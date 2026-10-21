import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Bot reorder in real Chrome with the real CSS: the Bots page and the Sessions
// bot section drag-reorder through one host-stored order; the drop line shows
// where a dragged bot lands, in both lists. Screenshots are taken mid-drag and
// after the drop (MIXDOG_QA_DIR, default %TEMP%\mixdog-qa\bot-reorder).

const lazyChunkBoundary = {
  name: 'lazy-chunk-boundary',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

const PAGE = `
  import "./process-shim";
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { AgentActivityPane } from "./AgentActivityPane";
  import { agentsSection } from "./session-sidebar-sections";
  import { useSidebarAgents } from "./session-sidebar-agents";

  const NOW = Date.now();
  const home = (agentHome, age, preview) => ({
    id: "sess_home_" + agentHome, agentHome, title: "x", preview, lastMessagePreview: preview,
    updatedAt: NOW - age, activityAt: NOW - age, messageCount: 2, readMessageCount: 2,
    cwd: "/tasks", classification: "task", projectPath: null,
  });
  const bot = (id, label) => ({ id, custom: true, kind: "bot", label, route: { provider: "openai", model: "gpt-5" } });
  const AGENTS = [bot("researcher", "Researcher"), bot("designer", "Designer"), bot("editor", "editor"), bot("scribe", "Scribe")];
  const SESSIONS = [
    home("lead", 1000, "How can I help?"), home("researcher", 2000, "Found three sources."),
    home("designer", 3000, "Pixel faces are ready."), home("editor", 4000, "LGTM"), home("scribe", 5000, "Draft saved."),
  ];
  const state = { order: [], calls: [], listeners: new Set() };
  window.__bots = state;
  window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: () => () => {},
    invokeCapability: async ({ capability, args }) => {
      state.calls.push([capability, ...args]);
      if (capability === "listAgents") return { value: AGENTS };
      if (capability === "getLeadStatus") return { value: { created: true } };
      if (capability === "getBotOrder") return { value: { order: state.order } };
      if (capability === "setBotOrder") { state.order = args[0]; return { value: { order: state.order } }; }
      return { value: null };
    },
    subscribeSettingsChanged: (listener) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  };
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  function Page() {
    const bots = useSidebarAgents(SESSIONS, undefined, true, () => {}, undefined);
    return (
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <aside className="session-sidebar" style={{ width: 240, position: "static" }}>
          {agentsSection({ contacts: bots.contacts, open: true, onToggleOpen() {}, selectedSessionId: "", onOpenAgent: bots.openAgent })}
        </aside>
        <div className="utility-dock" style={{ width: 360 }}>
          <AgentActivityPane active sessions={SESSIONS} onOpenSession={() => {}} />
        </div>
      </div>
    );
  }
  createRoot(document.getElementById("root")).render(<Page />);
`;

// A real drag: dragstart on the row's button, dragover on the target (held for the shot).
const DRAG = (selector, fromId, toId, release) => {
  const find = (id) =>
    document.querySelector(
      selector + ' [data-agent-contact="' + id + '"] button, ' + selector + '[data-agent-contact="' + id + '"] button'
    );
  const from = find(fromId);
  const to = find(toId);
  const transfer = new DataTransfer();
  // Held near the top edge of the target row (the Bots page places the line
  // from the pointer's half of the row).
  const clientY = Math.round(to.getBoundingClientRect().top + 2);
  const fire = (type, el) =>
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 100, clientY }));
  window.__drag = { fire, from, to };
  fire('dragstart', from);
  fire('dragenter', to);
  fire('dragover', to);
  if (release) {
    fire('drop', to);
    fire('dragend', from);
  }
};

test('bots reorder by drag in the Bots page and the sidebar, one shared order, with a drop line', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const shots = process.env.MIXDOG_QA_DIR || join(tmpdir(), 'mixdog-qa', 'bot-reorder');
  mkdirSync(shots, { recursive: true });
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: PAGE },
      bundle: true,
      write: false,
      outfile: 'bot-reorder.js',
      loader: { '.jpg': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
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
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./agent-chat.css";',
      },
      outfile: 'bot-reorder.css',
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
  await page.setViewport({ width: 700, height: 480, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      contentType: 'text/html',
      body: '<!doctype html><html data-mixdog-theme="dark"><head></head><body style="margin:0;padding:12px"><div id="root"></div></body></html>',
    })
  );
  await page.goto('http://mixdog.test/');
  for (const file of [...styles.outputFiles, ...bundle.outputFiles.filter((f) => f.path.endsWith('.css'))])
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.waitForSelector('.agent-contact-list [data-agent-contact="scribe"]');
  await page.waitForSelector('.sidebar-agents [data-agent-contact="scribe"]');
  await page.evaluate(() => document.fonts.ready);
  const order = (selector) =>
    page.evaluate(
      (s) => [...document.querySelectorAll(s + ' [data-agent-contact]')].map((row) => row.dataset.agentContact),
      selector
    );
  const PANE = '.agent-contact-list';
  const SIDE = '.sidebar-agents';
  const dropLine = (selector) =>
    page.evaluate(
      (s) =>
        [...document.querySelectorAll(s + ' [data-bot-drop]')].map((row) => [
          row.dataset.agentContact,
          row.dataset.botDrop,
          getComputedStyle(row).boxShadow !== 'none',
        ]),
      selector
    );
  // The Bots page draws the Sessions sidebar's insertion line (data-drop-position).
  const paneDropLine = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.agent-contact-list [data-drop-position]')].map((row) => [
        row.dataset.agentContact,
        row.dataset.dropPosition,
        getComputedStyle(row, '::after').content !== 'none',
      ])
    );
  assert.deepEqual(await order(PANE), ['lead', 'researcher', 'designer', 'editor', 'scribe']);
  await page.screenshot({ path: join(shots, '1-before.png') });

  // Mid-drag in the Bots page: Scribe held over Designer's top half.
  await page.evaluate(DRAG, PANE, 'scribe', 'designer', false);
  await page.waitForSelector(`${PANE} [data-drop-position]`);
  assert.deepEqual(await paneDropLine(), [['designer', 'before', true]]);
  await page.screenshot({ path: join(shots, '2-dragging-pane.png') });
  await page.evaluate(() => {
    window.__drag.fire('drop', window.__drag.to);
    window.__drag.fire('dragend', window.__drag.from);
  });
  await page.waitForFunction(
    () => document.querySelector('.sidebar-agents [data-agent-contact]:nth-child(3)')?.dataset.agentContact === 'scribe'
  );
  assert.deepEqual(await order(PANE), ['lead', 'researcher', 'scribe', 'designer', 'editor']);
  assert.deepEqual(await order(SIDE), ['lead', 'researcher', 'scribe', 'designer', 'editor'], 'the sidebar follows');
  await page.screenshot({ path: join(shots, '3-after-pane-drop.png') });

  // Mid-drag in the sidebar: Researcher held over editor (moves down → line below).
  await page.evaluate(DRAG, SIDE, 'researcher', 'editor', false);
  await page.waitForSelector(`${SIDE} [data-bot-drop]`);
  assert.deepEqual(await dropLine(SIDE), [['editor', 'after', true]]);
  await page.screenshot({ path: join(shots, '4-dragging-sidebar.png') });
  // Mixy's row refuses it: no line there.
  await page.evaluate(() => {
    const mixy = document.querySelector('.sidebar-agents [data-agent-contact="lead"] button');
    window.__drag.fire('dragover', mixy);
  });
  assert.deepEqual(await dropLine(SIDE), []);
  await page.screenshot({ path: join(shots, '5-mixy-refuses.png') });
  await page.evaluate(() => {
    const mixy = document.querySelector('.sidebar-agents [data-agent-contact="lead"] button');
    window.__drag.fire('drop', mixy);
    window.__drag.fire('dragend', window.__drag.from);
  });
  assert.deepEqual(await order(SIDE), ['lead', 'researcher', 'scribe', 'designer', 'editor'], 'nothing moved');
  assert.deepEqual(await page.evaluate(() => window.__bots.order), ['researcher', 'scribe', 'designer', 'editor']);
  assert.deepEqual(errors, []);
});
