import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { isOtherDevice, sessionUsesMultipleDevices } from '../shared/session-devices.ts';
import { TranscriptDevicesContext, TranscriptRow, TranscriptViewerDeviceContext } from './transcript-row.tsx';
import { retiredApprovalFor } from './use-retired-approval.ts';
import { applyPromptRestore } from './use-composer-prompt-restore.ts';
import { nextComposerSubmissionId, draftWithRestoredPrompt } from './composer-draft.ts';

const user = (id, device) => ({ id, kind: 'user', device });

test('a device is named only when more than one device sent prompts', () => {
  assert.equal(sessionUsesMultipleDevices([user('1', 'Main PC'), user('2', 'Main PC')]), false);
  assert.equal(sessionUsesMultipleDevices([user('1', 'Main PC'), user('2', 'Pixel')]), true);
  assert.equal(sessionUsesMultipleDevices([user('1', 'Main PC')], ['Pixel']), true);
  assert.equal(sessionUsesMultipleDevices([{ id: 'a', kind: 'assistant', device: 'x' }, user('1', 'Main PC')]), false);
});

const rowMarkup = (device, viewer) =>
  renderToStaticMarkup(
    React.createElement(
      TranscriptDevicesContext.Provider,
      { value: true },
      React.createElement(
        TranscriptViewerDeviceContext.Provider,
        { value: viewer },
        React.createElement(TranscriptRow, { item: { kind: 'user', id: 'u1', text: 'hi', device } })
      )
    )
  );

test('a message from the viewing device carries no "from" label; another device does', () => {
  assert.ok(!rowMarkup('DESKTOP-IBLP835', 'DESKTOP-IBLP835').includes('message-device'), 'own message');
  assert.ok(rowMarkup('Pixel 9', 'DESKTOP-IBLP835').includes('Pixel 9'), 'phone message seen on the PC');
  // A remote viewer sees the host-typed message labelled, and its own unlabelled.
  assert.ok(rowMarkup('DESKTOP-IBLP835', 'Pixel 9').includes('DESKTOP-IBLP835'), 'host message seen on the phone');
  assert.ok(!rowMarkup('Pixel 9', 'Pixel 9').includes('message-device'), "the phone's own message");
});

test('nothing is attributed until the viewing device is known; an unnamed viewer names every device', () => {
  assert.ok(!rowMarkup('Pixel 9', null).includes('message-device'));
  assert.ok(rowMarkup('Pixel 9', '').includes('message-device'));
  assert.equal(isOtherDevice('Pixel 9', 'Pixel 9'), false);
  assert.equal(isOtherDevice('', 'Pixel 9'), false);
  assert.equal(isOtherDevice('Main PC', 'Pixel 9'), true);
});

test('an approval answered elsewhere leaves a settled card only in a multi-device conversation', () => {
  const previous = { id: 'a1' };
  const snapshot = {
    toolApproval: null,
    toolApprovalResult: { id: 'a1', approved: true, device: 'Pixel', at: 1 },
    items: [user('1', 'Main PC')],
  };
  assert.deepEqual(retiredApprovalFor(previous, snapshot, new Set())?.outcome, { approved: true, device: 'Pixel' });
  assert.equal(retiredApprovalFor(previous, snapshot, new Set(['a1'])), null, 'this device answered it');
  assert.equal(
    retiredApprovalFor(previous, { ...snapshot, items: [user('1', 'Pixel')] }, new Set()),
    null,
    'one device only'
  );
  assert.equal(retiredApprovalFor({ id: 'a2' }, snapshot, new Set()), null, "another approval's result");
});

test('a handed-back prompt lands only in the composer of the device that sent it, beside any draft', () => {
  const mine = nextComposerSubmissionId();
  const restore = { id: 'r1', ids: [mine], text: 'my prompt', device: 'Pixel', at: 1 };
  const applied = new Set();
  assert.equal(
    applyPromptRestore({ ...restore, id: 'r0', ids: ['desktop-submit-someone-else'] }, 'draft', applied),
    null
  );
  assert.equal(applyPromptRestore(restore, 'half typed', applied), draftWithRestoredPrompt('half typed', 'my prompt'));
  assert.ok(applyPromptRestore(restore, 'half typed', new Set()), 'ownership, not the draft, decides');
  assert.equal(applyPromptRestore(restore, 'half typed', applied), null, 'applied once');
  assert.equal(draftWithRestoredPrompt('half typed', 'my prompt').includes('half typed'), true);
});
