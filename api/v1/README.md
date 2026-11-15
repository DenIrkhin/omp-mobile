# API v1

The HTTP API of the omp-mobile server, which the phone page and the iOS app use. Every route
starts with `/api/v1/`.

`fixtures/` holds a JSON file for each request and reply named below. `server/api-v1.test.ts`
builds each reply with the server's own code and checks it against its file, and the app's tests
(`ios/OmpKit/Tests/OmpKitTests/ContractTests.swift`) decode every file and encode each request
like its file.

## Reaching the server

The server listens on `127.0.0.1` only. `tailscale serve` publishes it on the tailnet over HTTPS
and sets the `Tailscale-User-Login` header to the login of the device that asks, replacing any
value the client sends. The server answers 403 when the header is missing or names a login that
is not in its `allowedLogins` (`fixtures/error-403.json`). Clients hold no token.

Every `POST` needs `Content-Type: application/json`, else 400. A request whose `Origin` header
names another site gets 403.

## Errors

An error reply is a JSON object with `error`, a message for people. Some add `code`, for the
cases a client acts on:

- `disabled`: the route belongs to a module the server's config turns off (404).
- `busy`, `running`, `missing_folder`, `in_use`: why Reopen did not start the chat (409, `fixtures/reopen-409.json`).
- `push_env`: a device registration for another app, or for an APNs environment the server has no key for (400).
- `unknown_device`: a test push to a token that is not registered (404).
- On a 502 from `POST /api/v1/push/test`, `code` is APNs's reason, such as `BadDeviceToken` or `InvalidProviderToken`, or `NoKey`, `KeyUnreadable` or `Unreachable` when the server could not send the notification.

Any other path or method under `/api/`, the paths without `/v1` included, gets 404
`{"error":"Not found"}`. Any route can answer 500 when something fails that the server did not
expect.

## Routes

| Route | Request | Replies |
|---|---|---|
| `GET /api/v1/info` | | 200 `info.json` |
| `GET /api/v1/hosts` | | 200 `hosts.json` or `hosts-empty.json`; 502 when omp cannot list its chats |
| `POST /api/v1/link` | `link-request.json` | 200 `link.json`; 400 a bad request; 403 a control link for a chat that allows only watching; 404 the chat is gone; 409 `error-409.json`, the chat's generation changed; 502 omp could not make the link |
| `POST /api/v1/pin` | `pin-request.json` | 200 `pin.json`; 400 a bad request; 404 no session file, or long tasks are off (`disabled`) |
| `POST /api/v1/long-tasks/reopen` | `reopen-request.json` | 201 like `sessions-201.json`; 400 a bad request; 404 not pinned, no session file, or long tasks or New session are off (`disabled`); 409 `reopen-409.json`; 502 and 504 as for sessions |
| `GET /api/v1/launch-options` | | 200 `launch-options.json`; 404 New session is off (`disabled`) |
| `POST /api/v1/sessions` | `sessions-request.json` | 201 `sessions-201.json`; 400 a folder or model the server did not offer, or a bad `maxCost`; 404 New session is off (`disabled`); 409 another chat is still starting; 502 cmux could not open a workspace; 504 omp did not show up within 25 seconds |
| `POST /api/v1/control` | `{"instanceId", "generation", "op", ...}` | Manage on the phone page; `server/README.md` lists its operations. 404 Manage is off (`disabled`), or an operation only the local API socket serves |
| `POST /api/v1/devices` | `devices-request.json` | 200 `devices.json`; 400 a bad request, or `push_env`; 404 push is off (`disabled`) |
| `POST /api/v1/devices/remove` | `{"token"}` | 200 `{"removed": true}`, or `false` when the token was not registered; 400 a bad token; 404 push is off (`disabled`) |
| `POST /api/v1/push/test` | `{"token"}` | 200 `{"apnsId"}`, the id APNs gave the notification; 400 a bad token; 404 push is off (`disabled`), or `unknown_device`; 502 the notification did not go out |

What the replies hold:

- `info.features` names the optional modules the server runs: `longTasks` (pins and the Long tasks tab), `launch` (New session and Reopen), `control` (Manage), `devCycles` (dev cycles in Manage), `reports` (job reports on cards), `push`, and `pageCopy` (chats open in the server's own copy of the Collab page). A client hides what is off.
- `info.mainProfile` is the omp profile New session starts chats in; null is omp's default profile. A closed long task from another profile shows its profile's name.
- `info.deviceName` is the asking device's machine name on the tailnet, or null.
- `info.push` is null when push is off, else the app's `bundleId` and the APNs `environments` the server has a key for (`sandbox`, `production`).
- In `hosts`, a card has `pinned: true` when its chat is a long task. `longTasks` lists every pinned chat, running or closed, most recently active first. `projects` gives the order of the project sections. Each report has an `id`, its own UUID.
- `pageCopy` is null when the page copy is off, else `{"ok": true}` or `{"ok": false, "reason": "…"}`.
- In `sessions-request.json`, `model` is an `id` from `launch-options` and defaults to `defaultModel`; `maxCost` is optional, in USD, above 0 and at most 500.
- In `devices-request.json`, `token` is the device token in hex (an even length from 32 to 200 characters, either case). `environment` is `sandbox` for builds installed from Xcode and `production` for TestFlight and App Store builds. `events` turns each notification kind on or off; a kind left out takes its default (`input` and `reportFailed` on, `reportUpdate` and `turnDone` off). Registering the same token again updates it, and a device that has not registered for 90 days is dropped.

The local API socket on the server's Mac (`server/README.md`) keeps its two routes,
`POST /api/sessions` and `POST /api/control`, without `/v1`.

## Push notifications

While push is on, the server sends notifications through APNs to each registered device whose `events` switch for the kind is on. `push-input.json`, `push-report.json` and `push-turn-done.json` show one of each. `aps` is what iOS shows, and `aps.thread-id` is the chat's session id, so iOS groups each chat's notifications. `omp` tells the app what the notification is about; `omp.v` is 1.

| `events` switch | `omp.kind` | Sent when |
|---|---|---|
| `input` | `input` | A chat starts to need input. A chat that already needed input when the server started, or when the first device registered, is not sent. At most one per chat every 30 seconds; a newer one replaces the older banner. |
| `reportFailed`, `reportUpdate` | `report` | A job report with outcome `failed` or `update` arrives, or arrived less than an hour before the server started. Each report is sent once. |
| `turnDone` | `turnDone` | A pinned chat that worked for 2 minutes or more is idle on two checks in a row. At most one per chat every 10 minutes. |

- `input` and `turnDone`: `omp.instanceId` and `omp.generation` are the chat's at the time, as in `hosts`. They may have changed by the time the user taps, so look the chat up by `omp.sessionId`. The title is the chat's session name, else its folder; an `input` notification's body is the folder.
- `report`: `omp` carries the report's `reportId`, `job`, `outcome` and `at`, as in `hosts`. The title is the job and its outcome, and the subtitle the chat's title when the server finds its session file. The body is the first line of the summary, cut to 180 characters, unless the server's `push.includeSummary` is `false`.

## Versioning

- Within v1, changes only add: new optional fields, or new values of a field that clients tolerate.
- Clients ignore fields they do not know. An unknown `access` counts as `view`; an unknown report `outcome` counts as unknown.
- A change that breaks a client moves to `/api/v2` and `apiVersion: 2`.
