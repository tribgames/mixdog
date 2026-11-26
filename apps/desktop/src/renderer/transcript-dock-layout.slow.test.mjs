import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const HARNESS = `
  import { Suspense, useLayoutEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { BtwCard } from './BtwCard';
  import { ComposerDock } from './ComposerDock';
  import { SessionGoalIsland } from './SessionGoalIsland';
  import { TranscriptList } from './TranscriptList';
  import { useTranscriptFollow } from './use-transcript-follow';
  import { PaneKeyContext } from './pane-key-context';
  import { openReaderPlace } from './transcript-list-reader-place';
  import { setHistoryPositions } from '../../../../packages/protocol-client/src/rows';

  const root = createRoot(document.getElementById('root'));
  const pending = new Map();
  // No changed files: the island carries the Goal segment alone.
  window.mixdogDesktop = {
    invokeCapability: async () => ({ value: {
      supported: true, authoritative: true, complete: true, snapshotKind: 'worktree',
      checkpointId: 'prompt', patch: '', files: [], agents: [],
    } }),
  };
  const empty = [];
  // Each row shows a stored record: a pane can be handed a reader's place on one.
  const rows = Array.from({ length: 40 }, (_, index) => ({
    key: 'message-' + index, _tag: 'AssistantPart',
    item: setHistoryPositions({ kind: 'assistant', text: 'Message ' + index }, 'p-' + index, 'p-' + index),
  }));
  window.openPlace = (session, place) => openReaderPlace('pane-1', session, place);
  function Body({ id }) {
    if (pending.has(id)) throw pending.get(id).promise;
    return <article data-body={id}>
      <h3>{id}</h3><p>Paragraph with <strong>formatted content</strong>.</p>
      <table><tbody><tr><td>Table</td><td>Stable row</td></tr></tbody></table>
      <pre>const value = 42;<br />return value;</pre>
    </article>;
  }
  const quotaCard = { resetAt: Date.now() + 3_600_000, otherAccount: false, reserved: false, busy: false };
  const btwCard = { question: 'A side question?', status: 'failed', text: '', error: 'The side answer failed.' };
  function Harness({ session }) {
    const [state, setState] = useState({
      goal: false, approval: false, quota: false, btw: false, revision: 0,
    });
    const viewport = useRef(null), content = useRef(null);
    const scrollToEndRef = useRef(() => {}), setAnchorBottomRef = useRef(() => {});
    const follow = useTranscriptFollow({
      viewport, content, sessionKey: session, scrollToEndRef, setAnchorBottomRef,
    });
    useLayoutEffect(() => {
      window.fixture = {
        change: (patch) => {
          flushSync(() => setState(previous => ({ ...previous, ...patch })));
        },
        // The real field-sizing growth: a value change with no React render.
        type: (text) => {
          document.querySelector('.composer textarea').value = text;
        },
        read: () => {
          flushSync(() => follow.pause());
          viewport.current.scrollTop = Math.max(0, viewport.current.scrollHeight - viewport.current.clientHeight - 600);
        },
        following: () => follow.followingRef.current,
        follow: () => follow.resume(),
        suspend: (id) => {
          let resolve;
          const promise = new Promise(done => resolve = done);
          pending.set(id, { promise, resolve });
          flushSync(() => setState(previous => ({ ...previous, revision: previous.revision + 1 })));
        },
        resolve: (id) => {
          const entry = pending.get(id);
          pending.delete(id);
          entry.resolve();
        },
      };
    });
    return <section className="conversation">
      <div className="transcript-shell">
        <div className="transcript" ref={viewport} onScroll={follow.handleScroll} onWheel={follow.handleWheel}
          onPointerDown={follow.handlePointerDown} onPointerMove={follow.handlePointerMove}
          onPointerUp={follow.handlePointerUp} onPointerCancel={follow.handlePointerUp}>
          <div className="thread">
            <TranscriptList sessionKey={session} rows={rows} viewport={viewport} content={content}
              shouldAnchorBottom={follow.following}
              scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
              markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
              onSelectionAutoScroll={follow.handleSelectionAutoScroll}
              renderRow={row => <Suspense fallback={<span hidden data-transcript-pending />}>
                <Body id={row.key} />
              </Suspense>} />
          </div>
        </div>
        <button className="jump-to-latest">Latest</button>
      </div>
      <ComposerDock sessionId={session} goalSubmissionId="" showProjectSelector={false}
        goalIsland={state.goal ? <SessionGoalIsland snapshot={{
          sessionId: session, goal: {
            id: 'goal', title: 'Keep the reading position', objective: 'Stable layout', status: 'paused',
            tasks: [{ id: 'task', title: 'Check layout', status: 'pending' }],
          },
        }} /> : null}
        approval={state.approval ? <article className="approval-card"
          style={{ height: state.approval === true ? 180 : state.approval }}>Approve?</article> : null}
        quotaCard={state.quota ? quotaCard : null}
        reviewItems={empty} reviewActive reviewBusy={false}
        reviewSessionId={session} reviewCwd="C:/fixture">
        {state.btw && <BtwCard card={btwCard} onClose={() => {}} onRetry={() => {}} />}
        <form className="composer">
          <textarea aria-label="Composer" defaultValue="Fixture input" />
        </form>
      </ComposerDock>
    </section>;
  }
  // A pane key keeps the reader's places of the sessions mounted in it.
  window.mountFixture = (session, pane = '') => {
    pending.clear();
    flushSync(() => root.render(<PaneKeyContext.Provider value={pane}>
      <Harness key={session} session={session} />
    </PaneKeyContext.Provider>));
  };
`;

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const PAGE_PROBES = `
  window.geometry = (key) => {
    const viewport = document.querySelector('.transcript');
    const dock = document.querySelector('.composer-region');
    const view = viewport.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const visible = [...document.querySelectorAll('.transcript-virtual-row')].find((row) => {
      const box = row.getBoundingClientRect();
      return box.top >= view.top && box.bottom < view.bottom;
    });
    const row = key ? document.querySelector('[data-timeline-key="' + key + '"]') : visible;
    const last = document.querySelector('[data-timeline-key="message-39"]');
    const slot = document.querySelector('.composer-island-slot');
    return {
      now: performance.now(),
      composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom,
      paneBottom: document.querySelector('.conversation').getBoundingClientRect().bottom,
      presence: slot?.getAttribute('data-presence') ?? null,
      motion: slot?.hasAttribute('data-motion') ?? false,
      viewportHeight: view.height,
      viewportBottom: view.bottom,
      // What shows of the viewport: its shell clips the part that runs on under the dock.
      shownBottom: viewport.parentElement.getBoundingClientRect().bottom,
      top: viewport.scrollTop,
      key: row?.dataset.timelineKey,
      rowTop: row?.getBoundingClientRect().top,
      rowHeight: row?.getBoundingClientRect().height,
      dockHeight: dockBox.height,
      dockTop: dockBox.top,
      slotHeight: slot ? slot.getBoundingClientRect().height : 0,
      gap: last ? dockBox.top - last.getBoundingClientRect().bottom : null,
      following: window.fixture.following(),
      jumpBottom: document.querySelector('.jump-to-latest').getBoundingClientRect().bottom,
    };
  };
  window.watchGeometry = (key) => {
    const frames = [];
    const observer = new ResizeObserver(() => frames.push(window.geometry(key)));
    observer.observe(document.querySelector('.transcript'));
    observer.observe(document.querySelector('.composer-region'));
    window.stopWatch = () => {
      observer.disconnect();
      return frames;
    };
  };
  // Chromium can run a posted task between a frame's animation callbacks and its layout, so a
  // read from one forces a layout the timeline has not observed. A probe resized from each frame
  // callback makes every frame deliver; the sampler reads in that delivery.
  const tick = document.createElement('div');
  tick.style.cssText = 'position: fixed; top: 0; left: 0; width: 1px; height: 1px; visibility: hidden; pointer-events: none;';
  document.body.append(tick);
  let tickWidth = 1;
  let sampler = null;
  // A throw inside the sampler's delivery, kept for the settle that follows.
  let failure = null;
  // Samples every frame from now on; arm it before triggering a change, so a
  // change that eases while the caller still waits on it is not missed.
  window.armPainted = (key) => {
    if (sampler) throw new Error('the painted-frame sampler is already armed');
    failure = null;
    const frames = [];
    let raf = 0;
    let finish = null;
    const stop = () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      sampler = null;
    };
    // Created after the timeline's observers, so it runs after them (and
    // their microtasks) in each delivery; a new observation delivers once.
    const observer = new ResizeObserver(() => {
      try {
        frames.push(window.geometry(key));
        finish?.check();
        if (!sampler) return;
        raf = requestAnimationFrame(() => {
          tickWidth = 3 - tickWidth;
          tick.style.width = tickWidth + 'px';
        });
      } catch (error) {
        stop();
        failure = error;
        finish?.reject(error);
      }
    });
    observer.observe(tick);
    sampler = {
      settle: (boundMs) => new Promise((resolve, reject) => {
        const from = frames.length;
        const timer = setTimeout(() => {
          stop();
          const last = frames.at(-1);
          reject(new Error('the dock did not rest within ' + boundMs + 'ms: ' + (frames.length - from) +
            ' frames sampled, last ' + JSON.stringify(last && { dockHeight: last.dockHeight, top: last.top, gap: last.gap, motion: last.motion, presence: last.presence })));
        }, boundMs);
        finish = {
          check() {
            const last = frames.slice(Math.max(from, frames.length - 6));
            if (last.length < 6 || last[5].motion || last[5].presence === 'grace') return;
            if (!last.every((frame) => frame.dockHeight === last[5].dockHeight &&
              frame.top === last[5].top && frame.gap === last[5].gap)) return;
            clearTimeout(timer);
            stop();
            resolve(frames);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        };
        finish.check();
      }),
    };
  };
  window.paintedUntilSettled = (boundMs = 10000) => {
    if (failure) return Promise.reject(failure);
    if (!sampler) return Promise.reject(new Error('arm the painted-frame sampler before the change'));
    return sampler.settle(boundMs);
  };
`;

async function geometry(page, key) {
  return page.evaluate((key) => window.geometry(key), key);
}

/** Every bottom-chrome member growing, then shrinking back to an empty dock.
 *  Island changes set the slot's height in one step (ISLAND_MOTION), the last
 *  content leaving first holds it for the grace (ISLAND_GRACE). */
const ISLAND_MOTION = 'island-motion';
const ISLAND_GRACE = 'island-grace';
/** A panel floating over the transcript: the dock keeps its height on every
 *  frame, so nothing under it moves. */
const ISLAND_OVERLAY = 'island-overlay';
const ISLAND_COLLAPSE_GRACE_MS = 500;
function dockChanges(page) {
  const change = (patch) => () => page.evaluate((patch) => window.fixture.change(patch), patch);
  return [
    [
      'island content appears',
      async () => {
        await change({ goal: true })();
        await page.waitForSelector('.session-goal-island');
      },
      ISLAND_MOTION,
    ],
    [
      'Goal panel expands',
      async () => {
        await page.click('.session-goal-trigger');
        await page.waitForSelector('.session-goal-island[data-open="true"]');
      },
      ISLAND_OVERLAY,
    ],
    [
      'Goal panel collapses',
      async () => {
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.session-goal-island[data-open="true"]'));
      },
      ISLAND_OVERLAY,
    ],
    ['approval card opens', change({ approval: true }), ISLAND_MOTION],
    ['approval card closes', change({ approval: false }), ISLAND_MOTION],
    [
      'island content disappears',
      async () => {
        await change({ goal: false })();
        await page.waitForFunction(() => !document.querySelector('.session-goal-island'));
      },
      ISLAND_GRACE,
    ],
    ['quota card opens', change({ quota: true })],
    ['quota card closes', change({ quota: false })],
    ['/btw card opens', change({ btw: true })],
    ['/btw card closes', change({ btw: false })],
    ['textarea grows', () => page.evaluate(() => window.fixture.type('one\ntwo\nthree\nfour\nfive\nsix'))],
    ['textarea clears', () => page.evaluate(() => window.fixture.type(''))],
  ];
}

const approvalChange = (page, open) => () => page.evaluate((open) => window.fixture.change({ approval: open }), open);

/** Runs one dock change and returns every frame it resized plus every painted
 *  frame from before it until the dock rests. */
async function framesOf(page, change, key) {
  await settle(page);
  const before = await geometry(page, key);
  await page.evaluate((key) => {
    window.watchGeometry(key);
    window.armPainted(key);
  }, key);
  await change();
  const painted = await page.evaluate(() => window.paintedUntilSettled());
  const resized = await page.evaluate(() => window.stopWatch());
  return { before, after: painted.at(-1), frames: [...resized, ...painted], painted };
}

/** How the dock moved between its two resting heights: an island change
 *  paints no height in between, and the grace keeps the old height for
 *  ISLAND_COLLAPSE_GRACE_MS first. */
function assertDockMotion(label, kind, { before, after, painted }) {
  if (!kind || kind === ISLAND_OVERLAY) return;
  const between = painted.filter(
    (frame) => Math.abs(frame.dockHeight - before.dockHeight) >= 1 && Math.abs(frame.dockHeight - after.dockHeight) >= 1
  );
  assert.equal(between.length, 0, `${label}: the slot moves the dock in one step`);
  if (kind !== ISLAND_GRACE) return;
  const moved = painted.find((frame) => Math.abs(frame.dockHeight - before.dockHeight) >= 1);
  assert.ok(
    moved.now - before.now >= ISLAND_COLLAPSE_GRACE_MS - 50,
    `${label}: the emptied slot holds through the grace (${Math.round(moved.now - before.now)}ms)`
  );
}

/** A dock change resizes the dock, except an overlay panel, which keeps the
 *  dock and the transcript viewport at their height on every frame. */
function assertDockHeight(label, kind, before, after, frames) {
  if (kind !== ISLAND_OVERLAY) {
    assert.ok(Math.abs(after.dockHeight - before.dockHeight) >= 1, `${label}: the dock changed height`);
    return;
  }
  for (const frame of [after, ...frames]) {
    assert.ok(Math.abs(frame.dockHeight - before.dockHeight) < 0.5, `${label}: the overlay keeps the dock height`);
    assert.ok(
      Math.abs(frame.viewportHeight - before.viewportHeight) < 0.5,
      `${label}: the overlay keeps the transcript viewport height`
    );
  }
}

/** While following: the viewport keeps its height under the dock, what shows
 *  of it ends where the dock starts, and the tail sits
 *  TRANSCRIPT_BOTTOM_SPACER (24px) above the dock on every resized and painted
 *  frame, through the slot's whole easing. */
async function assertFollowedChange(page, label, change, kind) {
  const result = await framesOf(page, change);
  const { before, after, frames } = result;
  assertDockHeight(label, kind, before, after, frames);
  assertDockMotion(label, kind, result);
  for (const frame of frames) {
    assert.equal(frame.following, true, `${label}: still following`);
    assert.ok(
      Math.abs(frame.shownBottom - frame.dockTop) < 0.5,
      `${label}: what shows of the viewport ends where the dock starts`
    );
    assert.ok(
      Math.abs(frame.viewportHeight - before.viewportHeight) < 0.5,
      `${label}: the dock never resizes the viewport`
    );
    assert.ok(
      Math.abs(frame.gap - 24) < 0.5,
      `${label}: the tail sits 24px above the dock (was ${frame.gap?.toFixed(2)})`
    );
  }
  return after;
}

/** While reading: the dock moves over the viewport, and the message the
 *  reader looks at keeps its screen position on every frame. */
async function assertReadChange(page, label, change, key, kind) {
  const result = await framesOf(page, change, key);
  const { before, after, frames } = result;
  assertDockHeight(label, kind, before, after, frames);
  assertDockMotion(label, kind, result);
  for (const frame of frames) {
    assert.equal(frame.following, false, `${label}: the reader stays detached`);
    assert.ok(
      Math.abs(frame.shownBottom - frame.dockTop) < 0.5,
      `${label}: what shows of the viewport ends where the dock starts`
    );
    assert.ok(Math.abs(frame.viewportHeight - before.viewportHeight) < 0.5, `${label}: the viewport keeps its height`);
    assert.ok(Math.abs(frame.rowTop - before.rowTop) <= 1, `${label}: the read message stays at its screen position`);
  }
  return after;
}

/** A pointer pressed and held still on the transcript's own chrome (the
 *  scrollbar), dispatched through the viewport's real pointer handlers. */
async function holdChromePointer(page, down) {
  await page.evaluate((down) => {
    const viewport = document.querySelector('.transcript');
    const box = viewport.getBoundingClientRect();
    viewport.dispatchEvent(
      new PointerEvent(down ? 'pointerdown' : 'pointerup', {
        bubbles: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: down ? 1 : 0,
        clientX: box.right - 4,
        clientY: box.top + 40,
      })
    );
  }, down);
}

async function pause(page, ms) {
  await page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), ms);
}

async function checkScrollFade(page) {
  const fade = await page.evaluate(() => {
    const shell = document.querySelector('.transcript-shell');
    const viewport = document.querySelector('.transcript');
    const dock = document.querySelector('.composer-region').getBoundingClientRect();
    const style = getComputedStyle(shell, '::after');
    const ramp = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--transcript-fade'));
    return {
      top: shell.getBoundingClientRect().bottom - Number.parseFloat(style.bottom) - Number.parseFloat(style.height),
      dockTop: dock.top,
      ramp,
      mask: getComputedStyle(viewport).maskImage,
      gradient: style.backgroundImage,
      pointerEvents: style.pointerEvents,
      belowJump: Number(style.zIndex) < Number(getComputedStyle(document.querySelector('.jump-to-latest')).zIndex),
    };
  });
  assert.equal(fade.mask, 'none', 'the scrolling content needs no per-frame viewport mask');
  assert.equal(fade.ramp, 24, 'retain the bottom fade distance');
  assert.ok(Math.abs(fade.top + fade.ramp - fade.dockTop) <= 1, 'the fade ends at the measured dock top');
  assert.equal(fade.pointerEvents, 'none', 'the fade cannot intercept scrolling or selection');
  assert.equal(fade.belowJump, true, 'jump-to-latest is not washed out');
  assert.match(fade.gradient, /linear-gradient/);
  return fade;
}

async function openDockPage(t) {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'transcript-dock-layout.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
      plugins: [
        {
          name: 'unopened-lazy-surfaces',
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) =>
              args.kind === 'dynamic-import' && args.path !== './TurnReview'
                ? { path: args.path, external: true }
                : null
            );
          },
        },
      ],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'transcript-dock-layout.css',
      bundle: true,
      write: false,
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css'))) {
    await page.addStyleTag({ content: file.text });
  }
  await page.addStyleTag({
    content: `
    #root { position: fixed; inset: 0; display: flex; container-type: size; }
    article { padding: 12px 20px; } article h3, article p, article pre { margin: 8px 0; }
    article table { border-spacing: 0; } article td { padding: 4px; }
    .composer textarea { field-sizing: content; min-height: 60px; max-height: none; line-height: 20px; }
  `,
  });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.addScriptTag({ content: PAGE_PROBES });
  return { page, errors };
}

test('dock changes and delayed rich rows preserve real browser geometry', async (t) => {
  const { page, errors } = await openDockPage(t);

  // 640 sat between these two on the same side of the phone breakpoint
  // (data-mixdog-mobile-tabs below 500), so it only repeated the desktop run.
  // The pointer-hold and reduced-motion passes are viewport-independent logic
  // (gesture window, motion preference), so they run once, on the desktop size.
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    const desktop = width >= 500;
    await page.setViewport({ width, height });
    await page.evaluate(
      ({ width, height }) => {
        document.documentElement.toggleAttribute('data-mixdog-mobile-tabs', width < 500);
        window.mountFixture(`dock-${width}-${height}`);
      },
      { width, height }
    );
    // Read where the timeline pins (the sampler's delivery) once the mount
    // rests: a read from a task can force a layout the pin has not seen yet.
    let before = await page.evaluate(async () => {
      window.armPainted();
      return (await window.paintedUntilSettled()).at(-1);
    });
    assert.ok(
      Math.abs(before.viewportHeight - height) < 0.5,
      'the viewport runs the pane’s whole height, under the dock'
    );
    assert.ok(Math.abs(before.viewportBottom - before.paneBottom) < 0.5, 'and ends with the pane');
    assert.ok(Math.abs(before.shownBottom - before.dockTop) < 0.5, 'what shows of it ends where the dock starts');
    assert.equal(before.slotHeight, 0, 'an empty island slot takes no room');
    assert.ok(Math.abs(before.gap - 24) < 0.5, `the tail sits 24px above the dock (was ${before.gap?.toFixed(2)})`);
    const emptyDock = before.dockHeight;
    const restingFade = await checkScrollFade(page);

    // Following: every dock member growing and shrinking moves the dock over
    // the viewport and keeps the tail exactly 24px above it on every frame.
    for (const [label, change, kind] of dockChanges(page)) await assertFollowedChange(page, label, change, kind);
    assert.equal((await geometry(page)).dockHeight, emptyDock, 'the last item leaving leaves no island footprint');
    assert.equal((await geometry(page)).slotHeight, 0, 'nothing holds the emptied slot open');

    await page.evaluate(() => window.fixture.read());
    await settle(page);
    assert.equal((await checkScrollFade(page)).top, restingFade.top, 'the fade stays stationary while content scrolls');
    // Mica makes workspace-sheet transparent inside panes. The painted sheet
    // remains opaque in both themes; the bottom fade must use its colour.
    for (const surface of ['rgb(17, 17, 19)', 'rgb(252, 252, 252)']) {
      await page.evaluate((surface) => {
        const conversation = document.querySelector('.conversation');
        conversation.style.setProperty('--mx-workspace-sheet', 'transparent');
        conversation.style.setProperty('--mx-sheet-surface', surface);
      }, surface);
      assert.ok(
        (await checkScrollFade(page)).gradient.includes(surface),
        'fade matches the painted sheet, not clear Mica'
      );
    }
    await page.evaluate(() => {
      const conversation = document.querySelector('.conversation');
      conversation.style.removeProperty('--mx-workspace-sheet');
      conversation.style.removeProperty('--mx-sheet-surface');
    });
    before = await geometry(page);
    assert.ok(before.key, 'a real reading anchor is visible');
    // Reading: the same changes keep the read message where it is. The anchor
    // is pinned by scroll arithmetic that does not depend on the phone layout,
    // so the full sweep runs on the desktop size only.
    if (desktop) {
      for (const [label, change, kind] of dockChanges(page)) {
        await assertReadChange(page, label, change, before.key, kind);
      }
    } else {
      await assertReadChange(page, 'approval card opens', approvalChange(page, true), before.key, ISLAND_MOTION);
      await assertReadChange(page, 'approval card closes', approvalChange(page, false), before.key, ISLAND_MOTION);
    }
    await checkScrollFade(page);

    const stable = async () => {
      for (let frame = 0; frame < 4; frame++) {
        await settle(page);
        const after = await geometry(page, before.key);
        assert.ok(Math.abs(after.rowTop - before.rowTop) <= 1, 'the same message stays at the same screen position');
      }
    };
    await page.evaluate((key) => window.fixture.suspend(key), before.key);
    await page.waitForSelector('[data-transcript-pending]');
    await stable();
    const pendingBox = await geometry(page, before.key);
    assert.ok(Math.abs(pendingBox.rowHeight - before.rowHeight) <= 1, 'a pending rich row retains its measured box');
    await page.evaluate((key) => window.fixture.resolve(key), before.key);
    await page.waitForFunction(() => !document.querySelector('[data-transcript-pending]'));
    await stable();

    await page.evaluate(() => window.fixture.follow());
    await settle(page);
    const tail = await geometry(page);
    assert.ok(Math.abs(tail.gap - 24) < 0.5, 'following returns 24px above the dock');
    assert.ok(tail.jumpBottom <= tail.dockTop, 'the jump control stays inside the transcript');

    // A fresh fixture following the tail: the first content opens the slot in
    // one step and the tail lands above the grown dock on the resize frame.
    await page.evaluate((session) => window.mountFixture(session), `fresh-${width}-${height}`);
    await settle(page);
    assert.ok(Math.abs((await geometry(page)).gap - 24) < 0.5, 'fresh fixture follows the tail');
    await assertFollowedChange(
      page,
      'first opening',
      async () => {
        await page.evaluate(() => window.fixture.change({ goal: true }));
        await page.waitForSelector('.session-goal-island');
      },
      ISLAND_MOTION
    );

    // A pointer held still on the scrollbar while the approval closes: the
    // viewport grows and Chromium clamps the offset to the new end before the
    // (gesture-deferred) end pin runs. That clamp is not the reader leaving.
    const approval = (open) => approvalChange(page, open);
    await assertFollowedChange(page, 'approval opens', approval(true));
    if (!desktop) await assertFollowedChange(page, 'approval closes', approval(false));
    if (desktop) {
      // Past PROGRAMMATIC_WINDOW_MS: the clamped end must not pass merely by
      // matching an end offset the timeline wrote moments ago.
      await pause(page, 1_600);
      await holdChromePointer(page, true);
      await assertFollowedChange(page, 'approval closes under a held pointer', approval(false));
      await pause(page, 300);
      await assertFollowedChange(page, 'approval reopens under a held pointer', approval(true));
      await holdChromePointer(page, false);
      await assertFollowedChange(page, 'approval closes after release', approval(false));

      // Reduced motion: the same island changes land in one step, the tail
      // still 24px above the dock on every frame.
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.evaluate((session) => window.mountFixture(session), `reduced-${width}-${height}`);
      await settle(page);
      for (const [label, change, kind] of dockChanges(page).filter(([, , kind]) => kind)) {
        await assertFollowedChange(page, `reduced motion: ${label}`, change, kind);
      }
      assert.equal((await geometry(page)).slotHeight, 0, 'reduced motion: the emptied slot closes');
      await page.emulateMediaFeatures([]);
    }
  }
  assert.deepEqual(errors, []);
});

test('in a short pane the island scrolls inside and the composer never leaves the pane', async (t) => {
  const { page, errors } = await openDockPage(t);
  for (const width of [1280, 390]) {
    await page.setViewport({ width, height: 360 });
    await page.evaluate((width) => {
      document.documentElement.toggleAttribute('data-mixdog-mobile-tabs', width < 500);
      window.mountFixture(`short-${width}`);
    }, width);
    await settle(page);
    await page.evaluate(() => {
      window.armPainted();
      window.fixture.change({ approval: 640 });
      window.fixture.type(Array.from({ length: 10 }, (_, line) => `line ${line + 1}`).join('\n'));
    });
    // Every frame of the island's opening keeps the composer inside the pane.
    for (const frame of await page.evaluate(() => window.paintedUntilSettled())) {
      assert.ok(
        frame.composerBottom <= frame.paneBottom + 0.5,
        `short ${width}px pane: the composer stays inside while the island eases`
      );
    }
    const box = await page.evaluate(() => {
      const pane = document.querySelector('.conversation').getBoundingClientRect();
      const dock = document.querySelector('.composer-region').getBoundingClientRect();
      const composer = document.querySelector('.composer').getBoundingClientRect();
      const island = document.querySelector('.composer-island');
      return {
        paneTop: pane.top,
        paneBottom: pane.bottom,
        dockBottom: dock.bottom,
        composerTop: composer.top,
        composerBottom: composer.bottom,
        islandTop: island.getBoundingClientRect().top,
        islandOverflow: island.scrollHeight - island.clientHeight,
      };
    });
    const label = `short ${width}px pane`;
    assert.ok(box.composerBottom <= box.paneBottom + 0.5, `${label}: the composer bottom stays inside the pane`);
    assert.ok(box.composerTop >= box.paneTop - 0.5, `${label}: the composer top stays inside the pane`);
    assert.ok(box.dockBottom <= box.paneBottom + 0.5, `${label}: the dock keeps its floor inside the pane`);
    assert.ok(box.islandTop >= box.paneTop - 0.5, `${label}: the island stays inside the pane`);
    assert.ok(box.islandOverflow > 0, `${label}: the approval scrolls inside the island`);
  }
  assert.deepEqual(errors, []);
});

test("a place handed to the list before the dock's observer reports the dock's new height: the reader is put there against the end the dock leaves", async (t) => {
  const { page, errors } = await openDockPage(t);
  await page.setViewport({ width: 1280, height: 800 });
  const geometry = () => {
    const view = document.querySelector('.transcript');
    const pad = Number.parseFloat(getComputedStyle(view.querySelector('.thread')).paddingTop) || 0;
    const box = view.getBoundingClientRect();
    return {
      top: view.scrollTop,
      max: view.scrollHeight - view.clientHeight,
      inset: Number.parseFloat(view.style.getPropertyValue('--transcript-dock-inset')) || 0,
      rows: [...view.querySelectorAll('.transcript-virtual-row')].map((row) => ({
        index: Number(row.dataset.index),
        start: row.getBoundingClientRect().top - box.top + view.scrollTop - pad,
      })),
    };
  };
  await page.evaluate(() => window.mountFixture('placed', 'pane-1'));
  await settle(page);
  // The reader reads above the end.
  await page.evaluate(() => window.fixture.read());
  await settle(page);
  const before = await page.evaluate(geometry);
  assert.ok(before.inset > 0, 'the dock covers the bottom of the viewport');
  // The composer grows by several lines, and in the same task the reader is handed a place below the end the list had:
  // the list puts the reader there before any observer has reported the dock's new height.
  const target = before.max + 60;
  const row = before.rows.find((entry) => entry.start >= target);
  const place = { position: `p-${row.index}`, key: `message-${row.index}`, top: row.start - target };
  await page.evaluate((handed) => {
    window.fixture.type(Array.from({ length: 10 }, (_, line) => `line ${line + 1}`).join('\n'));
    window.openPlace('placed', handed);
  }, place);
  await settle(page);
  await settle(page);
  const shown = await page.evaluate(geometry);
  t.diagnostic(`place: ${JSON.stringify({ target, place, top: shown.top, max: shown.max, inset: shown.inset })}`);
  assert.ok(shown.inset > before.inset + 60, 'the dock covers more of the viewport');
  assert.equal(shown.max, before.max + shown.inset - before.inset, "the end carries the dock's new inset");
  assert.ok(Math.abs(shown.top - target) <= 1, `the reader is put at ${target}, not ${shown.top}`);
  assert.equal(await page.evaluate(() => window.fixture.following()), false);
  assert.deepEqual(errors, []);
});
