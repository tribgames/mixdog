// Records the Node golden for the Rust tool-card model (mixdog-view-model: card_model/*). deriveToolCardModel runs over
//   (a) every tool row of the recorded corpora (native/core/fixtures: each JSON file's `kind: "tool"` rows, aggregate group
//       rows included), as recorded, pending, failed, exited, interrupted and denied,
//   (b) the cases of packages/protocol-client/test/rows/tool-card-model.golden-cases.mjs,
//   (c) a grid of tools (shell, read, edit, search, git, media, agent and task envelopes, background tasks, load_tool,
//       skills, call_tool) against result texts and the states of a call (pending, partly done, finished, failed, a command
//       exit, a verifying shell, an unfinished header), with and without a catalog, a surface row fitter and a row budget,
//   (d) group (aggregate) cards in every state,
// and every exported helper of the Node modules runs over its own grid; tests/cards_twin.rs replays the file in Rust.
//
//   node tests/recorders/record-cards.mjs [--tree <repo>] [--fixtures <dir>] [--out <file>]
//   node tests/recorders/record-cards.mjs [--tree <repo>] [--fixtures <dir>] --check <file>
//
// --tree is the Node product's tree (default: the repository this file sits in); --fixtures defaults to
// <tree>/native/core/fixtures. Each module is read from its product location (src/runtime/shared) and from the copy the
// protocol client ships (packages/protocol-client/src/rows). When both exist every call runs through both: a disagreement
// between the two Node copies is reported and fails the recording (it is never resolved silently). A module present in one
// place only is recorded from that one. The clock is pinned (Date.now, the zone) so the recording is repeatable; every case
// that reads a clock fixes nowMs and uses timestamps that carry a zone.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TZ = 'UTC';
const PINNED_NOW = 1_700_000_000_000;
Date.now = () => PINNED_NOW;

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const tree = resolve(flag('--tree') ?? join(here, '..', '..', '..', '..', '..', '..'));
const fixturesDir = resolve(flag('--fixtures') ?? join(tree, 'native', 'core', 'fixtures'));
const checkPath = flag('--check');
const outPath = resolve(flag('--out') ?? join(here, '..', 'goldens', 'cards.json'));

const ROWS = 'packages/protocol-client/src/rows';
async function loadCopies(file, dirs) {
  const copies = [];
  for (const dir of dirs) {
    const path = join(tree, dir, file);
    if (existsSync(path)) copies.push({ where: dir, module: await import(pathToFileURL(path).href) });
  }
  if (!copies.length) throw new Error(`${file} is in none of ${dirs.join(', ')} of ${tree}`);
  return copies;
}
const SHARED = 'src/runtime/shared';
const sub = (file) => loadCopies(file, [`${SHARED}/tool-card-model`, `${ROWS}/tool-card-model`]);
const cardMods = await loadCopies('tool-card-model.mjs', [SHARED, ROWS]);
const inlineMods = await sub('inline-text.mjs');
const terminalMods = await sub('terminal-status.mjs');
const shellMods = await sub('shell-surface.mjs');
const genericMods = await sub('generic-detail.mjs');
const agentMods = await sub('agent-surface.mjs');
const backgroundMods = await sub('background-task.mjs');
const mediaMods = await sub('media-result.mjs');
const gitMods = await sub('git-result.mjs');

// ── Running a function through every copy ───────────────────────────────────

const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
const disagreements = [];
const settle = (fn) => {
  try {
    return plain(fn());
  } catch (error) {
    return { threw: String(error?.message ?? error) };
  }
};
const outputsOf = (mods, call) => mods.map(({ module }) => settle(() => call(module)));
const agree = (mods, outputs, what) => {
  for (let i = 1; i < outputs.length; i += 1) {
    if (JSON.stringify(outputs[i]) !== JSON.stringify(outputs[0])) {
      disagreements.push({ what: what.slice(0, 300), [mods[0].where]: outputs[0], [mods[i].where]: outputs[i] });
    }
  }
  return outputs[0];
};
// `run(mods, name, ...args)`: the named export of every copy over a fresh copy of the arguments.
const run = (mods, name, ...args) =>
  agree(mods, outputsOf(mods, (module) => module[name](...args.map((a) => structuredClone(a)))), `${name}(${JSON.stringify(args)})`);
// An undefined argument survives the golden as null; the replay reads null as undefined only where the function does.
const rec = (mods, name, ...args) => [args, run(mods, name, ...args)];

// ── Options of a card ───────────────────────────────────────────────────────

const catalog = (key, original) => `[${key}|${original}]`;
const tilde = (text, width) => (String(text).length <= width ? String(text) : `${String(text).slice(0, Math.max(0, width - 1))}~`);
// `[translate, tilde fitter, maxResultChars]`
const OPTIONS = [
  { translate: false, fit: false, max: null },
  { translate: true, fit: false, max: null },
  { translate: false, fit: true, max: 40 },
  { translate: false, fit: false, max: 10 },
  { translate: true, fit: true, max: 200 },
  { translate: false, fit: false, max: 30 },
];
const nodeOptions = (o) => ({
  ...(o.translate ? { translate: catalog } : {}),
  ...(o.fit ? { truncate: tilde } : {}),
  ...(o.max != null ? { maxResultChars: o.max } : {}),
});
const NOW = 20000;

// ── The texts ───────────────────────────────────────────────────────────────

const big = (n) => 'x'.repeat(n);
const BG_RUNNING = 'background task\ntask_id: t1\nsurface: shell\nstatus: running\nstarted: 2024-01-01T00:00:00Z\n\nbuilding…';
const BG_DONE =
  'background task\ntask_id: t4\nsurface: bash\nstatus: completed\nstarted: 2024-01-01T00:00:00Z\nfinished: 2024-01-01T00:01:05Z\n\nall good\nline2';
const BG_FAILED = 'background task\ntask_id: t3\nsurface: web_search\nstatus: failed\nerror: boom\n';
const BG_QUEUED = 'background task\ntask_id: t5\nstatus: queued\n\nwaiting for a slot';
const NOTICE_DONE =
  '<task-notification>\n<task-id>t2</task-id>\n<status>completed</status>\n<exit-code>0</exit-code>\n<summary>Shell task completed (exit 0)</summary>\n<result>\nall good\nline2\n</result>\n</task-notification>';
const NOTICE_FAILED =
  '<task-notification>\n<task-id>t6</task-id>\n<status>failed</status>\n<summary>Agent failed</summary>\n<error>spawn refused</error>\n</task-notification>';
const NOTICE_AGENT =
  '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent completed</summary>\n<result>\nThe review is ready.\n</result>\n</task-notification>';
const TEXTS = [
  '', ' ', '\n\n', 'ok', 'hello\nworld', 'single line', '\u001b[31mred\u001b[0m text\n\u001b[2Kgreen', '\ttab\r\nrow\u0007bell',
  '[exit code: 0]\nout', '[exit code: 1]\n\nboom', '[exit code: 2]\n[outcome: no-match]\n', 'Error: [shell-run-failed] [exit code: 3]\nbad',
  '[status: completed]\n[exit code: 0]\nout', '[status: failed]\nexit 1', '[status: Cancelled]', '[status: running]\nstill going', '[elapsed: 2500 ms]\nfile-a\nfile-b',
  '[elapsed: 800 ms]\nfast', 'status: running\n\nstatus: failed in the body', 'status: failed\nreason',
  '1→alpha\n2→beta\n3→gamma', '[lines 1-3]\nalpha\nbeta\ngamma', '[lines 1-2]\nalpha\nbeta\n[lines 1-2 of 9; offset:3 for more]', '(no lines in range; file has 3 lines)',
  'OK modify src/a.rs — +3 -1', 'Edited: a.rs (+2 -1)', 'Created: b.rs', '3 additions, 1 removal', '--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n-old\n+new\n+more',
  '# a.rs\n3:fn x\n--\n# b.rs\n9:z', 'a.rs:3\nb.rs:2', '(no matches)', 'src/a.rs\nsrc/b.rs\nsrc/c.rs', 'HTTP 200 OK\ncontent-length: 12 KB\n\nbody', 'Status: 404 Not Found',
  '12 results\n1. foo\n2. bar', 'Loaded built-in skill: browser', 'Cancelled', 'canceled!',
  'Interrupted by user', '[Tool execution was interrupted]', 'Tool execution aborted', "The user doesn't want to proceed with this tool use. The tool use was rejected.",
  'Browser command interrupted by local user input.', 'computer_user_control_active: the user took over', 'Error: computer_session_aborted: stop', 'Error: boom', 'Error: [x] failed\nsecond line',
  '## main\n M a.txt\n', '## git add a.txt\n\n## git status\n## main\nA  a.txt\n', 'exit 128\nfatal: missing ref\n', 'exit 1\n[outcome: no-match]\ndiff --git a/a.txt b/a.txt\n',
  '## git show missing\nexit 128\nfatal: missing\nerror: command failed: git show missing', '{"ok":true,"clean":true}',
  '{"ok":true,"job":"j1","status":"running"}', '{"ok":true,"job":"j1","status":"completed"}', '{"ok":true,"job":"j1","status":"failed","error":"nope"}', '{"ok":false,"error":"no such job"}',
  '{"ok":true,"job":"j1","canceled":true,"status":"cancelled"}', '{"ok":false}', '{not json',
  BG_RUNNING, BG_DONE, BG_FAILED, BG_QUEUED, NOTICE_DONE, NOTICE_FAILED, NOTICE_AGENT, 'background task\nstatus: done',
  'agent task: a1\nstatus: completed\nagent: worker\nmodel: gpt-5\n\nThe answer is 42', 'agent task: a1\nstatus: running', 'agent message queued\ntask_id: a1\nstatus: queued',
  'agent close: a1', 'agents: 2\ntasks: 1\n- a1 running', '(no agents or tasks)', 'status: running · task_id: a1', 'task_id: a1\nstatus: completed\nagent: reviewer\n\nreview text',
  'null', 'undefined', 'The answer is 42.\nmore text', '<result>\nInside result\n</result>',
  JSON.stringify({ selected: { tools: { added: ['office'], already: ['media'] } } }), JSON.stringify({ selected: { tools: { added: [], already: ['media'] } } }),
  JSON.stringify({ entries: [{ name: 'office' }, { name: 'media' }], missing: ['x'], blocked: [{ name: 'y' }] }), JSON.stringify({ entries: [], missing: [], blocked: [] }),
  'Loaded deferred tools: a, b\nAlready active: c', 'Loaded deferred tools: a', '5', '[1,2]',
  'line one is long ' + big(150), big(500) + '\nsecond', 'α'.repeat(100), '💥'.repeat(60), 'a'.repeat(79) + '💥',
];

// The result texts, args and rows of the recorded corpora.
const fixtureRows = [];
const fixtureFiles = [];
const listJson = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listJson(path);
    else if (entry.name.endsWith('.json') && statSync(path).size <= 6_000_000) fixtureFiles.push(path);
  }
};
if (!existsSync(fixturesDir)) throw new Error(`fixtures ${fixturesDir} are missing (pass --fixtures)`);
listJson(fixturesDir);
const seenRows = new Set();
for (const path of fixtureFiles) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue;
  }
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'tool' && typeof node.name === 'string') {
      const key = JSON.stringify(node);
      if (!seenRows.has(key) && key.length < 8000) {
        seenRows.add(key);
        fixtureRows.push(node);
      }
    }
    for (const inner of Object.values(node)) walk(inner);
  };
  walk(value);
}
if (!fixtureRows.length) throw new Error(`no tool rows in ${fixturesDir}`);
const itemOf = (row) => {
  const { kind, id, expanded, archived, at, callId, callIds, text, toolMembers, offset, ...rest } = row;
  return { ...rest, nowMs: NOW };
};

// ── deriveToolCardModel ─────────────────────────────────────────────────────

const cases = [];
const runCard = (input, optionIndex) => {
  const o = OPTIONS[optionIndex];
  const out = agree(
    cardMods,
    outputsOf(cardMods, (module) => module.deriveToolCardModel(structuredClone(input), nodeOptions(o))),
    `deriveToolCardModel(${JSON.stringify(input).slice(0, 200)})`
  );
  cases.push([input, optionIndex, out]);
};
const withOptions = (input, index) => {
  runCard(input, 0);
  if (index % 4 === 0) runCard(input, 1 + ((index / 4) % (OPTIONS.length - 1)));
};

// (a) the recorded rows, in the states a call can be in.
fixtureRows.forEach((row, index) => {
  const item = itemOf(row);
  withOptions(item, index);
  const { result, rawResult, completedAt, errorCount, callErrorCount, exitErrorCount, isError, ...open } = item;
  withOptions({ ...open, completedCount: 0, startedAt: 1000 }, index + 1);
  withOptions({ ...item, isError: true, errorCount: item.count ?? 1, callErrorCount: item.count ?? 1, startedAt: 1000, completedAt: 3500 }, index + 2);
  withOptions({ ...item, errorCount: 1, exitErrorCount: 1 }, index + 3);
  withOptions({ ...item, result: '[Tool execution was interrupted]', isError: true }, index + 4);
  withOptions({ ...item, result: "The user doesn't want to proceed with this tool use. The tool use was rejected.", isError: true }, index + 5);
});

// (b) the cases of the product's own golden.
const goldenCases = await import(pathToFileURL(join(tree, 'packages/protocol-client/test/rows/tool-card-model.golden-cases.mjs')).href);
goldenCases.GOLDEN_CASES.forEach((c, index) => {
  const optionIndex = OPTIONS.findIndex((o) => !o.translate && !o.fit && o.max === (c.options?.maxResultChars ?? null));
  if (optionIndex < 0) throw new Error(`the golden case ${c.id} has options the recorder does not know`);
  runCard(c.input, optionIndex);
  if (index % 2 === 0) runCard(c.input, 1);
});
for (const git of goldenCases.GIT_GOLDEN_CASES) runCard({ name: 'git', args: { command: 'git status' }, result: git.result, nowMs: NOW }, 0);

// (c) the grid.
const TOOLS = [
  ['shell', { command: 'ls' }], ['bash', { command: 'npm test' }], ['bash_session', { command: 'x', verifyShell: true }], ['read', { path: 'src/a.rs' }],
  ['read', { file_path: 'C:/x/y.mjs', offset: 5, limit: 20 }], ['apply_patch', { patch: '*** Update File: a.txt\n+x' }], ['edit', { path: 'a.txt', old_string: 'a', new_string: 'b' }],
  ['write', { path: 'b.txt', content: 'x' }], ['grep', { pattern: 'x', path: '.' }], ['glob', { pattern: '*.rs' }], ['list', { path: '.' }], ['git', { command: 'status' }],
  ['web_search', { query: 'rust' }], ['fetch', { url: 'https://x.y' }], ['recall', { query: 'q' }], ['code_graph', { symbol: 'S' }],
  ['agent', { agent: 'worker', prompt: 'do it', tag: 't1', model: 'claude-opus-4-8' }], ['agent', { type: 'status', task_id: 'T1' }], ['agent', { type: 'result', agent: 'reviewer' }],
  ['agent', { action: 'list' }], ['agent', { type: 'send', agent: 'heavy-worker', message: 'hello there' }], ['agent', { type: 'spawn', status: 'failed', error: 'spawn refused' }],
  ['agent', { type: 'spawn', agent: 'worker', status: 'cancelled', error: 'cancelled by user' }], ['agent', {}],
  ['task', { action: 'wait', task_id: 't1' }], ['task', { type: 'result', task_id: 't1', status: 'completed' }], ['task', { task_id: 't1', status: 'running', type: 'progress' }],
  ['task', { action: 'cancel', task_id: 't1' }], ['load_tool', { names: ['a', 'b'] }], ['tool_search', { select: 'x' }], ['skill', { name: 's' }], ['use_skill', { name: 's' }],
  ['view_image', { path: 'a.png' }], ['media', { action: 'status', job: 'j1' }], ['media', { action: 'cancel', job: 'j1' }], ['media', { action: 'generate', prompt: 'p' }],
  ['call_tool', { name: 'shell', arguments: { command: 'ls' } }], ['mcp__srv__do', { x: 1 }], ['mystery', {}], ['', {}],
  ['shell', { task_id: 't9', status: 'running', startedAt: '2024-01-01T00:00:00Z', finishedAt: '2024-01-01T00:00:42Z' }],
  ['web_search', { task_id: 't3', status: 'failed', error: 'boom', surface: 'web_search' }],
];
const STATES = [
  (base) => base,
  (base) => ({ ...base, completedCount: 0, startedAt: 1000 }),
  (base) => ({ ...base, count: 3, completedCount: 1, startedAt: 1000 }),
  (base) => ({ ...base, count: 3, startedAt: 1000, completedAt: 9000 }),
  (base) => ({ ...base, isError: true, errorCount: 1, callErrorCount: 1 }),
  (base) => ({ ...base, errorCount: 1, exitErrorCount: 1 }),
  (base) => ({ ...base, headerFinalized: false }),
  (base) => ({ ...base, rawResult: 'raw ' + (base.result ?? '') }),
];
let gridIndex = 0;
TOOLS.forEach(([name, args], toolIndex) => {
  TEXTS.forEach((text, textIndex) => {
    // Every tool meets a seventh of the texts (a different seventh each); every state of it meets every eighth.
    if ((textIndex + toolIndex) % 7 !== 0) return;
    STATES.forEach((state, stateIndex) => {
      if ((textIndex + stateIndex) % 3 !== 0 && stateIndex > 1) return;
      gridIndex += 1;
      withOptions(state({ name, args, result: text, nowMs: NOW }), gridIndex);
    });
  });
  // Absent and null results, string args and a missing name or args.
  runCard({ name, args, nowMs: NOW }, 0);
  runCard({ name, args, result: null, nowMs: NOW }, 0);
  runCard({ name, args: JSON.stringify(args), result: 'ok', nowMs: NOW }, 0);
  runCard({ name, result: 'ok', nowMs: NOW }, 0);
});
runCard({ args: { command: 'ls' }, result: 'ok', nowMs: NOW }, 0);
runCard({ name: 'read', args: null, result: 'ok', nowMs: NOW }, 0);

// (d) group cards.
const CATEGORIES = [
  {}, { Read: 2 }, { Read: { count: 3, active: 'Reading', done: 'Read', noun: 'file', pluralNoun: 'files', category: 'Read' }, Search: 1 },
  { Read: { count: 2.9 }, Shell: -4, Edit: 'x', Misc: null }, { Search: { count: 0 } },
];
for (const [index, categories] of CATEGORIES.entries()) {
  for (const extra of [
    { completedCount: 0 }, { count: 4, completedCount: 2 }, { count: 4 }, { count: 2, result: 'Read 2 files\nsearched 1' }, { count: 2, result: '', isError: true, errorCount: 2 },
    { count: 3, result: '[status: failed]\nx', errorCount: 1 }, { count: 2, result: 'Cancelled' }, { count: 1, headerFinalized: false, result: 'x' },
  ]) {
    const base = { aggregate: true, categories, doneCategories: index % 2 ? categories : { Read: 1 }, nowMs: NOW, startedAt: 1000, ...extra };
    withOptions(base, index);
    runCard({ ...base, args: { categoryOrder: ['Search', 'Read'] } }, 0);
    runCard({ ...base, args: { loadingTargets: ['office', ' office', 'media', ''] } }, 0);
    runCard({ ...base, doneCategories: null }, 0);
  }
}

// ── The helpers ─────────────────────────────────────────────────────────────

const helpers = {};
const group = (name, mods, fn, argLists) => {
  helpers[name] = argLists.map((args) => rec(mods, fn, ...args));
};
const metaCases = [];
for (const text of TEXTS) {
  for (const args of [{}, { status: 'Failed', error: 'boom', surface: 'bash', task_id: 'T1' }, { task_id: 't9', startedAt: '2024-01-01T00:00:00Z', finishedAt: '2024-01-01T00:00:42Z', type: 'progress' }]) {
    const meta = run(backgroundMods, 'resolveBackgroundTaskMeta', args, text);
    if (meta && typeof meta === 'object' && !meta.threw) metaCases.push([args, text, meta]);
  }
}
const ARGS = [
  {}, { agent: 'worker' }, { agent: 'heavy_worker', tag: 't1' }, { subagent_type: 'reviewer', model: 'claude-opus-4-8', tag: 'x' }, { name: 'my-custom_agent', type: 'send' },
  { agent: 'worker', type: 'status', task_id: 'a1' }, { type: 'result' }, { action: 'result', agent: 'worker' }, { type: 'list' }, { type: 'weird' }, { type: 'SPAWN', agent: 'Maintainer' },
  { agent: 'worker', modelDisplay: 'Opus 4.8' }, { agent: 5 }, { tag: 7, agent: 'a' }, { type: 'cancel', agent: 'worker', provider: 'openai', model: 'openai/gpt-5' },
];
const SUMMARIES = ['', 'Worker', 'Worker · send · hello', 'send', 'send · hi', 'Opus 4.8', 't1', 'other', ' padded ', 'Heavy Worker · Opus 4.8'];
const STATUS_WORDS = ['', 'running', 'pending', 'queued', 'in_progress', 'completed', 'done', 'success', 'ok', 'failed', 'error', 'timeout', 'killed', 'cancelled', 'canceled', 'cancel', 'cancelling',
  'cancel-unconfirmed', 'cancel_pending', 'denied', 'refused', 'exit', ' Failed ', 'weird', null, 0, 5];
const ELAPSED = ['', '12s', '1m 5s', ' 3s '];
const NAMES = ['', 'shell', 'bash', 'bash_session', 'shell_command', 'job_wait', 'task', 'read', 'web_search', 'agent', 'load_tool', 'Task', 'mystery'];
const LABELS = ['', 'Run', 'run', 'Read', 'Search', 'Web Search', 'Shell', 'other'];

group('safeInlineText', inlineMods, 'safeInlineText', TEXTS.map((t) => [t]));
group('splitLineDeltaTokens', inlineMods, 'splitLineDeltaTokens', [
  ...['[+ 2 Lines] (-3 lines)', 'report-3.md +2 bytes', '+177 lines', 'Edited a.rs (+2 -1)', '+1 line, -2 Lines', 'x +5\tlines', '·+3 lines', '+ 3 Lines and -4 lines'].map((t) => [t]), [null], [undefined], [''],
]);
group('normalizeCountMap', inlineMods, 'normalizeCountMap', [
  [{}], [undefined], [null], [{ Read: 2 }], [{ Read: 2.7, Shell: -1, Edit: 'x', N: null, B: true }], [{ A: { count: '4', noun: 'x' }, B: { noun: 'y' }, C: [1, 2] }],
]);
group('deriveToolOutcomeTone', terminalMods, 'deriveToolOutcomeTone', [
  [], [{}],
  ...[true, false].flatMap((pending) =>
    ['', 'running', 'completed', 'failed', 'cancelled', 'denied', 'weird'].flatMap((terminalStatus) =>
      [[0, 0, 1], [1, 0, 1], [1, 0, 3], [3, 0, 3], [0, 2, 2], [0, 0, 0], [2, 1, 2]].map(([callFailedCount, exitFailedCount, groupCount]) => [
        { pending, terminalStatus, callFailedCount, exitFailedCount, groupCount },
      ])
    )
  ),
  [{ callFailedCount: 1, partialMutation: true }], [{ groupCount: 'x', callFailedCount: '2' }],
]);
group('displayTerminalStatus', terminalMods, 'displayTerminalStatus', STATUS_WORDS.map((s) => [s]));
group('normalizeTerminalStatus', terminalMods, 'normalizeTerminalStatus', STATUS_WORDS.map((s) => [s]));
group('mergeTerminalDetail', terminalMods, 'mergeTerminalDetail', STATUS_WORDS.flatMap((s) => ['', 'boom', 'Failed', 'failed to x', 'Cancelled', 'queued job', 'Queued', ' 3 files ', 'Running', 'Exited'].map((d) => [s, d])));
group('prefixElapsed', terminalMods, 'prefixElapsed', ['', 'done', 'done · 12s', ' x ', null].flatMap((d) => [...ELAPSED, undefined, null].map((e) => [d, e])));
group('clampFailureCount', terminalMods, 'clampFailureCount', [null, 0, 1, 2, 5, -2, 1.9, 'x', '2', true, ''].flatMap((c) => [1, 3].flatMap((n) => [true, false].map((e) => [c, n, e]))));
group('clampFailureCountAbsent', terminalMods, 'clampFailureCount', [1, 3].flatMap((n) => [true, false].map((e) => [undefined, n, e])));
group('shellResultStatus', terminalMods, 'shellResultStatus', TEXTS.map((t) => [t]));
group('shellResultElapsed', terminalMods, 'shellResultElapsed', TEXTS.map((t) => [t]));
group('stripLeadingStatusMarkerFromText', terminalMods, 'stripLeadingStatusMarkerFromText', [...TEXTS.map((t) => [t]), [null]]);
group('resultTerminalStatus', terminalMods, 'resultTerminalStatus', TEXTS.map((t) => [t]));
group('resultEnvelopeStatus', terminalMods, 'resultEnvelopeStatus', TEXTS.map((t) => [t]));
group('resultControlStatus', terminalMods, 'resultControlStatus', TEXTS.map((t) => [t]));
group('isShellTool', shellMods, 'isShellTool', NAMES.flatMap((n) => LABELS.map((l) => [n, l])));
group('shellDisplayStatus', shellMods, 'shellDisplayStatus', [
  [], ...[true, false].flatMap((pending) =>
    [[0, 0, false], [1, 0, false], [1, 1, false], [2, 1, false], [0, 0, true], [0, 2, false]].flatMap(([failedCount, exitFailedCount, isError]) =>
      ['', '[status: running]', 'status: queued', 'status: cancelled', 'status: canceled', 'status: failed', 'status: completed', 'out'].map((result) => [{ pending, failedCount, exitFailedCount, isError, result }])
    )
  ),
]);
group('shellHeader', shellMods, 'shellHeader', ['running', 'completed', 'exit', 'failed', 'cancelled', ''].flatMap((s) => [1, 2, 0, 2.5, 'x'].flatMap((n) => [true, false].map((v) => [s, n, v]))));
group('genericCompletedDetail', genericMods, 'genericCompletedDetail', NAMES.flatMap((normalizedName) =>
  LABELS.flatMap((label) => [[true, false], [false, false], [true, true], [false, true]].map(([hasResult, isError]) => [{ normalizedName, label, hasResult, firstResultLine: 'first', isError }]))));
group('bridgeDescribeResult', genericMods, 'bridgeDescribeResult', [...TEXTS.map((t) => [t]), [null], [undefined]]);
group('toolSearchLoadedSummary', genericMods, 'toolSearchLoadedSummary', [...TEXTS.map((t) => [t]), [null], [undefined]]);
group('shouldPrefixSyncElapsed', genericMods, 'shouldPrefixSyncElapsed', NAMES.flatMap((n) => LABELS.map((l) => [n, l])));
group('agentActionTitle', agentMods, 'agentActionTitle', ARGS.flatMap((a) => ['', 'agent: reviewer\nstatus: done', NOTICE_AGENT].map((t) => [a, t])));
group('agentActionSummary', agentMods, 'agentActionSummary', ARGS.flatMap((a) => SUMMARIES.map((s) => [a, s])));
group('agentResponseTitle', agentMods, 'agentResponseTitle', ARGS.flatMap((a) => [1, 3, 0, 'x'].flatMap((n) => ['', 'agent: reviewer\nstatus: done'].map((t) => [a, n, t]))));
group('isAgentResponseResult', agentMods, 'isAgentResponseResult', ARGS.flatMap((a) => TEXTS.map((t) => [a, t])));
group('hasAgentResponseResult', agentMods, 'hasAgentResponseResult', [...TEXTS.map((t) => [t]), [null], [undefined]]);
group('titleizeAgentName', agentMods, 'titleizeAgentName', ['', ' ', 'worker', 'Heavy_Worker', ' my-custom_agent ', 'a  b', '_x_', 'élan vital', 5, null].map((n) => [n]));
group('agentTerminalDetail', agentMods, 'agentTerminalDetail', STATUS_WORDS.flatMap((s) =>
  [true, false].flatMap((e) => ['', '12s'].flatMap((el) => [undefined, 'boom'].map((er) => [s, e, el, er])))));
group('parseBackgroundTaskResult', backgroundMods, 'parseBackgroundTaskResult', [...TEXTS.map((t) => [t]), [null], [undefined]]);
group('isBackgroundTaskTool', backgroundMods, 'isBackgroundTaskTool', NAMES.map((n) => [n]));
group('isBackgroundTaskResponseArgs', backgroundMods, 'isBackgroundTaskResponseArgs', NAMES.flatMap((n) =>
  [{}, { type: 'result' }, { action: 'completion' }, { status: 'completed', task_id: 't' }, { status: 'completed' }, { status: 'running', type: 'result' }, { status: 'Canceled', task_id: 't' }].map((a) => [n, a])));
group('taskControlTitle', backgroundMods, 'taskControlTitle', ['task', 'Task', 'shell', ''].flatMap((n) => [{}, { action: 'list' }, { type: 'read' }, { action: 'status' }, { action: 'wait' }, { type: 'cancel' }, { action: 'x' }].map((a) => [n, a])));
helpers.resolveBackgroundTaskMeta = metaCases.map(([args, text, meta]) => [[args, text], meta]);
for (const [name, fn] of [['backgroundTaskResultTitle', 'backgroundTaskResultTitle'], ['backgroundTaskActionTitle', 'backgroundTaskActionTitle']]) {
  helpers[name] = metaCases.flatMap(([, , meta]) => ['task', 'web_search', 'shell', 'agent', ''].map((n) => rec(backgroundMods, fn, n, meta)));
}
helpers.backgroundTaskDetail = metaCases.flatMap(([, , meta]) => ['', '12s'].map((e) => rec(backgroundMods, 'backgroundTaskDetail', meta, e)));
helpers.backgroundTaskFailureDetail = metaCases.flatMap(([, , meta]) => [{}, { status: 'failed', error: 'late', surface: 'agent' }].map((a) => rec(backgroundMods, 'backgroundTaskFailureDetail', meta, a)));
helpers.backgroundTaskElapsed = metaCases.flatMap(([, , meta]) => ['', 'fb'].map((f) => rec(backgroundMods, 'backgroundTaskElapsed', meta, f)));
helpers.backgroundTaskArgsElapsed = [
  {}, { startedAt: '2024-01-01T00:00:00Z', finishedAt: '2024-01-01T00:00:42Z' }, { startedAt: '2024-01-01T00:00:00Z', finishedAt: '2024-01-01T00:00:00.500Z' },
  { startedAt: '2024-01-01T00:00:10Z', finishedAt: '2024-01-01T00:00:00Z' }, { startedAt: 'x', finishedAt: 'y' }, { startedAt: '2024-01-01T00:00:00Z' },
  { startedAt: '2024-01-01T00:00:00+02:00', finishedAt: '2024-01-01T03:10:00Z' }, { startedAt: 1704067200000, finishedAt: 1704067290000 }, { startedAt: '2024-01-01T00:00:00Z', finishedAt: '2024-01-03T04:05:06Z' },
].flatMap((args) => ['', 'fb'].map((f) => [[args, f], run(backgroundMods, 'backgroundTaskElapsed', args, f)]));
group('mediaTerminalStatus', mediaMods, 'mediaTerminalStatus', ['status', 'cancel', 'CANCEL', 'generate', ''].flatMap((action) => TEXTS.map((t) => [{ action }, t])));
group('mediaResultSummary', mediaMods, 'mediaResultSummary', ['status', 'cancel', 'generate', ''].flatMap((action) => TEXTS.map((t) => [{ action }, t])));
group('gitTerminalStatus', gitMods, 'gitTerminalStatus', TEXTS.map((t) => [t]));

// ── The golden ──────────────────────────────────────────────────────────────

const golden = { options: OPTIONS, now: NOW, cases, helpers };
const text = `${JSON.stringify(golden)}\n`;
if (disagreements.length) {
  console.error(`${disagreements.length} disagreements between the Node copies; first:`);
  console.error(JSON.stringify(disagreements[0]).slice(0, 1500));
  process.exit(1);
}
if (checkPath) {
  const recorded = readFileSync(resolve(checkPath), 'utf8');
  if (recorded !== text) {
    console.error(`${checkPath} differs from what the Node code records now (${recorded.length} vs ${text.length} bytes)`);
    process.exit(1);
  }
  console.log(`${checkPath} matches (${cases.length} cards, ${Object.values(helpers).reduce((n, rows) => n + rows.length, 0)} helper calls)`);
} else {
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath}: ${cases.length} cards, ${Object.values(helpers).reduce((n, rows) => n + rows.length, 0)} helper calls, ${text.length} bytes`);
}
