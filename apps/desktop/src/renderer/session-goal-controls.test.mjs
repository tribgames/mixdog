import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import puppeteer from 'puppeteer-core';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';

// The Goal renders as a segment of the composer island; these fixtures give
// it that frame.
const islandFrame = (markup) =>
  `<div class="composer-island" data-expanded="goal"><div class="composer-island-pill">${markup}</div></div>`;

// The DOM suite owns actions and confirmation. This browser check owns
// geometry: in the open Goal tab all three controls remain visible in one
// row under the task list, regardless of drawer overflow or a narrow pane.
test('Goal tab controls stay in one visible row under the task list', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const css = (
    await Promise.all(
      ['./desktop/15-composer.css', './desktop/22-markdown.css'].map((path) =>
        readFile(new URL(path, import.meta.url), 'utf8')
      )
    )
  ).join('\n');
  const markup = islandFrame(
    renderToStaticMarkup(
      React.createElement(SessionGoalIsland, {
        snapshot: {
          sessionId: 'layout-test',
          goal: {
            id: 'goal',
            status: 'duration_reached',
            title: 'Continue workflow stabilization with a long goal title',
            objective: 'Finish the approved verification work',
            timeLimitMs: 3_600_000,
            timeUsedMs: 3_600_000,
            remainingMs: 0,
            tasks: Array.from({ length: 24 }, (_, index) => ({
              id: String(index),
              status: 'pending',
              text: `Task ${index + 1}: retain the original evidence and verify every result before reporting completion.`,
            })),
          },
        },
      })
    )
  );
  for (const { width, mobile } of [
    { width: 900, mobile: false },
    { width: 320, mobile: false },
    { width: 390, mobile: true },
  ]) {
    await page.setViewport({ width, height: 760 });
    await page.setContent(`<!doctype html><html ${mobile ? 'data-mixdog-mobile-tabs' : ''}><head><style>
      :root {
        --mx-icon-md: 16px;
        --mx-font-category: 15px; --mx-font-minor: 14px; --mx-font-meta: 13px;
        --mx-line-emphasis: 22px; --mx-line-ui: 20px; --mx-line-minor: 18px;
        --mx-text: #ddd; --mx-text-muted: #aaa; --mx-border: #444;
        --mx-bg-base: #181818; --mx-workspace-sheet: #222; --mx-radius-pill: 999px;
      }
      body { margin: 0; font-family: sans-serif; }
      main { position: fixed; bottom: 32px; left: 0; right: 0; }
      ${css}
    </style></head><body><main>${markup}</main></body></html>`);
    // Measure the settled island, not its entrance scale.
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    await page.$eval('.session-goal-island', (island) => {
      island.dataset.open = 'true';
      const drawer = island.querySelector('.session-goal-drawer');
      drawer.inert = false;
      drawer.setAttribute('aria-hidden', 'false');
    });
    for (const scrollToEnd of [false, true]) {
      const layout = await page.$eval(
        '.session-goal-island',
        (island, scroll) => {
          const list = island.querySelector('.session-goal-content');
          list.scrollTop = scroll ? list.scrollHeight : 0;
          const rect = (element) => {
            const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
          };
          return {
            tasks: rect(list),
            controls: [...island.querySelectorAll('.session-goal-control')].map((control) => {
              const bounds = rect(control);
              const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
              return { ...bounds, hittable: control === hit || control.contains(hit) };
            }),
          };
        },
        scrollToEnd
      );
      const context = `${width}px mobile=${mobile} scrolled=${scrollToEnd}`;
      assert.equal(layout.controls.length, 3, context);
      let right = -Infinity;
      for (const control of layout.controls) {
        assert.ok(control.width > 0 && control.height > 0 && control.hittable, `${context}: visible and clickable`);
        assert.ok(control.x >= right - 1, `${context}: ordered left to right without overlap`);
        assert.ok(control.y >= layout.tasks.bottom - 1, `${context}: under the task list`);
        assert.ok(control.right <= width && control.y >= 0 && control.bottom <= 760, `${context}: inside viewport`);
        assert.ok(Math.abs(control.y - layout.controls[0].y) < 1, `${context}: same row`);
        if (mobile) assert.ok(control.height >= 44, `${context}: 44px tap target`);
        right = control.right;
      }
    }
  }
});

// The open Goal tab's pill rule must not beat the pill's [hidden]: the
// approval card and a flash take the island over, Goal included.
test('approval and flash modes hide the Goal pill even with the Goal tab open', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const css = (
    await Promise.all(
      ['./desktop/15-composer.css', './desktop/22-markdown.css', './desktop/27-search-review.css'].map((path) =>
        readFile(new URL(path, import.meta.url), 'utf8')
      )
    )
  ).join('\n');
  const goal = renderToStaticMarkup(
    React.createElement(SessionGoalIsland, {
      snapshot: {
        sessionId: 'hidden-test',
        goal: { id: 'goal', status: 'active', objective: 'Hide under approval', tasks: [] },
      },
    })
  );
  for (const mode of ['approval', 'flash']) {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
      <div class="composer-island" data-mode="${mode}" data-expanded="goal">
        <div class="composer-island-${mode}">${mode}</div>
        <div class="composer-island-pill" hidden>${goal}</div>
      </div></body></html>`);
    const view = await page.$eval('.composer-island-pill', (pill) => ({
      display: getComputedStyle(pill).display,
      goalHeight: pill.querySelector('.session-goal-island').getBoundingClientRect().height,
    }));
    assert.equal(view.display, 'none', `${mode}: the pill stays hidden`);
    assert.equal(view.goalHeight, 0, `${mode}: the Goal does not render`);
  }
});

// The empty-island gate must count every kind of content: a quota panel or
// the expanded files list alone still shows the island.
test('an island carrying only the quota panel or the expanded files list stays visible', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const css = (
    await Promise.all(
      ['./desktop/15-composer.css', './desktop/27-search-review.css'].map((path) =>
        readFile(new URL(path, import.meta.url), 'utf8')
      )
    )
  ).join('\n');
  const cases = {
    empty: '<div class="composer-island-pill"></div>',
    quota:
      '<div class="composer-island-pill" hidden></div><section class="composer-island-panel composer-island-quota">limit</section>',
    files: '<div class="composer-island-pill"><div class="turn-review-bar" data-expanded="true">files</div></div>',
  };
  for (const [name, inner] of Object.entries(cases)) {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
      <div class="composer-island"${name === 'files' ? ' data-expanded="files"' : ''}>${inner}</div></body></html>`);
    const visibility = await page.$eval('.composer-island', (island) => getComputedStyle(island).visibility);
    assert.equal(visibility, name === 'empty' ? 'hidden' : 'visible', name);
  }
});

test('expanded Goal separates title, task copy, and supporting text with the existing UI font', async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
        @import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
        @import "./font-faces.css";
        @import "./ui/tokens.css";
        @import "./desktop.css";
      `,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
    },
    outfile: 'goal-typography.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const tasks = [
    {
      id: 'en',
      status: 'in_progress',
      text: 'Preserve prior measurements and inspect costly traces to identify a bounded change, then verify the result without weakening the approved requirements.',
    },
    {
      id: 'ko',
      status: 'pending',
      text: '기존 측정 결과와 작업 기록을 보존하고 Goal UI의 긴 한글·영문 문장이 좁은 화면에서도 편하게 읽히는지 확인합니다.',
    },
  ];
  for (const width of [900, 320]) {
    for (const empty of [false, true]) {
      const markup = islandFrame(
        renderToStaticMarkup(
          React.createElement(SessionGoalIsland, {
            snapshot: {
              sessionId: 'typography-test',
              goal: {
                id: 'typography',
                status: 'paused',
                title: 'Goal UI 글자 위계 정리',
                objective: 'Verify the agreed typography',
                timeMode: 'max',
                timeLimitMs: 3_600_000,
                timeUsedMs: 60_000,
                remainingMs: 3_540_000,
                tasks: empty ? [] : tasks,
                blocker: '승인 대기 — waiting for approval',
              },
            },
          })
        )
      );
      await page.setViewport({ width, height: 800 });
      await page.setContent(`<!doctype html><html><head></head><body>
        <main style="position:fixed;bottom:32px;left:0;right:0">${markup}</main>
      </body></html>`);
      await page.addStyleTag({ content: bundle.outputFiles[0].text });
      const view = await page.$eval('.session-goal-island', async (island) => {
        island.dataset.open = 'true';
        const drawer = island.querySelector('.session-goal-drawer');
        drawer.inert = false;
        drawer.setAttribute('aria-hidden', 'false');
        await document.fonts.ready;
        // Measure the settled island, not its entrance scale.
        await Promise.all(document.getAnimations().map((animation) => animation.finished));
        const typography = (element) => {
          const style = getComputedStyle(element);
          return {
            family: style.fontFamily,
            size: style.fontSize,
            weight: style.fontWeight,
            line: style.lineHeight,
            color: style.color,
          };
        };
        return {
          title: typography(island.querySelector('.session-goal-title')),
          supporting: [
            ...island.querySelectorAll('.session-goal-meta-time, .session-goal-objective-full, .session-goal-empty'),
          ].map((element) => ({
            ...typography(element),
            time: element.matches('.session-goal-meta-time'),
            objective: element.matches('.session-goal-objective-full'),
          })),
          tasks: [...island.querySelectorAll('.session-goal-tasks li')].map((row) => {
            const copy = row.querySelector('div > span');
            const icon = row.querySelector(':scope > span');
            return {
              ...typography(copy),
              current: row.dataset.status === 'in_progress',
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
      // The Goal title reads at the v2 mockup's bold 15/21 line.
      assert.deepEqual([view.title.size, view.title.weight, view.title.line], ['15px', '600', '21px'], context);
      for (const entry of [view.title, ...view.supporting, ...view.tasks]) {
        assert.ok(entry.family.startsWith('"Pretendard Variable"'), `${context}: shared Korean and Latin family`);
      }
      for (const entry of view.supporting) {
        // The tab's time keeps the segment's 14/20 line in muted ink; the objective is 13/19, the rest 13/18.
        const expected = entry.time
          ? ['14px', '400', '20px']
          : entry.objective
            ? ['13px', '400', '19px']
            : ['13px', '400', '18px'];
        assert.deepEqual([entry.size, entry.weight, entry.line], expected, context);
        assert.notEqual(entry.color, view.title.color, `${context}: supporting text is visually secondary`);
      }
      for (const entry of view.tasks) {
        // The running row reads at the label weight, as the mockup's current row does.
        assert.deepEqual(
          [entry.size, entry.weight, entry.line],
          ['14px', entry.current ? '500' : '400', '20px'],
          context
        );
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
        createRoot(document.querySelector('.composer-island-pill')).render(React.createElement(SessionGoalIsland, {
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
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const css = (
    await Promise.all(
      ['./desktop/15-composer.css', './desktop/22-markdown.css'].map((path) =>
        readFile(new URL(path, import.meta.url), 'utf8')
      )
    )
  ).join('\n');
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });
  await page.setContent(`<!doctype html><html><head><style>
    :root {
      --mx-icon-md: 16px;
      --mx-font-category: 15px; --mx-font-minor: 14px; --mx-font-meta: 13px;
      --mx-line-emphasis: 22px; --mx-line-ui: 20px; --mx-line-minor: 18px;
      --mx-text: #ddd; --mx-text-muted: #aaa; --mx-border: #444;
      --mx-bg-base: #181818; --mx-workspace-sheet: #222; --mx-radius-pill: 999px;
    }
    body { margin: 0; font-family: sans-serif; }
    ${css}
    /* The composer stack the island sits on: whatever leaves the panel's
       clip lands on this surface instead of the button the user aimed at. */
    .composer-region { position: fixed; right: 0; bottom: 0; left: 0; padding: 0 12px 16px; }
    .composer-input { height: 96px; }
  </style></head><body>
    <div class="composer-region">
      <div class="composer-island-slot"><div class="composer-island-stage">
        <div class="composer-island" data-expanded="goal"><div class="composer-island-pill"></div></div>
      </div></div>
      <div class="composer-input"></div>
    </div>
  </body></html>`);
  await page.addScriptTag({ content: script });
  await page.waitForSelector('.session-goal-trigger');
  await page.click('.session-goal-trigger');
  await page.waitForSelector('.session-goal-controls .session-goal-control:first-child', { visible: true });
  await page.click('.session-goal-controls .session-goal-control:first-child');
  await page.waitForSelector('.session-goal-confirm');
  const confirm = '.session-goal-confirm .session-goal-actions button:last-child';
  const reachable = await page.$eval(confirm, (button) => {
    const { x, y, width, height } = button.getBoundingClientRect();
    const hit = document.elementFromPoint(x + width / 2, y + height / 2);
    return {
      covering: hit === button || button.contains(hit) ? '' : hit?.className || hit?.tagName || 'nothing',
      inside:
        button.getBoundingClientRect().bottom <=
        document.querySelector('.session-goal-panel').getBoundingClientRect().bottom + 1,
    };
  });
  assert.equal(reachable.covering, '', 'the stop confirmation must receive the press itself');
  assert.equal(reachable.inside, true, 'the stop confirmation must stay inside the drawer it opened in');
  // Cancel and confirm sit at the row's right end, as every other confirmation row does.
  const trailingGap = await page.$eval(confirm, (button) => {
    const row = button.closest('.session-goal-actions').getBoundingClientRect();
    return row.right - button.getBoundingClientRect().right;
  });
  assert.ok(Math.abs(trailingGap) < 0.5, `the stop confirmation buttons are right-aligned (gap ${trailingGap})`);
  await page.click(confirm);
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(
    calls.at(-1),
    {
      sessionId: 'stop-confirm',
      capability: 'goalControl',
      args: [{ action: 'stop', expectedGoalId: 'long-goal' }],
    },
    'confirming stop sends the stop action for this session'
  );
});
