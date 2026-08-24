import UIKit
import WebKit

/// The WebView host. Mirrors the behaviour of the Android build:
/// bundled files or a live address, external links in the real browser,
/// pull-to-refresh, downloads handed to the share sheet, an offline page,
/// and camera/microphone prompts wired to the system permission dialogs.
final class ViewController: UIViewController {

    private var webView: WKWebView!
    private let refreshControl = UIRefreshControl()
    private var pendingDownloadURL: URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Config.themeColor

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.websiteDataStore = .default()

        if !Config.allowZoom {
            let script = """
                var meta = document.querySelector('meta[name=viewport]');
                if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
                meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
                """
            configuration.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            )
        }

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

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        loadStartPage()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        Config.themeIsDark ? .lightContent : .darkContent
    }

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
