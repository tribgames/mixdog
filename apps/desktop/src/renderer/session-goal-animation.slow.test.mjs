import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import puppeteer from 'puppeteer-core';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';

// Browser-rendered behavior, not stylesheet text: no animation anywhere in
// the segment, including a parent opacity animation that would still blink.
test('the Goal progress bar is static in every state', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const [tokens, styles, markdown] = await Promise.all(
    ['./ui/tokens.css', './styles.css', './desktop/22-markdown.css'].map((path) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    )
  );
  // The glyph turns on the shared spinner token and its keyframes.
  const spinKeyframes = styles.match(/@keyframes spin \{[\s\S]*?\n\}/)?.[0];
  assert.ok(spinKeyframes, 'styles.css defines the shared spin keyframes');
  const css = `${tokens}\n${spinKeyframes}\n${markdown}`;
  const render = async (status, execution = {}) => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionGoalIsland, {
        snapshot: {
          sessionId: 'animation-test',
          goal: { id: 'goal', status, title: 'Working Goal', tasks: [], timeUsedMs: 1_000 },
          ...execution,
        },
      })
    );
    await page.setContent(`<!doctype html><html><head><style>
      :root { --mx-icon-md: 16px; --mx-text-accent: #8ab4f8; --mx-text-muted: #888; }
      ${css}
    </style></head><body>${markup}</body></html>`);
  };
  // The progress mark is one static 16px ring: nothing in the segment
  // animates, whether work is running or not.
  const sample = () =>
    page.$eval('.session-goal-trigger', (trigger) => {
      const ring = trigger.querySelector('.session-goal-ring');
      const box = ring.getBoundingClientRect();
      return { animations: trigger.getAnimations({ subtree: true }).length, size: [box.width, box.height] };
    });

  for (const [status, execution] of [
    ['active', { busy: true }],
    ['active', { commandBusy: true }],
    ['active', { shellJobs: { count: 1 }, toolApproval: { id: 'other-approval' } }],
    ['paused', { busy: true }],
    ['active', {}],
    ['complete', { busy: true }],
    ['blocked', {}],
    ['usage_limited', {}],
    ['duration_reached', {}],
  ]) {
    await render(status, execution);
    assert.deepEqual(await sample(), { animations: 0, size: [16, 16] }, `${status}: the mark stays still`);
  }
});
