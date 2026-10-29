import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract.ts';
import { loginSiteLabel } from '../../shared/login-site.ts';
import { registerBrowserIpc } from '../ipc-browser.ts';
import { createTakeoverGate } from '../takeover-gate.ts';
import {
  LOGIN_AUTO_CLOSE_RULES,
  loginAutoClose,
  loginNavigationUrl,
  loginPopupBounds,
  loginRefusal,
  loginTakeoverOf,
  safeToReloadAfterSignIn,
} from './login-takeover.ts';

const login = {
  id: 't1',
  kind: 'takeover',
  takeover: {
    surface: 'browser',
    instructions: 'Sign in',
    purpose: 'login',
    url: 'https://a.example/login',
    tab: 'p1',
  },
};

test('only a takeover with the login purpose asks for the sign-in window; it never reveals the side panel', () => {
  assert.deepEqual(loginTakeoverOf({ toolApproval: login }), { id: 't1', url: 'https://a.example/login', tab: 'p1' });
  const plain = { ...login, id: 't2', takeover: { surface: 'browser', instructions: 'Solve the CAPTCHA' } };
  assert.equal(loginTakeoverOf({ toolApproval: plain }), null);
  assert.equal(loginTakeoverOf({ toolApproval: { ...login, kind: 'approval' } }), null);
  assert.equal(loginTakeoverOf({ toolApproval: null }), null);
  // index.ts: the gate still holds a login takeover (agent stopped), but only
  // a non-login browser takeover goes on to open the panel.
  const gate = createTakeoverGate(async (work) => work());
  const reveals = [];
  for (const approval of [login, null, plain]) {
    const snapshot = { toolApproval: approval };
    const surface = gate.onSessionState({ sessionId: 's1', snapshot });
    if (surface === 'browser' && !loginTakeoverOf(snapshot)) reveals.push(approval.id);
  }
  assert.deepEqual(reveals, ['t2']);
  gate.dispose();
});

test('the window shows HTTPS pages only (loopback excepted) under the Browser Use URL policy', () => {
  assert.equal(loginNavigationUrl('https://accounts.example.com/x', {}), 'https://accounts.example.com/x');
  assert.equal(loginNavigationUrl('http://127.0.0.1:5000/login', {}), 'http://127.0.0.1:5000/login');
  assert.equal(loginNavigationUrl('http://localhost:5000/', {}), 'http://localhost:5000/');
});

test('the card names a sign-in site by its registrable domain (public suffix list)', () => {
  for (const [url, site] of [
    ['https://accounts.example.com/login', 'example.com'],
    ['https://www.example.com/', 'example.com'],
    ['https://nid.naver.co.kr/login', 'naver.co.kr'],
    ['https://a.b.example.co.kr/', 'example.co.kr'],
    ['https://user.github.io/app', 'user.github.io'],
    ['https://login.user.github.io/', 'user.github.io'],
    ['https://accounts.google.co.uk/', 'google.co.uk'],
    ['http://127.0.0.1:5077/login', '127.0.0.1'],
    ['http://[::1]:5077/', '[::1]'],
    ['http://localhost:5000/', 'localhost'],
  ]) {
    assert.equal(loginSiteLabel(url), site, url);
  }
  assert.throws(() => loginNavigationUrl('http://example.com/login', {}), /HTTPS/);
  assert.throws(() => loginNavigationUrl('file:///etc/passwd', {}), /http\(s\)/);
  assert.throws(() => loginNavigationUrl('https://169.254.169.254/', {}), /metadata/);
  assert.throws(() => loginNavigationUrl('https://u:p@example.com/', {}), /credentials/);
  assert.throws(() => loginNavigationUrl('https://other.test/', { allowedDomains: ['example.com'] }), /domain policy/);
});

test('auto close needs an explicit trusted rule; none ship, and a rule never fires on http', () => {
  assert.equal(loginAutoClose('https://a.example/home', LOGIN_AUTO_CLOSE_RULES), false);
  const rules = [{ host: 'a.example', signedIn: (url) => url.pathname === '/home' }];
  assert.equal(loginAutoClose('https://a.example/home', rules), true);
  assert.equal(loginAutoClose('https://a.example/login', rules), false);
  assert.equal(loginAutoClose('http://a.example/home', rules), false);
  assert.equal(loginRefusal('https://accounts.google.com/v3/signin/rejected?hl=ko'), 'Google');
  assert.equal(loginRefusal('https://accounts.google.com/signin/rejected'), 'Google');
  assert.equal(loginRefusal('https://accounts.google.com/v3/signin/identifier'), '');
});

test('the window is about 480×720, centred on Mixdog and kept inside the work area', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(loginPopupBounds({ x: 100, y: 100, width: 1200, height: 800 }, work), {
    x: 460,
    y: 140,
    width: 480,
    height: 720,
  });
  // Mixdog at the screen's edge: the window stays on screen.
  assert.deepEqual(loginPopupBounds({ x: 1700, y: 900, width: 400, height: 300 }, work), {
    x: 1440,
    y: 320,
    width: 480,
    height: 720,
  });
  assert.deepEqual(loginPopupBounds(null, { x: 0, y: 0, width: 1280, height: 600 }), {
    x: 400,
    y: 0,
    width: 480,
    height: 600,
  });
});

test("the agent's page reloads after a sign-in only with nothing typed, edited or posted", () => {
  const page = { userInput: false, editedFields: false, documentMethod: 'GET' };
  assert.equal(safeToReloadAfterSignIn(page), true);
  assert.equal(safeToReloadAfterSignIn({ ...page, userInput: true }), false);
  assert.equal(safeToReloadAfterSignIn({ ...page, editedFields: true }), false);
  assert.equal(safeToReloadAfterSignIn({ ...page, documentMethod: 'POST' }), false);
  assert.equal(safeToReloadAfterSignIn({ ...page, documentMethod: '' }), false, 'unknown is not safe');
});

test('IPC: open and status are bound to a session and a takeover id; anything else is refused', async () => {
  const handlers = new Map();
  const calls = [];
  registerBrowserIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    browserLogin: {
      open: async (...args) => {
        calls.push(['open', ...args]);
        return { state: 'done' };
      },
      status: (...args) => {
        calls.push(['status', ...args]);
        return { state: 'idle' };
      },
    },
  });
  const call = (channel, ...args) => handlers.get(channel)({}, ...args);
  assert.deepEqual(await call(DESKTOP_IPC.browserLoginOpen, 'sess_1', 't1'), { state: 'done' });
  assert.deepEqual(await call(DESKTOP_IPC.browserLoginStatus, 'sess_1', 't1'), { state: 'idle' });
  assert.deepEqual(calls, [
    ['open', 'sess_1', 't1'],
    ['status', 'sess_1', 't1'],
  ]);
  await assert.rejects(async () => call(DESKTOP_IPC.browserLoginOpen, 'sess_1', { url: 'https://evil' }), /invalid/i);
  await assert.rejects(async () => call(DESKTOP_IPC.browserLoginOpen, '', 't1'));
  const bare = new Map();
  registerBrowserIpc({ handle: (channel, fn) => bare.set(channel, fn) });
  await assert.rejects(async () => bare.get(DESKTOP_IPC.browserLoginOpen)({}, 'sess_1', 't1'), /unavailable/);
});
