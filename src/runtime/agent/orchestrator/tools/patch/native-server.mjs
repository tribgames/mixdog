// Native mixdog-patch engine transport: persistent stdio server, env-driven
// mode gating, binary resolution, prewarm/idle lifecycle, and the char-indexed
// EDIT client. Split out of patch.mjs; behavior is identical.
//
// Executor: NATIVE-ONLY. Every supported apply/edit case is dispatched to the
// mixdog-patch Rust engine via the persistent stdio server. There is NO JS
// apply fallback: unsupported / unsafe input returns a clean Error string.

import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, dirname as pathDirname, join as pathJoin } from 'node:path';
import { performance } from 'node:perf_hooks';
import { packageNativeToolPath } from '../../../../shared/native-tool-paths.mjs';
import { getPluginData } from '../../config.mjs';
import { ensurePatchBinary, findCachedPatchBinary } from '../patch-binary-fetcher.mjs';

const PLUGIN_ROOT = process.env.MIXDOG_ROOT
  // This module lives at src/runtime/agent/orchestrator/tools/patch/, so the
  // repo root is SIX levels up. Five levels stopped at src/ and made the
  // documented "local cargo build first" rule dead code: the local
  // native/mixdog-patch/target/release build was never found and a stale
  // cached prebuilt was used instead, so native fixes could not be exercised.
  || pathResolve(pathDirname(fileURLToPath(import.meta.url)), '../../../../../..');
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

// Engine-contract gate. The Rust engine embeds this exact marker string; an
// artifact WITHOUT it predates the byte-fidelity contract this build requires
// (line-span rewrites, per-line terminators, BOM as a file prefix), and using
// it silently corrupts bytes — a stale installed binary in the field hits
// exactly that. The check is a literal byte search over the artifact, keyed by
// the digest of those bytes: deterministic, no spawn, no behaviour heuristics.
// The engine contract is proven by the RUNNING SESSION, never by a separate
// probe of a path: the process that will execute the work ANSWERS `CONTRACT`
// over the real protocol — bytes that merely appear (a startup printer) are
// not an answer, and the artifact judged is always the one about to run. A wrapper that prints the marker cannot serve the
// protocol, a swapped artifact cannot change a process that is already
// running, and one session means one verification for any number of callers.
// The marker search below is only a negative pre-filter (skip spawning an
// artifact that cannot possibly answer); it is never the proof.
export const NATIVE_PATCH_ENGINE_CONTRACT = 'mixdog-patch-engine-contract:3';
export const NATIVE_PATCH_CONTRACT_FAILED = 'ENATIVEPATCHCONTRACT';
const ENGINE_CONTRACT_TIMEOUT_MS = 5_000;
// Hard read bound for the handshake: a flood is cut off as it arrives instead
// of being buffered until the timeout.
const ENGINE_CONTRACT_MAX_BYTES = 4_096;

// The handshake exchange itself, over any object that speaks the session
// surface (the live server; a stub in tests). It is a TWO-STEP proof, because
// arrival order proves nothing: a binary's startup output can be scheduled late
// and land inside the post-request window, and a gate that trusts the window
// accepts a printer that never read a byte.
//
//   1. CHALLENGE — a request whose answer can only be produced by READING it: a
//      dry-run EDIT of a probe path carrying a fresh 128-bit nonce. The engine
//      echoes that path back in its `stat` error, so the reply is derived from
//      this request. Bytes printed unasked cannot contain a nonce invented
//      microseconds earlier, whenever they happen to arrive.
//   2. CONTRACT — answered by EXACTLY one `OK\t<marker>` frame.
//
// The challenge writes nothing anywhere: dry_run=1, and the probe path sits
// inside a directory that does not exist, so even a hostile peer that "obeys"
// it cannot create a file. Queued output, trailing bytes, an oversized flood or
// a late frame all invalidate the session — leftover output must never become
// the next command's response.
export async function verifyContractOverSession(session, {
  timeoutMs = ENGINE_CONTRACT_TIMEOUT_MS,
  maxBytes = ENGINE_CONTRACT_MAX_BYTES,
} = {}) {
  _contractVerificationCount += 1;
  try { session.assertAlive?.('contract'); } catch { return false; }
  const expected = `OK\t${NATIVE_PATCH_ENGINE_CONTRACT}`;
  let timer = null;
  let onData = null;
  let seen = 0;
  let overflow = false;
  let signalOverflow = null;
  const overflowed = new Promise((resolve) => { signalOverflow = resolve; });
  session.ref?.();
  try {
    onData = (chunk) => {
      seen += chunk.length;
      if (seen > maxBytes && !overflow) {
        overflow = true;
        signalOverflow(null);
      }
    };
    session.child.stdout.on('data', onData);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    // One request/response exchange. Output that is already queued was produced
    // without being asked for, so it can never be an answer — refuse rather
    // than consume it, and refuse again if anything trails the reply.
    const ask = async (payload) => {
      if (Array.isArray(session.lines) && session.lines.length > 0) return null;
      const linePromise = session.nextLine();
      linePromise.catch(() => {});
      session.child.stdin.write(payload);
      const line = await Promise.race([linePromise, overflowed, timeout]);
      if (overflow || typeof line !== 'string') return null;
      if (Array.isArray(session.lines) && session.lines.length > 0) return null;
      return line;
    };
    const nonce = randomBytes(16).toString('hex');
    const probePath = pathJoin(tmpdir(), `mixdog-engine-challenge-${nonce}`, 'probe');
    const probeBuf = Buffer.from(probePath, 'utf8');
    const challenge = await ask(Buffer.concat([
      Buffer.from(`EDIT ${probeBuf.length} 1 0 0 1\n`, 'utf8'),
      probeBuf,
      Buffer.from('x', 'utf8'),
    ]));
    // Evidence, not timing: the answer carries the nonce this request invented.
    if (typeof challenge !== 'string' || !challenge.includes(nonce)) return false;
    const seenBeforeContract = seen;
    const line = await ask('CONTRACT\n');
    if (line !== expected) return false;
    // Exactly one frame answered CONTRACT — no trailing bytes, no second line.
    const contractBytes = seen - seenBeforeContract;
    if (contractBytes < expected.length || contractBytes > expected.length + 2) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (onData) { try { session.child.stdout.off('data', onData); } catch { /* detached */ } }
    session.unref?.();
  }
}
// Content-keyed NEGATIVE PRE-FILTER only: "these bytes do not carry the marker"
// is a property of the bytes themselves, so remembering it is always true of
// them and skips a pointless spawn. A session VERDICT is never keyed by
// content — see verifiedSession().
const _markerlessDigests = new Set();
let _contractVerificationCount = 0;
// What bounds a non-conforming artifact is this backoff, not a verdict cache:
// after three consecutive failed handshakes, stop spawning for a while.
const CONTRACT_FAILURE_LIMIT = 3;
const CONTRACT_BACKOFF_MS = 30_000;
let _contractFailures = 0;
let _contractBackoffUntil = 0;
let _beforeSpawnHook = null;

export function _engineContractVerificationCountForTest() {
  return _contractVerificationCount;
}

// Clears the CACHES — never the failure ledger. The three-failure bound is
// absolute: only a proven session or the passage of real time reopens it, so no
// exported hatch can turn a flapping artifact back into an unbounded respawn
// loop. Tests that need a pristine ledger import a fresh module instance.
export function _resetEngineContractCachesForTest() {
  _markerlessDigests.clear();
  _beforeSpawnHook = null;
}

/** Read-only: proves the bound is a finite cost, not a permanent lockout. */
export function _contractBackoffRemainingMsForTest() {
  return Math.max(0, _contractBackoffUntil - Date.now());
}

/** Test seam: runs between reading the artifact and spawning the session. */
export function _setBeforeEngineSpawnHookForTest(hook) {
  _beforeSpawnHook = typeof hook === 'function' ? hook : null;
}

function contractBackoffActive() {
  if (_contractBackoffUntil === 0) return false;
  if (Date.now() < _contractBackoffUntil) return true;
  _contractBackoffUntil = 0;
  _contractFailures = 0;
  return false;
}

function noteContractFailure() {
  _contractFailures += 1;
  if (_contractFailures >= CONTRACT_FAILURE_LIMIT) {
    _contractBackoffUntil = Date.now() + CONTRACT_BACKOFF_MS;
  }
}

function clearContractFailures() {
  _contractFailures = 0;
  _contractBackoffUntil = 0;
}

function readArtifactOrNull(binPath) {
  try {
    return readFileSync(binPath);
  } catch {
    return null;
  }
}

function digestOf(bytes) {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null;
}

function contractFailure(action) {
  const err = new Error(
    `native patch engine did not state contract ${NATIVE_PATCH_ENGINE_CONTRACT} (${action})`,
  );
  err.code = NATIVE_PATCH_CONTRACT_FAILED;
  return err;
}

function currentSession(kind) {
  return kind === 'edit' ? _nativeEditServer : _nativePatchServer;
}

// The ONE binary resolution, for every kind. The gate hashes what this returns
// and the session spawns exactly the same path, so "verified artifact" and
// "executed artifact" cannot be two different files. The edit override is
// resolved HERE and nowhere else: a second resolution inside the edit getter
// let a markerless override run while the genuine engine took the exam.
function nativeBinPathFor(kind) {
  if (kind === 'edit' && process.env.MIXDOG_EDIT_NATIVE_BIN) {
    return process.env.MIXDOG_EDIT_NATIVE_BIN;
  }
  return nativePatchBinPath();
}

function spawnSession(kind, binPath) {
  return kind === 'edit' ? getNativeEditServer(binPath) : getNativePatchServer(binPath);
}

// A LIVE session that already proved itself IS the proof — no disk read and no
// metadata are consulted while it lives. Only a cold start looks at the file.
function liveVerifiedSession(kind) {
  const server = currentSession(kind);
  if (!server || server.exited || server.contractFailed) return null;
  return server.contractVerified === true ? server : null;
}

// Shared by the apply and edit sessions: reuse a proven session, else read the
// artifact ONCE, key the verdict on those exact bytes, and make the spawned
// session prove itself. Returns a verified server or `null`.
async function verifiedSession(kind) {
  const live = liveVerifiedSession(kind);
  if (live) return live;
  if (contractBackoffActive()) return null;
  const binPath = nativeBinPathFor(kind);
  const bytes = readArtifactOrNull(binPath);
  if (!bytes) return null; // missing / unreadable artifact — fail closed
  // Pre-filter on the BYTES ACTUALLY READ from the artifact that will be
  // spawned: a stat-keyed memo let a genuine engine that replaced a bad one at
  // the same path/size/mtime inherit a stale `false` and never be re-verified.
  const digest = digestOf(bytes);
  if (_markerlessDigests.has(digest)) return null; // known markerless — no spawn
  if (!bytes.includes(NATIVE_PATCH_ENGINE_CONTRACT)) {
    _markerlessDigests.add(digest);
    return null;
  }
  let server = null;
  let ok = false;
  try {
    if (_beforeSpawnHook) await _beforeSpawnHook();
    server = spawnSession(kind, binPath);
    ok = await server.contract();
  } catch {
    ok = false;
  }
  // A session verdict is NEVER memoized by content. Re-hashing the path after
  // the fact cannot prove which bytes the process loaded — an A→B→A swap-back
  // hashes A while B ran, and A then carried B's failure forever. The bounded
  // backoff, not a cache, is what stops a bad artifact from being respawned in
  // a loop; every fresh session simply proves itself again.
  if (ok) clearContractFailures();
  else noteContractFailure();
  return ok ? server : null;
}

export async function nativePatchSessionSatisfiesContract() {
  return (await verifiedSession('patch')) !== null;
}

export async function nativeEditSessionSatisfiesContract() {
  return (await verifiedSession('edit')) !== null;
}

export function nativePatchBinPath(options = {}) {
  if (process.env.MIXDOG_PATCH_NATIVE_BIN) return process.env.MIXDOG_PATCH_NATIVE_BIN;
  // Local cargo build first, then a fetched/cached prebuilt; absence is
  // a hard error at dispatch (no JS fallback in native-only mode).
  const defaultBin = options.defaultBin || NATIVE_PATCH_DEFAULT_BIN;
  if (existsSync(defaultBin)) return defaultBin;
  const installed = packageNativeToolPath('patch');
  if (existsSync(installed)) return installed;
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

// Error code for a request refused/failed because the server child is gone.
// Nothing was written when it is thrown from the pre-flight, so one respawned
// retry is safe.
export const NATIVE_PATCH_TRANSPORT_DEAD = 'ENATIVEPATCHDEAD';

// The child's pipes ARE the engine's protocol: a caller holding `stdin` can
// speak APPLY/EDIT around every gate — after a bare PING, a direct
// `child.stdin.write('EDIT …')` wrote a file on an unproven session. So the
// exported view of the child is lifecycle-only (kill, pid, events); there is
// nothing on it to write into.
const CHILD_TRANSPORT_KEYS = new Set(['stdin', 'stdout', 'stderr', 'stdio', 'channel']);

function lifecycleOnlyChild(child) {
  return new Proxy(child, {
    get(target, prop) {
      if (CHILD_TRANSPORT_KEYS.has(prop)) return undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set() { return false; },
    defineProperty() { return false; },
    deleteProperty() { return false; },
  });
}

class NativePatchServer {
  // Private state. The transport is unreachable from outside, and the
  // verification flag is not assignable: a public `_contractVerified = true`
  // used to unlock a raw .edit() with no handshake at all.
  #child;

  #rl;

  #lifecycleChild;

  #contractVerified = false;

  #contractPromise = null;

  constructor(binPath) {
    this.binPath = binPath;
    // windowsHide: mixdog-patch.exe is a console binary; without this each spawn
    // flashes an empty console window on Windows. Especially visible now that the
    // idle watchdog exits the server and it respawns on the next request.
    this.#child = spawn(binPath, ['--server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#lifecycleChild = lifecycleOnlyChild(this.#child);
    // No child guardian here. The server is self-terminating on BOTH orphan
    // paths: stdin EOF ends its request loop the moment this host's pipe handle
    // closes, and MIXDOG_PATCH_SERVER_IDLE_MS bounds the surviving-handle case
    // that EOF cannot see. A guardian added nothing those two already cover,
    // but it pinned the shared child-guardian broker — an Electron-as-node
    // process (~100MB RSS) — for the whole host lifetime, once per host, to
    // watch a ~10MB Rust process that outlives nothing.
    this.stderr = '';
    this.lines = [];
    this.waiters = [];
    this.exited = false;
    this.transportError = null;
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.#rl = createInterface({ input: this.#child.stdout });
    this.#rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) { waiter.resolve(line); return; }
      // Unsolicited output. Every command registers its waiter BEFORE writing,
      // so a line with no waiter is off-protocol chatter — queueing it would
      // hand it to the NEXT command as that command's response. Abandon the
      // session instead of letting stray bytes leak forward.
      this.lines.push(line);
      this.markProtocolViolation(line);
    });
    // A child that died mid-request turns every pending `stdin.write()` into an
    // UNHANDLED 'error' event (EPIPE) that takes the whole host process down —
    // a release validate job was lost exactly that way. Absorb it here: mark
    // the transport dead and reject the waiters so callers see an ordinary
    // rejection (and respawn) instead of a crash.
    this.#child.stdin.on('error', (err) => { this.failTransport(err); });
    this.#child.on('exit', (code, signal) => {
      this.exited = true;
      const err = new Error(`native patch server exited code=${code} signal=${signal} stderr=${this.stderr}`);
      for (const waiter of this.waiters.splice(0)) waiter.reject(err);
      try { this.#rl.close(); } catch {}
    });
  }

  /** Lifecycle only: kill/pid/events. The pipes stay inside this class. */
  get child() {
    return this.#lifecycleChild;
  }

  /** Read-only; true only after a completed handshake on THIS process. */
  get contractVerified() {
    return this.#contractVerified === true;
  }

  // The handshake is the one thing that needs the raw pipes. This view is built
  // inside the class body, handed straight to the verifier, and never returned
  // to a caller.
  #handshakeView() {
    return {
      child: this.#child,
      lines: this.lines,
      assertAlive: (action) => this.assertAlive(action),
      nextLine: () => this.nextLine(),
      ref: () => this.ref(),
      unref: () => this.unref(),
    };
  }

  // Idempotent death record: the stdin error and the child exit usually both
  // fire for the same death, and only the first one owns the reason.
  failTransport(cause) {
    this.exited = true;
    if (!this.transportError) {
      const err = cause instanceof Error ? cause : new Error(String(cause || 'native patch transport closed'));
      err.code = NATIVE_PATCH_TRANSPORT_DEAD;
      this.transportError = err;
    }
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.transportError);
    try { this.#rl.close(); } catch {}
  }

  // Pre-flight for every request: refuse BEFORE a single byte is written, so
  // the caller may respawn and retry without any risk of double-applying.
  // Contract handshake on THIS session, memoized per instance: N concurrent
  // callers await one exchange, and a respawned session proves itself again.
  contract() {
    if (!this.#contractPromise) {
      this.#contractPromise = verifyContractOverSession(this.#handshakeView()).then(
        (ok) => {
          this.#contractVerified = ok === true;
          if (!ok) this.markContractFailed();
          return ok;
        },
        () => { this.#contractVerified = false; this.markContractFailed(); return false; },
      );
    }
    return this.#contractPromise;
  }

  // A session that cannot state the contract — or that emitted anything
  // off-protocol — is abandoned outright: it never receives work, and the
  // module slot is cleared so nothing reuses it.
  markContractFailed() {
    this.contractFailed = true;
    this.#contractVerified = false;
    if (_nativePatchServer === this) _nativePatchServer = null;
    if (_nativeEditServer === this) _nativeEditServer = null;
    try { this.#child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  markProtocolViolation(detail) {
    this.protocolViolation = String(detail ?? '').slice(0, 200);
    this.markContractFailed();
  }

  // Every byte-writing command goes through here first. `_contractVerified` is
  // set ONLY by a completed handshake on this very process, so no exported
  // surface — including the raw session getNativePatchServer() hands out — can
  // reach apply/edit on an unproven engine. (PING writes nothing and stays
  // open, so prewarm can still warm a process before it is judged.)
  assertContractVerified(action) {
    if (this.#contractVerified !== true) throw contractFailure(action);
  }

  assertAlive(action) {
    if (this.contractFailed) throw contractFailure(action);
    if (!this.exited && !this.transportError) return;
    const reason = this.transportError?.message || this.stderr || 'exited';
    const err = new Error(`native patch server is not running (${action}): ${reason}`);
    err.code = NATIVE_PATCH_TRANSPORT_DEAD;
    throw err;
  }

  abort(signal) {
    const err = new Error(signal?.reason?.message || signal?.reason || 'native patch aborted');
    err.name = 'AbortError';
    if (_nativePatchServer === this) _nativePatchServer = null;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
    try { this.#child.kill('SIGTERM'); } catch {}
    return err;
  }

  nextLine() {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift());
    if (this.exited) return Promise.reject(new Error(`native patch server already exited: ${this.stderr}`));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  ref() {
    try { this.#child.ref(); } catch {}
    try { this.#child.stdin.ref?.(); } catch {}
    try { this.#child.stdout.ref?.(); } catch {}
    try { this.#child.stderr.ref?.(); } catch {}
  }

  unref() {
    try { this.#child.unref(); } catch {}
    try { this.#child.stdin.unref?.(); } catch {}
    try { this.#child.stdout.unref?.(); } catch {}
    try { this.#child.stderr.unref?.(); } catch {}
  }

  async ping() {
    this.ref();
    this.assertAlive('ping');
    const linePromise = this.nextLine();
    this.#child.stdin.write('PING\n');
    const line = await linePromise;
    if (line !== 'OK\tPONG') {
      throw new Error(`native patch server ping failed: ${line || 'no native response'}`);
    }
  }

  async apply(basePath, patchText, { fuzz = 2, rejectPartial = true, dryRun = false, signal = null } = {}) {
    this.ref();
    this.assertContractVerified('apply');
    this.assertAlive('apply');
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
    this.#child.stdin.write(`APPLY ${baseBuf.length} ${patchBuf.length} 1 ${dryTok} ${fuzzTok} ${rpTok}\n`);
    this.#child.stdin.write(baseBuf);
    this.#child.stdin.write(patchBuf);
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
    this.assertContractVerified('edit');
    this.assertAlive('edit');
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
    this.#child.stdin.write(
      `EDIT ${pathBuf.length} ${oldBuf.length} ${newBuf.length} ${replaceAll ? 1 : 0} ${dryRun ? 1 : 0}\n`,
    );
    this.#child.stdin.write(pathBuf);
    this.#child.stdin.write(oldBuf);
    this.#child.stdin.write(newBuf);
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
      try { this.#child.stdin.end('QUIT\n'); } catch {}
      this.unref();
      return;
    }
    this.ref();
    try { this.#child.stdin.end('QUIT\n'); } catch {}
    await new Promise((resolve) => this.#child.once('exit', resolve));
    try { this.#rl.close(); } catch {}
  }
}

export function getNativePatchServer(binPath = nativeBinPathFor('patch')) {
  markNativePatchRuntimeTouched();
  if (!existsSync(binPath)) {
    throw new Error(`native patch binary not found: ${binPath}`);
  }
  if (!_nativePatchServer || _nativePatchServer.exited || _nativePatchServer.binPath !== binPath) {
    _nativePatchServer = new NativePatchServer(binPath);
  }
  return _nativePatchServer;
}

// The path comes from nativeBinPathFor('edit') — the same call the gate hashed.
// This getter resolves nothing itself, so there is no second path a session
// could be spawned from.
function getNativeEditServer(binPath = nativeBinPathFor('edit')) {
  markNativePatchRuntimeTouched();
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
  try {
    // Defence in depth: no work is written to a session that has not proven
    // its contract, even if a caller skipped the gate.
    const verified = await verifiedSession('edit');
    if (!verified) throw contractFailure('edit');
    return await verified.edit(fullPath, oldBuf, newBuf, { replaceAll, dryRun, signal });
  } catch (err) {
    if (err?.code !== NATIVE_PATCH_TRANSPORT_DEAD) throw err;
    // The dead instance was refused before any byte went out; the getter
    // respawns because the previous one is marked exited — and the respawn
    // must prove itself again.
    const respawned = await verifiedSession('edit');
    if (!respawned) throw contractFailure('edit');
    return respawned.edit(fullPath, oldBuf, newBuf, { replaceAll, dryRun, signal });
  } finally {
    if (!nativePatchPersistent() && _nativeEditServer) {
      if (process.versions?.bun) {
        const server = _nativeEditServer;
        _nativeEditServer = null;
        void server.close().catch(() => {});
      } else {
        _nativeEditServer.unref();
      }
    }
  }
}

// Same one-shot respawn for APPLY: an idle-watchdog exit or an external kill
// between requests must cost a respawn, not the request.
export async function runServerApply(basePath, patchText, options = {}) {
  try {
    const verified = await verifiedSession('patch');
    if (!verified) throw contractFailure('apply');
    return await verified.apply(basePath, patchText, options);
  } catch (err) {
    if (err?.code !== NATIVE_PATCH_TRANSPORT_DEAD) throw err;
    const respawned = await verifiedSession('patch');
    if (!respawned) throw contractFailure('apply');
    return respawned.apply(basePath, patchText, options);
  }
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
