import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const HARNESS = `
  import 'virtual:slow-markdown-worker';
  import { Suspense, useLayoutEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { TranscriptList } from './TranscriptList';
  import { useTranscriptFollow } from './use-transcript-follow';
  import StreamingMarkdownBody from './StreamingMarkdownBody';
  import { preloadSyncMarkdownParser } from './markdown-worker-client';

  const root = createRoot(document.getElementById('root'));
  const texts = new Map();
  let serial = 0;
  const block = (n) => [
    '## Section ' + n, '', 'Intro paragraph ' + n + ' with **bold** and a [link](https://example.com/' + n + '). ', '',
    '- first item', '- second item', '', '| a | b |', '| --- | --- |', '| ' + n + ' | two |', '',
    '\`\`\`ts', 'const value' + n + ' = ' + n + ';', '\`\`\`', '',
  ].join('\\n');
  function reply(units) {
    const tag = 'reply-' + serial++;
    let text = '# ' + tag + '\\n\\n';
    for (let n = 0; text.length < units; n++) text += block(n);
    const cut = text.slice(0, units);
    const at = cut.lastIndexOf('\\n## ');
    return { key: tag, text: at > 0 ? cut.slice(0, at + 1) : cut };
  }
  function Harness() {
    const [list, setList] = useState([]);
    const viewport = useRef(null), content = useRef(null);
    const scrollToEndRef = useRef(() => {}), setAnchorBottomRef = useRef(() => {});
    const follow = useTranscriptFollow({ viewport, content, sessionKey: 'fixture', scrollToEndRef, setAnchorBottomRef });
    useLayoutEffect(() => {
      window.fixture = {
        add: (sizes, at) => {
          const made = sizes.map((size) => reply(size));
          for (const item of made) texts.set(item.key, item.text);
          flushSync(() => setList((previous) => (at === 'start' ? [...made, ...previous] : [...previous, ...made])));
          return made.map((item) => item.key);
        },
        read: () => flushSync(() => follow.pause()),
        follow: () => follow.resume(),
        following: () => follow.followingRef.current,
      };
    });
    return <section className="conversation" style={{ width: 620, height: 620, margin: 20 }}>
      <div className="transcript-shell">
        <div className="transcript" ref={viewport} onScroll={follow.handleScroll} onWheel={follow.handleWheel}
          onPointerDown={follow.handlePointerDown} onPointerMove={follow.handlePointerMove}
          onPointerUp={follow.handlePointerUp} onPointerCancel={follow.handlePointerUp}>
          <div className="thread">
            <TranscriptList sessionKey="fixture" rows={list.map((item) => ({ key: item.key, _tag: 'AssistantPart', item: { id: item.key } }))}
              viewport={viewport} content={content} shouldAnchorBottom={follow.following}
              scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
              markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
              onSelectionAutoScroll={follow.handleSelectionAutoScroll}
              renderRow={(row) => <Suspense fallback={<span hidden data-transcript-pending />}>
                <div className="markdown"><StreamingMarkdownBody text={texts.get(row.key)} copyControl={() => null} /></div>
              </Suspense>} />
          </div>
        </div>
      </div>
    </section>;
  }
  window.ready = preloadSyncMarkdownParser().then(() => flushSync(() => root.render(<Harness />)));
  // Per painted frame: tail gap, scroll offset, the anchor row's top, and
  // whether source text (raw table pipes, plain fallback prose) is on screen.
  // Frames with the worker held, then released and settled.
  window.heldThenReleased = async (change, held, settled, anchorKey) => {
    window.releaseWorker();
    change();
    const pending = await window.sample(held, anchorKey);
    window.releaseWorker(true);
    const landed = await window.sample(settled, anchorKey);
    window.releaseWorker();
    return { pending, landed };
  };
  window.sample = async (frames, anchorKey) => {
    const out = [];
    for (let index = 0; index < frames; index++) {
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const view = document.querySelector('.transcript');
      const box = view.getBoundingClientRect();
      const anchor = anchorKey && document.querySelector('[data-timeline-key="' + anchorKey + '"]');
      out.push({
        gap: view.scrollHeight - view.clientHeight - view.scrollTop,
        top: view.scrollTop,
        anchor: anchor ? anchor.getBoundingClientRect().top - box.top : null,
        pending: document.querySelectorAll('[data-transcript-pending]').length,
        // Anywhere in the mounted rows: a clipped row still draws it once revealed.
        source: Boolean(view.querySelector('.markdown-plain, .markdown-code-fallback')) || view.textContent.includes('| '),
      });
    }
    return out;
  };
`;

// A worker that answers only when the test releases it: every frame sampled
// before that is a frame with the parses pending. Released \`open\`, it also
// answers what is posted later, as a real worker does: a row the list mounts
// once the landed parses move its range asks only then.
const SLOW_WORKER = `
  import { parseMarkdownToHast } from './markdown-ast';
  const held = [];
  let open = false;
  window.releaseWorker = (keepOpen = false) => {
    open = keepOpen;
    for (const release of held.splice(0)) release();
  };
  window.Worker = class {
    listeners = [];
    addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
    postMessage({ id, text }) {
      const answer = () => {
        const root = parseMarkdownToHast(text);
        for (const listener of this.listeners) listener({ data: { id, root } });
      };
      if (open) setTimeout(answer, 0);
      else held.push(answer);
    }
    terminate() {}
  };
`;
async function openHarness(t) {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'transcript-pending-markdown.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      // The worker host builds its URL from import.meta.url before constructing a Worker.
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
      plugins: [
        {
          name: 'worker-stub',
          setup(builder) {
            // A real worker answers a few frames later; the page has no module worker here.
            builder.onResolve({ filter: /^virtual:slow-markdown-worker$/ }, (args) => ({
              path: args.path,
              namespace: 'slow-worker',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'slow-worker' }, () => ({
              resolveDir,
              loader: 'ts',
              contents: SLOW_WORKER,
            }));
            builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
              contents: 'export default class {};',
              loader: 'js',
            }));
            builder.onResolve({ filter: /.*/ }, (args) =>
              args.kind === 'dynamic-import' &&
              !/markdown-ast|markdown-worker|MarkdownAstBody|markdown-/.test(args.path)
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
      outfile: 'transcript-pending-markdown.css',
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
  // A slow machine splits the parse landings across separate pin steps; a
  // fast one hid a tail stranded by the last of them.
  await page.emulateCPUThrottling(4);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack.split('\n').slice(0, 4).join(' <- ')));
  await page.setViewport({ width: 700, height: 700 });
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.evaluate(() => window.ready);
  const pendingGone = () =>
    page.waitForFunction(() => {
      window.releaseWorker();
      return !document.querySelector('[data-transcript-pending]');
    });
  await page.evaluate((sizes) => window.fixture.add(sizes), SIZES);
  await pendingGone();
  return { page, errors };
}

// Mixed sizes: the learned estimate never equals the final height.
const SIZES = [6000, 1500, 4500, 2500, 5500];

test('pending replies never paint raw markdown nor move the followed tail while parses land', async (t) => {
  const { page, errors } = await openHarness(t);
  const sizes = SIZES;
  await page.evaluate(() => window.fixture.follow());
  await page.evaluate(() => window.sample(6));
  const held = await page.evaluate((sizes) => window.heldThenReleased(() => window.fixture.add(sizes), 12, 80), sizes);
  assert.ok(
    held.pending.some((frame) => frame.pending > 0),
    'the replies are pending while the worker is held'
  );
  const burst = [...held.pending, ...held.landed];
  const pinned = burst.findIndex((frame) => frame.gap <= 1);
  assert.ok(pinned >= 0, 'the followed tail reaches the new replies');
  assert.equal(
    burst.some((frame) => frame.source),
    false,
    'no frame paints raw markdown while parses are pending'
  );
  assert.ok(
    burst.slice(pinned).every((frame) => Math.abs(frame.gap) <= 1),
    'the pinned tail never moves while parses land'
  );
  assert.equal(burst.at(-1).pending, 0, 'every parse landed');
  assert.deepEqual(errors, []);
});

test('replies prepended above a reader keep the reading anchor still and paint no raw markdown', async (t) => {
  const { page, errors } = await openHarness(t);
  const sizes = SIZES;
  await page.evaluate(() => window.fixture.read());
  const anchorKey = await page.evaluate(async () => {
    const view = document.querySelector('.transcript');
    view.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
    view.scrollTop -= 1200;
    await window.sample(8);
    const middle = view.getBoundingClientRect().top + view.clientHeight / 2;
    const row = [...document.querySelectorAll('.transcript-virtual-row')].find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return box.top <= middle && box.bottom >= middle && !candidate.querySelector('[data-transcript-pending]');
    });
    return row.dataset.timelineKey;
  });
  const readingRun = await page.evaluate(
    (sizes, key) => window.heldThenReleased(() => window.fixture.add(sizes, 'start'), 12, 80, key),
    sizes,
    anchorKey
  );
  const reading = [...readingRun.pending, ...readingRun.landed];
  const anchors = reading.map((frame) => frame.anchor).filter((top) => top !== null);
  assert.ok(anchors.length > 40, 'the reading anchor stayed mounted');
  assert.ok(Math.max(...anchors) - Math.min(...anchors) <= 1, 'the reading anchor does not move while parses land');
  assert.equal(
    reading.some((frame) => frame.source),
    false,
    'no raw markdown above or below the reader'
  );
  assert.deepEqual(errors, []);
});
