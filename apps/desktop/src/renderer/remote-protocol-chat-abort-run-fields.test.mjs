// The fields the live Stop test treats as a run's own are proven by two recordings of Node's side by side: they differ in exactly
// VARYING_FIELDS (so nothing exempted is stable, and nothing stable is exempted).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { VARYING_FIELDS } from './remote-protocol-chat-abort-run-fields.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

test('two recordings of Node differ in exactly the run-own fields', () => {
  const first = read('./remote-protocol-chat-abort.recorded.json');
  const second = read('./remote-protocol-chat-abort.rerecorded.json');
  assert.deepEqual(first.cases.map((c) => c.name), second.cases.map((c) => c.name));
  const differing = new Set();
  const walk = (x, y, key) => {
    if (x && typeof x === 'object' && y && typeof y === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], Array.isArray(x) ? key : k);
    } else if (JSON.stringify(x) !== JSON.stringify(y)) differing.add(key);
  };
  walk(first.cases, second.cases, '');
  assert.deepEqual([...differing].sort(), VARYING_FIELDS);
});
