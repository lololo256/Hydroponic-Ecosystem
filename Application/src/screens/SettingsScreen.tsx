import React, { useState } from 'react';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import { ArrowLeft, Globe, Bell, Cpu, Wifi, Layers, ChevronRight, ShieldCheck, Info, ChevronUp, ChevronDown, RotateCcw, LayoutGrid, Columns, Sparkles, KeyRound } from 'lucide-react';
import { useHomeLayout, HOME_SECTION_LABELS } from '../hooks/useHomeLayout';

const FRESHNESS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  live: { label: 'ออนไลน์', bg: '#ecfdf5', color: '#059669' },
  stale: { label: 'ข้อมูลเริ่มเก่า', bg: '#fffbeb', color: '#d97706' },
  offline: { label: 'ออฟไลน์', bg: '#f1f5f9', color: '#64748b' },
  loading: { label: 'กำลังโหลด', bg: '#f1f5f9', color: '#64748b' },
  no_data: { label: 'ยังไม่มีข้อมูล', bg: '#f1f5f9', color: '#64748b' },
};

export default function SettingsScreen({ navigate, goBack }: NavProps) {
  const {
    connectedBoardId,
    savedBoards,
    telemetryFreshness,
    isDeviceOnline,
    data,
    notificationsEnabled,
    setNotificationsEnabled,
  } = useSmartFarm();
  const { order: sectionOrder, metricView, moveSection, setMetricView, resetLayout } = useHomeLayout();
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifMessage, setNotifMessage] = useState<string | null>(null);
  const farmName = (connectedBoardId && savedBoards[connectedBoardId]?.name) || '--';
  // Wi-Fi state is only meaningful while the device is reporting (live/stale).
  const wifiKnown = Boolean(connectedBoardId) && isDeviceOnline;
  const isWifiOk = wifiKnown && (data.device?.wifiConnected ?? false);
  const badge = connectedBoardId
    ? FRESHNESS_BADGE[telemetryFreshness] ?? FRESHNESS_BADGE.no_data
    : { label: 'ไม่ได้เชื่อมต่อ', bg: '#fffbeb', color: '#d97706' };

  const onToggleNotif = async () => {
    if (notifBusy) return;
    setNotifBusy(true);
    setNotifMessage(null);
    const want = !notificationsEnabled;
    try {
      const ok = await setNotificationsEnabled(want);
      if (want && !ok) {
        setNotifMessage('ไม่ได้รับอนุญาตให้แสดงการแจ้งเตือน กรุณาเปิดสิทธิ์การแจ้งเตือนของแอปในการตั้งค่ามือถือ');
      }
    } catch (_) {
      setNotifMessage('เปลี่ยนการตั้งค่าการแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setNotifBusy(false);
    }
  };

  const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, gap: 12 } as const;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #F0FBF6 0%, #FFFFFF 100%)',
        paddingBottom: 88,
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(12px)',
          padding: '48px 16px 12px',
          borderBottom: '1px solid rgba(226, 232, 240, 0.7)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button
          type="button"
          aria-label="ย้อนกลับ"
          onClick={() => (goBack ? goBack('profile') : navigate('profile'))}
          style={{
            background: 'none',
            border: 'none',
            width: 44,
            height: 44,
            cursor: 'pointer',
            color: '#334155',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 12,
          }}
        >
          <ArrowLeft size={20} strokeWidth={1.75} />
        </button>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', margin: 0 }}>การตั้งค่าระบบ</h1>
      </div>

      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Section 1: ทั่วไป */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <h2 style={{ fontSize: 12, fontWeight: 600, color: '#64748b', margin: '0 0 8px' }}>ทั่วไป</h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={rowStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Globe size={18} strokeWidth={1.5} color="#64748b" />
                <span style={{ fontSize: 13, color: '#0f172a' }}>ภาษาของระบบ</span>
              </div>
              <span style={{ fontSize: 12, color: '#64748b' }}>ไทย (TH)</span>
            </div>

            <div style={{ height: 1, background: '#f1f5f9' }} />

            <label style={{ ...rowStyle, cursor: notifBusy ? 'wait' : 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Bell size={18} strokeWidth={1.5} color="#64748b" />
                <span style={{ fontSize: 13, color: '#0f172a' }}>การแจ้งเตือนเซนเซอร์</span>
              </div>
              <span style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  disabled={notifBusy}
                  onChange={onToggleNotif}
                  style={{ width: 20, height: 20, accentColor: '#059669', cursor: 'inherit', margin: 0 }}
                />
              </span>
            </label>

            {notifMessage && (
              <p role="alert" style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', borderRadius: 10, padding: '8px 10px', margin: 0 }}>
                {notifMessage}
              </p>
            )}

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Info size={14} strokeWidth={1.5} color="#94a3b8" style={{ flexShrink: 0, marginTop: 2 }} />
              <p style={{ fontSize: 11, lineHeight: 1.5, color: '#64748b', margin: 0 }}>
                แจ้งเตือนแม้ปิดแอปอยู่ แจ้งเมื่อค่าผิดปกตินานเกิน 5 นาที (โหมดอัตโนมัติรอให้ระบบแก้เองก่อน 15 นาที) เตือนซ้ำ 1 ครั้งถ้ายังไม่หายใน 30 นาที และแจ้งอีกครั้งเมื่อกลับมาปกติ
              </p>
            </div>
          </div>
        </div>

        {/* Section: หน้าหลัก (order of the 5 home sections + metric panel style; saved on this phone) */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 4px' }}>
            <h2 style={{ fontSize: 12, fontWeight: 600, color: '#64748b', margin: 0 }}>จัดหน้าหลัก</h2>
            <button
              type="button"
              onClick={resetLayout}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                minHeight: 36,
                padding: '0 8px',
                background: 'none',
                border: 'none',
                color: '#059669',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <RotateCcw size={13} strokeWidth={2} />
              <span>ค่าเริ่มต้น</span>
            </button>
          </div>
          <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 8px', lineHeight: 1.5 }}>
            เลื่อนหัวข้อขึ้นลงเพื่อเรียงการแสดงผลในหน้าหลัก
          </p>

          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sectionOrder.map((id, idx) => {
              const first = idx === 0;
              const last = idx === sectionOrder.length - 1;
              const arrowBtn = (disabled: boolean): React.CSSProperties => ({
                width: 40,
                height: 40,
                borderRadius: 10,
                border: '1px solid #e2e8f0',
                background: disabled ? '#f8fafc' : '#ffffff',
                color: disabled ? '#cbd5e1' : '#334155',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: disabled ? 'default' : 'pointer',
              });
              return (
                <li
                  key={id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 6px 6px 10px',
                    background: '#f8fafc',
                    border: '1px solid #eef2f6',
                    borderRadius: 12,
                  }}
                >
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 7,
                      background: '#ecfdf5',
                      color: '#059669',
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#0f172a', fontWeight: 500 }}>
                    {HOME_SECTION_LABELS[id]}
                  </span>
                  <button
                    type="button"
                    aria-label={`เลื่อน ${HOME_SECTION_LABELS[id]} ขึ้น`}
                    disabled={first}
                    onClick={() => moveSection(id, -1)}
                    style={arrowBtn(first)}
                  >
                    <ChevronUp size={18} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    aria-label={`เลื่อน ${HOME_SECTION_LABELS[id]} ลง`}
                    disabled={last}
                    onClick={() => moveSection(id, 1)}
                    style={arrowBtn(last)}
                  >
                    <ChevronDown size={18} strokeWidth={2} />
                  </button>
                </li>
              );
            })}
          </ol>

          <div style={{ height: 1, background: '#f1f5f9', margin: '14px 0 10px' }} />

          <div style={{ ...rowStyle, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <LayoutGrid size={18} strokeWidth={1.5} color="#64748b" />
              <span style={{ fontSize: 13, color: '#0f172a' }}>แผงค่าคุณภาพน้ำ</span>
            </div>
            <div
              role="radiogroup"
              aria-label="รูปแบบแผงค่าคุณภาพน้ำ"
              style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 10, padding: 3, gap: 3 }}
            >
              {([
                { v: 'grid', label: 'Bento', icon: <LayoutGrid size={13} strokeWidth={2} /> },
                { v: 'rings', label: 'วงแหวน', icon: <Columns size={13} strokeWidth={2} /> },
              ] as const).map((o) => {
                const on = metricView === o.v;
                return (
                  <button
                    key={o.v}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setMetricView(o.v)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      minHeight: 36,
                      padding: '0 12px',
                      border: 'none',
                      borderRadius: 8,
                      background: on ? '#ffffff' : 'transparent',
                      color: on ? '#0f172a' : '#64748b',
                      fontSize: 12,
                      fontWeight: on ? 600 : 500,
                      boxShadow: on ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {o.icon}
                    <span>{o.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Section 2: ฟาร์มและอุปกรณ์ */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <h2 style={{ fontSize: 12, fontWeight: 600, color: '#64748b', margin: '0 0 8px' }}>ฟาร์มและอุปกรณ์</h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={rowStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Layers size={18} strokeWidth={1.5} color="#64748b" />
                <span style={{ fontSize: 13, color: '#0f172a' }}>ชื่อฟาร์ม</span>
              </div>
              <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500, textAlign: 'right' }}>{farmName}</span>
            </div>

            <div style={{ height: 1, background: '#f1f5f9' }} />

            <button
              type="button"
              onClick={() => navigate('device')}
              style={{
                ...rowStyle,
                width: '100%',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Cpu size={18} strokeWidth={1.5} color="#059669" />
                <div>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#0f172a', display: 'block' }}>การตั้งค่าอุปกรณ์ Hydroponic</span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>รีสตาร์ต รีเซ็ต Wi-Fi คืนค่าโรงงาน</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: badge.bg,
                    color: badge.color,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {badge.label}
                </span>
                <ChevronRight size={14} strokeWidth={1.5} color="#94a3b8" />
              </div>
            </button>

            <div style={{ height: 1, background: '#f1f5f9' }} />

            <div style={rowStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Wifi size={18} strokeWidth={1.5} color="#64748b" />
                <span style={{ fontSize: 13, color: '#0f172a' }}>สัญญาณ Wi-Fi ของอุปกรณ์</span>
              </div>
              <span style={{ fontSize: 12, color: isWifiOk ? '#059669' : '#94a3b8', fontWeight: 500 }}>
                {!wifiKnown ? '--' : isWifiOk ? 'เชื่อมต่อแล้ว' : 'ไม่ได้เชื่อมต่อ'}
              </span>
            </div>
          </div>
        </div>

        {/* Section 3: ความปลอดภัยของปั๊ม (read-only, enforced by firmware) */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <h2 style={{ fontSize: 12, fontWeight: 600, color: '#64748b', margin: '0 0 8px' }}>ความปลอดภัยของปั๊ม</h2>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minHeight: 44 }}>
            <ShieldCheck size={18} strokeWidth={1.5} color="#059669" style={{ flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 13, lineHeight: 1.55, color: '#334155', margin: 0 }}>
              อุปกรณ์ตัดปั๊มหลักอัตโนมัติเมื่อลูกลอยแจ้งน้ำต่ำ (ควบคุมโดยเฟิร์มแวร์)
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
