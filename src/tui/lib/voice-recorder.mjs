/**
 * src/tui/lib/voice-recorder.mjs — TUI-local voice install/toggle orchestration.
 *
 * Step1 (/voice command): owns the `voice.enabled` config flag and drives the
 * managed whisper.cpp + ffmpeg runtime install (voice-runtime-fetcher.mjs) the
 * first time voice is turned ON.
 *
 * Step2 (Ctrl+Space recorder): startRecording/stopRecording/cancelRecording
 * drive a small idle -> recording -> transcribing -> idle state machine.
 * Recording spawns ffmpeg against a DirectShow ("dshow") capture device (the
 * only capture API implemented — mixdog's managed voice runtime targets
 * win32; the enumerate/record commands below are DirectShow-specific).
 * Transcription reuses the SAME whisper-server.mjs singleton manager the
 * channels pipeline uses (ensureReady + transcribe), so a TUI-triggered
 * transcription and a Discord-attachment transcription share one warm
 * whisper-server child instead of racing two.
 *
 * Config load is a STATIC import here (approved design decision) — unlike
 * theme.mjs's dist-aware dynamic import of config.mjs, this file is not on the
 * TUI's hot boot path and esbuild bundling config.mjs's relative dependency
 * graph (plugin-paths/atomic-file/user-data-guard + the keychain .cjs via
 * createRequire) into src/tui/dist/index.mjs is harmless: config.mjs's
 * createRequire('../../lib/keychain-cjs.cjs') resolves relative to
 * import.meta.url, and src/tui/dist/ sits at the same depth-from-src as
 * src/runtime/shared/ (2 levels), so the relative path still lands on
 * src/lib/keychain-cjs.cjs after bundling.
 *
 * The whisper.cpp/ffmpeg runtime installer (voice-runtime-fetcher.mjs) and
 * the whisper-server manager (whisper-server.mjs) are BOTH loaded lazily via
 * dynamic import — neither should load into memory unless a user actually
 * asks for voice.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { readSection, updateSection } from '../../runtime/shared/config.mjs';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';

let _voiceRuntimeFetcherPromise = null;
function loadVoiceRuntimeFetcher() {
  if (!_voiceRuntimeFetcherPromise) {
    _voiceRuntimeFetcherPromise = import('../../runtime/channels/lib/voice-runtime-fetcher.mjs');
  }
  return _voiceRuntimeFetcherPromise;
}

let _whisperServerPromise = null;
// Set once loadWhisperServer()'s import resolves, so disposeRecorder() (a
// SYNC function called from a React unmount cleanup) can check "was the
// whisper-server manager ever engaged this session" without triggering a
// fresh dynamic import just to shut down something that was never started.
let _whisperServerModule = null;
function loadWhisperServer() {
  if (!_whisperServerPromise) {
    _whisperServerPromise = import('../../runtime/channels/lib/whisper-server.mjs').then((mod) => {
      _whisperServerModule = mod;
      return mod;
    });
  }
  return _whisperServerPromise;
}

// Reentrancy guard: only one install (ensureWhisperRuntime/ensureWhisperModel/
// ensureFfmpegRuntime sequence) may run at a time per process.
let _voiceInstallBusy = false;

/** True while a Step1 install sequence is in flight. */
export function isVoiceInstallBusy() {
  return _voiceInstallBusy;
}

/** Read `voice.enabled` from mixdog-config.json (top-level `voice` section). */
export function isVoiceEnabled() {
  try {
    return readSection('voice')?.enabled === true;
  } catch {
    return false;
  }
}

// Coalesce ensure*'s onProgress ({ phase, downloaded, total } | { phase:'extra', ... })
// into a sticky, in-place input-hint-line progress bar (setProgressHint) so a
// multi-hundred-MB model download doesn't spam the notice toast on every
// chunk. Falls back to the old throttled (2s) toast-spam behavior when the
// caller (e.g. the channels pipeline) doesn't have a progress-hint slot to
// render into — only pushNotice is guaranteed to exist everywhere.
const PROGRESS_BAR_CELLS = 6;
function renderProgressBarText(phase, downloaded, total) {
  const label = phaseLabel(phase);
  if (total > 0) {
    const ratio = Math.max(0, Math.min(1, downloaded / total));
    const filled = Math.round(ratio * PROGRESS_BAR_CELLS);
    const bar = '▓'.repeat(filled) + '░'.repeat(PROGRESS_BAR_CELLS - filled);
    return `⬇ Voice ${label} ${bar} ${Math.round(ratio * 100)}%`;
  }
  return `⬇ Voice ${label} …`;
}
function phaseLabel(phase) {
  if (phase === 'model') return 'model';
  if (phase === 'ffmpeg') return 'ffmpeg';
  if (phase === 'extra') return 'extra data';
  return 'whisper runtime';
}
function makeThrottledProgressNotice({ pushNotice, setProgressHint } = {}, intervalMs = 500) {
  let lastEmitAt = 0;
  return (progress = {}) => {
    const now = Date.now();
    if (now - lastEmitAt < intervalMs) return;
    lastEmitAt = now;
    const total = Number(progress.total) || 0;
    const downloaded = Number(progress.downloaded) || 0;
    const text = renderProgressBarText(progress.phase, downloaded, total);
    if (typeof setProgressHint === 'function') {
      setProgressHint(text, 'info');
      return;
    }
    if (typeof pushNotice === 'function') pushNotice(text, 'info');
  };
}

/**
 * Ensure every managed voice-runtime component (whisper binary+server,
 * whisper model, ffmpeg) is installed. Installs ONLY the missing pieces —
 * an already-installed component is never re-fetched. Returns the resolved
 * runtime descriptor (resolveVoiceRuntime shape) once `installed` is true;
 * throws on any ensure* failure (manifest fetch, sha256 mismatch, etc.).
 */
export async function ensureVoiceRuntimeReady({ dataDir = resolvePluginData(), pushNotice, setProgressHint } = {}) {
  const fetcher = await loadVoiceRuntimeFetcher();
  let runtime = fetcher.resolveVoiceRuntime(dataDir);
  if (runtime.installed) return runtime;

  const onProgress = makeThrottledProgressNotice({ pushNotice, setProgressHint });
  if (!runtime.binary || !runtime.serverCmd) {
    await fetcher.ensureWhisperRuntime(dataDir, onProgress);
  }
  if (!runtime.model) {
    await fetcher.ensureWhisperModel(dataDir, onProgress);
  }
  if (!runtime.ffmpeg) {
    await fetcher.ensureFfmpegRuntime(dataDir, onProgress);
  }

  runtime = fetcher.resolveVoiceRuntime(dataDir);
  if (!runtime.installed) {
    throw new Error('voice runtime install did not complete (still missing a required component)');
  }
  return runtime;
}

/**
 * /voice command entry point. OFF -> immediately flips `voice.enabled` to
 * false and notices "Voice OFF" (no install work, no busy gate — a disable
 * must never be blocked by an in-flight install of a DIFFERENT toggle-on).
 * ON  -> busy-guarded: checks resolveVoiceRuntime, installs only missing
 * components, then persists `voice.enabled: true` and notices "Voice ON —
 * Ctrl+Space to record". Any ensure* failure notices the cause and leaves
 * `voice.enabled` untouched (still off).
 *
 * Returns the NEW enabled state (true/false) on success, or null when the
 * toggle could not run (install already in flight) or failed.
 */
export async function toggleVoice({ pushNotice, setProgressHint } = {}) {
  const dataDir = resolvePluginData();
  if (isVoiceEnabled()) {
    // Med-5: updateSection is a synchronous file write (readAllForRmW +
    // atomic write under a file lock) and can throw — a locked/corrupt
    // config, a permissions error, etc. An unguarded throw here would
    // propagate out of the OFF branch uncaught (toggleVoice's try/catch
    // below only wraps the ON path) and crash the caller. Guard it the
    // same way the ON path is guarded, and report failure via pushNotice
    // instead of silently pretending the toggle succeeded.
    try {
      updateSection('voice', (current) => ({ ...current, enabled: false }));
    } catch (err) {
      pushNotice?.(`Voice OFF failed: ${err?.message || err}`, 'error');
      return { ok: false, error: err?.message || String(err) };
    }
    pushNotice?.('Voice OFF', 'info');
    return false;
  }
  if (_voiceInstallBusy) {
    pushNotice?.('Voice install is already running', 'warn');
    return null;
  }
  _voiceInstallBusy = true;
  try {
    await ensureVoiceRuntimeReady({ dataDir, pushNotice, setProgressHint });
    updateSection('voice', (current) => ({ ...current, enabled: true }));
    setProgressHint?.('');
    pushNotice?.('Voice ON — Ctrl+Space to record', 'info');
    return true;
  } catch (err) {
    setProgressHint?.('');
    pushNotice?.(`Voice setup failed: ${err?.message || err}`, 'error');
    return null;
  } finally {
    _voiceInstallBusy = false;
  }
}

// ── Step2: idle -> recording -> transcribing -> idle ────────────────────────

const RECORDER_STATE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  RECORDING: 'recording',
  TRANSCRIBING: 'transcribing',
});

// Module-scoped: the TUI has exactly one prompt/recorder, so one singleton
// state machine (mirrors whisper-server.mjs's own single-manager pattern).
const rec = {
  state: RECORDER_STATE.IDLE,
  child: null,     // ffmpeg ChildProcess while RECORDING
  wavPath: null,    // tmp wav path for the in-flight/just-finished recording
};

/** Current recorder state — 'idle' | 'recording' | 'transcribing'. */
export function getRecorderState() {
  return rec.state;
}

function newTmpWavPath() {
  return join(tmpdir(), `mixdog-rec-${Date.now()}.wav`);
}

// Resolve the ffmpeg binary: prefer the managed runtime (Step1 install),
// fall back to a bare 'ffmpeg' on PATH (spawn resolves PATH itself when no
// path separator is present), so a user with a system ffmpeg install still
// gets Ctrl+Space without running /voice's installer.
async function resolveFfmpegCmd(dataDir) {
  const fetcher = await loadVoiceRuntimeFetcher();
  const managed = fetcher.resolveManagedFfmpegPath(dataDir);
  if (managed) return managed;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { windowsHide: true });
  if (probe.status === 0) return 'ffmpeg';
  return null;
}

// Enumerate DirectShow audio-capture devices via
// `ffmpeg -hide_banner -list_devices true -f dshow -i dummy`, which ffmpeg
// (by design) always exits non-zero on while printing the device list to
// stderr. Returns the first "(audio)" device name, or null when none is
// found / the probe fails. UTF-8 decoded (device names may be non-ASCII on
// a localized Windows install).
function listFirstDshowAudioDevice(ffmpegCmd) {
  const r = spawnSync(ffmpegCmd, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  const text = `${r.stderr || ''}${r.stdout || ''}`;
  // ffmpeg prints device lines like:  "Mic Name" (audio)
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = /"([^"]+)"\s*\(audio\)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * Begin recording. IDLE -> RECORDING. No-op (returns null) unless the
 * recorder is currently idle. Claims the IDLE -> STARTING transition
 * SYNCHRONOUSLY (before any `await`) so a second Ctrl+Space fired while
 * ffmpeg/device resolution is still in flight sees STARTING (not IDLE) and
 * is a no-op rather than racing a second spawn onto the same rec.* fields.
 * Resolves ffmpeg (managed -> PATH fallback), enumerates the first dshow
 * audio-capture device, and spawns ffmpeg writing 16kHz mono PCM to a fresh
 * tmp wav. `-y` overwrites (tmp path is always fresh so this is defensive,
 * not load-bearing). Any failure on the STARTING path (no ffmpeg, no
 * device, spawn throw) reverts to IDLE before returning.
 *
 * Returns `{ ok: true }` on a successful spawn, `{ ok: false, reason }` on
 * any failure (no ffmpeg, no device, spawn error) — the caller (App.jsx)
 * turns `reason` into a user-facing notice — or `null` when the recorder
 * was not IDLE (already starting/recording/transcribing): a silent no-op,
 * matching stopRecording's null-for-wrong-state contract.
 */
export async function startRecording({ dataDir = resolvePluginData() } = {}) {
  if (rec.state !== RECORDER_STATE.IDLE) return null;
  // Claim the slot BEFORE the first await — see High-1 in the doc comment
  // above. Everything below this line runs against an already-STARTING
  // rec.state, so a concurrent startRecording() call bails out via the
  // guard above instead of racing a second ffmpeg spawn.
  rec.state = RECORDER_STATE.STARTING;
  const ffmpegCmd = await resolveFfmpegCmd(dataDir);
  if (!ffmpegCmd) {
    rec.state = RECORDER_STATE.IDLE;
    return { ok: false, reason: 'ffmpeg not found — run /voice to install it, or install ffmpeg on PATH' };
  }
  const device = listFirstDshowAudioDevice(ffmpegCmd);
  if (!device) {
    rec.state = RECORDER_STATE.IDLE;
    return { ok: false, reason: 'no microphone found (DirectShow audio device enumeration returned none)' };
  }
  const wavPath = newTmpWavPath();
  let child;
  try {
    child = spawn(ffmpegCmd, [
      '-f', 'dshow',
      '-i', `audio=${device}`,
      '-ar', '16000',
      '-ac', '1',
      '-y', wavPath,
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  } catch (err) {
    rec.state = RECORDER_STATE.IDLE;
    return { ok: false, reason: `failed to start ffmpeg: ${err?.message || err}` };
  }
  // EPIPE guard (Med-3): a write to ffmpeg's stdin AFTER it has already
  // closed the pipe (e.g. process died right as stopRecording() writes 'q')
  // emits an 'error' on the stream — Node throws uncaught if nothing is
  // listening. Attached once, here, so every future stdin write/close on
  // this child is covered (stopRecording's write included).
  child.stdin?.on('error', () => {});
  // A spawn error surfaces async (e.g. EACCES on the resolved path even
  // though the sync probe above found something on PATH) — fall back to
  // IDLE so a stuck RECORDING state never blocks the next Ctrl+Space.
  child.once('error', () => {
    if (rec.child === child) {
      rec.state = RECORDER_STATE.IDLE;
      rec.child = null;
      rec.wavPath = null;
    }
  });
  rec.state = RECORDER_STATE.RECORDING;
  rec.child = child;
  rec.wavPath = wavPath;
  return { ok: true };
}

// Graceful-stop budget before escalating to a hard kill. ffmpeg needs a
// moment to flush the wav trailer after receiving 'q' on stdin.
const RECORDING_STOP_GRACE_MS = 3000;

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (exited) => {
      if (done) return;
      done = true;
      resolve(exited);
    };
    child.once('exit', () => finish(true));
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

/**
 * Stop the in-flight recording. RECORDING -> TRANSCRIBING -> (transcribe) ->
 * IDLE. Sends 'q' on ffmpeg's stdin (its documented graceful-quit key —
 * flushes the wav trailer); if ffmpeg has not exited within
 * RECORDING_STOP_GRACE_MS it is force-killed (the partial wav is still
 * attempted). No-op (returns null) unless currently RECORDING.
 *
 * On success runs ensureReady + transcribe against the SAME whisper-server
 * singleton the channels pipeline uses, using `voice.language` from config
 * (undefined -> whisper auto-detect) and `voice.transcription.threadCount`
 * (falls back to the same quartered-cpu-count default index.mjs uses).
 * Returns `{ ok: true, text }` on success or `{ ok: false, reason }` on any
 * failure; state returns to IDLE either way.
 *
 * Med-1: rec.child is INTENTIONALLY kept set (not nulled) for the entire
 * grace-wait window below — only cleared once the child has actually
 * exited (or been killed). This lets disposeRecorder(), called mid-grace
 * (e.g. the user quits the TUI right after Ctrl+Space-stop), still see and
 * kill the SAME child instead of finding rec.child already null and
 * orphaning a live ffmpeg process.
 */
export async function stopRecording({ dataDir = resolvePluginData() } = {}) {
  if (rec.state !== RECORDER_STATE.RECORDING || !rec.child) return null;
  const child = rec.child;
  const wavPath = rec.wavPath;
  rec.state = RECORDER_STATE.TRANSCRIBING;
  try {
    try { child.stdin?.write('q'); } catch { /* stdin may already be closed */ }
    const exited = await waitForExit(child, RECORDING_STOP_GRACE_MS);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      await waitForExit(child, RECORDING_STOP_GRACE_MS);
    }
    // Only now is the child provably gone (or we gave up trying) — safe to
    // drop the reference so a concurrent disposeRecorder() no longer needs
    // (and no longer has) anything to kill.
    if (rec.child === child) rec.child = null;
    return await transcribeWav(wavPath, { dataDir });
  } finally {
    if (rec.child === child) rec.child = null;
    rec.state = RECORDER_STATE.IDLE;
    rec.wavPath = null;
  }
}

/**
 * Cancel the in-flight recording. RECORDING -> IDLE (no transcription).
 * Force-kills ffmpeg immediately and deletes the tmp wav. No-op (returns
 * false) unless currently RECORDING.
 */
export function cancelRecording() {
  if (rec.state !== RECORDER_STATE.RECORDING || !rec.child) return false;
  const child = rec.child;
  const wavPath = rec.wavPath;
  try { child.kill('SIGKILL'); } catch { /* best-effort */ }
  if (wavPath) {
    try { unlinkSync(wavPath); } catch { /* tmp file may not exist yet */ }
  }
  rec.state = RECORDER_STATE.IDLE;
  rec.child = null;
  rec.wavPath = null;
  return true;
}

/**
 * Best-effort teardown for TUI unmount/exit: kills any live ffmpeg child and
 * deletes its tmp wav, regardless of current state (RECORDING or
 * TRANSCRIBING — the latter can still hold a live child mid-stop-grace).
 * Never throws.
 */
export function disposeRecorder() {
  const child = rec.child;
  const wavPath = rec.wavPath;
  if (child) {
    try { child.kill('SIGKILL'); } catch { /* best-effort */ }
  }
  if (wavPath) {
    try { unlinkSync(wavPath); } catch { /* best-effort */ }
  }
  rec.state = RECORDER_STATE.IDLE;
  rec.child = null;
  rec.wavPath = null;
  // High-2: shut down the whisper-server child too, not just ffmpeg — a
  // TUI-triggered transcription can leave the managed whisper-server.exe
  // process running past TUI exit (it's a long-lived singleton by design,
  // kept warm across transcriptions), which otherwise orphans it. Only
  // meaningful if loadWhisperServer() actually resolved at least once this
  // session (_whisperServerModule set) — nothing to stop otherwise, and we
  // must not trigger a fresh dynamic import from a sync unmount callback.
  if (_whisperServerModule) {
    try { void _whisperServerModule.stopVoiceWhisperServer?.(); } catch { /* best-effort */ }
  }
}

async function transcribeWav(wavPath, { dataDir }) {
  // Med-2: the runtime.installed check is now INSIDE the try so an early
  // return here still hits the finally below and unlinks wavPath — the
  // original early-return (before try) skipped cleanup and leaked the tmp
  // wav on every "voice runtime not installed" path.
  try {
    const fetcher = await loadVoiceRuntimeFetcher();
    const runtime = fetcher.resolveVoiceRuntime(dataDir);
    if (!runtime?.installed) {
      return { ok: false, reason: 'voice runtime not installed — run /voice to install it' };
    }
    const server = await loadWhisperServer();
    const cfg = readSection('voice');
    const cpuCount = (() => { try { return cpus().length; } catch { return 2; } })();
    const threadCount = cfg?.transcription?.threadCount ?? Math.max(1, Math.ceil(cpuCount / 4));
    const language = cfg?.language || undefined;
    await server.ensureReady({ serverCmd: runtime.serverCmd, modelPath: runtime.modelPath, threadCount, host: '127.0.0.1' });
    const text = await server.transcribe(wavPath, { language });
    return { ok: true, text: text.trim() };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  } finally {
    try { unlinkSync(wavPath); } catch { /* best-effort cleanup */ }
  }
}
