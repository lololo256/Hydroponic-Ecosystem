/**
 * DEMO APP ONLY (vite --mode demo): replaces src/config/features.ts at build time.
 * The demo app always shows the "simulated / demo board" labels so nobody mistakes
 * the test board.s simulated values for real sensor readings.
 */
export const FEATURES = {
  googleLogin: false,
  ai: false,
  showDemoBoardLabels: true,
} as const;
