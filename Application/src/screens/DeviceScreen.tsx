import { useState } from 'react';
import { NavProps } from '../types';
import { mainTankStatusLabel } from '../services/telemetryContract';
import { isIos } from '../services/bleProvisioning';
import { useSmartFarm } from '../context/SmartFarmContext';
import {
  ArrowLeft,
  Cpu,
  Wifi,
  Activity,
  Layers,
  CheckCircle,
  AlertCircle,
  Trash2,
  Plus,
  RefreshCw,
  RotateCcw,
  AlertTriangle,
  Power,
  ShieldCheck,
  Check,
  X,
  Sliders,
  QrCode,
  Bluetooth,
} from 'lucide-react';

export default function DeviceScreen({ navigate, goBack }: NavProps) {
  const {
    data,
    connectedBoardId,
    savedBoards,
    connectBoard,
    removeBoard,
    disconnectBoard,
    rebootDevice,
    resetDeviceWifi,
    factoryResetDevice,
    telemetryFreshness,
    canControl,
  } = useSmartFarm();

  const [activeModal, setActiveModal] = useState<
    'none' | 'reboot' | 'resetWifi' | 'factoryReset' | 'remove'
  >('none');
  const [isProcessing, setIsProcessing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Reachable = telemetry live or stale (Contract v3 §6); commands need live.
  const isOnline = Boolean(connectedBoardId && (telemetryFreshness === 'live' || telemetryFreshness === 'stale'));
  // Remote maintenance commands need live telemetry (same gate as pumps).
  const commandsLocked = !canControl;
  const commandLockReason = !connectedBoardId
    ? 'ยังไม่ได้เชื่อมต่ออุปกรณ์'
    : telemetryFreshness === 'stale'
    ? 'ข้อมูลเริ่มเก่า รอให้อุปกรณ์ส่งค่าสดก่อนจึงสั่งงานได้'
    : telemetryFreshness === 'loading'
    ? 'กำลังโหลดสถานะอุปกรณ์'
    : 'อุปกรณ์ออฟไลน์ ไม่สามารถส่งคำสั่งได้';
  // Offline device: firmware opens BLE pairing by itself after 2 min without Wi-Fi -> change Wi-Fi over BLE.
  const showBleWifiChange = Boolean(connectedBoardId) && !isOnline && telemetryFreshness !== 'loading';
  const wifiConnected = isOnline ? data.device?.wifiConnected : undefined;
  const wifiLabel = wifiConnected === true ? 'เชื่อมต่อสำเร็จ' : wifiConnected === false ? 'ไม่ได้เชื่อมต่อ' : '--';
  const wifiColor = wifiConnected === true ? '#059669' : wifiConnected === false ? '#dc2626' : '#94a3b8';
  const tbHost = (() => {
    const raw = (import.meta.env.VITE_TB_URL as string | undefined) || '';
    if (!raw) return 'eu.thingsboard.cloud';
    try {
      return new URL(raw.includes('://') ? raw : `https://${raw}`).host || 'eu.thingsboard.cloud';
    } catch (_) {
      return 'eu.thingsboard.cloud';
    }
  })();
  const savedList = Object.entries(savedBoards || {}).map(([id, b]) => ({
    ...b,
    boardId: b.boardId || id,
  }));

  const handleConfirmReboot = async () => {
    setIsProcessing(true);
    try {
      const res = await rebootDevice();
      setActiveModal('none');
      showToast(res.success ? res.message : `รีสตาร์ตไม่สำเร็จ: ${res.message}`);
    } catch {
      showToast('เกิดข้อผิดพลาดในการส่งคำสั่งรีสตาร์ต');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmResetWifi = async () => {
    setIsProcessing(true);
    try {
      const res = await resetDeviceWifi();
      setActiveModal('none');
      if (!res.success) {
        showToast(`ล้างค่า Wi-Fi ไม่สำเร็จ: ${res.message}`);
        return;
      }
      if (res.provision) {
        // The device sent its pairing details with the reply: go straight to Wi-Fi entry (no QR).
        sessionStorage.setItem('provision_board_id', res.provision.d);
        sessionStorage.setItem('provision_claim_code', res.provision.c);
        if (res.provision.m && !isIos()) sessionStorage.setItem('provision_ble_id', res.provision.m);
        else sessionStorage.removeItem('provision_ble_id');
        showToast('อุปกรณ์ล้าง Wi-Fi แล้ว กำลังรีสตาร์ท ใส่ Wi-Fi ใหม่ได้เลย');
        setTimeout(() => {
          navigate('wifi-setup');
        }, 1200);
        return;
      }
      // older firmware without pairing details in the reply -> scan the QR on the device screen
      showToast('อุปกรณ์ล้าง Wi-Fi แล้ว สแกน QR บนหน้าจออุปกรณ์เพื่อตั้งค่า Wi-Fi ใหม่');
      setTimeout(() => {
        navigate('connect-board');
      }, 1200);
    } catch {
      showToast('เกิดข้อผิดพลาดในการรีเซ็ต Wi-Fi');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmFactoryReset = async () => {
    setIsProcessing(true);
    try {
      const res = await factoryResetDevice();
      setActiveModal('none');
      if (!res.success) {
        // Never show success when the board did not confirm
        showToast(`คืนค่าโรงงานไม่สำเร็จ: ${res.message}`);
        return;
      }
      showToast(res.message);
      setTimeout(() => {
        navigate('connect-board');
      }, 1500);
    } catch {
      showToast('เกิดข้อผิดพลาดในการคืนค่าเริ่มต้นจากโรงงาน');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmRemove = async () => {
    setIsProcessing(true);
    try {
      if (connectedBoardId) {
        await removeBoard(connectedBoardId);
      }
      setActiveModal('none');
      showToast('ยกเลิกการจับคู่อุปกรณ์เรียบร้อยแล้ว');
      setTimeout(() => {
        navigate('connect-board');
      }, 800);
    } catch (err: any) {
      showToast(err?.message || 'เกิดข้อผิดพลาดในการยกเลิกการจับคู่');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #F0FBF6 0%, #FFFFFF 100%)',
        paddingBottom: 88,
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {/* Toast Feedback */}
      {toastMessage && (
        <div
          style={{
            position: 'fixed',
            top: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(15, 23, 42, 0.94)',
            color: '#ffffff',
            padding: '12px 20px',
            borderRadius: 14,
            fontSize: 13,
            fontWeight: 500,
            zIndex: 9999,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            maxWidth: '90%',
            textAlign: 'center',
          }}
        >
          <CheckCircle size={18} color="#10b981" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Header */}
      <div
        style={{
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(12px)',
          padding: '52px 20px 16px',
          borderBottom: '1px solid rgba(226, 232, 240, 0.7)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <button
          type="button"
          onClick={() => (goBack ? goBack('settings') : navigate('settings'))}
          style={{
            background: 'none',
            border: 'none',
            padding: 4,
            cursor: 'pointer',
            color: '#334155',
            display: 'flex',
          }}
        >
          <ArrowLeft size={20} strokeWidth={1.75} />
        </button>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', margin: 0 }}>
            การตั้งค่าอุปกรณ์
          </h1>
          <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>
            จัดการสถานะ รีสตาร์ต และเครือข่ายของอุปกรณ์ Hydroponic
          </p>
        </div>
      </div>

      {savedList.length === 0 && !connectedBoardId ? (
        <div style={{ padding: '24px 16px' }}>
          <div
            style={{
              background: '#ffffff',
              borderRadius: 20,
              padding: '48px 20px',
              border: '1px solid #e2e8f0',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.03)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: '#f1f5f9',
                color: '#64748b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Cpu size={32} strokeWidth={1.5} />
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>
              ไม่มีอุปกรณ์ในบัญชีของคุณ
            </h2>
            <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 24px', lineHeight: 1.5, maxWidth: 280 }}>
              คุณยังไม่มีอุปกรณ์หรือได้ลบอุปกรณ์ออกจากระบบแล้ว โปรดเพิ่มอุปกรณ์ใหม่เพื่อเริ่มเชื่อมต่อและตั้งค่าการทำงาน
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 280 }}>
              <button
                type="button"
                onClick={() => navigate('add-board')}
                style={{
                  width: '100%',
                  padding: '13px',
                  borderRadius: 12,
                  background: '#059669',
                  color: '#ffffff',
                  border: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <Plus size={16} strokeWidth={2} />
                <span>เพิ่มอุปกรณ์ใหม่</span>
              </button>
              <button
                type="button"
                onClick={() => navigate('connect-board')}
                style={{
                  width: '100%',
                  padding: '13px',
                  borderRadius: 12,
                  background: '#f1f5f9',
                  color: '#334155',
                  border: '1px solid #cbd5e1',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <QrCode size={16} strokeWidth={1.75} />
                <span>สแกน QR เชื่อมต่ออุปกรณ์</span>
              </button>
            </div>
          </div>
        </div>
      ) : !connectedBoardId ? (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* มีอุปกรณ์ในบัญชีแต่ยังไม่ได้เชื่อมต่อตัวใด */}
          <div className="glass-card" style={{ padding: '16px' }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 4px' }}>
              อุปกรณ์ทั้งหมดในบัญชีของคุณ
            </h3>
            <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 12px' }}>
              กรุณาเลือกอุปกรณ์ที่ต้องการเชื่อมต่อเพื่อจัดการและตั้งค่า
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {savedList.map((board) => (
                <div
                  key={board.boardId}
                  onClick={() => connectBoard(board.boardId, board.name)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 14px',
                    borderRadius: 12,
                    background: '#f8fafc',
                    border: '1px solid rgba(226, 232, 240, 0.8)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Cpu size={18} color="#64748b" />
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', display: 'block' }}>
                        {board.name || board.boardId}
                      </span>
                      <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>
                        {board.boardId}
                      </span>
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>
                    เชื่อมต่อใช้งาน
                  </span>
                </div>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigate('connect-board')}
            style={{
              width: '100%',
              padding: '13px',
              borderRadius: 14,
              background: '#059669',
              color: '#ffffff',
              border: 'none',
              fontSize: 14,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <Plus size={18} strokeWidth={1.75} />
            <span>เชื่อมต่ออุปกรณ์ Hydroponic เพิ่ม</span>
          </button>
        </div>
      ) : (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* รายการอุปกรณ์ทั้งหมดที่บันทึกไว้ในบัญชี */}
          {savedList.length > 1 && (
            <div className="glass-card" style={{ padding: '16px' }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', margin: '0 0 10px' }}>
                อุปกรณ์ทั้งหมดในบัญชีของคุณ
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {savedList.map((board) => {
                  const isSelected = board.boardId === connectedBoardId;
                  return (
                    <div
                      key={board.boardId}
                      onClick={() => !isSelected && connectBoard(board.boardId, board.name)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        borderRadius: 12,
                        background: isSelected ? '#ecfdf5' : '#f8fafc',
                        border: `1px solid ${isSelected ? 'rgba(5, 150, 105, 0.3)' : 'rgba(226, 232, 240, 0.8)'}`,
                        cursor: isSelected ? 'default' : 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Cpu size={18} color={isSelected ? '#059669' : '#64748b'} />
                        <div>
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', display: 'block' }}>
                            {board.name || board.boardId}
                          </span>
                          <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>
                            {board.boardId}
                          </span>
                        </div>
                      </div>
                      {isSelected ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: isOnline ? '#059669' : '#475569',
                            }}
                          >
                            กำลังใช้งาน
                          </span>
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 600,
                              color: isOnline ? '#059669' : '#dc2626',
                              background: isOnline ? '#d1fae5' : '#fee2e2',
                              border: `1px solid ${isOnline ? '#bbf7d0' : '#fecaca'}`,
                              padding: '1px 6px',
                              borderRadius: 100,
                            }}
                          >
                            {isOnline ? 'ออนไลน์' : 'ออฟไลน์'}
                          </span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 12, color: '#059669', fontWeight: 500 }}>
                          สลับใช้งาน
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        {/* บัตรข้อมูลอุปกรณ์หลักที่กำลังใช้งาน */}
        <div
          className="glass-card"
          style={{
            padding: '20px',
            background: connectedBoardId ? (isOnline ? '#f0fdf6' : '#fffbfa') : 'rgba(255, 255, 255, 0.95)',
            border: `1px solid ${connectedBoardId ? (isOnline ? 'rgba(5, 150, 105, 0.25)' : 'rgba(220, 38, 38, 0.2)') : 'rgba(226, 232, 240, 0.8)'}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  background: '#ffffff',
                  color: isOnline ? '#059669' : '#64748b',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
                }}
              >
                <Cpu size={24} strokeWidth={1.5} />
              </div>
              <div>
                <p style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', margin: 0 }}>
                  Hydroponic Controller
                </p>
                <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 0', fontFamily: 'monospace' }}>
                  {connectedBoardId ? `ID: ${connectedBoardId}` : 'ยังไม่ได้เชื่อมต่ออุปกรณ์'}
                </p>
              </div>
            </div>

            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: 20,
                background: isOnline ? '#d1fae5' : '#fee2e2',
                color: isOnline ? '#059669' : '#dc2626',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: isOnline ? '#059669' : '#dc2626',
                }}
              />
              {connectedBoardId ? (isOnline ? 'ออนไลน์' : 'ออฟไลน์') : 'ไม่ได้เชื่อมต่อ'}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, fontSize: 12 }}>
            <div style={{ background: '#ffffff', padding: '10px 12px', borderRadius: 12 }}>
              <span style={{ color: '#94a3b8', display: 'block', marginBottom: 2 }}>ฮาร์ดแวร์</span>
              <span style={{ fontWeight: 600, color: '#0f172a' }}>ESP32-2432S028</span>
            </div>
            <div style={{ background: '#ffffff', padding: '10px 12px', borderRadius: 12 }}>
              <span style={{ color: '#94a3b8', display: 'block', marginBottom: 2 }}>จอแสดงผล</span>
              <span style={{ fontWeight: 600, color: '#0f172a' }}>2.8" Color TFT</span>
            </div>
            <div style={{ background: '#ffffff', padding: '10px 12px', borderRadius: 12 }}>
              <span style={{ color: '#94a3b8', display: 'block', marginBottom: 2 }}>การเชื่อมต่อ Wi-Fi</span>
              <span style={{ fontWeight: 600, color: wifiColor }}>{wifiLabel}</span>
            </div>
            <div style={{ background: '#ffffff', padding: '10px 12px', borderRadius: 12 }}>
              <span style={{ color: '#94a3b8', display: 'block', marginBottom: 2 }}>เฟิร์มแวร์</span>
              <span style={{ fontWeight: 600, color: '#94a3b8' }}>--</span>
            </div>
          </div>
        </div>

        {/* หมวดการจัดการและคำสั่งควบคุมระยะไกล */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 4px' }}>
            การควบคุมและบำรุงรักษาอุปกรณ์
          </h3>
          <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 10px' }}>
            สั่งการตัวควบคุมระยะไกลผ่านระบบคลาวด์ สะดวกและปลอดภัยโดยไม่ต้องสัมผัสสวิตช์ฮาร์ดแวร์จริง
          </p>

          <div style={{ background: '#ecfdf5', padding: '10px 14px', borderRadius: 12, marginBottom: 14, border: '1px solid #d1fae5' }}>
            <span style={{ fontSize: 12, color: '#065f46', fontWeight: 600, display: 'block' }}>
              เชื่อมต่อเซิร์ฟเวอร์ ThingsBoard Cloud ({tbHost})
            </span>
            <span style={{ fontSize: 11, color: '#047857' }}>
              ทุกคำสั่งจะถูกส่งตรงไปยังตัวควบคุมผ่าน ThingsBoard RPC และ Shared Attributes ทันที
            </span>
          </div>

          {commandsLocked && (
            <div
              role="status"
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f8fafc', border: '1px solid #e2e8f0', padding: '10px 14px', borderRadius: 12, marginBottom: 14 }}
            >
              <AlertCircle size={16} strokeWidth={2} color="#64748b" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: '#475569', fontWeight: 500 }}>
                คำสั่งรีสตาร์ต / Wi-Fi / คืนค่าโรงงานถูกล็อก: {commandLockReason}
              </span>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* คำสั่งที่ 1: รีสตาร์ตอุปกรณ์ */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 14px',
                background: '#f8fafc',
                borderRadius: 12,
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: '#eff6ff',
                    color: '#2563eb',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <RefreshCw size={18} strokeWidth={1.75} />
                </div>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', display: 'block' }}>
                    รีสตาร์ตอุปกรณ์ (Reboot)
                  </span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    ส่งคำสั่งรีบูตผ่าน ThingsBoard เมื่อเซนเซอร์หรือตัวควบคุมค้าง
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { if (!commandsLocked) setActiveModal('reboot'); }}
                disabled={commandsLocked}
                aria-disabled={commandsLocked}
                title={commandsLocked ? commandLockReason : undefined}
                style={{
                  background: commandsLocked ? '#cbd5e1' : '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  minHeight: 44,
                  minWidth: 44,
                  padding: '0 14px',
                  borderRadius: 10,
                  fontSize: 12,
                  fontWeight: 500,
                  flexShrink: 0,
                  cursor: commandsLocked ? 'not-allowed' : 'pointer',
                }}
              >
                รีสตาร์ต
              </button>
            </div>

            {/* คำสั่งที่ 2: เปลี่ยนหรือรีเซ็ตรหัสผ่าน Wi-Fi */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 14px',
                background: '#f8fafc',
                borderRadius: 12,
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: '#ecfdf5',
                    color: '#059669',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Wifi size={18} strokeWidth={1.75} />
                </div>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', display: 'block' }}>
                    เปลี่ยนเครือข่าย Wi-Fi
                  </span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    ส่งคำสั่งผ่าน ThingsBoard ให้ล้าง Wi-Fi เดิม และตั้งค่าใหม่
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { if (!commandsLocked) setActiveModal('resetWifi'); }}
                disabled={commandsLocked}
                aria-disabled={commandsLocked}
                title={commandsLocked ? commandLockReason : undefined}
                style={{
                  background: commandsLocked ? '#cbd5e1' : '#059669',
                  color: '#ffffff',
                  border: 'none',
                  minHeight: 44,
                  minWidth: 44,
                  padding: '0 14px',
                  borderRadius: 10,
                  fontSize: 12,
                  fontWeight: 500,
                  flexShrink: 0,
                  cursor: commandsLocked ? 'not-allowed' : 'pointer',
                }}
              >
                เปลี่ยน Wi-Fi
              </button>
            </div>

            {/* อุปกรณ์ออฟไลน์: เปลี่ยน Wi-Fi ผ่านบลูทูธ (อุปกรณ์เปิดบลูทูธเองเมื่อขาด Wi-Fi เกิน 2 นาที) */}
            {showBleWifiChange && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  background: '#f8fafc',
                  borderRadius: 12,
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: '#eff6ff',
                      color: '#2563eb',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Bluetooth size={18} strokeWidth={1.75} />
                  </div>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', display: 'block' }}>
                      เปลี่ยน Wi-Fi ผ่านบลูทูธ
                    </span>
                    <span style={{ fontSize: 11, color: '#64748b' }}>
                      อุปกรณ์ที่ขาด Wi-Fi เกิน 2 นาทีจะเปิดบลูทูธเอง อยู่ใกล้อุปกรณ์แล้วใส่รหัส 6 หลักบนจออุปกรณ์
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('add-board')}
                  style={{
                    background: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    minHeight: 44,
                    minWidth: 44,
                    padding: '0 14px',
                    borderRadius: 10,
                    fontSize: 12,
                    fontWeight: 500,
                    flexShrink: 0,
                    cursor: 'pointer',
                  }}
                >
                  ค้นหาอุปกรณ์
                </button>
              </div>
            )}

            {/* คำสั่งที่ 3: คืนค่าเริ่มต้นจากโรงงาน */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 14px',
                background: '#fffbeb',
                borderRadius: 12,
                border: '1px solid #fef3c7',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: '#fef3c7',
                    color: '#d97706',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <RotateCcw size={18} strokeWidth={1.75} />
                </div>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#92400e', display: 'block' }}>
                    คืนค่าเริ่มต้นจากโรงงาน
                  </span>
                  <span style={{ fontSize: 11, color: '#b45309' }}>
                    ล้างข้อมูลทั้งหมดในระบบ ทั้งค่าพืชที่ปลูก ประวัติ และ Wi-Fi
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { if (!commandsLocked) setActiveModal('factoryReset'); }}
                disabled={commandsLocked}
                aria-disabled={commandsLocked}
                title={commandsLocked ? commandLockReason : undefined}
                style={{
                  background: commandsLocked ? '#cbd5e1' : '#d97706',
                  color: '#ffffff',
                  border: 'none',
                  minHeight: 44,
                  minWidth: 44,
                  padding: '0 14px',
                  borderRadius: 10,
                  fontSize: 12,
                  fontWeight: 500,
                  flexShrink: 0,
                  cursor: commandsLocked ? 'not-allowed' : 'pointer',
                }}
              >
                คืนค่าโรงงาน
              </button>
            </div>

            {/* คำสั่งที่ 4: ยกเลิกการจับคู่อุปกรณ์ */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 14px',
                background: '#fef2f2',
                borderRadius: 12,
                border: '1px solid #fee2e2',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: '#fee2e2',
                    color: '#dc2626',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Trash2 size={18} strokeWidth={1.75} />
                </div>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#991b1b', display: 'block' }}>
                    ยกเลิกการจับคู่อุปกรณ์
                  </span>
                  <span style={{ fontSize: 11, color: '#b91c1c' }}>
                    ลบอุปกรณ์ออกจากบัญชี (ข้อมูลรอบการปลูกและสถิติยังคงอยู่ในอุปกรณ์)
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveModal('remove')}
                style={{
                  background: '#dc2626',
                  color: '#ffffff',
                  border: 'none',
                  minHeight: 44,
                  flexShrink: 0,
                  padding: '0 14px',
                  borderRadius: 10,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                ลบอุปกรณ์
              </button>
            </div>
          </div>
        </div>

        {/* การตรวจเช็กสุขภาพเซนเซอร์และฮาร์ดแวร์ */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 12px' }}>
            เซนเซอร์และอุปกรณ์ตรวจวัดที่เชื่อมต่อ
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(() => {
              // Values only while the board is reporting (live/stale); otherwise `--`. No stand-in numbers.
              const rep = isOnline;
              const num = (v: number | null | undefined, d: number, unit: string) =>
                rep && typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(d)} ${unit}` : '--';
              const tankOk = rep ? data.levels?.mainTankOk ?? null : null;
              return [
                {
                  label: 'หัววัดกรด-ด่าง (pH Probe)',
                  value: num(data.current?.pH, 2, 'pH'),
                  online: rep && typeof data.current?.pH === 'number',
                },
                {
                  label: 'หัววัดการนำไฟฟ้า (EC/TDS Probe)',
                  value: num(data.current?.ec, 2, 'mS/cm'),
                  online: rep && typeof data.current?.ec === 'number',
                },
                {
                  label: 'เซนเซอร์อุณหภูมิน้ำ (DS18B20)',
                  value: num(data.current?.tempC, 1, '°C'),
                  online: rep && typeof data.current?.tempC === 'number',
                },
                {
                  label: 'สวิตช์ลูกลอยถังหลัก (Float Switch)',
                  value: mainTankStatusLabel(tankOk),
                  online: tankOk !== null,
                },
                {
                  label: 'ชุดปั๊มสารละลายและน้ำวน (5 ตัว)',
                  value: `โหมด ${rep && data.pumps.controlMode ? data.pumps.controlMode : '--'}`,
                  online: rep && data.pumps.controlMode !== null,
                },
              ];
            })().map((sensor, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  background: '#f8fafc',
                  borderRadius: 12,
                  fontSize: 12,
                }}
              >
                <div>
                  <span style={{ fontWeight: 500, color: '#0f172a', display: 'block' }}>{sensor.label}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ color: sensor.online ? '#059669' : '#94a3b8', fontWeight: 600, display: 'block' }}>
                    {sensor.value}
                  </span>
                  <span style={{ fontSize: 10, color: sensor.online ? '#059669' : '#94a3b8' }}>
                    {sensor.online ? 'ออนไลน์' : 'ออฟไลน์'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ปุ่มเชื่อมต่ออุปกรณ์ใหม่ */}
        <button
          type="button"
          onClick={() => navigate('connect-board')}
          style={{
            width: '100%',
            padding: '13px',
            borderRadius: 14,
            background: '#059669',
            color: '#ffffff',
            border: 'none',
            fontSize: 14,
            fontWeight: 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Plus size={18} strokeWidth={1.75} />
          <span>เชื่อมต่ออุปกรณ์ Hydroponic เพิ่ม</span>
        </button>
      </div>
      )}

      {/* Confirmation Modal */}
      {activeModal !== 'none' && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(15, 23, 42, 0.6)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: 20,
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: 20,
              width: '100%',
              maxWidth: 360,
              padding: 24,
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.2)',
              boxSizing: 'border-box',
            }}
          >
            {activeModal === 'reboot' && (
              <>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 16,
                    background: '#eff6ff',
                    color: '#2563eb',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 16,
                  }}
                >
                  <RefreshCw size={24} strokeWidth={1.75} />
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>
                  รีสตาร์ตอุปกรณ์ Hydroponic?
                </h3>
                <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px', lineHeight: 1.5 }}>
                  ระบบจะส่งคำสั่งรีสตาร์ตไปยังชิปประมวลผลบนตัวอุปกรณ์ อุปกรณ์จะตัดการเชื่อมต่อชั่วคราวและเริ่มทำงานใหม่ภายใน 5 วินาที
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setActiveModal('none')}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '11px',
                      borderRadius: 12,
                      border: '1px solid #e2e8f0',
                      background: '#f8fafc',
                      color: '#475569',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmReboot}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '11px',
                      borderRadius: 12,
                      border: 'none',
                      background: '#2563eb',
                      color: '#ffffff',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    {isProcessing ? 'กำลังส่งคำสั่ง...' : 'ยืนยันรีสตาร์ต'}
                  </button>
                </div>
              </>
            )}

            {activeModal === 'resetWifi' && (
              <>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 16,
                    background: '#ecfdf5',
                    color: '#059669',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 16,
                  }}
                >
                  <Wifi size={24} strokeWidth={1.75} />
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>
                  เปลี่ยนเครือข่าย Wi-Fi?
                </h3>
                <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px', lineHeight: 1.5 }}>
                  อุปกรณ์จะทำการล้างชื่อและรหัสผ่าน Wi-Fi เดิมที่บันทึกไว้ในหน่วยความจำ แล้วเปิดโหมดจับคู่ใหม่เพื่อให้คุณระบุเครือข่าย Wi-Fi ใหม่ได้ทันที
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setActiveModal('none')}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '11px',
                      borderRadius: 12,
                      border: '1px solid #e2e8f0',
                      background: '#f8fafc',
                      color: '#475569',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmResetWifi}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '11px',
                      borderRadius: 12,
                      border: 'none',
                      background: '#059669',
                      color: '#ffffff',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    {isProcessing ? 'กำลังดำเนินการ...' : 'ยืนยันเปลี่ยน Wi-Fi'}
                  </button>
                </div>
              </>
            )}

            {activeModal === 'factoryReset' && (
              <>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 16,
                    background: '#fffbeb',
                    color: '#d97706',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 16,
                  }}
                >
                  <AlertTriangle size={24} strokeWidth={1.75} />
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 600, color: '#92400e', margin: '0 0 8px' }}>
                  คืนค่าเริ่มต้นจากโรงงาน?
                </h3>
                <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px', lineHeight: 1.5 }}>
                  คำเตือนระดับสูงสุด: การคืนค่าโรงงานจะล้างข้อมูลทั้งหมด ทั้งผักที่กำลังปลูก ค่าเป้าหมาย pH/EC ประวัติเซนเซอร์ย้อนหลัง และการเชื่อมต่อ Wi-Fi บนอุปกรณ์ โดยไม่สามารถกู้คืนได้
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setActiveModal('none')}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '11px',
                      borderRadius: 12,
                      border: '1px solid #e2e8f0',
                      background: '#f8fafc',
                      color: '#475569',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmFactoryReset}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '11px',
                      borderRadius: 12,
                      border: 'none',
                      background: '#d97706',
                      color: '#ffffff',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    {isProcessing ? 'กำลังคืนค่า...' : 'ยืนยันคืนค่าโรงงาน'}
                  </button>
                </div>
              </>
            )}

            {activeModal === 'remove' && (
              <>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 16,
                    background: '#fee2e2',
                    color: '#dc2626',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 16,
                  }}
                >
                  <Trash2 size={24} strokeWidth={1.75} />
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 600, color: '#991b1b', margin: '0 0 8px' }}>
                  ยกเลิกการจับคู่อุปกรณ์?
                </h3>
                <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px', lineHeight: 1.5 }}>
                  อุปกรณ์นี้จะถูกนำออกจากบัญชีของคุณ แต่ข้อมูลการปลูกผักรอบปัจจุบันและสถิติในอุปกรณ์จะยังคงอยู่ เมื่อเชื่อมต่อใหม่รอบการปลูกจะทำงานต่อเนื่องตามปกติ
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setActiveModal('none')}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '11px',
                      borderRadius: 12,
                      border: '1px solid #e2e8f0',
                      background: '#f8fafc',
                      color: '#475569',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmRemove}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '11px',
                      borderRadius: 12,
                      border: 'none',
                      background: '#dc2626',
                      color: '#ffffff',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    {isProcessing ? 'กำลังลบ...' : 'ยืนยันลบอุปกรณ์'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
