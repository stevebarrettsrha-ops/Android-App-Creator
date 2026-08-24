import UIKit
import WebKit
import CryptoKit

/// The WebView host. Mirrors the behaviour of the Android build:
/// bundled files or a live address, external links in the real browser,
/// pull-to-refresh, downloads handed to the share sheet, an offline page,
/// camera/microphone prompts wired to the system permission dialogs, the
/// custom button bar, and the paid-features unlock screen.
final class ViewController: UIViewController {

    private var webView: WKWebView!
    private let refreshControl = UIRefreshControl()
    private var pendingDownloadURL: URL?

    private var chrome = AppChrome()
    private var premiumUnlocked: Bool {
        get { UserDefaults.standard.bool(forKey: "packr_premium_unlocked") }
        set { UserDefaults.standard.set(newValue, forKey: "packr_premium_unlocked") }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Config.themeColor
        chrome = AppChrome.load()

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(self, name: "packr")
        installUserScripts(into: configuration.userContentController)

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.isOpaque = false
        webView.backgroundColor = Config.themeColor

        if Config.pullToRefresh {
            refreshControl.addTarget(self, action: #selector(reload), for: .valueChanged)
            webView.scrollView.refreshControl = refreshControl
        }

        layoutChrome()
        loadStartPage()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        Config.themeIsDark ? .lightContent : .darkContent
    }

    // ------------------------------------------------------------- layout

    /// Top bar, web view and button bar stacked vertically.
    private func layoutChrome() {
        let ink: UIColor = Config.themeIsDark ? .white : UIColor(
            red: 0x12 / 255, green: 0x18 / 255, blue: 0x1F / 255, alpha: 1)

        var topAnchor = view.safeAreaLayoutGuide.topAnchor
        if chrome.topBar {
            let bar = UILabel()
            bar.text = Config.appName
            bar.font = .systemFont(ofSize: 17, weight: .bold)
            bar.textColor = ink
            bar.backgroundColor = Config.themeColor
            bar.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(bar)
            NSLayoutConstraint.activate([
                bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
                bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
                bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),
                bar.heightAnchor.constraint(equalToConstant: 48),
            ])
            topAnchor = bar.bottomAnchor
        }

        var bottomAnchor = view.bottomAnchor
        if !chrome.navButtons.isEmpty {
            let stack = UIStackView()
            stack.axis = .horizontal
            stack.distribution = .fillEqually
            for button in chrome.navButtons {
                stack.addArrangedSubview(makeNavButton(button, ink: ink))
            }
            stack.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
                stack.heightAnchor.constraint(equalToConstant: 56),
            ])
            bottomAnchor = stack.topAnchor
        }

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private func makeNavButton(_ spec: NavButton, ink: UIColor) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: spec.sf ?? "circle.fill")
            ?? UIImage(systemName: "circle.fill")
        configuration.title = spec.label
        configuration.imagePlacement = .top
        configuration.imagePadding = 3
        configuration.baseForegroundColor = ink
        configuration.preferredSymbolConfigurationForImage =
            UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
        configuration.titleTextAttributesTransformer =
            UIConfigurationTextAttributesTransformer { incoming in
                var outgoing = incoming
                outgoing.font = UIFont.systemFont(ofSize: 10, weight: .medium)
                return outgoing
            }
        let button = UIButton(configuration: configuration)
        button.addAction(UIAction { [weak self] _ in self?.dispatch(spec) }, for: .touchUpInside)
        return button
    }

    // ------------------------------------------------------------ actions

    private func dispatch(_ spec: NavButton) {
        if spec.premium == true && !isPremium() {
            openPaywall()
            return
        }
        let value = spec.value ?? ""
        switch spec.action {
        case "home":
            loadStartPage()
        case "back":
            if webView.canGoBack { webView.goBack() }
        case "forward":
            if webView.canGoForward { webView.goForward() }
        case "reload":
            reload()
        case "share":
            shareCurrentPage()
        case "page":
            openPage(value)
        case "browser":
            if let url = URL(string: value) { UIApplication.shared.open(url) }
        case "call":
            let digits = value.replacingOccurrences(of: " ", with: "")
            if let url = URL(string: "tel:\(digits)") { UIApplication.shared.open(url) }
        case "email":
            if let url = URL(string: "mailto:\(value)") { UIApplication.shared.open(url) }
        case "paywall":
            openPaywall()
        default:
            break
        }
    }

    private func openPage(_ value: String) {
        if value.hasPrefix("http://") || value.hasPrefix("https://") {
            if let url = URL(string: value) { webView.load(URLRequest(url: url)) }
            return
        }
        let cleaned = value.hasPrefix("/") ? String(value.dropFirst()) : value
        if Config.localMode {
            if let www = Bundle.main.url(forResource: "www", withExtension: nil) {
                webView.loadFileURL(www.appendingPathComponent(cleaned), allowingReadAccessTo: www)
            }
        } else if let base = URL(string: Config.startURL),
                  let url = URL(string: cleaned, relativeTo: base) {
            webView.load(URLRequest(url: url.absoluteURL))
        }
    }

    private func shareCurrentPage() {
        let item: Any = webView.url ?? Config.appName
        let sheet = UIActivityViewController(activityItems: [item], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(
            x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1
        )
        present(sheet, animated: true)
    }

    // ------------------------------------------------------ paid features

    private func isPremium() -> Bool {
        if !chrome.premiumEnabled { return true }
        return premiumUnlocked
    }

    /// Codes are matched by SHA-256 against the hashes baked into the app.
    private func redeemCode(_ code: String) -> Bool {
        let normalised = code.uppercased().filter { $0.isLetter || $0.isNumber }
        guard !normalised.isEmpty else { return false }
        let digest = SHA256.hash(data: Data(normalised.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        guard chrome.premiumCodeHashes.contains(hex) else { return false }
        premiumUnlocked = true
        return true
    }

    private func openPaywall() {
        guard let www = Bundle.main.url(forResource: "www", withExtension: nil) else { return }
        let paywall = www.appendingPathComponent("_packr/paywall.html")
        if FileManager.default.fileExists(atPath: paywall.path) {
            webView.loadFileURL(paywall, allowingReadAccessTo: www)
        }
    }

    // ------------------------------------------------------------ loading

    private func loadStartPage() {
        if Config.localMode {
            guard let www = Bundle.main.url(forResource: "www", withExtension: nil) else {
                showFatal("The www folder is missing from the app bundle.")
                return
            }
            let entry = www.appendingPathComponent(Config.localEntry)
            webView.loadFileURL(entry, allowingReadAccessTo: www)
        } else if let url = URL(string: Config.startURL) {
            webView.load(URLRequest(url: url))
        }
    }

    @objc private func reload() {
        if webView.url == nil || webView.url?.lastPathComponent == "offline.html" {
            loadStartPage()
        } else {
            webView.reload()
        }
    }

    private func showOfflinePage() {
        if let www = Bundle.main.url(forResource: "www", withExtension: nil) {
            let offline = www.appendingPathComponent("offline.html")
            if FileManager.default.fileExists(atPath: offline.path) {
                webView.loadFileURL(offline, allowingReadAccessTo: www)
                return
            }
        }
        let html = """
            <!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>
            <body style='font-family:-apple-system;display:flex;min-height:90vh;align-items:center;justify-content:center'>
            <div style='text-align:center'><h2>No connection</h2>
            <p><a href='packr-retry://now' style='display:inline-block;padding:10px 22px;border:1px solid #888;border-radius:6px;text-decoration:none'>Try again</a></p></div>
            """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func showFatal(_ message: String) {
        let alert = UIAlertController(title: Config.appName, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    private func isExternal(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        if Config.localMode { return true }
        guard let startHost = URL(string: Config.startURL)?.host else { return true }
        return url.host?.lowercased() != startHost.lowercased()
    }
}

// MARK: - The window.PackrApp bridge

extension ViewController: WKScriptMessageHandler {

    /// Injected into every page: a synchronous isPremium flag plus
    /// promise-based calls into the shell. The generated premium screen uses
    /// this API, and your own web content can too.
    fileprivate func installUserScripts(into controller: WKUserContentController) {
        controller.removeAllUserScripts()

        if !Config.allowZoom {
            let zoom = """
                var meta = document.querySelector('meta[name=viewport]');
                if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
                meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
                """
            controller.addUserScript(
                WKUserScript(source: zoom, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            )
        }

        let bridge = """
            window.__packrPremium = \(isPremium() ? "true" : "false");
            window.__packrResolvers = {};
            window.__packrResolve = function(id, ok) {
              var r = window.__packrResolvers[id];
              delete window.__packrResolvers[id];
              if (ok) window.__packrPremium = true;
              if (r) r(ok);
            };
            window.PackrApp = {
              isPremium: function() { return window.__packrPremium === true; },
              unlock: function(code) {
                return new Promise(function(resolve) {
                  var id = String(Date.now()) + Math.random();
                  window.__packrResolvers[id] = resolve;
                  window.webkit.messageHandlers.packr.postMessage({type:'unlock', code:String(code||''), id:id});
                });
              },
              openPaywall: function() { window.webkit.messageHandlers.packr.postMessage({type:'paywall'}); },
              openExternal: function(url) { window.webkit.messageHandlers.packr.postMessage({type:'external', url:String(url||'')}); },
              goHome: function() { window.webkit.messageHandlers.packr.postMessage({type:'home'}); }
            };
            """
        controller.addUserScript(
            WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "packr", let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "unlock":
            let code = body["code"] as? String ?? ""
            let id = body["id"] as? String ?? ""
            let ok = redeemCode(code)
            if ok {
                // Future page loads should start with the flag already true.
                installUserScripts(into: webView.configuration.userContentController)
            }
            let script = "window.__packrResolve(\(jsString(id)), \(ok ? "true" : "false"));"
            webView.evaluateJavaScript(script, completionHandler: nil)
        case "paywall":
            openPaywall()
        case "external":
            if let raw = body["url"] as? String, let url = URL(string: raw),
               url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
            }
        case "home":
            loadStartPage()
        default:
            break
        }
    }

    private func jsString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        return "'\(escaped)'"
    }
}

// MARK: - Chrome configuration, read from the bundled _packr/app-config.json

struct NavButton: Decodable {
    let label: String
    let icon: String
    let action: String
    let value: String?
    let premium: Bool?
    let sf: String?
}

struct AppChrome {
    var topBar = false
    var navButtons: [NavButton] = []
    var premiumEnabled = false
    var premiumCodeHashes: [String] = []

    private struct Raw: Decodable {
        struct Premium: Decodable {
            let enabled: Bool?
            let codeHashes: [String]?
        }
        let topBar: Bool?
        let navButtons: [NavButton]?
        let premium: Premium?
    }

    static func load() -> AppChrome {
        var chrome = AppChrome()
        guard let www = Bundle.main.url(forResource: "www", withExtension: nil) else { return chrome }
        let file = www.appendingPathComponent("_packr/app-config.json")
        guard let data = try? Data(contentsOf: file),
              let raw = try? JSONDecoder().decode(Raw.self, from: data) else { return chrome }
        chrome.topBar = raw.topBar ?? false
        chrome.navButtons = raw.navButtons ?? []
        chrome.premiumEnabled = raw.premium?.enabled ?? false
        chrome.premiumCodeHashes = (raw.premium?.codeHashes ?? []).map { $0.lowercased() }
        return chrome
    }
}

// MARK: - Navigation

extension ViewController: WKNavigationDelegate {

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        if url.scheme == "packr-retry" {
            decisionHandler(.cancel)
            loadStartPage()
            return
        }

        // tel:, mailto:, sms:, and other apps' links go to the system.
        if let scheme = url.scheme?.lowercased(),
           !["http", "https", "file", "about", "blob", "data"].contains(scheme) {
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
            return
        }

        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }

        if Config.externalLinksInBrowser,
           navigationAction.navigationType == .linkActivated,
           isExternal(url) {
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
            return
        }

        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refreshControl.endRefreshing()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        refreshControl.endRefreshing()
        let code = (error as NSError).code
        if code == NSURLErrorCancelled { return }
        showOfflinePage()
    }

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }
}

// MARK: - Downloads: save to a temporary file, then offer the share sheet

extension ViewController: WKDownloadDelegate {

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = directory.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: target)
        pendingDownloadURL = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = pendingDownloadURL else { return }
        pendingDownloadURL = nil
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(
            x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1
        )
        present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        pendingDownloadURL = nil
    }
}

// MARK: - UI: window.open, media capture, JS dialogs

extension ViewController: WKUIDelegate {

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // window.open / target=_blank: navigate in place, or hand to the browser.
        if let url = navigationAction.request.url {
            if Config.externalLinksInBrowser, isExternal(url) {
                UIApplication.shared.open(url)
            } else {
                webView.load(navigationAction.request)
            }
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        // The system camera/microphone dialogs still apply on first use.
        decisionHandler(.grant)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
