import { ReactNode } from 'react';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import { getEffectiveTargets, mainTankStatusLabel } from '../services/telemetryContract';
import {
  ArrowLeft,
  Database,
  Activity,
  Sprout,
  FlaskConical,
  Zap,
  Thermometer,
  Gauge,
  Layers,
  CornerDownLeft,
  AlertTriangle,
} from 'lucide-react';

// 'none' = part has no sensor: shown neutral, never as online/offline.
type S = 'online' | 'warning' | 'error' | 'offline' | 'standby' | 'none';

const dot: Record<S, string> = { online: '#4ade80', warning: '#fbbf24', error: '#fb7185', offline: '#cbd5e1', standby: '#94a3b8', none: 'transparent' };
const lbl: Record<S, string> = { online: 'ปกติ', warning: 'เตือน', error: 'ผิดปกติ', offline: 'ออฟไลน์', standby: 'สแตนด์บาย', none: 'ไม่มีเซนเซอร์' };
const bg: Record<S, string> = { online: '#f0fdf6', warning: '#fffbeb', error: '#fff1f2', offline: '#f8fafc', standby: '#f8fafc', none: '#f8fafc' };

function StatusDot({ status, offlineLabel }: { status: S; offlineLabel: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 700,
        color: status === 'offline' || status === 'standby' || status === 'none' ? '#64748b' : '#334155',
        background: bg[status],
        border: `1px solid ${status === 'online' ? '#bbf7d0' : status === 'offline' || status === 'standby' || status === 'none' ? '#e2e8f0' : '#fde68a'}`,
        whiteSpace: 'nowrap',
        borderRadius: 20,
        padding: '3px 9px',
      }}
    >
      {status !== 'none' && (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot[status], display: 'inline-block' }} />
      )}
      {status === 'offline' ? offlineLabel : lbl[status]}
    </span>
  );
}

interface DeviceItem {
  icon: ReactNode;
  label: string;
  sub: string;
  s: S;
}

interface FlowItem {
  icon: ReactNode;
  label: string;
  color: string;
  border: string;
  s: S;
}

export default function FarmStatusScreen({ navigate, goBack }: NavProps) {
  const { data, connectedBoardId, telemetryFreshness, enableDosingTracking, solutionLevels } = useSmartFarm();
  // Reporting = live or stale (Contract v3 §6). Values are never shown when offline / no data.
  const isReporting = Boolean(connectedBoardId) && (telemetryFreshness === 'live' || telemetryFreshness === 'stale');
  const isOnline = isReporting;
  const isStale = telemetryFreshness === 'stale';
  const targets = getEffectiveTargets(data);

  const val = (v: number | null | undefined): number | null =>
    isReporting && typeof v === 'number' && Number.isFinite(v) ? v : null;
  const ph = val(data.current?.pH);
  const ec = val(data.current?.ec);
  const temp = val(data.current?.tempC);
  const tankOk = isReporting ? data.levels?.mainTankOk ?? null : null;

  const metricStatus = (v: number | null, min: number, max: number): S =>
    v === null ? 'offline' : v >= min && v <= max ? 'online' : 'warning';
  const phStatus: S = metricStatus(ph, targets.phMin, targets.phMax);
  const ecStatus: S = metricStatus(ec, targets.ecMin, targets.ecMax);
  const tempStatus: S = metricStatus(temp, targets.tempMin, targets.tempMax);
  const mainTankStatus: S = tankOk === null ? 'offline' : tankOk ? 'online' : 'error';
  const pumpStatus: S = !isReporting || data.pumps.mainPumpOn === null ? 'offline' : data.pumps.mainPumpOn ? 'online' : 'standby';
  // No sensor on the growing area / return line: never infer health from "device is reporting".
  const growingAreaStatus: S = 'none';
  const offlineLabel =
    telemetryFreshness === 'offline'
      ? 'ออฟไลน์'
      : telemetryFreshness === 'loading'
      ? 'กำลังโหลด'
      : 'ยังไม่มีข้อมูล';
  const staleNote = isStale ? ' (ข้อมูลเริ่มเก่า)' : '';
  const fmtVal = (v: number | null, d: number, unit: string) => (v === null ? '--' : `${v.toFixed(d)}${unit}${staleNote}`);

  // Calculated from refills + measured pump flow + the board's pump run-time (no level sensor).
  const estimate = (k: 'fertA' | 'fertB'): string => {
    const lvl = solutionLevels[k];
    return lvl.status === 'ok' && lvl.pct !== null ? `ประมาณการ ${lvl.pct}%` : '--';
  };

  const devices: DeviceItem[] = [
    {
      icon: <Database size={18} color="#0284c7" />,
      label: 'ถังน้ำหลัก (Main Water Tank)',
      sub: mainTankStatusLabel(tankOk),
      s: mainTankStatus,
    },
    {
      icon: <Activity size={18} color={data.pumps.mainPumpOn && isOnline ? '#059669' : '#64748b'} />,
      label: 'ปั๊มน้ำหลัก (Water Pump)',
      sub: !isReporting || data.pumps.mainPumpOn === null ? '--' : data.pumps.mainPumpOn ? 'กำลังทำงาน (Running)' : 'สแตนด์บาย (Standby)',
      s: pumpStatus,
    },
    {
      icon: <Sprout size={18} color="#64748b" />,
      label: 'แปลงปลูก (Growing Area)',
      sub: 'ไม่มีเซนเซอร์ตรวจวัดส่วนนี้',
      s: growingAreaStatus,
    },
    {
      icon: <FlaskConical size={18} color="#8b5cf6" />,
      label: 'เซนเซอร์ pH (pH Sensor)',
      sub: fmtVal(ph, 2, ''),
      s: phStatus,
    },
    {
      icon: <Zap size={18} color="#f59e0b" />,
      label: 'เซนเซอร์ EC/TDS (EC/TDS Sensor)',
      sub: fmtVal(ec, 2, ' mS/cm'),
      s: ecStatus,
    },
    {
      icon: <Thermometer size={18} color="#ef4444" />,
      label: 'เซนเซอร์อุณหภูมิน้ำ (Temperature Sensor)',
      sub: fmtVal(temp, 1, '°C'),
      s: tempStatus,
    },
    {
      icon: <Gauge size={18} color="#0ea5e9" />,
      label: 'สวิตช์ลูกลอยถังหลัก (Float Switch)',
      sub: mainTankStatusLabel(tankOk),
      s: mainTankStatus,
    },
    ...(enableDosingTracking
      ? [
          {
            icon: <Layers size={18} color="#10b981" />,
            label: 'แม่ปุ๋ย A (ประมาณการจากการเติม)',
            sub: estimate('fertA'),
            s: 'standby' as S,
          },
          {
            icon: <Layers size={18} color="#0284c7" />,
            label: 'แม่ปุ๋ย B (ประมาณการจากการเติม)',
            sub: estimate('fertB'),
            s: 'standby' as S,
          },
        ]
      : []),
  ];

  const flow: FlowItem[] = [
    {
      icon: <Database size={18} color="#0284c7" />,
      label: 'ถังน้ำหลัก (Main Tank)',
      color: '#eff6ff',
      border: '#bfdbfe',
      s: mainTankStatus,
    },
    {
      icon: <Activity size={18} color={data.pumps.mainPumpOn && isOnline ? '#059669' : '#64748b'} />,
      label: 'ปั๊มน้ำหลัก (Water Pump)',
      color: '#f0fdf6',
      border: '#bbf7d0',
      s: pumpStatus,
    },
    {
      icon: <Sprout size={18} color="#64748b" />,
      label: 'แปลงปลูก (Growing Area)',
      color: '#f8fafc',
      border: '#e2e8f0',
      s: growingAreaStatus,
    },
    {
      icon: <CornerDownLeft size={18} color="#64748b" />,
      label: 'ท่อไหลเวียนกลับ (Return Line)',
      color: '#f8fafc',
      border: '#e2e8f0',
      s: 'none',
    },
    {
      icon: <Database size={18} color="#0284c7" />,
      label: 'ถังน้ำหลัก (Main Tank)',
      color: '#eff6ff',
      border: '#bfdbfe',
      s: mainTankStatus,
    },
  ];

  return (
    <div className="screen-enter" style={{ padding: '0 16px 16px', fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif" }}>
      <div style={{ paddingTop: 48, paddingBottom: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={() => (goBack ? goBack('home') : navigate('home'))}
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: 'white',
            border: '1px solid #e2e8f0',
            cursor: 'pointer',
            boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#334155',
          }}
        >
          <ArrowLeft size={18} strokeWidth={1.75} />
        </button>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', margin: 0 }}>
          สถานะอุปกรณ์และการทำงาน (Farm Status)
        </h1>
      </div>

      {!connectedBoardId && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: 14,
            padding: '10px 14px',
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} color="#b45309" />
            <span style={{ fontWeight: 600, fontSize: 13, color: '#b45309' }}>ยังไม่ได้เชื่อมต่ออุปกรณ์</span>
          </div>
          <button
            type="button"
            onClick={() => navigate('connect-board')}
            style={{
              fontSize: 12,
              fontWeight: 600,
              background: '#f59e0b',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              minHeight: 44,
              padding: '0 14px',
              cursor: 'pointer',
            }}
          >
            เชื่อมต่อ
          </button>
        </div>
      )}

      {/* System flow */}
      <div style={{ background: 'white', borderRadius: 20, padding: 18, marginBottom: 14, border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,0.03)' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', margin: '0 0 14px' }}>
          แผนภาพการไหลเวียนน้ำ (System Flow)
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          {flow.map((node, i) => (
            <div key={i} style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div
                style={{
                  width: '90%',
                  background: node.color,
                  border: `1.5px solid ${node.border}`,
                  borderRadius: 14,
                  padding: '10px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {node.icon}
                  </div>
                  <span style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{node.label}</span>
                </div>
                {node.s === 'none' ? (
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' }}>ไม่มีเซนเซอร์</span>
                ) : (
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: dot[node.s],
                    }}
                    className={node.s === 'online' ? 'pulse-dot' : ''}
                  />
                )}
              </div>
              {i < flow.length - 1 && (
                <svg width="24" height="16" viewBox="0 0 24 16">
                  <path d="M12 0 L12 10 M6 6 L12 12 L18 6" stroke={pumpStatus === 'online' ? '#4ade80' : '#94a3b8'} strokeWidth="2" strokeLinecap="round" fill="none" />
                </svg>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Device list */}
      <div style={{ background: 'white', borderRadius: 20, padding: 18, border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,0.03)' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', margin: '0 0 14px' }}>
          สถานะอุปกรณ์และเซนเซอร์ (Device Status)
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {devices.map((d, i) => (
            <div
              key={d.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 0',
                borderBottom: i < devices.length - 1 ? '1px solid #f1f5f9' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: bg[d.s],
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `1px solid ${d.s === 'online' ? '#bbf7d0' : '#e2e8f0'}`,
                  }}
                >
                  {d.icon}
                </div>
                <div>
                  <p style={{ fontWeight: 600, fontSize: 13, color: '#0f172a', margin: 0 }}>{d.label}</p>
                  <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>{d.sub}</p>
                </div>
              </div>
              <StatusDot status={d.s} offlineLabel={offlineLabel} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
