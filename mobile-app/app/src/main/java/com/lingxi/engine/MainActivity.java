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
import android.net.wifi.WifiManager;
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

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 灵犀手机版 —— 账号的遥控器（Remote Controller），不是独立 AI 客户端。
 *
 * 产品定位（重要，勿改）：
 *   手机端本身【不产生任何算力】，App 内不含推理运行时、不含模型权重、不跑工具。
 *   全部智能与算力发生在【引擎所在机器】（你的电脑 / 本地部署 / 自部署服务器）上。
 *   手机只是同一账号的投影与遥控器：同一套记忆、同一批智能体、同一个工作区。
 *
 * v1.4.0 起（自动发现）：
 *   - 首次启动自动扫描局域网：UDP 3457 灯塔监听 + 本网段 3456 端口快速探测，
 *     找到引擎后一键连接，不再要求用户手抄 IP；
 *   - 手动输入地址保留为兜底；
 *   - 内置简体中文 / 繁體中文 / English 三语，可随时切换，跟随系统默认。
 *
 * v1.5.0 起（自部署模型）：
 *   - 移除「官方连接 Hub」入口：不再默认连接任何官方共享云端。
 *     各自部署各自的灵犀（本地电脑 / 自己的云服务器），各自登录各自的实例；
 *   - 改为「我的云端」入口：填入你自己的云端灵犀地址，登录与电脑相同的账号后，
 *     「我的灵犀」自动列出名下所有在线引擎，人在外面也能一键接管家里电脑；
 *   - 官网只提供下载与部署指南，不提供共享算力。
 */
public class MainActivity extends Activity {

    /** v1.5.0: 「我的云端」地址存储键 —— 用户自己的云端灵犀，无官方共享云。 */
    private static final String PREF_MY_CLOUD = "myCloud";

    /** 手机端入口：App 控制台（登录 + 我的灵犀 + 一键接管）。 */
    private static final String APP_PATH = "/app/";

    /** 引擎局域网灯塔端口（与 src/net/lan-discovery.ts 保持一致）。 */
    private static final int DISCOVERY_UDP_PORT = 3457;
    private static final int ENGINE_HTTP_PORT = 3456;

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
    private volatile boolean discovering = false;

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

        String ep = getSavedEndpoint();
        endpointLabel.setText(ep.isEmpty() ? getString(R.string.endpoint_unset) : ep);
        if (ep.isEmpty()) {
            showSetupGuide();
            startDiscovery();
        } else {
            setStatus(getString(R.string.status_connecting));
            web.loadUrl(appUrl());
        }
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

    // ---------- 局域网自动发现（v1.4.0） ----------

    /** 一条发现结果：endpoint + 展示名。 */
    private static final class Found {
        final String endpoint;
        final String label;
        Found(String endpoint, String label) { this.endpoint = endpoint; this.label = label; }
    }

    /**
     * 首次启动自动搜索：
     *   ① UDP 3457 被动监听引擎灯塔（引擎每 3s 广播一次，听 4.2s 必能收到）；
     *   ② 同时对本机所在 /24 网段的 3456 端口做快速 TCP 探测 + /api/health 校验，
     *      兜底广播被路由器/访客网络隔离的场景。
     * 两路并行，总耗时约 5s，结束后弹选择框。
     */
    private void startDiscovery() {
        if (discovering) return;
        discovering = true;
        setStatus(getString(R.string.status_scanning));
        final List<Found> found = Collections.synchronizedList(new ArrayList<Found>());

        final Thread udp = new Thread(new Runnable() {
            @Override public void run() { listenBeacons(found, 4200); }
        }, "lingxi-udp-discovery");
        udp.setDaemon(true);
        udp.start();

        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    scanSubnet(found);
                    udp.join(4600);
                } catch (Throwable ignored) { }
                final List<Found> merged = dedupe(found);
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        discovering = false;
                        // 扫描期间用户可能已手动设置了地址，那就别再弹框
                        if (!getSavedEndpoint().isEmpty()) return;
                        showDiscoveredDialog(merged);
                    }
                });
            }
        }, "lingxi-discovery").start();
    }

    /** ① UDP 灯塔监听：解析 lingxi-beacon JSON，提取引擎地址与版本。 */
    private void listenBeacons(List<Found> found, long windowMs) {
        WifiManager.MulticastLock lock = null;
        DatagramSocket socket = null;
        try {
            try {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    lock = wm.createMulticastLock("lingxi-discovery");
                    lock.setReferenceCounted(false);
                    lock.acquire();
                }
            } catch (Throwable ignored) { }

            socket = new DatagramSocket(null);
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress(DISCOVERY_UDP_PORT));
            socket.setSoTimeout(400);
            long deadline = System.currentTimeMillis() + windowMs;
            byte[] buf = new byte[8192];
            List<String> myIps = localIpv4s();
            while (System.currentTimeMillis() < deadline) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try { socket.receive(p); } catch (Throwable t) { continue; }
                try {
                    String s = new String(p.getData(), p.getOffset(), p.getLength(), "UTF-8");
                    JSONObject b = new JSONObject(s);
                    if (!"lingxi-beacon".equals(b.optString("type"))) continue;
                    if (b.optInt("proto", 0) != 1) continue;
                    int port = b.optInt("port", ENGINE_HTTP_PORT);
                    String ip = pickBeaconIp(b, myIps, p.getAddress().getHostAddress());
                    if (ip == null || ip.isEmpty()) continue;
                    String version = b.optString("version", "");
                    String who = "";
                    JSONArray users = b.optJSONArray("users");
                    if (users != null && users.length() > 0) {
                        who = users.optJSONObject(0) != null ? users.optJSONObject(0).optString("displayName", "") : "";
                    }
                    String label = (who.isEmpty() ? getString(R.string.engine_generic) : who)
                            + (version.isEmpty() ? "" : " · v" + version);
                    found.add(new Found("http://" + ip + ":" + port, label));
                } catch (Throwable ignored) { }
            }
        } catch (Throwable ignored) {
            // UDP 端口被占用/无权限时静默降级，TCP 扫描兜底
        } finally {
            try { if (socket != null) socket.close(); } catch (Throwable ignored) { }
            try { if (lock != null && lock.isHeld()) lock.release(); } catch (Throwable ignored) { }
        }
    }

    /** 灯塔里可能带多个网卡地址：优先选与手机同网段的，其次 beacon.lanIp，最后包来源地址。 */
    private static String pickBeaconIp(JSONObject b, List<String> myIps, String srcAddr) {
        JSONArray ips = b.optJSONArray("lanIps");
        if (ips != null) {
            for (int i = 0; i < ips.length(); i++) {
                String ip = ips.optString(i, "");
                if (ip.isEmpty() || ip.startsWith("127.")) continue;
                String pre = subnetPrefix(ip);
                for (String my : myIps) {
                    if (subnetPrefix(my).equals(pre)) return ip;
                }
            }
        }
        String lanIp = b.optString("lanIp", "");
        if (!lanIp.isEmpty() && !lanIp.startsWith("127.") && !lanIp.equals("0.0.0.0")) return lanIp;
        return srcAddr;
    }

    private static String subnetPrefix(String ip) {
        int i = ip.lastIndexOf('.');
        return i > 0 ? ip.substring(0, i) : ip;
    }

    /** ② 本网段 /24 快速 TCP 扫描：3456 端口连通后再用 /api/health 确认是灵犀引擎。 */
    private void scanSubnet(List<Found> found) {
        List<String> myIps = localIpv4s();
        if (myIps.isEmpty()) return;
        ExecutorService pool = Executors.newFixedThreadPool(64);
        try {
            for (String my : myIps) {
                final String pre = subnetPrefix(my);
                for (int h = 1; h <= 254; h++) {
                    final String ip = pre + "." + h;
                    if (ip.equals(my)) continue;
                    pool.submit(new Runnable() {
                        @Override public void run() {
                            Socket sock = null;
                            try {
                                sock = new Socket();
                                sock.connect(new InetSocketAddress(ip, ENGINE_HTTP_PORT), 350);
                                sock.close();
                                sock = null;
                                String version = healthCheck(ip);
                                if (version != null) {
                                    found.add(new Found("http://" + ip + ":" + ENGINE_HTTP_PORT,
                                            getString(R.string.engine_generic) + (version.isEmpty() ? "" : " · v" + version)));
                                }
                            } catch (Throwable ignored) {
                            } finally { try { if (sock != null) sock.close(); } catch (Throwable ignored) { } }
                        }
                    });
                }
            }
            pool.shutdown();
            pool.awaitTermination(6, TimeUnit.SECONDS);
        } catch (Throwable ignored) {
        } finally { try { pool.shutdownNow(); } catch (Throwable ignored) { } }
    }

    /** GET /api/health：200 且 JSON 含 ok 字段才认定是灵犀引擎；返回版本号（可能为空串）。 */
    private static String healthCheck(String ip) {
        HttpURLConnection c = null;
        try {
            URL u = new URL("http://" + ip + ":" + ENGINE_HTTP_PORT + "/api/health");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            c.setRequestMethod("GET");
            if (c.getResponseCode() != 200) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) { sb.append(line); if (sb.length() > 4096) break; }
            r.close();
            JSONObject j = new JSONObject(sb.toString());
            if (!j.has("ok")) return null;
            return j.optString("version", "");
        } catch (Throwable t) {
            return null;
        } finally { try { if (c != null) c.disconnect(); } catch (Throwable ignored) { } }
    }

    /** 本机全部非回环 IPv4（Wi-Fi / 热点 / 以太网都算）。 */
    private static List<String> localIpv4s() {
        List<String> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a instanceof Inet4Address && !a.isLoopbackAddress() && a.isSiteLocalAddress()) {
                        String ip = a.getHostAddress();
                        if (ip != null && !out.contains(ip)) out.add(ip);
                    }
                }
            }
        } catch (Throwable ignored) { }
        return out;
    }

    private static List<Found> dedupe(List<Found> in) {
        Map<String, Found> map = new LinkedHashMap<>();
        synchronized (in) {
            for (Found f : in) if (!map.containsKey(f.endpoint)) map.put(f.endpoint, f);
        }
        return new ArrayList<>(map.values());
    }

    /** 扫描结果选择框：发现的引擎 + 我的云端 + 手动输入。 */
    private void showDiscoveredDialog(final List<Found> engines) {
        final List<String> items = new ArrayList<>();
        for (Found f : engines) items.add("\uD83D\uDCBB " + f.label + "\n" + f.endpoint);
        items.add(getString(R.string.option_hub));
        items.add(getString(R.string.option_manual));

        String title = engines.isEmpty() ? getString(R.string.none_found_title) : getString(R.string.found_title);
        String msg = engines.isEmpty() ? getString(R.string.none_found_msg) : getString(R.string.found_msg);

        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(msg)
                .setItems(items.toArray(new String[0]), new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        if (which < engines.size()) {
                            connectTo(engines.get(which).endpoint);
                        } else if (which == engines.size()) {
                            promptForMyCloud();
                        } else {
                            promptForEndpoint();
                        }
                    }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    /** 保存地址并加载（切换 origin 时清缓存与 Cookie，避免串登录态）。 */
    private void connectTo(String endpoint) {
        String before = getSavedEndpoint();
        saveEndpoint(endpoint);
        String after = getSavedEndpoint();
        if (after.isEmpty()) return;
        if (!after.equals(before)) {
            try { web.clearCache(true); } catch (Throwable ignored) { }
            try { CookieManager.getInstance().removeAllCookies(null); } catch (Throwable ignored) { }
        }
        loadingFailed = false;
        errorPage.setVisibility(View.GONE);
        Toast.makeText(this, R.string.engine_switched, Toast.LENGTH_SHORT).show();
        reload();
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
                } else if (code == 410) {
                    showError(getString(R.string.err_410, appUrl()));
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
        if (v == null || v.trim().isEmpty()) return "";
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
                        connectTo(input.getText().toString());
                    }
                })
                .setNeutralButton(R.string.hub_short, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) { promptForMyCloud(); }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    /** v1.5.0: 「我的云端」—— 填入自己部署的云端灵犀地址，保存后记住。 */
    private void promptForMyCloud() {
        final EditText input = new EditText(this);
        SharedPreferences p = getSharedPreferences("lingxi", Context.MODE_PRIVATE);
        input.setText(p.getString(PREF_MY_CLOUD, ""));
        input.setSingleLine(true);
        input.setHint(R.string.mycloud_hint);

        new AlertDialog.Builder(this)
                .setTitle(R.string.mycloud_title)
                .setMessage(R.string.mycloud_msg)
                .setView(input)
                .setPositiveButton(R.string.connect, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        String v = normalize(input.getText().toString());
                        if (v.isEmpty()) {
                            Toast.makeText(MainActivity.this, R.string.endpoint_empty, Toast.LENGTH_SHORT).show();
                            return;
                        }
                        getSharedPreferences("lingxi", Context.MODE_PRIVATE)
                                .edit().putString(PREF_MY_CLOUD, v).apply();
                        connectTo(v);
                    }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    /**
     * 是否留在 App 内打开。
     * 关键场景：手机在 Hub App 页点「接管」，会跳到另一台引擎的
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
        loadingFailed = false;
        if (getSavedEndpoint().isEmpty()) {
            showSetupGuide();
            startDiscovery();
            return;
        }
        errorPage.setVisibility(View.GONE);
        setStatus(getString(R.string.status_connecting));
        web.loadUrl(appUrl());
    }

    /** 首次使用 / 未设置地址时的引导页（自动扫描进行中，顶栏按钮可手动设置）。 */
    private void showSetupGuide() {
        loadingFailed = true;
        errText.setText(R.string.setup_needed);
        errorPage.setVisibility(View.VISIBLE);
        setStatus(getString(R.string.status_scanning));
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
