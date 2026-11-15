import Foundation
import Observation
import OmpKit
import SwiftUI
import UserNotifications

/// What the whole app shares: the server's info, the session list, push, the open chat with its kept
/// web view, and where a tapped notification goes.
@Observable
final class AppModel {
    /// The last `GET /api/v1/info` reply from the saved server. Settings shows its versions, and its
    /// `features` decide which parts of the list show.
    var info: ServerInfo?

    /// The saved server's session list.
    let sessions = SessionStore()

    /// The open chat and its web view, kept while the user is back on the list.
    let chats = ChatPool()

    /// Notifications on this device: the permission, the token and the registration.
    let push = PushManager()

    /// The saved server; set by `use(_:)`.
    private(set) var server: APIClient?

    /// The column a collapsed split view (iPhone) shows: opening a chat moves to the chat.
    var compactColumn = NavigationSplitViewColumn.sidebar

    /// The instance whose link the app is asking for; every card's Watch and Control wait meanwhile.
    private(set) var opening: String?

    /// Where the last tapped notification goes. `SessionListView` acts on it and sets it back to nil.
    var tapDestination: PushDestination?

    /// Connect your Mac in the demo: onboarding opens at the server address once, then clears this.
    @ObservationIgnored var onboardingAtAddress = false

    /// The chat screen on view, set by `ChatScreen`. A notification about its chat shows no banner.
    @ObservationIgnored var shownChat: ChatPage?

    /// A tapped notification, waiting for the first list after the tap; `afterLoad` is the list count
    /// at the tap.
    private struct PendingTap {
        let route: PushRoute
        let afterLoad: Int
    }

    @ObservationIgnored private var pendingTap: PendingTap?

    /// Ephemeral: no cookies or cache on disk. URLSession sends no `Origin` header, which the
    /// server's mutation check needs on POST routes later.
    private let session = URLSession(configuration: .ephemeral)

    /// The demo's session: `DemoServer` answers every request on the device.
    private let demoSession = DemoServer.session()

    /// A client on the network. The address check uses it, so a typed `demo.invalid` never reaches the demo.
    func client(for url: URL) -> APIClient {
        APIClient(baseURL: url, session: session)
    }

    /// The saved server's client: the demo's in-app server for `DemoServer.baseURL`, else the network.
    private func serverClient(for url: URL) -> APIClient {
        url == DemoServer.baseURL ? APIClient(baseURL: url, session: demoSession) : client(for: url)
    }

    /// Points the app at the saved server. A new address drops the list, its poll and the open chat.
    func use(_ url: URL) {
        guard url != server?.baseURL else { return }
        let fresh = serverClient(for: url)
        server = fresh
        sessions.use(fresh)
        chats.clear()
        compactColumn = .sidebar
    }

    /// Asks the saved server for its info again; a failure keeps the last reply. A good reply lets push
    /// register this device with the server again, as at every launch.
    func refreshInfo(from url: URL) async {
        if let fresh = try? await serverClient(for: url).info() {
            info = fresh
            if let server, server.baseURL == url {
                await push.sync(server: server, info: fresh)
            }
        }
    }

    /// Leave demo and Connect your Mac: the list and its poll, the server, its info and the open chat
    /// go, and so do the demo's project chip and pins. A saved server address stays as it was.
    func leaveDemo() {
        sessions.use(nil)
        server = nil
        info = nil
        chats.clear()
        compactColumn = .sidebar
        UserDefaults.standard.removeObject(forKey: "project")
        DemoServer.shared.reset()
    }

    /// Shows a chat in the detail column. The kept page serves when it shows this chat at this
    /// generation with this access and theme; else the server mints a link, and the new page replaces
    /// the kept one. A failed link keeps the kept page and says why in a toast on the list.
    func openChat(_ target: ChatTarget, theme: Theme) async {
        guard let server, opening == nil else { return }
        if chats.reusable(for: target.key, theme: theme) != nil {
            compactColumn = .detail
            return
        }
        opening = target.key.instanceId
        defer { opening = nil }
        do {
            let link = try await server.link(
                instanceId: target.key.instanceId, generation: target.key.generation, access: target.key.access)
            guard server.baseURL == self.server?.baseURL else { return }
            chats.keep(ChatPage(target: target, link: link, theme: theme))
            compactColumn = .detail
        } catch let failure as APIError {
            guard server.baseURL == self.server?.baseURL else { return }
            sessions.showToast(Self.linkFailure(failure), isError: true)
            if Self.chatIsGone(failure) { await sessions.refresh(afterChange: true) }
        } catch {}
    }

    /// Reload in the chat toolbar, Retry on its overlay, and a new appearance: a fresh link for the open
    /// chat, loaded in its web view.
    func reloadChat(theme: Theme) async {
        guard let server, let page = chats.page, !page.isReloading else { return }
        page.isReloading = true
        defer { page.isReloading = false }
        do {
            let link = try await server.link(
                instanceId: page.key.instanceId, generation: page.key.generation, access: page.key.access)
            page.load(link: link, theme: theme)
        } catch let failure as APIError {
            page.loadError = Self.linkFailure(failure)
            if Self.chatIsGone(failure) { await sessions.refresh(afterChange: true) }
        } catch {}
    }

    /// New session's Start: the Mac starts omp in the folder (up to 45 s). On 201 the sheet can close,
    /// and the new chat opens in Control with no extra tap as soon as its link arrives; the list reloads.
    /// Returns why the start failed; a link that fails after a good start shows as a toast on the list.
    func startSession(folder: String, model: String, maxCost: Double?, theme: Theme) async -> APIError? {
        guard let server else { return nil }
        let launched: LaunchResult
        do {
            launched = try await server.startSession(folder: folder, model: model, maxCost: maxCost)
        } catch let failure as APIError {
            return failure
        } catch {
            return nil
        }
        let sessions = self.sessions
        Task { await sessions.refresh(afterChange: true) }
        Task { await openChat(ChatTarget(launched: launched, folder: folder), theme: theme) }
        return nil
    }

    /// A notification while the app is in front: no banner, sound or list entry when it is about the
    /// chat on screen. The list refreshes either way.
    func presentation(for route: PushRoute?) -> UNNotificationPresentationOptions {
        let sessions = self.sessions
        Task { await sessions.refresh(afterChange: true) }
        if let sessionId = route?.sessionId, sessionId == shownSessionId { return [] }
        return [.banner, .sound, .list]
    }

    /// A tapped notification. It waits for the first list after the tap, which this asks for; at a cold
    /// start the first list comes once `RootView` sets the server.
    func receiveTap(_ route: PushRoute) {
        pendingTap = PendingTap(route: route, afterLoad: sessions.loads)
        let sessions = self.sessions
        Task { await sessions.refresh(afterChange: true) }
    }

    /// After each list: removes stale "needs input" notifications, and gives a tapped notification that
    /// waited for this list its destination.
    func listLoaded() {
        guard let response = sessions.response else { return }
        let push = self.push
        Task { await push.removeStaleInputBanners(response) }
        if let tap = pendingTap, sessions.loads > tap.afterLoad {
            pendingTap = nil
            tapDestination = tap.route.destination(in: sessions.entries)
        }
    }

    /// The session of the chat on screen, from the last list.
    private var shownSessionId: String? {
        guard let key = shownChat?.key else { return nil }
        return sessions.response?.hosts
            .first { $0.instanceId == key.instanceId && $0.generation == key.generation }?
            .sessionId
    }

    /// What a failed `POST /api/v1/link` means for the user (`openSession` in `server/public/app.js`).
    private static func linkFailure(_ failure: APIError) -> String {
        switch failure {
        case .http(404, _, _): "That chat has ended."
        case .http(409, _, _): "This chat restarted. Open it again from the list."
        default: failure.message
        }
    }

    /// 404 (the chat ended) and 409 (its generation changed): the list is out of date.
    private static func chatIsGone(_ failure: APIError) -> Bool {
        if case .http(let status, _, _) = failure { return status == 404 || status == 409 }
        return false
    }
}
