// Records the Node golden for the Rust display helpers (mixdog-view-model: display/*). Every exported function of the
// Node modules named below runs over
//   (a) the model ids and names of every provider catalog in native/core/fixtures/model-lists-statusline,
//   (b) grids of context states, liveness entries, usage deltas, tool calls, skill-mention strings and usage numbers
//       (the cases of statusline-segments.test.mjs are filesystem tests: they run in Rust over a map of files),
// and the outputs are written beside their inputs; tests/display_twin.rs replays the file in Rust.
//
//   node tests/recorders/record-display.mjs [--tree <repo>] [--fixtures <dir>] [--out <file>]
//   node tests/recorders/record-display.mjs [--tree <repo>] [--fixtures <dir>] --check <file>
//
// --tree is the Node product's tree (default: the repository this file sits in); --fixtures defaults to
// <tree>/native/core/fixtures. Not recorded: modelContextWindow and formatModelSegment (they read the model catalog; unit
// tests give the Rust lookup), epochMsToHHMM (it reads the machine's time zone) and terminalColumns (the terminal).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The footer decides its colours once, at import: record the coloured form.
process.env.FORCE_COLOR = '1';
delete process.env.NO_COLOR;
delete process.env.TERM_PROGRAM;

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const tree = resolve(flag('--tree') ?? join(here, '..', '..', '..', '..', '..', '..'));
const fixturesDir = resolve(flag('--fixtures') ?? join(tree, 'native', 'core', 'fixtures'));
const checkPath = flag('--check');
const outPath = resolve(flag('--out') ?? join(here, '..', 'goldens', 'display.json'));

const SEARCH = [
  'src/runtime/shared',
  'src/runtime/shared/statusline',
  'src/ui',
  'src/session-runtime/services',
  'packages/protocol-client/src/rows',
];
async function load(file) {
  for (const dir of SEARCH) {
    const path = join(tree, dir, file);
    if (existsSync(path)) return import(pathToFileURL(path).href);
  }
  throw new Error(`${file} is in none of ${SEARCH.join(', ')} of ${tree}`);
}
const time = await load('time-format.mjs');
const modelDisplay = await load('model-display.mjs');
const modelAlias = await load('model-alias.mjs');
const providerName = await load('provider-display-name.mjs');
const measurement = await load('context-measurement.mjs');
const inspection = await load('context-inspection.mjs');
const quiet = await load('quiet-progress.mjs');
const mentions = await load('skill-mentions.mjs');
const cleanModule = await load('clean.mjs');
const format = await load('statusline-format.mjs');
const stats = await load('session-stats.mjs');
const toolCard = await load('tool-card.mjs');
const usage = await load('usage-dashboard-model.mjs');

// A number JSON cannot carry travels as { num: 'NaN' | 'Infinity' | '-Infinity' | '-0' }.
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'num') return Number(value.num);
    return Object.fromEntries(keys.map((key) => [key, decode(value[key])]));
  }
  return value;
}
const NAN = { num: 'NaN' };
const INF = { num: 'Infinity' };

const cases = [];
function record(fn, args, call) {
  const entry = { fn, args };
  try {
    const out = call(...decode(args));
    if (out !== undefined) entry.out = normalise(out);
  } catch {
    entry.threw = true;
  }
  cases.push(entry);
}
function normalise(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) return { num: String(item) };
      return item;
    })
  );
}

// ---- time -------------------------------------------------------------------------------------
const MS = [0, 1, 999, 1000, 1500, 59_999, 60_000, 61_000, 119_000, 3_599_000, 3_600_000, 3_723_000, 7_200_000, 86_399_000, 86_400_000, 98_400_000, 90_061_000, 1e12, -5, 0.5, NAN, INF];
const DURATION_OPTIONS = [undefined, {}, { mostSignificantOnly: true }, { hideTrailingZeros: true }, { mostSignificantOnly: true, hideTrailingZeros: true }];
for (const ms of MS) {
  for (const options of DURATION_OPTIONS) record('formatDuration', options === undefined ? [ms] : [ms, options], time.formatDuration);
  record('formatElapsed', [ms], time.formatElapsed);
}
const INSTANTS = [0, 1, 1_700_000_000_000, 1_794_735_123_456, 1_719_792_000_000, 1_731_196_800_000, 951_782_400_000, 4_102_444_800_000, NAN, INF];
const ZONES = ['UTC', 'Asia/Seoul', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Sydney', 'Pacific/Auckland', 'America/Los_Angeles', 'Not/AZone'];
for (const ms of INSTANTS) {
  record('formatUtcTimestamp', [ms], time.formatUtcTimestamp);
  for (const timeZone of ZONES) {
    record('localTimestampParts', [ms, { timeZone }], time.localTimestampParts);
    record('formatLocalAndUtcTimestamp', [ms, { timeZone }], time.formatLocalAndUtcTimestamp);
    record('formatRecallTimestamp', [ms, { timeZone }], time.formatRecallTimestamp);
  }
}

// ---- model names, aliases, providers ---------------------------------------------------------
const modelFacts = new Map();
function walkModels(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walkModels);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'models' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [id, model] of Object.entries(value)) modelFacts.set(id, typeof model?.name === 'string' ? model.name : '');
    }
    if (key === 'modelOverrides' && value && typeof value === 'object') {
      for (const [id, model] of Object.entries(value)) modelFacts.set(id, typeof model?.name === 'string' ? model.name : '');
    }
    walkModels(value);
  }
}
const catalogPath = join(fixturesDir, 'model-lists-statusline', 'node-model-lists.json');
if (existsSync(catalogPath)) walkModels(JSON.parse(readFileSync(catalogPath, 'utf8')));
const SYNTHETIC_IDS = [
  'gpt-5',
  'gpt-5.1-codex-max',
  'gpt-4o-2024-08-06',
  'o3-mini',
  'o4',
  'codex-mini-latest',
  'deepseek-v4-pro',
  'grok-4-fast',
  'claude-3-5-sonnet-20241022',
  'claude-opus-4-7',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5',
  'claude-fable-5',
  'claude-mythos-5-preview',
  'gemini-2.5-pro',
  'gemini-3-flash-preview',
  'gemini-pro-latest',
  'kimi-k2.7-code',
  'qwen3.8-max',
  'mimo-v2.5-pro',
  'muse-spark-1.3-contributor',
  'hy3-preview',
  'glm-5.3-flash',
  'minimax-m3',
  'longcat-flash-chat',
  'vendor/some-model',
  'a/b/c-model',
  'vendor/',
  '',
  '  spaced-id  ',
  'UPPER-CASE-ID',
  'unknown',
];
for (const id of SYNTHETIC_IDS) if (!modelFacts.has(id)) modelFacts.set(id, '');
for (const [id, name] of modelFacts) {
  for (const hint of new Set(['', name, 'Custom Alias'])) {
    record('displayModelName', [id, 'p', hint], modelDisplay.displayModelName);
    for (const cols of [40, 79, 80, 119, 120, 200]) {
      record('shortenModelName', [modelDisplay.displayModelName(id, 'p', hint), cols], modelDisplay.shortenModelName);
    }
  }
  record('canonicalModelDisplay', [id], modelDisplay.canonicalModelDisplay);
  record('gatewayBrandDisplay', [id], modelDisplay.gatewayBrandDisplay);
  record('isRollingModelAlias', [id], modelAlias.isRollingModelAlias);
}
for (const name of ['', 'model', 'Claude Opus 4.7 (1M context)', 'Claude  Sonnet', 'OpenAI GPT-5', 'claude lower', 'a very long display name of a model that goes past the width', '\u{e9}'.repeat(30)]) {
  for (const cols of [40, 80, 120, 200]) record('shortenModelName', [name, cols], modelDisplay.shortenModelName);
}
for (const part of ['', ' ', 'gpt', 'API', 'v4', 'sOnNeT', 'k2.7', 'é']) record('titleModelPart', [part], modelDisplay.titleModelPart);
for (const value of ['', ' ', 'xhigh', 'XHIGH', ' xHigh ', 'high', 'medium', 'low', 'minimal', 'very_high-ish', 'a b', null, 5]) {
  record('effortDisplayLabel', [value], modelDisplay.effortDisplayLabel);
}
for (const id of ['openai-oauth', 'anthropic-oauth', 'OpenAI', 'openai-api', 'XAI', 'mixdog-local', 'default', 'custom-aaaa', '', null, 'Some-New']) {
  record('providerDisplayName', [id], providerName.providerDisplayName);
}
const VALUES = ['', '  a  b  ', 'tab\tand\nnewline', '\u{a0}nbsp\u{2003}', null, 0, 12, false, true, ['a', ' b '], { a: 1 }];
for (const value of VALUES) {
  record('clean', [value], cleanModule.clean);
  record('cleanString', [value], cleanModule.cleanString);
  record('oneLine', [value], cleanModule.oneLine);
}

// ---- context ---------------------------------------------------------------------------------
const SESSIONS = [];
for (const lastContextTokens of [undefined, null, 0, -1, 1200, '300', 'x', 1e9]) {
  for (const updated of [undefined, 0, 50]) {
    for (const compaction of [undefined, { lastChangedAt: 49 }, { lastCompactAt: 50 }, { lastChangedAt: 10, lastCompactAt: 60 }]) {
      const session = { provider: 'p', model: 'm' };
      if (lastContextTokens !== undefined) session.lastContextTokens = lastContextTokens;
      if (updated !== undefined) session.lastContextTokensUpdatedAt = updated;
      if (compaction) session.compaction = compaction;
      SESSIONS.push(session);
    }
  }
}
for (const extra of [
  { contextPressureBaselineSource: 'checkpoint_post_compact' },
  { contextPressureBaselineProvider: 'q' },
  { contextPressureBaselineProvider: 'p' },
  { contextPressureBaselineModel: 'other' },
  { contextPressureBaselineModel: 'm' },
  { lastContextTokensStaleAfterCompact: true },
  { lastContextTokensStaleAfterCompact: false },
]) {
  SESSIONS.push({ provider: 'p', model: 'm', lastContextTokens: 1200, lastContextTokensUpdatedAt: 50, ...extra });
}
SESSIONS.push(null, {}, 'text');
for (const session of SESSIONS) {
  for (const active of [true, false]) record('sessionContextMeasurement', [session, active], measurement.sessionContextMeasurement);
}
const CONTEXTS = [
  undefined,
  null,
  {},
  { lastApiRequestTokens: 9 },
  { lastApiRequestTokens: 0 },
  { lastApiRequestTokens: 9, lastApiRequestStale: true },
  { measurement: { tokens: 5, source: 'last_api_request', updatedAt: 7 } },
  { measurement: { tokens: 5, source: 'last_api_request' } },
  { measurement: { tokens: null, source: 'unavailable', updatedAt: 3 } },
  { measurement: { tokens: 5, source: 'pending' } },
  { measurement: { tokens: 'x', source: 'last_api_request' } },
  { measurement: { tokens: 0, source: 'last_api_request' } },
  { measurement: { source: 'last_api_request' } },
  { measurement: {} },
];
for (const context of CONTEXTS) record('contextMeasurementStats', [context], measurement.contextMeasurementStats);
for (const tokens of [null, 0, 1, 33, 50, 250, 1e6, -4, NAN, '12']) {
  for (const limit of [0, -1, 1, 3, 200, 1000, 1e6, NAN, null]) record('contextPercent', [tokens, limit], measurement.contextPercent);
}
const STATS = [
  undefined,
  {},
  { currentContextTokens: 250, currentContextSource: 'last_api_request' },
  { currentContextTokens: 250 },
  { currentContextTokens: 250, currentContextSource: 'estimate' },
  { currentContextTokens: 0, currentContextSource: 'last_api_request' },
  { currentContextTokens: null },
  { currentContextTokens: 'x' },
  { currentContextTokens: 250, currentContextSource: 'unavailable', currentContextUpdatedAt: 9 },
  { currentContextTokens: 250, currentContextSource: 'last_api_request', currentContextUpdatedAt: 4 },
];
for (const stat of STATS) {
  for (const windows of [{}, { contextWindow: 1000 }, { displayContextWindow: 500 }, { rawContextWindow: 400 }, { contextWindow: 0, displayContextWindow: 500 }, { contextWindow: 'x' }, { contextWindow: -5 }]) {
    record('measuredContextUsage', [{ ...windows, ...(stat === undefined ? {} : { stats: stat }) }], measurement.measuredContextUsage);
  }
}
record('measuredContextUsage', [{}], measurement.measuredContextUsage);
record('measuredContextUsage', [{ stats: 'x', contextWindow: 10 }], measurement.measuredContextUsage);
for (const source of ['last_api_request', 'unavailable', 'pending', '', 'x', null]) record('contextMeasurementLabel', [source], measurement.contextMeasurementLabel);
record('contextCategories', [], () => inspection.CONTEXT_CATEGORIES);
for (const [weights, total] of [
  [[1, 1, 1], 10],
  [[1, 2], 3],
  [[0, 0], 5],
  [[], 5],
  [[7, 11, 13, 17], 128],
  [[1, 1, 1, 1, 1, 1, 1], 128],
  [[5], 128],
  [[0, 3, 0], 4],
  [[2.5, 2.5, 5], 7],
  [[1e9, 3, 7], 128],
]) {
  record('contextShares', [weights, total], inspection.contextShares);
}
for (const [categories, options] of [
  [[{ key: 'user', tokens: 25 }, { key: 'assistant', tokens: 25 }], { windowTokens: 100, cells: 4 }],
  [[{ key: 'user', tokens: 30 }, { key: 'tools', tokens: 10 }], { windowTokens: 100, cells: 4, fit: true }],
  [[{ key: 'user', tokens: 150 }], { windowTokens: 100, cells: 2 }],
  [[], undefined],
  [[], { windowTokens: 1000 }],
  [[{ key: 'system', tokens: 12_000 }, { key: 'user', tokens: 3000 }, { key: 'toolResults', tokens: 40_000 }, { key: 'tools', tokens: 9000 }], { windowTokens: 200_000 }],
  [[{ key: 'system', tokens: 12_000 }, { key: 'user', tokens: 3000 }, { key: 'toolResults', tokens: 40_000 }, { key: 'tools', tokens: 9000 }], { windowTokens: 200_000, cells: 40, fit: true }],
  [[{ key: 'a', tokens: 1 }, { key: 'b', tokens: 1 }, { key: 'c', tokens: 1 }], { windowTokens: 0, cells: 10 }],
  [[{ key: 'a', tokens: 0 }], { windowTokens: 0, cells: 10 }],
]) {
  record('buildContextMap', options === undefined ? [categories] : [categories, options], inspection.buildContextMap);
}

// ---- quiet progress --------------------------------------------------------------------------
const LIVENESS = [
  undefined,
  null,
  'x',
  {},
  { lastProgressAt: 10, lastStreamDeltaAt: 30, toolStartedAt: 20, askStartedAt: 5 },
  { lastProgressAt: '10', askStartedAt: 'x' },
  { lastProgressAt: -5 },
  { stage: 'requesting', requestSentAt: 100, lastTransportAt: 50 },
  { stage: 'requesting', requestSentAt: 100, lastTransportAt: 100 },
  { stage: 'requesting', requestSentAt: 100 },
  { stage: 'requesting', requestSentAt: 0 },
  { stage: 'requesting' },
  { stage: 'streaming', requestSentAt: 100 },
  { stage: 4 },
  { stage: 'tool_running', toolStartedAt: 7 },
];
for (const liveness of LIVENESS) {
  record('lastProgressAt', [liveness], quiet.lastProgressAt);
  record('awaitingModelResponse', [liveness], quiet.awaitingModelResponse);
  record('displayProgressStage', [liveness], quiet.displayProgressStage);
}
for (const stage of ['connecting', 'requesting', 'model_thinking', 'streaming', 'tool_running', 'resource_wait', 'cancelling', 'idle', '', null]) {
  record('quietWaitKind', [stage], quiet.quietWaitKind);
}
for (const progressAt of [0, 1000, 'x', null, NAN, 5.5]) {
  for (const stage of ['streaming', 'tool_running', 'requesting', 'unknown']) {
    for (const tool of [null, 'shell', '']) {
      for (const now of [1000, 120_999, 121_000, 500_000]) {
        record('quietProgress', [{ progressAt, stage, tool, now }], quiet.quietProgress);
      }
    }
  }
}
for (const q of [undefined, null, {}, { since: 1000, wait: 'tool', tool: 'shell' }, { since: 1000, wait: 'provider' }, { since: 'x' }, { since: 1000, wait: 5, tool: 7 }]) {
  for (const now of [100_000, 121_000, 200_000, 1_000_000]) {
    for (const warnMs of [0, 150_000, 'x']) {
      record('quietProgressParts', [q, now, warnMs], quiet.quietProgressParts);
      record('quietProgressLabel', [quiet.quietProgressParts(q, now, warnMs)], quiet.quietProgressLabel);
    }
  }
}
record('quietProgressLabel', [null], quiet.quietProgressLabel);
for (const wait of ['tool', 'provider', 'thinking', 'model', 'slot', 'cancel', '', 'odd']) {
  record('quietProgressLabel', [{ wait, tool: wait === 'tool' ? 'shell' : '', minutes: 3 }], quiet.quietProgressLabel);
  record('quietProgressLabel', [{ wait, tool: '', minutes: 0 }], quiet.quietProgressLabel);
}

// ---- skill mentions --------------------------------------------------------------------------
const KNOWN = ['pptx', 'docx', 'a1', 'b2', 'x', 'a-b', 'path', 'home'];
const known = (name) => KNOWN.includes(name);
const TEXTS = [
  '',
  '$pptx',
  '$pptx now',
  'use $pptx and $docx',
  'twice $pptx $pptx $docx',
  '(see $a1) [$b2] {$x} "$a-b" \'$x\' `$a1`',
  'a$pptx',
  '$pptx_env $pptxUPPER $pptx. $pptx,',
  '$pptx\u{b85c} \u{d55c}\u{ae00} $docx',
  '$HOME $path $home $300 $tmp',
  `$${'a'.repeat(64)} $${'a'.repeat(65)}`,
  '$a1\n$b2\r\n$x',
  '`$pptx` and $docx',
  '``a $b2 ` c`` $x',
  '```\n$fenced\n```\n$after',
  '```js\n$fenced\n``` \n$after $pptx',
  '~~~sh\n$tilde\n~~~\n$next',
  '```\n$unclosed',
  '`unmatched $x',
  '````\n```\n$inner\n```\n````\n$out',
  '   ```\n$indented\n   ```\n$ok',
  '    ```\n$four-spaces\n```\n$ok2',
  '```a`b\n$not-a-fence',
  '~~~a`b\n$tilde-info\n~~~\n$z',
  '``` \n$spaced-close\n```   \n$after',
  '\u{1f600} $pptx \u{1f600}$docx',
  '\u{2028}$pptx\u{a0}$docx\u{feff}$x',
  '$',
  '$$pptx',
  '$-a',
  '$a-',
  'a\n```\n```\n$x',
  '``` \u{2028}x\n$after-weird',
];
for (const text of TEXTS) {
  record('skillMentionCandidates', [text], mentions.skillMentionCandidates);
  record('mentionedSkillNames', [text, KNOWN], (value, names) => mentions.mentionedSkillNames(value, (name) => names.includes(name)));
  record('skillMentions', [text, KNOWN], (value, names) => mentions.skillMentions(value, (name) => names.includes(name)));
  for (let offset = -1; offset <= Math.min(text.length + 1, 60); offset += 1) {
    record('isInMarkdownCode', [text, offset], mentions.isInMarkdownCode);
  }
}
record('isInMarkdownCode', ['`a`', 1.5], mentions.isInMarkdownCode);
record('isInMarkdownCode', ['`a`', null], mentions.isInMarkdownCode);
for (const name of ['path', 'PATH', 'Home', '300', '0042', 'pptx', '', 'xdg_config_home', 'a1', null]) {
  record('isReservedMentionName', [name], mentions.isReservedMentionName);
}

// ---- statusline format -----------------------------------------------------------------------
const PCTS = [null, 0, 0.04, 0.5, 1, 1.5, 33.33, 50, 69.9, 70, 89.99, 90, 99.95, 100, 250, -3, NAN, INF];
for (const pct of PCTS) {
  record('contextPctDisplayLabel', [pct], format.contextPctDisplayLabel);
  if (pct !== null) record('colourPct', [pct], format.colourPct);
  for (const cols of [40, 79, 80, 120, 200]) {
    for (const source of ['pending', 'unavailable', 'last_api_request', 'other']) {
      record('formatContextSegment', [pct, cols, source], format.formatContextSegment);
    }
  }
}
record('formatContextSegment', [50, 100], format.formatContextSegment);
record('formatContextSegment', ['40', 100], format.formatContextSegment);
for (const n of [0, 1, 999, 999.4, 999.5, 1000, 1234, 1500, 12_345, 999_499, 999_500, 999_999, 1_000_000, 1_234_567, 25_000_000, -5, NAN, null, '2500', 'x']) {
  record('fmt', [n], format.fmt);
  record('num', [n], format.num);
}
for (const v of [5, -5, 0, 1.5, '1970-01-01T00:00:01.000Z', '2026-11-15T09:30:00Z', '2026-11-15', 'junk', '', null, NAN]) record('timeMs', [v], format.timeMs);
record('statusPalette', [], () => ({
  R: format.R,
  B: format.B,
  D: format.D,
  GRN: format.GRN,
  YLW: format.YLW,
  RED: format.RED,
  text: format.statusText('x'),
  subtle: format.statusSubtle('x'),
}));

// ---- session stats ---------------------------------------------------------------------------
const DELTAS = [
  [],
  [{ deltaInput: 10, deltaOutput: 4, deltaCachedRead: 3, deltaCacheWrite: 2, deltaPrompt: 15, costUsd: 0.5 }],
  [{ deltaInput: 10, deltaOutput: 4 }, { deltaInput: 5, costUsd: 0.25 }, { deltaOutput: 1 }],
  [{ deltaInput: '12', deltaOutput: 'x', deltaCachedRead: null, costUsd: -1 }],
  [{ deltaInput: 1 }, null, { deltaInput: 2 }],
  [{ deltaInput: 1 }, {}, 0, '', { deltaPrompt: 7 }],
  [{ deltaInput: 1e15, costUsd: 0.1 }, { costUsd: 0.2 }, { costUsd: 0.3 }],
];
for (const deltas of DELTAS) {
  record('sessionStats', [deltas], (list) => {
    const state = stats.createSessionStats();
    for (const delta of list) stats.applyUsageDelta(state, delta);
    return state;
  });
}
record('createSessionStats', [], stats.createSessionStats);

// ---- tool card -------------------------------------------------------------------------------
const CALLS = [
  { name: 'read', arguments: { path: 'src/a.rs' } },
  { name: 'read', arguments: { file: 'b.rs' } },
  { name: 'read', arguments: { path: null, file: 'c.rs' } },
  { name: 'read', arguments: { n: 'hi' } },
  { name: 'read', arguments: { path: '' } },
  { name: 'read', arguments: { path: 5 } },
  { name: 'read', arguments: { path: ['a', 'b'] } },
  { name: 'read', arguments: { path: { x: 1 } } },
  { name: 'shell', arguments: { command: 'git  status\n-s' } },
  { name: 'shell', arguments: { command: 'x'.repeat(100) } },
  { name: 'shell', arguments: { command: 'y'.repeat(72) } },
  { name: 'shell', arguments: { command: 'z'.repeat(73) } },
  { name: 'shell', arguments: { command: '\u{d55c}'.repeat(80) } },
  { name: 'grep', arguments: { pattern: ['a', 'b'] } },
  { name: 'grep', arguments: { pattern: ['a', null, 'b', 3] } },
  { name: 'grep', arguments: { pattern: 'one' } },
  { name: 'grep', arguments: {} },
  { name: 'glob', arguments: { pattern: ['*.rs'], path: 'x' } },
  { name: 'glob', arguments: { path: 'x' } },
  { name: 'glob', arguments: { pattern: [], path: 'x' } },
  { name: 'list', arguments: { pattern: '*.md' } },
  { name: 'list', arguments: { path: 'p', pattern: '*.md' } },
  { name: 'find', arguments: { fuzzy: 'foo', path: 'x' } },
  { name: 'find', arguments: { query: 'q', fuzzy: 'foo' } },
  { name: 'apply_patch', arguments: { base_path: 'root' } },
  { name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** Update File: src/x.rs  \n@@\n*** End Patch' } },
  { name: 'apply_patch', arguments: { patch: '*** Add File: n.txt' } },
  { name: 'apply_patch', arguments: { patch: '*** Delete File:\n  later.txt' } },
  { name: 'apply_patch', arguments: { patch: 'none' } },
  { name: 'apply_patch', arguments: { patch: 5 } },
  { name: 'other', arguments: { n: 3, blank: '  ', q: 'hi' } },
  { name: 'other', arguments: { n: 3 } },
  { name: 'other', arguments: { b: 'second', a: 'first', 2: 'two', 1: 'one' } },
  { name: 'other', arguments: '{"path":"p","cmd":"c"}' },
  { name: 'read', arguments: '{"path":"p"}' },
  { name: 'read', arguments: 'null' },
  { name: 'read', arguments: '7' },
  { name: 'read', arguments: '"text"' },
  { name: 'other', arguments: 'not json' },
  { name: 'other', arguments: '' },
  { name: 'other', arguments: ['x', 'y'] },
  { name: 'other', arguments: [1, 'y'] },
  { name: 'read', arguments: 7 },
  { name: 'read', arguments: null },
  { name: 'read' },
  {},
  { name: null },
  { name: 5, arguments: { q: 'x' } },
  { name: 'mcp__github__search', arguments: { q: 'x' } },
  { name: 'mcp__github__search__deep', arguments: { q: 'x' } },
  { name: 'mcp__plugin_mixdog_mixdog__recall', arguments: { q: 'x' } },
  { name: 'functions.read', arguments: { path: 'p' } },
  { name: 'mcp__', arguments: {} },
];
for (const call of CALLS) record('renderToolCard', [call], toolCard.renderToolCard);

// ---- usage numbers ---------------------------------------------------------------------------
const NUMBERS = [
  0, -0, 1, 1.5, 9.99, 9.995, 10, 12.4, 99.5, 999, 999.5, 1000, 1234.5, 9999, 9999.5, 10_000, 12_345, 99_999, 999_999, 1_000_000, 1_500_000, 9_999_999,
  10_000_000, 25_000_000, 1e12, 0.001, 0.00421, 0.005, 0.00999, 0.01, 0.015, 0.1234, 0.5, 0.25, 0.125, -5, -0.001, -1500, -25_000_000, 2.5, 3.5,
  '2.5', '', ' ', 'abc', null, true, NAN, INF, { num: '-Infinity' },
];
for (const n of NUMBERS) {
  record('money', [n], usage.money);
  record('compactNumber', [n], usage.compactNumber);
}

const golden = {
  meta: { recorder: 'tests/recorders/record-display.mjs', cases: cases.length },
  cases,
};
const text = `${JSON.stringify(golden, null, 1)}\n`;
if (checkPath) {
  const recorded = readFileSync(resolve(checkPath), 'utf8').replace(/\r\n/g, '\n');
  if (recorded !== text) {
    console.error(`${checkPath} is not what the Node code gives over these inputs`);
    process.exit(1);
  }
  console.log(`${checkPath}: ${cases.length} cases match`);
} else {
  writeFileSync(outPath, text);
  console.log(`${outPath}: ${cases.length} cases`);
}
