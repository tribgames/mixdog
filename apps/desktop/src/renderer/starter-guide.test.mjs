import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
  pretendToBeVisual: true,
});
for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'MutationObserver', 'CustomEvent']) {
  globalThis[name] = name === 'window' ? dom.window : dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { StarterGuide } = await import('./StarterGuide.tsx');
const { resetSidebarReferenceCache } = await import('./sidebar-reference-cache.ts');
const { inertBackground } = await import('./settings/dialog-modality.ts');
const { tourCardPosition } = await import('./StarterTour.tsx');
const { setCachedConnectionInfo } = await import('./settings/connection-info.ts');

test.after(() => dom.window.close());

async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(t, { connected = false, projects = [], clearStorage = true, onboardingActive = false } = {}) {
  if (clearStorage) window.localStorage.clear();
  resetSidebarReferenceCache();
  window.mixdogDesktop = {
    invokeCapability: async ({ capability }) => ({
      value: capability === 'getProviderSetup' ? { api: [], oauth: [{ id: 'openai', authenticated: connected }] } : {},
    }),
    listProjects: async () => projects,
  };
  const opened = { views: [], settings: [], settingsClosed: 0 };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(StarterGuide, {
          descriptors: new Map(),
          onboardingActive,
          onOpenView: (id) => opened.views.push(id),
          onOpenSettings: (section) => opened.settings.push(section),
          onCloseSettings: () => {
            opened.settingsClosed += 1;
          },
        })
      )
    );
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render();
  await settle();
  return { opened, render };
}

const pill = () => document.querySelector('.starter-guide-toggle');
const steps = () => [...document.querySelectorAll('.starter-guide-step')];
const tourCount = () => document.querySelector('.starter-tour-card .starter-tour-count')?.textContent;

function button(text) {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent.trim() === text);
  assert.ok(found, `Missing button: ${text}`);
  return found;
}

async function click(element) {
  await act(async () => element.click());
}

test('a paired device completes remote access once: emptied connection info does not re-announce it', async (t) => {
  const { render } = await mount(t);
  const api = window.mixdogDesktop;
  const toasts = () => document.querySelectorAll('.starter-guide-toast').length;
  setCachedConnectionInfo(api, { clients: [{ id: 'c1' }] });
  await render();
  await settle();
  assert.deepEqual(JSON.parse(window.localStorage.getItem('mixdog.desktop.starter-guide.v1')).visited, ['remote']);
  // The relay reconnects / access is switched off: the cache empties and refills.
  setCachedConnectionInfo(api, null);
  await render();
  await settle();
  assert.match(pill().textContent, /1\/5/, 'still done while the cache is empty');
  const before = toasts();
  setCachedConnectionInfo(api, { clients: [{ id: 'c1' }] });
  await render();
  await settle();
  assert.equal(toasts(), before, 'no second "Done" notice');
});

test('the guide counts real provider and project state and lists the steps in guided order', async (t) => {
  await mount(t, { connected: true, projects: [{ path: 'C:/work', name: 'work' }] });
  assert.match(pill().textContent, /2\/5/);
  await click(pill());
  assert.deepEqual(
    steps().map((step) => step.querySelector('b').textContent),
    ['Connect a provider', 'Add a project', 'Set up workflows and agents', 'Set up remote access', 'Explore extensions']
  );
  assert.deepEqual(
    steps().map((step) => step.dataset.done === 'true'),
    [true, true, false, false, false]
  );
  // Only the next open step carries its explanation.
  assert.deepEqual(
    steps().map((step) => Boolean(step.querySelector('small'))),
    [false, false, true, false, false]
  );
});

test('each step opens its destination and runs its own tour', async (t) => {
  const { opened } = await mount(t);
  await click(button('Maybe later'));
  assert.match(pill().textContent, /0\/5/);
  // Choosing a step folds the checklist and starts its tour.
  for (let index = 0; index < 5; index += 1) {
    if (!steps().length) await click(pill());
    await click(steps()[index]);
    assert.equal(steps().length, 0);
    assert.ok(document.querySelector('.starter-tour-card'));
  }
  assert.deepEqual(opened.settings, ['providers', 'connection']);
  assert.deepEqual(opened.views, ['projects', 'workflows', 'extensions']);
  // Opening a screen is not completing it.
  assert.match(pill().textContent, /0\/5/);
});

test('finishing a tour completes its step and says so', async (t) => {
  await mount(t);
  await click(button('Maybe later'));
  await click(pill());
  await click(steps()[2]);
  assert.equal(tourCount(), '1/4');
  await click(button('Next'));
  await click(button('Next'));
  await click(button('Next'));
  await click(button('Done'));
  assert.match(pill().textContent, /1\/5/);
  assert.match(document.querySelector('.starter-guide-toast').textContent, /Set up workflows and agents/);
});

test('clicking a live control completes the stop and hands the screen over', async (t) => {
  const { opened } = await mount(t, { connected: true });
  const add = document.createElement('button');
  add.className = 'composer-project-context';
  add.getBoundingClientRect = () => ({ top: 40, left: 260, width: 120, height: 28, right: 380, bottom: 68 });
  document.body.append(add);
  t.after(() => add.remove());
  await click(button('Start the tour'));
  await click(button('Next'));
  await click(button('Next'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.ok(document.querySelector('.starter-tour-hole[data-live="true"]'));
  assert.ok(document.querySelector('.starter-tour-try'));
  await click(add);
  await settle();
  assert.equal(document.querySelector('.starter-tour-card'), null);
  // The chain stops inside what the control opened.
  assert.deepEqual(opened.views, ['projects']);
});

async function projectAddStop(t) {
  await mount(t, { connected: true });
  const add = document.createElement('button');
  add.className = 'session-panel-action projects-add';
  add.getBoundingClientRect = () => ({ top: 40, left: 260, width: 28, height: 28, right: 288, bottom: 68 });
  document.body.append(add);
  t.after(() => add.remove());
  await click(button('Start the tour'));
  await click(button('Next'));
  assert.equal(tourCount(), '2/3');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.ok(document.querySelector('.starter-tour-hole[data-live="true"]'));
  return add;
}

test('the add-project stop steps aside for its form and carries on once it closes, added or not', async (t) => {
  const add = await projectAddStop(t);
  const form = document.createElement('div');
  form.className = 'projects-add-dialog';
  add.addEventListener('click', () => document.body.append(form));
  await click(add);
  await settle();
  assert.equal(document.querySelector('.starter-tour-card'), null);
  // Escape belongs to the open form, not the tour standing aside.
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.equal(document.querySelector('.starter-tour-card'), null);
  // Cancelled without adding a folder: the tour still moves on, and
  // finishing it completes the step — a project is optional.
  form.remove();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.equal(tourCount(), '3/3');
  await click(button('Done'));
  assert.match(pill().textContent, /2\/5/);
});

test('an add-project form that never opens does not strand the tour', async (t) => {
  const add = await projectAddStop(t);
  await click(add);
  await settle();
  assert.equal(document.querySelector('.starter-tour-card'), null);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2700)));
  assert.equal(tourCount(), '3/3');
});

test('a stop whose control never appears is skipped instead of dimming an empty screen', async (t) => {
  await mount(t);
  await click(button('Maybe later'));
  await click(pill());
  await click(steps()[2]);
  assert.equal(tourCount(), '1/4');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2700)));
  assert.equal(tourCount(), '2/4');
});

test('the card sits beside the spotlight with its arrow on the target middle', () => {
  const view = { width: 1000, height: 700 };
  const card = { width: 320, height: 160 };
  const right = tourCardPosition({ top: 100, left: 60, width: 200, height: 40 }, card, view);
  assert.equal(right.side, 'right');
  assert.equal(right.left, 60 + 200 + 14);
  assert.equal(right.top + right.arrow, 120);
  const above = tourCardPosition({ top: 600, left: 0, width: 1000, height: 60 }, card, view);
  assert.equal(above.side, 'above');
  // A composer-row control keeps its neighbours visible: the card rises
  // above it even though there is room to its right.
  const composer = tourCardPosition({ top: 550, left: 320, width: 150, height: 34 }, card, view);
  assert.equal(composer.side, 'above');
  assert.ok(composer.top + card.height <= 550);
  assert.equal(tourCardPosition(null, card, view).side, 'center');
  // No room on any side: docked to the bottom edge, not over the middle.
  const docked = tourCardPosition({ top: 20, left: 20, width: 960, height: 660 }, card, view);
  assert.equal(docked.top, 700 - 160 - 12);
});

test('the welcome card waits for onboarding, then starts the tour on the first open step', async (t) => {
  await mount(t, { onboardingActive: true });
  assert.equal(document.querySelector('.starter-welcome'), null);
  const { opened } = await mount(t, { clearStorage: false });
  assert.ok(document.querySelector('.starter-welcome'));
  await click(button('Start the tour'));
  assert.equal(document.querySelector('.starter-welcome'), null);
  assert.deepEqual(opened.settings, ['providers']);
  assert.equal(tourCount(), '1/2');
  assert.equal(JSON.parse(window.localStorage.getItem('mixdog.desktop.starter-guide.v1')).welcomed, true);
  // Settings opens in the same commit and inerts the page behind it; the
  // tour that points into Settings must stay clickable.
  const restore = inertBackground(() => true);
  assert.notEqual(document.querySelector('.starter-tour').inert, true);
  restore();
});

test('postponing the welcome keeps the pill for later', async (t) => {
  await mount(t);
  await click(button('Maybe later'));
  assert.equal(document.querySelector('.starter-welcome'), null);
  assert.ok(pill());
});

test('a chained tour walks each stop, then moves on to the next open step', async (t) => {
  const { opened } = await mount(t, { connected: true });
  await click(button('Start the tour'));
  assert.deepEqual(opened.views, ['projects']);
  assert.equal(opened.settingsClosed, 1);
  assert.equal(tourCount(), '1/3');
  await click(button('Next'));
  assert.equal(tourCount(), '2/3');
  await click(button('Next'));
  assert.equal(tourCount(), '3/3');
  await click(button('Done'));
  assert.deepEqual(opened.views, ['projects', 'workflows']);
  assert.equal(tourCount(), '1/4');
  await click(button('Skip'));
  assert.equal(document.querySelector('.starter-tour-card'), null);
  assert.deepEqual(opened.views, ['projects', 'workflows']);
});

test('X asks once before closing, and closing retires the guide across launches', async (t) => {
  await mount(t);
  await click(document.querySelector('.starter-guide-close'));
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /Close the getting started guide\?/);
  // Cancelling keeps the guide.
  await click(button('Cancel'));
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.ok(document.querySelector('.starter-guide'));
  await click(document.querySelector('.starter-guide-close'));
  await click(button('Close'));
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.equal(document.querySelector('.starter-guide'), null);
  await mount(t, { clearStorage: false });
  assert.equal(document.querySelector('.starter-guide'), null);
});

test('finishing every step retires the guide even if a provider is disconnected later', async (t) => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'mixdog.desktop.starter-guide.v1',
    JSON.stringify({ closed: false, visited: ['workflow', 'extensions', 'remote'] })
  );
  await mount(t, { connected: true, projects: [{ path: 'C:/work', name: 'work' }], clearStorage: false });
  assert.equal(document.querySelector('.starter-guide'), null);
  await mount(t, { connected: false, clearStorage: false });
  assert.equal(document.querySelector('.starter-guide'), null);
});
