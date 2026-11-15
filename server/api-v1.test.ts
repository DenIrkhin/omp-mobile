// The v1 contract: the routes build these replies with api.ts and the iOS app decodes the same
// files, so each reply must equal its fixture in api/v1/fixtures/, and each request fixture must
// pass its route's validator.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { deviceBody, errorBody, hostsBody, infoBody, launchedBody, launchOptionsBody, linkBody, pinBody } from "./api";
import { type CliHost, checkAuth, postCheckLink, preCheckLink, validateLinkRequest } from "./hosts";
import { type LaunchModel, validateLaunchRequest } from "./launch";
import { type LongTask, validatePinRequest, validateReopenRequest } from "./long-tasks";
import type { ProjectMap } from "./projects";
import { validateDeviceRequest } from "./push-devices";
import { apnsPayload } from "./push-events";
import type { JobReport } from "./reports";

const FIXTURES = join(import.meta.dir, "..", "api", "v1", "fixtures");

// Typed any: toEqual's overloads reject an unknown expected value, and a fixture is checked by value.
async function fixture(name: string): Promise<any> {
  return JSON.parse(await Bun.file(join(FIXTURES, `${name}.json`)).text());
}

const MAP: ProjectMap = {
  root: "/Users/you/dev",
  otherName: "dev",
  list: [
    { name: "orion", families: ["orion-web"] },
    { name: "vega", families: ["vega"] },
  ],
};

const ALPHA: CliHost = {
  instanceId: "inst-alpha",
  generation: 3,
  pid: 4242,
  sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a01",
  sessionName: "release notes",
  cwd: "/Users/you/dev/751orion-web",
  model: { provider: "anthropic", id: "claude-sonnet-4-5" },
  startedAt: 1762990000000,
  participants: 1,
  relayConnected: true,
  inputRequired: false,
  busy: true,
  access: "control",
};

const BRAVO: CliHost = {
  instanceId: "inst-bravo",
  generation: 1,
  pid: 4343,
  sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a02",
  sessionName: null,
  cwd: "/Users/you/dev/795vega",
  model: { provider: "openai", id: "gpt-5" },
  startedAt: 1762993000000,
  participants: 2,
  relayConnected: true,
  inputRequired: true,
  busy: false,
  access: "view",
};

const DIGEST: JobReport = {
  id: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b01",
  job: "digest",
  outcome: "update",
  summary: "3 new items",
  details: null,
  at: "2026-11-12T08:00:00.000Z",
};

const ALPHA_TASK: LongTask = {
  sessionId: ALPHA.sessionId,
  title: "release notes",
  cwd: ALPHA.cwd,
  folder: "751orion-web",
  project: "orion",
  profile: "work",
  lastActiveAt: 1762995000000,
  reports: [DIGEST],
};

const CLOSED_TASK: LongTask = {
  sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a03",
  title: "nightly build",
  cwd: "/Users/you/dev/724atlas-nightly",
  folder: "724atlas-nightly",
  project: "dev",
  profile: null,
  lastActiveAt: 1762900000000,
  reports: [],
};

const FETCHED_AT = 1762995600000;
const LINK_URL = "https://my.omp.sh/#test-room-0000000001.test_key-0000000000000000000000000000000001";
const FOLDERS = ["/Users/you/dev", "/Users/you/dev/751orion-web", "/Users/you/dev/795vega"];
const MODELS: Record<string, LaunchModel> = {
  default: { label: "Profile default", model: null, thinking: null },
  fast: { label: "Fast", model: "example/fast-1", thinking: "low" },
};

describe("api/v1 fixtures", () => {
  it("info: the versions, who asks, the main profile and the module switches", async () => {
    const body = infoBody(
      {
        longTasks: { enabled: true },
        launch: { enabled: false, profile: "work" },
        control: { enabled: false, devCycles: false, ownerOnlyWords: [] },
        reports: { enabled: false },
        pageCopy: { publicUrl: "https://mac.example.ts.net:8443/" },
        push: null,
      },
      { login: "you@example.com", deviceName: "iphone", serverVersion: "0.1.0", ompVersion: "18.4.10" },
    );
    expect(body).toEqual(await fixture("info"));
  });

  it("info with push on: the app's bundle id and each environment that has a key", () => {
    const body = infoBody(
      {
        longTasks: { enabled: true },
        launch: { enabled: false, profile: null },
        control: { enabled: false, devCycles: false, ownerOnlyWords: [] },
        reports: { enabled: false },
        pageCopy: { publicUrl: null },
        push: {
          bundleId: "io.github.you.ompmobile",
          teamId: "TEAM000001",
          keys: { sandbox: null, production: { keyId: "KEY0000001", path: "/keys/AuthKey_KEY0000001.p8" } },
          pollSeconds: 5,
          includeSummary: true,
        },
      },
      { login: "you@example.com", deviceName: null, serverVersion: "0.1.0", ompVersion: null },
    );
    expect([body.features.push, body.push]).toEqual([true, { bundleId: "io.github.you.ompmobile", environments: ["production"] }]);
  });

  it("hosts: chats that need input first, pins with their reports, long tasks, the project order", async () => {
    const pins = {
      pinnedIds: new Set([ALPHA.sessionId, CLOSED_TASK.sessionId]),
      longTasks: [ALPHA_TASK, CLOSED_TASK],
      reports: new Map([[ALPHA.sessionId, [DIGEST]]]),
    };
    expect(hostsBody(FETCHED_AT, [ALPHA, BRAVO], MAP, pins, { ok: true })).toEqual(await fixture("hosts"));
  });

  it("hosts-empty: no chats, no long tasks, the page copy off", async () => {
    const pins = { pinnedIds: new Set<string>(), longTasks: [], reports: new Map<string, JobReport[]>() };
    expect(hostsBody(FETCHED_AT, [], MAP, pins, null)).toEqual(await fixture("hosts-empty"));
  });

  it("link: the request passes both link checks, and the reply is the link", async () => {
    const link = validateLinkRequest(await fixture("link-request"));
    if (!link.req) throw new Error(link.error);
    expect(preCheckLink(link.req, [ALPHA, BRAVO]).ok).toBe(true);
    const decision = postCheckLink(link.req, {
      version: 1,
      instanceId: ALPHA.instanceId,
      generation: ALPHA.generation,
      access: ALPHA.access,
      url: LINK_URL,
    });
    if (decision.status !== 200) throw new Error(decision.error);
    expect(linkBody(decision.url)).toEqual(await fixture("link"));
  });

  it("error-409: a link for a chat whose generation changed", async () => {
    const link = validateLinkRequest(await fixture("link-request"));
    if (!link.req) throw new Error(link.error);
    const pre = preCheckLink(link.req, [{ ...ALPHA, generation: 4 }]);
    if (pre.ok) throw new Error("the link check passed");
    expect(pre.decision.status).toBe(409);
    expect(errorBody(pre.decision.error)).toEqual(await fixture("error-409"));
  });

  it("error-403: a login the server does not allow", async () => {
    const auth = checkAuth("someone@example.com", ["you@example.com"]);
    expect(auth.authorized).toBe(false);
    expect(errorBody(auth.reason || "Unauthorized")).toEqual(await fixture("error-403"));
  });

  it("pin: the request passes the validator, and the reply repeats it", async () => {
    const pin = validatePinRequest(await fixture("pin-request"));
    if (!pin.req) throw new Error(pin.error);
    expect(pinBody(pin.req)).toEqual(await fixture("pin"));
  });

  it("reopen: the request passes the validator; a chat that already runs is a 409 with code running", async () => {
    expect(validateReopenRequest(await fixture("reopen-request")).error).toBeUndefined();
    expect(errorBody("This session is already running", "running")).toEqual(await fixture("reopen-409"));
  });

  it("launch-options: the folders, each model choice by id and label, and the default", async () => {
    expect(launchOptionsBody(FOLDERS, MODELS, "default")).toEqual(await fixture("launch-options"));
  });

  it("sessions: a request built from launch-options passes the validator; 201 names the new chat", async () => {
    expect(validateLaunchRequest(await fixture("sessions-request"), FOLDERS, MODELS, "default").error).toBeUndefined();
    expect(launchedBody({ ...ALPHA, instanceId: "inst-charlie", generation: 1 }, "workspace:12")).toEqual(
      await fixture("sessions-201"),
    );
  });

  it("devices: the request passes the validator; the reply names the device and its events", async () => {
    const push = {
      bundleId: "io.github.you.ompmobile",
      keys: { sandbox: { keyId: "KEY0000001", path: "/keys/AuthKey_KEY0000001.p8" }, production: null },
    };
    const registration = validateDeviceRequest(await fixture("devices-request"), push);
    if (!registration.req) throw new Error(registration.error);
    const device = {
      ...registration.req,
      login: "you@example.com",
      deviceName: "iphone",
      registeredAt: "2026-11-14T08:00:00.000Z",
      lastSeenAt: "2026-11-14T09:30:00.000Z",
    };
    expect(deviceBody(device)).toEqual(await fixture("devices"));
  });

  const PUSH_CHAT = { sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a01", instanceId: "inst-alpha", generation: 3, title: "release notes", folder: "751orion-web" };

  it("push-input: the notification for a chat that starts to need input", async () => {
    expect(apnsPayload({ kind: "input", ...PUSH_CHAT }, true)).toEqual(await fixture("push-input"));
  });

  it("push-report: a failed job report shows the first line of its summary", async () => {
    const report = {
      v: 1 as const,
      id: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b02",
      job: "backup",
      outcome: "failed" as const,
      summary: "Disk full: 2 of 40 folders copied\nThe rest waits for the next run.",
      details: null,
      at: "2026-11-12T03:04:00.000Z",
    };
    const event = { kind: "reportFailed" as const, sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a03", title: "nightly build", report };
    expect(apnsPayload(event, true)).toEqual(await fixture("push-report"));
  });

  it("push-turn-done: the notification for a pinned chat that finished a long turn", async () => {
    expect(apnsPayload({ kind: "turnDone", ...PUSH_CHAT }, true)).toEqual(await fixture("push-turn-done"));
  });
});
