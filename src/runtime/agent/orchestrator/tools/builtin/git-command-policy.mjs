import { tokenizeDirectArgv } from './shell-direct-exe.mjs';

const ALWAYS_READ = new Set([
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-ref-format',
  'cherry',
  'count-objects',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'for-each-ref',
  'fsck',
  'grep',
  'help',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'merge-tree',
  'name-rev',
  'range-diff',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-branch',
  'show-ref',
  'status',
  'verify-commit',
  'verify-pack',
  'verify-tag',
  'version',
  'whatchanged',
]);

const SHELL_OPERATOR_CHARS = '|&;<>()';
// `git --version` / `-v` / `--help` / `-h` arrive in global-flag position; both
// the policy classifier and the git tool fold them onto their subcommand form,
// so the mapping is shared to keep the two from drifting apart.
export const OPERATION_ALIASES = new Map([
  ['--version', 'version'],
  ['-v', 'version'],
  ['--help', 'help'],
  ['-h', 'help'],
]);

function atTokenBoundary(char) {
  return char === undefined || /\s/.test(char);
}

// The git tool spawns git directly and never opens a shell, so an operator that
// survives this guard can only reach git as literal argument text — it can
// never chain, redirect, or substitute. The guard therefore exists to reject
// commands WRITTEN as shell pipelines (`git a && git b`), not to sanitize
// arguments. Operators count only in operator position (a whitespace-delimited
// run), which keeps literal separators inside one token usable unquoted:
// `--format=%h|%ad|%s` and `:(exclude)dir` were being rejected outright.
// Substitution and embedded newlines stay rejected wherever they appear.
export function commandHasShellSyntax(command) {
  const text = String(command || '');
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\' && text[index + 1] === '"') {
        index++;
        continue;
      }
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === '$' || char === '`') return true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '$' || char === '`' || char === '\n' || char === '\r') return true;
    if (!SHELL_OPERATOR_CHARS.includes(char)) continue;
    let end = index;
    while (end + 1 < text.length && SHELL_OPERATOR_CHARS.includes(text[end + 1])) end++;
    if (atTokenBoundary(text[index - 1]) && atTokenBoundary(text[end + 1])) return true;
    index = end;
  }
  return quote !== null;
}

function gitActionOf(operation, args) {
  const first = args.find((value) => value && !value.startsWith('-'));
  if (operation === 'stash') return first || 'push';
  if (operation === 'worktree') return first || 'list';
  if (operation === 'remote') return first || 'list';
  if (operation === 'reflog') return first || 'show';
  return first || 'list';
}

export function gitPlanIsReadOnly(plan) {
  const { operation, args } = plan;
  if (args.some((value) => value === '--output' || value.startsWith('--output='))) return false;
  if (operation === 'fsck' && args.includes('--lost-found')) return false;
  if (ALWAYS_READ.has(operation)) return true;
  if (operation === 'reflog') return ['show', 'list', 'exists'].includes(gitActionOf(operation, args));
  if (operation === 'stash') return ['list', 'show'].includes(gitActionOf(operation, args));
  if (operation === 'worktree') return gitActionOf(operation, args) === 'list';
  if (operation === 'remote') return ['list', 'get-url', 'show'].includes(gitActionOf(operation, args));
  if (operation === 'clean')
    return args.some((value) => value === '-n' || value === '--dry-run' || /^-[^-]*n/.test(value));
  if (operation === 'bundle') return ['list-heads', 'verify'].includes(gitActionOf(operation, args));
  if (operation === 'notes') return ['', 'list', 'show'].includes(gitActionOf(operation, args));
  if (operation === 'replace') return args.length === 0 || args.includes('--list');
  if (operation === 'sparse-checkout') return gitActionOf(operation, args) === 'list';
  if (operation === 'submodule') return ['', 'status', 'summary'].includes(gitActionOf(operation, args));
  if (operation === 'symbolic-ref') {
    if (args.some((value) => value === '-d' || value === '--delete')) return false;
    return args.filter((value) => !value.startsWith('-')).length <= 1;
  }
  if (operation === 'hash-object') return !args.includes('-w') && !args.includes('--stdin-paths');
  if (operation === 'branch' || operation === 'tag') {
    return (
      args.length === 0 || args.some((value) => ['--list', '-l', '-a', '--all', '-r', '--remotes'].includes(value))
    );
  }
  if (operation === 'config') {
    const mutationFlags = new Set([
      '--add',
      '--edit',
      '--rename-section',
      '--remove-section',
      '--replace-all',
      '--unset',
      '--unset-all',
    ]);
    if (args.some((value) => mutationFlags.has(value))) return false;
    const readFlag = args.some((value) =>
      /^--(?:get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope)$/.test(value)
    );
    const positional = args.filter((value) => !value.startsWith('-'));
    if (['set', 'unset', 'rename-section', 'remove-section'].includes(positional[0])) return false;
    if (['get', 'get-all', 'get-regexp', 'get-urlmatch', 'list'].includes(positional[0])) return true;
    return readFlag || positional.length <= 1;
  }
  return false;
}

const GIT_GLOBAL_VALUE_FLAGS = ['-c', '--config-env', '--git-dir', '--work-tree', '--namespace'];
const GIT_GLOBAL_BARE_FLAGS = [
  '--no-pager',
  '--paginate',
  '--bare',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
];

// git's global flags sit between `git` and the subcommand, and every consumer
// has to step over exactly the same set to find that subcommand. Returns its
// index; the optional handlers let a caller capture what it skipped (the git
// tool keeps `-C` as its cwd and the rest as global args, and rejects a
// missing value) while a pure scan passes none.
export function skipGitGlobalFlags(tokens, { onChdir, onValueFlag, onBareFlag } = {}) {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '-C') {
      onChdir?.(tokens[index + 1]);
      index += 2;
      continue;
    }
    if (/^-C.+/.test(token)) {
      onChdir?.(token.slice(2));
      index++;
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.includes(token)) {
      onValueFlag?.(token, tokens[index + 1]);
      index += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|config-env)=/.test(token) || GIT_GLOBAL_BARE_FLAGS.includes(token)) {
      onBareFlag?.(token);
      index++;
      continue;
    }
    break;
  }
  return index;
}

function parsedGitOperation(command) {
  if (commandHasShellSyntax(command)) return null;
  const tokens = tokenizeDirectArgv(command);
  if (!tokens?.length || !/(^|[\\/])git(?:\.exe)?$/i.test(tokens[0])) return null;
  const index = skipGitGlobalFlags(tokens);
  const rawOperation = String(tokens[index] || '').toLowerCase();
  const operation = OPERATION_ALIASES.get(rawOperation) ?? rawOperation;
  return operation ? { operation, args: tokens.slice(index + 1) } : null;
}

export function gitCommandMutates(value) {
  let args = value;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { command: args };
    }
  }
  if (args?.action !== undefined && args.action !== 'command') return true;
  const parsed = parsedGitOperation(args?.command);
  return !parsed || !gitPlanIsReadOnly(parsed);
}
