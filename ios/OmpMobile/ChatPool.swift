import Observation
import OmpKit
import WebKit

/// What the kept web view is reused for: the same chat, at the same generation, with the same access.
struct ChatKey: Equatable {
    let instanceId: String
    let generation: Int
    let access: Access
}

/// A chat to open: a card's live chat, or the chat New session started.
struct ChatTarget {
    let key: ChatKey
    let title: String

    init(host: HostCard, title: String, access: Access) {
        key = ChatKey(instanceId: host.instanceId, generation: host.generation, access: access)
        self.title = title
    }

    /// New session's chat opens in Control; its title is the folder's name, as its card shows it.
    init(launched: LaunchResult, folder: String) {
        key = ChatKey(instanceId: launched.instanceId, generation: launched.generation, access: .control)
        title = NewSession.leafName(folder)
    }
}

/// The open chat: its link with the app's theme, its web view, and what the chat screen shows over it.
@Observable
final class ChatPage {
    let key: ChatKey
    let title: String
    /// The loaded link with `?theme=`; the link policy compares origins with it.
    private(set) var url: URL
    private(set) var theme: Theme
    /// Why the page did not load; the chat screen shows it over the page with Retry.
    var loadError: String?
    var isReloading = false
    let webView: WKWebView

    init(target: ChatTarget, link: URL, theme: Theme) {
        key = target.key
        title = target.title
        url = ChatURL.themed(link, theme: theme)
        self.theme = theme
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        if link.scheme == DemoServer.pageScheme {
            // The demo's chat page comes from the app bundle, with no network.
            configuration.setURLSchemeHandler(DemoPageHandler(), forURLScheme: DemoServer.pageScheme)
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: url))
    }

    /// Loads a fresh link for the same chat in the same web view.
    func load(link: URL, theme: Theme) {
        url = ChatURL.themed(link, theme: theme)
        self.theme = theme
        loadError = nil
        webView.load(URLRequest(url: url))
    }
}

/// Keeps the last chat's web view, so going back to the list and opening the same chat again neither
/// reconnects nor downloads the transcript again. Another chat, another generation or the other
/// access replaces it; so does a new appearance, so that the page loads with the new theme.
@Observable
final class ChatPool {
    private(set) var page: ChatPage?

    /// The kept page when it shows this chat with this theme.
    func reusable(for key: ChatKey, theme: Theme) -> ChatPage? {
        guard let page, page.key == key, page.theme == theme else { return nil }
        return page
    }

    func keep(_ page: ChatPage) {
        self.page = page
    }

    func clear() {
        page = nil
    }

    /// Settings → Clear cached transcripts: closes the kept chat, then removes IndexedDB and local
    /// storage of the server's sites only.
    func clearCachedTranscripts(serverHost: String) async {
        page = nil
        let store = WKWebsiteDataStore.default()
        let types: Set<String> = [WKWebsiteDataTypeIndexedDBDatabases, WKWebsiteDataTypeLocalStorage]
        let records = await store.dataRecords(ofTypes: types)
            .filter { CachedTranscripts.isServerRecord($0.displayName, serverHost: serverHost) }
        await store.removeData(ofTypes: types, for: records)
    }
}
