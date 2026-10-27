import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideScreenSource,
  decisionUsesHelper,
  helperIssueAfterChange,
  NO_SECURE_DESKTOP,
  screenHelperIssue,
  screenStatusFor,
  secureDesktopIdentity,
} from './secure-desktop-switch.ts';

const facts = { offer: 'none', outcome: null, detail: null, issue: null };

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

test('an installed helper whose service could not be started reads failed; a connection supersedes it', () => {
  const installedOnly = { helperInstalled: true, helperConnected: false, helperDesktop: null };
  assert.equal(decideScreenSource({ local: secure, ...installedOnly }).helper, 'starting');
  const down = decideScreenSource({ local: secure, ...installedOnly, helperServiceDown: true });
  assert.equal(down.helper, 'failed');
  assert.equal(down.mode, 'blocked');
  assert.equal(down.helperActive, true, 'still wanted: a later activation tries again');
  assert.equal(screenStatusFor(down, true, false, facts).helper, 'failed');
  assert.equal(decideScreenSource({ local: secure, ...helperReady, helperServiceDown: true }).helper, 'active');
  assert.equal(decideScreenSource({ local: secure, ...noHelper, helperServiceDown: true }).helper, 'missing');
});

test('a helper another session holds reads in-use: blocked, no control, still wanted', () => {
  const held = { ...helperReady, helperOwnedElsewhere: true };
  const onSecure = decideScreenSource({ local: secure, ...held });
  assert.equal(onSecure.helper, 'in-use');
  assert.equal(onSecure.mode, 'blocked');
  assert.equal(onSecure.helperActive, true, 'it waits for the hold to pass');
  assert.equal(screenStatusFor(onSecure, true, true, facts).control, false);
  // An in-place prompt is not warmed through it either: no control.
  const prompt = decideScreenSource({ local: inPlacePrompt, ...held });
  assert.equal(prompt.mode, 'elevation-prompt');
  assert.equal(screenStatusFor(prompt, true, false, facts).control, false);
  // The ordinary desktop is unaffected but says so.
  const live = decideScreenSource({ local: ordinary, ...held });
  assert.equal(live.mode, 'default');
  assert.equal(live.helper, 'in-use');
  assert.equal(screenStatusFor(live, true, false, facts).control, true);
  assert.equal(decideScreenSource({ local: secure, ...noHelper, helperOwnedElsewhere: true }).helper, 'missing');
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

test('lock screen vs UAC: the helper’s lock state decides whenever it reports one, before LogonUI', () => {
  const winlogon = (consent, logonUi) => ({ inputDesktop: 'Winlogon', consent, logonUi });
  const reason = (local, helperLocked) => decideScreenSource({ local, ...helperReady, helperLocked }).reason;
  // Unlocked: LogonUI (the Ctrl+Alt+Del screen) is not the lock screen.
  assert.equal(reason(winlogon(true, true), false), 'uac');
  assert.equal(reason(winlogon(false, true), false), 'secure');
  // Locked: the lock screen, whatever runs.
  assert.equal(reason(winlogon(true, false), true), 'lock');
  assert.equal(reason(winlogon(false, false), true), 'lock');
  // No lock state (unknown, or not connected): the local LogonUI check.
  assert.equal(reason(winlogon(true, true), null), 'lock');
  assert.equal(reason(winlogon(true, false), null), 'uac');
  assert.equal(decideScreenSource({ local: lockScreen, ...noHelper, helperLocked: null }).reason, 'lock');
  // In place on the readable desktop: an unlocked session's lingering LogonUI is no prompt.
  const lingering = { inputDesktop: 'Default', consent: false, logonUi: true };
  assert.equal(decideScreenSource({ local: lingering, ...helperReady, helperLocked: false }).status, 'live');
  assert.equal(decideScreenSource({ local: lingering, ...helperReady, helperLocked: true }).reason, 'lock');
  assert.equal(decideScreenSource({ local: inPlacePrompt, ...helperReady, helperLocked: true }).reason, 'lock');
});

test('the status’s helper block: every offer, outcome and issue as given, and which secure screen is up', () => {
  const blocked = decideScreenSource({ local: secure, ...noHelper });
  for (const offer of ['install', 'update', 'none']) {
    assert.equal(screenStatusFor(blocked, true, false, { ...facts, offer }).helperInfo.offer, offer);
  }
  for (const outcome of ['installed', 'updated', 'declined', 'failed', 'in-progress', 'other-user', 'unavailable']) {
    const detail = outcome === 'failed' ? 'why' : null;
    const info = screenStatusFor(blocked, true, false, { ...facts, outcome, detail }).helperInfo;
    assert.deepEqual([info.outcome, info.detail], [outcome, detail]);
  }
  for (const issue of [
    'grant_key_missing',
    'grant_expired',
    'input_failed',
    'desktop_unavailable',
    'sas_disabled_by_policy',
  ]) {
    assert.equal(screenHelperIssue(issue), issue);
    assert.equal(screenStatusFor(blocked, true, false, { ...facts, issue }).helperInfo.issue, issue);
  }
  for (const other of ['grant_required', 'grant_bad_signature', 'capture_failed', 'protocol_mismatch', '']) {
    assert.equal(screenHelperIssue(other), null, other);
  }
  assert.deepEqual(screenStatusFor(blocked, true, false, facts).helperInfo, { ...facts, secure: 'uac' });
  const lock = decideScreenSource({ local: lockScreen, ...noHelper });
  assert.equal(screenStatusFor(lock, true, false, facts).helperInfo.secure, 'lock');
  const unnamed = decideScreenSource({ local: { inputDesktop: null, consent: false, logonUi: false }, ...noHelper });
  assert.equal(unnamed.reason, 'secure');
  assert.equal(screenStatusFor(unnamed, true, false, facts).helperInfo.secure, null);
  assert.equal(
    screenStatusFor(decideScreenSource({ local: ordinary, ...noHelper }), true, false, facts).helperInfo.secure,
    null
  );
});

test('a helper change ends every issue but a missing key, which stands while connected', () => {
  for (const issue of ['grant_expired', 'input_failed', 'desktop_unavailable', 'sas_disabled_by_policy']) {
    assert.equal(helperIssueAfterChange(issue, true), null, issue);
  }
  assert.equal(helperIssueAfterChange('grant_key_missing', true), 'grant_key_missing');
  assert.equal(helperIssueAfterChange('grant_key_missing', false), null);
  assert.equal(helperIssueAfterChange(null, true), null);
});

test('no local report yet is treated as the ordinary desktop', () => {
  const decision = decideScreenSource({ local: null, ...noHelper });
  assert.equal(decision.mode, 'default');
  assert.equal(decision.status, 'live');
});
