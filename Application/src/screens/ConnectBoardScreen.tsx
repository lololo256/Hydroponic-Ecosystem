import { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import {
  X,
  AlertCircle,
  Flashlight,
  FlashlightOff,
  Radio,
  Check,
  RotateCw,
} from 'lucide-react';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { isBleAvailable, isIos, DEVICE_NAME_RE, CLAIM_CODE_RE } from '../services/bleProvisioning';
import { pickWaitBound } from '../services/bleBindStatus';
import { thingsboard } from '../services/thingsboard';

const BOUND_TIMEOUT_MS = 30000;

type QrPayload = { d: string; c: string; m: string | null };
type ClaimPhase = 'checking' | 'binding' | 'wifi' | 'bind-timeout';

/**
 * QR ที่รับ: JSON `{"d":"FARM-XXXXXX","c":"<10 ตัว>","m":"<MAC>"}` เท่านั้น (CONTRACT v3 §5)
 * ไม่มีค่า fallback ไม่รับรูปแบบอื่น
 */
function parseFarmQr(raw: string): QrPayload | null {
  const trimmed = (raw || '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const d = typeof parsed.d === 'string' ? parsed.d.trim().toUpperCase() : '';
  const c = typeof parsed.c === 'string' ? parsed.c.trim() : '';
  if (!DEVICE_NAME_RE.test(d) || !CLAIM_CODE_RE.test(c)) return null;

  let m: string | null = null;
  if (typeof parsed.m === 'string') {
    let mac = parsed.m.trim().toUpperCase().replace(/-/g, ':');
    if (/^[0-9A-F]{12}$/.test(mac)) mac = mac.match(/.{2}/g)!.join(':');
    if (/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) m = mac;
  }
  return { d, c, m };
}

export default function ConnectBoardScreen({ navigate, goBack }: NavProps) {
  const smartFarm = useSmartFarm();
  const { claimBoardDevice } = smartFarm;

  // Camera & Scanning state
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanLoopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scannedRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  const navigatedRef = useRef<boolean>(false);
  const barcodeDetectorRef = useRef<any>(null);
  const uiTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const pendingQrRef = useRef<QrPayload | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState<boolean>(false);
  const [qrValidationError, setQrValidationError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [scanSuccess, setScanSuccess] = useState<boolean>(false);
  const [detectedId, setDetectedId] = useState<string>('');
  const [claimPhase, setClaimPhase] = useState<ClaimPhase>('checking');

  /** setTimeout ที่ถูกล้างอัตโนมัติตอนออกจากหน้า */
  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      uiTimersRef.current.delete(t);
      if (mountedRef.current) fn();
    }, ms);
    uiTimersRef.current.add(t);
  }, []);

  const navigateOnce = useCallback(
    (screen: 'home' | 'wifi-setup' | 'add-board') => {
      if (navigatedRef.current || !mountedRef.current) return;
      navigatedRef.current = true;
      navigate(screen);
    },
    [navigate]
  );

  /* ── Stop Camera Stream cleanly ── */
  const stopCamera = useCallback(() => {
    if (scanLoopTimerRef.current) {
      clearTimeout(scanLoopTimerRef.current);
      scanLoopTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          (track as any).applyConstraints?.({ advanced: [{ torch: false }] });
        } catch (e) {}
        track.stop();
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setTorchOn(false);
  }, []);

  /* ── Flashlight Toggle with Hardware Feedback ── */
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (track) {
      try {
        const next = !torchOn;
        await (track as any).applyConstraints({
          advanced: [{ torch: next }],
        });
        setTorchOn(next);
      } catch (e) {
        console.warn('Flashlight toggle not supported:', e);
        setCamError('ระบบกล้องไม่อนุญาตให้เปิดไฟฉาย กรุณาเปิดไฟห้องเพื่อสแกน');
        later(() => setCamError(null), 3000);
      }
    }
  };

  /* ── ไปหน้าตั้งค่า WiFi พร้อมข้อมูล d/c (+ MAC เฉพาะ Android) ── */
  const goToWifiSetup = useCallback(
    (qr: QrPayload) => {
      sessionStorage.setItem('provision_board_id', qr.d);
      sessionStorage.setItem('provision_claim_code', qr.c);
      // iOS: deviceId ของ BLE เป็น UUID ไม่ใช่ MAC → ให้หน้า WiFi สแกนหาชื่อที่ตรงกันเอง
      if (qr.m && !isIos()) sessionStorage.setItem('provision_ble_id', qr.m);
      else sessionStorage.removeItem('provision_ble_id');
      navigateOnce('wifi-setup');
    },
    [navigateOnce]
  );

  /* ── หลังสแกนสำเร็จ: ถ้าอุปกรณ์ออนไลน์อยู่แล้ว claim ได้ทันที → รอ bound → หน้าหลัก; ไม่งั้นไปตั้งค่า WiFi ── */
  const runClaimFlow = useCallback(
    async (qr: QrPayload) => {
      const aborted = () => !mountedRef.current || navigatedRef.current;
      setClaimPhase('checking');
      let claim: { success: boolean; message: string; deviceId?: string } | null = null;
      try {
        claim = await claimBoardDevice(qr.d, qr.c);
      } catch (err) {
        console.warn('[ConnectBoard] claim notice:', err);
        claim = null;
      }
      if (aborted()) return;

      if (!claim || !claim.success) {
        // อุปกรณ์ยังไม่ออนไลน์ (ยังไม่มี WiFi) → ตั้งค่า WiFi ผ่านบลูทูธ
        setClaimPhase('wifi');
        later(() => goToWifiSetup(qr), 500);
        return;
      }

      // อุปกรณ์เป็นของบัญชีนี้แล้วแต่ยังไม่ต่อ Wi-Fi (เช่น หลังรีเซ็ต Wi-Fi) → ตั้งค่า Wi-Fi ผ่านบลูทูธ
      if (claim.deviceId) {
        const online = await thingsboard.isDeviceOnline(claim.deviceId).catch(() => false);
        if (aborted()) return;
        if (!online) {
          setClaimPhase('wifi');
          later(() => goToWifiSetup(qr), 500);
          return;
        }
      }

      setClaimPhase('binding');
      let bound = false;
      if (claim.deviceId) {
        const waitBound = pickWaitBound(smartFarm, aborted);
        bound = await waitBound(claim.deviceId, BOUND_TIMEOUT_MS).catch(() => false);
      }
      if (aborted()) return;
      if (bound) {
        sessionStorage.removeItem('provision_claim_code');
        navigateOnce('home');
      } else {
        setClaimPhase('bind-timeout');
      }
    },
    [claimBoardDevice, goToWifiSetup, later, navigateOnce, smartFarm]
  );

  /* ── Process Scanned QR Data ── */
  const handleScannedPayload = (rawData: string) => {
    if (scannedRef.current) return;

    const qr = parseFarmQr(rawData);
    if (!qr) {
      setQrValidationError('QR นี้ไม่ใช่อุปกรณ์ SmartFarm');
      later(() => setQrValidationError(null), 2200);
      return;
    }

    // Lock scanner immediately
    scannedRef.current = true;
    pendingQrRef.current = qr;
    setScanSuccess(true);
    setDetectedId(qr.d);

    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(50);
      }
    } catch (e) {}

    if (scanLoopTimerRef.current) {
      clearTimeout(scanLoopTimerRef.current);
      scanLoopTimerRef.current = null;
    }
    stopCamera();
    void runClaimFlow(qr);
  };
  const handlePayloadRef = useRef(handleScannedPayload);
  handlePayloadRef.current = handleScannedPayload;

  /* ── Lightning-Fast Frame Scan Loop ── */
  const scanLoop = useCallback(async () => {
    if (scannedRef.current || !mountedRef.current) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      scanLoopTimerRef.current = setTimeout(scanLoop, 60);
      return;
    }

    // 1. Hardware-accelerated BarcodeDetector (สร้างครั้งเดียว)
    if (barcodeDetectorRef.current === null && typeof (window as any).BarcodeDetector !== 'undefined') {
      try {
        barcodeDetectorRef.current = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        barcodeDetectorRef.current = false;
      }
    }
    if (barcodeDetectorRef.current) {
      try {
        const barcodes = await barcodeDetectorRef.current.detect(video);
        if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
          handlePayloadRef.current(barcodes[0].rawValue);
          if (scannedRef.current) return;
        }
      } catch (err) {
        // Fallback to canvas scan
      }
    }

    // 2. Cropped canvas fallback (480x480 center crop with attemptBoth for LCD screens)
    const canvas = canvasRef.current;
    if (canvas && !scannedRef.current) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 480;
        const cropSize = Math.min(vw, vh) * 0.75;
        const sx = (vw - cropSize) / 2;
        const sy = (vh - cropSize) / 2;

        canvas.width = 480;
        canvas.height = 480;

        ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, 480, 480);

        try {
          const imageData = ctx.getImageData(0, 0, 480, 480);
          let result = jsQR(imageData.data, 480, 480, {
            inversionAttempts: 'attemptBoth',
          });

          if (!result && vw > 0 && vh > 0) {
            canvas.width = 480;
            canvas.height = Math.round((vh / vw) * 480);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const fullImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
            result = jsQR(fullImg.data, canvas.width, canvas.height, {
              inversionAttempts: 'attemptBoth',
            });
          }

          if (result && result.data) {
            handlePayloadRef.current(result.data);
            if (scannedRef.current) return;
          }
        } catch (e) {
          // Continue scanning
        }
      }
    }

    if (!scannedRef.current && mountedRef.current) {
      scanLoopTimerRef.current = setTimeout(scanLoop, 60);
    }
  }, []);

  /* ── Start Camera Stream with fast 720p ── */
  const startCamera = useCallback(async () => {
    stopCamera();
    scannedRef.current = false;
    setCamError(null);
    setPermissionDenied(false);
    setQrValidationError(null);

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        scanLoopTimerRef.current = setTimeout(scanLoop, 100);
      }
    } catch (err: any) {
      if (!mountedRef.current) return;
      setPermissionDenied(true);
      setCamError('ต้องอนุญาตให้ใช้กล้องเพื่อสแกน');
    }
  }, [stopCamera, scanLoop]);

  /* ── Open Device App Settings ── */
  const handleOpenSettings = async () => {
    if (isBleAvailable()) {
      try {
        await BleClient.openAppSettings();
        return;
      } catch (e) {}
    }
    void startCamera();
  };

  useEffect(() => {
    mountedRef.current = true;
    void startCamera();
    const timers = uiTimersRef.current;
    return () => {
      mountedRef.current = false;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  const bracketColor = '#10b981';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        background: '#0d0e12',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        overflow: 'hidden',
        zIndex: 999,
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
      }}
    >
      <style>{`
        @keyframes xiaomiScanLaser {
          0% {
            top: 10px;
            opacity: 0.8;
          }
          50% {
            opacity: 1;
          }
          100% {
            top: calc(100% - 12px);
            opacity: 0.8;
          }
        }
      `}</style>

      {/* 1. Fullscreen Video Stream */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          zIndex: 1,
        }}
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* 2. Top Header */}
      <div
        style={{
          position: 'relative',
          zIndex: 20,
          padding: 'calc(env(safe-area-inset-top, 24px) + 16px) 20px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <button
          type="button"
          onClick={() => {
            stopCamera();
            goBack ? goBack('add-board') : navigate('add-board');
          }}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'rgba(0, 0, 0, 0.45)',
            border: 'none',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
          }}
          title="ปิด"
        >
          <X size={20} strokeWidth={1.75} />
        </button>

        <span
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: '#ffffff',
            letterSpacing: '-0.01em',
          }}
        >
          สแกน QR อุปกรณ์
        </span>

        <button
          type="button"
          onClick={toggleTorch}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: torchOn ? 'rgba(16, 185, 129, 0.7)' : 'rgba(0, 0, 0, 0.45)',
            border: 'none',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            transition: 'background-color 0.2s ease',
          }}
          title={torchOn ? 'ปิดไฟฉาย' : 'เปิดไฟฉาย'}
        >
          {torchOn ? <Flashlight size={20} strokeWidth={1.75} /> : <FlashlightOff size={20} strokeWidth={1.75} />}
        </button>
      </div>

      {/* 3. Center Viewfinder with Laser Scanner */}
      <div
        style={{
          position: 'relative',
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
        }}
      >
        {/* Invalid QR Error Banner */}
        {qrValidationError && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              background: 'rgba(220, 38, 38, 0.95)',
              color: '#ffffff',
              padding: '10px 18px',
              borderRadius: 12,
              fontSize: 13,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              zIndex: 25,
              boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
            }}
          >
            <AlertCircle size={16} strokeWidth={2} />
            <span>{qrValidationError}</span>
          </div>
        )}

        {/* Viewfinder frame */}
        <div
          style={{
            width: '68vw',
            height: '68vw',
            maxWidth: 270,
            maxHeight: 270,
            position: 'relative',
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
            borderRadius: 18,
          }}
        >
          {/* Top-Left Bracket */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 28,
              height: 28,
              borderTop: `4px solid ${bracketColor}`,
              borderLeft: `4px solid ${bracketColor}`,
              borderTopLeftRadius: 16,
              filter: scanSuccess ? 'drop-shadow(0 0 8px #10b981)' : 'none',
              transition: 'border-color 0.2s ease, filter 0.2s ease',
            }}
          />
          {/* Top-Right Bracket */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 28,
              height: 28,
              borderTop: `4px solid ${bracketColor}`,
              borderRight: `4px solid ${bracketColor}`,
              borderTopRightRadius: 16,
              filter: scanSuccess ? 'drop-shadow(0 0 8px #10b981)' : 'none',
              transition: 'border-color 0.2s ease, filter 0.2s ease',
            }}
          />
          {/* Bottom-Left Bracket */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              width: 28,
              height: 28,
              borderBottom: `4px solid ${bracketColor}`,
              borderLeft: `4px solid ${bracketColor}`,
              borderBottomLeftRadius: 16,
              filter: scanSuccess ? 'drop-shadow(0 0 8px #10b981)' : 'none',
              transition: 'border-color 0.2s ease, filter 0.2s ease',
            }}
          />
          {/* Bottom-Right Bracket */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              right: 0,
              width: 28,
              height: 28,
              borderBottom: `4px solid ${bracketColor}`,
              borderRight: `4px solid ${bracketColor}`,
              borderBottomRightRadius: 16,
              filter: scanSuccess ? 'drop-shadow(0 0 8px #10b981)' : 'none',
              transition: 'border-color 0.2s ease, filter 0.2s ease',
            }}
          />

          {/* Animated Green Laser Line */}
          <div
            style={{
              position: 'absolute',
              left: 8,
              right: 8,
              height: 2,
              background: 'linear-gradient(90deg, rgba(16, 185, 129, 0) 0%, rgba(16, 185, 129, 1) 50%, rgba(16, 185, 129, 0) 100%)',
              boxShadow: '0 0 10px rgba(16, 185, 129, 0.8), 0 0 3px rgba(52, 211, 153, 0.9)',
              borderRadius: 2,
              pointerEvents: 'none',
              animation: 'xiaomiScanLaser 1.8s ease-in-out infinite alternate',
            }}
          />
        </div>

        {/* Caption */}
        <p
          style={{
            position: 'relative',
            zIndex: 20,
            fontSize: 14,
            color: 'rgba(255, 255, 255, 0.75)',
            textAlign: 'center',
            margin: '28px 0 0',
            fontWeight: 400,
          }}
        >
          จัดให้ QR Code ของอุปกรณ์อยู่ภายในกรอบ
        </p>
      </div>

      {/* 4. Bottom Action: ค้นหาผ่านบลูทูธ */}
      <div
        style={{
          position: 'relative',
          zIndex: 20,
          paddingBottom: 'calc(env(safe-area-inset-bottom, 16px) + 24px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <button
          type="button"
          onClick={() => {
            stopCamera();
            navigate('add-board');
          }}
          style={{
            height: 46,
            padding: '0 24px',
            borderRadius: 9999,
            background: 'rgba(28, 29, 34, 0.85)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            color: '#ffffff',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.3)',
          }}
        >
          <Radio size={16} strokeWidth={1.75} color="#10b981" />
          <span>ค้นหาผ่านบลูทูธแทน</span>
        </button>
      </div>

      {/* 5. Smooth Dark Success Overlay (Prevents white flash) */}
      {scanSuccess && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 100,
            background: '#0d0e12',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 68,
              height: 68,
              borderRadius: '50%',
              background: 'rgba(16, 185, 129, 0.15)',
              border: '2px solid #10b981',
              color: '#10b981',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 18,
              boxShadow: '0 0 24px rgba(16, 185, 129, 0.3)',
            }}
          >
            <Check size={36} strokeWidth={2.5} />
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 600, color: '#ffffff', margin: '0 0 6px' }}>
            ตรวจพบอุปกรณ์เรียบร้อย
          </h3>
          <p style={{ fontSize: 13, color: '#10b981', fontFamily: 'monospace', fontWeight: 600, margin: '0 0 10px' }}>
            {detectedId}
          </p>
          {claimPhase === 'bind-timeout' ? (
            <div style={{ maxWidth: 320 }}>
              <p style={{ fontSize: 13, color: '#fca5a5', margin: '0 0 18px', lineHeight: 1.6 }}>
                อุปกรณ์อยู่ในบัญชีแล้ว แต่ยังไม่ยืนยันการผูกภายใน 30 วินาที
                โปรดตรวจว่าอุปกรณ์ต่อเน็ตอยู่ แล้วลองอีกครั้ง
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => pendingQrRef.current && void runClaimFlow(pendingQrRef.current)}
                  style={{
                    minHeight: 48,
                    padding: '0 24px',
                    borderRadius: 9999,
                    background: '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  ลองผูกบัญชีอีกครั้ง
                </button>
                <button
                  type="button"
                  onClick={() => navigateOnce('home')}
                  style={{
                    minHeight: 44,
                    padding: '0 24px',
                    borderRadius: 9999,
                    background: 'rgba(38, 42, 50, 0.75)',
                    color: '#ffffff',
                    border: 'none',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  ไปหน้าหลัก
                </button>
              </div>
            </div>
          ) : (
            <p
              style={{ fontSize: 12, color: '#94a3b8', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}
              aria-live="polite"
            >
              <RotateCw size={13} strokeWidth={2} style={{ animation: 'spin 1s linear infinite' }} />
              {claimPhase === 'checking'
                ? 'กำลังตรวจสอบอุปกรณ์บนคลาวด์...'
                : claimPhase === 'binding'
                  ? 'รออุปกรณ์ยืนยันการผูกบัญชี...'
                  : 'อุปกรณ์ยังไม่เชื่อมต่อเน็ต กำลังไปหน้าตั้งค่า Wi-Fi...'}
            </p>
          )}
        </div>
      )}

      {/* 6. Permission Denied Modal */}
      {permissionDenied && (
        <div
          style={{
            position: 'absolute',
            zIndex: 50,
            inset: 0,
            background: 'rgba(0, 0, 0, 0.92)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: 'rgba(239, 68, 68, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ef4444',
              marginBottom: 16,
            }}
          >
            <AlertCircle size={26} strokeWidth={1.75} />
          </div>
          <p
            style={{
              color: '#ffffff',
              fontSize: 15,
              fontWeight: 500,
              margin: '0 0 20px',
              lineHeight: 1.5,
            }}
          >
            {camError || 'ต้องอนุญาตให้ใช้กล้องเพื่อสแกน'}
          </p>
          <button
            type="button"
            onClick={handleOpenSettings}
            style={{
              padding: '12px 28px',
              borderRadius: 9999,
              background: '#10b981',
              color: '#ffffff',
              border: 'none',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              marginBottom: 14,
              boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)',
            }}
          >
            เปิดการตั้งค่า
          </button>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              navigate('add-board');
            }}
            style={{
              height: 48,
              padding: '0 24px',
              borderRadius: 9999,
              background: 'rgba(38, 42, 50, 0.75)',
              border: 'none',
              color: '#ffffff',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Radio size={16} strokeWidth={1.75} color="#10b981" />
            <span>ค้นหาผ่านบลูทูธแทน</span>
          </button>
        </div>
      )}
    </div>
  );
}
