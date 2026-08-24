package __PACKAGE_ID__;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends AppCompatActivity {

    private static final String ASSET_DOMAIN = "appassets.androidplatform.net";

    private WebView webView;
    private SwipeRefreshLayout refreshLayout;
    private WebViewAssetLoader assetLoader;

    private ValueCallback<Uri[]> filePathCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;

    private PermissionRequest pendingWebPermission;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    private ActivityResultLauncher<String[]> runtimePermissionLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        refreshLayout = findViewById(R.id.refresh);
        webView = findViewById(R.id.webview);

        registerLaunchers();
        configureWebView();
        configureRefresh();
        configureBackNavigation();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(BuildConfig.START_URL);
        }
    }

    // ---------------------------------------------------------------- setup

    private void registerLaunchers() {
        fileChooserLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                new androidx.activity.result.ActivityResultCallback<ActivityResult>() {
                    @Override
                    public void onActivityResult(ActivityResult result) {
                        if (filePathCallback == null) {
                            return;
                        }
                        Uri[] uris = null;
                        Intent data = result.getData();
                        if (result.getResultCode() == RESULT_OK && data != null) {
                            if (data.getClipData() != null) {
                                int count = data.getClipData().getItemCount();
                                uris = new Uri[count];
                                for (int i = 0; i < count; i++) {
                                    uris[i] = data.getClipData().getItemAt(i).getUri();
                                }
                            } else if (data.getData() != null) {
                                uris = new Uri[]{data.getData()};
                            }
                        }
                        filePathCallback.onReceiveValue(uris);
                        filePathCallback = null;
                    }
                });

        runtimePermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestMultiplePermissions(),
                grants -> {
                    boolean allGranted = !grants.containsValue(Boolean.FALSE);
                    if (pendingWebPermission != null) {
                        if (allGranted) {
                            pendingWebPermission.grant(pendingWebPermission.getResources());
                        } else {
                            pendingWebPermission.deny();
                        }
                        pendingWebPermission = null;
                    }
                    if (pendingGeoCallback != null) {
                        pendingGeoCallback.invoke(pendingGeoOrigin, allGranted, false);
                        pendingGeoCallback = null;
                        pendingGeoOrigin = null;
                    }
                });
    }

    private void configureWebView() {
        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(ASSET_DOMAIN)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(BuildConfig.ALLOW_ZOOM);
        settings.setBuiltInZoomControls(BuildConfig.ALLOW_ZOOM);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new DownloadBridge(), "PackrBridge");
        webView.setWebViewClient(new HostWebViewClient());
        webView.setWebChromeClient(new HostChromeClient());
        webView.setDownloadListener(this::handleDownload);
    }

    private void configureRefresh() {
        if (!BuildConfig.PULL_TO_REFRESH) {
            refreshLayout.setEnabled(false);
            return;
        }
        refreshLayout.setOnRefreshListener(() -> webView.reload());
    }

    private void configureBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }

    // ------------------------------------------------------------- clients

    private class HostWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return assetLoader.shouldInterceptRequest(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();

            // Always hand these to the system.
            if (scheme.equals("tel") || scheme.equals("mailto") || scheme.equals("sms")
                    || scheme.equals("geo") || scheme.equals("whatsapp") || scheme.equals("intent")) {
                return openExternally(uri);
            }

            if (!BuildConfig.EXTERNAL_LINKS_IN_BROWSER) {
                return false;
            }

            if (isInternal(uri)) {
                return false;
            }
            return openExternally(uri);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            refreshLayout.setRefreshing(false);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                                    android.webkit.WebResourceError error) {
            if (!request.isForMainFrame()) {
                return;
            }
            refreshLayout.setRefreshing(false);
            view.loadDataWithBaseURL(null, offlinePage(), "text/html", "UTF-8", null);
        }
    }

    private class HostChromeClient extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;
            try {
                fileChooserLauncher.launch(params.createIntent());
                return true;
            } catch (ActivityNotFoundException e) {
                filePathCallback = null;
                toast(getString(R.string.no_file_picker));
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            java.util.ArrayList<String> needed = new java.util.ArrayList<>();
            for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                    needed.add(Manifest.permission.CAMERA);
                } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                    needed.add(Manifest.permission.RECORD_AUDIO);
                }
            }
            if (needed.isEmpty()) {
                request.grant(request.getResources());
                return;
            }
            if (hasAll(needed)) {
                request.grant(request.getResources());
                return;
            }
            pendingWebPermission = request;
            runtimePermissionLauncher.launch(needed.toArray(new String[0]));
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                                                       GeolocationPermissions.Callback callback) {
            String fine = Manifest.permission.ACCESS_FINE_LOCATION;
            if (ContextCompat.checkSelfPermission(MainActivity.this, fine)
                    == PackageManager.PERMISSION_GRANTED) {
                callback.invoke(origin, true, false);
                return;
            }
            pendingGeoCallback = callback;
            pendingGeoOrigin = origin;
            runtimePermissionLauncher.launch(new String[]{fine});
        }
    }

    // ----------------------------------------------------------- downloads

    private void handleDownload(String url, String userAgent, String contentDisposition,
                                String mimeType, long contentLength) {
        if (url.startsWith("blob:")) {
            webView.evaluateJavascript(blobReaderScript(url, mimeType), null);
            return;
        }
        if (url.startsWith("data:")) {
            saveDataUrl(url, guessName(url, contentDisposition, mimeType));
            return;
        }

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) {
                request.addRequestHeader("Cookie", cookies);
            }
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            request.setTitle(name);
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);

            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            manager.enqueue(request);
            toast(getString(R.string.download_started, name));
        } catch (Exception e) {
            toast(getString(R.string.download_failed));
        }
    }

    /**
     * WebView never streams blob: URLs to DownloadManager, so read the blob inside the page
     * and hand the bytes back through the JS bridge.
     */
    private String blobReaderScript(String blobUrl, String mimeType) {
        return "(function(){"
                + "var xhr=new XMLHttpRequest();"
                + "xhr.open('GET','" + blobUrl + "',true);"
                + "xhr.responseType='blob';"
                + "xhr.onload=function(){"
                + "  if(xhr.status!==200&&xhr.status!==0){return;}"
                + "  var r=new FileReader();"
                + "  r.onloadend=function(){"
                + "    PackrBridge.saveBase64(r.result,'" + (mimeType == null ? "" : mimeType) + "');"
                + "  };"
                + "  r.readAsDataURL(xhr.response);"
                + "};"
                + "xhr.send();"
                + "})();";
    }

    private class DownloadBridge {
        @JavascriptInterface
        public void saveBase64(String dataUrl, String mimeType) {
            runOnUiThread(() -> saveDataUrl(dataUrl, guessName(dataUrl, null, mimeType)));
        }
    }

    private void saveDataUrl(String dataUrl, String fileName) {
        int comma = dataUrl.indexOf(',');
        if (comma < 0) {
            toast(getString(R.string.download_failed));
            return;
        }
        try {
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(bytes, fileName);
            } else {
                saveViaFile(bytes, fileName);
            }
        } catch (Exception e) {
            toast(getString(R.string.download_failed));
        }
    }

    private void saveViaMediaStore(byte[] bytes, String fileName) throws Exception {
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fileName);
        values.put(android.provider.MediaStore.Downloads.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS);
        values.put(android.provider.MediaStore.Downloads.IS_PENDING, 1);

        android.content.ContentResolver resolver = getContentResolver();
        Uri target = resolver.insert(
                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (target == null) {
            toast(getString(R.string.download_failed));
            return;
        }
        try (OutputStream stream = resolver.openOutputStream(target)) {
            if (stream == null) {
                throw new java.io.IOException("no output stream");
            }
            stream.write(bytes);
        }
        values.clear();
        values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(target, values, null, null);
        toast(getString(R.string.download_saved, fileName));
    }

    private void saveViaFile(byte[] bytes, String fileName) throws Exception {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) {
            toast(getString(R.string.download_failed));
            return;
        }
        File out = uniqueFile(dir, fileName);
        try (OutputStream stream = new FileOutputStream(out)) {
            stream.write(bytes);
        }
        toast(getString(R.string.download_saved, out.getName()));
    }

    private File uniqueFile(File dir, String name) {
        File candidate = new File(dir, name);
        if (!candidate.exists()) {
            return candidate;
        }
        String stem = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            stem = name.substring(0, dot);
            ext = name.substring(dot);
        }
        for (int i = 1; i < 1000; i++) {
            candidate = new File(dir, stem + "-" + i + ext);
            if (!candidate.exists()) {
                return candidate;
            }
        }
        return candidate;
    }

    private String guessName(String url, @Nullable String contentDisposition, String mimeType) {
        try {
            String guessed = URLUtil.guessFileName(url, contentDisposition, mimeType);
            if (guessed != null && !guessed.equals("downloadfile.bin")) {
                return guessed;
            }
        } catch (Exception ignored) {
            // fall through
        }
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType);
        return "download-" + System.currentTimeMillis() + (ext == null ? "" : "." + ext);
    }

    // ------------------------------------------------------------- helpers

    private boolean isInternal(Uri uri) {
        String host = uri.getHost();
        if (host == null) {
            return true;
        }
        if (host.equals(ASSET_DOMAIN)) {
            return true;
        }
        Uri start = Uri.parse(BuildConfig.START_URL);
        String startHost = start.getHost();
        if (startHost == null) {
            return false;
        }
        return host.equals(startHost) || host.endsWith("." + startHost);
    }

    private boolean openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        } catch (ActivityNotFoundException e) {
            toast(getString(R.string.no_handler));
            return true;
        }
    }

    private boolean hasAll(java.util.List<String> permissions) {
        for (String permission : permissions) {
            if (ContextCompat.checkSelfPermission(this, permission)
                    != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }
        return true;
    }

    private String offlinePage() {
        return "<!doctype html><html><head><meta name='viewport' "
                + "content='width=device-width,initial-scale=1'>"
                + "<style>body{font-family:sans-serif;margin:0;display:flex;height:100vh;"
                + "align-items:center;justify-content:center;background:#101822;color:#E8E6E1;"
                + "text-align:center;padding:24px;box-sizing:border-box}"
                + "h1{font-size:20px;margin:0 0 8px}p{opacity:.7;margin:0 0 20px;font-size:15px}"
                + "button{font:inherit;padding:12px 22px;border:0;border-radius:6px;"
                + "background:#00C2B2;color:#08131a;font-weight:600}</style></head><body><div>"
                + "<h1>" + getString(R.string.offline_title) + "</h1>"
                + "<p>" + getString(R.string.offline_body) + "</p>"
                + "<button onclick='location.reload()'>"
                + getString(R.string.offline_retry) + "</button>"
                + "</div></body></html>";
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    // ------------------------------------------------------------ lifecycle

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeAllViews();
            webView.destroy();
        }
        super.onDestroy();
    }
}
