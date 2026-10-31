// Settings → Instruction control: two groups of rows (in use / modified
// badges, first-sentence preview), the edit sub-page, save, and the one
// confirmed reset after which the Modified badge is gone.
import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement', 'Event', 'MouseEvent'],
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { createRoot } = await import('react-dom/client');
const { InstructionControlPanel, instructionPreview } = await import('./instruction-control-panel.tsx');

const file = (group, id, label, body, extra = {}) => ({
  group,
  id,
  label,
  body,
  defaultBody: body,
  userOverride: false,
  modified: false,
  revision: `${id}-1`,
  ...extra,
});
const FILES = [
  file('delegation', 'none', 'Solo', '# Orchestration Mode: Solo\n\nLead executes all work directly. Never delegates.'),
  file('delegation', 'swarm', 'Swarm', '# Orchestration Mode: Swarm\n\nDelegate every scope. More.', {
    modified: true,
    userOverride: true,
    path: '/data/orchestration/swarm.md',
  }),
  file('outputStyle', 'simple', 'Simple', '## Depth\n\n- Give a summary. Omit detail.'),
];

async function mount(run, confirm = () => {}, notice = () => {}) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(InstructionControlPanel, {
        data: { instructionFiles: FILES, orchestrationMode: 'none', outputStyles: { current: { id: 'simple' } } },
        pending: '',
        run,
        confirm,
        notice,
      })
    );
  });
  return {
    host,
    click: (node) => act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
    unmount: () => act(async () => root.unmount()),
  };
}
const button = (host, text) => [...host.querySelectorAll('button')].find((node) => node.textContent === text);

test('preview is the first sentence without headings or list markers', () => {
  assert.equal(
    instructionPreview('# T\n\nLead executes all work directly. Never.'),
    'Lead executes all work directly.'
  );
  assert.equal(instructionPreview('## Depth\n\n- Give a summary. Omit.'), 'Give a summary.');
});

test('rows: two groups, In use and Modified badges, preview text', async () => {
  const { host, unmount } = await mount(async () => undefined);
  assert.deepEqual(
    [...host.querySelectorAll('.settings-group > header h3')].map((node) => node.textContent),
    ['Delegation', 'Output style']
  );
  const rows = [...host.querySelectorAll('.settings-resource')];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Solo.*In use.*Lead executes all work directly\./);
  assert.match(rows[1].textContent, /Swarm.*Modified/);
  assert.doesNotMatch(rows[1].textContent, /In use/);
  assert.match(rows[2].textContent, /Simple.*In use/);
  await unmount();
});

test('edit opens the sub-page; save sends the draft; reset asks once and clears Modified', async () => {
  const calls = [];
  const confirms = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return capability === 'saveInstructionFile'
      ? { ...FILES[1], body: args[0].body, revision: 'swarm-2' }
      : { ...FILES[1], modified: false, userOverride: false, path: undefined };
  };
  const { host, click, unmount } = await mount(run, (options) => confirms.push(options));
  await click([...host.querySelectorAll('.settings-resource')][1].querySelector('button'));
  assert.match(host.querySelector('.instruction-subhead h2').textContent, /Swarm\s*· Delegation instructions/);
  assert.match(host.querySelector('.instruction-meta').textContent, /Modified.*\/data\/orchestration\/swarm\.md/);
  const textarea = host.querySelector('textarea');
  assert.equal(textarea.value, FILES[1].body);
  assert.equal(button(host, 'Save').disabled, true, 'nothing changed yet');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, 'New text.');
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await click(button(host, 'Save'));
  assert.deepEqual(calls[0], [
    'saveInstructionFile',
    [{ group: 'delegation', id: 'swarm', body: 'New text.', expectedRevision: 'swarm-1' }],
  ]);
  await click(button(host, 'Reset to default'));
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].title, 'Reset to default?');
  assert.equal(confirms[0].danger, true);
  assert.equal(calls.length, 1, 'no reset before the confirmation');
  await act(async () => confirms[0].onConfirm());
  assert.deepEqual(calls[1], ['resetInstructionFile', ['delegation', 'swarm', 'swarm-2']]);
  assert.equal(host.querySelector('.instruction-meta .settings-status'), null, 'Modified badge is gone');
  assert.equal(button(host, 'Reset to default').disabled, true);
  await unmount();
});

test('a reset refused as stale reloads the latest text and tells the user', async () => {
  const calls = [];
  const notices = [];
  const confirms = [];
  const latest = { ...FILES[1], body: 'Newer from the phone.', revision: 'swarm-9' };
  const run = async (capability, args) => {
    calls.push(capability);
    if (capability === 'resetInstructionFile') {
      throw Object.assign(new Error('INSTRUCTION_FILE_CONFLICT: "swarm" changed since it was loaded'), {
        code: 'INSTRUCTION_FILE_CONFLICT',
      });
    }
    assert.deepEqual(args, ['delegation', 'swarm']);
    return latest;
  };
  const { host, click, unmount } = await mount(
    run,
    (options) => confirms.push(options),
    (message) => notices.push(message)
  );
  await click([...host.querySelectorAll('.settings-resource')][1].querySelector('button'));
  await click(button(host, 'Reset to default'));
  await act(async () => confirms[0].onConfirm());
  assert.deepEqual(calls, ['resetInstructionFile', 'getInstructionFile']);
  assert.equal(host.querySelector('textarea').value, 'Newer from the phone.');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /changed elsewhere/);
  await unmount();
});
