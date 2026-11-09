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
// A ledger row's `day` is the local day; the recording is the same on every machine only in one zone.
process.env.TZ = 'UTC';
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

// The ledger rows of the Gemini sends: the real `accountProviderSend` runs over each send and its row is captured
// where the ledger worker would take it. Prices come from the catalogs the runtime caches in its data directory, which
// is empty here, so nothing is priced (as on a machine that has not fetched them).
process.env.MIXDOG_USAGE_LEDGER_PATH = join(dataDir, 'ledger.sqlite');
const { UsageLedger, closeUsageLedgers } = await load('src/runtime/shared/llm/usage-ledger.mjs');
const { accountProviderSend } = await load('src/runtime/shared/llm/usage-accounting.mjs');
const { sanitizeToolPairs } = await load('src/runtime/agent/orchestrator/session/context-utils.mjs');
const { createNoticeSurface } = await load('src/tui/session/notice-surface.mjs');
let ledgerRows = [];
UsageLedger.prototype.recordQueued = async function recordQueued(row) {
  ledgerRows.push(row);
};
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const ledgerView = (row) => ({ ...row, id: row.id.replace(REQUEST_ID, '<req>'), rates: JSON.stringify(row.rates) });

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
// A reply with `chunks` arrives in pieces: the first at once, the rest when `release()` is called if the reply is held
// (`hold`), else straight after. The body then ends. `released` collects the releases of held replies.
let held = [];
const replyBody = (reply) => {
  if (!reply.chunks) return reply.body;
  const encoder = new TextEncoder();
  let release;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(reply.chunks[0]));
      release = () => {
        for (const chunk of reply.chunks.slice(1)) controller.enqueue(encoder.encode(chunk));
        controller.close();
      };
      if (!reply.hold) release();
    },
  });
  if (reply.hold) held.push(release);
  return stream;
};
globalThis.fetch = async (url, init = {}) => {
  const headers = Object.fromEntries(new Headers(init.headers || {}));
  captured.push({ method: init.method || 'GET', url: String(url), headers, body: init.body == null ? null : bodyText(init.body, headers) });
  const reply = responder ? responder(captured.at(-1)) : script.shift();
  if (!reply) throw new Error(`no scripted reply for ${init.method} ${url}`);
  if (responder) captured.at(-1).reply = { status: reply.status, body: reply.body };
  return new Response(replyBody(reply), { status: reply.status, headers: reply.headers || { 'content-type': reply.json ? 'application/json' : 'text/event-stream' } });
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

/** The SSE cut short: a message that starts and says some text, then ends with no `message_stop`. */
function truncatedReply(id, model) {
  return SSE([
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading' } },
  ]);
}

/** A reply in two pieces: everything up to the `message_stop` frame, then that frame. */
function splitAtStop(sse) {
  const at = sse.indexOf('event: message_stop');
  return [sse.slice(0, at), sse.slice(at)];
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
function conversation({ id, model, tools = TOOL_NAMES, history = [], user, turns, opts = {}, reminder, repaired = false }) {
  return { id, model, tools, history, user, turns, opts, reminder, repaired };
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
// A reminder with no text rides nothing, so it does not stop threading (`carriesLegacyTailReminder`).
for (const family of ['opus', 'sonnet']) {
  anthropicScenarios.push(conversation({ id: `${family}.empty-tail-reminder`, model: ANTHROPIC_MODELS[family], user: 'Look up the answer.', reminder: '', turns: [toolTurn(1, 'Reading it.'), finalTurn('The result is 42.')] }));
}
// A transcript the lowering has to repair: a tool call whose id has characters the API refuses, a result no call asked
// for, a call with no result, an assistant turn with no content, an empty user message and two user messages in a row.
const UNCLEAN = [
  { role: 'user', content: 'Refactor the parser.' },
  { role: 'assistant', content: 'Reading it.', toolCalls: [{ id: 'call:bad id/1', name: 'read', arguments: { path: 'a.rs' } }] },
  { role: 'tool', toolCallId: 'call:bad id/1', content: 'export function parse() {}' },
  { role: 'tool', toolCallId: 'call_ghost', content: 'a result nobody asked for' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_unanswered', name: 'grep', arguments: { pattern: 'parse' } }] },
  { role: 'user', content: '' },
  { role: 'user', content: 'Where is it used?' },
  { role: 'assistant', content: '' },
];
for (const family of ['opus', 'sonnet', 'legacy']) {
  anthropicScenarios.push(conversation({ id: `${family}.sanitized-lowering`, model: ANTHROPIC_MODELS[family], history: UNCLEAN, repaired: true, user: 'And in tests?', turns: [toolTurn(1, 'Searching.'), finalTurn('Found.')] }));
}
// What only the content-pair sanitizer of the lowering repairs (the pairing before it does not see it): a replayed
// assistant turn whose tool call never got an id (a streaming chunk that did not finish).
const IDLESS_CALL = [
  { role: 'user', content: 'Check the parser.' },
  { role: 'assistant', content: 'Checking.', assistantBlocks: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', name: 'read', input: { path: 'a.rs' } }] },
  { role: 'user', content: 'Go on.' },
  { role: 'assistant', content: 'Done.' },
];
for (const family of ['opus', 'sonnet', 'legacy']) {
  anthropicScenarios.push(conversation({ id: `${family}.idless-tool-call`, model: ANTHROPIC_MODELS[family], history: IDLESS_CALL, repaired: true, user: 'And now?', turns: [finalTurn('Fine.')] }));
}
// The confirmation that the API stored a tool-use answer (`message_stop`) arrives after the turn ended: before the next
// send (it continues the thread), or only after the next send began (that send creates, and the late one is ignored).
anthropicScenarios.push(conversation({ id: 'sonnet.receipt-before-next-send', model: ANTHROPIC_MODELS.sonnet, user: 'Read every file.', turns: [{ ...toolTurn(1, 'Reading.'), split: true }, { ...toolTurn(2, 'Reading more.'), split: true }, finalTurn('Done.')] }));
anthropicScenarios.push(conversation({ id: 'sonnet.receipt-after-next-send', model: ANTHROPIC_MODELS.sonnet, user: 'Read every file.', turns: [{ ...toolTurn(1, 'Reading.'), split: true, receipt: 'after' }, { ...toolTurn(2, 'Reading more.'), split: true }, finalTurn('Done.')] }));
anthropicScenarios.push(conversation({ id: 'opus.receipt-after-next-send', model: ANTHROPIC_MODELS.opus, user: 'Read every file.', turns: [{ ...toolTurn(1, 'Reading.'), split: true, receipt: 'after' }, { ...toolTurn(2, 'Reading more.'), split: true }, finalTurn('Done.')] }));
// Failures inside a send: the stream is cut before `message_stop` (Node resends a dropped continue as it was, then
// replays it as a create), and the API refuses the thread (replay, or no threads for the conversation).
const cut = (id, model) => ({ status: 200, body: truncatedReply(id, model) });
const refusal = (code, extra = {}) => () => ({ status: 400, json: true, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `The thread request cannot be served (${code}).`, details: { error_code: code, ...extra } } }) });
anthropicScenarios.push(conversation({ id: 'sonnet.stream-cut-create', model: ANTHROPIC_MODELS.sonnet, user: 'Look up the answer.', turns: [{ ...toolTurn(1, 'Reading it.'), before: [cut] }, finalTurn('The result is 42.')] }));
anthropicScenarios.push(conversation({ id: 'sonnet.stream-cut-continue', model: ANTHROPIC_MODELS.sonnet, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), { ...toolTurn(2, 'Reading more.'), before: [cut] }, { ...finalTurn('The result is 42.'), before: [cut, cut] }, finalTurn('Once more.')] }));
anthropicScenarios.push(conversation({ id: 'sonnet.thread-not-found', model: ANTHROPIC_MODELS.sonnet, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), { ...toolTurn(2, 'Reading more.'), before: [refusal('thread_not_found')] }, finalTurn('The result is 42.')] }));
anthropicScenarios.push(conversation({ id: 'sonnet.thread-unsupported', model: ANTHROPIC_MODELS.sonnet, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), { ...toolTurn(2, 'Reading more.'), before: [refusal('thread_unsupported_request', { unsupported: ['context_management'] })] }, finalTurn('The result is 42.')] }));
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
  // What Node's catalog answers of each model with that catalog: the inputs of the request builder, asked of the same
  // functions it asks (anthropic-effort.mjs, anthropic-thinking-contract.mjs, anthropic-max-tokens.mjs).
  const effort = await load('src/runtime/shared/llm/anthropic-effort.mjs');
  const contract = await load('src/runtime/shared/llm/anthropic-thinking-contract.mjs');
  const limits = await load(`${P}anthropic-max-tokens.mjs`);
  const sharedCatalog = await load('src/runtime/shared/llm/model-catalog.mjs');
  const capabilities = Object.fromEntries(
    Object.values(ANTHROPIC_MODELS).map((id) => [
      id,
      {
        supportsEffort: effort.modelSupportsEffort(id),
        supportsXhighEffort: effort.modelSupportsXhighEffort(id),
        supportsMaxEffort: effort.modelSupportsMaxEffort(id),
        adaptiveOnly: effort.isAnthropicAdaptiveOnlyModel(id),
        effortBeta: effort.shouldIncludeEffortBeta(id, {}),
        effortLevels: effort.anthropicEffortLevelsFor(id),
        progressUpdates: contract.emitsAnthropicProgressUpdates(id),
        turnScopedSystemMessages: contract.supportsAnthropicTurnScopedSystemMessages(id),
        declaredOutputTokens: sharedCatalog.getModelMetadataSync(id, 'anthropic')?.outputTokens ?? null,
        maxTokens: limits.resolveAnthropicMaxTokens(id, {}),
      },
    ])
  );
  const out = [];
  for (const scenario of anthropicScenarios) {
    threads._threadTest.reset();
    const provider = new AnthropicOAuthProvider({});
    const tools = scenario.tools.map((t) => (typeof t === 'string' ? realTool(t) : { ...realTool(t.name), deferLoading: t.deferLoading }));
    const opts = { sessionId: SESSION, ...scenario.opts };
    let messages = [...SYSTEM, ...scenario.history, { role: 'user', content: scenario.user }];
    const sends = [];
    // The sends whose confirmation (`message_stop`) is held back until the send after them is over.
    let late = [];
    for (const turn of scenario.turns) {
      const sent = scenario.reminder !== undefined ? [...messages, { role: 'user', content: scenario.reminder, meta: { source: 'tail-reminder' } }] : messages;
      const id = `msg_${scenario.id}_${sends.length}`;
      const reply = anthropicReply(id, scenario.model, turn.blocks, turn.stop);
      // One answer per request Node makes: the scripted failures first, then the reply (in pieces when it is split).
      const replies = [
        ...(turn.before || []).map((failure) => failure(id, scenario.model)),
        turn.split ? { status: 200, chunks: splitAtStop(reply), hold: turn.receipt === 'after' } : { status: 200, body: reply },
      ];
      script = replies.map((r) => ({ ...r }));
      held = [];
      captured = [];
      const result = await provider.send(structuredClone(sent), scenario.model, structuredClone(tools), { ...opts });
      const release = held.shift();
      if (release) late.push({ release, result });
      else {
        // Node's own signal that the response the thread stores has been confirmed.
        await result.threadReceipt?.pending;
      }
      // Node's provider pairs every call with a result before it builds the body (`sanitizeToolPairs`); the core does
      // that earlier, in the agent (`repair_before_send`), so a provider receives these. The recording names them for
      // the scenarios that need it, and the agent crate compares its repair with the same Node function.
      const paired = scenario.repaired ? sanitizeToolPairs(structuredClone(sent)) : undefined;
      sends.push({ messages: sent, ...(paired ? { pairedMessages: paired } : {}), opts: { ...opts }, replies, receipt: turn.receipt || 'before', requests: captured });
      // The confirmations held back by earlier sends arrive now, after this one is over.
      for (const { release: confirm, result: earlier } of late.splice(0, late.length - (release ? 1 : 0))) {
        confirm();
        await earlier.threadReceipt?.pending;
      }
      const assistant = assistantOf(turn.blocks);
      if (scenario.reminder && scenario.model === ANTHROPIC_MODELS.opus) assistant.turnReminder = scenario.reminder;
      if (turn.compactTo) {
        messages = [...SYSTEM, { role: 'user', content: turn.compactTo }];
      } else {
        messages = [...messages, assistant, ...(turn.results || []).map((content, i) => ({ role: 'tool', toolCallId: turn.blocks.filter((b) => b.call)[i].call.id, content }))];
        if (turn.next) messages.push({ role: 'user', content: turn.next });
      }
    }
    for (const { release, result } of late) {
      release();
      await result.threadReceipt?.pending;
    }
    out.push({ id: scenario.id, model: scenario.model, tools, sends });
  }
  return { capabilities, scenarios: out };
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
// The notice is given once per process (`announcedRedirects`), so the order of these scenarios is part of the recording.
// A first send that fails (the key is refused) has shown the notice already; the next one does not show it again.
gemini({ id: 'flash25.failed-first-send', model: GEMINI_MODELS.flash25, system: SMALL_SYSTEM, start: AFTER_REDIRECT, user: 'Look up the answer.', turns: [{ blocks: [], fail: { status: 401, reason: 'UNAUTHENTICATED', message: 'API key not valid. Please pass a valid API key.' } }, finalTurn('Done.')] });
// The last millisecond before the redirect, and its first.
gemini({ id: 'pro25.boundary-before', model: GEMINI_MODELS.pro25, start: Date.parse('2026-11-30T23:59:59.999Z'), user: 'Look up the answer.', turns: [finalTurn('Done.')] });
gemini({ id: 'pro25.boundary-at', model: GEMINI_MODELS.pro25, start: Date.parse('2026-12-01T00:00:00.000Z'), user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), finalTurn('Done.')] });
for (const family of ['pro25', 'flash25', 'lite25']) {
  gemini({ id: `${family}.after-redirect`, model: GEMINI_MODELS[family], start: AFTER_REDIRECT, user: 'Look up the answer.', turns: [toolTurn(1, 'Reading it.'), finalTurn('Done.')] });
}
// The id as the caller writes it: a `models/` prefix and capitals, and a second provider instance of the same process.
gemini({ id: 'pro25.prefixed-upper-case', model: 'models/GEMINI-2.5-PRO', start: AFTER_REDIRECT, user: 'Look up the answer.', turns: [finalTurn('Done.')] });
gemini({ id: 'pro25.second-instance', model: GEMINI_MODELS.pro25, start: AFTER_REDIRECT, user: 'Look up the answer.', turns: [finalTurn('Done.'), { ...finalTurn('Again.'), newProvider: true }] });

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
    let provider = new GeminiProvider({ apiKey: FAKE });
    const tools = scenario.tools.map((t) => realTool(t));
    let providerState;
    let messages = [...scenario.system, ...scenario.history, { role: 'user', content: scenario.user }];
    const sends = [];
    let creates = 0;
    for (const turn of scenario.turns) {
      if (turn.freshProcess) resetRegistry();
      // Another provider instance of the same process (the notice registry and the cache registry are the process's).
      if (turn.newProvider) provider = new GeminiProvider({ apiKey: FAKE });
      const reply = geminiReply(turn.blocks);
      responder = (entry) => {
        if (entry.method === 'DELETE') return { status: 200, body: '{}', json: true };
        if (entry.url.endsWith('/v1beta/cachedContents')) {
          creates += 1;
          return { status: 200, json: true, body: JSON.stringify({ name: `cachedContents/${scenario.id}-${creates}`, usageMetadata: { totalTokenCount: 5000 + creates } }) };
        }
        if (turn.fail) return { status: turn.fail.status, json: true, body: JSON.stringify({ error: { code: turn.fail.status, message: turn.fail.message, status: turn.fail.reason } }) };
        return { status: 200, body: reply };
      };
      captured = [];
      const opts = { sessionId: SESSION, iteration: sends.length + 1, ...scenario.opts, ...(turn.opts || {}), ...(providerState ? { providerState } : {}) };
      const before = structuredClone(opts);
      // What `onStageChange` received as a notice: the TUI/desktop turn handler shows each as a transcript notice
      // (`pushNotice(detail.message, detail.tone === 'warn' ? 'warn' : 'info', { transcript: true })`, turn.mjs).
      const notices = [];
      // The transcript rows the client got for them: the real notice surface of the TUI/desktop session, driven the
      // way the turn handler drives it.
      const rows = [];
      const surface = createNoticeSurface({
        getState: () => ({ toasts: [], items: [] }),
        set: () => {},
        isDisposed: () => false,
        pushItem: (item) => rows.push({ kind: item.kind, text: item.text, tone: item.tone }),
        replaceItems: (items) => items,
      });
      opts.onStageChange = (stage, detail) => {
        if (stage !== 'notice') return;
        notices.push(structuredClone(detail));
        surface.pushNotice(detail?.message, detail?.tone === 'warn' ? 'warn' : 'info', { transcript: true });
      };
      const at = clock.now;
      ledgerRows = [];
      // The send runs through Node's accounting (`accountProviderSend`), which writes the ledger row of the send.
      let used = opts;
      let result = null;
      let failure = null;
      try {
        result = await accountProviderSend('gemini', provider, (accounted) => {
          used = accounted;
          return provider.send(structuredClone(messages), scenario.model, structuredClone(tools), accounted);
        }, scenario.model, opts);
      } catch (error) {
        failure = { name: error.name, status: error.status ?? null, message: error.message };
      }
      // The scheduled delete of a superseded cache fires inside the gap that follows the send.
      await advance(turn.gapMs ?? scenario.gapMs);
      providerState = used.providerState;
      sends.push({
        messages: structuredClone(messages),
        opts: before,
        now: at,
        gapMs: turn.gapMs ?? scenario.gapMs,
        providerStateAfter: structuredClone(used.providerState ?? null),
        freshProcess: turn.freshProcess === true,
        newProvider: turn.newProvider === true,
        notices,
        noticeRows: rows,
        // What the send answered: the model that answered (`result.model`), or how it failed.
        result: result ? { model: result.model } : null,
        failure,
        ledger: ledgerRows.map(ledgerView),
        requests: captured,
      });
      if (turn.fail) continue;
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
await writeJsonCompact(tree, join(OUT, 'anthropic.json'), { recorder: 'benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs', capabilities: anthropic.capabilities, scenarios: anthropic.scenarios });
await writeJsonCompact(tree, join(OUT, 'gemini.json'), { recorder: 'benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs', scenarios: geminiRuns });
writeSetManifest(OUT, {
  set: 'wire-anthropic-gemini',
  recorder: 'benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs',
  command: 'node benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs --tree <exact export of b6f10295a>',
  identity,
});
closeUsageLedgers();
rmSync(dataDir, { recursive: true, force: true });
console.log(`recorded ${anthropic.scenarios.length} anthropic and ${geminiRuns.length} gemini scenarios`);
process.exit(0);
