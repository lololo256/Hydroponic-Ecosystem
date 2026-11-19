/**
 * ==============================================================================
 * โครงการ: Hydroponic System (Smart Water Farm)
 * โมดูล: smartNotificationSynthesizer.ts
 * สถาปัตยกรรม: แจ้งเตือนอัจฉริยะ (AI Notification Synthesizer & Batching Engine)
 * ==============================================================================
 * คุณสมบัติหลัก:
 * 1. Notification Bundler / Batching: รวมเหตุการณ์หลายเรื่องในช่วงเวลาเดียวกัน (15-30s)
 *    เป็นข้อความเดียวที่กระชับ ไม่สแปมแถบแจ้งเตือน
 * 2. Smart Transition Cancelling: หากหลุดการเชื่อมต่อแล้วต่อกลับทันที จะไม่ตกใจแจ้งเตือนซ้ำซ้อน
 * 3. Quiet Hours Protector (22:00 - 06:00 น.): ไม่ส่งเสียงรบกวนยามดึก ยกเว้นเรื่องวิกฤต (P0 Leak / Major Offline)
 * 4. Deduplication & Progressive Backoff: ปัญหาเดิมที่ยังไม่แก้ จะไม่เตือนซ้ำทุก 5-10 นาที
 * 5. Device Native Sound Binding: ผูก Channel เข้ากับเสียงแจ้งเตือนระบบของเครื่องโทรศัพท์นั้นๆ
 * ==============================================================================
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertCategory =
  | 'connectivity_offline'
  | 'connectivity_online'
  | 'ph'
  | 'ec'
  | 'tds'
  | 'temp'
  | 'tank'
  | 'fertilizer'
  | 'leak'
  | 'general';

export interface RawAlertEvent {
  id?: string;
  level: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
  farmName: string;
  metric?: string;
  value?: number;
  timestamp: number;
  debounceKey: string;
}

export interface SynthesizedNotification {
  title: string;
  body: string;
  level: AlertSeverity;
  category: AlertCategory | 'synthesized_bundle';
  channelId: 'smartfarm_critical' | 'smartfarm_general';
  sound?: string; // ใช้เสียงระบบมาตรฐานของโทรศัพท์เครื่องนั้นๆ (System Default Sound)
  suppressedQuietHours?: boolean;
}

export interface IssueAlertRecord {
  count: number;
  lastAlertTs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ระบบตรวจจับช่วงเวลาพักผ่อน (Quiet Hours: 22:00 - 06:00 น.)
// ─────────────────────────────────────────────────────────────────────────────
export function isQuietHour(date: Date = new Date(), quietStartHour = 22, quietEndHour = 6): boolean {
  const hour = date.getHours();
  if (quietStartHour > quietEndHour) {
    // ข้ามเที่ยงคืน เช่น 22:00 ถึง 06:00
    return hour >= quietStartHour || hour < quietEndHour;
  }
  return hour >= quietStartHour && hour < quietEndHour;
}

/**
 * ตัดสินใจว่าควรระงับเสียง/การแจ้งเตือนตามช่วงเวลาพักหรือไม่
 * กฎ: ปัญหาทั่วไป (Info/Warning) ระงับยามดึก 100%
 * ปัญหาวิกฤตความปลอดภัยร้ายแรง (P0: leak, major disconnect) อนุญาตให้ปลุกได้
 */
export function shouldSuppressNotification(params: {
  level: AlertSeverity;
  category: AlertCategory | 'synthesized_bundle';
  date?: Date;
  quietStartHour?: number;
  quietEndHour?: number;
}): boolean {
  const { level, category, date = new Date(), quietStartHour = 22, quietEndHour = 6 } = params;
  if (!isQuietHour(date, quietStartHour, quietEndHour)) {
    return false;
  }

  // ในช่วงเวลาพักผ่อน: อนุญาตเฉพาะวิกฤตคอขาดบาดตาย (P0)
  if (category === 'leak' || category === 'connectivity_offline') {
    return false; // น้ำรั่วหรืออุปกรณ์ดับยาว ต้องแจ้งเตือน
  }

  // ปัญหาทั่วไป ค่าปุ๋ย/pH เบี่ยงเบนเล็กน้อย ให้ระงับไว้ ไม่ปลุกตอนดึก
  if (level !== 'critical') {
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ระบบ Progressive Backoff ป้องกันการเตือนซ้ำเรื่องเดิมที่ยังไม่แก้
// ─────────────────────────────────────────────────────────────────────────────
/**
 * คำนวณระยะเวลาหน่วงก่อนจะเตือนซ้ำเรื่องเดิม (หน่วย ms)
 * ครั้งที่ 1: แจ้งเตือนทันที (delay 0)
 * ครั้งที่ 2: เว้นอย่างน้อย 2 ชั่วโมง (120 นาที)
 * ครั้งที่ 3 เป็นต้นไป: เว้นอย่างน้อย 6 ชั่วโมง (360 นาที)
 */
export function calculateProgressiveBackoff(alertCount: number): number {
  if (alertCount <= 1) return 0;
  if (alertCount === 2) return 2 * 60 * 60 * 1000; // 2 ชม.
  return 6 * 60 * 60 * 1000; // 6 ชม.
}

export function shouldThrottleIssue(
  alertRecord?: IssueAlertRecord,
  now: number = Date.now()
): boolean {
  if (!alertRecord) return false;
  const backoffMs = calculateProgressiveBackoff(alertRecord.count + 1);
  return now - alertRecord.lastAlertTs < backoffMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Notification Bundler: รวมเหตุการณ์หลายเรื่องในช่วงเวลาเดียวกัน
// ─────────────────────────────────────────────────────────────────────────────
export function synthesizeAlertBatch(events: RawAlertEvent[]): SynthesizedNotification | null {
  if (!events || events.length === 0) return null;

  // หากมีเพียงเหตุการณ์เดียว
  if (events.length === 1) {
    const ev = events[0];
    const isCrit = ev.level === 'critical';
    return {
      title: ev.title,
      body: ev.message,
      level: ev.level,
      category: ev.category,
      channelId: isCrit ? 'smartfarm_critical' : 'smartfarm_general',
      sound: undefined,
    };
  }

  const farmName = events[0].farmName || 'ฟาร์ม';
  const hasOffline = events.some((e) => e.category === 'connectivity_offline');
  const hasOnline = events.some((e) => e.category === 'connectivity_online');
  const nutrientEvents = events.filter((e) => ['ec', 'tds', 'ph'].includes(e.category));
  const tankEvents = events.filter((e) => e.category === 'tank');
  const leakEvents = events.filter((e) => e.category === 'leak');

  // เคสที่ 1: เกิดทั้ง Offline และ Online ในหน้าต่างเวลาเดียวกัน (เน็ตสวิงแล้วกลับมาต่อได้)
  if (hasOffline && hasOnline) {
    if (nutrientEvents.length > 0) {
      // รวมเป็น: ต่อเน็ตกลับมาได้แล้ว แต่พบค่าสารละลายนอกเกณฑ์
      const nutDesc = nutrientEvents.map((e) => e.message.replace(/^AI วิเคราะห์:\s*/, '').replace(/^.*?อยู่ที่\s*/, '')).join(' และ ');
      return {
        title: `ออนไลน์แล้ว & สารละลายเบี่ยงเบน`,
        body: `AI วิเคราะห์: อุปกรณ์เชื่อมต่อกลับสำเร็จ แต่ตรวจพบ ${nutDesc} แนะนำตรวจเช็กแปลงครับ`,
        level: nutrientEvents.some((e) => e.level === 'critical') ? 'critical' : 'warning',
        category: 'synthesized_bundle',
        channelId: nutrientEvents.some((e) => e.level === 'critical') ? 'smartfarm_critical' : 'smartfarm_general',
        sound: undefined,
      };
    }

    // แค่เน็ตสวิงชั่วคราวแล้วต่อติด
    return {
      title: `สัญญาณเชื่อมต่อเสถียรแล้ว`,
      body: `AI วิเคราะห์: อุปกรณ์เชื่อมต่อกลับเข้าระบบเรียบร้อย ข้อมูลเซ็นเซอร์กำลังอัปเดตต่อเนื่อง`,
      level: 'info',
      category: 'connectivity_online',
      channelId: 'smartfarm_general',
      sound: undefined,
    };
  }

  // เคสที่ 2: พบปัญหาค่าน้ำหลายตัวพร้อมกัน (เช่น EC ต่ำ และ pH สูง)
  if (nutrientEvents.length > 1) {
    const parts = nutrientEvents.map((e) => {
      if (e.category === 'ec' && e.value) return `EC=${e.value.toFixed(2)}`;
      if (e.category === 'ph' && e.value) return `pH=${e.value.toFixed(2)}`;
      if (e.category === 'tds' && e.value) return `TDS=${e.value}`;
      return e.title;
    });

    const isCrit = nutrientEvents.some((e) => e.level === 'critical');
    return {
      title: `ค่าน้ำเบี่ยงเบนหลายตัว`,
      body: `AI วิเคราะห์: ตรวจพบค่า (${parts.join(', ')}) อยู่นอกเกณฑ์เป้าหมาย แนะนำปรับสมดุลน้ำและปุ๋ยครับ`,
      level: isCrit ? 'critical' : 'warning',
      category: 'synthesized_bundle',
      channelId: isCrit ? 'smartfarm_critical' : 'smartfarm_general',
      sound: undefined,
    };
  }

  // เคสที่ 3: น้ำรั่วร่วมกับน้ำในถังลดฮวบ
  if (leakEvents.length > 0 || tankEvents.length > 0) {
    const isLeak = leakEvents.length > 0;
    return {
      title: isLeak ? `ตรวจพบน้ำรั่วซึม` : `น้ำในถังต่ำ`,
      body: isLeak
        ? `AI วิเคราะห์: ระดับน้ำลดลงผิดปกติ เสี่ยงท่อรั่วซึม แนะนำรีบตรวจเช็กแปลงปลูกทันทีครับ`
        : `AI วิเคราะห์: ระดับน้ำในถังสารละลายลดต่ำกว่าเกณฑ์ปลอดภัย กรุณาเติมน้ำเพื่อป้องกันปั๊มสูบแห้ง`,
      level: 'critical',
      category: isLeak ? 'leak' : 'tank',
      channelId: 'smartfarm_critical',
      sound: undefined,
    };
  }

  // Fallback รวม: เรียงตามความสำคัญสูงสุด
  const highestSeverity: AlertSeverity = events.some((e) => e.level === 'critical')
    ? 'critical'
    : events.some((e) => e.level === 'warning')
      ? 'warning'
      : 'info';

  const summaryTitles = events.map((e) => e.title).join(' / ');
  return {
    title: `สรุปการแจ้งเตือน`,
    body: `AI วิเคราะห์: ${summaryTitles}`,
    level: highestSeverity,
    category: 'synthesized_bundle',
    channelId: highestSeverity === 'critical' ? 'smartfarm_critical' : 'smartfarm_general',
    sound: undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ระบบผูกเสียงแจ้งเตือนของเครื่องโทรศัพท์ (System Default Notification Sound)
// ─────────────────────────────────────────────────────────────────────────────
export const NOTIFICATION_CHANNELS = {
  CRITICAL: {
    id: 'smartfarm_critical',
    name: 'แจ้งเตือนวิกฤตความปลอดภัย (Critical)',
    description: 'แจ้งเตือนเมื่ออุปกรณ์ดับ หรือน้ำรั่วซึมรวดเร็ว (ส่งเสียงและสั่นเตือนทันที)',
    importance: 5, // High / Max
    visibility: 1, // Public on lockscreen
    sound: undefined, // ไม่ระบุไฟล์ เพื่อให้ Android ดึงเสียงมาตรฐานของโทรศัพท์เครื่องนั้นๆ (Settings.System.DEFAULT_NOTIFICATION_URI)
    vibration: true,
    lights: true,
    lightColor: '#dc2626',
  },
  GENERAL: {
    id: 'smartfarm_general',
    name: 'แจ้งเตือนทั่วไปและการดูแลพืช (General)',
    description: 'แจ้งเตือนเมื่อค่าปุ๋ยเบี่ยงเบน หรือสรุปสถานะแปลงปลูก',
    importance: 3, // Default
    visibility: 0,
    sound: undefined, // ให้ Android ดึงเสียงมาตรฐานของโทรศัพท์เครื่องนั้นๆ
    vibration: true,
  },
} as const;

/**
 * ติดตั้ง Channels บน LocalNotifications โดยผูกกับ System Default Sound
 */
export async function setupNativeNotificationChannels(localNotificationsPlugin: any): Promise<void> {
  if (!localNotificationsPlugin || typeof localNotificationsPlugin.createChannel !== 'function') {
    return;
  }

  try {
    await localNotificationsPlugin.createChannel(NOTIFICATION_CHANNELS.CRITICAL);
    await localNotificationsPlugin.createChannel(NOTIFICATION_CHANNELS.GENERAL);
  } catch (err) {
    console.warn('setupNativeNotificationChannels error:', err);
  }
}
