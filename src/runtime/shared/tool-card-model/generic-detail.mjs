/**
 * generic-detail.mjs — the completed-detail row for tools without a
 * dedicated surface, plus the load_tool and web-search conventions.
 */
import { isShellTool } from './shell-surface.mjs';

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
  // Name-only on purpose: a `run`-labelled non-shell tool keeps the output row
  // below, which passing `l` to isShellTool would suppress.
  if (isShellTool(n)) return '';
  if (isOutputDetailTool(n, l)) {
    return hasResult ? firstResultLine : '';
  }
  return '';
}

const uniqueToolNames = (names) => [
  ...new Set((Array.isArray(names) ? names : []).map((name) => String(name || '').trim()).filter(Boolean)),
];

/**
 * What a bridge load_tool result described, missed and blocked; null for a
 * loader result (or anything that is not a describe result).
 */
export function bridgeDescribeResult(resultText) {
  let parsed;
  try {
    parsed = JSON.parse(String(resultText || ''));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.entries)) return null;
  return {
    described: uniqueToolNames(parsed.entries.map((entry) => entry?.name)),
    missing: uniqueToolNames(parsed.missing),
    blocked: uniqueToolNames((Array.isArray(parsed.blocked) ? parsed.blocked : []).map((entry) => entry?.name)),
  };
}

/** Names a bridge load_tool result described, or null for a loader result. */
export function bridgeDescribedToolNames(resultText) {
  return bridgeDescribeResult(resultText)?.described ?? null;
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
  // Bridge describe result: nothing was loaded; report what was not described.
  const describe = bridgeDescribeResult(resultText);
  if (describe) {
    const { missing, blocked } = describe;
    return [
      ...(missing.length ? [`Missing: ${missing.join(', ')}`] : []),
      ...(blocked.length ? [`Blocked: ${blocked.join(', ')}`] : []),
    ].join(' · ');
  }
  const tools = parsed?.selected?.tools;
  if (!tools || typeof tools !== 'object') return '';
  const loaded = uniqueToolNames(tools.added);
  const already = uniqueToolNames(tools.already);
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
