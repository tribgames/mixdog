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
    const viewport = dom.window.document.querySelector('meta[name="viewport"]');
    assert.match(viewport.getAttribute("content"), /width=device-width/u);
    assert.equal(dom.window.document.documentElement.hasAttribute("data-mixdog-mobile-tabs"), true);
    assert.equal(dom.window.document.documentElement.hasAttribute("data-mixdog-ios-web"), true);
    assert.equal(
      dom.window.document.documentElement.style.getPropertyValue("--mx-device-scale"),
      "1",
    );
  } finally {
    dom.window.close();
  }
});

test("Android boot retains the canonical projection", () => {
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
    const viewport = dom.window.document.querySelector('meta[name="viewport"]');
    assert.match(viewport.getAttribute("content"), /width=1040/u);
    assert.equal(dom.window.document.documentElement.dataset.mixdogProjection, "desktop");
    assert.equal(dom.window.document.documentElement.hasAttribute("data-mixdog-ios-web"), false);
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

test("projected Android phones are detected from physical screen size", async () => {
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
    value: 1040,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  try {
    const { installMobileSurfaceMarker, isMobileRemoteSurface, mobileSurfaceScale } =
      await import(`./mobile-surface.ts?android=${Date.now()}`);
    assert.equal(isMobileRemoteSurface(), true);
    assert.equal(mobileSurfaceScale(), 2.52);
    const remove = installMobileSurfaceMarker();
    assert.equal(document.documentElement.hasAttribute("data-mixdog-mobile-tabs"), true);
    assert.equal(document.documentElement.hasAttribute("data-mixdog-ios-web"), false);
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
