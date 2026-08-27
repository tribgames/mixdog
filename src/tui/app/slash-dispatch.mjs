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
import { presentErrorText } from '../../runtime/shared/err-text.mjs';

export function compactFailureNotice(error) {
  if (error == null || String(error).trim() === '') return 'Compact failed.';
  const reason = presentErrorText(error, { surface: 'compact', max: 320 });
  if (!reason || reason === 'Unknown error') return 'Compact failed.';
  return /^compact(?:ion)? failed\b/i.test(reason) ? reason : `Compact failed: ${reason}`;
}

export function createSlashDispatch({
  state,
  store,
  normalizeSlashCommandName,
  surface,
  closeUsagePanel,
  openModelPicker,
  modelSwitchNotice,
  openWebSearchPicker,
  openAgentsPicker,
  openWorkflowPicker,
  workflowSwitchNotice,
  openOutputStylePicker,
  outputStyleNotice,
  openThemePicker,
  themeNotice,
  openEffortPicker,
  enterProject,
  openProjectPicker,
  openMcpPicker,
  openSkillsPicker,
  openPluginsPicker,
  openHooksPicker,
  openProviderSetupPicker,
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
  const openSlashPanel = (command, title, open) => {
    const own = surface.claim();
    if (!own.paint({
      _kind: `slash-loading:${command}`,
      title,
      description: `Loading ${title.toLowerCase()}...`,
      help: 'Esc Close',
      indexMode: 'never',
      pickerKey: `slash-loading:${command}`,
      loading: true,
      items: [],
      onSelect: () => {},
      onCancel: () => own.close(),
    })) return;
    const finishUnclaimedLoading = () => {
      // A real picker/context/usage surface supersedes this loading identity.
      // If the opener completed without painting (empty result or failure),
      // remove only the still-owned placeholder and restore the normal prompt.
      if (own.owns()) own.close();
    };
    try {
      const opening = open();
      if (opening && typeof opening.then === 'function') {
        void Promise.resolve(opening).then(
          finishUnclaimedLoading,
          (error) => {
            finishUnclaimedLoading();
            store.pushNotice(`${title} panel failed: ${error?.message || error}`, 'error');
          },
        );
      } else {
        finishUnclaimedLoading();
      }
    } catch (error) {
      finishUnclaimedLoading();
      store.pushNotice(`${title} panel failed: ${error?.message || error}`, 'error');
    }
  };
  const runSlashCommand = (cmd, arg = '') => {
    const rawName = String(cmd || '').toLowerCase();
    cmd = normalizeSlashCommandName(cmd);
    // Synchronous dispatch of the command the user just submitted: this action
    // owns the surface it clears.
    if (cmd !== 'context') surface.claim().context(null);
    if (cmd !== 'usage') closeUsagePanel();
    switch (cmd) {
      case 'clear':
        if (state.busy || state.commandBusy) {
          store.pushNotice(`wait for the current session command to finish before /${rawName === 'new' ? 'new' : 'clear'}`, 'warn');
          return false;
        }
        if (rawName === 'new') {
          void store.newSession()
            .then((created) => {
              if (created === false) {
                store.pushNotice('new session is already running', 'warn');
                return;
              }
              // Incremental Ink rendering can otherwise retain physical rows
              // from the taller outgoing transcript on Windows Terminal.
              store.forceRenderRepaint?.();
            })
            .catch((e) => store.pushNotice(`new session failed: ${e?.message || e}`, 'error'));
        } else {
          void store.clear().then(() => {}).catch((e) => store.pushNotice(`clear failed: ${e?.message || e}`, 'error'));
        }
        return true;
      case 'model':
        if (!arg) {
          openSlashPanel('model', 'Model', () => openModelPicker());
          return true;
        }
        if (arg.trim().toLowerCase() === 'refresh') {
          // Explicit catalog reload: force a fresh remote provider list.
          openSlashPanel('model', 'Model', () => openModelPicker({ refreshModels: true }));
          return true;
        }
        void store.setModel(arg)
          .then(ok => store.pushNotice(ok ? modelSwitchNotice() : 'Model switch is already running.', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t switch model: ${e?.message || e}`, 'error'));
        return true;
      case 'websearch':
        // No busy guard: /websearch only picks the web-search provider/model (a
        // config save consumed by the NEXT web_search tool call). It never touches the
        // in-flight turn, and the same picker is already reachable mid-turn via
        // /settings, so blocking it here was inconsistent.
        if (arg) store.pushNotice('/websearch sets the web-search provider/model; the web_search tool uses that model when called.', 'warn');
        openSlashPanel('websearch', 'Web Search Model', () => openWebSearchPicker());
        return true;
      case 'agents':
        openSlashPanel('agents', 'Agents', () => openAgentsPicker(
          arg.trim().toLowerCase() === 'refresh' ? { refreshModels: true } : {},
        ));
        return true;
      case 'workflow':
        if (!arg) {
          openSlashPanel('workflow', 'Workflow', () => openWorkflowPicker());
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
          openSlashPanel('outputstyle', 'Output Style', () => openOutputStylePicker());
          return true;
        }
        if (lower === 'status' || lower === 'current' || lower === 'show') {
          void Promise.resolve(store.getOutputStyle?.())
            .then((status) => {
              const label = status?.current?.label || status?.current?.id || status?.configured || 'Default';
              store.pushNotice(`Output style: ${label}`, 'info');
            })
            .catch((e) => store.pushNotice(`Couldn’t read output style: ${e?.message || e}`, 'error'));
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
          openSlashPanel('theme', 'Theme', () => openThemePicker());
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
      case 'effort': {
        // A running turn no longer blocks the switch: the in-flight turn keeps
        // the effort it started with, and the new level applies from the next
        // turn. Same for /fast below.
        const pendingTurn = state.busy ? ' (applies from the next turn)' : '';
        if (!arg) {
          openSlashPanel('effort', 'Effort', () => openEffortPicker());
          return true;
        }
        void store.setEffort(arg)
          .then(result => store.pushNotice(result ? `Effort set to ${result}${pendingTurn}` : 'Effort switch is already running.', result ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t switch effort: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'fast': {
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
            store.pushNotice(
              `Fast mode ${enabled ? 'on' : 'off'} for ${state.provider}/${state.model}`
              + (state.busy ? ' (applies from the next turn)' : ''),
              'info',
            );
          })
          .catch((e) => store.pushNotice(`Couldn’t update fast mode: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'project': {
        const target = arg.trim();
        if (target) {
          enterProject(target);
          return true;
        }
        openSlashPanel('project', 'Projects', () => openProjectPicker());
        return true;
      }
      case 'mcp':
        openSlashPanel('mcp', 'MCP Servers', () => openMcpPicker());
        return true;
      case 'skills':
        openSlashPanel('skills', 'Skills', () => openSkillsPicker());
        return true;
      case 'plugins':
        openSlashPanel('plugins', 'Plugins', () => openPluginsPicker());
        return true;
      case 'hooks':
        openSlashPanel('hooks', 'Hooks', () => openHooksPicker());
        return true;
      case 'providers':
        openSlashPanel('providers', 'Providers', () => openProviderSetupPicker());
        return true;
      case 'schedules':
      case 'webhooks':
        // Management surface is desktop-only (user decision): hidden from the
        // palette, and a typed command answers instead of opening a picker.
        store.pushNotice('Schedules and webhooks are managed in the Mixdog desktop app', 'info');
        return true;
      case 'memory': {
        if (!arg.trim()) {
          openSlashPanel('memory', 'Memory', () => openMemoryCorePicker({ returnTo: null }));
          return true;
        }
        void store.memoryControl?.(parseMemoryCommand(arg))
          .catch((e) => store.pushNotice(`memory failed: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'autoclear': {
        const value = arg.trim().toLowerCase();
        if (!value) {
          openSlashPanel('autoclear', 'Auto-clear', () => openAutoClearPicker());
          return true;
        }
        // Promise-shaped on a daemon-backed store, so the verdict is reported
        // when the call settles instead of read off the (always truthy) call.
        void Promise.resolve(
          value === 'status'
            ? store.getAutoClear?.()
            : value === 'on' || value === 'enable' || value === 'enabled'
              ? store.setAutoClear?.({ enabled: true })
              : value === 'off' || value === 'disable' || value === 'disabled'
                ? store.setAutoClear?.({ enabled: false })
                : store.setAutoClear?.({ duration: value }),
        )
          .then((next) => {
            if (!next) {
              store.pushNotice('autoclear unavailable', 'warn');
              return;
            }
            store.pushNotice(`autoclear ${next.enabled ? 'on' : 'off'} · idle ${formatDuration(next.idleMs)}`, 'info');
          })
          .catch((e) => store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error'));
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
              store.pushNotice(compactFailureNotice(r.error), 'error');
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
          .catch((error) => store.pushNotice(compactFailureNotice(error), 'error'));
        return true;
      case 'goal':
        void Promise.resolve(store.goalControl?.({ command: arg }))
          .then((result) => {
            if (!result) {
              store.pushNotice('Goal is unavailable.', 'warn');
              return;
            }
            store.pushNotice(result.message || 'Goal updated.', 'info');
          })
          .catch((error) => store.pushNotice(`Goal failed: ${error?.message || error}`, 'error'));
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
          openSlashPanel('resume', 'Resume', () => openResumePicker());
        }
        return true;
      case 'usage':
        openSlashPanel('usage', 'Provider Quotas', () => openUsagePanel(arg));
        return true;
      case 'context':
        openSlashPanel('context', 'Context Usage', () => openContextPicker());
        return true;
      case 'inherit':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /inherit', 'warn');
          return false;
        }
        void Promise.resolve(store.inheritSession?.())
          .then((result) => {
            if (!result) {
              store.pushNotice('nothing to inherit', 'warn');
              return;
            }
            store.pushNotice(
              `inherited ${result.messages} messages into ${result.sessionId}`,
              'info',
            );
          })
          .catch((e) => store.pushNotice(`inherit failed: ${e?.message || e}`, 'error'));
        return true;
      case 'settings':
      case 'config':
        openSlashPanel('settings', 'Settings', () => openSettingsPicker());
        return true;
      case 'profile':
        openSlashPanel('profile', 'Profile', () => openProfilePicker());
        return true;
      case 'update':
        openSlashPanel('update', 'Update', () => openUpdatePicker());
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
