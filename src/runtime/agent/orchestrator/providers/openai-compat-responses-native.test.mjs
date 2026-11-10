import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseResponsesToolCalls } from './openai-compat-wire.mjs';
import { convertMessagesToResponsesInput } from './openai-responses-input.mjs';
import { createWsToolCalls } from './openai-ws-response-state/tool-calls.mjs';
import { createHttpSseResponseState } from './openai-http-sse-response-state.mjs';
import { ensureResponsesCallOutputs } from './lib/wire-pairing.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { sendCompatResponses } from './openai-compat-responses.mjs';
import {
  COMPAT_CASES,
  FIRST_PARTY,
  REPLY,
  ROUTES,
  SERVER_CALL,
  SERVER_OUTPUT,
  captureCompat,
  captureFirstParty,
  compatProvider,
  nativeHistory,
} from './openai-compat-responses-parity.fixtures.mjs';

const NATIVE = { responsesNativeItems: true };

// Request bodies captured by running the same fixtures against the pre-change
// (HEAD) converters; see openai-compat-responses-parity.fixtures.mjs.
const HEAD = JSON.parse(readFileSync(new URL('./openai-compat-responses-head-parity.json', import.meta.url), 'utf8'));

// A compat provider whose Responses client answers with scripted SSE events.
function fixture(name, { output, events, config = {} } = {}) {
  const { provider, requests } = compatProvider(name, config);
  if (output || events) {
    provider.client.responses.create = async (params) => {
      requests.push(structuredClone(params));
      return (async function* () {
        for (const event of events || []) yield event;
        yield {
          type: 'response.completed',
          response: { id: 'resp-1', model: params.model, status: 'completed', output: output || [REPLY] },
        };
      })();
    };
  }
  return { provider, requests };
}

const types = (input) => input.map((item) => item.type || item.role);

test('compat Responses replays native tool_search and custom calls with their own output types', async () => {
  const { provider, requests } = fixture('opencode-go', { config: NATIVE });
  await sendCompatResponses(provider, nativeHistory(), 'gpt-5.5', [], {});
  const input = requests[0].input;
  assert.deepEqual(types(input), [
    'user',
    'tool_search_call',
    'custom_tool_call',
    'function_call',
    'tool_search_output',
    'custom_tool_call_output',
    'function_call_output',
    'user', // tool_search_output carries no text: the loader result rides as user media
    'user',
  ]);
  assert.equal(input.find((i) => i.type === 'tool_search_output').call_id, 'ts1');
  assert.equal(input.find((i) => i.type === 'custom_tool_call_output').call_id, 'cu1');
  assert.equal(
    input.some((i) => i.type === 'function_call_output' && i.call_id === 'ts1'),
    false
  );
});

// The only intentional delta from HEAD: HEAD's pairing guard synthesized a
// client tool_search_output for a replayed server-executed search call.
const isSyntheticServerSearchOutput = (item) =>
  item.type === 'tool_search_output' &&
  item.call_id === SERVER_CALL.id &&
  item.execution === 'client' &&
  item.status === 'completed' &&
  item.tools.length === 0;
const withoutServerSearchSynthesis = (body) => ({
  ...body,
  input: body.input.filter((item) => !isSyntheticServerSearchOutput(item)),
});

function assertHeadParity(key, actual) {
  const head = HEAD[key];
  assert.ok(head, `missing HEAD fixture ${key}`);
  if (!key.endsWith('/server-replay')) {
    assert.deepEqual(actual, head, key);
    return;
  }
  // Server-replay: HEAD inserted exactly one synthetic client output; every
  // other byte (including the server call/output pair itself) matches HEAD.
  assert.equal(head.input.filter(isSyntheticServerSearchOutput).length, 1, `${key}: HEAD synthesized one output`);
  assert.equal(actual.input.filter(isSyntheticServerSearchOutput).length, 0, key);
  assert.deepEqual(actual, withoutServerSearchSynthesis(head), key);
  assert.equal(actual.input.filter((i) => i.type === 'tool_search_call').length, 1, key);
  assert.equal(actual.input.filter((i) => i.type === 'tool_search_output').length, 1, key);
}

test('without the native-items flag compat request bodies match the HEAD converter byte for byte', async () => {
  for (const [name, model] of ROUTES) {
    for (const [label, build] of COMPAT_CASES) {
      const actual = JSON.parse(JSON.stringify(await captureCompat(name, model, build(name))));
      assertHeadParity(`compat/${name}/${model}/${label}`, actual);
      if (label !== 'server-replay') {
        const wire = JSON.stringify(actual.input);
        assert.equal(
          /tool_search_call|tool_search_output|custom_tool_call|"phase"/.test(wire),
          false,
          `${name}/${model}/${label}`
        );
      }
    }
  }
  // An explicit false flag is the same as no flag.
  const off = fixture('opencode-go', { config: { responsesNativeItems: false } });
  await sendCompatResponses(off.provider, nativeHistory(), 'gpt-5.5', [], {});
  const none = fixture('opencode-go');
  await sendCompatResponses(none.provider, nativeHistory(), 'gpt-5.5', [], {});
  assert.deepEqual(off.requests[0], none.requests[0]);
});

test('with the flag on (config or opts) native pairs replay on every route kind', async () => {
  for (const [name, model] of [
    ['opencode-go', 'gpt-5.5'],
    ['custom-cmd', 'openai/gpt-5.6-sol'],
    ['openrouter', 'openai/gpt-5.5'],
  ]) {
    for (const via of ['config', 'opts']) {
      const { provider, requests } = fixture(name, via === 'config' ? { config: NATIVE } : {});
      await sendCompatResponses(provider, nativeHistory(), model, [], via === 'opts' ? NATIVE : {});
      const input = requests[0].input;
      assert.equal(
        input.some((i) => i.type === 'tool_search_call'),
        true,
        `${name} ${via}`
      );
      assert.equal(
        input.some((i) => i.type === 'tool_search_output' && i.call_id === 'ts1'),
        true,
        `${name} ${via}`
      );
      assert.equal(
        input.some((i) => i.type === 'custom_tool_call_output' && i.call_id === 'cu1'),
        true,
        `${name} ${via}`
      );
    }
  }
});

test('same-owner replay and state reasoning replay; foreign owners and flattened reasoning are rejected', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] };
  const call = { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' };
  const assistant = (replay) => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }],
    reasoningItems: [{ id: 'rs_flat', encrypted_content: 'FLAT', summary: [] }],
    ...(replay ? { providerReplay: replay } : {}),
  });
  const turn = (replay) => [
    { role: 'user', content: 'go' },
    assistant(replay),
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
  ];
  const send = async (messages, providerState) => {
    const { provider, requests } = fixture('opencode-go', { config: NATIVE });
    await sendCompatResponses(provider, messages, 'gpt-5.5', [], { providerState });
    return requests[0].input;
  };
  const own = await send(turn(createProviderReplay('compat-responses:opencode-go', [reasoning, call])));
  assert.deepEqual(types(own), ['user', 'reasoning', 'function_call', 'function_call_output']);
  assert.equal(own[1].encrypted_content, 'ENC');
  for (const owner of ['compat-responses:other', 'openai-responses', 'xai-responses']) {
    const foreign = await send(turn(createProviderReplay(owner, [reasoning, call])));
    assert.deepEqual(types(foreign), ['user', 'function_call', 'function_call_output'], owner);
    assert.equal(JSON.stringify(foreign).includes('ENC'), false);
    assert.equal(JSON.stringify(foreign).includes('FLAT'), false);
  }
  // Same-owner reasoning kept in provider state rides before its message.
  const state = {
    compatResponses: {
      store: false,
      seenMessageCount: 3,
      model: 'gpt-5.5',
      encryptedReasoningHistory: [{ messageIndex: 1, items: [{ ...reasoning, id: 'rs_state' }] }],
    },
  };
  const stateful = await send(turn(null), state);
  assert.deepEqual(types(stateful), ['user', 'reasoning', 'function_call', 'function_call_output']);
  assert.equal(stateful[1].id, 'rs_state');
});

test('server-executed tool_search is never dispatched locally (non-streaming parse, SSE, WS)', async () => {
  const fn = { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' };
  const parsed = parseResponsesToolCalls({ output: [SERVER_CALL, SERVER_OUTPUT, fn] }, 't');
  assert.deepEqual(
    parsed.map((c) => c.id),
    ['c1']
  );
  assert.equal(parseResponsesToolCalls({ output: [SERVER_CALL, SERVER_OUTPUT] }, 't'), undefined);
  const client = parseResponsesToolCalls({ output: [{ ...SERVER_CALL, execution: 'client', call_id: 'ts9' }] }, 't');
  assert.equal(client[0].nativeType, 'tool_search_call');

  const dispatched = [];
  const { provider } = fixture('opencode-go', {
    events: [
      { type: 'response.output_item.added', item: SERVER_CALL },
      { type: 'response.output_item.done', item: SERVER_CALL },
      { type: 'response.output_item.done', item: SERVER_OUTPUT },
    ],
    output: [SERVER_CALL, SERVER_OUTPUT, REPLY],
  });
  const result = await sendCompatResponses(provider, [{ role: 'user', content: 'hi' }], 'gpt-5.5', [], {
    onToolCall: (call) => dispatched.push(call),
  });
  assert.deepEqual(dispatched, []);
  assert.equal(result.toolCalls?.length || 0, 0);
  // Server items stay in the replay envelope, in order.
  assert.deepEqual(
    result.providerReplay.items.map((i) => i.type),
    ['tool_search_call', 'tool_search_output', 'message']
  );

  const wsFired = [];
  const ws = createWsToolCalls({
    onToolCall: (call) => wsFired.push(call),
    midState: {},
    replayItems: { enrichFunctionCall() {} },
  });
  ws.noteItemAdded(SERVER_CALL);
  ws.completeToolSearchItem(SERVER_CALL);
  ws.pushToolSearchCall(SERVER_CALL);
  assert.deepEqual(wsFired, []);
  assert.equal(ws.calls.length, 0);
  assert.equal(ws.inFlight, false);
  ws.completeToolSearchItem({ ...SERVER_CALL, execution: 'client', call_id: 'ts2' });
  assert.deepEqual(
    ws.calls.map((c) => c.id),
    ['ts2']
  );
});

test('server search call/output pairs are not paired with a synthetic client output; client calls still are', () => {
  const server = [{ role: 'user', content: 'hi' }, SERVER_CALL, SERVER_OUTPUT];
  assert.equal(ensureResponsesCallOutputs(server), server);
  const serverWithId = [{ ...SERVER_CALL, call_id: 'ts_a' }];
  assert.equal(ensureResponsesCallOutputs(serverWithId), serverWithId);
  const client = ensureResponsesCallOutputs([{ ...SERVER_CALL, execution: 'client', call_id: 'ts_c' }]);
  assert.equal(client[1].type, 'tool_search_output');
  assert.equal(client[1].call_id, 'ts_c');

  // Replayed through the lowering, the server pair stays as-is.
  const replay = createProviderReplay('compat-responses:opencode-go', [SERVER_CALL, SERVER_OUTPUT]);
  const input = convertMessagesToResponsesInput([{ role: 'assistant', content: '', providerReplay: replay }], {
    replayProvider: 'compat-responses:opencode-go',
  });
  assert.deepEqual(input, [SERVER_CALL, SERVER_OUTPUT]);
});

test('first-party lowering defaults are unchanged: system skipped, openai-responses owner, flattened reasoning gated', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'a',
      reasoningItems: [{ id: 'r', encrypted_content: 'E', summary: [] }],
      providerReplay: createProviderReplay('compat-responses:opencode-go', [
        { type: 'reasoning', encrypted_content: 'X' },
      ]),
    },
  ];
  assert.deepEqual(convertMessagesToResponsesInput(messages), [
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
  ]);
  assert.equal(
    convertMessagesToResponsesInput(messages, { replayEncryptedReasoning: true }).some((i) => i.type === 'reasoning'),
    true
  );
});

test('prompt_cache_key follows an explicit route declaration; custom routes keep it by default', async () => {
  const session = { sessionId: 'sess-1' };
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = fixture('opencode-go');
  await sendCompatResponses(plain.provider, messages, 'gpt-5.5', [], session);
  assert.equal(Object.hasOwn(plain.requests[0], 'prompt_cache_key'), false);
  const viaConfig = fixture('opencode-go', { config: { responsesPromptCacheKey: true } });
  await sendCompatResponses(viaConfig.provider, messages, 'gpt-5.5', [], session);
  assert.equal(viaConfig.requests[0].prompt_cache_key, 'sess-1');
  await sendCompatResponses(plain.provider, messages, 'gpt-5.5', [], { ...session, responsesPromptCacheKey: true });
  assert.equal(plain.requests[1].prompt_cache_key, 'sess-1');
  const custom = fixture('custom-g');
  await sendCompatResponses(custom.provider, messages, 'gpt-5.5', [], session);
  assert.equal(custom.requests[0].prompt_cache_key, 'sess-1');
  const off = fixture('custom-g', { config: { responsesPromptCacheKey: false } });
  await sendCompatResponses(off.provider, messages, 'gpt-5.5', [], session);
  assert.equal(Object.hasOwn(off.requests[0], 'prompt_cache_key'), false);
});

// Intentional first-party delta from HEAD: custom_tool_call_output follows the
// documented Responses shape (call_id + output) and no longer carries the
// undocumented `name` field HEAD sent. Every other byte still matches HEAD.
const withoutCustomOutputName = (body) => ({
  ...body,
  input: body.input.map((item) => {
    if (item?.type !== 'custom_tool_call_output') return item;
    const { name: _name, ...rest } = item;
    return rest;
  }),
});

test('first-party openai / openai-oauth request bodies match HEAD (server-search synthesis and custom output name are the only deltas)', () => {
  let customOutputs = 0;
  for (const [name, model] of FIRST_PARTY) {
    for (const [label, build] of COMPAT_CASES) {
      const key = `first-party/${name}/${label}`;
      const actual = captureFirstParty(name, model, build(name, 'openai-responses'));
      const headOutputs = HEAD[key].input.filter((item) => item.type === 'custom_tool_call_output');
      customOutputs += headOutputs.length;
      // HEAD sent the name; the current lowering never does.
      for (const item of headOutputs) assert.equal(typeof item.name, 'string', key);
      for (const item of actual.input.filter((i) => i.type === 'custom_tool_call_output')) {
        assert.equal(Object.hasOwn(item, 'name'), false, key);
      }
      const head = HEAD[key];
      HEAD[key] = withoutCustomOutputName(head);
      try {
        assertHeadParity(key, actual);
      } finally {
        HEAD[key] = head;
      }
    }
  }
  assert.ok(customOutputs > 0, 'the fixtures exercise custom_tool_call_output');
});

test('compat-owned tool_search payloads survive native lowering; foreign payloads fall back to an empty output', async () => {
  const build = COMPAT_CASES.find(([label]) => label === 'own-search-output')[1];
  const own = await captureCompat('opencode-go', 'gpt-5.5', build('opencode-go'), NATIVE);
  const output = own.input.find((i) => i.type === 'tool_search_output');
  assert.equal(output.call_id, 'ts1');
  assert.deepEqual(
    output.tools.map((tool) => tool.name),
    ['x']
  );
  // The same payload tagged for another route is never replayed to this one.
  const foreign = await captureCompat('opencode-go', 'gpt-5.5', build('openai-oauth'), NATIVE);
  assert.deepEqual(foreign.input.find((i) => i.type === 'tool_search_output').tools, []);
});

test('HTTP SSE fallback never dispatches a server-executed tool_search (item-done and completion-only)', () => {
  const run = (events) => {
    const dispatched = [];
    const state = createHttpSseResponseState({
      body: { tools: [] },
      onToolCall: (call) => dispatched.push(call),
      meaningful() {},
      onServerEvent() {},
      label: 'test',
    });
    for (const event of events) state.handleEvent(event);
    return dispatched;
  };
  const completed = (output) => ({
    type: 'response.completed',
    response: { id: 'r1', model: 'm', status: 'completed', output },
  });
  assert.deepEqual(
    run([
      { type: 'response.output_item.added', item: SERVER_CALL },
      { type: 'response.output_item.done', item: SERVER_CALL },
      { type: 'response.output_item.done', item: SERVER_OUTPUT },
      completed([SERVER_CALL, SERVER_OUTPUT]),
    ]),
    []
  );
  assert.deepEqual(run([completed([SERVER_CALL, SERVER_OUTPUT])]), []);
  const clientCall = { ...SERVER_CALL, id: 'item_c', call_id: 'ts2', execution: 'client' };
  assert.deepEqual(
    run([completed([clientCall])]).map((call) => [call.id, call.name]),
    [['ts2', 'load_tool']]
  );
});

test('state reasoning is owner-tagged and never replayed under a different owner', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_state', encrypted_content: 'ENC', summary: [] };
  const turn = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
  ];
  const stateFor = (owner, shape = 'history') => ({
    compatResponses: {
      store: false,
      seenMessageCount: 3,
      model: 'gpt-5.5',
      ...(owner === undefined ? {} : { owner }),
      ...(shape === 'history'
        ? {
            encryptedReasoningHistory: [
              { messageIndex: 1, items: [reasoning], ...(owner === undefined ? {} : { owner }) },
            ],
          }
        : { encryptedReasoningItems: [reasoning] }),
    },
  });
  for (const config of [{}, NATIVE]) {
    for (const shape of ['history', 'items']) {
      const send = async (owner) => {
        const { input } = await captureCompat(
          'opencode-go',
          'gpt-5.5',
          turn,
          { providerState: stateFor(owner, shape) },
          config
        );
        return JSON.stringify(input);
      };
      const label = `${shape} native=${config.responsesNativeItems === true}`;
      assert.equal((await send('compat-responses:opencode-go')).includes('ENC'), true, label);
      assert.equal((await send('compat-responses:muse-code')).includes('ENC'), false, label);
      assert.equal((await send('xai-responses')).includes('ENC'), false, label);
    }
  }
  // A response's reasoning is stored tagged with the route that produced it.
  const { provider } = fixture('opencode-go', { output: [reasoning, REPLY] });
  const result = await sendCompatResponses(provider, turn, 'gpt-5.5', [], {});
  const state = result.providerState.compatResponses;
  assert.equal(state.owner, 'compat-responses:opencode-go');
  assert.deepEqual(
    state.encryptedReasoningHistory.map((entry) => entry.owner),
    ['compat-responses:opencode-go']
  );
});
