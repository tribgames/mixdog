import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const css = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const registered = (css('./font-faces.css').match(/@property[^}]*\}/g) ?? []).join('\n');
const STYLES = [
  registered,
  css('./ui/tokens.css'),
  css('./desktop/01-tokens.css'),
  // The row's flex box comes from styles.css; the app loads it first.
  css('./styles.css'),
  css('./desktop/13-tool-cards.css'),
  css('./desktop/22-markdown.css'),
].join('\n');

const TASK = 'task-toolu_01SL98suT4MEK9rL6LNT9Jhm~329';
const GREP = {
  pattern: 'account_blocked\\b|blocked_ms',
  path: 'native/core/crates',
  context: 2,
  offset: 12,
  limit: 12,
};
const COMMAND = [
  "$f = Join-Path $env:TEMP 'follow-live2.js'; Set-Content -LiteralPath $f -Encoding utf8 -Value @'",
  '(async () => { const wait=(ms)=>new Promise(r=>setTimeout(r,ms));',
  " const scroller=()=>[...document.querySelectorAll('.transcript')].find(n=>n.getClientRects().length>0);",
  ' return out; })()',
  "'@; node scripts/dom-eval.mjs --port=9825 $f",
].join('\n');
const BACKGROUND = [
  'background task',
  `task_id: ${TASK}`,
  "label: $f = Join-Path $env:TEMP 'follow-live2.js'; Set-Content -LiteralPath $f -Encoding utf8 -Value @' (async () => { const wa",
  'status: running',
  'moved to background on new user input after 0s; still running.',
].join('\n');
const OUTPUT = 'exit code: 0, duration: 5.5s\n[stdout]\n{\n "entered": 478\n}\n';
const NOTIFICATION = [
  '<task-notification>',
  `<task-id>${TASK}</task-id>`,
  '<status>completed</status>',
  '<exit-code>0</exit-code>',
  "<summary>Shell task completed (exit 0): $f = Join-Path $env:TEMP 'follow-live2.js'; Set-Content -LiteralPath $f -Encoding utf8 -Value @' (async () =&gt; { const wait=(ms)=&gt;new Promise(r=&gt;setTimeout(r,ms)…</summary>",
  `<output-file>C:/Users/tempe/.mixdog/data/scratch/jobs/${TASK}.stdout.log</output-file>`,
  `<result>\n${OUTPUT}\n</result>`,
  '</task-notification>',
].join('\n');

// Each row as it was stored: a background run's completion carries no command
// (its detail is its status and id), and a search still running has no result yet.
const ROWS = [
  {
    item: {
      kind: 'tool',
      id: '01a207e9-aca6-7088-a79e-7359ff6cf355',
      name: 'shell',
      args: { type: 'result', status: 'completed', task_id: TASK, surface: 'shell' },
      result: OUTPUT,
      rawResult: NOTIFICATION,
      isError: false,
      count: 1,
      completedCount: 1,
      startedAt: 2,
      completedAt: 2,
    },
    verb: '실행',
    detail: '완료 · NT9Jhm~329',
  },
  { item: { kind: 'tool', id: 'grep-running', name: 'grep', args: GREP }, verb: '검색', detail: `"${GREP.pattern}"` },
  {
    item: {
      kind: 'tool',
      id: 'grep',
      name: 'grep',
      args: GREP,
      result: '[0 of 11 shown; offset:12 past end]',
      completedAt: 3,
    },
    verb: '검색',
    detail: `"${GREP.pattern}"`,
  },
  {
    item: {
      kind: 'tool',
      id: 'shell',
      name: 'shell',
      args: { command: COMMAND, cwd: 'C:\\Project\\mixdog\\apps\\desktop', timeout_ms: 60000 },
      result: BACKGROUND,
      completedAt: 4,
    },
    verb: '실행',
    detail: "$f = Join-Path $env:TEMP 'follow-live2.js';",
  },
];

const PAGE = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import i18n from './i18n.ts';
  import ko from './locales/ko.json';
  import { ToolActivityGroup } from './transcript-tool-ui.tsx';
  const items = ${JSON.stringify(ROWS.map((row) => row.item))};
  for (const item of items) if (!item.completedAt) item.at = Date.now();
  i18n.addResourceBundle('ko', 'translation', ko, true, false);
  i18n.changeLanguage('ko').then(() => {
    createRoot(document.getElementById('root')).render(
      React.createElement(ToolActivityGroup, { items, disclosureScope: 'sess-row-layout' })
    );
  });
  window.__rows = () =>
    [...document.querySelectorAll('.tool-activity-item-header')].map((header) => {
      const verb = header.querySelector('.tool-activity-item-title b');
      const detail = header.querySelector('.tool-activity-item-title small, .tool-activity-item-result');
      return {
        verb: verb.textContent,
        verbWhole: verb.scrollWidth <= verb.clientWidth,
        detail: detail ? detail.textContent : '',
        detailWidth: detail ? detail.clientWidth : 0,
        right: header.getBoundingClientRect().right,
      };
    });
`;

async function page(t) {
  const bundle = await build({
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
    stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx' },
    outfile: 'transcript-tool-row-layout.js',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const tab = await browser.newPage();
  await tab.setViewport({ width: 900, height: 900 });
  await tab.setContent(`<!doctype html><html><head><style>
    body { margin: 0; font-family: sans-serif; }
    ${STYLES}
  </style></head><body><div id="root" style="width:720px"></div></body></html>`);
  await tab.addScriptTag({ content: script });
  await tab.waitForSelector('.tool-activity-header');
  await tab.click('.tool-activity-header');
  await tab.waitForFunction((count) => window.__rows().length === count, {}, ROWS.length);
  return tab;
}

test('every tool row keeps its verb whole and shows its detail, wide and narrow', async (t) => {
  const tab = await page(t);
  for (const width of [720, 260]) {
    await tab.evaluate((w) => {
      document.getElementById('root').style.width = `${w}px`;
    }, width);
    const rows = await tab.evaluate(() => window.__rows());
    assert.deepEqual(
      rows.map((row, index) => ({
        verb: row.verb,
        verbWhole: row.verbWhole,
        detail: row.detail.startsWith(ROWS[index].detail) && row.detailWidth > 0,
        inColumn: row.right <= width,
      })),
      ROWS.map((row) => ({ verb: row.verb, verbWhole: true, detail: true, inColumn: true })),
      `${width}px: ${JSON.stringify(rows.map((row) => row.detail))}`
    );
  }
});
