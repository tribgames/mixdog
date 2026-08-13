import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter as pathDelimiter, isAbsolute, join as pathJoin, resolve as pathResolve } from 'node:path';
import { hasPowerShellOnlySyntax } from './shell-analysis.mjs';

// Windows+pwsh only. A simple native .exe (git status, node -e) skips the
// ~330ms pwsh/.NET/AMSI startup. Anything that needs a shell stays on pwsh:
// operators, expansion, cmdlets, aliases, and .cmd/.bat/.ps1 wrappers.

const DIRECT_EXE_DISABLED = /^(0|false|no|off)$/i;

// PowerShell aliases / language heads whose meaning would change if we
// resolved a same-named .exe (Git usr\bin\ls.exe vs Get-ChildItem).
const POWERSHELL_RESERVED_HEADS = new Set([
    'cat', 'cd', 'chdir', 'clear', 'cls', 'copy', 'cp', 'del', 'diff', 'dir',
    'echo', 'erase', 'foreach', 'help', 'history', 'kill', 'ls', 'man', 'md',
    'measure', 'mkdir', 'mount', 'move', 'mv', 'popd', 'ps', 'pushd', 'pwd',
    'ren', 'rename', 'rm', 'rmdir', 'select', 'set', 'sleep', 'sort', 'start',
    'tee', 'type', 'where', 'write',
    'gal', 'gc', 'gci', 'gi', 'gp', 'gsv', 'ii', 'ni', 'ri', 'sal', 'sc',
    'si', 'sl', 'sls', 'sp', 'sv',
    'begin', 'break', 'catch', 'continue', 'else', 'elseif', 'end', 'exit',
    'filter', 'finally', 'function', 'if', 'param', 'process', 'return',
    'switch', 'throw', 'trap', 'try', 'until', 'while', 'workflow',
]);

function _headName(token) {
    return String(token || '').replace(/\.exe$/i, '').split(/[\\/]/).pop().toLowerCase();
}

function _isCmdLetName(token) {
    return /^[A-Za-z]+-[A-Za-z]+$/.test(String(token || ''));
}

function _disabledByEnv(env) {
    return DIRECT_EXE_DISABLED.test(String(env?.MIXDOG_SHELL_DIRECT_EXE ?? '').trim());
}

// Quote-aware argv split for native CreateProcess. Unlike shellTokenize this
// keeps Windows backslashes literal so `C:\foo\bar.exe` is one path token.
export function tokenizeDirectArgv(command) {
    const text = String(command || '');
    const tokens = [];
    let current = '';
    let quote = null;
    let started = false;
    const push = () => {
        if (started) tokens.push(current);
        current = '';
        started = false;
    };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote === '"') {
            if (ch === '\\' && text[i + 1] === '"') {
                current += '"';
                i += 1;
                continue;
            }
            if (ch === '"') {
                quote = null;
                continue;
            }
            current += ch;
            continue;
        }
        if (quote === "'") {
            if (ch === "'") {
                quote = null;
                continue;
            }
            current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            started = true;
            continue;
        }
        if (/\s/.test(ch)) {
            push();
            continue;
        }
        current += ch;
        started = true;
    }
    if (quote) return null;
    push();
    return tokens;
}

// Operators / expansion that require the host shell. Single-quoted regions
// stay literal (same as pwsh). Double-quoted `$` / backtick would expand.
export function commandNeedsShell(command) {
    const text = String(command || '');
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote === "'") {
            if (ch === "'") quote = null;
            continue;
        }
        if (quote === '"') {
            if (ch === '"') {
                quote = null;
                continue;
            }
            if (ch === '`' || ch === '$') return true;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if ('|&;<>()\n\r{}'.includes(ch) || ch === '`') return true;
        if ('*?[]'.includes(ch)) return true;
        if (ch === '$') return true;
        if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return true;
    }
    return quote != null;
}

function _isUsableExe(file) {
    try {
        if (!/\.exe$/i.test(file)) return false;
        if (!statSync(file).isFile()) return false;
        accessSync(file, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

export function resolveDirectExe(token, {
    cwd = process.cwd(),
    pathValue = process.env.PATH || '',
    maxDirectories = 64,
} = {}) {
    const name = String(token || '').trim();
    if (!name || /[\0]/.test(name)) return null;
    if (/\.(cmd|bat|ps1|com)$/i.test(name)) return null;
    const baseCwd = cwd || process.cwd();
    if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) {
        const resolved = isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)
            ? name
            : pathResolve(baseCwd, name);
        return _isUsableExe(resolved) ? resolved : null;
    }
    const fileName = /\.exe$/i.test(name) ? name : `${name}.exe`;
    const seen = new Set();
    const dirs = [baseCwd, ...String(pathValue || '').split(pathDelimiter)];
    for (const dir of dirs) {
        if (!dir) continue;
        const key = dir.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > maxDirectories + 1) break;
        const candidate = pathJoin(dir, fileName);
        if (_isUsableExe(candidate)) return candidate;
    }
    return null;
}

export function planDirectExeSpawn(command, {
    platform = process.platform,
    shellType = 'powershell',
    cwd = process.cwd(),
    pathValue = process.env.PATH || '',
    env = process.env,
} = {}) {
    if (platform !== 'win32' || shellType !== 'powershell') return null;
    if (_disabledByEnv(env)) return null;
    const text = String(command || '').trim();
    if (!text || commandNeedsShell(text) || hasPowerShellOnlySyntax(text)) return null;
    const tokens = tokenizeDirectArgv(text);
    if (!tokens || tokens.length === 0) return null;
    if (tokens.includes('--%')) return null;
    const head = tokens[0];
    const headName = _headName(head);
    if (!headName || POWERSHELL_RESERVED_HEADS.has(headName) || _isCmdLetName(head)) return null;
    const exe = resolveDirectExe(head, { cwd, pathValue });
    if (!exe) return null;
    return { exe, argv: tokens.slice(1) };
}
