#!/usr/bin/env node
// Records how Node's CLI reads a command line (`classifyCliInvocation`, src/headless-command.mjs) over a generated corpus of
// argv, so the Rust entry (`mixdog-entry` argv.rs) replays them and is compared with it whole: every option alone, with values,
// with values that start with a dash, empty or name the exec verb, `exec` at each position, `--` placements, duplicates,
// unknown options, unicode messages and the empty line.
//   node native/core/crates/mixdog-entry/tests/recorders/record-argv.mjs --tree <tree> [--check <golden.json>]
// Without --check it writes tests/goldens/argv.json; with it, it compares and exits 1 when the recording differs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN = path.join(here, '..', 'goldens', 'argv.json');

function argument(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}
const tree = argument('--tree');
if (!tree) {
  console.error('usage: record-argv.mjs --tree <tree> [--check <golden.json>]');
  process.exit(2);
}
const check = argument('--check');
const { classifyCliInvocation } = await import(pathToFileURL(path.join(tree, 'src', 'headless-command.mjs')).href);

// One token group each: an option with the words it may take.
const FLAGS = ['--readonly', '--help', '-h', '--plain', '--react', '--remote', '--onboarding', '--fast', '--web-search', '--memory', '--json', '--no-worktree'];
const VALUES = ['gpt', 'x y', '', '-x', '--model', 'exec', ' Exec ', 'EXEC', 'ex_ec', 'exec_', '日本語'];
const NAMES = ['feature', 'a b', '', '..', 'a/b', '-', 'x'.repeat(100), 'exec', 'Exec', 'ok-name_1.2', 'é', '.hidden', 'a..b', 'a.lock'];

const singles = [];
for (const flag of FLAGS) singles.push([flag]);
for (const option of ['--provider', '--model', '--effort', '--workflow']) {
  singles.push([option]);
  for (const value of VALUES) singles.push([option, value]);
}
singles.push(['--worktree'], ['--worktree', 'a'], ['--worktree', '-x'], ['--worktree', 'exec'], ['--worktree', 'Exec'], ['--worktree', ' exec '], ['--worktree', '']);
for (const name of NAMES) singles.push([`--worktree=${name}`]);
for (const name of NAMES) singles.push(['--worktree', name]);
singles.push(['--unknown'], ['-x'], ['-'], ['--Provider', 'x'], ['--provider=x'], ['--json=1'], ['--worktree-x'], ['--no-worktree=x'], ['--tool-mode', 'readonly'], ['--cwd', 'x']);
singles.push([], [''], ['hello'], ['hello', 'world'], ['--'], ['--', '--help'], ['--', 'exec', 'hi'], ['--', '--json'], ['--', '-x']);

// The exec verb and its messages.
const MESSAGES = [
  ['exec', 'hi'], ['exec', 'hello', 'world'], ['exec'], ['exec', ''], ['exec', '  '], ['exec', '\t\n'], ['Exec', 'hi'], ['EXEC', 'hi'], [' exec ', 'hi'], ['exec_', 'hi'], ['ex_ec', 'hi'],
  ['exec', 'héllo', '日本語 🎉'], ['exec', '--', '--json'], ['exec', '--', '-x'], ['exec', '--', 'exec'], ['exec', 'exec'], ['exec', '-x'], ['exec', '--help'], ['exec', 'hi', '--json'],
  ['--', 'exec', 'hi'], ['--', '--', 'exec', 'hi'], ['hi', 'exec'], ['hi', 'exec', 'x'],
];
for (const words of MESSAGES) singles.push(words);

const PAIR_ATOMS = [
  ['--json'], ['--fast'], ['--web-search'], ['--readonly'], ['--remote'], ['--onboarding'], ['--memory'], ['--no-worktree'], ['--plain'], ['--help'], ['--react'],
  ['--provider', 'x'], ['--provider', 'exec'], ['--provider'], ['--model', 'm'], ['--model', '-m'], ['--effort', 'high'], ['--effort', 'Exec'], ['--workflow', 'w'], ['--workflow', 'exec'],
  ['--worktree'], ['--worktree', 'name'], ['--worktree=name'], ['--worktree=bad name'], ['--worktree', 'exec'], ['--bogus'],
];
const POSITIONS = [
  (atoms) => atoms,
  (atoms) => [...atoms, 'exec', 'say hi'],
  (atoms) => ['exec', 'say hi', ...atoms],
  (atoms) => ['exec', ...atoms, 'say hi'],
  (atoms) => [...atoms, '--', 'exec', 'say hi'],
];
const corpus = [...singles];
for (const first of PAIR_ATOMS) {
  corpus.push(first);
  for (const second of PAIR_ATOMS) {
    for (const place of POSITIONS) corpus.push(place([...first, ...second]));
  }
}
// Duplicates of one option: the first value wins.
corpus.push(['--provider', 'a', '--provider', 'b', 'exec', 'hi'], ['--model', 'a', '--model', 'b'], ['--worktree=a', '--worktree=b'], ['--worktree', 'a', '--worktree', 'b'], ['--fast', '--fast', 'exec', 'hi']);

const seen = new Set();
const unique = corpus.filter((argv) => {
  const key = JSON.stringify(argv);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const text = (value) => (value === undefined ? null : value);

/** What the entry decides from a classification: the kind, the refusal text, whether the host prelude is skipped, the message and the options. */
function record(argv) {
  const invocation = classifyCliInvocation(argv);
  const options = invocation.options;
  return {
    argv,
    kind: invocation.kind,
    error: text(invocation.error),
    skipHostPrelude: invocation.kind === 'exec' || invocation.skipHostPrelude === true,
    message: text(invocation.exec?.message),
    options: options
      ? {
          worktree: options.worktree ? { mode: options.worktree.mode, name: options.worktree.name ?? null } : null,
          provider: text(options.provider),
          model: text(options.model),
          effort: text(options.effort),
          fast: options.fast,
          webSearch: options.webSearch,
          json: options.json,
          toolMode: options.toolMode,
          remote: options.remote,
          forceOnboarding: options.forceOnboarding,
        }
      : null,
  };
}

const body = `${JSON.stringify({ cases: unique.map(record) })}\n`;
if (check) {
  const golden = fs.readFileSync(path.resolve(check), 'utf8');
  if (golden !== body) {
    console.error(`record-argv: ${check} differs from what ${tree} does now`);
    process.exit(1);
  }
  console.log(`record-argv: ${unique.length} cases match ${check}`);
} else {
  fs.writeFileSync(DEFAULT_GOLDEN, body);
  console.log(`record-argv: wrote ${unique.length} cases to ${DEFAULT_GOLDEN}`);
}
