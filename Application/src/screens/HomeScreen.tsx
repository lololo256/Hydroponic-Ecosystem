import React, { useState, useEffect, useMemo } from 'react';
import { NavProps } from '../types';
import { useSmartFarm, PumpKey } from '../context/SmartFarmContext';
import FarmCardCarousel, { FarmItem } from '../components/FarmCardCarousel';
import WaterQualityRingCard from '../components/WaterQualityRingCard';
import StatusBadge from '../components/StatusBadge';
import AIDiagnosisModal from '../components/AIDiagnosisModal';
import AIBriefingCard from '../components/AIBriefingCard';
import DemoSimPanel from '../components/DemoSimPanel';
import SensorHealthCard from '../components/SensorHealthCard';
import { calculatePlantDays } from '../services/briefingEngine';
import {
  getEffectiveTargets,
  mainTankStatusLabel,
  isChemicalPump,
  MAIN_PUMP_DEFAULT_SECONDS,
  CHEM_PUMP_DEFAULT_SECONDS,
} from '../services/telemetryContract';
import DemoBoardBadge from '../components/DemoBoardBadge';
import { useHomeLayout, HomeSectionId } from '../hooks/useHomeLayout';
import {
  Menu,
  Bell,
  Droplets,
  Zap,
  FlaskConical,
  Thermometer,
  Power,
  ChevronRight,
  RotateCw,
  Plus,
  QrCode,
  Radio,
  Cpu,
  Sliders,
  Sparkles,
  Lock,
  AlertCircle,
  Sprout,
  Bot,
  Clock,
  Sun,
  Sunrise,
  Sunset,
  Moon,
  AlertTriangle,
  BookOpen,
  MessageSquare,
  Loader2,
  X,
} from 'lucide-react';
import { FEATURES } from '../config/features';

interface HomeProps extends NavProps {
  onMenuOpen: () => void;
}

/* ─── Tank Liquid Colors Configuration ─── */
const TANK_COLORS = {
  main: '#378ADD',
  fertA: '#1D9E75',
  fertB: '#EF9F27',
  phDown: '#D4537E',
  phUp: '#7F77DD',
};

type TankType = keyof typeof TANK_COLORS;

interface LiquidTubeProps {
  label: string;
  value?: number;
  type: TankType;
  connected: boolean;
  prefersReducedMotion?: boolean;
}

function LiquidTube({
  label,
  value,
  type,
  connected,
  prefersReducedMotion = false,
}: LiquidTubeProps) {
  const hasData = connected && value !== undefined && value !== null && !isNaN(value);
  const percent = hasData ? Math.max(0, Math.min(100, value)) : 0;
  const isCriticalMain = hasData && type === 'main' && percent < 15;
  const isDosingEmpty = hasData && type !== 'main' && percent === 0;
  const liquidColor = TANK_COLORS[type];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flex: 1,
        minWidth: 0,
      }}
    >
      {/* 1. Percentage number / indicator */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          marginBottom: 6,
          height: 18,
        }}
      >
        {isCriticalMain && (
          <AlertCircle
            size={11}
            strokeWidth={2.2}
            color="#dc2626"
            style={{ flexShrink: 0 }}
          />
        )}
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: !hasData
              ? '#94a3b8'
              : isCriticalMain
              ? '#dc2626'
              : isDosingEmpty
              ? '#94a3b8'
              : '#1e293b',
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {hasData ? (isDosingEmpty ? '0%' : `${Math.round(percent)}%`) : '--'}
        </span>
      </div>

      {/* 2. Sleek Capsule Tube */}
      <div
        style={{
          width: '100%',
          maxWidth: 46,
          height: 68,
          borderRadius: 14,
          border: isCriticalMain
            ? '1.5px solid #f87171'
            : isDosingEmpty
            ? '1px dashed #cbd5e1'
            : '1px solid #e2e8f0',
          background: isDosingEmpty ? '#f8fafc' : '#f1f5f9',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.04)',
        }}
      >
        {/* Liquid Fill using transform */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            background: liquidColor,
            opacity: hasData ? 0.92 : 0,
            transform: `translateY(${hasData ? 100 - percent : 100}%)`,
            transition: prefersReducedMotion ? 'none' : 'transform 400ms cubic-bezier(0.16, 1, 0.3, 1)',
            willChange: 'transform',
            borderRadius: '0 0 13px 13px',
          }}
        />

        {/* Subtle Glass Reflection Overlay */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(90deg, rgba(255,255,255,0.35) 0%, transparent 60%, rgba(0,0,0,0.03) 100%)',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* 3. Name below tube */}
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: '#475569',
          marginTop: 6,
          textAlign: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
        }}
      >
        {label}
      </span>
    </div>
  );
}

export default function HomeScreen({ navigate, onMenuOpen }: HomeProps) {
  const {
    data,
    connectedBoardId,
    togglePump,
    loading,
    savedBoards,
    connectBoard,
    pendingPumps,
    commandError,
    clearCommandError,
    telemetryFreshness,
    canControl,
    isDemoBoard,
    showConfirm,
    showAlert,
    enableDosingTracking,
    solutionLevels,
    unreadAlertCount,
  } = useSmartFarm();
  const targets = getEffectiveTargets(data);
  const hasPairedDevice = Boolean(connectedBoardId || Object.keys(savedBoards || {}).length > 0);
  const isOnline = Boolean(
    connectedBoardId &&
    telemetryFreshness === 'live' &&
    data.device.esp32Connected &&
    data.device.wifiConnected
  );
  // Reporting = live or stale. Used for the farm carousel / ring cards so a stale device
  // is never labelled "ออฟไลน์" while the ring cards say "ข้อมูลเริ่มเก่า" (FRESHNESS_LABEL).
  const isReporting = Boolean(
    connectedBoardId && (telemetryFreshness === 'live' || telemetryFreshness === 'stale')
  );
  const { order: sectionOrder, metricView } = useHomeLayout();
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [isAIModalOpen, setIsAIModalOpen] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReducedMotion(mq.matches);
      const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
      mq.addEventListener?.('change', handler);
      return () => mq.removeEventListener?.('change', handler);
    } catch (e) { }
  }, []);

  // Plant age in days (Single Source of Truth: 1-based วันที่เริ่มปลูกนับเป็นวันที่ 1)
  const plantDays = data.plantingStartDate
    ? calculatePlantDays(data.plantingStartDate)
    : null;

  const isFarmConfigured = Boolean(data.plantType && data.plantingStartDate);
  // Not set -> undefined, the briefing card shows '--' (no invented 45-day countdown).
  const harvestCycleDays =
    typeof data.expectedHarvestDays === 'number' && data.expectedHarvestDays > 0 ? data.expectedHarvestDays : undefined;

  // รวบรวมข้อมูลประวัติเซนเซอร์จริง (Real History Data)
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

  // Farm List for Carousel & Farm Switcher
  const hasActiveCritical = Object.values(data.alerts || {}).some(
    (a: any) => (a.level === 'critical' || a.level === 'error') && !a.read
  );

  const farmList: FarmItem[] = Object.entries(savedBoards || {}).map(([id, info]) => ({
    id,
    name: info.name || `Hydroponic ${id}`,
    plantType: info.plantType || (id === connectedBoardId ? data.plantType : 'พืชไฮโดรโปนิกส์'),
    isOnline: id === connectedBoardId ? isReporting : false,
    freshness: id === connectedBoardId ? telemetryFreshness : undefined,
    hasCriticalAlert: id === connectedBoardId ? hasActiveCritical : false,
  }));

  if (connectedBoardId && !farmList.some((f) => f.id === connectedBoardId)) {
    farmList.unshift({
      id: connectedBoardId,
      name: data.profile.name || `Hydroponic ${connectedBoardId}`,
      plantType: data.plantType || 'พืชไฮโดรโปนิกส์',
      isOnline: isReporting,
      freshness: telemetryFreshness,
      hasCriticalAlert: hasActiveCritical,
    });
  }

  // Haptic feedback trigger for pump toggles with Farm Name confirmation
  const handleTogglePumpWithHaptic = (pumpKey: PumpKey) => {
    if (!canControl) {
      showAlert({
        title: 'ปั๊มถูกล็อก',
        message: 'อุปกรณ์ไม่ได้ส่งข้อมูลสด (ข้อมูลเก่ากว่า 75 วินาที หรือออฟไลน์) ระบบล็อกการสั่งงานเพื่อความปลอดภัย',
        variant: 'warning',
      });
      return;
    }

    if (pendingPumps[pumpKey]) {
      return;
    }

    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(35);
      }
    } catch (e) { }

    if (isChemicalPump(pumpKey) && data.pumps.controlMode !== 'MANUAL') {
      showAlert({
        title: data.pumps.controlMode === 'AUTO' ? 'ระบบอยู่ในโหมด AUTO' : 'ยังไม่ทราบโหมดการทำงาน',
        message:
          data.pumps.controlMode === 'AUTO'
            ? 'โหมด AUTO ล็อกการสั่งปั๊มสารเคมีเพื่อความปลอดภัย\n(กรุณาสลับเป็นโหมด MANUAL ในหน้าการจัดการน้ำก่อนควบคุม)'
            : 'อุปกรณ์ยังไม่รายงานโหมดการทำงาน ระบบล็อกปั๊มสารเคมีไว้ก่อนเพื่อความปลอดภัย',
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
    const currentFarmName = (connectedBoardId && savedBoards[connectedBoardId]?.name) || data.profile.name || 'ฟาร์มที่เลือก';
    const durationText = isCurrentlyOn
      ? 'อุปกรณ์จะหยุดปั๊มทันที'
      : isChemicalPump(pumpKey)
      ? `อุปกรณ์จะจ่ายสาร ${CHEM_PUMP_DEFAULT_SECONDS} วินาทีแล้วหยุดเอง`
      : `อุปกรณ์จะเปิดปั๊ม ${Math.round(MAIN_PUMP_DEFAULT_SECONDS / 60)} นาทีแล้วปิดเอง (กดอีกครั้งเพื่อหยุดก่อนได้)`;

    showConfirm({
      title: `${action}${pumpNames[pumpKey]}`,
      message: `คุณต้องการ${action}${pumpNames[pumpKey]}ของ ${currentFarmName} ใช่หรือไม่?\n${durationText}`,
      confirmText: action,
      cancelText: 'ยกเลิก',
      variant: isCurrentlyOn ? 'danger' : 'success',
      // togglePump shows its own alert on failure; swallow the rejection here.
      onConfirm: () => togglePump(pumpKey).catch(() => {}),
    });
  };

  return (
    <div
      style={{
        paddingBottom: 115,
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
      }}
    >
      {/* ── Top Bar ── */}
      <div
        style={{
          padding: '38px 16px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: '50%',
              background: '#ffffff',
              boxShadow: '0 4px 14px rgba(16, 185, 129, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              border: '1.5px solid rgba(16, 185, 129, 0.2)',
            }}
          >
            <img
              src="/logo.png"
              alt="Hydroponic Logo"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
          <div>
            <span style={{ fontSize: 17, fontWeight: 600, color: '#0f172a', letterSpacing: '0.06em' }}>
              Hydroponic
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
          <button
            type="button"
            onClick={() => setShowAddMenu(!showAddMenu)}
            aria-label="เพิ่มอุปกรณ์"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: 'rgba(255, 255, 255, 0.9)',
              border: 'none',
              color: '#334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
            }}
            title="เพิ่มอุปกรณ์"
          >
            <Plus size={20} strokeWidth={1.75} />
          </button>

          <button
            type="button"
            onClick={() => navigate('notifications')}
            aria-label={unreadAlertCount > 0 ? `การแจ้งเตือน ยังไม่ได้อ่าน ${unreadAlertCount} รายการ` : 'การแจ้งเตือน'}
            title="การแจ้งเตือน"
            style={{
              position: 'relative',
              width: 44,
              height: 44,
              borderRadius: 12,
              background: 'rgba(255, 255, 255, 0.9)',
              border: 'none',
              color: '#334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
            }}
          >
            <Bell size={19} strokeWidth={1.75} />
            {unreadAlertCount > 0 && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 9999,
                  background: '#dc2626',
                  color: '#ffffff',
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: '16px',
                  textAlign: 'center',
                  fontVariantNumeric: 'tabular-nums',
                  boxShadow: '0 0 0 2px #ffffff',
                  boxSizing: 'border-box',
                }}
              >
                {unreadAlertCount > 99 ? '99+' : unreadAlertCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onMenuOpen}
            aria-label="เมนู"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: 'rgba(255, 255, 255, 0.9)',
              border: 'none',
              color: '#334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
            }}
          >
            <Menu size={18} strokeWidth={1.75} />
          </button>

          {/* Xiaomi Home style popover menu */}
          {showAddMenu && (
            <>
              <div
                onClick={() => setShowAddMenu(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 90 }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 46,
                  right: 0,
                  width: 170,
                  background: '#1e293b',
                  borderRadius: 14,
                  padding: '6px',
                  boxShadow: '0 10px 25px rgba(0, 0, 0, 0.25)',
                  zIndex: 100,
                  border: '1px solid #334155',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setShowAddMenu(false);
                    navigate('add-board');
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'transparent',
                    border: 'none',
                    color: '#ffffff',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    textAlign: 'left',
                  }}
                >
                  <Radio size={16} strokeWidth={1.75} color="#10b981" />
                  <span>เพิ่มอุปกรณ์</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddMenu(false);
                    navigate('connect-board');
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'transparent',
                    border: 'none',
                    color: '#ffffff',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    textAlign: 'left',
                  }}
                >
                  <QrCode size={16} strokeWidth={1.75} color="#10b981" />
                  <span>สแกน</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ padding: '0 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!hasPairedDevice ? (
          /* Empty State when no device is paired */
          <div
            style={{
              background: '#ffffff',
              borderRadius: 20,
              padding: '44px 20px',
              border: '1px solid #e2e8f0',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.03)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              marginTop: 10,
            }}
          >
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: '50%',
                background: 'rgba(5, 150, 105, 0.08)',
                color: '#059669',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Cpu size={32} strokeWidth={1.5} />
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>
              ยังไม่มีอุปกรณ์ที่เชื่อมต่อ
            </h2>
            <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 24px', lineHeight: 1.5, maxWidth: 280 }}>
              กดปุ่มเพิ่มอุปกรณ์เพื่อเริ่มสแกนบลูทูธหรือสแกน QR Code สำหรับเชื่อมต่ออุปกรณ์ของคุณ
            </p>
            <div style={{ display: 'flex', gap: 10, width: '100%', maxWidth: 320 }}>
              <button
                type="button"
                onClick={() => navigate('add-board')}
                style={{
                  flex: 1,
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
                  gap: 6,
                }}
              >
                <Plus size={16} strokeWidth={2} />
                <span>เพิ่มอุปกรณ์</span>
              </button>
              <button
                type="button"
                onClick={() => navigate('connect-board')}
                style={{
                  padding: '13px 18px',
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
                  gap: 6,
                }}
              >
                <QrCode size={16} strokeWidth={1.75} />
                <span>สแกน</span>
              </button>
            </div>
          </div>
        ) : (
          <>

            {/* ── Farm Card Carousel with Horizontal Swipe ── */}
            <div style={{ marginBottom: 0 }}>
              <FarmCardCarousel
                farms={farmList}
                selectedFarmId={connectedBoardId}
                currentPlantDays={plantDays}
                currentPlantType={data.plantType || 'พืชไฮโดรโปนิกส์'}
                isCurrentOnline={isReporting}
                // Swiping back to the farm that is already shown must not reconnect it: connectBoard
                // clears the board data first, which flashed the "ตั้งค่าระบบพืช" prompt for a moment.
                onSelectFarm={(farmId) => {
                  if (farmId !== connectedBoardId) connectBoard(farmId);
                }}
                onAddFarm={() => navigate('add-board')}
                prefersReducedMotion={prefersReducedMotion}
              />
            </div>

            {/* ── ทดสอบระบบอัตโนมัติ: ส่งค่าเข้าบอร์ดทดลองจริง (CYD DEMO_SIM, RPC simSet) ──
                โชว์เฉพาะบอร์ดที่ส่ง sim:true — บอร์ดเซนเซอร์จริงในแอปหลักไม่มีกล่องนี้ (DemoSimPanel คืน null)
                อยู่บนสุดของแดชบอร์ดเพื่อให้อาจารย์หาเจอง่าย */}
            <div style={{ marginTop: 12, marginBottom: 16 }}>
              <DemoSimPanel />
            </div>

            {/* ── 5 home sections, in the order chosen in app settings (ตั้งค่าแอป > หน้าหลัก) ── */}
            {(() => {
              const sectionNodes: Record<HomeSectionId, React.ReactNode> = {
              briefing: (
                <>
            {/* ── Farm Setup Prompt or AI Executive Briefing Card (Gated: requires connected device) ── */}
            {Boolean(connectedBoardId) ? (
              !isFarmConfigured ? (
              <div
                onClick={() => navigate('setup-farm')}
                style={{
                  background: '#ffffff',
                  borderRadius: 18,
                  border: '1.5px dashed #059669',
                  padding: '14px 16px',
                  marginBottom: 16,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  boxShadow: '0 2px 10px rgba(5, 150, 105, 0.05)',
                  transition: 'transform 0.15s ease',
                }}
              >
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 12,
                    background: '#ecfdf5',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Sprout size={22} className="text-emerald-600" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                      ตั้งค่าระบบพืช & ฟาร์ม
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: '#fef3c7',
                        color: '#b45309',
                        fontWeight: 700,
                      }}
                    >
                      แนะนำ
                    </span>
                  </div>
                  <p style={{ margin: '3px 0 0', fontSize: 11.5, color: '#64748b', lineHeight: 1.4 }}>
                    ระบุชนิดผักและวันที่เริ่มปลูก เพื่อเปิดใช้งานสรุปสถานะฟาร์มและคำแนะนำรายวัน
                  </p>
                </div>
                <ChevronRight size={18} className="text-slate-400 shrink-0" />
              </div>
            ) : (
              <AIBriefingCard
                plantType={data.plantType}
                plantStartDate={data.plantingStartDate}
                expectedHarvestDays={harvestCycleDays}
                current={data.current}
                targets={targets}
                history={rawHistoryList as any}
                isOnline={isOnline}
                prefersReducedMotion={prefersReducedMotion}
                onOpenAIModal={() => setIsAIModalOpen(true)}
                onOpenSetupFarm={() => navigate('setup-farm')}
              />
            )) : null}
                </>
              ),
              sensorHealth: (
                <>
            {/* ── AI sensor health check (real telemetry, on-device analysis) ── */}
            {connectedBoardId && <SensorHealthCard />}
                </>
              ),
              waterQuality: (
                <>
            {/* ── Water Quality Metrics Overview ── */}
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 6,
                  padding: '0 4px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
                    คุณภาพน้ำ
                  </span>
                  <StatusBadge status={telemetryFreshness} />
                </div>
                <button
                  type="button"
                  onClick={() => navigate('water-quality')}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#059669',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '4px 6px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>รายละเอียด</span>
                  <ChevronRight size={14} strokeWidth={2} />
                </button>
              </div>

              {isDemoBoard && FEATURES.showDemoBoardLabels && (
                <div style={{ marginBottom: 8 }}>
                  <DemoBoardBadge />
                </div>
              )}

              <WaterQualityRingCard
                isConnected={isReporting}
                loading={loading}
                telemetryStatus={telemetryFreshness}
                prefersReducedMotion={prefersReducedMotion}
                viewMode={metricView}
                metrics={[
                  {
                    key: 'ph',
                    label: 'pH',
                    value: data.current.pH,
                    decimals: 2,
                    unit: 'pH',
                    targetMin: targets.phMin,
                    targetMax: targets.phMax,
                    targetStr: `${targets.phMin.toFixed(1)} - ${targets.phMax.toFixed(1)}`,
                    onClick: () => navigate('history', { sensor: 'ph' }),
                  },
                  {
                    key: 'ec',
                    label: 'EC',
                    value: data.current.ec,
                    decimals: 2,
                    unit: 'mS/cm',
                    targetMin: targets.ecMin,
                    targetMax: targets.ecMax,
                    targetStr: `${targets.ecMin.toFixed(1)} - ${targets.ecMax.toFixed(1)}`,
                    onClick: () => navigate('history', { sensor: 'ec' }),
                  },
                  {
                    key: 'tds',
                    label: 'TDS',
                    value: data.current.tds,
                    decimals: 0,
                    unit: 'ppm',
                    targetMin: Math.round(targets.ecMin * 500),
                    targetMax: Math.round(targets.ecMax * 500),
                    targetStr: `${Math.round(targets.ecMin * 500)} - ${Math.round(targets.ecMax * 500)}`,
                    onClick: () => navigate('history', { sensor: 'tds' }),
                  },
                  {
                    key: 'temp',
                    label: 'อุณหภูมิ',
                    value: data.current.tempC,
                    decimals: 1,
                    unit: '°C',
                    targetMin: targets.tempMin,
                    targetMax: targets.tempMax,
                    targetStr: `${targets.tempMin.toFixed(0)} - ${targets.tempMax.toFixed(0)}`,
                    onClick: () => navigate('history', { sensor: 'temp' }),
                  },
                ]}
              />
            </div>
                </>
              ),
              tanks: (
                <>
            {/* ── Liquid Tanks (5 หลอดใน 1 แถว) ── */}
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 10,
                  padding: '0 2px',
                }}
              >
                <span style={{ fontSize: 13.5, fontWeight: 600, color: '#334155' }}>
                  ระดับสารละลายในถัง
                </span>
                <button
                  type="button"
                  onClick={() => navigate('liquid-level')}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#059669',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                  }}
                >
                  <span>จัดการ</span>
                  <ChevronRight size={14} strokeWidth={1.5} />
                </button>
              </div>

              {(() => {
                // Main tank: real float switch `tank_main_ok` (no percentage sensor exists).
                const tankReported = telemetryFreshness === 'live' || telemetryFreshness === 'stale';
                const tankOk = tankReported ? data.levels.mainTankOk : null;
                const tankLabel = mainTankStatusLabel(tankOk);
                const tankColor = tankOk === true ? '#059669' : tankOk === false ? '#dc2626' : '#94a3b8';
                const tankBg = tankOk === true ? '#ecfdf5' : tankOk === false ? '#fef2f2' : '#f8fafc';

                // Chemical tanks: calculated (refills + measured pump flow + board pump run-time), "ประมาณการ".
                const estimate = (k: 'fertA' | 'fertB' | 'phDown' | 'phUp'): number | undefined => {
                  const lvl = solutionLevels[k];
                  return lvl.status === 'ok' && lvl.pct !== null ? lvl.pct : undefined;
                };

                return (
                  <div
                    style={{
                      background: '#ffffff',
                      padding: '14px 16px',
                      borderRadius: 20,
                      border: '1px solid rgba(226, 232, 240, 0.8)',
                      boxShadow: '0 2px 12px -2px rgba(15, 23, 42, 0.04)',
                      transition: 'all 0.25s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <Droplets size={16} strokeWidth={2} color="#0284c7" />
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>ถังน้ำสารละลายหลัก</span>
                        <span style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 6, background: '#f0fdf4', color: '#166534', fontWeight: 600, border: '1px solid #bbf7d0', whiteSpace: 'nowrap' }}>
                          ลูกลอยจริง
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: tankColor,
                          background: tankBg,
                          padding: '4px 10px',
                          borderRadius: 8,
                          minWidth: 56,
                          textAlign: 'center',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {tankLabel}
                      </span>
                    </div>

                    {enableDosingTracking && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '14px 0 8px' }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>ถังสารเคมี</span>
                          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#fffbeb', color: '#92400e', fontWeight: 700, border: '1px solid #fde68a' }}>
                            ประมาณการ
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                          <LiquidTube label="ปุ๋ย A" value={estimate('fertA')} type="fertA" connected={hasPairedDevice} prefersReducedMotion={prefersReducedMotion} />
                          <LiquidTube label="ปุ๋ย B" value={estimate('fertB')} type="fertB" connected={hasPairedDevice} prefersReducedMotion={prefersReducedMotion} />
                          <LiquidTube label="ลด pH" value={estimate('phDown')} type="phDown" connected={hasPairedDevice} prefersReducedMotion={prefersReducedMotion} />
                          <LiquidTube label="เพิ่ม pH" value={estimate('phUp')} type="phUp" connected={hasPairedDevice} prefersReducedMotion={prefersReducedMotion} />
                        </div>
                      </>
                    )}
                    <p style={{ margin: '10px 0 0', fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                      {enableDosingTracking
                        ? 'ถังสารเคมีไม่มีเซนเซอร์วัดระดับ ตัวเลขคำนวณจากปริมาณที่ผู้ใช้บันทึกตอนเติม (ไม่ใช่ค่าวัดจริง)'
                        : 'ตรวจวัดถังหลักด้วยสวิตช์ลูกลอยจริง (ปกติ / น้ำต่ำ)'}
                    </p>
                  </div>
                );
              })()}
            </div>
                </>
              ),
              pumps: (
                <>
            {/* ── Pump Control (reported state + pending, live-only) ── */}
            <div
              style={{
                background: '#ffffff',
                padding: '16px',
                borderRadius: 20,
                border: '1px solid rgba(226, 232, 240, 0.8)',
                boxShadow: '0 2px 12px -2px rgba(15, 23, 42, 0.04)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Power size={15} strokeWidth={2} color="#059669" />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#334155' }}>ควบคุมปั๊มน้ำ</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {data.pumps.controlMode === 'AUTO' && <Lock size={12} color="#059669" />}
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 6,
                      background: data.pumps.controlMode === 'AUTO' ? '#ecfdf5' : '#f1f5f9',
                      color: data.pumps.controlMode === 'AUTO' ? '#065f46' : '#475569',
                    }}
                  >
                    โหมด {data.pumps.controlMode ?? '--'}
                  </span>
                </div>
              </div>

              {!canControl && connectedBoardId && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: '8px 12px',
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 10,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: '#475569',
                    fontSize: 11.5,
                    fontWeight: 500,
                  }}
                >
                  <Lock size={13} color="#64748b" style={{ flexShrink: 0 }} />
                  <span>อุปกรณ์ไม่ได้ส่งข้อมูลสด ปั๊มถูกล็อกเพื่อความปลอดภัย</span>
                </div>
              )}

              {commandError && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: '4px 4px 4px 12px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    color: '#991b1b',
                    fontSize: 11,
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

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                {([
                  { key: 'mainPumpOn', label: 'ปั๊มหลัก', onColor: '#059669', onBg: '#ecfdf5', onBorder: 'rgba(5, 150, 105, 0.3)' },
                  { key: 'phDownPumpOn', label: 'ลด pH', onColor: '#d97706', onBg: '#fef3c7', onBorder: 'rgba(217, 119, 6, 0.3)' },
                  { key: 'phUpPumpOn', label: 'เพิ่ม pH', onColor: '#0d9488', onBg: '#f0fdfa', onBorder: 'rgba(13, 148, 136, 0.3)' },
                  { key: 'fertPumpAOn', label: 'ปุ๋ย A', onColor: '#059669', onBg: '#ecfdf5', onBorder: 'rgba(5, 150, 105, 0.3)' },
                  { key: 'fertPumpBOn', label: 'ปุ๋ย B', onColor: '#059669', onBg: '#ecfdf5', onBorder: 'rgba(5, 150, 105, 0.3)' },
                ] as Array<{ key: PumpKey; label: string; onColor: string; onBg: string; onBorder: string }>).map((p) => {
                  const pending = Boolean(pendingPumps[p.key]);
                  const reported = data.pumps[p.key];
                  const isOn = reported === true;
                  const chemLocked = isChemicalPump(p.key) && data.pumps.controlMode !== 'MANUAL';
                  const disabled = !canControl || pending || chemLocked;
                  // AUTO cycle reported by the board: a 2 s dose is easy to miss between polls, so the pumps of the
                  // current cycle stay highlighted until mixing ends (same data as the pump page)
                  const cycle = data.autoCycle;
                  const inAutoCycle =
                    canControl && !isOn && !!cycle && cycle.phase !== 'idle' && cycle.pumps.includes(p.key);
                  const lit = canControl && (isOn || inAutoCycle);
                  let statusText: string;
                  if (pending) statusText = 'กำลังส่ง...';
                  else if (!canControl || reported === null) statusText = '--';
                  else if (isOn) statusText = isChemicalPump(p.key) ? 'กำลังจ่าย' : 'เปิดอยู่';
                  else if (inAutoCycle) statusText = cycle!.phase === 'mixing' ? 'จ่ายแล้ว' : 'รอบนี้';
                  else if (chemLocked) statusText = 'ล็อก';
                  else statusText = isChemicalPump(p.key) ? 'พร้อม' : 'ปิด';
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => handleTogglePumpWithHaptic(p.key)}
                      aria-disabled={disabled}
                      aria-busy={pending}
                      className="active:scale-[0.98]"
                      style={{
                        minHeight: 52,
                        padding: '8px 2px',
                        borderRadius: 12,
                        background: pending ? '#f1f5f9' : lit ? p.onBg : '#ffffff',
                        border: `${isOn && canControl ? 1.5 : 1}px solid ${lit ? p.onColor : 'rgba(226, 232, 240, 0.8)'}`,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        opacity: !canControl ? 0.55 : chemLocked && !lit ? 0.75 : 1,
                        filter: !canControl ? 'grayscale(1)' : 'none',
                        textAlign: 'center',
                        transition: 'all 0.15s ease',
                        fontFamily: 'inherit',
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#0f172a' }}>{p.label}</div>
                      <div
                        style={{
                          fontSize: 10,
                          color: pending ? '#94a3b8' : lit ? p.onColor : '#64748b',
                          fontWeight: lit || pending ? 600 : 400,
                          marginTop: 2,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 3,
                          minHeight: 14,
                        }}
                      >
                        {pending && <Loader2 size={10} className="animate-spin" />}
                        <span>{statusText}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
                </>
              ),
              };
              return sectionOrder.map((id) => <React.Fragment key={id}>{sectionNodes[id]}</React.Fragment>);
            })()}


          </>
        )}
      </div>

      <AIDiagnosisModal isOpen={isAIModalOpen} onClose={() => setIsAIModalOpen(false)} />

      <style>{`
        @keyframes waveMove {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }

        @keyframes dotPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.3); }
        }
      `}</style>
    </div>
  );
}
