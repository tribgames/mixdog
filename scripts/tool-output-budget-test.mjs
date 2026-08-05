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
import { LOCATOR_OUTPUT_MAX_BYTES } from '../src/runtime/agent/orchestrator/tools/builtin/tool-output-limit.mjs';

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

test('locator tools share a 20KB call budget and list omits unused metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-locator-budget-'));
  try {
    for (let file = 0; file < 600; file += 1) {
      const name = `budget-item-${String(file).padStart(4, '0')}-${'x'.repeat(72)}.txt`;
      writeFileSync(join(dir, name), 'x');
    }
    const listResult = await executeBuiltinTool('list', {
      path: dir,
      head_limit: 0,
      offset: 0,
    }, dir);
    assert.ok(Buffer.byteLength(listResult, 'utf8') <= LOCATOR_OUTPUT_MAX_BYTES);
    assert.match(listResult, /\tfile(?:\r?\n|$)/);
    assert.doesNotMatch(listResult, /\tfile\t/);
    assert.match(listResult, /continue path=.* offset:\d+/);

    const globResult = await executeBuiltinTool('glob', {
      path: dir,
      pattern: '*.txt',
      head_limit: 0,
      offset: 0,
    }, dir);
    assert.ok(Buffer.byteLength(globResult, 'utf8') <= LOCATOR_OUTPUT_MAX_BYTES);
    assert.match(globResult, /continue path=.* offset:\d+/);

    const findResult = await executeBuiltinTool('find', {
      path: dir,
      query: 'budget-item',
      head_limit: 0,
    }, dir);
    assert.ok(Buffer.byteLength(findResult, 'utf8') <= LOCATOR_OUTPUT_MAX_BYTES);
    assert.match(findResult, /find result budget reached for query="budget-item"/);

    const batchedFindResult = await executeBuiltinTool('find', {
      path: dir,
      query: ['budget-item', 'item', 'txt', 'budget'],
      head_limit: 100,
    }, dir);
    const batchedPathLines = batchedFindResult.split(/\r?\n/)
      .filter((line) => line.includes('budget-item-'));
    assert.ok(batchedPathLines.length <= 100);
    assert.ok(Buffer.byteLength(batchedFindResult, 'utf8') <= LOCATOR_OUTPUT_MAX_BYTES);
    assert.doesNotMatch(batchedFindResult, /find output capped at 20 KB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
