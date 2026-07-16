/**
 * src/tui/lib/voice-setup.mjs — TUI-local voice install/toggle orchestration.
 *
 * Owns the `voice.enabled` config flag and drives the managed whisper.cpp +
 * ffmpeg runtime install (voice-runtime-fetcher.mjs) the first time voice is
 * turned ON. Voice, once enabled, makes the channels pipeline transcribe
 * incoming channel voice messages — there is no terminal recorder.
 *
 * Config load is a STATIC import here (approved design decision) — this file is
 * not on the TUI's hot boot path and esbuild bundling config.mjs's relative
 * dependency graph into src/tui/dist/index.mjs is harmless: config.mjs's
 * createRequire('../../lib/keychain-cjs.cjs') resolves relative to
 * import.meta.url, and src/tui/dist/ sits at the same depth-from-src as
 * src/runtime/shared/ (2 levels), so the relative path still lands on
 * src/lib/keychain-cjs.cjs after bundling.
 *
 * The whisper.cpp/ffmpeg runtime installer (voice-runtime-fetcher.mjs) is
 * loaded lazily via dynamic import — it should not load into memory unless a
 * user actually asks for voice.
 */
import { readSection, updateSection } from '../../runtime/shared/config.mjs';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';

let _voiceRuntimeFetcherPromise = null;
function loadVoiceRuntimeFetcher() {
  if (!_voiceRuntimeFetcherPromise) {
    _voiceRuntimeFetcherPromise = import('../../runtime/channels/lib/voice-runtime-fetcher.mjs');
  }
  return _voiceRuntimeFetcherPromise;
}

// Reentrancy guard: only one install (ensureWhisperRuntime/ensureWhisperModel/
// ensureFfmpegRuntime sequence) may run at a time per process.
let _voiceInstallBusy = false;

/** True while an install sequence is in flight. */
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

/** Read the managed runtime state without installing or mutating anything. */
export async function getVoiceStatus({ dataDir = resolvePluginData() } = {}) {
  const fetcher = await loadVoiceRuntimeFetcher();
  const runtime = fetcher.resolveVoiceRuntime(dataDir);
  return {
    enabled: isVoiceEnabled(),
    busy: isVoiceInstallBusy(),
    installed: runtime.installed === true,
    components: {
      whisper: Boolean(runtime.binary && runtime.serverCmd),
      model: Boolean(runtime.model),
      ffmpeg: Boolean(runtime.ffmpeg),
    },
  };
}

// Coalesce ensure*'s onProgress ({ phase, downloaded, total } | { phase:'extra', ... })
// into a sticky, in-place input-hint-line progress bar (setProgressHint) so a
// multi-hundred-MB model download doesn't spam the notice toast on every
// chunk. Falls back to the old throttled (2s) toast-spam behavior when the
// caller doesn't have a progress-hint slot to render into — only pushNotice is
// guaranteed to exist everywhere.
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
 * Voice toggle entry point. OFF -> immediately flips `voice.enabled` to
 * false and notices "Voice OFF" (no install work, no busy gate — a disable
 * must never be blocked by an in-flight install of a DIFFERENT toggle-on).
 * ON  -> busy-guarded: checks resolveVoiceRuntime, installs only missing
 * components, then persists `voice.enabled: true` and notices "Voice ON —
 * channel voice messages will be transcribed". Any ensure* failure notices the
 * cause and leaves `voice.enabled` untouched (still off).
 *
 * Returns the NEW enabled state (true/false) on success, or null when the
 * toggle could not run (install already in flight) or failed.
 */
export async function toggleVoice({ pushNotice, setProgressHint } = {}) {
  const dataDir = resolvePluginData();
  if (isVoiceEnabled()) {
    // updateSection is a synchronous file write (readAllForRmW + atomic write
    // under a file lock) and can throw — a locked/corrupt config, a
    // permissions error, etc. Guard it the same way the ON path is guarded and
    // report failure via pushNotice instead of silently pretending success.
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
    pushNotice?.('Voice ON — channel voice messages will be transcribed', 'info');
    return true;
  } catch (err) {
    setProgressHint?.('');
    pushNotice?.(`Voice setup failed: ${err?.message || err}`, 'error');
    return null;
  } finally {
    _voiceInstallBusy = false;
  }
}
