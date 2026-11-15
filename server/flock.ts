// Exclusive file lock that omp honours. On macOS omp serialises writers of a shared file
// (session-pins.json among them) by holding flock(2) on `<absolute path>.lock`, trying 50
// times 100 ms apart. Taking the same lock the same way keeps a dashboard write from
// racing an omp `/pin` and losing one of the two updates. On Linux omp locks with
// abstract sockets instead, so this helper only excludes omp on macOS.
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const ATTEMPTS = 50;
const RETRY_DELAY_MS = 100;

const libc = dlopen("libc.dylib", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/**
 * Runs `fn` while holding omp's exclusive lock for `filePath`. Throws when another
 * process keeps the lock through every attempt (about 5 s).
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${resolve(filePath)}.lock`;
  const fd = openSync(lockPath, "a", 0o600);
  try {
    let locked = false;
    for (let attempt = 0; attempt < ATTEMPTS && !locked; attempt++) {
      if (attempt > 0) await Bun.sleep(RETRY_DELAY_MS);
      // Bun's FFI does not expose errno. On a descriptor just opened for this file the
      // only failure flock reports in practice is EWOULDBLOCK (someone else holds it);
      // anything else also ends in the "could not lock" error below.
      locked = libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0;
    }
    if (!locked) {
      throw new Error(`Could not lock ${filePath}: another process held ${lockPath} for ${(ATTEMPTS * RETRY_DELAY_MS) / 1000}s`);
    }
    try {
      return await fn();
    } finally {
      libc.symbols.flock(fd, LOCK_UN);
    }
  } finally {
    closeSync(fd);
  }
}
