import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { comparePairedTask } from './paired-task.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const finished_at = '2026-01-01T00:00:01Z';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tb-paired-task-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    writeFileSync(join(root, path), text);
    return hash(text);
  };
  const manifest = { schemaVersion: 2 };
  for (const [key, runtime] of [['baseline', 'v1.4.5'], ['current', 'working-tree']]) {
    manifest[key] = {
      taskDigest: hash('task'), controlsDigest: hash('controls'), runtimeDigest: hash(runtime),
      ledger: `${key}.json`, attempts: [{ dir: key }],
    };
  }
  const ledger = (key, trialIds) =>
    write(manifest[key].ledger, { schemaVersion: 1, state: 'closed', runId: `run-${key}`, trialIds });
  const trial = (key, {
    dir = key, trialId = `trial-${key}`, reward = 1, wire = key === 'baseline' ? 10 : 15,
    proof = true, provenance = {}, changeExec = () => {}, changeTrace = () => {}, exceptionInfo = null,
  } = {}) => {
    mkdirSync(join(root, dir, 'agent'), { recursive: true });
    const session = { thread_id: `thread-${trialId}`, turn_id: 'turn_1' };
    const traceSessionId = `trace-${trialId}`;
    const row = (type, fields) => ({ schema_version: 1, ...session, type, ...fields });
    const request = { request_id: 'round-1', request_index: 1 };
    const item = { id: 'tool-1', type: 'tool_call', arguments: {} };
    const exec = [
      row('thread.started'), row('turn.started'),
      row('model.request.started', request),
      row('model.request.completed', { ...request, usage: { output_tokens: 4 } }),
      row('item.started', { item: { ...item, status: 'in_progress' } }),
      row('item.completed', { item: { ...item, output: 'ok', timing: {}, status: 'completed' } }),
      row('turn.completed'),
      row('result', { session_id: session.thread_id, subtype: 'success', is_error: false, provider_requests: 1, tool_calls: 1 }),
    ];
    const trace = [
      { kind: 'usage_raw', session_id: traceSessionId, output_tokens: 4, exec_link: { ...session, request_id: 'round-1' } },
      { kind: 'tool', session_id: traceSessionId, result_bytes_est: 2, exec_link: { ...session, tool_call_id: 'tool-1' } },
    ];
    changeExec(exec);
    changeTrace(trace);
    const artifacts = {
      result: write(`${dir}/result.json`, {
        id: trialId, finished_at, exception_info: exceptionInfo, ...(reward == null ? {} : { verifier_result: { rewards: { reward } } }),
      }),
      exec: write(`${dir}/agent/mixdog.txt`, jsonl(exec)),
      trace: write(`${dir}/agent/agent-trace.jsonl`, jsonl(trace)),
    };
    if (proof) {
      const { taskDigest, controlsDigest, runtimeDigest } = manifest[key];
      write(`${dir}/paired-trial-evidence.json`, {
        schemaVersion: 1, runId: `run-${key}`, trialId, artifacts, taskDigest, controlsDigest, runtimeDigest, traceSessionId,
        runtime: key === 'baseline' ? 'v1.4.5' : 'working-tree',
        counters: { providerRequestWireBytes: { value: wire, complete: true } },
        ...provenance,
      });
    }
  };
  trial('baseline');
  ledger('baseline', ['trial-baseline']);
  ledger('current', ['trial-current']);
  return { manifest, ledger, trial, report: () => comparePairedTask(manifest, root) };
}

test('reports deltas for bound histories with one-to-one lifecycle evidence', (t) => {
  const { trial, report } = fixture(t);
  trial('current');
  const pair = report();
  assert.equal(pair.verifiedPair, true);
  assert.equal(pair.currentMinusBaseline.providerRequestWireBytes, 5);
  assert.equal(pair.currentMinusBaseline.toolResultTextEstimateBytes, 0);
  assert.equal(pair.currentMinusBaseline.tracedToolResultEstimateBytes, 0);
  assert.equal(pair.currentMinusBaseline.reportedOutputTokens, 0);
  assert.equal(pair.currentMinusBaseline.reportedThinkingTokens, null);
});

test('manifest expectations cannot substitute for captured per-trial provenance', (t) => {
  const { trial, report } = fixture(t);
  trial('current', { provenance: { runtimeDigest: hash('another runtime') } });
  const pair = report();
  assert.equal(pair.verifiedPair, false);
  assert.equal(pair.current.metrics.providerRequestWireBytes.observedSubtotal, 15);
  assert.equal(pair.currentMinusBaseline.providerRequestWireBytes, null);
});

test('rejects histories with omitted trials or copied trial IDs', (t) => {
  const { ledger, trial, report } = fixture(t);
  trial('current');
  ledger('current', ['unlisted-trial', 'trial-current']);
  assert.equal(report().current.outcome, 'unverified');
  trial('current', { trialId: 'trial-baseline' });
  ledger('current', ['trial-baseline']);
  assert.equal(report().baseline.outcome, 'unverified');
});

test('a later pass does not establish first completion after an unknown verdict', (t) => {
  const { ledger, manifest, trial, report } = fixture(t);
  trial('current', { dir: 'prior', trialId: 'earlier', reward: null, wire: 3 });
  trial('current');
  ledger('current', ['earlier', 'trial-current']);
  manifest.current.attempts.unshift({ dir: 'prior' });
  const pair = report();
  assert.equal(pair.current.outcome, 'unverified');
  assert.equal(pair.current.attempts[1].outcome, 'verified');
  assert.equal(pair.current.metrics.providerRequestWireBytes.observedSubtotal, 18);
  assert.equal(pair.currentMinusBaseline.providerRequestWireBytes, null);
  trial('current', { dir: 'prior', trialId: 'earlier', reward: null, exceptionInfo: false });
  assert.equal(report().currentMinusBaseline.providerRequestWireBytes, null);
});

test('an empty trace without model rounds is not a provider report of zero tokens', (t) => {
  const { trial, report } = fixture(t);
  trial('current', {
    changeExec: (rows) => { rows.splice(2, 4); Object.assign(rows.at(-1), { provider_requests: 0, tool_calls: 0 }); },
    changeTrace: (rows) => { rows.length = 0; },
  });
  const pair = report();
  assert.equal(pair.current.metrics.usageRows.value, 0);
  assert.equal(pair.current.metrics.reportedOutputTokens.value, null);
  assert.equal(pair.currentMinusBaseline.reportedOutputTokens, null);
});

test('equal record counts cannot validate cross-session usage, unrelated calls, or a mismatched terminal', (t) => {
  const { trial, report } = fixture(t);
  trial('current', {
    changeTrace: ([usage]) => { usage.session_id = 'other-session'; },
    changeExec: (rows) => { rows[5].item.id = 'another-call'; },
  });
  let pair = report();
  assert.equal(pair.verifiedPair, true);
  assert.equal(pair.current.metrics.reportedOutputTokens.observedSubtotal, 4);
  assert.equal(pair.current.metrics.toolResultTextEstimateBytes.observedSubtotal, 2);
  assert.equal(pair.currentMinusBaseline.reportedOutputTokens, null);
  assert.equal(pair.currentMinusBaseline.toolResultTextEstimateBytes, null);
  trial('current', { changeExec: (rows) => { rows.at(-2).type = 'turn.failed'; } });
  pair = report();
  assert.equal(pair.current.metrics.logicalModelRounds.observedSubtotal, 1);
  assert.equal(pair.currentMinusBaseline.logicalModelRounds, null);
});

test('stock artifacts retain observed subtotals without certifying coverage', (t) => {
  const { trial, report } = fixture(t);
  trial('current', { proof: false, changeTrace: (rows) => rows.forEach((row) => { delete row.exec_link; }) });
  const pair = report();
  assert.equal(pair.verifiedPair, false);
  assert.equal(pair.current.metrics.reportedOutputTokens.observedSubtotal, 4);
  assert.equal(pair.current.metrics.reportedOutputTokens.value, null);
});
