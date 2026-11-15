import Foundation

/// The push texts Settings shows that depend on what iOS or the server answered.
public enum PushText {
    /// Without the Push Notifications capability, which only a paid team can sign.
    public static let paidTeam = "Push needs a paid Apple Developer Program team."

    /// The server runs push but has no key for the environment this build registers with.
    public static func noKey(_ environment: String) -> String {
        "This server has no APNs key for \(environment)."
    }

    /// iOS gave no device token. A build without the `aps-environment` entitlement gets Cocoa error
    /// 3000, "no valid “aps-environment” entitlement string found for application".
    public static func registrationFailed(domain: String, code: Int, description: String) -> String {
        if (domain == NSCocoaErrorDomain && code == 3000) || description.contains("aps-environment") {
            return paidTeam
        }
        return "This device could not register for notifications: \(description)"
    }

    /// Send test failed. A 502 means APNs refused the notification or could not be reached; the server's
    /// message names APNs's reason, so it does not get the "could not run omp" text.
    public static func testFailed(_ error: APIError) -> String {
        if case .http(502, let message, _) = error { return "Not sent: \(message)" }
        return error.message
    }
}
