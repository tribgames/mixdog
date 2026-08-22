/**
 * settings-picker.mjs — the SETTINGS picker cluster.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. The function body is the original App logic verbatim, with closure
 * identifiers threaded through the factory argument. openSettingsPicker
 * self-references (for light refresh) via the local const; all other openers it
 * routes to are threaded as lazy getter wrappers so they resolve the live
 * binding at call time.
 */
import { outputStyleNotice } from './route-pickers.mjs';
import { isVoiceEnabled, toggleVoice, isVoiceInstallBusy } from '../lib/voice-setup.mjs';

export function createSettingsPicker({
  store,
  state,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  settingsHeavyCacheRef,
  settingsRequestRef,
  formatDuration,
  displayModelName,
  routeModelLabel,
  workflowDisplayName,
  workflowSwitchNotice,
  themeNotice,
  openModelPicker,
  openWebSearchPicker,
  openAgentsPicker,
  openWorkflowPicker,
  openOutputStylePicker,
  openProviderSetupPicker,
  openThemePicker,
  openAutoClearPicker,
  openProfilePicker,
  openMcpPicker,
  openPluginsPicker,
  openHooksPicker,
  openSkillsPicker,
  openMemoryCorePicker,
  openUpdatePicker,
}) {
  // Build generation guard. Every open/refresh takes a ticket and Esc bumps it,
  // so a slow snapshot from a superseded (or already closed) build can never
  // re-open Settings. The ref is owned by App so it survives this per-render
  // factory; a missing ref degrades to "always current".
  const nextSettingsRequest = () => {
    if (!settingsRequestRef) return 0;
    settingsRequestRef.current = (Number(settingsRequestRef.current) || 0) + 1;
    return settingsRequestRef.current;
  };
  const isCurrentSettingsRequest = (requestId) => (
    !settingsRequestRef || settingsRequestRef.current === requestId
  );
  const buildSettingsPicker = async (opts = {}, requestId = 0) => {
    // Surface claim (panel-surface.mjs), taken before the snapshot await. The
    // request ticket above only invalidates builds that Settings' own Esc
    // bumped; a close/handover of ANOTHER surface while this open is pending is
    // caught here instead.
    const own = surface.claim();
    const light = opts.light === true;
    const overrides = opts.overrides || null;
    const heavyCache = light ? settingsHeavyCacheRef.current : null;
    // ONE round-trip for the whole panel: on a daemon-backed store each getter
    // below is a serialized remote call, and reading them synchronously handed
    // back promises (every row rendered its default). getSettingsSnapshot runs
    // the same getters engine-side and answers once.
    const snapshot = (await store.getSettingsSnapshot?.({ heavy: !heavyCache })) || {};
    const autoClear = snapshot.autoClear || {};
    const compaction = snapshot.compaction || {};
    const recap = snapshot.recap || { enabled: true };
    const toolModules = snapshot.toolModules || {};
    const webSearchOn = toolModules.webSearch?.enabled !== false;
    const memoryToolsOn = toolModules.memory?.enabled !== false;
    const systemShell = snapshot.systemShell || { source: 'auto', command: '', effective: '' };
    const outputStyle = snapshot.outputStyle || {};
    const workflow = state.workflow || {};
    const mcp = heavyCache ? heavyCache.mcp : (snapshot.mcp || { connectedCount: 0, configuredCount: 0, failedCount: 0 });
    const hooks = heavyCache ? heavyCache.hooks : (snapshot.hooks || { ruleCount: 0 });
    const plugins = heavyCache ? heavyCache.plugins : (snapshot.plugins || { count: 0 });
    const skills = heavyCache ? heavyCache.skills : (snapshot.skills || { count: 0 });
    // Refresh the cache every build (light or full) so the next light
    // refresh reuses whatever was most recently known.
    settingsHeavyCacheRef.current = { mcp, hooks, plugins, skills };
    const compactTypeLabel = 'Fast-track (fixed)';
    const outputStyleLabel = outputStyle?.current?.label || outputStyle?.current?.id || outputStyle?.configured || 'Default';
    const workflowLabel = workflowDisplayName(workflow);
    const boolLabel = (enabled) => enabled ? 'On' : 'Off';
    const compactTypeDescription = 'Uses Memory recall to rebuild context faster on large histories.';
    // Post-write refresh, bound to the claim AT ACTION TIME. Esc only
    // invalidates builds that already exist, so a write settling afterwards
    // would otherwise take a fresh generation and re-open the panel the user
    // just closed. Called while BUILDING each chain, so the binding happens on
    // the user's keypress, not on the ack.
    const deferredSettingsRefresh = () => own.defer(() => refreshSettings());
    const applyAutoClear = (patch = {}) => {
      void Promise.resolve(store.setAutoClear?.(patch))
        .then((next) => {
          if (!next) store.pushNotice('autoclear unavailable', 'warn');
          else store.pushNotice(next.enabled ? `Auto-clear on · idle ${formatDuration(next.idleMs)}` : 'Auto-clear off', 'info');
        })
        .catch((e) => store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error'))
        .finally(deferredSettingsRefresh());
    };
    // On/Off toggle only — idle-window override lives in the Advanced picker
    // (openAutoClearPicker), opened via Enter on this row.
    const autoClearEnabled = autoClear.enabled !== false;
    const toggleAutoClear = () => applyAutoClear({ enabled: !autoClearEnabled });
    const applyCompaction = (patch = {}) => {
      void Promise.resolve(store.setCompactionSettings?.(patch))
        .then((next) => {
          if (!next) {
            store.pushNotice('compaction setting is busy', 'warn');
            return;
          }
          store.pushNotice(`Compaction ${next.auto !== false ? 'auto on' : 'auto off'} · ${next.compactType === 'recall-fasttrack' ? 'Fast-track' : 'Default'}`, 'info');
        })
        .catch((e) => store.pushNotice(`compaction failed: ${e?.message || e}`, 'error'))
        .finally(deferredSettingsRefresh());
    };
    // Voice toggle (moved from the retired Channels cluster): enabling
    // installs the managed whisper/ffmpeg runtime first time, then flips
    // voice.enabled. toggleVoice owns all notices/progress.
    const applyVoice = () => {
      if (isVoiceInstallBusy()) {
        store.pushNotice('Voice install is already running', 'warn');
        return;
      }
      void Promise.resolve(toggleVoice({ pushNotice: store.pushNotice, setProgressHint: store.setProgressHint }))
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
    const toggleWebSearch = () => applyToolModule('Web search', store.setWebSearchEnabled, !webSearchOn);
    const toggleMemory = () => applyToolModule('Memory', store.setMemoryToolsEnabled, !memoryToolsOn);
    const toggleMemoryCycles = () => {
      const enabled = !(recap.enabled !== false);
      void Promise.resolve(store.setRecapEnabled?.(enabled))
        .then((next) => {
          if (!next) store.pushNotice('Memory cycles setting is busy', 'warn');
          else store.pushNotice(`Memory cycles ${enabled ? 'on' : 'off'}`, 'info');
        })
        .catch((e) => store.pushNotice(`Memory cycles setting failed: ${e?.message || e}`, 'error'))
        .finally(deferredSettingsRefresh());
    };
    const cycleOutputStyle = async (direction = 1) => {
      // Epoch captured on the KEYPRESS, BEFORE the listOutputStyles preflight:
      // taking it after that await would bind to whatever surface the user
      // moved to meanwhile, and the refresh would re-open Settings over it.
      const settled = deferredSettingsRefresh();
      let status = null;
      try { status = (await store.listOutputStyles?.()) || null; } catch (e) {
        store.pushNotice(`could not list output styles: ${e?.message || e}`, 'error');
        return;
      }
      const styles = Array.isArray(status?.styles) ? status.styles : [];
      if (!styles.length) {
        store.pushNotice('no output styles available', 'warn');
        return;
      }
      const currentId = status?.current?.id || 'default';
      const currentIndex = Math.max(0, styles.findIndex((style) => style.id === currentId));
      const next = styles[(currentIndex + direction + styles.length) % styles.length];
      void store.setOutputStyle?.(next.id)
        .then((result) => {
          if (!result) {
            store.pushNotice('Output style switch is already running.', 'warn');
            return;
          }
          store.pushNotice(outputStyleNotice(result), 'info');
        })
        .catch((e) => store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error'))
        .finally(settled);
    };
    const cycleWorkflow = async (direction = 1) => {
      // Same as cycleOutputStyle: the epoch belongs to the keypress, not to the
      // listWorkflows ack that lands after the user may have closed Settings.
      const settled = deferredSettingsRefresh();
      let workflows = [];
      try { workflows = (await store.listWorkflows?.()) || []; } catch (e) {
        store.pushNotice(`could not list workflows: ${e?.message || e}`, 'error');
        return;
      }
      if (!workflows.length) {
        store.pushNotice('no workflows available', 'warn');
        return;
      }
      const activeIndex = workflows.findIndex((item) => item.active);
      const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, workflows.findIndex((item) => item.id === workflow.id));
      const next = workflows[(currentIndex + direction + workflows.length) % workflows.length];
      void store.setWorkflow?.(next.id)
        .then((result) => {
          if (!result) {
            store.pushNotice('Workflow switch is already running.', 'warn');
            return;
          }
          store.pushNotice(workflowSwitchNotice(result), 'info');
        })
        .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'))
        .finally(settled);
    };
    const cycleTheme = (direction = 1) => {
      let themes = [];
      try { themes = store.listThemes?.() || []; } catch (e) {
        store.pushNotice(`could not list themes: ${e?.message || e}`, 'error');
        return;
      }
      if (!themes.length) {
        store.pushNotice('no themes available', 'warn');
        return;
      }
      const currentId = store.getTheme?.() || themes.find((t) => t.current)?.id || themes[0]?.id;
      const currentIndex = Math.max(0, themes.findIndex((t) => t.id === currentId));
      const next = themes[(currentIndex + direction + themes.length) % themes.length];
      try {
        const applied = store.setTheme?.(next.id, { persist: true });
        store.pushNotice(themeNotice(applied || next), 'info');
      } catch (e) {
        store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
      }
      refreshSettings();
    };
    // Row order groups by concern — routing/model first, then session
    // behavior, integrations, voice, system — and must stay in
    // sync with desktop SETTINGS_ITEMS (tui-parity test, minus system-shell).
    const items = [
      {
        value: 'model',
        label: 'Model',
        meta: displayModelName(state.model, state.provider),
        description: 'Main chat model.',
        _action: 'model',
      },
      {
        value: 'websearch',
        label: 'Web search model',
        // From the one-shot snapshot: a direct getWebSearchRoute() here is an
        // unresolved promise on a daemon-backed store, so the row rendered
        // its "(unset)" default for every configured route.
        meta: routeModelLabel(snapshot.webSearchRoute || null),
        description: 'Native web-search model.',
        _action: 'websearch',
      },
      {
        value: 'workflow',
        label: 'Workflow',
        meta: workflowLabel,
        description: 'Active agent routing profile.',
        _action: 'workflow',
      },
      {
        value: 'output-style',
        label: 'Output style',
        meta: outputStyleLabel,
        description: 'Response tone and format.',
        _action: 'output-style',
      },
      {
        value: 'profile',
        label: 'Profile',
        meta: (() => {
          // From the one-shot snapshot: a direct getProfile() here would be an
          // extra (promise-shaped) round-trip per row build.
          const p = snapshot.profile;
          const lang = p?.languageEntry?.label || 'System';
          const experience = p?.experienceLevelEntry?.label || '';
          return [p?.title, experience, lang].filter(Boolean).join(' · ');
        })(),
        description: 'Your title, development experience, and response language.',
        _action: 'profile',
      },
      {
        value: 'theme',
        label: 'Theme',
        meta: (() => {
          try {
            const id = store.getTheme?.();
            const entry = (store.listThemes?.() || []).find((t) => t.id === id);
            return entry?.label || id || 'Default';
          } catch { return 'Default'; }
        })(),
        description: 'TUI color theme.',
        _action: 'theme',
      },
      {
        value: 'web-search-enabled',
        label: 'Web search',
        meta: boolLabel(webSearchOn),
        description: 'Expose web search and fetch tools to new sessions.',
        _action: 'web-search-enabled',
      },
      {
        value: 'memory-enabled',
        label: 'Memory',
        meta: boolLabel(memoryToolsOn),
        description: 'Memory and recall tools plus core-memory injection for new sessions.',
        _action: 'memory-enabled',
      },
      {
        value: 'autocompact',
        label: 'Auto-compact',
        meta: boolLabel(compaction.auto !== false),
        description: 'Compact when context is high.',
        _action: 'autocompact',
      },
      {
        value: 'compact-type',
        label: 'Compact type',
        meta: compactTypeLabel,
        description: compactTypeDescription,
        _action: null,
      },
      {
        value: 'autoclear',
        label: 'Auto-clear',
        meta: autoClearEnabled ? `On (${formatDuration(autoClear.idleMs)})` : 'Off',
        description: autoClearEnabled
          ? `Clear idle sessions after ${formatDuration(autoClear.idleMs)}${autoClear.custom ? '' : ` (${autoClear.provider || 'default'} default)`}. Enter for options.`
          : 'Idle auto-clear disabled. Enter for options.',
        _action: 'autoclear',
      },
      {
        value: 'memory-cycles',
        label: 'Memory cycles',
        meta: boolLabel(recap.enabled !== false),
        description: recap.enabled === false
          ? 'Background cycles off. Recall and manual core memory stay available.'
          : 'Background memory cycles and model memory writes.',
        _action: 'memory-cycles',
      },
      {
        value: 'memory',
        label: 'Core memories',
        description: 'List and edit user-curated core memories.',
        _action: 'memory',
      },
      {
        value: 'providers',
        label: 'Providers',
        description: 'Auth, API keys, OAuth, local.',
        _action: 'providers',
      },
      {
        value: 'mcp',
        label: 'MCP servers',
        description: `${mcp.connectedCount || 0}/${mcp.configuredCount || 0} connected${mcp.failedCount ? ` · ${mcp.failedCount} failed` : ''}`,
        _action: 'mcp',
      },
      {
        value: 'plugins',
        label: 'Plugins',
        description: `${plugins.count || 0} detected`,
        _action: 'plugins',
      },
      {
        value: 'hooks',
        label: 'Hooks',
        description: `${hooks.ruleCount || 0} before-tool rules`,
        _action: 'hooks',
      },
      {
        value: 'skills',
        label: 'Skills',
        description: `${skills.count || 0} available`,
        _action: 'skills',
      },
      {
        value: 'voice',
        label: 'Voice',
        meta: boolLabel(isVoiceEnabled()),
        description: 'Transcribe voice input (managed Whisper runtime).',
        _action: 'voice',
      },
      {
        value: 'system-shell',
        label: 'System shell',
        meta: systemShell.command || 'Auto',
        description: systemShell.effective
          ? `Effective command: ${systemShell.effective}`
          : 'Use the platform default shell command.',
        _action: 'system-shell',
      },
      {
        value: 'update',
        label: 'Update',
        meta: (() => {
          const upd = snapshot.updateSettings || {};
          const current = upd.currentVersion || 'unknown';
          if (upd.updateAvailable && upd.latestVersion) return `${current} → ${upd.latestVersion}`;
          if (!upd.currentVersion) return 'unknown';
          return `${current} (latest)`;
        })(),
        description: 'Check version and update mixdog.',
        _action: 'update',
      },
    ];
    // A superseded build (newer open/refresh) or one whose panel was already
    // closed with Esc must never paint or clear prompts.
    if (!isCurrentSettingsRequest(requestId)) return;
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint({
      title: 'Settings',
      description: 'Runtime, model, tools, and integrations.',
      help: '↑/↓ Select · ←/→ Change · Enter Open/Toggle · Esc Close',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 18,
      items,
      initialIndex: opts.focus ? Math.max(0, items.findIndex((item) => item.value === opts.focus)) : undefined,
      onLeft: (item) => {
        if (item?._action === 'autoclear') toggleAutoClear();
        else if (item?._action === 'autocompact') applyCompaction({ auto: !(compaction.auto !== false) });
        else if (item?._action === 'web-search-enabled') toggleWebSearch();
        else if (item?._action === 'memory-enabled') toggleMemory();
        else if (item?._action === 'memory-cycles') toggleMemoryCycles();
        else if (item?._action === 'voice') applyVoice();
        else if (item?._action === 'output-style') cycleOutputStyle(-1);
        else if (item?._action === 'theme') cycleTheme(-1);
        else if (item?._action === 'workflow') cycleWorkflow(-1);
      },
      onRight: (item) => {
        if (item?._action === 'autoclear') toggleAutoClear();
        else if (item?._action === 'autocompact') applyCompaction({ auto: !(compaction.auto !== false) });
        else if (item?._action === 'web-search-enabled') toggleWebSearch();
        else if (item?._action === 'memory-enabled') toggleMemory();
        else if (item?._action === 'memory-cycles') toggleMemoryCycles();
        else if (item?._action === 'voice') applyVoice();
        else if (item?._action === 'output-style') cycleOutputStyle(1);
        else if (item?._action === 'theme') cycleTheme(1);
        else if (item?._action === 'workflow') cycleWorkflow(1);
      },
      onSelect: (_value, item) => {
        if (item._action === 'autoclear') openAutoClearPicker({ returnTo: openSettingsPicker });
        else if (item._action === 'profile') openProfilePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'autocompact') applyCompaction({ auto: !(compaction.auto !== false) });
        else if (item._action === 'web-search-enabled') toggleWebSearch();
        else if (item._action === 'memory-enabled') toggleMemory();
        else if (item._action === 'memory-cycles') toggleMemoryCycles();
        else if (item._action === 'voice') applyVoice();
        else if (item._action === 'output-style') openOutputStylePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'theme') openThemePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'workflow') openWorkflowPicker({ returnTo: openSettingsPicker });
        else if (item._action === 'model') openModelPicker({
          returnTo: openSettingsPicker,
          returnLabel: 'Settings',
          returnOnNestedCancel: true,
          onAfterSelect: openSettingsPicker,
        });
        else if (item._action === 'websearch') openWebSearchPicker({
          returnTo: openSettingsPicker,
          returnLabel: 'Settings',
          returnOnNestedCancel: true,
        });
        else if (item._action === 'providers') void openProviderSetupPicker({
          returnTo: openSettingsPicker,
          onCancel: openSettingsPicker,
          continueLabel: 'Back to settings',
          continueDescription: 'return to settings',
        });
        else if (item._action === 'mcp') openMcpPicker();
        else if (item._action === 'plugins') openPluginsPicker();
        else if (item._action === 'hooks') openHooksPicker();
        else if (item._action === 'skills') openSkillsPicker();
        else if (item._action === 'memory') openMemoryCorePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'system-shell') {
          own.close();
          setSettingsPrompt({
            kind: 'system-shell',
            label: 'System shell',
            hint: 'Enter a shell command, or leave empty for automatic selection. Windows accepts powershell.exe or pwsh.',
            initialValue: systemShell.command || '',
          });
        }
        else if (item._action === 'update') openUpdatePicker({ returnTo: openSettingsPicker });
      },
      onCancel: () => {
        // Invalidate in-flight builds: Esc must win over a slow snapshot.
        nextSettingsRequest();
        own.close();
      },
    });
  };

  // Public entry point. NEVER rejects: callers fire it detached
  // (`void openSettingsPicker({ light: true })`, returnTo/onCancel handlers),
  // so a failed daemon read must surface as a notice, not as a fatal
  // unhandled rejection.
  const openSettingsPicker = async (opts = {}) => {
    const requestId = nextSettingsRequest();
    try {
      await buildSettingsPicker(opts, requestId);
    } catch (error) {
      store.pushNotice(`settings unavailable: ${error?.message || error}`, 'error');
    }
  };
  const refreshSettings = () => { void openSettingsPicker({ light: true }); };

  return { openSettingsPicker };
}
