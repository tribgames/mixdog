#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { __saveModelSettingsForTest } from '../src/mixdog-session-runtime.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// setEffort moved out of the runtime entry into the model/route API module;
// the guard follows the code instead of silently matching an empty block.
const ROUTE_API_SRC = resolve(__dirname, '../src/session-runtime/model-route-api.mjs');

test('setEffort persists through adoptConfig with in-memory baseConfig', () => {
  const src = readFileSync(ROUTE_API_SRC, 'utf8');
  const block = src.match(/async setEffort\(value\) \{[\s\S]*?\n    \},/)?.[0] || '';
  assert.notEqual(block, '');
  assert.match(block, /adoptConfig\(saveModelSettings\(cfgMod, getRoute\(\), \{ fastCapable, baseConfig: getConfig\(\) \}\)/);
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
