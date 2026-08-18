export type SettingsItemKind = 'toggle' | 'cycle' | 'open' | 'static';

export interface SettingsItem {
  value: string;
  label: string;
  description: string;
  kind: SettingsItemKind;
}

export const SETTINGS_ITEMS = [
  { value: 'model', label: 'Model', description: 'Main chat model.', kind: 'open' },
  { value: 'search', label: 'Search model', description: 'Native search model.', kind: 'open' },
  // The workflow editor graduated to the main-pane Workflows page (sidebar →
  // Workflows). The item stays only so the /workflow slash command keeps its
  // SettingsSection type; App.openSettings reroutes it to the page.
  { value: 'workflow', label: 'Workflow', description: 'Active agent routing profile.', kind: 'open' },
  { value: 'output-style', label: 'Output style', description: 'Response tone and format.', kind: 'open' },
  { value: 'profile', label: 'Profile', description: 'Your title and response language.', kind: 'open' },
  { value: 'theme', label: 'Theme', description: 'TUI color theme.', kind: 'open' },
  { value: 'web-search-enabled', label: 'Web search', description: 'Expose web search and fetch tools to new sessions.', kind: 'toggle' },
  { value: 'memory-enabled', label: 'Memory', description: 'Memory tools, core-memory injection, and background upkeep.', kind: 'toggle' },
  { value: 'autocompact', label: 'Auto-compact', description: 'Compact when context is high.', kind: 'toggle' },
  { value: 'compact-type', label: 'Compact type', description: 'Uses Memory recall to rebuild context faster on large histories.', kind: 'static' },
  { value: 'autoclear', label: 'Auto-clear', description: 'Idle auto-clear disabled. Enter for options.', kind: 'toggle' },
  { value: 'providers', label: 'Providers', description: 'Auth, API keys, OAuth, local.', kind: 'open' },
  { value: 'mcp', label: 'MCP servers', description: '0/0 connected', kind: 'open' },
  { value: 'plugins', label: 'Plugins', description: '0 detected', kind: 'open' },
  { value: 'hooks', label: 'Hooks', description: '0 before-tool rules', kind: 'open' },
  { value: 'skills', label: 'Skills', description: '0 available', kind: 'open' },
  // Voice transcription graduated from the retired Channels page into General
  // (user: 음성전사만 일반으로): the managed Whisper runtime powers voice input.
  { value: 'voice', label: 'Voice transcription', description: 'Managed Whisper runtime for voice input.', kind: 'open' },
  // 'system-shell' stays TUI-only: the desktop hides the override (user
  // decision — automatic platform selection is the only sensible desktop
  // default; the shared config key remains editable from the TUI).
  { value: 'update', label: 'Update', description: 'Check version and update mixdog.', kind: 'open' },
] as const satisfies ReadonlyArray<SettingsItem>;

export type SettingsItemValue = typeof SETTINGS_ITEMS[number]['value'];

export type SettingsCategory =
  | 'general' | 'context' | 'output-style'
  | 'providers' | 'git' | 'connection' | 'mcp' | 'plugins' | 'hooks' | 'skills'
  | 'system' | 'shortcuts' | 'about';

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
    items: ['profile', 'theme', 'web-search-enabled', 'memory-enabled', 'voice'],
  },
  // Context owns session lifecycle. The Memory master itself lives once in
  // General; curated memories are managed with their project.
  {
    value: 'context',
    label: 'Context',
    group: 'Mixdog',
    items: ['autocompact', 'compact-type', 'autoclear'],
  },
  {
    value: 'providers',
    label: 'Providers',
    group: 'Integrations',
    items: ['providers'],
  },
  // Desktop-only surface: GitHub CLI integration, the commit message
  // template, and the global git identity (Settings → Git).
  {
    value: 'git',
    label: 'Git',
    group: 'Integrations',
    items: [],
  },
  {
    value: 'skills',
    label: 'Skills',
    group: 'Integrations',
    items: ['skills'],
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
    value: 'output-style',
    label: 'Output style',
    group: 'Mixdog',
    items: ['output-style'],
  },
  {
    value: 'hooks',
    label: 'Hooks',
    group: 'Integrations',
    items: ['hooks'],
  },
  {
    value: 'system',
    label: 'System',
    group: 'Support',
    items: ['update'],
  },
  // Desktop-only surface (no TUI settings-item counterpart): a read-only
  // keybind reference for the workspace shortcuts.
  {
    value: 'shortcuts',
    label: 'Shortcuts',
    group: 'Support',
    items: [],
  },
  // Desktop-only surface: web-app pairing (QR and bridge status).
  {
    value: 'connection',
    label: 'Connection',
    group: 'Integrations',
    items: [],
  },
  // Desktop-only surface: repo/star/sponsor links (Settings → About).
  {
    value: 'about',
    label: 'About',
    group: 'Support',
    items: [],
  },
] as const satisfies ReadonlyArray<SettingsCategoryItem>;

const REMOTE_HIDDEN_SETTINGS_CATEGORIES = new Set<SettingsCategory>([
  'providers',
]);
const REMOTE_SETTINGS_CATEGORIES = SETTINGS_CATEGORIES.filter(
  (category) => !REMOTE_HIDDEN_SETTINGS_CATEGORIES.has(category.value),
);

export function categoryForSettingsItem(value: SettingsItemValue): SettingsCategory {
  return SETTINGS_CATEGORIES.find((category) =>
    (category.items as readonly SettingsItemValue[]).includes(value))?.value || 'general';
}

export function settingsCategoryForSurface(
  category: SettingsCategory,
  remote: boolean,
): SettingsCategory {
  return remote && REMOTE_HIDDEN_SETTINGS_CATEGORIES.has(category) ? 'general' : category;
}

export function settingsCategoriesForSurface(remote: boolean): ReadonlyArray<SettingsCategoryItem> {
  return remote ? REMOTE_SETTINGS_CATEGORIES : SETTINGS_CATEGORIES;
}
