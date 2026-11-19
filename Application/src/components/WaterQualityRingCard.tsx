import React from 'react';
import { TelemetryFreshness } from '../context/SmartFarmContext';
import { FRESHNESS_LABEL } from './StatusBadge';
import {
  FlaskConical,
  Zap,
  Droplets,
  Thermometer,
  ChevronRight,
} from 'lucide-react';

export interface WaterMetricItem {
  key: string;
  label: string; // 'pH' | 'EC' | 'TDS' | 'อุณหภูมิ'
  /** null = no valid reading (shows `--`) */
  value: number | null;
  decimals: number; // 2 for pH, 2 for EC, 0 for TDS, 1 for Temp
  unit: string; // 'pH' | 'mS/cm' | 'ppm' | '°C'
  targetMin: number;
  targetMax: number;
  targetStr: string; // e.g. '5.8 - 6.5'
  onClick: () => void;
}

interface WaterQualityRingCardProps {
  /** 'grid' = Bento 2x2, 'rings' = ring gauges (chosen in app settings) */
  viewMode?: 'grid' | 'rings';
  metrics: WaterMetricItem[];
  isConnected: boolean;
  loading: boolean;
  telemetryStatus?: TelemetryFreshness;
  prefersReducedMotion?: boolean;
}

const METRIC_THEMES: Record<string, {
  name: string;
  shortLabel: string;
  icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  color: string;
  bgLight: string;
  borderLight: string;
  activeZoneColor: string;
}> = {
  ph: {
    name: 'ความเป็นกรด-ด่าง',
    shortLabel: 'pH น้ำ',
    icon: FlaskConical,
    color: '#059669', // Emerald
    bgLight: '#ecfdf5',
    borderLight: '#a7f3d0',
    activeZoneColor: '#10b981',
  },
  ec: {
    name: 'ความเข้มข้นปุ๋ย',
    shortLabel: 'EC สารอาหาร',
    icon: Zap,
    color: '#d97706', // Amber
    bgLight: '#fffbeb',
    borderLight: '#fde68a',
    activeZoneColor: '#f59e0b',
  },
  tds: {
    name: 'แร่ธาตุละลายรวม',
    shortLabel: 'TDS แร่ธาตุ',
    icon: Droplets,
    color: '#0284c7', // Sky Blue
    bgLight: '#f0f9ff',
    borderLight: '#bae6fd',
    activeZoneColor: '#38bdf8',
  },
  temp: {
    name: 'อุณหภูมิสารละลาย',
    shortLabel: 'อุณหภูมิน้ำ',
    icon: Thermometer,
    color: '#e11d48', // Rose
    bgLight: '#fff1f2',
    borderLight: '#fecdd3',
    activeZoneColor: '#fb7185',
  },
};

export default function WaterQualityRingCard({
  metrics,
  isConnected,
  loading,
  telemetryStatus,
  prefersReducedMotion = false,
  viewMode = 'grid',
}: WaterQualityRingCardProps) {

  // SVG Gauge constants for Ring View
  const size = 74;
  const center = size / 2;
  const strokeWidth = 6.5;
  const radius = 29.5;
  const circumference = 2 * Math.PI * radius;
  const arcLength270 = circumference * 0.75;
  const targetArcLength = arcLength270 * 0.5;

  return (
    <div
      style={{
        background: '#ffffff',
        borderRadius: 20,
        padding: '12px',
        boxShadow: '0 2px 12px -2px rgba(15, 23, 42, 0.04)',
        border: '1px solid rgba(226, 232, 240, 0.8)',
        boxSizing: 'border-box',
        width: '100%',
      }}
    >
      {/* ── View Mode 1: Modern 2x2 Bento Grid (Apple Home / Tesla Minimal Style) ── */}
      {viewMode === 'grid' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 8,
          }}
        >
          {metrics.map((item) => {
            const theme = METRIC_THEMES[item.key] || METRIC_THEMES.ph;
            const IconComp = theme.icon;

            const effectiveStatus: TelemetryFreshness = telemetryStatus ?? (
              loading ? 'loading' : (!isConnected ? 'offline' : (typeof item.value === 'number' ? 'live' : 'no_data'))
            );

            // Offline / no data / loading -> `--` (never a stand-in number)
            const value: number | null =
              effectiveStatus !== 'loading' &&
              effectiveStatus !== 'no_data' &&
              effectiveStatus !== 'offline' &&
              typeof item.value === 'number' &&
              Number.isFinite(item.value)
                ? item.value
                : null;
            const hasData = value !== null;

            // Health calculation
            const isOutOfRange = value !== null && (value < item.targetMin || value > item.targetMax);
            const isNearEdge = value !== null && !isOutOfRange && (
              value < item.targetMin + 0.15 * (item.targetMax - item.targetMin) ||
              value > item.targetMax - 0.15 * (item.targetMax - item.targetMin)
            );

            let statusText = 'สมดุลดี';
            let statusBadgeBg = '#ecfdf5';
            let statusTextColor = '#065f46';
            let statusDotColor = '#10b981';

            if (effectiveStatus === 'offline') {
              statusText = FRESHNESS_LABEL.offline;
              statusBadgeBg = '#f1f5f9';
              statusTextColor = '#64748b';
              statusDotColor = '#94a3b8';
            } else if (effectiveStatus === 'stale' && hasData) {
              statusText = FRESHNESS_LABEL.stale;
              statusBadgeBg = '#fffbeb';
              statusTextColor = '#92400e';
              statusDotColor = '#f59e0b';
            } else if (effectiveStatus === 'loading' || effectiveStatus === 'no_data' || !hasData) {
              statusText = effectiveStatus === 'loading' ? FRESHNESS_LABEL.loading : FRESHNESS_LABEL.no_data;
              statusBadgeBg = '#f8fafc';
              statusTextColor = '#94a3b8';
              statusDotColor = '#cbd5e1';
            } else if (isOutOfRange) {
              statusText = value !== null && value < item.targetMin ? 'ต่ำกว่าเกณฑ์' : 'เกินเกณฑ์';
              statusBadgeBg = '#fff1f2';
              statusTextColor = '#9f1239';
              statusDotColor = '#e11d48';
            } else if (isNearEdge) {
              statusText = 'ใกล้ขอบเกณฑ์';
              statusBadgeBg = '#fffbeb';
              statusTextColor = '#92400e';
              statusDotColor = '#f59e0b';
            }

            let displayVal = '--';
            if (value !== null) {
              displayVal = item.decimals === 0 ? Math.round(value).toString() : value.toFixed(item.decimals);
            }

            return (
              <div
                key={item.key}
                onClick={item.onClick}
                style={{
                  background: '#fcfdfd',
                  borderRadius: 14,
                  padding: '9px 12px',
                  border: isOutOfRange ? '1px solid #fecdd3' : effectiveStatus === 'stale' ? '1px solid #fde68a' : '1px solid #edf2f7',
                  opacity: effectiveStatus === 'offline' ? 0.6 : 1,
                  filter: effectiveStatus === 'offline' ? 'grayscale(1)' : 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  userSelect: 'none',
                  transition: prefersReducedMotion ? 'none' : 'transform 0.15s ease, border-color 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#cbd5e1';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = isOutOfRange ? '#fecdd3' : '#edf2f7';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                {/* 1. Tile Header: Icon in soft pill + Metric Name + Dot */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: theme.bgLight,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: theme.color,
                        flexShrink: 0,
                      }}
                    >
                      <IconComp size={12} strokeWidth={2.2} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#334155', letterSpacing: '-0.01em' }}>
                      {theme.shortLabel}
                    </span>
                  </div>

                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: statusDotColor,
                      boxShadow: statusDotColor === '#10b981' ? '0 0 6px rgba(16, 185, 129, 0.4)' : 'none',
                    }}
                  />
                </div>

                {/* 2. Hero Value (Large, Bold, Clean tabular-nums) */}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 5 }}>
                  <span
                    style={{
                      fontSize: 25,
                      fontWeight: 700,
                      color: isOutOfRange ? '#e11d48' : '#0f172a',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif',
                      fontFeatureSettings: '"tnum"',
                      letterSpacing: '-0.02em',
                      lineHeight: 1,
                    }}
                  >
                    {displayVal}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: '#64748b' }}>
                    {item.unit}
                  </span>
                </div>

                {/* 3. Subtle Clean Status Badge (Zero visual clutter) */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 7px',
                      borderRadius: 6,
                      background: statusBadgeBg,
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: statusTextColor,
                    }}
                  >
                    <span>{statusText}</span>
                  </div>
                  <ChevronRight size={13} color="#cbd5e1" strokeWidth={1.75} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── View Mode 2: Clean 4 Semicircle Rings (No double text) ── */
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            alignItems: 'stretch',
            padding: '4px 0',
          }}
        >
          {metrics.map((item, idx) => {
            const theme = METRIC_THEMES[item.key] || METRIC_THEMES.ph;
            const effectiveStatus: TelemetryFreshness = telemetryStatus ?? (
              loading ? 'loading' : (!isConnected ? 'offline' : (typeof item.value === 'number' ? 'live' : 'no_data'))
            );

            // Offline / no data / loading -> `--` (never a stand-in number)
            const value: number | null =
              effectiveStatus !== 'loading' &&
              effectiveStatus !== 'no_data' &&
              effectiveStatus !== 'offline' &&
              typeof item.value === 'number' &&
              Number.isFinite(item.value)
                ? item.value
                : null;
            const hasData = value !== null;

            const targetWidth = item.targetMax - item.targetMin;
            const scaleMin = item.targetMin - 0.5 * targetWidth;
            const scaleMax = item.targetMax + 0.5 * targetWidth;
            const clampedVal = Math.max(scaleMin, Math.min(scaleMax, value ?? scaleMin));
            const progress = hasData
              ? Math.max(0, Math.min(1, (clampedVal - scaleMin) / (scaleMax - scaleMin)))
              : 0;

            const isOutOfRange = value !== null && (value < item.targetMin || value > item.targetMax);

            let dotColor = '#10b981';
            if (effectiveStatus === 'offline') dotColor = '#94a3b8';
            else if (effectiveStatus === 'stale') dotColor = '#f59e0b';
            else if (effectiveStatus === 'no_data') dotColor = '#cbd5e1';
            else if (isOutOfRange) dotColor = '#e11d48';

            let valueTextColor = '#0f172a';
            if (effectiveStatus === 'no_data' || !hasData) valueTextColor = '#94a3b8';
            else if (effectiveStatus === 'stale') valueTextColor = '#92400e';
            else if (isOutOfRange) valueTextColor = '#e11d48';

            let displayVal = '--';
            if (value !== null) {
              displayVal = item.decimals === 0 ? Math.round(value).toString() : value.toFixed(item.decimals);
            }

            const angleDeg = 135 + progress * 270;
            const angleRad = (angleDeg * Math.PI) / 180;
            const dotX = center + radius * Math.cos(angleRad);
            const dotY = center + radius * Math.sin(angleRad);

            return (
              <div
                key={item.key}
                onClick={item.onClick}
                style={{
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  textAlign: 'center',
                  padding: '4px 2px',
                  cursor: 'pointer',
                  userSelect: 'none',
                  borderRight: idx < metrics.length - 1 ? '1px solid #f1f5f9' : 'none',
                }}
              >
                <div style={{ position: 'relative', width: size, height: size, margin: '0 auto' }}>
                  <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible', display: 'block' }}>
                    <circle
                      cx={center}
                      cy={center}
                      r={radius}
                      fill="none"
                      stroke="#f1f5f9"
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                      strokeDasharray={`${arcLength270} ${circumference}`}
                      strokeDashoffset={0}
                      transform={`rotate(135 ${center} ${center})`}
                    />
                    {hasData && (
                      <circle
                        cx={center}
                        cy={center}
                        r={radius}
                        fill="none"
                        stroke="#a7f3d0"
                        strokeWidth={strokeWidth}
                        strokeDasharray={`${targetArcLength} ${circumference}`}
                        strokeDashoffset={-0.25 * arcLength270}
                        transform={`rotate(135 ${center} ${center})`}
                      />
                    )}
                    {hasData && (
                      <circle
                        cx={dotX}
                        cy={dotY}
                        r={4.5}
                        fill={dotColor}
                        stroke="#ffffff"
                        strokeWidth={1.5}
                        style={{
                          transition: prefersReducedMotion ? 'none' : 'cx 300ms ease, cy 300ms ease',
                          filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.12))',
                        }}
                      />
                    )}
                  </svg>

                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                      paddingTop: 2,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: valueTextColor,
                        fontFeatureSettings: '"tnum"',
                        lineHeight: 1.1,
                        letterSpacing: '-0.02em',
                      }}
                    >
                      {displayVal}
                    </span>
                    <span style={{ fontSize: 9.5, color: '#64748b', fontWeight: 500 }}>
                      {item.unit}
                    </span>
                  </div>
                </div>

                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#334155',
                    marginTop: 6,
                    lineHeight: 1.2,
                  }}
                >
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
