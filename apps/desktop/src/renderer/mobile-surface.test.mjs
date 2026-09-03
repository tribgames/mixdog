import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  PROJECT_CATALOG_CACHE_KEY,
  acceptedProjectCatalog,
  readCachedProjectCatalog,
  resolveProjectPathAgainstCatalog,
  writeCachedProjectCatalog,
} from "./project-catalog-cache.ts";
import { resolveUnreadViewedSessionId } from "./app-unread-sessions.ts";

const bootSource = readFileSync(new URL("./public/boot.js", import.meta.url), "utf8");
const mobileChromeSource = readFileSync(
  new URL("./desktop/07-mobile-chrome.css", import.meta.url),
  "utf8",
);
const sidebarUsageSource = readFileSync(
  new URL("./desktop/11-sidebar-usage.css", import.meta.url),
  "utf8",
);
const railPagesSource = readFileSync(
  new URL("./desktop/10-rail-pages.css", import.meta.url),
  "utf8",
);
const dialogsSource = readFileSync(
  new URL("./desktop/30-dialogs.css", import.meta.url),
  "utf8",
);
const activityRailSource = readFileSync(
  new URL("./ActivityRail.tsx", import.meta.url),
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
const editorSource = readFileSync(
  new URL("./desktop/26-editor.css", import.meta.url),
  "utf8",
);
const markdownSource = readFileSync(
  new URL("./desktop/22-markdown.css", import.meta.url),
  "utf8",
);

test("phone draft context waits for Workflow before revealing Project", () => {
  const rule = mobileChromeSource.match(
    /html\[data-mixdog-mobile-tabs\] \.composer-context-bar:not\(:has\(\.composer-route-workflow\)\)\s*\{([^}]*)\}/u,
  );
  assert.ok(rule, "mobile context synchronization rule must exist");
  assert.match(rule[1], /min-height:\s*0;/u);
  assert.match(rule[1], /max-height:\s*0;/u);
  assert.match(rule[1], /opacity:\s*0;/u);
  assert.match(rule[1], /overflow:\s*hidden;/u);
  assert.match(rule[1], /pointer-events:\s*none;/u);
});

test("phone sheets preserve unread activity until the conversation is visible again", () => {
  const base = {
    viewedSessionId: "session-a",
    requestedSessionId: "",
    mobile: true,
    sidebarOpen: false,
    dockOpen: false,
    bottomPanelOpen: false,
    settingsOpen: false,
  };
  assert.equal(resolveUnreadViewedSessionId(base), "session-a");
  for (const coveredBy of ["sidebarOpen", "dockOpen", "bottomPanelOpen", "settingsOpen"]) {
    assert.equal(resolveUnreadViewedSessionId({ ...base, [coveredBy]: true }), "");
  }
  assert.equal(resolveUnreadViewedSessionId({
    ...base,
    requestedSessionId: "session-b",
  }), "session-b");
  assert.equal(resolveUnreadViewedSessionId({
    ...base,
    mobile: false,
    sidebarOpen: true,
  }), "session-a");
});

test("the Goal task drawer overlays from a fixed capsule slot and keeps task overflow", () => {
  const dom = new JSDOM(`<!doctype html><html><head><style>${markdownSource}</style></head><body>
    <div class="session-goal-host">
      <div class="session-goal-island" data-open="true">
        <div class="session-goal-stack">
          <div class="session-goal-drawer"><div class="session-goal-drawer-clip">
            <section class="session-goal-panel"><div class="session-goal-tasks"><ul><li></li><li></li></ul></div></section>
          </div></div>
        </div>
      </div>
    </div>
    <div class="session-goal-host">
      <div class="session-goal-island" data-open="false">
        <div class="session-goal-stack">
          <div class="session-goal-drawer"><div class="session-goal-drawer-clip"></div></div>
        </div>
      </div>
    </div>
  </body></html>`);
  const island = dom.window.document.querySelector('[data-open="true"]');
  const stack = dom.window.document.querySelector('[data-open="true"] .session-goal-stack');
  const openDrawer = dom.window.document.querySelector('[data-open="true"] .session-goal-drawer');
  const closedDrawer = dom.window.document.querySelector('[data-open="false"] .session-goal-drawer');
  const panel = dom.window.document.querySelector(".session-goal-panel");
  const taskList = dom.window.document.querySelector(".session-goal-tasks ul");
  const secondTask = dom.window.document.querySelector(".session-goal-tasks li + li");

  assert.equal(dom.window.getComputedStyle(island).height, "var(--session-goal-trigger-height)");
  assert.equal(dom.window.getComputedStyle(stack).position, "absolute");
  assert.equal(dom.window.getComputedStyle(stack).bottom, "0px");
  assert.equal(dom.window.getComputedStyle(stack).overflow, "hidden");
  assert.equal(dom.window.getComputedStyle(stack).transition, "none");
  assert.equal(dom.window.getComputedStyle(panel).borderTopStyle, "none");
  assert.equal(dom.window.getComputedStyle(panel).marginTop, "0px");
  assert.equal(dom.window.getComputedStyle(openDrawer).gridTemplateRows, "1fr");
  assert.equal(dom.window.getComputedStyle(openDrawer).transition, "none");
  assert.equal(dom.window.getComputedStyle(openDrawer).pointerEvents, "auto");
  assert.equal(dom.window.getComputedStyle(closedDrawer).gridTemplateRows, "0fr");
  assert.equal(dom.window.getComputedStyle(closedDrawer).pointerEvents, "none");
  assert.equal(dom.window.getComputedStyle(taskList).overflowY, "auto");
  assert.notEqual(dom.window.getComputedStyle(taskList).scrollbarGutter, "stable");
  assert.equal(dom.window.getComputedStyle(secondTask).borderTopStyle, "");
  dom.window.close();
});

test("the panel-nested dock view stays in normal flow", () => {
  // The right panel IS the phone/narrow sheet; the dock view nested in it
  // must never become a SECOND fixed sheet — the retired window-level dock
  // once did exactly that (user: 프레임 안에 들어오는 구조인데 요소만 넘친다).
  for (const source of [editorSource, mobileChromeSource]) {
    assert.doesNotMatch(source, /\.utility-dock\s*\{[^}]*position:\s*fixed;/su);
  }
});

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
    /\.session-panel-header-actions > \.session-panel-action:last-child\s*\{[^}]*margin-right:\s*calc\(var\(--mx-rail-trailing-center,\s*20px\) - 22px\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.session-row-unread-dot\s*\{\s*right:\s*16\.5px;\s*\}[\s\S]*?\.session-row-status\s*\{\s*right:\s*14px;\s*\}/u,
  );
  assert.match(
    mobileChromeSource,
    /html\[data-mixdog-mobile-tabs\] \.transcript\s*\{[^}]*scrollbar-gutter:\s*auto;[^}]*touch-action:\s*pan-y;/su,
  );
  assert.match(
    mobileChromeSource,
    /html\[data-mixdog-mobile-tabs\] \.session-sidebar-scroll\s*\{\s*margin-right:\s*0;\s*\}/su,
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
    /--mx-mobile-sheet-safe-bottom:\s*max\(\s*calc\(env\(safe-area-inset-bottom,\s*0px\) \/ var\(--mx-device-scale, 2\.5\)\),\s*calc\(env\(safe-area-max-inset-bottom,\s*0px\) \/ var\(--mx-device-scale, 2\.5\)\),\s*8px\s*\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.sidebar-drawer-frame > \.sidebar\.session-sidebar[\s\S]*?\{[^}]*padding:\s*16px 8px var\(--mx-mobile-sheet-safe-bottom\);/u,
  );
  assert.match(
    mobileChromeSource,
    /\.workbench-side-panel\[data-side="right"\] > \.workbench-side-panel-content\s*\{[^}]*padding-bottom:\s*var\(--mx-mobile-sheet-safe-bottom\);/su,
  );
});

test("rail trailing controls resolve to one 20px centerline", () => {
  assert.match(dialogsSource, /--mx-rail-trailing-center:\s*20px;/u);
  assert.match(
    railPagesSource,
    /\.sidebar-category-header > \.row-overflow \.row-overflow-trigger\s*\{[^}]*margin-right:\s*calc\(var\(--mx-rail-trailing-center,\s*20px\) - 14px\);/su,
  );
  assert.match(
    railPagesSource,
    /\.workflows-section-head > \.schedules-new\s*\{[^}]*margin-right:\s*calc\(var\(--mx-rail-trailing-center,\s*20px\) - 14px\);/su,
  );
  assert.match(
    dialogsSource,
    /\.sidebar-view-section-actions > \.session-panel-action:last-child\s*\{[^}]*margin-right:\s*calc\(var\(--mx-rail-trailing-center\) - 2px - 14px\);/su,
  );
  assert.match(
    dialogsSource,
    /\.schedules-row \.row-overflow-trigger,[\s\S]*?margin-right:\s*calc\(\s*var\(--mx-rail-trailing-center\) -\s*var\(--mx-rail-gutter\) -\s*12px\s*\);/u,
  );
  assert.match(
    mobileChromeSource,
    /\.session-sidebar \.sidebar-category-header > \.row-overflow \.row-overflow-trigger\s*\{[^}]*width:\s*var\(--mx-touch-row\);[^}]*margin-right:\s*calc\(var\(--mx-rail-trailing-center,\s*20px\) - 18px\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.session-sidebar-panels \.workflows-section-head > \.schedules-new\s*\{[^}]*margin-right:\s*calc\(var\(--mx-rail-trailing-center,\s*20px\) - 22px\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.session-sidebar \.sidebar-view-section-actions > \.session-panel-action\s*\{[^}]*width:\s*var\(--mx-touch\);[^}]*height:\s*var\(--mx-touch\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.session-sidebar \.sidebar-view-section-actions > \.session-panel-action:last-child\s*\{[^}]*margin-right:\s*calc\(var\(--mx-rail-trailing-center,\s*20px\) - 2px - 22px\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.session-sidebar-panels \.schedules-row \.row-overflow-trigger\s*\{[^}]*margin-right:\s*calc\(\s*var\(--mx-rail-trailing-center,\s*20px\) -\s*var\(--mx-rail-gutter,\s*12px\) -\s*18px\s*\);/su,
  );
});

test("PC and phone usage flyouts share one widened width", () => {
  assert.match(
    activityRailSource,
    /import \{ DESKTOP_SIDEBAR_DEFAULT_WIDTH \} from "\.\.\/shared\/window-layout";/u,
  );
  assert.match(
    activityRailSource,
    /className="rail-usage-popup"[\s\S]*?width:\s*DESKTOP_SIDEBAR_DEFAULT_WIDTH \+ 36,/u,
  );
  assert.doesNotMatch(
    sidebarUsageSource,
    /\.rail-usage-popup\s*\{[^}]*width:/su,
  );
  assert.doesNotMatch(
    sidebarUsageSource,
    /html\[data-mixdog-mobile-tabs\] \.rail-usage-popup/u,
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
  // The right sheet is the pane's whole side-dock UNIT (header + panel).
  assert.match(
    mobileChromeSource,
    /html\[data-mixdog-mobile-tabs\] \.pane-side-dock\s*\{[^}]*position:\s*fixed;[^}]*height:\s*var\(--mx-visible-height\);/su,
  );
  assert.match(
    mobileChromeSource,
    /\.sidebar-drawer-frame\s*\{[^}]*height:\s*calc\(var\(--mx-visible-height\) \/ var\(--mx-device-scale, 2\.5\)\);/su,
  );
  // The narrow-band right sheet retired with the pane-embedded dock: a
  // narrow PANE overlays its own panel (pane-layout.css container query), so
  // no window-level fixed right sheet may return to the tab layer.
  assert.doesNotMatch(
    mobileTabsSource,
    /\.workbench-side-panel\[data-side="right"\][^{]*\{[^}]*position:\s*fixed/su,
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

test("mobile cold boot hydrates the composer project catalog from local cache", () => {
  const cells = new Map();
  const storage = {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => { cells.set(key, value); },
  };
  const cached = [
    { name: "Mixdog", path: "C:\\Project\\mixdog", alias: "Core" },
    { name: "Duplicate", path: "c:/project/mixdog/", alias: null },
  ];

  writeCachedProjectCatalog(cached, storage);

  assert.equal(cells.has(PROJECT_CATALOG_CACHE_KEY), true);
  assert.deepEqual(readCachedProjectCatalog(storage), [cached[0]]);
});

test("an uncertain empty mobile probe preserves the last project until reconnect validates it", () => {
  const lastProject = "C:\\Project\\mixdog";

  assert.equal(acceptedProjectCatalog([], false), null);
  assert.deepEqual(acceptedProjectCatalog([], true), []);
  assert.equal(
    resolveProjectPathAgainstCatalog(lastProject, false, "", ""),
    lastProject,
  );
  assert.equal(
    resolveProjectPathAgainstCatalog(lastProject, true, "", "C:\\Project\\GamerScroll"),
    "C:\\Project\\GamerScroll",
  );
});
