import { basename, resolve } from 'node:path';
import { tokenizeDirectArgv } from './shell-direct-exe.mjs';
import { withBuiltinPathLocks } from './path-locks.mjs';
import { withAdvisoryLocks } from './advisory-lock.mjs';
import { withGitRepoReadLock, withGitRepoWriteLock } from './git-repo-rw-lock.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { drainCodeGraphCache } from '../code-graph-state.mjs';
import { ensureNativeSpawnServer, tryNativeSpawn } from '../lib/native-spawn-client.mjs';
import { gitActionOf as actionOf, gitPlanIsReadOnly as isReadOnly } from './git-command-policy.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const SUPPORTED = new Set([
    'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle',
    'cat-file', 'check-attr', 'check-ignore', 'check-ref-format', 'checkout',
    'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'config',
    'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree',
    'fetch', 'filter-branch', 'for-each-ref', 'format-patch', 'fsck', 'gc',
    'grep', 'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote',
    'ls-tree', 'maintenance', 'merge', 'merge-base', 'merge-tree', 'mv',
    'name-rev', 'notes', 'pack-refs', 'prune', 'pull', 'push', 'range-diff',
    'rebase', 'reflog', 'remote', 'repack', 'replace', 'reset', 'restore',
    'revert', 'rev-list', 'rev-parse', 'rm', 'shortlog', 'show', 'show-branch',
    'show-ref', 'sparse-checkout', 'stash', 'status', 'submodule', 'switch',
    'symbolic-ref', 'tag', 'update-ref', 'verify-commit', 'verify-pack',
    'verify-tag', 'whatchanged', 'worktree', 'write-tree',
]);
const PUSH_NOISE = [
    'Enumerating objects:', 'Counting objects:', 'Compressing objects:',
    'Writing objects:', 'Delta compression using', 'Total ',
];

export const GIT_TOOL_DEF = {
    name: 'git',
    title: 'Git',
    annotations: {
        title: 'Git',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        compressible: true,
    },
    description: 'Run one normal git command without a shell. Pipes, redirection, chaining, and substitution are rejected. Success output is compacted; destructive commands require confirm:true.',
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Full command beginning with git; quote arguments as in a shell.' },
            confirm: { type: 'boolean', description: 'Required for destructive commands.' },
            output_limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Item/line cap; default 50, log 10.' },
        },
        required: ['command'],
        additionalProperties: false,
    },
};

function cleanText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trimEnd();
}

function truncateLine(value, max = 2000) {
    const line = String(value || '');
    return line.length <= max ? line : `${line.slice(0, max)}…[${line.length - max} chars omitted]`;
}

function cappedLines(value, max = 50, skip = () => false) {
    const rows = cleanText(value).split('\n').map((line) => line.trimEnd()).filter((line) => line && !skip(line));
    return { lines: rows.slice(0, max).map((line) => truncateLine(line)), omitted: Math.max(0, rows.length - max) };
}

function compactOrRaw(raw, compact) {
    const output = cleanText(raw);
    if (!output) return compact;
    const fallback = { output };
    return JSON.stringify(compact).length < JSON.stringify(fallback).length ? compact : fallback;
}

function ok(data = {}) {
    return JSON.stringify({ ok: true, ...(data && typeof data === 'object' && !Array.isArray(data) ? data : { output: data }) });
}

function fail(message, detail = null) {
    return `Error: ${message}${detail ? `\n${JSON.stringify({ ok: false, ...detail })}` : ''}`;
}

function commandHasShellSyntax(command) {
    const text = String(command || '');
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote === "'") {
            if (ch === "'") quote = null;
            continue;
        }
        if (quote === '"') {
            if (ch === '\\' && text[i + 1] === '"') { i++; continue; }
            if (ch === '"') { quote = null; continue; }
            if (ch === '$' || ch === '`') return true;
            continue;
        }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if ('|&;<>()\n\r'.includes(ch) || ch === '$' || ch === '`') return true;
    }
    return quote !== null;
}

function parseCommand(command, workDir) {
    if (commandHasShellSyntax(command)) throw new Error('git command must not contain shell operators or substitution');
    const tokens = tokenizeDirectArgv(command);
    if (!tokens?.length || !/(^|[\\/])git(?:\.exe)?$/i.test(tokens[0])) {
        throw new Error('command must begin with git');
    }
    let cwd = resolve(workDir || process.cwd());
    const globalArgs = [];
    let index = 1;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === '-C') {
            const path = tokens[++index];
            if (!path) throw new Error('git -C requires a path');
            cwd = resolve(cwd, path);
            index++;
            continue;
        }
        if (token.startsWith('-C') && token.length > 2) {
            cwd = resolve(cwd, token.slice(2));
            index++;
            continue;
        }
        if (token === '-c' || token === '--config-env' || token === '--git-dir' || token === '--work-tree' || token === '--namespace') {
            const value = tokens[index + 1];
            if (!value) throw new Error(`${token} requires a value`);
            globalArgs.push(token, value);
            index += 2;
            continue;
        }
        if (/^--(?:git-dir|work-tree|namespace|config-env)=/.test(token)
            || ['--no-pager', '--paginate', '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'].includes(token)) {
            globalArgs.push(token);
            index++;
            continue;
        }
        break;
    }
    const operation = String(tokens[index] || '').toLowerCase();
    if (!SUPPORTED.has(operation)) throw new Error(`unsupported git subcommand: ${operation || '(missing)'}`);
    return { command: String(command), cwd, globalArgs, operation, args: tokens.slice(index + 1) };
}

async function runProcess(program, argv, { cwd, signal, maxBytes = MAX_CAPTURE_BYTES } = {}) {
    let child;
    try {
        await ensureNativeSpawnServer();
        const native = tryNativeSpawn({
            shell: program,
            argv,
            spawnOptions: {
                cwd,
                env: {
                    ...process.env,
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_PAGER: 'cat',
                    GIT_EDITOR: 'true',
                    GIT_SEQUENCE_EDITOR: 'true',
                    LC_ALL: 'C',
                },
                outputLimit: maxBytes,
            },
        });
        if (!native?.child) throw Object.assign(new Error('verified native spawn server unavailable'), { code: 'NATIVE_SPAWN_UNAVAILABLE' });
        child = native.child;
    } catch (error) {
        return { exitCode: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error, timedOut: false, aborted: false, overflow: false };
    }
    return new Promise((done) => {
        const stdout = [], stderr = [];
        let bytes = 0, timedOut = false, aborted = false, overflow = false, settled = false;
        const stop = () => { try { child.kill('SIGKILL'); } catch {} };
        const finish = (exitCode, exitSignal, error = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            done({ exitCode, signal: exitSignal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error, timedOut, aborted, overflow });
        };
        const take = (bucket, chunk) => {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxBytes) { overflow = true; stop(); return; }
            bucket.push(buffer);
        };
        child.stdout.on('data', (chunk) => take(stdout, chunk));
        child.stderr.on('data', (chunk) => take(stderr, chunk));
        child.once('error', (error) => finish(null, null, error));
        child.once('close', (code, exitSignal) => finish(code, exitSignal));
        const timer = setTimeout(() => { timedOut = true; stop(); }, DEFAULT_TIMEOUT_MS);
        timer.unref?.();
        const onAbort = () => { aborted = true; stop(); };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

function succeeded(result) {
    return result?.exitCode === 0 && !result.error && !result.timedOut && !result.aborted && !result.overflow;
}

function commandFailure(plan, result) {
    const reason = result.error
        ? `git process failed (${result.error.code || result.error.message || result.error})`
        : result.aborted ? 'git command aborted'
            : result.timedOut ? 'git command timed out'
                : result.overflow ? 'git output exceeded 128 MiB'
                    : `git ${plan.operation} exited ${result.exitCode}`;
    return fail(reason, {
        exit: result.exitCode,
        signal: result.signal,
        stderr: cleanText(result.stderr),
        stdout: cleanText(result.stdout),
    });
}

function runGit(plan, argv, options = {}) {
    return runProcess('git', [...plan.globalArgs, ...argv], { cwd: plan.cwd, signal: options.signal });
}

function destructiveReason(plan) {
    const { operation, args } = plan;
    if (operation === 'reset' && args.includes('--hard')) return 'git reset --hard';
    if (operation === 'clean' && args.some((value) => value === '--force' || /^-[^-]*f/.test(value))) return 'git clean --force';
    if (operation === 'gc' && args.some((value) => value === '--prune=now' || value === '--aggressive')) return `git gc ${args.find((value) => value.startsWith('--prune') || value === '--aggressive')}`;
    if (operation === 'prune') return 'git prune';
    if (operation === 'filter-branch') return 'git filter-branch';
    if (operation === 'update-ref' && args.includes('-d')) return 'git update-ref -d';
    if (operation === 'symbolic-ref' && args.includes('--delete')) return 'git symbolic-ref --delete';
    if (operation === 'reflog' && ['delete', 'expire'].includes(actionOf(operation, args))) return `git reflog ${actionOf(operation, args)}`;
    if (operation === 'push' && args.some((value) => value.startsWith('--force') || value.startsWith('+'))) return 'git push --force';
    if (operation === 'branch' && args.some((value) => value === '-D' || value === '--delete-force')) return 'git branch -D';
    if (operation === 'commit' && args.includes('--amend')) return 'git commit --amend';
    if (operation === 'stash' && actionOf(operation, args) === 'clear') return 'git stash clear';
    if (operation === 'worktree' && actionOf(operation, args) === 'remove' && args.includes('--force')) return 'git worktree remove --force';
    if (['checkout', 'switch'].includes(operation) && args.some((value) => value === '-f' || value === '--force' || value === '--discard-changes')) return `git ${operation} --force`;
    return null;
}

function hasOutputFormat(args) {
    return args.some((value) => /^(?:--format|--pretty)(?:=|$)/.test(value) || value === '--oneline');
}

function hasLogLimit(args) {
    return args.some((value) => /^-\d+$/.test(value) || value === '-n' || value === '--max-count' || value.startsWith('--max-count='));
}

function prepare(plan, limit) {
    const args = [...plan.args];
    const operation = plan.operation;
    if (operation === 'status' && args.every((value) => ['-s', '--short', '-b', '--branch', '-sb', '-bs'].includes(value))) {
        return { argv: ['status', '--porcelain=v1', '-b', '--untracked-files=normal'], format: 'status', action: 'list' };
    }
    if (['diff', 'diff-files', 'diff-index', 'diff-tree'].includes(operation)) {
        return { argv: [operation, '--no-ext-diff', '--no-color', ...args], format: 'diff', action: 'list' };
    }
    if (operation === 'log' && !hasOutputFormat(args)) {
        const limitArgs = hasLogLimit(args) ? [] : [`-n${limit}`];
        return {
            argv: ['log', ...limitArgs, '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e', ...args],
            format: 'log',
            action: 'list',
        };
    }
    if (operation === 'show') {
        const blob = args.some((value) => !value.startsWith('-') && value.includes(':'));
        const explicit = hasOutputFormat(args) || args.some((value) => /^(?:--stat|--numstat|--shortstat|--name-only|--name-status)$/.test(value));
        if (!blob && !explicit) {
            return { argv: ['show', '--no-color', '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s%n', ...args], format: 'show', action: 'list' };
        }
    }
    if (operation === 'for-each-ref' && !args.some((value) => value.startsWith('--format'))) {
        return {
            argv: ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream:short)%00%(subject)', ...args],
            format: 'refs',
            action: 'list',
        };
    }
    if (operation === 'reflog' && isReadOnly(plan) && !args.some((value) => value.startsWith('--format'))) {
        const action = actionOf(operation, args);
        const rest = action === 'show' && args[0] === 'show' ? args.slice(1) : args;
        const limitArgs = hasLogLimit(rest) ? [] : [`-n${limit}`];
        return {
            argv: ['reflog', 'show', ...limitArgs, '--date=iso-strict', '--format=%gD%x00%H%x00%gs', ...rest],
            format: 'reflog',
            action: 'show',
        };
    }
    return { argv: [operation, ...args], format: operation, action: actionOf(operation, args), raw: true };
}

function parseStatus(text) {
    const lines = cleanText(text).split('\n').filter(Boolean);
    const branch = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : null;
    return {
        branch,
        clean: lines.length === 0,
        changes: lines.map((line) => ({ index: line[0] || ' ', worktree: line[1] || ' ', path: line.slice(3) })),
    };
}

function statusSummary(snapshot) {
    let staged = 0, unstaged = 0, untracked = 0, conflicted = 0;
    for (const row of snapshot?.changes || []) {
        if (row.index === '?' && row.worktree === '?') untracked++;
        else {
            if (row.index !== ' ') staged++;
            if (row.worktree !== ' ') unstaged++;
            if ('UAD'.includes(row.index) && 'UAD'.includes(row.worktree)) conflicted++;
        }
    }
    return { branch: snapshot?.branch || null, clean: snapshot?.clean === true, staged, unstaged, untracked, conflicted };
}

async function statusSnapshot(repo, signal) {
    const plan = { cwd: repo, globalArgs: [] };
    const result = await runGit(plan, ['status', '--porcelain=v1', '-b', '--untracked-files=normal'], { signal });
    return succeeded(result) ? parseStatus(result.stdout) : { error: true, changes: [] };
}

function statusDelta(before, after, limit) {
    const left = new Map((before?.changes || []).map((row) => [row.path, `${row.index}${row.worktree}`]));
    const right = new Map((after?.changes || []).map((row) => [row.path, `${row.index}${row.worktree}`]));
    const changed = [];
    for (const path of new Set([...left.keys(), ...right.keys()])) {
        const from = left.get(path) || null, to = right.get(path) || null;
        if (from !== to) changed.push({ path, from, to });
    }
    return {
        before: statusSummary(before),
        after: statusSummary(after),
        changed: changed.slice(0, limit),
        omitted: Math.max(0, changed.length - limit),
    };
}

function compactDiff(raw, limit) {
    const shown = [], files = [];
    let additions = 0, deletions = 0, omitted = 0, inHunk = false, hunkLines = 0;
    const push = (line) => shown.length < limit ? shown.push(truncateLine(line)) : omitted++;
    for (const line of cleanText(raw).split('\n')) {
        if (line.startsWith('diff --git ')) {
            const path = line.split(' b/')[1] || line.slice(11);
            if (!files.includes(path)) files.push(path);
            push(`file ${path}`);
            inHunk = false;
            hunkLines = 0;
            continue;
        }
        if (line.startsWith('@@')) { push(line); inHunk = true; hunkLines = 0; continue; }
        if (/^(Binary files |GIT binary patch|new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to )/.test(line)) {
            push(line);
            continue;
        }
        if (!inHunk || line.startsWith('\\')) continue;
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
        if (hunkLines++ < 100) push(line);
        else omitted++;
    }
    return { files, additions, deletions, patch: shown.join('\n'), truncated: omitted > 0, ...(omitted ? { omittedLines: omitted } : {}) };
}

function parseWorktrees(text, limit) {
    const rows = [];
    for (const block of cleanText(text).split(/\n\n+/)) {
        if (!block.trim()) continue;
        const row = {};
        for (const line of block.split('\n')) {
            const [key, ...rest] = line.split(' ');
            const value = rest.join(' ');
            if (key === 'worktree') row.path = resolve(value);
            else if (key === 'HEAD') row.oid = value;
            else if (key === 'branch') row.branch = value.replace(/^refs\/heads\//, '');
            else if (['detached', 'bare', 'locked', 'prunable'].includes(key)) row[key] = value || true;
        }
        rows.push(row);
    }
    return { worktrees: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit) };
}

function formatRead(prepared, stdout, stderr, limit) {
    const { format, action, raw } = prepared;
    let data;
    if (format === 'status' && !raw) {
        const snapshot = parseStatus(stdout);
        data = { ...statusSummary(snapshot), changes: snapshot.changes.slice(0, limit), omitted: Math.max(0, snapshot.changes.length - limit) };
    } else if (format === 'diff') {
        data = compactOrRaw(stdout, compactDiff(stdout, limit));
    } else if (format === 'log' && !raw) {
        const commits = cleanText(stdout).split('\x1e').map((row) => row.trim()).filter(Boolean).map((row) => {
            const [oid, short, author, date, subject, body = ''] = row.split('\x1f');
            const bodyLines = body.split('\n').map((line) => line.trim()).filter((line) => line && !/^(Signed-off-by|Co-authored-by):/i.test(line));
            return {
                oid, short, author, date, subject: truncateLine(subject, 240),
                ...(bodyLines.length ? { body: bodyLines.slice(0, 3).map((line) => truncateLine(line, 240)), omittedBodyLines: Math.max(0, bodyLines.length - 3) } : {}),
            };
        });
        data = { commits };
    } else if (format === 'show' && !raw) {
        const records = stdout.split('\x1e').map((row) => row.trim()).filter(Boolean);
        const commits = records.map((record) => {
            const split = record.indexOf('\n');
            const [oid, short, author, date, subject] = record.slice(0, split).split('\x1f');
            return { commit: { oid, short, author, date, subject }, diff: compactDiff(record.slice(split + 1), limit) };
        });
        data = commits.length === 1 ? commits[0] : { commits };
    } else if (format === 'refs' && !raw) {
        const refs = cleanText(stdout).split('\n').filter(Boolean).slice(0, limit).map((line) => {
            const [name, oid, type, upstream, subject] = line.split('\0');
            return { name, oid, type, upstream: upstream || null, subject: truncateLine(subject, 240) };
        });
        data = { refs, omitted: Math.max(0, cleanText(stdout).split('\n').filter(Boolean).length - refs.length) };
    } else if (format === 'reflog' && !raw) {
        const entries = cleanText(stdout).split('\n').filter(Boolean).slice(0, limit).map((line) => {
            const [selector, oid, subject] = line.split('\0');
            return { selector, oid, subject: truncateLine(subject, 240) };
        });
        data = { entries };
    } else if (format === 'branch') {
        const rows = cappedLines(stdout, limit);
        data = compactOrRaw(stdout, {
            branches: rows.lines.map((line) => ({ current: line.startsWith('* '), linked: line.startsWith('+ '), name: line.replace(/^[*+ ]+/, '') })),
            omitted: rows.omitted,
        });
    } else if (format === 'stash' && action === 'list') {
        const rows = cappedLines(stdout, limit);
        data = compactOrRaw(stdout, { stashes: rows.lines, omitted: rows.omitted });
    } else if (format === 'worktree' && action === 'list') {
        data = compactOrRaw(stdout, parseWorktrees(stdout, limit));
    } else if (format === 'remote' && (action === 'list' || action === '-v')) {
        const remotes = {};
        for (const line of cleanText(stdout).split('\n')) {
            const [name, url, kind] = line.split(/\s+/);
            if (!name || !url) continue;
            remotes[name] ||= {};
            remotes[name][kind === '(push)' ? 'push' : 'fetch'] = url;
        }
        data = compactOrRaw(stdout, { remotes });
    } else {
        data = compactOrRaw(stdout, cappedLines(stdout, limit));
    }
    const warning = cleanText(stderr);
    if (warning) data.stderr = cappedLines(warning, Math.min(limit, 20));
    return data;
}

function mutationSummary(plan, stdout, stderr) {
    const combined = cleanText([stdout, stderr].filter(Boolean).join('\n'));
    if (plan.operation === 'init') return 'initialized';
    if (plan.operation === 'clone') return 'cloned';
    if (plan.operation === 'commit') {
        const oid = cleanText(stdout).split('\n')[0]?.match(/\b([0-9a-f]{7,40})\b/)?.[1];
        return oid ? `committed ${oid.slice(0, 12)}` : 'committed';
    }
    if (plan.operation === 'add') return 'staged';
    if (plan.operation === 'push') {
        if (/Everything up-to-date/i.test(combined)) return 'up-to-date';
        const destination = combined.match(/ -> ([^\s]+)/)?.[1];
        return destination ? `pushed ${destination}` : 'pushed';
    }
    if (plan.operation === 'fetch') {
        const count = combined.split('\n').filter((line) => line.includes(' -> ') || line.includes('[new ')).length;
        return count ? `fetched ${count} refs` : 'fetched';
    }
    if (plan.operation === 'pull') {
        if (/Already up[- ]to[- ]date/i.test(combined)) return 'up-to-date';
        const files = Number(combined.match(/(\d+) files? changed/)?.[1] || 0);
        const adds = Number(combined.match(/(\d+) insertions?\(\+\)/)?.[1] || 0);
        const dels = Number(combined.match(/(\d+) deletions?\(-\)/)?.[1] || 0);
        return files ? `pulled ${files} files +${adds} -${dels}` : 'pulled';
    }
    if (plan.operation === 'stash' && actionOf('stash', plan.args) === 'push') {
        return /No local changes/i.test(combined) ? 'no local changes' : 'stashed';
    }
    return 'ok';
}

function mutationData(plan, stdout, stderr, limit) {
    const summary = mutationSummary(plan, stdout, stderr);
    const stderrOnly = ['add', 'commit', 'fetch'].includes(plan.operation)
        || plan.operation === 'pull'
        || (plan.operation === 'stash' && actionOf('stash', plan.args) === 'push');
    const source = stderrOnly ? stderr : [stdout, stderr].filter(Boolean).join('\n');
    const skip = plan.operation === 'push'
        ? (line) => PUSH_NOISE.some((prefix) => line.trimStart().startsWith(prefix))
        : plan.operation === 'clone'
            ? (line) => /^(Cloning into|remote:|Receiving objects:|Resolving deltas:)/.test(line.trimStart())
            : plan.operation === 'init'
                ? (line) => line.trimStart().startsWith('hint:')
                : () => false;
    const rows = cappedLines(source, Math.min(limit, 20), skip);
    return { summary, ...(rows.lines.length ? { output: rows.lines } : {}), ...(rows.omitted ? { omittedOutputLines: rows.omitted } : {}) };
}

async function resolveRepo(plan, signal) {
    const result = await runGit(plan, ['rev-parse', '--show-toplevel'], { signal });
    return succeeded(result) ? cleanText(result.stdout) : null;
}

function localizeConfigPlan(plan) {
    if (plan.operation !== 'config') return plan;
    const external = plan.args.find((value) => ['--global', '--system', '--file', '-f'].includes(value)
        || value.startsWith('--file=')
        || (/^-f./.test(value) && !value.startsWith('--')));
    if (external) throw new Error(`git config ${external} is outside the local repository scope`);
    if (plan.args.some((value) => value === '--local' || value === '--worktree')) return plan;
    return { ...plan, args: ['--local', ...plan.args] };
}

function optionFreePositionals(args) {
    const takesValue = new Set([
        '-b', '--branch', '-c', '--config', '--depth', '-j', '--jobs', '-o',
        '--origin', '--reference', '--reference-if-able', '--separate-git-dir',
        '--template', '-u', '--upload-pack', '--filter', '--server-option',
        '--shallow-since', '--shallow-exclude', '--bundle-uri', '--revision',
        '--ref-format', '--object-format', '--initial-branch',
    ]);
    const out = [];
    for (let index = 0; index < args.length; index++) {
        const value = args[index];
        if (value === '--') {
            out.push(...args.slice(index + 1));
            break;
        }
        if (takesValue.has(value)) { index++; continue; }
        if (value.startsWith('-')) continue;
        out.push(value);
    }
    return out;
}

function creationTarget(plan) {
    const positional = optionFreePositionals(plan.args);
    if (plan.operation === 'init') return resolve(plan.cwd, positional.at(-1) || '.');
    if (plan.operation !== 'clone') return plan.cwd;
    if (positional.length >= 2) return resolve(plan.cwd, positional.at(-1));
    const source = String(positional[0] || '').replace(/[\\/]+$/, '');
    const leaf = basename(source.includes(':') ? source.slice(source.lastIndexOf(':') + 1) : source).replace(/\.git$/i, '') || 'repo';
    return resolve(plan.cwd, leaf);
}

async function executeCreation(plan, target, limit, signal) {
    return withBuiltinPathLocks([target], () => withAdvisoryLocks([target], async () => {
        const result = await runGit(plan, [plan.operation, ...plan.args], { signal });
        if (!succeeded(result)) return commandFailure(plan, result);
        invalidateBuiltinResultCache();
        drainCodeGraphCache();
        return ok(mutationData(plan, cleanText(result.stdout), cleanText(result.stderr), limit));
    }));
}

export async function executeGitTool(input, workDir, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('git requires an arguments object');
    let plan;
    try { plan = localizeConfigPlan(parseCommand(input.command, workDir)); }
    catch (error) { return fail(error.message); }
    if (plan.operation === 'archive' && !plan.args.some((value) => value === '-o' || value === '--output' || value.startsWith('--output='))) {
        return fail('git archive requires -o/--output; binary stdout is not returned');
    }
    const limitDefault = plan.operation === 'log' ? 10 : 50;
    const limit = Math.min(500, Math.max(1, Number(input.output_limit) || limitDefault));
    const reason = destructiveReason(plan);
    if (reason && input.confirm !== true) return fail(`${reason} requires confirm:true`);
    const signal = options?.signal || options?.abortSignal || null;
    if (plan.operation === 'init' || plan.operation === 'clone') {
        const target = creationTarget(plan);
        return withGitRepoWriteLock(target, () => executeCreation(plan, target, limit, signal), { signal });
    }
    const repo = await resolveRepo(plan, signal);
    if (!repo) {
        const probe = await runGit(plan, ['rev-parse', '--show-toplevel'], { signal });
        return commandFailure({ ...plan, operation: 'rev-parse' }, probe);
    }
    const prepared = prepare(plan, limit);
    if (isReadOnly(plan)) {
        return withGitRepoReadLock(repo, async () => {
            const result = await runGit(plan, prepared.argv, { signal });
            if (!succeeded(result)) return commandFailure(plan, result);
            return ok(formatRead(prepared, cleanText(result.stdout), cleanText(result.stderr), limit));
        }, { signal });
    }
    return withGitRepoWriteLock(repo, () => withBuiltinPathLocks([repo], () => withAdvisoryLocks([repo], async () => {
        const before = await statusSnapshot(repo, signal);
        const result = await runGit(plan, prepared.argv, { signal });
        const after = await statusSnapshot(repo, signal);
        invalidateBuiltinResultCache();
        drainCodeGraphCache();
        if (!succeeded(result)) return `${commandFailure(plan, result)}\n${JSON.stringify({ status: statusDelta(before, after, limit) })}`;
        return ok({ ...mutationData(plan, cleanText(result.stdout), cleanText(result.stderr), limit), status: statusDelta(before, after, limit) });
    })), { signal });
}

export const _gitCommandInternals = { creationTarget, localizeConfigPlan, parseCommand };
