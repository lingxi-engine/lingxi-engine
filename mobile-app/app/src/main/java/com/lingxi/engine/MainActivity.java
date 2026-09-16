package com.lingxi.engine;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * 灵犀引擎手机版（v1 壳模式）
 * WebView 直连官网移动端引擎入口 http://47.93.157.83/m/
 * （站点服务器将 /m/ 剥前缀代理到引擎，/api 与 /ws 走根层代理，流式与实时消息全通）。
 * 主文档加载失败时显示本地错误页 + 重试按钮；返回键先走网页历史。
 */
public class MainActivity extends Activity {
    private static final String HOME_URL = "http://47.93.157.83/m/";

    private WebView web;
    private ProgressBar progress;
    private View errorPage;
    private TextView errText;
    private boolean loadingFailed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = (WebView) findViewById(R.id.web);
        progress = (ProgressBar) findViewById(R.id.progress);
        errorPage = findViewById(R.id.error_page);
        errText = (TextView) findViewById(R.id.err_text);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
                progress.setProgress(newProgress);
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loadingFailed) errorPage.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    loadingFailed = true;
                    errorPage.setVisibility(View.VISIBLE);
                    errText.setText("无法连接到灵犀服务器\n(" + error.getErrorCode() + ") " + error.getDescription());
                }
            }
        });

        Button retry = (Button) findViewById(R.id.btn_retry);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadingFailed = false;
                errorPage.setVisibility(View.GONE);
                web.loadUrl(HOME_URL);
            }
        });

        web.loadUrl(HOME_URL);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() { super.onPause(); if (web != null) web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); if (web != null) web.onResume(); }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
