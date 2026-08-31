package com.lingxi.engine;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.nodejs.mobile.NodeJs;

import java.io.File;
import java.net.Socket;

/**
 * 灵犀引擎 - Android 前台服务
 * 
 * 在后台运行 nodejs-mobile 引擎，通过通知栏常驻保持存活。
 * 引擎启动后监听 127.0.0.1:3456，WebView 通过 localhost 连接。
 */
public class EngineService extends Service {

    private static final String TAG = "LingxiEngine";
    private static final String CHANNEL_ID = "lingxi_engine_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final int ENGINE_PORT = 3456;

    private PowerManager.WakeLock wakeLock;
    private Thread engineThread;
    private volatile boolean isRunning = false;
    private static volatile boolean engineReady = false;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "EngineService created");
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "EngineService starting...");

        // 前台服务通知
        Notification notification = buildNotification("引擎启动中...");
        startForeground(NOTIFICATION_ID, notification);

        // WakeLock 防止 CPU 休眠（可选，用户可关闭）
        acquireWakeLock();

        // 启动引擎线程
        if (!isRunning) {
            isRunning = true;
            engineThread = new Thread(this::startEngine, "lingxi-engine-thread");
            engineThread.start();
        }

        return START_STICKY; // 被杀后自动重启
    }

    /**
     * 启动 nodejs-mobile 引擎
     */
    private void startEngine() {
        try {
            // 数据目录：App 内部存储
            File dataDir = new File(getFilesDir(), "lingxi/data");
            if (!dataDir.exists()) dataDir.mkdirs();

            File modelsDir = new File(getFilesDir(), "lingxi/models");
            if (!modelsDir.exists()) modelsDir.mkdirs();

            // 设置环境变量
            String envVars = "LINGXI_DATA_DIR=" + dataDir.getAbsolutePath() + "\n"
                    + "LINGXI_PORT=" + ENGINE_PORT + "\n"
                    + "LINGXI_MOBILE=true\n"
                    + "LINGXI_MODEL_DIR=" + modelsDir.getAbsolutePath() + "\n"
                    + "NODE_ENV=production\n";

            Log.i(TAG, "Starting engine with data dir: " + dataDir.getAbsolutePath());

            // 启动 nodejs-mobile（main.js 是 nodejs-mobile 的入口）
            // lingxi-mobile.js 放在 assets/nodejs-project/ 下
            NodeJs.startWithMainScript(
                    getAssets(),
                    "nodejs-project/lingxi-mobile.js",
                    envVars
            );

            // 等待引擎就绪（轮询端口）
            waitForEngine(30); // 最多等 30 秒

        } catch (Exception e) {
            Log.e(TAG, "Engine start failed", e);
            updateNotification("引擎启动失败: " + e.getMessage());
        }
    }

    /**
     * 轮询等待引擎端口就绪
     */
    private void waitForEngine(int timeoutSeconds) {
        long deadline = System.currentTimeMillis() + timeoutSeconds * 1000L;
        while (System.currentTimeMillis() < deadline) {
            if (isPortOpen(ENGINE_PORT)) {
                engineReady = true;
                Log.i(TAG, "Engine ready on port " + ENGINE_PORT);
                updateNotification("引擎运行中 ✓");
                // 通知 MainActivity
                Intent readyIntent = new Intent("com.lingxi.engine.READY");
                readyIntent.putExtra("port", ENGINE_PORT);
                sendBroadcast(readyIntent);
                return;
            }
            try { Thread.sleep(500); } catch (InterruptedException e) { break; }
        }
        Log.w(TAG, "Engine not ready after " + timeoutSeconds + "s");
        updateNotification("引擎启动超时");
    }

    private boolean isPortOpen(int port) {
        try (Socket socket = new Socket("127.0.0.1", port)) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 引擎是否已就绪（供 MainActivity 查询）
     */
    public static boolean isEngineReady() {
        return engineReady;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "EngineService destroying");
        isRunning = false;
        engineReady = false;
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── 通知 ──

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "灵犀引擎",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("灵犀引擎后台运行通知");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String text) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("灵犀引擎")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_engine)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, buildNotification(text));
        }
    }

    // ── WakeLock ──

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lingxi:engine-wakelock");
            wakeLock.acquire(60 * 60 * 1000L); // 最多 1 小时
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }
}
