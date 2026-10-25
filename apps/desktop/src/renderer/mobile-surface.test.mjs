import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  PROJECT_CATALOG_CACHE_KEY,
  acceptedProjectCatalog,
  readCachedProjectCatalog,
  resolveProjectPathAgainstCatalog,
  writeCachedProjectCatalog,
} from './project-catalog-cache.ts';
import { resolveUnreadViewedSessionId } from './app-unread-sessions.ts';

const bootSource = readFileSync(new URL('./public/boot.js', import.meta.url), 'utf8');

// Boot observers fire on the teardown mutations once the document is gone, so
// every window disconnects the ones its boot script registered before closing.
const bootObservers = new WeakMap();
function evalBoot(dom) {
  const observers = [];
  const NativeObserver = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends NativeObserver {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };
  bootObservers.set(dom, observers);
  dom.window.eval(bootSource);
}
function closeWindow(dom) {
  for (const observer of bootObservers.get(dom) ?? []) observer.disconnect();
  dom.window.close();
}
const mobileChromeSource = readFileSync(new URL('./desktop/07-mobile-chrome.css', import.meta.url), 'utf8');
const markdownSource = readFileSync(new URL('./desktop/22-markdown.css', import.meta.url), 'utf8');

test('phone draft context keeps Project and its height while Workflow loads', () => {
  const composer = readFileSync(new URL('./desktop/15-composer.css', import.meta.url), 'utf8');
  const dom = new JSDOM(`<!doctype html><html data-mixdog-mobile-tabs><head>
    <style>${composer}\n${mobileChromeSource}</style></head><body>
    <div class="composer-context-bar"><button>Project</button></div></body></html>`);
  try {
    const bar = dom.window.document.querySelector('.composer-context-bar');
    const before = dom.window.getComputedStyle(bar);
    // jsdom keeps var() unresolved; the real-browser 48px (36px pill + 12px
    // gap) is asserted in composer-island.slow.test.mjs at the phone size.
    assert.equal(before.minHeight, 'var(--island-rest-height)', 'the bar takes the island slot’s resting height');
    assert.match(
      composer,
      /html\[data-mixdog-mobile-tabs\] \.composer-region \{\s*--island-pill-height: 36px;\s*\}/,
      'the phone sets the pill height the slot and bar derive from'
    );
    assert.notEqual(before.opacity, '0');
    assert.notEqual(before.pointerEvents, 'none');
    const workflow = dom.window.document.createElement('div');
    workflow.className = 'composer-route-workflow';
    bar.append(workflow);
    assert.equal(dom.window.getComputedStyle(bar).minHeight, before.minHeight);
  } finally {
    closeWindow(dom);
  }
});

test('first-paint theme uses the same dark default and explicit System preference as App', async () => {
  for (const osLight of [false, true]) {
    for (const [preference, light, storageBlocked = false] of [
      [null, false],
      ['dark', false],
      ['gray', false],
      ['white', true],
      ['system', osLight],
      [null, false, true],
    ]) {
      const dom = new JSDOM(
        '<!doctype html><html><head><meta name="color-scheme" content="dark light"></head><body></body></html>',
        {
          runScripts: 'outside-only',
          url: 'https://mixdog.test/',
        }
      );
      dom.window.matchMedia = (query) => ({
        matches: query === `(prefers-color-scheme: ${osLight ? 'light' : 'dark'})`,
      });
      if (preference) dom.window.localStorage.setItem('mixdog.desktop-theme-preference', preference);
      if (storageBlocked) {
        Object.defineProperty(dom.window, 'localStorage', {
          get() {
            throw new dom.window.DOMException('Storage is blocked', 'SecurityError');
          },
        });
      }
      try {
        evalBoot(dom);
        const root = dom.window.document.documentElement;
        const scenario = JSON.stringify({ preference, osLight, storageBlocked });
        assert.equal(root.dataset.mixdogTheme === 'light', light, scenario);
        assert.equal(root.style.colorScheme, light ? 'light' : 'dark', scenario);
      } finally {
        // Let boot observers finish before destroying their document.
        await new Promise((resolve) => setTimeout(resolve, 25));
        closeWindow(dom);
      }
    }
  }
});

test('phone sheets preserve unread activity until the conversation is visible again', () => {
  const base = {
    viewedSessionId: 'session-a',
    requestedSessionId: '',
    mobile: true,
    sidebarOpen: false,
    dockOpen: false,
    bottomPanelOpen: false,
    settingsOpen: false,
  };
  assert.equal(resolveUnreadViewedSessionId(base), 'session-a');
  for (const coveredBy of ['sidebarOpen', 'dockOpen', 'bottomPanelOpen', 'settingsOpen']) {
    assert.equal(resolveUnreadViewedSessionId({ ...base, [coveredBy]: true }), '');
  }
  assert.equal(
    resolveUnreadViewedSessionId({
      ...base,
      requestedSessionId: 'session-b',
    }),
    'session-b'
  );
  assert.equal(
    resolveUnreadViewedSessionId({
      ...base,
      mobile: false,
      sidebarOpen: true,
    }),
    'session-a'
  );
});

test('the Goal tab shows its task drawer only while open and keeps task overflow', () => {
  const dom = new JSDOM(`<!doctype html><html><head><style>${markdownSource}</style></head><body>
    <div class="session-goal-island" data-open="true">
      <button class="session-goal-trigger"></button>
      <div class="session-goal-drawer">
        <section class="session-goal-panel"><div class="session-goal-body"><div class="session-goal-content"><div class="session-goal-tasks"><ul><li></li><li></li></ul></div></div></div></section>
      </div>
    </div>
    <div class="session-goal-island" data-open="false">
      <button class="session-goal-trigger"></button>
      <div class="session-goal-drawer"></div>
    </div>
  </body></html>`);
  const style = (selector) => dom.window.getComputedStyle(dom.window.document.querySelector(selector));
  assert.equal(style('[data-open="true"] .session-goal-drawer').display, 'block');
  assert.equal(
    style('[data-open="true"] > .session-goal-trigger').display,
    'none',
    'the open tab replaces the segment'
  );
  assert.equal(style('[data-open="false"] .session-goal-drawer').display, 'none');
  assert.equal(style('.session-goal-body').overflow, 'hidden');
  // Only the content scrolls; header and controls stay fixed.
  assert.equal(style('.session-goal-content').overflowY, 'auto');
  assert.notEqual(style('.session-goal-content').scrollbarGutter, 'stable');
  closeWindow(dom);
});

test('iOS boot preserves device-width and marks the phone before CSS paint', () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>',
    { runScripts: 'outside-only', url: 'https://mixdog.test/' }
  );
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  Object.defineProperty(dom.window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: 5,
  });
  try {
    evalBoot(dom);
    assertPhoneBoot(dom, { ios: true });
  } finally {
    closeWindow(dom);
  }
});

function assertPhoneBoot(dom, { ios = false } = {}) {
  const viewport = dom.window.document.querySelector('meta[name="viewport"]');
  assert.match(viewport.getAttribute('content'), /width=device-width/u);
  assert.match(viewport.getAttribute('content'), /minimum-scale=1\.0/u);
  assert.match(viewport.getAttribute('content'), /maximum-scale=1\.0/u);
  assert.match(viewport.getAttribute('content'), /user-scalable=no/u);
  assert.equal(dom.window.document.documentElement.hasAttribute('data-mixdog-mobile-tabs'), true);
  assert.equal(dom.window.document.documentElement.dataset.mixdogProjection, undefined);
  assert.equal(dom.window.document.documentElement.hasAttribute('data-mixdog-ios-web'), ios);
}

for (const [device, model] of [
  ['Pixel', 'Pixel 8'],
  ['Samsung', 'SM-S928N'],
]) {
  test(`Android ${device} boot preserves device-width like iOS`, () => {
    const dom = new JSDOM(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>',
      { runScripts: 'outside-only', url: 'https://mixdog.test/' }
    );
    Object.defineProperty(dom.window.navigator, 'userAgent', {
      configurable: true,
      value: `Mozilla/5.0 (Linux; Android 15; ${model}) AppleWebKit/537.36 Chrome/131 Mobile`,
    });
    try {
      evalBoot(dom);
      assertPhoneBoot(dom);
    } finally {
      closeWindow(dom);
    }
  });
}

test('installed phone boot promotes only its locale and preserves asset priority', () => {
  const dom = new JSDOM(
    `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width">
      <template id="mixdog-first-screen">
        <link rel="modulepreload" fetchpriority="high" href="./bootstrap.js">
        <link rel="modulepreload" data-mixdog-locale="ko" href="./ko.js">
        <link rel="modulepreload" data-mixdog-locale="ja" href="./ja.js">
        <link rel="preload" href="./seti.woff" as="font" type="font/woff" crossorigin data-mixdog-surface="desktop">
      </template>
    </head><body><div id="root"></div></body></html>`,
    { runScripts: 'outside-only', url: 'https://mixdog.test/d/device/' }
  );
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile',
  });
  Object.defineProperty(dom.window.navigator, 'language', {
    configurable: true,
    value: 'ko-KR',
  });
  // boot.js reads the ordered preference list first; JSDOM's default is en-US.
  Object.defineProperty(dom.window.navigator, 'languages', {
    configurable: true,
    value: ['ko-KR', 'ko'],
  });
  dom.window.matchMedia = (query) => ({
    matches: query === '(display-mode: standalone)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  try {
    evalBoot(dom);
    const promoted = [...dom.window.document.head.children].filter((node) => node.tagName === 'LINK');
    assert.deepEqual(
      promoted.map((link) => new URL(link.href).pathname),
      ['/d/device/bootstrap.js', '/d/device/ko.js']
    );
    assert.equal(promoted[0].getAttribute('fetchpriority'), 'high');
  } finally {
    dom.window.mixdogRevealApp?.();
    closeWindow(dom);
  }
});

test('a directly connected browser tab gets the installed-app boot gate; a plain tab does not', () => {
  const gated = (marked) => {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
      runScripts: 'outside-only',
      url: 'https://mixdog.test/d/device/',
    });
    Object.defineProperty(dom.window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144',
    });
    if (marked) dom.window.localStorage.setItem('mixdog.directBrowser', '1');
    try {
      evalBoot(dom);
      return dom.window.document.documentElement.hasAttribute('data-mixdog-booting');
    } finally {
      dom.window.mixdogRevealApp?.();
      closeWindow(dom);
    }
  };
  assert.equal(gated(true), true);
  assert.equal(gated(false), false);
});

test('only the Electron desktop promotes desktop-surface hints', () => {
  const markup = `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width">
      <template id="mixdog-first-screen">
        <link rel="modulepreload" fetchpriority="high" href="./bootstrap.js">
        <link rel="preload" href="./assets/seti-12345678.woff" as="font" type="font/woff" crossorigin data-mixdog-surface="desktop">
      </template>
    </head><body><div id="root"></div></body></html>`;
  const headLinks = (userAgent) => {
    const dom = new JSDOM(markup, { runScripts: 'outside-only', url: 'file:///app/out/renderer/index.html' });
    Object.defineProperty(dom.window.navigator, 'userAgent', { configurable: true, value: userAgent });
    dom.window.matchMedia = (query) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    });
    try {
      evalBoot(dom);
      return [...dom.window.document.head.children]
        .filter((node) => node.tagName === 'LINK')
        .map((link) => ({
          rel: link.rel,
          as: link.getAttribute('as'),
          type: link.getAttribute('type'),
          crossorigin: link.hasAttribute('crossorigin'),
          href: link.href,
        }));
    } finally {
      dom.window.mixdogRevealApp?.();
      closeWindow(dom);
    }
  };
  assert.deepEqual(headLinks('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144 Electron/41.0.0'), [
    {
      rel: 'preload',
      as: 'font',
      type: 'font/woff',
      crossorigin: true,
      href: 'file:///app/out/renderer/assets/seti-12345678.woff',
    },
  ]);
  // The installed phone app takes its module hints but never the desktop font.
  assert.deepEqual(
    headLinks('Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile').map((link) => link.rel),
    ['modulepreload']
  );
});

function bootDesktopLayout({ userAgent, platform, maxTouchPoints = 0, innerWidth, standalone = false }) {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><div id="root"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://mixdog.test/d/device/' }
  );
  const define = (target, key, value) => Object.defineProperty(target, key, { configurable: true, value });
  define(dom.window.navigator, 'userAgent', userAgent);
  if (platform) define(dom.window.navigator, 'platform', platform);
  define(dom.window.navigator, 'maxTouchPoints', maxTouchPoints);
  if (innerWidth) define(dom.window, 'innerWidth', innerWidth);
  dom.window.matchMedia = (query) => ({
    matches:
      (standalone && query === '(display-mode: standalone)') || (maxTouchPoints > 0 && query === '(pointer: coarse)'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  try {
    evalBoot(dom);
    const root = dom.window.document.documentElement;
    return {
      viewport: dom.window.document.querySelector('meta[name="viewport"]').getAttribute('content'),
      projection: root.dataset.mixdogProjection,
      phone: root.hasAttribute('data-mixdog-mobile-tabs'),
      ios: root.hasAttribute('data-mixdog-ios-web'),
      gated: root.hasAttribute('data-mixdog-booting'),
    };
  } finally {
    dom.window.mixdogRevealApp?.();
    closeWindow(dom);
  }
}

test('desktop Chrome boot lays out at device-width with no projection', () => {
  const boot = bootDesktopLayout({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131',
  });
  assert.match(boot.viewport, /width=device-width/u);
  assert.match(boot.viewport, /maximum-scale=1\.0/u);
  assert.match(boot.viewport, /user-scalable=no/u);
  assert.doesNotMatch(bootSource, /width=1040/u);
  assert.equal(boot.projection, undefined);
  assert.equal(boot.phone, false);
});

test('boot picks the tablet layout with the same classifier as the mounted app', async () => {
  const { usesPhoneLayout } = await import('../shared/surface-class.ts');
  const android = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/131 Safari/537.36';
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
  for (const [userAgent, platform, innerWidth] of [
    [android, 'Linux armv8l', 800],
    [android, 'Linux armv8l', 1280],
    [android, 'Linux armv8l', 600],
    [ipad, 'MacIntel', 1180],
    [ipad, 'MacIntel', 820],
    [ipad, 'MacIntel', 507],
  ]) {
    const boot = bootDesktopLayout({ userAgent, platform, maxTouchPoints: 5, innerWidth });
    const probe = { userAgent, platform, maxTouchPoints: 5, coarsePointer: true };
    assert.match(boot.viewport, /width=device-width/u);
    assert.equal(boot.projection, undefined);
    assert.equal(boot.phone, usesPhoneLayout(probe, innerWidth), `${platform} at ${innerWidth}`);
    assert.equal(boot.phone, innerWidth < 640, `${platform} at ${innerWidth}`);
    assert.equal(boot.ios, boot.phone && platform === 'MacIntel');
  }
  // An installed tablet app gets the boot gate like an installed phone app.
  assert.equal(
    bootDesktopLayout({
      userAgent: android,
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
      innerWidth: 800,
      standalone: true,
    }).gated,
    true
  );
});

test('iOS web surfaces keep native scale through landscape rotation', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body></body></html>',
    expose: ['navigator'],
    actEnvironment: false,
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  Object.defineProperty(dom.window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: 5,
  });
  Object.defineProperty(dom.window.navigator, 'standalone', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', {
    configurable: true,
    value: 844,
  });

  try {
    const {
      installMobileSurfaceMarker,
      isIOSWebSurface,
      isInstalledMobileWebAppSurface,
      isInstalledWebAppSurface,
      isMobileRemoteSurface,
    } = await import(`./mobile-surface.ts?ios=${Date.now()}`);
    assert.equal(isIOSWebSurface(), true);
    assert.equal(isMobileRemoteSurface(), true);
    assert.equal(isInstalledWebAppSurface(), true);
    assert.equal(isInstalledMobileWebAppSurface(), true);

    const remove = installMobileSurfaceMarker();
    assert.equal(document.documentElement.hasAttribute('data-mixdog-mobile-tabs'), true);
    assert.equal(document.documentElement.hasAttribute('data-mixdog-ios-web'), true);

    window.dispatchEvent(new dom.window.Event('orientationchange'));
    assert.equal(document.documentElement.hasAttribute('data-mixdog-mobile-tabs'), true);
    assert.equal(document.documentElement.hasAttribute('data-mixdog-ios-web'), true);
    remove();
  } finally {
    restore();
  }
});

test('iPads and touch laptops pick the layout by viewport width', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body></body></html>',
    expose: ['navigator'],
    actEnvironment: false,
  });
  const define = (target, key, value) => Object.defineProperty(target, key, { configurable: true, value });
  define(dom.window.navigator, 'userAgent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');
  define(dom.window.navigator, 'platform', 'MacIntel');
  define(dom.window.navigator, 'maxTouchPoints', 5);
  try {
    const { isMobileRemoteSurface, isMobileDeviceSurface, isInstalledMobileWebAppSurface } = await import(
      `./mobile-surface.ts?tablet=${Date.now()}`
    );
    define(dom.window, 'innerWidth', 1024);
    assert.equal(isMobileRemoteSurface(), false);
    // Desktop LAYOUT, yet still an installable device: an installed iPad app
    // must keep launching (layout width never gates the entry).
    define(dom.window.navigator, 'standalone', true);
    assert.equal(isMobileDeviceSurface(), true);
    assert.equal(isInstalledMobileWebAppSurface(), true);
    define(dom.window.navigator, 'standalone', false);
    define(dom.window, 'innerWidth', 507);
    assert.equal(isMobileRemoteSurface(), true);
    define(dom.window, 'innerWidth', 820);
    assert.equal(isMobileRemoteSurface(), false);

    // Touch laptop: fine primary pointer, small screen, never a phone.
    define(dom.window.navigator, 'platform', 'Win32');
    define(
      dom.window.navigator,
      'userAgent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131'
    );
    define(dom.window, 'innerWidth', 700);
    define(dom.window.screen, 'width', 700);
    define(dom.window.screen, 'height', 700);
    define(dom.window, 'matchMedia', () => ({ matches: false }));
    assert.equal(isMobileRemoteSurface(), false);
    assert.equal(isMobileDeviceSurface(), false);
  } finally {
    restore();
  }
});

test('a desktop-installed PWA never becomes a remote work surface', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body></body></html>',
    expose: ['navigator'],
    actEnvironment: false,
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131',
  });
  Object.defineProperty(dom.window.navigator, 'standalone', {
    configurable: true,
    value: true,
  });

  try {
    const { isInstalledMobileWebAppSurface, isInstalledWebAppSurface, isMobileRemoteSurface } = await import(
      `./mobile-surface.ts?desktop-pwa=${Date.now()}`
    );
    assert.equal(isInstalledWebAppSurface(), true);
    assert.equal(isMobileRemoteSurface(), false);
    assert.equal(isInstalledMobileWebAppSurface(), false);
  } finally {
    restore();
  }
});

test('remote web surfaces clear and block renderer and browser zoom', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body></body></html>',
    expose: ['navigator'],
    actEnvironment: false,
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  dom.window.localStorage.setItem('mixdog.web-zoom', '1.8');
  dom.window.document.documentElement.style.zoom = '1.8';

  try {
    await import(`./webview-zoom.ts?remote-zoom=${Date.now()}`);
    assert.equal(dom.window.localStorage.getItem('mixdog.web-zoom'), null);
    assert.equal(dom.window.document.documentElement.style.zoom, '');

    const shortcut = new dom.window.KeyboardEvent('keydown', {
      key: '+',
      ctrlKey: true,
      cancelable: true,
    });
    dom.window.dispatchEvent(shortcut);
    assert.equal(shortcut.defaultPrevented, true);

    const wheel = new dom.window.WheelEvent('wheel', {
      ctrlKey: true,
      cancelable: true,
    });
    dom.window.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, true);

    const gesture = new dom.window.Event('gesturestart', { cancelable: true });
    dom.window.document.dispatchEvent(gesture);
    assert.equal(gesture.defaultPrevented, true);
  } finally {
    restore();
  }
});

test('desktop shell blocks zoom shortcuts and pinch without blocking normal scrolling', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body></body></html>',
    expose: ['navigator'],
    actEnvironment: false,
  });
  const zoomCalls = [];
  dom.window.mixdogDesktop = {
    bootContext: { bootId: 'boot-test' },
    setZoomFactor: async (factor) => zoomCalls.push(factor),
  };
  dom.window.localStorage.setItem('mixdog.web-zoom', '1.2');
  dom.window.document.documentElement.style.zoom = '1.2';
  try {
    await import(`./webview-zoom.ts?desktop-zoom=${Date.now()}`);
    assert.equal(dom.window.localStorage.getItem('mixdog.web-zoom'), null);
    assert.equal(dom.window.document.documentElement.style.zoom, '');
    for (const modifier of ['ctrlKey', 'metaKey']) {
      for (const key of ['=', '+', '-', '0']) {
        const event = new dom.window.KeyboardEvent('keydown', { key, [modifier]: true, cancelable: true });
        dom.window.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true, `${modifier} ${key}`);
      }
    }
    // The main process pins the host window's zoom, so no blocking wheel
    // listener holds every scroll on the main thread.
    for (const ctrlKey of [true, false]) {
      const event = new dom.window.WheelEvent('wheel', { ctrlKey, cancelable: true });
      dom.window.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
    }
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      const event = new dom.window.Event(name, { cancelable: true });
      dom.window.document.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    assert.deepEqual(zoomCalls, []);
  } finally {
    restore();
  }
});

/** Imports webview-zoom under `userAgent` and returns its non-passive document touch listeners. */
async function blockingTouchListeners(userAgent, tag) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body></body></html>',
    expose: ['navigator'],
    actEnvironment: false,
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  const blocking = [];
  const add = dom.window.document.addEventListener;
  dom.window.document.addEventListener = function (type, listener, options) {
    if (/^touch/.test(type) && options?.passive === false) blocking.push(type);
    return add.call(this, type, listener, options);
  };
  try {
    await import(`./webview-zoom.ts?${tag}=${Date.now()}`);
    return blocking;
  } finally {
    dom.window.document.addEventListener = add;
    restore();
  }
}

test('no phone keeps a blocking document touch listener', async () => {
  // Pinch is refused by the viewport meta, the root touch-action and (iOS
  // Safari) the gesture listeners; a blocking document touch listener only
  // delayed the start of every scroll.
  assert.deepEqual(
    await blockingTouchListeners(
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile',
      'android-touch'
    ),
    []
  );
  assert.deepEqual(
    await blockingTouchListeners(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
      'ios-touch'
    ),
    []
  );
});

test('Android phones keep native scale on Pixel and Samsung screens', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body></body></html>',
    expose: ['navigator'],
    actEnvironment: false,
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile',
  });
  Object.defineProperty(dom.window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: 5,
  });
  Object.defineProperty(dom.window.screen, 'width', { configurable: true, value: 412 });
  Object.defineProperty(dom.window.screen, 'height', { configurable: true, value: 915 });
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', {
    configurable: true,
    value: 412,
  });

  try {
    const { installMobileSurfaceMarker, isMobileRemoteSurface } = await import(
      `./mobile-surface.ts?android=${Date.now()}`
    );
    assert.equal(isMobileRemoteSurface(), true);
    const remove = installMobileSurfaceMarker();
    assert.equal(document.documentElement.hasAttribute('data-mixdog-mobile-tabs'), true);
    assert.equal(document.documentElement.hasAttribute('data-mixdog-ios-web'), false);
    remove();
  } finally {
    restore();
  }
});

test('the entry route names the desktop to ask, by path or by relay cookie', async () => {
  const { REMOTE_PAIRING_STORAGE_KEYS, clearStoredRemotePairing, readRemoteDeviceId } = await import(
    `./remote-pairing-recovery.ts?device=${Date.now()}`
  );
  // An installed web app launches at the route its manifest captured — the one
  // thing an empty storage container knows about the desktop it belongs to.
  assert.equal(readRemoteDeviceId('/d/abc123de/', ''), 'abc123de');
  assert.equal(readRemoteDeviceId('/d/abc123de', ''), 'abc123de');
  assert.equal(readRemoteDeviceId('/d/abc123de/settings', ''), 'abc123de');
  // A navigation that left the route falls back to the cookie the relay set.
  assert.equal(readRemoteDeviceId('/', 'theme=dark; mixdog_device=abc123de'), 'abc123de');
  // The route is a label, not a credential — but a malformed one is refused.
  assert.equal(readRemoteDeviceId('/', 'mixdog_device=../secrets'), '');
  assert.equal(readRemoteDeviceId('/', ''), '');

  const cells = new Map([
    [REMOTE_PAIRING_STORAGE_KEYS.token, 'b'.repeat(64)],
    [REMOTE_PAIRING_STORAGE_KEYS.device, 'abc123de'],
  ]);
  // A reset wipes stored credentials AND the route; the entry screen recovers
  // the route from the URL it launched at and asks for a new approval.
  clearStoredRemotePairing({
    removeItem: (key) => {
      cells.delete(key);
    },
  });
  assert.equal(cells.size, 0);
});

test('mobile cold boot hydrates the composer project catalog from local cache', () => {
  const cells = new Map();
  const storage = {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => {
      cells.set(key, value);
    },
  };
  const cached = [
    { name: 'Mixdog', path: 'C:\\Project\\mixdog', alias: 'Core' },
    { name: 'Duplicate', path: 'c:/project/mixdog/', alias: null },
  ];

  writeCachedProjectCatalog(cached, storage);

  assert.equal(cells.has(PROJECT_CATALOG_CACHE_KEY), true);
  assert.deepEqual(readCachedProjectCatalog(storage), [cached[0]]);
});

test('an uncertain empty mobile probe preserves the last project until reconnect validates it', () => {
  const lastProject = 'C:\\Project\\mixdog';

  assert.equal(acceptedProjectCatalog([], false), null);
  assert.deepEqual(acceptedProjectCatalog([], true), []);
  assert.equal(resolveProjectPathAgainstCatalog(lastProject, false, '', ''), lastProject);
  assert.equal(
    resolveProjectPathAgainstCatalog(lastProject, true, '', 'C:\\Project\\GamerScroll'),
    'C:\\Project\\GamerScroll'
  );
});
