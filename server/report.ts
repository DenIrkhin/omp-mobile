// Posts one job result to a long-task omp chat, for launchd jobs and other scripts:
//
//   bun report.ts --session <omp session id> --job <name> --outcome ok|update|failed
//                 (--summary <text> | --summary-file <path>) [--details <absolute path>] [--wake]
//
// The report is appended to the chat's report file (see reports.ts). The chat's control
// extension posts it into the chat, now if the chat is open, else when it is next resumed;
// the dashboard shows it on the chat's Long tasks card. With --wake, posting it within an hour
// also starts a turn, so the chat goes on with work that waited for this result.
//
// Exit codes: 0 written, 64 usage error, 1 the write failed or the config file is invalid (config.ts).
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyIfMissing, listAgentDirs } from "./agent-dirs";
import { loadConfigOrExit } from "./config";
import { sessionIdFromFileName } from "./long-tasks";
import { appendReport, reportFile, validateReport } from "./reports";

const OMP_CONFIG_ROOT = loadConfigOrExit({ requireServer: false }).omp.configRoot;
const EX_USAGE = 64;
const USAGE = `Usage: bun report.ts --session <omp session id> --job <name> --outcome ok|update|failed
                     (--summary <text> | --summary-file <path>) [--details <absolute path>] [--wake]`;
const OPTIONS: Record<string, true> = {
  "--session": true,
  "--job": true,
  "--outcome": true,
  "--summary": true,
  "--summary-file": true,
  "--details": true,
};

function usageError(message: string): never {
  process.stderr.write(`report.ts: ${message}\n${USAGE}\n`);
  process.exit(EX_USAGE);
}

/** Whether any agent dir (`~/.omp/agent`, `~/.omp/profiles/<name>/agent`) has a session file with this id. */
async function sessionExists(sessionId: string): Promise<boolean> {
  for (const { dir } of await listAgentDirs(OMP_CONFIG_ROOT)) {
    const sessionsDir = join(dir, "sessions");
    for (const cwdDir of await readdir(sessionsDir, { withFileTypes: true }).catch(emptyIfMissing)) {
      if (!cwdDir.isDirectory()) continue;
      const names = await readdir(join(sessionsDir, cwdDir.name)).catch(emptyIfMissing);
      if (names.some((name) => sessionIdFromFileName(name) === sessionId)) return true;
    }
  }
  return false;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const values: Record<string, string> = {};
let wake = false;
for (let i = 0; i < args.length; i += 2) {
  const option = args[i];
  if (option === "--wake") {
    if (wake) usageError("--wake given twice");
    wake = true;
    i -= 1; // a flag without a value
    continue;
  }
  if (OPTIONS[option] !== true) usageError(`unknown argument ${JSON.stringify(option)}`);
  if (option in values) usageError(`${option} given twice`);
  if (i + 1 >= args.length) usageError(`${option} needs a value`);
  values[option] = args[i + 1];
}
for (const option of ["--session", "--job", "--outcome"]) {
  if (!(option in values)) usageError(`${option} is required`);
}
if (("--summary" in values) === ("--summary-file" in values)) {
  usageError("give exactly one of --summary and --summary-file");
}

let summary = values["--summary"];
if (summary === undefined) {
  try {
    summary = await readFile(values["--summary-file"], "utf8");
  } catch (err) {
    usageError(`cannot read --summary-file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const { report, error } = validateReport({
  sessionId: values["--session"],
  job: values["--job"],
  outcome: values["--outcome"],
  summary,
  details: values["--details"] ?? null,
  wake,
});
if (!report) usageError(error ?? "invalid report");

// Only a hint for a mistyped id: the job's result is still worth keeping when the check fails.
const exists = await sessionExists(report.sessionId).catch((err: unknown) => {
  process.stderr.write(
    `report.ts: warning: could not look for the session file: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  return true;
});
if (!exists) {
  process.stderr.write(
    `report.ts: warning: no omp session file has the id ${report.sessionId}; writing the report anyway\n`,
  );
}

const id = randomUUID();
const { sessionId, ...fields } = report;
let file: string;
try {
  file = await appendReport(OMP_CONFIG_ROOT, sessionId, { v: 1, id, ...fields, at: new Date().toISOString() });
} catch (err) {
  process.stderr.write(
    `report.ts: could not write ${reportFile(OMP_CONFIG_ROOT, sessionId)}: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
process.stdout.write(`reported ${id} for ${report.job} to ${file}\n`);
