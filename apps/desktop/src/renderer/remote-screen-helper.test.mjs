import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createScreenHelperGrants,
  createScreenHelperInstall,
  EMPTY_SCREEN_HELPER_FORM,
  readScreenHelperBlock,
  screenBlockReason,
  screenGrantSurfaceActive,
  screenHelperAsksAccount,
  screenHelperFormReady,
  screenHelperPanel,
  submitScreenHelperForm,
} from './remote-screen-helper.ts';
import { CREDUI_MAX_PASSWORD_LENGTH, CREDUI_MAX_USERNAME_LENGTH } from '../shared/remote-webrtc.ts';
import { readRemoteWebrtcScreenStatus } from '../shared/remote-webrtc.ts';
import { generateSecureDesktopControllerKey, secureDesktopGrantPayload } from '../shared/secure-desktop-grant.ts';

const block = (patch = {}) => ({ offer: 'none', outcome: null, detail: null, issue: null, secure: null, ...patch });
const nonce = (byte) => Buffer.alloc(16, byte).toString('base64');

test('a helper service that would not start is said, with no button, whatever else is offered', () => {
  const offered = block({ offer: 'install', outcome: 'declined' });
  assert.deepEqual(screenHelperPanel(offered, false, 'failed'), {
    action: null,
    busy: false,
    lines: [{ kind: 'copy', id: 'service-failed' }],
  });
  assert.deepEqual(screenHelperPanel(null, false, 'failed').lines, [{ kind: 'copy', id: 'service-failed' }]);
  for (const state of ['active', 'starting', 'missing', 'not-needed', undefined]) {
    assert.notDeepEqual(screenHelperPanel(offered, false, state).lines, [{ kind: 'copy', id: 'service-failed' }]);
  }
  assert.equal(screenHelperPanel(block({ offer: 'install' }), false, 'missing').action, 'install');
});

test('a helper held by another viewer is said, with no button, whatever is offered', () => {
  for (const offer of ['install', 'update', 'none']) {
    assert.deepEqual(screenHelperPanel(block({ offer }), false, 'in-use'), {
      action: null,
      busy: false,
      lines: [{ kind: 'copy', id: 'in-use' }],
    });
  }
  assert.equal(screenHelperPanel(block({ offer: 'install' }), true, 'in-use').busy, false);
});

test('the helper block is the helperInfo of the status the shared reader parsed', () => {
  assert.equal(readScreenHelperBlock(null), null, 'before the first status');
  const info = block({ offer: 'update', outcome: 'declined', detail: 'No.', issue: 'input_failed', secure: 'lock' });
  const status = { state: 'secure-desktop', helper: 'active', control: false, helperInfo: info };
  const text = JSON.stringify({ v: 1, kind: 'screen-status', status });
  assert.deepEqual(readScreenHelperBlock(readRemoteWebrtcScreenStatus(text).status), info);
  // The reader refuses a block it does not know, so none ever reaches the panel.
  const bad = JSON.stringify({
    v: 1,
    kind: 'screen-status',
    status: { ...status, helperInfo: { ...info, offer: 'later' } },
  });
  assert.equal(readRemoteWebrtcScreenStatus(bad), null);
});

test('the button follows the offer and how the last request ended', () => {
  const action = (patch) => screenHelperPanel(block(patch), false).action;
  assert.equal(action({ offer: 'install' }), 'install');
  assert.equal(action({ offer: 'update' }), 'update');
  assert.equal(action({ offer: 'none' }), null);
  assert.equal(screenHelperPanel(null, false).action, null, 'no block, no button');

  // A decline latches on the PC until it restarts: no button. Failed leaves it.
  assert.equal(action({ offer: 'install', outcome: 'declined' }), null);
  assert.equal(action({ offer: 'update', outcome: 'declined' }), null);
  assert.equal(action({ offer: 'update', outcome: 'failed', detail: 'x' }), 'update');
  // The PC is waiting on its prompt; another Windows account owns it; it cannot be installed here; it is done.
  for (const outcome of ['in-progress', 'other-user', 'unavailable', 'installed', 'updated']) {
    assert.equal(action({ offer: 'install', outcome }), null, outcome);
    assert.equal(action({ offer: 'update', outcome }), null, outcome);
  }
  // Nothing to offer, nothing to press, whatever the outcome says.
  assert.equal(action({ offer: 'none', outcome: 'declined' }), null);
});

test('after a press the button waits for the PC, and nothing presses it for the person', async () => {
  const failed = block({ offer: 'install', outcome: 'failed', detail: 'x' });
  assert.deepEqual(screenHelperPanel(failed, true), { ...screenHelperPanel(failed, false), busy: true });
  assert.equal(screenHelperPanel(failed, false).busy, false);
  assert.equal(screenHelperPanel(block({ offer: 'install', outcome: 'declined' }), true).busy, false);
  assert.equal(screenHelperPanel(block(), true).busy, false, 'no button, nothing to hold');

  // Every status the PC can push, one after another: the install request is
  // sent only by an explicit call, never because a status said declined/failed.
  const sent = [];
  const request = createScreenHelperInstall({
    ensureKey: async () => ({ publicKey: 'PUB' }),
    send: (message) => sent.push(message) > 0,
  });
  for (const outcome of ['in-progress', 'declined', 'failed', 'declined', 'unavailable', 'other-user', 'installed']) {
    screenHelperPanel(block({ offer: 'install', outcome, detail: 'd' }), false);
  }
  assert.deepEqual(sent, []);
  assert.equal(await request(), true);
  assert.deepEqual(sent, [{ v: 1, kind: 'screen-helper-install', publicKey: 'PUB' }]);
});

test('the lines say how the request ended, then what the helper reported', () => {
  const lines = (patch) => screenHelperPanel(block(patch), false).lines;
  assert.deepEqual(lines({ offer: 'install' }), []);
  assert.deepEqual(lines({ offer: 'install', outcome: 'in-progress' }), [{ kind: 'copy', id: 'in-progress' }]);
  assert.deepEqual(lines({ offer: 'install', outcome: 'declined' }), [{ kind: 'copy', id: 'declined' }]);
  assert.deepEqual(lines({ outcome: 'other-user' }), [{ kind: 'copy', id: 'other-user' }]);
  assert.deepEqual(lines({ outcome: 'unavailable' }), [{ kind: 'copy', id: 'unavailable' }]);
  // The PC's diagnostic never becomes a visible line: the fixed access copy does.
  assert.deepEqual(
    lines({
      offer: 'install',
      outcome: 'failed',
      detail: 'the helper image was refused: it is not a signed, unrevoked Mixdog release build',
    }),
    [{ kind: 'copy', id: 'failed' }]
  );
  assert.deepEqual(lines({ offer: 'install', outcome: 'failed' }), [{ kind: 'copy', id: 'failed' }]);
  assert.deepEqual(lines({ outcome: 'installed' }), [], 'back to normal');
  assert.deepEqual(lines({ offer: 'update', outcome: 'updated' }), [], 'back to normal');

  for (const issue of ['sas_disabled_by_policy', 'desktop_unavailable', 'input_failed', 'grant_key_missing']) {
    assert.deepEqual(lines({ issue }), [{ kind: 'copy', id: issue }], issue);
  }
  assert.deepEqual(lines({ issue: 'grant_expired' }), [], 'an expired grant is answered silently');
  assert.deepEqual(lines({ outcome: 'declined', issue: 'input_failed' }), [
    { kind: 'copy', id: 'declined' },
    { kind: 'copy', id: 'input_failed' },
  ]);
});

test('every line the panel can show has Korean copy', () => {
  const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
  const pane = readFileSync(new URL('./RemoteScreenPane.tsx', import.meta.url), 'utf8');
  const copy = new Map(
    [...pane.matchAll(/case '([\w-]+)':\s*return t\('([^']+)'\)/gu)].map(([, id, text]) => [id, text])
  );
  const ids = [
    'in-progress',
    'declined',
    'failed',
    'other-user',
    'unavailable',
    'sas_disabled_by_policy',
    'desktop_unavailable',
    'input_failed',
    'grant_key_missing',
  ];
  for (const id of ids) {
    assert.ok(copy.has(id), `${id} has copy in the pane`);
    assert.ok(ko[copy.get(id)], `${id}: ${copy.get(id)}`);
  }
  for (const text of ['PC에 접근 권한 요청', '접근 권한 다시 승인', 'PC에 뜬 확인 창에서 승인해 주세요.']) {
    assert.ok(Object.values(ko).includes(text), text);
  }
  assert.ok(
    ko['Request access on the PC'] && ko['Approve access again'] && ko['The request could not be sent to the PC.']
  );
});

test('the lock or UAC wording follows the helper when it names the secure screen', () => {
  const view = { kind: 'blocked', reason: 'secure', dim: true };
  assert.equal(screenBlockReason(view, null), 'secure');
  assert.equal(screenBlockReason(view, block()), 'secure');
  assert.equal(screenBlockReason(view, block({ secure: 'lock' })), 'lock');
  assert.equal(screenBlockReason({ ...view, reason: 'uac' }, block({ secure: 'lock' })), 'lock');
  assert.equal(screenBlockReason({ ...view, reason: 'lock' }, block({ secure: 'uac' })), 'uac');
});

test('the install request enrolls the pairing key, and fails if there is none to enroll', async () => {
  const sent = [];
  const send = (message) => {
    sent.push(message);
    return true;
  };
  assert.equal(
    await createScreenHelperInstall({ ensureKey: () => Promise.reject(new Error('no storage')), send })(),
    false
  );
  assert.deepEqual(sent, [], 'a key that could not be kept is never enrolled');
  assert.equal(
    await createScreenHelperInstall({ ensureKey: async () => ({ publicKey: 'K' }), send: () => false })(),
    false
  );
});

test('a grant is signed only for the current run, while the surface is active, and verifies', async () => {
  const key = await generateSecureDesktopControllerKey();
  const state = { epoch: 4, active: true, key };
  const sent = [];
  const grants = createScreenHelperGrants({
    key: async () => state.key,
    epoch: () => state.epoch,
    active: () => state.active,
    send: (message) => {
      sent.push(message);
      return true;
    },
  });
  const challenge = (epoch) => ({ epoch, nonce: nonce(1), challenge: nonce(2) });

  assert.equal(await grants.challenge(challenge(4)), 'sent');
  const [grant] = sent;
  assert.deepEqual(
    { ...grant, signature: undefined },
    { v: 1, kind: 'screen-helper-grant', epoch: 4, challenge: nonce(2), signature: undefined }
  );
  const publicKey = await crypto.subtle.importKey(
    'raw',
    Buffer.from(key.publicKey, 'base64url'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  assert.equal(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(grant.signature, 'base64'),
      secureDesktopGrantPayload(nonce(1), nonce(2), 4)
    ),
    true,
    'signed over nonce, challenge and the run epoch'
  );

  // A challenge for another run is stale, whichever way.
  assert.equal(await grants.challenge(challenge(3)), 'stale');
  assert.equal(await grants.challenge(challenge(5)), 'stale');
  state.epoch = null;
  assert.equal(await grants.challenge(challenge(4)), 'stale');
  state.epoch = 4;
  // Not the active, visible control surface: nothing is signed at all.
  state.active = false;
  assert.equal(await grants.challenge(challenge(4)), 'inactive');
  state.active = true;
  // No key for this pairing: it cannot answer, and does not invent one.
  state.key = null;
  assert.equal(await grants.challenge(challenge(4)), 'no-key');
  state.key = key;
  assert.equal(sent.length, 1, 'only the first was ever sent');
});

test('a grant is dropped if the run or the surface changed while it was being signed', async () => {
  const key = await generateSecureDesktopControllerKey();
  const state = { epoch: 2, active: true };
  const sent = [];
  let reached;
  const grants = createScreenHelperGrants({
    key: async () => key,
    epoch: () => state.epoch,
    active: () => state.active,
    send: (message) => sent.push(message) > 0,
    sign: async (...args) => {
      reached?.();
      await new Promise((done) => setTimeout(done, 5));
      return 'c2ln';
    },
  });
  const challenge = { epoch: 2, nonce: nonce(1), challenge: nonce(2) };

  const midway = (change) =>
    new Promise((resolve) => {
      reached = () => change();
      grants.challenge(challenge).then(resolve);
    });
  assert.equal(await midway(() => (state.epoch = 3)), 'stale');
  state.epoch = 2;
  assert.equal(await midway(() => (state.active = false)), 'inactive');
  state.active = true;
  assert.deepEqual(sent, []);
  reached = undefined;
  assert.equal(await grants.challenge(challenge), 'sent');
  assert.equal(sent.length, 1);

  // A signing error or a channel that is gone answers nothing.
  const broken = createScreenHelperGrants({
    key: async () => key,
    epoch: () => 2,
    active: () => true,
    send: () => true,
    sign: async () => {
      throw new Error('x');
    },
  });
  assert.equal(await broken.challenge(challenge), 'failed');
  const closed = createScreenHelperGrants({
    key: async () => key,
    epoch: () => 2,
    active: () => true,
    send: () => false,
  });
  assert.equal(await closed.challenge(challenge), 'failed');
});

test('a transition during the key load or the signature ends the challenge, even if the surface is active again', async () => {
  const key = await generateSecureDesktopControllerKey();
  const challenge = { epoch: 2, nonce: nonce(1), challenge: nonce(2) };
  const deferred = () => {
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    return { promise, release };
  };

  // Inactive while the key was still loading: nothing is signed.
  {
    const state = { active: true };
    const load = deferred();
    const signed = [];
    const sent = [];
    const grants = createScreenHelperGrants({
      key: () => load.promise,
      epoch: () => 2,
      active: () => state.active,
      send: (message) => sent.push(message) > 0,
      sign: async () => (signed.push(1), 'c2ln'),
    });
    const result = grants.challenge(challenge);
    state.active = false;
    load.release(key);
    assert.equal(await result, 'inactive');
    assert.deepEqual([signed.length, sent.length], [0, 0]);
  }

  // Hidden and shown again while the key loaded (active at both checks): the
  // generation moved on, so the old challenge is not signed.
  {
    const load = deferred();
    const signed = [];
    const grants = createScreenHelperGrants({
      key: () => load.promise,
      epoch: () => 2,
      active: () => true,
      send: () => true,
      sign: async () => (signed.push(1), 'c2ln'),
    });
    const result = grants.challenge(challenge);
    grants.invalidate();
    load.release(key);
    assert.equal(await result, 'stale');
    assert.equal(signed.length, 0);
  }

  // Inactive → active during the signature: the old grant is not sent.
  {
    const hold = deferred();
    const sent = [];
    const grants = createScreenHelperGrants({
      key: async () => key,
      epoch: () => 2,
      active: () => true,
      send: (message) => sent.push(message) > 0,
      sign: () => hold.promise,
    });
    const result = grants.challenge(challenge);
    await new Promise((done) => setTimeout(done, 0));
    grants.invalidate();
    hold.release('c2ln');
    assert.equal(await result, 'stale');
    assert.deepEqual(sent, []);
    // The next challenge, begun after the transition, goes out.
    hold.release();
    const next = createScreenHelperGrants({
      key: async () => key,
      epoch: () => 2,
      active: () => true,
      send: () => true,
    });
    assert.equal(await next.challenge(challenge), 'sent');
  }
});

test('a grant goes out through the viewer its challenge came from, and is dropped if that viewer was replaced', async () => {
  const key = await generateSecureDesktopControllerKey();
  const challenge = { epoch: 2, nonce: nonce(1), challenge: nonce(2) };
  const first = { name: 'first', sent: [] };
  const second = { name: 'second', sent: [] };
  const state = { current: first };
  let release;
  const hold = new Promise((resolve) => (release = resolve));
  let slow = true;
  const grants = createScreenHelperGrants({
    key: async () => key,
    epoch: () => 2,
    active: () => true,
    origin: () => state.current,
    send: (message, origin) => origin.sent.push(message) > 0,
    sign: async () => (slow ? hold.then(() => 'c2ln') : 'c2ln'),
  });

  const swapped = grants.challenge(challenge, first);
  state.current = second;
  release();
  assert.equal(await swapped, 'stale');
  assert.deepEqual([first.sent.length, second.sent.length], [0, 0], 'nothing goes through either viewer');

  slow = false;
  assert.equal(await grants.challenge(challenge, second), 'sent');
  assert.deepEqual([first.sent.length, second.sent.length], [0, 1]);
  // A challenge from a viewer that is no longer current is dropped up front.
  assert.equal(await grants.challenge(challenge, first), 'stale');
  assert.equal(first.sent.length, 0);
});

test("no screen session asks for the helper by itself: the only request is the button's", async () => {
  const helper = await import('./remote-screen-helper.ts');
  assert.equal(helper.createScreenHelperAutoInstall, undefined, 'the first-full-screen request is gone');
  const sent = [];
  const requestInstall = createScreenHelperInstall({
    ensureKey: async () => ({ publicKey: 'PUB' }),
    send: (message) => sent.push(message) > 0,
  });
  assert.deepEqual(sent, [], 'nothing goes out until the person presses the button');
  assert.equal(await requestInstall(), true);
  assert.deepEqual(sent, [{ v: 1, kind: 'screen-helper-install', publicKey: 'PUB' }]);
});

test('a request refused only because the PC was busy keeps the action and says to try again; it is not this phone’s own request in progress', () => {
  for (const offer of ['install', 'update']) {
    assert.deepEqual(screenHelperPanel(block({ offer, outcome: 'busy' }), false), {
      action: offer,
      busy: false,
      lines: [{ kind: 'copy', id: 'busy' }],
    });
    // Unlike the PC's own prompt open for this phone, which removes it.
    assert.equal(screenHelperPanel(block({ offer, outcome: 'in-progress' }), false).action, null);
  }
  // No offer, nothing to press: unchanged.
  assert.equal(screenHelperPanel(block({ offer: 'none', outcome: 'busy' }), false).action, null);
});

test('the password sheet asks for an account name only when the PC says its account is not an administrator', () => {
  assert.equal(screenHelperAsksAccount(block({ accountIsAdmin: false })), true);
  assert.equal(screenHelperAsksAccount(block({ accountIsAdmin: true })), false);
  assert.equal(screenHelperAsksAccount(block()), false, 'an older PC does not say: the password only');
  assert.equal(screenHelperAsksAccount(null), false, 'before the first status');
  // Recovery: a PC that did not say, then answered not-admin, reveals the field,
  // and it stays once shown even when the next answer is another refusal.
  assert.equal(screenHelperAsksAccount(block({ outcome: 'not-admin' })), true);
  assert.equal(screenHelperAsksAccount(block({ outcome: 'bad-credentials' })), false);
  assert.equal(screenHelperAsksAccount(block({ outcome: 'bad-credentials' }), true), true);

  // The status the PC pushed carries the field through the shared reader to the sheet.
  const text = (accountIsAdmin) =>
    JSON.stringify({
      v: 1,
      kind: 'screen-status',
      status: {
        state: 'secure-desktop',
        helper: 'missing',
        control: false,
        helperInfo: block({ offer: 'install', ...(accountIsAdmin === undefined ? {} : { accountIsAdmin }) }),
      },
    });
  for (const [said, asks] of [
    [false, true],
    [true, false],
    [undefined, false],
  ]) {
    assert.equal(screenHelperAsksAccount(readScreenHelperBlock(readRemoteWebrtcScreenStatus(text(said)).status)), asks);
  }
});

test('a submit needs a bounded password (and the account name when asked), sends exactly that, and always empties the password', () => {
  const form = (patch = {}) => ({ ...EMPTY_SCREEN_HELPER_FORM, ...patch });

  // Password only: no account name rides along, even if one was typed before.
  assert.equal(screenHelperFormReady(form(), false), false, 'nothing typed');
  assert.equal(screenHelperFormReady(form({ password: 'pw' }), false), true);
  assert.deepEqual(submitScreenHelperForm(form({ password: 'pw', user: 'stale' }), false), {
    credential: { password: 'pw' },
    form: { password: '', user: 'stale' },
  });

  // With the account field: the name is required, trimmed, bounded and sent.
  assert.equal(screenHelperFormReady(form({ password: 'pw' }), true), false, 'the name is missing');
  assert.equal(screenHelperFormReady(form({ password: 'pw', user: '   ' }), true), false);
  assert.deepEqual(submitScreenHelperForm(form({ password: 'pw', user: ' PC\\admin ' }), true), {
    credential: { password: 'pw', user: 'PC\\admin' },
    form: { password: '', user: ' PC\\admin ' },
  });

  // Bounded like the wire: one more than Windows allows is not submitted.
  const long = 'a'.repeat(CREDUI_MAX_PASSWORD_LENGTH + 1);
  assert.equal(screenHelperFormReady(form({ password: 'a'.repeat(CREDUI_MAX_PASSWORD_LENGTH) }), false), true);
  assert.equal(screenHelperFormReady(form({ password: long }), false), false);
  assert.equal(
    screenHelperFormReady(form({ password: 'pw', user: 'u'.repeat(CREDUI_MAX_USERNAME_LENGTH) }), true),
    true
  );
  assert.equal(
    screenHelperFormReady(form({ password: 'pw', user: 'u'.repeat(CREDUI_MAX_USERNAME_LENGTH + 1) }), true),
    false
  );

  // Not ready: nothing is sent and the form is untouched.
  const typed = form({ password: long });
  assert.deepEqual(submitScreenHelperForm(typed, false), { credential: null, form: typed });
});

test('the sheet’s request carries the Windows password: an install offer as an install, an update offer as an enroll', async () => {
  const sent = [];
  const request = createScreenHelperInstall({
    ensureKey: async () => ({ publicKey: 'PUB' }),
    send: (message) => sent.push(message) > 0,
  });
  const credential = { password: 'pw' };
  assert.equal(await request('install', credential), true);
  assert.equal(await request('update', { password: 'pw2', user: 'PC\\admin' }), true);
  assert.deepEqual(sent, [
    { v: 1, kind: 'screen-helper-install', publicKey: 'PUB', credential: { password: 'pw' } },
    { v: 1, kind: 'screen-helper-enroll', publicKey: 'PUB', credential: { password: 'pw2', user: 'PC\\admin' } },
  ]);
  // Both survive the shared encoder/reader (bounds and all).
  const {
    encodeRemoteWebrtcScreenHelperInstall,
    encodeRemoteWebrtcScreenHelperEnroll,
    parseRemoteWebrtcChannelFromClient,
  } = await import('../shared/remote-webrtc.ts');
  const key = (await generateSecureDesktopControllerKey()).publicKey;
  assert.deepEqual(
    parseRemoteWebrtcChannelFromClient(encodeRemoteWebrtcScreenHelperInstall(key, { credential })).credential,
    credential
  );
  assert.doesNotThrow(() =>
    encodeRemoteWebrtcScreenHelperEnroll(key, { credential: { password: 'pw2', user: 'PC\\admin' } })
  );
});

test('only a shown, visible screen pane may sign a grant', () => {
  const visible = 'visible';
  assert.equal(
    screenGrantSurfaceActive({ kind: 'live', control: false }, visible),
    true,
    'the grant is what gives control'
  );
  assert.equal(screenGrantSurfaceActive({ kind: 'live', control: true }, visible), true);
  assert.equal(screenGrantSurfaceActive({ kind: 'blocked', reason: 'lock', dim: true }, visible), true);
  for (const view of [{ kind: 'connecting' }, { kind: 'failed' }, { kind: 'stopped', reason: 'other' }]) {
    assert.equal(screenGrantSurfaceActive(view, visible), false, view.kind);
  }
  assert.equal(screenGrantSurfaceActive({ kind: 'live', control: true }, 'hidden'), false);
  assert.equal(screenGrantSurfaceActive({ kind: 'blocked', reason: 'uac', dim: true }, 'hidden'), false);
});
