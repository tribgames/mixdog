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
const { openModal } = await import('./settings/dialog-modality.ts');
const { tourCardPosition } = await import('./StarterTour.tsx');
const { setCachedConnectionInfo } = await import('./settings/connection-info.ts');
const { holdMixyDialogOpen, onMixyDialogRequest, publishMixyStatus, resetMixyStatus } = await import(
  './mixy-identity.ts'
);

test.after(() => dom.window.close());

async function settle() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const FRESH = { closed: false, welcomed: false, visited: [] };

async function mount(
  t,
  {
    connected = false,
    projects = [],
    clearStorage = true,
    onboardingActive = false,
    disk = FRESH,
    completed = true,
    statusError = false,
    saveError = false,
    mixy = true,
  } = {}
) {
  if (clearStorage) window.localStorage.clear();
  resetSidebarReferenceCache();
  resetMixyStatus();
  const saved = [];
  window.mixdogDesktop = {
    invokeCapability: async ({ capability, args }) => {
      if (capability === 'saveStarterGuideState') {
        saved.push(args[0]);
        if (saveError) throw new Error('save rejected');
      }
      if (capability === 'getOnboardingStatus') {
        if (statusError) throw new Error('status rejected');
        return { value: { completed, starterGuide: disk } };
      }
      if (capability === 'getLeadStatus') return { value: { created: mixy } };
      return {
        value:
          capability === 'getProviderSetup' ? { api: [], oauth: [{ id: 'openai', authenticated: connected }] } : {},
      };
    },
    listProjects: async () => projects,
  };
  const opened = { views: [], settings: [], settingsClosed: 0, saved };
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
  return { opened, render, saved };
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
  assert.match(pill().textContent, /2\/6/, 'still done while the cache is empty');
  const before = toasts();
  setCachedConnectionInfo(api, { clients: [{ id: 'c1' }] });
  await render();
  await settle();
  assert.equal(toasts(), before, 'no second "Done" notice');
});

test('the guide counts real provider and project state and lists the steps in guided order', async (t) => {
  await mount(t, { connected: true, projects: [{ path: 'C:/work', name: 'work' }] });
  assert.match(pill().textContent, /3\/6/);
  await click(pill());
  assert.deepEqual(
    steps().map((step) => step.querySelector('b').textContent),
    [
      'Connect a provider',
      'Add a project',
      'Set up workflows and agents',
      'Set up remote access',
      'Explore extensions',
      'Create representative bot',
    ]
  );
  assert.deepEqual(
    steps().map((step) => step.dataset.done === 'true'),
    [true, true, false, false, false, true]
  );
  // Only the next open step carries its explanation.
  assert.deepEqual(
    steps().map((step) => Boolean(step.querySelector('small'))),
    [false, false, true, false, false, false]
  );
});

/** The empty Agents pane's create button (MixyEmptyState), laid out. */
function mixyCreateButton(t) {
  const create = document.createElement('button');
  create.className = 'mixy-empty-create';
  create.getBoundingClientRect = () => ({ top: 120, left: 40, width: 180, height: 32, right: 220, bottom: 152 });
  document.body.append(create);
  t.after(() => create.remove());
  return create;
}

test('a new user without the representative bot gets the welcome, never while its dialog is open', async (t) => {
  await mount(t, { mixy: false });
  // Nothing opens the dialog by itself, so the welcome cannot wait for it.
  assert.ok(document.querySelector('.starter-welcome'));
  let release = () => {};
  t.after(() => release());
  await act(async () => {
    release = holdMixyDialogOpen();
  });
  assert.equal(document.querySelector('.starter-welcome'), null);
  await act(async () => release());
  assert.ok(document.querySelector('.starter-welcome'));
});

test('대표 봇 만들기 is the last step: it lights the create button, opens no dialog, and completes on creation', async (t) => {
  const requested = [];
  t.after(onMixyDialogRequest(() => requested.push('dialog')));
  const { opened } = await mount(t, { connected: true, mixy: false });
  await click(button('Maybe later'));
  assert.match(pill().textContent, /1\/6/);
  const create = mixyCreateButton(t);
  await click(pill());
  const last = steps()[5];
  assert.equal(last.querySelector('b').textContent, 'Create representative bot');
  assert.equal(last.dataset.done, undefined);
  // Its step opens the Agents page and points at the real button.
  await click(last);
  assert.deepEqual(opened.views, ['agents']);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.equal(document.querySelector('.starter-tour-card h2').textContent, 'Create representative bot');
  assert.ok(document.querySelector('.starter-tour-hole[data-live="true"]'));
  assert.deepEqual(requested, [], 'the step itself opens no dialog');
  // The click is the user's: the tour hands the page over.
  await click(create);
  await settle();
  assert.equal(document.querySelector('.starter-tour-card'), null);
  assert.deepEqual(requested, []);
  assert.match(pill().textContent, /1\/6/);
  // The dialog created it, under the name the user chose.
  await act(async () => publishMixyStatus({ created: true, name: 'Navi' }));
  await settle();
  assert.match(pill().textContent, /2\/6/);
  assert.match(document.querySelector('.starter-guide-toast').textContent, /Create representative bot/);
});

test('the step copy names the representative by its current name', async (t) => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'mixdog.desktop.starter-guide.v1',
    JSON.stringify({ closed: false, welcomed: true, visited: ['workflow', 'extensions', 'remote'] })
  );
  await mount(t, { connected: true, projects: [{ path: 'C:/work' }], mixy: false, clearStorage: false });
  await act(async () => publishMixyStatus({ created: false, name: 'Navi' }));
  await click(pill());
  const last = steps()[5];
  assert.equal(last.dataset.next, 'true');
  assert.match(last.textContent, /The representative bot helps with anything/);
  assert.match(last.textContent, /Done when the representative bot is created\./);
});

test('an existing user (Mixy already decided as created) sees that step done, without a notice', async (t) => {
  const { opened } = await mount(t, { mixy: true });
  await click(button('Maybe later'));
  assert.match(pill().textContent, /1\/6/);
  assert.equal(document.querySelector('.starter-guide-toast'), null);
  // A created representative leaves nothing to open.
  await click(pill());
  await click(steps()[5]);
  assert.deepEqual(opened.views, []);
  assert.equal(document.querySelector('.starter-tour-card'), null);
});

test('the welcome chain ends on the Agents page with the create button lit; only its click hands over', async (t) => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'mixdog.desktop.starter-guide.v1',
    JSON.stringify({ closed: false, welcomed: false, visited: ['workflow', 'remote'] })
  );
  const requested = [];
  t.after(onMixyDialogRequest(() => requested.push('dialog')));
  const { opened } = await mount(t, {
    connected: true,
    projects: [{ path: 'C:/work' }],
    mixy: false,
    clearStorage: false,
  });
  const create = mixyCreateButton(t);
  await click(button('Start the tour'));
  assert.deepEqual(opened.views, ['extensions']);
  await click(button('Next'));
  await click(button('Next'));
  await click(button('Done'));
  assert.deepEqual(opened.views, ['extensions', 'agents']);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.equal(document.querySelector('.starter-tour-card h2').textContent, 'Create representative bot');
  assert.ok(document.querySelector('.starter-tour-hole[data-live="true"]'));
  assert.deepEqual(requested, [], 'the chain opens no dialog');
  await click(create);
  await settle();
  assert.equal(document.querySelector('.starter-tour-card'), null);
});

test('the create stop lights the visible button, not a hidden retained twin, and its click hands over', async (t) => {
  const { opened } = await mount(t, { connected: true, mixy: false });
  await click(button('Maybe later'));
  // A retained routine page (RoutineNeedsBot) earlier in the DOM: hidden by
  // visibility only, so it keeps a box in the same spot.
  const retained = document.createElement('div');
  retained.style.visibility = 'hidden';
  const twin = mixyCreateButton(t);
  retained.append(twin);
  document.body.prepend(retained);
  t.after(() => retained.remove());
  const create = mixyCreateButton(t);
  create.getBoundingClientRect = () => ({ top: 200, left: 40, width: 180, height: 32, right: 220, bottom: 232 });
  await click(pill());
  await click(steps()[5]);
  assert.deepEqual(opened.views, ['agents']);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.equal(document.querySelector('.starter-tour-hole[data-live="true"]')?.style.top, '194px');
  await click(create);
  await settle();
  assert.equal(document.querySelector('.starter-tour-card'), null);
  assert.equal(document.querySelector('.starter-tour-hole'), null);
});

test('the completion notice covers the pill, at least its width, instead of the panel above it', async (t) => {
  await mount(t);
  await click(button('Maybe later'));
  const guide = document.querySelector('.starter-guide');
  guide.getBoundingClientRect = () => ({ top: 720, left: 60, width: 230, height: 32, right: 290, bottom: 752 });
  await click(pill());
  await click(steps()[2]);
  await click(button('Next'));
  await click(button('Next'));
  await click(button('Next'));
  await click(button('Done'));
  const toast = document.querySelector('.starter-guide-toast');
  assert.equal(toast.style.bottom, `${window.innerHeight - 752}px`, 'bottom edge on the pill’s');
  assert.equal(toast.style.left, '60px');
  assert.equal(toast.style.minWidth, '230px');
  assert.equal(toast.style.width, '', 'grows to fit the step name');
  assert.equal(toast.style.maxWidth, `${window.innerWidth - 60 - 16}px`);
});

test('with no visible pill the completion notice still stops 16px short of the window edge', async (t) => {
  await mount(t);
  await click(button('Maybe later'));
  // The side panel is closed: the pill has no box (jsdom's default rect).
  await click(pill());
  await click(steps()[2]);
  await click(button('Next'));
  await click(button('Next'));
  await click(button('Next'));
  await click(button('Done'));
  const toast = document.querySelector('.starter-guide-toast');
  assert.equal(toast.style.left, '60px');
  assert.equal(toast.style.bottom, '16px');
  assert.equal(toast.style.maxWidth, `${window.innerWidth - 60 - 16}px`);
});

test('the delegation stop lights where a session tab shows and sets its mode', async (t) => {
  await mount(t);
  await click(button('Maybe later'));
  // An existing session tab: no New Task select, the route label and the
  // model menu (whose rows set the mode) instead.
  const line = document.createElement('span');
  line.className = 'composer-model-line-controls';
  const label = document.createElement('button');
  label.className = 'composer-route-label';
  label.getBoundingClientRect = () => ({ top: 600, left: 400, width: 140, height: 24, right: 540, bottom: 624 });
  const trigger = document.createElement('button');
  trigger.className = 'model-trigger';
  trigger.getBoundingClientRect = () => ({ top: 600, left: 560, width: 120, height: 24, right: 680, bottom: 624 });
  line.append(label, trigger);
  document.body.append(line);
  t.after(() => line.remove());
  await click(pill());
  await click(steps()[2]);
  await click(button('Next'));
  await click(button('Next'));
  assert.equal(tourCount(), '3/4');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1400)));
  assert.equal(tourCount(), '3/4', 'not skipped');
  const hole = () => document.querySelector('.starter-tour-hole');
  assert.equal(hole()?.style.left, '394px', 'the route label');
  // The "simple" composer style shows no label: the model menu holds the mode.
  label.remove();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.equal(hole()?.style.left, '554px', 'the model menu');
});

test('each step opens its destination and runs its own tour', async (t) => {
  const { opened } = await mount(t);
  await click(button('Maybe later'));
  assert.match(pill().textContent, /1\/6/);
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
  assert.match(pill().textContent, /1\/6/);
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
  assert.match(pill().textContent, /2\/6/);
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
  assert.match(pill().textContent, /3\/6/);
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

test('the guide holds the What’s new gate while the welcome is open and releases it when answered', async (t) => {
  const { useStarterGuideBlocking, setStarterGuideBlocking } = await import('./starter-guide-gate.ts');
  t.after(() => setStarterGuideBlocking(false));
  let blocked = false;
  const Probe = () => {
    blocked = useStarterGuideBlocking();
    return null;
  };
  const host = document.createElement('div');
  const probeRoot = createRoot(host);
  t.after(async () => act(async () => probeRoot.unmount()));
  await act(async () => probeRoot.render(React.createElement(Probe)));
  await mount(t);
  assert.ok(document.querySelector('.starter-welcome'));
  assert.equal(blocked, true);
  await click(button('Maybe later'));
  assert.equal(blocked, false);
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
  const host = document.createElement('div');
  document.body.append(host);
  const restore = openModal(host);
  assert.notEqual(document.querySelector('.starter-tour').inert, true);
  restore();
  host.remove();
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

test('the guide stays closed when only the config file says closed', async (t) => {
  const { saved } = await mount(t, { disk: { closed: true, welcomed: true, visited: ['workflow'] } });
  assert.equal(document.querySelector('.starter-guide'), null);
  assert.equal(document.querySelector('.starter-welcome'), null);
  // The merge is mirrored into the fast local copy; the disk already has it.
  assert.equal(JSON.parse(window.localStorage.getItem('mixdog.desktop.starter-guide.v1')).closed, true);
  assert.deepEqual(saved, []);
});

test('nothing shows until the config copy has been read', async (t) => {
  window.localStorage.clear();
  resetSidebarReferenceCache();
  let release;
  window.mixdogDesktop = {
    invokeCapability: ({ capability }) => {
      if (capability === 'getOnboardingStatus') {
        return new Promise((resolve) => {
          release = () => resolve({ value: { starterGuide: { closed: true, welcomed: true, visited: [] } } });
        });
      }
      return Promise.resolve({ value: capability === 'getProviderSetup' ? { api: [], oauth: [] } : {} });
    },
    listProjects: async () => [],
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const props = {
    descriptors: new Map(),
    onboardingActive: false,
    onOpenView() {},
    onOpenSettings() {},
    onCloseSettings() {},
  };
  await act(async () => root.render(React.createElement(StarterGuide, props)));
  await settle();
  assert.equal(document.querySelector('.starter-guide'), null);
  assert.equal(document.querySelector('.starter-welcome'), null);
  await act(async () => release());
  await settle();
  assert.equal(document.querySelector('.starter-guide'), null);
  assert.equal(document.querySelector('.starter-welcome'), null);
});

test('localStorage-only state is merged with the config copy and written to it once', async (t) => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'mixdog.desktop.starter-guide.v1',
    JSON.stringify({ closed: false, welcomed: true, visited: ['extensions'] })
  );
  const { saved } = await mount(t, {
    clearStorage: false,
    disk: { closed: false, welcomed: false, visited: ['workflow'] },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].welcomed, true);
  assert.deepEqual([...saved[0].visited].sort(), ['extensions', 'workflow']);
  assert.match(pill().textContent, /3\/6/);
});

test('a profile onboarded before the guide was persisted, whose localStorage was lost, keeps it closed', async (t) => {
  // Installed-app evidence: onboarding completed 2026-10-01 with no
  // starterGuide in mixdog-config.json, and the Local Storage database was
  // recreated empty during the 1.1.0 session.
  const { saved } = await mount(t, { disk: null, completed: true });
  assert.equal(document.querySelector('.starter-guide'), null);
  assert.equal(document.querySelector('.starter-welcome'), null);
  assert.deepEqual(saved, [{ closed: true, welcomed: true, visited: [] }], 'the recovery is written to the config');
  assert.equal(JSON.parse(window.localStorage.getItem('mixdog.desktop.starter-guide.v1')).closed, true);
});

test('before onboarding completes, an empty profile is a new user and gets the guide', async (t) => {
  const { saved } = await mount(t, { disk: null, completed: false });
  assert.ok(document.querySelector('.starter-welcome'));
  assert.deepEqual(saved, []);
});

test('an older profile with its local copy intact keeps its progress and backfills the config', async (t) => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'mixdog.desktop.starter-guide.v1',
    JSON.stringify({ closed: false, welcomed: true, visited: ['workflow'] })
  );
  const { saved } = await mount(t, { disk: null, completed: true, clearStorage: false });
  assert.match(pill().textContent, /2\/6/);
  assert.deepEqual(saved, [{ closed: false, welcomed: true, visited: ['workflow'] }]);
});

test('a rejected status read keeps the guide hidden unless a local copy decides', async (t) => {
  const { saved } = await mount(t, { statusError: true });
  assert.equal(document.querySelector('.starter-guide'), null);
  assert.equal(document.querySelector('.starter-welcome'), null);
  assert.deepEqual(saved, []);
  window.localStorage.setItem(
    'mixdog.desktop.starter-guide.v1',
    JSON.stringify({ closed: false, welcomed: true, visited: [] })
  );
  await mount(t, { statusError: true, clearStorage: false });
  assert.match(pill().textContent, /1\/6/);
});

test('a rejected save still keeps the change locally', async (t) => {
  const { saved } = await mount(t, { saveError: true });
  await click(button('Maybe later'));
  await settle();
  assert.deepEqual(saved, [{ closed: false, welcomed: true, visited: [] }]);
  assert.equal(JSON.parse(window.localStorage.getItem('mixdog.desktop.starter-guide.v1')).welcomed, true);
  assert.ok(pill());
});

test('every persisted change is written to localStorage and the config file', async (t) => {
  const { saved } = await mount(t);
  assert.deepEqual(saved, []);
  await click(button('Maybe later'));
  assert.deepEqual(saved, [{ closed: false, welcomed: true, visited: [] }]);
  assert.equal(JSON.parse(window.localStorage.getItem('mixdog.desktop.starter-guide.v1')).welcomed, true);
});
