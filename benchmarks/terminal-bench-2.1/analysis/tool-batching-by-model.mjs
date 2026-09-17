#!/usr/bin/env node
// Per-model tool batching from agent-trace.jsonl: how often a model round
// carried more than one call, how often array-capable tools received arrays,
// and how many batching reminders the runtime issued.
//
//   node benchmarks/terminal-bench-2.1/analysis/tool-batching-by-model.mjs [trace.jsonl] [--since=YYYY-MM-DD] [--json]
//
// Sessions are attributed to the model recorded on their first tool row.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeToolBatching } from './tool-batching.mjs';

function defaultTracePath() {
  const home = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
  const data = process.env.MIXDOG_DATA_DIR || join(home, 'data');
  return join(data, 'history', 'agent-trace.jsonl');
}

function parseArgs(argv) {
  const out = { trace: null, since: null, json: false };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg.startsWith('--since=')) out.since = Date.parse(arg.slice('--since='.length));
    else out.trace = arg;
  }
  return out;
}

export function readTraceRows(text, { since = null } = {}) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (Number.isFinite(since) && Number.isFinite(row?.ts) && row.ts < since) continue;
    rows.push(row);
  }
  return rows;
}

export function summarizeToolBatchingByModel(rows) {
  const modelBySession = new Map();
  for (const row of rows) {
    if (row.kind === 'tool' && row.model && row.session_id && !modelBySession.has(row.session_id)) {
      modelBySession.set(row.session_id, row.model);
    }
  }
  const rowsByModel = new Map();
  for (const row of rows) {
    if (!row.session_id) continue;
    const model = modelBySession.get(row.session_id) || 'unknown';
    if (!rowsByModel.has(model)) rowsByModel.set(model, []);
    rowsByModel.get(model).push(row);
  }
  const out = [];
  for (const [model, modelRows] of rowsByModel) {
    const summary = summarizeToolBatching(modelRows);
    const rounds = summary.groups_total;
    if (!rounds) continue;
    const arrays = summary.internal_arrays;
    const contract = arrays?.calls_with_array_contract ?? 0;
    const batched = arrays?.array_batched_calls ?? 0;
    out.push({
      model,
      sessions: new Set(modelRows.filter((row) => row.kind === 'batch').map((row) => row.session_id)).size,
      rounds,
      multi_call_rounds: summary.inter_tool.multi_call_groups,
      multi_call_pct: Math.round((1000 * summary.inter_tool.multi_call_groups) / rounds) / 10,
      array_contract_calls: contract,
      array_batched_calls: batched,
      array_batched_pct: contract ? Math.round((1000 * batched) / contract) / 10 : null,
      nudges: modelRows.filter((row) => row.kind === 'batching_nudge' && row.payload?.trigger !== 'per_round').length,
      per_round: modelRows.filter((row) => row.kind === 'batching_nudge' && row.payload?.trigger === 'per_round').length,
    });
  }
  return out.sort((a, b) => b.rounds - a.rounds);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('tool-batching-by-model.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  const rows = readTraceRows(readFileSync(args.trace || defaultTracePath(), 'utf8'), { since: args.since });
  const summary = summarizeToolBatchingByModel(rows);
  if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else console.table(summary);
}
