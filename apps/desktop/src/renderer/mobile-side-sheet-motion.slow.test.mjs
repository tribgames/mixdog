import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The phone sheets in 07-mobile-chrome.css: the right side sheet
// (.pane-side-dock), the left session drawer (.sidebar-drawer-frame) and its
// scrim (.sidebar-backdrop). Each one that was still `visibility: hidden` when
// its open began was "no visible change" to Chromium, so its transform/opacity
// ran on the main thread and any long task (a body mount) froze it mid-slide.
// The drawer also starts every phone session with an instant close, and the
// first tap's intent stamp opened it in one jump before the commit reset
// data-motion.

const FIXTURE = `
  <div class="main-panel" style="position: fixed; inset: 0;">
    <div class="conversation" style="height: 100%;"><p>Chat</p></div>
    <div class="pane-side-dock" data-open="false">
      <header class="dock-header-row">Visualize</header>
      <div class="pane-side-dock-main">
        <aside class="workbench-side-panel" data-side="right" hidden>
          <div class="workbench-side-panel-content"><div class="workbench-side-panel-body">Body</div></div>
        </aside>
      </div>
    </div>
  </div>
  <div class="sidebar-drawer-frame" data-state="closed" data-motion="instant">
    <nav class="activity-rail"></nav>
    <aside class="workbench-side-panel" data-side="left"><p>Sessions</p></aside>
  </div>
  <button class="sidebar-backdrop" data-state="closed" aria-label="Close"></button>`;
// AppShellLayout renders the scrim as the drawer frame's next sibling.

// Every surface's state and the in-page triggers. The drawer opens as the app
// does: the tap stamps html[data-drawer-intent], the commit two frames later
// sets data-state/data-motion and drops the stamp (use-app-shell-panels.ts).
const PROBES = `
  const tick = document.createElement('div');
  tick.style.cssText = 'position: fixed; top: 0; left: 0; width: 1px; height: 1px; visibility: hidden; pointer-events: none;';
  document.body.append(tick);
  let width = 1;
  const read = (selector) => {
    const element = document.querySelector(selector);
    const style = getComputedStyle(element);
    return {
      left: element.getBoundingClientRect().left,
      opacity: Number(style.opacity),
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
    };
  };
  window.readSurfaces = () => ({
    dock: read('.pane-side-dock'), drawer: read('.sidebar-drawer-frame'), scrim: read('.sidebar-backdrop'),
  });
  // Samples every frame from a ResizeObserver delivery (a probe resized from
  // each frame callback); arm it before the trigger.
  window.arm = () => {
    const frames = [];
    let raf = 0;
    const observer = new ResizeObserver(() => {
      frames.push({ now: performance.now(), ...window.readSurfaces() });
      raf = requestAnimationFrame(() => { width = 3 - width; tick.style.width = width + 'px'; });
    });
    observer.observe(tick);
    window.stop = () => { observer.disconnect(); cancelAnimationFrame(raf); return frames; };
  };
  window.setDock = (open) => {
    const dock = document.querySelector('.pane-side-dock');
    dock.dataset.open = String(open);
    dock.querySelector('.workbench-side-panel').hidden = !open;
    return performance.now();
  };
  const commitDrawer = (open, motion) => {
    for (const selector of ['.sidebar-drawer-frame', '.sidebar-backdrop']) {
      document.querySelector(selector).dataset.state = open ? 'open' : 'closed';
    }
    document.querySelector('.sidebar-drawer-frame').dataset.motion = motion;
    document.documentElement.removeAttribute('data-drawer-intent');
  };
  window.tapDrawer = (open) => {
    document.documentElement.setAttribute('data-drawer-intent', open ? 'open' : 'closed');
    requestAnimationFrame(() => requestAnimationFrame(() => commitDrawer(open, 'animated')));
    return performance.now();
  };
  // A navigation close or the phone start: no stamp, instant motion.
  window.instantDrawer = (open) => {
    commitDrawer(open, 'instant');
    return performance.now();
  };
  // The body mount: a long main-thread task two frames after the open.
  window.longTaskLater = (ms) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const end = performance.now() + ms;
    while (performance.now() < end) {}
  }));
`;

const wait = (page, ms) => page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), ms);

async function frame(page, count = 2) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
        step(count);
      }),
    count
  );
}

/** Each surface's open trigger, the property it moves and its sampled value. */
const SURFACES = [
  {
    label: 'the right side sheet',
    node: /pane-side-dock/,
    property: 'transform',
    value: (sample) => sample.dock.left,
    visibility: (sample) => sample.dock.visibility,
    open: () => window.setDock(true),
    close: () => window.setDock(false),
  },
  {
    label: 'the session drawer',
    node: /sidebar-drawer-frame/,
    property: 'transform',
    value: (sample) => sample.drawer.left,
    visibility: (sample) => sample.drawer.visibility,
    open: () => window.tapDrawer(true),
    close: () => window.tapDrawer(false),
  },
  {
    label: 'the drawer scrim',
    node: /sidebar-backdrop/,
    property: 'opacity',
    value: (sample) => sample.scrim.opacity,
    visibility: (sample) => sample.scrim.visibility,
    open: () => window.tapDrawer(true),
    close: () => window.tapDrawer(false),
  },
];

/** Compositing verdicts of every transition Chromium started in the trace. */
function animationsOf(trace) {
  const started = new Map();
  const runs = [];
  for (const event of trace.traceEvents ?? trace) {
    if (event.name !== 'Animation') continue;
    const key = event.id2?.local ?? event.id;
    if (event.ph === 'b') {
      const run = { ...event.args?.data, failed: [] };
      started.set(key, run);
      runs.push(run);
    }
    const failed = event.ph === 'n' ? event.args?.data?.compositeFailed : undefined;
    if (failed !== undefined) started.get(key)?.failed.push(failed);
  }
  return runs;
}

/** Fraction of the way from the closed to the open value. */
const progress = (surface, rest, sample) => (surface.value(sample) - rest.closed) / (rest.open - rest.closed);

test('the phone sheets and drawer move on the compositor, continuously, from the tap', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const styles = await build({
    stdin: {
      resolveDir,
      loader: 'css',
      contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
    },
    outfile: 'mobile-side-sheet-motion.css',
    bundle: true,
    write: false,
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.jpg': 'dataurl',
      '.png': 'dataurl',
    },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setContent(
    `<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${FIXTURE}</body></html>`
  );
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: PROBES });
  // The stylesheet arrives after the fixture, so the sheets first move to their parking places.
  await wait(page, 500);
  await frame(page, 4);
  const closed = await page.evaluate(() => window.readSurfaces());
  assert.ok(closed.dock.left >= 389, 'the closed side sheet parks off the right edge');
  assert.ok(closed.drawer.left < -300, 'the closed drawer parks off the left edge');
  assert.equal(closed.scrim.opacity, 0, 'the closed scrim is clear');
  for (const surface of SURFACES) assert.equal(surface.visibility(closed), 'hidden', `${surface.label} rests hidden`);

  // Every open is traced under a long task two frames in, for Chromium's
  // compositing verdict (a main-thread sample cannot see compositor
  // progress, so these opens are judged by the trace). The first drawer tap
  // follows the phone start's instant close (the fixture's data-motion).
  await page.tracing.start({ categories: ['blink.animations', 'devtools.timeline'] });
  for (const trigger of [() => window.setDock(true), () => window.tapDrawer(true)]) {
    await page.evaluate(`(${trigger.toString()})(); window.longTaskLater(120);`);
    await wait(page, 700);
  }
  const trace = JSON.parse(Buffer.from(await page.tracing.stop()).toString('utf8'));
  const animations = animationsOf(trace);
  for (const surface of SURFACES) {
    const opens = animations.filter(
      (run) => run.displayName === surface.property && surface.node.test(run.nodeName ?? '')
    );
    assert.ok(
      opens.length > 0,
      `${surface.label}: the open runs a ${surface.property} transition (the first drawer tap included)`
    );
    assert.deepEqual(
      opens.flatMap((run) => run.failed),
      [],
      `${surface.label}: the open ${surface.property} runs on the compositor (no compositeFailed)`
    );
  }
  const open = await page.evaluate(() => window.readSurfaces());
  await page.evaluate(() => {
    window.setDock(false);
    window.instantDrawer(false);
  });
  await wait(page, 500);

  for (const surface of SURFACES) {
    const rest = { closed: surface.value(closed), open: surface.value(open) };
    // An unloaded open, sampled every frame from before the tap: on its way
    // within the first frames, never already at rest, never backwards, visible
    // throughout, then at rest.
    await page.evaluate(() => window.arm());
    await frame(page);
    const tapAt = await page.evaluate(`(${surface.open.toString()})()`);
    await wait(page, 500);
    const opening = (await page.evaluate(() => window.stop())).filter((sample) => sample.now >= tapAt);
    const first = opening.find((sample) => progress(surface, rest, sample) > 0.001);
    assert.ok(first, `${surface.label} moved`);
    // Responsiveness is reported; the bound only catches a dead tap, not CI jitter.
    const firstMs = Math.round(first.now - tapAt);
    t.diagnostic(`${surface.label}: first moved frame ${firstMs}ms after the tap`);
    assert.ok(firstMs <= 500, `${surface.label}: first moved frame ${firstMs}ms after the tap`);
    assert.ok(
      progress(surface, rest, first) < 0.999,
      `${surface.label}: the first moved frame is not already the end state`
    );
    for (let index = 1; index < opening.length; index++) {
      assert.ok(
        progress(surface, rest, opening[index]) >= progress(surface, rest, opening[index - 1]) - 0.001,
        `${surface.label} never moves back`
      );
    }
    for (const sample of opening) {
      if (progress(surface, rest, sample) > 0.001)
        assert.equal(surface.visibility(sample), 'visible', `${surface.label}: visible while it opens`);
    }
    assert.ok(Math.abs(progress(surface, rest, opening.at(-1)) - 1) < 0.001, `${surface.label} comes to rest open`);

    // The exit stays visible until it is gone, then hides.
    await page.evaluate(() => window.arm());
    await frame(page);
    await page.evaluate(`(${surface.close.toString()})()`);
    await wait(page, 500);
    const closing = await page.evaluate(() => window.stop());
    const between = closing.filter((sample) => {
      const p = progress(surface, rest, sample);
      return p > 0.001 && p < 0.999;
    });
    assert.ok(between.length >= 2, `${surface.label}: the exit moves over several frames (${between.length})`);
    for (const sample of between)
      assert.equal(surface.visibility(sample), 'visible', `${surface.label}: the exit stays visible`);
    assert.equal(surface.visibility(closing.at(-1)), 'hidden', `${surface.label}: the closed state hides`);
  }

  // A drawer change with no tap stamp and instant motion (a navigation
  // close): the drawer and its scrim land at their end state on the first
  // frame after it, and stay there.
  for (const opened of [true, false]) {
    await page.evaluate(() => window.arm());
    await frame(page);
    const changedAt = await page.evaluate((opened) => window.instantDrawer(opened), opened);
    await frame(page, 6);
    const steps = (await page.evaluate(() => window.stop())).filter((sample) => sample.now >= changedAt);
    const label = `an instant drawer ${opened ? 'open' : 'close'}`;
    assert.ok(steps.length >= 4, `${label}: sampled frames after the change (${steps.length})`);
    const end = opened ? open : closed;
    for (const sample of steps) {
      assert.ok(Math.abs(sample.drawer.left - end.drawer.left) < 0.5, `${label}: the drawer lands in one step`);
      assert.equal(
        sample.drawer.visibility,
        opened ? 'visible' : 'hidden',
        `${label}: the drawer visibility lands at once`
      );
      assert.equal(sample.scrim.opacity, opened ? 1 : 0, `${label}: the scrim lands in one step`);
      assert.equal(
        sample.scrim.visibility,
        opened ? 'visible' : 'hidden',
        `${label}: the scrim visibility lands at once`
      );
      assert.equal(
        sample.scrim.pointerEvents,
        opened ? 'auto' : 'none',
        `${label}: the scrim's hit target follows at once`
      );
    }
  }

  // Reduced motion: every surface opens and closes in one step.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  for (const opened of [true, false]) {
    await page.evaluate(() => window.arm());
    await frame(page);
    await page.evaluate((opened) => {
      window.setDock(opened);
      window.tapDrawer(opened);
    }, opened);
    await frame(page, 8);
    const steps = await page.evaluate(() => window.stop());
    for (const surface of SURFACES) {
      const rest = { closed: surface.value(closed), open: surface.value(open) };
      assert.equal(
        steps.filter((sample) => {
          const p = progress(surface, rest, sample);
          return p > 0.001 && p < 0.999;
        }).length,
        0,
        `reduced motion: ${surface.label} ${opened ? 'opens' : 'closes'} in one step`
      );
    }
  }
  assert.deepEqual(errors, []);
});
