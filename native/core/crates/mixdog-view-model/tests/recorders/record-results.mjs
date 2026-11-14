// Records the Node golden for the Rust tool result projections (mixdog-view-model: results::{summary, status, text,
// classification, read_rows, aggregate_detail, git_media}). Every exported function of the Node modules runs
// over a corpus of real-shaped results (shell output with ANSI, file reads with line numbers, edit and patch diffs, search
// hits, web results, MCP content arrays, agent results and task envelopes, errors, very large outputs, empty results) plus the
// result texts of the row-bearing fixtures of native/core fixtures; tests/results_twin.rs replays the file in Rust.
//
//   node tests/recorders/record-results.mjs [--tree <repo>] [--fixtures <dir>] [--out <file>]
//   node tests/recorders/record-results.mjs [--tree <repo>] [--fixtures <dir>] --check <file>
//
// --tree is the Node product's tree (default: the repository this file sits in); --fixtures defaults to
// <tree>/native/core/fixtures. Each module is read from its product location (src/runtime/shared, src/tui/session,
// src/runtime/agent/orchestrator/session) and from the copy the protocol client ships (packages/protocol-client/src/rows). When
// both exist every call runs through both: a disagreement between the two Node copies is reported and fails the recording
// (it is never resolved silently). A module present in one place only is recorded from that one.
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
const outPath = resolve(flag('--out') ?? join(here, '..', 'goldens', 'results.json'));

const ROWS = 'packages/protocol-client/src/rows';
async function loadCopies(file, productDirs) {
  const copies = [];
  for (const dir of [...productDirs, ROWS]) {
    const path = join(tree, dir, file);
    if (existsSync(path)) copies.push({ where: dir, module: await import(pathToFileURL(path).href) });
  }
  if (!copies.length) throw new Error(`${file} is in none of ${[...productDirs, ROWS].join(', ')} of ${tree}`);
  return copies;
}
const summaryMods = await loadCopies('tool-result-summary.mjs', ['src/runtime/shared']);
const statusMods = await loadCopies('tool-result-status.mjs', ['src/tui/session']);
const textMods = await loadCopies('tool-result-text.mjs', ['src/tui/session']);
const classMods = await loadCopies('result-classification.mjs', ['src/runtime/agent/orchestrator/session']);
const rowsMods = await loadCopies('read-row-numbers.mjs', ['src/runtime/shared']);
const errMods = await loadCopies('err-text.mjs', ['src/runtime/shared']);
const surfaceMods = await loadCopies('tool-surface.mjs', ['src/runtime/shared']);
const surface = surfaceMods[0].module;

// ── Running a function through every copy ───────────────────────────────────

const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
const disagreements = [];
const drain = (steps) => {
  let yields = 0;
  for (;;) {
    const r = steps.next();
    if (r.done) return { yields, value: r.value };
    yields += 1;
  }
};
const settle = (fn) => {
  try {
    return plain(fn());
  } catch (error) {
    return { threw: String(error?.message ?? error) };
  }
};
// `run(mods, name, ...args)`: the named export of every copy over a fresh copy of the arguments; the primary's output is the
// record. A stepped function (a generator) is drained and records `{ yields, value }`.
const run = (mods, name, ...args) => {
  const outputs = mods.map(({ module }) =>
    settle(() => {
      const result = module[name](...args.map((a) => (typeof a === 'function' ? a : structuredClone(a))));
      return result && typeof result.next === 'function' && typeof result[Symbol.iterator] === 'function' ? drain(result) : result;
    })
  );
  for (let i = 1; i < outputs.length; i += 1) {
    if (JSON.stringify(outputs[i]) !== JSON.stringify(outputs[0])) {
      disagreements.push({ name, args: JSON.stringify(args).slice(0, 200), [mods[0].where]: outputs[0], [mods[i].where]: outputs[i] });
    }
  }
  return outputs[0];
};
const catalog = (key, original) => `[${key}|${original}]`;

// ── The corpus ──────────────────────────────────────────────────────────────

const big = (n) => 'x'.repeat(n);
const TEXTS = [
  // empty and blank
  '', ' ', '\n\n', '   \n  ', '\t',
  // shell output
  'hello\nworld', 'single line', '\u001b[31mred\u001b[0m text\n\u001b[1;32mgreen\u001b[0m', '[exit code: 0]\nout', '[exit code: 0]', '[exit code: 1]\n\nboom',
  '[exit code: 2]\n[outcome: no-match]\n', 'Error: [shell-run-failed] [exit code: 3]\nbad', '[session: s1]\n[exit code: 1]\nx', 'Error: [shell-tool-failed] spawn',
  '[exit code: 1] timed out', '[timeout: 30s]\npartial', '[signal: SIGKILL]', '[status: completed]\n[exit code: 0]', '[status: failed]\n[exit code: 1]',
  '[task_id: T-1]\n[status: running]', '[job: j-2]\n[exit: 2]', '[task_id: T-3]', '[status: timed out]', '[status: Cancelled]', '[status: queued]\n[exit code: 0]',
  'background task\nstatus: running\ntask_id: T-9\n\n[stdout]\nline one\nline two', 'background task\nstatus: done\n\n[stderr preview]\nwarn: x',
  'background task\nstatus: done', '[tool output offloaded: shell /tmp/x]\n\n[exit code: 1]\nbody', '⚠️ warning\nError: [shell-run-failed] [timeout: 5s]',
  // file reads
  '1→alpha\n2→beta\n3→gamma', '[lines 1-3]\nalpha\nbeta\ngamma', '[lines 1-2]\nalpha\nbeta\n[lines 1-2 of 9; offset:3 for more]', '[lines 4-6]\na\nb\nc\n[lines 4-6 of 6]',
  '(no lines in range; file has 3 lines)', '[image: image/png]', '[image: ]', '<system-reminder>File exists but has empty contents: a.txt</system-reminder>',
  '[lines 1-5]\nonly\ntwo', '[lines 9-7]\nx', '1→a\n3→c\n4→d', '[lines 1-2]\n1→x\n2→y',
  // edits and patches
  'OK modify src/a.rs — +3 -1', 'OK add x.txt', 'OK delete y.txt', 'OK create new/z.md — +12', 'OK modify a.rs — +1 line / -2 lines\nOK modify b.rs — +4',
  'Edited: a.rs (+2 -1)', 'Created: b.rs', 'Wrote: c.rs (+10)', 'Updated: d.rs (-4)', 'Updated: e.rs (report-20260920.md)',
  'Edited: src/deep/path/file.rs (+1 -1)\nEdited: other.rs (+2)', '3 additions, 1 removal', '5 additions', '2 removals', '--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n-old\n+new\n+more',
  'diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n+1\n+2', 'Updated foo.rs · +3 -1', 'Created 3 Files · +9 -0', 'Checked bar.js · +7 -5', 'Deleted a.txt',
  // search
  '# a.rs\n3:fn x\n4-ctx\n5:y', '# a.rs\n3:fn x\n--\n# b.rs\n9:z', 'a.rs:3\nb.rs:2\nc.rs:10', 'a.rs\nb.rs\nc.rs', '(no matches)', '(no fuzzy match for "x")', '0 matches', 'No results',
  'no files found', '(no files found)', '(empty)', 'none', 'src/a.rs\nsrc/b.rs\nsrc/c.rs', 'dir/\nfile.txt\n[truncated]', '… more rows\n[note]\nreal',
  'found 4 callers', '3 references', '12 definitions of Foo', '(no references)', '2 symbols\nA\nB',
  // web
  'HTTP 200 OK\ncontent-length: 12 KB\n\nbody', 'Status: 404 Not Found', 'status 503', '1.5 MB downloaded', '200 OK', '15 bytes · HTTP/1.1 301 Moved', '12 results\n1. foo\n2. bar',
  '1 result', 'First hit about rust\nSecond hit', 'Search failed: network',
  // memory and skills
  'memory text #1\nother text #2', 'one #7', '(no results)', 'Loaded built-in skill: browser', '12 skills\na\nb', 'skill-a\nskill-b\nskill-c', '1 skill',
  // agents and tasks
  'agents: 2\ntasks: 1', 'agents: 0\ntasks: 0', 'agents: 3', 'tasks: 4', '(no agents or tasks)', 'Cancelled', 'cancelled.', 'canceled!', 'background tasks: 3',
  'Job still running; 4 new lines.', 'Job still running; 1 new line', 'Agent result\nstatus: completed\n**Bold** answer here', 'status: done\nThe answer is 42',
  '<final-answer>The final one</final-answer>', '<result>\nInside result\n</result>', 'agent task: a1\nstatus: failed\nmodel: x\n\nWhat went wrong',
  '[status: completed]\n[exit: 0]\nreal answer line', '<status>done</status>\nbody',
  '<task-notification>\n<task-id>T-1</task-id>\n<status>completed</status>\n<summary>Shell task completed (exit 0): npm test</summary>\n</task-notification>',
  '<task-notification>\n<task-id>T-2</task-id>\n<status>failed</status>\n<exit-code>1</exit-code>\n<summary>Shell task failed (exit 1): cargo build</summary>\n<result>\nerror[E0425]: nope\n</result>\n<error>build broke</error>\n</task-notification>',
  '<task-notification>\n<task-id>T-3</task-id>\n<status>cancelled</status>\n<summary>Shell task was cancelled (exit n/a)</summary>\n</task-notification>',
  '<task-notification>\n<task-id>A-1</task-id>\n<tag>helper</tag>\n<status>completed</status>\n<summary>Agent "helper" completed</summary>\n<result>\nstatus: done\n**Summary** of the work\n</result>\n</task-notification>',
  '<task-notification>\n<task-id>A-2</task-id>\n<status>failed</status>\n<summary>Agent "x" failed: bad</summary>\n<error>bad</error>\n</task-notification>',
  '<task-notification>\n<task-id>M-1</task-id>\n<status>completed</status>\n<summary>media task completed</summary>\n<result>\n{"ok":true,"status":"completed"}\n</result>\n</task-notification>',
  '<task-notification>\n<task-id>1</task-id>\n<status>completed</status>\n<summary>x</summary>\n<result>\nopen', '<task-notification>\n</task-notification>',
  // json
  '{"ok":true}', '{"ok":false}', '{"ok":1}', '[1,2,3]', '[]', '{"items":[1,2]}', '{"results":[]}', '{"resources":[1]}', '{"templates":[1,2,3]}', '{"cwd":"/x/y"}',
  '{"status":"running"}', '{"state":"done","message":"m"}', '{"message":"hi there"}', '{"result":"the result"}', '{"error":"bad","detail":"d"}', '{"error":{"message":"m"}}',
  '[{"error":"e"}]', '{"reason":"because"}', '{"status":"failed"}', '{"cause":["a","b"]}', '{"other":1}', '{"ok":true,"status":"completed","job":"j1"}',
  '{"ok":true,"status":"running","job":"j2"}', '{"ok":false,"error":" nope "}', '{"ok":true,"canceled":true}', '{"ok":true,"status":"failed"}', 'null', 'undefined', 'NULL',
  '{bad json', '{', '[', '{"a":', '[[1]]',
  // ask user
  'User replied in chat: "hi there". Extra text', 'User replied in chat: "". x', 'User replied in chat: "a \\"quoted\\" b". x',
  'User has answered your questions: "Q"="A". You can now continue with these answers in mind.', 'User has answered your questions: x', 'plain answer',
  // git
  '## main...origin/main\n M a.rs\n?? b.rs', '## main\nexit 1\nfatal: x', 'exit 2', '## x\nexit 128', 'error: command failed: git push', 'error: bad thing', 'out\nerror: command failed: git x\nmore',
  'On branch main\nnothing to commit', '## main git\n\n', 'diff --git a/x b/x\nexit 3', 'a\nexit 5\n',
  // errors
  'Error: boom', 'error: **bad** `thing`', 'ERROR: shouting', 'Error [code 5]: structured', '[error] bracket', 'ENOENT: no such file or directory', 'path does not exist',
  'symbol "Foo" not found in src', 'EACCES: permission denied, ENOENT', 'Request failed with status 500', 'exit code 2', 'timed out after 5s', 'the call failed hard',
  'line one\nconnection refused by host\nline three', 'trace\n  at a\n  at b', 'Cannot read property', '(no symbol matches foo)', '(no lines in range',
  // markdown and prose
  '# Title\nbody text', '> quote line', '- bullet', '1. numbered', '**bold** and *italic* and `code` and __under__', '  ## indented heading', '***', 'a * b * c',
  // unicode and size
  'é'.repeat(300), '😀'.repeat(100), `${'long line '.repeat(30)}end`, big(250), big(6000), 'line\n'.repeat(500), `[status: done]\n${big(5000)}`, 'wide — path — x', 'a — b', ' padded ',
];
const argsList = [
  {}, { output_mode: 'count' }, { mode: 'files' }, { mode: 'files_with_matches' }, { dry_run: true }, { path: 'src/a.rs' }, { name: 'browser' },
  { skill: 'sk', action: 'status' }, { action: 'cancel' }, { action: 'status' }, '{"output_mode":"count"}', { action: 'spawn', prompt: 'go   do it' }, { file: 'f.txt', dry_run: false },
  { input: { name: 'inner' } }, null, 'not json',
];
const NAME_ARGS = {
  read: [0], view_image: [0], read_mcp_resource: [0], apply_patch: [0, 4, 5, 12], grep: [0, 1, 2, 3, 10], media: [0, 8, 9], glob: [0], find: [0], list: [0], ls: [0],
  shell: [0], bash: [0], bash_session: [0], shell_command: [0], job_wait: [0], git: [0], code_graph: [0], web_fetch: [0], fetch: [0], web_search: [0], search_query: [0],
  image_query: [0], web_search_call: [0], recall: [0], search_memories: [0], memory: [0], remember: [0], save_memory: [0], update_memory: [0], request_user_input: [0],
  update_plan: [0], cwd: [0], session: [0], list_mcp_resources: [0], list_mcp_resource_templates: [0], skill: [0, 6, 13], skill_execute: [0, 6], skill_view: [0, 6],
  skills_list: [0, 6], use_skill: [0, 6], agent: [0, 8, 9, 11], task: [0, 8, 9, 11], ask_user: [0], handoff_user: [0], mystery: [0], '': [0],
  'functions.read': [0], 'mcp__srv__do': [0], 'mcp__plugin_mixdog_mixdog__shell': [0], 'Read': [0], 'tool_search': [0],
};
const SURFACE_NAMES = ['agent', 'task', 'mystery', 'read'];

// The result texts of the row-bearing fixtures.
const FIXTURES = ['session-state/stream.json', 'stale-rows-cases/golden.json', 'trace-rows-cases/golden.json', 'ladder-rows/golden.json'];
const fromFixtures = new Set();
for (const file of FIXTURES) {
  const path = join(fixturesDir, file);
  if (!existsSync(path)) throw new Error(`fixture ${path} is missing (pass --fixtures)`);
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === 'string' && /^(?:result|output|text|content|error|message|body|summary|rawResult)$/i.test(key) && inner.length < 4000) fromFixtures.add(inner);
      walk(inner);
    }
  };
  walk(JSON.parse(readFileSync(path, 'utf8')));
}
// A spread of the fixture texts, deterministic: shortest first, every k-th, at most 140.
const fixtureTexts = [...fromFixtures].filter((t) => !TEXTS.includes(t)).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
const stride = Math.max(1, Math.ceil(fixtureTexts.length / 140));
const picked = fixtureTexts.filter((_, i) => i % stride === 0);
const texts = [...TEXTS, ...picked];
const textIndex = new Map(texts.map((t, i) => [t, i]));

// ── Summaries ───────────────────────────────────────────────────────────────

const summaries = [];
// Every text goes through the tools with a summariser of their own; the aliases of those get every fifth text.
const CORE_NAMES = new Set(['read', 'apply_patch', 'grep', 'shell', 'git', 'code_graph', 'fetch', 'web_search', 'recall', 'skill', 'skills_list', 'agent', 'task', 'ask_user', 'media', 'glob', 'session', 'mystery']);
for (const [name, argIdxs] of Object.entries(NAME_ARGS)) {
  for (const a of argIdxs) {
    texts.forEach((text, t) => {
      if (!CORE_NAMES.has(name) && t % 5 !== 0) return;
      if (CORE_NAMES.has(name) && a !== 0 && t % 2 !== 0) return;
      const plainOut = run(summaryMods, 'summarizeToolResult', name, argsList[a], text);
      const translated = run(summaryMods, 'summarizeToolResult', name, argsList[a], text, false, catalog);
      summaries.push([name, a, t, plainOut, run(summaryMods, 'summarizeToolResult', name, argsList[a], text, true), JSON.stringify(translated) === JSON.stringify(plainOut) ? 1 : translated]);
    });
  }
}

const briefs = [];
for (const name of SURFACE_NAMES) {
  for (const a of [0, 8, 11, 14, 15]) {
    texts.forEach((text, t) => {
      if (t % 2 !== 0 && t < TEXTS.length) return;
      const row = [name, a, t];
      for (const options of [{}, { isError: true }, { isResponse: true }, { isError: true, isResponse: true }]) {
        row.push(run(summaryMods, 'summarizeAgentSurfaceBrief', name, argsList[a], text, options));
      }
      briefs.push(row);
    });
  }
}

const textProbes = texts.map((text) => ({
  extractErrorCause: run(summaryMods, 'extractErrorCause', text),
  parseLineDelta: run(summaryMods, 'parseLineDelta', text),
  parseUpdateSummary: run(summaryMods, 'parseUpdateSummary', text),
  finalAnswer: run(summaryMods, 'textBetweenTag', text, 'final-answer'),
  result: run(summaryMods, 'textBetweenTag', text, 'result'),
  stripShellExitHeader: run(textMods, 'stripShellExitHeader', text),
  shellCommandExitCode: run(statusMods, 'shellCommandExitCode', text),
  isShellFailureResult: run(classMods, 'isShellFailureResult', text),
  readRowsForModel: run(rowsMods, 'readRowsForModel', text),
  readRowsForDisplay: run(rowsMods, 'readRowsForDisplay', text),
  readSourceWindow: run(rowsMods, 'readSourceWindow', text),
}));
const DELTAS = [
  '', '+3', '-2', '+3 -1', '+3 lines', '+1 line · -2 lines', '+3 / -1', '+3/-1', '(+3 -1)', 'a, +2, b', 'report-20260920.md', '+3 -1 extra', '+ 3', '+3 lines -2 line', '+3\n-4',
  '+0 -0', '+99999999999999999999', 'x · +1 · +2',
];
const deltas = DELTAS.map((text) => {
  const parsed = run(summaryMods, 'parseLineDelta', text);
  return { text, parsed, formatted: run(summaryMods, 'formatLineDelta', parsed) };
});
const formatCases = [null, {}, { seen: true, added: 2, removed: 0 }, { seen: true, added: 1, removed: 1 }, { seen: false, added: 5 }, { seen: true, added: 0, removed: 0 }, { seen: true, added: '3', removed: 'x' }, { seen: true, added: NaN, removed: 4 }]
  .map((totals) => ({ totals: plain(totals), formatted: run(summaryMods, 'formatLineDelta', totals) }));
const tagCases = [
  ['<a>x</a>', 'a'], ['<a href="q">  y  </a>', 'a'], ['<A>z</a>', 'a'], ['<a>1</a><a>2</a>', 'a'], ['<a>\nmulti\nline\n</a>', 'a'], ['<a>open', 'a'], ['plain', 'a'],
  ['<final-answer>A</final-answer>', 'final-answer'], ['<result>R</result>', 'result'], ['<x.y>d</x.y>', 'x.y'], ['', 'a'],
].map(([text, tag]) => ({ text, tag, found: run(summaryMods, 'textBetweenTag', text, tag) }));

// ── Classification ──────────────────────────────────────────────────────────

const CLASS_TOOLS = ['', 'read', 'grep', 'shell', 'glob', 'list', 'code_graph', 'Find', 'READ', 'functions.read'];
const classification = [];
texts.forEach((text, t) => {
  for (const tool of CLASS_TOOLS) {
    classification.push([
      t,
      tool,
      run(classMods, 'classifyResultKind', text, false, tool),
      run(classMods, 'isReadOnlyNavigationMiss', tool, text),
    ]);
  }
  classification.push([t, 'read', run(classMods, 'classifyResultKind', text, true, 'read'), null]);
});

// ── Result text ─────────────────────────────────────────────────────────────

const deepNest = (n, leaf) => (n === 0 ? leaf : [deepNest(n - 1, leaf)]);
const CONTENTS = [
  null, '', 'plain', 5, true, false, [], {}, [null], ['a', 'b'], ['a', '', 'b'], [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
  [{ type: 'output_text', text: 'o' }, { type: 'input_text', text: 'i' }], [{ type: 'text' }, { type: 'text', text: null }, { type: 'text', text: 7 }, { type: 'text', text: ['x', 'y'] }],
  [{ type: 'image', mimeType: 'image/png' }, { type: 'input_image', mediaType: 'image/jpeg' }, { type: 'image', source: { media_type: 'image/gif' } }, { type: 'image' }],
  [{ source: { type: 'base64', data: 'AAAA', media_type: 'image/webp' } }, { source: { type: 'base64', data: 'AAAA', mediaType: 'm' } }, { source: { type: 'base64', data: 'AAAA' } }, { source: { type: 'base64', data: '' } }],
  { content: [{ type: 'text', text: 'nested' }] }, { content: [] }, { content: [{}] }, { content: { type: 'text', text: 'obj' } }, { content: { x: 1 } }, { content: 'str' }, { content: 5 },
  { parts: [{ type: 'text', text: 'p1' }, 'p2'] }, { parts: [] }, { type: 'tool_result', content: 'inner' }, { type: 'tool_result', content: [{ type: 'text', text: 'ti' }] },
  { type: 'tool_result', content: { type: 'text', text: 'to' } }, { type: 'tool_result', content: null }, { type: 'tool_result' }, { type: 'tool_result', content: [] },
  [{ type: 'tool_result', content: 'in-array' }, { type: 'tool_result', content: [{ type: 'text', text: 'deep' }] }], { text: 't' }, { text: '' }, { text: 5 }, { output: 'out' },
  { message: 'msg' }, { output: '', message: 'm2' }, { text: '', output: '', message: '', content: '' }, { a: 1, b: [1, 2] }, { type: 'weird', k: 'v' },
  { k: big(600) }, { k: big(470) }, { k: 'é'.repeat(300) }, [{ k: big(600) }], deepNest(14, { type: 'text', text: 'deep' }), deepNest(12, { type: 'text', text: 'edge' }),
  deepNest(13, 'str'), { content: deepNest(13, 'str') }, [[['a'], 'b'], 'c'], [{ content: [{ content: [{ text: 'x' }] }] }], [5, true, null, 'k'], { type: 'text', text: 'top text' },
  { type: 'image', mimeType: 'image/png' }, { type: 'text', content: 'alt' }, { text: 'a', content: [{ type: 'text', text: 'b' }] }, { content: [], text: 'fallback' },
  { content: '', text: 'x' }, { type: 'tool_result', text: 'x' }, { source: { type: 'url' }, k: 1 },
];
const resultText = CONTENTS.map((content) => ({ content: plain(content), text: run(textMods, 'toolResultText', content) }));
const fallbackTexts = ['', ' ', 'detail', '\n\n  first line  \nsecond', big(100), '😀'.repeat(60), 'é'.repeat(81), 'x'.repeat(80), 'x'.repeat(81)];
const fallbacks = [];
for (const a of fallbackTexts) {
  for (const b of fallbackTexts) {
    fallbacks.push({ detail: a, raw: b, aggregate: run(textMods, 'toolAggregateDetailFallback', a, b), grouped: run(textMods, 'toolGroupedDisplayFallback', a, b, 'raw text') });
    fallbacks.push({ result: a, text: b, grouped3: run(textMods, 'toolGroupedDisplayFallback', a, b, fallbackTexts[2]) });
  }
}
const errorDisplays = [];
for (const surfaceName of ['tool', 'shell', 'web_search', 'agent']) {
  texts.forEach((text, t) => {
    if (t % 3 !== 0 && t < TEXTS.length) return;
    const presented = settle(() => errMods[0].module.presentErrorText(text, { surface: surfaceName }));
    errorDisplays.push([t, surfaceName, presented, run(textMods, 'toolErrorDisplay', text, surfaceName)]);
  });
}

// ── Call outcomes and aggregates ────────────────────────────────────────────

const MESSAGES = [{}, { name: 'shell' }, { name: 'shell', isError: true }, { name: 'git' }, { toolName: 'read', isError: true }, { name: 'grep', toolKind: 'error' }, { name: 'functions.git', isError: true },
  { toolName: 'git', name: 'shell' }, { name: 'bash', isError: 'yes' }, { name: 'list', toolKind: 'ok' }];
const outcomes = [];
texts.forEach((text, t) => {
  if (t % 2 !== 0 && t < TEXTS.length) return;
  MESSAGES.forEach((message, m) => outcomes.push([m, t, run(statusMods, 'toolCallOutcome', message, text)]));
});
const displays = [];
const DISPLAY_NAMES = ['', 'shell', 'read', 'git'];
texts.forEach((text, t) => {
  if (t % 2 !== 0 && t < TEXTS.length) return;
  [0, 2, 3, 4].forEach((m) => {
    DISPLAY_NAMES.forEach((tool) => {
      const presented = settle(() => errMods[0].module.presentErrorText(text, { surface: tool || 'tool' }));
      displays.push([m, t, tool, presented, run(statusMods, 'toolResultDisplay', MESSAGES[m], text, tool)]);
    });
  });
});
const failureDetails = [];
for (const succeeded of [undefined, 0, 1, 3]) {
  for (const realErrors of [undefined, 0, 1, 2]) {
    for (const exitErrors of [undefined, 0, 1, 2]) {
      for (const exitCode of [undefined, null, 0, 1, 127, -1, '5', NaN]) {
        failureDetails.push({ args: plain({ succeeded, realErrors, exitErrors, exitCode: exitCode === undefined ? null : exitCode }), hasCode: exitCode !== undefined, nan: Number.isNaN(exitCode), text: run(statusMods, 'failureDetailText', { succeeded, realErrors, exitErrors, exitCode }) });
      }
    }
  }
}
const ITEMS = [{}, { result: '' }, { result: 'Cancelled' }, { text: 'status: done' }, { args: { status: 'failed' } }, { args: { status: 'weird' } }, { rawResult: 'status: done' }, { result: '[status: cancelled]' }, { result: 'running\n[status: completed]' }, null];
const markers = [];
texts.forEach((text, t) => {
  if (t % 2 !== 0 && t < TEXTS.length) return;
  ITEMS.forEach((item, i) => markers.push([t, i, run(statusMods, 'withCancelledResultMarker', text, item)]));
});

const callRecords = [
  [],
  [{ name: 'grep', resolved: true, rawResultText: 'a.rs:3\n\n', resultText: 'x' }, { name: 'read', resolved: false, rawResultText: 'no' }, { category: 'Read', resolved: true, resultText: 'b  ' }, { resolved: true, name: ' ', resultText: 'c' }],
  [{ resolved: true, rawResultText: '   ', name: 'empty' }, null, undefined, 0, { resolved: 'true', rawResultText: 'str' }, { resolved: true, rawResultText: null, resultText: 'fallback' }, { resolved: true, rawResultText: 5 }],
  Array.from({ length: 40 }, (_, i) => ({ name: i % 2 ? 'read' : 'grep', resolved: true, rawResultText: `out ${i}\n`, resultText: `short ${i}` })),
  [{ callId: 'c1', name: 'read', args: { path: 'a' }, resultText: 'r', rawResultText: 'raw', resolved: true, isError: true, uiDiff: 'd', startedAt: 5, completedAt: 9 },
    { callId: 0, name: '', args: null, completedEarly: true, isCallError: true, isExitError: true, uiDiff: 7, startedAt: '12', completedAt: -1 },
    { name: 'shell', resolved: false }, null, [], 'text', { callId: null, name: 0, resultText: null, startedAt: 'abc' }, { uiDiff: '' }],
  Array.from({ length: 17 }, (_, i) => ({ name: 'read', args: { path: `f${i}` }, resolved: i % 2 === 0, resultText: `${i} lines` })),
];
const aggregateRaw = callRecords.map((calls) => ({ calls: plain(calls), raw: run(statusMods, 'aggregateRawResult', calls), steps: run(statusMods, 'aggregateRawResultSteps', calls), members: run(statusMods, 'aggregateToolMembers', calls), memberSteps: run(statusMods, 'aggregateToolMembersSteps', calls) }));
const BUCKETS = [['Read', {}], ['Search', {}], ['Agent', {}], ['Agent', { agentBatch: 'b1' }], ['Agent', { agentBatch: '' }], ['Shell', {}], [' Patch ', {}], ['', {}], [null, {}], [undefined, {}], [0, {}], ['Read+Search', {}]];
const buckets = BUCKETS.map(([category, options]) => ({ category: plain(category), hasCategory: category !== undefined, options, bucket: run(statusMods, 'aggregateBucketForCategory', category, options) }));
const entry = (key, count, extra = {}) => ({ key, category: 'Read', active: 'Reading', done: 'Read', noun: 'file', pluralNoun: 'files', effect: false, count, ...extra });
const MERGES = [
  [[entry('a', 2), entry('b', 0)], [entry('a', 3)]],
  [[entry('x', undefined)], [entry('x', undefined), entry('x', 4, { effect: true })]],
  [[], [entry('k', 1)]],
  [[entry('p', 1, { category: 'Patch' }), entry('q', 2)], [entry('q', NaN), entry('p', 0)], [entry('r', '3')]],
];
const merges = MERGES.map((batches) => {
  const outputs = [statusMods].map((mods) =>
    mods.map(({ module }) =>
      settle(() => {
        const aggregate = { categories: new Map(), categoryOrder: [] };
        for (const batch of structuredClone(batches)) module.mergeAggregateCategoryEntries(aggregate, batch);
        return { order: aggregate.categoryOrder, entries: [...aggregate.categories.values()] };
      })
    )
  )[0];
  if (outputs.length > 1 && JSON.stringify(outputs[0]) !== JSON.stringify(outputs[1])) disagreements.push({ name: 'mergeAggregateCategoryEntries', outputs });
  return { batches: plain(batches.map((batch) => batch.map((e) => ({ ...e, count: Number.isNaN(e.count) ? 'NaN' : e.count })))), merged: outputs[0] };
});
const uiDiffs = [undefined, null, {}, { uiDiff: 'd' }, { uiDiff: '' }, { uiDiff: 5 }, { uiDiff: null }, { uiDiff: ['a'] }, 'str', 7, []].map((source) => ({
  source: plain(source),
  hasSource: source !== undefined,
  from: run(statusMods, 'uiDiffFromMessage', source),
  patch: run(statusMods, 'uiDiffPatchFromMessage', source),
  stringPatch: run(statusMods, 'stringUiDiffPatch', source),
}));
const loadCalls = (names) => ({ name: 'load_tool', args: { names } });
const LOADING = [
  [], [loadCalls(['a', 'b'])], [loadCalls(['a', 'b']), loadCalls(['b', 'c'])], [loadCalls(['a']), { name: 'read', args: {} }], [{ name: 'skill', args: { name: 'sk' } }, { name: 'skill', args: { skill: 'sk' } }],
  [loadCalls(['select:mcp__s__t', 'x']), loadCalls([])], Array.from({ length: 33 }, (_, i) => loadCalls([`t${i % 5}`])), [{ name: 'tool_search', args: { names: 'one, two' } }],
];
const loading = LOADING.map((calls) => ({ calls: plain(calls), targets: run(statusMods, 'aggregateLoadingTargets', calls), steps: run(statusMods, 'aggregateLoadingTargetsSteps', calls) }));

const PATCH_CASES = [
  { calls: [{ name: 'read', summary: '3 lines', summarySeq: 2 }, { name: 'read', summary: '4 lines', summarySeq: 1 }], all: null, done: 2 },
  { calls: [{ summary: 'Updated a.rs · +3 -1' }, { summary: 'Updated b.rs · +1 -0' }, { summary: '' }, { summary: 'Exit 0' }], all: null, done: 4 },
  { calls: [{ summary: 'x' }], all: [{ isError: true, isCallError: true }, { isExitError: true, exitCode: 3 }, { name: 'read' }], done: 3 },
  { calls: [], all: [{ isError: true }, { isError: true, isCallError: true }], done: 2 },
  { calls: [], all: [{ isExitError: true, exitCode: 2 }], done: 1 },
  { calls: [], all: [{ isExitError: true, exitCode: 2 }, { isExitError: true, exitCode: 5 }, {}], done: 3 },
  { calls: [], all: [{ isExitError: true }], done: 0 },
  { calls: Array.from({ length: 50 }, (_, i) => ({ name: 'read', summary: `${i} lines`, summarySeq: (i * 7) % 50 })), all: null, done: 50 },
  { calls: Array.from({ length: 35 }, (_, i) => ({ name: 'grep', summary: `${i + 1} matches` })), all: null, done: 35 },
  { calls: [{ summary: 'a', summarySeq: 'x' }, { summary: 'b' }, { summary: 'c', summarySeq: null }, { summary: 'd', summarySeq: -1 }], all: null, done: 4 },
  { calls: [{ summary: 0 }, { summary: 5 }, { summary: ['q'] }], all: null, done: 3 },
  { calls: [{ summary: 'z' }], all: [{ isError: 1 }, { isError: 'x', isCallError: [] }, { isExitError: 1, exitCode: '7' }], done: 3 },
];
const patches = PATCH_CASES.map((c) => {
  const all = c.all ?? c.calls;
  const outputs = statusMods.map(({ module }) =>
    settle(() => drain(module.aggregateResultPatchSteps({ calls: new Map(structuredClone(c.calls).map((r, i) => [i, r])) }, structuredClone(all), c.done)))
  );
  const sync = statusMods.map(({ module }) => settle(() => module.aggregateResultPatch({ calls: new Map(structuredClone(c.calls).map((r, i) => [i, r])) }, structuredClone(all), c.done)));
  for (let i = 1; i < outputs.length; i += 1) if (JSON.stringify(outputs[i]) !== JSON.stringify(outputs[0]) || JSON.stringify(sync[i]) !== JSON.stringify(sync[0])) disagreements.push({ name: 'aggregateResultPatch', case: JSON.stringify(c).slice(0, 200) });
  return { calls: plain(c.calls), all: plain(all), done: c.done, steps: outputs[0], sync: sync[0] };
});

// The merge of per-call summaries: hand lists, and the summaries the run above produced in groups.
const SUMMARY_LISTS = [
  [], [''], ['3 lines', 'Read 4 lines', 'image', 'Read image', '1 match', '48 matches', 'Found 2 matches'], ['2 entries', '1 entry', '5 candidates', '1 candidate', '3 files', '1 file'],
  ['+3 -1', 'Updated +2 -0', 'Updated - +1 -1'], ['Updated a.rs · +3 -1', 'Updated b.rs · +1 -0', 'Created c.rs', 'Deleted d.rs'], ['Updated a.rs', 'Created b.rs'], ['Deleted a.rs'],
  ['Checked a.rs · +7 -5'], ['Checked a.rs · +7 -5', 'Updated b.rs · +1 -0'], ['Checked a.rs', 'Checked b.rs · +1 -1', 'Checked c.rs · +2 -2'], ['Updated 3 Files · +9 -0', 'Updated d.rs · +1'],
  ['Created 2 Files', 'Updated 1 File'], ['Exit 1', '', '5 lines', 'Exit 1', 'other'], ['  spaced  ', 'spaced'], ['2 Memories', '1 Memory', 'No Results'], ['3 skills', '1 skill', '12 boxes', '1 box', '4 churches'],
  ['7 queries', '1 query', '2 classes', '1 class', '3 buzzes', '1 buzz', '5 dishes', '1 dish'], ['Found 12 results', '1 result'], Array.from({ length: 40 }, (_, i) => `extra ${i}`),
  Array.from({ length: 33 }, (_, i) => `${i + 1} lines`), [null, undefined, 0, 'ok', false, 'ok'],
  ['Updated a.rs · +3 -1', 'Updated a.rs · +2', 'Checked a.rs'], ['Updated report-20260920.md', 'Updated x.rs · +1 line · -2 lines'], ['+3 lines', '-2 lines'],
];
const groups = [];
const summaryOutputs = summaries.filter((row) => typeof row[3] === 'string');
for (let i = 0; i < summaryOutputs.length; i += 97) groups.push(summaryOutputs.slice(i, i + 5).map((row) => row[3]));
for (let i = 0; i < summaryOutputs.length; i += 811) groups.push(summaryOutputs.slice(i, i + 37).map((row) => row[3]));
const details = [...SUMMARY_LISTS, ...groups].map((list) => ({ summaries: plain(list), steps: run(surfaceMods, 'formatAggregateDetailSteps', list), sync: run(surfaceMods, 'formatAggregateDetail', list) }));

// ── Read rows ───────────────────────────────────────────────────────────────

const ROW_TEXTS = [
  '1→a\n2→b\n3→c', '1→a\n3→b', '5→x\n6→y\n9→z\n10→w', '1→a\n[lines 1-1]', '1→a\n2→b\n[lines 1-2]\ntail', '1→a\n2→b\n[lines 1-3]', 'no rows →', '→x', '1→', '0→zero\n1→one', '1→é\n2→😀',
  '[lines 1-2]\na\nb', '[lines 1-2]\na', '[lines 2-1]\na', '[lines 0-0]\na', '[lines 1-1]\na\n[lines 5-6]\nb\nc', '[lines 1-2]\n[lines 3-4]\nx\ny', '[lines 1-3]\na\nb\nc\n[lines 1-3 of 20; offset:4 for more]',
  '[lines 1-3]\na\nb\nc\n[lines 1-3 of 3]', '[lines 1-3]\na\nb\nc\n[lines 1-4 of 20]', '[lines 1-3]\na\nb\nc\n[lines 1-3 of 2]', '[lines 1-3]\na\nb\nc\n[lines 1-3 of 9]\nextra', '[lines 1-2]\n1→x\n2→y',
  '[lines 99999999999999999999-100000000000000000001]\na\nb\nc', '[lines 1-2]\na\nb\n[lines 1-2 of 2][lines 1-2 of 2]', '[lines 3-4]\nx\ny\n[lines 3-4 of 9; offset:5 for more]',
  '(no lines in range; file has 0 lines)', '(no lines in range; file has 12 lines)', '(no lines in range; file has x lines)', '(no lines in range; file has 3 lines) ',
  '<system-reminder>File exists but has empty contents: a.txt</system-reminder>', '<system-reminder>File exists but has empty contents: </system-reminder>', '<system-reminder>File exists but has empty contents: a\nb</system-reminder>',
  '[lines 1-2]\r\na\r\nb', '[lines 1-2]\na\n\nb', '',
];
const readRows = ROW_TEXTS.map((text) => ({
  text,
  model: run(rowsMods, 'readRowsForModel', text),
  display: run(rowsMods, 'readRowsForDisplay', text),
  window: run(rowsMods, 'readSourceWindow', text),
  roundTrip: run(rowsMods, 'readRowsForDisplay', run(rowsMods, 'readRowsForModel', text)),
}));

// ── The Rust catalog keys ───────────────────────────────────────────────────

const golden = {
  note: 'Recorded by tests/recorders/record-results.mjs from the Node tool result modules; tests/results_twin.rs replays it.',
  step: surface.STEP,
  uiKeys: plain(summaryMods[0].module.TOOL_RESULT_UI_KEYS),
  memorySurface: ['Memory', 'memory', '', 'Memories'].map((label) => ({ label, is: run(summaryMods, 'isMemorySurface', label) })),
  readLineNoSep: rowsMods[0].module.READ_LINE_NO_SEP,
  texts,
  fixtureTexts: picked.length,
  argsList,
  summaries,
  briefs,
  textProbes,
  deltas,
  formatCases,
  tagCases,
  classification,
  resultText,
  fallbacks,
  errorDisplays,
  messages: plain(MESSAGES),
  items: plain(ITEMS),
  outcomes,
  displays,
  failureDetails,
  markers,
  aggregateRaw,
  buckets,
  merges,
  uiDiffs,
  loading,
  patches,
  details,
  readRows,
};

// An output Node recorded as an exception is `{ threw }`; the twin skips it: the Rust port answers where Node crashes.
let threw = 0;
const scan = (value) => {
  if (Array.isArray(value)) return value.forEach(scan);
  if (!value || typeof value !== 'object') return;
  if (typeof value.threw === 'string') threw += 1;
  for (const inner of Object.values(value)) scan(inner);
};
scan(golden);
if (threw) console.error(`${threw} recorded output(s) are Node exceptions`);
if (disagreements.length) {
  console.error(`${disagreements.length} case(s) where the Node copies disagree (first 5 below); nothing was recorded`);
  for (const one of disagreements.slice(0, 5)) console.error(JSON.stringify(one).slice(0, 600));
  process.exit(2);
}

const text = `${JSON.stringify(golden)}\n`;
if (checkPath) {
  const recorded = readFileSync(resolve(checkPath), 'utf8');
  if (recorded !== text) {
    console.error(`${checkPath} differs from what the Node code records now`);
    process.exit(1);
  }
  console.log(`${checkPath} matches (${summaries.length} summaries, ${texts.length} texts)`);
} else {
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath} (${summaries.length} summaries, ${texts.length} texts, ${picked.length} fixture texts, ${text.length} bytes)`);
}
