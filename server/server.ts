import { watch } from "fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, join } from "path";
import { emptyIfMissing, isMissing, listAgentDirs, loadPinnedIds, readPins, writePin } from "./agent-dirs";
import {
  deviceBody,
  errorBody,
  hostsBody,
  infoBody,
  launchedBody,
  launchOptionsBody,
  linkBody,
  pinBody,
  pushTestBody,
  removedBody,
} from "./api";
import { CMUX_OMP_HOOK_STORE, GroupSync } from "./cmux-groups";
import {
  type CollabBuildInfo,
  collabCacheControl,
  collabCsp,
  machineNameFromWhois,
  type PageCopyState,
  pageCopyState,
  parseBuildInfo,
  parseOmpVersion,
  REBUILD_RETRY_MS,
  type RebuildAttempt,
  resolveCollabPath,
  rewriteCollabUrl,
  shouldRebuild,
} from "./collab-copy";
import { loadConfigOrExit } from "./config";
import { collabUiRelay, GUEST_DEADLINE_MS, handleControl } from "./control";
import {
  checkAuth,
  deriveFolder,
  parseCliLink,
  parseCliList,
  postCheckLink,
  preCheckLink,
  validateLinkRequest,
  type CliHost,
} from "./hosts";
import {
  findLaunchedHost,
  launchCommand,
  parseWorkspaceRef,
  validateLaunchRequest,
  workspaceName,
} from "./launch";
import type { LongTask, SessionHead, SessionLocation } from "./long-tasks";
import {
  parseSessionHead,
  reopenCommand,
  SESSION_HEAD_BYTES,
  SESSION_ID,
  sessionIdFromFileName,
  validatePinRequest,
  validateReopenRequest,
} from "./long-tasks";
import { projectOf } from "./projects";
import { ApnsClient, http2Transport, testMessage } from "./push-apns";
import { type Device, DeviceStore, validateDeviceRequest, validateTokenRequest } from "./push-devices";
import {
  apnsMessage,
  detectHostEvents,
  detectReportEvents,
  type HostSnap,
  type HostWatch,
  INPUT_COOLDOWN_MS,
  parsePushState,
  type PushEvent,
  type PushState,
  pushStateText,
  type ReportFile,
  reportWatermark,
  SEEN_MAX_AGE_MS,
} from "./push-events";
import { CARD_REPORTS, type JobReport, latestPerJob, readReportsTail, reportFile, reportsDir } from "./reports";
import { SERVER_VERSION } from "./version";

// Settings from the config file (config.ts); a missing or invalid file stops the server here.
const config = loadConfigOrExit();
const PORT = config.port;
// tailscale serve proxies to this address; the server never listens anywhere else.
const HOST = "127.0.0.1";
const OMP_BIN = config.omp.bin;
const PUBLIC_DIR = join(import.meta.dir, "public");
// The project map: New session offers its root and the folders directly inside it.
const PROJECT_MAP = config.projects;
const CMUX_BIN = config.launch.cmuxBin;
// cmux sidebar groups (cmux-groups.ts): a sync every GROUP_SYNC_MS, plus one GROUP_SYNC_SOON_MS
// after a pin change, a Reopen or a New session; only when cmuxGroups.enabled is true.
const GROUP_SYNC_MS = 15_000;
const GROUP_SYNC_SOON_MS = 1_000;
// A workspace in a long-task group whose last omp session is not pinned leaves it once it has
// run no chat this long, so a chat that restarts (`/omp-update`, a cmux restart) keeps its row.
const LONG_TASK_GRACE_MS = 60_000;
const LAUNCH_REGISTER_TIMEOUT_MS = 25_000;
// omp's config root (`~/.omp`): the default agent dir, the profiles, and the session leases.
const OMP_CONFIG_ROOT = config.omp.configRoot;
// A live omp process holds flock on `<sessionId>.lock` here for every session it writes.
const SESSION_OWNERS_DIR = join(OMP_CONFIG_ROOT, "run", "session-owners");
const LSOF_BIN = "/usr/sbin/lsof";
// Second listener for the dashboard's copy of the Collab page (build-collab.ts), published with
// `tailscale serve --https=8443`. Another port is another origin, so that page cannot call /api.
// A null public URL turns the page copy off: no listener, no rebuilds, links open at my.omp.sh.
const COLLAB_PORT = config.pageCopy.port;
const COLLAB_PUBLIC_URL = config.pageCopy.publicUrl;
const COLLAB_DIST = join(import.meta.dir, "collab-dist");
const OMP_VERSION_TTL_MS = 60_000;
const BUILD_SCRIPT = join(import.meta.dir, "build-collab.ts");
// A build normally takes a few seconds; this only stops a hung git or bun download.
const REBUILD_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_ORIGINS: Record<string, true> = {
  [config.publicUrl]: true,
  [`http://127.0.0.1:${PORT}`]: true,
  [`http://localhost:${PORT}`]: true,
};

const COMMON_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const JSON_API_HEADERS: Record<string, string> = {
  ...COMMON_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

// Bun closes a connection idle for 10 s by default; reading or answering a session's question
// first loads its whole transcript over Collab (control.ts `pending`, `answer`), which gives up
// at GUEST_DEADLINE_MS (150 s), before this. Bun's max is 255.
const CONTROL_IDLE_TIMEOUT_S = 180;

// Coalescing and caching for CLI list
let cachedHosts: { timestamp: number; hosts: CliHost[] } | null = null;
let inflightList: Promise<CliHost[]> | null = null;

async function executeProcess(args: string[], timeoutMs = 5000): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Ensure clean locale and standard path
      PATH: process.env.PATH || `/usr/bin:/bin:/usr/local/bin:${join(homedir(), ".bun", "bin")}`,
      CMUX_QUIET: "1",
    },
  });

  const timer = setTimeout(() => {
    try {
      proc.kill(9);
    } catch {}
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLiveHosts(bypassCache = false): Promise<CliHost[]> {
  const now = Date.now();
  if (!bypassCache && cachedHosts && now - cachedHosts.timestamp < 1000) {
    return cachedHosts.hosts;
  }

  if (inflightList) {
    return inflightList;
  }

  inflightList = (async () => {
    try {
      const { stdout, stderr, code } = await executeProcess([OMP_BIN, "collab", "list", "--json"]);
      if (code !== 0) {
        const errMsg = (stderr || stdout || `Process exited with code ${code}`).slice(0, 300);
        throw new Error(`CLI list failure: ${errMsg}`);
      }
      const parsed = parseCliList(stdout);
      if (!parsed) {
        throw new Error("CLI list returned unsupported format or version !== 1");
      }
      cachedHosts = { timestamp: Date.now(), hosts: parsed.hosts };
      return parsed.hosts;
    } finally {
      inflightList = null;
    }
  })();

  return inflightList;
}

async function fetchLink(instanceId: string, access: "view" | "control"): Promise<{ stdout: string; stderr: string; code: number }> {
  const args = [OMP_BIN, "collab", "link", instanceId];
  if (access === "view") {
    args.push("--view");
  }
  args.push("--json");
  return executeProcess(args, 6000);
}

const TAILSCALE_BIN = config.tailscaleBin;
// A tailnet address: IPv4 or IPv6, which is all `tailscale whois` gets as its argument.
const TAILNET_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:]{2,39})$/;
const DEVICE_NAME_TTL_MS = 10 * 60_000;
const deviceNames = new Map<string, { name: string | null; checkedAt: number }>();

/**
 * The Tailscale machine name of the device that sent `req` ("iphone"), for the name the
 * chat shows for its Collab guest. Tailscale Serve sets X-Forwarded-For to the client's tailnet
 * address and replaces any value the client sends. Null when there is none or whois fails.
 */
async function deviceName(req: Request): Promise<string | null> {
  if (TAILSCALE_BIN === null) return null;
  const address = req.headers.get("X-Forwarded-For")?.trim() ?? "";
  if (!TAILNET_ADDRESS.test(address)) return null;
  const cached = deviceNames.get(address);
  if (cached && Date.now() - cached.checkedAt < DEVICE_NAME_TTL_MS) return cached.name;
  let name: string | null = null;
  try {
    const { stdout, code } = await executeProcess([TAILSCALE_BIN, "whois", "--json", address], 3000);
    if (code === 0) name = machineNameFromWhois(stdout);
  } catch (err) {
    console.error(`tailscale whois failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  deviceNames.set(address, { name, checkedAt: Date.now() });
  return name;
}

async function loadBuildInfo(): Promise<CollabBuildInfo | null> {
  const file = Bun.file(join(COLLAB_DIST, "build.json"));
  return (await file.exists()) ? parseBuildInfo(await file.text()) : null;
}

let ompVersionCache: { checkedAt: number; version: string | null } | null = null;

async function installedOmpVersion(): Promise<string | null> {
  if (ompVersionCache && Date.now() - ompVersionCache.checkedAt < OMP_VERSION_TTL_MS) {
    return ompVersionCache.version;
  }
  const result = await executeProcess([OMP_BIN, "--version"]).catch(() => null);
  ompVersionCache = { checkedAt: Date.now(), version: result?.code === 0 ? parseOmpVersion(result.stdout) : null };
  return ompVersionCache.version;
}

let lastRebuild: RebuildAttempt | null = null;

/** Runs build-collab.ts in the background; later page-copy checks see its result. */
function startRebuild(version: string): void {
  const attempt: RebuildAttempt = { version, finishedAt: null, error: null };
  lastRebuild = attempt;
  console.log(`page copy: building for omp ${version}`);
  executeProcess([process.execPath, BUILD_SCRIPT, "--if-outdated"], REBUILD_TIMEOUT_MS)
    .then(({ stdout, stderr, code }) => {
      if (code === 0) return;
      const firstLine = (stderr || stdout).trim().replace(/^build-collab: /, "").split("\n")[0];
      attempt.error = (firstLine || `build-collab.ts exited with code ${code}`).slice(0, 300);
    })
    .catch((err: unknown) => {
      attempt.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      attempt.finishedAt = Date.now();
      console.log(
        attempt.error
          ? `page copy: build for omp ${version} failed: ${attempt.error}`
          : `page copy: built for omp ${version}`,
      );
    });
}

/** Whether links may open the page copy. A missing or outdated copy starts a rebuild. */
async function currentPageCopy(): Promise<PageCopyState> {
  const installed = await installedOmpVersion();
  const state = pageCopyState(await loadBuildInfo(), installed);
  if (state.ok || !installed) return state;
  if (shouldRebuild(lastRebuild, installed, Date.now())) startRebuild(installed);
  const attempt = lastRebuild?.version === installed ? lastRebuild : null;
  if (attempt && attempt.finishedAt === null) {
    return { ok: false, reason: `Building the page copy for omp ${installed}…` };
  }
  if (attempt?.error) {
    return {
      ok: false,
      reason: `Building the page copy for omp ${installed} failed: ${attempt.error}. The dashboard tries again ${REBUILD_RETRY_MS / 60_000} minutes after a failure; to build now, on the server Mac run: bun build-collab.ts`,
    };
  }
  return state;
}

function handleStaticFile(pathname: string): Response | null {
  const filePath = pathname === "/" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, pathname.slice(1));
  const file = Bun.file(filePath);
  if (!file.size) {
    return null;
  }

  const ext = (pathname === "/" ? "html" : pathname.split(".").pop() || "").toLowerCase();
  const contentTypes: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };

  return new Response(file, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": contentTypes[ext] || "text/plain; charset=utf-8",
      // Revalidate every load so a phone never pairs new HTML with a stale app.js.
      "Cache-Control": "no-cache",
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_API_HEADERS });
}

// CSRF guard for POST routes: JSON body only, and Origin (when sent) must be ours.
function rejectUnsafeMutation(req: Request): Response | null {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return jsonResponse(400, errorBody("Content-Type must be application/json"));
  }
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS[origin] !== true) {
    return jsonResponse(403, errorBody("Invalid request origin"));
  }
  return null;
}

/** A route of a module the config turns off: 404 with code "disabled". */
function disabledResponse(module: string): Response {
  return jsonResponse(404, errorBody(`${module} is turned off on this server`, "disabled"));
}

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(full).catch(() => null))?.isDirectory());
    if (isDir) dirs.push(full);
  }
  return dirs.sort();
}

async function listLaunchFolders(): Promise<string[]> {
  return [PROJECT_MAP.root, ...(await listDirectories(PROJECT_MAP.root))];
}

// One cmux start at a time, for New session and for reopening a long task alike.
let launchInFlight = false;

/**
 * Opens a cmux workspace in `folder` whose shell runs `command`, then waits for the omp it
 * starts to appear in Collab: 201 with the host, 502 when cmux fails, 504 when omp does
 * not show up within LAUNCH_REGISTER_TIMEOUT_MS.
 */
async function startInCmux(
  folder: string,
  command: string,
  findHost: (hosts: CliHost[]) => CliHost | null | undefined,
): Promise<Response> {
  const { stdout, stderr, code } = await executeProcess([
    CMUX_BIN, "workspace", "create",
    "--name", workspaceName(folder),
    "--cwd", folder,
    "--command", command,
    "--focus", "false",
  ]);
  const workspace = code === 0 ? parseWorkspaceRef(stdout) : null;
  if (!workspace) {
    const detail = (stderr || stdout || `exit code ${code}`).trim().slice(0, 300);
    return jsonResponse(502, errorBody(`cmux could not create a workspace: ${detail}`));
  }

  // omp needs a few seconds to boot and publish itself to the Collab registry.
  const deadline = Date.now() + LAUNCH_REGISTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(750);
    const host = findHost(await fetchLiveHosts(true).catch(() => []));
    if (host) {
      return jsonResponse(201, launchedBody(host, workspace));
    }
  }
  return jsonResponse(504, {
    ...errorBody(`omp started in cmux ${workspace} but did not appear in Collab within ${LAUNCH_REGISTER_TIMEOUT_MS / 1000}s`),
    workspace,
  });
}

async function handleLaunch(req: Request): Promise<Response> {
  if (!config.launch.enabled) return disabledResponse("New session");
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {}

  const { req: launch, error } = validateLaunchRequest(body, await listLaunchFolders(), config.launch.models, config.launch.defaultModel);
  if (!launch) {
    return jsonResponse(400, errorBody(error ?? "Invalid launch request"));
  }
  if (launchInFlight) {
    return jsonResponse(409, errorBody("Another session is still starting"));
  }

  launchInFlight = true;
  try {
    const knownBefore = new Set((await fetchLiveHosts(true)).map((h) => h.instanceId));
    const res = await startInCmux(launch.folder, launchCommand(launch.model, launch.maxCost, config.launch.profile), (hosts) =>
      findLaunchedHost(hosts, knownBefore, launch.folder),
    );
    if (res.status === 201) syncGroupsSoon();
    return res;
  } finally {
    launchInFlight = false;
  }
}

/**
 * The control link of a host's Collab room, for the guest that reads and answers its questions.
 * Throws when the CLI fails or the session rotated since the host list was read.
 */
async function controlLink(host: CliHost): Promise<string> {
  const { stdout, stderr, code } = await fetchLink(host.instanceId, "control");
  if (code !== 0) throw new Error(`omp collab link failed: ${(stderr || stdout || `exit ${code}`).slice(0, 300)}`);
  const link = parseCliLink(stdout);
  if (!link) throw new Error("Invalid link output from CLI");
  if (link.generation !== host.generation) throw new Error("Session was rotated or ended");
  return link.url;
}

const uiRelay = collabUiRelay(controlLink);

/**
 * Manage: one operation on a live session, through its control extension or Collab room
 * (control.ts). `local`: the request came over the local API socket, which alone serves the ops
 * that act inside a chat.
 */
async function handleControlRequest(req: Request, local: boolean): Promise<Response> {
  if (!config.control.enabled) return disabledResponse("Manage");
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {}
  const settings = { models: config.launch.models, devCycles: config.control.devCycles, ownerOnlyWords: config.control.ownerOnlyWords };
  // The deadline also ends when the caller hangs up, so nothing is sent for a request nobody awaits.
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(GUEST_DEADLINE_MS)]);
  const ctx = { local, signal, relist: () => fetchLiveHosts(true) };
  const control = await handleControl(body, await fetchLiveHosts(true), settings, uiRelay, ctx);
  return jsonResponse(control.status, control.body);
}

// Session id → session file, from a scan of every agent dir's `sessions/<encoded cwd>/`.
// Rebuilt whenever a wanted id is unknown or its file has gone (moved or deleted).
let sessionIndex = new Map<string, SessionLocation>();
let inflightScan: Promise<void> | null = null;

async function scanSessions(): Promise<void> {
  if (inflightScan) {
    return inflightScan;
  }
  inflightScan = (async () => {
    try {
      const next = new Map<string, SessionLocation>();
      for (const { dir, profile } of await listAgentDirs(OMP_CONFIG_ROOT)) {
        const sessionsDir = join(dir, "sessions");
        for (const cwdDir of await readdir(sessionsDir, { withFileTypes: true }).catch(emptyIfMissing)) {
          if (!cwdDir.isDirectory()) continue;
          for (const name of await readdir(join(sessionsDir, cwdDir.name)).catch(emptyIfMissing)) {
            const id = sessionIdFromFileName(name);
            if (id && !next.has(id)) {
              next.set(id, { path: join(sessionsDir, cwdDir.name, name), agentDir: dir, profile });
            }
          }
        }
      }
      sessionIndex = next;
    } finally {
      inflightScan = null;
    }
  })();
  return inflightScan;
}

type FoundSession = { loc: SessionLocation; mtimeMs: number };

/** Session files by id with their last-modified time; ids without a file are left out. */
async function findSessions(ids: readonly string[]): Promise<Map<string, FoundSession>> {
  const found = new Map<string, FoundSession>();
  const statIndexed = async (wanted: readonly string[]): Promise<string[]> => {
    await Promise.all(
      wanted.map(async (id) => {
        const loc = sessionIndex.get(id);
        if (!loc) return;
        const info = await stat(loc.path).catch((err: unknown) => {
          if (isMissing(err)) return null;
          throw err;
        });
        if (info?.isFile()) found.set(id, { loc, mtimeMs: info.mtimeMs });
      }),
    );
    return wanted.filter((id) => !found.has(id));
  };
  const missing = await statIndexed(ids);
  if (missing.length > 0) {
    await scanSessions();
    await statIndexed(missing);
  }
  return found;
}

async function readSessionHead(path: string): Promise<SessionHead | null> {
  try {
    return parseSessionHead(await Bun.file(path).slice(0, SESSION_HEAD_BYTES).text());
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Each job's latest reports for every pinned session, from the last 64 KiB of its report
 * file. A file that cannot be read gives no reports rather than failing the whole poll.
 */
async function loadReports(sessionIds: readonly string[]): Promise<Map<string, JobReport[]>> {
  const entries = await Promise.all(
    sessionIds.map(async (sessionId): Promise<[string, JobReport[]]> => {
      const file = reportFile(OMP_CONFIG_ROOT, sessionId);
      const reports = await readReportsTail(file).catch((err: unknown) => {
        console.error(`reports: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      });
      return [sessionId, latestPerJob(reports, CARD_REPORTS)];
    }),
  );
  return new Map(entries);
}

/**
 * Every pinned id across agent dirs, the pinned sessions whose files still exist, most
 * recently active first, and each pinned session's job reports. Runs on every /api/v1/hosts
 * poll: it reads the pins files, the first bytes of each pinned session and the end of its
 * report file, and scans folders only when a pinned file moved.
 */
async function loadLongTasks(): Promise<{
  pinnedIds: Set<string>;
  longTasks: LongTask[];
  reports: Map<string, JobReport[]>;
}> {
  if (!config.longTasks.enabled) return { pinnedIds: new Set(), longTasks: [], reports: new Map() };
  const pinnedIds = await loadPinnedIds(OMP_CONFIG_ROOT);
  // Ids that are not omp session ids can never match a file name, so they are not looked up.
  const sessionIds = [...pinnedIds].filter((id) => SESSION_ID.test(id));
  const [found, reports] = await Promise.all([findSessions(sessionIds), config.reports.enabled ? loadReports(sessionIds) : new Map<string, JobReport[]>()]);
  const tasks = await Promise.all(
    [...found].map(async ([sessionId, { loc, mtimeMs }]): Promise<LongTask | null> => {
      const head = await readSessionHead(loc.path);
      if (head?.sessionId !== sessionId) return null;
      return {
        sessionId,
        title: head.title,
        cwd: head.cwd,
        folder: deriveFolder(head.cwd),
        project: projectOf(head.cwd, PROJECT_MAP),
        profile: loc.profile,
        lastActiveAt: Math.trunc(mtimeMs),
        reports: reports.get(sessionId) ?? [],
      };
    }),
  );
  const longTasks = tasks.filter((task) => task !== null).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return { pinnedIds, longTasks, reports };
}

async function handlePin(req: Request): Promise<Response> {
  if (!config.longTasks.enabled) return disabledResponse("Long tasks");
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {}

  const { req: pin, error } = validatePinRequest(body);
  if (!pin) {
    return jsonResponse(400, errorBody(error ?? "Invalid pin request"));
  }
  const { sessionId, pinned } = pin;
  if (pinned) {
    // Pin where the session lives, as `/pin` inside that session would.
    const found = (await findSessions([sessionId])).get(sessionId);
    if (!found) {
      return jsonResponse(404, errorBody(`Session ${sessionId} has no session file`));
    }
    if (await writePin(found.loc.agentDir, sessionId, true)) {
      console.log(`pin: pinned session ${sessionId} in profile ${found.loc.profile ?? "(default)"}`);
      syncGroupsSoon();
    }
  } else {
    for (const { dir, profile } of await listAgentDirs(OMP_CONFIG_ROOT)) {
      if ((await readPins(dir)).includes(sessionId) && (await writePin(dir, sessionId, false))) {
        console.log(`pin: unpinned session ${sessionId} in profile ${profile ?? "(default)"}`);
        syncGroupsSoon();
      }
    }
  }
  return jsonResponse(200, pinBody(pin));
}

/**
 * Pids holding the session's lease. lsof only reads the open-file table: taking the lease
 * ourselves, even briefly, could make a starting omp fork the session under a new id.
 */
async function sessionLeaseHolders(sessionId: string): Promise<string[]> {
  const lease = join(SESSION_OWNERS_DIR, `${sessionId}.lock`);
  const exists = await stat(lease).then(
    () => true,
    (err: unknown) => {
      if (isMissing(err)) return false;
      throw err;
    },
  );
  if (!exists) return [];
  const { stdout, stderr, code } = await executeProcess([LSOF_BIN, "-t", "--", lease]);
  const pids = stdout.split("\n").filter((line) => /^\d+$/.test(line.trim())).map((line) => line.trim());
  // lsof exits 1 without output when no process has the file open.
  if (pids.length > 0 || (code === 1 && !stderr.trim())) return pids;
  throw new Error(`lsof could not check ${lease}: ${(stderr || stdout || `exit code ${code}`).trim().slice(0, 300)}`);
}

async function handleReopen(req: Request): Promise<Response> {
  if (!config.longTasks.enabled) return disabledResponse("Long tasks");
  if (!config.launch.enabled) return disabledResponse("Reopen");
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {}

  const { req: reopen, error } = validateReopenRequest(body);
  if (!reopen) {
    return jsonResponse(400, errorBody(error ?? "Invalid reopen request"));
  }
  const { sessionId } = reopen;
  if (!(await loadPinnedIds(OMP_CONFIG_ROOT)).has(sessionId)) {
    return jsonResponse(404, errorBody(`Session ${sessionId} is not pinned`));
  }
  const found = (await findSessions([sessionId])).get(sessionId);
  const head = found ? await readSessionHead(found.loc.path) : null;
  if (!found || head?.sessionId !== sessionId) {
    return jsonResponse(404, errorBody(`Session ${sessionId} has no session file`));
  }
  const command = reopenCommand(found.loc);
  if (launchInFlight) {
    return jsonResponse(409, errorBody("Another session is still starting", "busy"));
  }

  launchInFlight = true;
  try {
    // Checked inside the guard so a double tap cannot start the session twice.
    if ((await fetchLiveHosts(true)).some((h) => h.sessionId === sessionId)) {
      return jsonResponse(409, errorBody("This session is already running", "running"));
    }
    if (!(await stat(head.cwd).catch(() => null))?.isDirectory()) {
      return jsonResponse(409, errorBody(`The session's folder ${head.cwd} no longer exists`, "missing_folder"));
    }
    // Resuming a session another omp still holds would fork it under a new id.
    const holders = await sessionLeaseHolders(sessionId);
    if (holders.length > 0) {
      return jsonResponse(
        409,
        errorBody(`The session is still open in another omp process (pid ${holders.join(", ")}); close it there first`, "in_use"),
      );
    }
    const res = await startInCmux(head.cwd, command, (hosts) => hosts.find((h) => h.sessionId === sessionId));
    console.log(
      `reopen: session ${sessionId} (profile ${found.loc.profile ?? "(default)"}) in ${head.cwd} -> ${res.status}`,
    );
    if (res.status === 201) syncGroupsSoon();
    return res;
  } finally {
    launchInFlight = false;
  }
}

const groupSync =
  !config.cmuxGroups.enabled
    ? null
    : new GroupSync({
        cmuxBin: CMUX_BIN,
        projects: PROJECT_MAP,
        window: null,
        exec: executeProcess,
        liveHosts: fetchLiveHosts,
        pinnedIds: () => loadPinnedIds(OMP_CONFIG_ROOT),
        hookSessionsPath: CMUX_OMP_HOOK_STORE,
        longTaskGraceMs: LONG_TASK_GRACE_MS,
        now: Date.now,
        log: console.log,
      });
let groupSyncTimer: Timer | null = null;

/** Runs a group sync about a second from now; requests until then share it. */
function syncGroupsSoon(): void {
  if (!groupSync || groupSyncTimer) return;
  groupSyncTimer = setTimeout(() => {
    groupSyncTimer = null;
    void groupSync.sync();
  }, GROUP_SYNC_SOON_MS);
}

// Push (push-apns.ts, push-devices.ts, push-events.ts), built only when push is on: with push off
// nothing reads or writes stateDir, no watcher runs, no APNs session opens, and the three push
// routes answer 404 "disabled".
const pushService =
  config.push === null
    ? null
    : {
        settings: config.push,
        devices: new DeviceStore(join(config.stateDir, "devices.json")),
        apns: new ApnsClient({ ...config.push, transport: http2Transport().send, log: console.log }),
      };

async function handleDeviceRegister(req: Request): Promise<Response> {
  if (pushService === null) return disabledResponse("Push");
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {}
  const { req: registration, error, code } = validateDeviceRequest(body, pushService.settings);
  if (!registration) return jsonResponse(400, errorBody(error ?? "Invalid device request", code));
  const login = (req.headers.get("tailscale-user-login") ?? "").trim();
  const device = await pushService.devices.upsert(registration, { login, deviceName: await deviceName(req) });
  console.log(`push: registered a ${device.environment} device (${device.deviceName ?? "no name"})`);
  return jsonResponse(200, deviceBody(device));
}

async function handleDeviceRemove(req: Request): Promise<Response> {
  if (pushService === null) return disabledResponse("Push");
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {}
  const { req: target, error } = validateTokenRequest(body);
  if (!target) return jsonResponse(400, errorBody(error ?? "Invalid device request"));
  const removed = await pushService.devices.remove(target.token);
  if (removed) console.log("push: removed a device");
  return jsonResponse(200, removedBody(removed));
}

async function handlePushTest(req: Request): Promise<Response> {
  if (pushService === null) return disabledResponse("Push");
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {}
  const { req: target, error } = validateTokenRequest(body);
  if (!target) return jsonResponse(400, errorBody(error ?? "Invalid device request"));
  const device = await pushService.devices.find(target.token);
  if (!device) return jsonResponse(404, errorBody("This device is not registered for push", "unknown_device"));
  const result = await pushService.apns.send(device.environment, testMessage(device.token), Date.parse(device.lastSeenAt));
  if (result.removeDevice) {
    await pushService.devices.remove(device.token);
    console.log(`push: removed a device APNs no longer accepts (${result.reason ?? result.status})`);
  }
  if (result.status === 200) return jsonResponse(200, pushTestBody(result.apnsId));
  const reason = result.reason ?? `status_${result.status}`;
  const message = result.status === 0 ? `The server could not send through APNs: ${reason}` : `APNs answered ${result.status} ${reason}`;
  return jsonResponse(502, errorBody(message, reason));
}

// Push watchers (build plan §6.2), only while push is on: the chats every push.pollSeconds while a
// device is registered, and the job reports folder while reports are on too. push-events.ts decides
// what to send; a send that fails is logged and never holds up the next check.
type PushService = NonNullable<typeof pushService>;
const PUSH_STATE_FILE = join(config.stateDir, "push-state.json");
const REPORTS_RESCAN_MS = 60_000;
// After an fs.watch event, wait this long so a burst of writes makes one scan.
const REPORTS_SETTLE_MS = 300;
// A report push that met an APNs 5xx goes once more after this long (build plan §6.3).
const REPORT_RETRY_MS = 15 * 60_000;

function logPushError(where: string, err: unknown): void {
  console.error(`push: ${where}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Sends `event` to every registered device whose switch for it is on. */
async function sendPushEvent(service: PushService, event: PushEvent): Promise<void> {
  const devices = (await service.devices.list()).filter((device) => device.events[event.kind]);
  await Promise.all(devices.map((device) => sendPushToDevice(service, event, device, true)));
}

async function sendPushToDevice(service: PushService, event: PushEvent, device: Device, retry: boolean): Promise<void> {
  const message = apnsMessage(event, device.token, service.settings.includeSummary);
  const result = await service.apns.send(device.environment, message, Date.parse(device.lastSeenAt));
  if (result.removeDevice) {
    await service.devices.remove(device.token);
    console.log(`push: removed a device APNs no longer accepts (${result.reason ?? result.status})`);
  } else if (retry && result.status >= 500 && message.kind === "report") {
    setTimeout(() => {
      void (async () => {
        // Only to a device that is still registered and still wants this kind.
        const current = await service.devices.find(device.token);
        if (current?.events[event.kind]) await sendPushToDevice(service, event, current, false);
      })().catch((err: unknown) => logPushError("retry", err));
    }, REPORT_RETRY_MS);
  }
}

/** Starts each send without waiting for it, so a slow or failing send never delays detection. */
function pushEvents(service: PushService, events: readonly PushEvent[]): void {
  for (const event of events) {
    void sendPushEvent(service, event).catch((err: unknown) => logPushError(event.kind, err));
  }
}

/** Polls the chats every push.pollSeconds while a device is registered; with none, the next poll is a new baseline. */
function watchChatsForPush(service: PushService): void {
  let known: HostWatch | null = null;
  const lastInputPush = new Map<string, number>();
  let lastError: string | null = null;
  const poll = async (): Promise<void> => {
    if ((await service.devices.list()).length === 0) {
      known = null;
      return;
    }
    const [hosts, pinned] = await Promise.all([
      fetchLiveHosts(),
      config.longTasks.enabled ? loadPinnedIds(OMP_CONFIG_ROOT) : Promise.resolve(new Set<string>()),
    ]);
    const now = Date.now();
    const snaps: HostSnap[] = hosts.map((h) => {
      const folder = deriveFolder(h.cwd);
      return {
        instanceId: h.instanceId,
        generation: h.generation,
        sessionId: h.sessionId,
        title: h.sessionName?.trim() || folder,
        folder,
        inputRequired: h.inputRequired,
        busy: h.busy,
        pinned: pinned.has(h.sessionId),
      };
    });
    const baseline = known === null;
    const { state, events } = detectHostEvents(known, snaps, now, lastInputPush);
    known = state;
    if (baseline) console.log(`push: chats baseline, ${snaps.length} chats, nothing sent`);
    for (const [sessionId, at] of lastInputPush) {
      if (now - at >= INPUT_COOLDOWN_MS) lastInputPush.delete(sessionId);
    }
    for (const event of events) {
      if (event.kind === "input") lastInputPush.set(event.sessionId, now);
    }
    pushEvents(service, events);
  };
  const tick = (): void => {
    void poll()
      .then(() => {
        lastError = null;
      })
      .catch((err: unknown) => {
        // A lasting failure, such as omp not answering, is logged once, not on every poll.
        const text = err instanceof Error ? err.message : String(err);
        if (text !== lastError) console.error(`push: chats watcher: ${text}`);
        lastError = text;
      })
      .finally(() => setTimeout(tick, service.settings.pollSeconds * 1000));
  };
  console.log(`push: watching chats every ${service.settings.pollSeconds} s while a device is registered`);
  tick();
}

/** push-state.json; a missing or broken file gives no state, so the reports watcher starts from now. */
async function readPushState(): Promise<PushState> {
  try {
    const state = parsePushState(await readFile(PUSH_STATE_FILE, "utf8"));
    if (state !== null) return state;
    console.error(`push: ${PUSH_STATE_FILE} is not a push state file; job reports are pushed from now on`);
  } catch (err) {
    if (!isMissing(err)) logPushError(`cannot read ${PUSH_STATE_FILE}`, err);
  }
  return { savedAt: null, seen: new Map() };
}

/** Writes push-state.json owner-only, through a temp file and a rename, like devices.json. */
async function writePushState(savedAt: number, seen: ReadonlyMap<string, number>): Promise<void> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temp = `${PUSH_STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temp, pushStateText({ savedAt, seen }), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, PUSH_STATE_FILE);
}

/** Each session's title as its Long tasks card shows it: the title in its file, else its folder. */
async function sessionTitles(ids: readonly string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  const found = await findSessions(ids);
  await Promise.all(
    [...found].map(async ([sessionId, { loc }]) => {
      const head = await readSessionHead(loc.path).catch(() => null);
      if (head?.sessionId === sessionId) titles.set(sessionId, head.title ?? deriveFolder(head.cwd));
    }),
  );
  return titles;
}

/**
 * Watches the job reports folder and pushes each new failed or update report once. A file is read
 * again only when its size or time changed: after an fs.watch event, and in a scan of the whole
 * folder at the start and every minute, which catches what fs.watch missed.
 */
async function watchReportsForPush(service: PushService): Promise<void> {
  const dir = reportsDir(OMP_CONFIG_ROOT);
  // mkdir's mode applies only to a folder it creates, so an existing folder is set again.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const state = await readPushState();
  const startWatermark = reportWatermark(state.savedAt, Date.now());
  let seen = state.seen;
  const marks = new Map<string, string>();
  const changedNames = new Set<string>();
  let wholeFolder = true;
  let settleTimer: Timer | null = null;
  let queue: Promise<void> = Promise.resolve();
  const isReportFile = (name: string): boolean => name.endsWith(".jsonl") && SESSION_ID.test(name.slice(0, -".jsonl".length));

  const scan = async (): Promise<void> => {
    const names = wholeFolder ? (await readdir(dir).catch(emptyIfMissing)).filter(isReportFile) : [...changedNames];
    wholeFolder = false;
    changedNames.clear();
    const files: Omit<ReportFile, "title">[] = [];
    for (const name of names) {
      const file = join(dir, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        marks.delete(name);
        continue;
      }
      const mark = `${info.size}:${info.mtimeMs}`;
      if (marks.get(name) === mark) continue;
      marks.set(name, mark);
      const reports = await readReportsTail(file).catch((err: unknown) => {
        logPushError(`cannot read ${file}`, err);
        return [];
      });
      files.push({ sessionId: name.slice(0, -".jsonl".length), reports });
    }
    const titles = await sessionTitles(files.map((f) => f.sessionId));
    const now = Date.now();
    const changed = files.map((f) => ({ ...f, title: titles.get(f.sessionId) ?? null }));
    const result = detectReportEvents(changed, seen, Math.max(startWatermark, now - SEEN_MAX_AGE_MS));
    seen = result.seen;
    await writePushState(now, seen);
    pushEvents(service, result.events);
  };
  const runScan = (): void => {
    queue = queue.then(scan).catch((err: unknown) => logPushError("reports watcher", err));
  };
  const scanSoon = (): void => {
    if (settleTimer !== null) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      runScan();
    }, REPORTS_SETTLE_MS);
  };

  watch(dir, (_event, name) => {
    if (typeof name !== "string") wholeFolder = true;
    else if (isReportFile(name)) changedNames.add(name);
    else return;
    scanSoon();
  }).on("error", (err) => logPushError("watching the reports folder", err));
  setInterval(() => {
    wholeFolder = true;
    runScan();
  }, REPORTS_RESCAN_MS);
  console.log(`push: watching job reports in ${dir}, from ${new Date(startWatermark).toISOString()}`);
  runScan();
}

export const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: CONTROL_IDLE_TIMEOUT_S,
  async fetch(req) {
    const start = performance.now();
    const url = new URL(req.url);
    const pathname = url.pathname;

    let res: Response;

    try {
      // 1. Auth check
      const login = req.headers.get("tailscale-user-login");
      const auth = checkAuth(login, config.allowedLogins);
      if (!auth.authorized) {
        res = jsonResponse(403, errorBody(auth.reason || "Unauthorized"));
      } else if (req.method === "GET" && pathname === "/api/v1/info") {
        const [device, ompVersion] = await Promise.all([deviceName(req), installedOmpVersion()]);
        res = jsonResponse(
          200,
          infoBody(config, { login: (login ?? "").trim(), deviceName: device, serverVersion: SERVER_VERSION, ompVersion }),
        );
      } else if (req.method === "GET" && pathname === "/api/v1/hosts") {
        try {
          const [live, pins] = await Promise.all([fetchLiveHosts(), loadLongTasks()]);
          const pageCopy = COLLAB_PUBLIC_URL === null ? null : await currentPageCopy();
          res = jsonResponse(200, hostsBody(Date.now(), live, PROJECT_MAP, pins, pageCopy));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          res = jsonResponse(502, errorBody(msg));
        }
      } else if (req.method === "POST" && pathname === "/api/v1/link") {
        const rejected = rejectUnsafeMutation(req);
        if (rejected) {
          res = rejected;
        } else {
          let bodyPayload: unknown;
          try {
            bodyPayload = await req.json();
          } catch {
            bodyPayload = null;
          }

          const { req: linkReq, error: valError } = validateLinkRequest(bodyPayload);
          if (!linkReq) {
            res = jsonResponse(400, errorBody(valError || "Invalid link request"));
          } else {
            try {
              // Fresh list to avoid stale cached decisions
              const live = await fetchLiveHosts(true);
              const pre = preCheckLink(linkReq, live);
              if (!pre.ok) {
                res = jsonResponse(pre.decision.status, errorBody(pre.decision.error));
              } else {
                const { stdout, stderr, code } = await fetchLink(linkReq.instanceId, linkReq.access);
                if (code !== 0) {
                  const errMsg = (stderr || stdout || `Process exited with code ${code}`).slice(0, 300);
                  res = jsonResponse(502, errorBody(`Failed to retrieve link: ${errMsg}`));
                } else {
                  const cliLink = parseCliLink(stdout);
                  if (!cliLink) {
                    res = jsonResponse(502, errorBody("Invalid link output from CLI"));
                  } else {
                    const post = postCheckLink(linkReq, cliLink);
                    if (post.status === 200) {
                      // Open the dashboard's page copy when it is on and matches the installed omp; else my.omp.sh.
                      // The copy also gets the device's name, so the chat shows "iphone", not "guest".
                      const pageUrl =
                        COLLAB_PUBLIC_URL !== null &&
                        (await currentPageCopy()).ok &&
                        rewriteCollabUrl(post.url, COLLAB_PUBLIC_URL, await deviceName(req));
                      res = jsonResponse(200, linkBody(pageUrl || post.url));
                    } else {
                      res = jsonResponse(post.status, errorBody(post.error));
                    }
                  }
                }
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              res = jsonResponse(502, errorBody(msg));
            }
          }
        }
      } else if (req.method === "GET" && pathname === "/api/v1/launch-options") {
        if (!config.launch.enabled) {
          res = disabledResponse("New session");
        } else {
          res = jsonResponse(200, launchOptionsBody(await listLaunchFolders(), config.launch.models, config.launch.defaultModel));
        }
      } else if (req.method === "POST" && pathname === "/api/v1/control") {
        res = rejectUnsafeMutation(req) ?? (await handleControlRequest(req, false));
      } else if (req.method === "POST" && pathname === "/api/v1/sessions") {
        res = rejectUnsafeMutation(req) ?? (await handleLaunch(req));
      } else if (req.method === "POST" && pathname === "/api/v1/pin") {
        res = rejectUnsafeMutation(req) ?? (await handlePin(req));
      } else if (req.method === "POST" && pathname === "/api/v1/long-tasks/reopen") {
        res = rejectUnsafeMutation(req) ?? (await handleReopen(req));
      } else if (req.method === "POST" && pathname === "/api/v1/devices") {
        res = rejectUnsafeMutation(req) ?? (await handleDeviceRegister(req));
      } else if (req.method === "POST" && pathname === "/api/v1/devices/remove") {
        res = rejectUnsafeMutation(req) ?? (await handleDeviceRemove(req));
      } else if (req.method === "POST" && pathname === "/api/v1/push/test") {
        res = rejectUnsafeMutation(req) ?? (await handlePushTest(req));
      } else if (pathname.startsWith("/api/")) {
        // No such route, the old paths without /v1 included: a JSON 404 like every other /api/ reply.
        res = jsonResponse(404, errorBody("Not found"));
      } else if (req.method === "GET") {
        const staticRes = handleStaticFile(pathname);
        res = staticRes || new Response("Not found", { status: 404, headers: COMMON_HEADERS });
      } else {
        res = new Response("Method not allowed", { status: 405, headers: COMMON_HEADERS });
      }
    } catch (unhandled: unknown) {
      const msg = unhandled instanceof Error ? unhandled.message : "Internal Server Error";
      res = jsonResponse(500, errorBody(msg));
    }

    const duration = (performance.now() - start).toFixed(1);
    // Safe audit logging: method, path, status, latency only (never secrets or body)
    console.log(`${req.method} ${pathname} -> ${res.status} [${duration}ms]`);
    return res;
  },
});

console.log(`omp-sessions server running on http://${HOST}:${PORT}`);

if (groupSync) {
  setInterval(() => void groupSync.sync(), GROUP_SYNC_MS);
  syncGroupsSoon();
}

if (pushService !== null) {
  watchChatsForPush(pushService);
  if (config.reports.enabled) {
    void watchReportsForPush(pushService).catch((err: unknown) => logPushError("the reports watcher did not start", err));
  }
}

async function handleCollabRequest(req: Request): Promise<Response> {
  const auth = checkAuth(req.headers.get("tailscale-user-login"), config.allowedLogins);
  if (!auth.authorized) {
    return new Response(auth.reason || "Unauthorized", { status: 403, headers: COMMON_HEADERS });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: COMMON_HEADERS });
  }
  const info = await loadBuildInfo();
  if (!info) {
    return new Response("The page copy is not built. On the server Mac run: bun build-collab.ts", {
      status: 503,
      headers: COMMON_HEADERS,
    });
  }
  const filePath = resolveCollabPath(COLLAB_DIST, new URL(req.url).pathname);
  if (!filePath || !(await Bun.file(filePath).exists())) {
    return new Response("Not found", { status: 404, headers: COMMON_HEADERS });
  }
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Security-Policy": collabCsp(info),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": collabCacheControl(basename(filePath)),
    },
  });
}

if (COLLAB_PUBLIC_URL !== null) {
  Bun.serve({
    port: COLLAB_PORT,
    hostname: HOST,
    async fetch(req) {
      const start = performance.now();
      let res: Response;
      try {
        res = await handleCollabRequest(req);
      } catch {
        res = new Response("Internal Server Error", { status: 500, headers: COMMON_HEADERS });
      }
      const duration = (performance.now() - start).toFixed(1);
      console.log(`collab ${req.method} ${new URL(req.url).pathname} -> ${res.status} [${duration}ms]`);
      return res;
    },
  });
  console.log(`omp-sessions page copy on http://${HOST}:${COLLAB_PORT} (public ${COLLAB_PUBLIC_URL})`);
}

// Local API for this user's own scripts, such as a launchd job that watches a service: New session and
// Manage over a Unix socket, without the Tailscale login check. The folder is 0700, so no other
// user can reach the socket, even before its own chmod to 0600 right after the listen.
const LOCAL_API_DIR = config.localApi.dir;
const LOCAL_API_SOCKET = join(LOCAL_API_DIR, "api.sock");

/** The local API's two routes; anything else, the page and /api/v1/hosts included, is 404. */
async function handleLocalRequest(req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  if (req.method === "POST" && pathname === "/api/sessions") {
    return rejectUnsafeMutation(req) ?? (await handleLaunch(req));
  }
  if (req.method === "POST" && pathname === "/api/control") {
    return rejectUnsafeMutation(req) ?? (await handleControlRequest(req, true));
  }
  return jsonResponse(404, errorBody("Not found"));
}

if (config.localApi.enabled) {
  // mkdir's mode applies only to a folder it creates, so an existing folder is set again.
  await mkdir(LOCAL_API_DIR, { recursive: true, mode: 0o700 });
  await chmod(LOCAL_API_DIR, 0o700);
  // A socket file left by a killed server would make the listen fail with "address in use".
  await rm(LOCAL_API_SOCKET, { force: true });
  Bun.serve({
    unix: LOCAL_API_SOCKET,
    async fetch(req, srv) {
      // The unix-socket options take no idleTimeout; the per-request one does the same.
      srv.timeout(req, CONTROL_IDLE_TIMEOUT_S);
      const start = performance.now();
      let res: Response;
      try {
        res = await handleLocalRequest(req);
      } catch (unhandled: unknown) {
        const msg = unhandled instanceof Error ? unhandled.message : "Internal Server Error";
        res = jsonResponse(500, errorBody(msg));
      }
      const duration = (performance.now() - start).toFixed(1);
      console.log(`local ${req.method} ${new URL(req.url).pathname} -> ${res.status} [${duration}ms]`);
      return res;
    },
  });
  await chmod(LOCAL_API_SOCKET, 0o600);
  console.log(`omp-sessions local API on ${LOCAL_API_SOCKET}`);
}
