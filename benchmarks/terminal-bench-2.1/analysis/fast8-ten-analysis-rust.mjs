// Task-neutral raw-trace comparison and immutable candidate snapshots, on the Rust core (`mixdogd`): the K1
// replacement of fast8-ten-analysis.mjs, whose `snapshot` mode imported Node's builtin, code-graph and patch
// tool definitions. The tool contracts now come from the catalog `tools/toolsStatus` returns with `snapshot`
// (contract-hash-rust.mjs); `analyze` and `calls` read run directories only and are unchanged.
// Usage: snapshot <backup-dir> <label> --mixdogd <bin> | analyze <jobs-dir> <baseline-dir> <backup-dir>
//        calls <jobs-dir> <task-id>...
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRouteSnapshots, digestFromSnapshots } from './contract-hash-rust.mjs';
import { summarizeToolBatching } from './tool-batching.mjs';

const json = p => JSON.parse(readFileSync(p, 'utf8'));
const jsonl = p => readFileSync(p, 'utf8').split(/\r?\n/).filter(s => s.trim()).map(JSON.parse);
const sum = xs => xs.reduce((a, b) => a + b, 0);
export function strip(x) {
  if (Array.isArray(x)) return x.map(strip);
  if (!x || typeof x !== 'object') return x;
  return Object.fromEntries(Object.entries(x)
    .filter(([k]) => k !== 'description' && k !== 'freeformDescription')
    .map(([k, v]) => [k, strip(v)]));
}

/**
 * The complete non-description contract array, as Node's snapshot compared it (`assert.deepEqual` of the whole
 * `[...BUILTIN_TOOLS, ...CODE_GRAPH_TOOL_DEFS, ...PATCH_TOOL_DEFS]` against the baseline): every tool of the
 * baseline must be in the route's catalog, in the same order, and the catalog may hold no other tool. Returns what
 * differs: a changed tool by name, `+name` for a tool the baseline lacks, `-name` for one the catalog lacks,
 * `(order)` when only the order differs. `baseline.contracts` is therefore recorded from this same catalog.
 */
export function changedContracts(catalog, baselineContracts) {
  const now = catalog.map(tool => sortKeys(strip(tool)));
  const was = baselineContracts.map(tool => sortKeys(strip(tool)));
  const text = tool => JSON.stringify(tool);
  const wasByName = new Map(was.map(tool => [tool.name, text(tool)]));
  const nowByName = new Map(now.map(tool => [tool.name, text(tool)]));
  const changed = [];
  for (const [name, contract] of nowByName) {
    if (!wasByName.has(name)) changed.push(`+${name}`);
    else if (wasByName.get(name) !== contract) changed.push(name);
  }
  for (const name of wasByName.keys()) if (!nowByName.has(name)) changed.push(`-${name}`);
  if (!changed.length && text(now) !== text(was)) changed.push('(order)');
  return changed;
}
function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (!x || typeof x !== 'object') return x;
  return Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys(x[k])]));
}

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

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'snapshot') {
    const mixdogd = args.indexOf('--mixdogd');
    assert.ok(mixdogd >= 0 && args[mixdogd + 1], 'snapshot needs --mixdogd <bin>');
    const [dir, label] = args;
    const baseline = json(join(dir, 'baseline.json'));
    // The digest and the catalog come from the same core start.
    const routes = await collectRouteSnapshots({ bin: resolve(args[mixdogd + 1]), provider: 'openai-oauth', model: 'gpt-5.6-sol' });
    const digest = digestFromSnapshots(REPO_ROOT, 'headless', routes);
    const catalog = routes.find(r => r.id === 'lead').snapshot.catalog;
    assert.ok(catalog.length > 0, 'the route catalog is empty');
    const changed = changedContracts(catalog, baseline.contracts);
    assert.deepEqual(changed, [], `non-description tool contracts changed: ${changed.join(', ')}`);
    const files = Object.fromEntries(Object.keys(baseline.files).map(p => [p, readFileSync(p, 'utf8')]));
    writeFileSync(join(dir, `${label}-source.json`), JSON.stringify({ files, digest }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ label, contracts: catalog.length, prompt: digest.promptSurfaceBytes,
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
          let shownArgs = a;
          if (a.patch) shownArgs = { patchChars: a.patch.length };
          else if (a.command) shownArgs = { command: '(below)' };
          console.log(JSON.stringify({ request, name: item.name,
            args: shownArgs,
            status: item.status, outputChars: output.length }));
          if (a.command) console.log(typeof a.command === 'string' ? a.command : JSON.stringify(a.command));
          console.log(output.slice(0, 600));
        } else if (item?.type === 'agent_message') console.log(JSON.stringify({ request, text: item.text }));
      }
    }
  } else throw new Error('Expected snapshot, analyze, or calls.');
}

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
