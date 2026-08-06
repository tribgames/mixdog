// TEMPORARY (delete after use): replay every current rescue/classification
// rule over the last 5 days of logged tool failures and report what would no
// longer surface as a failure.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isLegitimateShellExit } from '../src/runtime/agent/orchestrator/session/result-classification.mjs';
import { _isBenignSearchExitOne } from '../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';
import { hasPowerShellOnlySyntax, planInlineScriptHoist } from '../src/runtime/agent/orchestrator/tools/builtin/shell-analysis.mjs';
import { normalizeCoreOp, normalizeCoreInput } from '../src/runtime/memory/lib/core-memory-store.mjs';

const dir = resolve(homedir(), '.mixdog', 'data', 'history');
const rows = [];
for (const file of ['tool-failures.jsonl', 'tool-failures.jsonl.1']) {
  const p = join(dir, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
}
const recent = rows.filter((r) => Number(r.ts) >= Date.now() - 5 * 86400000);

const TEST_FIXTURES = new Set(['unknown_test_tool', 'definitely_missing_tool']);
const buckets = {
  total: recent.length,
  testNoise: 0,
  retiredGuard: 0,
  legitimateExit: 0,
  benignSearch: 0,
  bashRescue: 0,
  inlineHoist: 0,
  codeGraphDot: 0,
  memoryArgs: 0,
  webFetchArgs: 0,
  grepArgs: 0,
  realFailure: 0,
};

for (const row of recent) {
  const tool = String(row.tool_name || '');
  const head = String(row.error_first_line || '');
  const preview = String(row.error_preview || head);
  const cmd = String(row.tool_args?.command || '');
  if (TEST_FIXTURES.has(tool) || /^Error: patch failed$/.test(head)
    || /must be of type string\. Received undefined/.test(head)) { buckets.testNoise += 1; continue; }
  if (/resource pressure/i.test(preview)) { buckets.retiredGuard += 1; continue; }
  if (tool === 'shell') {
    if (/PowerShell preflight blocked/.test(head)) {
      if (cmd && !hasPowerShellOnlySyntax(cmd)) { buckets.bashRescue += 1; continue; }
      buckets.realFailure += 1; continue;
    }
    if (/\[exit code: 1\]/.test(head)) {
      if (cmd && _isBenignSearchExitOne(cmd, 1, null, '')) { buckets.benignSearch += 1; continue; }
      const body = preview.replace(/^Error:[^\n]*\n?/, '');
      const stderr = /\[stderr/.test(body) ? 'x' : '';
      if (isLegitimateShellExit({ exitCode: 1, signal: null, stdout: body, stderr })) { buckets.legitimateExit += 1; continue; }
      if (cmd && planInlineScriptHoist(cmd) && /SyntaxError|ParserError|Unexpected token|missing the terminator/i.test(preview)) {
        buckets.inlineHoist += 1; continue;
      }
    }
    buckets.realFailure += 1; continue;
  }
  if (tool === 'code_graph') {
    const a = row.tool_args || {};
    const files = Array.isArray(a.files) ? a.files : (typeof a.files === 'string' ? [a.files] : []);
    if (files.length && files.every((f) => String(f).trim() === '.')) { buckets.codeGraphDot += 1; continue; }
    buckets.realFailure += 1; continue;
  }
  if (tool === 'memory') {
    const a = row.tool_args || {};
    const opFixed = ['add', 'edit', 'delete', 'list', 'candidates', 'promote', 'dismiss'].includes(normalizeCoreOp(a.op));
    const argsFixed = normalizeCoreInput(a, { requireElement: true, requireSummary: true }).errors.length === 0;
    if (opFixed && argsFixed) { buckets.memoryArgs += 1; continue; }
    buckets.realFailure += 1; continue;
  }
  if (tool === 'web_fetch') {
    const url = row.tool_args?.url;
    if (typeof url === 'string' && /^\s*\[/.test(url)) { buckets.webFetchArgs += 1; continue; }
    buckets.realFailure += 1; continue;
  }
  if (tool === 'grep' || tool === 'glob' || tool === 'list' || tool === 'find') {
    if (/must be string or string\[\] \(got (?:null|undefined|array)\)/.test(head)) { buckets.grepArgs += 1; continue; }
    buckets.realFailure += 1; continue;
  }
  buckets.realFailure += 1;
}

const rescued = buckets.legitimateExit + buckets.benignSearch + buckets.bashRescue + buckets.inlineHoist
  + buckets.codeGraphDot + buckets.memoryArgs + buckets.webFetchArgs + buckets.grepArgs;
const pct = (n) => `${((n / buckets.total) * 100).toFixed(1)}%`;
console.log(JSON.stringify(buckets, null, 1));
console.log(`\nrescued/reclassified: ${rescued} (${pct(rescued)})`);
console.log(`test noise: ${buckets.testNoise} (${pct(buckets.testNoise)})`);
console.log(`retired guard: ${buckets.retiredGuard} (${pct(buckets.retiredGuard)})`);
console.log(`remaining real failures: ${buckets.realFailure} (${pct(buckets.realFailure)})`);
