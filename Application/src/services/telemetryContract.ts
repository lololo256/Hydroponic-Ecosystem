/**
 * Data Contract v3 helpers (Firmware <-> ThingsBoard <-> App).
 * Source of truth: To-dolist/CONTRACT_v3.md
 *
 * Pure functions only (no React / Capacitor imports) so they can be unit tested
 * with `node --test` and shared by context, screens and the AI engines.
 */

/* ---------------------------------------------------------------- */
/* §1 Telemetry keys                                                 */
/* ---------------------------------------------------------------- */

export const TELEMETRY_KEYS = [
  'ph',
  'ec',
  'tds',
  'temp',
  'tank_main_ok',
  'pump_main',
  'pump_a',
  'pump_b',
  'pump_ph_up',
  'pump_ph_down',
  'mode',
  'sensor_ok',
  'sim',
  // Cumulative pump run-time counters (seconds) — used to calculate solution usage.
  'run_a',
  'run_b',
  'run_ph_up',
  'run_ph_down',
  // AUTO dosing cycle reported by the board (doses last 2 s, the app polls every 15 s, so the cycle
  // phase is what the app can show reliably): see parseAutoCycle().
  'auto_phase',
  'auto_pumps',
  'auto_reason',
  'auto_mix_left',
] as const;

export type TelemetryKey = (typeof TELEMETRY_KEYS)[number];

/* ---------------------------------------------------------------- */
/* §6 Freshness thresholds (age of the board's own `ts`)             */
/* ---------------------------------------------------------------- */

export const FRESHNESS_LIVE_MAX_MS = 75_000;
export const FRESHNESS_STALE_MAX_MS = 150_000;

export type TelemetryFreshness = 'loading' | 'live' | 'stale' | 'offline' | 'no_data';

/** Age of a board timestamp. Future timestamps (clock skew) count as age 0. */
export function telemetryAgeMs(ts: number | null | undefined, now: number = Date.now()): number | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  return Math.max(0, now - ts);
}

export function computeFreshness(ts: number | null | undefined, now: number = Date.now()): TelemetryFreshness {
  const age = telemetryAgeMs(ts, now);
  if (age === null) return 'no_data';
  if (age <= FRESHNESS_LIVE_MAX_MS) return 'live';
  if (age <= FRESHNESS_STALE_MAX_MS) return 'stale';
  return 'offline';
}

/* ---------------------------------------------------------------- */
/* Value parsing                                                     */
/* ---------------------------------------------------------------- */

/** Finite number or null. Never returns NaN / Infinity. Booleans are rejected. */
export function finiteOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Strict boolean parse: true/false/"true"/"false"/1/0, anything else -> null. */
export function boolOrNull(raw: unknown): boolean | null {
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  return null;
}

export function modeOrNull(raw: unknown): 'AUTO' | 'MANUAL' | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  return t === 'AUTO' || t === 'MANUAL' ? t : null;
}

export interface TBValue {
  ts: number;
  value: unknown;
}

/**
 * Pick the latest value of each key and the newest board timestamp.
 * A key whose own `ts` is older than the newest ts by more than `maxLagMs`
 * is treated as ABSENT (ThingsBoard keeps the last value forever, but the
 * firmware stops sending a key when the sensor becomes invalid).
 */
export function extractLatest(
  telemetry: Record<string, TBValue[] | undefined> | null | undefined,
  keys: readonly string[] = TELEMETRY_KEYS,
  maxLagMs: number = FRESHNESS_STALE_MAX_MS
): { latestTs: number; values: Record<string, unknown> } {
  let latestTs = 0;
  const raw: Record<string, TBValue> = {};
  if (telemetry && typeof telemetry === 'object') {
    for (const k of keys) {
      const arr = telemetry[k];
      if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0].ts === 'number') {
        raw[k] = arr[0];
        if (arr[0].ts > latestTs) latestTs = arr[0].ts;
      }
    }
  }
  const values: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) {
    if (latestTs - raw[k].ts <= maxLagMs) values[k] = raw[k].value;
  }
  return { latestTs, values };
}

/* ---------------------------------------------------------------- */
/* §3 Targets                                                        */
/* ---------------------------------------------------------------- */

export interface FarmTargets {
  phMin: number;
  phMax: number;
  ecMin: number;
  ecMax: number;
  tempMin: number;
  tempMax: number;
}

export type TargetsSource = 'device' | 'requested' | 'default';

/**
 * Defaults the firmware itself applies when nothing is stored in NVS
 * (smart_water_farm_28_display.ino: prefs.getFloat("ph_min", 5.8) ...).
 * Used only when neither `targets_applied` nor shared attributes exist.
 */
export const FIRMWARE_DEFAULT_TARGETS: FarmTargets = {
  phMin: 5.8,
  phMax: 6.5,
  ecMin: 1.4,
  ecMax: 1.8,
  tempMin: 22.0,
  tempMax: 28.0,
};

const SNAKE: Record<keyof FarmTargets, string> = {
  phMin: 'ph_min',
  phMax: 'ph_max',
  ecMin: 'ec_min',
  ecMax: 'ec_max',
  tempMin: 'temp_min',
  tempMax: 'temp_max',
};

export const TARGET_ATTRIBUTE_KEYS = Object.values(SNAKE);

/** Convert app targets to contract shared attributes (`ph_min`...). Undefined fields are skipped. */
export function toSharedTargetAttributes(t: Partial<FarmTargets>): Record<string, number> {
  const out: Record<string, number> = {};
  (Object.keys(SNAKE) as Array<keyof FarmTargets>).forEach((k) => {
    const v = finiteOrNull(t[k]);
    if (v !== null) out[SNAKE[k]] = v;
  });
  return out;
}

/** Parse a snake_case target object (targets_applied may arrive as object or JSON string). */
export function parseSnakeTargets(raw: unknown): Partial<FarmTargets> {
  let obj: any = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object') return {};
  const out: Partial<FarmTargets> = {};
  (Object.keys(SNAKE) as Array<keyof FarmTargets>).forEach((k) => {
    const v = finiteOrNull(obj[SNAKE[k]]);
    if (v !== null) out[k] = v;
  });
  return out;
}

/**
 * Resolve targets from attributes: `targets_applied` (board confirmed) ->
 * shared `ph_min..` (requested by app) -> firmware defaults.
 */
export function resolveTargetsFromAttributes(attrMap: Record<string, unknown>): {
  targets: FarmTargets;
  source: TargetsSource;
} {
  const applied = parseSnakeTargets(attrMap['targets_applied']);
  const requested = parseSnakeTargets(attrMap);
  const hasApplied = Object.keys(applied).length > 0;
  const hasRequested = Object.keys(requested).length > 0;
  return {
    targets: { ...FIRMWARE_DEFAULT_TARGETS, ...requested, ...applied },
    source: hasApplied ? 'device' : hasRequested ? 'requested' : 'default',
  };
}

/**
 * The ONE helper every screen / engine uses for target ranges.
 * Accepts the context data shape (targetPHMin...) and falls back to firmware defaults.
 */
export function getEffectiveTargets(data: {
  targetPHMin?: number | null;
  targetPHMax?: number | null;
  targetECMin?: number | null;
  targetECMax?: number | null;
  targetTempMin?: number | null;
  targetTempMax?: number | null;
} | null | undefined): FarmTargets {
  const d = data || {};
  const pick = (v: unknown, fb: number) => {
    const n = finiteOrNull(v);
    return n === null ? fb : n;
  };
  return {
    phMin: pick(d.targetPHMin, FIRMWARE_DEFAULT_TARGETS.phMin),
    phMax: pick(d.targetPHMax, FIRMWARE_DEFAULT_TARGETS.phMax),
    ecMin: pick(d.targetECMin, FIRMWARE_DEFAULT_TARGETS.ecMin),
    ecMax: pick(d.targetECMax, FIRMWARE_DEFAULT_TARGETS.ecMax),
    tempMin: pick(d.targetTempMin, FIRMWARE_DEFAULT_TARGETS.tempMin),
    tempMax: pick(d.targetTempMax, FIRMWARE_DEFAULT_TARGETS.tempMax),
  };
}

/* ---------------------------------------------------------------- */
/* §4 Pumps                                                          */
/* ---------------------------------------------------------------- */

export type PumpKey = 'mainPumpOn' | 'fertPumpAOn' | 'fertPumpBOn' | 'phDownPumpOn' | 'phUpPumpOn';

export const PUMP_RPC_NAME: Record<PumpKey, 'main' | 'A' | 'B' | 'phUp' | 'phDown'> = {
  mainPumpOn: 'main',
  fertPumpAOn: 'A',
  fertPumpBOn: 'B',
  phUpPumpOn: 'phUp',
  phDownPumpOn: 'phDown',
};

export const PUMP_TELEMETRY_KEY: Record<PumpKey, TelemetryKey> = {
  mainPumpOn: 'pump_main',
  fertPumpAOn: 'pump_a',
  fertPumpBOn: 'pump_b',
  phUpPumpOn: 'pump_ph_up',
  phDownPumpOn: 'pump_ph_down',
};

export const MAIN_PUMP_MAX_SECONDS = 300;
export const CHEM_PUMP_MAX_SECONDS = 10;
export const MAIN_PUMP_DEFAULT_SECONDS = 300;
export const CHEM_PUMP_DEFAULT_SECONDS = 5;

export function isChemicalPump(k: PumpKey): boolean {
  return k !== 'mainPumpOn';
}

/* ---------------------------------------------------------------- */
/* §7 AUTO dosing cycle (telemetry auto_phase / auto_pumps / ...)    */
/* ---------------------------------------------------------------- */

export type AutoPhase = 'idle' | 'dosing' | 'mixing';

export interface AutoCycle {
  phase: AutoPhase;
  /** Pumps of the current cycle, in dosing order (board RPC names mapped to PumpKey). */
  pumps: PumpKey[];
  /** Why the board dosed, e.g. "pH 7.10 > 6.50". null when not reported. */
  reason: string | null;
  /** Epoch ms when mixing ends (board's seconds-left + the telemetry ts). null when not mixing. */
  mixEndsAt: number | null;
}

const RPC_TO_PUMP: Record<string, PumpKey> = {
  main: 'mainPumpOn',
  A: 'fertPumpAOn',
  B: 'fertPumpBOn',
  phUp: 'phUpPumpOn',
  phDown: 'phDownPumpOn',
};

/**
 * Parse the board's AUTO cycle. Returns null when the board does not report it (older firmware)
 * — the UI then shows nothing rather than guessing.
 */
export function parseAutoCycle(values: Record<string, unknown>, telemetryTs: number): AutoCycle | null {
  const p = values['auto_phase'];
  if (p !== 'idle' && p !== 'dosing' && p !== 'mixing') return null;
  const pumps: PumpKey[] = [];
  const rawPumps = values['auto_pumps'];
  if (typeof rawPumps === 'string') {
    rawPumps.split(',').forEach((s) => {
      const k = RPC_TO_PUMP[s.trim()];
      if (k && !pumps.includes(k)) pumps.push(k);
    });
  }
  const reason = typeof values['auto_reason'] === 'string' && values['auto_reason'].trim() ? values['auto_reason'].trim() : null;
  const left = finiteOrNull(values['auto_mix_left']);
  const mixEndsAt = p === 'mixing' && left !== null && left >= 0 && telemetryTs > 0 ? telemetryTs + left * 1000 : null;
  return { phase: p, pumps: p === 'idle' ? [] : pumps, reason: p === 'idle' ? null : reason, mixEndsAt };
}

/** Clamp requested run seconds to the firmware limits. 0 means "stop now". */
export function clampPumpSeconds(k: PumpKey, seconds: number | undefined): number {
  const max = isChemicalPump(k) ? CHEM_PUMP_MAX_SECONDS : MAIN_PUMP_MAX_SECONDS;
  const def = isChemicalPump(k) ? CHEM_PUMP_DEFAULT_SECONDS : MAIN_PUMP_DEFAULT_SECONDS;
  const n = finiteOrNull(seconds);
  if (n === null) return def;
  if (n <= 0) return 0;
  return Math.min(max, Math.max(1, Math.round(n)));
}

/* ---------------------------------------------------------------- */
/* Main tank float switch                                            */
/* ---------------------------------------------------------------- */

export function mainTankStatusLabel(ok: boolean | null | undefined): string {
  if (ok === true) return 'ปกติ';
  if (ok === false) return 'น้ำต่ำ';
  return '--';
}

/** Format a nullable number; returns `--` when missing. */
export function fmt(v: number | null | undefined, digits = 1): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '--';
}
