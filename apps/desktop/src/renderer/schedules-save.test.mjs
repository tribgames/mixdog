import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom, toolModulesSource } from './test-support/test-dom.mjs';

async function mountSchedules(t, invokeCapability) {
  const { document, root, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'FormData'],
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window.navigator, 'userAgent', { value: `${window.navigator.userAgent} Electron/38.0.0` });
  const { SchedulesPane } = await import('./SchedulesView.tsx');
  const { requestNewSchedule } = await import('./routine-editor-request.ts');
  const { resetSidebarReferenceCache, updateSidebarReference } = await import('./sidebar-reference-cache.ts');
  resetSidebarReferenceCache();
  t.after(resetSidebarReferenceCache);
  const source = toolModulesSource();
  source.publishSection('agents', []);
  source.publishSection('projects', []);
  const api = {
    sections: source.sections,
    async invokeCapability(request) {
      if (request.capability === 'getLeadStatus') return { value: { created: true } };
      return invokeCapability(request);
    },
  };
  const name = () => document.querySelector('input[name="schedule-name"]');
  const instructions = () => document.querySelector('textarea[name="schedule-instructions"]');
  const submit = () =>
    document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await act(async () => root.render(React.createElement(SchedulesPane, { api })));
  return { document, window, name, instructions, submit, requestNewSchedule, updateSidebarReference };
}

test('a first schedule save is usable before refresh settles, without discarding a newer draft', async (t) => {
  const write = Promise.withResolvers();
  const refresh = Promise.withResolvers();
  const saves = [];
  const { document, name, instructions, submit, requestNewSchedule } = await mountSchedules(
    t,
    ({ capability, args }) => {
      if (capability === 'getChannelSetup') return saves.length ? refresh.promise : { value: { schedules: [] } };
      if (capability === 'saveSchedule') {
        saves.push(args[0]);
        return write.promise;
      }
      return { value: null };
    }
  );

  await act(async () => document.querySelector('.schedules-add').click());
  name().value = 'daily-report';
  instructions().value = 'Summarize the report';
  await act(async () => {
    submit();
    submit();
  });
  assert.equal(name().disabled, true);

  await act(async () => requestNewSchedule('lead'));
  await act(async () => {
    write.resolve({
      value: {
        name: 'daily-report',
        whenCron: '0 9 * * *',
        instructions: 'Summarize the report',
        owner: 'lead',
        enabled: true,
      },
    });
  });
  assert.equal(name().disabled, false, 'the newer draft unlocks on the write receipt, before the list refresh');
  assert.equal(name().value, '', 'the first save does not close or replace the newer draft');
  await act(async () => document.querySelector('[aria-label="Close schedule editor"]').click());
  await act(async () => document.querySelector('.routines-open').click());
  assert.equal(name().value, 'daily-report');
  assert.equal(instructions().value, 'Summarize the report');
  assert.equal(name().disabled, false);

  await act(async () => refresh.reject(new Error('channel read failed')));
  assert.match(document.querySelector('.schedules-page [role="status"]').textContent, /refresh.*channel read failed/);
  assert.equal(name().value, 'daily-report');
  assert.equal(saves.length, 1, 'neither double submit nor a failed refresh causes a duplicate write');
});

test('late save outcomes preserve a newer same-name row and report rejection outside a replacement draft', async (t) => {
  const original = { name: 'daily-report', whenCron: '0 9 * * *', instructions: 'Original', owner: 'lead' };
  const newer = { ...original, instructions: 'Newer catalog instructions' };
  const unrelated = { ...original, name: 'another-report' };
  const receipt = Promise.withResolvers();
  const rejection = Promise.withResolvers();
  const refresh = Promise.withResolvers();
  let writes = 0;
  const { document, window, name, instructions, submit, requestNewSchedule, updateSidebarReference } =
    await mountSchedules(t, ({ capability }) => {
      if (capability === 'getChannelSetup') return writes ? refresh.promise : { value: { schedules: [original] } };
      if (capability === 'saveSchedule') return ++writes === 1 ? receipt.promise : rejection.promise;
      return { value: null };
    });
  const openReport = () =>
    [...document.querySelectorAll('.routines-open')]
      .find((button) => button.textContent.includes('daily-report'))
      .click();
  const toasts = [];
  const { DESKTOP_TOAST_EVENT } = await import('./desktop-toasts.tsx');
  window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail));

  await act(async () => openReport());
  instructions().value = 'Instructions from the pending write';
  await act(async () => submit());
  await act(async () => updateSidebarReference('channelSetup', { schedules: [newer, unrelated] }));
  await act(async () =>
    receipt.resolve({ value: { ...original, instructions: 'Instructions from the pending write' } })
  );

  await act(async () => openReport());
  assert.equal(instructions().value, 'Newer catalog instructions', 'a late receipt must not replace the observed row');
  assert.match(document.querySelector('.schedules-page').textContent, /another-report/);

  await act(async () => submit());
  await act(async () => requestNewSchedule('lead'));
  name().value = 'replacement-draft';
  await act(async () => {
    rejection.reject(
      Object.assign(new Error('duplicate'), { code: 'SCHEDULE_NAME_TAKEN', details: { name: 'daily-report' } })
    );
  });
  assert.equal(name().value, 'replacement-draft');
  assert.equal(name().disabled, false);
  assert.doesNotMatch(document.querySelector('.schedules-editor-dialog').textContent, /already exists/);
  assert.deepEqual(
    toasts.map(({ tone, text }) => [tone, text]),
    [['error', 'A schedule named "daily-report" already exists.']]
  );
  await act(async () => refresh.resolve({ value: { schedules: [newer, unrelated] } }));
});

test('a refused Enabled switch in the editor flips back, so Save keeps the stored value', async (t) => {
  const stored = { name: 'daily-report', whenCron: '0 9 * * *', instructions: 'Report', owner: 'lead', enabled: true };
  const toggles = [];
  const saves = [];
  const { document, submit } = await mountSchedules(t, ({ capability, args }) => {
    if (capability === 'getChannelSetup') return { value: { schedules: [stored] } };
    if (capability === 'setScheduleEnabled') {
      toggles.push(args);
      throw new Error('toggle refused');
    }
    if (capability === 'saveSchedule') {
      saves.push(args[0]);
      return { value: args[0] };
    }
    return { value: null };
  });
  await act(async () => document.querySelector('.routines-open').click());
  const enabled = document.querySelector('.schedules-editor-dialog [aria-label="Enabled"]');
  await act(async () => enabled.click());
  assert.deepEqual(toggles, [['daily-report', false]]);
  assert.equal(enabled.checked, true);
  await act(async () => submit());
  assert.deepEqual(
    saves.map((entry) => entry.enabled),
    [true]
  );
});

test('a delayed create receipt cannot resurrect a schedule after a published deletion', async (t) => {
  const empty = { schedules: [] };
  const saved = { name: 'daily-report', whenCron: '0 9 * * *', instructions: 'Summarize the report', owner: 'lead' };
  const receipt = Promise.withResolvers();
  const refresh = Promise.withResolvers();
  let saves = 0;
  const { document, name, instructions, submit, requestNewSchedule, updateSidebarReference } = await mountSchedules(
    t,
    ({ capability }) => {
      if (capability === 'getChannelSetup') return saves ? refresh.promise : { value: empty };
      if (capability === 'saveSchedule') {
        saves++;
        return receipt.promise;
      }
      return { value: null };
    }
  );

  await act(async () => document.querySelector('.schedules-add').click());
  name().value = saved.name;
  instructions().value = saved.instructions;
  await act(async () => submit());
  await act(async () => updateSidebarReference('channelSetup', { schedules: [saved] }));
  assert.match(document.querySelector('.routines-open').textContent, /daily-report/);
  // Republishing the exact same empty value still supersedes the submit-time catalog.
  await act(async () => updateSidebarReference('channelSetup', empty));
  await act(async () => requestNewSchedule('lead'));
  name().value = 'replacement-draft';
  await act(async () => receipt.resolve({ value: saved }));

  assert.equal(document.querySelector('.routines-open'), null, 'the late receipt does not undo the observed delete');
  assert.equal(name().value, 'replacement-draft');
  assert.equal(name().disabled, false, 'acknowledgement unlocks the draft before refresh answers');
  assert.equal(saves, 1);
  await act(async () => refresh.resolve({ value: empty }));
});
