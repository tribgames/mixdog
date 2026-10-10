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
      <ComposerDock dockRef={dock} goalSubmissionId="" showProjectSelector={false}
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

    await page.evaluate(() => window.fixture.read());
    await settle(page);
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
    await page.evaluate(() => window.fixture.change({ goal: true, review: true, composer: 156 }));
    await page.waitForSelector('.turn-review-bar');
    await stable();
    const collapsed = await geometry(page, before.key);
    await page.click('.turn-review-summary');
    await stable();
    assert.equal((await geometry(page)).dockHeight, collapsed.dockHeight, 'review disclosure overlays the reader');
    const stack = await page.evaluate(() => ({
      goalBottom: document.querySelector('.session-goal-island').getBoundingClientRect().bottom,
      reviewTop: document.querySelector('.turn-review-bar').getBoundingClientRect().top,
    }));
    assert.ok(stack.goalBottom <= stack.reviewTop + 0.5, 'an open review lifts Goal above its file list');
    await page.click('.session-goal-trigger');
    await stable();
    assert.equal((await geometry(page)).dockHeight, collapsed.dockHeight, 'Goal disclosure overlays the reader');

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
    await page.evaluate(() => window.fixture.follow());
    await settle(page);
    const tail = await geometry(page);
    assert.ok(Math.abs(tail.lastBottom - (tail.dockTop - 24)) <= 1, 'following returns above the measured dock');
    assert.ok(tail.jumpBottom <= tail.dockTop, 'the jump control stays outside the composer');
  }
  assert.deepEqual(errors, []);
});
