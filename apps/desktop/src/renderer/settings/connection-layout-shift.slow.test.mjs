import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Same graph as the usage-stats layout test: lazy chunks stay external so the
// bundle holds only what Settings loads.
const lazyChunkBoundary = {
  name: 'lazy-chunk-boundary',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

// Settings → Connection: the page's data (this PC's name and switch, the saved
// PCs) arrives after the page first paints. Nothing already painted may move.
test('opening Settings → Connection does not shift the page when its data arrives after first paint', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const rendererDir = fileURLToPath(new URL('..', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import "../process-shim";
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { SettingsView } from "./SettingsView";

          const wait = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
          const readyInfo = {
            relayBrowserUrl: "https://relay.example/d/aaaaaaaa/",
            relayBrowserQrSvg: "<svg></svg>",
            relayAppQrSvg: "<svg></svg>",
            relayConnectUrl: "https://relay.example/connect",
            enabled: true,
            clients: [
              { id: "c1", name: "Pixel", platform: "Android", browser: "app", createdAt: 1, lastSeenAt: 2, online: true },
              { id: "c2", name: "Laptop", platform: "Windows", browser: "Chrome", createdAt: 1, lastSeenAt: 2, online: false },
            ],
          };
          const settings = { enabled: true, name: "DESKTOP-IBLP835", defaultName: "DESKTOP-IBLP835" };
          const hosts = [{ id: "h1", name: "Office PC", online: true, lastConnectedAt: 1 }];

          let root;
          window.renderSettings = (delay) => {
            root?.unmount();
            document.getElementById("root").innerHTML = "<div id='mount'></div>";
            root = createRoot(document.getElementById("mount"));
            const api = {
              readCapabilities: async (requests) => requests.map(() => ({ ok: true, value: null })),
              invokeCapability: async () => ({ value: null, snapshot: null }),
              listProviderModels: async () => [],
              getSnapshot: async () => null,
              getUpdaterState: async () => ({ status: "idle" }),
              checkForDesktopUpdate: async () => ({ status: "idle" }),
              subscribeState: () => () => {},
              subscribeUpdaterState: () => () => {},
              getRemoteAccessInfo: () => wait(delay, readyInfo),
              getRemoteAccessSettings: () => wait(delay, settings),
              subscribeRemoteAccessSettings: () => () => {},
              listRemoteHosts: () => wait(delay, hosts),
              connectRemoteHostByCode: async () => ({}),
              getRemotePairCode: async () => null,
            };
            root.render(<SettingsView api={api} open onClose={() => {}} />);
          };
        `,
      },
      bundle: true,
      write: false,
      outfile: 'connection-layout-shift.js',
      format: 'iife',
      jsx: 'automatic',
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.url': '"http://mixdog.test/assets/index.js"',
      },
      plugins: [lazyChunkBoundary],
    }),
    build({
      stdin: {
        resolveDir: rendererDir,
        loader: 'css',
        contents: '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./desktop.css";',
      },
      outfile: 'connection-layout-shift.css',
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1160, height: 831 });
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css'))) {
    await page.addStyleTag({ content: file.text });
  }
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });

  // Opens Settings, waits for the first page to settle, then switches to
  // `category` while recording every layout shift and the top of the page's
  // blocks frame by frame.
  const openCategory = (category, delay) =>
    page.evaluate(
      async (category, delay) => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        window.renderSettings(delay);
        await pause(delay + 700);
        const shifts = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) if (!entry.hadRecentInput) shifts.push(entry.value);
        });
        observer.observe({ type: 'layout-shift', buffered: false });
        const tops = {};
        let sampling = true;
        const sample = () => {
          for (const block of document.querySelectorAll('.conn-toolbar, .conn-card, .conn-group')) {
            const key = block.className.split(' ')[0] + ':' + (block.querySelector('h4')?.textContent ?? '');
            tops[key] ??= [];
            tops[key].push(Math.round(block.getBoundingClientRect().top));
          }
          if (sampling) requestAnimationFrame(sample);
        };
        document.querySelector('button[aria-label="' + category + '"]').click();
        sample();
        await pause(delay + 900);
        sampling = false;
        await pause(50);
        observer.disconnect();
        return {
          cls: shifts.reduce((sum, value) => sum + value, 0),
          shifts,
          tops,
          text: document.querySelector('.capability-settings-content')?.textContent ?? '',
        };
      },
      category,
      delay
    );

  for (const delay of [0, 150]) {
    const control = await openCategory('General', delay);
    assert.ok(control.cls < 0.001, `control (General) is stable at ${delay}ms: cls=${control.cls}`);

    const connection = await openCategory('Connection', delay);
    assert.match(connection.text, /DESKTOP-IBLP835/, `the PC's name painted at ${delay}ms`);
    assert.match(connection.text, /Office PC/, `saved PCs painted at ${delay}ms`);
    assert.match(connection.text, /Pixel/, `devices painted at ${delay}ms`);
    assert.ok(
      connection.cls < 0.001,
      `Connection does not shift at ${delay}ms: cls=${connection.cls} shifts=${JSON.stringify(connection.shifts)}`
    );
    for (const [block, tops] of Object.entries(connection.tops)) {
      // A block may appear once the page is ready, but it never moves after it did.
      assert.equal(new Set(tops).size, 1, `${block} keeps its top at ${delay}ms: ${[...new Set(tops)]}`);
    }
  }
  assert.deepEqual(errors, [], 'no renderer errors');
});
