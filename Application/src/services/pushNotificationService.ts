/**
 * Push notifications OUTSIDE the app (app closed / in background).
 *
 * ThingsBoard does the alert checks server-side (rule chain "Farm Alerts": pH / EC / temperature out of
 * the owner's range, tank empty, sensor fault, device offline) and sends a push through Firebase Cloud
 * Messaging only to the device owner. The app's job is just to register this phone with ThingsBoard:
 *   POST   /api/user/mobile/session  (header X-Mobile-Token: <FCM token>)  after login
 *   DELETE /api/user/mobile/session                                       on logout / notifications off
 * so a shared phone never keeps receiving the previous account's alerts.
 */
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { thingsboard } from './thingsboard';

export const FCM_TOKEN_STORAGE = 'smartfarm_fcm_token';
const TOKEN_WAIT_MS = 10000;

let listenersReady = false;
let tokenWaiters: Array<(token: string | null) => void> = [];

function pushAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PushNotifications');
  } catch {
    return false;
  }
}

async function ensureListeners(): Promise<void> {
  if (listenersReady) return;
  listenersReady = true;
  await PushNotifications.addListener('registration', (t) => {
    try {
      localStorage.setItem(FCM_TOKEN_STORAGE, t.value);
    } catch {}
    tokenWaiters.splice(0).forEach((w) => w(t.value));
  });
  await PushNotifications.addListener('registrationError', (err) => {
    console.warn('[Push] FCM registration error:', err);
    tokenWaiters.splice(0).forEach((w) => w(null));
  });
}

/** Asks Firebase for this phone's FCM token (null when Firebase is unavailable / times out). */
async function requestFcmToken(): Promise<string | null> {
  await ensureListeners();
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), TOKEN_WAIT_MS);
    tokenWaiters.push((token) => {
      clearTimeout(timer);
      resolve(token);
    });
    PushNotifications.register().catch((e) => {
      console.warn('[Push] register() failed:', e);
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Registers this phone for ThingsBoard push notifications of the signed-in account.
 * Returns true only when ThingsBoard accepted the FCM token.
 */
export async function registerPushWithThingsBoard(): Promise<boolean> {
  if (!pushAvailable()) return false;
  try {
    if (Capacitor.getPlatform() === 'android') {
      try {
        await PushNotifications.createChannel({
          id: 'smartfarm_alerts',
          name: 'แจ้งเตือนฟาร์ม',
          description: 'ค่าน้ำผิดปกติ ถังน้ำว่าง เซนเซอร์ผิดปกติ และอุปกรณ์ออฟไลน์',
          importance: 5,
          visibility: 1,
          vibration: true,
        });
      } catch (e) {
        console.warn('[Push] channel notice:', e);
      }
    }
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== 'granted') return false;

    const token = await requestFcmToken();
    if (!token) return false;
    await thingsboard.saveMobileSession(token);
    return true;
  } catch (e) {
    console.warn('[Push] ThingsBoard registration notice:', e);
    return false;
  }
}

/** Stops ThingsBoard push to this phone for the current account (call BEFORE clearing tokens). */
export async function unregisterPushFromThingsBoard(): Promise<void> {
  if (!pushAvailable()) return;
  let token: string | null = null;
  try {
    token = localStorage.getItem(FCM_TOKEN_STORAGE);
  } catch {}
  if (!token) return;
  try {
    await thingsboard.removeMobileSession(token);
  } catch (e) {
    console.warn('[Push] ThingsBoard unregister notice:', e);
  }
}
