// Shared by xai-tool-search.test.mjs and the one-off generator that produced
// xai-tool-search-head-parity.json by running these same captures against the
// pre-change xAI send path. The WebSocket transport is driven through the real
// sendViaWebSocket with a scripted socket, so the real stream collector and
// delta framing run; only the connection is replaced.
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import * as realWs from './openai-oauth-ws.mjs';

export const ws = { bodies: [], frames: [], scripts: [] };

function scriptedEntry() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.close = () => {
    socket.readyState = 3;
  };
  socket.terminate = socket.close;
  return { socket, ephemeral: true };
}

mock.module(new URL('./openai-oauth-ws.mjs', import.meta.url).href, {
  namedExports: {
    ...realWs,
    sendViaWebSocket: (args) => {
      ws.bodies.push(structuredClone(args.body));
      return realWs.sendViaWebSocket({
        ...args,
        _acquireWithRetryFn: async () => ({ entry: scriptedEntry(), reused: false }),
        _sendFrameFn: async (entry, frame) => {
          ws.frames.push(structuredClone(frame));
          const events = ws.scripts.shift() || [COMPLETED_REPLY];
          setImmediate(() => {
            for (const event of events) entry.socket.emit('message', Buffer.from(JSON.stringify(event)));
          });
        },
      });
    },
  },
});

const { sendXaiResponses, sendXaiResponsesWebSocket } = await import('./openai-compat-xai-send.mjs');
const { nativeHistory, oauthHistory } = await import('./openai-compat-responses-parity.fixtures.mjs');
export { sendXaiResponses, sendXaiResponsesWebSocket, nativeHistory, oauthHistory };

export const REPLY = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
export const COMPLETED_REPLY = {
  type: 'response.completed',
  response: { id: 'resp-1', model: 'grok-4', status: 'completed', output: [REPLY] },
};

// A recorded xAI server-side tool-search turn (shapes per xAI's OpenAPI schema
// ToolSearchCall / ToolSearchOutput: execution always "server", call_id null).
export const ENCRYPTED_REASONING = { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] };
export const TS_CALL = {
  type: 'tool_search_call',
  id: 'tsc_1',
  call_id: null,
  execution: 'server',
  status: 'completed',
  arguments: { query: 'mcp__weather__forecast', limit: 1 },
};
export const TS_OUTPUT = {
  type: 'tool_search_output',
  id: 'tso_1',
  call_id: null,
  execution: 'server',
  status: 'completed',
  tools: [
    {
      type: 'function',
      name: 'mcp__weather__forecast',
      description: 'Forecast',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      defer_loading: true,
    },
  ],
};
export const FN_CALL = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_w',
  name: 'mcp__weather__forecast',
  arguments: '{"city":"Seoul"}',
  status: 'completed',
};
export const TURN_OUTPUT = [ENCRYPTED_REASONING, TS_CALL, TS_OUTPUT, FN_CALL];

/** The stream events one server tool-search turn emits, in wire order. */
export function serverSearchEvents(model = 'grok-4') {
  return [
    { type: 'response.created', response: { id: 'resp_ts', model } },
    { type: 'response.output_item.done', item: ENCRYPTED_REASONING },
    { type: 'response.output_item.added', item: { ...TS_CALL, status: 'in_progress' } },
    { type: 'response.output_item.done', item: TS_CALL },
    { type: 'response.output_item.added', item: TS_OUTPUT },
    { type: 'response.output_item.done', item: TS_OUTPUT },
    { type: 'response.output_item.added', item: { ...FN_CALL, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: FN_CALL.arguments },
    { type: 'response.output_item.done', item: FN_CALL },
    {
      type: 'response.completed',
      response: { id: 'resp_ts', model, status: 'completed', output: TURN_OUTPUT },
    },
  ];
}

export const SESSION_TOOLS = [
  { name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'load_tool', description: 'Load tools', inputSchema: { type: 'object', properties: { names: { type: 'array' } } } },
];
export const DEFERRED_TOOLS = [
  ...SESSION_TOOLS,
  {
    name: 'mcp__weather__forecast',
    description: 'Forecast',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    deferLoading: true,
  },
];

export function xaiProvider(config = {}, events = null) {
  const requests = [];
  const provider = {
    name: 'xai',
    config: { apiKey: 'test-key', preconnect: false, ...config },
    nativePdf: true,
    client: {
      responses: {
        create: async (params) => {
          requests.push(structuredClone(params));
          return (async function* () {
            for (const event of events || [COMPLETED_REPLY]) yield event;
          })();
        },
      },
    },
  };
  return { provider, requests };
}

/** The history left by a recorded server tool-search turn (replay owner xai-responses). */
export function serverSearchHistory() {
  return [
    { role: 'user', content: 'weather in Seoul?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_w', name: 'mcp__weather__forecast', arguments: { city: 'Seoul' } }],
      providerReplay: { version: 1, provider: 'xai-responses', items: structuredClone(TURN_OUTPUT) },
    },
    { role: 'tool', toolCallId: 'call_w', content: 'sunny' },
    { role: 'user', content: 'and Busan?' },
  ];
}

export const CASES = [
  ['native/plain-tools', () => nativeHistory(), SESSION_TOOLS],
  ['oauth/plain-tools', () => oauthHistory(), SESSION_TOOLS],
  ['server-replay/plain-tools', () => serverSearchHistory(), SESSION_TOOLS],
  ['server-replay/deferred-tools', () => serverSearchHistory(), DEFERRED_TOOLS],
  ['native/deferred-tools', () => nativeHistory(), DEFERRED_TOOLS],
];

/** The request body each transport sends for `history`, plus any option overrides. */
export async function captureBodies(history, tools, { config = {}, opts = {} } = {}) {
  const http = xaiProvider(config);
  await sendXaiResponses(http.provider, history, 'grok-4', tools, { sessionId: 'sess-1', ...opts });
  const before = ws.bodies.length;
  const socket = xaiProvider(config);
  await sendXaiResponsesWebSocket(socket.provider, history, 'grok-4', tools, { sessionId: 'sess-1', iteration: 1, ...opts });
  return { http: http.requests[0], ws: ws.bodies[before] };
}

export async function captureAll() {
  const out = {};
  for (const [label, build, tools] of CASES) {
    const { http, ws: socketBody } = await captureBodies(build(), tools);
    out[`http/${label}`] = http;
    out[`ws/${label}`] = socketBody;
  }
  return out;
}
