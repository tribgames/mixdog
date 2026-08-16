import { tokenizeDirectArgv } from './shell-direct-exe.mjs';

const ALWAYS_READ = new Set([
    'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-ref-format',
    'cherry', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index',
    'diff-tree', 'for-each-ref', 'fsck', 'grep', 'help', 'log', 'ls-files',
    'ls-remote', 'ls-tree', 'merge-base', 'merge-tree', 'name-rev',
    'range-diff', 'rev-list', 'rev-parse', 'shortlog', 'show', 'show-branch',
    'show-ref', 'status', 'verify-commit', 'verify-pack', 'verify-tag',
    'whatchanged',
]);

function commandHasShellSyntax(command) {
    const text = String(command || '');
    let quote = null;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quote === "'") {
            if (char === "'") quote = null;
            continue;
        }
        if (quote === '"') {
            if (char === '\\' && text[index + 1] === '"') { index++; continue; }
            if (char === '"') { quote = null; continue; }
            if (char === '$' || char === '`') return true;
            continue;
        }
        if (char === "'" || char === '"') { quote = char; continue; }
        if ('|&;<>()\n\r'.includes(char) || char === '$' || char === '`') return true;
    }
    return quote !== null;
}

export function gitActionOf(operation, args) {
    const first = args.find((value) => value && !value.startsWith('-'));
    if (operation === 'stash') return first || 'push';
    if (operation === 'worktree') return first || 'list';
    if (operation === 'remote') return first || 'list';
    if (operation === 'reflog') return first || 'show';
    return first || 'list';
}

export function gitPlanIsReadOnly(plan) {
    const { operation, args } = plan;
    if (operation === 'fsck' && args.includes('--lost-found')) return false;
    if (ALWAYS_READ.has(operation)) return true;
    if (operation === 'reflog') return !['delete', 'expire'].includes(gitActionOf(operation, args));
    if (operation === 'stash') return ['list', 'show'].includes(gitActionOf(operation, args));
    if (operation === 'worktree') return gitActionOf(operation, args) === 'list';
    if (operation === 'remote') return args.length === 0 || args.includes('-v') || ['get-url', 'show'].includes(gitActionOf(operation, args));
    if (operation === 'clean') return args.some((value) => value === '-n' || value === '--dry-run' || /^-[^-]*n/.test(value));
    if (operation === 'bundle') return ['list-heads', 'verify'].includes(gitActionOf(operation, args));
    if (operation === 'notes') return ['', 'list', 'show'].includes(gitActionOf(operation, args));
    if (operation === 'replace') return args.length === 0 || args.includes('--list');
    if (operation === 'sparse-checkout') return gitActionOf(operation, args) === 'list';
    if (operation === 'submodule') return ['', 'status', 'summary'].includes(gitActionOf(operation, args));
    if (operation === 'symbolic-ref') return args.filter((value) => !value.startsWith('-')).length <= 1;
    if (operation === 'hash-object') return !args.includes('-w') && !args.includes('--stdin-paths');
    if (operation === 'branch' || operation === 'tag') {
        return args.length === 0 || args.some((value) => ['--list', '-l', '-a', '--all', '-r', '--remotes'].includes(value));
    }
    if (operation === 'config') {
        const mutationFlags = new Set([
            '--add', '--edit', '--rename-section', '--remove-section',
            '--replace-all', '--unset', '--unset-all',
        ]);
        if (args.some((value) => mutationFlags.has(value))) return false;
        const readFlag = args.some((value) => /^--(?:get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope)$/.test(value));
        const positional = args.filter((value) => !value.startsWith('-'));
        if (['set', 'unset', 'rename-section', 'remove-section'].includes(positional[0])) return false;
        if (['get', 'get-all', 'get-regexp', 'get-urlmatch', 'list'].includes(positional[0])) return true;
        return readFlag || positional.length <= 1;
    }
    return false;
}

function parsedGitOperation(command) {
    if (commandHasShellSyntax(command)) return null;
    const tokens = tokenizeDirectArgv(command);
    if (!tokens?.length || !/(^|[\\/])git(?:\.exe)?$/i.test(tokens[0])) return null;
    let index = 1;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === '-C' || token === '-c' || token === '--config-env' || token === '--git-dir'
            || token === '--work-tree' || token === '--namespace') {
            index += 2;
            continue;
        }
        if (/^-C.+/.test(token) || /^--(?:git-dir|work-tree|namespace|config-env)=/.test(token)
            || ['--no-pager', '--paginate', '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'].includes(token)) {
            index++;
            continue;
        }
        break;
    }
    const operation = String(tokens[index] || '').toLowerCase();
    return operation ? { operation, args: tokens.slice(index + 1) } : null;
}

export function gitCommandMutates(value) {
    let args = value;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = { command: args }; }
    }
    const parsed = parsedGitOperation(args?.command);
    return !parsed || !gitPlanIsReadOnly(parsed);
}
