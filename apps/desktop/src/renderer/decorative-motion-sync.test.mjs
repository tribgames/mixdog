import assert from 'node:assert/strict';
import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

// A list mounting its running marks starts many loops in one frame. Each
// lock writes a start time, which invalidates style: a loop list read after
// such a write forced another full style update, so a burst of N starts cost
// N style updates in one task (a long task after every reload and reconnect).
test('a burst of loop starts locks in one pass that reads every loop before writing any', async (t) => {
  const { window } = installTestDom(t, { expose: ['Element', 'MutationObserver'] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const frames = [];
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = () => {};
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  const { installDecorativeMotionSync } = await import('./decorative-motion-sync.ts');
  let written = false;
  let readsAfterWrite = 0;
  const loops = [];
  const host = window.document.createElement('section');
  window.document.body.append(host);
  for (let index = 0; index < 4; index += 1) {
    const mark = window.document.createElement('span');
    mark.className = 'live-activity-arcs';
    let startTime = 120 + index;
    const loop = {
      animationName: 'live-activity-logo-spin',
      playState: 'running',
      get startTime() {
        return startTime;
      },
      set startTime(value) {
        written = true;
        startTime = value;
      },
      effect: { target: mark },
    };
    loops.push(loop);
    host.append(mark);
  }
  window.document.getAnimations = () => {
    if (written) readsAfterWrite += 1;
    return loops;
  };
  const stop = installDecorativeMotionSync(window.document.documentElement);
  t.after(stop);
  for (const mark of host.children) {
    const event = new window.Event('animationstart', { bubbles: true });
    event.animationName = 'live-activity-logo-spin';
    mark.dispatchEvent(event);
  }
  for (const frame of frames.splice(0)) frame(0);
  assert.deepEqual(
    loops.map((loop) => loop.startTime),
    [0, 0, 0, 0]
  );
  assert.equal(readsAfterWrite, 0);
});

/** Running loops on every host below `scope`, read through one document-wide
 *  `getAnimations` the test counts. */
function documentLoops(window, scope = window.document) {
  const loops = [
    ...scope.querySelectorAll('.live-activity-arcs, .live-activity-arc-strip, [data-slot="text-shimmer-glint"]'),
  ].map((host) => ({
    animationName: 'live-activity-logo-spin',
    playState: 'running',
    startTime: 50,
    effect: { target: host },
  }));
  const reads = { count: 0 };
  window.document.getAnimations = () => {
    reads.count += 1;
    return loops;
  };
  return { loops, reads };
}

// getAnimations flushes style for the whole document. Asked of every row whose
// offscreen mark a scroll changed, it ran a full style update after each range
// change though no row held a loop.
test('offscreen marks only lock the loop hosts below a resumed row', async (t) => {
  const { window } = installTestDom(t, { expose: ['Element', 'MutationObserver'] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { installDecorativeMotionSync } = await import('./decorative-motion-sync.ts');
  window.document.body.innerHTML = `
    <div class="transcript-virtual-row" id="plain"><article><pre><code><span>x</span></code></pre></article></div>
    <div class="transcript-virtual-row" id="live"><div class="live-activity"><span class="live-activity-arcs"><span class="live-activity-arc-strip"></span></span><span data-component="text-shimmer"><span data-slot="text-shimmer-glint"></span></span></div></div>
    <div class="transcript-virtual-row" id="other"><span class="live-activity-arcs"></span></div>`;
  const { loops, reads } = documentLoops(window);
  const frames = [];
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = () => {};
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  const stop = installDecorativeMotionSync(window.document.documentElement);
  t.after(stop);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const frame of frames.splice(0)) frame(0);
  };
  const plain = window.document.getElementById('plain');
  const live = window.document.getElementById('live');
  plain.setAttribute('data-offscreen', 'true');
  live.setAttribute('data-offscreen', 'true');
  await settle();
  assert.equal(reads.count, 0, 'a pause needs no lock');
  plain.removeAttribute('data-offscreen');
  await settle();
  assert.equal(reads.count, 0, 'a row without a loop host reads nothing');
  live.removeAttribute('data-offscreen');
  await settle();
  assert.equal(reads.count, 1, 'the resumed row reads once');
  const locked = loops.filter((loop) => loop.startTime === 0).map((loop) => loop.effect.target.closest('[id]').id);
  assert.deepEqual(locked, ['live', 'live', 'live'], 'the resumed row only');
});

// A phone back from the background: the root mode flips and rows unpause
// across several commits (each its own mutation delivery) within one frame.
// Each delivery used to lock at once, a full style update apiece.
test('a resume locks its root mode change and every unpaused row in one pass per frame', async (t) => {
  const { window } = installTestDom(t, { expose: ['Element', 'MutationObserver'] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const frames = [];
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = () => {};
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  const { installDecorativeMotionSync } = await import('./decorative-motion-sync.ts');
  window.document.body.innerHTML = [1, 2, 3]
    .map(
      (n) =>
        `<div class="transcript-virtual-row" id="row${n}" data-offscreen="true"><span class="live-activity-arcs" id="arcs${n}"></span></div>`
    )
    .join('');
  const { loops, reads } = documentLoops(window);
  const stop = installDecorativeMotionSync(window.document.documentElement);
  t.after(stop);
  const delivery = () => new Promise((resolve) => setTimeout(resolve, 0));
  window.document.documentElement.setAttribute('data-visibility', 'visible');
  await delivery();
  for (const n of [1, 2, 3]) {
    window.document.getElementById(`row${n}`).removeAttribute('data-offscreen');
    await delivery();
  }
  assert.equal(reads.count, 0, 'nothing is read before the frame');
  for (const frame of frames.splice(0)) frame(0);
  assert.equal(reads.count, 1, 'one read serves every loop host');
  assert.deepEqual(
    loops.map((loop) => loop.startTime),
    [0, 0, 0]
  );
});

// A commit mounting several marks ran one document-wide read per mark's ref,
// each a full style update and a pass over every animation on the page.
test('mounts, a resume and a root mode change in one frame lock with one document read', async (t) => {
  const { window } = installTestDom(t, { expose: ['Element', 'MutationObserver'] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const frames = [];
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = () => {};
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  const { installDecorativeMotionSync, lockDecorativeLoops } = await import('./decorative-motion-sync.ts');
  window.document.body.innerHTML = `
    <div class="transcript-virtual-row" id="row" data-offscreen="true"><span class="live-activity-arcs"></span></div>
    <div id="mounted"><span class="live-activity-icon"><span class="live-activity-arcs"></span></span><span class="live-activity-icon"><span class="live-activity-arcs"></span></span><span data-slot="text-shimmer-glint"></span></div>`;
  const { loops, reads } = documentLoops(window);
  const stop = installDecorativeMotionSync(window.document.documentElement);
  t.after(stop);
  const delivery = () => new Promise((resolve) => setTimeout(resolve, 0));
  for (const element of window.document.querySelectorAll('#mounted > *')) lockDecorativeLoops(element);
  window.document.getElementById('row').removeAttribute('data-offscreen');
  await delivery();
  window.document.documentElement.setAttribute('data-visibility', 'visible');
  await delivery();
  assert.equal(reads.count, 0, 'nothing is read before the frame');
  assert.equal(frames.length, 1, 'one lock pass is queued');
  for (const frame of frames.splice(0)) frame(0);
  assert.equal(reads.count, 1, 'one read serves the mounts, the resume and the root mode');
  assert.deepEqual(
    loops.map((loop) => loop.startTime),
    [0, 0, 0, 0]
  );
});

// A hidden window runs no animation frames: every mark mounted and unmounted
// meanwhile (rows scrolling, tool runs coming and going) stayed queued, its
// detached subtree with it, until the window showed again.
test('an unmounted mark leaves the lock queue while frames are withheld, a mounted one locks when they resume', async (t) => {
  const { window } = installTestDom(t, { expose: ['Element', 'MutationObserver'] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const frames = [];
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = () => {};
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  const { installDecorativeMotionSync, lockDecorativeLoops } = await import('./decorative-motion-sync.ts');
  const stop = installDecorativeMotionSync(window.document.documentElement);
  t.after(stop);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const mark = (id) =>
    React.createElement(
      'span',
      { key: id, id, className: 'live-activity-icon', ref: lockDecorativeLoops },
      React.createElement('span', { className: 'live-activity-arcs' })
    );
  act(() => root.render([mark('kept'), mark('gone')]));
  const gone = new WeakRef(window.document.getElementById('gone'));
  act(() => root.render([mark('kept')]));
  for (let pass = 0; pass < 3; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
  assert.equal(gone.deref(), undefined, 'the queue let the unmounted mark go');
  const { loops, reads } = documentLoops(window);
  assert.equal(reads.count, 0, 'nothing locks while frames are withheld');
  for (const frame of frames.splice(0)) frame(0);
  assert.equal(reads.count, 1);
  assert.deepEqual(
    loops.map((loop) => [loop.effect.target.parentElement.id, loop.startTime]),
    [['kept', 0]]
  );
  act(() => root.unmount());
});

// Resumes and starts have no unmount hook: a row resumed while frames are
// withheld and then removed stayed queued, its subtree with it.
test('a removed row leaves the lock queue on the next enqueue while frames are withheld, a live one locks when they resume', async (t) => {
  const { window } = installTestDom(t, { expose: ['Element', 'MutationObserver'] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const frames = [];
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = () => {};
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  const { installDecorativeMotionSync } = await import('./decorative-motion-sync.ts');
  window.document.body.innerHTML = ['gone', 'live']
    .map(
      (id) =>
        `<div class="transcript-virtual-row" id="${id}" data-offscreen="true"><span class="live-activity-arcs"></span></div>`
    )
    .join('');
  const stop = installDecorativeMotionSync(window.document.documentElement);
  t.after(stop);
  const delivery = () => new Promise((resolve) => setTimeout(resolve, 0));
  const gone = new WeakRef(window.document.getElementById('gone'));
  gone.deref().removeAttribute('data-offscreen');
  await delivery();
  gone.deref().remove();
  window.document.getElementById('live').removeAttribute('data-offscreen');
  await delivery();
  for (let pass = 0; pass < 3; pass += 1) {
    await delivery();
    gc();
  }
  assert.equal(gone.deref(), undefined, 'the queue let the removed row go');
  const { loops, reads } = documentLoops(window);
  assert.equal(reads.count, 0, 'nothing locks while frames are withheld');
  for (const frame of frames.splice(0)) frame(0);
  assert.equal(reads.count, 1);
  assert.deepEqual(
    loops.map((loop) => [loop.effect.target.parentElement.id, loop.startTime]),
    [['live', 0]]
  );
});

test('every stylesheet rule that runs a decorative loop targets a loop host', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { DECORATIVE_LOOP_HOSTS } = await import('./decorative-motion-sync.ts');
  const hosts = DECORATIVE_LOOP_HOSTS.split(',').map((host) => host.trim());
  const loops =
    /animation(?:-name)?\s*:[^;{}]*\b(live-activity-arc-flow|live-activity-logo-spin|text-shimmer-window|text-shimmer-window-copy|text-shimmer-mask)\b/;
  const directory = new URL('./desktop/', import.meta.url);
  let rules = 0;
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(new URL(file, directory), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!loops.test(body)) continue;
      rules += 1;
      for (const selector of selectors.split(',')) {
        const subject = selector
          .trim()
          .replace(/::?before$/, '')
          .split(/\s+|>/)
          .at(-1);
        assert.ok(
          hosts.some((host) => subject.includes(host)),
          `${file}: "${selector.trim()}" runs a decorative loop outside DECORATIVE_LOOP_HOSTS`
        );
      }
    }
  }
  assert.ok(rules >= 5, `found ${rules} loop rules`);
});
