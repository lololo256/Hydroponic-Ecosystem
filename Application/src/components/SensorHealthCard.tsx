import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { useSmartFarm } from '../context/SmartFarmContext';
import { thingsboard } from '../services/thingsboard';
import { analyzeSensorHealth, type HealthCheck, type Sample, type SensorHealthReport } from '../services/sensorHealth';
import { FEATURES } from '../config/features';

const WINDOW_MS = 3 * 60 * 60 * 1000;
const KEYS = ['ph', 'ec', 'temp', 'run_ph_down', 'run_ph_up', 'run_a', 'run_b'];

const toSamples = (arr: Array<{ ts: number; value: unknown }> | undefined): Sample[] =>
  (arr || [])
    .map((p) => ({ ts: Number(p.ts), value: typeof p.value === 'string' ? Number(p.value) : (p.value as number) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.value));

const LEVEL_STYLE: Record<HealthCheck['level'], { color: string; bg: string; Icon: typeof Info }> = {
  critical: { color: '#b91c1c', bg: '#fef2f2', Icon: XCircle },
  warning: { color: '#b45309', bg: '#fffbeb', Icon: AlertTriangle },
  info: { color: '#475569', bg: '#f8fafc', Icon: Info },
  ok: { color: '#047857', bg: '#ecfdf5', Icon: CheckCircle2 },
};

const OVERALL: Record<SensorHealthReport['overall'], { text: string; color: string }> = {
  good: { text: 'เซนเซอร์ทำงานปกติ', color: '#047857' },
  attention: { text: 'มีจุดที่ควรตรวจ', color: '#b45309' },
  problem: { text: 'พบปัญหาที่ต้องแก้', color: '#b91c1c' },
  unknown: { text: 'ข้อมูลยังไม่พอวิเคราะห์', color: '#64748b' },
};

/**
 * "AI ตรวจสุขภาพเซนเซอร์": runs the on-device sensor diagnostics on the last 3 hours of real
 * ThingsBoard telemetry (plus pump run-time counters to judge dosing response).
 */
export default function SensorHealthCard() {
  const { connectedBoardId, telemetryFreshness, data } = useSmartFarm();
  const [report, setReport] = useState<SensorHealthReport | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  const run = useCallback(async () => {
    if (!connectedBoardId) return;
    setRunning(true);
    setError('');
    try {
      const now = Date.now();
      const ts = await thingsboard.getHistoricalTimeseries(connectedBoardId, KEYS, now - WINDOW_MS, now, 60000, 'NONE', 20000, 2000);
      const r = analyzeSensorHealth({
        now,
        freshness: telemetryFreshness,
        isSim: FEATURES.showDemoBoardLabels && Boolean(data.device.isSim),
        sensorOk: data.device.sensorOk ?? null,
        current: { pH: data.current.pH, ec: data.current.ec, tempC: data.current.tempC },
        series: { ph: toSamples(ts.ph as any), ec: toSamples(ts.ec as any), temp: toSamples(ts.temp as any) },
        runtime: {
          phDown: toSamples(ts.run_ph_down as any),
          phUp: toSamples(ts.run_ph_up as any),
          fertA: toSamples(ts.run_a as any),
          fertB: toSamples(ts.run_b as any),
        },
      });
      setReport(r);
      setCheckedAt(now);
      // Stay collapsed: the header already says "มีจุดที่ควรตรวจ"; the user taps to open the details.
    } catch (e: any) {
      setError(e?.message || 'ดึงข้อมูลย้อนหลังไม่สำเร็จ');
    } finally {
      setRunning(false);
    }
  }, [connectedBoardId, telemetryFreshness, data.device.isSim, data.device.sensorOk, data.current.pH, data.current.ec, data.current.tempC]);

  // Check once when a device is selected and reachable; afterwards on demand.
  useEffect(() => {
    setReport(null);
    setCheckedAt(null);
  }, [connectedBoardId]);
  useEffect(() => {
    if (connectedBoardId && !report && !running && (telemetryFreshness === 'live' || telemetryFreshness === 'stale' || telemetryFreshness === 'offline')) {
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedBoardId, telemetryFreshness, report]);

  if (!connectedBoardId) return null;

  const overall = report ? OVERALL[report.overall] : null;
  const problems = report ? report.checks.filter((c) => c.level === 'critical' || c.level === 'warning').length : 0;

  return (
    <div style={{ background: '#ffffff', borderRadius: 20, border: '1px solid rgba(226,232,240,0.8)', padding: '14px 16px', boxShadow: '0 2px 12px -2px rgba(15,23,42,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Activity size={18} color="#0f766e" />
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#0f172a' }}>AI ตรวจสุขภาพเซนเซอร์</p>
            <p style={{ margin: '2px 0 0', fontSize: 11.5, color: overall?.color || '#64748b' }}>
              {running
                ? 'กำลังวิเคราะห์ข้อมูล 3 ชั่วโมงล่าสุด...'
                : error
                  ? error
                  : overall
                    ? `${overall.text}${report?.score !== null && report?.score !== undefined ? ` · คะแนน ${report.score}/100` : ''}`
                    : 'ยังไม่ได้ตรวจ'}
            </p>
          </div>
        </div>
        <button
          onClick={run}
          disabled={running}
          aria-label="ตรวจเซนเซอร์อีกครั้ง"
          style={{ minWidth: 44, minHeight: 44, borderRadius: 12, border: '1px solid #e2e8f0', background: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: running ? 'not-allowed' : 'pointer', color: '#0f766e' }}
        >
          {running ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
        </button>
      </div>

      {report && (
        <>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{ marginTop: 10, width: '100%', minHeight: 40, border: 'none', background: '#f8fafc', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', cursor: 'pointer', fontSize: 12.5, color: '#334155' }}
          >
            <span>
              {problems > 0 ? `พบ ${problems} เรื่องที่ควรตรวจ` : `ผลการตรวจ ${report.checks.length} รายการ`}
              {checkedAt ? ` · ${new Date(checkedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {expanded && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {report.checks.map((c) => {
                const st = LEVEL_STYLE[c.level];
                return (
                  <div key={c.id} style={{ background: st.bg, borderRadius: 12, padding: '10px 12px', display: 'flex', gap: 8 }}>
                    <st.Icon size={16} color={st.color} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: st.color }}>{c.title}</p>
                      <p style={{ margin: '2px 0 0', fontSize: 12, color: '#475569', lineHeight: 1.5 }}>{c.detail}</p>
                      {c.advice && <p style={{ margin: '4px 0 0', fontSize: 12, color: '#0f172a', lineHeight: 1.5 }}>แนะนำ: {c.advice}</p>}
                    </div>
                  </div>
                );
              })}
              <p style={{ margin: '2px 0 0', fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                วิเคราะห์ในเครื่องจากค่าจริง {report.sampleCount} จุดใน 3 ชั่วโมงล่าสุด ไม่ส่งข้อมูลออกนอกแอป
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
