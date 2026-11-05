// Records the golden transcripts of the Node agent loop.
//
//   node native/core/fixtures/agent/record.mjs [--tree <node checkout with node_modules>]
//
// Each scenario is a scripted provider (the same script the Rust loop replays
// in `crates/mixdog-agent/tests/golden.rs`). The Node loop runs it through the
// public `agentLoop` entry point and the normalized transcript, result fields
// and the requests it built are written to `golden/<name>.json`. Scenarios
// themselves are written to `scenarios/<name>.json`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
// The agent set is shared with the other recorders: stage a copy, replace only
// the directories this recorder owns, re-list the manifest, then swap it in.
const stage = stageSet(here, ['golden', 'scenarios']);
const loopDir = join(nodeRoot, 'src/runtime/agent/orchestrator');
const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-agent-golden-'));
process.env.MIXDOG_DATA_DIR = dataRoot;

const { agentLoop } = await import(pathToFileURL(join(loopDir, 'session/agent-loop.mjs')).href);
const { setInternalToolsProvider } = await import(pathToFileURL(join(loopDir, 'internal-tools.mjs')).href);

const call = (id, name, args = {}) => ({ id, name, arguments: args });
const turn = (content, stopReason, toolCalls = []) => ({ content, toolCalls, stopReason });
const toolTurn = (content, ...calls) => turn(content, 'tool_use', calls);
const cut = (text, stop = 'length') => turn(text, stop);
const user = (content) => ({ role: 'user', content });

const scenarios = [
  {
    name: 'tail_reminder_korean',
    model: 'anthropic/claude-opus-5.5',
    provider: 'anthropic',
    language: { id: 'ko', name: 'Korean' },
    messages: [user('go')],
    script: [toolTurn('looking', call('c1', 'echo', { a: 1 })), turn('all done', 'end_turn')],
  },
  {
    name: 'tail_reminder_other_language',
    model: 'claude-opus-5-5',
    provider: 'anthropic-oauth',
    language: { id: 'en', name: 'English' },
    messages: [user('go')],
    script: [turn('hello', 'end_turn')],
  },
  {
    name: 'tool_round',
    messages: [user('go')],
    script: [toolTurn('looking', call('c1', 'echo', { a: 1 })), turn('all done', 'end_turn')],
  },
  {
    name: 'two_calls_in_order',
    messages: [user('go')],
    script: [
      toolTurn('', call('c1', 'echo', { n: 1 }), call('c2', 'echo', { n: 2 })),
      turn('k', 'end_turn'),
    ],
  },
  {
    name: 'steering_pre_send',
    messages: [user('go')],
    steer: { 'pre-send': ['  also check b '] },
    script: [toolTurn('', call('c1', 'echo')), turn('ok', 'end_turn')],
  },
  {
    name: 'steering_terminal',
    messages: [user('go')],
    steer: { terminal: ['one more thing'] },
    script: [turn('first', 'end_turn'), turn('second', 'end_turn')],
  },
  {
    name: 'output_limit_escalation',
    messages: [user('go')],
    escalated: 8000,
    script: [cut('aa'), cut('bb'), turn('cc', 'end_turn')],
  },
  {
    name: 'output_limit_exhausted',
    messages: [user('go')],
    script: [cut('a'), cut('b'), cut('c'), cut('d')],
  },
  {
    name: 'empty_nudge',
    messages: [user('go')],
    script: [turn('', 'end_turn')],
    repeatLast: true,
  },
  {
    name: 'empty_incomplete_nudge',
    messages: [user('go')],
    script: [turn('', 'OTHER'), turn('done', 'end_turn')],
  },
  {
    name: 'empty_max_tokens_nudge_spelling',
    messages: [user('go')],
    escalated: null,
    script: [turn('', 'MAX_TOKENS'), turn('x', 'end_turn')],
  },
  {
    name: 'pause_turn',
    messages: [user('go')],
    script: [turn('part', 'pause_turn'), turn('rest', 'end_turn')],
  },
  {
    name: 'refusal_twice',
    messages: [user('go')],
    script: [turn('', 'refusal')],
    repeatLast: true,
  },
  {
    name: 'turn_limits',
    messages: [user('go')],
    limits: { maxToolCalls: 1 },
    script: [
      toolTurn('', call('c1', 'echo', { n: 1 }), call('c2', 'echo', { n: 2 })),
      turn('wrap', 'end_turn'),
    ],
  },
  {
    name: 'intra_turn_dedup',
    messages: [user('go')],
    script: [
      toolTurn('', call('c1', 'echo', { p: 'x' }), call('c2', 'echo', { p: 'x' })),
      turn('k', 'end_turn'),
    ],
  },
  {
    name: 'unknown_tool_redirect',
    messages: [user('go')],
    script: [toolTurn('', call('c1', 'semantic_search', { query: 'x' })), turn('k', 'end_turn')],
  },
  {
    name: 'unknown_tool_suggestion',
    messages: [user('go')],
    script: [toolTurn('', call('c1', 'raed', {})), turn('k', 'end_turn')],
  },
  {
    name: 'repeat_failure_guard',
    messages: [user('go')],
    script: [
      toolTurn('', call('c1', 'boom', { path: 'a/../b.txt' })),
      toolTurn('', call('c2', 'boom', { path: 'b.txt' })),
      toolTurn('', call('c3', 'boom', { path: './b.txt' })),
      toolTurn('', call('c4', 'boom', { path: 'b.txt' })),
      turn('gave up', 'end_turn'),
    ],
  },
  {
    name: 'stale_ids_renamed',
    messages: [user('go')],
    script: [
      toolTurn('', call('call_0', 'echo', { i: 1 })),
      toolTurn('', call('call_0', 'echo', { i: 2 })),
      turn('k', 'end_turn'),
    ],
  },
];

const ECHO = {
  name: 'echo',
  description: 'Echo.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};
const BOOM = {
  name: 'boom',
  description: 'Always fails.',
  inputSchema: { type: 'object', properties: {} },
  annotations: {},
};

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p?.type === 'text' ? p.text : p?.type === 'image' ? '[Image]' : '')).filter(Boolean).join('\n');
  }
  return String(content ?? '');
}

function normalizeMessage(m) {
  const meta = m.meta && typeof m.meta === 'object' ? m.meta : null;
  const source = meta?.source ?? (typeof m.meta === 'string' ? m.meta : null);
  return {
    role: m.role,
    content: normalizeContent(m.content),
    source: source ?? null,
    attempt: meta?.attempt ?? null,
    toolCalls: (m.toolCalls || []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
    toolCallId: m.toolCallId ?? null,
    toolKind: m.toolKind ?? null,
    turnReminder: m.turnReminder ?? null,
  };
}

async function record(scenario) {
  const scopeId = `golden-${scenario.name}`;
  const unregister = setInternalToolsProvider({
    scopeId,
    tools: [ECHO, BOOM],
    executor: async (name, args) => {
      if (name === 'boom') throw new Error('boom');
      return `echo:${JSON.stringify(args)}`;
    },
  });
  const session = {
    id: scopeId,
    owner: 'cli',
    provider: scenario.provider ?? 'openrouter',
    responseLanguage: scenario.language ?? null,
    mcpScopeId: scopeId,
    cwd: process.cwd(),
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
    tools: [ECHO, BOOM],
    messages: [],
  };
  const messages = structuredClone(scenario.messages);
  const requests = [];
  let sends = 0;
  const provider = {
    name: 'openrouter',
    escalatedMaxTokens: () => scenario.escalated ?? null,
    async send(sent, _model, _tools, opts) {
      requests.push({
        override: opts?.maxOutputTokensOverride ?? null,
        toolChoice: opts?.toolChoice ?? null,
        messages: sent.map((m) => ({
          role: m.role,
          content: normalizeContent(m.content),
          toolCallId: m.toolCallId ?? null,
        })),
      });
      sends += 1;
      const index = scenario.repeatLast ? Math.min(sends, scenario.script.length) - 1 : sends - 1;
      const entry = scenario.script[index];
      if (!entry) throw new Error(`script exhausted at send ${sends}`);
      return structuredClone(entry);
    },
  };
  const queues = structuredClone(scenario.steer || {});
  const sendOpts = {
    session,
    sessionId: scopeId,
    ...(scenario.limits ? { turnLimits: scenario.limits } : {}),
    drainSteering: (_sid, { stage }) => (queues[stage] || []).splice(0).map((text) => ({ content: text, ids: ['q1'] })),
  };
  let result;
  let error = null;
  try {
    result = await agentLoop(provider, messages, scenario.model ?? 'fixture-model', session.tools, null, session.cwd, sendOpts);
  } catch (e) {
    error = String(e?.message || e);
  } finally {
    unregister?.();
  }
  return {
    messages: messages.map(normalizeMessage),
    result: result && {
      content: result.content ?? '',
      historyContent: result.historyContent ?? null,
      reportContent: result.reportContent ?? null,
      terminationReason: result.terminationReason ?? null,
      iterations: result.iterations,
      toolCallsTotal: result.toolCallsTotal,
      maxOutputRecoveryAttempts: result.maxOutputRecoveryAttempts ?? null,
      providerContinuations: result.providerContinuations ?? 0,
    },
    error,
    requests,
  };
}

const out = (dir, name, value) => {
  mkdirSync(join(stage, dir), { recursive: true });
  writeFileSync(join(stage, dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
};

try {
  for (const scenario of scenarios) {
    out('scenarios', scenario.name, scenario);
    out('golden', scenario.name, await record(scenario));
    process.stdout.write(`recorded ${scenario.name}\n`);
  }
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
refreshSetManifest(stage, nodeRoot);
commitStage(stage, here);
process.exit(0);
