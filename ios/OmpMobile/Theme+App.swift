import OmpKit
import SwiftUI

extension Theme {
    /// The color scheme the app asks for; nil follows the device.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// The name on the Appearance control in Settings.
    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}
