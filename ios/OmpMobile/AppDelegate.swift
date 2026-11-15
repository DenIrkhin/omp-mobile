import OmpKit
import UIKit
import UserNotifications

/// The app's UIKit delegate: the APNs device token, and the notifications iOS shows while the app is in
/// front or the user taps. It owns the `AppModel`, so a tap that launched the app reaches the model the
/// screens use. The notification methods run on the main actor and call their completion handler there:
/// UIKit aborts when a tap's handler runs on another thread.
final class AppDelegate: NSObject, UIApplicationDelegate, @MainActor UNUserNotificationCenterDelegate {
    let model = AppModel()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Before launch ends, so the tap that launched the app arrives in didReceive.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        let push = model.push
        Task { await push.received(token: token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        let error = error as NSError
        model.push.registrationFailed(domain: error.domain, code: error.code, description: error.localizedDescription)
    }

    /// A notification while the app is in front: no banner for the chat on screen; the list refreshes.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler(model.presentation(for: PushRoute(userInfo: notification.request.content.userInfo)))
    }

    /// A tapped notification: it opens what it is about once the next list is in.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let route = PushRoute(userInfo: response.notification.request.content.userInfo) {
            model.receiveTap(route)
        }
        completionHandler()
    }
}
