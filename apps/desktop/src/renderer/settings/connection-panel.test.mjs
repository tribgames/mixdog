import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { getCachedConnectionInfo, setCachedConnectionInfo } from './connection-info.ts';
import { ConnectionPanel } from './connection-panel.tsx';

const readyInfo = (id) => ({
  relayBrowserUrl: `https://relay.example/d/${id}/`,
  relayBrowserQrSvg: `<svg data-device="${id}"></svg>`,
  clients: [],
});

test('a displayed QR and its cache clear on disconnect and return after the automatic retry', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const old = readyInfo('aaaaaaaa');
  const fresh = readyInfo('bbbbbbbb');
  const disconnected = Promise.withResolvers();
  const reconnected = Promise.withResolvers();
  let calls = 0;
  const api = {
    getRemoteAccessInfo() {
      calls += 1;
      if (calls === 1) return disconnected.promise;
      if (calls === 2) return reconnected.promise;
      return Promise.resolve(fresh);
    },
  };
  setCachedConnectionInfo(api, old);

  await act(async () => root.render(React.createElement(ConnectionPanel, { api })));
  assert.ok(document.querySelector('svg[data-device="aaaaaaaa"]'));

  await act(async () => disconnected.resolve(null));
  assert.equal(document.querySelector('.settings-connection-card svg'), null);
  assert.ok(document.querySelector('.settings-connection-card[aria-busy="true"]'));
  assert.equal(getCachedConnectionInfo(api), null);
  assert.equal(calls, 2);

  await act(async () => reconnected.resolve(fresh));
  assert.equal(document.querySelector('svg[data-device="aaaaaaaa"]'), null);
  assert.ok(document.querySelector('svg[data-device="bbbbbbbb"]'));
  assert.deepEqual(getCachedConnectionInfo(api), fresh);
});
