import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'Node', 'Element'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { useGithubDeviceCode } = await import('./github-device-code.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FLOW = { flowId: 'flow-1', state: 'code', code: 'ABCD-1234', url: 'https://github.com/login/device' };

async function openGithub(t, { remote, hostOpens }) {
  if (remote) window.mixdogRemoteServer = 'https://host.test';
  t.after(() => {
    delete window.mixdogRemoteServer;
  });
  const opened = [];
  const hostCalls = [];
  const hostOptions = [];
  const host = {
    githubCliLoginOpenBrowser: async (flowId, options) => {
      hostCalls.push(flowId);
      hostOptions.push(options);
      return hostOpens;
    },
  };
  let state;
  function Probe() {
    state = useGithubDeviceCode(host, FLOW, (url) => opened.push(url));
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(React.createElement(Probe)));
  await act(async () => {
    state.openGithub();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { opened, hostCalls, hostOptions };
}

test('a remote client opens the authorization URL itself even when the host opened its browser', async (t) => {
  const { opened, hostCalls } = await openGithub(t, { remote: true, hostOpens: true });
  assert.deepEqual(hostCalls, ['flow-1']);
  assert.deepEqual(opened, [FLOW.url]);
});

test('a remote client asks the host not to open a browser and opens the URL itself', async (t) => {
  const { opened, hostOptions } = await openGithub(t, { remote: true, hostOpens: false });
  assert.deepEqual(hostOptions, [{ openBrowser: false }]);
  assert.deepEqual(opened, [FLOW.url]);
});

test('a local window does not restrict the host browser', async (t) => {
  const { hostOptions } = await openGithub(t, { remote: false, hostOpens: true });
  assert.deepEqual(hostOptions, [undefined]);
});

test('a local window leaves the page to gh when it opened it', async (t) => {
  const { opened } = await openGithub(t, { remote: false, hostOpens: true });
  assert.deepEqual(opened, []);
});

test('a local window opens the page itself when gh did not', async (t) => {
  const { opened } = await openGithub(t, { remote: false, hostOpens: false });
  assert.deepEqual(opened, [FLOW.url]);
});
