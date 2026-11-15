// Builds the dashboard's copy of omp's Collab web page (packages/collab-web) into ./collab-dist.
// It uses the omp source tag that matches the installed omp and applies collab-web.patch.
//
//   bun build-collab.ts                 build now; run it by hand to see the full error of a failed build
//   bun build-collab.ts --if-outdated   build only when collab-dist is not for the installed omp
//
// server.ts runs it with --if-outdated when it sees a new omp version, and /omp-update runs it
// after each update. A lock file lets one build run at a time; the others wait for it.
import { existsSync } from "fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { type CollabBuildInfo, inlineScriptHashes, parseBuildInfo, parseOmpVersion } from "./collab-copy";
import { loadConfigOrExit } from "./config";

const ROOT = import.meta.dir;
const WORK_DIR = join(ROOT, ".collab-build");
const SRC_DIR = join(WORK_DIR, "src");
const DEPS_DIR = join(WORK_DIR, "deps");
const OUT_DIR = join(ROOT, "collab-dist");
const PATCH_FILE = join(ROOT, "collab-web.patch");
const LOCK_FILE = join(ROOT, ".collab-build.lock");
// Longer than the 5 minutes server.ts gives a build, so a waiter outlasts any normal build.
const LOCK_WAIT_MS = 6 * 60_000;
// A lock file still without a pid after this long was left by a crash between creating and writing it.
const LOCK_EMPTY_STALE_MS = 10_000;
const REPO_URL = "https://github.com/can1357/oh-my-pi.git";
const OMP_BIN = loadConfigOrExit({ requireServer: false }).omp.bin;
// The page imports only these monorepo packages; pi-utils and pi-wire are plain src/*.ts.
const SPARSE_PATHS = ["/packages/collab-web/", "/packages/utils/", "/packages/wire/", "/bun.lock"];
const CLIENT_DEPS = ["react", "react-dom", "katex", "lucide-react"];

async function run(cmd: string[], cwd = ROOT): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 1000)}`);
  }
  return stdout;
}

/** Sparse, blob-less checkout of the tag: only the paths above are downloaded. */
async function checkoutTag(tag: string): Promise<string> {
  if (!existsSync(join(SRC_DIR, ".git"))) {
    await rm(SRC_DIR, { recursive: true, force: true });
    await mkdir(WORK_DIR, { recursive: true });
    await run(["git", "clone", "-q", "--depth=1", "--filter=blob:none", "--no-checkout", "--branch", tag, REPO_URL, SRC_DIR]);
  }
  await run(["git", "fetch", "-q", "--depth=1", "--filter=blob:none", "origin", `+refs/tags/${tag}:refs/tags/${tag}`], SRC_DIR);
  await run(["git", "config", "core.sparseCheckout", "true"], SRC_DIR);
  await Bun.write(join(SRC_DIR, ".git", "info", "sparse-checkout"), `${SPARSE_PATHS.join("\n")}\n`);
  await run(["git", "-c", "advice.detachedHead=false", "checkout", "-q", "--force", "--detach", `refs/tags/${tag}^{commit}`], SRC_DIR);
  await run(["git", "clean", "-q", "-fdx", "--", "packages"], SRC_DIR);
  return (await run(["git", "rev-parse", "--short=10", "HEAD"], SRC_DIR)).trim();
}

async function applyPatch(tag: string): Promise<void> {
  try {
    await run(["git", "apply", "--check", PATCH_FILE], SRC_DIR);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`collab-web.patch no longer applies to ${tag}; update the patch for this omp version.\n${detail}`);
  }
  await run(["git", "apply", PATCH_FILE], SRC_DIR);
}

/** Installs the page's npm packages at the versions omp's own lockfile pins. */
async function installDeps(): Promise<void> {
  const lock = await Bun.file(join(SRC_DIR, "bun.lock")).text();
  const dependencies: Record<string, string> = {};
  for (const name of CLIENT_DEPS) {
    const match = lock.match(new RegExp(`^\\s*"${name}": \\["${name}@([^"]+)"`, "m"));
    if (!match) throw new Error(`bun.lock at this tag has no entry for ${name}`);
    dependencies[name] = match[1];
  }
  await mkdir(DEPS_DIR, { recursive: true });
  await Bun.write(join(DEPS_DIR, "package.json"), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`);
  await run([process.execPath, "install", "--silent"], DEPS_DIR);

  // Workspace packages resolve to the checked-out sources, the rest to the install above.
  const scope = join(DEPS_DIR, "node_modules", "@oh-my-pi");
  await mkdir(scope, { recursive: true });
  for (const [name, dir] of [
    ["pi-utils", "utils"],
    ["pi-wire", "wire"],
  ]) {
    await rm(join(scope, name), { recursive: true, force: true });
    await symlink(join(SRC_DIR, "packages", dir), join(scope, name));
  }
  await rm(join(SRC_DIR, "node_modules"), { recursive: true, force: true });
  await symlink(join(DEPS_DIR, "node_modules"), join(SRC_DIR, "node_modules"));
}

/** Same steps as collab-web's `bun run build`, then swaps the result into collab-dist. */
async function buildPage(info: Omit<CollabBuildInfo, "inlineScriptHashes">): Promise<number> {
  const webDir = join(SRC_DIR, "packages", "collab-web");
  const tmpOut = `${OUT_DIR}.tmp`;
  await rm(tmpOut, { recursive: true, force: true });
  await run(
    [
      process.execPath,
      "build",
      "./index.html",
      `--outdir=${tmpOut}`,
      "--minify",
      "--define",
      'process.env.NODE_ENV="production"',
      "--entry-naming=[hash].[ext]",
      "--chunk-naming=[hash].[ext]",
      "--asset-naming=[hash].[ext]",
    ],
    webDir,
  );
  const htmlFiles = (await readdir(tmpOut)).filter((name) => name.endsWith(".html"));
  if (htmlFiles.length !== 1) throw new Error(`Expected one built HTML file, found: ${htmlFiles.join(", ") || "none"}`);
  await rename(join(tmpOut, htmlFiles[0]), join(tmpOut, "index.html"));
  await cp(join(webDir, "public"), tmpOut, { recursive: true });

  const indexHtml = await Bun.file(join(tmpOut, "index.html")).text();
  const buildInfo: CollabBuildInfo = { ...info, inlineScriptHashes: inlineScriptHashes(indexHtml) };
  await Bun.write(join(tmpOut, "build.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);

  const oldOut = `${OUT_DIR}.old`;
  await rm(oldOut, { recursive: true, force: true });
  if (existsSync(OUT_DIR)) await rename(OUT_DIR, oldOut);
  await rename(tmpOut, OUT_DIR);
  await rm(oldOut, { recursive: true, force: true });
  return (await readdir(OUT_DIR)).length;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

/** Takes LOCK_FILE, waiting while a live build holds it. A lock left by a killed build is removed. */
async function acquireLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let announced = false;
  for (;;) {
    try {
      await writeFile(LOCK_FILE, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
    const holder = Number.parseInt(await readFile(LOCK_FILE, "utf8").catch(() => ""), 10);
    const lockedAt = (await stat(LOCK_FILE).catch(() => null))?.mtimeMs ?? Date.now();
    const stale = holder > 0 ? !isAlive(holder) : Date.now() - lockedAt > LOCK_EMPTY_STALE_MS;
    if (stale) {
      await rm(LOCK_FILE, { force: true });
      continue;
    }
    const who = holder > 0 ? `pid ${holder}` : "starting";
    if (Date.now() > deadline) throw new Error(`another build (${who}) still holds ${LOCK_FILE}`);
    if (!announced) console.log(`Waiting for another build (${who})…`);
    announced = true;
    await Bun.sleep(500);
  }
}

try {
  await acquireLock();
  try {
    const version = parseOmpVersion(await run([OMP_BIN, "--version"]));
    if (!version) throw new Error(`Could not read a version from ${OMP_BIN} --version`);
    const current = parseBuildInfo(await Bun.file(join(OUT_DIR, "build.json")).text().catch(() => ""));
    if (process.argv.includes("--if-outdated") && current?.ompVersion === version) {
      console.log(`collab-dist is already built for omp ${version}.`);
    } else {
      const tag = `v${version}`;
      console.log(`Building the Collab page copy for omp ${version} (${tag})…`);
      const commit = await checkoutTag(tag);
      await applyPatch(tag);
      await installDeps();
      const fileCount = await buildPage({ ompVersion: version, tag, commit, builtAt: new Date().toISOString() });
      console.log(`Done: collab-dist holds ${fileCount} files for omp ${version} (${commit}). The dashboard uses it from the next tap.`);
    }
  } finally {
    // Remove the lock only while it is still ours.
    const holder = await readFile(LOCK_FILE, "utf8").catch(() => "");
    if (Number.parseInt(holder, 10) === process.pid) await rm(LOCK_FILE, { force: true });
  }
} catch (err) {
  console.error(`build-collab: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
