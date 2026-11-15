import SwiftUI

/// The server address field of onboarding and Settings: URL keyboard, no capitals, no autocorrect.
struct ServerAddressField: View {
    @Binding var text: String

    var body: some View {
        TextField("my-mac.example.ts.net", text: $text)
            .keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .accessibilityLabel("Server address")
    }
}
