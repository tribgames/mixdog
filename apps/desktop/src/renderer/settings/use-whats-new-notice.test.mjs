import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node']) {
  globalThis[name] = name === 'window' ? dom.window : dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { useWhatsNewNotice } = await import('./use-whats-new-notice.ts');
const { SEEN_VERSION_KEY } = await import('./whats-new.ts');

test.after(() => dom.window.close());

const release = (version) => ({ version: `v${version}`, date: '2026-10-12', body: '- notes' });
const Dialog = ({ release: shown }) => React.createElement('div', { className: 'notice' }, shown.version);

function Probe({ version, load }) {
  const { notice } = useWhatsNewNotice(version, load);
  return notice ? React.createElement(notice.Dialog, { release: notice.release, onClose() {}, onViewAll() {} }) : null;
}

/** Mounts the notice for `version` with the given stored mark and loader. */
async function mount(t, { version, seen, afterUpdate = true, prepare }) {
  window.localStorage.clear();
  if (seen) window.localStorage.setItem(SEEN_VERSION_KEY, seen);
  const acknowledged = [];
  const diagnostics = [];
  let loads = 0;
  window.mixdogDesktop = {
    bootContext: { bootId: 'b', processStartedAt: 1, ...(afterUpdate ? { afterUpdate: true } : {}) },
    acknowledgeWhatsNew: (acked) => acknowledged.push(acked),
    rendererDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
  const load = async () => {
    loads += 1;
    return { default: Dialog, prepareWhatsNew: prepare };
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(React.createElement(Probe, { version, load })));
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const steps = diagnostics.map((entry) => entry.reason ?? entry.event);
  return { acknowledged, steps, loads: () => loads, container };
}

test('a notice that rendered marks the version seen and acknowledges the update', async (t) => {
  const { acknowledged, steps, container } = await mount(t, {
    version: '4.1.0',
    seen: '4.0.0',
    prepare: async () => release('4.1.0'),
  });
  assert.equal(container.querySelector('.notice')?.textContent, 'v4.1.0');
  assert.deepEqual(acknowledged, ['4.1.0']);
  assert.equal(window.localStorage.getItem(SEEN_VERSION_KEY), '4.1.0');
  assert.deepEqual(steps, ['taken', 'shown']);
});

test('the notice waits behind the starter welcome and is acknowledged only once it is on top', async (t) => {
  const { setStarterGuideBlocking } = await import('../starter-guide-gate.ts');
  setStarterGuideBlocking(true);
  t.after(() => setStarterGuideBlocking(false));
  window.localStorage.clear();
  window.localStorage.setItem(SEEN_VERSION_KEY, '4.9.0');
  const acknowledged = [];
  window.mixdogDesktop = {
    bootContext: { bootId: 'b', processStartedAt: 1, afterUpdate: true },
    acknowledgeWhatsNew: (version) => acknowledged.push(version),
    rendererDiagnostic() {},
  };
  const load = async () => ({ default: Dialog, prepareWhatsNew: async () => release('5.0.0') });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  await act(async () => root.render(React.createElement(Probe, { version: '5.0.0', load })));
  await settle();
  assert.equal(container.querySelector('.notice'), null);
  assert.deepEqual(acknowledged, []);
  assert.equal(window.localStorage.getItem(SEEN_VERSION_KEY), '4.9.0', 'quitting now leaves it unseen');
  await act(async () => setStarterGuideBlocking(false));
  await settle();
  assert.equal(container.querySelector('.notice')?.textContent, 'v5.0.0');
  assert.deepEqual(acknowledged, ['5.0.0']);
  assert.equal(window.localStorage.getItem(SEEN_VERSION_KEY), '5.0.0');
});

test('a version without notes is acknowledged, since retrying could never show any', async (t) => {
  const { acknowledged, steps } = await mount(t, { version: '4.2.0', seen: '4.1.0', prepare: async () => undefined });
  assert.deepEqual(acknowledged, ['4.2.0']);
  assert.equal(window.localStorage.getItem(SEEN_VERSION_KEY), '4.2.0');
  assert.deepEqual(steps, ['taken', 'no-section']);
});

test('a failed preparation is not acknowledged, so the next launch retries', async (t) => {
  const { acknowledged, steps, container } = await mount(t, {
    version: '4.3.0',
    seen: '4.2.0',
    prepare: async () => {
      throw new Error('chunk failed');
    },
  });
  assert.equal(container.querySelector('.notice'), null);
  assert.deepEqual(acknowledged, []);
  assert.equal(window.localStorage.getItem(SEEN_VERSION_KEY), '4.2.0');
  assert.deepEqual(steps, ['taken', 'failed']);
});

test('an already announced version only acknowledges main’s lagging record', async (t) => {
  const current = await mount(t, { version: '4.4.0', seen: '4.4.0', prepare: async () => release('4.4.0') });
  assert.deepEqual(current.acknowledged, ['4.4.0']);
  assert.equal(current.loads(), 0, 'nothing is shown again');
  assert.deepEqual(current.steps, ['current']);
  // 4.1.0 was shown earlier this session; a remount with a stale mark does not repeat it.
  const shown = await mount(t, { version: '4.1.0', seen: '4.0.0', prepare: async () => release('4.1.0') });
  assert.deepEqual(shown.acknowledged, ['4.1.0']);
  assert.equal(shown.loads(), 0);
  assert.deepEqual(shown.steps, ['already-shown']);
});

test('without a pending update from main nothing is acknowledged', async (t) => {
  const { acknowledged, steps } = await mount(t, {
    version: '4.5.0',
    seen: '4.4.0',
    afterUpdate: false,
    prepare: async () => release('4.5.0'),
  });
  assert.deepEqual(acknowledged, []);
  assert.deepEqual(steps, ['taken', 'shown']);
});

test('a downgrade neither shows nor acknowledges anything', async (t) => {
  const { acknowledged, steps, loads } = await mount(t, {
    version: '4.0.5',
    seen: '4.5.0',
    afterUpdate: false,
    prepare: async () => release('4.0.5'),
  });
  assert.deepEqual(acknowledged, []);
  assert.equal(loads(), 0);
  assert.deepEqual(steps, ['downgrade']);
  assert.equal(window.localStorage.getItem(SEEN_VERSION_KEY), '4.5.0');
});
