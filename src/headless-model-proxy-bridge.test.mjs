// End to end, in process: the pptx skill scripts' headless runs in remote
// (SSH) mode reach a fake PC through a real model proxy bridge server, exactly
// as a skill-script process reaches the daemon's bridge.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MODEL_PROXY_OPERATIONS,
  ModelProxyChannel,
  decodeModelProxyWire,
  encodeModelProxyWire,
  getModelProxyChannel,
} from './runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { createModelProxyBridgeServer } from './runtime/agent/orchestrator/providers/model-proxy-bridge.mjs';
import { runReview } from './defaults/skills/pptx/scripts/review-deck.mjs';
import { runPageQc } from './defaults/skills/pptx/scripts/qc-pages.mjs';

const PROVIDER = 'openai';
const MODEL = 'gpt-bridge-test';
// 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

function useEnv(t, values) {
  const prior = {};
  for (const [key, value] of Object.entries(values)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** The daemon side: a real bridge server over a fresh channel, a fake PC
 *  answering with canned responses, and the daemon.json a script reads. */
async function remoteDaemon(t, reply) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-bridge-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const channel = new ModelProxyChannel();
  const server = createModelProxyBridgeServer({ channel });
  const endpoint = await server.start();
  t.after(() => server.close());
  writeFileSync(
    join(runtimeRoot, 'daemon.json'),
    JSON.stringify({ pid: process.pid, endpoints: { modelProxy: endpoint } })
  );
  const calls = [];
  const handled = new Set();
  t.after(
    channel.attachPublisher((snapshot) => {
      for (const { id } of snapshot.requests) {
        if (handled.has(id)) continue;
        handled.add(id);
        queueMicrotask(() => {
          const call = decodeModelProxyWire(channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id]).payload);
          calls.push(call);
          let value;
          if (call.method === 'providerConfig') value = { ready: true, providers: { [PROVIDER]: { enabled: true } } };
          else if (call.method === 'listModels' || call.method === 'refreshModels') {
            value = { models: [{ id: MODEL, name: MODEL }], modelInfo: {} };
          } else if (call.method === 'isAvailable') value = true;
          else
            value = {
              content: reply(call),
              model: MODEL,
              stopReason: 'end_turn',
              usage: { inputTokens: 10, outputTokens: 5 },
            };
          channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [id, true, encodeModelProxyWire(value), null]);
        });
      }
    })
  );
  useEnv(t, {
    MIXDOG_MODEL_PROXY: 'client',
    MIXDOG_RUNTIME_ROOT: runtimeRoot,
    MIXDOG_HOME: join(root, 'home'),
    MIXDOG_DATA_DIR: join(root, 'home', 'data'),
    MIXDOG_DISABLE_TOOL_PREWARM: '1',
    OPENAI_API_KEY: undefined,
  });
  return { root, calls };
}

const sends = (calls) => calls.filter((call) => call.method === 'send');

test('review-deck runs its pristine review through the daemon bridge in remote mode', async (t) => {
  const review = {
    selection: { candidateId: 'C1', reason: '제목과 근거가 한눈에 보입니다.' },
    candidates: [
      {
        id: 'C1',
        pages: [{ page: 1, verdict: 'pass', observations: ['제목 대비 본문 크기가 적절합니다.'] }],
        answers: [{ id: 'Q1', status: 'answered', answer: '매출 증가', evidencePages: [1] }],
      },
    ],
  };
  const fx = await remoteDaemon(t, () => JSON.stringify(review));
  const original = getModelProxyChannel();
  const dir = join(fx.root, 'packet');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'source.md'), '# 매출\n매출이 증가했습니다.\n');
  writeFileSync(join(dir, 'page-1.png'), PNG);
  writeFileSync(
    join(dir, 'packet.json'),
    JSON.stringify({
      task: '분기 매출 보고',
      sources: ['source.md'],
      questions: [{ id: 'Q1', question: '무엇이 변했나?' }],
      candidates: [{ id: 'C1', pages: ['page-1.png'] }],
    })
  );
  const output = join(fx.root, 'out', 'review.json');
  const result = await runReview({ input: join(dir, 'packet.json'), output, provider: PROVIDER, model: MODEL });
  assert.equal(result.ok, true, JSON.stringify({ error: result.error, errors: result.errors }));
  assert.deepEqual(result.review.selection, review.selection);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).review, review);
  assert.equal(sends(fx.calls).length, 1);
  assert.equal(sends(fx.calls)[0].provider, PROVIDER);
  assert.equal(sends(fx.calls)[0].model, MODEL);
  assert.equal(getModelProxyChannel(), original, 'the boundary restored the process channel');
  assert.equal(process.env.MIXDOG_MODEL_PROXY, 'client');
});

test('qc-pages runs two page sessions in one process through the daemon bridge', async (t) => {
  const fx = await remoteDaemon(t, () => 'OK');
  const deck = join(fx.root, 'deck.pptx');
  writeFileSync(deck, 'deck bytes');
  const document = {
    slides: [
      { index: 1, text: 'one', shapes: [] },
      { index: 2, text: 'two', shapes: [] },
    ],
  };
  const measure = async () => ({
    issues: [
      { severity: 'error', code: 'text_overflow', path: '/slide[1]/shape[1]', message: 'overflows' },
      { severity: 'error', code: 'text_overflow', path: '/slide[2]/shape[1]', message: 'overflows' },
    ],
    document,
  });
  const office = async () => {
    throw new Error('the fake deck is never opened');
  };
  const report = await runPageQc(
    { deck, pages: '1-2', provider: PROVIDER, model: MODEL, vision: false },
    { office, measure }
  );
  assert.deepEqual(
    report.pages.map((entry) => [entry.page, entry.reason, entry.reply]),
    [
      [1, 'unchanged', 'OK'],
      [2, 'unchanged', 'OK'],
    ],
    JSON.stringify(report.pages.map((entry) => entry.errors))
  );
  assert.equal(report.failed, 0);
  assert.equal(report.ok, true);
  assert.equal(sends(fx.calls).length, 2, 'page 2 reached the PC through its own boundary');
  assert.equal(fx.calls.filter((call) => call.method === 'providerConfig').length >= 2, true);
});
