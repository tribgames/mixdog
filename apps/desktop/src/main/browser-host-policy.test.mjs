import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  assertBackgroundTabCapacity,
  backgroundPageIdle,
  BACKGROUND_PAGE_IDLE_MS,
  browserUrlContainsSecret,
  browserRefPointExpression,
  browserSnapshotExpression,
  MAX_BACKGROUND_TABS,
  normalizeAgentUrl,
  normalizePageUrl,
  normalizeBackgroundTabName,
  redactBrowserText,
} from './browser-host-policy.ts';
import { BROWSER_CREDENTIAL_AUTOFILL_FUNCTION } from './browser-credential-autofill.ts';

test('background browser tab names are bounded and cannot impersonate visible tabs', () => {
  assert.equal(normalizeBackgroundTabName(''), 'bg');
  assert.equal(normalizeBackgroundTabName(' research '), 'research');
  assert.throws(
    () => normalizeBackgroundTabName('', { required: true }),
    /background tab name is required/,
  );
  assert.throws(() => normalizeBackgroundTabName('v2'), /reserved p1\/p2.*v1\/v2/);
  assert.throws(() => normalizeBackgroundTabName('p2'), /reserved p1\/p2/);
  assert.throws(() => normalizeBackgroundTabName('bad\nname'), /control characters/);
  assert.throws(() => normalizeBackgroundTabName('x'.repeat(65)), /64 characters/);
  assert.doesNotThrow(() => assertBackgroundTabCapacity(MAX_BACKGROUND_TABS - 1));
  assert.throws(() => assertBackgroundTabCapacity(MAX_BACKGROUND_TABS), /close_tab/);
});

test('background browser pages become reclaimable only after the idle deadline', () => {
  const lastUsedAt = 1_000;
  assert.equal(backgroundPageIdle(lastUsedAt, lastUsedAt + BACKGROUND_PAGE_IDLE_MS - 1), false);
  assert.equal(backgroundPageIdle(lastUsedAt, lastUsedAt + BACKGROUND_PAGE_IDLE_MS), true);
});

function refPointHarness() {
  const dom = new JSDOM(
    '<!doctype html><button id="target"><span id="child">Run</span></button>'
      + '<div id="ancestor"><span id="nested">Nested target</span></div>'
      + '<a id="link" href="/destination">Destination</a>'
      + '<a id="equivalent" href="/destination">Destination duplicate</a>'
      + '<div id="overlay">Blocking dialog</div>',
    { runScripts: 'outside-only', url: 'https://example.test/' },
  );
  const { window } = dom;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  const target = window.document.querySelector('#target');
  const child = window.document.querySelector('#child');
  const ancestor = window.document.querySelector('#ancestor');
  const nested = window.document.querySelector('#nested');
  const link = window.document.querySelector('#link');
  const equivalent = window.document.querySelector('#equivalent');
  const overlay = window.document.querySelector('#overlay');
  target.scrollIntoView = () => {};
  target.getBoundingClientRect = () => ({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 110,
    bottom: 60,
    width: 100,
    height: 40,
    toJSON() { return this; },
  });
  window.__mixdogAgentSnapshot = {
    id: 'p1-s1',
    refs: new Map([['p1-s1-e1', { element: target, frames: [] }]]),
  };
  return { dom, window, target, child, ancestor, nested, link, equivalent, overlay };
}

test('browser ref clicks accept the target tree, reject overlays, and never alias generations', async () => {
  const harness = refPointHarness();
  try {
    harness.window.document.elementFromPoint = () => harness.child;
    const point = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(point.x, 60);
    assert.equal(point.y, 40);

    harness.window.__mixdogAgentSnapshot = {
      id: 'p1-s1',
      refs: new Map([['p1-s1-e1', { element: harness.nested, frames: [] }]]),
    };
    harness.nested.scrollIntoView = () => {};
    harness.nested.getBoundingClientRect = harness.target.getBoundingClientRect;
    harness.window.document.elementFromPoint = () => harness.ancestor;
    const arbitraryAncestor = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(arbitraryAncestor.error, 'covered');

    harness.window.__mixdogAgentSnapshot = {
      id: 'p1-s1',
      refs: new Map([['p1-s1-e1', { element: harness.link, frames: [] }]]),
    };
    harness.link.scrollIntoView = () => {};
    harness.link.getBoundingClientRect = harness.target.getBoundingClientRect;
    harness.window.document.elementFromPoint = () => harness.equivalent;
    const equivalent = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(equivalent.x, 60);
    assert.equal(equivalent.y, 40);

    harness.window.__mixdogAgentSnapshot = {
      id: 'p1-s1',
      refs: new Map([['p1-s1-e1', { element: harness.target, frames: [] }]]),
    };
    harness.window.document.elementFromPoint = () => harness.overlay;
    const covered = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(covered.error, 'covered');
    assert.match(covered.covering, /Blocking dialog/);

    harness.window.__mixdogAgentSnapshot = {
      id: 'p1-s2',
      refs: new Map([['p1-s2-e1', { element: harness.overlay, frames: [] }]]),
    };
    const stale = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(stale.error, 'stale');
  } finally {
    harness.dom.window.close();
  }
});

test('browser URL policy blocks credentials, metadata, and private networks but keeps loopback', () => {
  assert.equal(normalizeAgentUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeAgentUrl('http://localhost:3000/app'), 'http://localhost:3000/app');
  assert.throws(() => normalizeAgentUrl('https://user:pass@example.com'), /embedded credentials/);
  assert.throws(() => normalizeAgentUrl('http://169.254.169.254/latest/meta-data'), /metadata/);
  assert.throws(() => normalizeAgentUrl('http://192.168.1.1'), /private or internal/);
  assert.throws(
    () => normalizeAgentUrl('https://example.com/collect?token=plain-secret'),
    /credential-like/,
  );
  assert.throws(
    () => normalizeAgentUrl('https://example.com/collect/sk%2Dproj%2Dabcdefghijklmnop'),
    /secret tokens/,
  );
  assert.equal(
    normalizeAgentUrl('http://localhost:3000/callback?token=local-development'),
    'http://localhost:3000/callback?token=local-development',
  );
  assert.equal(
    normalizeAgentUrl('http://192.168.1.1', { allowPrivateNetwork: true }),
    'http://192.168.1.1/',
  );
  assert.throws(
    () => normalizeAgentUrl('https://example.net', { allowedDomains: ['example.com', '*.trusted.test'] }),
    /domain policy/,
  );
  assert.equal(
    normalizePageUrl('https://example.com/product?dib=eyJ2IjoiMSJ9.long.site.token'),
    'https://example.com/product?dib=eyJ2IjoiMSJ9.long.site.token',
  );
  assert.throws(() => normalizePageUrl('https://user:pass@example.com'), /embedded credentials/);
  assert.throws(() => normalizePageUrl('http://169.254.169.254/latest/meta-data'), /metadata/);
});

test('browser URL secret detection covers encoded token shapes without blocking ordinary keys', () => {
  assert.equal(browserUrlContainsSecret('https://example.com/?api_key=value'), true);
  assert.equal(
    browserUrlContainsSecret('https://example.com/%67%68%70%5Fabcdefghijklmnopqrstuvwxyz'),
    true,
  );
  assert.equal(browserUrlContainsSecret('https://example.com/docs?key=keyboard'), false);
});

test('browser output redacts URL credentials and common token shapes', () => {
  const redacted = redactBrowserText(
    'https://alice:secret@example.com/?access_token=abc123 sk-proj-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz',
  );
  assert.doesNotMatch(redacted, /secret|abc123|abcdefghijklmnop|ghp_/);
  assert.match(redacted, /\[REDACTED/);
});

test('DOM fallback semantic query ignores URL search parameters and reports the matched field', () => {
  const dom = new JSDOM(`<!doctype html>
    <a id="signin" href="/login?return_to=%2Fissues%3Fq%3Ddownload">Sign in</a>
    <button id="named">Download report</button>
    <a id="path" href="/downloads/latest?token=tracking">Release asset</a>
    <input id="search-value" type="search" aria-label="Issue search" value="download">
    <div id="focusable-wrapper" role="listitem" tabindex="0">Download report</div>
    <a id="named-link" href="/downloads/report">Download report</a>`, {
    url: 'https://example.test/issues?q=download',
    runScripts: 'outside-only',
  });
  try {
    for (const [index, element] of [...dom.window.document.querySelectorAll('a,button,input,[role="listitem"]')].entries()) {
      element.getBoundingClientRect = () => ({
        left: 10,
        top: 10 + index * 30,
        right: 110,
        bottom: 30 + index * 30,
        width: 100,
        height: 20,
        x: 10,
        y: 10 + index * 30,
        toJSON() { return this; },
      });
    }
    const payload = dom.window.eval(browserSnapshotExpression({
      snapshotId: 'p3-s1',
      query: 'download',
      maxElements: 20,
    }));
    assert.deepEqual(
      Array.from(payload.elements, (entry) => [entry.role, entry.name, entry.matchField]),
      [
        ['link', 'Download report', 'name'],
        ['button', 'Download report', 'name'],
        ['listitem', 'Download report', 'name'],
        ['link', 'Release asset', 'href'],
        ['searchbox', 'Issue search', 'value'],
      ],
    );
  } finally {
    dom.window.close();
  }
});

test('semantic snapshots include shadow controls, omit password values, and bind generated refs', () => {
  const dom = new JSDOM(
    '<!doctype html><title>Demo</title><button id="plain">Run</button>'
      + '<label for="secret">Password</label><input id="secret" type="password" value="do-not-leak">'
      + '<div id="custom" role="button" aria-expanded="false">Custom</div><div id="host"></div>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/app' },
  );
  const { window } = dom;
  try {
    Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        const index = [...this.ownerDocument.querySelectorAll('*')].indexOf(this);
        return {
          left: 10,
          top: Math.max(0, index * 20),
          right: 130,
          bottom: Math.max(20, index * 20 + 20),
          width: 120,
          height: 20,
          x: 10,
          y: Math.max(0, index * 20),
          toJSON() { return this; },
        };
      },
    });
    const host = window.document.querySelector('#host');
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowButton = window.document.createElement('button');
    shadowButton.textContent = 'Shadow action';
    shadow.append(shadowButton);

    const payload = window.eval(browserSnapshotExpression({
      snapshotId: 'p7-s3',
      maxElements: 10,
      textChars: 500,
    }));
    assert.equal(payload.snapshotId, 'p7-s3');
    assert.ok(payload.elements.some((entry) => entry.name === 'Shadow action'));
    assert.ok(payload.elements.every((entry) => entry.ref.startsWith('p7-s3-e')));
    const password = payload.elements.find((entry) => entry.name === 'Password');
    assert.ok(password);
    assert.equal(password.sensitive, true);
    assert.equal(password.value, '');
    assert.doesNotMatch(JSON.stringify(payload), /do-not-leak/);
    assert.ok(window.__mixdogAgentSnapshot.refs.has(payload.elements[0].ref));
  } finally {
    dom.window.close();
  }
});

test('stored credential fill targets the current login form and emits framework events without returning secrets', async () => {
  const dom = new JSDOM(`<!doctype html>
    <form>
      <input id="identity" name="user_id" type="text">
      <input id="password" name="pw" type="password">
      <input id="new-password" type="password" autocomplete="new-password">
    </form>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://accounts.example.test/login',
  });
  try {
    const events = [];
    for (const input of dom.window.document.querySelectorAll('input')) {
      input.getBoundingClientRect = () => ({
        left: 10, top: 10, right: 210, bottom: 40,
        width: 200, height: 30, x: 10, y: 10,
        toJSON() { return this; },
      });
      input.addEventListener('input', () => events.push(`${input.id}:input`));
      input.addEventListener('change', () => events.push(`${input.id}:change`));
    }
    const fill = dom.window.eval(`(${BROWSER_CREDENTIAL_AUTOFILL_FUNCTION})`);
    const result = await fill({
      username: 'fixture-user',
      password: 'fixture-password',
    });
    assert.equal(dom.window.document.querySelector('#identity').value, 'fixture-user');
    assert.equal(dom.window.document.querySelector('#password').value, 'fixture-password');
    assert.equal(dom.window.document.querySelector('#new-password').value, '');
    assert.equal(result.usernameFilled, true);
    assert.equal(result.passwordFilled, true);
    assert.doesNotMatch(JSON.stringify(result), /fixture-user|fixture-password/);
    assert.deepEqual(events, [
      'identity:input',
      'identity:change',
      'password:input',
      'password:change',
    ]);
  } finally {
    dom.window.close();
  }
});
