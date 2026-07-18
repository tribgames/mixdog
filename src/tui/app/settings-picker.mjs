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

export function createSettingsPicker({
  store,
  state,
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  settingsHeavyCacheRef,
  formatDuration,
  displayModelName,
  routeModelLabel,
  workflowDisplayName,
  workflowSwitchNotice,
  themeNotice,
  openModelPicker,
  openSearchPicker,
  openAgentsPicker,
  openWorkflowPicker,
  openOutputStylePicker,
  openBridgePicker,
  openToolsPicker,
  openProviderSetupPicker,
  openThemePicker,
  openAutoClearPicker,
  openProfilePicker,
  openMcpPicker,
  openPluginsPicker,
  openHooksPicker,
  openSkillsPicker,
  openUpdatePicker,
  openChannelSettingTypePicker,
}) {
  const openSettingsPicker = async (opts = {}) => {
    const light = opts.light === true;
    const overrides = opts.overrides || null;
    const heavyCache = light ? settingsHeavyCacheRef.current : null;
    const autoClear = store.getAutoClear?.() || {};
    const compaction = store.getCompactionSettings?.() || {};
    const memory = store.getMemorySettings?.() || { enabled: true };
    const channels = store.getChannelSettings?.({ includeStatus: false }) || { enabled: true };
    const systemShell = store.getSystemShell?.() || { source: 'auto', command: '', effective: '' };
    const outputStyle = store.getOutputStyle?.() || store.listOutputStyles?.() || {};
    const workflow = state.workflow || {};
    const mcp = heavyCache ? heavyCache.mcp : (store.mcpStatus?.() || { connectedCount: 0, configuredCount: 0, failedCount: 0 });
    const hooks = heavyCache ? heavyCache.hooks : (store.hooksStatus?.() || { ruleCount: 0 });
    const plugins = heavyCache ? heavyCache.plugins : (store.pluginsStatus?.() || { count: 0 });
    const skills = heavyCache ? heavyCache.skills : (store.skillsStatus?.() || { count: 0 });
    const channelWorker = store.getChannelWorkerStatus?.();
    let channelBackend = 'discord';
    if (heavyCache) {
      channelBackend = heavyCache.channelBackend || 'discord';
    } else {
      try {
        channelBackend = (await store.getChannelSetup?.())?.backend || 'discord';
      } catch {
        channelBackend = 'discord';
      }
    }
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'channelBackend')) {
      channelBackend = overrides.channelBackend;
    }
    // Refresh the cache every build (light or full) so the next light
    // refresh reuses whatever was most recently known, and so an
    // optimistic override (e.g. channel backend cycle) sticks without
    // re-running the heavy getter it came from.
    settingsHeavyCacheRef.current = { mcp, hooks, plugins, skills, channelBackend };
    const channelBackendLabel = channelBackend === 'telegram' ? 'Telegram' : 'Discord';
    const remoteEnabled = store.isRemoteEnabled?.() === true;
    const remoteRuntimeDescription = channelWorker?.running
      ? `runtime running · pid ${channelWorker.pid}`
      : 'runtime stopped';
    const compactType = compaction.compactType || compaction.type || 'semantic';
    const compactTypeLabel = 'Fast-track (fixed)';
    const outputStyleLabel = outputStyle?.current?.label || outputStyle?.current?.id || outputStyle?.configured || 'Default';
    const workflowLabel = workflowDisplayName(workflow);
    const boolLabel = (enabled) => enabled ? 'On' : 'Off';
    const compactTypeDescription = memory.enabled === false
      ? 'Injects raw transcript lines (memory off: no LLM chunking).'
      : 'Uses Memory recall to rebuild context faster on large histories.';
    const applyAutoClear = (patch = {}) => {
      try {
        const next = store.setAutoClear?.(patch);
        if (!next) store.pushNotice('autoclear unavailable', 'warn');
        else store.pushNotice(next.enabled ? `Auto-clear on · idle ${formatDuration(next.idleMs)}` : 'Auto-clear off', 'info');
      } catch (e) {
        store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error');
      }
      openSettingsPicker({ light: true });
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
        .finally(() => openSettingsPicker({ light: true }));
    };
    const applyChannels = (enabled) => {
      void Promise.resolve(store.setChannelsEnabled?.(enabled))
        .then((next) => {
          if (!next) {
            store.pushNotice('channel setting is busy', 'warn');
            return;
          }
          store.pushNotice(`Channels ${next.enabled ? 'on' : 'off'}`, 'info');
        })
        .catch((e) => store.pushNotice(`channel setting failed: ${e?.message || e}`, 'error'))
        .finally(() => openSettingsPicker({ light: true }));
    };
    const cycleOutputStyle = (direction = 1) => {
      let status = null;
      try { status = store.listOutputStyles?.() || null; } catch (e) {
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
        .finally(() => openSettingsPicker({ light: true }));
    };
    const cycleWorkflow = (direction = 1) => {
      let workflows = [];
      try { workflows = store.listWorkflows?.() || []; } catch (e) {
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
        .finally(() => openSettingsPicker({ light: true }));
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
      openSettingsPicker({ light: true });
    };
    const applyRemoteRuntime = () => {
      const enabled = store.toggleRemote?.() === true;
      store.pushNotice(enabled ? 'Remote mode ON' : 'Remote mode OFF', 'info');
      openSettingsPicker({ light: true });
    };
    const cycleChannelBackend = (direction = 1) => {
      const backends = ['discord', 'telegram'];
      const currentIndex = Math.max(0, backends.indexOf(channelBackend));
      const chosen = backends[(currentIndex + direction + backends.length) % backends.length];
      if (chosen === channelBackend) {
        openSettingsPicker({ light: true, overrides: { channelBackend } });
        return;
      }
      try {
        store.setBackend(chosen);
        const label = chosen === 'telegram' ? 'Telegram' : 'Discord';
        const restartHint = (store.isRemoteEnabled?.() === true || channelWorker?.running)
          ? `Channel set to ${label}. Restart remote to apply.`
          : `Channel set to ${label}.`;
        store.pushNotice(restartHint, 'info');
      } catch (e) {
        store.pushNotice(`channel backend failed: ${e?.message || e}`, 'error');
      }
      openSettingsPicker({ light: true, overrides: { channelBackend: chosen } });
    };
    const items = [
      {
        value: 'profile',
        label: 'Profile',
        meta: (() => {
          try {
            const p = store.getProfile?.();
            const lang = p?.languageEntry?.label || 'System';
            return p?.title ? `${p.title} · ${lang}` : lang;
          } catch { return 'System'; }
        })(),
        description: 'Your title and response language.',
        _action: 'profile',
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
        value: 'channels',
        label: 'Channels enabled',
        meta: boolLabel(channels.enabled !== false),
        description: channels.enabled === false
          ? 'Channel tools disabled.'
          : 'Discord, schedules, and webhooks.',
        _action: 'channels',
      },
      {
        value: 'remote-runtime',
        label: 'Remote Runtime',
        meta: boolLabel(remoteEnabled),
        description: remoteRuntimeDescription,
        _action: 'remote-runtime',
      },
      {
        value: 'channel-backend',
        label: 'Channel',
        meta: channelBackendLabel,
        description: 'Left/Right or Enter changes channel type (Discord or Telegram).',
        _action: 'channel-backend',
      },
      {
        value: 'channel-setting',
        label: 'Setting',
        description: 'Configure credentials and main channel/chat for the active type.',
        _action: 'channel-setting',
      },
      {
        value: 'output-style',
        label: 'Output style',
        meta: outputStyleLabel,
        description: 'Response tone and format.',
        _action: 'output-style',
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
        value: 'workflow',
        label: 'Workflow',
        meta: workflowLabel,
        description: 'Active agent routing profile.',
        _action: 'workflow',
      },
      {
        value: 'model',
        label: 'Model',
        meta: displayModelName(state.model, state.provider),
        description: 'Main chat model.',
        _action: 'model',
      },
      {
        value: 'search',
        label: 'Search model',
        meta: routeModelLabel(store.getSearchRoute?.()),
        description: 'Native search model.',
        _action: 'search',
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
          try {
            const upd = store.getUpdateSettings?.() || {};
            const current = upd.currentVersion || 'unknown';
            if (upd.updateAvailable && upd.latestVersion) return `${current} → ${upd.latestVersion}`;
            if (!upd.currentVersion) return 'unknown';
            return `${current} (latest)`;
          } catch { return 'unknown'; }
        })(),
        description: 'Check version and update mixdog.',
        _action: 'update',
      },
    ];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
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
        else if (item?._action === 'compact-type') {
          const nextType = compactType === 'recall-fasttrack' ? 'semantic' : 'recall-fasttrack';
          applyCompaction({ compactType: nextType });
        }
        else if (item?._action === 'channels') applyChannels(!(channels.enabled !== false));
        else if (item?._action === 'remote-runtime') applyRemoteRuntime();
        else if (item?._action === 'channel-backend') cycleChannelBackend(-1);
        else if (item?._action === 'output-style') cycleOutputStyle(-1);
        else if (item?._action === 'theme') cycleTheme(-1);
        else if (item?._action === 'workflow') cycleWorkflow(-1);
      },
      onRight: (item) => {
        if (item?._action === 'autoclear') toggleAutoClear();
        else if (item?._action === 'autocompact') applyCompaction({ auto: !(compaction.auto !== false) });
        else if (item?._action === 'compact-type') {
          const nextType = compactType === 'recall-fasttrack' ? 'semantic' : 'recall-fasttrack';
          applyCompaction({ compactType: nextType });
        }
        else if (item?._action === 'channels') applyChannels(!(channels.enabled !== false));
        else if (item?._action === 'remote-runtime') applyRemoteRuntime();
        else if (item?._action === 'channel-backend') cycleChannelBackend(1);
        else if (item?._action === 'output-style') cycleOutputStyle(1);
        else if (item?._action === 'theme') cycleTheme(1);
        else if (item?._action === 'workflow') cycleWorkflow(1);
      },
      onSelect: (_value, item) => {
        if (item._action === 'autoclear') openAutoClearPicker({ returnTo: openSettingsPicker });
        else if (item._action === 'profile') openProfilePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'autocompact') applyCompaction({ auto: !(compaction.auto !== false) });
        else if (item._action === 'compact-type') {
          const nextType = compactType === 'recall-fasttrack' ? 'semantic' : 'recall-fasttrack';
          applyCompaction({ compactType: nextType });
        }
        else if (item._action === 'channels') applyChannels(!(channels.enabled !== false));
        else if (item._action === 'remote-runtime') applyRemoteRuntime();
        else if (item._action === 'channel-backend') cycleChannelBackend(1);
        else if (item._action === 'channel-setting') openChannelSettingTypePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'output-style') openOutputStylePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'theme') openThemePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'workflow') openWorkflowPicker({ returnTo: openSettingsPicker });
        else if (item._action === 'model') openModelPicker({
          returnTo: openSettingsPicker,
          returnLabel: 'Settings',
          returnOnNestedCancel: true,
          onAfterSelect: openSettingsPicker,
        });
        else if (item._action === 'search') openSearchPicker({
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
        else if (item._action === 'system-shell') {
          setPicker(null);
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
        setPicker(null);
      },
    });
  };

  return { openSettingsPicker };
}
