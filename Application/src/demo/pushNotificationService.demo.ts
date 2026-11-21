/**
 * DEMO APP ONLY (vite --mode demo): replaces src/services/pushNotificationService.ts.
 * The demo app has no ThingsBoard account, so there is no cloud push (in-app alerts still work).
 */
export const FCM_TOKEN_STORAGE = 'smartfarm_fcm_token';

export async function registerPushWithThingsBoard(): Promise<boolean> {
  return false;
}

export async function unregisterPushFromThingsBoard(): Promise<void> {}
