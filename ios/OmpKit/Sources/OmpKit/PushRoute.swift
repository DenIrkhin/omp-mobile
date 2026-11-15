import Foundation

/// What a notification from the server is about: its `omp` object (`api/v1/README.md`, "Push
/// notifications"). The app reads it from a notification's `userInfo` to decide what a tap opens.
public enum PushRoute: Sendable, Equatable {
    /// A chat started to need input. Its instance and generation may have changed since.
    case input(sessionId: String, instanceId: String, generation: Int)
    /// A job report with outcome `failed` or `update`.
    case report(sessionId: String, reportId: String, job: String, outcome: ReportOutcome, at: Date)
    /// A pinned chat finished a long turn.
    case turnDone(sessionId: String)
    /// Settings' Send test.
    case test

    /// Reads `userInfo["omp"]`. Nil when `v` is not 1, the kind is unknown, or a field the kind needs
    /// is missing or of the wrong type.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let omp = userInfo["omp"] as? [String: Any],
              JSONSerialization.isValidJSONObject(omp),
              let data = try? JSONSerialization.data(withJSONObject: omp),
              let fields = try? OmpJSON.decoder.decode(Fields.self, from: data),
              fields.v == 1
        else { return nil }
        switch fields.kind {
        case "input":
            guard let sessionId = fields.sessionId, let instanceId = fields.instanceId,
                  let generation = fields.generation
            else { return nil }
            self = .input(sessionId: sessionId, instanceId: instanceId, generation: generation)
        case "report":
            guard let sessionId = fields.sessionId, let reportId = fields.reportId, let job = fields.job,
                  let outcome = fields.outcome, let at = fields.at
            else { return nil }
            self = .report(sessionId: sessionId, reportId: reportId, job: job, outcome: outcome, at: at)
        case "turnDone":
            guard let sessionId = fields.sessionId else { return nil }
            self = .turnDone(sessionId: sessionId)
        case "test":
            self = .test
        default:
            return nil
        }
    }

    /// The chat the notification is about; nil for a test.
    public var sessionId: String? {
        switch self {
        case .input(let sessionId, _, _), .report(let sessionId, _, _, _, _), .turnDone(let sessionId):
            sessionId
        case .test:
            nil
        }
    }

    /// Where a tap goes, once the first list after the tap is in. The chat is looked up by its session,
    /// because its instance and generation may have changed since the notification.
    public func destination(in entries: (chats: [SessionEntry], longTasks: [SessionEntry])) -> PushDestination {
        switch self {
        case .input(let sessionId, _, _):
            if let entry = (entries.chats + entries.longTasks).first(where: { $0.host?.sessionId == sessionId }),
               let host = entry.host {
                return .chat(entry, access: host.access)
            }
            if let entry = entries.longTasks.first(where: { $0.sessionId == sessionId }) {
                return .card(entry, tab: .longTasks, reportId: nil)
            }
            return .ended
        case .report(let sessionId, let reportId, let job, let outcome, let at):
            return Self.card(sessionId, reportId: reportId, in: entries) ?? .report(job: job, outcome: outcome, at: at)
        case .turnDone(let sessionId):
            return Self.card(sessionId, reportId: nil, in: entries) ?? .ended
        case .test:
            return .refreshOnly
        }
    }

    /// The session's card: on Long tasks first, where reports and finished turns usually belong, else on
    /// Chats.
    private static func card(
        _ sessionId: String, reportId: String?, in entries: (chats: [SessionEntry], longTasks: [SessionEntry])
    ) -> PushDestination? {
        if let entry = entries.longTasks.first(where: { $0.sessionId == sessionId }) {
            return .card(entry, tab: .longTasks, reportId: reportId)
        }
        if let entry = entries.chats.first(where: { $0.sessionId == sessionId }) {
            return .card(entry, tab: .chats, reportId: reportId)
        }
        return nil
    }

    private struct Fields: Decodable {
        let v: Int
        let kind: String
        let sessionId: String?
        let instanceId: String?
        let generation: Int?
        let reportId: String?
        let job: String?
        let outcome: ReportOutcome?
        let at: Date?
    }
}

/// What a tapped notification opens.
public enum PushDestination: Sendable, Equatable {
    /// The live chat, in Control when the server allows it, else watching; no confirm dialog.
    case chat(SessionEntry, access: Access)
    /// The card on its tab, with project All and no search, scrolled to and highlighted; the report
    /// with `reportId` opens.
    case card(SessionEntry, tab: ListTab, reportId: String?)
    /// A report whose card is gone: a sheet with the notification's job, outcome and time.
    case report(job: String, outcome: ReportOutcome, at: Date)
    /// The toast "That chat has ended."
    case ended
    /// Only the refresh, as for a test notification.
    case refreshOnly
}
