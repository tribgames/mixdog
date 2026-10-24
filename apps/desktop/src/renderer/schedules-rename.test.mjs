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

/** Open the one-shot's editor, apply `edit` to the form, save; resolves the saved entry. */
async function saveOneShot(whenAt, edit) {
  resetSidebarReferenceCache();
  updateSidebarReference('channelSetup', {
    schedules: [{ name: 'once', whenAt, instructions: 'Report', enabled: true, owner: 'lead' }],
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
    edit();
    await act(async () =>
      document
        .querySelector('form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    assert.equal(saves.length, 1);
    return saves[0];
  } finally {
    await act(async () => root.unmount());
  }
}

test('renaming a one-shot without touching its time sends the saved instant whole, not cut to the minute', async () => {
  const whenAt = '2030-01-02T03:04:05.678Z';
  const saved = await saveOneShot(whenAt, () => {
    document.querySelector('input[name="schedule-name"]').value = 'renamed';
  });
  assert.equal(saved.newName, 'renamed');
  assert.equal(saved.at, whenAt, 'an untouched time is the saved instant');
});

test('an edited one-shot time is sent as typed', async () => {
  const saved = await saveOneShot('2030-01-02T03:04:05.678Z', () => {
    document.querySelector('input[name="schedule-at"]').value = '2030-02-01T09:30';
  });
  assert.equal(saved.at, '2030-02-01T09:30');
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

