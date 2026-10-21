import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Settings and a confirm dialog (the scrim every `settings-confirm-layer`
// dialog shares) on an iPhone: opened at phone viewports under an iOS user
// agent (Chromium emulation; WebKit itself is not available here) with the
// device's safe-area insets, each must close by its control and by a tap on
// the scrim with NO mouse events delivered — iOS sends none for a plain div.
// A press that starts inside the card and ends on the scrim must not close it.
// Set MIXDOG_QA_DIR to keep the screenshots.

const lazyChunkBoundary = {
  name: 'lazy-chunk-boundary',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MixdogApp/1';
const INSETS = { top: '59px', right: '0px', bottom: '34px', left: '0px' };
const withInsets = (css) =>
  css.replace(/env\(safe-area-inset-(top|right|bottom|left)\s*,\s*([^)]*)\)/g, (_, side) => INSETS[side]);

const SURFACES = [
  {
    name: 'settings',
    sheet: true,
    layer: '.mixdog-settings-layer',
    card: '.mixdog-settings',
    close: '.mixdog-settings__close',
  },
  {
    name: 'confirm',
    layer: '.settings-confirm-layer',
    card: '.settings-confirm-dialog',
    close: '.settings-confirm-dialog footer button',
  },
  // The scrim and the X both open the "Skip setup?" confirmation (a second
  // dialog on top), which Cancel closes; the wizard card stays inside the
  // layer's phone gutter instead of spilling over the right edge.
  {
    name: 'onboarding',
    layer: '.onboarding-layer',
    card: '.settings-confirm-dialog',
    open: '.onboarding-top-actions button[aria-label="Skip setup"]',
    close: '.settings-confirm-dialog footer button:not(.danger)',
    wizard: '.onboarding-dialog',
  },
];

test('settings and confirm dialogs close by control and by an outside tap on a phone', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const shots = process.env.MIXDOG_QA_DIR || '';
  if (shots) mkdirSync(shots, { recursive: true });
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import "./process-shim";
          import React, { useState } from "react";
          import { createRoot } from "react-dom/client";
          import { SettingsView } from "./settings/SettingsView";
          import { UnsavedChangesDialog } from "./WorkbenchOverlays";
          import { OnboardingWizard } from "./settings/OnboardingWizard";

          // Every call answers like a capability AND is its own unsubscribe.
          const reply = () => {
            const answer = Promise.resolve({ value: {} });
            return Object.assign(() => {}, {
              then: (...handlers) => answer.then(...handlers),
              catch: (handler) => answer.catch(handler),
              finally: (handler) => answer.finally(handler),
            });
          };
          const api = new Proxy({}, { get: () => reply });
          function App() {
            const [open, setOpen] = useState("");
            const close = () => setOpen("");
            return (
              <div className="app-shell">
                <button id="open-settings" type="button" onClick={() => setOpen("settings")}>s</button>
                <button id="open-confirm" type="button" onClick={() => setOpen("confirm")}>c</button>
                <button id="open-onboarding" type="button" onClick={() => setOpen("onboarding")}>o</button>
                {open === "onboarding" && <OnboardingWizard api={api} onDone={close} />}
                {open === "settings" &&<SettingsView api={api} open onClose={close} />}
                {open === "confirm" && (
                  <UnsavedChangesDialog title="a.ts" busy={false} error="" onSave={close} onDiscard={close} onCancel={close} />
                )}
              </div>
            );
          }
          createRoot(document.getElementById("root")).render(<App />);
        `,
      },
      bundle: true,
      write: false,
      outfile: 'phone-dismiss-surfaces.js',
      loader: {
        '.jpg': 'dataurl',
        '.png': 'dataurl',
        '.svg': 'dataurl',
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
        '.webm': 'file',
      },
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://mixdog.test/assets/index.js"' },
      plugins: [lazyChunkBoundary],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./desktop.css"; @import "./mobile-web-runtime.css";',
      },
      outfile: 'phone-dismiss-surfaces.css',
      bundle: true,
      write: false,
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const css = bundle.outputFiles.filter((file) => file.path.endsWith('.css')).map((file) => file.text);
  css.unshift(styles.outputFiles[0].text);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 667 },
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    await page.setUserAgent(IOS_UA);
    await page.setViewport({ ...viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setContent(
      '<!doctype html><html data-mixdog-mobile-tabs data-mixdog-ios-web><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"></head><body><div id="root"></div></body></html>'
    );
    await page.evaluate(({ width, height }) => {
      const root = document.documentElement.style;
      root.setProperty('--vvw', `${width}px`);
      root.setProperty('--vvh', `${height}px`);
    }, viewport);
    await page.addStyleTag({ content: 'html, body { margin: 0; }' });
    for (const text of css) await page.addStyleTag({ content: withInsets(text) });
    await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
    // iOS delivers no mouse events for a tap on a plain div.
    await page.evaluate(() => {
      for (const type of ['mousedown', 'mouseup']) {
        document.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
      }
    });
    const label = `${viewport.width}x${viewport.height}`;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(errors, [], `renderer booted: ${label}`);

    for (const surface of SURFACES) {
      const id = `${surface.name}-${label}`;
      const isOpen = () => page.evaluate((selector) => Boolean(document.querySelector(selector)), surface.card);
      const open = async () => {
        await page.tap(`#open-${surface.name}`);
        await page.waitForSelector(surface.card, { timeout: 5000 }).catch((error) => {
          throw new Error(`${error.message}: ${JSON.stringify(errors)}`);
        });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
              .map((animation) => animation.finished.catch(() => undefined))
          );
        });
      };
      const gone = () =>
        page
          .waitForFunction((selector) => !document.querySelector(selector), { timeout: 3000 }, surface.card)
          .catch(() => {});

      if (surface.wizard) {
        await page.tap(`#open-${surface.name}`);
        await page.waitForSelector(surface.wizard, { timeout: 5000 });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
              .map((animation) => animation.finished.catch(() => undefined))
          );
        });
        if (shots) await page.screenshot({ path: join(shots, `${id}-open.png`) });
        const box = await page.evaluate((selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return { left: rect.left, right: rect.right, bottom: rect.bottom, vh: window.innerHeight };
        }, surface.wizard);
        assert.ok(box.left >= 16 - 0.5, `${id}: wizard keeps the left gutter (left=${box.left})`);
        assert.ok(box.right <= viewport.width - 16 + 0.5, `${id}: wizard keeps the right gutter (right=${box.right})`);
        assert.ok(box.bottom <= box.vh - 34 + 0.5, `${id}: wizard clears the home indicator (bottom=${box.bottom})`);
        const confirmOpen = () => page.evaluate((selector) => Boolean(document.querySelector(selector)), surface.card);
        // A press that starts in the card and ends over the scrim asks nothing.
        await page.evaluate(
          (selectors) => {
            document.querySelector(selectors.wizard).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            document.querySelector(selectors.layer).dispatchEvent(new MouseEvent('click', { bubbles: true }));
          },
          { wizard: surface.wizard, layer: surface.layer }
        );
        assert.equal(await confirmOpen(), false, `${id}: a drag out of the card does not dismiss`);
        // A tap on the scrim (inside the notch band) opens "Skip setup?", as the X does.
        await page.touchscreen.tap(viewport.width / 2, 8);
        await page.waitForSelector(surface.card, { timeout: 3000 });
        await page.tap(surface.close);
        await gone();
        assert.equal(await confirmOpen(), false, `${id}: Cancel closes the confirmation`);
        await page.tap(surface.open);
        await page.waitForSelector(surface.card, { timeout: 3000 });
        assert.equal(await confirmOpen(), true, `${id}: the X opens the same confirmation`);
        await page.tap(surface.close);
        await gone();
        assert.deepEqual(errors, [], `${id}: no renderer errors`);
        continue;
      }
      await open();
      if (shots) await page.screenshot({ path: join(shots, `${id}-open.png`) });
      const layout = await page.evaluate(
        (selectors) => {
          const control = document.querySelector(selectors.close);
          const box = control.getBoundingClientRect();
          const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
          return {
            controlHit: control === hit || control.contains(hit),
            controlTop: box.top,
            controlBottom: box.bottom,
            vh: window.innerHeight,
          };
        },
        { close: surface.close, card: surface.card }
      );
      assert.ok(layout.controlHit, `${id}: close control is hit-testable`);
      assert.ok(layout.controlTop >= 59, `${id}: close control clears the notch inset (top=${layout.controlTop})`);
      assert.ok(layout.controlBottom <= layout.vh - 34, `${id}: close control clears the home indicator`);

      await page.tap(surface.close);
      await gone();
      assert.equal(await isOpen(), false, `${id}: control dismisses`);
      assert.deepEqual(errors, [], `${id}: no renderer errors`);

      // Settings is a full-screen sheet on a phone: no scrim to tap, the back
      // control above (and the system back) is its way out.
      if (surface.sheet) continue;
      await open();
      // A press that starts in the card and ends over the scrim keeps it open.
      await page.evaluate(
        (selectors) => {
          const card = document.querySelector(selectors.card);
          const layer = document.querySelector(selectors.layer);
          card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          layer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        },
        { card: surface.card, layer: surface.layer }
      );
      assert.equal(await isOpen(), true, `${id}: a drag out of the card does not dismiss`);

      // Tap the scrim above the card, inside the notch band.
      await page.touchscreen.tap(viewport.width / 2, 8);
      await gone();
      assert.equal(await isOpen(), false, `${id}: outside tap dismisses`);
      if (shots) await page.screenshot({ path: join(shots, `${id}-closed.png`) });
    }
    assert.deepEqual(errors, [], 'no renderer errors');
    await page.close();
  }
});
