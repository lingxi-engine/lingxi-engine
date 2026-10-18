package com.lingxi.engine;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
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

import java.util.Locale;

/**
 * 灵犀手机版 —— 账号的遥控器（Remote Controller），不是独立 AI 客户端。
 *
 * 产品定位（重要，勿改）：
 *   手机端本身【不产生任何算力】，App 内不含推理运行时、不含模型权重、不跑工具。
 *   全部智能与算力发生在【引擎所在机器】（你的电脑 / 本地部署 / 云端服务器）上。
 *   手机只是同一账号的投影与遥控器：同一套记忆、同一批智能体、同一个工作区。
 *
 * v1.2.0 起：
 *   - 入口改为 /app/：先登录账号，再在「我的灵犀」里看到云端 + 电脑上的所有引擎；
 *   - 只有【在线且登录了同一账号】的引擎才能一键接管；
 *   - 内置简体中文 / 繁體中文 / English 三语，可随时切换，跟随系统默认。
 */
public class MainActivity extends Activity {

    /** 默认官方云引擎。自部署用户可在「更换引擎地址」里改成自己的。 */
    private static final String DEFAULT_ENDPOINT = "https://lingxi-engine.com";

    /** 手机端入口：App 控制台（登录 + 我的灵犀 + 一键接管）。 */
    private static final String APP_PATH = "/app/";

    private static final String PREF_ENDPOINT = "endpoint";
    private static final String PREF_LANG = "lang";
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
    private Uri cameraOutputUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyLocale(savedLang());
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

        findViewById(R.id.btn_lang).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { promptForLanguage(); }
        });

        // 顶栏整条可点：换引擎（子控件均可点，事件不会穿透，故单独绑）
        findViewById(R.id.topbar).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { promptForEndpoint(); }
        });

        endpointLabel.setText(getSavedEndpoint());
        setStatus(getString(R.string.status_connecting));
        web.loadUrl(appUrl());
    }

    // ---------- 语言 ----------

    private String savedLang() {
        SharedPreferences p = getSharedPreferences("lingxi", Context.MODE_PRIVATE);
        String v = p.getString(PREF_LANG, null);
        if (v != null && (v.equals("zh") || v.equals("zh-TW") || v.equals("en"))) return v;
        Locale l = Locale.getDefault();
        String tag = l.toLanguageTag().toLowerCase(Locale.US);
        if (tag.startsWith("zh")) {
            return (tag.contains("tw") || tag.contains("hk") || tag.contains("hant")) ? "zh-TW" : "zh";
        }
        return tag.startsWith("en") ? "en" : "zh";
    }

    private void applyLocale(String code) {
        Locale locale;
        if ("zh-TW".equals(code)) locale = Locale.TRADITIONAL_CHINESE;
        else if ("en".equals(code)) locale = Locale.US;
        else locale = Locale.SIMPLIFIED_CHINESE;
        Locale.setDefault(locale);
        Configuration cfg = new Configuration(getResources().getConfiguration());
        cfg.setLocale(locale);
        getResources().updateConfiguration(cfg, getResources().getDisplayMetrics());
    }

    private void promptForLanguage() {
        final String[] codes = { "zh", "zh-TW", "en" };
        final String[] labels = {
                getString(R.string.lang_zh),
                getString(R.string.lang_tw),
                getString(R.string.lang_en)
        };
        new AlertDialog.Builder(this)
                .setTitle(R.string.lang_title)
                .setItems(labels, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        String code = codes[which];
                        getSharedPreferences("lingxi", Context.MODE_PRIVATE)
                                .edit().putString(PREF_LANG, code).apply();
                        applyLocale(code);
                        // 重新加载，让原生控件与网页语言同时生效
                        loadingFailed = false;
                        errorPage.setVisibility(View.GONE);
                        recreate();
                    }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    // ---------- WebView 配置 ----------

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
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

        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);

        try {
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        } catch (Throwable ignored) { }

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
                progress.setProgress(newProgress);
                if (newProgress >= 100 && !loadingFailed) {
                    setStatus(getString(R.string.status_connected));
                }
            }

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

        web.setDownloadListener(new DownloadListenerImpl());

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u == null) return false;
                // 站内 + 其它灵犀引擎（/app/ 接管、/m/ 聊天、局域网地址）都留在壳里；
                // 只有真正的外部网站才交给系统浏览器。
                if (shouldKeepInside(u)) return false;
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
                showError(getString(R.string.err_connect, appUrl(),
                        error.getErrorCode(), String.valueOf(error.getDescription())));
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse response) {
                if (request == null || !request.isForMainFrame()) return;
                int code = response == null ? 0 : response.getStatusCode();
                if (code >= 200 && code < 400) return;
                if (code == 404) {
                    showError(getString(R.string.err_404, appUrl()));
                } else {
                    showError(getString(R.string.err_http, appUrl(), code));
                }
            }
        });
    }

    private void showError(String msg) {
        loadingFailed = true;
        errText.setText(msg);
        errorPage.setVisibility(View.VISIBLE);
        setStatus(getString(R.string.status_offline));
    }

    // ---------- 文件选择 ----------

    private boolean openFileChooser(WebChromeClient.FileChooserParams params) {
        try {
            Intent i = params.createIntent();
            i.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(Intent.createChooser(i, getString(R.string.file_chooser)), REQ_FILE_CHOOSER);
            return true;
        } catch (ActivityNotFoundException e) {
            try {
                startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
                return true;
            } catch (Throwable t) {
                Toast.makeText(this, R.string.no_file_picker, Toast.LENGTH_SHORT).show();
                deliverFileResult(null);
                return false;
            }
        } catch (Throwable t) {
            Toast.makeText(this, R.string.cant_open_picker, Toast.LENGTH_SHORT).show();
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

    // ---------- 下载 ----------

    private class DownloadListenerImpl implements android.webkit.DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimetype, long contentLength) {
            if (url == null || url.isEmpty()) return;
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
                Toast.makeText(MainActivity.this, R.string.download_on_pc, Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void openExternally(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Throwable t) {
            Toast.makeText(this, R.string.no_app, Toast.LENGTH_SHORT).show();
        }
    }

    // ---------- 引擎地址管理 ----------

    /** App 控制台完整地址（带语言参数，网页与原生态保持一致）。 */
    private String appUrl() {
        String base = getSavedEndpoint() + APP_PATH;
        String sep = base.contains("?") ? "&" : "?";
        return base + sep + "lang=" + savedLang();
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
            Toast.makeText(this, R.string.endpoint_empty, Toast.LENGTH_SHORT).show();
            return;
        }
        getSharedPreferences("lingxi", Context.MODE_PRIVATE)
                .edit().putString(PREF_ENDPOINT, v).apply();
        endpointLabel.setText(v);
    }

    private static String normalize(String raw) {
        String v = raw == null ? "" : raw.trim();
        if (v.isEmpty()) return "";
        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://" + v;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    private void promptForEndpoint() {
        final EditText input = new EditText(this);
        input.setText(getSavedEndpoint());
        input.setSingleLine(true);
        input.setHint(R.string.endpoint_hint);

        new AlertDialog.Builder(this)
                .setTitle(R.string.choose_engine)
                .setMessage(R.string.choose_engine_msg)
                .setView(input)
                .setPositiveButton(R.string.connect, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        String before = getSavedEndpoint();
                        saveEndpoint(input.getText().toString());
                        String after = getSavedEndpoint();
                        if (!after.equals(before)) {
                            try { web.clearCache(true); } catch (Throwable ignored) { }
                            try { CookieManager.getInstance().removeAllCookies(null); } catch (Throwable ignored) { }
                        }
                        loadingFailed = false;
                        errorPage.setVisibility(View.GONE);
                        Toast.makeText(MainActivity.this, R.string.engine_switched, Toast.LENGTH_SHORT).show();
                        reload();
                    }
                })
                .setNeutralButton(R.string.restore_cloud, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        getSharedPreferences("lingxi", Context.MODE_PRIVATE).edit()
                                .remove(PREF_ENDPOINT).apply();
                        endpointLabel.setText(DEFAULT_ENDPOINT);
                        try { web.clearCache(true); } catch (Throwable ignored) { }
                        try { CookieManager.getInstance().removeAllCookies(null); } catch (Throwable ignored) { }
                        loadingFailed = false;
                        errorPage.setVisibility(View.GONE);
                        reload();
                    }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    /**
     * 是否留在 App 内打开。
     * 关键场景：手机在云端 App 页点「接管」，会跳到另一台引擎的
     * /app/connect 与 /m/ —— 那是另一个 origin，不能用「同一个引擎」判断，
     * 否则会被当成外链踢到浏览器，接管直接断掉。
     */
    private boolean shouldKeepInside(Uri u) {
        if (isSameEngine(u)) return true;
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.US);
        if (!scheme.equals("http") && !scheme.equals("https")) return false;
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.US);
        boolean privateHost = host.equals("localhost") || host.equals("127.0.0.1")
                || host.startsWith("192.168.") || host.startsWith("10.")
                || host.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*");
        if (privateHost) return true;
        String path = u.getPath() == null ? "" : u.getPath();
        return path.equals("/m") || path.startsWith("/m/")
                || path.startsWith("/app")
                || path.startsWith("/chat")
                || path.equals("/login") || path.equals("/register")
                || path.equals("/login.html") || path.equals("/register.html");
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
        setStatus(getString(R.string.status_connecting));
        loadingFailed = false;
        web.loadUrl(appUrl());
    }

    private void setStatus(String s) {
        statusBar.setText(s);
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
        new AlertDialog.Builder(this)
                .setTitle(R.string.exit_title)
                .setMessage(R.string.exit_msg)
                .setPositiveButton(R.string.exit, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) { finish(); }
                })
                .setNegativeButton(R.string.stay, null)
                .show();
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
