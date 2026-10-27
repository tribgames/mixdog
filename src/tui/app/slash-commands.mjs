/**
 * slash-commands.mjs — the /command registry plus the pure string/matching
 * helpers that operate on it. No hooks, no App state, no closures — plain
 * data + pure fns.
 */
export const SLASH_COMMANDS = [
  { name: 'clear', usage: '/clear', aliases: ['new'], aliasUsage: ['new'], description: 'Start a fresh chat' },
  {
    name: 'project',
    usage: '/project',
    aliases: ['projects'],
    aliasUsage: ['projects'],
    showAliasUsage: false,
    params: '[path]',
    description: 'Switch working directory (project)',
  },
  { name: 'compact', usage: '/compact', description: 'Compact older conversation context' },
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
  },
  {
    name: 'goal',
    usage: '/goal',
    params: '[objective --time 1h --time-mode max|status|pause|resume|edit|stop]',
    description: 'Run and manage a durable session Goal',
  },
  {
    name: 'autoclear',
    usage: '/autoclear',
    params: '[on|off|duration|unlimited]',
    description: 'Reduce cache-miss cost after long idle gaps',
  },
  { name: 'resume', usage: '/resume', params: '[id]', description: 'Resume a saved chat' },
  { name: 'context', usage: '/context', description: 'Show current context surface' },
  {
    name: 'shells',
    usage: '/shells',
    params: '[release <task_id> [--confirm]]',
    description: 'List shells; release one whose termination is unconfirmed',
  },
  {
    name: 'fork',
    usage: '/fork',
    aliases: ['inherit'],
    aliasUsage: ['inherit'],
    showAliasUsage: false,
    description: 'Fork this conversation into a new session on the current model',
  },
  { name: 'usage', usage: '/usage', params: '[refresh]', description: 'Show total provider quota / balance' },
  { name: 'model', usage: '/model', params: '[name|refresh]', description: 'Switch model for subsequent turns' },
  { name: 'websearch', usage: '/websearch', description: 'Set the web search provider/model' },
  { name: 'workflow', usage: '/workflow', params: '[name]', description: 'Switch the active workflow' },
  {
    name: 'outputstyle',
    usage: '/OutputStyle',
    aliases: ['output-style', 'style'],
    aliasUsage: ['style'],
    showAliasUsage: false,
    params: '[name]',
    description: 'Switch Lead output style',
  },
  { name: 'theme', usage: '/theme', params: '[id]', description: 'Change the TUI color theme' },
  { name: 'agents', usage: '/agents', params: '[refresh]', description: 'Show available workflow agents' },
  { name: 'effort', usage: '/effort', params: '[level]', description: 'Set reasoning effort for the current model' },
  {
    name: 'fast',
    usage: '/fast',
    params: '[on|off|ultra]',
    description: 'Set Fast or Ultrafast mode for the current model',
  },
  { name: 'mcp', usage: '/mcp', params: '[login|logout <name>]', description: 'Manage MCP servers and tools' },
  { name: 'skills', usage: '/skills', description: 'Choose a skill for the next request' },
  { name: 'memory', usage: '/memory', params: '[status|core ...]', description: 'List and edit core memories' },
  { name: 'plugins', usage: '/plugins', description: 'Manage local plugin integrations' },
  { name: 'providers', usage: '/providers', description: 'Manage auth, API keys, OAuth, and local endpoints' },
  {
    name: 'settings',
    usage: '/setting',
    aliases: ['setting', 'config'],
    aliasUsage: ['settings', 'config'],
    showAliasUsage: false,
    description: 'Open runtime settings',
  },
  { name: 'profile', usage: '/profile', description: 'Set your title, development experience, and response language' },
  { name: 'update', usage: '/update', description: 'Check version and update mixdog' },
  { name: 'doctor', usage: '/doctor', description: 'Diagnose installation health' },
  { name: 'quit', usage: '/quit', aliases: ['exit', 'q'], aliasUsage: ['exit', 'q'], description: 'Quit the TUI' },
];

export function slashQuery(value) {
  const text = String(value ?? '');
  if (!/^\/[^\s]*$/.test(text)) return null;
  return text.slice(1).toLowerCase();
}

export function slashCommandMatches(command, query) {
  const needle = String(query || '').toLowerCase();
  if (!needle) return true;
  if (
    String(command?.name || '')
      .toLowerCase()
      .startsWith(needle)
  )
    return true;
  return (command?.aliases || []).some((alias) =>
    String(alias || '')
      .toLowerCase()
      .startsWith(needle)
  );
}

export function compareSlashCommands(a, b) {
  return String(a?.name || '').localeCompare(String(b?.name || ''), 'en', { sensitivity: 'base' });
}

/** Prompt-owned overlays absorb PageUp/PageDown and wheel scroll instead of the transcript. */
export function overlayBlocksGlobalTranscriptScroll(owner = {}) {
  return !!(
    owner.slashPaletteOpen ||
    owner.picker ||
    owner.toolApproval ||
    owner.contextPanel ||
    owner.usagePanel ||
    owner.btwPanel ||
    owner.providerPrompt ||
    owner.settingsPrompt
  );
}

// Name/alias lookups run per keystroke (argument hints, palette accept), so the
// registry is indexed once instead of scanned per call. First registration
// wins, matching the `find` order these tables replaced.
const SLASH_COMMAND_BY_NAME = new Map();
const SLASH_COMMAND_BY_TOKEN = new Map();
for (const command of SLASH_COMMANDS) {
  if (!SLASH_COMMAND_BY_NAME.has(command.name)) SLASH_COMMAND_BY_NAME.set(command.name, command);
  for (const token of [command.name, ...(command.aliases || [])]) {
    if (!SLASH_COMMAND_BY_TOKEN.has(token)) SLASH_COMMAND_BY_TOKEN.set(token, command);
  }
}

/**
 * The registered command a prompt runs, by the renderer's rule
 * (apps/desktop renderer/slash-commands.ts recognisedSlashSpan): the text,
 * trimmed, begins with `/` and its first whitespace-delimited token names a
 * command or alias. Returns that token lowercased, else null: any other
 * leading `/` (an absolute path, a stray word) is ordinary message text.
 */
export function recognisedSlashToken(text) {
  const token = /^\s*\/(\S+)/.exec(String(text ?? ''))?.[1].toLowerCase();
  return token && SLASH_COMMAND_BY_TOKEN.has(token) ? token : null;
}

/** The only commands a bot's conversation room runs, by their literal name
 *  (`/new` stays text); mirrors the renderer's recognisedAgentRoomSlash. */
const AGENT_ROOM_SLASH_TOKENS = new Set(['compact', 'clear']);

export function recognisedAgentRoomSlash(text) {
  return AGENT_ROOM_SLASH_TOKENS.has(recognisedSlashToken(text));
}

export function normalizeSlashCommandName(cmd) {
  const name = String(cmd || '').toLowerCase();
  return SLASH_COMMAND_BY_TOKEN.get(name)?.name || name;
}

export function slashCommandTokenForPaletteAccept(command, draftValue = '') {
  if (!command) return '';
  const text = String(draftValue ?? '').trim();
  const typedToken = text.startsWith('/') ? text.slice(1).split(/\s+/)[0]?.toLowerCase() : '';
  const canonical = String(command.name || '').toLowerCase();
  const aliases = (command.aliases || []).map((alias) => String(alias || '').toLowerCase());
  if (typedToken && (typedToken === canonical || aliases.includes(typedToken))) {
    return typedToken;
  }
  return command.name;
}

function slashCommandForName(cmd) {
  return SLASH_COMMAND_BY_NAME.get(normalizeSlashCommandName(cmd)) || null;
}

export function slashArgumentHint(value) {
  const text = String(value ?? '');
  const match = text.match(/^\/([^\s]+)\s+$/);
  if (!match) return '';
  const command = slashCommandForName(match[1]);
  return command?.params ? `${command.usage} ${command.params}` : '';
}
