import OmpKit
import SwiftUI

/// Settings: the server address with the same check as onboarding (Leave demo in the demo), the appearance,
/// notifications, clearing the chats' cached transcripts, the web dashboard and the versions.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @AppStorage("serverURL") private var serverURL = ""
    @AppStorage("theme") private var theme: Theme = .system
    @AppStorage("demo") private var demo = false
    @Environment(\.dismiss) private var dismiss
    // The push switches. The kinds start as the server's defaults: input and failed reports on.
    @AppStorage("push.enabled") private var pushEnabled = false
    @AppStorage("push.input") private var pushInput = true
    @AppStorage("push.reportFailed") private var pushReportFailed = true
    @AppStorage("push.reportUpdate") private var pushReportUpdate = false
    @AppStorage("push.turnDone") private var pushTurnDone = false
    @State private var address = ""
    @State private var check = ServerCheck()
    @State private var confirmClear = false
    @State private var cacheCleared = false

    var body: some View {
        Form {
            if demo {
                Section {
                    Button("Leave demo") { leaveDemo() }
                        .accessibilityIdentifier("settings.leaveDemo")
                } header: {
                    Text("Demo")
                } footer: {
                    Text("The list shows sample data. Leave the demo to connect your Mac.")
                }
            } else {
                Section {
                    ServerAddressField(text: $address)
                        .onSubmit { runCheck() }
                        .accessibilityIdentifier("settings.address")
                    Button {
                        runCheck()
                    } label: {
                        HStack {
                            Text("Check")
                            Spacer()
                            if check.isChecking { ProgressView() }
                        }
                    }
                    .disabled(check.isChecking)
                    .accessibilityIdentifier("settings.check")
                    if let outcome = check.outcome {
                        ServerCheckRow(outcome: outcome)
                    }
                    if let verified = check.verified {
                        Button("Save") { save(verified) }
                            .accessibilityIdentifier("settings.save")
                    }
                } header: {
                    Text("Server")
                }
            }

            Section("Appearance") {
                Picker("Appearance", selection: $theme) {
                    ForEach(Theme.allCases, id: \.self) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("settings.appearance")
            }

            notifications

            if !demo {
                Section {
                    Button("Clear cached transcripts", role: .destructive) { confirmClear = true }
                        .accessibilityIdentifier("settings.clearCache")
                        .confirmationDialog("Clear cached transcripts?", isPresented: $confirmClear, titleVisibility: .visible) {
                            Button("Clear", role: .destructive) { clearCache() }
                        } message: {
                            Text("Removes the transcript copies and the chat name this device keeps for this server, and closes the open chat.")
                        }
                } header: {
                    Text("Chats")
                } footer: {
                    Text(cacheCleared
                        ? "Cached transcripts cleared."
                        : "Chats keep an encrypted copy of each transcript on this device, so they show at once while the live chat loads.")
                        .accessibilityIdentifier("settings.cacheStatus")
                }

                Section {
                    Button("Open web dashboard") {
                        if let url = URL(string: serverURL) { openURL(url) }
                    }
                    .accessibilityIdentifier("settings.openDashboard")
                } footer: {
                    Text("Opens the dashboard in the browser, for Manage and the rest of the web page.")
                }
            }

            Section("About") {
                LabeledContent("App", value: Bundle.main.appVersion)
                LabeledContent("Server", value: model.info?.serverVersion ?? "—")
                LabeledContent("omp", value: model.info?.ompVersion ?? "—")
            }
        }
        .navigationTitle("Settings")
        .onAppear { address = serverURL }
        .onChange(of: address) { check.reset() }
    }

    /// The switch, how push stands on this device, Send test, and one switch per kind; a kind's change
    /// registers the device again.
    @ViewBuilder
    private var notifications: some View {
        let push = model.push
        if model.info?.features.push == true {
            Section {
                Toggle("Notifications", isOn: Binding(
                    get: { pushEnabled },
                    set: { on in
                        Task {
                            if on {
                                await push.turnOn()
                            } else {
                                await push.turnOff()
                            }
                        }
                    }))
                    .accessibilityIdentifier("settings.push")
                Text(push.status.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.pushStatus")
                Button {
                    Task { await push.sendTest() }
                } label: {
                    HStack {
                        Text("Send test")
                        Spacer()
                        if push.isTesting { ProgressView() }
                    }
                }
                .disabled(push.status != .on || push.isTesting)
                .accessibilityIdentifier("settings.pushTest")
                if let result = push.testResult {
                    Text(result)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("settings.pushTestResult")
                }
                Toggle("Chat needs input", isOn: $pushInput)
                    .disabled(!pushEnabled)
                Toggle("Job failed", isOn: $pushReportFailed)
                    .disabled(!pushEnabled)
                Toggle("Job update", isOn: $pushReportUpdate)
                    .disabled(!pushEnabled)
                Toggle("Long task finished", isOn: $pushTurnDone)
                    .disabled(!pushEnabled)
            } header: {
                Text("Notifications")
            } footer: {
                Text("Job failed and Job update come from job reports. Long task finished comes when a pinned chat that worked for 2 minutes or more goes idle.")
            }
            .onChange(of: [pushInput, pushReportFailed, pushReportUpdate, pushTurnDone]) {
                Task { await push.register() }
            }
        } else {
            Section("Notifications") {
                Text("Notifications are off on this server.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.pushStatus")
            }
        }
    }

    private func runCheck() {
        check.connect(address, using: model)
    }

    private func save(_ verified: ServerCheck.Verified) {
        model.info = verified.info
        serverURL = verified.url.absoluteString
        address = serverURL
        check.reset()
    }

    /// Closes Settings, then leaves the demo for onboarding's first step.
    private func leaveDemo() {
        dismiss()
        model.leaveDemo()
        demo = false
    }

    private func clearCache() {
        guard let host = URL(string: serverURL)?.host() else { return }
        Task {
            await model.chats.clearCachedTranscripts(serverHost: host)
            cacheCleared = true
        }
    }
}
