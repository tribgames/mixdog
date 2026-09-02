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
  redactBrowserKnownSecrets,
  redactBrowserUrl,
  selectAndRefreshActiveBrowserGuest,
  selectActiveBrowserGuest,
} from './host-policy.ts';
import { createBrowserCommandQueue } from './command-queue.ts';
import { BROWSER_CREDENTIAL_AUTOFILL_FUNCTION } from './credential-autofill.ts';
import { createBrowserUrlAdmission } from './url-admission.ts';
import { createBrowserInitScripts } from './init-scripts.ts';
import { createBrowserEmulation } from './emulation.ts';

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

test('focused browser guest selection follows explicit activity without arbitrary fallback', () => {
  const alpha = { id: 1, destroyed: false, isDestroyed() { return this.destroyed; } };
  const beta = { id: 2, destroyed: false, isDestroyed() { return this.destroyed; } };
  const guests = new Set([alpha, beta]);
  let current = selectActiveBrowserGuest(guests, null, alpha.id, true);
  assert.equal(current, alpha);
  current = selectActiveBrowserGuest(guests, current, beta.id, false);
  assert.equal(current, alpha);
  current = selectActiveBrowserGuest(guests, current, beta.id, true);
  assert.equal(current, beta);
  current = selectActiveBrowserGuest(guests, current, beta.id, false);
  assert.equal(current, null);
  current = selectActiveBrowserGuest(guests, current, 999, true);
  assert.equal(current, null);
  alpha.destroyed = true;
  current = selectActiveBrowserGuest(guests, alpha, beta.id, false);
  assert.equal(current, null);
});

test('active browser guest repaints on activation and foreground return', () => {
  const alpha = {
    id: 1,
    destroyed: false,
    repaints: 0,
    isDestroyed() { return this.destroyed; },
    invalidate() { this.repaints += 1; },
  };
  const beta = {
    id: 2,
    destroyed: false,
    repaints: 0,
    isDestroyed() { return this.destroyed; },
    invalidate() { this.repaints += 1; },
  };
  const guests = new Set([alpha, beta]);
  let current = selectAndRefreshActiveBrowserGuest(guests, null, alpha.id, true);
  assert.equal(current, alpha);
  assert.equal(alpha.repaints, 1);

  current = selectAndRefreshActiveBrowserGuest(guests, current, alpha.id, true);
  assert.equal(current, alpha);
  assert.equal(alpha.repaints, 2);

  current = selectAndRefreshActiveBrowserGuest(guests, current, beta.id, false);
  assert.equal(current, alpha);
  assert.equal(beta.repaints, 0);

  current = selectAndRefreshActiveBrowserGuest(guests, current, beta.id, true);
  assert.equal(current, beta);
  assert.equal(beta.repaints, 1);
});

test('queued Browser Use commands release immediately when cancelled before dispatch', async () => {
  let releasePrevious;
  const previous = new Promise((resolve) => {
    releasePrevious = resolve;
  });
  const chains = new Map([['foreground', previous]]);
  let dispatches = 0;
  const queue = createBrowserCommandQueue({
    chains,
    pendingReads: new Map(),
    backgroundEntryByPageId: () => null,
    run: async () => {
      dispatches += 1;
      return { text: 'unexpected' };
    },
    bounded: async (operation) => await operation,
    readOnlyActions: new Set(),
    commandTimeoutMs: 45_000,
  });
  const controller = new AbortController();
  const pending = queue.executeSerialized({ action: 'open' }, controller.signal);
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(pending, /fixture cancelled/);
  assert.equal(dispatches, 0);
  const next = queue.executeSerialized({ action: 'open' });
  await Promise.resolve();
  assert.equal(dispatches, 0);
  releasePrevious();
  await next;
  assert.equal(dispatches, 1);
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
  assert.throws(() => normalizePageUrl('file:///C:/Users/example/secrets.txt'), /only http\(s\)/);
});

test('browser URL admission rechecks completed DNS answers and coalesces only concurrent lookups', async () => {
  let calls = 0;
  let releaseFirst;
  const firstLookup = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const admission = createBrowserUrlAdmission({
    policy: {},
    lookupAddresses: async () => {
      calls += 1;
      if (calls === 1) {
        await firstLookup;
        return [{ address: '93.184.216.34' }];
      }
      return [{ address: '192.168.1.10' }];
    },
  });
  const first = admission.assertResolvedUrlAllowed('https://rebind.example.test/');
  const concurrent = admission.assertResolvedUrlAllowed('https://rebind.example.test/image.png');
  releaseFirst();
  await Promise.all([first, concurrent]);
  assert.equal(calls, 1, 'concurrent requests should share one DNS lookup');

  await assert.rejects(
    admission.assertResolvedUrlAllowed('https://rebind.example.test/private'),
    /resolved to blocked private or internal address 192\.168\.1\.10/,
  );
  await admission.assertResolvedUrlAllowed('http://[::1]:8080/fixture');
  assert.equal(calls, 2, 'a later request must recheck DNS after the first lookup completed');

  const unresolved = createBrowserUrlAdmission({
    policy: {},
    lookupAddresses: async () => {
      throw new Error('fixture DNS failure');
    },
  });
  await assert.rejects(
    unresolved.assertResolvedUrlAllowed('https://unresolved.example.test/'),
    /could not be resolved for private-network validation/,
  );

  let releasePending;
  const pendingLookup = new Promise((resolve) => {
    releasePending = resolve;
  });
  const bounded = createBrowserUrlAdmission({
    policy: {},
    maxPendingResolutions: 1,
    lookupAddresses: async () => {
      await pendingLookup;
      return [{ address: '93.184.216.34' }];
    },
  });
  const occupied = bounded.assertResolvedUrlAllowed('https://one.example.test/');
  await assert.rejects(
    bounded.assertResolvedUrlAllowed('https://two.example.test/'),
    /too many concurrent browser DNS validations/,
  );
  releasePending();
  await occupied;

  const socketAdmission = createBrowserUrlAdmission({
    policy: {},
    lookupAddresses: async () => [{ address: '93.184.216.34' }],
  });
  await socketAdmission.assertResolvedResourceUrlAllowed('wss://socket.example.test/live');
  await assert.rejects(
    socketAdmission.assertResolvedResourceUrlAllowed('ws://169.254.169.254/latest/meta-data'),
    /cloud metadata endpoints is blocked/,
  );
});

test('init script clear preserves only transient failures so cleanup can be retried', async () => {
  const guest = {};
  let identifier = 0;
  let failSecondRemoval = true;
  const scripts = createBrowserInitScripts({
    guestDebugger: async () => ({}),
    cdpTimeoutMs: 100,
    sendCdp: async (_guest, _cdp, method, params) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        identifier += 1;
        return { identifier: `cdp-${identifier}` };
      }
      if (params.identifier === 'cdp-2' && failSecondRemoval) {
        throw new Error('fixture transient failure');
      }
      return {};
    },
  });
  await scripts.initScriptResult(guest, { operation: 'add', script: 'window.one = 1;' });
  await scripts.initScriptResult(guest, { operation: 'add', script: 'window.two = 2;' });
  await assert.rejects(
    scripts.initScriptResult(guest, { operation: 'clear' }),
    /1 could not be removed; retry clear/,
  );
  const remaining = await scripts.initScriptResult(guest, { operation: 'list' });
  assert.doesNotMatch(remaining.text, /\[is1\]/);
  assert.match(remaining.text, /\[is2\]/);

  failSecondRemoval = false;
  assert.match(
    (await scripts.initScriptResult(guest, { operation: 'clear' })).text,
    /Removed 1 init script/,
  );
});

test('emulation validates compound input before attaching CDP or partially resetting the page', async () => {
  let debuggerCalls = 0;
  let cdpCalls = 0;
  const emulation = createBrowserEmulation({
    guestDebugger: async () => {
      debuggerCalls += 1;
      return {};
    },
    sendCdp: async () => {
      cdpCalls += 1;
      return {};
    },
    invalidateInteractionState() {},
    snapshotResult: async () => ({ text: 'fixture snapshot' }),
    cdpTimeoutMs: 100,
  });
  const guest = {};
  await assert.rejects(
    emulation.applyEmulation(guest, { reset: true, width: 390 }),
    /requires width and height together/,
  );
  await assert.rejects(
    emulation.applyEmulation(guest, {
      width: 390,
      height: 844,
      networkProfile: 'satellite',
    }),
    /networkProfile must be none, offline, slow3g, or fast3g/,
  );
  await assert.rejects(
    emulation.applyEmulation(guest, { latitude: 37.5 }),
    /latitude and longitude together/,
  );
  await assert.rejects(
    emulation.applyEmulation(guest, { reset: true, timezone: 'Not/A_Real_Zone' }),
    /timezone must be a valid IANA timezone/,
  );
  assert.equal(debuggerCalls, 0);
  assert.equal(cdpCalls, 0);
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
  assert.doesNotMatch(
    redactBrowserText('{"access_token":"opaque-value","name":"safe"}'),
    /opaque-value/,
  );
  assert.doesNotMatch(
    redactBrowserUrl('https://example.test/callback?code=opaque-code&state=public'),
    /opaque-code/,
  );
});

test('known browser credential redaction never amplifies short secrets', () => {
  const source = 'a password can be short: a';
  const redacted = redactBrowserKnownSecrets(source, ['a', '*']);
  assert.equal(redacted.includes('a'), false);
  assert.ok(redacted.length <= source.length);
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
      + `<div id="custom" role="button" aria-expanded="${'expanded '.repeat(100)}">Custom</div><div id="host"></div>`,
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
    const custom = payload.elements.find((entry) => entry.name === 'Custom');
    assert.ok(custom.states.every((state) => state.length <= 89));
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
