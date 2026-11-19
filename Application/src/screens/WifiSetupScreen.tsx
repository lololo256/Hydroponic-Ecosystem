import { useState, useEffect, useRef, useCallback } from 'react';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import { Capacitor } from '@capacitor/core';
import { WifiScan, ScannedNetwork } from '../plugins/WifiScan';
import {
  isBleAvailable,
  isIos,
  isMacAddress,
  findDeviceByExactName,
  connectWithRetry,
  writeJson,
  readJson,
  startJsonNotifications,
  releaseDevice,
  sleep,
  boardErrorCode,
  boardErrorMessage,
  bleConnectErrorMessage,
  DEVICE_NAME_RE,
} from '../services/bleProvisioning';
import { claimWithRetry, pickWaitBound } from '../services/bleBindStatus';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  ChevronDown,
  Check,
  RotateCw,
  Wifi,
  Cloud,
  Link2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

type Step = 'form' | 'provisioning' | 'failed' | 'done';
/** ขั้นที่ล้มเหลว: wifi = ส่ง WiFi ไม่ผ่าน, claim = ผูกใน ThingsBoard ไม่ผ่าน, bind = อุปกรณ์ยังไม่ยืนยันการผูก */
type FailStage = 'wifi' | 'claim' | 'bind';

/** ลำดับขั้นที่แสดงบนจอ: phase = ดัชนีขั้นที่กำลังทำ (4 = เสร็จครบ) */
const PROVISION_STEPS: { label: string; activeText: string; doneText: string }[] = [
  { label: 'ส่ง WiFi', activeText: 'กำลังส่งข้อมูลและรออุปกรณ์เชื่อมต่อ Wi-Fi...', doneText: 'อุปกรณ์เชื่อมต่อ Wi-Fi สำเร็จ' },
  { label: 'อุปกรณ์ออนไลน์', activeText: 'รออุปกรณ์เชื่อมต่อคลาวด์...', doneText: 'อุปกรณ์ออนไลน์บนคลาวด์แล้ว' },
  { label: 'ผูกบัญชี', activeText: 'รออุปกรณ์ยืนยันการผูกบัญชี...', doneText: 'อุปกรณ์ยืนยันการผูกบัญชีแล้ว' },
  { label: 'เสร็จ', activeText: 'กำลังเตรียมอุปกรณ์...', doneText: 'พร้อมใช้งาน' },
];
const STEP_ICONS = [Wifi, Cloud, Link2, CheckCircle2];

const WIFI_TIMEOUT_S = 90; // เชื่อม BLE + auth + อุปกรณ์ลองต่อ Wi-Fi สูงสุด 3 รอบ x 13 วิ
const BOUND_TIMEOUT_MS = 30000;

/* ── 4-Level Signal Strength Line Icon ── */
function WifiSignalIcon({ level, size = 16 }: { level: number; size?: number }) {
  const bars = level > -60 ? 4 : level > -70 ? 3 : level > -80 ? 2 : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13a10 10 0 0 1 14 0" opacity={bars >= 3 ? 1 : 0.25} />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" opacity={bars >= 2 ? 1 : 0.25} />
      <path d="M2 9a15 15 0 0 1 20 0" opacity={bars >= 4 ? 1 : 0.25} />
      <line x1="12" y1="20" x2="12.01" y2="20" opacity={1} strokeWidth="2.5" />
    </svg>
  );
}

export default function WifiSetupScreen({ navigate, goBack }: NavProps) {
  const smartFarm = useSmartFarm();
  const { claimBoardDevice } = smartFarm;

  // ข้อมูลอุปกรณ์จากหน้าก่อน (QR / ค้นหาบลูทูธ) — อ่านครั้งเดียวตอน mount
  const [boardId] = useState<string>(() => (sessionStorage.getItem('provision_board_id') || '').trim().toUpperCase());
  const claimCodeRef = useRef<string>(sessionStorage.getItem('provision_claim_code') || '');
  const bleIdRef = useRef<string>(sessionStorage.getItem('provision_ble_id') || '');

  // Form State
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // WiFi networks (จากอุปกรณ์ผ่าน BLE หรือจากโทรศัพท์ Android)
  const [real24GNetworks, setReal24GNetworks] = useState<ScannedNetwork[]>([]);
  const [isScanningWifi, setIsScanningWifi] = useState(false);
  const [scanErrorMsg, setScanErrorMsg] = useState<string | null>(null);

  // Provisioning State
  const [step, setStep] = useState<Step>('form');
  const [phase, setPhase] = useState(0);
  const [failStage, setFailStage] = useState<FailStage | null>(null);
  const [timeoutSeconds, setTimeoutSeconds] = useState(WIFI_TIMEOUT_S);
  const [provisionErrorMsg, setProvisionErrorMsg] = useState<string | null>(null);

  // Timers & guards — เก็บใน ref ทั้งหมด ล้างเมื่อสำเร็จ/หมดเวลา/ผิดพลาด/ลองใหม่/ออกจากหน้า
  const mountedRef = useRef(true);
  const runIdRef = useRef(0); // เพิ่มทุกครั้งที่เริ่มรอบใหม่หรือออกจากหน้า → รอบเก่าหยุดเอง
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wifiSettledRef = useRef(false);
  const bindInFlightRef = useRef(false);
  const navigatedRef = useRef(false);
  const connectedBleRef = useRef<string | null>(null);
  const scanPromiseRef = useRef<Promise<void> | null>(null);
  const scanAbortRef = useRef(false);
  const codelessErrorCountRef = useRef(0);

  const stopTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = null;
  }, []);

  const releaseBle = useCallback(async () => {
    const id = connectedBleRef.current;
    connectedBleRef.current = null;
    await releaseDevice(id);
  }, []);

  /* ── หา BLE deviceId ของอุปกรณ์เป้าหมาย: Android ใช้ MAC จาก QR ได้, iOS ต้องสแกนชื่อที่ตรงกันทุกตัวอักษร ── */
  const resolveBleId = useCallback(
    async (forceScan = false): Promise<string | null> => {
      const cached = bleIdRef.current;
      if (!forceScan && cached) {
        if (!isIos() && isMacAddress(cached)) return cached;
        // iOS: ใช้ UUID ที่ได้จากการสแกนในแอปนี้เท่านั้น (ไม่ใช่ MAC จาก QR)
        if (isIos() && !isMacAddress(cached) && !cached.startsWith('BLE-')) return cached;
      }
      if (!DEVICE_NAME_RE.test(boardId)) return null;
      const found = await findDeviceByExactName(boardId, 10000);
      if (found) {
        bleIdRef.current = found;
        sessionStorage.setItem('provision_ble_id', found);
      }
      return found;
    },
    [boardId]
  );

  /* ── เชื่อมต่อ BLE (retry + backoff); ถ้าใช้ MAC ตรงๆ ไม่ผ่าน ลองสแกนชื่ออีกรอบ ── */
  const connectTarget = useCallback(
    async (runId: number): Promise<string> => {
      const aborted = () => runIdRef.current !== runId || !mountedRef.current;
      let id = await resolveBleId(false);
      if (!id) throw new Error('DEVICE_NOT_FOUND');
      try {
        await connectWithRetry(id, () => {
          if (connectedBleRef.current === id) connectedBleRef.current = null;
        }, aborted);
      } catch (e) {
        if (aborted()) throw e;
        const rescanned = await resolveBleId(true);
        if (!rescanned) throw new Error('DEVICE_NOT_FOUND');
        id = rescanned;
        await connectWithRetry(id, () => {
          if (connectedBleRef.current === id) connectedBleRef.current = null;
        }, aborted);
      }
      connectedBleRef.current = id;
      return id;
    },
    [resolveBleId]
  );

  /* ── สแกน WiFi 2.4GHz: ให้อุปกรณ์สแกนผ่าน BLE ก่อน, สำรองด้วยปลั๊กอินโทรศัพท์ (Android) ── */
  const triggerNativeWifiScan = useCallback(async () => {
    if (scanPromiseRef.current) return scanPromiseRef.current;
    const job = (async () => {
      setIsScanningWifi(true);
      setScanErrorMsg(null);
      scanAbortRef.current = false;
      let gotNetworks = false;

      if (isBleAvailable() && DEVICE_NAME_RE.test(boardId)) {
        let id: string | null = null;
        try {
          id = await resolveBleId(false);
          if (id && !scanAbortRef.current) {
            await connectWithRetry(id, undefined, () => scanAbortRef.current || !mountedRef.current);
            let networks: any[] | null = null;
            await startJsonNotifications(id, (msg) => {
              if (Array.isArray(msg?.networks)) networks = msg.networks;
            }).catch(() => {});
            await writeJson(id, { cmd: 'scan_wifi' });
            // อุปกรณ์สแกนแบบ async: รอผลจาก notify หรือ READ สูงสุด ~8 วิ
            for (let i = 0; i < 16 && !networks && !scanAbortRef.current; i++) {
              await sleep(500);
              if (i % 2 === 1) {
                const res = await readJson(id).catch(() => null);
                if (Array.isArray(res?.networks)) networks = res.networks;
              }
            }
            const list = (networks || []) as any[];
            if (list.length > 0 && mountedRef.current) {
              const mapped: ScannedNetwork[] = list
                .filter((n) => typeof (n?.ssid ?? n?.s) === 'string' && (n.ssid ?? n.s).length > 0)
                .map((n) => ({
                  ssid: n.ssid ?? n.s,
                  bssid: typeof n.bssid === 'string' ? n.bssid : '',
                  frequency: 0,
                  level: typeof (n.rssi ?? n.r) === 'number' ? (n.rssi ?? n.r) : -100,
                  isCurrent: false,
                }));
              setReal24GNetworks(mapped);
              gotNetworks = mapped.length > 0;
            }
          }
        } catch (bleErr) {
          console.warn('[WifiSetup] BLE wifi scan notice:', bleErr);
        } finally {
          // ตัดการเชื่อมต่อเสมอเมื่อสแกนเสร็จ (ขั้นส่ง WiFi จะเชื่อมใหม่เอง)
          await releaseDevice(id);
        }
      }

      if (!gotNetworks && Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('WifiScan')) {
        try {
          const result = await WifiScan.scan24GNetworks();
          if (result && result.networks && result.networks.length > 0 && mountedRef.current) {
            setReal24GNetworks(result.networks);
            if (result.currentSsid && result.networks.some((n) => n.ssid === result.currentSsid)) {
              setWifiSsid((prev) => (prev ? prev : result.currentSsid));
            }
            gotNetworks = true;
          }
        } catch (err) {
          console.warn('[WifiSetup] phone WiFi scan notice:', err);
          if (mountedRef.current) {
            setScanErrorMsg('โปรดเปิดการอนุญาตตำแหน่ง (GPS) และบลูทูธเพื่อค้นหาชื่อ Wi-Fi');
          }
        }
      }

      if (mountedRef.current) setIsScanningWifi(false);
    })();
    scanPromiseRef.current = job.finally(() => {
      scanPromiseRef.current = null;
    });
    return scanPromiseRef.current;
  }, [boardId, resolveBleId]);

  /* ── mount ครั้งเดียว: สแกน WiFi / unmount: หยุดทุกอย่างและตัด BLE ── */
  const scanOnMountRef = useRef(triggerNativeWifiScan);
  useEffect(() => {
    mountedRef.current = true;
    scanOnMountRef.current();
    return () => {
      mountedRef.current = false;
      runIdRef.current += 1;
      scanAbortRef.current = true;
      stopTimers();
      void releaseBle();
    };
  }, [releaseBle, stopTimers]);

  /* ── Toggle dropdown and refresh scan if needed ── */
  const handleToggleDropdown = () => {
    const nextState = !showDropdown;
    setShowDropdown(nextState);
    if (nextState && real24GNetworks.length === 0) {
      void triggerNativeWifiScan();
    }
  };

  const fail = useCallback(
    (runId: number, stage: FailStage, message: string) => {
      if (runIdRef.current !== runId || !mountedRef.current) return;
      stopTimers();
      setFailStage(stage);
      setProvisionErrorMsg(message);
      setStep('failed');
    },
    [stopTimers]
  );

  /* ── ขั้น 2-4: claim ใน ThingsBoard (retry) → รออุปกรณ์รายงาน bound=true ── */
  const runBind = useCallback(
    async (runId: number) => {
      if (bindInFlightRef.current) return;
      bindInFlightRef.current = true;
      const aborted = () => runIdRef.current !== runId || !mountedRef.current;
      try {
        setFailStage(null);
        setProvisionErrorMsg(null);
        setStep('provisioning');
        setPhase(1);

        const claimCode = claimCodeRef.current;
        if (!claimCode) {
          fail(runId, 'claim', 'ไม่พบรหัสยืนยันของอุปกรณ์ โปรดสแกน QR บนหน้าจออุปกรณ์อีกครั้ง');
          return;
        }

        const claim = await claimWithRetry(claimBoardDevice, boardId, claimCode, { totalMs: 45000, shouldAbort: aborted });
        if (aborted()) return;
        if (!claim.success) {
          fail(runId, 'claim', claim.message || 'ผูกอุปกรณ์กับบัญชีไม่สำเร็จ');
          return;
        }

        setPhase(2);
        const tbDeviceId = claim.deviceId;
        if (!tbDeviceId) {
          fail(runId, 'bind', 'ผูกบัญชีแล้ว แต่ไม่พบรหัสอุปกรณ์จากคลาวด์เพื่อตรวจสอบสถานะ');
          return;
        }
        const waitBound = pickWaitBound(smartFarm, aborted);
        const bound = await waitBound(tbDeviceId, BOUND_TIMEOUT_MS);
        if (aborted()) return;
        if (!bound) {
          fail(
            runId,
            'bind',
            'อุปกรณ์อยู่ในบัญชีแล้ว แต่ยังไม่ยืนยันการผูกภายใน 30 วินาที โปรดตรวจว่าอุปกรณ์ต่อเน็ตอยู่ แล้วกดลองผูกอีกครั้ง'
          );
          return;
        }

        setPhase(4);
        setStep('done');
        sessionStorage.removeItem('provision_claim_code');
        sessionStorage.removeItem('provision_ble_id');
      } finally {
        bindInFlightRef.current = false;
      }
    },
    [boardId, claimBoardDevice, fail, smartFarm]
  );

  /* ── ขั้น 1: ส่ง auth ครั้งเดียว → ส่ง WiFi → รอผลจริงจากอุปกรณ์ (notify + READ) ── */
  const handleNext = async () => {
    const cleanSsid = wifiSsid.trim();
    if (!cleanSsid) return;

    const runId = ++runIdRef.current;
    const aborted = () => runIdRef.current !== runId || !mountedRef.current;
    stopTimers();
    wifiSettledRef.current = false;
    codelessErrorCountRef.current = 0;
    setStep('provisioning');
    setPhase(0);
    setFailStage(null);
    setProvisionErrorMsg(null);
    setTimeoutSeconds(WIFI_TIMEOUT_S);

    if (!isBleAvailable()) {
      fail(runId, 'wifi', 'ต้องใช้แอปบนมือถือเพื่อส่ง Wi-Fi ให้อุปกรณ์ผ่านบลูทูธ');
      return;
    }
    if (!DEVICE_NAME_RE.test(boardId)) {
      fail(runId, 'wifi', 'ไม่พบข้อมูลอุปกรณ์ โปรดกลับไปสแกน QR หรือค้นหาอุปกรณ์อีกครั้ง');
      return;
    }
    const claimCode = claimCodeRef.current;
    if (!claimCode) {
      fail(runId, 'wifi', 'ไม่พบรหัสยืนยันของอุปกรณ์ โปรดสแกน QR บนหน้าจออุปกรณ์อีกครั้ง');
      return;
    }

    // ให้การสแกน WiFi ที่ค้างอยู่หยุดและตัดการเชื่อมต่อก่อน
    scanAbortRef.current = true;
    if (scanPromiseRef.current) await scanPromiseRef.current.catch(() => {});
    await releaseBle();
    if (aborted()) return;

    // นับถอยหลังทั้งขั้นส่ง WiFi
    const wifiDeadline = Date.now() + WIFI_TIMEOUT_S * 1000;
    countdownRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((wifiDeadline - Date.now()) / 1000));
      setTimeoutSeconds(remaining);
      if (remaining <= 0 && !wifiSettledRef.current) {
        wifiSettledRef.current = true;
        void releaseBle();
        fail(runId, 'wifi', 'หมดเวลา อุปกรณ์ไม่ตอบกลับ ถ้าหน้าจออุปกรณ์ขึ้น PAIRING CLOSED ให้กดปุ่ม BOOT ค้าง 5 วินาที แล้ววางโทรศัพท์ใกล้อุปกรณ์และลองใหม่');
      }
    }, 1000);

    let bleId: string;
    try {
      bleId = await connectTarget(runId);
    } catch (e: any) {
      if (aborted() || wifiSettledRef.current) return;
      wifiSettledRef.current = true;
      fail(
        runId,
        'wifi',
        e?.message === 'DEVICE_NOT_FOUND'
          ? `ไม่พบสัญญาณบลูทูธของอุปกรณ์ ${boardId} โปรดเปิดบลูทูธ ถือโทรศัพท์ใกล้อุปกรณ์ ถ้าหน้าจออุปกรณ์ขึ้น PAIRING CLOSED ให้กดปุ่ม BOOT ค้าง 5 วินาที แล้วลองใหม่`
          : bleConnectErrorMessage(e)
      );
      return;
    }
    if (aborted() || wifiSettledRef.current) {
      // หมดเวลาไปแล้วระหว่างเชื่อมต่อ → ไม่ส่งอะไรต่อ
      await releaseBle();
      return;
    }

    // ผลจากอุปกรณ์ (มาได้ทั้ง notify และ READ)
    const handleBoardMessage = (msg: any, fromRead: boolean) => {
      if (wifiSettledRef.current || aborted() || !msg) return;
      if (msg.wifi_status === 'ok') {
        wifiSettledRef.current = true;
        stopTimers();
        void releaseBle().then(() => {
          if (!aborted()) void runBind(runId);
        });
        return;
      }
      const isError = msg.wifi_status === 'error' || msg.status === 'error' || msg.locked === true;
      if (!isError) return;
      const code = boardErrorCode(msg) ?? (msg.locked === true ? 'ERR_LOCKED_OUT' : null);
      if (!code && fromRead) {
        // fw รุ่นเก่า: READ บอกแค่ error ไม่มีโค้ด — รอ notify ที่มีเหตุผลอีก 2 รอบก่อนสรุป
        codelessErrorCountRef.current += 1;
        if (codelessErrorCountRef.current < 3) return;
      }
      wifiSettledRef.current = true;
      void releaseBle();
      fail(runId, 'wifi', boardErrorMessage(code, cleanSsid));
    };

    try {
      await startJsonNotifications(bleId, (msg) => handleBoardMessage(msg, false)).catch((e) => {
        console.warn('[WifiSetup] notify unavailable, using READ polling only:', e);
      });

      // 1) auth ครั้งเดียว
      await writeJson(bleId, { cmd: 'auth', c: claimCode });
      let authOk = false;
      for (let i = 0; i < 16 && !aborted() && !wifiSettledRef.current; i++) {
        await sleep(250);
        const res = await readJson(bleId).catch(() => null);
        if (!res) continue;
        if (res.auth === true || res.status === 'auth_ok') {
          authOk = true;
          break;
        }
        const code = boardErrorCode(res);
        if (res.locked === true || code === 'ERR_LOCKED_OUT') {
          wifiSettledRef.current = true;
          await releaseBle();
          fail(runId, 'wifi', boardErrorMessage('ERR_LOCKED_OUT'));
          return;
        }
        if (code === 'ERR_AUTH_FAILED' || code === 'UNAUTHORIZED') {
          wifiSettledRef.current = true;
          await releaseBle();
          fail(runId, 'wifi', boardErrorMessage(code));
          return;
        }
      }
      if (aborted() || wifiSettledRef.current) return;
      if (!authOk) {
        wifiSettledRef.current = true;
        await releaseBle();
        fail(runId, 'wifi', boardErrorMessage('UNAUTHORIZED'));
        return;
      }

      // 2) ส่ง WiFi (ไม่ต้องแนบ c เพราะ auth ผ่านแล้ว)
      if (wifiSettledRef.current) return;
      await writeJson(bleId, { ssid: cleanSsid, pass: wifiPassword });
      if (aborted() || wifiSettledRef.current) return;

      // 3) poll READ ทุก 1.2 วิ ควบคู่กับ notify
      pollRef.current = setInterval(async () => {
        if (wifiSettledRef.current || aborted()) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          return;
        }
        const id = connectedBleRef.current;
        if (!id) return;
        const res = await readJson(id).catch(() => null);
        if (res) handleBoardMessage(res, true);
      }, 1200);
    } catch (bleErr) {
      console.warn('[WifiSetup] BLE write error:', bleErr);
      if (aborted() || wifiSettledRef.current) return;
      wifiSettledRef.current = true;
      await releaseBle();
      fail(runId, 'wifi', 'การสื่อสารบลูทูธขัดข้อง โปรดถือโทรศัพท์ใกล้อุปกรณ์แล้วลองใหม่อีกครั้ง');
    }
  };

  /* ── ลองผูกบัญชีใหม่อย่างเดียว (ไม่ส่ง WiFi ซ้ำ) ── */
  const handleRetryBind = () => {
    const runId = ++runIdRef.current;
    stopTimers();
    void runBind(runId);
  };

  const goHomeOnce = () => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    navigate('home');
  };

  /* ═══════════════════════════════════════════════════════
     VIEW 1: หน้าฟอร์มเรียบง่าย (ดึง WiFi จริงจากมือถือ 2.4GHz)
  ══════════════════════════════════════════════════════ */
  if (step === 'form') {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#ffffff',
          color: '#0f172a',
          fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '48px 24px 36px',
          boxSizing: 'border-box',
        }}
      >
        <div>
          {/* Top Back Button */}
          <div style={{ marginBottom: 32 }}>
            <button
              type="button"
              onClick={() => (goBack ? goBack('add-board') : navigate('add-board'))}
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#334155',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <ArrowLeft size={20} strokeWidth={1.75} />
            </button>
          </div>

          {/* Title & Guidelines */}
          <h1
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: '#0f172a',
              margin: '0 0 8px',
              letterSpacing: '-0.02em',
            }}
          >
            เลือกเครือข่าย Wi-Fi
          </h1>
          <p
            style={{
              fontSize: 13,
              color: '#64748b',
              margin: '0 0 36px',
              lineHeight: 1.6,
            }}
          >
            อุปกรณ์นี้รองรับเฉพาะ Wi-Fi 2.4GHz เท่านั้น<br />
            ชื่อของ Wi-Fi รองรับเฉพาะตัวอักษรและตัวเลขเท่านั้น
          </p>

          {/* Form Inputs */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Input 1: WiFi SSID with Real 2.4GHz Hardware Dropdown */}
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  borderBottom: '1.5px solid #cbd5e1',
                  paddingBottom: 8,
                }}
              >
                <input
                  type="text"
                  value={wifiSsid}
                  onChange={(e) => setWifiSsid(e.target.value)}
                  placeholder="ชื่อเครือข่าย Wi-Fi"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-form-type="other"
                  name="farm_wifi_ssid_field"
                  id="farm_wifi_ssid_field"
                  style={{
                    flex: 1,
                    border: 'none',
                    outline: 'none',
                    fontSize: 16,
                    color: '#0f172a',
                    background: 'transparent',
                    padding: 0,
                  }}
                />
                <button
                  type="button"
                  onClick={handleToggleDropdown}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#64748b',
                    cursor: 'pointer',
                    padding: 0, minWidth: 44, minHeight: 44, justifyContent: 'center',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  title="ดูรายชื่อ Wi-Fi 2.4GHz จริงที่ตรวจพบ"
                >
                  <ChevronDown
                    size={20}
                    strokeWidth={1.75}
                    style={{
                      transform: showDropdown ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s ease',
                    }}
                  />
                </button>
              </div>

              {/* Real 2.4GHz Networks Dropdown */}
              {showDropdown && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    background: '#ffffff',
                    border: '1px solid #cbd5e1',
                    borderRadius: 14,
                    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.12)',
                    zIndex: 30,
                    marginTop: 6,
                    maxHeight: 260,
                    overflowY: 'auto',
                  }}
                >
                  {/* Dropdown Header with Real Scan Status & Refresh */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: '#f8fafc',
                      borderBottom: '1px solid #f1f5f9',
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#64748b',
                    }}
                  >
                    <span>
                      {isScanningWifi
                        ? 'กำลังสแกนคลื่น 2.4GHz...'
                        : `พบ ${real24GNetworks.length} เครือข่าย (2.4GHz)`}
                    </span>
                    <button
                      type="button"
                      onClick={() => void triggerNativeWifiScan()}
                      disabled={isScanningWifi}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: isScanningWifi ? '#94a3b8' : '#059669',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: isScanningWifi ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '0 4px', minHeight: 44,
                      }}
                    >
                      <RotateCw
                        size={12}
                        style={{ animation: isScanningWifi ? 'spin 1s linear infinite' : 'none' }}
                      />
                      <span>สแกนใหม่</span>
                    </button>
                  </div>

                  {/* Real Scanned 2.4GHz Networks */}
                  {real24GNetworks.length > 0 ? (
                    real24GNetworks.map((net) => (
                      <div
                        key={`${net.ssid}-${net.bssid || net.level}`}
                        onClick={() => {
                          setWifiSsid(net.ssid);
                          setShowDropdown(false);
                        }}
                        style={{
                          padding: '12px 14px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderBottom: '1px solid #f1f5f9',
                          cursor: 'pointer',
                          background: wifiSsid === net.ssid ? '#ecfdf5' : '#ffffff',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ color: '#059669' }}>
                            <WifiSignalIcon level={net.level} size={15} />
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 500, color: '#0f172a' }}>
                              {net.ssid}
                            </div>
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>
                              {net.frequency > 0 ? `2.4 GHz (${net.frequency} MHz)` : '2.4 GHz'}
                            </div>
                          </div>
                        </div>

                        {wifiSsid === net.ssid && <Check size={16} strokeWidth={2.5} color="#059669" />}
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: '16px', textAlign: 'center', color: '#64748b', fontSize: 12 }}>
                      {isScanningWifi ? (
                        <span>กำลังสแกนหาสัญญาณ Wi-Fi 2.4GHz จริงจากโทรศัพท์...</span>
                      ) : scanErrorMsg ? (
                        <span style={{ color: '#dc2626' }}>{scanErrorMsg}</span>
                      ) : (
                        <span>ไม่พบสัญญาณ Wi-Fi 2.4GHz (สามารถพิมพ์ชื่อเครือข่ายเองได้)</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Input 2: WiFi Password */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                borderBottom: '1.5px solid #cbd5e1',
                paddingBottom: 8,
              }}
            >
              <input
                type={showPassword ? 'text' : 'password'}
                value={wifiPassword}
                onChange={(e) => setWifiPassword(e.target.value)}
                placeholder="รหัสผ่าน Wi-Fi"
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  fontSize: 16,
                  color: '#0f172a',
                  background: 'transparent',
                  padding: 0,
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: 0, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center',
                  display: 'flex',
                }}
              >
                {showPassword ? <EyeOff size={20} strokeWidth={1.5} /> : <Eye size={20} strokeWidth={1.5} />}
              </button>
            </div>
          </div>
        </div>

        {/* Bottom Button "ถัดไป" */}
        <div style={{ marginTop: 40 }}>
          <button
            type="button"
            disabled={!wifiSsid.trim()}
            onClick={handleNext}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: 24,
              background: '#059669',
              color: '#ffffff',
              border: 'none',
              fontSize: 15,
              fontWeight: 600,
              cursor: !wifiSsid.trim() ? 'not-allowed' : 'pointer',
              opacity: !wifiSsid.trim() ? 0.45 : 1,
              boxShadow: '0 4px 14px rgba(5, 150, 105, 0.25)',
              transition: 'opacity 0.2s',
            }}
          >
            ถัดไป
          </button>
        </div>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════
     VIEW 2: สถานะการตั้งค่า (ส่ง WiFi → อุปกรณ์ออนไลน์ → ผูกบัญชี → เสร็จ)
  ══════════════════════════════════════════════════════ */
  const isFailed = step === 'failed';
  const isDone = step === 'done';
  const title = isDone
    ? 'ตั้งค่าอุปกรณ์สำเร็จ'
    : isFailed
      ? failStage === 'wifi'
        ? 'เชื่อมต่อ Wi-Fi ไม่สำเร็จ'
        : 'ผูกบัญชีไม่สำเร็จ'
      : 'กำลังตั้งค่าอุปกรณ์';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#ffffff',
        color: '#0f172a',
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '48px 24px 36px',
        boxSizing: 'border-box',
      }}
    >
      <div>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <span
            style={{
              fontSize: 12,
              fontFamily: 'monospace',
              background: '#f1f5f9',
              color: '#475569',
              padding: '4px 12px',
              borderRadius: 100,
              display: 'inline-block',
              marginBottom: 12,
            }}
          >
            {boardId || '--'}
          </span>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: '#0f172a', margin: '0 0 6px' }}>{title}</h2>
          {step === 'provisioning' && phase === 0 && (
            <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>เหลือเวลาอีก {timeoutSeconds} วินาที</p>
          )}
        </div>

        {/* ลำดับขั้น: ส่ง WiFi → อุปกรณ์ออนไลน์ → ผูกบัญชี → เสร็จ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 320, margin: '0 auto' }}>
          {PROVISION_STEPS.map((s, i) => {
            const done = phase > i || (isDone && i === PROVISION_STEPS.length - 1);
            const active = !done && phase === i && step === 'provisioning';
            const failedHere = !done && phase === i && isFailed;
            const Icon = STEP_ICONS[i];
            return (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    background: done ? '#ecfdf5' : failedHere ? '#fef2f2' : active ? '#f0fdf4' : '#f8fafc',
                    color: done ? '#059669' : failedHere ? '#dc2626' : '#94a3b8',
                    border: done ? '1.5px solid #a7f3d0' : failedHere ? '1.5px solid #fecaca' : '1px solid #e2e8f0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {done ? (
                    <Check size={18} strokeWidth={2.5} />
                  ) : failedHere ? (
                    <AlertCircle size={16} strokeWidth={2} />
                  ) : active ? (
                    <RotateCw size={15} strokeWidth={2} style={{ animation: 'spin 1s linear infinite', color: '#059669' }} />
                  ) : (
                    <Icon size={16} strokeWidth={1.5} />
                  )}
                </div>
                <div>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: done || active || failedHere ? '#0f172a' : '#94a3b8',
                      display: 'block',
                    }}
                  >
                    {s.label}
                  </span>
                  <span style={{ fontSize: 12, color: done ? '#059669' : failedHere ? '#dc2626' : active ? '#64748b' : '#cbd5e1' }}>
                    {done ? s.doneText : failedHere ? 'ไม่สำเร็จ' : active ? s.activeText : 'รอดำเนินการ'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Error message (ข้อความจริงจากอุปกรณ์/คลาวด์) */}
        {isFailed && (
          <div
            role="alert"
            style={{
              background: '#fef2f2',
              border: '1px solid #fee2e2',
              borderRadius: 12,
              padding: '12px 16px',
              marginTop: 28,
              textAlign: 'center',
            }}
          >
            <p style={{ fontSize: 13, fontWeight: 600, color: '#dc2626', margin: '0 0 4px' }}>{title}</p>
            <p style={{ fontSize: 12, color: '#b91c1c', margin: 0, lineHeight: 1.6 }}>
              {provisionErrorMsg || 'โปรดลองใหม่อีกครั้ง'}
            </p>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ marginTop: 40 }}>
        {isFailed && failStage === 'wifi' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              type="button"
              onClick={() => {
                stopTimers();
                setStep('form');
              }}
              style={{
                width: '100%',
                minHeight: 48,
                padding: '14px',
                borderRadius: 24,
                background: '#059669',
                color: '#ffffff',
                border: 'none',
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              แก้ไขชื่อและรหัสผ่าน
            </button>
            <button
              type="button"
              onClick={handleNext}
              style={{
                width: '100%',
                minHeight: 44,
                padding: '12px',
                borderRadius: 24,
                background: '#f1f5f9',
                color: '#334155',
                border: 'none',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              ลองอีกครั้ง
            </button>
          </div>
        ) : isFailed ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              type="button"
              onClick={handleRetryBind}
              style={{
                width: '100%',
                minHeight: 48,
                padding: '14px',
                borderRadius: 24,
                background: '#059669',
                color: '#ffffff',
                border: 'none',
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ลองผูกบัญชีอีกครั้ง
            </button>
            {failStage === 'bind' && (
              <button
                type="button"
                onClick={goHomeOnce}
                style={{
                  width: '100%',
                  minHeight: 44,
                  padding: '12px',
                  borderRadius: 24,
                  background: '#f1f5f9',
                  color: '#334155',
                  border: 'none',
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                ไปหน้าหลัก
              </button>
            )}
          </div>
        ) : isDone ? (
          <button
            type="button"
            onClick={goHomeOnce}
            style={{
              width: '100%',
              minHeight: 48,
              padding: '14px',
              borderRadius: 24,
              background: '#059669',
              color: '#ffffff',
              border: 'none',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(5, 150, 105, 0.25)',
            }}
          >
            เริ่มใช้งาน
          </button>
        ) : null}
      </div>
    </div>
  );
}
