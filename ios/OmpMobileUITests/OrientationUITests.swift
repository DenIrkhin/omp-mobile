import UIKit
import XCTest

/// The orientation rules of `Config/Base.xcconfig`: portrait only on iPhone, every orientation on
/// iPad. Each test skips on the other kind of device, so the one scheme runs on both simulators.
final class OrientationUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Turning an iPhone to landscape leaves the app's window portrait.
    @MainActor
    func testIPhoneStaysPortrait() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhone only")
        let frame = windowFrameAfterTurningToLandscape()
        XCTAssertLessThan(frame.width, frame.height)
    }

    /// Turning an iPad to landscape turns the app's window with it.
    @MainActor
    func testIPadRotates() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad only")
        let frame = windowFrameAfterTurningToLandscape()
        XCTAssertGreaterThan(frame.width, frame.height)
    }

    /// Starts the app at first run in portrait, turns the device to landscape and returns the window's
    /// frame two seconds later. The device is back in portrait before the caller checks the frame, so
    /// a failed check does not leave the Simulator turned.
    @MainActor
    private func windowFrameAfterTurningToLandscape() -> CGRect {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing-reset"]
        app.launch()
        XCTAssertTrue(app.buttons["onboarding.next"].waitForExistence(timeout: 10))

        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        let turned = XCUIDevice.shared.orientation
        let frame = app.windows.firstMatch.frame
        XCUIDevice.shared.orientation = .portrait
        XCTAssertEqual(turned, .landscapeLeft)
        return frame
    }
}
