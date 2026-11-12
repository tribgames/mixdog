// Records Node's leaked tool-call guard (`providers/lib/leaked-toolcall.mjs`) as each provider route wires it: text
// that carries a tool call as tags (or not) is streamed through the real decoder of the route, and what the decoder
// relayed as text, dispatched, reported as progress and returned is written down per wire event.
//
//   node native/core/fixtures/agent/leaked-toolcall/record.mjs --tree D:\mixdog-build\tmp\real-turn-harness\node-tree
// (the harness's Node tree: the product source with its `node_modules`, like the other recorders)
//
// Routes (the Node decoder driven): anthropic (`parseSSEStream`), chat (`consumeCompatChatCompletionStream`),
// responses-compat (`consumeCompatResponsesStream`), responses-ws (`createWsEventSwitch` over the real response state and
// text relay), responses-sse (`createHttpSseResponseState`), gemini (`consumeGeminiRestStreamResponse` with the deferring
// guard `geminiTextLeakGuardFor` builds, then `parseGeminiCandidate`).
//
// `golden/leaked_toolcall.json`: the guard's own cases (chunks in, text and calls out) and, per route scenario, the
// known tools, the wire events, per wire event (and one `end` step) the text relayed, the calls dispatched and the
// progress kinds, and the result (content, returned calls).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const treeAt = args.indexOf('--tree');
const nodeRoot = resolve(treeAt >= 0 ? args[treeAt + 1] : (process.env.MIXDOG_BENCH_TREE ?? join(here, '..', '..', '..', '..', '..')));
const scratch = mkdtempSync(join(tmpdir(), 'mixdog-leak-golden-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = join(scratch, key);
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
mkdirSync(join(here, 'golden'), { recursive: true });
const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);
const providerDir = 'src/runtime/agent/orchestrator/providers';

const guardLib = await load(`${providerDir}/lib/leaked-toolcall.mjs`);
const { parseSSEStream } = await load(`${providerDir}/anthropic-sse.mjs`);
const { consumeCompatChatCompletionStream } = await load(`${providerDir}/openai-compat-chat-stream.mjs`);
const { consumeCompatResponsesStream } = await load(`${providerDir}/openai-compat-stream.mjs`);
const { parseToolCalls, parseResponsesToolCalls, responseOutputText } = await load(`${providerDir}/openai-compat-wire.mjs`);
const { createWsResponseState } = await load(`${providerDir}/openai-ws-response-state.mjs`);
const { createWsTextRelay } = await load(`${providerDir}/openai-ws-text-relay.mjs`);
const { createWsEventSwitch } = await load(`${providerDir}/openai-ws-stream/event-switch.mjs`);
const { createTerminalFrameHandlers } = await load(`${providerDir}/openai-ws-stream/terminal-frames.mjs`);
const { createHttpSseResponseState } = await load(`${providerDir}/openai-http-sse-response-state.mjs`);
const { consumeGeminiRestStreamResponse } = await load(`${providerDir}/gemini-stream.mjs`);
const { geminiTextLeakGuardFor } = await load(`${providerDir}/gemini-sdk-request.mjs`);
const { parseGeminiCandidate } = await load(`${providerDir}/gemini-response.mjs`);
const { emitGeminiToolCalls } = await load(`${providerDir}/gemini-schema.mjs`);
const { normalizeCompatChatResponse } = await load(`${providerDir}/openai-compat-response-normalization.mjs`);
const { agentLoop } = await load('src/runtime/agent/orchestrator/session/agent-loop.mjs');

// ---- text fixtures: the tags are assembled here so the source never holds a literal tag ----
const lt = '<';
const tag = (prefix, name, attrs = '') => `${lt}${prefix}${name}${attrs}>`;
const endTag = (prefix, name) => `${lt}/${prefix}${name}>`;
const param = (prefix, key, value) => `${tag(prefix, 'parameter', ` name="${key}"`)}${value}${endTag(prefix, 'parameter')}`;
const invoke = (name, params, prefix = '') =>
  `${tag(prefix, 'invoke', ` name="${name}"`)}${params.map(([k, v]) => param(prefix, k, v)).join('')}${endTag(prefix, 'invoke')}`;
const wrapped = (inner, prefix = '') => `${tag(prefix, 'function_calls')}${inner}${endTag(prefix, 'function_calls')}`;
const gemma = (name, params) =>
  `${tag('', 'function', ` name="${name}"`)}${params.map(([k, v]) => param('', k, v)).join('')}${endTag('', 'function')}`;
const harmony = (name, json) => `<|channel|>commentary to=functions.${name} <|constrain|>json<|message|>${json}<|call|>`;
// A tag family with the attribute spelled as given: `<tag NAME EQ Q read Q>` holding a parameter spelled the same way.
const attrInvoke = (tagName, attr, eq, q) =>
  `${lt}${tagName} ${attr}${eq}${q}read${q}>${lt}parameter ${attr}${eq}${q}path${q}>a.txt${lt}/parameter>${lt}/${tagName}>`;
const READ_A =invoke('read', [['path', 'a.txt']]);
const split = (text, cuts) => {
  const out = [];
  let from = 0;
  for (const cut of cuts) {
    out.push(text.slice(from, cut));
    from = cut;
  }
  out.push(text.slice(from));
  return out;
};

// Each scenario: the text chunks of the model's answer, with what the route offered. `native` adds the same call as a
// structured one (the cross-path dedupe), `harmony` marks the syntax only the OpenAI-family routes read.
const TEXTS = [
  { name: 'an invoke tag in the answer', chunks: ['Look. ', READ_A, ' Done.'] },
  { name: 'a tag split across chunks', chunks: split(`go ${READ_A} ok`, [6, 30, 52]) },
  { name: 'a partial opener at a chunk end is held and flushed', chunks: ['text ', `${lt}fun`, 'ction> in prose'] },
  { name: 'the function_calls wrapper with the antml prefix and typed values', chunks: [wrapped(invoke('read', [['path', '"x.txt"'], ['limit', '5'], ['flag', 'true'], ['list', '[1,2]'], ['raw', 'plain text']], 'antml:'), 'antml:')] },
  { name: 'a Gemma function tag', chunks: ['now ', gemma('read', [['path', 'g.txt']])] },
  { name: 'an unknown tool stays text', chunks: [invoke('nope', [['path', 'a.txt']])] },
  { name: 'a tag inside a fenced code block stays text', chunks: ['example:\n```\n', READ_A, '\n```\nthat is all'] },
  { name: 'a tag inside inline code stays text', chunks: ['write `', READ_A, '` to call it'] },
  { name: 'a fence opened in one chunk covers the next', chunks: ['```xml\n', `${READ_A}\n`, '```\n', READ_A] },
  { name: 'a function mention in prose stays text', chunks: ['Use <function> in JavaScript, or <function name> too.'] },
  { name: 'an unfinished block is flushed as text at the end', chunks: [`${lt}invoke name="read">`, param('', 'path', 'a.txt').slice(0, 20)] },
  { name: 'two identical leaked calls run once', chunks: [READ_A, ' and again ', READ_A] },
  { name: 'two different leaked calls', chunks: [READ_A, invoke('read', [['path', 'b.txt']])] },
  // Every spelling of `name` + `=` + value the regexes accept, in each tag family: the whitespace around `=` (none, either side,
  // both, a newline), the quote (double, single, none) and the case of tag and attribute.
  ...[
    ['=', '"'],
    [' =', '"'],
    ['= ', '"'],
    [' = ', '"'],
    ['\n=\n', '"'],
    ['=', "'"],
    [' = ', "'"],
    ['=', ''],
    [' = ', ''],
  ].flatMap(([eq, q]) => [
    { name: `an invoke with name${JSON.stringify(eq)}${q || 'unquoted'}`, chunks: [`go ${attrInvoke('invoke', 'name', eq, q)}`] },
    { name: `a Gemma function with name${JSON.stringify(eq)}${q || 'unquoted'}`, chunks: [attrInvoke('function', 'name', eq, q)] },
  ]),
  { name: 'upper-case tag and attribute names', chunks: [attrInvoke('INVOKE', 'NAME', ' = ', '"')] },
  // The guard knows `ghost` (the request offered it) but the loop's tool surface does not: the executor answers an unknown tool.
  { name: 'a leaked call to a tool the executor does not have', chunks: ['go ', invoke('ghost', [['path', 'a.txt']])], known: ['ghost'] },
  { name: 'a harmony channel call', chunks: ['plan. ', harmony('read', '{"path":"a.txt"}')], harmony: true },
  { name: 'a harmony channel message that is not a call', chunks: ['<|channel|>analysis<|message|>thinking<|end|>after'], harmony: true },
  { name: 'a leaked call and the same native call', chunks: ['go ', READ_A], native: true },
  { name: 'a leaked call and a namespaced native call of the same name', chunks: ['go ', READ_A], native: true, namespace: 'ns' },
  { name: 'only leaked calls, nothing else visible', chunks: [READ_A, invoke('read', [['path', 'b.txt']])] },
  { name: 'no tool offered', chunks: ['go ', READ_A], known: [] },
  { name: 'plain text', chunks: ['just ', 'words'] },
];

// ---- the guard itself ----
const guardCases = [];
for (const entry of TEXTS) {
  for (const harmonyOn of [false, true]) {
    const guard = guardLib.createLeakGuard({ knownToolNames: entry.known ?? ['read'], harmony: harmonyOn });
    const steps = entry.chunks.map((chunk) => guard.push(chunk));
    const tail = guard.flush();
    guardCases.push({ name: entry.name, harmony: harmonyOn, known: entry.known ?? ['read'], chunks: entry.chunks, steps: [...steps, tail] });
  }
}

// ---- the routes ----
const idShape = (id) => (typeof id === 'string' ? id.replace(/(_leaked_)[0-9a-f]{16}$/, (m, p) => (id.startsWith('gemini_') ? m : `${p}*`)) : id);
const shapeCall = (call) => ({ id: idShape(call.id), name: call.name, arguments: call.arguments });

// While a loop run is recording, the decoder's live callbacks also reach the loop (its eager dispatcher), and the
// decoder's raw result is kept for the provider stub to return.
let live = null;
let lastRaw = null;

// One recorder: steps[i] holds what was reported while wire event i was being processed; the last step is the end.
function makeSteps(length) {
  const steps = Array.from({ length: length + 1 }, () => ({ text: [], calls: [], kinds: [] }));
  let current = 0;
  return {
    steps,
    at: (i) => { current = i; },
    onText: (text) => { steps[current].text.push(text); live?.onTextDelta?.(text); },
    onCall: (call) => { steps[current].calls.push(shapeCall(call)); live?.onToolCall?.(call); },
    onKind: (kind) => { if (kind !== 'transport') steps[current].kinds.push(kind); },
  };
}

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;

function anthropicWire(entry) {
  const wire = [{ type: 'message_start', message: { id: 'msg_1', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } }];
  wire.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  wire.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } });
  wire.push({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
  wire.push({ type: 'content_block_stop', index: 0 });
  wire.push({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  for (const chunk of entry.chunks) wire.push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: chunk } });
  wire.push({ type: 'content_block_stop', index: 1 });
  if (entry.native) {
    wire.push({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_native', name: 'read', input: {} } });
    wire.push({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } });
    wire.push({ type: 'content_block_stop', index: 2 });
  }
  wire.push({ type: 'message_delta', delta: { stop_reason: entry.native ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } });
  wire.push({ type: 'message_stop' });
  return wire;
}

async function runAnthropic(entry) {
  const wire = anthropicWire(entry);
  const rec = makeSteps(wire.length);
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (next >= wire.length) {
          rec.at(wire.length);
          controller.close();
          return;
        }
        rec.at(next);
        const event = wire[next];
        next += 1;
        controller.enqueue(encoder.encode(`event: ${event.type}\n${sse(event)}`));
      },
    },
    { highWaterMark: 0 }
  );
  const state = {};
  const known = entry.known ?? ['read'];
  const result = lastRaw = await parseSSEStream({ body }, new AbortController().signal, () => {}, rec.onKind, rec.onCall, state, rec.onText, new Set(known));
  return {
    wire,
    steps: rec.steps,
    result: {
      content: result.content,
      toolCalls: (result.toolCalls ?? []).map(shapeCall),
      thinkingBlocks: result.thinkingBlocks ?? null,
      assistantBlocks: result.assistantBlocks !== undefined,
    },
  };
}

function chatWire(entry, finish) {
  const chunk = (delta, extra = {}) => ({ id: 'c', model: 'm', choices: [{ index: 0, delta, finish_reason: null, ...extra }] });
  const wire = [chunk({ role: 'assistant', content: '' })];
  for (const text of entry.chunks) wire.push(chunk({ content: text }));
  if (entry.native) {
    wire.push(chunk({ tool_calls: [{ index: 0, id: 'call_native', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] }));
  }
  wire.push({ id: 'c', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
  return wire;
}

async function runChat(entry, finish) {
  const wire = chatWire(entry, finish);
  const rec = makeSteps(wire.length);
  async function* source() {
    for (let i = 0; i < wire.length; i += 1) {
      rec.at(i);
      yield wire[i];
    }
    rec.at(wire.length);
  }
  let outcome;
  try {
    const result = lastRaw = await consumeCompatChatCompletionStream(source(), {
      label: 'chat',
      providerName: 'custom',
      knownToolNames: entry.known ?? ['read'],
      onStreamDelta: rec.onKind,
      onToolCall: rec.onCall,
      onTextDelta: rec.onText,
      parseToolCalls,
    });
    outcome = { content: result.content, toolCalls: (result.toolCalls ?? []).map(shapeCall), stopReason: result.stopReason };
  } catch (err) {
    outcome = { error: String(err?.message ?? err) };
  }
  return { wire, steps: rec.steps, result: outcome };
}

function responsesWire(entry, { bundleOnly = false } = {}) {
  const fcItem = { type: 'function_call', id: 'fc1', call_id: 'call_native', name: 'read', arguments: '{"path":"a.txt"}', status: 'completed', ...(entry.namespace ? { namespace: entry.namespace } : {}) };
  const text = entry.chunks.join('');
  const message = { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text }] };
  const wire = [{ type: 'response.created', response: { id: 'r1', model: 'm' } }];
  if (!bundleOnly) {
    wire.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } });
    for (const chunk of entry.chunks) wire.push({ type: 'response.output_text.delta', item_id: 'm1', delta: chunk });
    wire.push({ type: 'response.output_item.done', output_index: 0, item: message });
  }
  const output = [message];
  if (entry.native) {
    wire.push({ type: 'response.output_item.added', output_index: 1, item: { ...fcItem, arguments: '', status: 'in_progress' } });
    wire.push({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"path":"a.txt"}' });
    wire.push({ type: 'response.function_call_arguments.done', item_id: 'fc1', arguments: '{"path":"a.txt"}' });
    wire.push({ type: 'response.output_item.done', output_index: 1, item: fcItem });
    output.push(fcItem);
  }
  wire.push({ type: 'response.completed', response: { id: 'r1', model: 'm', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } } });
  return wire;
}

async function runCompat(entry, options) {
  const wire = responsesWire(entry, options);
  const rec = makeSteps(wire.length);
  async function* source() {
    for (let i = 0; i < wire.length; i += 1) {
      rec.at(i);
      yield wire[i];
    }
    rec.at(wire.length);
  }
  let outcome;
  try {
    const result = lastRaw = await consumeCompatResponsesStream(source(), {
      label: 'compat',
      knownToolNames: entry.known ?? ['read'],
      onStreamDelta: rec.onKind,
      onToolCall: rec.onCall,
      onTextDelta: rec.onText,
      parseResponsesToolCalls,
      responseOutputText,
    });
    outcome = { content: result.content, toolCalls: (result.toolCalls ?? []).map(shapeCall) };
  } catch (err) {
    outcome = { error: String(err?.message ?? err) };
  }
  return { wire, steps: rec.steps, result: outcome };
}

function runWs(entry, options) {
  const wire = responsesWire(entry, options);
  const rec = makeSteps(wire.length);
  const midState = {};
  const response = createWsResponseState({ onToolCall: rec.onCall, onStreamDelta: rec.onKind, midState, traceProvider: 'openai-oauth' });
  const textRelay = createWsTextRelay({ response, knownToolNames: entry.known ?? ['read'], sessionState: midState, onTextDelta: rec.onText, onStreamDelta: rec.onKind });
  const noop = () => {};
  let seen = false;
  const watchdogs = { clearFirstMeaningful: noop, semanticSeen: () => seen, bumpSemantic() { seen = true; } };
  const terminal = createTerminalFrameHandlers({ response, textRelay, midState, errLabel: 'ws', progress: rec.onKind, outcome: {}, finish: noop });
  const handlers = { onResponseCompleted: terminal.onResponseCompleted, onResponseDone: terminal.onResponseDone, onResponseIncomplete: noop, onResponseFailed: noop, onErrorFrame: noop };
  const onEvent = createWsEventSwitch({ response, textRelay, watchdogs, midState, progress: rec.onKind, terminal: handlers, streamingStart: Date.now(), onStreamItemStart: null });
  wire.forEach((event, i) => {
    rec.at(i);
    onEvent(event);
  });
  rec.at(wire.length);
  textRelay.flush();
  const result = lastRaw = response.result();
  return { wire, steps: rec.steps, result: { content: result.content, toolCalls: (result.toolCalls ?? []).map(shapeCall) } };
}

function runSse(entry, options) {
  const wire = responsesWire(entry, options);
  const rec = makeSteps(wire.length);
  let seen = false;
  const meaningful = (kind = 'semantic') => { seen = true; rec.onKind(kind); };
  const lifecycle = (kind = 'semantic') => { if (seen) meaningful(kind); };
  const tools = (entry.known ?? ['read']).map((name) => ({ name }));
  const state = createHttpSseResponseState({ body: { tools }, onToolCall: rec.onCall, onTextDelta: rec.onText, meaningful, lifecycle, onServerEvent() {}, label: 'sse' });
  wire.forEach((event, i) => {
    rec.at(i);
    state.handleEvent(event);
  });
  rec.at(wire.length);
  state.flushLeak();
  const result = lastRaw = state.finish({ useModel: 'm', poolKey: 'k', iteration: 0, sseStartedAt: 0, ttftMs: 0 });
  return { wire, steps: rec.steps, result: { content: result.content, toolCalls: (result.toolCalls ?? []).map(shapeCall) } };
}

function geminiWire(entry) {
  const part = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, ...extra }] });
  const wire = [];
  entry.chunks.forEach((text, i) => {
    const parts = [{ text }];
    if (entry.native && i === entry.chunks.length - 1) parts.push({ functionCall: { name: 'read', args: { path: 'a.txt' } } });
    wire.push(part(parts));
  });
  wire.push({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } });
  return wire;
}

async function runGemini(entry) {
  const wire = geminiWire(entry);
  const rec = makeSteps(wire.length);
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (next >= wire.length) {
          rec.at(wire.length);
          controller.close();
          return;
        }
        rec.at(next);
        const event = wire[next];
        next += 1;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
      },
    },
    { highWaterMark: 0 }
  );
  const tools = (entry.known ?? ['read']).map((name) => ({ name }));
  const callbacks = { onTextDelta: rec.onText, onToolCall: rec.onCall, onStreamDelta: rec.onKind };
  const textLeakGuard = geminiTextLeakGuardFor({ tools, callbacks });
  const response = await consumeGeminiRestStreamResponse(new Response(body), { label: 'gemini', onStreamDelta: rec.onKind, onTextDelta: rec.onText, textLeakGuard });
  rec.at(wire.length);
  const parsed = parseGeminiCandidate(response, textLeakGuard);
  textLeakGuard.releaseDeferredToolCalls();
  emitGeminiToolCalls(parsed.nativeToolCalls, callbacks.onToolCall);
  lastRaw = { content: parsed.content, toolCalls: parsed.toolCalls, providerReplay: parsed.providerReplay };
  return {
    wire,
    steps: rec.steps,
    result: { content: parsed.content, toolCalls: (parsed.toolCalls ?? []).map(shapeCall), replay: Boolean(parsed.providerReplay?.items?.length ?? parsed.providerReplay) },
  };
}

// Cursor: Connect frames of AgentServerMessage through the real stream response (think filter, sink, bridge
// controller), whose SSE chunks the real chat consumer reads, as `_dispatchChat` wires it. `wire` is the frames' payloads (hex).
async function runCursor(entry) {
  const { __cursorWireInternals: wireInternals } = await load(`${providerDir}/cursor-wire.mjs`);
  const { encodeMessage, connectFrame, createStreamResponse } = wireInternals;
  const payloads = [
    ...entry.chunks.map((text) => encodeMessage('AgentServerMessage', { interactionUpdate: { textDelta: { text } } })),
    encodeMessage('AgentServerMessage', { interactionUpdate: { turnEnded: {} } }),
  ];
  let onData = null;
  let onClose = null;
  const bridge = {
    alive: true,
    write() {},
    close(error = null) {
      this.alive = false;
      onClose?.(error);
    },
    onData(handler) { onData = handler; },
    onClose(handler) { onClose = handler; },
  };
  const response = createStreamResponse({
    bridge,
    heartbeat: null,
    conversation: { checkpoint: null },
    tools: [],
    cloudRule: undefined,
    model: 'cursor-test',
    key: 'leak-golden',
    restart: null,
    sleep: async () => {},
    onStageChange: null,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const chunks = [];
  let reading = null;
  let carry = '';
  const drain = async (frame) => {
    for (;;) {
      reading ??= reader.read();
      const got = await Promise.race([reading, tick().then(() => null)]);
      if (got === null) return;
      reading = null;
      if (got.done) return;
      carry += decoder.decode(got.value, { stream: true });
      let cut;
      while ((cut = carry.indexOf('\n\n')) >= 0) {
        const record = carry.slice(0, cut);
        carry = carry.slice(cut + 2);
        const data = record.replace(/^data: /, '');
        if (data !== '[DONE]') chunks.push({ frame, event: JSON.parse(data) });
      }
    }
  };
  for (let i = 0; i < payloads.length; i += 1) {
    onData(connectFrame(payloads[i]));
    await drain(i);
  }
  bridge.close();
  await drain(payloads.length);
  const rec = makeSteps(payloads.length);
  async function* source() {
    for (const { frame, event } of chunks) {
      rec.at(frame);
      yield event;
    }
    rec.at(payloads.length);
  }
  let outcome;
  try {
    const result = lastRaw = await consumeCompatChatCompletionStream(source(), {
      label: 'cursor',
      providerName: 'cursor',
      knownToolNames: entry.known ?? ['read'],
      onStreamDelta: rec.onKind,
      onToolCall: rec.onCall,
      onTextDelta: rec.onText,
      parseToolCalls,
    });
    outcome = { content: result.content, toolCalls: (result.toolCalls ?? []).map(shapeCall), stopReason: result.stopReason };
  } catch (err) {
    outcome = { error: String(err?.message ?? err) };
  }
  return { wire: payloads.map((p) => Buffer.from(p).toString('hex')), steps: rec.steps, result: outcome };
}

// The stored side: the real agent loop over a provider whose send runs the route's real decoder (its live calls reach the
// loop's eager dispatcher, its returned result is what the loop executes and stores) with the real read tool on a
// file. `executed` lists the ids a tool ran for (a run whose result nothing consumed shows only as a UI early notice).
const loopCwd = mkdtempSync(join(scratch, 'loop-cwd-'));
writeFileSync(join(loopCwd, 'a.txt'), 'hello probe\n');
let loopRuns = 0;
// `normalize`: the step a chat send runs on the collector's result (`normalizeCompatChatResponse`), which rejects a turn cut
// by `length` (with calls) or `content_filter`; the loop then gets the error the product's send throws, never the raw result.
async function recordStored(run, { failing = false, denying = false, normalize = false } = {}) {
  loopRuns += 1;
  const session = { id: `leak-loop-${loopRuns}`, owner: 'agent', agent: 'worker', contextWindow: 200000, rawContextWindow: 200000, compaction: { auto: false } };
  // A PreToolUse hook that denies: the executor returns the denial as text, so the call settles normally.
  if (denying) session.beforeToolHook = () => ({ action: 'deny', reason: 'blocked by the test gate' });
  const committed = [];
  const results = [];
  let sends = 0;
  const provider = {
    async send(_messages, _model, _tools, sendOpts) {
      sends += 1;
      if (sends > 1) return { content: 'final', toolCalls: [], stopReason: 'end_turn' };
      live = { onToolCall: sendOpts.onToolCall, onTextDelta: sendOpts.onTextDelta };
      try {
        await run();
        // A real stream spans many network reads: a call it dispatched live has finished before the batch starts.
        for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      } finally {
        live = null;
      }
      return normalize ? normalizeCompatChatResponse({ providerName: 'custom', useModel: 'm', opts: {}, assembled: lastRaw }) : lastRaw;
    },
  };
  const tools = [{ name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  let turnError = null;
  const final = await agentLoop(provider, [{ role: 'user', content: 'go' }], 'fake-model', tools, null, loopCwd, {
    session,
    sessionId: session.id,
    onAssistantMessageCommitted: (message) => committed.push(message),
    onToolResult: (message) => results.push(message),
    // A run that throws before the tool executes (`runEagerEntry` settles `{ ok: false }`): its early notice is an error.
    ...(failing
      ? {
          beforeToolExecution: () => {
            throw new Error('boom');
          },
        }
      : {}),
  }).catch((error) => {
    // The turn failed: the error the caller (and the session's error mark) gets, and what the loop had stored.
    turnError = String(error?.message ?? error);
    return { content: null };
  });
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return {
    ...(turnError === null ? {} : { turnError }),
    content: final.content,
    sends,
    messages: committed.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls ? { toolCalls: m.toolCalls.map(shapeCall) } : {}),
      ...(m.thinkingBlocks ? { thinkingBlocks: m.thinkingBlocks } : {}),
    })),
    toolResults: results
      .filter((m) => !m.__earlyNotify)
      .map((m) => ({ toolCallId: idShape(m.toolCallId), content: m.content, isError: m.isError === true })),
    executed: [...new Set(results.map((m) => idShape(m.toolCallId)))].sort(),
    // The early notices (`onToolResult` with `__earlyNotify`): one per streamed call that settled, in completion order.
    early: results
      .filter((m) => m.__earlyNotify)
      .map((m) => ({ toolCallId: idShape(m.toolCallId), content: m.content, isError: m.isError === true })),
  };
}

const scenarios = [];
const record = async (route, entry, run, extra = {}) => {
  const out = await run();
  const stored = extra.loop === false || out.result.error ? {} : { stored: await recordStored(run, { failing: extra.failing === true, denying: extra.denying === true, normalize: extra.normalize === true }) };
  scenarios.push({ route, name: extra.name ?? entry.name, known: entry.known ?? ['read'], native: Boolean(entry.native), failing: extra.failing === true, denying: extra.denying === true, ...extra.fields, ...out, ...stored });
};
for (const entry of TEXTS) {
  // The harmony syntax is read by the OpenAI-family routes only; the others must leave it as text.
  await record('anthropic', entry, () => runAnthropic(entry));
  await record('chat', entry, () => runChat(entry, entry.native ? 'tool_calls' : 'stop'));
  await record('responses-compat', entry, () => runCompat(entry));
  await record('responses-ws', entry, () => runWs(entry));
  await record('responses-sse', entry, () => runSse(entry));
  await record('gemini', entry, () => runGemini(entry));
  // Cursor announces its own calls over exec messages; the text path is what the guard sees.
  if (!entry.native) await record('cursor', entry, () => runCursor(entry));
}
// The final bundle is the only place the text appears.
for (const name of ['an invoke tag in the answer', 'plain text', 'only leaked calls, nothing else visible']) {
  const entry = TEXTS.find((t) => t.name === name);
  for (const [route, run] of [['responses-compat', runCompat], ['responses-ws', runWs], ['responses-sse', runSse]]) {
    await record(route, entry, () => run(entry, { bundleOnly: true }), { name: `${name}, only in the bundle` });
  }
}
// A run that throws: the early notice is an error with the thrown message, the stored result the same text.
for (const name of ['an invoke tag in the answer', 'a leaked call and the same native call']) {
  const entry = TEXTS.find((t) => t.name === name);
  const routes = [
    ['anthropic', runAnthropic],
    ['chat', (e) => runChat(e, e.native ? 'tool_calls' : 'stop')],
    ['responses-compat', runCompat],
    ['responses-ws', runWs],
    ['responses-sse', runSse],
    ['gemini', runGemini],
    ['cursor', runCursor],
  ];
  for (const [route, run] of routes) {
    if (route === 'cursor' && entry.native) continue;
    await record(route, entry, () => run(entry), { name: `${name}, the tool run throws`, failing: true });
  }
}
// A gate denial: the executor returns its text, so the early notice is a normal result carrying the denial.
for (const name of ['an invoke tag in the answer', 'a leaked call and the same native call']) {
  const entry = TEXTS.find((t) => t.name === name);
  const routes = [
    ['anthropic', runAnthropic],
    ['chat', (e) => runChat(e, e.native ? 'tool_calls' : 'stop')],
    ['responses-compat', runCompat],
    ['responses-ws', runWs],
    ['responses-sse', runSse],
    ['gemini', runGemini],
    ['cursor', runCursor],
  ];
  for (const [route, run] of routes) {
    if (route === 'cursor' && entry.native) continue;
    await record(route, entry, () => run(entry), { name: `${name}, a gate denies the call`, denying: true });
  }
}
// A turn cut at the token limit never runs a call it leaked.
for (const finish of ['length', 'content_filter', 'error']) {
  const entry = TEXTS[0];
  await record('chat', entry, () => runChat(entry, finish), { name: `${entry.name}, finish_reason ${finish}`, normalize: finish !== 'error' });
}
// A cut turn still relays what the guard held back (the flush runs before `normalizeCompatChatResponse` throws).
const held = { name: 'a partial opener held at the cut', chunks: ['text ', `${lt}fun`] };
await record('chat', held, () => runChat(held, 'content_filter'), { name: `${held.name}, finish_reason content_filter`, normalize: true });

writeFileSync(join(here, 'golden', 'leaked_toolcall.json'), `${JSON.stringify({ guard: guardCases, scenarios }, null, 2)}\n`);
