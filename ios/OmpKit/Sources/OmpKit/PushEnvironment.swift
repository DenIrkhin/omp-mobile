import Foundation

/// The APNs environment a device build registers with, `sandbox` or `production`, read from the
/// provisioning profile the build carries.
public enum PushEnvironment {
    /// `profile` is the app's `embedded.mobileprovision`, or nil when the app has none.
    /// - An install from Xcode, or an ad hoc one, carries a profile. Its `aps-environment` entitlement
    ///   names the environment: `development` registers as `sandbox`, `production` as `production`.
    /// - TestFlight and App Store installs carry no profile and always use `production`.
    /// - A profile with no readable `aps-environment` cannot get a device token at all; it gets
    ///   `sandbox`, like any other install from Xcode.
    public static func forProfile(_ profile: Data?) -> String {
        guard let profile else { return "production" }
        return apsEnvironment(in: profile) == "production" ? "production" : "sandbox"
    }

    /// A profile is a signed message with the profile's property list inside, as XML: the bytes from
    /// `<?xml` through `</plist>`.
    private static func apsEnvironment(in profile: Data) -> String? {
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.upperBound..<profile.endIndex),
              let plist = try? PropertyListSerialization.propertyList(
                  from: profile.subdata(in: start.lowerBound..<end.upperBound), format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any]
        else { return nil }
        return entitlements["aps-environment"] as? String
    }
}
