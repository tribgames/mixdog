// The running mark and the decorative loops beside it, in a real Chrome
// against the app's own stylesheets:
// - the mark's two loops (arc strip, outer rotation) step at 24 fps on one
//   shared 1/24 s grid, the strip showing every second pre-drawn frame, and
//   the star holds still in its static pose; the arcs cross the loop seam
//   with an ordinary step, as rasterized;
// - the text sweep steps on the same grid: a whole number of frames a cycle,
//   one equal step per frame through its seam;
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
const { LIVE_ACTIVITY_ARC_FRAMES, LiveActivity, liveActivityArcPath } = await import('./transcript-status.tsx');
const { TextShimmer } = await import('./transcript-primitives.tsx');
const { build } = await import('esbuild');

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

test('the arcs cross the loop seam with an ordinary step, as drawn', async (t) => {
  // The rings are 120deg apart, so turning a pose by 120deg (the loop's whole
  // advance) must draw the very same arcs: the loop's last pose is its first.
  const subpaths = (d) => d.split('M').filter(Boolean).sort();
  for (const [dash, offset] of LIVE_ACTIVITY_ARC_FRAMES) {
    assert.deepEqual(subpaths(liveActivityArcPath(dash, offset - 120)), subpaths(liveActivityArcPath(dash, offset)));
  }

  // As rasterized: hold the spin, step the strip across its seam (frame 47 ->
  // 48 = the next loop's first) and measure each frame's ink and the arcs'
  // angle (the phase of the 3-fold pattern) at 8x.
  const page = await launch(t);
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 8 });
  await page.addStyleTag({
    content: 'body { background: #000 !important; } .live-activity-icon svg { visibility: hidden; }',
  });
  const icon = await page.$('[data-context="visible"] .live-activity-icon');
  const FRAME_MS = 1000 / 24;
  const measured = [];
  for (let frame = 44; frame <= 51; frame += 1) {
    await page.evaluate(
      (frame, FRAME_MS) => {
        const icon = document.querySelector('[data-context="visible"] .live-activity-icon');
        const [strip] = icon.querySelector('.live-activity-arc-strip').getAnimations();
        const [spin] = icon.querySelector('.live-activity-arcs').getAnimations();
        strip.pause();
        spin.pause();
        strip.currentTime = (frame + 0.5) * FRAME_MS;
        spin.currentTime = FRAME_MS / 2;
      },
      frame,
      FRAME_MS
    );
    const png = await icon.screenshot({ encoding: 'base64' });
    measured.push(
      await page.evaluate(async (png) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
        let ink = 0;
        let sin = 0;
        let cos = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            const value = (data[i] + data[i + 1] + data[i + 2]) / 765;
            const angle = Math.atan2(y + 0.5 - height / 2, x + 0.5 - width / 2);
            ink += value;
            sin += value * Math.sin(3 * angle);
            cos += value * Math.cos(3 * angle);
          }
        }
        return { ink, angle: (Math.atan2(sin, cos) * 60) / Math.PI };
      }, png)
    );
  }
  const step = (index) => ((((measured[index + 1].angle - measured[index].angle) % 120) + 180) % 120) - 60;
  const inkStep = (index) => Math.abs(measured[index + 1].ink - measured[index].ink);
  // Frames 44..51: index 3 is the seam (47 -> 48).
  const seam = step(3);
  const around = [step(2), step(4)];
  assert.ok(
    seam >= Math.min(...around) - 0.15 && seam <= Math.max(...around) + 0.15,
    `seam step ${seam.toFixed(2)}deg vs ${around.map((v) => v.toFixed(2)).join(', ')}deg around it`
  );
  assert.ok(inkStep(3) <= Math.max(inkStep(2), inkStep(4)) * 1.5, `ink change at the seam ${inkStep(3).toFixed(1)}`);
});

test('the text sweep steps at 24 fps: one pose per frame, a whole number of frames a cycle', async (t) => {
  const page = await launch(t);
  const FRAME_MS = 1000 / 24;
  for (const phone of [false, true]) {
    const sweeps = await page.evaluate(
      (phone, FRAME_MS) => {
        const root = document.documentElement;
        if (phone) root.dataset.mixdogMobileTabs = 'true';
        else delete root.dataset.mixdogMobileTabs;
        root.dataset.mixdogMotion = 'running';
        return ['visible', 'dock: open, agents view'].map((name) => {
          const shimmer = document.querySelector(`[data-context="${name}"] [data-component="text-shimmer"]`);
          const glint = shimmer.querySelector('[data-slot="text-shimmer-glint"]');
          const vars = getComputedStyle(shimmer);
          const number = (property) => Number(vars.getPropertyValue(property));
          const animations = glint.getAnimations({ subtree: true });
          // The phone sweep's mask x position in px: a computed position keeps
          // its percentage (of the box less the mask's width).
          const maskX = (style) => {
            const value = style.maskPosition;
            const x = value.startsWith('calc(') ? value.slice(5, value.indexOf(')')) : value.split(' ')[0];
            const basis = glint.getBoundingClientRect().width - Number.parseFloat(style.maskSize);
            let px = 0;
            for (const [, sign, number, unit] of x.matchAll(/(-\s*)?(-?[\d.]+)(%|px)/g)) {
              const signed = (sign ? -1 : 1) * Number(number);
              px += unit === '%' ? (signed / 100) * basis : signed;
            }
            return px;
          };
          const read = () =>
            animations.map((animation) => {
              const style = getComputedStyle(glint, animation.effect.pseudoElement);
              return animation.animationName === 'text-shimmer-mask'
                ? maskX(style)
                : new DOMMatrix(style.transform).m41;
            });
          for (const animation of animations) animation.pause();
          const timings = animations.map((animation) => ({
            name: animation.animationName,
            duration: animation.effect.getTiming().duration,
            easings: animation.effect.getKeyframes().map((frame) => frame.easing),
            startTime: animation.startTime,
          }));
          // Mid-frame poses through one whole cycle and the next cycle's first.
          const frames = Math.round(timings[0].duration / FRAME_MS);
          const poses = [];
          for (let frame = 0; frame <= frames; frame += 1) {
            for (const animation of animations) animation.currentTime = (frame + 0.5) * FRAME_MS;
            poses.push(read());
          }
          // Each keyframe's resolved value (its var()/% geometry): one
          // iteration held at either end (a stepped `end` timing reaches the
          // last keyframe only there).
          const ends = animations.map((animation, index) => {
            animation.effect.updateTiming({ iterations: 1, fill: 'both' });
            animation.currentTime = 0;
            const from = read()[index];
            animation.currentTime = animation.effect.getTiming().duration;
            const to = read()[index];
            return { from, to };
          });
          return {
            ends,
            name,
            cells: number('--text-shimmer-cells'),
            comet: number('--text-shimmer-comet'),
            rest: number('--text-shimmer-rest'),
            timings,
            poses,
          };
        });
      },
      phone,
      FRAME_MS
    );
    for (const { ends, name, cells, comet, rest, timings, poses } of sweeps) {
      const label = `${phone ? 'phone' : 'desktop'} ${name}`;
      // 100ms a cell, capped at 3.2s, rounded to whole frames of 1/24 s.
      const frames = Math.round(Math.min((cells + comet + rest) * 2.4, 76.8));
      assert.deepEqual(
        timings.map(({ name }) => name),
        phone ? ['text-shimmer-mask'] : ['text-shimmer-window', 'text-shimmer-window-copy'],
        label
      );
      for (const timing of timings) {
        assert.ok(Math.abs(timing.duration - frames * FRAME_MS) < 1e-9, `${label} ${timing.name}: ${frames} frames`);
        assert.deepEqual(timing.easings, [`steps(${frames})`, `steps(${frames})`], `${label} ${timing.name}`);
        assert.equal(timing.startTime, timings[0].startTime, `${label}: the window and its copy start together`);
      }
      // Every frame one equal step of the whole travel / frames; the cycle's
      // last pose is one step short of the end (the next cycle's start), and
      // the next cycle starts on the first pose: the seam is an ordinary step.
      // (Computed transforms serialize to 1/1000 px.)
      for (let channel = 0; channel < timings.length; channel += 1) {
        const track = poses.map((pose) => pose[channel]);
        const { from, to } = ends[channel];
        const step = (to - from) / frames;
        assert.ok(Math.abs(step) > 0.1, `${label}: the sweep moves`);
        assert.ok(Math.abs(track[0] - from) < 2e-3, `${label}: the first pose is the start`);
        for (let frame = 1; frame <= frames; frame += 1) {
          const want = frame === frames ? from : from + frame * step;
          assert.ok(Math.abs(track[frame] - want) < 2e-3, `${label} frame ${frame}: ${track[frame]} (want ${want})`);
        }
        assert.ok(Math.abs(track[frames - 1] + step - to) < 2e-3, `${label}: the seam step`);
      }
      // The lit copy counter-slides in lockstep with its window.
      if (!phone) for (const [window, copy] of poses) assert.ok(Math.abs(window + copy) < 1e-6, label);
    }
  }
});

test('every loop locks to the timeline origin when it mounts or resumes, and a held loop stays with its CSS', async (t) => {
  const page = await launch(t);
  const bundle = await build({
    entryPoints: [new URL('./decorative-motion-sync.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
    bundle: true,
    format: 'iife',
    globalName: 'motionSync',
    write: false,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const LOOP_NAMES = [
    'live-activity-arc-flow',
    'live-activity-logo-spin',
    'text-shimmer-window',
    'text-shimmer-window-copy',
    'text-shimmer-mask',
  ];
  const html = { band, heading };
  for (const phone of [false, true]) {
    const result = await page.evaluate(
      async (phone, html, LOOP_NAMES) => {
        const root = document.documentElement;
        if (phone) root.dataset.mixdogMobileTabs = 'true';
        else delete root.dataset.mixdogMobileTabs;
        root.dataset.mixdogMotion = 'running';
        const stop = window.motionSync.installDecorativeMotionSync();
        const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
        const wait = async (ms) => {
          const until = performance.now() + ms;
          while (performance.now() < until) await frame();
        };
        const loops = (element) =>
          element.getAnimations({ subtree: true }).filter((animation) => LOOP_NAMES.includes(animation.animationName));
        const read = (element) =>
          loops(element).map((animation) => `${animation.animationName}:${animation.playState}:${animation.startTime}`);
        const host = document.createElement('section');
        host.innerHTML = `<div class="transcript-virtual-row"><div class="transcript-virtual-row-content">${html.band}</div></div><div class="utility-dock-pane" data-surface-active="true"><h2>${html.heading}</h2></div>`;
        const row = host.querySelector('.transcript-virtual-row');
        const pane = host.querySelector('.utility-dock-pane');
        const out = {};
        // Mount well after the timeline started, as the components' refs do.
        await wait(150);
        document.body.append(host);
        for (const element of host.querySelectorAll('.live-activity-icon, [data-slot="text-shimmer-glint"]')) {
          window.motionSync.lockDecorativeLoops(element);
        }
        out.mounted = read(host);
        out.mountedPhase = loops(host).map((animation) => animation.currentTime - document.timeline.currentTime);
        // Pause each signal for a while, then resume it.
        const cycle = async (name, region, pause, resume) => {
          pause();
          await Promise.resolve();
          await wait(120);
          const held = read(region);
          resume();
          await Promise.resolve();
          out[name] = { held, resumed: read(host) };
        };
        await cycle(
          'row offscreen',
          row,
          () => row.setAttribute('data-offscreen', 'true'),
          () => row.removeAttribute('data-offscreen')
        );
        await cycle(
          'parked',
          host,
          () => host.setAttribute('data-conversation-parked', 'true'),
          () => host.removeAttribute('data-conversation-parked')
        );
        await cycle(
          'dock pane inactive',
          pane,
          () => pane.setAttribute('data-surface-active', 'false'),
          () => pane.setAttribute('data-surface-active', 'true')
        );
        await cycle(
          'document hidden',
          host,
          () => {
            root.dataset.mixdogMotion = 'paused';
          },
          () => {
            root.dataset.mixdogMotion = 'running';
          }
        );
        // A locked loop still follows its CSS play state.
        row.setAttribute('data-offscreen', 'true');
        await frame();
        out.pausedAgain = read(row);
        stop();
        host.remove();
        return out;
      },
      phone,
      html,
      LOOP_NAMES
    );
    const label = phone ? 'phone' : 'desktop';
    // The mark's two loops, and per sweep (band verb, dock heading) its window\n    // and lit copy (desktop) or its one mask (phone).
    const loopCount = 2 + 2 * (phone ? 1 : 2);
    const locked = Array.from({ length: loopCount }, () => /:running:0$/);
    const expectAll = (states, pattern, what) => {
      assert.equal(states.length, loopCount, `${label} ${what}: ${states}`);
      for (const state of states) assert.match(state, pattern, `${label} ${what}`);
    };
    expectAll(result.mounted, locked[0], 'mounted');
    for (const offset of result.mountedPhase) assert.ok(Math.abs(offset) < 1e-6, `${label}: on the timeline's phase`);
    for (const name of ['row offscreen', 'parked', 'dock pane inactive', 'document hidden']) {
      const { held, resumed } = result[name];
      // Held loops are paused by CSS (or, for the mark under a hidden
      // document, gone), never played by the lock.
      for (const state of held) assert.match(state, /:paused:/, `${label} ${name} held`);
      expectAll(resumed, locked[0], `${name} resumed`);
    }
    for (const state of result.pausedAgain) assert.match(state, /:paused:/, `${label}: CSS still pauses a locked loop`);
  }
});

test('loops recreated by a layout switch, reduced motion or anything else lock too, before their first paint where the cause is known', async (t) => {
  const page = await launch(t);
  const bundle = await build({
    entryPoints: [new URL('./decorative-motion-sync.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
    bundle: true,
    format: 'iife',
    globalName: 'motionSync',
    write: false,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(
    async (html) => {
      const root = document.documentElement;
      delete root.dataset.mixdogMobileTabs;
      root.dataset.mixdogMotion = 'running';
      window.__stopSync = window.motionSync.installDecorativeMotionSync();
      // Before the module's own listener (document before root, capture): the
      // start time a new loop had when its start was reported, one frame
      // after its first.
      window.__starts = [];
      document.addEventListener(
        'animationstart',
        (event) => {
          if (!event.target.closest('#sync-host') || !event.animationName.match(/^(live-activity|text-shimmer)-/))
            return;
          const animation = event.target
            .getAnimations({ subtree: true })
            .find(
              (item) =>
                item.animationName === event.animationName &&
                item.effect.target === event.target &&
                (item.effect.pseudoElement ?? '') === event.pseudoElement
            );
          window.__starts.push(`${event.animationName}${event.pseudoElement}:${animation?.startTime}`);
        },
        true
      );
      const host = document.createElement('section');
      host.id = 'sync-host';
      host.innerHTML = `<div class="transcript-virtual-row"><div class="transcript-virtual-row-content">${html.band}</div></div><div class="utility-dock-pane" data-surface-active="true"><h2>${html.heading}</h2></div>`;
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      for (let i = 0; i < 6; i += 1) await frame();
      document.body.append(host);
      for (const element of host.querySelectorAll('.live-activity-icon, [data-slot="text-shimmer-glint"]')) {
        window.motionSync.lockDecorativeLoops(element);
      }
    },
    { band, heading }
  );
  const NAMES = [
    'live-activity-arc-flow',
    'live-activity-logo-spin',
    'text-shimmer-window',
    'text-shimmer-window-copy',
    'text-shimmer-mask',
  ];
  const settle = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 6; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    });
  const loops = () =>
    page.evaluate(
      (NAMES) =>
        document
          .getElementById('sync-host')
          .getAnimations({ subtree: true })
          .filter((animation) => NAMES.includes(animation.animationName))
          .map((animation) => `${animation.animationName}:${animation.playState}:${animation.startTime}`),
      NAMES
    );
  const takeStarts = () => page.evaluate(() => window.__starts.splice(0));
  const check = async (label, count, { prePaint }) => {
    await settle();
    const states = await loops();
    assert.equal(states.length, count, `${label}: ${states}`);
    for (const state of states) assert.match(state, /:running:0$/, label);
    const starts = await takeStarts();
    if (prePaint) {
      assert.ok(starts.length > 0, `${label}: loops were recreated`);
      for (const start of starts) assert.match(start, /:0$/, `${label}: locked before its first paint (${starts})`);
    }
  };
  await settle();
  await takeStarts();
  await check('mounted', 6, { prePaint: false });

  const setPhone = (phone) =>
    page.evaluate((phone) => {
      if (phone) document.documentElement.dataset.mixdogMobileTabs = 'true';
      else delete document.documentElement.dataset.mixdogMobileTabs;
    }, phone);
  await setPhone(true);
  await check('desktop -> phone', 4, { prePaint: true });
  await setPhone(false);
  await check('phone -> desktop', 6, { prePaint: true });

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await settle();
  await takeStarts();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await check('reduced motion on -> off', 6, { prePaint: true });

  // A cause no hook knows (an inline animation override dropped): locked on
  // its reported start, a frame late.
  await page.evaluate(() => {
    document.querySelector('#sync-host .live-activity-arc-strip').style.animationName = 'none';
  });
  await settle();
  await page.evaluate(() => {
    document.querySelector('#sync-host .live-activity-arc-strip').style.animationName = '';
  });
  await check('recreated by anything else', 6, { prePaint: false });

  // Locked loops still obey the pause rules, and resume locked.
  await page.evaluate(() =>
    document.querySelector('#sync-host .transcript-virtual-row').setAttribute('data-offscreen', 'true')
  );
  await settle();
  const held = await page.evaluate(
    (NAMES) =>
      document
        .querySelector('#sync-host .transcript-virtual-row')
        .getAnimations({ subtree: true })
        .filter((animation) => NAMES.includes(animation.animationName))
        .map((animation) => animation.playState),
    NAMES
  );
  assert.deepEqual(held, ['paused', 'paused', 'paused', 'paused']);
  await page.evaluate(() =>
    document.querySelector('#sync-host .transcript-virtual-row').removeAttribute('data-offscreen')
  );
  await check('resumed', 6, { prePaint: false });
  await page.evaluate(() => window.__stopSync());
});
