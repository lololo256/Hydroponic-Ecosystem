import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeFreshness,
  extractLatest,
  finiteOrNull,
  boolOrNull,
  modeOrNull,
  clampPumpSeconds,
  getEffectiveTargets,
  parseSnakeTargets,
  resolveTargetsFromAttributes,
  toSharedTargetAttributes,
  mainTankStatusLabel,
  FIRMWARE_DEFAULT_TARGETS,
} from './telemetryContract.ts';

describe('Data Contract v3 helpers', () => {
  it('freshness: live <=75s, stale <=150s, offline >150s, no_data, future ts = age 0', () => {
    const now = 1_000_000_000;
    assert.strictEqual(computeFreshness(0, now), 'no_data');
    assert.strictEqual(computeFreshness(null, now), 'no_data');
    assert.strictEqual(computeFreshness(now - 75_000, now), 'live');
    assert.strictEqual(computeFreshness(now - 75_001, now), 'stale');
    assert.strictEqual(computeFreshness(now - 150_000, now), 'stale');
    assert.strictEqual(computeFreshness(now - 150_001, now), 'offline');
    assert.strictEqual(computeFreshness(now + 60_000, now), 'live');
  });

  it('finiteOrNull never returns NaN and rejects booleans / empty strings', () => {
    assert.strictEqual(finiteOrNull('6.25'), 6.25);
    assert.strictEqual(finiteOrNull(0), 0);
    assert.strictEqual(finiteOrNull('abc'), null);
    assert.strictEqual(finiteOrNull(''), null);
    assert.strictEqual(finiteOrNull(NaN), null);
    assert.strictEqual(finiteOrNull(true), null);
    assert.strictEqual(finiteOrNull(undefined), null);
  });

  it('bool / mode parsing returns null for unknown values', () => {
    assert.strictEqual(boolOrNull('true'), true);
    assert.strictEqual(boolOrNull(false), false);
    assert.strictEqual(boolOrNull(undefined), null);
    assert.strictEqual(modeOrNull('manual'), 'MANUAL');
    assert.strictEqual(modeOrNull('x'), null);
  });

  it('extractLatest treats keys much older than the newest ts as absent', () => {
    const t = 2_000_000_000;
    const { latestTs, values } = extractLatest({
      ph: [{ ts: t - 3_600_000, value: '6.1' }],
      ec: [{ ts: t, value: '1.5' }],
      temp: [{ ts: t - 30_000, value: '24.5' }],
    });
    assert.strictEqual(latestTs, t);
    assert.strictEqual(values.ph, undefined);
    assert.strictEqual(values.ec, '1.5');
    assert.strictEqual(values.temp, '24.5');
  });

  it('pump seconds: 0 stops, chemical capped at 10, main capped at 300', () => {
    assert.strictEqual(clampPumpSeconds('fertPumpAOn', 0), 0);
    assert.strictEqual(clampPumpSeconds('fertPumpAOn', 60), 10);
    assert.strictEqual(clampPumpSeconds('phUpPumpOn', undefined), 5);
    assert.strictEqual(clampPumpSeconds('mainPumpOn', 9999), 300);
    assert.strictEqual(clampPumpSeconds('mainPumpOn', 0.4), 1);
  });

  it('targets: snake attrs, targets_applied string/object, defaults', () => {
    assert.deepStrictEqual(toSharedTargetAttributes({ phMin: 5.6, ecMax: 2 }), { ph_min: 5.6, ec_max: 2 });
    assert.deepStrictEqual(parseSnakeTargets('{"ph_min":"5.90","ph_max":"6.40"}'), { phMin: 5.9, phMax: 6.4 });
    const r = resolveTargetsFromAttributes({ ph_min: 5.5, targets_applied: { ph_min: 5.7 } });
    assert.strictEqual(r.source, 'device');
    assert.strictEqual(r.targets.phMin, 5.7);
    assert.deepStrictEqual(getEffectiveTargets({}), FIRMWARE_DEFAULT_TARGETS);
    assert.strictEqual(getEffectiveTargets({ targetPHMin: 6.0 }).phMin, 6.0);
  });

  it('main tank label', () => {
    assert.strictEqual(mainTankStatusLabel(true), 'ปกติ');
    assert.strictEqual(mainTankStatusLabel(false), 'น้ำต่ำ');
    assert.strictEqual(mainTankStatusLabel(null), '--');
  });
});

describe('parseAutoCycle (AUTO dosing cycle)', () => {
  it('returns null when the board does not report it (older firmware)', async () => {
    const { parseAutoCycle } = await import('./telemetryContract');
    assert.strictEqual(parseAutoCycle({}, 1000), null);
    assert.strictEqual(parseAutoCycle({ auto_phase: 'weird' }, 1000), null);
  });
  it('maps dosing pumps in order and keeps the reason', async () => {
    const { parseAutoCycle } = await import('./telemetryContract');
    const c = parseAutoCycle({ auto_phase: 'dosing', auto_pumps: 'phDown,A,B,X', auto_reason: 'pH 7.10 > 6.50' }, 1000);
    assert.deepStrictEqual(c, {
      phase: 'dosing',
      pumps: ['phDownPumpOn', 'fertPumpAOn', 'fertPumpBOn'],
      reason: 'pH 7.10 > 6.50',
      mixEndsAt: null,
    });
  });
  it('computes the mixing end from the telemetry ts', async () => {
    const { parseAutoCycle } = await import('./telemetryContract');
    const c = parseAutoCycle({ auto_phase: 'mixing', auto_pumps: 'A,B', auto_mix_left: 120 }, 10_000);
    assert.strictEqual(c?.mixEndsAt, 130_000);
  });
  it('idle shows nothing', async () => {
    const { parseAutoCycle } = await import('./telemetryContract');
    const c = parseAutoCycle({ auto_phase: 'idle', auto_pumps: 'A', auto_reason: 'x' }, 1);
    assert.deepStrictEqual(c, { phase: 'idle', pumps: [], reason: null, mixEndsAt: null });
  });
});
