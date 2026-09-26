package com.omni2d.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The page scales its own viewport at start-up so that one CSS pixel
        // covers a whole number of screen pixels (www/js/pixelScale.js) --
        // the only way pixel art stays hard-edged on a screen whose pixel
        // ratio is fractional. A WebView ignores the page's viewport tag
        // unless it is told to honour it.
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().getSettings().setUseWideViewPort(true);
        }
    }
}
