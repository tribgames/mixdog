import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
    basename,
    delimiter as pathDelimiter,
    dirname as pathDirname,
    join as pathJoin,
    resolve as pathResolveAbsolute,
} from 'node:path';
import { resolveShellFor } from './shell-runtime.mjs';

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

export const SHELL_DEPENDENCY_CANDIDATES = Object.freeze([
    'git',
    'rg',
    'jq',
    'curl',
    'wget',
    'gcc',
    'clang',
    'make',
    'cmake',
    'ninja',
    'cargo',
    'sqlite3',
    'psql',
    'docker',
    'kubectl',
    'openssl',
    'tar',
]);

export const SHELL_CAPABILITY_CANDIDATES = Object.freeze([
    ...SHELL_RUNTIME_CANDIDATES,
    ...SHELL_DEPENDENCY_CANDIDATES,
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

export function detectPathCapabilities({
    candidates = SHELL_CAPABILITY_CANDIDATES,
    ...pathOptions
} = {}) {
    const available = [];
    const unavailable = [];
    for (const name of candidates) {
        (findPathExecutable(name, pathOptions) ? available : unavailable).push(name);
    }
    return { available, unavailable };
}

export function describeShellStartupPolicy({
    os = process.platform,
    shell = null,
    // Accept a pre-computed scan so a caller emitting several startup lines
    // walks PATH once instead of once per line.
    capabilities = null,
    ...pathOptions
} = {}) {
    const { available, unavailable } = capabilities ?? detectPathCapabilities(pathOptions);
    const resolvedShell = shell || basename(String(resolveShellFor('default')?.shell || 'unknown'));
    // Shell networking is independent from the web-search tool surface:
    // applyShellEgressPolicy leaves the spawn env untouched, so package
    // managers, source-control clients, and proxies keep working even with
    // MIXDOG_FEATURE_WEB_SEARCH=0. This line therefore never claims an
    // egress block the runtime does not enforce.
    return `- Shell startup environment: OS=${os}; shell=${resolvedShell}; available=${available.join(', ') || 'none'}; unavailable=${unavailable.join(', ') || 'none'}. For shell commands, treat every unavailable entry as absent. Invoke one only if the same command first installs it or exposes it on PATH.`;
}

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
    capabilities = null,
    ...pathOptions
} = {}) {
    const installed = capabilities
        ? capabilities.available.includes('git')
        : Boolean(findPathExecutable('git', pathOptions));
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

export function appendShellStartupPolicy(rules, tools, options = {}) {
    const text = String(rules || '').trimEnd();
    if (!text || !Array.isArray(tools) || !tools.some((tool) => tool?.name === 'shell')) return text;
    return `${text}\n${describeShellStartupPolicy(options)}`;
}
