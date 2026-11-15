import Foundation

/// The app's appearance setting. The chat page accepts exactly these `theme` values.
public enum Theme: String, Sendable, CaseIterable {
    case system, light, dark
}

public enum ChatURL {
    /// The chat URL with `theme` set, as the web page's `withTheme` does: the first `theme` item
    /// takes the new value in place and later ones go, else one is appended. Every other item stays
    /// exactly as minted, and so does the `#` fragment, which holds the room key.
    public static func themed(_ url: URL, theme: Theme) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        var items = components.percentEncodedQueryItems ?? []
        if let first = items.firstIndex(where: { $0.name == "theme" }) {
            items[first].value = theme.rawValue
            items = items.enumerated()
                .filter { $0.offset == first || $0.element.name != "theme" }
                .map(\.element)
        } else {
            items.append(URLQueryItem(name: "theme", value: theme.rawValue))
        }
        components.percentEncodedQueryItems = items
        return components.url ?? url
    }
}
