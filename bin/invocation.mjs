// Whether a command line is one that never touches the host's data folder (`skipHostPrelude` of 1.4.5's
// `classifyCliInvocation`, `skip_host_prelude` of mixdog-entry/src/argv.rs): `mixdog exec` and the refusals made before the host
// matters. 1.4.5's cli.mjs ran its staged-update swap only when this is false, so the launcher asks it before swapping.
// The launcher ships alone, so the reading is restated here; native/core/crates/mixdog-entry/tests/prelude-cases.json holds the two
// together (a JS test and a Rust test read the same table).

const VALUE_OPTIONS = ['--provider', '--model', '--effort', '--workflow'];
const FLAG_OPTIONS = ['--no-worktree', '--readonly', '--help', '-h', '--plain', '--react', '--remote', '--onboarding', '--fast', '--web-search', '--memory', '--json'];
const WORKTREE_NAME_MAX_LENGTH = 64;

const isExec = (value) => String(value).trim().toLowerCase().replace(/[\s_]+/g, '-') === 'exec';
const isWorktreeOption = (arg) => arg === '--worktree' || arg.startsWith('--worktree=');

/** `worktreeNameError(name) !== null`. */
function worktreeNameInvalid(name) {
  if (!name || name.length > WORKTREE_NAME_MAX_LENGTH) return true;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return true;
  return name.includes('..') || name.endsWith('.') || name.toLowerCase().endsWith('.lock');
}

/** The word after a bare `--worktree` is its name unless it is empty, an option or the exec verb. */
const worktreeNameToken = (value) => (value === undefined || value === '' || value.startsWith('-') || isExec(value) ? null : value);

function argvIndicatesExec(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (VALUE_OPTIONS.includes(arg)) {
      index += 1;
    } else if (arg === '--worktree') {
      if (worktreeNameToken(argv[index + 1]) !== null) index += 1;
    } else if (!(isWorktreeOption(arg) || arg === '--' || FLAG_OPTIONS.includes(arg) || arg.startsWith('-'))) {
      return isExec(arg);
    }
  }
  return false;
}

/** `parseTokens`: `{ refusal: skipHostPrelude }` for a refusal made while the line is read, else what the rest needs. */
function parseTokens(argv, strict) {
  const allowHeadlessIntent = strict && !argv.includes('--react');
  const parsed = { positional: [], workflow: false, worktree: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (isWorktreeOption(arg)) {
      let name = null;
      if (arg === '--worktree') {
        name = worktreeNameToken(next);
        if (name !== null) index += 1;
      } else {
        name = arg.slice('--worktree='.length);
      }
      if (strict && name !== null && worktreeNameInvalid(name)) return { refusal: false };
      parsed.worktree = true;
    } else if (VALUE_OPTIONS.includes(arg)) {
      if (next === undefined || next === '' || next.startsWith('-')) {
        if (strict) return { refusal: arg === '--provider' || arg === '--model' };
        continue;
      }
      if (allowHeadlessIntent && isExec(next)) return { refusal: true };
      if (arg === '--workflow') parsed.workflow = true;
      index += 1;
    } else if (FLAG_OPTIONS.includes(arg)) {
      // A flag is read from the whole line.
    } else if (arg === '--') {
      parsed.positional.push(...argv.slice(index + 1));
      break;
    } else if (arg.startsWith('-')) {
      return { refusal: allowHeadlessIntent && argvIndicatesExec(argv) };
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

/** `classifyCliInvocation(argv).skipHostPrelude === true`. */
export function skipsHostPrelude(argv) {
  const given = (flag) => argv.includes(flag);
  const help = given('--help') || given('-h');
  const plain = given('--plain');
  const parsed = parseTokens(argv, !help && !plain);
  if ('refusal' in parsed) return parsed.refusal;
  if (given('--no-worktree') && parsed.worktree && !help && !plain) return false;
  if (help || plain || given('--react')) return false;
  // An exec, with or without the message and the options it refuses, and `--json` without one, are all refused or run before the host.
  return isExec(parsed.positional[0] ?? '') || given('--json');
}
