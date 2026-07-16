export type SettingsSection =
  | 'profile' | 'autoclear' | 'autocompact' | 'compact-type' | 'channels'
  | 'remote-runtime' | 'channel-backend' | 'channel-setting' | 'output-style'
  | 'theme' | 'workflow' | 'model' | 'search' | 'providers' | 'mcp'
  | 'plugins' | 'hooks' | 'skills' | 'update';

export type CommandSurface =
  | 'agents' | 'memory' | 'schedules' | 'webhooks' | 'channels'
  | 'context' | 'usage' | 'doctor' | 'effort';

export interface DesktopSlashCommand {
  name: string;
  usage: string;
  aliases?: readonly string[];
  aliasUsage?: readonly string[];
  showAliasUsage?: boolean;
  params?: string;
  description: string;
  settingsRow?: SettingsSection;
  surface?: CommandSurface;
  action?: 'clear' | 'project' | 'compact' | 'resume' | 'fast' | 'remote' | 'settings' | 'quit';
}

// Public fields mirror src/tui/app/slash-commands.mjs. Desktop-only fields
// describe routing and are deliberately limited to TUI-exposed surfaces.
export const SLASH_COMMANDS: ReadonlyArray<DesktopSlashCommand> = [
  { name: 'clear', usage: '/clear', aliases: ['new'], aliasUsage: ['new'], description: 'Start a fresh chat', action: 'clear' },
  { name: 'project', usage: '/project', aliases: ['projects'], aliasUsage: ['projects'], showAliasUsage: false, description: 'Switch working directory (project)', action: 'project' },
  { name: 'compact', usage: '/compact', description: 'Compact older conversation context', action: 'compact' },
  { name: 'autoclear', usage: '/autoclear', description: 'Reduce cache-miss cost after long idle gaps', settingsRow: 'autoclear' },
  { name: 'resume', usage: '/resume', description: 'Resume a saved chat', action: 'resume' },
  { name: 'context', usage: '/context', description: 'Show current context surface', surface: 'context' },
  { name: 'usage', usage: '/usage', params: '[refresh]', description: 'Show total provider quota / balance', surface: 'usage' },
  { name: 'model', usage: '/model', description: 'Switch model for subsequent turns', settingsRow: 'model' },
  { name: 'search', usage: '/search', description: 'Set the web search provider/model', settingsRow: 'search' },
  { name: 'workflow', usage: '/workflow', description: 'Switch the active workflow', settingsRow: 'workflow' },
  { name: 'outputstyle', usage: '/OutputStyle', aliases: ['output-style', 'style'], aliasUsage: ['style'], showAliasUsage: false, params: '[name]', description: 'Switch Lead output style', settingsRow: 'output-style' },
  { name: 'theme', usage: '/theme', params: '[id]', description: 'Change the TUI color theme', settingsRow: 'theme' },
  { name: 'agents', usage: '/agents', description: 'Show available workflow agents', surface: 'agents' },
  { name: 'effort', usage: '/effort', params: '[level]', description: 'Set reasoning effort for the current model', surface: 'effort' },
  { name: 'fast', usage: '/fast', params: '[on|off]', description: 'Toggle Fast mode for the current model', action: 'fast' },
  { name: 'mcp', usage: '/mcp', description: 'Manage MCP servers and tools', settingsRow: 'mcp' },
  { name: 'skills', usage: '/skills', description: 'Choose a skill for the next request', settingsRow: 'skills' },
  { name: 'memory', usage: '/memory', description: 'List and edit core memories', surface: 'memory' },
  { name: 'plugins', usage: '/plugins', description: 'Manage local plugin integrations', settingsRow: 'plugins' },
  { name: 'hooks', usage: '/hooks', description: 'Manage before-tool hook rules and events', settingsRow: 'hooks' },
  { name: 'providers', usage: '/providers', description: 'Manage auth, API keys, OAuth, and local endpoints', settingsRow: 'providers' },
  { name: 'channels', usage: '/channels', description: 'Manage Discord, channels, schedules, webhooks', surface: 'channels' },
  { name: 'remote', usage: '/remote', description: 'Claim remote for this session (takes over from any other session)', action: 'remote' },
  { name: 'schedules', usage: '/schedules', description: 'Manage schedules', surface: 'schedules' },
  { name: 'webhooks', usage: '/webhooks', description: 'Manage inbound webhooks', surface: 'webhooks' },
  { name: 'settings', usage: '/setting', aliases: ['setting', 'config'], aliasUsage: ['settings', 'config'], showAliasUsage: false, description: 'Open runtime settings', action: 'settings' },
  { name: 'profile', usage: '/profile', description: 'Set your title and response language', settingsRow: 'profile' },
  { name: 'update', usage: '/update', description: 'Check version and update mixdog', settingsRow: 'update' },
  { name: 'doctor', usage: '/doctor', description: 'Diagnose installation health', surface: 'doctor' },
  { name: 'quit', usage: '/quit', aliases: ['exit', 'q'], aliasUsage: ['exit', 'q'], description: 'Quit the TUI', action: 'quit' },
];
