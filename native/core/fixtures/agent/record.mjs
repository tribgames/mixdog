// Records the golden transcripts of the Node agent loop.
//
//   node native/core/fixtures/agent/record.mjs [--tree <node checkout with node_modules>]
//
// Each scenario is a scripted provider (the same script the Rust loop replays
// in `crates/mixdog-agent/tests/golden.rs`). The Node loop runs it through the
// public `agentLoop` entry point and the normalized transcript, result fields
// and the requests it built are written to `golden/<name>.json`. Scenarios
// themselves are written to `scenarios/<name>.json`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, exactProductIdentity, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';
import { recorderProvenance } from '../../../../benchmarks/rust-core/recorders/lib/provenance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
// The agent set is shared with the other recorders: stage a copy, replace only
// the directories this recorder owns, re-list the manifest, then swap it in.
const stage = stageSet(here, ['golden', 'scenarios']);
const loopDir = join(nodeRoot, 'src/runtime/agent/orchestrator');
const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-agent-golden-'));
process.env.MIXDOG_DATA_DIR = dataRoot;
// A retried send waits no time (the retry is what a scenario records, not its pause).
process.env.MIXDOG_TRANSPORT_RETRY_BACKOFF_MS = '0,0,0';

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
  // The escalation is one-shot whatever happens to the send it rode on (agent-loop-output-escalation.test.mjs): the retry of the
  // escalated send, which fails the way Gemini's cut function call does, goes out without the override.
  {
    name: 'output_limit_escalation_transport_retry',
    messages: [user('go')],
    escalated: 128000,
    script: [cut('', 'max_tokens'), { throw: 'malformed_function_call' }, turn('done', 'end_turn')],
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
  // No cap on how long a turn may run (agent-loop-step-limit.test.mjs): 45 rounds of calls that fail, or of the same call with
  // the same result, end in the model's own answer; the loop neither stops the turn nor tells the model to reply.
  {
    name: 'uncapped_failing_rounds',
    messages: [user('go')],
    script: [...Array.from({ length: 45 }, (_, i) => toolTurn(`step ${i + 1}`, call(`c${i + 1}`, 'probe', { path: 'a.txt' }))), turn('final answer', 'end_turn')],
  },
  {
    name: 'uncapped_replayed_rounds',
    messages: [user('go')],
    script: [...Array.from({ length: 45 }, (_, i) => toolTurn(`step ${i + 1}`, call(`c${i + 1}`, 'echo', { path: 'a.txt' }))), turn('final answer', 'end_turn')],
  },
  // The text a reply streams reaches the turn's delta hook whole and in order (agent-loop.test.mjs, "preserves text deltas").
  {
    name: 'text_deltas_reach_the_hook',
    messages: [user('go')],
    captureDeltas: true,
    script: [{ ...toolTurn('Now let me look', call('c1', 'echo', { a: 1 })), deltas: ['Now let ', 'me look'] }, { ...turn('final answer', 'end_turn'), deltas: ['final ', 'answer'] }],
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
      // The reply streams its text through the loop's own delta hook before it settles.
      for (const delta of entry.deltas ?? []) opts?.onTextDelta?.(delta);
      // A send the provider fails the way Gemini does when it cuts a function call short: the loop retries it.
      if (entry.throw === 'malformed_function_call') {
        throw Object.assign(new Error('Gemini response incomplete: finishReason=MALFORMED_FUNCTION_CALL'), {
          providerIncomplete: true,
          code: 'PROVIDER_INCOMPLETE',
          finishReason: 'MALFORMED_FUNCTION_CALL',
          partialContent: '',
        });
      }
      return structuredClone(entry);
    },
  };
  const queues = structuredClone(scenario.steer || {});
  const deltas = [];
  const sendOpts = {
    session,
    sessionId: scopeId,
    ...(scenario.captureDeltas ? { onTextDelta: (chunk) => deltas.push(chunk) } : {}),
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
    ...(scenario.captureDeltas ? { deltas } : {}),
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
// `exclusions` is a list of {path, scope, reason}: the entries the set already holds stay, this recorder's own is added once.
const loopEvents = {
  path: 'golden/*.json',
  scope: '"deltas": run events other than the text deltas',
  reason: 'the loop reports to its caller only through the hooks the caller passes (agent-loop.mjs:42-49, sendOpts); this recorder installs onTextDelta alone, so Node produced no stage, tool-call, usage, steering or compaction events here and the Rust run\'s RunEvent variants other than TextDelta have no recorded counterpart in this set. What the loop did around them is compared through the transcript, the result and the requests of every scenario',
};
const held = JSON.parse(readFileSync(join(stage, 'MANIFEST.json'), 'utf8')).exclusions ?? [];
refreshSetManifest(stage, nodeRoot, 'HEAD', { exclusions: [...held.filter((e) => e.path !== loopEvents.path || e.scope !== loopEvents.scope), loopEvents] });
// The set's manifest also states what made it: this recorder, every module it loads and the Node that ran it.
const manifestPath = join(stage, 'MANIFEST.json');
const manifest = { ...JSON.parse(readFileSync(manifestPath, 'utf8')), ...recorderProvenance(import.meta.url), product: exactProductIdentity(nodeRoot, 'b6f10295a2f698afc85332467192de28500bd146') };
writeFileSync(manifestPath, `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`);
commitStage(stage, here);
process.exit(0);
