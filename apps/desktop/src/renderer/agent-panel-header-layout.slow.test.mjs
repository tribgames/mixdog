// The composer island's Agents popover in a real Chrome, built from the real
// ComposerDock and the app's whole stylesheet: at phone widths (360–430dp) and
// in a long-label locale its header (title pill, state counts, "Clear
// finished", close) never overlaps or clips, the counts and both buttons stay
// readable with a 44px tap area, the rows ellipsize with their right column
// clear of the text, and the usage footer wraps inside the panel.
// AGENT_PANEL_SHOT_TAG=before|after names the screenshots written under
// %TEMP%/agent-panel-header/.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const HOST =
  '<section class="conversation" id="host" style="display:flex;flex-direction:column;height:100vh;margin:0"></section>';
// Korean is the reported one; German and Russian carry the longest labels.
const LANGUAGES = ['ko', 'de', 'ru', 'es', 'fr', 'it', 'ja', 'pt-BR', 'vi', 'zh-CN', 'zh-TW'];
const SHOTS = join(tmpdir(), 'agent-panel-header');
const TAG = process.env.AGENT_PANEL_SHOT_TAG || 'run';

const PAGE = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import i18next from './i18n.ts';
  import { ComposerDock } from './ComposerDock.tsx';
  import ko from './locales/ko.json';
  import de from './locales/de.json';
  import ru from './locales/ru.json';
  import es from './locales/es.json';
  import fr from './locales/fr.json';
  import it from './locales/it.json';
  import ja from './locales/ja.json';
  import ptBR from './locales/pt-BR.json';
  import vi from './locales/vi.json';
  import zhCN from './locales/zh-CN.json';
  import zhTW from './locales/zh-TW.json';
  const h = React.createElement;
  const NOW = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const LEAD = 'lead-a';
  const row = (tag, overrides) => ({
    tag, agent: 'worker', sessionId: 's-' + tag, ownerSessionId: LEAD, parentSessionId: LEAD,
    title: tag, provider: 'anthropic', model: 'claude-opus-4-5', effort: 'auto',
    status: 'idle', stage: 'idle', startedAt: NOW - 50_000, idleSince: iso(NOW - 10_000), ...overrides,
  });
  // 17 agents like the report: 1 running, 1 queued, 15 resting (clearable).
  const rows = [
    { tag: 'lead:' + LEAD, agent: 'lead', sessionId: LEAD, ownerSessionId: LEAD, status: 'running', stage: 'running', startedAt: NOW - 60_000 },
    row('feat-approval-button-ui-with-a-really-long-branch-name', { status: 'running', stage: 'running', idleSince: null, turnStartedAt: NOW - 583_000 }),
    row('queued-one', { status: 'queued', stage: 'queued', idleSince: null }),
    row('needs-approval', { status: 'running', stage: 'running', idleSince: null, turnStartedAt: NOW - 5_000, awaitingUser: 'approval' }),
    row('long-route', { model: 'a-model-whose-name-is-far-too-long-to-fit-in-a-phone-row-at-all', effort: 'high', idleSince: null, status: 'running', stage: 'running', turnStartedAt: NOW - 3_723_000 }),
    ...Array.from({ length: 13 }, (_, i) => row('rested-' + i)),
  ];
  const sessions = Object.fromEntries(rows.map((r, i) => [r.sessionId, {
    turns: 3, tokens: 67_751_234 + i, input: 1000, cacheRead: 5000, cacheWrite: 10, unmeasuredTurns: 0, costUsd: 1, costUnpricedTurns: 0,
  }]));
  const usage = {
    turns: 9, tokens: 200_000_000, input: 1000, cacheRead: 98000, cacheWrite: 10, unmeasuredTurns: 0, costUsd: 120.5, costUnpricedTurns: 0,
    agents: { turns: 20, tokens: 580_000_000, input: 1000, cacheRead: 98000, cacheWrite: 10, unmeasuredTurns: 0, costUsd: 178.85, costUnpricedTurns: 0 },
    sessions,
  };
  // __usageGate holds getSessionUsage so the loading footer can be measured.
  window.mixdogDesktop = new Proxy({
    listAgentPool: async () => rows,
    invokeCapability: async () => { if (window.__usageGate) await window.__usageGate; return { value: usage }; },
  }, {
    get: (target, name) => name in target ? target[name]
      : String(name).startsWith('subscribe') ? () => () => {} : async () => [],
  });
  let root = null;
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const geometry = () => {
    const rect = (node) => { const b = node.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((n) => Math.round(n * 2) / 2); };
    const panel = document.querySelector('.composer-island-panel');
    const summary = panel.querySelector('.composer-island-summary');
    return {
      panel: rect(panel),
      firstRow: rect(panel.querySelector('.composer-island-agent-item')),
      summary: rect(summary),
      stats: [...summary.children].map(rect),
      text: summary.textContent,
      overflow: summary.scrollWidth - summary.clientWidth,
    };
  };
  // Opens the panel with getSessionUsage held, records the footer's geometry
  // (the "-" placeholders), releases the answer and records it again.
  window.__renderHeld = async (language) => {
    let release;
    window.__usageGate = new Promise((r) => { release = r; });
    await window.__render(language, true);
    await settle(400);
    const loading = geometry();
    release();
    window.__usageGate = null;
    for (let i = 0; i < 60 && (document.querySelector('.composer-island-summary b')?.textContent ?? '-') === '-'; i++) await settle(50);
    await settle(400);
    return { loading, data: geometry() };
  };
  window.__render = async (language, held) => {
    if (root) { root.unmount(); root = null; }
    const catalogs = { ko, de, ru, es, fr, it, ja, 'pt-BR': ptBR, vi, 'zh-CN': zhCN, 'zh-TW': zhTW };
    if (language !== 'en') i18next.addResourceBundle(language, 'translation', catalogs[language]);
    await i18next.changeLanguage(language);
    root = createRoot(document.getElementById('host'));
    flushSync(() => root.render(h(React.Fragment, null,
      h('div', { className: 'transcript-shell', style: { flex: '1 1 0', minHeight: 0 } }),
      h(ComposerDock, {
        sessionId: LEAD, reviewSessionId: LEAD, goalSubmissionId: '', showProjectSelector: false,
        reviewItems: [], reviewActive: true, reviewBusy: false, reviewCwd: '',
        children: h('form', { className: 'composer', style: { height: '96px' } }),
      }))));
    for (let i = 0; i < 40 && !document.querySelector('.composer-island-seg-agents'); i++) await new Promise((r) => setTimeout(r, 50));
    document.querySelector('.composer-island-seg-agents').click();
    if (held) { for (let i = 0; i < 60 && !document.querySelector('.composer-island-summary'); i++) await settle(50); return; }
    for (let i = 0; i < 60 && (document.querySelector('.composer-island-summary b')?.textContent ?? '-') === '-'; i++) await settle(50);
    await new Promise((r) => setTimeout(r, 400));
  };
  window.__measure = () => {
    const box = (node) => node.getBoundingClientRect();
    const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const name = (node) => (node.className?.baseVal ?? node.className) + ':' + (node.textContent || '').trim().slice(0, 24);
    const panel = document.querySelector('.composer-island-panel');
    const head = panel.querySelector('.composer-island-phead');
    const meta = head.querySelector('.composer-island-phead-meta');
    const leaves = [
      head.querySelector('.composer-island-tab'),
      ...(meta ? [...meta.children] : []),
      head.querySelector('.composer-island-phead-action'),
      head.querySelector('.composer-island-close'),
    ].filter(Boolean);
    const overlaps = [];
    for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
      if (overlap(box(leaves[i]), box(leaves[j]))) overlaps.push(name(leaves[i]) + ' × ' + name(leaves[j]));
    }
    const p = box(panel);
    const frame = box(document.querySelector('.composer-island'));
    const clipped = leaves.filter((node) => {
      const r = box(node);
      const m = box(head);
      return r.left < m.left - 0.5 || r.right > m.right + 0.5 || node.scrollWidth > node.clientWidth + 1;
    }).map(name);
    const metaClipped = meta ? meta.scrollWidth > meta.clientWidth + 1 || box(meta).right > box(head).right + 0.5 : false;
    const hiddenByAncestor = (node) => {
      for (let a = node.parentElement; a && a !== panel; a = a.parentElement) {
        if (getComputedStyle(a).overflowX === 'hidden') return true;
      }
      return false;
    };
    const outside = [...panel.querySelectorAll('*')].filter((node) => {
      if (hiddenByAncestor(node)) return false;
      const r = box(node);
      return r.width > 0 && (r.left < p.left - 0.5 || r.right > p.right + 0.5);
    }).map(name);
    const action = head.querySelector('.composer-island-phead-action');
    const close = head.querySelector('.composer-island-close');
    const size = (node) => node ? { w: box(node).width, h: box(node).height } : null;
    const items = [...panel.querySelectorAll('.composer-island-agent-item')];
    const rowOverlaps = [];
    for (const item of items) {
      const it = box(item);
      const copy = item.querySelector('.schedules-row-copy');
      const status = item.querySelector('.agent-activity-status');
      const tokens = item.querySelector('.composer-island-agent-tokens');
      const parts = [status, tokens].filter(Boolean);
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
        // Line boxes touch by a pixel or two; only real vertical sharing counts.
      const core = (n) => { const r = box(n); return { left: r.left, right: r.right, top: r.top + 3, bottom: r.bottom - 3 }; };
      if (overlap(core(parts[i]), core(parts[j]))) rowOverlaps.push(name(parts[i]) + ' × ' + name(parts[j]));
      }
      // The text itself (not just its flex box) must stay clear of the right column.
      const right = [status, tokens].filter(Boolean).map(box);
      for (const text of item.querySelectorAll('.agent-pool-name, .model-route-label')) {
        const range = document.createRange();
        range.selectNodeContents(text);
        const t = range.getBoundingClientRect();
        const visible = { left: t.left, right: Math.min(t.right, box(text).right), top: t.top, bottom: t.bottom };
        if (right.some((r) => overlap(visible, r))) rowOverlaps.push('text ' + name(text));
      }
      if (box(status).right > it.right + 0.5 || (tokens && box(tokens).right > it.right + 0.5)) rowOverlaps.push('right column leaves the row');
    }
    const names = [...panel.querySelectorAll('.agent-pool-name')];
    const summary = panel.querySelector('.composer-island-summary');
    const parts = [...summary.children];
    const summaryOverlaps = [];
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      if (overlap(box(parts[i]), box(parts[j]))) summaryOverlaps.push(name(parts[i]) + ' × ' + name(parts[j]));
    }
    return {
      viewport: innerWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      panel: { width: p.width, frame: frame.width, left: p.left, overflow: panel.scrollWidth - panel.clientWidth },
      head: { height: box(head).height, overflow: head.scrollWidth - head.clientWidth },
      metaTexts: meta ? [...meta.children].map((n) => n.textContent) : [],
      actionLabel: action?.textContent ?? null,
      overlaps, clipped, metaClipped, outside,
      // The tap area: the box, or the invisible pad (::after) it carries.
      action: action && {
        w: box(action).width,
        h: Math.max(box(action).height, parseFloat(getComputedStyle(action, '::after').height) || 0),
      },
      close: size(close),
      rows: items.length,
      rowOverlaps,
      namesEllipsize: names.every((n) => getComputedStyle(n).textOverflow === 'ellipsis' && getComputedStyle(n).overflow === 'hidden'),
      summary: { overflow: summary.scrollWidth - summary.clientWidth, overlaps: summaryOverlaps, text: summary.textContent },
    };
  };
`;

/** Every broken invariant of one measurement, so a run lists them all. */
function problems(label, m, phone) {
  const found = [];
  const expect = (ok, what) => {
    if (!ok) found.push(`${label}: ${what}`);
  };
  expect(m.rows >= 17 && m.metaTexts.length >= 2, `the agents and their counts show (${m.rows} rows)`);
  expect(m.overlaps.length === 0, `header children overlap: ${m.overlaps}`);
  expect(m.clipped.length === 0, `header text or button clipped: ${m.clipped}`);
  expect(!m.metaClipped, `the counts are clipped (${m.metaTexts})`);
  expect(m.pageOverflow <= 0, `the page overflows by ${m.pageOverflow}px`);
  expect(m.panel.overflow <= 0 && m.head.overflow <= 0, `panel/header overflow ${m.panel.overflow}/${m.head.overflow}`);
  expect(m.outside.length === 0, `pokes out of the panel: ${m.outside}`);
  expect(m.rowOverlaps.length === 0, `row text under the right column: ${m.rowOverlaps}`);
  expect(m.namesEllipsize, 'row titles ellipsize');
  expect(m.summary.overflow <= 0 && m.summary.overlaps.length === 0, `footer overflow/overlap ${m.summary.overlaps}`);
  if (phone) {
    expect(
      m.action && m.action.w >= 44 && m.action.h >= 44,
      `Clear finished is ${JSON.stringify(m.action)}, not a 44px target`
    );
    expect(m.close && m.close.w >= 44 && m.close.h >= 44, `Close is ${JSON.stringify(m.close)}, not a 44px target`);
  }
  return found;
}

/** The footer is laid out before getSessionUsage answers: the same boxes hold
 *  its "-" placeholders and then the measured figures, nothing moves, and
 *  nothing overflows sideways. */
function stabilityProblems(label, { loading, data }) {
  const found = [];
  const same = (a, b) => a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) <= 0.5);
  const expect = (ok, what) => {
    if (!ok) found.push(`${label}: ${what}`);
  };
  expect(loading.stats.length === 3, `the three stats exist while loading (${loading.stats.length})`);
  expect(/-/.test(loading.text) && !/\d/.test(loading.text), `loading footer is "-" placeholders: ${loading.text}`);
  expect(!/\d/.test(loading.text) && /\d/.test(data.text), `data footer carries the figures: ${data.text}`);
  expect(same(loading.panel, data.panel), `panel moved ${loading.panel} -> ${data.panel}`);
  expect(same(loading.firstRow, data.firstRow), `rows moved ${loading.firstRow} -> ${data.firstRow}`);
  expect(same(loading.summary, data.summary), `footer moved ${loading.summary} -> ${data.summary}`);
  expect(
    loading.stats.length === data.stats.length && loading.stats.every((box, i) => same(box, data.stats[i])),
    `stat boxes moved ${JSON.stringify(loading.stats)} -> ${JSON.stringify(data.stats)}`
  );
  expect(loading.overflow <= 0 && data.overflow <= 0, `footer overflows ${loading.overflow}/${data.overflow}`);
  return found;
}

async function bundle(entry, loader) {
  return build({
    stdin: { contents: entry, resolveDir, loader },
    outfile: 'agent-panel-header.out',
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

test('the Agents popover header never overlaps or clips on a phone, in any language', async (t) => {
  const [script, styles] = await Promise.all([
    bundle(PAGE, 'tsx'),
    bundle('@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";', 'css'),
  ]);
  const js = script.outputFiles.find((file) => file.path.endsWith('.out')).text;
  const css = styles.outputFiles.find((file) => file.path.endsWith('.out')).text;
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  mkdirSync(SHOTS, { recursive: true });
  const tab = await browser.newPage();
  const errors = [];
  const failures = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mobileHtml = `<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${HOST}</body></html>`;

  for (const [width, height] of [
    [360, 800],
    [412, 915],
    [430, 932],
  ]) {
    await tab.setViewport({ width, height, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    for (const language of LANGUAGES) {
      // A fresh document first: the island remembers a session's last usage
      // answer, which would hide the loading state on a re-render.
      await tab.setContent(mobileHtml);
      await tab.addScriptTag({ content: js });
      const held = await tab.evaluate((lang) => window.__renderHeld(lang), language);
      failures.push(...stabilityProblems(`${language} @${width} loading->data`, held));
      await tab.evaluate((lang) => window.__render(lang), language);
      const m = await tab.evaluate(() => window.__measure());
      await tab.screenshot({ path: join(SHOTS, `${TAG}-${language}-${width}x${height}.png`) });
      failures.push(...problems(`${language} @${width}`, m, true));
    }
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
});

test('a narrow desktop pane gets the same header', async (t) => {
  const [script, styles] = await Promise.all([
    bundle(PAGE, 'tsx'),
    bundle('@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";', 'css'),
  ]);
  const js = script.outputFiles.find((file) => file.path.endsWith('.out')).text;
  const css = styles.outputFiles.find((file) => file.path.endsWith('.out')).text;
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const tab = await browser.newPage();
  const failures = [];
  await tab.setViewport({ width: 1400, height: 900 });
  const desktopHtml = `<!doctype html><html><head><style>${css}</style></head><body>${HOST}</body></html>`;
  // 560 is the panel's own width; the narrower ones are split panes and side panels.
  for (const paneWidth of [560, 480, 340]) {
    for (const language of ['en', ...LANGUAGES]) {
      await tab.setContent(desktopHtml);
      await tab.addScriptTag({ content: js });
      await tab.evaluate((width) => {
        document.querySelector('#host').style.width = `${width}px`;
      }, paneWidth);
      const held = await tab.evaluate((lang) => window.__renderHeld(lang), language);
      failures.push(...stabilityProblems(`desktop ${language} @${paneWidth} loading->data`, held));
      await tab.evaluate((lang) => window.__render(lang), language);
      const m = await tab.evaluate(() => window.__measure());
      failures.push(...problems(`desktop ${language} @${paneWidth}`, m, false));
    }
  }
  assert.deepEqual(failures, []);
});
