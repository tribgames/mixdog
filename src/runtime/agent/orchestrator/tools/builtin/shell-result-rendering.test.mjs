import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeToolEnvelope } from '../../session/tool-envelope.mjs';
import { renderCompletedResult } from './bash-tool/completed-result.mjs';
import { renderLosslessRecoveryHint, renderShellOutputBody } from './shell-lossless-compact.mjs';
import { _shellFailureStatus } from './bash-tool/result-format.mjs';

test('timeout states its duration once while preserving signal, cause and partial-effects warning', () => {
  const result = _shellFailureStatus({ timedOut: true, signal: 'SIGTERM', killCause: 'deadline' }, 12000);
  assert.equal(result.statusDetail,
    '[timeout: 12000ms signal: SIGTERM cause: deadline] — command killed; partial effects may remain');
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.exitCode, null);
});

test('completed shell results use the exit marker without an explanatory banner', () => {
  for (const exitCode of [0, 1, 7, 127]) {
    for (const [stdout, stderr, body] of [
      ['command output', 'Error: command diagnostic\n', 'command output\nError: command diagnostic\n'],
      ['', '', '(no output)'],
    ]) {
      const result = normalizeToolEnvelope(renderCompletedResult({
        result: { exitCode, stdout, stderr },
        command: 'node script.mjs',
        analysisCommand: 'node script.mjs',
        stdout,
        stderr,
      }));
      assert.equal(result.explicitSuccess, true, `exit ${exitCode} is a command result, not a tool failure`);
      assert.equal(result.result, `[exit code: ${exitCode}]\n\n${body}`);
    }
  }
});

test('lossless recovery notes omit the digest without changing artifact metadata', () => {
  const artifact = Object.freeze({
    stream: 'stdout',
    path: 'C:/tool-results/session/result.txt',
    bytes: 1024,
    sha256: 'a'.repeat(64),
  });
  const compaction = { kind: 'json', recovery: [artifact] };
  const hint = '[lossless compact: json; full captured output preserved]\n'
    + '[full stdout: C:/tool-results/session/result.txt (1024 bytes) — use read to recover]';
  assert.equal(renderLosslessRecoveryHint(compaction), hint);
  assert.equal(renderShellOutputBody('{"ok":true}', '', compaction), `{"ok":true}\n\n${hint}`);
  assert.equal(artifact.sha256, 'a'.repeat(64));
});
