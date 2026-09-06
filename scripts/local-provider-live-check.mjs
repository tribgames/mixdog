// Explicit live acceptance runner. It uses an existing owner process only:
// no server launch, unload, app restart, download, or real tool side effects.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MixdogLocalProvider } from '../src/runtime/agent/orchestrator/providers/mixdog-local.mjs';
import { recordLocalModelLoad, localModelState } from '../src/runtime/local-provider/model-state.mjs';
import { completeToolConversation, assertResponseContains } from './lib/local-provider-live-scenarios.mjs';

const flags = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const pid = Number(flags.pid);
const durationSeconds = Number(flags.seconds || 600);
const targetCycles = flags.cycles ? Number(flags.cycles) : null;
const selectedCase = flags.case || null;
const cases = ['long-context', 'multi-turn', 'tool-roundtrip', 'concurrent-queue', 'cancel-and-recover'];
if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(durationSeconds) || durationSeconds < 600
    || (targetCycles !== null && (!Number.isInteger(targetCycles) || targetCycles < 1 || targetCycles > 100))
    || (selectedCase && !cases.includes(selectedCase))) {
  throw new Error('Explicit --pid and --seconds>=600 are required; optional --cycles=1..100 and --case select a bounded follow-up.');
}
const reportPath = resolve(flags.report || '.runtime/local-provider-live/report.json');
const exec = promisify(execFile);
const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { windowsHide: true, maxBuffer: 128 * 1024 });
const line = stdout.trim();
if (!/llama-server\.exe/i.test(line)) throw new Error('The supplied process is not llama-server.');
const argument = (name) => {
  const match = new RegExp(`--${name}\\s+(?:"([^"]+)"|(\\S+))`).exec(line);
  return match?.[1] || match?.[2] || '';
};
const port = Number(argument('port')), apiKey = argument('api-key'), model = argument('alias');
if (!Number.isInteger(port) || !apiKey || !model) throw new Error('Required local server arguments are unavailable.');
const baseURL = `http://127.0.0.1:${port}/v1`;
const headers = { Authorization: `Bearer ${apiKey}` };
const propsResponse = await fetch(`http://127.0.0.1:${port}/props`, { headers, signal: AbortSignal.timeout(10_000) });
if (!propsResponse.ok) throw new Error(`Local props HTTP ${propsResponse.status}`);
recordLocalModelLoad(model, await propsResponse.json(), null);
const provider = new MixdogLocalProvider({}, { ensureServer: async () => ({ baseURL, apiKey }) });
const report = { startedAt: new Date().toISOString(), pid, model, durationSeconds, targetCycles, selectedCase, busySkips: 0, cases: [], failures: [] };
const started = Date.now();
const persist = () => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
};
const send = (messages, tools = [], options = {}) => provider.send(messages, model, tools, {
  maxOutputTokens: 2048, ...options,
  signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
});
async function check(name, action) {
  if (selectedCase && name.replace(/-\d+$/, '') !== selectedCase) return;
  const at = Date.now();
  try {
    const detail = await action();
    report.cases.push({ name, ok: true, elapsedMs: Date.now() - at, metrics: localModelState(model).inference, detail });
    console.log(`PASS ${name} ${Date.now() - at}ms`);
  } catch (error) {
    const failure = { name, elapsedMs: Date.now() - at, error: String(error?.message || error) };
    report.failures.push(failure);
    console.log(`FAIL ${name}: ${failure.error}`);
  }
  persist();
}
let cycle = 0;
try {
while (targetCycles !== null ? cycle < targetCycles : Date.now() - started < durationSeconds * 1000 || cycle < 2) {
  if (Date.now() - started > (durationSeconds + 600) * 1000) throw new Error('Live acceptance exceeded its bounded completion window.');
  const slotsResponse = await fetch(`http://127.0.0.1:${port}/slots`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!slotsResponse.ok) throw new Error(`Cannot establish server idleness: HTTP ${slotsResponse.status}`);
  const slots = await slotsResponse.json();
  if (!Array.isArray(slots)) throw new Error('Invalid server slots response');
  if (slots.some((slot) => slot.is_processing)) { report.busySkips++; await delay(2000); continue; }
  cycle++;
  await check(`long-context-${cycle}`, async () => {
    const records = Array.from({ length: 768 }, (_, index) => `Record ${index}: stored value is entry-${index}-copper.`);
    const result = await send([{ role: 'user', content: `${records.join('\n')}\nWhat is the exact stored value of Record 731? Reply with that value only.` }]);
    assert.ok(result.content.includes('entry-731-copper'));
  });
  await check(`multi-turn-${cycle}`, async () => {
    const marker = `marker-${cycle}-amber`;
    const messages = [{ role: 'system', content: 'Answer concisely and accurately.' },
      { role: 'system', content: 'This conversation uses short factual answers.' },
      { role: 'user', content: `Remember this marker for the next question: ${marker}. Briefly acknowledge it.` }];
    const first = await send(messages);
    assert.ok(first.content);
    messages.push({ role: 'assistant', content: first.content, reasoningContent: first.reasoningContent });
    messages.push({ role: 'user', content: 'What was the exact marker? Reply with the marker only.' });
    assert.ok((await send(messages)).content.includes(marker));
  });
  await check(`tool-roundtrip-${cycle}`, async () => {
    const tools = [{ name: 'read_probe_value', description: 'Read the current test value for a named field.',
      inputSchema: { type: 'object', properties: { field: { type: 'string', enum: ['marker'] } }, required: ['field'], additionalProperties: false } }];
    const messages = [{ role: 'user', content: 'Use read_probe_value to read the marker field. Then tell me its returned value.' }];
    const completed = await completeToolConversation({ send, messages, tools, executeTool: async (tool) => {
      assert.equal(tool.name, 'read_probe_value');
      assert.equal(tool.arguments.field, 'marker');
      return `probe-value-${cycle}`;
    } });
    assert.ok(completed.toolSteps > 0, `Model did not use the offered tool: ${JSON.stringify(completed.result).slice(0, 2000)}`);
    assertResponseContains(completed.result, `probe-value-${cycle}`);
    return { toolSteps: completed.toolSteps };
  });
  await check(`concurrent-queue-${cycle}`, async () => {
    const results = await Promise.all([
      send([{ role: 'user', content: 'What is 7 plus 8? Reply with just the result.' }]),
      send([{ role: 'user', content: 'What is 12 minus 5? Reply with just the result.' }]),
    ]);
    assert.match(results[0].content, /15/);
    assert.match(results[1].content, /7/);
  });
  await check(`cancel-and-recover-${cycle}`, async () => {
    const controller = new AbortController();
    let emitted = false;
    await assert.rejects(send([{ role: 'user', content: 'Explain the tradeoffs between caching, memory consumption, and request scheduling in a local inference server.' }], [], {
      signal: controller.signal,
      onStreamDelta(kind) {
        if (kind !== 'transport' && !emitted) { emitted = true; controller.abort(new Error('live check cancellation')); }
      },
    }));
    assert.equal(emitted, true);
    const recovered = await send([{ role: 'user', content: 'Reply with exactly RECOVERED.' }]);
    assert.match(recovered.content, /RECOVERED/);
  });
}
} catch (error) {
  report.failures.push({ name: 'runner', error: String(error?.message || error) });
}
report.finishedAt = new Date().toISOString();
report.elapsedMs = Date.now() - started;
report.cycles = cycle;
report.passed = report.failures.length === 0 && cycle >= (targetCycles || 2);
report.scope = 'Existing model process; long-running multi-turn/tool/queue/cancel recovery. No OS sleep, app restart, model reload or new model installation.';
persist();
console.log(JSON.stringify({ reportPath, passed: report.passed, cycles: cycle, elapsedMs: report.elapsedMs,
  failures: report.failures.length, maxToolSteps: Math.max(0, ...report.cases.map((entry) => entry.detail?.toolSteps || 0)) }));
if (!report.passed) process.exitCode = 1;
