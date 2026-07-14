// Native mixdog-patch engine transport: persistent stdio server, env-driven
// mode gating, binary resolution, prewarm/idle lifecycle, and the char-indexed
// EDIT client. Split out of patch.mjs; behavior is identical.
//
// Backend: NATIVE-ONLY. Every supported apply/edit case is dispatched to the
// mixdog-patch Rust engine via the persistent stdio server. There is NO JS
// apply fallback: unsupported / unsafe input returns a clean Error string.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, dirname as pathDirname, join as pathJoin } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startChildGuardian } from '../../../../shared/child-guardian.mjs';
import { getPluginData } from '../../config.mjs';
import { ensurePatchBinary, findCachedPatchBinary } from '../patch-binary-fetcher.mjs';

const PLUGIN_ROOT = process.env.MIXDOG_ROOT
  || pathResolve(pathDirname(fileURLToPath(import.meta.url)), '../../../../..');
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

export function nativePatchEnabled() {
  return !/^(0|false|no|off|js|legacy)$/i.test(nativePatchMode());
}

export function nativePatchTraceEnabled() {
  return /^(1|true|yes)$/i.test(process.env.MIXDOG_PATCH_NATIVE_TRACE || '');
}

function ioTraceEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_IO_TRACE || ''));
}

export function ioTrace(event, fields = {}) {
  if (!ioTraceEnabled()) return;
  try {
    process.stderr.write(`[io-trace] ${JSON.stringify({ event, ts: Date.now(), ...fields })}\n`);
  } catch {}
}

export function patchTraceEnabled() {
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

export function nativePatchBinPath(options = {}) {
  if (process.env.MIXDOG_PATCH_NATIVE_BIN) return process.env.MIXDOG_PATCH_NATIVE_BIN;
  // Local cargo build first, then a fetched/cached prebuilt; absence is
  // a hard error at dispatch (no JS fallback in native-only mode).
  const defaultBin = options.defaultBin || NATIVE_PATCH_DEFAULT_BIN;
  if (existsSync(defaultBin)) return defaultBin;
  const dataDir = options.dataDir || getPluginData();
  return findCachedPatchBinary(dataDir, options.fetcherOptions) || defaultBin;
}

export async function ensureNativePatchBinaryAvailable(options = {}) {
  if (!nativePatchEnabled()) {
    throw new Error('apply_patch: native engine disabled via MIXDOG_PATCH_NATIVE; set it to "auto" or "1" to apply patches.');
  }
  const current = nativePatchBinPath(options);
  if (existsSync(current)) return current;
  if (process.env.MIXDOG_PATCH_NATIVE_BIN) {
    throw new Error(`apply_patch: native patch binary not found at MIXDOG_PATCH_NATIVE_BIN=${current}.`);
  }
  try {
    const fetched = await ensurePatchBinary(
      options.dataDir || getPluginData(),
      options.fetcherOptions,
    );
    if (fetched && existsSync(fetched)) return fetched;
  } catch (err) {
    throw new Error(`apply_patch: native patch binary unavailable — ${err?.message || String(err)}`);
  }
  const resolved = nativePatchBinPath(options);
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

export function getNativePatchServer() {
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

export function scheduleNativePatchPrewarm() {
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

export function scheduleNativePatchIdleClose() {
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
