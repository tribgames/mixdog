import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionTransport } from './session-transport.ts';

for (const supported of [false, true]) {
  test(`desktop readiness reflects the attached daemon's view recovery support (${supported})`, async () => {
    const ready = Promise.withResolvers();
    const transport = new SessionTransport('file:///test-only.mjs', 'test-only', async () => ({
      async ensureDaemon() { return {}; },
      async attachSession({ onFrame }) {
        return {
          async call(name) {
            if (name === 'desktop.init') return { desktopId: 'test-view' };
            if (name === 'desktop.control' && supported) onFrame({
              type: 'desktop-event', desktopId: 'test-view', message: { kind: 'view-sync-complete' },
            });
            return {};
          },
          async close() {},
        };
      },
    }));
    transport.on('message', (message) => {
      if (message.kind === 'ready') ready.resolve(message);
    });
    transport.on('exit', (_code, error) => ready.reject(error));
    try {
      transport.postMessage({
        kind: 'init', options: { userDataPath: 'test-only', resourcesPath: 'test-only', appPath: 'test-only', packaged: false },
      });
      assert.equal((await ready.promise).viewSync, supported);
    } finally { await transport.close(); }
  });
}
