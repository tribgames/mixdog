/**
 * slash-commands.mjs — the /command registry plus the pure string/matching
 * helpers that operate on it. Extracted verbatim from App.jsx (behavior-
 * preserving): no hooks, no App state, no closures — plain data + pure fns.
 */
export const SLASH_COMMANDS = [
  { name: 'clear', usage: '/clear', aliases: ['new'], aliasUsage: ['new'], description: 'Start a fresh chat' },
  { name: 'project', usage: '/project', aliases: ['projects'], aliasUsage: ['projects'], showAliasUsage: false, description: 'Switch working directory (project)' },
  { name: 'compact', usage: '/compact', description: 'Compact older conversation context' },
  { name: 'autoclear', usage: '/autoclear', description: 'Reduce cache-miss cost after long idle gaps' },
  { name: 'resume', usage: '/resume', description: 'Resume a saved chat' },
  { name: 'context', usage: '/context', description: 'Show current context surface' },
  { name: 'usage', usage: '/usage', params: '[refresh]', description: 'Show total provider quota / balance' },
  { name: 'model', usage: '/model', description: 'Switch model for subsequent turns' },
  { name: 'search', usage: '/search', description: 'Set the web search provider/model' },
  { name: 'workflow', usage: '/workflow', description: 'Switch the active workflow' },
  { name: 'outputstyle', usage: '/OutputStyle', aliases: ['output-style', 'style'], aliasUsage: ['style'], showAliasUsage: false, params: '[name]', description: 'Switch Lead output style' },
  { name: 'theme', usage: '/theme', params: '[id]', description: 'Change the TUI color theme' },
  { name: 'agents', usage: '/agents', description: 'Show available workflow agents' },
  { name: 'effort', usage: '/effort', params: '[level]', description: 'Set reasoning effort for the current model' },
  { name: 'fast', usage: '/fast', params: '[on|off]', description: 'Toggle Fast mode for the current model' },
  { name: 'mcp', usage: '/mcp', description: 'Manage MCP servers and tools' },
  { name: 'skills', usage: '/skills', description: 'Choose a skill for the next request' },
  { name: 'memory', usage: '/memory', description: 'List and edit core memories' },
  { name: 'plugins', usage: '/plugins', description: 'Manage local plugin integrations' },
  { name: 'hooks', usage: '/hooks', description: 'Manage before-tool hook rules and events' },
  { name: 'providers', usage: '/providers', description: 'Manage auth, API keys, OAuth, and local endpoints' },
  { name: 'channels', usage: '/channels', description: 'Manage Discord, channels, schedules, webhooks' },
  { name: 'remote', usage: '/remote', description: 'Claim remote for this session (takes over from any other session)' },
  { name: 'schedules', usage: '/schedules', description: 'Manage schedules' },
  { name: 'webhooks', usage: '/webhooks', description: 'Manage inbound webhooks' },
  { name: 'settings', usage: '/setting', aliases: ['setting', 'config'], aliasUsage: ['settings', 'config'], showAliasUsage: false, description: 'Open runtime settings' },
  { name: 'profile', usage: '/profile', description: 'Set your title and response language' },
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
  if (String(command?.name || '').toLowerCase().startsWith(needle)) return true;
  return (command?.aliases || []).some((alias) => String(alias || '').toLowerCase().startsWith(needle));
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
    owner.providerPrompt ||
    owner.channelPrompt ||
    owner.hookPrompt ||
    owner.settingsPrompt
  );
}

export function normalizeSlashCommandName(cmd) {
  const name = String(cmd || '').toLowerCase();
  const command = SLASH_COMMANDS.find((item) => item.name === name || (item.aliases || []).includes(name));
  return command?.name || name;
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

export function slashCommandForName(cmd) {
  const name = normalizeSlashCommandName(cmd);
  return SLASH_COMMANDS.find((item) => item.name === name) || null;
}

export function slashArgumentHint(value) {
  const text = String(value ?? '');
  const match = text.match(/^\/([^\s]+)\s+$/);
  if (!match) return '';
  const command = slashCommandForName(match[1]);
  return command?.params ? `${command.usage} ${command.params}` : '';
}
