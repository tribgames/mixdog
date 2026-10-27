import { t } from './i18n';

export type SettingsSection =
  | 'profile'
  | 'autoclear'
  | 'autocompact'
  | 'output-style'
  | 'theme'
  | 'workflow'
  | 'model'
  | 'websearch'
  | 'providers'
  | 'model-management'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'memory'
  | 'voice'
  | 'update'
  | 'connection'
  | 'auth'
  | 'bots'
  | 'developer';

// 'stats' is the usage dialog: /usage and the usage flyout both open it.
export type CommandSurface = 'context' | 'doctor' | 'inherit' | 'stats';

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
  action?: 'clear' | 'compact' | 'btw' | 'goal' | 'resume' | 'remote' | 'project' | 'fast' | 'settings' | 'close-task';
}

// Public fields mirror src/tui/app/slash-commands.mjs exactly. Desktop routing
// metadata sends each command to its native GUI home or session capability.
export const SLASH_COMMANDS: ReadonlyArray<DesktopSlashCommand> = [
  {
    name: 'clear',
    usage: '/clear',
    aliases: ['new'],
    aliasUsage: ['new'],
    description: 'Start a fresh chat',
    action: 'clear',
  },
  {
    name: 'project',
    usage: '/project',
    aliases: ['projects'],
    aliasUsage: ['projects'],
    showAliasUsage: false,
    params: '[path]',
    description: 'Switch working directory (project)',
    action: 'project',
  },
  { name: 'compact', usage: '/compact', description: 'Compact older conversation context', action: 'compact' },
  {
    name: 'handoff',
    usage: '/handoff',
    description: 'Write a Devin handoff file and start the Devin CLI on this project',
  },
  {
    name: 'btw',
    usage: '/btw',
    params: '<question>',
    description: 'Ask a quick side question without interrupting the current work',
    action: 'btw',
  },
  {
    name: 'goal',
    usage: '/goal',
    params: '[objective --time 1h --time-mode max|status|pause|resume|edit|stop]',
    description: 'Run and manage a durable session Goal',
    action: 'goal',
  },
  {
    name: 'autoclear',
    usage: '/autoclear',
    params: '[on|off|duration|unlimited]',
    description: 'Reduce cache-miss cost after long idle gaps',
    settingsRow: 'autoclear',
  },
  { name: 'resume', usage: '/resume', params: '[id]', description: 'Resume a saved chat', action: 'resume' },
  { name: 'context', usage: '/context', description: 'Show current context surface', surface: 'context' },
  {
    name: 'fork',
    usage: '/fork',
    aliases: ['inherit'],
    aliasUsage: ['inherit'],
    showAliasUsage: false,
    description: 'Fork this conversation into a new session on the current model',
    surface: 'inherit',
  },
  {
    name: 'usage',
    usage: '/usage',
    params: '[refresh]',
    description: 'Show total provider quota / balance',
    desktopDescription: 'Show token usage and subscription quota',
    surface: 'stats',
  },
  {
    name: 'model',
    usage: '/model',
    params: '[name|refresh]',
    description: 'Switch model for subsequent turns',
    settingsRow: 'model',
  },
  {
    name: 'websearch',
    usage: '/websearch',
    description: 'Set the web search provider/model',
    settingsRow: 'websearch',
  },
  {
    name: 'workflow',
    usage: '/workflow',
    params: '[name]',
    description: 'Switch the active workflow',
    settingsRow: 'workflow',
  },
  {
    name: 'outputstyle',
    usage: '/OutputStyle',
    aliases: ['output-style', 'style'],
    aliasUsage: ['style'],
    showAliasUsage: false,
    params: '[name]',
    description: 'Switch Lead output style',
    settingsRow: 'output-style',
  },
  {
    name: 'theme',
    usage: '/theme',
    params: '[id]',
    description: 'Change the TUI color theme',
    desktopDescription: 'Change the app color theme',
    settingsRow: 'theme',
  },
  {
    name: 'agents',
    usage: '/agents',
    params: '[refresh]',
    description: 'Show available workflow agents',
    settingsRow: 'workflow',
  },
  {
    name: 'effort',
    usage: '/effort',
    params: '[level]',
    description: 'Set reasoning effort for the current model',
    settingsRow: 'model',
  },
  {
    name: 'fast',
    usage: '/fast',
    params: '[on|off|ultra]',
    description: 'Toggle Fast mode for the current model',
    action: 'fast',
  },
  { name: 'mcp', usage: '/mcp', description: 'Manage MCP servers and tools', settingsRow: 'mcp' },
  { name: 'skills', usage: '/skills', description: 'Choose a skill for the next request', settingsRow: 'skills' },
  {
    name: 'memory',
    usage: '/memory',
    params: '[status|core ...]',
    description: 'List and edit core memories',
    settingsRow: 'memory',
  },
  { name: 'plugins', usage: '/plugins', description: 'Manage local plugin integrations', settingsRow: 'plugins' },
  {
    name: 'providers',
    usage: '/providers',
    description: 'Manage auth, API keys, OAuth, and local endpoints',
    settingsRow: 'providers',
  },
  {
    name: 'settings',
    usage: '/setting',
    aliases: ['setting', 'config'],
    aliasUsage: ['settings', 'config'],
    showAliasUsage: false,
    description: 'Open runtime settings',
    action: 'settings',
  },
  {
    name: 'profile',
    usage: '/profile',
    description: 'Set your title, development experience, and response language',
    settingsRow: 'profile',
  },
  { name: 'update', usage: '/update', description: 'Check version and update mixdog', settingsRow: 'update' },
  {
    name: 'connect',
    usage: '/connect',
    description: 'Connect to another PC',
    settingsRow: 'connection',
  },
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

/** The recognised `/name` token of a draft, by the executor's rule: the
 *  trimmed draft begins with `/` and its first whitespace-delimited token
 *  names a registry command or alias. Returns the token's range in `draft`. */
export function recognisedSlashSpan(draft: string): { start: number; end: number } | null {
  const match = /^\s*(\/(\S+))/.exec(draft);
  if (!match || !resolveDesktopSlashCommand(match[2])) return null;
  const start = match[0].length - match[1].length;
  return { start, end: match[0].length };
}

/** The only commands a bot's conversation room runs: every other leading `/`
 *  there is message text. They are the room's own context controls, matched by
 *  their literal name (`/new` stays text). */
const AGENT_ROOM_SLASH_COMMANDS: ReadonlySet<string> = new Set(['compact', 'clear']);

export function recognisedAgentRoomSlash(draft: string): boolean {
  const span = recognisedSlashSpan(draft);
  return span !== null && AGENT_ROOM_SLASH_COMMANDS.has(draft.slice(span.start + 1, span.end).toLowerCase());
}

// Discovery stays small; the full registry still accepts commands typed directly.
const COMPOSER_SLASH_COMMANDS: ReadonlyArray<DesktopSlashCommand> = [
  'new',
  'btw',
  'resume',
  'model',
  'compact',
  'context',
  'usage',
  'skills',
  'goal',
  'fork',
  'doctor',
  'fast',
].map((name) => ({ ...resolveDesktopSlashCommand(name)!, usage: `/${name}` }));

/** A group room's own command (agent-room.mjs parseRoomAsk): not a runtime
 *  command, so it lives outside the shared registry and lists only in rooms. */
export const ROOM_ASK_COMMAND: DesktopSlashCommand = {
  name: 'ask',
  usage: '/ask',
  params: '<agent> <message>',
  description: 'Ask one member of this room; the others skip their turn',
};

export function desktopComposerSlashCommands(draft: string, room = false): ReadonlyArray<DesktopSlashCommand> {
  if (!/^\/[a-z]*$/i.test(draft)) return [];
  const query = draft.toLowerCase();
  const commands = room ? [ROOM_ASK_COMMAND, ...COMPOSER_SLASH_COMMANDS] : COMPOSER_SLASH_COMMANDS;
  return commands.filter((command) => command.usage.startsWith(query));
}

export function desktopSlashCommandDescription(command: DesktopSlashCommand): string {
  return t(command.desktopDescription ?? command.description);
}
