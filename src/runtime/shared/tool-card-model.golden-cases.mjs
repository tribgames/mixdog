/**
 * Representative deriveToolCardModel inputs. Every case fixes nowMs so the
 * derived model is deterministic; tool-card-model.golden.json holds the
 * expected models and tool-card-model.test.mjs compares against it.
 */
const NOW_MS = 20000;

// Git expectations are authored from the text contract rather than captured
// from the model, so a rendering regression cannot bless its own output.
export const GIT_GOLDEN_CASES = [
  { result: '## main\n M a.txt\n', summary: '## main', status: 'completed' },
  { result: '', summary: '(No Output)', status: 'completed' },
  { result: '## git add a.txt\n\n## git status\n## main\nA  a.txt\n', summary: '## main', status: 'completed' },
  {
    result: 'diff --git a/a.txt b/a.txt\n... [4 more lines omitted; raise output_limit or narrow the command]',
    summary: 'diff --git a/a.txt b/a.txt',
    status: 'completed',
  },
  { result: 'exit 128\nfatal: missing ref\n', summary: 'Exit 128', status: 'failed' },
  {
    result: '## git show missing\nexit 128\nfatal: missing\nerror: command failed: git show missing',
    summary: 'Exit 128',
    status: 'failed',
  },
  { result: '{"ok":true,"clean":true}', summary: 'Ok', status: 'completed' },
];

const BACKGROUND_RUNNING =
  'background task\ntask_id: t1\nsurface: shell\nstatus: running\nstarted: 2024-01-01T00:00:00Z\n\nbuilding…';
const BACKGROUND_DONE =
  '<task-notification>\n<task-id>t2</task-id>\n<status>completed</status>\n<exit-code>0</exit-code>\n<summary>Shell task completed (exit 0)</summary>\n<result>\nall good\nline2\n</result>\n</task-notification>';
const BACKGROUND_FAILED = 'background task\ntask_id: t3\nsurface: web_search\nstatus: failed\nerror: boom\n';

export const GOLDEN_CASES = [
  {
    id: 'shell-pending',
    input: { name: 'shell', args: { command: 'npm test' }, completedCount: 0, startedAt: 1000, nowMs: NOW_MS },
  },
  {
    id: 'shell-done',
    input: {
      name: 'shell',
      args: { command: 'ls' },
      result: '[elapsed: 2500 ms]\nfile-a\nfile-b',
      startedAt: 1000,
      completedAt: 5000,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'shell-exit-failure',
    input: {
      name: 'shell',
      args: { command: 'false' },
      result: '[status: failed]\nexit 1',
      exitErrorCount: 1,
      errorCount: 1,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'shell-verified-group',
    input: {
      name: 'shell',
      args: { command: 'npm test', verifyShell: true },
      count: 2,
      completedCount: 2,
      result: 'ok',
      nowMs: NOW_MS,
    },
  },
  {
    id: 'agent-spawn-pending',
    input: {
      name: 'agent',
      args: { type: 'spawn', agent: 'worker', model: 'gpt-5', tag: 'lens-a' },
      completedCount: 0,
      startedAt: 1000,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'agent-response',
    input: {
      name: 'agent',
      args: { type: 'send', agent: 'heavy-worker', status: 'completed' },
      result: 'Here is the review summary.\nmore',
      startedAt: 1000,
      completedAt: 4000,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'agent-failed',
    input: {
      name: 'agent',
      args: { type: 'spawn', agent: 'worker', status: 'failed', error: 'spawn refused' },
      isError: true,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'agent-list',
    input: { name: 'agent', args: { type: 'list' }, result: '(no agents or tasks)', nowMs: NOW_MS },
  },
  {
    id: 'background-running',
    input: {
      name: 'shell',
      args: { task_id: 't1', status: 'running', type: 'progress' },
      result: BACKGROUND_RUNNING,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'background-response',
    input: { name: 'shell', args: { task_id: 't2' }, result: BACKGROUND_DONE, nowMs: NOW_MS },
  },
  {
    id: 'background-failed',
    input: { name: 'web_search', args: { task_id: 't3' }, result: BACKGROUND_FAILED, isError: true, nowMs: NOW_MS },
  },
  {
    id: 'load-tool',
    input: {
      name: 'load_tool',
      args: { names: ['office', 'media'] },
      result: JSON.stringify({ selected: { tools: { added: ['office'], already: ['media'] } } }),
      nowMs: NOW_MS,
    },
  },
  {
    id: 'skill-error',
    input: { name: 'skill', args: { name: 'pdf' }, result: 'Failed to load', isError: true, nowMs: NOW_MS },
  },
  { id: 'skill-ok', input: { name: 'skill', args: { name: 'pdf' }, result: 'loaded', nowMs: NOW_MS } },
  {
    id: 'read',
    input: { name: 'read', args: { file_path: 'C:/x/y.mjs' }, result: '1→line\n2→line', nowMs: NOW_MS },
  },
  { id: 'view-image', input: { name: 'view_image', args: { path: 'a.png' }, result: 'ok', nowMs: NOW_MS } },
  {
    id: 'web-search',
    input: {
      name: 'web_search',
      args: { query: 'node test runner' },
      result: 'Result 1\nResult 2',
      startedAt: 1000,
      completedAt: 3500,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'aggregate-pending',
    input: {
      aggregate: true,
      categories: { read: 2, search: 1 },
      count: 3,
      completedCount: 1,
      args: { categoryOrder: ['read', 'search'] },
      startedAt: 1000,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'aggregate-done',
    input: {
      aggregate: true,
      categories: { read: 2 },
      doneCategories: { read: 2 },
      count: 2,
      completedCount: 2,
      result: 'Loaded 2 files',
      nowMs: NOW_MS,
    },
  },
  {
    id: 'aggregate-loading-targets',
    input: {
      aggregate: true,
      args: { loadingTargets: ['office', 'media'] },
      count: 2,
      completedCount: 2,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'grep-group-partial-failure',
    input: {
      name: 'grep',
      args: { pattern: 'foo' },
      count: 3,
      completedCount: 3,
      result: 'a\tb\r\nc',
      errorCount: 1,
      callErrorCount: 1,
      nowMs: NOW_MS,
    },
  },
  {
    id: 'edit-error',
    input: { name: 'edit', args: { file_path: 'x.mjs' }, isError: true, result: 'Error: no match', nowMs: NOW_MS },
  },
  {
    id: 'agent-brief-truncated',
    input: {
      name: 'agent',
      args: { type: 'spawn', agent: 'worker', status: 'failed', error: 'x'.repeat(120) },
      result:
        'Agent result\nstatus: failed\n\nThe worker failed after a very long explanation that keeps going and going',
      isError: true,
      nowMs: NOW_MS,
    },
    options: { maxResultChars: 30 },
  },
];
