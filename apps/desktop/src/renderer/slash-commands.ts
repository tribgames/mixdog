export type SettingsSection =
  | 'profile' | 'autoclear' | 'autocompact' | 'compact-type' | 'output-style'
  | 'theme' | 'workflow' | 'model' | 'websearch' | 'providers' | 'mcp'
  | 'plugins' | 'hooks' | 'skills' | 'memory' | 'update';

export type CommandSurface = 'context' | 'usage' | 'doctor' | 'inherit';

export interface DesktopSlashCommand {
  name: string;
  usage: string;
  aliases?: readonly string[];
  aliasUsage?: readonly string[];
  showAliasUsage?: boolean;
  params?: string;
  description: string;
  desktopDescription?: string;
  settingsRow?: SettingsSection;
  surface?: CommandSurface;
  action?: 'clear' | 'compact' | 'goal' | 'resume' | 'remote' | 'project' | 'fast' | 'settings' | 'close-task';
}

// Public fields mirror src/tui/app/slash-commands.mjs exactly. Desktop routing
// metadata sends each command to its native GUI home or session capability.
export const SLASH_COMMANDS: ReadonlyArray<DesktopSlashCommand> = [
  { name: 'clear', usage: '/clear', aliases: ['new'], aliasUsage: ['new'], description: 'Start a fresh chat', action: 'clear' },
  { name: 'project', usage: '/project', aliases: ['projects'], aliasUsage: ['projects'], showAliasUsage: false, params: '[path]', description: 'Switch working directory (project)', action: 'project' },
  { name: 'compact', usage: '/compact', description: 'Compact older conversation context', action: 'compact' },
  { name: 'goal', usage: '/goal', params: '[objective --time 1h|status|pause|resume|edit|complete|clear]', description: 'Run and manage a durable session Goal', action: 'goal' },
  { name: 'autoclear', usage: '/autoclear', params: '[on|off|duration]', description: 'Reduce cache-miss cost after long idle gaps', settingsRow: 'autoclear' },
  { name: 'resume', usage: '/resume', params: '[id]', description: 'Resume a saved chat', action: 'resume' },
  { name: 'context', usage: '/context', description: 'Show current context surface', surface: 'context' },
  { name: 'inherit', usage: '/inherit', description: 'Carry this conversation into a new session on the current model', surface: 'inherit' },
  { name: 'usage', usage: '/usage', params: '[refresh]', description: 'Show total provider quota / balance', surface: 'usage' },
  { name: 'model', usage: '/model', params: '[name|refresh]', description: 'Switch model for subsequent turns', settingsRow: 'model' },
  { name: 'websearch', usage: '/websearch', description: 'Set the web search provider/model', settingsRow: 'websearch' },
  { name: 'workflow', usage: '/workflow', params: '[name]', description: 'Switch the active workflow', settingsRow: 'workflow' },
  { name: 'outputstyle', usage: '/OutputStyle', aliases: ['output-style', 'style'], aliasUsage: ['style'], showAliasUsage: false, params: '[name]', description: 'Switch Lead output style', settingsRow: 'output-style' },
  { name: 'theme', usage: '/theme', params: '[id]', description: 'Change the TUI color theme', settingsRow: 'theme' },
  { name: 'agents', usage: '/agents', params: '[refresh]', description: 'Show available workflow agents', settingsRow: 'workflow' },
  { name: 'effort', usage: '/effort', params: '[level]', description: 'Set reasoning effort for the current model', settingsRow: 'model' },
  { name: 'fast', usage: '/fast', params: '[on|off]', description: 'Toggle Fast mode for the current model', action: 'fast' },
  { name: 'mcp', usage: '/mcp', description: 'Manage MCP servers and tools', settingsRow: 'mcp' },
  { name: 'skills', usage: '/skills', description: 'Choose a skill for the next request', settingsRow: 'skills' },
  { name: 'memory', usage: '/memory', params: '[status|core ...]', description: 'List and edit core memories', settingsRow: 'memory' },
  { name: 'plugins', usage: '/plugins', description: 'Manage local plugin integrations', settingsRow: 'plugins' },
  { name: 'hooks', usage: '/hooks', description: 'Manage before-tool hook rules and events', settingsRow: 'hooks' },
  { name: 'providers', usage: '/providers', description: 'Manage auth, API keys, OAuth, and local endpoints', settingsRow: 'providers' },
  { name: 'settings', usage: '/setting', aliases: ['setting', 'config'], aliasUsage: ['settings', 'config'], showAliasUsage: false, description: 'Open runtime settings', action: 'settings' },
  { name: 'profile', usage: '/profile', description: 'Set your title, development experience, and response language', settingsRow: 'profile' },
  { name: 'update', usage: '/update', description: 'Check version and update mixdog', settingsRow: 'update' },
  { name: 'doctor', usage: '/doctor', description: 'Diagnose installation health', surface: 'doctor' },
  {
    name: 'quit',
    usage: '/quit',
    aliases: ['exit', 'q'],
    aliasUsage: ['exit', 'q'],
    description: 'Quit the TUI',
    desktopDescription: 'Close this task',
    action: 'close-task',
  },
];

export function resolveDesktopSlashCommand(rawName: string): DesktopSlashCommand | undefined {
  const token = rawName.toLowerCase();
  return SLASH_COMMANDS.find((entry) => entry.name === token || entry.aliases?.includes(token));
}

export function desktopSlashCommandDescription(command: DesktopSlashCommand): string {
  return command.desktopDescription ?? command.description;
}
