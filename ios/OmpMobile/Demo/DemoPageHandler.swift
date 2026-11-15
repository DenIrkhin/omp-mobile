import Foundation
import WebKit

/// Answers the demo's `omp-demo://` chat links with `demo-chat.html` from the app bundle, so Watch and
/// Control in the demo show a sample chat with no network. The page reads `theme`, `access` and `folder`
/// from its link.
final class DemoPageHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let file = Bundle.main.url(forResource: "demo-chat", withExtension: "html"),
              let data = try? Data(contentsOf: file)
        else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        urlSchemeTask.didReceive(
            URLResponse(url: url, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}
