import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { basename, delimiter as pathDelimiter, join as pathJoin } from 'node:path';
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
    ...pathOptions
} = {}) {
    const { available, unavailable } = detectPathCapabilities(pathOptions);
    const resolvedShell = shell || basename(String(resolveShellFor('default')?.shell || 'unknown'));
    // Session-variable capability line: when the process-level egress block
    // is active (mixdog exec default pins MIXDOG_FEATURE_WEB_SEARCH=0 and
    // shell children get a dead proxy), say so here — the model must not
    // spend calls attempting web access that is guaranteed to fail.
    const network = String(process.env.MIXDOG_FEATURE_WEB_SEARCH || '') === '0'
        ? ' network=offline (external egress blocked for every command — curl/wget/pip/apt/git included; only loopback services are reachable; never attempt web access).'
        : '';
    return `- Shell startup environment: OS=${os}; shell=${resolvedShell}; available=${available.join(', ') || 'none'}; unavailable=${unavailable.join(', ') || 'none'}.${network} For shell commands, treat every unavailable entry as absent. Invoke one only if the same command first installs it or exposes it on PATH.`;
}

export function appendShellStartupPolicy(rules, tools, options = {}) {
    const text = String(rules || '').trimEnd();
    if (!text || !Array.isArray(tools) || !tools.some((tool) => tool?.name === 'shell')) return text;
    return `${text}\n${describeShellStartupPolicy(options)}`;
}
