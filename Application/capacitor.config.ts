import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hydroponic.ecosystem',
  appName: 'Hydroponic',
  webDir: 'dist',

  // ─── Server ──────────────────────────────────────────────
  server: {
    androidScheme: 'https',
    // Uncomment for hot-reload during development:
    // url: 'http://YOUR_LOCAL_IP:5173',
    // cleartext: true,
  },

  // ─── Plugins ─────────────────────────────────────────────
  plugins: {
    Camera: {
      // Permissions handled automatically by plugin
    },
    Preferences: {
      group: 'HydroponicPrefs',
    },
  },

  // ─── Android ─────────────────────────────────────────────
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false, // set true during development
  },

  // ─── iOS ─────────────────────────────────────────────────
  ios: {
    contentInset: 'automatic',
    scrollEnabled: true,
    preferredContentMode: 'mobile',
    limitsNavigationsToAppBoundDomains: true,
  },
};

export default config;
