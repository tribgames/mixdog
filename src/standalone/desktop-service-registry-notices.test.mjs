import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliverPendingDesktopNotices,
  raiseDesktopNotice,
  registerDesktopNoticeSink,
} from '../runtime/shared/desktop-notice-host.mjs';
import { DesktopServiceRegistry } from './desktop-service-registry.mjs';

const moduleUrl = new URL('./test-fixtures/lifecycle-desktop-service.mjs', import.meta.url).href;

// The desktop service's notice wiring (apps/desktop/src/main/desktop-service.ts):
// its sink reports whether `emit` reached a client, and `clientReady` offers
// what waited.
function noticeAdapter({ emit }) {
  const unregister = registerDesktopNoticeSink(
    (notice) => emit({ kind: 'desktop-event', name: 'desktop-notice', value: notice }) !== false
  );
  return {
    invoke: async () => null,
    control: async () => {},
    clientReady: () => deliverPendingDesktopNotices(),
    dispose: async () => unregister(),
  };
}

test('a notice raised while no desktop client is attached reaches the client that attaches later', async (t) => {
  const frames = [];
  const registry = new DesktopServiceRegistry({
    runtime: { makeAdapter: noticeAdapter },
    onFrame: (frame, targets) =>
      frames.push({ name: frame.message?.name, value: frame.message?.value, to: [...targets] }),
  });
  t.after(() => registry.dispose());
  await registry.init({ desktopId: 'desktop_notice', moduleUrl });

  raiseDesktopNotice('secret-storage', 'secret-storage-failed');
  assert.deepEqual(
    frames.flatMap((frame) => frame.to),
    [],
    'published to nobody: no client is subscribed'
  );

  await registry.init({ desktopId: 'desktop_notice', moduleUrl }, { clientToken: 'window' });
  registry.ready({ desktopId: 'desktop_notice' }, { clientToken: 'window' });
  const delivered = frames.filter((frame) => frame.to.includes('window'));
  assert.deepEqual(delivered, [
    {
      name: 'desktop-notice',
      value: { key: 'secret-storage', code: 'secret-storage-failed', params: {} },
      to: ['window'],
    },
  ]);

  registry.ready({ desktopId: 'desktop_notice' }, { clientToken: 'window' });
  assert.equal(frames.filter((frame) => frame.to.includes('window')).length, 1, 'delivered once, not on every ready');
});
