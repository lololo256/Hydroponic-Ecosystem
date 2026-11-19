/**
 * ==============================================================================
 * โครงการ: Hydroponic System (Smart Water Farm)
 * โมดูล: diurnalPredictor.ts (วิเคราะห์ตามช่วงเวลา: กฎตายตัวตามช่วงแดด ไม่ใช่ AI)
 * สถาปัตยกรรม: Diurnal Pattern & Anomaly Predictor Engine (Zero-Mock)
 * ==============================================================================
 */

export type DiurnalPhaseKey = 'morning_warmup' | 'peak_sun' | 'afternoon_winddown' | 'night_dormancy';

export interface DiurnalPhaseInfo {
  key: DiurnalPhaseKey;
  label: string;
  shortLabel: string;
  timeRange: string;
  iconName: 'sunrise' | 'sun' | 'sunset' | 'moon';
  badgeBg: string;
  badgeColor: string;
  badgeBorder: string;
  expectedBehavior: string;
  plantAdvice: string;
}

export interface DiurnalMetrics {
  currentPhase: DiurnalPhaseInfo;
  /** อัตราการลดลงของ EC ต่อชั่วโมง (mS/cm / hr); null เมื่อประวัติไม่ถึง 2 จุดหรือไม่มีค่า EC */
  ecConsumptionRatePerHour: number | null;
  /** null when no temperature reading exists */
  avgTempInPhase: number | null;
  dataPointsCount: number;
  anomalyDetected: boolean;
  anomalyType: 'none' | 'root_stress' | 'heat_spike' | 'ec_dilution' | 'ph_drift';
  anomalySeverity: 'normal' | 'info' | 'warning' | 'danger';
  briefingHeadline: string;
  briefingMessage: string;
  detailedAnalysis: string;
}

export interface HistoryDataPoint {
  pH?: number | null;
  ec?: number | null;
  tds?: number | null;
  tempC?: number | null;
  timestamp: number;
  level?: number | null;
}

// ------------------------------------------------------------------------------
// 1. กำหนดคุณลักษณะของช่วงเวลาแดดและพฤติกรรมพืชไฮโดรโปนิกส์
// ------------------------------------------------------------------------------
export const DIURNAL_PHASES: Record<DiurnalPhaseKey, DiurnalPhaseInfo> = {
  morning_warmup: {
    key: 'morning_warmup',
    label: 'ช่วงเช้า: ตื่นรับแสง & เริ่มสังเคราะห์แสง',
    shortLabel: 'เช้าตื่นรับแสง',
    timeRange: '06:00 - 10:00',
    iconName: 'sunrise',
    badgeBg: '#fffbeb',
    badgeColor: '#b45309',
    badgeBorder: '#fde68a',
    expectedBehavior: 'พืชเริ่มเปิดปากใบ การคายน้ำและดูดซึมปุ๋ยค่อยๆ เพิ่มขึ้นอย่างนุ่มนวล',
    plantAdvice: 'ค่า EC และ pH ควรเสถียร หากแดดเริ่มแรงควรเตรียมระดับน้ำสำรองให้พร้อม',
  },
  peak_sun: {
    key: 'peak_sun',
    label: 'ช่วงแดดจัด: คายน้ำสูงสุด (Peak Transpiration)',
    shortLabel: 'แดดจัดคายน้ำสูง',
    timeRange: '10:00 - 15:30',
    iconName: 'sun',
    badgeBg: '#fef2f2',
    badgeColor: '#b91c1c',
    badgeBorder: '#fecaca',
    expectedBehavior: 'พืชคายน้ำเร็วที่สุดในรอบวัน อัตรากินน้ำสูงกว่ากินปุ๋ย EC อาจเข้มขึ้นชั่วคราว',
    plantAdvice: 'ระวังอุณหภูมิน้ำเกิน 29°C อาจทำให้รากขาดออกซิเจน และควรดูระดับน้ำอย่าให้แห้ง',
  },
  afternoon_winddown: {
    key: 'afternoon_winddown',
    label: 'ช่วงบ่าย-เย็น: แดดร่มลมตก & สะสมสารอาหาร',
    shortLabel: 'บ่ายสะสมอาหาร',
    timeRange: '15:30 - 18:30',
    iconName: 'sunset',
    badgeBg: '#f0fdf4',
    badgeColor: '#15803d',
    badgeBorder: '#bbf7d0',
    expectedBehavior: 'การคายน้ำชะลอตัวลง พืชเน้นดูดซึมธาตุอาหาร N-P-K เพื่อนำไปสะสมสร้างเซลล์',
    plantAdvice: 'ช่วงนี้รากพืชกินปุ๋ยได้สมดุลดีที่สุด เหมาะสำหรับการตรวจสอบและปรับสมดุล EC/pH',
  },
  night_dormancy: {
    key: 'night_dormancy',
    label: 'ช่วงกลางคืน: พักผ่อน & ปิดปากใบ (Night Dormancy)',
    shortLabel: 'กลางคืนพักผ่อน',
    timeRange: '18:30 - 06:00',
    iconName: 'moon',
    badgeBg: '#f8fafc',
    badgeColor: '#475569',
    badgeBorder: '#e2e8f0',
    expectedBehavior: 'ปากใบปิดสนิท หยุดการคายน้ำ การใช้น้ำและสารอาหารแทบเป็นศูนย์',
    plantAdvice: 'ค่าปุ๋ยควรค่อนข้างนิ่ง หากสังเกตเห็นน้ำในถังลดลงมากช่วงนี้ ควรตรวจท่อและข้อต่อ',
  },
};

// ------------------------------------------------------------------------------
// 2. คำนวณช่วงเวลาแดดปัจจุบันจากเวลาจริง
// ------------------------------------------------------------------------------
export function getCurrentDiurnalPhase(now: Date = new Date()): DiurnalPhaseInfo {
  const hour = now.getHours();
  const minute = now.getMinutes();
  const totalMinutes = hour * 60 + minute;

  // 06:00 - 10:00 (360 - 600 นาที)
  if (totalMinutes >= 360 && totalMinutes < 600) {
    return DIURNAL_PHASES.morning_warmup;
  }
  // 10:00 - 15:30 (600 - 930 นาที)
  if (totalMinutes >= 600 && totalMinutes < 930) {
    return DIURNAL_PHASES.peak_sun;
  }
  // 15:30 - 18:30 (930 - 1110 นาที)
  if (totalMinutes >= 930 && totalMinutes < 1110) {
    return DIURNAL_PHASES.afternoon_winddown;
  }
  // 18:30 - 06:00
  return DIURNAL_PHASES.night_dormancy;
}

// ------------------------------------------------------------------------------
// 3. เครื่องยนต์หลักวิเคราะห์ Diurnal Pattern และตรวจจับ Anomaly (Real Physics)
// ------------------------------------------------------------------------------
export function analyzeDiurnalPattern(
  historyPoints: HistoryDataPoint[],
  /** null = no valid reading; rules that need a missing metric are skipped (never assumed) */
  currentSensors: { pH: number | null; ec: number | null; tempC: number | null; level?: number | null },
  plantType: string = 'พืชไฮโดรโปนิกส์',
  targetECMin: number = 1.4,
  targetECMax: number = 1.8,
  targetPHMin: number = 5.8,
  targetPHMax: number = 6.5,
  targets?: { ecMin?: number; ecMax?: number; phMin?: number; phMax?: number },
  now?: Date
): DiurnalMetrics {
  const currentDate = now || new Date();
  const currentPhase = getCurrentDiurnalPhase(currentDate);
  const nowMs = currentDate.getTime();

  // กำหนดเกณฑ์ใช้งานจริง (ให้ความสำคัญกับ targets object ก่อน)
  const effECMin = targets?.ecMin ?? targetECMin ?? 1.4;
  const effECMax = targets?.ecMax ?? targetECMax ?? 1.8;
  const effPHMin = targets?.phMin ?? targetPHMin ?? 5.8;
  const effPHMax = targets?.phMax ?? targetPHMax ?? 6.5;

  // กรองจุดข้อมูลประวัติย้อนหลัง 6 ชั่วโมงล่าสุด (ช่วงเวลาวิเคราะห์วงจรปัจจุบัน)
  const sixHoursAgo = nowMs - 6 * 60 * 60 * 1000;
  const recentPoints = (historyPoints || [])
    .filter((pt) => pt && pt.timestamp && pt.timestamp >= sixHoursAgo && pt.timestamp <= nowMs)
    .sort((a, b) => a.timestamp - b.timestamp);

  // null = ยังคำนวณไม่ได้ (ประวัติไม่ถึง 2 จุด หรือไม่มีค่า EC ทั้งต้นและปลายช่วง)
  let ecConsumptionRate: number | null = null;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  let avgTemp: number | null = num(currentSensors.tempC) ? currentSensors.tempC : null;

  if (recentPoints.length >= 2) {
    const firstPt = recentPoints[0];
    const lastPt = recentPoints[recentPoints.length - 1];
    const timeDeltaHours = Math.max(0.25, (lastPt.timestamp - firstPt.timestamp) / (1000 * 60 * 60));

    // คำนวณอัตราการกินปุ๋ย (ถ้าค่า EC ลดลง แสดงว่าพืชดูดซึมปุ๋ยไป)
    if (num(firstPt.ec) && num(lastPt.ec) && firstPt.ec > 0 && lastPt.ec > 0) {
      const deltaEc = firstPt.ec - lastPt.ec;
      ecConsumptionRate = Math.max(0, parseFloat((deltaEc / timeDeltaHours).toFixed(3)));
    }

    // ไม่คำนวณอัตราการใช้น้ำ: ระบบไม่มีเซนเซอร์วัดระดับน้ำแบบต่อเนื่อง (มีแค่สวิตช์ลูกลอย)

    // คำนวณอุณหภูมิเฉลี่ย
    const validTemps = recentPoints.map((p) => p.tempC).filter((t): t is number => typeof t === 'number' && t > 0);
    if (validTemps.length > 0) {
      avgTemp = parseFloat((validTemps.reduce((acc, v) => acc + v, 0) / validTemps.length).toFixed(1));
    }
  }

  // ----------------------------------------------------------------------------
  // 4. ระบบตรวจจับความผิดปกติ (Anomaly Detection Logic)
  // ----------------------------------------------------------------------------
  let anomalyDetected = false;
  let anomalyType: DiurnalMetrics['anomalyType'] = 'none';
  let anomalySeverity: DiurnalMetrics['anomalySeverity'] = 'normal';
  let briefingHeadline = '';
  let briefingMessage = '';
  let detailedAnalysis = '';

  const pH = num(currentSensors.pH) ? currentSensors.pH : null;
  const ec = num(currentSensors.ec) ? currentSensors.ec : null;
  const tempC = num(currentSensors.tempC) ? currentSensors.tempC : null;
  const hasAnyReading = pH !== null || ec !== null || tempC !== null;

  // (ตัดกฎ "น้ำลดตอนกลางคืน" ออก: ไม่มีเซนเซอร์วัดระดับน้ำแบบต่อเนื่อง จึงคำนวณไม่ได้จริง)
  // กฎที่ 2: ช่วงแดดร้อนจัด น้ำระเหยเร็วจนปุ๋ยเข้มข้นจัด (Heat-Induced Fertilizer Spike)
  if (currentPhase.key === 'peak_sun' && tempC !== null && ec !== null && tempC > 29.5 && ec > effECMax) {
    anomalyDetected = true;
    anomalyType = 'heat_spike';
    anomalySeverity = 'warning';
    briefingHeadline = 'แดดร้อนจัด: ปุ๋ยเข้มข้นขึ้นจากน้ำระเหย';
    briefingMessage = `แดดช่วงเที่ยง-บ่าย ทำให้อุณหภูมิน้ำขึ้นถึง ${tempC.toFixed(1)}°C น้ำระเหยเร็ว ส่งผลให้ค่าปุ๋ยพุ่งเป็น ${ec.toFixed(2)} mS (เกินเกณฑ์) แนะนำเติมน้ำเปล่าเจือจางเพื่อป้องกันปลายใบไหม้ครับ`;
    detailedAnalysis = `สภาพอากาศร้อนจัดส่งผลให้น้ำระเหยเร็วกว่าอัตราดูดซึมของพืช เกิดภาวะปุ๋ยเข้มข้นเกินเกณฑ์ (${ec.toFixed(2)} > ${effECMax} mS)`;
  }
  // กฎที่ 3: แดดจัดแต่รากพืชหยุดดูดซึมปุ๋ย (Peak Sun Root Shutdown)
  else if (currentPhase.key === 'peak_sun' && tempC !== null && recentPoints.length >= 4 && ecConsumptionRate !== null && ecConsumptionRate === 0 && tempC > 30.0) {
    anomalyDetected = true;
    anomalyType = 'root_stress';
    anomalySeverity = 'warning';
    briefingHeadline = 'รากพืชเผชิญความเครียดจากความร้อน';
    briefingMessage = `ช่วงแดดจัดนี้ค่าปุ๋ยแทบไม่ขยับ และอุณหภูมิน้ำสูง ${tempC.toFixed(1)}°C รากพืชอาจเครียดจากออกซิเจนในน้ำต่ำ แนะนำเปิดปั๊มพ่นน้ำสร้างออกซิเจนเพิ่มครับ`;
    detailedAnalysis = `ช่วงคายน้ำสูงสุดแต่ไม่มีอัตราการกินปุ๋ยร่วมกับอุณหภูมิน้ำสูง (${tempC.toFixed(1)}°C) บ่งชี้ความเสี่ยงรากขาดออกซิเจน`;
  }
  // กฎที่ 4: ค่าปุ๋ยเจือจางลงฮวบฮาบ (EC Dilution) - แก้ไข: ตัด -0.25 ออก
  else if (ec !== null && ec > 0 && ec < effECMin) {
    anomalyDetected = true;
    anomalyType = 'ec_dilution';
    anomalySeverity = 'warning';
    briefingHeadline = 'ค่าปุ๋ยเจือจางลงผิดปกติ';
    briefingMessage = `ค่าปุ๋ยลดลงอยู่ที่ ${ec.toFixed(2)} mS (ต่ำกว่าเกณฑ์ของ ${plantType}) อาจมีน้ำเติมเข้ามาเจือจาง แนะนำจ่ายแม่ปุ๋ย A+B เพิ่มให้พืชโตต่อเนื่องครับ`;
    detailedAnalysis = `ค่า EC ต่ำกว่าขอบล่างของเกณฑ์ที่เหมาะสม (${ec.toFixed(2)} < ${effECMin} mS) จำเป็นต้องเพิ่มธาตุอาหาร`;
  }
  // กฎที่ 5: ค่า pH แกว่งผิดปกติ (pH Drift)
  else if (pH !== null && pH > 0 && (pH < effPHMin || pH > effPHMax)) {
    anomalyDetected = true;
    anomalyType = 'ph_drift';
    anomalySeverity = 'warning';
    const direction = pH < effPHMin ? 'เป็นกรดเกินไป' : 'เป็นด่างเกินไป';
    briefingHeadline = `ค่า pH ${direction} (${pH.toFixed(2)})`;
    briefingMessage = `ค่า pH น้ำอยู่ที่ ${pH.toFixed(2)} (${direction}) พืชอาจดูดซึมธาตุอาหารบางตัวได้ไม่เต็มที่ แนะนำตรวจสอบและปรับสมดุลครับ`;
    detailedAnalysis = `ค่า pH หลุดกรอบเป้าหมาย (${effPHMin} - ${effPHMax}) ส่งผลต่อความสามารถในการแลกเปลี่ยนประจุของรากพืช`;
  }
  // สภาวะปกติ: พืชกินน้ำ-กินปุ๋ยตามรอบแดด (Optimal Diurnal Rhythm)
  // ไม่มีค่าเซนเซอร์ที่ใช้ได้เลย: ห้ามสรุปว่า "อยู่ในเกณฑ์"
  else if (!hasAnyReading) {
    anomalyDetected = false;
    anomalyType = 'none';
    anomalySeverity = 'info';
    briefingHeadline = 'ยังไม่มีค่าเซนเซอร์ที่ใช้ได้';
    briefingMessage = `ยังไม่ได้รับค่าตรวจวัดที่ใช้ได้จากอุปกรณ์ จึงยังประเมินสภาพน้ำของแปลง ${plantType} ไม่ได้ครับ`;
    detailedAnalysis = 'รอค่าตรวจวัด pH / EC / อุณหภูมิจากอุปกรณ์ ระบบจะไม่สรุปผลจากค่าที่ไม่มีอยู่จริง';
  }
  // ตัดคำว่า สมบูรณ์ / สมดุลดีมาก / ปลอดภัย 100% / ปราศจากสิ่งผิดปกติ / นอนหลับสบายใจ
  else {
    anomalyDetected = false;
    anomalyType = 'none';
    anomalySeverity = 'normal';

    switch (currentPhase.key) {
      case 'morning_warmup':
        briefingHeadline = 'ยามเช้า: แปลงผักตื่นรับแสงแดด';
        briefingMessage = `แปลง ${plantType} เริ่มเปิดปากใบรับแสงแดดยามเช้า การคายน้ำและดูดซึมธาตุอาหารค่อยๆ เริ่มต้นตามรอบวันครับ`;
        detailedAnalysis = `ช่วงเช้าตรู่ พืชเริ่มสังเคราะห์แสง การกินปุ๋ยค่อยเป็นค่อยไป`;
        break;

      case 'peak_sun':
        briefingHeadline = 'ช่วงแดดจัด: วงจรคายน้ำ & ดูดสารอาหารเต็มกำลัง';
        briefingMessage = ecConsumptionRate !== null && ecConsumptionRate > 0
          ? `ช่วงแดดจัดนี้ ${plantType} ใช้ปุ๋ยเฉลี่ย ~${ecConsumptionRate} mS/ชม. (คำนวณจากประวัติ ${recentPoints.length} จุด) พืชกำลังคายน้ำและลำเลียงสารอาหารครับ`
          : tempC !== null
          ? `ช่วงแดดจัดนี้ แปลง ${plantType} อยู่ในช่วงคายน้ำสูงสุด อุณหภูมิน้ำ ${tempC.toFixed(1)}°C ครับ`
          : `ช่วงแดดจัดนี้ แปลง ${plantType} อยู่ในช่วงคายน้ำสูงสุด (ยังไม่มีค่าอุณหภูมิน้ำ) ครับ`;
        detailedAnalysis = `ช่วงเวลาคายน้ำสูงสุดของวัน พืชดูดซึมน้ำและธาตุอาหารตามธรรมชาติ`;
        break;

      case 'afternoon_winddown':
        briefingHeadline = 'ช่วงบ่าย-เย็น: แดดร่มลมตก สะสมสารอาหาร';
        briefingMessage = `แดดเริ่มร่มลงแล้ว แปลง ${plantType} กำลังดูดซึมธาตุอาหารไปสะสมในลำต้นและใบอย่างต่อเนื่องครับ`;
        detailedAnalysis = `การคายน้ำชะลอตัว พืชสะสมสารอาหาร`;
        break;

      case 'night_dormancy':
      default:
        briefingHeadline = 'ยามค่ำคืน: แปลงผักพักผ่อนและปิดปากใบ';
        briefingMessage = `ตอนนี้แปลง ${plantType} ปิดปากใบและพักผ่อนในรอบค่ำ การใช้น้ำและสารอาหารชะลอตัวลงครับ`;
        detailedAnalysis = `เข้าสู่ช่วงพักผ่อนยามค่ำคืน พืชลดการคายน้ำ`;
        break;
    }
  }

  return {
    currentPhase,
    ecConsumptionRatePerHour: ecConsumptionRate,
    avgTempInPhase: avgTemp,
    dataPointsCount: recentPoints.length,
    anomalyDetected,
    anomalyType,
    anomalySeverity,
    briefingHeadline,
    briefingMessage,
    detailedAnalysis,
  };
}
