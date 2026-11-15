import OmpKit
import SwiftUI
import WebKit

/// The chat page in a WKWebView. The web view belongs to the `ChatPage` in `ChatPool`, so it outlives
/// this view; each new `CollabWebView` takes over its delegates.
struct CollabWebView: UIViewRepresentable {
    let page: ChatPage

    func makeCoordinator() -> Coordinator {
        Coordinator(page: page)
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = page.webView
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let page: ChatPage

        init(page: ChatPage) {
            self.page = page
        }

        /// Main-frame navigations follow `NavigationPolicy`; frames inside the page load.
        func webView(
            _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.targetFrame?.isMainFrame == true, let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let tapped = navigationAction.navigationType == .linkActivated
            switch NavigationPolicy.decide(url: url, chatURL: page.url, userInitiated: tapped) {
            case .allow:
                decisionHandler(.allow)
            case .openExternally:
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            case .cancel:
                decisionHandler(.cancel)
            }
        }

        /// A link that asks for a new window (a nil target frame): the page's own site loads here, any
        /// other site opens in the default browser. No new web view either way.
        func webView(
            _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                switch NavigationPolicy.decide(url: url, chatURL: page.url, userInitiated: true) {
                case .allow: webView.load(navigationAction.request)
                case .openExternally: UIApplication.shared.open(url)
                case .cancel: break
                }
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            page.loadError = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            failed(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            failed(error)
        }

        /// iOS ended the page's process (memory pressure): load the chat again.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: page.url))
        }

        private func failed(_ error: any Error) {
            let nsError = error as NSError
            // A load the next one replaced, or a link the policy sent elsewhere ("Frame load interrupted").
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
            if let urlError = error as? URLError {
                page.loadError = APIError(urlError, host: page.url.host() ?? page.url.absoluteString).message
            } else {
                page.loadError = nsError.localizedDescription
            }
        }
    }
}
