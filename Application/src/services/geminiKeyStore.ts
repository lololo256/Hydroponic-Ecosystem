import { Preferences } from '@capacitor/preferences';
import { USER_GEMINI_KEY_STORAGE, getPlantStorage, getUserGeminiKey } from './plantProfileService';

/**
 * The user's own Gemini API key (free key from Google AI Studio), kept on this phone only.
 * Mirrored to Capacitor Preferences because the Android WebView's localStorage does not reliably
 * survive the app being closed. Never sent anywhere except Google's Gemini API.
 */

/** Gemini keys from AI Studio: letters, digits, "_" "-" "." (no spaces), realistic length. */
export function looksLikeGeminiKey(key: string): boolean {
  return /^[A-Za-z0-9._-]{20,200}$/.test(key.trim());
}

export async function saveUserGeminiKey(key: string): Promise<void> {
  const k = key.trim();
  getPlantStorage().setItem(USER_GEMINI_KEY_STORAGE, k);
  await Preferences.set({ key: USER_GEMINI_KEY_STORAGE, value: k }).catch(() => {});
}

export async function clearUserGeminiKey(): Promise<void> {
  getPlantStorage().removeItem(USER_GEMINI_KEY_STORAGE);
  await Preferences.remove({ key: USER_GEMINI_KEY_STORAGE }).catch(() => {});
}

/** Call once at app start: copy the key back from Preferences if the WebView storage lost it. */
export async function restoreUserGeminiKey(): Promise<void> {
  try {
    const { value } = await Preferences.get({ key: USER_GEMINI_KEY_STORAGE });
    const stored = (value || '').trim();
    const local = getUserGeminiKey();
    if (stored && stored !== local) getPlantStorage().setItem(USER_GEMINI_KEY_STORAGE, stored);
    else if (!stored && local) await Preferences.set({ key: USER_GEMINI_KEY_STORAGE, value: local });
  } catch (_) {
    /* storage unavailable: the key simply has to be entered again */
  }
}
