// Renaming a schedule from its edit dialog: the name field is editable and the
// saved payload carries the old name (the key) plus the new one.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
globalThis.FormData = window.FormData;
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: `${window.navigator.userAgent} Electron/38.0.0`,
});

const { resetSidebarReferenceCache, updateSidebarReference } = await import('./sidebar-reference-cache.ts');
const { SchedulesPane } = await import('./SchedulesView.tsx');

test('the edit dialog name is enabled, and a changed name saves old name + newName', async () => {
  resetSidebarReferenceCache();
  updateSidebarReference('channelSetup', {
    schedules: [
      { name: 'daily-report', whenCron: '0 9 * * *', instructions: 'Report', enabled: true, owner: 'lead' },
    ],
    webhooks: [],
  });
  updateSidebarReference('projects', []);
  updateSidebarReference('agents', []);
  const saves = [];
  const api = {
    invokeCapability(request) {
      if (request.capability === 'getLeadStatus') return Promise.resolve({ value: { created: true } });
      if (request.capability === 'saveSchedule') {
        saves.push(request.args[0]);
        return Promise.resolve({ value: {} });
      }
      return new Promise(() => {});
    },
  };
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(SchedulesPane, { api, active: true })));
    await act(async () => document.querySelector('.routines-open').click());
    const input = document.querySelector('input[name="schedule-name"]');
    assert.equal(input.disabled, false, 'the name is editable while editing');
    assert.equal(input.maxLength, 64);
    const submit = () =>
      act(async () =>
        document
          .querySelector('form')
          .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      );
    input.value = 'morning-report';
    await submit();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].name, 'daily-report');
    assert.equal(saves[0].newName, 'morning-report');
    assert.equal(saves[0].overwrite, true);
  } finally {
    await act(async () => root.unmount());
  }
});

test('saving an edit without changing the name carries no newName', async () => {
  resetSidebarReferenceCache();
  updateSidebarReference('channelSetup', {
    schedules: [{ name: 'daily-report', whenCron: '0 9 * * *', instructions: 'Report', enabled: true }],
    webhooks: [],
  });
  updateSidebarReference('projects', []);
  updateSidebarReference('agents', []);
  const saves = [];
  const api = {
    invokeCapability(request) {
      if (request.capability === 'getLeadStatus') return Promise.resolve({ value: { created: true } });
      if (request.capability === 'saveSchedule') {
        saves.push(request.args[0]);
        return Promise.resolve({ value: {} });
      }
      return new Promise(() => {});
    },
  };
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(SchedulesPane, { api, active: true })));
    await act(async () => document.querySelector('.routines-open').click());
    await act(async () =>
      document
        .querySelector('form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    assert.equal(saves[0].name, 'daily-report');
    assert.equal(Object.hasOwn(saves[0], 'newName'), false);
  } finally {
    await act(async () => root.unmount());
  }
});

