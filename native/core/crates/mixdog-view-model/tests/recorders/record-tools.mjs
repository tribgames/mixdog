// Records the Node golden for the Rust tool surface (mixdog-view-model: tool_surface, tool_work_units, tool_status,
// tool_contract). Every exported function of the Node modules runs over
//   (a) the calls and result texts found in the row-bearing fixtures of native/core/fixtures
//       (session-state stream.json, stale-rows-cases, trace-rows-cases, ladder-rows), and
//   (b) synthetic calls for every builtin tool name the Node tables know (typical, empty, malformed and oversized
//       arguments; every action word they branch on) and synthetic results (finished, failed, denied, interrupted),
// and the outputs are written beside their inputs; tests/tools_twin.rs replays the file in Rust.
//
//   node tests/recorders/record-tools.mjs [--tree <repo>] [--fixtures <dir>] [--out <file>]
//   node tests/recorders/record-tools.mjs [--tree <repo>] [--fixtures <dir>] --check <file>
//
// --tree is the Node product's tree (default: the repository this file sits in); --fixtures defaults to
// <tree>/native/core/fixtures. The modules are read from <tree>/src/runtime/shared, else from the copies in
// <tree>/packages/protocol-client/src/rows (the Node copies the TUI and the desktop import).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const tree = resolve(flag('--tree') ?? join(here, '..', '..', '..', '..', '..', '..'));
const fixturesDir = resolve(flag('--fixtures') ?? join(tree, 'native', 'core', 'fixtures'));
const checkPath = flag('--check');
const outPath = resolve(flag('--out') ?? join(here, '..', 'goldens', 'tools.json'));

async function load(file) {
  for (const dir of ['src/runtime/shared', 'packages/protocol-client/src/rows']) {
    const path = join(tree, dir, file);
    if (existsSync(path)) return import(pathToFileURL(path).href);
  }
  throw new Error(`${file} is in neither src/runtime/shared nor packages/protocol-client/src/rows of ${tree}`);
}
const surface = await load('tool-surface.mjs');
const units = await load('tool-work-units.mjs');
const status = await load('tool-status.mjs');
const contract = await load('tool-execution-contract.mjs');

// ── Inputs ──────────────────────────────────────────────────────────────────

// Every name the Node tables know: TOOL_CATEGORY, TOOL_UNITS, displayToolName, summarizeToolArgs and the hidden set,
// plus names no table has (they take the generic rules).
const NAMES = [
  'read', 'view_image', 'read_mcp_resource', 'grep', 'find', 'glob', 'list', 'ls', 'load_tool', 'tool_search',
  'web_search', 'search_query', 'image_query', 'web_search_call', 'web_fetch', 'fetch', 'recall', 'recall_memory',
  'search_memories', 'remember', 'save_memory', 'update_memory', 'memory', 'explore', 'apply_patch', 'edit', 'strreplace',
  'str_replace', 'str_replace_editor', 'search_replace', 'git', 'git_stage', 'github', 'bash', 'shell', 'shell_command',
  'bash_session', 'job_wait', 'task', 'agent', 'bridge', 'browser', 'browser_devtools', 'computer', 'terminal', 'office',
  'media', 'tidy', 'visualize', 'list_mcp_resources', 'list_mcp_resource_templates', 'cwd', 'session', 'setup', 'goal',
  'request_user_input', 'ask_user', 'handoff_user', 'update_plan', 'skill', 'skill_execute', 'skill_view', 'skills_list',
  'use_skill', 'code_graph', 'todo', 'react', 'create_goal', 'call_tool', 'Some-Odd_Tool', 'mystery',
  'functions.read', 'FUNCTIONS.bash', 'mcp__plugin_mixdog_mixdog__recall', 'mcp__plugin_mixdog_mixdog__shell',
  'mcp__github__create_issue', 'mcp__playwright__browser_click', 'mcp__a__b', 'mcp__x', 'mcp____', 'mcp__only__', '',
];
const ACTIONS = [
  '', 'list', 'read', 'status', 'wait', 'cancel', 'close', 'result', 'stage', 'worktree', 'create', 'send', 'delete',
  'rename', 'compact', 'fork', 'favorite', 'archive', 'set', 'set-project', 'list-projects', 'generate', 'install', 'fix',
  'scan', 'rules', 'results', 'snapshot', 'get', 'rollback', 'capture', 'export', 'annotate', 'check', 'inspect', 'act',
  'add', 'edit', 'open', 'install_model', 'search_models', 'remove_server', 'update_x', 'pr.merge', 'issue.create',
  'run.logs', 'run.cancel', 'issue.comments', 'pr.read', 'comment', 'nope', 'ISSUE.VIEW', 'prewarm', 'callers', 'overview',
  'finalize', 'transactions',
];
const RICH = {
  path: 'src/app/main.rs', paths: ['a/b.txt', 'c\\d.txt', ' '], file_path: '/x/y.z', file: 'f.txt', files: ['one', 'two'],
  dir: 'dd', cwd: 'C:\\Users\\t\\proj', offset: 10, limit: 20, pages: '1-3', head_limit: 7,
  pattern: 'fn main', glob: '*.rs', query: 'what is it', queries: ['q1', 'q2'], keywords: ['k'], fuzzy: 'fz', q: 'qq', text: 'hello',
  url: 'https://example.com/a', urls: ['https://a', 'https://b'], uri: 'file:///x', uris: ['u1'],
  command: 'ls -la\necho two\necho three', commands: ['a', 'b'], cmd: 'dir', description: 'list the files',
  name: 'nm', names: 'alpha, beta', select: ['mcp__s__t', 'skill:foo'], skill: 'sk', skill_name: 'skn',
  task_id: 'T-1', task_ids: ['T1', 'T2'], id: 5, ids: [1, 2], tag: 'tg', sessionId: 's-1', agents: [{ role: 'x' }, { role: 'y' }],
  role: 'worker', agent: 'heavy-worker', model: 'anthropic/claude-opus-4-1-20250805', modelDisplay: '',
  change_ids: ['c1', 'c2'], title: 'Title', repo: 'o/r', number: 12, workflow: 'ci', objective: 'ship it', value: false,
  kind: 'video', apply: true, engines: ['e1', 'e2'], session: 'sess', job: 'job-1', tab: 3, ref: 'e9', operation: 'clear',
  input: { url: 'https://u', ref: 'r', tab: 2, targets: ['t1', 't2'], tab2: 1 },
  questions: [{ header: 'H1', question: 'Q1' }, { question: 'Q2' }, null], server: { name: 'srv' }, topK: 4, mode: 'overview',
  symbols: ['S1'], symbol: 'S', files2: ['x'], patch: '*** Add File: a.txt\n+x\n*** Update File: b.txt\n@@\n*** Delete File: c.txt',
  old_string: 'a', new_string: 'b', base_path: 'p/q', dry_run: false, worktree_action: 'list', op: 'add', type: 'result',
  status: 'failed', domain: 'dom', modelId: 'm1', messages: ['m'], entries: [1, 2, 3], items: ['i'], summary: 'sm', key: 'ky',
};
const PATCHES = [
  '*** Add File: a.txt\n+x', '*** Update File: a\n*** Update File: b', 'diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n+1\ndiff --git a/y b/y\ndeleted file mode 100644\n--- a/y\n+++ /dev/null',
  '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-1\n+2', '--- /dev/null\n+++ b/f\n+1', 'diff --git a/q b/q\n--- a/q\n+++ b/q\n@@\n-x\n+y', 'not a patch', '',
  '*** update file: lower\n*** ADD FILE: upper',
];
const MALFORMED = [
  null, '', '   ', 'not json', '{"a":1}', '[1,2,3]', '[]', '{"input":{"path":"x"}}', '{"input":"str"}', '"just a string"', 7, 0, true, false,
  [], [1, 'two', null, { three: 3 }], {}, { input: null }, { input: [] }, { input: { input: { path: 'deep' } } },
  { a: 1, b: 'x', c: null, d: { e: 1 }, f: [1] }, { 0: 'zero', 1: 'one', z: 'last' }, { action: 5, path: 7, query: {}, limit: 'abc' },
  { action: ['list'], type: { x: 1 }, tag: [], pattern: [] }, '{"action":"wait","task_id":"x"}', '{"truncated":',
  { input: { action: 'click', url: 'u' }, action: 'open' }, { path: [], paths: [null, '', ' '], files: [null], query: [' '] },
  { limit: -3, messages: 'm' }, { limit: 'NaN', messages: ['a', 'b'] }, { limit: 1e30 }, { limit: '4.5' },
];

const big = (n) => 'x'.repeat(n);
const OVERSIZED_NAMES = ['read', 'grep', 'bash', 'web_search', 'apply_patch', 'agent', 'memory', 'recall', 'github', 'browser', 'tidy', 'mystery', 'load_tool', 'mcp__srv__do', 'code_graph', 'session'];
const oversized = (name) => {
  const text = big(6000);
  const list = Array.from({ length: 150 }, (_, i) => `item-${i}-${big(20)}`);
  return [
    { name, args: { path: text, pattern: text, query: text, command: `${text}\n${text}\n${text}`, action: big(300), patch: `${'*** Add File: f\n'.repeat(80)}`, title: text, tag: text } },
    { name, args: { paths: list, queries: list, files: list, commands: list, agents: list, change_ids: list, urls: list, id: list, query: list, engines: list, paths2: list } },
  ];
};

const calls = [];
const seen = new Set();
const addCall = (call) => {
  const key = JSON.stringify(call);
  if (seen.has(key)) return;
  seen.add(key);
  calls.push(call);
};
// A small body for the action sweeps (the full RICH body rides along only a few times per name).
const SMALL = {
  path: 'src/a.rs', query: 'q', command: 'ls', task_id: 'T-1', id: 5, tag: 'tg', title: 'Title', repo: 'o/r', number: 12, agents: [{ role: 'x' }],
  value: false, status: 'failed', kind: 'video', apply: true, mode: 'overview',
};
const ACTION_NAMES = new Set([
  'task', 'agent', 'bridge', 'git', 'github', 'goal', 'setup', 'session', 'cwd', 'media', 'tidy', 'office', 'visualize', 'terminal', 'memory',
  'code_graph', 'browser', 'computer', 'mcp__github__create_issue', 'remember',
]);
const MALFORMED_NAMES = new Set([
  'read', 'grep', 'bash', 'web_search', 'apply_patch', 'agent', 'memory', 'recall', 'github', 'browser', 'tidy', 'mystery', 'load_tool', 'mcp__a__b',
  'code_graph', 'session', 'task', 'fetch', 'list',
]);
for (const name of NAMES) {
  addCall({ name, args: {} });
  addCall({ name, args: RICH });
  addCall({ name, args: JSON.stringify(RICH) });
  if (ACTION_NAMES.has(name)) {
    for (const action of ACTIONS) {
      addCall({ name, args: { ...SMALL, action, ...(action ? { type: action, op: action, worktree_action: action } : {}) } });
    }
  }
  if (MALFORMED_NAMES.has(name)) {
    for (const args of MALFORMED) addCall({ name, args });
    addCall({ name, args: JSON.stringify({ input: SMALL }) });
    addCall({ name, args: { input: { ...SMALL, action: 'list' }, action: 'wait' } });
    addCall({ name, args: { ...SMALL, dry_run: true } });
    addCall({ name, args: { ...SMALL, status: 'cancelled', type: 'result' } });
    addCall({ name, args: { ...SMALL, status: 'ok', type: 'result' } });
    addCall({ name, args: { ...SMALL, value: true, action: 'favorite' } });
    addCall({ name, args: { ...SMALL, apply: false, action: 'fix' } });
    addCall({ name, args: { ...SMALL, path: null, file_path: null, action: '', limit: 0 } });
  }
}
for (const patch of PATCHES) {
  for (const extra of [{}, { dry_run: true }, { old_string: '', new_string: 'x' }, { old_string: 'x', new_string: '' }, { path: 'a', file: 'b' }]) {
    addCall({ name: 'apply_patch', args: { patch, ...extra } });
  }
}
for (const name of OVERSIZED_NAMES) for (const call of oversized(name)) addCall(call);

// Calls and result texts of the row-bearing fixtures.
const FIXTURES = ['session-state/stream.json', 'stale-rows-cases/golden.json', 'trace-rows-cases/golden.json', 'ladder-rows/golden.json'];
const texts = new Set();
let fixtureCalls = 0;
for (const file of FIXTURES) {
  const path = join(fixturesDir, file);
  if (!existsSync(path)) throw new Error(`fixture ${path} is missing (pass --fixtures)`);
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (typeof value.name === 'string' && ('args' in value || 'input' in value || 'arguments' in value)) {
      const args = 'args' in value ? value.args : 'input' in value ? value.input : value.arguments;
      addCall({ name: value.name, args });
      fixtureCalls += 1;
    }
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === 'string' && /^(?:result|output|text|content|error|message|body|summary)$/i.test(key) && inner.length < 4000) texts.add(inner);
      walk(inner);
    }
  };
  walk(JSON.parse(readFileSync(path, 'utf8')));
}

const SYNTHETIC_TEXTS = [
  '', ' ', 'ok', 'done', 'Error: boom', 'error: x', 'cancelled', ' Canceled ', 'CANCELED', 'Interrupted by user', 'interrupted by process restart',
  'Tool execution aborted', '[tool execution was interrupted]', "The user doesn't want to proceed with this tool use. The tool use was rejected.",
  "the user doesn't want to proceed with this tool useful", 'Error: Browser command interrupted by local user input.', 'computer_session_aborted: stop',
  'Error: computer_user_control_active: busy', 'Browser command interrupted by local user input. more', '   computer_session_aborted:',
  '[status: completed]\nbody', '[status: failed]', '[STATUS: Timeout]\n', '[status: ]\nx', '[status:cancelled]', '[status: weird]', 'status: running · 3s',
  'State: done', 'status: cancel-unconfirmed', 'status: cancel pending', 'status: cancel_unconfirmed', 'status: denied', 'status: timed_out', 'status:ok',
  '<task-notification>\n<task-id>1</task-id>\n<status>completed</status>\n</task-notification>', '<status>failed</status>', '<status> killed </status>\nrest',
  '<task-id>x</task-id>\nstatus: failed', 'prose <status>done</status>', '<status></status>\nstatus: done', '<output-file>f</output-file>\n[status: done]',
  '[tool output offloaded: f.txt]\n\n[status: failed]\nbody', '[Tool output offloaded: f]\n\n\nstatus: done\n\nmore', '[tool output offloaded: f]',
  'header line\n\nstatus: failed\n', 'a\nb\n\nc\nstatus: done', 'exit 1\n[outcome: no-match]', '[outcome: no-change]\n', '[OUTCOME: conflicts]  ',
  '[outcome: failed]', 'x [outcome: no-match]', 'line1\r\nstatus: done\r\n\r\nrest', '\n\nstatus: done', 'status:\tdone', 'status: failed,x', 'status: done;y',
  'Error: status: failed', '[status: done] [status: failed]', 'Background task started\nstatus: running\n\nresult', big(5000), `[status: done]\n${big(5000)}`,
  'status: ✓ done', 'status: \u00a0done', '\u00a0[status: done]', '[tool output offloaded: a]\n   \n\t\nstatus: running',
];
for (const text of SYNTHETIC_TEXTS) texts.add(text);

// ── Outputs ─────────────────────────────────────────────────────────────────

const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
const guard = (fn) => {
  try {
    return plain(fn());
  } catch (error) {
    return { threw: String(error?.message ?? error) };
  }
};
const compact = (args) => JSON.stringify(args ?? null).length < 600;

function recordCall({ name, args }) {
  const jsonArgs = plain(args);
  const out = {
    category: guard(() => units.classifyToolCategory(name, args)),
    unit: guard(() => units.toolWorkUnit(name, args)),
    unitFor: name === 'mystery' || name === '' ? guard(() => units.toolWorkUnit(name, args, 'Browser')) : undefined,
    entries: guard(() => surface.aggregateToolCategoryEntries(name, args)),
    patchUnits: name === 'apply_patch' ? guard(() => units.patchMutationUnits(args)) : undefined,
    patchProfile: name === 'apply_patch' ? guard(() => [...units.patchOperationProfile(args)]) : undefined,
    summary: guard(() => surface.summarizeToolArgs(name, args)),
    summaryNarrow: guard(() => surface.summarizeToolArgs(name, args, { max: 12 })),
    label: guard(() => surface.formatToolSurface(name, args).label),
    normalizedName: guard(() => surface.formatToolSurface(name, args).normalizedName),
    parsedArgs: compact(args) ? guard(() => surface.formatToolSurface(name, args).args) : undefined,
    loading: guard(() => surface.toolLoadingTargets(name, args)),
    taskWait: guard(() => surface.isTaskWaitToolCall(name, args)),
    headers: guard(() => [
      surface.formatToolActionHeader(name, args),
      surface.formatToolActionHeader(name, args, { pending: true }),
      surface.formatToolActionHeader(name, args, { failed: true }),
      surface.formatToolActionHeader(name, args, { pending: true, stableVerbWidth: true }),
      surface.formatToolActionHeader(name, args, { stableVerbWidth: true, failed: true }),
      surface.formatToolActionHeader(name, args, { category: 'Shell' }),
    ]),
  };
  return { name, args: jsonArgs, ...out };
}

function recordText(text) {
  return {
    text,
    normalized: guard(() => status.normalizeToolTerminalStatus(text)),
    leading: guard(() => status.leadingResultBlock(text)),
    userControl: guard(() => status.isUserControlCancellation(text)),
    benign: guard(() => status.hasBenignExitOutcome(text)),
    envelope: guard(() => status.toolResultEnvelopeStatus(text)),
    control: guard(() => status.toolResultControlStatus(text)),
    terminal: guard(() => status.toolResultTerminalStatus(text)),
    controlMarker: guard(() => contract.CONTROL_MARKER_RE.test(text)),
    cancelledText: guard(() => contract.isTranscriptCancelledStatusText(text)),
  };
}

const HIDDEN_ITEMS = [
  null, undefined, {}, { name: 'goal' }, { name: ' Functions.Todo ' }, { name: 'load_tool' }, { name: 'tool_search' }, { name: 'react' },
  { name: 'read' }, { name: 'skill', result: 'Loaded built-in skill: browser' }, { name: 'skill_view', result: '  loaded BUILT-IN skill: x' },
  { name: 'use_skill', result: 'Loaded skill: mine' }, { name: 'skill_execute', result: 'Loaded built-in skill:' }, { name: 'skill', result: null },
  { name: 'read', result: 'Loaded built-in skill: x' }, { name: 'create_goal', result: 1 }, { name: 'get_goal' }, { name: 'set_goal_tasks' },
  { name: 'update_goal' }, { name: 'todo', result: '' }, { name: 5 }, { name: ['goal'] }, { name: 'FUNCTIONS.skill', result: 'Loaded built-in skill: z' },
  { name: 'skill', result: { text: 'Loaded built-in skill: z' } }, 0, '', 'goal', [],
];
const MARKERS = [
  '[Request interrupted by user]', '[Request interrupted by user for tool use]', '[Request interrupted by process restart]', '[Request interrupted]',
  '[truncated]', '[TRUNCATED]', ' [Request interrupted] ', '[Request interrupted] x', '', 'plain', '[request interrupted by user for tool use] ',
];
const hidden = HIDDEN_ITEMS.map((item) => ({
  item: plain(item),
  hiddenItem: guard(() => contract.isTranscriptHiddenToolItem(item)),
  hiddenName: typeof item?.name === 'string' ? guard(() => contract.isTranscriptHiddenControlToolName(item.name)) : undefined,
  skillName: typeof item?.name === 'string' ? guard(() => contract.isTranscriptSkillToolName(item.name)) : undefined,
}));
const markers = MARKERS.map((text) => ({ text, controlMarker: contract.CONTROL_MARKER_RE.test(text), cancelledText: contract.isTranscriptCancelledStatusText(text) }));

// Aggregates: the done tallies of call lists, the stepped pass, and the header over the tally and over hand-built maps.
const pick = (names) => names.map((name) => calls.find((c) => c.name === name && JSON.stringify(c.args) === JSON.stringify(RICH)) ?? { name, args: {} });
const AGGREGATE_LISTS = [
  [],
  pick(['read', 'read', 'grep', 'bash', 'apply_patch', 'agent', 'task']),
  pick(['web_search', 'web_fetch', 'fetch', 'memory', 'recall', 'git', 'github', 'session', 'browser', 'computer', 'terminal']),
  pick(['mcp__github__create_issue', 'mcp__a__b', 'mystery', 'load_tool', 'skill', 'office', 'media', 'tidy', 'visualize', 'code_graph', 'goal']),
  [{ name: 'read', args: { path: 'a' } }, null, { name: 'read', args: { path: 'b' } }, { name: 'read', args: { paths: ['c', 'd'] }, category: 'Search' }, undefined, 0, { args: {} }],
  [{ name: 'apply_patch', args: { patch: PATCHES[1] } }, { name: 'apply_patch', args: { patch: PATCHES[2] } }, { name: 'apply_patch', args: { patch: PATCHES[0], dry_run: true } }],
  Array.from({ length: 40 }, (_, i) => ({ name: i % 3 ? 'read' : 'bash', args: i % 3 ? { path: `f${i}` } : { command: `c${i}` } })),
  Array.from({ length: 33 }, (_, i) => ({ name: ['read', 'grep', 'bash', 'agent'][i % 4], args: {}, category: i % 5 === 0 ? 'Other' : '' })),
];
const HEADER_MAPS = [
  {}, { Read: 2 }, { Read: { count: 3 }, Search: 5, Other: 1 }, { Setup: 2, Read: { count: 1 } }, { Zero: 0, Read: 0 }, { Visualize: 2, Tidy: { count: 1, noun: 'pass' } },
  { 'Read|Reading|Read|file|files': { category: 'Read', active: 'Reading', done: 'Read', noun: 'file', pluralNoun: 'files', count: 2, effect: false } },
  { 'Patch|Editing|Edited|file|files': { category: 'Patch', active: 'Editing', done: 'Edited', noun: 'file', pluralNoun: 'files', count: 2, effect: true }, Shell: 1 },
  { Made: { noun: 'thing', count: 1 } }, { Made2: { noun: 'thing', pluralNoun: 'things', count: 4, active: 'Making', done: 'Made', effect: true } },
  { 'Web Research': 2, Memory: '3', Agent: [1], Task: { count: '2' }, Browser: true, Computer: null }, { 'x|y': { count: 1 } }, { Git: -1, Shell: NaN },
];
const HEADER_OPTIONS = [{}, { pending: true }, { failed: true }, { pending: true, failed: true }, { stableVerbWidth: true }, { order: ['Shell', 'Read', 'Nope'], failed: true },
  { order: [], pending: true, stableVerbWidth: true }];
const drain = (list) => {
  const steps = surface.aggregateDoneCategoriesSteps(list);
  let yields = 0;
  for (;;) {
    const r = steps.next();
    if (r.done) return { yields, tallies: plain(r.value) };
    yields += 1;
  }
};
const aggregates = AGGREGATE_LISTS.map((list) => {
  const record = guard(() => drain(list));
  return {
    calls: plain(list),
    result: record,
    sync: guard(() => surface.aggregateDoneCategories(list)),
    headers: record.tallies ? HEADER_OPTIONS.map((options) => guard(() => surface.formatAggregateHeader(record.tallies, options))) : [],
  };
});
const headerMaps = HEADER_MAPS.map((map) => ({ map: plain(map), headers: HEADER_OPTIONS.map((options) => guard(() => surface.formatAggregateHeader(map, options))) }));

const golden = {
  note: 'Recorded by tests/recorders/record-tools.mjs from the Node tool surface; tests/tools_twin.rs replays it.',
  step: surface.STEP,
  categoryOrder: units.CATEGORY_ORDER,
  categoryCopy: Object.fromEntries([...units.CATEGORY_ORDER, 'Visualize', 'Nope'].map((c) => [c, plain(units.categoryCopy(c))])),
  fixtureCalls,
  calls: calls.map(recordCall),
  texts: [...texts].map(recordText),
  hidden,
  markers,
  aggregates,
  headerMaps,
};

// A call that throws in Node (a null argument where the code reads a field) is recorded as `{ threw }`; the twin skips it:
// the Rust port answers where Node crashes.
let threw = 0;
const scan = (value) => {
  if (Array.isArray(value)) return value.forEach(scan);
  if (!value || typeof value !== 'object') return;
  if (typeof value.threw === 'string') threw += 1;
  for (const inner of Object.values(value)) scan(inner);
};
scan(golden);
if (threw) console.error(`${threw} recorded output(s) are Node exceptions`);

const text = `${JSON.stringify(golden)}\n`;
if (checkPath) {
  const recorded = readFileSync(resolve(checkPath), 'utf8');
  if (recorded !== text) {
    console.error(`${checkPath} differs from what the Node code records now`);
    process.exit(1);
  }
  console.log(`${checkPath} matches (${golden.calls.length} calls, ${golden.texts.length} texts)`);
} else {
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath} (${golden.calls.length} calls, ${golden.texts.length} texts, ${fixtureCalls} fixture calls, ${text.length} bytes)`);
}
