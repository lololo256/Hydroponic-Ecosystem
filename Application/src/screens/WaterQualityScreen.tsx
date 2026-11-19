import { useState, useMemo, useEffect } from 'react';
import { NavProps } from '../types';
import { useSmartFarm, SolutionTankKey, PumpKey } from '../context/SmartFarmContext';
import type { TankLevel } from '../services/solutionTracker';
import PumpFlowCalibrationModal from '../components/PumpFlowCalibrationModal';
import StatusBadge from '../components/StatusBadge';
import DemoBoardBadge from '../components/DemoBoardBadge';
import {
  getEffectiveTargets,
  mainTankStatusLabel,
  isChemicalPump,
  CHEM_PUMP_DEFAULT_SECONDS,
  MAIN_PUMP_DEFAULT_SECONDS,
} from '../services/telemetryContract';
import { analyzeDiurnalPattern, DIURNAL_PHASES, DiurnalPhaseKey } from '../services/diurnalPredictor';
import {
  Power,
  Plus,
  Lock,
  Unlock,
  AlertTriangle,
  CheckCircle,
  CheckCircle2,
  AlertCircle,
  X,
  ShieldAlert,
  Sparkles,
  Info,
  Sprout,
  ChevronRight,
  Sun,
  Sunrise,
  Sunset,
  Moon,
  Activity,
  Loader2,
} from 'lucide-react';
import { FEATURES } from '../config/features';

type SubTab = 'quality' | 'levels' | 'pumps' | 'targets';

interface WaterQualityProps extends NavProps {
  initialTab?: SubTab;
}

export default function WaterQualityScreen({ navigate, initialTab = 'quality' }: WaterQualityProps) {
  const {
    data,
    connectedBoardId,
    togglePump,
    refillTank,
    solutionLevels,
    setControlMode,
    updateTargets,
    savedBoards,
    pendingPumps,
    pendingMode,
    commandError,
    clearCommandError,
    canControl,
    isDemoBoard,
    telemetryFreshness,
    showConfirm,
    showAlert,
    enableDosingTracking,
    setEnableDosingTracking,
    pumpRunEnds,
  } = useSmartFarm();
  // 1 s tick only while a pump started from the app is running (countdown on its button).
  const [clockMs, setClockMs] = useState(() => Date.now());
  const autoCycle = data.autoCycle ?? null;
  const hasRunningCountdown =
    Object.values(pumpRunEnds || {}).some((t) => typeof t === 'number' && t > clockMs) ||
    (autoCycle?.phase === 'mixing' && typeof autoCycle.mixEndsAt === 'number' && autoCycle.mixEndsAt > clockMs);
  useEffect(() => {
    if (!hasRunningCountdown) return;
    const id = setInterval(() => setClockMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunningCountdown]);
  const [activeTab, setActiveTab] = useState<SubTab>(initialTab);

  const handleToggleDosingTracking = () => {
    setEnableDosingTracking(!enableDosingTracking);
  };
  const isBoardPaired = !!connectedBoardId;
  // Contract v3 §6: controls only when telemetry is live.
  const isOnline = isBoardPaired && canControl;
  const targets = getEffectiveTargets(data);
  const isConnected = isBoardPaired;
  const farmName = (connectedBoardId && savedBoards[connectedBoardId]?.name) || data.profile.name || '';

  // รวบรวมข้อมูลประวัติเซนเซอร์จริง
  const rawHistoryList = useMemo(() => {
    if (!connectedBoardId) return Object.values(data.history || {});
    try {
      const raw = localStorage.getItem(`smartfarm_history_${connectedBoardId}`);
      const localHist = raw ? JSON.parse(raw) : {};
      return Object.values({ ...localHist, ...(data.history || {}) });
    } catch (_) {
      return Object.values(data.history || {});
    }
  }, [connectedBoardId, data.history]);

  // Values are only trusted while the device is reporting (live or stale).
  const hasFreshTelemetry = telemetryFreshness === 'live' || telemetryFreshness === 'stale';

  // วิเคราะห์ตามช่วงเวลา (rule-based) — ไม่ใช้ค่าจากอุปกรณ์ที่ออฟไลน์ / ยังโหลดไม่เสร็จ
  const diurnalMetrics = useMemo(() => {
    return analyzeDiurnalPattern(
      rawHistoryList as any[],
      {
        // Missing readings stay null: the predictor skips those rules (no stand-in values)
        pH: hasFreshTelemetry ? data.current.pH : null,
        ec: hasFreshTelemetry ? data.current.ec : null,
        tempC: hasFreshTelemetry ? data.current.tempC : null,
        level: null,
      },
      data.plantType || 'พืชไฮโดรโปนิกส์',
      targets.ecMin,
      targets.ecMax,
      targets.phMin,
      targets.phMax
    );
  }, [rawHistoryList, hasFreshTelemetry, data.current, data.plantType, targets.ecMin, targets.ecMax, targets.phMin, targets.phMax]);

  const handleTogglePumpWithConfirm = (pumpKey: PumpKey, seconds?: number) => {
    if (!isOnline) {
      showAlert({
        title: 'ปั๊มถูกล็อก',
        message: 'อุปกรณ์ไม่ได้ส่งข้อมูลสด (ข้อมูลเก่ากว่า 75 วินาที หรือออฟไลน์) ไม่สามารถสั่งงานได้เพื่อความปลอดภัย',
        variant: 'warning',
      });
      return;
    }
    if (pendingPumps[pumpKey]) {
      return;
    }
    if (isChemicalPump(pumpKey) && data.pumps.controlMode !== 'MANUAL') {
      showAlert({
        title: 'ปั๊มสารเคมีถูกล็อก',
        message: 'สั่งปั๊มสารเคมีได้เฉพาะโหมด MANUAL กรุณาสลับโหมดด้านบนก่อน',
        variant: 'warning',
      });
      return;
    }

    const pumpNames: Record<PumpKey, string> = {
      mainPumpOn: 'ปั๊มน้ำหลัก',
      phDownPumpOn: 'ปั๊มลด pH',
      phUpPumpOn: 'ปั๊มเพิ่ม pH',
      fertPumpAOn: 'ปั๊มปุ๋ย A',
      fertPumpBOn: 'ปั๊มปุ๋ย B',
    };
    const isCurrentlyOn = data.pumps[pumpKey] === true;
    const action = isCurrentlyOn ? 'หยุด' : isChemicalPump(pumpKey) ? 'จ่าย' : 'เปิด';
    const currentFarmName = farmName || 'ฟาร์มที่เลือก';
    const durationText = isCurrentlyOn
      ? 'อุปกรณ์จะหยุดปั๊มทันที'
      : isChemicalPump(pumpKey)
      ? `อุปกรณ์จะจ่ายสาร ${seconds ?? CHEM_PUMP_DEFAULT_SECONDS} วินาทีแล้วหยุดเอง`
      : `อุปกรณ์จะเปิดปั๊ม ${Math.round(MAIN_PUMP_DEFAULT_SECONDS / 60)} นาทีแล้วปิดเอง (กดอีกครั้งเพื่อหยุดก่อนได้)`;

    showConfirm({
      title: `${action}${pumpNames[pumpKey]}`,
      message: `คุณต้องการ${action}${pumpNames[pumpKey]}ของ ${currentFarmName} ใช่หรือไม่?\n${durationText}`,
      confirmText: action,
      cancelText: 'ยกเลิก',
      variant: isCurrentlyOn ? 'danger' : 'success',
      // togglePump shows its own alert on failure; swallow the rejection here.
      onConfirm: () => togglePump(pumpKey, seconds).catch(() => {}),
    });
  };

  const handleSetMode = (mode: 'AUTO' | 'MANUAL') => {
    if (pendingMode || data.pumps.controlMode === mode) return;
    if (!isOnline) {
      showAlert({
        title: 'เปลี่ยนโหมดไม่ได้',
        message: 'อุปกรณ์ไม่ได้ส่งข้อมูลสด ระบบล็อกการเปลี่ยนโหมดเพื่อความปลอดภัย',
        variant: 'warning',
      });
      return;
    }
    // setControlMode shows its own alert on failure
    setControlMode(mode).catch(() => {});
  };

  const renderPumpRow = (pumpKey: PumpKey, index: number, title: string, subtitle: string, onBg: string, onColor: string) => {
    const pending = Boolean(pendingPumps[pumpKey]);
    const reported = data.pumps[pumpKey];
    const isOn = reported === true;
    const chem = isChemicalPump(pumpKey);
    const chemLocked = chem && data.pumps.controlMode !== 'MANUAL';
    const disabled = !isOnline || pending || chemLocked;
    let label: string;
    if (pending) label = 'กำลังส่ง...';
    else if (!isOnline || reported === null) label = '--';
    else if (isOn) {
      const endAt = pumpRunEnds?.[pumpKey];
      const left = typeof endAt === 'number' ? Math.max(0, Math.ceil((endAt - clockMs) / 1000)) : null;
      const leftText = left === null ? '' : left >= 60 ? ` ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : ` ${left} วิ`;
      label = chem ? `กำลังจ่าย${leftText} (กดเพื่อหยุด)` : `เปิดอยู่${leftText} (กดเพื่อหยุด)`;
    }
    else if (chemLocked) label = 'ล็อก (AUTO)';
    else label = chem ? `กดจ่าย ${CHEM_PUMP_DEFAULT_SECONDS}s` : 'ปิด';
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: 0 }}>
              {index > 0 ? `${index}. ` : ''}{title}
            </p>
            {FEATURES.showDemoBoardLabels && (
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: isDemoBoard ? '#fef3c7' : '#f1f5f9', color: isDemoBoard ? '#92400e' : '#475569' }}>
                {isDemoBoard ? 'ปั๊มจำลอง' : 'รีเลย์จริง'}
              </span>
            )}
          </div>
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 0' }}>{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => handleTogglePumpWithConfirm(pumpKey, chem ? CHEM_PUMP_DEFAULT_SECONDS : undefined)}
          disabled={disabled}
          aria-busy={pending}
          className="active:scale-[0.98]"
          style={{
            minHeight: 44,
            minWidth: 88,
            padding: '8px 14px',
            borderRadius: 10,
            border: 'none',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            flexShrink: 0,
            background: !pending && isOnline && isOn ? onBg : '#f1f5f9',
            color: pending || !isOnline ? '#94a3b8' : isOn ? onColor : '#64748b',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: !isOnline ? 0.55 : 1,
            transition: 'all 0.15s ease',
          }}
        >
          {pending && <Loader2 size={13} className="animate-spin" />}
          <span>{label}</span>
        </button>
      </div>
    );
  };

  // Refill Modal state
  const [isRefillModalOpen, setIsRefillModalOpen] = useState(false);
  const [selectedTank, setSelectedTank] = useState<SolutionTankKey>('fertA');
  const [refillAmount, setRefillAmount] = useState('500');
  const [refillUnit, setRefillUnit] = useState<'ml' | 'L'>('ml');
  const [tankCapacity, setTankCapacity] = useState(1000);
  const [refillFeedback, setRefillFeedback] = useState<string | null>(null);
  const [calibrationTank, setCalibrationTank] = useState<SolutionTankKey | null>(null);

  // Local state for target settings
  const [phMin, setPhMin] = useState(targets.phMin);
  const [phMax, setPhMax] = useState(targets.phMax);
  const [ecMin, setEcMin] = useState(targets.ecMin);
  const [ecMax, setEcMax] = useState(targets.ecMax);
  const [isSaved, setIsSaved] = useState(false);

  // Solution tank level, CALCULATED in the context from: the last recorded refill, the pump's measured
  // flow rate and the board's cumulative pump run-time (manual presses + AUTO dosing). Never guessed:
  // vol / pct stay null until all of these are known. `cap` is the user's container size (form value).
  const getTankLevel = (tankKey: SolutionTankKey) => {
    const level = solutionLevels[tankKey];
    const cap = level.capacityMl ?? data.solutionTanks?.[tankKey]?.capacityMl ?? (tankKey.startsWith('fert') ? 1000 : 500);
    return { vol: level.remainingMl, cap, pct: level.pct, isLow: level.isLow, level };
  };

  const tankStatusText = (level: TankLevel): string => {
    switch (level.status) {
      case 'not_set':
        return 'ยังไม่ได้บันทึกการเติม (แตะเพื่อบันทึก)';
      case 'needs_flow':
        return 'ยังไม่ได้วัดอัตราไหลของปั๊ม (แตะเพื่อวัด)';
      case 'waiting_runtime':
        return 'รออุปกรณ์รายงานเวลาทำงานของปั๊ม (ต้องใช้เฟิร์มแวร์รุ่นใหม่)';
      case 'counter_reset':
        return 'ตัวนับของอุปกรณ์ถูกรีเซ็ต แตะเพื่อบันทึกการเติมใหม่';
      default:
        return `ประมาณการ ${level.remainingMl} / ${level.capacityMl} มล. · ใช้ไป ${level.usedMl} มล. (แตะเพื่อเติม)`;
    }
  };

  // Tapping a tank: measure the pump first if its flow is unknown, otherwise record a refill.
  const openTankAction = (tankKey: SolutionTankKey) => {
    if (solutionLevels[tankKey].status === 'needs_flow') setCalibrationTank(tankKey);
    else openRefillModal(tankKey);
  };

  const openRefillModal = (tankKey: SolutionTankKey) => {
    setSelectedTank(tankKey);
    const { vol, cap } = getTankLevel(tankKey);
    const needed = Math.max(0, cap - (vol ?? 0));
    setTankCapacity(cap);
    setRefillUnit('ml');
    setRefillAmount(needed > 0 ? String(needed) : '200');
    setIsRefillModalOpen(true);
  };

  const handleTankChange = (tankKey: SolutionTankKey) => {
    setSelectedTank(tankKey);
    const { vol, cap } = getTankLevel(tankKey);
    const needed = Math.max(0, cap - (vol ?? 0));
    setTankCapacity(cap);
    if (refillUnit === 'L') {
      setRefillAmount(needed > 0 ? (needed / 1000).toFixed(2) : '0.20');
    } else {
      setRefillAmount(needed > 0 ? String(needed) : '200');
    }
  };

  const handleQuickFillMax = () => {
    const { vol } = getTankLevel(selectedTank);
    const neededMl = Math.max(0, tankCapacity - (vol ?? 0));
    if (refillUnit === 'L') {
      setRefillAmount((neededMl / 1000).toFixed(2));
    } else {
      setRefillAmount(String(neededMl));
    }
  };

  const handleSubmitRefill = async () => {
    const rawVal = parseFloat(refillAmount) || 0;
    if (rawVal <= 0) return;
    const finalAmountMl = refillUnit === 'L' ? rawVal * 1000 : rawVal;
    try {
      await refillTank(selectedTank, finalAmountMl, tankCapacity);
    } catch (e: any) {
      setRefillFeedback(`บันทึกไม่สำเร็จ: ${e?.message || 'เครือข่ายขัดข้อง'}`);
      return;
    }
    setRefillFeedback('บันทึกการเติมสารละลายเรียบร้อยแล้ว');
    setTimeout(() => {
      setRefillFeedback(null);
      setIsRefillModalOpen(false);
    }, 1200);
  };

  const handleSaveTargets = async () => {
    try {
      await updateTargets({
        phMin,
        phMax,
        ecMin,
        ecMax,
      });
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2000);
    } catch (err: any) {
      showAlert({ title: 'บันทึกเป้าหมายไม่สำเร็จ', message: err?.message || 'ส่งค่าไปยังคลาวด์ไม่สำเร็จ', variant: 'danger' });
    }
  };

  const tankDisplayNames: Record<SolutionTankKey, { name: string; shortName: string; chemType: string; color: string }> = {
    fertA: { name: 'ถังแม่ปุ๋ย A', shortName: 'แม่ปุ๋ย A', chemType: 'สูตรธาตุหลัก A', color: '#059669' },
    fertB: { name: 'ถังแม่ปุ๋ย B', shortName: 'แม่ปุ๋ย B', chemType: 'สูตรธาตุหลัก B', color: '#6366f1' },
    phDown: { name: 'ถังสารลด pH (กรด)', shortName: 'สารลด pH', chemType: 'กรด (pH-)', color: '#d97706' },
    phUp: { name: 'ถังสารเพิ่ม pH (ด่าง/เบส)', shortName: 'สารเพิ่ม pH', chemType: 'ด่าง (pH+)', color: '#0d9488' },
  };

  const isAutoMode = data.pumps.controlMode === 'AUTO';

  return (
    <div
      style={{
        paddingBottom: 88,
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* ── Top Header ── */}
      <div
        style={{
          background: '#ffffff',
          padding: '52px 20px 14px',
          borderBottom: '1px solid #f1f5f9',
          boxSizing: 'border-box',
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
            การจัดการน้ำ
          </h1>
          {farmName && (
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              {farmName}
            </span>
          )}
        </div>

        {/* 4 Sub-Tabs */}
        <div
          style={{
            display: 'flex',
            gap: 6,
            background: '#f1f5f9',
            padding: 4,
            borderRadius: 12,
            boxSizing: 'border-box',
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('quality')}
            style={{
              flex: 1,
              padding: '7px 4px',
              borderRadius: 8,
              border: 'none',
              fontSize: 12,
              fontWeight: activeTab === 'quality' ? 600 : 400,
              background: activeTab === 'quality' ? '#ffffff' : 'transparent',
              color: activeTab === 'quality' ? '#0f172a' : '#64748b',
              boxShadow: activeTab === 'quality' ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
            }}
          >
            คุณภาพน้ำ
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('levels')}
            style={{
              flex: 1,
              padding: '7px 4px',
              borderRadius: 8,
              border: 'none',
              fontSize: 12,
              fontWeight: activeTab === 'levels' ? 600 : 400,
              background: activeTab === 'levels' ? '#ffffff' : 'transparent',
              color: activeTab === 'levels' ? '#0f172a' : '#64748b',
              boxShadow: activeTab === 'levels' ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
            }}
          >
            ระดับถัง
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('pumps')}
            style={{
              flex: 1,
              padding: '7px 4px',
              borderRadius: 8,
              border: 'none',
              fontSize: 12,
              fontWeight: activeTab === 'pumps' ? 600 : 400,
              background: activeTab === 'pumps' ? '#ffffff' : 'transparent',
              color: activeTab === 'pumps' ? '#0f172a' : '#64748b',
              boxShadow: activeTab === 'pumps' ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
            }}
          >
            ควบคุมปั๊ม & จ่ายสาร
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('targets')}
            style={{
              flex: 1,
              padding: '7px 4px',
              borderRadius: 8,
              border: 'none',
              fontSize: 12,
              fontWeight: activeTab === 'targets' ? 600 : 400,
              background: activeTab === 'targets' ? '#ffffff' : 'transparent',
              color: activeTab === 'targets' ? '#0f172a' : '#64748b',
              boxShadow: activeTab === 'targets' ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
            }}
          >
            เป้าหมาย
          </button>
        </div>
      </div>

      {/* ── Sub-Tab Contents ── */}
      <div style={{ padding: '16px', boxSizing: 'border-box' }}>
        {isBoardPaired && (telemetryFreshness === 'stale' || telemetryFreshness === 'offline' || telemetryFreshness === 'no_data') && (() => {
          const banner =
            telemetryFreshness === 'stale'
              ? { bg: '#fffbeb', border: '#fde68a', dot: '#f59e0b', title: '#92400e', body: '#b45309', heading: 'ข้อมูลเริ่มเก่า', detail: 'อุปกรณ์ยังไม่ส่งค่าใหม่ ค่าที่แสดงอาจไม่ใช่ค่าล่าสุด และระบบล็อกการสั่งงานชั่วคราว' }
              : telemetryFreshness === 'offline'
              ? { bg: '#fef2f2', border: '#fecdd3', dot: '#dc2626', title: '#991b1b', body: '#b91c1c', heading: 'อุปกรณ์ออฟไลน์ (ตัดการเชื่อมต่อ)', detail: 'ไม่พบสัญญาณจากอุปกรณ์ ตรวจสอบ Wi-Fi หรือการจ่ายไฟของอุปกรณ์' }
              : { bg: '#f8fafc', border: '#e2e8f0', dot: '#94a3b8', title: '#334155', body: '#64748b', heading: 'ยังไม่มีข้อมูลจากอุปกรณ์', detail: 'รอให้อุปกรณ์ส่งค่าตรวจวัดครั้งแรก ระหว่างนี้ค่าจะแสดงเป็น --' };
          return (
            <div
              role="status"
              style={{
                background: banner.bg,
                border: `1px solid ${banner.border}`,
                borderRadius: 14,
                padding: '12px 16px',
                marginBottom: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                boxSizing: 'border-box',
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: banner.dot, flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, color: banner.title, fontWeight: 600 }}>{banner.heading}</span>
                <span style={{ fontSize: 11, color: banner.body }}>{banner.detail}</span>
              </div>
            </div>
          );
        })()}

        {!isBoardPaired && (
          <div
            onClick={() => navigate('add-board')}
            style={{
              background: '#f8fafc',
              border: '1px dashed #cbd5e1',
              borderRadius: 14,
              padding: '14px 16px',
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
              boxSizing: 'border-box',
            }}
          >
            <span style={{ fontSize: 13, color: '#64748b', fontWeight: 500 }}>
              ยังไม่มีอุปกรณ์ที่เชื่อมต่อ
            </span>
            <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>
              เพิ่มอุปกรณ์ ›
            </span>
          </div>
        )}

        {/* TAB 1: คุณภาพน้ำพร้อมกราฟเส้นเล็ก */}
        {activeTab === 'quality' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2, padding: '0 2px' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>ค่าตรวจวัดคุณภาพน้ำ</span>
              <StatusBadge status={telemetryFreshness} />
            </div>

            {isDemoBoard && FEATURES.showDemoBoardLabels && <DemoBoardBadge />}

            {([
              { key: 'ph', label: 'ค่ากรด-ด่าง (pH)', value: data.current.pH, digits: 2, unit: '', min: targets.phMin, max: targets.phMax, scale: 14, color: '#059669', rangeText: `${targets.phMin.toFixed(1)} - ${targets.phMax.toFixed(1)}` },
              { key: 'ec', label: 'การนำไฟฟ้า (EC)', value: data.current.ec, digits: 2, unit: 'mS', min: targets.ecMin, max: targets.ecMax, scale: 3, color: '#0284c7', rangeText: `${targets.ecMin.toFixed(1)} - ${targets.ecMax.toFixed(1)} mS/cm` },
              { key: 'tds', label: 'สารละลายรวม (TDS)', value: data.current.tds, digits: 0, unit: 'ppm', min: Math.round(targets.ecMin * 500), max: Math.round(targets.ecMax * 500), scale: 1500, color: '#6366f1', rangeText: `${Math.round(targets.ecMin * 500)} - ${Math.round(targets.ecMax * 500)} ppm` },
              { key: 'temp', label: 'อุณหภูมิน้ำ (Water Temp)', value: data.current.tempC, digits: 1, unit: '°C', min: targets.tempMin, max: targets.tempMax, scale: 40, color: '#059669', rangeText: `${targets.tempMin.toFixed(1)} - ${targets.tempMax.toFixed(1)} °C` },
            ]).map((m) => {
              // Offline / no data / loading -> `--`. Stale -> value with amber hint.
              const showValue =
                (telemetryFreshness === 'live' || telemetryFreshness === 'stale') &&
                typeof m.value === 'number' &&
                Number.isFinite(m.value);
              const v = showValue ? (m.value as number) : null;
              const outOfRange = v !== null && (v < m.min || v > m.max);
              const isStale = telemetryFreshness === 'stale';
              const isOffline = telemetryFreshness === 'offline';
              const hint = isOffline
                ? 'อุปกรณ์ออฟไลน์'
                : isStale
                ? 'ข้อมูลเริ่มเก่า (เกิน 75 วินาที)'
                : showValue
                ? null
                : telemetryFreshness === 'live'
                ? 'อุปกรณ์ไม่ได้ส่งค่านี้ (เซนเซอร์ไม่พร้อม)'
                : null;
              return (
                <div
                  key={m.key}
                  style={{
                    background: '#ffffff',
                    border: `1px solid ${isStale ? '#fde68a' : outOfRange ? '#fecdd3' : '#e2e8f0'}`,
                    borderRadius: 16,
                    padding: '16px',
                    boxSizing: 'border-box',
                    opacity: isOffline ? 0.6 : 1,
                    filter: isOffline ? 'grayscale(1)' : 'none',
                    transition: 'opacity 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}>{m.label}</span>
                    <span
                      style={{
                        fontSize: 24,
                        fontWeight: 600,
                        color: v === null ? '#94a3b8' : outOfRange ? '#dc2626' : isStale ? '#92400e' : '#0f172a',
                        fontVariantNumeric: 'tabular-nums',
                        minWidth: 90,
                        textAlign: 'right',
                      }}
                    >
                      {v === null ? '--' : `${m.digits === 0 ? Math.round(v) : v.toFixed(m.digits)}${m.unit ? ` ${m.unit}` : ''}`}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: isStale ? '#92400e' : '#94a3b8', marginTop: 4, minHeight: 15 }}>
                    {hint ? `${hint} | ` : ''}ช่วงเป้าหมาย: {m.rangeText}
                  </div>
                  <div style={{ height: 4, width: '100%', background: '#f1f5f9', borderRadius: 2, marginTop: 12, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${v === null ? 0 : Math.max(0, Math.min(100, (v / m.scale) * 100))}%`,
                        height: '100%',
                        background: isStale ? '#f59e0b' : outOfRange ? '#dc2626' : m.color,
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })}

            {/* ── ระบบเรียนรู้วงจรการกินน้ำ-กินปุ๋ยตามช่วงเวลาแดด (Diurnal Rhythm & Anomaly Predictor) ── */}
            <div
              style={{
                background: '#ffffff',
                borderRadius: 18,
                border: '1px solid #e2e8f0',
                padding: '16px',
                marginTop: 6,
                boxShadow: '0 2px 10px -2px rgba(15, 23, 42, 0.04)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 10,
                      background: '#ecfdf5',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#059669',
                    }}
                  >
                    <Activity size={18} strokeWidth={2.2} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>วงจรการกินปุ๋ย & คายน้ำตามรอบแดด</span>
                      <span
                        style={{
                          fontSize: 9.5,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: '#f1f5f9',
                          color: '#475569',
                          fontWeight: 600,
                        }}
                      >
                        วิเคราะห์ตามช่วงเวลา
                      </span>
                    </div>
                    <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
                      วิเคราะห์พฤติกรรมการดูดซึมสารอาหารเทียบกับช่วงเวลาแดดจริง
                    </p>
                  </div>
                </div>
              </div>

              {/* Phase Matrix: 4 ช่วงเวลาใน 24 ชั่วโมง */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                {(Object.keys(DIURNAL_PHASES) as DiurnalPhaseKey[]).map((phaseKey) => {
                  const p = DIURNAL_PHASES[phaseKey];
                  const isActive = diurnalMetrics.currentPhase.key === phaseKey;

                  return (
                    <div
                      key={phaseKey}
                      style={{
                        padding: '10px 10px 8px',
                        borderRadius: 12,
                        background: isActive ? p.badgeBg : '#f8fafc',
                        border: `1.5px solid ${isActive ? p.badgeBorder : '#f1f5f9'}`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        position: 'relative',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: isActive ? p.badgeColor : '#475569' }}>
                          {p.iconName === 'sunrise' && <Sunrise size={13} />}
                          {p.iconName === 'sun' && <Sun size={13} />}
                          {p.iconName === 'sunset' && <Sunset size={13} />}
                          {p.iconName === 'moon' && <Moon size={13} />}
                          <span>{p.shortLabel}</span>
                        </div>
                        {isActive && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              color: '#059669',
                              background: '#ffffff',
                              padding: '1px 5px',
                              borderRadius: 4,
                              border: '1px solid #d1fae5',
                            }}
                          >
                            ช่วงปัจจุบัน
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: 10, color: '#64748b' }}>{p.timeRange}</span>
                    </div>
                  );
                })}
              </div>

              {/* อัตราการกินปุ๋ยและใช้น้ำในเฟสปัจจุบัน */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr',
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    background: '#f8fafc',
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid #f1f5f9',
                  }}
                >
                  <span style={{ fontSize: 10.5, color: '#64748b', display: 'block', marginBottom: 2 }}>
                    อัตรากินปุ๋ย (EC Rate)
                  </span>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: diurnalMetrics.ecConsumptionRatePerHour === null ? '#94a3b8' : '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                      {diurnalMetrics.ecConsumptionRatePerHour === null || diurnalMetrics.dataPointsCount < 2
                        ? '--'
                        : diurnalMetrics.ecConsumptionRatePerHour > 0
                        ? `~${diurnalMetrics.ecConsumptionRatePerHour}`
                        : 'เสถียร'}
                    </span>
                    <span style={{ fontSize: 10.5, color: '#64748b' }}>mS/ชม.</span>
                  </div>
                </div>

              </div>

              {/* พฤติกรรมที่คาดหมาย & คำแนะนำตามช่วงเวลา */}
              <div
                style={{
                  background: diurnalMetrics.anomalyDetected
                    ? (diurnalMetrics.anomalySeverity === 'danger' ? '#fef2f2' : '#fffbeb')
                    : '#f0fdf4',
                  border: `1px solid ${
                    diurnalMetrics.anomalyDetected
                      ? (diurnalMetrics.anomalySeverity === 'danger' ? '#fecaca' : '#fde68a')
                      : '#d1fae5'
                  }`,
                  borderRadius: 12,
                  padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  {diurnalMetrics.anomalyDetected ? (
                    <AlertTriangle size={14} className={diurnalMetrics.anomalySeverity === 'danger' ? 'text-rose-600' : 'text-amber-600'} />
                  ) : (
                    <Sparkles size={14} className="text-emerald-600" />
                  )}
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      color: diurnalMetrics.anomalyDetected
                        ? (diurnalMetrics.anomalySeverity === 'danger' ? '#991b1b' : '#92400e')
                        : '#15803d',
                    }}
                  >
                    {diurnalMetrics.briefingHeadline}
                  </span>
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 11.5,
                    color: diurnalMetrics.anomalyDetected
                      ? (diurnalMetrics.anomalySeverity === 'danger' ? '#991b1b' : '#78350f')
                      : '#166534',
                    lineHeight: 1.45,
                  }}
                >
                  {diurnalMetrics.detailedAnalysis || diurnalMetrics.currentPhase.plantAdvice}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: ระดับของเหลวและระบบเติมสารละลายเสมือน */}
        {activeTab === 'levels' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Header with Quick Refill button */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '2px 0',
                boxSizing: 'border-box',
              }}
            >
              <div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
                  การตรวจสอบระดับของเหลว
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
                  {enableDosingTracking
                    ? 'เปิดระบบประมาณการสารละลายคงเหลือ (Soft Sensor)'
                    : 'โหมดเรียบง่าย: ตรวจวัดระดับน้ำหลักด้วยสวิตช์ลูกลอยจริง'}
                </p>
              </div>

              {enableDosingTracking && (
                <button
                  type="button"
                  onClick={() => openRefillModal('fertA')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 12px',
                    borderRadius: 10,
                    background: '#ecfdf5',
                    color: '#059669',
                    border: '1px solid rgba(5, 150, 105, 0.3)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                  }}
                >
                  <Plus size={15} strokeWidth={2.2} />
                  <span>เติมสารละลาย</span>
                </button>
              )}
            </div>

            {/* 1. ถังน้ำสารละลายหลัก (มีเซนเซอร์ลูกลอยจริง) */}
            <div
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 18,
                padding: '16px 18px',
                boxSizing: 'border-box',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a' }}>ถังน้ำสารละลายหลัก</span>
                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#f0fdf4', color: '#166534', fontWeight: 600, border: '1px solid #bbf7d0' }}>
                      สวิตช์ลูกลอยจริง
                    </span>
                  </div>
                  <p style={{ margin: '3px 0 0', fontSize: 11.5, color: '#64748b' }}>
                    ถังน้ำวนหลักสำหรับระบบรากพืช (ตรวจจับด้วยฮาร์ดแวร์จริง)
                  </p>
                </div>
                {(() => {
                  const reporting = isConnected && (telemetryFreshness === 'live' || telemetryFreshness === 'stale');
                  const ok = reporting ? data.levels.mainTankOk : null;
                  return (
                    <span
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: ok === true ? '#059669' : ok === false ? '#dc2626' : '#94a3b8',
                        background: ok === true ? '#ecfdf5' : ok === false ? '#fef2f2' : '#f8fafc',
                        padding: '6px 12px',
                        borderRadius: 10,
                        minWidth: 64,
                        textAlign: 'center',
                      }}
                    >
                      {mainTankStatusLabel(ok)}
                    </span>
                  );
                })()}
              </div>
            </div>

            {/* 2. สวิตช์ควบคุม: โหมดติดตามปริมาณสารละลายคงเหลือ (Smart Dosing Tracker) */}
            <div
              style={{
                background: enableDosingTracking ? '#f0fdf4' : '#ffffff',
                border: enableDosingTracking ? '1.5px solid #86efac' : '1px solid #e2e8f0',
                borderRadius: 18,
                padding: '14px 16px',
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                transition: 'all 0.25s ease',
                boxShadow: enableDosingTracking ? '0 4px 16px -2px rgba(34, 197, 94, 0.12)' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    background: enableDosingTracking ? '#dcfce7' : '#f1f5f9',
                    color: enableDosingTracking ? '#16a34a' : '#64748b',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <Sparkles size={18} strokeWidth={2} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>
                    ติดตามปริมาณสารละลายคงเหลือ
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: enableDosingTracking ? '#bbf7d0' : '#e2e8f0',
                      color: enableDosingTracking ? '#15803d' : '#475569',
                      fontWeight: 600,
                    }}
                  >
                    Soft Sensor
                  </span>
                  <button
                    type="button"
                    onClick={() => showAlert({
                      title: 'ระบบประมาณการสารละลาย (Soft Sensor)',
                      message:
                        'ถังสารเคมี (ปุ๋ย A, B, กรด, ด่าง) ไม่มีเซนเซอร์วัดระดับ แอปจึงคำนวณปริมาณคงเหลือ = ปริมาณที่บันทึกตอนเติมล่าสุด − (เวลาที่ปั๊มทำงานหลังเติม × อัตราไหลของปั๊ม)\n\n' +
                        'เวลาทำงานของปั๊มมาจากตัวนับในอุปกรณ์ จึงนับครบทั้งการกดจ่ายเองและโหมด AUTO แม้ตอนปิดแอป\n\n' +
                        'ขั้นตอน: 1) วัดอัตราไหลของแต่ละปั๊มครั้งเดียว 2) บันทึกทุกครั้งที่เติม\n' +
                        'ข้อมูลเก็บใน ThingsBoard ใช้ร่วมกันทุกเครื่องของคุณ',
                      variant: 'info'
                    })}
                    aria-label="ข้อมูลเพิ่มเติมเกี่ยวกับระบบประมาณการ"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#64748b',
                      borderRadius: '50%',
                    }}
                  >
                    <Info size={16} />
                  </button>
                </div>
              </div>

              {/* Apple-style Switch Toggle */}
              <button
                type="button"
                onClick={handleToggleDosingTracking}
                aria-label="สลับโหมดคำนวณสารละลาย"
                style={{
                  width: 50,
                  height: 28,
                  borderRadius: 9999,
                  background: enableDosingTracking ? '#16a34a' : '#cbd5e1',
                  border: 'none',
                  cursor: 'pointer',
                  position: 'relative',
                  padding: 2,
                  boxSizing: 'border-box',
                  transition: 'background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: '#ffffff',
                    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
                    transform: enableDosingTracking ? 'translateX(22px)' : 'translateX(0px)',
                    transition: 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                />
              </button>
            </div>

            {/* 3. ส่วนแสดงผลตามสถานะสวิตช์ */}
            {!enableDosingTracking ? (
              /* โหมดเรียบง่าย (Casual Minimalist Mode) */
              <div
                style={{
                  background: '#f8fafc',
                  border: '1px dashed #cbd5e1',
                  borderRadius: 18,
                  padding: '24px 18px',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 14,
                    background: '#ecfdf5',
                    color: '#059669',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 4,
                  }}
                >
                  <CheckCircle2 size={24} strokeWidth={2} />
                </div>
                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
                  โหมดเรียบง่าย (Casual Mode) กำลังทำงาน
                </h4>
                <p style={{ margin: 0, fontSize: 12, color: '#64748b', maxWidth: 310, lineHeight: 1.5 }}>
                  ตรวจวัดระดับน้ำหลักด้วยสวิตช์ลูกลอยจริง โดยไม่ต้องบันทึกหรือคำนวณปริมาณขวดปุ๋ย
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 2. ถังแม่ปุ๋ย A */}
            {(() => {
              const { pct, isLow, level } = getTankLevel('fertA');
              return (
                <div
                  onClick={() => openTankAction('fertA')}
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 16,
                    padding: '16px',
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>ถังแม่ปุ๋ย A</span>
                        {isLow ? (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef2f2', color: '#b91c1c', fontWeight: 600 }}>
                            สารละลายใกล้หมด
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#ecfdf5', color: '#059669', fontWeight: 500 }}>
                            {level.status === 'ok' ? 'ระดับปกติ' : 'ยังไม่ทราบระดับ'}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
                        {tankStatusText(level)}
                      </p>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 20, fontWeight: 700, color: isLow ? '#dc2626' : '#059669', fontFamily: 'monospace' }}>
                        {pct !== null ? `${pct}%` : '--'}
                      </span>
                    </div>
                  </div>

                  <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${pct ?? 0}%`,
                        background: isLow ? '#dc2626' : '#059669',
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* 3. ถังแม่ปุ๋ย B */}
            {(() => {
              const { pct, isLow, level } = getTankLevel('fertB');
              return (
                <div
                  onClick={() => openTankAction('fertB')}
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 16,
                    padding: '16px',
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>ถังแม่ปุ๋ย B</span>
                        {isLow ? (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef2f2', color: '#b91c1c', fontWeight: 600 }}>
                            สารละลายใกล้หมด
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#eef2ff', color: '#4f46e5', fontWeight: 500 }}>
                            {level.status === 'ok' ? 'ระดับปกติ' : 'ยังไม่ทราบระดับ'}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
                        {tankStatusText(level)}
                      </p>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 20, fontWeight: 700, color: isLow ? '#dc2626' : '#6366f1', fontFamily: 'monospace' }}>
                        {pct !== null ? `${pct}%` : '--'}
                      </span>
                    </div>
                  </div>

                  <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${pct ?? 0}%`,
                        background: isLow ? '#dc2626' : '#6366f1',
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* 4. ถังสารลด pH (กรด) */}
            {(() => {
              const { pct, isLow, level } = getTankLevel('phDown');
              return (
                <div
                  onClick={() => openTankAction('phDown')}
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 16,
                    padding: '16px',
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>ถังสารลด pH (กรด)</span>
                        {isLow ? (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef2f2', color: '#b91c1c', fontWeight: 600 }}>
                            สารละลายใกล้หมด
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fffbeb', color: '#b45309', fontWeight: 500 }}>
                            {level.status === 'ok' ? 'ระดับปกติ' : 'ยังไม่ทราบระดับ'}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
                        {tankStatusText(level)}
                      </p>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 20, fontWeight: 700, color: isLow ? '#dc2626' : '#d97706', fontFamily: 'monospace' }}>
                        {pct !== null ? `${pct}%` : '--'}
                      </span>
                    </div>
                  </div>

                  <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${pct ?? 0}%`,
                        background: isLow ? '#dc2626' : '#d97706',
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* 5. ถังสารเพิ่ม pH (ด่าง/เบส) */}
            {(() => {
              const { pct, isLow, level } = getTankLevel('phUp');
              return (
                <div
                  onClick={() => openTankAction('phUp')}
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 16,
                    padding: '16px',
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>ถังสารเพิ่ม pH (ด่าง/เบส)</span>
                        {isLow ? (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef2f2', color: '#b91c1c', fontWeight: 600 }}>
                            สารละลายใกล้หมด
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#f0fdfa', color: '#0f766e', fontWeight: 500 }}>
                            {level.status === 'ok' ? 'ระดับปกติ' : 'ยังไม่ทราบระดับ'}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
                        {tankStatusText(level)}
                      </p>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 20, fontWeight: 700, color: isLow ? '#dc2626' : '#0d9488', fontFamily: 'monospace' }}>
                        {pct !== null ? `${pct}%` : '--'}
                      </span>
                    </div>
                  </div>

                  <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${pct ?? 0}%`,
                        background: isLow ? '#dc2626' : '#0d9488',
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })()}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: ควบคุมปั๊ม & การจ่ายสารละลาย (รวมระบบ AUTO และ MANUAL เข้าด้วยกัน) */}
        {activeTab === 'pumps' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Control mode switch */}
            <div
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 16,
                padding: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                boxSizing: 'border-box',
              }}
            >
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: 0 }}>โหมดการทำงานของปั๊ม</p>
                <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>
                  {pendingMode
                    ? `กำลังส่งคำสั่งเปลี่ยนเป็น ${pendingMode}...`
                    : data.pumps.controlMode === null
                    ? 'อุปกรณ์ยังไม่รายงานโหมด (--)'
                    : isAutoMode
                    ? 'ระบบปรับสารละลายอัตโนมัติ (Auto Mode)'
                    : 'ควบคุมด้วยตนเอง (Manual Mode)'}
                </p>
              </div>

              <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', padding: 3, borderRadius: 10, boxSizing: 'border-box' }}>
                <button
                  type="button"
                  onClick={() => handleSetMode('AUTO')}
                  disabled={!isOnline || Boolean(pendingMode)}
                  aria-busy={pendingMode === 'AUTO'}
                  style={{
                    minHeight: 44,
                    minWidth: 76,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    opacity: !isOnline ? 0.5 : 1,
                    padding: '6px 14px',
                    borderRadius: 8,
                    border: 'none',
                    fontSize: 12,
                    fontWeight: isAutoMode ? 600 : 400,
                    background: isAutoMode ? '#059669' : 'transparent',
                    color: isAutoMode ? '#ffffff' : '#64748b',
                    cursor: !isOnline || pendingMode ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {pendingMode === 'AUTO' && <Loader2 size={13} className="animate-spin" />}
                  AUTO
                </button>
                <button
                  type="button"
                  onClick={() => handleSetMode('MANUAL')}
                  disabled={!isOnline || Boolean(pendingMode)}
                  aria-busy={pendingMode === 'MANUAL'}
                  style={{
                    minHeight: 44,
                    minWidth: 76,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    opacity: !isOnline ? 0.5 : 1,
                    padding: '6px 14px',
                    borderRadius: 8,
                    border: 'none',
                    fontSize: 12,
                    fontWeight: !isAutoMode ? 600 : 400,
                    background: !isAutoMode ? '#0f172a' : 'transparent',
                    color: !isAutoMode ? '#ffffff' : '#64748b',
                    cursor: !isOnline || pendingMode ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {pendingMode === 'MANUAL' && <Loader2 size={13} className="animate-spin" />}
                  MANUAL
                </button>
              </div>
            </div>

            {/* View 1: When in AUTO Mode -> Show Automated Dosing Dashboard */}
            {isAutoMode ? (
              <>
                {/* Auto Status Notice Banner */}
                <div
                  style={{
                    background: isOnline ? '#ecfdf5' : '#fffbeb',
                    border: `1px solid ${isOnline ? '#bbf7d0' : '#fde68a'}`,
                    borderRadius: 14,
                    padding: '12px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  {isOnline ? (
                    <>
                      <CheckCircle size={18} color="#059669" style={{ flexShrink: 0 }} />
                      <div>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#065f46' }}>
                          โหมดอัตโนมัติ: อุปกรณ์ตรวจวัดและจ่ายสารเคมีเอง
                        </p>
                        <p style={{ margin: '2px 0 0', fontSize: 11, color: '#047857' }}>
                          ทุก 5 นาที เมื่อเซนเซอร์พร้อม: pH เกินเกณฑ์จ่ายสารปรับ 2 วินาที, EC ต่ำจ่ายปุ๋ย A และ B อย่างละ 2 วินาที แล้วรอผสม 5 นาที
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <AlertCircle size={18} color="#b45309" style={{ flexShrink: 0 }} />
                      <div>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#92400e' }}>
                          อุปกรณ์ไม่ได้ส่งข้อมูลสด
                        </p>
                        <p style={{ margin: '2px 0 0', fontSize: 11, color: '#b45309' }}>
                          แอปไม่ทราบสถานะล่าสุดของอุปกรณ์ จึงล็อกการสั่งงานจนกว่าข้อมูลจะกลับมาสด
                        </p>
                      </div>
                    </>
                  )}
                </div>

                {/* AUTO กำลังทำงาน: แสดงเฉพาะตอนอุปกรณ์รายงานรอบจ่ายสาร (ว่าง = ไม่แสดงอะไร) */}
                {isOnline && autoCycle && autoCycle.phase !== 'idle' && (() => {
                  const names: Record<PumpKey, string> = {
                    phDownPumpOn: 'ปั๊มลด pH',
                    phUpPumpOn: 'ปั๊มเพิ่ม pH',
                    fertPumpAOn: 'ปั๊มปุ๋ย A',
                    fertPumpBOn: 'ปั๊มปุ๋ย B',
                    mainPumpOn: 'ปั๊มน้ำหมุนเวียน',
                  };
                  const mixLeft =
                    autoCycle.phase === 'mixing' && typeof autoCycle.mixEndsAt === 'number'
                      ? Math.max(0, Math.ceil((autoCycle.mixEndsAt - clockMs) / 1000))
                      : null;
                  return (
                    <div style={{ background: '#ffffff', border: '1px solid #bbf7d0', borderRadius: 16, padding: '16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#059669', flexShrink: 0 }} />
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#065f46' }}>
                          {autoCycle.phase === 'dosing' ? 'ระบบอัตโนมัติกำลังจ่ายสาร' : 'ระบบอัตโนมัติกำลังผสมสาร'}
                        </p>
                      </div>
                      <p style={{ margin: '0 0 12px', fontSize: 11, color: '#64748b' }}>
                        {autoCycle.reason ? `สาเหตุ: ${autoCycle.reason}` : 'ค่าน้ำหลุดช่วงเป้าหมาย'}
                        {mixLeft !== null && ` · รอผสมอีก ${Math.floor(mixLeft / 60)}:${String(mixLeft % 60).padStart(2, '0')}`}
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {autoCycle.pumps.map((k) => {
                          const running = data.pumps[k] === true;
                          const label = running ? 'กำลังทำงาน' : autoCycle.phase === 'mixing' ? 'จ่ายแล้ว' : 'อยู่ในรอบนี้';
                          return (
                            <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                              <span style={{ fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{names[k]}</span>
                              <span
                                style={{
                                  minHeight: 32,
                                  minWidth: 96,
                                  padding: '6px 12px',
                                  borderRadius: 10,
                                  fontSize: 12,
                                  fontWeight: 600,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  background: running ? '#059669' : '#ecfdf5',
                                  color: running ? '#ffffff' : '#047857',
                                }}
                              >
                                {label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Main Circulation Pump Card (Controllable in AUTO mode) */}
                <div
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 16,
                    padding: '16px',
                  }}
                >
                  {renderPumpRow('mainPumpOn', 0, 'ปั๊มน้ำหมุนเวียนหลัก (น้ำวน)', 'Main Circulation Pump', '#ecfdf5', '#059669')}
                </div>

                {/* Fertilizer Levels Summary (Mother Tanks A & B) - Only shown when Smart Dosing Tracker is active */}
                {enableDosingTracking && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                    {/* Fert A */}
                    {(() => {
                      const { pct, isLow } = getTankLevel('fertA');
                      return (
                        <div
                          onClick={() => setActiveTab('levels')}
                          style={{
                            background: '#ffffff',
                            border: '1px solid #e2e8f0',
                            borderRadius: 16,
                            padding: '16px',
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: '#475569' }}>แม่ปุ๋ย A</span>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: !isLow ? '#059669' : '#d97706',
                                background: !isLow ? '#ecfdf5' : '#fffbeb',
                                padding: '2px 6px',
                                borderRadius: 4,
                              }}
                            >
                              {pct === null ? 'ประมาณการ' : !isLow ? 'ประมาณการ: ปกติ' : 'ประมาณการ: เหลือน้อย'}
                            </span>
                          </div>
                          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>
                            {pct !== null ? `${pct}%` : '--'}
                          </div>
                          <div style={{ width: '100%', height: 6, background: '#f1f5f9', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
                            <div
                              style={{
                                width: `${Math.min(100, Math.max(0, pct ?? 0))}%`,
                                height: '100%',
                                background: '#059669',
                                borderRadius: 3,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {/* Fert B */}
                    {(() => {
                      const { pct, isLow } = getTankLevel('fertB');
                      return (
                        <div
                          onClick={() => setActiveTab('levels')}
                          style={{
                            background: '#ffffff',
                            border: '1px solid #e2e8f0',
                            borderRadius: 16,
                            padding: '16px',
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: '#475569' }}>แม่ปุ๋ย B</span>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: !isLow ? '#059669' : '#d97706',
                                background: !isLow ? '#ecfdf5' : '#fffbeb',
                                padding: '2px 6px',
                                borderRadius: 4,
                              }}
                            >
                              {pct === null ? 'ประมาณการ' : !isLow ? 'ประมาณการ: ปกติ' : 'ประมาณการ: เหลือน้อย'}
                            </span>
                          </div>
                          <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>
                            {pct !== null ? `${pct}%` : '--'}
                          </div>
                          <div style={{ width: '100%', height: 6, background: '#f1f5f9', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
                            <div
                              style={{
                                width: `${Math.min(100, Math.max(0, pct ?? 0))}%`,
                                height: '100%',
                                background: '#0284c7',
                                borderRadius: 3,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* 5-Step Automated Dosing Process Card */}
                <div
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 16,
                    padding: '18px 16px',
                  }}
                >
                  <h3 style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 14px' }}>
                    ขั้นตอนการทำงานของระบบปรับสารละลายอัตโนมัติ
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {[
                      { step: 1, title: 'เซนเซอร์วัดคุณภาพน้ำ (Sensors)', sub: 'pH, EC, อุณหภูมิ และลูกลอยถังหลัก' },
                      { step: 2, title: 'ประมวลผลบนอุปกรณ์ (Controller)', sub: 'ชิปประมวลผลตรวจสอบค่าเทียบกับช่วงเป้าหมาย' },
                      { step: 3, title: 'ตัดสินใจจ่ายสารละลาย (Dosing Decision)', sub: 'ทุก 5 นาที เทียบกับช่วงเป้าหมาย ไม่จ่ายเมื่อเซนเซอร์ไม่พร้อมหรือถังหลักน้ำต่ำ' },
                      { step: 4, title: 'สั่งการปั๊มสารเคมี (Dosing Pumps)', sub: 'จ่ายครั้งละ 2 วินาที แล้วรอผสม 5 นาทีก่อนประเมินใหม่' },
                      { step: 5, title: 'หมุนเวียนในถังน้ำหลัก (Circulation)', sub: 'ปั๊มน้ำหลักกระจายสารอาหารสู่ระบบรากพืช' },
                    ].map((st) => (
                      <div key={st.step} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            background: '#ecfdf5',
                            color: '#059669',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 11,
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          {st.step}
                        </div>
                        <div>
                          <p style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', margin: 0 }}>
                            {st.title}
                          </p>
                          <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0', lineHeight: 1.4 }}>
                            {st.sub}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Helpful note to switch to MANUAL */}
                <div
                  style={{
                    background: '#f8fafc',
                    borderRadius: 12,
                    padding: '12px 14px',
                    border: '1px solid #e2e8f0',
                    fontSize: 11,
                    color: '#64748b',
                    lineHeight: 1.5,
                    textAlign: 'center',
                  }}
                >
                  หากต้องการสั่งจ่ายปุ๋ยหรือปรับกรด-ด่างด้วยตนเอง กรุณากดสลับเป็นปุ่ม <strong>MANUAL</strong> ด้านบน
                </div>
              </>
            ) : (
              /* View 2: When in MANUAL Mode -> Show Full Manual Pump Controls */
              <>
                {/* Manual Mode Notice Banner */}
                <div
                  style={{
                    background: '#ecfdf5',
                    border: '1px solid #d1fae5',
                    borderRadius: 14,
                    padding: '12px 14px',
                    display: 'flex',
                    gap: 10,
                    alignItems: 'flex-start',
                    boxSizing: 'border-box',
                  }}
                >
                  <Unlock size={18} color="#059669" style={{ marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: '#065f46' }}>
                      โหมด MANUAL: ปลดล็อกการควบคุมปั๊มสารเคมี
                    </p>
                    <p style={{ margin: '4px 0 0', fontSize: 11, color: '#047857', lineHeight: 1.45 }}>
                      สามารถกดสั่งปั๊มสารเคมีได้ คำสั่งจะส่งไปยังอุปกรณ์เพื่อทำงานรอบละ 5 วินาที (สูงสุด 10 วินาที) สถานะปุ่มอ่านจากรีเลย์จริงที่อุปกรณ์รายงานกลับมา
                    </p>
                  </div>
                </div>

                {commandError && (
                  <div
                    style={{
                      padding: '10px 14px',
                      background: '#fef2f2',
                      border: '1px solid #fecaca',
                      borderRadius: 12,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      color: '#991b1b',
                      fontSize: 12,
                      fontWeight: 500,
                    }}
                  >
                    <span>{commandError}</span>
                    <button
                      type="button"
                      onClick={clearCommandError}
                      aria-label="ปิดข้อความ"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#991b1b',
                        cursor: 'pointer',
                        minWidth: 44,
                        minHeight: 44,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}

                {/* List of 5 Pumps with Action Buttons */}
                <div
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 16,
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    boxSizing: 'border-box',
                  }}
                >
                  {renderPumpRow('mainPumpOn', 1, 'ปั๊มน้ำหมุนเวียนหลัก', 'Main Circulation Pump (น้ำวน)', '#ecfdf5', '#059669')}
                  <div style={{ height: 1, background: '#f1f5f9' }} />
                  {renderPumpRow('phDownPumpOn', 2, 'ปั๊มสารลด pH (กรด)', 'pH Down Pump (ปรับลด pH)', '#fef3c7', '#d97706')}
                  <div style={{ height: 1, background: '#f1f5f9' }} />
                  {renderPumpRow('phUpPumpOn', 3, 'ปั๊มสารเพิ่ม pH (ด่าง/เบส)', 'pH Up Pump (ปรับเพิ่ม pH)', '#f0fdfa', '#0d9488')}
                  <div style={{ height: 1, background: '#f1f5f9' }} />
                  {renderPumpRow('fertPumpAOn', 4, 'ปั๊มแม่ปุ๋ย A', 'Fertilizer Pump A', '#ecfdf5', '#059669')}
                  <div style={{ height: 1, background: '#f1f5f9' }} />
                  {renderPumpRow('fertPumpBOn', 5, 'ปั๊มแม่ปุ๋ย B', 'Fertilizer Pump B', '#ecfdf5', '#059669')}
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 4: ตั้งค่าเป้าหมาย (min-max) */}
        {activeTab === 'targets' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Quick Plant Preset & Research Sync Banner (เฉพาะเมื่อมีอุปกรณ์เชื่อมต่อ) */}
            {connectedBoardId && (
              <div
                onClick={() => navigate('setup-farm')}
                style={{
                  background: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  borderRadius: 16,
                  padding: '14px 16px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: '#ffffff',
                      border: '1px solid #dcfce7',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#059669',
                      flexShrink: 0,
                    }}
                  >
                    <Sprout size={20} strokeWidth={2} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#166534' }}>
                      พืชที่ปลูก: {data.plantType || 'ยังไม่ได้ระบุ'}
                    </div>
                    <div style={{ fontSize: 11, color: '#15803d', marginTop: 1 }}>
                      แตะเพื่อเปลี่ยนชนิดพืช / ใช้ค่าแนะนำจากฐานข้อมูลพืชในแอป
                    </div>
                  </div>
                </div>
                <ChevronRight size={18} className="text-emerald-700 shrink-0" />
              </div>
            )}

            <div
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 16,
                padding: '16px',
                boxSizing: 'border-box',
              }}
            >
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 16px' }}>
                ช่วงเป้าหมายค่ากรด-ด่าง (pH)
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>
                    ต่ำสุด (Min)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={phMin}
                    onChange={(e) => setPhMin(parseFloat(e.target.value) || 0)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: '1px solid #cbd5e1',
                      fontSize: 14,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>
                    สูงสุด (Max)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={phMax}
                    onChange={(e) => setPhMax(parseFloat(e.target.value) || 0)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: '1px solid #cbd5e1',
                      fontSize: 14,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
            </div>

            <div
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 16,
                padding: '16px',
                boxSizing: 'border-box',
              }}
            >
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: '0 0 16px' }}>
                ช่วงเป้าหมายการนำไฟฟ้า (EC)
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>
                    ต่ำสุด (Min)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={ecMin}
                    onChange={(e) => setEcMin(parseFloat(e.target.value) || 0)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: '1px solid #cbd5e1',
                      fontSize: 14,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>
                    สูงสุด (Max)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={ecMax}
                    onChange={(e) => setEcMax(parseFloat(e.target.value) || 0)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: '1px solid #cbd5e1',
                      fontSize: 14,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleSaveTargets}
              style={{
                width: '100%',
                padding: '13px',
                borderRadius: 12,
                background: '#059669',
                color: '#ffffff',
                border: 'none',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {isSaved ? 'บันทึกเป้าหมายแล้ว' : 'บันทึกการตั้งค่าเป้าหมาย'}
            </button>
          </div>
        )}
      </div>

      {/* ── Modal บันทึกการเติมสารละลายเข้าถัง ── */}
      {calibrationTank && (
        <PumpFlowCalibrationModal
          tankKey={calibrationTank}
          tankLabel={tankDisplayNames[calibrationTank].name}
          onClose={() => setCalibrationTank(null)}
        />
      )}

      {isRefillModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.6)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            boxSizing: 'border-box',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
          onClick={() => setIsRefillModalOpen(false)}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: 22,
              width: '100%',
              maxWidth: 390,
              maxHeight: '92vh',
              overflowY: 'auto',
              padding: '20px 18px',
              boxSizing: 'border-box',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    background: '#ecfdf5',
                    color: '#059669',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Plus size={20} strokeWidth={2.5} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
                    บันทึกการเติมสารละลาย
                  </h3>
                  <p style={{ margin: '1px 0 0', fontSize: 11, color: '#64748b' }}>
                    คำนวณและปรับระดับของเหลวในระบบ
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsRefillModalOpen(false)}
                style={{
                  background: '#f1f5f9',
                  border: 'none',
                  borderRadius: '50%',
                  width: 32,
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  color: '#64748b',
                  flexShrink: 0,
                }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Safety Warning */}
            <div
              style={{
                background: '#fffbeb',
                border: '1px solid #fef3c7',
                borderRadius: 12,
                padding: '10px 12px',
                marginBottom: 14,
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                boxSizing: 'border-box',
              }}
            >
              <AlertTriangle size={16} color="#d97706" style={{ marginTop: 2, flexShrink: 0 }} />
              <p style={{ margin: 0, fontSize: 11, color: '#92400e', lineHeight: 1.45 }}>
                ความปลอดภัยสำคัญ: ตรวจสอบถังและสารเคมีให้ตรงกัน ห้ามเติมสลับถังเด็ดขาด เพื่อป้องกันความไม่สมดุลของสารอาหารในฟาร์ม
              </p>
            </div>

            {/* Select Tank */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#334155', display: 'block', marginBottom: 6 }}>
                เลือกถังสารละลาย
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, boxSizing: 'border-box' }}>
                {(['fertA', 'fertB', 'phDown', 'phUp'] as SolutionTankKey[]).map((tKey) => {
                  const isCur = selectedTank === tKey;
                  const item = tankDisplayNames[tKey];
                  return (
                    <button
                      key={tKey}
                      type="button"
                      onClick={() => handleTankChange(tKey)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: `1.5px solid ${isCur ? item.color : '#e2e8f0'}`,
                        background: isCur ? `${item.color}12` : '#ffffff',
                        textAlign: 'left',
                        cursor: 'pointer',
                        boxSizing: 'border-box',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        minHeight: 52,
                        outline: 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <span style={{ fontSize: 13, fontWeight: isCur ? 700 : 600, color: isCur ? item.color : '#0f172a' }}>
                          {item.shortName}
                        </span>
                        {isCur && <CheckCircle2 size={14} color={item.color} />}
                      </div>
                      <span style={{ fontSize: 10, color: isCur ? item.color : '#64748b', marginTop: 2, opacity: 0.9 }}>
                        {item.chemType}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Refill Amount & Unit */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#334155', margin: 0 }}>
                  ปริมาณสารละลายที่เติม
                </label>
                <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', padding: 2, borderRadius: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (refillUnit === 'L') {
                        setRefillUnit('ml');
                        const val = parseFloat(refillAmount) || 0;
                        setRefillAmount(String(Math.round(val * 1000)));
                      }
                    }}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 6,
                      border: 'none',
                      fontSize: 11,
                      fontWeight: refillUnit === 'ml' ? 700 : 500,
                      background: refillUnit === 'ml' ? '#ffffff' : 'transparent',
                      color: refillUnit === 'ml' ? '#0f172a' : '#64748b',
                      cursor: 'pointer',
                      boxShadow: refillUnit === 'ml' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                    }}
                  >
                    ml
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (refillUnit === 'ml') {
                        setRefillUnit('L');
                        const val = parseFloat(refillAmount) || 0;
                        setRefillAmount((val / 1000).toFixed(2));
                      }
                    }}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 6,
                      border: 'none',
                      fontSize: 11,
                      fontWeight: refillUnit === 'L' ? 700 : 500,
                      background: refillUnit === 'L' ? '#ffffff' : 'transparent',
                      color: refillUnit === 'L' ? '#0f172a' : '#64748b',
                      cursor: 'pointer',
                      boxShadow: refillUnit === 'L' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                    }}
                  >
                    L
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                <input
                  type="number"
                  step={refillUnit === 'L' ? '0.1' : '50'}
                  value={refillAmount}
                  onChange={(e) => setRefillAmount(e.target.value)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '10px 14px',
                    borderRadius: 12,
                    border: '1.5px solid #cbd5e1',
                    fontSize: 16,
                    fontWeight: 600,
                    color: '#0f172a',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                  placeholder={refillUnit === 'L' ? 'เช่น 0.5' : 'เช่น 500'}
                />

                <button
                  type="button"
                  onClick={handleQuickFillMax}
                  style={{
                    padding: '0 14px',
                    borderRadius: 12,
                    background: '#ecfdf5',
                    border: '1px solid #a7f3d0',
                    color: '#059669',
                    fontSize: 12,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                  }}
                >
                  เติมเต็ม 100%
                </button>
              </div>
            </div>

            {/* Tank Capacity */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#334155', display: 'block', marginBottom: 6 }}>
                ความจุถัง (มิลลิลิตร)
              </label>
              <input
                type="number"
                step="100"
                value={tankCapacity}
                onChange={(e) => setTankCapacity(parseInt(e.target.value) || 1000)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 12,
                  border: '1.5px solid #cbd5e1',
                  fontSize: 14,
                  fontWeight: 500,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Refill Calculation Preview */}
            {(() => {
              const { vol: curVol } = getTankLevel(selectedTank);
              const curPct = curVol === null ? 0 : Math.min(100, Math.round((curVol / tankCapacity) * 100));
              const addVol = Math.round(refillUnit === 'L' ? (parseFloat(refillAmount) || 0) * 1000 : (parseFloat(refillAmount) || 0));
              const totalVol = Math.min(tankCapacity, (curVol ?? 0) + addVol);
              const nextPct = Math.round((totalVol / tankCapacity) * 100);

              return (
                <div
                  style={{
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 14,
                    padding: '12px 14px',
                    marginBottom: 16,
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: '#64748b' }}>ก่อนเติม</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: '#475569' }}>{curVol} ml ({curPct}%)</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: '#64748b' }}>ปริมาณที่เพิ่ม</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#0284c7' }}>+{addVol} ml</span>
                  </div>
                  <div style={{ height: 1, background: '#e2e8f0', margin: '6px 0' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a' }}>หลังเติมเสร็จสิ้น</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#059669' }}>
                      {totalVol} / {tankCapacity} ml ({nextPct}%)
                    </span>
                  </div>
                </div>
              );
            })()}

            <button
              type="button"
              onClick={() => {
                setIsRefillModalOpen(false);
                setCalibrationTank(selectedTank);
              }}
              style={{ width: '100%', minHeight: 44, marginBottom: 12, borderRadius: 12, border: '1px dashed #94a3b8', background: '#f8fafc', color: '#334155', fontSize: 12.5, cursor: 'pointer' }}
            >
              {solutionLevels[selectedTank].flowMlPerS !== null
                ? `อัตราไหลปั๊ม ${solutionLevels[selectedTank].flowMlPerS} มล./วินาที · แตะเพื่อวัดใหม่`
                : 'ยังไม่ได้วัดอัตราไหลของปั๊มนี้ · แตะเพื่อวัด'}
            </button>

            {refillFeedback && (
              <div
                style={{
                  background: refillFeedback.startsWith('บันทึกไม่สำเร็จ') ? '#fef2f2' : '#ecfdf5',
                  color: refillFeedback.startsWith('บันทึกไม่สำเร็จ') ? '#b91c1c' : '#059669',
                  padding: '10px',
                  borderRadius: 12,
                  fontSize: 12,
                  fontWeight: 600,
                  textAlign: 'center',
                  marginBottom: 14,
                  boxSizing: 'border-box',
                }}
              >
                {refillFeedback}
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: 10, boxSizing: 'border-box' }}>
              <button
                type="button"
                onClick={() => setIsRefillModalOpen(false)}
                style={{
                  flex: 1,
                  padding: '12px',
                  borderRadius: 14,
                  background: '#f1f5f9',
                  border: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#64748b',
                  cursor: 'pointer',
                }}
              >
                ยกเลิก
              </button>

              <button
                type="button"
                onClick={handleSubmitRefill}
                style={{
                  flex: 2,
                  padding: '12px',
                  borderRadius: 14,
                  background: '#059669',
                  border: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#ffffff',
                  cursor: 'pointer',
                  boxShadow: '0 2px 6px rgba(5, 150, 105, 0.25)',
                }}
              >
                บันทึกการเติมสารละลาย
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
