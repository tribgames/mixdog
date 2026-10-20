// Full-tree shutdown for stdio MCP child processes.
//
// The MCP SDK's StdioClientTransport.close() closes stdin, waits ~2s, then
// SIGTERMs / SIGKILLs the *direct* child only. On Windows that maps to
// TerminateProcess on the spawned wrapper (uvx/npx/uv) and leaves its
// grandchildren (uv.exe -> mcp-for-unity.exe -> python.exe) orphaned. This
// module implements the MCP spec shutdown order over the whole process tree:
// close stdin -> grace wait for voluntary exit -> force-kill the recorded
// tree (taskkill /T /F on Windows, SIGTERM->SIGKILL of every descendant on
// POSIX). No external dependencies.
import { spawn } from 'node:child_process';
import { runProcessOffThread } from '../../../shared/process-runner.mjs';
import { detachedSpawnOpts } from '../../../shared/spawn-flags.mjs';

const isWin = process.platform === 'win32';

// The SIGTERM → SIGKILL escalation wait. Kept ref'd: it runs right after the
// tree was signalled, when the dying children may be the only handles left,
// and an unref'd timer would then never fire, leaving the awaited kill (and
// every close awaiting it) pending forever. It is short and bounded.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort signal: a pid that already exited (or cannot be signalled) is skipped.
function signalQuietly(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    /* ignore */
  }
}

// The live child's pid: the transport's own `pid` when it exposes one, else
// the spawned ChildProcess (stdio transports keep it on `_process`).
function transportPid(transport) {
  return (typeof transport?.pid === 'number' ? transport.pid : null) ?? transport?._process?.pid ?? null;
}

/** Deadline of one process-table enumeration subprocess. A healthy CIM query
 *  takes ~1-3 s but exceeds 8 s under heavy load, and a timed-out strict read
 *  leaves the finished command's workspace held, so the deadline only cuts
 *  off a query that is genuinely stuck. A query that has not answered by then
 *  is killed and its snapshot rejected (strict) or empty (best-effort). A
 *  termination watch schedules its next pass only after the previous read
 *  settled, so enumerators never pile up whatever this value is. */
export const ENUMERATION_DEADLINE_MS = 20_000;

// Output bound of one helper command: a process table is tens of KB.
const HELPER_MAX_BYTES = 64 * 1024 * 1024;

// Run a helper command off the event loop (process-runner.mjs: under load one
// PowerShell start blocked the daemon's loop for seconds) and resolve its
// stdout. Past `timeoutMs` (default ENUMERATION_DEADLINE_MS) the helper is
// killed and the call settles. Strict: a failed, non-zero or timed-out run
// rejects; otherwise it resolves '' (non-zero exits keep their stdout).
function run(cmd, args, { strict = false, timeoutMs = ENUMERATION_DEADLINE_MS } = {}) {
  return runProcessOffThread(cmd, args, { timeoutMs, maxBytes: HELPER_MAX_BYTES }).then(
    ({ code, stdout }) => {
      if (strict && code !== 0) throw new Error(`Process enumeration failed (${code}).`);
      return stdout;
    },
    (error) => {
      if (!strict) return '';
      if (error?.code === 'ETIMEDOUT') throw new Error(`Process enumeration timed out after ${timeoutMs} ms.`);
      throw error;
    }
  );
}

// Snapshot the whole process table once: parent map + a per-pid identity
// token (Windows CreationDate, POSIX lstart) so a later kill can prove a pid
// number was not recycled onto a different process before signalling it.
// POSIX rows also carry the process group id (Windows has none).
async function enumerate({ strict = false } = {}) {
  const childrenOf = new Map();
  const tokenOf = new Map();
  const nameOf = new Map();
  const pgidOf = new Map();
  const out = isWin
    ? await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `${strict ? "$ErrorActionPreference = 'Stop'; " : ''}Get-CimInstance Win32_Process | ForEach-Object { $created = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }; "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $created" }`,
        ],
        { strict, timeoutMs: ENUMERATION_DEADLINE_MS }
      )
    : await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,comm=,lstart='], {
        strict,
        timeoutMs: ENUMERATION_DEADLINE_MS,
      });
  const row = isWin ? /^(\d+)\s+(\d+)\s+()()(\S+)(?:\s+(.+))?$/ : /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.+))?$/;
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(row);
    if (!m) continue;
    // A zombie runs nothing and holds no port or file; it only waits to be
    // reaped (forever under an init that does not reap, e.g. a container
    // without one). Counting it alive would hold a dead tree as running.
    if (m[4].startsWith('Z')) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const token = (m[6] || '').trim() || null;
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
    tokenOf.set(pid, token);
    nameOf.set(pid, m[5]);
    if (m[3]) pgidOf.set(pid, Number(m[3]));
  }
  if (strict && !nameOf.has(process.pid)) throw new Error('The process snapshot could not be verified.');
  return { childrenOf, tokenOf, nameOf, pgidOf };
}

/** One strict process-table snapshot: parent links, identity tokens, image
 *  names and (POSIX) process groups. Rejects instead of returning a partial
 *  table, so callers can tell "nothing found" from "could not look".
 *
 *  Every caller sees a table from a read begun after it asked: an earlier
 *  read may miss newly spawned descendants before a kill, or report a killed
 *  tree alive afterwards. A caller starts a read when none runs, else joins
 *  the one queued to begin when the running read settles — every caller
 *  asking meanwhile shares it. At most one enumerator runs at
 *  a time, however many shells settle or watch at once (each one is a
 *  PowerShell process on Windows; one per settle and watch pass compounded
 *  machine load into multi-second daemon stalls). */
let tableInFlight = null;
let nextTable = null;
function startTableRead() {
  const read = enumerate({ strict: true }).finally(() => {
    if (tableInFlight === read) tableInFlight = null;
  });
  tableInFlight = read;
  return read;
}
export function readProcessTable() {
  if (nextTable) return nextTable;
  if (!tableInFlight) return startTableRead();
  const settled = () => {};
  nextTable = tableInFlight.then(settled, settled).then(() => {
    nextTable = null;
    return startTableRead();
  });
  return nextTable;
}

// Walk every descendant pid of rootPid (excludes rootPid).
function descendantsOf(childrenOf, rootPid) {
  const result = [];
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of childrenOf.get(cur) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        result.push(child);
        stack.push(child);
      }
    }
  }
  return result;
}

async function collectDescendants(rootPid) {
  const { childrenOf } = await enumerate();
  return descendantsOf(childrenOf, rootPid);
}

/** Descendant pids WITH their image names and identity tokens (creation
 *  time), from one batched process-table read. */
export async function collectDescendantProcesses(rootPid, { strict = false } = {}) {
  const snapshot = enumerate({ strict });
  const { childrenOf, nameOf, tokenOf } = strict
    ? await snapshot
    : await snapshot.catch(() => ({ childrenOf: new Map(), nameOf: new Map(), tokenOf: new Map() }));
  return descendantsOf(childrenOf, rootPid).map((pid) => ({
    pid,
    name: nameOf.get(pid) || '',
    token: tokenOf.get(pid) ?? null,
  }));
}

/** Force-kill whole process trees by pid. Windows batches one taskkill /T /F
 *  for every pid; POSIX escalates SIGTERM → SIGKILL. Best-effort: the caller
 *  verifies liveness afterwards rather than trusting the signal. */
export async function killProcessTrees(pids) {
  const targets = [...new Set((pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (targets.length === 0) return;
  if (isWin) {
    const args = ['/F', '/T'];
    for (const pid of targets) args.push('/PID', String(pid));
    await run('taskkill', args);
    return;
  }
  for (const pid of targets) signalQuietly(pid, 'SIGTERM');
  await delay(300);
  for (const pid of targets) {
    if (isAlive(pid)) signalQuietly(pid, 'SIGKILL');
  }
}

/**
 * Immediate, non-blocking tree kill for a transport whose MCP handshake never
 * completed (shutdown-during-connect). Unlike shutdownStdioChild there is no
 * grace wait and no identity-checked enumeration on Windows — the ChildProcess
 * handle is live, so the pid is current, and taskkill /T reaps the still-
 * parented tree. Everything is unref'd/fire-and-forget so the kill can never
 * hold the caller's event loop open (the caller is a process about to exit).
 */
export function killStdioChildTreeFast(transport) {
  const proc = transport?._process;
  const pid = transportPid(transport);
  if (!pid) return false;
  if (proc && (proc.exitCode !== null || proc.signalCode !== null)) return false;
  try {
    proc?.unref?.();
  } catch {
    /* ignore */
  }
  for (const s of [proc?.stdin, proc?.stdout, proc?.stderr]) {
    try {
      s?.unref?.();
    } catch {
      /* ignore */
    }
    try {
      s?.destroy?.();
    } catch {
      /* ignore */
    }
  }
  if (isWin) {
    try {
      const cp = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        ...detachedSpawnOpts,
      });
      cp.unref();
    } catch {
      /* ignore */
    }
    return true;
  }
  // POSIX: cheap ps enumerate, then SIGKILL descendants + root. Best-effort
  // and un-awaited; a straggler orphan is reparented to init, not leaked by us.
  void collectDescendants(pid)
    .then((pids) => {
      for (const p of [...pids, pid]) signalQuietly(p, 'SIGKILL');
    })
    .catch(() => {
      /* ignore */
    });
  return true;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM => exists but not signalable by us; ESRCH => gone.
    return Boolean(e && e.code === 'EPERM');
  }
}

function waitExit(proc, ms) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const t = setTimeout(() => finish(false), ms);
    if (t.unref) t.unref();
    proc.once('exit', () => {
      clearTimeout(t);
      finish(true);
    });
    proc.once('close', () => {
      clearTimeout(t);
      finish(true);
    });
  });
}

// A pid is safe to signal only if its CURRENT identity token equals the one
// recorded at snapshot time. Both must be present; a gone/recycled pid has a
// missing or mismatched token and is skipped. Tokens come from batched table
// reads (Map), so verification is O(1) with zero extra process spawns.
function stillSame(pid, snapshotToken, currentTokens) {
  const want = snapshotToken.get(pid);
  const cur = currentTokens.get(pid);
  return Boolean(want && cur && want === cur);
}

// Force-kill the given pids, identity-checked against a batched current-token
// table captured immediately before signalling so a recycled pid is never hit.
async function killVerified(pids, snapshotToken, currentTokens) {
  const verified = pids.filter((pid) => stillSame(pid, snapshotToken, currentTokens));
  if (verified.length === 0) return;
  if (isWin) {
    // /T also reaps any still-live children spawned since enumeration;
    // every listed /PID was identity-checked just above.
    const args = ['/F', '/T'];
    for (const p of verified) args.push('/PID', String(p));
    await run('taskkill', args);
    return;
  }
  // POSIX: terminate, brief wait, then hard-kill survivors. Re-verify with a
  // single fresh batched table read (not per-pid) before the SIGKILL pass.
  for (const p of verified) signalQuietly(p, 'SIGTERM');
  await delay(500);
  const { tokenOf: fresh } = await enumerate().catch(() => ({ tokenOf: new Map() }));
  for (const p of verified) {
    if (isAlive(p) && stillSame(p, snapshotToken, fresh)) signalQuietly(p, 'SIGKILL');
  }
}

/**
 * Shut down an stdio MCP transport's child process tree per MCP spec order.
 * Returns false when the transport has no live child (non-stdio / already
 * exited); true once the tree has been shut down.
 */
export async function shutdownStdioChild(transport, { graceMs = 2000 } = {}) {
  const proc = transport?._process;
  const pid = transportPid(transport);
  if (!pid) return false;
  const empty = { childrenOf: new Map(), tokenOf: new Map() };
  const snapshotToken = new Map();
  // Snapshot #1: tree + identity tokens while it is still fully intact.
  // Covers children that later get re-parented/orphaned during shutdown.
  const before = await enumerate().catch(() => empty);
  const initial = descendantsOf(before.childrenOf, pid);
  snapshotToken.set(pid, before.tokenOf.get(pid) ?? null);
  for (const d of initial) snapshotToken.set(d, before.tokenOf.get(d) ?? null);
  // 1. Close stdin to request a voluntary shutdown.
  try {
    proc?.stdin?.end();
  } catch {
    /* ignore */
  }
  // 2. Grace period for the server to exit on its own.
  const exited = await waitExit(proc, graceMs);
  // 3. Snapshot #2 after the grace: catches children spawned late during
  //    shutdown that were absent from the first snapshot.
  const after = await enumerate().catch(() => empty);
  const fresh = descendantsOf(after.childrenOf, pid);
  for (const d of fresh) {
    if (!snapshotToken.has(d)) snapshotToken.set(d, after.tokenOf.get(d) ?? null);
  }
  // 4. Candidate set = union of both snapshots' descendants; add the root
  //    only when it did NOT exit on its own (skip stale-root kill per spec).
  const candidates = new Set(initial);
  for (const d of fresh) candidates.add(d);
  if (!exited) candidates.add(pid);
  if (candidates.size === 0) return true;
  // 5. Force-kill. Snapshot #2 is the pre-kill verify table (captured just
  //    now, immediately before signalling) — no per-pid queries.
  await killVerified([...candidates], snapshotToken, after.tokenOf);
  return true;
}
