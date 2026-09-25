// settings-picker/settings-rows.mjs
// The Settings rows built from one settings snapshot. Row order groups by
// concern — routing/model first, then session behavior, integrations, voice,
// system — and must stay in sync with desktop SETTINGS_ITEMS (tui-parity
// test, minus system-shell).
import { isVoiceEnabled } from '../../lib/voice-setup.mjs';

const boolLabel = (enabled) => (enabled ? 'On' : 'Off');

const profileMeta = (profile) => {
  // From the one-shot snapshot: a direct getProfile() here would be an
  // extra (promise-shaped) round-trip per row build.
  const lang = profile?.languageEntry?.label || 'System';
  const experience = profile?.experienceLevelEntry?.label || '';
  return [profile?.title, experience, lang].filter(Boolean).join(' · ');
};

const themeMeta = (store) => {
  try {
    const id = store.getTheme?.();
    const entry = (store.listThemes?.() || []).find((t) => t.id === id);
    return entry?.label || id || 'Default';
  } catch {
    return 'Default';
  }
};

const updateMeta = (upd = {}) => {
  const current = upd.currentVersion || 'unknown';
  if (upd.updateAvailable && upd.latestVersion) return `${current} → ${upd.latestVersion}`;
  if (!upd.currentVersion) return 'unknown';
  return `${current} (latest)`;
};

/** What one Settings build reads from the snapshot (and the heavy cache on a
 *  light refresh): the values every row and toggle works from. */
export function readSettingsView({ snapshot, heavyCache, state }) {
  const autoClear = snapshot.autoClear || {};
  const toolModules = snapshot.toolModules || {};
  return {
    autoClear,
    autoClearEnabled: autoClear.enabled !== false,
    compaction: snapshot.compaction || {},
    webSearchOn: toolModules.webSearch?.enabled !== false,
    memoryToolsOn: toolModules.memory?.enabled !== false,
    systemShell: snapshot.systemShell || { source: 'auto', command: '', effective: '' },
    outputStyle: snapshot.outputStyle || {},
    workflow: state.workflow || {},
    mcp: heavyCache ? heavyCache.mcp : snapshot.mcp || { connectedCount: 0, configuredCount: 0, failedCount: 0 },
    plugins: heavyCache ? heavyCache.plugins : snapshot.plugins || { count: 0 },
    skills: heavyCache ? heavyCache.skills : snapshot.skills || { count: 0 },
  };
}

export function buildSettingsItems({
  snapshot,
  view,
  state,
  store,
  formatDuration,
  displayModelName,
  routeModelLabel,
  workflowDisplayName,
}) {
  const { autoClear, autoClearEnabled, compaction, webSearchOn, memoryToolsOn, systemShell, outputStyle } = view;
  const { workflow, mcp, plugins, skills } = view;
  const outputStyleLabel =
    outputStyle?.current?.label || outputStyle?.current?.id || outputStyle?.configured || 'Default';
  const autoClearSource = autoClear.custom ? '' : ` (${autoClear.provider || 'default'} default)`;
  return [
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
      meta: workflowDisplayName(workflow),
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
      meta: profileMeta(snapshot.profile),
      description: 'Your title, development experience, and response language.',
      _action: 'profile',
    },
    {
      value: 'theme',
      label: 'Theme',
      meta: themeMeta(store),
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
      value: 'autoclear',
      label: 'Auto-clear',
      meta: autoClearEnabled ? `On (${formatDuration(autoClear.idleMs)})` : 'Off',
      description: autoClearEnabled
        ? `Clear idle sessions after ${formatDuration(autoClear.idleMs)}${autoClearSource}. Enter for options.`
        : 'Idle auto-clear disabled. Enter for options.',
      _action: 'autoclear',
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
      value: 'developer',
      label: 'Developer',
      description: 'Developer-only options.',
      _action: 'developer',
    },
    {
      value: 'update',
      label: 'Update',
      meta: updateMeta(snapshot.updateSettings),
      description: 'Check version and update mixdog.',
      _action: 'update',
    },
  ];
}
