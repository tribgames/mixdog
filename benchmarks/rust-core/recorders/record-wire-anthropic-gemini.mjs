#!/usr/bin/env node
// The requests Node sends to Anthropic (subscription route) and to Gemini (API key), as the REAL provider classes put
// them on the wire: `AnthropicOAuthProvider.send` and `GeminiProvider.send` run over scripted conversations (a first
// turn, a tool-result turn, a long thread, a resumed and a compacted thread, per model family), with the network
// replaced by a recorder that answers each request with the scripted reply and writes down what was sent: method, url,
// every header and the whole body (a gzip body decoded). The answers are stored beside the requests, so the Rust test
// feeds the adapter the same ones and compares the whole request sequence.
//
//   node benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs --tree <exact export of b6f10295a>
//
// Output: native/core/fixtures/wire-anthropic-gemini/{anthropic,gemini}.json and MANIFEST.json (the manifest names
// the commit and fails unless the tree is exactly it). Credentials are fake; the global dispatcher is replaced by one
// that refuses every connection, so nothing can reach a network (Node's `preconnect` would otherwise send a HEAD).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, exactProductIdentity, parseArgs, resolveTree, writeSetManifest } from './lib/common.mjs';
import { nodeRealTool, writeJsonCompact } from './lib/tool-definitions.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const OUT = join(FIXTURES_ROOT, 'wire-anthropic-gemini');

const dataDir = mkdtempSync(join(tmpdir(), 'wire-anthropic-gemini-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
const FAKE = 'fake-credential-not-a-secret';
const put = (file, value) => writeFileSync(join(dataDir, file), JSON.stringify(value));
// The access token the Rust test's credential file holds too (`MemoryStore`), so `authorization` is compared as it is.
put('anthropic-oauth-credentials.json', {
  claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference'] },
});
put('gemini-api-key.json', { apiKey: FAKE });

const load = (path) => import(pathToFileURL(join(tree, path)).href);
const P = 'src/runtime/agent/orchestrator/providers/';

// No connection of any kind leaves this process.
const { Dispatcher, setGlobalDispatcher } = await import(pathToFileURL(join(tree, 'node_modules/undici/index.js')).href);
setGlobalDispatcher(
  new (class NoNetwork extends Dispatcher {
    dispatch() {
      throw new Error('the recorder allows no network connection');
    }
  })()
);

// ---- the recording fetch ----

let script = [];
// When set, answers each request by what it is (the Gemini sends: a cache create, a generate call, a delete) and the
// answer is stored on the request itself.
let responder = null;
let captured = [];
const bodyText = (body, headers) => {
  if (typeof body === 'string') return body;
  const bytes = Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
  return new Headers(headers).get('content-encoding') === 'gzip' ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
};
globalThis.fetch = async (url, init = {}) => {
  const headers = Object.fromEntries(new Headers(init.headers || {}));
  captured.push({ method: init.method || 'GET', url: String(url), headers, body: init.body == null ? null : bodyText(init.body, headers) });
  const reply = responder ? responder(captured.at(-1)) : script.shift();
  if (!reply) throw new Error(`no scripted reply for ${init.method} ${url}`);
  if (responder) captured.at(-1).reply = { status: reply.status, body: reply.body };
  return new Response(reply.body, { status: reply.status, headers: reply.headers || { 'content-type': reply.json ? 'application/json' : 'text/event-stream' } });
};

// ---- scripted conversations ----

const SYSTEM = [
  { role: 'system', content: '# Tool Calls\n\n- Group calls already known to be needed in one response.\n- Order on files: enumerate only when the scope is unknown.\n'.repeat(40) },
  { role: 'system', content: '# Profile\n\nThe user prefers short answers.\n\n# Skills\n\n- review: check a diff\n'.repeat(30) },
  { role: 'system', content: '# Workflow\n\nThe lead plans, workers edit.\n'.repeat(20), cacheTier: 'tier3' },
  { role: 'system', content: '# Session\n\nCwd: C:/work/project\nModel: the session model\n', cacheTier: 'env' },
];
const TOOL_NAMES = ['read', 'grep', 'glob'];
const SESSION = 'wire-session';
const SSE = (events) => events.map(({ type, ...rest }) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`).join('');

/** The SSE the API answers with for a reply of `blocks` ({ text } or { call }) ending in `stop`. */
function anthropicReply(id, model, blocks, stop) {
  const events = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 20, output_tokens: 1 } } }];
  blocks.forEach((block, index) => {
    if ('text' in block) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.call.id, name: block.call.name, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.call.arguments) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 12 } });
  events.push({ type: 'message_stop' });
  return SSE(events);
}

const assistantOf = (blocks) => ({
  role: 'assistant',
  content: blocks.filter((b) => 'text' in b).map((b) => b.text).join(''),
  ...(blocks.some((b) => b.call) ? { toolCalls: blocks.filter((b) => b.call).map((b) => b.call) } : {}),
});

/**
 * A conversation: `turns` run in order, each one a send. A turn is `{ blocks, stop }` (the reply) plus what is appended
 * for the next send: the tool results of its calls, or the next user message.
 */
function conversation({ id, model, tools = TOOL_NAMES, history = [], user, turns, opts = {}, reminder }) {
  return { id, model, tools, history, user, turns, opts, reminder };
}

const callOf = (n, name = 'read') => ({ id: `toolu_${String(n).padStart(2, '0')}`, name, arguments: { path: `src/file${n}.rs` } });
const toolTurn = (n, text) => ({ blocks: [{ text }, { call: callOf(n) }], stop: 'tool_use', results: [`contents of file ${n}`] });
const finalTurn = (text) => ({ blocks: [{ text }], stop: 'end_turn' });

const ANTHROPIC_MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5-20251001',
  legacy: 'claude-3-7-sonnet-20250219',
};

const longTurns = () => [
  ...Array.from({ length: 12 }, (_, i) => toolTurn(i + 1, `Reading file ${i + 1}.`)),
  { ...finalTurn('All twelve files are read.'), next: 'Now summarize them.' },
  finalTurn('Summary: twelve files.'),
];

const PRIOR = [
  { role: 'user', content: 'Refactor the parser.' },
  { role: 'assistant', content: 'Reading it.', toolCalls: [callOf(90)] },
  { role: 'tool', toolCallId: 'toolu_90', content: 'export function parse() {}' },
  { role: 'assistant', content: 'The parser is small.' },
];

const anthropicScenarios = [];
for (const [family, model] of Object.entries(ANTHROPIC_MODELS)) {
  anthropicScenarios.push(conversation({ id: `${family}.first-turn`, model, user: 'Look up the answer.', turns: [finalTurn('The result is 42.')] }));
  anthropicScenarios.push(conversation({ id: `${family}.tool-result-turn`, model, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), finalTurn('The result is 42.')] }));
  anthropicScenarios.push(conversation({ id: `${family}.long-thread`, model, user: 'Read every file.', turns: longTurns() }));
  // A resumed thread: a process with no thread state sends the whole stored history, then continues it.
  anthropicScenarios.push(conversation({ id: `${family}.resumed`, model, history: PRIOR, user: 'Now add tests.', turns: [toolTurn(1, 'Adding a test.'), finalTurn('Tests added.')] }));
  // A compacted thread: after two sends the history is replaced by a summary, the next send creates.
  anthropicScenarios.push(conversation({ id: `${family}.compacted`, model, user: 'Read every file.', turns: [toolTurn(1, 'Reading.'), toolTurn(2, 'Reading more.'), { ...finalTurn('Read.'), compactTo: '<summary>Two files were read.</summary>' }, finalTurn('Continuing after the summary.')] }));
}
// A tail reminder: legacy layout on Sonnet, turn-scoped on Opus.
for (const family of ['opus', 'sonnet']) {
  anthropicScenarios.push(conversation({ id: `${family}.tail-reminder`, model: ANTHROPIC_MODELS[family], user: 'Look up the answer.', reminder: '<system-reminder>Write all user-facing text in Korean.</system-reminder>', turns: [toolTurn(1, 'Reading it.'), finalTurn('The result is 42.')] }));
}
// Requests Node never threads.
anthropicScenarios.push(conversation({ id: 'opus.no-session', model: ANTHROPIC_MODELS.opus, user: 'Look up the answer.', opts: { sessionId: null }, turns: [toolTurn(1, 'Reading it.'), finalTurn('Done.')] }));
anthropicScenarios.push(conversation({ id: 'opus.compaction-kind', model: ANTHROPIC_MODELS.opus, user: 'Summarize.', opts: { requestKind: 'compaction' }, turns: [finalTurn('Summary.')] }));
anthropicScenarios.push(conversation({ id: 'opus.shared-prefix-fork', model: ANTHROPIC_MODELS.opus, history: PRIOR, user: '<side-question>Where is parse?</side-question>', opts: { sharedCachePrefixCount: 5 }, turns: [finalTurn('In parser.rs.')] }));
anthropicScenarios.push(conversation({ id: 'opus.deferred-tool', model: ANTHROPIC_MODELS.opus, tools: ['read', { name: 'grep', deferLoading: true }], user: 'Look up the answer.', turns: [finalTurn('The result is 42.')] }));

async function runAnthropic(realTool) {
  const { AnthropicOAuthProvider } = await load(`${P}anthropic-oauth.mjs`);
  const threads = await load(`${P}anthropic-message-threads.mjs`);
  // The catalog lists the models by id only (no capability rows, so the release-generation floor decides the
  // request); a model the catalog already lists is not followed by Node's background `GET /v1/models` refresh.
  (await load(`${P}anthropic-model-resolve.mjs`))._setInMemoryCatalog(Object.values(ANTHROPIC_MODELS).map((id) => ({ id })));
  const out = [];
  for (const scenario of anthropicScenarios) {
    threads._threadTest.reset();
    const provider = new AnthropicOAuthProvider({});
    const tools = scenario.tools.map((t) => (typeof t === 'string' ? realTool(t) : { ...realTool(t.name), deferLoading: t.deferLoading }));
    const opts = { sessionId: SESSION, ...scenario.opts };
    let messages = [...SYSTEM, ...scenario.history, { role: 'user', content: scenario.user }];
    const sends = [];
    for (const turn of scenario.turns) {
      const sent = scenario.reminder ? [...messages, { role: 'user', content: scenario.reminder, meta: { source: 'tail-reminder' } }] : messages;
      const reply = anthropicReply(`msg_${scenario.id}_${sends.length}`, scenario.model, turn.blocks, turn.stop);
      script = [{ status: 200, body: reply }];
      captured = [];
      const result = await provider.send(structuredClone(sent), scenario.model, structuredClone(tools), { ...opts });
      // Node's own signal that the response the thread stores has been confirmed.
      await result.threadReceipt?.pending;
      sends.push({ messages: sent, opts: { ...opts }, replies: [{ status: 200, body: reply }], requests: captured });
      const assistant = assistantOf(turn.blocks);
      if (scenario.reminder && scenario.model === ANTHROPIC_MODELS.opus) assistant.turnReminder = scenario.reminder;
      if (turn.compactTo) {
        messages = [...SYSTEM, { role: 'user', content: turn.compactTo }];
      } else {
        messages = [...messages, assistant, ...(turn.results || []).map((content, i) => ({ role: 'tool', toolCallId: turn.blocks.filter((b) => b.call)[i].call.id, content }))];
        if (turn.next) messages.push({ role: 'user', content: turn.next });
      }
    }
    out.push({ id: scenario.id, model: scenario.model, tools, sends });
  }
  return out;
}

// ---- Gemini ----

// Node's time for the Gemini sends is a virtual queue: `Date.now` and `setTimeout` follow `clock`, and a timer runs
// only when `advance` reaches it (due time, then registration order, one callback at a time, microtasks drained
// between callbacks). The scheduled delete of a superseded cache therefore fires where the scenario's own gaps put it.
const clock = { now: 0, seq: 0, timers: new Map() };
function installVirtualTime() {
  Date.now = () => clock.now;
  globalThis.setTimeout = (fn, ms = 0, ...rest) => {
    const id = ++clock.seq;
    clock.timers.set(id, { id, due: clock.now + Math.max(0, Number(ms) || 0), fn, rest });
    return { id, unref() { return this; }, ref() { return this; }, hasRef: () => true, [Symbol.toPrimitive]: () => id };
  };
  globalThis.clearTimeout = (timer) => void clock.timers.delete(timer?.id ?? timer);
}
const drain = () => new Promise((resolve) => setImmediate(resolve));
async function advance(ms) {
  const target = clock.now + ms;
  for (;;) {
    const due = [...clock.timers.values()].filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
    if (!due) break;
    clock.timers.delete(due.id);
    clock.now = Math.max(clock.now, due.due);
    due.fn(...due.rest);
    await drain();
  }
  clock.now = target;
  await drain();
}

const GEMINI_MODELS = {
  pro25: 'gemini-2.5-pro',
  flash25: 'gemini-2.5-flash',
  lite25: 'gemini-2.5-flash-lite',
  g3pro: 'gemini-3-pro-preview',
  g36: 'gemini-3.6-flash',
  g4: 'gemini-4-argon',
};
const GEMINI_SYSTEM = SYSTEM.map(({ role, content }) => ({ role, content: content.repeat(2) }));
const SMALL_SYSTEM = [{ role: 'system', content: 'You are brief.' }];
const T0 = Date.parse('2026-11-09T12:00:00Z');
const AFTER_REDIRECT = Date.parse('2026-12-02T12:00:00Z');

function geminiReply(blocks) {
  const parts = blocks.map((b) => ('text' in b ? { text: b.text } : { functionCall: { id: b.call.id, name: b.call.name, args: b.call.arguments } }));
  const chunk = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 12, totalTokenCount: 5012 } };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

const geminiScenarios = [];
const gemini = (s) => geminiScenarios.push({ system: GEMINI_SYSTEM, history: [], opts: {}, start: T0, gapMs: 10_000, tools: TOOL_NAMES, ...s });
for (const [family, model] of Object.entries(GEMINI_MODELS)) {
  gemini({ id: `${family}.first-turn`, model, user: 'Look up the answer.', turns: [finalTurn('The result is 42.')] });
  gemini({ id: `${family}.tool-result-turn`, model, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), finalTurn('The result is 42.')] });
}
for (const family of ['pro25', 'g3pro']) {
  gemini({ id: `${family}.long-thread`, model: GEMINI_MODELS[family], user: 'Read every file.', turns: longTurns() });
}
for (const family of ['pro25', 'g3pro']) {
  const model = GEMINI_MODELS[family];
  gemini({ id: `${family}.resumed`, model, history: PRIOR, user: 'Now add tests.', turns: [toolTurn(1, 'Adding a test.'), finalTurn('Tests added.')] });
  gemini({ id: `${family}.compacted`, model, user: 'Read every file.', turns: [toolTurn(1, 'Reading.'), toolTurn(2, 'Reading more.'), { ...finalTurn('Read.'), compactTo: '<summary>Two files were read.</summary>' }, finalTurn('Continuing after the summary.')] });
  // A new process (empty cache registry) resumes a session whose saved state names a live cache.
  gemini({ id: `${family}.resumed-with-state`, model, user: 'Read every file.', turns: [toolTurn(1, 'Reading.'), { ...toolTurn(2, 'Reading more.'), freshProcess: true }, finalTurn('Done.')] });
  // The gap outlives the cache: the next send rebuilds.
  gemini({ id: `${family}.expired-cache`, model, user: 'Read every file.', gapMs: 400_000, turns: [toolTurn(1, 'Reading.'), toolTurn(2, 'Reading more.'), finalTurn('Done.')] });
  gemini({ id: `${family}.fork`, model, user: 'Read every file.', turns: [toolTurn(1, 'Reading.'), { ...finalTurn('Done.'), next: '<side-question>Where is parse?</side-question>' }, { ...finalTurn('In parser.rs.'), opts: { sharedCachePrefixCount: 8 } }] });
}
gemini({ id: 'pro25.small-prefix', model: GEMINI_MODELS.pro25, system: SMALL_SYSTEM, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), finalTurn('Done.')] });
gemini({ id: 'pro25.efforts', model: GEMINI_MODELS.pro25, opts: { effort: 'high' }, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), finalTurn('Done.')] });
gemini({ id: 'g3pro.temperature', model: GEMINI_MODELS.g3pro, opts: { temperature: 0.7 }, user: 'Look up the answer.', turns: [finalTurn('Done.')] });
gemini({ id: 'g36.temperature', model: GEMINI_MODELS.g36, opts: { temperature: 0.7 }, user: 'Look up the answer.', turns: [finalTurn('Done.')] });
// Google serves gemini-2.5-pro and gemini-2.5-flash as other models from 2026-12-01.
for (const family of ['pro25', 'flash25', 'lite25']) {
  gemini({ id: `${family}.after-redirect`, model: GEMINI_MODELS[family], start: AFTER_REDIRECT, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), finalTurn('Done.')] });
}

async function runGemini(realTool) {
  const { GeminiProvider } = await load(`${P}gemini.mjs`);
  const cache = await load(`${P}gemini-cache.mjs`);
  const resetRegistry = () => {
    cache._invalidateGeminiCachesForCredentialFingerprint(cache._geminiCredentialFingerprint(FAKE));
    cache.geminiGlobalCacheCreates.clear();
  };
  const out = [];
  for (const scenario of geminiScenarios) {
    resetRegistry();
    clock.timers.clear();
    clock.now = scenario.start;
    const provider = new GeminiProvider({ apiKey: FAKE });
    const tools = scenario.tools.map((t) => realTool(t));
    let providerState;
    let messages = [...scenario.system, ...scenario.history, { role: 'user', content: scenario.user }];
    const sends = [];
    let creates = 0;
    for (const turn of scenario.turns) {
      if (turn.freshProcess) resetRegistry();
      const reply = geminiReply(turn.blocks);
      responder = (entry) => {
        if (entry.method === 'DELETE') return { status: 200, body: '{}', json: true };
        if (entry.url.endsWith('/v1beta/cachedContents')) {
          creates += 1;
          return { status: 200, json: true, body: JSON.stringify({ name: `cachedContents/${scenario.id}-${creates}`, usageMetadata: { totalTokenCount: 5000 + creates } }) };
        }
        return { status: 200, body: reply };
      };
      captured = [];
      const opts = { sessionId: SESSION, iteration: sends.length + 1, ...scenario.opts, ...(turn.opts || {}), ...(providerState ? { providerState } : {}) };
      const before = structuredClone(opts);
      const at = clock.now;
      await provider.send(structuredClone(messages), scenario.model, structuredClone(tools), opts);
      // The scheduled delete of a superseded cache fires inside the gap that follows the send.
      await advance(turn.gapMs ?? scenario.gapMs);
      providerState = opts.providerState;
      sends.push({ messages: structuredClone(messages), opts: before, now: at, gapMs: turn.gapMs ?? scenario.gapMs, providerStateAfter: structuredClone(opts.providerState ?? null), freshProcess: turn.freshProcess === true, requests: captured });
      const assistant = assistantOf(turn.blocks);
      if (turn.compactTo) {
        messages = [...scenario.system, { role: 'user', content: turn.compactTo }];
      } else {
        messages = [...messages, assistant, ...(turn.results || []).map((content, i) => ({ role: 'tool', toolCallId: turn.blocks.filter((b) => b.call)[i].call.id, content }))];
        if (turn.next) messages.push({ role: 'user', content: turn.next });
      }
    }
    out.push({ id: scenario.id, model: scenario.model, tools, sends });
  }
  responder = null;
  return out;
}

const realTool = await nodeRealTool(tree);
const anthropic = await runAnthropic(realTool);
installVirtualTime();
const geminiRuns = await runGemini(realTool);
rmSync(OUT, { recursive: true, force: true });
await writeJsonCompact(tree, join(OUT, 'anthropic.json'), { recorder: 'benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs', scenarios: anthropic });
await writeJsonCompact(tree, join(OUT, 'gemini.json'), { recorder: 'benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs', scenarios: geminiRuns });
writeSetManifest(OUT, {
  set: 'wire-anthropic-gemini',
  recorder: 'benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs',
  command: 'node benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs --tree <exact export of b6f10295a>',
  identity,
});
rmSync(dataDir, { recursive: true, force: true });
console.log(`recorded ${anthropic.length} anthropic and ${geminiRuns.length} gemini scenarios`);
process.exit(0);
