import { describe, expect, it } from "bun:test";
import {
  checkAuth,
  deriveFolder,
  parseCliLink,
  parseCliList,
  postCheckLink,
  preCheckLink,
  sortHosts,
  toHostCard,
  validateLinkRequest,
  type CliHost,
} from "./hosts";
import type { ProjectMap } from "./projects";

const ROOT = "/Users/you/dev";
const MAP: ProjectMap = { root: ROOT, otherName: "dev", list: [{ name: "orion", families: ["orion-web"] }] };

const sampleHost1: CliHost = {
  instanceId: "inst-1",
  generation: 1,
  pid: 101,
  sessionId: "sess-1",
  sessionName: "feature-auth",
  cwd: "/Users/you/dev/755orion-web",
  model: { provider: "anthropic", id: "claude-3-7-sonnet" },
  startedAt: 1000,
  participants: 1,
  relayConnected: true,
  inputRequired: false,
  busy: false,
  access: "control",
};

const sampleHost2: CliHost = {
  instanceId: "inst-2",
  generation: 2,
  pid: 102,
  sessionId: "sess-2",
  sessionName: null,
  cwd: "/Users/you/dev/omp-sessions",
  model: { provider: "google-antigravity", id: "gemini-3.8-flash" },
  startedAt: 2000,
  participants: 2,
  relayConnected: true,
  inputRequired: true,
  busy: false,
  access: "view",
};

const sampleHost3: CliHost = {
  instanceId: "inst-3",
  generation: 1,
  pid: 103,
  sessionId: "sess-3",
  sessionName: null,
  cwd: "/tmp/working-task",
  model: { provider: "deepseek", id: "deepseek-r1" },
  startedAt: 1500,
  participants: 1,
  relayConnected: true,
  inputRequired: false,
  busy: true,
  access: "control",
};

describe("deriveFolder and toHostCard", () => {
  it("extracts basename correctly", () => {
    expect(deriveFolder("/Users/you/dev/755orion-web")).toBe("755orion-web");
    expect(deriveFolder("/Users/you/dev/755orion-web/")).toBe("755orion-web");
    expect(deriveFolder("/")).toBe("root");
  });

  it("converts CliHost to HostCard without leaking pid", () => {
    const card = toHostCard(sampleHost1, MAP, false, []);
    expect(card.folder).toBe("755orion-web");
    expect(card.project).toBe("orion");
    expect(card.model).toBe("anthropic/claude-3-7-sonnet");
    expect("pid" in card).toBe(false);
  });

  it("gives the card the project of its folder, none outside the root", () => {
    expect(toHostCard(sampleHost2, MAP, false, []).project).toBe("dev");
    expect(toHostCard(sampleHost3, MAP, false, []).project).toBeNull();
  });
});

describe("sortHosts", () => {
  it("prioritizes inputRequired > busy === true > idle/unknown > newest startedAt", () => {
    const cards = [toHostCard(sampleHost1, MAP, false, []), toHostCard(sampleHost2, MAP, false, []), toHostCard(sampleHost3, MAP, false, [])];
    const sorted = sortHosts(cards);

    // sampleHost2 has inputRequired: true -> first
    expect(sorted[0].instanceId).toBe("inst-2");
    // sampleHost3 has busy: true -> second
    expect(sorted[1].instanceId).toBe("inst-3");
    // sampleHost1 is idle -> third
    expect(sorted[2].instanceId).toBe("inst-1");
  });

  it("retains busy: null as distinct from false and sorts newest first when both idle", () => {
    const olderIdle = toHostCard({ ...sampleHost1, instanceId: "older", startedAt: 500, busy: false }, MAP, false, []);
    const newerUnknown = toHostCard({ ...sampleHost1, instanceId: "newer", startedAt: 900, busy: null }, MAP, false, []);
    const sorted = sortHosts([olderIdle, newerUnknown]);

    expect(sorted[0].instanceId).toBe("newer");
    expect(sorted[0].busy).toBeNull();
    expect(sorted[1].instanceId).toBe("older");
    expect(sorted[1].busy).toBe(false);
  });
});

describe("parseCliList and parseCliLink", () => {
  it("parses valid CLI list output", () => {
    const raw = JSON.stringify({ version: 1, hosts: [sampleHost1] });
    const res = parseCliList(raw);
    expect(res).not.toBeNull();
    expect(res?.hosts.length).toBe(1);
  });

  it("rejects non-version 1 list output", () => {
    const raw = JSON.stringify({ version: 2, hosts: [sampleHost1] });
    expect(parseCliList(raw)).toBeNull();
  });

  it("parses valid CLI link output", () => {
    const raw = JSON.stringify({
      version: 1,
      instanceId: "inst-1",
      generation: 1,
      access: "control",
      url: "https://my.omp.sh/#key-payload",
    });
    const res = parseCliLink(raw);
    expect(res).not.toBeNull();
    expect(res?.url).toBe("https://my.omp.sh/#key-payload");
  });

  it("rejects invalid link json", () => {
    expect(parseCliLink("not-json")).toBeNull();
    expect(parseCliLink(JSON.stringify({ version: 2 }))).toBeNull();
  });
});

describe("validateLinkRequest", () => {
  it("accepts valid view and control requests", () => {
    const v = validateLinkRequest({ instanceId: "inst-1", generation: 1, access: "view" });
    expect(v.error).toBeUndefined();
    expect(v.req?.access).toBe("view");

    const c = validateLinkRequest({ instanceId: "inst-1", generation: 2, access: "control" });
    expect(c.error).toBeUndefined();
    expect(c.req?.access).toBe("control");
  });

  it("rejects missing or invalid fields", () => {
    expect(validateLinkRequest(null).error).toBeDefined();
    expect(validateLinkRequest({ instanceId: "", generation: 1, access: "view" }).error).toBeDefined();
    expect(validateLinkRequest({ instanceId: "i", generation: 0, access: "view" }).error).toBeDefined();
    expect(validateLinkRequest({ instanceId: "i", generation: 1, access: "invalid" }).error).toBeDefined();
  });
});

describe("checkAuth", () => {
  const allowed = ["you@example.com"];

  it("authorizes any listed login regardless of case", () => {
    expect(checkAuth("you@example.com", allowed).authorized).toBe(true);
    expect(checkAuth("You@Example.Com", allowed).authorized).toBe(true);
    expect(checkAuth("Second@Example.com", ["first@example.com", "second@example.com"]).authorized).toBe(true);
  });

  it("rejects missing header or non-matching login", () => {
    expect(checkAuth(null, allowed).authorized).toBe(false);
    expect(checkAuth("other@example.com", allowed).authorized).toBe(false);
  });
});

describe("preCheckLink and postCheckLink", () => {
  const hosts = [sampleHost1, sampleHost2];

  it("returns 404 for missing host", () => {
    const res = preCheckLink({ instanceId: "missing", generation: 1, access: "view" }, hosts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.decision.status).toBe(404);
  });

  it("returns 409 for generation mismatch before CLI invocation", () => {
    const res = preCheckLink({ instanceId: "inst-1", generation: 99, access: "control" }, hosts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.decision.status).toBe(409);
  });

  it("returns 403 when requesting control on a view-only host", () => {
    const res = preCheckLink({ instanceId: "inst-2", generation: 2, access: "control" }, hosts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.decision.status).toBe(403);
  });

  it("passes pre-check for valid request", () => {
    const res = preCheckLink({ instanceId: "inst-1", generation: 1, access: "control" }, hosts);
    expect(res.ok).toBe(true);
  });

  it("postCheckLink catches race where session switched during link creation", () => {
    const rotatedCliLink = {
      version: 1,
      instanceId: "inst-1",
      generation: 2, // switched to 2 while we requested 1
      access: "control" as const,
      url: "https://my.omp.sh/#stale",
    };
    const res = postCheckLink({ instanceId: "inst-1", generation: 1, access: "control" }, rotatedCliLink);
    expect(res.status).toBe(409);
    expect("url" in res).toBe(false);
  });

  it("postCheckLink returns 200 with URL when generation matches", () => {
    const okCliLink = {
      version: 1,
      instanceId: "inst-1",
      generation: 1,
      access: "control" as const,
      url: "https://my.omp.sh/#live",
    };
    const res = postCheckLink({ instanceId: "inst-1", generation: 1, access: "control" }, okCliLink);
    expect(res.status).toBe(200);
    if (res.status === 200) expect(res.url).toBe("https://my.omp.sh/#live");
  });
});
