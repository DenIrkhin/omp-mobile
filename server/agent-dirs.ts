// omp's agent dirs and the pins they hold, shared by the server, the command-line tools
// (cmux-groups.ts, report.ts) that run without it, and the control extension's /unpin.
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./flock";
import { parsePins, PINS_FILE, PROFILE_NAME, setPinned } from "./long-tasks";

/** An agent dir and the profile that owns it (null = the default agent dir). */
export type AgentDir = { dir: string; profile: string | null };

// ENOTDIR counts too: a stray file in `profiles/` is not a profile with an agent dir.
export function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/** `.catch` handler for listings of folders that may not exist (yet, or any more). */
export function emptyIfMissing(err: unknown): never[] {
  if (isMissing(err)) return [];
  throw err;
}

/**
 * The default agent dir under omp's config root (`~/.omp`), then one per profile. omp only
 * accepts profile names that start with a letter or digit.
 */
export async function listAgentDirs(configRoot: string): Promise<AgentDir[]> {
  const profilesDir = join(configRoot, "profiles");
  const names = await readdir(profilesDir).catch(emptyIfMissing);
  return [
    { dir: join(configRoot, "agent"), profile: null },
    ...names
      .filter((name) => PROFILE_NAME.test(name) && !name.startsWith("."))
      .sort()
      .map((name) => ({ dir: join(profilesDir, name, "agent"), profile: name })),
  ];
}

export async function readPins(agentDir: string): Promise<string[]> {
  try {
    return parsePins(await readFile(join(agentDir, PINS_FILE), "utf8"));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/** Every session id pinned in any agent dir. */
export async function loadPinnedIds(configRoot: string): Promise<Set<string>> {
  const lists = await Promise.all((await listAgentDirs(configRoot)).map(({ dir }) => readPins(dir)));
  return new Set(lists.flat());
}

/**
 * Pins or unpins one session in one agent dir the way omp's `/pin` does: under omp's lock,
 * re-read the file, then write a temp file and rename it over the original, so a crash
 * never leaves a truncated pins file. Returns whether the file changed.
 */
export async function writePin(agentDir: string, sessionId: string, pinned: boolean): Promise<boolean> {
  const file = join(agentDir, PINS_FILE);
  return withFileLock(file, async () => {
    // An omp `/pin` may have changed the file since the caller looked.
    const current = await readPins(agentDir);
    if (current.includes(sessionId) === pinned) return false;
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(setPinned(current, sessionId, pinned), null, "\t"), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return true;
  });
}
