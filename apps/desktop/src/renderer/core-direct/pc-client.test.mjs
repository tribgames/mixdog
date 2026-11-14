// pcCoreClient: the primary client in a main window, the client on slot pc in a server window, null before it is open.
import assert from 'node:assert/strict';
import test from 'node:test';

import { forgetDirectClient, openDirectClient, pcCoreClient } from './client.ts';

/** A bridge and a host whose ports answer initialize with the window `windowOf(slot)` names. */
function world(windowOf) {
  const listeners = [];
  const host = { addEventListener: (_t, l) => listeners.push(l) };
  const infos = [];
  let next = 1;
  const bridge = {
    async open({ slot }) {
      const generation = next++;
      const port = {
        onmessage: null,
        close() {},
        postMessage(text) {
          if (typeof text !== 'string') return;
          const msg = JSON.parse(text);
          if (msg.method !== 'initialize') return;
          infos.push({ slot, info: msg.params.clientInfo, capabilities: msg.params.capabilities });
          const connection = { origin: 'app', device: 'd', window: windowOf(slot) };
          const result = { serverInstanceId: 's', coreState: 'ready', limits: {}, capabilities: {}, connection };
          queueMicrotask(() => port.onmessage({ data: JSON.stringify({ id: msg.id, result }) }));
        },
      };
      queueMicrotask(() => listeners.forEach((l) => l({ source: host, data: { type: 'mixdog-core-port', generation, slot }, ports: [port] })));
      return { generation };
    },
  };
  return { bridge, infos, host };
}
const reset = () => {
  delete globalThis.window;
  forgetDirectClient('primary');
  forgetDirectClient('pc');
};

test('pc_client_main_window_is_primary', async (t) => {
  const w = world(() => ({ role: 'main' }));
  globalThis.window = w.host;
  t.after(reset);
  assert.equal(pcCoreClient(), null);
  const client = await openDirectClient({ bridge: w.bridge, version: '1.2.3' });
  assert.equal(pcCoreClient(), client);
  assert.deepEqual(w.infos[0].info, { name: 'mixdog-desktop-window', title: 'Mixdog Desktop', version: '1.2.3', kind: 'desktop' });
  assert.deepEqual(w.infos[0].capabilities, { approvalsInbox: true });
  await client.close();
});

test('pc_client_server_window_uses_pc_slot', async (t) => {
  const w = world((slot) => ({ role: slot === 'pc' ? 'main' : 'server:s1' }));
  globalThis.window = w.host;
  t.after(reset);
  const primary = await openDirectClient({ bridge: w.bridge, version: '1' });
  assert.equal(pcCoreClient(), null, 'a server window has no PC client until slot pc is open');
  const pc = await openDirectClient({ bridge: w.bridge, version: '1', slot: 'pc' });
  assert.equal(pcCoreClient(), pc);
  assert.notEqual(pc, primary);
  assert.deepEqual(w.infos.map((i) => i.slot), ['primary', 'pc']);
  await primary.close();
  await pc.close();
});
