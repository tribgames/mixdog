// Isolated synthetic histories only: no live daemon, credentials or model calls.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as immediate } from 'node:timers/promises';
import { legacyTokenFloors } from './transcript-baseline.mjs';
import { denseTokenFloor, structuredTokenFloor } from '../../src/runtime/agent/orchestrator/session/token-estimate-floors.mjs';
import { estimateMessagesTokens, summarizeContextMessages } from '../../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { readTopLevelLifecycleRecord } from '../../src/runtime/agent/orchestrator/session/lifecycle-scan.mjs';
import { createCanonicalSessionReader } from '../../src/runtime/agent/orchestrator/session/store/canonical-reader.mjs';
import { yieldToRenderer } from '../../src/tui/session/render-timing.mjs';

const directory = mkdtempSync(join(tmpdir(), 'mixdog-transcript-perf-'));
const messages = Array.from({ length: 1000 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `message ${i}\n${'ordinary content with spaces '.repeat(280)}`,
}));
const raw = JSON.stringify({ id: 'synthetic', closed: false, generation: 1, messages });
const target = join(directory, 'synthetic.json');
writeFileSync(target, raw);
const currentReader = createCanonicalSessionReader();
const oldReader = () => readTopLevelLifecycleRecord(readFileSync(target, 'utf8'));
const currentFloors = value => Math.max(denseTokenFloor(value), structuredTokenFloor(value));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timed = async (name, action, repetitions = 5) => {
    const samples = [];
    for (let i = 0; i < repetitions; i++) {
        globalThis.gc?.();
        const start = performance.now();
        await action();
        samples.push(performance.now() - start);
    }
    return { name, medianMs: +median(samples).toFixed(3), samplesMs: samples.map(n => +n.toFixed(3)) };
};
const results = [];
results.push(await timed('token-floors-before', () => messages.forEach(m => legacyTokenFloors(m.content))));
results.push(await timed('token-floors-after', () => messages.forEach(m => currentFloors(m.content))));
results.push(await timed('full-token-meter-after', () => estimateMessagesTokens(messages)));
results.push(await timed('context-summary-cold-after', () => summarizeContextMessages(structuredClone(messages))));
summarizeContextMessages(messages);
results.push(await timed('context-summary-warm-after', () => summarizeContextMessages(messages)));
results.push(await timed('canonical-before', oldReader));
currentReader(target, true);
results.push(await timed('canonical-warm-after', () => currentReader(target, true)));
results.push(await timed('headless-render-yield-after', () => yieldToRenderer()));
// An independent queued session callback shares the SAME event loop with the
// heavy operation. Its delay attributes interference directly to this batch,
// unlike a live daemon's unrelated maximum event-loop observation.
for (const [name, action] of [
    ['shared-loop-before', () => { messages.forEach(m => legacyTokenFloors(m.content)); oldReader(); }],
    ['shared-loop-after', () => { messages.forEach(m => currentFloors(m.content)); currentReader(target, true); }],
]) {
    results.push(await timed(name, async () => {
        const otherSession = immediate();
        action();
        await otherSession;
    }));
}
const report = { bytes: Buffer.byteLength(raw), messageCount: messages.length, directory, results,
    limits: 'Synthetic same-event-loop contention, not attribution of the prior live 502ms event.' };
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
