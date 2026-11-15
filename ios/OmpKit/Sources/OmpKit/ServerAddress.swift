import Foundation

/// Why a typed server address was refused; `message` is the text the app shows under the field.
public enum ServerAddressError: Error, Equatable, Sendable {
    case empty, notHTTPS, notOrigin, invalid

    public var message: String {
        switch self {
        case .empty:
            "Enter the server address."
        case .notHTTPS:
            "Use an https address like https://my-mac.example.ts.net."
        case .notOrigin:
            "Enter only the server address, like my-mac.example.ts.net, with no path."
        case .invalid:
            "That is not a server address. Use one like my-mac.example.ts.net."
        }
    }
}

public enum ServerAddress {
    /// Turns what the user typed (`host`, `host:port` or `https://host[:port]`) into the server's origin:
    /// `https://host[:port]` with the host lowercased, no path, and port 443 dropped.
    public static func parse(_ input: String) -> Result<URL, ServerAddressError> {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(.empty) }
        if text.unicodeScalars.contains(where: CharacterSet.whitespacesAndNewlines.contains) {
            return .failure(.invalid)
        }
        guard let parts = URLComponents(string: text.contains("://") ? text : "https://" + text) else {
            return .failure(.invalid)
        }
        if parts.scheme?.lowercased() != "https" { return .failure(.notHTTPS) }
        if parts.user != nil || parts.password != nil || parts.query != nil || parts.fragment != nil
            || !(parts.path.isEmpty || parts.path == "/") {
            return .failure(.notOrigin)
        }
        guard let host = parts.host?.lowercased(), !host.isEmpty,
              host.unicodeScalars.allSatisfy(hostScalars.contains),
              !host.hasPrefix("."), !host.hasSuffix("."), !host.hasPrefix("-"), !host.hasSuffix("-")
        else { return .failure(.invalid) }
        if let port = parts.port, !(1...65535).contains(port) { return .failure(.invalid) }
        var origin = URLComponents()
        origin.scheme = "https"
        origin.host = host
        origin.port = parts.port == 443 ? nil : parts.port
        guard let url = origin.url else { return .failure(.invalid) }
        return .success(url)
    }

    private static let hostScalars = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-")
}
