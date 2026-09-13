import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import puppeteer from 'puppeteer-core';
import { SessionGoalHost, SessionGoalIsland } from './SessionGoalIsland.tsx';

// The DOM suite owns actions and confirmation. This browser check owns
// geometry: all three controls must remain visible beside the summary,
// regardless of drawer overflow or a narrow composer.
test('Goal controls stay in one visible row to the right of the summary', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const css = await readFile(new URL('./desktop/22-markdown.css', import.meta.url), 'utf8');
  const markup = renderToStaticMarkup(React.createElement(SessionGoalHost, { placement: 'composer' },
    React.createElement(SessionGoalIsland, {
      snapshot: {
        sessionId: 'layout-test',
        goal: {
          id: 'goal', status: 'duration_reached',
          title: 'Continue workflow stabilization with a long goal title',
          objective: 'Finish the approved verification work',
          timeLimitMs: 3_600_000, timeUsedMs: 3_600_000, remainingMs: 0,
          tasks: Array.from({ length: 24 }, (_, index) => ({
            id: String(index), status: 'pending',
            text: `Task ${index + 1}: retain the original evidence and verify every result before reporting completion.`,
          })),
        },
      },
    })));
  for (const { width, mobile, scale } of [
    { width: 900, mobile: false, scale: 1 },
    { width: 320, mobile: false, scale: 1 },
    { width: 980, mobile: true, scale: 2.5 },
    { width: 390, mobile: true, scale: 1 },
  ]) {
    await page.setViewport({ width, height: 760 });
    await page.setContent(`<!doctype html><html ${mobile ? 'data-mixdog-mobile-tabs' : ''}><head><style>
      :root {
        --mx-device-scale: ${scale}; --mx-icon-md: 16px;
        --mx-font-category: 15px; --mx-font-minor: 14px; --mx-font-meta: 13px;
        --mx-line-emphasis: 22px; --mx-line-ui: 20px; --mx-line-minor: 18px;
        --mx-text: #ddd; --mx-text-muted: #aaa; --mx-border: #444;
        --mx-bg-base: #181818; --mx-workspace-sheet: #222; --mx-radius-pill: 999px;
      }
      body { margin: 0; font-family: sans-serif; }
      main { position: fixed; bottom: 32px; left: 0; right: 0; }
      ${css}
    </style></head><body><main>${markup}</main></body></html>`);
    for (const open of [false, true]) {
      await page.$eval('.session-goal-island', (island, expanded) => {
        island.dataset.open = String(expanded);
        const drawer = island.querySelector('.session-goal-drawer');
        drawer.inert = !expanded;
        drawer.setAttribute('aria-hidden', String(!expanded));
      }, open);
      for (const scrollToEnd of open ? [false, true] : [false]) {
        const layout = await page.$eval('.session-goal-island', (island, scroll) => {
          const list = island.querySelector('.session-goal-task-list');
          list.scrollTop = scroll ? list.scrollHeight : 0;
          const rect = (element) => {
            const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
          };
          return {
            trigger: rect(island.querySelector('.session-goal-trigger')),
            controls: [...island.querySelectorAll('.session-goal-control')].map((control) => {
              const bounds = rect(control);
              const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
              return { ...bounds, hittable: control === hit || control.contains(hit) };
            }),
          };
        }, scrollToEnd);
        const context = `${width}px mobile=${mobile} open=${open} scrolled=${scrollToEnd}`;
        assert.equal(layout.controls.length, 3, context);
        let right = layout.trigger.right;
        for (const control of layout.controls) {
          assert.ok(control.width > 0 && control.height > 0 && control.hittable, `${context}: visible and clickable`);
          assert.ok(control.x >= right - 1, `${context}: ordered to the right without overlap`);
          assert.ok(control.right <= width && control.y >= 0 && control.bottom <= 760, `${context}: inside viewport`);
          assert.ok(Math.abs((control.y + control.height / 2)
            - (layout.trigger.y + layout.trigger.height / 2)) < 1, `${context}: same row`);
          right = control.right;
        }
      }
    }
  }
});

test('expanded Goal separates title, task copy, and supporting text with the existing UI font', async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
        @import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
        @import "./ui/tokens.css";
        @import "./desktop.css";
      `,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
    },
    outfile: 'goal-typography.css',
    bundle: true, write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const tasks = [
    { id: 'en', status: 'in_progress', text: 'Preserve prior measurements and inspect costly traces to identify a bounded change, then verify the result without weakening the approved requirements.' },
    { id: 'ko', status: 'pending', text: '기존 측정 결과와 작업 기록을 보존하고 Goal UI의 긴 한글·영문 문장이 좁은 화면에서도 편하게 읽히는지 확인합니다.' },
  ];
  for (const width of [900, 320]) {
    for (const empty of [false, true]) {
      const markup = renderToStaticMarkup(React.createElement(SessionGoalHost, { placement: 'composer' },
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'typography-test',
            goal: {
              id: 'typography', status: 'paused', title: 'Goal UI 글자 위계 정리',
              objective: 'Verify the agreed typography',
              timeMode: 'max', timeLimitMs: 3_600_000, timeUsedMs: 60_000, remainingMs: 3_540_000,
              tasks: empty ? [] : tasks,
              blocker: '승인 대기 — waiting for approval',
            },
          },
        })));
      await page.setViewport({ width, height: 800 });
      await page.setContent(`<!doctype html><html><head></head><body>
        <main style="position:fixed;bottom:32px;left:0;right:0">${markup}</main>
      </body></html>`);
      await page.addStyleTag({ content: bundle.outputFiles[0].text });
      const view = await page.$eval('.session-goal-island', async island => {
        island.dataset.open = 'true';
        const drawer = island.querySelector('.session-goal-drawer');
        drawer.inert = false;
        drawer.setAttribute('aria-hidden', 'false');
        await document.fonts.ready;
        const typography = element => {
          const style = getComputedStyle(element);
          return {
            family: style.fontFamily, size: style.fontSize, weight: style.fontWeight,
            line: style.lineHeight, color: style.color,
          };
        };
        return {
          title: typography(island.querySelector('.session-goal-objective')),
          supporting: [...island.querySelectorAll('.session-goal-meta, .session-goal-details, .session-goal-empty, .session-goal-blocker')]
            .map(typography),
          tasks: [...island.querySelectorAll('.session-goal-tasks li')].map(row => {
            const copy = row.querySelector('div > span');
            const icon = row.querySelector(':scope > span');
            return {
              ...typography(copy),
              fits: copy.scrollWidth <= copy.clientWidth,
              iconLine: icon.getBoundingClientRect().height,
              topDifference: Math.abs(copy.getBoundingClientRect().top - icon.getBoundingClientRect().top),
            };
          }),
          fontLoaded: document.fonts.check('14px "Pretendard Variable"', 'Goal 목표'),
        };
      });
      const context = `${width}px empty=${empty}`;
      assert.equal(view.fontLoaded, true, context);
      assert.deepEqual([view.title.size, view.title.weight, view.title.line], ['15px', '600', '22px'], context);
      for (const entry of [view.title, ...view.supporting, ...view.tasks]) {
        assert.ok(entry.family.startsWith('"Pretendard Variable"'), `${context}: shared Korean and Latin family`);
      }
      for (const entry of view.supporting) {
        assert.deepEqual([entry.size, entry.weight, entry.line], ['13px', '400', '18px'], context);
        assert.notEqual(entry.color, view.title.color, `${context}: supporting text is visually secondary`);
      }
      for (const entry of view.tasks) {
        assert.deepEqual([entry.size, entry.weight, entry.line], ['14px', '400', '20px'], context);
        assert.equal(entry.fits, true, `${context}: long text wraps without horizontal clipping`);
        assert.equal(entry.iconLine, 20, `${context}: task glyph follows the first text line`);
        assert.ok(entry.topDifference < 1, `${context}: icon and first line align`);
      }
    }
  }
});

// A checklist taller than the drawer's own height used to push the stop
// confirmation past the panel's clip: the button existed and answered every
// DOM query, but the press landed on the composer behind it, so stopping a
// long-running Goal silently did nothing (user: 골 중단버튼이 안 눌려). Only a
// real press at real coordinates proves the confirmation is reachable.
test('stopping a Goal with a long checklist keeps its confirmation pressable', async (t) => {
  const bundle = await build({
    // Vite-only `?worker` imports carry no esbuild meaning, and the capsule
    // never reaches a Monaco worker at runtime.
    plugins: [{
      name: 'worker-stub',
      setup(builder) {
        builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
          contents: 'export default class {};', loader: 'js',
        }));
      },
    }],
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { SessionGoalIsland } from './SessionGoalIsland.tsx';
        window.__calls = [];
        window.mixdogDesktop = {
          invokeCapability: async (request) => {
            window.__calls.push(request);
            return { value: { ok: true } };
          },
        };
        createRoot(document.querySelector('.session-goal-host')).render(React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'stop-confirm',
            goal: {
              id: 'long-goal', status: 'active', objective: 'Finish the approved verification work',
              timeLimitMs: 3600000, timeUsedMs: 120000, remainingMs: 3480000,
              tasks: Array.from({ length: 24 }, (_, index) => ({
                id: String(index), status: index === 0 ? 'in_progress' : 'pending',
                text: 'Task ' + (index + 1) + ': retain the original evidence and verify every result before reporting completion.',
              })),
            },
          },
        }));
      `,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
    },
    outfile: 'goal-stop-confirmation.js',
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const css = await readFile(new URL('./desktop/22-markdown.css', import.meta.url), 'utf8');
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });
  await page.setContent(`<!doctype html><html><head><style>
    :root {
      --mx-device-scale: 1; --mx-icon-md: 16px;
      --mx-font-category: 15px; --mx-font-minor: 14px; --mx-font-meta: 13px;
      --mx-line-emphasis: 22px; --mx-line-ui: 20px; --mx-line-minor: 18px;
      --mx-text: #ddd; --mx-text-muted: #aaa; --mx-border: #444;
      --mx-bg-base: #181818; --mx-workspace-sheet: #222; --mx-radius-pill: 999px;
    }
    body { margin: 0; font-family: sans-serif; }
    /* The composer stack the capsule sits on: whatever leaves the drawer's
       clip lands on this surface instead of the button the user aimed at. */
    .composer-region { position: fixed; right: 0; bottom: 0; left: 0; padding: 0 12px 16px; }
    .composer-input { height: 96px; }
    ${css}
  </style></head><body>
    <div class="composer-region">
      <div class="session-goal-host" data-goal-placement="composer"></div>
      <div class="composer-input"></div>
    </div>
  </body></html>`);
  await page.addScriptTag({ content: script });
  await page.waitForSelector('.session-goal-control');
  await page.click('.session-goal-controls .session-goal-control:last-child');
  await page.waitForSelector('.session-goal-confirm');
  const confirm = '.session-goal-confirm .session-goal-actions button:last-child';
  const reachable = await page.$eval(confirm, (button) => {
    const { x, y, width, height } = button.getBoundingClientRect();
    const hit = document.elementFromPoint(x + width / 2, y + height / 2);
    return {
      covering: hit === button || button.contains(hit) ? '' : (hit?.className || hit?.tagName || 'nothing'),
      inside: button.getBoundingClientRect().bottom
        <= document.querySelector('.session-goal-panel').getBoundingClientRect().bottom + 1,
    };
  });
  assert.equal(reachable.covering, '', 'the stop confirmation must receive the press itself');
  assert.equal(reachable.inside, true, 'the stop confirmation must stay inside the drawer it opened in');
  await page.click(confirm);
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls.at(-1), {
    sessionId: 'stop-confirm', capability: 'goalControl',
    args: [{ action: 'stop', expectedGoalId: 'long-goal' }],
  }, 'confirming stop sends the stop action for this session');
});
