import { test } from 'node:test';
import assert from 'node:assert';
import { analyzeSensorHealth, type Sample, type SensorHealthInput } from './sensorHealth.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** n samples every `stepMs`, ending at NOW, value from fn(i). */
const series = (n: number, stepMs: number, fn: (i: number) => number): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ ts: NOW - (n - 1 - i) * stepMs, value: fn(i) }));

const healthy = (): SensorHealthInput['series'] => ({
  ph: series(40, 30_000, (i) => 6.1 + Math.sin(i / 3) * 0.03),
  ec: series(40, 30_000, (i) => 1.5 + Math.cos(i / 4) * 0.02),
  temp: series(40, 30_000, (i) => 25 + Math.sin(i / 5) * 0.2),
});

const base = (over: Partial<SensorHealthInput> = {}): SensorHealthInput => ({
  now: NOW,
  freshness: 'live',
  isSim: false,
  sensorOk: true,
  current: { pH: 6.1, ec: 1.5, tempC: 25 },
  series: healthy(),
  ...over,
});

const ids = (r: ReturnType<typeof analyzeSensorHealth>) => r.checks.map((c) => c.id);

test('healthy real data -> good, score 100, every sensor reported ok', () => {
  const r = analyzeSensorHealth(base());
  assert.strictEqual(r.overall, 'good');
  assert.strictEqual(r.score, 100);
  assert.deepStrictEqual(ids(r).sort(), ['ec-ok', 'ph-ok', 'temp-ok']);
});

test('no data -> unknown (never a made-up score)', () => {
  const r = analyzeSensorHealth(base({ freshness: 'no_data', series: { ph: [], ec: [], temp: [] } }));
  assert.strictEqual(r.overall, 'unknown');
  assert.strictEqual(r.score, null);
});

test('board online but a probe sends nothing -> critical', () => {
  const r = analyzeSensorHealth(base({ current: { pH: null, ec: 1.5, tempC: 25 } }));
  assert.ok(ids(r).includes('ph-missing'));
  assert.strictEqual(r.overall, 'problem');
});

test('impossible and implausible values are flagged', () => {
  assert.ok(ids(analyzeSensorHealth(base({ current: { pH: 15.2, ec: 1.5, tempC: 25 } }))).includes('ph-impossible'));
  assert.ok(ids(analyzeSensorHealth(base({ current: { pH: 11.4, ec: 1.5, tempC: 25 } }))).includes('ph-implausible'));
  assert.ok(ids(analyzeSensorHealth(base({ current: { pH: 6, ec: 1.5, tempC: 70 } }))).includes('temp-impossible'));
});

test('flat-line for 30+ minutes -> stuck probe warning; short windows are not judged', () => {
  const s = healthy();
  s.ph = series(70, 30_000, () => 7.0); // 34.5 minutes perfectly constant
  assert.ok(ids(analyzeSensorHealth(base({ series: s, current: { pH: 7, ec: 1.5, tempC: 25 } }))).includes('ph-flat'));
  s.ph = series(10, 30_000, () => 7.0); // only 4.5 minutes
  assert.ok(!ids(analyzeSensorHealth(base({ series: s, current: { pH: 7, ec: 1.5, tempC: 25 } }))).includes('ph-flat'));
});

test('spikes between close readings -> loose wire / noise warning', () => {
  const s = healthy();
  s.ec = series(40, 30_000, (i) => (i === 10 || i === 25 ? 3.2 : 1.5));
  assert.ok(ids(analyzeSensorHealth(base({ series: s }))).includes('ec-spikes'));
});

test('acid dosed twice but pH did not fall -> no-response warning; a response clears it', () => {
  const doseAt = [NOW - 100 * MIN, NOW - 60 * MIN];
  const counter: Sample[] = [
    { ts: NOW - 120 * MIN, value: 10 },
    { ts: doseAt[0], value: 12 },
    { ts: doseAt[1], value: 14 },
    { ts: NOW, value: 14 },
  ];
  const s = healthy();
  s.ph = series(240, 30_000, (i) => 7.2 + Math.sin(i) * 0.005); // never falls
  let r = analyzeSensorHealth(base({ series: s, current: { pH: 7.2, ec: 1.5, tempC: 25 }, runtime: { phDown: counter } }));
  assert.ok(ids(r).includes('ph-no-response-down'));

  s.ph = s.ph.map((p) => ({ ...p, value: p.ts > doseAt[1] + 4 * MIN ? 6.6 : p.ts > doseAt[0] + 4 * MIN ? 6.9 : 7.2 }));
  r = analyzeSensorHealth(base({ series: s, current: { pH: 6.6, ec: 1.5, tempC: 25 }, runtime: { phDown: counter } }));
  assert.ok(!ids(r).includes('ph-no-response-down'));
});

test('offline, simulated board and missing temperature are reported honestly', () => {
  const r = analyzeSensorHealth(base({ freshness: 'offline', isSim: true }));
  assert.ok(ids(r).includes('sys-offline'));
  assert.ok(ids(r).includes('sys-sim'));
  const t = analyzeSensorHealth(base({ current: { pH: 6.1, ec: 1.5, tempC: null } }));
  assert.ok(ids(t).includes('temp-missing'));
  assert.ok(ids(t).includes('temp-compensation'));
});
