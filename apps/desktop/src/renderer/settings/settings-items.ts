export type SettingsItemKind = 'toggle' | 'cycle' | 'open' | 'static';

export interface SettingsItem {
  value: string;
  label: string;
  description: string;
  kind: SettingsItemKind;
}

export const SETTINGS_ITEMS = [
  { value: 'profile', label: 'Profile', description: 'Your title and response language.', kind: 'open' },
  { value: 'autoclear', label: 'Auto-clear', description: 'Idle auto-clear disabled. Enter for options.', kind: 'toggle' },
  { value: 'autocompact', label: 'Auto-compact', description: 'Compact when context is high.', kind: 'toggle' },
  { value: 'compact-type', label: 'Compact type', description: 'Uses Memory recall to rebuild context faster on large histories.', kind: 'static' },
  { value: 'channels', label: 'Channels enabled', description: 'Discord, schedules, and webhooks.', kind: 'toggle' },
  { value: 'remote-runtime', label: 'Remote Runtime', description: 'runtime stopped', kind: 'toggle' },
  { value: 'channel-backend', label: 'Channel', description: 'Left/Right or Enter changes channel type (Discord or Telegram).', kind: 'cycle' },
  { value: 'channel-setting', label: 'Setting', description: 'Configure credentials and main channel/chat for the active type.', kind: 'open' },
  { value: 'output-style', label: 'Output style', description: 'Response tone and format.', kind: 'open' },
  { value: 'theme', label: 'Theme', description: 'TUI color theme.', kind: 'open' },
  { value: 'workflow', label: 'Workflow', description: 'Active agent routing profile.', kind: 'open' },
  { value: 'model', label: 'Model', description: 'Main chat model.', kind: 'open' },
  { value: 'search', label: 'Search model', description: 'Native search model.', kind: 'open' },
  { value: 'providers', label: 'Providers', description: 'Auth, API keys, OAuth, local.', kind: 'open' },
  { value: 'mcp', label: 'MCP servers', description: '0/0 connected', kind: 'open' },
  { value: 'plugins', label: 'Plugins', description: '0 detected', kind: 'open' },
  { value: 'hooks', label: 'Hooks', description: '0 before-tool rules', kind: 'open' },
  { value: 'skills', label: 'Skills', description: '0 available', kind: 'open' },
  // 'system-shell' stays TUI-only: the desktop hides the override (user
  // decision — automatic platform selection is the only sensible desktop
  // default; the shared config key remains editable from the TUI).
  { value: 'update', label: 'Update', description: 'Check version and update mixdog.', kind: 'open' },
] as const satisfies ReadonlyArray<SettingsItem>;

export type SettingsItemValue = typeof SETTINGS_ITEMS[number]['value'];

export type SettingsCategory =
  | 'general' | 'models' | 'workflows' | 'output-style'
  | 'providers' | 'channels' | 'connection' | 'mcp' | 'plugins' | 'hooks' | 'skills' | 'memory'
  | 'system' | 'shortcuts';

export interface SettingsCategoryItem {
  value: SettingsCategory;
  label: string;
  group: 'Mixdog' | 'Integrations' | 'Support';
  items: readonly SettingsItemValue[];
}

export const SETTINGS_CATEGORIES = [
  {
    value: 'general',
    label: 'General',
    group: 'Mixdog',
    items: ['profile', 'theme', 'autocompact', 'autoclear', 'compact-type'],
  },
  {
    value: 'models',
    label: 'Models',
    group: 'Mixdog',
    items: ['model', 'search'],
  },
  {
    value: 'workflows',
    label: 'Workflows',
    group: 'Mixdog',
    items: ['workflow'],
  },
  {
    value: 'output-style',
    label: 'Output style',
    group: 'Mixdog',
    items: ['output-style'],
  },
  {
    value: 'providers',
    label: 'Providers',
    group: 'Integrations',
    items: ['providers'],
  },
  {
    value: 'channels',
    label: 'Channels',
    group: 'Integrations',
    items: ['channels', 'channel-backend', 'channel-setting'],
  },
  // Desktop-only surface: phone pairing (QRs, APK, bridge status).
  {
    value: 'connection',
    label: 'Connection',
    group: 'Integrations',
    items: [],
  },
  {
    value: 'mcp',
    label: 'MCP',
    group: 'Integrations',
    items: ['mcp'],
  },
  {
    value: 'plugins',
    label: 'Plugins',
    group: 'Integrations',
    items: ['plugins'],
  },
  {
    value: 'hooks',
    label: 'Hooks',
    group: 'Integrations',
    items: ['hooks'],
  },
  {
    value: 'skills',
    label: 'Skills',
    group: 'Integrations',
    items: ['skills'],
  },
  {
    value: 'memory',
    label: 'Memory',
    group: 'Integrations',
    items: [],
  },
  {
    value: 'system',
    label: 'System',
    group: 'Support',
    items: ['remote-runtime', 'update'],
  },
  // Desktop-only surface (no TUI settings-item counterpart): a read-only
  // OpenCode-style keybind reference for the workspace shortcuts.
  {
    value: 'shortcuts',
    label: 'Shortcuts',
    group: 'Support',
    items: [],
  },
] as const satisfies ReadonlyArray<SettingsCategoryItem>;

export function categoryForSettingsItem(value: SettingsItemValue): SettingsCategory {
  return SETTINGS_CATEGORIES.find((category) =>
    (category.items as readonly SettingsItemValue[]).includes(value))?.value || 'general';
}
