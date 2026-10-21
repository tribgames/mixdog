import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIALOG_ANSWER_GESTURE_MS,
  popupTakesSelection,
  recordWindowOpen,
  takeWindowOpenGesture,
} from './popup-focus.ts';

const now = 100_000;
const person = (extra = {}) => ({ actor: 'person', userGesture: false, now, ...extra });

test("a window a person's click opened in front is selected, as Chrome brings it forward", () => {
  // target=_blank / window.open(url) and window.open(url, name, features),
  // with the click's transient activation still on the opener.
  for (const disposition of ['foreground-tab', 'new-window']) {
    assert.equal(popupTakesSelection(disposition, person({ userGesture: true })), true, disposition);
  }
});

test('a delayed popup after an earlier click of the person stays in the background', () => {
  // The person did click this document (its last actor), but the window
  // opens later from a timer: Chromium reports no gesture for it.
  for (const disposition of ['foreground-tab', 'new-window']) {
    assert.equal(popupTakesSelection(disposition, person()), false, disposition);
    assert.equal(
      popupTakesSelection(disposition, person({ personDialogAnswerAt: now - DIALOG_ANSWER_GESTURE_MS - 1 })),
      false,
      'a dialog the person answered long ago is no gesture either'
    );
  }
});

test('a popup right after the person answered an alert is selected, even once the click activation expired', () => {
  // alert('새창에서 열립니다.'); window.open(...): the person may read the
  // alert past Chromium's activation window.
  assert.equal(popupTakesSelection('foreground-tab', person({ personDialogAnswerAt: now - 40 })), true);
  assert.equal(popupTakesSelection('new-window', person({ personDialogAnswerAt: now })), true);
});

test('an agent-opened, unprompted or background-opened window stays unselected', () => {
  for (const disposition of ['foreground-tab', 'new-window']) {
    // An agent click through CDP carries a user activation too.
    assert.equal(popupTakesSelection(disposition, person({ actor: 'agent', userGesture: true })), false);
    assert.equal(popupTakesSelection(disposition, person({ actor: undefined, userGesture: true })), false);
    assert.equal(
      popupTakesSelection(disposition, person({ actor: 'agent', personDialogAnswerAt: now })),
      false,
      'an agent command since the dialog answer makes the window the agent’s'
    );
  }
  // Ctrl/middle click: Chrome leaves the person where they are.
  for (const disposition of ['background-tab', 'other', 'default', '']) {
    assert.equal(popupTakesSelection(disposition, person({ userGesture: true })), false, disposition);
  }
});

test("each window takes its own Page.windowOpen gesture; a later one never inherits an earlier one's", () => {
  const record = { windowOpens: [] };
  // A click opens one window (consuming the activation); a timer opens the next.
  recordWindowOpen(record, { url: 'https://pay.example/first', userGesture: true }, now);
  recordWindowOpen(record, { url: 'https://pay.example/late', userGesture: false }, now + 500);
  assert.equal(takeWindowOpenGesture(record, 'https://pay.example/first', now + 1), true);
  assert.equal(takeWindowOpenGesture(record, 'https://pay.example/first', now + 2), false, 'used once');
  assert.equal(takeWindowOpenGesture(record, 'https://pay.example/late', now + 501), false);
  assert.equal(takeWindowOpenGesture(record, 'https://other.example/', now + 502), false, 'no event: no gesture');
  // window.open('') reaches CDP without an address and Electron as about:blank.
  recordWindowOpen(record, { url: '', userGesture: true }, now);
  assert.equal(takeWindowOpenGesture(record, 'about:blank', now + 1), true);
  recordWindowOpen(record, { url: 'https://pay.example/stale', userGesture: true }, now);
  assert.equal(takeWindowOpenGesture(record, 'https://pay.example/stale', now + 10_000), false, 'too old to match');
});
