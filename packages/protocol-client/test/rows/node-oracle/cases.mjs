// Inputs whose outputs are recorded from Node (b6f10295a) by record.mjs into node-oracle.golden.json, and replayed
// against the rows modules by the tests. `deep` builds the nested-array input at the recursion cap.
const nest = (levels, inner = 'x') => {
  let value = inner;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
};

export const TOOL_RESULT_TEXT = [
  ['toolResultText', [['a', { type: 'text', text: 'b' }, { type: 'text', text: '' }, null]]],
  ['toolResultText', [{ content: [{ type: 'output_text', text: 'x' }] }]],
  ['toolResultText', [{ parts: [{ type: 'input_text', text: 'p' }, { type: 'text' }] }]],
  ['toolResultText', [{ content: { type: 'text', text: 'single' } }]],
  ['toolResultText', [[{ type: 'image', mimeType: 'image/png' }]]],
  ['toolResultText', [[{ type: 'image' }]]],
  ['toolResultText', [{ source: { type: 'base64', data: 'AA', media_type: 'image/jpeg' } }]],
  ['toolResultText', [{ type: 'tool_result', content: [{ type: 'text', text: 'deep' }] }]],
  ['toolResultText', [{ type: 'tool_result', content: 'flat' }]],
  ['toolResultText', [{ type: 'tool_result', content: [] }]],
  ['toolResultText', [{ output: 'out' }]],
  ['toolResultText', [{ message: 'msg' }]],
  ['toolResultText', [{ foo: 1 }]],
  ['toolResultText', [{}]],
  ['toolResultText', [null]],
  ['toolResultText', ['plain']],
  ['toolResultText', [nest(3)]],
  ['toolResultText', [nest(8)]],
  ['toolResultText', [nest(9)]],
  ['toolResultText', [nest(10)]],
  ['toolResultText', [nest(20)]],
  ['toolResultText', [{ content: nest(6, { type: 'text', text: 'at the cap' }) }]],
  ['toolResultText', [[{ type: 'image', source: { media_type: 'image/webp' } }, 'after']]],
  ['toolAggregateDetailFallback', ['  summary  ', 'other result']],
  ['toolAggregateDetailFallback', ['', '\ufeff \r\n\u00a0 result \t\r\nsecond line\n']],
  ['toolAggregateDetailFallback', [null, '\ufeff \n\u00a0']],
  ['toolAggregateDetailFallback', ['', 'x'.repeat(79)]],
  ['toolAggregateDetailFallback', ['', 'x'.repeat(80)]],
  ['toolAggregateDetailFallback', ['', 'x'.repeat(81)]],
  ['toolAggregateDetailFallback', ['', 'x'.repeat(200)]],
  ['toolAggregateDetailFallback', [undefined, '   ']],
  ['toolAggregateDetailFallback', ['', '\n\n  first nonblank  \nsecond']],
];

const measurement = (tokens, source, updatedAt) => ({ measurement: { tokens, source, ...(updatedAt === undefined ? {} : { updatedAt }) } });

export const CONTEXT_MEASUREMENT = [
  ['stats', measurement(8300, 'last_api_request', 5), { contextWindow: 436000 }],
  ['stats', measurement(24000, 'pending'), { contextWindow: 100000 }],
  ['stats', measurement(24000, 'unavailable'), { contextWindow: 100000 }],
  ['stats', measurement(0, 'last_api_request'), { contextWindow: 100000 }],
  ['stats', measurement(-5, 'last_api_request'), { contextWindow: 100000 }],
  ['stats', measurement('abc', 'last_api_request'), { contextWindow: 100000 }],
  ['stats', measurement(null, 'last_api_request'), { contextWindow: 100000 }],
  ['stats', measurement(150000, 'last_api_request'), { contextWindow: 100000 }],
  ['stats', measurement(1234, 'last_api_request'), { contextWindow: 0, displayContextWindow: 200000 }],
  ['stats', measurement(1234, 'last_api_request'), { contextWindow: 0, rawContextWindow: 400000 }],
  ['stats', measurement(1234, 'last_api_request'), {}],
  ['stats', { lastApiRequestTokens: 9000, lastApiRequestStale: false }, { contextWindow: 90000 }],
  ['stats', { lastApiRequestTokens: 9000, lastApiRequestStale: true }, { contextWindow: 90000 }],
  ['stats', {}, { contextWindow: 90000 }],
  ['stats', null, { contextWindow: 90000 }],
  ['usage', { currentContextTokens: 5000, currentContextSource: 'last_api_request' }, { contextWindow: 100000 }],
  ['usage', { currentContextTokens: 5000 }, { contextWindow: 100000 }],
  ['usage', { currentContextTokens: 5000, currentContextSource: 'estimate' }, { contextWindow: 100000 }],
  ['usage', { currentContextTokens: 5000, currentContextSource: 'unavailable' }, { contextWindow: 100000 }],
  ['usage', { currentContextTokens: null, currentContextSource: 'unavailable' }, { contextWindow: 100000 }],
  ['usage', { currentContextTokens: 33333, currentContextSource: 'last_api_request' }, { contextWindow: 100000 }],
  ['usage', { currentContextTokens: 1, currentContextSource: 'last_api_request' }, { contextWindow: 3 }],
];
