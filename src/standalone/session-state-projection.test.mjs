import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { projectSessionState } from './session-state-projection.mjs';
import { applySessionStatePatch, diffSessionState } from './session-state-patch.mjs';

test('a long unfinished line crosses the daemon hop in bytes linear in its length', () => {
  const entry = {};
  const base = { sessionId: 'stream', items: [], streamingTail: { id: 'a1', kind: 'assistant', text: 'head\n' } };
  let previous = projectSessionState(entry, { ...base, streamingPartial: { id: 'a1', from: 5, text: 'x' } });
  let held = previous;
  let bytes = 0;
  let text = 'x';
  for (let step = 0; step < 1_000; step += 1) {
    text += 'y'.repeat(100);
    const next = projectSessionState(entry, { ...base, streamingPartial: { id: 'a1', from: 5, text } });
    const patch = diffSessionState(previous, next);
    assert.equal(Object.hasOwn(patch.set, 'streamingPartial'), false);
    bytes += JSON.stringify(patch).length;
    held = applySessionStatePatch(held, patch);
    previous = next;
  }
  assert.equal(held.streamingPartial.text, text);
  // ~100 KB of text: a whole-line resend would be ~50 MB.
  assert.ok(bytes < 2 * text.length, `${bytes} bytes for a ${text.length}-char line`);
  // A retraction, another row or a new line offset replaces the partial whole.
  for (const replacement of [
    { id: 'a1', from: 5, text: text.slice(0, 10) },
    { id: 'a2', from: 5, text: `${text}z` },
    { id: 'a1', from: 9, text: `${text}z` },
  ]) {
    const next = projectSessionState(entry, { ...base, streamingPartial: replacement });
    const patch = diffSessionState(previous, next);
    assert.equal(patch.partialAppend, undefined);
    assert.deepEqual(applySessionStatePatch(held, patch).streamingPartial, replacement);
  }
});

test('a partial append with no held line is rejected instead of dropping its text', () => {
  const baseline = { sessionId: 'stream', items: [], streamingTail: { id: 'a1', kind: 'assistant', text: 'head\n' } };
  assert.equal(applySessionStatePatch(baseline, { set: {}, remove: [], partialAppend: { text: 'tail' } }), null);
  assert.equal(
    applySessionStatePatch({ ...baseline, streamingPartial: null }, { set: {}, partialAppend: { text: 'tail' } }),
    null
  );
});

test('tail-only updates do not resend the settled history or queued prompts', () => {
  const entry = {};
  const source = {
    sessionId: 'stream',
    items: Array.from({ length: 2_000 }, (_, id) => ({ id, text: `row ${id}` })),
    queued: [{ id: 'next', text: 'x'.repeat(8_000), submittedAt: 1 }],
    streamingTail: { id: 'tail', text: 'first' },
  };
  const previous = projectSessionState(entry, source);
  const next = projectSessionState(entry, {
    ...source,
    streamingTail: { id: 'tail', text: 'second' },
  });
  const patch = diffSessionState(previous, next);
  assert.deepEqual(patch, {
    set: { streamingTail: { id: 'tail', text: 'second' } },
    remove: [],
    itemsAppend: null,
  });
  assert.deepEqual(applySessionStatePatch(previous, patch), next);
});

test('history edits, queue edits and removed fields still reconstruct the complete state', () => {
  const entry = {};
  const first = { id: 1, text: 'one' };
  const second = { id: 2, text: 'two' };
  const sources = [
    { items: [first], queued: [{ text: 'next' }], extra: { text: 'temporary' } },
    { items: [first, second], queued: [{ displayText: 'replaced' }] },
    { items: [{ ...first, text: 'edited' }], queued: [] },
    { items: null, queued: undefined },
    { items: [second], queued: [{ text: 'restored' }] },
  ];
  let previous = null;
  for (const source of sources) {
    const next = projectSessionState(entry, source);
    // A fresh projection is the same public result as the incremental one.
    assert.deepEqual(next, projectSessionState({}, source));
    if (previous) {
      assert.deepEqual(applySessionStatePatch(previous, diffSessionState(previous, next)), next);
    }
    previous = next;
  }
});

test('removed or unrepresentable fields release source and wire objects', {
  skip: typeof globalThis.gc !== 'function',
}, async () => {
  for (const next of [{ busy: false }, { items: null, extra: undefined }, null]) {
    const entry = {};
    const refs = (() => {
      const source = { items: [{ text: 'removed row' }], extra: { text: 'temporary' } };
      const wire = projectSessionState(entry, source);
      return [source.items[0], source.extra, wire.items[0], wire.extra].map((value) => new WeakRef(value));
    })();
    projectSessionState(entry, next);
    for (let round = 0; round < 3; round += 1) {
      await setImmediate();
      globalThis.gc();
    }
    assert.ok(
      refs.every((ref) => ref.deref() === undefined),
      'removed transcript/field objects must be collectable while the entry stays alive'
    );
    // Keep the owner alive across collection; this is not just entry teardown.
    assert.deepEqual(projectSessionState(entry, next), projectSessionState({}, next));
  }
});
