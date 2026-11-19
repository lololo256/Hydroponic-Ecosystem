/**
 * Application Feature Flags
 */
export const FEATURES = {
  googleLogin: true,
  ai: false,
  /**
   * Show "demo / simulated board" labels in the UI (badge, pump tags, sensor-health note).
   * Off by the owner's request (2026-11-19). The board still sends `sim:true` and the data keeps
   * that flag, so turning this back on restores every label.
   */
  showDemoBoardLabels: false,
} as const;
