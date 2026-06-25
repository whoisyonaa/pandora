package com.pandora.passwords;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PandoraDiscoveryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
