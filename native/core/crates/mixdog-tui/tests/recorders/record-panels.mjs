// Records what the Node panel controllers do, so the Rust port (`mixdog_tui::panels`) is checked against it
// (tests/panels.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-panels.mjs --tree C:/Project/mixdog --write tests/goldens/panels.json
//   node record-panels.mjs --tree C:/Project/mixdog --check tests/goldens/panels.json
//
// Recorded:
//  * contextModel - buildContextPanelModel over a seeded corpus of status answers: the shapes of the test file, then random
//                   ones whose members are numbers, strings, booleans, null, containers or absent (the JavaScript coercions of
//                   `Number(x || 0)`, `a || b || c` and `fmt`/`pct` are the point), rows and detail as JSON;
//  * contextOpen  - createUsageContextPanels().openContextPicker over a recording surface: the prompts, paints and the panel
//                   it opens, with the reads answered, failing, missing, or the claim lost while they were pending;
//  * usage        - openUsagePanel over a recording surface and a store whose dashboard answers are scripted: the paints of
//                   the usage claim, the arguments of the store call, the notices and the closes, for an argument corpus and
//                   for a newer /usage that invalidates the first;
//  * btw          - createBtwController under scripted steps (ask, flush, resolve, reject, close, session change, sync,
//                   dispose): the panel after each step and the store calls it made.
//
// The store's answers are promises in Node and plain results in Rust; every scenario step that lets a promise settle is
// followed by a flush, so the events of a step settle in the order the Rust code makes them.
//
// The packages a TypeScript-era checkout installs (react, string-width, strip-ansi, marked, chalk, wrap-ansi) are only used by
// the rendering the controllers never reach; where a tree has no node_modules they are replaced by inert stand-ins.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { setImmediate as flush, setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-panels.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

const STUBS = {
  react:
    'export const useState=()=>[],useEffect=()=>{},useRef=()=>({}),useCallback=f=>f,useMemo=f=>f(),useLayoutEffect=()=>{},useContext=()=>({}),createContext=()=>({}),createElement=()=>null,memo=f=>f,forwardRef=f=>f,Fragment=null;export default {};',
  'string-width': 'export default s=>[...String(s)].length;',
  'strip-ansi': 'export default s=>String(s);',
  marked: 'export const marked={lexer:()=>[],setOptions(){},use(){}};',
  chalk:
    'const p=()=>new Proxy(function(s){return String(s)},{get:(t,k)=>k==="level"?0:p(),apply:(t,th,a)=>String(a[0])});export class Chalk{constructor(){return p()}};export default p();',
  'wrap-ansi': 'export default s=>String(s);',
};
const hooks = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && STUBS[spec]) return { url: 'stub:' + spec, shortCircuit: true };
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.startsWith('stub:')) return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true };
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const sources = [];
const load = async (path) => {
  const file = join(tree, 'src/tui', path);
  // Hashed with LF line endings: a checkout that converts them records the same digest.
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  sources.push({ path: `src/tui/${path}`, sha256: createHash('sha256').update(text).digest('hex') });
  return import(pathToFileURL(file).href);
};

const modelMod = await load('app/usage-context-panels/context-model.mjs');
const panelsMod = await load('app/usage-context-panels.mjs');
const btwMod = await load('app/btw-controller.mjs');

// What JSON.stringify keeps of a value (the Rust side compares parsed JSON).
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------- context model

const testStatus = {
  measurement: { tokens: 50_000, source: 'last_api_request', updatedAt: 1234 },
  effectiveContextWindow: 180_000,
  rawContextWindow: 200_000,
  usage: {
    lastContextTokens: 50_000,
    lastInputTokens: 48_000,
    lastCachedReadTokens: 40_000,
    lastCacheWriteTokens: 2_000,
    lastOutputTokens: 900,
  },
  messages: {
    estimatedTokens: 30_000,
    count: 14,
    toolCallCount: 3,
    toolCallTokens: 1_200,
    toolResultCount: 3,
    toolResultTokens: 9_500,
    semantic: { kinds: 2 },
  },
  request: {
    toolSchemaBreakdown: { code: { tokens: 4_000 }, web: { tokens: 1_000 }, mcp: { tokens: 2_500 } },
    requestOverheadTokens: 800,
    reserveTokens: 16_000,
  },
  compaction: {
    lastStage: 'compacted',
    lastChanged: true,
    lastTrigger: 'reactive',
    lastDurationMs: 4200,
    boundaryTokens: 150_000,
    triggerTokens: 140_000,
    pressureTokens: 60_000,
    reserveTokens: 20_000,
  },
  inspection: { entries: [] },
};
const testTools = { activeCount: 12, count: 20, mcpToolCount: 5, activeMcpToolCount: 3, activeTools: [] };
const testMcp = { connectedCount: 1, configuredCount: 2, failedCount: 1 };

const fixed = [
  {
    toolsStatus: testTools,
    mcpStatus: testMcp,
    skillsStatus: { count: 7 },
    pluginsStatus: { count: 2 },
    contextStatus: testStatus,
    sessionUsage: { outputTokensPerSecond: 41.5 },
    state: { contextWindow: 200_000, rawContextWindow: 250_000 },
  },
  { contextStatus: { contextWindow: 100_000, compaction: { lastStage: 'compacting', lastDurationMs: 4200 } }, state: {} },
  { contextStatus: { contextWindow: 100_000, compaction: { inProgress: true, lastDurationMs: 4200 } }, state: {} },
  {
    contextStatus: { contextWindow: 100_000, compaction: { lastStage: 'pre_send', lastChanged: true, lastDurationMs: 4200 } },
    state: {},
  },
  { contextStatus: { contextWindow: 100_000, compaction: { lastStage: 'pre_send_check', lastDurationMs: 4200 } }, state: {} },
  { state: { contextWindow: 100_000 } },
  { state: {} },
  {
    contextStatus: { contextWindow: 100_000, compaction: { lastStage: 'auto_clear_failed', lastClearCompactError: 'boom' } },
    state: {},
  },
  { contextStatus: { contextWindow: 100_000, compaction: { lastStage: 'auto_clear', lastClearAt: 5 } }, state: {} },
  { contextStatus: { contextWindow: 100_000, compaction: { lastStage: 'interrupted' } }, state: {} },
  { contextStatus: { contextWindow: 100_000, compaction: { bufferTokens: 5 } }, state: {} },
  { contextStatus: { contextWindow: 100_000, compaction: { bufferTokens: -5 } }, state: {} },
  { contextStatus: { contextWindow: 100_000, compaction: { bufferTokens: null } }, state: {} },
  { contextStatus: { lastApiRequestTokens: 1234, lastApiRequestStale: false, contextWindow: 8000 }, state: {} },
  { contextStatus: { lastApiRequestTokens: 1234, lastApiRequestStale: true, contextWindow: 8000 }, state: {} },
  { contextStatus: { measurement: { tokens: 10, source: 'unavailable' }, contextWindow: 8000 }, state: {} },
];

// A small seeded generator, so the corpus is the same every time it is recorded.
let seed = 0x2f6e2b1;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const pick = (list) => list[Math.floor(next() * list.length)];
const numbers = [0, 1, 7, 99, 999, 1000, 1049, 1050, 1999, 9999, 10_000, 10_499, 10_500, 123_456, 999_999, 1_000_000, 1_250_000, 1e9, 0.4, 0.5, 2.5, -3, 3.7, 4096, 65_536, 200_000, 1e21];
const odd = ['12', 'abc', '', ' 7 ', '0x10', true, false, null, [], {}, [5], { a: 1 }];
const num = () => (next() < 0.78 ? pick(numbers) : pick(odd));
// A member that may be left out.
const maybe = (make, odds = 0.8) => (next() < odds ? make() : undefined);
const strip = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

const randomStatus = () => {
  const stage = pick([undefined, 'pending', 'compacted', 'compacting', 'auto_clear', 'auto_clear_failed', 'interrupted', 'pre_send', 7, '']);
  return strip({
    measurement: maybe(() =>
      strip({
        tokens: maybe(num),
        source: pick(['last_api_request', 'pending', 'unavailable', 'x', undefined]),
        updatedAt: maybe(() => pick([0, 5, 1234, 'x'])),
      }), 0.5),
    lastApiRequestTokens: maybe(num, 0.3),
    lastApiRequestStale: maybe(() => pick([true, false, 1, 0, 'yes']), 0.3),
    effectiveContextWindow: maybe(num, 0.4),
    contextWindow: maybe(num, 0.5),
    rawContextWindow: maybe(num, 0.5),
    usage: maybe(() =>
      strip({
        lastContextTokens: maybe(num),
        lastInputTokens: maybe(num),
        lastCachedReadTokens: maybe(num),
        lastCacheWriteTokens: maybe(num),
        lastUncachedInputTokens: maybe(num, 0.4),
        lastOutputTokens: maybe(num),
      }), 0.85),
    messages: maybe(() =>
      strip({
        estimatedTokens: maybe(num),
        count: maybe(num),
        toolCallCount: maybe(num),
        toolCallTokens: maybe(num),
        toolResultCount: maybe(num),
        toolResultTokens: maybe(num),
        semantic: maybe(() => strip({ reasoning: maybe(() => strip({ tokens: maybe(num) })), kinds: maybe(num) }), 0.5),
      }), 0.85),
    request: maybe(() =>
      strip({
        toolSchemaBreakdown: maybe(() =>
          strip(Object.fromEntries(['code', 'web', 'mutation', 'channels', 'setup', 'other', 'mcp'].map((key) => [key, maybe(() => strip({ tokens: maybe(num) }), 0.5)]))), 0.8),
        requestOverheadTokens: maybe(num),
        reserveTokens: maybe(num),
      }), 0.85),
    compaction: maybe(() =>
      strip({
        inProgress: maybe(() => pick([true, false, 1]), 0.3),
        lastStage: stage,
        lastTrigger: maybe(() => pick(['reactive', 'REACTIVE', 'manual', '', 5]), 0.4),
        lastChanged: maybe(() => pick([true, false, 1, 'x']), 0.5),
        lastClearAt: maybe(() => pick([0, 5, 'x']), 0.2),
        lastClearCompactError: maybe(() => pick(['', 'boom', 12]), 0.2),
        lastDurationMs: maybe(num, 0.6),
        boundaryTokens: maybe(num, 0.5),
        triggerTokens: maybe(num, 0.5),
        bufferTokens: maybe(num, 0.3),
        pressureTokens: maybe(num, 0.5),
        lastPressureTokens: maybe(num, 0.3),
        currentEstimatedTokens: maybe(num, 0.3),
        reserveTokens: maybe(num, 0.5),
      }), 0.9),
    inspection: maybe(() => pick([{ entries: [] }, { revision: 3 }, 'x', 0]), 0.2),
  });
};
const randomStatusAnswer = () => pick([null, null, {}, strip({ count: maybe(num), activeCount: maybe(num), connectedCount: maybe(num), configuredCount: maybe(num), failedCount: maybe(num), mcpToolCount: maybe(num), activeMcpToolCount: maybe(num), count2: 1 }), 'x', 0]);

const random = Array.from({ length: 300 }, () =>
  strip({
    toolsStatus: maybe(randomStatusAnswer, 0.7),
    mcpStatus: maybe(randomStatusAnswer, 0.7),
    skillsStatus: maybe(randomStatusAnswer, 0.7),
    pluginsStatus: maybe(randomStatusAnswer, 0.7),
    contextStatus: maybe(() => (next() < 0.06 ? pick([null, 'x', 0]) : randomStatus()), 0.95),
    sessionUsage: maybe(() => pick([null, {}, { outputTokensPerSecond: pick([0, 12.5, null, '3']) }]), 0.5),
    state: strip({ contextWindow: maybe(num, 0.5), rawContextWindow: maybe(num, 0.5) }),
  })
);

const contextModel = [...fixed, ...random].map((input) => {
  const given = {
    toolsStatus: input.toolsStatus,
    mcpStatus: input.mcpStatus,
    skillsStatus: input.skillsStatus,
    pluginsStatus: input.pluginsStatus,
    contextStatus: input.contextStatus,
    sessionUsage: input.sessionUsage,
    state: input.state,
  };
  const { rows, detail } = modelMod.buildContextPanelModel(given);
  return { input: plain(given), rows: plain(rows), detail: plain(detail) };
});

// ---------------------------------------------------------------- recording surface

// Every effect the controllers have on their surroundings, in order, in the shape the Rust fake logs it.
function recordingSurface(log, { owns = () => true } = {}) {
  let usageGeneration = 0;
  return {
    claim: () => ({
      owns: () => owns(),
      paint: (value) => log.push(['picker', plain(value)]),
      context: (value) => log.push(['context', plain(value)]),
    }),
    claimUsage: () => {
      const mine = ++usageGeneration;
      return {
        owns: () => mine === usageGeneration,
        paint: (value) => log.push(['usage', plain(value)]),
      };
    },
    closeUsage: () => {
      usageGeneration += 1;
      log.push(['usage', null]);
    },
  };
}

const contextOpenCases = [
  { name: 'every read answers', stores: { toolsStatus: testTools, mcpStatus: testMcp, skillsStatus: { count: 7 }, pluginsStatus: { count: 2 }, contextStatus: testStatus, getSessionUsage: { outputTokensPerSecond: 12 } }, state: { contextWindow: 200_000, rawContextWindow: 250_000 } },
  { name: 'every read fails', stores: { toolsStatus: '!', mcpStatus: '!', skillsStatus: '!', pluginsStatus: '!', contextStatus: '!', getSessionUsage: '!' }, state: { contextWindow: 100_000 } },
  { name: 'the store has none of them', stores: {}, state: {} },
  { name: 'one read fails', stores: { toolsStatus: testTools, mcpStatus: '!', skillsStatus: { count: 1 }, pluginsStatus: { count: 0 }, contextStatus: testStatus }, state: { contextWindow: 90_000, rawContextWindow: 95_000 } },
  { name: 'the claim is lost during the reads', stores: { toolsStatus: testTools, contextStatus: testStatus }, state: {}, lose: true },
];

async function runContextOpen(spec) {
  const log = [];
  const calls = [];
  let lost = false;
  const surface = recordingSurface(log, { owns: () => !lost });
  const store = {};
  for (const [name, answer] of Object.entries(spec.stores)) {
    store[name] = async (options) => {
      calls.push([name, plain(options ?? null)]);
      if (answer === '!') throw new Error('daemon offline');
      return answer;
    };
  }
  const panels = panelsMod.createUsageContextPanels({
    store,
    state: spec.state,
    surface,
    setProviderPrompt: (value) => log.push(['prompt', 'provider', value]),
    setSettingsPrompt: (value) => log.push(['prompt', 'settings', value]),
    closeUsagePanel: () => {},
  });
  const opening = panels.openContextPicker();
  lost = Boolean(spec.lose);
  await opening;
  // The panel's own callbacks are not data: its rows and detail are.
  const events = log.map((event) => (event[0] === 'context' && event[1] ? ['context', { kind: event[1].kind, title: event[1].title, detail: event[1].detail, rows: event[1].rows }] : event));
  return { calls, log: plain(events) };
}

const contextOpen = [];
for (const spec of contextOpenCases) contextOpen.push({ name: spec.name, spec, ...(await runContextOpen(spec)) });

// ---------------------------------------------------------------- usage

const usageCases = [
  ...['', '--refresh', 'refresh', ' -r ', 'TRUE', 'true', 'Refresh', 'refreshx', 'x refresh y', 'norefresh', '-R', 'true1', '\trefresh\n', '--refresh=1', 'refresh,', 'a\u00a0-r\u00a0b', 'a\u2003true'].map((arg) => ({
    name: `argument ${JSON.stringify(arg)}`,
    arg,
    answer: { updates: [{ title: 'partial', rows: [1] }, null], final: { title: 'final', rows: [1, 2] } },
  })),
  { name: 'unavailable', arg: '', answer: { updates: [], final: null } },
  { name: 'failure', arg: '', answer: { updates: [{ title: 'partial' }], throws: 'quota api down' } },
  { name: 'failure without a message', arg: '', answer: { updates: [], throwsPlain: 'plain failure' } },
  { name: 'a store without the dashboard', arg: '', answer: null },
  { name: 'a newer usage supersedes the first', arg: '--refresh', answer: { updates: [{ title: 'late' }], final: { title: 'late final' } }, supersede: true },
];

async function runUsage(spec) {
  const log = [];
  const calls = [];
  const notices = [];
  const surface = recordingSurface(log);
  const store = {
    pushNotice: (text, level) => notices.push([text, level]),
  };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  if (spec.answer) {
    store.getUsageDashboard = async ({ refresh, onUpdate }) => {
      calls.push(['getUsageDashboard', { refresh }]);
      await gate;
      for (const update of spec.answer.updates) onUpdate(update);
      if (spec.answer.throws) throw new Error(spec.answer.throws);
      if (spec.answer.throwsPlain) throw spec.answer.throwsPlain;
      return spec.answer.final;
    };
  }
  const closes = [];
  const panels = panelsMod.createUsageContextPanels({
    store,
    state: {},
    surface,
    setProviderPrompt: (value) => log.push(['prompt', 'provider', value]),
    setSettingsPrompt: (value) => log.push(['prompt', 'settings', value]),
    closeUsagePanel: () => {
      closes.push(1);
      surface.closeUsage();
    },
  });
  panels.openUsagePanel(spec.arg);
  if (spec.supersede) {
    // The timer of the first open has not run: a second open takes the usage claim.
    panels.openUsagePanel('');
  }
  // The dashboard read starts from a zero-delay timer.
  await sleep(20);
  release();
  await sleep(20);
  return { calls: plain(calls), notices: plain(notices), closes: closes.length, log: plain(log) };
}

const usage = [];
for (const spec of usageCases) usage.push({ name: spec.name, spec, ...(await runUsage(spec)) });

// ---------------------------------------------------------------- btw

// Steps: ask <q>, flush, resolve <q> <text>, reject <q> <message|null|''> (null: a plain string, '': an empty one), close, session <id>, sync,
// dispose. `resolve` and `reject` flush first, so queued requests dispatch before the answer arrives.
const btwScripts = [
  { name: 'ask, dispatch, answer', steps: [['ask', 'why?'], ['flush'], ['resolve', 'why?', 'because']] },
  { name: 'answer without text', steps: [['ask', 'q'], ['flush'], ['resolve', 'q', null]] },
  { name: 'failure with a message', steps: [['ask', 'q'], ['flush'], ['reject', 'q', 'boom']] },
  { name: 'failure with an empty rejection', steps: [['ask', 'q'], ['flush'], ['reject', 'q', '']] },
  { name: 'failure with a plain string', steps: [['ask', 'q'], ['flush'], ['reject', 'q', null]] },
  { name: 'a second ask replaces the first before it is sent', steps: [['ask', 'one'], ['ask', 'two'], ['flush'], ['resolve', 'two', 'second']] },
  { name: 'a second ask cancels the first in flight', steps: [['ask', 'one'], ['flush'], ['ask', 'two'], ['flush'], ['resolve', 'one', 'late'], ['resolve', 'two', 'second']] },
  { name: 'close before the dispatch cancels nothing', steps: [['ask', 'one'], ['close'], ['flush']] },
  { name: 'close in flight cancels the side question', steps: [['ask', 'one'], ['flush'], ['close'], ['resolve', 'one', 'late']] },
  { name: 'close without a panel', steps: [['close'], ['close']] },
  { name: 'a session change before the dispatch drops the request', steps: [['ask', 'one'], ['session', 's2'], ['flush']] },
  { name: 'a session change and back before the dispatch', steps: [['ask', 'one'], ['session', 's2'], ['session', 's1'], ['flush'], ['resolve', 'one', 'text']] },
  { name: 'a session change in flight is cleared by sync and cancels for the origin', steps: [['ask', 'one'], ['flush'], ['session', 's2'], ['sync'], ['resolve', 'one', 'late']] },
  { name: 'an answer of another session is ignored', steps: [['ask', 'one'], ['flush'], ['session', 's2'], ['resolve', 'one', 'late'], ['sync']] },
  { name: 'sync in the same session keeps the panel', steps: [['ask', 'one'], ['flush'], ['sync'], ['resolve', 'one', 'x']] },
  { name: 'sync without a panel', steps: [['session', 's2'], ['sync']] },
  { name: 'dispose cancels in flight and keeps the panel', steps: [['ask', 'one'], ['flush'], ['dispose'], ['resolve', 'one', 'late']] },
  { name: 'dispose before the dispatch', steps: [['ask', 'one'], ['dispose'], ['flush']] },
  { name: 'an answer after the panel was answered once more', steps: [['ask', 'a'], ['flush'], ['resolve', 'a', 'A'], ['ask', 'b'], ['flush'], ['resolve', 'b', 'B'], ['close']] },
  { name: 'markdown answer', steps: [['ask', 'md'], ['flush'], ['resolve', 'md', '# title\n\n- one\n- two']] },
];

async function runBtw(script) {
  const out = [];
  let sessionId = 's1';
  const sideCalls = [];
  const deferred = [];
  let panel = null;
  const store = {
    askSide: (question) =>
      new Promise((resolve, reject) => {
        sideCalls.push(['askSide', question]);
        deferred.push({ question, resolve, reject });
      }),
    cancelSide: (id) => {
      sideCalls.push(['cancelSide', id]);
    },
  };
  const controller = btwMod.createBtwController({
    getStore: () => store,
    setPanel: (value) => {
      panel = value;
    },
    getSessionId: () => sessionId,
  });
  for (const step of script.steps) {
    const [op, a, b] = step;
    if (op === 'ask') controller.ask(a);
    else if (op === 'flush') await flush();
    else if (op === 'resolve' || op === 'reject') {
      await flush();
      const entry = [...deferred].reverse().find((item) => item.question === a);
      if (entry) {
        if (op === 'resolve') entry.resolve(b === null ? { text: null } : { text: b });
        else entry.reject(b === null ? 'plain failure' : b === '' ? '' : new Error(b));
      }
      await flush();
    } else if (op === 'close') controller.close();
    else if (op === 'session') sessionId = a;
    else if (op === 'sync') controller.sync();
    else if (op === 'dispose') controller.dispose();
    out.push({ step, panel: plain(panel), calls: plain(sideCalls.splice(0)) });
  }
  return out;
}

const btw = [];
for (const script of btwScripts) btw.push({ name: script.name, steps: script.steps, result: await runBtw(script) });

// ---------------------------------------------------------------- output

const out = { contextModel, contextOpen, usage, btw, sources };

const text = `{\n${Object.entries(out)
  .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  .join(',\n')}\n}\n`;
const target = option('--write') ?? option('--check');
if (option('--write')) {
  writeFileSync(target, text);
  console.log(`wrote ${target} (${text.length} bytes, ${contextModel.length} models, ${btw.length} btw scripts)`);
} else {
  const recorded = readFileSync(target, 'utf8');
  if (recorded.replace(/\r\n/g, '\n') !== text) {
    console.error(`${target} differs from what the Node code does now: re-record it with --write`);
    process.exit(1);
  }
  console.log(`${target} matches (${contextModel.length} models, ${btw.length} btw scripts)`);
}
