package com.smartfarm;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WifiScanPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
