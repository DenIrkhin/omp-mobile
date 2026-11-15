import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Chat,
  type CmuxIds,
  type CmuxWindow,
  type Group,
  GroupSync,
  parseGroupList,
  parseHookSessions,
  parsePsEnv,
  parseSidebarCwd,
  parseTree,
  planSync,
  type ProcessResult,
  type Step,
  type SyncState,
  type Workspace,
  workspacesByPid,
} from "./cmux-groups";
import type { CliHost } from "./hosts";
import type { ProjectMap } from "./projects";

const ROOT = "/Users/you/dev";
const MAP: ProjectMap = {
  root: ROOT,
  otherName: "dev",
  list: [
    { name: "orion", families: ["orion-web"] },
    { name: "vega", families: ["vega"] },
    { name: "lyra", families: ["lyra"] },
    { name: "nova", families: ["nova"] },
    { name: "atlas", families: ["atlas"] },
  ],
};
const ORION = "omp-sessions:project:orion";
const VEGA = "omp-sessions:project:vega";
const LYRA = "omp-sessions:project:lyra";
const NOVA = "omp-sessions:project:nova";
const LT_ORION = "omp-sessions:long-tasks:orion";
const LT_VEGA = "omp-sessions:long-tasks:vega";
const LT_NOVA = "omp-sessions:long-tasks:nova";
const LT_DEV = "omp-sessions:long-tasks:dev";
// The groups of earlier versions.
const OLD_LONG = "omp-sessions:long-tasks";
const OLD_ORION = "omp-sessions:folder:orion-web";
const OLD_DEV = "omp-sessions:folder:dev";
const OLD_VEGA = "omp-sessions:folder:vega";
const OLD_VEGA_WT = "omp-sessions:folder:vega-wt";
const OLD_LYRA = "omp-sessions:folder:lyra";
const OLD_NOVA = "omp-sessions:folder:nova";
const W1 = "window:1";

/** UUID of workspace `n`'s terminal surface. */
function surfaceId(n: number): string {
  return `5F000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Workspace `workspace:<n>` (UUID `UUID-<n>`) with one terminal, surface `surfaceId(n)`. */
function ws(n: number, title: string, extra: Partial<Workspace> = {}): Workspace {
  return { id: `UUID-${n}`, ref: `workspace:${n}`, title, pinned: false, surfaces: [surfaceId(n)], ...extra };
}

/** A live chat in workspace `n`, in `folder` under ROOT ("" = ROOT itself). */
function chat(n: number, folder: string, extra: Partial<Chat> = {}): Chat {
  return { sessionId: `session-${n}`, cwd: folder ? `${ROOT}/${folder}` : ROOT, inputRequired: false, workspace: `UUID-${n}`, ...extra };
}

/** Group whose first listed workspace is its anchor. */
function group(n: number, name: string, externalId: string | null, members: number[], color: string | null = null): Group {
  const refs = members.map((m) => `workspace:${m}`);
  return { ref: `workspace_group:${n}`, name, externalId, anchor: refs[0], members: refs, color };
}

function win(ref: string, selected: number | null, workspaces: Workspace[], groups: Group[] = []): CmuxWindow {
  return { ref, selected: selected === null ? null : `workspace:${selected}`, workspaces, groups };
}

function state(windows: CmuxWindow[], chats: Chat[], extra: Partial<SyncState> = {}): SyncState {
  return { projects: MAP, windows, chats, pinnedIds: new Set(), sidebarCwds: new Map(), graceOver: new Set(), lastSessions: new Map(), ...extra };
}

/** What cmux looks like after the steps, as far as planning can tell. */
function applySteps(before: SyncState, steps: Step[]): SyncState {
  const windows = before.windows.map((w) => ({
    ...w,
    workspaces: [...w.workspaces],
    groups: w.groups.map((g) => ({ ...g, members: [...g.members] })),
  }));
  let next = 900;
  for (const step of steps) {
    const target = windows.find((w) => w.ref === step.window);
    if (!target) throw new Error(`no window ${step.window}`);
    const own = target.groups.find((g) => g.externalId === step.key);
    if (step.kind === "create") {
      const anchor = ws(next++, step.name, { surfaces: [] });
      target.workspaces.unshift(anchor);
      target.groups.push({ ref: `workspace_group:${next++}`, name: step.name, externalId: step.key, anchor: anchor.ref, members: [anchor.ref], color: null });
      continue;
    }
    if (!own) throw new Error(`no group ${step.key}`);
    if (step.kind === "move") {
      for (const g of target.groups) g.members = g.members.filter((m) => m !== step.workspace);
      own.members.push(step.workspace);
    } else if (step.kind === "leave") {
      own.members = own.members.filter((m) => m !== step.workspace);
    } else if (step.kind === "rename") {
      own.name = step.name;
    } else if (step.kind === "color") {
      own.color = step.color;
    } else if (step.kind === "remove") {
      if (own.members.length !== 1) throw new Error(`group ${step.key} is not empty`);
      target.groups = target.groups.filter((g) => g !== own);
      target.workspaces = target.workspaces.filter((w) => w.ref !== own.anchor);
    }
  }
  return { ...before, windows };
}

function expectSettled(s: SyncState): void {
  expect(planSync(applySteps(s, planSync(s)))).toEqual([]);
}

describe("planSync", () => {
  it("creates a project group in place of its first workspace, collapsed, and keeps the members' order", () => {
    const s = state(
      [win(W1, 1, [ws(1, "dev-x"), ws(2, "751-a"), ws(3, "797vega-b", { surfaces: [] }), ws(4, "753-c"), ws(5, "797wt-d"), ws(6, "791lyra-e")])],
      [chat(1, ""), chat(2, "751orion-web"), chat(4, "753orion-web"), chat(5, "797vega-wt"), chat(6, "791lyra")],
      // workspace 3 has no live chat: its folder comes from cmux's sidebar.
      { sidebarCwds: new Map([["UUID-3", `${ROOT}/797vega`]]) },
    );
    expect(planSync(s)).toEqual([
      { kind: "create", window: W1, key: ORION, name: "orion", cwd: `${ROOT}/751orion-web`, before: "workspace:2", collapsed: true, pinned: false },
      { kind: "move", window: W1, key: ORION, group: "orion", workspace: "workspace:2", title: "751-a", from: null },
      { kind: "move", window: W1, key: ORION, group: "orion", workspace: "workspace:4", title: "753-c", from: null },
      {
        kind: "order",
        window: W1,
        key: ORION,
        group: "orion",
        members: [{ ref: "workspace:2", title: "751-a" }, { ref: "workspace:4", title: "753-c" }],
      },
      { kind: "create", window: W1, key: VEGA, name: "vega", cwd: `${ROOT}/797vega`, before: "workspace:3", collapsed: true, pinned: false },
      { kind: "move", window: W1, key: VEGA, group: "vega", workspace: "workspace:3", title: "797vega-b", from: null },
      { kind: "move", window: W1, key: VEGA, group: "vega", workspace: "workspace:5", title: "797wt-d", from: null },
      {
        kind: "order",
        window: W1,
        key: VEGA,
        group: "vega",
        members: [{ ref: "workspace:3", title: "797vega-b" }, { ref: "workspace:5", title: "797wt-d" }],
      },
      // lyra is a project of its own.
      { kind: "create", window: W1, key: LYRA, name: "lyra", cwd: `${ROOT}/791lyra`, before: "workspace:6", collapsed: true, pinned: false },
      { kind: "move", window: W1, key: LYRA, group: "lyra", workspace: "workspace:6", title: "791lyra-e", from: null },
    ]);
    expectSettled(s);
  });

  it("leaves the selected workspace ungrouped and starts its project's new group expanded", () => {
    const s = state([win(W1, 1, [ws(1, "751-a"), ws(2, "753-b")])], [chat(1, "751orion-web"), chat(2, "753orion-web")]);
    expect(planSync(s)).toEqual([
      { kind: "create", window: W1, key: ORION, name: "orion", cwd: `${ROOT}/753orion-web`, before: "workspace:2", collapsed: false, pinned: false },
      { kind: "move", window: W1, key: ORION, group: "orion", workspace: "workspace:2", title: "753-b", from: null },
    ]);
    expectSettled(s);
  });

  it("adds a new workspace to the existing group of its project", () => {
    const s = state(
      [win(W1, null, [ws(5, "orion", { surfaces: [] }), ws(1, "751-a"), ws(2, "753-b")], [group(1, "orion", ORION, [5, 1])])],
      [chat(1, "751orion-web"), chat(2, "753orion-web")],
    );
    expect(planSync(s)).toEqual([
      { kind: "move", window: W1, key: ORION, group: "orion", workspace: "workspace:2", title: "753-b", from: null },
      {
        kind: "order",
        window: W1,
        key: ORION,
        group: "orion",
        members: [{ ref: "workspace:1", title: "751-a" }, { ref: "workspace:2", title: "753-b" }],
      },
    ]);
  });

  it("never touches anchors, workspaces pinned in cmux, or workspaces outside the root", () => {
    const s = state(
      [
        win(
          W1,
          null,
          [ws(1, "my group"), ws(2, "751-pinned", { pinned: true }), ws(3, "tmp"), ws(4, "browser only", { surfaces: [] })],
          [group(1, "my group", null, [1])],
        ),
      ],
      [chat(1, "751orion-web"), chat(2, "751orion-web"), { ...chat(3, ""), cwd: "/tmp/751x" }],
      { pinnedIds: new Set(["session-1", "session-2", "session-3"]), sidebarCwds: new Map([["UUID-4", null]]) },
    );
    expect(planSync(s)).toEqual([]);
  });

  it("moves a workspace with a pinned chat to its project's long-task group, even when selected or in another group", () => {
    const s = state(
      [
        win(
          W1,
          1,
          [
            ws(1, "797-deps"),
            ws(6, "vega", { surfaces: [] }),
            ws(2, "795-flow"),
            ws(7, "mine", { surfaces: [] }),
            ws(3, "005-email"),
            ws(4, "751-x"),
            ws(8, "dev-cam"),
          ],
          [group(1, "vega", VEGA, [6, 2]), group(2, "mine", null, [7, 3])],
        ),
      ],
      [chat(1, "797vega"), chat(2, "795vega"), chat(3, "005nova"), chat(4, "751orion-web"), chat(8, "")],
      { pinnedIds: new Set(["session-1", "session-2", "session-3", "session-4", "session-8"]) },
    );
    const pinned = { window: W1, before: null, collapsed: false, pinned: true };
    // Created in project order, each below the pinned groups before it.
    expect(planSync(s)).toEqual([
      { kind: "create", ...pinned, key: LT_ORION, name: "orion · long tasks", cwd: `${ROOT}/751orion-web` },
      { kind: "move", window: W1, key: LT_ORION, group: "orion · long tasks", workspace: "workspace:4", title: "751-x", from: null },
      { kind: "create", ...pinned, key: LT_VEGA, name: "vega · long tasks", cwd: `${ROOT}/797vega` },
      { kind: "move", window: W1, key: LT_VEGA, group: "vega · long tasks", workspace: "workspace:1", title: "797-deps", from: null },
      { kind: "move", window: W1, key: LT_VEGA, group: "vega · long tasks", workspace: "workspace:2", title: "795-flow", from: "vega" },
      {
        kind: "order",
        window: W1,
        key: LT_VEGA,
        group: "vega · long tasks",
        members: [{ ref: "workspace:1", title: "797-deps" }, { ref: "workspace:2", title: "795-flow" }],
      },
      { kind: "create", ...pinned, key: LT_NOVA, name: "nova · long tasks", cwd: `${ROOT}/005nova` },
      { kind: "move", window: W1, key: LT_NOVA, group: "nova · long tasks", workspace: "workspace:3", title: "005-email", from: "mine" },
      { kind: "create", ...pinned, key: LT_DEV, name: "dev · long tasks", cwd: ROOT },
      { kind: "move", window: W1, key: LT_DEV, group: "dev · long tasks", workspace: "workspace:8", title: "dev-cam", from: null },
    ]);
    // No remove step for the emptied vega project group (cmux drops it itself, as it is not pinned).
    expectSettled(s);
  });

  it("puts a new long-task group above the long-task groups of later projects", () => {
    const s = state(
      [
        win(
          W1,
          null,
          [ws(9, "f", { surfaces: [] }), ws(4, "751-x"), ws(5, "u", { surfaces: [] }), ws(3, "005-email"), ws(1, "797-deps"), ws(8, "dev-cam")],
          [group(1, "orion · long tasks", LT_ORION, [9, 4]), group(2, "nova · long tasks", LT_NOVA, [5, 3])],
        ),
      ],
      [chat(4, "751orion-web"), chat(3, "005nova"), chat(1, "797vega"), chat(8, "")],
      { pinnedIds: new Set(["session-4", "session-3", "session-1", "session-8"]) },
    );
    expect(planSync(s).filter((step) => step.kind === "create")).toEqual([
      { kind: "create", window: W1, key: LT_VEGA, name: "vega · long tasks", cwd: `${ROOT}/797vega`, before: "workspace:5", collapsed: false, pinned: true },
      { kind: "create", window: W1, key: LT_DEV, name: "dev · long tasks", cwd: ROOT, before: null, collapsed: false, pinned: true },
    ]);
    expectSettled(s);
  });

  it("sends an unpinned member back to its project group at once and keeps a member without a chat during the grace", () => {
    const s = state(
      [
        win(
          W1,
          1,
          [ws(5, "vega · long tasks", { surfaces: [] }), ws(1, "797-deps"), ws(2, "797-closed", { surfaces: [] }), ws(6, "vega", { surfaces: [] }), ws(3, "795-flow")],
          [group(1, "vega · long tasks", LT_VEGA, [5, 1, 2]), group(2, "vega", VEGA, [6, 3])],
        ),
      ],
      [chat(1, "797vega"), chat(3, "795vega")],
      { sidebarCwds: new Map([["UUID-2", `${ROOT}/797vega`]]) },
    );
    expect(planSync(s)).toEqual([
      { kind: "move", window: W1, key: VEGA, group: "vega", workspace: "workspace:1", title: "797-deps", from: "vega · long tasks" },
      {
        kind: "order",
        window: W1,
        key: VEGA,
        group: "vega",
        members: [{ ref: "workspace:1", title: "797-deps" }, { ref: "workspace:3", title: "795-flow" }],
      },
    ]);
    expectSettled(s);
  });

  it("takes a member without a chat out of its long-task group after the grace, unless the last session cmux recorded there is pinned", () => {
    const s = state(
      [
        win(
          W1,
          null,
          [
            ws(5, "vega · long tasks", { surfaces: [] }),
            ws(1, "797vega-UI-UX"),
            ws(9, "797-deps-closed"),
            ws(10, "797-shell"),
            ws(2, "lt-tmp"),
            ws(3, "797-unknown"),
            ws(4, "797-deps"),
            ws(8, "tmp-chat"),
            ws(6, "vega", { surfaces: [] }),
            ws(7, "795-flow"),
          ],
          [group(1, "vega · long tasks", LT_VEGA, [5, 1, 9, 10, 2, 3, 4, 8]), group(2, "vega", VEGA, [6, 7])],
        ),
      ],
      // 4 runs a long task; 8 runs an unpinned chat outside the root, so it leaves without a grace.
      [chat(4, "797vega"), { ...chat(8, ""), cwd: "/tmp" }, chat(7, "795vega")],
      {
        pinnedIds: new Set(["session-4", "session-deps"]),
        // 9 is a closed long task, 1 a shell whose last chat is not pinned; cmux recorded no
        // session in the others.
        lastSessions: new Map([
          ["UUID-1", "session-ui-ux"],
          ["UUID-9", "session-deps"],
        ]),
        // Workspace 3's folder is not known yet.
        sidebarCwds: new Map([
          ["UUID-1", `${ROOT}/797vega`],
          ["UUID-9", `${ROOT}/797vega`],
          ["UUID-10", `${ROOT}/797vega`],
          ["UUID-2", "/tmp"],
        ]),
        graceOver: new Set(["UUID-1", "UUID-9", "UUID-10", "UUID-2", "UUID-3"]),
      },
    );
    expect(planSync(s)).toEqual([
      { kind: "move", window: W1, key: VEGA, group: "vega", workspace: "workspace:1", title: "797vega-UI-UX", from: "vega · long tasks" },
      { kind: "move", window: W1, key: VEGA, group: "vega", workspace: "workspace:10", title: "797-shell", from: "vega · long tasks" },
      {
        kind: "order",
        window: W1,
        key: VEGA,
        group: "vega",
        members: [
          { ref: "workspace:1", title: "797vega-UI-UX" },
          { ref: "workspace:10", title: "797-shell" },
          { ref: "workspace:7", title: "795-flow" },
        ],
      },
      // Without a project they leave for no group.
      { kind: "leave", window: W1, key: LT_VEGA, group: "vega · long tasks", workspace: "workspace:2", title: "lt-tmp" },
      { kind: "leave", window: W1, key: LT_VEGA, group: "vega · long tasks", workspace: "workspace:8", title: "tmp-chat" },
    ]);
    expectSettled(s);
  });

  it("keeps every member without a chat in its long-task group while cmux's hook store cannot be read", () => {
    const s = state(
      [win(W1, null, [ws(5, "vega · long tasks", { surfaces: [] }), ws(1, "797-closed"), ws(3, "797-unpinned")], [group(1, "vega · long tasks", LT_VEGA, [5, 1, 3])])],
      // The chat in 3 is not pinned, so it leaves at once all the same.
      [chat(3, "797vega")],
      { lastSessions: null, sidebarCwds: new Map([["UUID-1", `${ROOT}/797vega`]]), graceOver: new Set(["UUID-1"]) },
    );
    expect(planSync(s)).toEqual([
      { kind: "create", window: W1, key: VEGA, name: "vega", cwd: `${ROOT}/797vega`, before: null, collapsed: true, pinned: false },
      { kind: "move", window: W1, key: VEGA, group: "vega", workspace: "workspace:3", title: "797-unpinned", from: "vega · long tasks" },
    ]);
    expectSettled(s);
  });

  it("follows a long task into another project and removes the long-task groups left empty, but no project group", () => {
    // The chat in workspace 1 moved from the root to 005nova; it is still pinned.
    const s = state(
      [
        win(
          W1,
          1,
          [ws(8, "f", { surfaces: [] }), ws(6, "dev · long tasks", { surfaces: [] }), ws(1, "dev-camera"), ws(7, "orion", { surfaces: [] })],
          [group(1, "orion · long tasks", LT_ORION, [8]), group(2, "dev · long tasks", LT_DEV, [6, 1]), group(3, "orion", ORION, [7])],
        ),
      ],
      [chat(1, "005nova")],
      { pinnedIds: new Set(["session-1"]) },
    );
    expect(planSync(s)).toEqual([
      // Not above the dev group, which goes.
      { kind: "create", window: W1, key: LT_NOVA, name: "nova · long tasks", cwd: `${ROOT}/005nova`, before: null, collapsed: false, pinned: true },
      { kind: "move", window: W1, key: LT_NOVA, group: "nova · long tasks", workspace: "workspace:1", title: "dev-camera", from: "dev · long tasks" },
      { kind: "remove", window: W1, key: LT_ORION, group: "orion · long tasks" },
      { kind: "remove", window: W1, key: LT_DEV, group: "dev · long tasks" },
    ]);
    expectSettled(s);
  });

  it("leaves workspaces in project groups and in the user's own groups where they are", () => {
    const s = state(
      [
        win(
          W1,
          null,
          [ws(5, "vega", { surfaces: [] }), ws(1, "751 in vega"), ws(6, "mine", { surfaces: [] }), ws(2, "797 in mine")],
          [group(1, "vega", VEGA, [5, 1]), group(2, "mine", null, [6, 2])],
        ),
      ],
      [chat(1, "751orion-web"), chat(2, "797vega")],
    );
    expect(planSync(s)).toEqual([]);
  });

  it("counts members needing input into the header, keeping the user's name for the group", () => {
    const s = state(
      [
        win(
          W1,
          null,
          [ws(5, "Orion", { surfaces: [] }), ws(1, "751-a"), ws(2, "753-b"), ws(3, "755-c")],
          [group(1, "Orion · 1 needs input", ORION, [5, 1, 2, 3])],
        ),
      ],
      [
        chat(1, "751orion-web", { inputRequired: true }),
        chat(2, "753orion-web", { inputRequired: true }),
        // A second chat in the same workspace counts that workspace once.
        chat(8, "753orion-web", { inputRequired: true, workspace: "UUID-2" }),
        chat(3, "755orion-web"),
      ],
    );
    expect(planSync(s)).toEqual([
      { kind: "rename", window: W1, key: ORION, from: "Orion · 1 needs input", name: "Orion · 2 needs input" },
      { kind: "color", window: W1, key: ORION, group: "Orion · 2 needs input", color: "#DC2626" },
    ]);
    expectSettled(s);
  });

  it("clears only its own red once nothing needs input", () => {
    const s = state(
      [
        win(
          W1,
          null,
          [ws(5, "t", { surfaces: [] }), ws(1, "751-a"), ws(6, "s", { surfaces: [] }), ws(2, "797-b"), ws(7, "m", { surfaces: [] }), ws(3, "791-c")],
          [
            group(1, "Orion · 2 needs input", ORION, [5, 1], "#dc2626"),
            group(2, "vega", VEGA, [6, 2], "#00FF00"),
            group(3, "mine", null, [7, 3]),
          ],
        ),
      ],
      [chat(1, "751orion-web"), chat(2, "797vega"), chat(3, "791lyra", { inputRequired: true })],
    );
    expect(planSync(s)).toEqual([
      { kind: "rename", window: W1, key: ORION, from: "Orion · 2 needs input", name: "Orion" },
      { kind: "color", window: W1, key: ORION, group: "Orion", color: null },
    ]);
  });

  it("adds the count but keeps a color the user picked while a chat needs input", () => {
    const s = state(
      [win(W1, null, [ws(6, "s", { surfaces: [] }), ws(2, "797-b")], [group(2, "vega", VEGA, [6, 2], "#00FF00")])],
      [chat(2, "797vega", { inputRequired: true })],
    );
    expect(planSync(s)).toEqual([{ kind: "rename", window: W1, key: VEGA, from: "vega", name: "vega · 1 needs input" }]);
    expectSettled(s);
  });

  it("counts header attention on the members left after the moves", () => {
    const s = state(
      [
        win(
          W1,
          null,
          [ws(5, "lt", { surfaces: [] }), ws(1, "797-deps"), ws(3, "797-closed", { surfaces: [] }), ws(6, "s", { surfaces: [] }), ws(2, "795-flow")],
          [group(1, "vega · long tasks · 1 needs input", LT_VEGA, [5, 1, 3], "#DC2626"), group(2, "vega", VEGA, [6, 2])],
        ),
      ],
      // The chat waiting for input was unpinned.
      [chat(1, "797vega", { inputRequired: true }), chat(2, "795vega")],
    );
    expect(planSync(s).filter((step) => step.kind === "rename" || step.kind === "color")).toEqual([
      { kind: "rename", window: W1, key: LT_VEGA, from: "vega · long tasks · 1 needs input", name: "vega · long tasks" },
      { kind: "color", window: W1, key: LT_VEGA, group: "vega · long tasks", color: null },
      { kind: "rename", window: W1, key: VEGA, from: "vega", name: "vega · 1 needs input" },
      { kind: "color", window: W1, key: VEGA, group: "vega · 1 needs input", color: "#DC2626" },
    ]);
    expectSettled(s);
  });

  it("plans each window on its own, creating groups in the window that needs them", () => {
    const s = state(
      [
        win("window:1", 1, [ws(1, "751-a"), ws(2, "753-b")]),
        win("window:2", 4, [ws(3, "755-c"), ws(4, "797-d")]),
      ],
      [chat(1, "751orion-web"), chat(2, "753orion-web"), chat(3, "755orion-web"), chat(4, "797vega")],
    );
    const creates = planSync(s).filter((step) => step.kind === "create");
    expect(creates.map((step) => [step.window, step.key, step.kind === "create" && step.collapsed])).toEqual([
      ["window:1", ORION, false],
      ["window:2", ORION, true],
    ]);
    expectSettled(s);
  });
});

describe("planSync, moving the groups of earlier versions", () => {
  it("moves the old Long tasks group's members to their project's groups and removes it once empty", () => {
    const s = state(
      [
        win(
          W1,
          null,
          [
            ws(5, "Long tasks", { surfaces: [] }),
            ws(1, "774-log-watch"),
            ws(2, "797-deps", { surfaces: [] }),
            ws(3, "lt-tmp", { surfaces: [] }),
            ws(4, "005-backup"),
            ws(6, "lt-nowhere", { surfaces: [] }),
          ],
          [group(1, "Long tasks", OLD_LONG, [5, 1, 2, 3, 4, 6])],
        ),
      ],
      // 1 is a running long task, 2 a closed one, 4 a chat no longer pinned.
      [chat(1, "774orion-web"), chat(4, "005nova")],
      {
        pinnedIds: new Set(["session-1"]),
        sidebarCwds: new Map([
          ["UUID-2", `${ROOT}/797vega`],
          ["UUID-3", "/tmp"],
          ["UUID-6", null],
        ]),
      },
    );
    const pinned = { window: W1, before: null, collapsed: false, pinned: true };
    expect(planSync(s)).toEqual([
      { kind: "create", ...pinned, key: LT_ORION, name: "orion · long tasks", cwd: `${ROOT}/774orion-web` },
      { kind: "move", window: W1, key: LT_ORION, group: "orion · long tasks", workspace: "workspace:1", title: "774-log-watch", from: "Long tasks" },
      { kind: "create", ...pinned, key: LT_VEGA, name: "vega · long tasks", cwd: `${ROOT}/797vega` },
      { kind: "move", window: W1, key: LT_VEGA, group: "vega · long tasks", workspace: "workspace:2", title: "797-deps", from: "Long tasks" },
      { kind: "create", window: W1, key: NOVA, name: "nova", cwd: `${ROOT}/005nova`, before: null, collapsed: true, pinned: false },
      { kind: "move", window: W1, key: NOVA, group: "nova", workspace: "workspace:4", title: "005-backup", from: "Long tasks" },
      // Workspaces without a project leave the group.
      { kind: "leave", window: W1, key: OLD_LONG, group: "Long tasks", workspace: "workspace:3", title: "lt-tmp" },
      { kind: "leave", window: W1, key: OLD_LONG, group: "Long tasks", workspace: "workspace:6", title: "lt-nowhere" },
      { kind: "remove", window: W1, key: OLD_LONG, group: "Long tasks" },
    ]);
    expectSettled(s);
  });

  it("keeps a closed long task in the old Long tasks group until its folder is known", () => {
    const s = state(
      [win(W1, null, [ws(5, "Long tasks", { surfaces: [] }), ws(1, "797-closed", { surfaces: [] })], [group(1, "Long tasks", OLD_LONG, [5, 1])])],
      [],
    );
    expect(planSync(s)).toEqual([]);
  });

  it("adopts the first old folder group of each project, renames it only while it has its family's name, and empties the others into it", () => {
    const s = state(
      [
        win(
          W1,
          6,
          [
            ws(10, "orion-web", { surfaces: [] }),
            ws(1, "751-a"),
            ws(11, "dev", { surfaces: [] }),
            ws(2, "dev-x"),
            ws(12, "vega", { surfaces: [] }),
            ws(3, "797-b"),
            ws(13, "vega-wt", { surfaces: [] }),
            ws(4, "797wt-c"),
            ws(5, "797wt-shell", { surfaces: [] }),
            ws(14, "Nova", { surfaces: [] }),
            ws(6, "005-e"),
            ws(15, "lyra", { surfaces: [] }),
            ws(9, "791-d"),
            ws(7, "500-new"),
            ws(8, "753-new"),
            ws(16, "791-new"),
          ],
          [
            group(1, "orion-web", OLD_ORION, [10, 1]),
            group(2, "dev", OLD_DEV, [11, 2]),
            group(3, "vega", OLD_VEGA, [12, 3]),
            group(4, "vega-wt · 1 needs input", OLD_VEGA_WT, [13, 4, 5], "#DC2626"),
            group(5, "Nova", OLD_NOVA, [14, 6]),
            group(6, "lyra", OLD_LYRA, [15, 9]),
          ],
        ),
      ],
      [
        chat(1, "751orion-web", { inputRequired: true }),
        chat(2, ""),
        chat(3, "797vega"),
        chat(4, "797vega-wt", { inputRequired: true }),
        chat(6, "005nova"),
        chat(7, "500mono"),
        chat(8, "753orion-web"),
        chat(9, "791lyra"),
        chat(16, "791lyra"),
      ],
    );
    expect(planSync(s)).toEqual([
      // vega-wt's members, the shell without a chat too, go to the vega group.
      { kind: "move", window: W1, key: OLD_VEGA, group: "vega", workspace: "workspace:4", title: "797wt-c", from: "vega-wt · 1 needs input" },
      { kind: "move", window: W1, key: OLD_VEGA, group: "vega", workspace: "workspace:5", title: "797wt-shell", from: "vega-wt · 1 needs input" },
      {
        kind: "order",
        window: W1,
        key: OLD_VEGA,
        group: "vega",
        members: [
          { ref: "workspace:3", title: "797-b" },
          { ref: "workspace:4", title: "797wt-c" },
          { ref: "workspace:5", title: "797wt-shell" },
        ],
      },
      { kind: "move", window: W1, key: OLD_DEV, group: "dev", workspace: "workspace:7", title: "500-new", from: null },
      {
        kind: "order",
        window: W1,
        key: OLD_DEV,
        group: "dev",
        members: [{ ref: "workspace:2", title: "dev-x" }, { ref: "workspace:7", title: "500-new" }],
      },
      { kind: "move", window: W1, key: OLD_ORION, group: "orion", workspace: "workspace:8", title: "753-new", from: null },
      {
        kind: "order",
        window: W1,
        key: OLD_ORION,
        group: "orion",
        members: [{ ref: "workspace:1", title: "751-a" }, { ref: "workspace:8", title: "753-new" }],
      },
      // The old lyra group is lyra's own group now.
      { kind: "move", window: W1, key: OLD_LYRA, group: "lyra", workspace: "workspace:16", title: "791-new", from: null },
      {
        kind: "order",
        window: W1,
        key: OLD_LYRA,
        group: "lyra",
        members: [{ ref: "workspace:9", title: "791-d" }, { ref: "workspace:16", title: "791-new" }],
      },
      { kind: "rename", window: W1, key: OLD_ORION, from: "orion-web", name: "orion · 1 needs input" },
      { kind: "color", window: W1, key: OLD_ORION, group: "orion · 1 needs input", color: "#DC2626" },
      { kind: "rename", window: W1, key: OLD_VEGA, from: "vega", name: "vega · 1 needs input" },
      { kind: "color", window: W1, key: OLD_VEGA, group: "vega · 1 needs input", color: "#DC2626" },
      { kind: "remove", window: W1, key: OLD_VEGA_WT, group: "vega-wt" },
    ]);
    expectSettled(s);
  });

  it("empties old folder groups into a project group of its own and never creates one while an old group can serve", () => {
    const s = state(
      [
        win(
          "window:1",
          null,
          [ws(10, "vega", { surfaces: [] }), ws(1, "797-a"), ws(11, "vega", { surfaces: [] }), ws(2, "795-b")],
          [group(1, "vega", VEGA, [10, 1]), group(2, "vega", OLD_VEGA, [11, 2])],
        ),
        win("window:2", null, [ws(12, "vega-wt", { surfaces: [] }), ws(3, "797wt-c"), ws(4, "799-d")], [group(3, "vega-wt", OLD_VEGA_WT, [12, 3])]),
      ],
      [chat(1, "797vega"), chat(2, "795vega"), chat(3, "797vega-wt"), chat(4, "799vega")],
    );
    expect(planSync(s)).toEqual([
      { kind: "move", window: "window:1", key: VEGA, group: "vega", workspace: "workspace:2", title: "795-b", from: "vega" },
      {
        kind: "order",
        window: "window:1",
        key: VEGA,
        group: "vega",
        members: [{ ref: "workspace:1", title: "797-a" }, { ref: "workspace:2", title: "795-b" }],
      },
      { kind: "remove", window: "window:1", key: OLD_VEGA, group: "vega" },
      { kind: "move", window: "window:2", key: OLD_VEGA_WT, group: "vega", workspace: "workspace:4", title: "799-d", from: null },
      {
        kind: "order",
        window: "window:2",
        key: OLD_VEGA_WT,
        group: "vega",
        members: [{ ref: "workspace:3", title: "797wt-c" }, { ref: "workspace:4", title: "799-d" }],
      },
      { kind: "rename", window: "window:2", key: OLD_VEGA_WT, from: "vega-wt", name: "vega" },
    ]);
    expectSettled(s);
  });
});

describe("cmux output parsers", () => {
  it("reads windows, terminal surfaces, pins and the selection from cmux tree", () => {
    const tree = JSON.stringify({
      active: {},
      windows: [
        {
          ref: "window:1000010000",
          selected_workspace_ref: "workspace:1000010002",
          workspaces: [
            {
              id: "9FA25C7F-A1BE-4B39-82E4-A52FA68F87DD",
              ref: "workspace:1000010000",
              title: "751-app-621-notes",
              pinned: true,
              panes: [
                { surfaces: [{ type: "terminal", id: "1BC691BF-42E7-45CA-A471-A7C1D2489496", tty: "ttys001" }] },
                {
                  surfaces: [
                    { type: "browser", id: "0D7C2E61-5A4B-4C3D-9E8F-7A6B5C4D3E2F", tty: null },
                    { type: "terminal", id: "36FA2FF0-AA04-4D83-A334-E8DC00AEFE94", tty: "ttys020" },
                  ],
                },
              ],
            },
            // Without `--id-format both` cmux lists no surface ids.
            { id: "A773A9C5", ref: "workspace:1000010028", title: "005nova-_", pinned: false, panes: [{ surfaces: [{ type: "terminal", tty: null }] }] },
          ],
        },
      ],
    });
    expect(parseTree(tree)).toEqual([
      {
        ref: "window:1000010000",
        selected: "workspace:1000010002",
        workspaces: [
          {
            id: "9FA25C7F-A1BE-4B39-82E4-A52FA68F87DD",
            ref: "workspace:1000010000",
            title: "751-app-621-notes",
            pinned: true,
            surfaces: ["1BC691BF-42E7-45CA-A471-A7C1D2489496", "36FA2FF0-AA04-4D83-A334-E8DC00AEFE94"],
          },
          { id: "A773A9C5", ref: "workspace:1000010028", title: "005nova-_", pinned: false, surfaces: [] },
        ],
        groups: [],
      },
    ]);
    expect(parseTree("Error: Socket not found")).toBeNull();
    expect(parseTree(JSON.stringify({ windows: [{ ref: "window:1", workspaces: [{ ref: "workspace:1" }] }] }))).toBeNull();
  });

  it("reads groups from workspace-group list and rejects another format", () => {
    const list = JSON.stringify({
      groups: [
        {
          anchor_workspace_ref: "workspace:1000010060",
          custom_color: "#DC2626",
          external_id: "omp-sessions:long-tasks",
          is_collapsed: false,
          member_workspace_refs: ["workspace:1000010060", "workspace:1000010059"],
          name: "Long tasks",
          ref: "workspace_group:1000010004",
        },
        { anchor_workspace_ref: "workspace:7", custom_color: null, external_id: null, member_workspace_refs: ["workspace:7"], name: "mine", ref: "workspace_group:5" },
      ],
      window_ref: "window:1000010001",
    });
    expect(parseGroupList(list)).toEqual([
      {
        ref: "workspace_group:1000010004",
        name: "Long tasks",
        externalId: "omp-sessions:long-tasks",
        anchor: "workspace:1000010060",
        members: ["workspace:1000010060", "workspace:1000010059"],
        color: "#DC2626",
      },
      { ref: "workspace_group:5", name: "mine", externalId: null, anchor: "workspace:7", members: ["workspace:7"], color: null },
    ]);
    expect(parseGroupList(JSON.stringify({ groups: [{ ref: "workspace_group:5", name: "x", member_workspace_refs: [7] }] }))).toBeNull();
  });

  it("reads the cmux ids from the environment ps -E prints after each process's arguments", () => {
    const surface = "1BC691BF-42E7-45CA-A471-A7C1D2489496";
    const workspace = "89BB7A8A-F4D7-4D3B-AFAF-38461D41D699";
    const other = "36FA2FF0-AA04-4D83-A334-E8DC00AEFE94";
    const out = [
      // An argument that looks like a variable comes before the environment and does not count.
      `11512 omp --note CMUX_SURFACE_ID=${other} TERM=xterm-256color CMUX_WORKSPACE_ID=${workspace} CMUX_SURFACE_ID=${surface} HOME=/Users/you`,
      // A value with spaces, and one with newlines: the lines after it, even one that starts
      // with a number, still belong to pid 10705.
      ` 10705 omp PROMPT=a b c NOTE=first line`,
      `2 more lines`,
      `end CMUX_SURFACE_ID=${other} LANG=en_US.UTF-8`,
      // Only a UUID counts.
      `  9065 omp CMUX_SURFACE_ID=not-a-uuid CMUX_WORKSPACE_ID=${workspace}`,
      // A process outside cmux.
      `   777 bun server.ts PATH=/usr/bin`,
      "",
    ].join("\n");
    // ps leaves out pid 4242, which no longer exists.
    expect(parsePsEnv(out, [11512, 10705, 9065, 777, 4242])).toEqual(
      new Map([
        [11512, { surface, workspace }],
        [10705, { surface: other, workspace: null }],
        [9065, { surface: null, workspace }],
        [777, { surface: null, workspace: null }],
      ]),
    );
  });

  it("places a process in the workspace holding its surface, else in the one its CMUX_WORKSPACE_ID names", () => {
    const windows = [
      win("window:1", null, [ws(1, "a"), ws(2, "b")]),
      win("window:2", null, [ws(3, "c", { surfaces: [surfaceId(3), surfaceId(9)] })]),
    ];
    const ids = new Map<number, CmuxIds>([
      // Its surface moved from workspace 1 to workspace 3, in another window.
      [101, { surface: surfaceId(9), workspace: "UUID-1" }],
      [102, { surface: surfaceId(2), workspace: "UUID-2" }],
      // cmux lists its surface nowhere: the workspace counts.
      [103, { surface: surfaceId(8), workspace: "UUID-1" }],
      [104, { surface: null, workspace: "UUID-2" }],
      // cmux lists neither, or the process runs outside cmux: it is in no workspace.
      [105, { surface: surfaceId(7), workspace: "UUID-7" }],
      [106, { surface: null, workspace: null }],
    ]);
    expect(workspacesByPid(windows, ids)).toEqual(
      new Map([
        [101, "UUID-3"],
        [102, "UUID-2"],
        [103, "UUID-1"],
        [104, "UUID-2"],
      ]),
    );
  });

  it("reads the last omp session cmux recorded in each workspace from its hook store", () => {
    const scoring = "89BB7A8A-F4D7-4D3B-AFAF-38461D41D699";
    const email = "5995AFFB-2F94-4D04-A787-862533D09E66";
    const store = JSON.stringify({
      version: 1,
      agentHookFailureReportTimestamps: {},
      sessions: {
        a: { sessionId: "s-before", workspaceId: scoring, surfaceId: "1BC691BF-42E7-45CA-A471-A7C1D2489496", updatedAt: 1793404492.2, runtimeStatus: "running" },
        // The same workspace in lower case, recorded later; one recorded earlier does not count.
        b: { sessionId: "s-last", workspaceId: scoring.toLowerCase(), updatedAt: 1793404500.5 },
        c: { sessionId: "s-earliest", workspaceId: scoring, updatedAt: 1793404400 },
        d: { sessionId: "s-email", workspaceId: email, updatedAt: 1793673045.5 },
        // Malformed records are skipped.
        e: { sessionId: "s-text-time", workspaceId: email, updatedAt: "1793999999" },
        f: { workspaceId: email, updatedAt: 1793999999 },
        g: { sessionId: "s-no-workspace", updatedAt: 1793999999 },
        h: "not a record",
      },
    });
    expect(parseHookSessions(store)).toEqual(
      new Map([
        [scoring, "s-last"],
        [email, "s-email"],
      ]),
    );
    expect(parseHookSessions(JSON.stringify({ version: 2, sessions: {} }))).toBeNull();
    expect(parseHookSessions(JSON.stringify({ version: 1, sessions: [] }))).toBeNull();
    expect(parseHookSessions(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseHookSessions("{")).toBeNull();
  });

  it("reads the cwd line of sidebar-state", () => {
    expect(parseSidebarCwd("tab=A10E\ncolor=none\ncwd=/Users/you/dev/797vega\nfocused_cwd=/x\n")).toBe(`${ROOT}/797vega`);
    expect(parseSidebarCwd("tab=A10E\ncwd=none\n")).toBeNull();
  });
});

function host(pid: number, cwd: string, inputRequired = false): CliHost {
  return {
    instanceId: `inst-${pid}`,
    generation: 1,
    pid,
    sessionId: `session-${pid}`,
    sessionName: null,
    cwd,
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    startedAt: 0,
    participants: 1,
    relayConnected: true,
    inputRequired,
    busy: false,
    access: "control",
  };
}

const TREE = "cmux tree --all --json --id-format both";

function treeJson(selected: string, workspaces: Workspace[]): string {
  return JSON.stringify({
    windows: [
      {
        ref: W1,
        selected_workspace_ref: selected,
        workspaces: workspaces.map(({ id, ref, title, pinned, surfaces }) => ({
          id,
          ref,
          title,
          pinned,
          panes: [{ surfaces: surfaces.map((surface) => ({ type: "terminal", id: surface })) }],
        })),
      },
    ],
  });
}

/** `ps -E` output for `[pid, n]` pairs: process `pid` runs in workspace `n`'s terminal. */
function psEnv(...processes: [number, number][]): string {
  return processes.map(([pid, n]) => `${String(pid).padStart(5)} omp --profile=default TERM=xterm-256color CMUX_SURFACE_ID=${surfaceId(n)} HOME=/Users/you\n`).join("");
}

function groupJson(g: Group): Record<string, unknown> {
  return {
    ref: g.ref,
    name: g.name,
    external_id: g.externalId,
    anchor_workspace_ref: g.anchor,
    member_workspace_refs: g.members,
    custom_color: g.color,
  };
}

const READS = /^cmux (tree|sidebar-state|workspace-group list)|^\/bin\/ps/;

const TMP = mkdtempSync(join(tmpdir(), "cmux-groups-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let storeFiles = 0;

/** cmux's omp hook store with one record per `[workspace UUID, session ID, updatedAt]`. */
function hookStore(...records: [string, string, number][]): string {
  const sessions = Object.fromEntries(
    records.map(([workspaceId, sessionId, updatedAt], i) => [
      `record-${i}`,
      { sessionId, workspaceId, surfaceId: surfaceId(i), updatedAt, cwd: ROOT, runtimeStatus: "running" },
    ]),
  );
  return JSON.stringify({ version: 1, agentHookFailureReportTimestamps: {}, sessions });
}

/**
 * A GroupSync whose commands go to `respond`; `changes` keeps the commands that change cmux.
 * Its clock reads `clock.now`; a long-task row may run no chat for a minute. cmux's hook store,
 * at `storePath`, holds `store` (null: there is no such file).
 */
function harness(
  respond: (cmd: string) => Partial<ProcessResult> | undefined | Promise<Partial<ProcessResult> | undefined>,
  hosts: () => CliHost[],
  pinned: string[] = [],
  store: string | null = hookStore(),
) {
  const calls: string[] = [];
  const logs: string[] = [];
  const clock = { now: 0 };
  const storePath = join(TMP, `omp-hook-sessions-${storeFiles++}.json`);
  if (store !== null) writeFileSync(storePath, store);
  const sync = new GroupSync({
    cmuxBin: "cmux",
    projects: MAP,
    window: null,
    exec: async (args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      const reply = (await respond(cmd)) ?? {};
      return { stdout: reply.stdout ?? "OK\n", stderr: reply.stderr ?? "", code: reply.code ?? 0 };
    },
    liveHosts: async () => hosts(),
    pinnedIds: async () => new Set(pinned),
    hookSessionsPath: storePath,
    longTaskGraceMs: 60_000,
    now: () => clock.now,
    log: (line) => logs.push(line),
  });
  return { sync, calls, logs, clock, storePath, changes: () => calls.filter((cmd) => !READS.test(cmd)) };
}

/**
 * cmux with "797-deps" (workspace 1) in "vega · long tasks" and "795-flow" (workspace 3) in
 * "vega". Chat 103 runs in workspace 3, any other in workspace 1.
 */
function vegaLongTask(hosts: () => CliHost[]): (cmd: string) => Partial<ProcessResult> | undefined {
  return (cmd) => {
    if (cmd === TREE) {
      return {
        stdout: treeJson("workspace:3", [ws(20, "vega · long tasks", { surfaces: [] }), ws(1, "797-deps"), ws(21, "vega", { surfaces: [] }), ws(3, "795-flow")]),
      };
    }
    if (cmd.startsWith("cmux workspace-group list")) {
      const groups = [group(20, "vega · long tasks", LT_VEGA, [20, 1]), group(21, "vega", VEGA, [21, 3])];
      return { stdout: JSON.stringify({ groups: groups.map(groupJson) }) };
    }
    if (cmd.startsWith("/bin/ps")) return { stdout: psEnv(...hosts().map((h): [number, number] => [h.pid, h.pid === 103 ? 3 : 1])) };
    if (cmd.startsWith("cmux sidebar-state --workspace workspace:1")) return { stdout: `tab=A\ncwd=${ROOT}/797vega\n` };
  };
}

/** The changes and log lines of "797-deps" leaving "vega · long tasks" for "vega". */
const DEPS_LEAVES = [
  "cmux workspace-group add --group workspace_group:21 --workspace workspace:1 --window window:1",
  "cmux workspace-group ungroup workspace_group:20 --remove-generated-anchor --window window:1",
];
const DEPS_LEAVES_LOG = ['groups: moved workspace:1 "797-deps" to "vega"', 'groups: removed the empty group "vega · long tasks"'];

describe("GroupSync", () => {
  it("names and colors a header while a member needs input, then restores both", async () => {
    let waiting = true;
    let current = group(9, "Orion", ORION, [10, 2]);
    const { sync, logs, changes } = harness(
      (cmd) => {
        if (cmd === TREE) return { stdout: treeJson("workspace:2", [ws(10, "Orion", { surfaces: [] }), ws(2, "751-a")]) };
        if (cmd.startsWith("cmux workspace-group list")) return { stdout: JSON.stringify({ groups: [groupJson(current)] }) };
        if (cmd.startsWith("/bin/ps")) return { stdout: psEnv([102, 2]) };
      },
      () => [host(102, `${ROOT}/751orion-web`, waiting)],
    );

    await sync.sync();
    expect(changes()).toEqual([
      "cmux workspace-group rename workspace_group:9 --name Orion · 1 needs input --window window:1",
      "cmux workspace-group set-color workspace_group:9 --hex #DC2626 --window window:1",
    ]);
    expect(logs).toEqual(['groups: renamed "Orion" to "Orion · 1 needs input"', 'groups: colored "Orion · 1 needs input" #DC2626']);

    current = { ...current, name: "Orion · 1 needs input", color: "#DC2626" };
    await sync.sync();
    expect(changes()).toHaveLength(2);

    waiting = false;
    await sync.sync();
    expect(changes().slice(2)).toEqual([
      "cmux workspace-group rename workspace_group:9 --name Orion --window window:1",
      "cmux workspace-group set-color workspace_group:9 --window window:1",
    ]);
    expect(logs.slice(2)).toEqual(['groups: renamed "Orion · 1 needs input" to "Orion"', 'groups: cleared the color of "Orion"']);
  });

  it("creates a group in place, collapses it, and puts its members back in their sidebar order", async () => {
    let groups: Group[] = [];
    const created = group(20, "orion", ORION, [30]);
    const { sync, logs, changes } = harness(
      (cmd) => {
        if (cmd === TREE) {
          return { stdout: treeJson("workspace:1", [ws(1, "dev-x"), ws(2, "751-a"), ws(3, "753-b")]) };
        }
        if (cmd.startsWith("cmux workspace-group list")) return { stdout: JSON.stringify({ groups: groups.map(groupJson) }) };
        if (cmd.startsWith("/bin/ps")) return { stdout: psEnv([101, 1], [102, 2], [103, 3]) };
        if (cmd.startsWith("cmux workspace-group create")) {
          // As if cmux had put the second member above the first.
          groups = [{ ...created, members: ["workspace:30", "workspace:3", "workspace:2"] }];
          return { stdout: JSON.stringify({ created: true, group: groupJson(created) }) };
        }
        if (cmd.includes("add --group workspace_group:20 --workspace workspace:3")) return { code: 1, stderr: "Error: boom" };
      },
      () => [host(101, ROOT), host(102, `${ROOT}/751orion-web`), host(103, `${ROOT}/753orion-web`)],
    );

    await sync.sync();
    expect(changes()).toEqual([
      "cmux workspace-group create --name orion --external-id omp-sessions:project:orion --cwd /Users/you/dev/751orion-web --window window:1 --json",
      "cmux reorder-workspace --workspace workspace:30 --before workspace:2 --window window:1",
      "cmux workspace-group collapse workspace_group:20 --window window:1",
      "cmux workspace-group add --group workspace_group:20 --workspace workspace:2 --window window:1",
      "cmux workspace-group add --group workspace_group:20 --workspace workspace:3 --window window:1",
      "cmux reorder-workspace --workspace workspace:2 --after workspace:30 --window window:1",
    ]);
    // The failed add is logged and the sync goes on.
    expect(logs).toEqual([
      'groups: created "orion" in window:1, collapsed',
      'groups: moved workspace:2 "751-a" to "orion"',
      "groups: cmux workspace-group add --group workspace_group:20 --workspace workspace:3 --window window:1 failed: Error: boom",
      'groups: reordered workspace:2 "751-a" in "orion"',
    ]);
  });

  it("pins a new long-task group above a later project's, empties the old Long tasks group into it and removes that", async () => {
    const created = group(30, "vega · long tasks", LT_VEGA, [31]);
    const { sync, calls, logs, changes } = harness(
      (cmd) => {
        if (cmd === TREE) {
          return {
            stdout: treeJson("workspace:3", [
              ws(20, "Long tasks", { surfaces: [] }),
              ws(1, "797-deps"),
              ws(2, "lt-tmp", { surfaces: [] }),
              ws(21, "nova · long tasks", { surfaces: [] }),
              ws(3, "005-x"),
            ]),
          };
        }
        if (cmd.startsWith("cmux workspace-group list")) {
          const groups = [group(20, "Long tasks", OLD_LONG, [20, 1, 2]), group(21, "nova · long tasks", LT_NOVA, [21, 3])];
          return { stdout: JSON.stringify({ groups: groups.map(groupJson) }) };
        }
        if (cmd.startsWith("/bin/ps")) return { stdout: psEnv([101, 1], [103, 3]) };
        if (cmd.startsWith("cmux sidebar-state --workspace workspace:2")) return { stdout: "tab=A\ncwd=/tmp\n" };
        if (cmd.startsWith("cmux workspace-group create")) return { stdout: JSON.stringify({ created: true, group: groupJson(created) }) };
      },
      () => [host(101, `${ROOT}/797vega`), host(103, `${ROOT}/005nova`)],
      ["session-101", "session-103"],
    );

    await sync.sync();
    // The closed long task's folder is asked even though it sits in a group.
    expect(calls).toContain("cmux sidebar-state --workspace workspace:2 --window window:1");
    expect(changes()).toEqual([
      "cmux workspace-group create --name vega · long tasks --external-id omp-sessions:long-tasks:vega --cwd /Users/you/dev/797vega --window window:1 --json",
      "cmux workspace-group pin workspace_group:30 --window window:1",
      "cmux workspace-group set-icon workspace_group:30 --symbol pin.fill --window window:1",
      "cmux reorder-workspace --workspace workspace:31 --before workspace:21 --window window:1",
      "cmux workspace-group add --group workspace_group:30 --workspace workspace:1 --window window:1",
      "cmux workspace-group remove --workspace workspace:2 --window window:1",
      "cmux workspace-group ungroup workspace_group:20 --remove-generated-anchor --window window:1",
    ]);
    expect(logs).toEqual([
      'groups: created "vega · long tasks" in window:1, pinned',
      'groups: moved workspace:1 "797-deps" to "vega · long tasks"',
      'groups: took workspace:2 "lt-tmp" out of "Long tasks"',
      'groups: removed the empty group "Long tasks"',
    ]);
  });

  it("leaves it to cmux to drop an emptied group that is not pinned", async () => {
    let moved = false;
    const { sync, logs, changes } = harness(
      (cmd) => {
        if (cmd === TREE) {
          return {
            stdout: treeJson("workspace:1", [ws(10, "vega", { surfaces: [] }), ws(1, "797-a"), ws(11, "vega-wt", { surfaces: [] }), ws(2, "797wt-b")]),
          };
        }
        if (cmd.startsWith("cmux workspace-group list")) {
          const groups = moved
            ? [group(1, "vega", OLD_VEGA, [10, 1, 2])]
            : [group(1, "vega", OLD_VEGA, [10, 1]), group(2, "vega-wt", OLD_VEGA_WT, [11, 2])];
          return { stdout: JSON.stringify({ groups: groups.map(groupJson) }) };
        }
        if (cmd.startsWith("/bin/ps")) return { stdout: psEnv([101, 1], [102, 2]) };
        // As cmux does, the move takes vega-wt's header along with its last workspace.
        if (cmd.startsWith("cmux workspace-group add")) moved = true;
      },
      () => [host(101, `${ROOT}/797vega`), host(102, `${ROOT}/797vega-wt`)],
    );

    await sync.sync();
    expect(changes()).toEqual(["cmux workspace-group add --group workspace_group:1 --workspace workspace:2 --window window:1"]);
    expect(logs).toEqual(['groups: moved workspace:2 "797wt-b" to "vega"', 'groups: cmux removed the empty group "vega-wt"']);
  });

  it("keeps a long-task row while its chat restarts and takes it out once a minute has passed without one", async () => {
    const deps = host(101, `${ROOT}/797vega`);
    // The same chat after a restart: a new process in the same terminal, the same session.
    const restarted = { ...host(111, `${ROOT}/797vega`), sessionId: "session-101" };
    const flow = host(103, `${ROOT}/795vega`);
    let hosts = [deps, flow];
    // cmux's hook store has no record of it, as for a chat in a profile without the hook.
    const { sync, calls, logs, clock, changes } = harness(vegaLongTask(() => hosts), () => hosts, ["session-101"]);

    await sync.sync();
    // The chat stops: its row stays, and cmux is asked for the workspace's folder.
    hosts = [flow];
    await sync.sync();
    expect(calls).toContain("cmux sidebar-state --workspace workspace:1 --window window:1");
    clock.now = 45_000;
    hosts = [restarted, flow];
    await sync.sync();
    // It stops again: the minute starts anew.
    clock.now = 50_000;
    hosts = [flow];
    await sync.sync();
    clock.now = 100_000;
    await sync.sync();
    expect(changes()).toEqual([]);

    clock.now = 110_000;
    await sync.sync();
    expect(changes()).toEqual(DEPS_LEAVES);
    expect(logs).toEqual(DEPS_LEAVES_LOG);
  });

  it("keeps a closed long task's row past the grace while the last session cmux recorded there is pinned", async () => {
    const flow = host(103, `${ROOT}/795vega`);
    const { sync, logs, clock, changes, storePath } = harness(
      vegaLongTask(() => [flow]),
      () => [flow],
      ["session-deps"],
      // Records name a workspace in either case; the latest counts.
      hookStore(["uuid-1", "session-scratch", 1793404400.5], ["uuid-1", "session-deps", 1793404500.5]),
    );

    await sync.sync();
    clock.now = 120_000;
    await sync.sync();
    expect(changes()).toEqual([]);

    // A chat that is not pinned ran there last, so the row is a misplaced shell and leaves.
    writeFileSync(storePath, hookStore(["UUID-1", "session-deps", 1793404500.5], ["UUID-1", "session-scratch", 1793404600.5]));
    clock.now = 130_000;
    await sync.sync();
    expect(changes()).toEqual(DEPS_LEAVES);
    expect(logs).toEqual(DEPS_LEAVES_LOG);
  });

  it("keeps every long-task row without a chat while cmux's hook store cannot be read, and logs that once", async () => {
    const flow = host(103, `${ROOT}/795vega`);
    const { sync, logs, clock, changes, storePath } = harness(vegaLongTask(() => [flow]), () => [flow], [], null);

    await sync.sync();
    clock.now = 120_000;
    await sync.sync();
    expect(changes()).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith(`groups: cannot read cmux's omp session store ${storePath} (`);
    expect(logs[0]).toEndWith("); long-task rows without a chat stay until it can be read");

    // Readable again, and without a record of the row: its grace is long over.
    writeFileSync(storePath, hookStore());
    clock.now = 130_000;
    await sync.sync();
    expect(changes()).toEqual(DEPS_LEAVES);
    expect(logs.slice(1)).toEqual(DEPS_LEAVES_LOG);
  });

  it("logs once while cmux is not running and changes nothing", async () => {
    const { sync, calls, logs } = harness(() => ({ stdout: "", stderr: "Error: Socket not found at /tmp/cmux.sock\n", code: 1 }), () => []);
    await sync.sync();
    await sync.sync();
    expect(calls).toEqual([TREE, TREE]);
    expect(logs).toEqual(["groups: cmux is not reachable, skipping until it is: Error: Socket not found at /tmp/cmux.sock"]);
  });

  it("runs one sync at a time and one more for the calls made meanwhile", async () => {
    let running = 0;
    let most = 0;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { sync, calls } = harness(async () => {
      most = Math.max(most, ++running);
      await gate;
      running--;
      return { stdout: "", code: 1 };
    }, () => []);
    const all = Promise.all([sync.sync(), sync.sync(), sync.sync()]);
    open();
    await all;
    expect(calls).toHaveLength(2);
    expect(most).toBe(1);
  });
});
