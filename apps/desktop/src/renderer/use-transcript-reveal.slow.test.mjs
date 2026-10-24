import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The entry reveal against the real virtual list and its real measurements in
// a real browser: a revisit whose remembered geometry still holds paints its
// rows (at the end it was pinned to) in the first frame, and one whose inputs
// changed while away never paints a frame at a wrong offset.
const HARNESS = `
  import { useMemo, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { TranscriptList } from './TranscriptList';
  import { useTranscriptFollow } from './use-transcript-follow';
  import { useTranscriptReveal } from './use-transcript-reveal';
  import { readTranscriptVirtualSnapshot } from './transcript-virtual-cache';
  import { setFontSettings } from './appearance/font-settings';

  const WORDS = 'transcript rows wrap differently at every width so a stale measurement is visible';
  const make = (tag, from, count) => Array.from({ length: count }, (_, n) => {
    const key = tag + '-' + (from + n);
    const text = WORDS.repeat(1 + ((from + n) % 4));
    // Every third row is a tool roll-up (its rules: desktop/33-skin.css).
    return (from + n) % 3 === 2
      ? { key, _tag: 'ToolActivity', turnKey: key, items: [] }
      : { key, _tag: 'AssistantPart', turnKey: key, item: { id: key, text } };
  });
  const sessions = { A: make('A', 0, 40), B: make('B', 0, 40), C: make('C', 0, 40) };
  let setActive, setWidth, setHeight;
  function Pane() {
    const [active, activate] = useState('A');
    const [width, resize] = useState(620);
    setActive = (key) => flushSync(() => activate(key));
    const [height, resizeHeight] = useState(620);
    setWidth = (value) => flushSync(() => resize(value));
    setHeight = (value) => flushSync(() => resizeHeight(value));
    const viewport = useRef(null), content = useRef(null), scope = useRef(null);
    const scrollToEndRef = useRef(() => {}), setAnchorBottomRef = useRef(() => {});
    const follow = useTranscriptFollow({ viewport, content, sessionKey: active, scrollToEndRef, setAnchorBottomRef });
    const rows = sessions[active];
    const revealed = useTranscriptReveal({
      identity: active, enabled: true, draft: false, viewport, content, scope,
      hasScrollGesture: follow.hasScrollGesture,
      retainedGeometry: readTranscriptVirtualSnapshot(active)?.measurements,
      pinned: follow.following,
    });
    return <section ref={scope} className="conversation" style={{ width, height, margin: 20 }}>
      <div className="transcript-shell">
        <div className="transcript" ref={viewport} style={{ visibility: revealed ? 'visible' : 'hidden' }}
          onScroll={follow.handleScroll} onWheel={follow.handleWheel}>
          <div className="thread">
            <TranscriptList key={active} sessionKey={active} rows={rows}
              viewport={viewport} content={content} shouldAnchorBottom={follow.following}
              scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
              markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
              onSelectionAutoScroll={follow.handleSelectionAutoScroll}
              renderRow={(row) => row._tag === 'ToolActivity'
                ? <div className="tool-activity" data-surface="desktop" data-open={window.toolsOpen ? 'true' : 'false'}>
                    <span>{row.key} tool</span>
                    {window.toolsOpen ? <div style={{ height: 90 }}>tool output body</div> : null}
                  </div>
                : <div className="message assistant"><p style={{ margin: 0, padding: window.tallKey === row.key ? '6px 12px 46px' : '6px 12px', fontSize: 'calc(14px * var(--mx-code-scale, 1))', fontFamily: 'var(--mx-font-mono-user,) monospace' }}>{row.key + ' ' + row.item.text}</p></div>} />
          </div>
        </div>
      </div>
    </section>;
  }
  createRoot(document.getElementById('root')).render(<Pane />);
  window.fixture = {
    switchTo: (key) => setActive(key),
    resize: (value) => setWidth(value),
    // One row grows (its own markup); the rows around it are untouched.
    tall: (key) => {
      window.tallKey = key;
    },
    // Finds a pane height at which the row crossing the viewport's upper edge
    // shows less than the thread's top padding: such a row ends, in spacer
    // coordinates, above the scroll offset (the scroll offset counts the
    // padding, row offsets do not).
    findPartialTopRow: async () => {
      const inset = Number.parseFloat(getComputedStyle(document.querySelector('.thread')).paddingTop) || 0;
      for (let height = 420; height <= 600; height += 2) {
        setHeight(height);
        for (let frame = 0; frame < 4; frame++) await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const edge = document.querySelector('.transcript').getBoundingClientRect().top;
        const row = [...document.querySelectorAll('.transcript-virtual-row')].find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.top < edge && box.bottom > edge;
        });
        const shown = row ? row.getBoundingClientRect().bottom - edge : 0;
        if (row && shown >= 4 && shown <= inset - 2) return { key: row.dataset.timelineKey, height, inset, shown };
      }
      return { key: null, inset };
    },
    codeSize: (value) => setFontSettings({ codeSize: value }),
    monoFont: (value) => setFontSettings({ mono: value }),
    // A skin plates replies and tool rows (desktop/33-skin.css).
    skin: (on) => {
      if (on) document.documentElement.dataset.mixdogSkin = 'test';
      else delete document.documentElement.dataset.mixdogSkin;
    },
    // The effective tool-activity expansion decides which bodies mount.
    toolsOpen: (open) => { window.toolsOpen = open; },
    append: (key, count) => { sessions[key] = [...sessions[key], ...make(key, sessions[key].length, count)]; },
  };
  const snapshot = () => {
    const view = document.querySelector('.transcript');
    return {
      visible: getComputedStyle(view).visibility === 'visible',
      rows: view.querySelectorAll('.transcript-virtual-row').length,
      gap: view.scrollHeight - view.clientHeight - view.scrollTop,
      top: view.scrollTop,
    };
  };
  window.settle = async () => {
    for (let n = 0; n < 12; n++) await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  };
  // What each frame paints: sampled after its layout (a ResizeObserver created
  // last), with the action dispatched inside frame 1's animation callback.
  window.frames = (count, act) => new Promise((done) => {
    const out = [];
    const dummy = document.createElement('div');
    dummy.style.cssText = 'position:fixed;left:-20px;top:0;width:1px;height:1px';
    document.body.append(dummy);
    let frame = 0, armed = false;
    const observer = new ResizeObserver(() => { if (armed) out.push(snapshot()); });
    observer.observe(dummy);
    const tick = () => {
      frame++;
      if (frame === 1) { armed = true; act(); }
      dummy.style.width = (frame % 2) + 1 + 'px';
      if (frame < count) requestAnimationFrame(tick);
      else requestAnimationFrame(() => { observer.disconnect(); dummy.remove(); done(out); });
    };
    requestAnimationFrame(tick);
  });
`;

test('a revisit reveals in its first frame only while its remembered geometry still holds', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'use-transcript-reveal.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
      plugins: [
        {
          name: 'worker-stub',
          setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
              contents: 'export default class {};',
              loader: 'js',
            }));
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
      outfile: 'use-transcript-reveal.css',
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
  page.on('pageerror', (error) => errors.push(error.stack.split('\n').slice(0, 4).join(' <- ')));
  await page.setViewport({ width: 800, height: 700 });
  // A real origin: the font settings persist in localStorage, which the
  // opaque about:blank origin refuses.
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    })
  );
  await page.goto('http://mixdog.test/');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  const visit = (key) =>
    page.evaluate(async (to) => {
      const frames = await window.frames(10, () => window.fixture.switchTo(to));
      await window.settle();
      return frames;
    }, key);
  const away = (key, mutate) =>
    page.evaluate(
      async (to, name, argument) => {
        window.fixture.switchTo(to);
        await window.settle();
        if (name) window.fixture[name](...argument);
        await window.settle();
      },
      key,
      mutate?.[0],
      mutate?.slice(1)
    );
  const firstVisible = (frames) => frames.findIndex((frame) => frame.visible && frame.rows > 0);
  const settled = (frames) => frames.at(-1);
  // Collected, so a run with the direct check bypassed names every case it fails.
  const problems = [];
  const expect = (ok, message) => {
    if (!ok) problems.push(message);
  };
  const assertNoWrongFrame = (frames, label) => {
    const final = settled(frames);
    expect(Math.abs(final.gap) <= 1, `${label}: ends at the pinned end`);
    for (const [index, frame] of frames.entries()) {
      if (!frame.visible) continue;
      expect(Math.abs(frame.gap) <= 1, `${label}: frame ${index + 1} painted ${frame.gap}px off the end`);
      expect(Math.abs(frame.top - final.top) <= 1, `${label}: frame ${index + 1} scroll jumped to ${frame.top}`);
    }
  };

  await page.evaluate(() => window.settle());
  // First visits settle as they always did: A (mount), then B and C.
  // Its data is present and its rows exact in the click's commit: the final,
  // settled rows paint in frame 1 (no covered frames, no later correction).
  const firstB = await visit('B');
  expect(firstVisible(firstB) === 0, 'a first visit with its data present paints settled rows in frame 1');
  assertNoWrongFrame(firstB, 'first visit');
  // Fonts still loading is a genuine wait: the cover holds frame 1.
  await page.evaluate(() =>
    Object.defineProperty(document.fonts, 'status', { configurable: true, get: () => 'loading' })
  );
  const pendingFonts = await visit('C');
  expect(!pendingFonts[0].visible, 'a first visit with fonts pending stays covered in frame 1');
  await page.evaluate(() => delete document.fonts.status);

  // Unchanged revisit: rows at the end in frame 1, nothing moves afterwards.
  const unchanged = await visit('A');
  expect(firstVisible(unchanged) === 0, 'an unchanged revisit paints its rows in frame 1');
  assertNoWrongFrame(unchanged, 'unchanged revisit');
  await visit('B');
  const again = await visit('A');
  expect(firstVisible(again) === 0, 'and again');

  // Rows appended while away on a bottom-pinned session.
  await away('B', ['append', 'A', 3]);
  const appended = await visit('A');
  assertNoWrongFrame(appended, 'rows appended while away');
  expect(!appended[0].visible, 'rows appended while away: not revealed in frame 1');
  expect(firstVisible(appended) >= 0, 'it reveals');

  // The viewport width changed while away.
  await away('B', ['resize', 480]);
  const resized = await visit('A');
  expect(!resized[0].visible, 'width changed while away: not revealed in frame 1');
  assertNoWrongFrame(resized, 'width changed while away');
  await page.evaluate(() => window.fixture.resize(620));
  await page.evaluate(() => window.settle());

  // Font settings change row metrics with no width, zoom or font-load event.
  await visit('B');
  await away('B', ['codeSize', 18]);
  const bigger = await visit('A');
  expect(!bigger[0].visible, 'code size changed while away: not revealed in frame 1');
  assertNoWrongFrame(bigger, 'code size changed while away');
  await away('B', ['monoFont', 'Courier New']);
  const family = await visit('A');
  expect(!family[0].visible, 'code font family changed while away: not revealed in frame 1');
  assertNoWrongFrame(family, 'code font family changed while away');

  // Skin activation re-pads replies and tool rows through CSS alone.
  await away('B', ['skin', true]);
  const skinned = await visit('A');
  expect(!skinned[0].visible, 'skin activated while away: not revealed in frame 1');
  assertNoWrongFrame(skinned, 'skin activated while away');

  // Tool expansion mounts bodies the remembered rows did not have.
  await away('B', ['toolsOpen', true]);
  const expanded = await visit('A');
  expect(!expanded[0].visible, 'tool expansion changed while away: not revealed in frame 1');
  assertNoWrongFrame(expanded, 'tool expansion changed while away');

  // A changed row crossing the viewport's upper edge, below which every row is
  // unchanged. The edge row ends above the scroll offset in spacer coordinates
  // (the offset counts the thread's top padding), so the selection of visible
  // rows must convert before comparing.
  const edge = await page.evaluate(() => window.fixture.findPartialTopRow());
  assert.ok(edge.key, `a pane height shows a top row partly (padding ${edge.inset}px)`);
  await visit('B');
  await away('B', ['tall', edge.key]);
  const topChanged = await visit('A');
  expect(!topChanged[0].visible, 'a changed partly visible top row: not revealed in frame 1');
  assertNoWrongFrame(topChanged, 'a changed partly visible top row');

  // Unchanged again after all of that: the direct check still passes.
  await visit('B');
  const stable = await visit('A');
  expect(firstVisible(stable) === 0, 'an unchanged revisit still paints in frame 1');

  assert.deepEqual(problems, []);
  assert.deepEqual(errors, []);
});
