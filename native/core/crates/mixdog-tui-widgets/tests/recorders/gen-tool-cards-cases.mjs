// Writes tests/cases/tool_cards.json: the corpus of the tool cards. One frame case per tool surface and state, collapsed and
// expanded, at the widths 40, 80 and 120, and the cases of the expanded-body functions. The cases are generated, not typed,
// so a width or a state is one more loop turn rather than one more block of JSON.
//
//   node gen-tool-cards-cases.mjs > ../cases/tool_cards.json

const cases = [];
const WIDTHS = [40, 80, 120];
const NOW = 20000;
const frame = (id, columns, props, extra = {}) => cases.push({ id, kind: 'frame', columns, now: NOW, props, ...extra });
const fn = (id, name, args, env) => cases.push({ id, kind: 'fn', name, args, ...(env ? { env } : {}) });

const ESC = '\u001b';
const diff = [
  'diff --git a/src/a.js b/src/a.js',
  'index 1111111..2222222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export { a, b };',
].join('\n');
const readBody = ['1→import fs from "node:fs";', '2→', '3→export function load(path) {', '4→  return fs.readFileSync(path, "utf8");', '5→}'].join('\n');
const grepBody = ['src/a.js:3:export function load(path) {', 'src/b.js:12:  return load(path);', 'C:\\work\\repo\\c.js:7:load(x)'].join('\n');
const jsonBody = JSON.stringify({ name: 'mixdog', items: [1, 2, 3], nested: { ok: true, link: 'https://example.com/a?b=1' } });
const markdownBody = ['# Title', '', 'Some **bold** text and `code`.', '', '- one', '- two', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
const longLine = `1→${'word '.repeat(60)}`;
const shellBody = `[exit code: 0]\nfirst line\n${ESC}[31mred${ESC}[0m line\n${ESC}[4munderlined${ESC}[24m https://example.com/x\nlast\tline`;

const tools = {
  bash: { name: 'bash', args: { command: 'ls -la && echo done' }, result: shellBody },
  read: { name: 'read', args: { path: 'src/load.js' }, result: readBody },
  grep: { name: 'grep', args: { pattern: 'load', path: 'src' }, result: grepBody },
  glob: { name: 'glob', args: { pattern: '**/*.js' }, result: 'src/a.js\nsrc/b.js\nsrc/c.js' },
  edit: { name: 'edit', args: { path: 'src/a.js', old_string: 'b = 2', new_string: 'b = 3' }, result: 'Edited src/a.js (+2 Lines, -1 Lines)', uiDiff: diff, rawResult: diff },
  write: { name: 'write', args: { path: 'out.txt', content: 'hello' }, result: 'Wrote out.txt (+1 Line)' },
  apply_patch: { name: 'apply_patch', args: { patch: '*** Begin Patch\n*** End Patch' }, result: 'Applied patch to src/a.js (+2 Lines, -1 Lines)', rawResult: diff },
  web_fetch: { name: 'web_fetch', args: { url: 'https://example.com/page' }, result: 'Fetched https://example.com/page\n\nExample Domain\nThis domain is for use in illustrative examples.' },
  web_search: { name: 'web_search', args: { query: 'mixdog terminal ui' }, result: '1. Result one https://a.example/1\n2. Result two https://b.example/2' },
  mcp: { name: 'mcp__files__list_dir', args: { path: '/tmp' }, result: jsonBody },
  agent_spawn: { name: 'agent', args: { type: 'spawn', agent: 'worker', prompt: 'do the thing' } },
  agent_result: { name: 'agent', args: { type: 'result', agent: 'worker', status: 'completed' }, result: 'summary alpha\nsummary beta', rawResult: 'raw alpha\nraw beta' },
  skill: { name: 'skill', args: { name: 'review' }, result: 'Loaded skill review' },
  load_tool: { name: 'load_tool', args: { names: ['bash'] }, result: 'Loaded bash\nsecond' },
  custom: { name: 'custom', result: 'one\ntwo\nthree' },
  markdown: { name: 'custom_notes', args: {}, result: markdownBody },
  longline: { name: 'read', args: { path: 'src/long.js' }, result: longLine },
};

// Every surface, collapsed and expanded, done, at every width.
for (const [key, base] of Object.entries(tools)) {
  for (const width of WIDTHS) {
    frame(`${key}-done-w${width}`, width, { ...base, startedAt: 1000, completedAt: 3500 });
    frame(`${key}-expanded-w${width}`, width, { ...base, startedAt: 1000, completedAt: 3500, expanded: true });
  }
}

// States of one shell and one read card.
for (const width of WIDTHS) {
  const bash = tools.bash;
  frame(`bash-pending-old-w${width}`, width, { name: bash.name, args: bash.args, startedAt: 17000, completedCount: 0 });
  frame(`bash-pending-blink-off-w${width}`, width, { name: bash.name, args: bash.args, startedAt: 17000, completedCount: 0 }, { now: 20600 });
  frame(`bash-pending-fresh-w${width}`, width, { name: bash.name, args: bash.args, startedAt: 19800, completedCount: 0 });
  frame(`bash-pending-fresh-attached-w${width}`, width, { name: bash.name, args: bash.args, startedAt: 19800, completedCount: 0, attached: true });
  frame(`bash-deferred-ready-w${width}`, width, { name: bash.name, args: bash.args, startedAt: 19800, completedCount: 0, deferredDisplayReady: true });
  frame(`bash-exit-error-w${width}`, width, { name: bash.name, args: bash.args, result: '[exit code: 2]\nboom\nmore', exitErrorCount: 1, startedAt: 1000, completedAt: 2000 });
  frame(`bash-exit-error-expanded-w${width}`, width, { name: bash.name, args: bash.args, result: '[exit code: 2]\nboom\nmore', exitErrorCount: 1, expanded: true, startedAt: 1000, completedAt: 2000 });
  frame(`bash-failed-call-w${width}`, width, { name: bash.name, args: bash.args, result: 'Error: spawn failed', isError: true, callErrorCount: 1, errorCount: 1 });
  frame(`bash-cancelled-w${width}`, width, { name: bash.name, args: bash.args, result: '[status: cancelled]\npartial output', startedAt: 1000, completedAt: 2000 });
  frame(`read-error-w${width}`, width, { name: 'read', args: { path: 'missing.js' }, result: 'Error: ENOENT: no such file', isError: true, callErrorCount: 1, errorCount: 1 });
  frame(`read-attached-w${width}`, width, { ...tools.read, attached: true });
  frame(`read-not-finalized-w${width}`, width, { ...tools.read, headerFinalized: false });
  frame(`hook-denied-w${width}`, width, { name: 'bash', args: { command: 'rm -rf x' }, result: 'Error: tool "bash" denied by hook: nope', isError: true, callErrorCount: 1, errorCount: 1 });
  frame(`apply-patch-partial-w${width}`, width, { name: 'apply_patch', args: { patch: 'x' }, result: 'Error: section 2 failed', isError: true, callErrorCount: 1, errorCount: 1, uiDiff: diff });
  frame(`raw-only-expanded-w${width}`, width, { name: 'custom', completedCount: 1, rawResult: 'raw alpha\nraw beta', expanded: true });
}

// Group cards.
for (const width of WIDTHS) {
  const group = { aggregate: true, categories: { read: 2, search: 1 }, count: 3, startedAt: 1000 };
  frame(`group-pending-w${width}`, width, { ...group, completedCount: 0 });
  frame(`group-partial-w${width}`, width, { ...group, completedCount: 1, result: 'one done' });
  frame(`group-done-w${width}`, width, { ...group, completedCount: 3, completedAt: 4000 });
  frame(`group-summary-w${width}`, width, { ...group, completedCount: 3, result: 'summary alpha\nsummary beta', rawResult: 'raw alpha\nraw beta' });
  frame(`group-expanded-w${width}`, width, { ...group, completedCount: 3, result: 'summary alpha\nsummary beta', rawResult: 'raw alpha\nraw beta', expanded: true });
  frame(`group-failed-w${width}`, width, { aggregate: true, categories: { edit: 2 }, doneCategories: { edit: 0 }, count: 2, completedCount: 2, isError: true, errorCount: 2, callErrorCount: 2, result: 'Error: both failed' });
  frame(`group-cancelled-w${width}`, width, { ...group, completedCount: 3, result: '[status: cancelled]\nstopped' });
  frame(`group-not-finalized-w${width}`, width, { ...group, completedCount: 3, headerFinalized: false });
  frame(`group-order-w${width}`, width, { ...group, completedCount: 3, args: { categoryOrder: ['search', 'read'] } });
}

// Themes.
for (const theme of ['light', 'dracula']) {
  frame(`theme-${theme}-edit`, 80, { ...tools.edit, expanded: true }, { theme });
  frame(`theme-${theme}-bash`, 80, { ...tools.bash, expanded: true }, { theme });
}

// The expanded-body functions.
const bodies = {
  shell: [shellBody, '', true],
  read: [readBody, 'src/load.js', false],
  readRust: [readBody.replaceAll('"', "'"), 'src/lib.rs', false],
  grep: [grepBody, 'src/a.js', false],
  diff: [diff, '', false],
  json: [jsonBody, '', false],
  jsonPretty: ['{"a":1,"b":[1,2]}\n[1,2,3]\nplain', '', false],
  bigint: ['{"a":12345678901234567890}', '', false],
  markdown: [markdownBody, '', false],
  mdPath: ['plain text without syntax', 'notes.md', false],
  link: ['see https://example.com/a and (https://b.example/x) end', '', false],
  tabs: ['a\tb\tc\r\nd\u0000e', '', false],
  ansiShell: [`${ESC}[4;31mA\tB${ESC}[24;39m\r\nC\u0000D`, '', true],
  osc: [`${ESC}]8;;https://example.test\u0007label${ESC}]8;;\u0007`, '', true],
  empty: ['', '', false],
  longJson: [JSON.stringify({ text: 'x'.repeat(12000) }), '', false],
};
for (const [key, [text, pathArg, isShell]] of Object.entries(bodies)) {
  fn(`format-${key}`, 'formatExpandedResult', [text, { pathArg, isShell }]);
}
fn('format-many-lines', 'formatExpandedResult', [Array.from({ length: 4100 }, (_, i) => `line ${i}`).join('\n'), { pathArg: '', isShell: false }]);
fn('format-many-lines-shell', 'formatExpandedResult', [Array.from({ length: 4100 }, (_, i) => `line ${i}`).join('\n'), { pathArg: '', isShell: true }]);
for (const width of [24, 40, 80, 120]) {
  fn(`wrap-long-w${width}`, 'wrapExpandedResultLines', [[longLine, 'short', '', 'x'.repeat(300)], width, { isShell: false }]);
  fn(`wrap-wide-glyphs-w${width}`, 'wrapExpandedResultLines', [['한국어 日本語 mixed 문장입니다 '.repeat(8), '1→ブロック '.repeat(20)], width, { isShell: false }]);
}
for (const cap of ['0', '1', '3', 'abc']) {
  fn(`wrap-cap-${cap}-shell`, 'wrapExpandedResultLines', [['a', 'b', 'c', 'd', 'e'], 160, { isShell: true }], { MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES: cap });
  fn(`wrap-cap-${cap}`, 'wrapExpandedResultLines', [['a', 'b', 'c', 'd', 'e'], 160, { isShell: false }], { MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES: cap });
}
fn('wrap-legacy-cap', 'wrapExpandedResultLines', [['a', 'b', 'c'], 160, { isShell: false }], { MIXDOG_TUI_EXPANDED_MAX_ROWS: '2' });
fn('wrap-legacy-ignored', 'wrapExpandedResultLines', [['a', 'b', 'c'], 160, { isShell: false }], { MIXDOG_TUI_EXPANDED_MAX_ROWS: '2', MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES: '0' });
fn('wrap-empty', 'wrapExpandedResultLines', [[], 160, { isShell: false }]);

process.stdout.write(`${JSON.stringify(cases, null, 1)}\n`);
