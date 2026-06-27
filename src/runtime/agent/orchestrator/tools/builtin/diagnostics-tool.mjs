// Server-less diagnostics tool.
//
// Mixdog has no resident LSP server. Instead this tool detects the project
// marker(s) under the target path, runs the matching project CLI ONCE via the
// same exec path bash-tool uses (execShellCommand + resolveShell), then PARSES
// the checker's stdout/stderr into structured findings. No watch, no daemon.
//
// Graceful contract: a missing marker or a missing checker binary returns a
// clear "no checker available for X" message — it never throws.
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, resolve as pathResolve } from 'path';
import { execShellCommand, stripAnsi } from '../shell-command.mjs';
import { resolveShell } from './shell-runtime.mjs';

const DIAGNOSTICS_TIMEOUT_MS = 120_000;

// Probe whether a CLI binary is resolvable on PATH without running real work.
// Uses the platform command-resolver so an absent checker degrades gracefully
// into a "no checker available" message instead of a spawn error.
async function _commandExists(bin, cwd, env) {
    const { shell, shellArg, shellArgs, shellType } = resolveShell();
    const probe = shellType === 'powershell'
        ? `Get-Command ${bin} -ErrorAction SilentlyContinue | Select-Object -First 1`
        : `command -v ${bin}`;
    try {
        const r = await execShellCommand({
            shell, shellArg, shellArgs, command: probe,
            env, cwd, timeoutMs: 10_000, abortSignal: null,
        });
        const out = `${r.stdout || ''}`.trim();
        if (shellType === 'powershell') return out.length > 0;
        return r.exitCode === 0 && out.length > 0;
    } catch {
        return false;
    }
}

async function _runChecker(command, cwd, env) {
    const { shell, shellArg, shellArgs } = resolveShell();
    const r = await execShellCommand({
        shell, shellArg, shellArgs, command,
        env, cwd, timeoutMs: DIAGNOSTICS_TIMEOUT_MS, abortSignal: null,
    });
    return {
        stdout: stripAnsi(r.stdout || ''),
        stderr: stripAnsi(r.stderr || ''),
        exitCode: r.timedOut ? null : r.exitCode,
        timedOut: !!r.timedOut,
    };
}

// ---- per-checker output parsers -> [{file,line,col,severity,code,message}] ----

function _parseTsc(text) {
    const findings = [];
    const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
    for (const line of text.split(/\r?\n/)) {
        const m = re.exec(line.trim());
        if (m) findings.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4], code: m[5], message: m[6] });
    }
    return findings;
}

function _parseRuff(text) {
    const findings = [];
    // ruff default text: path:line:col: CODE message
    const re = /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.*)$/;
    for (const line of text.split(/\r?\n/)) {
        const m = re.exec(line.trim());
        if (!m) continue;
        const code = m[4];
        const severity = (/^(E9|F)/.test(code)) ? 'error' : 'warning';
        findings.push({ file: m[1], line: +m[2], col: +m[3], severity, code, message: m[5] });
    }
    return findings;
}

function _parsePyflakes(text) {
    const findings = [];
    // pyflakes: path:line: message  (no column)
    const re = /^(.+?):(\d+):\s*(.*)$/;
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = re.exec(trimmed);
        if (m) findings.push({ file: m[1], line: +m[2], col: null, severity: 'warning', code: null, message: m[3] });
    }
    return findings;
}

function _parseGoVet(text) {
    const findings = [];
    // go vet: path:line:col: message   OR   path:line: message
    const re = /^(.+?\.go):(\d+):(?:(\d+):)?\s+(.*)$/;
    for (const line of text.split(/\r?\n/)) {
        const m = re.exec(line.trim());
        if (m) findings.push({ file: m[1], line: +m[2], col: m[3] ? +m[3] : null, severity: 'error', code: 'vet', message: m[4] });
    }
    return findings;
}

function _parseCargo(text) {
    const findings = [];
    // cargo check --message-format=short: path:line:col: severity[CODE]: message
    const re = /^(.+?):(\d+):(\d+):\s+(warning|error)(?:\[([A-Za-z0-9]+)\])?:\s+(.*)$/;
    for (const line of text.split(/\r?\n/)) {
        const m = re.exec(line.trim());
        if (m) findings.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4], code: m[5] || null, message: m[6] });
    }
    return findings;
}

// node --check failure shape: "<abs file>:<line>" on its own line, followed
// by the offending source + caret, then "SyntaxError: <message>".
function _parseNodeCheck(text) {
    const findings = [];
    const head = /^(.+?):(\d+)\s*$/m.exec(text);
    const err = /^([A-Za-z]*Error):\s+(.*)$/m.exec(text);
    if (head && err) {
        findings.push({ file: head[1], line: +head[2], col: null, severity: 'error', code: err[1], message: err[2] });
    }
    return findings;
}

function _parseEslintCompact(text) {
    const findings = [];
    // eslint --format compact: path: line N, col M, Severity - message (rule)
    const re = /^(.+?):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning)\s+-\s+(.*?)(?:\s+\(([^)]+)\))?$/;
    for (const line of text.split(/\r?\n/)) {
        const m = re.exec(line.trim());
        if (m) findings.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4].toLowerCase(), code: m[6] || null, message: m[5] });
    }
    return findings;
}

// Detect the project marker under projectDir and return the checker plan.
// Order is deterministic; the first matching marker wins.
function _detectChecker(projectDir) {
    const has = (f) => existsSync(pathResolve(projectDir, f));
    if (has('tsconfig.json')) {
        return { kind: 'tsc', bin: 'tsc', command: 'tsc --noEmit', parse: _parseTsc, marker: 'tsconfig.json' };
    }
    if (has('pyproject.toml') || has('setup.py')) {
        return { kind: 'python', marker: has('pyproject.toml') ? 'pyproject.toml' : 'setup.py' };
    }
    if (has('go.mod')) {
        return { kind: 'go', bin: 'go', command: 'go vet ./...', parse: _parseGoVet, marker: 'go.mod' };
    }
    if (has('Cargo.toml')) {
        return { kind: 'cargo', bin: 'cargo', command: 'cargo check --message-format=short', parse: _parseCargo, marker: 'Cargo.toml' };
    }
    if (has('package.json')) {
        let usesEslint = false;
        try {
            const pkg = JSON.parse(readFileSync(pathResolve(projectDir, 'package.json'), 'utf8'));
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            usesEslint = Object.prototype.hasOwnProperty.call(deps, 'eslint');
        } catch { /* unreadable/invalid package.json */ }
        const hasEslintConfig = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs']
            .some((f) => has(f));
        if (usesEslint || hasEslintConfig) {
            return { kind: 'eslint', bin: 'eslint', command: 'eslint . --format compact', parse: _parseEslintCompact, marker: 'package.json (eslint)' };
        }
        return { kind: 'none', reason: 'package.json present but no eslint dependency/config detected' };
    }
    return { kind: 'none', reason: 'no recognized project marker (tsconfig.json / pyproject.toml / setup.py / go.mod / Cargo.toml / package.json)' };
}

function _formatResult({ marker, checker, findings, raw, note }) {
    return JSON.stringify({
        ok: true,
        marker: marker || null,
        checker: checker || null,
        note: note || null,
        count: findings.length,
        findings,
        raw: raw ? raw.slice(0, 4000) : undefined,
    }, null, 2);
}

export async function executeDiagnosticsTool(args, workDir, options = {}) {
    const result = await _executeDiagnosticsImpl(args, workDir);
    // ② completion progress (claude "Found N" parity). Best-effort, no-op
    // when onProgress is absent (no progressToken). Never throws — the tool
    // result is returned regardless.
    if (typeof options?.onProgress === 'function') {
        try {
            let _n = null;
            try { _n = JSON.parse(result)?.count; } catch { /* non-JSON envelope */ }
            if (Number.isFinite(_n)) {
                options.onProgress(_n === 0 ? 'no issues' : `${_n} issue${_n === 1 ? '' : 's'}`);
            }
        } catch { /* best-effort */ }
    }
    return result;
}

async function _executeDiagnosticsImpl(args, workDir) {
    try {
        // Resolve the target path (file or dir). Default: cwd.
        const rawPath = (args && typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : '';
        const absTarget = rawPath
            ? (isAbsolute(rawPath) ? rawPath : pathResolve(workDir, rawPath))
            : workDir;
        if (rawPath && !existsSync(absTarget)) {
            return _formatResult({ note: `path not found: ${rawPath}`, findings: [] });
        }
        let projectDir = absTarget;
        try {
            if (statSync(absTarget).isFile()) projectDir = dirname(absTarget);
        } catch { /* fall through with absTarget */ }

        let plan = _detectChecker(projectDir);
        // A file deep in the tree (src/search/lib/foo.mjs) has its project
        // marker at the repo ROOT — walk parent directories until a marker is
        // found instead of reporting "no recognized project marker" from the
        // file's immediate dirname. Stops at the first directory that yields
        // any non-"no marker" answer (including "package.json present but no
        // eslint"), or at the filesystem root.
        {
            const _noMarker = (p) => p.kind === 'none' && String(p.reason || '').startsWith('no recognized project marker');
            let walk = projectDir;
            while (_noMarker(plan)) {
                const parent = dirname(walk);
                if (!parent || parent === walk) break;
                walk = parent;
                plan = _detectChecker(walk);
            }
            if (!_noMarker(plan)) projectDir = walk;
        }
        if (plan.kind === 'none') {
            // Syntax-check fallback: a JS file target can still be validated
            // with `node --check` even when the project has no lint setup —
            // catch the dominant failure class (parse errors) instead of
            // going dark with "no checker".
            let isJsFile = false;
            try { isJsFile = /\.(mjs|cjs|js)$/i.test(absTarget) && statSync(absTarget).isFile(); } catch { /* keep false */ }
            if (isJsFile) {
                const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
                if (await _commandExists('node', projectDir, env)) {
                    const r = await _runChecker(`node --check "${absTarget}"`, projectDir, env);
                    const combined = `${r.stdout}\n${r.stderr}`;
                    const findings = _parseNodeCheck(combined);
                    return _formatResult({ checker: 'node --check (no-lint fallback)', findings, raw: combined, note: `${plan.reason} — fell back to syntax check only` });
                }
            }
            return _formatResult({ note: `no checker available for this path — ${plan.reason}`, findings: [] });
        }

        const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

        // Python is special: prefer ruff, fall back to pyflakes.
        if (plan.kind === 'python') {
            if (await _commandExists('ruff', projectDir, env)) {
                const r = await _runChecker('ruff check .', projectDir, env);
                const findings = _parseRuff(`${r.stdout}\n${r.stderr}`);
                return _formatResult({ marker: plan.marker, checker: 'ruff check', findings, raw: `${r.stdout}\n${r.stderr}` });
            }
            if (await _commandExists('python', projectDir, env)) {
                const r = await _runChecker('python -m pyflakes .', projectDir, env);
                const out = `${r.stdout}\n${r.stderr}`;
                if (/No module named pyflakes/i.test(out)) {
                    return _formatResult({ marker: plan.marker, note: 'no checker available for Python — ruff absent and pyflakes module not installed', findings: [] });
                }
                const findings = _parsePyflakes(out);
                return _formatResult({ marker: plan.marker, checker: 'python -m pyflakes (ruff fallback)', findings, raw: out });
            }
            return _formatResult({ marker: plan.marker, note: 'no checker available for Python — neither ruff nor python found on PATH', findings: [] });
        }

        if (!(await _commandExists(plan.bin, projectDir, env))) {
            return _formatResult({ marker: plan.marker, note: `no checker available for ${plan.kind} — "${plan.bin}" not found on PATH`, findings: [] });
        }
        const r = await _runChecker(plan.command, projectDir, env);
        const combined = `${r.stdout}\n${r.stderr}`;
        const findings = plan.parse(combined);
        const note = r.timedOut ? `checker timed out after ${DIAGNOSTICS_TIMEOUT_MS}ms` : null;
        return _formatResult({ marker: plan.marker, checker: plan.command, findings, raw: combined, note });
    } catch (err) {
        // Never throw — surface a graceful diagnostic envelope.
        return JSON.stringify({ ok: false, error: `diagnostics failed: ${err && err.message ? err.message : String(err)}`, findings: [] }, null, 2);
    }
}

export default executeDiagnosticsTool;
