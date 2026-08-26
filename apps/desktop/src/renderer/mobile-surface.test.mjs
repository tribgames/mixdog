import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const bootSource = readFileSync(new URL("./public/boot.js", import.meta.url), "utf8");
const mobileChromeSource = readFileSync(
  new URL("./desktop/07-mobile-chrome.css", import.meta.url),
  "utf8",
);
const tokensSource = readFileSync(
  new URL("./desktop/01-tokens.css", import.meta.url),
  "utf8",
);
const mobileTabsSource = readFileSync(
  new URL("./desktop/08-mobile-tabs.css", import.meta.url),
  "utf8",
);
const mobileRuntimeSource = readFileSync(
  new URL("./mobile-web-runtime.css", import.meta.url),
  "utf8",
);

test("iOS boot preserves device-width and marks the phone before CSS paint", () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>',
    { runScripts: "outside-only", url: "https://mixdog.test/" },
  );
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  Object.defineProperty(dom.window.navigator, "maxTouchPoints", {
    configurable: true,
    value: 5,
  });
  try {
    dom.window.eval(bootSource);
    assertPhoneBoot(dom, { ios: true });
  } finally {
    dom.window.close();
  }
});

function assertPhoneBoot(dom, { ios = false } = {}) {
  const viewport = dom.window.document.querySelector('meta[name="viewport"]');
  assert.match(viewport.getAttribute("content"), /width=device-width/u);
  assert.match(viewport.getAttribute("content"), /minimum-scale=1\.0/u);
  assert.match(viewport.getAttribute("content"), /maximum-scale=1\.0/u);
  assert.match(viewport.getAttribute("content"), /user-scalable=no/u);
  assert.equal(dom.window.document.documentElement.hasAttribute("data-mixdog-mobile-tabs"), true);
  assert.equal(
    dom.window.document.documentElement.style.getPropertyValue("--mx-device-scale"),
    "1",
  );
  assert.equal(dom.window.document.documentElement.dataset.mixdogProjection, undefined);
  assert.equal(dom.window.document.documentElement.hasAttribute("data-mixdog-ios-web"), ios);
}

test("Android Pixel boot preserves device-width like iOS", () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>',
    { runScripts: "outside-only", url: "https://mixdog.test/" },
  );
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile",
  });
  try {
    dom.window.eval(bootSource);
    assertPhoneBoot(dom);
  } finally {
    dom.window.close();
  }
});

test("Android Samsung boot preserves device-width like iOS", () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>',
    { runScripts: "outside-only", url: "https://mixdog.test/" },
  );
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 Chrome/131 Mobile",
  });
  try {
    dom.window.eval(bootSource);
    assertPhoneBoot(dom);
  } finally {
    dom.window.close();
  }
});

test("installed phone boot promotes only its locale and preserves asset priority", () => {
  const dom = new JSDOM(
    `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width">
      <template id="mixdog-first-screen">
        <link rel="modulepreload" fetchpriority="high" href="./bootstrap.js">
        <link rel="modulepreload" data-mixdog-locale="ko" href="./ko.js">
        <link rel="modulepreload" data-mixdog-locale="ja" href="./ja.js">
      </template>
    </head><body><div id="root"></div></body></html>`,
    { runScripts: "outside-only", url: "https://mixdog.test/d/device/" },
  );
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile",
  });
  Object.defineProperty(dom.window.navigator, "language", {
    configurable: true,
    value: "ko-KR",
  });
  dom.window.matchMedia = (query) => ({
    matches: query === "(display-mode: standalone)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  try {
    dom.window.eval(bootSource);
    const promoted = [...dom.window.document.head.children]
      .filter((node) => node.tagName === "LINK");
    assert.deepEqual(
      promoted.map((link) => new URL(link.href).pathname),
      ["/d/device/bootstrap.js", "/d/device/ko.js"],
    );
    assert.equal(promoted[0].getAttribute("fetchpriority"), "high");
  } finally {
    dom.window.mixdogRevealApp?.();
    dom.window.close();
  }
});

test("phone finishing rules keep reading, touch and safe-area geometry aligned", () => {
  assert.match(mobileChromeSource, /--mx-mobile-edge-main:\s*calc\(12px \* var\(--mx-device-scale/u);
  assert.match(
    mobileChromeSource,
    /html\[data-mixdog-mobile-tabs\] \.session-sidebar \.session-row\s*\{[^}]*height:\s*var\(--mx-touch-row\);[^}]*min-height:\s*var\(--mx-touch-row\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.session-sidebar \.session-row-actions\s*\{[^}]*top:\s*calc\(\(var\(--mx-touch-row\) - 24px\) \/ 2\);/su,
  );
  assert.match(
    mobileChromeSource,
    /html\[data-mixdog-mobile-tabs\] \.transcript\s*\{[^}]*scrollbar-gutter:\s*auto;[^}]*touch-action:\s*pan-y;/su,
  );
  assert.match(
    mobileChromeSource,
    /html\[data-mixdog-mobile-tabs\] \.jump-to-latest\s*\{[^}]*min-height:\s*var\(--mx-touch-main\);/su,
  );
  assert.match(
    mobileChromeSource,
    /settings-confirm-dialog > footer button,[\s\S]*?min-height:\s*var\(--mx-touch\);/u,
  );
  assert.match(
    mobileChromeSource,
    /orientation:\s*landscape[\s\S]*?grid-template-columns:\s*repeat\(3,/u,
  );
  assert.match(
    mobileChromeSource,
    /--mx-mobile-sheet-safe-bottom:\s*max\(\s*env\(safe-area-inset-bottom,\s*0px\),\s*env\(safe-area-max-inset-bottom,\s*0px\)\s*\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.workbench-side-panel\[data-side="right"\] > \.workbench-side-panel-content\s*\{[^}]*padding-bottom:\s*var\(--mx-mobile-sheet-safe-bottom\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.desktop-body > \.utility-dock\s*\{[^}]*padding-bottom:\s*var\(--mx-mobile-sheet-safe-bottom\);/su,
  );
});

test("every screen-pinned sheet takes the visible-height ceiling", () => {
  // --vvh mirrors visualViewport from JS and can name MORE height than the
  // screen shows (a retracting URL bar, an edge-to-edge viewport reaching
  // behind system UI). `dvh` is the browser's own measure of the same height,
  // so a sheet takes whichever is smaller: the variable still shrinks it for
  // the soft keyboard, the unit keeps its pinned footer on screen.
  assert.match(
    tokensSource,
    /--mx-visible-height:\s*min\(var\(--vvh, 100dvh\), 100dvh\);/u,
  );
  // The phone body is the containing block every fixed sheet resolves against.
  assert.match(
    mobileRuntimeSource,
    /html\[data-mixdog-mobile-tabs\] body\s*\{[^}]*height:\s*var\(--mx-visible-height\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.workbench-side-panel\[data-side="right"\]\s*\{[^}]*height:\s*var\(--mx-visible-height\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.sidebar-drawer-frame\s*\{[^}]*height:\s*calc\(var\(--mx-visible-height\) \/ var\(--mx-device-scale, 2\.5\)\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.desktop-body > \.utility-dock\s*\{[^}]*height:\s*calc\(var\(--mx-visible-height\) \/ var\(--mx-device-scale, 2\.5\)\);/su,
  );
  // Narrow desktop/tablet band: the same sheet used to anchor to `bottom`,
  // which resolves against the LAYOUT viewport and dropped its footer below
  // the fold on every mobile browser.
  assert.match(
    mobileTabsSource,
    /@media \(max-width: 940px\)\s*\{[^}]*\.workbench-side-panel\[data-side="right"\]\s*\{[^}]*height:\s*calc\(var\(--mx-visible-height\) - var\(--titlebar-height\)\);/su,
  );
  assert.doesNotMatch(
    mobileTabsSource,
    /\.workbench-side-panel\[data-side="right"\]\s*\{[^}]*bottom:\s*0;/su,
  );
});

test("desktop Chrome boot retains the canonical projection", () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>',
    { runScripts: "outside-only", url: "https://mixdog.test/" },
  );
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131",
  });
  try {
    dom.window.eval(bootSource);
    const viewport = dom.window.document.querySelector('meta[name="viewport"]');
    assert.match(viewport.getAttribute("content"), /width=1040/u);
    assert.match(viewport.getAttribute("content"), /maximum-scale=1\.0/u);
    assert.match(viewport.getAttribute("content"), /user-scalable=no/u);
    assert.equal(dom.window.document.documentElement.dataset.mixdogProjection, "desktop");
    assert.equal(dom.window.document.documentElement.hasAttribute("data-mixdog-mobile-tabs"), false);
  } finally {
    dom.window.close();
  }
});

test("iOS web surfaces keep native scale through landscape rotation", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://mixdog.test/",
  });
  const previous = new Map(["window", "document", "navigator"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  Object.defineProperty(dom.window.navigator, "maxTouchPoints", {
    configurable: true,
    value: 5,
  });
  Object.defineProperty(dom.window.navigator, "standalone", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(dom.window.document.documentElement, "clientWidth", {
    configurable: true,
    value: 844,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  try {
    const {
      installMobileSurfaceMarker,
      isIOSWebSurface,
      isInstalledMobileWebAppSurface,
      isInstalledWebAppSurface,
      isMobileRemoteSurface,
      mobileSurfaceScale,
    } = await import(`./mobile-surface.ts?ios=${Date.now()}`);
    assert.equal(isIOSWebSurface(), true);
    assert.equal(isMobileRemoteSurface(), true);
    assert.equal(isInstalledWebAppSurface(), true);
    assert.equal(isInstalledMobileWebAppSurface(), true);
    assert.equal(mobileSurfaceScale(), 1);

    const remove = installMobileSurfaceMarker();
    assert.equal(document.documentElement.hasAttribute("data-mixdog-mobile-tabs"), true);
    assert.equal(document.documentElement.hasAttribute("data-mixdog-ios-web"), true);
    assert.equal(document.documentElement.style.getPropertyValue("--mx-device-scale"), "1");

    window.dispatchEvent(new dom.window.Event("orientationchange"));
    assert.equal(document.documentElement.style.getPropertyValue("--mx-device-scale"), "1");
    remove();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

test("a desktop-installed PWA never becomes a remote work surface", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://mixdog.test/",
  });
  const previous = new Map(["window", "document", "navigator"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131",
  });
  Object.defineProperty(dom.window.navigator, "standalone", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  try {
    const {
      isInstalledMobileWebAppSurface,
      isInstalledWebAppSurface,
      isMobileRemoteSurface,
    } = await import(`./mobile-surface.ts?desktop-pwa=${Date.now()}`);
    assert.equal(isInstalledWebAppSurface(), true);
    assert.equal(isMobileRemoteSurface(), false);
    assert.equal(isInstalledMobileWebAppSurface(), false);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

test("remote web surfaces clear and block renderer and browser zoom", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://mixdog.test/",
  });
  const previous = new Map(["window", "document", "navigator"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  dom.window.localStorage.setItem("mixdog.web-zoom", "1.8");
  dom.window.document.documentElement.style.zoom = "1.8";
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  try {
    const { zoomIn } = await import(`./webview-zoom.ts?remote-zoom=${Date.now()}`);
    assert.equal(dom.window.localStorage.getItem("mixdog.web-zoom"), null);
    assert.equal(dom.window.document.documentElement.style.zoom, "");
    await zoomIn();
    assert.equal(dom.window.document.documentElement.style.zoom, "");

    const shortcut = new dom.window.KeyboardEvent("keydown", {
      key: "+",
      ctrlKey: true,
      cancelable: true,
    });
    dom.window.dispatchEvent(shortcut);
    assert.equal(shortcut.defaultPrevented, true);

    const wheel = new dom.window.WheelEvent("wheel", {
      ctrlKey: true,
      cancelable: true,
    });
    dom.window.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, true);

    const gesture = new dom.window.Event("gesturestart", { cancelable: true });
    dom.window.document.dispatchEvent(gesture);
    assert.equal(gesture.defaultPrevented, true);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

test("Android phones keep native scale on Pixel and Samsung screens", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://mixdog.test/",
  });
  const previous = new Map(["window", "document", "navigator"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile",
  });
  Object.defineProperty(dom.window.navigator, "maxTouchPoints", {
    configurable: true,
    value: 5,
  });
  Object.defineProperty(dom.window.screen, "width", { configurable: true, value: 412 });
  Object.defineProperty(dom.window.screen, "height", { configurable: true, value: 915 });
  Object.defineProperty(dom.window.document.documentElement, "clientWidth", {
    configurable: true,
    value: 412,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  try {
    const { installMobileSurfaceMarker, isMobileRemoteSurface, mobileSurfaceScale } =
      await import(`./mobile-surface.ts?android=${Date.now()}`);
    assert.equal(isMobileRemoteSurface(), true);
    assert.equal(mobileSurfaceScale(), 1);
    const remove = installMobileSurfaceMarker();
    assert.equal(document.documentElement.hasAttribute("data-mixdog-mobile-tabs"), true);
    assert.equal(document.documentElement.hasAttribute("data-mixdog-ios-web"), false);
    assert.equal(document.documentElement.style.getPropertyValue("--mx-device-scale"), "1");
    remove();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

// A cached older boot.js still pins the 1040px desktop projection. The bundle
// must counter-scale it instead of assuming device-width, or the phone paints
// dp-sized chrome into a canvas the browser shrinks onto a 412px screen.
test("a stale projected boot keeps phone chrome at native size", async () => {
  const dom = new JSDOM(
    '<!doctype html><html data-mixdog-projection="desktop"><body></body></html>',
    { url: "https://mixdog.test/" },
  );
  const previous = new Map(["window", "document", "navigator"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile",
  });
  Object.defineProperty(dom.window.navigator, "maxTouchPoints", {
    configurable: true,
    value: 5,
  });
  Object.defineProperty(dom.window.screen, "width", { configurable: true, value: 412 });
  Object.defineProperty(dom.window.screen, "height", { configurable: true, value: 915 });
  Object.defineProperty(dom.window.document.documentElement, "clientWidth", {
    configurable: true,
    value: 1040,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  try {
    const { installMobileSurfaceMarker, mobileSurfaceScale } =
      await import(`./mobile-surface.ts?projected=${Date.now()}`);
    assert.equal(mobileSurfaceScale(), 2.52);
    const remove = installMobileSurfaceMarker();
    assert.equal(document.documentElement.hasAttribute("data-mixdog-mobile-tabs"), true);
    assert.equal(document.documentElement.style.getPropertyValue("--mx-device-scale"), "2.52");
    remove();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

test("the entry route names the desktop to ask, by path or by relay cookie", async () => {
  const { REMOTE_PAIRING_STORAGE_KEYS, clearStoredRemotePairing, readRemoteDeviceId } =
    await import(`./remote-pairing-recovery.ts?device=${Date.now()}`);
  // An installed web app launches at the route its manifest captured — the one
  // thing an empty storage container knows about the desktop it belongs to.
  assert.equal(readRemoteDeviceId("/d/abc123de/", ""), "abc123de");
  assert.equal(readRemoteDeviceId("/d/abc123de", ""), "abc123de");
  assert.equal(readRemoteDeviceId("/d/abc123de/settings", ""), "abc123de");
  // A navigation that left the route falls back to the cookie the relay set.
  assert.equal(readRemoteDeviceId("/", "theme=dark; mixdog_device=abc123de"), "abc123de");
  // The route is a label, not a credential — but a malformed one is refused.
  assert.equal(readRemoteDeviceId("/", "mixdog_device=../secrets"), "");
  assert.equal(readRemoteDeviceId("/", ""), "");

  const cells = new Map([
    [REMOTE_PAIRING_STORAGE_KEYS.token, "b".repeat(64)],
    [REMOTE_PAIRING_STORAGE_KEYS.device, "abc123de"],
  ]);
  // A reset wipes stored credentials AND the route; the entry screen recovers
  // the route from the URL it launched at and asks for a new approval.
  clearStoredRemotePairing({ removeItem: (key) => { cells.delete(key); } });
  assert.equal(cells.size, 0);
});
