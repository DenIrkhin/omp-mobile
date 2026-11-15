import Foundation

public enum NavigationPolicy {
    public enum Decision: Sendable, Equatable {
        case allow, openExternally, cancel
    }

    /// What the chat web view does with a main-frame navigation: the chat's own origin loads in
    /// place, a link the user tapped to anywhere else opens in the default browser, and any other
    /// navigation is dropped.
    public static func decide(url: URL, chatURL: URL, userInitiated: Bool) -> Decision {
        if let origin = Origin(url), origin == Origin(chatURL) { return .allow }
        return userInitiated ? .openExternally : .cancel
    }

    /// Scheme, host and port. A URL without a host has no origin and matches nothing.
    private struct Origin: Equatable {
        let scheme: String
        let host: String
        let port: Int?

        init?(_ url: URL) {
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let scheme = components.scheme?.lowercased(),
                  let host = components.host?.lowercased(), !host.isEmpty
            else { return nil }
            self.scheme = scheme
            self.host = host
            self.port = components.port ?? Self.defaultPorts[scheme]
        }

        private static let defaultPorts = ["http": 80, "https": 443]
    }
}
