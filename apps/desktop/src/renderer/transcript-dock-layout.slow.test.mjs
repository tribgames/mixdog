import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const HARNESS = `
  import { Suspense, useLayoutEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { ComposerDock } from './ComposerDock';
  import { SessionGoalIsland } from './SessionGoalIsland';
  import { TranscriptList } from './TranscriptList';
  import { useComposerDockHeight } from './use-composer-dock-height';
  import { useTranscriptFollow } from './use-transcript-follow';

  const root = createRoot(document.getElementById('root'));
  const pending = new Map();
  let currentReview = false;
  const files = Array.from({ length: 6 }, (_, index) => ({
    path: 'file-' + index + '.ts', status: 'M', additions: 3, deletions: 1,
  }));
  window.mixdogDesktop = {
    invokeCapability: async () => ({ value: {
      supported: true, authoritative: true, snapshotKind: 'worktree',
      checkpointId: 'prompt', patch: '', files: currentReview ? files : [], agents: [],
    } }),
  };
  const items = [
    { kind: 'user', id: 'prompt', text: 'Change files' },
    { kind: 'tool', id: 'edit', name: 'apply_patch', args: {}, result: 'Updated file-0.ts' },
  ];
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
  function Harness({ session }) {
    const [state, setState] = useState({ goal: false, review: false, composer: 84, revision: 0 });
    currentReview = state.review;
    const viewport = useRef(null), content = useRef(null), dock = useRef(null);
    const scrollToEndRef = useRef(() => {}), setAnchorBottomRef = useRef(() => {});
    const height = useComposerDockHeight(dock);
    const follow = useTranscriptFollow({
      viewport, content, sessionKey: session, scrollToEndRef, setAnchorBottomRef,
    });
    useLayoutEffect(() => {
      window.fixture = {
        change: (patch) => flushSync(() => setState(previous => ({ ...previous, ...patch }))),
        read: () => {
          flushSync(() => follow.pause());
          viewport.current.scrollTop = Math.max(0, viewport.current.scrollHeight - viewport.current.clientHeight - 600);
        },
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
    return <section className="conversation" style={{ '--composer-dock-height': height + 'px' }}>
      <div className="transcript-shell">
        <div className="transcript" ref={viewport} onScroll={follow.handleScroll} onWheel={follow.handleWheel}>
          <div className="thread">
            <TranscriptList sessionKey={session} rows={rows} viewport={viewport} content={content}
              bottomInset={height} shouldAnchorBottom={follow.following}
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
      <ComposerDock dockRef={dock} sessionId="" goalSubmissionId="" showProjectSelector={false}
        goalIsland={state.goal ? <SessionGoalIsland snapshot={{
          sessionId: session, goal: {
            id: 'goal', title: 'Keep the reading position', objective: 'Stable layout', status: 'paused',
            tasks: [{ id: 'task', title: 'Check layout', status: 'pending' }],
          },
        }} /> : null}
        reviewItems={state.review ? items : empty} reviewActive reviewBusy={false}
        reviewSessionId={session} reviewCwd="C:/fixture">
        <form className="composer" style={{ height: state.composer }}>
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

async function geometry(page, key) {
  return page.evaluate((key) => {
    const viewport = document.querySelector('.transcript');
    const dock = document.querySelector('.composer-region');
    const view = viewport.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const visible = [...document.querySelectorAll('.transcript-virtual-row')].find((row) => {
      const box = row.getBoundingClientRect();
      return box.top >= view.top && box.bottom < dockBox.top;
    });
    const row = key ? document.querySelector(`[data-timeline-key="${key}"]`) : visible;
    const last = document.querySelector('[data-timeline-key="message-39"]');
    return {
      viewportHeight: view.height,
      top: viewport.scrollTop,
      key: row?.dataset.timelineKey,
      rowTop: row?.getBoundingClientRect().top,
      rowHeight: row?.getBoundingClientRect().height,
      dockHeight: dockBox.height,
      dockTop: dockBox.top,
      lastBottom: last?.getBoundingClientRect().bottom,
      jumpBottom: document.querySelector('.jump-to-latest').getBoundingClientRect().bottom,
      bottomInset: Number.parseFloat(getComputedStyle(viewport).scrollPaddingBottom),
    };
  }, key);
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
    .composer textarea { height: 100%; }
  `,
  });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });

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
    assert.equal(before.viewportHeight, height, 'the dock never reduces the scroll viewport');
    assert.equal(before.bottomInset, before.dockHeight, 'native scroll clearance is measured');
    assert.ok(Math.abs(before.lastBottom - (before.dockTop - 24)) <= 1, 'tail clears the composer');
    const restingFade = await checkScrollFade(page);

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
    const stable = async () => {
      for (let frame = 0; frame < 4; frame++) {
        await settle(page);
        const after = await geometry(page, before.key);
        assert.equal(after.viewportHeight, before.viewportHeight);
        assert.ok(Math.abs(after.rowTop - before.rowTop) <= 1, 'the same message stays at the same screen position');
      }
    };
    const empty = await geometry(page, before.key);
    await page.evaluate(() => window.fixture.change({ goal: true, review: true }));
    await page.waitForSelector('.turn-review-segment');
    // The slot opens in one step; measure the settled height.
    await stable();
    const collapsed = await geometry(page, before.key);
    await checkScrollFade(page);
    assert.equal(
      empty.dockHeight < collapsed.dockHeight,
      true,
      'an empty island reserves no space; content opens its slot'
    );
    await page.click('.session-goal-trigger');
    await stable();
    assert.equal((await geometry(page)).dockHeight, collapsed.dockHeight, 'the Goal tab overlays the reader');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.fixture.change({ composer: 156 }));
    await stable();
    await checkScrollFade(page);

    await page.evaluate((key) => window.fixture.suspend(key), before.key);
    await page.waitForSelector('[data-transcript-pending]');
    await stable();
    const pendingBox = await geometry(page, before.key);
    assert.ok(Math.abs(pendingBox.rowHeight - before.rowHeight) <= 1, 'a pending rich row retains its measured box');
    await page.evaluate((key) => window.fixture.resolve(key), before.key);
    await page.waitForFunction(() => !document.querySelector('[data-transcript-pending]'));
    await stable();

    await page.evaluate(() => window.fixture.change({ goal: false, review: false, composer: 84 }));
    await stable();
    // The slot opens in one step and stays open for the rest of the session
    // visit, so the last item leaving never moves the transcript …
    assert.equal((await geometry(page)).dockHeight, collapsed.dockHeight, 'the slot outlives its last item');
    // … and returning content reuses the open slot.
    await page.evaluate(() => window.fixture.change({ goal: true, review: true }));
    await page.waitForSelector('.turn-review-segment');
    await settle(page);
    assert.equal((await geometry(page)).dockHeight, collapsed.dockHeight, 'returning content keeps the slot open');
    await page.evaluate(() => window.fixture.change({ goal: false, review: false }));
    await stable();
    assert.equal((await geometry(page)).dockHeight, collapsed.dockHeight, 'the held slot never collapses');
    // Longer than the 1.5s grace period the slot used to collapse after.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await settle(page);
    assert.equal((await geometry(page)).dockHeight, collapsed.dockHeight, 'the slot is still held after the old grace');
    await page.evaluate(() => window.fixture.follow());
    await settle(page);
    const tail = await geometry(page);
    assert.ok(Math.abs(tail.lastBottom - (tail.dockTop - 24)) <= 1, 'following returns above the measured dock');
    assert.ok(tail.jumpBottom <= tail.dockTop, 'the jump control stays outside the composer');

    // Following the tail: the slot opening and closing must keep the last row
    // pinned above the dock on every frame, not only once settled.
    const pinned = async (label) => {
      for (let frame = 0; frame < 4; frame++) {
        await settle(page);
        const now = await geometry(page);
        assert.ok(Math.abs(now.lastBottom - (now.dockTop - 24)) <= 1, `${label}: the tail stays pinned`);
      }
    };
    // The held slot keeps the dock height, so the pinned tail does not move
    // while content comes and goes.
    await page.evaluate(() => window.fixture.change({ goal: true, review: true }));
    await page.waitForSelector('.turn-review-segment');
    await pinned('content returns');
    await page.evaluate(() => window.fixture.change({ goal: false, review: false }));
    await pinned('content leaves');

    // A fresh fixture follows the tail with a not-yet-held slot: the first
    // content opens the slot in one step and the tail must stay pinned above
    // the grown dock, on every painted frame and once settled.
    await page.evaluate((session) => window.mountFixture(session), `fresh-${width}-${height}`);
    await settle(page);
    const fresh = await geometry(page);
    assert.ok(Math.abs(fresh.lastBottom - (fresh.dockTop - 24)) <= 1, 'fresh fixture follows the tail');
    await page.evaluate(() => {
      const dock = document.querySelector('.composer-region');
      const misses = [];
      // Created after the dock hook's observer, so it is notified after that
      // observer's callback and the pin microtask it schedules.
      const observer = new ResizeObserver(() => {
        const last = document.querySelector('[data-timeline-key="message-39"]');
        misses.push(last.getBoundingClientRect().bottom - (dock.getBoundingClientRect().top - 24));
      });
      observer.observe(dock);
      window.openingPins = { misses, stop: () => observer.disconnect() };
    });
    await page.evaluate(() => window.fixture.change({ goal: true, review: true }));
    await page.waitForSelector('.turn-review-segment');
    await settle(page);
    const opening = await page.evaluate(() => {
      window.openingPins.stop();
      return window.openingPins.misses;
    });
    assert.ok(opening.length >= 1, 'the one-step opening resizes the dock while following');
    for (const miss of opening) {
      assert.ok(Math.abs(miss) <= 1.5, `first opening: the tail is pinned on the resize frame (missed by ${miss.toFixed(2)}px)`);
    }
    const opened = await geometry(page);
    assert.ok(opened.dockHeight > fresh.dockHeight, 'the first content opens the slot');
    assert.ok(Math.abs(opened.lastBottom - (opened.dockTop - 24)) <= 1, 'the tail clears the opened dock');
    await pinned('first opening');
  }
  assert.deepEqual(errors, []);
});
