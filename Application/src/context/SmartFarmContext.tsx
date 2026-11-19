import React, { createContext, useContext, useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { LocalNotifications } from '@capacitor/local-notifications';
import {
  thingsboard,
  TBUser,
  TBAlarm,
  waitForBoardBound as tbWaitForBoardBound,
  describeRpcError,
} from '../services/thingsboard';
import { Capacitor } from '@capacitor/core';
import { getGoogleIdToken, signUpWithEmailViaServer, signUpWithGoogleViaServer } from '../services/accountApi';
import { evaluateAlertConditions, trackAlerts, type AlertState } from '../services/alertRules';
import { analyzeSensorHealth, type Sample } from '../services/sensorHealth';
import { shouldSuppressNotification, synthesizeAlertBatch } from '../services/smartNotificationSynthesizer';
import {
  SOLUTION_ATTRIBUTE_KEY,
  SOLUTION_TANK_KEYS,
  TANK_RUNTIME_KEY,
  applyFlowCalibration,
  applyRefill,
  computeTankLevel,
  parseSolutionTanks,
  type SolutionTanks,
  type TankLevel,
} from '../services/solutionTracker';
import { FEATURES } from '../config/features';
import { registerPushWithThingsBoard, unregisterPushFromThingsBoard } from '../services/pushNotificationService';
import ModernConfirmModal, { ModalState, ModalVariant } from '../components/ModernConfirmModal';
import { calculatePlantDays } from '../services/briefingEngine';
import {
  TELEMETRY_KEYS,
  PUMP_RPC_NAME,
  boolOrNull,
  clampPumpSeconds,
  computeFreshness,
  extractLatest,
  finiteOrNull,
  isChemicalPump,
  modeOrNull,
  parseAutoCycle,
  parseSnakeTargets,
  toSharedTargetAttributes,
  getEffectiveTargets,
  FIRMWARE_DEFAULT_TARGETS,
  type AutoCycle,
  type PumpKey as ContractPumpKey,
  type TargetsSource,
  type TelemetryFreshness as ContractFreshness,
} from '../services/telemetryContract';

export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL?: string | null;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ModalVariant;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}

export interface AlertOptions {
  title: string;
  message: string;
  buttonText?: string;
  variant?: ModalVariant;
  onClose?: () => void;
}

export type { SolutionTankKey, TankLevel } from '../services/solutionTracker';
import type { SolutionTankKey } from '../services/solutionTracker';
export type PumpKey = ContractPumpKey;

export interface HistoryPoint {
  pH: number | null;
  ec: number | null;
  tds: number | null;
  tempC: number | null;
  timestamp: number;
  level?: number | null;
}

export interface SmartWaterFarmData {
  profile: {
    name: string;
    email: string;
    photoURL?: string | null;
    role: string;
    createdAt?: number;
    lastLogin?: number;
  };
  device: {
    esp32Connected: boolean;
    wifiConnected: boolean;
    /** `sensor_ok` telemetry: true when ph, ec, temp are all valid. null = not reported. */
    sensorOk?: boolean | null;
    /** `sim` telemetry: true only for the CYD demo board compiled with DEMO_SIM. */
    isSim?: boolean;
  };
  /** Reported relay / mode state. null = the board never reported it. */
  pumps: {
    controlMode: 'AUTO' | 'MANUAL' | null;
    mainPumpOn: boolean | null;
    fertPumpAOn: boolean | null;
    fertPumpBOn: boolean | null;
    phDownPumpOn: boolean | null;
    phUpPumpOn: boolean | null;
  };
  /** Sensor readings. null = no valid reading from the board (UI shows `--`). */
  current: {
    pH: number | null;
    ec: number | null;
    tds: number | null;
    tempC: number | null;
    /** Board timestamp (ms) of the newest telemetry; 0 = never received. */
    updatedAt: number;
  };
  /**
   * Tank levels. The board has no level sensors for A/B/pH tanks and no
   * percentage for the main tank (Contract v3), so all percents are null.
   * `mainTankOk` comes from the `tank_main_ok` float switch.
   */
  levels: {
    mainTankPercent: number | null;
    fertAPercent: number | null;
    fertBPercent: number | null;
    phDownPercent: number | null;
    phUpPercent: number | null;
    mainTankOk: boolean | null;
  };
  /** Where the target ranges come from: board-confirmed, app-requested (pending) or firmware defaults. */
  targetsSource?: TargetsSource;
  /** Solution tank records (refills + measured pump flow), stored in ThingsBoard `solution_tanks`. */
  solutionTanks?: SolutionTanks;
  /** Board's cumulative pump run-time counters (seconds) per solution tank pump; null = not reported. */
  pumpRuntimeS?: Record<SolutionTankKey, number | null>;
  /** AUTO dosing cycle reported by the board (null = not reported / older firmware). */
  autoCycle?: AutoCycle | null;
  alerts: Record<
    string,
    {
      level: 'info' | 'warning' | 'critical';
      title: string;
      message: string;
      timestamp: number;
      read: boolean;
    }
  >;
  history: Record<string, HistoryPoint>;
  aiMemory?: Record<string, FarmDiaryEntry>;
  plantType?: string;
  targetPHMin?: number;
  targetPHMax?: number;
  targetECMin?: number;
  targetECMax?: number;
  targetTempMin?: number;
  targetTempMax?: number;
  plantingStartDate?: number;
  expectedHarvestDays?: number;
  targets?: any;
}

export interface FarmDiaryEntry {
  id?: string;
  day: number;
  date: string;
  time: string;
  type:
    | 'CROP_START'
    | 'DOSING_FERT'
    | 'DOSING_PH'
    | 'HEAT_ALERT'
    | 'DIURNAL_SHIFT'
    | 'WATER_REFILL'
    | 'MANUAL_NOTE';
  text: string;
  timestamp: number;
}

export interface SavedBoard {
  boardId?: string;
  name: string;
  addedAt: number;
  plantType?: string;
}

const MAX_LOCAL_HISTORY_POINTS = 2000;

const sanitizeHistoryPoint = (p: any): HistoryPoint | null => {
  if (!p || typeof p !== 'object') return null;
  const ts = finiteOrNull(p.timestamp);
  if (ts === null || ts <= 0) return null;
  const point: HistoryPoint = {
    pH: finiteOrNull(p.pH),
    ec: finiteOrNull(p.ec),
    tds: finiteOrNull(p.tds),
    tempC: finiteOrNull(p.tempC),
    timestamp: ts,
  };
  if (point.pH === null && point.ec === null && point.tds === null && point.tempC === null) return null;
  return point;
};

export const loadLocalHistory = (boardId?: string | null): Record<string, HistoryPoint> => {
  if (!boardId) return {};
  const key = `smartfarm_history_${boardId}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const out: Record<string, HistoryPoint> = {};
        Object.keys(parsed).forEach((k) => {
          const p = sanitizeHistoryPoint(parsed[k]);
          if (p) out[k] = p;
        });
        return out;
      }
    }
  } catch (_) {}
  return {};
};

export const saveLocalHistory = (boardId: string, history: Record<string, HistoryPoint>): void => {
  if (!boardId) return;
  try {
    localStorage.setItem(`smartfarm_history_${boardId}`, JSON.stringify(history));
  } catch (_) {}
};

export const loadLocalMemory = (boardId?: string | null): Record<string, FarmDiaryEntry> => {
  if (!boardId) return {};
  const key = `smartfarm_aimemory_${boardId}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return {};
};

export const saveLocalMemory = (boardId: string, memory: Record<string, FarmDiaryEntry>): void => {
  if (!boardId) return;
  try {
    localStorage.setItem(`smartfarm_aimemory_${boardId}`, JSON.stringify(memory));
  } catch (_) {}
};

export const loadLocalFarmSnapshot = (boardId?: string | null): Partial<SmartWaterFarmData> | null => {
  if (!boardId) return null;
  const key = `smartfarm_snapshot_${boardId}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return null;
};

export const saveLocalFarmSnapshot = (boardId: string, data: Partial<SmartWaterFarmData>): void => {
  if (!boardId) return;
  const key = `smartfarm_snapshot_${boardId}`;
  try {
    const snapshot = {
      current: data.current,
      targets: data.targets,
      levels: data.levels,
      plantType: data.plantType,
      plantingStartDate: data.plantingStartDate,
      expectedHarvestDays: data.expectedHarvestDays,
      device: data.device,
      snapshotTimestamp: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(snapshot));
  } catch (_) {}
};

/**
 * Initial (empty) state. Every reading is null until real telemetry arrives.
 * (Name kept for backwards compatibility with existing imports; contains NO mock values.)
 */
export const initialMockData: SmartWaterFarmData = {
  profile: {
    name: '',
    email: '',
    role: 'Customer User',
    createdAt: Date.now(),
  },
  device: { esp32Connected: false, wifiConnected: false, sensorOk: null, isSim: false },
  pumps: {
    controlMode: null,
    mainPumpOn: null,
    fertPumpAOn: null,
    fertPumpBOn: null,
    phDownPumpOn: null,
    phUpPumpOn: null,
  },
  current: { pH: null, ec: null, tds: null, tempC: null, updatedAt: 0 },
  levels: {
    mainTankPercent: null,
    fertAPercent: null,
    fertBPercent: null,
    phDownPercent: null,
    phUpPercent: null,
    mainTankOk: null,
  },
  targetsSource: 'default',
  solutionTanks: undefined,
  pumpRuntimeS: undefined,
  alerts: {},
  history: {},
  aiMemory: {},
};

export type TelemetryFreshness = ContractFreshness;

const SEVERITY_TO_LEVEL: Record<TBAlarm['severity'], 'info' | 'warning' | 'critical'> = {
  CRITICAL: 'critical',
  MAJOR: 'critical',
  MINOR: 'warning',
  WARNING: 'warning',
  INDETERMINATE: 'info',
};

/** Map ThingsBoard alarms into the context `alerts` shape (read = acknowledged or locally read). */
const mapAlarmsToAlerts = (
  alarms: TBAlarm[],
  prevAlerts: SmartWaterFarmData['alerts'],
  dismissed: Set<string>,
  readIds: Set<string> = new Set()
): SmartWaterFarmData['alerts'] => {
  const out: SmartWaterFarmData['alerts'] = {};
  alarms.forEach((a) => {
    const id = a?.id?.id;
    if (!id || dismissed.has(id)) return;
    const details = a.details && typeof a.details === 'object' ? a.details : {};
    const detailMsg = typeof details.message === 'string' ? details.message : typeof details.data === 'string' ? details.data : '';
    const statusText = a.cleared ? 'คลี่คลายแล้ว' : 'ยังเกิดอยู่';
    out[id] = {
      level: SEVERITY_TO_LEVEL[a.severity] || 'info',
      title: a.name || a.type || 'การแจ้งเตือนจากอุปกรณ์',
      message: detailMsg || `${a.type || 'Alarm'} (${statusText})`,
      timestamp: a.createdTime || Date.now(),
      read: Boolean(a.acknowledged) || Boolean(prevAlerts[id]?.read) || readIds.has(id),
    };
  });
  return out;
};

export interface SmartFarmContextType {
  data: SmartWaterFarmData;
  loading: boolean;
  isCloudConnected: boolean;
  userId: string;
  connectedBoardId: string | null;
  isBoardConnected: boolean;
  currentUser: User | null;
  isAuthenticated: boolean;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  savedBoards: Record<string, SavedBoard>;
  connectBoard: (boardId: string, name?: string) => Promise<void>;
  disconnectBoard: () => Promise<void>;
  removeBoard: (boardId: string) => Promise<void>;
  claimBoardDevice: (deviceId: string, claimCode: string) => Promise<{ success: boolean; message: string; deviceId?: string }>;
  loginWithEmail: (email: string, pass: string) => Promise<{ success: boolean; hasBoard?: boolean; error?: string }>;
  signUpWithGoogle: (pass: string, name?: string) => Promise<{ success: boolean; hasBoard?: boolean; error?: string }>;
  signUpWithEmail: (name: string, email: string, pass: string) => Promise<{ success: boolean; hasBoard?: boolean; error?: string }>;
  logout: () => Promise<void>;
  /** Poll client attribute `bound===true` (every 2 s) for the BLE pairing screens. */
  waitForBoardBound: (deviceId: string, timeoutMs?: number) => Promise<boolean>;
  /**
   * Send `setPump`. When the pump is reported ON it sends `seconds: 0` (stop now).
   * Rejects (after showing an alert) when not live, chemical pump in AUTO, or the board answered an error.
   */
  togglePump: (pumpKey: PumpKey, seconds?: number) => Promise<void>;
  /** Keys are present only while a command is in flight (check truthiness). */
  pendingPumps: Partial<Record<PumpKey, boolean>>;
  /** Mode currently being sent to the board, or null. */
  pendingMode: 'AUTO' | 'MANUAL' | null;
  /** Board-confirmed end time (ms) of each pump run started from the app (for the countdown). */
  pumpRunEnds: Partial<Record<PumpKey, number>>;
  commandError: string | null;
  clearCommandError: () => void;
  /** live or stale */
  isDeviceOnline: boolean;
  /** anything other than live */
  isDeviceStale: boolean;
  /** true only when telemetry is live (Contract v3 §6: controls enabled only when live). */
  canControl: boolean;
  /** `sim===true` from the board: CYD demo board with simulated sensors. */
  isDemoBoard: boolean;
  telemetryFreshness: TelemetryFreshness;
  refillTank: (tankKey: SolutionTankKey, amountMl: number, newCapacityMl?: number) => Promise<void>;
  /** Calculated solution tank levels (Soft Sensor) — `null` values mean unknown, never guessed. */
  solutionLevels: Record<SolutionTankKey, TankLevel>;
  calibratePumpFlow: (tankKey: SolutionTankKey, measuredMl: number, seconds: number) => Promise<void>;
  /** Phone notifications for farm alerts (in-app list always works). Returns false if permission was refused. */
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => Promise<boolean>;
  /** Unread alerts for the selected device (badge on the bell). */
  unreadAlertCount: number;
  setControlMode: (mode: 'AUTO' | 'MANUAL') => Promise<void>;
  updatePlantType: (
    type: string,
    targets?: { targetPHMin: number; targetPHMax: number; targetECMin: number; targetECMax: number },
    plantingStartDate?: number,
    expectedHarvestDays?: number
  ) => Promise<void>;
  updateTargets: (targets: {
    phMin?: number;
    phMax?: number;
    ecMin?: number;
    ecMax?: number;
    tempMin?: number;
    tempMax?: number;
    levelLow?: number;
    fertLow?: number;
  }) => Promise<void>;
  rebootDevice: () => Promise<DeviceActionResult>;
  /** Demo board only (sim:true): set simulated water values to exercise AUTO dosing (RPC simSet). */
  setDemoSimValues: (values: { ph?: number; ec?: number; temp?: number }) => Promise<DeviceActionResult>;
  resetDeviceWifi: () => Promise<DeviceActionResult>;
  factoryResetDevice: () => Promise<DeviceActionResult>;
  endCropSeason: () => Promise<void>;
  markAlertRead: (alertId: string) => Promise<void>;
  clearAlerts: () => Promise<void>;
  showConfirm: (options: ConfirmOptions) => void;
  showAlert: (options: AlertOptions) => void;
  enableDosingTracking: boolean;
  setEnableDosingTracking: (enabled: boolean) => void;
  recordFarmDiaryEntry: (text: string, type?: FarmDiaryEntry['type']) => Promise<void>;
  askGeminiAdvisor: (question: string) => Promise<{ answer?: string; error?: string }>;
}

export interface DeviceActionResult {
  success: boolean;
  message: string;
  /** resetWifi only: same details as the device's QR ({d, c, m}) so Wi-Fi setup needs no QR scan. */
  provision?: { d: string; c: string; m: string | null };
}

const SmartFarmContext = createContext<SmartFarmContextType | null>(null);

const LIVE_REQUIRED_MESSAGE =
  'อุปกรณ์ไม่ได้ส่งข้อมูลสดในขณะนี้ (ออฟไลน์หรือข้อมูลค้าง) ระบบล็อกการสั่งงานปั๊มและโหมดเพื่อความปลอดภัย';

/** Build an empty per-board state (keeps profile). Used when switching boards. */
/** "First Last" from the ThingsBoard user (what the sign-up form saved); falls back to the e-mail.
 *  Note: ThingsBoard's `name` field is the e-mail, so it is not used as the display name. */
const userDisplayName = (user: { firstName?: string | null; lastName?: string | null; email?: string | null }): string =>
  [user.firstName, user.lastName].map((x) => (x || '').trim()).filter(Boolean).join(' ') || (user.email || '').trim();

/** Per-board notification memory: app alerts, read ids and dismissed ThingsBoard alarm ids survive restarts. */
interface AlertMemory {
  local: SmartWaterFarmData['alerts'];
  readIds: string[];
  dismissedIds: string[];
}
const loadAlertMemory = (boardId: string | null): AlertMemory => {
  const empty: AlertMemory = { local: {}, readIds: [], dismissedIds: [] };
  if (!boardId) return empty;
  try {
    const raw = JSON.parse(localStorage.getItem(`smartfarm_alertmem_${boardId}`) || 'null');
    if (!raw || typeof raw !== 'object') return empty;
    return {
      local: raw.local && typeof raw.local === 'object' ? raw.local : {},
      readIds: Array.isArray(raw.readIds) ? raw.readIds.slice(-200) : [],
      dismissedIds: Array.isArray(raw.dismissedIds) ? raw.dismissedIds.slice(-200) : [],
    };
  } catch {
    return empty;
  }
};
const saveAlertMemory = (boardId: string | null, alerts: SmartWaterFarmData['alerts'], dismissed: Set<string>) => {
  if (!boardId) return;
  try {
    const local = Object.fromEntries(Object.entries(alerts).filter(([id]) => id.startsWith('local:')));
    const readIds = Object.entries(alerts).filter(([, a]) => a.read).map(([id]) => id);
    localStorage.setItem(
      `smartfarm_alertmem_${boardId}`,
      JSON.stringify({ local, readIds: readIds.slice(-200), dismissedIds: Array.from(dismissed).slice(-200) })
    );
  } catch {}
};

const emptyBoardState = (prev: SmartWaterFarmData, boardId: string | null): SmartWaterFarmData => ({
  ...initialMockData,
  alerts: loadAlertMemory(boardId).local,
  profile: prev.profile,
  history: boardId ? loadLocalHistory(boardId) : {},
  aiMemory: boardId ? loadLocalMemory(boardId) : {},
});

export const SmartFarmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [data, setData] = useState<SmartWaterFarmData>(() => {
    const initial = { ...initialMockData };
    const savedBoard = typeof localStorage !== 'undefined' ? localStorage.getItem('connected_board_id') : null;
    if (savedBoard) {
      initial.history = loadLocalHistory(savedBoard);
      initial.aiMemory = loadLocalMemory(savedBoard);
      const snapshot = loadLocalFarmSnapshot(savedBoard);
      if (snapshot) {
        // Restore the last REAL reading with its board timestamp (freshness is derived from it,
        // so an old snapshot shows as offline). Levels are not restored: older app versions
        // stored percentages the board never measured.
        const c: any = snapshot.current || {};
        initial.current = {
          pH: finiteOrNull(c.pH),
          ec: finiteOrNull(c.ec),
          tds: finiteOrNull(c.tds),
          tempC: finiteOrNull(c.tempC),
          updatedAt: finiteOrNull(c.updatedAt) ?? 0,
        };
        if (snapshot.plantType) initial.plantType = snapshot.plantType;
        if (snapshot.plantingStartDate) initial.plantingStartDate = snapshot.plantingStartDate;
        if (snapshot.expectedHarvestDays) initial.expectedHarvestDays = snapshot.expectedHarvestDays;
      }
    }
    return initial;
  });

  const [loading, setLoading] = useState(true);
  const [isCloudConnected, setIsCloudConnected] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('smartfarm_current_user') : null;
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [connectedBoardId, setConnectedBoardId] = useState<string | null>(() => {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('connected_board_id') : null;
  });
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => {
    return (typeof localStorage !== 'undefined' && (localStorage.getItem('smartfarm_theme') as 'light' | 'dark')) || 'light';
  });

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('smartfarm_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    const t = theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('smartfarm_theme', t);
    setThemeState(t);
  };

  const setTheme = (t: 'light' | 'dark') => {
    localStorage.setItem('smartfarm_theme', t);
    setThemeState(t);
  };

  const [savedBoards, setSavedBoards] = useState<Record<string, SavedBoard>>(() => {
    try {
      const raw = localStorage.getItem('smartfarm_saved_boards');
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return {};
  });

  const [pendingPumps, setPendingPumps] = useState<Partial<Record<PumpKey, boolean>>>({});
  const pendingPumpsRef = useRef<Partial<Record<PumpKey, boolean>>>({});
  const [pendingMode, setPendingMode] = useState<'AUTO' | 'MANUAL' | null>(null);
  // A command the device CONFIRMED (RPC success) stays shown until telemetry reports the same value
  // or `until` passes. Without this, the read-back right after the command returns the previous
  // telemetry sample and the switch jumps back (e.g. MANUAL -> AUTO).
  const confirmedRef = useRef<{
    mode?: { value: 'AUTO' | 'MANUAL'; until: number };
    pumps: Partial<Record<PumpKey, { value: boolean; until: number }>>;
  }>({ pumps: {} });
  // When each pump started by the app is due to stop (board-confirmed run time) -> countdown in the UI.
  const [pumpRunEnds, setPumpRunEnds] = useState<Partial<Record<PumpKey, number>>>({});
  const [commandError, setCommandError] = useState<string | null>(null);
  const [enableDosingTracking, setEnableDosingTrackingState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('smartfarm_dosing_tracking') !== 'false';
    } catch {
      return true;
    }
  });
  const setEnableDosingTracking = (v: boolean) => {
    setEnableDosingTrackingState(v);
    try {
      localStorage.setItem('smartfarm_dosing_tracking', v ? 'true' : 'false');
    } catch {}
  };

  // Board whose responses are currently accepted (guards against late responses after switching).
  const activeBoardRef = useRef<string | null>(connectedBoardId);
  // Board id for which at least one telemetry fetch has completed (success or failure).
  const [fetchedBoardId, setFetchedBoardId] = useState<string | null>(null);
  // Alarm ids the user cleared locally (so the next poll does not re-add them).
  const dismissedAlarmIdsRef = useRef<Set<string>>(new Set());

  // Ticking clock so freshness decays even when fetches fail or the app stops receiving data.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // ---- Derived state (declared BEFORE any effect that uses it: BUG-004 TDZ guard) ----
  const telemetryFreshness: TelemetryFreshness = useMemo(() => {
    if (!connectedBoardId) return 'no_data';
    const f = computeFreshness(data.current.updatedAt, nowTick);
    if (f === 'no_data' && fetchedBoardId !== connectedBoardId) return 'loading';
    return f;
  }, [connectedBoardId, data.current.updatedAt, nowTick, fetchedBoardId]);
  const isDeviceOnline = telemetryFreshness === 'live' || telemetryFreshness === 'stale';
  const isDeviceStale = telemetryFreshness !== 'live';
  const canControl = Boolean(connectedBoardId) && telemetryFreshness === 'live';
  const isDemoBoard = Boolean(data.device.isSim);

  // Modern Modal State
  const [modalState, setModalState] = useState<ModalState>({
    isOpen: false,
    title: '',
    message: '',
    variant: 'info',
  });

  const showConfirm = useCallback((opts: ConfirmOptions) => {
    setModalState({
      isOpen: true,
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText || 'ยืนยัน',
      cancelText: opts.cancelText || 'ยกเลิก',
      variant: opts.variant || 'success',
      isAlert: false,
      onConfirm: opts.onConfirm,
      onCancel: opts.onCancel,
    });
  }, []);

  const showAlert = useCallback((opts: AlertOptions) => {
    setModalState({
      isOpen: true,
      title: opts.title,
      message: opts.message,
      confirmText: opts.buttonText || 'รับทราบ',
      variant: opts.variant || 'info',
      isAlert: true,
      onConfirm: opts.onClose,
    });
  }, []);

  const clearCommandError = () => setCommandError(null);

  // Update savedBoards in localStorage
  const updateSavedBoards = (updater: (prev: Record<string, SavedBoard>) => Record<string, SavedBoard>) => {
    setSavedBoards((prev) => {
      const next = updater(prev);
      try {
        localStorage.setItem('smartfarm_saved_boards', JSON.stringify(next));
      } catch (_) {}
      return next;
    });
  };

  // Sync boards from ThingsBoard Cloud
  // Make the local device list EXACTLY the devices this account may access in ThingsBoard
  // (per-user privacy: devices that are no longer ours disappear; no stale/foreign entries).
  const applyDeviceList = (devices: Array<{ id?: { id: string }; name?: string; createdTime?: number }>) => {
    const ids = devices.map((d) => d.id?.id).filter((x): x is string => Boolean(x));
    updateSavedBoards((prev) => {
      const next: Record<string, SavedBoard> = {};
      devices.forEach((d) => {
        const devId = d.id?.id;
        if (!devId) return;
        next[devId] = {
          boardId: devId,
          name: d.name || devId,
          addedAt: prev[devId]?.addedAt || d.createdTime || Date.now(),
          plantType: prev[devId]?.plantType || '',
        };
      });
      return next;
    });
    setConnectedBoardId((current) => {
      if (current && ids.includes(current)) return current;
      const nextId = ids[0] || null;
      activeBoardRef.current = nextId;
      setFetchedBoardId(null);
      setData((prev) => emptyBoardState(prev, nextId));
      try {
        if (nextId) localStorage.setItem('connected_board_id', nextId);
        else localStorage.removeItem('connected_board_id');
      } catch (_) {}
      return nextId;
    });
    return ids.length > 0;
  };

  const syncDevicesFromThingsBoard = useCallback(async () => {
    try {
      const result = await thingsboard.getCustomerDevices(100, 0);
      if (result && Array.isArray(result.data)) applyDeviceList(result.data);
    } catch (_) {
      // Network error: keep the last known list rather than wiping it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check auth session on startup (with native SharedPreferences & auto refresh)
  useEffect(() => {
    let isMounted = true;
    const checkAuth = async () => {
      try {
        // 1. If currentUser is not yet in state, check native Preferences for cached user
        if (!currentUser) {
          try {
            const prefUser = await Preferences.get({ key: 'smartfarm_current_user' });
            if (prefUser.value && isMounted) {
              const parsed = JSON.parse(prefUser.value);
              setCurrentUser(parsed);
              try { localStorage.setItem('smartfarm_current_user', prefUser.value); } catch {}
            }
          } catch (_) {}
        }

        // 2. Initialize and sync session (auto refresh expired access tokens)
        const hasSession = await thingsboard.initSession();
        if (!isMounted) return;

        if (hasSession) {
          try {
            const user = await thingsboard.getCurrentUser();
            if (isMounted) {
              const customUser: User = {
                uid: user.id.id,
                email: user.email,
                displayName: userDisplayName(user),
                photoURL: null,
              };
              setCurrentUser(customUser);
              try {
                localStorage.setItem('smartfarm_current_user', JSON.stringify(customUser));
                localStorage.setItem('has_seen_onboarding', 'true');
              } catch {}
              Preferences.set({ key: 'smartfarm_current_user', value: JSON.stringify(customUser) }).catch(() => {});
              Preferences.set({ key: 'has_seen_onboarding', value: 'true' }).catch(() => {});
              setIsCloudConnected(true);
              await syncDevicesFromThingsBoard();
            }
          } catch (userErr: any) {
            console.warn('[SmartFarm] getCurrentUser failed on startup:', userErr);
            // If offline, preserve cached user so user is not kicked out
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
              if (isMounted) setIsCloudConnected(false);
            } else if (userErr?.status === 401 || userErr?.code === 'UNAUTHORIZED') {
              // Real 401 after refresh attempt means refresh token is invalid
              if (isMounted) {
                setCurrentUser(null);
                setIsCloudConnected(false);
                try { localStorage.removeItem('smartfarm_current_user'); } catch {}
                Preferences.remove({ key: 'smartfarm_current_user' }).catch(() => {});
              }
            } else {
              // Transient error (e.g. server timeout): keep cached user
              if (isMounted) setIsCloudConnected(false);
            }
          }
        } else {
          // No valid session
          if (isMounted) {
            setCurrentUser(null);
            setIsCloudConnected(false);
            try { localStorage.removeItem('smartfarm_current_user'); } catch {}
            Preferences.remove({ key: 'smartfarm_current_user' }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('[SmartFarm] checkAuth error:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    checkAuth();
    return () => {
      isMounted = false;
    };
  }, [syncDevicesFromThingsBoard]);

  // Main 15-second Telemetry & Attribute Polling Loop
  const pollIntervalRef = useRef<any>(null);
  const autoDosingRef = useRef(false);
  const isAppActiveRef = useRef(true);

  // Keep the accepted-board guard in sync (declared before the polling effect so it runs first).
  useEffect(() => {
    activeBoardRef.current = connectedBoardId;
  }, [connectedBoardId]);

  // Freshness clock: re-evaluate every 5 s.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const fetchDeviceData = useCallback(async (targetDeviceId: string) => {
    if (!targetDeviceId || !isAppActiveRef.current) return;

    const FAILED = Symbol('failed');
    const [telemetry, attributes, alarms] = await Promise.all([
      thingsboard.getLatestTimeseries(targetDeviceId, [...TELEMETRY_KEYS]).catch(() => FAILED),
      thingsboard.getAttributes(targetDeviceId).catch(() => FAILED),
      thingsboard.getDeviceAlarms(targetDeviceId, 30, 0).catch(() => FAILED),
    ]);

    // Late response for a board the user already switched away from: drop it.
    if (activeBoardRef.current !== targetDeviceId) return;

    setFetchedBoardId(targetDeviceId);
    setNowTick(Date.now());

    if (telemetry === FAILED) {
      // Cloud unreachable: keep the last known data (freshness decays by itself), flag disconnected.
      setIsCloudConnected(false);
      return;
    }
    setIsCloudConnected(true);

    const { latestTs, values } = extractLatest(telemetry as any);
    autoDosingRef.current = parseAutoCycle(values, latestTs)?.phase === 'dosing';

    // Attributes (all scopes merged): shared targets + app attrs, client `targets_applied`.
    const attrMap: Record<string, any> = {};
    const attrTs: Record<string, number> = {};
    if (attributes !== FAILED && Array.isArray(attributes)) {
      attributes.forEach((attr) => {
        attrMap[attr.key] = attr.value;
        attrTs[attr.key] = attr.lastUpdateTs || 0;
      });
    }

    // Board-confirmed commands that telemetry has not caught up with yet.
    const nowMs = Date.now();
    const confirmed = confirmedRef.current;
    const reportedMode = modeOrNull(values.mode);
    if (confirmed.mode && (nowMs > confirmed.mode.until || reportedMode === confirmed.mode.value)) {
      confirmed.mode = undefined;
    }
    const pumpReported: Record<PumpKey, boolean | null> = {
      mainPumpOn: boolOrNull(values.pump_main),
      fertPumpAOn: boolOrNull(values.pump_a),
      fertPumpBOn: boolOrNull(values.pump_b),
      phDownPumpOn: boolOrNull(values.pump_ph_down),
      phUpPumpOn: boolOrNull(values.pump_ph_up),
    };
    (Object.keys(confirmed.pumps) as PumpKey[]).forEach((k) => {
      const c = confirmed.pumps[k];
      if (c && (nowMs > c.until || pumpReported[k] === c.value)) delete confirmed.pumps[k];
    });
    const pumpValue = (k: PumpKey, prevValue: boolean | null) =>
      confirmed.pumps[k] ? confirmed.pumps[k]!.value : pumpReported[k] ?? prevValue;
    setPumpRunEnds((prev) => {
      let changed = false;
      const next = { ...prev };
      (Object.keys(next) as PumpKey[]).forEach((k) => {
        const reportedOff = pumpReported[k] === false && !confirmed.pumps[k];
        if (reportedOff || nowMs > (next[k] || 0) + 5000) {
          delete next[k];
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    setData((prev) => {
      const pumps: SmartWaterFarmData['pumps'] = {
        // Absent key -> keep the previously reported value (never invent OFF / AUTO).
        controlMode: confirmed.mode ? confirmed.mode.value : reportedMode ?? prev.pumps.controlMode,
        mainPumpOn: pumpValue('mainPumpOn', prev.pumps.mainPumpOn),
        fertPumpAOn: pumpValue('fertPumpAOn', prev.pumps.fertPumpAOn),
        fertPumpBOn: pumpValue('fertPumpBOn', prev.pumps.fertPumpBOn),
        phDownPumpOn: pumpValue('phDownPumpOn', prev.pumps.phDownPumpOn),
        phUpPumpOn: pumpValue('phUpPumpOn', prev.pumps.phUpPumpOn),
      };

      const freshness = computeFreshness(latestTs);
      const reachable = freshness === 'live' || freshness === 'stale';

      const updated: SmartWaterFarmData = {
        ...prev,
        device: {
          esp32Connected: reachable,
          wifiConnected: reachable,
          sensorOk: boolOrNull(values.sensor_ok),
          isSim: boolOrNull(values.sim) === true,
        },
        pumps,
        current: {
          // Absent / invalid key -> null (UI shows `--`). Never 0, never a stand-in value.
          pH: finiteOrNull(values.ph),
          ec: finiteOrNull(values.ec),
          tds: finiteOrNull(values.tds),
          tempC: finiteOrNull(values.temp),
          updatedAt: latestTs,
        },
        levels: {
          mainTankPercent: null,
          fertAPercent: null,
          fertBPercent: null,
          phDownPercent: null,
          phUpPercent: null,
          mainTankOk: boolOrNull(values.tank_main_ok),
        },
        autoCycle: parseAutoCycle(values, latestTs),
        // Run-time counters only grow, so the last reported value stays valid while the board is offline.
        pumpRuntimeS: SOLUTION_TANK_KEYS.reduce((acc, k) => {
          acc[k] = finiteOrNull(values[TANK_RUNTIME_KEY[k]]) ?? prev.pumpRuntimeS?.[k] ?? null;
          return acc;
        }, {} as Record<SolutionTankKey, number | null>),
      };

      if (attributes !== FAILED) {
        updated.solutionTanks = parseSolutionTanks(attrMap[SOLUTION_ATTRIBUTE_KEY]);
        // Targets: board-confirmed `targets_applied` wins unless the app wrote newer shared values.
        const applied = parseSnakeTargets(attrMap.targets_applied);
        const requested = parseSnakeTargets(attrMap);
        const appliedTs = attrTs.targets_applied || 0;
        const requestedTs = Math.max(
          attrTs.ph_min || 0,
          attrTs.ph_max || 0,
          attrTs.ec_min || 0,
          attrTs.ec_max || 0,
          attrTs.temp_min || 0,
          attrTs.temp_max || 0
        );
        const hasApplied = Object.keys(applied).length > 0;
        const hasRequested = Object.keys(requested).length > 0;
        const requestedIsNewer = hasRequested && (!hasApplied || requestedTs > appliedTs);
        const t = requestedIsNewer
          ? { ...FIRMWARE_DEFAULT_TARGETS, ...applied, ...requested }
          : { ...FIRMWARE_DEFAULT_TARGETS, ...requested, ...applied };
        updated.targetsSource = requestedIsNewer ? 'requested' : hasApplied ? 'device' : 'default';
        updated.targetPHMin = t.phMin;
        updated.targetPHMax = t.phMax;
        updated.targetECMin = t.ecMin;
        updated.targetECMax = t.ecMax;
        updated.targetTempMin = t.tempMin;
        updated.targetTempMax = t.tempMax;
        updated.targets = {
          ...(prev.targets || {}),
          phMin: t.phMin,
          phMax: t.phMax,
          ecMin: t.ecMin,
          ecMax: t.ecMax,
          tempMin: t.tempMin,
          tempMax: t.tempMax,
        };
        updated.plantType = attrMap.plantType || prev.plantType;
        updated.plantingStartDate = finiteOrNull(attrMap.plantingStartDate) ?? prev.plantingStartDate;
        updated.expectedHarvestDays = finiteOrNull(attrMap.expectedHarvestDays) ?? prev.expectedHarvestDays;
      }

      if (alarms !== FAILED && alarms && Array.isArray((alarms as any).data)) {
        const localAlerts = Object.fromEntries(Object.entries(prev.alerts).filter(([id]) => id.startsWith('local:')));
        const mem = loadAlertMemory(targetDeviceId);
        updated.alerts = {
          ...localAlerts,
          ...mapAlarmsToAlerts((alarms as any).data, prev.alerts, dismissedAlarmIdsRef.current, new Set(mem.readIds)),
        };
      }

      saveLocalFarmSnapshot(targetDeviceId, updated);

      // Record a history point for each new board timestamp that carries at least one reading.
      const c = updated.current;
      const hasReading = c.pH !== null || c.ec !== null || c.tds !== null || c.tempC !== null;
      if (latestTs > 0 && hasReading) {
        const historyKey = String(latestTs);
        if (!prev.history[historyKey]) {
          let nextHistory: Record<string, HistoryPoint> = {
            ...prev.history,
            [historyKey]: { pH: c.pH, ec: c.ec, tds: c.tds, tempC: c.tempC, timestamp: latestTs },
          };
          const keys = Object.keys(nextHistory);
          if (keys.length > MAX_LOCAL_HISTORY_POINTS) {
            const keep = keys
              .sort((a, b) => Number(a) - Number(b))
              .slice(keys.length - MAX_LOCAL_HISTORY_POINTS);
            const trimmed: Record<string, HistoryPoint> = {};
            keep.forEach((k) => (trimmed[k] = nextHistory[k]));
            nextHistory = trimmed;
          }
          saveLocalHistory(targetDeviceId, nextHistory);
          updated.history = nextHistory;
        }
      }

      return updated;
    });
  }, []);

  // Polling setup and lifecycle handling
  useEffect(() => {
    if (!connectedBoardId || !currentUser) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    // Initial immediate poll
    fetchDeviceData(connectedBoardId);

    // 15-second interval; 3 s while the board reports an AUTO dosing step (doses last 2 s each)
    let lastPollAt = Date.now(); // the initial poll just ran
    pollIntervalRef.current = setInterval(() => {
      if (!isAppActiveRef.current) return;
      const dosing = autoDosingRef.current;
      if (Date.now() - lastPollAt < (dosing ? 3000 : 15000) - 200) return;
      lastPollAt = Date.now();
      fetchDeviceData(connectedBoardId);
    }, 1000);

    // Capacitor App State Listener to freeze polling on background.
    // App.addListener returns a Promise<PluginListenerHandle>: keep the resolved handle.
    let disposed = false;
    let appStateHandle: { remove: () => Promise<void> | void } | null = null;
    try {
      Promise.resolve(
        App.addListener('appStateChange', (state) => {
          isAppActiveRef.current = state.isActive;
          if (state.isActive) {
            fetchDeviceData(connectedBoardId);
          }
        })
      )
        .then((h) => {
          if (disposed) {
            try {
              h.remove();
            } catch (_) {}
          } else {
            appStateHandle = h;
          }
        })
        .catch(() => {});
    } catch (_) {}

    return () => {
      disposed = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (appStateHandle) {
        try {
          appStateHandle.remove();
        } catch (_) {}
        appStateHandle = null;
      }
    };
  }, [connectedBoardId, currentUser, fetchDeviceData]);

  // Connect board (switch active): reset per-board state so values never mix between boards.
  const connectBoard = async (boardId: string, name?: string) => {
    activeBoardRef.current = boardId;
    dismissedAlarmIdsRef.current = new Set(loadAlertMemory(boardId).dismissedIds);
    pendingPumpsRef.current = {};
    setPendingPumps({});
    setPendingMode(null);
    setFetchedBoardId(null);
    setData((prev) => emptyBoardState(prev, boardId));
    setConnectedBoardId(boardId);
    localStorage.setItem('connected_board_id', boardId);
    if (name) {
      updateSavedBoards((prev) => ({
        ...prev,
        [boardId]: {
          boardId,
          name,
          addedAt: prev[boardId]?.addedAt || Date.now(),
          plantType: prev[boardId]?.plantType || '',
        },
      }));
    }
    await fetchDeviceData(boardId);
  };

  // Disconnect active board
  const disconnectBoard = async () => {
    activeBoardRef.current = null;
    pendingPumpsRef.current = {};
    setPendingPumps({});
    setPendingMode(null);
    setData((prev) => emptyBoardState(prev, null));
    setConnectedBoardId(null);
    localStorage.removeItem('connected_board_id');
  };

  // Remove Board: the device forgets its owner + Wi-Fi (firmware `unbind`), the account lets go of it
  // (bind_owner "" + reclaim). Telemetry history and plant settings stay on ThingsBoard for the next owner.
  // `skipUnbindRpc`: the device already wiped itself (factory reset), so only the account side is cleaned.
  const removeBoard = async (boardId: string, opts?: { skipUnbindRpc?: boolean }) => {
    const boardName = savedBoards[boardId]?.name || boardId;

    // 1. Ask the board to unbind (non-fatal: it may be offline; bind_owner="" covers it on reconnect)
    if (!opts?.skipUnbindRpc) {
      try {
        await thingsboard.callDeviceRpc(boardId, 'unbind', {}, 6000);
      } catch (e: any) {
        console.warn('[SmartFarm] unbind RPC notice:', e?.message || e);
      }
    }

    // 2. Clear the primary bind attribute (Contract v3 §3)
    try {
      await thingsboard.saveSharedAttributes(boardId, { bind_owner: '' });
    } catch (e: any) {
      console.warn('[SmartFarm] clear bind_owner notice:', e?.message || e);
    }

    // 3. Reclaim (unassign from this customer). Telemetry history is intentionally kept.
    try {
      await thingsboard.reclaimDevice(boardName);
    } catch (e: any) {
      throw new Error(`ยกเลิกการผูกอุปกรณ์บนคลาวด์ไม่สำเร็จ: ${e?.message || 'ไม่ทราบสาเหตุ'}`);
    }

    // 4. Clean local cache for this board
    try {
      localStorage.removeItem(`smartfarm_history_${boardId}`);
      localStorage.removeItem(`smartfarm_snapshot_${boardId}`);
      localStorage.removeItem(`smartfarm_aimemory_${boardId}`);
    } catch (_) {}

    updateSavedBoards((prev) => {
      const next = { ...prev };
      delete next[boardId];
      return next;
    });

    if (connectedBoardId === boardId) {
      const remainingIds = Object.keys(savedBoards).filter((id) => id !== boardId);
      if (remainingIds.length > 0) {
        await connectBoard(remainingIds[0]);
      } else {
        await disconnectBoard();
      }
    }
  };

  // Claim Board Device (used by the BLE / QR pairing screens)
  const claimBoardDevice = async (
    deviceId: string,
    claimCode: string
  ): Promise<{ success: boolean; message: string; deviceId?: string }> => {
    const cleanName = (deviceId || '').trim();
    if (!cleanName) return { success: false, message: 'ไม่พบรหัสอุปกรณ์' };

    let resolvedId: string | null = null;
    let claimFailureNote = '';

    // 1. Claim via ThingsBoard (ClaimResult.response === 'SUCCESS' or carries `device`)
    try {
      const result = await thingsboard.claimDevice(cleanName, claimCode);
      if (result.success && result.device?.id?.id) {
        resolvedId = result.device.id.id;
      } else if (!result.success) {
        claimFailureNote = result.response || '';
      }
    } catch (claimErr: any) {
      // HTTP 400 is returned for FAILURE / CLAIMED; "already claimed by you" is resolved below.
      claimFailureNote = claimErr?.message || '';
      console.warn('[SmartFarm] claimDevice API notice:', claimFailureNote);
    }

    // Owner = the account's e-mail. The ThingsBoard Rule Chain moves the device into the
    // private device group "Devices <owner>" when bind_owner is written, so it must be the e-mail.
    let owner = (currentUser?.email || '').trim();
    if (!owner) {
      try {
        const u = await thingsboard.getCurrentUser();
        owner = (u.email || '').trim();
      } catch (_) {}
    }
    if (!owner) return { success: false, message: 'ไม่พบอีเมลของบัญชีนี้ กรุณาออกจากระบบแล้วเข้าใหม่' };

    const findMine = async () => {
      const devices = (await thingsboard.getCustomerDevices(100, 0)).data || [];
      return devices.find(
        (d) => d.name === cleanName || d.id?.id === cleanName || (resolvedId !== null && d.id?.id === resolvedId)
      );
    };

    // 2. Bind the owner. With per-user privacy the device only becomes visible to this account
    //    AFTER bind_owner is written (Rule Chain: device -> "Devices <owner>"), so write first, then wait.
    let foundDevice: { id?: { id: string }; name: string } | undefined;
    try {
      if (!resolvedId) {
        // Claim did not return the device: maybe it is already ours (re-pairing our own device).
        foundDevice = await findMine();
        if (foundDevice?.id?.id) resolvedId = foundDevice.id.id;
      }
      if (!resolvedId) {
        return {
          success: false,
          message: `ไม่สามารถผูกอุปกรณ์ได้ รหัสไม่ถูกต้อง หมดเวลาจับคู่ หรืออุปกรณ์ถูกผูกกับบัญชีอื่นแล้ว${
            claimFailureNote ? ` (${claimFailureNote})` : ''
          }`,
        };
      }
      await thingsboard.saveSharedAttributes(resolvedId, { bind_owner: owner, bind_ts: Date.now() });
    } catch (attrErr: any) {
      return {
        success: false,
        message: `จับคู่แล้ว แต่ส่งข้อมูลเจ้าของไปยังอุปกรณ์ไม่สำเร็จ กรุณาลองอีกครั้ง (${attrErr?.message || 'เครือข่ายขัดข้อง'})`,
        deviceId: resolvedId || undefined,
      };
    }

    // 3. Wait (max ~20 s) until the Rule Chain has moved the device into this user's group.
    const visibleDeadline = Date.now() + 20000;
    while (!foundDevice?.id?.id && Date.now() < visibleDeadline) {
      try {
        foundDevice = await findMine();
      } catch (_) {}
      if (!foundDevice?.id?.id) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!foundDevice?.id?.id) {
      return {
        success: false,
        message: 'จับคู่แล้ว แต่ระบบยังไม่ย้ายอุปกรณ์เข้าบัญชีของคุณ (ตรวจ Rule Chain "[Owner]" ใน ThingsBoard) กรุณาลองใหม่อีกครั้ง',
        deviceId: resolvedId,
      };
    }
    resolvedId = foundDevice.id.id;

    // 4. Fast path: RPC bind, up to 3 tries x 6 s (non-fatal, runs in background;
    //    the screens confirm with waitForBoardBound()).
    const bindTarget = resolvedId;
    void (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await thingsboard.callDeviceRpc(bindTarget, 'bind', { owner }, 6000);
          return;
        } catch (rpcErr: any) {
          console.warn(`[SmartFarm] bind RPC attempt ${attempt} notice:`, rpcErr?.message || rpcErr);
        }
      }
    })();

    await syncDevicesFromThingsBoard();
    await connectBoard(resolvedId, foundDevice.name || cleanName);
    return { success: true, message: 'ผูกอุปกรณ์สำเร็จ', deviceId: resolvedId };
  };

  const waitForBoardBound = useCallback(
    (deviceId: string, timeoutMs = 60000) => tbWaitForBoardBound(deviceId, timeoutMs, 2000),
    []
  );

  // Login With Email
  const loginWithEmail = async (
    email: string,
    pass: string
  ): Promise<{ success: boolean; hasBoard?: boolean; error?: string }> => {
    try {
      const { user } = await thingsboard.login(email, pass);
      const customUser: User = {
        uid: user.id.id,
        email: user.email,
        displayName: userDisplayName(user),
        photoURL: null,
      };
      setCurrentUser(customUser);
      try {
        localStorage.setItem('smartfarm_current_user', JSON.stringify(customUser));
        localStorage.setItem('has_seen_onboarding', 'true');
      } catch {}
      Preferences.set({ key: 'smartfarm_current_user', value: JSON.stringify(customUser) }).catch(() => {});
      Preferences.set({ key: 'has_seen_onboarding', value: 'true' }).catch(() => {});
      setIsCloudConnected(true);

      let hasBoard = false;
      try {
        const devResult = await thingsboard.getCustomerDevices(100, 0);
        hasBoard = applyDeviceList(devResult.data || []);
      } catch (devErr) {
        console.warn('[SmartFarm] device sync after login notice:', devErr);
      }

      return { success: true, hasBoard };
    } catch (err: any) {
      return { success: false, error: err.message || 'เข้าสู่ระบบไม่สำเร็จ' };
    }
  };


  // Sign Up: the middle server only CREATES the ThingsBoard account (with the chosen password).
  // Login then goes directly to ThingsBoard with that e-mail + password (same as the login screen).
  const signUpWithEmail = async (
    name: string,
    email: string,
    pass: string
  ): Promise<{ success: boolean; hasBoard?: boolean; error?: string }> => {
    try {
      const created = await signUpWithEmailViaServer(name.trim(), email.trim(), pass);
      return await loginWithEmail(created.email, pass);
    } catch (err: any) {
      return { success: false, error: err?.message || 'สมัครสมาชิกไม่สำเร็จ' };
    }
  };

  // Google Sign Up: Google only verifies the e-mail; the account uses the password the user typed.
  const signUpWithGoogle = async (
    pass: string,
    name?: string
  ): Promise<{ success: boolean; hasBoard?: boolean; error?: string }> => {
    if (!FEATURES.googleLogin) {
      return { success: false, error: 'ระบบปิดการสมัครด้วย Google ชั่วคราว' };
    }
    try {
      const idToken = await getGoogleIdToken();
      const created = await signUpWithGoogleViaServer(idToken, pass, name?.trim());
      return await loginWithEmail(created.email, pass);
    } catch (err: any) {
      return { success: false, error: err?.message || 'สมัครด้วย Google ไม่สำเร็จ' };
    }
  };

  // Logout
  const logout = async () => {
    // Stop push for this account on this phone while the session is still valid.
    await unregisterPushFromThingsBoard();
    await thingsboard.logout();
    activeBoardRef.current = null;
    pendingPumpsRef.current = {};
    setPendingPumps({});
    setPendingMode(null);
    setFetchedBoardId(null);
    setCurrentUser(null);
    setIsCloudConnected(false);
    setConnectedBoardId(null);
    try {
      localStorage.removeItem('connected_board_id');
      localStorage.removeItem('smartfarm_current_user');
    } catch {}
    Preferences.remove({ key: 'connected_board_id' }).catch(() => {});
    Preferences.remove({ key: 'smartfarm_current_user' }).catch(() => {});
    updateSavedBoards(() => ({})); // the next account must not see this account's devices
    setData({ ...initialMockData });
  };

  const failCommand = (message: string, title = 'คำสั่งล้มเหลว'): never => {
    setCommandError(message);
    showAlert({ title, message, variant: 'danger' });
    throw new Error(message);
  };

  // Toggle Pump (Two-Way RPC setPump, Contract v3 §4)
  const togglePump = async (pumpKey: PumpKey, seconds?: number) => {
    const boardId = connectedBoardId;
    if (!boardId) {
      showAlert({ title: 'ไม่พบอุปกรณ์', message: 'กรุณาเชื่อมต่ออุปกรณ์ก่อนสั่งงานปั๊ม', variant: 'warning' });
      throw new Error('ไม่พบอุปกรณ์');
    }
    if (pendingPumpsRef.current[pumpKey]) return; // command already in flight
    if (!canControl) failCommand(LIVE_REQUIRED_MESSAGE, 'ปั๊มถูกล็อก');
    if (isChemicalPump(pumpKey) && data.pumps.controlMode !== 'MANUAL') {
      failCommand(
        data.pumps.controlMode === 'AUTO'
          ? describeRpcError('AUTO_MODE_LOCKED')
          : 'ยังไม่ทราบโหมดการทำงานของอุปกรณ์ ระบบล็อกปั๊มสารเคมีไว้ก่อนเพื่อความปลอดภัย',
        'ปั๊มถูกล็อก'
      );
    }

    // Running pump -> stop now (seconds 0). Otherwise run for the clamped duration.
    const isOn = data.pumps[pumpKey] === true;
    const runSeconds = isOn ? 0 : clampPumpSeconds(pumpKey, seconds);

    pendingPumpsRef.current = { ...pendingPumpsRef.current, [pumpKey]: true };
    setPendingPumps((prev) => ({ ...prev, [pumpKey]: true }));
    setCommandError(null);

    try {
      await thingsboard.callDeviceRpc(boardId, 'setPump', { pump: PUMP_RPC_NAME[pumpKey], seconds: runSeconds }, 10000);
      // The board answered success: show its new relay state until telemetry reports it
      // (ON: for the run time, OFF: briefly), then the reported value rules again.
      const turnedOn = runSeconds > 0;
      const now = Date.now();
      setPumpRunEnds((prev) => {
        const next = { ...prev };
        if (turnedOn) next[pumpKey] = now + runSeconds * 1000;
        else delete next[pumpKey];
        return next;
      });
      confirmedRef.current.pumps[pumpKey] = {
        value: turnedOn,
        until: now + (turnedOn ? Math.min(runSeconds * 1000, 75000) : 15000),
      };
      if (activeBoardRef.current === boardId) {
        setData((prev) => ({ ...prev, pumps: { ...prev.pumps, [pumpKey]: turnedOn } }));
      }
      setTimeout(() => {
        fetchDeviceData(boardId);
      }, 2500);
      if (turnedOn) {
        // read the OFF state back right after the run ends
        setTimeout(() => {
          fetchDeviceData(boardId);
        }, runSeconds * 1000 + 2500);
      }
    } catch (err: any) {
      failCommand(err?.message || describeRpcError('TIMEOUT'));
    } finally {
      const nextRef = { ...pendingPumpsRef.current };
      delete nextRef[pumpKey];
      pendingPumpsRef.current = nextRef;
      setPendingPumps((prev) => {
        const next = { ...prev };
        delete next[pumpKey];
        return next;
      });
    }
  };

  // Solution tanks (Soft Sensor): levels are CALCULATED from real data only (see solutionTracker.ts).
  const solutionLevels = useMemo(() => {
    const out = {} as Record<SolutionTankKey, TankLevel>;
    SOLUTION_TANK_KEYS.forEach((k) => {
      out[k] = computeTankLevel(data.solutionTanks?.[k], data.pumpRuntimeS?.[k] ?? null);
    });
    return out;
  }, [data.solutionTanks, data.pumpRuntimeS]);

  // Writes one tank record to ThingsBoard (server attribute, shared by all the owner's phones).
  const saveSolutionRecord = async (tankKey: SolutionTankKey, record: NonNullable<SolutionTanks[SolutionTankKey]>) => {
    const boardId = connectedBoardId;
    if (!boardId) throw new Error('กรุณาเลือกอุปกรณ์ก่อน');
    const next: SolutionTanks = { ...(data.solutionTanks || {}), [tankKey]: record };
    await thingsboard.saveServerAttributes(boardId, { [SOLUTION_ATTRIBUTE_KEY]: next });
    setData((prev) => (activeBoardRef.current === boardId ? { ...prev, solutionTanks: next } : prev));
  };

  // Refill: the user poured `amountMl` into the tank (adds to the calculated remaining volume).
  const refillTank = async (tankKey: SolutionTankKey, amountMl: number, newCapacityMl?: number) => {
    const record = data.solutionTanks?.[tankKey];
    const capacity = newCapacityMl && newCapacityMl > 0 ? newCapacityMl : record?.capacityMl;
    if (!capacity) throw new Error('กรุณาระบุความจุของถัง');
    const next = applyRefill(record, solutionLevels[tankKey], amountMl, capacity, data.pumpRuntimeS?.[tankKey] ?? null);
    await saveSolutionRecord(tankKey, next);
  };

  // Flow calibration: the pump ran `seconds` into a measuring cup and delivered `measuredMl`.
  const calibratePumpFlow = async (tankKey: SolutionTankKey, measuredMl: number, seconds: number) => {
    const next = applyFlowCalibration(
      data.solutionTanks?.[tankKey],
      solutionLevels[tankKey],
      measuredMl,
      seconds,
      data.pumpRuntimeS?.[tankKey] ?? null
    );
    if (!next) throw new Error('ค่าที่วัดไม่ถูกต้อง (ต้องมากกว่า 0 และไม่เกิน 50 มล./วินาที)');
    await saveSolutionRecord(tankKey, next);
  };

  // ── Farm alerts: evaluate real data every poll, keep an in-app list, notify the phone ──
  const [notificationsEnabled, setNotificationsEnabledState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('smartfarm_notifications_enabled') !== 'false';
    } catch {
      return true;
    }
  });
  const alertStateRef = useRef<{ boardId: string | null; state: AlertState }>({ boardId: null, state: {} });

  const ensureNotificationPermission = useCallback(async (): Promise<boolean> => {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LocalNotifications')) return false;
    try {
      let perm = await LocalNotifications.checkPermissions();
      if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') perm = await LocalNotifications.requestPermissions();
      return perm.display === 'granted';
    } catch {
      return false;
    }
  }, []);

  const setNotificationsEnabled = async (enabled: boolean): Promise<boolean> => {
    let ok = enabled;
    if (enabled) ok = (await ensureNotificationPermission()) || !Capacitor.isNativePlatform();
    setNotificationsEnabledState(ok);
    try {
      localStorage.setItem('smartfarm_notifications_enabled', ok ? 'true' : 'false');
    } catch {}
    return ok;
  };

  // Push outside the app: register this phone with ThingsBoard for the signed-in account
  // (alerts are evaluated by the ThingsBoard rule chain "Farm Alerts" and sent only to the owner).
  const pushUserEmail = currentUser?.email || null;
  const pushRegisteredRef = useRef(false);
  useEffect(() => {
    pushRegisteredRef.current = false;
    if (!pushUserEmail) return;
    let cancelled = false;
    if (notificationsEnabled) {
      void registerPushWithThingsBoard().then((ok) => {
        if (!cancelled) pushRegisteredRef.current = ok;
      });
    } else {
      void unregisterPushFromThingsBoard();
    }
    return () => {
      cancelled = true;
    };
  }, [pushUserEmail, notificationsEnabled]);

  useEffect(() => {
    const boardId = connectedBoardId;
    if (!boardId || fetchedBoardId !== boardId) return;
    if (alertStateRef.current.boardId !== boardId) {
      let saved: AlertState = {};
      try {
        saved = JSON.parse(localStorage.getItem(`smartfarm_alertstate_${boardId}`) || '{}');
      } catch {}
      alertStateRef.current = { boardId, state: saved };
    }
    const now = Date.now();
    const points = Object.values(data.history || {}).filter((p) => p.timestamp >= now - 3 * 3600_000);
    const toSeries = (pick: (p: HistoryPoint) => number | null): Sample[] =>
      points.map((p) => ({ ts: p.timestamp, value: pick(p) })).filter((x): x is Sample => typeof x.value === 'number');
    const health = analyzeSensorHealth({
      now,
      freshness: telemetryFreshness,
      isSim: Boolean(data.device.isSim),
      sensorOk: data.device.sensorOk ?? null,
      current: { pH: data.current.pH, ec: data.current.ec, tempC: data.current.tempC },
      series: { ph: toSeries((p) => p.pH), ec: toSeries((p) => p.ec), temp: toSeries((p) => p.tempC) },
    });
    const conditions = evaluateAlertConditions({
      freshness: telemetryFreshness,
      current: { pH: data.current.pH, ec: data.current.ec, tempC: data.current.tempC },
      targets: getEffectiveTargets(data),
      mainTankOk: data.levels.mainTankOk ?? null,
      solutionLevels,
      sensorChecks: health.checks,
    });
    const farmName = savedBoards[boardId]?.name || 'ฟาร์มของคุณ';
    const { state, notify, resolved } = trackAlerts(alertStateRef.current.state, conditions, now, farmName, {
      autoMode: data.pumps.controlMode === 'AUTO',
      // a signal hiccup (stale / offline) must not report a still-wrong value as resolved
      holdMissing: telemetryFreshness !== 'live',
    });
    alertStateRef.current = { boardId, state };
    try {
      localStorage.setItem(`smartfarm_alertstate_${boardId}`, JSON.stringify(state));
    } catch {}

    if (notify.length || resolved.length) {
      setData((prev) => {
        if (activeBoardRef.current !== boardId) return prev;
        const alerts = { ...prev.alerts };
        notify.forEach((ev) => {
          const tracked = state[ev.debounceKey];
          alerts[`local:${ev.debounceKey}:${tracked.firstSeen}`] = {
            level: ev.level,
            title: ev.title,
            message: ev.message,
            timestamp: now,
            read: false,
          };
        });
        resolved.forEach((key) => {
          Object.keys(alerts)
            .filter((id) => id.startsWith(`local:${key}:`) && !alerts[id].title.startsWith('คลี่คลายแล้ว'))
            .forEach((id) => {
              alerts[id] = { ...alerts[id], level: 'info', title: `คลี่คลายแล้ว: ${alerts[id].title}` };
            });
        });
        // keep the list bounded: newest 60 app-generated entries
        const local = Object.entries(alerts).filter(([id]) => id.startsWith('local:')).sort((a, b) => b[1].timestamp - a[1].timestamp);
        local.slice(60).forEach(([id]) => delete alerts[id]);
        saveAlertMemory(boardId, alerts, dismissedAlarmIdsRef.current);
        return { ...prev, alerts };
      });
    }

    // In the background ThingsBoard push already covers these alerts (no duplicate local copy);
    // without a working push registration the local notification is still shown.
    const pushCovers = pushRegisteredRef.current && typeof document !== 'undefined' && document.visibilityState !== 'visible';
    if (notify.length && notificationsEnabled && Capacitor.isNativePlatform() && !pushCovers) {
      const batch = synthesizeAlertBatch(notify);
      if (batch && !shouldSuppressNotification({ level: batch.level, category: batch.category })) {
        void ensureNotificationPermission().then((granted) => {
          if (!granted) return;
          LocalNotifications.schedule({
            notifications: [
              {
                id: Math.floor(now / 1000) % 2147483647,
                title: batch.title,
                body: batch.body,
                channelId: batch.channelId,
                schedule: { at: new Date(Date.now() + 500), allowWhileIdle: true },
              },
            ],
          }).catch((e) => console.warn('[SmartFarm] local notification notice:', e?.message || e));
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedBoardId, fetchedBoardId, data.current.updatedAt, telemetryFreshness, data.levels.mainTankOk, solutionLevels]);

  // A refill recorded while the board had not reported its counter yet: pin the baseline as soon as it does.
  const baselineWriteRef = useRef(false);
  useEffect(() => {
    const boardId = connectedBoardId;
    const tanks = data.solutionTanks;
    if (!boardId || !tanks || baselineWriteRef.current) return;
    const pending = SOLUTION_TANK_KEYS.filter(
      (k) => tanks[k] && tanks[k]!.refilledAt > 0 && tanks[k]!.runAtRefillS === null && data.pumpRuntimeS?.[k] != null
    );
    if (!pending.length) return;
    const next: SolutionTanks = { ...tanks };
    pending.forEach((k) => {
      next[k] = { ...tanks[k]!, runAtRefillS: data.pumpRuntimeS![k]! };
    });
    baselineWriteRef.current = true;
    thingsboard
      .saveServerAttributes(boardId, { [SOLUTION_ATTRIBUTE_KEY]: next })
      .then(() => setData((prev) => (activeBoardRef.current === boardId ? { ...prev, solutionTanks: next } : prev)))
      .catch((e) => console.warn('[SmartFarm] solution baseline notice:', e?.message || e))
      .finally(() => {
        baselineWriteRef.current = false;
      });
  }, [connectedBoardId, data.solutionTanks, data.pumpRuntimeS]);

  // Set Control Mode (Two-Way RPC setMode)
  const setControlMode = async (mode: 'AUTO' | 'MANUAL') => {
    const boardId = connectedBoardId;
    if (!boardId) return;
    if (pendingMode) return;
    if (!canControl) failCommand(LIVE_REQUIRED_MESSAGE, 'เปลี่ยนโหมดไม่ได้');
    setPendingMode(mode);
    setCommandError(null);
    try {
      await thingsboard.callDeviceRpc(boardId, 'setMode', { mode }, 10000);
      // Board confirmed success === true: keep showing it until telemetry reports the same mode.
      confirmedRef.current.mode = { value: mode, until: Date.now() + 75000 };
      if (activeBoardRef.current === boardId) {
        setData((prev) => ({ ...prev, pumps: { ...prev.pumps, controlMode: mode } }));
      }
      setTimeout(() => {
        fetchDeviceData(boardId);
      }, 2500);
    } catch (err: any) {
      failCommand(err?.message || describeRpcError('TIMEOUT'), 'เปลี่ยนโหมดไม่สำเร็จ');
    } finally {
      setPendingMode(null);
    }
  };

  // Update Plant Type & Schedule
  const updatePlantType = async (
    type: string,
    targets?: { targetPHMin: number; targetPHMax: number; targetECMin: number; targetECMax: number },
    plantingStartDate?: number,
    expectedHarvestDays?: number
  ) => {
    const payload: Record<string, any> = { plantType: type };
    if (targets) {
      Object.assign(
        payload,
        toSharedTargetAttributes({
          phMin: targets.targetPHMin,
          phMax: targets.targetPHMax,
          ecMin: targets.targetECMin,
          ecMax: targets.targetECMax,
        })
      );
    }
    if (plantingStartDate) payload.plantingStartDate = plantingStartDate;
    if (expectedHarvestDays) payload.expectedHarvestDays = expectedHarvestDays;

    if (connectedBoardId) {
      try {
        await thingsboard.saveSharedAttributes(connectedBoardId, payload);
      } catch (e: any) {
        throw new Error(`บันทึกข้อมูลการปลูกไปยังอุปกรณ์ไม่สำเร็จ: ${e?.message || 'เครือข่ายขัดข้อง'}`);
      }
    }

    setData((prev) => {
      const updated: SmartWaterFarmData = {
        ...prev,
        plantType: type,
        ...(targets || {}),
        ...(targets ? { targetsSource: 'requested' as TargetsSource } : {}),
        plantingStartDate: plantingStartDate || prev.plantingStartDate,
        expectedHarvestDays: expectedHarvestDays || prev.expectedHarvestDays,
      };
      if (connectedBoardId) saveLocalFarmSnapshot(connectedBoardId, updated);
      return updated;
    });
  };

  // Update Target Attributes (with range validation). Writes contract shared attrs ph_min..temp_max.
  const updateTargets = async (targets: {
    phMin?: number;
    phMax?: number;
    ecMin?: number;
    ecMax?: number;
    tempMin?: number;
    tempMax?: number;
    levelLow?: number;
    fertLow?: number;
  }) => {
    // 1. Validate pH: 4.5 - 7.5
    if (targets.phMin !== undefined && (targets.phMin < 4.5 || targets.phMin > 7.5)) {
      throw new Error('ค่า pH ต่ำสุดต้องอยู่ระหว่าง 4.5 ถึง 7.5');
    }
    if (targets.phMax !== undefined && (targets.phMax < 4.5 || targets.phMax > 7.5)) {
      throw new Error('ค่า pH สูงสุดต้องอยู่ระหว่าง 4.5 ถึง 7.5');
    }
    if (targets.phMin !== undefined && targets.phMax !== undefined && targets.phMin >= targets.phMax) {
      throw new Error('ค่า pH ต่ำสุดต้องน้อยกว่าค่าสูงสุด');
    }

    // 2. Validate EC: 0.5 - 3.5
    if (targets.ecMin !== undefined && (targets.ecMin < 0.5 || targets.ecMin > 3.5)) {
      throw new Error('ค่า EC ต่ำสุดต้องอยู่ระหว่าง 0.5 ถึง 3.5');
    }
    if (targets.ecMax !== undefined && (targets.ecMax < 0.5 || targets.ecMax > 3.5)) {
      throw new Error('ค่า EC สูงสุดต้องอยู่ระหว่าง 0.5 ถึง 3.5');
    }
    if (targets.ecMin !== undefined && targets.ecMax !== undefined && targets.ecMin >= targets.ecMax) {
      throw new Error('ค่า EC ต่ำสุดต้องน้อยกว่าค่าสูงสุด');
    }

    // 3. Validate Temp: 15 - 35
    if (targets.tempMin !== undefined && (targets.tempMin < 15 || targets.tempMin > 35)) {
      throw new Error('อุณหภูมิต่ำสุดต้องอยู่ระหว่าง 15 ถึง 35 องศาเซลเซียส');
    }
    if (targets.tempMax !== undefined && (targets.tempMax < 15 || targets.tempMax > 35)) {
      throw new Error('อุณหภูมิสูงสุดต้องอยู่ระหว่าง 15 ถึง 35 องศาเซลเซียส');
    }
    if (targets.tempMin !== undefined && targets.tempMax !== undefined && targets.tempMin >= targets.tempMax) {
      throw new Error('อุณหภูมิต่ำสุดต้องน้อยกว่าอุณหภูมิสูงสุด');
    }

    // Contract v3 §3 shared attributes. levelLow / fertLow are app-only alert settings (kept locally).
    const payload = toSharedTargetAttributes(targets);

    if (connectedBoardId && Object.keys(payload).length > 0) {
      await thingsboard.saveSharedAttributes(connectedBoardId, payload);
    }

    setData((prev) => {
      const updated: SmartWaterFarmData = {
        ...prev,
        targetsSource: Object.keys(payload).length > 0 ? 'requested' : prev.targetsSource,
        targetPHMin: targets.phMin !== undefined ? targets.phMin : prev.targetPHMin,
        targetPHMax: targets.phMax !== undefined ? targets.phMax : prev.targetPHMax,
        targetECMin: targets.ecMin !== undefined ? targets.ecMin : prev.targetECMin,
        targetECMax: targets.ecMax !== undefined ? targets.ecMax : prev.targetECMax,
        targetTempMin: targets.tempMin !== undefined ? targets.tempMin : prev.targetTempMin,
        targetTempMax: targets.tempMax !== undefined ? targets.tempMax : prev.targetTempMax,
        targets: {
          ...(prev.targets || {}),
          ...targets,
        },
      };
      if (connectedBoardId) saveLocalFarmSnapshot(connectedBoardId, updated);
      return updated;
    });
  };

  const runDeviceAction = async (
    method: 'reboot' | 'resetWifi' | 'factoryReset',
    okMessage: string
  ): Promise<DeviceActionResult> => {
    if (!connectedBoardId) return { success: false, message: 'ยังไม่ได้เลือกอุปกรณ์' };
    try {
      const body = await thingsboard.callDeviceRpc(connectedBoardId, method, {}, 10000);
      if (method === 'resetWifi') {
        const d = typeof body?.d === 'string' ? body.d.trim().toUpperCase() : '';
        const c = typeof body?.c === 'string' ? body.c.trim() : '';
        let m: string | null = null;
        if (typeof body?.m === 'string') {
          let mac = body.m.trim().toUpperCase().replace(/-/g, ':');
          if (/^[0-9A-F]{12}$/.test(mac)) mac = mac.match(/.{2}/g)!.join(':');
          if (/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac) && mac !== '00:00:00:00:00:00') m = mac;
        }
        // Older firmware answers {"success":true} only -> no provision -> the app falls back to the QR.
        if (/^FARM-[A-Z0-9-]{2,32}$/.test(d) && /^[A-Za-z0-9]{10}$/.test(c)) {
          return { success: true, message: okMessage, provision: { d, c, m } };
        }
      }
      return { success: true, message: okMessage };
    } catch (err: any) {
      const message = err?.message || describeRpcError('TIMEOUT');
      setCommandError(message);
      return { success: false, message };
    }
  };

  // Reboot Device (RPC reboot)
  const rebootDevice = () => runDeviceAction('reboot', 'อุปกรณ์รับคำสั่งรีสตาร์ทแล้ว');

  // Demo board only: the firmware accepts simSet only when compiled with DEMO_SIM (its data stays sim:true).
  const setDemoSimValues = async (values: { ph?: number; ec?: number; temp?: number }): Promise<DeviceActionResult> => {
    if (!connectedBoardId) return { success: false, message: 'ยังไม่ได้เลือกอุปกรณ์' };
    if (!data.device.isSim) return { success: false, message: 'อุปกรณ์นี้ไม่รองรับการทดสอบนี้' };
    const params: Record<string, number> = {};
    (['ph', 'ec', 'temp'] as const).forEach((k) => {
      const v = values[k];
      if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
    });
    if (Object.keys(params).length === 0) return { success: false, message: 'กรุณาใส่ค่าอย่างน้อย 1 ค่า' };
    try {
      await thingsboard.callDeviceRpc(connectedBoardId, 'simSet', params, 10000);
      return { success: true, message: 'ส่งค่าทดสอบแล้ว ค่าใหม่จะขึ้นในแอปภายในไม่กี่วินาที' };
    } catch (err: any) {
      return { success: false, message: err?.message || describeRpcError('TIMEOUT') };
    }
  };

  // Reset Device WiFi (RPC resetWifi: board clears WiFi, opens pairing window, restarts)
  const resetDeviceWifi = () =>
    runDeviceAction('resetWifi', 'อุปกรณ์ล้างการตั้งค่า WiFi แล้ว และกำลังรีสตาร์ทเข้าสู่โหมดจับคู่');

  // Factory Reset Device (RPC factoryReset): the device wipes itself, then the device is removed from
  // this account and from the app (same account-side clean-up as "remove device").
  const factoryResetDevice = async (): Promise<DeviceActionResult> => {
    const boardId = connectedBoardId;
    const res = await runDeviceAction('factoryReset', 'อุปกรณ์คืนค่าโรงงานแล้ว และนำออกจากบัญชีนี้เรียบร้อย');
    if (!res.success || !boardId) return res;
    try {
      await removeBoard(boardId, { skipUnbindRpc: true });
    } catch (e: any) {
      return {
        success: false,
        message: `อุปกรณ์คืนค่าโรงงานแล้ว แต่นำออกจากบัญชีไม่สำเร็จ: ${e?.message || 'ไม่ทราบสาเหตุ'} กรุณากดลบอุปกรณ์อีกครั้ง`,
      };
    }
    return res;
  };

  // End Crop Season
  // Ends the crop cycle: new start date is saved on the device (ThingsBoard) so it survives the next poll.
  // ThingsBoard telemetry history is kept; only this phone's local chart cache is cleared.
  const endCropSeason = async () => {
    if (!connectedBoardId) throw new Error('กรุณาเลือกอุปกรณ์ก่อน');
    const startedAt = Date.now();
    await thingsboard.saveSharedAttributes(connectedBoardId, { plantingStartDate: startedAt });
    try {
      localStorage.removeItem(`smartfarm_history_${connectedBoardId}`);
    } catch (_) {}
    setData((prev) => ({ ...prev, history: {}, plantingStartDate: startedAt }));
  };

  // Mark Alert Read
  const markAlertRead = async (alertId: string) => {
    setData((prev) => {
      if (!prev.alerts[alertId]) return prev;
      const alerts = { ...prev.alerts, [alertId]: { ...prev.alerts[alertId], read: true } };
      saveAlertMemory(activeBoardRef.current, alerts, dismissedAlarmIdsRef.current);
      return { ...prev, alerts };
    });
  };

  // Clear Alerts
  const clearAlerts = async () => {
    setData((prev) => {
      // Remember cleared ThingsBoard alarm ids so the next poll does not bring them back.
      Object.keys(prev.alerts).forEach((id) => dismissedAlarmIdsRef.current.add(id));
      saveAlertMemory(activeBoardRef.current, {}, dismissedAlarmIdsRef.current);
      return { ...prev, alerts: {} };
    });
  };

  // Record Farm Diary Entry
  const recordFarmDiaryEntry = async (text: string, type: FarmDiaryEntry['type'] = 'MANUAL_NOTE') => {
    if (!connectedBoardId) return;
    const now = new Date();
    const entryId = `diary_${Date.now()}`;
    const day = calculatePlantDays(data.plantingStartDate);
    const entry: FarmDiaryEntry = {
      id: entryId,
      day,
      date: now.toLocaleDateString('th-TH'),
      time: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
      type,
      text,
      timestamp: Date.now(),
    };

    setData((prev) => {
      const nextMemory = {
        ...(prev.aiMemory || {}),
        [entryId]: entry,
      };
      saveLocalMemory(connectedBoardId, nextMemory);
      return {
        ...prev,
        aiMemory: nextMemory,
      };
    });
  };

  // Ask Gemini Advisor
  const askGeminiAdvisor = async (_question: string): Promise<{ answer?: string; error?: string }> => {
    if (!FEATURES.ai) {
      return { error: 'ระบบปิดการใช้งาน AI ชั่วคราว' };
    }
    return { error: 'ฟีเจอร์ AI ไม่พร้อมใช้งาน' };
  };

  const isBoardConnected = Boolean(connectedBoardId && isDeviceOnline);

  const contextValue: SmartFarmContextType = {
    data,
    loading,
    isCloudConnected,
    userId: currentUser?.uid || '',
    connectedBoardId,
    isBoardConnected,
    currentUser,
    isAuthenticated: Boolean(currentUser),
    theme,
    toggleTheme,
    setTheme,
    savedBoards,
    connectBoard,
    disconnectBoard,
    removeBoard,
    claimBoardDevice,
    waitForBoardBound,
    loginWithEmail,
    signUpWithGoogle,
    signUpWithEmail,
    logout,
    togglePump,
    pendingPumps,
    pendingMode,
    pumpRunEnds,
    commandError,
    clearCommandError,
    isDeviceOnline,
    isDeviceStale,
    canControl,
    isDemoBoard,
    telemetryFreshness,
    refillTank,
    solutionLevels,
    calibratePumpFlow,
    notificationsEnabled,
    setNotificationsEnabled,
    unreadAlertCount: Object.values(data.alerts || {}).filter((a) => !a.read).length,
    setControlMode,
    updatePlantType,
    updateTargets,
    rebootDevice,
    setDemoSimValues,
    resetDeviceWifi,
    factoryResetDevice,
    endCropSeason,
    markAlertRead,
    clearAlerts,
    showConfirm,
    showAlert,
    enableDosingTracking,
    setEnableDosingTracking,
    recordFarmDiaryEntry,
    askGeminiAdvisor,
  };

  return (
    <SmartFarmContext.Provider value={contextValue}>
      {children}
      <ModernConfirmModal modalState={modalState} onClose={() => setModalState((prev) => ({ ...prev, isOpen: false }))} />
    </SmartFarmContext.Provider>
  );
};

export const useSmartFarm = (): SmartFarmContextType => {
  const ctx = useContext(SmartFarmContext);
  if (!ctx) {
    throw new Error('useSmartFarm must be used within a SmartFarmProvider');
  }
  return ctx;
};
