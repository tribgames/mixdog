#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { __saveModelSettingsForTest } from '../src/mixdog-session-runtime.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = resolve(__dirname, '../src/mixdog-session-runtime.mjs');

test('setEffort persists through adoptConfig with in-memory baseConfig', () => {
  const src = readFileSync(RUNTIME_SRC, 'utf8');
  const block = src.match(/async setEffort\(value\) \{[\s\S]*?\n    \},/)?.[0] || '';
  assert.match(block, /adoptConfig\(saveModelSettings\(cfgMod, route, \{ fastCapable, baseConfig: config \}\)/);
  assert.doesNotMatch(block, /config = saveModelSettings/);
});

test('saveModelSettings preserves baseConfig fields not present on disk', () => {
  const saved = [];
  const cfgMod = {
    loadConfig: () => ({ profile: 'from-disk', modelSettings: {}, fastModels: {} }),
    saveConfig: (next) => {
      saved.push(next);
      return next;
    },
  };
  const baseConfig = {
    profile: 'in-memory-only',
    modelSettings: {},
    fastModels: {},
    autoClear: { enabled: true },
  };
  const route = { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };
  const result = __saveModelSettingsForTest(cfgMod, route, { fastCapable: true, baseConfig });
  assert.equal(result.profile, 'in-memory-only');
  assert.equal(result.autoClear?.enabled, true);
  assert.equal(result.modelSettings['openai/gpt-5.4']?.effort, 'high');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].profile, 'in-memory-only');
});
