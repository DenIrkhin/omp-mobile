# omp-mobile server

A web page for your iPhone and iPad that lists the omp sessions running on your Mac, opens any of them in the omp Collab web view, starts new sessions, and keeps long-running chats on a tab of their own, where they stay listed after they close. Scheduled jobs can report their results to those chats, and on the Mac the server can keep the cmux sidebar in collapsible groups. Everything beyond the session list with Watch and Control is a module that the config file turns on or off (see [Modules](#modules)).

## Using it

### Open the page

1. Connect the Tailscale app on the device, logged in with one of the logins in `allowedLogins` in the config file (see [Configuration](#configuration)).
2. Open the address in `publicUrl`, for example https://your-mac.your-tailnet.ts.net/, in Chrome.
3. Optional: bookmark it or keep the tab open. If you add it with Share → Add to Home Screen and the sheet shows an "Open as Web App" switch, turn it off. A web-app window has no tabs, and Watch and Control open sessions in new tabs.

Chrome on iPhone and iPad runs on Apple's WebKit engine, the same as Safari, so both browsers follow the same pop-up rules described below.

Any device in the tailnet logged in with one of those logins can open it. Other Tailscale users get a `Tailscale login not permitted` error, and devices outside the tailnet cannot reach the address.

### Which sessions appear

The page has two tabs. **Chats** shows every omp session on the Mac that shares itself through Collab, except the ones pinned as long tasks. **Long tasks** shows the pinned ones, running or closed (see [Long tasks](#long-tasks)). A session shares itself when its profile has `collab.autoStart` set. Set it to `control` in every profile you use (see [New omp profile](#new-omp-profile)).

The setting is read when a session starts. A session that was already running when the setting changed stays off the list until you restart it. A session that exits drops off within a few seconds.

Sessions that need you come first:

1. Needs input
2. Running
3. Idle or Unknown

Within each group the newest session is on top.

### Search

Type in the box above the list to show only the chats on the open tab whose session name or folder contains what you type. Case does not matter. With several words, each word must appear somewhere in the name, the folder name or the folder's full path: `791 bank` finds the chats in `791lyra` with "bank" in their name. A chat without a name matches on the first 8 characters of its ID, as shown on its card. The line under the box shows how many match, for example "3 of 27 chats" or "1 of 2 long tasks". The filter stays while the list refreshes; clear the box (the × at its right) to see every chat again.

### Filter by project

The chips under the tabs filter both tabs by project: **All**, then the projects in `projects.list` and `projects.otherName`, in the same order as the [cmux sidebar groups](#cmux-sidebar-groups), and "other" while a chat runs outside `projects.root`. One chip is lit at a time: tap a project to show only its chats, or tap **All** to see every project. Tapping the lit chip changes nothing. Each chip shows how many cards on the open tab are in that project and match the search; a project with none is dimmed but still tappable. The line under the chips shows how many are shown, for example "4 of 31 chats". The device remembers the choice, also across reloads. The projects come from `projects` in the config file (see [Configuration](#configuration)), so a project added there gets its chip after the service restarts.

### Long tasks

Long tasks are chats you keep coming back to, such as the chat that manages your email or the one that merges Renovate pull requests. The Long tasks tab keeps them listed after their chat closes in cmux, and **Reopen** starts them again with their whole history.

A long task is an omp pinned session: the same pin that omp's `/pin` command sets, which also puts the chat at the top of the `omp --resume` list on the Mac. omp has no tags or folders for chats; the pin is its only mark.

- **Make a chat a long task:** tap the pin at the top right of its card on the Chats tab, or type `/pin` in the chat on the Mac. Typing `/pin` in the Control chat on the phone does not work, because omp passes a phone message to the model as plain text.
- **Give it back to Chats:** tap the filled pin, or type `/unpin` in the chat on the Mac. `/unpin` only unpins; omp's `/pin` toggles, so typing it again unpins too. The chat's cmux row leaves the long-task group within 15 seconds.
- **A running long task** shows the usual card with Watch, Control and Manage, titled with the chat's name.
- **A closed long task** shows "Closed", when it was last active, and **Reopen**. Reopen opens a cmux workspace on the Mac in the chat's folder and runs `omp --profile=<profile> --resume '<session file>'`, so the chat continues with its own history, model and thinking level. The card turns live a few seconds later; tap Control as usual.
- **Unpinning a closed long task** asks first, because the chat then disappears from the page. `omp --resume` on the Mac still finds it.

The tab lists long tasks by project, in the same projects and order as the [cmux sidebar groups](#cmux-sidebar-groups): the projects in `projects.list`, then `projects.otherName`, then "other" for chats outside `projects.root`. Each section's heading shows the project and how many long tasks it lists, and a section with none is left out. Within a section, running long tasks come first (needs input, running, idle), then closed ones, most recently active first. Search and the project chips filter within the sections.

Reopen refuses when the chat is already running, when its folder no longer exists, and when another omp process still holds the session: a terminal outside cmux where it is open without sharing, or a scheduled `omp -p --resume` run. omp lets only one process write a session. A second process that resumed it would quietly continue in a new session with a new ID, and the long task would split in two.

A long task does not have to stay open: a chat does nothing between prompts, and Reopen brings it back with its history. Keep it open only while it works on its own, for example during a running turn, a `/loop`, a `/goal` or a Dev cycle.

### Job reports

A scheduled job can post its result to a long-task chat. The result shows up in three places:

- **In the chat**, as a message that starts no turn. The agent reads it on its next turn, so you can ask "what did last night's backup say?". A closed chat gets its reports when it is reopened.
- **On the chat's cmux row**, as a bold pill such as `backup ok · 03:04` (dark green, `#166534`), `digest update · 18:00` (dark blue, `#1D4ED8`) or `backup failed · 03:04` (red), with the date once the day has passed. A failed report also raises a cmux banner. The red pill goes once the chat has dealt with the failure: you wrote in the chat after the report came in, or the chat finished a turn after it (its last message ended without a tool call). Ok and update pills stay until a newer report of the job replaces them. A chat picks up a change to the pill style only after it restarts.
- **On its Long tasks card** on the phone: each job's latest result, up to 3 lines, with ✓, i or ✕, the job, the time and the first line of the summary. Tap a line for the whole summary and the details path.

A report has one of three outcomes: `ok` when the job ran and all is well, `update` when it ran and has news for you (a digest, a limit running low), and `failed` when the job itself broke.

Each job script names the chat it reports to by the chat's session ID, for example in a `REPORT_SESSION` variable. Make the report best effort: a missing reporter or a failed report should not change the job's exit code or its other output.

Any script can report with:

```bash
bun <repo>/server/report.ts --session <omp session id> --job <name> --outcome ok|update|failed \
  (--summary "<text>" | --summary-file <path>) [--details <absolute path>] [--wake]
```

- `--job` is a letter or digit, then up to 63 letters, digits, `.`, `_` or `-`.
- The summary is cut to 4,000 characters, and control characters other than newline and tab become spaces. `--details` is an absolute path of at most 1,024 characters.
- It prints `reported <id> for <job> to <file>`. It exits 64 on a usage error and 1 when the write fails. When no session file has that ID, it warns and writes the report anyway.
- `--wake`: posting the report also starts a turn, so the chat goes on with work that waited for the job. Only within an hour of the write; a chat resumed later gets the message without a turn. The message then also says "This is the result this chat waited for: go on with the work that waited on it."

The chat message and the cmux pill come from the control extension (see [How it works](#how-it-works)), so the chat must run in a profile that has it installed, and a chat posts reports only once it has loaded the extension: restart chats that were open before you installed it. The phone card needs the chat pinned; the message and the pill do not.

### Push notifications

With `push` on in the config file, the server sends notifications to the iOS app on each registered device whose switch for the kind is on:

- **Needs input**, on by default: a chat starts to need input, such as a question from its ask tool. The server checks the chats every `push.pollSeconds` seconds (5 by default), but only while at least one device is registered. A chat gets at most one such notification every 30 seconds, and a newer one replaces the older banner.
- **Job failed**, on by default, and **job update**, off by default: a job report with outcome `failed` or `update` arrives (see [Job reports](#job-reports)). Each report is sent once. The notification names the job and the chat and, unless `push.includeSummary` is `false`, the first line of the summary, cut to 180 characters. Report notifications need `reports.enabled` too.
- **Turn finished**, off by default: a pinned chat that worked for 2 minutes or more is idle on two checks in a row. At most one per chat every 10 minutes.

Each device registers for the APNs environment of its build: an install from Xcode, or the Simulator, for `sandbox`; a TestFlight or App Store install for `production`. A device gets notifications only when `push.keys` has a key for its environment (see [Configuration](#configuration)).

A restart sends nothing twice. The first check after a start, or after the first device registers, only learns which chats need input, so input that began while the server was down is not sent. A job report written while the server was down is sent once if it is less than an hour old at the start; `push-state.json` in `stateDir` keeps the reports already sent for 7 days. When APNs answers a report notification with a server error, the server tries once more 15 minutes later. `api/v1/README.md` describes what each notification holds.

### cmux sidebar groups

On the Mac the server can keep the cmux sidebar in collapsible groups, two per project, so the window needs no scrolling; `cmuxGroups.enabled` turns it on. The projects come from `projects` in the config file. In this example `projects.root` is `~/dev`, `projects.otherName` is `dev`, and `projects.list` holds orion (family `orion-web`) and vega, lyra, nova and atlas (each its own family):

| Project | Folders |
|---|---|
| orion | `751orion-web` to `775orion-web` |
| vega | `795vega` to `799vega` and `797vega-wt` |
| lyra | `791lyra` |
| nova | `005nova` |
| atlas | `725atlas` and `724atlas-nightly` |
| dev | `~/dev` itself and every other folder in it |

A folder belongs to a project by the first folder under `projects.root` on its path, without its leading digits: `753orion-web/packages/web` → `orion-web` → orion. A name that starts with a project's family and a `-` counts too, so `797vega-wt` and `798vega-watch` are vega. Folders outside `projects.root` have no project, and the server leaves their workspaces alone.

Each project gets up to two groups, shown here for orion:

- **Long-task group, "orion · long tasks"**, pinned at the top with a pin icon: the project's workspaces whose chat is pinned in omp. The long-task groups appear in project order, also when one is added later.
- **Project group, "orion"**: the project's other workspaces.

Every 15 seconds, and about a second after a pin change, a Reopen or a New session, it applies these rules in each cmux window:

- A workspace running a pinned chat moves to its project's long-task group, even while you are looking at it. When you unpin the chat, the workspace moves to its project group. When the chat moves to another project's folder (omp `/move`), the workspace follows it to that project's long-task group.
- A closed long task keeps its row in its long-task group: a row whose chat has stopped stays while the last omp session cmux recorded in that workspace is pinned. Unpin it and the row leaves. Any other row there without a chat, one whose last chat was not pinned or one cmux has no record of, leaves about a minute later: to its project group, or out of all groups when its folder is outside `projects.root`. The minute covers a restart (an omp update, a cmux restart), after which the chat runs in the same row again. The record comes from cmux's omp hook store, `~/.cmuxterm/omp-hook-sessions.json`, where cmux notes the session and workspace of each omp event in a cmux terminal. While that file cannot be read, no row without a chat moves, and the log says so once. A long-task group left with no workspace is removed: when `dev-notes` moves to "nova · long tasks", "dev · long tasks" goes. It comes back when a chat there is pinned again.
- A workspace in no group moves to its project group once you switch away from it.
- It never moves workspaces you pinned in cmux, group headers, workspaces outside `projects.root`, or workspaces in a project group or in any group you made.

To find the workspace a chat runs in, the dashboard reads `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` from the chat's environment. cmux sets both in every terminal it starts and keeps the IDs across its restarts. The chat belongs to the workspace that holds that surface, or, when no workspace holds it, to the workspace with that ID. The tty that `cmux tree` lists for a terminal is not used: after a cmux restart it is stale for restored terminals, and since macOS hands the same tty names to new terminals, two workspaces can claim one chat. Using it once put unpinned chats into another project's long-task group.

A new long-task group goes between the long-task groups of the projects before and after it. A new project group appears where its first workspace was, and the workspaces keep their order. Project groups start collapsed, except the one holding the workspace you are looking at. After that, collapse, expand, rename, recolor and reorder them as you like; the dashboard keeps your choices and never removes a project group. cmux itself removes a group that is not pinned once its last workspace leaves it, though: when the only workspace of "vega" moves to "vega · long tasks", the "vega" group goes, and it comes back as a new group, without your name or color, when a vega workspace needs it again.

A collapsed header shows unread counts but not whether a chat waits for you. So while a chat in a dashboard group needs input, the header reads "orion · 1 needs input" and its folder icon turns red. The count and the red go away when nothing waits any more; a color you picked stays.

Earlier versions kept one "Long tasks" group and one group per folder family. The first check with the project rules moves them over, and later checks find nothing more to move:

- Each workspace in "Long tasks" moves to its project's long-task group, by its chat's folder or, for a closed long task, the folder cmux shows for it. A workspace outside `projects.root` leaves the group. Then "Long tasks" is removed.
- The first folder group of each project in the sidebar becomes that project's group. It keeps its place, its collapse state and its workspaces, and takes the project's name only while it still has its folder family's name: "orion-web" becomes "orion", while a name you gave it stays.
- When a project has more than one folder group, the workspaces of the others move into the first, and those groups go: a "vega-wt" group would empty into "vega".

To change the projects, edit `projects` in the config file (see [Configuration](#configuration)): `list` holds the projects in sidebar order, each with the folder names (without digits) it claims in `families`, and `otherName` names the project that takes every folder no other project claims. Then restart the service; the phone's Long tasks sections follow the same setting. Rows already in a group stay there when the mapping changes, as the sync never takes a workspace out of a project group: drag one into the right group, or take it out of its group, and the sync places it once you switch away from it. The groups of a project you drop stay until you dissolve them.

To stop the sync, set `cmuxGroups.enabled` to `false` in the config file and restart the service. While it runs, a dashboard group you dissolve comes back when a workspace needs it.

### Reading a card

The title is the folder the session runs in, with the full path underneath. The line below shows the session name (or the first 8 characters of its ID when it has no name), the model, and how long ago it started.

| Status badge | Meaning |
|---|---|
| Needs input (amber) | The agent asked you something (the ask tool, a tool approval, or a plan approval) and its turn is blocked until you answer. |
| Running (blue) | The agent is in the middle of a turn. |
| Idle (green) | The turn finished and the agent is waiting for your next prompt. |
| Unknown (gray) | The session did not report its state. |

The cmux sidebar on the Mac shows the `omp` pill on each workspace, which cmux draws itself: Running (blue bolt) and Idle (gray pause).

Two more badges appear only when they apply. "2 connected" (or a higher number) counts everyone who has the session open, including the terminal, so it shows up once someone opens the session from the web. "Relay offline" means the session lost its connection to the Collab relay; Watch and Control stay disabled until it reconnects.

### Watch and Control

Watch opens the session read-only. You see the conversation update live but cannot send anything.

Control lets you send prompts from the phone, the same as typing in the terminal on the Mac. A Control link can make the agent run commands on the Mac, so the page asks you to confirm first ("Grant Full Control?", then Open Control). The Control button appears only on sessions that share control access, which with `collab.autoStart` set to `control` is every session.

After you tap, the button reads "Opening…" and the Collab view opens in a new tab. The list stays open in its own tab. The page opens an empty tab first ("Opening session…") and loads the link into it once the server returns it. Chrome and Safari on iOS block a new tab that opens after a server request unless the tab is created during the tap itself. If Chrome blocks the new tab anyway, the session opens in the dashboard's tab instead.

Each tap creates a new link. The part after `#` is the key to the session, so do not copy or share it: anyone holding a Control link can drive the agent. The dashboard does not store or log links.

When `pageCopy.publicUrl` is set, the Collab view opens from the server's own copy of omp's web page, for example at https://your-mac.your-tailnet.ts.net:8443/. It is the page `my.omp.sh` serves, built from the omp source of the installed version with these changes (`collab-web.patch`):

- **Images:** the picture button next to Send adds up to 4 images to a message, from the photo library, the camera or Files; on an iPad or a computer you can also paste a screenshot into the box. Each image is shrunk to about 1.15 megapixels and sent as a JPEG of at most about 160 KB, so the message still fits the 1 MiB that Collab replicates back to every viewer. Tap the × on a thumbnail to drop it. "At most 4 images per message." or "Could not add …" shows above the box when an image is not added.
- **Enter on a touch screen** (phone or tablet) starts a new line; only the Send button sends. On a computer Enter still sends and Shift+Enter starts a new line.
- **Your name in the chat** is this device's Tailscale machine name, for example `iphone`, in place of "guest". It shows on your messages on the phone and as `«iphone»` in the chat on the Mac. The dashboard looks it up with `tailscale whois` and passes it in the link (`?name=`). A name typed on the page's connect screen (open the page copy's address without a link) wins on that device; typing the machine name or clearing the field goes back to it.
- **Header on a phone:** the chat's name, on up to two lines, in place of the omp mark and the folder; it follows `/rename` at once. The connection dot sits in the middle of its circle. There is no leave button (close the tab to leave) and no theme switch (see [Light and dark](#light-and-dark)).
- **Saved copy:** when you open a chat again, or come back to a tab the phone closed, the last transcript shows at once with "Saved copy · syncing… N%" in the banner. When the live chat has finished downloading it replaces the copy and the banner goes away; you can only type once it is live. The whole chat still downloads each time you come back, so the copy hides the wait but does not save data (the fix for that has to come from omp itself). The copy lives in this browser's storage for the page (IndexedDB), encrypted with the chat's link key, so it is no more readable than the link. It keeps the 10 most recently opened chats and at most 100 MB, dropping the oldest first; a chat over 25 MB is not saved. To clear it, delete the website data for the page copy's address in the browser (on an iPhone: Settings → Apps → Safari → Advanced → Website Data).
- The agents panel starts closed (tap the panel button with the subagent count to open it), and the analytics script is removed.

The chat still travels through the Collab relay at `my.omp.sh`, encrypted end to end. After an omp upgrade the server rebuilds the copy by itself within about a minute. Until that build finishes, or if it fails, links open at `my.omp.sh` as before, without these changes, and the line under the title says why.

### Start a new session

1. Tap **+** at the top right.
2. Pick a folder: the projects root (`projects.root`) itself or any folder directly inside it.
3. Pick a model from the choices in `launch.models`. The one in `launch.defaultModel` is preselected the first time. The dialog remembers the last folder and model you used on that device.
4. Tap **Start**.
5. When the dialog says "Session in <folder> is ready.", tap **Open**.

The Mac opens a new cmux workspace named after the folder with `-mobile` added (for example `795vega-mobile`) and runs `omp --profile=<profile> --config=<repo>/server/new-session.yml --model=<model> --thinking=<level>` in it, with the profile in `launch.profile` and the model and thinking level of the choice. A `null` profile, model or thinking level leaves its flag out, so omp and the profile decide. The `--config` overlay turns off the profile's `autoResume` for this launch only, so you always get an empty session instead of the folder's most recent one; typing `omp` in a terminal still resumes as before. To change the model of a running session, use Manage (below). To offer other models, edit `launch.models` in the config file and restart the service.

The Mac's screen does not switch to the new workspace. After about 5 seconds the session appears in Collab and the dialog shows **Open**. Tapping Open opens the session in Control mode in a new tab. You don't get the "Grant Full Control?" prompt here, because you asked for the session yourself. The extra tap is needed because iOS WebKit (Safari and Chrome) blocks a new tab opened 5 seconds after the Start tap.

If you tap Cancel while it is starting, the session still starts. It shows up in the list, and a message says it is ready. On the Mac the workspace stays open after omp exits; close it in cmux when you're done.

### Manage a session

Cards with Control access have a third button, **Manage**. It changes the running session without opening it:

- **Model:** the choices in `launch.models` that set a model, the same list New session offers. **Switch** sets both the model and its thinking level.
- **Thinking:** off, minimal, low, medium, high, xhigh or max. omp can lower a level the model does not support; the dialog shows the level in effect.
- **Skill:** any skill the session lists for `/skill:<name>`, with optional arguments. **Run** sends it the way `/skill:<name>` does in the terminal: an idle session starts a turn, a running one takes it as a steer.
- **Compact:** asks first, then compacts the context, with an optional focus. omp refuses when the session is running a turn or is too small to compact; the result shows in the session, not in the dialog.
- **Dev cycle:** shown in folders that have cycle commands, such as `/feature-cycle`. Pick the command, type its arguments (the line under the label shows what it takes) and tap **Start**. After you confirm, the dev-cycle extension starts it exactly as if you had typed `/feature-cycle <arguments>` in the terminal: it switches to the plan model and runs the phases on its own. While a cycle runs, the row shows the command, its phase and how long the phase has run, or why the cycle paused, with two buttons. **Resume** does what `/cycle resume` does; it needs the session to be idle. **Stop** does what `/cycle stop` does: no later phase starts, but a turn already running goes on without the cycle (interrupt it in the Control chat to cut it short). `/cycle pause` and `/cycle goto` stay terminal-only. Typing `/feature-cycle` in the Control chat does not start a cycle, because omp passes a Collab guest's message to the model as plain text.

The terminal on the Mac shows a `Dashboard: …` line for every change. Collab guests cannot do any of this (omp keeps `/model`, `/compact`, skills and extension commands such as `/cycle` host-only), so Manage talks to the `omp-sessions-control` extension inside the session instead (see [How it works](#how-it-works)). Only sessions that started after the extension was installed in their profile have it. For any other session the dialog says "This session started before the dashboard extension was installed. Restart it to manage it here." When no dev-cycle extension answers in the session, the Dev cycle row shows "Restart this chat to start dev cycles from here."

### Refreshing

The list updates every 10 seconds while the page is on screen. Updates stop when you switch apps or lock the device, and the page reloads the list as soon as you come back. The line under the title shows when the list last updated. The round-arrow button at the top right refreshes immediately; it spins only when you tap it.

Each update runs `omp collab list` once on the Mac, which takes about 70 ms of CPU. At one update every 10 seconds that is under 1% of one core, and only while a device has the page on screen.

### Light and dark

The button left of **+** switches the colors between the device's setting (monitor icon), light (sun) and dark (moon), one step per tap, and the device remembers the choice. Watch and Control pass that choice in the link (`?theme=`), so the chat opens in the same colors; the dashboard's copy of the chat page has no switch of its own.

### Messages

| Message | What happened | What to do |
|---|---|---|
| No active shared sessions | No session on the Mac is sharing itself. | Start omp, or restart sessions that were running before `collab.autoStart` was set. |
| Session was rotated or ended. Refreshing… | The session exited, or its share key changed after the list loaded. | The list reloads by itself. Tap the card again. |
| Control access is not enabled for this session. | The session shares view access only. | Use Watch. |
| Failed to fetch sessions: … | The server could not run `omp collab list` (an error, or no answer within 5 seconds). | The page retries every 10 seconds. If it keeps failing, check the logs below. |
| `Tailscale login not permitted` | The device is logged in to a different Tailscale account. | Log in to Tailscale with a login in `allowedLogins`, or add the device's login there. |
| Chrome cannot open the page | Tailscale is disconnected on the device, the Mac is asleep or offline, or the service is stopped. | Connect Tailscale, wake the Mac, then check the service with `launchctl list \| grep omp-mobile`. |
| Folder is not in the allowed list | The folder was renamed or deleted after the dialog loaded. | Close the dialog and tap **+** again. |
| Model is not in the allowed list | The page sent a model the server does not offer, usually because it still has an old copy of the page. | Reload the page and tap **+** again. |
| Another session is still starting | A start from another tab or device, a New session or a Reopen, has not finished. | Wait a few seconds and tap Start or Reopen again. |
| cmux could not create a workspace: … | cmux is not running on the Mac, or it refused the request. | Open cmux on the Mac and try again. |
| omp started in cmux workspace:N but did not appear in Collab within 25s | omp started but did not share itself: it is still booting or it hit an error. | Check that workspace on the Mac. If it is still booting, the session appears in the list once it is up. |
| Building the page copy for omp X… | omp was upgraded, or `collab-dist/` is missing, and the dashboard is rebuilding the copy. Links open at `my.omp.sh` meanwhile. | Wait a few seconds. |
| Building the page copy for omp X failed: … | The automatic build failed: GitHub was unreachable, or `collab-web.patch` no longer applies to the new omp. The dashboard tries again 10 minutes after the failure. | On the Mac, run `bun build-collab.ts` in the server folder to build at once and see the full error. If the patch no longer applies, update it for the new omp. |
| This session started before the dashboard extension was installed. Restart it to manage it here. | Manage reached a session without the `omp-sessions-control` extension: it started before the install, or runs in a profile where the extension is not installed. | Restart the session: exit omp and run it again. |
| The session is busy; wait for the current turn to finish | Compact, Start or Resume was tapped while a turn, or an earlier compaction, was running. | Try again when the card shows Idle. |
| Unknown skill … | The skill was removed or renamed after the dialog loaded. | Close Manage and open it again. |
| A cycle is already active (/…); stop it first | A cycle already runs in that chat, for example one started on the Mac. | Close Manage and open it again to see it. Tap Stop first if you want to start another. |
| /… is not a cycle command in … | The command file was removed or renamed after the dialog loaded. | Close Manage and open it again. |
| No cycle is running in this session | Resume or Stop was tapped after the cycle ended. | Close Manage and open it again. |
| Pin failed: Session … has no session file | The chat has not finished its first turn, so omp has not written its session file yet. | Send it one prompt and tap the pin again, or type `/pin` in the chat on the Mac. |
| The session is still open in another omp process (pid N); close it there first | Reopen found another omp process writing that session, such as a terminal outside cmux or a scheduled `omp -p --resume` run. | Close that process, or let the scheduled run finish, then tap Reopen again. `ps -p N -o command=` on the Mac shows what it is. |
| The session's folder … no longer exists | The chat's folder was renamed or deleted after the chat closed. | Put the folder back, or unpin the long task. |

## Running the service

### How it works

`server.ts` is a Bun HTTP server on `127.0.0.1:7478` (`port` in the config file). At login the LaunchAgent `local.omp-mobile` runs `omp-mobile-server.sh`, which `exec`s `bun run server.ts`, and launchd restarts the server if it exits (see [Start at login](#start-at-login)). System Settings → General → Login Items & Extensions lists the job under that file name. `tailscale serve` publishes the server to the tailnet only, at the address in `publicUrl`; never turn on Funnel for it.

The session list comes from `omp collab list --json`, cached for 1 second so several open tabs share one call. Tapping Watch or Control runs `omp collab link <instanceId> --json` (with `--view` for Watch). The server compares the session's generation number with the one the page saw, both before and after creating the link. If they differ, it discards the link and returns 409, which the page shows as "Session was rotated or ended".

The page, and later the iOS app, call the HTTP API under `/api/v1/`. `api/v1/README.md` at the repo root lists its routes, replies, errors and versioning rules, with an example of each request and reply in `api/v1/fixtures/`. `GET /api/v1/info` tells a client the server and omp versions, the login and device that ask, the main profile (`launch.profile`) and which modules run. The page reads it once at load and hides New session and Reopen when `launch.enabled` is false, and Manage when `control.enabled` is false. Any other path under `/api/`, the old ones without `/v1` included, answers 404 `{"error":"Not found"}`.

Start a new session calls `GET /api/v1/launch-options` for the folders and the model choices, then `POST /api/v1/sessions`. The choices come from `launch.models` in the config file; the page sends back only a choice id (for example `default`). The server records which sessions already exist and runs `cmux workspace create --name <folder>-mobile --cwd <folder> --command "omp --profile=<profile> --config=<new-session.yml> --model=<model> --thinking=<level>"`. Then it checks `omp collab list` every 750 ms for up to 25 seconds, until a session it has not seen before appears in that folder. It returns that session's ID, and the page asks for a Control link the usual way when you tap Open. The server starts one session at a time. A request may also set a spending cap, `maxCost` (see [Local API](#local-api-unix-socket)); the page never sends one.

The Collab page copy is served by a second listener in the same process, on `127.0.0.1:7479`, published by `tailscale serve --https=8443`. `bun build-collab.ts` builds it: it reads `omp --version`, checks out that version's tag from GitHub (only `packages/collab-web`, `packages/utils`, `packages/wire` and `bun.lock`, into `.collab-build/`), applies `collab-web.patch`, installs `react`, `react-dom`, `katex` and `lucide-react` at the versions in omp's lockfile, runs the same `bun build` as omp's own package, and swaps the result into `collab-dist/` with a `build.json` that records the omp version. A build takes a few seconds. When `collab-web.patch` no longer applies to a new omp version, the build stops with an error and the old copy stays in place (it is then unused, because the version no longer matches). `POST /api/v1/link` hands out a page-copy link only when `build.json` matches the installed omp (checked at most once a minute) and the link uses the default relay; otherwise it returns the `my.omp.sh` link unchanged. The version must match because a Collab host rejects a page that speaks another protocol version (`COLLAB_PROTO` in omp's `packages/wire`), and the chat then ends at once with "protocol mismatch".

When `GET /api/v1/hosts` or `POST /api/v1/link` finds the copy missing or built for another omp version, the server starts `build-collab.ts --if-outdated` in the background and serves `my.omp.sh` links until the new `build.json` is in place. It stops a build after 5 minutes. After a build for a given omp version ends, it tries that version again only 10 minutes later, so a failing build does not rerun on every 10-second refresh. Builds and failures are logged as `page copy: …` lines in `omp-mobile.log`.

A script that updates omp can run `bun build-collab.ts --if-outdated` right after `omp update`, so the copy is ready before the next tap. Only one build runs at a time: `build-collab.ts` holds `.collab-build.lock` (it contains the builder's pid) and any other build waits for it, up to 6 minutes. A lock whose pid no longer runs is left from a killed build and is removed. With `--if-outdated`, a build that waited finds the copy already current and stops there.

Manage goes through `extension/omp-sessions-control.ts`, an omp extension you install as a symlink in a profile's `agent/extensions/` folder (see [Commands](#commands)). In each interactive main session it opens the Unix socket `~/.omp/run/omp-sessions-control/<pid>.sock` (folder 0700, socket 0600) and removes it when omp exits; subagent sessions never touch it. `POST /api/v1/control` takes the card's `instanceId` and `generation`, checks them against a fresh `omp collab list` (404 and 409 as for links, 403 for view-only sessions), and sends one JSON line to the socket of that session's process, with the session ID from the list. The extension refuses when it runs a different session by then. The operations are `status`, `set-model` (a `launch.models` choice id, never a raw model name), `set-thinking`, `compact`, `skill` and `cycle`. A session without the extension has no socket, which the dashboard reports as 503 `no_extension`.

Cycles belong to a dev-cycle extension, which is not part of this repository, so the control extension passes `cycle` requests, and a cycle query for every `status`, to it on omp's shared extension event bus, channel `dev-cycle:request`. The dev-cycle instance that runs the session claims the request while it is sent (the bus also reaches subagent sessions) and answers it. It lists the cycle commands it finds from the session's folder: `.omp/commands`, `.agents/commands` and `.claude/commands` in each folder up to the Git root, then the profile's `commands` folder. It starts, resumes or stops a cycle with the same code as typing the command, `/cycle resume` and `/cycle stop`, except that it refuses while the session is busy instead of waiting. When no dev-cycle instance claims a request, the status reply carries `cycle: null` and the row asks for a restart.

Long tasks come from omp's own pins: `session-pins.json` in each agent dir (`~/.omp/agent` and `~/.omp/profiles/<name>/agent`), a JSON list of session IDs that `/pin` adds to and removes from. Every `/api/v1/hosts` poll reads those files and the first 8 KiB of each pinned session file: the chat's name from the file's 256-byte title slot, its folder from the session header, and the file's modification time as its last activity. Pins of deleted sessions are skipped, as omp skips them. Live cards get `pinned: true`, and the reply also carries `longTasks`. Every card and long task has `folder`, the last part of its path, and `project`, from the config's `projects` (null outside `projects.root`); the reply's `projects` gives the order of the Long tasks sections. The server finds a session file by its ID with one scan of every agent dir's `sessions/` folders, which it keeps in memory and repeats only when a pinned ID is new or its file has moved.

`POST /api/v1/pin` changes the file the way `/pin` does. It holds omp's lock (`flock` on `session-pins.json.lock`, in `flock.ts`), reads the file again, writes a temp file and renames it over the original, so it never loses an update that a `/pin` made at the same moment. `POST /api/v1/long-tasks/reopen` takes only a pinned session. It checks that the chat is not in the live list, that its folder exists, and that no other process holds the session's lease. A live omp holds `flock` on `~/.omp/run/session-owners/<id>.lock` for every session it writes; the server asks `lsof` who has that file open rather than taking the lock itself, because holding it even for a moment could make an omp that is starting at that instant fork the session. Then it starts the workspace the same way New session does, one start at a time, and waits up to 25 seconds for a live chat with the same session ID.

The control extension also adds `/unpin`. It removes the chat's session ID from `session-pins.json` in every agent dir that lists it, with the same locked write as `POST /api/v1/pin` (`writePin` in `agent-dirs.ts`). In a chat that is not pinned it says "This chat is not in Long tasks." and changes nothing.

Job reports live in one append-only file per chat, `~/.omp/omp-sessions/reports/<session id>.jsonl` (folder 0700, file 0600), one JSON object per line: `{"v":1,"id","job","outcome","summary","details","at"}`, plus `"wake":true` when `report.ts` got `--wake`. `report.ts` appends to it; `reports.ts` holds the rules it shares with the server and the extension. The control extension watches that folder from each chat. When the chat's file changes, and when the chat starts, resumes or switches session, it posts the reports the session does not have yet with `pi.sendMessage(..., { triggerTurn: false })`: omp shows such a message at once without starting a turn and sends it to the model as a developer message on the next turn. When a report in the pass has `wake` and is at most an hour old (`wakeTurn`), the last message of the pass goes with `triggerTurn: true` instead, so one turn starts. A report counts as posted when the session holds an `omp-sessions-report` message with its ID, so nothing is posted twice, also across restarts. Only reports newer than the last posted one and at most 7 days old are posted, the newest 5 at a time, oldest first; while a turn runs, the extension waits until the chat is idle. The extension imports `../reports.ts`, which works because omp loads the symlinked extension by its real path. For the phone, `/api/v1/hosts` reads the last 64 KiB of each pinned chat's file and returns `reports` (the latest per job with its `id`, newest first, at most 3) on pinned cards and long tasks.

The sidebar sync (`cmux-groups.ts`) reads `cmux tree --all --json --id-format both` (windows, workspaces, the selected workspace, the UUIDs of terminal surfaces), `cmux workspace-group list --json` per window, `omp collab list`, one `ps -E -ww -o pid=,command=` call that reads `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` from each chat's environment (macOS `ps -E` prints it after the arguments), the pins files, cmux's omp hook store `~/.cmuxterm/omp-hook-sessions.json`, and `cmux sidebar-state` for the folder of each workspace without a running chat that is in no group, in a long-task group or in the old "Long tasks" group. Of the hook store's `sessions` records, the one with the latest `updatedAt` names a workspace's last omp session; workspace UUIDs are compared without regard to case, and the store's `runtimeStatus` is ignored, as it goes stale. `projectOf` in `projects.ts` turns a folder into its project. The executor remembers one thing between checks: since when each workspace in a long-task group has run no chat. It hands `planSync` the ones past `LONG_TASK_GRACE_MS` (60 s, in `server.ts`); `bun cmux-groups.ts` uses 0, so its plan and `--apply` move such rows at once. `planSync` turns all that into steps, and the executor runs them one cmux call at a time; a failed call is logged and tried again on the next check. Groups are created without `--from`, so cmux adds a separate header row, and `reorder-workspace` moves the header into place. Pinning puts a group below the other pinned groups, so a new long-task group is pinned first and then moved above the long-task group of the next project with `reorder-workspace --before <that group's header>`. The dashboard finds its groups by cmux external ID: `omp-sessions:long-tasks:<project>` and `omp-sessions:project:<project>`, and the earlier `omp-sessions:long-tasks` and `omp-sessions:folder:<family>` while it moves them over. It removes a group with `workspace-group ungroup --remove-generated-anchor`, which cmux refuses while the group holds more than its header. A pinned group stays with only its header when its last workspace leaves; a group that is not pinned is removed by cmux at that moment, so the executor checks the group list first and logs `groups: cmux removed the empty group "vega"`. cmux counts each header as a workspace, so `cmux workspace list` shows one extra entry per group.

### Local API (Unix socket)

Scripts that run as your user on the Mac, such as a launchd job that watches a service, start sessions and run Manage operations through a third listener in the same process: the Unix socket `~/.omp/run/omp-sessions-api/api.sock`. Its folder is 0700 and the socket 0600, so only your user's processes can connect, and nothing new is reachable from the tailnet. At start the server creates the folder (or sets 0700 again on an existing one), removes a socket file left by an earlier run, listens, and then sets the socket to 0600. `localApi.enabled` in the config file turns the listener on; `localApi.dir` moves the folder.

It serves two routes, at their paths without `/v1`, with the same code as the tailnet listener's `/api/v1/sessions` and `/api/v1/control` but without the `Tailscale-User-Login` check:

- `POST /api/sessions` starts a session as New session does. Body: `{"folder": "<projects.root or a folder directly inside it>", "model": "<choice id>", "maxCost": <USD>}`; `model` defaults to `launch.defaultModel`. `maxCost` is optional: a number above 0 and at most 500, rounded to cents, that adds `--max-cost=<n>` to the omp command, so the session stops sending model requests once it has spent that much. Any other value is a 400 `maxCost must be a number of USD above 0 and at most 500`. The tailnet listener accepts `maxCost` too. Replies: 201 `{instanceId, generation, access, workspace}`, 400 for a folder or model outside the lists, 409 while another start runs, 502 when cmux fails, 504 when omp does not appear in Collab within 25 seconds.
- `POST /api/control` runs one [Manage](#manage-a-session) operation: `{"instanceId", "generation", "op", ...}` with `op` one of `status`, `set-model`, `set-thinking`, `compact`, `skill` and `cycle`, plus four that scripts use to drive a chat. Only this socket serves those four; the tailnet listener answers them with 404 `{"error":"Not found"}`, because any local process can set its `Tailscale-User-Login` header.
  - `prompt` (`"text"`, up to 61,440 bytes as JSON) sends a user message. An idle chat gets it as an aside, which starts a turn (`{"started":true}`); a busy one gets it as a follow-up after the turn (`{"queued":true}`), never as a steer, because a steer denies an open tool approval.
  - `abort` interrupts the running turn, as Esc does, and replies once the turn stopped or after 5 seconds: `{"aborted":true,"idle":<stopped>}`, or `{"aborted":false}` when the chat is idle. While a question is open it is refused (`input_required`), since it would cancel the question; `"force":true` interrupts anyway.
  - `pending` returns the question the chat waits on, oldest first: `{"pending": {"ref", "reqId", "kind", "title", "options", "multi", "checked", "other", "ownerOnly", "since"} | null, "queued": <more open>}`. `ref` is `<instanceId>:<generation>:<reqId>:<titleHash>`, the hash being the first 8 hex characters of the SHA-256 of the title. `kind` is `approval` (a tool approval), `ask` (one field of an ask form), `select` (an extension's list) or `editor` (free text). `other` is true when the question takes free text from here. `ownerOnly` is true when the title names work only the owner may approve (production, `--force`, merge, release, deploy, `rm -rf`, `kubectl`, `helm`, `terraform`, `DROP`, secrets, tokens) or contains one of the words in `control.ownerOnlyWords`, ignoring case; `answer` refuses those. `pending` names no recommended option: omp preselects the first option of a list with no default, so the dialog cannot tell a recommendation apart. `since` is when the question was posed, or for one already open, the time of the chat's last transcript entry.
  - `answer` (`"ref"` from `pending`, required; `"value"`: an option's label, the free text, or a list of labels for a multi-select) answers that question as if the owner picked it: it checks each listed option, sets or clears the free text, then presses Next or Done. A tool approval takes only `Approve`, `Approve Once`, `Deny`, `Yes` or `No`; a grant for the session or for good is the owner's (403 `owner_only`). Reply: `{"answered": <reqId>, "next": <the next field of the same form, with its own ref, or null>}`.

  The extension cannot see or answer these questions (omp gives extensions no hook for them), so `pending` and `answer` join the chat's Collab room as a guest named `omp-sessions`, the way the phone's Control link does (`collab-guest.ts`): the chat shows "omp-sessions joined", the host sends the whole transcript first, and a large chat takes seconds. They join only when the host list says `inputRequired`; otherwise `pending` is `{"pending":null}` at once. One guest talks to a chat at a time. Each call gives up after 150 seconds, or as soon as the caller hangs up, and sends nothing after that.

  Replies: 200 with the session's answer (for `status`: its model, thinking level, whether it is idle, its running background `jobs`, the job results still `queued` for delivery, its skills and its dev cycle), 400 for a bad request or an answer that is no option, 403 for a view-only session or an `owner_only` question or answer, 404 when the session is not running or (`nothing_pending`) has no open question, 409 when its generation changed, it runs another session by then, another request is talking to it (`busy`), a question is open for `prompt`, `skill`, a cycle start or an unforced `abort` (`input_required`), or the question the `ref` names is no longer the one open, including after an omp restart (`changed`), 422 `rejected` when the chat shows the same field again because it did not take the value, 502 `protocol` when the host list shows an open question that never reached the guest, 503 `no_extension` for a session without the control extension, and 504 when the 150 seconds ran out: `timeout` when nothing was sent, `outcome_unknown` when an answer went out and may have landed (read `pending` again).

Both routes require `Content-Type: application/json` and refuse an `Origin` that is not the dashboard's. Any other method or path, `/` and `/api/v1/hosts` included, returns 404 `{"error":"Not found"}`. The log has one line per request, such as `local POST /api/control -> 200 [41.3ms]`.

Ask a live chat for its status (`omp collab list --json` gives each chat's `instanceId` and `generation`):
```bash
curl -s --unix-socket ~/.omp/run/omp-sessions-api/api.sock http://localhost/api/control \
  -H 'Content-Type: application/json' \
  -d '{"instanceId":"<instanceId>","generation":<generation>,"op":"status"}'
```

### Security

- Tailscale Serve sets the `Tailscale-User-Login` header from the device's login and replaces any value the client sends. The server returns 403 unless the header matches one of `allowedLogins` in the config file, ignoring case.
- `POST /api/v1/link` and `POST /api/v1/sessions` require `Content-Type: application/json`. When the browser sends an `Origin` header, it must exactly match `publicUrl`, `http://127.0.0.1:<port>`, or `http://localhost:<port>`.
- `POST /api/v1/sessions` accepts only a folder from the list the server built itself (`projects.root` and its direct subfolders), one of the `launch.models` choice ids and an optional `maxCost` number. The folder goes to cmux as its own argument. The command typed into the shell is built only from the profile and models in the config file, which the loader accepts only as letters, digits and `._:/@-`, and that checked number, so no text from the request reaches the shell.
- A Collab tab opened from the dashboard has `window.opener` cleared, so the Collab page cannot navigate the dashboard tab.
- The page copy runs on its own origin (port 8443). Its Content-Security-Policy lets it connect only to itself and `wss://my.omp.sh`, and the dashboard's `Origin` check rejects it, so a Watch tab cannot ask the dashboard for a Control link. Its listener requires the same Tailscale login, accepts only GET and HEAD, and serves only files inside `collab-dist/`.
- `POST /api/v1/control` has the same JSON and `Origin` checks. It accepts only a model choice id, a known thinking level, a skill name of letters, digits and `._:/-`, a cycle command name of letters, digits and `._-`, a compact focus of up to 2,000 characters, skill or cycle arguments of up to 4,000, a prompt of up to 61,440 bytes as JSON, and answers of up to 4,000 characters each (64 at most). dev-cycle starts only a command whose frontmatter declares cycle phases. Running a skill, starting a cycle, a prompt and an answer all act as the user, so Manage has the same power as a Control link and works only on sessions that share control access. `pending`, `answer`, `prompt` and `abort` are served only on the local API socket. `pending` and `answer` fetch the Control link from `omp collab link` on the server and never return it.
- `POST /api/v1/pin` and `POST /api/v1/long-tasks/reopen` have the same JSON and `Origin` checks and take only a session ID, a lowercase UUID. Reopen starts only pinned sessions. The command it types is built from constants, a profile name of letters, digits and `._-`, and a session file path that the server's own scan found under an agent dir's `sessions/` folder, in single quotes. A path with a newline or other control character is refused, because cmux types the command as keystrokes.
- `POST /api/v1/devices`, `POST /api/v1/devices/remove` and `POST /api/v1/push/test` have the same JSON and `Origin` checks and answer 404 while push is off. They take only a hex device token, an APNs environment the config has a key for, the configured bundle id, an app version of up to 64 characters and four event switches. A test push goes only to a registered device. `devices.json` and `push-state.json` are owner-only (0600, in a 0700 folder) and are replaced whole through a temp file. The log records a push as `push <kind> <apns-id> -> <status> <reason>` and a registration with the device's name, never a device token or the notification text.
- Job reports and the sidebar sync are local only: nothing from the phone reaches them, and a pin change, Reopen or New session only makes the next sync run sooner. Every value goes to cmux as its own argument, never through a shell, and the page sets report text as text, not HTML. A report message ends with "Posted by a scheduled job through the omp-sessions reporter, not typed by the user.", so the agent weighs it like any other input. Only your user can write the reports folder, and that user can already run omp.
- The guest name comes from `X-Forwarded-For`, which Tailscale Serve sets to the phone's tailnet address and overwrites when a client sends one. The server passes it to `tailscale whois --json` only when it is a plain IPv4 or IPv6 address, as its own argument, and accepts back only a one-label machine name of letters, digits and `-`. Names are cached for 10 minutes per address. A name is a label, not a credential: the Control link alone decides who may prompt.
- The control socket is owner-only, so only processes running as your user can use it; those can already run omp themselves.
- The local API socket is owner-only too (folder 0700, socket 0600) and has no Tailscale check: a process of your user can start a session or prompt one through it, which it could already do by running omp or cmux itself.
- Link responses carry `Cache-Control: no-store`. The log records method, path, status, and duration, plus one line per pin change, per Reopen and per sidebar change (`groups: moved workspace:1000010022 "797vega-release-notes" to "vega · long tasks"`); it never records links or message text.

### Configuration

The server reads its settings once at start from one JSON file: the path in `OMP_MOBILE_CONFIG`, else `~/.config/omp-mobile/config.json`. Copy `config.example.json` there to start. A missing file, a key the server does not know or a value of the wrong type stops the server with exit code 1, and the error log lists every problem. `report.ts`, `build-collab.ts` and `bun cmux-groups.ts` read the same file but run on the defaults without one. A path that starts with `~` starts in your home folder. Restart the service after a change.

| Key | Default | What it sets |
|---|---|---|
| `publicUrl` | required | The https address `tailscale serve` publishes the dashboard at, without a path. POSTs from any other page are refused. |
| `allowedLogins` | required | The Tailscale logins that may use the dashboard, ignoring case. |
| `port` | `7478` | The dashboard's port on `127.0.0.1`. |
| `omp.bin`, `omp.configRoot` | `~/.bun/bin/omp`, `~/.omp` | The omp binary, and omp's folder: agent dirs, profiles, session leases and the job reports. |
| `tailscaleBin` | `/Applications/Tailscale.app/Contents/MacOS/Tailscale` | Gives a chat the device name of its guest; `null` shows no names. |
| `projects.root` | `~` | New session offers this folder and the folders directly inside it; a chat below it has a project. |
| `projects.list` | `[]` | The projects in sidebar order, each `{"name", "families"}`. A folder whose name without leading digits is a family, or starts with one plus `-`, belongs to that project. |
| `projects.otherName` | the root folder's name | The project of every folder under the root that no listed project claims. |
| `pageCopy.publicUrl`, `pageCopy.port` | `null`, `7479` | The page copy's public address and port. `null` turns the page copy off; Watch and Control then open at my.omp.sh. |
| `longTasks.enabled` | `true` | Long tasks: pins, the Long tasks list and Reopen. |
| `launch.enabled` | `false` | New session and Reopen. |
| `launch.cmuxBin` | `/Applications/cmux.app/Contents/Resources/bin/cmux` | The cmux binary, for New session, Reopen and the sidebar sync. |
| `launch.profile` | `null` | The omp profile new sessions run under; `null` uses omp's default. |
| `launch.models`, `launch.defaultModel` | one choice, `default`, that sets no model | The model choices of New session and Manage, each `{"label", "model", "thinking"}` under an id; a `null` model or thinking level leaves the profile's own. `defaultModel` is the id New session preselects and uses when a request names none. |
| `control.enabled`, `control.devCycles` | `false`, `false` | Manage, and the dev-cycle actions in it. |
| `control.ownerOnlyWords` | `[]` | Words of your own that make a question owner-only for the local API's `pending` and `answer`, on top of the built-in list: a question whose title contains one, ignoring case, is marked `ownerOnly`, and `answer` refuses it. Plain text, not patterns; at most 100, none empty. |
| `reports.enabled` | `false` | Job report lines on cards. |
| `cmuxGroups.enabled` | `false` | The cmux sidebar sync. |
| `localApi.enabled`, `localApi.dir` | `false`, `<omp.configRoot>/run/omp-sessions-api` | The local API socket and its folder. |
| `push.enabled`, `push.bundleId`, `push.teamId` | `false`, `null`, `null` | Push notifications to the iOS app through Apple's push service (APNs). Turning it on needs the app's bundle id, the team id of the Apple Developer account and at least one key. |
| `push.keys.sandbox`, `push.keys.production` | `null`, `null` | The APNs key for each environment, `{"keyId", "path"}`: the key's 10-character id and its `.p8` file, mode 0600. Builds installed from Xcode use sandbox; TestFlight and App Store installs use production, so they get notifications only when `push.keys.production` names a key. When your Apple Developer key serves both environments, both name the same file. |
| `push.pollSeconds`, `push.includeSummary` | `5`, `true` | How often, in seconds (2 to 60), the server checks the chats for push while a device is registered, and whether a job report's notification shows the first line of its summary. |
| `stateDir` | `~/.config/omp-mobile/state` | The server's own files: `devices.json`, the devices registered for push, and `push-state.json`, the job reports already pushed. Nothing is written there while push is off. |

A part that is off answers its routes with 404 `{"error":"… is turned off on this server","code":"disabled"}`; a dev-cycle action with dev cycles off gets 400 with the same code.

### Modules

The session list with Watch and Control always runs. Every other part is a module with its own key in the config file:

| Module | Turned on by | Needs |
|---|---|---|
| Page copy, the patched Collab page | `pageCopy.publicUrl` | git and access to GitHub for `build-collab.ts`, and a second `tailscale serve` port |
| Long tasks: pins and the Long tasks tab | `longTasks.enabled`, on by default | nothing more |
| New session and Reopen | `launch.enabled` | cmux; Reopen also needs Long tasks |
| Manage | `control.enabled` | the control extension installed in the session's profile (see [Commands](#commands)) |
| Dev cycles in Manage | `control.devCycles` | a dev-cycle extension that answers on omp's event bus channel `dev-cycle:request` |
| Job report lines on cards | `reports.enabled` | job scripts that call `report.ts` |
| cmux sidebar groups | `cmuxGroups.enabled` | cmux |
| Local API socket | `localApi.enabled` | nothing more |
| Push notifications to the iOS app | `push.enabled` | a paid Apple Developer Program team and an APNs `.p8` key |

### New omp profile

A profile created later does not share its sessions until you run:

```bash
OMP_PROFILE=<name> omp config set collab.autoStart control
```

### Start at login

`scripts/install-launchd.sh` sets up the LaunchAgent `local.omp-mobile`, so the server starts at login and launchd restarts it when it exits. The script fills `launchd/local.omp-mobile.plist.template` with this folder's real path, your home folder and the folder that holds `bun`, writes the result to `~/Library/LaunchAgents/local.omp-mobile.plist`, checks it with `plutil`, and loads it. The job runs `omp-mobile-server.sh`, which starts `bun run server.ts`; the logs are `~/Library/Logs/omp-mobile.log` and `~/Library/Logs/omp-mobile.error.log`. Run the script again after you move this folder or reinstall bun: it unloads the running job before it loads the new one.

```bash
scripts/install-launchd.sh                               # from this folder: install, or install again
launchctl kickstart -k gui/$(id -u)/local.omp-mobile     # restart after editing the code
launchctl bootout gui/$(id -u)/local.omp-mobile          # stop, then uninstall:
rm ~/Library/LaunchAgents/local.omp-mobile.plist
```

### Names kept from omp-sessions

The server began as omp-sessions, a dashboard for one Mac. These names keep that word, because running chats, job scripts, session files or devices depend on them:

| Name | Why it stays |
|---|---|
| `~/.omp/omp-sessions/reports/` | Job scripts write their reports there, and running chats read them. |
| `~/.omp/run/omp-sessions-control/<pid>.sock` | The control extension in each running chat listens there. |
| `~/.omp/run/omp-sessions-api/api.sock` | Scripts reach the local API there. |
| Message type `omp-sessions-report` | Session files store it; a new name would post old reports again. |
| cmux group IDs `omp-sessions:*` | A new ID would leave the existing sidebar groups behind. |
| `extension/omp-sessions-control.ts` | Profiles link the extension under this file name. |
| Browser storage keys `omp-sessions:*` | Each device keeps its choices under them. |

### Commands

Run these from this folder.

Publish to the tailnet, check, and unpublish (dashboard on 443, page copy on 8443):
```bash
tailscale serve --bg 7478
tailscale serve --bg --https=8443 http://127.0.0.1:7479
tailscale serve status
tailscale serve --https=443 off
tailscale serve --https=8443 off
```

Rebuild the page copy by hand, to build at once (for example after editing `collab-web.patch`) or to see the full error of a failed build (the server picks it up on the next tap, no restart needed):
```bash
bun build-collab.ts
```

See or run the sidebar sync by hand (add `--window window:N` to limit it to one window, and `--root <folder>` to use another `projects.root`):
```bash
bun cmux-groups.ts           # print what the next check would change
bun cmux-groups.ts --apply   # run one check now
```

Install or remove the session-control extension in one profile; sessions pick it up when they start. The default profile's folder is `~/.omp/agent/extensions`:
```bash
ln -sfn "$PWD/extension/omp-sessions-control.ts" ~/.omp/profiles/<profile>/agent/extensions/omp-sessions-control.ts
rm ~/.omp/profiles/<profile>/agent/extensions/omp-sessions-control.ts
```

Check push from this Mac. `--fake-key` needs no config and no Apple account: APNs answers `status 403 InvalidProviderToken`, which shows the Mac reaches it. `--token` sends a test notification to one device with the config's key:
```bash
bun scripts/push-test.ts --fake-key
bun scripts/push-test.ts --token <hex> [--env sandbox|production]
```

Logs:
```bash
tail -f ~/Library/Logs/omp-mobile.log
tail -f ~/Library/Logs/omp-mobile.error.log
```

Tests:
```bash
bun test
```
