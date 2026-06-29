// apply_patch — one-turn multi-file edits from a unified diff.
//
// Typical Lead workflow without this tool is `read` → `edit` per file, which
// costs N+1 turns for an N-file refactor. A unified diff already encodes
// every hunk's surrounding context, so we can apply the whole patch
// server-side and skip the read round-trips entirely.
//
// Backend: NATIVE-ONLY. Every supported case is dispatched to the
// mixdog-patch Rust engine via the persistent stdio server. There is NO
// JS apply fallback: unsupported / unsafe input returns a clean Error
// string ("Error: …"), never silently degrades to a different engine.
// `parsePatch(str)` splits a multi-file diff into one object per file
// with `{oldFileName, newFileName, hunks}`; the parsed entries are
// consulted only to derive display path/lines stats and to pre-validate
// path-escape safety before dispatch.
//
// Safety model:
//   - No separate read gate. Hunk context lines are themselves the
//     match proof — if they don't match, the native engine
//     rejects the hunk and nothing is written.
//   - Path-escape pre-validator throws on out-of-base `..` segments and
//     symlink/junction escapes (realpath verifies the target stays inside
//     the basePath even when an intermediate symlink points outside).
//   - `reject_partial:true` (default) — file-batch atomic. Native engine
//     errors out before touching disk.
//   - `reject_partial:false` — file-level isolation. Native engine
//     responds with OK_PARTIAL plus a hex-encoded failures payload that
//     the JS side surfaces per-entry.

import { existsSync, readFileSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, relative as pathRelative, isAbsolute, dirname as pathDirname, join as pathJoin } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parsePatch } from 'diff';
import { getAbortSignalForSession } from '../session/abort-lookup.mjs';
import { startChildGuardian } from '../../../shared/child-guardian.mjs';
import {
  normalizeInputPath,
  normalizeOutputPath,
  resolveAgainstCwd,
  invalidateBuiltinResultCache,
  recordReadSnapshotForPath,
  clearReadSnapshotForPath,
  withBuiltinPathLocks,
} from './builtin.mjs';
import { withAdvisoryLocks } from './builtin/advisory-lock.mjs';
import { markCodeGraphDirtyPaths } from './code-graph-state.mjs';
import { wrapMutationRouteOutput } from './mutation-planner.mjs';
import { getPluginData } from '../config.mjs';
import { ensurePatchBinary, findCachedPatchBinary } from './patch-binary-fetcher.mjs';
import {
  rawContentCacheGet,
  rawContentCacheSet,
} from './builtin/cache-layers.mjs';
import { atomicWrite } from './builtin/atomic-write.mjs';
import { assertPathReachable, assertPathsReachable } from './builtin/fs-reachability.mjs';
export { PATCH_TOOL_DEFS } from './patch-tool-defs.mjs';

const DEV_NULL = /^\/dev\/null$/;
const V4A_EOF_MARKER = '*** End of File';
const V4A_MOVE_TO_PREFIX = '*** Move to:';
const PLUGIN_ROOT = process.env.MIXDOG_ROOT
  || pathResolve(pathDirname(fileURLToPath(import.meta.url)), '../../../..');
const NATIVE_PATCH_DEFAULT_BIN = pathJoin(
  PLUGIN_ROOT,
  'native/mixdog-patch/target/release',
  process.platform === 'win32' ? 'mixdog-patch.exe' : 'mixdog-patch',
);
let _nativePatchServer = null;
let _nativePatchPrewarmTimer = null;
let _nativeEditServer = null;

function markNativePatchRuntimeTouched() {
  try { globalThis.__mixdogNativePatchRuntimeTouched = true; } catch {}
}

function nativePatchMode() {
  return String(process.env.MIXDOG_PATCH_NATIVE || 'auto').toLowerCase();
}

function nativePatchEnabled() {
  return !/^(0|false|no|off|js|legacy)$/i.test(nativePatchMode());
}

function nativePatchTraceEnabled() {
  return /^(1|true|yes)$/i.test(process.env.MIXDOG_PATCH_NATIVE_TRACE || '');
}

function ioTraceEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_IO_TRACE || ''));
}

function ioTrace(event, fields = {}) {
  if (!ioTraceEnabled()) return;
  try {
    process.stderr.write(`[io-trace] ${JSON.stringify({ event, ts: Date.now(), ...fields })}\n`);
  } catch {}
}

function patchTraceEnabled() {
  return ioTraceEnabled()
    || nativePatchTraceEnabled()
    || /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_PATCH_TRACE || ''));
}

function nativePatchPrewarmEnabled() {
  if (!nativePatchEnabled()) return false;
  if (process.env.MIXDOG_PATCH_NATIVE_BIN && !existsSync(nativePatchBinPath())) return false;
  return !/^(0|false|no)$/i.test(process.env.MIXDOG_PATCH_NATIVE_PREWARM || '');
}

function nativePatchPersistent() {
  return /^(1|true|yes|server|persistent)$/i.test(nativePatchMode());
}

function nativePatchBinPath() {
  if (process.env.MIXDOG_PATCH_NATIVE_BIN) return process.env.MIXDOG_PATCH_NATIVE_BIN;
  // Local cargo build first, then a fetched/cached prebuilt; absence is
  // a hard error at dispatch (no JS fallback in native-only mode).
  if (existsSync(NATIVE_PATCH_DEFAULT_BIN)) return NATIVE_PATCH_DEFAULT_BIN;
  return findCachedPatchBinary(getPluginData()) || NATIVE_PATCH_DEFAULT_BIN;
}

async function ensureNativePatchBinaryAvailable() {
  if (!nativePatchEnabled()) {
    throw new Error('apply_patch: native engine disabled via MIXDOG_PATCH_NATIVE; set it to "auto" or "1" to apply patches.');
  }
  const current = nativePatchBinPath();
  if (existsSync(current)) return current;
  if (process.env.MIXDOG_PATCH_NATIVE_BIN) {
    throw new Error(`apply_patch: native patch binary not found at MIXDOG_PATCH_NATIVE_BIN=${current}.`);
  }
  try {
    const fetched = await ensurePatchBinary(getPluginData());
    if (fetched && existsSync(fetched)) return fetched;
  } catch (err) {
    throw new Error(`apply_patch: native patch binary unavailable — ${err?.message || String(err)}`);
  }
  const resolved = nativePatchBinPath();
  if (existsSync(resolved)) return resolved;
  throw new Error(`apply_patch: native patch binary not found at ${resolved}.`);
}

// Decode the hex-encoded failures payload that accompanies OK_PARTIAL:
// the Rust side emits utf-8 bytes (`<path>\t<reason>` records joined by
// `\n`) hex-encoded so they can ride the tab-separated response line
// without escaping. An empty / unparseable payload becomes an empty list
// so a missing field never crashes the caller.
function decodeNativeFailures(hexPayload) {
  if (typeof hexPayload !== 'string' || hexPayload.length === 0) return [];
  if (!/^[0-9a-fA-F]+$/.test(hexPayload) || hexPayload.length % 2 !== 0) return [];
  let text = '';
  try { text = Buffer.from(hexPayload, 'hex').toString('utf-8'); }
  catch { return []; }
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const tab = raw.indexOf('\t');
    if (tab === -1) out.push({ path: '', reason: raw });
    else out.push({ path: raw.slice(0, tab), reason: raw.slice(tab + 1) });
  }
  return out;
}

class NativePatchServer {
  constructor(binPath) {
    this.binPath = binPath;
    // windowsHide: mixdog-patch.exe is a console binary; without this each spawn
    // flashes an empty console window on Windows. Especially visible now that the
    // idle watchdog exits the server and it respawns on the next request.
    this.child = spawn(binPath, ['--server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    startChildGuardian({ childPid: this.child.pid, label: 'native-patch-server', orphanGraceMs: 5000, forceGraceMs: 2000 });
    this.stderr = '';
    this.lines = [];
    this.waiters = [];
    this.exited = false;
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    });
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      const err = new Error(`native patch server exited code=${code} signal=${signal} stderr=${this.stderr}`);
      for (const waiter of this.waiters.splice(0)) waiter.reject(err);
      try { this.rl.close(); } catch {}
    });
  }

  abort(signal) {
    const err = new Error(signal?.reason?.message || signal?.reason || 'native patch aborted');
    err.name = 'AbortError';
    if (_nativePatchServer === this) _nativePatchServer = null;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
    try { this.child.kill('SIGTERM'); } catch {}
    return err;
  }

  nextLine() {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift());
    if (this.exited) return Promise.reject(new Error(`native patch server already exited: ${this.stderr}`));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  ref() {
    try { this.child.ref(); } catch {}
    try { this.child.stdin.ref?.(); } catch {}
    try { this.child.stdout.ref?.(); } catch {}
    try { this.child.stderr.ref?.(); } catch {}
  }

  unref() {
    try { this.child.unref(); } catch {}
    try { this.child.stdin.unref?.(); } catch {}
    try { this.child.stdout.unref?.(); } catch {}
    try { this.child.stderr.unref?.(); } catch {}
  }

  async ping() {
    this.ref();
    const linePromise = this.nextLine();
    this.child.stdin.write('PING\n');
    const line = await linePromise;
    if (line !== 'OK\tPONG') {
      throw new Error(`native patch server ping failed: ${line || 'no native response'}`);
    }
  }

  async apply(basePath, patchText, { fuzz = 2, rejectPartial = true, dryRun = false, signal = null } = {}) {
    this.ref();
    if (signal?.aborted) {
      const err = new Error(signal.reason?.message || signal.reason || 'native patch aborted');
      err.name = 'AbortError';
      throw err;
    }
    const started = performance.now();
    const baseBuf = Buffer.from(basePath, 'utf8');
    const patchBuf = Buffer.from(patchText, 'utf8');
    const linePromise = this.nextLine();
    if (signal) linePromise.catch(() => {});
    let abortListener = null;
    const abortPromise = signal ? new Promise((_, reject) => {
      abortListener = () => {
        reject(this.abort(signal));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }) : null;
    // 7-token APPLY protocol: APPLY <base_len> <patch_len> <timing> <dry_run> <fuzz> <reject_partial>
    // - timing=1 keeps the server emitting per-phase ms fields
    // - dry_run=1 validates without writing; useful for tests and explicit callers
    // - fuzz=0 means strict context match; fuzz=2 absorbs minor outer-context drift and context trailing spaces/tabs
    // - reject_partial=0 unlocks file-level isolation (OK_PARTIAL response)
    const fuzzTok = Number.isFinite(fuzz) && fuzz >= 0 ? Math.floor(fuzz) : 2;
    const rpTok = rejectPartial ? 1 : 0;
    const dryTok = dryRun ? 1 : 0;
    this.child.stdin.write(`APPLY ${baseBuf.length} ${patchBuf.length} 1 ${dryTok} ${fuzzTok} ${rpTok}\n`);
    this.child.stdin.write(baseBuf);
    this.child.stdin.write(patchBuf);
    let line;
    try {
      line = abortPromise ? await Promise.race([linePromise, abortPromise]) : await linePromise;
    } finally {
      if (abortListener) {
        try { signal.removeEventListener('abort', abortListener); } catch {}
      }
    }
    if (!line) throw new Error('no native response');
    if (line.startsWith('ERR\t')) throw new Error(line.slice(4));
    const okFull = line.startsWith('OK\t');
    const okPartial = line.startsWith('OK_PARTIAL\t');
    if (!okFull && !okPartial) throw new Error(line);
    const fields = line.split('\t');
    // fields[0] = "OK" | "OK_PARTIAL".
    //   OK layout:         <files> <readMs> <applyMs> <writeMs> <totalMs> <hashMs> <contentHashes>
    //   OK_PARTIAL layout: <files> <failed> <readMs> <applyMs> <writeMs> <totalMs> <hashMs> <contentHashes> <hexFailures>
    // The OK_PARTIAL line carries an extra <failed> count between <files>
    // and the timing block, plus a trailing <hexFailures> column — keep
    // the two decodes separate so SKIP failure counts stay accurate.
    let files; let readMs; let applyMs; let writeMs; let totalMs; let hashMs;
    let contentHashesRaw; let hexFailures;
    if (okPartial) {
      files = fields[1];
      // fields[2] = <failed> count; the JS layer already derives a failure
      // count from decodeNativeFailures(hexFailures), so skip the raw cell.
      readMs = fields[3];
      applyMs = fields[4];
      writeMs = fields[5];
      totalMs = fields[6];
      hashMs = fields[7];
      contentHashesRaw = fields[8];
      hexFailures = fields[9];
    } else {
      files = fields[1];
      readMs = fields[2];
      applyMs = fields[3];
      writeMs = fields[4];
      totalMs = fields[5];
      hashMs = fields[6];
      contentHashesRaw = fields[7];
    }
    const contentHashes = String(contentHashesRaw || '')
      .split(',')
      .filter((value) => value.length > 0)
      .map((value) => (/^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null));
    const failures = okPartial ? decodeNativeFailures(hexFailures) : [];
    return {
      partial: okPartial,
      files: Number(files) || 0,
      readMs: Number(readMs) || 0,
      applyMs: Number(applyMs) || 0,
      writeMs: Number(writeMs) || 0,
      hashMs: Number(hashMs) || 0,
      totalMs: Number(totalMs) || 0,
      contentHashes,
      contentHash: contentHashes.length === 1 ? contentHashes[0] : null,
      failures,
      roundtripMs: performance.now() - started,
    };
  }

  // EDIT protocol client: invariant-safe char-indexed edit. Mirrors apply()'s
  // abort/await-line handling. EDIT <path_len> <old_len> <new_len> <replace_all>
  // <dry_run> then path+old+new bytes; response is the 8-field OK line with the
  // matched tier.
  async edit(fullPath, oldBuf, newBuf, { replaceAll = false, dryRun = false, signal = null } = {}) {
    this.ref();
    if (signal?.aborted) {
      const err = new Error(signal.reason?.message || signal.reason || 'native edit aborted');
      err.name = 'AbortError';
      throw err;
    }
    const started = performance.now();
    const pathBuf = Buffer.from(fullPath, 'utf8');
    const linePromise = this.nextLine();
    if (signal) linePromise.catch(() => {});
    let abortListener = null;
    const abortPromise = signal ? new Promise((_, reject) => {
      abortListener = () => { reject(this.abort(signal)); };
      signal.addEventListener('abort', abortListener, { once: true });
    }) : null;
    this.child.stdin.write(
      `EDIT ${pathBuf.length} ${oldBuf.length} ${newBuf.length} ${replaceAll ? 1 : 0} ${dryRun ? 1 : 0}\n`,
    );
    this.child.stdin.write(pathBuf);
    this.child.stdin.write(oldBuf);
    this.child.stdin.write(newBuf);
    let line;
    try {
      line = abortPromise ? await Promise.race([linePromise, abortPromise]) : await linePromise;
    } finally {
      if (abortListener) {
        try { signal.removeEventListener('abort', abortListener); } catch {}
      }
    }
    if (!line) throw new Error('no native response');
    if (line.startsWith('ERR\t')) throw new Error(line.slice(4));
    if (!line.startsWith('OK\t')) throw new Error(line);
    const f = line.split('\t');
    // OK \t replacements \t readMs \t applyMs \t writeMs \t totalMs \t tier \t hash
    return {
      replacements: Number(f[1]) || 0,
      readMs: Number(f[2]) || 0,
      applyMs: Number(f[3]) || 0,
      writeMs: Number(f[4]) || 0,
      totalMs: Number(f[5]) || 0,
      tier: f[6] || 'exact',
      contentHash: /^[a-f0-9]{64}$/i.test(f[7] || '') ? f[7].toLowerCase() : null,
      roundtripMs: performance.now() - started,
    };
  }

  async close(options = {}) {
    if (this.exited) return;
    const waitForExit = options?.waitForExit !== false;
    if (!waitForExit) {
      try { this.child.stdin.end('QUIT\n'); } catch {}
      this.unref();
      return;
    }
    this.ref();
    try { this.child.stdin.end('QUIT\n'); } catch {}
    await new Promise((resolve) => this.child.once('exit', resolve));
    try { this.rl.close(); } catch {}
  }
}

function getNativePatchServer() {
  markNativePatchRuntimeTouched();
  const binPath = nativePatchBinPath();
  if (!existsSync(binPath)) {
    throw new Error(`native patch binary not found: ${binPath}`);
  }
  if (!_nativePatchServer || _nativePatchServer.exited || _nativePatchServer.binPath !== binPath) {
    _nativePatchServer = new NativePatchServer(binPath);
  }
  return _nativePatchServer;
}

function getNativeEditServer() {
  markNativePatchRuntimeTouched();
  // Honor MIXDOG_EDIT_NATIVE_BIN (the same override the edit gating checks) so
  // the gated binary and the spawned server binary cannot diverge.
  const binPath = process.env.MIXDOG_EDIT_NATIVE_BIN || nativePatchBinPath();
  if (!existsSync(binPath)) {
    throw new Error(`native patch binary not found: ${binPath}`);
  }
  if (!_nativeEditServer || _nativeEditServer.exited || _nativeEditServer.binPath !== binPath) {
    _nativeEditServer = new NativePatchServer(binPath);
  }
  return _nativeEditServer;
}

// Invariant-safe char-indexed edit over the persistent server (B2). Shares the
// NativePatchServer transport but runs on a DEDICATED instance so edit and
// patch requests never interleave their stdin framing on one stdout stream.
export async function runServerEdit({ fullPath, oldBuf, newBuf, replaceAll = false, dryRun = false, signal = null }) {
  const server = getNativeEditServer();
  return server.edit(fullPath, oldBuf, newBuf, { replaceAll, dryRun, signal });
}

function scheduleNativePatchPrewarm() {
  if (!nativePatchPrewarmEnabled() || _nativePatchPrewarmTimer || _nativePatchServer) return;
  _nativePatchPrewarmTimer = setImmediate(() => {
    void (async () => {
      _nativePatchPrewarmTimer = null;
      const started = performance.now();
      try {
        // Ensure the native binary is present (local build or fetched
        // prebuilt) before starting the server. Best-effort: failures
        // surface as a hard error at dispatch (no JS fallback in the
        // native-only path).
        if (!existsSync(nativePatchBinPath())) {
          try { await ensurePatchBinary(getPluginData()); } catch { /* surfaces at dispatch */ }
        }
        await getNativePatchServer().ping();
        if (!nativePatchPersistent() && (_nativePatchServer?.waiters?.length || 0) === 0) {
          _nativePatchServer?.unref();
        }
        if (nativePatchTraceEnabled()) {
          process.stderr.write(`[patch-native-trace] prewarm_ms=${(performance.now() - started).toFixed(3)}\n`);
        }
      } catch (err) {
        if (nativePatchTraceEnabled()) {
          process.stderr.write(`[patch-native-trace] prewarm_failed=${err?.message || String(err)}\n`);
        }
      }
    })();
  });
  if (_nativePatchPrewarmTimer?.unref) _nativePatchPrewarmTimer.unref();
}

scheduleNativePatchPrewarm();

function scheduleNativePatchIdleClose() {
  if (nativePatchPersistent() || !_nativePatchServer) return;
  if (process.versions?.bun) {
    const server = _nativePatchServer;
    _nativePatchServer = null;
    void server?.close().catch(() => {});
    return;
  }
  _nativePatchServer.unref();
}

export async function closeNativePatchServerForTests(options = {}) {
  if (_nativePatchPrewarmTimer) {
    try { clearImmediate(_nativePatchPrewarmTimer); } catch {}
    _nativePatchPrewarmTimer = null;
  }
  const server = _nativePatchServer;
  _nativePatchServer = null;
  const editServer = _nativeEditServer;
  _nativeEditServer = null;
  await server?.close(options);
  await editServer?.close(options);
}

try { globalThis.__mixdogCloseNativePatchServers = closeNativePatchServerForTests; } catch {}

// Strip the leading `a/` or `b/` prefix that `diff -u` / git emit by
// default, plus timestamp suffixes (`\t2024-...`) that some tools append
// to header lines. parsePatch already splits the name from the header
// so timestamps land in `oldHeader` / `newHeader`, but be defensive.
function stripDiffPrefix(name) {
  if (!name) return name;
  if (isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)) return name;
  const m = /^[ab]\/(.+)$/.exec(name);
  return m ? m[1] : name;
}

function resolveEntryPath(basePath, rawName) {
  const stripped = stripDiffPrefix(rawName);
  const norm = normalizeInputPath(stripped);
  return isAbsolute(norm) ? pathResolve(norm) : resolveAgainstCwd(norm, basePath);
}

// V4A section paths are real repository paths and never carry the unified
// diff `a/`·`b/` prefix, so resolution must NOT apply stripDiffPrefix — a
// legitimate top-level `a/` or `b/` directory would otherwise be silently
// rewritten to its child, reading/writing the wrong file.
function resolveV4AEntryPath(basePath, rawName) {
  const norm = normalizeInputPath(rawName);
  return isAbsolute(norm) ? pathResolve(norm) : resolveAgainstCwd(norm, basePath);
}

function resolveBasePath(cwd, basePath) {
  if (!basePath) return cwd;
  const norm = normalizeInputPath(basePath);
  return isAbsolute(norm) ? pathResolve(norm) : resolveAgainstCwd(norm, cwd);
}

// Categorise the per-file entry. A unified diff can describe:
//   - modify   : both files named, oldFileName exists on disk
//   - create   : oldFileName === /dev/null (or file doesn't exist + hunks start at 0)
//   - delete   : newFileName === /dev/null
function classifyEntry(entry) {
  const oldIsNull = DEV_NULL.test(entry.oldFileName || '');
  const newIsNull = DEV_NULL.test(entry.newFileName || '');
  if (oldIsNull && !newIsNull) return 'create';
  if (!oldIsNull && newIsNull) return 'delete';
  return 'modify';
}

function parsedEntryTargetKey(entry, basePath) {
  if (classifyEntry(entry) !== 'modify') return '';
  const headerName = entry.oldFileName || entry.newFileName;
  if (!headerName || DEV_NULL.test(headerName)) return '';
  const fullPath = resolveEntryPath(basePath, headerName);
  return process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
}

function mergeDuplicateParsedModifyEntries(parsed, basePath) {
  const out = [];
  const byTarget = new Map();
  let changed = false;
  for (const entry of parsed || []) {
    const key = parsedEntryTargetKey(entry, basePath);
    if (!key) {
      out.push(entry);
      continue;
    }
    const existing = byTarget.get(key);
    if (!existing) {
      byTarget.set(key, entry);
      out.push(entry);
      continue;
    }
    existing.hunks.push(...(entry.hunks || []));
    changed = true;
  }
  return { parsed: out, changed };
}

function unifiedRange(start, lines) {
  const s = Math.max(0, Number(start) || 0);
  const n = Math.max(0, Number(lines) || 0);
  return `${s},${n}`;
}

function renderParsedUnifiedPatch(parsed) {
  const out = [];
  for (const entry of parsed || []) {
    out.push(`--- ${entry.oldFileName || '/dev/null'}`);
    out.push(`+++ ${entry.newFileName || '/dev/null'}`);
    for (const hunk of entry.hunks || []) {
      const section = hunk.section ? ` ${hunk.section}` : '';
      out.push(`@@ -${unifiedRange(hunk.oldStart, hunk.oldLines)} +${unifiedRange(hunk.newStart, hunk.newLines)} @@${section}`);
      for (const line of hunk.lines || []) out.push(line);
    }
  }
  return `${out.join('\n')}\n`;
}

function isPatchErrorText(text) {
  return /^Error:/i.test(String(text ?? '').trimStart());
}

// Count how many source lines a hunk consumes vs produces so we can
// surface a concise `lines_changed` figure without re-diffing.
function countHunkChanges(hunks) {
  let added = 0;
  let removed = 0;
  for (const h of hunks || []) {
    for (const line of h.lines || []) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

// Header-shape pre-validator (lexical only): a missing header, a
// `..` segment, or an absolute path that does not resolve inside the
// basePath returns false. Caller wraps the negative result into a clean
// throw so unsupported headers surface as a clean error instead of
// silently degrading to a JS fallback.
function nativeHeaderSupported(entry, basePath) {
  const kind = classifyEntry(entry);
  const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
  if (!headerName || DEV_NULL.test(headerName)) return false;
  // Reject any `..` segment on EITHER oldFileName or newFileName (every
  // non-/dev/null header) — a modify whose newFileName traverses out of
  // base must still be refused even when the resolved path lands inside.
  for (const which of ['oldFileName', 'newFileName']) {
    const raw = entry[which];
    if (!raw || DEV_NULL.test(raw)) continue;
    const segs = normalizeInputPath(stripDiffPrefix(raw)).split(/[\\/]+/);
    if (segs.some((part) => part === '..')) return false;
  }
  const stripped = stripDiffPrefix(headerName);
  const norm = normalizeInputPath(stripped);
  if (isAbsolute(norm) || /^[A-Za-z]:[\\/]/.test(norm)) {
    if (!basePath) return false;
    const absHeader = pathResolve(norm);
    const absBase = pathResolve(basePath);
    const rel = pathRelative(absBase, absHeader);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    if (rel.split(/[\\/]+/).some((part) => part === '..')) return false;
    return true;
  }
  return true;
}

// Resolve `absPath` via fs.realpathSync, walking up to the nearest existing
// ancestor when the leaf does not yet exist (e.g. a create-mode target).
// Returns the resolved real path, or the lexically-resolved path if no
// ancestor can be realpath'd.
function realpathNearestExistingAncestor(absPath) {
  let cur = pathResolve(absPath);
  while (true) {
    try {
      return realpathSync(cur);
    } catch {
      const parent = pathDirname(cur);
      if (!parent || parent === cur) return cur;
      cur = parent;
    }
  }
}

// Pre-validator (throws): walks every parsed entry and enforces
//   - native engine is enabled
//   - native binary exists on disk
//   - each header is shape-supported (no `..`, no out-of-base absolute)
//   - realpath of each non-/dev/null header stays inside the real basePath
//     (catches symlink/junction escapes that lexical checks miss)
//   - no duplicate target paths in the patch (case-insensitive on win32)
// Returns the list of normalized entry rows the dispatcher uses to format
// output, plus the header-rewrite map for absolute-path normalization.
async function preValidateNativeBatch(parsed, basePath) {
  if (!nativePatchEnabled()) {
    throw new Error('apply_patch: native engine disabled via MIXDOG_PATCH_NATIVE; set it to "auto" or "1" to apply patches.');
  }
  const binPath = nativePatchBinPath();
  if (!existsSync(binPath)) {
    throw new Error(`apply_patch: native patch binary not found at ${binPath}; build native/mixdog-patch or fetch the prebuilt before invoking apply_patch.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('apply_patch: patch contained no file sections');
  }
  await assertPathReachable(basePath);
  const reachabilityPaths = [];
  for (const entry of parsed) {
    for (const which of ['oldFileName', 'newFileName']) {
      const checkName = entry[which];
      if (!checkName || DEV_NULL.test(checkName)) continue;
      reachabilityPaths.push(resolveEntryPath(basePath, checkName));
    }
  }
  await assertPathsReachable(reachabilityPaths);
  let realBase;
  try {
    realBase = realpathSync(pathResolve(basePath));
  } catch (err) {
    throw new Error(`apply_patch: base_path unreadable (${err?.code || err?.message || String(err)}): ${basePath}`);
  }
  const entries = [];
  const seenPaths = new Set();
  const headerRewrites = [];
  for (const entry of parsed) {
    const kind = classifyEntry(entry);
    const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
    if (!nativeHeaderSupported(entry, basePath)) {
      const display = headerName ? normalizeOutputPath(stripDiffPrefix(headerName)) : '(unknown)';
      throw new Error(`apply_patch: header ${display} is unsupported (path escapes base_path or contains \`..\`).`);
    }
    if (kind !== 'delete' && !(entry.hunks?.length > 0)) {
      const display = headerName ? normalizeOutputPath(stripDiffPrefix(headerName)) : '(unknown)';
      throw new Error(`apply_patch: entry ${display} has no hunks — patch header malformed (use \`@@ -A,B +C,D @@\` per hunk).`);
    }
    // Realpath each non-/dev/null header; nearest-existing-ancestor handles
    // create-mode leaves that do not yet exist. A symlink/junction whose
    // target escapes basePath fails here even when the lexical check above
    // looked safe.
    for (const which of ['oldFileName', 'newFileName']) {
      const checkName = entry[which];
      if (!checkName || DEV_NULL.test(checkName)) continue;
      const checkFull = resolveEntryPath(basePath, checkName);
      const checkReal = realpathNearestExistingAncestor(checkFull);
      const checkRel = pathRelative(realBase, checkReal);
      if (checkRel.split(/[\\/]+/).some((part) => part === '..') || isAbsolute(checkRel)) {
        const display = normalizeOutputPath(stripDiffPrefix(checkName));
        throw new Error(`apply_patch: ${display} resolves outside base_path via symlink/junction; refusing to apply.`);
      }
    }
    const fullPath = resolveEntryPath(basePath, headerName);
    const pathKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    if (seenPaths.has(pathKey)) {
      const display = normalizeOutputPath(stripDiffPrefix(headerName));
      throw new Error(`apply_patch: duplicate target ${display} — patch lists the same path twice.`);
    }
    seenPaths.add(pathKey);
    const displayPath = normalizeOutputPath(stripDiffPrefix(headerName));
    const { added, removed } = countHunkChanges(entry.hunks);
    entries.push({
      kind,
      fullPath,
      displayPath,
      added,
      removed,
      hunks: entry.hunks?.length || 0,
      linesChanged: added + removed,
    });
    // Absolute-form headers must be rewritten to repo-relative before the
    // native server, which joins headers to basePath, sees them.
    for (const which of ['oldFileName', 'newFileName']) {
      const raw = entry[which];
      if (!raw || DEV_NULL.test(raw)) continue;
      const stripped = stripDiffPrefix(raw);
      const norm = normalizeInputPath(stripped);
      if (!isAbsolute(norm) && !/^[A-Za-z]:[\\/]/.test(norm)) continue;
      const rel = pathRelative(pathResolve(basePath), pathResolve(norm)).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        const display = normalizeOutputPath(stripDiffPrefix(raw));
        throw new Error(`apply_patch: absolute header ${display} does not resolve inside base_path.`);
      }
      headerRewrites.push({ from: raw, to: rel });
    }
  }
  return { entries, headerRewrites };
}

// Rewrite ONLY the file-section header lines (`--- old`/`+++ new`) that
// precede each hunk so the native server, which joins headers to
// basePath, never sees an absolute header. A hunk DELETION line is `-`
// + content, so a deleted line whose body text is `-- C:/...` renders as
// `--- C:/...`; track hunk-body state by consuming each `@@ -a,b +c,d @@`
// header's declared line counts so only lines outside any hunk body are
// eligible for rewrite.
function rewriteHeaderPaths(patchStr, headerRewrites) {
  if (!headerRewrites || headerRewrites.length === 0) return patchStr;
  const lines = patchStr.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      let oldRem = m && m[1] !== undefined ? Number(m[1]) : 1;
      let newRem = m && m[2] !== undefined ? Number(m[2]) : 1;
      i++;
      while (i < lines.length && (oldRem > 0 || newRem > 0)) {
        const body = lines[i];
        const c = body.charAt(0);
        if (c === ' ') { oldRem--; newRem--; }
        else if (c === '-') { oldRem--; }
        else if (c === '+') { newRem--; }
        else if (c === '\\') { /* "\ No newline at end of file" marker */ }
        else break;
        i++;
      }
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const prefix = line.slice(0, 4);
      const rest = line.slice(4);
      const tabIdx = rest.indexOf('\t');
      const pathPart = tabIdx === -1 ? rest : rest.slice(0, tabIdx);
      const suffix = tabIdx === -1 ? '' : rest.slice(tabIdx);
      for (const { from, to } of headerRewrites) {
        if (pathPart === from) {
          lines[i] = `${prefix}${to}${suffix}`;
          break;
        }
      }
    }
    i++;
  }
  return lines.join('\n');
}

function collectUnifiedOldLines(hunk) {
  const oldLines = [];
  // Track whether the immediately preceding hunk line contributed an OLD
  // (context/delete) line, so a following "\ No newline at end of file" marker
  // can flip the trailing-newline flag on the right entry. hasNewline is EXTRA
  // metadata: the push condition stays IDENTICAL to before so old-line offsets
  // and the change-band coordinates are unaffected.
  let lastWasOld = false;
  for (const raw of hunk?.lines || []) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const tag = raw[0];
    if (tag === '-' || tag === ' ') {
      oldLines.push({ tag, line: raw.slice(1), hasNewline: true });
      lastWasOld = true;
      continue;
    }
    if (tag === '\\') {
      // Unified "\ No newline at end of file": the immediately preceding line
      // has no trailing newline. Mirror native (main.rs:1500-1526), which flips
      // the has_newline flag on the preceding line. Only apply to OLD lines —
      // an add-line marker does not affect the context/delete old-line list.
      if (lastWasOld && oldLines.length > 0) oldLines[oldLines.length - 1].hasNewline = false;
      lastWasOld = false;
      continue;
    }
    lastWasOld = false;
  }
  return oldLines;
}

// Ordered op sequence for a hunk (Context/Delete/Add), in source order. Mirrors
// native parts.ops: needed for the change-band computation because Add lines do
// not live in the old-line list yet still bound the interior context region.
// The push condition for context/delete is kept IDENTICAL to
// collectUnifiedOldLines so old-line offsets line up across both views.
function collectUnifiedOps(hunk) {
  const ops = [];
  for (const raw of hunk?.lines || []) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const tag = raw[0];
    if (tag === ' ') ops.push('context');
    else if (tag === '-') ops.push('delete');
    else if (tag === '+') ops.push('add');
  }
  return ops;
}

// Mirror native evaluate_fuzzy_candidate change-band (main.rs:1744-1766): map
// the ordered op sequence into a doubled+shifted old-index coordinate space.
// old_cursor counts consumed OLD lines; Delete at cursor o -> (o+1)*2, Add at
// cursor k -> k*2+1 (strictly between neighbouring old lines). first/last span
// over Adds AND Deletes. {first:null,last:null} means no changes at all.
function computeUnifiedChangeBand(ops) {
  let first = null;
  let last = null;
  let oldCursor = 0;
  for (const op of ops) {
    if (op === 'context') {
      oldCursor += 1;
    } else if (op === 'delete') {
      const pos = (oldCursor + 1) * 2;
      first = first === null ? pos : Math.min(first, pos);
      last = last === null ? pos : Math.max(last, pos);
      oldCursor += 1;
    } else {
      const pos = oldCursor * 2 + 1;
      first = first === null ? pos : Math.min(first, pos);
      last = last === null ? pos : Math.max(last, pos);
    }
  }
  return { first, last };
}

function firstMeaningfulUnifiedHunkLine(hunk) {
  for (const { line } of collectUnifiedOldLines(hunk)) {
    if (line.trim()) return { line, preferredLine: Math.max(0, (Number(hunk?.oldStart) || 1) - 1) };
  }
  return null;
}

// First FAILING old line within a hunk — not its first line. Anchor at the
// deepest-matching prefix (declared oldStart first, then any position where
// the first old line matches) and report the line where the match breaks.
// Without this the rejection message shows the hunk's FIRST context line,
// which often matches perfectly, next to a "nearest" source line identical
// to it — telling the caller nothing about the actual mismatch.
function firstFailingUnifiedHunkLineDetail(sourceLines, hunk) {
  const oldLines = collectUnifiedOldLines(hunk);
  if (!oldLines.length) return null;
  const lineEq = (actual, expected) => {
    const ab = toLineBytes(actual);
    const eb = toLineBytes(expected);
    return ab.equals(eb) || byteTrimPatchWhitespace(ab).equals(byteTrimPatchWhitespace(eb));
  };
  const prefixDepth = (start) => {
    let d = 0;
    while (d < oldLines.length && start + d < sourceLines.length && lineEq(sourceLines[start + d], oldLines[d].line)) d += 1;
    return d;
  };
  const declared = Math.max(0, (Number(hunk?.oldStart) || 1) - 1);
  const candidates = [];
  if (declared < sourceLines.length) candidates.push(declared);
  for (let i = 0; i < sourceLines.length && candidates.length < 8; i++) {
    if (i !== declared && lineEq(sourceLines[i], oldLines[0].line)) candidates.push(i);
  }
  let best = null;
  for (const start of candidates) {
    const depth = prefixDepth(start);
    if (depth >= oldLines.length) continue;
    if (!best || depth > best.depth) best = { start, depth };
  }
  // depth 0 → the hunk's first line itself never anchored; the existing
  // first-meaningful-line message is already the right diagnostic there.
  if (!best || best.depth === 0) return null;
  return {
    line: oldLines[best.depth].line,
    preferredLine: best.start + best.depth,
  };
}

function firstMeaningfulUnifiedEntryLine(entry) {
  const hunks = Array.isArray(entry?.hunks) ? entry.hunks : [];
  for (const hunk of hunks) {
    const expected = firstMeaningfulUnifiedHunkLine(hunk);
    if (expected) return expected;
  }
  return null;
}

// --- Byte-level diagnostic-matcher substrate (diagnostics ONLY) ---------------
// The native engine compares RAW BYTES (main.rs:1867-1875 exact, 1891-1899 ws,
// 1936-1944 normalize). The JS diagnostic matcher mirrors that on Buffer line
// slices so invalid-UTF-8 source bytes are NOT pre-collapsed to U+FFFD. These
// helpers feed unifiedOldLinesMatchAt / findFirstFailingUnifiedHunk and nothing
// on the V4A conversion path.

// Coerce a matcher line value to bytes. Buffer (byte source view OR a raw-byte
// expected line injected by a test) is used as-is; a string (parsed-patch
// expected body, already valid UTF-8 — or a legacy/test plain source array) is
// encoded as UTF-8. Mirrors the fact that native holds both sides as bytes.
function toLineBytes(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8');
}

// Byte version of trim_patch_ws (main.rs:1891-1899): strip ONLY 0x20/0x09 from
// BOTH ends, returning a (zero-copy) subview.
function byteTrimPatchWhitespace(buf) {
  let start = 0;
  let end = buf.length;
  while (start < end && (buf[start] === 0x20 || buf[start] === 0x09)) start++;
  while (end > start && (buf[end - 1] === 0x20 || buf[end - 1] === 0x09)) end--;
  return buf.subarray(start, end);
}

// Reused fatal UTF-8 decoder: mirror native's `from_utf8` validity gate
// (main.rs:1936-1944). Returns the decoded string when the bytes are valid
// UTF-8, else null (the normalize tier is then refused for that line).
const __utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function decodeValidUtf8OrNull(buf) {
  try {
    return __utf8FatalDecoder.decode(buf);
  } catch {
    return null;
  }
}

function unifiedOldLinesMatchAt(sourceLines, oldLines, startIdx, fuzz, band) {
  if (startIdx < 0 || startIdx + oldLines.length > sourceLines.length) return null;
  let fuzzUsed = 0;
  let normCount = 0;
  // A source line has a trailing newline EXCEPT the final line when the file
  // body did not end in '\n' (metadata stashed on the array by
  // splitTextLinesForPatch). Default true when metadata is absent (callers that
  // pass a plain literal array, e.g. tests/legacy) so behaviour is unchanged
  // unless they opt in by setting hasFinalNewline.
  const srcFinalNewline = sourceLines.hasFinalNewline !== false;
  const lastSrcIdx = sourceLines.length - 1;
  for (let offset = 0; offset < oldLines.length; offset++) {
    const expected = oldLines[offset];
    const actualIdx = startIdx + offset;
    // Byte substrate (diagnostics-only): compare RAW BYTES like native instead
    // of JS strings, so invalid-UTF-8 source bytes are not pre-collapsed to
    // U+FFFD. `actualBytes` is a per-line Buffer slice when sourceLines is the
    // byte view (formatNativeFailureContext) and an on-the-fly UTF-8 encode for
    // a plain-string/legacy/test source array; `expectedBytes` is the UTF-8
    // encoding of the parsed-patch old line (or a raw Buffer when a test injects
    // invalid bytes directly).
    const actualBytes = toLineBytes(sourceLines[actualIdx]);
    const expectedBytes = toLineBytes(expected.line);
    // Per-line newline guard (mirror native exact-newline guard main.rs:1867-1875
    // and ws/normalize guards 1891-1899/1928-1947): a tier matches ONLY when the
    // expected and actual trailing-newline state agree. expected.hasNewline is
    // the unified old line's flag (default true, cleared by a "\ No newline"
    // marker); the source line lacks a newline only when it is the final line of
    // a no-trailing-newline file. When they differ, NO tier accepts this line —
    // for a delete line this then falls through to reject (mirror native
    // 1832-1835).
    const expectedNL = expected.hasNewline !== false;
    const actualNL = !(actualIdx === lastSrcIdx && !srcFinalNewline);
    const newlineOk = expectedNL === actualNL;
    // Exact tier (main.rs:1867-1875): raw byte equality.
    if (newlineOk && actualBytes.equals(expectedBytes)) continue;
    // Whitespace tier: mirror native (gate main.rs:1787-1790) which accepts a
    // Context OR Delete line that matches after trimming space/tab (0x20/0x09)
    // from BOTH ends (byte trim, main.rs:1891-1899). Costs no fuzz and does NOT
    // increment normCount.
    if (newlineOk && fuzz > 0 && (expected.tag === ' ' || expected.tag === '-') && byteTrimPatchWhitespace(actualBytes).equals(byteTrimPatchWhitespace(expectedBytes))) continue;
    // Unicode-normalization tier: mirror the native engine, which accepts a
    // context OR delete line that matches only after typographic normalization
    // (dashes/quotes/NBSP) at zero fuzz cost (native gate: Context|Delete). The
    // count of such normalization-only matches is tracked so the candidate
    // selector can prefer a block that anchored without normalization. Without
    // this the diagnostic matcher mislabels which hunk first failed when the
    // source carries exotic code-points.
    //
    // UTF-8 validity guard (exact mirror of native main.rs:1936-1944, which
    // normalizes ONLY when BOTH bodies are valid UTF-8): decode each side with a
    // fatal TextDecoder; if EITHER side is invalid UTF-8 the normalize tier is
    // refused (matching native's `from_utf8` gate). This replaces the old
    // string-level U+FFFD heuristic — a VALID literal U+FFFD present in both
    // sides now normalize-matches, exactly as native does.
    if (
      newlineOk
      && fuzz > 0
      && (expected.tag === ' ' || expected.tag === '-')
    ) {
      const actualStr = decodeValidUtf8OrNull(actualBytes);
      const expectedStr = actualStr === null ? null : decodeValidUtf8OrNull(expectedBytes);
      if (
        actualStr !== null
        && expectedStr !== null
        && normalizeTypographic(actualStr) === normalizeTypographic(expectedStr)
      ) {
        normCount++;
        continue;
      }
    }
    if (fuzz > 0 && expected.tag === ' ') {
      // Mirror native (main.rs:1808-1830): content drift on a context line is
      // only fuzz-consumable when the line is OUTER context (before the first
      // change or after the last). Interior context (strictly inside the change
      // band) must match exactly/ws/normalize — content drift there means the
      // hunk is binding to a different block, so reject. ctx_pos maps the old
      // line at this offset into the band coordinate space: (offset + 1) * 2.
      const ctxPos = (offset + 1) * 2;
      const isOuter = (!band || band.first === null || band.last === null)
        ? true
        : (ctxPos < band.first || ctxPos > band.last);
      if (!isOuter) return null;
      fuzzUsed++;
      if (fuzzUsed <= fuzz) continue;
    }
    return null;
  }
  return { fuzzUsed, normCount };
}

function findUnifiedHunkMatch(sourceLines, hunk, minStartIdx, fuzz) {
  const oldLines = collectUnifiedOldLines(hunk);
  const band = computeUnifiedChangeBand(collectUnifiedOps(hunk));
  const oldStart = Math.max(0, (Number(hunk?.oldStart) || 1) - 1);
  if (oldLines.length === 0) {
    const insertIdx = Math.max(0, Number(hunk?.oldStart) || 0);
    return insertIdx >= minStartIdx && insertIdx <= sourceLines.length ? { start: insertIdx, end: insertIdx } : null;
  }
  if (oldStart >= minStartIdx && unifiedOldLinesMatchAt(sourceLines, oldLines, oldStart, 0, band) !== null) {
    return { start: oldStart, end: oldStart + oldLines.length };
  }
  if (fuzz <= 0) return null;
  let best = null;
  for (let start = minStartIdx; start <= sourceLines.length - oldLines.length; start++) {
    const matched = unifiedOldLinesMatchAt(sourceLines, oldLines, start, fuzz, band);
    if (matched === null) continue;
    const { fuzzUsed, normCount } = matched;
    const distance = Math.abs(start - oldStart);
    // Ordering mirrors native: lower fuzz, THEN fewer normalization-only
    // matches, THEN smaller distance. A block that anchored without
    // normalization always beats a nearer one that needed it.
    if (
      !best ||
      fuzzUsed < best.fuzzUsed ||
      (fuzzUsed === best.fuzzUsed && normCount < best.normCount) ||
      (fuzzUsed === best.fuzzUsed && normCount === best.normCount && distance < best.distance)
    ) {
      best = { start, distance, fuzzUsed, normCount };
    }
  }
  return best ? { start: best.start, end: best.start + oldLines.length } : null;
}

function findFirstFailingUnifiedHunk(entry, sourceLines, fuzz) {
  const hunks = Array.isArray(entry?.hunks) ? entry.hunks : [];
  let minStartIdx = 0;
  for (const hunk of hunks) {
    const match = findUnifiedHunkMatch(sourceLines, hunk, minStartIdx, fuzz);
    if (!match) return hunk;
    minStartIdx = Math.max(minStartIdx, match.end);
  }
  return null;
}

function nativeFailurePathCandidates(parsed) {
  const candidates = new Set();
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    const kind = classifyEntry(entry);
    const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
    if (!headerName) continue;
    const stripped = stripDiffPrefix(headerName);
    const display = normalizeOutputPath(stripped);
    candidates.add(headerName);
    candidates.add(stripped);
    candidates.add(display);
    if (display) {
      candidates.add(`a/${display}`);
      candidates.add(`b/${display}`);
    }
  }
  return [...candidates].filter(Boolean).sort((a, b) => b.length - a.length);
}

function extractNativeFailurePath(message, parsed) {
  const text = String(message || '').trim();
  if (!text) return '';
  const candidates = nativeFailurePathCandidates(parsed);
  for (const candidate of candidates) {
    if (text.startsWith(`${candidate}:`)) return candidate;
  }
  const hunkMatch = /(?:^|\b)hunk rejected in (.+?)(?: \(|$)/i.exec(text);
  if (hunkMatch?.[1]) return hunkMatch[1].trim();
  for (const candidate of candidates) {
    if (text.includes(candidate)) return candidate;
  }
  return '';
}

function nativeFailureMatchesEntry(entry, failedPath) {
  if (!failedPath) return true;
  const kind = classifyEntry(entry);
  const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
  if (!headerName) return false;
  const failed = normalizeOutputPath(stripDiffPrefix(failedPath));
  const display = normalizeOutputPath(stripDiffPrefix(headerName));
  if (!failed || !display) return false;
  // Exact match: single-file / relative-header case.
  if (failed === display) return true;
  // Path-segment-aware containment, both directions:
  //   - display.endsWith('/'+failed): an accepted ABSOLUTE header is rewritten
  //     to a repo-relative path before native dispatch, so the native failure
  //     reports the RELATIVE path while this parsed entry still carries its
  //     ORIGINAL absolute (or longer) path — `.../src/b.js` matches `src/b.js`.
  //   - failed.endsWith('/'+display): the inverse (native path longer than the
  //     parsed header).
  // Anchoring on a leading `/` keeps this segment-boundary aware, so
  // `.../notsrc/app.js` never matches `src/app.js` via raw substring.
  return display.endsWith(`/${failed}`) || failed.endsWith(`/${display}`);
}

function formatNativeFailureContext(parsed, basePath, failedPath = '', options = {}) {
  const entries = Array.isArray(parsed) ? parsed : [];
  const entry = entries.find((candidate) => classifyEntry(candidate) !== 'create' && nativeFailureMatchesEntry(candidate, failedPath))
    || entries.find((candidate) => classifyEntry(candidate) !== 'create');
  const headerName = entry?.oldFileName;
  const displayPath = headerName ? normalizeOutputPath(stripDiffPrefix(headerName)) : '';
  const fuzz = Number.isFinite(options?.fuzz) && options.fuzz > 0 ? Math.floor(options.fuzz) : 0;
  // Two SEPARATE views of the same source file (this is the ONLY shared-source
  // site): `sourceLines` stays a decoded UTF-8 string[] for the downstream hint
  // heuristics (nearestPatchLineHint, .trim(), normalizeTypographic below) which
  // are inherently string-based; `sourceByteLines` is an independent raw-byte
  // view (per-line Buffer slices) for the byte-parity diagnostic matcher so
  // invalid-UTF-8 bytes are not pre-collapsed to U+FFFD. The V4A conversion path
  // (splitTextLinesForPatch at ~1644/~1660 feeding findLineSequence) is NOT
  // touched — it keeps reading utf8 strings.
  let sourceLines = null;
  let sourceByteLines = null;
  try {
    const fullPath = resolveEntryPath(basePath, entry.oldFileName);
    const raw = readFileSync(fullPath); // Buffer — no 'utf8' decode
    sourceByteLines = splitBufferLinesForPatch(raw);
    sourceLines = splitTextLinesForPatch(raw.toString('utf8'));
  } catch {}
  const failingHunk = sourceByteLines ? findFirstFailingUnifiedHunk(entry, sourceByteLines, fuzz) : null;
  const failingDetail = (failingHunk && sourceByteLines)
    ? firstFailingUnifiedHunkLineDetail(sourceByteLines, failingHunk)
    : null;
  const expected = failingDetail || firstMeaningfulUnifiedHunkLine(failingHunk) || firstMeaningfulUnifiedEntryLine(entry);
  if (!entry || !expected?.line) return '';
  const expectedText = JSON.stringify(compactPatchPreviewLine(expected.line));
  let nearest = '';
  let normalizeHint = '';
  if (sourceLines) {
    nearest = nearestPatchLineHint(sourceLines, expected.line, expected.preferredLine);
    // Typographic-mismatch hint: if the expected context line matches a source
    // line ONLY after Unicode normalization, the source likely carries
    // typographic dashes/quotes/NBSP that an ASCII patch can't match exactly.
    const wantNorm = normalizeTypographic(expected.line);
    if (wantNorm) {
      for (let i = 0; i < sourceLines.length; i++) {
        if (sourceLines[i] === expected.line) break; // exact match exists; not a normalization issue
        // normalizeTypographic also .trim()s, so a pure trailing/leading
        // whitespace drift would otherwise fire this typographic hint. Require
        // a genuine code-point difference: the lines must still differ after a
        // plain trim, yet become equal after typographic normalization.
        if (
          sourceLines[i].trim() !== expected.line.trim()
          && normalizeTypographic(sourceLines[i]) === wantNorm
        ) {
          normalizeHint = `context matches after Unicode normalization at line ${i + 1} — source may contain typographic dashes/quotes/NBSP`;
          break;
        }
      }
    }
  }
  return ` expected first old/context line${displayPath ? ` in ${displayPath}` : ''}: ${expectedText}${nearest ? `; ${nearest}` : ''}${normalizeHint ? `; ${normalizeHint}` : ''}; use exact current lines, no stubs.`;
}

// Dispatch the (already validated, header-rewritten) patch to the native
// engine. Throws on any native error; on success returns the formatted
// human-readable response string. Never silently falls back to JS — the
// caller MUST surface throws as `Error: ...` strings.
async function dispatchNativePatch({ entries, basePath, nativePatchStr, fuzz, rejectPartial, dryRun, readStateScope, signal, parsed }) {
  const nativeStart = performance.now();
  let stats;
  try {
    stats = await getNativePatchServer().apply(basePath, nativePatchStr, { fuzz, rejectPartial, dryRun, signal });
  } catch (err) {
    scheduleNativePatchIdleClose();
    const msg = err?.message || String(err);
    const failedPath = extractNativeFailurePath(msg, parsed);
    return `Error: native patch failed — ${msg}${formatNativeFailureContext(parsed, basePath, failedPath, { fuzz })}`;
  }
  const afterInvalidateStart = performance.now();
  // Only invalidate / snapshot entries that actually landed. In isolation
  // mode (OK_PARTIAL) skipped entries still have their original disk state
  // and must not be re-snapshotted.
  const failedDisplaySet = new Set();
  for (const f of stats.failures || []) {
    if (!f?.path) continue;
    failedDisplaySet.add(normalizeOutputPath(f.path));
    failedDisplaySet.add(normalizeOutputPath(stripDiffPrefix(f.path)));
  }
  const writtenEntries = entries.filter((entry) => !failedDisplaySet.has(entry.displayPath));
  const fullPaths = writtenEntries.map((entry) => entry.fullPath);
  if (!dryRun) invalidateBuiltinResultCache(fullPaths);
  const afterInvalidate = performance.now();
  if (!dryRun) markCodeGraphDirtyPaths(fullPaths);
  const afterDirty = performance.now();
  if (!dryRun) {
    for (let i = 0; i < writtenEntries.length; i++) {
      const entry = writtenEntries[i];
      if (entry.kind === 'delete') {
        clearReadSnapshotForPath(entry.fullPath, readStateScope);
      } else {
        const snapshotMeta = {
          source: 'apply_patch_native',
          isPartialView: false,
        };
        const contentHash = stats.contentHashes?.[i] || null;
        if (contentHash) snapshotMeta.contentHash = contentHash;
        recordReadSnapshotForPath(entry.fullPath, readStateScope, snapshotMeta);
      }
    }
  }
  const afterSnapshot = performance.now();
  ioTrace('apply_patch_native', {
    files: writtenEntries.length,
    dryRun,
    partial: stats.partial,
    failed: stats.failures.length,
    roundtripMs: Number(stats.roundtripMs.toFixed(3)),
    rustTotalMs: Number(stats.totalMs.toFixed(3)),
    invalidateMs: Number((afterInvalidate - afterInvalidateStart).toFixed(3)),
    dirtyMs: Number((afterDirty - afterInvalidate).toFixed(3)),
    snapshotMs: Number((afterSnapshot - afterDirty).toFixed(3)),
    contentHashes: (stats.contentHashes || []).filter(Boolean).length,
  });
  if (nativePatchTraceEnabled()) {
    process.stderr.write(
      `[patch-native-trace] files=${writtenEntries.length} partial=${stats.partial ? 1 : 0} failed=${stats.failures.length} roundtrip_ms=${stats.roundtripMs.toFixed(3)} rust_total_ms=${stats.totalMs.toFixed(3)} rust_hash_ms=${stats.hashMs.toFixed(3)} invalidate_ms=${(afterInvalidate - afterInvalidateStart).toFixed(3)} dirty_ms=${(afterDirty - afterInvalidate).toFixed(3)} snapshot_ms=${(afterSnapshot - afterDirty).toFixed(3)} total_js_ms=${(afterSnapshot - nativeStart).toFixed(3)} content_hashes=${(stats.contentHashes || []).filter(Boolean).length}\n`
    );
  }
  if (patchTraceEnabled()) {
    process.stderr.write(`[patch-native] applied files=${writtenEntries.length} partial=${stats.partial ? 1 : 0} ms=${stats.totalMs.toFixed(3)}\n`);
  }
  scheduleNativePatchIdleClose();
  const verb = dryRun ? 'checked' : 'applied';
  const verbLabel = dryRun ? 'Checked' : 'Applied';
  const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
  const kindLabel = (kind) => {
    const text = String(kind || '').trim();
    return text ? `${text.charAt(0).toUpperCase()}${text.slice(1).toLowerCase()}` : 'Update';
  };
  const summary = stats.partial
    ? `Error: Patch Partially ${verbLabel} (${countLabel(writtenEntries.length, 'File')} ${verb} · ${countLabel(stats.failures.length, 'File')} Skipped) (Native)`
    : `${verbLabel} ${countLabel(writtenEntries.length, 'File')} (Native)${dryRun ? ' Dry Run' : ''}`;
  const lines = [summary];
  for (const entry of writtenEntries) {
    const added = entry.added || 0;
    const removed = entry.removed || 0;
    const parts = [];
    if (added > 0) parts.push(`+${countLabel(added, 'Line')}`);
    if (removed > 0) parts.push(`-${countLabel(removed, 'Line')}`);
    const detail = parts.join(' · ');
    lines.push(detail
      ? `  OK ${kindLabel(entry.kind)} ${entry.displayPath} — ${detail}`
      : `  OK ${kindLabel(entry.kind)} ${entry.displayPath}`);
  }
  for (const f of stats.failures || []) {
    lines.push(`  SKIP ${f.path || '(unknown)'} — ${f.reason}${formatNativeFailureContext(parsed, basePath, f.path, { fuzz })}`);
  }
  return lines.join('\n');
}

// Strip BOM + normalize CRLF→LF only. Idempotent and structural — no
// hunk metadata is rewritten.
function prepareInput(patchStr) {
  return String(patchStr).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function isCodexApplyPatchEnvelope(patchStr) {
  const text = prepareInput(patchStr).trimStart();
  return text.startsWith('*** Begin Patch')
    || text.startsWith('*** Add File:')
    || text.startsWith('*** Update File:')
    || text.startsWith('*** Delete File:');
}

function isV4APatchInput(patchStr, format) {
  return String(format || '').toLowerCase() === 'v4a'
    || isCodexApplyPatchEnvelope(patchStr);
}

const UNIFIED_HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const UNIFIED_HUNK_HEADER_CAPTURE_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/;

function hasUnifiedBareV4AHunk(patchStr) {
  const text = prepareInput(patchStr);
  if (!/^--- /m.test(text) || !/^\+\+\+ /m.test(text)) return false;
  return text.split('\n').some((line) => line.startsWith('@@') && !UNIFIED_HUNK_HEADER_RE.test(line));
}

function isUnifiedHunkCountError(err) {
  const message = String(err?.message || err || '');
  return /Hunk at line .*more lines than expected|Hunk at line .*less lines than expected|expected \d+ old lines|line count did not match/i.test(message);
}

function canFallbackCountedUnified(patchStr, requestedFormat, err) {
  if (requestedFormat === 'unified') return false;
  if (isV4APatchInput(patchStr, requestedFormat)) return false;
  const text = prepareInput(patchStr);
  return /^--- /m.test(text)
    && /^\+\+\+ /m.test(text)
    && UNIFIED_HUNK_HEADER_RE.test(text.split('\n').find((line) => line.startsWith('@@')) || '')
    && isUnifiedHunkCountError(err);
}

function planApplyPatchMutationRoute(args, patchStr, requestedFormat) {
  const v4aInput = isV4APatchInput(patchStr, requestedFormat)
    || (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr));
  return {
    sourceTool: 'apply_patch',
    engine: v4aInput ? 'v4a-patch' : 'unified-patch',
    reason: 'direct',
  };
}

function wrapPatchMutationOutput(text, plan, extras = {}) {
  if (isPatchErrorText(text)) return text;
  return wrapMutationRouteOutput(text, plan, extras);
}

function stripPatchPathMetadata(rawPath) {
  let text = String(rawPath || '').trim();
  if (!text) return '';
  const tabIdx = text.indexOf('\t');
  if (tabIdx !== -1) text = text.slice(0, tabIdx).trimEnd();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length > 1) {
    const end = text.indexOf(quote, 1);
    if (end > 0) text = text.slice(1, end);
  }
  return text;
}

function stripV4APathHeader(line, prefix) {
  return stripPatchPathMetadata(String(line || '').slice(prefix.length));
}

function normaliseV4APath(rawPath) {
  const p = stripPatchPathMetadata(rawPath);
  if (!p) return '';
  return p.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
}

function normaliseV4AAnchor(rawAnchor) {
  return String(rawAnchor || '').replace(/\s*@@\s*$/, '').trim();
}

function stripV4AMovePathHeader(line) {
  return normaliseV4APath(String(line || '').slice(V4A_MOVE_TO_PREFIX.length));
}

function isV4AEndOfFileMarker(rawLine) {
  return String(rawLine || '').trim() === V4A_EOF_MARKER;
}

function v4aEnsureUpdateHunk(current, pendingAnchors) {
  return { anchors: pendingAnchors.slice(), lines: [] };
}

function v4aPushBlankContextLine(currentHunk, pendingAnchors) {
  if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(null, pendingAnchors);
  currentHunk.lines.push(' ');
  return currentHunk;
}

function v4aMarkHunkEndOfFile(currentHunk, finishHunk) {
  if (!currentHunk || currentHunk.lines.length === 0) {
    throw new Error('V4A update hunk does not contain any lines before *** End of File');
  }
  currentHunk.isEndOfFile = true;
  finishHunk();
}

// Split a patch string into lines, dropping the single trailing empty element
// produced by the patch's terminal newline. Invariant: a well-formed patch
// ends with "\n", so `"...\n".split("\n")` always yields a spurious final ""
// that is a line *terminator*, not a content line. Absorbing it as a blank
// context line corrupts the last hunk (phantom trailing "" in oldLines) and
// breaks anchoring whenever the matched source region is not followed by a
// blank line. A genuine trailing blank context line survives as the
// second-to-last element, so only the terminator artifact is removed.
function splitPatchLines(patchStr) {
  const lines = prepareInput(patchStr).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function parseV4APatch(patchStr) {
  const lines = splitPatchLines(patchStr);
  const files = [];
  let current = null;
  let pendingAnchors = [];
  let currentHunk = null;

  const finishHunk = () => {
    if (!current || !currentHunk) return;
    if (currentHunk.lines.length > 0) current.hunks.push(currentHunk);
    currentHunk = null;
  };
  const finishFile = () => {
    finishHunk();
    current = null;
    pendingAnchors = [];
  };
  const startFile = (kind, path) => {
    finishFile();
    current = { kind, path: normaliseV4APath(path), hunks: [], lines: [], movePath: null };
    files.push(current);
  };

  for (const rawLine of lines) {
    if (rawLine === '*** Begin Patch' || rawLine === '*** End Patch') continue;
    if (rawLine.startsWith('*** Update File:')) {
      startFile('update', stripV4APathHeader(rawLine, '*** Update File:'));
      continue;
    }
    if (rawLine.startsWith('*** Add File:')) {
      startFile('add', stripV4APathHeader(rawLine, '*** Add File:'));
      continue;
    }
    if (rawLine.startsWith('*** Delete File:')) {
      startFile('delete', stripV4APathHeader(rawLine, '*** Delete File:'));
      continue;
    }
    if (!current) {
      throw new Error(`V4A patch line appears before a file header: ${rawLine}`);
    }
    if (current.kind === 'update' && rawLine.startsWith(V4A_MOVE_TO_PREFIX)) {
      if (current.movePath) {
        throw new Error(`V4A patch lists multiple ${V4A_MOVE_TO_PREFIX} directives for ${current.path}`);
      }
      const dest = stripV4AMovePathHeader(rawLine);
      if (!dest) throw new Error('V4A patch contains an empty move destination path');
      current.movePath = dest;
      continue;
    }
    if (current.kind === 'add') {
      current.lines.push(rawLine.startsWith('+') ? rawLine.slice(1) : rawLine);
      continue;
    }
    if (current.kind === 'delete') {
      continue;
    }
    if (rawLine === '') {
      if (currentHunk) currentHunk = v4aPushBlankContextLine(currentHunk, pendingAnchors);
      continue;
    }
    if (isV4AEndOfFileMarker(rawLine)) {
      v4aMarkHunkEndOfFile(currentHunk, finishHunk);
      currentHunk = null;
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const anchor = normaliseV4AAnchor(rawLine.slice(2));
      if (currentHunk && currentHunk.lines.length > 0) finishHunk();
      pendingAnchors.push(anchor);
      currentHunk = { anchors: pendingAnchors.slice(), lines: [] };
      pendingAnchors = [];
      continue;
    }
    const tag = rawLine[0];
    if (tag !== ' ' && tag !== '-' && tag !== '+') {
      if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(current, pendingAnchors);
      pendingAnchors = [];
      currentHunk.lines.push(` ${rawLine}`);
      continue;
    }
    if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(current, pendingAnchors);
    currentHunk.lines.push(rawLine);
  }
  finishFile();
  const bad = files.find((file) => !file.path);
  if (bad) throw new Error('V4A patch contains an empty file path');
  if (files.length === 0) throw new Error('V4A patch contained no file sections');
  return files;
}

function stripUnifiedV4APathHeader(line, prefix) {
  return stripDiffPrefix(normaliseV4APath(String(line || '').slice(prefix.length)));
}

// Shared parser for unified-input -> V4A sections. The bare and counted
// fallbacks are byte-identical except for (a) the error label and (b) how an
// `@@` line yields its anchor: bare rejects counted headers and takes the raw
// tail; counted requires a counted header and takes its capture group. The
// difference is injected as `resolveAnchor`; everything else is shared.
function parseUnifiedAsV4APatch(patchStr, { label, resolveAnchor }) {
  const lines = splitPatchLines(patchStr);
  const files = [];
  let current = null;
  let pendingAnchors = [];
  let currentHunk = null;

  const finishHunk = () => {
    if (!current || !currentHunk) return;
    if (current.kind === 'update' && currentHunk.lines.length > 0) current.hunks.push(currentHunk);
    currentHunk = null;
  };
  const finishFile = () => {
    finishHunk();
    current = null;
    pendingAnchors = [];
  };
  const startFile = (oldPath, newPath) => {
    finishFile();
    const oldIsNull = DEV_NULL.test(oldPath || '');
    const newIsNull = DEV_NULL.test(newPath || '');
    const kind = oldIsNull ? 'add' : (newIsNull ? 'delete' : 'update');
    const path = kind === 'add' ? newPath : oldPath;
    current = { kind, path: normaliseV4APath(path), hunks: [], lines: [] };
    files.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.startsWith('diff --git ') || rawLine.startsWith('index ') || rawLine.startsWith('new file mode ') || rawLine.startsWith('deleted file mode ')) {
      continue;
    }
    if (rawLine.startsWith('--- ')) {
      const next = lines[i + 1] || '';
      if (next.startsWith('+++ ')) {
        startFile(stripUnifiedV4APathHeader(rawLine, '--- '), stripUnifiedV4APathHeader(next, '+++ '));
        i++;
        continue;
      }
      // A real unified file header `--- X` is ALWAYS immediately followed by a
      // `+++ Y` line. Without the pair, outside a file this is a malformed
      // patch (keep the diagnostic); INSIDE a file it is a hunk-body deletion
      // line whose content starts with `-- ` (rawLine `--- foo`) — fall through
      // to body handling instead of misreading it as a file header.
      if (!current) throw new Error(`${label} missing +++ header after: ${rawLine}`);
    }
    if (!current) continue;
    if (rawLine === '') {
      if (current.kind !== 'update') continue;
      if (currentHunk) currentHunk = v4aPushBlankContextLine(currentHunk, pendingAnchors);
      continue;
    }
    if (current.kind === 'update' && isV4AEndOfFileMarker(rawLine)) {
      v4aMarkHunkEndOfFile(currentHunk, finishHunk);
      currentHunk = null;
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const anchor = resolveAnchor(rawLine);
      if (currentHunk && currentHunk.lines.length > 0) finishHunk();
      pendingAnchors.push(anchor);
      currentHunk = { anchors: pendingAnchors.slice(), lines: [] };
      pendingAnchors = [];
      continue;
    }
    if (current.kind === 'add') {
      if (rawLine[0] === '+') current.lines.push(rawLine.slice(1));
      continue;
    }
    if (current.kind === 'delete') {
      continue;
    }
    const tag = rawLine[0];
    if (tag !== ' ' && tag !== '-' && tag !== '+') {
      if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(current, pendingAnchors);
      pendingAnchors = [];
      currentHunk.lines.push(` ${rawLine}`);
      continue;
    }
    if (!currentHunk) currentHunk = v4aEnsureUpdateHunk(current, pendingAnchors);
    currentHunk.lines.push(rawLine);
  }
  finishFile();
  const bad = files.find((file) => !file.path);
  if (bad) throw new Error(`${label} contains an empty file path`);
  if (files.length === 0) throw new Error(`${label} contained no file sections`);
  return files;
}

function parseUnifiedBareV4APatch(patchStr) {
  return parseUnifiedAsV4APatch(patchStr, {
    label: 'unified bare patch',
    resolveAnchor: (rawLine) => {
      if (UNIFIED_HUNK_HEADER_RE.test(rawLine)) {
        throw new Error('unified bare patch cannot mix counted unified hunks with bare @@ anchors');
      }
      return normaliseV4AAnchor(rawLine.slice(2));
    },
  });
}

function parseUnifiedCountedAsV4APatch(patchStr) {
  return parseUnifiedAsV4APatch(patchStr, {
    label: 'unified fallback',
    resolveAnchor: (rawLine) => {
      const match = UNIFIED_HUNK_HEADER_CAPTURE_RE.exec(rawLine);
      if (!match) throw new Error(`unified fallback requires counted hunk header: ${rawLine}`);
      return normaliseV4AAnchor(match[1] || '');
    },
  });
}

function splitTextLinesForPatch(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n');
  if (body.length === 0) {
    const empty = [];
    // No content -> no final source line that could lack a newline.
    empty.hasFinalNewline = true;
    return empty;
  }
  const lines = body.split('\n');
  // Per-line hasNewline tracking (mirror native): every line carries a trailing
  // newline EXCEPT possibly the final one. The metadata rides on the array as a
  // non-indexed `hasFinalNewline` property so the return value stays a plain
  // string[] for every existing exact/ws/normalize/LCS consumer; only the
  // newline-aware matcher reads it. When `body` ends in '\n', split yields a
  // trailing '' sentinel -> popped -> all real lines had newlines. Otherwise
  // the final element IS real content with no trailing newline.
  let hasFinalNewline = true;
  if (lines[lines.length - 1] === '') lines.pop();
  else hasFinalNewline = false;
  lines.hasFinalNewline = hasFinalNewline;
  return lines;
}

// Byte-aware variant of splitTextLinesForPatch for the DIAGNOSTIC matcher only.
// Takes a raw file Buffer and yields an array of per-line Buffer slices split on
// 0x0A (LF), stripping a single trailing 0x0D (CR) per line so CRLF files behave
// like the string splitter's \r\n -> \n normalization — all WITHOUT lossy UTF-8
// decoding, so invalid bytes survive for native-parity raw byte compares. The
// same non-indexed `hasFinalNewline` metadata rides on the array; values are
// Buffers, which toLineBytes/unifiedOldLinesMatchAt consume directly.
function splitBufferLinesForPatch(buf) {
  const empty = [];
  if (!buf || buf.length === 0) {
    empty.hasFinalNewline = true;
    return empty;
  }
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      let end = i;
      if (end > start && buf[end - 1] === 0x0d) end--; // strip CR of CRLF
      lines.push(buf.subarray(start, end));
      start = i + 1;
    }
  }
  let hasFinalNewline;
  if (start === buf.length) {
    // Buffer ended exactly on a newline -> no dangling final line.
    hasFinalNewline = true;
  } else {
    // Native strips \r ONLY when immediately before \n (CRLF). The FINAL
    // unterminated line has no \n, so a bare trailing \r is KEPT in the
    // compared body to mirror native's exact byte compare.
    lines.push(buf.subarray(start, buf.length));
    hasFinalNewline = false;
  }
  lines.hasFinalNewline = hasFinalNewline;
  return lines;
}

function v4AHunkLineStats(hunk) {
  let oldCount = 0;
  let newCount = 0;
  const oldLines = [];
  const newLines = [];
  for (const raw of hunk.lines || []) {
    if (!raw) continue;
    const tag = raw[0];
    const body = raw.slice(1);
    if (tag === ' ') {
      oldCount++;
      newCount++;
      oldLines.push(body);
      newLines.push(body);
    } else if (tag === '-') {
      oldCount++;
      oldLines.push(body);
    } else if (tag === '+') {
      newCount++;
      newLines.push(body);
    }
  }
  return { oldCount, newCount, oldLines, newLines };
}

function findAnchorLine(lines, anchors, fromLine) {
  let cursor = Math.max(0, fromLine || 0);
  for (const anchorRaw of anchors || []) {
    const anchor = String(anchorRaw || '').trim();
    if (!anchor) continue;
    const found = lines.findIndex((line, idx) => idx >= cursor && line.includes(anchor));
    if (found === -1) return -1;
    cursor = found + 1;
  }
  return cursor;
}

// Length of the longest common (contiguous) substring of `a` and `b`.
// Capped per side so a pathological multi-KB line cannot blow up the
// O(N*M) inner loop; lines beyond `cap` are truncated for the LCS only.
// Used by both the long-single-line context fallback in findLineSequence
// and the nearest-line hint scorer.
function longestCommonSubstringLen(a, b, cap = 4000) {
  if (!a || !b) return 0;
  const A = a.length > cap ? a.slice(0, cap) : a;
  const B = b.length > cap ? b.slice(0, cap) : b;
  const la = A.length;
  const lb = B.length;
  if (la === 0 || lb === 0) return 0;
  let prev = new Int32Array(lb + 1);
  let curr = new Int32Array(lb + 1);
  let best = 0;
  for (let i = 1; i <= la; i++) {
    const ca = A.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      curr[j] = ca === B.charCodeAt(j - 1) ? prev[j - 1] + 1 : 0;
      if (curr[j] > best) best = curr[j];
    }
    const tmp = prev; prev = curr; curr = tmp;
    curr.fill(0);
  }
  return best;
}

// Normalize common typographic code-points to their ASCII equivalents, then
// trim. Mirrors the Rust mixdog-patch normalize_typographic() and V4A
// apply_patch's normalise() so V4A->unified anchor resolution stays consistent
// across engines: an ASCII-authored patch can still anchor on source that
// carries curly quotes, em/en dashes, NBSP and other exotic spaces.
// Rust str::trim() strips Unicode White_Space at both ends. JS String.trim()
// diverges: it trims U+FEFF (BOM/ZWNBSP) but NOT U+0085 (NEL). To stay
// byte-for-byte consistent with native normalise(), trim EXACTLY the Rust
// White_Space set here — include U+0085, exclude U+FEFF.
const RUST_WS = '\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const RUST_TRIM_RE = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, 'g');
function rustTrim(s) {
  return s.replace(RUST_TRIM_RE, '');
}
function normalizeTypographic(s) {
  // Mirror Rust normalise() ORDER: trim FIRST, then apply the dash/quote/space
  // code-point map. Trimming before mapping matches `s.trim().chars().map(...)`.
  return rustTrim(String(s ?? ''))
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, ' ');
}

function findLineSequence(lines, needle, fromLine, preferredLine = 0, options = {}) {
  if (!Array.isArray(needle) || needle.length === 0) return Math.max(0, preferredLine || fromLine || 0);
  const eof = options?.eof === true;
  let minStart = Math.max(0, fromLine || 0);
  if (eof && needle.length <= lines.length) {
    minStart = Math.max(minStart, lines.length - needle.length);
  }
  const preferred = Math.max(0, preferredLine || 0);
  const fuzzy = options && options.fuzzy === false ? false : true;
  const tiers = fuzzy
    ? [
      (a, b) => a === b,
      (a, b) => a.replace(/\s+$/, '') === b.replace(/\s+$/, ''),
      (a, b) => a.trim() === b.trim(),
      // Internal-whitespace-collapse tier: catches reformatted long lines
      // (e.g. re-indented JSON values) where exact bytes drift but the
      // semantic content matches. Runs strictly after stricter tiers so
      // exact / rstrip / trim still win when they match.
      (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim(),
      // Unicode-normalization tier (LAST): typographic dashes/quotes/NBSP in
      // the source vs an ASCII-authored patch. Deterministic code-point map,
      // runs after every whitespace tier so stricter matches always win.
      (a, b) => normalizeTypographic(a) === normalizeTypographic(b),
    ]
    : [
      (a, b) => a === b,
    ];
  for (const eq of tiers) {
    const starts = [];
    for (let i = minStart; i <= lines.length - needle.length; i++) {
      let ok = true;
      for (let k = 0; k < needle.length; k++) {
        if (!eq(lines[i + k], needle[k])) { ok = false; break; }
      }
      if (ok) starts.push(i);
    }
    if (starts.length) {
      starts.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
      return starts[0];
    }
  }
  // Long single-line context fallback. When the entire needle is one long
  // line (>=40 chars after whitespace-collapse) and every equality tier
  // failed, accept a UNIQUE source line whose longest-common-substring
  // with the needle is the file-wide maximum and covers at least half of
  // the needle. Uniqueness is the invariant: ambiguous best-matches
  // return -1, so real mismatches still surface as "context not found"
  // instead of silently anchoring on the wrong line.
  if (fuzzy && needle.length === 1) {
    const want = String(needle[0] ?? '').replace(/\s+/g, ' ').trim();
    if (want.length >= 40) {
      const minLcs = Math.max(40, Math.floor(want.length / 2));
      let bestIdx = -1;
      let bestLcs = 0;
      let bestTies = 0;
      for (let i = minStart; i < lines.length; i++) {
        const cand = String(lines[i] ?? '').replace(/\s+/g, ' ').trim();
        if (cand.length === 0) continue;
        const lcs = longestCommonSubstringLen(cand, want);
        if (lcs < minLcs) continue;
        if (lcs > bestLcs) { bestLcs = lcs; bestIdx = i; bestTies = 1; }
        else if (lcs === bestLcs) { bestTies++; }
      }
      if (bestIdx >= 0 && bestTies === 1) return bestIdx;
    }
  }
  return -1;
}

function compactPatchPreviewLine(line, maxLen = 140) {
  const text = String(line ?? '').replace(/\t/g, '\\t');
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

// Bundled/transpiled sources often store non-ASCII inside string literals as
// literal `\uXXXX` escape sequences (6 ASCII chars). A patch authored with the
// real character can then never match verbatim. These helpers let the V4A
// locator accept a window where each patch line matches the source either
// verbatim or via "patch's real char == file's \uXXXX escape of it".
function escapeNonAsciiForPatch(line) {
  const s = String(line ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code > 0x7f
      ? String.fromCharCode(92) + 'u' + code.toString(16).padStart(4, '0')
      : s[i];
  }
  return out;
}

function findLineSequenceEscapeEquiv(sourceLines, pattern, minStart, preferred) {
  if (!pattern || pattern.length === 0) return -1;
  const starts = [];
  const from = Math.max(0, Number.isFinite(minStart) ? minStart : 0);
  outer: for (let i = from; i + pattern.length <= sourceLines.length; i++) {
    let usedEquiv = false;
    for (let k = 0; k < pattern.length; k++) {
      const pat = pattern[k];
      const src = sourceLines[i + k];
      if (src === pat) continue;
      if (src === escapeNonAsciiForPatch(pat)) { usedEquiv = true; continue; }
      continue outer;
    }
    // Require at least one escape-equivalent line: an all-verbatim window
    // would have been found by the primary matcher already.
    if (usedEquiv) starts.push(i);
  }
  if (starts.length === 0) return -1;
  const pref = Number.isFinite(preferred) && preferred >= 0 ? preferred : 0;
  starts.sort((a, b) => Math.abs(a - pref) - Math.abs(b - pref) || a - b);
  return starts[0];
}

function firstMeaningfulPatchLine(lines) {
  return (lines || []).find((line) => String(line ?? '').trim().length > 0) || '';
}

function scoreSimilarPatchLine(candidate, target) {
  const cand = String(candidate ?? '').trim().replace(/\s+/g, ' ');
  const want = String(target ?? '').trim().replace(/\s+/g, ' ');
  if (!cand || !want) return 0;
  if (cand === want) return 100000;
  let score = 0;
  // Longest common substring drives similarity for long lines: weighting
  // shared-byte run length keeps the "nearest line" hint anchored on the
  // line that actually shares the most content, instead of a short line
  // that happens to embed in (or share a few tokens with) the long target.
  const lcs = longestCommonSubstringLen(cand, want);
  score += lcs * 20;
  if (cand.includes(want) || want.includes(cand)) score += 5000 + Math.min(cand.length, want.length);
  const words = new Set(want.split(/[^A-Za-z0-9_$]+/).filter((word) => word.length > 1));
  for (const word of words) {
    if (cand.includes(word)) score += Math.min(200, word.length * 12);
  }
  // Length-delta penalty only meaningful for short lines; a long line with
  // a large shared-byte run should not be crushed by a modest length gap.
  if (Math.max(cand.length, want.length) < 80) {
    score -= Math.abs(cand.length - want.length);
  }
  return score;
}

function nearestPatchLineHint(sourceLines, expectedLine, preferredLine) {
  const expected = String(expectedLine || '');
  if (!expected.trim()) return '';
  let best = null;
  const preferred = Number.isFinite(preferredLine) && preferredLine >= 0 ? preferredLine : 0;
  for (let i = 0; i < sourceLines.length; i++) {
    const score = scoreSimilarPatchLine(sourceLines[i], expected) - (Math.abs(i - preferred) * 0.01);
    if (!best || score > best.score) best = { score, index: i, line: sourceLines[i] };
  }
  if (!best || best.score <= 0) return '';
  return `nearest line ${best.index + 1}: ${JSON.stringify(compactPatchPreviewLine(best.line))}`;
}

function formatV4AHunkLocator(hunk) {
  return (hunk.anchors || []).filter(Boolean).join(' > ') || '(no anchor)';
}

function formatV4AAnchorMissHint(sourceLines, hunk) {
  const anchors = (hunk?.anchors || []).filter(Boolean);
  const nearest = anchors.length > 0
    ? anchors.map((anchor) => nearestPatchLineHint(sourceLines, anchor, 0)).find(Boolean)
    : null;
  return anchors.length === 0
    ? ' use an existing @@ anchor from the current file or add exact context lines.'
    : ` use an existing @@ anchor from the current file or add exact context lines; no stubs.${nearest ? ` nearest anchor candidate: ${nearest}.` : ''}`;
}

function formatV4AContextMissHint(sourceLines, stats, anchorLine) {
  const expected = firstMeaningfulPatchLine(stats.oldLines);
  const parts = [];
  if (expected) {
    const nearest = nearestPatchLineHint(sourceLines, expected, anchorLine);
    parts.push(`expected first old line: ${JSON.stringify(compactPatchPreviewLine(expected))}`);
    if (nearest) parts.push(nearest);
    const divergence = firstV4ADivergenceHint(sourceLines, stats.oldLines, anchorLine);
    if (divergence) parts.push(divergence);
  }
  parts.push('use exact current context or a broader @@ anchor; no stubs.');
  return ` ${parts.join('; ')}`;
}

// When the FIRST old line does exist verbatim in the source, the real
// mismatch is some later line of the block — name it, with both sides
// JSON-escaped so invisible differences (real char vs literal \uXXXX
// escape, tabs, trailing spaces) become visible in the error.
function firstV4ADivergenceHint(sourceLines, oldLines, anchorLine) {
  const lines = oldLines || [];
  const firstIdx = lines.findIndex((l) => String(l ?? '').trim().length > 0);
  if (firstIdx < 0) return '';
  const first = lines[firstIdx];
  const starts = [];
  for (let i = 0; i < sourceLines.length; i++) {
    if (sourceLines[i] === first) starts.push(i - firstIdx);
  }
  const pref = Number.isFinite(anchorLine) && anchorLine >= 0 ? anchorLine : 0;
  const start = starts.filter((s) => s >= 0)
    .sort((a, b) => Math.abs(a - pref) - Math.abs(b - pref) || a - b)[0];
  if (start === undefined) return '';
  for (let k = 0; k < lines.length; k++) {
    const exp = lines[k];
    const act = sourceLines[start + k];
    if (act !== exp) {
      const actText = act === undefined ? '(past EOF)' : JSON.stringify(compactPatchPreviewLine(act));
      return `first divergent line: old[${k + 1}] expected ${JSON.stringify(compactPatchPreviewLine(exp))} vs file line ${start + k + 1} actual ${actText}`;
    }
  }
  return '';
}

function joinTextLinesForPatch(lines) {
  const body = (lines || []).join('\n');
  return lines?.hasFinalNewline !== false ? `${body}\n` : body;
}

function cloneTextLinesForPatch(sourceLines) {
  const lines = [...(sourceLines || [])];
  lines.hasFinalNewline = sourceLines?.hasFinalNewline !== false;
  return lines;
}

function resolveV4AHunkPosition(sourceLines, hunk, nextSearchLine, options = {}) {
  const stats = v4AHunkLineStats(hunk);
  if (stats.oldCount === 0 && stats.newCount === 0) return { skip: true };
  const fuzzy = options.fuzzy !== false;
  const eof = hunk?.isEndOfFile === true;
  const anchorLine = findAnchorLine(sourceLines, hunk.anchors, nextSearchLine);
  if (anchorLine < 0) {
    const msg = `V4A hunk anchor not found: ${formatV4AHunkLocator(hunk)};${formatV4AAnchorMissHint(sourceLines, hunk)}`;
    return { error: msg };
  }
  let oldLinesPattern = stats.oldLines;
  let newLinesPattern = stats.newLines;
  let oldStartIdx;
  let trimmedTrailing = 0;
  let trimmedTrailingNew = 0;
  if (stats.oldCount === 0) {
    oldStartIdx = eof ? sourceLines.length : anchorLine;
  } else {
    const searchFrom = Math.max(0, anchorLine - 1);
    oldStartIdx = findLineSequence(
      sourceLines,
      oldLinesPattern,
      searchFrom,
      searchFrom,
      { fuzzy, eof },
    );
    if (eof && oldStartIdx < 0 && oldLinesPattern.length > 0 && oldLinesPattern[oldLinesPattern.length - 1] === '') {
      oldLinesPattern = oldLinesPattern.slice(0, -1);
      trimmedTrailing = 1;
      if (newLinesPattern.length > 0 && newLinesPattern[newLinesPattern.length - 1] === '') {
        newLinesPattern = newLinesPattern.slice(0, -1);
        trimmedTrailingNew = 1;
      }
      oldStartIdx = findLineSequence(
        sourceLines,
        oldLinesPattern,
        searchFrom,
        searchFrom,
        { fuzzy, eof },
      );
    }
  }
  // Escape-equivalence fallback (fuzzy, non-EOF only): accept a window where each old
  // line matches the source verbatim OR as the file's literal `\uXXXX` escape
  // of the patch's real character. On match, remap old/context lines to the
  // file's on-disk form so untouched context stays byte-identical and the
  // escape representation survives the edit.
  if (oldStartIdx < 0 && fuzzy && !eof && oldLinesPattern.length > 0) {
    const from = Math.max(0, anchorLine - 1);
    const alt = findLineSequenceEscapeEquiv(sourceLines, oldLinesPattern, from, from);
    if (alt >= 0) {
      const remapped = new Map();
      // Text-keyed remap is only safe when unambiguous: if the SAME patch
      // line text maps to DIFFERENT on-disk forms at different window
      // positions (one verbatim, one escaped), rewriting newLines by text
      // would corrupt an untouched context line — reject the match instead.
      let ambiguous = false;
      for (let k = 0; k < oldLinesPattern.length; k++) {
        const pat = oldLinesPattern[k];
        const src = sourceLines[alt + k];
        if (remapped.has(pat) && remapped.get(pat) !== src) { ambiguous = true; break; }
        remapped.set(pat, src);
      }
      if (!ambiguous) {
        newLinesPattern = newLinesPattern.map((l) => remapped.get(l) ?? l);
        oldLinesPattern = oldLinesPattern.map((_, k) => sourceLines[alt + k]);
        oldStartIdx = alt;
      }
    }
  }
  if (oldStartIdx < 0) {
    const msg = `V4A hunk context not found: ${formatV4AHunkLocator(hunk)};${formatV4AContextMissHint(sourceLines, stats, anchorLine)}`;
    return { error: msg };
  }
  const matchLen = stats.oldCount === 0 ? 0 : oldLinesPattern.length;
  return {
    oldStartIdx,
    matchLen,
    newLines: newLinesPattern,
    nextSearchLine: oldStartIdx + Math.max(1, matchLen),
    trimmedTrailing,
    trimmedTrailingNew,
  };
}

function applyV4AHunksToLines(sourceLines, hunks, options = {}) {
  const lines = cloneTextLinesForPatch(sourceLines);
  const orderedHunks = orderV4AHunksByFilePosition(lines, hunks, options.fuzzy !== false);
  let nextSearchLine = 0;
  const replacements = [];
  for (const hunk of orderedHunks) {
    const loc = resolveV4AHunkPosition(lines, hunk, nextSearchLine, options);
    if (loc.skip) continue;
    if (loc.error) throw new Error(loc.error);
    replacements.push({
      oldStartIdx: loc.oldStartIdx,
      oldLen: loc.matchLen,
      newLines: loc.newLines,
    });
    nextSearchLine = loc.nextSearchLine;
  }
  for (const rep of replacements.reverse()) {
    lines.splice(rep.oldStartIdx, rep.oldLen, ...rep.newLines);
  }
  return lines;
}

// Order-independent hunk ordering for the V4A apply / V4A→unified conversion.
// V4A hunks carry no line numbers and may be authored out of file order (a
// later edit's hunk listed before an earlier one) or against pre-shift line
// numbers. The cursor loops that consume hunks locate each one with a
// forward-only `nextSearchLine`, which rejects an out-of-order hunk even when
// its context is uniquely present ("context not found; nearest line N").
//
// Two-phase, semantics-preserving:
//   Phase 1 — replay the SAME forward-cursor over the input order. If every
//     hunk resolves, the existing cursor semantics are authoritative — they
//     own duplicate-context AND insert-only @@-anchor disambiguation (a later
//     hunk binds to the NEXT matching occurrence after the previous hunk), so
//     we return the hunks UNCHANGED. An already-in-order patch is a guaranteed
//     no-op; nothing about the existing behaviour shifts.
//   Phase 2 (invariant-based recovery) — only when the input order is NOT
//     forward-locatable (a hunk targets a position before a prior hunk).
//     Reorder a hunk ONLY when its old-block (context+delete body lines)
//     appears EXACTLY ONCE in the source as a literal line sequence — that
//     hunk then has a single order-independent position. If ANY hunk is
//     insert-only (no old body) or its old-block is absent / appears more than
//     once (cursor-sensitive), reordering is unsafe: return the input order
//     unchanged so the loop surfaces the original error instead of binding to
//     the wrong occurrence. Direct literal counting (NOT resolveV4AHunkPosition)
//     sidesteps the anchor/cursor/EOF off-by-one quirks of a re-probe.
function orderV4AHunksByFilePosition(sourceLines, hunks, fuzzy) {
  const list = hunks || [];
  if (list.length <= 1) return list;
  // Phase 1: is the input order already forward-locatable? Mirror the
  // conversion/apply loop's `nextSearchLine` advance exactly.
  let nextSearchLine = 0;
  let inputOrderValid = true;
  for (const hunk of list) {
    const stats = v4AHunkLineStats(hunk);
    if (stats.oldCount === 0 && stats.newCount === 0) continue;
    let loc;
    try { loc = resolveV4AHunkPosition(sourceLines, hunk, nextSearchLine, { fuzzy }); }
    catch { loc = { error: true }; }
    if (!loc || loc.error || loc.skip || typeof loc.nextSearchLine !== 'number') {
      inputOrderValid = false;
      break;
    }
    nextSearchLine = loc.nextSearchLine;
  }
  if (inputOrderValid) return list;
  // Phase 2: reorder only hunks whose old-block is a UNIQUE literal sequence.
  const keyed = [];
  for (let idx = 0; idx < list.length; idx++) {
    const hunk = list[idx];
    const stats = v4AHunkLineStats(hunk);
    if (stats.oldCount === 0 && stats.newCount === 0) {
      keyed.push({ hunk, key: Number.MAX_SAFE_INTEGER, idx });
      continue;
    }
    // Old-block = context + delete body lines (prefix-stripped), excluding the
    // EOF marker. Empty = insert-only → no order-independent position.
    const seq = [];
    for (const ln of hunk.lines || []) {
      if (isV4AEndOfFileMarker(ln)) continue;
      const p = ln[0];
      if (p === ' ' || p === '-') seq.push(ln.slice(1));
    }
    if (seq.length === 0) return list;
    // Count exact file-wide occurrences (early-out at 2). Must be exactly one.
    let pos = -1;
    let count = 0;
    for (let i = 0; i + seq.length <= sourceLines.length; i++) {
      let match = true;
      for (let j = 0; j < seq.length; j++) {
        if (sourceLines[i + j] !== seq[j]) { match = false; break; }
      }
      if (match) {
        if (pos < 0) pos = i;
        count++;
        if (count >= 2) break;
      }
    }
    if (count !== 1) return list;
    keyed.push({ hunk, key: pos, idx });
  }
  keyed.sort((a, b) => (a.key - b.key) || (a.idx - b.idx));
  return keyed.map((e) => e.hunk);
}

function isV4ARenameSection(section) {
  return section?.kind === 'update' && !!section?.movePath;
}

function v4aRenamePathKey(absPath) {
  return process.platform === 'win32' ? String(absPath || '').toLowerCase() : String(absPath || '');
}

function v4aRenamePathInsideRealBase(absPath, realBase) {
  const checkReal = realpathNearestExistingAncestor(absPath);
  const checkRel = pathRelative(realBase, checkReal);
  if (!checkRel || checkRel.startsWith('..') || isAbsolute(checkRel)) return false;
  return !checkRel.split(/[\\/]+/).some((part) => part === '..');
}

function validateV4ARenameSection(section, basePath, seenDestKeys, realBase) {
  const escapeErr = v4aSectionPathEscapeError(section, basePath);
  if (escapeErr) return escapeErr;
  const escapeDest = v4aSectionPathEscapeError({ path: section.movePath }, basePath);
  if (escapeDest) return escapeDest;
  const srcFull = resolveV4AEntryPath(basePath, section.path);
  const destFull = resolveV4AEntryPath(basePath, section.movePath);
  if (realBase) {
    if (!v4aRenamePathInsideRealBase(srcFull, realBase)) {
      return `apply_patch: ${normalizeOutputPath(section.path)} resolves outside base_path via symlink/junction; refusing V4A rename.`;
    }
    if (!v4aRenamePathInsideRealBase(destFull, realBase)) {
      return `apply_patch: ${normalizeOutputPath(section.movePath)} resolves outside base_path via symlink/junction; refusing V4A rename.`;
    }
  }
  if (v4aRenamePathKey(srcFull) === v4aRenamePathKey(destFull)) {
    return `apply_patch: V4A rename source and destination are the same path (${normalizeOutputPath(section.path)})`;
  }
  const destKey = v4aRenamePathKey(destFull);
  if (seenDestKeys.has(destKey)) {
    return `apply_patch: duplicate V4A rename destination ${normalizeOutputPath(section.movePath)}`;
  }
  seenDestKeys.add(destKey);
  try {
    const st = statSync(srcFull);
    if (!st.isFile()) {
      return `apply_patch: V4A rename source is not a regular file: ${normalizeOutputPath(section.path)}`;
    }
  } catch (err) {
    return `apply_patch: V4A rename source missing or unreadable: ${normalizeOutputPath(section.path)} (${err?.code || err?.message || String(err)})`;
  }
  try {
    const destSt = statSync(destFull);
    if (destSt.isDirectory()) {
      return `apply_patch: V4A rename destination is a directory: ${normalizeOutputPath(section.movePath)}`;
    }
    if (!destSt.isFile()) {
      return `apply_patch: V4A rename destination is not a regular file: ${normalizeOutputPath(section.movePath)}`;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return `apply_patch: V4A rename destination unreadable: ${normalizeOutputPath(section.movePath)} (${err?.code || err?.message || String(err)})`;
    }
  }
  if (!section.hunks?.length) {
    return `apply_patch: V4A rename for ${normalizeOutputPath(section.path)} has no update hunks`;
  }
  return null;
}

async function applyV4ARenameSection(section, basePath, options = {}) {
  const srcFull = resolveV4AEntryPath(basePath, section.path);
  const destFull = resolveV4AEntryPath(basePath, section.movePath);
  const displaySrc = normalizeOutputPath(section.path);
  const displayDest = normalizeOutputPath(section.movePath);
  let sourceLines;
  try {
    sourceLines = v4aConversionSourceLines(srcFull, options.linesCache || new Map());
  } catch (err) {
    throw new Error(`apply_patch: V4A rename source unreadable: ${displaySrc} (${err?.code || err?.message || String(err)})`);
  }
  let updatedLines;
  try {
    updatedLines = applyV4AHunksToLines(sourceLines, section.hunks, options);
  } catch (err) {
    throw err;
  }
  const newContent = joinTextLinesForPatch(updatedLines);
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      displayPath: displayDest,
      linesChanged: section.hunks.reduce((n, h) => n + (h.lines?.length || 0), 0),
      srcFull,
      destFull,
    };
  }
  const originalContent = readFileSync(srcFull);
  let destBefore = null;
  try {
    destBefore = readFileSync(destFull);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  mkdirSync(pathDirname(destFull), { recursive: true });
  try {
    await atomicWrite(destFull, newContent, { sessionId: options.readStateScope });
    await unlink(srcFull);
  } catch (err) {
    try {
      if (destBefore === null) {
        try { await unlink(destFull); } catch {}
      } else {
        await atomicWrite(destFull, destBefore, { sessionId: options.readStateScope });
      }
    } catch {}
    try {
      await atomicWrite(srcFull, originalContent, { sessionId: options.readStateScope });
    } catch {}
    throw new Error(`apply_patch: V4A rename failed for ${displaySrc} → ${displayDest} (${err?.message || String(err)})`);
  }
  invalidateBuiltinResultCache([srcFull, destFull]);
  markCodeGraphDirtyPaths([srcFull, destFull]);
  clearReadSnapshotForPath(srcFull, options.readStateScope);
  clearReadSnapshotForPath(destFull, options.readStateScope);
  return {
    ok: true,
    displayPath: displayDest,
    fromPath: displaySrc,
    linesChanged: section.hunks.reduce((n, h) => n + (h.lines?.length || 0), 0),
    srcFull,
    destFull,
  };
}

function formatV4ARenameSuccessLines(results) {
  return (results || [])
    .filter((r) => r?.ok && !r.skipped)
    .map((r) => `OK ${r.displayPath} (renamed from ${r.fromPath}, ~${r.linesChanged} lines touched, engine=v4a-rename)`);
}

async function planV4ARenameSections(sections, basePath) {
  const renameSections = (sections || []).filter(isV4ARenameSection);
  const remainingSections = (sections || []).filter((s) => !isV4ARenameSection(s));
  if (renameSections.length === 0) {
    return { renameSections: [], remainingSections };
  }
  if (renameSections.length > 1) {
    throw new Error('apply_patch: only one V4A rename (*** Move to:) per patch is supported; split into separate patches.');
  }
  if (remainingSections.length > 0) {
    throw new Error('apply_patch: V4A rename cannot be combined with other add/update/delete sections in the same patch; apply file edits in a separate patch first.');
  }
  await assertPathReachable(basePath);
  const renameReachPaths = renameSections.flatMap((section) => [
    resolveV4AEntryPath(basePath, section.path),
    resolveV4AEntryPath(basePath, section.movePath),
  ]);
  await assertPathsReachable(renameReachPaths);
  let realBase;
  try {
    realBase = realpathSync(pathResolve(basePath));
  } catch (err) {
    throw new Error(`apply_patch: base_path unreadable (${err?.code || err?.message || String(err)}): ${basePath}`);
  }
  const seenDestKeys = new Set();
  for (const section of renameSections) {
    const errText = validateV4ARenameSection(section, basePath, seenDestKeys, realBase);
    if (errText) throw new Error(errText);
  }
  return {
    renameSections,
    remainingSections,
  };
}

async function applyV4ARenameSections(renameSections, basePath, options = {}) {
  const linesCache = new Map();
  const results = [];
  for (const section of renameSections || []) {
    results.push(await applyV4ARenameSection(section, basePath, { ...options, linesCache }));
  }
  return results;
}

function convertUnifiedBareV4AToUnifiedPatch(patchStr, basePath, options = {}) {
  return convertV4ASectionsToUnifiedPatch(parseUnifiedBareV4APatch(patchStr), basePath, options);
}

function convertUnifiedCountedToUnifiedPatchViaV4A(patchStr, basePath, options = {}) {
  return convertV4ASectionsToUnifiedPatch(parseUnifiedCountedAsV4APatch(patchStr), basePath, options);
}

// Lexical path-escape guard for V4A section paths. Mirrors the check
// `nativeHeaderSupported` runs on unified headers: a `..` segment or an
// absolute path that does not resolve inside basePath is unsupported.
// Run BEFORE the V4A readFileSync so an escape surfaces with a clear
// reason instead of masquerading as an ENOENT "update target unreadable".
function v4aSectionPathEscapeError(section, basePath) {
  const raw = section?.path;
  if (!raw) return null;
  const norm = normalizeInputPath(raw);
  const segs = norm.split(/[\\/]+/);
  if (segs.some((part) => part === '..')) {
    return `apply_patch: header ${normalizeOutputPath(raw)} is unsupported (path escapes base_path or contains \`..\`).`;
  }
  if (isAbsolute(norm) || /^[A-Za-z]:[\\/]/.test(norm)) {
    if (!basePath) return `apply_patch: header ${normalizeOutputPath(raw)} is unsupported (path escapes base_path or contains \`..\`).`;
    const absHeader = pathResolve(norm);
    const absBase = pathResolve(basePath);
    const rel = pathRelative(absBase, absHeader);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]+/).some((part) => part === '..')) {
      return `apply_patch: header ${normalizeOutputPath(raw)} is unsupported (path escapes base_path or contains \`..\`).`;
    }
  }
  return null;
}

function readRawBufForV4AConversion(fullPath) {
  // Fresh statSync (NOT the 5s STAT_CACHE) for raw-cache generation validation:
  // an external modify/delete that bypasses invalidateBuiltinResultCache could
  // otherwise let a stale STAT_CACHE entry match stale raw bytes, anchoring V4A
  // hunks on out-of-date source. Fresh stat is cheap and keeps the byte-read
  // savings on the unchanged common path while rejecting stale generations.
  const st = statSync(fullPath);
  const cached = rawContentCacheGet(fullPath, st);
  if (cached) return cached;
  const rawBuf = readFileSync(fullPath);
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  rawContentCacheSet(fullPath, st, buf);
  return buf;
}

function v4aConversionSourceLines(fullPath, linesCache) {
  if (linesCache.has(fullPath)) return linesCache.get(fullPath);
  const lines = splitTextLinesForPatch(readRawBufForV4AConversion(fullPath).toString('utf-8'));
  linesCache.set(fullPath, lines);
  return lines;
}

// options.rejectPartial (default true)
//   true  — anchor/context miss on any hunk throws and aborts the whole patch
//   false — hunk-level isolation in the V4A→unified conversion: a hunk
//           whose anchor/context cannot be located is dropped; the rest of
//           the file's hunks continue. A file section whose hunks all fail
//           emits no header so the downstream unified-diff parser does not
//           see an empty section. Dropped hunks are appended to
//           options.rejectedHunks for the caller to surface.
async function convertV4ASectionsToUnifiedPatch(sections, basePath, options = {}) {
  // Reachability preflight for update/delete targets: v4aConversionSourceLines
  // does statSync/readFileSync on each non-add section's source file. A
  // dead-mounted target under a reachable basePath would freeze the event loop
  // here, before preValidateNativeBatch's guard. resolveEntryPath is FS-pure.
  {
    const reachPaths = [];
    const _seenReach = new Set();
    for (const s of (sections || [])) {
      if (!s || s.kind === 'add' || typeof s.path !== 'string' || !s.path) continue;
      const fp = resolveV4AEntryPath(basePath, s.path);
      if (_seenReach.has(fp)) continue;
      _seenReach.add(fp);
      reachPaths.push(fp);
    }
    await assertPathsReachable(reachPaths);
  }
  const rejectPartial = options.rejectPartial !== false;
  const rejectedHunks = Array.isArray(options.rejectedHunks) ? options.rejectedHunks : null;
  const fuzzy = options.fuzzy !== false;
  const out = [];
  const v4aLinesCache = new Map();
  for (const section of sections) {
    // Explicit path-escape guard runs BEFORE any readFileSync attempt so
    // a header containing `..` or an out-of-base absolute path surfaces
    // with a clear reason instead of being masked as ENOENT (the V4A
    // "update target unreadable" path) when the escaped target doesn't
    // happen to exist on disk.
    const escapeErr = v4aSectionPathEscapeError(section, basePath);
    if (escapeErr) throw new Error(escapeErr);
    const displayPath = section.path.replace(/\\/g, '/');
    if (section.kind === 'add') {
      out.push('--- /dev/null');
      out.push(`+++ b/${displayPath}`);
      out.push(`@@ -0,0 +1,${section.lines.length} @@`);
      for (const line of section.lines) out.push(`+${line}`);
      continue;
    }
    if (section.kind === 'delete') {
      const fullPath = resolveV4AEntryPath(basePath, section.path);
      let fileLines = [];
      try {
        // Non-UTF-8 targets (UTF-16 BOM / binary) cannot round-trip through
        // decoded `-` lines — the native byte compare rejects the hunk and the
        // file becomes UNDELETABLE through apply_patch. A delete needs no
        // content match; emit the header-only form (already the unreadable-
        // file shape below) and let the engine remove the file by intent.
        const _delRaw = readFileSync(fullPath);
        // decodeValidUtf8OrNull (fatal TextDecoder) instead of Buffer.isUtf8:
        // the daemon may run under a runtime where Buffer.isUtf8 is absent,
        // and a missing-API fallback of "assume UTF-8" silently re-enables
        // the content hunks this gate exists to suppress.
        if (decodeValidUtf8OrNull(_delRaw) !== null) {
          fileLines = v4aConversionSourceLines(fullPath, v4aLinesCache);
        }
      } catch {
        fileLines = [];
      }
      out.push(`--- a/${displayPath}`);
      out.push('+++ /dev/null');
      if (fileLines.length > 0) {
        out.push(`@@ -1,${fileLines.length} +0,0 @@`);
        for (const line of fileLines) out.push(`-${line}`);
      }
      continue;
    }

    const fullPath = resolveV4AEntryPath(basePath, section.path);
    let sourceLines;
    try {
      sourceLines = v4aConversionSourceLines(fullPath, v4aLinesCache);
    } catch (err) {
      throw new Error(`V4A update target unreadable: ${section.path} (${err?.code || err?.message || String(err)}).`);
    }
    const sectionHunks = [];
    const orderedHunks = orderV4AHunksByFilePosition(sourceLines, section.hunks, fuzzy);
    let nextSearchLine = 0;
    for (const hunk of orderedHunks) {
      const stats = v4AHunkLineStats(hunk);
      if (stats.oldCount === 0 && stats.newCount === 0) continue;
      const loc = resolveV4AHunkPosition(sourceLines, hunk, nextSearchLine, { fuzzy });
      if (loc.skip) continue;
      if (loc.error) {
        const msg = `${loc.error.replace(/^V4A hunk /, `V4A hunk ${section.path}: `)}`;
        if (rejectPartial) throw new Error(msg);
        if (rejectedHunks) rejectedHunks.push({ file: section.path, hunk, reason: msg });
        continue;
      }
      const oldStart = stats.oldCount === 0 ? loc.oldStartIdx : loc.oldStartIdx + 1;
      const newStart = oldStart;
      const tail = (hunk.anchors || []).filter(Boolean).join(' ');
      const oldCount = stats.oldCount === 0 ? 0 : loc.matchLen;
      const newCount = stats.newCount - (loc.trimmedTrailingNew || 0);
      sectionHunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${tail ? ` ${tail}` : ''}`);
      // EOF-trim: resolveV4AHunkPosition dropped the trailing empty line from
      // oldLinesPattern (and optionally newLinesPattern). Drop the matching
      // trailing body line(s) so old/new body counts equal the header counts.
      let dropOldAt = -1;
      let dropNewAt = -1;
      if (loc.trimmedTrailing) {
        for (let i = hunk.lines.length - 1; i >= 0; i--) {
          const ln = hunk.lines[i];
          if (isV4AEndOfFileMarker(ln)) continue;
          const p = ln[0];
          if (dropOldAt < 0 && (p === ' ' || p === '-')) dropOldAt = i;
          if (dropNewAt < 0 && loc.trimmedTrailingNew && (p === ' ' || p === '+')) dropNewAt = i;
          if (dropOldAt >= 0 && (!loc.trimmedTrailingNew || dropNewAt >= 0)) break;
        }
      }
      let srcIdx = loc.oldStartIdx;
      const srcEnd = loc.oldStartIdx + loc.matchLen;
      for (let i = 0; i < hunk.lines.length; i++) {
        const line = hunk.lines[i];
        if (isV4AEndOfFileMarker(line)) continue;
        const prefix = line[0];
        if (prefix === ' ' || prefix === '-') {
          if (i === dropOldAt || i === dropNewAt) continue;
          if (srcIdx < srcEnd && srcIdx < sourceLines.length) {
            sectionHunks.push(prefix + sourceLines[srcIdx]);
          } else {
            sectionHunks.push(line);
          }
          srcIdx++;
        } else {
          if (i === dropNewAt) continue;
          sectionHunks.push(line);
        }
      }
      nextSearchLine = loc.nextSearchLine;
    }
    if (sectionHunks.length > 0) {
      out.push(`--- a/${displayPath}`);
      out.push(`+++ b/${displayPath}`);
      for (const line of sectionHunks) out.push(line);
    }
  }
  return out.join('\n') + '\n';
}

// Native-only apply_patch entry point.
//   - Pre-validates security (path-escape, symlink-escape, duplicates).
//   - V4A / unified-bare V4A inputs are converted to standard unified first.
//   - parsePatch errors / unsupported headers / missing binary throw clean
//     Error strings — they DO NOT fall back to a JS engine.
//   - Native engine handles fuzz / reject_partial / hunkless-delete /
//     zero-length-delete entirely. fuzzy:false → fuzz 0 (strict), else 2.
//   - On OK the response includes a per-entry success line + native trace.
//   - On OK_PARTIAL the response prefix is "Error: patch partially applied"
//     and per-entry SKIP lines surface the Rust failure reasons.
// Some providers (notably grok-composer) serialize a multi-line V4A `patch`
// argument as a flat key:value object: the `*** Update File: <path>` header's
// colon-space plus the newlines make the tool-arg decoder split each patch line
// into alternating keys/values, so `patch` arrives as just "*** Begin Patch"
// and the real body leaks into stray top-level keys. Rebuild the original by
// re-joining the patch value with the stray entries in insertion order; the V4A
// parser + native engine then apply it normally. The trigger is tight (an
// incomplete `*** Begin Patch` opener with no newline, plus keys outside the
// schema) so well-formed calls are untouched. Keys on the shape, not the model.
const APPLY_PATCH_SCHEMA_KEYS = new Set(['patch', 'format', 'base_path', 'dry_run', 'reject_partial', 'fuzzy']);
function salvageShatteredV4APatchArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const rawPatch = typeof args.patch === 'string' ? args.patch : '';
  if (!rawPatch.startsWith('*** Begin Patch') || rawPatch.includes('\n') || rawPatch.includes('*** End Patch')) return args;
  const stray = Object.keys(args).filter((k) => !APPLY_PATCH_SCHEMA_KEYS.has(k));
  if (stray.length === 0) return args;
  const lines = [rawPatch];
  for (const key of Object.keys(args)) {
    if (APPLY_PATCH_SCHEMA_KEYS.has(key)) continue;
    lines.push(key);
    lines.push(String(args[key] ?? ''));
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const cleaned = {};
  for (const key of Object.keys(args)) if (APPLY_PATCH_SCHEMA_KEYS.has(key)) cleaned[key] = args[key];
  cleaned.patch = lines.join('\n');
  return cleaned;
}
async function apply_patch(args, cwd, options = {}) {
  args = salvageShatteredV4APatchArgs(args);
  // Strip a leading UTF-8 BOM up-front: editors / PowerShell redirections
  // sometimes prepend `\uFEFF` to text files and the bare BOM trips the
  // unified envelope check.
  const patchStr = (typeof args?.patch === 'string' ? args.patch : '').replace(/^\uFEFF/, '');
  if (!patchStr.trim()) {
    throw new Error('apply_patch: "patch" is required (unified diff or V4A patch string)');
  }
  const requestedFormat = String(args?.format || '').toLowerCase();
  if (requestedFormat && requestedFormat !== 'unified' && requestedFormat !== 'v4a') {
    throw new Error('apply_patch: "format" must be "unified" or "v4a"');
  }
  let mutationPlan = options?.mutationPlan || planApplyPatchMutationRoute(args, patchStr, requestedFormat);
  const readStateScope = options?.readStateScope ?? options?.sessionId ?? null;
  let abortSignal = options?.signal || options?.abortSignal || null;
  if (!abortSignal && options?.sessionId) {
    try { abortSignal = await getAbortSignalForSession(options.sessionId); } catch { abortSignal = null; }
  }
  if (abortSignal?.aborted) {
    throw new Error(abortSignal.reason?.message || abortSignal.reason || 'apply_patch aborted');
  }
  const basePath = resolveBasePath(cwd, args?.base_path);
  try {
    await assertPathReachable(basePath);
  } catch (err) {
    return `Error: ${err?.message || String(err)}`;
  }
  // Default true — file-batch atomic. reject_partial:false unlocks the
  // native engine's OK_PARTIAL isolation mode.
  const rejectPartial = args?.reject_partial !== false;
  const dryRun = args?.dry_run === true;
  const fuzzy = args?.fuzzy !== false;
  // fuzzy:false → strict context match (fuzz 0); else allow 2 lines of
  // outer-context drift and ignore context trailing spaces/tabs. The same
  // fuzz value is forwarded to the V4A line-sequence search so both layers agree.
  const fuzz = fuzzy ? 2 : 0;

  // V4A → unified conversion (in JS). Hunk anchor/context miss in the
  // conversion stage surfaces a clean Error — no JS apply fallback.
  let inputPatchStr = patchStr;
  const rejectedV4AHunks = [];
  const v4aConvertOpts = { rejectPartial, rejectedHunks: rejectedV4AHunks, fuzzy, dryRun, readStateScope };
  let v4aRenamePlan = null;
  if (isV4APatchInput(patchStr, requestedFormat)) {
    try {
      const allSections = parseV4APatch(patchStr);
      v4aRenamePlan = await planV4ARenameSections(allSections, basePath);
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(v4aRenamePlan.remainingSections, basePath, v4aConvertOpts);
      if (v4aRenamePlan.renameSections.length > 0) {
        mutationPlan = v4aRenamePlan.remainingSections.length > 0
          ? { sourceTool: 'apply_patch', engine: 'v4a-patch', reason: 'v4a-mixed' }
          : { sourceTool: 'apply_patch', engine: 'v4a-rename', reason: 'v4a-move' };
      }
    } catch (err) {
      throw new Error(`apply_patch: V4A parse failed — ${err?.message || String(err)}`);
    }
  } else if (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr)) {
    try {
      inputPatchStr = await convertUnifiedBareV4AToUnifiedPatch(patchStr, basePath, v4aConvertOpts);
    } catch (err) {
      throw new Error(`apply_patch: bare @@ parse failed — ${err?.message || String(err)}`);
    }
  }
  let normalizedPatchStr = prepareInput(inputPatchStr);
  const v4aRenameOnly = v4aRenamePlan?.renameSections?.length > 0 && v4aRenamePlan.remainingSections.length === 0;

  // parsePatch remains strict. In auto mode only, counted unified diffs
  // with bad @@ counts can be reinterpreted through the V4A converter so
  // exact old/context lines are still verified before native apply.
  let parsed = [];
  if (!v4aRenameOnly) try {
    parsed = parsePatch(normalizedPatchStr);
  } catch (err) {
    if (!canFallbackCountedUnified(patchStr, requestedFormat, err)) {
      throw new Error(`apply_patch: parse failed — ${err?.message || String(err)}; prefer V4A envelope for multi-hunk edits (no @@ line counts)`);
    }
    try {
      inputPatchStr = await convertUnifiedCountedToUnifiedPatchViaV4A(patchStr, basePath, v4aConvertOpts);
      normalizedPatchStr = prepareInput(inputPatchStr);
      parsed = parsePatch(normalizedPatchStr);
      mutationPlan = {
        sourceTool: 'apply_patch',
        engine: 'v4a-patch',
        reason: 'unified-count-fallback',
      };
    } catch (fallbackErr) {
      throw new Error(`apply_patch: parse failed — ${err?.message || String(err)}; V4A fallback failed — ${fallbackErr?.message || String(fallbackErr)}`);
    }
  }
  if (!v4aRenameOnly && (!Array.isArray(parsed) || parsed.length === 0)) {
    return 'Error: patch contained no file sections';
  }
  if (!v4aRenameOnly) {
    const merged = mergeDuplicateParsedModifyEntries(parsed, basePath);
    if (merged.changed) {
      parsed = merged.parsed;
      normalizedPatchStr = renderParsedUnifiedPatch(parsed);
    }
  }

  // Pre-validate paths / duplicates / symlink escapes — throws on any
  // unsupported entry. Throws bubble out to the tool dispatcher as clean
  // "Error: ..." strings.
  if (!v4aRenameOnly) {
    try {
      await ensureNativePatchBinaryAvailable();
    } catch (err) {
      return `Error: ${err?.message || String(err)}`;
    }
  }
  let entries = [];
  let headerRewrites = [];
  if (!v4aRenameOnly) {
    try {
      ({ entries, headerRewrites } = await preValidateNativeBatch(parsed, basePath));
    } catch (err) {
      return `Error: ${err?.message || String(err)}`;
    }
  }

  const _lockPaths = [
    ...entries.map((entry) => entry.fullPath),
    ...(v4aRenamePlan?.renameSections || []).flatMap((section) => {
      const src = resolveV4AEntryPath(basePath, section.path);
      const dest = resolveV4AEntryPath(basePath, section.movePath);
      return [src, dest];
    }),
  ];

  return withBuiltinPathLocks(_lockPaths, () =>
    withAdvisoryLocks(_lockPaths, async () => {
    let v4aRenameResults = [];
    if (v4aRenamePlan?.renameSections?.length) {
      v4aRenameResults = await applyV4ARenameSections(v4aRenamePlan.renameSections, basePath, v4aConvertOpts);
    }
    if (v4aRenameOnly) {
      const lines = formatV4ARenameSuccessLines(v4aRenameResults);
      if (lines.length === 0) return 'Error: patch contained no applicable file sections';
      return wrapPatchMutationOutput(`${lines.join('\n')}\n`, mutationPlan, { backend: 'v4a-rename' });
    }
    const nativePatchStr = rewriteHeaderPaths(normalizedPatchStr, headerRewrites);
    const nativeResult = await dispatchNativePatch({
      entries,
      basePath,
      nativePatchStr,
      fuzz,
      rejectPartial,
      dryRun,
      readStateScope,
      signal: abortSignal,
      parsed,
    });
    // V4A conversion may have isolated some hunks (rejectPartial:false).
    // Surface them as additional REJECT lines so callers see every dropped
    // change, native or JS-side.
    let combined = nativeResult;
    const renameLines = formatV4ARenameSuccessLines(v4aRenameResults);
    if (renameLines.length > 0 && !isPatchErrorText(nativeResult)) {
      combined = `${renameLines.join('\n')}\n${nativeResult}`;
    }
    if (!isPatchErrorText(combined) && rejectedV4AHunks.length > 0) {
      const tail = [
        '',
        `hunk-level rejected (rejectPartial=false, V4A): ${rejectedV4AHunks.length}`,
        ...rejectedV4AHunks.map((r) => `  REJECT ${r.file || '(unknown)'} — ${String(r.reason || '').split(';')[0].trim()}`),
      ];
      return wrapPatchMutationOutput(`${combined}\n${tail.join('\n')}`, mutationPlan, { backend: 'native-patch' });
    }
    return wrapPatchMutationOutput(combined, mutationPlan, { backend: 'native-patch' });
  }));
}

// Test-only export: lets the regression harness exercise the interior-vs-outer
// change-band logic in findFirstFailingUnifiedHunk without spawning the native
// binary.
export const __patchTestHooks = { findFirstFailingUnifiedHunk, computeUnifiedChangeBand, collectUnifiedOps, unifiedOldLinesMatchAt, splitBufferLinesForPatch };

export async function executePatchTool(name, args, cwd, options = {}) {
  const effectiveCwd = cwd || process.cwd();
  switch (name) {
    case 'apply_patch': {
      let result;
      try {
        result = await apply_patch(args || {}, effectiveCwd, options);
      } catch (err) {
        return `Error: ${err?.message || String(err)}`;
      }
      // ② completion progress (claude "Found N" parity). Best-effort, no-op
      // when onProgress is absent (no progressToken). Never throws — only
      // emits on success (an "Error:" body is left to the tool result alone).
      if (typeof options?.onProgress === 'function') {
        try {
          const _body = String(result);
          if (!/^Error[\s:[]/.test(_body)) {
            if (args?.dry_run === true) options.onProgress('validated');
            else {
              const _m = /^(?:applied|checked)\s+(\d+)\b/m.exec(_body);
              const _n = _m ? Number(_m[1]) : (_body.match(/^\s*OK\s/gm) || []).length;
              options.onProgress(`applied ${_n} files`);
            }
          }
        } catch { /* best-effort */ }
      }
      return result;
    }
    default: throw new Error(`Unknown patch tool: ${name}`);
  }
}
