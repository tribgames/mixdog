// Read-only comparison of one completed run with a same-preset reference.
// Usage: node analysis/round-metrics.mjs <jobs-dir> <reference-jobs-dir>
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const jsonl = (path) => readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const [jobs, reference] = process.argv.slice(2);
if (!jobs || !reference) throw new Error('Expected a jobs directory and a reference jobs directory');
const report = json(join(root, jobs, 'report.json'));
const before = json(join(root, reference, 'report.json'));
if (report.preset.fingerprint !== before.preset.fingerprint) {
  throw new Error('Preset fingerprints differ; do not compare these runs');
}
const prior = new Map(before.tasks.map((task) => [task.task, task]));
const rows = [];
for (const entry of readdirSync(report.paths.runDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.includes('__')) continue;
  const trial = join(report.paths.runDir, entry.name);
  const result = json(join(trial, 'result.json'));
  const task = entry.name.split('__')[0];
  const current = report.tasks.find((item) => item.task === task);
  const previous = prior.get(task);
  if (!current || !previous) throw new Error(`Unpaired task: ${task}`);
  const events = jsonl(join(trial, 'agent/agent-trace.jsonl'));
  const usage = events.filter((event) => event.kind === 'usage_raw');
  const total = usage.reduce((sum, event) => sum + event.output_tokens, 0);
  if (total !== current.tokens.output) throw new Error(`Output token mismatch: ${task}`);
  if ((result.verifier_result?.rewards?.reward === 1) !== current.passed) {
    throw new Error(`Verifier/report mismatch: ${task}`);
  }
  const lastUsageIndex = events.findLastIndex((event) => event.kind === 'usage_raw');
  const last = events[lastUsageIndex];
  const stream = events.slice(0, lastUsageIndex).findLast((event) => event.kind === 'sse');
  const batches = events.filter((event) => event.kind === 'batch');
  const transcript = jsonl(join(trial, 'agent/mixdog.txt'));
  const calls = transcript.flatMap((event, index) => {
    const item = event.item;
    if (event.type !== 'item.completed' || item?.type !== 'tool_call') return [];
    return [{
      line: index + 1,
      tool: item.name,
      args: JSON.stringify(item.arguments ?? {}).slice(0, 260),
      output: String(item.output ?? '').slice(-160),
    }];
  });
  rows.push({
    task, trial: entry.name, passed: current.passed,
    output: total, outputDelta: total - previous.tokens.output,
    thinking: usage.reduce((sum, event) => sum + (event.thinking_tokens ?? 0), 0),
    requests: usage.length, tools: calls.length, batches: batches.length,
    multi: batches.filter((event) => event.payload.tool_call_count > 1).length,
    seconds: current.agentSeconds,
    secondsDelta: current.agentSeconds - previous.agentSeconds,
    finalThinking: last?.thinking_tokens ?? null,
    finalStreamMs: stream?.stream_total_ms ?? null,
    calls,
  });
}
if (rows.length !== report.result.total) throw new Error('Trial coverage mismatch');
const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
console.log(JSON.stringify({
  jobs, reference, result: report.result, tokens: report.tokens,
  thinking: sum('thinking'), finalThinking: sum('finalThinking'),
  requests: sum('requests'), tools: sum('tools'),
  batches: sum('batches'), multi: sum('multi'),
  wallSeconds: report.timing.wallSeconds,
  agentSeconds: report.timing.agentTotalSeconds,
  context: report.finalContext, cost: report.cost,
  costPerAgentMinute: report.cost.usd * 60 / report.timing.agentTotalSeconds,
  reduction: report.reduction.totalSavedBytes,
  contract: {
    rules: report.preset.contract?.rulesHash,
    tools: report.preset.contract?.toolContractHash,
    prompt: report.preset.contract?.promptSurfaceHash,
  },
  bundle: report.preset.runtime?.bundleSha256,
  tasks: rows.map(({ calls, ...row }) => row),
}, null, 2));
const inspect = rows.filter((row) => row.outputDelta > 0 || !row.passed)
  .sort((a, b) => b.outputDelta - a.outputDelta).slice(0, 3);
for (const row of inspect) {
  console.log(`TRACE ${row.trial}`);
  for (const call of row.calls) console.log(JSON.stringify(call));
}
