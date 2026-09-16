#!/usr/bin/env node
// Real-AI second-layer simulation on immutable, prepared first-layer cases.
// Input: { cases: [{ name, rows: [{id,ts,role,session_id,content,sourceIds}],
//                   preservedRawIds?, reviewCriteria? }] }.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { generateCycle1Chunks } from '../src/runtime/memory/lib/memory-chunk-quality.mjs';
import { estimateTokens } from '../src/runtime/agent/orchestrator/session/token-estimate.mjs';
import { makeAgentDispatch } from '../src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import { loadConfig } from '../src/runtime/agent/orchestrator/config.mjs';
import { resolveMaintenanceRoute } from '../src/runtime/agent/orchestrator/agent-runtime/maintenance-route.mjs';
import { initProviders } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import { loadScopedRoleInstructions } from '../src/runtime/agent/orchestrator/context/collect.mjs';
import { resolveMaintenancePreset } from '../src/runtime/shared/llm/index.mjs';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    case: { type: 'string', multiple: true },
  },
});
if (!values.input) throw new Error('--input must name a prepared first-layer case file');
const bytes = await readFile(values.input, 'utf8');
const sourceHash = createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(bytes);
assert.ok(Array.isArray(source.cases) && source.cases.length, 'cases must be nonempty');
const selectedCases = values.case ? new Set(values.case) : null;
if (selectedCases) {
  for (const name of selectedCases)
    assert.ok(
      source.cases.some((item) => item.name === name),
      `unknown case: ${name}`
    );
}
const directory = await mkdtemp(join(tmpdir(), 'mixdog-layer2-once-'));
await writeFile(join(directory, 'input.json'), bytes, { flag: 'wx' });
await writeFile(join(directory, 'working.json'), bytes, { flag: 'wx' });
console.log(`Artifacts: ${directory}`);
const working = structuredClone(source);
const config = loadConfig();
const configuredRoute =
  resolveMaintenancePreset('memory') || resolveMaintenanceRoute({ agent: 'cycle1-agent', config });
const preset =
  typeof configuredRoute === 'object'
    ? configuredRoute
    : config.presets.find((item) => item.id === configuredRoute || item.name === configuredRoute);
assert.ok(preset?.provider && preset?.model, 'second-layer model route is unresolved');
const request = {
  agent: 'cycle1-agent',
  taskType: 'maintenance',
  preset: { ...preset, effort: 'low' },
  timeout: 180000,
  cwd: null,
};
// The installed broker can carry an older, first-layer-only system policy.
// A source-code benchmark must use the worktree's actual scoped role rules,
// not a new user prompt under that incompatible old system instruction.
const roleInstructions = loadScopedRoleInstructions(request.agent, request.preset?.provider);
assert.ok(roleInstructions.includes('SECOND_LAYER'), 'source runtime did not load the second-layer role policy');
const rolePolicyHash = createHash('sha256').update(roleInstructions).digest('hex');
await initProviders(config.providers);
const dispatch = makeAgentDispatch({
  agent: request.agent,
  taskType: request.taskType,
  preset: request.preset,
  cwd: null,
  brief: false,
  config,
});
const outcomes = [];
let blocked = false;
for (const item of working.cases) {
  if (selectedCases && !selectedCases.has(item.name)) continue;
  if (blocked) {
    outcomes.push({ name: item.name, status: 'not_run_after_provider_failure' });
    continue;
  }
  const original = JSON.stringify(item);
  const inputText = item.rows.map((row) => row.content).join('\n');
  const inputTokens = estimateTokens(inputText);
  assert.ok(inputTokens >= 2);
  assert.equal(new Set(item.rows.map((row) => String(row.id))).size, item.rows.length);
  assert.equal(new Set(item.rows.map((row) => row.session_id)).size, 1);
  const calls = [];
  const result = await generateCycle1Chunks(item.rows, {
    // Prepared cases have no measured live-context budget. Report the writing
    // target separately instead of inventing a hard half-size context limit.
    layer: 2,
    request,
    callLlm: async (options, prompt) => {
      const response = await dispatch({
        prompt,
        preset: options.preset,
        cwd: null,
        parentSignal: options.signal,
        idleTimeoutMs: options.timeout,
      });
      calls.push({ mode: options.mode, response });
      return response;
    },
  });
  assert.equal(JSON.stringify(item), original, 'source input mutated');
  assert.ok(result);
  assert.ok(result.stats.groupingCalls <= 1, 'second layer must not make multiple AI calls');
  const fallback = new Set(result.rawRowIds.map(String));
  const units = [
    ...result.chunks.map((chunk) => ({
      position: Math.min(...chunk._idxList) - 1,
      text: chunk.summary,
      parentIds: chunk.members.map((row) => String(row.id)),
    })),
    ...item.rows.flatMap((row, position) =>
      fallback.has(String(row.id)) ? [{ position, text: row.content, parentIds: [String(row.id)] }] : []
    ),
  ].sort((a, b) => a.position - b.position);
  const parentIds = units.flatMap((unit) => unit.parentIds);
  assert.equal(new Set(parentIds).size, parentIds.length);
  assert.deepEqual(parentIds.slice().sort(), item.rows.map((row) => String(row.id)).sort());
  const text = units.map((unit) => unit.text).join('\n');
  const outputTokens = estimateTokens(text);
  if (result.compression.used) assert.ok(outputTokens < inputTokens);
  const sourceIds = item.rows.flatMap((row) => row.sourceIds || [String(row.id)]);
  assert.equal(new Set(sourceIds).size, sourceIds.length);
  assert.equal(result.stats.verificationCalls, 0);
  assert.equal(result.stats.retries, 0);
  outcomes.push({
    name: item.name,
    applied: result.compression.used,
    targetMet: result.compression.targetMet,
    inputChunks: item.rows.length,
    outputChunks: result.chunks.length,
    fallbackChunks: fallback.size,
    inputTokens,
    outputTokens,
    reductionPercent: (100 * (inputTokens - outputTokens)) / inputTokens,
    stats: result.stats,
    compression: result.compression,
    errors: result.invalidChunks,
    parentCoverage: parentIds.length,
    sourceRowCoverage: sourceIds.length,
    preservedRawIds: item.preservedRawIds || [],
    reviewCriteria: item.reviewCriteria || [],
    text,
    calls,
  });
  if (result.invalidChunks.some((error) => error.reason === 'llm_error')) blocked = true;
}
assert.equal(
  createHash('sha256')
    .update(await readFile(values.input, 'utf8'))
    .digest('hex'),
  sourceHash
);
assert.deepEqual(working, source);
const report = {
  sourceHash,
  sourceUnchanged: true,
  runtime: 'source',
  route: request.preset,
  rolePolicyHash,
  outcomes,
  blocked,
  allSizeTargetsMet: outcomes.length > 0 && outcomes.every((outcome) => outcome.targetMet === true),
  scope:
    'Single-call lossy second-layer compression with a soft half-size writing target. Reports time and approximate savings, not semantic equivalence. No AI verification, quality rejection, retry, live DB update or automatic compaction deployment.',
};
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(
  JSON.stringify(
    {
      directory,
      sourceUnchanged: report.sourceUnchanged,
      route: report.route,
      allSizeTargetsMet: report.allSizeTargetsMet,
      blocked,
      outcomes: outcomes.map(({ calls, reviewCriteria, ...outcome }) => outcome),
    },
    null,
    2
  )
);
process.exitCode = blocked ? 1 : 0;
