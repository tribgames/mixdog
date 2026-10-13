import { worktreeNameError } from './runtime/shared/worktrees/contract.mjs';

const VALUE_OPTIONS = new Set(['--provider', '--model', '--effort', '--workflow']);
// `--worktree [name]` takes an optional value; `--worktree=<name>` is the
// unambiguous spelling.
const WORKTREE_OPTION = '--worktree';
const NO_WORKTREE_OPTION = '--no-worktree';
const FLAG_OPTIONS = new Set([
  NO_WORKTREE_OPTION,
  '--readonly',
  '--help',
  '-h',
  '--plain',
  '--react',
  '--remote',
  '--onboarding',
  '--fast',
  '--web-search',
  '--memory',
  '--json',
]);
const EXEC_UNSUPPORTED_FLAGS = new Set(['--readonly', '--remote', '--onboarding', '--memory', NO_WORKTREE_OPTION]);
const HEADLESS_WORKFLOW_ERROR = 'option --workflow is not supported for mixdog exec';

function roleKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

const isWorktreeOption = (arg) => arg === WORKTREE_OPTION || arg.startsWith(`${WORKTREE_OPTION}=`);

/** The token after a bare `--worktree` is its name unless it is an option or the exec verb. */
function worktreeNameToken(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!text || text.startsWith('-') || roleKey(text) === 'exec') return null;
  return text;
}

function argvIndicatesExec(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === WORKTREE_OPTION) {
      if (worktreeNameToken(argv[index + 1]) !== null) index += 1;
      continue;
    }
    if (isWorktreeOption(arg)) continue;
    if (arg === '--') continue;
    if (FLAG_OPTIONS.has(arg) || arg.startsWith('-')) continue;
    return roleKey(arg) === 'exec';
  }
  return false;
}

function parseTokens(argv, { strictValues = true } = {}) {
  const positional = [];
  const values = {};
  let worktree;
  const allowHeadlessIntent = strictValues && !argv.includes('--react');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (isWorktreeOption(arg)) {
      let name = arg === WORKTREE_OPTION ? null : arg.slice(WORKTREE_OPTION.length + 1);
      if (name === null) {
        name = worktreeNameToken(argv[index + 1]);
        if (name !== null) index += 1;
      }
      const nameError = name === null ? null : worktreeNameError(name);
      if (nameError && strictValues) {
        return { error: `option --worktree name ${JSON.stringify(name)} is invalid: ${nameError}` };
      }
      worktree = { mode: 'worktree', name: nameError ? null : name };
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value === '' || String(value).startsWith('-')) {
        if (strictValues) {
          return {
            error: `option ${arg} requires a non-option value`,
            skipHostPrelude: arg === '--provider' || arg === '--model',
          };
        }
        continue;
      }
      const valueKey = roleKey(value);
      if (allowHeadlessIntent && arg === '--workflow' && valueKey === 'exec') {
        return {
          error: HEADLESS_WORKFLOW_ERROR,
          skipHostPrelude: true,
        };
      }
      if (
        allowHeadlessIntent &&
        (arg === '--provider' || arg === '--model' || arg === '--effort') &&
        valueKey === 'exec'
      ) {
        return {
          error: `option ${arg} requires a route value before ${JSON.stringify(String(value))}`,
          skipHostPrelude: true,
        };
      }
      if (!(arg in values)) values[arg] = String(value);
      index += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(arg)) continue;
    if (arg === '--') {
      positional.push(...argv.slice(index + 1).map((value) => String(value ?? '')));
      break;
    }
    if (arg.startsWith('-')) {
      return {
        error: `unknown option ${arg}`,
        ...(allowHeadlessIntent && argvIndicatesExec(argv) ? { skipHostPrelude: true } : {}),
      };
    }
    positional.push(arg);
  }
  return { positional, values, worktree };
}

/**
 * Session creation intent from `--worktree [name]` / `--no-worktree`:
 * undefined follows the worktree settings default.
 * @returns {{ worktree?: { mode: 'worktree', name: string|null } | { mode: 'branch' } } | { error: string }}
 */
function worktreeIntent(argv, parsed) {
  const disabled = argv.includes(NO_WORKTREE_OPTION);
  if (disabled && parsed.worktree) return { error: 'options --worktree and --no-worktree are mutually exclusive' };
  if (disabled) return { worktree: { mode: 'branch' } };
  return parsed.worktree ? { worktree: parsed.worktree } : {};
}

function execFromPositional(positional) {
  if (!positional.length) return null;
  if (roleKey(positional[0]) !== 'exec') return null;
  const message = positional.slice(1).join(' ').trim();
  if (!message) return { error: 'usage: mixdog exec [options] <message...>' };
  return { message };
}

export function classifyCliInvocation(argv = []) {
  const hasHelp = argv.includes('--help') || argv.includes('-h');
  const hasPlain = argv.includes('--plain');
  const parsed = parseTokens(argv, { strictValues: !hasHelp && !hasPlain });
  if (parsed.error) return { kind: 'error', ...parsed };
  const intent = worktreeIntent(argv, parsed);
  if (intent.error && !hasHelp && !hasPlain) return { kind: 'error', error: intent.error };
  const options = {
    ...(intent.worktree ? { worktree: intent.worktree } : {}),
    provider: parsed.values['--provider'],
    model: parsed.values['--model'],
    effort: parsed.values['--effort'],
    fast: argv.includes('--fast'),
    webSearch: argv.includes('--web-search'),
    json: argv.includes('--json'),
    toolMode: argv.includes('--readonly') ? 'readonly' : 'full',
    remote: argv.includes('--remote'),
    forceOnboarding: argv.includes('--onboarding'),
  };
  if (hasHelp) return { kind: 'help', options };
  if (hasPlain) return { kind: 'plain', options };
  if (argv.includes('--react')) return { kind: 'react', options };
  const exec = execFromPositional(parsed.positional);
  if (exec?.error) {
    return { kind: 'error', error: exec.error, skipHostPrelude: true };
  }
  if (exec) {
    if (parsed.values['--workflow'] !== undefined) {
      return {
        kind: 'error',
        error: HEADLESS_WORKFLOW_ERROR,
        skipHostPrelude: true,
      };
    }
    const unsupported =
      [...EXEC_UNSUPPORTED_FLAGS].find((flag) => argv.includes(flag)) ||
      (parsed.worktree ? WORKTREE_OPTION : undefined);
    if (unsupported) {
      return {
        kind: 'error',
        error: `option ${unsupported} is not supported for mixdog exec`,
        skipHostPrelude: true,
      };
    }
    return { kind: 'exec', exec, options, skipHostPrelude: true };
  }
  if (argv.includes('--json')) {
    return {
      kind: 'error',
      error: 'option --json is only supported for mixdog exec',
      skipHostPrelude: true,
    };
  }
  return { kind: 'general', options };
}

export function parseHeadlessExecCommand(argv = []) {
  const invocation = classifyCliInvocation(argv);
  if (invocation.kind === 'error') return { error: invocation.error };
  return invocation.kind === 'exec' ? invocation.exec : null;
}
