import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolOutputTelemetryPayload } from '../agent-trace-format.mjs';
import { summarizeReductionTraceRows } from './reduction-metrics.mjs';

test('generic offload telemetry records only byte counts and reduction', () => {
    assert.deepEqual(buildToolOutputTelemetryPayload({
        toolCallId: 'call_list_1',
        preOffloadBytes: 50_000,
        postOffloadBytes: 700,
        modelVisibleBytes: 700,
        offloaded: true,
        resultKind: 'normal',
    }), {
        tool_call_id: 'call_list_1',
        result_kind: 'normal',
        pre_offload_bytes: 50_000,
        post_offload_bytes: 700,
        model_visible_bytes: 700,
        saved_bytes: 49_300,
        reduction_pct: 99,
        offloaded: true,
    });
});

test('reduction report separates evidence, artifact, and shell savings without double counting', () => {
    const summary = summarizeReductionTraceRows([
        {
            kind: 'evidence_union',
            payload: {
                before_bytes: 1_000,
                after_bytes: 700,
                reused_rows: 3,
                exact_result_refs: 1,
                exact_result_bytes_saved: 100,
            },
        },
        {
            kind: 'tool_output',
            payload: {
                pre_offload_bytes: 5_000,
                model_visible_bytes: 500,
            },
        },
        {
            kind: 'shell_output',
            payload: {
                command_output_bytes: 10_000,
                model_visible_bytes: 300,
            },
        },
        { kind: 'usage_raw', input_tokens: 12_000, cached_tokens: 8_000, output_tokens: 900 },
        { kind: 'batch', payload: { tool_call_count: 2 } },
        { kind: 'tool', tool_name: 'list', tool_args: { path: 'src' } },
    ]);
    assert.deepEqual(summary.evidence, {
        projections: 1,
        beforeBytes: 1_000,
        afterBytes: 700,
        savedBytes: 300,
        rowSavedBytes: 200,
        exactSavedBytes: 100,
        reusedRows: 3,
        exactRefs: 1,
    });
    assert.equal(summary.artifactOffload.savedBytes, 4_500);
    assert.equal(summary.shell.savedBytes, 9_700);
    assert.equal(summary.totalSavedBytes, 14_500);
    assert.deepEqual(summary.activity, {
        providerRequests: 1,
        toolBatches: 1,
        toolCalls: 1,
        artifactReads: 0,
    });
    assert.deepEqual(summary.tokens, { input: 12_000, cached: 8_000, output: 900 });
});

test('reduction report exposes artifact reads that may add a model turn', () => {
    const summary = summarizeReductionTraceRows([
        {
            kind: 'tool',
            tool_name: 'read',
            tool_args: { file_path: 'C:/data/tool-results/session/abc.txt' },
        },
    ]);
    assert.equal(summary.activity.artifactReads, 1);
});
