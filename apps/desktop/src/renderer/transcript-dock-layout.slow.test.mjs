import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const HARNESS = `
  import { Suspense, useContext, useLayoutEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { createPortal, flushSync } from 'react-dom';
  import { BtwCard } from './BtwCard';
  import { ComposerDock } from './ComposerDock';
  import { ComposerQueueTrayContext } from './composer-island-state';
  import { QueueList } from './composer-support';
  import { SessionGoalIsland } from './SessionGoalIsland';
  import { TranscriptList } from './TranscriptList';
  import { useTranscriptFollow } from './use-transcript-follow';

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
  const rows = Array.from({ length: 40 }, (_, index) => ({
    key: 'message-' + index, _tag: 'AssistantPart',
  }));
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
  const queued = [
    { id: 'q1', displayText: 'Queued follow-up' },
    { id: 'q2', displayText: 'Another queued follow-up' },
  ];
  // Composer portals its queued follow-ups into the dock's tray.
  function Queue({ shown }) {
    const tray = useContext(ComposerQueueTrayContext);
    if (!tray || !shown) return null;
    return createPortal(
      <QueueList queued={queued} restoring={false} onEdit={() => {}} onSteer={() => {}} onRemove={() => {}} />,
      tray
    );
  }
  function Harness({ session }) {
    const [state, setState] = useState({
      goal: false, approval: false, quota: false, btw: false, queue: false, revision: 0,
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
        <Queue shown={state.queue} />
        {state.btw && <BtwCard card={btwCard} onClose={() => {}} onRetry={() => {}} />}
        <form className="composer">
          <textarea aria-label="Composer" defaultValue="Fixture input" />
        </form>
      </ComposerDock>
    </section>;
  }
  window.mountFixture = (session) => {
    pending.clear();
    flushSync(() => root.render(<Harness key={session} session={session} />));
  };
`;

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// In-page probes: one geometry read, a watcher that reads it inside every
// resize delivery (after the timeline's own observer and its pin microtask,
// so exactly what that frame paints) and a sampler of the next painted frames.
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
  window.paintedFrames = (count, key) => new Promise((resolve) => {
    const frames = [];
    const next = () => requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        frames.push(window.geometry(key));
        if (frames.length < count) next();
        else resolve(frames);
      };
      channel.port2.postMessage(0);
    });
    next();
  });
  // Every painted frame until the dock rests: no slot motion or grace hold
  // and six frames at one dock height (bounded).
  window.paintedUntilSettled = (key) => new Promise((resolve) => {
    const frames = [];
    const settled = () => {
      const last = frames.slice(-6);
      return last.length === 6 && !last[5].motion && last[5].presence !== 'grace' &&
        last.every((frame) => frame.dockHeight === last[5].dockHeight);
    };
    const next = () => requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        frames.push(window.geometry(key));
        if (settled() || frames.length >= 240) resolve(frames);
        else next();
      };
      channel.port2.postMessage(0);
    });
    next();
  });
`;

async function geometry(page, key) {
  return page.evaluate((key) => window.geometry(key), key);
}

/** Every bottom-chrome member growing, then shrinking back to an empty dock.
 *  Island changes ease the slot's height (ISLAND_MOTION), the last content
 *  leaving first holds it for the grace (ISLAND_GRACE). */
const ISLAND_MOTION = 'island-motion';
const ISLAND_GRACE = 'island-grace';
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
      ISLAND_MOTION,
    ],
    [
      'Goal panel collapses',
      async () => {
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.session-goal-island[data-open="true"]'));
      },
      ISLAND_MOTION,
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
    ['queue tray opens', change({ queue: true })],
    ['queue tray closes', change({ queue: false })],
    ['textarea grows', () => page.evaluate(() => window.fixture.type('one\ntwo\nthree\nfour\nfive\nsix'))],
    ['textarea clears', () => page.evaluate(() => window.fixture.type(''))],
  ];
}

/** Runs one dock change and returns every frame it resized plus every painted
 *  frame until the dock rests. */
async function framesOf(page, change, key) {
  await settle(page);
  const before = await geometry(page, key);
  await page.evaluate((key) => window.watchGeometry(key), key);
  await change();
  const painted = await page.evaluate((key) => window.paintedUntilSettled(key), key);
  const resized = await page.evaluate(() => window.stopWatch());
  return { before, after: painted.at(-1), frames: [...resized, ...painted], painted };
}

/** How the dock moved between its two resting heights: an eased island
 *  change paints heights in between, an instant one (reduced motion) none, and
 *  the grace keeps the old height for ISLAND_COLLAPSE_GRACE_MS first. */
function assertDockMotion(label, kind, instant, { before, after, painted }) {
  if (!kind) return;
  const between = painted.filter(
    (frame) => Math.abs(frame.dockHeight - before.dockHeight) >= 1 && Math.abs(frame.dockHeight - after.dockHeight) >= 1
  );
  if (instant) assert.equal(between.length, 0, `${label}: reduced motion moves the dock in one step`);
  else assert.ok(between.length >= 3, `${label}: the slot eases over several painted frames (${between.length})`);
  if (kind !== ISLAND_GRACE) return;
  const moved = painted.find((frame) => Math.abs(frame.dockHeight - before.dockHeight) >= 1);
  assert.ok(
    moved.now - before.now >= ISLAND_COLLAPSE_GRACE_MS - 50,
    `${label}: the emptied slot holds through the grace (${Math.round(moved.now - before.now)}ms)`
  );
}

/** While following: the viewport ends at the dock, gives up exactly what the
 *  dock takes, and the tail sits TRANSCRIPT_BOTTOM_SPACER (24px) above it on
 *  every resized and painted frame, through the slot's whole easing. */
async function assertFollowedChange(page, label, change, kind, instant = false) {
  const result = await framesOf(page, change);
  const { before, after, frames } = result;
  assert.ok(Math.abs(after.dockHeight - before.dockHeight) >= 1, `${label}: the dock changed height`);
  assertDockMotion(label, kind, instant, result);
  for (const frame of frames) {
    assert.equal(frame.following, true, `${label}: still following`);
    assert.ok(
      Math.abs(frame.viewportBottom - frame.dockTop) < 0.5,
      `${label}: the viewport ends where the dock starts`
    );
    assert.ok(
      Math.abs(frame.viewportHeight + frame.dockHeight - (before.viewportHeight + before.dockHeight)) < 0.5,
      `${label}: the viewport changes with the dock`
    );
    assert.ok(
      Math.abs(frame.gap - 24) < 0.5,
      `${label}: the tail sits 24px above the dock (was ${frame.gap?.toFixed(2)})`
    );
  }
  return after;
}

/** While reading: the dock still resizes the viewport, but the message the
 *  reader looks at keeps its screen position on every frame. */
async function assertReadChange(page, label, change, key, kind) {
  const result = await framesOf(page, change, key);
  const { before, after, frames } = result;
  assert.ok(Math.abs(after.dockHeight - before.dockHeight) >= 1, `${label}: the dock changed height`);
  assertDockMotion(label, kind, false, result);
  for (const frame of frames) {
    assert.equal(frame.following, false, `${label}: the reader stays detached`);
    assert.ok(
      Math.abs(frame.viewportBottom - frame.dockTop) < 0.5,
      `${label}: the viewport ends where the dock starts`
    );
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

test('dock changes and delayed rich rows preserve real browser geometry', async (t) => {
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
            // Exercise the actual review chunk, but retain Vite's lazy boundary
            // for unopened editors/dialogs. Unexpected use remains a page error.
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
        contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
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

  for (const [width, height] of [
    [1280, 800],
    [640, 500],
    [390, 844],
  ]) {
    await page.setViewport({ width, height });
    await page.evaluate(
      ({ width, height }) => {
        document.documentElement.toggleAttribute('data-mixdog-mobile-tabs', width < 500);
        window.mountFixture(`dock-${width}-${height}`);
      },
      { width, height }
    );
    await settle(page);
    let before = await geometry(page);
    assert.ok(Math.abs(before.viewportHeight + before.dockHeight - height) < 0.5, 'the dock sits below the viewport');
    assert.ok(Math.abs(before.viewportBottom - before.dockTop) < 0.5, 'the viewport ends where the dock starts');
    assert.equal(before.slotHeight, 0, 'an empty island slot takes no room');
    assert.ok(Math.abs(before.gap - 24) < 0.5, 'the tail sits 24px above the dock');
    const emptyDock = before.dockHeight;
    const restingFade = await checkScrollFade(page);

    // Following: every dock member growing and shrinking resizes the viewport
    // and keeps the tail exactly 24px above the dock on every frame.
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
    // Reading: the same changes keep the read message where it is.
    for (const [label, change, kind] of dockChanges(page)) {
      await assertReadChange(page, label, change, before.key, kind);
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
    const approval = (open) => () => page.evaluate((open) => window.fixture.change({ approval: open }), open);
    await assertFollowedChange(page, 'approval opens', approval(true));
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
      await assertFollowedChange(page, `reduced motion: ${label}`, change, kind, true);
    }
    assert.equal((await geometry(page)).slotHeight, 0, 'reduced motion: the emptied slot closes');
    await page.emulateMediaFeatures([]);
  }

  // A short pane where a large approval and a ten-line draft together need
  // more than the pane: the island gives up the room and scrolls inside, and
  // the composer never leaves the pane.
  for (const width of [1280, 390]) {
    await page.setViewport({ width, height: 360 });
    await page.evaluate((width) => {
      document.documentElement.toggleAttribute('data-mixdog-mobile-tabs', width < 500);
      window.mountFixture(`short-${width}`);
    }, width);
    await settle(page);
    await page.evaluate(() => {
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
