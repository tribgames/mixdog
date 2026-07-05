/**
 * app-format.mjs — pure formatting/labeling helpers for the App shell.
 *
 * Extracted verbatim from App.jsx. No React, no engine state — string/label
 * formatting, welcome hints, provider row labels, and small pure predicates.
 */
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';
import { formatToolSurface } from '../../runtime/shared/tool-surface.mjs';

// SEARCH_DEFAULT marker — mirrors backend SEARCH_DEFAULT_PROVIDER/MODEL
// (mixdog-session-runtime.mjs 1167-1168). A search route of {provider:'default',
// model:'default'} means "follow the Main Model" at runtime (nativeSearchRoutes).
export const SEARCH_DEFAULT_ROUTE = Object.freeze({ provider: 'default', model: 'default' });
export const isSearchDefaultRoute = (route) =>
  String(route?.provider || '').toLowerCase() === 'default'
  && String(route?.model || '').toLowerCase() === 'default';

export function terminalSize(stdout) {
  // Match ink's getWindowSize() semantics (vendor/ink/build/utils.js): rows or
  // columns can be 0 (not just undefined) before the TTY reports its size —
  // treating 0 as valid made App's FIRST frame lay out against a tiny/default
  // viewport, so the initial picker rendered collapsed and then "unfolded"
  // when the post-mount resize effect read the real dimensions.
  const columns = stdout?.columns;
  const rows = stdout?.rows;
  if (columns && rows) return { columns, rows };
  return {
    columns: columns || 80,
    rows: rows || 24,
  };
}

export function clean(value) {
  return String(value ?? '').trim();
}

export function projectNameFromPath(value) {
  const text = String(value || '').replace(/[\\/]+$/, '');
  return text.split(/[\\/]/).pop() || text || '(current)';
}

export function workflowDisplayName(workflow = {}) {
  return clean(workflow?.name || workflow?.id) || 'Default';
}

export function workflowSwitchNotice(workflow = {}) {
  return 'Workflow saved · new sessions';
}

export function modelSwitchNotice() {
  return 'Model saved · new sessions';
}

export function compactJson(value, max = 180) {
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value ?? '');
  }
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return stringWidth(text) > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

export function toolApprovalDescription(request = {}) {
  const surface = formatToolSurface(request.name, request.args);
  const summary = surface?.summary ? `${surface.label || request.name} (${surface.summary})` : (surface?.label || request.name || 'tool');
  const reason = clean(request.reason) || 'Hook requested approval.';
  const args = compactJson(request.args);
  return [
    summary ? `Tool: ${summary}` : '',
    reason ? `Reason: ${reason}` : '',
    args ? `Args: ${args}` : '',
  ].filter(Boolean).join('\n');
}

export function providerStatusLabel(provider = {}) {
  const status = clean(provider.status);
  if (status) return status;
  if (provider.enabled || provider.authenticated) return 'Set';
  if (provider.detected) return 'Detected';
  return 'Off';
}

export function providerDetailText(provider = {}) {
  const detail = clean(provider.detail);
  if (detail) return detail;
  if (provider.env && provider.envName) return `env: ${provider.envName}`;
  if (provider.envName) return provider.envName;
  if (provider.baseURL) return provider.baseURL;
  if (provider.desc) return provider.desc;
  return '';
}

export function providerKindLabel(provider = {}) {
  if (provider.type === 'oauth') return 'OAuth';
  if (provider.type === 'local') return 'Local endpoint';
  return 'API key';
}

export function formatSessionUpdatedAt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '--:--';
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return '--:--';
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}-${day} ${time}`;
}

export function formatSessionMessageCount(count) {
  const n = Number(count || 0);
  return `${Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0} msg${n === 1 ? '' : 's'}`;
}

export function fitLine(value, columns, reserve = 4) {
  const text = String(value || '');
  const width = Math.max(1, Number(columns || 80) - reserve);
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return '…'.repeat(Math.max(0, width));
  let out = '';
  for (const ch of text) {
    if (stringWidth(`${out}${ch}…`) > width) break;
    out += ch;
  }
  return `${out}…`;
}

export function centerLine(value, columns, reserve = 0) {
  const text = fitLine(value, columns, reserve);
  const width = Math.max(1, Number(columns || 80) - reserve);
  const pad = Math.max(0, Math.floor((width - stringWidth(text)) / 2));
  return `${' '.repeat(pad)}${text}`;
}

export const WELCOME_PROMPT_HINTS = [
  'Tip: /setting · Tune the runtime before the run.',
  'Tip: /model · Pick the right brain for the job.',
  'Tip: /workflow · Change how work gets routed.',
  'Tip: Ctrl+O · Expand tool output when you need details.',
  'Tip: PageUp/PageDown · Scroll the transcript.',
  'Tip: Esc · Close panels or interrupt work.',
  'Tip: /usage · Check quota before a long run.',
  'Tip: /agents · See who can help.',
  'Tip: /theme · Change the terminal mood.',
  'Tip: /search · Set web search routing.',
  'Paste an error. I’ll trace it.',
  'Tell me the goal. I’ll handle the steps.',
  'Start with a task, a bug, or a wild idea.',
  'Good fixes start with a repro.',
  'Ask for a plan, then let the agents work.',
  'Small prompt, sharp result.',
  'Drop in a file path and ask what changed.',
  'Describe the outcome, not just the command.',
  'Ready when you are.',
  'One clear goal beats ten vague tasks.',
];

export const CONDITIONAL_WELCOME_PROMPT_HINTS = {
  noProvider: 'Tip: /providers · Connect a provider before your first turn.',
  noModel: 'Tip: /model · Choose a model before your first turn.',
  soloWorkflow: 'Tip: /workflow · Switch from Solo when you want agents.',
  searchDefaultUnsupported: 'Tip: /search · Choose a native search model for this main model.',
  error: 'Tip: /doctor · Check setup health. (coming soon)',
};

export function randomWelcomePromptHint() {
  const index = Math.floor(Math.random() * WELCOME_PROMPT_HINTS.length);
  return WELCOME_PROMPT_HINTS[index] || WELCOME_PROMPT_HINTS[0] || '';
}

export function providerSetupHasUsableProvider(setup = {}) {
  const rows = [
    ...(Array.isArray(setup.api) ? setup.api : []),
    ...(Array.isArray(setup.oauth) ? setup.oauth : []),
    ...(Array.isArray(setup.local) ? setup.local : []),
  ];
  return rows.some((row) => (
    row?.authenticated === true
    || row?.enabled === true
    || row?.stored === true
    || row?.env === true
    || row?.detected === true
  ));
}

export function activeWorkflowSummaryForStore(store, workflow = {}) {
  try {
    const workflows = store.listWorkflows?.() || [];
    return workflows.find((item) => item.active)
      || workflows.find((item) => item.id === workflow?.id)
      || null;
  } catch {
    return null;
  }
}

export function promptStatusColor(tone) {
  if (tone === 'error') return theme.error;
  if (tone === 'warn' || tone === 'cancel') return theme.warning;
  if (tone === 'plain') return theme.subtle;
  return theme.inactive;
}

export function promptHistoryKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}
