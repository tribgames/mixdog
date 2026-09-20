/**
 * config-writers.mjs — the three debounced disk channels behind an adopted
 * config (field patches, skills.disabled, top-level outputStyle) and the
 * flush barriers that drain them.
 *
 * Debounce rationale: persisting mixdog-config.json is heavy (cross-process
 * lock, atomic temp+rename, win32 icacls owner-only ACL). Callers adopt
 * in-memory IMMEDIATELY so same-tick readers see fresh state, and DEBOUNCE
 * the disk write so a burst of toggles collapses into one persist.
 *   - config save  (field patches rebased onto the locked agent section)
 *   - outputStyle  (sharedCfgMod.updateConfig whole-root RMW — cfgMod.saveConfig
 *                   only serializes agent-section fields, so a top-level
 *                   outputStyle would never reach disk via that path)
 */
import { createDebouncedWriter } from '../../runtime/shared/debounced-writer.mjs';

const CONFIG_SAVE_DEBOUNCE_MS = 150;

// Only pending writers are retained. A new runtime must also drain changes
// accepted by OTHER runtimes before reading its initial config from disk.
const pendingSessionConfigWriters = new Set();

export async function flushPendingSessionConfigWrites() {
  while (pendingSessionConfigWriters.size) {
    await Promise.all([...pendingSessionConfigWriters].map((flush) => flush({ requireSaved: true })));
  }
}

function outputStyleUpdater(styleId) {
  return (root) => {
    const next = { ...(root || {}), outputStyle: styleId };
    if (next.agent && typeof next.agent === 'object' && !Array.isArray(next.agent)) {
      const agent = { ...next.agent };
      delete agent.outputStyle;
      next.agent = agent;
    }
    return next;
  };
}

const writeFailure = (label) => (error, sync) =>
  process.stderr.write(`[config] ${sync ? 'debounced' : 'async'} ${label} failed: ${error?.message || error}\n`);

export function createConfigWriters({ cfgMod, sharedCfgMod }) {
  let pendingConfigChanges = [];
  // Synchronous reload remains a synchronous API. It may flush an idle writer,
  // but must retain its pending field overlay while an async write is active.
  const configWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: async () => {
      const changes = pendingConfigChanges;
      await cfgMod.saveConfigPatchAsync(changes);
      // New edits accepted during this write remain queued; a successful prefix
      // must never be replayed over another runtime's subsequent changes.
      pendingConfigChanges = pendingConfigChanges.slice(changes.length);
    },
    onError: writeFailure('saveConfig'),
  });
  const skillsWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: (names) => cfgMod.patchSkillsDisabledAsync(names),
    onError: writeFailure('patchSkillsDisabled'),
  });
  const outputStyleWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: (styleId) => sharedCfgMod.updateConfigAsync(outputStyleUpdater(styleId)),
    onError: (error) => process.stderr.write(`[config] async outputStyle save failed: ${error?.message || error}\n`),
  });
  let configFlushInFlight = null;

  function releaseSavedWriter() {
    const pending = configWriter.hasPending() || skillsWriter.hasPending() || outputStyleWriter.hasPending();
    if (!pending) pendingSessionConfigWriters.delete(flushAllConfigSavesAsync);
    return !pending;
  }

  async function runConfigFlushAsync() {
    // Config edits precede the dedicated skills.disabled patch.
    do {
      if (!(await configWriter.flush())) return false;
      if (!(await skillsWriter.flush())) return false;
    } while (configWriter.hasPending() || skillsWriter.hasPending());
    return true;
  }

  function flushConfigSaveAsync() {
    if (configFlushInFlight) return configFlushInFlight;
    const p = runConfigFlushAsync();
    configFlushInFlight = p;
    const clear = () => {
      if (configFlushInFlight === p) configFlushInFlight = null;
      releaseSavedWriter();
    };
    p.then(clear, clear);
    return p;
  }

  function flushConfigSave() {
    if (
      configWriter.flushSyncIfIdle(() => {
        const changes = pendingConfigChanges;
        cfgMod.saveConfigPatch(changes);
        pendingConfigChanges = pendingConfigChanges.slice(changes.length);
      })
    ) {
      skillsWriter.flushSyncIfIdle((names) => cfgMod.patchSkillsDisabled(names));
    }
    releaseSavedWriter();
  }

  // Teardown barrier for every in-process writer that can hold the shared
  // mixdog-config lock. Start/drain all debounce channels through their async
  // variants, then resolve only when every promise tail (including skills,
  // which config flushes after its whole-section write) has settled.
  async function flushAllConfigSavesAsync({ requireSaved = false } = {}) {
    const saved = await Promise.all([flushConfigSaveAsync(), outputStyleWriter.flush()]);
    // The shared config layer also tracks writes started directly by channel,
    // webhook, voice, and future async RMW callers.
    await sharedCfgMod.pendingConfigWrites();
    releaseSavedWriter();
    if (requireSaved && saved.includes(false)) {
      throw new Error('Cannot create a new session: pending settings could not be saved.');
    }
  }

  async function flushOutputStyleSaveAsync() {
    await outputStyleWriter.flush();
    releaseSavedWriter();
  }

  return {
    queueConfigChanges(changes) {
      pendingConfigChanges = [...pendingConfigChanges, ...changes];
      configWriter.schedule(pendingConfigChanges, flushConfigSaveAsync);
      pendingSessionConfigWriters.add(flushAllConfigSavesAsync);
    },
    scheduleSkillsSave(names) {
      skillsWriter.schedule(names, flushConfigSaveAsync);
      pendingSessionConfigWriters.add(flushAllConfigSavesAsync);
    },
    scheduleOutputStyleSave(styleId) {
      outputStyleWriter.schedule(styleId, flushOutputStyleSaveAsync);
      pendingSessionConfigWriters.add(flushAllConfigSavesAsync);
    },
    flushConfigSave,
    flushConfigSaveAsync,
    flushAllConfigSavesAsync,
    hasPendingConfigChanges: () => configWriter.hasPending(),
    pendingConfigChanges: () => pendingConfigChanges,
    pendingSkills: () => skillsWriter.getPending(),
  };
}
