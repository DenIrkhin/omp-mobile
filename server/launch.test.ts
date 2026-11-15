import { describe, expect, it } from "bun:test";
import type { CliHost } from "./hosts";
import { findLaunchedHost, type LaunchModel, launchCommand, parseWorkspaceRef, validateLaunchRequest } from "./launch";

const folders = ["/Users/you/dev", "/Users/you/dev/757orion-web", "/Users/you/dev/795vega"];
const MODELS: Record<string, LaunchModel> = {
  "opus-5.5-xhigh": { label: "Claude Opus 5.5 · xhigh", model: "anthropic/claude-opus-5-5", thinking: "xhigh" },
  "sonnet-5.5-medium": { label: "Claude Sonnet 5.5 · medium", model: "anthropic/claude-sonnet-5-5", thinking: "medium" },
};

function host(instanceId: string, cwd: string, startedAt: number): CliHost {
  return {
    instanceId,
    generation: 1,
    pid: 1,
    sessionId: `sess-${instanceId}`,
    sessionName: null,
    cwd,
    model: { provider: "anthropic", id: "claude" },
    startedAt,
    participants: 1,
    relayConnected: true,
    inputRequired: false,
    busy: false,
    access: "control",
  };
}

describe("validateLaunchRequest", () => {
  it("uses Sonnet 5.5 on medium when no model is sent", () => {
    expect(validateLaunchRequest({ folder: "/Users/you/dev/795vega" }, folders, MODELS, "sonnet-5.5-medium")).toEqual({
      req: { folder: "/Users/you/dev/795vega", model: MODELS["sonnet-5.5-medium"] },
    });
  });

  it("accepts the Opus choice", () => {
    expect(validateLaunchRequest({ folder: "/Users/you/dev", model: "opus-5.5-xhigh" }, folders, MODELS, "sonnet-5.5-medium").req?.model).toEqual({
      label: "Claude Opus 5.5 · xhigh",
      model: "anthropic/claude-opus-5-5",
      thinking: "xhigh",
    });
  });

  it("rejects folders outside the offered list, including traversal and prefix tricks", () => {
    for (const folder of ["/Users/you/dev/../../../etc", "/Users/you/dev/795vega/", "/Users/you/dev/795vega-evil", "/tmp"]) {
      expect(validateLaunchRequest({ folder }, folders, MODELS, "sonnet-5.5-medium").error).toBe("Folder is not in the allowed list");
    }
  });

  it("rejects anything but the two choice ids, including raw selectors and prototype keys", () => {
    for (const model of ["anthropic/claude-opus-5-5", "opus-5.5-high", "", null, 42, "toString", "__proto__", "constructor"]) {
      expect(validateLaunchRequest({ folder: "/Users/you/dev", model }, folders, MODELS, "sonnet-5.5-medium").error).toBe("Model is not in the allowed list");
    }
  });

  it("rejects non-object bodies and non-string folders", () => {
    expect(validateLaunchRequest(null, folders, MODELS, "sonnet-5.5-medium").error).toBeDefined();
    expect(validateLaunchRequest({ folder: ["/Users/you/dev"] }, folders, MODELS, "sonnet-5.5-medium").error).toBeDefined();
  });
});

describe("launchCommand", () => {
  it("starts a fresh session on the chosen model and thinking level", () => {
    const overlay = new URL("./new-session.yml", import.meta.url).pathname;
    expect(launchCommand(MODELS["opus-5.5-xhigh"], undefined, "work")).toBe(
      `omp --profile=work --config=${overlay} --model=anthropic/claude-opus-5-5 --thinking=xhigh`
    );
  });

  it("leaves out the profile, model and thinking flags the config leaves null", () => {
    const overlay = new URL("./new-session.yml", import.meta.url).pathname;
    expect(launchCommand({ label: "Profile default", model: null, thinking: null }, 25, null)).toBe(
      `omp --config=${overlay} --max-cost=25`
    );
  });
});

describe("parseWorkspaceRef", () => {
  it("extracts the ref from cmux success output and rejects anything else", () => {
    expect(parseWorkspaceRef("OK workspace:32\n")).toBe("workspace:32");
    expect(parseWorkspaceRef("Error: socket not found")).toBeNull();
    expect(parseWorkspaceRef("")).toBeNull();
  });
});

describe("findLaunchedHost", () => {
  const folder = "/Users/you/dev/795vega";

  it("ignores sessions that were already running in the same folder", () => {
    const hosts = [host("old", folder, 5000)];
    expect(findLaunchedHost(hosts, new Set(["old"]), folder)).toBeNull();
  });

  it("ignores new sessions in other folders", () => {
    const hosts = [host("other", "/Users/you/dev/757orion-web", 9000)];
    expect(findLaunchedHost(hosts, new Set(), folder)).toBeNull();
  });

  it("picks the newest unseen session in the folder", () => {
    const hosts = [host("old", folder, 9999), host("a", folder, 6000), host("b", folder, 7000)];
    expect(findLaunchedHost(hosts, new Set(["old"]), folder)?.instanceId).toBe("b");
  });
});
