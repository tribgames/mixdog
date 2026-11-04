// Settings → System → Network proxy: the row states of the approved mockup
// (design/mockups/proxy-settings/clean.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView ??= () => {};

const DEFAULT_EXCEPTIONS = 'localhost, 127.0.0.1, ::1';
const route = (over = {}) => ({
  via: 'direct',
  proxy: null,
  envVar: null,
  ignored: { system: false, env: [] },
  noProxyAll: false,
  platform: 'windows',
  error: null,
  ...over,
});
let host;
let calls;
let nextCheck;
function reset(settings) {
  host = { mode: 'system', url: '', exceptions: DEFAULT_EXCEPTIONS, origin: 'https://api.openai.com', route: route(), ...settings };
  calls = [];
  nextCheck = { ok: true, ms: 182, origin: 'https://api.openai.com', status: 401, route: route() };
}
reset({});
window.mixdogDesktop = {
  invokeCapability: async ({ capability, args }) => {
    calls.push([capability, args]);
    if (capability === 'getNetworkProxy') return { value: structuredClone(host) };
    if (capability === 'testNetworkProxy') return { value: nextCheck };
    // The runtime refuses an address without a scheme and stores nothing.
    const patch = args[0];
    if (patch.url !== undefined && !/^https?:\/\/[^\s]+$/.test(patch.url)) {
      throw new Error('Error invoking remote method \'invokeCapability\': Error: networkProxy.url is not a proxy address.');
    }
    host = { ...host, ...patch, route: patch.mode === 'manual' ? route({ via: 'manual', proxy: 'proxy.company.com:8080' }) : host.route };
    return { value: structuredClone(host) };
  },
};
const { createRoot } = await import('react-dom/client');
const { NetworkProxyGroup, routeDescription } = await import('./network-proxy-settings.tsx');

const settle = () => act(() => new Promise((resolve) => setImmediate(resolve)));
const select = () => document.querySelector('.network-proxy-select');
const row = (title) => [...document.querySelectorAll('.network-proxy-row')].find((el) => el.querySelector('.mixdog-settings__row-title')?.textContent === title);
const desc = (title) => row(title)?.querySelector('.mixdog-settings__row-desc')?.textContent ?? '';
const input = (title) => row(title)?.querySelector('input');
const type = (el, text) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, text);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const blur = (el) =>
  act(async () => {
    el.focus();
    el.blur();
  });
const choose = (value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select(), value);
    select().dispatchEvent(new window.Event('change', { bubbles: true }));
  });

async function mounted(fn) {
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(NetworkProxyGroup, { active: true })));
    await settle();
    await fn();
  } finally {
    await act(async () => root.unmount());
  }
}

test('system mode shows one proxy row naming the route in effect, with the three choices', async () => {
  reset({ route: route({ via: 'system', proxy: 'proxy.corp.local:8080' }) });
  await mounted(async () => {
    assert.equal(select().value, 'system');
    assert.deepEqual([...select().options].map((option) => option.value), ['system', 'manual', 'off']);
    assert.match(desc('Proxy'), /Windows proxy proxy\.corp\.local:8080/);
    assert.equal(row('Proxy address'), undefined, 'the manual rows stay hidden');
    assert.equal(row('Exceptions'), undefined);
    assert.ok(row('Check connection'));
  });
});

test('manual mode shows the address and exception rows; a bad address is refused in its row and not saved', async () => {
  reset({});
  await mounted(async () => {
    await choose('manual');
    assert.equal(calls.filter(([name]) => name === 'setNetworkProxy').length, 0, 'no address yet: nothing is saved');
    assert.equal(input('Exceptions').value, DEFAULT_EXCEPTIONS, 'the exception field starts prefilled');
    assert.match(desc('Proxy address'), /http, https or socks5/);

    await type(input('Proxy address'), 'proxy.company.com 8080');
    await blur(input('Proxy address'));
    await settle();
    assert.equal(input('Proxy address').getAttribute('aria-invalid'), 'true');
    assert.match(desc('Proxy address'), /address is not valid\. Example: http:\/\/proxy\.company\.com:8080/);
    assert.equal(host.url, '', 'the runtime stored nothing');

    await type(input('Proxy address'), 'http://proxy.company.com:8080');
    await blur(input('Proxy address'));
    await settle();
    assert.equal(input('Proxy address').getAttribute('aria-invalid'), null);
    assert.deepEqual(calls.at(-1), ['setNetworkProxy', [{ mode: 'manual', url: 'http://proxy.company.com:8080' }]]);
    assert.match(desc('Proxy'), /only through the proxy below/);

    await type(input('Exceptions'), 'localhost, *.company.local');
    await blur(input('Exceptions'));
    await settle();
    assert.deepEqual(calls.at(-1), ['setNetworkProxy', [{ exceptions: 'localhost, *.company.local' }]]);
  });
});

test('off names what it ignores, and leaving manual hides its rows', async () => {
  reset({ mode: 'manual', url: 'http://proxy.company.com:8080', route: route({ via: 'manual', proxy: 'proxy.company.com:8080' }) });
  await mounted(async () => {
    assert.ok(input('Proxy address'));
    host.route = route({ via: 'off', ignored: { system: true, env: ['HTTPS_PROXY'] } });
    await choose('off');
    await settle();
    assert.deepEqual(calls.at(-1), ['setNetworkProxy', [{ mode: 'off' }]]);
    assert.match(desc('Proxy'), /Connecting directly, without a proxy\. Ignoring Windows proxy and HTTPS_PROXY\./);
    assert.equal(row('Proxy address'), undefined);
  });
});

test('routeDescription covers a proxy variable, NO_PROXY=*, and no proxy at all', () => {
  assert.match(routeDescription('system', route({ via: 'env', proxy: 'p:1', envVar: 'ALL_PROXY' })), /p:1.*ALL_PROXY/);
  assert.match(routeDescription('system', route({ noProxyAll: true })), /NO_PROXY.*\*/);
  assert.match(routeDescription('system', route()), /No system proxy or proxy variable/);
  assert.match(routeDescription('manual', route({ error: 'no-address' })), /Enter a proxy address/);
});

test('the connection check shows its result and latency in the row, and a failure offers another try', async () => {
  reset({ route: route({ via: 'system', proxy: 'proxy.corp.local:8080' }) });
  await mounted(async () => {
    assert.match(desc('Check connection'), /Tries to connect to api\.openai\.com/);
    const button = row('Check connection').querySelector('button');
    nextCheck = { ok: true, ms: 182, origin: 'https://api.openai.com', status: 401, route: route({ via: 'system', proxy: 'proxy.corp.local:8080' }) };
    await act(async () => button.click());
    await settle();
    assert.match(desc('Check connection'), /Connected\. It took 182ms to reach api\.openai\.com through the proxy\./);

    nextCheck = { ok: false, ms: 9, origin: 'https://api.openai.com', code: 'ECONNREFUSED', route: route({ via: 'manual', proxy: 'proxy.corp.local:8080' }) };
    await act(async () => button.click());
    await settle();
    assert.match(desc('Check connection'), /Could not connect\. The proxy proxy\.corp\.local:8080 is not responding\./);
    assert.equal(button.textContent, 'Check again');
    assert.deepEqual(calls.at(-1), ['testNetworkProxy', []]);
  });
});
