/**
 * slash-dispatch.mjs — the runSlashCommand slash-command dispatcher.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory: the switch body reads live store/state and drives many pickers +
 * openers, so it can't be pure. The switch body below is the original App
 * logic verbatim (case ordering + fallthrough semantics byte-identical), with
 * every closure identifier threaded in through the factory argument. Openers
 * defined later in the App factory zone are passed as lazy getters so their
 * live binding is used at call time.
 */
export function createSlashDispatch({
  state,
  store,
  normalizeSlashCommandName,
  setContextPanel,
  closeUsagePanel,
  openModelPicker,
  modelSwitchNotice,
  openSearchPicker,
  openAgentsPicker,
  openWorkflowPicker,
  workflowSwitchNotice,
  openOutputStylePicker,
  outputStyleNotice,
  openThemePicker,
  themeNotice,
  openEffortPicker,
  projectNameFromPath,
  enterProject,
  openProjectPicker,
  openToolsPicker,
  openMcpPicker,
  openSkillsPicker,
  openPluginsPicker,
  openHooksPicker,
  openProviderSetupPicker,
  openChannelSetupPicker,
  openMemoryCorePicker,
  parseMemoryCommand,
  openSettingsPicker,
  openAutoClearPicker,
  formatDuration,
  openResumePicker,
  openUsagePanel,
  openContextPicker,
  openProfilePicker,
  openUpdatePicker,
  runDoctor,
  requestExit,
}) {
  const runSlashCommand = (cmd, arg = '') => {
    const rawName = String(cmd || '').toLowerCase();
    cmd = normalizeSlashCommandName(cmd);
    if (cmd !== 'context') setContextPanel(null);
    if (cmd !== 'usage') closeUsagePanel();
    switch (cmd) {
      case 'clear':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /clear', 'warn');
          return false;
        }
        if (rawName === 'new') {
          void store.newSession().then(() => {}).catch((e) => store.pushNotice(`new session failed: ${e?.message || e}`, 'error'));
        } else {
          void store.clear().then(() => {}).catch((e) => store.pushNotice(`clear failed: ${e?.message || e}`, 'error'));
        }
        return true;
      case 'model':
        if (!arg) {
          openModelPicker();
          return true;
        }
        void store.setModel(arg)
          .then(ok => store.pushNotice(ok ? modelSwitchNotice() : 'Model switch is already running.', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t switch model: ${e?.message || e}`, 'error'));
        return true;
      case 'remote': {
        // /remote = force-claim, not toggle: always turns remote ON for THIS
        // session and steals the seat from any other session (which flips
        // itself OFF via the superseded notification). Turn off via /channels.
        const enabled = store.claimRemote?.() === true;
        store.pushNotice(enabled ? 'Remote mode ON — this session owns remote now.' : 'Remote mode unavailable.', 'info');
        return true;
      }
      case 'search':
        // No busy guard: /search only picks the search provider/model (a config
        // save consumed by the NEXT search tool call). It never touches the
        // in-flight turn, and the same picker is already reachable mid-turn via
        // /settings, so blocking it here was inconsistent.
        if (arg) store.pushNotice('/search sets the search provider/model; the search tool uses that model when called.', 'warn');
        openSearchPicker();
        return true;
      case 'agents':
        openAgentsPicker();
        return true;
      case 'workflow':
        if (!arg) {
          openWorkflowPicker();
          return true;
        }
        void store.setWorkflow?.(arg.trim())
          .then((result) => {
            if (!result) {
              store.pushNotice('Workflow switch is already running.', 'warn');
              return;
            }
            store.pushNotice(workflowSwitchNotice(result), 'info');
          })
          .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'));
        return true;
      case 'outputstyle': {
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /OutputStyle', 'warn');
          return false;
        }
        const value = arg.trim();
        const lower = value.toLowerCase();
        if (!value) {
          openOutputStylePicker();
          return true;
        }
        if (lower === 'status' || lower === 'current' || lower === 'show') {
          try {
            const status = store.getOutputStyle?.();
            const label = status?.current?.label || status?.current?.id || status?.configured || 'Default';
            store.pushNotice(`Output style: ${label}`, 'info');
          } catch (e) {
            store.pushNotice(`Couldn’t read output style: ${e?.message || e}`, 'error');
          }
          return true;
        }
        void store.setOutputStyle?.(value)
          .then((result) => {
            if (!result) {
              store.pushNotice('Output style switch is already running.', 'warn');
              return;
            }
            store.pushNotice(outputStyleNotice(result), 'info');
          })
          .catch((e) => store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'theme': {
        const value = arg.trim();
        const lower = value.toLowerCase();
        if (!value) {
          openThemePicker();
          return true;
        }
        let themes = [];
        try { themes = store.listThemes?.() || []; } catch (e) {
          store.pushNotice(`could not list themes: ${e?.message || e}`, 'error');
          return true;
        }
        if (lower === 'status' || lower === 'current' || lower === 'show') {
          const id = store.getTheme?.();
          const entry = themes.find((t) => t.id === id);
          store.pushNotice(`Theme: ${entry?.label || id || 'default'}`, 'info');
          return true;
        }
        const match = themes.find((t) => t.id.toLowerCase() === lower)
          || themes.find((t) => String(t.label || '').toLowerCase() === lower);
        if (!match) {
          const ids = themes.map((t) => t.id).join(', ');
          store.pushNotice(`usage: /theme [id]. Available: ${ids}`, 'warn');
          return true;
        }
        try {
          const applied = store.setTheme?.(match.id, { persist: true });
          store.pushNotice(themeNotice(applied || match), 'info');
        } catch (e) {
          store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'effort':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /effort', 'warn');
          return false;
        }
        if (!arg) {
          openEffortPicker();
          return true;
        }
        void store.setEffort(arg)
          .then(result => store.pushNotice(result ? `Effort set to ${result}` : 'Effort switch is already running.', result ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t switch effort: ${e?.message || e}`, 'error'));
        return true;
      case 'fast': {
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /fast', 'warn');
          return false;
        }
        const value = String(arg || '').trim().toLowerCase();
        const setTo = value
          ? ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(value)
            ? true
            : ['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(value)
              ? false
              : null
          : undefined;
        if (setTo === null) {
          store.pushNotice('usage: /fast [on|off]', 'warn');
          return true;
        }
        const action = setTo === undefined ? store.toggleFast?.() : store.setFast?.(setTo);
        void Promise.resolve(action)
          .then((enabled) => {
            if (enabled === null || enabled === undefined) {
              store.pushNotice('Fast mode switch is already running.', 'warn');
              return;
            }
            store.pushNotice(`Fast mode ${enabled ? 'on' : 'off'} for ${state.provider}/${state.model}`, 'info');
          })
          .catch((e) => store.pushNotice(`Couldn’t update fast mode: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'cwd': {
        const nextPath = arg.trim();
        if (!nextPath) {
          store.pushNotice(`Project path: ${state.cwd}`, 'info');
          return true;
        }
        try {
          store.setCwd?.(nextPath, { message: `Project set: ${projectNameFromPath(nextPath)}` });
        } catch (e) {
          store.pushNotice(`project switch failed: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'project': {
        const target = arg.trim();
        if (target) {
          enterProject(target);
          return true;
        }
        openProjectPicker();
        return true;
      }
      case 'tools':
        openToolsPicker(arg.trim());
        return true;
      case 'mcp':
        openMcpPicker();
        return true;
      case 'skills':
        openSkillsPicker();
        return true;
      case 'plugins':
        openPluginsPicker();
        return true;
      case 'hooks':
        openHooksPicker();
        return true;
      case 'providers':
        void openProviderSetupPicker();
        return true;
      case 'channels':
        void openChannelSetupPicker('all');
        return true;
      case 'schedules':
        void openChannelSetupPicker('schedules');
        return true;
      case 'webhooks':
        void openChannelSetupPicker('webhooks');
        return true;
      case 'auth':
        store.pushNotice('/auth moved to /providers', 'info');
        void openProviderSetupPicker();
        return true;
      case 'auth-forget': {
        const providerId = arg.trim();
        if (!providerId) {
          store.pushNotice('usage: /auth-forget <provider>', 'warn');
          return true;
        }
        try {
          store.forgetProviderAuth(providerId);
        } catch (e) {
          store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'memory': {
        if (!arg.trim()) {
          openMemoryCorePicker({ returnTo: null });
          return true;
        }
        void store.memoryControl?.(parseMemoryCommand(arg))
          .catch((e) => store.pushNotice(`memory failed: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'recall': {
        const query = arg.trim();
        if (!query) {
          store.pushNotice('usage: /recall <query>', 'warn');
          return true;
        }
        void store.recall?.(query)
          .catch((e) => store.pushNotice(`recall failed: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'autoclear': {
        const value = arg.trim().toLowerCase();
        if (!value) {
          openAutoClearPicker();
          return true;
        }
        try {
          let next;
          if (value === 'status') {
            next = store.getAutoClear?.();
          } else if (value === 'on' || value === 'enable' || value === 'enabled') {
            next = store.setAutoClear?.({ enabled: true });
          } else if (value === 'off' || value === 'disable' || value === 'disabled') {
            next = store.setAutoClear?.({ enabled: false });
          } else {
            next = store.setAutoClear?.({ duration: value });
          }
          if (!next) {
            store.pushNotice('autoclear unavailable', 'warn');
            return true;
          }
          store.pushNotice(`autoclear ${next.enabled ? 'on' : 'off'} · idle ${formatDuration(next.idleMs)}`, 'info');
        } catch (e) {
          store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'compact':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /compact', 'warn');
          return false;
        }
        void store.compact()
          .then((r) => {
            if (!r) {
              store.pushNotice('Compact failed.', 'warn');
              return;
            }
            if (r.error) {
              store.pushNotice('Compact failed.', 'error');
              return;
            }
            if (r.changed === false && r.reason) {
              store.pushNotice(r.reason, 'warn');
              return;
            }
            if (r.changed === false) {
              store.pushNotice('nothing to compact', 'warn');
              return;
            }
            store.pushNotice('Compact done.', 'info');
          })
          .catch(() => store.pushNotice('Compact failed.', 'error'));
        return true;
      case 'resume':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /resume', 'warn');
          return false;
        }
        if (arg) {
          void store.resume(arg)
            .then(ok => store.pushNotice(ok ? `Resumed ${arg}` : 'Couldn’t resume chat.', ok ? 'info' : 'warn'))
            .catch((e) => store.pushNotice(`Couldn’t resume chat: ${e?.message || e}`, 'error'));
        } else {
          openResumePicker();
        }
        return true;
      case 'usage':
        openUsagePanel(arg);
        return true;
      case 'context':
        openContextPicker();
        return true;
      case 'settings':
      case 'config':
        openSettingsPicker();
        return true;
      case 'profile':
        openProfilePicker();
        return true;
      case 'update':
        openUpdatePicker();
        return true;
      case 'doctor':
        if (state.commandBusy) {
          store.pushNotice('wait for the current command to finish before /doctor', 'warn');
          return false;
        }
        void Promise.resolve(runDoctor?.())
          .catch((e) => store.pushNotice(`doctor failed: ${e?.message || e}`, 'error'));
        return true;
      case 'quit':
        requestExit();
        return true;
      default:
        store.pushNotice(`unknown command: /${cmd}`, 'warn');
        return true;
    }
  };
  return { runSlashCommand };
}
