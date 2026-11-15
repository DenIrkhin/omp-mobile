# App Store listing

What to enter in App Store Connect for omp mobile 0.1.0 (1). The owner creates the record, uploads the build and submits it; nothing in this file is sent anywhere by itself.

## App information

| Field | Value |
|---|---|
| Name | omp mobile (check that the name is free when creating the record) |
| Subtitle | Watch and steer omp chats |
| Primary category | Developer Tools |
| Support URL | https://github.com/DenIrkhin/omp-mobile/issues |
| Privacy policy URL | https://github.com/DenIrkhin/omp-mobile/blob/main/PRIVACY.md |
| Bundle ID | `<your prefix>.ompmobile`, the prefix set in `ios/Config/Local.xcconfig` |
| Version and build | 0.1.0, build 1 (`ios/Config/Base.xcconfig`) |

## Keywords

```text
omp,coding agent,AI agent,remote,sessions,chat,developer,terminal,mac,notifications,long tasks
```

## Description

```text
omp mobile brings your omp chats to iPhone and iPad. It connects to the omp-mobile server on your own Mac, over your Tailscale network, and shows every omp chat running there.

• Every chat at a glance: status, folder, model and start time, grouped by project, with a badge when a chat needs input.
• Long tasks: pin a chat to follow it, see its job reports and their outcome, and reopen a closed long task.
• Watch a chat as it works, or take Control to answer and steer it. Control always asks first.
• Search by name or folder, and narrow the list to one project.
• Start a new session in a folder and model you pick, with an optional spend cap.
• Notifications when a chat needs input or a job fails, when your server has push turned on.
• Light and dark appearance. On iPad the list stays beside the open chat.

omp mobile needs the open-source omp-mobile server on a Mac you own, reachable over Tailscale. To look around first, tap Try the demo on the first screen: it shows the app with sample data and needs no Mac.

No account, no analytics, no tracking.
```

## App Privacy

Answer: **Data Not Collected.** The app has no analytics, no account and no third-party code that collects data. It sends its requests to the user's own server. Chat traffic goes through omp's Collab relay, encrypted end to end. With notifications on, the device token goes to the user's server and through Apple's push service. None of it reaches the developer. `PRIVACY.md` says the same to users.

## Age rating

| Question | Answer |
|---|---|
| Every content question (violence, sexual content, profanity, horror, mature themes, alcohol, tobacco or drugs, gambling, contests, medical or wellness topics) | None |
| Unrestricted web access | No: chat pages come from the user's own server or omp's Collab page, and links to other sites open in the browser |
| User-generated content shared with other users | No |
| Messaging or chat with other people | No: the chats are with the user's own coding agent |
| Advertising | No |
| Parental controls or age assurance | No |

Expected rating: 4+.

## Export compliance

The build's Info.plist sets `ITSAppUsesNonExemptEncryption` to NO, because the app uses only the HTTPS built into iOS (URLSession and WebKit). App Store Connect then asks no encryption questions for the build.

## App Review information

- Sign-in required: No.
- Contact: the owner's name, phone and email, entered in App Store Connect only.
- Notes:

```text
omp mobile is a companion app for omp, a coding agent that runs in the terminal on a Mac. The app shows the user's omp chats and lets them watch or control them. It connects only to the user's own omp-mobile server, which runs on their Mac and is reached over their private Tailscale network. There is no server we host, so a reviewer cannot connect to one.

To review the app without a Mac, use the demo:
1. Launch the app. On the first screen, tap Try the demo.
2. The list shows sample chats under a "Demo with sample data" banner. Switch between Chats and Long tasks, search, tap a project chip, and tap a pin to move a chat between the tabs.
3. Tap Watch on a card to open a sample chat. Tap Control on a card: the app asks first, then opens the chat with control.
4. The gear opens Settings, where Leave demo ends the demo. Connect your Mac on the banner leads to the server address step.

The demo needs no network and no sign-in; everything in it is sample data inside the app. New session, Reopen and notifications need a real server, so the demo hides them. The app has no accounts.
```

## Screenshots

Taken from the demo on Simulator, light appearance, status bar at 9:41.

| Display | Simulator | Size (pixels) | Files |
|---|---|---|---|
| iPhone 6.9-inch | iPhone 17 Pro Max, portrait | 1320 × 2868 | `screenshots/iphone-1-chats.png`, `screenshots/iphone-2-long-tasks.png`, `screenshots/iphone-3-chat.png`, `screenshots/iphone-4-settings.png` |
| iPad 13-inch | iPad Pro 13-inch (M5), landscape | 2752 × 2064 | `screenshots/ipad-1-chats.png`, `screenshots/ipad-2-long-tasks.png`, `screenshots/ipad-3-chat.png`, `screenshots/ipad-4-settings.png` |

In order: the Chats list, Long tasks with job reports, a chat page (Watching on iPhone, Control on iPad), and Settings.
