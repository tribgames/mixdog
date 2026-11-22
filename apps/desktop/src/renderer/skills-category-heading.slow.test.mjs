import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// The Skills panel in real renderer CSS, headless Chrome, in the phone
// drawer at 412px: a plugin whose name is longer than the rail pushed its
// category count off the edge.

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

const PLUGIN_NAME = 'An extremely long plugin display name that does not fit the rail';

const harness = `
  import { createRoot } from 'react-dom/client';
  import { SkillsPanel } from './settings/extension-panels';
  const skill = (name, sourceKey) => ({
    name, key: sourceKey + ':' + name, sourceKey, state: 'inUse', hiddenBy: null, offBy: null,
    replacesBuiltin: false, enabled: true, editable: sourceKey === 'global',
  });
  window.mixdogDesktop = {};
  createRoot(document.getElementById('skills')).render(
    <SkillsPanel
      api={{}}
      data={{
        __loadedSections: ['skills', 'plugins'],
        skills: { skills: [skill('deploy', 'global'), skill('lint', 'plugin:long'), skill('tidy', 'plugin:long')] },
        plugins: { plugins: [{ id: 'long', name: ${JSON.stringify(PLUGIN_NAME)}, enabled: true }] },
      }}
      snapshot={null}
      pending=""
      run={async () => undefined}
      confirm={() => {}}
      refreshExtensions={async () => {}}
    />
  );
`;

const body = `<div class="sidebar-drawer-frame" data-state="open" data-motion="instant"><nav class="activity-rail"></nav>
  <aside class="workbench-side-panel" data-side="left"><div class="workbench-side-panel-content"><div class="workbench-side-panel-body">
  <section class="workbench-side-section"><div class="workbench-side-section-body"><aside class="sidebar session-sidebar open">
  <div class="session-sidebar-scroll session-sidebar-panels session-sidebar-surface" data-surface-active="true">
  <div class="extensions-pane skills-pane schedules-pane" data-surface-active="true"><div class="schedules-page">
  <div class="pane-surface-gate"><div class="pane-surface-gate-content"><div id="skills" class="capability-settings-content"></div>
  </div></div></div></div></div></aside></div></section></div></div></aside></div>`;

test('a long plugin name truncates in its category heading; the count and chevron stay on the rail', async (t) => {
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
      outdir: 'skills-category-heading',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { ...assets, '.json': 'json' },
      plugins: [workerStub],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./settings/settings.css"; @import "./desktop/31-extensions.css";',
      },
      outfile: 'skills-category-heading.css',
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
  // Served from an origin, not set on about:blank: the panel keeps its collapsed categories in localStorage.
  const html = `<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.map((file) => file.text).join('\n')}</style></head><body>${body}</body></html>`;
  await page.setRequestInterception(true);
  page.on('request', (request) => request.respond({ contentType: 'text/html', body: html }));
  await page.goto('http://skills-category-heading.test/');
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.waitForSelector('[data-skill-source="plugin:long"] .sidebar-heading-toggle', { timeout: 5000 }).catch((error) => {
    throw new Error(`${error.message}; page errors: ${JSON.stringify(errors)}`);
  });
  const heading = await page.$eval('[data-skill-source="plugin:long"] .sidebar-heading-toggle', (toggle) => {
    const rail = toggle.closest('.skills-pane').getBoundingClientRect();
    const label = toggle.querySelector('span');
    return {
      railRight: rail.right,
      label: label.textContent,
      labelTruncated: label.scrollWidth > label.clientWidth,
      countRight: toggle.querySelector('small').getBoundingClientRect().right,
      count: toggle.querySelector('small').textContent,
      chevronRight: toggle.querySelector('svg').getBoundingClientRect().right,
    };
  });
  assert.equal(heading.label, PLUGIN_NAME);
  assert.equal(heading.count, '2');
  assert.ok(heading.labelTruncated, `the plugin name is cut to the rail (${JSON.stringify(heading)})`);
  assert.ok(heading.countRight <= heading.railRight, `the count stays on the rail (${heading.countRight} > ${heading.railRight})`);
  assert.ok(
    heading.chevronRight <= heading.railRight,
    `the chevron stays on the rail (${heading.chevronRight} > ${heading.railRight})`
  );
});
