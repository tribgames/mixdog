import { countSplitLines } from './path-utils.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './tool-output-limit.mjs';
import { DELIVERY_FULL_CHARS, fitPieces, shellTextPiece } from './lib/shell-delivery.mjs';

const SHELL_OUTPUT_MAX_BYTES = TOOL_OUTPUT_MAX_BYTES;

export const SMART_BASH_MAX_LINES = 400;
export const SMART_BASH_MAX_BYTES = TOOL_OUTPUT_MAX_BYTES;
export const SMART_BASH_HEAD_LINES = 80;
export const SMART_BASH_TAIL_LINES = 80;
function utf8Prefix(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  let end = maxBytes;
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

// Partial output of a promoted command that has no task record, in the shared
// delivery shape (lib/shell-delivery.mjs).
export function renderBackgroundPartialOutput(stdout, stderr) {
  const streams = [
    ['stdout', String(stdout ?? '')],
    ['stderr', String(stderr ?? '')],
  ].filter(([, text]) => text);
  const headings = streams.map(([label]) => `[partial ${label}]\n`);
  const fixed = headings.reduce((sum, heading) => sum + heading.length, 2 * Math.max(0, streams.length - 1));
  const bodies = fitPieces(
    streams.map(([label, text]) => shellTextPiece(text, { label })),
    DELIVERY_FULL_CHARS - fixed
  );
  return streams.map((_, index) => `${headings[index]}${bodies[index]}`).join('\n\n');
}

export function smartMiddleTruncate(content) {
  const s = typeof content === 'string' ? content : String(content ?? '');
  const totalBytes = Buffer.byteLength(s, 'utf8');
  if (totalBytes <= SMART_BASH_MAX_BYTES) {
    const fastLines = s.split('\n');
    if (fastLines.length <= SMART_BASH_MAX_LINES) return s;
    const head = fastLines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
    const tail = fastLines.slice(-SMART_BASH_TAIL_LINES).join('\n');
    const middle = fastLines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
    return `${head}\n\n... [${middle} lines omitted of ${fastLines.length} total — head and tail shown] ...\n\n${tail}`;
  }
  const lines = s.split('\n');
  if (lines.length <= SMART_BASH_MAX_LINES) {
    const head = utf8Prefix(s, SMART_BASH_MAX_BYTES);
    return `${head}\n\n... [output exceeded ${Math.round(SMART_BASH_MAX_BYTES / 1024)} KB on a single line] ...`;
  }
  const head = lines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
  const tail = lines.slice(-SMART_BASH_TAIL_LINES).join('\n');
  const middle = lines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
  const totalKb = Math.round(totalBytes / 1024);
  return `${head}\n\n... [${middle} lines omitted of ${lines.length} total / ${totalKb} KB — head and tail shown] ...\n\n${tail}`;
}

export function capShellOutput(content) {
  const s = typeof content === 'string' ? content : String(content ?? '');
  if (Buffer.byteLength(s, 'utf8') <= SHELL_OUTPUT_MAX_BYTES && countSplitLines(s) <= SMART_BASH_MAX_LINES) return s;
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
    'utf8'
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
