import test from 'node:test';
import assert from 'node:assert/strict';
import {
  path,
  createHash,
  mkdtempSync,
  rmSync,
  tmpdir,
  join,
  readFileSync,
  compactShellOutputLosslessly,
  planLosslessShellCompaction,
  renderLosslessRecoveryHint,
} from './_shared.mjs';


test('lossless shell compaction summarizes successful pytest and preserves exact capture', () => {
    const originalDataDir = process.env.MIXDOG_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-shell-compact-'));
    process.env.MIXDOG_DATA_DIR = dataDir;
    try {
        const stdout = [
            '============================= test session starts =============================',
            'collected 367 items',
            '',
            ...Array.from({ length: 367 }, (_, i) => `test/test_${i}.py PASSED`),
            '',
            '============================= 367 passed in 1.25s =============================',
            '',
        ].join('\n');
        const compacted = compactShellOutputLosslessly({
            command: 'pytest -rA',
            rawStdout: stdout,
            rawStderr: '',
            stdout,
            stderr: '',
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: 'session-lossless-shell',
            toolCallId: 'call-lossless-shell',
        });
        assert.equal(compacted.stdout, 'Pytest: 367 passed in 1.25s');
        assert.equal(compacted.kind, 'command-success');
        assert.equal(compacted.recovery.length, 1);
        const capture = compacted.recovery[0];
        assert.equal(readFileSync(capture.path, 'utf8'), stdout);
        assert.equal(capture.bytes, Buffer.byteLength(stdout, 'utf8'));
        assert.equal(capture.sha256, createHash('sha256').update(stdout).digest('hex'));
        assert.match(renderLosslessRecoveryHint(compacted), /full captured output preserved/);
        assert.match(renderLosslessRecoveryHint(compacted), /use read to recover/);
    } finally {
        if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = originalDataDir;
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test('lossless shell compaction fails open for failures, heredocs, warnings, and existing recovery', () => {
    const output = `${'test_x PASSED\n'.repeat(80)}80 passed in 1.0s\n`;
    for (const input of [
        { command: 'pytest', exitCode: 1 },
        { command: "python3 - <<'PY'\nprint('x')\nPY", exitCode: 0 },
        { command: 'pytest', exitCode: 0, stdout: `${output}1 warning\n` },
        { command: 'pytest', exitCode: 0, hasExistingRecovery: true },
    ]) {
        assert.equal(planLosslessShellCompaction({
            command: input.command,
            stdout: input.stdout ?? output,
            stderr: '',
            exitCode: input.exitCode,
            signal: null,
            timedOut: false,
            hasExistingRecovery: input.hasExistingRecovery,
        }), null);
    }
});

test('lossless shell compaction folds only worthwhile consecutive duplicates', () => {
    const repeated = `${'same log line\n'.repeat(120)}done\n`;
    const compacted = planLosslessShellCompaction({
        command: 'node worker.mjs',
        stdout: repeated,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    });
    assert.equal(compacted.kind, 'consecutive-duplicates');
    assert.match(compacted.stdout, /^same log line\n\.\.\. \[previous line repeated 119 more times\]\ndone\n$/);
    assert.equal(planLosslessShellCompaction({
        command: 'node worker.mjs',
        stdout: 'same log line\n'.repeat(5),
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    }), null);
});

test('lossless shell compaction preserves JSON lexemes while removing only insignificant whitespace', () => {
    const pretty = `{
  "large": 9007199254740993,
  "text": "spaces stay here",
  "nested": [
    true,
    null
  ]
}${' '.repeat(700)}`;
    const compacted = planLosslessShellCompaction({
        command: 'tool --json',
        stdout: pretty,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    });
    assert.equal(compacted.kind, 'structured-json');
    assert.equal(
        compacted.stdout,
        '{"large":9007199254740993,"text":"spaces stay here","nested":[true,null]}',
    );
});

test('lossless shell compaction summarizes successful test runners only with complete zero-risk counts', () => {
    const tap = [
        'TAP version 13',
        ...Array.from({ length: 80 }, (_, i) => `# Subtest: case ${i}`),
        '1..80',
        '# tests 80',
        '# suites 0',
        '# pass 80',
        '# fail 0',
        '# cancelled 0',
        '# skipped 0',
        '# todo 0',
        '# duration_ms 42.5',
        '',
    ].join('\n');
    const nodePlan = planLosslessShellCompaction({
        command: 'npm run test:unit',
        stdout: tap,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    });
    assert.equal(nodePlan.stdout, 'Node tests: 80 passed in 42.5ms');

    const cargo = `${'test case ... ok\n'.repeat(80)}test result: ok. 80 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s\n`;
    const cargoPlan = planLosslessShellCompaction({
        command: 'cargo test',
        stdout: cargo,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    });
    assert.equal(cargoPlan.stdout, 'Cargo test: 80 passed in 1 suites (0.42s)');

    assert.equal(planLosslessShellCompaction({
        command: 'npm test',
        stdout: tap.replace('# fail 0', '# fail 1'),
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    }), null);

    // A TAP tail that lost its header is not a Go package list: its `ok N - name`
    // assertion lines were once counted as passing Go packages.
    const tapTail = [
        ...Array.from({ length: 40 }, (_, i) => `ok ${i + 1} - case ${i}`),
        '1..80',
        '# tests 80',
        '# pass 80',
        '# fail 0',
        '# duration_ms 42.5',
        '',
    ].join('\n');
    assert.equal(planLosslessShellCompaction({
        command: 'node --test test/unit.test.mjs',
        stdout: tapTail,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    }), null);

    // A pipeline returns its last stage's exit status, so the runner's verdict
    // is unknown and no summary may claim success on its behalf.
    assert.equal(planLosslessShellCompaction({
        command: 'node --test test/unit.test.mjs | tail -n 40',
        stdout: tap,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    }), null);

    // Real Go output still summarizes.
    const goPlan = planLosslessShellCompaction({
        command: 'go test ./...',
        stdout: 'ok  \texample.com/pkg/a\t0.02s\n'.repeat(60),
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    });
    assert.equal(goPlan.stdout, 'Go test: 60 packages passed');
});

test('lossless shell compaction folds overwritten progress frames but never diagnostics', () => {
    const progress = `${Array.from({ length: 240 }, (_, i) => `${i}%`).join('\r')}\r100%\n`;
    const compacted = planLosslessShellCompaction({
        command: 'builder',
        stdout: progress,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    });
    assert.match(compacted.stdout, /^100%\n\n\.\.\. \[240 overwritten progress frames omitted\]$/);
    assert.equal(planLosslessShellCompaction({
        command: 'builder',
        stdout: `${progress}warning: unstable output\n`,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
    }), null);
});
