import { useState, useEffect, useRef } from 'react';
import { NavProps } from '../types';
import { finiteOrNull } from '../services/telemetryContract';
import { useSmartFarm } from '../context/SmartFarmContext';
import { thingsboard } from '../services/thingsboard';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import AIDiagnosisModal from '../components/AIDiagnosisModal';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  Download,
  Square,
  Sparkles,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  AlertTriangle,
  FileSpreadsheet,
  Plus,
  Calendar,
} from 'lucide-react';

const sensors = [
  { key: 'ph', label: 'pH', unit: 'pH', color: '#059669' },
  { key: 'ec', label: 'EC', unit: 'mS/cm', color: '#0284c7' },
  { key: 'tds', label: 'TDS', unit: 'ppm', color: '#6366f1' },
  { key: 'temp', label: 'Temp', unit: '°C', color: '#d97706' },
];

const timeRanges = ['24 ชม.', '7 วัน', '30 วัน', 'ทั้งหมด', 'เลือกวัน'];

/** ThingsBoard AVG bucket per range (kept under the 500-bucket aggregation limit). */
const RANGE_QUERY: Record<string, { spanMs: number; intervalMs: number; label: string }> = {
  '24 ชม.': { spanMs: 24 * 3600_000, intervalMs: 180_000, label: 'ค่าเฉลี่ยทุก 3 นาที' },
  'เลือกวัน': { spanMs: 24 * 3600_000, intervalMs: 180_000, label: 'ค่าเฉลี่ยทุก 3 นาที' },
  '7 วัน': { spanMs: 7 * 24 * 3600_000, intervalMs: 3600_000, label: 'ค่าเฉลี่ยรายชั่วโมง' },
  '30 วัน': { spanMs: 30 * 24 * 3600_000, intervalMs: 6 * 3600_000, label: 'ค่าเฉลี่ยทุก 6 ชั่วโมง' },
  // "ทั้งหมด" = up to 365 days of daily averages (365 buckets)
  'ทั้งหมด': { spanMs: 365 * 24 * 3600_000, intervalMs: 24 * 3600_000, label: 'ค่าเฉลี่ยรายวัน' },
};

export interface HistoryScreenProps extends NavProps {
  initialSensor?: string;
}

export default function HistoryScreen({ navigate, goBack, initialSensor = 'ph', screenParams }: HistoryScreenProps) {
  const targetSensor = screenParams?.sensor || initialSensor || 'ph';
  const [selectedSensor, setSelectedSensor] = useState(targetSensor);
  const [isAIModalOpen, setIsAIModalOpen] = useState(false);

  useEffect(() => {
    const next = screenParams?.sensor || initialSensor;
    if (next) {
      setSelectedSensor(next);
    }
  }, [screenParams?.sensor, initialSensor]);
  const [selectedTime, setSelectedTime] = useState('24 ชม.');
  const dateInputRef = useRef<HTMLInputElement>(null);
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const d = new Date();
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${day}`;
  });

  const getTodayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const [thingsboardHistory, setThingsboardHistory] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isEndingSeason, setIsEndingSeason] = useState(false);
  const {
    data,
    endCropSeason,
    connectedBoardId,
    currentUser,
    savedBoards,
    showConfirm,
    showAlert,
  } = useSmartFarm();
  const farmName = (connectedBoardId && savedBoards[connectedBoardId]?.name) || data.profile.name || '';

  const currentSensorMeta = sensors.find((s) => s.key === selectedSensor) || sensors[0];

  // ดึงข้อมูลประวัติย้อนหลังจริงจาก ThingsBoard Cloud ตามช่วงเวลาหรือวันที่เลือก
  useEffect(() => {
    let isMounted = true;
    const fetchThingsBoardHistory = async () => {
      if (!connectedBoardId) {
        setThingsboardHistory([]);
        setLoadingHistory(false);
        return;
      }
      const targetBoard = connectedBoardId;
      const now = Date.now();
      const q = RANGE_QUERY[selectedTime] || RANGE_QUERY['24 ชม.'];
      let startTime = now - q.spanMs;
      let endTime = now;
      const interval = q.intervalMs;

      if (selectedTime === 'เลือกวัน') {
        const [y, m, d] = selectedDate.split('-').map(Number);
        startTime = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
        endTime = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
      }

      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const tbData = await thingsboard.getHistoricalTimeseries(
          targetBoard,
          // Contract v3 §1 telemetry keys (the board sends ph / temp, not pH / tempC)
          ['ph', 'ec', 'tds', 'temp'],
          startTime,
          endTime,
          interval,
          'AVG',
          15000
        );

        if (isMounted && tbData) {
          const timeMap = new Map<number, any>();
          for (const key of ['ph', 'ec', 'tds', 'temp']) {
            const points = tbData[key] || [];
            for (const pt of points) {
              const step = interval >= 60000 ? interval : 60000;
              const roundedTs = Math.round(pt.ts / step) * step;
              if (!timeMap.has(roundedTs)) {
                timeMap.set(roundedTs, { timestamp: pt.ts });
              }
              const row = timeMap.get(roundedTs);
              const numVal = finiteOrNull(pt.value);
              if (numVal === null) continue; // never chart NaN / garbage
              if (key === 'ph') row.pH = numVal;
              if (key === 'ec') row.ec = numVal;
              if (key === 'tds') row.tds = numVal;
              if (key === 'temp') row.tempC = numVal;
            }
          }
          const list = Array.from(timeMap.values()).sort((a: any, b: any) => a.timestamp - b.timestamp);
          setThingsboardHistory(list);
        }
      } catch (err: any) {
        console.warn('ThingsBoard History fetch failed:', err);
        if (isMounted) {
          // Do not keep showing another range's cloud data as if it were this range
          setThingsboardHistory([]);
          setHistoryError(err?.message ? String(err.message) : 'เชื่อมต่อ ThingsBoard ไม่สำเร็จ');
        }
      } finally {
        if (isMounted) setLoadingHistory(false);
      }
    };

    fetchThingsBoardHistory();
    return () => {
      isMounted = false;
    };
  }, [connectedBoardId, currentUser, selectedTime, selectedDate, reloadKey]);

  // รวมข้อมูลประวัติจาก ThingsBoard Cloud, State ในเครื่อง + LocalStorage
  const storedLocalHistory = (() => {
    if (!connectedBoardId) return {};
    try {
      const raw = localStorage.getItem(`smartfarm_history_${connectedBoardId}`);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  })();

  const rawHistory = connectedBoardId ? Object.values({ ...storedLocalHistory, ...(data.history || {}) }) : [];
  const combinedHistory = connectedBoardId ? [...thingsboardHistory, ...rawHistory] : [];

  const now = Date.now();

  const mapUnique = new Map<number, any>();
  combinedHistory.forEach((h: any) => {
    if (h && h.timestamp) {
      const ts = Number(h.timestamp);
      // ยอมรับเฉพาะ timestamp เวลาจริง (Unix epoch ms มากกว่าปี 2020) และไม่ขยับเวลาตามการเปิดแอป
      if (ts > 1577836800000) {
        const bucket = Math.round(ts / 60000) * 60000;
        const normalizedPoint = { ...h, timestamp: ts };
        if (!mapUnique.has(bucket)) {
          mapUnique.set(bucket, normalizedPoint);
        } else {
          mapUnique.set(bucket, { ...mapUnique.get(bucket), ...normalizedPoint });
        }
      }
    }
  });

  let filterStartTime = 0;
  let filterEndTime = Infinity;
  if (selectedTime === '24 ชม.') {
    filterStartTime = now - 24 * 60 * 60 * 1000;
  } else if (selectedTime === 'เลือกวัน') {
    const [y, m, d] = selectedDate.split('-').map(Number);
    filterStartTime = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    filterEndTime = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  } else if (selectedTime === '7 วัน') {
    filterStartTime = now - 7 * 24 * 60 * 60 * 1000;
  } else if (selectedTime === '30 วัน') {
    filterStartTime = now - 30 * 24 * 60 * 60 * 1000;
  } else if (selectedTime === 'ทั้งหมด') {
    filterStartTime = now - RANGE_QUERY['ทั้งหมด'].spanMs;
  }

  const filteredHistory = Array.from(mapUnique.values())
    .filter(
      (h) =>
        (!filterStartTime || (h.timestamp && h.timestamp >= filterStartTime)) &&
        (!filterEndTime || (h.timestamp && h.timestamp <= filterEndTime))
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const isSingleDay = selectedTime === '24 ชม.' || selectedTime === 'เลือกวัน';

  const chartData = filteredHistory.map((item) => {
    const d = new Date(item.timestamp);
    const timeLabel = isSingleDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    let raw: unknown = null;
    if (selectedSensor === 'ph') raw = item.pH;
    else if (selectedSensor === 'ec') raw = item.ec;
    else if (selectedSensor === 'tds') raw = item.tds;
    else if (selectedSensor === 'temp') raw = item.tempC;
    const val = finiteOrNull(raw);

    return {
      time: timeLabel,
      // null = no reading at this time (gap in the chart), never a stand-in value
      value: val === null ? null : Number(val.toFixed(2)),
      timestamp: item.timestamp,
    };
  });

  // Calculate statistics (Average, Min with timestamp, Max with timestamp, Trend)
  const validPoints = chartData.filter((d): d is { time: string; value: number; timestamp: number } => typeof d.value === 'number');
  let avg = '--';
  let min = '--';
  let minTime = '--';
  let max = '--';
  let maxTime = '--';
  let diff = 0;
  let diffPercent = '0';

  if (validPoints.length > 0) {
    let minPoint = validPoints[0];
    let maxPoint = validPoints[0];
    let sum = 0;

    for (const pt of validPoints) {
      sum += pt.value;
      if (pt.value < minPoint.value) minPoint = pt;
      if (pt.value > maxPoint.value) maxPoint = pt;
    }

    avg = (sum / validPoints.length).toFixed(2);
    min = minPoint.value.toFixed(2);
    minTime = isSingleDay ? `เวลา ${minPoint.time}` : minPoint.time;
    max = maxPoint.value.toFixed(2);
    maxTime = isSingleDay ? `เวลา ${maxPoint.time}` : maxPoint.time;

    if (validPoints.length >= 2) {
      const firstVal = validPoints[0].value;
      const lastVal = validPoints[validPoints.length - 1].value;
      diff = lastVal - firstVal;
      diffPercent = firstVal > 0 ? Math.abs((diff / firstVal) * 100).toFixed(1) : '0';
    }
  }

  // All points currently loaded (cloud range + on-device) for the season report
  const allLoadedHistory = Array.from(mapUnique.values()).sort((a, b) => a.timestamp - b.timestamp);

  const handleEndCropSeason = async () => {
    if (isEndingSeason) return;
    if (allLoadedHistory.length === 0) {
      showAlert({
        title: 'ไม่มีข้อมูลประวัติ',
        message: 'ยังไม่มีข้อมูลประวัติสำหรับบันทึกและจบฤดูกาลการปลูก',
        variant: 'info',
      });
      return;
    }

    showConfirm({
      title: 'ยืนยันการจบฤดูกาลปลูก',
      message:
        'ระบบจะส่งออกรายงาน CSV ของข้อมูลที่โหลดไว้ แล้วเริ่มนับรอบปลูกใหม่ตั้งแต่วันนี้\nประวัติบน ThingsBoard ยังเก็บไว้ ไม่ถูกลบ',
      confirmText: 'จบฤดูกาล',
      cancelText: 'ยกเลิก',
      variant: 'warning',
      onConfirm: async () => {
        setIsEndingSeason(true);
        try {
          // 1. Export first; stop if the report could not be produced (nothing is reset)
          const exported = await handleExportCSV(allLoadedHistory, { silent: true });
          if (exported === 'cancelled') {
            showAlert({
              title: 'ยังไม่ได้จบฤดูกาล',
              message: 'ยกเลิกการส่งออกรายงาน จึงยังไม่เริ่มรอบปลูกใหม่',
              variant: 'info',
            });
            return;
          }
          if (exported !== 'ok') {
            showAlert({
              title: 'ยังไม่ได้จบฤดูกาล',
              message: `ส่งออกรายงาน CSV ไม่สำเร็จ (${exported.error}) จึงยังไม่เริ่มรอบปลูกใหม่`,
              variant: 'danger',
            });
            return;
          }

          // 2. Start a new season (saves plantingStartDate to ThingsBoard; throws on failure)
          try {
            await endCropSeason();
          } catch (err: any) {
            showAlert({
              title: 'เริ่มรอบปลูกใหม่ไม่สำเร็จ',
              message: `ส่งออกรายงานแล้ว แต่บันทึกรอบปลูกใหม่ไปยังอุปกรณ์ไม่สำเร็จ: ${err?.message || 'ไม่ทราบสาเหตุ'}\nกรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่`,
              variant: 'danger',
            });
            return;
          }

          showAlert({
            title: 'จบฤดูกาลแล้ว',
            message: 'เริ่มรอบปลูกใหม่แล้ว (ประวัติบน ThingsBoard ยังเก็บไว้)',
            variant: 'success',
          });
        } finally {
          setIsEndingSeason(false);
        }
      },
    });
  };

  const formatBangkokDate = (ts: number): string => {
    try {
      const d = new Date(ts);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(d);

      const p: Record<string, string> = {};
      parts.forEach(({ type, value }) => {
        p[type] = value;
      });
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
    } catch {
      return new Date(ts).toISOString().replace('T', ' ').substring(0, 19);
    }
  };

  /**
   * Export rows as CSV. Native: write to Cache + system share sheet. Web: <a download>.
   * Returns 'ok' | 'cancelled' | { error }. With `silent`, the caller reports the result.
   */
  const handleExportCSV = async (
    sourceEntries?: any[],
    opts: { silent?: boolean } = {}
  ): Promise<'ok' | 'cancelled' | { error: string }> => {
    if (!connectedBoardId) {
      if (!opts.silent) {
        showAlert({
          title: 'ไม่พบอุปกรณ์เชื่อมต่อ',
          message: 'ยังไม่มีอุปกรณ์ที่เชื่อมต่อ ไม่สามารถส่งออกประวัติได้',
          variant: 'warning',
        });
      }
      return { error: 'ไม่พบอุปกรณ์เชื่อมต่อ' };
    }

    const entries = sourceEntries || filteredHistory;
    if (entries.length === 0) {
      if (!opts.silent) {
        showAlert({
          title: 'ไม่มีข้อมูลประวัติ',
          message: 'ยังไม่มีข้อมูลประวัติสำหรับส่งออกรายงาน',
          variant: 'info',
        });
      }
      return { error: 'ไม่มีข้อมูลประวัติ' };
    }

    const headers = 'วันเวลา,pH,EC (mS/cm),TDS (ppm),อุณหภูมิ (°C)';
    const rows = entries.map((e) => {
      const timeStr = formatBangkokDate(e.timestamp);
      const phStr = e.pH !== undefined && e.pH !== null ? e.pH : '';
      const ecStr = e.ec !== undefined && e.ec !== null ? e.ec : '';
      const tdsStr = e.tds !== undefined && e.tds !== null ? e.tds : '';
      const tempStr = e.tempC !== undefined && e.tempC !== null ? e.tempC : '';
      return `${timeStr},${phStr},${ecStr},${tdsStr},${tempStr}`;
    });

    const csvContent = '\uFEFF' + [headers, ...rows].join('\n');
    const fileName = `smartfarm_history_${Date.now()}.csv`;

    if (Capacitor.isNativePlatform()) {
      try {
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
        return 'ok';
      } catch (err: any) {
        const msg = String(err?.message || '');
        // Closing the share sheet rejects with "Share canceled" on Android/iOS
        if (/cancel/i.test(msg)) return 'cancelled';
        if (!opts.silent) {
          showAlert({
            title: 'ส่งออกล้มเหลว',
            message: msg || 'ไม่สามารถส่งออกไฟล์บนอุปกรณ์ได้',
            variant: 'danger',
          });
        }
        return { error: msg || 'ไม่สามารถส่งออกไฟล์บนอุปกรณ์ได้' };
      }
    }

    try {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return 'ok';
    } catch (err: any) {
      const msg = String(err?.message || 'ไม่สามารถดาวน์โหลดไฟล์ได้');
      if (!opts.silent) {
        showAlert({ title: 'ส่งออกล้มเหลว', message: msg, variant: 'danger' });
      }
      return { error: msg };
    }
  };

  return (
    <div
      style={{
        paddingBottom: 88,
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          background: '#ffffff',
          padding: '52px 20px 16px',
          borderBottom: '1px solid #f1f5f9',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '0 0 14px' }}>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: '#0f172a',
              margin: 0,
              letterSpacing: '-0.02em',
            }}
          >
            ประวัติข้อมูลย้อนหลัง
          </h1>
          {farmName && (
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              {farmName}
            </span>
          )}
        </div>

        {/* Time ranges pill & Date Picker */}
        {connectedBoardId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
              {timeRanges.map((tr) => (
                <button
                  key={tr}
                  type="button"
                  onClick={() => setSelectedTime(tr)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 20,
                    border: 'none',
                    fontSize: 12,
                    fontWeight: selectedTime === tr ? 600 : 400,
                    background: selectedTime === tr ? '#0f172a' : '#f1f5f9',
                    color: selectedTime === tr ? '#ffffff' : '#64748b',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  {tr === 'เลือกวัน' && <Calendar size={13} />}
                  <span>{tr}</span>
                </button>
              ))}
            </div>

            {selectedTime === 'เลือกวัน' && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                  background: '#f8fafc',
                  border: '1px solid #cbd5e1',
                  borderRadius: 14,
                  padding: '8px 12px',
                  width: 'fit-content',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                }}
              >
                <div
                  onClick={() => {
                    try {
                      dateInputRef.current?.showPicker?.();
                    } catch (_) {}
                    dateInputRef.current?.focus();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                  }}
                >
                  <Calendar size={16} color="#059669" />
                  <span style={{ fontSize: 12, color: '#334155', fontWeight: 600 }}>เลือกวันที่:</span>
                  <input
                    ref={dateInputRef}
                    type="date"
                    value={selectedDate}
                    onChange={(e) => {
                      if (e.target.value) setSelectedDate(e.target.value);
                    }}
                    onClick={(e) => {
                      try {
                        (e.currentTarget as any).showPicker?.();
                      } catch (_) {}
                    }}
                    style={{
                      border: '1.5px solid #059669',
                      borderRadius: 8,
                      padding: '4px 10px',
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: '#0f172a',
                      background: '#ffffff',
                      cursor: 'pointer',
                      outline: 'none',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>

                {/* Quick Preset: วันนี้ */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => setSelectedDate(getTodayStr())}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 8,
                      border: selectedDate === getTodayStr() ? '1px solid #059669' : '1px solid #e2e8f0',
                      background: selectedDate === getTodayStr() ? '#ecfdf5' : '#ffffff',
                      color: selectedDate === getTodayStr() ? '#059669' : '#64748b',
                      fontSize: 11,
                      fontWeight: selectedDate === getTodayStr() ? 600 : 500,
                      cursor: 'pointer',
                    }}
                  >
                    วันนี้
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {!connectedBoardId ? (
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
              <FileSpreadsheet size={32} strokeWidth={1.5} />
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>
              ยังไม่มีอุปกรณ์ที่เชื่อมต่อ
            </h2>
            <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 24px', lineHeight: 1.5, maxWidth: 280 }}>
              ไม่สามารถแสดงกราฟและประวัติข้อมูลย้อนหลังได้ เนื่องจากไม่มีอุปกรณ์ที่เชื่อมต่ออยู่ในระบบ โปรดเพิ่มหรือเชื่อมต่ออุปกรณ์
            </p>
            <button
              type="button"
              onClick={() => navigate('add-board')}
              style={{
                padding: '12px 24px',
                borderRadius: 12,
                background: '#059669',
                color: '#ffffff',
                border: 'none',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Plus size={16} strokeWidth={2} />
              <span>เพิ่มอุปกรณ์ใหม่</span>
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Sensor selector tabs */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
          {sensors.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSelectedSensor(s.key)}
              style={{
                padding: '7px 14px',
                borderRadius: 10,
                border: `1px solid ${selectedSensor === s.key ? '#059669' : '#e2e8f0'}`,
                background: selectedSensor === s.key ? '#ecfdf5' : '#ffffff',
                color: selectedSensor === s.key ? '#059669' : '#475569',
                fontSize: 12,
                fontWeight: selectedSensor === s.key ? 600 : 400,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Chart Card (Shadcn UI Area Chart - Interactive Style) */}
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 18,
            padding: '18px 16px',
            boxShadow: '0 2px 10px -2px rgba(15, 23, 42, 0.04)',
          }}
        >
          {/* Card Header */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: 14,
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14.5, fontWeight: 700, color: '#0f172a' }}>
                  แนวโน้ม {currentSensorMeta.label}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: '#f1f5f9',
                    color: '#475569',
                    fontWeight: 600,
                  }}
                >
                  Area Chart - Interactive
                </span>
              </div>
              <p style={{ fontSize: 11, color: '#94a3b8', margin: '3px 0 0' }}>
                {selectedTime === 'เลือกวัน'
                  ? `วันที่เลือก: ${selectedDate}`
                  : (selectedTime === '24 ชม.' ? 'ช่วงเวลา 24 ชั่วโมงล่าสุด' : `ช่วงเวลา ${selectedTime}`)}
              </p>
            </div>
            <span
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 9999,
                background: '#ecfdf5',
                color: '#059669',
                fontWeight: 600,
              }}
            >
              {selectedTime === 'เลือกวัน' ? selectedDate : selectedTime}
            </span>
          </div>

          {/* Chart Container */}
          <div
            style={{
              height: 210,
              width: '100%',
              outline: 'none',
              WebkitTapHighlightColor: 'transparent',
              userSelect: 'none',
            }}
          >
            {historyError && chartData.length === 0 ? (
              <div
                role="alert"
                style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  textAlign: 'center',
                  padding: '0 16px',
                }}
              >
                <AlertTriangle size={22} color="#d97706" />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>โหลดประวัติจาก ThingsBoard ไม่สำเร็จ</span>
                <span style={{ fontSize: 11, color: '#94a3b8', wordBreak: 'break-word' }}>{historyError}</span>
                <button
                  type="button"
                  onClick={() => setReloadKey((k) => k + 1)}
                  disabled={loadingHistory}
                  style={{
                    minHeight: 44,
                    padding: '0 18px',
                    borderRadius: 12,
                    border: '1px solid #cbd5e1',
                    background: '#ffffff',
                    color: '#0f172a',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: loadingHistory ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <RefreshCw size={14} className={loadingHistory ? 'animate-spin' : ''} />
                  <span>{loadingHistory ? 'กำลังโหลด...' : 'ลองอีกครั้ง'}</span>
                </button>
              </div>
            ) : chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%" style={{ outline: 'none' }}>
                <AreaChart
                  data={chartData}
                  margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                  style={{ outline: 'none', WebkitTapHighlightColor: 'transparent' }}
                >
                  <defs>
                    <linearGradient id={`gradient-${selectedSensor}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={currentSensorMeta.color} stopOpacity={0.38} />
                      <stop offset="95%" stopColor={currentSensorMeta.color} stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="time"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    stroke="#94a3b8"
                    fontSize={10}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={4}
                    stroke="#94a3b8"
                    fontSize={10}
                    domain={['auto', 'auto']}
                  />
                  <Tooltip
                    cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '4 4' }}
                    wrapperStyle={{ outline: 'none', pointerEvents: 'none' }}
                    content={({ active, payload, label }) => {
                      if (active && payload && payload.length) {
                        return (
                          <div
                            style={{
                              background: '#ffffff',
                              border: '1px solid #e2e8f0',
                              borderRadius: 10,
                              padding: '8px 12px',
                              boxShadow: '0 4px 16px -2px rgba(15, 23, 42, 0.12)',
                              outline: 'none',
                            }}
                          >
                            <p style={{ margin: 0, fontSize: 11, color: '#64748b' }}>เวลา {label}</p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                              <div
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: '50%',
                                  background: currentSensorMeta.color,
                                }}
                              />
                              <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', fontFamily: 'monospace' }}>
                                {payload[0].value} {currentSensorMeta.unit}
                              </span>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Area
                    type="natural"
                    dataKey="value"
                    stroke={currentSensorMeta.color}
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill={`url(#gradient-${selectedSensor})`}
                    dot={false}
                    activeDot={{
                      r: 6,
                      stroke: currentSensorMeta.color,
                      strokeWidth: 2,
                      fill: '#ffffff',
                      style: { outline: 'none' },
                    }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#94a3b8',
                  fontSize: 13,
                }}
              >
                {loadingHistory ? 'กำลังโหลดประวัติ...' : 'ยังไม่มีข้อมูลประวัติในช่วงเวลานี้'}
              </div>
            )}
          </div>

          {/* Cloud fetch failed but on-device points exist: say so, offer retry */}
          {historyError && chartData.length > 0 && (
            <div
              role="alert"
              style={{
                marginTop: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 10,
                background: '#fffbeb',
                border: '1px solid #fde68a',
                fontSize: 11.5,
                color: '#92400e',
              }}
            >
              <span>โหลดจาก ThingsBoard ไม่สำเร็จ แสดงเฉพาะค่าที่บันทึกในเครื่อง</span>
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                disabled={loadingHistory}
                style={{
                  minHeight: 44,
                  padding: '0 12px',
                  borderRadius: 10,
                  border: '1px solid #f59e0b',
                  background: '#ffffff',
                  color: '#92400e',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                ลองอีกครั้ง
              </button>
            </div>
          )}

          {/* Card Footer (Trend Indicator) */}
          {validPoints.length >= 2 && (
            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid #f1f5f9',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#0f172a' }}>
                <span>
                  {diff >= 0 ? `แนวโน้มเพิ่มขึ้น +${diff.toFixed(2)}` : `แนวโน้มลดลง ${diff.toFixed(2)}`} ({diffPercent}%) ในรอบ {selectedTime}
                </span>
                {diff >= 0 ? (
                  <TrendingUp size={14} style={{ color: '#059669' }} />
                ) : (
                  <TrendingDown size={14} style={{ color: '#dc2626' }} />
                )}
              </div>
              <p style={{ margin: 0, fontSize: 11, color: '#94a3b8' }}>
                {(RANGE_QUERY[selectedTime] || RANGE_QUERY['24 ชม.']).label} จาก ThingsBoard ตลอดช่วง {selectedTime}
                {' '}(รวมค่าที่บันทึกในเครื่อง)
              </p>
            </div>
          )}
        </div>

        {/* Summary Statistics (Avg / Min with Time / Max with Time) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          <div
            style={{
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 16,
              padding: '12px 8px',
              textAlign: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
            }}
          >
            <p style={{ fontSize: 11, color: '#64748b', margin: 0, fontWeight: 500 }}>ค่าเฉลี่ย</p>
            <p style={{ fontSize: 17, fontWeight: 700, color: '#0f172a', margin: '4px 0 2px', fontFamily: 'monospace' }}>
              {avg}
            </p>
            <p style={{ fontSize: 10, color: '#94a3b8', margin: 0 }}>
              {currentSensorMeta.unit || 'เกณฑ์มาตรฐาน'}
            </p>
          </div>
          <div
            style={{
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 16,
              padding: '12px 8px',
              textAlign: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
            }}
          >
            <p style={{ fontSize: 11, color: '#64748b', margin: 0, fontWeight: 500 }}>ต่ำสุด</p>
            <p style={{ fontSize: 17, fontWeight: 700, color: '#0f172a', margin: '4px 0 2px', fontFamily: 'monospace' }}>
              {min}
            </p>
            <p style={{ fontSize: 10.5, color: '#059669', margin: 0, fontWeight: 600 }}>
              {minTime !== '--' ? minTime : '--'}
            </p>
          </div>
          <div
            style={{
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 16,
              padding: '12px 8px',
              textAlign: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
            }}
          >
            <p style={{ fontSize: 11, color: '#64748b', margin: 0, fontWeight: 500 }}>สูงสุด</p>
            <p style={{ fontSize: 17, fontWeight: 700, color: '#0f172a', margin: '4px 0 2px', fontFamily: 'monospace' }}>
              {max}
            </p>
            <p style={{ fontSize: 10.5, color: '#059669', margin: 0, fontWeight: 600 }}>
              {maxTime !== '--' ? maxTime : '--'}
            </p>
          </div>
        </div>

        {/* Actions Row (AI Analysis & End Season) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          <button
            type="button"
            onClick={() => setIsAIModalOpen(true)}
            style={{
              padding: '12px',
              borderRadius: 12,
              border: '1px solid #059669',
              background: '#ffffff',
              color: '#059669',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <Sparkles size={16} strokeWidth={1.75} />
            <span>ส่งให้ AI ภายนอกวิเคราะห์</span>
          </button>

          <button
            type="button"
            onClick={handleEndCropSeason}
            disabled={isEndingSeason}
            aria-busy={isEndingSeason}
            style={{
              padding: '12px',
              minHeight: 44,
              borderRadius: 12,
              border: '1px solid #dc2626',
              background: '#ffffff',
              color: '#dc2626',
              fontSize: 13,
              fontWeight: 500,
              cursor: isEndingSeason ? 'wait' : 'pointer',
              opacity: isEndingSeason ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            {isEndingSeason ? (
              <RefreshCw size={16} strokeWidth={1.75} className="animate-spin" />
            ) : (
              <Square size={16} strokeWidth={1.75} />
            )}
            <span>{isEndingSeason ? 'กำลังจบฤดูกาล...' : 'จบฤดูกาลปลูก'}</span>
          </button>
        </div>

        {/* Export CSV button */}
        <button
          type="button"
          onClick={() => {
            void handleExportCSV();
          }}
          style={{
            width: '100%',
            padding: '12px',
            minHeight: 44,
            borderRadius: 12,
            border: '1px solid #e2e8f0',
            background: '#ffffff',
            color: '#334155',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Download size={16} strokeWidth={1.75} />
          <span>ส่งออกข้อมูลประวัติเป็น CSV</span>
        </button>
      </div>
      )}

      <AIDiagnosisModal isOpen={isAIModalOpen} onClose={() => setIsAIModalOpen(false)} />
    </div>
  );
}
