import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

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
    };
    loops.push(loop);
    mark.getAnimations = () => {
      if (written) readsAfterWrite += 1;
      return [loop];
    };
    host.append(mark);
  }
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

// getAnimations flushes style for the whole document. Asked of every row whose
// offscreen mark a scroll changed, it ran a full style update after each range
// change though no row held a loop.
test('offscreen marks only read the loop hosts below a resumed row', async (t) => {
  const { window } = installTestDom(t, { expose: ['Element', 'MutationObserver'] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { installDecorativeMotionSync } = await import('./decorative-motion-sync.ts');
  const reads = [];
  const proto = window.Element.prototype;
  proto.getAnimations = function () {
    reads.push(this.className || this.getAttribute('data-slot'));
    return [];
  };
  t.after(() => {
    delete proto.getAnimations;
  });
  window.document.body.innerHTML = `
    <div class="transcript-virtual-row" id="plain"><article><pre><code><span>x</span></code></pre></article></div>
    <div class="transcript-virtual-row" id="live"><div class="live-activity"><span class="live-activity-arcs"><span class="live-activity-arc-strip"></span></span><span data-component="text-shimmer"><span data-slot="text-shimmer-glint"></span></span></div></div>`;
  const stop = installDecorativeMotionSync(window.document.documentElement);
  t.after(stop);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const plain = window.document.getElementById('plain');
  const live = window.document.getElementById('live');
  plain.setAttribute('data-offscreen', 'true');
  live.setAttribute('data-offscreen', 'true');
  await settle();
  assert.deepEqual(reads, [], 'a pause needs no lock');
  plain.removeAttribute('data-offscreen');
  await settle();
  assert.deepEqual(reads, [], 'a row without a loop host is never asked');
  live.removeAttribute('data-offscreen');
  await settle();
  assert.deepEqual(reads.sort(), ['live-activity-arc-strip', 'live-activity-arcs', 'text-shimmer-glint']);
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
