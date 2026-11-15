import Foundation

/// Settings → Clear cached transcripts: which of the app's stored website data is the chat page's.
/// WebKit names each record by domain, without a port, so the page copy's `https://<server>:8443`
/// data sits in a record named after the server's host or one of its parent domains.
public enum CachedTranscripts {
    /// True when the record's name is the server's host or one of its parent domains, compared by
    /// whole labels and without case.
    public static func isServerRecord(_ displayName: String, serverHost: String) -> Bool {
        let name = displayName.lowercased()
        let host = serverHost.lowercased()
        guard !name.isEmpty else { return false }
        return host == name || host.hasSuffix("." + name)
    }
}
