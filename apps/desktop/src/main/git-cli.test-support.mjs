// Shared fixtures for the git-cli suites. The tests are split across files so
// node's per-file parallelism can run them at the same time: the suite drives
// real git processes, which cost ~110ms each to spawn on win32, and a single
// file would run all of them in sequence.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as gitCli from "./git-cli.ts";

// ── Internal seams, reached through the module NAMESPACE ─────────────────────
// A named import of a seam the implementation does not export is a SyntaxError
// at MODULE LOAD: run against an older git-cli.ts, every test would fail with
// "does not provide an export", which proves nothing about behaviour — "these
// tests fail for the right reason" could not be checked at all. Through the
// namespace the old module still loads, every behavioural test still runs
// against it, and only a test that reaches for a seam that is not there fails,
// saying exactly that.
//
// MUTATION RUN — how to check these tests fail for the right reason:
//   1. copy git-cli.ts aside;
//   2. undo ONE behaviour in it, e.g. make the explicit-octal branch of
//      `sharedRepositoryMode` OR its tweak on (`mode | tweak`) instead of
//      setting it, or hand `applyPublishMode` the index's own mode as a
//      read-back allowance again, or drop an `export` keyword;
//   3. re-run the suites: the failures must name the behaviour (an assertion,
//      or "exports no <seam>() seam"), and the other tests must still run;
//   4. restore the copy.
export function seam(name) {
  const value = gitCli[name];
  if (typeof value !== "function") {
    throw new Error(
      `git-cli.ts exports no ${name}() seam, so the behaviour asserted here cannot be reached`,
    );
  }
  return value;
}

export const applyPublishMode = (...args) => seam("applyPublishMode")(...args);
export const assertCommitHooksRunnable = (...args) => seam("assertCommitHooksRunnable")(...args);
export const assertIndexLockFree = (...args) => seam("assertIndexLockFree")(...args);
export const cacheHookRunnerSupport = (...args) => seam("cacheHookRunnerSupport")(...args);
export const chmodErrorIsIgnorable = (...args) => seam("chmodErrorIsIgnorable")(...args);
export const executableHook = (...args) => seam("executableHook")(...args);
export const indexPublishMode = (...args) => seam("indexPublishMode")(...args);
export const missingHookRunner = (...args) => seam("missingHookRunner")(...args);
export const modeGrantsMoreThan = (...args) => seam("modeGrantsMoreThan")(...args);
export const sharedRepositoryMode = (...args) => seam("sharedRepositoryMode")(...args);
export const writeIndexBytes = (...args) => seam("writeIndexBytes")(...args);

// The mutable seams are objects, so a missing one has to fail on USE as well —
// never as an undefined that a test silently writes a property onto.
export function seamState(name) {
  const value = gitCli[name];
  if (value && typeof value === "object") return value;
  const missing = () => {
    throw new Error(`git-cli.ts exports no ${name} seam, so this test cannot drive it`);
  };
  // `delete` is answered instead of thrown: a cleanup block may not mask the
  // real failure with one of its own.
  return new Proxy({}, { get: missing, set: missing, deleteProperty: () => true });
}

export const commitRefreshProbe = seamState("commitRefreshProbe");
export const hookRunnerSupport = seamState("hookRunnerSupport");

// ── Platform coverage ────────────────────────────────────────────────────────
// win32 has no POSIX permission bits, no symlink a dangling `index.lock` could
// be, and no process groups. The tests that need them are marked `skip` rather
// than returning early, so a win32 run REPORTS them as skipped instead of
// counting a test that asserted nothing as a pass — and on Linux/macOS the same
// tests RUN.
//
// Only CI on Linux/macOS can therefore cover:
//   * the publish mode end to end — a real chmod on `.git/index.lock` and the
//     rename that makes it `.git/index`: that the index keeps 0660 under
//     `core.sharedRepository=group`, and that a competing writer's stricter
//     mode survives our publish;
//   * `indexPublishMode` consuming a real repository's config against the host
//     git (bare key, explicit empty value, zero-padded octal filemode);
//   * a DANGLING `.git/index.lock` symlink defeating git's O_CREAT|O_EXCL,
//     which is the whole reason the lock probe uses `lstat` and not `stat`;
//   * git's executable-bit hook rule.
// On win32 those paths are covered only as pure functions —
// `sharedRepositoryMode`, `applyPublishMode`, `chmodErrorIsIgnorable`,
// `modeGrantsMoreThan` and `assertIndexLockFree` with an injected probe — so a
// green win32 run is NOT evidence that the real chmod/rename path works.
export const POSIX_ONLY = process.platform === "win32"
  ? "POSIX-only: needs real permission bits, symlinks or process groups"
  : false;

export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout));
    });
  });
}

// The same child against a chosen index file, so a test can build a complete
// alternate index without touching the repository's own.
export function gitWithIndex(cwd, args, indexFile) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout));
    });
  });
}

export async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "mixdog-git-"));
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.name", "Mixdog Test"]);
  await git(cwd, ["config", "user.email", "mixdog@example.com"]);
  return cwd;
}

export async function commit(cwd, path, content, message) {
  await writeFile(join(cwd, path), content, "utf8");
  await git(cwd, ["add", "--", path]);
  await git(cwd, ["commit", "-m", message]);
}

// Probes the host git directly (never through gitBranches) so a parser
// regression fails the ahead/behind assertions instead of silently skipping.
// Capability is decided by the git VERSION (`%(ahead-behind:<commit>)` landed
// in git 2.31), not by catching exceptions: a spawn failure, a bad temp repo
// or a permission error cannot be read as "old git" because nothing here is
// caught — every such error propagates and fails the test. The one tolerated
// outcome is a parsed version below 2.31, which no runtime fault can fake.
export async function hostCountsAheadBehind(cwd) {
  const version = await git(cwd, ["--version"]);
  const parsed = /(\d+)\.(\d+)/.exec(version);
  if (!parsed) throw new Error(`unreadable git version: ${version.trim()}`);
  const [major, minor] = [Number(parsed[1]), Number(parsed[2])];
  if (major < 2 || (major === 2 && minor < 31)) return false;
  const raw = await git(cwd, [
    "for-each-ref",
    "--format=%(ahead-behind:HEAD)",
    "--count=1",
    "refs/heads",
  ]);
  // git >= 2.31 must answer "<ahead> <behind>"; anything else is a broken
  // probe, not a capability gap, so fail loudly instead of downgrading.
  assert.match(raw.trim(), /^\d+\s+\d+$/);
  return true;
}

// `git hook run` (git >= 2.36) is what keeps the repository's own hooks alive
// on a plumbing commit; below that version a repository that defines one is
// refused rather than committed with the hook skipped.
export async function hostRunsCommitHooks(cwd) {
  const version = await git(cwd, ["--version"]);
  const parsed = /(\d+)\.(\d+)/.exec(version);
  if (!parsed) throw new Error(`unreadable git version: ${version.trim()}`);
  const [major, minor] = [Number(parsed[1]), Number(parsed[2])];
  return major > 2 || (major === 2 && minor >= 36);
}

// Entry-level, which is what "the index is untouched" means: `git status`
// itself may rewrite the file to refresh stat data, but no entry of the
// user's may change mode, blob, stage or path.
export function indexEntries(cwd) {
  return git(cwd, ["ls-files", "--stage"]);
}

export async function writeHook(cwd, name, body) {
  await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
  const path = join(cwd, ".git", "hooks", name);
  await writeFile(path, body, "utf8");
  // posix git silently skips a hook without the execute bit, so a suite that
  // only ever ran on win32 (where the mode is ignored) proved nothing about the
  // hook paths it claims to cover.
  await chmod(path, 0o755);
  return path;
}
