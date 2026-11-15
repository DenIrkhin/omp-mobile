# Decisions

Dated design decisions, newest first: what was decided and why. `server/README.md` describes how the result works.

## 2026-11-11: Start at login through a template and an install script

`server/scripts/install-launchd.sh` writes the LaunchAgent `local.omp-mobile` from `server/launchd/local.omp-mobile.plist.template`, filling in the checkout's path, the home folder and bun's folder. A checked-in plist would hold one machine's paths.

## 2026-11-11: A versioned HTTP API with example bodies

The phone page and the coming iOS app call the server under `/api/v1/`. `GET /api/v1/info` tells a client the versions, who asks and which modules run, so a client can hide what the server does not offer. `api/v1/fixtures/` holds an example of each request and reply; the server's tests check its replies against them, and the app's tests will decode them, so the two sides cannot drift apart. Within v1 changes only add; a change that breaks a client moves to `/api/v2/`.

## 2026-11-11: One config file, and modules that start off

The server reads every setting from one JSON file, `~/.config/omp-mobile/config.json` or the file `OMP_MOBILE_CONFIG` names, and stops with a list of every problem when the file is wrong. Earlier versions read environment variables and constants written for one Mac. Only the session list with Watch and Control always runs. New session, Manage, dev cycles, job reports, the page copy, the cmux sidebar sync and the local API each wait for their key, so a new install starts small and turns on only what it has the tools for. Long tasks start on, because they need nothing beyond omp.

## 2026-11-11: Tailscale is the only way in

The server listens on `127.0.0.1` only and trusts the `Tailscale-User-Login` header, which `tailscale serve` sets and overwrites when a client sends its own. There is no token login and no public address: the dashboard can run commands on the Mac, so a leaked token on a public URL would let anyone run code there, and Tailscale Funnel traffic carries no login header. A device with a Tailscale tag gets no login header, so it gets 403.

## 2026-11-11: Names kept from omp-sessions

The server began as omp-sessions, a dashboard for one Mac. File paths, socket paths, the report message type, cmux group IDs and browser storage keys that contain `omp-sessions` keep that name, because running chats, job scripts, session files and devices depend on them. `server/README.md` lists them.

## 2026-11-11: The project chips pick one project

The project chips on the phone page work like radio buttons: **All**, or exactly one project. Tapping the lit chip changes nothing. Before, several projects could be picked at once.
