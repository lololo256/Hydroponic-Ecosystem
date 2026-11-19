import { registerPlugin } from '@capacitor/core';

export interface ScannedNetwork {
  ssid: string;
  bssid: string;
  frequency: number;
  level: number;
  isCurrent: boolean;
}

export interface WifiScanResult {
  networks: ScannedNetwork[];
  currentSsid: string;
  count: number;
}

export interface WifiScanPluginInterface {
  scan24GNetworks(): Promise<WifiScanResult>;
}

export const WifiScan = registerPlugin<WifiScanPluginInterface>('WifiScan');

