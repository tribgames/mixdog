import { statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import {
    normalizeInputPath,
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';

export function literalPathHint(rawPath) {
    const s = String(rawPath || '');
    if (/\$env:[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%/.test(s)) {
        return ' Path fields do not expand shell environment variables; pass the resolved absolute path.';
    }
    if (process.platform === 'win32' && /^[A-Za-z]:[^\\/]/.test(s)) {
        return ' Windows drive-relative paths like C:Project are ambiguous; use C:/Project or C:\\Project.';
    }
    return '';
}

export function resolveOptionalCwd(rawCwd, baseCwd) {
    if (typeof rawCwd !== 'string' || rawCwd.trim() === '') {
        return { cwd: baseCwd };
    }
    const normalized = normalizeInputPath(rawCwd.trim());
    const resolved = isAbsolute(normalized) ? resolve(normalized) : resolveAgainstCwd(normalized, baseCwd);
    try {
        const st = statSync(resolved);
        if (!st.isDirectory()) {
            return { error: `Error: cwd is not a directory: ${normalizeOutputPath(resolved)}.${literalPathHint(rawCwd)}` };
        }
        return { cwd: resolved };
    } catch (err) {
        return {
            error: `Error: cwd does not exist: ${normalizeOutputPath(resolved)} (${err?.code || 'ENOENT'}).${literalPathHint(rawCwd)} Pass an absolute repo path or omit cwd to use ${normalizeOutputPath(baseCwd)}.`,
        };
    }
}
