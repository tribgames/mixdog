import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from 'node:events';
import { clearBrowserPermissionHandlers, createBrowserPermissions } from './permissions.ts';
import {
  BROWSER_PERMISSION_MAX_SITES,
  defaultBrowserPermissionPolicy,
  normalizeBrowserPermissionPolicy,
  storableBrowserPermissionPolicy,
  withBrowserPermissionDefault,
  withBrowserPermissionSite,
} from '../../shared/browser-permission-policy.ts';

function fixture(options = {}) {
  const handlers = {};
  const session = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler(handler) {
      handlers.check = handler;
    },
    setPermissionRequestHandler(handler) {
      handlers.request = handler;
    },
    setDevicePermissionHandler(handler) {
      handlers.device = handler;
    },
  });
  const activation = { active: true, asked: [] };
  const permissions = createBrowserPermissions({
    userActivation: async (frames) => {
      activation.asked.push(frames.map((frame) => frame.url));
      return activation.active;
    },
    ...options,
  });
  permissions.install(session);
  /** A page at `url`; `children` are its iframes' URLs. */
  const page = (url, children = []) => {
    const guest = new EventEmitter();
    const frame = (frameUrl, routingId) => ({ url: frameUrl, processId: 1, routingId });
    const main = frame(url, 1);
    main.framesInSubtree = [main, ...children.map((child, index) => frame(child, index + 2))];
    Object.assign(guest, { getURL: () => url, isDestroyed: () => false, mainFrame: main });
    return guest;
  };
  const ask = (guest, permission, details = {}) => {
    const outcome = { granted: undefined };
    handlers.request(
      guest,
      permission,
      (granted) => {
        outcome.granted = granted;
      },
      { isMainFrame: true, requestingUrl: guest.getURL(), ...details }
    );
    return outcome;
  };
  const askFrame = (guest, permission, requestingUrl, details = {}) =>
    ask(guest, permission, { isMainFrame: false, requestingUrl, ...details });
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  return { handlers, session, permissions, page, ask, askFrame, activation, settled };
}

test('nothing is granted until a person answers, and devices are never offered', () => {
  const { handlers, session, permissions, page, ask } = fixture();
  const guest = page('https://site.test/app');
  assert.equal(handlers.check(guest, 'notifications', 'https://site.test', {}), false);
  assert.equal(handlers.check(guest, 'media', 'https://site.test', { mediaType: 'video' }), false);
  const camera = ask(guest, 'media', { mediaTypes: ['video', 'audio'] });
  assert.equal(camera.granted, undefined, 'the request waits for a person');
  const shown = permissions.pending(guest);
  assert.deepEqual(shown, { id: shown.id, origin: 'https://site.test', keys: ['media:video', 'media:audio'] });
  assert.equal(handlers.device({ deviceType: 'usb' }), false);
  for (const refused of ['openExternal', 'display-capture', 'pointerLock', 'unknown']) {
    assert.equal(ask(guest, refused).granted, false, refused);
  }
  assert.equal(permissions.answer(guest, 'permission_0', true), false, 'only the prompt shown is answered');
  assert.equal(permissions.answer(guest, shown.id, true), true);
  assert.equal(camera.granted, true);
  assert.equal(permissions.pending(guest), undefined);
  assert.equal(handlers.check(guest, 'media', 'https://site.test', { mediaType: 'video' }), true);
  clearBrowserPermissionHandlers(session);
  assert.equal(handlers.check, null);
  assert.equal(handlers.request, null);
  assert.equal(handlers.device, null);
});

test("an answer is remembered for the site and settles that site's waiting requests", () => {
  const { handlers, permissions, page, ask } = fixture();
  const guest = page('https://site.test/');
  const first = ask(guest, 'midi');
  const again = ask(guest, 'midi');
  const idle = ask(guest, 'idle-detection');
  assert.deepEqual(permissions.pending(guest).keys, ['midi']);
  permissions.answer(guest, permissions.pending(guest).id, false);
  assert.deepEqual([first.granted, again.granted], [false, false]);
  assert.equal(ask(guest, 'midi').granted, false, 'a refusal is not asked again');
  assert.deepEqual(permissions.pending(guest).keys, ['idle-detection']);
  assert.equal(idle.granted, undefined);
  assert.equal(ask(page('https://other.test/'), 'midi').granted, undefined, 'another site is asked');
  assert.equal(handlers.check(guest, 'midi', 'https://site.test', {}), false);
});

test('a permission belongs to the frame that asked, isolated by the site embedding it', () => {
  const { handlers, permissions, page, askFrame, ask } = fixture();
  const top = page('https://site.test/', ['https://evil.test/ad', 'https://ok.test/widget']);
  const evil = askFrame(top, 'media', 'https://evil.test/ad', { mediaTypes: ['video'] });
  assert.equal(evil.granted, undefined);
  const shown = permissions.pending(top);
  assert.equal(shown.origin, 'https://evil.test', 'the prompt names the frame, not the top site');
  assert.equal(shown.embedder, 'https://site.test');
  permissions.answer(top, shown.id, true);
  assert.equal(evil.granted, true);
  const check = (page_, permission, origin, details) => handlers.check(page_, permission, origin, details);
  const camera = { mediaType: 'video' };
  assert.equal(check(top, 'media', 'https://evil.test', { ...camera, embeddingOrigin: 'https://site.test' }), true);
  assert.equal(check(top, 'media', 'https://site.test', camera), false, 'the top site did not inherit the grant');
  assert.equal(check(top, 'media', 'https://ok.test', { ...camera, embeddingOrigin: 'https://site.test' }), false);
  assert.equal(
    check(top, 'media', 'https://evil.test', { ...camera, embeddingOrigin: 'https://other.test' }),
    false,
    'the same frame origin under another embedder is asked again'
  );
  const own = ask(page('https://evil.test/'), 'media', { mediaTypes: ['video'] });
  assert.equal(own.granted, undefined, 'evil.test as a page of its own is asked');
  const again = askFrame(top, 'media', 'https://ok.test/widget', { mediaTypes: ['video'] });
  assert.equal(again.granted, undefined, "another frame's grant is not inherited");
  assert.equal(permissions.pending(top).origin, 'https://ok.test');
  assert.equal(permissions.refused('https://evil.test', 'video_capture'), false);
});

test("a prompt is withdrawn when the asking frame navigates, and not for another frame's", () => {
  const { permissions, page, askFrame } = fixture();
  const top = page('https://site.test/', ['https://a.test/', 'https://b.test/']);
  const a = askFrame(top, 'idle-detection', 'https://a.test/');
  const b = askFrame(top, 'midi', 'https://b.test/');
  top.emit('did-start-navigation', {
    isMainFrame: false,
    isSameDocument: false,
    frame: top.mainFrame.framesInSubtree[2],
  });
  assert.equal(b.granted, false, 'the navigating frame lost its prompt');
  assert.equal(a.granted, undefined);
  assert.deepEqual(permissions.pending(top).keys, ['idle-detection']);
  top.emit('did-start-navigation', {
    isMainFrame: false,
    isSameDocument: true,
    frame: top.mainFrame.framesInSubtree[1],
  });
  assert.ok(permissions.pending(top), 'an in-page navigation keeps it');
  top.emit('did-start-navigation', {
    isMainFrame: false,
    isSameDocument: false,
    frame: top.mainFrame.framesInSubtree[1],
  });
  assert.equal(a.granted, false);
  assert.equal(permissions.pending(top), undefined);
});

test('a navigation or a closed page withdraws its prompts unanswered', async () => {
  const { permissions, page, ask, settled } = fixture();
  const guest = page('https://site.test/');
  const asked = ask(guest, 'clipboard-read');
  await settled();
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.ok(permissions.pending(guest), 'an in-page navigation keeps it');
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(asked.granted, false);
  assert.equal(permissions.pending(guest), undefined);
  const closing = ask(guest, 'clipboard-read');
  await settled();
  assert.ok(permissions.pending(guest), 'withdrawn is not remembered as refused');
  guest.emit('destroyed');
  assert.equal(closing.granted, false);
});

test('privileged clipboard access needs a live user activation, even once granted', async () => {
  const { handlers, permissions, page, ask, activation, settled } = fixture();
  const guest = page('https://site.test/');
  assert.equal(handlers.check(guest, 'clipboard-sanitized-write', 'https://site.test', {}), false);
  assert.equal(handlers.check(guest, 'clipboard-read', 'https://site.test', {}), false);
  activation.active = false;
  const idleWrite = ask(guest, 'clipboard-sanitized-write');
  const idleRead = ask(guest, 'clipboard-read');
  await settled();
  assert.equal(idleWrite.granted, false, 'a gestureless write is refused');
  assert.equal(idleRead.granted, false, 'a gestureless read is not even offered');
  assert.equal(permissions.pending(guest), undefined);
  activation.active = true;
  const write = ask(guest, 'clipboard-sanitized-write');
  await settled();
  assert.equal(write.granted, true, 'a write with a gesture needs no prompt');
  const read = ask(guest, 'clipboard-read');
  await settled();
  assert.equal(read.granted, undefined);
  permissions.answer(guest, permissions.pending(guest).id, true);
  assert.equal(read.granted, true);
  assert.equal(
    handlers.check(guest, 'clipboard-read', 'https://site.test', {}),
    false,
    'a grant is not a standing check'
  );
  activation.active = false;
  const later = ask(guest, 'clipboard-read');
  await settled();
  assert.equal(later.granted, false, 'the remembered grant does not stand in for a gesture');
  activation.active = true;
  const gesture = ask(guest, 'clipboard-read');
  await settled();
  assert.equal(gesture.granted, true);
});

test('an iframe needs its own activation, asked of the frame itself', async () => {
  const { page, askFrame, activation, settled } = fixture();
  const top = page('https://site.test/', ['https://evil.test/ad']);
  askFrame(top, 'clipboard-sanitized-write', 'https://evil.test/ad');
  await settled();
  assert.deepEqual(activation.asked.at(-1), ['https://evil.test/ad']);
});

test('Chrome defaults hold without a prompt: protected media and element fullscreen', () => {
  const { handlers, page, ask } = fixture();
  const guest = page('https://site.test/');
  for (const permission of ['mediaKeySystem', 'fullscreen']) {
    assert.equal(handlers.check(guest, permission, 'https://site.test', {}), true, permission);
    assert.equal(ask(guest, permission).granted, true, permission);
  }
});

test('storage access is granted as Chrome grants it, never asked of a person', () => {
  const { handlers, permissions, page, ask, askFrame } = fixture();
  const top = page('https://search.google.com/search-console', [
    'https://www.google.com/recaptcha/enterprise/anchor',
    'https://www.recaptcha.net/recaptcha/api2/anchor',
  ]);
  for (const frame of top.mainFrame.framesInSubtree.slice(1)) {
    assert.equal(askFrame(top, 'storage-access', frame.url).granted, true, frame.url);
  }
  assert.equal(permissions.pending(top), undefined, 'nobody is asked');
  const embedded = { isMainFrame: false, embeddingOrigin: 'https://search.google.com' };
  const own = { isMainFrame: true, embeddingOrigin: 'https://search.google.com' };
  assert.equal(handlers.check(top, 'storage-access', 'https://search.google.com', own), true, 'the top page holds it');
  assert.equal(handlers.check(top, 'storage-access', 'https://www.google.com', embedded), false, 'a frame does not');
  assert.equal(
    handlers.check(top, 'storage-access', 'https://search.google.com', embedded),
    false,
    'nor a same-origin one'
  );
  assert.equal(ask(top, 'top-level-storage-access').granted, undefined, 'top-level storage access is still asked');
  assert.deepEqual(permissions.pending(top).keys, ['top-level-storage-access']);
});

test('a HID device connects only with the setting on and only the one device a person picks', () => {
  const setting = { on: false };
  const guests = new Map();
  const { handlers, session, permissions, page } = fixture({
    hidDevices: () => setting.on,
    guestForFrame: (frame) => guests.get(frame),
  });
  const guest = page('https://launcher.test/app');
  const frame = { origin: 'https://launcher.test', processId: 1, routingId: 1, isDestroyed: () => false };
  guests.set(frame, guest);
  // The chooser lists devices with a `deviceId`; Electron's device permission
  // handler is given the same device without one (name, ids, serial or guid).
  const keyboard = { deviceId: 'hid-1', name: 'Keyboard', vendorId: 1, productId: 1, serialNumber: 'K1' };
  const deck = { deviceId: 'hid-2', name: 'Stream Deck', vendorId: 4057, productId: 96, serialNumber: 'DECK-A' };
  const otherDeck = { deviceId: 'hid-3', name: 'Stream Deck', vendorId: 4057, productId: 96, serialNumber: 'DECK-B' };
  const pad = { deviceId: 'hid-4', name: '', vendorId: 7, productId: 7, guid: 'pad-guid' };
  const reported = ({ deviceId, ...device }) => (device.name ? device : { ...device, serialNumber: undefined });
  const request = (deviceList) => {
    const outcome = { prevented: false, calls: [] };
    session.emit(
      'select-hid-device',
      { preventDefault: () => (outcome.prevented = true) },
      { deviceList, frame },
      (...args) => outcome.calls.push(args)
    );
    return outcome;
  };
  const granted = (device, origin = 'https://launcher.test') =>
    handlers.device({ deviceType: 'hid', origin, device: reported(device) });

  // Off (the default): the page cannot use HID and a request is refused unasked.
  assert.equal(handlers.check(guest, 'hid', 'https://launcher.test', {}), false);
  const off = request([keyboard]);
  assert.deepEqual([off.prevented, off.calls], [true, [[]]]);
  assert.equal(permissions.pending(guest), undefined);

  setting.on = true;
  assert.equal(handlers.check(guest, 'hid', 'https://launcher.test', {}), true);
  const asked = request([keyboard]);
  assert.deepEqual(asked.calls, [], 'the request waits for a person');
  const shown = permissions.pending(guest);
  assert.deepEqual(shown, {
    id: shown.id,
    origin: 'https://launcher.test',
    keys: ['hid'],
    devices: [{ id: 'hid-1', name: 'Keyboard' }],
  });
  session.emit('hid-device-added', {}, { device: deck, frame });
  session.emit('hid-device-removed', {}, { device: keyboard, frame });
  assert.deepEqual(permissions.pending(guest).devices, [{ id: 'hid-2', name: 'Stream Deck' }], 'kept current');
  assert.equal(permissions.answer(guest, shown.id, true), false, 'allowing needs a device');
  assert.equal(permissions.answer(guest, shown.id, true, 'hid-1'), false, 'only a device still offered');
  assert.equal(granted(deck), false, 'nothing is granted before the pick');
  assert.equal(permissions.answer(guest, shown.id, true, 'hid-2'), true);
  assert.deepEqual(asked.calls, [['hid-2']]);
  assert.equal(permissions.pending(guest), undefined);
  assert.equal(granted(deck), true, 'the picked device is granted to that site');
  assert.equal(granted(keyboard), false, 'another device is not');
  assert.equal(granted(otherDeck), false, 'another unit of the same model is not');
  assert.equal(granted(deck, 'https://other.test'), false, 'another site is not');
  assert.equal(
    handlers.device({ deviceType: 'hid', origin: 'https://launcher.test', device: { vendorId: 4057, productId: 96 } }),
    false,
    'vendor and product alone grant nothing'
  );

  // A device without a serial number is identified by its guid.
  const padAsked = request([pad]);
  session.emit('hid-device-added', {}, { device: otherDeck, frame });
  assert.equal(permissions.answer(guest, permissions.pending(guest).id, true, 'hid-3'), true, 'a hot-added pick');
  assert.deepEqual(padAsked.calls, [['hid-3']]);
  assert.equal(granted(otherDeck), true, 'a device added while the chooser was open is granted');
  assert.equal(granted(deck), true);
  const padPicked = request([pad]);
  permissions.answer(guest, permissions.pending(guest).id, true, 'hid-4');
  assert.deepEqual(padPicked.calls, [['hid-4']]);
  assert.equal(granted(pad), true, 'a device without a serial is granted by guid');
  assert.equal(granted({ ...pad, guid: 'other-guid' }), false);
  assert.equal(handlers.device({ deviceType: 'usb', origin: 'https://launcher.test', device: deck }), false);

  // A pick is never remembered as a site decision: the next request asks again.
  const cancelled = request([keyboard]);
  permissions.answer(guest, permissions.pending(guest).id, false);
  assert.deepEqual(cancelled.calls, [[undefined]]);
  const navigated = request([keyboard]);
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(navigated.calls, [[undefined]], 'a navigation withdraws the chooser');

  // Turning the setting off withdraws the grants it allowed.
  setting.on = false;
  assert.equal(granted(deck), false);
  // Disposing the browser cancels a chooser still waiting, once.
  setting.on = true;
  const waiting = request([keyboard]);
  permissions.uninstall(session);
  assert.deepEqual(waiting.calls, [[undefined]]);
  assert.equal(permissions.pending(guest), undefined);
  assert.equal(session.listenerCount('select-hid-device'), 0);
  assert.equal(handlers.device, null);
});

test('only a blocked or refused permission reads as refused to a page', () => {
  const { permissions, page, ask } = fixture();
  const guest = page('https://site.test/');
  assert.equal(permissions.refused('https://site.test', 'audio_capture'), false, 'undecided');
  ask(guest, 'media', { mediaTypes: ['audio'] });
  permissions.answer(guest, permissions.pending(guest).id, false);
  assert.equal(permissions.refused('https://site.test', 'audio_capture'), true);
  assert.equal(permissions.refused('https://other.test', 'audio_capture'), false);
  assert.equal(permissions.refused('https://site.test', 'video_capture'), false);
  assert.equal(permissions.refused('https://site.test', 'notifications'), true, 'blocked by default');
});

function policyFixture() {
  const store = { policy: defaultBrowserPermissionPolicy(), saves: 0 };
  const f = fixture({
    policy: () => store.policy,
    save: (next) => {
      store.policy = next;
      store.saves += 1;
    },
  });
  return { ...f, store };
}

test('defaults apply silently: notifications and location blocked, clipboard write allowed', async () => {
  const { handlers, permissions, page, ask, settled } = policyFixture();
  const guest = page('https://site.test/');
  assert.equal(ask(guest, 'notifications').granted, false);
  assert.equal(ask(guest, 'geolocation').granted, false);
  const write = ask(guest, 'clipboard-sanitized-write');
  await settled();
  assert.equal(write.granted, true);
  assert.equal(permissions.pending(guest), undefined, 'no prompt for any of them');
  assert.equal(handlers.check(guest, 'notifications', 'https://site.test', {}), false);
  assert.equal(ask(guest, 'media', { mediaTypes: ['video'] }).granted, undefined, 'camera asks');
  assert.deepEqual(permissions.pending(guest).keys, ['media:video']);
});

test('remember for all sites sets the default and persists; for this site, an exception that wins', () => {
  const { handlers, permissions, page, ask, store } = policyFixture();
  const guest = page('https://site.test/');
  const first = ask(guest, 'media', { mediaTypes: ['audio'] });
  assert.equal(permissions.answer(guest, permissions.pending(guest).id, true, undefined, 'all'), true);
  assert.equal(first.granted, true);
  assert.equal(store.policy.defaults['media:audio'], 'allow');
  assert.equal(store.saves, 1);
  const other = page('https://other.test/');
  assert.equal(ask(other, 'media', { mediaTypes: ['audio'] }).granted, true, 'any site, no prompt');
  assert.equal(handlers.check(other, 'media', 'https://other.test', { mediaType: 'audio' }), true);

  // A site exception beats the default, in both directions.
  const camera = ask(guest, 'media', { mediaTypes: ['video'] });
  permissions.answer(guest, permissions.pending(guest).id, false, undefined, 'site');
  assert.equal(camera.granted, false);
  assert.deepEqual(store.policy.sites, [
    { origin: 'https://site.test', permission: 'media:video', setting: 'block' },
  ]);
  store.policy = withBrowserPermissionDefault(store.policy, 'media:video', 'allow');
  assert.equal(ask(guest, 'media', { mediaTypes: ['video'] }).granted, false, 'exception over default');
  assert.equal(ask(other, 'media', { mediaTypes: ['video'] }).granted, true);
  store.policy = withBrowserPermissionDefault(store.policy, 'notifications', 'allow');
  store.policy = withBrowserPermissionSite(store.policy, {
    origin: 'https://site.test',
    permission: 'notifications',
    setting: 'block',
  });
  assert.equal(ask(guest, 'notifications').granted, false);
  assert.equal(ask(other, 'notifications').granted, true);
});

test('a full exception list refuses a new site and never drops an existing block', () => {
  const { handlers, permissions, page, ask, store } = policyFixture();
  store.policy = withBrowserPermissionDefault(store.policy, 'media:video', 'allow');
  store.policy = withBrowserPermissionSite(store.policy, {
    origin: 'https://blocked.test',
    permission: 'media:video',
    setting: 'block',
  });
  for (let index = 1; store.policy.sites.length < BROWSER_PERMISSION_MAX_SITES; index += 1) {
    store.policy = withBrowserPermissionSite(store.policy, {
      origin: `https://s${index}.test`,
      permission: 'midi',
      setting: 'allow',
    });
  }
  assert.equal(store.policy.sites.length, BROWSER_PERMISSION_MAX_SITES);
  const extra = { origin: 'https://new.test', permission: 'midi', setting: 'allow' };
  assert.equal(withBrowserPermissionSite(store.policy, extra), null, 'refused at capacity');
  assert.ok(withBrowserPermissionSite(store.policy, { ...store.policy.sites[1], setting: 'block' }), 'edit in place');
  const before = store.policy;
  const guest = page('https://new.test/');
  const asked = ask(guest, 'midi');
  assert.equal(permissions.pending(guest).siteListFull, true, 'the prompt says the list is full');
  const promptId = permissions.pending(guest).id;
  assert.throws(() => permissions.answer(guest, promptId, true, undefined, 'site'), /exception list is full/);
  assert.equal(asked.granted, undefined, 'the answer is rejected, not downgraded to until-quit');
  assert.equal(permissions.pending(guest).id, promptId, 'the prompt stays open');
  assert.equal(store.policy, before, 'nothing persisted');
  assert.equal(store.saves, 0);
  assert.equal(permissions.answer(guest, promptId, true, undefined, 'all'), true, 'other choices still work');
  assert.equal(asked.granted, true);  assert.equal(ask(page('https://blocked.test/'), 'media', { mediaTypes: ['video'] }).granted, false);
  assert.equal(handlers.check(page('https://blocked.test/'), 'media', 'https://blocked.test', { mediaType: 'video' }), false);
  assert.equal(normalizeBrowserPermissionPolicy(before).sites.length, BROWSER_PERMISSION_MAX_SITES, 'load keeps all');
  const over = { ...before, sites: [...before.sites, { ...extra }] };
  assert.equal(normalizeBrowserPermissionPolicy(over).sites.length, BROWSER_PERMISSION_MAX_SITES + 1, 'no truncation');
});

test('an answer without remember changes no saved setting', () => {
  const { permissions, page, ask, store } = policyFixture();
  const guest = page('https://site.test/');
  ask(guest, 'media', { mediaTypes: ['video'] });
  permissions.answer(guest, permissions.pending(guest).id, true);
  assert.equal(store.saves, 0);
  assert.deepEqual(store.policy, defaultBrowserPermissionPolicy());
});

test('settings survive a restart: the stored form reads back to the same policy', () => {
  const { permissions, page, ask, store } = policyFixture();
  const guest = page('https://site.test/', ['https://ad.test/x']);
  ask(guest, 'midi');
  permissions.answer(guest, permissions.pending(guest).id, true, undefined, 'all');
  const frame = ask(guest, 'media', { mediaTypes: ['video'] });
  permissions.answer(guest, permissions.pending(guest).id, true, undefined, 'site');
  assert.equal(frame.granted, true);
  const stored = JSON.parse(JSON.stringify(storableBrowserPermissionPolicy(store.policy)));
  assert.deepEqual(Object.keys(stored.defaults), ['midi'], 'only differences are stored');
  assert.deepEqual(normalizeBrowserPermissionPolicy(stored), store.policy);
  assert.deepEqual(normalizeBrowserPermissionPolicy({ defaults: { midi: 'maybe', bogus: 'allow' }, sites: [{}] }), defaultBrowserPermissionPolicy());
});

test('clipboard read is only ever allowed by an explicit remember, and still needs a gesture', async () => {
  const { handlers, permissions, page, ask, activation, settled, store } = policyFixture();
  const guest = page('https://site.test/');
  assert.equal(store.policy.defaults['clipboard-read'], 'ask');
  const first = ask(guest, 'clipboard-read');
  await settled();
  assert.equal(first.granted, undefined, 'asked, not granted by default');
  permissions.answer(guest, permissions.pending(guest).id, true);
  assert.equal(store.policy.defaults['clipboard-read'], 'ask', 'a plain answer does not change the default');
  const second = ask(guest, 'clipboard-read', { requestingUrl: 'https://site.test/' });
  await settled();
  assert.equal(second.granted, true, 'a plain answer lasted only this run, for this site');
  const stranger = page('https://other.test/');
  const third = ask(stranger, 'clipboard-read');
  await settled();
  assert.equal(third.granted, undefined, 'another site is still asked');
  permissions.answer(stranger, permissions.pending(stranger).id, true, undefined, 'all');
  assert.equal(third.granted, true);
  assert.equal(store.policy.defaults['clipboard-read'], 'allow');
  assert.equal(handlers.check(guest, 'clipboard-read', 'https://site.test', {}), false, 'never a standing check');
  activation.active = false;
  const idle = ask(guest, 'clipboard-read');
  await settled();
  assert.equal(idle.granted, false, 'even allowed everywhere, a gesture is needed');
});
