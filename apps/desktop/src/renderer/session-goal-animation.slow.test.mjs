import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import puppeteer from 'puppeteer-core';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';

// Browser-rendered behavior, not stylesheet text: a loader-shaped SVG alone
// does not prove it rotates, and a parent opacity animation can still blink.
test('Goal activity rotates steadily without pulsing and stops for inactive states', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const css = await readFile(new URL('./desktop/22-markdown.css', import.meta.url), 'utf8');
  const render = async (status, execution = {}) => {
    const markup = renderToStaticMarkup(React.createElement(SessionGoalIsland, {
      snapshot: {
        sessionId: 'animation-test',
        goal: { id: 'goal', status, title: 'Working Goal', tasks: [], timeUsedMs: 1_000 },
        ...execution,
      },
    }));
    await page.setContent(`<!doctype html><html><head><style>
      :root { --mx-icon-md: 16px; --mx-text-accent: #8ab4f8; --mx-text-muted: #888; }
      ${css}
    </style></head><body>${markup}</body></html>`);
  };
  const sample = () => page.$eval('.session-goal-glyph', (glyph) => {
    const icon = glyph.querySelector('svg');
    const animations = icon.getAnimations();
    if (!animations.length) return { count: 0, parentCount: glyph.getAnimations().length };
    const animation = animations[0];
    animation.pause();
    const timing = animation.effect.getTiming();
    const samples = [0, .25, .5, .75].map((phase) => {
      animation.currentTime = Number(timing.duration) * phase;
      const iconStyle = getComputedStyle(icon);
      const parentStyle = getComputedStyle(glyph);
      const matrix = new DOMMatrixReadOnly(iconStyle.transform);
      return {
        a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d,
        opacity: [iconStyle.opacity, parentStyle.opacity],
        filter: [iconStyle.filter, parentStyle.filter],
      };
    });
    return { count: animations.length, parentCount: glyph.getAnimations().length, timing, samples };
  });

  for (const [status, execution] of [
    ['active', { busy: true }],
    ['active', { commandBusy: true }],
    ['active', { shellJobs: { count: 1 }, toolApproval: { id: 'other-approval' } }],
    ['paused', { busy: true }],
    ['paused', { commandBusy: true }],
  ]) {
    await render(status, execution);
    const result = await sample();
    assert.equal(result.count, 1, `${status}: running work has a rotating icon`);
    assert.equal(result.parentCount, 0, 'the icon container must not pulse');
    assert.equal(result.timing.easing, 'linear');
    assert.ok(Number(result.timing.duration) > 0);
    const expected = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [0, -1, 1, 0]];
    result.samples.forEach((value, index) => {
      for (const [axis, target] of ['a', 'b', 'c', 'd'].map((axis, at) => [axis, expected[index][at]])) {
        assert.ok(Math.abs(value[axis] - target) < .01, `${status}: phase ${index}, axis ${axis}`);
      }
      assert.deepEqual(value.opacity, ['1', '1']);
      assert.deepEqual(value.filter, ['none', 'none']);
    });
  }

  for (const status of ['active', 'paused', 'complete', 'blocked', 'usage_limited', 'duration_reached']) {
    await render(status, { busy: !['active', 'paused'].includes(status) });
    assert.deepEqual(await sample(), { count: 0, parentCount: 0 }, `${status}: inactive Goal icons stay still`);
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await render('active', { busy: true });
  assert.deepEqual(await sample(), { count: 0, parentCount: 0 });
});
