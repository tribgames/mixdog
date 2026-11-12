// A value marked sensitive in a session is redacted in every text that leaves
// it for another session: a worker's report reaches its owner with the
// worker's values as the marker, and a value the worker marks after a report
// carried it leaves the owner's stored files too, up the chain of owners
// (sensitive-values.mjs carrySensitiveValues).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-sensitive-carry-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(async () => {
  (await import('./store.mjs')).drainSessionStore();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const { carrySensitiveValues, onSensitiveValuesCarried, onSensitiveValuesMarked, redactSensitiveText, rememberSensitiveValues, sensitiveValuesVersion } =
  await import('./sensitive-values.mjs');
const { saveSessionAsync } = await import('./store.mjs');
const { redactCarriedSession } = await import('./manager/ask-turn-state.mjs');

const fill = (text) => ({ name: 'browser', arguments: { action: 'fill', input: { text, sensitive: true } } });

test('a carried session takes the values its source holds and gains, on up the chain', (t) => {
  const told = [];
  t.after(onSensitiveValuesCarried((id) => told.push(id)));
  let heard = 0;
  t.after(onSensitiveValuesMarked('c-parent', (version) => (heard = version)));
  assert.equal(rememberSensitiveValues('c-child', [fill('before')]), true);
  carrySensitiveValues('c-child', 'c-parent');
  assert.equal(redactSensitiveText('c-parent', 'before'), '[redacted]', 'what the source held is carried');
  carrySensitiveValues('c-grandchild', 'c-child');
  carrySensitiveValues('c-parent', 'c-child');
  assert.equal(rememberSensitiveValues('c-grandchild', [fill('after')]), true);
  assert.equal(redactSensitiveText('c-grandchild', 'before after'), 'before [redacted]');
  assert.equal(redactSensitiveText('c-child', 'before after'), '[redacted] [redacted]');
  assert.equal(redactSensitiveText('c-parent', 'before after'), '[redacted] [redacted]');
  assert.equal(heard, sensitiveValuesVersion('c-parent'));
  assert.deepEqual(told, ['c-parent', 'c-child', 'c-parent']);
  assert.equal(redactSensitiveText('c-unrelated', 'after'), 'after');
});

test("a value a worker marks after its report leaves the owner's stored files, idle owners up the chain included", async (t) => {
  const CODE = '482913';
  const logPath = (id) => join(dataRoot, 'sessions', `${id}.log.jsonl`);
  const parent = { id: 'carry-parent', messages: [{ role: 'user', content: 'Ask the child.' }, { role: 'tool', toolCallId: 'A', content: `The child reported ${CODE}.` }] };
  const child = { id: 'carry-child', messages: [{ role: 'tool', toolCallId: 'B', content: `The grandchild reported ${CODE}.` }] };
  await saveSessionAsync(parent);
  await saveSessionAsync(child);
  for (const session of [parent, child]) assert.match(readFileSync(logPath(session.id), 'utf8'), new RegExp(CODE));
  // The product's listener (registered by ask-turn-state.mjs), with each rewrite it starts kept to be awaited.
  const rewrites = [];
  onSensitiveValuesCarried((id) => rewrites.push(redactCarriedSession(id)));
  t.after(() => onSensitiveValuesCarried(redactCarriedSession));
  carrySensitiveValues('carry-grandchild', child.id);
  carrySensitiveValues(child.id, parent.id);
  rememberSensitiveValues('carry-grandchild', [fill(CODE)]);
  assert.deepEqual(await Promise.all(rewrites), [true, true]);
  for (const session of [parent, child]) {
    const log = readFileSync(logPath(session.id), 'utf8');
    assert.doesNotMatch(log, new RegExp(CODE), session.id);
    assert.match(log, /reported \[redacted\]/, session.id);
  }
});
