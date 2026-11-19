/**
 * Farm alert rules: decides WHAT needs the user's attention right now from real data only,
 * and tracks each condition over time so the phone is notified at the right moment, not every poll.
 * Same policy as the ThingsBoard rule chain "Farm Alerts" (docs/thingsboard/farm_alerts_evaluate.tbel).
 * Delivery helpers (quiet hours, back-off, bundling) live in smartNotificationSynthesizer.ts.
 */
import type { AlertCategory, AlertSeverity, IssueAlertRecord, RawAlertEvent } from './smartNotificationSynthesizer';
import type { HealthCheck } from './sensorHealth';
import type { SolutionTankKey, TankLevel } from './solutionTracker';

export interface AlertCondition {
  key: string;
  level: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
}

export interface AlertRuleInput {
  freshness: 'loading' | 'live' | 'stale' | 'offline' | 'no_data';
  current: { pH: number | null; ec: number | null; tempC: number | null };
  targets: { phMin: number; phMax: number; ecMin: number; ecMax: number; tempMin: number; tempMax: number };
  mainTankOk: boolean | null;
  solutionLevels?: Partial<Record<SolutionTankKey, TankLevel>>;
  sensorChecks?: HealthCheck[];
}

const TANK_NAME: Record<SolutionTankKey, string> = {
  fertA: 'ถังแม่ปุ๋ย A',
  fertB: 'ถังแม่ปุ๋ย B',
  phDown: 'ถังสารลด pH (กรด)',
  phUp: 'ถังสารเพิ่ม pH (ด่าง)',
};

function rangeCondition(
  key: string,
  category: AlertCategory,
  label: string,
  value: number | null,
  min: number,
  max: number,
  criticalMargin: number,
  digits: number,
  unit: string
): AlertCondition | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= min && value <= max) return null;
  const low = value < min;
  const off = low ? min - value : value - max;
  return {
    key,
    category,
    level: off >= criticalMargin ? 'critical' : 'warning',
    title: `${label}${low ? 'ต่ำ' : 'สูง'}กว่าเป้าหมาย`,
    message: `${label} ${value.toFixed(digits)}${unit} (เป้าหมาย ${min.toFixed(digits)}-${max.toFixed(digits)}${unit})`,
  };
}

/** Conditions that are true right now. Range rules only run on live data (never on stale values). */
export function evaluateAlertConditions(input: AlertRuleInput): AlertCondition[] {
  const out: AlertCondition[] = [];
  if (input.freshness === 'offline') {
    out.push({
      key: 'device-offline',
      category: 'connectivity_offline',
      level: 'critical',
      title: 'อุปกรณ์ออฟไลน์',
      message: 'ไม่ได้รับข้อมูลจากอุปกรณ์เกิน 150 วินาที ตรวจไฟเลี้ยงและ Wi-Fi',
    });
    return out;
  }
  if (input.freshness !== 'live') return out;

  const t = input.targets;
  const c = input.current;
  [
    rangeCondition('ph-range', 'ph', 'pH ', c.pH, t.phMin, t.phMax, 0.5, 2, ''),
    rangeCondition('ec-range', 'ec', 'EC ', c.ec, t.ecMin, t.ecMax, 0.5, 2, ' mS/cm'),
    rangeCondition('temp-range', 'temp', 'อุณหภูมิน้ำ', c.tempC, t.tempMin, t.tempMax, 3, 1, '°C'),
  ].forEach((x) => x && out.push(x));

  if (input.mainTankOk === false) {
    out.push({
      key: 'main-tank-low',
      category: 'tank',
      level: 'critical',
      title: 'ถังน้ำหลักน้ำต่ำ',
      message: 'ลูกลอยแจ้งว่าน้ำในถังหลักต่ำ ปั๊มหลักจะไม่ทำงานจนกว่าจะเติมน้ำ',
    });
  }

  for (const [k, lvl] of Object.entries(input.solutionLevels || {}) as [SolutionTankKey, TankLevel][]) {
    if (lvl?.status === 'ok' && lvl.isLow) {
      out.push({
        key: `solution-low-${k}`,
        category: 'fertilizer',
        level: lvl.remainingMl !== null && lvl.remainingMl <= 0 ? 'critical' : 'warning',
        title: `${TANK_NAME[k]}ใกล้หมด`,
        message: `เหลือประมาณ ${lvl.remainingMl} มล. (${lvl.pct}%) ควรเติมก่อนหมด`,
      });
    }
  }

  for (const chk of input.sensorChecks || []) {
    if (chk.sensor === 'system' || (chk.level !== 'critical' && chk.level !== 'warning')) continue;
    out.push({
      key: `sensor-${chk.id}`,
      category: 'general',
      level: chk.level,
      title: `ตรวจเซนเซอร์: ${chk.title}`,
      message: chk.advice || chk.detail,
    });
  }
  return out;
}

export interface TrackedAlert {
  condition: AlertCondition;
  firstSeen: number;
  lastSeen: number;
  seenCount: number;
  record: IssueAlertRecord; // notification count + last notification time
}

export type AlertState = Record<string, TrackedAlert>;

/**
 * Smart alert policy (owner request 2026-11-19, same as the ThingsBoard rule chain):
 *  - a problem must last ALERT_CONFIRM_MS (5 min) before the first notification
 *    (AUTO_FIX_CONFIRM_MS = 15 min for what AUTO mode fixes itself: pH both ways, EC low);
 *  - offline and main tank low notify at once (already confirmed upstream / urgent);
 *  - ONE reminder when it is still there REMIND_AFTER_MS (30 min) after it started, then silence;
 *  - "resolved" only for problems that were notified;
 *  - while data is not live (stale / offline) the other problems are held, never reported as resolved.
 */
export const ALERT_CONFIRM_MS = 5 * 60_000;
export const AUTO_FIX_CONFIRM_MS = 15 * 60_000;
export const REMIND_AFTER_MS = 30 * 60_000;

export interface TrackOptions {
  /** Board is in AUTO mode (it doses pH / EC itself, so give it time first). */
  autoMode?: boolean;
  /** Data is not live: keep problems that are not evaluated right now instead of resolving them. */
  holdMissing?: boolean;
}

function confirmDelayMs(cond: AlertCondition, autoMode: boolean): number {
  if (cond.key === 'device-offline' || cond.key === 'main-tank-low') return 0;
  if (autoMode && cond.key === 'ph-range') return AUTO_FIX_CONFIRM_MS;
  if (autoMode && cond.key === 'ec-range' && cond.title.includes('ต่ำ')) return AUTO_FIX_CONFIRM_MS;
  return ALERT_CONFIRM_MS;
}

/**
 * Folds the current conditions into the tracked state.
 * Returns the new state, the events that should notify now, and the keys that just cleared.
 */
export function trackAlerts(
  prev: AlertState,
  conditions: AlertCondition[],
  now: number,
  farmName: string,
  opts: TrackOptions = {}
): { state: AlertState; notify: RawAlertEvent[]; resolved: string[] } {
  const state: AlertState = {};
  const notify: RawAlertEvent[] = [];
  for (const cond of conditions) {
    const old = prev[cond.key];
    // a new episode when it is new or changed direction (e.g. pH low -> pH high)
    const tracked: TrackedAlert =
      old && old.condition.title === cond.title
        ? { ...old, condition: cond, lastSeen: now, seenCount: old.seenCount + 1 }
        : { condition: cond, firstSeen: now, lastSeen: now, seenCount: 1, record: { count: 0, lastAlertTs: 0 } };
    const age = now - tracked.firstSeen;
    const count = tracked.record.count;
    let message: string | null = null;
    if (count === 0 && age >= confirmDelayMs(cond, Boolean(opts.autoMode))) {
      message = cond.message;
    } else if (count === 1 && age >= REMIND_AFTER_MS && cond.key !== 'device-offline') {
      message = `ยังไม่หาย ${Math.round(age / 60_000)} นาที: ${cond.message}`;
    }
    if (message !== null) {
      notify.push({
        level: cond.level,
        category: cond.category,
        title: cond.title,
        message,
        farmName,
        timestamp: now,
        debounceKey: cond.key,
      });
      tracked.record = { count: count + 1, lastAlertTs: now };
    }
    state[cond.key] = tracked;
  }
  if (opts.holdMissing) {
    for (const k of Object.keys(prev)) if (!state[k] && k !== 'device-offline') state[k] = prev[k];
  }
  const resolved = Object.keys(prev).filter((k) => !state[k] && prev[k].record.count > 0);
  return { state, notify, resolved };
}
