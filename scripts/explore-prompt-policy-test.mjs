#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExplorerPrompt } from '../src/standalone/explore-tool.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';

test('explore per-query prompt leaves path policy to tool schemas', () => {
  const prompt = buildExplorerPrompt('display model usage show usage model_usage provider_usage session cache usage state');
  assert.doesNotMatch(prompt, /Path policy:/i);
  assert.doesNotMatch(prompt, /run find for that fragment before any grep\/glob/i);
});

test('grep glob find tool schemas carry unverified path policy', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  // Conditional find-first: only genuinely guessed fragments route through
  // find, and in the SAME turn — project root itself is a verified scope.
  assert.match(byName.grep.description, /project root counts as verified/i);
  assert.match(byName.grep.description, /guessed path fragment → find first, same turn/i);
  assert.match(byName.grep.description, /no path "\." \+ guessed src\/\*\*/i);
  assert.match(byName.glob.description, /project root is verified/i);
  assert.match(byName.glob.description, /Guessed root\/name → find first, same turn/i);
  assert.match(byName.find.description, /verify roots before grep\/glob/i);
});

test('explorer turn-1 contract includes batched find for unknown broad targets', () => {
  const rule = readFileSync(new URL('../src/rules/agent/30-explorer.md', import.meta.url), 'utf8');
  assert.match(rule, /Turn 1 is the whole search in ONE message/i);
  assert.match(rule, /unknown\/broad\s+targets\)\s+find `query\[\]`/i);
  assert.match(rule, /path\/name fragments from multiple tokens/i);
});
