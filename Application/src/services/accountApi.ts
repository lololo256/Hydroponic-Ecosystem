/**
 * Account SIGN-UP through our middle server (server/accounts.js). The server only creates the
 * ThingsBoard customer + user (with the password the user chose) and returns { success, email }.
 * It never logs anyone in: after sign-up the app logs in DIRECTLY to ThingsBoard with e-mail + password.
 * Google is used only at sign-up to prove the e-mail address belongs to the user.
 */
import { Capacitor } from '@capacitor/core';
import { GoogleSignIn } from '@capawesome/capacitor-google-sign-in';
import { GOOGLE_CONFIG } from './googleAuth';

// Render free tier sleeps after ~15 min idle; the first request can take up to ~60 s to wake it.
const ACCOUNT_TIMEOUT_MS = 90000;

export interface SignUpResult {
  success: true;
  email: string;
}

function getApiBase(): string {
  const v = import.meta.env.VITE_API_URL;
  if (typeof v === 'string' && v.trim()) return v.trim().replace(/\/+$/, '');
  return 'https://hydroponic-ecosystem.onrender.com';
}

const ERROR_TEXT: Record<string, string> = {
  INVALID_EMAIL: 'รูปแบบอีเมลไม่ถูกต้อง',
  WEAK_PASSWORD: 'รหัสผ่านต้องยาว 8-72 ตัวอักษร',
  EMAIL_EXISTS: 'อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน',
  GOOGLE_TOKEN_INVALID: 'Google ปฏิเสธการลงชื่อเข้าใช้ กรุณาลองใหม่',
  GOOGLE_TOKEN_EXPIRED: 'การลงชื่อเข้าใช้ Google หมดเวลา กรุณาลองใหม่',
  GOOGLE_AUDIENCE_MISMATCH: 'การตั้งค่า Google Client ของแอปไม่ตรงกับเซิร์ฟเวอร์ (GOOGLE_CLIENT_IDS)',
  GOOGLE_EMAIL_UNVERIFIED: 'อีเมลของบัญชี Google นี้ยังไม่ได้ยืนยัน',
  THINGSBOARD_ERROR: 'ระบบคลาวด์ไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง',
  ACTIVATION_FAILED: 'สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่',
  INVALID_INPUT: 'ข้อมูลไม่ครบ กรุณาลองใหม่',
  USER_LIMIT_REACHED: 'จำนวนผู้ใช้เต็มโควตาของ ThingsBoard แพ็กเกจฟรีแล้ว (สูงสุด 5 บัญชี) กรุณาติดต่อผู้ดูแลระบบ',
  SIGNUP_CUSTOMER_MISSING: 'ไม่พบกลุ่มลูกค้า "Hydroponic" ใน ThingsBoard (ตรวจ SIGNUP_CUSTOMER_TITLE บน Render)',
  ACTIVATION_LINK_INVALID: 'สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่',
};

async function postAccount(path: string, body: unknown): Promise<SignUpResult> {
  const data = await postAccountRaw(path, body);
  if (data?.success !== true || typeof data?.email !== 'string') throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง');
  return data as SignUpResult;
}

async function postAccountRaw(path: string, body: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACCOUNT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}/api/account${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new Error(
      err?.name === 'AbortError'
        ? 'เซิร์ฟเวอร์ตอบช้าเกินไป (อาจกำลังตื่นจากโหมดพัก) กรุณาลองใหม่อีกครั้ง'
        : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต'
    );
  } finally {
    clearTimeout(timer);
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    if (res.status === 429) throw new Error('ลองหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่');
    if (res.status === 404) {
      throw new Error('เซิร์ฟเวอร์สมัครสมาชิกยังเป็นเวอร์ชันเก่า (ยังไม่ได้ deploy ระบบสมัครสมาชิกขึ้น Render)');
    }
    const code = data?.error as string | undefined;
    if (code === 'THINGSBOARD_ERROR') {
      const stageText: Record<string, string> = {
        admin_login:
          data?.detail === 'TB_2FA_ENABLED'
            ? 'บัญชีผู้ดูแลของเซิร์ฟเวอร์เปิด 2FA อยู่ ต้องปิด 2FA ใน ThingsBoard'
            : 'เซิร์ฟเวอร์ล็อกอิน ThingsBoard ด้วยบัญชีผู้ดูแลไม่ได้ (ตรวจ THINGSBOARD_USERNAME / PASSWORD บน Render)',
        find_customer: 'ค้นหากลุ่มลูกค้า Hydroponic ใน ThingsBoard ไม่สำเร็จ',
        find_group: 'ค้นหากลุ่มสิทธิ์ผู้ใช้ใน ThingsBoard ไม่สำเร็จ',
        create_user: 'สร้างผู้ใช้ใน ThingsBoard ไม่สำเร็จ',
        activation_link: 'ขอลิงก์เปิดใช้งานบัญชีจาก ThingsBoard ไม่สำเร็จ',
        activate: 'เปิดใช้งานบัญชี (ตั้งรหัสผ่าน) ใน ThingsBoard ไม่สำเร็จ',
      };
      const stage = typeof data?.stage === 'string' ? data.stage : 'unknown';
      throw new Error(
        `${stageText[stage] || 'ระบบคลาวด์ไม่ตอบสนอง'} [${stage}${data?.tbStatus ? ` / HTTP ${data.tbStatus}` : ''}]`
      );
    }
    throw Object.assign(new Error((code && ERROR_TEXT[code]) || `สมัครสมาชิกไม่สำเร็จ (HTTP ${res.status})`), { code });
  }
  return data;
}

/** Native Google sign-in -> Google ID token (JWT) for the server to verify. */
export async function getGoogleIdToken(): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('การเชื่อมต่อด้วย Google ใช้ได้บนแอปมือถือ (Android/iOS) เท่านั้น บนเว็บกรุณาเข้าสู่ระบบหรือสมัครด้วยอีเมล');
  }
  try {
    await GoogleSignIn.initialize({ clientId: GOOGLE_CONFIG.webClientId, scopes: ['email', 'profile'] });
    const result = await GoogleSignIn.signIn();
    if (!result.idToken) throw new Error('ไม่ได้รับ ID token จาก Google');
    return result.idToken;
  } catch (err: any) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('cancel') || err?.code === 'SignInCanceled' || err?.code === 13) {
      throw new Error('การลงชื่อเข้าใช้ด้วย Google ถูกยกเลิก');
    }
    throw new Error(err?.message || 'การลงชื่อเข้าใช้ด้วย Google บนอุปกรณ์ล้มเหลว');
  }
}

export function signUpWithEmailViaServer(name: string, email: string, password: string): Promise<SignUpResult> {
  return postAccount('/signup', { firstName: name, email, password });
}

/** Google proves the e-mail; the account is created with the password the user chose. */
export function signUpWithGoogleViaServer(idToken: string, password: string, name?: string): Promise<SignUpResult> {
  return postAccount('/signup/google', { idToken, password, firstName: name || '' });
}
