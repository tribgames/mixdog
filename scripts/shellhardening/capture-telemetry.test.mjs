import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeBashTool,
  buildShellOutputTelemetryPayload,
  TaskOutput,
  normalizeToolEnvelope,
  BACKGROUND_PARTIAL_OUTPUT_MAX_BYTES,
  recordShellCaptureTelemetry,
  renderBackgroundPartialOutput,
} from './_shared.mjs';


test('shell capture sanitizes binary/control output and keeps capturing', async () => {
    const normal = new TaskOutput('shell-text-normal');
    normal.writeStdout('정상 UTF-8\n');
    assert.equal(await normal.getStdout(), '정상 UTF-8\n');
    assert.equal(normal.binaryOutput, null);

    const binary = new TaskOutput('shell-text-binary');
    binary.writeStdout(`prefix\u0000\u0001suffix`);
    binary.writeStdout('must-follow');
    assert.deepEqual(binary.binaryOutput, { channel: 'stdout', bytes: 14 });
    const captured = await binary.getStdout();
    assert.match(captured, /^\[binary output on stdout sanitized;/);
    assert.doesNotMatch(captured, /\u0000/);
    assert.match(captured, /prefixsuffix/);
    assert.match(captured, /must-follow/);
});

test('shell capture preserves raw UTF-16LE text instead of killing it as binary', async () => {
    const script = "process.stdout.write(Buffer.from('raw-utf16-ok\\n', 'utf16le'))";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = normalizeToolEnvelope(await executeBashTool(
        { command, timeout_ms: 10_000 },
        process.cwd(),
    ));
    assert.equal(result.explicitSuccess, true);
    assert.match(result.result, /raw-utf16-ok/);
    assert.doesNotMatch(result.result, /binary output detected/);
});

test('auto-background partial output shares one strict UTF-8 byte budget', () => {
    const rendered = renderBackgroundPartialOutput(
        '가'.repeat(6_000),
        'fatal: 끝',
    );
    assert.ok(Buffer.byteLength(rendered, 'utf8') <= BACKGROUND_PARTIAL_OUTPUT_MAX_BYTES);
    assert.match(rendered, /^\[partial stdout\]\n/);
    assert.match(rendered, /partial output truncated; head and tail shown/);
    assert.match(rendered, /\[partial stderr\]\nfatal: 끝$/);
    assert.equal(rendered.includes('\uFFFD'), false);
});

test('shell output telemetry measures spill-backed raw bytes without retaining output', () => {
    const telemetry = {};
    recordShellCaptureTelemetry(
        telemetry,
        {
            stdout: 'bounded preview',
            stderr: '',
            stdoutPath: '/tmp/stdout',
            stdoutFileSize: 120,
            stderrPath: null,
            stderrFileSize: 0,
        },
        'bounded preview',
        '',
    );
    telemetry.shellResultBytes = 80;
    telemetry.toolResultBytes = 70;
    assert.deepEqual(telemetry, {
        commandOutputBytes: 120,
        capturedPreviewBytes: 15,
        spilled: true,
        exitCode: null,
        signal: null,
        timedOut: false,
        shellResultBytes: 80,
        toolResultBytes: 70,
    });

    const payload = buildShellOutputTelemetryPayload({
        toolCallId: 'call_shell_1',
        telemetry,
        preOffloadBytes: 70,
        postOffloadBytes: 30,
        modelVisibleBytes: 20,
        offloaded: true,
        resultKind: 'normal',
    });
    assert.equal(payload.command_output_bytes, 120);
    assert.equal(payload.model_visible_bytes, 20);
    assert.equal(payload.byte_delta, 100);
    assert.equal(payload.reduction_pct, 83);
    assert.equal(payload.offloaded, true);
    assert.equal('stdout' in payload, false);
});
