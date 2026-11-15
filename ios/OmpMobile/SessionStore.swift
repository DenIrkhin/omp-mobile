import Foundation
import Network
import Observation
import OmpKit

/// A short message at the bottom of the list, such as the result of a pin.
struct Toast: Equatable {
    let id = UUID()
    let text: String
    let isError: Bool
}

/// The saved server's session list: `GET /api/v1/hosts` every 10 seconds while the app is in front,
/// one request at a time, plus one more after a pin, a Reopen or a New session (`loadHosts` in `server/public/app.js`).
@MainActor
@Observable
final class SessionStore {
    /// The last reply. It stays while later requests fail, so the list can show it dimmed.
    private(set) var response: HostsResponse?
    /// `response` split into the two tabs.
    private(set) var entries: (chats: [SessionEntry], longTasks: [SessionEntry]) = ([], [])
    /// Why the last request failed; nil after a request that worked.
    private(set) var error: APIError?
    /// True while a refresh the user asked for runs; only then does the refresh button spin.
    private(set) var isRefreshing = false
    /// The sessions whose pin request runs.
    private(set) var pinning: Set<String> = []
    /// The closed long task whose Reopen runs; one at a time, as on the page.
    private(set) var reopening: String?
    private(set) var toast: Toast?
    /// Counts the replies that worked. After each, the app clears stale notifications and routes a
    /// tapped one (`AppModel.listLoaded`).
    private(set) var loads = 0

    @ObservationIgnored private var client: APIClient?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var isFetching = false
    @ObservationIgnored private var refetchQueued = false
    /// Counts address changes, so a reply from the server before is dropped.
    @ObservationIgnored private var serverChanges = 0
    @ObservationIgnored private var pathSatisfied = true
    private let pathMonitor = NWPathMonitor()

    init() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in self?.pathChanged(satisfied) }
        }
        pathMonitor.start(queue: .main)
    }

    /// Points the store at a server. A new address drops the old list, its poll and its pending replies;
    /// nil (leaving the demo) drops them and leaves the store with no server.
    func use(_ newClient: APIClient?) {
        guard newClient?.baseURL != client?.baseURL else { return }
        stop()
        client = newClient
        serverChanges += 1
        isFetching = false
        refetchQueued = false
        isRefreshing = false
        response = nil
        entries = ([], [])
        error = nil
        pinning = []
        reopening = nil
        toast = nil
    }

    /// Refreshes now and every 10 seconds after, until `stop()`. While the poll already runs, only
    /// the refresh now.
    func start() {
        guard client != nil else { return }
        guard pollTask == nil else {
            Task { await refresh() }
            return
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                let next = ContinuousClock.now + .seconds(10)
                await self?.refresh()
                do {
                    try await Task.sleep(until: next)
                } catch {
                    return
                }
            }
        }
    }

    /// Stops the poll, as when the app goes to the background.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Asks for the list now. `manual` spins the refresh button. `afterChange` queues one more request
    /// when one runs already, so the list shows the change.
    func refresh(manual: Bool = false, afterChange: Bool = false) async {
        guard let client else { return }
        if isFetching {
            if afterChange { refetchQueued = true }
            return
        }
        isFetching = true
        if manual { isRefreshing = true }
        let change = serverChanges
        let outcome: Result<HostsResponse, APIError>?
        do {
            outcome = .success(try await client.hosts())
        } catch let failure as APIError {
            outcome = .failure(failure)
        } catch {
            // Cancelled with the poll: keep what the list shows.
            outcome = nil
        }
        guard change == serverChanges else { return }
        isFetching = false
        isRefreshing = false
        switch outcome {
        case .success(let fresh):
            response = fresh
            entries = SessionList.compose(fresh)
            error = nil
            loads += 1
        case .failure(let failure):
            error = failure
        case nil:
            break
        }
        if refetchQueued {
            refetchQueued = false
            await refresh()
        }
    }

    /// Pins or unpins the entry's session, the same pin as /pin on the Mac, then reloads the list so
    /// the card moves to the other tab. The toast says what happened.
    func setPinned(_ entry: SessionEntry, to pinned: Bool) async {
        guard let client, !pinning.contains(entry.sessionId) else { return }
        pinning.insert(entry.sessionId)
        let change = serverChanges
        do {
            try await client.pin(sessionId: entry.sessionId, pinned: pinned)
            guard change == serverChanges else { return }
            pinning.remove(entry.sessionId)
            let text = pinned ? "Moved to Long tasks" : entry.host == nil ? "Removed from Long tasks" : "Moved to Chats"
            toast = Toast(text: text, isError: false)
            await refresh(afterChange: true)
        } catch let failure as APIError {
            guard change == serverChanges else { return }
            pinning.remove(entry.sessionId)
            toast = Toast(text: "\(pinned ? "Pin" : "Unpin") failed: \(failure.message)", isError: true)
        } catch {
            guard change == serverChanges else { return }
            pinning.remove(entry.sessionId)
        }
    }

    /// Reopen on a closed long task: the Mac starts its chat again in cmux, then the list reloads so the
    /// card turns live (`reopenLongTask` in `server/public/app.js`). A refusal shows the server's message.
    func reopen(_ entry: SessionEntry) async {
        guard let client, reopening == nil else { return }
        reopening = entry.sessionId
        let change = serverChanges
        let result: Toast?
        do {
            try await client.reopen(sessionId: entry.sessionId)
            result = Toast(text: "Reopened \(entry.title) on the Mac", isError: false)
        } catch let failure as APIError {
            result = Toast(text: failure.message, isError: true)
        } catch {
            result = nil
        }
        guard change == serverChanges else { return }
        if let result { toast = result }
        await refresh(afterChange: true)
        guard change == serverChanges else { return }
        reopening = nil
    }

    /// Shows a message at the bottom of the list for a result that starts outside it, such as opening
    /// a chat.
    func showToast(_ text: String, isError: Bool) {
        toast = Toast(text: text, isError: isError)
    }

    /// Hides the toast, unless a newer one took its place.
    func dismissToast(_ id: UUID) {
        if toast?.id == id { toast = nil }
    }

    /// The network came back (a VPN reconnect raises a path update): refresh once, if the app polls.
    private func pathChanged(_ satisfied: Bool) {
        let wasSatisfied = pathSatisfied
        pathSatisfied = satisfied
        if satisfied && !wasSatisfied && pollTask != nil {
            Task { await refresh() }
        }
    }
}
