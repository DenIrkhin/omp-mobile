import Foundation

/// What onboarding and Settings show after Connect.
public enum ConnectResult: Equatable, Sendable {
    case connected(summary: String)
    case failed(APIError)

    /// Checks the API version of a `GET /api/v1/info` reply and builds the line that names the login and versions.
    public static func evaluate(_ info: ServerInfo) -> ConnectResult {
        guard info.apiVersion == 1 else { return .failed(.incompatible(info.apiVersion)) }
        var summary = "Connected as \(info.login) · server \(info.serverVersion)"
        if let omp = info.ompVersion { summary += " · omp \(omp)" }
        return .connected(summary: summary)
    }

    /// The text the app shows: the summary, or the error's message.
    public var message: String {
        switch self {
        case .connected(let summary): summary
        case .failed(let error): error.message
        }
    }
}
