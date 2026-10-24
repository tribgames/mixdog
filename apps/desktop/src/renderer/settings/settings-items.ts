type SettingsItemKind = 'toggle' | 'cycle' | 'open' | 'static';

interface SettingsItem {
  value: string;
  label: string;
  description: string;
  kind: SettingsItemKind;
}

export const SETTINGS_ITEMS = [
  { value: 'model', label: 'Model', description: 'Main chat model.', kind: 'open' },
  { value: 'websearch', label: 'Web search model', description: 'Native web-search model.', kind: 'open' },
  // The workflow editor graduated to the main-pane Workflows page (sidebar →
  // Workflows). The item stays only so the /workflow slash command keeps its
  // SettingsSection type; App.openSettings reroutes it to the page.
  { value: 'workflow', label: 'Workflow', description: 'Active agent routing profile.', kind: 'open' },
  { value: 'output-style', label: 'Output style', description: 'Response tone and format.', kind: 'open' },
  { value: 'profile', label: 'Profile', description: 'Your title and response language.', kind: 'open' },
  { value: 'theme', label: 'Theme', description: 'App color theme.', kind: 'open' },
  {
    value: 'web-search-enabled',
    label: 'Web search',
    description: 'Expose web search and fetch tools to new sessions.',
    kind: 'toggle',
  },
  {
    value: 'link-preview',
    label: 'Link preview',
    description: 'Open chat links in a preview tab that the next link replaces.',
    kind: 'toggle',
  },
  {
    value: 'memory-enabled',
    label: 'Memory',
    description: 'Memory tools, core-memory injection, and background upkeep.',
    kind: 'toggle',
  },
  { value: 'autocompact', label: 'Auto-compact', description: 'Compact when context is high.', kind: 'toggle' },
  {
    value: 'autoclear',
    label: 'Auto-clear',
    description: 'Idle auto-clear disabled. Enter for options.',
    kind: 'toggle',
  },
  { value: 'providers', label: 'Providers', description: 'Auth, API keys, OAuth, local.', kind: 'open' },
  {
    value: 'model-management',
    label: 'Model management',
    description: 'Models shown in /model and favorites.',
    kind: 'open',
  },
  { value: 'mcp', label: 'MCP servers', description: '0/0 connected', kind: 'open' },
  { value: 'plugins', label: 'Plugins', description: '0 detected', kind: 'open' },
  { value: 'skills', label: 'Skills', description: '0 available', kind: 'open' },
  // Voice transcription graduated from the retired Channels page into General
  // (user: 음성전사만 일반으로): the managed Whisper runtime powers voice input.
  {
    value: 'voice',
    label: 'Voice transcription',
    description: 'Managed Whisper runtime for voice input.',
    kind: 'open',
  },
  // 'system-shell' stays TUI-only: the desktop hides the override (user
  // decision — automatic platform selection is the only sensible desktop
  // default; the shared config key remains editable from the TUI).
  { value: 'developer', label: 'Developer options', description: 'Developer-only options.', kind: 'open' },
  { value: 'update', label: 'Update', description: 'Check version and update mixdog.', kind: 'open' },
  // Desktop-only: lets the getting-started guide deep-link to remote pairing.
  {
    value: 'connection',
    label: 'Connection',
    description: 'Use this PC from your phone, browser, or another PC.',
    kind: 'open',
  },
  // Desktop-only: the overlay's own menu deep-links to its options.
  { value: 'bots', label: 'Bots', description: 'Representative bot overlay', kind: 'open' },
  {
    value: 'notifications',
    label: 'Notifications',
    description: 'What each device is notified about.',
    kind: 'open',
  },
] as const satisfies ReadonlyArray<SettingsItem>;

type SettingsItemValue = (typeof SETTINGS_ITEMS)[number]['value'];

export type SettingsCategory =
  | 'general'
  | 'skin'
  | 'bots'
  | 'notifications'
  | 'context'
  | 'output-style'
  | 'providers'
  | 'models'
  | 'git'
  | 'connection'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'system'
  | 'developer'
  | 'shortcuts'
  | 'about'
  | 'display'
  | 'work';

interface SettingsCategoryItem {
  value: SettingsCategory;
  label: string;
  /** The rail section heading; categories of one group stay adjacent. */
  group: 'Basics' | 'AI behavior' | 'Integrations' | 'Support';
  items: readonly SettingsItemValue[];
}

export const SETTINGS_CATEGORIES = [
  {
    value: 'general',
    label: 'General',
    group: 'Basics',
    items: ['profile', 'memory-enabled', 'voice'],
  },
  // The representative bot (Mixy) and bot behavior: regular check-ins and
  // reactions on every surface, the overlay options on this PC's window only.
  {
    value: 'bots',
    label: 'Bots',
    group: 'Basics',
    items: ['bots'],
  },
  // Per-device notification preferences (this PC and every paired device).
  {
    value: 'notifications',
    label: 'Notifications',
    group: 'Basics',
    items: ['notifications'],
  },
  // Theme: light/dark/system or a skin picture, color theme files and fonts, all
  // device-local, so a remote surface lists it under "This device". The id stays
  // 'skin' (stored deep links); the retired 'appearance' (fonts) page id is
  // redirected here by settingsCategoryForSurface.
  {
    value: 'skin',
    label: 'Theme',
    group: 'Basics',
    items: ['theme'],
  },
  // Display language, time format, side panels, link preview and the Markdown
  // view; a remote surface lists it under "This device" (stored per device).
  {
    value: 'display',
    label: 'Display',
    group: 'Basics',
    items: ['link-preview'],
  },
  {
    value: 'output-style',
    label: 'Output style',
    group: 'AI behavior',
    items: ['output-style'],
  },
  // Context owns session lifecycle. The Memory master itself lives once in
  // General; curated memories are managed with their project.
  {
    value: 'context',
    label: 'Context',
    group: 'AI behavior',
    items: ['autocompact', 'autoclear'],
  },
  // How sessions work: web search, instruction files, Auto reasoning, worktrees.
  {
    value: 'work',
    label: 'Work style',
    group: 'AI behavior',
    items: ['web-search-enabled'],
  },
  {
    value: 'providers',
    label: 'Providers',
    group: 'Integrations',
    items: ['providers'],
  },
  // Directly below Providers: which connected models /model lists, and favorites.
  {
    value: 'models',
    label: 'Model management',
    group: 'Integrations',
    items: ['model-management'],
  },
  // Desktop-only surface: web-app pairing (QR and bridge status).
  {
    value: 'connection',
    label: 'Connection',
    group: 'Integrations',
    items: ['connection'],
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
    value: 'system',
    label: 'System',
    group: 'Support',
    items: ['update'],
  },
  // Runtime-driven developer toggles, grouped into headed sub-categories.
  {
    value: 'developer',
    label: 'Developer options',
    group: 'Support',
    items: ['developer'],
  },
  // Desktop-only surface (no TUI settings-item counterpart): a read-only
  // keybind reference for the workspace shortcuts.
  {
    value: 'shortcuts',
    label: 'Shortcuts',
    group: 'Support',
    items: [],
  },
  // Desktop-only surface: repo/star/issue links (Settings → About).
  {
    value: 'about',
    label: 'About',
    group: 'Support',
    items: [],
  },
] as const satisfies ReadonlyArray<SettingsCategoryItem>;

/** Device-local pages a remote surface lists under "This device" (Theme, Display)
 *  instead of among the connected PC's pages. */
const DEVICE_PAGES = new Set<SettingsCategory>(['skin', 'display']);
export const DEVICE_SETTINGS_CATEGORIES: ReadonlyArray<SettingsCategoryItem> = SETTINGS_CATEGORIES.filter((category) =>
  DEVICE_PAGES.has(category.value)
);

// Pages whose calls an older host still refuses to remote clients. A host that
// announces open access (every paired client is trusted) shows them all.
const LEGACY_REMOTE_HIDDEN_SETTINGS_CATEGORIES = new Set<SettingsCategory>(['providers', 'models', 'developer']);
const MOVED_EXTENSION_CATEGORIES = new Set<SettingsCategory>(['git', 'skills', 'mcp', 'plugins']);
const LOCAL_SETTINGS_CATEGORIES = SETTINGS_CATEGORIES.filter(
  (category) => !MOVED_EXTENSION_CATEGORIES.has(category.value)
);
// On a remote surface Theme and Display are device pages (DEVICE_SETTINGS_CATEGORIES), not the PC's.
const REMOTE_OPEN_SETTINGS_CATEGORIES = LOCAL_SETTINGS_CATEGORIES.filter(
  (category) => !DEVICE_PAGES.has(category.value)
);
const REMOTE_LEGACY_SETTINGS_CATEGORIES = REMOTE_OPEN_SETTINGS_CATEGORIES.filter(
  (category) => !LEGACY_REMOTE_HIDDEN_SETTINGS_CATEGORIES.has(category.value)
);

export function categoryForSettingsItem(value: SettingsItemValue): SettingsCategory {
  return (
    SETTINGS_CATEGORIES.find((category) => (category.items as readonly SettingsItemValue[]).includes(value))?.value ||
    'general'
  );
}

export function settingsCategoryForSurface(
  requested: SettingsCategory | 'appearance',
  remote: boolean,
  hostOpenAccess = false
): SettingsCategory {
  // The retired "Themes and fonts" page now lives on the Theme page.
  const category = requested === 'appearance' ? 'skin' : requested;
  if (MOVED_EXTENSION_CATEGORIES.has(category)) return 'general';
  return remote && !hostOpenAccess && LEGACY_REMOTE_HIDDEN_SETTINGS_CATEGORIES.has(category) ? 'general' : category;
}

export function settingsCategoriesForSurface(
  remote: boolean,
  hostOpenAccess = false
): ReadonlyArray<SettingsCategoryItem> {
  return remote
    ? hostOpenAccess
      ? REMOTE_OPEN_SETTINGS_CATEGORIES
      : REMOTE_LEGACY_SETTINGS_CATEGORIES
    : LOCAL_SETTINGS_CATEGORIES;
}
