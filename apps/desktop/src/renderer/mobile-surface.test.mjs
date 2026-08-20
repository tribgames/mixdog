import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const bootSource = readFileSync(new URL("./public/boot.js", import.meta.url), "utf8");

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
      isMobileRemoteSurface,
      mobileSurfaceScale,
    } = await import(`./mobile-surface.ts?ios=${Date.now()}`);
    assert.equal(isIOSWebSurface(), true);
    assert.equal(isMobileRemoteSurface(), true);
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

test("install guidance separates iOS manual install from Android prompts", async () => {
  const { isIosInstallPlatform, remoteInstallMode } =
    await import(`./remote-install.ts?install=${Date.now()}`);
  assert.equal(isIosInstallPlatform("Mozilla/5.0 (iPhone)", "iPhone", 5), true);
  assert.equal(remoteInstallMode({
    remote: true,
    standalone: false,
    dismissed: false,
    canPrompt: false,
    ios: true,
  }), "ios");
  assert.equal(remoteInstallMode({
    remote: true,
    standalone: false,
    dismissed: false,
    canPrompt: true,
    ios: false,
  }), "prompt");
  assert.equal(remoteInstallMode({
    remote: true,
    standalone: true,
    dismissed: false,
    canPrompt: false,
    ios: true,
  }), "hidden");
});

test("the iOS install handoff is offered only with a scanned pairing in hand", async () => {
  const { iosInstallStep } = await import(`./remote-install.ts?handoff=${Date.now()}`);
  assert.equal(iosInstallStep({ handoff: true, prepared: false }), "prepare");
  assert.equal(iosInstallStep({ handoff: true, prepared: true }), "share");
  assert.equal(iosInstallStep({ handoff: false, prepared: false }), "plain");
});

test("the scanned pairing link outlives token registration and dies with a reset", async () => {
  const {
    REMOTE_PAIRING_STORAGE_KEYS,
    clearStoredRemotePairing,
    parseRemotePairingLink,
    readRemotePairingLink,
    storeRemotePairingLink,
  } = await import(`./remote-pairing-recovery.ts?link=${Date.now()}`);
  const link = `https://relay.example/?token=${"a".repeat(48)}`
    + `#e2eeKey=${"K".repeat(87)}&e2eeSecret=${"S".repeat(43)}`;
  const parsed = parseRemotePairingLink(link);
  assert.ok(parsed);
  const cells = new Map();
  const storage = {
    getItem: (key) => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => { cells.set(key, String(value)); },
    removeItem: (key) => { cells.delete(key); },
  };
  storeRemotePairingLink(storage, parsed);
  // Registration replaces the routing token with a per-browser credential; only
  // the scanned link can still pair a second storage container, so it stays.
  storage.setItem(REMOTE_PAIRING_STORAGE_KEYS.token, "b".repeat(64));
  assert.equal(readRemotePairingLink(storage), parsed.url);
  clearStoredRemotePairing(storage);
  assert.equal(readRemotePairingLink(storage), "");
});
