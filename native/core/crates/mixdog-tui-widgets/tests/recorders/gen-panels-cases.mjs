// Writes tests/cases/panels.json: the corpus of the floating panels (context panel with its inspector, usage panel, /btw
// panel), taken from the props of status-panels.test.mjs, btw-panel.test.mjs, context-inspector.test.mjs and
// usage-context-panels.test.mjs. The cases are generated, not typed, so a width or a theme is one more loop turn.
//
//   node gen-panels-cases.mjs > ../cases/panels.json
//
// The reset time of a quota window depends on the clock and the time zone, so no case carries a `resetAt`: the reset text is
// covered by unit tests in usage_panel.rs, which pin both.

const cases = [];
const frame = (id, component, columns, props, extra = {}) =>
  cases.push({ id, kind: 'frame', component, columns, props: { columns, ...props }, ...extra });

const WIDTHS = [50, 80, 120];
const THEMES = ['basic', 'light', 'dracula'];
const KEYS = { enter: '\r', up: '\u001b[A', down: '\u001b[B', left: '\u001b[D', pageUp: '\u001b[5~', pageDown: '\u001b[6~', home: '\u001b[H', end: '\u001b[F' };

// ---- ContextPanel: the plain list --------------------------------------------------------------------------------------
const LIST = [
  { value: 'model', label: 'Model', description: 'claude-sonnet-5-5 through the Anthropic account' },
  { value: 'window', label: 'Window', description: '200k tokens, 160k before compaction' },
  { value: 'long', label: 'A label that is far too long for its column', description: 'x'.repeat(120) },
  { value: 'cjk', label: '한글 항목', description: '한글로 쓴 긴 설명이 한 줄에 다 들어가지 않을 때 잘리는 모양을 본다 '.repeat(3) },
];
for (const width of WIDTHS) {
  frame(`context-list-w${width}`, 'ContextPanel', width, { rows: LIST, description: 'Plain rows under the title.' });
  frame(`context-list-empty-w${width}`, 'ContextPanel', width, { rows: [] });
}
frame('context-list-title', 'ContextPanel', 80, { rows: LIST.slice(0, 2), title: 'Session', description: '  spaced \n  out   description  ' });
frame('context-list-fill', 'ContextPanel', 80, { rows: LIST.slice(0, 2), fillHeight: true }, { rows: 20 });

// ---- ContextPanel: a context report ------------------------------------------------------------------------------------
const bucket = (tokens) => ({ tokens });
const REPORT = {
  type: 'context',
  usage: { usedTokens: 84210, windowTokens: 200000, rawWindowTokens: 220000, measurementSource: 'last_api_request', effective: true },
  compaction: { stage: 'idle', state: 'ready', type: 'auto', triggerTokens: 160000, boundaryTokens: 120000, pressureTokens: 90000, reserveTokens: 20000 },
  messages: {
    semantic: {
      system: bucket(6200), workflow: bucket(800), workspace: bucket(1500), environment: bucket(400), other: bucket(100),
      memory: bucket(2300), chat: bucket(20000), assistant: bucket(30000), toolResults: bucket(15000), reasoning: bucket(4000),
    },
  },
  request: {
    toolSchemaBreakdown: {
      code: bucket(3000), web: bucket(1200), mutation: bucket(900), channels: bucket(300), setup: bucket(200), other: bucket(100),
      control: bucket(400), session: bucket(500), mcp: bucket(2500), agents: bucket(700), memory: bucket(300), skills: bucket(1100),
    },
  },
  lastApi: { contextTokens: 84210, inputTokens: 3100, outputTokens: 950, rawInputTokens: 3300 },
  cache: { writeTokens: 1200, hitRate: '94%' },
  speed: { outputTokensPerSecond: 42.7 },
};
for (const width of WIDTHS) {
  frame(`context-report-w${width}`, 'ContextPanel', width, { rows: [], detail: REPORT });
}
for (const theme of THEMES) {
  frame(`context-report-theme-${theme}`, 'ContextPanel', 80, { rows: [], detail: REPORT }, { theme, levels: theme === 'basic' ? true : undefined });
}
frame('context-report-unavailable', 'ContextPanel', 80, {
  rows: [],
  detail: { type: 'context', usage: { usedTokens: null, windowTokens: 200000, measurementSource: 'unavailable' } },
});
frame('context-report-pending', 'ContextPanel', 80, { rows: [], detail: { type: 'context' } });
frame('context-report-warning', 'ContextPanel', 80, {
  rows: [],
  detail: { type: 'context', usage: { usedTokens: 170000, windowTokens: 200000, measurementSource: 'last_api_request' }, speed: { outputTokensPerSecond: 5.25 } },
});
frame('context-report-critical', 'ContextPanel', 80, {
  rows: [],
  detail: { type: 'context', usage: { usedTokens: 199000, windowTokens: 200000, rawWindowTokens: 200000, measurementSource: 'last_api_request' }, messages: { semantic: { chat: bucket(260000) } } },
});
frame('context-report-conserve', 'ContextPanel', 80, {
  rows: [],
  detail: { type: 'context', usage: { usedTokens: 500, windowTokens: 1000, rawWindowTokens: 1200, measurementSource: 'last_api_request' } },
});
frame('context-report-fill', 'ContextPanel', 80, { rows: [], detail: REPORT, fillHeight: true }, { rows: 30 });
frame('context-report-description', 'ContextPanel', 80, { rows: [], detail: REPORT, description: 'A description of the report.' });

// ---- ContextPanel with an inspection (the inspector inside) -------------------------------------------------------------
const INSPECTION = {
  revision: 'rev-1',
  categories: [
    { key: 'system', label: 'System messages', tokens: 6200, count: 4 },
    { key: 'user', label: 'User messages', tokens: 3100, count: 12 },
    { key: 'assistant', label: 'Assistant messages', tokens: 30000, count: 11 },
    { key: 'reasoning', label: 'Reasoning tokens', tokens: 4000 },
    { key: 'toolResults', label: 'Tool results', tokens: 15000, count: 9 },
    { key: 'attachments', label: 'Attachments', tokens: 800 },
    { key: 'tools', label: 'System tools', tokens: 6600 },
    { key: 'mcp', label: 'MCP tools', tokens: 2500 },
    { key: 'agents', label: 'Custom agents', tokens: 700 },
    { key: 'memory', label: 'Memory files', tokens: 2300 },
    { key: 'skills', label: 'Skills', tokens: 1100 },
  ],
  entries: [
    { id: 'm:0', category: 'system', label: 'Instructions', tokens: 4100 },
    { id: 'm:1', category: 'system', label: 'Reminders', tokens: 2100, state: 'stale' },
    { id: 'u:0', category: 'user', label: 'First prompt', tokens: 1200 },
    { id: 'r:0', category: 'toolResults', label: 'Bash output', tokens: 1200, toolResults: [{ name: 'Bash' }, { name: 'Read' }], count: 2 },
    { id: 'r:1', category: 'toolResults', label: 'Read output', tokens: 9000, state: 'active' },
    { id: 't:0', category: 'tools', label: 'Read', tokens: 50, state: 'deferred' },
    { id: 't:1', category: 'tools', label: 'Edit', tokens: 1250 },
    ...Array.from({ length: 14 }, (_, index) => ({ id: `a:${index}`, category: 'assistant', label: `Answer ${index}`, tokens: 1000 + index * 137 })),
  ],
  calibration: { source: 'provider', measuredTokens: 84210, ratio: 0.93, estimatedTokens: 90500 },
};
const INSPECTED = { type: 'context', inspection: INSPECTION, usage: { usedTokens: 84210, windowTokens: 200000, rawWindowTokens: 220000, measurementSource: 'last_api_request' } };
const SPIES = ['onInspect', 'onRefresh'];
for (const width of WIDTHS) {
  frame(`inspector-list-w${width}`, 'ContextPanel', width, { rows: [], detail: INSPECTED, panelRows: 26 }, { spies: SPIES });
}
for (const theme of THEMES) {
  frame(`inspector-theme-${theme}`, 'ContextPanel', 80, { rows: [], detail: INSPECTED, panelRows: 26 }, { theme, spies: SPIES, levels: theme === 'basic' ? true : undefined });
}
frame('inspector-open-preview', 'ContextPanel', 80, { rows: [], detail: INSPECTED, panelRows: 26 }, {
  keys: [KEYS.enter, KEYS.down, KEYS.enter, KEYS.left, KEYS.left, 'z', 'z', 'r'],
  spies: SPIES,
});
frame('inspector-entries-scroll', 'ContextPanel', 80, { rows: [], detail: INSPECTED, panelRows: 22 }, {
  keys: [KEYS.down, KEYS.down, KEYS.enter, KEYS.pageDown, KEYS.pageDown, KEYS.down, KEYS.up, KEYS.pageUp, KEYS.pageUp, KEYS.left],
  spies: SPIES,
});
frame('inspector-fit-zoom', 'ContextPanel', 80, { rows: [], detail: INSPECTED, panelRows: 26 }, { keys: ['z', 'z'], spies: SPIES });
frame('inspector-empty-category', 'ContextPanel', 80, { rows: [], detail: INSPECTED, panelRows: 26 }, {
  keys: [KEYS.down, KEYS.down, KEYS.down, KEYS.enter, KEYS.enter, KEYS.left],
  spies: SPIES,
});
frame('inspector-small-rows', 'ContextPanel', 50, { rows: [], detail: INSPECTED, panelRows: 6 }, { keys: [KEYS.enter, KEYS.down], spies: SPIES });
frame('inspector-local-estimates', 'ContextPanel', 80, {
  rows: [],
  detail: { ...INSPECTED, inspection: { ...INSPECTION, calibration: { source: 'local' } } },
  panelRows: 26,
}, { spies: SPIES });
frame('inspector-over-window', 'ContextPanel', 80, {
  rows: [],
  detail: { ...INSPECTED, usage: { usedTokens: 84210, windowTokens: 20000, measurementSource: 'last_api_request' } },
  panelRows: 26,
}, { spies: SPIES });
frame('inspector-cjk-label', 'ContextPanel', 50, {
  rows: [],
  detail: { type: 'context', inspection: { revision: 'k', categories: [{ key: 'user', label: '사용자 메시지', tokens: 3100, count: 2 }], entries: [{ id: 'u:0', category: 'user', label: '첫 번째 프롬프트에 대한 아주 긴 한글 설명이 이어진다', tokens: 1200 }] }, usage: { usedTokens: 30, windowTokens: 100 } },
  panelRows: 22,
}, { keys: [KEYS.enter], spies: SPIES });

// ---- UsagePanel -------------------------------------------------------------------------------------------------------
const windowsOf = (index) => [
  { label: '5h', usedPct: (index * 13) % 100, source: 'oauth' },
  { label: 'week', usedPct: (index * 7) % 100, source: 'oauth' },
  { label: 'month', usedPct: 3, source: 'oauth' },
];
const MIXED = [
  { id: 'anthropic', label: 'Anthropic OAuth', windows: windowsOf(5) },
  { id: 'openai', label: 'OpenAI', windows: windowsOf(9), remainingUsd: 12.5 },
  { id: 'billing', label: 'Billing style', windows: [{ label: 'bal', remainingUsd: 4.25, source: 'api' }] },
  { id: 'spent', label: 'Spent', windows: [{ label: 'use', usedUsd: 1.5, limitUsd: 20, source: 'api' }] },
  { id: 'credits', label: 'Credits', windows: [{ label: 'cr', remainingCredits: 1500, limitCredits: 20000, source: 'api' }] },
  { id: 'credits-used', label: 'Credits used', windows: [{ label: 'cr', usedCredits: 15000, limitCredits: 20000, usedPct: 'x', source: 'api' }] },
  { id: 'estimate', label: 'Local estimate', windows: [{ label: 'day', usedPct: 42 }, { label: 'wk', remainingUsd: 3.5, source: 'local-estimate' }] },
  { id: 'hot', label: 'Nearly out', windows: [{ label: '5h', usedPct: 96, source: 'oauth' }, { label: 'week', usedPct: 85, source: 'oauth' }] },
  { id: 'credit-only', label: 'Credit only', remainingUsd: 0 },
  { id: 'credit-low', label: 'Credit low', remainingUsd: 0.75 },
  { id: 'checking', label: 'Checking one', status: 'checking' },
  { id: 'hidden', label: 'Hidden balance', status: 'hidden', primary: 'n/a' },
  { id: 'hidden-bare', label: 'Hidden bare', status: 'hidden' },
  { id: 'missing', label: 'Missing key', status: 'missing', primary: 'no key' },
  { id: 'error', label: 'Errored', status: 'error' },
  { id: 'local', label: 'Local only', status: 'local' },
  { id: 'tokens', label: 'Token count', primary: '12.4K tokens' },
  { id: 'cjk', label: '한글 공급자 이름이 아주 길면 잘린다 한글 공급자', windows: [{ label: '시간', usedPct: 12, source: 'oauth' }] },
  { label: 'no id', primary: 'no id row' },
];
for (const width of WIDTHS) {
  frame(`usage-mixed-w${width}`, 'UsagePanel', width, { dashboard: { title: 'Provider Quotas', subtitle: 'Quota windows and balances.', rows: MIXED } });
  frame(`usage-few-w${width}`, 'UsagePanel', width, { dashboard: { rows: MIXED.slice(0, 3) } });
  frame(`usage-empty-w${width}`, 'UsagePanel', width, { dashboard: { rows: [] } });
  frame(`usage-loading-w${width}`, 'UsagePanel', width, { dashboard: { rows: [] }, loading: true });
}
for (const theme of THEMES) {
  frame(`usage-theme-${theme}`, 'UsagePanel', 80, { dashboard: { rows: MIXED.slice(0, 8) } }, { theme, levels: theme === 'basic' ? true : undefined });
}
frame('usage-checking-empty', 'UsagePanel', 80, { dashboard: { checking: true, rows: [] } });
frame('usage-loading-with-rows', 'UsagePanel', 80, { dashboard: { loading: true, rows: MIXED.slice(0, 3) } });
frame('usage-checking-with-rows', 'UsagePanel', 80, { dashboard: { checking: true, rows: MIXED.slice(0, 3) } });
frame('usage-no-dashboard', 'UsagePanel', 80, {});
frame('usage-fill', 'UsagePanel', 80, { dashboard: { rows: MIXED.slice(0, 3) }, fillHeight: true }, { rows: 24 });
frame('usage-scroll', 'UsagePanel', 80, { dashboard: { rows: MIXED }, panelRows: 12 }, {
  keys: [KEYS.down, KEYS.down, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.up, KEYS.pageUp, KEYS.end, KEYS.home],
});
frame('usage-scroll-w50', 'UsagePanel', 50, { dashboard: { rows: MIXED }, panelRows: 9 }, { keys: [KEYS.pageDown, KEYS.pageDown, KEYS.end, KEYS.up] });
frame('usage-scroll-w120', 'UsagePanel', 120, { dashboard: { rows: MIXED }, panelRows: 15 }, { keys: [KEYS.down, KEYS.pageDown, KEYS.end] });
frame('usage-measured-fits', 'UsagePanel', 80, { dashboard: { rows: MIXED.slice(0, 3) }, panelRows: 20 }, { keys: [KEYS.down, KEYS.end] });
frame('usage-scroll-loading', 'UsagePanel', 80, { dashboard: { rows: MIXED, loading: true }, panelRows: 9 }, { keys: [KEYS.down, KEYS.pageDown] });

// ---- BtwPanel -----------------------------------------------------------------------------------------------------------
const lines = (count) => Array.from({ length: count }, (_, index) => `entry-${index}`).join('\n');
const RICH = [
  '# A heading',
  '',
  'A paragraph with **bold**, *italic*, `code` and a [link](https://example.com/page).',
  '',
  '- first item',
  '- second item with more words so that it has to wrap on a narrow panel',
  '',
  '1. one',
  '2. two',
  '',
  '```js',
  'const answer = 42;',
  'console.log(answer);',
  '```',
  '',
  '> a quote',
  '',
  '| name | value |',
  '| --- | --- |',
  '| alpha | 1 |',
  '| beta | 22 |',
].join('\n');
for (const width of WIDTHS) {
  frame(`btw-pending-w${width}`, 'BtwPanel', width, { panel: { question: 'why is the sky blue?', status: 'pending', text: '' } });
  frame(`btw-error-w${width}`, 'BtwPanel', width, { panel: { question: 'why?', status: 'error', text: 'side question failed' } });
  frame(`btw-short-w${width}`, 'BtwPanel', width, { panel: { question: 'why?', status: 'done', text: 'short' }, panelRows: 9 });
  frame(`btw-rich-w${width}`, 'BtwPanel', width, { panel: { question: 'show me every kind of block', status: 'done', text: RICH }, panelRows: 14 });
  frame(`btw-long-w${width}`, 'BtwPanel', width, { panel: { question: 'why?', status: 'done', text: lines(12) }, panelRows: 9 });
}
for (const theme of THEMES) {
  frame(`btw-theme-${theme}`, 'BtwPanel', 80, { panel: { question: 'themes', status: 'done', text: RICH }, panelRows: 14 }, { theme, levels: theme === 'basic' ? true : undefined });
}
frame('btw-scroll', 'BtwPanel', 80, { panel: { question: 'why?', status: 'done', text: lines(12) }, panelRows: 9 }, {
  keys: [KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageUp, KEYS.pageUp, KEYS.pageUp, KEYS.pageUp, 'a'],
});
frame('btw-scroll-rich', 'BtwPanel', 50, { panel: { question: 'rich', status: 'done', text: RICH }, panelRows: 10 }, {
  keys: [KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageUp],
});
frame('btw-scroll-error', 'BtwPanel', 50, { panel: { question: 'err', status: 'error', text: lines(8) }, panelRows: 8 }, { keys: [KEYS.pageDown, KEYS.pageDown, KEYS.pageUp] });
frame('btw-default-rows', 'BtwPanel', 80, { panel: { question: 'default rows', status: 'done', text: lines(4) } });
frame('btw-cjk', 'BtwPanel', 50, { panel: { question: '하늘은 왜 파란가요? 아주 긴 질문이 제목 한 줄에 들어가지 않을 때', status: 'done', text: '하늘이 파란 것은 빛의 산란 때문입니다. '.repeat(6) }, panelRows: 9 });
frame('btw-long-question', 'BtwPanel', 50, { panel: { question: 'q'.repeat(80), status: 'pending', text: '' } });

process.stdout.write(JSON.stringify(cases, null, 1) + '\n');
