import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as gitCli from "./git-cli.ts";
import { buildGhPrCreateArgs } from "./gh-cli.ts";
import {
  GIT_RESET_DIRTY_CODE,
  gitAmend,
  gitApplyPatch,
  gitBranches,
  gitCheckoutBranch,
  gitCheckoutCommit,
  gitCherryPickCommit,
  gitCommitPaths,
  gitContinue,
  gitCreateBranch,
  gitCreateBranchAtCommit,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteTag,
  gitDiff,
  gitLog,
  gitAbortOperation,
  gitFetch,
  gitIgnore,
  gitMergeBranch,
  gitPull,
  gitRenameBranch,
  gitReview,
  gitResetToCommit,
  gitRevertCommit,
  gitRevertFile,
  gitShow,
  gitShowDiff,
  gitStage,
  gitStash,
  gitStashPop,
  gitStatus,
  gitSync,
  gitUndoLastCommit,
  gitUnstage,
} from "./git-cli.ts";
import { createRemoteMethods, executeRemoteFrame } from "./remote-methods.ts";
import { splitGitPatchHunks } from "../shared/git-patch.ts";

// ── Internal seams, reached through the module NAMESPACE ─────────────────────
// A named import of a seam the implementation does not export is a SyntaxError
// at MODULE LOAD: run against an older git-cli.ts, every test in this file
// would fail with "does not provide an export", which proves nothing about
// behaviour — "these tests fail for the right reason" could not be checked at
// all. Through the namespace the old module still loads, every behavioural
// test still runs against it, and only a test that reaches for a seam that is
// not there fails, saying exactly that.
//
// MUTATION RUN — how to check these tests fail for the right reason:
//   1. copy git-cli.ts aside;
//   2. undo ONE behaviour in it, e.g. make the explicit-octal branch of
//      `sharedRepositoryMode` OR its tweak on (`mode | tweak`) instead of
//      setting it, or hand `applyPublishMode` the index's own mode as a
//      read-back allowance again, or drop an `export` keyword;
//   3. `node --test apps/desktop/src/main/git-cli.test.mjs`: the failures must
//      name the behaviour (an assertion, or "exports no <seam>() seam"), and
//      the other tests must still run;
//   4. restore the copy.
function seam(name) {
  const value = gitCli[name];
  if (typeof value !== "function") {
    throw new Error(
      `git-cli.ts exports no ${name}() seam, so the behaviour asserted here cannot be reached`,
    );
  }
  return value;
}

const applyPublishMode = (...args) => seam("applyPublishMode")(...args);
const assertCommitHooksRunnable = (...args) => seam("assertCommitHooksRunnable")(...args);
const assertIndexLockFree = (...args) => seam("assertIndexLockFree")(...args);
const cacheHookRunnerSupport = (...args) => seam("cacheHookRunnerSupport")(...args);
const chmodErrorIsIgnorable = (...args) => seam("chmodErrorIsIgnorable")(...args);
const executableHook = (...args) => seam("executableHook")(...args);
const indexPublishMode = (...args) => seam("indexPublishMode")(...args);
const missingHookRunner = (...args) => seam("missingHookRunner")(...args);
const modeGrantsMoreThan = (...args) => seam("modeGrantsMoreThan")(...args);
const sharedRepositoryMode = (...args) => seam("sharedRepositoryMode")(...args);
const writeIndexBytes = (...args) => seam("writeIndexBytes")(...args);

// The mutable seams are objects, so a missing one has to fail on USE as well —
// never as an undefined that a test silently writes a property onto.
function seamState(name) {
  const value = gitCli[name];
  if (value && typeof value === "object") return value;
  const missing = () => {
    throw new Error(`git-cli.ts exports no ${name} seam, so this test cannot drive it`);
  };
  // `delete` is answered instead of thrown: a cleanup block may not mask the
  // real failure with one of its own.
  return new Proxy({}, { get: missing, set: missing, deleteProperty: () => true });
}

const commitRefreshProbe = seamState("commitRefreshProbe");
const hookRunnerSupport = seamState("hookRunnerSupport");

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
//     mode survives our publish ("the index publish mode is decided under the
//     lock", whose mode assertions are POSIX-only inside a test that otherwise
//     runs everywhere);
//   * `indexPublishMode` consuming a real repository's config against the host
//     git (bare key, explicit empty value, zero-padded octal filemode);
//   * a DANGLING `.git/index.lock` symlink defeating git's O_CREAT|O_EXCL,
//     which is the whole reason the lock probe uses `lstat` and not `stat`;
//   * git's executable-bit hook rule (the POSIX half of "a commit hook counts
//     only when git itself would run it", which still returns early because a
//     win32 host cannot make a hook non-executable in the first place).
// On win32 those paths are covered only as pure functions —
// `sharedRepositoryMode`, `applyPublishMode`, `chmodErrorIsIgnorable`,
// `modeGrantsMoreThan` and `assertIndexLockFree` with an injected probe — so a
// green win32 run is NOT evidence that the real chmod/rename path works.
const POSIX_ONLY = process.platform === "win32"
  ? "POSIX-only: needs real permission bits, symlinks or process groups"
  : false;

test("pull request creation builds the gh payload without a browser", () => {
  assert.deepEqual(buildGhPrCreateArgs({
    base: "main",
    head: "e2e-secondary",
    title: "E2e secondary",
    body: "- Initial commit for E2E",
    draft: true,
  }), [
    "pr", "create",
    "--base", "main",
    "--head", "e2e-secondary",
    "--title", "E2e secondary",
    "--body", "- Initial commit for E2E",
    "--draft",
  ]);
  assert.throws(() => buildGhPrCreateArgs({
    base: "main",
    head: "main",
    title: "Invalid",
  }), /must differ/);
  assert.throws(() => buildGhPrCreateArgs({
    base: "main",
    head: "feature",
    title: "Invalid",
    unexpected: true,
  }), /unsupported field/);
  assert.throws(() => buildGhPrCreateArgs({
    base: "main",
    head: "feature",
    title: "Invalid",
    body: { markdown: true },
  }), /body must be a string/);
});

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout));
    });
  });
}

// The same child against a chosen index file, so a test can build a complete
// alternate index without touching the repository's own.
function gitWithIndex(cwd, args, indexFile) {
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

async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "mixdog-git-"));
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.name", "Mixdog Test"]);
  await git(cwd, ["config", "user.email", "mixdog@example.com"]);
  return cwd;
}

async function commit(cwd, path, content, message) {
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
async function hostCountsAheadBehind(cwd) {
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

test("git status recognizes unborn repositories and unstages without HEAD", async () => {
  const cwd = await createRepository();
  try {
    const empty = await gitStatus(cwd);
    assert.equal(empty.repository, true);
    assert.equal(empty.branch, "main");
    assert.equal(empty.unborn, true);

    await writeFile(join(cwd, "first.txt"), "one\n", "utf8");
    await gitStage(cwd, ["first.txt"]);
    const staged = await gitStatus(cwd);
    assert.equal(staged.files[0]?.index, "A");
    assert.equal(staged.files[0]?.stagedAdditions, 1);

    await gitUnstage(cwd, ["first.txt"]);
    const unstaged = await gitStatus(cwd);
    assert.equal(unstaged.files[0]?.untracked, true);
    assert.equal(unstaged.files[0]?.unstagedAdditions, 1);

    await mkdir(join(cwd, "nested"), { recursive: true });
    await writeFile(join(cwd, "nested", "child.txt"), "child\n", "utf8");
    const nested = await gitStatus(cwd);
    assert.ok(nested.files.some((file) => file.path.replace(/\\/g, "/") === "nested/child.txt"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("worktree discard preserves staged changes and rename paths stay actionable", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "file.txt", "one\n", "Initial");
    await writeFile(join(cwd, "file.txt"), "one\ntwo\n", "utf8");
    await gitStage(cwd, ["file.txt"]);
    await writeFile(join(cwd, "file.txt"), "one\ntwo\nthree\n", "utf8");

    const mixed = await gitStatus(cwd);
    const file = mixed.files.find((entry) => entry.path === "file.txt");
    assert.equal(file?.stagedAdditions, 1);
    assert.equal(file?.unstagedAdditions, 1);

    await gitRevertFile(cwd, "file.txt", false, "worktree");
    assert.equal((await readFile(join(cwd, "file.txt"), "utf8").then((text) =>
      text.replace(/\r\n/g, "\n"))), "one\ntwo\n");
    assert.match(await git(cwd, ["diff", "--cached", "--", "file.txt"]), /^\+two$/m);

    await gitRevertFile(cwd, "file.txt", false, "all");
    await rename(join(cwd, "file.txt"), join(cwd, "renamed.txt"));
    await gitStage(cwd, ["file.txt", "renamed.txt"]);
    const renamed = (await gitStatus(cwd)).files.find((entry) => entry.path === "renamed.txt");
    assert.equal(renamed?.oldPath, "file.txt");
    assert.equal(renamed?.index, "R");
    await gitUnstage(cwd, ["file.txt", "renamed.txt"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ignore adds one repository-rooted exact pattern without duplicating it", async () => {
  const cwd = await createRepository();
  try {
    await mkdir(join(cwd, "generated"), { recursive: true });
    await writeFile(join(cwd, "generated", "cache[1].txt"), "cache\n", "utf8");
    await gitIgnore(cwd, "generated/cache[1].txt");
    await gitIgnore(cwd, "generated/cache[1].txt");
    assert.equal(
      await readFile(join(cwd, ".gitignore"), "utf8"),
      "/generated/cache\\[1\\].txt\n",
    );
    assert.equal((await gitStatus(cwd)).files.some((file) =>
      file.path === "generated/cache[1].txt"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ignore writes an unanchored extension rule beside the rooted file rule", async () => {
  const cwd = await createRepository();
  try {
    await mkdir(join(cwd, "logs"), { recursive: true });
    await writeFile(join(cwd, "logs", "run.log"), "noise\n", "utf8");
    await gitIgnore(cwd, "logs/run.log", "extension");
    await gitIgnore(cwd, "logs/run.log", "extension");
    assert.equal(await readFile(join(cwd, ".gitignore"), "utf8"), "*.log\n");
    assert.equal((await gitStatus(cwd)).files.some((file) =>
      file.path === "logs/run.log"), false);

    // The file scope stays byte-identical: rooted and escaped.
    await gitIgnore(cwd, "logs/run.log");
    assert.equal(await readFile(join(cwd, ".gitignore"), "utf8"), "*.log\n/logs/run.log\n");

    // Only the literal extension text is escaped; the leading `*` is pattern.
    await gitIgnore(cwd, "weird/name.a[1]", "extension");
    assert.equal(
      await readFile(join(cwd, ".gitignore"), "utf8"),
      "*.log\n/logs/run.log\n*.a\\[1\\]\n",
    );

    // Nothing to ignore by extension, and no third scope to smuggle in.
    await assert.rejects(() => gitIgnore(cwd, "Makefile", "extension"), TypeError);
    await assert.rejects(() => gitIgnore(cwd, ".gitignore", "extension"), TypeError);
    await assert.rejects(() => gitIgnore(cwd, "logs/run.", "extension"), TypeError);
    await assert.rejects(() => gitIgnore(cwd, "logs/run.log", "pattern"), TypeError);
    assert.equal(
      await readFile(join(cwd, ".gitignore"), "utf8"),
      "*.log\n/logs/run.log\n*.a\\[1\\]\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("history separates tag decorations from branches, commas included", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "tagged.txt", "one\n", "Tagged");
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await gitCreateTag(cwd, "v1.0.0", head);
    // A tag name may contain a comma: `%D` is ", " separated, so a
    // /tag: ([^\s,]+)/ regex would clip this one in half.
    await git(cwd, ["tag", "release,rc1"]);

    const [entry] = await gitLog(cwd, "", 0, 1);
    assert.deepEqual([...entry.tags].sort(), ["release,rc1", "v1.0.0"]);
    assert.deepEqual(entry.branches, ["main"]);
    assert.deepEqual(entry.remotes, []);
    // The flattened list stays available for existing consumers.
    for (const ref of ["main", "v1.0.0", "release,rc1"]) {
      assert.equal(entry.refs.includes(ref), true, `refs should still carry ${ref}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("partial patches stage and unstage one hunk without touching neighboring work", async () => {
  const cwd = await createRepository();
  try {
    const base = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    await commit(cwd, "partial.txt", `${base.join("\n")}\n`, "Initial");
    const changed = [...base];
    changed[1] = "changed near top";
    changed[18] = "changed near bottom";
    await writeFile(join(cwd, "partial.txt"), `${changed.join("\n")}\n`, "utf8");

    const hunks = splitGitPatchHunks(await gitDiff(cwd, "partial.txt", false, true));
    assert.equal(hunks.length, 2);
    await gitApplyPatch(cwd, "partial.txt", hunks[0].patch);
    const partiallyStaged = (await gitStatus(cwd)).files[0];
    assert.equal(partiallyStaged?.stagedAdditions, 1);
    assert.equal(partiallyStaged?.unstagedAdditions, 1);

    const stagedHunks = splitGitPatchHunks(await gitDiff(cwd, "partial.txt", true));
    assert.equal(stagedHunks.length, 1);
    await gitApplyPatch(cwd, "partial.txt", stagedHunks[0].patch, true);
    const unstaged = (await gitStatus(cwd)).files[0];
    assert.equal(unstaged?.stagedAdditions, 0);
    assert.equal(unstaged?.unstagedAdditions, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("display diffs ignore configured external diff and textconv commands", async () => {
  const cwd = await createRepository();
  try {
    await writeFile(join(cwd, ".gitattributes"), [
      "external.txt diff=mixdog-external",
      "textconv.txt diff=mixdog-textconv",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(cwd, "external.txt"), "one\n", "utf8");
    await writeFile(join(cwd, "textconv.txt"), "one\n", "utf8");
    await git(cwd, ["add", "--", ".gitattributes", "external.txt", "textconv.txt"]);
    await git(cwd, ["commit", "-m", "Initial diff drivers"]);
    await git(cwd, [
      "config",
      "diff.mixdog-external.command",
      "mixdog-command-that-must-not-run",
    ]);
    await git(cwd, [
      "config",
      "diff.mixdog-textconv.textconv",
      "mixdog-textconv-that-must-not-run",
    ]);

    await writeFile(join(cwd, "external.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(cwd, "textconv.txt"), "one\ntwo\n", "utf8");
    assert.match(await gitDiff(cwd, "external.txt", false, true), /^\+two$/m);
    assert.match(await gitDiff(cwd, "textconv.txt", false, true), /^\+two$/m);

    await git(cwd, ["add", "--", "external.txt"]);
    await git(cwd, ["commit", "-m", "External diff change"]);
    const hash = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    assert.match(await gitShowDiff(cwd, hash, "external.txt"), /^\+two$/m);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("review collects tracked and untracked line stats from one parallel refresh", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "tracked.txt", "one\n", "Initial");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(cwd, "untracked.txt"), "alpha\nbeta\n", "utf8");
    const review = await gitReview(cwd);
    assert.equal(review.base, "HEAD");
    assert.deepEqual(
      review.files.map((file) => ({
        path: file.path,
        additions: file.additions,
        untracked: file.untracked,
        uncommitted: file.uncommitted,
      })),
      [
        { path: "tracked.txt", additions: 1, untracked: false, uncommitted: true },
        { path: "untracked.txt", additions: 2, untracked: true, uncommitted: true },
      ],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("status reuses line stats only while the changed-file shape is stable", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "tracked.txt", "one\n", "Initial");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n", "utf8");
    const fresh = await gitStatus(cwd);
    const cached = await gitStatus(cwd, { reuseLineStats: true });
    assert.equal(cached.files[0]?.unstagedAdditions, fresh.files[0]?.unstagedAdditions);

    await writeFile(join(cwd, "untracked.txt"), "alpha\nbeta\n", "utf8");
    const changedShape = await gitStatus(cwd, { reuseLineStats: true });
    assert.equal(
      changedShape.files.find((file) => file.path === "untracked.txt")?.unstagedAdditions,
      2,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("history returns commit metadata, changed files, and lazy per-file patches", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "history.txt", "one\n", "Initial");
    await commit(cwd, "history.txt", "one\ntwo\n", "Second");

    const history = await gitLog(cwd);
    assert.equal(history[0]?.subject, "Second");
    assert.equal(history[0]?.author, "Mixdog Test");
    assert.equal(history[0]?.pushed, false);
    assert.equal(history[0]?.parents.length, 1);
    await git(cwd, ["tag", "v-test"]);
    assert.ok((await gitLog(cwd, "Second", 0, 1))[0]?.refs.includes("v-test"));

    const detail = await gitShow(cwd, history[0].hash);
    assert.equal(detail.subject, "Second");
    assert.equal(detail.files[0]?.path, "history.txt");
    assert.equal(detail.files[0]?.additions, 1);
    assert.match(await gitShowDiff(cwd, history[0].hash, "history.txt"), /^\+two$/m);

    await git(cwd, ["checkout", "--detach", "HEAD~1"]);
    const detached = await gitStatus(cwd);
    assert.equal(detached.repository, true);
    assert.equal(detached.detached, true);
    assert.match(detached.branch, /^HEAD \(/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remote actions fetch, pull, and sync without terminal prompts", async () => {
  const cwd = await createRepository();
  const remote = await mkdtemp(join(tmpdir(), "mixdog-git-remote-"));
  const peer = await mkdtemp(join(tmpdir(), "mixdog-git-peer-"));
  try {
    await git(remote, ["init", "--bare"]);
    await commit(cwd, "remote.txt", "one\n", "Initial");
    await git(cwd, ["remote", "add", "origin", remote]);
    await git(cwd, ["push", "-u", "origin", "main"]);
    await git(peer, ["clone", remote, "."]);
    await git(peer, ["config", "user.name", "Mixdog Peer"]);
    await git(peer, ["config", "user.email", "peer@example.com"]);
    await commit(peer, "remote.txt", "one\ntwo\n", "Peer change");
    await git(peer, ["push"]);

    await gitFetch(cwd);
    assert.equal((await gitStatus(cwd)).behind, 1);
    await gitPull(cwd);
    assert.equal((await gitStatus(cwd)).behind, 0);
    await commit(cwd, "local.txt", "local\n", "Local change");
    await gitSync(cwd);
    assert.equal((await gitStatus(cwd)).ahead, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  }
});

test("branch operations cover local and remote checkout without losing work", async () => {
  const cwd = await createRepository();
  const remote = await mkdtemp(join(tmpdir(), "mixdog-git-branch-remote-"));
  const peer = await mkdtemp(join(tmpdir(), "mixdog-git-branch-peer-"));
  try {
    await git(remote, ["init", "--bare"]);
    await commit(cwd, "branch.txt", "main\n", "Initial");
    await git(cwd, ["remote", "add", "origin", remote]);
    await git(cwd, ["push", "-u", "origin", "main"]);

    await gitCreateBranch(cwd, "feature/local");
    assert.equal((await gitBranches(cwd)).find((branch) => branch.current)?.name, "feature/local");
    await gitRenameBranch(cwd, "feature/local", "feature/renamed");
    await gitCheckoutBranch(cwd, "main");
    await gitDeleteBranch(cwd, "feature/renamed");
    assert.equal((await gitBranches(cwd)).some((branch) => branch.name === "feature/renamed"), false);

    await git(peer, ["clone", remote, "."]);
    await git(peer, ["config", "user.name", "Mixdog Peer"]);
    await git(peer, ["config", "user.email", "peer@example.com"]);
    await git(peer, ["switch", "-c", "review"]);
    await commit(peer, "review.txt", "review\n", "Review");
    await git(peer, ["push", "-u", "origin", "review"]);
    await gitFetch(cwd);
    assert.ok((await gitBranches(cwd)).some((branch) =>
      branch.remote && branch.name === "origin/review"));
    await gitCheckoutBranch(cwd, "origin/review", true);
    assert.equal((await gitStatus(cwd)).branch, "review");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  }
});

test("stash, amend, and undo last commit preserve recoverable changes", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "daily.txt", "one\n", "Initial");
    await writeFile(join(cwd, "daily.txt"), "one\ntwo\n", "utf8");
    await gitStash(cwd, "daily work");
    assert.equal((await gitStatus(cwd)).files.length, 0);
    await gitStashPop(cwd);
    assert.equal((await gitStatus(cwd)).files[0]?.unstagedAdditions, 1);

    await gitStage(cwd, ["daily.txt"]);
    await git(cwd, ["commit", "-m", "Daily"]);
    await gitAmend(cwd, "Daily amended");
    assert.equal((await gitLog(cwd, "", 0, 1))[0]?.subject, "Daily amended");
    await gitUndoLastCommit(cwd);
    const undone = await gitStatus(cwd);
    assert.equal(undone.files[0]?.stagedAdditions, 1);
    assert.equal((await gitLog(cwd, "", 0, 1))[0]?.subject, "Initial");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("status exposes merge conflicts and abort restores a clean operation state", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "conflict.txt", "base\n", "Base");
    await git(cwd, ["checkout", "-b", "feature"]);
    await commit(cwd, "conflict.txt", "feature\n", "Feature");
    await git(cwd, ["checkout", "main"]);
    await commit(cwd, "conflict.txt", "main\n", "Main");
    await git(cwd, ["merge", "feature"]).catch(() => "");
    const conflicted = await gitStatus(cwd);
    assert.equal(conflicted.operation, "merge");
    assert.equal(conflicted.files[0]?.conflicted, true);
    await gitAbortOperation(cwd);
    assert.equal((await gitStatus(cwd)).operation, "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("merge folds a branch into the current one and reports conflicts as errors", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "merge.txt", "base\n", "Base");
    await git(cwd, ["checkout", "-b", "feature"]);
    await commit(cwd, "feature.txt", "feature\n", "Feature");
    await git(cwd, ["checkout", "main"]);
    const merged = await gitMergeBranch(cwd, "feature");
    assert.match(merged, /feature\.txt|Fast-forward/);
    assert.equal((await gitStatus(cwd)).files.length, 0);
    assert.equal(
      (await readFile(join(cwd, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "feature\n",
    );
    assert.match(await gitMergeBranch(cwd, "feature"), /Already up to date/i);

    await git(cwd, ["checkout", "-b", "rival"]);
    await commit(cwd, "merge.txt", "rival\n", "Rival");
    await git(cwd, ["checkout", "main"]);
    await commit(cwd, "merge.txt", "mainline\n", "Mainline");
    await assert.rejects(
      () => gitMergeBranch(cwd, "rival"),
      (error) => /conflicts/i.test(error.message) && /merge\.txt/.test(error.message),
    );
    const conflicted = await gitStatus(cwd);
    assert.equal(conflicted.operation, "merge");
    assert.equal(conflicted.files[0]?.conflicted, true);

    // A live operation must never be stacked under a second merge.
    await assert.rejects(
      () => gitMergeBranch(cwd, "rival"),
      (error) => /merge is already in progress/i.test(error.message),
    );
    assert.equal((await gitStatus(cwd)).operation, "merge");
    await gitAbortOperation(cwd);
    assert.equal((await gitStatus(cwd)).operation, "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("merge refuses to run over uncommitted changes and leaves them untouched", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "shared.txt", "base\n", "Base");
    await git(cwd, ["checkout", "-b", "incoming"]);
    await commit(cwd, "incoming.txt", "incoming\n", "Incoming");
    await git(cwd, ["checkout", "main"]);

    await writeFile(join(cwd, "shared.txt"), "base\nlocal work\n", "utf8");
    await writeFile(join(cwd, "scratch.txt"), "untracked\n", "utf8");
    await assert.rejects(
      () => gitMergeBranch(cwd, "incoming"),
      (error) => /uncommitted changes/i.test(error.message)
        && /shared\.txt/.test(error.message),
    );
    const untouched = await gitStatus(cwd);
    assert.equal(untouched.operation, "");
    assert.equal(untouched.files.length, 2);
    assert.equal(
      (await readFile(join(cwd, "shared.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "base\nlocal work\n",
    );
    assert.equal(await gitStatus(cwd).then((status) => status.files.some((file) =>
      file.path === "incoming.txt")), false);

    await gitStash(cwd, "before merge");
    assert.match(await gitMergeBranch(cwd, "incoming"), /incoming\.txt|Fast-forward/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("branch rows carry tip age and ahead/behind against the current branch", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "age.txt", "one\n", "Initial");
    await git(cwd, ["checkout", "-b", "topic"]);
    await commit(cwd, "age.txt", "one\ntwo\n", "Topic");
    await git(cwd, ["checkout", "main"]);

    const branches = await gitBranches(cwd);
    const topic = branches.find((branch) => branch.name === "topic");
    const main = branches.find((branch) => branch.name === "main");
    assert.match(topic?.lastCommitRelative ?? "", /ago$/);
    assert.match(topic?.lastCommitAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(main?.current, true);
    // Capability comes from the host git, not from the parser output, so a
    // broken `%(ahead-behind:HEAD)` read fails here instead of skipping.
    if (await hostCountsAheadBehind(cwd)) {
      assert.equal(topic?.ahead, 1);
      assert.equal(topic?.behind, 0);
      assert.equal(main?.ahead, 0);
      assert.equal(main?.behind, 0);
    } else {
      assert.equal(topic?.ahead, undefined);
      assert.equal(topic?.behind, undefined);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// `git commit -m <message> -- <paths>` commits the WORKTREE content of the
// listed paths (a partially staged file goes in whole) and leaves every other
// index entry exactly as it was — the semantics the dock commits against.
test("pathspec commit takes worktree content and leaves other index entries alone", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "selected.txt", "base\n", "Base");
    await commit(cwd, "other.txt", "other\n", "Other");
    await writeFile(join(cwd, "selected.txt"), "base\nstaged\n", "utf8");
    await gitStage(cwd, ["selected.txt"]);
    await writeFile(join(cwd, "selected.txt"), "base\nstaged\nworktree\n", "utf8");
    // The unrelated file keeps DISTINCT staged and worktree content, so a
    // stray `git add -A` (or any index churn) shows up as a changed blob.
    await writeFile(join(cwd, "other.txt"), "other\nstaged elsewhere\n", "utf8");
    await gitStage(cwd, ["other.txt"]);
    await writeFile(join(cwd, "other.txt"), "other\nstaged elsewhere\nworktree only\n", "utf8");

    await gitCommitPaths(cwd, "Selected only", ["selected.txt"]);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "selected.txt",
    );
    assert.equal(
      (await git(cwd, ["show", "HEAD:selected.txt"])).replace(/\r\n/g, "\n"),
      "base\nstaged\nworktree\n",
    );
    const after = await gitStatus(cwd);
    assert.equal(after.files.some((file) => file.path === "selected.txt"), false);
    const other = after.files.find((file) => file.path === "other.txt");
    assert.equal(other?.index, "M");
    assert.equal(other?.worktree, "M");
    assert.equal(other?.stagedAdditions, 1);
    assert.equal(other?.unstagedAdditions, 1);
    assert.equal(
      (await git(cwd, ["show", ":other.txt"])).replace(/\r\n/g, "\n"),
      "other\nstaged elsewhere\n",
    );
    assert.equal(
      (await readFile(join(cwd, "other.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "other\nstaged elsewhere\nworktree only\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Rejections are ordered: message, empty list, invalid path, unknown path,
// conflicted path, operation in progress. Each case below also satisfies the
// LATER ones, so a reordering regression fails here.
test("pathspec commit rejects in a fixed order", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "clash.txt", "base\n", "Base");
    await commit(cwd, "clean.txt", "clean\n", "Clean");
    await git(cwd, ["checkout", "-b", "feature"]);
    await commit(cwd, "clash.txt", "feature\n", "Feature");
    await git(cwd, ["checkout", "main"]);
    await commit(cwd, "clash.txt", "main\n", "Main");
    await git(cwd, ["merge", "feature"]).catch(() => "");
    assert.equal((await gitStatus(cwd)).operation, "merge");

    await assert.rejects(() => gitCommitPaths(cwd, "   ", []), /commit message/i);
    await assert.rejects(() => gitCommitPaths(cwd, "Msg", []), /at least one file/i);
    await assert.rejects(() => gitCommitPaths(cwd, "Msg", [""]), /at least one file/i);
    await assert.rejects(
      () => gitCommitPaths(cwd, "Msg", ["gone.txt", "clash.txt", "--amend"]),
      /path is invalid/i,
    );
    await assert.rejects(() => gitCommitPaths(cwd, "Msg", ["../escape.txt"]), /path is invalid/i);
    await assert.rejects(
      () => gitCommitPaths(cwd, "Msg", ["clash.txt", "gone.txt"]),
      /not in this repository/i,
    );
    await assert.rejects(
      () => gitCommitPaths(cwd, "Msg", ["clash.txt"]),
      (error) => /resolve the conflict/i.test(error.message) && /clash\.txt/.test(error.message),
    );
    await assert.rejects(() => gitCommitPaths(cwd, "Msg", ["clean.txt"]), /merge is in progress/i);
    assert.equal((await gitStatus(cwd)).operation, "merge");
    await gitAbortOperation(cwd);
    assert.equal((await gitStatus(cwd)).operation, "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pathspec commit closes renames from either form, staged or worktree-only", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "rename-src.txt", "one\n", "Base");
    await rename(join(cwd, "rename-src.txt"), join(cwd, "rename-dst.txt"));
    await gitStage(cwd, ["rename-src.txt", "rename-dst.txt"]);
    await writeFile(join(cwd, "fresh.txt"), "fresh\n", "utf8");

    // The old path is enough: both halves of the staged rename land together.
    await gitCommitPaths(cwd, "Rename via old path", ["rename-src.txt"]);
    assert.match(
      await git(cwd, ["show", "--name-status", "--format=", "HEAD"]),
      /^R\d*\s+rename-src\.txt\s+rename-dst\.txt$/m,
    );
    const afterRename = await gitStatus(cwd);
    assert.equal(afterRename.files.length, 1);
    assert.equal(afterRename.files[0]?.path, "fresh.txt");

    // A brand-new file commits without staging anything else.
    await gitCommitPaths(cwd, "New file", ["fresh.txt"]);
    assert.equal((await gitStatus(cwd)).files.length, 0);

    // A move git has NOT detected is two independent changes. Passing only the
    // destination commits only the addition — no silent widening — and the
    // pending deletion then commits from its own path alone.
    await rename(join(cwd, "rename-dst.txt"), join(cwd, "rename-final.txt"));
    await gitCommitPaths(cwd, "Add the moved file", ["rename-final.txt"]);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "rename-final.txt",
    );
    const pending = await gitStatus(cwd);
    assert.equal(pending.files.length, 1);
    assert.equal(pending.files[0]?.path, "rename-dst.txt");
    await gitCommitPaths(cwd, "Drop the old path", ["rename-dst.txt"]);
    assert.equal((await gitStatus(cwd)).files.length, 0);

    // Once git itself reports the rename (porcelain ".R"), ONE form is enough:
    // the old path alone still closes both halves in a single commit.
    await rename(join(cwd, "rename-final.txt"), join(cwd, "rename-last.txt"));
    await git(cwd, ["add", "-N", "--", "rename-last.txt"]);
    assert.equal(
      (await gitStatus(cwd)).files.find((file) => file.path === "rename-last.txt")?.oldPath,
      "rename-final.txt",
    );
    await gitCommitPaths(cwd, "Detected rename", ["rename-final.txt"]);
    assert.equal((await gitStatus(cwd)).files.length, 0);
    assert.match(await git(cwd, ["ls-files"]), /^rename-last\.txt$/m);
    assert.equal((await git(cwd, ["ls-files"])).includes("rename-final.txt"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// The commit is assembled in a scratch index outside the repository, so the
// user's index is only ever written AFTER the commit landed — and then only
// for the paths the commit actually wrote.
test("pathspec commit keeps a concurrent stage in the real index intact", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    await writeFile(join(cwd, "selected.txt"), "selected\n", "utf8");
    await writeFile(join(cwd, "unrelated.txt"), "unrelated\n", "utf8");
    // A clean filter parks the scratch-index `git add` long enough for an
    // outside `git add` to land in the REAL index mid-commit. A design that
    // snapshotted or rewrote that index would lose the concurrent entry.
    await git(cwd, ["config", "filter.park.clean", "sh -c 'sleep 3; cat'"]);
    await writeFile(join(cwd, ".gitattributes"), "selected.txt filter=park\n", "utf8");

    const inflight = gitCommitPaths(cwd, "Selected", ["selected.txt"]);
    await new Promise((wait) => setTimeout(wait, 1_000));
    await git(cwd, ["add", "--", "unrelated.txt"]);
    const stagedDuring = await git(cwd, ["ls-files", "-s", "--", "unrelated.txt"]);
    assert.match(stagedDuring, /unrelated\.txt/);
    await inflight;

    assert.equal(await git(cwd, ["ls-files", "-s", "--", "unrelated.txt"]), stagedDuring);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "selected.txt",
    );
    // The committed path is the only index entry the commit refreshed.
    const after = await gitStatus(cwd);
    assert.equal(after.files.some((file) => file.path === "selected.txt"), false);
    assert.equal(after.files.find((file) => file.path === "unrelated.txt")?.index, "A");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("pathspec commit commits untracked files and an unborn HEAD", async () => {
  const cwd = await createRepository();
  try {
    await writeFile(join(cwd, "first.txt"), "first\n", "utf8");
    await writeFile(join(cwd, "spare.txt"), "spare\n", "utf8");
    assert.equal(await git(cwd, ["ls-files"]), "");

    const summary = await gitCommitPaths(cwd, "First commit", ["first.txt"]);
    assert.match(summary, /root-commit/);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "first.txt",
    );
    // The unborn branch is born, its reflog reads like git's own, and the
    // untracked file that was NOT selected stays untracked.
    assert.equal((await git(cwd, ["log", "-g", "-1", "--format=%gs", "HEAD"])).trim(),
      "commit (initial): First commit");
    const afterFirst = await gitStatus(cwd);
    assert.equal(afterFirst.unborn, false);
    assert.equal(afterFirst.files.length, 1);
    assert.equal(afterFirst.files[0]?.path, "spare.txt");
    assert.equal(afterFirst.files[0]?.untracked, true);

    // An intent-to-add marker the USER made commits its real content and is
    // left as a normal tracked entry afterwards.
    await writeFile(join(cwd, "marked.txt"), "marked\n", "utf8");
    await git(cwd, ["add", "-N", "--", "marked.txt"]);
    await gitCommitPaths(cwd, "User marker", ["marked.txt"]);
    assert.equal(
      (await git(cwd, ["show", "HEAD:marked.txt"])).replace(/\r\n/g, "\n"),
      "marked\n",
    );
    assert.equal((await gitStatus(cwd)).files.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pathspec commit moves the branch from the current HEAD and logs both reflogs", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    const before = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "seed.txt"), "seed\nmore\n", "utf8");

    await gitCommitPaths(cwd, "Second subject\n\nbody line\n", ["seed.txt"]);
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    assert.notEqual(head, before);
    assert.equal((await git(cwd, ["rev-parse", "HEAD^"])).trim(), before);
    assert.equal((await git(cwd, ["rev-parse", "refs/heads/main"])).trim(), head);
    assert.equal((await git(cwd, ["log", "-g", "-1", "--format=%gs", "HEAD"])).trim(),
      "commit: Second subject");
    assert.equal((await git(cwd, ["log", "-g", "-1", "--format=%gs", "refs/heads/main"])).trim(),
      "commit: Second subject");
    // Identity and message body come from git itself, exactly as `commit -m`.
    assert.equal((await git(cwd, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).trim(),
      "Mixdog Test <mixdog@example.com>|Mixdog Test <mixdog@example.com>");
    assert.equal((await git(cwd, ["log", "-1", "--format=%B"])).replace(/\r\n/g, "\n"),
      "Second subject\n\nbody line\n\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// `git commit -m` cleans the message with `stripspace` (no editor, so comment
// lines are KEPT); the plumbing path has to do the same by hand.
test("pathspec commit applies git's own -m message cleanup", async () => {
  const cwd = await createRepository();
  try {
    await writeFile(join(cwd, "file.txt"), "one\n", "utf8");
    await gitCommitPaths(cwd, "Subject   \n\n\n\n# kept comment\nbody   \n\n\n", ["file.txt"]);
    assert.equal((await git(cwd, ["log", "-1", "--format=%B"])).replace(/\r\n/g, "\n"),
      "Subject\n\n# kept comment\nbody\n\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// `git hook run` (git >= 2.36) is what keeps the repository's own hooks alive
// on a plumbing commit; below that version a repository that defines one is
// refused rather than committed with the hook skipped.
async function hostRunsCommitHooks(cwd) {
  const version = await git(cwd, ["--version"]);
  const parsed = /(\d+)\.(\d+)/.exec(version);
  if (!parsed) throw new Error(`unreadable git version: ${version.trim()}`);
  const [major, minor] = [Number(parsed[1]), Number(parsed[2])];
  return major > 2 || (major === 2 && minor >= 36);
}

// Entry-level, which is what "the index is untouched" means: `git status`
// itself may rewrite the file to refresh stat data, but no entry of the
// user's may change mode, blob, stage or path.
function indexEntries(cwd) {
  return git(cwd, ["ls-files", "--stage"]);
}

async function writeHook(cwd, name, body) {
  await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
  const path = join(cwd, ".git", "hooks", name);
  await writeFile(path, body, "utf8");
  return path;
}

test("commit hooks run against the scratch index and can veto the commit", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const indexBefore = await indexEntries(cwd);
    await writeFile(join(cwd, "hooked.txt"), "hooked\n", "utf8");
    await writeFile(join(cwd, "sneaky.txt"), "sneaky\n", "utf8");
    if (!await hostRunsCommitHooks(cwd)) {
      // Hook-less operation is never silent: with a hook installed the commit
      // is refused, and only a repository without one still commits.
      const blocker = await writeHook(cwd, "pre-commit", "#!/bin/sh\nexit 1\n");
      await assert.rejects(
        () => gitCommitPaths(cwd, "No hook support", ["hooked.txt"]),
        /cannot run commit hooks/i,
      );
      assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
      assert.equal(await indexEntries(cwd), indexBefore);
      await rm(blocker, { force: true });
      await gitCommitPaths(cwd, "No hook support", ["hooked.txt"]);
      assert.notEqual((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
      return;
    }

    // A refusing pre-commit hook leaves NOTHING behind: no commit, no ref
    // move, and the index byte-for-byte as it was.
    const preCommit = await writeHook(cwd, "pre-commit", "#!/bin/sh\necho no >&2\nexit 1\n");
    await assert.rejects(
      () => gitCommitPaths(cwd, "Blocked", ["hooked.txt"]),
      /pre-commit hook refused/i,
    );
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal(await indexEntries(cwd), indexBefore);

    // A hook that stages something the user did not select cannot widen the
    // commit: it is refused before any commit object reaches a ref.
    await writeFile(preCommit, "#!/bin/sh\ngit add -- sneaky.txt\n", "utf8");
    await assert.rejects(
      () => gitCommitPaths(cwd, "Widened", ["hooked.txt"]),
      /sneaky\.txt, which was not selected/,
    );
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal(await indexEntries(cwd), indexBefore);
    assert.equal((await git(cwd, ["ls-files"])).includes("sneaky.txt"), false);

    // commit-msg rewrites the message git records; post-commit cannot fail
    // the commit, exactly as git treats it.
    await rm(preCommit, { force: true });
    await writeHook(cwd, "commit-msg", "#!/bin/sh\necho \"Rewritten by the hook\" > \"$1\"\n");
    await writeHook(cwd, "post-commit", "#!/bin/sh\nexit 9\n");
    await gitCommitPaths(cwd, "Original subject", ["hooked.txt"]);
    assert.equal((await git(cwd, ["log", "-1", "--format=%s"])).trim(), "Rewritten by the hook");
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "hooked.txt",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("commit hooks cannot inherit daemon identity or provider secrets", async (t) => {
  const cwd = await createRepository();
  const inherited = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    MIXDOG_DAEMON_HOST: process.env.MIXDOG_DAEMON_HOST,
    MIXDOG_TEST_HOOK_VISIBLE: process.env.MIXDOG_TEST_HOOK_VISIBLE,
  };
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    if (!await hostRunsCommitHooks(cwd)) {
      t.skip("git hook run requires Git 2.36 or newer");
      return;
    }
    process.env.ANTHROPIC_API_KEY = "provider-secret";
    process.env.MIXDOG_DAEMON_HOST = "1";
    process.env.MIXDOG_TEST_HOOK_VISIBLE = "visible";
    await writeFile(join(cwd, "hooked.txt"), "hooked\n", "utf8");
    const hook = await writeHook(cwd, "pre-commit", [
      "#!/bin/sh",
      "{",
      "  printf '%s\\n' \"${ANTHROPIC_API_KEY-unset}\"",
      "  printf '%s\\n' \"${MIXDOG_DAEMON_HOST-unset}\"",
      "  printf '%s\\n' \"${MIXDOG_TEST_HOOK_VISIBLE-unset}\"",
      "} > hook-environment.txt",
      "",
    ].join("\n"));
    if (process.platform !== "win32") await chmod(hook, 0o755);

    await gitCommitPaths(cwd, "Protected hook", ["hooked.txt"]);
    assert.deepEqual(
      (await readFile(join(cwd, "hook-environment.txt"), "utf8")).trim().split(/\r?\n/),
      ["unset", "unset", "visible"],
    );
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// Capability, never a guess: only "this git has no `git hook run`" may turn
// hooks off, and even then only where the repository defines none. ONE answer
// says that — git's own "not a git command". `usage: git hook ...` and
// "unknown subcommand" both come from a git that HAS the command, so reading
// either as "no hooks" would skip a repository's pre-commit policy.
test("hook support is decided by capability, not by an unrelated failure", async () => {
  assert.equal(missingHookRunner("git: 'hook' is not a git command. See 'git --help'."), true);
  assert.equal(missingHookRunner("usage: git hook run [--ignore-missing] <hook-name>"), false);
  assert.equal(missingHookRunner("error: unknown subcommand: `frobnicate'"), false);
  assert.equal(missingHookRunner("fatal: not a git repository"), false);
  assert.equal(missingHookRunner("spawn git ENOENT"), false);
  assert.equal(missingHookRunner("fatal: Unable to create 'index.lock': File exists"), false);

  assert.doesNotThrow(() => assertCommitHooksRunnable(true, ["pre-commit"]));
  assert.doesNotThrow(() => assertCommitHooksRunnable(false, []));
  assert.throws(
    () => assertCommitHooksRunnable(false, ["pre-commit", "commit-msg"]),
    /cannot run commit hooks.*pre-commit, commit-msg/is,
  );

  // A BROKEN probe is not an answer: it propagates and is forgotten, so the
  // next call asks again instead of committing with the hooks skipped.
  const cache = { value: null };
  let probes = 0;
  await assert.rejects(
    () => cacheHookRunnerSupport(() => {
      probes += 1;
      return Promise.reject(new Error("fatal: cannot exec 'git': out of memory"));
    }, cache),
    /Could not check whether Git can run commit hooks/,
  );
  assert.equal(cache.value, null);
  assert.equal(probes, 1);

  // Only a definitive answer is cached, and then it is never probed again.
  assert.equal(await cacheHookRunnerSupport(() => {
    probes += 1;
    return Promise.reject(new Error("git: 'hook' is not a git command. See 'git --help'."));
  }, cache), false);
  assert.equal(probes, 2);
  assert.equal(await cacheHookRunnerSupport(() => {
    probes += 1;
    return Promise.resolve("");
  }, cache), false);
  assert.equal(probes, 2);
});

// git runs a hook only when it is EXECUTABLE (`find_hook` -> access(X_OK)), so
// a non-executable file may not make us refuse a commit git itself performs.
// Windows has no executable bit and git's compat access() drops X_OK there.
test("a commit hook counts only when git itself would run it", async () => {
  assert.equal(executableHook(null, "linux"), false);
  assert.equal(executableHook(0o100644, "linux"), false);
  assert.equal(executableHook(0o100755, "linux"), true);
  assert.equal(executableHook(0o100750, "linux"), true);
  assert.equal(executableHook(0o100644, "win32"), true);
  assert.equal(executableHook(null, "win32"), false);

  if (process.platform === "win32") return;
  // Parity with native git: a non-executable pre-commit hook is ignored, so
  // the commit it "refuses" still happens.
  const cwd = await createRepository();
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    const hook = await writeHook(cwd, "pre-commit", "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o644);
    await writeFile(join(cwd, "quiet.txt"), "quiet\n", "utf8");
    await gitCommitPaths(cwd, "Ignored hook", ["quiet.txt"]);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "quiet.txt",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// A hook can unset GIT_INDEX_FILE and write the REAL index. That cannot be
// prevented, so it is detected: anything staged outside the selection stops
// the commit while no commit object exists.
test("a hook that writes the real index outside the selection is refused", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "selected.txt"), "selected\n", "utf8");
    await writeFile(join(cwd, "outside.txt"), "outside\n", "utf8");
    await writeHook(
      cwd,
      "pre-commit",
      "#!/bin/sh\nunset GIT_INDEX_FILE\ngit add -- outside.txt\n",
    );
    await assert.rejects(
      () => gitCommitPaths(cwd, "Selected", ["selected.txt"]),
      await hostRunsCommitHooks(cwd)
        ? /changed the staged entry for outside\.txt/i
        : /cannot run commit hooks/i,
    );
    // No commit, and the selected path never reached the user's index.
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal((await git(cwd, ["ls-files"])).includes("selected.txt"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// The refresh may only put back what the commit recorded. Content staged
// underneath it — here by a post-commit hook, the exact window a review
// reproduced — must survive as STAGED content, not be demoted to an unstaged
// change, and the caller must hear about it.
test("a path staged again mid-commit is reported, never overwritten", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "selected.txt", "base\n", "Base");
    await writeFile(join(cwd, "selected.txt"), "base\ncommitted\n", "utf8");
    if (!await hostRunsCommitHooks(cwd)) return;
    await writeHook(cwd, "post-commit", [
      "#!/bin/sh",
      "unset GIT_INDEX_FILE",
      "printf 'base\\nstaged elsewhere\\n' > selected.txt",
      "git add -- selected.txt",
      "",
    ].join("\n"));

    await assert.rejects(
      () => gitCommitPaths(cwd, "Selected", ["selected.txt"]),
      /staged again while it was being committed/i,
    );
    // The commit itself is intact...
    assert.equal(
      (await git(cwd, ["show", "HEAD:selected.txt"])).replace(/\r\n/g, "\n"),
      "base\ncommitted\n",
    );
    // ...and the entry staged underneath it is still staged.
    assert.equal(
      (await git(cwd, ["show", ":selected.txt"])).replace(/\r\n/g, "\n"),
      "base\nstaged elsewhere\n",
    );
    assert.equal((await gitStatus(cwd)).files.find((file) => file.path === "selected.txt")?.index,
      "M");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// The refresh baseline is the state the commit was BUILT FROM, not a snapshot
// taken after the hooks ran: a pre-commit hook that unsets GIT_INDEX_FILE and
// stages the selected path is staging concurrent work, and putting the
// commit's own blob back over it would demote it to an unstaged change.
test("content staged for a selected path during pre-commit survives the refresh", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "selected.txt", "base\n", "Base");
    if (!await hostRunsCommitHooks(cwd)) return;
    await writeFile(join(cwd, "selected.txt"), "base\ncommitted\n", "utf8");
    // Stages a DIFFERENT blob for the selected path without touching the
    // worktree, so the commit still records the worktree content.
    await writeHook(cwd, "pre-commit", [
      "#!/bin/sh",
      "unset GIT_INDEX_FILE",
      "blob=$(printf 'base\\nstaged during hook\\n' | git hash-object -w --stdin)",
      "git update-index --cacheinfo 100644,$blob,selected.txt",
      "",
    ].join("\n"));

    await assert.rejects(
      () => gitCommitPaths(cwd, "Selected", ["selected.txt"]),
      /staged again while it was being committed/i,
    );
    // The commit carries the worktree content...
    assert.equal(
      (await git(cwd, ["show", "HEAD:selected.txt"])).replace(/\r\n/g, "\n"),
      "base\ncommitted\n",
    );
    // ...and what the hook staged is still STAGED, not demoted.
    assert.equal(
      (await git(cwd, ["show", ":selected.txt"])).replace(/\r\n/g, "\n"),
      "base\nstaged during hook\n",
    );
    assert.equal((await gitStatus(cwd)).files.find((file) => file.path === "selected.txt")?.index,
      "M");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// Compare-then-write is only safe while nobody else may write, and the ORDER
// carries it: the lock is taken BEFORE the index is read and released by
// renaming the lock onto the index. Both ends of that window are probed with a
// REAL second git process — the `beforeIndexRead` one is the ordering itself,
// because a lock taken only after the snapshot would let that writer through
// and then overwrite the entry it staged.
test("the index refresh holds git's own lock before it reads the index", async () => {
  const cwd = await createRepository();
  const lock = join(cwd, ".git", "index.lock");
  try {
    await commit(cwd, "selected.txt", "base\n", "Base");
    await writeFile(join(cwd, "selected.txt"), "base\ncommitted\n", "utf8");
    await writeFile(join(cwd, "rival.txt"), "rival\n", "utf8");
    const rival = () => git(cwd, ["add", "--", "selected.txt", "rival.txt"])
      .then(() => "staged", (error) => error.message);
    const early = [];
    const late = [];
    commitRefreshProbe.beforeIndexRead = async () => {
      // Held already, and still empty: nothing has been published yet.
      assert.equal(await readFile(lock, "utf8"), "");
      early.push(await rival());
    };
    commitRefreshProbe.betweenReadAndReplace = async () => {
      late.push(await rival());
    };

    await gitCommitPaths(cwd, "Selected", ["selected.txt"]);

    // The writer is refused at BOTH ends of the window; acquiring the lock
    // below the snapshot would let the first one stage and change this to
    // "staged", the exact lost update the ordering exists to prevent.
    assert.equal(early.length, 1);
    assert.equal(late.length, 1);
    for (const attempt of [...early, ...late]) {
      assert.match(attempt, /index\.lock/);
      assert.match(attempt, /File exists/i);
    }
    // The refresh landed exactly what the commit recorded, and the writer that
    // lost the race changed nothing at all.
    assert.equal(
      (await git(cwd, ["show", ":selected.txt"])).replace(/\r\n/g, "\n"),
      "base\ncommitted\n",
    );
    assert.equal((await git(cwd, ["ls-files"])).includes("rival.txt"), false);
    assert.equal((await gitStatus(cwd)).files.find((file) => file.path === "rival.txt")?.untracked,
      true);
    // The lock is released by the replace, never left behind.
    await assert.rejects(() => readFile(join(cwd, ".git", "index.lock"), "utf8"));
  } finally {
    delete commitRefreshProbe.beforeIndexRead;
    delete commitRefreshProbe.betweenReadAndReplace;
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// The test above proves the lock is HELD when the probe runs — but not that
// the index is READ after it: a snapshot taken before the lock would satisfy
// every assertion there and still lose the update. This one pins the read
// itself, independently of where the probe sits: a complete index written
// straight onto `.git/index` while the lock is held (a plain file copy, which
// takes no lock — exactly what the compare exists to catch) is visible ONLY to
// a snapshot taken after that point. Read too early, the refresh would not see
// the rival entry and would overwrite it with the commit's own blob; read in
// the right place, it reports it and keeps its hands off.
test("the index refresh reads the index after the lock is taken, not before", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "selected.txt", "base\n", "Base");
    // A whole index with a DIFFERENT blob staged for the selected path.
    const alternate = join(cwd, ".git", "alternate.index");
    await writeFile(join(cwd, "selected.txt"), "base\nstaged elsewhere\n", "utf8");
    await copyFile(join(cwd, ".git", "index"), alternate);
    await gitWithIndex(cwd, ["add", "--", "selected.txt"], alternate);
    // What this commit records instead.
    await writeFile(join(cwd, "selected.txt"), "base\ncommitted\n", "utf8");

    let injected = false;
    commitRefreshProbe.beforeIndexRead = async () => {
      await copyFile(alternate, join(cwd, ".git", "index"));
      injected = true;
    };

    await assert.rejects(
      () => gitCommitPaths(cwd, "Selected", ["selected.txt"]),
      /staged again while it was being committed/i,
      "the refresh must read the index AFTER the lock, or it cannot see this entry",
    );
    assert.equal(injected, true);
    // The commit is intact, and the entry that appeared mid-window is exactly
    // as its writer left it — never demoted to an unstaged change.
    assert.equal(
      (await git(cwd, ["show", "HEAD:selected.txt"])).replace(/\r\n/g, "\n"),
      "base\ncommitted\n",
    );
    assert.equal(
      (await git(cwd, ["show", ":selected.txt"])).replace(/\r\n/g, "\n"),
      "base\nstaged elsewhere\n",
    );
    await assert.rejects(() => readFile(join(cwd, ".git", "index.lock"), "utf8"));
  } finally {
    delete commitRefreshProbe.beforeIndexRead;
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// The publish is a rename, so a short write would replace a good index with a
// truncated one — atomically. Every byte is written, the size is read back
// before anything is renamed, and an fsync error is never swallowed.
function fakeLockFile({ chunk = Infinity, size = null, stall = false, syncError = null } = {}) {
  const file = { bytes: Buffer.alloc(0), truncated: -1, synced: 0, writes: 0 };
  file.write = async (buffer, offset, length, position) => {
    const written = stall ? 0 : Math.min(chunk, length);
    file.writes += 1;
    const next = Buffer.alloc(Math.max(file.bytes.length, position + written));
    file.bytes.copy(next);
    buffer.copy(next, position, offset, offset + written);
    file.bytes = next;
    return { bytesWritten: written };
  };
  file.truncate = async (length) => {
    file.truncated = length;
    file.bytes = file.bytes.subarray(0, length);
  };
  file.stat = async () => ({ size: size ?? file.bytes.length });
  file.sync = async () => {
    if (syncError) throw syncError;
    file.synced += 1;
  };
  return file;
}

test("the index publish writes every byte, verifies the size and propagates fsync", async () => {
  const data = Buffer.from("index bytes that do not fit in one write\n".repeat(16));

  // A filesystem that takes 7 bytes at a time still receives all of them.
  const short = fakeLockFile({ chunk: 7 });
  await writeIndexBytes(short, data);
  assert.deepEqual(short.bytes, data);
  assert.ok(short.writes > 1, "a short write must be resumed, not ignored");
  assert.equal(short.truncated, data.length);
  assert.equal(short.synced, 1);

  // A write that makes no progress fails; it never spins forever.
  await assert.rejects(
    () => writeIndexBytes(fakeLockFile({ stall: true }), data),
    /could not be written \(0 of \d+ bytes\)/,
  );

  // The published size is read BACK: a short file is never renamed onto the
  // user's index.
  await assert.rejects(
    () => writeIndexBytes(fakeLockFile({ size: 3 }), data),
    /is 3 bytes where \d+ were expected/,
  );

  // fsync is the promise that the bytes are on disk; its failure is the
  // caller's business, not something to swallow.
  await assert.rejects(
    () => writeIndexBytes(fakeLockFile({ syncError: new Error("EIO: fsync failed") }), data),
    /EIO: fsync failed/,
  );
});

// git's own `core.sharedRepository` arithmetic, on every platform.
test("core.sharedRepository is folded onto a mode the way git folds it", () => {
  assert.equal(sharedRepositoryMode(0o600, "group"), 0o660);
  assert.equal(sharedRepositoryMode(0o600, "true"), 0o660);
  assert.equal(sharedRepositoryMode(0o600, "all"), 0o664);
  assert.equal(sharedRepositoryMode(0o600, "0660"), 0o660);
  assert.equal(sharedRepositoryMode(0o664, "umask"), 0o664);
  assert.equal(sharedRepositoryMode(0o664, ""), 0o664);
  // Never a world write, whatever is asked for.
  assert.equal(sharedRepositoryMode(0o600, "world") & 0o002, 0);
});

// The lock becomes the index by rename, so its permissions become the index's:
// Node's default mode would quietly strip the group write bit a shared
// repository depends on. Only a POSIX host can prove it — the chmod and the
// rename are real here, which is the half a win32 run cannot reach at all.
test("the published index keeps the permissions of the index it replaces",
  { skip: POSIX_ONLY }, async () => {
    const cwd = await createRepository();
    try {
      await commit(cwd, "seed.txt", "seed\n", "Seed");
      await git(cwd, ["config", "core.sharedRepository", "group"]);
      const index = join(cwd, ".git", "index");
      await chmod(index, 0o660);
      await writeFile(join(cwd, "shared.txt"), "shared\n", "utf8");

      await gitCommitPaths(cwd, "Shared", ["shared.txt"]);

      assert.equal((await stat(index)).mode & 0o777, 0o660);
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });

// git's `calc_shared_perm`: an EXPLICIT octal is the mode to use, not a set of
// bits to add. OR-ing it would let `core.sharedRepository=0640` leave a 0666
// index world-readable — the restriction defeated by the code enforcing it.
test("an explicit core.sharedRepository octal sets the mode instead of widening it", () => {
  assert.equal(sharedRepositoryMode(0o666, "0640"), 0o640);
  assert.equal(sharedRepositoryMode(0o666, "0600"), 0o600);
  assert.equal(sharedRepositoryMode(0o666, "0660"), 0o660);
  assert.equal(sharedRepositoryMode(0o644, "0660"), 0o660);
  // Bits above 0777 (setgid on an inherited mode) are not part of the swap.
  assert.equal(sharedRepositoryMode(0o2666, "0640"), 0o2640);
  // git's own ceiling: an explicit value never grants execute by itself.
  assert.equal(sharedRepositoryMode(0o666, "0777"), 0o666);
  // The historical spellings stay compatibility cases, not filemodes.
  assert.equal(sharedRepositoryMode(0o600, "0"), 0o600);
  assert.equal(sharedRepositoryMode(0o600, "1"), 0o660);
  assert.equal(sharedRepositoryMode(0o600, "2"), 0o664);
  // A file the owner cannot write hands nobody else a write bit...
  assert.equal(sharedRepositoryMode(0o400, "group"), 0o440);
  assert.equal(sharedRepositoryMode(0o444, "0666"), 0o444);
  // ...and execute follows read, exactly as git propagates it.
  assert.equal(sharedRepositoryMode(0o700, "group"), 0o770);
  assert.equal(sharedRepositoryMode(0o700, "all"), 0o775);
  // An octal that would lock the owner out is git's fatal config error, not
  // something to round off into a mode the repository never asked for.
  assert.throws(() => sharedRepositoryMode(0o666, "0400"), /core\.sharedRepository/);
  assert.throws(() => sharedRepositoryMode(0o666, "0044"), /core\.sharedRepository/);
});

// The lock becomes the index BY RENAME, so a mode that did not take is an
// index published with permissions nobody chose. Only a filesystem with no
// permission bits at all may be tolerated — there is nothing there to get
// wrong; EPERM/EACCES mean the file kept some OTHER mode.
test("a publish mode that did not take stops the publish instead of being swallowed", async () => {
  assert.equal(chmodErrorIsIgnorable("ENOSYS"), true);
  assert.equal(chmodErrorIsIgnorable("ENOTSUP"), true);
  assert.equal(chmodErrorIsIgnorable("EOPNOTSUPP"), true);
  for (const code of ["EPERM", "EACCES", "EINVAL", "EROFS", "EIO", ""]) {
    assert.equal(chmodErrorIsIgnorable(code), false, code || "(no code)");
  }
  // Stricter than required is safe; wider is the leak.
  assert.equal(modeGrantsMoreThan(0o640, 0o660), false);
  assert.equal(modeGrantsMoreThan(0o660, 0o660), false);
  assert.equal(modeGrantsMoreThan(0o666, 0o640), true);
  assert.equal(modeGrantsMoreThan(0o100640, 0o640), false, "file-type bits are not permissions");

  const lockFile = (chmodError, actual) => ({
    chmod: async () => {
      if (chmodError) throw chmodError;
    },
    stat: async () => ({ mode: 0o100000 | actual }),
  });
  const failure = (code) => Object.assign(new Error(`${code}: chmod failed`), { code });

  // A refused chmod leaves the lock at whatever mode it was created with.
  await assert.rejects(
    () => applyPublishMode(lockFile(failure("EPERM"), 0o666), 0o640),
    /could not be given mode 640/,
  );
  await assert.rejects(
    () => applyPublishMode(lockFile(failure("EACCES"), 0o666), 0o640),
    /could not be given mode 640/,
  );
  // A chmod that "succeeded" and changed nothing is the same failure.
  await assert.rejects(
    () => applyPublishMode(lockFile(null, 0o666), 0o640),
    /kept mode 666 where 640 was required/,
  );
  // Tolerated: no POSIX modes on this filesystem, and a stricter result.
  await applyPublishMode(lockFile(failure("ENOSYS"), 0o666), 0o640);
  await applyPublishMode(lockFile(null, 0o600), 0o640);
});

// A mount that EMULATES modes (CIFS) answers chmod with success and then reads
// back its own synthetic bits — and reports those same bits for the INDEX, so
// the mode the publish was derived from already contains them and nothing
// false-fails. What may NEVER be tolerated is the other case: an index that is
// already too permissive licensing a publish at that width. `0640` asked for
// on a 0666 index is a restriction; a chmod that did nothing would otherwise
// publish new index content at 0666 — the exposure the config exists to stop.
test("an over-permissive index cannot license republishing at its width", async () => {
  const lockFile = (actual) => ({
    chmod: async () => {},
    stat: async () => ({ mode: 0o100000 | actual }),
  });
  // Emulating mount, nothing restricted: the mode IS what the mount reports,
  // so the synthetic read-back is not a widening.
  await applyPublishMode(lockFile(0o777), 0o777);
  assert.equal(sharedRepositoryMode(0o777, "group"), 0o777);
  await applyPublishMode(lockFile(0o777), sharedRepositoryMode(0o777, "group"));
  // A restriction that did not take is fatal even though the index it replaces
  // grants those very bits today.
  assert.equal(sharedRepositoryMode(0o666, "0640"), 0o640);
  await assert.rejects(
    () => applyPublishMode(lockFile(0o666), sharedRepositoryMode(0o666, "0640")),
    /kept mode 666 where 640 was required/,
  );
  await assert.rejects(
    () => applyPublishMode(lockFile(0o777), 0o640),
    /kept mode 777 where 640 was required/,
  );
  // Stricter than required stays safe, on any mount.
  await applyPublishMode(lockFile(0o600), 0o640);
});

// git decides `core.sharedRepository` in `git_config_perm` (path.c), and the
// spellings it accepts are not the ones a naive `--get` reading sees: a BARE
// key is git's `value == NULL` (implicit true → GROUP), an explicit empty
// value is 0 (umask, unchanged), a zero-padded octal is a filemode, and
// anything else falls through to git's boolean parser — which DIES rather
// than meaning "unchanged".
test("core.sharedRepository is decoded exactly the way git decodes it", () => {
  // The bare form: GROUP sharing, never "unset".
  assert.equal(sharedRepositoryMode(0o600, null), 0o660);
  assert.equal(sharedRepositoryMode(0o700, null), 0o770);
  // Zero-padded octals are filemodes git restricts to, not noise to ignore.
  assert.equal(sharedRepositoryMode(0o666, "000640"), 0o640);
  assert.equal(sharedRepositoryMode(0o666, "00660"), 0o660);
  assert.equal(sharedRepositoryMode(0o600, "0000"), 0o600);
  assert.equal(sharedRepositoryMode(0o600, "0001"), 0o660);
  assert.equal(sharedRepositoryMode(0o600, "0002"), 0o664);
  // git's boolean spellings, case-insensitive exactly as git's are.
  for (const yes of ["true", "TRUE", "yes", "On"]) {
    assert.equal(sharedRepositoryMode(0o600, yes), 0o660, yes);
  }
  for (const no of ["false", "FALSE", "no", "Off", ""]) {
    assert.equal(sharedRepositoryMode(0o600, no), 0o600, no || "(empty)");
  }
  // Not octal, so git reads it as a boolean integer: nonzero is true.
  assert.equal(sharedRepositoryMode(0o600, "9"), 0o660);
  assert.equal(sharedRepositoryMode(0o600, "-0"), 0o600);
  // The keyword spellings are byte-exact in git (strcmp), so a miscased one
  // is garbage — and garbage is fatal, never a silent "leave it alone".
  for (const bad of ["garbage", "GROUP", "Group", "0640x", "shared"]) {
    assert.throws(() => sharedRepositoryMode(0o600, bad), /bad boolean config value/, bad);
  }
  // git's wording, byte for byte (checked against git 2.51 on the host): this
  // die comes from the config machinery, which had already lowercased the key
  // before it got there — so the message says `core.sharedrepository`, whatever
  // the config file spelled...
  assert.throws(
    () => sharedRepositoryMode(0o600, "garbage"),
    { message: "fatal: bad boolean config value 'garbage' for 'core.sharedrepository'" },
  );
  // ...while the filemode die is a LITERAL string in git's path.c, so it keeps
  // the camelCase spelling and git's `0%.3o` padding (`044` prints as `0044`).
  assert.throws(
    () => sharedRepositoryMode(0o666, "0044"),
    {
      message: "fatal: problem with core.sharedRepository filemode value (0044).\n"
        + "The owner of files must always have read and write permissions.",
    },
  );
});

// The same decoding, measured against the git on this machine: `--get` cannot
// tell a bare key from an empty one, and they mean opposite things. This half
// is pure config reading, so it runs on every platform.
test("a bare or empty core.sharedRepository is read the way git reads it", async () => {
  const cwd = await createRepository();
  const config = join(cwd, ".git", "config");
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    const base = await readFile(config, "utf8");

    await writeFile(config, `${base}[core]\n\tsharedRepository\n`, "utf8");
    assert.equal((await git(cwd, ["config", "--get", "core.sharedRepository"])).trim(), "");
    assert.equal(
      (await git(cwd, ["config", "--bool", "--get", "core.sharedRepository"])).trim(),
      "true",
      "a bare key is an implicit true to git",
    );
    // An EXPLICIT empty value prints the same empty line and means the
    // opposite: leave the mode exactly as it is.
    await writeFile(config, `${base}[core]\n\tsharedRepository = \n`, "utf8");
    assert.equal(
      (await git(cwd, ["config", "--bool", "--get", "core.sharedRepository"])).trim(),
      "false",
    );
    await writeFile(config, base, "utf8");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// The same config CONSUMED by the app: `indexPublishMode` turns it into the
// mode the rename will install. POSIX only — `indexPublishMode` answers null on
// win32 by design, so this is one of the paths only Linux/macOS CI can cover.
test("the publish mode consumes core.sharedRepository as git decodes it",
  { skip: POSIX_ONLY }, async () => {
    const cwd = await createRepository();
    const config = join(cwd, ".git", "config");
    const index = join(cwd, ".git", "index");
    try {
      await commit(cwd, "seed.txt", "seed\n", "Seed");
      const base = await readFile(config, "utf8");

      await writeFile(config, `${base}[core]\n\tsharedRepository\n`, "utf8");
      await chmod(index, 0o600);
      assert.equal((await indexPublishMode(cwd, index)).mode, 0o660, "bare = group sharing");
      await writeFile(config, `${base}[core]\n\tsharedRepository = \n`, "utf8");
      assert.equal((await indexPublishMode(cwd, index)).mode, 0o600, "empty = unchanged");
      // A long octal is a filemode, and it RESTRICTS: the index it replaces
      // being wider is what the restriction is FOR, never a licence to keep it.
      await writeFile(config, `${base}[core]\n\tsharedRepository = 000640\n`, "utf8");
      await chmod(index, 0o666);
      const publish = await indexPublishMode(cwd, index);
      assert.equal(publish.mode, 0o640);
      assert.equal(publish.existing, 0o666, "the mode was derived from the index's own");
      await writeFile(config, base, "utf8");
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });

// The mode is what the RENAME installs on the user's index, so it may only be
// decided once `.git/index.lock` is HELD. Decided before, a writer that
// replaces the index with a stricter one in that window gets its restriction
// undone by our own publish.
test("the index publish mode is decided under the lock, not before it", async () => {
  const cwd = await createRepository();
  const lock = join(cwd, ".git", "index.lock");
  const index = join(cwd, ".git", "index");
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    await writeFile(join(cwd, "moded.txt"), "moded\n", "utf8");
    if (process.platform !== "win32") await chmod(index, 0o660);
    let held = null;
    commitRefreshProbe.beforePublishMode = async () => {
      held = await stat(lock).then(() => true, () => false);
      // The competing writer: the index is tightened while we hold the lock.
      if (process.platform !== "win32") await chmod(index, 0o600);
    };

    await gitCommitPaths(cwd, "Moded", ["moded.txt"]);

    assert.equal(held, true, "the publish mode must be read with the lock already held");
    assert.equal((await git(cwd, ["log", "-1", "--format=%s"])).trim(), "Moded");
    if (process.platform !== "win32") {
      const published = (await stat(index)).mode & 0o777;
      assert.equal(published, 0o600, "the published index kept the stricter mode");
    }
    await assert.rejects(() => readFile(lock, "utf8"));
  } finally {
    delete commitRefreshProbe.beforePublishMode;
    await rm(lock, { force: true });
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// "No lock" and "the lock's state cannot be determined" are different answers.
// Reading EACCES/EIO as "no lock" lets the capability probe run a hook and the
// commit move HEAD on top of a lock that may well be somebody's live one.
test("a lock whose state cannot be determined stops the commit", async () => {
  const gitDir = join(tmpdir(), "mixdog-no-such-repository", ".git");
  const fails = (code) => () =>
    Promise.reject(Object.assign(new Error(`${code || "unknown"}: probe failed`), { code }));

  // Definitively absent: the commit may go ahead.
  await assertIndexLockFree(gitDir, fails("ENOENT"));
  await assertIndexLockFree(gitDir, fails("ENOTDIR"));
  // Definitively there.
  await assert.rejects(() => assertIndexLockFree(gitDir, async () => ({})), /already exists/);
  // Undeterminable: fail closed, before a hook runs and before HEAD moves.
  for (const code of ["EACCES", "EPERM", "EIO", "ELOOP", "EMFILE", ""]) {
    await assert.rejects(
      () => assertIndexLockFree(gitDir, fails(code)),
      /could not be checked/,
      code || "(no code)",
    );
    await assert.rejects(
      () => assertIndexLockFree(gitDir, fails(code)),
      /Nothing was committed/i,
      code || "(no code)",
    );
  }
});

// git's lock is `O_CREAT|O_EXCL`, which a DANGLING symlink defeats just as a
// real file does — while a `stat`-shaped check follows the link and reports
// "no lock". The commit would then run hooks and move HEAD against a lock it
// can never take.
test("an index.lock that resolves to nothing is still a lock",
  { skip: POSIX_ONLY }, async () => {
    const cwd = await createRepository();
    const lock = join(cwd, ".git", "index.lock");
    try {
      await commit(cwd, "seed.txt", "seed\n", "Seed");
      const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
      await writeFile(join(cwd, "dangling.txt"), "dangling\n", "utf8");
      await symlink(join(cwd, ".git", "no-such-target"), lock);

      const failure = await gitCommitPaths(cwd, "Dangling", ["dangling.txt"])
        .then(() => null, (error) => error);
      assert.ok(failure, "a dangling index.lock still blocks git's own O_EXCL create");
      assert.match(failure.message, /index\.lock/);
      assert.match(failure.message, /Nothing was committed/i);
      assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    } finally {
      await rm(lock, { force: true });
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });

// A lock that is already there is either a live git process or the wreckage of
// a dead one. Either way it is found BEFORE a hook runs or HEAD moves — found
// at the refresh instead, the commit would already be on the branch and the
// repair could not run until the file was removed by hand.
test("a pre-existing index.lock stops the commit before anything moves", async () => {
  const cwd = await createRepository();
  const lock = join(cwd, ".git", "index.lock");
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const indexBefore = await indexEntries(cwd);
    await writeHook(cwd, "pre-commit", "#!/bin/sh\ntouch .git/hook-ran\n");
    await writeFile(join(cwd, "cache[1].txt"), "cache\n", "utf8");
    await writeFile(lock, "foreign\n", "utf8");

    const failure = await gitCommitPaths(cwd, "Cached", ["cache[1].txt"])
      .then(() => null, (error) => error);
    assert.ok(failure, "the commit must report the lock instead of proceeding");
    assert.match(failure.message, /index\.lock/);
    assert.match(failure.message, /delete/i);
    assert.match(failure.message, /Nothing was committed/i);

    // Nothing ran, nothing moved, and the lock is still theirs byte for byte.
    await assert.rejects(() => readFile(join(cwd, ".git", "hook-ran"), "utf8"));
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal(await indexEntries(cwd), indexBefore);
    assert.equal(await readFile(lock, "utf8"), "foreign\n");
  } finally {
    await rm(lock, { force: true });
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// The hook-runner capability probe is itself a `git hook run`, so a repository
// that defines a hook by the probe's name gets that hook EXECUTED. Nothing of
// the user's — the probe's own path included — may run before the pre-flight
// rejections, whose whole promise is that nothing has moved yet.
test("the capability probe runs no hook before the stale lock is reported", async () => {
  const cwd = await createRepository();
  const lock = join(cwd, ".git", "index.lock");
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    if (!await hostRunsCommitHooks(cwd)) return;
    const hook = await writeHook(cwd, "mixdog-hook-probe", "#!/bin/sh\ntouch .git/probe-ran\n");
    await chmod(hook, 0o755);
    await writeFile(join(cwd, "probed.txt"), "probed\n", "utf8");
    await writeFile(lock, "foreign\n", "utf8");
    // The probe answers once per process; this test needs it to actually run.
    hookRunnerSupport.value = null;

    const failure = await gitCommitPaths(cwd, "Probed", ["probed.txt"])
      .then(() => null, (error) => error);
    assert.ok(failure, "the commit must report the lock instead of probing");
    assert.match(failure.message, /index\.lock/);
    assert.match(failure.message, /Nothing was committed/i);
    // The probe's hook never ran, and the lock is still theirs byte for byte.
    await assert.rejects(() => readFile(join(cwd, ".git", "probe-ran"), "utf8"));
    assert.equal(await readFile(lock, "utf8"), "foreign\n");
  } finally {
    hookRunnerSupport.value = null;
    await rm(lock, { force: true });
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// A lock taken WHILE the commit was being made (here by the pre-commit hook,
// the one window that is left) is somebody else's: the refresh stops, the
// index is left untouched, the lock is left where it was, and the recovery
// command is spelled with a literal pathspec so a name with glob magic cannot
// widen it.
test("a lock taken mid-commit stops the refresh with a pathspec-safe recovery", async () => {
  const cwd = await createRepository();
  const lock = join(cwd, ".git", "index.lock");
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    await writeFile(join(cwd, "cache[1].txt"), "cache\n", "utf8");
    const indexBefore = await indexEntries(cwd);
    await writeHook(cwd, "pre-commit", "#!/bin/sh\nprintf foreign > .git/index.lock\n");

    const failure = await gitCommitPaths(cwd, "Cached", ["cache[1].txt"])
      .then(() => null, (error) => error);
    assert.ok(failure, "the refresh must report the lock instead of succeeding");
    assert.match(failure.message, /could not be refreshed/i);
    assert.match(failure.message, /index\.lock/);
    assert.match(failure.message, /delete/i);
    assert.match(failure.message, /git reset [0-9a-f]{7} -- ":\(literal\)cache\[1\]\.txt"/);

    // The commit landed, the index did not move, and the lock is still theirs.
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "cache[1].txt",
    );
    assert.equal(await indexEntries(cwd), indexBefore);
    assert.equal(await readFile(lock, "utf8"), "foreign");

    // The suggested command really is the repair.
    await rm(lock, { force: true });
    const short = (await git(cwd, ["rev-parse", "--short=7", "HEAD"])).trim();
    await git(cwd, ["reset", "--quiet", short, "--", ":(literal)cache[1].txt"]);
    assert.equal((await gitStatus(cwd)).files.length, 0);
  } finally {
    await rm(lock, { force: true });
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// An unusable `commit.cleanup` is fatal to native git; treating it as
// `whitespace` would apply a cleanup the repository never asked for and make a
// commit git refuses to make.
test("an invalid commit.cleanup fails the commit exactly as git does", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "cleanup.txt"), "cleanup\n", "utf8");
    await git(cwd, ["config", "commit.cleanup", "bogus"]);
    await assert.rejects(
      () => git(cwd, ["commit", "--allow-empty", "-m", "control"]),
      /invalid cleanup mode/i,
    );

    await assert.rejects(
      () => gitCommitPaths(cwd, "Cleanup", ["cleanup.txt"]),
      /invalid cleanup mode/i,
    );
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal((await git(cwd, ["ls-files"])).includes("cleanup.txt"), false);

    // A config git cannot read is a FAULT, never a default: the commit stops
    // (here already at "which repository is this?", because git refuses every
    // command with an unparsable config) instead of inventing a cleanup mode.
    await git(cwd, ["config", "--unset", "commit.cleanup"]);
    const config = join(cwd, ".git", "config");
    const readable = await readFile(config, "utf8");
    await writeFile(config, `${readable}[commit\n`, "utf8");
    await assert.rejects(() => gitCommitPaths(cwd, "Cleanup", ["cleanup.txt"]));
    // Repaired first: every later probe needs a config git can read.
    await writeFile(config, readable, "utf8");
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal((await git(cwd, ["ls-files"])).includes("cleanup.txt"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// Native git refuses a malformed `commit.gpgsign`; producing an UNSIGNED
// commit instead would be a silent policy bypass.
test("a malformed commit.gpgsign fails the commit exactly as git does", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "signed.txt"), "signed\n", "utf8");
    await git(cwd, ["config", "commit.gpgsign", "bogus"]);
    await assert.rejects(
      () => git(cwd, ["commit", "--allow-empty", "-m", "control"]),
      /bad boolean config value/i,
    );

    await assert.rejects(
      () => gitCommitPaths(cwd, "Signed", ["signed.txt"]),
      /bad boolean config value/i,
    );
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal((await git(cwd, ["ls-files"])).includes("signed.txt"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Parity is measured against git itself: the same message, the same cleanup
// mode, the same recorded bytes.
async function nativeCommitMessage(cleanup, message) {
  const cwd = await createRepository();
  try {
    if (cleanup) await git(cwd, ["config", "commit.cleanup", cleanup]);
    await writeFile(join(cwd, "file.txt"), "one\n", "utf8");
    await git(cwd, ["add", "--", "file.txt"]);
    await git(cwd, ["commit", "-m", message]);
    // Awaited INSIDE the try: returning the promise would let `finally` delete
    // the repository out from under the still-running child.
    const recorded = await git(cwd, ["log", "-1", "--format=%B"]);
    return recorded;
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

test("the recorded message matches `git commit -m` in every cleanup mode", async () => {
  const message = "  Subject  \n\n\n# a comment\nbody   \n\n";
  for (const cleanup of ["", "whitespace", "verbatim", "strip", "scissors"]) {
    const cwd = await createRepository();
    try {
      if (cleanup) await git(cwd, ["config", "commit.cleanup", cleanup]);
      await writeFile(join(cwd, "file.txt"), "one\n", "utf8");
      await gitCommitPaths(cwd, message, ["file.txt"]);
      assert.equal(
        await git(cwd, ["log", "-1", "--format=%B"]),
        await nativeCommitMessage(cleanup, message),
        `commit.cleanup=${cleanup || "(unset)"}`,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
});

// The only honest interruption test is a real run, killed while the process is
// parked at a chosen point: the child touches `.git/park-live` when it gets
// there and the parent kills the whole tree the moment that marker appears.
const GIT_CLI_MODULE = new URL("./git-cli.ts", import.meta.url).href;
const TSX_IMPORT = import.meta.resolve("tsx");

function parkMarker(cwd) {
  return join(cwd, ".git", "park-live");
}

// Every kill is BOUNDED: `taskkill` is itself a child, and one that never
// returns (a wedged handle, a hung filter) would hang the test run forever
// with the parked process still holding the repository. POSIX's group kill is
// a syscall and returns on its own.
const KILL_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 30_000;

function taskkillTree(pid) {
  return new Promise((settle) =>
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], {
      timeout: KILL_TIMEOUT_MS,
      windowsHide: true,
    }, (failure) => settle(failure)));
}

// A kill that did not take is a live process still holding this repository, so
// it FAILS the test instead of being ignored: waiting on `done` afterwards
// would simply hang. An error the child raced us to (it exited on its own) is
// not a failure — that is the outcome the kill wanted.
async function killParkedTree(child, state) {
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!state.exited && error?.code !== "ESRCH") {
        throw new Error(`the parked child could not be killed: ${error.message}`);
      }
    }
    return;
  }
  const error = await taskkillTree(child.pid);
  if (error && !state.exited) throw new Error(`taskkill failed: ${error.message}`);
}

function timeoutAfter(ms, message) {
  return new Promise((_resolve, fail) => {
    setTimeout(() => fail(new Error(message)), ms).unref();
  });
}

// The LAST resort, and the only one that can actually reap a Windows tree:
// `child.kill()` signals the Node parent alone, so the git, sh and `sleep`
// descendants outlive it and keep holding the repository the cleanup is about
// to delete. A BLOCKING `taskkill /T /F` cannot be lost to a timeout the way
// the two async attempts can — and whatever it reports, the pid is CHECKED
// afterwards, so a survivor is failed loudly instead of leaked.
function reapTreeSync(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return null;
  } catch (error) {
    // 128 is taskkill's "there is no such process" — the outcome this wanted.
    return error?.status === 128 ? null : error;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, and not ours to signal. Anything else: gone.
    return error?.code === "EPERM";
  }
}

// Returns null once the tree is gone, or the message the caller must fail with.
async function reapTree(child, state, done) {
  let failure = null;
  if (process.platform === "win32") {
    failure = reapTreeSync(child.pid);
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      failure = error?.code === "ESRCH" ? null : error;
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone: the only thing this last resort had to achieve.
  }
  await Promise.race([done, timeoutAfter(KILL_TIMEOUT_MS, "kill")]).catch(() => {});
  if (state.exited || !processAlive(child.pid)) return null;
  return `the parked child (pid ${child.pid}) survived every kill, so its `
    + "descendants may still be holding this repository — kill that tree by hand "
    + `before rerunning${failure ? `: ${failure.message}` : ""}`;
}

async function killWhileParked(cwd, source) {
  const scriptDir = await mkdtemp(join(tmpdir(), "mixdog-git-interrupt-"));
  const live = parkMarker(cwd);
  const state = { exited: false };
  let child = null;
  let survivor = null;
  let done = Promise.resolve();
  try {
    const script = join(scriptDir, "interrupt.mjs");
    await writeFile(script, source, "utf8");
    child = spawn(process.execPath, ["--import", TSX_IMPORT, script], {
      cwd,
      detached: process.platform !== "win32",
      // stderr is KEPT: a child that dies before it parks has to say why,
      // otherwise the only symptom is a test that waited for nothing.
      stdio: ["ignore", "ignore", "pipe"],
    });
    let failed = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      failed += chunk;
    });
    done = new Promise((settle) => child.once("exit", () => {
      state.exited = true;
      settle();
    }));
    const deadline = Date.now() + 90_000;
    let parked = false;
    while (Date.now() < deadline && !state.exited) {
      parked = await readFile(live, "utf8").then(() => true, () => false);
      if (parked) break;
      await new Promise((wait) => setTimeout(wait, 100));
    }
    if (!state.exited) await killParkedTree(child, state);
    // Never an unbounded wait: a child that outlived its kill is reported.
    await Promise.race([
      done,
      timeoutAfter(EXIT_TIMEOUT_MS, "the parked child did not exit after the kill"),
    ]);
    // The park marker is what "it got there" means. A child parked on a
    // promise nothing keeps alive can exit by itself before the poll sees the
    // marker — it strands exactly the same state the kill would — so the file
    // decides, not who ended the process.
    const reached = parked || await readFile(live, "utf8").then(() => true, () => false);
    if (!reached) {
      throw new Error(
        `the child exited before it reached the park marker${failed ? `:\n${failed.trim()}` : ""}`,
      );
    }
  } finally {
    // Whatever happened above — a kill that errored, a kill that timed out, an
    // assertion that threw first — the child is terminated AGAIN and waited
    // for here, so no detached process survives this test still holding the
    // repository the cleanup below is about to delete.
    if (child && !state.exited) {
      await killParkedTree(child, state).catch(() => {});
      await Promise.race([done, timeoutAfter(KILL_TIMEOUT_MS, "kill")]).catch(() => {});
    }
    if (child && !state.exited) {
      survivor = await reapTree(child, state, done);
    }
    // Marker and script go whatever happened above, so a failure here cannot
    // leak a stale park marker or a temp script into the next test.
    await rm(live, { force: true }).catch(() => {});
    await rm(scriptDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      .catch(() => {});
    // Reported LAST, and only once the temp state is gone. It can mask an
    // earlier failure, and it is meant to: a process tree that outlived every
    // kill still holds the repository the caller is about to delete, so the
    // next test would fail for a reason that has nothing to do with itself.
    if (survivor) throw new Error(survivor);
  }
}

// Parked inside a clean filter: the scratch index is open and no commit exists.
async function interruptedCommit(cwd, message, paths) {
  const live = parkMarker(cwd);
  await git(cwd, [
    "config", "filter.park.clean", `sh -c 'touch "${live.replace(/\\/g, "/")}"; sleep 120'`,
  ]);
  await killWhileParked(cwd, [
    `import { gitCommitPaths } from ${JSON.stringify(GIT_CLI_MODULE)};`,
    `await gitCommitPaths(${JSON.stringify(cwd)}, ${JSON.stringify(message)},`
      + ` ${JSON.stringify(paths)});`,
  ].join("\n"));
  await git(cwd, ["config", "--unset", "filter.park.clean"]).catch(() => {});
}

// Parked with `.git/index.lock` HELD and the new index not yet written into
// it: the commit is already on the branch, so the kill strands exactly the
// partial lock a power loss would leave.
async function commitKilledHoldingIndexLock(cwd, message, paths) {
  await killWhileParked(cwd, [
    `import { writeFile } from "node:fs/promises";`,
    `import { gitCommitPaths, commitRefreshProbe } from ${JSON.stringify(GIT_CLI_MODULE)};`,
    `commitRefreshProbe.betweenReadAndReplace = async () => {`,
    `  await writeFile(${JSON.stringify(parkMarker(cwd))}, "parked", "utf8");`,
    `  await new Promise(() => {});`,
    `};`,
    `await gitCommitPaths(${JSON.stringify(cwd)}, ${JSON.stringify(message)},`
      + ` ${JSON.stringify(paths)});`,
  ].join("\n"));
}

test("an interrupted pathspec commit leaves no repository state behind", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "seed.txt", "seed\n", "Seed");
    await writeFile(join(cwd, "interrupted.txt"), "interrupted\n", "utf8");
    await writeFile(join(cwd, "other.txt"), "other\n", "utf8");
    await writeFile(join(cwd, ".gitattributes"), "interrupted.txt filter=park\n", "utf8");
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const indexBefore = await indexEntries(cwd);
    const reflogBefore = await git(cwd, ["log", "-g", "--format=%gs", "HEAD"]);

    await interruptedCommit(cwd, "Interrupted", ["interrupted.txt"]);

    // Nothing of ours survives the kill: no marker, no journal, no lock, no
    // ref movement, and the index is the SAME FILE it was.
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal(await indexEntries(cwd), indexBefore);
    assert.equal(await git(cwd, ["log", "-g", "--format=%gs", "HEAD"]), reflogBefore);
    assert.equal((await git(cwd, ["ls-files"])).includes("interrupted.txt"), false);
    await assert.rejects(() => readFile(join(cwd, ".git", "index.lock"), "utf8"));
    await assert.rejects(() => readFile(join(cwd, ".git", "mixdog", "commit-paths.json"), "utf8"));
    const stranded = await gitStatus(cwd);
    assert.equal(stranded.files.find((file) => file.path === "interrupted.txt")?.untracked, true);

    // The next call needs no repair step of any kind.
    await gitCommitPaths(cwd, "Other", ["other.txt"]);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "other.txt",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// Killed with the lock held and the bytes not yet in it: the user's index is
// whole (it is replaced by ONE rename that never happened), but a partial
// `index.lock` is stranded. The next commit has to meet it BEFORE it moves
// HEAD — otherwise a commit lands whose printed repair cannot run until this
// same file is deleted by hand.
test("a commit killed while writing the lock strands it and stops the next commit early",
  async () => {
    const cwd = await createRepository();
    const lock = join(cwd, ".git", "index.lock");
    try {
      await commit(cwd, "seed.txt", "seed\n", "Seed");
      await writeFile(join(cwd, "killed.txt"), "killed\n", "utf8");
      await writeFile(join(cwd, "next.txt"), "next\n", "utf8");
      const indexBefore = await indexEntries(cwd);

      await commitKilledHoldingIndexLock(cwd, "Killed", ["killed.txt"]);

      // The commit is on the branch, the index is untouched, and the lock the
      // dead process created is still there — partial, as the kill left it.
      const landed = (await git(cwd, ["rev-parse", "HEAD"])).trim();
      assert.equal(
        (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
        "killed.txt",
      );
      assert.equal(await indexEntries(cwd), indexBefore);
      assert.equal(await readFile(lock, "utf8"), "");

      // The next commit refuses before anything moves, and says what to do.
      const failure = await gitCommitPaths(cwd, "Next", ["next.txt"])
        .then(() => null, (error) => error);
      assert.ok(failure, "a stranded index.lock must stop the next commit");
      assert.match(failure.message, /index\.lock/);
      assert.match(failure.message, /delete/i);
      assert.match(failure.message, /Nothing was committed/i);
      assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), landed);
      assert.equal(await indexEntries(cwd), indexBefore);
      // Not ours to remove, even now.
      assert.equal(await readFile(lock, "utf8"), "");

      // Cleared by hand, exactly as the message says: everything works again,
      // including the repair the killed run never got to.
      await rm(lock, { force: true });
      await git(cwd, ["reset", "--quiet", landed, "--", ":(literal)killed.txt"]);
      await gitCommitPaths(cwd, "Next", ["next.txt"]);
      assert.equal(
        (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
        "next.txt",
      );
    } finally {
      await rm(lock, { force: true });
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });

// A killed process never runs `finally`, so the scratch location has to clean
// itself: the owning pid is in the directory name, and a name whose process is
// gone is swept by the next commit. Liveness is the WHOLE rule — a commit
// parked in a slow filter or hook for a day still owns its index.
test("scratch indexes of dead processes are swept, live ones are left alone", async () => {
  const cwd = await createRepository();
  const orphan = join(tmpdir(), "mixdog-commit-2147483646-orphan");
  const mine = join(tmpdir(), `mixdog-commit-${process.pid}-live`);
  const slow = join(tmpdir(), `mixdog-commit-${process.pid}-slow`);
  try {
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "commit.index"), "orphaned\n", "utf8");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "commit.index"), "in flight\n", "utf8");
    await mkdir(slow, { recursive: true });
    await writeFile(join(slow, "commit.index"), "still committing\n", "utf8");
    // Three days old and still owned by a live process: age may not evict it.
    const ancient = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(slow, ancient, ancient);
    await writeFile(join(cwd, "file.txt"), "one\n", "utf8");

    await gitCommitPaths(cwd, "Sweeps as it goes", ["file.txt"]);

    await assert.rejects(() => readFile(join(orphan, "commit.index"), "utf8"));
    assert.equal(await readFile(join(mine, "commit.index"), "utf8"), "in flight\n");
    assert.equal(await readFile(join(slow, "commit.index"), "utf8"), "still committing\n");
    // Nothing this run created outlives it.
    await rm(mine, { recursive: true, force: true });
    await rm(slow, { recursive: true, force: true });
    const leftovers = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("mixdog-commit-"));
    assert.deepEqual(leftovers, [], `stale scratch indexes: ${leftovers.join(", ")}`);
  } finally {
    await rm(orphan, { recursive: true, force: true });
    await rm(mine, { recursive: true, force: true });
    await rm(slow, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pathspec commit serializes per repository and resolves the repository's own spelling", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, ".gitignore", "/ignored.txt\n", "Ignore rule");
    await mkdir(join(cwd, "dir"), { recursive: true });
    await writeFile(join(cwd, "dir", "child.txt"), "child\n", "utf8");
    await writeFile(join(cwd, "ignored.txt"), "ignored\n", "utf8");

    // A separator-different spelling resolves against git's own path list
    // instead of by rewriting the caller's string.
    await gitCommitPaths(cwd, "Nested child", ["dir\\child.txt"]);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "dir/child.txt",
    );
    // Ignored, therefore absent from status and the index — still committable
    // when the user selected it on purpose.
    await gitCommitPaths(cwd, "Ignored on purpose", ["ignored.txt"]);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "ignored.txt",
    );

    // Two SPELLINGS of the same repository — the root and a nested directory —
    // must queue behind one another instead of racing the index.
    await mkdir(join(cwd, "dir", "deep"), { recursive: true });
    await writeFile(join(cwd, "left.txt"), "left\n", "utf8");
    await writeFile(join(cwd, "dir", "deep", "right.txt"), "right\n", "utf8");
    // The hook holds each `git commit` open long enough that two unserialized
    // runs would overlap — git then loses the other run's index entry.
    await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
    const slowHook = join(cwd, ".git", "hooks", "pre-commit");
    await writeFile(slowHook, "#!/bin/sh\nsleep 2\n", "utf8");
    await Promise.all([
      gitCommitPaths(cwd, "Left", ["left.txt"]),
      gitCommitPaths(join(cwd, "dir", "deep"), "Right", ["right.txt"]),
    ]);
    await rm(slowHook, { force: true });
    const subjects = await git(cwd, ["log", "--format=%s%x00%H"]);
    assert.match(subjects, /^Left\u0000/m);
    assert.match(subjects, /^Right\u0000/m);
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD"])).trim().split(/\r?\n/).length,
      1,
    );
    assert.equal(
      (await git(cwd, ["show", "--name-only", "--format=", "HEAD~1"])).trim().split(/\r?\n/).length,
      1,
    );
    assert.equal((await gitStatus(cwd)).files.length, 0);
  } finally {
    // Retries so a failing assertion is reported instead of a busy git process.
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// ── History context menu ───────────────────
// Gated narrowly: only cherry-pick refuses on top of a
// live operation or over uncommitted
// work; checkout and branch creation carry safe local changes across, revert is
// left to git, and every action refuses a ref/tag/commit git itself would not
// accept.

const inProgress = (error) => /already in progress/i.test(error.message);
const mixdogDirtyRefusal = (error) => /uncommitted changes would be overwritten/i
  .test(error.message);

test("only cherry-pick refuses to stack on a live Git operation", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "shared.txt", "base\n", "Base");
    const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["checkout", "-b", "rival"]);
    await commit(cwd, "shared.txt", "rival\n", "Rival");
    const rival = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["checkout", "main"]);
    await commit(cwd, "shared.txt", "mainline\n", "Mainline");
    await git(cwd, ["merge", "rival"]).catch(() => "");
    assert.equal((await gitStatus(cwd)).operation, "merge");

    await assert.rejects(() => gitCherryPickCommit(cwd, rival), inProgress);

    // A tag only writes refs/tags, so it is never gated — the tag
    // dispatchers stay available while an operation runs.
    assert.match(await gitCreateTag(cwd, "v1.0.0", base), /v1\.0\.0/);
    assert.equal((await git(cwd, ["tag", "-l"])).trim(), "v1.0.0");
    assert.match(await gitDeleteTag(cwd, "v1.0.0"), /v1\.0\.0/);

    // Reset, revert, checkout and branch creation are handed to git: what it
    // cannot do here it refuses in its OWN words ("Cannot do a soft reset in
    // the middle of a merge", unmerged entries), never with mixdog's
    // "already in progress".
    for (const action of [
      () => gitResetToCommit(cwd, base, "soft"),
      () => gitRevertCommit(cwd, rival),
      () => gitCheckoutCommit(cwd, base),
      () => gitCreateBranchAtCommit(cwd, "from-history", base),
    ]) {
      await assert.rejects(action, (error) => !inProgress(error));
    }

    // Nothing moved: the half-done merge is still the only live state.
    assert.equal((await gitStatus(cwd)).operation, "merge");
    assert.equal((await git(cwd, ["tag", "-l"])).trim(), "");
    assert.equal(
      await git(cwd, ["rev-parse", "--verify", "refs/heads/from-history"])
        .then(() => true, () => false),
      false,
    );

    // And reset is not gated by mixdog at all: the mode the reference uses
    // (--mixed) runs with the merge still live, moves the branch and leaves
    // the merge state behind, exactly as the reference's dispatcher would.
    await gitResetToCommit(cwd, base, "mixed", true);
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);
    assert.equal((await gitStatus(cwd)).operation, "");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("reset moves the branch in the mode the caller names, --hard refuses work and --mixed reports it", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "reset.txt", "base\n", "Base");
    const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await commit(cwd, "later.txt", "later\n", "Later");

    // soft keeps the undone commit's content STAGED.
    await gitResetToCommit(cwd, base, "soft");
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);
    const soft = await gitStatus(cwd);
    assert.equal(soft.files[0]?.path, "later.txt");
    assert.equal(soft.files[0]?.index, "A");

    // mixed REWRITES THE INDEX: that staged file would silently become
    // unstaged, so the risk is reported — named files plus a code the UI can
    // match — instead of run, as the reference asks first (WarningBeforeReset,
    // warn-before-reset rule).
    const warned = await gitResetToCommit(cwd, base, "mixed").then(() => null, (error) => error);
    assert.ok(warned, "a --mixed reset must not silently unstage uncommitted work");
    assert.match(warned.message, /--mixed/);
    assert.match(warned.message, /later\.txt/);
    assert.match(warned.message, /confirm/i);
    assert.equal(warned.code, "git-reset-dirty-worktree");
    assert.equal((await gitStatus(cwd)).files[0]?.index, "A"); // still staged

    // Confirmed by the caller, it runs: same content, now unstaged.
    await gitResetToCommit(cwd, base, "mixed", true);
    assert.equal((await gitStatus(cwd)).files[0]?.untracked, true);

    // hard would destroy it, so it is refused and names the file.
    await assert.rejects(
      () => gitResetToCommit(cwd, base, "hard"),
      (error) => /uncommitted changes/i.test(error.message) && /later\.txt/.test(error.message),
    );
    assert.equal((await gitStatus(cwd)).files.length, 1);
    assert.equal(
      (await readFile(join(cwd, "later.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "later\n",
    );

    await rm(join(cwd, "later.txt"), { force: true });
    assert.equal((await gitStatus(cwd)).files.length, 0);
    // Nothing to lose, nothing to confirm.
    await gitResetToCommit(cwd, base, "mixed");
    await gitResetToCommit(cwd, base, "hard");
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);

    await assert.rejects(() => gitResetToCommit(cwd, base, "keep"), TypeError);
    await assert.rejects(() => gitResetToCommit(cwd, "--hard", "soft"), TypeError);
    await assert.rejects(() => gitResetToCommit(cwd, "HEAD~1", "soft"), TypeError);
    await assert.rejects(() => gitResetToCommit(cwd, "deadbee", "soft"), TypeError);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// The dirty `--mixed` refusal is only usable if the caller can TELL it apart
// from a real Git failure, so the code has to reach every caller — including
// the phone, whose frames are JSON and drop custom Error properties.
test("a refused dirty --mixed reset carries its code on the direct AND the remote path", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "reset.txt", "base\n", "Base");
    const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await commit(cwd, "later.txt", "later\n", "Later");
    await gitResetToCommit(cwd, base, "soft"); // later.txt is now STAGED

    // Direct call: the code rides on the Error itself.
    const direct = await gitResetToCommit(cwd, base, "mixed").then(() => null, (error) => error);
    assert.ok(direct, "a --mixed reset over staged work must be refused");
    assert.equal(direct.code, GIT_RESET_DIRTY_CODE);
    assert.equal(GIT_RESET_DIRTY_CODE, "git-reset-dirty-worktree");

    // Remote transport: the same refusal, through the frame executor the LAN
    // bridge and the relay both run, survives a JSON round trip as its own
    // field — a remote caller branches on the contract, not on prose.
    const methods = createRemoteMethods({
      host: {
        invokeDesktopOperation(name, args) {
          if (name !== "gitResetToCommit") throw new Error(`unexpected service operation ${name}`);
          return gitResetToCommit(...args);
        },
      },
    });
    const refused = JSON.parse(JSON.stringify(await executeRemoteFrame(methods, JSON.stringify({
      id: 7, method: "gitResetToCommit", params: [cwd, base, "mixed"],
    }))));
    assert.equal(refused.ok, false);
    assert.match(refused.error, /--mixed/);
    assert.match(refused.error, /later\.txt/);
    assert.equal(refused.errorCode, GIT_RESET_DIRTY_CODE);
    assert.equal((await gitStatus(cwd)).files[0]?.index, "A"); // nothing was reset

    // A failure that carries NO code stays code-less: the field means "there is
    // a contract here", so it must not appear on every ordinary failure.
    const invalid = JSON.parse(JSON.stringify(await executeRemoteFrame(methods, JSON.stringify({
      id: 8, method: "gitResetToCommit", params: [cwd, base, "keep"],
    }))));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errorCode, undefined);

    // Confirmed over the same transport, it runs: the flag is the whole reply.
    const confirmed = await executeRemoteFrame(methods, JSON.stringify({
      id: 9, method: "gitResetToCommit", params: [cwd, base, "mixed", true],
    }));
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.errorCode, undefined);
    assert.equal((await gitStatus(cwd)).files[0]?.untracked, true);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("revert undoes a commit and a conflicted revert stays resolvable", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "a.txt", "base\n", "Base");
    await commit(cwd, "b.txt", "added\n", "Add b");
    const added = (await git(cwd, ["rev-parse", "HEAD"])).trim();

    assert.match(await gitRevertCommit(cwd, added), /revert/i);
    assert.equal(await stat(join(cwd, "b.txt")).then(() => true, () => false), false);
    assert.equal((await gitStatus(cwd)).files.length, 0);
    assert.match(await git(cwd, ["log", "-1", "--format=%s"]), /Revert "Add b"/);

    // Unrelated local work is NOT a blanket refusal: the reference's revert
    // path runs no uncommitted-changes check, so a revert that cannot touch the
    // edited or untracked file goes through and both survive it.
    await commit(cwd, "c.txt", "c\n", "Add c");
    const addedC = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "a.txt"), "base\nlocal work\n", "utf8");
    await writeFile(join(cwd, "scratch.txt"), "untracked\n", "utf8");
    assert.match(await gitRevertCommit(cwd, addedC), /revert/i);
    assert.equal(await stat(join(cwd, "c.txt")).then(() => true, () => false), false);
    assert.equal(
      (await readFile(join(cwd, "a.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "base\nlocal work\n",
    );
    assert.equal(await stat(join(cwd, "scratch.txt")).then(() => true, () => false), true);
    await rm(join(cwd, "scratch.txt"), { force: true });
    await git(cwd, ["checkout", "--", "a.txt"]);

    // The revert that really WOULD overwrite the edit is still refused — by
    // git, in git's words, not by a mixdog preflight.
    await commit(cwd, "a.txt", "base\nedited\n", "Edit a");
    const editedA = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "a.txt"), "base\nedited\nlocal work\n", "utf8");
    await assert.rejects(
      () => gitRevertCommit(cwd, editedA),
      (error) => !mixdogDirtyRefusal(error) && /local changes|overwritten/i.test(error.message),
    );
    assert.equal((await gitStatus(cwd)).operation, "");
    assert.equal(
      (await readFile(join(cwd, "a.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "base\nedited\nlocal work\n",
    );
    await git(cwd, ["checkout", "--", "a.txt"]);

    await assert.rejects(() => gitRevertCommit(cwd, "--no-edit"), TypeError);
    await assert.rejects(() => gitRevertCommit(cwd, "HEAD"), TypeError);

    // A conflicted revert keeps its sequencer state, so `gitContinue` finishes.
    await commit(cwd, "a.txt", "one\n", "One");
    const one = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await commit(cwd, "a.txt", "two\n", "Two");
    await assert.rejects(
      () => gitRevertCommit(cwd, one),
      (error) => /conflicts/i.test(error.message) && /a\.txt/.test(error.message),
    );
    const conflicted = await gitStatus(cwd);
    assert.equal(conflicted.operation, "revert");
    assert.equal(conflicted.files[0]?.conflicted, true);

    await writeFile(join(cwd, "a.txt"), "resolved\n", "utf8");
    await git(cwd, ["add", "--", "a.txt"]);
    await gitContinue(cwd);
    assert.equal((await gitStatus(cwd)).operation, "");
    assert.equal(
      (await readFile(join(cwd, "a.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "resolved\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("cherry-pick lands a commit here and a conflicted one stays abortable", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "shared.txt", "base\n", "Base");
    await git(cwd, ["checkout", "-b", "feature"]);
    await commit(cwd, "feature.txt", "feature\n", "Feature");
    const feature = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["checkout", "main"]);

    await gitCherryPickCommit(cwd, feature);
    assert.equal(
      (await readFile(join(cwd, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "feature\n",
    );
    assert.match(await git(cwd, ["log", "-1", "--format=%s"]), /Feature/);
    assert.equal((await gitStatus(cwd)).files.length, 0);

    await writeFile(join(cwd, "shared.txt"), "base\nlocal work\n", "utf8");
    await assert.rejects(
      () => gitCherryPickCommit(cwd, feature),
      (error) => /uncommitted changes/i.test(error.message) && /shared\.txt/.test(error.message),
    );
    assert.equal((await gitStatus(cwd)).operation, "");
    assert.equal(
      (await readFile(join(cwd, "shared.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "base\nlocal work\n",
    );
    await git(cwd, ["checkout", "--", "shared.txt"]);

    await assert.rejects(() => gitCherryPickCommit(cwd, "--continue"), TypeError);
    await assert.rejects(() => gitCherryPickCommit(cwd, "feature"), TypeError);

    await git(cwd, ["checkout", "feature"]);
    await commit(cwd, "shared.txt", "feature side\n", "Feature edit");
    const rival = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["checkout", "main"]);
    await commit(cwd, "shared.txt", "main side\n", "Main edit");
    await assert.rejects(
      () => gitCherryPickCommit(cwd, rival),
      (error) => /conflicts/i.test(error.message) && /shared\.txt/.test(error.message),
    );
    const conflicted = await gitStatus(cwd);
    assert.equal(conflicted.operation, "cherry-pick");
    assert.equal(conflicted.files[0]?.conflicted, true);
    await gitAbortOperation(cwd);
    assert.equal((await gitStatus(cwd)).operation, "");
    assert.equal(
      (await readFile(join(cwd, "shared.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "main side\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

// git's DEFAULT stops an empty pick (exit 1) and leaves CHERRY_PICK_HEAD on
// disk, which sequencerFailure would then report as a conflict — one the dock
// cannot resolve, because it offers no "skip". The reference keeps the commit
// instead (`--empty=keep`), so the picked summary lands
// in this branch's history and nothing half-done is left behind.
test("cherry-pick keeps an empty commit instead of stranding the sequencer", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "base.txt", "base\n", "Base");
    await git(cwd, ["checkout", "-b", "feature"]);
    await git(cwd, ["commit", "--allow-empty", "-m", "Empty marker"]);
    const empty = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["checkout", "main"]);
    const before = (await git(cwd, ["rev-parse", "HEAD"])).trim();

    await gitCherryPickCommit(cwd, empty);
    assert.match(await git(cwd, ["log", "-1", "--format=%s"]), /Empty marker/);
    assert.equal((await git(cwd, ["rev-parse", "HEAD^"])).trim(), before);

    const status = await gitStatus(cwd);
    assert.equal(status.operation, "");
    assert.equal(status.files.length, 0);
    assert.equal(
      await stat(join(cwd, ".git", "CHERRY_PICK_HEAD")).then(() => true, () => false),
      false,
    );

    // Same flag, other empty case: a commit whose change is ALREADY here
    // becomes empty while it replays, and is kept rather than stopping.
    await commit(cwd, "twice.txt", "twice\n", "Twice");
    const twice = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await gitCherryPickCommit(cwd, twice);
    assert.match(await git(cwd, ["log", "-1", "--format=%s"]), /Twice/);
    assert.equal((await git(cwd, ["rev-parse", "HEAD^"])).trim(), twice);
    assert.equal((await gitStatus(cwd)).operation, "");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("tags are created at a commit and deleted, and invalid names never reach git", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "tagged.txt", "base\n", "Base");
    const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await commit(cwd, "tagged.txt", "later\n", "Later");

    assert.match(await gitCreateTag(cwd, "v1.0.0", base), /v1\.0\.0/);
    assert.equal((await git(cwd, ["rev-parse", "v1.0.0^{commit}"])).trim(), base);

    // A tag writes refs/tags only: uncommitted work is never at risk, so it is
    // neither refused nor touched.
    await writeFile(join(cwd, "tagged.txt"), "dirty\n", "utf8");
    await gitCreateTag(cwd, "v1.1.0", (await git(cwd, ["rev-parse", "HEAD"])).trim());
    const dirty = await gitStatus(cwd);
    assert.equal(dirty.files.length, 1);
    assert.equal(
      (await readFile(join(cwd, "tagged.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "dirty\n",
    );
    await git(cwd, ["checkout", "--", "tagged.txt"]);

    for (const name of ["", "bad name", "-f", "a..b", "tag.lock", "refs/tags/"]) {
      await assert.rejects(() => gitCreateTag(cwd, name, base), TypeError);
      await assert.rejects(() => gitDeleteTag(cwd, name), TypeError);
    }
    await assert.rejects(() => gitCreateTag(cwd, "v2.0.0", "--force"), TypeError);
    assert.equal((await git(cwd, ["tag", "-l"])).trim().split(/\r?\n/).length, 2);
    await assert.rejects(() => gitCreateTag(cwd, "v1.0.0", base), /already exists/i);

    assert.match(await gitDeleteTag(cwd, "v1.0.0"), /v1\.0\.0/);
    assert.equal((await git(cwd, ["tag", "-l"])).trim(), "v1.1.0");
    await assert.rejects(() => gitDeleteTag(cwd, "v1.0.0"), /not found/i);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("a commit can be checked out detached or opened as a new branch", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "history.txt", "base\n", "Base");
    const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await commit(cwd, "history.txt", "later\n", "Later");

    assert.match(await gitCheckoutCommit(cwd, base), /detached/i);
    const detached = await gitStatus(cwd);
    assert.equal(detached.detached, true);
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);
    assert.equal(
      (await readFile(join(cwd, "history.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "base\n",
    );
    await git(cwd, ["checkout", "main"]);

    await gitCreateBranchAtCommit(cwd, "from-history", base);
    const branched = await gitStatus(cwd);
    assert.equal(branched.branch, "from-history");
    assert.equal(branched.detached, false);
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);
    await git(cwd, ["checkout", "main"]);

    // Local work neither action would overwrite is CARRIED ACROSS, not refused:
    // the reference's "Check out commit" tolerates safe local changes, and
    // branch creation likewise.
    await writeFile(join(cwd, "scratch.txt"), "local\n", "utf8");
    await gitCheckoutCommit(cwd, base);
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);
    assert.equal(
      (await readFile(join(cwd, "scratch.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "local\n",
    );
    await git(cwd, ["checkout", "main"]);
    await gitCreateBranchAtCommit(cwd, "second-try", base);
    const carried = await gitStatus(cwd);
    assert.equal(carried.branch, "second-try");
    assert.equal(carried.files.some((entry) => entry.path === "scratch.txt"), true);
    await git(cwd, ["checkout", "main"]);
    await rm(join(cwd, "scratch.txt"), { force: true });

    // The checkout that really WOULD overwrite an edit is still refused — by
    // git, in git's words, and nothing moves.
    await writeFile(join(cwd, "history.txt"), "later\nlocal work\n", "utf8");
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await assert.rejects(
      () => gitCheckoutCommit(cwd, base),
      (error) => !mixdogDirtyRefusal(error) && /local changes|overwritten/i.test(error.message),
    );
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal(
      (await readFile(join(cwd, "history.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "later\nlocal work\n",
    );
    await git(cwd, ["checkout", "--", "history.txt"]);

    await assert.rejects(() => gitCheckoutCommit(cwd, "--detach"), TypeError);
    await assert.rejects(() => gitCheckoutCommit(cwd, "main"), TypeError);
    await assert.rejects(() => gitCreateBranchAtCommit(cwd, "later", "--force"), TypeError);
    await assert.rejects(
      () => gitCreateBranchAtCommit(cwd, "bad name", base),
      (error) => /not a valid branch name|invalid/i.test(error.message),
    );
    await assert.rejects(() => gitCreateBranchAtCommit(cwd, "", base), TypeError);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("a merge commit is reverted and cherry-picked against its first parent", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "base.txt", "base\n", "Base");
    const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["checkout", "-b", "side"]);
    await commit(cwd, "side.txt", "side\n", "Side");
    await git(cwd, ["checkout", "main"]);
    await commit(cwd, "main.txt", "main\n", "Mainline");
    await git(cwd, ["merge", "--no-ff", "--no-edit", "side"]);
    const merge = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    assert.equal(
      (await git(cwd, ["rev-list", "--parents", "-n", "1", merge])).trim().split(/\s+/).length,
      3, // the commit plus TWO parents
    );

    // A merge has no single "before", so git refuses to revert one until a
    // mainline is named; `-m 1` names the first parent.
    assert.match(await gitRevertCommit(cwd, merge), /revert/i);
    assert.match(await git(cwd, ["log", "-1", "--format=%s"]), /Revert "Merge/);
    assert.equal(await stat(join(cwd, "side.txt")).then(() => true, () => false), false);
    assert.equal(await stat(join(cwd, "main.txt")).then(() => true, () => false), true);
    assert.equal((await gitStatus(cwd)).files.length, 0);

    // Same rule for cherry-pick: replayed onto another
    // branch, the merge contributes the diff against its first parent.
    await git(cwd, ["checkout", "-b", "target", base]);
    assert.equal(await stat(join(cwd, "side.txt")).then(() => true, () => false), false);
    await gitCherryPickCommit(cwd, merge);
    assert.equal(
      (await readFile(join(cwd, "side.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "side\n",
    );
    assert.equal((await gitStatus(cwd)).files.length, 0);
    assert.equal((await gitStatus(cwd)).operation, "");
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("a hex-shaped ref never shadows the commit a history action names", async () => {
  const cwd = await createRepository();
  try {
    await commit(cwd, "shadow.txt", "base\n", "Base");
    const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await commit(cwd, "shadow.txt", "later\n", "Later");
    const later = (await git(cwd, ["rev-parse", "HEAD"])).trim();

    // A branch NAMED like the abbreviated id of another commit: git's DWIM
    // gives the BRANCH, so a hex-only check is not enough on its own.
    const shadow = base.slice(0, 7);
    await git(cwd, ["branch", shadow, later]);
    assert.equal((await git(cwd, ["rev-parse", `${shadow}^{commit}`])).trim(), later);

    // Every action still lands on the object the caller named.
    assert.match(await gitCreateTag(cwd, "v-shadow", shadow), new RegExp(base.slice(0, 8)));
    assert.equal((await git(cwd, ["rev-parse", "v-shadow^{commit}"])).trim(), base);
    assert.match(await gitCheckoutCommit(cwd, shadow), new RegExp(base.slice(0, 8)));
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);
    await git(cwd, ["checkout", "main"]);
    await gitCreateBranchAtCommit(cwd, "from-shadow", shadow);
    assert.equal((await git(cwd, ["rev-parse", "refs/heads/from-shadow"])).trim(), base);
    await git(cwd, ["checkout", "main"]);
    await gitResetToCommit(cwd, shadow, "hard");
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);

    // A hex-shaped name that is ONLY a ref names no commit at all.
    await git(cwd, ["branch", "abcdef1234567", later]);
    await assert.rejects(() => gitCheckoutCommit(cwd, "abcdef1234567"), TypeError);
    await assert.rejects(() => gitCreateTag(cwd, "v-nope", "abcdef1234567"), TypeError);
    assert.equal((await git(cwd, ["rev-parse", "HEAD"])).trim(), base);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
