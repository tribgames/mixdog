function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function metric(row, key) {
    if (row?.[key] != null) return finite(row[key]);
    return finite(row?.payload?.[key]);
}

function saved(before, after) {
    return Math.max(0, Math.trunc(finite(before) - finite(after)));
}

function toolArgsText(row) {
    try {
        return JSON.stringify(row?.tool_args ?? row?.payload?.tool_args ?? '');
    } catch {
        return '';
    }
}

export function summarizeReductionTraceRows(rows) {
    const summary = {
        evidence: {
            projections: 0,
            beforeBytes: 0,
            afterBytes: 0,
            savedBytes: 0,
            rowSavedBytes: 0,
            exactSavedBytes: 0,
            reusedRows: 0,
            exactRefs: 0,
        },
        artifactOffload: {
            results: 0,
            beforeBytes: 0,
            visibleBytes: 0,
            savedBytes: 0,
        },
        shell: {
            results: 0,
            rawBytes: 0,
            visibleBytes: 0,
            savedBytes: 0,
        },
        activity: {
            providerRequests: 0,
            toolBatches: 0,
            toolCalls: 0,
            artifactReads: 0,
        },
        tokens: {
            input: 0,
            cached: 0,
            output: 0,
        },
        totalSavedBytes: 0,
    };

    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') continue;
        const kind = String(row.kind || '');
        if (kind === 'evidence_union') {
            const before = metric(row, 'before_bytes');
            const after = metric(row, 'after_bytes');
            const totalSaved = saved(before, after);
            const exactSaved = Math.min(totalSaved, metric(row, 'exact_result_bytes_saved'));
            summary.evidence.projections += 1;
            summary.evidence.beforeBytes += before;
            summary.evidence.afterBytes += after;
            summary.evidence.savedBytes += totalSaved;
            summary.evidence.exactSavedBytes += exactSaved;
            summary.evidence.rowSavedBytes += totalSaved - exactSaved;
            summary.evidence.reusedRows += metric(row, 'reused_rows');
            summary.evidence.exactRefs += metric(row, 'exact_result_refs');
            continue;
        }
        if (kind === 'tool_output') {
            const before = metric(row, 'pre_offload_bytes');
            const visible = metric(row, 'model_visible_bytes');
            summary.artifactOffload.results += 1;
            summary.artifactOffload.beforeBytes += before;
            summary.artifactOffload.visibleBytes += visible;
            summary.artifactOffload.savedBytes += saved(before, visible);
            continue;
        }
        if (kind === 'shell_output') {
            const before = metric(row, 'command_output_bytes');
            const visible = metric(row, 'model_visible_bytes');
            summary.shell.results += 1;
            summary.shell.rawBytes += before;
            summary.shell.visibleBytes += visible;
            summary.shell.savedBytes += saved(before, visible);
            continue;
        }
        if (kind === 'usage_raw') {
            summary.activity.providerRequests += 1;
            summary.tokens.input += metric(row, 'input_tokens');
            summary.tokens.cached += metric(row, 'cached_tokens');
            summary.tokens.output += metric(row, 'output_tokens');
            continue;
        }
        if (kind === 'batch') {
            summary.activity.toolBatches += 1;
            continue;
        }
        if (kind === 'tool') {
            summary.activity.toolCalls += 1;
            const name = String(row.tool_name || row.payload?.tool_name || '').toLowerCase();
            if (name === 'read' && /[\\/]tool-results[\\/]|[\\/]shell-output(?:-compact)?[\\/]/i.test(toolArgsText(row))) {
                summary.activity.artifactReads += 1;
            }
        }
    }
    summary.totalSavedBytes = summary.evidence.savedBytes
        + summary.artifactOffload.savedBytes
        + summary.shell.savedBytes;
    return summary;
}
