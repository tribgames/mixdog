import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

const SECTIONS = 40;
const ARRIVING_SECTIONS = 12;

// The link component reaches the code editor, which only Vite can bundle; no
// reply block here opens it.
const WITHOUT_EDITOR = {
  name: 'without-editor',
  setup(bundler) {
    bundler.onResolve({ filter: /monaco/ }, (args) => ({ path: args.path, namespace: 'without-editor' }));
    bundler.onLoad({ filter: /.*/, namespace: 'without-editor' }, () => ({
      contents: 'module.exports = new Proxy({}, { get: () => () => null });',
      loader: 'js',
    }));
  },
};

// hast, as the markdown parser emits it.
const HAST = `
  const el = (tagName, children, properties = {}) => ({ type: 'element', tagName, properties, children });
  const text = (value) => ({ type: 'text', value });
  const words = (n, seed) => Array.from({ length: n }, (_, i) => 'word' + ((i * 7 + seed) % 23)).join(' ');
  const section = (n) => [
    el('h' + (1 + (n % 3)), [text('Section ' + n)]),
    text('\\n'),
    el('p', [text(words(40 + (n % 5) * 30, n)), el('code', [text('inline')]), text(' tail')]),
    text('\\n'),
    el('ul', [1, 2, 3].map((i) => el('li', [el('p', [text(words(12 * i, n + i))])]))),
    text('\\n'),
    el('blockquote', [el('p', [text(words(25, n))]), el('p', [text(words(9, n + 3))])]),
    text('\\n'),
    el('pre', [el('code', [text(Array.from({ length: 6 + (n % 4) }, (_, i) => 'const v' + i + ' = ' + n + ';').join('\\n') + '\\n')], { className: ['language-js'] })]),
    text('\\n'),
    el('table', [
      el('thead', [el('tr', [el('th', [text('Name')]), el('th', [text('Value')])])]),
      el('tbody', [1, 2].map((i) => el('tr', [el('td', [text('row ' + i)]), el('td', [text(words(14, n + i))])]))),
    ]),
    text('\\n'),
    el('hr', []),
    text('\\n'),
    el('ol', [1, 2].map((i) => el('li', [text(words(8, n * i))]))),
    text('\\n'),
  ];
  // The reply opens and closes on a block whose child's margin leaves through
  // the reply's own edge.
  const edge = () => el('ul', [el('li', [el('h1', [text('Edge')])])]);
  window.replyRoot = (count) => ({
    type: 'root',
    children: [edge(), text('\\n'), ...Array.from({ length: count }, (_, n) => section(n)).flat(), edge()],
  });
  // A body between others: it opens on \`lead\` and closes on a heading, whose
  // gap to the next body is the larger of its margin and that body's lead's.
  const leads = {
    rule: () => el('hr', []),
    list: () => el('ul', [el('li', [text('item')])]),
    // A heading whose title is still to arrive takes no box while the reply streams.
    untitled: () => el('h2', []),
  };
  // \`mark\`: the class of the line marks, which is what a highlighting sets.
  const codeLine = (n, mark) => [
    el('span', [text(n % 2 ? 'let' : 'const')], { className: [mark], dataLine: String(n) }),
    text(' v' + n + ' = ' + (n % 7 === 3 ? words(40, n) : n) + ';\\n'),
  ];
  const code = (lines, mark) => {
    const children = [];
    for (let n = 0; n < lines; n += 1) {
      if (n % 10 === 9) children.push(text('\\n'));
      else if (n % 100 === 30) {
        const until = Math.min(lines, n + 45);
        children.push(el('span', Array.from({ length: until - n }, (_, i) => codeLine(n + i, mark)).flat(), { className: ['hljs-comment'] }));
        n = until - 1;
      } else children.push(...codeLine(n, mark));
    }
    return el('pre', [el('code', children, { className: ['language-js'] })]);
  };
  // \`open\`: the code is the reply's last block, as while it arrives.
  // \`listed\`: it is inside an item of a list ('twice': and the same code
  // again, in a list inside that item). \`lead\`: sections before it.
  window.codeRoot = (lines, { open = false, listed = false, lead = 1, mark = 'hljs-keyword' } = {}) => {
    const deeper = listed === 'twice' ? [el('ul', [el('li', [code(lines, mark)])])] : [];
    const block = listed
      ? el('ul', [
          el('li', [el('p', [text(words(20, 1))]), code(lines, mark), ...deeper]),
          ...[2, 3].map((i) => el('li', [el('p', [text(words(30, i))])])),
        ])
      : code(lines, mark);
    const sections = (from, count) => Array.from({ length: count }, (_, n) => section(from + n)).flat();
    return {
      type: 'root',
      children: open
        ? [el('p', [text('Code:')]), text('\\n'), block]
        : [edge(), text('\\n'), ...sections(0, lead), block, text('\\n'), ...sections(lead, 8), edge()],
    };
  };
  window.ledRoot = (count, lead) => ({
    type: 'root',
    children: [leads[lead](), text('\\n'), ...Array.from({ length: count }, (_, n) => section(n)).flat(), el('h2', [text('Close')])],
  });
`;

const PAGE = (width) => `
  <style>.pane { position: absolute; top: 0; height: 600px; overflow-y: auto; }
  /* The list inside a list item is far narrower than its parent, whatever font the machine has: the long lines wrap differently there. */
  .pane ul ul { padding-inline-start: 240px !important; }</style>
  ${['whole', 'parked']
    .map(
      (id, index) => `
  <div class="pane" id="${id}" style="left:${index * 620}px;width:${width}px">
    <div style="height:500px"></div>
    <div class="transcript-virtual-row"><article class="message assistant settled"><div class="message-body" id="${id}-host"></div></article></div>
    <div style="height:500px"></div>
  </div>`
    )
    .join('')}`;

const PROBE = `
  window.frames = (count = 8) => new Promise((resolve) => {
    let seen = 0;
    const next = () => (++seen > count ? resolve() : requestAnimationFrame(next));
    next();
  });
  window.blocksOf = (id) => {
    const reply = document.querySelector('#' + id + ' .markdown');
    const top = reply.getBoundingClientRect().top;
    const rows = [...reply.children]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const unit = node.getAttribute('data-md-unit') ?? node.getAttribute('data-md-parked');
        return {
          top: rect.top - top,
          height: rect.height,
          parked: node.hasAttribute('data-md-parked'),
          // null: part of the block is parked (a code block's lines).
          text: node.querySelector('[data-md-parked]') ? null : node.textContent,
          body: unit === null ? null : unit.slice(0, unit.lastIndexOf(':')),
        };
      });
    return { height: reply.getBoundingClientRect().height, rows, elements: reply.querySelectorAll('*').length };
  };
  // The reply's code block: where each line in the DOM starts, and which of
  // its stretches are parked (null: it is not held in stretches). The block
  // of the reply it is in may be parked itself: none of it is in the DOM.
  window.codeOf = (id) => {
    const reply = document.querySelector('#' + id + ' .markdown');
    const top = reply.getBoundingClientRect().top;
    const code = reply.querySelector('.markdown-code code:has([data-line])');
    if (!code) return { lines: {}, stretches: [], top: null, height: null, elements: 0 };
    const card = code.closest('.markdown-code');
    const lines = {};
    for (const mark of code.querySelectorAll('[data-line]')) lines[mark.dataset.line] = mark.getBoundingClientRect().top - top;
    return {
      lines,
      stretches: code.hasAttribute('data-md-lines') ? [...code.children].map((node) => node.hasAttribute('data-md-parked')) : null,
      top: card.getBoundingClientRect().top - top,
      height: card.getBoundingClientRect().height,
      elements: code.querySelectorAll('*').length,
    };
  };
  // What a selection from the start of line \`from\` to the start of line \`to\`
  // copies once it stands. The selection stays (unselect).
  window.copied = async (id, from, to) => {
    const mark = (line) => document.querySelector('#' + id + ' [data-line="' + line + '"]');
    const range = document.createRange();
    range.setStartBefore(mark(from));
    range.setEndBefore(mark(to));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await window.frames();
    return selection.toString();
  };
  window.unselect = async () => {
    getSelection().removeAllRanges();
    await window.frames();
  };
  // How tall each long code block of the reply is.
  window.codeHeights = (id) =>
    [...document.querySelectorAll('#' + id + ' .markdown-code:has([data-line])')].map((card) => card.getBoundingClientRect().height);
  // The most elements the parked reply's code has held in the DOM since.
  window.watchCodePeak = () => {
    const reply = document.querySelector('#parked .markdown');
    let peak = 0;
    new MutationObserver(() => {
      peak = Math.max(peak, reply.querySelectorAll('.markdown-code code:has([data-line]) *').length);
    }).observe(reply, { childList: true, subtree: true });
    window.codePeak = () => peak;
  };
  window.scrollBoth = async (top) => {
    for (const id of ['whole', 'parked']) document.getElementById(id).scrollTop = top;
    await window.frames();
  };
`;

function sameGeometry(whole, parked, label) {
  assert.equal(parked.height, whole.height, `${label}: reply height`);
  assert.equal(parked.rows.length, whole.rows.length, `${label}: block count`);
  parked.rows.forEach((row, index) => {
    const expected = whole.rows[index];
    assert.equal(row.top, expected.top, `${label}: block ${index} top`);
    assert.equal(row.height, expected.height, `${label}: block ${index} height`);
    if (!row.parked && row.text !== null) assert.equal(row.text, expected.text, `${label}: block ${index} text`);
  });
}

/** By body, in reply order: how many of its blocks are parked and mounted. */
function blocksByBody(rows) {
  const bodies = new Map();
  for (const row of rows) {
    if (row.body === null) continue;
    const counts = bodies.get(row.body) ?? { parked: 0, mounted: 0 };
    counts[row.parked ? 'parked' : 'mounted'] += 1;
    bodies.set(row.body, counts);
  }
  return [...bodies.values()];
}

let assets;

function replyAssets() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  assets ??= Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import { createElement, useLayoutEffect, useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { MarkdownDocumentView } from './MarkdownDocumentView';
          import { markdownPagesOf } from './markdown-document';
          import { createBlockParking, MarkdownBlockParkingContext } from './markdown-block-parking';
          const Copy = () => null;
          // Each body's children are units b<body>:<child>; a body without a
          // tree is one whose parse is still to land. While the reply grows its
          // last body and the unit before it are held.
          function unitsOf(bodies, growing) {
            const units = bodies.flatMap((root, body) => root
              ? root.children.map((node, child) => ({ key: 'b' + body + ':' + child, node, from: 0, held: false }))
              : [{ key: 'b' + body + ':wait', node: null, from: 0, held: false, text: '', pending: true }]);
            if (!growing) return units;
            const last = 'b' + (bodies.length - 1) + ':';
            const first = units.findIndex((unit) => unit.key.startsWith(last));
            return units.map((unit, index) => (index >= first - 1 ? { ...unit, held: true } : unit));
          }
          function Reply({ bodies, parks, growing }) {
            const ref = useRef(null);
            const [parking] = useState(createBlockParking);
            useLayoutEffect(() => { if (parks) parking.attach(ref.current, true, growing); }, [parking, parks, growing]);
            if (parks) window.replyParking = parking;
            return createElement(MarkdownBlockParkingContext.Provider, { value: parks ? parking : null },
              createElement('div', { ref, className: growing ? 'markdown streaming' : 'markdown' },
                createElement(MarkdownDocumentView, { root: markdownPagesOf(unitsOf(bodies, growing)), copyControl: Copy })));
          }
          const replies = new Map();
          // The reply in pane \`id\`, as these bodies; \`growing\`: still arriving.
          window.renderReply = (id, bodies, parks, growing = false) => {
            if (!replies.has(id)) replies.set(id, createRoot(document.getElementById(id + '-host')));
            replies.get(id).render(createElement(Reply, { bodies, parks, growing }));
          };`,
      },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      outfile: 'parking.js',
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'empty' },
      plugins: [WITHOUT_EDITOR],
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: ['font-faces', 'ui/tokens', 'styles', 'desktop', 'pane-layout']
          .map((sheet) => `@import "./${sheet}.css";`)
          .join('\n'),
      },
      outfile: 'parking.css',
      bundle: true,
      write: false,
      logLevel: 'error',
      external: ['*.woff2', '*.woff', '*.ttf', '*.otf', '*.svg', '*.png', '*.jpg', '*.webp', '*.gif'],
    }),
  ]);
  return assets;
}

/** A page with the two panes and the reply harness loaded. */
async function openReplies(t) {
  const [bundle, styles] = await replyAssets();
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 700 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<!doctype html><html><head></head><body style="margin:0">${PAGE(560)}</body></html>`);
  await page.addStyleTag({ content: styles.outputFiles.find((file) => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.evaluate(`${HAST}${PROBE}`);
  const read = async () => ({
    whole: await page.evaluate('window.blocksOf("whole")'),
    parked: await page.evaluate('window.blocksOf("parked")'),
  });
  return { page, errors, read };
}

test('parked blocks leave the DOM and the reply keeps its exact geometry', async (t) => {
  const { page, errors, read } = await openReplies(t);
  await page.evaluate(`
    const root = window.replyRoot(${SECTIONS});
    window.renderReply('whole', [root], false);
    window.renderReply('parked', [root], true);
    window.frames()`);
  assert.deepEqual(errors, [], 'both replies rendered');

  const max = await page.evaluate(
    '(() => { const pane = document.getElementById("whole"); return pane.scrollHeight - pane.clientHeight; })()'
  );
  assert.ok(max > 6000, `the reply is many viewports long: ${max}`);

  const first = await read();
  assert.ok(
    first.parked.rows.some((row) => row.parked),
    'blocks far below the reader are parked'
  );
  assert.ok(
    first.parked.elements < first.whole.elements / 3,
    `most of the reply left the DOM: ${first.parked.elements} of ${first.whole.elements} elements`
  );
  sameGeometry(first.whole, first.parked, 'at the top');

  for (const top of [max / 3, max, max / 2, 0, max * 0.8]) {
    await page.evaluate(`window.scrollBoth(${top})`);
    const at = await read();
    sameGeometry(at.whole, at.parked, `at ${Math.round(top)}`);
    const view = { top: top - 500, bottom: top - 500 + 600 };
    for (const row of at.parked.rows) {
      const inView = row.top + row.height > view.top && row.top < view.bottom;
      if (inView) assert.equal(row.parked, false, `a block in view at ${Math.round(top)} is mounted`);
    }
    assert.ok(at.parked.elements < at.whole.elements / 3, `still mostly out of the DOM at ${Math.round(top)}`);
  }

  // Another width: a parked box stands for its block as measured, so each
  // block takes its real height when the reader reaches it. Once the reader
  // has passed over the whole reply, it is laid out as the whole one again.
  await page.evaluate(`
    for (const id of ['whole', 'parked']) document.getElementById(id).style.width = '400px';
    window.frames()`);
  const narrowMax = await page.evaluate(
    '(() => { const pane = document.getElementById("whole"); return pane.scrollHeight - pane.clientHeight; })()'
  );
  for (let top = 0; top <= narrowMax + 600; top += 300) await page.evaluate(`window.scrollBoth(${top})`);
  for (let top = narrowMax; top >= 0; top -= 300) await page.evaluate(`window.scrollBoth(${top})`);
  await page.evaluate('window.scrollBoth(0)');
  const narrow = await read();
  sameGeometry(narrow.whole, narrow.parked, 'after the width changed');
  assert.ok(narrow.parked.rows.some((row) => row.parked));

  assert.deepEqual(errors, []);
});

test('a reply still arriving parks every body but its last', async (t) => {
  const { page, errors, read } = await openReplies(t);
  // The reader stays at the top, so each body that arrives is out of reach.
  await page.evaluate(`
    const bodies = [0, 1, 2].map(() => window.replyRoot(${ARRIVING_SECTIONS}));
    window.arrive = async (count, growing) => {
      window.renderReply('whole', bodies.slice(0, count), false, growing);
      window.renderReply('parked', bodies.slice(0, count), true, growing);
      await window.frames();
    };`);

  await page.evaluate('window.arrive(2, true)');
  const two = await read();
  const [first, last] = blocksByBody(two.parked.rows);
  assert.ok(first.parked > 0, 'blocks of the body before the last are parked');
  assert.deepEqual(last, { parked: 0, mounted: last.mounted }, 'the last body is whole');
  sameGeometry(two.whole, two.parked, 'two bodies arrived');

  await page.evaluate('window.arrive(3, true)');
  const three = await read();
  const bodies = blocksByBody(three.parked.rows);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[1].parked > 0, 'a body parks once another follows it');
  assert.equal(bodies[2].parked, 0, 'the new last body is whole');
  sameGeometry(three.whole, three.parked, 'three bodies arrived');

  await page.evaluate('window.arrive(3, false)');
  const settled = await read();
  assert.ok(blocksByBody(settled.parked.rows)[2].parked > 0, 'the last body parks once the reply has ended');
  sameGeometry(settled.whole, settled.parked, 'the reply ended');

  assert.deepEqual(errors, []);
});

const CODE_LINES = 1200;

/** Every line of the parked code that is in the DOM starts where the whole
 *  one has it, and the card is as tall. */
function sameCode(whole, parked, label) {
  if (parked.top !== null) {
    assert.equal(parked.top, whole.top, `${label}: code card top`);
    assert.equal(parked.height, whole.height, `${label}: code card height`);
  }
  for (const [line, top] of Object.entries(parked.lines)) {
    assert.equal(top, whole.lines[line], `${label}: line ${line} top`);
  }
}

test('a long code block keeps only the lines near the reader in the DOM', async (t) => {
  const { page, errors, read } = await openReplies(t);
  const code = async () => ({
    whole: await page.evaluate('window.codeOf("whole")'),
    parked: await page.evaluate('window.codeOf("parked")'),
  });
  await page.evaluate(`
    const root = window.codeRoot(${CODE_LINES});
    window.renderReply('whole', [root], false);
    window.renderReply('parked', [root], true);
    window.frames()`);
  assert.deepEqual(errors, [], 'both replies rendered');

  const first = await code();
  assert.equal(first.whole.stretches, null, 'a reply that parks nothing holds its code whole');
  assert.ok(first.parked.stretches.length > 10, `the code is held in stretches: ${first.parked.stretches.length}`);
  assert.ok(first.parked.stretches.some(Boolean), 'stretches far below the reader are parked');
  assert.ok(
    first.parked.elements < first.whole.elements / 3,
    `most of the code left the DOM: ${first.parked.elements} of ${first.whole.elements} elements`
  );
  sameCode(first.whole, first.parked, 'at the top');
  const firstBlocks = await read();
  sameGeometry(firstBlocks.whole, firstBlocks.parked, 'at the top');
  // A selection over the end of one stretch and the start of the next, both
  // in view.
  await page.evaluate(`window.scrollBoth(${first.whole.lines[36] + 500 - 100})`);
  assert.equal(
    await page.evaluate('window.copied("parked", 36, 44)'),
    await page.evaluate('window.copied("whole", 36, 44)'),
    'lines copy as from the code whole'
  );
  // A selection over lines that are parked: they return for it.
  const copied = await page.evaluate(`window.copied("parked", 0, ${CODE_LINES - 2})`);
  assert.ok(copied.length > CODE_LINES * 10, `the selection ran over the code: ${copied.length} characters`);
  // The lines the selection leaves park again, while it still stands on others.
  await page.evaluate('window.copied("parked", 36, 37)');
  const narrowed = await code();
  assert.ok(
    narrowed.parked.elements < narrowed.whole.elements / 3,
    `the lines no longer selected parked: ${narrowed.parked.elements} of ${narrowed.whole.elements} elements`
  );
  assert.equal(copied, await page.evaluate(`window.copied("whole", 0, ${CODE_LINES - 2})`), 'parked lines copy too');
  // And all of them once it is gone.
  await page.evaluate(`window.copied("parked", 0, ${CODE_LINES - 2})`);
  await page.evaluate('window.unselect()');
  const unselected = await code();
  assert.ok(
    unselected.parked.elements < unselected.whole.elements / 3,
    `the lines parked again: ${unselected.parked.elements} of ${unselected.whole.elements} elements`
  );
  sameCode(unselected.whole, unselected.parked, 'after a selection');

  const max = await page.evaluate(
    '(() => { const pane = document.getElementById("whole"); return pane.scrollHeight - pane.clientHeight; })()'
  );
  for (const top of [max / 3, max, max / 2, 0, max * 0.7]) {
    await page.evaluate(`window.scrollBoth(${top})`);
    const at = await code();
    const label = `at ${Math.round(top)}`;
    sameCode(at.whole, at.parked, label);
    const view = { top: top - 500, bottom: top - 500 + 600 };
    for (const [line, lineTop] of Object.entries(at.whole.lines)) {
      if (lineTop < view.top || lineTop >= view.bottom) continue;
      assert.ok(line in at.parked.lines, `${label}: line ${line} in view is in the DOM`);
    }
    assert.ok(at.parked.elements < at.whole.elements / 3, `${label}: still mostly out of the DOM`);
    const blocks = await read();
    sameGeometry(blocks.whole, blocks.parked, label);
  }

  assert.deepEqual(errors, []);
});

test('code highlighted anew is laid out anew', async (t) => {
  const { page, errors, read } = await openReplies(t);
  // The same text under other marks, which lay every line out on two rows.
  await page.addStyleTag({ content: '.test-tall { display: block; }' });
  const code = async () => ({
    whole: await page.evaluate('window.codeOf("whole")'),
    parked: await page.evaluate('window.codeOf("parked")'),
  });
  await page.evaluate(`
    window.highlight = async (mark) => {
      const root = window.codeRoot(${CODE_LINES}, { mark });
      window.renderReply('whole', [root], false);
      window.renderReply('parked', [root], true);
      await window.frames();
    };
    window.highlight('hljs-keyword')`);
  const plain = await code();
  await page.evaluate(`window.scrollBoth(${plain.whole.lines[600] + 500 - 100})`);
  const before = await code();
  assert.ok(before.parked.stretches.slice(0, 10).some(Boolean), 'stretches above the reader are parked');
  sameCode(before.whole, before.parked, 'before');

  await page.evaluate('window.highlight("test-tall")');
  const after = await code();
  assert.ok(after.whole.height > before.whole.height * 1.5, 'the code is taller under the other marks');
  sameCode(after.whole, after.parked, 'highlighted anew');
  const blocks = await read();
  sameGeometry(blocks.whole, blocks.parked, 'highlighted anew');
  assert.ok(after.parked.stretches.some(Boolean), 'the stretches park again');

  assert.deepEqual(errors, []);
});

test('code inside a list returns from the parked list with its lines parked', async (t) => {
  const { page, errors, read } = await openReplies(t);
  const lines = CODE_LINES * 2;
  const code = async () => ({
    whole: await page.evaluate('window.codeOf("whole")'),
    parked: await page.evaluate('window.codeOf("parked")'),
  });
  await page.evaluate(`
    const root = window.codeRoot(${lines}, { listed: true });
    window.renderReply('whole', [root], false);
    window.renderReply('parked', [root], true);
    window.frames()`);
  const first = await code();
  assert.ok(first.parked.stretches.some(Boolean), 'the lines of code inside a list park');
  sameCode(first.whole, first.parked, 'at the top');

  // Far below the list, all of it leaves the DOM as one block of the reply.
  const max = await page.evaluate(
    '(() => { const pane = document.getElementById("whole"); return pane.scrollHeight - pane.clientHeight; })()'
  );
  await page.evaluate(`window.scrollBoth(${max})`);
  const away = await read();
  sameGeometry(away.whole, away.parked, 'far below the list');
  assert.equal((await code()).parked.top, null, 'the list is parked with its code');

  // Back in the middle of the code, the list returns with the lines that were
  // parked still parked: the code is never whole in the DOM.
  await page.evaluate('window.watchCodePeak()');
  await page.evaluate(`window.scrollBoth(${first.whole.lines[lines / 2] + 500 - 100})`);
  const back = await code();
  sameCode(back.whole, back.parked, 'back in the code');
  const blocks = await read();
  sameGeometry(blocks.whole, blocks.parked, 'back in the code');
  const view = { top: first.whole.lines[lines / 2] - 100, bottom: first.whole.lines[lines / 2] + 500 };
  for (const [line, lineTop] of Object.entries(back.whole.lines)) {
    if (lineTop < view.top || lineTop >= view.bottom) continue;
    assert.ok(line in back.parked.lines, `line ${line} in view is in the DOM`);
  }
  const peak = await page.evaluate('window.codePeak()');
  assert.ok(peak > 0, 'the code returned');
  assert.ok(
    peak < back.whole.elements / 3,
    `the code never returned whole: ${peak} of ${back.whole.elements} elements`
  );

  assert.deepEqual(errors, []);
});

test('code in a list that parked before the reader came near returns with its lines parked', async (t) => {
  const { page, errors, read } = await openReplies(t);
  const lines = CODE_LINES * 2;
  const code = async () => ({
    whole: await page.evaluate('window.codeOf("whole")'),
    parked: await page.evaluate('window.codeOf("parked")'),
  });
  // The list is many viewports below the reader from the start: it parks on
  // the observer's first report, none of its lines having parked before.
  await page.evaluate(`
    const root = window.codeRoot(${lines}, { listed: true, lead: 12 });
    window.renderReply('whole', [root], false);
    window.renderReply('parked', [root], true);
    window.frames()`);
  const first = await code();
  assert.equal(first.parked.top, null, 'the list is parked with its code');

  await page.evaluate('window.watchCodePeak()');
  const middle = first.whole.lines[lines / 2];
  await page.evaluate(`window.scrollBoth(${middle + 500 - 100})`);
  const back = await code();
  sameCode(back.whole, back.parked, 'in the code');
  const blocks = await read();
  sameGeometry(blocks.whole, blocks.parked, 'in the code');
  for (const [line, lineTop] of Object.entries(back.whole.lines)) {
    if (lineTop < middle - 100 || lineTop >= middle + 500) continue;
    assert.ok(line in back.parked.lines, `line ${line} in view is in the DOM`);
  }
  const peak = await page.evaluate('window.codePeak()');
  assert.ok(peak > 0, 'the code returned');
  assert.ok(
    peak < back.whole.elements / 3,
    `the code never returned whole: ${peak} of ${back.whole.elements} elements`
  );

  assert.deepEqual(errors, []);
});

test('nothing is kept for the code of a body that left its reply', async (t) => {
  const { page, errors } = await openReplies(t);
  await page.evaluate(`
    const bodies = [window.replyRoot(2), window.codeRoot(${CODE_LINES}, { lead: 0 })];
    window.show = async (count) => {
      window.renderReply('whole', bodies.slice(0, count), false);
      window.renderReply('parked', bodies.slice(0, count), true);
      await window.frames();
    };
    window.show(2)`);
  const top = (await page.evaluate('window.codeOf("whole")')).lines[0];
  await page.evaluate(`window.scrollBoth(${top + 500 - 100})`);
  // The code is the first of its block: its place, and its parked stretches.
  const code = await page.evaluate(`(() => {
    const code = document.querySelector('#parked .markdown-code code:has([data-line])');
    const unit = code.closest('[data-md-unit]').getAttribute('data-md-unit');
    return {
      place: unit + '/0',
      parked: [...code.children].map((node) => node.getAttribute('data-md-parked')).filter(Boolean),
    };
  })()`);
  assert.ok(code.parked.length > 5, `stretches of the code are parked: ${code.parked.length}`);
  const kept = `(() => {
    const lines = window.replyParking.inner(${JSON.stringify(code.place)});
    return ${JSON.stringify(code.parked)}.filter((id) => lines.parked(id)).length;
  })()`;

  // Far above the code its card leaves the DOM, and what was parked is kept.
  await page.evaluate('window.scrollBoth(0)');
  assert.equal((await page.evaluate('window.codeOf("parked")')).top, null, 'the card is parked');
  assert.equal(await page.evaluate(kept), code.parked.length, 'kept while the card is out of the DOM');

  await page.evaluate('window.show(1)');
  assert.equal(await page.evaluate(kept), 0, 'dropped with the body');

  assert.deepEqual(errors, []);
});

test('the same code twice in a list returns each as tall as it was', async (t) => {
  const { page, errors, read } = await openReplies(t);
  const heights = async () => ({
    whole: await page.evaluate('window.codeHeights("whole")'),
    parked: await page.evaluate('window.codeHeights("parked")'),
  });
  // The second is in a list inside the item: narrower, so its lines wrap more.
  await page.evaluate(`
    const root = window.codeRoot(${CODE_LINES}, { listed: 'twice' });
    window.renderReply('whole', [root], false);
    window.renderReply('parked', [root], true);
    window.frames()`);
  const listTop = (await page.evaluate('window.codeOf("whole")')).lines[0] + 500 - 100;
  await page.evaluate(`window.scrollBoth(${listTop})`);
  const first = await heights();
  assert.equal(first.whole.length, 2);
  assert.notEqual(first.whole[0], first.whole[1], 'the two wrap differently');
  assert.deepEqual(first.parked, first.whole, 'at the list');

  const max = await page.evaluate(
    '(() => { const pane = document.getElementById("whole"); return pane.scrollHeight - pane.clientHeight; })()'
  );
  await page.evaluate(`window.scrollBoth(${max})`);
  assert.deepEqual((await heights()).parked, [], 'the list is parked with both');
  await page.evaluate(`window.scrollBoth(${listTop})`);
  const back = await heights();
  assert.deepEqual(back.parked, back.whole, 'back at the list');
  const blocks = await read();
  sameGeometry(blocks.whole, blocks.parked, 'back at the list');

  assert.deepEqual(errors, []);
});

test('code still arriving parks every stretch but its last two', async (t) => {
  const { page, errors } = await openReplies(t);
  // The reader stays at the top, so the lines that arrive are out of reach.
  await page.evaluate(`
    window.arrive = async (lines, growing) => {
      const root = window.codeRoot(lines, { open: true });
      window.renderReply('whole', [root], false, growing);
      window.renderReply('parked', [root], true, growing);
      await window.frames();
    };`);
  const code = async () => ({
    whole: await page.evaluate('window.codeOf("whole")'),
    parked: await page.evaluate('window.codeOf("parked")'),
  });

  await page.evaluate('window.arrive(300, true)');
  const some = await code();
  assert.ok(some.parked.stretches.some(Boolean), 'stretches before the last two are parked');
  assert.deepEqual(some.parked.stretches.slice(-2), [false, false], 'the last two stretches are in the DOM');
  sameCode(some.whole, some.parked, '300 lines arrived');

  // A line that arrives changes only the last stretch.
  await page.evaluate('window.arrive(301, true)');
  const one = await code();
  assert.deepEqual(one.parked.stretches.slice(0, -2), some.parked.stretches.slice(0, -2), 'no parked stretch returned');
  sameCode(one.whole, one.parked, 'one more line arrived');

  await page.evaluate(`window.arrive(${CODE_LINES}, true)`);
  const more = await code();
  const parkedOf = (stretches) => stretches.filter(Boolean).length;
  assert.ok(parkedOf(more.parked.stretches) > parkedOf(some.parked.stretches), 'stretches park as more follow them');
  assert.deepEqual(more.parked.stretches.slice(-2), [false, false], 'the last two stretches are in the DOM');
  assert.ok(more.parked.elements < more.whole.elements / 3, 'most of the code never stayed in the DOM');
  sameCode(more.whole, more.parked, 'all lines arrived');

  await page.evaluate(`window.arrive(${CODE_LINES}, false)`);
  const settled = await code();
  assert.deepEqual(
    settled.parked.stretches.slice(-2),
    [true, false],
    'the stretch before the last parks once the reply has ended'
  );
  sameCode(settled.whole, settled.parked, 'the reply ended');

  assert.deepEqual(errors, []);
});

test('a parked block keeps no gap to a neighbour that changed', async (t) => {
  const { page, errors, read } = await openReplies(t);
  // The reader stays at the top; the second body opens on a rule or on a
  // list, which stand at different gaps under the heading before them.
  await page.evaluate(`
    const outer = [0, 1].map(() => window.ledRoot(${ARRIVING_SECTIONS}, 'rule'));
    const middles = {};
    window.lead = async (lead, bodies, growing) => {
      if (lead) middles[lead] ??= window.ledRoot(${ARRIVING_SECTIONS}, lead);
      const reply = [outer[0], lead && middles[lead], outer[1]].slice(0, bodies);
      window.renderReply('whole', reply, false, growing);
      window.renderReply('parked', reply, true, growing);
      await window.frames();
    };`);

  await page.evaluate('window.lead("rule", 3, false)');
  const ruled = await read();
  const firstBody = ruled.parked.rows.filter((row) => row.body === ruled.parked.rows.find((other) => other.body)?.body);
  assert.equal(firstBody.at(-1).parked, true, 'the heading before the second body is parked');
  sameGeometry(ruled.whole, ruled.parked, 'a rule under the heading');

  await page.evaluate('window.lead("list", 3, false)');
  const listed = await read();
  assert.notEqual(listed.whole.height, ruled.whole.height, 'the gap under the heading changed');
  sameGeometry(listed.whole, listed.parked, 'a list under the heading');

  // The second body leaves, as one whose parse is still to land, and lands.
  await page.evaluate('window.lead(null, 3, false)');
  const pending = await read();
  assert.equal(pending.parked.rows.filter((row) => row.body).length, firstBody.length * 2, 'two bodies are shown');
  sameGeometry(pending.whole, pending.parked, 'the third body under the heading');
  await page.evaluate('window.lead("list", 3, false)');
  const landed = await read();
  sameGeometry(landed.whole, landed.parked, 'a body landed under the heading');

  // The last body of a reply still arriving changes with every parse.
  await page.evaluate('window.lead("rule", 2, true)');
  const tail = await read();
  sameGeometry(tail.whole, tail.parked, 'the third body left');
  await page.evaluate('window.lead("list", 2, true)');
  const grown = await read();
  sameGeometry(grown.whole, grown.parked, 'the last body changed');

  // A heading whose title is still to arrive takes no box while the reply
  // streams: the gap of the blocks around it runs past it.
  await page.evaluate('window.lead("untitled", 3, true)');
  const untitled = await read();
  assert.ok(blocksByBody(untitled.parked.rows)[1].parked > 0, 'the body under the untitled heading parks');
  sameGeometry(untitled.whole, untitled.parked, 'an untitled heading');

  // The same reply ends: the heading has a box of no height, which the
  // margins around it meet through, and the last body may park.
  await page.evaluate('window.lead("untitled", 3, false)');
  const ended = await read();
  assert.ok(blocksByBody(ended.parked.rows)[2].parked > 0, 'the last body parks once the reply has ended');
  sameGeometry(ended.whole, ended.parked, 'an untitled heading in a reply that ended');

  assert.deepEqual(errors, []);
});
