import assert from 'node:assert/strict';
import test from 'node:test';

import { generateRelayE2EEServerIdentity, relayE2EEPairingMaterial } from '../../shared/remote-e2ee.ts';
import {
  REMOTE_BROWSER_FIT_CAPABILITY,
  REMOTE_WEBRTC_CAPABILITY,
  REMOTE_WEBRTC_VERSION,
} from '../../shared/remote-webrtc.ts';
import { createRelayClientLifecycle } from '../remote-relay-client-lifecycle.ts';
import { createRelayClientRegistry } from '../remote-relay-clients.ts';

test('the host advertises the WebRTC live view and the take-over fit in its encryption challenge', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const envelopes = [];
  const clients = createRelayClientRegistry({
    host: { setVisibleSessionsForSource: async () => true },
    sendEnvelope: (payload) => envelopes.push(payload),
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => {},
    onEmpty: () => {},
  });
  const lifecycle = createRelayClientLifecycle({
    clients,
    e2eeIdentity: identity,
    pairing: relayE2EEPairingMaterial(identity),
    relayBinaryFrames: () => false,
    viewSyncSupported: () => false,
    relayRoutingCapsPayload: () => ({}),
    sendEnvelope: (payload) => envelopes.push(payload),
    sendEncryptedFrame: async () => {},
    dispatchClientCall: async () => ({}),
    resyncClient: () => {},
  });
  lifecycle.open('client-1', 'phone-credential');
  const challenge = JSON.parse(envelopes.find((entry) => entry.type === 'frame').data);
  assert.equal(challenge.type, 'e2ee-challenge');
  assert.equal(REMOTE_WEBRTC_CAPABILITY, 'browserWebrtc');
  assert.equal(REMOTE_BROWSER_FIT_CAPABILITY, 'browserFit');
  assert.equal(challenge.browserWebrtc, REMOTE_WEBRTC_VERSION);
  assert.equal(challenge.browserFit, 1);
  clients.clear();
});
