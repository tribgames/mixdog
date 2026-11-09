import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LANGS, MODELS, execInputTokens, inputTokensOfFirstRequest, measureModel, renderTable, usageLogInput } from './measure-exec.mjs';

const lines = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
const completed = (usage) => ({ type: 'model.request.completed', request_id: 'model_request_1', request_index: 1, duration_ms: 3, usage });

test('the table is the one Node measured: rendering results.json gives table.md', () => {
  const recorded = JSON.parse(readFileSync(new URL('./results/results.json', import.meta.url), 'utf8'));
  const results = recorded.results.map(({ ratio, ...row }) => row);
  assert.equal(`${renderTable(results)}\n`, readFileSync(new URL('./results/table.md', import.meta.url), 'utf8'));
});

test('every model results.json holds is measured, in its order (results.json predates Qwen)', () => {
  const recorded = JSON.parse(readFileSync(new URL('./results/results.json', import.meta.url), 'utf8'));
  assert.deepEqual(MODELS.map(([name]) => name).filter((name) => recorded.results.some((row) => row.name === name)), recorded.results.map((row) => row.name));
  assert.deepEqual(LANGS.map(([lang]) => lang), Object.keys(recorded.results[0].net));
});

test('the count is the first request: OpenAI includes cache, Anthropic adds it', () => {
  const stdout = lines(
    { type: 'thread.started' },
    { type: 'model.request.started', request_index: 1 },
    completed({ input_tokens: 1200, cached_input_tokens: 800, cache_write_input_tokens: 50, output_tokens: 3 }),
    completed({ input_tokens: 99999, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3 }),
  );
  assert.equal(inputTokensOfFirstRequest(stdout, 'openai-oauth'), 1200);
  assert.equal(inputTokensOfFirstRequest(stdout, 'anthropic-oauth'), 1200 + 800 + 50);
  assert.throws(() => inputTokensOfFirstRequest(lines({ type: 'thread.started' }, 'not json'), 'gemini'), /no completed model request/);
  assert.equal(usageLogInput({ totals: { inputTokens: 10, cacheTokens: 4, cacheWriteTokens: 1 } }, 'anthropic-oauth'), 15);
  assert.equal(usageLogInput({ totals: { inputTokens: 10, cacheTokens: 4 } }, 'gemini'), 10);
});

function fakeSpawn({ stdout, code = 0, record }) {
  return (bin, args) => {
    record.push([bin, args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', code);
    });
    return child;
  };
}

test('one exec per text, carrying the route, the usage log and the text as its last argument', async () => {
  const record = [];
  const tokens = await execInputTokens({
    bin: 'mixdogd', provider: 'anthropic-oauth', model: 'claude-opus-5-5', effort: 'low', text: 'line one\nline two', cwd: '/work',
    spawnImpl: fakeSpawn({ record, stdout: lines(completed({ input_tokens: 30, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 1 })) }),
  });
  assert.equal(tokens, 35);
  const [[bin, args]] = record;
  assert.equal(bin, 'mixdogd');
  assert.deepEqual(args.slice(0, 9), ['exec', '--json', '--provider', 'anthropic-oauth', '--model', 'claude-opus-5-5', '--effort', 'low', '--cwd']);
  assert.equal(args[args.indexOf('--usage-log') + 1].endsWith('usage.json'), true);
  assert.equal(args.at(-1), 'line one\nline two');
  const noEffort = [];
  await execInputTokens({ bin: 'mixdogd', provider: 'gemini', model: 'g', text: 't', cwd: '/w', spawnImpl: fakeSpawn({ record: noEffort, stdout: lines(completed({ input_tokens: 1 })) }) });
  assert.equal(noEffort[0][1].includes('--effort'), false);
});

test('a failed exec is an error that names its exit and stderr', async () => {
  const child = (bin, args) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    queueMicrotask(() => {
      c.stderr.emit('data', 'mixdog: provider "x" is not available\n');
      c.emit('close', 1);
    });
    return c;
  };
  await assert.rejects(execInputTokens({ bin: 'mixdogd', provider: 'x', model: 'm', text: 't', cwd: '/w', spawnImpl: child }), /exited 1: mixdog: provider "x" is not available/);
});

test('the net count of a language is its count less the "." baseline', async () => {
  const count = async (text) => (text === '.' ? 7 : text.length + 7);
  const corpus = Object.fromEntries(LANGS.map(([lang], i) => [lang, 'x'.repeat(10 * (i + 1))]));
  const measured = await measureModel(count, corpus);
  assert.equal(measured.baseline, 7);
  assert.equal(measured.raw.English, 17);
  assert.deepEqual(measured.net, Object.fromEntries(LANGS.map(([lang], i) => [lang, 10 * (i + 1)])));
});
