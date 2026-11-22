import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// A reply streamed in one pane and the same reply read from history in the
// other, each a row of a scroller as in the transcript.
const HARNESS = `
  import 'virtual:answering-worker';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { MarkdownResponse } from './MarkdownResponse';
  import { preloadSyncMarkdownParser } from './markdown-worker-client';

  const roots = {};
  window.show = (pane, text, streaming) => {
    roots[pane] ??= createRoot(document.getElementById(pane));
    flushSync(() => roots[pane].render(<MarkdownResponse text={text} streaming={streaming} />));
  };
  window.ready = preloadSyncMarkdownParser();
`;

// The parser worker answers on the next task.
const ANSWERING_WORKER = `
  import { parseMarkdownToHast } from './markdown-ast';
  window.Worker = class {
    listeners = [];
    addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
    postMessage({ id, text }) {
      setTimeout(() => {
        const root = parseMarkdownToHast(text);
        for (const listener of this.listeners) listener({ data: { id, root } });
      });
    }
    terminate() {}
  };
`;

const PAGE = ['live', 'history']
  .map(
    (id) =>
      `<div style="height:3000px;overflow-y:auto;width:600px"><div class="transcript-virtual-row"><div id="${id}"></div></div></div>`
  )
  .join('');

async function openPanes(t) {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
    outfile: 'markdown-response-finish.js',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'error',
    // The worker host builds its URL from import.meta.url before constructing a Worker.
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.png': 'dataurl',
      '.css': 'empty',
    },
    plugins: [
      {
        name: 'answering-worker',
        setup(builder) {
          builder.onResolve({ filter: /^virtual:answering-worker$/ }, (args) => ({
            path: args.path,
            namespace: 'answering-worker',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'answering-worker' }, () => ({
            resolveDir,
            loader: 'ts',
            contents: ANSWERING_WORKER,
          }));
          builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
            contents: 'export default class {};',
            loader: 'js',
          }));
          // The link component reaches the code editor, which only Vite can bundle.
          builder.onResolve({ filter: /monaco/ }, (args) => ({ path: args.path, namespace: 'without-editor' }));
          builder.onLoad({ filter: /.*/, namespace: 'without-editor' }, () => ({
            contents: 'module.exports = new Proxy({}, { get: () => () => null });',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1300, height: 900 });
  await page.setContent(`<!doctype html><html><head></head><body style="margin:0">${PAGE}</body></html>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.ready);
  return { page, errors };
}

/** Streams `text` into the live pane a few characters at a time. */
async function stream(page, text) {
  await page.evaluate(async (whole) => {
    for (let end = 1; end < whole.length; end += 5) {
      window.show('live', whole.slice(0, end), true);
      await new Promise((resolve) => setTimeout(resolve));
    }
    window.show('live', whole, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, text);
}

const REPLY = [
  '## Steps',
  '',
  'First paragraph with **bold** text that the reader selects from.',
  '',
  'Second paragraph where the selection ends.',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '- one',
  '- two',
  '',
  'Last words.',
].join('\n');

test('ending a reply keeps what the reader selected and focused, and every block element', async (t) => {
  const { page, errors } = await openPanes(t);
  await stream(page, REPLY);
  const before = await page.evaluate(() => {
    const reply = document.querySelector('#live .markdown');
    const [first, second] = reply.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(first.lastChild, 3);
    range.setEnd(second.firstChild, 6);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    reply.querySelector('.markdown-code-copy').focus();
    window.kept = {
      start: range.startContainer,
      end: range.endContainer,
      focus: document.activeElement,
      blocks: [...reply.children],
    };
    return {
      selected: getSelection().toString(),
      focused: document.activeElement.className,
      blocks: reply.children.length,
    };
  });
  assert.ok(before.selected.length > 10, `text is selected: ${JSON.stringify(before.selected)}`);
  assert.match(before.focused, /markdown-code-copy/);

  await page.evaluate((text) => window.show('live', text, false), REPLY);
  const after = await page.evaluate(() => {
    const reply = document.querySelector('#live .markdown');
    const selection = getSelection();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    return {
      selected: selection.toString(),
      sameStart: range?.startContainer === window.kept.start && range.startOffset === 3,
      sameEnd: range?.endContainer === window.kept.end && range.endOffset === 6,
      sameFocus: document.activeElement === window.kept.focus,
      sameBlocks:
        reply.children.length === window.kept.blocks.length &&
        window.kept.blocks.every((block, index) => reply.children[index] === block),
      ended: !reply.classList.contains('streaming'),
    };
  });
  assert.deepEqual(after, {
    selected: before.selected,
    sameStart: true,
    sameEnd: true,
    sameFocus: true,
    sameBlocks: true,
    ended: true,
  });
  assert.deepEqual(errors, []);
});

test('a correction the whole text makes early in a reply changes that block only', async (t) => {
  const { page, errors } = await openPanes(t);
  // The reference is defined at the end: while the reply streams, its first
  // paragraph shows the brackets; the whole text makes them a link. More than
  // a page of blocks follows it.
  const filler = Array.from({ length: 45 }, (_, index) => `Paragraph ${index} goes on.`).join('\n\n');
  const text = `See [the guide][g] first.\n\n${filler}\n\n[g]: https://example.com/guide\n\nEnd.`;
  await stream(page, text);
  const streamed = await page.evaluate(() => {
    const reply = document.querySelector('#live .markdown');
    window.kept = [...reply.children];
    return { link: Boolean(reply.querySelector('a')), blocks: reply.children.length };
  });
  assert.equal(streamed.link, false, 'the streamed paragraph has no link yet');
  assert.ok(streamed.blocks > 40);

  await page.evaluate((whole) => {
    window.show('live', whole, false);
    window.show('history', whole, false);
  }, text);
  const ended = await page.evaluate(() => {
    const reply = document.querySelector('#live .markdown');
    const history = document.querySelector('#history .markdown');
    return {
      link: reply.querySelector('a')?.getAttribute('href') ?? null,
      sameAsHistory: reply.innerHTML === history.innerHTML,
      suffixKept: window.kept.slice(1).every((block, index) => reply.children[index + 1] === block),
      blocks: reply.children.length,
    };
  });
  assert.deepEqual(ended, {
    link: 'https://example.com/guide',
    sameAsHistory: true,
    suffixKept: true,
    blocks: streamed.blocks,
  });
  assert.deepEqual(errors, []);
});
