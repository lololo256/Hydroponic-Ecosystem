/** Single source of truth for telemetry-freshness wording across the app. */
export const FRESHNESS_LABEL = {
  live: 'ออนไลน์',
  stale: 'ข้อมูลเริ่มเก่า',
  offline: 'ออฟไลน์',
  no_data: 'ยังไม่มีข้อมูล',
  loading: 'กำลังโหลด',
} as const;

interface StatusBadgeProps {
  status: 'normal' | 'warning' | 'critical' | 'offline' | 'active' | 'live' | 'stale' | 'loading' | 'no_data';
  label?: string;
  size?: 'sm' | 'md';
}

const configs = {
  normal:   { dot: 'bg-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/70', text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-800/60', default: 'ปกติ' },
  live:     { dot: 'bg-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/70', text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-800/60', default: FRESHNESS_LABEL.live },
  stale:    { dot: 'bg-amber-400',  bg: 'bg-amber-50 dark:bg-amber-950/70',   text: 'text-amber-700 dark:text-amber-300',     border: 'border-amber-200 dark:border-amber-800/60',   default: FRESHNESS_LABEL.stale },
  loading:  { dot: 'bg-blue-400',   bg: 'bg-blue-50 dark:bg-blue-950/70',     text: 'text-blue-700 dark:text-blue-300',       border: 'border-blue-200 dark:border-blue-800/60',     default: FRESHNESS_LABEL.loading },
  no_data:  { dot: 'bg-slate-300',  bg: 'bg-slate-50 dark:bg-slate-800/80',   text: 'text-slate-500 dark:text-slate-400',     border: 'border-slate-200 dark:border-slate-700/60',   default: FRESHNESS_LABEL.no_data },
  warning:  { dot: 'bg-amber-400',  bg: 'bg-amber-50 dark:bg-amber-950/70',   text: 'text-amber-700 dark:text-amber-300',     border: 'border-amber-100 dark:border-amber-800/60',   default: 'เตือน' },
  critical: { dot: 'bg-rose-500',   bg: 'bg-rose-50 dark:bg-rose-950/70',     text: 'text-rose-700 dark:text-rose-300',       border: 'border-rose-100 dark:border-rose-800/60',     default: 'วิกฤต' },
  offline:  { dot: 'bg-slate-400',  bg: 'bg-slate-50 dark:bg-slate-800/80',   text: 'text-slate-500 dark:text-slate-300',     border: 'border-slate-100 dark:border-slate-700/60',   default: FRESHNESS_LABEL.offline },
  active:   { dot: 'bg-purple-500', bg: 'bg-purple-50 dark:bg-purple-950/70', text: 'text-purple-700 dark:text-purple-300', border: 'border-purple-100 dark:border-purple-800/60',default: 'ทำงาน' },
};

export default function StatusBadge({ status, label, size = 'sm' }: StatusBadgeProps) {
  const c = configs[status] || configs.offline;
  const px = size === 'md' ? 'px-3 py-1.5 text-xs' : 'px-2.5 py-1 text-[11px]';
  const isPulse = status === 'normal' || status === 'live' || status === 'loading';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-bold border transition-colors ${px} ${c.bg} ${c.text} ${c.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot} ${isPulse ? 'pulse-dot' : ''}`} />
      {label ?? c.default}
    </span>
  );
}
