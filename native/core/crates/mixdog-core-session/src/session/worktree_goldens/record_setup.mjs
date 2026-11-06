// Records the text-producing parts of Node's worktree setup (`outputTail`, the byte-capped
// output window and the agent's preparation note) into setup_goldens.json, which
// `worktree_setup_tests.rs` compares the Rust port against byte for byte.
//
//   node record_setup.mjs [path-to-mixdog-node-checkout]   (default C:/Project/mixdog)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ?? 'C:/Project/mixdog';
const load = (path) => import(pathToFileURL(`${ROOT}/${path}`).href);
const { outputTail, createOutputWindow } = await load('src/runtime/shared/worktrees/setup-commands.mjs');
const { worktreePreparationNote } = await load('src/runtime/shared/worktrees/preparation-report.mjs');

// A lone surrogate cannot be written to UTF-8 or JSON; the output stream carries U+FFFD for it.
const wellFormed = (text) => text.toWellFormed();

const tails = [
  '',
  'one line',
  'a\nb\n',
  'a\r\nb\r\n\r\n',
  '  \n\t\n',
  Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'),
  'x'.repeat(3000),
  `${'😀'.repeat(1100)}y`,
  `${'é'.repeat(2500)}\n`,
  'tail with trailing blanks \u00a0\ufeff\n',
];
const tail = tails.map((input) => ({ input, output: wellFormed(outputTail(input)) }));

const windows = [
  { limit: 10, chunks: ['abcdef', 'ghijklmnop', 'qr'] },
  { limit: 10, chunks: ['abc'] },
  { limit: 10, chunks: ['abcdefghij'] },
  { limit: 9, chunks: ['ééééé'] },
  { limit: 8, chunks: ['a', 'b', 'cdefghijklmnopqrstuvwxyz', 'END'] },
  { limit: 16 * 1024, chunks: ['x'.repeat(40000)] },
].map(({ limit, chunks }) => {
  const window = createOutputWindow(limit);
  for (const chunk of chunks) window.append(chunk);
  return { limit, chunks, text: wellFormed(window.text()), truncated: window.truncated };
});

const step = (command, status, over = {}) => ({
  command,
  label: undefined,
  status,
  exitCode: status === 'completed' ? 0 : 1,
  durationMs: 5,
  output: '',
  truncated: false,
  ...over,
});
const pending = (command, label, cwd) => ({ command, label, cwd, file: 'x', args: [] });
const notes = [
  { name: 'bare', report: {} },
  {
    name: 'prepared',
    report: {
      root: '/repo',
      prepared: {
        root: '/ignored',
        copied: ['.env', 'config/local.json'],
        linked: ['node_modules'],
        skipped: [
          'include-missing:a.txt',
          'include-exists:b.txt',
          'include-skipped:c.txt',
          'include-invalid:patterns',
          'include-invalid:7',
          'include-truncated:5000',
          'unknown-code:z',
        ],
      },
      dependencyNotes: ['No lockfile or dependency manifest found; nothing was installed.'],
      notes: ['A free-form note.'],
    },
  },
  { name: 'prepared-root-only', report: { prepared: { root: '/from-prepared' } } },
  {
    name: 'installed',
    report: {
      root: '/repo',
      installs: {
        status: 'completed',
        total: 2,
        steps: [step('"npm" ci', 'completed', { label: 'npm (root)' }), step('"yarn" install', 'completed')],
        pending: [],
      },
    },
  },
  {
    name: 'failed',
    report: {
      root: '/repo',
      installs: {
        status: 'failed',
        total: 3,
        steps: [
          step('"npm" ci', 'completed', { label: 'npm (root)' }),
          step('"pnpm" install', 'failed', { label: 'pnpm (web)', exitCode: 2, output: 'boom\nERR! it broke\n' }),
        ],
        pending: [pending('"uv" sync', 'uv (api)', '/repo/api')],
      },
    },
  },
  {
    name: 'timed-out-no-code',
    report: {
      root: '/repo',
      installs: {
        status: 'timed-out',
        total: 1,
        steps: [step('"npm" ci', 'timed-out', { exitCode: null, output: 'slow' })],
        pending: [],
      },
    },
  },
  {
    name: 'cancelled-before-any',
    report: {
      root: '/repo',
      installs: { status: 'cancelled', total: 2, steps: [], pending: [pending('"npm" ci', undefined, '/repo')] },
    },
  },
  {
    name: 'cancelled-mid',
    report: {
      root: '/repo',
      installs: {
        status: 'cancelled',
        total: 1,
        steps: [step('"npm" ci', 'cancelled', { exitCode: null })],
        pending: [],
      },
    },
  },
].map(({ name, report }) => ({
  name,
  report: JSON.parse(JSON.stringify(report)),
  note: wellFormed(worktreePreparationNote(report)),
}));

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'setup_goldens.json'), `${JSON.stringify({ tail, windows, notes }, null, 2)}\n`);
console.log(`recorded ${tail.length} tails, ${windows.length} windows, ${notes.length} notes`);
