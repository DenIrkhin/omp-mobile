import Foundation

/// The New session sheet's rules: the phone page's launch dialog (`openLaunchDialog` in
/// `server/public/app.js`) plus the app's optional spend cap, which the server reads as `maxCost`.
public enum NewSession {
    /// The folder and model the sheet starts with.
    public struct Choice: Sendable, Equatable {
        public let folder: String
        public let model: String
    }

    /// What the spend cap field holds.
    public enum SpendCap: Sendable, Equatable {
        /// Empty: the chat starts without a cap.
        case noCap
        /// A cap the server accepts, in USD.
        case usd(Double)
        /// Something the server would refuse with 400.
        case invalid
    }

    /// The highest cap the server accepts, in USD (`MAX_LAUNCH_COST` in `server/launch.ts`).
    public static let maxSpendCap: Double = 500

    /// The remembered folder and model while the server still offers them; else the top folder, which
    /// the server lists first, and the server's default model. Nil when the server offers no folder.
    public static func initialChoice(_ options: LaunchOptions, lastFolder: String?, lastModel: String?) -> Choice? {
        guard let top = options.folders.first else { return nil }
        let folder = lastFolder.flatMap { options.folders.contains($0) ? $0 : nil } ?? top
        let model = lastModel.flatMap { last in options.models.contains { $0.id == last } ? last : nil }
            ?? options.defaultModel
        return Choice(folder: folder, model: model)
    }

    /// A folder's last path part, as the page's `leafName`.
    public static func leafName(_ folder: String) -> String {
        folder.split(separator: "/").last.map(String.init) ?? folder
    }

    /// The folder picker's text: "<name> (top folder)" for the first folder, else its name.
    public static func folderLabel(_ folder: String, in options: LaunchOptions) -> String {
        folder == options.folders.first ? "\(leafName(folder)) (top folder)" : leafName(folder)
    }

    /// Reads the spend cap field. Empty is no cap. Otherwise a number with "." or the locale's decimal
    /// separator, above 0 and at most 500, that rounds to at least one cent (`validateLaunchRequest`
    /// in `server/launch.ts`).
    public static func spendCap(_ text: String, locale: Locale) -> SpendCap {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .noCap }
        let separator = locale.decimalSeparator ?? "."
        let normalized = separator == "." ? trimmed : trimmed.replacingOccurrences(of: separator, with: ".")
        guard let value = Double(normalized), value.isFinite, value > 0, value <= maxSpendCap,
              (value * 100).rounded() >= 1
        else { return .invalid }
        return .usd(value)
    }
}
