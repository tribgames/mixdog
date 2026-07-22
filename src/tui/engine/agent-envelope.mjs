/**
 * src/tui/engine/agent-envelope.mjs - parse agent/background-task/shell
 * notification envelopes into synthetic tool-item shapes, and derive
 * status/result text. Extracted from engine.mjs; parseBackgroundTaskEnvelope
 * remains part of engine.mjs's public surface.
 */
import { isBackgroundErrorOnlyBody } from '../../runtime/shared/err-text.mjs';

export function textBetweenTag(text, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(String(text ?? ''));
  return match ? match[1].trim() : '';
}

function stripSyntheticAgentTags(text) {
  const value = String(text ?? '').trim();
  const finalAnswer = textBetweenTag(value, 'final-answer');
  if (finalAnswer) return finalAnswer;
  const taskResult = textBetweenTag(value, 'result');
  if (taskResult) return taskResult;
  return value
    .replace(/^agent result[^\n]*(?:\n|$)/i, '')
    .replace(/<\/?(?:final-answer|task-notification|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>/gi, '')
    .trim();
}

function splitBridgeEnvelope(text) {
  const value = String(text ?? '').trim();
  if (!value) return { head: '', body: '' };
  const match = /\n\s*\n/.exec(value);
  if (!match) return { head: value, body: '' };
  return {
    head: value.slice(0, match.index).trim(),
    body: value.slice(match.index + match[0].length).trim(),
  };
}

function agentJobStatusText(parsed) {
  if (!parsed) return '';
  const parts = [];
  if (parsed.status) parts.push(`status: ${parsed.status}`);
  if (parsed.taskId) parts.push(`task_id: ${parsed.taskId}`);
  return parts.join(' · ');
}

export function agentJobResultText(text, parsed = parseAgentJob(text)) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  if (parsed?.taskId) {
    const { body } = splitBridgeEnvelope(value);
    const cleanBody = stripSyntheticAgentTags(body);
    if (cleanBody) return cleanBody;
    return agentJobStatusText(parsed);
  }
  return stripSyntheticAgentTags(value) || value;
}

export function parseAgentResultEnvelope(text, fallback = {}) {
  const value = String(text ?? '').trim();
  if (!/^agent result\b/i.test(value)) return null;
  const [head = '', ...restLines] = value.split('\n');
  const body = stripSyntheticAgentTags(restLines.join('\n'));
  const attrs = {};
  const attrRe = /([a-zA-Z][\w-]*)=("[^"]*"|'[^']*'|\S+)/g;
  let match;
  while ((match = attrRe.exec(head))) {
    attrs[match[1].toLowerCase()] = String(match[2] || '').replace(/^["']|["']$/g, '');
  }
  const providerModel = /\s([a-zA-Z0-9_.-]+)\/([^\s]+)\s*$/i.exec(head);
  const agent = attrs.agent || fallback.agent || '';
  return {
    name: 'agent',
    label: String(fallback.status || attrs.status || 'completed').toLowerCase(),
    args: {
      type: 'result',
      status: fallback.status || attrs.status || 'completed',
      task_id: fallback.taskId || attrs.task_id || attrs.taskid || undefined,
      tag: fallback.tag || attrs.tag || undefined,
      agent: agent || undefined,
      provider: fallback.provider || attrs.provider || providerModel?.[1] || undefined,
      model: fallback.model || attrs.model || providerModel?.[2] || undefined,
      preset: fallback.preset || attrs.preset || undefined,
      effort: fallback.effort || attrs.effort || undefined,
      fast: fallback.fast ?? attrs.fast,
    },
    result: body || agentJobStatusText({ status: fallback.status || attrs.status || 'completed', taskId: fallback.taskId || attrs.task_id || attrs.taskid || '' }),
    isError: /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(fallback.status || attrs.status || ''),
  };
}

export function parseBackgroundTaskEnvelope(text) {
  const value = String(text ?? '').trim();
  if (!/^background task\b/i.test(value)) return null;
  const allLines = value.split('\n');
  const rest = allLines.slice(1);
  const blank = rest.findIndex((line) => !line.trim());
  const headLines = blank >= 0 ? rest.slice(0, blank) : rest;
  const body = blank >= 0 ? rest.slice(blank + 1).join('\n').trim() : '';
  const fields = {};
  for (const line of headLines) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const surface = String(fields.surface || fields.operation || 'task').toLowerCase();
  const name = surface === 'explore' || surface === 'search' || surface === 'shell' || surface === 'agent' ? surface : 'task';
  const status = String(fields.status || '').toLowerCase();
  const taskId = fields.task_id || fields.taskid || '';
  const errorText = fields.error || '';
  const agentResult = parseAgentResultEnvelope(body, {
    status,
    taskId,
    tag: fields.tag || fields.label || '',
    agent: fields.agent || '',
    provider: fields.provider || '',
    model: fields.model || '',
    preset: fields.preset || '',
    effort: fields.effort || '',
    fast: fields.fast,
  });
  if (agentResult) return { ...agentResult, rawResult: value };
  const errorOnlyBody = isBackgroundErrorOnlyBody(body, errorText);
  const resultBody = body && !errorOnlyBody ? body : '';
  return {
    name,
    label: status || 'notification',
    args: {
      type: body ? 'result' : (fields.operation || 'status'),
      status,
      task_id: taskId || undefined,
      surface,
      operation: fields.operation || undefined,
      label: fields.label || undefined,
      tag: fields.tag || undefined,
      agent: fields.agent || undefined,
      provider: fields.provider || undefined,
      model: fields.model || undefined,
      preset: fields.preset || undefined,
      effort: fields.effort || undefined,
      fast: fields.fast || undefined,
      error: errorText || undefined,
      startedAt: fields.started || fields.startedat || undefined,
      finishedAt: fields.finished || fields.finishedat || undefined,
    },
    result: resultBody || (!errorText ? [status ? `status: ${status}` : '', taskId ? `task_id: ${taskId}` : ''].filter(Boolean).join(' · ') : ''),
    rawResult: value,
    isError: /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(status) || /^error:/i.test(body) || Boolean(errorText),
  };
}

export function isStatusOnlyAgentCompletionNotification(text) {
  const background = parseBackgroundTaskEnvelope(text);
  if (background?.name === 'agent' && /^(completed|cancelled|canceled)$/i.test(background.label || '')) {
    return !(hasAgentResponseResultText(background.result) || hasAgentResponseResultText(text));
  }
  const parsed = parseAgentJob(text);
  const result = agentJobResultText(text, parsed);
  if (!parsed?.taskId || !/^(completed|cancelled|canceled)$/i.test(parsed.status || '')) return false;
  return !(hasAgentResponseResultText(result) || hasAgentResponseResultText(text));
}

function hasAgentResponseResultText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$/i.test(value)) return false;
  if (/^(?:background task\b|agent task:|task_id:)/i.test(value) && !/\n\s*\n[\s\S]*\S/.test(value)) return false;
  return true;
}

function bracketField(text, name) {
  const re = new RegExp(`^\\[${name}:\\s*([^\\]]*)\\]`, 'mi');
  return re.exec(String(text ?? ''))?.[1]?.trim() || '';
}

export function toolResultStatus(text) {
  const value = String(text ?? '');
  const tagged = textBetweenTag(value, 'status');
  if (tagged) return tagged.trim();
  const bracketed = bracketField(value, 'status');
  if (bracketed) return bracketed.trim();
  const inline = /^(?:status|state):\s*([^\s·,;]+)/mi.exec(value);
  return inline ? inline[1].trim() : '';
}

export function isErrorToolStatus(status) {
  return /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(String(status || '').trim());
}

export function parseSyntheticAgentMessage(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const finalAnswer = textBetweenTag(value, 'final-answer');
  if (finalAnswer) {
    return {
      name: 'agent',
      label: 'final',
      args: { type: 'read', description: 'agent result' },
      result: finalAnswer,
    };
  }
  const agentResult = parseAgentResultEnvelope(value);
  if (agentResult) return agentResult;
  const backgroundTask = parseBackgroundTaskEnvelope(value);
  if (backgroundTask) return backgroundTask;
  const shellTaskId = bracketField(value, 'task_id');
  if (shellTaskId) {
    const status = bracketField(value, 'status') || 'done';
    const exit = bracketField(value, 'exit');
    const command = bracketField(value, 'command');
    return {
      name: 'shell',
      label: status,
      args: { type: 'result', task_id: shellTaskId, command },
      result: value,
      isError: /^(failed|error|timeout|cancelled|killed)$/i.test(status) || (exit && exit !== '0' && exit !== 'n/a'),
    };
  }
  const agentJob = parseAgentJob(value);
  if (agentJob?.taskId) {
    const label = agentJob.status || 'notification';
    const result = agentJobResultText(value, agentJob);
    return {
      name: 'agent',
      label,
      args: agentArgsWithResultMetadata({ type: agentJob.type || 'notification', description: 'agent notification' }, agentJob),
      result: result || agentJobStatusText(agentJob) || 'agent notification',
      isError: /^(failed|error|timeout|cancelled|killed)$/i.test(label),
    };
  }
  if (/<task-notification\b/i.test(value)) {
    const status = textBetweenTag(value, 'status') || 'completed';
    const summary = textBetweenTag(value, 'summary') || `Agent ${status}`;
    const taskId = textBetweenTag(value, 'task-id');
    const result = stripSyntheticAgentTags(value);
    return {
      name: 'agent',
      label: status,
      taskId,
      summary,
      result: result || summary,
    };
  }
  return null;
}

export function parseAgentJob(text) {
  const value = String(text || '');
  const idMatch = /^agent task:\s*([^\s]+)/m.exec(value) || /^task_id:\s*([^\s]+)/m.exec(value);
  if (!idMatch) return null;
  const statusMatch = /^status:\s*([^\s(]+)/m.exec(value);
  const typeMatch = /^type:\s*(.+)$/m.exec(value);
  const targetMatch = /^target:\s*(.+)$/m.exec(value);
  const agentMatch = /^agent:\s*(.+)$/m.exec(value);
  const presetMatch = /^preset:\s*(.+)$/m.exec(value);
  // Spawn acknowledgements normally use `model: provider/model`, but agent
  // completion envelopes carry the resolved route as separate provider/model
  // fields. A generic tool result can also contain task_id/provider/model
  // diagnostics, so only recognize either route shape on an agent envelope.
  const isAgentEnvelope = /^agent task:\s*/mi.test(value)
    || /^agent result\b/mi.test(value)
    || /^surface:\s*agent\s*$/mi.test(value);
  const providerMatch = isAgentEnvelope ? /^provider:\s*(.+)$/m.exec(value) : null;
  const modelLineMatch = isAgentEnvelope ? /^model:\s*(.+)$/m.exec(value) : null;
  const providerModelMatch = /^([^/\s]+)\/(.+)$/.exec(modelLineMatch?.[1]?.trim() || '');
  const effortMatch = /^effort:\s*(.+)$/m.exec(value);
  const fastMatch = /^fast:\s*(on|off|true|false)$/m.exec(value);
  return {
    taskId: idMatch[1],
    status: (statusMatch?.[1] || '').toLowerCase(),
    type: (typeMatch?.[1] || '').trim(),
    target: (targetMatch?.[1] || '').trim(),
    agent: (agentMatch?.[1] || '').trim(),
    preset: (presetMatch?.[1] || '').trim(),
    provider: (providerMatch?.[1] || providerModelMatch?.[1] || '').trim(),
    model: (providerModelMatch?.[2] || modelLineMatch?.[1] || '').trim(),
    effort: (effortMatch?.[1] || '').trim(),
    fast: fastMatch ? /^(on|true)$/i.test(fastMatch[1]) : undefined,
  };
}

export function agentArgsWithResultMetadata(args, parsed) {
  if (!parsed) return args;
  const next = { ...(args && typeof args === 'object' ? args : {}) };
  const requestedAction = String(next.type || next.action || next.mode || '').trim().toLowerCase();
  if (parsed.type) {
    // Job status envelopes report the original job type (usually "spawn").
    // Preserve the user's current agent tool action ("status", "read", …) so
    // manual checks render as "Reviewer status" instead of another
    // "Spawning Reviewer" card. Keep the job type as metadata for detail.
    if (!requestedAction || /^(notification|result|completion)$/i.test(requestedAction)) next.type = parsed.type;
    else next.jobType = parsed.type;
  }
  if (parsed.status) next.status = parsed.status;
  if (parsed.taskId) next.task_id = parsed.taskId;
  if (parsed.agent) next.agent = parsed.agent;
  if (parsed.preset) next.preset = parsed.preset;
  const hasExplicitProvider = [next.provider, next.providerId, next.provider_id]
    .some((value) => String(value || '').trim());
  if (parsed.provider && !hasExplicitProvider) next.provider = parsed.provider;
  if (parsed.model && !String(next.model || '').trim()) next.model = parsed.model;
  if (parsed.effort) next.effort = parsed.effort;
  if (parsed.fast !== undefined) next.fast = parsed.fast;
  if (!next.tag && parsed.target) {
    const target = parsed.target.split(/\s+/)[0];
    if (target && !target.startsWith('sess_')) next.tag = target;
  }
  return next;
}
