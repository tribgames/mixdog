/**
 * src/tui/engine/notice-text.mjs - polish user-facing failure/notice text.
 * Extracted from engine.mjs.
 */
const FAILED_NOTICE_ACTIONS = new Map([
  ['api key save', 'save API key'],
  ['auth-forget', 'forget auth'],
  ['auto-clear', 'update auto-clear'],
  ['autoclear', 'update auto-clear'],
  ['agent', 'run agent command'],
  ['channels', 'load channels'],
  ['channels update', 'update channels'],
  ['clear', 'clear chat'],
  ['compact', 'compact context'],
  ['copy', 'copy'],
  ['core memory', 'load core memory'],
  ['cwd', 'update working directory'],
  ['effort switch', 'switch effort'],
  ['fast', 'update fast mode'],
  ['hook rule update', 'update hook rule'],
  ['hook toggle', 'toggle hook'],
  ['hook update', 'update hook'],
  ['hooks status', 'load hooks'],
  ['local provider update', 'update local provider'],
  ['mcp add', 'add MCP server'],
  ['mcp reconnect', 'reconnect MCP server'],
  ['mcp status', 'load MCP status'],
  ['mcp toggle', 'toggle MCP server'],
  ['memory', 'run memory command'],
  ['memory status', 'load memory status'],
  ['model save', 'save model'],
  ['model switch', 'switch model'],
  ['oauth code', 'finish OAuth login'],
  ['oauth login', 'start OAuth login'],
  ['output style switch', 'switch output style'],
  ['OpenAI usage auth save', 'save OpenAI usage auth'],
  ['OpenCode Go usage auth save', 'save OpenCode Go usage auth'],
  ['plugin add', 'add plugin'],
  ['plugin MCP enable', 'enable plugin MCP'],
  ['plugin uninstall', 'uninstall plugin'],
  ['plugin update', 'update plugin'],
  ['plugins status', 'load plugins'],
  ['providers', 'load providers'],
  ['recall', 'run recall'],
  ['resume', 'resume chat'],
  ['schedule toggle', 'toggle schedule'],
  ['setup save', 'save setup'],
  ['settings update', 'update settings'],
  ['skill add', 'add skill'],
  ['skills status', 'load skills'],
  ['tools status', 'load tool status'],
  ['usage', 'load usage'],
  ['webhook toggle', 'toggle webhook'],
  ['workflow switch', 'switch workflow'],
]);

function polishNoticeAction(action) {
  const value = String(action || '').trim();
  if (!value) return 'finish';
  const key = value.toLowerCase();
  for (const [candidate, replacement] of FAILED_NOTICE_ACTIONS.entries()) {
    if (candidate.toLowerCase() === key) return replacement;
  }
  const suffixes = [
    [' save', 'save'],
    [' switch', 'switch'],
    [' update', 'update'],
    [' toggle', 'toggle'],
    [' reconnect', 'reconnect'],
    [' enable', 'enable'],
    [' uninstall', 'uninstall'],
    [' add', 'add'],
  ];
  for (const [suffix, verb] of suffixes) {
    if (!key.endsWith(suffix)) continue;
    const subject = value.slice(0, -suffix.length).trim();
    return subject ? `${verb} ${subject}` : verb;
  }
  return value;
}

function sentenceStart(text) {
  const value = String(text || '').trim();
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

export function polishNoticeText(text) {
  let value = String(text ?? '').trim().replace(/^✓\s*/, '');
  if (!value) return '';
  const error = /^error\s*:\s*(.+)$/i.exec(value);
  if (error?.[1]) value = error[1].trim();
  const couldNot = /^could not\s+(.+?)(?::\s*(.+))?$/i.exec(value);
  if (couldNot) {
    return couldNot[2]
      ? `Couldn’t ${couldNot[1]}: ${couldNot[2]}`
      : `Couldn’t ${couldNot[1]}.`;
  }
  const failed = /^(.+?)\s+failed(?::\s*(.+))?$/i.exec(value);
  if (failed) {
    const action = polishNoticeAction(failed[1]);
    return failed[2] ? `Couldn’t ${action}: ${failed[2]}` : `Couldn’t ${action}.`;
  }
  const busy = /^(.+?)\s+already in progress\.?$/i.exec(value);
  if (busy) return `${sentenceStart(polishNoticeAction(busy[1]))} is already running.`;
  const required = /^(.+?)\s+is required(?:\s+for\s+(.+))?\.?$/i.exec(value);
  if (required) {
    const subject = required[1].trim();
    const target = required[2]?.trim();
    return `${subject}${target ? ` required for ${target}` : ' required'}.`;
  }
  return value;
}
