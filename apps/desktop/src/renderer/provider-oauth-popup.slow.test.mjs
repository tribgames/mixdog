import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';
import { appStyles } from './test-support/app-styles.mjs';

// The provider sign-in popup in real renderer CSS, real components, headless
// Chrome: over the Settings › Providers cards only its own content shows, from
// an account row's Reconnect and from a card's add-account control alike.

const noLazyChunks = {
  name: 'no-lazy-chunks',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

const HARNESS = `
  import "./process-shim";
  import { createRoot } from "react-dom/client";
  import { ProvidersPanel } from "./settings/provider-panel";

  const usage = { windows: [{ label: "5H", usedPct: 0 }, { label: "7D", usedPct: 40 }] };
  const accounts = (provider) => [
    { id: provider + "-1", label: "Account 1", detail: "someone@example.com", authenticated: true,
      reauthRequired: provider === "cursor-oauth", usage },
    { id: provider + "-2", label: "Account 2", detail: "other@example.com", authenticated: true, usage },
  ];
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === "getProviderAccounts")
        return { value: { selectedId: args[0] + "-1", auto: true, accounts: accounts(args[0]) } };
      return { value: {} };
    },
  };
  const flow = { flowId: "flow-1", state: "pending", url: "https://cursor.com/loginDeepControl" };
  const run = async (capability) =>
    capability === "beginOAuthProviderLogin" || capability === "getOAuthProviderLoginStatus" ? flow : undefined;
  const oauth = ["cursor-oauth", "openai-oauth", "anthropic-oauth", "copilot-oauth"].map((id) => ({
    id, name: id, authenticated: true, usable: true, status: "Connected",
  }));
  createRoot(document.getElementById("root")).render(
    <ProvidersPanel api={api} pending="" run={run} confirm={() => {}} data={{ providerSetup: { oauth, api: [] } }} />
  );
`;

async function openPage(t) {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const assets = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      jsx: 'automatic',
      outdir: 'provider-oauth-popup',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://mixdog.test/assets/index.js"' },
      loader: { ...assets, '.jpg': 'dataurl', '.webm': 'file' },
      plugins: [noLazyChunks],
    }),
    appStyles(),
  ]);
  const componentCss = bundle.outputFiles.filter((file) => file.path.endsWith('.css')).map((file) => file.text);
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  // The panel at the Settings dialog's content width.
  await page.setContent(
    `<!doctype html><html data-mixdog-theme="basic"><head><style>${[styles, ...componentCss].join('\n')}</style></head>
    <body><div id="root" class="capability-settings-content" style="width:650px;margin:40px auto"></div></body></html>`
  );
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  return page;
}

/** What the pointer meets over the popup's card: every sample must land in
 *  the card, and the card's own plate must be opaque. */
const probePopup = (page) =>
  page.evaluate(() => {
    const card = document.querySelector('.settings-oauth-dialog');
    const box = card.getBoundingClientRect();
    const strays = [];
    for (let x = 0.05; x < 1; x += 0.1) {
      for (let y = 0.05; y < 1; y += 0.1) {
        const hit = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y);
        if (!card.contains(hit))
          strays.push(`${hit?.className || hit?.tagName} ${hit?.textContent?.trim().slice(0, 24)}`);
      }
    }
    const scrim = document.elementFromPoint(box.left / 2, box.top / 2);
    return {
      strays,
      plate: getComputedStyle(card).backgroundColor,
      scrimOver: scrim?.classList.contains('settings-oauth-layer') ?? false,
    };
  });

const alpha = (color) => {
  const parts = color.match(/[\d.]+/g).map(Number);
  return color.startsWith('rgba') ? parts[3] : 1;
};

test('the provider sign-in popup shows only its own content over the provider cards', async (t) => {
  const page = await openPage(t);
  await page.waitForSelector('[data-account-id="cursor-oauth-1"] .settings-resource-actions button');
  const openers = [
    ['Reconnect', '[data-account-id="cursor-oauth-1"] .settings-resource-actions button'],
    ['add account', '.provider-accounts-heading-actions button[aria-label="Add account"]'],
  ];
  for (const [name, selector] of openers) {
    await page.$eval(selector, (button) => button.click());
    await page.waitForSelector('.settings-oauth-dialog');
    for (const theme of ['basic', 'light']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.mixdogTheme = theme;
      }, theme);
      const { strays, plate, scrimOver } = await probePopup(page);
      assert.deepEqual(strays, [], `${name} (${theme}): nothing paints over the popup`);
      assert.equal(alpha(plate), 1, `${name} (${theme}): the popup's plate is opaque (${plate})`);
      assert.ok(scrimOver, `${name} (${theme}): the scrim covers the settings around the popup`);
    }
    await page.$eval('.settings-oauth-dialog > footer button', (button) => button.click());
    await page.waitForFunction(() => !document.querySelector('.settings-oauth-dialog'));
  }
});
