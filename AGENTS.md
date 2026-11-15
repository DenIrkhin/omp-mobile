# AGENTS.md

Rules for anyone changing this repository, people and coding agents alike.

## Layout

- `server/`: the Bun server and its phone web page. See `server/README.md`.
- `api/v1/`: the HTTP API and an example of each request and reply. See `api/v1/README.md`.
- `docs/decisions.md`: dated design decisions.
- `ios/`: the iOS app, `OmpMobile.xcodeproj`, and OmpKit, the Swift package it builds on. See `ios/README.md`.

## Checks before a commit

Run the row of every sub-project the commit changes, from the folder named in the row. CI runs the same commands on every pull request.

| Sub-project | Run from | Commands |
|---|---|---|
| `server/` | `server/` | `bun install` (first run, or after `package.json` changed), then `bun run check` (type-check) and `bun test` |
| `ios/` | repo root | `swift test --package-path ios/OmpKit`, then `xcodebuild build -project ios/OmpMobile.xcodeproj -scheme OmpMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`. On a Mac with the `omp-iPhone` and `omp-iPad` simulators (`ios/README.md`), also the UI tests on both, which CI does not run: `xcodebuild test -project ios/OmpMobile.xcodeproj -scheme OmpMobile -destination 'platform=iOS Simulator,name=omp-iPhone'`, then the same command with `name=omp-iPad` |

Add or change a test only where a behavior a user would notice can break. No tests for wiring, constants, or code that only passes a value through.

## Try a change before you commit it

A server runs the files of the checkout it starts from. If the installed service runs from your checkout, do feature work in a separate `git worktree`, so the service never loads half-done files.

To see a change, start a second server from your worktree's `server/` on another port, with a test copy of your config file:

```bash
jq '.port=7488 | .pageCopy.publicUrl=null | .cmuxGroups.enabled=false | .localApi.enabled=false' ~/.config/omp-mobile/config.json > /tmp/omp-mobile-test.json
OMP_MOBILE_CONFIG=/tmp/omp-mobile-test.json bun run server.ts
```

- `localApi.enabled=false` keeps the second server off the local API socket. Without it, the second server deletes the running server's socket.
- `pageCopy.publicUrl=null` and `cmuxGroups.enabled=false` turn off the page copy and the cmux sidebar sync, which belong to the running server.
- Never start a second server without `OMP_MOBILE_CONFIG`: it would read the running server's config file.
- Every request needs the `Tailscale-User-Login` header with an allowed login; every POST also needs `Content-Type: application/json`.

## Branches and commits

- Branch: `<type>/<slug>`. `<type>` is one of `feat`, `fix`, `chore`, `docs`, `refactor`; `<slug>` is lowercase words joined by `-`, for example `feat/radio-chips`.
- Commit message: `<type>(<scope>): <imperative summary>`, for example `fix(server): keep the chosen tab after a reload`. `<scope>` is `server`, `ios`, `api`, `ci` or `docs`.
- Stage files by name. Never `git add -A`.
- Never change files with uncommitted changes you did not make: do not stage, stash, reset, restore, or discard them. They are someone else's work in progress.

## Pull request descriptions

- Title: `<type>(<scope>): <imperative summary>`, under 72 characters.
- Describe only what the diff shows.
- Open with one plain sentence: what changed and why.
- Then a `## <area>` heading per changed area (`Server`, `Phone page`, `iOS app`, `CI`, `Docs`), each with 1–3 bullets. Each bullet is an outcome in plain words.
- No function names, file paths, class names, or flag keys.
- When someone must act around the merge (restart open omp chats to load an extension change, reinstall the app), end with `## Before or after merge` and each step in plain words.

## Merging

- Merge only a pull request whose checks are green.
- Squash merge: `main` gets one commit per pull request, and its subject is the pull request title.
- A branch behind `main` takes `main` with a merge commit. Never rebase a pushed branch and never force-push.
- Keep the branch after the merge; do not delete it.
