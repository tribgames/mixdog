import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// The phone drawer's page headers in real renderer CSS, headless Chrome, at
// 412px: the Bots page (a utility dock) draws its own title row, the rail
// pages share the session sidebar's.

const workerStub = {
  name: 'worker-stub',
  setup(builder) {
    builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
      contents: 'export default class {};',
      loader: 'js',
    }));
  },
};

const harness = `
  import { Plus } from 'lucide-react';
  import { Fragment, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { sessionPanelHeader } from './session-sidebar-render';
  import { SidebarPanelAction, SidebarPanelHeaderSlot } from './session-sidebar-sections';
  import { UtilityDock } from './UtilityDock';

  // No representative bot yet: the Bots header's + is "Create representative bot".
  window.mixdogDesktop = new Proxy(
    {
      sections: {
        core: async () => false,
        snapshot: async () => ({ status: 'ready', entries: [{ section: 'agentPool', key: null, revision: 1, value: [] }] }),
        subscribe: () => () => {},
      },
      invokeCapability: async ({ capability }) => ({
        value: capability === 'getLeadStatus' ? { created: false, name: '', avatar: null } : null,
      }),
    },
    {
      get: (target, name) =>
        name in target ? target[name] : String(name).startsWith('subscribe') ? () => () => {} : async () => [],
    }
  );

  // A rail page: the session sidebar's title row, its slot holding the page's own action.
  function RailPage({ title, children }) {
    const [slot, setSlot] = useState(null);
    return (
      <aside className="sidebar session-sidebar open" data-state="open">
        {sessionPanelHeader({
          panelActive: Boolean(title),
          panelTitle: title ?? 'Sessions',
          setPanelActionSlot: setSlot,
          orderMenuItems: [{ id: 'recent', label: 'Recent' }],
          onNewTask() {},
        })}
        <div className="session-sidebar-scroll session-sidebar-panels session-sidebar-surface">
          <SidebarPanelHeaderSlot.Provider value={slot}>{children}</SidebarPanelHeaderSlot.Provider>
        </div>
      </aside>
    );
  }
  const PAGES = {
    sessions: [3, () => <RailPage />],
    projects: [
      1,
      () => (
        <RailPage title="Projects">
          <SidebarPanelAction label="Add project" icon={Plus} className="projects-add" onClick={() => {}} />
        </RailPage>
      ),
    ],
    bots: [3, () => <UtilityDock open tab="agents" snapshot={{}} showTitle title="Bots" />],
  };
  const root = createRoot(document.getElementById('page'));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const buttons = () => [
    ...document.querySelectorAll(
      '.session-panel-header .session-panel-header-actions :is(.session-panel-action, .row-overflow-trigger)'
    ),
  ];
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    return [box.left, box.top, box.width, box.height].map((n) => Math.round(n * 2) / 2);
  };
  window.__header = async (name) => {
    const [count, page] = PAGES[name];
    root.render(<Fragment key={name}>{page()}</Fragment>);
    const start = performance.now();
    while (buttons().length !== count) {
      if (performance.now() - start > 5000) throw new Error(name + ': ' + buttons().length + ' header buttons, not ' + count);
      await frame();
    }
    await frame();
    return buttons().map((button) => ({
      label: button.getAttribute('aria-label'),
      box: rect(button),
      icon: rect(button.querySelector('svg')).slice(2),
    }));
  };
`;

const body = `<div class="sidebar-drawer-frame" data-state="open" data-motion="instant"><nav class="activity-rail"></nav>
  <aside class="workbench-side-panel" data-side="left"><div class="workbench-side-panel-content"><div class="workbench-side-panel-body">
  <section class="workbench-side-section"><div id="page" class="workbench-side-section-body"></div></section>
  </div></div></aside></div>`;

test("on a 412px phone, the Bots page's header buttons take the Sessions header's 44px boxes, glyphs and places, its + where Projects' sits", async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const assets = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: harness },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      jsx: 'automatic',
      outdir: 'drawer-header-actions',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { ...assets, '.jpg': 'dataurl', '.json': 'json' },
      plugins: [workerStub],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'drawer-header-actions.css',
      bundle: true,
      write: false,
      logLevel: 'error',
      loader: { ...assets, '.jpg': 'dataurl' },
    }),
  ]);
  const css = [styles, bundle].flatMap((result) => result.outputFiles.filter((file) => file.path.endsWith('.css')));
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true });
  // Served from an origin, not set on about:blank: the Bots page keeps its group choices in localStorage.
  const html = `<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.map((file) => file.text).join('\n')}</style></head><body>${body}</body></html>`;
  await page.setRequestInterception(true);
  page.on('request', (request) => request.respond({ contentType: 'text/html', body: html }));
  await page.goto('http://drawer-header-actions.test/');
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });

  const sessions = await page.evaluate(() => window.__header('sessions'));
  const projects = await page.evaluate(() => window.__header('projects'));
  const bots = await page.evaluate(() => window.__header('bots'));
  const place = ({ box, icon }) => ({ box, icon });
  const report = JSON.stringify({ sessions, projects, bots });
  // Search, ⋯ and + in the Sessions header's order, each on its box and glyph.
  assert.deepEqual(bots.map(place), sessions.map(place), report);
  assert.deepEqual(place(bots.at(-1)), place(projects[0]), report);
  assert.ok(
    bots.every(({ box }) => box[2] === 44 && box[3] === 44),
    report
  );
  assert.deepEqual(errors, []);
});
