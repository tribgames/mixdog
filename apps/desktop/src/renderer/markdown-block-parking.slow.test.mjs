import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// A long settled reply keeps only the blocks near the reader in the DOM
// (markdown-block-parking). In a real Chrome against the app's stylesheets and
// markdown components, the same reply is rendered twice, once whole: wherever
// the reader scrolls, every block of the parked one sits where the whole one
// has it, to the layout unit, and the reply is as tall. A reply still arriving
// does the same for every body but its last.

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
  window.ledRoot = (count, lead) => ({
    type: 'root',
    children: [leads[lead](), text('\\n'), ...Array.from({ length: count }, (_, n) => section(n)).flat(), el('h2', [text('Close')])],
  });
`;

const PAGE = (width) => `
  <style>.pane { position: absolute; top: 0; height: 600px; overflow-y: auto; }</style>
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
          text: node.textContent,
          body: unit === null ? null : unit.slice(0, unit.lastIndexOf(':')),
        };
      });
    return { height: reply.getBoundingClientRect().height, rows, elements: reply.querySelectorAll('*').length };
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
    if (!row.parked) assert.equal(row.text, expected.text, `${label}: block ${index} text`);
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
          import MarkdownAstBody from './MarkdownAstBody';
          import { createBlockParking, MarkdownBlockParkingContext } from './markdown-block-parking';
          const Copy = () => null;
          function Reply({ bodies, parks, growing }) {
            const ref = useRef(null);
            const [parking] = useState(createBlockParking);
            useLayoutEffect(() => { if (parks) parking.attach(ref.current, true, growing); }, [parking, parks, growing]);
            return createElement(MarkdownBlockParkingContext.Provider, { value: parks ? parking : null },
              createElement('div', { ref, className: growing ? 'markdown streaming' : 'markdown' },
                // A body without a tree is one whose parse is still to land.
                bodies.map((root, index) => root
                  ? createElement(MarkdownAstBody, { key: index, root, copyControl: Copy })
                  : createElement('span', { key: index, hidden: true }))));
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
