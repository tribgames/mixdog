// settings-picker/settings-toggles/store-toggles.mjs
// The boolean rows of Settings: each write goes through the store, reports the
// outcome as a notice, and refreshes Settings through the deferred refresh
// bound to the keypress that started it.
export function createStoreToggles({ store, view, formatDuration, deferredSettingsRefresh }) {
  const applyAutoClear = (patch = {}) => {
    void Promise.resolve(store.setAutoClear?.(patch))
      .then((next) => {
        if (!next) store.pushNotice('autoclear unavailable', 'warn');
        else
          store.pushNotice(
            next.enabled ? `Auto-clear on · idle ${formatDuration(next.idleMs)}` : 'Auto-clear off',
            'info'
          );
      })
      .catch((e) => store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error'))
      .finally(deferredSettingsRefresh());
  };
  // On/Off toggle only — idle-window override lives in the Advanced picker
  // (openAutoClearPicker), opened via Enter on this row.
  const toggleAutoClear = () => applyAutoClear({ enabled: !view.autoClearEnabled });
  const toggleCompaction = () => {
    void Promise.resolve(store.setCompactionSettings?.({ auto: view.compaction.auto === false }))
      .then((next) => {
        if (!next) {
          store.pushNotice('compaction setting is busy', 'warn');
          return;
        }
        store.pushNotice(`Compaction ${next.auto !== false ? 'auto on' : 'auto off'}`, 'info');
      })
      .catch((e) => store.pushNotice(`compaction failed: ${e?.message || e}`, 'error'))
      .finally(deferredSettingsRefresh());
  };

  // Voice toggle: the core's `voice/toggleVoice` flips voice.enabled, installing the managed
  // whisper/ffmpeg runtime the first time it is turned on, and shows the install's progress on the
  // thread's hint line. Its reply carries the outcome; the notices are the client's.
  const voiceNotice = (turningOn, result) => {
    if (result?.ok === false) {
      if (!result.error) return store.pushNotice('Voice install is already running', 'warn');
      const failure = /^Voice setup failed/.test(result.error) ? result.error : `Voice OFF failed: ${result.error}`;
      return store.pushNotice(failure, 'error');
    }
    if (!turningOn) return store.pushNotice('Voice OFF', 'info');
    // `enabled: false` on an ON request: a later OFF superseded the install, which says nothing.
    if (result?.enabled === true) store.pushNotice('Voice ON — channel voice messages will be transcribed', 'info');
  };
  const applyVoice = () => {
    void (async () => {
      const status = await store.getVoiceStatus();
      if (status?.busy === true) {
        store.pushNotice('Voice install is already running', 'warn');
        return;
      }
      const turningOn = status?.enabled !== true;
      const reply = await store.toggleVoice(turningOn);
      voiceNotice(turningOn, reply?.result);
    })()
      .catch((e) => store.pushNotice(`voice setup failed: ${e?.message || e}`, 'error'))
      .finally(deferredSettingsRefresh());
  };
  const applyToolModule = (label, setter, enabled) => {
    void Promise.resolve(setter?.(enabled))
      .then((next) => {
        if (!next) store.pushNotice(`${label} setting is busy`, 'warn');
        else store.pushNotice(`${label} ${enabled ? 'on' : 'off'} · new sessions`, 'info');
      })
      .catch((e) => store.pushNotice(`${label} setting failed: ${e?.message || e}`, 'error'))
      .finally(deferredSettingsRefresh());
  };
  const toggleWebSearch = () => applyToolModule('Web search', store.setWebSearchEnabled, !view.webSearchOn);
  const toggleMemory = () => applyToolModule('Memory', store.setMemoryToolsEnabled, !view.memoryToolsOn);

  return { toggleAutoClear, toggleCompaction, applyVoice, toggleWebSearch, toggleMemory };
}
