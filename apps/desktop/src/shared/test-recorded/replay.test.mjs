// Replay must find a call by all of its arguments: a wrong argument (session id, transcript content, a flag, an extra or a missing
// one) is an error for every recorded helper, whatever the helper. Only a value a table names under "normalize" (a measured field, a
// temp-directory path) may differ, and then only in the part the rule replaces.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { callKey, normalizeArgs, replay } from './replay.mjs';

const tables = readdirSync(new URL('.', import.meta.url))
  .filter((name) => name.endsWith('.recorded.json'))
  .map((name) => [name, JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'))]);

/** Every way to change one leaf of `value`. */
function* mutations(value, path = []) {
  const at = (changed) => {
    if (!path.length) return changed;
    const copy = structuredClone(value);
    return copy;
  };
  void at;
  if (typeof value === 'string') yield [path, `${value}~wrong`];
  else if (typeof value === 'number') yield [path, value + 1];
  else if (typeof value === 'boolean') yield [path, !value];
  else if (value === null) yield [path, 'wrong'];
  else if (Array.isArray(value)) for (const [i, child] of value.entries()) yield* mutations(child, [...path, i]);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) yield* mutations(child, [...path, key]);
}

function withLeaf(root, path, leaf) {
  const copy = structuredClone(root);
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key];
  node[path.at(-1)] = leaf;
  return copy;
}

const thrown = (call) => {
  try {
    const result = call();
    if (result && typeof result.then === 'function') return result.then(() => false, (error) => /was not recorded/.test(error.message));
    return false;
  } catch (error) {
    return /was not recorded/.test(error.message);
  }
};

test('a recorded call replays with its own arguments, and any other argument is refused', async () => {
  let refused = 0;
  let normalizedAway = 0;
  for (const [file, table] of tables) {
    for (const key of Object.keys(table.calls)) {
      const name = key.slice(0, key.indexOf('\0'));
      if (table.stubs?.[name]) continue; // a setup helper that does nothing here; nothing is replayed from it
      const args = JSON.parse(key.slice(key.indexOf('\0') + 1));
      const fn = replay(table, name);
      assert.equal(await thrown(() => fn(...args)), false, `${file}: ${name} refuses its own recorded arguments`);
      // An extra and a missing argument.
      // (An argument list that is itself another recorded call of the function is that call.)
      const recorded = (list) => table.calls[callKey(table, name, list)];
      if (!recorded([...args, 'extra'])) {
        assert.equal(await thrown(() => replay(table, name)(...args, 'extra')), true, `${file}: ${name} accepted an extra argument`);
      }
      if (args.length && !recorded(args.slice(0, -1))) {
        assert.equal(await thrown(() => replay(table, name)(...args.slice(0, -1))), true, `${file}: ${name} accepted a missing argument`);
      }
      for (const [path, leaf] of mutations(args)) {
        const wrong = withLeaf(args, path, leaf);
        if (callKey(table, name, wrong) === callKey(table, name, args)) {
          normalizedAway += 1;
          continue;
        }
        // A change that lands on another recorded call of the same function is that call.
        if (table.calls[callKey(table, name, wrong)]) continue;
        assert.equal(await thrown(() => replay(table, name)(...wrong)), true, `${file}: ${name} accepted a wrong argument at ${path.join('.')}`);
        refused += 1;
      }
    }
  }
  assert.ok(refused > 1000, `only ${refused} wrong arguments were tried`);
  assert.ok(normalizedAway > 0, 'the normalization rules never applied');
});

test('only the parts a rule names are ignored: a wrong session id or transcript content still fails', async () => {
  const find = (file) => tables.find(([name]) => name === file)[1];
  const preview = find('turn-preview-worker.test.0.recorded.json');
  const begin = replay(preview, 'beginAgentTurnReview');
  assert.throws(() => begin('wrong-session', 'desk-lead-worker', { agent: 'worker' }), /was not recorded/);
  assert.throws(() => begin('desk-lead', 'wrong-worker', { agent: 'worker' }), /was not recorded/);
  // The temp-directory prefix differs per run and is ignored; the rest of the path is not.
  const snapshot = replay(preview, 'beginTurnSnapshot');
  const [snapshotKey] = Object.keys(preview.calls).filter((key) => key.startsWith('beginTurnSnapshot'));
  const [root, ...rest] = JSON.parse(snapshotKey.slice(snapshotKey.indexOf('\0') + 1));
  assert.equal(root, '<temp-dir>');
  assert.doesNotThrow(() => snapshot('C:\\any\\run\\mixdog-preview-worker-AbCdEf', ...rest));
  assert.throws(() => snapshot('C:\\any\\run\\other-dir-AbCdEf', ...rest), /was not recorded/);
  const quota = replay(find('quota-continue.test.0.recorded.json'), 'transcriptTurnKeys');
  const [quotaKey] = Object.keys(find('quota-continue.test.0.recorded.json').calls).filter((key) => key.startsWith('transcriptTurnKeys'));
  const [items] = JSON.parse(quotaKey.slice(quotaKey.indexOf('\0') + 1));
  assert.throws(() => quota(items.map((item) => (item.kind === 'user' ? { ...item, text: `${item.text}!` } : item))), /was not recorded/);
  assert.equal(normalizeArgs({ timings_ms: 5, other: 1 }, [{ field: 'timings_ms' }]).other, 1);
});
