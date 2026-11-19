import { useState, useEffect, useRef, useCallback } from 'react';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import { BleClient, ScanResult, ScanMode } from '@capacitor-community/bluetooth-le';
import {
  DEVICE_NAME_RE,
  ESP32_SERVICE_UUID,
  CLAIM_CODE_RE,
  isBleAvailable,
  ensureInit,
  connectWithRetry,
  writeJson,
  readJson,
  startJsonNotifications,
  releaseDevice,
  stopScanSafe,
  scanResultName,
  sleep,
  boardErrorCode,
  boardErrorMessage,
  bleConnectErrorMessage,
  openLocationSettings,
} from '../services/bleProvisioning';
import {
  ArrowLeft,
  HelpCircle,
  Scan,
  RotateCw,
  AlertCircle,
  ChevronRight,
  ShieldCheck,
} from 'lucide-react';

interface DiscoveredDevice {
  deviceId: string;
  name: string;
  rssi?: number;
}

const SCAN_TIMEOUT_MS = 15000;
const CHOICES_WAIT_MS = 5000;

export default function AddBoardScreen({ navigate, goBack }: NavProps) {
  const { showAlert } = useSmartFarm();
  const bleOk = isBleAvailable();
  const [view, setView] = useState<'scan' | 'verify-code'>('scan');
  const [scanning, setScanning] = useState(bleOk);
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DiscoveredDevice | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [scanTimedOut, setScanTimedOut] = useState(false);
  const [needLocation, setNeedLocation] = useState(false);
  // How many Bluetooth devices of ANY kind the phone saw in the last scan (diagnostic shown when
  // nothing matched): 0 = the phone's scan itself returned nothing (permission / Bluetooth / Location).
  const [nearbyAnyCount, setNearbyAnyCount] = useState<number | null>(null);
  const seenAnyRef = useRef<Set<string>>(new Set());

  // ยืนยันตัวตน: ผู้ใช้พิมพ์รหัส 6 หลักที่เห็นบนจออุปกรณ์ (อุปกรณ์ไม่ส่งรหัสทางบลูทูธ กันคนในระยะเดา)
  const [codeInput, setCodeInput] = useState('');
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [verifyErrorMsg, setVerifyErrorMsg] = useState<string | null>(null);

  // 60-second Countdown
  const [countdown, setCountdown] = useState(60);
  const [verifySession, setVerifySession] = useState(0);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isScanningRef = useRef(false);
  const mountedRef = useRef(true);
  const navigatedRef = useRef(false);
  const activeBleRef = useRef<string | null>(null);
  const connectBusyRef = useRef(false);
  const choiceBusyRef = useRef(false);
  const uiTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  /** setTimeout ที่ถูกล้างอัตโนมัติตอนออกจากหน้า */
  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      uiTimersRef.current.delete(t);
      if (mountedRef.current) fn();
    }, ms);
    uiTimersRef.current.add(t);
  }, []);

  const releaseActive = useCallback(async () => {
    const id = activeBleRef.current;
    activeBleRef.current = null;
    await releaseDevice(id);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = null;
  }, []);

  /* ── Stop Bluetooth Scan ── */
  const stopScan = useCallback(async () => {
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (isScanningRef.current) {
      isScanningRef.current = false;
      await stopScanSafe();
    }
    if (mountedRef.current) setScanning(false);
  }, []);

  /* ── Start Bluetooth Scan (เฉพาะอุปกรณ์ชื่อรูปแบบ FARM-xxxx) ── */
  const startScan = useCallback(async () => {
    await stopScan();
    if (!mountedRef.current) return;
    setScanTimedOut(false);
    setDiscoveredDevices([]);
    setConnectError(null);
    setNeedLocation(false);
    setNearbyAnyCount(null);
    seenAnyRef.current = new Set();
    if (!isBleAvailable()) {
      setScanning(false);
      return;
    }
    setScanning(true);

    try {
      await ensureInit();
      if (!mountedRef.current) return;
      isScanningRef.current = true;
      await BleClient.requestLEScan(
        {
          // ไม่กรองด้วย service UUID ระดับระบบ: บางเครื่อง/เฟิร์มแวร์เก่าใส่ UUID ไม่ครบในแพ็กเก็ตโฆษณา
          // จึงคัดด้วยชื่อ FARM-xxxx ใน callback แทน (ทั้ง service และชื่อมาจากอุปกรณ์จริงเท่านั้น)
          allowDuplicates: true, // ผลแรกอาจยังไม่มีชื่อ (ชื่อมากับ scan response) ต้องให้รายงานซ้ำได้ เรากันซ้ำเองด้วย deviceId
          scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
        },
        (result: ScanResult) => {
          const devId = result.device.deviceId;
          seenAnyRef.current.add(devId);
          // Our device = advertises the provisioning service (0xFFFF) OR has a FARM… name.
          // The name can be missing from a single report (it may arrive only in the scan response),
          // so the service UUID alone is enough; the real name comes from the device after the
          // 6-digit check (payload.device), never invented here.
          const name = scanResultName(result).trim().toUpperCase();
          const hasService = (result.uuids || []).some((u) => u.toLowerCase() === ESP32_SERVICE_UUID);
          if (!hasService && !DEVICE_NAME_RE.test(name) && !name.startsWith('FARM')) return;
          setDiscoveredDevices((prev) => {
            const i = prev.findIndex((b) => b.deviceId === devId);
            if (i < 0) return [...prev, { deviceId: devId, name, rssi: result.rssi }];
            // fill in the name once a later report carries it
            if (!prev[i].name && name) {
              const next = [...prev];
              next[i] = { ...prev[i], name };
              return next;
            }
            return prev;
          });
        }
      );
    } catch (err) {
      console.warn('[AddBoard] BLE scan error:', err);
      isScanningRef.current = false;
      if (mountedRef.current) {
        setScanning(false);
        setConnectError(bleConnectErrorMessage(err));
        setNeedLocation(err instanceof Error && err.message === 'LOCATION_DISABLED');
      }
      return;
    }

    scanTimerRef.current = setTimeout(async () => {
      await stopScan();
      if (mountedRef.current) {
        setScanTimedOut(true);
        setNearbyAnyCount(seenAnyRef.current.size);
      }
    }, SCAN_TIMEOUT_MS);
  }, [stopScan]);

  /* ── mount/unmount: หยุดสแกน ตัด BLE ล้าง timer ทั้งหมด ── */
  useEffect(() => {
    mountedRef.current = true;
    const timers = uiTimersRef.current;
    return () => {
      mountedRef.current = false;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
      void stopScan();
      void releaseActive();
    };
  }, [stopScan, releaseActive]);

  useEffect(() => {
    if (view === 'scan') {
      void startScan();
    }
    return () => {
      void stopScan();
    };
  }, [view, startScan, stopScan]);

  /* ── Dedicated 60-second Countdown Effect for Verification View ── */
  useEffect(() => {
    if (view === 'verify-code') {
      stopCountdown();
      setCountdown(60);
      countdownTimerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            stopCountdown();
            if (!navigatedRef.current) void releaseActive();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return stopCountdown;
  }, [view, verifySession, stopCountdown, releaseActive]);

  /* ── ยืนยันสำเร็จ: เก็บข้อมูลแล้วไปหน้า WiFi (ครั้งเดียว) ── */
  const handleVerified = useCallback(
    (device: DiscoveredDevice, payload: any) => {
      if (navigatedRef.current || !mountedRef.current) return;
      const name = String(payload?.device || device.name || '').trim().toUpperCase();
      const claimCode = typeof payload?.c === 'string' ? payload.c.trim() : '';
      if (!DEVICE_NAME_RE.test(name) || !CLAIM_CODE_RE.test(claimCode)) {
        setVerifyStatus('error');
        setVerifyErrorMsg('อุปกรณ์ไม่ส่งรหัสยืนยันกลับมา โปรดลองใหม่ หรือสแกน QR บนหน้าจออุปกรณ์แทน');
        return;
      }
      navigatedRef.current = true;
      stopCountdown();
      setVerifyStatus('success');
      setVerifyErrorMsg(null);
      sessionStorage.setItem('provision_board_id', name);
      sessionStorage.setItem('provision_ble_id', device.deviceId);
      sessionStorage.setItem('provision_claim_code', claimCode);
      later(() => navigate('wifi-setup'), 600);
    },
    [later, navigate, stopCountdown]
  );

  /* ── ข้อความจากอุปกรณ์ (notify หรือ READ) ระหว่างยืนยันตัวเลข ── */
  const handleBoardMessage = useCallback(
    (device: DiscoveredDevice, parsed: any) => {
      if (!parsed || !mountedRef.current || navigatedRef.current) return;
      if (parsed.status === 'verified' || parsed.auth === true) {
        handleVerified(device, parsed);
        return;
      }
      const code = boardErrorCode(parsed);
      if (parsed.status === 'locked' || parsed.locked === true || code === 'ERR_LOCKED_OUT') {
        stopCountdown();
        setVerifyStatus('error');
        setVerifyErrorMsg(boardErrorMessage('ERR_LOCKED_OUT'));
        void releaseActive();
      }
    },
    [handleVerified, releaseActive, stopCountdown]
  );

  /* ── Select Device -> Connect via BLE (retry+backoff) -> พิมพ์รหัส 6 หลัก ── */
  const handleSelectDevice = async (device: DiscoveredDevice) => {
    if (connectBusyRef.current || navigatedRef.current) return;
    connectBusyRef.current = true;
    setSelectedDevice(device);
    setConnectingId(device.deviceId);
    setConnectError(null);
    setVerifyErrorMsg(null);
    setCodeInput('');
    await stopScan();
    await releaseActive();

    try {
      if (!isBleAvailable()) {
        setConnectError('ต้องใช้แอปบนมือถือเพื่อเชื่อมต่ออุปกรณ์ผ่านบลูทูธ');
        return;
      }

      try {
        await connectWithRetry(
          device.deviceId,
          () => {
            if (activeBleRef.current === device.deviceId) activeBleRef.current = null;
          },
          () => !mountedRef.current
        );
      } catch (err) {
        console.warn('[AddBoard] BLE connect failed:', err);
        if (mountedRef.current) setConnectError(bleConnectErrorMessage(err));
        return;
      }
      if (!mountedRef.current) {
        await releaseDevice(device.deviceId);
        return;
      }
      activeBleRef.current = device.deviceId;

      await startJsonNotifications(device.deviceId, (msg) => handleBoardMessage(device, msg)).catch((e) =>
        console.warn('[AddBoard] notify unavailable, using READ only:', e)
      );

      // ขอให้อุปกรณ์แสดงรหัส 6 หลักบนจอ (รหัสไม่ถูกส่งทางบลูทูธ) แล้วรอให้อุปกรณ์ตอบว่าพร้อม
      let ready = false;
      try {
        await writeJson(device.deviceId, { cmd: 'start_verify' });
        const deadline = Date.now() + CHOICES_WAIT_MS;
        while (!ready && Date.now() < deadline && mountedRef.current) {
          await sleep(300);
          const res = await readJson(device.deviceId).catch(() => null);
          if (res && (res.locked === true || boardErrorCode(res) === 'ERR_LOCKED_OUT')) {
            throw new Error('ERR_LOCKED_OUT');
          }
          if (res && (res.status === 'verify_ready' || res.status === 'wrong')) ready = true;
        }
      } catch (err: any) {
        await releaseActive();
        if (mountedRef.current) {
          setConnectError(
            err?.message === 'ERR_LOCKED_OUT'
              ? boardErrorMessage('ERR_LOCKED_OUT')
              : 'สื่อสารกับอุปกรณ์ไม่สำเร็จ โปรดถือโทรศัพท์ใกล้อุปกรณ์แล้วลองใหม่'
          );
        }
        return;
      }
      if (!mountedRef.current) return;
      if (!ready) {
        await releaseActive();
        setConnectError('อุปกรณ์ไม่ตอบรับการยืนยัน โปรดอัปเดตเฟิร์มแวร์อุปกรณ์ หรือสแกน QR บนหน้าจออุปกรณ์แทน');
        return;
      }

      setCodeInput('');
      setVerifyStatus('idle');
      setVerifyErrorMsg(null);
      setVerifySession((n) => n + 1);
      setView('verify-code');
    } finally {
      connectBusyRef.current = false;
      if (mountedRef.current) setConnectingId(null);
    }
  };

  /* ── ผู้ใช้พิมพ์รหัส 6 หลักจากหน้าจออุปกรณ์แล้วกดยืนยัน ── */
  const handleSubmitCode = async () => {
    if (verifyStatus === 'success' || choiceBusyRef.current || navigatedRef.current) return;
    const code = codeInput.trim();
    if (!/^\d{6}$/.test(code)) {
      setVerifyStatus('error');
      setVerifyErrorMsg('กรุณาพิมพ์รหัส 6 หลักที่แสดงบนหน้าจออุปกรณ์');
      return;
    }
    const device = selectedDevice;
    const bleId = activeBleRef.current;
    if (!device || !bleId) {
      setVerifyStatus('error');
      setVerifyErrorMsg('การเชื่อมต่อกับอุปกรณ์หลุด โปรดกดย้อนกลับแล้วเลือกอุปกรณ์อีกครั้ง');
      return;
    }
    choiceBusyRef.current = true;
    setVerifyStatus('idle');
    setVerifyErrorMsg(null);

    try {
      await writeJson(bleId, { cmd: 'verify_code', code: Number(code) });
      await sleep(250);
      if (navigatedRef.current) return; // notify ยืนยันแล้ว
      const parsed = await readJson(bleId).catch(() => null);
      if (parsed && (parsed.status === 'verified' || parsed.auth === true)) {
        handleVerified(device, parsed);
        return;
      }
      handleBoardMessage(device, parsed);
      if (navigatedRef.current || !mountedRef.current) return;
      const locked = parsed && (parsed.status === 'locked' || parsed.locked === true);
      // ถ้าอุปกรณ์ล็อก (notify มาก่อนแล้วตัดการเชื่อมต่อ) อย่าเขียนทับข้อความล็อก
      if (!locked && activeBleRef.current) {
        setVerifyStatus('error');
        setVerifyErrorMsg('รหัสไม่ตรง อุปกรณ์สร้างรหัสใหม่แล้ว โปรดดูรหัสใหม่บนหน้าจออุปกรณ์แล้วพิมพ์อีกครั้ง');
        setCodeInput('');
      }
    } catch (e) {
      console.warn('[AddBoard] verify code error:', e);
      if (mountedRef.current) {
        setVerifyStatus('error');
        setVerifyErrorMsg('ส่งรหัสไปยังอุปกรณ์ไม่สำเร็จ โปรดลองใหม่อีกครั้ง');
      }
    } finally {
      choiceBusyRef.current = false;
    }
  };

  /* ═══════════════════════════════════════════════════════
     VIEW 2: ยืนยันตัวตนกับอุปกรณ์ (พิมพ์รหัส 6 หลักตามหน้าจออุปกรณ์)
  ══════════════════════════════════════════════════════ */
  if (view === 'verify-code') {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#0d0e12',
          color: '#ffffff',
          fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          paddingBottom: 40,
        }}
      >
        {/* Top Bar */}
        <div>
          <div
            style={{
              padding: '48px 20px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
                void releaseActive();
                setView('scan');
              }}
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: '#1c1d22',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                cursor: 'pointer',
              }}
            >
              <ArrowLeft size={18} strokeWidth={1.75} />
            </button>
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 600, color: '#ffffff', margin: 0 }}>
                ยืนยันตัวตนกับอุปกรณ์
              </h1>
              <p style={{ fontSize: 12, color: '#10b981', margin: '2px 0 0', fontFamily: 'monospace' }}>
                {selectedDevice?.name}
              </p>
            </div>
          </div>

          <div style={{ padding: '32px 24px 20px', textAlign: 'center' }}>
            {/* Animated Device / Prompt Badge */}
            <div
              style={{
                width: 84,
                height: 84,
                borderRadius: 24,
                background: 'rgba(16, 185, 129, 0.12)',
                border: '1.5px solid rgba(16, 185, 129, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 24px',
                color: '#10b981',
                boxShadow: '0 0 25px rgba(16, 185, 129, 0.2)',
              }}
            >
              <ShieldCheck size={42} strokeWidth={1.75} />
            </div>

            <h2 style={{ fontSize: 21, fontWeight: 600, color: '#ffffff', margin: '0 0 8px', letterSpacing: '-0.01em' }}>
              พิมพ์รหัสที่แสดงบนหน้าจออุปกรณ์
            </h2>
            <p style={{ fontSize: 13, color: '#94a3b8', maxWidth: 300, margin: '0 auto 28px', lineHeight: 1.6 }}>
              ดูรหัส 6 หลักบนหน้าจอของอุปกรณ์<br />แล้วพิมพ์ให้ตรงกันเพื่อยืนยันความเป็นเจ้าของ
            </p>

            {/* Error Message if wrong choice clicked */}
            {(verifyErrorMsg || connectError) && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  borderRadius: 12,
                  padding: '10px 14px',
                  color: '#f87171',
                  fontSize: 13,
                  marginBottom: 20,
                  maxWidth: 320,
                  margin: '0 auto 20px',
                }}
              >
                {verifyErrorMsg || connectError}
              </div>
            )}

            {/* Success Message */}
            {verifyStatus === 'success' && (
              <div
                style={{
                  background: 'rgba(16, 185, 129, 0.15)',
                  border: '1px solid rgba(16, 185, 129, 0.4)',
                  borderRadius: 12,
                  padding: '10px 14px',
                  color: '#34d399',
                  fontSize: 13,
                  fontWeight: 600,
                  marginBottom: 20,
                  maxWidth: 320,
                  margin: '0 auto 20px',
                }}
              >
                ยืนยันถูกต้อง กำลังนำไปยังการตั้งค่า Wi-Fi...
              </div>
            )}

            {/* ── ช่องพิมพ์รหัส 6 หลัก ── */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSubmitCode();
              }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, margin: '0 auto 28px', maxWidth: 320 }}
            >
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6));
                  if (verifyStatus === 'error') {
                    setVerifyStatus('idle');
                    setVerifyErrorMsg(null);
                  }
                }}
                disabled={verifyStatus === 'success'}
                aria-label="รหัส 6 หลักจากหน้าจออุปกรณ์"
                placeholder="------"
                style={{
                  width: '100%',
                  height: 64,
                  borderRadius: 16,
                  background: '#17181c',
                  border: `1.5px solid ${verifyStatus === 'error' ? '#ef4444' : verifyStatus === 'success' ? '#10b981' : 'rgba(255, 255, 255, 0.16)'}`,
                  color: '#ffffff',
                  fontSize: 30,
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  letterSpacing: '0.35em',
                  textAlign: 'center',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="submit"
                disabled={codeInput.length !== 6 || verifyStatus === 'success'}
                style={{
                  width: '100%',
                  minHeight: 48,
                  borderRadius: 12,
                  background: codeInput.length === 6 ? '#10b981' : '#23242a',
                  color: codeInput.length === 6 ? '#ffffff' : '#64748b',
                  border: 'none',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: codeInput.length === 6 ? 'pointer' : 'not-allowed',
                }}
              >
                ยืนยันรหัส
              </button>
            </form>

            {/* 60-Second Countdown Display */}
            <div style={{ fontSize: 13, color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <span>เหลือเวลา</span>
              <span style={{ color: countdown <= 10 ? '#ef4444' : '#10b981', fontWeight: 600, fontFamily: 'monospace' }}>
                {countdown}
              </span>
              <span>วินาที</span>
            </div>

            {countdown === 0 && (
              <div style={{ marginTop: 18 }}>
                <button
                  type="button"
                  disabled={!!connectingId}
                  onClick={() => selectedDevice && handleSelectDevice(selectedDevice)}
                  style={{
                    padding: '12px 28px', minHeight: 44,
                    borderRadius: 12,
                    background: '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  ลองใหม่อีกครั้ง
                </button>
              </div>
            )}
          </div>
        </div>

        {/* คำแนะนำ */}
        <div style={{ padding: '0 24px', textAlign: 'center' }}>
          <p style={{ fontSize: 11, color: '#475569', margin: 0 }}>
            คำแนะนำ: รหัส 6 หลักแสดงบนหน้าจออุปกรณ์เท่านั้น ถ้าพิมพ์ผิด 2 ครั้ง อุปกรณ์จะล็อก 5 นาที
          </p>
        </div>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════
     VIEW 1: หน้าค้นหาและเพิ่มอุปกรณ์แบบ XIAOMI HOME แท้ (Dark Theme)
  ══════════════════════════════════════════════════════ */
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0d0e12',
        color: '#ffffff',
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
        paddingBottom: 48,
      }}
    >
      <style>{`
        @keyframes xiaomiRadarPulse {
          0% {
            transform: scale(0.85);
            opacity: 0.8;
          }
          50% {
            transform: scale(1.15);
            opacity: 0.3;
          }
          100% {
            transform: scale(1.35);
            opacity: 0;
          }
        }
      `}</style>

      {/* ── Top Bar (Xiaomi Home Style) ── */}
      <div
        style={{
          padding: '48px 20px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <button
          type="button"
          onClick={() => (goBack ? goBack('home') : navigate('home'))}
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: 'transparent',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <ArrowLeft size={22} strokeWidth={1.75} />
        </button>

        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#ffffff', margin: 0 }}>
          เพิ่มอุปกรณ์
        </h1>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            type="button"
            onClick={() => showAlert({
              title: 'คำแนะนำการเชื่อมต่อ',
              message: 'โปรดเปิดบลูทูธบนโทรศัพท์ และวางอุปกรณ์ให้อยู่ในระยะสัญญาณเพื่อทำการเชื่อมต่อ',
              variant: 'info',
            })}
            style={{
              background: 'none',
              border: 'none',
              color: '#ffffff',
              cursor: 'pointer',
              padding: 0, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center',
              display: 'flex',
            }}
          >
            <HelpCircle size={20} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div style={{ padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* ── CARD 1: ค้นพบอุปกรณ์ใกล้เคียง (Graphic Phone + Radar Waves) ── */}
        <div
          style={{
            background: '#17181c',
            borderRadius: 22,
            border: '1px solid rgba(255, 255, 255, 0.06)',
            padding: '20px 18px',
          }}
        >
          <div style={{ marginBottom: 18 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#ffffff', margin: '0 0 4px' }}>
              ค้นพบอุปกรณ์ใกล้เคียง
            </h2>
            <p style={{ fontSize: 12, color: '#8e8e93', margin: 0 }}>
              {scanning ? 'การตรวจหาอุปกรณ์ในบริเวณใกล้เคียงโดยอัตโนมัติ...' : `ตรวจพบ ${discoveredDevices.length} อุปกรณ์`}
            </p>
          </div>

          {/* Central Phone Graphic with Pulsing Radar Effect */}
          <div
            style={{
              position: 'relative',
              height: 140,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '10px 0 16px',
            }}
          >
            {/* Pulsing Radar Ring 1 */}
            {scanning && (
              <div
                style={{
                  position: 'absolute',
                  width: 130,
                  height: 130,
                  borderRadius: '50%',
                  border: '1px solid rgba(16, 185, 129, 0.35)',
                  animation: 'xiaomiRadarPulse 2.4s ease-out infinite',
                }}
              />
            )}
            {/* Pulsing Radar Ring 2 */}
            {scanning && (
              <div
                style={{
                  position: 'absolute',
                  width: 170,
                  height: 170,
                  borderRadius: '50%',
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                  animation: 'xiaomiRadarPulse 2.4s ease-out infinite 0.8s',
                }}
              />
            )}

            {/* Phone Silhouette Icon */}
            <div
              style={{
                width: 48,
                height: 84,
                borderRadius: 10,
                background: '#0d0e12',
                border: '2.5px solid #3a3b40',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
              }}
            >
              {/* Speaker Notch */}
              <div
                style={{
                  position: 'absolute',
                  top: 5,
                  width: 12,
                  height: 2,
                  background: '#5a5b62',
                  borderRadius: 1,
                }}
              />
              {/* Inner glowing screen dot */}
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: scanning ? '#10b981' : '#64748b',
                  boxShadow: scanning ? '0 0 10px #10b981' : 'none',
                }}
              />
            </div>
          </div>

          <p style={{ fontSize: 13, color: '#8e8e93', textAlign: 'center', margin: '0 0 6px' }}>
            วางโทรศัพท์ให้ใกล้กับอุปกรณ์เป้าหมายมากที่สุด
          </p>

          {/* Device list if discovered */}
          {discoveredDevices.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              {discoveredDevices.map((device) => {
                const isConnecting = connectingId === device.deviceId;
                return (
                  <div
                    key={device.deviceId}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 14,
                      background: '#23242a',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#ffffff', fontFamily: 'monospace' }}>
                        {device.name || 'อุปกรณ์ Hydroponic (รอชื่อ)'}
                      </div>
                      <div style={{ fontSize: 11, color: '#10b981', marginTop: 2 }}>
                        สัญญาณ {device.rssi ? `${device.rssi} dBm` : 'พร้อมเชื่อมต่อ'}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={isConnecting}
                      onClick={() => handleSelectDevice(device)}
                      style={{
                        padding: '8px 18px', minHeight: 44, minWidth: 88,
                        borderRadius: 10,
                        background: '#10b981',
                        color: '#ffffff',
                        border: 'none',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: isConnecting ? 'not-allowed' : 'pointer',
                        opacity: isConnecting ? 0.7 : 1,
                      }}
                    >
                      {isConnecting ? 'กำลังเชื่อมต่อ...' : 'เชื่อมต่อ'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* ผลสแกนจริง: บอกว่ามือถือเห็นบลูทูธรอบตัวกี่เครื่อง เพื่อแยกว่าสแกนไม่ทำงาน หรืออุปกรณ์ไม่ได้ประกาศตัว */}
          {bleOk && !scanning && discoveredDevices.length === 0 && nearbyAnyCount !== null && (
            <p style={{ fontSize: 12, color: '#8e8e93', textAlign: 'center', margin: '10px 0 0', lineHeight: 1.6 }}>
              {nearbyAnyCount === 0
                ? 'มือถือไม่เห็นสัญญาณบลูทูธใดๆ เลย ตรวจว่าเปิดบลูทูธ ตำแหน่ง และอนุญาตสิทธิ์อุปกรณ์ใกล้เคียงให้แอปแล้ว'
                : `มือถือเห็นสัญญาณบลูทูธ ${nearbyAnyCount} เครื่อง แต่ไม่มีอุปกรณ์ Hydroponic ที่เปิดรับการจับคู่ อุปกรณ์ที่ผูกบัญชีแล้วจะไม่ประกาศตัว ถ้าหน้าจออุปกรณ์ขึ้น PAIRING CLOSED ให้กดปุ่ม BOOT ค้าง 5 วินาที`}
            </p>
          )}

          {/* ข้อผิดพลาดจริงจากการเชื่อมต่อ (ไม่หมุนรอเปล่า) */}
          {connectError && (
            <div
              role="alert"
              style={{
                marginTop: 14,
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                borderRadius: 12,
                padding: '10px 14px',
                color: '#f87171',
                fontSize: 13,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                lineHeight: 1.5,
              }}
            >
              <AlertCircle size={16} strokeWidth={2} style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span>{connectError}</span>
                {needLocation && (
                  <button
                    type="button"
                    onClick={() => void openLocationSettings()}
                    style={{ alignSelf: 'flex-start', minHeight: 44, padding: '0 14px', borderRadius: 10, border: '1px solid rgba(248,113,113,0.5)', background: 'transparent', color: '#fca5a5', fontSize: 13, cursor: 'pointer' }}
                  >
                    เปิดการตั้งค่าตำแหน่ง
                  </button>
                )}
              </div>
            </div>
          )}

          {/* เว็บ: ไม่มีบลูทูธ */}
          {!bleOk && (
            <p style={{ fontSize: 13, color: '#f59e0b', textAlign: 'center', margin: '8px 0 0' }}>
              ต้องใช้แอปบนมือถือเพื่อค้นหาอุปกรณ์ผ่านบลูทูธ
            </p>
          )}

          {/* ไม่พบอุปกรณ์ / สแกนใหม่ */}
          {bleOk && !scanning && !connectingId && (
            <div style={{ textAlign: 'center', marginTop: 8 }}>
              <button
                type="button"
                onClick={() => void startScan()}
                style={{
                  minHeight: 44,
                  padding: '0 16px',
                  background: 'none',
                  border: 'none',
                  fontSize: 13,
                  color: '#f59e0b',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <RotateCw size={14} strokeWidth={2} />
                {discoveredDevices.length === 0
                  ? scanTimedOut
                    ? 'ไม่พบอุปกรณ์ แตะเพื่อค้นหาอีกครั้ง หรือสแกน QR ด้านล่าง'
                    : 'ค้นหาอีกครั้ง'
                  : 'ค้นหาอีกครั้ง'}
              </button>
            </div>
          )}
        </div>

        {/* ── CARD 2: สแกนเพื่อเพิ่ม (Scan QR Code) ── */}
        <div
          onClick={() => navigate('connect-board')}
          style={{
            background: '#17181c',
            borderRadius: 20,
            border: '1px solid rgba(255, 255, 255, 0.06)',
            padding: '16px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            transition: 'background 0.2s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: '#23242a',
                color: '#ffffff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Scan size={20} strokeWidth={1.75} />
            </div>
            <div>
              <span style={{ fontSize: 15, fontWeight: 600, color: '#ffffff', display: 'block' }}>
                สแกนเพื่อเพิ่ม
              </span>
              <span style={{ fontSize: 12, color: '#8e8e93', display: 'block', marginTop: 2 }}>
                ใช้กล้องสแกน QR Code บนหน้าจออุปกรณ์
              </span>
            </div>
          </div>
          <ChevronRight size={18} strokeWidth={1.75} color="#5a5b62" />
        </div>
      </div>
    </div>
  );
}
