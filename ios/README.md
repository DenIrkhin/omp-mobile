# iOS

`OmpMobile.xcodeproj` is the iPhone and iPad app. `OmpKit/` is a Swift package, Foundation only, that the app builds on. It holds the models of the server's HTTP API (`api/v1/README.md`), a client for the routes the app calls, the error texts the app shows, what a notification from the server is about and where its tap goes, which APNs environment a device build registers with, the check of the server address a user types with the "Connected as …" line after Connect, and the rules the app shares with the phone page: the Chats and Long tasks lists with search and project chips, the theme on a chat link, which links stay in the app, the New session sheet's first choices and spend cap, and which stored website data belongs to the server.

## The app

Open `ios/OmpMobile.xcodeproj` in Xcode 27 or later and run the `OmpMobile` scheme on a simulator. At first run the app asks for the server address, the one `tailscale serve` gives your Mac (like `my-mac.example.ts.net`), checks it with Connect and saves it. Then it shows the session list, with the phone page's rules: the Chats and Long tasks tabs with their counts, search, and one project chip at a time. A card shows the chat's title, folder, status, session, model and start time, its job reports, and a pin that moves it between the tabs; a long task whose chat is closed shows when it was last active. Watch opens the chat in the app; Control asks first, because it gives full control of the session on the Mac. When the server runs New session, + starts a chat in a folder and with a model the server offers, with an optional spend cap, and opens it in Control at once; Reopen on a closed long task starts its chat again. The gear opens Settings, which changes the address, sets the appearance (System, Light or Dark), clears the chats' cached transcripts, opens the web dashboard in the browser, and shows the app, server and omp versions.

The list asks the server for `GET /api/v1/hosts` every 10 seconds while the app is in front, one request at a time, and at once when the app comes to the front, on pull to refresh or the refresh button, after a pin, a Reopen or a New session, and when the network comes back. In the background it asks nothing. `GET /api/v1/info` runs at launch, when the app comes to the front and after the address changes; the modules it names decide whether cards show pins and job reports. When a request fails, the last list stays, dimmed, under a banner with Retry; with no list yet, the screen says what failed and offers Retry.

A chat opens in the server's page copy inside the app: beside the list on iPad, on its own screen on iPhone. The toolbar has Back on iPhone, the chat's name with Watching or Control, and Reload, which asks the server for a fresh link. The app keeps the last chat's page loaded: back to the list and the same chat again shows it at once, with no new link and no reload. Another chat, a chat that restarted, the other access or a new appearance load a fresh page. Links to the page's own site stay in the app; a tapped link to any other site opens in the default browser. The page takes the app's appearance from its link. The page keeps an encrypted copy of each transcript and the chat name in the app's website data, so they survive a relaunch; Settings → Clear cached transcripts removes them for the server's sites only. Debug builds make the chat page inspectable: in Safari on the Mac, Develop → the simulator or device → the page.

When the server runs push, the first run has a third step: Allow asks iOS for permission, and Not now skips it. While notifications are allowed and on, the app asks iOS for its device token at every launch and sends it to the server (`POST /api/v1/devices`) with the kinds it wants; it keeps the token in memory only, as Apple advises. Settings → Notifications has the switch, which removes the device from the server when turned off, a line that says how push stands on this device, Send test, and one switch per kind: Chat needs input and Job failed start on, Job update and Long task finished start off. The app registers with the APNs environment of its build: the sandbox on the Simulator and for installs from Xcode, whose profile names `development`; production for TestFlight and App Store installs, which carry no profile, so the server needs `push.keys.production` for them. It needs the push entitlement, so a build without a paid team gets no token, and Settings says "Push needs a paid Apple Developer Program team." A notification about the chat on screen shows no banner; any notification refreshes the list, and each refresh removes "needs input" notifications of chats that no longer need input. A tap waits for the next list. A chat that needs input opens, in Control when the server allows it, with no confirm; a closed long task shows its card instead, and a chat that is gone gets "That chat has ended." A job report or a finished long task shows its card, highlighted, with the report open; a report whose card is gone shows in a sheet.

The first screen also offers Try the demo, which needs no Mac and no network. OmpKit's `DemoServer` answers the app's requests inside the app, through a `URLProtocol` on the address `https://demo.invalid`, a name that never resolves, so the list, search, chips, pins and error handling run the same code as with a server. The sample list has six live chats and three closed long tasks in the projects `website`, `mobile-app` and `infra`, with job reports; a pin moves a card between the tabs until the demo ends. Watch and Control open a sample chat bundled with the app, in the app's appearance. New session, Reopen and notifications stay hidden. A banner over the list says the data is a sample, and Connect your Mac leaves the demo for the server address; Settings has Leave demo. Leaving forgets the demo's pins and never changes a saved server address. App Review uses the demo: the app needs a Mac that runs the server, so the review notes point the reviewer to Try the demo.

`Config/Base.xcconfig` holds the app's build settings: iOS 26 or later, iPhone and iPad, Swift 6, the bundle id `io.github.example.ompmobile`, portrait only on iPhone, the version and build number, and the export-compliance answer. To build for your own device, copy `Config/Local.example.xcconfig` to `Config/Local.xcconfig`, which git ignores, and set:

- `DEVELOPMENT_TEAM`: your Apple team id;
- `OMP_BUNDLE_ID_PREFIX`: a prefix of your own, so the bundle id is yours;
- `CODE_SIGN_ENTITLEMENTS = OmpMobile/Push.entitlements`, only with a paid Apple Developer Program team: it turns on push notifications, which a free Personal Team cannot sign.

## Release build

App Store and TestFlight builds need a paid Apple Developer Program team. Put three lines in `Config/Local.xcconfig`: `DEVELOPMENT_TEAM`, your own `OMP_BUNDLE_ID_PREFIX`, and `CODE_SIGN_ENTITLEMENTS = OmpMobile/Push.entitlements`. `Config/Base.xcconfig` sets the version, `MARKETING_VERSION`, and the build number, `CURRENT_PROJECT_VERSION`; raise the build number for each upload of the same version. It also tells App Store Connect that the app uses no encryption beyond Apple's HTTPS (`ITSAppUsesNonExemptEncryption = NO`). `OmpMobile/PrivacyInfo.xcprivacy` is the privacy manifest: no tracking, no collected data, and one required-reason API, `UserDefaults`, for the app's own settings (reason `CA92.1`). The icon's three variants come from `Design/render-icon.swift`.

In Xcode, pick Any iOS Device as the destination, then Product → Archive, and in the Organizer Distribute App → App Store Connect. From the terminal, with an `ExportOptions.plist` whose `method` is `app-store-connect` and whose `destination` is `upload`:

```bash
xcodebuild archive -project ios/OmpMobile.xcodeproj -scheme OmpMobile -configuration Release -destination 'generic/platform=iOS' -archivePath /tmp/omp-mobile/OmpMobile.xcarchive -allowProvisioningUpdates
xcodebuild -exportArchive -archivePath /tmp/omp-mobile/OmpMobile.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath /tmp/omp-mobile/export -allowProvisioningUpdates
```

The archive is signed for development. Distributing it to App Store Connect signs it again for production, `aps-environment` included, so TestFlight and App Store installs register for push as `production` and the server needs `push.keys.production` (`server/README.md`, Configuration). `docs/app-store.md` holds the App Store texts, the App Review notes and the screenshots; `PRIVACY.md` is the privacy policy.

## Checks

From the repo root. OmpKit needs Swift 6.2 or later on macOS 26 or later; the app needs Xcode 27 or later.

```bash
swift test --package-path ios/OmpKit
xcodebuild build -project ios/OmpMobile.xcodeproj -scheme OmpMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

CI runs these two. `ContractTests` decodes every file in `api/v1/fixtures/`, the examples the server's own tests check its replies against, and checks that each request encodes like its example. A new fixture fails the tests until it has a model.

The UI tests run only on a Mac. Make the two simulators once, from the installed iOS runtime, then run the tests on both:

```bash
xcrun simctl create omp-iPhone "iPhone 17"
xcrun simctl create omp-iPad "iPad Pro 11-inch (M5)"
xcodebuild test -project ios/OmpMobile.xcodeproj -scheme OmpMobile -destination 'platform=iOS Simulator,name=omp-iPhone'
xcodebuild test -project ios/OmpMobile.xcodeproj -scheme OmpMobile -destination 'platform=iOS Simulator,name=omp-iPad'
```

The UI tests need no server. Two use an address whose name does not resolve: one types it at first run and checks the "Can't find …" message under the field, the other starts with it saved and checks the same message on the list screen. Two turn the Simulator to landscape at first run: on the iPhone the app's window stays portrait, on the iPad it turns with the device. Each of those two skips on the other kind of device, so each run reports one test skipped. One more taps Try the demo, opens the sample chat with Watch and checks that Connect your Mac leads to the server address; on the iPad it runs in landscape, with the list beside the chat. Debug builds read the launch argument `-ui-testing-reset`, which clears the app's saved settings, so each test starts at the first run. `-serverURL <address>` before it sets the saved address for that run only.

The Simulator shows a notification and its tap without APNs. Allow notifications in the app, copy one of `api/v1/fixtures/push-*.json`, put a session id from your list in `omp.sessionId`, and run `xcrun simctl push omp-iPhone io.github.example.ompmobile <file>`.
