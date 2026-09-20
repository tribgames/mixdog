/**
 * generic-detail.mjs — the completed-detail row for tools without a
 * dedicated surface, plus the load_tool and web-search conventions.
 */
const OUTPUT_DETAIL_TOOL_NAMES = new Set([
  'shell',
  'bash',
  'bash_session',
  'shell_command',
  'job_wait',
  'read',
  'view_image',
  'read_mcp_resource',
  'grep',
  'glob',
  'search_query',
  'image_query',
  'web_search',
  'web_search_call',
  'web_fetch',
  'fetch',
  'list',
  'ls',
  'code_graph',
  'recall',
  'recall_memory',
  'search_memories',
  'remember',
  'save_memory',
  'update_memory',
]);

function isOutputDetailTool(normalizedName, label) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return OUTPUT_DETAIL_TOOL_NAMES.has(n) || l === 'read' || l === 'search' || l === 'web search' || l === 'run';
}

export function genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError }) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  if (isError) return hasResult ? firstResultLine : 'Failed';
  if (n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait') {
    return '';
  }
  if (isOutputDetailTool(n, l)) {
    return hasResult ? firstResultLine : '';
  }
  return '';
}

export function toolSearchLoadedSummary(resultText) {
  let parsed;
  try {
    parsed = JSON.parse(String(resultText || ''));
  } catch {
    const text = String(resultText || '');
    const loaded = /^Loaded deferred tools:\s*(.+)$/m.exec(text)?.[1] || '';
    const already = /^Already active:\s*(.+)$/m.exec(text)?.[1] || '';
    return [...(loaded ? [`Loaded: ${loaded}`] : []), ...(already ? [`Already active: ${already}`] : [])].join(' · ');
  }
  const tools = parsed?.selected?.tools;
  if (!tools || typeof tools !== 'object') return '';
  const uniqueNames = (names) => [
    ...new Set((Array.isArray(names) ? names : []).map((name) => String(name || '').trim()).filter(Boolean)),
  ];
  const loaded = uniqueNames(tools.added);
  const already = uniqueNames(tools.already);
  return [
    ...(loaded.length ? [`Loaded: ${loaded.join(', ')}`] : []),
    ...(already.length ? [`Already active: ${already.join(', ')}`] : []),
  ].join(' · ');
}

export function shouldPrefixSyncElapsed(normalizedName, label) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return n === 'web_search' || l === 'search' || l === 'web search';
}
