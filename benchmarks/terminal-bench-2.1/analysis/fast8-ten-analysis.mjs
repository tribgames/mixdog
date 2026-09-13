// Task-neutral raw-trace comparison and immutable candidate snapshots.
// Usage: snapshot <backup-dir> <label> | analyze <jobs-dir> <baseline-dir> <backup-dir>
//        calls <jobs-dir> <task-id>...
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { buildContractDigest } from './contract-hash.mjs';
import { summarizeToolBatching } from './tool-batching.mjs';

const json = p => JSON.parse(readFileSync(p, 'utf8'));
const jsonl = p => readFileSync(p, 'utf8').split(/\r?\n/).filter(s => s.trim()).map(JSON.parse);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const strip = x => Array.isArray(x) ? x.map(strip) : x && typeof x === 'object'
  ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'description' && k !== 'freeformDescription').map(([k, v]) => [k, strip(v)])) : x;
const [mode, ...args] = process.argv.slice(2);

function trials(report) {
  return readdirSync(report.paths.runDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.includes('__'))
    .map(e => ({ task: e.name.split('__')[0], agent: join(report.paths.runDir, e.name, 'agent') }));
}

function analyze(root) {
  const report = json(join(root, 'report.json'));
  const rows = trials(report).map(({ task, agent }) => {
    const trace = jsonl(join(agent, 'agent-trace.jsonl'));
    const events = jsonl(join(agent, 'mixdog.txt'));
    const usages = trace.filter(e => e.kind === 'usage_raw');
    const calls = events.filter(e => e.type === 'item.completed' && e.item?.type === 'tool_call');
    const requests = events.filter(e => e.type === 'model.request.started').length;
    const completed = events.filter(e => e.type === 'model.request.completed').length;
    const failed = events.filter(e => e.type === 'model.request.failed').length;
    const row = report.tasks.find(r => r.task === task);
    assert.ok(row, `missing report task ${task}`);
    const tokens = {
      input: sum(usages.map(e => e.prompt_tokens)),
      cached: sum(usages.map(e => e.cached_tokens)),
      output: sum(usages.map(e => e.output_tokens)),
      cacheWrite: sum(usages.map(e => e.cache_write_tokens)),
    };
    assert.deepEqual(tokens, row.tokens, `${task}: raw/report tokens`);
    assert.equal(requests, row.activity.providerRequests, `${task}: requests`);
    assert.equal(usages.length, completed, `${task}: completed usage`);
    assert.equal(completed + failed, requests, `${task}: request outcomes`);
    assert.equal(calls.length, row.activity.toolCalls, `${task}: tool calls`);
    assert.equal(trace.filter(e => e.kind === 'tool').length, calls.length, `${task}: trace calls`);
    return {
      task, passed: row.passed, agent: row.agentSeconds, ...tokens,
      requests, usageResponses: usages.length, failedRequests: failed, calls: calls.length,
      thinking: sum(usages.map(e => e.thinking_tokens)),
      finalThinking: usages.at(-1)?.thinking_tokens,
      batching: summarizeToolBatching(trace),
      errorKinds: trace.filter(e => /error|retry|cancel/i.test(e.kind)).map(e => e.kind),
    };
  }).sort((a, b) => a.task.localeCompare(b.task));
  assert.equal(rows.length, report.result.total);
  for (const key of ['input', 'cached', 'output', 'cacheWrite']) {
    assert.equal(sum(rows.map(r => r[key])), report.tokens[key], `total ${key}`);
  }
  assert.equal(sum(rows.map(r => r.requests)), report.activity.providerRequests);
  assert.equal(sum(rows.map(r => r.calls)), report.activity.toolCalls);
  return {
    run: basename(root), fingerprint: report.preset.fingerprint,
    result: report.result, timing: report.timing, tokens: report.tokens,
    cost: report.cost, usdPerAgentMinute: report.cost.usd / report.timing.agentTotalSeconds * 60,
    activity: report.activity, finalContext: report.finalContext,
    reduction: report.reduction, contract: {
      promptBytes: report.preset.contract.promptSurfaceBytes,
      toolBytes: report.preset.contract.providerToolBytes,
    },
    thinking: sum(rows.map(r => r.thinking)),
    finalThinking: sum(rows.map(r => r.finalThinking)),
    errorKinds: rows.flatMap(r => r.errorKinds),
    rows,
  };
}

if (mode === 'snapshot') {
  const [dir, label] = args;
  const baseline = json(join(dir, 'baseline.json'));
  const digest = await buildContractDigest(undefined, { provider: 'openai-oauth', model: 'gpt-5.6-sol' });
  const { BUILTIN_TOOLS } = await import('../../../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs');
  const { CODE_GRAPH_TOOL_DEFS } = await import('../../../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs');
  const { PATCH_TOOL_DEFS } = await import('../../../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs');
  const contracts = strip([...BUILTIN_TOOLS, ...CODE_GRAPH_TOOL_DEFS, ...PATCH_TOOL_DEFS]);
  assert.deepEqual(contracts, strip(baseline.contracts), 'non-description tool contracts changed');
  const files = Object.fromEntries(Object.keys(baseline.files).map(p => [p, readFileSync(p, 'utf8')]));
  writeFileSync(join(dir, `${label}-source.json`), JSON.stringify({ files, digest }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ label, contracts: contracts.length, prompt: digest.promptSurfaceBytes,
    tools: digest.providerToolBytes, total: digest.promptSurfaceBytes + digest.providerToolBytes }));
} else if (mode === 'analyze') {
  const [root, baselineRoot, dir] = args.map(p => resolve(p));
  const current = analyze(root);
  // The baseline was cross-checked in the completed C1 analysis. Reuse its
  // report; only the new run needs raw-trace verification.
  const baseline = json(join(baselineRoot, 'report.json'));
  const baselineRows = [...baseline.tasks].sort((a, b) => a.task.localeCompare(b.task));
  assert.equal(current.fingerprint, baseline.preset.fingerprint);
  assert.deepEqual(current.rows.map(r => r.task), baselineRows.map(r => r.task));
  const paired = current.rows.map((r, i) => ({ task: r.task,
    outputDelta: r.output - baselineRows[i].tokens.output, secondsDelta: r.agent - baselineRows[i].agentSeconds,
    callsDelta: r.calls - baselineRows[i].activity.toolCalls }));
  const result = { ...current, baseline: basename(baselineRoot), paired };
  writeFileSync(join(dir, `${current.run}-analysis.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
} else if (mode === 'calls') {
  const [root, ...tasks] = args;
  const report = json(join(root, 'report.json'));
  for (const { task, agent } of trials(report).filter(t => tasks.includes(t.task))) {
    console.log(`\n## ${task}`);
    let request = 0;
    for (const e of jsonl(join(agent, 'mixdog.txt'))) {
      if (e.type === 'model.request.started') request++;
      if (e.type !== 'item.completed') continue;
      const item = e.item;
      if (item?.type === 'tool_call') {
        const output = typeof item.output === 'string' ? item.output
          : (item.output?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        const a = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
        console.log(JSON.stringify({ request, name: item.name,
          args: a.patch ? { patchChars: a.patch.length } : a.command ? { command: '(below)' } : a,
          status: item.status, outputChars: output.length }));
        if (a.command) console.log(typeof a.command === 'string' ? a.command : JSON.stringify(a.command));
        console.log(output.slice(0, 600));
      } else if (item?.type === 'agent_message') console.log(JSON.stringify({ request, text: item.text }));
    }
  }
} else throw new Error('Expected snapshot, analyze, or calls.');
