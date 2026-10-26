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
        // The phone sweep has no animation (its mask is stepped from script):
        // the pause rules still set the play state script reads.
        const playing = plays.some((play) => play === 'running');
        states[loop] = {
          running: (states[loop]?.running ?? false) || running,
          animated,
          playing: (states[loop]?.playing ?? false) || playing,
        };
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
          // The phone sweep moves one mask on the window, stepped from script
          // (no animation, but the play state the pause rules set); its lit
          // copy holds.
          const expected = context.runs && !hidden && !(phone && loop.endsWith('::before'));
          const scripted = phone && loop === '[data-slot="text-shimmer-glint"]';
          const actual = scripted ? state.playing : state.running;
          if (scripted && state.animated) failures.push(`${label} ${loop} runs a CSS animation`);
          if (actual !== expected) failures.push(`${label} ${loop} ${actual ? 'runs' : 'holds'}`);
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

test('the typing dots animate normally and run no animation under reduced motion', async (t) => {
  const page = await launch(t);
  const dotAnimations = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-context="visible"] .mx-chat-dots > i')].map(
        (dot) => getComputedStyle(dot).animationName
      )
    );
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  assert.deepEqual(await dotAnimations(), ['mx-chat-typing', 'mx-chat-typing', 'mx-chat-typing']);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  assert.deepEqual(await dotAnimations(), ['none', 'none', 'none']);
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
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 4 });
  await page.addStyleTag({
    content: 'body { background: #000 !important; } .live-activity-icon svg { display: none; } [data-context]:not([data-context=\"visible\"]) { display: none; }',
  });
  const icon = await page.$('[data-context="visible"] .live-activity-icon');
  const FRAME_MS = 1000 / 24;
  const measured = [];
  // The strip's mask is an SVG image: hold the first frame until it is decoded.
  await page.evaluate(async () => {
    const strip = document.querySelector('[data-context="visible"] .live-activity-arc-strip');
    const url = getComputedStyle(strip).maskImage.slice(5, -2);
    const image = new Image();
    image.src = url;
    await image.decode();
  });
  for (let frame = 44; frame <= 51; frame += 1) {
    // Each pose is held as a still transform, so the raster is exactly that frame.
    await page.evaluate(
      (frame) => {
        const icon = document.querySelector('[data-context="visible"] .live-activity-icon');
        const strip = icon.querySelector('.live-activity-arc-strip');
        const spin = icon.querySelector('.live-activity-arcs');
        for (const element of [strip, spin]) element.getAnimations().forEach((animation) => animation.cancel());
        strip.style.animation = 'none';
        spin.style.animation = 'none';
        strip.style.transform = `translateX(${-14 - 28 * (frame % 48)}px)`;
        spin.style.rotate = '0deg';
      },
      frame
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
  // The comparison below means nothing on blank frames (no ink, a zero angle
  // everywhere, every step 0): every frame must draw, and the arcs must turn
  // between each pair of frames.
  measured.forEach(({ ink }, index) => assert.ok(ink > 0, `frame ${44 + index} has no ink`));
  for (let index = 0; index < measured.length - 1; index += 1) {
    assert.ok(Math.abs(step(index)) > 0.01, `no angular movement from frame ${44 + index} to ${45 + index}: ${JSON.stringify(measured)}`);
  }
  // Frames 44..51: index 3 is the seam (47 -> 48).
  const seam = step(3);
  const around = [step(2), step(4)];
  assert.ok(
    seam >= Math.min(...around) - 0.15 && seam <= Math.max(...around) + 0.15,
    `seam step ${seam.toFixed(2)}deg vs ${around.map((v) => v.toFixed(2)).join(', ')}deg around it`
  );
  assert.ok(inkStep(3) <= Math.max(inkStep(2), inkStep(4)) * 1.5, `ink change at the seam ${inkStep(3).toFixed(1)}`);
});

test('the desktop text sweep steps at 24 fps: one pose per frame, a whole number of frames a cycle', async (t) => {
  const page = await launch(t);
  const FRAME_MS = 1000 / 24;
  for (const phone of [false]) {
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
          const read = () =>
            animations.map((animation) => {
              const style = getComputedStyle(glint, animation.effect.pseudoElement);
              return new DOMMatrix(style.transform).m41;
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
        ['text-shimmer-window', 'text-shimmer-window-copy'],
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
      for (const [window, copy] of poses) assert.ok(Math.abs(window + copy) < 1e-6, label);
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
  const LOOP_NAMES = ['live-activity-arc-flow', 'live-activity-logo-spin', 'text-shimmer-window', 'text-shimmer-window-copy'];
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
        // In a task, as React commits; the refs' locks run in the next
        // frame's animation callbacks, before its paint.
        await new Promise((resolve) => setTimeout(resolve, 0));
        document.body.append(host);
        for (const element of host.querySelectorAll('.live-activity-icon, [data-slot="text-shimmer-glint"]')) {
          window.motionSync.lockDecorativeLoops(element);
        }
        await frame();
        out.mounted = read(host);
        out.mountedPhase = loops(host).map((animation) => animation.currentTime - document.timeline.currentTime);
        // Pause each signal for a while, then resume it.
        const cycle = async (name, region, pause, resume) => {
          pause();
          await Promise.resolve();
          await wait(120);
          const held = read(region);
          resume();
          // Resumes lock in the next frame's animation callbacks, before its
          // paint; this callback is queued after the lock's (the observer's
          // microtask queues that).
          await Promise.resolve();
          await frame();
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
    // The mark's two loops, and per sweep (band verb, dock heading) its window
    // and lit copy (desktop); the phone's masks are stepped from script.
    const loopCount = phone ? 2 : 6;
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
          window.__notifyStart?.();
        },
        true
      );
      // Resolves once `count` starts have been reported since the last take.
      window.__startsReached = (count) =>
        new Promise((resolve) => {
          const reached = () => window.__starts.length >= count;
          if (reached()) resolve();
          else {
            window.__notifyStart = () => {
              if (!reached()) return;
              window.__notifyStart = null;
              resolve();
            };
          }
        });
      const host = document.createElement('section');
      host.id = 'sync-host';
      host.innerHTML = `<div class="transcript-virtual-row"><div class="transcript-virtual-row-content">${html.band}</div></div><div class="utility-dock-pane" data-surface-active="true"><h2>${html.heading}</h2></div>`;
      document.body.append(host);
      for (const element of host.querySelectorAll('.live-activity-icon, [data-slot="text-shimmer-glint"]')) {
        window.motionSync.lockDecorativeLoops(element);
      }
    },
    { band, heading }
  );
  const NAMES = ['live-activity-arc-flow', 'live-activity-logo-spin', 'text-shimmer-window', 'text-shimmer-window-copy'];
  // The page's loops once `count` of them run, all locked to the origin.
  const locked = (count) =>
    page.waitForFunction(
      (NAMES, count) => {
        const loops = document
          .getElementById('sync-host')
          .getAnimations({ subtree: true })
          .filter((animation) => NAMES.includes(animation.animationName));
        return loops.length === count && loops.every((a) => a.playState === 'running' && a.startTime === 0);
      },
      { polling: 'raf' },
      NAMES,
      count
    );
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
  // `started`: the animationstart events the cause raises (a resume raises none).
  const check = async (label, count, { prePaint, started }) => {
    await page.evaluate((started) => window.__startsReached(started), started);
    await locked(count);
    const states = await loops();
    assert.equal(states.length, count, `${label}: ${states}`);
    for (const state of states) assert.match(state, /:running:0$/, label);
    const starts = await takeStarts();
    console.log('DEBUGSTARTS', label, starts.length, JSON.stringify(starts));
    if (prePaint) {
      assert.ok(starts.length > 0, `${label}: loops were recreated`);
      for (const start of starts) assert.match(start, /:0$/, `${label}: locked before its first paint (${starts})`);
    }
  };
  await check('mounted', 6, { prePaint: true, started: 1 });

  const setPhone = (phone) =>
    page.evaluate((phone) => {
      if (phone) document.documentElement.dataset.mixdogMobileTabs = 'true';
      else delete document.documentElement.dataset.mixdogMobileTabs;
    }, phone);
  await setPhone(true);
  // The phone's masks are stepped from script: only the mark's loops remain,
  // and nothing starts.
  await check('desktop -> phone', 2, { prePaint: false, started: 0 });
  await setPhone(false);
  await check('phone -> desktop', 6, { prePaint: true, started: 1 });

  // The preference change reaches the page (its listeners run) before the
  // loops come back: the reduced state must be seen, not coalesced away.
  const mediaChange = () =>
    page.evaluate(() => {
      window.__mediaChanged = new Promise((resolve) =>
        window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => resolve(), { once: true })
      );
    });
  await mediaChange();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(() => window.__mediaChanged);
  assert.deepEqual(await loops(), [], 'reduced motion runs no loops');
  await takeStarts();
  await mediaChange();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await check('reduced motion on -> off', 6, { prePaint: true, started: 1 });

  // A cause no hook knows (an inline animation override dropped): locked on
  // its reported start, a frame late. `getAnimations` flushes style, so the
  // override's effect is readable at once.
  await page.evaluate(() => {
    document.querySelector('#sync-host .live-activity-arc-strip').style.animationName = 'none';
  });
  assert.equal((await loops()).length, 5, 'the strip loop is gone while overridden');
  await page.evaluate(() => {
    document.querySelector('#sync-host .live-activity-arc-strip').style.animationName = '';
  });
  await check('recreated by anything else', 6, { prePaint: false, started: 1 });

  // Locked loops still obey the pause rules, and resume locked.
  await page.evaluate(() =>
    document.querySelector('#sync-host .transcript-virtual-row').setAttribute('data-offscreen', 'true')
  );
  // Frame callbacks run in registration order: this one runs right after the
  // lock pass the change above would queue, were it wrongly to ask for one.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
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
  await check('resumed', 6, { prePaint: false, started: 0 });
  await page.evaluate(() => window.__stopSync());
});

// The phone's sweep has no CSS animation: one mask position, driven from
// script a step at a time (decorative-motion-sync.ts).
const RUNNING = ['visible', 'dock: open, agents view'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('phone: the mask position at step k is the keyframe interpolation, -band to 100% + rest, at step k of the frames', async (t) => {
  const page = await launch(t);
  const sweeps = await page.evaluate((RUNNING) => {
    document.documentElement.dataset.mixdogMobileTabs = 'true';
    document.documentElement.dataset.mixdogMotion = 'running';
    return RUNNING.map((name) => {
      const shimmer = document.querySelector(`[data-context="${name}"] [data-component="text-shimmer"]`);
      const glint = shimmer.querySelector('[data-slot="text-shimmer-glint"]');
      const vars = getComputedStyle(shimmer);
      const number = (property) => Number(vars.getPropertyValue(property));
      const frames = Math.round(
        Math.min((number('--text-shimmer-cells') + number('--text-shimmer-comet') + number('--text-shimmer-rest')) * 2.4, 76.8)
      );
      const band = Number.parseFloat(getComputedStyle(glint).maskSize);
      // --text-shimmer-rest-run in px.
      const probe = document.createElement('i');
      probe.style.cssText = 'position:absolute;width:var(--text-shimmer-rest-run)';
      glint.append(probe);
      const rest = probe.getBoundingClientRect().width;
      probe.remove();
      // A computed position keeps its percentage (of the box less the mask's width).
      const basis = glint.getBoundingClientRect().width - band;
      const maskX = () => {
        const value = getComputedStyle(glint).maskPosition;
        const x = value.startsWith('calc(') ? value.slice(5, value.indexOf(')')) : value.split(' ')[0];
        let px = 0;
        for (const [, sign, amount, unit] of x.matchAll(/(-\s*)?(-?[\d.]+)(%|px)/g)) {
          const signed = (sign ? -1 : 1) * Number(amount);
          px += unit === '%' ? (signed / 100) * basis : signed;
        }
        return px;
      };
      const positions = [];
      for (let step = 0; step <= frames; step += 1) {
        glint.style.setProperty('--text-shimmer-step', String(step));
        positions.push(maskX());
      }
      return {
        name,
        frames,
        band,
        rest,
        basis,
        positions,
        animation: getComputedStyle(glint).animationName,
        copy: getComputedStyle(glint, '::before').animationName,
      };
    });
  }, RUNNING);
  for (const { name, frames, band, rest, basis, positions, animation, copy } of sweeps) {
    assert.equal(animation, 'none', `${name}: the mask runs no CSS animation`);
    assert.equal(copy, 'none', `${name}: nor does its lit copy`);
    assert.ok(band > 0 && rest > 0 && basis > 0, `${name}: geometry measured`);
    const from = -band;
    const to = basis + rest;
    positions.forEach((position, step) => {
      const want = from + ((to - from) * step) / frames;
      // (The computed percentage serializes to a few digits: 1/50 px.)
      assert.ok(Math.abs(position - want) < 0.02, `${name} step ${step}: ${position} (want ${want})`);
    });
  }
});

/** A phone page with the sync module installed, every glint and the mark
 *  mounted through its ref hook, and every glint's step writes recorded. */
async function drivenPage(t, { phone }) {
  const page = await launch(t);
  const bundle = await build({
    entryPoints: [new URL('./decorative-motion-sync.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
    bundle: true,
    format: 'iife',
    globalName: 'motionSync',
    write: false,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const meta = await page.evaluate((phone) => {
    const root = document.documentElement;
    if (phone) root.dataset.mixdogMobileTabs = 'true';
    else delete root.dataset.mixdogMobileTabs;
    root.dataset.mixdogMotion = 'running';
    window.__stopSync = window.motionSync.installDecorativeMotionSync();
    window.__writes = [];
    const watch = new MutationObserver((records) => {
      const t = performance.now();
      for (const { target } of records) {
        window.__writes.push({
          context: target.closest('[data-context]').dataset.context,
          step: Number(target.style.getPropertyValue('--text-shimmer-step')),
          t,
        });
      }
    });
    const meta = {};
    for (const glint of document.querySelectorAll('[data-slot="text-shimmer-glint"]')) {
      const shimmer = glint.closest('[data-component="text-shimmer"]');
      const vars = getComputedStyle(shimmer);
      const number = (property) => Number(vars.getPropertyValue(property));
      meta[glint.closest('[data-context]').dataset.context] = Math.round(
        Math.min((number('--text-shimmer-cells') + number('--text-shimmer-comet') + number('--text-shimmer-rest')) * 2.4, 76.8)
      );
      watch.observe(glint, { attributes: true, attributeFilter: ['style'] });
      (window.__unmounts ??= new Map()).set(glint, window.motionSync.lockDecorativeLoops(glint));
    }
    for (const icon of document.querySelectorAll('.live-activity-icon')) window.motionSync.lockDecorativeLoops(icon);
    return meta;
  }, phone);
  t.after(() => page.evaluate(() => window.__stopSync()).catch(() => {}));
  const drain = () => page.evaluate(() => window.__writes.splice(0));
  return { page, meta, drain };
}

const FRAME = 1000 / 24;
const byContext = (writes) => {
  const grouped = {};
  for (const write of writes) (grouped[write.context] ??= []).push(write);
  return grouped;
};

test('phone: one write per step, on the running mark\'s beat, nothing while held', async (t) => {
  const { page, meta, drain } = await drivenPage(t, { phone: true });
  await sleep(300);
  await drain();
  await sleep(1500);
  const writes = byContext(await drain());
  for (const name of RUNNING) {
    const list = writes[name];
    const frames = meta[name];
    assert.ok(list?.length > 20, `${name}: stepping (${list?.length} writes in 1.5s)`);
    const span = list.at(-1).t - list[0].t;
    // One write per 1/24 s step: never two for a step, none on other frames.
    assert.ok(list.length <= Math.ceil(span / FRAME) + 1, `${name}: ${list.length} writes over ${span}ms`);
    list.forEach(({ step, t: time }, index) => {
      assert.equal(step, Math.floor(time / FRAME) % frames, `${name} write ${index}: the step of its time`);
      assert.ok(time % FRAME < FRAME * 0.75, `${name} write ${index}: ${time % FRAME}ms after the step's boundary`);
      if (index === 0) return;
      const advance = (step - list[index - 1].step + frames) % frames;
      assert.ok(advance >= 1 && advance <= 2, `${name} write ${index}: advanced ${advance} steps`);
    });
  }
  for (const name of Object.keys(meta).filter((name) => !RUNNING.includes(name))) {
    assert.equal(writes[name], undefined, `${name}: held, no writes`);
  }
  // The mark's loops sit on the same grid: locked to the timeline origin,
  // one step per 1/24 s, on the clock the steps above count from.
  const mark = await page.evaluate(() => {
    const strip = document.querySelector('[data-context="visible"] .live-activity-arc-strip');
    const [animation] = strip.getAnimations();
    return {
      startTime: animation.startTime,
      frame: animation.effect.getTiming().duration / Number(/steps\((\d+)/.exec(animation.effect.getKeyframes()[0].easing)[1]),
      clock: Math.abs(document.timeline.currentTime - performance.now()),
    };
  });
  assert.equal(mark.startTime, 0);
  assert.ok(Math.abs(mark.frame - FRAME) < 1e-9);
  assert.ok(mark.clock < 100, `the timeline and the writes share an origin (${mark.clock}ms apart)`);
});

test('phone: every pause rule stops the writes and the resume lands on the beat', async (t) => {
  const { page, meta, drain } = await drivenPage(t, { phone: true });
  const toggle = (selector, attribute, value) =>
    page.evaluate(
      (selector, attribute, value) => {
        const element = document.querySelector(selector);
        if (value === null) element.removeAttribute(attribute);
        else element.setAttribute(attribute, value);
      },
      selector,
      attribute,
      value
    );
  const rootMotion = (value) =>
    page.evaluate((value) => {
      document.documentElement.dataset.mixdogMotion = value;
    }, value);
  const reduced = (value) => page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value }]);
  const visibleRow = '[data-context="visible"] .transcript-virtual-row';
  const cases = [
    {
      label: 'row outside the range',
      scope: ['visible'],
      hold: () => toggle(visibleRow, 'data-offscreen', 'true'),
      release: () => toggle(visibleRow, 'data-offscreen', null),
    },
    {
      label: 'conversation parked',
      scope: ['visible'],
      hold: () => toggle('[data-context="visible"]', 'data-conversation-parked', 'true'),
      release: () => toggle('[data-context="visible"]', 'data-conversation-parked', null),
    },
    {
      label: 'retained surface',
      scope: ['visible'],
      hold: () => toggle('[data-context="visible"]', 'data-retained', ''),
      release: () => toggle('[data-context="visible"]', 'data-retained', null),
    },
    {
      label: 'dock pane inactive',
      scope: ['dock: open, agents view'],
      hold: () => toggle('[data-context="dock: open, agents view"] .utility-dock-pane', 'data-surface-active', 'false'),
      release: () => toggle('[data-context="dock: open, agents view"] .utility-dock-pane', 'data-surface-active', 'true'),
    },
    { label: 'document hidden', scope: RUNNING, hold: () => rootMotion('paused'), release: () => rootMotion('running') },
    { label: 'reduced motion', scope: RUNNING, hold: () => reduced('reduce'), release: () => reduced('no-preference') },
    {
      label: 'desktop layout',
      scope: RUNNING,
      hold: () =>
        page.evaluate(() => {
          delete document.documentElement.dataset.mixdogMobileTabs;
        }),
      release: () =>
        page.evaluate(() => {
          document.documentElement.dataset.mixdogMobileTabs = 'true';
        }),
    },
  ];
  await sleep(300);
  for (const { label, scope, hold, release } of cases) {
    await drain();
    await hold();
    await sleep(100);
    await drain();
    await sleep(300);
    const held = byContext(await drain());
    for (const name of scope) assert.equal(held[name], undefined, `${label}: ${name} holds, no writes`);
    for (const name of RUNNING.filter((name) => !scope.includes(name))) {
      assert.ok(held[name]?.length > 3, `${label}: ${name} keeps stepping`);
    }
    await release();
    await sleep(300);
    const resumed = byContext(await drain());
    for (const name of scope) {
      const list = resumed[name];
      assert.ok(list?.length > 3, `${label}: ${name} resumes (${list?.length} writes)`);
      list.forEach(({ step, t: time }, index) => {
        // The first write is the resume's own, wherever in the step it lands.
        if (index === 0) {
          const now = [Math.floor(time / FRAME), Math.floor((time - 3) / FRAME)].map((n) => n % meta[name]);
          assert.ok(now.includes(step), `${label}: ${name} resumes on the step of its time`);
        } else {
          assert.equal(step, Math.floor(time / FRAME) % meta[name], `${label}: ${name} write ${index} on the beat`);
          assert.ok(time % FRAME < FRAME * 0.75, `${label}: ${name} write ${index} on the beat`);
        }
      });
    }
  }
});

test('phone: one step timer while a glint runs; the last glint unmounting leaves none', async (t) => {
  const { page, drain } = await drivenPage(t, { phone: true });
  await sleep(300);
  // Held glints (offscreen, parked, ...) and the mark own no timer: count
  // the page's pending timeouts, which only the step timer uses. (The two
  // running glints are 'visible' and the open dock's.)
  await page.evaluate(() => {
    const pending = new Set();
    const { setTimeout: set, clearTimeout: clear } = window;
    window.setTimeout = (callback, ...rest) => {
      const id = set(() => {
        pending.delete(id);
        callback();
      }, ...rest);
      pending.add(id);
      return id;
    };
    window.clearTimeout = (id) => {
      pending.delete(id);
      clear(id);
    };
    window.__pendingTimers = () => pending.size;
    // Pause and resume to re-arm the timer under the counting wrappers.
    document.documentElement.dataset.mixdogMotion = 'paused';
  });
  await sleep(100);
  await page.evaluate(() => {
    document.documentElement.dataset.mixdogMotion = 'running';
  });
  await sleep(100);
  const unmount = (context) =>
    page.evaluate((context) => {
      const glint = document.querySelector(`[data-context="${context}"] [data-slot="text-shimmer-glint"]`);
      window.__unmounts.get(glint)();
      glint.remove();
      return window.__pendingTimers();
    }, context);
  await drain();
  assert.equal(await page.evaluate(() => window.__pendingTimers()), 1, 'two running glints share one timer');
  assert.equal(await unmount('visible'), 1, 'a remaining running glint keeps exactly one timer');
  // The rest are held by pause rules: nothing is left to wake for.
  assert.equal(await unmount('dock: open, agents view'), 0, 'the last running glint leaves no timer');
});

test('desktop: the sweep stays on its two CSS animations, nothing is written from script', async (t) => {
  const { page, drain } = await drivenPage(t, { phone: false });
  await sleep(600);
  assert.deepEqual(await drain(), []);
  const state = await page.evaluate(() =>
    [...document.querySelectorAll('[data-context="visible"] [data-slot="text-shimmer-glint"]')].map((glint) => ({
      style: glint.getAttribute('style'),
      animations: glint
        .getAnimations({ subtree: true })
        .map((animation) => `${animation.animationName}:${animation.playState}`),
    }))
  );
  assert.deepEqual(state, [
    { style: null, animations: ['text-shimmer-window:running', 'text-shimmer-window-copy:running'] },
  ]);
});
