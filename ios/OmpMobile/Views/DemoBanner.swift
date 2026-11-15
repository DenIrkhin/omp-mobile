import SwiftUI

/// Over the demo's list: the data is made up, and Connect your Mac leaves the demo for the server address.
struct DemoBanner: View {
    let onConnect: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "sparkles")
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            Text("Demo with sample data")
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Connect your Mac", action: onConnect)
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("demo.connect")
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("demo.banner")
    }
}
