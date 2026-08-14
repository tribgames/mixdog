import { persistToolResultArtifactSync } from '../../session/tool-result-offload.mjs';

const MIN_RAW_BYTES = 512;
const MIN_SAVED_BYTES = 384;
const MIN_SAVED_RATIO = 0.2;

function enabled() {
    return !/^(?:0|false|no|off)$/i.test(
        String(process.env.MIXDOG_SHELL_LOSSLESS_COMPACT ?? '1').trim(),
    );
}

function byteLength(value) {
    return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function simplePytestCommand(command) {
    const text = String(command ?? '').trim();
    if (!text || /[\r\n;&|<>`]|\$\(|\$\{|\$\(\(/.test(text)) return false;
    if (/^(?:(?:\S*[\\/])?(?:pytest|py\.test))(?:\.exe)?(?:\s|$)/i.test(text)) return true;
    return /^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?\s+-m\s+pytest(?:\s|$)/i.test(text);
}

function pytestSuccessSummary(stdout) {
    const text = String(stdout ?? '');
    if (byteLength(text) < MIN_RAW_BYTES) return null;
    if (/\b(?:failed|errors?|warnings?|skipped|xfailed|xpassed|deselected|rerun)\b/i.test(text)) {
        return null;
    }
    const lines = text.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i].trim().match(
            /^=*\s*(\d+)\s+passed(?:\s+in\s+([^=\r\n]+?))?\s*=*$/,
        );
        if (!match) continue;
        const duration = String(match[2] ?? '').trim();
        return `Pytest: ${match[1]} passed${duration ? ` in ${duration}` : ''}`;
    }
    return null;
}

function compactJsonWhitespace(value) {
    const text = String(value ?? '');
    const trimmed = text.trim();
    if (!trimmed || !/^(?:\{|\[)/.test(trimmed)) return null;
    try { JSON.parse(trimmed); } catch { return null; }
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of trimmed) {
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
            out += ch;
        } else if (!/\s/.test(ch)) {
            out += ch;
        }
    }
    return out;
}

function compactStructuredJson(stdout) {
    const text = String(stdout ?? '');
    const whole = compactJsonWhitespace(text);
    if (whole) return whole;
    const lines = text.split(/\r?\n/);
    const hadTrailingNewline = /\r?\n$/.test(text);
    if (hadTrailingNewline) lines.pop();
    if (lines.length < 2 || lines.some((line) => !line.trim())) return null;
    const compacted = lines.map(compactJsonWhitespace);
    if (compacted.some((line) => line === null)) return null;
    return `${compacted.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
}

function testLikeCommand(command) {
    const text = String(command ?? '').trim();
    return simplePytestCommand(text)
        || /^(?:node|bun)(?:\.exe)?\s+--test(?:\s|$)/i.test(text)
        || /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:[:.\w-]*)(?:\s|$)/i.test(text)
        || /^(?:(?:npx|pnpx|bunx)\s+)?(?:jest|vitest)(?:\s|$)/i.test(text)
        || /^(?:cargo|go|dotnet)\s+test(?:\s|$)/i.test(text);
}

function nodeTapSuccessSummary(stdout) {
    const text = String(stdout ?? '');
    if (!/^TAP version \d+/m.test(text) || /(?:^|\n)\s*not ok\b/i.test(text)) return null;
    const count = (name) => {
        const match = text.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
        return match ? Number(match[1]) : null;
    };
    const tests = count('tests');
    const passed = count('pass');
    if (!(tests > 0) || passed !== tests) return null;
    for (const name of ['fail', 'cancelled', 'skipped', 'todo']) {
        const value = count(name);
        if (value !== null && value !== 0) return null;
    }
    const duration = text.match(/^# duration_ms ([\d.]+)\s*$/m)?.[1];
    return `Node tests: ${passed} passed${duration ? ` in ${duration}ms` : ''}`;
}

function jestVitestSuccessSummary(stdout) {
    const text = String(stdout ?? '');
    if (/\b(?:failed|failure|errors?|warnings?|skipped|todo)\b/i.test(text)) return null;
    const jestSuites = text.match(/Test Suites:\s+(\d+)\s+passed,\s+(\d+)\s+total/i);
    const jestTests = text.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/i);
    if (jestSuites && jestTests && jestSuites[1] === jestSuites[2] && jestTests[1] === jestTests[2]) {
        return `Jest: ${jestTests[1]} passed in ${jestSuites[1]} suites`;
    }
    const vitestFiles = text.match(/Test Files\s+(\d+)\s+passed\s+\((\d+)\)/i);
    const vitestTests = text.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/i);
    if (vitestFiles && vitestTests && vitestFiles[1] === vitestFiles[2] && vitestTests[1] === vitestTests[2]) {
        return `Vitest: ${vitestTests[1]} passed in ${vitestFiles[1]} files`;
    }
    return null;
}

function cargoTestSuccessSummary(stdout) {
    const text = String(stdout ?? '');
    if (/(?:^|\n)\s*(?:warning|error):|panicked at|^failures:/im.test(text)) return null;
    const resultLines = text.split(/\r?\n/).filter((line) => line.startsWith('test result:'));
    if (!resultLines.length) return null;
    let passed = 0;
    let duration = 0;
    for (const line of resultLines) {
        const match = line.match(
            /^test result: ok\.\s+(\d+) passed;\s+0 failed;\s+0 ignored;\s+\d+ measured;\s+\d+ filtered out(?:;\s+finished in ([\d.]+)s)?/,
        );
        if (!match) return null;
        passed += Number(match[1]);
        duration += Number(match[2] ?? 0);
    }
    return `Cargo test: ${passed} passed in ${resultLines.length} suites${duration ? ` (${duration.toFixed(2)}s)` : ''}`;
}

function goTestSuccessSummary(stdout) {
    const text = String(stdout ?? '');
    if (/(?:^|\n)(?:FAIL\b|--- FAIL:)|\b(?:panic|warning):/im.test(text)) return null;
    const packages = text.split(/\r?\n/).filter((line) => /^ok\s+\S+/.test(line.trim()));
    if (!packages.length) return null;
    return `Go test: ${packages.length} packages passed`;
}

function dotnetTestSuccessSummary(stdout) {
    const text = String(stdout ?? '');
    if (/Build FAILED|(?:^|\s)(?:warning|error)\s+[A-Z]+\d+/i.test(text)) return null;
    const matches = [...text.matchAll(
        /Passed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/gi,
    )];
    if (!matches.length) return null;
    let passed = 0;
    for (const match of matches) {
        if (Number(match[1]) !== 0 || Number(match[3]) !== 0 || match[2] !== match[4]) return null;
        passed += Number(match[2]);
    }
    return `.NET test: ${passed} passed in ${matches.length} projects`;
}

function testSuccessSummary(command, stdout) {
    if (!testLikeCommand(command)) return null;
    return pytestSuccessSummary(stdout)
        ?? nodeTapSuccessSummary(stdout)
        ?? jestVitestSuccessSummary(stdout)
        ?? cargoTestSuccessSummary(stdout)
        ?? goTestSuccessSummary(stdout)
        ?? dotnetTestSuccessSummary(stdout);
}

function buildSuccessSummary(command, stdout) {
    const cmd = String(command ?? '').trim();
    const text = String(stdout ?? '');
    if (/^cargo\s+(?:build|check)(?:\s|$)/i.test(cmd)) {
        if (/(?:^|\n)\s*(?:warning|error):|\bfailed\b/im.test(text)) return null;
        const match = text.match(/Finished\s+.+?\s+target\(s\)\s+in\s+([^\r\n]+)/i);
        if (match) return `Cargo build: succeeded in ${match[1].trim()}`;
    }
    if (/^dotnet\s+build(?:\s|$)/i.test(cmd)) {
        if (!/Build succeeded\./i.test(text)
            || !/0 Warning\(s\)/i.test(text)
            || !/0 Error\(s\)/i.test(text)) return null;
        return '.NET build: succeeded with 0 warnings';
    }
    return null;
}

function foldCarriageReturnFrames(value) {
    const text = String(value ?? '');
    if (!/\r(?!\n)/.test(text)) return null;
    const normalized = text.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    let omitted = 0;
    const out = lines.map((line) => {
        const frames = line.split('\r');
        if (frames.length === 1) return line;
        omitted += frames.length - 1;
        return [...frames].reverse().find((frame) => frame !== '') ?? '';
    });
    if (!omitted) return null;
    return `${out.join('\n')}\n... [${omitted} overwritten progress frames omitted]`;
}

function hasDiagnosticHazard(value) {
    return /\b(?:errors?|warnings?|failed|failure|panic|fatal|xpass|xfailed|cancelled|todo|skipped)\b/i.test(
        String(value ?? ''),
    );
}

function foldConsecutiveDuplicateLines(value) {
    const text = String(value ?? '');
    const lines = text.split(/\r?\n/);
    const hadTrailingNewline = /\r?\n$/.test(text);
    if (hadTrailingNewline) lines.pop();
    if (lines.length < 20) return null;

    const out = [];
    let folded = 0;
    for (let i = 0; i < lines.length;) {
        let end = i + 1;
        while (end < lines.length && lines[end] === lines[i]) end++;
        const count = end - i;
        out.push(lines[i]);
        if (count >= 3 && lines[i] !== '') {
            out.push(`... [previous line repeated ${count - 1} more times]`);
            folded += count - 2;
        } else {
            for (let j = 1; j < count; j++) out.push(lines[i]);
        }
        i = end;
    }
    if (!folded) return null;
    return `${out.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
}

function worthwhile(rawStdout, rawStderr, stdout, stderr) {
    const before = byteLength(rawStdout) + byteLength(rawStderr);
    const after = byteLength(stdout) + byteLength(stderr);
    const saved = before - after;
    return before >= MIN_RAW_BYTES
        && saved >= MIN_SAVED_BYTES
        && saved / before >= MIN_SAVED_RATIO;
}

export function planLosslessShellCompaction({
    command,
    stdout,
    stderr,
    exitCode,
    signal,
    timedOut,
    hasExistingRecovery = false,
} = {}) {
    if (!enabled() || exitCode !== 0 || signal || timedOut || hasExistingRecovery) return null;
    if (/[\r\n]|<<|@\s*['"]/.test(String(command ?? ''))) return null;
    const rawStdout = String(stdout ?? '');
    const rawStderr = String(stderr ?? '');

    if (!rawStderr.trim()) {
        const compactJson = compactStructuredJson(rawStdout);
        if (compactJson && worthwhile(rawStdout, rawStderr, compactJson, '')) {
            return { kind: 'structured-json', stdout: compactJson, stderr: '' };
        }
        const summary = testSuccessSummary(command, rawStdout)
            ?? buildSuccessSummary(command, rawStdout);
        if (summary && worthwhile(rawStdout, rawStderr, summary, '')) {
            return { kind: 'command-success', stdout: summary, stderr: '' };
        }
    }

    if (hasDiagnosticHazard(`${rawStdout}\n${rawStderr}`)) return null;
    const compactStdout = foldCarriageReturnFrames(rawStdout)
        ?? foldConsecutiveDuplicateLines(rawStdout)
        ?? rawStdout;
    const compactStderr = foldCarriageReturnFrames(rawStderr)
        ?? foldConsecutiveDuplicateLines(rawStderr)
        ?? rawStderr;
    if (
        (compactStdout !== rawStdout || compactStderr !== rawStderr)
        && worthwhile(rawStdout, rawStderr, compactStdout, compactStderr)
    ) {
        return {
            kind: 'consecutive-duplicates',
            stdout: compactStdout,
            stderr: compactStderr,
        };
    }
    return null;
}

function persistStream(sessionId, toolCallId, stream, content) {
    if (!content) return null;
    return persistToolResultArtifactSync({
        sessionId,
        toolCallId,
        channel: stream,
        content,
    });
}

export function compactShellOutputLosslessly({
    command,
    rawStdout,
    rawStderr,
    stdout,
    stderr,
    exitCode,
    signal,
    timedOut,
    hasExistingRecovery = false,
    sessionId,
    toolCallId,
} = {}) {
    const plan = planLosslessShellCompaction({
        command,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        hasExistingRecovery,
    });
    if (!plan) return null;

    const recovery = [];
    const rawOut = String(rawStdout ?? '');
    const rawErr = String(rawStderr ?? '');
    const stdoutCapture = persistStream(sessionId, toolCallId, 'stdout', rawOut);
    const stderrCapture = persistStream(sessionId, toolCallId, 'stderr', rawErr);
    if ((rawOut && !stdoutCapture) || (rawErr && !stderrCapture)) return null;
    if (stdoutCapture) recovery.push(stdoutCapture);
    if (stderrCapture) recovery.push(stderrCapture);
    if (!recovery.length) return null;
    return { ...plan, recovery };
}

export function renderLosslessRecoveryHint(compaction, normalizePath = (value) => value) {
    if (!compaction?.recovery?.length) return '';
    const lines = [
        `[lossless compact: ${compaction.kind}; full captured output preserved]`,
    ];
    for (const item of compaction.recovery) {
        lines.push(
            `[full ${item.stream}: ${normalizePath(item.path)} `
            + `(${item.bytes} bytes; sha256 ${item.sha256}) — use read to recover]`,
        );
    }
    return lines.join('\n');
}
