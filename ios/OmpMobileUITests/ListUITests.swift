import XCTest

final class ListUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// With a saved address whose name does not resolve and no list yet, the list screen says why and
    /// offers Retry.
    @MainActor
    func testUnreachableServerShowsErrorView() throws {
        let app = XCUIApplication()
        // -serverURL sets the saved address for this run only. -ui-testing-reset goes last, so it is
        // not read as that setting's value.
        app.launchArguments = ["-serverURL", "https://nope.tail0000.ts.net", "-ui-testing-reset"]
        app.launch()

        let message = "Can't find nope.tail0000.ts.net. Is Tailscale connected on this device?"
        let text = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", message)).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Retry"].exists)
    }
}
