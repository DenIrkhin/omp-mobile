import UIKit
import XCTest

/// The demo needs no server: Try the demo shows the sample list, Watch opens the bundled sample chat,
/// and Connect your Mac leaves the demo at the server address. On iPad it runs in landscape, where the
/// list stays beside the chat.
final class DemoUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testDemoTourEndsAtServerAddress() throws {
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        if isPad { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing-reset"]
        app.launch()

        let demo = app.buttons["onboarding.demo"]
        XCTAssertTrue(demo.waitForExistence(timeout: 10))
        demo.tap()
        XCTAssertTrue(app.staticTexts["Demo with sample data"].waitForExistence(timeout: 10))
        let card = app.descendants(matching: .any).matching(identifier: "card.demo-1").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))

        app.buttons["watch.demo-1"].tap()
        let page = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Sample chat")).firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 15))

        if !isPad {
            let back = app.navigationBars.buttons["BackButton"]
            (back.exists ? back : app.navigationBars.buttons.element(boundBy: 0)).tap()
        }
        let connect = app.buttons["demo.connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        connect.tap()
        XCTAssertTrue(app.textFields["onboarding.address"].waitForExistence(timeout: 10))
    }
}
