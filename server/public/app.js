// Client script for omp Sessions dashboard

const POLL_INTERVAL_MS = 10_000;

let lastFetchedAt = 0;
// Why Watch/Control open at my.omp.sh instead of the dashboard's page copy; empty when they don't.
let pageCopyNote = "";
let pollTimer = null;
let isFetching = false;
let pendingControlTarget = null;
// Last lists from /api/v1/hosts; typing in the search box or switching tabs re-filters them without a fetch.
let lastHosts = [];
let lastLongTasks = [];
// Project names in the order the Long tasks tab shows its sections (projects.ts on the server).
let lastProjects = [];
// Set when a pin or reopen asks for the list while a poll is in flight: that poll's
// answer may predate the change, so fetch once more when it lands.
let refetchQueued = false;
// Session id of the long task being reopened. The list re-renders every 10 s, so its
// Reopen button reads this to keep showing "Starting…".
let reopeningId = null;
// Job report lines the user tapped open, by `<sessionId> <job> <at>`, kept across re-renders.
const openReports = new Set();

const sessionListEl = document.getElementById("session-list");
const statusTextEl = document.getElementById("status-text");
const searchInputEl = document.getElementById("search-input");
const searchCountEl = document.getElementById("search-count");
const tabBarEl = document.getElementById("tab-bar");
const projectChipsEl = document.getElementById("project-chips");
const tabChatsCountEl = document.getElementById("tab-chats-count");
const tabLongTasksCountEl = document.getElementById("tab-long-tasks-count");
const TAB_BUTTONS = {
  chats: document.getElementById("tab-chats"),
  "long-tasks": document.getElementById("tab-long-tasks"),
};
const refreshBtnEl = document.getElementById("refresh-btn");
const themeBtnEl = document.getElementById("theme-btn");
const errorBannerEl = document.getElementById("error-banner");
const toastContainerEl = document.getElementById("toast-container");
const confirmDialogEl = document.getElementById("confirm-dialog");
const dialogBodyEl = document.getElementById("dialog-body");
const dialogConfirmEl = document.getElementById("dialog-confirm");
const newSessionBtnEl = document.getElementById("new-session-btn");
const launchDialogEl = document.getElementById("launch-dialog");
const launchFormEl = document.getElementById("launch-form");
const launchFolderEl = document.getElementById("launch-folder");
const launchModelEl = document.getElementById("launch-model");
const launchStatusEl = document.getElementById("launch-status");
const launchStartEl = document.getElementById("launch-start");
const launchCancelEl = document.getElementById("launch-cancel");
const manageDialogEl = document.getElementById("manage-dialog");
const manageTitleEl = document.getElementById("manage-title");
const manageStateEl = document.getElementById("manage-state");
const manageModelEl = document.getElementById("manage-model");
const manageModelApplyEl = document.getElementById("manage-model-apply");
const manageThinkingEl = document.getElementById("manage-thinking");
const manageThinkingApplyEl = document.getElementById("manage-thinking-apply");
const manageSkillEl = document.getElementById("manage-skill");
const manageSkillArgsEl = document.getElementById("manage-skill-args");
const manageSkillRunEl = document.getElementById("manage-skill-run");
const manageCompactFocusEl = document.getElementById("manage-compact-focus");
const manageCompactEl = document.getElementById("manage-compact");
const manageMessageEl = document.getElementById("manage-message");
const manageCloseEl = document.getElementById("manage-close");
const manageCycleFieldEl = document.getElementById("manage-cycle-field");
const manageCycleNoteEl = document.getElementById("manage-cycle-note");
const manageCycleStartEl = document.getElementById("manage-cycle-start");
const manageCycleEl = document.getElementById("manage-cycle");
const manageCycleArgsEl = document.getElementById("manage-cycle-args");
const manageCycleRunEl = document.getElementById("manage-cycle-run");
const manageCycleLiveEl = document.getElementById("manage-cycle-live");
const manageCycleResumeEl = document.getElementById("manage-cycle-resume");
const manageCycleStopEl = document.getElementById("manage-cycle-stop");
const MANAGE_CONTROLS = [
  manageModelEl,
  manageModelApplyEl,
  manageThinkingEl,
  manageThinkingApplyEl,
  manageSkillEl,
  manageSkillArgsEl,
  manageSkillRunEl,
  manageCompactFocusEl,
  manageCompactEl,
  manageCycleEl,
  manageCycleArgsEl,
  manageCycleRunEl,
  manageCycleResumeEl,
  manageCycleStopEl,
];

const LAST_FOLDER_KEY = "omp-sessions:last-folder";
const LAST_MODEL_KEY = "omp-sessions:last-model";
const TAB_KEY = "omp-sessions:tab";
// The project picked with the chips, stored as its plain name; no key means All.
const PROJECT_KEY = "omp-sessions:project";
// Earlier versions stored a JSON list of picked projects here; readSelectedProject moves it over once.
const LEGACY_PROJECTS_KEY = "omp-sessions:projects";
// The chip and Long tasks section for chats outside OMP_ROOT, whose `project` is null.
const OTHER_PROJECT = "other";
// What the server runs (GET /api/v1/info, read once at load). Until it answers, and when that
// request fails, both modules count as on, as before, so no button goes missing by mistake.
let features = { launch: true, control: true };
// Closed long tasks name their profile only when it is not this one, the profile New session uses (null: omp's default).
let mainProfile = null;
// The server answers a reopen once the chat shows up in omp's list, giving up after 25 s;
// opening the cmux workspace comes on top of that.
const REOPEN_TIMEOUT_MS = 45_000;
// Lucide "pin" icon. CSS fills it on long tasks and leaves it an outline on chats.
const PIN_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
let activeTab = localStorage.getItem(TAB_KEY) === "long-tasks" ? "long-tasks" : "chats";
// The project picked with the chips under the tabs, for both tabs; null is All, which shows every project.
let selectedProject = readSelectedProject();
let launching = false;
let launchedSession = null;
// Manage dialog: the host it acts on, its last status reply (null until one loads),
// and the model presets from that reply. manageSeq changes on every open and close,
// so a reply that arrives after the dialog moved on is dropped.
let manageTarget = null;
let manageStatus = null;
let managePresets = [];
let manageSeq = 0;

function showToast(message, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast ${isError ? "toast-error" : ""}`;
  toast.textContent = message;
  toastContainerEl.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function updateStatusText() {
  if (!lastFetchedAt) {
    statusTextEl.textContent = "Connecting…";
    return;
  }
  const sec = Math.floor((Date.now() - lastFetchedAt) / 1000);
  const updated = sec <= 2 ? "Updated just now" : `Updated ${sec}s ago`;
  statusTextEl.textContent = pageCopyNote ? `${updated} · ${pageCopyNote}` : updated;
}

setInterval(updateStatusText, 1000);

// Background polls stay quiet; the refresh icon spins only when the user taps it.
async function loadHosts({ manual = false, afterChange = false } = {}) {
  if (isFetching) {
    if (afterChange) refetchQueued = true;
    return;
  }
  isFetching = true;
  if (manual) refreshBtnEl.classList.add("spinning");

  try {
    const res = await fetch("/api/v1/hosts", {
      headers: { Accept: "application/json" },
    });

    if (res.status === 403) {
      errorBannerEl.textContent = "Access denied: Tailscale account not authorized.";
      errorBannerEl.classList.remove("hidden");
      sessionListEl.innerHTML = "";
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    lastFetchedAt = data.fetchedAt || Date.now();
    pageCopyNote = data.pageCopy && data.pageCopy.ok === false ? data.pageCopy.reason : "";
    updateStatusText();
    errorBannerEl.classList.add("hidden");
    lastHosts = data.hosts || [];
    // An older server sends no longTasks and no `pinned`: everything is a chat.
    lastLongTasks = data.longTasks || [];
    lastProjects = data.projects || [];
    renderHosts();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorBannerEl.textContent = `Failed to fetch sessions: ${msg}`;
    errorBannerEl.classList.remove("hidden");
  } finally {
    isFetching = false;
    refreshBtnEl.classList.remove("spinning");
    if (refetchQueued) {
      refetchQueued = false;
      loadHosts();
    }
  }
}

// Each card is one entry: `host` is the live chat (null when a long task is closed),
// `task` its long task (null for a chat), `pinned` says it belongs in Long tasks,
// and `title` is the session title for long tasks, else the folder name.
function renderHosts() {
  // Nothing to filter before the first answer; keep the "Scanning for sessions…" placeholder.
  if (!lastFetchedAt) return;

  const tasksById = new Map(lastLongTasks.map((task) => [task.sessionId, task]));
  const chats = [];
  const longTasks = [];
  for (const host of lastHosts) {
    const task = tasksById.get(host.sessionId) ?? null;
    // `pinned` without a task happens when /pin ran on the Mac before omp wrote the session file.
    if (host.pinned === true || task) {
      longTasks.push({ host, task, pinned: true, title: task?.title || host.folder });
    } else {
      chats.push({ host, task: null, pinned: false, title: host.folder });
    }
  }
  // Live long tasks keep the server's order (needs input, running, idle); closed ones
  // come after, most recently active first as the server sends them.
  const liveIds = new Set(lastHosts.map((host) => host.sessionId));
  for (const task of lastLongTasks) {
    if (!liveIds.has(task.sessionId)) longTasks.push({ host: null, task, pinned: true, title: task.title || task.folder });
  }
  tabChatsCountEl.textContent = String(chats.length);
  tabLongTasksCountEl.textContent = String(longTasks.length);

  const isChats = activeTab === "chats";
  const kind = isChats ? "chats" : "long tasks";
  const entries = isChats ? chats : longTasks;
  const words = searchInputEl.value.toLowerCase().split(/\s+/).filter(Boolean);
  // Every word must appear in the title, the session name (or the short ID shown instead), the folder name, or its path.
  const matching = entries.filter(({ host, task, title }) => {
    const session = host ?? task;
    const text = `${title} ${host?.sessionName ?? ""} ${session.sessionId.slice(0, 8)} ${session.folder} ${session.cwd}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });

  // The chips: every project in the server's order, then "other" while a card on either tab is
  // outside OMP_ROOT or the filter holds it. A picked project the server no longer lists falls back to All.
  const projectNames = [...lastProjects];
  if (selectedProject === OTHER_PROJECT || [...chats, ...longTasks].some((entry) => entryProject(entry) === OTHER_PROJECT)) {
    projectNames.push(OTHER_PROJECT);
  }
  if (selectedProject !== null && !projectNames.includes(selectedProject)) {
    selectedProject = null;
    localStorage.removeItem(PROJECT_KEY);
  }
  // Each chip counts the cards of the open tab that match the search.
  const counts = new Map();
  for (const entry of matching) {
    const project = entryProject(entry);
    counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  renderProjectChips(projectNames, counts, matching.length);
  const shown = selectedProject === null ? matching : matching.filter((entry) => entryProject(entry) === selectedProject);

  searchCountEl.textContent =
    (words.length > 0 || selectedProject !== null) && entries.length > 0 ? `${shown.length} of ${entries.length} ${kind}` : "";
  sessionListEl.innerHTML = "";

  if (entries.length === 0) {
    if (!isChats) {
      appendEmptyState(
        "No long tasks yet",
        features.launch
          ? "Tap the pin on a chat to keep it here, or type /pin in that chat on the Mac. Long tasks stay here after their chat closes; tap Reopen to start them again."
          : "Tap the pin on a chat to keep it here, or type /pin in that chat on the Mac. Long tasks stay here after their chat closes."
      );
    } else if (lastHosts.length > 0) {
      appendEmptyState("Every live chat is a long task", "Find them in the Long tasks tab.");
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `
        <p class="empty-title">No active shared sessions</p>
        <p class="empty-hint">Sessions appear here when <code>collab.autoStart</code> is set to <code>control</code> or <code>view</code> in their profile and they were started after it was enabled.</p>
      `;
      sessionListEl.appendChild(empty);
    }
    return;
  }

  if (shown.length === 0) {
    const picked = selectedProject ?? "";
    const where = picked ? ` in ${picked}` : "";
    let hint;
    if (!picked) {
      hint = isChats
        ? "Search checks the session name and the folder. Clear the box to see every chat."
        : "Search checks the title and the folder. Clear the box to see every long task.";
    } else if (words.length === 0) {
      hint = "Tap All to see every project.";
    } else {
      hint = "Search checks the name and the folder. Clear the box or tap All to see more.";
    }
    appendEmptyState(words.length > 0 ? `No ${kind}${where} match “${searchInputEl.value.trim()}”` : `No ${kind}${where}`, hint);
    return;
  }

  if (isChats) {
    for (const entry of shown) sessionListEl.appendChild(entry.host ? buildLiveCard(entry) : buildClosedCard(entry));
    return;
  }
  // Long tasks: a section per project in the chips' order. Each keeps the order above; a section
  // with nothing to show is left out.
  const sections = new Map(projectNames.map((name) => [name, []]));
  for (const entry of shown) sections.get(entryProject(entry)).push(entry);
  for (const [name, list] of sections) {
    if (list.length === 0) continue;
    const section = document.createElement("section");
    section.className = "project-section";
    const heading = document.createElement("h2");
    heading.className = "section-heading";
    const count = document.createElement("span");
    count.className = "section-count";
    count.textContent = String(list.length);
    heading.append(name, count);
    section.append(heading, ...list.map((entry) => (entry.host ? buildLiveCard(entry) : buildClosedCard(entry))));
    sessionListEl.appendChild(section);
  }
}

// The project of a card, for the chips and the Long tasks sections: the server's, else "other".
function entryProject(entry) {
  const project = (entry.host ?? entry.task).project;
  return lastProjects.includes(project) ? project : OTHER_PROJECT;
}

// The project picked on an earlier visit; null for All. A list stored under LEGACY_PROJECTS_KEY by
// an earlier version moves over once: exactly one name carries over, anything else (several
// names, none, not JSON) becomes All. renderHosts drops a name the server no longer lists.
function readSelectedProject() {
  const legacy = localStorage.getItem(LEGACY_PROJECTS_KEY);
  if (legacy !== null) {
    let names;
    try {
      names = JSON.parse(legacy);
    } catch {
      names = [];
    }
    if (Array.isArray(names) && names.length === 1 && typeof names[0] === "string") localStorage.setItem(PROJECT_KEY, names[0]);
    else localStorage.removeItem(PROJECT_KEY);
    localStorage.removeItem(LEGACY_PROJECTS_KEY);
  }
  return localStorage.getItem(PROJECT_KEY);
}

// All, then a chip per project with how many cards it holds. The buttons are rebuilt only when
// the projects change, so a tapped chip keeps its focus across the 10-second refreshes.
function renderProjectChips(names, counts, total) {
  const wanted = ["", ...names];
  if ([...projectChipsEl.children].map((chip) => chip.dataset.project).join("\n") !== wanted.join("\n")) {
    projectChipsEl.replaceChildren(
      ...wanted.map((name) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.dataset.project = name;
        const label = document.createElement("span");
        label.textContent = name || "All";
        const count = document.createElement("span");
        count.className = "chip-count";
        chip.append(label, count);
        return chip;
      })
    );
  }
  for (const chip of projectChipsEl.children) {
    const name = chip.dataset.project;
    const count = name ? (counts.get(name) ?? 0) : total;
    chip.lastElementChild.textContent = String(count);
    chip.setAttribute("aria-pressed", String(name ? name === selectedProject : selectedProject === null));
    chip.classList.toggle("is-empty", count === 0);
  }
}

function appendEmptyState(title, hint) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const emptyTitle = document.createElement("p");
  emptyTitle.className = "empty-title";
  emptyTitle.textContent = title;
  const emptyHint = document.createElement("p");
  emptyHint.className = "empty-hint";
  emptyHint.textContent = hint;
  empty.append(emptyTitle, emptyHint);
  sessionListEl.appendChild(empty);
}

// Title and path, status badges, and the pin that moves the card to the other tab.
function buildCardHeader(entry, badges) {
  const header = document.createElement("div");
  header.className = "card-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "card-title";
  const title = document.createElement("h2");
  title.className = "project-name";
  title.textContent = entry.title;
  const path = document.createElement("p");
  path.className = "project-path";
  path.textContent = (entry.host ?? entry.task).cwd;
  titleGroup.append(title, path);

  const pinLabel = entry.pinned ? "Remove from Long tasks" : "Move to Long tasks";
  const pinBtn = document.createElement("button");
  pinBtn.className = entry.pinned ? "pin-btn is-pinned" : "pin-btn";
  pinBtn.type = "button";
  pinBtn.title = pinLabel;
  pinBtn.setAttribute("aria-label", pinLabel);
  pinBtn.innerHTML = PIN_ICON;
  pinBtn.addEventListener("click", () => setPinned(entry, pinBtn));

  header.append(titleGroup, badges, pinBtn);
  return header;
}

function buildStatusChip(tone, label) {
  const chip = document.createElement("span");
  chip.className = `badge badge-${tone}`;
  const dot = document.createElement("span");
  dot.className = "badge-dot";
  chip.append(dot, label);
  return chip;
}

function buildLiveCard(entry) {
  const { host } = entry;
  const card = document.createElement("article");
  card.className = "session-card";

  const badges = document.createElement("div");
  badges.className = "badges-wrap";
  if (host.inputRequired) {
    badges.appendChild(buildStatusChip("amber", "Needs input"));
  } else if (host.busy === true) {
    badges.appendChild(buildStatusChip("blue", "Running"));
  } else if (host.busy === false) {
    badges.appendChild(buildStatusChip("green", "Idle"));
  } else {
    badges.appendChild(buildStatusChip("gray", "Unknown"));
  }

  if (host.participants > 1) {
    const guestBadge = document.createElement("span");
    guestBadge.className = "badge badge-gray";
    guestBadge.textContent = `${host.participants} connected`;
    badges.appendChild(guestBadge);
  }

  if (!host.relayConnected) {
    const relayBadge = document.createElement("span");
    relayBadge.className = "badge badge-offline";
    relayBadge.textContent = "Relay offline";
    badges.appendChild(relayBadge);
  }

  // Meta row
  const meta = document.createElement("div");
  meta.className = "card-meta";

  const sessName = host.sessionName ? host.sessionName : host.sessionId.slice(0, 8);
  meta.innerHTML = `
    <span class="meta-item"><strong>Session:</strong> ${escapeHtml(sessName)}</span>
    <span class="meta-item"><strong>Model:</strong> ${escapeHtml(host.model)}</span>
    <span class="meta-item"><strong>Started:</strong> ${formatRelativeTime(host.startedAt)}</span>
  `;

  // Actions
  const actions = document.createElement("div");
  actions.className = host.access !== "control" ? "card-actions single-btn" : features.control ? "card-actions three-btn" : "card-actions";

  const watchBtn = document.createElement("button");
  watchBtn.className = "btn btn-secondary";
  watchBtn.type = "button";
  watchBtn.textContent = "Watch";
  if (!host.relayConnected) watchBtn.disabled = true;
  watchBtn.addEventListener("click", () => openSession(host, "view", watchBtn));

  actions.appendChild(watchBtn);

  if (host.access === "control") {
    const controlBtn = document.createElement("button");
    controlBtn.className = "btn btn-primary";
    controlBtn.type = "button";
    controlBtn.textContent = "Control";
    if (!host.relayConnected) controlBtn.disabled = true;
    controlBtn.addEventListener("click", () => requestControl(host, controlBtn));
    actions.appendChild(controlBtn);

    // Talks to the session's control extension, not to Collab, so it works without the relay.
    // Only when the server runs Manage.
    if (features.control) {
      const manageBtn = document.createElement("button");
      manageBtn.className = "btn btn-secondary";
      manageBtn.type = "button";
      manageBtn.textContent = "Manage";
      manageBtn.addEventListener("click", () => openManageDialog(host));
      actions.appendChild(manageBtn);
    }
  }

  card.append(buildCardHeader(entry, badges), meta, ...buildReportList(host.sessionId, host.reports), actions);
  return card;
}

// A long task whose chat is not running: nothing to watch or control, only Reopen when the server runs New session.
function buildClosedCard(entry) {
  const { task } = entry;
  const card = document.createElement("article");
  card.className = "session-card";

  const badges = document.createElement("div");
  badges.className = "badges-wrap";
  badges.appendChild(buildStatusChip("gray", "Closed"));

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.innerHTML = `<span class="meta-item"><strong>Last active:</strong> ${formatRelativeTime(task.lastActiveAt)}</span>`;
  if (task.profile !== mainProfile) {
    // A null profile is omp's default agent dir (~/.omp/agent).
    meta.insertAdjacentHTML("beforeend", `<span class="meta-item"><strong>Profile:</strong> ${escapeHtml(task.profile ?? "default")}</span>`);
  }

  card.append(buildCardHeader(entry, badges), meta, ...buildReportList(task.sessionId, task.reports));
  if (features.launch) {
    const actions = document.createElement("div");
    actions.className = "card-actions single-btn";
    const reopenBtn = document.createElement("button");
    reopenBtn.className = "btn btn-primary";
    reopenBtn.type = "button";
    reopenBtn.textContent = reopeningId === task.sessionId ? "Starting…" : "Reopen";
    // The Mac starts one chat at a time, so every Reopen waits while one is starting.
    reopenBtn.disabled = reopeningId !== null;
    reopenBtn.addEventListener("click", () => reopenLongTask(entry));
    actions.appendChild(reopenBtn);
    card.append(actions);
  }
  return card;
}

// "today 03:04", "yesterday 09:00", "3d ago", counted in calendar days.
function formatReportTime(iso) {
  const at = new Date(iso);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
  const days = Math.round((today - day) / 86_400_000);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${days}d ago`;
}

// Report mark per outcome; reports.ts lists the outcomes.
const REPORT_MARKS = { ok: "✓", update: "i", failed: "✕" };

// The latest report of each job (a long task's jobs post them with report.ts), one line each:
// outcome, job, time and the summary's first line. Tapping a line shows the whole summary and
// the details path. An empty array when there are none, to spread into append().
function buildReportList(sessionId, reports) {
  if (reports.length === 0) return [];
  const list = document.createElement("ul");
  list.className = "report-list";
  for (const report of reports) {
    const key = `${sessionId} ${report.job} ${report.at}`;
    const item = document.createElement("li");
    item.className = `report report-${report.outcome}`;

    const line = document.createElement("button");
    line.type = "button";
    line.className = "report-line";
    line.title = report.summary;
    const mark = document.createElement("span");
    mark.className = "report-mark";
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", report.outcome);
    mark.textContent = REPORT_MARKS[report.outcome] ?? REPORT_MARKS.failed;
    const job = document.createElement("span");
    job.className = "report-job";
    job.textContent = report.job;
    const time = document.createElement("span");
    time.className = "report-time";
    time.textContent = formatReportTime(report.at);
    const summary = document.createElement("span");
    summary.className = "report-summary";
    summary.textContent = report.summary.split("\n")[0];
    line.append(mark, job, time, summary);

    const full = document.createElement("div");
    full.className = "report-full";
    full.textContent = report.summary;
    if (report.details) {
      const details = document.createElement("p");
      details.className = "report-details";
      details.textContent = report.details;
      full.appendChild(details);
    }

    const setOpen = (open) => {
      line.setAttribute("aria-expanded", String(open));
      full.hidden = !open;
    };
    setOpen(openReports.has(key));
    line.addEventListener("click", () => {
      if (openReports.has(key)) openReports.delete(key);
      else openReports.add(key);
      setOpen(openReports.has(key));
    });
    item.append(line, full);
    list.appendChild(item);
  }
  return [list];
}

// Pins or unpins the card's omp session, the same pin as /pin on the Mac, which moves
// the card to the other tab.
async function setPinned(entry, btn) {
  const pinned = !entry.pinned;
  const closed = entry.host === null;
  if (closed && !confirm(`Remove "${entry.title}" from Long tasks? Its chat is closed, so it disappears from this page. On the Mac, omp --resume still finds it.`)) return;

  btn.disabled = true;
  try {
    const res = await fetch("/api/v1/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: (entry.host ?? entry.task).sessionId, pinned }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    let message = "Moved to Long tasks";
    if (!pinned) message = closed ? "Removed from Long tasks" : "Moved to Chats";
    showToast(message);
    loadHosts({ afterChange: true });
  } catch (err) {
    showToast(`${pinned ? "Pin" : "Unpin"} failed: ${errorText(err)}`, true);
    btn.disabled = false;
  }
}

// Starts a closed long task again in a cmux workspace on the Mac. The server answers
// once the chat is back in omp's list, so the reload turns the card live.
async function reopenLongTask(entry) {
  const { task } = entry;
  reopeningId = task.sessionId;
  renderHosts();
  try {
    const res = await fetch("/api/v1/long-tasks/reopen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: task.sessionId }),
      signal: AbortSignal.timeout(REOPEN_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 201) {
      showToast(`Reopened ${entry.title} on the Mac`);
    } else if (res.status !== 409 || data.code !== "running") {
      // 409 "running" needs no toast: the chat is already live and the reload shows it.
      showToast(data.error || `Could not reopen (HTTP ${res.status})`, true);
    }
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    showToast(
      timedOut ? `No answer from the Mac within ${REOPEN_TIMEOUT_MS / 1000} s. The list shows whether it started.` : `Network error: ${errorText(err)}`,
      true
    );
  } finally {
    await loadHosts({ afterChange: true });
    reopeningId = null;
    renderHosts();
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, (tag) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[tag] || tag));
}

function requestControl(host, btn) {
  pendingControlTarget = { host, btn };
  dialogBodyEl.textContent = `Open full control of "${host.folder}"? Anyone holding this link can prompt the agent and execute shell commands/tools on your Mac.`;
  confirmDialogEl.showModal();
}

// Handle the confirm tap itself (not the dialog's close event) so the new tab
// opens inside the user gesture and iOS WebKit (Safari and Chrome) does not block it.
dialogConfirmEl.addEventListener("click", () => {
  if (!pendingControlTarget) return;
  const { host, btn } = pendingControlTarget;
  pendingControlTarget = null;
  openSession(host, "control", btn);
});

confirmDialogEl.addEventListener("close", () => {
  pendingControlTarget = null;
});

// iOS WebKit (Safari and Chrome) allows window.open only while handling the tap, but the link needs a
// server round trip. Open an empty tab now and point it at the link when it arrives.
function openPendingTab() {
  const tab = window.open("", "_blank");
  if (!tab) return null;
  tab.opener = null; // the Collab page must not be able to navigate this dashboard
  tab.document.title = "Opening session…";
  tab.document.body.textContent = "Opening session…";
  return tab;
}

// The chat page has no theme switch of its own: it follows this page's through ?theme=.
// The URL API keeps the rest as is, including the #fragment with the room key.
function withTheme(url) {
  const link = new URL(url);
  link.searchParams.set("theme", themePreference());
  return link.href;
}

function showCollab(tab, url) {
  const themedUrl = withTheme(url);
  if (!tab) {
    window.location.assign(themedUrl); // popup blocked: fall back to this tab
  } else if (!tab.closed) {
    tab.location.replace(themedUrl);
  }
}

async function openSession(session, access, btn = null) {
  const tab = openPendingTab();
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Opening…";
  }

  try {
    const { res, data } = await fetchLink(session.instanceId, session.generation, access);
    if (res.ok && data.url) {
      showCollab(tab, data.url);
      return;
    }

    tab?.close();
    if (res.status === 409 || res.status === 404) {
      showToast("Session was rotated or ended. Refreshing…", true);
      loadHosts();
    } else if (res.status === 403) {
      showToast("Control access is not enabled for this session.", true);
    } else {
      showToast(data.error || `Failed to open session (HTTP ${res.status})`, true);
    }
  } catch (err) {
    tab?.close();
    showToast(`Network error: ${errorText(err)}`, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function fetchLink(instanceId, generation, access) {
  const res = await fetch("/api/v1/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceId, generation, access }),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

function setLaunchStatus(text, isError = false) {
  launchStatusEl.textContent = text;
  launchStatusEl.classList.toggle("is-error", isError);
}

function resetLaunchForm() {
  launchedSession = null;
  launchStartEl.textContent = "Start";
  setLaunchStatus("");
}

function fillSelect(selectEl, values, selected, labelFor) {
  selectEl.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labelFor(value);
      option.selected = value === selected;
      return option;
    })
  );
}

function leafName(folder) {
  return folder.split("/").pop();
}

function setLaunchInputsEnabled(enabled) {
  launchFolderEl.disabled = !enabled;
  launchModelEl.disabled = !enabled;
}

async function openLaunchDialog() {
  launchDialogEl.showModal();
  if (launching) return; // keep showing the in-progress status

  resetLaunchForm();
  setLaunchInputsEnabled(false);
  launchStartEl.disabled = true;
  setLaunchStatus("Loading folders and models…");

  try {
    const res = await fetch("/api/v1/launch-options", { headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const root = data.folders[0];
    const lastFolder = localStorage.getItem(LAST_FOLDER_KEY);
    fillSelect(launchFolderEl, data.folders, data.folders.includes(lastFolder) ? lastFolder : root, (f) =>
      f === root ? `${leafName(f)} (top folder)` : leafName(f)
    );
    const labels = Object.fromEntries(data.models.map((m) => [m.id, m.label]));
    const lastModel = localStorage.getItem(LAST_MODEL_KEY);
    fillSelect(launchModelEl, Object.keys(labels), Object.hasOwn(labels, lastModel ?? "") ? lastModel : data.defaultModel, (id) => labels[id]);
    setLaunchStatus("");
    setLaunchInputsEnabled(true);
    launchStartEl.disabled = false;
  } catch (err) {
    setLaunchStatus(`Could not load folders: ${errorText(err)}`, true);
  }
}

async function startSession(folder, model) {
  launching = true;
  setLaunchInputsEnabled(false);
  launchStartEl.disabled = true;
  const modelLabel = launchModelEl.selectedOptions[0]?.textContent;
  setLaunchStatus(`Starting omp in ${leafName(folder)} on ${modelLabel}… this takes a few seconds.`);

  try {
    const res = await fetch("/api/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, model }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 201) throw new Error(data.error || `HTTP ${res.status}`);

    loadHosts();
    if (!launchDialogEl.open) {
      showToast(`New session in ${leafName(folder)} is ready in the list.`);
      return;
    }
    // Opening needs a fresh tap: iOS WebKit blocks a new tab opened seconds after the Start tap.
    launchedSession = data;
    setLaunchStatus(`Session in ${leafName(folder)} is ready.`);
    launchStartEl.textContent = "Open";
  } catch (err) {
    if (launchDialogEl.open) {
      setLaunchStatus(errorText(err), true);
    } else {
      showToast(errorText(err), true);
    }
  } finally {
    launching = false;
    launchStartEl.disabled = false;
    setLaunchInputsEnabled(launchedSession === null);
  }
}

newSessionBtnEl.addEventListener("click", () => {
  openLaunchDialog();
});

launchCancelEl.addEventListener("click", () => {
  launchDialogEl.close();
});

launchFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  if (launching) return;

  if (launchedSession) {
    openSession(launchedSession, launchedSession.access);
    launchDialogEl.close();
    return;
  }

  const folder = launchFolderEl.value;
  const model = launchModelEl.value;
  localStorage.setItem(LAST_FOLDER_KEY, folder);
  localStorage.setItem(LAST_MODEL_KEY, model);
  startSession(folder, model);
});

function setManageMessage(text, isError = false) {
  manageMessageEl.textContent = text;
  manageMessageEl.classList.toggle("is-error", isError);
}

function setManageEnabled(enabled) {
  for (const el of MANAGE_CONTROLS) el.disabled = !enabled;
  const canRunSkill = enabled && manageStatus.skills.length > 0;
  manageSkillEl.disabled = !canRunSkill;
  manageSkillArgsEl.disabled = !canRunSkill;
  manageSkillRunEl.disabled = !canRunSkill;
  const cycle = enabled ? manageStatus.cycle : null;
  const canStartCycle = (cycle?.commands.length ?? 0) > 0;
  manageCycleEl.disabled = !canStartCycle;
  manageCycleArgsEl.disabled = !canStartCycle;
  manageCycleRunEl.disabled = !canStartCycle;
  // A paused cycle, or an active one whose phase stopped without cycle_done (the session is idle).
  manageCycleResumeEl.disabled = !(cycle?.state && (cycle.state.status === "paused" || manageStatus.idle));
}

// Shows a status reply (from status, set-model or set-thinking) and unlocks the controls.
function showManageStatus(status) {
  manageStatus = status;
  manageStateEl.textContent = `${status.model ?? "Unknown model"} · ${status.thinking ?? "no thinking level"} · ${status.idle ? "Idle" : "Running"}`;

  const current =
    managePresets.find((p) => p.model === status.model && p.thinking === status.thinking) ||
    managePresets.find((p) => p.model === status.model);
  const labels = Object.fromEntries(managePresets.map((p) => [p.id, p.label]));
  fillSelect(manageModelEl, Object.keys(labels), current?.id, (id) => labels[id]);
  if (!current) {
    const placeholder = new Option(`Current: ${status.model ?? "unknown"}`, "", true, true);
    placeholder.disabled = true;
    manageModelEl.prepend(placeholder);
  }
  for (const option of manageThinkingEl.options) option.selected = option.value === status.thinking;
  renderManageCycle(status);
  setManageEnabled(true);
}

// The Dev cycle field. `cycle` is missing or null when the session's extensions predate
// dashboard cycles; otherwise it lists the folder's cycle commands and the active or paused cycle.
function renderManageCycle(status) {
  const cycle = status.cycle ?? null;
  const running = cycle?.state ?? null;
  manageCycleFieldEl.classList.toggle("hidden", cycle !== null && running === null && cycle.commands.length === 0);
  manageCycleStartEl.classList.toggle("hidden", cycle === null || running !== null);
  manageCycleLiveEl.classList.toggle("hidden", running === null);
  if (cycle === null) {
    manageCycleNoteEl.textContent = "Restart this chat to start dev cycles from here.";
  } else if (running) {
    manageCycleNoteEl.textContent = cycleStateText(running);
  } else {
    const names = cycle.commands.map((c) => c.name);
    fillSelect(manageCycleEl, names, names.includes(manageCycleEl.value) ? manageCycleEl.value : names[0], (name) => `/${name}`);
    showCycleHint();
  }
}

// Shows the selected cycle command's argument hint under the label.
function showCycleHint() {
  const command = manageStatus.cycle.commands.find((c) => c.name === manageCycleEl.value);
  manageCycleNoteEl.textContent = command?.argumentHint ? `Arguments: ${command.argumentHint}` : "";
  manageCycleEl.title = command?.description ?? "";
}

// "/feature-cycle add-search · implement · 12 min in this phase", or "… · review · paused: <reason>".
function cycleStateText(state) {
  const args = state.args.length > 60 ? `${state.args.slice(0, 59)}…` : state.args;
  const parts = [`/${state.name}${args ? ` ${args}` : ""}`, state.phase];
  if (state.status === "paused") {
    parts.push(state.pauseReason ? `paused: ${state.pauseReason}` : "paused");
  } else if (state.next) {
    parts.push(`next: ${state.next}`);
  } else {
    parts.push(`${Math.max(1, Math.round((Date.now() - state.phaseStartedAt) / 60_000))} min in this phase`);
  }
  if (state.failedReviews > 0) parts.push(`failed reviews ${state.failedReviews}/${state.maxReviewRounds}`);
  return parts.join(" · ");
}

// Sends one op for the open Manage dialog. Resolves to the reply data, or null when
// the dialog already shows why it failed (or closed because the session went away).
async function sendManageOp(op, fields, pendingText) {
  const host = manageTarget;
  const seq = manageSeq;
  setManageEnabled(false);
  setManageMessage(pendingText);
  try {
    const res = await fetch("/api/v1/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: host.instanceId, generation: host.generation, op, ...fields }),
    });
    const data = await res.json().catch(() => ({}));
    if (seq !== manageSeq) return null;
    if (res.ok) {
      setManageMessage("");
      return data;
    }

    if (res.status === 503 && data.code === "no_extension") {
      manageStatus = null;
      manageStateEl.textContent = "Not available";
      setManageMessage("This session started before the dashboard extension was installed. Restart it to manage it here.", true);
    } else if ((res.status === 404 || res.status === 409) && data.code !== "busy" && data.code !== "not_found") {
      showToast("Session was rotated or ended. Refreshing…", true);
      manageDialogEl.close();
      loadHosts();
    } else {
      setManageMessage(data.error || `Request failed (HTTP ${res.status})`, true);
    }
    return null;
  } catch (err) {
    if (seq === manageSeq) setManageMessage(`Network error: ${errorText(err)}`, true);
    return null;
  } finally {
    if (seq === manageSeq) setManageEnabled(manageStatus !== null);
  }
}

async function openManageDialog(host) {
  manageSeq += 1;
  manageTarget = host;
  manageStatus = null;
  managePresets = [];
  manageTitleEl.textContent = `Manage ${host.folder}`;
  manageStateEl.textContent = "";
  manageSkillArgsEl.value = "";
  manageCompactFocusEl.value = "";
  manageCycleArgsEl.value = "";
  manageCycleFieldEl.classList.add("hidden");
  for (const select of [manageModelEl, manageThinkingEl, manageSkillEl, manageCycleEl]) select.replaceChildren();
  manageDialogEl.showModal();

  const data = await sendManageOp("status", {}, "Loading session status…");
  if (!data) return;
  managePresets = data.presets;
  fillSelect(manageThinkingEl, data.thinkingLevels, data.thinking, (level) => level);
  if (data.skills.length > 0) {
    manageSkillEl.replaceChildren(
      ...data.skills.map((skill) => {
        const option = new Option(skill.name, skill.name);
        if (skill.description) option.title = skill.description;
        return option;
      })
    );
  } else {
    manageSkillEl.replaceChildren(new Option("No skills available", ""));
  }
  showManageStatus(data);
}

manageModelApplyEl.addEventListener("click", async () => {
  const preset = manageModelEl.value;
  if (!preset) {
    setManageMessage("Choose a model first.", true);
    return;
  }
  const label = manageModelEl.selectedOptions[0].textContent;
  const data = await sendManageOp("set-model", { preset }, `Switching to ${label}…`);
  if (!data) return;
  showManageStatus(data);
  setManageMessage(`Switched to ${data.model} · ${data.thinking ?? "no thinking level"}.`);
});

manageThinkingApplyEl.addEventListener("click", async () => {
  const level = manageThinkingEl.value;
  const data = await sendManageOp("set-thinking", { level }, `Setting thinking to ${level}…`);
  if (!data) return;
  showManageStatus(data);
  setManageMessage(`Thinking set to ${data.thinking ?? level}.`);
});

manageSkillRunEl.addEventListener("click", async () => {
  const name = manageSkillEl.value;
  const args = manageSkillArgsEl.value.trim();
  const data = await sendManageOp("skill", args ? { name, args } : { name }, `Sending /skill:${name}…`);
  if (!data) return;
  manageSkillArgsEl.value = "";
  setManageMessage(`Sent /skill:${name} to the session.`);
});

manageCompactEl.addEventListener("click", async () => {
  if (!confirm(`Compact the context of "${manageTarget.folder}"? Older messages are replaced by a summary.`)) return;
  const instructions = manageCompactFocusEl.value.trim();
  const data = await sendManageOp("compact", instructions ? { instructions } : {}, "Starting compaction…");
  if (!data) return;
  manageCompactFocusEl.value = "";
  setManageMessage("Compaction started. The session shows the result.");
});

manageCycleEl.addEventListener("change", showCycleHint);

manageCycleRunEl.addEventListener("click", async () => {
  const command = manageStatus.cycle.commands.find((c) => c.name === manageCycleEl.value);
  if (!command) return;
  const args = manageCycleArgsEl.value.trim();
  const prompt = `Start /${command.name}${args ? ` ${args}` : ""} in "${manageTarget.folder}"? It runs ${command.phases.join(" → ")} on its own and switches the model for each phase.`;
  if (!confirm(prompt)) return;
  const fields = args ? { action: "start", command: command.name, args } : { action: "start", command: command.name };
  const data = await sendManageOp("cycle", fields, `Starting /${command.name}…`);
  if (!data) return;
  manageCycleArgsEl.value = "";
  showManageStatus(data);
  setManageMessage(data.message);
});

manageCycleResumeEl.addEventListener("click", async () => {
  const data = await sendManageOp("cycle", { action: "resume" }, "Resuming the cycle…");
  if (!data) return;
  showManageStatus(data);
  setManageMessage(data.message);
});

manageCycleStopEl.addEventListener("click", async () => {
  const name = manageStatus.cycle.state.name;
  if (!confirm(`Stop /${name}? No later phase starts. A turn already running goes on without the cycle; interrupt it in the chat to cut it short.`)) return;
  const data = await sendManageOp("cycle", { action: "stop" }, `Stopping /${name}…`);
  if (!data) return;
  showManageStatus(data);
  setManageMessage(data.message);
});

manageCloseEl.addEventListener("click", () => {
  manageDialogEl.close();
});

manageDialogEl.addEventListener("close", () => {
  manageSeq += 1;
  manageTarget = null;
});

refreshBtnEl.addEventListener("click", () => {
  loadHosts({ manual: true });
});

// One tap moves system → light → dark → system; theme.js applies and stores it.
const NEXT_THEME = { system: "light", light: "dark", dark: "system" };

// CSS shows the icon; this names the current preference and the one a tap picks.
function renderThemeButton() {
  const preference = themePreference();
  const label = `Theme: ${preference} (tap for ${NEXT_THEME[preference]})`;
  themeBtnEl.setAttribute("aria-label", label);
  themeBtnEl.title = label;
}

themeBtnEl.addEventListener("click", () => {
  setThemePreference(NEXT_THEME[themePreference()]);
  renderThemeButton();
});

searchInputEl.addEventListener("input", renderHosts);

// The keyboard's Search key has no form to submit; it only closes the keyboard.
searchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchInputEl.blur();
});

// One chip is lit at a time: a project chip shows only that project, All shows every project.
// Tapping the lit chip changes nothing. The choice is kept for the next visit.
projectChipsEl.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  const name = chip.dataset.project || null;
  if (name === selectedProject) return;
  selectedProject = name;
  if (name === null) localStorage.removeItem(PROJECT_KEY);
  else localStorage.setItem(PROJECT_KEY, name);
  renderHosts();
});

// Marks a tab selected and remembers it for the next visit; renderHosts fills the list.
function selectTab(tab) {
  activeTab = tab;
  localStorage.setItem(TAB_KEY, tab);
  for (const [name, button] of Object.entries(TAB_BUTTONS)) {
    button.setAttribute("aria-selected", String(name === tab));
    // Tab key focus lands on the selected tab only; the arrow keys move between tabs.
    button.tabIndex = name === tab ? 0 : -1;
  }
  sessionListEl.setAttribute("aria-labelledby", TAB_BUTTONS[tab].id);
}

for (const [tab, button] of Object.entries(TAB_BUTTONS)) {
  button.addEventListener("click", () => {
    selectTab(tab);
    renderHosts();
  });
}

tabBarEl.addEventListener("keydown", (event) => {
  const other = activeTab === "chats" ? "long-tasks" : "chats";
  const tab = { ArrowLeft: other, ArrowRight: other, Home: "chats", End: "long-tasks" }[event.key];
  if (!tab) return;
  event.preventDefault();
  selectTab(tab);
  TAB_BUTTONS[tab].focus();
  renderHosts();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadHosts();
    startPolling();
  } else {
    stopPolling();
  }
});

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!document.hidden) {
      loadHosts();
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Which modules the server runs and its main profile (GET /api/v1/info), once at load; the list
// re-renders with them. A failed request changes nothing: loadHosts shows the error.
async function loadInfo() {
  let info;
  try {
    const res = await fetch("/api/v1/info", { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    info = await res.json();
  } catch {
    return;
  }
  features = info.features;
  mainProfile = info.mainProfile;
  newSessionBtnEl.classList.toggle("hidden", !features.launch);
  renderHosts();
}

// Initial load
renderThemeButton();
selectTab(activeTab);
loadInfo();
loadHosts();
startPolling();
