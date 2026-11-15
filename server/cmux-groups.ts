// Keeps the cmux sidebar on this Mac in collapsible workspace groups, two per project
// (projects.ts): a pinned "<project> · long tasks" group for the workspaces whose chat is pinned
// in omp (`/pin`), and a "<project>" group for the others, so `751orion-web` and
// `753orion-web` share "orion". Every sync reads cmux and omp afresh, plans the changes
// (planSync, pure), and makes them one cmux call at a time (GroupSync); all a sync remembers is
// since when each long-task row has run no chat. The same rules carry the groups of earlier
// versions, one "Long tasks" group and one group per folder family, over to the project groups.
// The dashboard runs a sync every 15 s; on its own, `bun cmux-groups.ts` prints the plan for the
// live state and `--apply` runs one sync.
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPinnedIds } from "./agent-dirs";
import { loadConfigOrExit } from "./config";
import type { CliHost } from "./hosts";
import { parseCliList } from "./hosts";
import { familyProject, type ProjectMap, projectNames, projectOf } from "./projects";

/** Long-task groups have the external id `omp-sessions:long-tasks:<project>`. */
const LONG_TASKS_KEY_PREFIX = "omp-sessions:long-tasks:";
const LONG_TASKS_SUFFIX = " · long tasks";
const LONG_TASKS_ICON = "pin.fill";
/** Project groups have the external id `omp-sessions:project:<project>`. */
const PROJECT_KEY_PREFIX = "omp-sessions:project:";
/** The one Long tasks group of earlier versions: its members go to their project's long-task group, then it goes. */
const LEGACY_LONG_TASKS_KEY = "omp-sessions:long-tasks";
/**
 * Folder groups of earlier versions, `omp-sessions:folder:<family>`. While a window has no
 * group of its own for a project, the first of them for that project in the sidebar serves as
 * the project group; the others hand their members over to it and go.
 */
const LEGACY_FOLDER_KEY_PREFIX = "omp-sessions:folder:";
/** The external ids above: the dashboard's own groups, current and earlier. */
const OUR_KEY = /^omp-sessions:(long-tasks$|long-tasks:|project:|folder:)/;
/** Header color while a member needs input: the red omp's cmux hook gives such a workspace row. */
export const ATTENTION_COLOR = "#DC2626";
const ATTENTION_SUFFIX = / · \d+ needs input$/;
const PS_BIN = "/bin/ps";
/** A `CMUX_SURFACE_ID=<uuid>` or `CMUX_WORKSPACE_ID=<uuid>` word in `ps -E` output. */
const CMUX_ID_WORD = /^CMUX_(SURFACE|WORKSPACE)_ID=([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/;
// cmux sometimes resolves a new group's anchor ref a moment after `workspace-group create`
// returns ("Workspace ref not found"), so the calls right after it try a few times.
const NEW_REF_ATTEMPTS = 5;
const REF_RETRY_MS = 100;
// A workspace without a live chat that stays ungrouped (a shell outside the project root, or one still
// in `~`) has its folder asked again after this long, so a later `cd` into a project still counts.
const SIDEBAR_CWD_TTL_MS = 60_000;
/**
 * cmux's omp hook store: cmux's `cmux-omp-session.ts` hook records the omp session of each omp
 * event in a cmux terminal there, with its workspace.
 */
export const CMUX_OMP_HOOK_STORE = join(homedir(), ".cmuxterm", "omp-hook-sessions.json");

/** A workspace as `cmux tree --all --json --id-format both` lists it; the list is in sidebar order. */
export type Workspace = {
  /** UUID. Refs stay put while cmux runs; the UUID keys the sidebar cwd cache. */
  id: string;
  ref: string;
  title: string;
  /** Pinned by the user in cmux. */
  pinned: boolean;
  /** UUIDs of its terminal surfaces. */
  surfaces: string[];
};

/** A workspace group as `cmux workspace-group list --json` reports it. */
export type Group = {
  ref: string;
  name: string;
  externalId: string | null;
  /** The workspace whose sidebar row is the group's header. */
  anchor: string;
  /** Workspace refs, anchor first. */
  members: string[];
  color: string | null;
};

export type CmuxWindow = {
  ref: string;
  /** The workspace the window shows. */
  selected: string | null;
  workspaces: Workspace[];
  groups: Group[];
};

/** A live omp chat and the UUID of the cmux workspace it runs in (null: none, it runs outside cmux). */
export type Chat = { sessionId: string; cwd: string; inputRequired: boolean; workspace: string | null };

/** CMUX_SURFACE_ID and CMUX_WORKSPACE_ID from a process's environment: cmux starts every terminal with them. */
export type CmuxIds = { surface: string | null; workspace: string | null };

export type SyncState = {
  /** The project map (config.ts): folders below its root have a project, folders elsewhere are left alone. */
  projects: ProjectMap;
  windows: CmuxWindow[];
  chats: Chat[];
  pinnedIds: ReadonlySet<string>;
  /** `cmux sidebar-state` cwd by workspace UUID, for workspaces without a live chat (null: it names none). */
  sidebarCwds: ReadonlyMap<string, string | null>;
  /**
   * UUIDs of the workspaces in a long-task group that have run no live chat for the whole
   * grace (GroupSyncDeps.longTaskGraceMs): they leave the group.
   */
  graceOver: ReadonlySet<string>;
  /**
   * The session ID of the last omp session cmux's hook recorded in each workspace, by upper-case
   * workspace UUID (parseHookSessions); null while cmux's hook store cannot be read.
   */
  lastSessions: ReadonlyMap<string, string> | null;
};

/**
 * One change to one window's sidebar. Groups are named by their external id (`key`) because
 * a group created earlier in the same sync has no ref yet when the plan is made.
 */
export type Step =
  | {
      kind: "create";
      window: string;
      key: string;
      name: string;
      cwd: string;
      /**
       * Workspace whose sidebar place the new group takes; for a long-task group, the header of
       * the long-task group it goes above. Null leaves it where cmux puts it, which for a pinned
       * group is below the other pinned groups.
       */
      before: string | null;
      collapsed: boolean;
      pinned: boolean;
    }
  /** `from` names the group the workspace leaves, for the plan; null when it is in none. */
  | { kind: "move"; window: string; key: string; group: string; workspace: string; title: string; from: string | null }
  /** After the moves, check the group's members against this order and reorder where they differ. */
  | { kind: "order"; window: string; key: string; group: string; members: { ref: string; title: string }[] }
  /** Takes a workspace out of the group `key`, leaving it ungrouped. */
  | { kind: "leave"; window: string; key: string; group: string; workspace: string; title: string }
  | { kind: "rename"; window: string; key: string; from: string; name: string }
  | { kind: "color"; window: string; key: string; group: string; color: string | null }
  /** Removes a group that only its header is left in, header included. */
  | { kind: "remove"; window: string; key: string; group: string };

/** Plans one sync of every window in `state`. Applying the plan and planning again gives no steps. */
export function planSync(state: SyncState): Step[] {
  const chatsByWorkspace = new Map<string, Chat[]>();
  for (const chat of state.chats) {
    if (chat.workspace === null) continue;
    const list = chatsByWorkspace.get(chat.workspace);
    if (list) list.push(chat);
    else chatsByWorkspace.set(chat.workspace, [chat]);
  }
  return state.windows.flatMap((win) => planWindow(win, state, chatsByWorkspace));
}

type Arrival = { ws: Workspace; folder: string | null; from: Group | undefined };

function planWindow(win: CmuxWindow, state: SyncState, chatsByWorkspace: ReadonlyMap<string, Chat[]>): Step[] {
  const position = new Map(win.workspaces.map((ws, i) => [ws.ref, i]));
  const at = (ref: string): number => position.get(ref) ?? win.workspaces.length;
  const anchors = new Set(win.groups.map((group) => group.anchor));
  const groupOf = new Map<string, Group>();
  // The dashboard's own groups by external id, the first one when cmux somehow has two.
  const ours = new Map<string, Group>();
  for (const group of win.groups) {
    for (const ref of group.members) if (ref !== group.anchor) groupOf.set(ref, group);
    const key = group.externalId;
    if (key && OUR_KEY.test(key) && !ours.has(key)) ours.set(key, group);
  }

  // The key of each project's group: its own, else the first old folder group of that project
  // in sidebar order, which keeps its place, state and members (adopted, by key → family).
  // Every other old folder group empties into its project's group (drained, by key → project).
  const projectOrder = projectNames(state.projects);
  const projectKeys = new Map<string, string>();
  for (const project of projectOrder) {
    if (ours.has(PROJECT_KEY_PREFIX + project)) projectKeys.set(project, PROJECT_KEY_PREFIX + project);
  }
  const adopted = new Map<string, string>();
  const drained = new Map<string, string>();
  const legacyFolders = [...ours]
    .filter(([key]) => key.startsWith(LEGACY_FOLDER_KEY_PREFIX))
    .sort(([, a], [, b]) => at(a.anchor) - at(b.anchor));
  for (const [key] of legacyFolders) {
    const family = key.slice(LEGACY_FOLDER_KEY_PREFIX.length);
    const project = familyProject(family, state.projects);
    if (projectKeys.has(project)) {
      drained.set(key, project);
    } else {
      projectKeys.set(project, key);
      adopted.set(key, family);
    }
  }
  const projectKey = (project: string): string => projectKeys.get(project) ?? PROJECT_KEY_PREFIX + project;

  const byRef = new Map(win.workspaces.map((ws) => [ws.ref, ws]));
  const chatsIn = (ref: string): Chat[] => {
    const id = byRef.get(ref)?.id;
    return (id === undefined ? undefined : chatsByWorkspace.get(id)) ?? [];
  };
  // The live chat's folder, else the sidebar's; undefined while the sidebar's is not known.
  const folderOf = (ws: Workspace): string | null | undefined => chatsIn(ws.ref)[0]?.cwd ?? state.sidebarCwds.get(ws.id);

  // Where each workspace goes, by target group key in the sidebar order of its first arrival.
  const arrivals = new Map<string, Arrival[]>();
  // Workspaces that leave a long-task group or the old Long tasks group for no group, as they
  // have no project.
  const leaving: { ws: Workspace; key: string }[] = [];
  // Every workspace that leaves its group in this sync.
  const departing = new Set<string>();
  for (const ws of win.workspaces) {
    if (anchors.has(ws.ref) || ws.pinned) continue;
    const from = groupOf.get(ws.ref);
    const fromKey = from?.externalId ?? null;
    const drainedTo = fromKey === null ? undefined : drained.get(fromKey);
    const chats = chatsIn(ws.ref);
    const pinned = chats.some((chat) => state.pinnedIds.has(chat.sessionId));
    const folder = folderOf(ws);
    const project = folder ? projectOf(folder, state.projects) : null;
    let key: string | null = null;
    if (project !== null && pinned) {
      key = LONG_TASKS_KEY_PREFIX + project;
    } else if (fromKey?.startsWith(LONG_TASKS_KEY_PREFIX)) {
      // A long-task group holds the workspaces running a pinned chat and the rows of closed long
      // tasks. An unpinned chat takes its workspace out at once. A workspace without a live chat
      // stays while the last omp session cmux recorded in it is pinned (a closed long task), and
      // while that record cannot be read. Otherwise it leaves once the grace is over, as a
      // restarted chat (`/omp-update`, a cmux restart) comes back within it, and not before its
      // folder is known: to its project group, or to no group without a project. A pinned chat
      // outside the projects keeps its row.
      if (pinned) continue;
      if (chats.length === 0) {
        if (state.lastSessions === null || !state.graceOver.has(ws.id) || folder === undefined) continue;
        const last = state.lastSessions.get(ws.id.toUpperCase());
        if (last !== undefined && state.pinnedIds.has(last)) continue;
      }
      if (project === null) {
        leaving.push({ ws, key: fromKey });
        departing.add(ws.ref);
        continue;
      }
      key = projectKey(project);
    } else if (fromKey === LEGACY_LONG_TASKS_KEY) {
      // Wait for the folder of a closed long task's shell before moving it.
      if (folder === undefined) continue;
      if (project === null) {
        leaving.push({ ws, key: fromKey });
        departing.add(ws.ref);
        continue;
      }
      key = chats.length > 0 ? projectKey(project) : LONG_TASKS_KEY_PREFIX + project;
    } else if (drainedTo !== undefined) {
      key = projectKey(drainedTo);
    } else if (!from && ws.ref !== win.selected && project !== null) {
      key = projectKey(project);
    }
    if (key === null || fromKey === key) continue;
    const arrival = { ws, folder: folder ?? null, from };
    const list = arrivals.get(key);
    if (list) list.push(arrival);
    else arrivals.set(key, [arrival]);
    departing.add(ws.ref);
  }

  // Header names without the attention count. An adopted group still named after its family
  // takes its project's name; a name the user gave it stays.
  const bases = new Map<string, string>();
  for (const [key, group] of ours) {
    const base = group.name.replace(ATTENTION_SUFFIX, "");
    const family = adopted.get(key);
    bases.set(key, family !== undefined && base === family ? familyProject(family, state.projects) : base);
  }
  // The old Long tasks group, the drained folder groups and the long-task groups go once only
  // their header is left. A project group stays, with the name and state the user gave it.
  const removed = new Set(
    [...ours.keys()].filter((key) => {
      const group = ours.get(key);
      const goes = key === LEGACY_LONG_TASKS_KEY || drained.has(key) || key.startsWith(LONG_TASKS_KEY_PREFIX);
      return goes && group !== undefined && !arrivals.has(key) && group.members.every((ref) => ref === group.anchor || departing.has(ref));
    }),
  );
  const longTasksRank = (key: string): number =>
    key.startsWith(LONG_TASKS_KEY_PREFIX) ? projectOrder.indexOf(key.slice(LONG_TASKS_KEY_PREFIX.length)) : -1;
  // A new long-task group goes above the topmost long-task group of a later project. Without
  // one it stays below the other pinned groups, where pinning puts it; long-task groups are
  // created in project order, so they keep that order among themselves.
  const longTasksAbove = (rank: number): string | null =>
    [...ours]
      .filter(([key]) => longTasksRank(key) > rank && !removed.has(key))
      .map(([, group]) => group.anchor)
      .sort((a, b) => at(a) - at(b))[0] ?? null;

  const steps: Step[] = [];
  const selected = win.workspaces.find((ws) => ws.ref === win.selected);
  const selectedFolder = selected ? folderOf(selected) : null;
  const selectedProject = selectedFolder ? projectOf(selectedFolder, state.projects) : null;
  const created: string[] = [];
  // Long-task groups first, in project order; the other groups in the order of their first arrival.
  const targets = [...arrivals].sort(([a], [b]) => {
    const [ra, rb] = [longTasksRank(a), longTasksRank(b)];
    return (ra < 0 ? projectOrder.length : ra) - (rb < 0 ? projectOrder.length : rb);
  });
  for (const [key, list] of targets) {
    const existing = ours.get(key);
    let group = bases.get(key) ?? "";
    if (!existing) {
      const pinned = longTasksRank(key) >= 0;
      const project = key.slice((pinned ? LONG_TASKS_KEY_PREFIX : PROJECT_KEY_PREFIX).length);
      group = pinned ? project + LONG_TASKS_SUFFIX : project;
      bases.set(key, group);
      created.push(key);
      steps.push({
        kind: "create",
        window: win.ref,
        key,
        name: group,
        cwd: list[0].folder ?? state.projects.root,
        // A pinned group sorts to the top wherever it is placed, so only its place among the
        // pinned groups counts.
        before: pinned ? longTasksAbove(longTasksRank(key)) : (list.find((arrival) => !arrival.from)?.ws.ref ?? null),
        collapsed: !pinned && project !== selectedProject,
        pinned,
      });
    }
    for (const { ws, from } of list) {
      steps.push({ kind: "move", window: win.ref, key, group, workspace: ws.ref, title: ws.title, from: from?.name ?? null });
    }
    const members = [
      ...(existing?.members.filter((ref) => ref !== existing.anchor && !departing.has(ref)) ?? []),
      ...list.map((arrival) => arrival.ws.ref),
    ].sort((a, b) => at(a) - at(b));
    if (members.length > 1) {
      steps.push({
        kind: "order",
        window: win.ref,
        key,
        group,
        members: members.map((ref) => ({ ref, title: byRef.get(ref)?.title ?? "" })),
      });
    }
  }
  for (const { ws, key } of leaving) {
    steps.push({ kind: "leave", window: win.ref, key, group: bases.get(key) ?? "", workspace: ws.ref, title: ws.title });
  }

  // Header names and attention, on the membership the moves above leave behind.
  for (const key of [...ours.keys(), ...created]) {
    if (removed.has(key)) continue;
    const existing = ours.get(key);
    const members = [
      ...(existing?.members.filter((ref) => !departing.has(ref)) ?? []),
      ...(arrivals.get(key)?.map((arrival) => arrival.ws.ref) ?? []),
    ];
    const waiting = members.filter((ref) => chatsIn(ref).some((chat) => chat.inputRequired)).length;
    const base = bases.get(key) ?? key;
    const current = existing?.name ?? base;
    const name = waiting > 0 ? `${base} · ${waiting} needs input` : base;
    if (name !== current) steps.push({ kind: "rename", window: win.ref, key, from: current, name });
    const color = existing?.color ?? null;
    const red = color?.toUpperCase() === ATTENTION_COLOR;
    // Red goes only on a group without a color, and only the dashboard's own red is cleared,
    // so a color the user picked stays; the header's count still shows the wait.
    if (waiting > 0 && color === null) steps.push({ kind: "color", window: win.ref, key, group: name, color: ATTENTION_COLOR });
    if (waiting === 0 && red) steps.push({ kind: "color", window: win.ref, key, group: name, color: null });
  }
  for (const key of removed) {
    steps.push({ kind: "remove", window: win.ref, key, group: bases.get(key) ?? key });
  }
  return steps;
}

/** One line per step, for the plan the command line prints. */
export function describeStep(step: Step): string {
  switch (step.kind) {
    case "create": {
      const place = step.before ? ` ${step.pinned ? "above the group of" : "in place of"} ${step.before}` : "";
      const state = step.pinned ? "pinned" : step.collapsed ? "collapsed" : "expanded";
      return `create group "${step.name}"${place}, ${state}`;
    }
    case "move":
      return `move ${step.workspace} "${step.title}" ${step.from === null ? "" : `from "${step.from}" `}to "${step.group}"`;
    case "order":
      return `keep "${step.group}" in sidebar order: ${step.members.map((m) => m.ref).join(", ")}`;
    case "leave":
      return `take ${step.workspace} "${step.title}" out of "${step.group}"`;
    case "rename":
      return `rename "${step.from}" to "${step.name}"`;
    case "color":
      return step.color ? `color "${step.group}" ${step.color}` : `clear the color of "${step.group}"`;
    case "remove":
      return `remove the empty group "${step.group}"`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Windows and their workspaces from `cmux tree --all --json --id-format both`, groups still empty; null for another format. */
export function parseTree(stdout: string): CmuxWindow[] | null {
  const data = asRecord(parseJson(stdout));
  if (!data || !Array.isArray(data.windows)) return null;
  const windows: CmuxWindow[] = [];
  for (const value of data.windows) {
    const win = asRecord(value);
    if (!win || typeof win.ref !== "string" || !Array.isArray(win.workspaces)) return null;
    const workspaces: Workspace[] = [];
    for (const item of win.workspaces) {
      const ws = asRecord(item);
      if (!ws || typeof ws.id !== "string" || typeof ws.ref !== "string") return null;
      const panes = Array.isArray(ws.panes) ? ws.panes : [];
      const surfaces = panes.flatMap((pane) => {
        const list = asRecord(pane)?.surfaces;
        return (Array.isArray(list) ? list : []).flatMap((value) => {
          const surface = asRecord(value);
          return surface?.type === "terminal" && typeof surface.id === "string" ? [surface.id] : [];
        });
      });
      workspaces.push({
        id: ws.id,
        ref: ws.ref,
        title: typeof ws.title === "string" ? ws.title : "",
        pinned: ws.pinned === true,
        surfaces,
      });
    }
    const selected = typeof win.selected_workspace_ref === "string" ? win.selected_workspace_ref : null;
    windows.push({ ref: win.ref, selected, workspaces, groups: [] });
  }
  return windows;
}

function parseGroup(value: unknown): Group | null {
  const group = asRecord(value);
  if (!group) return null;
  const { ref, name, external_id, anchor_workspace_ref, member_workspace_refs, custom_color } = group;
  if (
    typeof ref !== "string" ||
    typeof name !== "string" ||
    typeof anchor_workspace_ref !== "string" ||
    !Array.isArray(member_workspace_refs) ||
    !member_workspace_refs.every((member): member is string => typeof member === "string")
  ) {
    return null;
  }
  return {
    ref,
    name,
    externalId: typeof external_id === "string" ? external_id : null,
    anchor: anchor_workspace_ref,
    members: member_workspace_refs,
    color: typeof custom_color === "string" ? custom_color : null,
  };
}

/** Groups from `cmux workspace-group list --json`; null for another format. */
export function parseGroupList(stdout: string): Group[] | null {
  const data = asRecord(parseJson(stdout));
  if (!data || !Array.isArray(data.groups)) return null;
  const groups: Group[] = [];
  for (const value of data.groups) {
    const group = parseGroup(value);
    if (!group) return null;
    groups.push(group);
  }
  return groups;
}

/**
 * The cmux ids in each process's environment, by pid, from `ps -E -ww -o pid=,command= -p <pids>`.
 * macOS prints a process's arguments and then its environment, so a record starts at a line that
 * begins with one of `pids` and runs on over the lines below it, as a value can hold a newline.
 * The last word of each name counts, so an argument that looks like one does not. A pid ps did
 * not list is left out.
 */
export function parsePsEnv(stdout: string, pids: readonly number[]): Map<number, CmuxIds> {
  const wanted = new Set(pids);
  const byPid = new Map<number, CmuxIds>();
  let ids: CmuxIds | null = null;
  for (const line of stdout.split("\n")) {
    const pid = line.match(/^\s*(\d+)(?:\s|$)/)?.[1];
    if (pid !== undefined && wanted.has(Number(pid))) {
      ids = { surface: null, workspace: null };
      byPid.set(Number(pid), ids);
    }
    if (!ids) continue;
    for (const word of line.split(/\s+/)) {
      const match = word.match(CMUX_ID_WORD);
      if (match?.[1] === "SURFACE") ids.surface = match[2];
      else if (match) ids.workspace = match[2];
    }
  }
  return byPid;
}

/**
 * The UUID of the workspace each process runs in, by pid: the workspace that holds its surface
 * in any window, else the one its CMUX_WORKSPACE_ID names, else none (it runs outside cmux).
 * cmux sets both ids when it starts the terminal and keeps them across its restarts; the surface
 * counts first because it can move to another workspace later.
 */
export function workspacesByPid(windows: readonly CmuxWindow[], idsByPid: ReadonlyMap<number, CmuxIds>): Map<number, string> {
  const surfaceOwner = new Map<string, string>();
  const workspaceIds = new Set<string>();
  for (const win of windows) {
    for (const ws of win.workspaces) {
      workspaceIds.add(ws.id);
      for (const surface of ws.surfaces) surfaceOwner.set(surface, ws.id);
    }
  }
  const byPid = new Map<number, string>();
  for (const [pid, { surface, workspace }] of idsByPid) {
    const id =
      (surface === null ? undefined : surfaceOwner.get(surface)) ??
      (workspace !== null && workspaceIds.has(workspace) ? workspace : undefined);
    if (id !== undefined) byPid.set(pid, id);
  }
  return byPid;
}

/** The `cwd=` line of `cmux sidebar-state`, or null when it names no folder. */
export function parseSidebarCwd(stdout: string): string | null {
  return stdout.match(/^cwd=(\/.*)$/m)?.[1] ?? null;
}

/**
 * The session ID of the last omp session cmux's hook recorded in each workspace, by upper-case
 * workspace UUID, from cmux's omp hook store (CMUX_OMP_HOOK_STORE, `version: 1`). Each record in
 * its `sessions` has a `sessionId`, a `workspaceId` and an `updatedAt` (epoch seconds); several
 * can share a workspace, and the latest counts. Records without those fields are skipped; null
 * for another format.
 */
export function parseHookSessions(text: string): Map<string, string> | null {
  const data = asRecord(parseJson(text));
  const sessions = asRecord(data?.sessions);
  if (data?.version !== 1 || !sessions) return null;
  const last = new Map<string, string>();
  const lastAt = new Map<string, number>();
  for (const value of Object.values(sessions)) {
    const record = asRecord(value);
    const sessionId = record?.sessionId;
    const workspaceId = record?.workspaceId;
    const updatedAt = record?.updatedAt;
    if (typeof sessionId !== "string" || typeof workspaceId !== "string" || typeof updatedAt !== "number") continue;
    const workspace = workspaceId.toUpperCase();
    if (updatedAt <= (lastAt.get(workspace) ?? -Infinity)) continue;
    last.set(workspace, sessionId);
    lastAt.set(workspace, updatedAt);
  }
  return last;
}

export type ProcessResult = { stdout: string; stderr: string; code: number };

export type GroupSyncDeps = {
  cmuxBin: string;
  /** The project map (config.ts). */
  projects: ProjectMap;
  /** Reads and changes only this window (`window:N`); null means every window. */
  window: string | null;
  /** Runs a command with CMUX_QUIET=1 in its environment. */
  exec: (args: string[]) => Promise<ProcessResult>;
  liveHosts: () => Promise<CliHost[]>;
  pinnedIds: () => Promise<ReadonlySet<string>>;
  /**
   * cmux's omp hook store (CMUX_OMP_HOOK_STORE): the last omp session in each workspace, which
   * keeps a closed long task's row in its group.
   */
  hookSessionsPath: string;
  /**
   * How long a workspace in a long-task group may run no chat before it leaves the group, so a
   * chat that restarts (`/omp-update`, a cmux restart) keeps its row; 0 moves it at once.
   */
  longTaskGraceMs: number;
  /** The clock, in ms since the epoch. */
  now: () => number;
  log: (line: string) => void;
};

/** Reads the live state, plans, and makes the changes one cmux call at a time. */
export class GroupSync {
  readonly #deps: GroupSyncDeps;
  // `cmux sidebar-state` cwd by workspace UUID, only for workspaces without a live chat that
  // are ungrouped, in a long-task group or in the old Long tasks group (the only ones the
  // planner places by it); null = none. Asked at most once a TTL.
  readonly #sidebarCwds = new Map<string, string | null>();
  readonly #sidebarAskedAt = new Map<string, number>();
  // Since when each workspace (UUID) in a long-task group has run no live chat.
  readonly #chatlessSince = new Map<string, number>();
  #cmuxDown = false;
  // Whether the last read of cmux's hook store failed, so a streak of failures is logged once.
  #hookStoreDown = false;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(deps: GroupSyncDeps) {
    this.#deps = deps;
  }

  /** The plan for the live state without changing anything; null when cmux is not reachable. */
  async plan(): Promise<Step[] | null> {
    const state = await this.#readState();
    return state && planSync(state);
  }

  /**
   * One sync. Never throws: a failed cmux call is logged and skipped, and the next sync
   * tries again. A call while a sync runs makes one more sync follow it.
   */
  sync(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          try {
            const state = await this.#readState();
            if (state) await this.#apply(state, planSync(state));
          } catch (err) {
            this.#deps.log(`groups: sync failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  /**
   * Runs one cmux command; its output, or null after logging the failure. With `attempts`
   * above 1, a "ref not found" failure is tried again REF_RETRY_MS later.
   */
  async #cmux(args: string[], attempts = 1): Promise<string | null> {
    const shown = args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
    for (let attempt = 1; ; attempt++) {
      let detail: string;
      try {
        const { stdout, stderr, code } = await this.#deps.exec([this.#deps.cmuxBin, ...args]);
        if (code === 0) return stdout;
        detail = (stderr || stdout || `exit code ${code}`).trim().slice(0, 300);
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
      if (attempt >= attempts || !/ref not found/i.test(detail)) {
        this.#deps.log(`groups: cmux ${shown} failed: ${detail}`);
        return null;
      }
      await Bun.sleep(REF_RETRY_MS);
    }
  }

  async #listGroups(window: string): Promise<Group[] | null> {
    const out = await this.#cmux(["workspace-group", "list", "--json", "--window", window]);
    const groups = out === null ? null : parseGroupList(out);
    if (out !== null && !groups) this.#deps.log(`groups: cmux workspace-group list returned an unexpected format`);
    return groups;
  }

  /** The last omp session cmux recorded in each workspace; null, logged once a streak, when its store cannot be read. */
  async #readLastSessions(): Promise<Map<string, string> | null> {
    const { hookSessionsPath, log } = this.#deps;
    let problem: string;
    try {
      const sessions = parseHookSessions(await Bun.file(hookSessionsPath).text());
      if (sessions) {
        this.#hookStoreDown = false;
        return sessions;
      }
      problem = "unexpected format";
    } catch (err) {
      problem = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    }
    if (!this.#hookStoreDown) {
      log(`groups: cannot read cmux's omp session store ${hookSessionsPath} (${problem}); long-task rows without a chat stay until it can be read`);
    }
    this.#hookStoreDown = true;
    return null;
  }

  async #readState(): Promise<SyncState | null> {
    const { cmuxBin, projects, window, exec, log } = this.#deps;
    const tree = await exec([cmuxBin, "tree", "--all", "--json", "--id-format", "both"]).catch(
      (err: unknown): ProcessResult => ({ stdout: "", stderr: err instanceof Error ? err.message : String(err), code: -1 }),
    );
    if (tree.code !== 0) {
      if (!this.#cmuxDown) {
        log(`groups: cmux is not reachable, skipping until it is: ${(tree.stderr || tree.stdout).trim().slice(0, 300)}`);
      }
      this.#cmuxDown = true;
      return null;
    }
    this.#cmuxDown = false;
    const parsed = parseTree(tree.stdout);
    if (!parsed) throw new Error("cmux tree --all --json --id-format both returned an unexpected format");
    const listed = window === null ? parsed : parsed.filter((win) => win.ref === window);
    if (listed.length === 0 && window !== null) throw new Error(`cmux has no window ${window}`);
    const windows: CmuxWindow[] = [];
    for (const win of listed) {
      // A window whose groups cannot be read is left alone this time.
      const groups = await this.#listGroups(win.ref);
      if (groups) windows.push({ ...win, groups });
    }

    const [hosts, pinnedIds, lastSessions] = await Promise.all([this.#deps.liveHosts(), this.#deps.pinnedIds(), this.#readLastSessions()]);
    const pids = hosts.map((host) => host.pid).filter((pid) => Number.isInteger(pid) && pid > 0);
    // ps lists only the pids that still exist and exits 1 when none does, so only its output counts.
    const ids =
      pids.length > 0
        ? parsePsEnv((await exec([PS_BIN, "-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")])).stdout, pids)
        : new Map<number, CmuxIds>();
    // Every window of the tree counts, so a chat whose surface moved to a window this sync does
    // not read is not placed in the workspace it started in.
    const places = workspacesByPid(parsed, ids);
    const chats = hosts.map(
      (host): Chat => ({
        sessionId: host.sessionId,
        cwd: host.cwd,
        inputRequired: host.inputRequired,
        workspace: places.get(host.pid) ?? null,
      }),
    );

    const running = new Set(chats.map((chat) => chat.workspace));
    const graceOver = new Set<string>();
    const present = new Set<string>();
    const now = this.#deps.now();
    for (const win of windows) {
      // Member lists start with the anchor, so this covers group headers too. The members of the
      // long-task groups and of the old Long tasks group move by their folder, so they are asked
      // as well.
      const grouped = new Set(
        win.groups.flatMap((group) => {
          const key = group.externalId;
          return key === LEGACY_LONG_TASKS_KEY || key?.startsWith(LONG_TASKS_KEY_PREFIX) ? [group.anchor] : group.members;
        }),
      );
      const longTasks = new Set(
        win.groups.flatMap((group) =>
          group.externalId?.startsWith(LONG_TASKS_KEY_PREFIX) ? group.members.filter((ref) => ref !== group.anchor) : [],
        ),
      );
      for (const ws of win.workspaces) {
        present.add(ws.id);
        if (longTasks.has(ws.ref) && !running.has(ws.id)) {
          const since = this.#chatlessSince.get(ws.id) ?? now;
          this.#chatlessSince.set(ws.id, since);
          if (now - since >= this.#deps.longTaskGraceMs) graceOver.add(ws.id);
        } else {
          this.#chatlessSince.delete(ws.id);
        }
        if (grouped.has(ws.ref) || running.has(ws.id)) continue;
        if (now - (this.#sidebarAskedAt.get(ws.id) ?? -Infinity) < SIDEBAR_CWD_TTL_MS) continue;
        const out = await this.#cmux(["sidebar-state", "--workspace", ws.ref, "--window", win.ref]);
        if (out === null) continue;
        this.#sidebarCwds.set(ws.id, parseSidebarCwd(out));
        this.#sidebarAskedAt.set(ws.id, now);
      }
    }
    if (window === null) {
      for (const id of this.#sidebarCwds.keys()) {
        if (present.has(id)) continue;
        this.#sidebarCwds.delete(id);
        this.#sidebarAskedAt.delete(id);
      }
      for (const id of this.#chatlessSince.keys()) {
        if (!present.has(id)) this.#chatlessSince.delete(id);
      }
    }
    return { projects, windows, chats, pinnedIds, sidebarCwds: this.#sidebarCwds, graceOver, lastSessions };
  }

  async #apply(state: SyncState, steps: Step[]): Promise<void> {
    const { log } = this.#deps;
    // Group ref by `<window> <external id>`, including groups created during this sync.
    const refs = new Map<string, string>();
    for (const win of state.windows) {
      for (const group of win.groups) {
        const id = `${win.ref} ${group.externalId}`;
        if (group.externalId && !refs.has(id)) refs.set(id, group.ref);
      }
    }
    for (const step of steps) {
      const id = `${step.window} ${step.key}`;
      if (step.kind === "create") {
        const group = await this.#create(step);
        if (group) refs.set(id, group);
        continue;
      }
      const group = refs.get(id);
      // Its create failed and was logged.
      if (!group) continue;
      switch (step.kind) {
        case "move":
          if ((await this.#cmux(["workspace-group", "add", "--group", group, "--workspace", step.workspace, "--window", step.window])) !== null) {
            log(`groups: moved ${step.workspace} "${step.title}" to "${step.group}"`);
          }
          break;
        case "order":
          await this.#order(step, group);
          break;
        case "leave":
          if ((await this.#cmux(["workspace-group", "remove", "--workspace", step.workspace, "--window", step.window])) !== null) {
            log(`groups: took ${step.workspace} "${step.title}" out of "${step.group}"`);
          }
          break;
        case "rename":
          if ((await this.#cmux(["workspace-group", "rename", group, "--name", step.name, "--window", step.window])) !== null) {
            log(`groups: renamed "${step.from}" to "${step.name}"`);
          }
          break;
        case "color": {
          const hex = step.color ? ["--hex", step.color] : [];
          if ((await this.#cmux(["workspace-group", "set-color", group, ...hex, "--window", step.window])) !== null) {
            log(step.color ? `groups: colored "${step.group}" ${step.color}` : `groups: cleared the color of "${step.group}"`);
          }
          break;
        }
        case "remove": {
          // cmux itself drops a group that is not pinned once its last workspace leaves it, and
          // refuses to remove one that holds more than its header, for example after a failed move.
          const listed = await this.#listGroups(step.window);
          if (listed && !listed.some((g) => g.ref === group)) {
            log(`groups: cmux removed the empty group "${step.group}"`);
          } else if ((await this.#cmux(["workspace-group", "ungroup", group, "--remove-generated-anchor", "--window", step.window])) !== null) {
            log(`groups: removed the empty group "${step.group}"`);
          }
          break;
        }
      }
    }
  }

  /**
   * Creates an anchor-only group (never `--from`: the first workspace would become the header
   * and lose its own row), pins it, moves it into place, then collapses it. Returns its ref.
   */
  async #create(step: Extract<Step, { kind: "create" }>): Promise<string | null> {
    const { window } = step;
    const out = await this.#cmux([
      "workspace-group", "create",
      "--name", step.name,
      "--external-id", step.key,
      "--cwd", step.cwd,
      "--window", window,
      "--json",
    ]);
    if (out === null) return null;
    const group = parseGroup(asRecord(parseJson(out))?.group);
    if (!group) {
      this.#deps.log(`groups: cmux workspace-group create returned an unexpected format`);
      return null;
    }
    // Pinning puts the group below the other pinned groups, so it comes before the reorder.
    if (step.pinned) {
      await this.#cmux(["workspace-group", "pin", group.ref, "--window", window], NEW_REF_ATTEMPTS);
      await this.#cmux(["workspace-group", "set-icon", group.ref, "--symbol", LONG_TASKS_ICON, "--window", window], NEW_REF_ATTEMPTS);
    }
    if (step.before) {
      await this.#cmux(["reorder-workspace", "--workspace", group.anchor, "--before", step.before, "--window", window], NEW_REF_ATTEMPTS);
    }
    if (!step.pinned && step.collapsed) {
      await this.#cmux(["workspace-group", "collapse", group.ref, "--window", window], NEW_REF_ATTEMPTS);
    }
    const state = step.pinned ? "pinned" : step.collapsed ? "collapsed" : "expanded";
    this.#deps.log(`groups: created "${step.name}" in ${window}, ${state}`);
    return group.ref;
  }

  /**
   * `workspace-group add` puts a workspace that sat above the group at its top and one from
   * below at its end, so arrivals from both sides can end up out of their old order.
   */
  async #order(step: Extract<Step, { kind: "order" }>, ref: string): Promise<void> {
    const group = (await this.#listGroups(step.window))?.find((g) => g.ref === ref);
    if (!group) return;
    const current = group.members.filter((member) => member !== group.anchor);
    let after = group.anchor;
    for (const { ref: member, title } of step.members) {
      const at = current.indexOf(member);
      // Its move failed and was logged.
      if (at < 0) continue;
      const wanted = current.indexOf(after) + 1;
      if (at !== wanted) {
        const moved = await this.#cmux(["reorder-workspace", "--workspace", member, "--after", after, "--window", step.window]);
        if (moved !== null) {
          current.splice(at, 1);
          current.splice(current.indexOf(after) + 1, 0, member);
          this.#deps.log(`groups: reordered ${member} "${title}" in "${step.group}"`);
        }
      }
      after = member;
    }
  }
}

if (import.meta.main) {
  const USAGE = "usage: bun cmux-groups.ts [--apply] [--window <window:N>] [--root <dir>]";
  const args = process.argv.slice(2);
  let apply = false;
  let window: string | null = null;
  let root: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--apply") {
      apply = true;
    } else if ((arg === "--window" || arg === "--root") && value && !value.startsWith("--")) {
      if (arg === "--window") window = value;
      else root = value;
      i++;
    } else {
      console.error(USAGE);
      process.exit(64);
    }
  }

  const exec = async (cmd: string[]): Promise<ProcessResult> => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, CMUX_QUIET: "1" } });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  // The dashboard's config file (config.ts), defaults without one; --root replaces its projects.root.
  const config = loadConfigOrExit({ requireServer: false });
  const ompBin = config.omp.bin;
  const configRoot = config.omp.configRoot;
  const sync = new GroupSync({
    cmuxBin: config.launch.cmuxBin,
    projects: root === null ? config.projects : { ...config.projects, root },
    window,
    exec,
    liveHosts: async () => {
      const { stdout, stderr, code } = await exec([ompBin, "collab", "list", "--json"]);
      const list = code === 0 ? parseCliList(stdout) : null;
      if (!list) throw new Error(`omp collab list failed: ${(stderr || stdout || `exit code ${code}`).trim().slice(0, 300)}`);
      return list.hosts;
    },
    pinnedIds: () => loadPinnedIds(configRoot),
    hookSessionsPath: CMUX_OMP_HOOK_STORE,
    // One sync on its own: no grace for a long-task row without a chat.
    longTaskGraceMs: 0,
    now: Date.now,
    log: console.log,
  });

  if (apply) {
    await sync.sync();
  } else {
    const steps = await sync.plan().catch((err: unknown) => {
      console.error(`groups: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
    if (steps === null) process.exit(1);
    if (steps.length === 0) console.log("Nothing to do.");
    let shown: string | null = null;
    for (const step of steps) {
      if (step.window !== shown) console.log(`${(shown = step.window)}:`);
      console.log(`  ${describeStep(step)}`);
    }
  }
}
