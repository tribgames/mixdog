import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserTraceExport } from './trace-file.ts';
import { BROWSER_HIT_GUARD } from './hit-target.ts';

test('Chrome trace export preserves timing, masks secrets, counts omissions, and persists valid JSON', async () => {
  const trace = new BrowserTraceExport((text) => text.replaceAll('known-private', '[REDACTED]'), 512);
  trace.add([{ name: 'Task', ts: 10, dur: 20, ph: 'X', args: { cookie: 'opaque', text: 'known-private' } }]);
  trace.add([{ name: 'large', args: { value: 'x'.repeat(1000) } }]);
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-trace-test-'));
  try {
    const saved = trace.save(directory);
    const parsed = JSON.parse(await readFile(saved.path, 'utf8'));
    assert.equal(parsed.traceEvents[0].dur, 20);
    assert.equal(parsed.traceEvents[0].ts, 10);
    assert.equal(parsed.traceEvents[0].args.cookie, '[REDACTED]');
    assert.equal(parsed.traceEvents[0].args.text, '[REDACTED]');
    assert.equal(parsed.metadata.droppedEvents, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('event-time target guard blocks an overlay and cleans up listeners', () => {
  const listeners = new Map();
  const view = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    setTimeout: () => 1, clearTimeout() {}, frameElement: null,
  };
  const element = { isConnected: true, ownerDocument: { defaultView: view } };
  const guard = Function(`return (${BROWSER_HIT_GUARD})`)();
  guard.call(element, 'test', false);
  let blocked = 0;
  listeners.get('pointerdown')({
    isTrusted: true, composedPath: () => [{}],
    preventDefault: () => { blocked++; }, stopImmediatePropagation() {},
  });
  assert.equal(blocked, 1);
  assert.deepEqual(guard.call(element, 'test', true), { blocked: true });
  assert.equal(listeners.size, 0);
});
