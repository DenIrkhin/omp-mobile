import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ConfigError, loadConfig } from "./config";

const DIR = mkdtempSync(join(tmpdir(), "config-test-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let files = 0;
/** Writes `body` as JSON to a new file in DIR and returns its path. */
function file(body: object): string {
  const path = join(DIR, `config-${files++}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const SERVER = { publicUrl: "https://mac.example.ts.net", allowedLogins: ["you@example.com"] };

/** The problems loadConfig reports for `path`; [] when it loads. */
function problems(path: string, requireServer = true): string[] {
  try {
    loadConfig({ path, requireServer });
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe("loadConfig", () => {
  it("fills what the file leaves out with defaults that keep every risky part off", () => {
    const config = loadConfig({ path: file(SERVER) });
    expect(config.port).toBe(7478);
    expect(config.omp).toEqual({ bin: join(homedir(), ".bun/bin/omp"), configRoot: join(homedir(), ".omp") });
    expect(config.projects).toEqual({ root: homedir(), otherName: basename(homedir()), list: [] });
    expect(config.pageCopy).toEqual({ publicUrl: null, port: 7479 });
    expect(config.longTasks.enabled).toBe(true);
    expect(config.launch.enabled).toBe(false);
    expect(config.launch.models).toEqual({ default: { label: "Profile default", model: null, thinking: null } });
    expect(config.launch.defaultModel).toBe("default");
    expect(config.control).toEqual({ enabled: false, devCycles: false, ownerOnlyWords: [] });
    expect(config.reports.enabled).toBe(false);
    expect(config.cmuxGroups.enabled).toBe(false);
    expect(config.localApi).toEqual({ enabled: false, dir: join(homedir(), ".omp", "run", "omp-sessions-api") });
    expect(config.push).toBeNull();
    expect(config.stateDir).toBe(join(homedir(), ".config", "omp-mobile", "state"));
  });

  it("expands ~ and names the other project after the root folder", () => {
    const config = loadConfig({ path: file({ ...SERVER, projects: { root: "~/dev", list: [{ name: "orion", families: ["orion-web"] }] } }) });
    expect(config.projects).toEqual({ root: join(homedir(), "dev"), otherName: "dev", list: [{ name: "orion", families: ["orion-web"] }] });
  });

  it("names every problem in one error", () => {
    const found = problems(
      file({
        ...SERVER,
        prot: 1,
        port: "7478",
        launch: { modle: {}, models: { fast: { label: "Fast", model: "vendor/fast", thinking: "low" } }, defaultModel: "slow" },
      }),
    );
    expect(found).toHaveLength(4);
    expect(found.some((p) => p.includes('unknown key "prot"'))).toBe(true);
    expect(found.some((p) => p.includes('unknown key "launch.modle"'))).toBe(true);
    expect(found.some((p) => p.includes('"port" must be an integer from 1 to 65535'))).toBe(true);
    expect(found.some((p) => p.includes('"launch.defaultModel" must be one of the ids'))).toBe(true);
  });

  it("requires publicUrl and allowedLogins for the server only", () => {
    const path = file({ port: 7490 });
    expect(problems(path)).toEqual([`${path}: "publicUrl" is required`, `${path}: "allowedLogins" is required`]);
    expect(loadConfig({ path, requireServer: false }).port).toBe(7490);
  });

  it("runs the CLIs on the defaults without a file and refuses to start the server", () => {
    const path = join(DIR, "missing.json");
    expect(loadConfig({ path, requireServer: false }).omp.configRoot).toBe(join(homedir(), ".omp"));
    expect(problems(path)).toEqual([`config file not found: ${path} (copy server/config.example.json)`]);
  });

  it("turns push on only with a bundle id, a team id and a key, and names each bad push key", () => {
    const on = loadConfig({
      path: file({
        ...SERVER,
        stateDir: "~/omp-state",
        push: {
          enabled: true,
          bundleId: "io.github.you.ompmobile",
          teamId: "TEAM000001",
          keys: { sandbox: { keyId: "KEY0000001", path: "~/keys/AuthKey_KEY0000001.p8" } },
        },
      }),
    });
    expect(on.push).toEqual({
      bundleId: "io.github.you.ompmobile",
      teamId: "TEAM000001",
      keys: { sandbox: { keyId: "KEY0000001", path: join(homedir(), "keys", "AuthKey_KEY0000001.p8") }, production: null },
      pollSeconds: 5,
      includeSummary: true,
    });
    expect(on.stateDir).toBe(join(homedir(), "omp-state"));

    const path = file({ ...SERVER, push: { enabled: true, teamId: "team", keys: { sandbox: { keyId: "KEY1", path: "AuthKey.p8" }, staging: null }, pollSeconds: 1, includeSummary: "yes" } });
    expect(problems(path)).toEqual([
      `${path}: "push.teamId" must be the 10-letter-or-digit team id from the Apple Developer account`,
      `${path}: unknown key "push.keys.staging"`,
      `${path}: "push.keys.sandbox.keyId" must be the 10-letter-or-digit key id of the APNs key`,
      `${path}: "push.keys.sandbox.path" must be the .p8 file's absolute path or start with ~`,
      `${path}: "push.pollSeconds" must be an integer from 2 to 60`,
      `${path}: "push.includeSummary" must be true or false`,
      `${path}: "push.bundleId" is required when push is on`,
    ]);
  });

  it("reads control.ownerOnlyWords as written, up to 100, and names a bad list", () => {
    const words = ["payments.example.com", "Alpha Billing"];
    expect(loadConfig({ path: file({ ...SERVER, control: { ownerOnlyWords: words } }) }).control.ownerOnlyWords).toEqual(words);
    const hundred = Array.from({ length: 100 }, (_, i) => `word-${i}`);
    expect(problems(file({ ...SERVER, control: { ownerOnlyWords: hundred } }))).toEqual([]);
    for (const ownerOnlyWords of ["payments.example.com", ["payments.example.com", " "], [7], [...hundred, "one-more"]]) {
      const path = file({ ...SERVER, control: { ownerOnlyWords } });
      expect(problems(path)).toEqual([`${path}: "control.ownerOnlyWords" must be a list of at most 100 non-empty strings`]);
    }
  });

  it("accepts the example file", () => {
    expect(problems(join(import.meta.dir, "config.example.json"))).toEqual([]);
  });
});
