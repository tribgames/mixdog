import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from 'node:events';
import { clearBrowserPermissionHandlers, createBrowserPermissions } from './permissions.ts';

function fixture() {
  const handlers = {};
  const session = {
    setPermissionCheckHandler(handler) {
      handlers.check = handler;
    },
    setPermissionRequestHandler(handler) {
      handlers.request = handler;
    },
    setDevicePermissionHandler(handler) {
      handlers.device = handler;
    },
  };
  const activation = { active: true, asked: [] };
  const permissions = createBrowserPermissions({
    userActivation: async (frames) => {
      activation.asked.push(frames.map((frame) => frame.url));
      return activation.active;
    },
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
  for (const refused of ['openExternal', 'display-capture', 'fullscreen', 'pointerLock', 'unknown']) {
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
  const first = ask(guest, 'notifications');
  const again = ask(guest, 'notifications');
  const location = ask(guest, 'geolocation');
  assert.deepEqual(permissions.pending(guest).keys, ['notifications']);
  permissions.answer(guest, permissions.pending(guest).id, false);
  assert.deepEqual([first.granted, again.granted], [false, false]);
  assert.equal(ask(guest, 'notifications').granted, false, 'a refusal is not asked again');
  assert.deepEqual(permissions.pending(guest).keys, ['geolocation']);
  assert.equal(location.granted, undefined);
  assert.equal(ask(page('https://other.test/'), 'notifications').granted, undefined, 'another site is asked');
  assert.equal(handlers.check(guest, 'notifications', 'https://site.test', {}), false);
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
  const a = askFrame(top, 'geolocation', 'https://a.test/');
  const b = askFrame(top, 'notifications', 'https://b.test/');
  top.emit('did-start-navigation', {
    isMainFrame: false,
    isSameDocument: false,
    frame: top.mainFrame.framesInSubtree[2],
  });
  assert.equal(b.granted, false, 'the navigating frame lost its prompt');
  assert.equal(a.granted, undefined);
  assert.deepEqual(permissions.pending(top).keys, ['geolocation']);
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

test('Chrome defaults hold without a prompt: protected media', () => {
  const { handlers, page, ask } = fixture();
  const guest = page('https://site.test/');
  assert.equal(handlers.check(guest, 'mediaKeySystem', 'https://site.test', {}), true);
  assert.equal(ask(guest, 'mediaKeySystem').granted, true);
});

test('only a person refusal reads as refused to a page', () => {
  const { permissions, page, ask } = fixture();
  const guest = page('https://site.test/');
  ask(guest, 'notifications');
  assert.equal(permissions.refused('https://site.test', 'notifications'), false, 'undecided');
  permissions.answer(guest, permissions.pending(guest).id, false);
  assert.equal(permissions.refused('https://site.test', 'notifications'), true);
  assert.equal(permissions.refused('https://other.test', 'notifications'), false);
  assert.equal(permissions.refused('https://site.test', 'geolocation'), false);
});
