/**
 * Nutrient / pH solution tank tracker ("Soft Sensor") — no level sensors exist for these tanks,
 * so the remaining volume is CALCULATED from real data only:
 *
 *   remaining = volume recorded at the last refill
 *             - (pump run-time since that refill  x  the pump's measured flow rate)
 *
 * - Pump run-time comes from the board's cumulative counters (telemetry run_a / run_b /
 *   run_ph_up / run_ph_down, seconds). They count every real pump run: manual presses in the app,
 *   AUTO dosing, and runs while the phone app was closed.
 * - The flow rate (ml per second) is measured by the user once per pump (run 10 s into a measuring
 *   cup, enter the ml). There is NO built-in default flow rate: until it is measured, the remaining
 *   volume is unknown and shown as "--".
 * - Records are stored on the device in ThingsBoard (server attribute `solution_tanks`), so every
 *   phone of the owner sees the same numbers.
 */

export type SolutionTankKey = 'fertA' | 'fertB' | 'phDown' | 'phUp';
export const SOLUTION_TANK_KEYS: SolutionTankKey[] = ['fertA', 'fertB', 'phDown', 'phUp'];

/** Telemetry key of the cumulative run-time counter (seconds) of the pump that empties each tank. */
export const TANK_RUNTIME_KEY: Record<SolutionTankKey, string> = {
  fertA: 'run_a',
  fertB: 'run_b',
  phDown: 'run_ph_down',
  phUp: 'run_ph_up',
};

/** RPC pump name (contract §4) for each tank, used to run the pump during flow calibration. */
export const TANK_PUMP_RPC: Record<SolutionTankKey, string> = {
  fertA: 'A',
  fertB: 'B',
  phDown: 'phDown',
  phUp: 'phUp',
};

export const SOLUTION_ATTRIBUTE_KEY = 'solution_tanks';
export const CALIBRATION_SECONDS = 10;
const MAX_CAPACITY_ML = 200000;
const MAX_FLOW_ML_PER_S = 50;

export interface TankRecord {
  capacityMl: number;
  /** Volume in the tank right after the last refill. */
  volumeMl: number;
  /** Pump run-time counter (s) at the moment of that refill; null = board did not report it yet. */
  runAtRefillS: number | null;
  refilledAt: number;
  /** Measured pump flow (ml/s); null = not measured yet. */
  flowMlPerS: number | null;
  flowMeasuredAt: number | null;
}

export type SolutionTanks = Partial<Record<SolutionTankKey, TankRecord>>;

export type TankStatus =
  | 'not_set' // no refill recorded yet
  | 'needs_flow' // refill recorded, pump flow not measured yet
  | 'waiting_runtime' // board has not reported its pump run-time counter yet (old firmware / offline)
  | 'counter_reset' // board counter went backwards (factory reset) -> record a refill again
  | 'ok';

export interface TankLevel {
  status: TankStatus;
  capacityMl: number | null;
  remainingMl: number | null;
  usedMl: number | null;
  pct: number | null;
  flowMlPerS: number | null;
  refilledAt: number | null;
  isLow: boolean;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Parses the `solution_tanks` attribute (object or JSON string); drops anything malformed. */
export function parseSolutionTanks(raw: unknown): SolutionTanks {
  let obj: any = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object') return {};
  const out: SolutionTanks = {};
  for (const key of SOLUTION_TANK_KEYS) {
    const r = obj[key];
    if (!r || typeof r !== 'object') continue;
    const capacityMl = finite(r.capacityMl);
    const volumeMl = finite(r.volumeMl);
    const refilledAt = finite(r.refilledAt);
    if (capacityMl === null || capacityMl <= 0 || capacityMl > MAX_CAPACITY_ML) continue;
    if (volumeMl === null || volumeMl < 0 || refilledAt === null) continue;
    const flow = finite(r.flowMlPerS);
    out[key] = {
      capacityMl,
      volumeMl: Math.min(volumeMl, capacityMl),
      runAtRefillS: finite(r.runAtRefillS),
      refilledAt,
      flowMlPerS: flow !== null && flow > 0 && flow <= MAX_FLOW_ML_PER_S ? flow : null,
      flowMeasuredAt: finite(r.flowMeasuredAt),
    };
  }
  return out;
}

/** Current level of one tank from its record and the board's current run-time counter (seconds). */
export function computeTankLevel(record: TankRecord | undefined, runNowS: number | null): TankLevel {
  const empty: TankLevel = {
    status: 'not_set',
    capacityMl: null,
    remainingMl: null,
    usedMl: null,
    pct: null,
    flowMlPerS: null,
    refilledAt: null,
    isLow: false,
  };
  if (!record) return empty;
  if (!hasRefill(record)) return { ...empty, flowMlPerS: record.flowMlPerS };
  const base = { ...empty, capacityMl: record.capacityMl, flowMlPerS: record.flowMlPerS, refilledAt: record.refilledAt };
  if (record.flowMlPerS === null) return { ...base, status: 'needs_flow' };
  if (runNowS === null || record.runAtRefillS === null) return { ...base, status: 'waiting_runtime' };
  const runSince = runNowS - record.runAtRefillS;
  if (runSince < -0.05) return { ...base, status: 'counter_reset' };
  const usedMl = Math.max(0, runSince) * record.flowMlPerS;
  const remainingMl = Math.max(0, record.volumeMl - usedMl);
  const pct = Math.round((remainingMl / record.capacityMl) * 100);
  return {
    ...base,
    status: 'ok',
    usedMl: Math.round(usedMl),
    remainingMl: Math.round(remainingMl),
    pct: Math.min(100, Math.max(0, pct)),
    isLow: pct <= 20 || remainingMl <= 100,
  };
}

/** New record after the user poured `addedMl` into the tank. Unknown current level counts as empty. */
export function applyRefill(
  record: TankRecord | undefined,
  level: TankLevel,
  addedMl: number,
  capacityMl: number,
  runNowS: number | null,
  now = Date.now()
): TankRecord {
  const cap = Math.min(MAX_CAPACITY_ML, Math.max(1, Math.round(capacityMl)));
  const before = level.status === 'ok' && level.remainingMl !== null ? level.remainingMl : 0;
  const added = Number.isFinite(addedMl) && addedMl > 0 ? addedMl : 0;
  return {
    capacityMl: cap,
    volumeMl: Math.round(Math.min(cap, before + added)),
    runAtRefillS: runNowS,
    refilledAt: now,
    flowMlPerS: record?.flowMlPerS ?? null,
    flowMeasuredAt: record?.flowMeasuredAt ?? null,
  };
}

/**
 * Stores a measured flow rate. Re-bases the record at the current counter so the volume already used
 * (computed with the old/unknown rate) is kept, and later runs use the new rate.
 */
export function applyFlowCalibration(
  record: TankRecord | undefined,
  level: TankLevel,
  measuredMl: number,
  seconds: number,
  runNowS: number | null,
  now = Date.now()
): TankRecord | null {
  if (!(measuredMl > 0) || !(seconds > 0)) return null;
  const flow = measuredMl / seconds;
  if (flow > MAX_FLOW_ML_PER_S) return null;
  const rounded = Math.round(flow * 1000) / 1000;
  if (!record) {
    // Flow measured before the first refill: keep it, the tank level stays unknown until a refill.
    return { capacityMl: 1000, volumeMl: 0, runAtRefillS: runNowS, refilledAt: 0, flowMlPerS: rounded, flowMeasuredAt: now };
  }
  // Volume left right now: computed with the old rate if it was known; otherwise everything pumped
  // since the refill (including the calibration run itself) is charged at the newly measured rate.
  let keepVolume = record.volumeMl;
  if (level.status === 'ok' && level.remainingMl !== null) {
    keepVolume = level.remainingMl;
  } else if (runNowS !== null && record.runAtRefillS !== null && runNowS >= record.runAtRefillS) {
    keepVolume = Math.max(0, Math.round(record.volumeMl - (runNowS - record.runAtRefillS) * rounded));
  }
  return {
    ...record,
    volumeMl: keepVolume,
    runAtRefillS: runNowS ?? record.runAtRefillS,
    flowMlPerS: rounded,
    flowMeasuredAt: now,
  };
}

/** A record created only to hold a flow rate (no refill recorded yet) is not a real tank level. */
export function hasRefill(record: TankRecord | undefined): boolean {
  return Boolean(record && record.refilledAt > 0);
}
