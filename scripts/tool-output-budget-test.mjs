#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAggregateOffloadEligible,
  maybeOffloadToolResultBatch,
} from '../src/runtime/agent/orchestrator/session/tool-result-offload.mjs';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { READ_MAX_OUTPUT_BYTES } from '../src/runtime/agent/orchestrator/tools/builtin/read-constants.mjs';

test('aggregate offload excludes Read/Skill and chooses the latest largest result', async () => {
  const entries = [
    { toolCallId: 'read-1', toolName: 'read', result: 'r'.repeat(1_000) },
    { toolCallId: 'grep-1', toolName: 'grep', result: 'g'.repeat(70) },
    { toolCallId: 'skill-1', toolName: 'skill', result: 'k'.repeat(1_000) },
    { toolCallId: 'glob-1', toolName: 'glob', result: 'b'.repeat(70) },
    { toolCallId: 'shell-1', toolName: 'shell', result: 's'.repeat(20) },
  ];
  const forced = [];
  const states = await maybeOffloadToolResultBatch('budget-test', entries, {
    maxAggregateChars: 110,
    applyPerToolLimits: false,
    offloadResult: async (_sessionId, _toolCallId, toolName, result, options) => {
      if (!options.force) return result;
      forced.push(toolName);
      return `[saved:${toolName}]`;
    },
  });
  assert.deepEqual(forced, ['glob']);
  assert.equal(states[0].result, entries[0].result);
  assert.equal(states[2].result, entries[2].result);
  assert.equal(states[3].result, '[saved:glob]');
  assert.equal(isAggregateOffloadEligible('read', 'text'), false);
  assert.equal(isAggregateOffloadEligible('skill_view', 'text'), false);
  assert.equal(isAggregateOffloadEligible('grep', { content: [] }), false);
});

test('batched Read shares one 50KB budget and returns exact continuation offsets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-read-budget-'));
  try {
    const paths = [];
    for (let file = 0; file < 6; file += 1) {
      const name = `large-${file}.txt`;
      paths.push(name);
      const body = Array.from(
        { length: 1_000 },
        (_, line) => `row-${line}-${String(file).repeat(96)}`,
      ).join('\n');
      writeFileSync(join(dir, name), body);
    }
    const result = await executeBuiltinTool(
      'read',
      { path: paths },
      dir,
      { readStateScope: {}, sessionId: 'read-budget-test' },
    );
    assert.equal(typeof result, 'string');
    assert.ok(Buffer.byteLength(result, 'utf8') <= READ_MAX_OUTPUT_BYTES);
    assert.match(result, /pass offset:\d+ to continue/);
    assert.doesNotMatch(result, /row-999-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
