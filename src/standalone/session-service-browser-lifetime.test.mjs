import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionService } from './session-service.mjs';

test('browser teardown follows idle runtime eviction, not view detach or live work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  const frames = [];
  const disposing = [];
  let finishDisposal;
  const disposal = new Promise(resolve => { finishDisposal = resolve; });
  const service = createSessionService({
    idleEvictMs: 100, evictSweepMs: 10,
    createSessionRuntime: async ({ sessionId }) => {
      const state = { sessionId, items: [], queued: [], busy: sessionId === 'busy' };
      return {
        getState: () => state,
        subscribe: () => () => {},
        dispose: async (_reason, options) => {
          disposing.push({ sessionId, options });
          await disposal;
        },
      };
    },
    onFrame(frame, targets) { frames.push({ frame, targets: [...(targets || [])] }); },
  });
  const viewer = { clientToken: 'viewer' };
  try {
    await service.handleCall('desktop.init', {
      desktopId: 'desktop',
      moduleUrl: new URL('./test-fixtures/browser-lifecycle-desktop.mjs', import.meta.url).href,
    }, { clientToken: 'desktop-client' });
    await service.createSession({ sessionId: 'watched' }, viewer);
    await service.createSession({ sessionId: 'alpha' }, viewer);
    await service.createSession({ sessionId: 'beta' }, viewer);
    await service.createSession({ sessionId: 'busy' });
    await service.unsubscribeSession({ sessionId: 'alpha' }, viewer);
    await service.unsubscribeSession({ sessionId: 'beta' }, viewer);
    const releases = () => frames.filter(event => event.frame.message?.name === 'session-runtime-released');
    assert.equal(releases().length, 0, 'leaving a view retains the browser');
    t.mock.timers.tick(150);
    const events = releases();
    assert.deepEqual(events.map(event => event.frame.message.value), [
      { sessionId: 'alpha', restore: true }, { sessionId: 'beta', restore: true },
    ]);
    assert.ok(events.every(event => event.targets.includes('desktop-client')),
      'resource owners receive the event even when the session has no subscribers');
    assert.equal(new Set(events.map(event => event.frame.key)).size, 2,
      'transport coalescing must not lose another session release');
    assert.deepEqual(disposing.map(value => value.sessionId), ['alpha', 'beta']);
    assert.ok(disposing.every(value => value.options.keepBackgroundWork));
    assert.equal(service.size, 2, 'watched and busy runtimes remain alive');
    // The old runtime is still disposing. A replacement must not receive a
    // second, late browser release after it resumes.
    await service.createSession({ sessionId: 'alpha' }, viewer);
    finishDisposal();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(releases().length, 2);
  } finally {
    finishDisposal();
    await service.stop('test complete');
  }
});
