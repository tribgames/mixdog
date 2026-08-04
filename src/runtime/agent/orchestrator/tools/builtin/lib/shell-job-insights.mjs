import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { stripAnsi } from '../../shell-command.mjs';

const JOB_STATUS_PREVIEW_MAX_BYTES = 4096;
const JOB_STATUS_PREVIEW_MAX_LINES = 20;
const JOB_STATUS_PREVIEW_MAX_CHARS = 1200;
// Hard ceiling on a background job's on-disk stdout+stderr. Mirrors the
// foreground SHELL_OUTPUT_DISK_CAP (shell-command.mjs) so a runaway
// background loop is killed and flagged instead of filling the filesystem.
export const SHELL_JOB_OUTPUT_DISK_CAP = 100 * 1024 * 1024;

// Combined byte size of a job's spilled stdout/stderr files, or 0 if
// unreadable. mergeStderr collapses both onto stdoutPath, so count it once.
export function shellJobOutputBytes(detail) {
    let total = 0;
    const seen = new Set();
    for (const p of [detail?.stdoutPath, detail?.stderrPath]) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        try {
            if (existsSync(p)) total += statSync(p).size;
        } catch { /* ignore */ }
    }
    return total;
}

function readTailPreviewSync(filePath, { maxBytes = JOB_STATUS_PREVIEW_MAX_BYTES, maxLines = JOB_STATUS_PREVIEW_MAX_LINES, maxChars = JOB_STATUS_PREVIEW_MAX_CHARS } = {}) {
    try {
        if (!filePath || !existsSync(filePath)) return null;
        const st = statSync(filePath);
        if (!st.isFile()) return null;
        const size = st.size;
        if (size <= 0) return { bytes: 0, preview: '' };
        const readBytes = Math.min(size, maxBytes);
        const fd = openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(readBytes);
            readSync(fd, buf, 0, readBytes, size - readBytes);
            let text = buf.toString('utf8');
            if (size > readBytes) {
                const nl = text.indexOf('\n');
                if (nl !== -1) text = text.slice(nl + 1);
            }
            let lines = text.split(/\r?\n/);
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            let truncated = size > readBytes;
            if (lines.length > maxLines) {
                lines = lines.slice(-maxLines);
                truncated = true;
            }
            let preview = lines.join('\n');
            if (preview.length > maxChars) {
                preview = preview.slice(preview.length - maxChars);
                const nl = preview.indexOf('\n');
                if (nl !== -1) preview = preview.slice(nl + 1);
                truncated = true;
            }
            return {
                bytes: size,
                preview,
                truncated,
            };
        } finally {
            try { closeSync(fd); } catch { /* ignore */ }
        }
    } catch {
        return null;
    }
}

function attachJobPreview(detail) {
    if (!detail || typeof detail !== 'object') return detail;
    const withPreview = { ...detail };
    const stdoutInfo = readTailPreviewSync(detail.stdoutPath);
    if (stdoutInfo) {
        withPreview.stdoutBytes = stdoutInfo.bytes;
        if (stdoutInfo.preview) withPreview.stdoutPreview = stdoutInfo.preview;
        if (stdoutInfo.truncated) withPreview.stdoutPreviewTruncated = true;
    }
    if (detail.mergeStderr !== true) {
        const stderrInfo = readTailPreviewSync(detail.stderrPath);
        if (stderrInfo) {
            withPreview.stderrBytes = stderrInfo.bytes;
            if (stderrInfo.preview) withPreview.stderrPreview = stderrInfo.preview;
            if (stderrInfo.truncated) withPreview.stderrPreviewTruncated = true;
        }
    }
    return withPreview;
}

function summarizeJobPreviewText(text, maxChars = 160) {
    if (typeof text !== 'string' || !text.trim()) return '';
    const lines = text
        .split(/\r?\n/)
        .map((line) => stripAnsi(line).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    if (lines.length === 0) return '';
    let summary = lines[lines.length - 1];
    if (summary.length > maxChars) summary = `${summary.slice(0, maxChars - 1)}…`;
    return summary;
}

const SHELL_JOB_PROMPT_TAIL_BYTES = 1024;
const SHELL_JOB_PROMPT_TAIL_LINES = 16;
const SHELL_JOB_PROMPT_TAIL_CHARS = 1024;
const SHELL_JOB_PROMPT_PATTERNS = [
    /\((?:y|yes)\/(?:n|no)\)\s*[:?]?\s*$/i,
    /\[(?:y|yes)\/(?:n|no)\]\s*[:?]?\s*$/i,
    /\b(?:continue|proceed|confirm|overwrite|replace)\b[^\n]*[?:]\s*$/i,
    /\bpress\s+(?:enter|return)\b[^\n]*$/i,
    /\bdo you (?:want|wish|agree|accept)\b[^\n]*\?\s*$/i,
    /\b(?:password|passphrase|otp|verification code)\b[^\n]*[:?]\s*$/i,
];

export function looksLikeInteractivePrompt(text) {
    const tail = stripAnsi(String(text || '')).trim();
    if (!tail) return false;
    const last = tail.split(/\r?\n/).slice(-4).join('\n').trim();
    return SHELL_JOB_PROMPT_PATTERNS.some((pattern) => pattern.test(last));
}

export function readPromptTail(detail) {
    if (!detail || typeof detail !== 'object') return { bytes: 0, text: '' };
    const stdoutInfo = readTailPreviewSync(detail.stdoutPath, {
        maxBytes: SHELL_JOB_PROMPT_TAIL_BYTES,
        maxLines: SHELL_JOB_PROMPT_TAIL_LINES,
        maxChars: SHELL_JOB_PROMPT_TAIL_CHARS,
    });
    const stderrInfo = detail.mergeStderr === true ? null : readTailPreviewSync(detail.stderrPath, {
        maxBytes: SHELL_JOB_PROMPT_TAIL_BYTES,
        maxLines: SHELL_JOB_PROMPT_TAIL_LINES,
        maxChars: SHELL_JOB_PROMPT_TAIL_CHARS,
    });
    const bytes = (stdoutInfo?.bytes || 0) + (stderrInfo?.bytes || 0);
    const parts = [
        stdoutInfo?.preview ? `[stdout tail]\n${stdoutInfo.preview}` : '',
        stderrInfo?.preview ? `[stderr tail]\n${stderrInfo.preview}` : '',
    ].filter(Boolean);
    return { bytes, text: parts.join('\n\n') };
}

export function attachJobInsights(detail) {
    const withPreview = attachJobPreview(detail);
    if (!withPreview || typeof withPreview !== 'object') return withPreview;
    let summary = '';
    let summarySource = '';
    if (withPreview.status === 'completed') {
        summary = summarizeJobPreviewText(withPreview.stdoutPreview)
            || summarizeJobPreviewText(withPreview.stderrPreview);
        summarySource = summary ? (withPreview.stdoutPreview ? 'stdout' : 'stderr') : '';
    } else if (withPreview.status === 'failed') {
        summary = summarizeJobPreviewText(withPreview.stderrPreview)
            || summarizeJobPreviewText(withPreview.stdoutPreview)
            || String(withPreview.error || '').trim();
        summarySource = summary ? (withPreview.stderrPreview ? 'stderr' : (withPreview.stdoutPreview ? 'stdout' : 'status')) : '';
    } else if (withPreview.status === 'cancelled') {
        summary = 'cancelled before completion';
        summarySource = 'status';
    } else if (withPreview.status === 'running') {
        summary = summarizeJobPreviewText(withPreview.stdoutPreview)
            || summarizeJobPreviewText(withPreview.stderrPreview);
        summarySource = summary ? (withPreview.stdoutPreview ? 'stdout' : 'stderr') : '';
    }
    if (summary) {
        withPreview.summary = summary;
        withPreview.summarySource = summarySource;
    }
    return withPreview;
}

export function shellJobPublicTaskResult(detail) {
    if (!detail || typeof detail !== 'object') return detail;
    const result = {
        task_id: detail.jobId || detail.task_id || null,
        shell: detail.shellType || null,
        status: detail.status || null,
        cwd: detail.cwd || null,
        pid: detail.pid || null,
        exit_code: (typeof detail.exitCode === 'number') ? detail.exitCode : null,
        signal: detail.signal || null,
        timed_out: detail.timedOut === true ? true : null,
        killed: detail.killed === true ? true : null,
        stdout_bytes: (typeof detail.stdoutBytes === 'number') ? detail.stdoutBytes : null,
        stderr_bytes: (typeof detail.stderrBytes === 'number') ? detail.stderrBytes : null,
        stdout_preview: detail.stdoutPreview || null,
        stderr_preview: detail.stderrPreview || null,
        summary: detail.summary || null,
        summary_source: detail.summarySource || null,
        waited_ms: (typeof detail.waitedMs === 'number') ? detail.waitedMs : null,
        wait_timed_out: detail.waitTimedOut === true ? true : null,
        started_at: detail.startedAt || null,
        finished_at: detail.finishedAt || null,
        error: detail.error || null,
    };
    for (const [key, value] of Object.entries(result)) {
        if (value == null || value === '') delete result[key];
    }
    return result;
}
