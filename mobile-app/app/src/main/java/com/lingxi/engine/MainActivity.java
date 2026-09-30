package com.lingxi.engine;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.util.Locale;

/**
 * 灵犀引擎手机版 —— 远程遥控器（Remote Controller），不是独立 AI 客户端。
 *
 * 产品定位（重要，勿改）：
 *   手机端本身【不产生任何算力】。App 内不含任何推理运行时，不含模型权重，不跑工具。
 *   全部智能与算力发生在【引擎所在机器】（你的电脑 / 本地部署 / 云端服务器）上。
 *   手机只是同一账号的投影与遥控器：同一套记忆、同一批智能体、同一个工作区、
 *   同一批正在运行的长任务、同一批工具能力。
 *
 *   因此：
 *   - 必须用【同一个账号】登录，否则连到的是另一个引擎；
 *   - 可以指向官方云引擎，也可以指向你自己在家/公司电脑上跑的引擎；
 *   - 换地址 = 换引擎，不是换 App。
 *
 * 实现方式：WebView 承载引擎移动页 /m/，引擎地址可由用户填写并持久化。
 */
public class MainActivity extends Activity {

    private static final String TAG = "LingxiRemote";

    /** 默认官方云引擎。自部署用户可在「更换引擎地址」里改成自己的。 */
    private static final String DEFAULT_ENDPOINT = "http://<SERVER_IP>";

    /** 引擎移动端入口。手机端一律走 /m/，保证拿到的是移动版界面。 */
    private static final String MOBILE_PATH = "/m/";

    private static final String PREF_ENDPOINT = "endpoint";
    private static final int REQ_FILE_CHOOSER = 1001;

    private WebView web;
    private ProgressBar progress;
    private View errorPage;
    private TextView errText;
    private TextView endpointLabel;
    private TextView statusBar;
    private boolean loadingFailed = false;

    /** WebView 发起的文件选择回调；非 null 时说明有一次待处理的选择在飞。 */
    private ValueCallback<Uri[]> pendingFileCallback;
    /** 承接 onShowFileChooser 返回结果的目标 Uri。 */
    private Uri cameraOutputUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web           = (WebView) findViewById(R.id.web);
        progress      = (ProgressBar) findViewById(R.id.progress);
        errorPage     = findViewById(R.id.error_page);
        errText       = (TextView) findViewById(R.id.err_text);
        endpointLabel = (TextView) findViewById(R.id.endpoint);
        statusBar     = (TextView) findViewById(R.id.statusbar);

        configureWebView();

        Button retry = (Button) findViewById(R.id.btn_retry);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadingFailed = false;
                errorPage.setVisibility(View.GONE);
                reload();
            }
        });

        Button settings = (Button) findViewById(R.id.btn_settings);
        settings.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { promptForEndpoint(); }
        });

        findViewById(R.id.btn_refresh).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadingFailed = false;
                errorPage.setVisibility(View.GONE);
                reload();
            }
        });

        // 顶栏整条可点：点哪儿都能换引擎（子控件均非 clickable，事件穿透到父容器）
        findViewById(R.id.topbar).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { promptForEndpoint(); }
        });

        endpointLabel.setText(shorten(getSavedEndpoint()));
        setStatus("正在连接引擎…");
        web.loadUrl(mobileUrl());
    }

    // ---------- WebView 配置 ----------

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 引擎前端状态、会话标记
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);

        // 混合内容：自部署常用 http://192.168.x.x 内网地址
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // 文件选择走系统选择器（见 onShowFileChooser），不开 file:// 直读
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);

        // 第三方 Cookie：保证同一账号会话在壳内稳定
        try {
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        } catch (Throwable ignored) { }

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
                progress.setProgress(newProgress);
                if (newProgress >= 100 && !loadingFailed) {
                    setStatus("已连接 · 算力运行在引擎端（你的电脑或云端）");
                }
            }

            /**
             * 文件上传：手机端选文件交给引擎处理。
             * 缺这个回调，WebView 会静默取消选择 —— 用户表现为「点了附件没反应」。
             */
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                return openFileChooser(params);
            }

            /** 允许网页申请相机/麦克风权限（语音输入、拍照识图）。 */
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                try {
                    request.grant(request.getResources());
                } catch (Throwable t) {
                    try { request.deny(); } catch (Throwable ignored) { }
                }
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                try { request.deny(); } catch (Throwable ignored) { }
            }
        });

        // 引擎导出文件 / 下载 APK 时不丢在 WebView 里
        web.setDownloadListener(new DownloadListenerImpl());

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u == null) return false;
                if (isSameEngine(u)) return false;
                // 站内留在 WebView；外链交给系统浏览器，避免卡在壳里出不去
                openExternally(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loadingFailed) errorPage.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                showError("连不上这台引擎\n\n地址：" + mobileUrl()
                        + "\n\n(" + error.getErrorCode() + ") " + error.getDescription()
                        + "\n\n· 手机和引擎要在同一网络，或引擎已开放公网地址"
                        + "\n· 确认引擎已启动并在监听端口"
                        + "\n· 顶栏点一下可以更换引擎地址");
            }

            /** 引擎活着但返回 5xx/404 时也要给提示，否则用户对着白屏发呆。 */
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse response) {
                if (request == null || !request.isForMainFrame()) return;
                int code = response == null ? 0 : response.getStatusCode();
                if (code >= 200 && code < 400) return;
                if (code == 404) {
                    showError("这台引擎上没有手机版页面\n\n地址：" + mobileUrl()
                            + "\n\n(HTTP 404)"
                            + "\n\n· 这台引擎可能不是灵犀引擎，或版本太老"
                            + "\n· 请到引擎根地址确认一下，再重试");
                } else {
                    showError("引擎返回了错误\n\n地址：" + mobileUrl()
                            + "\n\n(HTTP " + code + ")"
                            + "\n\n· 引擎服务可能正在重启，稍后重试");
                }
            }
        });
    }

    private void showError(String msg) {
        loadingFailed = true;
        errText.setText(msg);
        errorPage.setVisibility(View.VISIBLE);
        setStatus("未连接");
    }

    // ---------- 文件选择 ----------

    private boolean openFileChooser(WebChromeClient.FileChooserParams params) {
        try {
            Intent i = params.createIntent();
            i.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(Intent.createChooser(i, "选择要交给引擎的文件"), REQ_FILE_CHOOSER);
            return true;
        } catch (ActivityNotFoundException e) {
            try {
                startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
                return true;
            } catch (Throwable t) {
                Toast.makeText(this, "这台手机没有可用的文件选择器", Toast.LENGTH_SHORT).show();
                deliverFileResult(null);
                return false;
            }
        } catch (Throwable t) {
            Toast.makeText(this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
            deliverFileResult(null);
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE_CHOOSER) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) {
                    result[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                result = new Uri[]{ data.getData() };
            }
        }
        deliverFileResult(result);
    }

    private void deliverFileResult(Uri[] result) {
        if (pendingFileCallback == null) return;
        ValueCallback<Uri[]> cb = pendingFileCallback;
        pendingFileCallback = null;
        try { cb.onReceiveValue(result); } catch (Throwable ignored) { }
    }

    // ---------- 下载（引擎导出文件 / APK） ----------

    private class DownloadListenerImpl implements android.webkit.DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimetype, long contentLength) {
            if (url == null || url.isEmpty()) return;
            // 二进制/安装包类不落地，直接交给系统浏览器或下载器更稳
            try {
                Uri u = Uri.parse(url);
                String mime = mimetype == null ? "" : mimetype.toLowerCase(Locale.US);
                if (mime.contains("apk") || mime.contains("android")
                        || url.endsWith(".apk") || url.endsWith(".zip")) {
                    openExternally(u);
                    return;
                }
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Throwable t) {
                Toast.makeText(MainActivity.this, "这个文件需要到电脑上下载", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void openExternally(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Throwable t) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("about:blank")));
            } catch (Throwable ignored) { }
            Toast.makeText(this, "没有能打开该链接的应用", Toast.LENGTH_SHORT).show();
        }
    }

    // ---------- 引擎地址管理 ----------

    /** 引擎移动端完整地址。换引擎后所有页面都从这个入口进。 */
    private String mobileUrl() {
        return getSavedEndpoint() + MOBILE_PATH;
    }

    private String getSavedEndpoint() {
        SharedPreferences p = getSharedPreferences("lingxi", Context.MODE_PRIVATE);
        String v = p.getString(PREF_ENDPOINT, null);
        if (v == null || v.trim().isEmpty()) return DEFAULT_ENDPOINT;
        return normalize(v);
    }

    private void saveEndpoint(String raw) {
        String v = normalize(raw);
        if (v.isEmpty()) {
            Toast.makeText(this, "地址不能为空", Toast.LENGTH_SHORT).show();
            return;
        }
        getSharedPreferences("lingxi", Context.MODE_PRIVATE)
                .edit().putString(PREF_ENDPOINT, v).apply();
        endpointLabel.setText(shorten(v));
    }

    private static String normalize(String raw) {
        String v = raw == null ? "" : raw.trim();
        if (v.isEmpty()) return "";
        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://" + v;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    /** 让用户填写自己那台引擎的地址（云端公网地址或内网 IP）。 */
    private void promptForEndpoint() {
        final EditText input = new EditText(this);
        input.setText(getSavedEndpoint());
        input.setSingleLine(true);
        input.setHint("例如 http://192.168.1.10:3456 或 https://你的域名");

        new AlertDialog.Builder(this)
                .setTitle("选择要遥控的引擎")
                .setMessage("填你电脑 / 云端上那台灵犀引擎的地址。\n"
                        + "换一个地址就是换一个引擎，请用同一账号登录。\n\n"
                        + "手机不产生算力，这里填的机器才是真正干活的。")
                .setView(input)
                .setPositiveButton("连接", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) {
                        String before = getSavedEndpoint();
                        saveEndpoint(input.getText().toString());
                        String after = getSavedEndpoint();
                        if (!after.equals(before)) {
                            // 换引擎 = 换一套会话，清干净免得串号
                            try { web.clearCache(true); } catch (Throwable ignored) { }
                            try { CookieManager.getInstance().removeAllCookies(null); } catch (Throwable ignored) { }
                        }
                        loadingFailed = false;
                        errorPage.setVisibility(View.GONE);
                        Toast.makeText(MainActivity.this, "已切换引擎", Toast.LENGTH_SHORT).show();
                        reload();
                    }
                })
                .setNeutralButton("恢复官方云端", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) {
                        getSharedPreferences("lingxi", Context.MODE_PRIVATE).edit()
                                .remove(PREF_ENDPOINT).apply();
                        endpointLabel.setText(shorten(DEFAULT_ENDPOINT));
                        try { web.clearCache(true); } catch (Throwable ignored) { }
                        try { CookieManager.getInstance().removeAllCookies(null); } catch (Throwable ignored) { }
                        loadingFailed = false;
                        errorPage.setVisibility(View.GONE);
                        reload();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /**
     * 是否属于同一台引擎 —— 必须同时比 host 和 port。
     * 只比 host 的话，192.168.1.10:3456（引擎）和 192.168.1.10:8080（路由器后台）
     * 会被误判为站内，链接会卡在壳里打不开。
     */
    private boolean isSameEngine(Uri u) {
        try {
            Uri base = Uri.parse(getSavedEndpoint());
            String h1 = String.valueOf(u.getHost());
            String h2 = String.valueOf(base.getHost());
            if (!h1.equalsIgnoreCase(h2)) return false;
            int p1 = u.getPort();
            int p2 = base.getPort();
            if (p1 == -1) p1 = defaultPort(u.getScheme());
            if (p2 == -1) p2 = defaultPort(base.getScheme());
            return p1 == p2;
        } catch (Throwable e) {
            return false;
        }
    }

    private static int defaultPort(String scheme) {
        return "https".equalsIgnoreCase(scheme) ? 443 : 80;
    }

    private void reload() {
        setStatus("正在连接引擎…");
        loadingFailed = false;
        web.loadUrl(mobileUrl());
    }

    private void setStatus(String s) {
        statusBar.setText(s);
    }

    private static String shorten(String s) {
        if (s == null) return "";
        String t = s.replaceFirst("^https?://", "");
        if (t.length() > 22) t = t.substring(0, 10) + "…" + t.substring(t.length() - 8);
        return t;
    }

    // ---------- 生命周期 ----------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // 已经在引擎首页：二次确认，避免误触直接退出遥控台
        new AlertDialog.Builder(this)
                .setTitle("退出灵犀引擎？")
                .setMessage("引擎端的任务不会停止，只是断开遥控。")
                .setPositiveButton("退出", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) { finish(); }
                })
                .setNegativeButton("留在引擎", null)
                .show();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        // 有一次文件选择在飞时必须回调，否则引擎端会一直卡在「上传中」
        deliverFileResult(null);
        if (web != null) {
            try { web.stopLoading(); } catch (Throwable ignored) { }
            try { web.loadUrl("about:blank"); } catch (Throwable ignored) { }
            try { web.destroy(); } catch (Throwable ignored) { }
            web = null;
        }
        super.onDestroy();
    }
}
