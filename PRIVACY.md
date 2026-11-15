# Privacy policy

This policy covers omp mobile, the iOS app in this repository. Last changed on 2026-11-15.

omp mobile shows the omp chats on your own Mac. It works with the omp-mobile server that you run on that Mac, and with nothing run by the app's developer.

## What the app keeps on your device

- The address of your server.
- Your settings: the appearance, the list tab and project you picked, the folder and model you last chose for a new session, and which notifications you want.
- The chat pages' website data, which holds an encrypted copy of each transcript so chats show at once. Settings → Clear cached transcripts removes it.

Deleting the app deletes all of it.

## What the app sends, and to whom

- **Your server.** The list, pins, new sessions and the links that open chats come from your server, at the address you typed, over HTTPS on your tailnet, the private network Tailscale sets up between your devices.
- **The chats.** A chat opens omp's Collab page, from your server's copy of it or from `my.omp.sh`. What you read and type in a chat, photos included, travels through omp's Collab relay at `my.omp.sh`, encrypted end to end, so the relay cannot read it.
- **Notifications, only when you turn them on.** iOS gives the app a device token, and the app sends it to your server with the app's version and the kinds of notification you want. Your server sends notifications through Apple's Push Notification service, so the token and the notification text pass through Apple. Turning notifications off removes the device from your server.
- **The demo** sends nothing: its sample data stays in the app.

## What the app does not do

- No analytics, tracking or ads, and no third-party code that collects data.
- No account, and no data sent to the app's developer.

## Questions

Open an issue at https://github.com/DenIrkhin/omp-mobile/issues.
