/**
 * ==============================================================================
 * โครงการ: Hydroponic System (Smart Water Farm)
 * โมดูล: briefingEngine.ts (สมองกลผู้ช่วยฟาร์มรายงานตัว, ทักทายอัจฉริยะ & Smart Invalidation)
 * ==============================================================================
 * สถาปัตยกรรม:
 * 1. evaluateFarm(): โค้ดตัดสินล้วน 100% เทียบค่าเซนเซอร์จริงกับเป้าหมายตามชนิดพืชและอายุปลูก
 * 2. buildUserContext(): คำนวณช่วงเวลา, เวลาที่ไม่ได้เปิดแอป, คำเรียก, ประวัติเมื่อวาน
 * 3. computeFactsHash(): แฮชจากสถานะ (optimal/low/high) + issues + anomaly ไม่ใช้ตัวเลขดิบ เพื่อกัน sensor jitter
 * 4. decideBriefingMode(): ตัดสินใจ "reuse" (15m & same hash), "delta" (hash เปลี่ยน), "full" (>6h)
 * 5. buildBriefingPrompt(): สร้าง Prompt จาก FACTS + USER_CONTEXT + MODE ห้ามเดาตัวเลข
 * 6. validateBriefing(): Post-Response Validator ดักจับคำต้องห้าม ถ้าขัดแย้งกับ Fact ให้ใช้ Template สำรอง
 * 7. generateBriefing(): จุดเข้าเดียว (Single Entry Point) พร้อมระบบ In-App Learning & Storage
 * ==============================================================================
 */

import {
  getCurrentDiurnalPhase,
  analyzeDiurnalPattern,
  type DiurnalMetrics,
  type DiurnalPhaseKey,
  type HistoryDataPoint,
} from './diurnalPredictor.ts';
import { FIRMWARE_DEFAULT_TARGETS } from './telemetryContract.ts';

export interface SensorReading {
  value: number | null;
  status: 'optimal' | 'low' | 'high' | 'no_data';
  targetMin: number;
  targetMax: number;
  diff: number;
  unit: string;
}

export type IssueGroup =
  | 'nutrient_concentration'
  | 'ph'
  | 'water_temp'
  | 'connectivity'
  | 'water_level'
  | 'night_leak'
  | 'heat_stress'
  | 'root_stress';

export const ISSUE_GROUP_LABELS: Record<IssueGroup | string, string> = {
  connectivity: 'การเชื่อมต่ออุปกรณ์',
  nutrient_concentration: 'ความเข้มข้นธาตุอาหาร (EC/TDS)',
  ph: 'ค่ากรด-ด่าง (pH)',
  water_temp: 'อุณหภูมิน้ำ',
  water_level: 'ระดับน้ำในถัง',
  night_leak: 'น้ำรั่วซึมช่วงกลางคืน',
  heat_stress: 'ความเครียดจากความร้อน',
  root_stress: 'ระบบรากขาดออกซิเจน',
};

export interface FarmIssue {
  group: IssueGroup;
  metrics: string[];
  status: 'low' | 'high' | 'offline';
  severity: 'low' | 'medium' | 'high';
  text: string;
  recommendation: string;
  keywords: string[];
}

export interface FarmFacts {
  plantType: string;
  plantDays: number;
  growthStage: 'seedling' | 'vegetative' | 'maturity';
  growthStageLabel: string;
  /** null = ยังไม่ทราบรอบเก็บเกี่ยว (ไม่ได้ตั้ง expectedHarvestDays) -> UI แสดง '--' */
  harvestDaysRemaining: number | null;
  isOnline: boolean;
  timeOfDay: 'morning' | 'noon' | 'afternoon' | 'night' | 'late_night';
  timeOfDayLabel: string;
  phase: {
    key: DiurnalPhaseKey;
    label: string;
    expectedBehavior: string;
  };
  sensors: {
    pH: SensorReading;
    ec: SensorReading;
    tds: SensorReading;
    tempC: SensorReading;
    waterLevel?: SensorReading;
  };
  trends: {
    ecTrend: 'falling' | 'rising' | 'stable';
    pHTrend: 'falling' | 'rising' | 'stable';
    tempTrend: 'falling' | 'rising' | 'stable';
  };
  /** 'no_data' = อุปกรณ์ออนไลน์แต่ยังไม่มีค่าตรวจวัด pH/EC/TDS/อุณหภูมิเลย (ห้ามสรุปว่าปกติ) */
  overallStatus: 'optimal' | 'warning' | 'danger' | 'no_data';
  issues: FarmIssue[];
  criticalIssues: string[]; // สำหรับ backward compatibility กับเทสต์เดิม
  recommendations: string[]; // สำหรับ backward compatibility กับเทสต์เดิม
  okMetrics: string[];
  diurnalAnomaly?: string;
  dataHash: string;
}

export type BriefingMode = 'reuse' | 'delta' | 'full';

export interface UserContext {
  timeOfDay: 'morning' | 'noon' | 'afternoon' | 'night' | 'late_night';
  timeOfDayGreeting: string;
  hoursSinceLastOpen: number | null;
  isFirstOpen: boolean;
  isRecentReturn: boolean; // < 1 ชม.
  isAwayLong: boolean; // >= 24 ชม.
  callName: string;
  yesterdayEvent?: string;
}

export interface UserSession {
  lastOpenAt: number;
  lastBriefingAt: number;
  lastFactsHash: string;
  lastIssueKeys?: string[];
}

export interface UserProfile {
  lastOpenAt: number;
  frequentHours: Record<number, number>; // hour -> count
  totalOpens: number;
}

export interface FarmMemoryItem {
  id: string;
  timestamp: number;
  issueType: string;
  actionTaken: string;
  outcomeResult: string;
}

export interface PendingAction {
  id: string;
  issueType: string;
  actionTaken: string;
  timestamp: number;
}

export interface CachedBriefing {
  dataHash: string;
  timestamp: number;
  headline: string;
  message: string;
  severity: 'normal' | 'warning' | 'danger';
  mode: BriefingMode;
}

export interface BriefingFeedback {
  id: string;
  timestamp: number;
  briefingHash: string;
  rating: 'up' | 'down';
  reason?: string;
  factsSnapshot?: any;
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. Briefing Storage Abstraction (รองรับทั้ง Browser LocalStorage และ Mock ใน Test)
// ─────────────────────────────────────────────────────────────────────────────
export interface BriefingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let customStorage: BriefingStorage | null = null;

// Memory storage สำรองกรณีรันใน Node.js ที่ไม่มี window.localStorage
const memoryStore = new Map<string, string>();
const memoryStorageFallback: BriefingStorage = {
  getItem: (k) => memoryStore.get(k) ?? null,
  setItem: (k, v) => { memoryStore.set(k, String(v)); },
  removeItem: (k) => { memoryStore.delete(k); },
};

export function setBriefingStorage(storage: BriefingStorage | null): void {
  customStorage = storage;
}

export function getStorage(): BriefingStorage {
  if (customStorage) return customStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return memoryStorageFallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper ฟังก์ชันคำนวณเวลาและการเปลี่ยนแปลง (Delta)
// ─────────────────────────────────────────────────────────────────────────────
export function formatAwayDuration(hours: number): string {
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} วัน`;
  }
  const rounded = Math.round(hours);
  return `ประมาณ ${rounded} ชม.`;
}

export function computeDelta(
  prevKeys: string[] = [],
  currentKeys: string[] = []
): { newIssues: string[]; resolvedIssues: string[]; ongoing: string[] } {
  const prevSet = new Set(prevKeys);
  const curSet = new Set(currentKeys);

  const newIssues = currentKeys.filter((k) => !prevSet.has(k));
  const resolvedIssues = prevKeys.filter((k) => !curSet.has(k));
  const ongoing = currentKeys.filter((k) => prevSet.has(k));

  return { newIssues, resolvedIssues, ongoing };
}

/**
 * คำนวณอายุผักในแปลงปลูก (Single Source of Truth: 1-based วันที่เริ่มปลูกนับเป็นวันที่ 1)
 */
export function calculatePlantDays(
  plantStartDate: string | number | Date | null | undefined,
  now: Date = new Date()
): number {
  if (!plantStartDate) return 1;
  const startMs =
    typeof plantStartDate === 'number'
      ? plantStartDate
      : new Date(plantStartDate).getTime();
  if (isNaN(startMs)) return 1;
  const diffMs = now.getTime() - startMs;
  return Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. evaluateFarm(): โค้ดตัดสินล้วน (Deterministic Rule Engine)
// ─────────────────────────────────────────────────────────────────────────────
export function evaluateFarm(params: {
  plantType?: string;
  plantStartDate?: string | null | number;
  expectedHarvestDays?: number;
  current: {
    pH: number | null;
    ec: number | null;
    tds: number | null;
    tempC: number | null;
    waterLevel?: number | null;
  };
  targets: {
    phMin?: number;
    phMax?: number;
    ecMin?: number;
    ecMax?: number;
    tempMin?: number;
    tempMax?: number;
    tdsMin?: number;
    tdsMax?: number;
  };
  history?: Array<{
    timestamp: number;
    pH?: number | null;
    ec?: number | null;
    tempC?: number | null;
  }>;
  isOnline?: boolean;
  diurnal?: DiurnalMetrics;
  now?: Date;
}): FarmFacts {
  const { plantType = 'กรีนโอ๊ค', current, targets, history = [], isOnline = true, diurnal } = params;
  const currentDate = params.now || new Date();

  // 1.1 คำนวณวันปลูกและระยะการเจริญเติบโต โดยอ้างอิงจาก currentDate (Single Source of Truth)
  const plantDays = calculatePlantDays(params.plantStartDate, currentDate);
  // ไม่มีค่ารอบเก็บเกี่ยวจริง -> null (UI แสดง '--') ห้ามเดาเป็น 40 วัน
  const harvestCycle =
    typeof params.expectedHarvestDays === 'number' && params.expectedHarvestDays > 0 ? params.expectedHarvestDays : null;
  const harvestDaysRemaining = harvestCycle !== null ? Math.max(0, harvestCycle - plantDays) : null;

  let growthStage: 'seedling' | 'vegetative' | 'maturity' = 'vegetative';
  let growthStageLabel = 'ช่วงสร้างใบและลำต้น';
  if (plantDays <= 10) {
    growthStage = 'seedling';
    growthStageLabel = 'ช่วงต้นกล้าตั้งตัว';
  } else if (harvestCycle !== null && plantDays >= harvestCycle - 7) {
    growthStage = 'maturity';
    growthStageLabel = 'ช่วงสะสมน้ำหนักก่อนเก็บเกี่ยว';
  }

  // 1.2 คำนวณช่วงเวลาแดดจาก diurnalPredictor เป็น Source of Truth
  const diurnalPhase = getCurrentDiurnalPhase(currentDate);
  const hour = currentDate.getHours();
  let timeOfDay: 'morning' | 'noon' | 'afternoon' | 'night' | 'late_night' = 'morning';

  if (hour >= 5 && hour < 10) {
    timeOfDay = 'morning';
  } else if (hour >= 10 && hour < 15) {
    timeOfDay = 'noon';
  } else if (hour >= 15 && hour < 18) {
    timeOfDay = 'afternoon';
  } else if (hour >= 18 && hour < 22) {
    timeOfDay = 'night';
  } else {
    timeOfDay = 'late_night';
  }

  // 1.3 กำหนดเกณฑ์เป้าหมายที่แท้จริง
  // Fallback = the defaults the firmware itself applies (single source: telemetryContract)
  const phMin = targets.phMin ?? FIRMWARE_DEFAULT_TARGETS.phMin;
  const phMax = targets.phMax ?? FIRMWARE_DEFAULT_TARGETS.phMax;
  const ecMin = targets.ecMin ?? FIRMWARE_DEFAULT_TARGETS.ecMin;
  const ecMax = targets.ecMax ?? FIRMWARE_DEFAULT_TARGETS.ecMax;
  const tempMin = targets.tempMin ?? FIRMWARE_DEFAULT_TARGETS.tempMin;
  const tempMax = targets.tempMax ?? FIRMWARE_DEFAULT_TARGETS.tempMax;
  const tdsMin = targets.tdsMin ?? Math.round(ecMin * 500);
  const tdsMax = targets.tdsMax ?? Math.round(ecMax * 500);

  const evalMetric = (
    val: number | null,
    min: number,
    max: number,
    unit: string
  ): SensorReading => {
    if (val === null || val === undefined || isNaN(val)) {
      return { value: null, status: 'no_data', targetMin: min, targetMax: max, diff: 0, unit };
    }
    if (val < min) {
      return {
        value: val,
        status: 'low',
        targetMin: min,
        targetMax: max,
        diff: parseFloat((val - min).toFixed(2)),
        unit,
      };
    }
    if (val > max) {
      return {
        value: val,
        status: 'high',
        targetMin: min,
        targetMax: max,
        diff: parseFloat((val - max).toFixed(2)),
        unit,
      };
    }
    return { value: val, status: 'optimal', targetMin: min, targetMax: max, diff: 0, unit };
  };

  const phEval = evalMetric(current.pH, phMin, phMax, '');
  const ecEval = evalMetric(current.ec, ecMin, ecMax, 'mS/cm');
  const tempEval = evalMetric(current.tempC, tempMin, tempMax, '°C');
  const tdsEval = evalMetric(current.tds, tdsMin, tdsMax, 'ppm');

  // 1.4 รวบรวมปัญหาและคำแนะนำที่โค้ดตัดสิน 100% (FarmIssue)
  const issues: FarmIssue[] = [];
  const okMetrics: string[] = [];

  // ปัญหาการเชื่อมต่อ
  if (!isOnline) {
    issues.push({
      group: 'connectivity',
      metrics: ['connectivity'],
      status: 'offline',
      severity: 'high',
      text: 'อุปกรณ์ออฟไลน์ ขาดการเชื่อมต่อ',
      recommendation: 'ตรวจสอบการเชื่อมต่อ Wi-Fi หรือไฟเลี้ยงของอุปกรณ์',
      keywords: ['ออฟไลน์', 'เชื่อมต่อ', 'สัญญาณ', 'อุปกรณ์'],
    });
  }

  // ปัญหาความเข้มข้นธาตุอาหาร (EC & TDS)
  const isEcLow = ecEval.status === 'low';
  const isEcHigh = ecEval.status === 'high';
  const isTdsLow = tdsEval.status === 'low';
  const isTdsHigh = tdsEval.status === 'high';

  if (isEcLow && isTdsLow) {
    // ผิดทิศทางเดียวกัน รวมเป็นกลุ่ม nutrient_concentration เดียว
    issues.push({
      group: 'nutrient_concentration',
      metrics: ['EC', 'TDS'],
      status: 'low',
      severity: 'medium',
      text: `ความเข้มข้นธาตุอาหารต่ำ: EC=${ecEval.value} mS/cm, TDS=${tdsEval.value} ppm (เกณฑ์ EC ${ecMin}-${ecMax})`,
      recommendation: 'เติมสารละลายแม่ปุ๋ย A และ B เพิ่มในสัดส่วนเท่ากันเพื่อเพิ่มความเข้มข้นธาตุอาหาร',
      keywords: ['EC', 'TDS', 'ธาตุอาหาร', 'ปุ๋ย'],
    });
  } else if (isEcHigh && isTdsHigh) {
    issues.push({
      group: 'nutrient_concentration',
      metrics: ['EC', 'TDS'],
      status: 'high',
      severity: 'high',
      text: `ความเข้มข้นธาตุอาหารสูงเกินเกณฑ์: EC=${ecEval.value} mS/cm, TDS=${tdsEval.value} ppm (เกณฑ์ EC ${ecMin}-${ecMax})`,
      recommendation: 'เติมน้ำเปล่าเพื่อเจือจางสารละลาย ป้องกันภาวะปุ๋ยเค็มและปลายใบไหม้',
      keywords: ['EC', 'TDS', 'ธาตุอาหาร', 'ปุ๋ย'],
    });
  } else if (isEcLow) {
    issues.push({
      group: 'nutrient_concentration',
      metrics: ['EC'],
      status: 'low',
      severity: 'medium',
      text: `ค่า EC=${ecEval.value} ต่ำกว่าเกณฑ์ (${ecMin}-${ecMax} mS/cm)`,
      recommendation: 'เติมสารละลายแม่ปุ๋ย A และ B เพิ่มในสัดส่วนเท่ากันเพื่อเพิ่มความเข้มข้นธาตุอาหาร',
      keywords: ['EC', 'ธาตุอาหาร', 'ปุ๋ย'],
    });
  } else if (isEcHigh) {
    issues.push({
      group: 'nutrient_concentration',
      metrics: ['EC'],
      status: 'high',
      severity: 'high',
      text: `ค่า EC=${ecEval.value} สูงกว่าเกณฑ์ (${ecMin}-${ecMax} mS/cm)`,
      recommendation: 'เติมน้ำเปล่าเพื่อเจือจางสารละลาย ป้องกันภาวะปุ๋ยเค็มและปลายใบไหม้',
      keywords: ['EC', 'ธาตุอาหาร', 'ปุ๋ย'],
    });
  } else if (ecEval.status === 'optimal' && (isTdsLow || isTdsHigh)) {
    // TDS ผิดเกณฑ์แต่ EC ปกติ เป็นกลุ่มของตัวเอง ห้ามถูกกลืนหาย
    issues.push({
      group: 'nutrient_concentration',
      metrics: ['TDS'],
      status: isTdsLow ? 'low' : 'high',
      severity: 'low',
      text: `ค่า TDS=${tdsEval.value} ppm ${isTdsLow ? 'ต่ำกว่าเกณฑ์' : 'สูงกว่าเกณฑ์'} (${tdsMin}-${tdsMax} ppm)`,
      recommendation: 'ตรวจสอบค่าสารละลายรวมหรือทำการคาลิเบรตเซนเซอร์ TDS',
      keywords: ['TDS', 'สารละลาย', 'ปุ๋ย'],
    });
  }

  if (ecEval.status === 'optimal') {
    okMetrics.push('EC');
  }

  // ปัญหา pH
  if (phEval.status === 'low') {
    issues.push({
      group: 'ph',
      metrics: ['pH'],
      status: 'low',
      severity: 'medium',
      text: `ค่า pH=${phEval.value} ต่ำกว่าเกณฑ์ (${phMin}-${phMax}) น้ำเป็นกรด`,
      recommendation: 'เติมสารละลายปรับด่าง (pH Up) ทีละน้อยเพื่อปรับสมดุล',
      keywords: ['pH', 'กรด', 'น้ำ'],
    });
  } else if (phEval.status === 'high') {
    issues.push({
      group: 'ph',
      metrics: ['pH'],
      status: 'high',
      severity: 'medium',
      text: `ค่า pH=${phEval.value} สูงกว่าเกณฑ์ (${phMin}-${phMax}) น้ำเป็นด่าง`,
      recommendation: 'เติมสารละลายปรับกรด (pH Down) เพื่อเปิดการดูดซึมธาตุเหล็ก',
      keywords: ['pH', 'ด่าง', 'น้ำ'],
    });
  } else if (phEval.status === 'optimal') {
    okMetrics.push('pH');
  }

  // ปัญหาอุณหภูมิน้ำ (ตรวจทั้งสูงและต่ำ)
  if (tempEval.status === 'high') {
    issues.push({
      group: 'water_temp',
      metrics: ['tempC'],
      status: 'high',
      severity: 'high',
      text: `อุณหภูมิน้ำ=${tempEval.value}°C สูงเกินเกณฑ์ปลอดภัย (${tempMax}°C)`,
      recommendation: 'เปิดระบบพ่นหมอก ระบายอากาศ หรือหมุนเวียนน้ำเพื่อป้องกันรากเน่าและขาดออกซิเจน',
      keywords: ['อุณหภูมิ', 'อุณหภูมิน้ำ', 'ร้อน', 'น้ำ'],
    });
  } else if (tempEval.status === 'low') {
    issues.push({
      group: 'water_temp',
      metrics: ['tempC'],
      status: 'low',
      severity: 'medium',
      text: `อุณหภูมิน้ำ=${tempEval.value}°C ต่ำกว่าเกณฑ์ (${tempMin}°C)`,
      recommendation: 'ตรวจเช็กอุณหภูมิโดยรอบ อุณหภูมิน้ำเย็นอาจชะลอการดูดซึมปุ๋ย',
      keywords: ['อุณหภูมิ', 'อุณหภูมิน้ำ', 'เย็น', 'น้ำ'],
    });
  } else if (tempEval.status === 'optimal') {
    okMetrics.push('อุณหภูมิน้ำ');
  }

  // ปัญหาจาก Diurnal Predictor (heat_spike, root_stress)
  if (diurnal && diurnal.anomalyDetected) {
    // night_leak ถูกตัดออก: ไม่มีเซนเซอร์ระดับน้ำแบบต่อเนื่อง จึงคำนวณอัตราน้ำลดไม่ได้จริง
    if (diurnal.anomalyType === 'heat_spike') {
      issues.push({
        group: 'heat_stress',
        metrics: ['tempC', 'EC'],
        status: 'high',
        severity: 'medium',
        text: 'แดดร้อนจัด อุณหภูมิน้ำสูง ปุ๋ยเข้มข้นขึ้นจากน้ำระเหย',
        recommendation: 'เติมน้ำเปล่าเจือจางเพื่อป้องกันปลายใบไหม้',
        keywords: ['แดดร้อน', 'ระเหย', 'ความร้อน', 'ปุ๋ยเข้มข้น'],
      });
    } else if (diurnal.anomalyType === 'root_stress') {
      issues.push({
        group: 'root_stress',
        metrics: ['tempC', 'EC'],
        status: 'high',
        severity: 'medium',
        text: 'รากพืชเผชิญความเครียดจากความร้อน หยุดการดูดซึมปุ๋ย',
        recommendation: 'เพิ่มการหมุนเวียนน้ำและเติมออกซิเจนในระบบ',
        keywords: ['ราก', 'ความเครียด', 'ออกซิเจน', 'ความร้อน'],
      });
    }
  }

  // เรียงลำดับ issues ตามความรุนแรง (severity): high > medium > low
  const severityWeight: Record<string, number> = { high: 3, medium: 2, low: 1 };
  issues.sort((a, b) => (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0));

  // คำนวณ overallStatus
  // ออนไลน์แต่ไม่มีค่าตรวจวัดเลย -> 'no_data' (ไม่มีหลักฐานว่าปกติ จึงห้ามสรุปว่า optimal)
  const hasAnyReading = [phEval, ecEval, tempEval, tdsEval].some((r) => r.status !== 'no_data');
  let overallStatus: FarmFacts['overallStatus'] = 'optimal';
  if (issues.some((i) => i.severity === 'high')) {
    overallStatus = 'danger';
  } else if (issues.length > 0) {
    overallStatus = 'warning';
  } else if (!hasAnyReading) {
    overallStatus = 'no_data';
  }

  const criticalIssues: string[] = issues.map((i) => i.text);
  const recommendations: string[] = issues.map((i) => i.recommendation);

  // 1.5 คำนวณแนวโน้มจากประวัติ 24 ชม. ล่าสุดเทียบกับ currentDate
  let ecTrend: 'falling' | 'rising' | 'stable' = 'stable';
  let pHTrend: 'falling' | 'rising' | 'stable' = 'stable';
  let tempTrend: 'falling' | 'rising' | 'stable' = 'stable';

  const oneDayAgo = currentDate.getTime() - 24 * 60 * 60 * 1000;
  const history24h = (history || [])
    .filter((pt) => pt && pt.timestamp && pt.timestamp >= oneDayAgo && pt.timestamp <= currentDate.getTime())
    .sort((a, b) => a.timestamp - b.timestamp);

  if (history24h.length >= 2) {
    const oldest = history24h[0];
    const latest = history24h[history24h.length - 1];

    if (oldest.ec !== undefined && latest.ec !== undefined && oldest.ec !== null && latest.ec !== null) {
      const deltaEc = latest.ec - oldest.ec;
      if (deltaEc <= -0.15) ecTrend = 'falling';
      else if (deltaEc >= 0.15) ecTrend = 'rising';
    }
    if (oldest.pH !== undefined && latest.pH !== undefined && oldest.pH !== null && latest.pH !== null) {
      const deltaPh = latest.pH - oldest.pH;
      if (deltaPh <= -0.2) pHTrend = 'falling';
      else if (deltaPh >= 0.2) pHTrend = 'rising';
    }
    if (oldest.tempC !== undefined && latest.tempC !== undefined && oldest.tempC !== null && latest.tempC !== null) {
      const deltaTemp = latest.tempC - oldest.tempC;
      if (deltaTemp <= -1.0) tempTrend = 'falling';
      else if (deltaTemp >= 1.0) tempTrend = 'rising';
    }
  }

  // 1.6 สร้าง State Hash ที่ไม่ใช้ตัวเลขดิบ (computeFactsHash)
  const factsObj: FarmFacts = {
    plantType,
    plantDays,
    growthStage,
    growthStageLabel,
    harvestDaysRemaining,
    isOnline,
    timeOfDay,
    timeOfDayLabel: diurnalPhase.label,
    phase: {
      key: diurnalPhase.key,
      label: diurnalPhase.label,
      expectedBehavior: diurnalPhase.expectedBehavior,
    },
    sensors: {
      pH: phEval,
      ec: ecEval,
      tds: tdsEval,
      tempC: tempEval,
    },
    trends: {
      ecTrend,
      pHTrend,
      tempTrend,
    },
    overallStatus,
    issues,
    criticalIssues,
    recommendations,
    okMetrics,
    diurnalAnomaly: diurnal?.anomalyDetected ? diurnal.anomalyType : undefined,
    dataHash: '',
  };

  factsObj.dataHash = computeFactsHash(factsObj);
  return factsObj;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. computeFactsHash(): แฮชจากสถานะ (optimal/low/high) + issues + anomaly
// ─────────────────────────────────────────────────────────────────────────────
export function computeFactsHash(facts: FarmFacts): string {
  const { sensors, isOnline, overallStatus, plantType, growthStage, issues = [], diurnalAnomaly } = facts;
  const issueKey = issues.map((i) => `${i.group}:${i.status}`).sort().join(',');
  const anomalyKey = diurnalAnomaly || 'none';

  return [
    plantType,
    growthStage,
    isOnline ? 'online' : 'offline',
    overallStatus,
    `ph:${sensors.pH.status}`,
    `ec:${sensors.ec.status}`,
    `tds:${sensors.tds.status}`,
    `temp:${sensors.tempC.status}`,
    `issues:${issueKey}`,
    `anomaly:${anomalyKey}`,
  ].join('|');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. buildUserContext(): สร้างบริบทการทักทายอัจฉริยะจากข้อมูลจริง (แก้ B3, B4)
// ─────────────────────────────────────────────────────────────────────────────
export function buildUserContext(params: {
  now?: Date;
  lastOpenAt?: number | null;
  callName?: string;
  yesterdayEvent?: string;
}): UserContext {
  const now = params.now || new Date();
  const hour = now.getHours();

  // คำนวณช่วงเวลาและการทักทาย 5 ช่วง
  let timeOfDay: UserContext['timeOfDay'] = 'morning';
  let timeOfDayGreeting = 'สวัสดีตอนเช้าครับ';

  if (hour >= 5 && hour < 10) {
    timeOfDay = 'morning';
    timeOfDayGreeting = 'สวัสดีตอนเช้าครับ';
  } else if (hour >= 10 && hour < 15) {
    timeOfDay = 'noon';
    timeOfDayGreeting = 'สวัสดีตอนกลางวันครับ';
  } else if (hour >= 15 && hour < 18) {
    timeOfDay = 'afternoon';
    timeOfDayGreeting = 'สวัสดีตอนบ่ายครับ';
  } else if (hour >= 18 && hour < 22) {
    timeOfDay = 'night';
    timeOfDayGreeting = 'สวัสดีตอนค่ำครับ';
  } else {
    timeOfDay = 'late_night';
    timeOfDayGreeting = 'สวัสดีรอบดึกครับ';
  }

  // คำนวณเวลาที่ไม่ได้เปิดแอป (แก้ B4: ไม่มีประวัติ ให้ isFirstOpen=true, hoursSinceLastOpen=null, isAwayLong=false)
  const isFirstOpen = params.lastOpenAt === undefined || params.lastOpenAt === null;
  let hoursSinceLastOpen: number | null = null;
  let isRecentReturn = false;
  let isAwayLong = false;

  if (!isFirstOpen && typeof params.lastOpenAt === 'number' && !isNaN(params.lastOpenAt)) {
    hoursSinceLastOpen = Math.max(0, (now.getTime() - params.lastOpenAt) / (1000 * 60 * 60));
    isRecentReturn = hoursSinceLastOpen < 1.0;
    isAwayLong = hoursSinceLastOpen >= 24.0;
  }

  // ไม่ใส่คำเรียกสมมติ (persona) ถ้าผู้ใช้ไม่ได้ตั้งชื่อเรียกไว้
  const callName = params.callName || '';

  return {
    timeOfDay,
    timeOfDayGreeting,
    hoursSinceLastOpen,
    isFirstOpen,
    isRecentReturn,
    isAwayLong,
    callName,
    yesterdayEvent: params.yesterdayEvent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. decideBriefingMode(): ตัดสินใจ "reuse" | "delta" | "full"
// ─────────────────────────────────────────────────────────────────────────────
export function decideBriefingMode(
  session: UserSession | null,
  currentHash: string,
  nowTime: number | Date = Date.now()
): BriefingMode {
  const now = typeof nowTime === 'number' ? nowTime : nowTime.getTime();

  // 1. ถ้าไม่มีประวัติเซสชัน หรือ หายไปเกิน 6 ชั่วโมง -> สรุปภาพรวมเต็มรูปแบบ
  if (!session || !session.lastBriefingAt || now - session.lastOpenAt >= 6 * 60 * 60 * 1000) {
    return 'full';
  }

  // 2. เปิดซ้ำใน 15 นาที และสถานะเซนเซอร์ยังคงเดิม (hash เท่าเดิม) -> reuse แคชเดิมทันที
  const msSinceLastBriefing = now - session.lastBriefingAt;
  const isHashUnchanged = session.lastFactsHash === currentHash;

  if (msSinceLastBriefing < 15 * 60 * 1000 && isHashUnchanged) {
    return 'reuse';
  }

  // 3. ถ้า hash เปลี่ยน หรือเปิดซ้ำเกิน 15 นาที แต่ยังไม่เกิน 6 ชม. -> สรุปแบบ delta
  return 'delta';
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. buildBriefingPrompt(): สร้าง Prompt จาก FACTS + USER_CONTEXT + MODE
// ─────────────────────────────────────────────────────────────────────────────
export function buildBriefingPrompt(
  facts: FarmFacts,
  userContext?: UserContext,
  mode: BriefingMode = 'full',
  memoryItems: FarmMemoryItem[] = [],
  feedbackRules: string[] = [],
  delta?: { newIssues: string[]; resolvedIssues: string[]; ongoing: string[] }
): string {
  const ctx = userContext || buildUserContext({});

  // ข้อกำหนดเฉพาะตาม Mode
  let modeGuideline = '';
  if (mode === 'reuse') {
    modeGuideline = '- โหมด REUSE: ผู้ใช้เพิ่งเปิดแอปไม่นานและค่าเท่าเดิม ให้ทักสั้นมากๆ เช่น "สถานะยังคงที่ครับ"';
  } else if (mode === 'delta') {
    modeGuideline = '- โหมด DELTA: ผู้ใช้เพิ่งตรวจแปลงไปไม่นาน ให้ทักกระชับและบอกเฉพาะจุดที่เปลี่ยนแปลง (ปัญหาใหม่/แก้แล้ว) ไม่ต้องเกริ่นภาพรวมทั้งหมดซ้ำ';
  } else {
    modeGuideline = '- โหมด FULL: สรุปภาพรวมสถานะแปลงทั้งหมดอย่างชัดเจนและครบถ้วน';
  }

  // ข้อกำหนดเรื่องระยะเวลาห่างหาย
  let contextGuideline = '';
  if (ctx.isFirstOpen) {
    contextGuideline = `- ผู้ใช้เปิดแอปครั้งแรก: ห้ามพูดเรื่องเวลาที่ห่างหาย ให้ทักทายต้อนรับอย่างอบอุ่น เช่น "${ctx.timeOfDayGreeting}${ctx.callName}! ยินดีต้อนรับสู่ระบบรายงานตัวแปลง ${facts.plantType} ครับ"`;
  } else if (ctx.isRecentReturn) {
    contextGuideline = `- ผู้ใช้เปิดแอปซ้ำใน 1 ชม.: ทักทายสั้นกระชับ เช่น "ยินดีต้อนรับกลับมาตรวจแปลงครับ${ctx.callName}!" แล้วเข้าประเด็นทันที`;
  } else if (ctx.isAwayLong && ctx.hoursSinceLastOpen !== null) {
    const awayText = formatAwayDuration(ctx.hoursSinceLastOpen);
    contextGuideline = `- ผู้ใช้ไม่ได้เข้ามาประมาณ ${awayText}: ให้ทักว่า "ไม่ได้เจอกัน ${awayText} เลยครับ${ctx.callName}" แล้วสรุปสถานะ`;
  } else {
    contextGuideline = `- คำทักทายตามช่วงเวลา: "${ctx.timeOfDayGreeting}${ctx.callName}!"`;
  }

  const memoryContext =
    memoryItems.length > 0
      ? `\n[MEMORY ในอดีตของฟาร์มนี้]:\n` +
        memoryItems
          .map((m) => `- ปัญหา ${m.issueType}: ผู้ใช้เคยแก้โดย "${m.actionTaken}" ได้ผลลัพธ์ "${m.outcomeResult}"`)
          .join('\n')
      : '';

  const rulesContext =
    feedbackRules.length > 0
      ? `\n[กฎที่ผู้ใช้กด Feedback ไว้]:\n` + feedbackRules.map((r) => `- ${r}`).join('\n')
      : '';

  const deltaNewStr = delta?.newIssues.map((g) => ISSUE_GROUP_LABELS[g] || g).join(', ') || 'ไม่มี';
  const deltaResolvedStr = delta?.resolvedIssues.map((g) => ISSUE_GROUP_LABELS[g] || g).join(', ') || 'ไม่มี';
  const deltaOngoingStr = delta?.ongoing.map((g) => ISSUE_GROUP_LABELS[g] || g).join(', ') || 'ไม่มี';

  const deltaContext =
    mode === 'delta' && delta
      ? `\n[DELTA การเปลี่ยนแปลง]: ปัญหาใหม่: [${deltaNewStr}], แก้ไขแล้ว: [${deltaResolvedStr}], ปัญหาเดิมที่ยังค้างอยู่: [${deltaOngoingStr}] (หากยังมีปัญหาเดิมค้างอยู่ ต้องสรุปเตือนปัญหาที่ยังค้างอยู่ด้วย ห้ามตอบว่าปกติ)`
      : '';

  const issuesListText =
    facts.issues.length > 0
      ? facts.issues.map((iss, i) => `${i + 1}. [${iss.severity}] ${iss.text} -> แนะนำ: ${iss.recommendation}`).join('\n')
      : facts.overallStatus === 'no_data'
        ? 'ยังไม่มีค่าตรวจวัดจากอุปกรณ์ ห้ามสรุปว่าค่าปกติ'
        : 'ทุกค่าอยู่ในเกณฑ์เป้าหมาย';

  return `คุณคือผู้ช่วยฟาร์มไฮโดรโปนิกส์ประจำแปลง ${facts.plantType} (อายุวันที่ ${facts.plantDays})
จงเรียบเรียงสรุปสั้นๆ สำหรับหน้ารายงานตัวผู้ช่วยฟาร์ม โดยยึด FACTS และ USER_CONTEXT ดังนี้เท่านั้น:

[USER_CONTEXT]:
- คำเรียก: ${ctx.callName}
- ช่วงเวลา: ${ctx.timeOfDayGreeting} (${ctx.timeOfDay})
- เวลาที่ไม่ได้เปิดแอป: ${ctx.hoursSinceLastOpen !== null ? formatAwayDuration(ctx.hoursSinceLastOpen) : 'เปิดครั้งแรก'}
- รูปแบบสรุป (MODE): ${mode}${deltaContext}
${ctx.yesterdayEvent ? `- เหตุการณ์เมื่อวาน: ${ctx.yesterdayEvent}` : ''}

[FACTS ข้อมูลจริงที่ผ่านการคำนวณแล้ว]:
- ชนิดพืช: ${facts.plantType} (${facts.growthStageLabel})
- ช่วงแดดและพฤติกรรมพืช (PHASE): ${facts.phase.label} (${facts.phase.expectedBehavior})
- สถานะอุปกรณ์: ${facts.isOnline ? 'ออนไลน์' : 'ออฟไลน์'}
- สถานะรวม: ${facts.overallStatus}
- ค่า EC: ${facts.sensors.ec.value ?? '-'} mS/cm (เป้าหมาย: ${facts.sensors.ec.targetMin}-${facts.sensors.ec.targetMax}) [สถานะ: ${facts.sensors.ec.status}]
- ค่า TDS: ${facts.sensors.tds.value ?? '-'} ppm (เป้าหมาย: ${facts.sensors.tds.targetMin}-${facts.sensors.tds.targetMax}) [สถานะ: ${facts.sensors.tds.status}]
- ค่า pH: ${facts.sensors.pH.value ?? '-'} (เป้าหมาย: ${facts.sensors.pH.targetMin}-${facts.sensors.pH.targetMax}) [สถานะ: ${facts.sensors.pH.status}]
- อุณหภูมิน้ำ: ${facts.sensors.tempC.value ?? '-'}°C (เป้าหมาย: ${facts.sensors.tempC.targetMin}-${facts.sensors.tempC.targetMax}) [สถานะ: ${facts.sensors.tempC.status}]
- ค่าที่อยู่ในเกณฑ์ปกติ (okMetrics): [${facts.okMetrics.join(', ')}]
- แนวโน้ม: EC=${facts.trends.ecTrend}, pH=${facts.trends.pHTrend}, Temp=${facts.trends.tempTrend}
- รายการประเด็นปัญหา (เรียงตาม severity):
${issuesListText}
${memoryContext}
${rulesContext}

[กฎเหล็กการตอบ]:
1. ต้องพูดถึงทุก issue ที่ระบุใน FACTS เรียงตาม severity โดย issue แรกให้อธิบายละเอียด ส่วน issue ที่เหลือให้อธิบายสั้นกระชับ
2. issue ที่มีหลาย metric (เช่น EC และ TDS) ให้รวมประโยคเดียวพร้อมระบุตัวเลขทุกค่า
3. ปิดท้ายด้วย okMetrics โดยใช้คำว่า "ยังอยู่ในเกณฑ์" ห้ามใช้คำว่า สมบูรณ์ / สมดุลดี / ปกติดี เด็ดขาด
4. ห้ามใช้ตัวเลขนอกเหนือจาก FACTS
5. ${contextGuideline}
6. ${modeGuideline}
7. ความยาวไม่เกิน 3 ประโยค กระชับ ได้ใจความ สุภาพ และลงท้ายด้วยคำว่า "ครับ" เสมอ`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. validateBriefing(): Post-Response Validator & Rule-Based Fallback (แก้ B5)
// ─────────────────────────────────────────────────────────────────────────────
export function validateBriefing(
  aiOutput: string,
  facts: FarmFacts,
  userContext?: UserContext,
  mode: BriefingMode = 'full',
  delta?: { newIssues: string[]; resolvedIssues: string[]; ongoing: string[] }
): { isValid: boolean; text: string; fallbackUsed: boolean } {
  const fallback = {
    isValid: false,
    text: generateFallbackBriefing(facts, userContext, mode, delta),
    fallbackUsed: true,
  };

  const text = (aiOutput || '').trim();

  // V0: ยังไม่มีค่าตรวจวัด -> ใช้ข้อความที่โค้ดสร้างเท่านั้น (ไม่มีข้อมูลให้ตรวจยืนยันคำตอบ)
  if (facts.overallStatus === 'no_data') {
    return fallback;
  }

  // V4: ข้อความว่างหรือสั้นกว่า 20 ตัวอักษร
  if (!text || text.length < 20) {
    return fallback;
  }

  // กรณีที่ 1: สถานะรวมมีปัญหา (overallStatus !== 'optimal')
  if (facts.overallStatus !== 'optimal') {
    // V1: มีคำอ้างสถานะรวมว่าดี
    const forbiddenPositiveRegex =
      /(สภาพน้ำสมบูรณ์|สมบูรณ์พร้อม|สมบูรณ์ดี|สมบูรณ์|สมดุลดีมาก|สมดุลดี|ปกติดี|ทุกค่า(อยู่ใน|ปกติ|สมดุล)|ทุกอย่าง(ปกติ|ดี|เรียบร้อย)|ไม่พบความผิดปกติ|ไม่มีปัญหา|ปลอดภัย\s*100)/i;
    if (forbiddenPositiveRegex.test(text)) {
      return fallback;
    }

    // V2: ตรวจว่าพูดถึงครบทุก issue (ใช้ .every ตรวจว่า keywords ของแต่ละ issue มีอย่างน้อย 1 คำอยู่ในข้อความ)
    const allIssuesMentioned = facts.issues.every((issue) => {
      return issue.keywords.some((kw) => text.includes(kw));
    });
    if (!allIssuesMentioned) {
      return fallback;
    }

    // V3: ตรวจสอบตัวเลขที่ AI แต่งขึ้นเอง (Hallucinated Numbers)
    // รวบรวมตัวเลขทั้งหมดที่ได้รับอนุญาตใน FACTS, Context และ Common Numbers
    const allowedNumbers = new Set<string>();

    // 1-3 อนุญาตให้เป็นคำเชื่อมหรือลำดับ
    allowedNumbers.add('1');
    allowedNumbers.add('2');
    allowedNumbers.add('3');

    // เซนเซอร์และเป้าหมาย
    if (facts.sensors.ec.value !== null) {
      allowedNumbers.add(String(facts.sensors.ec.value));
      allowedNumbers.add(facts.sensors.ec.value.toFixed(1));
      allowedNumbers.add(facts.sensors.ec.value.toFixed(2));
    }
    allowedNumbers.add(String(facts.sensors.ec.targetMin));
    allowedNumbers.add(String(facts.sensors.ec.targetMax));
    allowedNumbers.add(facts.sensors.ec.targetMin.toFixed(1));
    allowedNumbers.add(facts.sensors.ec.targetMax.toFixed(1));

    if (facts.sensors.tds.value !== null) {
      allowedNumbers.add(String(facts.sensors.tds.value));
    }
    allowedNumbers.add(String(facts.sensors.tds.targetMin));
    allowedNumbers.add(String(facts.sensors.tds.targetMax));

    if (facts.sensors.pH.value !== null) {
      allowedNumbers.add(String(facts.sensors.pH.value));
      allowedNumbers.add(facts.sensors.pH.value.toFixed(1));
      allowedNumbers.add(facts.sensors.pH.value.toFixed(2));
    }
    allowedNumbers.add(String(facts.sensors.pH.targetMin));
    allowedNumbers.add(String(facts.sensors.pH.targetMax));
    allowedNumbers.add(facts.sensors.pH.targetMin.toFixed(1));
    allowedNumbers.add(facts.sensors.pH.targetMax.toFixed(1));

    if (facts.sensors.tempC.value !== null) {
      allowedNumbers.add(String(facts.sensors.tempC.value));
      allowedNumbers.add(facts.sensors.tempC.value.toFixed(0));
      allowedNumbers.add(facts.sensors.tempC.value.toFixed(1));
    }
    allowedNumbers.add(String(facts.sensors.tempC.targetMin));
    allowedNumbers.add(String(facts.sensors.tempC.targetMax));
    allowedNumbers.add(facts.sensors.tempC.targetMin.toFixed(0));
    allowedNumbers.add(facts.sensors.tempC.targetMax.toFixed(0));

    // วันปลูกและวันเก็บเกี่ยว
    allowedNumbers.add(String(facts.plantDays));
    if (facts.harvestDaysRemaining !== null) allowedNumbers.add(String(facts.harvestDaysRemaining));

    // ชั่วโมง/วันที่ห่างหาย
    if (userContext?.hoursSinceLastOpen !== null && userContext?.hoursSinceLastOpen !== undefined) {
      const h = userContext.hoursSinceLastOpen;
      allowedNumbers.add(String(Math.round(h)));
      allowedNumbers.add(String(Math.floor(h)));
      allowedNumbers.add(String(Math.floor(h / 24)));
      allowedNumbers.add(String(Math.round(h / 24)));
    }

    // เวลาในรอบวันจาก Phase (เช่น 6, 10, 15, 30, 18, 22)
    ['6', '10', '15', '30', '18', '22', '24'].forEach((n) => allowedNumbers.add(n));

    // ค้นหาตัวเลขทศนิยมหรือจำนวนเต็มในข้อความ AI
    const numbersInText = text.match(/\d+(\.\d+)?/g) || [];
    for (const numStr of numbersInText) {
      // ตรวจสอบว่าตัวเลขนี้อยู่ใน allowedNumbers หรือไม่
      if (!allowedNumbers.has(numStr)) {
        // หากตัวเลขไม่อยู่ใน Facts -> ปฏิเสธการแต่งตัวเลข
        return fallback;
      }
    }
  }

  // กรณีที่ 2: ทุกค่าปกติ (overallStatus === 'optimal')
  if (facts.overallStatus === 'optimal') {
    // ห้ามมีคำเตือนปัญหาหรือคำว่าหลุดเกณฑ์
    const forbiddenNegativeRegex = /(ต่ำกว่าเกณฑ์|สูงกว่าเกณฑ์|ผิดปกติ|เตือน)/i;
    if (forbiddenNegativeRegex.test(text)) {
      return fallback;
    }
  }

  // ปรับให้ลงท้าย "ครับ" เสมอถ้ายังไม่ลงท้าย
  let finalText = text;
  if (!finalText.endsWith('ครับ') && !finalText.endsWith('ครับ!')) {
    finalText = `${finalText} ครับ`;
  }

  return {
    isValid: true,
    text: finalText,
    fallbackUsed: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. generateFallbackBriefing(): สร้างข้อความสำรองด้วยโค้ดล้วน 100%
// ─────────────────────────────────────────────────────────────────────────────
export function generateFallbackBriefing(
  facts: FarmFacts,
  userContext?: UserContext,
  mode: BriefingMode = 'full',
  delta?: { newIssues: string[]; resolvedIssues: string[]; ongoing: string[] }
): string {
  const { plantType, overallStatus, issues, okMetrics } = facts;
  const ctx = userContext || buildUserContext({});

  // 1. คำทักทายขึ้นต้นตามบริบทจริง
  let greeting = '';
  if (ctx.isFirstOpen) {
    greeting = `${ctx.timeOfDayGreeting}${ctx.callName}! ยินดีต้อนรับสู่แปลง ${plantType}`;
  } else if (ctx.isRecentReturn && mode !== 'full') {
    greeting = `กลับมาตรวจแปลงอีกรอบนะครับ${ctx.callName}!`;
  } else if (ctx.isAwayLong && ctx.hoursSinceLastOpen !== null) {
    const awayStr = formatAwayDuration(ctx.hoursSinceLastOpen);
    greeting = `ไม่ได้เจอกัน ${awayStr} เลยครับ${ctx.callName}!`;
  } else {
    greeting = `${ctx.timeOfDayGreeting}${ctx.callName}!`;
  }

  // 2. กรณีโหมด Delta มีการเปลี่ยนแปลงของปัญหา
  if (mode === 'delta' && delta && (delta.newIssues.length > 0 || delta.resolvedIssues.length > 0)) {
    const parts: string[] = [];
    if (delta.resolvedIssues.length > 0) {
      const resolvedNames = delta.resolvedIssues.map((g) => ISSUE_GROUP_LABELS[g] || g).join(', ');
      parts.push(`ปัญหา${resolvedNames}ได้รับการแก้ไขกลับเข้าเกณฑ์แล้ว`);
    }
    if (delta.newIssues.length > 0) {
      parts.push(`พบปัญหาใหม่: ${issues.filter((i) => delta.newIssues.includes(i.group)).map((i) => i.text).join(', ')}`);
    }
    // ตรวจสอบว่ายังมีปัญหาเดิมที่ยังค้างอยู่ (ongoing active issues) หรือไม่
    const ongoingIssues = issues.filter((i) => !delta.newIssues.includes(i.group));
    if (ongoingIssues.length > 0) {
      const ongoingDesc = ongoingIssues.map((i) => i.text).join(' และ ');
      const reco = ongoingIssues[0].recommendation ? ` แนะนำ${ongoingIssues[0].recommendation}` : '';
      parts.push(`แต่ขณะนี้ยังตรวจพบ ${ongoingDesc}${reco}`);
    }
    return `${greeting} ${parts.join(' ')} ครับ`.trim();
  }

  // 2.5 อุปกรณ์ออนไลน์แต่ยังไม่มีค่าตรวจวัด -> บอกตรงๆ ห้ามบอกว่าอยู่ในเกณฑ์
  if (overallStatus === 'no_data') {
    return `${greeting} อุปกรณ์แปลง ${plantType} เชื่อมต่ออยู่ แต่ยังไม่ได้รับค่า pH, EC และอุณหภูมิน้ำ จึงยังประเมินสภาพน้ำไม่ได้ แนะนำตรวจสายเซนเซอร์หรือรอรอบส่งข้อมูลถัดไปครับ`;
  }

  // 3. กรณีมีปัญหา (overallStatus !== 'optimal')
  if (overallStatus !== 'optimal') {
    if (!facts.isOnline) {
      return `${greeting} ขณะนี้อุปกรณ์แปลง ${plantType} ออฟไลน์ แอปล็อกการสั่งงานปั๊มไว้จนกว่าอุปกรณ์จะกลับมาส่งข้อมูล แนะนำตรวจเช็กระบบไฟและการเชื่อมต่อครับ`;
    }

    if (issues.length > 0) {
      const primary = issues[0];
      const primaryDesc = `${primary.text}${primary.recommendation ? ` แนะนำ${primary.recommendation}` : ''}`;

      let secondaryDesc = '';
      if (issues.length > 1) {
        secondaryDesc = ` นอกจากนี้ยังพบ ${issues.slice(1).map((i) => i.text).join(' และ ')}`;
      }

      let okDesc = '';
      if (okMetrics.length > 0) {
        okDesc = ` ส่วน${okMetrics.join(' และ ')}ยังอยู่ในเกณฑ์`;
      }

      return `${greeting} ขณะนี้แปลง ${plantType} ตรวจพบ ${primaryDesc}${secondaryDesc}${okDesc} ครับ`;
    }

    return `${greeting} ขณะนี้ตรวจพบค่าสารละลายบางตัวอยู่นอกเกณฑ์ แนะนำตรวจเช็กแปลงปลูกครับ`;
  }

  // 4. กรณีทุกค่าอยู่ในเกณฑ์ปกติ
  const okListStr = okMetrics.length > 0 ? okMetrics.join(', ') : 'ค่าสารละลายและสภาพน้ำ';
  switch (ctx.timeOfDay) {
    case 'morning':
      return `${greeting} แปลง ${plantType} เริ่มรับแสงยามเช้า ${okListStr} ยังอยู่ในเกณฑ์ พืชพร้อมเจริญเติบโตเต็มที่ครับ`;
    case 'noon':
      return `${greeting} ช่วงแดดจัดนี้ ${plantType} ดูดซึมน้ำและธาตุอาหารได้ดี ${okListStr} ยังอยู่ในเกณฑ์ครับ`;
    case 'afternoon':
      return `${greeting} แดดเริ่มร่มลงแล้ว แปลง ${plantType} ${okListStr} ยังอยู่ในเกณฑ์ พืชสะสมสารอาหารได้ต่อเนื่องครับ`;
    case 'late_night':
      return `${greeting} แปลง ${plantType} เข้าสู่ช่วงพักผ่อนกลางคืน ${okListStr} ทั้งหมดนิ่งเสถียรดีครับ`;
    case 'night':
    default:
      return `${greeting} แปลง ${plantType} ${okListStr} ทั้งหมดนิ่งเสถียรดี พร้อมเข้าสู่รอบค่ำครับ`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Single Entry Point: generateBriefing()
// ─────────────────────────────────────────────────────────────────────────────
export async function generateBriefing(input: {
  sensors: {
    pH: number | null;
    ec: number | null;
    tds: number | null;
    tempC: number | null;
    waterLevel?: number | null;
  };
  targets: {
    phMin?: number;
    phMax?: number;
    ecMin?: number;
    ecMax?: number;
    tempMin?: number;
    tempMax?: number;
    tdsMin?: number;
    tdsMax?: number;
  };
  history?: Array<{
    timestamp: number;
    pH?: number | null;
    ec?: number | null;
    tempC?: number | null;
  }>;
  plantType?: string;
  plantStartDate?: string | null | number;
  expectedHarvestDays?: number;
  isOnline?: boolean;
  callName?: string;
  callAI: (prompt: string) => Promise<string>;
  now?: Date;
  previousOpenAt: number | null;
}): Promise<{
  text: string;
  headline: string;
  severity: 'normal' | 'warning' | 'danger';
  mode: BriefingMode;
  source: 'cache' | 'ai' | 'fallback';
  dataHash: string;
  facts: FarmFacts;
}> {
  const currentDate = input.now || new Date();
  const nowMs = currentDate.getTime();

  // 1. Session snapshot ไว้เป็น prevSession
  const currentSession = getUserSession();
  const prevSession: UserSession | null = currentSession
    ? {
        ...currentSession,
        lastOpenAt: input.previousOpenAt ?? currentSession.lastOpenAt,
      }
    : null;

  // 2. รัน diurnalPredictor ด้วย targets ชุดเดียวกัน แล้วส่งเข้า evaluateFarm
  const historyPoints: HistoryDataPoint[] = (input.history || []).map((h) => ({
    timestamp: h.timestamp,
    pH: h.pH ?? undefined,
    ec: h.ec ?? undefined,
    tempC: h.tempC ?? undefined,
  }));

  const diurnal = analyzeDiurnalPattern(
    historyPoints,
    {
      // Missing readings stay null: the predictor skips rules for them (no stand-in values)
      pH: input.sensors.pH ?? null,
      ec: input.sensors.ec ?? null,
      tempC: input.sensors.tempC ?? null,
      level: input.sensors.waterLevel ?? null,
    },
    input.plantType || 'กรีนโอ๊ค',
    input.targets.ecMin ?? FIRMWARE_DEFAULT_TARGETS.ecMin,
    input.targets.ecMax ?? FIRMWARE_DEFAULT_TARGETS.ecMax,
    input.targets.phMin ?? FIRMWARE_DEFAULT_TARGETS.phMin,
    input.targets.phMax ?? FIRMWARE_DEFAULT_TARGETS.phMax,
    input.targets,
    currentDate
  );

  const facts = evaluateFarm({
    plantType: input.plantType,
    plantStartDate: input.plantStartDate,
    expectedHarvestDays: input.expectedHarvestDays,
    current: input.sensors,
    targets: input.targets,
    history: input.history,
    isOnline: input.isOnline,
    diurnal,
    now: currentDate,
  });

  // 3. buildUserContext
  const yesterdayEvent = buildYesterdayEvent(input.history || [], input.targets, currentDate);
  const ctx = buildUserContext({
    now: currentDate,
    lastOpenAt: input.previousOpenAt,
    callName: input.callName,
    yesterdayEvent,
  });

  // 4. ตัดสินใจ BriefingMode
  let mode = decideBriefingMode(prevSession, facts.dataHash, nowMs);

  // 5. ถ้า mode === 'reuse' ให้ลองดึง Cache
  if (mode === 'reuse') {
    const cached = getCachedBriefing(facts.dataHash, nowMs);
    if (cached) {
      return {
        text: cached.message,
        headline: cached.headline,
        severity: cached.severity,
        mode: 'reuse',
        source: 'cache',
        dataHash: facts.dataHash,
        facts,
      };
    }
    mode = 'delta';
  }

  // 6. แก้ไข Action ที่เคยบันทึกไว้ใน Memory
  resolvePendingActions(facts, currentDate);

  // 7. คำนวณ delta ระหว่างเซสชันก่อนหน้ากับปัจจุบัน
  const prevKeys = prevSession?.lastIssueKeys || [];
  const currentKeys = facts.issues.map((i) => i.group);
  const delta = computeDelta(prevKeys, currentKeys);

  // ดึง relevant memory และ feedback rules
  const memory = getRelevantMemory(currentKeys, 3);
  const rules = getFeedbackRules();

  // 8. สร้าง Prompt และเรียก callAI พร้อม Timeout 8 วินาที
  const prompt = buildBriefingPrompt(facts, ctx, mode, memory, rules, delta);

  let finalBriefingText = '';
  let source: 'cache' | 'ai' | 'fallback' = 'fallback';

  if (!facts.isOnline || facts.overallStatus === 'no_data') {
    // ออฟไลน์ หรือยังไม่มีค่าตรวจวัด ให้ใช้ข้อความจากโค้ดทันที
    finalBriefingText = generateFallbackBriefing(facts, ctx, mode, delta);
    source = 'fallback';
  } else {
    try {
      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('AI Call Timeout (8s)')), 8000)
      );

      const aiResponse = await Promise.race([input.callAI(prompt), timeoutPromise]);
      const validated = validateBriefing(aiResponse, facts, ctx, mode, delta);

      if (validated.isValid && !validated.fallbackUsed) {
        finalBriefingText = validated.text;
        source = 'ai';
      } else {
        finalBriefingText = validated.text;
        source = 'fallback';
      }
    } catch (_) {
      finalBriefingText = generateFallbackBriefing(facts, ctx, mode, delta);
      source = 'fallback';
    }
  }

  // 9. บันทึก Cache และ Session
  const headline = facts.phase.label;
  const severity: 'normal' | 'warning' | 'danger' =
    facts.overallStatus === 'optimal' ? 'normal' : facts.overallStatus === 'no_data' ? 'warning' : facts.overallStatus;

  setCachedBriefing({
    dataHash: facts.dataHash,
    timestamp: nowMs,
    headline,
    message: finalBriefingText,
    severity,
    mode,
  });

  saveUserSession({
    lastOpenAt: nowMs,
    lastBriefingAt: nowMs,
    lastFactsHash: facts.dataHash,
    lastIssueKeys: currentKeys,
  });

  return {
    text: finalBriefingText,
    headline,
    severity,
    mode,
    source,
    dataHash: facts.dataHash,
    facts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. ระบบเรียนรู้ในแอป (Farm Memory & Feedback Storage)
// ─────────────────────────────────────────────────────────────────────────────
export const BRIEFING_ENGINE_VERSION = 'v4';
const SESSION_KEY = `smartfarm_user_session_${BRIEFING_ENGINE_VERSION}`;
const PROFILE_KEY = `smartfarm_user_profile_${BRIEFING_ENGINE_VERSION}`;
const CACHE_KEY = `smartfarm_briefing_cache_${BRIEFING_ENGINE_VERSION}`;
const FEEDBACK_STORAGE_KEY = 'smartfarm_briefing_feedback';
const MEMORY_STORAGE_KEY = 'smartfarm_briefing_memory';
const PENDING_ACTION_KEY = 'smartfarm_pending_actions';

export function clearBriefingCache(): void {
  const storage = getStorage();
  try {
    storage.removeItem('smartfarm_briefing_cache');
    storage.removeItem('smartfarm_briefing_cache_v2');
    storage.removeItem('smartfarm_briefing_cache_v3');
    storage.removeItem(CACHE_KEY);
    storage.removeItem('smartfarm_user_session');
    storage.removeItem('smartfarm_user_session_v3');
    storage.removeItem(SESSION_KEY);
  } catch (_) {}
}

export function getUserSession(): UserSession | null {
  const storage = getStorage();
  try {
    const raw = storage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function saveUserSession(session: UserSession): void {
  const storage = getStorage();
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (_) {}
}

export function trackAppOpen(nowTime: number | Date = Date.now()): {
  profile: UserProfile;
  previousOpenAt: number | null;
} {
  const now = typeof nowTime === 'number' ? nowTime : nowTime.getTime();
  const storage = getStorage();

  try {
    const rawProfile = storage.getItem(PROFILE_KEY);
    const existingProfile: UserProfile | null = rawProfile ? JSON.parse(rawProfile) : null;
    const previousOpenAt = existingProfile?.lastOpenAt ?? null;

    const profile: UserProfile = existingProfile || { lastOpenAt: now, frequentHours: {}, totalOpens: 0 };
    profile.lastOpenAt = now;
    profile.totalOpens = (profile.totalOpens || 0) + 1;
    const hour = new Date(now).getHours();
    profile.frequentHours[hour] = (profile.frequentHours[hour] || 0) + 1;

    storage.setItem(PROFILE_KEY, JSON.stringify(profile));

    const currentSession = getUserSession();
    if (currentSession) {
      currentSession.lastOpenAt = now;
      saveUserSession(currentSession);
    } else {
      saveUserSession({
        lastOpenAt: now,
        lastBriefingAt: 0,
        lastFactsHash: '',
      });
    }

    return { profile, previousOpenAt };
  } catch (_) {
    return {
      profile: { lastOpenAt: now, frequentHours: {}, totalOpens: 1 },
      previousOpenAt: null,
    };
  }
}

export function getCachedBriefing(currentHash: string, nowTime: number = Date.now()): CachedBriefing | null {
  const storage = getStorage();
  try {
    // ล้างแคชเวอร์ชันเก่าที่อาจมีข้อความบั๊กตกค้าง
    try {
      storage.removeItem('smartfarm_briefing_cache');
      storage.removeItem('smartfarm_briefing_cache_v2');
      storage.removeItem('smartfarm_briefing_cache_v3');
      storage.removeItem('smartfarm_user_session');
      storage.removeItem('smartfarm_user_session_v3');
    } catch (_) {}

    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: CachedBriefing = JSON.parse(raw);
    const isExpired = nowTime - parsed.timestamp > 30 * 60 * 1000;
    const isHashMatched = parsed.dataHash === currentHash;

    // ตรวจสอบความถูกต้องของข้อความในแคช: ถ้ามี [ หรือหลุด connectivity ให้ทำลายแคชทิ้งทันที
    if (parsed.message && (parsed.message.includes('[') || parsed.message.includes('connectivity'))) {
      storage.removeItem(CACHE_KEY);
      return null;
    }

    if (!isExpired && isHashMatched) {
      return parsed;
    }
  } catch (_) {}
  return null;
}

export function setCachedBriefing(briefing: CachedBriefing): void {
  const storage = getStorage();
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(briefing));
  } catch (_) {}
}

export function saveBriefingFeedback(feedback: BriefingFeedback): void {
  const storage = getStorage();
  try {
    const raw = storage.getItem(FEEDBACK_STORAGE_KEY);
    const list: BriefingFeedback[] = raw ? JSON.parse(raw) : [];
    list.unshift(feedback);
    storage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(list.slice(0, 50)));
  } catch (_) {}
}

export function getFeedbackRules(): string[] {
  const storage = getStorage();
  try {
    const raw = storage.getItem(FEEDBACK_STORAGE_KEY);
    if (!raw) return [];
    const list: BriefingFeedback[] = JSON.parse(raw);
    const rules: string[] = [];
    const downvotes = list.filter((f) => f.rating === 'down');
    if (downvotes.some((f) => f.reason === 'ยาวไป')) {
      rules.push('ผู้ใช้ชอบข้อความที่กระชับ สั้น ไม่เยิ่นเย้อ');
    }
    if (downvotes.some((f) => f.reason === 'ผิดข้อมูล')) {
      rules.push('ต้องยึดตัวเลขจาก FACTS 100% ห้ามเดา');
    }
    return rules;
  } catch (_) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. ระบบ Farm Actions & Memory Learning
// ─────────────────────────────────────────────────────────────────────────────
export function recordFarmAction(issueType: string, actionTaken: string): void {
  const storage = getStorage();
  try {
    const raw = storage.getItem(PENDING_ACTION_KEY);
    const list: PendingAction[] = raw ? JSON.parse(raw) : [];
    list.unshift({
      id: `act_${Date.now()}`,
      issueType,
      actionTaken,
      timestamp: Date.now(),
    });
    storage.setItem(PENDING_ACTION_KEY, JSON.stringify(list.slice(0, 10)));
  } catch (_) {}
}

export function resolvePendingActions(facts: FarmFacts, nowTime?: Date): void {
  const storage = getStorage();
  try {
    const raw = storage.getItem(PENDING_ACTION_KEY);
    if (!raw) return;
    const pendingList: PendingAction[] = JSON.parse(raw);
    if (pendingList.length === 0) return;

    const remaining: PendingAction[] = [];
    const resolvedMemories: FarmMemoryItem[] = [];
    const nowMs = (nowTime || new Date()).getTime();

    for (const act of pendingList) {
      // ตรวจสอบว่า issueType นี้หายไปหรือยัง
      let isResolved = false;
      if (act.issueType.includes('ec') && facts.sensors.ec.status === 'optimal') {
        isResolved = true;
      } else if (act.issueType.includes('ph') && facts.sensors.pH.status === 'optimal') {
        isResolved = true;
      } else if (act.issueType.includes('temp') && facts.sensors.tempC.status === 'optimal') {
        isResolved = true;
      }

      if (isResolved) {
        const hoursSpent = Math.max(0.5, (nowMs - act.timestamp) / (1000 * 60 * 60));
        const durationStr = hoursSpent >= 24 ? `${Math.round(hoursSpent / 24)} วัน` : `~${Math.round(hoursSpent)} ชม.`;
        resolvedMemories.push({
          id: `mem_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
          timestamp: nowMs,
          issueType: act.issueType,
          actionTaken: act.actionTaken,
          outcomeResult: `${act.issueType.toUpperCase()} กลับเข้าเกณฑ์ใน ${durationStr}`,
        });
      } else {
        remaining.push(act);
      }
    }

    if (resolvedMemories.length > 0) {
      storage.setItem(PENDING_ACTION_KEY, JSON.stringify(remaining));
      const rawMem = storage.getItem(MEMORY_STORAGE_KEY);
      const memList: FarmMemoryItem[] = rawMem ? JSON.parse(rawMem) : [];
      memList.unshift(...resolvedMemories);
      storage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(memList.slice(0, 30)));
    }
  } catch (_) {}
}

export function getRelevantMemory(issueTypes: string[], limit: number = 3): FarmMemoryItem[] {
  const storage = getStorage();
  try {
    const raw = storage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return [];
    const list: FarmMemoryItem[] = JSON.parse(raw);
    return list
      .filter((m) => issueTypes.some((t) => m.issueType.toLowerCase().includes(t.toLowerCase())))
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

export function buildYesterdayEvent(
  history: Array<{ timestamp: number; pH?: number | null; ec?: number | null; tempC?: number | null }>,
  targets: { phMin?: number; phMax?: number; ecMin?: number; ecMax?: number },
  nowDate?: Date
): string | undefined {
  if (!history || history.length < 2) return undefined;
  const now = (nowDate || new Date()).getTime();
  const yesterdayStart = now - 48 * 60 * 60 * 1000;
  const yesterdayEnd = now - 24 * 60 * 60 * 1000;

  const yesterdayPoints = history.filter((p) => p.timestamp >= yesterdayStart && p.timestamp <= yesterdayEnd);
  if (yesterdayPoints.length === 0) return undefined;

  const ecMin = targets.ecMin ?? FIRMWARE_DEFAULT_TARGETS.ecMin;
  const phMin = targets.phMin ?? FIRMWARE_DEFAULT_TARGETS.phMin;

  const hadLowEc = yesterdayPoints.some((p) => typeof p.ec === 'number' && p.ec < ecMin);
  const hadLowPh = yesterdayPoints.some((p) => typeof p.pH === 'number' && p.pH < phMin);

  const latest = history[history.length - 1];
  if (hadLowEc && typeof latest.ec === 'number' && latest.ec >= ecMin) {
    return 'เมื่อวาน EC ต่ำ ตอนนี้กลับเข้าเกณฑ์แล้ว';
  }
  if (hadLowPh && typeof latest.pH === 'number' && latest.pH >= phMin) {
    return 'เมื่อวาน pH เป็นกรด ตอนนี้กลับเข้าเกณฑ์แล้ว';
  }

  return undefined;
}
