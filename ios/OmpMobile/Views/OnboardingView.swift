import OmpKit
import SwiftUI

/// First run: what the app needs, with Try the demo, then the server address with Connect, then, when the
/// server has push on, Allow or Not now for notifications. Saving the checked address ends onboarding;
/// Try the demo shows the list with sample data instead.
struct OnboardingView: View {
    private enum Step {
        case needs, address, notifications
    }

    @Environment(AppModel.self) private var model
    @AppStorage("serverURL") private var serverURL = ""
    @AppStorage("demo") private var demo = false
    @State private var step: Step
    @State private var address = ""
    @State private var check = ServerCheck()
    @State private var isAllowing = false

    /// Connect your Mac in the demo starts at the address.
    init(startsAtAddress: Bool = false) {
        _step = State(initialValue: startsAtAddress ? .address : .needs)
    }

    var body: some View {
        NavigationStack {
            switch step {
            case .needs: needs
            case .address: server
            case .notifications: notifications
            }
        }
        .onAppear { model.onboardingAtAddress = false }
    }

    private var needs: some View {
        Form {
            Section("What you need") {
                Label("The omp mobile server running on your Mac.", systemImage: "desktopcomputer")
                Label("Tailscale connected on this device, signed in with a login the server allows.", systemImage: "network")
            }
            Section {
                Button("Continue") { step = .address }
                    .accessibilityIdentifier("onboarding.next")
                Button("Try the demo") { demo = true }
                    .accessibilityIdentifier("onboarding.demo")
            } footer: {
                Text("The demo shows sample chats and job reports. It needs no Mac and sends nothing over the network.")
            }
        }
        .navigationTitle("omp mobile")
    }

    private var server: some View {
        Form {
            Section {
                ServerAddressField(text: $address)
                    .onSubmit { connect() }
                    .accessibilityIdentifier("onboarding.address")
                Button {
                    connect()
                } label: {
                    HStack {
                        Text("Connect")
                        Spacer()
                        if check.isChecking { ProgressView() }
                    }
                }
                .disabled(check.isChecking)
                .accessibilityIdentifier("onboarding.connect")
                if let outcome = check.outcome {
                    ServerCheckRow(outcome: outcome)
                }
            } header: {
                Text("Server address")
            } footer: {
                Text("The address tailscale serve gives your Mac, like my-mac.example.ts.net.")
            }
            if let verified = check.verified {
                Section {
                    Button("Continue") {
                        if verified.info.features.push {
                            step = .notifications
                        } else {
                            save(verified)
                        }
                    }
                    .accessibilityIdentifier("onboarding.continue")
                }
            }
        }
        .navigationTitle("Server")
        .onChange(of: address) { check.reset() }
    }

    private var notifications: some View {
        Form {
            Section("Notifications") {
                Label("Get a notification when a chat needs your input or a job fails. Settings chooses which kinds.", systemImage: "bell.badge")
            }
            Section {
                Button {
                    allow()
                } label: {
                    HStack {
                        Text("Allow")
                        Spacer()
                        if isAllowing { ProgressView() }
                    }
                }
                .disabled(isAllowing)
                .accessibilityIdentifier("onboarding.allow")
                Button("Not now") {
                    if let verified = check.verified { save(verified) }
                }
                .disabled(isAllowing)
                .accessibilityIdentifier("onboarding.notNow")
            }
        }
        .navigationTitle("Notifications")
    }

    private func connect() {
        check.connect(address, using: model)
    }

    /// Asks iOS for permission, then saves the address; the device registers when the first info reply
    /// from the saved server arrives.
    private func allow() {
        guard let verified = check.verified else { return }
        isAllowing = true
        let push = model.push
        Task {
            await push.turnOn()
            save(verified)
        }
    }

    private func save(_ verified: ServerCheck.Verified) {
        model.info = verified.info
        serverURL = verified.url.absoluteString
    }
}
