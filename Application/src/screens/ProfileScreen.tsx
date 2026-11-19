import { NavProps, Screen } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { version as APP_VERSION } from '../../package.json';
import {
  Cpu,
  Activity,
  Bell,
  Leaf,
  Sprout,
  ChevronRight,
  Plus,
  Link2,
  Settings,
  Info,
  Download,
  LogOut,
  Loader2,
  X,
} from 'lucide-react';

const FONT = "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif";
const SHADOW = '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)';

interface MenuItem {
  icon: React.ElementType;
  label: string;
  screen?: Screen;
  action?: 'about';
}

const menuItems: MenuItem[] = [
  { icon: Sprout, label: 'ตั้งค่าระบบฟาร์ม & ชนิดพืช', screen: 'setup-farm' },
  { icon: Cpu, label: 'จัดการอุปกรณ์ Hydroponic', screen: 'device' },
  { icon: Settings, label: 'ตั้งค่าแอป', screen: 'settings' },
  { icon: Link2, label: 'เชื่อมต่ออุปกรณ์ใหม่', screen: 'connect-board' },
  { icon: Info, label: 'เกี่ยวกับแอป', action: 'about' },
];

export default function ProfileScreen({ navigate }: NavProps) {
  const {
    data,
    logout,
    currentUser,
    connectedBoardId,
    savedBoards,
    connectBoard,
    removeBoard,
    isDeviceOnline,
    telemetryFreshness,
    showAlert,
  } = useSmartFarm();

  // Sensors that are actually reporting on the selected device (no fixed number):
  // pH, EC, water temperature and the main-tank float switch, counted only when the board has sent them.
  const sensorCountLabel = (() => {
    if (!connectedBoardId || telemetryFreshness === 'no_data' || telemetryFreshness === 'loading') return '--';
    const readings = [data.current.pH, data.current.ec, data.current.tempC, data.levels.mainTankOk];
    return String(readings.filter((v) => v !== null && v !== undefined).length);
  })();

  const [showManageMenu, setShowManageMenu] = useState<string | null>(null);
  const [manageMode, setManageMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<{ boardId: string; message: string } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  const handleRemoveBoard = async (boardId: string) => {
    if (removingId) return;
    setRemovingId(boardId);
    setRemoveError(null);
    try {
      await removeBoard(boardId);
      setConfirmDelete(null);
      setShowManageMenu(null);
    } catch (err: any) {
      setRemoveError({ boardId, message: err?.message || 'ลบอุปกรณ์ไม่สำเร็จ กรุณาลองใหม่' });
    } finally {
      setRemovingId(null);
    }
  };

  /* ── CSV Export: native = Filesystem (Cache) + share sheet (same as HistoryScreen); web = download ── */
  const handleExportCSV = async () => {
    if (isExporting) return;
    if (!data.history || Object.keys(data.history).length === 0) {
      showAlert({
        title: 'ไม่มีข้อมูลประวัติ',
        message: 'ยังไม่มีข้อมูลประวัติสำหรับส่งออกรายงานสถิติ',
        variant: 'info',
      });
      return;
    }
    const entries = Object.values(data.history).sort((a, b) => a.timestamp - b.timestamp);
    const plantName = data.plantType || 'ไม่ระบุชื่อพืช';
    let csvContent = "\uFEFFPlant,Date (DD/MM),Year,Time,pH,EC (mS/cm),TDS (ppm),Temperature (C)\n";
    entries.forEach(entry => {
      const d = new Date(entry.timestamp);
      const parts = d.toLocaleDateString('th-TH').split('/');
      csvContent += `"${plantName}","${parts[0]}/${parts[1]}","${parts[2] || ''}","${d.toLocaleTimeString('th-TH')}",${entry.pH ?? ''},${entry.ec ?? ''},${entry.tds ?? ''},${entry.tempC ?? ''}\n`;
    });
    const fileName = `hydroponic_${plantName.replace(/[^a-zA-Z0-9ก-๙]/g, '_')}_${new Date().getTime()}.csv`;

    setIsExporting(true);
    try {
      if (Capacitor.isNativePlatform()) {
        // <a download> does nothing inside the Capacitor WebView
        const fileResult = await Filesystem.writeFile({
          path: fileName,
          data: csvContent,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({
          title: 'ส่งออกข้อมูล Smart Water Farm',
          url: fileResult.uri,
          dialogTitle: 'แชร์รายงาน CSV',
        });
      } else {
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', fileName);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (!/cancel/i.test(msg)) {
        showAlert({
          title: 'ส่งออกล้มเหลว',
          message: msg || 'ไม่สามารถส่งออกไฟล์บนอุปกรณ์ได้',
          variant: 'danger',
        });
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('welcome');
  };

  const displayName = currentUser?.displayName || data.profile.name || currentUser?.email || '';
  const displayEmail = currentUser?.email || data.profile.email || '';
  const initials = (displayName.charAt(0) || '?').toUpperCase();
  const photoURL = currentUser?.photoURL || data.profile.photoURL;

  const deviceCount = Object.keys(savedBoards || {}).length;
  // Unread only (same read flag the notifications screen uses)
  const alertsCount = Object.values(data.alerts || {}).filter((a) => a && !a.read).length;

  return (
    <div
      className="screen-enter"
      style={{
        fontFamily: FONT,
        background: '#f8fafc',
        minHeight: '100vh',
        paddingBottom: 32,
      }}
    >
      {/* ── Header Card ── */}
      <div
        style={{
          background: '#ffffff',
          borderRadius: '0 0 24px 24px',
          padding: '56px 24px 24px',
          boxShadow: SHADOW,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Avatar */}
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #d1fae5, #a7f3d0)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {photoURL ? (
              <img
                src={photoURL}
                alt="Profile"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <span
                style={{
                  fontFamily: FONT,
                  fontSize: 22,
                  fontWeight: 600,
                  color: '#059669',
                  lineHeight: 1,
                }}
              >
                {initials}
              </span>
            )}
          </div>

          {/* Name / Email */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                fontFamily: FONT,
                fontSize: 18,
                fontWeight: 600,
                color: '#0f172a',
                margin: '0 0 2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {displayName}
            </h1>
            <p
              style={{
                fontFamily: FONT,
                fontSize: 13,
                color: '#64748b',
                margin: '0 0 8px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {data.profile.email || displayEmail}
            </p>
          </div>
        </div>
      </div>

      {/* ── Stats Row ── */}
      <div style={{ padding: '16px 24px 0' }}>
        <div
          style={{
            display: 'flex',
            gap: 10,
          }}
        >
          {[
            { icon: Cpu, label: 'อุปกรณ์', value: String(deviceCount) },
            { icon: Activity, label: 'เซนเซอร์', value: sensorCountLabel },
            { icon: Bell, label: 'แจ้งเตือนใหม่', value: String(alertsCount) },
          ].map(({ icon: IconComp, label, value }) => (
            <div
              key={label}
              style={{
                flex: 1,
                background: '#ffffff',
                borderRadius: 16,
                border: '1px solid #e2e8f0',
                padding: '16px 8px',
                textAlign: 'center',
                boxShadow: SHADOW,
              }}
            >
              <IconComp size={18} strokeWidth={1.5} color="#64748b" style={{ margin: '0 auto 6px' }} />
              <p
                style={{
                  fontFamily: FONT,
                  fontSize: 22,
                  fontWeight: 600,
                  color: '#0f172a',
                  margin: '0 0 2px',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {value}
              </p>
              <p
                style={{
                  fontFamily: FONT,
                  fontSize: 11,
                  color: '#64748b',
                  margin: 0,
                }}
              >
                {label}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Farm Section ── */}
      <div style={{ padding: '24px 24px 0' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <h2
            style={{
              fontFamily: FONT,
              fontSize: 14,
              fontWeight: 600,
              color: '#0f172a',
              margin: 0,
            }}
          >
            ฟาร์มของฉัน
          </h2>
          {Object.keys(savedBoards || {}).length > 0 && (
            <button
              onClick={() => {
                setManageMode(!manageMode);
                setShowManageMenu(null);
                setConfirmDelete(null);
              }}
              style={{
                fontFamily: FONT,
                fontSize: 11,
                fontWeight: 500,
                padding: '4px 10px',
                borderRadius: 8,
                border: '1px solid #e2e8f0',
                background: manageMode ? '#f1f5f9' : '#ffffff',
                color: manageMode ? '#059669' : '#64748b',
                cursor: 'pointer',
              }}
            >
              {manageMode ? 'เสร็จสิ้น' : 'จัดการ'}
            </button>
          )}
        </div>

        {/* Board list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Object.entries(savedBoards || {}).map(([boardId, board]) => {
            const isActive = connectedBoardId === boardId;
            const isBoardOnline = Boolean(isActive && (
              (data.device?.esp32Connected && data.device?.wifiConnected) ||
              isDeviceOnline ||
              telemetryFreshness === 'live'
            ));
            return (
              <div
                key={boardId}
                onClick={() => {
                  if (isActive && !manageMode) navigate('device');
                }}
                style={{
                  background: '#ffffff',
                  borderRadius: 12,
                  border: '1px solid #e2e8f0',
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  boxShadow: SHADOW,
                  position: 'relative',
                  cursor: isActive ? 'pointer' : 'default',
                }}
              >
                {/* Left icon */}
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: '#f0fdf4',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Leaf size={18} strokeWidth={1.5} color="#059669" />
                </div>

                {/* Text */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    style={{
                      fontFamily: FONT,
                      fontSize: 14,
                      fontWeight: 500,
                      color: '#0f172a',
                      margin: '0 0 2px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {board.name}
                  </p>
                  <p
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 11,
                      color: '#94a3b8',
                      margin: 0,
                    }}
                  >
                    {boardId.substring(0, 16)}...
                  </p>
                </div>

                {/* Right side */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {isActive && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: isBoardOnline ? '#059669' : '#94a3b8',
                          }}
                        />
                        <span
                          style={{
                            fontFamily: FONT,
                            fontSize: 10,
                            fontWeight: 600,
                            color: isBoardOnline ? '#059669' : '#475569',
                          }}
                        >
                          กำลังใช้งาน
                        </span>
                      </div>
                      <span
                        style={{
                          fontFamily: FONT,
                          fontSize: 9,
                          fontWeight: 600,
                          color: isBoardOnline ? '#059669' : '#dc2626',
                          background: isBoardOnline ? '#f0fdf4' : '#fef2f2',
                          border: `1px solid ${isBoardOnline ? '#bbf7d0' : '#fecaca'}`,
                          padding: '1px 7px',
                          borderRadius: 100,
                        }}
                      >
                        {isBoardOnline ? 'ออนไลน์' : 'ออฟไลน์'}
                      </span>
                    </div>
                  )}
                  {!isActive && !manageMode && (
                    <button
                      onClick={() => connectBoard(boardId)}
                      style={{
                        fontFamily: FONT,
                        fontSize: 11,
                        fontWeight: 500,
                        padding: '4px 10px',
                        borderRadius: 8,
                        border: '1px solid #e2e8f0',
                        background: '#f8fafc',
                        color: '#64748b',
                        cursor: 'pointer',
                      }}
                    >
                      สลับ
                    </button>
                  )}
                  {manageMode && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {confirmDelete === boardId ? (
                          <>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDelete(null);
                                setRemoveError(null);
                              }}
                              disabled={removingId === boardId}
                              style={{
                                fontFamily: FONT,
                                fontSize: 12,
                                fontWeight: 500,
                                minHeight: 44,
                                padding: '0 12px',
                                borderRadius: 10,
                                border: '1px solid #e2e8f0',
                                background: '#ffffff',
                                color: '#64748b',
                                cursor: removingId === boardId ? 'not-allowed' : 'pointer',
                              }}
                            >
                              ยกเลิก
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleRemoveBoard(boardId);
                              }}
                              disabled={removingId === boardId}
                              aria-busy={removingId === boardId}
                              style={{
                                fontFamily: FONT,
                                fontSize: 12,
                                fontWeight: 600,
                                minHeight: 44,
                                padding: '0 14px',
                                borderRadius: 10,
                                border: '1px solid #fecaca',
                                background: '#fef2f2',
                                color: '#dc2626',
                                cursor: removingId === boardId ? 'wait' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                              }}
                            >
                              {removingId === boardId && <Loader2 size={14} className="animate-spin" />}
                              <span>{removingId === boardId ? 'กำลังลบ...' : 'ยืนยันลบ'}</span>
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDelete(boardId);
                              setRemoveError(null);
                            }}
                            disabled={Boolean(removingId)}
                            style={{
                              fontFamily: FONT,
                              fontSize: 12,
                              fontWeight: 500,
                              minHeight: 44,
                              padding: '0 14px',
                              borderRadius: 10,
                              border: '1px solid #e2e8f0',
                              background: '#f8fafc',
                              color: '#dc2626',
                              cursor: 'pointer',
                            }}
                          >
                            ลบ
                          </button>
                        )}
                      </div>
                      {removeError?.boardId === boardId && (
                        <span role="alert" style={{ fontFamily: FONT, fontSize: 11, color: '#dc2626', maxWidth: 180, textAlign: 'right' }}>
                          {removeError.message}
                        </span>
                      )}
                    </div>
                  )}
                  <ChevronRight size={16} strokeWidth={1.5} color="#94a3b8" />
                </div>
              </div>
            );
          })}

          {/* Add new farm button */}
          <button
            onClick={() => navigate('connect-board')}
            style={{
              fontFamily: FONT,
              fontSize: 13,
              fontWeight: 500,
              color: '#64748b',
              width: '100%',
              padding: '14px 16px',
              borderRadius: 12,
              border: '1.5px dashed #e2e8f0',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <Plus size={16} strokeWidth={1.5} color="#64748b" />
            เพิ่มฟาร์มใหม่
          </button>
        </div>
      </div>

      {/* ── Settings Section ── */}
      <div style={{ padding: '24px 24px 0' }}>
        <h2
          style={{
            fontFamily: FONT,
            fontSize: 14,
            fontWeight: 600,
            color: '#0f172a',
            margin: '0 0 12px',
          }}
        >
          ตั้งค่า
        </h2>
        <div
          style={{
            background: '#ffffff',
            borderRadius: 16,
            border: '1px solid #e2e8f0',
            overflow: 'hidden',
            boxShadow: SHADOW,
          }}
        >
          {menuItems
            .filter((item) => !(item.screen === 'setup-farm' && !connectedBoardId))
            .map((item, idx, arr) => {
              const IconComp = item.icon;
              const isLast = idx === arr.length - 1;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    if (item.action === 'about') setShowAbout(true);
                    else if (item.screen) navigate(item.screen);
                  }}
                  style={{
                    fontFamily: FONT,
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 16px',
                    background: 'none',
                    border: 'none',
                    borderBottom: isLast ? 'none' : '1px solid #f1f5f9',
                    minHeight: 48,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <IconComp size={18} strokeWidth={1.5} color="#64748b" />
                  <span
                    style={{
                      flex: 1,
                      fontFamily: FONT,
                      fontSize: 14,
                      color: '#0f172a',
                    }}
                  >
                    {item.label}
                  </span>
                  <ChevronRight size={16} strokeWidth={1.5} color="#94a3b8" />
                </button>
              );
            })}
        </div>
      </div>

      {/* ── Export CSV ── */}
      <div style={{ padding: '16px 24px 0' }}>
        <button
          type="button"
          onClick={() => {
            void handleExportCSV();
          }}
          disabled={isExporting}
          aria-busy={isExporting}
          style={{
            fontFamily: FONT,
            width: '100%',
            padding: '14px 16px',
            minHeight: 48,
            borderRadius: 12,
            border: '1px solid #e2e8f0',
            background: '#ffffff',
            color: '#374151',
            fontSize: 14,
            fontWeight: 500,
            cursor: isExporting ? 'wait' : 'pointer',
            opacity: isExporting ? 0.7 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            boxShadow: SHADOW,
          }}
        >
          {isExporting ? (
            <Loader2 size={18} strokeWidth={1.5} color="#374151" className="animate-spin" />
          ) : (
            <Download size={18} strokeWidth={1.5} color="#374151" />
          )}
          {isExporting ? 'กำลังส่งออก...' : 'ส่งออกข้อมูล CSV'}
        </button>
      </div>

      {/* ── Logout ── */}
      <div style={{ padding: '12px 24px 0' }}>
        <button
          onClick={handleLogout}
          style={{
            fontFamily: FONT,
            width: '100%',
            padding: '14px 16px',
            borderRadius: 12,
            border: '1px solid #fecaca',
            background: '#fef2f2',
            color: '#dc2626',
            fontSize: 14,
            fontWeight: 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <LogOut size={18} strokeWidth={1.5} color="#dc2626" />
          ออกจากระบบ
        </button>
      </div>

      {/* ── About bottom sheet ── */}
      {showAbout && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="เกี่ยวกับแอป"
          onClick={() => setShowAbout(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9000,
            background: 'rgba(15, 23, 42, 0.5)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            fontFamily: FONT,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 480,
              background: '#ffffff',
              borderRadius: '20px 20px 0 0',
              padding: '20px 20px max(20px, env(safe-area-inset-bottom))',
              boxShadow: '0 -8px 30px rgba(15, 23, 42, 0.15)',
              animation: 'slideUp 0.22s ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    background: '#ecfdf5',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Leaf size={20} strokeWidth={1.75} color="#059669" />
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Smart Water Farm</p>
                  {APP_VERSION && (
                    <p style={{ margin: 0, fontSize: 12, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                      เวอร์ชัน {APP_VERSION}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAbout(false)}
                aria-label="ปิด"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  border: 'none',
                  background: '#f1f5f9',
                  color: '#64748b',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: '#475569', lineHeight: 1.55 }}>
              <p style={{ margin: 0 }}>
                <b style={{ color: '#0f172a', fontWeight: 600 }}>Smart Water Farm — โครงงาน</b>
                <br />
                ระบบติดตามและควบคุมฟาร์มไฮโดรโปนิกส์: อุปกรณ์ ESP32 วัดค่า pH, EC และอุณหภูมิน้ำ ส่งข้อมูลผ่าน ThingsBoard มายังแอปนี้
              </p>
              <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                ค่าที่แสดงในแอปมาจากอุปกรณ์จริงเท่านั้น หากยังไม่มีข้อมูลจะแสดงเป็น --
              </p>
              <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                ติดต่อ / แจ้งปัญหา: ทีมผู้พัฒนาโครงงาน Smart Water Farm
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowAbout(false)}
              style={{
                marginTop: 18,
                width: '100%',
                minHeight: 48,
                borderRadius: 12,
                border: 'none',
                background: '#0f172a',
                color: '#ffffff',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: FONT,
              }}
            >
              ปิด
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
