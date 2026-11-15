import Foundation
import Testing
import OmpKit

/// Which APNs environment a device build registers with. A wrong one means the server's notifications
/// never arrive: Apple accepts a token only in the environment that issued it.
struct PushEnvironmentTests {
    /// A provisioning profile as a build carries it: the property list between the bytes of the
    /// signature around it.
    private func profile(entitlements: String) -> Data {
        let plist = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>AppIDName</key>
                <string>alpha</string>
                <key>Entitlements</key>
                <dict>
                    <key>application-identifier</key>
                    <string>TEAMID1234.io.github.example.ompmobile</string>
            \(entitlements)
                </dict>
                <key>Name</key>
                <string>bravo development</string>
            </dict>
            </plist>
            """
        return Data([0x30, 0x82, 0x2E, 0x4B, 0x06, 0x09, 0x2A, 0x86]) + Data(plist.utf8) + Data([0xA0, 0x82, 0x0D, 0x00])
    }

    @Test func noProfileIsTestFlightOrAppStore() {
        #expect(PushEnvironment.forProfile(nil) == "production")
    }

    @Test func developmentProfileUsesTheSandbox() {
        let data = profile(entitlements: "<key>aps-environment</key><string>development</string>")
        #expect(PushEnvironment.forProfile(data) == "sandbox")
    }

    @Test func productionProfileUsesProduction() {
        let data = profile(entitlements: "<key>aps-environment</key><string>production</string>")
        #expect(PushEnvironment.forProfile(data) == "production")
    }

    @Test func profileWithoutPushOrUnreadableUsesTheSandbox() {
        #expect(PushEnvironment.forProfile(profile(entitlements: "")) == "sandbox")
        #expect(PushEnvironment.forProfile(Data([0x30, 0x82, 0x00, 0x01])) == "sandbox")
    }
}
