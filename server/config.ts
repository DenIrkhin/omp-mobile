// The server's settings, read from one JSON file: $OMP_MOBILE_CONFIG, else
// ~/.config/omp-mobile/config.json; server/config.example.json shows every key. The server needs
// the file. The CLIs (report.ts, build-collab.ts, `bun cmux-groups.ts`) read the same file but run
// on the defaults without one. reports.ts, agent-dirs.ts and long-tasks.ts must not import this
// module: the control extension imports them into omp's own process.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { THINKING_LEVELS } from "./control";
import type { LaunchModel } from "./launch";
import type { ProjectMap } from "./projects";
import type { PushEnvironment, PushKey } from "./push-apns";

export type Config = {
  /** The https origin `tailscale serve` publishes the dashboard at; POSTs from other origins are refused. */
  publicUrl: string;
  /** Tailscale logins that may use the dashboard, compared without regard to case. */
  allowedLogins: string[];
  /** The dashboard's port on 127.0.0.1. */
  port: number;
  omp: { bin: string; configRoot: string };
  /** For the device names Collab guests get; null: no names. */
  tailscaleBin: string | null;
  projects: ProjectMap;
  /** publicUrl null turns the page copy off: no listener, no rebuilds, links open at my.omp.sh. */
  pageCopy: { publicUrl: string | null; port: number };
  longTasks: { enabled: boolean };
  launch: {
    enabled: boolean;
    cmuxBin: string;
    /** The omp profile new sessions run under; null leaves omp's default. */
    profile: string | null;
    /** The model choices of New session and Manage, by the id the page sends back. */
    models: Record<string, LaunchModel>;
    defaultModel: string;
  };
  /** ownerOnlyWords: a question whose title holds one, ignoring case, is the owner's to answer (collab-guest.ts ownerOnlyTitle). */
  control: { enabled: boolean; devCycles: boolean; ownerOnlyWords: string[] };
  reports: { enabled: boolean };
  cmuxGroups: { enabled: boolean };
  /** dir: the local API socket's folder. */
  localApi: { enabled: boolean; dir: string };
  /** Push notifications through APNs (push-apns.ts); null: off. pollSeconds: how often the chats are checked; includeSummary: report pushes show the summary's first line. */
  push: { bundleId: string; teamId: string; keys: Record<PushEnvironment, PushKey | null>; pollSeconds: number; includeSummary: boolean } | null;
  /** The folder of the server's own files: devices.json and push-state.json while push is on. */
  stateDir: string;
};

export type LoadOptions = {
  /** The file to read; default $OMP_MOBILE_CONFIG, else ~/.config/omp-mobile/config.json. */
  path?: string;
  /**
   * True (the default) for the server: the file must exist and set publicUrl and allowedLogins.
   * False for the CLIs: a missing file means the defaults, and those two keys may be left out.
   */
  requireServer?: boolean;
};

/** Every problem found in a config file, one per line of the message. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULT_TAILSCALE_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const DEFAULT_CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
// launch.ts types the profile, the model and the thinking level into a shell, so only these
// characters get through (the thinking level must be one of THINKING_LEVELS).
const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;
const MODEL_NAME = /^[A-Za-z0-9._:/@-]+$/;
// The id the page sends back for a model choice.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Apple's team ids and APNs key ids are 10 capital letters or digits; a bundle id is reverse DNS.
const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const DEFAULT_STATE_DIR = "~/.config/omp-mobile/state";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `~` or `~/…` → the home folder; any other path stays as it is. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** `value` as an https URL without credentials, query or fragment; else null. */
function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : null;
}

/** Checks every key of `raw` and fills in the defaults; throws one ConfigError naming every problem. */
function readConfig(raw: Json, file: string, requireServer: boolean): Config {
  const problems: string[] = [];
  const problem = (key: string, text: string): void => {
    problems.push(`${file}: "${key}" ${text}`);
  };
  const unknownKeys = (obj: Json, prefix: string, known: readonly string[]): void => {
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) problems.push(`${file}: unknown key "${prefix}${key}"`);
    }
  };
  /** The top-level object `key`: {} when it is absent or not an object; its unknown keys are reported. */
  const section = (key: string, known: readonly string[]): Json => {
    const value = raw[key];
    if (value === undefined) return {};
    if (!isObject(value)) {
      problem(key, "must be an object");
      return {};
    }
    unknownKeys(value, `${key}.`, known);
    return value;
  };
  const text = (obj: Json, key: string, path: string, fallback: string): string => {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value === "string" && value.trim() !== "") return value;
    problem(path, "must be a non-empty string");
    return fallback;
  };
  const textOrNull = (obj: Json, key: string, path: string, fallback: string | null): string | null => {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (value === null) return null;
    if (typeof value === "string" && value.trim() !== "") return value;
    problem(path, "must be a non-empty string or null");
    return fallback;
  };
  const flag = (obj: Json, key: string, path: string, fallback: boolean): boolean => {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    problem(path, "must be true or false");
    return fallback;
  };
  const portNumber = (obj: Json, key: string, path: string, fallback: number): number => {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value;
    problem(path, "must be an integer from 1 to 65535");
    return fallback;
  };

  unknownKeys(raw, "", [
    "publicUrl",
    "allowedLogins",
    "port",
    "omp",
    "tailscaleBin",
    "projects",
    "pageCopy",
    "longTasks",
    "launch",
    "control",
    "reports",
    "cmuxGroups",
    "localApi",
    "push",
    "stateDir",
  ]);

  let publicUrl = "";
  if (raw.publicUrl === undefined) {
    if (requireServer) problem("publicUrl", "is required");
  } else {
    const url = httpsUrl(raw.publicUrl);
    if (url === null || url.pathname !== "/") {
      problem("publicUrl", "must be an https URL without a path, such as https://your-mac.your-tailnet.ts.net");
    } else {
      publicUrl = url.origin;
    }
  }

  let allowedLogins: string[] = [];
  const logins = raw.allowedLogins;
  if (logins === undefined) {
    if (requireServer) problem("allowedLogins", "is required");
  } else if (Array.isArray(logins) && logins.length > 0 && logins.every((login) => typeof login === "string" && login.trim() !== "")) {
    allowedLogins = logins.map((login: string) => login.trim());
  } else {
    problem("allowedLogins", "must be a non-empty list of logins");
  }

  const port = portNumber(raw, "port", "port", 7478);

  const omp = section("omp", ["bin", "configRoot"]);
  const ompBin = expandHome(text(omp, "bin", "omp.bin", "~/.bun/bin/omp"));
  const configRoot = expandHome(text(omp, "configRoot", "omp.configRoot", "~/.omp"));

  const tailscale = textOrNull(raw, "tailscaleBin", "tailscaleBin", DEFAULT_TAILSCALE_BIN);

  const projects = section("projects", ["root", "otherName", "list"]);
  const root = expandHome(text(projects, "root", "projects.root", "~"));
  if (!isAbsolute(root)) problem("projects.root", "must be an absolute path or start with ~");
  const otherName = textOrNull(projects, "otherName", "projects.otherName", null) ?? basename(root);
  const list: ProjectMap["list"] = [];
  const rawList = projects.list;
  if (rawList !== undefined) {
    if (!Array.isArray(rawList)) {
      problem("projects.list", "must be a list");
    } else {
      rawList.forEach((item: unknown, i: number) => {
        const path = `projects.list[${i}]`;
        if (!isObject(item)) {
          problem(path, "must be an object");
          return;
        }
        unknownKeys(item, `${path}.`, ["name", "families"]);
        const { name, families } = item;
        if (typeof name !== "string" || name.trim() === "") {
          problem(`${path}.name`, "must be a non-empty string");
        } else if (name === otherName || list.some((project) => project.name === name)) {
          problem(`${path}.name`, "is already a project name");
        } else if (!Array.isArray(families) || !families.every((family) => typeof family === "string" && family.trim() !== "")) {
          problem(`${path}.families`, "must be a list of folder names");
        } else {
          list.push({ name, families: families as string[] });
        }
      });
    }
  }

  const pageCopy = section("pageCopy", ["publicUrl", "port"]);
  let pageCopyUrl: string | null = null;
  if (pageCopy.publicUrl !== undefined && pageCopy.publicUrl !== null) {
    const url = httpsUrl(pageCopy.publicUrl);
    if (url === null) problem("pageCopy.publicUrl", "must be an https URL without ? or #, or null");
    else pageCopyUrl = url.href;
  }
  const pageCopyPort = portNumber(pageCopy, "port", "pageCopy.port", 7479);
  if (pageCopyUrl !== null && pageCopyPort === port) problem("pageCopy.port", 'must differ from "port"');

  const longTasks = section("longTasks", ["enabled"]);

  const launch = section("launch", ["enabled", "cmuxBin", "profile", "models", "defaultModel"]);
  const profile = textOrNull(launch, "profile", "launch.profile", null);
  if (profile !== null && !PROFILE_NAME.test(profile)) problem("launch.profile", "may hold only letters, digits and ._-");
  let models: Record<string, LaunchModel> = { default: { label: "Profile default", model: null, thinking: null } };
  const rawModels = launch.models;
  if (rawModels !== undefined) {
    if (!isObject(rawModels) || Object.keys(rawModels).length === 0) {
      problem("launch.models", "must be an object with at least one model");
    } else {
      const entries: [string, LaunchModel][] = [];
      for (const [id, entry] of Object.entries(rawModels)) {
        const path = `launch.models.${id}`;
        if (!MODEL_ID.test(id)) {
          problem(path, "needs an id of letters, digits and ._- that starts with a letter or digit");
          continue;
        }
        if (!isObject(entry)) {
          problem(path, "must be an object");
          continue;
        }
        unknownKeys(entry, `${path}.`, ["label", "model", "thinking"]);
        const label = entry.label;
        if (typeof label !== "string" || label.trim() === "") problem(`${path}.label`, "must be a non-empty string");
        const model = textOrNull(entry, "model", `${path}.model`, null);
        if (model !== null && !MODEL_NAME.test(model)) problem(`${path}.model`, "may hold only letters, digits and ._:/@-");
        const thinking = textOrNull(entry, "thinking", `${path}.thinking`, null);
        if (thinking !== null && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
          problem(`${path}.thinking`, `must be one of ${THINKING_LEVELS.join(", ")}, or null`);
        }
        entries.push([id, { label: typeof label === "string" ? label : id, model, thinking }]);
      }
      models = Object.fromEntries(entries);
    }
  }
  const defaultModel = text(launch, "defaultModel", "launch.defaultModel", Object.keys(models)[0] ?? "default");
  if (!Object.hasOwn(models, defaultModel)) problem("launch.defaultModel", 'must be one of the ids in "launch.models"');

  const control = section("control", ["enabled", "devCycles", "ownerOnlyWords"]);
  let ownerOnlyWords: string[] = [];
  const rawWords = control.ownerOnlyWords;
  if (rawWords !== undefined) {
    if (Array.isArray(rawWords) && rawWords.length <= 100 && rawWords.every((word) => typeof word === "string" && word.trim() !== "")) {
      ownerOnlyWords = rawWords as string[];
    } else {
      problem("control.ownerOnlyWords", "must be a list of at most 100 non-empty strings");
    }
  }
  const reports = section("reports", ["enabled"]);
  const cmuxGroups = section("cmuxGroups", ["enabled"]);
  const localApi = section("localApi", ["enabled", "dir"]);
  const localApiDir = textOrNull(localApi, "dir", "localApi.dir", null);

  const push = section("push", ["enabled", "bundleId", "teamId", "keys", "pollSeconds", "includeSummary"]);
  const pushOn = flag(push, "enabled", "push.enabled", false);
  const bundleId = textOrNull(push, "bundleId", "push.bundleId", null);
  if (bundleId !== null && !BUNDLE_ID.test(bundleId)) problem("push.bundleId", "must be an app bundle id such as io.github.you.ompmobile");
  const teamId = textOrNull(push, "teamId", "push.teamId", null);
  if (teamId !== null && !APPLE_ID.test(teamId)) {
    problem("push.teamId", "must be the 10-letter-or-digit team id from the Apple Developer account");
  }
  const pushKeys: Record<PushEnvironment, PushKey | null> = { sandbox: null, production: null };
  let keysGiven = 0;
  const rawKeys = push.keys;
  if (rawKeys !== undefined) {
    if (!isObject(rawKeys)) {
      problem("push.keys", "must be an object");
    } else {
      unknownKeys(rawKeys, "push.keys.", ["sandbox", "production"]);
      for (const env of ["sandbox", "production"] as const) {
        const entry = rawKeys[env];
        const path = `push.keys.${env}`;
        if (entry === undefined || entry === null) continue;
        keysGiven++;
        if (!isObject(entry)) {
          problem(path, "must be an object or null");
          continue;
        }
        unknownKeys(entry, `${path}.`, ["keyId", "path"]);
        const { keyId, path: keyFile } = entry;
        const keyPath = typeof keyFile === "string" && keyFile.trim() !== "" ? expandHome(keyFile) : "";
        const goodId = typeof keyId === "string" && APPLE_ID.test(keyId);
        if (!goodId) problem(`${path}.keyId`, "must be the 10-letter-or-digit key id of the APNs key");
        if (!isAbsolute(keyPath)) problem(`${path}.path`, "must be the .p8 file's absolute path or start with ~");
        if (goodId && isAbsolute(keyPath)) pushKeys[env] = { keyId: keyId as string, path: keyPath };
      }
    }
  }
  let pollSeconds = 5;
  if (push.pollSeconds !== undefined) {
    const value = push.pollSeconds;
    if (typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 60) pollSeconds = value;
    else problem("push.pollSeconds", "must be an integer from 2 to 60");
  }
  const includeSummary = flag(push, "includeSummary", "push.includeSummary", true);
  if (pushOn) {
    if (bundleId === null) problem("push.bundleId", "is required when push is on");
    if (teamId === null) problem("push.teamId", "is required when push is on");
    if (keysGiven === 0) problem("push.keys", "needs a sandbox or a production key when push is on");
  }

  const stateDir = expandHome(text(raw, "stateDir", "stateDir", DEFAULT_STATE_DIR));
  if (!isAbsolute(stateDir)) problem("stateDir", "must be an absolute path or start with ~");

  const config: Config = {
    publicUrl,
    allowedLogins,
    port,
    omp: { bin: ompBin, configRoot },
    tailscaleBin: tailscale === null ? null : expandHome(tailscale),
    projects: { root, otherName, list },
    pageCopy: { publicUrl: pageCopyUrl, port: pageCopyPort },
    longTasks: { enabled: flag(longTasks, "enabled", "longTasks.enabled", true) },
    launch: {
      enabled: flag(launch, "enabled", "launch.enabled", false),
      cmuxBin: expandHome(text(launch, "cmuxBin", "launch.cmuxBin", DEFAULT_CMUX_BIN)),
      profile,
      models,
      defaultModel,
    },
    control: {
      enabled: flag(control, "enabled", "control.enabled", false),
      devCycles: flag(control, "devCycles", "control.devCycles", false),
      ownerOnlyWords,
    },
    reports: { enabled: flag(reports, "enabled", "reports.enabled", false) },
    cmuxGroups: { enabled: flag(cmuxGroups, "enabled", "cmuxGroups.enabled", false) },
    localApi: {
      enabled: flag(localApi, "enabled", "localApi.enabled", false),
      dir: localApiDir === null ? join(configRoot, "run", "omp-sessions-api") : expandHome(localApiDir),
    },
    push: pushOn && bundleId !== null && teamId !== null ? { bundleId, teamId, keys: pushKeys, pollSeconds, includeSummary } : null,
    stateDir,
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Reads and checks the config file; throws a ConfigError that names every problem. */
export function loadConfig(opts: LoadOptions = {}): Config {
  const file = opts.path ?? (process.env.OMP_MOBILE_CONFIG || join(homedir(), ".config", "omp-mobile", "config.json"));
  const requireServer = opts.requireServer ?? true;
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError([`cannot read config file ${file}: ${err instanceof Error ? err.message : String(err)}`]);
    }
    if (requireServer) throw new ConfigError([`config file not found: ${file} (copy server/config.example.json)`]);
    return readConfig({}, file, false);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    throw new ConfigError([`config file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  if (!isObject(raw)) throw new ConfigError([`config file ${file} must hold a JSON object`]);
  return readConfig(raw, file, requireServer);
}

/** loadConfig for an entry point: on a ConfigError it prints the problems to stderr and exits 1. */
export function loadConfigOrExit(opts: LoadOptions = {}): Config {
  try {
    return loadConfig(opts);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}
