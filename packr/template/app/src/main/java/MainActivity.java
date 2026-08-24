package __PACKAGE_ID__;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
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

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

public class MainActivity extends AppCompatActivity {

    private static final String ASSET_DOMAIN = "appassets.androidplatform.net";
    private static final String PAYWALL_URL =
            "https://" + ASSET_DOMAIN + "/assets/_packr/paywall.html";
    private static final String PREFS = "packr";

    private WebView webView;
    private SwipeRefreshLayout refreshLayout;
    private WebViewAssetLoader assetLoader;

    private JSONObject appConfig = new JSONObject();
    private boolean premiumEnabled;
    private final java.util.List<String> premiumHashes = new java.util.ArrayList<>();

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

        loadAppConfig();
        registerLaunchers();
        configureWebView();
        configureRefresh();
        configureBackNavigation();
        buildChrome();

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
        webView.addJavascriptInterface(new PackrAppBridge(), "PackrApp");
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

    // ------------------------------------------------- app chrome & buttons

    /** Settings that are structured rather than scalar ship as a JSON asset. */
    private void loadAppConfig() {
        try (InputStream stream = getAssets().open("_packr/app-config.json")) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            appConfig = new JSONObject(buffer.toString("UTF-8"));
        } catch (Exception e) {
            appConfig = new JSONObject();
        }
        JSONObject premium = appConfig.optJSONObject("premium");
        premiumEnabled = premium != null && premium.optBoolean("enabled");
        if (premium != null) {
            JSONArray hashes = premium.optJSONArray("codeHashes");
            for (int i = 0; hashes != null && i < hashes.length(); i++) {
                premiumHashes.add(hashes.optString(i).toLowerCase(Locale.ROOT));
            }
        }
    }

    private void buildChrome() {
        int themeColor;
        try {
            themeColor = Color.parseColor(appConfig.optString("themeColor", "#101822"));
        } catch (Exception e) {
            themeColor = Color.parseColor("#101822");
        }
        boolean darkTheme = (0.299 * Color.red(themeColor)
                + 0.587 * Color.green(themeColor)
                + 0.114 * Color.blue(themeColor)) < 150;
        int ink = darkTheme ? Color.WHITE : Color.parseColor("#12181F");

        if (appConfig.optBoolean("topBar")) {
            TextView topBar = findViewById(R.id.topbar);
            topBar.setVisibility(View.VISIBLE);
            topBar.setText(getString(R.string.app_name));
            topBar.setBackgroundColor(themeColor);
            topBar.setTextColor(ink);
        }

        JSONArray buttons = appConfig.optJSONArray("navButtons");
        if (buttons == null || buttons.length() == 0) {
            return;
        }
        LinearLayout navbar = findViewById(R.id.navbar);
        navbar.setVisibility(View.VISIBLE);
        navbar.setBackgroundColor(themeColor);
        for (int i = 0; i < buttons.length(); i++) {
            JSONObject spec = buttons.optJSONObject(i);
            if (spec == null) {
                continue;
            }
            navbar.addView(makeNavButton(spec, ink),
                    new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
        }
    }

    private View makeNavButton(JSONObject spec, int ink) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        TypedValue ripple = new TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, ripple, true);
        item.setBackgroundResource(ripple.resourceId);

        int iconSize = (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, 24, getResources().getDisplayMetrics());
        ImageView icon = new ImageView(this);
        int drawable = getResources().getIdentifier(
                "pk_" + spec.optString("icon"), "drawable", getPackageName());
        if (drawable != 0) {
            icon.setImageResource(drawable);
        }
        icon.setColorFilter(ink);
        item.addView(icon, new LinearLayout.LayoutParams(iconSize, iconSize));

        TextView label = new TextView(this);
        label.setText(spec.optString("label"));
        label.setTextColor(ink);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        label.setMaxLines(1);
        item.addView(label);

        item.setOnClickListener(view -> dispatchNavAction(spec));
        return item;
    }

    private void dispatchNavAction(JSONObject spec) {
        if (spec.optBoolean("premium") && !isPremiumUnlocked()) {
            openPaywall();
            return;
        }
        String value = spec.optString("value");
        switch (spec.optString("action")) {
            case "home":
                webView.loadUrl(BuildConfig.START_URL);
                break;
            case "back":
                if (webView.canGoBack()) {
                    webView.goBack();
                }
                break;
            case "forward":
                if (webView.canGoForward()) {
                    webView.goForward();
                }
                break;
            case "reload":
                webView.reload();
                break;
            case "share":
                shareCurrentPage();
                break;
            case "page":
                webView.loadUrl(resolvePage(value));
                break;
            case "browser":
                openExternally(Uri.parse(value));
                break;
            case "call":
                openExternally(Uri.parse("tel:" + value.replaceAll("\\s+", "")));
                break;
            case "email":
                openExternally(Uri.parse("mailto:" + value));
                break;
            case "paywall":
                openPaywall();
                break;
            default:
                break;
        }
    }

    private String resolvePage(String value) {
        if (value.startsWith("http://") || value.startsWith("https://")) {
            return value;
        }
        String cleaned = value.startsWith("/") ? value.substring(1) : value;
        if (BuildConfig.LOCAL_MODE) {
            return "https://" + ASSET_DOMAIN + "/assets/www/" + cleaned;
        }
        try {
            return java.net.URI.create(BuildConfig.START_URL).resolve(cleaned).toString();
        } catch (Exception e) {
            return BuildConfig.START_URL;
        }
    }

    private void shareCurrentPage() {
        String url = webView.getUrl();
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, url == null ? getString(R.string.app_name) : url);
        try {
            startActivity(Intent.createChooser(send, null));
        } catch (ActivityNotFoundException e) {
            toast(getString(R.string.no_handler));
        }
    }

    // ------------------------------------------------------- paid features

    private boolean isPremiumUnlocked() {
        if (!premiumEnabled) {
            return true;
        }
        return getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("premium_unlocked", false);
    }

    /** Codes are matched by SHA-256 against the hashes baked into the app. */
    private boolean redeemCode(String code) {
        String normalised = code == null
                ? ""
                : code.replaceAll("[^A-Za-z0-9]", "").toUpperCase(Locale.ROOT);
        if (normalised.isEmpty()) {
            return false;
        }
        if (!premiumHashes.contains(sha256Hex(normalised))) {
            return false;
        }
        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit().putBoolean("premium_unlocked", true).apply();
        return true;
    }

    private String sha256Hex(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : bytes) {
                hex.append(String.format("%02x", b));
            }
            return hex.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private void openPaywall() {
        webView.loadUrl(PAYWALL_URL);
    }

    /**
     * Exposed to the page as window.PackrApp, and used by the generated
     * premium screen. Your own web content can gate features with it too.
     */
    private class PackrAppBridge {
        @JavascriptInterface
        public boolean isPremium() {
            return isPremiumUnlocked();
        }

        @JavascriptInterface
        public boolean unlock(String code) {
            return redeemCode(code);
        }

        @JavascriptInterface
        public void openPaywall() {
            runOnUiThread(MainActivity.this::openPaywall);
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> openExternally(Uri.parse(url)));
        }

        @JavascriptInterface
        public void goHome() {
            runOnUiThread(() -> webView.loadUrl(BuildConfig.START_URL));
        }
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
