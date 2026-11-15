import XCTest

final class OnboardingUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// An address whose name does not resolve gets the Tailscale hint under the field.
    @MainActor
    func testUnknownHostShowsTailscaleHint() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing-reset"]
        app.launch()

        app.buttons["onboarding.next"].tap()
        let field = app.textFields["onboarding.address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("https://nope.tail0000.ts.net")
        app.buttons["onboarding.connect"].tap()

        let message = app.staticTexts["server.message"]
        XCTAssertTrue(message.waitForExistence(timeout: 20))
        XCTAssertEqual(message.label, "Can't find nope.tail0000.ts.net. Is Tailscale connected on this device?")
    }
}
