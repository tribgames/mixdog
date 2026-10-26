import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideScreenSource,
  decisionUsesHelper,
  NO_SECURE_DESKTOP,
  screenStatusFor,
  secureDesktopIdentity,
} from './secure-desktop-switch.ts';

const ordinary = { inputDesktop: 'Default', consent: false, logonUi: false };
const inPlacePrompt = { inputDesktop: 'Default', consent: true, logonUi: false };
const secure = { inputDesktop: null, consent: true, logonUi: false };
const lockScreen = { inputDesktop: null, consent: false, logonUi: true };

const noHelper = { helperInstalled: false, helperConnected: false, helperDesktop: null };
const helperReady = { helperInstalled: true, helperConnected: true, helperDesktop: 'Winlogon' };

test('the ordinary desktop streams through the default path', () => {
  const decision = decideScreenSource({ local: ordinary, ...noHelper });
  assert.equal(decision.mode, 'default');
  assert.equal(decision.status, 'live');
  assert.equal(decision.helperActive, false);
  assert.equal(decisionUsesHelper(decision), false);
  assert.equal(decision.helper, 'missing');
});

test('an in-place UAC prompt without a helper is live but un-actionable', () => {
  const decision = decideScreenSource({ local: inPlacePrompt, ...noHelper });
  assert.equal(decision.mode, 'elevation-prompt');
  assert.equal(decision.status, 'elevation-prompt');
  assert.equal(decision.reason, 'uac');
  // View works; control is withheld without the helper.
  assert.equal(screenStatusFor(decision, true).control, false);
});

test('the secure desktop without a helper is blocked, not a frozen frame', () => {
  const decision = decideScreenSource({ local: secure, ...noHelper });
  assert.equal(decision.mode, 'blocked');
  assert.equal(decision.status, 'secure-desktop');
  assert.equal(decision.reason, 'uac');
  assert.equal(screenStatusFor(decision, true).control, false);
});

test('the lock screen reports a lock reason', () => {
  assert.equal(decideScreenSource({ local: lockScreen, ...noHelper }).reason, 'lock');
});

test('the secure desktop with an attached helper switches to the helper', () => {
  const decision = decideScreenSource({ local: secure, ...helperReady });
  assert.equal(decision.mode, 'helper');
  assert.equal(decision.status, 'secure-desktop');
  assert.equal(decision.helperActive, true);
  assert.equal(decisionUsesHelper(decision), true);
  assert.equal(decision.helper, 'active');
  // Control passes through on the helper path when granted, once the helper's
  // video reaches the viewer; before that it is view-blocked.
  assert.equal(screenStatusFor(decision, true, true).control, true);
  assert.equal(screenStatusFor(decision, true, false).control, false);
  assert.equal(screenStatusFor(decision, false, true).control, false);
});

test('an installed-but-not-yet-connected helper is reported as starting and blocks', () => {
  const decision = decideScreenSource({
    local: secure,
    helperInstalled: true,
    helperConnected: false,
    helperDesktop: null,
  });
  assert.equal(decision.mode, 'blocked');
  assert.equal(decision.helper, 'starting');
  assert.equal(decision.helperActive, true);
});

test('an in-place prompt keeps a connected helper warm on the ordinary desktop', () => {
  const decision = decideScreenSource({
    local: inPlacePrompt,
    helperInstalled: true,
    helperConnected: true,
    helperDesktop: 'Default',
  });
  assert.equal(decision.mode, 'default');
  assert.equal(decision.status, 'elevation-prompt');
  assert.equal(decision.helperActive, true);
  // With the helper, the prompt is actionable.
  assert.equal(screenStatusFor(decision, true).control, true);
});

test('desktop names (protocol v3) compare case-insensitively', () => {
  const winlogon = { inputDesktop: 'WINLOGON', consent: false, logonUi: true };
  for (const name of ['Winlogon', 'winlogon', 'WINLOGON']) {
    assert.equal(decideScreenSource({ local: secure, ...helperReady, helperDesktop: name }).mode, 'helper');
  }
  // The local watcher's name, in any case, marks the secure desktop.
  assert.equal(decideScreenSource({ local: winlogon, ...noHelper }).status, 'secure-desktop');
  // A helper still on `Default` (any case) doesn't serve the secure desktop.
  for (const name of ['Default', 'DEFAULT']) {
    assert.equal(decideScreenSource({ local: secure, ...helperReady, helperDesktop: name }).mode, 'blocked');
  }
  // An unknown helper desktop doesn't either.
  assert.equal(decideScreenSource({ local: secure, ...helperReady, helperDesktop: null }).mode, 'blocked');
});

test('the helper identity uses the lower-cased real desktop name', () => {
  const client = { ...NO_SECURE_DESKTOP, connected: () => true, session: () => 2, desktop: () => 'Winlogon' };
  assert.deepEqual(secureDesktopIdentity(client), { session: 2, desktop: 'winlogon' });
  assert.equal(secureDesktopIdentity({ ...client, desktop: () => null }), null);
});

test('no local report yet is treated as the ordinary desktop', () => {
  const decision = decideScreenSource({ local: null, ...noHelper });
  assert.equal(decision.mode, 'default');
  assert.equal(decision.status, 'live');
});
