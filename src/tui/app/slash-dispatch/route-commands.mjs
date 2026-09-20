// slash-dispatch/route-commands.mjs
// Slash commands that change the route: model, web-search model, agents,
// workflow, output style, theme, effort and Fast. Each handler receives the
// dispatch context and the raw argument and returns whether it ran.
const STATUS_WORDS = ['status', 'current', 'show'];

export const routeCommands = {
  model(ctx, arg) {
    const { store, openSlashPanel, deps } = ctx;
    if (!arg) {
      openSlashPanel('model', 'Model', () => deps.openModelPicker());
      return true;
    }
    if (arg.trim().toLowerCase() === 'refresh') {
      // Explicit catalog reload: force a fresh remote provider list.
      openSlashPanel('model', 'Model', () => deps.openModelPicker({ refreshModels: true }));
      return true;
    }
    void store
      .setModel(arg)
      .then((ok) =>
        store.pushNotice(ok ? deps.modelSwitchNotice() : 'Model switch is already running.', ok ? 'info' : 'warn')
      )
      .catch((e) => store.pushNotice(`Couldn’t switch model: ${e?.message || e}`, 'error'));
    return true;
  },

  websearch(ctx, arg) {
    const { store, openSlashPanel, deps } = ctx;
    // No busy guard: /websearch only picks the web-search provider/model (a
    // config save consumed by the NEXT web_search tool call). It never touches the
    // in-flight turn, and the same picker is already reachable mid-turn via
    // /settings, so blocking it here was inconsistent.
    if (arg)
      store.pushNotice(
        '/websearch sets the web-search provider/model; the web_search tool uses that model when called.',
        'warn'
      );
    openSlashPanel('websearch', 'Web Search Model', () => deps.openWebSearchPicker());
    return true;
  },

  agents(ctx, arg) {
    ctx.openSlashPanel('agents', 'Agents', () =>
      ctx.deps.openAgentsPicker(arg.trim().toLowerCase() === 'refresh' ? { refreshModels: true } : {})
    );
    return true;
  },

  workflow(ctx, arg) {
    const { store, openSlashPanel, deps } = ctx;
    if (!arg) {
      openSlashPanel('workflow', 'Workflow', () => deps.openWorkflowPicker());
      return true;
    }
    void store
      .setWorkflow?.(arg.trim())
      .then((result) => {
        if (!result) {
          store.pushNotice('Workflow switch is already running.', 'warn');
          return;
        }
        store.pushNotice(deps.workflowSwitchNotice(result), 'info');
      })
      .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'));
    return true;
  },

  outputstyle(ctx, arg) {
    const { state, store, openSlashPanel, deps } = ctx;
    if (state.busy) {
      store.pushNotice('wait for the current turn to finish before /OutputStyle', 'warn');
      return false;
    }
    const value = arg.trim();
    if (!value) {
      openSlashPanel('outputstyle', 'Output Style', () => deps.openOutputStylePicker());
      return true;
    }
    if (STATUS_WORDS.includes(value.toLowerCase())) {
      void Promise.resolve(store.getOutputStyle?.())
        .then((status) => {
          const label = status?.current?.label || status?.current?.id || status?.configured || 'Default';
          store.pushNotice(`Output style: ${label}`, 'info');
        })
        .catch((e) => store.pushNotice(`Couldn’t read output style: ${e?.message || e}`, 'error'));
      return true;
    }
    void store
      .setOutputStyle?.(value)
      .then((result) => {
        if (!result) {
          store.pushNotice('Output style switch is already running.', 'warn');
          return;
        }
        store.pushNotice(deps.outputStyleNotice(result), 'info');
      })
      .catch((e) => store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error'));
    return true;
  },

  theme(ctx, arg) {
    const { store, openSlashPanel, deps } = ctx;
    const value = arg.trim();
    const lower = value.toLowerCase();
    if (!value) {
      openSlashPanel('theme', 'Theme', () => deps.openThemePicker());
      return true;
    }
    let themes = [];
    try {
      themes = store.listThemes?.() || [];
    } catch (e) {
      store.pushNotice(`could not list themes: ${e?.message || e}`, 'error');
      return true;
    }
    if (STATUS_WORDS.includes(lower)) {
      const id = store.getTheme?.();
      const entry = themes.find((t) => t.id === id);
      store.pushNotice(`Theme: ${entry?.label || id || 'default'}`, 'info');
      return true;
    }
    const match =
      themes.find((t) => t.id.toLowerCase() === lower) ||
      themes.find((t) => String(t.label || '').toLowerCase() === lower);
    if (!match) {
      const ids = themes.map((t) => t.id).join(', ');
      store.pushNotice(`usage: /theme [id]. Available: ${ids}`, 'warn');
      return true;
    }
    try {
      const applied = store.setTheme?.(match.id, { persist: true });
      store.pushNotice(deps.themeNotice(applied || match), 'info');
    } catch (e) {
      store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
    }
    return true;
  },

  effort(ctx, arg) {
    const { state, store, openSlashPanel, deps } = ctx;
    // A running turn no longer blocks the switch: the in-flight turn keeps
    // the effort it started with, and the new level applies from the next
    // turn. Same for /fast below.
    const pendingTurn = state.busy ? ' (applies from the next turn)' : '';
    if (!arg) {
      openSlashPanel('effort', 'Effort', () => deps.openEffortPicker());
      return true;
    }
    void store
      .setEffort(arg)
      .then((result) =>
        store.pushNotice(
          result ? `Effort set to ${result}${pendingTurn}` : 'Effort switch is already running.',
          result ? 'info' : 'warn'
        )
      )
      .catch((e) => store.pushNotice(`Couldn’t switch effort: ${e?.message || e}`, 'error'));
    return true;
  },

  fast(ctx, arg) {
    const { state, store } = ctx;
    const value = String(arg || '')
      .trim()
      .toLowerCase();
    let setTo = null;
    if (!value) setTo = undefined;
    else if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(value)) setTo = true;
    else if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(value)) setTo = false;
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
          `Fast mode ${enabled ? 'on' : 'off'} for ${state.provider}/${state.model}` +
            (state.busy ? ' (applies from the next turn)' : ''),
          'info'
        );
      })
      .catch((e) => store.pushNotice(`Couldn’t update fast mode: ${e?.message || e}`, 'error'));
    return true;
  },
};
