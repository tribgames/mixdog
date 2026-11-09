// Full-tree shutdown for stdio MCP child processes.
//
// The MCP SDK's StdioClientTransport.close() closes stdin, waits ~2s, then
// SIGTERMs / SIGKILLs the *direct* child only. On Windows that maps to
// TerminateProcess on the spawned wrapper (uvx/npx/uv) and leaves its
// grandchildren (uv.exe -> mcp-for-unity.exe -> python.exe) orphaned. This
// module implements the MCP spec shutdown order over the whole process tree:
// close stdin -> grace wait for voluntary exit -> force-kill the recorded
// tree (the creation-checked tree kill below on Windows, SIGTERM->SIGKILL of
// every descendant on POSIX). No external dependencies.
//
// It also owns Mixdog's one Windows process-tree kill (treeKillCommand), which
// every other Windows tree kill runs, sync, async or detached.
import { spawn, spawnSync } from 'node:child_process';
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

// Run a helper command (a process-table read or a tree kill) off the event
// loop (process-runner.mjs: under load one PowerShell start blocked the
// daemon's loop for seconds). Past `timeoutMs` the helper itself is killed
// directly: it starts nothing worth walking, and a tree kill of it would be
// one more pass on the same stuck table read, with a deadline of its own.
function runHelper(cmd, args, timeoutMs) {
  return runProcessOffThread(cmd, args, { timeoutMs, maxBytes: HELPER_MAX_BYTES, killTree: false });
}

// A process-table helper's stdout. Past `timeoutMs` (default
// ENUMERATION_DEADLINE_MS) the helper is killed and the call settles. Strict:
// a failed, non-zero or timed-out run rejects; otherwise it resolves ''
// (non-zero exits keep their stdout).
function run(cmd, args, { strict = false, timeoutMs = ENUMERATION_DEADLINE_MS } = {}) {
  return runHelper(cmd, args, timeoutMs).then(
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
// token (Windows CreationDate as a UTC FILETIME, POSIX lstart) so a later kill
// can prove a pid number was not recycled onto a different process before
// signalling it. The FILETIME form orders against the spawn server's root
// creation time and carries no local-time offset.
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
          `${strict ? "$ErrorActionPreference = 'Stop'; " : ''}Get-CimInstance Win32_Process | ForEach-Object { $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { '' }; "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $created" }`,
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

// Windows keeps a dead parent's pid in its children and hands that pid to new
// processes, so an older process can look like a newer one's child: wininit.exe
// still names its boot-time parent's pid, and a tree walked from whatever holds
// that pid now reaches services.exe and every service host under it. A child is
// never created before its parent, so on Windows a link is followed only from a
// process whose creation time is known, to one created no earlier. POSIX
// reparents orphans, so its links never dangle.
const createdTicks = (token) => (typeof token === 'string' && /^\d+$/.test(token) ? BigInt(token) : null);

// Walk every descendant pid of rootPid (excludes rootPid).
function descendantsOf(childrenOf, rootPid, tokenOf) {
  const result = [];
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    const cur = stack.pop();
    const parentCreated = isWin ? createdTicks(tokenOf.get(cur)) : null;
    if (isWin && parentCreated == null) continue;
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue;
      if (isWin) {
        const childCreated = createdTicks(tokenOf.get(child));
        if (childCreated == null || childCreated < parentCreated) continue;
      }
      seen.add(child);
      result.push(child);
      stack.push(child);
    }
  }
  return result;
}

async function collectDescendants(rootPid) {
  const { childrenOf, tokenOf } = await enumerate();
  return descendantsOf(childrenOf, rootPid, tokenOf);
}

/** Descendant pids WITH their image names and identity tokens (creation
 *  time), from one batched process-table read. */
export async function collectDescendantProcesses(rootPid, { strict = false } = {}) {
  const snapshot = enumerate({ strict });
  const { childrenOf, nameOf, tokenOf } = strict
    ? await snapshot
    : await snapshot.catch(() => ({ childrenOf: new Map(), nameOf: new Map(), tokenOf: new Map() }));
  return descendantsOf(childrenOf, rootPid, tokenOf).map((pid) => ({
    pid,
    name: nameOf.get(pid) || '',
    token: tokenOf.get(pid) ?? null,
  }));
}

const positivePids = (pids) => [...new Set((pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];

// The Windows tree kill, one PowerShell pass. taskkill /T is never used: it
// walks parent ids with no creation times, so it follows the dangling links
// descendantsOf refuses (on 2026-10-30 one such kill ended every user-owned
// service host and sihost.exe). A root counts only if it was created no later
// than -AliveAt (a pid taken over after the caller saw its process is not
// that process); a descendant only if created no earlier than its parent.
// Each process is ended through a handle whose start time matches the table.
// Exit: 0 ended, 128 no root matched (gone or a different process), 1 a root
// survived; a failed or timed-out table read fails the pass. The table read
// times out on its own (a pass detached from an exiting caller still ends);
// every spawn from Node is also held to TREE_KILL_DEADLINE_MS. -Table/-List: tests only, a
// stand-in table whose member pids are printed instead of ended.
export const TREE_KILL_SCRIPT = `param([int[]]$Pids, [long]$AliveAt, [object[]]$Table, [switch]$List)
$ErrorActionPreference = 'Stop'
$limit = [DateTime]::FromFileTimeUtc($AliveAt)
if ($Table) {
  $rows = @(foreach ($t in $Table) { [pscustomobject]@{ Id = [int]$t.Id; Parent = [int]$t.Parent; Created = [DateTime]::FromFileTimeUtc([long]$t.Created) } })
} else {
  $rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 | Where-Object CreationDate | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Parent = [int]$_.ParentProcessId; Created = $_.CreationDate.ToUniversalTime() } })
}
$byId = @{}
$byParent = @{}
foreach ($r in $rows) {
  $byId[$r.Id] = $r
  if (-not $byParent.ContainsKey($r.Parent)) { $byParent[$r.Parent] = [Collections.Generic.List[object]]::new() }
  $byParent[$r.Parent].Add($r)
}
$members = [Collections.Generic.List[object]]::new()
foreach ($id in $Pids) {
  $r = $byId[$id]
  if ($r -and $r.Created -le $limit -and -not $members.Contains($r)) { $members.Add($r) }
}
$roots = $members.Count
if ($roots -eq 0) { exit 128 }
for ($i = 0; $i -lt $members.Count; $i++) {
  $parent = $members[$i]
  if (-not $byParent.ContainsKey($parent.Id)) { continue }
  foreach ($child in $byParent[$parent.Id]) {
    if ($child.Created -ge $parent.Created -and -not $members.Contains($child)) { $members.Add($child) }
  }
}
if ($List) { foreach ($m in $members) { $m.Id }; exit 0 }
$survived = $false
for ($i = 0; $i -lt $members.Count; $i++) {
  $m = $members[$i]
  try { $p = [Diagnostics.Process]::GetProcessById($m.Id) } catch { continue }
  try { $same = [math]::Abs(($p.StartTime.ToUniversalTime() - $m.Created).TotalMilliseconds) -lt 1 } catch { $same = $null }
  if ($same -eq $false) { continue }
  # A start time that cannot be read proves nothing: the process is left alone,
  # and a root left alone counts as surviving.
  if ($null -eq $same) { if ($i -lt $roots) { $survived = $true }; continue }
  try { $p.Kill() } catch {}
  if ($i -lt $roots) { try { if (-not $p.WaitForExit(2000)) { $survived = $true } } catch { $survived = $true } }
}
if ($survived) { exit 1 }
exit 0`;

const fileTime = (ms) => BigInt(Math.floor(Number(ms))) * 10_000n + 116_444_736_000_000_000n;

/** The command of one Windows tree kill of `pids` (see TREE_KILL_SCRIPT), for
 *  callers that spawn it themselves: awaited, synchronous, or detached and
 *  unref'd so it outlives an exiting caller. `aliveAt` (epoch ms): when the
 *  caller last knew each pid was its process (a live child handle: now; a
 *  pid file: when it was written). `table`: tests only, rows { pid, ppid,
 *  created (epoch ms) } standing in for the live table; the command then
 *  prints the member pids instead of ending them. */
export function treeKillCommand(pids, { aliveAt = Date.now(), table = null } = {}) {
  const rows = table
    ? ` -List -Table @(${table.map((row) => `@{Id=${row.pid};Parent=${row.ppid};Created=${fileTime(row.created)}}`).join(',')})`
    : '';
  const source = `& {\n${TREE_KILL_SCRIPT}\n} -Pids @(${positivePids(pids).join(',')}) -AliveAt ${fileTime(aliveAt)}${rows}`;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return {
    command: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
  };
}

/** The hard lifetime of one tree-kill pass, enforced from Node whatever the
 *  table read does (its own timeout is 10 s). */
export const TREE_KILL_DEADLINE_MS = 15_000;

/** The tree kill run synchronously (Windows only): its exit status (see
 *  TREE_KILL_SCRIPT), or null when it could not run or outlived `timeoutMs`. */
export function killProcessTreesSync(pids, { aliveAt = Date.now(), timeoutMs = TREE_KILL_DEADLINE_MS } = {}) {
  const { command, args } = treeKillCommand(pids, { aliveAt });
  return spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: timeoutMs }).status;
}

/** The tree kill spawned (Windows only) and held to TREE_KILL_DEADLINE_MS:
 *  past it the pass is killed. `root`: the caller's own ChildProcess, alive
 *  now; it is killed directly once the pass has ended, failed or run out of
 *  time, so a hung pass never keeps it alive. `detached`: the pass outlives
 *  an exiting caller and is bounded only by its own table-read timeout.
 *  Neither the pass nor its deadline keeps the caller's event loop alive.
 *  Returns the pass's ChildProcess, or null when it could not be spawned. */
export function spawnTreeKill(pids, { aliveAt = Date.now(), root = null, detached = false } = {}) {
  const killRoot = () => {
    try {
      root?.kill();
    } catch {
      /* already gone */
    }
  };
  let pass;
  try {
    const { command, args } = treeKillCommand(pids, { aliveAt });
    pass = spawn(command, args, { stdio: 'ignore', ...detachedSpawnOpts });
  } catch {
    killRoot();
    return null;
  }
  pass.unref?.();
  if (detached) {
    pass.once('error', killRoot);
    return pass;
  }
  const deadline = setTimeout(() => {
    try {
      pass.kill();
    } catch {
      /* already gone */
    }
    killRoot();
  }, TREE_KILL_DEADLINE_MS);
  deadline.unref?.();
  const settle = () => {
    clearTimeout(deadline);
    killRoot();
  };
  pass.once('error', settle);
  pass.once('exit', settle);
  return pass;
}

/** Force-kill whole process trees by pid. Windows runs the tree kill off the
 *  event loop and resolves to its exit status (null: it could not run or
 *  timed out); POSIX escalates SIGTERM → SIGKILL. Best-effort: the caller
 *  verifies liveness afterwards rather than trusting the signal. */
export async function killProcessTrees(pids, { aliveAt = Date.now() } = {}) {
  const targets = positivePids(pids);
  if (targets.length === 0) return isWin ? 128 : undefined;
  if (isWin) {
    const { command, args } = treeKillCommand(targets, { aliveAt });
    return runHelper(command, args, TREE_KILL_DEADLINE_MS).then(
      ({ code }) => code,
      () => null
    );
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
 * grace wait and no enumeration here — the ChildProcess handle is live, so the
 * pid is current, and a detached tree kill reaps the still-parented tree after
 * the caller is gone. Everything is unref'd/fire-and-forget so the kill can
 * never hold the caller's event loop open (the caller is a process about to exit).
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
    spawnTreeKill([pid], { root: proc, detached: true });
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
    // Every listed pid was identity-checked just above.
    await killProcessTrees(verified);
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
  const initial = descendantsOf(before.childrenOf, pid, before.tokenOf);
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
  const fresh = descendantsOf(after.childrenOf, pid, after.tokenOf);
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
