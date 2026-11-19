import { useState, useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Screen } from './types';

import SplashScreen from './screens/SplashScreen';
import WelcomeScreen from './screens/WelcomeScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import LoginScreen from './screens/LoginScreen';
import SignUpScreen from './screens/SignUpScreen';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import { restoreUserGeminiKey } from './services/geminiKeyStore';
import HomeScreen from './screens/HomeScreen';
import WaterQualityScreen from './screens/WaterQualityScreen';
import FarmStatusScreen from './screens/FarmStatusScreen';
import HistoryScreen from './screens/HistoryScreen';
import NotificationsScreen from './screens/NotificationsScreen';
import ProfileScreen from './screens/ProfileScreen';
import SettingsScreen from './screens/SettingsScreen';
import DeviceScreen from './screens/DeviceScreen';
import ConnectBoardScreen from './screens/ConnectBoardScreen';
import AddBoardScreen from './screens/AddBoardScreen';
import WifiSetupScreen from './screens/WifiSetupScreen';
import SetupFarmScreen from './screens/SetupFarmScreen';
import { useSmartFarm } from './context/SmartFarmContext';
import { ReactNode } from 'react';

// Lucide nav icons (line icons, consistent weight)
import {
  Home,
  Droplets,
  BarChart2,
  Bell,
  User,
  FlaskConical,
  Activity,
  Layers,
  Cpu,
  Settings,
  LogOut,
} from 'lucide-react';

/** Auth / intro screens. Crossing between these and the signed-in app always resets the back stack. */
const AUTH_SCREENS: Screen[] = ['splash', 'welcome', 'onboarding', 'login', 'signup'];
/** One-time screens that must never be returned to with Back. */
const ONE_TIME_SCREENS: Screen[] = ['splash', 'onboarding'];

const NO_SHELL: Screen[] = ['splash', 'welcome', 'onboarding', 'login', 'signup', 'connect-board', 'add-board', 'wifi-setup', 'setup-farm'];

const tabs: { id: Screen; icon: ReactNode; label: string }[] = [
  { id: 'home', icon: <Home size={19} strokeWidth={1.5} />, label: 'หน้าหลัก' },
  { id: 'water-quality', icon: <Droplets size={19} strokeWidth={1.5} />, label: 'น้ำ' },
  { id: 'history', icon: <BarChart2 size={19} strokeWidth={1.5} />, label: 'ประวัติ' },
  { id: 'notifications', icon: <Bell size={19} strokeWidth={1.5} />, label: 'แจ้งเตือน' },
  { id: 'profile', icon: <User size={19} strokeWidth={1.5} />, label: 'โปรไฟล์' },
];

const activeMap: Partial<Record<Screen, Screen>> = {
  home: 'home',
  'water-quality': 'water-quality',
  'ph-detail': 'water-quality',
  'ec-detail': 'water-quality',
  'temp-detail': 'water-quality',
  'pump-control': 'water-quality',
  'auto-dosing': 'water-quality',
  'liquid-level': 'water-quality',
  'farm-status': 'water-quality',
  notifications: 'notifications',
  profile: 'profile',
  settings: 'profile',
  device: 'profile',
  history: 'history',
};

const drawerItems: { icon: ReactNode; label: string; s: Screen }[] = [
  { icon: <Home size={16} strokeWidth={1.5} />, label: 'หน้าหลัก', s: 'home' },
  { icon: <Droplets size={16} strokeWidth={1.5} />, label: 'คุณภาพน้ำ', s: 'water-quality' },
  { icon: <Activity size={16} strokeWidth={1.5} />, label: 'ควบคุมปั๊ม & การจ่ายสาร', s: 'pump-control' },
  { icon: <Layers size={16} strokeWidth={1.5} />, label: 'สถานะฟาร์ม', s: 'farm-status' },
  { icon: <BarChart2 size={16} strokeWidth={1.5} />, label: 'ประวัติข้อมูล', s: 'history' },
  { icon: <Bell size={16} strokeWidth={1.5} />, label: 'การแจ้งเตือน', s: 'notifications' },
  { icon: <Cpu size={16} strokeWidth={1.5} />, label: 'จัดการอุปกรณ์ Hydroponic', s: 'device' },
  { icon: <Settings size={16} strokeWidth={1.5} />, label: 'ตั้งค่าแอป', s: 'settings' },
];

const FONT = "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif";

export default function App() {
  const { connectedBoardId, logout, unreadAlertCount } = useSmartFarm();
  const [screen, setScreen] = useState<Screen>('splash');
  const [history, setHistory] = useState<Screen[]>([]);
  const [screenParams, setScreenParams] = useState<any>(null);
  const keyboardInset = useKeyboardInset();
  const [drawer, setDrawer] = useState(false);

  // the user's Gemini key (AI plant analysis) lives in native Preferences: copy it back once per launch
  useEffect(() => {
    void restoreUserGeminiKey();
  }, []);
  const [showExitToast, setShowExitToast] = useState(false);

  const screenRef = useRef(screen);
  const historyRef = useRef(history);
  const drawerRef = useRef(drawer);
  const lastBackPressRef = useRef<number>(0);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    drawerRef.current = drawer;
  }, [drawer]);

  /**
   * Navigate to a screen. The back stack is cleared (replace) when:
   * - crossing between auth/intro screens and the signed-in app (either direction, incl. logout),
   * - going to 'home' (root of the app: Back on home exits instead of walking old history),
   * - leaving a one-time screen (splash / onboarding).
   */
  const navigate = (s: Screen, params?: any) => {
    setScreenParams(params || null);
    const cur = screenRef.current;
    if (s === cur) {
      setDrawer(false);
      return;
    }
    const crossesAuthBoundary = AUTH_SCREENS.includes(cur) !== AUTH_SCREENS.includes(s);
    const replace = crossesAuthBoundary || s === 'home' || ONE_TIME_SCREENS.includes(cur);
    try {
      if (replace) window.history.replaceState({ screen: s, params }, '', '');
      else window.history.pushState({ screen: s, params }, '', '');
    } catch (e) { }
    if (replace) {
      historyRef.current = [];
      setHistory([]);
    } else {
      historyRef.current = [...historyRef.current, cur];
      setHistory((prev) => [...prev, cur]);
    }
    screenRef.current = s;
    setScreen(s);
    setDrawer(false);
  };

  const goBack = (fallback: Screen = 'home') => {
    setDrawer(false);
    setHistory((prev) => {
      if (prev.length === 0) {
        setScreen(fallback);
        return [];
      }
      const next = [...prev];
      const prevScreen = next.pop();
      setScreen(prevScreen || fallback);
      return next;
    });
  };

  const exitApp = () => {
    try {
      Promise.resolve(CapApp.exitApp()).catch(() => { });
    } catch (_) { }
  };

  // Intercept Android hardware back button and Samsung swipe edge back gesture
  useEffect(() => {
    const handleBackAction = () => {
      // 1. If drawer is open, close it first
      if (drawerRef.current) {
        setDrawer(false);
        return;
      }

      const cur = screenRef.current;
      const hist = historyRef.current;

      // 2. Root screens: home (signed in) and splash/welcome (signed out) never go "back" across
      //    the auth boundary. Back on a root = double press to exit the app.
      const isRoot = cur === 'home' || cur === 'splash' || (cur === 'welcome' && hist.length === 0);
      if (isRoot) {
        const now = Date.now();
        if (lastBackPressRef.current && now - lastBackPressRef.current < 2000) {
          lastBackPressRef.current = 0;
          exitApp();
        } else {
          lastBackPressRef.current = now;
          setShowExitToast(true);
          setTimeout(() => {
            setShowExitToast(false);
          }, 2000);
        }
        return;
      }

      // 3. Auth sub-screens (login / signup / onboarding) fall back to welcome, app screens to home.
      goBack(AUTH_SCREENS.includes(cur) ? 'welcome' : 'home');
    };

    // addListener resolves asynchronously: if the effect is cleaned up first, remove on resolve.
    let disposed = false;
    let capListenerHandle: { remove: () => Promise<void> | void } | null = null;
    try {
      Promise.resolve(
        CapApp.addListener('backButton', () => {
          handleBackAction();
        })
      ).then((h) => {
        if (disposed) {
          try { h.remove(); } catch (_) { }
        } else {
          capListenerHandle = h;
        }
      }).catch(() => { });
    } catch (e) { }

    // NOTE: no document 'backbutton' listener. When an App 'backButton' listener exists, Capacitor
    // (AppPlugin.java) fires BOTH the plugin event and document 'backbutton' for one press, which
    // made one press run twice (home: instant exit, sub screens: back two pages).

    const onPopState = () => {
      handleBackAction();
    };
    window.addEventListener('popstate', onPopState);

    return () => {
      disposed = true;
      if (capListenerHandle) {
        try { capListenerHandle.remove(); } catch (_) { }
        capListenerHandle = null;
      }
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  const inShell = !NO_SHELL.includes(screen);
  const activeTab = activeMap[screen] ?? 'home';
  const activeTabIndex = tabs.findIndex((t) => t.id === activeTab);

  const renderScreen = () => {
    const p = { navigate, goBack, currentScreen: screen, screenParams };
    switch (screen) {
      case 'splash':
        return <SplashScreen {...p} />;
      case 'welcome':
        return <WelcomeScreen {...p} />;
      case 'onboarding':
        return <OnboardingScreen {...p} />;
      case 'login':
        return <LoginScreen {...p} />;
      case 'signup':
        return <SignUpScreen {...p} />;
      case 'home':
        return <HomeScreen {...p} onMenuOpen={() => setDrawer(true)} />;
      case 'water-quality':
        return <WaterQualityScreen {...p} />;
      case 'ph-detail':
        return <HistoryScreen {...p} initialSensor="ph" />;
      case 'ec-detail':
        return <HistoryScreen {...p} initialSensor="ec" />;
      case 'temp-detail':
        return <HistoryScreen {...p} initialSensor="temp" />;
      case 'liquid-level':
        return <WaterQualityScreen {...p} initialTab="levels" />;
      case 'auto-dosing':
      case 'pump-control':
        return <WaterQualityScreen {...p} initialTab="pumps" />;
      case 'farm-status':
        return <FarmStatusScreen {...p} />;
      case 'history':
        return <HistoryScreen {...p} initialSensor={screenParams?.sensor || 'ph'} />;
      case 'notifications':
        return <NotificationsScreen {...p} />;
      case 'profile':
        return <ProfileScreen {...p} />;
      case 'settings':
        return <SettingsScreen {...p} />;
      case 'device':
        return <DeviceScreen {...p} />;
      case 'connect-board':
        return <ConnectBoardScreen {...p} />;
      case 'add-board':
        return <AddBoardScreen {...p} />;
      case 'wifi-setup':
        return <WifiSetupScreen {...p} />;
      case 'setup-farm':
        if (!connectedBoardId) {
          return <HomeScreen {...p} onMenuOpen={() => setDrawer(true)} />;
        }
        return <SetupFarmScreen {...p} />;
      default:
        return <HomeScreen {...p} onMenuOpen={() => setDrawer(true)} />;
    }
  };

  if (!inShell) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          maxHeight: '100%',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
          background: 'linear-gradient(180deg, #F0FBF6 0%, #FFFFFF 100%)',
          fontFamily: FONT,
          display: 'flex',
          justifyContent: 'center',
          position: 'relative',
          paddingBottom: keyboardInset,
        }}
      >
        <div style={{ width: '100%', maxWidth: 430, minHeight: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {renderScreen()}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        maxHeight: '100%',
        background: 'linear-gradient(180deg, #F0FBF6 0%, #FFFFFF 100%)',
        display: 'flex',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: FONT,
      }}
    >
      {/* Ambient background blur elements for living glassmorphism */}
      <div
        style={{
          position: 'fixed',
          top: -60,
          right: -60,
          width: 240,
          height: 240,
          borderRadius: '50%',
          background: 'rgba(16, 185, 129, 0.12)',
          filter: 'blur(60px)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: '40%',
          left: -80,
          width: 220,
          height: 220,
          borderRadius: '50%',
          background: 'rgba(56, 189, 248, 0.08)',
          filter: 'blur(70px)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      <div
        style={{
          width: '100%',
          maxWidth: 430,
          height: '100%',
          maxHeight: '100%',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          zIndex: 1,
        }}
      >
        {/* ── Side Drawer ── */}
        {drawer && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex' }}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(15, 23, 42, 0.35)',
                backdropFilter: 'blur(4px)',
              }}
              onClick={() => setDrawer(false)}
            />
            <div
              style={{
                position: 'relative',
                width: 280,
                background: 'rgba(255, 255, 255, 0.95)',
                backdropFilter: 'blur(16px)',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '8px 0 32px rgba(15, 23, 42, 0.1)',
                animation: 'slideInLeft 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              {/* Drawer Header */}
              <div style={{ padding: '56px 20px 20px', borderBottom: '1px solid rgba(226, 232, 240, 0.7)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 14,
                      background: 'rgba(255, 255, 255, 0.9)',
                      boxShadow: '0 4px 14px rgba(16, 185, 129, 0.12)',
                      border: '1px solid rgba(16, 185, 129, 0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                      <path
                        d="M11 2C11 2 5 7.5 5 13C5 16.3 7.7 19 11 19C14.3 19 17 16.3 17 13C17 7.5 11 2 11 2Z"
                        fill="#ecfdf5"
                        stroke="#059669"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <circle cx="14" cy="14" r="2.5" fill="#bfdbfe" />
                    </svg>
                  </div>
                  <div>
                    <p style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0, letterSpacing: '0.06em' }}>
                      Hydroponic
                    </p>
                    <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>
                      ระบบจัดการไฮโดรโปนิกส์อัจฉริยะ
                    </p>
                  </div>
                </div>
              </div>

              {/* Nav items */}
              <nav style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
                {drawerItems.map((item) => (
                  <button
                    key={item.label}
                    onClick={() => navigate(item.s)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '0 12px',
                      minHeight: 44,
                      borderRadius: 12,
                      border: 'none',
                      cursor: 'pointer',
                      background: screen === item.s ? '#ecfdf5' : 'transparent',
                      color: screen === item.s ? '#059669' : '#334155',
                      marginBottom: 2,
                      textAlign: 'left',
                      transition: 'background 0.15s',
                      fontFamily: FONT,
                    }}
                  >
                    <span style={{ color: screen === item.s ? '#059669' : '#64748b', display: 'flex' }}>
                      {item.icon}
                    </span>
                    <span style={{ fontWeight: screen === item.s ? 600 : 500, fontSize: 13 }}>
                      {item.label}
                    </span>
                  </button>
                ))}
              </nav>

              {/* Drawer Footer */}
              <div style={{ padding: '16px 12px 32px', borderTop: '1px solid rgba(226, 232, 240, 0.7)' }}>
                <button
                  onClick={async () => {
                    setDrawer(false);
                    // Real logout: clears tokens, stops polling, resets state (Audit M20)
                    try {
                      await logout();
                    } catch (_) { }
                    navigate('welcome');
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '0 12px',
                    minHeight: 44,
                    borderRadius: 12,
                    border: 'none',
                    cursor: 'pointer',
                    background: '#fef2f2',
                    color: '#dc2626',
                    textAlign: 'left',
                    fontFamily: FONT,
                  }}
                >
                  <LogOut size={16} strokeWidth={1.5} />
                  <span style={{ fontWeight: 500, fontSize: 13 }}>ออกจากระบบ</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Screen content with soft fade/slide ── */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', paddingBottom: 88 + keyboardInset }}>
          <div key={screen} className="screen-enter">
            {renderScreen()}
          </div>
        </div>

        {/* ── Floating Modern Glassmorphism Bottom Navigation ── */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            width: '100%',
            maxWidth: 430,
            margin: '0 auto',
            padding: '0 16px 16px',
            zIndex: 40,
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.88)',
              backdropFilter: 'blur(20px)',
              borderRadius: 22,
              boxShadow: '0 8px 32px rgba(16, 185, 129, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.9)',
              display: 'flex',
              padding: '6px',
              position: 'relative',
            }}
          >
            {/* Sliding Green Indicator Pill */}
            {activeTabIndex !== -1 && (
              <div
                style={{
                  position: 'absolute',
                  top: 6,
                  bottom: 6,
                  left: `calc(6px + ${activeTabIndex} * ((100% - 12px) / 5))`,
                  width: `calc((100% - 12px) / 5)`,
                  borderRadius: 16,
                  background: '#ecfdf5',
                  transition: 'left 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
                  pointerEvents: 'none',
                  zIndex: 0,
                }}
              />
            )}

            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              const badgeCount = tab.id === 'notifications' ? unreadAlertCount : 0;
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-label={badgeCount > 0 ? `${tab.label} (ยังไม่อ่าน ${badgeCount} รายการ)` : tab.label}
                  onClick={() => navigate(tab.id)}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 3,
                    justifyContent: 'center',
                    padding: '8px 4px',
                    minHeight: 48,
                    borderRadius: 16,
                    border: 'none',
                    cursor: 'pointer',
                    outline: 'none',
                    background: 'transparent',
                    color: active ? '#059669' : '#94a3b8',
                    transition: 'color 0.2s ease',
                    fontFamily: FONT,
                    position: 'relative',
                    zIndex: 1,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                    {tab.icon}
                    {badgeCount > 0 && (
                      <span
                        aria-hidden="true"
                        style={{
                          position: 'absolute',
                          top: -6,
                          left: '60%',
                          minWidth: 16,
                          height: 16,
                          padding: '0 4px',
                          borderRadius: 8,
                          background: '#dc2626',
                          color: '#ffffff',
                          fontSize: 10,
                          fontWeight: 600,
                          lineHeight: '13px',
                          textAlign: 'center',
                          fontVariantNumeric: 'tabular-nums',
                          boxSizing: 'border-box',
                          border: '1.5px solid #ffffff',
                        }}
                      >
                        {badgeCount > 99 ? '99+' : badgeCount}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 10, fontWeight: active ? 600 : 400 }}>
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Double back exit toast */}
      {showExitToast && (
        <div
          style={{
            position: 'fixed',
            bottom: 90,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(15, 23, 42, 0.88)',
            backdropFilter: 'blur(10px)',
            color: '#ffffff',
            padding: '10px 20px',
            borderRadius: 24,
            fontSize: 13,
            fontWeight: 500,
            fontFamily: FONT,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
            zIndex: 9999,
            pointerEvents: 'none',
            animation: 'screen-in 0.2s ease',
          }}
        >
          กดอีกครั้งเพื่อออกจากแอป
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@300;400;500;600;700&family=Noto+Sans+Thai:wght@300;400;500;600;700&display=swap');
        
        @keyframes slideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        
        @keyframes screen-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        .screen-enter {
          animation: screen-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Glassmorphism Card Hover/Active Scale Effect */
        .glass-card {
          background: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.9);
          box-shadow: 0 4px 20px rgba(16, 185, 129, 0.05);
          border-radius: 16px;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .glass-card:active {
          transform: scale(0.97);
        }

        * {
          -webkit-font-smoothing: antialiased;
        }
      `}</style>
    </div>
  );
}
