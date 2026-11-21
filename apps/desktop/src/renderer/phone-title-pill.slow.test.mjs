// Real Chromium owns the layout: the phone title pill's glyph and the working
// spinner that replaces it are sized by the stylesheets, not by the markup.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));

const PAGE = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { workspaceMobileTabPill } from './WorkspaceTabStrip.tsx';
  import { agentHomeSessionId } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
  window.mixdogDesktop = new Proxy({
    sections: {
      core: async () => false,
      snapshot: async () => ({ status: 'ready', entries: [] }),
      subscribe: () => () => {},
    },
  }, {
    get: (target, name) => name in target ? target[name]
      : String(name).startsWith('subscribe') ? () => () => {} : async () => [],
  });
  const root = createRoot(document.getElementById('host'));
  // The title's left edge with the session idle, then working.
  window.__titleLeft = async (sessionId) => {
    const tab = { key: 'tab', title: 'Release notes', selection: { kind: 'session', id: sessionId } };
    const left = (working) => {
      flushSync(() => root.render(workspaceMobileTabPill({
        tabs: [tab], activeKey: 'tab', activeBusy: false, pendingNewTask: false,
        workingSessionIds: new Set(working ? [sessionId] : []),
        setTabMenu() {}, onSelectTab() {},
      })));
      return document.querySelector('.workspace-tab-compact-current > span:last-child').getBoundingClientRect().left;
    };
    return { idle: left(false), working: left(true) };
  };
  window.__homeSession = agentHomeSessionId('lead');
`;

async function bundle(contents, loader) {
  return build({
    stdin: { contents, resolveDir, loader },
    outfile: 'phone-title-pill.out',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'worker-stub',
        setup(builder) {
          builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
            contents: 'export default class {};',
            loader: 'js',
          }));
        },
      },
    ],
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.jpg': 'dataurl',
      '.png': 'dataurl',
    },
  });
}

test('the phone title stays put when its session starts and stops working, a bot chat included', async () => {
  const [script, styles] = await Promise.all([
    bundle(PAGE, 'tsx'),
    bundle(
      '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./agent-chat.css";',
      'css'
    ),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  try {
    const tab = await browser.newPage();
    const errors = [];
    tab.on('pageerror', (error) => errors.push(error.message));
    await tab.setViewport({ width: 412, height: 870, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const css = styles.outputFiles.find((file) => file.path.endsWith('.out')).text;
    await tab.setContent(
      `<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="host"></div></body></html>`
    );
    await tab.addScriptTag({ content: script.outputFiles.find((file) => file.path.endsWith('.out')).text });
    const home = await tab.evaluate(() => window.__homeSession);
    assert.ok(home);
    for (const [label, sessionId] of [
      ['a coding chat', 'session-1'],
      ['a bot chat', home],
    ]) {
      const { idle, working } = await tab.evaluate((id) => window.__titleLeft(id), sessionId);
      assert.ok(Math.abs(idle - working) <= 0.5, `${label}: the title moved from ${idle} to ${working}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
