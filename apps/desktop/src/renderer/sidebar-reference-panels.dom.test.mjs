// Panel-level contract for the shared sidebar reference cache: the three rail
// panels must paint from memory, share one request per key, revalidate without
// blanking, and survive a failed refresh with their rows intact.
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

register(new URL('./settings/test-css-loader.mjs', import.meta.url));
const { SchedulesPane } = await import('./SchedulesView.tsx');
const { WebhooksPane } = await import('./WebhooksView.tsx');
const { WorkflowsPane } = await import('./WorkflowsView.tsx');
const { OpenSelect } = await import('./OpenSelect.tsx');
const { StatusPopover } = await import('./StatusPopover.tsx');
const { StudioModelMenu } = await import('./StudioModelMenu.tsx');
const {
  DESKTOP_TOAST_DISMISS_EVENT,
  DESKTOP_TOAST_EVENT,
} = await import('./notifications.tsx');
const {
  invalidateSidebarReferenceForMutation,
  prewarmSidebarReferences,
  readSidebarReference,
  resetSidebarReferenceCache,
} = await import('./sidebar-reference-cache.ts');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let dom;
let root;
let now = 1_000_000;

function mount() {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    FormData: dom.window.FormData,
  });
  dom.window.HTMLElement.prototype.attachEvent ??= () => {};
  dom.window.HTMLElement.prototype.detachEvent ??= () => {};
  now = 1_000_000;
  resetSidebarReferenceCache({ now: () => now });
  root = createRoot(document.getElementById('root'));
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  dom?.window.close();
  root = undefined;
  dom = undefined;
  resetSidebarReferenceCache();
});

function referenceApi() {
  const counts = {};
  const state = {
    fail: '',
    schedules: [{ name: 'daily', enabled: true, time: '0 9 * * *', model: 'openai/gpt-test' }],
    webhooks: [{ name: 'gh-issues', enabled: true, parser: 'github' }],
    // anthropic is present but NOT connected: its models must never reach a
    // picker once the setup snapshot lands.
    providerSetup: {
      api: [{ id: 'openai', authenticated: true }, { id: 'anthropic', authenticated: false }],
    },
  };
  const bump = (name) => {
    counts[name] = (counts[name] || 0) + 1;
  };
  const api = {
    invokeCapability: async ({ capability }) => {
      bump(capability);
      if (state.fail && capability === 'getChannelSetup') throw new Error(state.fail);
      if (capability === 'getChannelSetup') {
        return {
          value: {
            provider: 'discord',
            channel: { discordChannelId: '111' },
            webhook: { publicUrl: 'https://relay.example/hook/device-1' },
            schedules: state.schedules,
            webhooks: state.webhooks,
          },
        };
      }
      if (capability === 'listWorkflows') return { value: [{ id: 'default', name: 'Solo' }] };
      if (capability === 'getProviderSetup') return { value: state.providerSetup };
      return { value: { ok: true } };
    },
    listProviderModels: async () => {
      bump('listProviderModels');
      return [
        {
          provider: 'openai', model: 'gpt-test', display: 'GPT Test',
          effortOptions: [], fastCapable: false, fastPreferred: false,
        },
        {
          provider: 'anthropic', model: 'claude-test', display: 'Claude Test',
          effortOptions: [], fastCapable: false, fastPreferred: false,
        },
      ];
    },
    listProjects: async () => {
      bump('listProjects');
      return [];
    },
  };
  return { api, counts, state };
}

function workflowsApi() {
  const counts = {};
  const state = {
    workflows: [{
      id: 'squad', name: 'Squad', source: 'user', description: 'Custom pack',
      delegatesAgents: true,
    }],
  };
  const bump = (name) => {
    counts[name] = (counts[name] || 0) + 1;
  };
  const api = {
    invokeCapability: async ({ capability }) => {
      bump(capability);
      if (capability === 'listWorkflows') return { value: state.workflows };
      if (capability === 'listAgents') {
        return {
          value: [
            {
              id: 'explore', label: 'Explore', description: 'Maps unfamiliar code and references.',
              custom: false, route: { provider: 'openai', model: 'gpt-test', effort: 'high', fast: true },
            },
            {
              id: 'maintainer', label: 'Maintainer', description: 'Keeps the project healthy over time.',
              custom: false, route: { provider: 'openai', model: 'gpt-test', effort: 'high', fast: true },
            },
            {
              id: 'worker', label: 'Worker', description: 'Implementation role', custom: true,
              route: { provider: 'openai', model: 'gpt-test', effort: 'high', fast: true },
            },
          ],
        };
      }
       if (capability === 'getAgentDefinition') {
         return {
           value: {
             id: 'worker',
             name: 'Worker',
             description: 'Implementation role',
             route: { provider: 'openai', model: 'gpt-test', effort: 'high', fast: true },
             body: '# Worker',
           },
         };
       }
      if (capability === 'getSearchRoute') {
        return {
          value: { provider: 'openai', model: 'gpt-search', effort: 'high', fast: false },
        };
      }
      if (capability === 'listSearchModels') {
        return {
          value: [
            {
              id: 'gpt-search',
              provider: 'openai',
              name: 'GPT Search',
              effortOptions: [{ value: 'high', label: 'High' }],
              fastCapable: true,
              savedFast: false,
            },
            { id: 'claude-search', provider: 'anthropic', name: 'Claude Search' },
          ],
        };
      }
      if (capability === 'getProviderSetup') {
        return {
          value: {
            api: [{ id: 'openai', authenticated: true }, { id: 'anthropic', authenticated: false }],
          },
        };
      }
      return { value: { ok: true } };
    },
    listProviderModels: async () => {
      bump('listProviderModels');
      return [{
        provider: 'openai', model: 'gpt-test', display: 'GPT Test',
         effortOptions: [{ value: 'high', label: 'High' }],
         fastCapable: true, fastPreferred: false,
      }];
    },
  };
  return { api, counts, state };
}

async function openMenu(label) {
  await act(async () => {
    document.querySelector(`[aria-label="Actions for ${label}"]`).click();
    await Promise.resolve();
  });
  return document.querySelector(`[role="menu"][aria-label="Actions for ${label} menu"]`);
}

async function pickerOptions(triggerLabel) {
  await act(async () => {
    document.querySelector(`button[aria-label="${triggerLabel}"]`).click();
    await Promise.resolve();
  });
  return Array.from(document.querySelectorAll('[role="option"]')).map((node) => node.textContent || '');
}

const rowNames = () => Array.from(document.querySelectorAll('.schedules-row b'))
  .map((node) => node.textContent);

test('scroll surfaces spend one shared gutter inside their existing inline inset', async () => {
  const css = await readFile(new URL('./desktop.css', import.meta.url), 'utf8');
  assert.match(css, /:root\s*\{[^}]*--mx-scrollbar-size:\s*8px;/s);
  assert.match(css,
    /\*\s*\{[^}]*scrollbar-width:\s*auto;[^}]*scrollbar-color:\s*auto;/s,
    'standard scrollbar styling must yield to the exact WebKit track width');
  assert.doesNotMatch(css, /\*\s*\{[^}]*scrollbar-width:\s*thin/s,
    'the shell-wide rule must not override the exact shared track width');
  assert.doesNotMatch(css,
    /\.(?:utility-dock-pane|turn-review-files)\s*\{[^}]*scrollbar-width:\s*thin/s,
    'primary vertical lists must inherit the exact shared track width');
  assert.doesNotMatch(css, /scrollbar-gutter:\s*stable both-edges/,
    'no surface may reserve a second fake scrollbar edge');
  assert.match(css,
    /\.transcript\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(css,
    /\.thread\s*\{[^}]*width:\s*100%;[^}]*padding:\s*20px 0 0;/s,
    'the timeline stays full-width so virtual rows own their measured geometry');
  assert.match(css,
    /\.transcript-virtual-row-content\[data-tag="UserMessage"\],[\s\S]*?\.transcript-virtual-row-content\[data-tag="Error"\]\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*var\(--pane-scroll-column\);[^}]*margin-inline:\s*auto;[^}]*padding-left:\s*calc\(var\(--pane-inset\) \+ var\(--composer-text-inset\)\);[^}]*padding-right:\s*calc\(var\(--pane-inset\) \+ var\(--composer-text-inset\) - var\(--mx-scrollbar-size\)\);/s,
    'projected rows spend the single scrollbar reserve inside their centered reading frame');
  assert.match(css,
    /\.workspace > \.session-header,\s*\.conversation,\s*\.studio-shell\s*\{[^}]*--pane-inset:\s*20px;[^}]*--pane-column:\s*100%;[^}]*--pane-scroll-column:\s*100%;/s,
    'chat and Studio surfaces share the default pane inset ladder');
  assert.match(css,
    /@container chat-pane \(max-width:\s*419px\)\s*\{[^}]*\.workspace > \.session-header,\s*\.conversation\s*\{[^}]*--pane-inset:\s*12px;/s);
  assert.match(css,
    /@container chat-pane \(min-width:\s*768px\)\s*\{[^}]*\.workspace > \.session-header,\s*\.conversation\s*\{[^}]*--pane-inset:\s*24px;[^}]*--pane-column:\s*800px;[^}]*--pane-scroll-column:\s*calc\(var\(--pane-column\) - var\(--mx-scrollbar-size\)\);/s);
  assert.match(css,
    /\.composer-region\s*\{[^}]*max-width:\s*var\(--pane-column\);[^}]*padding:\s*0 var\(--pane-inset\) 16px;/s,
    'the composer consumes the same responsive inset and centered column as projected rows');
  assert.match(css,
    /\.studio-results\s*\{[^}]*padding:\s*16px calc\(var\(--pane-inset\) - var\(--mx-scrollbar-size\)\) 8px var\(--pane-inset\);[^}]*scrollbar-gutter:\s*stable;/s,
    'Studio spends the shared gutter from the same responsive pane inset');
  assert.match(css,
    /\.mixdog-settings__body\s*\{[^}]*padding:\s*24px calc\(32px - var\(--mx-scrollbar-size\)\) 32px 32px;[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(css,
    /\.schedules-pane > \.pane-surface-gate > \.pane-surface-gate-content\s*\{[^}]*overflow:\s*visible;/s);
});

test('row overflow opens on pointer press without a render-time geometry read', async () => {
  mount();
  const { api } = referenceApi();
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api, active: true }));
    await Promise.resolve();
  });
  const trigger = document.querySelector('[aria-label="Actions for daily"]');
  let measurements = 0;
  trigger.getBoundingClientRect = () => {
    measurements += 1;
    return {
      left: 100, top: 100, right: 124, bottom: 124,
      width: 24, height: 24, x: 100, y: 100, toJSON() {},
    };
  };
  trigger.dispatchEvent(new window.MouseEvent('pointerover', {
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(measurements, 1, 'hover intent should premeasure the anchor');
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));
    assert.ok(document.querySelector('[role="menu"][aria-label="Actions for daily menu"]'),
      'the menu must exist before the originating pointer event returns');
  });
  assert.ok(document.querySelector('[role="menu"][aria-label="Actions for daily menu"]'),
    'primary pointerdown must present the menu before click release');
  assert.equal(measurements, 1,
    'the pointer press must reuse the intent-time anchor instead of forcing layout');
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
    }));
  });
  assert.ok(document.querySelector('[role="menu"][aria-label="Actions for daily menu"]'),
    'the pointer follow-up click must not toggle the already-open menu');

  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));
    trigger.dispatchEvent(new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
    }));
  });
  assert.equal(document.querySelector('[role="menu"][aria-label="Actions for daily menu"]'), null);
  await act(async () => {
    trigger.click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector('[role="menu"][aria-label="Actions for daily menu"]'),
    'keyboard/programmatic click must keep the accessible toggle path');
  assert.equal(measurements, 2);
});

test('shared transient overlays commit before the primary pointer event returns', async () => {
  mount();
  const api = referenceApi().api;
  window.mixdogDesktop = {
    ...api,
    getSnapshot: async () => ({ items: [], queued: [] }),
  };
  const cases = [
    {
      name: 'OpenSelect',
      element: React.createElement(OpenSelect, {
        ariaLabel: 'Immediate select',
        options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }],
      }),
      trigger: '[aria-label="Immediate select"]',
      surface: '.mx-menu[aria-label="Immediate select"]',
    },
    {
      name: 'StatusPopover',
      element: React.createElement(StatusPopover),
      trigger: '[aria-label="Runtime status"]',
      surface: '[aria-label="Runtime health"]',
    },
    {
      name: 'StudioModelMenu',
      element: React.createElement(StudioModelMenu, {
        entries: [{ lane: 'image', laneLabel: 'Image', model: 'instant', label: 'Instant' }],
        lane: 'image',
        model: 'instant',
        onSelect() {},
      }),
      trigger: '[aria-label="Generation model"]',
      surface: '.studio-model-panel[aria-label="Generation model"]',
    },
  ];
  for (const entry of cases) {
    await act(async () => {
      root.render(entry.element);
      await Promise.resolve();
    });
    const trigger = document.querySelector(entry.trigger);
    let measurements = 0;
    trigger.getBoundingClientRect = () => {
      measurements += 1;
      return {
        left: 100, top: 100, right: 224, bottom: 124,
        width: 124, height: 24, x: 100, y: 100, toJSON() {},
      };
    };
    trigger.dispatchEvent(new window.MouseEvent('pointerover', {
      bubbles: true,
      cancelable: true,
    }));
    const beforePress = measurements;
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
      assert.ok(document.querySelector(entry.surface),
        `${entry.name} must mount in the originating pointer event`);
      assert.equal(measurements, beforePress,
        `${entry.name} must not measure layout during pointer press`);
    });
  }
});

test('a prewarmed cache paints schedules on the first render with no refetch', async () => {
  mount();
  const { api, counts } = referenceApi();
  // Boot prewarm (app-idle-warmup) runs before the panel ever mounts.
  await prewarmSidebarReferences(api);
  assert.equal(counts.getChannelSetup, 1);

  // Synchronous act: this is the FIRST paint, before any effect promise
  // resolves. Rows must already be there instead of a loading cover.
  act(() => {
    root.render(React.createElement(SchedulesPane, { api, active: true }));
  });
  assert.deepEqual(rowNames(), ['daily']);

  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(counts.getChannelSetup, 1, 'a warm panel must not refetch on mount');
});

test('schedules and webhooks mounting together share one request per key', async () => {
  mount();
  const { api, counts } = referenceApi();
  await act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(SchedulesPane, { api, active: true, key: 'schedules' }),
      React.createElement(WebhooksPane, { api, active: false, key: 'webhooks' })));
    await Promise.resolve();
  });

  assert.equal(counts.getChannelSetup, 1);
  assert.equal(counts.listWorkflows, 1);
  assert.equal(counts.listProviderModels, 1);
  assert.equal(counts.listProjects, 1);
  assert.equal(rowNames().includes('daily'), true);
  assert.equal(rowNames().includes('gh-issues'), true);
});

test('stale re-entry revalidates silently and never blanks the rows', async () => {
  mount();
  const { api, counts, state } = referenceApi();
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api, active: false }));
    await Promise.resolve();
  });
  assert.deepEqual(rowNames(), ['daily']);

  now += 30_000;
  state.schedules = [...state.schedules, { name: 'weekly', enabled: true }];
  act(() => {
    root.render(React.createElement(SchedulesPane, { api, active: true }));
  });
  // Mid-revalidation frame: the previous snapshot is still on screen.
  assert.deepEqual(rowNames(), ['daily']);

  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(counts.getChannelSetup, 2);
  assert.deepEqual(rowNames(), ['daily', 'weekly']);
});

test('a mutation invalidates the shared channel setup and refreshes the list', async () => {
  mount();
  const { api, counts, state } = referenceApi();
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api, active: true }));
    await Promise.resolve();
  });
  assert.equal(counts.getChannelSetup, 1);
  const scheduleRow = document.querySelector('.schedules-row');

  await act(async () => {
    document.querySelector('[aria-label="Actions for daily"]').click();
    await Promise.resolve();
  });
  state.schedules = [{ name: 'daily', enabled: false }];
  const menu = document.querySelector('[role="menu"][aria-label="Actions for daily menu"]');
  await act(async () => {
    Array.from(menu.querySelectorAll('button'))
      .find((button) => button.textContent === 'Pause').click();
    await Promise.resolve();
  });

  assert.equal(counts.setScheduleEnabled, 1);
  assert.equal(counts.getChannelSetup, 2, 'the mutation must invalidate the cached setup');
  assert.equal(document.querySelector('.schedules-row'), scheduleRow,
    'updating a schedule must preserve its row DOM');
  assert.equal(document.querySelector('.schedules-row-dot.on'), null);
});

test('a failed revalidation keeps the panel rows on screen', async () => {
  mount();
  const { api, state } = referenceApi();
  let toast;
  window.addEventListener(DESKTOP_TOAST_EVENT, (event) => { toast = event.detail; });
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api, active: false }));
    await Promise.resolve();
  });
  assert.deepEqual(rowNames(), ['daily']);

  now += 30_000;
  state.fail = 'host offline';
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api, active: true }));
    await Promise.resolve();
  });

  assert.deepEqual(rowNames(), ['daily'], 'a failed refresh must retain the stale snapshot');
  assert.match(toast?.text || '', /host offline/);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test('switching the host never paints the previous host rows', async () => {
  mount();
  const first = referenceApi();
  await prewarmSidebarReferences(first.api);
  act(() => {
    root.render(React.createElement(SchedulesPane, { api: first.api, active: true }));
  });
  assert.deepEqual(rowNames(), ['daily']);

  const second = referenceApi();
  second.state.schedules = [{ name: 'nightly', enabled: true }];
  // The very commit that first observes host B must already be free of A.
  act(() => {
    root.render(React.createElement(SchedulesPane, { api: second.api, active: true }));
  });
  assert.deepEqual(rowNames(), []);
  assert.equal(document.querySelector('.schedules-empty'), null,
    'a rebind shows the cover, not an empty-state lie');

  await act(async () => {
    await Promise.resolve();
  });
  assert.deepEqual(rowNames(), ['nightly']);
});

test('a host without the capability bridge lands on the empty state, not a cover', async () => {
  mount();
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api: {}, active: true }));
    await Promise.resolve();
  });
  assert.deepEqual(rowNames(), []);
  assert.ok(document.querySelector('.schedules-empty'));
});

test('disconnected providers never enter the schedules model picker', async () => {
  mount();
  const { api } = referenceApi();
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api, active: true }));
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[aria-label="New schedule"]').click();
    await Promise.resolve();
  });

  const options = await pickerOptions('Schedule model');
  assert.equal(options.some((text) => /gpt-test/i.test(text)), true);
  assert.equal(options.some((text) => /claude/i.test(text)), false);
});

test('workflows filters the search catalog to configured providers', async () => {
  mount();
  const { api, counts } = workflowsApi();
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
    await Promise.resolve();
  });
  assert.equal(counts.getSearchRoute, 1);
  assert.equal(counts.listSearchModels, 1);

  const row = document.querySelector('.workflows-default-agent-summary-row');
  assert.equal(row?.querySelector('small')?.textContent, 'GPT-Search · High · Fast Off');
  assert.equal(row?.querySelector('.settings-model-trigger'), null);
  const menu = await openMenu('Web search');
  const edit = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'Edit');
  await act(async () => {
    edit.click();
    await Promise.resolve();
  });
  const options = await pickerOptions('Web search model');
  assert.equal(options.some((text) => /gpt-search/i.test(text)), true);
  assert.equal(options.some((text) => /claude/i.test(text)), false);
});

test('default agent routes save only from their overflow-owned editor', async () => {
  mount();
  const { api, counts } = workflowsApi();
  let toast;
  window.addEventListener('mixdog:desktop-toast', (event) => { toast = event.detail; }, { once: true });
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
    await Promise.resolve();
  });

  const menu = await openMenu('Web search');
  const edit = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'Edit');
  await act(async () => {
    edit.click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector('#route-dialog-title')?.textContent, 'Edit Web search');
  await act(async () => {
    document.querySelector('.schedules-dialog footer button[type="submit"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(counts.setSearchRoute, 1);
  assert.equal(document.querySelector('#route-dialog-title'), null);
  assert.deepEqual({ text: toast?.text, tone: toast?.tone }, {
    text: 'Saved "Web search" route.',
    tone: 'success',
  });
  assert.equal(document.querySelector('.schedules-feedback-slot'), null);
});

test('workflow creation lives beside the Workflows heading', async () => {
  mount();
  const { api } = workflowsApi();
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
    await Promise.resolve();
  });
  const section = document.querySelector('section[aria-label="Workflows"]');
  const header = section?.querySelector('.workflows-section-head');
  assert.equal(header?.querySelector('h2')?.textContent, 'Workflows');
  assert.ok(header?.querySelector('[aria-label="New workflow"]'));
  assert.equal(document.querySelector('.workflows-pane > [aria-label="New workflow"]'), null);
});

test('default agent route editor shows its fixed identity and description', async () => {
  mount();
  const { api } = workflowsApi();
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
    await Promise.resolve();
  });
  const menu = await openMenu('Maintainer');
  const edit = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'Edit');
  await act(async () => {
    edit.click();
    await Promise.resolve();
  });
  const readOnly = Array.from(document.querySelectorAll('.workflows-readonly-field'));
  assert.deepEqual(readOnly.map((field) => field.querySelector('.workflows-readonly-value')?.textContent), [
    'Maintainer',
    'Keeps the project healthy over time.',
  ]);
  assert.deepEqual(readOnly.map((field) => field.querySelector('small')?.textContent), [
    'Read-only',
    'Read-only',
  ]);
  assert.ok(document.querySelector('[aria-label="Maintainer model"]'));
});

test('editable agents show a quiet route summary and edit only from the overflow menu', async () => {
  mount();
  const { api } = workflowsApi();
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
    await Promise.resolve();
  });

  const row = document.querySelector('section[aria-label="Agents"] .workflows-agent-summary-row');
  assert.equal(row?.querySelector('.schedules-row-copy')?.tagName, 'DIV');
  assert.equal(row?.querySelector('small')?.textContent, 'GPT-Test · High · Fast On');
  assert.equal(row?.querySelector('.settings-model-trigger'), null,
    'editable agent rows must not expose inline route controls');
  assert.equal(row?.querySelector('[aria-label="Edit agent Worker"]'), null,
    'the summary itself must not remain a second edit entry point');

  const menu = await openMenu('Worker');
  const edit = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'Edit');
  await act(async () => {
    edit.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector('#agent-dialog-title')?.textContent, 'Edit agent');
  assert.ok(document.querySelector('[aria-label="Agent model"]'),
    'the overflow Edit dialog retains model, effort, and fast settings');
});

test('custom agent deletion is a plain confirm — agents are global, no workflow bookkeeping', async () => {
  mount();
  const { api, counts } = workflowsApi();
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
    await Promise.resolve();
  });
  const menu = await openMenu('Worker');
  assert.deepEqual(Array.from(menu.querySelectorAll('button')).map((button) => button.textContent), [
    'Edit',
    'Delete',
  ]);
  await act(async () => {
    Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'Delete').click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector('[role="alertdialog"]'), null,
    'no in-use warning: workflows no longer reference agents');
  const dialog = document.querySelector('.workflows-delete-dialog');
  assert.equal(dialog?.querySelector('#agent-delete-dialog-title')?.textContent, 'Delete agent');
  await act(async () => {
    Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Delete').click();
    await Promise.resolve();
  });
  assert.equal(counts.deleteAgentDefinition, 1);
});

test('built-in agents remain protected and never expose delete or reset actions', async () => {
  mount();
  const { api } = workflowsApi();
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
    await Promise.resolve();
  });
  const menu = await openMenu('Maintainer');
  assert.deepEqual(Array.from(menu.querySelectorAll('button')).map((button) => button.textContent), ['Edit']);
});

test('deleting a workflow invalidates the shared workflow and agent keys only', async () => {
  mount();
  const { api, counts, state } = workflowsApi();
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
    await Promise.resolve();
  });
  assert.equal(counts.listWorkflows, 1);

  const menu = await openMenu('Squad');
  const deleteButton = () => Array.from(menu.querySelectorAll('button')).find((button) =>
    button.textContent === 'Delete' || button.textContent === 'Confirm delete');
  await act(async () => {
    deleteButton().click();
    await Promise.resolve();
  });
  state.workflows = [];
  await act(async () => {
    deleteButton().click();
    await Promise.resolve();
  });

  assert.equal(counts.deleteWorkflow, 1);
  assert.equal(counts.listWorkflows, 2);
  assert.equal(counts.listAgents, 2);
  assert.equal(counts.listSearchModels, 1, 'unrelated reference keys stay cached');
  assert.equal(counts.getProviderSetup, 1);
});

test('a mutation completing after a host swap never resurrects the old host', async () => {
  mount();
  const first = referenceApi();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const hostInvoke = first.api.invokeCapability;
  first.api.invokeCapability = async (request) => {
    if (request.capability === 'setScheduleEnabled') {
      await gate;
      return { value: true };
    }
    return hostInvoke(request);
  };
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api: first.api, active: true }));
    await Promise.resolve();
  });
  const menu = await openMenu('daily');
  await act(async () => {
    Array.from(menu.querySelectorAll('button'))
      .find((button) => button.textContent === 'Pause').click();
    await Promise.resolve();
  });

  const second = referenceApi();
  second.state.schedules = [{ name: 'nightly', enabled: true }];
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api: second.api, active: true }));
    await Promise.resolve();
  });
  assert.deepEqual(rowNames(), ['nightly']);

  // Host A's mutation now completes: its refresh must be dropped, not adopted.
  await act(async () => {
    release();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(rowNames(), ['nightly']);
  assert.equal(first.counts.getChannelSetup, 1, 'the abandoned host is never re-read');
  assert.equal(readSidebarReference('channelSetup').schedules[0].name, 'nightly');
});

test('an invalidation from the settings overlay refreshes the panel underneath', async () => {
  mount();
  const { api, counts } = referenceApi();
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api, active: true }));
    await Promise.resolve();
  });
  assert.equal(counts.getProviderSetup, 1);
  assert.equal(counts.listProviderModels, 1);

  // Settings/onboarding mutate provider state from ABOVE the sidebar.
  await act(async () => {
    invalidateSidebarReferenceForMutation('saveProviderApiKey');
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(counts.getProviderSetup, 2, 'the mounted panel must not stay stale');
  assert.equal(counts.listProviderModels, 2);
  assert.equal(counts.getChannelSetup, 1, 'untouched keys are not refetched');
  assert.deepEqual(rowNames(), ['daily'], 'rows stay on screen through the refresh');
});

test('a host swap never surfaces the previous host error', async () => {
  mount();
  const first = referenceApi();
  first.state.fail = 'host offline';
  let toast;
  let dismissed = '';
  window.addEventListener(DESKTOP_TOAST_EVENT, (event) => { toast = event.detail; });
  window.addEventListener(DESKTOP_TOAST_DISMISS_EVENT, (event) => { dismissed = event.detail; });
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api: first.api, active: true }));
    await Promise.resolve();
  });
  assert.match(toast?.text || '', /host offline/);

  const second = referenceApi();
  act(() => {
    root.render(React.createElement(SchedulesPane, { api: second.api, active: true }));
  });
  assert.equal(dismissed, toast.id, 'host B first paint must dismiss host A failure');

  await act(async () => {
    await Promise.resolve();
  });
  assert.deepEqual(rowNames(), ['daily']);
  assert.equal(document.querySelector('[role="alert"]'), null);
});
