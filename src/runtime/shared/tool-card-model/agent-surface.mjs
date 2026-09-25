/**
 * agent-surface.mjs — the agent tool family: action/response titles, the
 * parenthesized summary and the bridge-envelope response detection.
 */
import { displayModelName } from '../tool-surface.mjs';
import { titleWord } from '../tool-primitives.mjs';
import { backgroundTaskFailureStatusLabel } from '../err-text.mjs';
import { parseTaskNotification } from '../task-notification-envelope.mjs';

export function isAgentTool(normalizedName) {
  return normalizedName === 'agent';
}

export const SKILL_SURFACE_NAMES = new Set(['skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill']);

const AGENT_DISPLAY_NAMES = new Map([
  ['maintainer', 'Maintainer'],
  ['worker', 'Worker'],
  ['heavy-worker', 'Heavy Worker'],
  ['reviewer', 'Reviewer'],
]);

export function titleizeAgentName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const key = text.toLowerCase().replace(/[\s_]+/g, '-');
  if (AGENT_DISPLAY_NAMES.has(key)) return AGENT_DISPLAY_NAMES.get(key);
  return text.replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean).map(titleWord).join(' ');
}

// The agent identity a card shows, from whichever field the caller supplied.
function agentDisplayName(args) {
  return titleizeAgentName(args?.agent || args?.subagent_type || args?.name || '');
}

function agentModelLabel(args) {
  const a = args && typeof args === 'object' ? args : {};
  const provider = String(a.provider || a.providerId || a.provider_id || '').trim();
  const model = String(a.model || '').trim();
  const displayHint = String(a.modelDisplay || a.model_display || a.displayModel || '').trim();
  return displayModelName(model, provider, displayHint);
}

function agentTagLabel(args) {
  // The real spawn tag (engine fills parsedArgs.tag from the envelope target).
  // Never fall back to task_id — only the human-meaningful spawn tag belongs in
  // the header parentheses.
  return String(args?.tag || '').trim();
}

function withModelAndTag(label, args) {
  const model = agentModelLabel(args);
  const tag = agentTagLabel(args);
  const inner = [model, tag].filter(Boolean).join(', ');
  return inner ? `${label} (${inner})` : label;
}

// Append an agent name to a base action word without leaving a trailing space
// when the agent is unknown (no generic "Agent" fallback).
function joinActionAgent(action, agent) {
  return agent ? `${action} ${agent}` : action;
}

export function agentResponseTitle(args, count = 1) {
  const total = Math.max(1, Number(count) || 1);
  if (total > 1) return `Responses ${total} agents`;
  const name = agentDisplayName(args) || 'Agent';
  // The agent + model identify the responder; the response summary itself
  // is hidden in the collapsed card (expanding still shows the full body).
  // Keep the surface identifiable even when a failed/legacy completion has no
  // concrete agent identity.
  return withModelAndTag(joinActionAgent('Response', name), args);
}

const AGENT_ACTION_VERBS = new Map([
  ['spawn', 'Spawn'],
  ['send', 'Send'],
  ['cancel', 'Cancel'],
  ['close', 'Close'],
  ['cleanup', 'Cleanup'],
  ['read', 'Status'],
  ['status', 'Status'],
]);

export function agentActionTitle(args) {
  const name = agentDisplayName(args);
  // Runtime treats an omitted type/action as "spawn" (see agent-tool.mjs default),
  // so mirror that contract here instead of falling through to the generic
  // "Called agent" status copy.
  const action = String(args?.type || args?.action || 'spawn').toLowerCase();
  if (action === 'list') return 'Agent status';
  // Fixed action verbs regardless of running/completed status. No generic
  // "Agent" fallback for the agent: when the agent is unknown render the action
  // word alone ("Spawn") instead of "Spawn Agent".
  const verb = AGENT_ACTION_VERBS.get(action);
  return verb ? withModelAndTag(joinActionAgent(verb, name), args) : '';
}

export function agentActionSummary(args, summary) {
  const text = String(summary || '').trim();
  if (!text) return '';
  const name = agentDisplayName(args);
  if (name && text === name) return '';
  const rest = name && text.startsWith(`${name} · `) ? text.slice(name.length + 3).trim() : text;
  // The agent/model/tag surface summary ("Heavy Worker · Opus 4.8") is now folded
  // into the header label itself ("Spawn Heavy Worker (Opus 4.8, tag)"), so drop
  // the model and tag tokens from the parenthesized summary to avoid showing
  // them twice.
  const model = agentModelLabel(args);
  if (model && rest === model) return '';
  const tag = agentTagLabel(args);
  if (tag && rest === tag) return '';
  return rest;
}

const BRIDGE_ENVELOPE_TAG_RE =
  /^<\/?(?:final-answer|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>$/i;
const BRIDGE_ENVELOPE_HEAD_FIELD_RE =
  /^(?:agent task|background task|agent message queued\b|agent close:|task_id|surface|operation|label|status|type|target|agent|preset|model|effort|fast|limits|started|finished|error|notification|queueDepth):?\s*/i;

function isBridgeEnvelope(text) {
  return (
    /^(?:agent task:|background task\b|agent message queued\b|agent close:)/i.test(text) ||
    /^(?:agents|tasks):\s*\d/i.test(text) ||
    /^\(no agents or tasks\)$/i.test(text) ||
    (/^task_id:\s*\S+/im.test(text) && /^(?:surface|operation|status):\s*/im.test(text))
  );
}

/** True when a bridge envelope carries a line the model actually authored. */
function envelopeHasResponseLine(text) {
  let sawBlank = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      sawBlank = true;
      continue;
    }
    if (/^agent result\b/i.test(trimmed)) continue;
    if (/^(?:undefined|null)$/i.test(trimmed)) continue;
    if (BRIDGE_ENVELOPE_TAG_RE.test(trimmed)) continue;
    if (!sawBlank && BRIDGE_ENVELOPE_HEAD_FIELD_RE.test(trimmed)) continue;
    if (!sawBlank && /^(?:agents|tasks):\s*/i.test(trimmed)) continue;
    if (/^\(no agents or tasks\)$/i.test(trimmed)) continue;
    if (!sawBlank && /^-\s+\S+/i.test(trimmed)) continue;
    return true;
  }
  return false;
}

export function hasAgentResponseResult(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const notification = parseTaskNotification(text);
  if (notification) return Boolean(notification.result);
  if (/^(?:undefined|null)$/i.test(text)) return false;
  if (
    /^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$/i.test(text)
  )
    return false;
  if (!isBridgeEnvelope(text)) return true;
  return envelopeHasResponseLine(text);
}

export function agentTerminalDetail(status, isError, elapsed, error = '') {
  const failureDetail = isError && error ? backgroundTaskFailureStatusLabel(status, error, { surface: 'agent' }) : '';
  if (failureDetail) return failureDetail;
  const s = String(status || '').toLowerCase();
  let word = '';
  if (/cancel/.test(s)) word = 'Cancelled';
  else if (/error|fail|killed|timeout/.test(s) || isError) word = 'Failed';
  else if (/done|success|complete|closed/.test(s)) word = 'Finished';
  // Unified ` · <time>` convention (previously "Finished after 12s").
  if (!word) return '';
  return elapsed ? `${word} · ${elapsed}` : word;
}
