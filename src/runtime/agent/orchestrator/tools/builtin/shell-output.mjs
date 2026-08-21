import { countSplitLines } from './path-utils.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './tool-output-limit.mjs';

export const SHELL_OUTPUT_MAX_CHARS = TOOL_OUTPUT_MAX_BYTES;

export const SMART_BASH_MAX_LINES = 400;
export const SMART_BASH_MAX_BYTES = TOOL_OUTPUT_MAX_BYTES;
export const SMART_BASH_HEAD_LINES = 80;
export const SMART_BASH_TAIL_LINES = 80;
export const BACKGROUND_PARTIAL_OUTPUT_MAX_BYTES = 10 * 1024;
export const BACKGROUND_PARTIAL_OUTPUT_HEAD_BYTES = 2 * 1024;

const BACKGROUND_PARTIAL_TRUNCATION_MARKER =
    '\n\n... [partial output truncated; head and tail shown] ...\n\n';

function utf8Prefix(value, maxBytes) {
    const buffer = Buffer.from(String(value ?? ''), 'utf8');
    if (buffer.length <= maxBytes) return buffer.toString('utf8');
    let end = maxBytes;
    while (end > 0 && end < buffer.length && (buffer[end] & 0xC0) === 0x80) end -= 1;
    return buffer.subarray(0, end).toString('utf8');
}

function utf8Suffix(value, maxBytes) {
    const buffer = Buffer.from(String(value ?? ''), 'utf8');
    if (buffer.length <= maxBytes) return buffer.toString('utf8');
    let start = buffer.length - maxBytes;
    while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) start += 1;
    return buffer.subarray(start).toString('utf8');
}

export function renderBackgroundPartialOutput(stdout, stderr) {
    const sections = [];
    const out = String(stdout ?? '');
    const err = String(stderr ?? '');
    if (out) sections.push(`[partial stdout]\n${out}`);
    if (err) sections.push(`[partial stderr]\n${err}`);
    const merged = sections.join('\n\n');
    if (!merged) return '';
    if (Buffer.byteLength(merged, 'utf8') <= BACKGROUND_PARTIAL_OUTPUT_MAX_BYTES) return merged;

    const markerBytes = Buffer.byteLength(BACKGROUND_PARTIAL_TRUNCATION_MARKER, 'utf8');
    const tailBytes = BACKGROUND_PARTIAL_OUTPUT_MAX_BYTES
        - BACKGROUND_PARTIAL_OUTPUT_HEAD_BYTES
        - markerBytes;
    return utf8Prefix(merged, BACKGROUND_PARTIAL_OUTPUT_HEAD_BYTES)
        + BACKGROUND_PARTIAL_TRUNCATION_MARKER
        + utf8Suffix(merged, tailBytes);
}

export function smartMiddleTruncate(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    if (s.length <= SMART_BASH_MAX_BYTES) {
        const fastLines = s.split('\n');
        if (fastLines.length <= SMART_BASH_MAX_LINES) return s;
        const head = fastLines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
        const tail = fastLines.slice(-SMART_BASH_TAIL_LINES).join('\n');
        const middle = fastLines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
        return `${head}\n\n... [${middle} lines omitted of ${fastLines.length} total — head and tail shown] ...\n\n${tail}`;
    }
    const lines = s.split('\n');
    if (lines.length <= SMART_BASH_MAX_LINES) {
        const head = s.slice(0, SMART_BASH_MAX_BYTES);
        return `${head}\n\n... [output exceeded ${Math.round(SMART_BASH_MAX_BYTES / 1024)} KB on a single line] ...`;
    }
    const head = lines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
    const tail = lines.slice(-SMART_BASH_TAIL_LINES).join('\n');
    const middle = lines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
    const totalKb = Math.round(s.length / 1024);
    return `${head}\n\n... [${middle} lines omitted of ${lines.length} total / ${totalKb} KB — head and tail shown] ...\n\n${tail}`;
}

export function capShellOutput(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    if (s.length <= SHELL_OUTPUT_MAX_CHARS && countSplitLines(s) <= SMART_BASH_MAX_LINES) return s;
    return smartMiddleTruncate(s);
}

function capturedStreamBytes(path, size, text) {
    const fileBytes = Number(size);
    if (path && Number.isFinite(fileBytes) && fileBytes > 0) return Math.trunc(fileBytes);
    return Buffer.byteLength(String(text ?? ''), 'utf8');
}

// Record byte counts only; never retain command output in telemetry. Spill file
// sizes recover the true child-output volume when stdout/stderr are already a
// bounded head+tail preview by the time bash-tool renders the result.
export function recordShellCaptureTelemetry(target, result, visibleStdout, visibleStderr) {
    if (!target || typeof target !== 'object' || !result || typeof result !== 'object') return;
    const stdoutBytes = capturedStreamBytes(result.stdoutPath, result.stdoutFileSize, result.stdout);
    const stderrBytes = capturedStreamBytes(result.stderrPath, result.stderrFileSize, result.stderr);
    target.commandOutputBytes = stdoutBytes + stderrBytes;
    target.capturedPreviewBytes = Buffer.byteLength(
        `${String(visibleStdout ?? '')}${String(visibleStderr ?? '')}`,
        'utf8',
    );
    target.spilled = Boolean(result.stdoutPath || result.stderrPath);
    // Exit status rides along with the byte counts. The tool row itself stays
    // `normal` for a non-zero command exit (that is an observed completion, not
    // a tool failure), so without this a failed command and its retry are
    // indistinguishable from two deliberate runs in the trace.
    target.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
    target.signal = result.signal || (result.killed ? 'SIGKILL' : null);
    target.timedOut = result.timedOut === true;
}
