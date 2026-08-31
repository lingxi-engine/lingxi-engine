package com.lingxi.engine;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * 灵犀引擎 - Android 主 Activity
 * 
 * 基于 Capacitor BridgeActivity，启动时：
 * 1. 启动 EngineService（nodejs-mobile 引擎）
 * 2. 等待引擎就绪（127.0.0.1:3456）
 * 3. WebView 加载前端 UI
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "LingxiMain";
    private static final int ENGINE_PORT = 3456;

    private BroadcastReceiver engineReadyReceiver;
    private boolean engineStarted = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "MainActivity onCreate");

        // 注册引擎就绪广播
        engineReadyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if ("com.lingxi.engine.READY".equals(intent.getAction())) {
                    int port = intent.getIntExtra("port", ENGINE_PORT);
                    Log.i(TAG, "Engine ready on port " + port);
                    onEngineReady(port);
                }
            }
        };
        registerReceiver(engineReadyReceiver, new IntentFilter("com.lingxi.engine.READY"));

        // 启动引擎服务
        startEngineService();
    }

    /**
     * 启动引擎前台服务
     */
    private void startEngineService() {
        Log.i(TAG, "Starting EngineService...");
        Intent serviceIntent = new Intent(this, EngineService.class);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }

        // 如果引擎已经就绪（服务重启场景），直接加载
        if (EngineService.isEngineReady()) {
            onEngineReady(ENGINE_PORT);
        }
    }

    /**
     * 引擎就绪回调 - 配置 WebView 连接
     */
    private void onEngineReady(int port) {
        if (engineStarted) return;
        engineStarted = true;

        Log.i(TAG, "Loading WebView with engine at port " + port);

        // Capacitor 配置中 server.url 已指向 localhost:3456
        // 这里可以动态修改 WebView URL（如果需要）
        runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.loadUrl("http://127.0.0.1:" + port);
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (engineReadyReceiver != null) {
            unregisterReceiver(engineReadyReceiver);
        }
        super.onDestroy();
    }

    @Override
    protected void onStop() {
        super.onStop();
        // 引擎服务保持运行（前台服务），不随 Activity 停止
    }
}
