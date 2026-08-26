import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
    delimiter as pathDelimiter,
    dirname as pathDirname,
    join as pathJoin,
    resolve as pathResolveAbsolute,
} from 'node:path';

export const SHELL_RUNTIME_CANDIDATES = Object.freeze([
    'node',
    'python3',
    'python',
    'py',
    'deno',
    'bun',
    'perl',
    'ruby',
    'php',
    'lua',
    'Rscript',
    'java',
    'go',
    'rustc',
    'dotnet',
    'pwsh',
    'powershell',
    'bash',
]);

function _pathDirectory(value) {
    const text = String(value || '').trim();
    return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
        ? text.slice(1, -1)
        : text;
}

function _executableNames(name, platform) {
    const text = String(name || '').trim();
    if (!text) return [];
    if (platform !== 'win32' || /\.(?:exe|cmd|bat|com)$/i.test(text)) return [text];
    return [text, `${text}.exe`, `${text}.cmd`, `${text}.bat`, `${text}.com`];
}

export function findPathExecutable(name, {
    pathValue = process.env.PATH || '',
    platform = process.platform,
    maxDirectories = 64,
} = {}) {
    const names = _executableNames(name, platform);
    if (!names.length) return null;
    const seenDirectories = new Set();
    for (const rawDirectory of String(pathValue).split(pathDelimiter)) {
        const directory = _pathDirectory(rawDirectory);
        if (!directory) continue;
        const key = platform === 'win32' ? directory.toLowerCase() : directory;
        if (seenDirectories.has(key)) continue;
        seenDirectories.add(key);
        if (seenDirectories.size > maxDirectories) break;
        for (const executable of names) {
            const file = pathJoin(directory, executable);
            try {
                if (!statSync(file).isFile()) continue;
                accessSync(file, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
                return `${executable} (${directory.replace(/\\/g, '/')})`;
            } catch {}
        }
    }
    return null;
}

// A startup PATH inventory is deliberately not rendered into the prompt: it
// would be measured in this process's PATH while commands run under the
// login-shell snapshot (shell-snapshot.mjs), which does not exist until the
// first shell call, and it would freeze at session start while an install
// during the session changes the answer. bash-tool's _exitClassDiagnostic
// reports a missing command after it has run, from the environment that ran it.

// Walk up for a `.git` marker instead of shelling out to `git rev-parse`: it
// costs no process spawn, and it still answers on images where the git binary
// is absent. `.git` is a directory in a normal clone and a file in a worktree
// or submodule, so both count as "inside a repository".
export function findRepositoryRoot(startDirectory, { maxDepth = 64 } = {}) {
    let current;
    try {
        current = pathResolveAbsolute(String(startDirectory || '.'));
    } catch {
        return null;
    }
    for (let depth = 0; depth < maxDepth; depth += 1) {
        const marker = pathJoin(current, '.git');
        try {
            const stats = statSync(marker);
            return { root: current, gitDirectory: stats.isDirectory() ? marker : null };
        } catch {}
        const parent = pathDirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

function _headBranch(gitDirectory) {
    if (!gitDirectory) return null;
    try {
        const head = readFileSync(pathJoin(gitDirectory, 'HEAD'), 'utf8').trim();
        // Detached HEAD holds a raw object id and names no branch.
        return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
    } catch {
        return null;
    }
}

function _repositoryChangeState(root) {
    try {
        const result = spawnSync('git', [
            '--no-optional-locks',
            '-C',
            root,
            'status',
            '--porcelain=v1',
            '--untracked-files=normal',
        ], {
            encoding: 'utf8',
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
            maxBuffer: 64 * 1024,
            timeout: 1500,
            windowsHide: true,
        });
        const output = String(result.stdout || '').trim();
        if (result.status === 0) return output ? 'changes present' : 'clean';
        if (result.error?.code === 'ENOBUFS' && output) return 'changes present';
    } catch {}
    return null;
}

// Startup snapshot, same contract as the shell line above: it states what was
// true when the session opened, not a permanent rule. `git init` or a move to
// another directory changes it, which is why this reports the observation
// rather than forbidding calls.
export function describeGitStartupState({
    cwd = process.cwd(),
    ...pathOptions
} = {}) {
    const installed = Boolean(findPathExecutable('git', pathOptions));
    if (!installed) {
        return '- Git startup state: git is not installed here; git tool calls fail until something installs it.';
    }
    const found = findRepositoryRoot(cwd);
    if (!found) {
        return `- Git startup state: ${cwd} was not inside a git repository at startup; git commands that require one fail until a repository exists.`;
    }
    const branch = _headBranch(found.gitDirectory);
    const changeState = _repositoryChangeState(found.root);
    return `- Git startup state: repository root ${found.root}${branch ? ` on branch ${branch}` : ' with a detached HEAD'}${changeState ? `; ${changeState}` : ''}.`;
}

export function appendGitStartupState(rules, tools, options = {}) {
    const text = String(rules || '').trimEnd();
    if (!text || !Array.isArray(tools) || !tools.some((tool) => tool?.name === 'git')) return text;
    return `${text}\n${describeGitStartupState(options)}`;
}
