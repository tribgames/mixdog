import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeTranscriptReadDiagnostic, reportTranscriptRead, setTranscriptReadDiagnosticSink,
} from './transcript-read-diagnostics.ts';

test('read diagnostics retain bounded correlation/timing evidence without user data', () => {
  const diagnostic = normalizeTranscriptReadDiagnostic({
    kind: 'transcript-read', sessionId: 'sess_A', traceId: 'read-1',
    stage: 'host-read-result', atMs: 1_800_000_000_000,
    durationMs: 23.456, elapsedMs: Infinity, itemCount: 12,
    accepted: true, hasLane: false, attempt: 1,
    text: 'private transcript', token: 'credential', error: 'private file path',
  });
  assert.deepEqual(diagnostic, {
    kind: 'transcript-read', sessionId: 'sess_A', traceId: 'read-1',
    stage: 'host-read-result', atMs: 1_800_000_000_000,
    durationMs: 23.5, itemCount: 12, accepted: true, hasLane: false, attempt: 1,
  });
  for (const change of [
    { traceId: 'x'.repeat(161) }, { sessionId: 'a\nb' },
    { stage: 'private transcript' }, { atMs: NaN },
  ]) assert.equal(normalizeTranscriptReadDiagnostic({ ...diagnostic, ...change }), null);
});

test('untraced work is silent and diagnostic sink failure cannot escape', () => {
  const records = [];
  const restore = setTranscriptReadDiagnosticSink((entry) => records.push(entry));
  try {
    reportTranscriptRead('sess_A', undefined, 'host-start');
    assert.equal(records.length, 0);
    reportTranscriptRead('sess_A', 'read-1', 'host-start');
    assert.equal(records[0].stage, 'host-start');
    assert.doesNotThrow(() => reportTranscriptRead('sess_A', 'read-1', 'host-start', {}, () => {
      throw new Error('diagnostic storage unavailable');
    }));
  } finally { restore(); }
});
