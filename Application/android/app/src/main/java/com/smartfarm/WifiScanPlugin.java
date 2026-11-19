package com.smartfarm;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@CapacitorPlugin(
    name = "WifiScan",
    permissions = {
        @Permission(
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_WIFI_STATE
            },
            alias = "location"
        )
    }
)
public class WifiScanPlugin extends Plugin {

    @PluginMethod
    public void scan24GNetworks(PluginCall call) {
        Context context = getContext();
        WifiManager wifiManager = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);

        if (wifiManager == null) {
            call.reject("WifiManager is not available on this device");
            return;
        }

        try {
            // Check Location permission
            if (ActivityCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                requestPermissionForAlias("location", call, "locationPermsCallback");
                return;
            }

            // Start hardware scan
            try {
                wifiManager.startScan();
            } catch (Exception ignored) {
                // Throttled or background exception
            }

            // Get real hardware scan results from the phone
            List<ScanResult> results = wifiManager.getScanResults();
            if (results == null) {
                results = new ArrayList<>();
            }

            // Filter strictly 2.4GHz: frequency < 3000 MHz (2412-2484 MHz) and deduplicate SSIDs
            Map<String, ScanResult> filteredMap = new HashMap<>();

            for (ScanResult sr : results) {
                if (sr.SSID == null || sr.SSID.trim().isEmpty()) {
                    continue;
                }
                // Only 2.4GHz
                if (sr.frequency < 3000) {
                    ScanResult existing = filteredMap.get(sr.SSID);
                    if (existing == null || sr.level > existing.level) {
                        filteredMap.put(sr.SSID, sr);
                    }
                }
            }

            List<ScanResult> sortedList = new ArrayList<>(filteredMap.values());
            Collections.sort(sortedList, new Comparator<ScanResult>() {
                @Override
                public int compare(ScanResult a, ScanResult b) {
                    return Integer.compare(b.level, a.level); // Strongest first
                }
            });

            // Read current connected WiFi SSID
            String currentSsid = "";
            try {
                WifiInfo info = wifiManager.getConnectionInfo();
                if (info != null && info.getSSID() != null) {
                    currentSsid = info.getSSID().replace("\"", "");
                    if ("<unknown ssid>".equalsIgnoreCase(currentSsid)) {
                        currentSsid = "";
                    }
                }
            } catch (Exception ignored) {}

            JSArray netArray = new JSArray();
            for (ScanResult sr : sortedList) {
                JSObject item = new JSObject();
                item.put("ssid", sr.SSID);
                item.put("bssid", sr.BSSID);
                item.put("frequency", sr.frequency);
                item.put("level", sr.level);
                item.put("isCurrent", sr.SSID.equals(currentSsid));
                netArray.put(item);
            }

            JSObject response = new JSObject();
            response.put("networks", netArray);
            response.put("currentSsid", currentSsid);
            response.put("count", sortedList.size());
            call.resolve(response);

        } catch (Exception e) {
            call.reject("Error scanning wifi: " + e.getMessage());
        }
    }

    @PermissionCallback
    private void locationPermsCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            scan24GNetworks(call);
        } else {
            call.reject("Permission ACCESS_FINE_LOCATION denied");
        }
    }
}

