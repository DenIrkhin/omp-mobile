import Foundation

/// The status badge of a card, picked as the phone page picks it (`buildLiveCard` and
/// `buildClosedCard` in `server/public/app.js`).
public enum CardStatus: Sendable, Equatable {
    case needsInput, running, idle, unknown, closed

    /// A live chat's status. A question that waits for an answer wins over running.
    public init(_ host: HostCard) {
        if host.inputRequired {
            self = .needsInput
        } else if host.busy == true {
            self = .running
        } else if host.busy == false {
            self = .idle
        } else {
            self = .unknown
        }
    }

    public var text: String {
        switch self {
        case .needsInput: "Needs input"
        case .running: "Running"
        case .idle: "Idle"
        case .unknown: "Unknown"
        case .closed: "Closed"
        }
    }
}

/// What an empty list says, and what to do about it.
public struct EmptyState: Sendable, Equatable {
    public let title: String
    public let hint: String
}

/// The texts of the list screen, written as the phone page writes them (`server/public/app.js`).
public enum CardText {
    /// "just now" under 10 seconds, then "45s ago", "5m ago", "3h ago", "2d ago" (`formatRelativeTime`).
    public static func relative(_ date: Date, now: Date) -> String {
        let seconds = Int(now.timeIntervalSince(date).rounded(.down))
        if seconds < 10 { return "just now" }
        if seconds < 60 { return "\(seconds)s ago" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    /// The status line: "Updated just now" up to 2 seconds after the server's fetch, then
    /// "Updated 12s ago", with the page copy's problem after a dot (`updateStatusText`).
    public static func updated(fetchedAt: Date, now: Date, pageCopyNote: String?) -> String {
        let seconds = Int(now.timeIntervalSince(fetchedAt).rounded(.down))
        let updated = seconds <= 2 ? "Updated just now" : "Updated \(seconds)s ago"
        guard let pageCopyNote, !pageCopyNote.isEmpty else { return updated }
        return "\(updated) · \(pageCopyNote)"
    }

    /// The page copy's problem for the status line: its reason while the server runs the page copy
    /// and the copy is not ok; else nil.
    public static func pageCopyNote(_ state: PageCopyState?, enabled: Bool) -> String? {
        guard enabled, let state, !state.ok else { return nil }
        return state.reason
    }

    /// The chat's session name, or the first 8 characters of its session id when it has none.
    public static func sessionName(_ host: HostCard) -> String {
        if let name = host.sessionName, !name.isEmpty { return name }
        return String(host.sessionId.prefix(8))
    }

    /// A live card's meta line: "Session: alpha · Model: model-a · Started: 5m ago".
    public static func liveMeta(_ host: HostCard, now: Date) -> String {
        "Session: \(sessionName(host)) · Model: \(host.model) · Started: \(relative(host.startedAt, now: now))"
    }

    /// A closed card's meta line: "Last active: 2h ago", plus "Profile: lab" when the long task ran
    /// under another profile than the server's main one. A nil profile is omp's default.
    public static func closedMeta(_ task: LongTask, mainProfile: String?, now: Date) -> String {
        let active = "Last active: \(relative(task.lastActiveAt, now: now))"
        guard task.profile != mainProfile else { return active }
        return "\(active) · Profile: \(task.profile ?? "default")"
    }

    /// When a job report was written, in calendar days: "today 03:04", "yesterday 09:00", "3d ago"
    /// (`formatReportTime`).
    public static func reportTime(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let clock = calendar.dateComponents([.hour, .minute], from: date)
        let hour = clock.hour ?? 0
        let minute = clock.minute ?? 0
        let time = "\(hour < 10 ? "0" : "")\(hour):\(minute < 10 ? "0" : "")\(minute)"
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)
        ).day ?? 0
        if days <= 0 { return "today \(time)" }
        if days == 1 { return "yesterday \(time)" }
        return "\(days)d ago"
    }

    /// The first line of a report's summary, which its line on a card shows.
    public static func firstLine(_ summary: String) -> String {
        String(summary.prefix { !$0.isNewline })
    }

    /// What the open tab says when it shows no card: it has none at all, or the search and the
    /// project hide them all (`renderHosts`). Nil while a card shows.
    public static func emptyState(
        tab: ListTab, tabCount: Int, liveCount: Int, shownCount: Int, search: String, selected: String?
    ) -> EmptyState? {
        if tabCount == 0 {
            if tab == .longTasks {
                return EmptyState(
                    title: "No long tasks yet",
                    hint: "Tap the pin on a chat to keep it here, or type /pin in that chat on the Mac. Long tasks stay here after their chat closes.")
            }
            if liveCount > 0 {
                return EmptyState(title: "Every live chat is a long task", hint: "Find them in the Long tasks tab.")
            }
            return EmptyState(
                title: "No active shared sessions",
                hint: "Sessions appear here when collab.autoStart is set to control or view in their profile and they were started after it was enabled.")
        }
        guard shownCount == 0 else { return nil }
        let kind = tab == .chats ? "chats" : "long tasks"
        let words = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let place = selected.map { " in \($0)" } ?? ""
        let hint: String
        if selected == nil {
            hint = tab == .chats
                ? "Search checks the session name and the folder. Clear the box to see every chat."
                : "Search checks the title and the folder. Clear the box to see every long task."
        } else if words.isEmpty {
            hint = "Tap All to see every project."
        } else {
            hint = "Search checks the name and the folder. Clear the box or tap All to see more."
        }
        let title = words.isEmpty ? "No \(kind)\(place)" : "No \(kind)\(place) match “\(words)”"
        return EmptyState(title: title, hint: hint)
    }
}
