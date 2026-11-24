// The page's lifecycle link while the first connection is still being dialed (phone-boot.ts `link`): the post-approval recovery
// (remote-shim-pairing.ts `verifyApprovedConnection`, `ctx.phone.recycle()`) wakes the dial through it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateRelayE2EEServerIdentity, relayE2EEPairingMaterial } from '../../desktop/src/shared/remote-e2ee.ts';
import type { RemoteShimContext } from '../../desktop/src/renderer/remote-shim-state.ts';
import type { RelaySocket } from './relay-connector.ts';

const page = globalThis as unknown as Record<string, unknown>;
page.window ??= {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
  Event: class {
    constructor(readonly type: string) {}
  },
};
page.document ??= {
  visibilityState: 'visible',
  addEventListener() {},
  documentElement: { dataset: {} },
  getElementById: () => null,
};

/** A socket the relay refuses at once (the PC is offline): its dial ends before ready. */
const refusedSocket = (): RelaySocket => {
  const ws: RelaySocket = {
    binaryType: '',
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
  queueMicrotask(() => ws.onclose!({ code: 4002, reason: 'offline' }));
  return ws;
};

test('before the first connection the boot hands out the link being dialed, and its wake cuts the redial wait', async () => {
  const { bootPhone } = await import('./phone-boot.ts');
  const identity = await generateRelayE2EEServerIdentity();
  let dials = 0;
  const dialed: Array<{ n: number; resolve(): void }> = [];
  const dial = (n: number) => new Promise<void>((resolve) => (dials >= n ? resolve() : dialed.push({ n, resolve })));
  const ctx = {
    deviceId: 'dev',
    e2eePairing: relayE2EEPairingMaterial(identity),
    backgroundSuspended: false,
    mediaSid: null,
    limits: { resetLearnedCaps() {} },
    waitForCredential: async () => undefined,
    ensureClientRegistration: async () => undefined,
    wsUrl: () => 'wss://relay.invalid/d/dev',
  } as unknown as RemoteShimContext;
  const boot = bootPhone(ctx, {
    version: '1.0.0',
    createSocket: () => {
      dials += 1;
      for (const waiter of dialed.filter((w) => w.n <= dials)) {
        dialed.splice(dialed.indexOf(waiter), 1);
        waiter.resolve();
      }
      return refusedSocket();
    },
    suspendApplies: () => false,
    visualizePanels: () => [],
    random: () => 0.5,
    updateRequired() {},
  });
  void boot.start().catch(() => undefined);
  try {
    // The first redial of an outage leaves at once; the one after it waits out a backoff of hundreds of ms.
    await dial(2);
    assert.ok(boot.link, 'the link of the dial in progress');
    boot.link.wake();
    await dial(3);
  } finally {
    boot.resetPairing();
  }
});
