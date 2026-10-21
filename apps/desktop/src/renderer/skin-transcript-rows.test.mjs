// Transcript rows under a skin, in a real Chrome against the app's own
// stylesheets: every plated row (assistant reply, tool roll-up open and
// closed, live status, turn-end line, compaction and error notices) shares the
// assistant plate's token background and its left/right edges with every card
// (question, changed files, approval, visualize, result), and its text holds
// 4.5:1 (icons 3:1) on every skin x plate x theme x transparency (default,
// max). Phone included. Set MIXDOG_ROWS_SHOTS=<dir> to write screenshots.
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { installTestDom } from './test-support/test-dom.mjs';
import { appStyles, measureIds, paintState } from './test-support/app-styles.mjs';
import { DEFAULT_TRANSPARENCY } from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';

const row = (tag, inner, extra = '') =>
  `<div class="transcript-virtual-row-content" data-tag="${tag}" ${extra}>${inner}</div>`;
const CARD = (id, cls) =>
  `<section class="${cls}" id="${id}" style="border:1px solid #888;padding:8px 12px">card ${id}</section>`;

const PAGE = `
  <div class="app-shell"><div class="desktop-body"><main class="main-panel">
    <div class="workspace" style="width: var(--qa-width, 1100px)"><div class="conversation"><div class="thread">
      ${row('UserMessage', '<article class="message user"><div class="message-body">Do the thing</div></article>')}
      ${row('AssistantPart', '<article class="message assistant settled" id="plate"><div class="message-body"><p id="reply-text">Here is the answer.</p></div></article>')}
      ${row('AssistantPart', CARD('card-changes', 'turn-changes-card'))}
      ${row('ToolActivity', CARD('card-question', 'ask-user-card'))}
      ${row('ToolActivity', CARD('card-approval', 'approval-prompt'))}
      ${row('ToolActivity', CARD('card-visualize', 'visualize-card'))}
      ${row(
        'ToolActivity',
        `<article class="tool-activity" data-surface="desktop" data-open="false" id="tools-closed"><button type="button" class="tool-header tool-activity-header"><span class="tool-title tool-activity-title"><b id="tools-closed-text">Ran 1 command, called an agent, 1 failed</b></span><span class="tool-chevron" id="tools-closed-icon"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" stroke="currentColor" fill="none"/></svg></span></button></article>`,
        'data-step-before="true"'
      )}
      ${row(
        'ToolActivity',
        `<article class="tool-activity" data-surface="desktop" data-open="true" id="tools-open"><button type="button" class="tool-header tool-activity-header"><span class="tool-title tool-activity-title"><b id="tools-open-text">Edited 1 file, searched code</b></span><span class="tool-chevron" id="tools-open-icon"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" stroke="currentColor" fill="none"/></svg></span></button><div class="tool-activity-content"><div class="tool-activity-details"><span class="tool-activity-item-result" id="tools-open-detail">src/app.ts +7 −0</span></div></div></article>`,
        'data-step-before="true"'
      )}
      ${row(
        'Thinking',
        `<div class="live-activity-slot" data-busy="true"><div class="live-activity"><div class="live-activity-status" id="live"><span class="live-activity-icon" id="live-icon"><svg width="16" height="16"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg></span><span id="live-text">Working it out</span><span class="live-activity-meta" id="live-meta">1m 33s · 272 tokens</span></div></div></div>`,
        'data-step-before="true"'
      )}
      ${row(
        'Thinking',
        `<div class="turn-status complete" role="status" id="done"><span class="turn-status-mark"><svg class="turn-status-icon" id="done-icon" width="16" height="16"><path d="M3 8l3 3 7-7" stroke="currentColor" fill="none"/></svg></span><span id="done-text">Finished in 1m 27s</span></div>`
      )}
      ${row(
        'Thinking',
        `<div class="compaction-divider" role="status" id="compact"><svg class="compaction-icon" id="compact-icon" width="16" height="16"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg><span id="compact-text">Context compacted</span><small id="compact-meta">12k tokens</small></div>`
      )}
      ${row(
        'Error',
        `<div class="error-notice transcript-error-notice" role="status" id="error"><div class="error-notice-summary"><svg class="error-notice-icon" id="error-icon" width="16" height="16"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg><div class="error-notice-copy"><span id="error-text">Request failed</span></div></div></div>`
      )}
    </div></div></div>
  </main></div></div>`;

const TEXTS = [
  'reply-text',
  'tools-closed-text',
  'tools-open-text',
  'tools-open-detail',
  'live-text',
  'live-meta',
  'done-text',
  'compact-text',
  'compact-meta',
  'error-text',
];
const ICONS = ['tools-closed-icon', 'tools-open-icon', 'live-icon', 'done-icon', 'compact-icon', 'error-icon'];
const PLATED = ['tools-closed', 'tools-open', 'live', 'done', 'compact', 'error'];
const CARDS = ['card-changes', 'card-question', 'card-approval', 'card-visualize', 'tools-open'];

const edges = (page) =>
  page.evaluate(
    (ids) =>
      Object.fromEntries(
        ids.map((id) => {
          const box = document.getElementById(id).getBoundingClientRect();
          const style = getComputedStyle(document.getElementById(id));
          return [
            id,
            { left: box.left, right: box.right, background: style.backgroundColor, filter: style.backdropFilter },
          ];
        })
      ),
    ['plate', ...PLATED, ...CARDS]
  );

test('skin transcript rows: one plate family, shared edges, readable', async (t) => {
  installTestDom(t, { actEnvironment: false });
  const { skinVars } = await import('./desktop-skin');
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  await page.setContent(
    `<!doctype html><html><head><style>${await appStyles()}</style></head><body>${PAGE}</body></html>`
  );
  await page.addStyleTag({
    content: 'body::before { background-image: none !important; } * { transition: none !important; }',
  });

  const failures = [];
  const misaligned = [];
  const unplated = [];
  const lowest = {};
  for (const phone of [false, true]) {
    await page.evaluate(
      (width) => document.documentElement.style.setProperty('--qa-width', width),
      phone ? '390px' : '1100px'
    );
    await page.setViewport({ width: phone ? 390 : 1400, height: 1100 });
    for (const theme of ['dark', 'light']) {
      for (const skin of SKIN_MANIFEST) {
        for (const plate of ['light', 'dark']) {
          for (const transparency of [DEFAULT_TRANSPARENCY, 100]) {
            const label = `${phone ? 'phone ' : ''}${theme} ${skin.id}/${plate}@${transparency}`;
            const vars = skinVars(
              skin.id,
              { outerTransparency: transparency, mainTransparency: transparency, plate, accent: null },
              theme
            );
            await paintState(page, { theme, skin: skin.id, plate, vars, phone });
            await page.evaluate(
              (width) => document.documentElement.style.setProperty('--qa-width', width),
              phone ? '390px' : '1100px'
            );
            const measured = await measureIds(page, [...TEXTS, ...ICONS], skin.picture);
            for (const id of [...TEXTS, ...ICONS]) lowest[id] = Math.min(lowest[id] ?? Infinity, measured[id].ratio);
            for (const id of TEXTS) if (measured[id].ratio < 4.5) failures.push(`${label} ${id} ${measured[id].ratio}`);
            for (const id of ICONS)
              if (measured[id].ratio < 3) failures.push(`${label} ${id} icon ${measured[id].ratio}`);
            const box = await edges(page);
            const { plate: message } = box;
            for (const id of CARDS) {
              if (Math.abs(box[id].left - message.left) > 1 || Math.abs(box[id].right - message.right) > 1) {
                misaligned.push(
                  `${label} ${id} ${box[id].left}-${box[id].right} vs plate ${message.left}-${message.right}`
                );
              }
            }
            for (const id of PLATED) {
              if (Math.abs(box[id].left - message.left) > 1)
                misaligned.push(`${label} ${id} left ${box[id].left} vs ${message.left}`);
              if (box[id].background !== message.background || box[id].filter !== message.filter)
                unplated.push(`${label} ${id} ${box[id].background} ${box[id].filter}`);
            }
            if (
              process.env.MIXDOG_ROWS_SHOTS &&
              transparency === DEFAULT_TRANSPARENCY &&
              plate === 'light' &&
              theme === 'dark' &&
              ['tech-studio', 'spring-window'].includes(skin.id)
            ) {
              await page.screenshot({
                path: `${process.env.MIXDOG_ROWS_SHOTS}/${skin.id}-${phone ? 'phone' : 'wide'}.png`,
              });
            }
          }
        }
      }
    }
  }

  if (process.env.MIXDOG_ROWS_SHOTS)
    console.log(`LOWEST ${JSON.stringify(lowest)} MISALIGNED ${misaligned.length} UNPLATED ${unplated.length}`);
  await t.test('every plated row and card shares the assistant plate edges and tokens', () => {
    assert.deepEqual(misaligned, []);
    assert.deepEqual(unplated, []);
  });
  await t.test('row text holds 4.5:1 and icons 3:1 on every skin, plate, theme and transparency', () => {
    assert.deepEqual(failures, []);
  });
});
