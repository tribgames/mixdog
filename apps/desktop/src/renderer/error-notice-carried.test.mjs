// A room or schedule refusal that crossed `contextBridge` carries its code in a
// message trailer. No surface that shows the message may show the trailer.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { ErrorNotice, errorMessageText, errorSummary } from './ErrorNotice.tsx';
import { composerSubmitErrorText } from './composer-submit-error.ts';
import { scheduleErrorText } from './schedule-error-text.ts';
import { ipcErrorEnvelope, ipcErrorFromEnvelope } from '../shared/coded-error.ts';
import { roomMemberSwitchedOffError } from '../shared/room-error-codes.ts';

const bridged = (error) => new Error(ipcErrorFromEnvelope(structuredClone(ipcErrorEnvelope(error))).message);
const scheduleRefusal = () =>
  bridged(
    Object.assign(new Error('Schedule "a" is running. Rename it after the run finishes.'), {
      code: 'SCHEDULE_RENAME_RUNNING',
      details: { name: 'a' },
    })
  );
const roomRefusal = () => bridged(roomMemberSwitchedOffError('Bench'));
const MARKER = /\[(mixdog-error|worktree-details)\]/;

test('the carried errors really hold the trailer', () => {
  assert.match(scheduleRefusal().message, MARKER);
  assert.match(roomRefusal().message, MARKER);
});

test('ErrorNotice shows a carried error, summary and expanded details, without the trailer', async () => {
  const { dom, restore } = installTestDom(null, {
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'HTMLElement', 'MutationObserver'],
  });
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(React.createElement(ErrorNotice, { errors: [scheduleRefusal(), roomRefusal()] }))
    );
    assert.doesNotMatch(document.body.textContent, MARKER);
    assert.match(document.body.textContent, /switched off/);
    await act(async () =>
      document.querySelector('[aria-expanded]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    const details = [...document.querySelectorAll('pre')].map((pre) => pre.textContent).join('\n');
    assert.match(details, /Rename it after the run finishes/);
    assert.match(details, /"Bench" is switched off/);
    assert.doesNotMatch(document.body.textContent, MARKER);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('the helpers other surfaces call show a carried error without the trailer', () => {
  for (const error of [scheduleRefusal(), roomRefusal()]) {
    assert.doesNotMatch(errorMessageText(error), MARKER);
    assert.doesNotMatch(errorSummary(error), MARKER);
  }
  // The Run-now toasts (SchedulesView, RoutinesPane) show scheduleErrorText.
  assert.doesNotMatch(scheduleErrorText(scheduleRefusal()), MARKER);
  // The composer's fallback for an error it has no translation for.
  const other = bridged(Object.assign(new Error('x'), { code: 'SCHEDULE_NAME_TAKEN', details: { name: 'b' } }));
  assert.doesNotMatch(composerSubmitErrorText(other), MARKER);
  assert.doesNotMatch(composerSubmitErrorText(roomRefusal()), MARKER);
});
