import OmpKit
import SwiftUI

@main
struct OmpMobileApp: App {
    /// Owns the `AppModel`, so the APNs token and tapped notifications reach the state the screens use.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @AppStorage("theme") private var theme: Theme = .system

    init() {
        #if DEBUG
        // UI tests pass -ui-testing-reset so that every run starts at the first run, with nothing saved.
        if ProcessInfo.processInfo.arguments.contains("-ui-testing-reset"),
           let domain = Bundle.main.bundleIdentifier {
            UserDefaults.standard.removePersistentDomain(forName: domain)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appDelegate.model)
                .preferredColorScheme(theme.colorScheme)
        }
    }
}
