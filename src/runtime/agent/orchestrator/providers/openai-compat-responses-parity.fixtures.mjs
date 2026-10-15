// Shared by openai-compat-responses-native.test.mjs and the one-off generator
// that produced openai-compat-responses-head-parity.json by running these same
// captures against the pre-change (HEAD) converters.
import { sendCompatResponses } from './openai-compat-responses.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { buildRequestBody } from './openai-responses-payload.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';

export const SERVER_CALL = {
  type: 'tool_search_call',
  id: 'ts_srv',
  call_id: null,
  execution: 'server',
  arguments: { query: 'q' },
};
export const SERVER_OUTPUT = { type: 'tool_search_output', id: 'tso_srv', call_id: null, execution: 'server', tools: [] };
export const REPLY = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };

export const ROUTES = [
  ['opencode-go', 'gpt-5.5'],
  ['muse-code', 'muse-spark'],
  ['command-code', 'gpt-5.5'],
  ['custom-cmd', 'openai/gpt-5.6-sol'],
  ['openrouter', 'openai/gpt-5.5'],
  ['xai', 'grok-4'],
  ['opencode-go', 'grok-4'],
];
export const FIRST_PARTY = [
  ['openai', 'gpt-5.5'],
  ['openai-oauth', 'gpt-5.5'],
];

export const replayOwner = (name) => `compat-responses:${name}`;

const search = (name) => ({
  provider: name,
  openaiTools: [{ type: 'function', name: 'x', description: 'd', parameters: { type: 'object', properties: {} } }],
});

export function nativeHistory() {
  return [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'ts1', name: 'load_tool', arguments: { names: ['x'] }, nativeType: 'tool_search_call' },
        { id: 'cu1', name: 'apply_patch', arguments: { patch: 'P' }, nativeType: 'custom_tool_call' },
        { id: 'fn1', name: 'Read', arguments: { path: 'a' } },
      ],
    },
    { role: 'tool', toolCallId: 'ts1', content: 'loaded' },
    { role: 'tool', toolCallId: 'cu1', content: 'patched' },
    { role: 'tool', toolCallId: 'fn1', content: 'file' },
    { role: 'user', content: 'next' },
  ];
}

// Left by a previous openai-oauth route: native search/custom calls, native
// search results carrying loaded tools, phase-tagged assistant turns, a Skill
// result with loadable tools, and a foreign openai-responses replay.
export function oauthHistory() {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'working', phase: 'commentary', toolCalls: [] },
    {
      role: 'assistant',
      content: 'looking',
      phase: 'commentary',
      reasoningItems: [{ id: 'rs', encrypted_content: 'ENC', summary: [] }],
      toolCalls: [
        { id: 'ts1', name: 'load_tool', arguments: { names: ['x'] }, nativeType: 'tool_search_call' },
        { id: 'cu1', name: 'apply_patch', arguments: { patch: 'P' }, nativeType: 'custom_tool_call' },
        { id: 'sk1', name: 'Skill', arguments: { name: 's' } },
      ],
    },
    { role: 'tool', toolCallId: 'ts1', content: 'loaded', nativeToolSearch: search('openai-oauth') },
    { role: 'tool', toolCallId: 'cu1', content: 'patched' },
    { role: 'tool', toolCallId: 'sk1', content: 'skill', nativeToolSearch: search('openai-oauth') },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'f2', name: 'Read', arguments: { path: 'a' } }],
      providerReplay: createProviderReplay('openai-responses', [
        { type: 'tool_search_call', call_id: 'ts9', execution: 'client', arguments: {} },
      ]),
    },
    { role: 'tool', toolCallId: 'f2', content: 'file' },
    { role: 'user', content: 'next' },
  ];
}

// Same-owner replay envelope holding a server-executed search pair.
export function serverSearchReplayHistory(owner) {
  return [
    { role: 'user', content: 'find tools' },
    {
      role: 'assistant',
      content: 'done',
      providerReplay: createProviderReplay(owner, [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
        SERVER_CALL,
        SERVER_OUTPUT,
        { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' },
      ]),
      toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }],
    },
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
    { role: 'user', content: 'next' },
  ];
}

// Pre-change flag-off cases: [label, history(name), providerState?]
export const COMPAT_CASES = [
  ['native', () => nativeHistory()],
  ['oauth', () => oauthHistory()],
  ['own-search-output', (name) => {
    const h = nativeHistory();
    h[2] = { ...h[2], nativeToolSearch: search(name) };
    return h;
  }],
  ['server-replay', (name, owner = replayOwner(name)) => serverSearchReplayHistory(owner)],
];

export function compatProvider(name, config = {}) {
  const requests = [];
  const provider = Object.assign(Object.create(OpenAICompatProvider.prototype), {
    name,
    config: { preconnect: false, ...config },
    nativePdf: true,
    client: {
      responses: {
        create: async (params) => {
          requests.push(structuredClone(params));
          return (async function* () {
            yield {
              type: 'response.completed',
              response: { id: 'resp-1', model: params.model, status: 'completed', output: [REPLY] },
            };
          })();
        },
      },
    },
  });
  return { provider, requests };
}

export async function captureCompat(name, model, history, opts = {}, config = {}) {
  const { provider, requests } = compatProvider(name, config);
  await sendCompatResponses(provider, history, model, [], { sessionId: 'sess-1', ...opts });
  return requests[0];
}

export function captureFirstParty(name, model, history) {
  return JSON.parse(JSON.stringify(buildRequestBody(history, model, [], { promptCacheProvider: name, sessionId: 'sess-1' })));
}

export async function captureAll() {
  const out = {};
  for (const [name, model] of ROUTES) {
    for (const [label, build] of COMPAT_CASES) {
      out[`compat/${name}/${model}/${label}`] = await captureCompat(name, model, build(name));
    }
  }
  for (const [name, model] of FIRST_PARTY) {
    for (const [label, build] of COMPAT_CASES) {
      out[`first-party/${name}/${label}`] = captureFirstParty(name, model, build(name, 'openai-responses'));
    }
  }
  return out;
}
