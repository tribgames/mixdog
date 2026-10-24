// The running mark and the decorative loops beside it, in a real Chrome
// against the app's own stylesheets:
// - the mark's two loops (arc strip, outer rotation) step at 24 fps on one
//   shared 1/24 s grid, the strip showing every second pre-drawn frame, and
//   the star holds still in its static pose;
// - every loop (mark, text sweep, typing dots) holds still under each "not
//   visible" signal, on desktop and phone: the computed play state after the
//   whole cascade, not the selectors that are meant to win it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import React, { act } from 'react';
import { appStyles } from './test-support/app-styles.mjs';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null);
const { createRoot } = await import('react-dom/client');
const { LIVE_ACTIVITY_ARC_FRAMES, LiveActivity } = await import('./transcript-status.tsx');
const { TextShimmer } = await import('./transcript-primitives.tsx');

/** A component's markup as the app renders it. */
async function markup(element) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

const band = await markup(
  React.createElement(LiveActivity, {
    snapshot: { spinner: { active: true, mode: 'thinking', startedAt: Date.now() - 2_000 } },
  })
);
const heading = await markup(React.createElement(TextShimmer, { text: 'Fix the dock', active: true }));
const DOTS =
  '<span class="turn-status-dots"><span></span><span></span><span></span></span>' +
  '<span class="mx-chat-dots"><i></i><i></i><i></i></span>' +
  '<span class="agent-room-dots"><i></i><i></i><i></i></span>';
const row = (attrs = '') =>
  `<div class="transcript-virtual-row" ${attrs}><div class="transcript-virtual-row-content" data-tag="Thinking">${band}${DOTS}</div></div>`;
const dock = (active) =>
  `<aside class="utility-dock"><div class="utility-dock-pane stable-surface-layer" data-surface-active="${active}"><div class="agent-session-heading"><h2>${heading}</h2></div>${DOTS}</div></aside>`;

// Each context: its markup and whether its loops must run.
const CONTEXTS = {
  visible: { html: row(), runs: true },
  'row outside the range': { html: row('data-offscreen="true"'), runs: false },
  parked: { html: `<div data-conversation-parked="true">${row()}</div>`, runs: false },
  retained: { html: `<div data-retained="">${row()}</div>`, runs: false },
  'dock: open, agents view': { html: dock('true'), runs: true },
  'dock: closed or another view': { html: dock('false'), runs: false },
};
const PAGE = Object.entries(CONTEXTS)
  .map(([name, context]) => `<section data-context="${name}">${context.html}</section>`)
  .join('');

/** Runs in the page: every loop's computed animation in each context. */
function loopStates() {
  const LOOPS = [
    '.live-activity-arc-strip',
    '.live-activity-arcs',
    '[data-slot="text-shimmer-glint"]',
    '[data-slot="text-shimmer-glint"]::before',
    '.turn-status-dots > span',
    '.mx-chat-dots > i',
    '.agent-room-dots > i',
  ];
  const result = {};
  for (const section of document.querySelectorAll('[data-context]')) {
    const states = {};
    for (const loop of LOOPS) {
      const [selector, pseudo] = loop.split('::');
      for (const element of section.querySelectorAll(selector)) {
        const style = getComputedStyle(element, pseudo ? `::${pseudo}` : null);
        const names = style.animationName.split(', ');
        const plays = style.animationPlayState.split(', ');
        // A loop runs while any of its named animations plays.
        const running = names.some((name, index) => name !== 'none' && (plays[index] ?? plays[0]) === 'running');
        const animated = names.some((name) => name !== 'none');
        states[loop] = { running: (states[loop]?.running ?? false) || running, animated };
      }
    }
    result[section.dataset.context] = states;
  }
  return result;
}

async function launch(t) {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const rooms = await readFile(new URL('./agent-rooms.css', import.meta.url), 'utf8');
  await page.setContent(
    `<!doctype html><html data-mixdog-theme="dark"><head><style>${await appStyles()}\n${rooms}</style></head><body>${PAGE}</body></html>`
  );
  return page;
}

test('every decorative loop holds still wherever it cannot be seen, desktop and phone', async (t) => {
  const page = await launch(t);
  const failures = [];
  for (const phone of [false, true]) {
    for (const hidden of [false, true]) {
      await page.evaluate(
        (phone, hidden) => {
          const root = document.documentElement;
          if (phone) root.dataset.mixdogMobileTabs = 'true';
          else delete root.dataset.mixdogMobileTabs;
          // A hidden document (motion-visibility.ts).
          root.dataset.mixdogMotion = hidden ? 'paused' : 'running';
        },
        phone,
        hidden
      );
      const states = await page.evaluate(loopStates);
      for (const [name, context] of Object.entries(CONTEXTS)) {
        const label = `${phone ? 'phone' : 'desktop'}${hidden ? ', document hidden' : ''}: ${name}`;
        const loops = Object.entries(states[name]);
        assert.ok(loops.length > 0, `${label}: loops found`);
        for (const [loop, state] of loops) {
          // The phone sweep moves one mask on the window; its lit copy holds.
          const expected = context.runs && !hidden && !(phone && loop.endsWith('::before'));
          if (state.running !== expected) failures.push(`${label} ${loop} ${state.running ? 'runs' : 'holds'}`);
        }
        if (context.runs && !hidden) {
          for (const loop of ['.live-activity-arc-strip', '.live-activity-arcs']) {
            if (states[name][loop] && !states[name][loop].animated) failures.push(`${label} ${loop} not animated`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('the mark steps at 24 fps on one grid; the star holds its static pose', async (t) => {
  const page = await launch(t);
  const FRAME_MS = 1000 / 24;
  const read = await page.evaluate((FRAME_MS) => {
    const icon = document.querySelector('[data-context="visible"] .live-activity-icon');
    const strip = icon.querySelector('.live-activity-arc-strip');
    const spin = icon.querySelector('.live-activity-arcs');
    const [stripAnimation] = strip.getAnimations();
    const [spinAnimation] = spin.getAnimations();
    const timing = (animation) => ({
      duration: animation.effect.getTiming().duration,
      keyframes: animation.effect.getKeyframes().map((frame) => ({
        offset: frame.offset,
        easing: frame.easing,
        transform: frame.transform,
        rotate: frame.rotate,
      })),
      startTime: animation.startTime,
    });
    const star = icon.querySelector('svg');
    const result = {
      strip: timing(stripAnimation),
      spin: timing(spinAnimation),
      stripWidth: getComputedStyle(strip).width,
      star: {
        animations: star.getAnimations({ subtree: true }).length,
        transform: getComputedStyle(star).transform,
        rotate: getComputedStyle(star).rotate,
        pathTransform: getComputedStyle(star.querySelector('.star')).transform,
      },
      iconAnimations: icon.getAnimations({ subtree: true }).length,
    };
    // Seek both loops together, frame by frame over a whole common period
    // (lcm 48 x 101), mid-frame and a hair either side of every frame edge.
    stripAnimation.pause();
    spinAnimation.pause();
    const pose = (time) => {
      stripAnimation.currentTime = time;
      spinAnimation.currentTime = time;
      return [new DOMMatrix(getComputedStyle(strip).transform).m41, Number.parseFloat(getComputedStyle(spin).rotate)];
    };
    result.mid = [];
    result.before = [];
    result.after = [];
    for (let frame = 0; frame < 48 * 101; frame += 1) {
      result.mid.push(pose((frame + 0.5) * FRAME_MS));
      result.before.push(pose((frame + 1) * FRAME_MS - 1e-3));
      result.after.push(pose(frame * FRAME_MS + 1e-3));
    }
    return result;
  }, FRAME_MS);

  const steps = (easing) => Number(/^steps\((\d+)(?:, (?:end|jump-end))?\)$/.exec(easing)?.[1]);
  for (const loop of ['strip', 'spin']) {
    const { duration, keyframes } = read[loop];
    assert.equal(keyframes.length, 2, `${loop}: one stepped interval`);
    assert.ok(Math.abs(duration / steps(keyframes[0].easing) - FRAME_MS) < 1e-9, `${loop}: one step per 1/24 s`);
    assert.ok(Number.isInteger(Math.round(duration / FRAME_MS)), `${loop}: whole frames`);
  }
  assert.equal(read.strip.startTime, read.spin.startTime, 'both loops start on the same frame');
  assert.equal(read.iconAnimations, 2, 'the mark runs exactly two loops');
  assert.deepEqual(read.star, { animations: 0, transform: 'none', rotate: 'none', pathTransform: 'none' });

  // The strip: from frame 1, two pre-drawn frames (2 x 14px) per step, ending
  // past the last frame so the final step shows frame (count - 2).
  const frames = LIVE_ACTIVITY_ARC_FRAMES.length;
  const stripSteps = steps(read.strip.keyframes[0].easing);
  const x = (transform) => Number(/translateX\((-?[\d.]+)px\)/.exec(transform)?.[1]);
  assert.equal(x(read.strip.keyframes[0].transform), -14, 'starts on frame 1 (frame 0 is the static pose)');
  assert.equal(x(read.strip.keyframes[1].transform), -14 * frames, 'ends one frame past the strip');
  assert.equal(1 + 2 * stripSteps, frames, 'every second frame of the loop, 1..count-2');
  assert.equal(read.stripWidth, `${14 * frames}px`);
  const spinSteps = steps(read.spin.keyframes[0].easing);
  assert.deepEqual([read.spin.keyframes[0].rotate, read.spin.keyframes[1].rotate], ['0deg', '360deg']);

  const expected = (frame) => [-14 * (1 + 2 * (frame % stripSteps)), ((frame % spinSteps) * 360) / spinSteps];
  const mismatches = [];
  for (const [name, poses] of Object.entries({ mid: read.mid, before: read.before, after: read.after })) {
    poses.forEach(([stripX, angle], frame) => {
      const [wantX, wantAngle] = expected(frame);
      if (Math.abs(stripX - wantX) > 1e-6 || Math.abs(angle - wantAngle) > 1e-3) {
        mismatches.push(`${name} frame ${frame}: strip ${stripX} (want ${wantX}), rotate ${angle} (want ${wantAngle})`);
      }
    });
  }
  assert.deepEqual(mismatches.slice(0, 5), []);
});
