/**
 * ==============================================================================
 * โครงการ: Hydroponic System (Smart Water Farm)
 * โมดูล: plantProfileService.ts (บริการค้นหาและวิเคราะห์ค่ามาตรฐานพืชด้วย AI)
 * ==============================================================================
 * สถาปัตยกรรม:
 * 1. normalizePlantName(): ตัดช่องว่าง, ตัวพิมพ์, สะกดใกล้เคียง, alias ไทย-อังกฤษ
 * 2. getPlantProfile(): ตารางในแอป -> Cache -> เรียก AI (Zero-Mock, Strict Ceilings)
 * 3. validatePlantProfile(): ตรวจสอบ Schema & เพดานความปลอดภัย (pH, EC, Temp, Harvest)
 * 4. mergePlantTargets(): คำนวณช่วงซ้อนทับ (Intersection) หรือตรวจจับ Conflict พร้อมเตือนแยกถัง
 * 5. PlantLock Engine: หน้าต่างยืนยัน, Grace Period 10 นาที, ล็อกถึง 00:00 น. ป้องกันสแปม AI
 * ==============================================================================
 */


/**
 * ตัวเลือก "พืชอื่นๆ" ต้องเรียก AI ภายนอก (ต้องมี API key) จึงเปิดใช้ได้เฉพาะเมื่อมี VITE_GEMINI_API_KEY
 * ขณะปิดอยู่ หน้าตั้งค่าฟาร์มจะซ่อนตัวเลือกนี้ และใช้เฉพาะฐานข้อมูลพืชในแอป
 */
// Key comes from the build environment (.env -> VITE_GEMINI_API_KEY, never committed to git)
// or from a key the user saved on this phone. Without a key the AI choice stays hidden.
const BUILD_GEMINI_KEY: string = String((import.meta as any).env?.VITE_GEMINI_API_KEY || '').trim();
export const CUSTOM_PLANT_AI_ENABLED: boolean = BUILD_GEMINI_KEY.length > 0;

export interface PlantProfile {
  recognized: boolean;
  canonical_name_th: string;
  canonical_name_en: string;
  hydroponic_suitable: boolean;
  harvest_days: { min: number; max: number };
  ph: { min: number; max: number };
  ec_ms_cm: { min: number; max: number };
  water_temp_c: { min: number; max: number };
  stages?: {
    seedling?: { ec_min: number; ec_max: number };
    vegetative?: { ec_min: number; ec_max: number };
    maturity?: { ec_min: number; ec_max: number };
  };
  confidence: 'high' | 'medium' | 'low';
  notes: string;
  isEstimated?: boolean;
  isFromCache?: boolean;
  isFromBuiltin?: boolean;
}

export interface MergedPlantTargets {
  phMin: number;
  phMax: number;
  ecMin: number;
  ecMax: number;
  tempMin: number;
  tempMax: number;
  harvestDays: number;
  conflict: boolean;
  disadvantagedPlants: string[];
  warning?: string;
  compatiblePlantNames: string[];
}

export interface PlantLockInfo {
  confirmedAt: number;
  lockedUntil: number; // 00:00 ของวันถัดไปตามเวลาท้องถิ่น
  plantKeys: string[];
  graceUntil: number; // confirmedAt + 10 นาที
  graceUsed?: boolean;
}

export class PlantLockedError extends Error {
  public lockedUntil: number;
  constructor(message: string, lockedUntil: number) {
    super(message);
    this.name = 'PlantLockedError';
    this.lockedUntil = lockedUntil;
  }
}

export interface PlantQueryValidation {
  valid: boolean;
  reason?: string;
}

/**
 * ตรวจสอบความสมบูรณ์ของชื่อพืช (Gibberish & Sanity Filter)
 * ป้องกันการพิมพ์คำสุ่ม เช่น "ตตตต", อักษรซ้ำ, ตัวเลขล้วน, สัญลักษณ์
 */
export function isValidPlantQuery(input: string): PlantQueryValidation {
  const trimmed = (input || '').trim();

  // 1. ความยาวขั้นต่ำ 2 ตัวอักษร
  if (trimmed.length < 2) {
    return {
      valid: false,
      reason: 'ชื่อพืชต้องมีความยาวอย่างน้อย 2 ตัวอักษร',
    };
  }

  // 2. ความยาวสูงสุดไม่เกิน 50 ตัวอักษร
  if (trimmed.length > 50) {
    return {
      valid: false,
      reason: 'ชื่อพืชยาวเกินกำหนด (สูงสุด 50 ตัวอักษร)',
    };
  }

  // 3. ตรวจจับการพิมพ์ตัวอักษรซ้ำซ้อนผิดปกติ (3 ตัวขึ้นไปติดกัน เช่น ตตตต, กกก, aaaa, .....)
  if (/(.)\1{2,}/.test(trimmed)) {
    return {
      valid: false,
      reason: 'ชื่อพืชมีตัวอักษรซ้ำซ้อนผิดปกติ กรุณาระบุชื่อพืชจริงที่ต้องการปลูก',
    };
  }

  // 4. ต้องมีตัวอักษรภาษาไทยหรือภาษาอังกฤษ
  const hasValidChars = /[a-zA-Z\u0E01-\u0E5B]/.test(trimmed);
  if (!hasValidChars) {
    return {
      valid: false,
      reason: 'ชื่อพืชต้องประกอบด้วยตัวอักษรภาษาไทยหรือภาษาอังกฤษ',
    };
  }

  // 5. สัดส่วนตัวอักษรต่อสัญลักษณ์/ตัวเลข (ป้องกันสแปมสัญลักษณ์ เช่น @#$% หรือ 123456)
  const alphaChars = trimmed.match(/[a-zA-Z\u0E01-\u0E5B]/g) || [];
  if (alphaChars.length / trimmed.length < 0.6) {
    return {
      valid: false,
      reason: 'ชื่อพืชมีอักขระพิเศษมากเกินไป กรุณาระบุชื่อพืชจริง',
    };
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. Storage Interface (รองรับทั้ง Browser LocalStorage และ Mock ใน Test)
// ─────────────────────────────────────────────────────────────────────────────
export interface PlantStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let customStorage: PlantStorage | null = null;
const memoryStore = new Map<string, string>();
const defaultMemoryStorage: PlantStorage = {
  getItem: (k) => memoryStore.get(k) ?? null,
  setItem: (k, v) => { memoryStore.set(k, String(v)); },
  removeItem: (k) => { memoryStore.delete(k); },
};

export function setPlantStorage(storage: PlantStorage | null): void {
  customStorage = storage;
}

export function getPlantStorage(): PlantStorage {
  if (customStorage) return customStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return defaultMemoryStorage;
}

const CACHE_PREFIX = 'smartfarm_plant_profile_';
const LOCK_KEY = 'smartfarm_plant_lock';
const LAST_SEEN_KEY = 'smartfarm_last_seen_time';
export const USER_GEMINI_KEY_STORAGE = 'smartfarm_gemini_key';

/** Gemini API key the user pasted in app settings (their own free key, stored on this phone only). */
export function getUserGeminiKey(): string {
  try {
    return (getPlantStorage().getItem(USER_GEMINI_KEY_STORAGE) || '').trim();
  } catch (_) {
    return '';
  }
}

/** AI analysis of a typed plant name is available when a key exists (user key, or a build key in .env). */
export function isCustomPlantAiEnabled(): boolean {
  return getUserGeminiKey().length > 0 || BUILD_GEMINI_KEY.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. normalizePlantName(): แปลงชื่อพืชเป็นรูปมาตรฐาน (Canonical Alias)
// ─────────────────────────────────────────────────────────────────────────────
const ALIAS_MAP: Record<string, string> = {
  // กรีนโอ๊ค
  'green oak': 'กรีนโอ๊ค',
  'greenoak': 'กรีนโอ๊ค',
  'กรีนโอค': 'กรีนโอ๊ค',
  'กรีนโอ๊ก': 'กรีนโอ๊ค',
  'กรีนโอ๊ค': 'กรีนโอ๊ค',

  // เรดโอ๊ค
  'red oak': 'เรดโอ๊ค',
  'redoak': 'เรดโอ๊ค',
  'เรดโอค': 'เรดโอ๊ค',
  'เรดโอ๊ก': 'เรดโอ๊ค',
  'เรดโอ๊ค': 'เรดโอ๊ค',

  // สลัดคอส
  'cos': 'สลัดคอส',
  'romaine': 'สลัดคอส',
  'คอส': 'สลัดคอส',
  'สลัดคอส': 'สลัดคอส',

  // ผักกาดหอม
  'lettuce': 'ผักกาดหอม',
  'ผักกาดหอม': 'ผักกาดหอม',

  // ผักบุ้ง
  'morning glory': 'ผักบุ้ง',
  'water spinach': 'ผักบุ้ง',
  'ผักบุ้งจีน': 'ผักบุ้ง',
  'ผักบุ้ง': 'ผักบุ้ง',

  // เคล
  'kale': 'เคล',
  'คะน้าเคล': 'เคล',
  'เคล': 'เคล',

  // คื่นฉ่าย
  'celery': 'คื่นฉ่าย',
  'ขึ้นฉ่าย': 'คื่นฉ่าย',
  'คื่นฉ่าย': 'คื่นฉ่าย',

  // สตรอเบอร์รี่
  'strawberry': 'สตรอเบอร์รี่',
  'สตอเบอรี่': 'สตรอเบอร์รี่',
  'สตรอเบอรี่': 'สตรอเบอร์รี่',
  'สตรอเบอร์รี่': 'สตรอเบอร์รี่',

  // มะเขือเทศ
  'tomato': 'มะเขือเทศ',
  'มะเขือเทศ': 'มะเขือเทศ',
  'มะเขือเทศเชอร์รี่': 'มะเขือเทศ',

  // เมลอน
  'melon': 'เมลอน',
  'cantaloupe': 'เมลอน',
  'เมล่อน': 'เมลอน',
  'แคนตาลูป': 'เมลอน',
  'เมลอน': 'เมลอน',

  // แตงกวาญี่ปุ่น
  'japanese cucumber': 'แตงกวาญี่ปุ่น',
  'cucumber': 'แตงกวาญี่ปุ่น',
  'แตงกวา': 'แตงกวาญี่ปุ่น',
  'แตงกวาญี่ปุ่น': 'แตงกวาญี่ปุ่น',

  // สะระแหน่
  'mint': 'สะระแหน่',
  'peppermint': 'สะระแหน่',
  'สะระแหน่': 'สะระแหน่',

  // โหระพา
  'basil': 'โหระพา',
  'sweet basil': 'โหระพา',
  'โหระพา': 'โหระพา',
};

export function normalizePlantName(name: string): string {
  if (!name) return '';
  const cleaned = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return ALIAS_MAP[cleaned] || cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Built-in Plant Profiles Table (ฐานข้อมูลพืชมาตรฐานในตัวแอป)
// ─────────────────────────────────────────────────────────────────────────────
export const BUILTIN_PLANT_PROFILES: Record<string, PlantProfile> = {
  'กรีนโอ๊ค': {
    recognized: true,
    canonical_name_th: 'กรีนโอ๊ค',
    canonical_name_en: 'Green Oak Lettuce',
    hydroponic_suitable: true,
    harvest_days: { min: 40, max: 45 },
    ph: { min: 5.8, max: 6.5 },
    ec_ms_cm: { min: 1.4, max: 1.8 },
    water_temp_c: { min: 22.0, max: 26.0 },
    stages: {
      seedling: { ec_min: 0.8, ec_max: 1.2 },
      vegetative: { ec_min: 1.4, ec_max: 1.8 },
      maturity: { ec_min: 1.4, ec_max: 1.8 },
    },
    confidence: 'high',
    notes: 'ระวังอุณหภูมิน้ำเกิน 28°C เสี่ยงเกิดอาการปลายใบไหม้ (Tip burn)',
    isFromBuiltin: true,
  },
  'เรดโอ๊ค': {
    recognized: true,
    canonical_name_th: 'เรดโอ๊ค',
    canonical_name_en: 'Red Oak Lettuce',
    hydroponic_suitable: true,
    harvest_days: { min: 40, max: 45 },
    ph: { min: 5.8, max: 6.5 },
    ec_ms_cm: { min: 1.4, max: 1.8 },
    water_temp_c: { min: 22.0, max: 26.0 },
    confidence: 'high',
    notes: 'ต้องการแสงแดดเพียงพอเพื่อขับสีแดงของใบให้สดชัดเจน',
    isFromBuiltin: true,
  },
  'สลัดคอส': {
    recognized: true,
    canonical_name_th: 'สลัดคอส',
    canonical_name_en: 'Cos / Romaine Lettuce',
    hydroponic_suitable: true,
    harvest_days: { min: 45, max: 50 },
    ph: { min: 5.8, max: 6.5 },
    ec_ms_cm: { min: 1.5, max: 2.0 },
    water_temp_c: { min: 22.0, max: 26.0 },
    confidence: 'high',
    notes: 'ทนทานต่อสภาพอากาศร้อนได้ดีกว่าผักสลัดใบอ่อนทั่วไป',
    isFromBuiltin: true,
  },
  'ผักกาดหอม': {
    recognized: true,
    canonical_name_th: 'ผักกาดหอม',
    canonical_name_en: 'Grand Rapids Lettuce',
    hydroponic_suitable: true,
    harvest_days: { min: 40, max: 45 },
    ph: { min: 5.8, max: 6.5 },
    ec_ms_cm: { min: 1.3, max: 1.8 },
    water_temp_c: { min: 22.0, max: 26.0 },
    confidence: 'high',
    notes: 'เก็บเกี่ยวตามกำหนดเพื่อป้องกันรสชาติขมจากยางในลำต้น',
    isFromBuiltin: true,
  },
  'ผักบุ้ง': {
    recognized: true,
    canonical_name_th: 'ผักบุ้ง',
    canonical_name_en: 'Water Spinach',
    hydroponic_suitable: true,
    harvest_days: { min: 20, max: 25 },
    ph: { min: 5.5, max: 6.5 },
    ec_ms_cm: { min: 1.8, max: 2.4 },
    water_temp_c: { min: 25.0, max: 30.0 },
    confidence: 'high',
    notes: 'โตไวมาก ใช้น้ำและธาตุอาหารสูง ทนความร้อนได้ดีเยี่ยม',
    isFromBuiltin: true,
  },
  'เคล': {
    recognized: true,
    canonical_name_th: 'เคล',
    canonical_name_en: 'Curly Kale',
    hydroponic_suitable: true,
    harvest_days: { min: 50, max: 60 },
    ph: { min: 6.0, max: 6.8 },
    ec_ms_cm: { min: 1.8, max: 2.5 },
    water_temp_c: { min: 20.0, max: 25.0 },
    confidence: 'high',
    notes: 'ต้องการปุ๋ยเข้มข้นและธาตุเหล็กสูงเพื่อให้ใบหยิกหนาเข้ม',
    isFromBuiltin: true,
  },
  'คื่นฉ่าย': {
    recognized: true,
    canonical_name_th: 'คื่นฉ่าย',
    canonical_name_en: 'Chinese Celery',
    hydroponic_suitable: true,
    harvest_days: { min: 55, max: 65 },
    ph: { min: 6.0, max: 6.8 },
    ec_ms_cm: { min: 1.8, max: 2.2 },
    water_temp_c: { min: 22.0, max: 27.0 },
    confidence: 'high',
    notes: 'ระยะต้นกล้าโตช้า ต้องการออกซิเจนในน้ำอย่างสม่ำเสมอ',
    isFromBuiltin: true,
  },
  'สตรอเบอร์รี่': {
    recognized: true,
    canonical_name_th: 'สตรอเบอร์รี่',
    canonical_name_en: 'Strawberry',
    hydroponic_suitable: true,
    harvest_days: { min: 70, max: 90 },
    ph: { min: 5.5, max: 6.2 },
    ec_ms_cm: { min: 0.8, max: 1.2 }, // EC ต่ำมาก ไวต่อปุ๋ยเค็ม
    water_temp_c: { min: 18.0, max: 22.0 },
    confidence: 'high',
    notes: 'ต้องการ EC ต่ำมาก (0.8-1.2 mS/cm) ปุ๋ยเข้มข้นจะทำให้รากไหม้ทันที',
    isFromBuiltin: true,
  },
  'มะเขือเทศ': {
    recognized: true,
    canonical_name_th: 'มะเขือเทศ',
    canonical_name_en: 'Tomato',
    hydroponic_suitable: true,
    harvest_days: { min: 70, max: 85 },
    ph: { min: 5.8, max: 6.5 },
    ec_ms_cm: { min: 2.0, max: 3.5 },
    water_temp_c: { min: 22.0, max: 28.0 },
    confidence: 'high',
    notes: 'ช่วงติดผลต้องการ EC สูงและโพแทสเซียม-แคลเซียมเข้มข้น',
    isFromBuiltin: true,
  },
  'เมลอน': {
    recognized: true,
    canonical_name_th: 'เมลอน',
    canonical_name_en: 'Japanese Melon',
    hydroponic_suitable: true,
    harvest_days: { min: 75, max: 85 },
    ph: { min: 6.0, max: 6.8 },
    ec_ms_cm: { min: 2.0, max: 3.0 },
    water_temp_c: { min: 24.0, max: 28.0 },
    confidence: 'high',
    notes: 'ต้องการการควบคุมระดับน้ำและปุ๋ยอย่างแม่นยำเพื่อสร้างลายเน็ตและความหวาน',
    isFromBuiltin: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. validatePlantProfile(): ตรวจสอบ Schema & เพดานความปลอดภัย (Safety Ceilings)
// ─────────────────────────────────────────────────────────────────────────────
export function validatePlantProfile(json: any): PlantProfile {
  if (!json || typeof json !== 'object') {
    throw new Error('Invalid plant profile: must be an object');
  }

  // กรณี AI ไม่รู้จักหรือไม่เหมาะกับไฮโดรโปนิกส์
  if (json.recognized === false || json.hydroponic_suitable === false) {
    return {
      recognized: Boolean(json.recognized),
      canonical_name_th: String(json.canonical_name_th || 'ไม่ทราบชื่อ'),
      canonical_name_en: String(json.canonical_name_en || 'Unknown Plant'),
      hydroponic_suitable: Boolean(json.hydroponic_suitable),
      harvest_days: { min: 30, max: 50 },
      ph: { min: 5.5, max: 6.5 },
      ec_ms_cm: { min: 1.2, max: 1.8 },
      water_temp_c: { min: 22.0, max: 28.0 },
      confidence: json.confidence === 'high' ? 'high' : json.confidence === 'medium' ? 'medium' : 'low',
      notes: String(json.notes || (json.hydroponic_suitable === false ? 'ไม่เหมาะกับการปลูกในระบบไฮโดรโปนิกส์' : 'ไม่พบข้อมูลในสารบบพฤกษศาสตร์')),
    };
  }

  const { ph, ec_ms_cm, water_temp_c, harvest_days } = json;

  if (!ph || typeof ph.min !== 'number' || typeof ph.max !== 'number') {
    throw new Error('Invalid pH range in plant profile');
  }
  if (!ec_ms_cm || typeof ec_ms_cm.min !== 'number' || typeof ec_ms_cm.max !== 'number') {
    throw new Error('Invalid EC range in plant profile');
  }
  if (!water_temp_c || typeof water_temp_c.min !== 'number' || typeof water_temp_c.max !== 'number') {
    throw new Error('Invalid water temperature range in plant profile');
  }
  if (!harvest_days || typeof harvest_days.min !== 'number' || typeof harvest_days.max !== 'number') {
    throw new Error('Invalid harvest days range in plant profile');
  }

  // เพดานความปลอดภัยตามข้อกำหนด:
  // pH 4.5 - 8.0, min < max
  if (ph.min < 4.5 || ph.max > 8.0 || ph.min >= ph.max) {
    throw new Error(`pH range out of safety ceilings (4.5 - 8.0): got [${ph.min}, ${ph.max}]`);
  }

  // EC 0.3 - 4.0, min < max
  if (ec_ms_cm.min < 0.3 || ec_ms_cm.max > 4.0 || ec_ms_cm.min >= ec_ms_cm.max) {
    throw new Error(`EC range out of safety ceilings (0.3 - 4.0): got [${ec_ms_cm.min}, ${ec_ms_cm.max}]`);
  }

  // Temp 10 - 35, min < max
  if (water_temp_c.min < 10.0 || water_temp_c.max > 35.0 || water_temp_c.min >= water_temp_c.max) {
    throw new Error(`Water temp range out of safety ceilings (10 - 35°C): got [${water_temp_c.min}, ${water_temp_c.max}]`);
  }

  // Harvest 10 - 200, min < max
  if (harvest_days.min < 10 || harvest_days.max > 200 || harvest_days.min >= harvest_days.max) {
    throw new Error(`Harvest days out of safety ceilings (10 - 200 days): got [${harvest_days.min}, ${harvest_days.max}]`);
  }

  return {
    recognized: true,
    canonical_name_th: String(json.canonical_name_th || 'พืชทั่วไป'),
    canonical_name_en: String(json.canonical_name_en || 'General Hydroponic Plant'),
    hydroponic_suitable: true,
    harvest_days: { min: harvest_days.min, max: harvest_days.max },
    ph: { min: parseFloat(ph.min.toFixed(2)), max: parseFloat(ph.max.toFixed(2)) },
    ec_ms_cm: { min: parseFloat(ec_ms_cm.min.toFixed(2)), max: parseFloat(ec_ms_cm.max.toFixed(2)) },
    water_temp_c: { min: parseFloat(water_temp_c.min.toFixed(1)), max: parseFloat(water_temp_c.max.toFixed(1)) },
    stages: json.stages,
    confidence: json.confidence === 'high' ? 'high' : json.confidence === 'medium' ? 'medium' : 'low',
    notes: String(json.notes || 'ค่าประมาณจาก AI ภายนอก ควรตรวจสอบก่อนใช้งานจริง'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PlantLock & Anti-Tampering Engine (กันสแปม AI & กันโกงเวลา)
// ─────────────────────────────────────────────────────────────────────────────
export function getEffectiveTime(nowDate?: Date): number {
  const storage = getPlantStorage();
  const rawNow = (nowDate || new Date()).getTime();

  try {
    const rawLastSeen = storage.getItem(LAST_SEEN_KEY);
    const lastSeen = rawLastSeen ? parseInt(rawLastSeen, 10) : 0;

    // ถ้าเวลาปัจจุบันน้อยกว่า lastSeen แสดงว่ามีการหมุนเวลานาฬิกาย้อนหลัง
    const effectiveNow = Math.max(rawNow, lastSeen);
    storage.setItem(LAST_SEEN_KEY, String(effectiveNow));
    return effectiveNow;
  } catch (_) {
    return rawNow;
  }
}

export function calculateNextMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getPlantLock(nowDate?: Date): PlantLockInfo | null {
  const storage = getPlantStorage();
  try {
    const raw = storage.getItem(LOCK_KEY);
    if (!raw) return null;
    const lock: PlantLockInfo = JSON.parse(raw);
    const effectiveNow = getEffectiveTime(nowDate);

    // พ้นเวลา 00:00 น. แล้ว ปลดล็อกอัตโนมัติ
    if (effectiveNow >= lock.lockedUntil) {
      storage.removeItem(LOCK_KEY);
      return null;
    }
    return lock;
  } catch (_) {
    return null;
  }
}

export function setPlantLock(plantKeys: string[], nowDate?: Date): PlantLockInfo {
  const storage = getPlantStorage();
  const confirmedAt = getEffectiveTime(nowDate);
  const lockedUntil = calculateNextMidnight(confirmedAt);
  const graceUntil = confirmedAt + 10 * 60 * 1000; // 10 นาทีแรก

  const lock: PlantLockInfo = {
    confirmedAt,
    lockedUntil,
    plantKeys,
    graceUntil,
    graceUsed: false,
  };

  storage.setItem(LOCK_KEY, JSON.stringify(lock));
  return lock;
}

export function cancelPlantLockInGrace(nowDate?: Date): boolean {
  const storage = getPlantStorage();
  const lock = getPlantLock(nowDate);
  if (!lock) return false;

  const effectiveNow = getEffectiveTime(nowDate);
  if (effectiveNow <= lock.graceUntil && !lock.graceUsed) {
    storage.removeItem(LOCK_KEY);
    return true;
  }
  return false;
}

export function isPlantLockedForNewAI(nowDate?: Date): boolean {
  const lock = getPlantLock(nowDate);
  if (!lock) return false;

  const effectiveNow = getEffectiveTime(nowDate);
  // ถ้ายังอยู่ในช่วง grace 10 นาที ยังไม่ถือว่าล็อกสนิท
  if (effectiveNow <= lock.graceUntil && !lock.graceUsed) {
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. getPlantProfile(): ตารางในแอป -> Cache -> เรียก AI (Single Entry Point)
// ─────────────────────────────────────────────────────────────────────────────
export const PLANT_AI_PROMPT_TEMPLATE = (plantName: string) => `คุณคือผู้เชี่ยวชาญการปลูกพืชไฮโดรโปนิกส์ ผู้ใช้พิมพ์ชื่อพืช: "${plantName}"
ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น ตามโครงนี้:
{
  "recognized": true,
  "canonical_name_th": "...",
  "canonical_name_en": "...",
  "hydroponic_suitable": true,
  "harvest_days": {"min": 40, "max": 45},
  "ph": {"min": 5.8, "max": 6.5},
  "ec_ms_cm": {"min": 1.4, "max": 1.8},
  "water_temp_c": {"min": 22.0, "max": 26.0},
  "stages": {
    "seedling": {"ec_min": 1.0, "ec_max": 1.2},
    "vegetative": {"ec_min": 1.4, "ec_max": 1.8},
    "maturity": {"ec_min": 1.4, "ec_max": 1.8}
  },
  "confidence": "high",
  "notes": "ข้อควรระวังสั้นๆ ไม่เกิน 1 ประโยค"
}
กฎ: ให้เฉพาะค่าที่มั่นใจ ถ้าไม่แน่ใจให้ confidence เป็น low ห้ามเดาตัวเลขให้ดูน่าเชื่อถือ ถ้าเป็นไม้ผลหรือไม้ยืนต้นที่ไม่เหมาะกับระบบนี้ ให้ hydroponic_suitable เป็น false`;

export async function getPlantProfile(
  rawName: string,
  callAI?: (prompt: string) => Promise<string>,
  nowDate?: Date
): Promise<PlantProfile> {
  const normName = normalizePlantName(rawName);
  const storage = getPlantStorage();

  // 0. Sanity & Anti-Hallucination Filter (ตรวจจับคำสุ่ม เช่น "ตตตต", อักษรซ้ำ, ตัวเลขล้วน)
  const validation = isValidPlantQuery(normName);
  if (!validation.valid) {
    return {
      recognized: false,
      canonical_name_th: normName || 'ไม่ระบุ',
      canonical_name_en: 'Unrecognized Plant',
      hydroponic_suitable: false,
      harvest_days: { min: 0, max: 0 },
      ph: { min: 0, max: 0 },
      ec_ms_cm: { min: 0, max: 0 },
      water_temp_c: { min: 0, max: 0 },
      confidence: 'low',
      notes: validation.reason || 'ชื่อพืชไม่ถูกต้องหรือไม่พบในฐานข้อมูลไฮโดรโปนิกส์',
      isEstimated: false,
    };
  }

  // 1. ตรวจสอบตารางพืชมาตรฐานในตัวแอป (Built-in Table Hit)
  if (BUILTIN_PLANT_PROFILES[normName]) {
    return { ...BUILTIN_PLANT_PROFILES[normName] };
  }

  // 2. ตรวจสอบ Local Cache ในแอป (Cache Hit)
  try {
    const cachedRaw = storage.getItem(`${CACHE_PREFIX}${normName}`);
    if (cachedRaw) {
      const parsed = JSON.parse(cachedRaw);
      return { ...parsed, isFromCache: true };
    }
  } catch (_) {}

  // 3. ตรวจสอบการล็อก (ถ้ายังล็อกอยู่ และไม่มีใน Table หรือ Cache จะปฏิเสธการเรียก AI)
  if (isPlantLockedForNewAI(nowDate)) {
    const lock = getPlantLock(nowDate);
    throw new PlantLockedError(
      'ระบบล็อกการวิเคราะห์พืชใหม่จนถึง 00:00 น. เพื่อประหยัดทรัพยากร AI (แต่ยังเลือกพืชในตารางหรือแก้ตัวเลขเองได้ครับ)',
      lock ? lock.lockedUntil : calculateNextMidnight(Date.now())
    );
  }

  // 4. เรียก AI เพื่อวิเคราะห์พืชชนิดใหม่
  let aiFailure = '';
  if (callAI) {
    try {
      const prompt = PLANT_AI_PROMPT_TEMPLATE(normName);
      const rawResponse = await callAI(prompt);

      // แกะ JSON ออกจากข้อความ AI (ดักตัด markdown code blocks)
      let cleanedJson = rawResponse.trim();
      if (cleanedJson.includes('```')) {
        const match = cleanedJson.match(/```(?:json)?([\s\S]*?)```/);
        if (match) cleanedJson = match[1].trim();
      }

      const parsed = JSON.parse(cleanedJson);
      const validated = validatePlantProfile(parsed);

      // บันทึกลง Cache เฉพาะเมื่อข้อมูลผ่านเกณฑ์ และได้รับการรับรองว่าปลูกได้
      if (validated.recognized && validated.hydroponic_suitable) {
        storage.setItem(`${CACHE_PREFIX}${normName}`, JSON.stringify(validated));
      }
      return validated;
    } catch (err: any) {
      if (err instanceof PlantLockedError) throw err;
      // หาก AI ล่มหรือโยน Error ให้ข้ามไปใช้ Fallback แบบ Fail-Closed ทันที (แต่บอกผู้ใช้ว่าเพราะ AI ใช้ไม่ได้)
      aiFailure = describeAiFailure(err);
    }
  }

  // 5. Fallback ปลอดภัย (Fail-Closed: เมื่อ AI ล่ม/ออฟไลน์/ไม่รู้จัก ห้ามเดาว่าเป็นพืชที่ปลูกได้เด็ดขาด)
  const fallbackProfile: PlantProfile = {
    recognized: false,
    canonical_name_th: normName || 'ไม่ระบุ',
    canonical_name_en: 'Unrecognized Plant',
    hydroponic_suitable: false,
    harvest_days: { min: 0, max: 0 },
    ph: { min: 0, max: 0 },
    ec_ms_cm: { min: 0, max: 0 },
    water_temp_c: { min: 0, max: 0 },
    confidence: 'low',
    notes: aiFailure
      ? `วิเคราะห์ด้วย AI ไม่สำเร็จ (${aiFailure}) จึงยังไม่มีค่าแนะนำที่ยืนยันได้ ลองใหม่อีกครั้ง หรือเลือกพืชจากรายการ`
      : 'ไม่พบพืชนี้ในฐานข้อมูลพืชในแอป จึงยังไม่มีค่าแนะนำที่ยืนยันได้ กรุณาเลือกพืชจากรายการหรือตรวจสอบชื่อพืช',
    isEstimated: false,
  };

  return fallbackProfile;
}

/** Short Thai reason for a failed AI call (never echoes the key or the raw response body). */
function describeAiFailure(err: any): string {
  const msg = String(err?.message || '');
  if (/\((400|401|403)\)/.test(msg)) return 'คีย์ AI ไม่ถูกต้องหรือถูกปิดใช้งาน';
  if (/\(429\)/.test(msg)) return 'ใช้ AI ครบโควตาแล้ว ลองใหม่ภายหลัง';
  if (/\(5\d\d\)/.test(msg)) return 'บริการ AI ขัดข้องชั่วคราว';
  if (/ยังไม่ได้ตั้งค่า/.test(msg)) return 'แอปยังไม่ได้ตั้งค่าคีย์ AI';
  if (err instanceof SyntaxError) return 'AI ตอบกลับในรูปแบบที่อ่านไม่ได้';
  if (/fetch|network|Failed/i.test(msg)) return 'เชื่อมต่ออินเทอร์เน็ตไม่ได้';
  return 'AI ตอบกลับไม่ถูกต้อง';
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. mergePlantTargets(): คำนวณช่วงซ้อนทับ (Intersection) หรือตรวจจับ Conflict
// ─────────────────────────────────────────────────────────────────────────────
export function mergePlantTargets(profiles: PlantProfile[]): MergedPlantTargets {
  if (!profiles || profiles.length === 0) {
    return {
      phMin: 5.8,
      phMax: 6.5,
      ecMin: 1.4,
      ecMax: 1.8,
      tempMin: 22.0,
      tempMax: 26.0,
      harvestDays: 45,
      conflict: false,
      disadvantagedPlants: [],
      compatiblePlantNames: [],
    };
  }

  // ตรวจจับพืชที่ไม่รู้จัก หรือไม่เหมาะกับการปลูกไฮโดรโปนิกส์ (Fail-Closed Enforcement)
  const invalidOrUnsuitable = profiles.filter((p) => !p.recognized || !p.hydroponic_suitable);
  if (invalidOrUnsuitable.length > 0) {
    const invalidNames = invalidOrUnsuitable.map((p) => p.canonical_name_th).join(', ');
    return {
      phMin: 0,
      phMax: 0,
      ecMin: 0,
      ecMax: 0,
      tempMin: 0,
      tempMax: 0,
      harvestDays: 0,
      conflict: true,
      disadvantagedPlants: invalidOrUnsuitable.map((p) => p.canonical_name_th),
      warning: `ไม่สามารถเริ่มรอบการปลูกได้: พบพืชที่ไม่รู้จักหรือไม่เหมาะกับไฮโดรโปนิกส์ (${invalidNames}) กรุณาตรวจสอบหรือเปลี่ยนชนิดพืช`,
      compatiblePlantNames: [],
    };
  }

  const plantNames = profiles.map((p) => p.canonical_name_th);

  // คำนวณช่วงซ้อนทับ (Intersection)
  const overlapPhMin = Math.max(...profiles.map((p) => p.ph.min));
  const overlapPhMax = Math.min(...profiles.map((p) => p.ph.max));

  const overlapEcMin = Math.max(...profiles.map((p) => p.ec_ms_cm.min));
  const overlapEcMax = Math.min(...profiles.map((p) => p.ec_ms_cm.max));

  const overlapTempMin = Math.max(...profiles.map((p) => p.water_temp_c.min));
  const overlapTempMax = Math.min(...profiles.map((p) => p.water_temp_c.max));

  const maxHarvestDays = Math.max(...profiles.map((p) => p.harvest_days.max));

  const phConflict = overlapPhMin > overlapPhMax;
  const ecConflict = overlapEcMin > overlapEcMax;
  const tempConflict = overlapTempMin > overlapTempMax;
  const conflict = phConflict || ecConflict || tempConflict;

  if (!conflict) {
    return {
      phMin: parseFloat(overlapPhMin.toFixed(2)),
      phMax: parseFloat(overlapPhMax.toFixed(2)),
      ecMin: parseFloat(overlapEcMin.toFixed(2)),
      ecMax: parseFloat(overlapEcMax.toFixed(2)),
      tempMin: parseFloat(overlapTempMin.toFixed(1)),
      tempMax: parseFloat(overlapTempMax.toFixed(1)),
      harvestDays: maxHarvestDays,
      conflict: false,
      disadvantagedPlants: [],
      compatiblePlantNames: plantNames,
    };
  }

  // กรณีเกิด Conflict: คำนวณค่ากลางถ่วงน้ำหนัก (Weighted Average / Compromise)
  const avgPhMin = profiles.reduce((acc, p) => acc + p.ph.min, 0) / profiles.length;
  const avgPhMax = profiles.reduce((acc, p) => acc + p.ph.max, 0) / profiles.length;

  const avgEcMin = profiles.reduce((acc, p) => acc + p.ec_ms_cm.min, 0) / profiles.length;
  const avgEcMax = profiles.reduce((acc, p) => acc + p.ec_ms_cm.max, 0) / profiles.length;

  const avgTempMin = profiles.reduce((acc, p) => acc + p.water_temp_c.min, 0) / profiles.length;
  const avgTempMax = profiles.reduce((acc, p) => acc + p.water_temp_c.max, 0) / profiles.length;

  // ค้นหารายชื่อพืชที่เสียเปรียบ (พืชที่มีช่วงความต้องการขัดแย้งกับพืชชนิดอื่นในถังเดียวกัน)
  const disadvantaged: string[] = [];
  profiles.forEach((p) => {
    const hasConflictWithOther = profiles.some((other) => {
      if (other === p) return false;
      const noOverlapEc = p.ec_ms_cm.max < other.ec_ms_cm.min || p.ec_ms_cm.min > other.ec_ms_cm.max;
      const noOverlapPh = p.ph.max < other.ph.min || p.ph.min > other.ph.max;
      const noOverlapTemp = p.water_temp_c.max < other.water_temp_c.min || p.water_temp_c.min > other.water_temp_c.max;
      return noOverlapEc || noOverlapPh || noOverlapTemp;
    });
    if (hasConflictWithOther) {
      disadvantaged.push(p.canonical_name_th);
    }
  });

  return {
    phMin: parseFloat(avgPhMin.toFixed(2)),
    phMax: parseFloat(Math.max(avgPhMin + 0.3, avgPhMax).toFixed(2)),
    ecMin: parseFloat(avgEcMin.toFixed(2)),
    ecMax: parseFloat(Math.max(avgEcMin + 0.3, avgEcMax).toFixed(2)),
    tempMin: parseFloat(avgTempMin.toFixed(1)),
    tempMax: parseFloat(Math.max(avgTempMin + 2.0, avgTempMax).toFixed(1)),
    harvestDays: maxHarvestDays,
    conflict: true,
    disadvantagedPlants: disadvantaged,
    warning: `แนะนำแยกถัง: พืชชุดนี้มีความต้องการธาตุอาหารแตกต่างกันเกินไป (${disadvantaged.join(', ') || plantNames.join(', ')} อาจได้รับสารอาหารไม่เหมาะสม)`,
    compatiblePlantNames: plantNames,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Helper ยิงตรงสู่ Google Gemini API (ด้วย Key ที่ผู้ใช้ระบุ)
// ─────────────────────────────────────────────────────────────────────────────
export async function callGeminiPlantAPI(plantName: string, customApiKey?: string): Promise<string> {
  return callGeminiPrompt(PLANT_AI_PROMPT_TEMPLATE(plantName), customApiKey);
}

/**
 * Send an already-built prompt to Gemini. getPlantProfile() builds the plant prompt itself and hands it
 * to its callAI callback, so the screen must use THIS function there (callGeminiPlantAPI would wrap the
 * prompt in the template a second time and Gemini would read the whole prompt as the "plant name").
 */
export async function callGeminiPrompt(prompt: string, customApiKey?: string): Promise<string> {
  // Key: explicit arg -> the owner's build key (.env VITE_GEMINI_API_KEY, never committed). The build key ends up inside the APK, so use a free-tier key
  // restricted to the Generative Language API.
  // The app's own key (owner's, from .env) comes first; a key a user saved earlier is only a fallback
  // (the settings field was removed 2026-11-19).
  const apiKey = (customApiKey || BUILD_GEMINI_KEY || getUserGeminiKey() || '').trim();
  if (!apiKey) {
    throw new Error('ยังไม่ได้ตั้งค่า Gemini API Key ของแอป');
  }

  // Tried in order (verified 2026-11-19 with the owner's key: gemini-2.5-* is retired for new keys,
  // 3.5-flash-lite answers in ~9 s). A retired (404), busy (429/5xx) or slow model -> next one.
  // A wrong / disabled key (400/401/403) stops at once: another model would fail the same way.
  let lastError: Error = new Error('Empty response from Gemini API');
  for (const model of GEMINI_PLANT_MODELS) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS) : null;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        // key in a header, not in the URL (URLs end up in logs)
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: 'low' },
          },
        }),
        signal: ctrl?.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        lastError = new Error(`Gemini API Error (${res.status}): ${errText}`);
        if (res.status === 400 || res.status === 401 || res.status === 403) throw lastError;
        continue;
      }
      const data = await res.json();
      const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
      // thinking models may return a thought part first: take the last text part
      const contentText = [...parts].reverse().find((p) => typeof p?.text === 'string' && !p.thought)?.text;
      if (contentText) return contentText;
      lastError = new Error('Empty response from Gemini API');
    } catch (err: any) {
      if (err === lastError) throw err;
      lastError = err?.name === 'AbortError' ? new Error('Gemini API Error (504): timeout') : err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError;
}

const GEMINI_PLANT_MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash'] as const;
const GEMINI_TIMEOUT_MS = 30000;
