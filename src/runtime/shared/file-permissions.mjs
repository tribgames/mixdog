import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MessageChannel, receiveMessageOnPort, SHARE_ENV, Worker } from 'node:worker_threads';

let cachedUserSid = null;

// Resolved per call (not promisified once at load) so the live binding of
// child_process.execFile is used.
function execFileAsync(file, args, options) {
  return new Promise((done, fail) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) fail(Object.assign(error, { stdout, stderr }));
      else done({ stdout, stderr });
    });
  });
}

// Securing a published secret by spawning PowerShell costs ~150-200 ms per
// call, and secrets are read far more often than they change. Nothing is
// cached: every non-fresh async call still reads the file's real DACL and
// tightens it when it is not owner-only. File metadata (mtime/ctime/size/id)
// is never treated as evidence of permissions. To make that per-call check
// cheap, one long-lived PowerShell helper per process answers requests over
// stdin/stdout ("<id> <base64 path>" in, "<id> ok|fixed|err <base64 detail>"
// out); concurrent callers share it and are matched by request id. If the
// helper cannot start, crashes, closes its pipes or misses the request
// deadline, every request it held (and later ones, once the restart budget is
// spent) falls back to the spawn-per-call update, so a lost helper never
// skips a check. A definite ACL failure reported by the helper is an error,
// exactly like a failed per-call update.
const ACL_HELPER_REQUEST_TIMEOUT_MS = 15_000;
// At most this many helper starts per window. A lifetime budget let three
// unrelated losses (a request deadline missed across a system sleep, an
// antivirus stall) pin a days-old process to a PowerShell spawn per read.
const ACL_HELPER_MAX_STARTS = 3;
const ACL_HELPER_START_WINDOW_MS = 10 * 60_000;
let aclHelper = null;
let aclHelperStartTimes = [];
let aclHelperSeq = 0;

function aclHelperScript(sid) {
  return [
    "$ErrorActionPreference = 'Stop';",
    `$sid = [System.Security.Principal.SecurityIdentifier]::new(${quoteForPowerShell(sid)});`,
    '$full = [System.Security.AccessControl.FileSystemRights]::FullControl;',
    '$utf8 = [System.Text.Encoding]::UTF8;',
    '$out = [Console]::Out;',
    'while ($null -ne ($line = [Console]::In.ReadLine())) {',
    '$parts = $line.Split(@([char]32), 2);',
    'if ($parts.Count -ne 2) { continue };',
    'try {',
    '$path = $utf8.GetString([Convert]::FromBase64String($parts[1]));',
    '$directory = [System.IO.Directory]::Exists($path);',
    '$current = if ($directory) { [System.IO.Directory]::GetAccessControl($path) }',
    'else { [System.IO.File]::GetAccessControl($path) };',
    '$rules = @($current.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]));',
    '$ownerOnly = $current.AreAccessRulesProtected -and $rules.Count -eq 1 -and',
    "$rules[0].AccessControlType -eq 'Allow' -and $rules[0].IdentityReference -eq $sid -and",
    '$rules[0].FileSystemRights -eq $full;',
    "if ($ownerOnly) { $out.WriteLine($parts[0] + ' ok') } else {",
    '$acl = if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() }',
    'else { [System.Security.AccessControl.FileSecurity]::new() };',
    '$acl.SetAccessRuleProtection($true, $false);',
    '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(',
    '$sid, $full, [System.Security.AccessControl.AccessControlType]::Allow));',
    'if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl) }',
    'else { [System.IO.File]::SetAccessControl($path, $acl) };',
    "$out.WriteLine($parts[0] + ' fixed') }",
    '} catch {',
    "$out.WriteLine($parts[0] + ' err ' + [Convert]::ToBase64String($utf8.GetBytes([string]$_.Exception.Message)))",
    '};',
    '$out.Flush() }',
  ].join(' ');
}

function startAclHelper(icacls, sid) {
  const now = Date.now();
  aclHelperStartTimes = aclHelperStartTimes.filter((at) => now - at < ACL_HELPER_START_WINDOW_MS);
  if (aclHelperStartTimes.length >= ACL_HELPER_MAX_STARTS) return null;
  aclHelperStartTimes.push(now);
  const command = powerShellCommand(icacls, aclHelperScript(sid));
  let child;
  try {
    // Long-lived: run from System32 so it never pins the caller's working
    // directory (a folder a process's cwd sits in cannot be removed).
    child = spawn(command.executable, command.args, {
      cwd: dirname(icacls),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
  const helper = { child, pending: new Map(), buffer: '', dead: false };
  helper.fail = (cause) => {
    if (aclHelper === helper) aclHelper = null;
    if (helper.dead) return;
    helper.dead = true;
    const lost = [...helper.pending.values()];
    helper.pending.clear();
    for (const request of lost) request.lost(cause);
    try {
      child.kill();
    } catch {}
  };
  child.on('error', helper.fail);
  child.on('exit', () => helper.fail(new Error('Windows ACL helper exited')));
  child.stdin.on('error', helper.fail);
  child.stdout.on('error', helper.fail);
  child.stdout.on('close', () => helper.fail(new Error('Windows ACL helper closed its output')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    helper.buffer += chunk;
    let newline = helper.buffer.indexOf('\n');
    while (newline >= 0) {
      const [id, status, detail = ''] = helper.buffer.slice(0, newline).trim().split(' ');
      helper.buffer = helper.buffer.slice(newline + 1);
      newline = helper.buffer.indexOf('\n');
      const request = helper.pending.get(id);
      if (!request) continue;
      helper.pending.delete(id);
      syncAclHelperRef(helper);
      request.answer(status, Buffer.from(detail, 'base64').toString('utf8'));
    }
  });
  syncAclHelperRef(helper);
  return helper;
}

// An idle helper never keeps the process alive; while a request awaits its
// answer the helper's handles do, so the answer is delivered even when the
// request's deadline timer is mocked or otherwise not a live handle.
function syncAclHelperRef(helper) {
  const method = helper.pending.size > 0 ? 'ref' : 'unref';
  helper.child[method]();
  helper.child.stdin[method]?.();
  helper.child.stdout[method]?.();
}

/** Resolves `{ status, detail }` from the helper, or `{ lost }` when it could not answer. */
function askAclHelper(targetPath, icacls, sid) {
  if (!aclHelper) aclHelper = startAclHelper(icacls, sid);
  const helper = aclHelper;
  if (!helper) return Promise.resolve({ lost: new Error('Windows ACL helper unavailable') });
  return new Promise((done) => {
    aclHelperSeq += 1;
    const id = String(aclHelperSeq);
    const timer = setTimeout(() => {
      helper.pending.delete(id);
      syncAclHelperRef(helper);
      done({ lost: new Error('Windows ACL helper timed out') });
      helper.fail(new Error('Windows ACL helper timed out'));
    }, ACL_HELPER_REQUEST_TIMEOUT_MS);
    helper.pending.set(id, {
      answer(status, detail) {
        clearTimeout(timer);
        done({ status, detail });
      },
      lost(cause) {
        clearTimeout(timer);
        done({ lost: cause });
      },
    });
    syncAclHelperRef(helper);
    helper.child.stdin.write(`${id} ${Buffer.from(targetPath, 'utf8').toString('base64')}\n`);
  });
}

// ── Sync bridge ─────────────────────────────────────────────────────────
// Synchronous secret writes (token stores, config) cannot await the helper,
// and a blocking icacls spawn per write held the event loop (and the write's
// file lock) for seconds under load. A worker thread owns a second helper;
// a synchronous caller posts its path and blocks in Atomics.wait only for
// the answer — milliseconds once the helper runs (prewarmOwnerOnlyAclWin32
// starts it off the write path). Shared slots: [0] answer counter, [1] the
// worker exited, [2] the worker is ready. A worker not ready within
// ACL_SYNC_BRIDGE_READY_MS, or gone, sends the caller to the one-shot
// update; an answer later than ACL_SYNC_BRIDGE_TIMEOUT_MS fails the write.
const ACL_SYNC_BRIDGE_READY_MS = 10_000;
// The helper's own deadline plus its one-shot fallback's, with margin.
const ACL_SYNC_BRIDGE_TIMEOUT_MS = 2 * ACL_HELPER_REQUEST_TIMEOUT_MS + 5_000;
let aclSyncBridge = null;
let aclSyncBridgeBroken = false;

function syncBridge() {
  if (aclSyncBridge || aclSyncBridgeBroken) return aclSyncBridge;
  try {
    const url = new URL('./file-permissions-worker.mjs', import.meta.url);
    // Bundled copies (the desktop service) ship no worker beside them.
    if (!existsSync(fileURLToPath(url))) throw new Error('Windows ACL bridge worker is not shipped here');
    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(12));
    const worker = new Worker(url, {
      env: SHARE_ENV,
      execArgv: [],
      workerData: { port: port2, signal },
      transferList: [port2],
    });
    const bridge = { worker, port: port1, signal, seq: 0, startedAt: Date.now() };
    const drop = () => {
      if (aclSyncBridge === bridge) aclSyncBridge = null;
    };
    worker.on('error', drop);
    worker.on('exit', drop);
    worker.unref();
    port1.unref?.();
    aclSyncBridge = bridge;
  } catch {
    aclSyncBridgeBroken = true;
  }
  return aclSyncBridge;
}

function dropSyncBridge(bridge) {
  if (aclSyncBridge !== bridge) return;
  aclSyncBridge = null;
  void bridge.worker.terminate();
}

/** `{ ok: true }`, `{ ok: false, message, code }` (a definite ACL failure),
 *  `{ timedOut: true }`, or `{ lost }` when no bridge could answer. */
function askSyncBridge(targetPath) {
  const bridge = syncBridge();
  if (!bridge) return { lost: new Error('Windows ACL bridge unavailable') };
  bridge.seq += 1;
  const id = bridge.seq;
  let seen = Atomics.load(bridge.signal, 0);
  bridge.port.postMessage({ id, path: targetPath });
  const deadline = Date.now() + ACL_SYNC_BRIDGE_TIMEOUT_MS;
  for (;;) {
    for (let received = receiveMessageOnPort(bridge.port); received; received = receiveMessageOnPort(bridge.port)) {
      if (received.message?.id === id) return received.message;
    }
    const now = Date.now();
    const ready = Atomics.load(bridge.signal, 2) === 1;
    if (Atomics.load(bridge.signal, 1) === 1 || (!ready && now - bridge.startedAt >= ACL_SYNC_BRIDGE_READY_MS)) {
      dropSyncBridge(bridge);
      return { lost: new Error('Windows ACL bridge exited') };
    }
    if (now >= deadline) return { timedOut: true };
    const wait = ready ? deadline - now : Math.min(deadline - now, bridge.startedAt + ACL_SYNC_BRIDGE_READY_MS - now);
    Atomics.wait(bridge.signal, 0, seen, Math.max(1, wait));
    seen = Atomics.load(bridge.signal, 0);
  }
}

/** Test hook: synchronous calls skip the bridge (its one-shot fallback runs). */
export function disableOwnerOnlyAclSyncBridgeForTests() {
  aclSyncBridgeBroken = true;
  if (aclSyncBridge) dropSyncBridge(aclSyncBridge);
}

/** Starts, off any write path, what owner-only enforcement needs on Windows:
 *  this thread's SID and helper, and the sync bridge with its own helper.
 *  Best-effort; never rejects. */
export async function prewarmOwnerOnlyAclWin32({ bridge = true } = {}) {
  if (process.platform !== 'win32') return;
  try {
    const icacls = icaclsPath();
    if (cachedUserSid === null) cachedUserSid = await resolveCurrentUserPrincipalAsync();
    if (!aclHelper) aclHelper = startAclHelper(icacls, cachedUserSid);
    if (bridge) syncBridge()?.port.postMessage({ warm: true });
  } catch {
    /* enforcement itself reports any failure */
  }
}

/** Test/diagnostic hook: whether a helper is attached, its requests awaiting
 *  an answer, and the starts inside the current restart window. */
export function ownerOnlyAclHelperStats() {
  return {
    alive: aclHelper !== null,
    pid: aclHelper?.child.pid ?? null,
    pending: aclHelper?.pending.size ?? 0,
    recentStarts: aclHelperStartTimes.length,
  };
}

/** Test hook: the live helper process, or null. */
export function ownerOnlyAclHelperForTests() {
  return aclHelper?.child ?? null;
}

function systemToolPath(name) {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  return systemRoot ? join(systemRoot, 'System32', name) : null;
}

function currentUserSid(output) {
  // whoami /user /fo csv /nh returns one quoted name,SID record. Read the
  // identity field, not a SID-shaped display name or an assumed authority.
  return (
    String(output)
      .trim()
      .match(/^"(?:[^"]|"")*","(S-\d+(?:-\d+)+)"$/)?.[1] || null
  );
}

function unresolvedUserError() {
  const error = new Error('cannot resolve current Windows user for owner-only ACL enforcement');
  error.code = 'EACLNOUSER';
  return error;
}

function resolveCurrentUserPrincipal() {
  const whoami = systemToolPath('whoami.exe');
  if (whoami && existsSync(whoami)) {
    try {
      const output = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const sid = currentUserSid(output);
      if (sid) return sid;
    } catch {}
  }
  throw unresolvedUserError();
}

async function resolveCurrentUserPrincipalAsync() {
  const whoami = systemToolPath('whoami.exe');
  if (whoami && existsSync(whoami)) {
    try {
      const { stdout } = await execFileAsync(whoami, ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const sid = currentUserSid(stdout);
      if (sid) return sid;
    } catch {}
  }
  throw unresolvedUserError();
}

function icaclsPath() {
  const path = systemToolPath('icacls.exe');
  if (!path) {
    const error = new Error('SystemRoot not set; cannot locate icacls.exe for owner-only ACL enforcement');
    error.code = 'EACLNOROOT';
    throw error;
  }
  if (!existsSync(path)) {
    const error = new Error(`icacls.exe not found at ${path}; refusing to leave secret world-readable`);
    error.code = 'EACLNOICACLS';
    throw error;
  }
  return path;
}

const quoteForPowerShell = (value) => `'${String(value).replaceAll("'", "''")}'`;

function powerShellCommand(icacls, script) {
  return {
    executable: join(dirname(icacls), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    label: 'Windows ACL update',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

function ownerOnlyAclCommand(targetPath, sid, fresh, icacls) {
  if (fresh) {
    return {
      executable: icacls,
      label: 'icacls',
      args: [targetPath, '/inheritance:r', '/grant:r', `*${sid}:(F)`],
    };
  }
  // Never /reset a published secret: that temporarily restores broad parent
  // grants, and a later failure leaves them in place. Build the protected DACL
  // in memory and publish it in one native ACL update instead.
  const quote = quoteForPowerShell;
  const script = [
    "$ErrorActionPreference = 'Stop';",
    `$path = ${quote(targetPath)};`,
    `$sid = [System.Security.Principal.SecurityIdentifier]::new(${quote(sid)});`,
    '$directory = [System.IO.Directory]::Exists($path);',
    '$acl = if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() }',
    'else { [System.Security.AccessControl.FileSecurity]::new() };',
    '$acl.SetAccessRuleProtection($true, $false);',
    '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(',
    '$sid, [System.Security.AccessControl.FileSystemRights]::FullControl,',
    '[System.Security.AccessControl.AccessControlType]::Allow);',
    '$acl.AddAccessRule($rule);',
    'if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl) }',
    'else { [System.IO.File]::SetAccessControl($path, $acl) };',
  ].join(' ');
  return powerShellCommand(icacls, script);
}

// Replaces a directory's whole DACL (explicit grants to anyone else included)
// with one protected, inheritable owner-only grant, in one native update, so
// files created inside need no ACL call of their own. Files already inside
// that carry an explicit grant or any other principal's grant are reset to
// inherit only that owner grant.
function ownerOnlyDirectoryCommand(targetPath, sid, icacls) {
  const script = [
    "$ErrorActionPreference = 'Stop';",
    `$path = ${quoteForPowerShell(targetPath)};`,
    `$sid = [System.Security.Principal.SecurityIdentifier]::new(${quoteForPowerShell(sid)});`,
    '$acl = [System.Security.AccessControl.DirectorySecurity]::new();',
    '$acl.SetAccessRuleProtection($true, $false);',
    '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(',
    '$sid, [System.Security.AccessControl.FileSystemRights]::FullControl,',
    "[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',",
    '[System.Security.AccessControl.PropagationFlags]::None,',
    '[System.Security.AccessControl.AccessControlType]::Allow));',
    '[System.IO.Directory]::SetAccessControl($path, $acl);',
    'foreach ($file in [System.IO.Directory]::GetFiles($path)) {',
    '$current = [System.IO.File]::GetAccessControl($file);',
    '$rules = @($current.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]));',
    '$foreign = @($rules | Where-Object { -not $_.IsInherited -or $_.IdentityReference -ne $sid });',
    'if ($current.AreAccessRulesProtected -or $foreign.Count -gt 0) {',
    '$reset = [System.Security.AccessControl.FileSecurity]::new();',
    '$reset.SetAccessRuleProtection($false, $false);',
    '[System.IO.File]::SetAccessControl($file, $reset) } };',
  ].join(' ');
  return powerShellCommand(icacls, script);
}

function aclFailure(targetPath, cause, label = 'icacls') {
  const error = new Error(`${label} failed to apply owner-only ACL to ${targetPath}: ${cause?.message || cause}`);
  error.code = 'EACLFAIL';
  error.cause = cause;
  return error;
}

// Never resolve security-sensitive executables through PATH or fall back to an
// account name. Successful writes require a proven SID and successful ACL calls.
export function enforceOwnerOnlyAclWin32(targetPath, { fresh = false } = {}) {
  if (process.platform !== 'win32') return;
  const icacls = icaclsPath();
  // Fresh files (the temp and lock files of every synchronous secret write,
  // made while its file lock is held) go to the helper through the sync
  // bridge: one round trip, no process spawned. Only a bridge that is gone
  // falls back to the blocking one-shot update below.
  if (fresh) {
    const reply = askSyncBridge(resolve(targetPath));
    if (reply.ok === true) return;
    if (reply.ok === false) throw Object.assign(new Error(reply.message), { code: reply.code || 'EACLFAIL' });
    if (reply.timedOut) {
      throw aclFailure(targetPath, new Error('the Windows ACL bridge did not answer'), 'Windows ACL helper');
    }
  }
  if (cachedUserSid === null) cachedUserSid = resolveCurrentUserPrincipal();
  const command = ownerOnlyAclCommand(targetPath, cachedUserSid, fresh, icacls);
  try {
    execFileSync(command.executable, command.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    });
  } catch (error) {
    throw aclFailure(targetPath, error, command.label);
  }
}

// Fresh files (unpublished temp/lock files, one or two per secret write) go
// through the helper too: never owner-only yet, each is secured explicitly by
// its DACL replacement. An icacls spawn per write, made inside the write's
// file lock, kept provider-accounts.json locked for 114 s under heavy load
// (each spawn blocked the event loop for seconds as well).
export async function enforceOwnerOnlyAclWin32Async(targetPath, { fresh = false } = {}) {
  if (process.platform !== 'win32') return;
  const icacls = icaclsPath();
  if (cachedUserSid === null) cachedUserSid = await resolveCurrentUserPrincipalAsync();
  const reply = await askAclHelper(resolve(targetPath), icacls, cachedUserSid);
  if (reply.status === 'ok' || reply.status === 'fixed') return;
  if (reply.status === 'err') {
    throw aclFailure(targetPath, new Error(reply.detail || 'unknown error'), 'Windows ACL helper');
  }
  // The helper could not answer: verify with a one-shot update instead.
  return applyOwnerOnlyAclAsync(targetPath, fresh);
}

async function applyOwnerOnlyAclAsync(targetPath, fresh) {
  const icacls = icaclsPath();
  if (cachedUserSid === null) cachedUserSid = await resolveCurrentUserPrincipalAsync();
  const command = ownerOnlyAclCommand(targetPath, cachedUserSid, fresh, icacls);
  try {
    await execFileAsync(command.executable, command.args, { windowsHide: true, timeout: 15_000 });
  } catch (error) {
    throw aclFailure(targetPath, error, command.label);
  }
}

export async function enforceOwnerOnlyDirectoryWin32Async(targetPath) {
  if (process.platform !== 'win32') return;
  const icacls = icaclsPath();
  if (cachedUserSid === null) cachedUserSid = await resolveCurrentUserPrincipalAsync();
  const command = ownerOnlyDirectoryCommand(targetPath, cachedUserSid, icacls);
  try {
    await execFileAsync(command.executable, command.args, { windowsHide: true, timeout: 15_000 });
  } catch (error) {
    throw aclFailure(targetPath, error, command.label);
  }
}
