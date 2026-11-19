export type Screen =
  | 'auto-dosing'
  | 'liquid-level'
  | 'pump-control'
  | 'splash'
  | 'welcome'
  | 'onboarding'
  | 'login'
  | 'signup'
  | 'home'
  | 'water-quality'
  | 'ph-detail'
  | 'ec-detail'
  | 'temp-detail'
  | 'farm-status'
  | 'history'
  | 'notifications'
  | 'profile'
  | 'settings'
  | 'device'
  | 'connect-board'
  | 'add-board'
  | 'wifi-setup'
  | 'setup-farm';

export interface NavProps {
  navigate: (screen: Screen, params?: any) => void;
  goBack?: (fallback?: Screen) => void;
  currentScreen: Screen;
  screenParams?: any;
}
