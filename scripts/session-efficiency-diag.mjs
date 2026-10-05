#!/usr/bin/env node
// Token-efficiency diag over the stored session transcripts. The trace-based
// diags (session-diag, tool-efficiency-diag) need agent-trace.jsonl, which a
// shipped build does not write; the session store is always there.
// Usage: node scripts/session-efficiency-diag.mjs [--since 5d] [--data-dir <dir>] [--agent lead] [--json]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argValue, hasFlag } from './lib/cli-args.mjs';
import { parseSince } from './lib/parse-since.mjs';
import { DEFAULT_SHELL_AUTO_BACKGROUND_MS } from '../src/runtime/agent/orchestrator/tools/builtin/bash-tool/deadline-plan.mjs';

const CONTEXT_BUCKETS = [50_000, 100_000, 200_000, 300_000, 500_000, Infinity];
// Fallback for a session that never recorded a provider context size.
const FALLBACK_TOKENS_PER_BYTE = 0.3;

const size = (value) => {
  if (value == null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
};

function replayBytes(message) {
  let bytes = 0;
  for (const item of message.providerReplay?.items || []) {
    if (item?.type !== 'thinking' && item?.type !== 'redacted_thinking' && item?.type !== 'reasoning') continue;
    bytes += size(item.thinking) + size(item.signature) + size(item.data) + size(item.encrypted_content);
  }
  return bytes;
}

function userCategory(message) {
  return message.meta === 'skill' ? 'skills' : 'user';
}

function add(map, key, fields) {
  const row = map.get(key) || {};
  for (const [name, value] of Object.entries(fields)) row[name] = (row[name] || 0) + value;
  map.set(key, row);
  return row;
}

export function createSummary() {
  return {
    sessions: 0,
    requests: 0,
    groups: new Map(),
    carry: new Map(),
    tools: new Map(),
    buckets: new Map(),
    shell: {},
  };
}

// Folds one stored session into the summary. A message's carry is its size
// times the requests sent after it: every later request re-sends it.
export function addSession(summary, session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const requests = messages.filter((message) => message.role === 'assistant').length;
  if (!requests) return;
  summary.sessions++;
  summary.requests += requests;
  const group = add(summary.groups, `${session.agent || '-'} @${session.model || '-'}`, { sessions: 1, requests });
  const shell = summary.shell;
  const callsById = new Map();
  const promoted = new Map();
  const prefixes = [];
  let prefix = size(session.tools);
  let later = requests;
  for (const message of messages) {
    if (message.role === 'assistant') {
      later--;
      prefixes.push(prefix);
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      let argBytes = 0;
      for (const call of calls) {
        argBytes += size(call.arguments) + size(call.name);
        callsById.set(call.id, { ...call, alone: calls.length === 1 });
      }
      const thinking = replayBytes(message);
      const text = size(message.content);
      add(summary.carry, 'tool args', { bytes: argBytes * later });
      add(summary.carry, 'thinking', { bytes: thinking * later });
      add(summary.carry, 'assistant text', { bytes: text * later });
      group.calls = (group.calls || 0) + calls.length;
      if (calls.length) group.toolRequests = (group.toolRequests || 0) + 1;
      if (calls.length === 1) group.singleCall = (group.singleCall || 0) + 1;
      if (calls.length && calls.every((call) => call.name === 'task' && call.arguments?.action === 'wait')) {
        shell.taskWaitOnlyRequests = (shell.taskWaitOnlyRequests || 0) + 1;
      }
      prefix += argBytes + thinking + text;
      continue;
    }
    const bytes = size(message.content);
    prefix += bytes;
    if (message.role === 'system') add(summary.carry, 'system', { bytes: bytes * later });
    else if (message.role === 'user') add(summary.carry, userCategory(message), { bytes: bytes * later });
    else if (message.role === 'tool') {
      add(summary.carry, 'tool results', { bytes: bytes * later });
      const call = callsById.get(message.toolCallId);
      if (!call) continue;
      add(summary.tools, call.name, { calls: 1, bytes, carry: bytes * later });
      const text = typeof message.content === 'string' ? message.content : '';
      if (call.name === 'shell') recordShellCall(shell, promoted, call, text);
      else if (call.name === 'task') recordTaskResult(shell, promoted, call, text);
    }
  }
  const lastContext = Number(session.lastContextTokens) || 0;
  const tokensPerByte = lastContext > 0 && prefix > 0 ? lastContext / prefix : FALLBACK_TOKENS_PER_BYTE;
  for (const bytes of prefixes) {
    const context = bytes * tokensPerByte;
    group.tokenRequests = (group.tokenRequests || 0) + context;
    add(
      summary.buckets,
      CONTEXT_BUCKETS.find((limit) => context < limit),
      { requests: 1, tokenRequests: context }
    );
  }
}

function recordShellCall(shell, promoted, call, text) {
  shell.calls = (shell.calls || 0) + 1;
  const waitMs = call.arguments?.wait_ms;
  const shortWait = Number.isFinite(waitMs) && waitMs < DEFAULT_SHELL_AUTO_BACKGROUND_MS;
  if (shortWait) shell.shortWait = (shell.shortWait || 0) + 1;
  if (!text.startsWith('background task')) return;
  shell.promoted = (shell.promoted || 0) + 1;
  if (shortWait) shell.shortWaitPromoted = (shell.shortWaitPromoted || 0) + 1;
  const taskId = /^task_id: (\S+)/m.exec(text)?.[1];
  if (taskId) promoted.set(taskId, { shortWait, durationKnown: false });
}

// The first task result that reports both timestamps settles how long the
// promoted command really ran.
function recordTaskResult(shell, promoted, call, text) {
  const job = promoted.get(call.arguments?.task_id);
  if (!job || job.durationKnown) return;
  const started = Date.parse(/^started: (\S+)/m.exec(text)?.[1] || '');
  const finished = Date.parse(/^finished: (\S+)/m.exec(text)?.[1] || '');
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return;
  job.durationKnown = true;
  if (!job.shortWait) return;
  shell.shortWaitTimed = (shell.shortWaitTimed || 0) + 1;
  if (finished - started <= DEFAULT_SHELL_AUTO_BACKGROUND_MS) {
    shell.shortWaitInsideDefault = (shell.shortWaitInsideDefault || 0) + 1;
  }
}

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function buildReport(summary) {
  const carryTotal = [...summary.carry.values()].reduce((sum, row) => sum + row.bytes, 0);
  const toolCarryTotal = [...summary.tools.values()].reduce((sum, row) => sum + row.carry, 0);
  const tokenRequestTotal = [...summary.buckets.values()].reduce((sum, row) => sum + row.tokenRequests, 0);
  return {
    sessions: summary.sessions,
    requests: summary.requests,
    groups: [...summary.groups.entries()]
      .map(([name, row]) => ({
        name,
        sessions: row.sessions,
        requests: row.requests,
        callsPerToolRequest: row.toolRequests ? Math.round((row.calls / row.toolRequests) * 100) / 100 : 0,
        singleCallPct: share(row.singleCall || 0, row.toolRequests || 0),
        avgContextTokens: Math.round((row.tokenRequests || 0) / row.requests),
        tokenRequests: Math.round(row.tokenRequests || 0),
      }))
      .sort((a, b) => b.tokenRequests - a.tokenRequests),
    carry: [...summary.carry.entries()]
      .map(([name, row]) => ({ name, pct: share(row.bytes, carryTotal) }))
      .sort((a, b) => b.pct - a.pct),
    tools: [...summary.tools.entries()]
      .map(([name, row]) => ({
        name,
        calls: row.calls,
        avgResultBytes: Math.round(row.bytes / row.calls),
        carryPct: share(row.carry, toolCarryTotal),
      }))
      .sort((a, b) => b.carryPct - a.carryPct),
    requestContext: CONTEXT_BUCKETS.map((limit) => {
      const row = summary.buckets.get(limit) || { requests: 0, tokenRequests: 0 };
      return {
        under: Number.isFinite(limit) ? limit : null,
        requestPct: share(row.requests, summary.requests),
        tokenRequestPct: share(row.tokenRequests, tokenRequestTotal),
      };
    }),
    shell: {
      calls: summary.shell.calls || 0,
      promoted: summary.shell.promoted || 0,
      waitUnderDefault: summary.shell.shortWait || 0,
      waitUnderDefaultPromoted: summary.shell.shortWaitPromoted || 0,
      waitUnderDefaultTimed: summary.shell.shortWaitTimed || 0,
      waitUnderDefaultFinishedInsideDefault: summary.shell.shortWaitInsideDefault || 0,
      taskWaitOnlyRequests: summary.shell.taskWaitOnlyRequests || 0,
      taskWaitOnlyPct: share(summary.shell.taskWaitOnlyRequests || 0, summary.requests),
    },
  };
}

const compact = (value) => {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  return value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(Math.round(value));
};

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  return rows.map((row) =>
    row
      .map((cell, column) => String(cell).padEnd(widths[column]))
      .join('  ')
      .trimEnd()
  );
}

function renderReport(report, sinceTs) {
  const lines = [
    `session efficiency: ${report.sessions} sessions, ${report.requests} requests${sinceTs ? ` since ${new Date(sinceTs).toISOString()}` : ''}`,
    '',
    ...table([
      ['agent @model', 'sessions', 'requests', 'calls/req', 'single-call%', 'avgContext', 'tokenRequests'],
      ...report.groups
        .slice(0, 12)
        .map((row) => [
          row.name,
          row.sessions,
          row.requests,
          row.callsPerToolRequest,
          row.singleCallPct,
          compact(row.avgContextTokens),
          compact(row.tokenRequests),
        ]),
    ]),
    '',
    `carried context (size x later requests): ${report.carry.map((row) => `${row.name} ${row.pct}%`).join(', ')}`,
    `tool results by carry: ${report.tools
      .slice(0, 10)
      .map((row) => `${row.name} ${row.carryPct}% (${row.calls} calls, avg ${compact(row.avgResultBytes)}B)`)
      .join(', ')}`,
    `request context: ${report.requestContext
      .map(
        (row) =>
          `${row.under ? `<${compact(row.under)}` : 'larger'} ${row.requestPct}% of requests / ${row.tokenRequestPct}% of token-requests`
      )
      .join(', ')}`,
    `shell foreground window: ${report.shell.calls} calls, ${report.shell.promoted} promoted to background; wait_ms under the ${DEFAULT_SHELL_AUTO_BACKGROUND_MS}ms default on ${report.shell.waitUnderDefault} calls (${report.shell.waitUnderDefaultPromoted} promoted, ${report.shell.waitUnderDefaultFinishedInsideDefault} of ${report.shell.waitUnderDefaultTimed} timed ones finished inside the default); task-wait-only requests: ${report.shell.taskWaitOnlyRequests} (${report.shell.taskWaitOnlyPct}%)`,
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const mixdogHome = process.env.MIXDOG_HOME || resolve(homedir(), '.mixdog');
  const dataDir = resolve(argValue('--data-dir', process.env.MIXDOG_DATA_DIR || join(mixdogHome, 'data')));
  const sinceTs = parseSince(argValue('--since', '5d'));
  const agentFilter = argValue('--agent', null);
  const sessionsDir = join(dataDir, 'sessions');
  const summary = createSummary();
  let names;
  try {
    names = readdirSync(sessionsDir).filter((name) => name.endsWith('.json'));
  } catch {
    process.stderr.write(`no sessions directory at ${sessionsDir}\n`);
    return 1;
  }
  for (const name of names) {
    const file = join(sessionsDir, name);
    try {
      if (sinceTs != null && statSync(file).mtimeMs < sinceTs) continue;
      const session = JSON.parse(readFileSync(file, 'utf8'));
      if (agentFilter && String(session.agent || '') !== agentFilter) continue;
      addSession(summary, session);
    } catch {
      /* a session mid-write or unreadable: skip it */
    }
  }
  const report = buildReport(summary);
  process.stdout.write(hasFlag('--json') ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report, sinceTs));
  return 0;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
