import Foundation
import Observation
import OmpKit
import UIKit
import UserNotifications

/// Push on this device: the notification permission, the APNs device token, and this device's
/// registration with the saved server. The token stays in memory: Apple issues new ones and advises
/// against keeping them, so the app asks iOS for it at every launch.
@MainActor
@Observable
final class PushManager {
    /// How push stands on this device; Settings shows `text`.
    enum Status: Equatable {
        /// iOS has not asked the user yet.
        case notAsked
        /// The user turned notifications off for the app in iOS.
        case denied
        /// The Notifications switch in Settings is off.
        case off
        /// Waiting for iOS's token or the server's answer.
        case registering
        /// The server has this device.
        case on
        case failed(String)

        var text: String {
            switch self {
            case .notAsked: "Not turned on yet."
            case .denied: "Notifications are off for omp mobile in the iOS Settings app."
            case .off: "Off. The server sends this device nothing."
            case .registering: "Turning on…"
            case .on: "On. The server sends the kinds turned on below."
            case .failed(let message): message
            }
        }
    }

    /// The APNs environment this build registers with: the sandbox on the Simulator; on a device, the one
    /// its provisioning profile names, or production for TestFlight and App Store installs, which carry no
    /// profile.
    static let environment: String = {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
        return PushEnvironment.forProfile(profile)
        #endif
    }()

    private(set) var status = Status.notAsked
    /// This launch's device token in hex, once iOS gave one.
    private(set) var token: String?
    /// True while Send test waits for the server.
    private(set) var isTesting = false
    /// What the last Send test came to: "Sent", or why not.
    private(set) var testResult: String?

    @ObservationIgnored private var server: APIClient?
    @ObservationIgnored private var info: ServerInfo?

    /// The Settings switch, `@AppStorage("push.enabled")`: off until Allow or the switch turns it on.
    private var enabled: Bool { UserDefaults.standard.bool(forKey: "push.enabled") }

    /// After each `GET /api/v1/info` from the saved server (launch, back in front, a new address): asks
    /// iOS for the token when the switch is on, the user allowed notifications, and the server runs push
    /// with a key for this build's environment.
    func sync(server: APIClient, info: ServerInfo) async {
        self.server = server
        self.info = info
        guard info.features.push else { return }
        let authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard server.baseURL == self.server?.baseURL else { return }
        switch authorization {
        case .notDetermined:
            status = .notAsked
        case .denied:
            status = .denied
        default:
            if !enabled {
                status = .off
            } else if info.push?.environments.contains(Self.environment) != true {
                status = .failed(PushText.noKey(Self.environment))
            } else {
                if status != .on { status = .registering }
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Onboarding's Allow and the Settings switch: turns push on here and asks iOS for permission. iOS
    /// shows its alert once; later calls return the user's answer.
    func turnOn() async {
        UserDefaults.standard.set(true, forKey: "push.enabled")
        let allowed = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
        guard allowed else {
            status = .denied
            return
        }
        if let server, let info { await sync(server: server, info: info) }
    }

    /// The Settings switch off: the server forgets this device and sends it nothing more.
    func turnOff() async {
        UserDefaults.standard.set(false, forKey: "push.enabled")
        status = .off
        testResult = nil
        guard let server, let token else { return }
        do {
            _ = try await server.removeDevice(token: token)
        } catch let failure as APIError {
            status = .failed("The server still has this device: \(failure.message)")
        } catch {}
    }

    /// From the app delegate: iOS gave this launch its token.
    func received(token: String) async {
        self.token = token
        await register()
    }

    /// From the app delegate: iOS gave no token.
    func registrationFailed(domain: String, code: Int, description: String) {
        token = nil
        status = .failed(PushText.registrationFailed(domain: domain, code: code, description: description))
    }

    /// `POST /api/v1/devices` with the token and the kind switches; Settings calls it again when a switch
    /// changes.
    func register() async {
        guard enabled, let server, let token, info?.features.push == true else { return }
        let registration = DeviceRegistration(
            token: token, environment: Self.environment, bundleId: Bundle.main.bundleIdentifier ?? "",
            appVersion: Bundle.main.appVersion, events: Self.events)
        do {
            _ = try await server.registerDevice(registration)
            guard server.baseURL == self.server?.baseURL else { return }
            status = .on
        } catch let failure as APIError {
            guard server.baseURL == self.server?.baseURL else { return }
            status = .failed(failure.message)
        } catch {}
    }

    /// Settings → Send test: one notification to this device through APNs.
    func sendTest() async {
        guard let server, let token, !isTesting else { return }
        isTesting = true
        defer { isTesting = false }
        do {
            _ = try await server.testPush(token: token)
            testResult = "Sent"
        } catch let failure as APIError {
            testResult = PushText.testFailed(failure)
        } catch {}
    }

    /// After each list while the app is in front: removes delivered "needs input" notifications of chats
    /// that no longer need input.
    func removeStaleInputBanners(_ response: HostsResponse) async {
        let waiting = Set(response.hosts.filter(\.inputRequired).map(\.sessionId))
        let center = UNUserNotificationCenter.current()
        let stale = await center.deliveredNotifications().compactMap { notification -> String? in
            guard case .input(let sessionId, _, _)? = PushRoute(userInfo: notification.request.content.userInfo),
                  !waiting.contains(sessionId)
            else { return nil }
            return notification.request.identifier
        }
        if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
    }

    /// The kind switches in Settings (`@AppStorage("push.input")` and so on), with the server's
    /// defaults: input and failed reports on, updates and finished turns off.
    private static var events: PushEvents {
        let defaults = UserDefaults.standard
        return PushEvents(
            input: defaults.object(forKey: "push.input") as? Bool ?? true,
            reportFailed: defaults.object(forKey: "push.reportFailed") as? Bool ?? true,
            reportUpdate: defaults.object(forKey: "push.reportUpdate") as? Bool ?? false,
            turnDone: defaults.object(forKey: "push.turnDone") as? Bool ?? false)
    }
}

extension Bundle {
    /// "<version> (<build>)", as Settings → About shows it and the device registration sends it.
    var appVersion: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
