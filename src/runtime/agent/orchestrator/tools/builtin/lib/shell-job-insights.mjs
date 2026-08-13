import { stripAnsi } from '../../shell-command.mjs';

export const SHELL_JOB_OUTPUT_DISK_CAP = 100 * 1024 * 1024;

function summarizeJobPreviewText(text, maxChars = 160) {
    if (typeof text !== 'string' || !text.trim()) return '';
    const lines = text
        .split(/\r?\n/)
        .map((line) => stripAnsi(line).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    if (lines.length === 0) return '';
    const summary = lines[lines.length - 1];
    return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary;
}

export function attachJobInsights(detail) {
    if (!detail || typeof detail !== 'object') return detail;
    const result = { ...detail };
    let summary = '';
    let summarySource = '';
    if (result.status === 'completed') {
        summary = summarizeJobPreviewText(result.stdoutPreview)
            || summarizeJobPreviewText(result.stderrPreview);
        summarySource = summary ? (result.stdoutPreview ? 'stdout' : 'stderr') : '';
    } else if (result.status === 'failed') {
        summary = summarizeJobPreviewText(result.stderrPreview)
            || summarizeJobPreviewText(result.stdoutPreview)
            || String(result.error || '').trim();
        summarySource = summary ? (result.stderrPreview ? 'stderr' : (result.stdoutPreview ? 'stdout' : 'status')) : '';
    } else if (result.status === 'cancelled') {
        summary = 'cancelled before completion';
        summarySource = 'status';
    } else if (result.status === 'running') {
        summary = summarizeJobPreviewText(result.stdoutPreview)
            || summarizeJobPreviewText(result.stderrPreview);
        summarySource = summary ? (result.stdoutPreview ? 'stdout' : 'stderr') : '';
    }
    if (summary) {
        result.summary = summary;
        result.summarySource = summarySource;
    }
    return result;
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
