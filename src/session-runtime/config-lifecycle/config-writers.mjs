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
import { AsyncLocalStorage } from 'node:async_hooks';
import { createDebouncedWriter } from '../../runtime/shared/debounced-writer.mjs';
import { DEFAULT_OUTPUT_STYLE } from '../../runtime/shared/defaults-separation.mjs';

const CONFIG_SAVE_DEBOUNCE_MS = 150;

// Only pending writers are retained. A new runtime must also see the changes
// OTHER runtimes accepted before it reads its initial config from disk.
const pendingSessionConfigWriters = new Set();
const UNSAVED_SETTINGS = 'Cannot create a new session: pending settings could not be saved.';

/** Every runtime's pending saves, those accepted while it waits included: the
 *  process shutdown barrier. */
export async function drainSessionConfigWrites() {
  while (pendingSessionConfigWriters.size) {
    await Promise.all([...pendingSessionConfigWriters].map((writers) => writers.flushAll({ requireSaved: true })));
  }
}

/** The reader barrier: the changes every runtime had accepted at this call,
 *  on disk. Changes accepted later are newer than what the reader needs, so a
 *  busy runtime never holds it. */
export async function flushPendingSessionConfigWrites() {
  const saved = await Promise.all([...pendingSessionConfigWriters].map((writers) => writers.flushAccepted()));
  if (saved.includes(false)) throw new Error(UNSAVED_SETTINGS);
}

/** `root` with a top-level outputStyle; the retired `agent.outputStyle` copy is dropped. */
export function configWithOutputStyle(root, styleId) {
  const next = { ...(root || {}), outputStyle: styleId };
  // Defaults live in code: the default style is stored as an absent key.
  if (styleId === DEFAULT_OUTPUT_STYLE) delete next.outputStyle;
  if (next.agent && typeof next.agent === 'object' && !Array.isArray(next.agent)) {
    const agent = { ...next.agent };
    delete agent.outputStyle;
    next.agent = agent;
  }
  return next;
}

const writeFailure = (label) => (error, sync) =>
  process.stderr.write(`[config] ${sync ? 'debounced' : 'async'} ${label} failed: ${error?.message || error}\n`);

export function createConfigWriters({ cfgMod, sharedCfgMod }) {
  // A write runs in the context these writers were created in (their runtime's
  // config-write owner), whoever starts the flush: another runtime's reader
  // barrier must not take this runtime's writes into its own close.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const owned = (write) => (value) => inOwnerContext(write, value);
  let pendingConfigChanges = [];
  // Synchronous reload remains a synchronous API. It may flush an idle writer,
  // but must retain its pending field overlay while an async write is active.
  const configWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: owned(async () => {
      const changes = pendingConfigChanges;
      await cfgMod.saveConfigPatchAsync(changes);
      // New edits accepted during this write remain queued; a successful prefix
      // must never be replayed over another runtime's subsequent changes.
      pendingConfigChanges = pendingConfigChanges.slice(changes.length);
    }),
    onError: writeFailure('saveConfig'),
  });
  const skillsWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: owned((names) => cfgMod.patchSkillsDisabledAsync(names)),
    onError: writeFailure('patchSkillsDisabled'),
  });
  const outputStyleWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: owned((styleId) => sharedCfgMod.updateConfigAsync((root) => configWithOutputStyle(root, styleId))),
    onError: (error) => process.stderr.write(`[config] async outputStyle save failed: ${error?.message || error}\n`),
  });
  let configFlushInFlight = null;

  function releaseSavedWriter() {
    const pending = configWriter.hasPending() || skillsWriter.hasPending() || outputStyleWriter.hasPending();
    if (!pending) pendingSessionConfigWriters.delete(registration);
    return !pending;
  }

  // Both channels up to marks the caller took together, at its call: the
  // skills.disabled patch lands after the config edits accepted before those
  // marks, never after edits accepted later.
  async function flushConfigAndSkillsTo(configMark, skillsMark) {
    const config = configWriter.flushTo(configMark);
    const skills = skillsWriter.flushTo(skillsMark, () => config.then((saved) => saved && skillsWriter.flush()));
    return !(await Promise.all([config, skills])).includes(false);
  }

  async function runConfigFlushAsync() {
    do {
      if (!(await flushConfigAndSkillsTo(configWriter.acceptedMark(), skillsWriter.acceptedMark()))) return false;
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

  // This runtime's save barrier: start/drain all of its debounce channels
  // through their async variants, then resolve only when every promise tail
  // (including skills, which config flushes after its whole-section write) has
  // settled. Other runtimes' writers are not waited on: a reader of the file
  // flushes what they accepted itself (flushPendingSessionConfigWrites), and
  // a process shutdown drains them all (drainSessionConfigWrites).
  async function flushAllConfigSavesAsync({ requireSaved = false } = {}) {
    const saved = await Promise.all([flushConfigSaveAsync(), outputStyleWriter.flush()]);
    releaseSavedWriter();
    if (requireSaved && saved.includes(false)) throw new Error(UNSAVED_SETTINGS);
  }

  async function flushOutputStyleSaveAsync() {
    await outputStyleWriter.flush();
    releaseSavedWriter();
  }

  // What each channel had accepted when another runtime's reader asked; no
  // channel waits on values another channel accepts later.
  async function flushAcceptedConfigSaves() {
    const saved = await Promise.all([
      flushConfigAndSkillsTo(configWriter.acceptedMark(), skillsWriter.acceptedMark()),
      outputStyleWriter.flushAccepted(),
    ]);
    releaseSavedWriter();
    return !saved.includes(false);
  }

  const registration = { flushAll: flushAllConfigSavesAsync, flushAccepted: flushAcceptedConfigSaves };

  return {
    queueConfigChanges(changes) {
      pendingConfigChanges = [...pendingConfigChanges, ...changes];
      configWriter.schedule(pendingConfigChanges, flushConfigSaveAsync);
      pendingSessionConfigWriters.add(registration);
    },
    scheduleSkillsSave(names) {
      skillsWriter.schedule(names, flushConfigSaveAsync);
      pendingSessionConfigWriters.add(registration);
    },
    scheduleOutputStyleSave(styleId) {
      outputStyleWriter.schedule(styleId, flushOutputStyleSaveAsync);
      pendingSessionConfigWriters.add(registration);
    },
    flushConfigSave,
    flushConfigSaveAsync,
    flushAllConfigSavesAsync,
    hasPendingConfigChanges: () => configWriter.hasPending(),
    pendingConfigChanges: () => pendingConfigChanges,
    pendingSkills: () => skillsWriter.getPending(),
    pendingOutputStyle: () => outputStyleWriter.getPending(),
  };
}
