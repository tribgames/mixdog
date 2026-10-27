import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// A bot row of the 봇 pane keeps one size while its bot works: the preview
// swaps from the last message to "Working" when a turn starts and back to the
// (often two-line) reply when it ends, and the status badge comes and goes in
// the right column. None of that may change the row's height or move its face,
// name or preview (user: 봇 목록 창 ... 줄이 바뀌는 건지 살짝 레이아웃 쉬프트).
// Real component and CSS in headless Chrome at the wide, narrow and phone sizes.

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
  import { MIXY_AGENT_ID } from "../shared/agent-contacts";
  import { resetMixyStatus } from "./mixy-identity";

  // A profile with Mixy (the host's answer): her contact row is listed.
  resetMixyStatus({ created: true });
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: () => () => {},
    invokeCapability: async () => ({ value: null }),
  };
  const root = createRoot(document.getElementById("root"));
  window.__render = ({ preview, working, unread }) => {
    const session = { id: "home-1", title: "Mixy", preview, lastMessagePreview: preview, working, updatedAt: Date.now() - 60000, messageCount: 2, agentHome: MIXY_AGENT_ID };
    root.render(
      <div className="utility-dock" style={{ width: "var(--probe-width)" }}>
        <AgentActivityPane active={false} sessions={[session]} unreadSessionIds={new Set(unread ? ["home-1"] : [])} />
      </div>
    );
  };
`;

const SHORT = '네.';
const LONG =
  '강아지는 사람을 잘 따르고 정이 많은 친구입니다. 함께 있으면 마음이 편안해지고, 작은 행동 하나도 큰 기쁨을 줍니다.';
// One turn, start to finish: idle on a one-line reply, working, then the long
// reply arriving unread, then read.
const STEPS = [
  { name: 'idle, one-line preview', preview: SHORT, working: false, unread: false },
  { name: 'working', preview: SHORT, working: true, unread: false },
  { name: 'finished, unread two-line reply', preview: LONG, working: false, unread: true },
  { name: 'finished, read', preview: LONG, working: false, unread: false },
  { name: 'working again', preview: LONG, working: true, unread: false },
];

test('a working bot row keeps its height and its face, name and preview stay put', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: PAGE },
      bundle: true,
      write: false,
      outfile: 'agent-contact-row-stability.js',
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
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'agent-contact-row-stability.css',
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
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      contentType: 'text/html',
      body: '<!doctype html><html data-mixdog-theme="dark"><head></head><body style="margin:0"><div id="root"></div></body></html>',
    })
  );
  await page.setViewport({ width: 520, height: 760 });
  for (const { label, width, phone } of [
    { label: 'wide', width: 420, phone: false },
    { label: 'narrow', width: 252, phone: false },
    { label: 'phone', width: 390, phone: true },
  ]) {
    await page.goto('http://mixdog.test/');
    await page.evaluate(
      (w, p) => {
        document.documentElement.style.setProperty('--probe-width', `${w}px`);
        if (p) document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
      },
      width,
      phone
    );
    for (const file of [...styles.outputFiles, ...bundle.outputFiles.filter((f) => f.path.endsWith('.css'))])
      await page.addStyleTag({ content: file.text });
    await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
    await page.evaluate(() => document.fonts.ready);
    const frames = [];
    for (const step of STEPS) {
      await page.evaluate((s) => window.__render(s), step);
      await page.waitForFunction(
        (s) => {
          const row = document.querySelector('.agent-chat-row[data-kind="contact"]');
          const running = Boolean(row?.querySelector('.agent-chat-status[data-kind="running"]'));
          const unread = Boolean(row?.querySelector('.agent-chat-status[data-kind="unread"]'));
          return row && running === s.working && unread === s.unread;
        },
        {},
        step
      );
      frames.push({
        step: step.name,
        ...(await page.evaluate(() => {
          const row = document.querySelector('.agent-chat-row[data-kind="contact"]');
          const box = (selector) => {
            const r = (selector ? row.querySelector(selector) : row).getBoundingClientRect();
            return [r.top, r.height].map((v) => Math.round(v * 10) / 10).join('/');
          };
          return {
            row: box(''),
            avatar: box('.agent-chat-avatar'),
            title: box('.agent-chat-title'),
            preview: box('.agent-chat-preview'),
            time: box('.agent-chat-time'),
          };
        })),
      });
    }
    const [first, ...rest] = frames;
    for (const frame of rest) {
      for (const key of ['row', 'avatar', 'title', 'preview', 'time']) {
        assert.equal(
          frame[key],
          first[key],
          `${label}: ${key} (top/height) moved from "${first.step}" to "${frame.step}" ${JSON.stringify(frames)}`
        );
      }
    }
  }
  assert.deepEqual(errors, []);
});
