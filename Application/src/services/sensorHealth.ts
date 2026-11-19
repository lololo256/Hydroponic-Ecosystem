/**
 * Sensor health analysis ("AI ตรวจสุขภาพเซนเซอร์").
 *
 * An on-device expert system: it runs only on REAL telemetry from ThingsBoard (no API key, no cloud
 * cost, nothing leaves the phone) and looks for patterns a person scanning a chart easily misses:
 *   - probe missing / unreadable while the board is online
 *   - physically implausible values (calibration / wiring problem)
 *   - flat-line (a real probe in water never stays perfectly constant -> stuck / in air / broken wire)
 *   - spikes (loose connector, electrical noise)
 *   - no response to dosing (acid dosed but pH did not fall -> empty tank, clogged line, worn probe)
 * When there is not enough data it says so ("unknown") instead of guessing.
 */

export type HealthLevel = 'ok' | 'info' | 'warning' | 'critical';
export type SensorId = 'ph' | 'ec' | 'temp' | 'system';

export interface Sample {
  ts: number;
  value: number;
}

export interface HealthCheck {
  id: string;
  sensor: SensorId;
  level: HealthLevel;
  title: string;
  detail: string;
  advice?: string;
}

export interface SensorHealthInput {
  now: number;
  freshness: 'loading' | 'live' | 'stale' | 'offline' | 'no_data';
  isSim: boolean;
  sensorOk: boolean | null;
  current: { pH: number | null; ec: number | null; tempC: number | null };
  /** Recent raw samples (any order). */
  series: { ph: Sample[]; ec: Sample[]; temp: Sample[] };
  /** Cumulative pump run-time counters (seconds) over the same window, to find dosing events. */
  runtime?: { phDown?: Sample[]; phUp?: Sample[]; fertA?: Sample[]; fertB?: Sample[] };
}

export interface SensorHealthReport {
  overall: 'good' | 'attention' | 'problem' | 'unknown';
  score: number | null;
  checks: HealthCheck[];
  sampleCount: number;
}

const SENSOR_LABEL: Record<Exclude<SensorId, 'system'>, string> = { ph: 'pH', ec: 'EC', temp: 'อุณหภูมิน้ำ' };

interface SensorRules {
  hardMin: number;
  hardMax: number;
  softMin: number;
  softMax: number;
  flatEps: number;
  spike: number;
  unit: string;
  digits: number;
}

const RULES: Record<'ph' | 'ec' | 'temp', SensorRules> = {
  ph: { hardMin: 0, hardMax: 14, softMin: 3, softMax: 10, flatEps: 0.006, spike: 0.6, unit: '', digits: 2 },
  ec: { hardMin: 0, hardMax: 20, softMin: 0.05, softMax: 6, flatEps: 0.006, spike: 0.6, unit: ' mS/cm', digits: 2 },
  temp: { hardMin: -5, hardMax: 60, softMin: 5, softMax: 42, flatEps: 0.05, spike: 4, unit: '°C', digits: 1 },
};

const FLAT_MIN_SAMPLES = 8;
const FLAT_MIN_SPAN_MS = 30 * 60 * 1000;
const SPIKE_MAX_GAP_MS = 5 * 60 * 1000;
const DOSE_SETTLE_MS = 5 * 60 * 1000;
const DOSE_WINDOW_MS = 15 * 60 * 1000;

const sorted = (s: Sample[] = []) =>
  s.filter((x) => Number.isFinite(x.value) && Number.isFinite(x.ts)).sort((a, b) => a.ts - b.ts);

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const fmt = (v: number, r: SensorRules) => `${v.toFixed(r.digits)}${r.unit}`;

function checkSensor(id: 'ph' | 'ec' | 'temp', current: number | null, raw: Sample[], live: boolean): HealthCheck[] {
  const r = RULES[id];
  const label = SENSOR_LABEL[id];
  const s = sorted(raw);
  const out: HealthCheck[] = [];

  if (live && current === null) {
    out.push({
      id: `${id}-missing`,
      sensor: id,
      level: 'critical',
      title: `${label}: อุปกรณ์ออนไลน์แต่ไม่ส่งค่า`,
      detail: 'อุปกรณ์ไม่ส่งค่าเซนเซอร์นี้ เพราะอ่านไม่ได้หรือค่าอยู่นอกช่วงที่เชื่อถือได้',
      advice: 'ตรวจสายและขั้วต่อหัววัด และดูว่าหัววัดจุ่มอยู่ในน้ำ',
    });
    return out;
  }

  const values = s.map((x) => x.value);
  const latest = current ?? (values.length ? values[values.length - 1] : null);
  if (latest !== null) {
    if (latest < r.hardMin || latest > r.hardMax) {
      out.push({
        id: `${id}-impossible`,
        sensor: id,
        level: 'critical',
        title: `${label}: ค่า ${fmt(latest, r)} เป็นไปไม่ได้ทางกายภาพ`,
        detail: 'ค่าแบบนี้เกิดจากวงจรหรือการคาลิเบรตผิด ไม่ใช่ค่าน้ำจริง',
        advice: id === 'ph' ? 'คาลิเบรต pH ใหม่ด้วยน้ำยาบัฟเฟอร์ pH 7 และ pH 4' : 'ตรวจการต่อสายและแรงดันไฟเลี้ยงหัววัด',
      });
    } else if (latest < r.softMin || latest > r.softMax) {
      out.push({
        id: `${id}-implausible`,
        sensor: id,
        level: 'warning',
        title: `${label}: ค่า ${fmt(latest, r)} ผิดปกติมากสำหรับระบบไฮโดรโปนิกส์`,
        detail: 'ถ้าน้ำไม่ได้มีปัญหาจริง มักเกิดจากหัววัดเสื่อม ยังไม่ได้คาลิเบรต หรือหัววัดไม่ได้จุ่มน้ำ',
        advice: id === 'ph' ? 'ทดสอบด้วยน้ำยาบัฟเฟอร์ ถ้าอ่านเพี้ยนให้คาลิเบรตใหม่' : 'ตรวจด้วยเครื่องวัดมือถือเทียบ 1 ครั้ง',
      });
    }
  }

  // Flat-line: a real probe in water always shows small fluctuations.
  if (s.length >= FLAT_MIN_SAMPLES && s[s.length - 1].ts - s[0].ts >= FLAT_MIN_SPAN_MS) {
    const range = Math.max(...values) - Math.min(...values);
    if (range < r.flatEps) {
      const minutes = Math.round((s[s.length - 1].ts - s[0].ts) / 60000);
      out.push({
        id: `${id}-flat`,
        sensor: id,
        level: 'warning',
        title: `${label}: ค่านิ่งสนิท ${minutes} นาที`,
        detail: `อ่านได้ ${fmt(values[values.length - 1], r)} ตลอด ${s.length} ครั้ง ซึ่งหัววัดจริงในน้ำไม่ควรนิ่งขนาดนี้`,
        advice: 'หัววัดอาจค้าง ลอยอยู่ในอากาศ หรือสายขาด ให้ยกหัววัดขึ้นแล้วจุ่มใหม่ ดูว่าค่าขยับไหม',
      });
    }
  }

  // Spikes between close-by readings.
  let jumps = 0;
  let worst = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i].ts - s[i - 1].ts > SPIKE_MAX_GAP_MS) continue;
    const d = Math.abs(s[i].value - s[i - 1].value);
    if (d >= r.spike) {
      jumps++;
      worst = Math.max(worst, d);
    }
  }
  if (jumps >= 2) {
    out.push({
      id: `${id}-spikes`,
      sensor: id,
      level: 'warning',
      title: `${label}: ค่ากระโดด ${jumps} ครั้ง (สูงสุด ${fmt(worst, r)})`,
      detail: 'ค่าเปลี่ยนเร็วเกินกว่าน้ำจริงจะเปลี่ยนได้ในเวลาไม่กี่นาที',
      advice: 'ตรวจขั้วต่อสายหลวม และให้สายหัววัดอยู่ห่างสายปั๊มหรือสายไฟ 220V',
    });
  }

  if (!out.length && s.length >= 3) {
    out.push({
      id: `${id}-ok`,
      sensor: id,
      level: 'ok',
      title: `${label}: ทำงานปกติ`,
      detail: `ค่าล่าสุด ${latest !== null ? fmt(latest, r) : '--'} จาก ${s.length} ครั้งล่าสุด ไม่พบรูปแบบผิดปกติ`,
    });
  }
  return out;
}

/** Dosing events = increases of a cumulative run-time counter. */
function doseTimes(counter: Sample[] = []): number[] {
  const s = sorted(counter);
  const times: number[] = [];
  for (let i = 1; i < s.length; i++) if (s[i].value - s[i - 1].value >= 0.5) times.push(s[i].ts);
  return times;
}

function checkDosingResponse(
  sensor: 'ph' | 'ec',
  doses: number[],
  series: Sample[],
  expect: 'down' | 'up',
  now: number,
  what: string,
  idSuffix: string
): HealthCheck | null {
  const s = sorted(series);
  const evaluated: boolean[] = [];
  for (const t of doses) {
    if (now - t < DOSE_WINDOW_MS) continue; // too recent to judge (still mixing)
    const before = median(s.filter((x) => x.ts <= t && x.ts > t - DOSE_SETTLE_MS).map((x) => x.value));
    const after = median(s.filter((x) => x.ts >= t + DOSE_SETTLE_MS && x.ts <= t + DOSE_WINDOW_MS).map((x) => x.value));
    if (before === null || after === null) continue;
    const delta = after - before;
    evaluated.push(expect === 'down' ? delta <= -0.02 : delta >= 0.02);
  }
  if (evaluated.length < 2) return null;
  const lastTwo = evaluated.slice(-2);
  if (lastTwo.some(Boolean)) return null;
  const label = SENSOR_LABEL[sensor];
  return {
    id: `${sensor}-no-response-${idSuffix}`,
    sensor,
    level: 'warning',
    title: `${label}: จ่าย${what}แล้วค่าไม่${expect === 'down' ? 'ลด' : 'เพิ่ม'} (${lastTwo.length} ครั้งล่าสุด)`,
    detail: 'ปั๊มทำงานแล้ว แต่ค่าที่วัดได้ไม่ตอบสนองภายใน 15 นาที',
    advice: `ตรวจตามลำดับ: ถัง${what}หมดหรือไม่ → สายปั๊มอุดตันหรือดูดอากาศ → หัววัด ${label} เสื่อมหรือยังไม่คาลิเบรต`,
  };
}

export function analyzeSensorHealth(input: SensorHealthInput): SensorHealthReport {
  const checks: HealthCheck[] = [];
  const live = input.freshness === 'live';
  const sampleCount = input.series.ph.length + input.series.ec.length + input.series.temp.length;

  if (input.freshness === 'no_data' || input.freshness === 'loading') {
    return {
      overall: 'unknown',
      score: null,
      sampleCount,
      checks: [
        {
          id: 'sys-no-data',
          sensor: 'system',
          level: 'info',
          title: 'ยังไม่มีข้อมูลให้วิเคราะห์',
          detail: 'อุปกรณ์ยังไม่เคยส่งข้อมูล หรือยังไม่ได้เชื่อมต่ออุปกรณ์',
        },
      ],
    };
  }
  if (input.freshness === 'offline') {
    checks.push({
      id: 'sys-offline',
      sensor: 'system',
      level: 'critical',
      title: 'อุปกรณ์ออฟไลน์',
      detail: 'ไม่ได้รับข้อมูลเกิน 150 วินาที ผลวิเคราะห์ด้านล่างอ้างอิงข้อมูลก่อนออฟไลน์',
      advice: 'ตรวจไฟเลี้ยงอุปกรณ์และ Wi-Fi',
    });
  } else if (input.freshness === 'stale') {
    checks.push({
      id: 'sys-stale',
      sensor: 'system',
      level: 'warning',
      title: 'ข้อมูลเริ่มเก่า',
      detail: 'อุปกรณ์ส่งข้อมูลช้ากว่าปกติ (75 ถึง 150 วินาที)',
      advice: 'สัญญาณ Wi-Fi อาจอ่อน',
    });
  }
  if (input.isSim) {
    checks.push({
      id: 'sys-sim',
      sensor: 'system',
      level: 'info',
      title: 'อุปกรณ์จำลอง (โหมดสาธิต)',
      detail: 'ค่าที่วิเคราะห์เป็นค่าจำลองจากอุปกรณ์สาธิต ไม่ใช่ค่าจากหัววัดจริง',
    });
  }

  checks.push(...checkSensor('ph', input.current.pH, input.series.ph, live));
  checks.push(...checkSensor('ec', input.current.ec, input.series.ec, live));
  checks.push(...checkSensor('temp', input.current.tempC, input.series.temp, live));

  if (live && input.current.tempC === null && (input.current.ec !== null || input.current.pH !== null)) {
    checks.push({
      id: 'temp-compensation',
      sensor: 'ec',
      level: 'info',
      title: 'EC ไม่มีการชดเชยอุณหภูมิ',
      detail: 'ไม่มีค่าอุณหภูมิ อุปกรณ์จึงคำนวณ EC ที่ 25°C ค่าอาจคลาดเคลื่อนประมาณ 2% ต่อ 1°C',
    });
  }

  const rt = input.runtime || {};
  const noResp = [
    checkDosingResponse('ph', doseTimes(rt.phDown), input.series.ph, 'down', input.now, 'กรด (pH-)', 'down'),
    checkDosingResponse('ph', doseTimes(rt.phUp), input.series.ph, 'up', input.now, 'ด่าง (pH+)', 'up'),
    checkDosingResponse('ec', [...doseTimes(rt.fertA), ...doseTimes(rt.fertB)].sort((a, b) => a - b), input.series.ec, 'up', input.now, 'ปุ๋ย A/B', 'fert'),
  ].filter((x): x is HealthCheck => x !== null);
  checks.push(...noResp);

  if (input.sensorOk === false && !checks.some((c) => c.level === 'critical' && c.sensor !== 'system')) {
    checks.push({
      id: 'sys-sensor-flag',
      sensor: 'system',
      level: 'warning',
      title: 'อุปกรณ์แจ้งว่าเซนเซอร์บางตัวไม่พร้อม',
      detail: 'อุปกรณ์ตั้งสถานะ sensor_ok เป็นไม่พร้อม เช่น ไม่มีค่าอุณหภูมิสำหรับชดเชย EC',
    });
  }

  const penalties = checks.reduce((p, c) => p + (c.level === 'critical' ? 40 : c.level === 'warning' ? 15 : 0), 0);
  const sensorEvidence = checks.some((c) => c.sensor !== 'system' && (c.level !== 'info' || c.id.endsWith('-ok')));
  if (!sensorEvidence && !checks.some((c) => c.level === 'critical' || c.level === 'warning')) {
    return { overall: 'unknown', score: null, checks, sampleCount };
  }
  const score = Math.max(0, 100 - penalties);
  const overall = checks.some((c) => c.level === 'critical') ? 'problem' : checks.some((c) => c.level === 'warning') ? 'attention' : 'good';
  const order: Record<HealthLevel, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return { overall, score, checks, sampleCount };
}
