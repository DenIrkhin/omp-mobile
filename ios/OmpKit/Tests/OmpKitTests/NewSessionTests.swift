import Foundation
import Testing
@testable import OmpKit

private let options = LaunchOptions(
    folders: ["/Users/you/dev", "/Users/you/dev/alpha", "/Users/you/dev/bravo"],
    models: [.init(id: "default", label: "Profile default"), .init(id: "fast", label: "Fast")],
    defaultModel: "default")

@Suite struct NewSessionTests {
    @Test func keepsTheRememberedChoices() {
        #expect(NewSession.initialChoice(options, lastFolder: "/Users/you/dev/bravo", lastModel: "fast")
            == NewSession.Choice(folder: "/Users/you/dev/bravo", model: "fast"))
    }

    @Test func fallsBackToTheTopFolderAndTheDefaultModel() {
        let top = NewSession.Choice(folder: "/Users/you/dev", model: "default")
        #expect(NewSession.initialChoice(options, lastFolder: "/Users/you/dev/gone", lastModel: "retired") == top)
        #expect(NewSession.initialChoice(options, lastFolder: nil, lastModel: nil) == top)
    }

    @Test func labelsTheTopFolder() {
        #expect(NewSession.folderLabel("/Users/you/dev", in: options) == "dev (top folder)")
        #expect(NewSession.folderLabel("/Users/you/dev/alpha", in: options) == "alpha")
    }

    @Test func readsTheSpendCap() {
        let us = Locale(identifier: "en_US")
        let de = Locale(identifier: "de_DE")
        #expect(NewSession.spendCap("", locale: us) == .noCap)
        #expect(NewSession.spendCap("  ", locale: us) == .noCap)
        #expect(NewSession.spendCap("5", locale: us) == .usd(5))
        #expect(NewSession.spendCap("2.5", locale: us) == .usd(2.5))
        #expect(NewSession.spendCap("2,5", locale: de) == .usd(2.5))
        #expect(NewSession.spendCap("2.5", locale: de) == .usd(2.5))
        #expect(NewSession.spendCap("500", locale: us) == .usd(500))
    }

    @Test func refusesACapTheServerRefuses() {
        let us = Locale(identifier: "en_US")
        for text in ["0", "0.004", "-1", "500.01", "abc", "inf", "nan", "2,5"] {
            #expect(NewSession.spendCap(text, locale: us) == .invalid, "\(text)")
        }
    }
}
