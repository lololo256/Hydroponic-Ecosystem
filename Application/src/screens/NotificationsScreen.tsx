import { useState } from 'react';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import { AlertTriangle, AlertCircle, Info, Bell, Wifi, CheckCircle2 } from 'lucide-react';

type FilterTab = 'all' | 'critical' | 'warning';

interface AlertItem {
  id: string;
  level: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  time: string;
  read: boolean;
  resolved: boolean;
}

const RESOLVED_PREFIX = 'คลี่คลายแล้ว';
const RESOLVED_CONFIG = {
  strip: '#94a3b8',
  iconBg: '#f1f5f9',
  iconColor: '#64748b',
  Icon: CheckCircle2,
};

const FONT = "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif";
const SHADOW = '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)';

function levelConfig(level: 'info' | 'warning' | 'critical') {
  if (level === 'critical') {
    return {
      strip: '#dc2626',
      iconBg: '#fef2f2',
      iconColor: '#dc2626',
      Icon: AlertTriangle,
    };
  }
  if (level === 'warning') {
    return {
      strip: '#d97706',
      iconBg: '#fffbeb',
      iconColor: '#d97706',
      Icon: AlertCircle,
    };
  }
  return {
    strip: '#0369a1',
    iconBg: '#eff6ff',
    iconColor: '#0369a1',
    Icon: Info,
  };
}

export default function NotificationsScreen({ navigate }: NavProps) {
  const { data, connectedBoardId, savedBoards, markAlertRead, clearAlerts, showConfirm } = useSmartFarm();
  const farmName = (connectedBoardId && savedBoards[connectedBoardId]?.name) || data.profile.name || '';
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rawAlerts = data.alerts || {};

  const alertList: AlertItem[] = Object.entries(rawAlerts)
    .map(([key, alert]) => {
      const timeStr = alert.timestamp
        ? new Date(alert.timestamp).toLocaleString('th-TH', {
            dateStyle: 'short',
            timeStyle: 'short',
          })
        : '';
      return {
        id: key,
        level: alert.level,
        title: alert.title || 'การแจ้งเตือน',
        resolved: (alert.title || '').trim().startsWith(RESOLVED_PREFIX),
        message: alert.message || '',
        time: timeStr,
        read: alert.read ?? false,
      };
    })
    .sort((a, b) => {
      const ta = rawAlerts[a.id]?.timestamp ?? 0;
      const tb = rawAlerts[b.id]?.timestamp ?? 0;
      return tb - ta;
    });

  const filtered = alertList.filter((a) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'critical') return a.level === 'critical';
    if (activeTab === 'warning') return a.level === 'warning';
    return true;
  });

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'critical', label: 'วิกฤต' },
    { key: 'warning', label: 'เตือน' },
  ];

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
      {/* ── Header ── */}
      <div style={{ padding: '56px 24px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h1
              style={{
                fontFamily: FONT,
                fontSize: 20,
                fontWeight: 600,
                color: '#0f172a',
                margin: 0,
              }}
            >
              การแจ้งเตือน
            </h1>
            <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0', fontFamily: FONT }}>
              {connectedBoardId
                ? `${alertList.length} รายการ`
                : 'ยังไม่ได้เชื่อมต่อ'}
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            {farmName && (
              <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500, fontFamily: FONT }}>
                {farmName}
              </span>
            )}
            {alertList.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  showConfirm({
                    title: 'ล้างประวัติการแจ้งเตือน',
                    message: 'คุณต้องการล้างประวัติการแจ้งเตือนทั้งหมดใช่หรือไม่?\nรายการจะถูกซ่อนจากแอปนี้ (ไม่ลบประวัติบน ThingsBoard)',
                    confirmText: 'ล้างทั้งหมด',
                    cancelText: 'ยกเลิก',
                    variant: 'danger',
                    onConfirm: () => clearAlerts(),
                  });
                }}
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#dc2626',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0 10px',
                  minHeight: 44,
                  marginRight: -10,
                  fontFamily: FONT,
                }}
              >
                ล้างทั้งหมด
              </button>
            )}
          </div>
        </div>

        {/* Delivery limit hint */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10 }}>
          <Info size={14} strokeWidth={1.5} color="#94a3b8" style={{ flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 11, lineHeight: 1.5, color: '#64748b', margin: 0, fontFamily: FONT }}>
            การแจ้งเตือนบนมือถือทำงานขณะเปิดแอปหรือแอปอยู่เบื้องหลัง หากปัดปิดแอป รายการแจ้งเตือนจะแสดงเมื่อเปิดแอปครั้งถัดไป
          </p>
        </div>
      </div>

      {/* ── Filter Tabs ── */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '0 24px 16px',
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActiveTab(tab.key)}
              style={{
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: 500,
                padding: '0 18px',
                minHeight: 44,
                borderRadius: 100,
                border: isActive ? 'none' : '1px solid #e2e8f0',
                background: isActive ? '#0f172a' : '#ffffff',
                color: isActive ? '#ffffff' : '#64748b',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                boxShadow: isActive ? SHADOW : 'none',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── Content ── */}
      <div style={{ padding: '0 24px' }}>
        {/* Not connected */}
        {!connectedBoardId ? (
          <div
            style={{
              background: '#ffffff',
              borderRadius: 16,
              border: '1px solid #e2e8f0',
              padding: '48px 24px',
              textAlign: 'center',
              boxShadow: SHADOW,
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                background: '#f1f5f9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
              }}
            >
              <Wifi size={32} strokeWidth={1.5} color="#94a3b8" />
            </div>
            <p
              style={{
                fontFamily: FONT,
                fontSize: 16,
                fontWeight: 500,
                color: '#0f172a',
                margin: '0 0 6px',
              }}
            >
              ยังไม่ได้เชื่อมต่อ
            </p>
            <p
              style={{
                fontFamily: FONT,
                fontSize: 13,
                color: '#64748b',
                margin: '0 0 20px',
              }}
            >
              เชื่อมต่ออุปกรณ์เพื่อรับการแจ้งเตือนจากเซนเซอร์
            </p>
            <button
              type="button"
              onClick={() => navigate('add-board')}
              style={{
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: 500,
                padding: '0 24px',
                minHeight: 44,
                borderRadius: 12,
                border: '1px solid #059669',
                background: 'transparent',
                color: '#059669',
                cursor: 'pointer',
              }}
            >
              เชื่อมต่ออุปกรณ์
            </button>
          </div>
        ) : filtered.length === 0 ? (
          /* Empty state */
          <div
            style={{
              background: '#ffffff',
              borderRadius: 16,
              border: '1px solid #e2e8f0',
              padding: '48px 24px',
              textAlign: 'center',
              boxShadow: SHADOW,
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                background: '#f1f5f9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
              }}
            >
              <Bell size={32} strokeWidth={1.5} color="#94a3b8" />
            </div>
            <p
              style={{
                fontFamily: FONT,
                fontSize: 16,
                fontWeight: 500,
                color: '#0f172a',
                margin: '0 0 6px',
              }}
            >
              ยังไม่มีการแจ้งเตือน
            </p>
            <p style={{ fontFamily: FONT, fontSize: 13, color: '#64748b', margin: 0, lineHeight: 1.5 }}>
              แสดงรายการแจ้งเตือน (Alarm) ของอุปกรณ์นี้จาก ThingsBoard ขณะนี้ไม่พบรายการ
            </p>
          </div>
        ) : (
          /* Alert list */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtered.map((alert) => {
              const cfg = alert.resolved ? RESOLVED_CONFIG : levelConfig(alert.level);
              const IconComp = cfg.Icon;
              return (
                <div
                  key={alert.id}
                  onClick={() => {
                    markAlertRead(alert.id);
                    setExpandedId((cur) => (cur === alert.id ? null : alert.id));
                  }}
                  style={{
                    background: '#ffffff',
                    borderRadius: 16,
                    border: '1px solid #e2e8f0',
                    boxShadow: SHADOW,
                    display: 'flex',
                    overflow: 'hidden',
                    position: 'relative',
                    cursor: 'pointer',
                    opacity: alert.read || alert.resolved ? 0.75 : 1,
                  }}
                >
                  {/* Left status strip */}
                  <div
                    style={{
                      width: 4,
                      background: cfg.strip,
                      borderRadius: '4px 0 0 4px',
                      flexShrink: 0,
                    }}
                  />

                  {/* Card body */}
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0, // ให้ข้อความตัดบรรทัดในการ์ด ไม่ดันการ์ดล้นจอ
                      padding: '14px 14px 14px 12px',
                      display: 'flex',
                      gap: 12,
                      alignItems: 'flex-start',
                    }}
                  >
                    {/* Icon circle */}
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        background: cfg.iconBg,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <IconComp size={18} strokeWidth={1.5} color={cfg.iconColor} />
                    </div>

                    {/* Text */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Title row */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 6,
                          marginBottom: 3,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: FONT,
                            fontSize: 14,
                            fontWeight: 600,
                            color: alert.resolved ? '#475569' : '#0f172a',
                            flex: 1,
                            minWidth: 0,
                            lineHeight: 1.4,
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {alert.title}
                        </span>
                        {/* Unread dot */}
                        {!alert.read && (
                          <div
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: '#059669',
                              flexShrink: 0,
                              marginTop: 7,
                            }}
                          />
                        )}
                      </div>

                      <p
                        style={{
                          fontFamily: FONT,
                          fontSize: 13,
                          color: '#64748b',
                          margin: '0 0 6px',
                          lineHeight: 1.55,
                          overflowWrap: 'anywhere',
                          whiteSpace: 'pre-line',
                          ...(expandedId === alert.id
                            ? {}
                            : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }),
                        }}
                      >
                        {alert.message}
                      </p>

                      <p
                        style={{
                          fontFamily: FONT,
                          fontSize: 11,
                          color: '#94a3b8',
                          margin: 0,
                          textAlign: 'right',
                        }}
                      >
                        {alert.time}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
