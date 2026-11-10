/**
 * src/runtime/channels/lib/voice-setup.mjs — voice install/toggle orchestration
 * shared by the TUI settings hub, the session `toggleVoice` action Desktop
 * calls, and the runtime `setup` tool.
 *
 * Owns the `voice.enabled` config flag and drives the managed whisper.cpp +
 * ffmpeg runtime install (voice-runtime-fetcher.mjs) the first time voice is
 * turned ON. Voice, once enabled, makes the channels pipeline transcribe
 * incoming channel voice messages — there is no terminal recorder.
 *
 * The whisper.cpp/ffmpeg runtime installer (voice-runtime-fetcher.mjs) is
 * loaded lazily via dynamic import — it should not load into memory unless a
 * user actually asks for voice.
 */
import { readSection, updateSectionAsync } from '../../shared/config.mjs';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';

let _voiceRuntimeFetcherPromise = null;
function loadVoiceRuntimeFetcher() {
  if (!_voiceRuntimeFetcherPromise) {
    _voiceRuntimeFetcherPromise = import('./voice-runtime-fetcher.mjs');
  }
  return _voiceRuntimeFetcherPromise;
}

// Reentrancy guard: only one install (ensureWhisperRuntime/ensureWhisperModel/
// ensureFfmpegRuntime sequence) may run at a time per process.
let _voiceInstallBusy = false;

// Bumped by every accepted OFF request. An install that started earlier must
// not enable voice once a later OFF has superseded it.
let _voiceOffGeneration = 0;

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

/** Read the managed runtime state without installing, mutating, or cleaning
 *  up anything: version GC runs only inside the install guard. */
export async function getVoiceStatus({ dataDir = resolvePluginData() } = {}) {
  const fetcher = await loadVoiceRuntimeFetcher();
  const runtime = fetcher.resolveVoiceRuntime(dataDir, {
    modelId: fetcher.selectVoiceModelId(readSection('voice')),
    cleanup: false,
  });
  return {
    enabled: isVoiceEnabled(),
    busy: isVoiceInstallBusy(),
    installed: runtime.installed === true,
    modelId: runtime.modelId,
    info: fetcher.voiceRuntimeInfo(runtime),
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
// chunk. Falls back to throttled toasts when the caller has no progress-hint
// slot to render into — only pushNotice is guaranteed to exist everywhere.
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
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((downloaded / total) * 100))) : undefined;
    if (typeof setProgressHint === 'function') {
      setProgressHint(text, 'info', percent);
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
async function ensureVoiceRuntimeReady({ dataDir = resolvePluginData(), pushNotice, setProgressHint } = {}) {
  const fetcher = await loadVoiceRuntimeFetcher();
  // Every device installs the same standard multilingual Q8 model.
  const modelId = fetcher.selectVoiceModelId(readSection('voice'));
  let runtime = fetcher.resolveVoiceRuntime(dataDir, { modelId });
  if (runtime.installed && !runtime.stale) return runtime;

  const onProgress = makeThrottledProgressNotice({ pushNotice, setProgressHint });
  // `stale` = a newer manifest version shipped while a working older runtime is
  // installed. Re-fetch instead of skipping: ensureWhisperRuntime installs the
  // new version directory and its gcStaleVersions drops the superseded one, so
  // the upgrade reclaims the old bytes in the same pass.
  if (!runtime.binary || !runtime.serverCmd || runtime.stale) {
    await fetcher.ensureWhisperRuntime(dataDir, onProgress);
  }
  if (!runtime.model) {
    await fetcher.ensureWhisperModel(dataDir, onProgress, modelId);
  }
  if (!runtime.ffmpeg) {
    await fetcher.ensureFfmpegRuntime(dataDir, onProgress);
  }

  runtime = fetcher.resolveVoiceRuntime(dataDir, { modelId });
  if (!runtime.installed) {
    throw new Error('voice runtime install did not complete (still missing a required component)');
  }
  return runtime;
}

/**
 * Voice state entry point. OFF -> immediately flips `voice.enabled` to
 * false and notices "Voice OFF" while keeping the installed runtime and model
 * for an instant re-enable (no install work, no busy gate — a disable must
 * never be blocked by an in-flight install of a DIFFERENT toggle-on).
 * ON  -> busy-guarded: checks resolveVoiceRuntime, installs only missing
 * components, then persists `voice.enabled: true` and notices "Voice ON —
 * channel voice messages will be transcribed". Any ensure* failure notices the
 * cause and leaves `voice.enabled` untouched (still off).
 *
 * `enabled` makes desktop and setup writes idempotent. Omitted flips the
 * current state. Returns the resulting enabled state on success,
 * or null when installation could not run or failed.
 */
export async function toggleVoice({ pushNotice, setProgressHint, enabled } = {}) {
  const dataDir = resolvePluginData();
  const requestGeneration = _voiceOffGeneration;
  const status = await getVoiceStatus({ dataDir });
  const targetEnabled = typeof enabled === 'boolean' ? enabled : !status.enabled;
  if (!targetEnabled) {
    // Counted even when voice is not yet enabled: a pending install must lose.
    _voiceOffGeneration++;
    // The async RMW preserves the shared config lock/ACL protocol without
    // blocking the event loop. It can still throw — a locked/corrupt config,
    // permissions error, etc. Guard it the same way the ON path is guarded and
    // report failure via pushNotice instead of silently pretending success.
    // It runs even when the pre-read says disabled so it queues behind (and
    // overrides) any ON write already waiting on the lock.
    try {
      await updateSectionAsync('voice', (current) => ({ ...current, enabled: false }));
    } catch (err) {
      pushNotice?.(`Voice OFF failed: ${err?.message || err}`, 'error');
      return { ok: false, error: err?.message || String(err) };
    }
    pushNotice?.('Voice OFF', 'info');
    return false;
  }
  if (status.enabled && status.installed) return true;
  if (_voiceInstallBusy) {
    pushNotice?.('Voice install is already running', 'warn');
    return null;
  }
  _voiceInstallBusy = true;
  try {
    await ensureVoiceRuntimeReady({ dataDir, pushNotice, setProgressHint });
    // Checked inside the locked updater so an OFF accepted while this write
    // waits for the lock still wins.
    let superseded = false;
    await updateSectionAsync('voice', (current) => {
      if (requestGeneration !== _voiceOffGeneration) {
        superseded = true;
        return current;
      }
      return { ...current, enabled: true };
    });
    if (superseded) {
      setProgressHint?.('');
      return false;
    }
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
