import { useCallback, useEffect, useState } from 'react';
import { Preferences } from '@capacitor/preferences';

/**
 * Home screen layout preferences (display only, stored on this phone; nothing is sent to the device
 * or the cloud): the order of the 5 home sections and how the water-quality metrics are drawn.
 *
 * Saved to BOTH localStorage (instant read on first render) and Capacitor Preferences (native
 * SharedPreferences): the Android WebView's localStorage does not reliably survive the app being
 * closed, so without Preferences the layout went back to default on every app restart
 * (same reason the login session is mirrored to Preferences in services/thingsboard.ts).
 */
export type HomeSectionId = 'briefing' | 'sensorHealth' | 'waterQuality' | 'tanks' | 'pumps';
export type MetricViewMode = 'grid' | 'rings';

export const HOME_SECTION_LABELS: Record<HomeSectionId, string> = {
  briefing: 'สรุปสถานะฟาร์ม',
  sensorHealth: 'AI ตรวจสุขภาพเซนเซอร์',
  waterQuality: 'คุณภาพน้ำ',
  tanks: 'ระดับสารละลายในถัง',
  pumps: 'ควบคุมปั๊มน้ำ',
};

export const DEFAULT_HOME_ORDER: HomeSectionId[] = ['briefing', 'sensorHealth', 'waterQuality', 'tanks', 'pumps'];

const STORAGE_KEY = 'smartfarm_home_layout_v1';
const CHANGE_EVENT = 'smartfarm-home-layout-change';

interface HomeLayout {
  order: HomeSectionId[];
  metricView: MetricViewMode;
}

/** Keep only known ids, no duplicates, and append any missing section (e.g. added in a later version). */
function normalizeOrder(value: unknown): HomeSectionId[] {
  const known = new Set<HomeSectionId>(DEFAULT_HOME_ORDER);
  const out: HomeSectionId[] = [];
  if (Array.isArray(value)) {
    for (const v of value) {
      if (known.has(v as HomeSectionId) && !out.includes(v as HomeSectionId)) out.push(v as HomeSectionId);
    }
  }
  for (const id of DEFAULT_HOME_ORDER) if (!out.includes(id)) out.push(id);
  return out;
}

function parseLayout(raw: string | null | undefined): HomeLayout {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      order: normalizeOrder(parsed?.order),
      metricView: parsed?.metricView === 'rings' ? 'rings' : 'grid',
    };
  } catch (_) {
    return { order: [...DEFAULT_HOME_ORDER], metricView: 'grid' };
  }
}

function readLayout(): HomeLayout {
  try {
    return parseLayout(localStorage.getItem(STORAGE_KEY));
  } catch (_) {
    return parseLayout(null);
  }
}

function writeLayout(layout: HomeLayout) {
  const json = JSON.stringify(layout);
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch (_) {
    /* storage full / blocked: Preferences below still keeps it */
  }
  Preferences.set({ key: STORAGE_KEY, value: json }).catch(() => {});
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// Restore from native Preferences once per app launch (survives app kill), then tell every hook.
let restorePromise: Promise<void> | null = null;
function restoreFromPreferences(): Promise<void> {
  if (!restorePromise) {
    restorePromise = Preferences.get({ key: STORAGE_KEY })
      .then(({ value }) => {
        if (!value) {
          // older install: layout only in localStorage -> copy it to Preferences
          const local = (() => {
            try {
              return localStorage.getItem(STORAGE_KEY);
            } catch (_) {
              return null;
            }
          })();
          if (local) Preferences.set({ key: STORAGE_KEY, value: local }).catch(() => {});
          return;
        }
        try {
          if (localStorage.getItem(STORAGE_KEY) === value) return;
          localStorage.setItem(STORAGE_KEY, value);
        } catch (_) {
          /* ignore: the event below still re-reads what it can */
        }
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }));
      })
      .catch(() => {});
  }
  return restorePromise;
}

export function useHomeLayout() {
  const [layout, setLayout] = useState<HomeLayout>(readLayout);

  useEffect(() => {
    const sync = (e?: Event) => {
      const detail = (e as CustomEvent<string> | undefined)?.detail;
      setLayout(typeof detail === 'string' ? parseLayout(detail) : readLayout());
    };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    restoreFromPreferences();
  }, []);

  const update = useCallback((next: HomeLayout) => {
    setLayout(next);
    writeLayout(next);
  }, []);

  /** Move a section one step up (-1) or down (+1). */
  const moveSection = useCallback(
    (id: HomeSectionId, dir: -1 | 1) => {
      const order = [...layout.order];
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      update({ ...layout, order });
    },
    [layout, update]
  );

  const setMetricView = useCallback((metricView: MetricViewMode) => update({ ...layout, metricView }), [layout, update]);

  const resetLayout = useCallback(() => update({ order: [...DEFAULT_HOME_ORDER], metricView: 'grid' }), [update]);

  return {
    order: layout.order,
    metricView: layout.metricView,
    moveSection,
    setMetricView,
    resetLayout,
  };
}
