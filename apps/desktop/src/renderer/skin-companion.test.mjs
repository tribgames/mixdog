import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const model = await import('./skin-companion-model');

// ---- Bubble state from the session ----------------------------------------

const prompt = (id, at = 0) => ({ kind: 'user', id, text: 'do it', at });
const reply = (id, text) => ({ kind: 'assistant', id, text });
const done = (id, at, extra = {}) => ({ kind: 'turndone', id, status: 'done', at, ...extra });

test("the latest completion carries the outcome and the final reply's markdown", () => {
  assert.equal(model.latestCompletion([]), null);
  assert.equal(model.latestCompletion([prompt('u1')]), null, 'a prompt still waiting has no completion');
  const items = [prompt('u1'), reply('a1', 'preamble'), reply('a2', '## Fixed the **build**\n\nmore'), done('d1', 50)];
  assert.deepEqual(model.latestCompletion(items), {
    key: 'd1',
    kind: 'done',
    at: 50,
    text: '## Fixed the **build**\n\nmore',
  });
  const final = [
    prompt('u1'),
    reply('a1', 'the answer'),
    reply('a2', 'trailing'),
    done('d1', 50, { finalAssistantId: 'a1' }),
  ];
  assert.equal(model.latestCompletion(final).text, 'the answer', 'finalAssistantId picks the reply');
  assert.equal(model.latestCompletion([prompt('u1'), { kind: 'turndone', id: 'd', status: 'failed' }]).kind, 'failed');
  assert.equal(
    model.latestCompletion([prompt('u1'), { kind: 'turndone', id: 'd', status: 'cancelled' }]).kind,
    'cancelled'
  );
});

test("a reply's markdown is kept for the bubble: control characters dropped, blank runs folded, bounded", () => {
  assert.equal(
    model.markdownReplyText('# Done\r\n\n\n\n- **built**\tit\u0007\n```ts\nconst a = 1;\n```  '),
    '# Done\n\n- **built**    it\n```ts\nconst a = 1;\n```'
  );
  assert.equal(model.markdownReplyText('\n\n'), '');
  assert.equal(
    model.markdownReplyText('word '.repeat(400)),
    'word '.repeat(400).trim(),
    'an ordinary long reply is whole'
  );
  const long = model.markdownReplyText('word '.repeat(1000));
  assert.equal(long.length, 4000);
  assert.ok(long.endsWith('…'));
});
test('the bubble: approval outranks work; a new reply shows until dismissed; failures and history sleep', () => {
  const completion = { key: 'd1', kind: 'done', at: 200, text: 'Fixed it' };
  const base = { working: false, approval: false, completion, dismissedKey: '', firstSeenAt: 100, sawWorking: false };
  assert.deepEqual(model.companionBubble({ ...base, working: true, approval: true }), { kind: 'approval' });
  assert.deepEqual(model.companionBubble({ ...base, working: true }), { kind: 'working' });
  assert.deepEqual(model.companionBubble(base), { kind: 'reply', key: 'd1', text: 'Fixed it' });
  assert.deepEqual(model.companionBubble({ ...base, dismissedKey: 'd1' }), { kind: 'idle' });
  // Finished before the pet first saw the chat, and never seen working: history.
  assert.deepEqual(model.companionBubble({ ...base, firstSeenAt: 300 }), { kind: 'idle' });
  assert.deepEqual(model.companionBubble({ ...base, firstSeenAt: 300, sawWorking: true }).kind, 'reply');
  // A failed or cancelled turn shows nothing special; nor does an empty reply.
  for (const kind of ['failed', 'cancelled']) {
    assert.deepEqual(model.companionBubble({ ...base, completion: { ...completion, kind, text: '' } }), {
      kind: 'idle',
    });
  }
  assert.deepEqual(model.companionBubble({ ...base, completion: { ...completion, text: '' } }), { kind: 'idle' });
  assert.deepEqual(model.companionBubble({ ...base, completion: null }), { kind: 'idle' });
});

// ---- The pet (drawn in the pet window) ---------------------------------------

async function mountPet(t, props = {}) {
  const dom = installTestDom(t, {
    rootId: 'root',
    expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'],
  });
  const { CompanionPet } = await import('./skin-companion-pet');
  const calls = {
    send: [],
    open: 0,
    menu: 0,
    drag: [],
    nudge: [],
    reset: 0,
    focus: [],
    dismiss: [],
    read: [],
    copy: [],
  };
  let current = {
    face: React.createElement('span', { className: 'skin-companion-face' }),
    bubble: { kind: 'idle' },
    collapsed: false,
    canSend: true,
    onOpen: () => calls.open++,
    onSend: async (text) => {
      calls.send.push(text);
      return true;
    },
    onDismiss: (key) => calls.dismiss.push(key),
    onMenu: () => calls.menu++,
    onDrag: (drag) => calls.drag.push(drag),
    onNudge: (dx, dy) => calls.nudge.push([dx, dy]),
    onReset: () => calls.reset++,
    onInputFocus: (open) => calls.focus.push(open),
    onRead: (key) => calls.read.push(key),
    onCopy: (key) => calls.copy.push(key),
    blurSignal: 0,
    ...props,
  };
  const render = (next = {}) => {
    current = { ...current, ...next };
    return act(async () => dom.root.render(React.createElement(CompanionPet, current)));
  };
  await render();
  const $ = (selector) => dom.document.querySelector(selector);
  const typeInto = (input, value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  const key = (target, init) =>
    act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
  return {
    ...dom,
    $,
    pet: () => $('.skin-companion'),
    mascot: () => $('.skin-companion-pet'),
    render,
    typeInto,
    key,
    calls,
  };
}

test('idle shows no bubble: the pet itself idles (breathes, blinks), paused off screen', async (t) => {
  const { $, pet, render, mascot } = await mountPet(t);
  assert.equal($('.skin-companion-bubble'), null, 'no bubble when idle');
  assert.equal($('.skin-companion-zzz'), null, 'no z Z Z');
  assert.equal($('.skin-companion-status .sr-only').textContent, '', 'nothing announced');
  assert.equal(pet().dataset.idle, 'true', 'the idle animation is on');
  assert.equal(pet().dataset.paused, undefined);
  await render({ paused: true });
  assert.equal(pet().dataset.paused, 'true', 'off screen: paused');
  await render({ paused: false, bubble: { kind: 'working' } });
  assert.equal(pet().dataset.idle, undefined, 'working: the bubble talks, the pet holds still');
  await render({ bubble: { kind: 'idle' } });
  await act(async () => mascot().click());
  assert.equal(pet().dataset.idle, undefined, 'the quick message open: no idle animation');
});

test('the idle animation lives on the sprite in CSS: eyes pixels blink, squash fallback, off under reduced motion', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  for (const rule of [
    /\.skin-companion\[data-idle\] \.mx-av \.eyes-open \{\s*animation: pet-blink-open/,
    /\.skin-companion\[data-idle\] \.mx-av \.eyes-shut \{\s*animation: pet-blink-shut/,
    /\.skin-companion\[data-idle\] \.mx-av \.bob \{\s*animation: pet-breathe/,
    /\.skin-companion\[data-idle\] \.mx-av \.ear \{\s*animation: pet-twitch/,
    /svg:not\(:has\(\.eyes-open\)\) \{[^}]*animation: pet-squash/,
    /\.skin-companion\[data-paused\]\[data-idle\] \.skin-companion-face \.mx-av \*,[^{]*\{\s*animation-play-state: paused/,
  ]) {
    assert.match(css, rule);
  }
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(
    reduced,
    /\.skin-companion\[data-idle\]\[data-idle\] \.skin-companion-face \.mx-av \*,[^{]*\{\s*animation: none;/
  );
  assert.equal(/zzz|doze/.test(css), false, 'the z Z Z is gone');
  assert.equal(/glance|\.eyes \{/.test(css), false, 'no side glance: the eyes never move');
  assert.doesNotMatch(css.match(/@keyframes pet-twitch \{[^@]*/)[0], /translateX/, 'the ear only bobs');
});

test('every idle animation steps, so the transparent pet window is not recomposited every frame', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  const idle = [...css.matchAll(/\.skin-companion\[data-idle\][^{]*\{([^}]*)\}/g)]
    .flatMap((rule) => [...rule[1].matchAll(/animation:\s*(pet-[\w-]+)[^;]*;/g)])
    .map((declaration) => declaration[0]);
  assert.ok(idle.length >= 5, idle.join('\n'));
  for (const declaration of idle) assert.match(declaration, /step-end/, declaration);
});

test('each busy state is a comic symbol in a polite live region with a spoken label', async (t) => {
  const { $, render, calls } = await mountPet(t);
  const status = $('.skin-companion-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  const cases = [
    ['working', 'Companion: working', '.skin-companion-dots', ''],
    ['approval', 'Companion: waiting for your approval', '.skin-companion-mark', '!'],
  ];
  for (const [kind, label, symbol, glyph] of cases) {
    await render({ bubble: { kind } });
    const bubble = $('.skin-companion-bubble');
    assert.equal(bubble.dataset.state, kind);
    assert.equal(status.querySelector('.sr-only').textContent, label);
    assert.equal($(symbol).getAttribute('aria-hidden'), 'true');
    assert.equal($(symbol).textContent, glyph);
    assert.equal(bubble.getAttribute('role'), null, 'a symbol is not clickable');
  }
  // A reply: just its text, grown out of the SAME bubble element the dots were in.
  await render({ bubble: { kind: 'working' } });
  const dots = $('.skin-companion-bubble');
  await render({ bubble: { kind: 'reply', key: 'd1', text: 'Fixed the build.\nAll tests pass.' } });
  const bubble = $('.skin-companion-bubble');
  assert.equal(bubble, dots, 'the same anchored bubble takes over');
  assert.equal(bubble.getAttribute('role'), 'button', 'a button that closes the reply');
  assert.equal(bubble.getAttribute('title'), null);
  assert.equal(bubble.dataset.state, 'reply');
  assert.equal(status.querySelector('.sr-only').textContent, 'Companion: Mixy replied');
  assert.equal(
    $('.skin-companion-reply').textContent,
    'Fixed the build. All tests pass.',
    'markdown: a soft break is a space'
  );
  assert.equal(bubble.querySelector('svg, .skin-companion-mark, .skin-companion-check'), null, 'no decoration');
  await act(async () => bubble.click());
  assert.equal(calls.open, 0, 'a bubble click never opens the chat');
  assert.equal($('.skin-companion-quick'), null, 'nor the quick message');
  assert.deepEqual(calls.dismiss, ['d1'], 'it closes the reply');
  // Collapsed: only the pet.
  await render({ collapsed: true });
  assert.equal($('.skin-companion-bubble'), null);
  assert.ok($('.skin-companion-pet'));
});

test('reply text reads like the app: 13.5px/1.6 type; a short and a paged reply fit the 336px window at 50/100/200%', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => new RegExp(`\\n${selector.replace(/[.[\]"=>+*]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)[1];
  assert.doesNotMatch(css, /line-clamp|data-long|data-more|reply-tools/, 'no cut, scrolling or floating plate');
  const bubble = rule('.skin-companion-bubble');
  assert.match(bubble, /font-size:\s*13\.5px/);
  assert.match(bubble, /line-height:\s*1\.6/);
  assert.match(bubble, /letter-spacing:\s*normal/);
  assert.match(bubble, /color:\s*var\(--mx-text\)/);
  assert.match(bubble, /word-break:\s*keep-all/);
  assert.match(bubble, /overflow-wrap:\s*anywhere/);
  // 320px at most, narrower to fit its span (--bubble-max); paged: the span's width.
  assert.match(bubble, /max-width:\s*min\(320px, var\(--bubble-max, 320px\)\)/);
  assert.match(rule('.skin-companion-bubble[data-paged]'), /width:\s*var\(--bubble-max, calc\(100vw - 32px\)\)/);
  const capOf = (body) =>
    /max-height:\s*min\(140\.4px,\s*calc\(100vh - (\d+)px - var\(--pet-size, 56px\)\)\)/.exec(body);
  const shortCap = capOf(rule('.skin-companion-reply'));
  const page = rule('.skin-companion-page');
  const pageCap = capOf(page);
  assert.ok(shortCap && pageCap, 'both within the height budget and the window');
  assert.doesNotMatch(page, /font-size|padding/, 'the same type as any reply');
  assert.match(page, /overflow:\s*hidden/, 'a page never scrolls');
  assert.match(rule('.skin-companion-reply-bar'), /height:\s*24px/);
  assert.match(rule('.skin-companion-reply-tool'), /width:\s*24px;[\s\S]*height:\s*24px/);
  assert.match(rule('.skin-companion-pages'), /height:\s*8px/);
  const { desktopPetGeometry } = await import('../shared/desktop-pet.ts');
  const heights = {};
  const budgets = {};
  for (const scale of [50, 100, 200]) {
    const { window: room, sprite } = desktopPetGeometry(scale);
    heights[scale] = room.height;
    const below = 8 + sprite.size + 40 + 6 + 14;
    const short = Math.min(140.4, room.height - Number(shortCap[1]) - sprite.size);
    assert.ok(below + short <= room.height, `${scale}%: a short reply stays in the window`);
    // The bar (24px + 4px gap), a page and its dots (8px + 4px gap), with the bot hopped up.
    const paged = Math.min(140.4, room.height - Number(pageCap[1]) - sprite.size);
    assert.ok(below + 28 + paged + 12 <= room.height, `${scale}%: the paged bubble stays in the window`);
    budgets[scale] = Math.round(paged);
  }
  assert.deepEqual(heights, { 50: 336, 100: 336, 200: 336 }, 'the window never grows');
  assert.deepEqual(budgets, { 50: 140, 100: 140, 200: 116 }, 'a page height budget (px)');
});

test("the reply's markdown becomes compact blocks: paragraphs, bold, code, lists; headings bold; code and tables as text", async () => {
  const { replyBlocks } = await import('./skin-companion-paging.ts');
  const blocks = replyBlocks(
    '# Done\n\nIt **built** the `app` and [the docs](https://x.test).\n\n- one\n- two\n  1. nested\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted'
  );
  assert.deepEqual(
    blocks.map((block) => [
      block.kind,
      block.runs.map((run) => run.text).join(''),
      block.marker ?? '',
      block.depth ?? 0,
    ]),
    [
      ['p', 'Done', '', 0],
      ['p', 'It built the app and the docs.', '', 0],
      ['li', 'one', '•', 0],
      ['li', 'two', '•', 0],
      ['li', 'nested', '1.', 1],
      ['pre', 'const a = 1;', '', 0],
      ['pre', 'a · b\n1 · 2', '', 0],
      ['p', 'quoted', '', 0],
    ]
  );
  assert.equal(blocks[0].runs[0].strong, true, 'a heading is a bold paragraph');
  assert.deepEqual(
    blocks[1].runs.map((run) => [run.text, Boolean(run.strong), Boolean(run.code)]),
    [
      ['It ', false, false],
      ['built', true, false],
      [' the ', false, false],
      ['app', false, true],
      [' and ', false, false],
      ['the docs', false, false],
      ['.', false, false],
    ]
  );
  assert.equal(blocks.at(-1).quote, true);
});

test('pages fill the budget, ending at a sentence, else a word; a block moves whole once the page holds half', async () => {
  const { splitReplyPages, replyBlocks, blockText, pageReadMs } = await import('./skin-companion-paging.ts');
  // Ten characters a line, eight lines a page here (Chrome measures the real one).
  const height = (blocks) =>
    blocks.reduce((sum, block) => sum + Math.max(1, Math.ceil(blockText(block).length / 10)), 0);
  const measure = { fits: (blocks) => height(blocks) <= 8, half: (blocks) => height(blocks) >= 4 };
  const split = (markdown) => splitReplyPages(replyBlocks(markdown), measure).map((page) => page.text);
  assert.deepEqual(split('One short.\n\nTwo short.'), ['One short.\nTwo short.']);
  // Half full: a paragraph that does not fully fit moves whole.
  const four = `${'a'.repeat(9)}. ${'b'.repeat(28)}.`;
  const five = 'Ccccccccc. Ddddddddd. Eeeeeeeee. Fffffffff. Ggggggggg.';
  assert.deepEqual(split(`${four}\n\n${five}`), [four, five]);
  // Under half: it continues there, the page ending at its last sentence that fits.
  const long = `${five} Hhhhhhhhh. Iiiiiiiii. Jjjjjjjjj.`;
  const filled = split(`Intro hi.\n\n${long}`);
  assert.ok(filled.length === 2 && filled[0].startsWith('Intro hi.\nCcccccccc.'), JSON.stringify(filled));
  assert.ok(
    filled.every((page) => page.endsWith('.')),
    'whole sentences'
  );
  // A list item moves whole too, and a continued one has no second marker.
  const items = splitReplyPages(replyBlocks(`${four}\n\n- ${five}`), measure);
  assert.deepEqual(
    items.map((page) => page.blocks.map((block) => block.marker ?? '')),
    [[''], ['•']]
  );
  // No sentence end fits: the last word; a word wider than a page, its characters.
  const words = split(
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
  );
  assert.equal(words.length, 2);
  assert.equal(
    words.join(' '),
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
  );
  assert.ok(split('x'.repeat(170)).every((page) => page.length <= 80));
  assert.equal(pageReadMs('short'), 2500, 'at least 2.5 s');
  assert.equal(pageReadMs('가'.repeat(140)), 10000, 'fourteen characters a second');
});

test('in Chrome: paragraph gap and lists render, a long path wraps, pages fit the budget at 50/100/200%', async (t) => {
  const { build } = await import('esbuild');
  const { default: puppeteer } = await import('puppeteer-core');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { desktopPetGeometry } = await import('../shared/desktop-pet.ts');
  const bundle = await build({
    stdin: {
      contents: `
        import { measureReplyPages, renderReplyBlocks, replyBlocks } from './skin-companion-paging.ts';
        const root = () => document.querySelector('.skin-companion');
        // A bubble showing blocks; paged: the long bubble's page.
        const show = (blocks, paged) => {
          const bubble = document.createElement('div');
          bubble.className = 'skin-companion-bubble';
          if (paged) bubble.dataset.paged = 'true';
          const body = document.createElement('div');
          body.className = (paged ? 'skin-companion-page' : 'skin-companion-reply') + ' skin-companion-md';
          body.append(renderReplyBlocks(document, blocks));
          bubble.append(body);
          root().append(bubble);
          return { bubble, body };
        };
        window.__pages = (markdown) => measureReplyPages(root(), markdown).map((page) => {
          const { bubble, body } = show(page.blocks, true);
          const out = { text: page.text, fits: body.scrollHeight <= body.clientHeight + 1, height: body.scrollHeight, budget: parseFloat(getComputedStyle(body).maxHeight), lastKind: page.blocks.at(-1).kind };
          bubble.remove();
          return out;
        });
        window.__layout = (markdown) => {
          const { bubble, body } = show(replyBlocks(markdown), false);
          const boxes = [...body.children].map((child) => { const box = child.getBoundingClientRect(); return { cls: child.className, top: box.top, bottom: box.bottom, left: box.left, pad: getComputedStyle(child).paddingLeft, mark: child.querySelector('.skin-companion-md-mark')?.textContent ?? '' }; });
          const out = { boxes, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, bubbleWidth: bubble.getBoundingClientRect().width };
          bubble.remove();
          return out;
        };
      `,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
  });
  const css = readFileSync(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const paragraph = (n) =>
    `Paragraph ${n} says a few things about the build. It passed on every platform we tried today, and the slow tests finished too.`;
  const markdown = [1, 2, 3, 4, 5].map(paragraph).join('\n\n');
  for (const scale of [50, 100, 200]) {
    const { window: room, sprite } = desktopPetGeometry(scale);
    await page.setViewport({ width: room.width, height: room.height });
    await page.setContent(`<!doctype html><html style="--pet-size:${sprite.size}px"><head><style>
      body { margin: 0; font-family: sans-serif; }
      ${css}
    </style></head><body><div class="skin-companion"></div></body></html>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    // Paragraphs 8px apart; list items 4px, indented 16px, with their markers.
    const layout = await page.evaluate((md) => window.__layout(md), 'One.\n\nTwo.\n\n- a\n- b');
    const [one, two, a, b] = layout.boxes;
    assert.equal(Math.round(two.top - one.bottom), 8, `${scale}%: paragraph gap`);
    assert.equal(Math.round(b.top - a.bottom), 4, `${scale}%: list item gap`);
    assert.equal(a.pad, '16px');
    assert.deepEqual([a.mark, b.mark], ['•', '•']);
    // A long path wraps inside the bubble.
    const path = await page.evaluate(
      (md) => window.__layout(md),
      'See C:/Project/mixdog/apps/desktop/src/renderer/a-really-long-folder-name/another-long-folder-name/skin-companion-paging.ts now.'
    );
    assert.ok(
      path.scrollWidth <= path.clientWidth,
      `${scale}%: the path wraps (${path.scrollWidth} > ${path.clientWidth})`
    );
    assert.ok(path.bubbleWidth <= 320, `${scale}%: within the short bubble`);
    // Pages: each fits the budget and ends at a paragraph or sentence end.
    const pages = await page.evaluate((md) => window.__pages(md), markdown);
    assert.ok(pages.length > 1, `${scale}%: paged (${pages.length})`);
    const flat = (value) => value.replace(/\s+/g, ' ');
    assert.equal(
      flat(pages.map((p) => p.text).join(' ')),
      flat(markdown.replace(/\n\n/g, ' ')),
      `${scale}%: nothing lost`
    );
    for (const [n, p] of pages.entries()) {
      assert.ok(p.fits && p.height <= p.budget + 1, `${scale}%: page ${n + 1} is ${p.height}px (budget ${p.budget})`);
      assert.ok(p.text.endsWith('.'), `${scale}%: page ${n + 1} ends at a sentence end`);
    }
  }
});

/** A pet whose replies overflow the short bubble; pages split at "|". */
async function mountPaged(t, props = {}) {
  const { replyBlocks, replyPage } = await import('./skin-companion-paging.ts');
  const mounted = await mountPet(t, {
    measurePages: (_anchor, text) => text.split('|').map((part) => replyPage(replyBlocks(part))),
    ...props,
  });
  const { window } = mounted;
  for (const [name, value] of [
    ['scrollHeight', 400],
    ['clientHeight', 140],
  ]) {
    Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => value });
    t.after(() => delete window.HTMLElement.prototype[name]);
  }
  const clock = fakeClock(globalThis.window);
  const page = () => mounted.$('.skin-companion-page')?.textContent;
  const dots = () =>
    [...mounted.document.querySelectorAll('.skin-companion-pages i')].map((dot) => dot.dataset.page ?? '');
  return { ...mounted, clock, page, dots };
}
const PAGED = 'First page.|Second page.|Third page.';

/** jsdom has no layout: the balloon starts at `left` (window px) and the
 *  bubble is `width()` wide (the CSS cap applied by the caller's model). */
function stubBubbleBox(t, window, left, width) {
  const proto = window.HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () {
    return this.classList.contains('skin-companion-balloon')
      ? { left, right: left, top: 0, bottom: 0, width: 0, height: 0, x: left, y: 0 }
      : rect.call(this);
  };
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get() {
      return this.classList.contains('skin-companion-bubble') ? width(this) : 0;
    },
  });
  t.after(() => {
    proto.getBoundingClientRect = rect;
    delete proto.offsetWidth;
  });
}

/** The bubble's laid-out left/right edges: the balloon's left plus its shift. */
function bubbleEdges($, left, width) {
  const bubble = $('.skin-companion-bubble');
  const shift = Number.parseFloat(bubble.style.getPropertyValue('--bubble-shift') || '0');
  return { left: left + shift, right: left + shift + width };
}

test("a reply stays 16px inside its span (the app window's content), not the pet window, on both sides", async (t) => {
  const { $, render, window } = await mountPet(t);
  const head = 136;
  stubBubbleBox(t, window, head, () => 240);
  // The app window ends 300px into the pet window: moved left by the overflow.
  await render({ bubble: { kind: 'reply', key: 's1', text: 'A reply.' }, bubbleSpan: { left: 0, right: 300 } });
  assert.deepEqual(bubbleEdges($, head, 240), { left: 44, right: 284 }, 'right = span right - 16');
  // Its left edge near the head: moved right, tail kept on the head (the shift is undone for it).
  await render({ bubbleSpan: { left: 140, right: 600 } });
  assert.deepEqual(bubbleEdges($, head, 240), { left: 156, right: 396 });
  // Room enough: no shift.
  await render({ bubbleSpan: { left: 0, right: 600 } });
  assert.equal($('.skin-companion-bubble').style.getPropertyValue('--bubble-shift'), '');
  // No span yet: the window's own edges.
  await render({ bubbleSpan: undefined });
  assert.equal($('.skin-companion').style.getPropertyValue('--bubble-max'), '');
});

test('a span narrower than the bubble caps its width (shared with the page measure) and keeps both margins', async (t) => {
  const measured = [];
  const { $, render, window } = await mountPaged(t, {
    measurePages: (anchor, text) => {
      measured.push(anchor.closest('.skin-companion').style.getPropertyValue('--bubble-max'));
      return text.split('|').map((part) => ({ text: part, blocks: [] }));
    },
  });
  const head = 136;
  const cap = () => Number.parseFloat($('.skin-companion').style.getPropertyValue('--bubble-max'));
  // As the sheet: a paged bubble is the cap wide, a short one at most 320px.
  stubBubbleBox(t, window, head, (bubble) => (bubble.dataset.paged ? cap() : Math.min(320, cap())));
  await render({ bubble: { kind: 'reply', key: 'n1', text: 'A reply.' }, bubbleSpan: { left: 100, right: 250 } });
  assert.equal(cap(), 118, '150 - 2 x 16');
  assert.deepEqual(bubbleEdges($, head, 118), { left: 116, right: 234 });
  // A paged reply is measured at the cap, and again when the span changes.
  await render({ bubble: { kind: 'reply', key: 'n2', text: PAGED }, bubbleSpan: { left: 0, right: 300 } });
  assert.equal($('.skin-companion-bubble').dataset.paged, 'true');
  await render({ bubbleSpan: { left: 0, right: 400 } });
  assert.deepEqual(measured, ['118px', '268px', '368px']);
  assert.deepEqual(bubbleEdges($, head, 368), { left: 16, right: 384 });
});

test('a long reply shows page by page: dots, click and arrows turn, the last page closes it', async (t) => {
  const { $, render, page, dots, key, calls, window } = await mountPaged(t, { name: 'Mixy' });
  await render({ bubble: { kind: 'reply', key: 'p1', text: PAGED } });
  const bubble = $('.skin-companion-bubble');
  assert.equal(bubble.dataset.paged, 'true');
  assert.equal(bubble.getAttribute('role'), 'group');
  assert.equal(bubble.getAttribute('tabindex'), '0');
  assert.equal(page(), 'First page.');
  assert.deepEqual(dots(), ['on', '', '']);
  assert.equal($('.skin-companion-reply'), null, 'no scrolling text');
  // The bar: the name, Copy and Close; no open-in-app.
  assert.equal($('.skin-companion-reply-name').textContent, 'Mixy');
  const tools = [...document.querySelectorAll('.skin-companion-reply-bar button')];
  assert.deepEqual(
    tools.map((button) => button.getAttribute('aria-label')),
    ['Copy', 'Close']
  );
  await act(async () => bubble.click());
  assert.equal(page(), 'Second page.');
  assert.deepEqual(dots(), ['done', 'on', '']);
  await key(bubble, { key: 'ArrowLeft' });
  assert.equal(page(), 'First page.');
  await key(bubble, { key: 'ArrowRight' });
  await key(bubble, { key: 'ArrowRight' });
  assert.equal(page(), 'Third page.');
  await key(bubble, { key: 'ArrowRight' });
  assert.equal(page(), 'Third page.', 'the last page stays');
  assert.equal($('.skin-companion-quick'), null);
  assert.deepEqual(calls.dismiss, [], 'turning pages never closes it');
  await key(bubble, { key: 'Enter' });
  assert.deepEqual(calls.dismiss, ['p1'], 'Enter on the last page closes it');
  assert.equal($('.skin-companion-quick'), null, 'never the quick message');
  // A click on the last page closes it too; before it, a click only turns.
  await render({ bubble: { kind: 'reply', key: 'p2', text: 'Only.|Last.' } });
  await act(async () => $('.skin-companion-bubble').click());
  assert.deepEqual(calls.dismiss, ['p1']);
  // Copy: the whole reply (main writes it); the click turns no page and closes nothing.
  await act(async () => $('.skin-companion-reply-copy').click());
  assert.deepEqual(calls.copy, ['p2']);
  assert.equal(page(), 'Last.');
  assert.deepEqual(calls.dismiss, ['p1']);
  await act(async () => $('.skin-companion-bubble').click());
  assert.deepEqual(calls.dismiss, ['p1', 'p2']);
  assert.equal($('.skin-companion-quick'), null);
  // ✕ and Esc close.
  await act(async () => $('.skin-companion-reply-close').click());
  assert.deepEqual(calls.dismiss.at(-1), 'p2');
  await render({ bubble: { kind: 'reply', key: 'p3', text: PAGED } });
  await act(async () =>
    $('.skin-companion-bubble').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  );
  assert.equal(calls.dismiss.at(-1), 'p3');
});

test('Enter on the last page\'s Copy or Close button is the button\'s, not the bubble\'s: the reply stays open and Copy runs', async (t) => {
  const { $, render, page, calls, window } = await mountPaged(t, { name: 'Mixy' });
  await render({ bubble: { kind: 'reply', key: 'k1', text: 'Only.|Last.' } });
  await act(async () => $('.skin-companion-bubble').click());
  assert.equal(page(), 'Last.');
  const copy = $('.skin-companion-reply-copy');
  let enter;
  await act(async () => {
    enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    copy.dispatchEvent(enter);
  });
  assert.equal(enter.defaultPrevented, false, 'the browser still activates the focused button');
  assert.deepEqual(calls.dismiss, [], 'the reply is not closed');
  // The activation the browser then performs (a click) copies the whole reply.
  await act(async () => copy.click());
  assert.deepEqual(calls.copy, ['k1']);
  assert.deepEqual(calls.dismiss, []);
  // Enter on the bubble itself still closes the last page.
  await act(async () =>
    $('.skin-companion-bubble').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
  );
  assert.deepEqual(calls.dismiss, ['k1']);
});

test('a short reply: a click closes it (never the chat or the quick message), no bar or dots', async (t) => {
  const { $, render, calls } = await mountPet(t, { measurePages: () => assert.fail('a short reply is not paged') });
  await render({ bubble: { kind: 'reply', key: 's1', text: 'Done.' } });
  assert.equal($('.skin-companion-bubble').getAttribute('role'), 'button');
  assert.equal($('.skin-companion-reply-bar'), null);
  assert.equal($('.skin-companion-pages'), null);
  assert.deepEqual(calls.read, ['s1'], 'read on display, as before');
  await act(async () => $('.skin-companion-bubble').click());
  assert.equal(calls.open, 0);
  assert.equal($('.skin-companion-quick'), null);
  assert.deepEqual(calls.dismiss, ['s1'], 'a click closes it');
});

test('hidden under an app modal (paused) and back, the quick message and the reply keep their state', async (t) => {
  const { $, mascot, render, calls } = await mountPet(t);
  await render({ bubble: { kind: 'reply', key: 'h1', text: 'Done.' } });
  await act(async () => mascot().click());
  const field = $('.skin-companion-quick textarea, .skin-companion-quick input');
  assert.ok(field);
  await render({ bubble: { kind: 'reply', key: 'h1', text: 'Done.' }, paused: true });
  await render({ bubble: { kind: 'reply', key: 'h1', text: 'Done.' }, paused: false });
  assert.equal($('.skin-companion-quick textarea, .skin-companion-quick input'), field, 'the same open field');
  assert.equal($('.skin-companion-reply').textContent, 'Done.');
  assert.deepEqual(calls.dismiss, []);
});

test('a short reply: Enter on the focused bubble closes it', async (t) => {
  const { $, render, calls } = await mountPet(t);
  await render({ bubble: { kind: 'reply', key: 'k1', text: 'Done.' } });
  await act(async () =>
    $('.skin-companion-bubble').dispatchEvent(
      new globalThis.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
  );
  assert.equal(calls.open, 0);
  assert.equal($('.skin-companion-quick'), null);
  assert.deepEqual(calls.dismiss, ['k1']);
});

test('pages turn at reading pace, pause under the pointer, restart on a turn by hand, and stop at the last', async (t) => {
  const { pageReadMs } = await import('./skin-companion-paging.ts');
  const { $, render, page, clock } = await mountPaged(t);
  const text = `${'가'.repeat(70)}|${'나'.repeat(140)}|끝.`;
  await render({ bubble: { kind: 'reply', key: 'a1', text } });
  assert.equal(pageReadMs('가'.repeat(70)), 5000, 'fourteen characters a second');
  const dot = () => $('.skin-companion-pages i[data-page="on"]');
  assert.equal(dot().style.getPropertyValue('--page-ms'), '5000ms', 'the current dot fills over its time');
  assert.equal($('.skin-companion-pages').dataset.timed, 'true');
  await clock.advance(4999);
  assert.equal(page(), '가'.repeat(70));
  await clock.advance(1);
  assert.equal(page(), '나'.repeat(140), 'turned after 5 s');
  // The pointer holds it (the dot's fill pauses); leaving resumes where it stopped.
  await clock.advance(4000);
  await act(async () =>
    $('.skin-companion-bubble').dispatchEvent(new globalThis.window.MouseEvent('pointerover', { bubbles: true }))
  );
  const bubble = $('.skin-companion-bubble');
  assert.equal(bubble.dataset.held, 'true');
  await clock.advance(60000);
  assert.equal(page(), '나'.repeat(140), 'held');
  await act(async () => bubble.dispatchEvent(new globalThis.window.Event('pointerout', { bubbles: true })));
  await clock.advance(5999);
  assert.equal(page(), '나'.repeat(140));
  await clock.advance(1);
  assert.equal(page(), '끝.', 'the rest of its 10 s');
  // The last page stays.
  await clock.advance(60000);
  assert.equal(page(), '끝.');
  // A turn by hand restarts that page's time.
  await render({ bubble: { kind: 'reply', key: 'a2', text } });
  await clock.advance(4000);
  await act(async () => $('.skin-companion-bubble').click());
  await act(async () => $('.skin-companion-bubble').blur());
  await clock.advance(9999);
  assert.equal(page(), '나'.repeat(140), 'its full 10 s again');
  await clock.advance(1);
  assert.equal(page(), '끝.');
  // Auto-advance off: no turn by itself, no filling dot.
  await render({ bubble: { kind: 'reply', key: 'a3', text }, autoAdvance: false });
  assert.equal($('.skin-companion-pages').dataset.timed, undefined);
  await clock.advance(60000);
  assert.equal(page(), '가'.repeat(70));
});

test('auto-close: a paged reply times out only after its last page; off, a reply stays until closed', async (t) => {
  const { replyHideMs } = await import('./skin-companion-pet.tsx');
  const { $, render, calls, clock } = await mountPaged(t);
  await render({ bubble: { kind: 'reply', key: 'c1', text: 'One.|Two.' } });
  await clock.advance(2500);
  assert.equal($('.skin-companion-page').textContent, 'Two.');
  // The last page's own time, then the usual timeout (reduced motion: at once).
  await clock.advance(2500);
  await clock.advance(replyHideMs('Two.') - 1);
  assert.deepEqual(calls.dismiss, []);
  await clock.advance(1);
  assert.deepEqual(calls.dismiss, ['c1']);
  // Read by hand to the end: the same.
  await render({ bubble: { kind: 'reply', key: 'c2', text: 'One.|Two.' }, autoAdvance: false });
  await clock.advance(60000);
  assert.deepEqual(calls.dismiss, ['c1'], 'never past page one: stays');
  // Off: no timeout at all, short or long.
  await render({ bubble: { kind: 'reply', key: 'c3', text: 'One.|Two.' }, autoAdvance: true, autoClose: false });
  await clock.advance(600000);
  assert.deepEqual(calls.dismiss, ['c1']);
  await act(async () => $('.skin-companion-reply-close').click());
  assert.deepEqual(calls.dismiss, ['c1', 'c3'], '✕ still closes');
});

test('a reply counts as read once its end is shown: a short one at once, a long one at its last page, not when closed early', async (t) => {
  const { $, render, calls, clock } = await mountPaged(t);
  await render({ bubble: { kind: 'reply', key: 'r1', text: 'One.|Two.|Three.' } });
  assert.deepEqual(calls.read, [], 'page one only');
  await act(async () => $('.skin-companion-reply-close').click());
  assert.deepEqual(calls.read, [], 'closed before its last page: unread');
  // Read to the end by auto-advance.
  await render({ bubble: { kind: 'reply', key: 'r2', text: 'One.|Two.' } });
  await clock.advance(2500);
  assert.deepEqual(calls.read, ['r2']);
  // By hand.
  await render({ bubble: { kind: 'reply', key: 'r3', text: 'One.|Two.' } });
  await act(async () => $('.skin-companion-bubble').click());
  assert.deepEqual(calls.read, ['r2', 'r3']);
  // Off screen or collapsed: not shown, not read.
  await render({ bubble: { kind: 'reply', key: 'r4', text: 'Only.' }, paused: true });
  assert.deepEqual(calls.read, ['r2', 'r3']);
  await render({ paused: false });
  assert.deepEqual(calls.read, ['r2', 'r3', 'r4'], 'a one-page reply is read as it shows');
});

test('a short reply counts as read as soon as it shows', async (t) => {
  const { render, calls } = await mountPet(t);
  await render({ bubble: { kind: 'reply', key: 'short', text: 'Done.' } });
  assert.deepEqual(calls.read, ['short']);
  await render({ bubble: { kind: 'reply', key: 'hidden', text: 'Later.' }, collapsed: true });
  assert.deepEqual(calls.read, ['short']);
});

test('the quick message keeps a paged reply and its page; a send replaces it with the dots, then the new reply', async (t) => {
  const { $, mascot, render, typeInto, calls, page } = await mountPaged(t);
  await render({ bubble: { kind: 'reply', key: 'q1', text: PAGED } });
  await act(async () => $('.skin-companion-bubble').click());
  assert.equal(page(), 'Second page.');
  await act(async () => mascot().click());
  assert.ok($('.skin-companion-quick input'), 'the quick message is open');
  assert.equal(page(), 'Second page.', 'the same page');
  assert.deepEqual(calls.dismiss, []);
  await typeInto($('.skin-companion-quick input'), 'and then?');
  await act(async () => $('.skin-companion-quick').requestSubmit());
  assert.deepEqual(calls.send, ['and then?']);
  await render({ bubble: { kind: 'working' } });
  assert.equal($('.skin-companion-page'), null, 'the typing dots replace it');
  assert.equal($('.skin-companion-bubble').dataset.state, 'working');
  await render({ bubble: { kind: 'reply', key: 'q2', text: 'Then this.|And that.' } });
  assert.equal(page(), 'Then this.');
  assert.ok($('.skin-companion-quick input'), 'still open for the next line');
});
test('a click unfolds the quick message and the pet hops onto it; a send keeps it open, cleared and focused', async (t) => {
  const { $, pet, mascot, calls, typeInto, key, window } = await mountPet(t);
  assert.equal(mascot().getAttribute('aria-expanded'), 'false');
  assert.equal(pet().dataset.quick, undefined);
  await act(async () => mascot().click());
  assert.equal(mascot().getAttribute('aria-expanded'), 'true');
  assert.equal(pet().dataset.quick, 'true', 'the hop (CSS) keys off data-quick');
  assert.deepEqual(calls.focus, [true], 'the window takes keyboard focus');
  const input = $('.skin-companion-quick input');
  assert.equal(window.document.activeElement, input);
  await act(async () => $('.skin-companion-quick').requestSubmit());
  assert.equal(calls.send.length, 0, 'an empty input sends nothing');
  await typeInto(input, '  ship it  ');
  await act(async () => $('.skin-companion-quick').requestSubmit());
  assert.deepEqual(calls.send, ['ship it']);
  assert.equal($('.skin-companion-quick input'), input, 'sent: still open');
  assert.equal(input.value, '', 'cleared');
  assert.equal(window.document.activeElement, input, 'and focused for the next line');
  assert.equal(pet().dataset.quick, 'true');
  assert.deepEqual(calls.focus, [true], 'the window keeps the keys');
  await typeInto(input, 'and test it');
  await act(async () => $('.skin-companion-quick').requestSubmit());
  assert.deepEqual(calls.send, ['ship it', 'and test it'], 'the next line sends too');
  await key(input, { key: 'Escape' });
  assert.equal($('.skin-companion-quick'), null, 'Esc closes it');
  assert.equal(pet().dataset.quick, undefined, 'and dropped back');
  assert.deepEqual(calls.focus, [true, false]);
  assert.equal(window.document.activeElement, mascot(), 'focus returns to the pet');
});

test('Esc and the window losing focus close the quick message; Enter on the pet opens it', async (t) => {
  const { $, mascot, render, key, window } = await mountPet(t);
  mascot().focus();
  // Enter on a focused button is its keyboard click (detail 0).
  await act(async () => mascot().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })));
  const input = $('.skin-companion-quick input');
  assert.ok(input);
  await key(input, { key: 'Escape' });
  assert.equal($('.skin-companion-quick'), null);
  assert.equal(window.document.activeElement, mascot());
  await act(async () => mascot().click());
  assert.ok($('.skin-companion-quick'));
  await render({ blurSignal: 1 });
  assert.equal($('.skin-companion-quick'), null, 'blur closes it');
});

test('focus returns to the pet with a ring only for keyboard users: no box after a mouse open', async (t) => {
  const { $, mascot, key, window } = await mountPet(t);
  const options = [];
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function (opts) {
    if (this === mascot()) options.push(opts?.focusVisible);
    return focus.call(this, opts);
  };
  t.after(() => {
    window.HTMLElement.prototype.focus = focus;
  });
  const click = (detail) =>
    act(async () => mascot().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail })));
  // Mouse: open, type, Esc (keyboard keys after a pointer open).
  await click(1);
  await key($('.skin-companion-quick input'), { key: 'Escape' });
  assert.deepEqual(options, [false], 'a mouse user gets no ring around the pet');
  // Keyboard: Enter on the pet (detail 0), then Esc.
  await click(0);
  await key($('.skin-companion-quick input'), { key: 'Escape' });
  assert.deepEqual(options, [false, true], 'a keyboard user keeps the ring');
});

test('the overlay window claims the pointer over the bot only; a system focus hands the keys to the bot', async (t) => {
  const dom = installTestDom(t, {
    expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'],
    actEnvironment: false,
  });
  const calls = { interactive: [], focusInput: [] };
  const noop = () => {};
  let readied = false;
  dom.window.mixdogPet = {
    onView: () => noop,
    onBlurred: () => noop,
    ready: () => {
      readied = true;
    },
    painted: noop,
    send: async () => true,
    open: noop,
    command: noop,
    area: noop,
    drag: noop,
    nudge: noop,
    reset: noop,
    interactive: (on) => calls.interactive.push(on),
    focusInput: (open) => calls.focusInput.push(open),
  };
  await import('./desktop-pet-main');
  const $ = (selector) => dom.document.querySelector(selector);
  // The pointer listeners attach in the same effect pass that calls ready(),
  // after the first paint: on a slow runner the bot shows before them.
  for (let wait = 0; wait < 200 && (!$('.skin-companion-pet') || !readied); wait += 1)
    await new Promise((r) => setTimeout(r, 10));
  const bot = $('.skin-companion-pet');
  assert.ok(bot && readied, 'the overlay drew the bot and attached its listeners');
  const move = (target) =>
    target.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 256, clientY: 176 }));
  // A forwarded move over the bot claims the pointer; over the empty window it passes through again.
  move(bot);
  assert.deepEqual(calls.interactive, [true]);
  move($('.skin-companion'));
  assert.deepEqual(calls.interactive, [true, false]);
  // Focused by the system with nothing focused inside: the bot takes the keys.
  assert.equal(dom.document.activeElement, dom.document.body);
  const root = dom.document.documentElement;
  dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  assert.equal(dom.document.activeElement, bot, 'Shift+F10 / Enter reach the bot');
  // ...without a ring: that focus was a script's, the key that switched windows was pressed elsewhere.
  assert.equal(root.dataset.petKeys, undefined, 'no ring on a window focus');
  // A real key in the overlay shows it; a press hides it again. (Shift+F10 on
  // the document: on the bot it would open the menu after this test ends.)
  dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
  assert.equal(root.dataset.petKeys, 'true', 'Shift+F10: ring');
  bot.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(root.dataset.petKeys, undefined, 'a press: no ring');
  bot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  assert.equal(root.dataset.petKeys, 'true', 'Enter: ring');
});

test('app layers over the pet are cut out of all it draws (#root clip-path), and the pointer there passes through', async (t) => {
  const dom = installTestDom(t, {
    expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'],
    actEnvironment: false,
  });
  const calls = { interactive: [], focusInput: [] };
  let showView = null;
  const noop = () => {};
  dom.window.mixdogPet = {
    onView: (listener) => {
      showView = listener;
      return noop;
    },
    onBlurred: () => noop,
    ready: noop,
    painted: noop,
    send: async () => true,
    open: noop,
    command: noop,
    area: noop,
    drag: noop,
    nudge: noop,
    reset: noop,
    read: noop,
    copy: noop,
    interactive: (on) => calls.interactive.push(on),
    focusInput: (open) => calls.focusInput.push(open),
  };
  const { flushSync } = await import('react-dom');
  // A fresh module instance: this test mounts its own overlay page.
  await import(`./desktop-pet-main.tsx?cutouts=${Date.now()}`);
  const $ = (selector) => dom.document.querySelector(selector);
  // The page subscribes to its view in an effect, after the first paint: wait for that too,
  // or a view sent earlier is lost on a slow runner.
  for (let wait = 0; wait < 200 && (!$('.skin-companion-pet') || !showView); wait += 1)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(showView, 'the page subscribed to its view');
  const html = dom.document.documentElement;
  const view = {
    sessionId: 's1',
    bubble: { kind: 'reply', key: 'r1', text: 'Hello.' },
    face: { room: false, members: [] },
    quiet: false,
    collapsed: false,
    keepAbove: false,
    pinned: true,
    theme: null,
    visible: true,
    scale: 100,
    screenRight: 512,
    bubbleSpan: { left: 0, right: 512 },
  };
  const show = async (cutouts) => {
    flushSync(() => showView({ ...view, cutouts }));
    await new Promise((r) => setTimeout(r, 0));
  };
  await show([]);
  assert.equal(html.style.getPropertyValue('--pet-clip'), '', 'nothing over it: no clip');
  // #root clips with it, and holds all the pet draws: the sprite and the bubble (the quick message and menu too).
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  assert.match(css, /#root \{[^}]*clip-path: var\(--pet-clip, none\);/);
  const rootNode = dom.document.getElementById('root');
  // The reply bubble mounts once the view has been applied; a slow runner may need a few more turns.
  for (let wait = 0; wait < 100 && !$('.skin-companion-bubble'); wait += 1) await new Promise((r) => setTimeout(r, 10));
  const bot = $('.skin-companion-pet');
  const bubble = $('.skin-companion-bubble');
  assert.ok(bot && bubble, 'the sprite and the reply bubble are drawn');
  assert.ok(rootNode.contains(bot) && rootNode.contains(bubble));
  // A tooltip over the sprite (228–284 × 244–300), the model menu over the bubble, and a popover overlapping the tooltip.
  const tooltip = { x: 240, y: 250, width: 30, height: 30 };
  const menu = { x: 100, y: 0, width: 200, height: 150 };
  const popover = { x: 250, y: 260, width: 40, height: 40 };
  await show([tooltip, menu, popover]);
  const clip = html.style.getPropertyValue('--pet-clip');
  assert.ok(clip.startsWith('path(evenodd, "M-1 -1H99999V99999H-1z'), clip);
  // The holes (even-odd) are disjoint and cover the three layers' union, overlap counted once.
  const holes = [...clip.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-\d+z/g)].map(([, x, y, w, h]) => ({
    x: +x,
    y: +y,
    width: +w,
    height: +h,
  }));
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  for (const [i, a] of holes.entries()) for (const b of holes.slice(i + 1)) assert.equal(overlap(a, b), 0);
  const area = holes.reduce((sum, hole) => sum + hole.width * hole.height, 0);
  assert.equal(area, 900 + 30000 + 1600 - overlap(tooltip, popover));
  const at = (target, type, x, y) =>
    target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  // Over the sprite inside a cut: not claimed, a press is not the pet's.
  at(bot, 'mousemove', 255, 270);
  at(bot, 'pointerdown', 255, 270);
  // Over the bubble inside the menu's cut: not claimed either.
  at(bubble, 'mousemove', 150, 100);
  assert.deepEqual(calls.interactive, []);
  assert.deepEqual(calls.focusInput, []);
  // Over the sprite outside every cut: the pet's.
  at(bot, 'mousemove', 232, 296);
  assert.deepEqual(calls.interactive, [true]);
  // A layer opens under the resting pointer: passed on at once; it closes: the pet's again.
  await show([{ x: 0, y: 0, width: 512, height: 336 }]);
  assert.deepEqual(calls.interactive, [true, false]);
  await show([]);
  assert.deepEqual(calls.interactive, [true, false, true]);
  assert.equal(html.style.getPropertyValue('--pet-clip'), '');
  // The page's "painted" handshake waits two animation frames; let them run
  // before the test's DOM (and its frame clock) is torn down.
  await new Promise((r) => setTimeout(r, 100));
});

test('a picture face (#178): an empty box while it loads, the picture once read, the mascot only if it cannot be read', async (t) => {
  const dom = installTestDom(t, {
    expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'],
    actEnvironment: false,
  });
  let showView = null;
  const asked = [];
  const noop = () => {};
  dom.window.mixdogPet = {
    onView: (listener) => {
      showView = listener;
      return noop;
    },
    onBlurred: () => noop,
    ready: noop,
    painted: noop,
    send: async () => true,
    open: noop,
    command: noop,
    area: noop,
    drag: noop,
    nudge: noop,
    reset: noop,
    read: noop,
    copy: noop,
    interactive: noop,
    focusInput: noop,
    avatarImage: (id) =>
      new Promise((resolve, reject) => {
        asked.push({ id, resolve, reject });
      }),
  };
  const { flushSync } = await import('react-dom');
  await import(`./desktop-pet-main.tsx?picture=${Date.now()}`);
  const $ = (selector) => dom.document.querySelector(selector);
  const turn = () => new Promise((r) => setTimeout(r, 10));
  for (let wait = 0; wait < 200 && (!$('.skin-companion-pet') || !showView); wait += 1) await turn();
  assert.ok(showView, 'the page subscribed to its view');
  const { MIXY_AGENT_ID: lead } = await import('../../../../src/runtime/agent/orchestrator/session/agent-home.mjs');
  const view = (idle) => ({
    sessionId: 's1',
    bubble: { kind: 'idle' },
    face: { room: false, members: [{ id: lead, name: '하치와레', avatar: { kind: 'custom', states: { idle } } }] },
    quiet: false,
    collapsed: false,
    keepAbove: false,
    pinned: true,
    theme: null,
    visible: true,
    scale: 100,
    screenRight: 512,
    bubbleSpan: { left: 0, right: 512 },
    cutouts: [],
  });
  const face = () => $('.skin-companion-pet .skin-companion-face');
  const feetGap = () => dom.document.documentElement.style.getPropertyValue('--pet-feet-gap');
  flushSync(() => showView(view('idle-0123456789ab.png')));
  for (let wait = 0; wait < 100 && !asked.length; wait += 1) await turn();
  assert.deepEqual(
    asked.map(({ id }) => id),
    [lead]
  );
  assert.ok(face(), 'the sprite box stands');
  assert.equal(face().children.length, 0, 'loading: nothing drawn (no mascot first)');
  assert.equal(feetGap(), '0', "loading: the picture face's geometry");
  asked[0].resolve({
    states: { idle: { file: 'idle-0123456789ab.png', url: 'data:image/png;base64,AAAA', poster: '' } },
  });
  for (let wait = 0; wait < 100 && !face()?.querySelector('img'); wait += 1) await turn();
  assert.equal(face().querySelector('img')?.getAttribute('src'), 'data:image/png;base64,AAAA', 'the picture');
  assert.equal(face().querySelector('svg'), null);
  // A new picture that cannot be read: empty while asked, then the mascot.
  flushSync(() => showView(view('idle-ffffffffffff.png')));
  for (let wait = 0; wait < 100 && asked.length < 2; wait += 1) await turn();
  assert.equal(face().children.length, 0, 'the new picture loading: nothing drawn');
  asked[1].reject(new Error('gone'));
  for (let wait = 0; wait < 100 && !face()?.querySelector('svg'); wait += 1) await turn();
  assert.ok(face().querySelector('svg'), 'unreadable: the mascot in its place');
  assert.equal(face().querySelector('img'), null);
  // A moving picture that decodes to nothing (zero size) cannot be read either: the mascot, not an empty image.
  const { HTMLCanvasElement } = dom.window;
  const realToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  const realImage = globalThis.Image;
  HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.Image = class {
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  };
  t.after(() => {
    HTMLCanvasElement.prototype.toDataURL = realToDataURL;
    HTMLCanvasElement.prototype.getContext = realGetContext;
    globalThis.Image = realImage;
  });
  flushSync(() => showView(view('idle-eeeeeeeeeeee.gif')));
  for (let wait = 0; wait < 100 && asked.length < 3; wait += 1) await turn();
  asked[2].resolve({
    states: { idle: { file: 'idle-eeeeeeeeeeee.gif', url: 'data:image/gif;base64,R0lGODlh', poster: '' } },
  });
  for (let wait = 0; wait < 100 && !face()?.querySelector('svg'); wait += 1) await turn();
  assert.ok(face().querySelector('svg'), 'zero-size decode: the mascot in its place');
  assert.equal(face().querySelector('img'), null);
  // #179: main's flip at the screen's top marks the page (desktop-pet.css html[data-pet-flipped]).
  const html = dom.document.documentElement;
  flushSync(() => showView({ ...view('idle-ffffffffffff.png'), flipped: true }));
  assert.equal(html.dataset.petFlipped, 'true');
  flushSync(() => showView({ ...view('idle-ffffffffffff.png'), flipped: false }));
  assert.equal(html.dataset.petFlipped, undefined);
  await new Promise((r) => setTimeout(r, 100));
});

test('flipped at the screen top (#179): the page marks it, and the bot stands at the top with all else below it', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `rule ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('html[data-pet-flipped] .skin-companion-stack'), /top: 8px;[\s\S]*bottom: auto;/);
  assert.match(rule('html[data-pet-flipped] .skin-companion[data-quick] .skin-companion-stack'), /transform: none;/);
  assert.match(rule('html[data-pet-flipped] .skin-companion-balloon'), /top: calc\(100% \+ 6px\);/);
  assert.match(rule('html[data-pet-flipped] .skin-companion-quick'), /top: calc\(14px \+ var\(--pet-size, 56px\)\);/);
  assert.match(rule('html[data-pet-flipped] .desktop-pet-menu'), /top: 4px;[\s\S]*bottom: auto;/);
});

test("the bot never draws a ring; the bubble's only for keyboard use, never by Chromium's :focus-visible guess", async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
    ([, selector, body]) => ({
      selector: selector.trim(),
      body,
    })
  );
  const ringed = rules.filter(
    ({ selector, body }) => /skin-companion-(pet|bubble)/.test(selector) && /outline:\s*2px/.test(body)
  );
  assert.deepEqual(
    ringed.map(({ selector }) => selector),
    ['html[data-pet-keys] .skin-companion-bubble:focus']
  );
  assert.ok(
    !rules.some(
      ({ selector, body }) => /\.skin-companion-pet\b/.test(selector) && /outline(-\w+)?:\s*(?!none\b)\S/.test(body)
    ),
    'no rule outlines the bot'
  );
  assert.ok(
    rules.some(
      ({ selector, body }) =>
        /\.skin-companion-pet(:focus|:is\([^)]*:focus\b)/.test(selector) &&
        !selector.includes('data-pet-keys') &&
        /outline:\s*none/.test(body)
    ),
    'otherwise no outline, whatever :focus-visible says'
  );
});

test('a refused quick message comes back into the input; no session, no input', async (t) => {
  const { $, mascot, render, typeInto } = await mountPet(t, { onSend: async () => false });
  await act(async () => mascot().click());
  await typeInto($('.skin-companion-quick input'), 'hello');
  await act(async () => $('.skin-companion-quick').requestSubmit());
  assert.equal($('.skin-companion-quick input').value, 'hello');
  await render({ canSend: false });
  assert.equal($('.skin-companion-quick'), null);
  assert.equal(mascot().hasAttribute('aria-expanded'), false);
  await act(async () => mascot().click());
  assert.equal($('.skin-companion-quick'), null);
});

/** A manual clock for the pet's window timers (jsdom's own timers are real). */
function fakeClock(window) {
  let now = 0;
  let next = 1;
  const timers = new Map();
  window.setTimeout = (fn, ms = 0) => {
    const id = next++;
    timers.set(id, { fn, at: now + ms });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  Object.defineProperty(window.performance, 'now', { configurable: true, value: () => now });
  return {
    pending: () => timers.size,
    advance: (ms) =>
      act(async () => {
        const end = now + ms;
        for (;;) {
          const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          timers.delete(due[0]);
          now = due[1].at;
          due[1].fn();
        }
        now = end;
      }),
  };
}

test('IME: Enter or Esc while composing neither sends nor closes; the committed syllable sends once', async (t) => {
  const { $, mascot, calls, typeInto, key, window } = await mountPet(t);
  await act(async () => mascot().click());
  const input = $('.skin-companion-quick input');
  const compose = (type) => act(async () => input.dispatchEvent(new window.CompositionEvent(type, { bubbles: true })));
  await compose('compositionstart');
  await typeInto(input, '안녀');
  await typeInto(input, '안녕');
  // The IME's commit key: keydown Enter (isComposing / keyCode 229).
  const enter = new window.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    isComposing: true,
  });
  await act(async () => input.dispatchEvent(enter));
  assert.equal(enter.defaultPrevented, true, 'no implicit submit while composing');
  await act(async () => $('.skin-companion-quick').requestSubmit());
  assert.deepEqual(calls.send, [], 'a submit mid-composition is ignored');
  await key(input, { key: 'Escape', isComposing: true });
  assert.ok($('.skin-companion-quick'), 'Esc cancelling the IME does not close the input');
  assert.equal(input.value, '안녕', 'the controlled value keeps the composition');
  await compose('compositionend');
  const plain = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(plain));
  assert.equal(plain.defaultPrevented, false, 'after the commit Enter submits as usual');
  await act(async () => $('.skin-companion-quick').requestSubmit());
  assert.deepEqual(calls.send, ['안녕'], 'the last syllable is neither dropped nor doubled');
  assert.equal(input.value, '', 'sent: cleared, still open for the next line');
  assert.equal(window.document.activeElement, input);
});

test('leaving the quick message clears the draft and dismisses the shown reply; a later reply shows', async (t) => {
  const { $, mascot, render, typeInto, key, calls } = await mountPet(t);
  fakeClock(globalThis.window);
  await render({ bubble: { kind: 'reply', key: 'd1', text: 'Done.' } });
  for (const leave of [
    (input) => key(input, { key: 'Escape' }),
    () => render({ blurSignal: Date.now() }),
    async (input) => {
      // A send is not leaving: the input and the reply stay until Esc.
      await typeInto(input, 'thanks');
      await act(async () => $('.skin-companion-quick').requestSubmit());
      assert.ok($('.skin-companion-quick'));
      assert.deepEqual(calls.dismiss, [], 'the reply stays on display while the input is open');
      assert.equal($('.skin-companion-reply').textContent, 'Done.');
      await key(input, { key: 'Escape' });
    },
  ]) {
    calls.dismiss.length = 0;
    await act(async () => mascot().click());
    await typeInto($('.skin-companion-quick input'), 'half typed');
    await leave($('.skin-companion-quick input'));
    assert.equal($('.skin-companion-quick'), null);
    assert.deepEqual(calls.dismiss, ['d1'], 'the reply on display is seen');
    await act(async () => mascot().click());
    assert.equal($('.skin-companion-quick input').value, '', 'reopening starts clean');
    await key($('.skin-companion-quick input'), { key: 'Escape' });
  }
  // A new reply arriving later is a new key: it shows.
  calls.dismiss.length = 0;
  await render({ bubble: { kind: 'reply', key: 'd2', text: 'Next.' } });
  assert.equal($('.skin-companion-reply').textContent, 'Next.');
  assert.deepEqual(calls.dismiss, []);
  assert.equal(calls.send.at(-1), 'thanks');
});

test('a reply auto-hides after 8 s plus a little per character (at most 20 s); hover and the input hold it', async (t) => {
  const { $, mascot, render, key, calls } = await mountPet(t);
  const { replyHideMs } = await import('./skin-companion-pet');
  assert.equal(replyHideMs(''), 8000);
  assert.equal(replyHideMs('a'.repeat(40)), 10000);
  assert.equal(replyHideMs('가'.repeat(10)), 8500, 'per character, not per UTF-16 unit');
  assert.equal(replyHideMs('a'.repeat(5000)), 20000, 'capped at 20 s');
  const clock = fakeClock(globalThis.window);
  // The symbols never time out.
  for (const kind of ['working', 'approval']) {
    await render({ bubble: { kind } });
    assert.equal(clock.pending(), 0);
    await clock.advance(60000);
    assert.ok($('.skin-companion-bubble'));
  }
  assert.deepEqual(calls.dismiss, []);
  // Reduced motion (jsdom has no matchMedia): dismissed at once, no fade.
  await render({ bubble: { kind: 'reply', key: 'd1', text: 'a'.repeat(40) } });
  await clock.advance(9999);
  assert.deepEqual(calls.dismiss, []);
  await clock.advance(1);
  assert.deepEqual(calls.dismiss, ['d1'], 'timed out: seen');
  // Hover pauses; leaving restarts the full time.
  await render({ bubble: { kind: 'reply', key: 'd2', text: '' } });
  const bubble = $('.skin-companion-bubble');
  await clock.advance(7000);
  await act(async () => bubble.dispatchEvent(new globalThis.window.Event('pointerover', { bubbles: true })));
  await clock.advance(60000);
  assert.deepEqual(calls.dismiss, ['d1'], 'held while hovered');
  await act(async () =>
    bubble.dispatchEvent(new globalThis.window.Event('pointerout', { bubbles: true, relatedTarget: null }))
  );
  await clock.advance(7999);
  assert.deepEqual(calls.dismiss, ['d1'], 'the leave restarts the timer');
  await clock.advance(1);
  assert.deepEqual(calls.dismiss, ['d1', 'd2']);
  // The open quick message holds it too.
  await render({ bubble: { kind: 'reply', key: 'd3', text: '' } });
  await act(async () => mascot().click());
  await clock.advance(60000);
  assert.deepEqual(calls.dismiss, ['d1', 'd2']);
  await key($('.skin-companion-quick input'), { key: 'Escape' });
  assert.deepEqual(calls.dismiss, ['d1', 'd2', 'd3'], 'leaving the input dismisses it');
  // With motion: a 200ms fade first.
  globalThis.window.matchMedia = () => ({ matches: true });
  await render({ bubble: { kind: 'reply', key: 'd4', text: '' } });
  await clock.advance(8000);
  assert.equal($('.skin-companion-bubble').dataset.fading, 'true');
  assert.deepEqual(calls.dismiss.at(-1), 'd3');
  await clock.advance(200);
  assert.equal(calls.dismiss.at(-1), 'd4');
});

test('a hover, keyboard focus or the input mid-fade stops the fade; the countdown starts over after', async (t) => {
  const { $, mascot, render, key, calls, window } = await mountPet(t);
  const clock = fakeClock(globalThis.window);
  globalThis.window.matchMedia = () => ({ matches: true });
  const fadeOf = async (keyName) => {
    await render({ bubble: { kind: 'reply', key: keyName, text: '' } });
    await clock.advance(8000);
    assert.equal($('.skin-companion-bubble').dataset.fading, 'true', `${keyName} fading`);
    return $('.skin-companion-bubble');
  };
  const fire = (target, type, init = {}) =>
    act(async () => target.dispatchEvent(new window.Event(type, { bubbles: true, ...init })));
  // Hover during the fade.
  let bubble = await fadeOf('h1');
  await fire(bubble, 'pointerover');
  assert.equal(bubble.dataset.fading, undefined, 'the bubble is back');
  await clock.advance(60000);
  assert.deepEqual(calls.dismiss, [], 'held while hovered, fade included');
  await fire(bubble, 'pointerout');
  await clock.advance(7999);
  assert.deepEqual(calls.dismiss, []);
  await clock.advance(1);
  await clock.advance(200);
  assert.deepEqual(calls.dismiss, ['h1'], 'a full countdown and fade after the leave');
  // Keyboard focus in the bubble, before and during the fade.
  await render({ bubble: { kind: 'reply', key: 'f1', text: '' } });
  bubble = $('.skin-companion-bubble');
  await act(async () => bubble.focus());
  await clock.advance(60000);
  assert.deepEqual(calls.dismiss, ['h1'], 'focus holds it like a hover');
  await act(async () => bubble.blur());
  await clock.advance(8000);
  assert.equal(bubble.dataset.fading, 'true');
  await act(async () => bubble.focus());
  assert.equal(bubble.dataset.fading, undefined);
  await clock.advance(60000);
  assert.deepEqual(calls.dismiss, ['h1'], 'focus mid-fade stops it');
  await act(async () => bubble.blur());
  await clock.advance(8000);
  await clock.advance(200);
  assert.deepEqual(calls.dismiss, ['h1', 'f1']);
  // The quick message opening during the fade.
  await fadeOf('q1');
  await act(async () => mascot().click());
  await clock.advance(60000);
  assert.deepEqual(calls.dismiss, ['h1', 'f1'], 'the open input holds it, fade included');
  await key($('.skin-companion-quick input'), { key: 'Escape' });
  assert.deepEqual(calls.dismiss, ['h1', 'f1', 'q1'], 'leaving the input: seen');
});

test('a send answered after the user left the input never writes the old text back', async (t) => {
  let answer;
  const { $, mascot, typeInto, key } = await mountPet(t, {
    onSend: () =>
      new Promise((resolve, reject) => {
        answer = { resolve, reject };
      }),
  });
  for (const settle of [(a) => a.resolve(false), (a) => a.reject(new Error('down'))]) {
    await act(async () => mascot().click());
    await typeInto($('.skin-companion-quick input'), 'hello');
    await act(async () => $('.skin-companion-quick').requestSubmit());
    await key($('.skin-companion-quick input'), { key: 'Escape' });
    assert.equal($('.skin-companion-quick'), null);
    await act(async () => mascot().click());
    await act(async () => settle(answer));
    assert.equal($('.skin-companion-quick input').value, '', 'a reopened input stays clean');
    await key($('.skin-companion-quick input'), { key: 'Escape' });
  }
  // Still the same open input: the refused text comes back.
  await act(async () => mascot().click());
  await typeInto($('.skin-companion-quick input'), 'again');
  await act(async () => $('.skin-companion-quick').requestSubmit());
  await act(async () => answer.resolve(false));
  assert.equal($('.skin-companion-quick input').value, 'again');
  // A late success does not close an input reopened since.
  await act(async () => $('.skin-companion-quick').requestSubmit());
  await key($('.skin-companion-quick input'), { key: 'Escape' });
  await act(async () => mascot().click());
  await act(async () => answer.resolve(true));
  assert.ok($('.skin-companion-quick'), 'the newer input stays open');
});

test('dragging moves the window by screen pixels; the click that ends a drag opens nothing', async (t) => {
  const { $, pet, mascot, calls, window } = await mountPet(t);
  const fire = (type, x, y) =>
    act(async () => {
      mascot().dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: y }));
    });
  await fire('pointerdown', 100, 100);
  await fire('pointermove', 102, 101);
  assert.deepEqual(calls.drag, [], 'under the threshold: still a click');
  await fire('pointermove', 140, 90);
  assert.equal(pet().dataset.dragging, 'true');
  await fire('pointerup', 150, 80);
  assert.deepEqual(calls.drag, [
    { phase: 'start', screenX: 100, screenY: 100 },
    { phase: 'move', screenX: 140, screenY: 90 },
    { phase: 'end', screenX: 150, screenY: 80 },
  ]);
  assert.equal(pet().dataset.dragging, undefined);
  const pointerClick = () =>
    act(async () => mascot().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })));
  await pointerClick();
  assert.equal($('.skin-companion-quick'), null, 'the drag-ending click is swallowed');
  await pointerClick();
  assert.ok($('.skin-companion-quick'), 'the next click opens it');
});

test('arrow keys nudge, double-click resets, right-click and Shift+F10/ContextMenu open the menu', async (t) => {
  const { $, mascot, calls, key, window } = await mountPet(t);
  mascot().focus();
  await key(mascot(), { key: 'ArrowLeft' });
  await key(mascot(), { key: 'ArrowUp', shiftKey: true });
  assert.deepEqual(calls.nudge, [
    [-8, 0],
    [0, -32],
  ]);
  await act(async () => mascot().dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  assert.equal(calls.reset, 1);
  const menu = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  await act(async () => mascot().dispatchEvent(menu));
  assert.equal(menu.defaultPrevented, true, 'no native page menu');
  await key(mascot(), { key: 'F10', shiftKey: true });
  await key(mascot(), { key: 'ContextMenu' });
  assert.equal(calls.menu, 3);
  assert.equal($('.skin-companion-quick'), null, 'the menu opens no input');
  assert.equal($('.skin-companion-toolbar'), null, 'no hover toolbar');
});

test('pinned above the message box, the pet does not drag or nudge; a click still opens the quick message', async (t) => {
  const { $, pet, mascot, calls, key, window } = await mountPet(t, { movable: false });
  assert.equal(pet().dataset.pinned, 'true');
  const fire = (type, x, y) =>
    act(async () => {
      mascot().dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: y }));
    });
  await fire('pointerdown', 100, 100);
  await fire('pointermove', 160, 60);
  await fire('pointerup', 160, 60);
  mascot().focus();
  await key(mascot(), { key: 'ArrowLeft' });
  assert.deepEqual(calls.drag, [], 'no drag');
  assert.deepEqual(calls.nudge, [], 'no nudge');
  await act(async () => mascot().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })));
  assert.ok($('.skin-companion-quick'));
});

// ---- The pet's own menu and look (pet window) ----------------------------------------

test("the pet's menu: the app's menu look, our labels, checkbox states, keyboard, one command per item", async (t) => {
  const dom = installTestDom(t, { rootId: 'root', expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'] });
  const { PetMenu } = await import('./desktop-pet-menu');
  const calls = { command: [], close: 0 };
  const state = { pinned: true, keepAbove: false, collapsed: true };
  await act(async () =>
    dom.root.render(
      React.createElement(PetMenu, {
        state,
        screenRight: 512,
        onCommand: (command) => calls.command.push(command),
        onClose: () => calls.close++,
      })
    )
  );
  const menu = dom.document.querySelector('.mx-menu.desktop-pet-menu');
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(menu.dataset.side, 'right');
  const items = [...menu.querySelectorAll('button.mx-menu-item')];
  assert.deepEqual(
    items.map((item) => [
      item.dataset.command,
      item.textContent,
      item.getAttribute('role'),
      item.getAttribute('aria-checked'),
    ]),
    [
      ['open', 'Open chat', 'menuitem', null],
      ['settings', 'Settings', 'menuitem', null],
      ['pin', 'Pin above the message box', 'menuitemcheckbox', 'true'],
      ['pin-here', 'Pin here', 'menuitemcheckbox', 'false'],
      ['on-screen', 'Free on screen', 'menuitemcheckbox', 'false'],
      ['keep-above', 'Keep above other windows', 'menuitemcheckbox', 'false'],
      ['collapse', 'Collapse bubble', 'menuitemcheckbox', 'true'],
      ['reset', 'Reset position', 'menuitem', null],
      ['off', 'Turn off overlay', 'menuitem', null],
    ]
  );
  assert.equal(items[2].querySelector('svg') !== null, true, 'a checked item shows our check');
  assert.equal(items[5].querySelector('svg'), null);
  // Beside the pet inside the resting window: nothing asks to resize it.
  const css = await (await import('node:fs/promises')).readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /\.desktop-pet-menu \{[^}]*left: calc\(236px \+ var\(--pet-size, 56px\)\);[^}]*bottom: 4px;[^}]*max-height: calc\(100vh - 8px\)/
  );
  assert.equal(menu.getAttribute('style'), null);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(dom.document.activeElement, items[0], 'focus on the first item');
  const key = (init) =>
    act(async () =>
      dom.document.activeElement.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      )
    );
  await key({ key: 'ArrowDown' });
  assert.equal(dom.document.activeElement, items[1]);
  await key({ key: 'ArrowUp' });
  await key({ key: 'ArrowUp' });
  assert.equal(dom.document.activeElement, items[8], 'wraps');
  await act(async () => items[5].click());
  assert.deepEqual(calls.command, ['keep-above']);
  assert.equal(calls.close, 1, 'a choice closes the menu');
  await key({ key: 'Escape' });
  assert.equal(calls.close, 2);
  await act(async () => dom.document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })));
  assert.equal(calls.close, 3, 'an outside click closes it');
});

test('the whole menu fits its window with no scrollbar at 50/100/200%, and draws no ring for a mouse user', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const parse = (css) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({
      selector: selector.trim(),
      body,
    }));
  const pet = parse(await read('./desktop-pet.css'));
  const tokens = await read('./desktop/01-tokens.css');
  const rule = (selector) => pet.find((entry) => entry.selector === selector)?.body ?? '';
  const px = (body, prop) => {
    const found = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`).exec(body);
    return found ? Number(found[1]) : Number.NaN;
  };
  // The menu's rows: a fixed height (min-height lets a tall row, like the Size
  // row's steps in their padding, grow past it) holding the steps.
  const menu = rule('.desktop-pet-menu');
  const rowHeight = px(menu, '--mx-menu-row-height');
  assert.match(rule('.desktop-pet-menu .mx-menu-item'), /(?:^|[;\s])height:\s*var\(--mx-menu-row-height\)/);
  assert.match(rule('.desktop-pet-menu .mx-menu-item'), /padding-block:\s*0/);
  assert.ok(px(rule('.desktop-pet-menu-step'), 'height') <= rowHeight, 'the steps fit their row');
  const divider = px(rule('.desktop-pet-menu-separated'), 'margin-top');
  const inset = px(tokens, '--mx-menu-inset');
  const dom = installTestDom(t, { rootId: 'root', expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'] });
  const { PetMenu } = await import('./desktop-pet-menu');
  const { desktopPetGeometry } = await import('../shared/desktop-pet.ts');
  await act(async () =>
    dom.root.render(
      React.createElement(PetMenu, {
        state: { pinned: true, pinnedHere: false, keepAbove: false, collapsed: false, scale: 100 },
        screenRight: 512,
        onCommand: () => {},
        onClose: () => {},
      })
    )
  );
  const panel = dom.document.querySelector('.desktop-pet-menu');
  const rows = panel.querySelectorAll(':scope > .mx-menu-item').length;
  const dividers = panel.querySelectorAll(':scope > .desktop-pet-menu-separated').length;
  assert.deepEqual([rows, dividers], [10, 3]);
  // The menu's laid-out height (jsdom has no layout: modelled from the sheet):
  // its content against the room `max-height: calc(100vh - 8px)` leaves it.
  assert.match(menu, /max-height:\s*calc\(100vh - 8px\)/);
  const scrollHeight = rows * rowHeight + dividers * divider + 2 * inset + 2;
  for (const scale of [50, 100, 200]) {
    const clientHeight = desktopPetGeometry(scale).window.height - 8;
    assert.ok(scrollHeight <= clientHeight, `${scale}%: scrollHeight ${scrollHeight} <= clientHeight ${clientHeight}`);
  }
  // The ring: only under a real key in the overlay; the menu's own focus on
  // its first item (and :focus-visible) draws nothing.
  const ringed = pet.filter(
    ({ selector, body }) => /desktop-pet-menu/.test(selector) && /box-shadow:\s*var\(--mx-list-focus-ring\)/.test(body)
  );
  assert.ok(ringed.length >= 2);
  for (const { selector } of ringed) assert.match(selector, /^html\[data-pet-keys\] /, selector);
  assert.match(
    rule('.desktop-pet-menu .mx-menu-item:focus,\n.desktop-pet-menu .mx-menu-item:focus-visible'),
    /box-shadow:\s*none/
  );
  assert.equal(dom.document.activeElement, panel.querySelector('button'), 'the first item has focus');
  const { trackPetKeyboardUse } = await import('./skin-companion-pet');
  const untrack = trackPetKeyboardUse(dom.document);
  t.after(untrack);
  dom.document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(dom.document.documentElement.dataset.petKeys, undefined, 'opened by the mouse: no ring');
  dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
  assert.equal(dom.document.documentElement.dataset.petKeys, 'true', 'a key in the menu: ring');
});

test('the bot never shows an outline: clicked, then Tab, PrintScreen and Shift', async (t) => {
  const dom = installTestDom(t, { expose: ['MouseEvent', 'KeyboardEvent'], actEnvironment: false });
  const { readFile } = await import('node:fs/promises');
  const style = dom.document.createElement('style');
  style.textContent = await readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  dom.document.head.append(style);
  const { trackPetKeyboardUse } = await import('./skin-companion-pet');
  t.after(trackPetKeyboardUse(dom.document));
  const bot = dom.document.createElement('button');
  bot.className = 'skin-companion-pet';
  dom.document.body.append(bot);
  bot.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  bot.focus();
  bot.click();
  for (const key of ['Tab', 'PrintScreen', 'Shift']) {
    bot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key, shiftKey: key === 'Shift' }));
    assert.equal(dom.document.activeElement, bot);
    const drawn = dom.window.getComputedStyle(bot);
    const outline = `${drawn.outline} ${drawn.outlineStyle} ${drawn.outlineWidth}`;
    assert.doesNotMatch(outline, /solid|\dpx/, `${key}: no outline`);
  }
});

test('a screenshot or modifier key never turns on the keyboard rings (bubble, menu); navigation keys do', async (t) => {
  const dom = installTestDom(t, { expose: ['MouseEvent', 'KeyboardEvent'], actEnvironment: false });
  const { trackPetKeyboardUse } = await import('./skin-companion-pet');
  const untrack = trackPetKeyboardUse(dom.document);
  t.after(untrack);
  const root = dom.document.documentElement;
  const press = (init) =>
    dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, ...init }));
  // Clicked (it keeps focus), then a screenshot: PrintScreen, Win+Shift+S, Alt, Ctrl.
  dom.document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  for (const init of [
    { key: 'PrintScreen' },
    { key: 'Meta', metaKey: true },
    { key: 'Shift', shiftKey: true, metaKey: true },
    { key: 'S', shiftKey: true, metaKey: true },
    { key: 'Alt', altKey: true },
    { key: 'Control', ctrlKey: true },
    { key: 'F10' },
    { key: 'a' },
  ]) {
    press(init);
    assert.equal(root.dataset.petKeys, undefined, `${init.key}: no ring`);
  }
  for (const init of [
    { key: 'Tab' },
    { key: 'ArrowLeft' },
    { key: 'Enter' },
    { key: ' ' },
    { key: 'Escape' },
    { key: 'ContextMenu' },
    { key: 'F10', shiftKey: true },
  ]) {
    dom.document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    press(init);
    assert.equal(root.dataset.petKeys, 'true', `${JSON.stringify(init)}: ring`);
  }
});

test("the menu's Size row steps 10% within 50–200%, keeps the menu open, and applies once as it closes", async (t) => {
  const dom = installTestDom(t, { rootId: 'root', expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'] });
  const { PetMenu, steppedPetScale } = await import('./desktop-pet-menu');
  const { DESKTOP_PET_MENU } = await import('../shared/desktop-pet.ts');
  assert.equal(steppedPetScale(100, 1), 110);
  assert.equal(steppedPetScale(200, 1), 200, 'clamped at the top');
  assert.equal(steppedPetScale(50, -1), 50, 'clamped at the bottom');
  const calls = { command: [], close: 0, scale: [] };
  const render = (scale) =>
    act(async () =>
      dom.root.render(
        React.createElement(PetMenu, {
          state: { pinned: true, pinnedHere: false, keepAbove: false, collapsed: false, scale },
          screenRight: 512,
          onCommand: (command) => calls.command.push(command),
          onScale: (next) => calls.scale.push(next),
          onClose: () => calls.close++,
        })
      )
    );
  await render(180);
  const $ = (selector) => dom.document.querySelector(selector);
  const row = $('.desktop-pet-menu-size');
  assert.equal(row.querySelector('#desktop-pet-menu-size').textContent, 'Size');
  const smaller = $('button[aria-label="Smaller"]');
  const larger = $('button[aria-label="Larger"]');
  const value = () => $('.desktop-pet-menu-size-value').textContent;
  assert.equal(value(), '180%');
  // The menu's rows and dividers are the ones its room was made for.
  const rows = dom.document.querySelectorAll('.desktop-pet-menu > .mx-menu-item');
  assert.equal(rows.length, DESKTOP_PET_MENU.rows);
  assert.equal(dom.document.querySelectorAll('.desktop-pet-menu-separated').length, DESKTOP_PET_MENU.dividers);
  assert.equal(rows[7], row, 'between Collapse bubble and Reset position');
  larger.focus();
  await act(async () => larger.click());
  assert.equal(value(), '190%');
  await act(async () => larger.click());
  assert.equal(value(), '200%');
  assert.equal(larger.disabled, true, '+ disables at 200%');
  assert.equal(dom.document.activeElement, smaller, 'the keys move to −');
  await act(async () => larger.click());
  assert.equal(value(), '200%');
  // Keyboard: arrows skip the disabled +; Enter on − steps down.
  const key = (init) =>
    act(async () =>
      dom.document.activeElement.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      )
    );
  await key({ key: 'ArrowDown' });
  assert.equal(dom.document.activeElement.dataset.command, 'reset', '+ is skipped while disabled');
  await key({ key: 'ArrowUp' });
  assert.equal(dom.document.activeElement, smaller);
  await act(async () => smaller.click());
  assert.equal(value(), '190%');
  await act(async () => row.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })));
  assert.equal(calls.close, 0, 'stepping keeps the menu open');
  assert.deepEqual(calls.scale, [], 'nothing applied while it is open');
  await act(async () => dom.root.render(null));
  assert.deepEqual(calls.scale, [190], 'applied once as the menu closes');
  // Unchanged: nothing sent. At 50%: − disabled.
  calls.scale.length = 0;
  await render(50);
  assert.equal($('button[aria-label="Smaller"]').disabled, true);
  await act(async () => dom.root.render(null));
  assert.deepEqual(calls.scale, []);
  // The Settings item asks main for Settings → Bots.
  await render(100);
  await act(async () => $('[data-command="settings"]').click());
  assert.deepEqual(calls.command, ['settings']);
  const { categoryForSettingsItem } = await import('./settings/settings-items.ts');
  assert.equal(categoryForSettingsItem('bots'), 'bots', 'the overlay options page');
});

test('near the screen edge the menu opens on the side with room, inside the same window, the pet unmoved', async (t) => {
  const dom = installTestDom(t, { rootId: 'root', expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'] });
  const { PetMenu, petMenuSide } = await import('./desktop-pet-menu');
  const { DESKTOP_PET_SPRITE, DESKTOP_PET_WINDOW, DESKTOP_PET_CORE_WIDTH } = await import('../shared/desktop-pet.ts');
  const css = await (await import('node:fs/promises')).readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  const px = (selector, property) =>
    Number(new RegExp(`${selector.replace(/[.[\]"=]/g, '\\$&')} \\{[^}]*${property}: (\\d+)px`).exec(css)?.[1]);
  const spriteLeft = px('.skin-companion-stack', 'left');
  assert.equal(spriteLeft, DESKTOP_PET_SPRITE.left, 'CSS and main agree on the sprite box');
  const petRight = spriteLeft + DESKTOP_PET_SPRITE.size;
  // Right: past the pet (at its scale's box size); left: its right edge
  // before the pet, the 200px minimum fitting in the window.
  const right = /\.desktop-pet-menu \{[^}]*left: calc\((\d+)px \+ var\(--pet-size, (\d+)px\)\)/.exec(css);
  assert.equal(Number(right[1]), spriteLeft + 8);
  assert.equal(Number(right[2]), DESKTOP_PET_SPRITE.size, 'the 100% box by default');
  const left =
    /\.desktop-pet-menu\[data-side="left"\] \{[^}]*right: calc\(100vw - (\d+)px\);[^}]*max-width: (\d+)px/.exec(css);
  assert.equal(Number(left[1]), spriteLeft - 8, 'ends left of the pet');
  assert.ok(Number(left[2]) >= px('.desktop-pet-menu', 'min-width') && Number(left[2]) <= spriteLeft - 8 - 4);
  assert.ok(DESKTOP_PET_CORE_WIDTH > spriteLeft, 'main keeps the left-hand room on screen');
  assert.ok(DESKTOP_PET_WINDOW.width - (petRight + 8) - 4 >= 200, 'the right-hand room holds the menu too');
  // The side follows the window's on-screen extent.
  assert.equal(petMenuSide(200, DESKTOP_PET_WINDOW.width), 'right');
  assert.equal(petMenuSide(200, petRight + 8 + 200 + 4), 'right');
  assert.equal(petMenuSide(200, petRight + 8 + 200 + 3), 'left');
  const render = (screenRight) =>
    act(async () =>
      dom.root.render(
        React.createElement(PetMenu, {
          state: { pinned: true, keepAbove: false, collapsed: false },
          screenRight,
          onCommand: () => {},
          onClose: () => {},
        })
      )
    );
  await render(DESKTOP_PET_WINDOW.width);
  const menu = dom.document.querySelector('.desktop-pet-menu');
  assert.equal(menu.dataset.side, 'right');
  await render(petRight);
  assert.equal(menu.dataset.side, 'left', 'the right runs off screen: the left');
  assert.equal(menu.getAttribute('style'), null, 'positioned by CSS only');
  // A 200% bot: its menu starts past the bigger box.
  const big = { left: spriteLeft, size: 112 };
  assert.equal(petMenuSide(200, spriteLeft + 112 + 8 + 200 + 4, big), 'right');
  assert.equal(petMenuSide(200, spriteLeft + 112 + 8 + 200 + 3, big), 'left');
});

test('the sprite box, bubble, quick message and menu follow the bot size (--pet-size), pixel art kept crisp', async () => {
  const css = await (await import('node:fs/promises')).readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8');
  const rule = (selector) =>
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  for (const selector of ['.skin-companion-stack', '.skin-companion .skin-companion-face', '.skin-companion-pet']) {
    assert.match(rule(selector), /width: var\(--pet-size, 56px\);\s*height: var\(--pet-size, 56px\);/, selector);
  }
  assert.match(rule('.skin-companion-stack'), /left: 228px;\s*bottom: 8px;/, 'the box stands where main pins it');
  assert.match(
    rule('.skin-companion-quick'),
    /left: calc\(108px \+ var\(--pet-size, 56px\) \/ 2 \+ var\(--quick-shift, 0px\)\);/,
    'centred under it (shifted inside its span at a screen edge)'
  );
  assert.match(rule('.skin-companion-balloon'), /left: calc\(var\(--pet-size, 56px\) \* 9 \/ 28\);/, 'over its head');
  assert.match(
    rule('.skin-companion .skin-companion-face > svg'),
    /margin-bottom: calc\(var\(--pet-size, 56px\) \/ -16 \* var\(--pet-feet-gap, 0\)\);/,
    'lowered by the empty rows under the feet, a sixteenth of the box each'
  );
});

test('nothing draws a box around the bot in any state: no outline, border, shadow, background or box-shaped filter', async () => {
  const css = (
    await (await import('node:fs/promises')).readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8')
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    body,
  }));
  // Rules on the bot itself (its button, the sprite box, the face and its
  // svg/img), in any state; the bubble, quick message and menu keep theirs.
  const bot = rules.filter(
    ({ selector }) =>
      /skin-companion-pet|skin-companion-stack|skin-companion-face|\.mx-av/.test(selector) &&
      !/bubble|quick|menu|balloon|reply/.test(selector)
  );
  assert.ok(bot.length > 5);
  for (const { selector, body } of bot) {
    for (const [, property, value] of body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
      const v = value.trim();
      if (/^(outline|border(-[\w-]+)?)$/.test(property))
        assert.match(v, /^(none|0(px)?)$/, `${selector} ${property}: ${v}`);
      if (property === 'box-shadow') assert.equal(v, 'none', `${selector} ${property}`);
      if (/^background(-color)?$/.test(property)) assert.equal(v, 'transparent', `${selector} ${property}`);
      if (property === 'border-radius') assert.fail(`${selector}: a rounded box`);
      // A drop-shadow follows the drawn pixels: only on the mascot svg, never
      // on a picture (an opaque one gets a square shadow box) or the button.
      if (property === 'filter') assert.match(selector, /> svg$/, `${selector}: filter only on the mascot svg`);
    }
  }
  const pet = rules.find(({ selector }) => selector === '.skin-companion-pet').body;
  assert.match(pet, /outline: none;/);
  assert.match(pet, /-webkit-tap-highlight-color: transparent;/);
  assert.match(pet, /appearance: none;/);
  assert.ok(
    rules.some(
      ({ selector, body }) =>
        /:focus-visible/.test(selector) && /skin-companion-pet/.test(selector) && /outline: none/.test(body)
    )
  );
});

test('a picture face: smooth (pixelated only for the mascot svg) and never continuously animated', async () => {
  const css = (
    await (await import('node:fs/promises')).readFile(new URL('./desktop-pet.css', import.meta.url), 'utf8')
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    body,
  }));
  const pixelated = rules.filter(({ body }) => /image-rendering:\s*pixelated/.test(body));
  assert.ok(pixelated.length > 0);
  for (const { selector } of pixelated) {
    assert.doesNotMatch(selector, /\bimg\b/, `${selector}: an uploaded picture is never pixelated`);
    assert.match(selector, /svg/, selector);
  }
  // Every animation that can reach a picture (the face's img, the face, the
  // stack or the pet button around it) steps: no per-frame recomposite.
  const reaches =
    /skin-companion-face > img|skin-companion-face > :is\([^)]*img|\.skin-companion-face\s*(,|$)|skin-companion-stack|skin-companion-pet\b/;
  for (const { selector, body } of rules) {
    if (!reaches.test(selector) || /@media|prefers-reduced/.test(selector)) continue;
    const animation = /(?:^|;)\s*animation:\s*([^;]+)/.exec(body)?.[1];
    if (animation && animation.trim() !== 'none')
      assert.match(animation, /step-end|steps\(/, `${selector}: ${animation}`);
  }
});

test('the overlay draws the sprite at the size main made its window for', async (t) => {
  const dom = installTestDom(t, {
    expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'],
    actEnvironment: false,
  });
  let showView = null;
  const noop = () => {};
  dom.window.mixdogPet = {
    onView: (listener) => {
      showView = listener;
      return noop;
    },
    onBlurred: () => noop,
    ready: noop,
    painted: noop,
    send: async () => true,
    open: noop,
    command: noop,
    area: noop,
    drag: noop,
    nudge: noop,
    reset: noop,
    interactive: noop,
    focusInput: noop,
  };
  const { flushSync } = await import('react-dom');
  // A fresh module instance: this test mounts its own overlay page.
  await import(`./desktop-pet-main.tsx?scale=${Date.now()}`);
  const root = dom.document.documentElement;
  // The page subscribes to its view in an effect after the first paint.
  for (let wait = 0; wait < 200 && (!dom.document.querySelector('.skin-companion-pet') || !showView); wait += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(showView, 'the page subscribed to its view');
  const base = { sessionId: '', bubble: { kind: 'idle' }, face: { room: false, members: [] }, quiet: false };
  const view = { ...base, collapsed: false, keepAbove: false, pinned: true, theme: null, visible: true };
  for (const [scale, size] of [
    [50, '28px'],
    [100, '56px'],
    [150, '84px'],
    [200, '112px'],
  ]) {
    flushSync(() => showView({ ...view, scale, screenRight: 600 }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(root.style.getPropertyValue('--pet-size'), size, `${scale}%`);
  }
  // The visible feet are the box's bottom (main stands it on the island's
  // bottom line): a look with empty rows under its feet is lowered by them.
  const { mascotCells } = await import('../../../../src/runtime/shared/agent-avatar.mjs');
  const face = (avatar) => ({ room: false, members: [{ id: 'bot', name: 'Bot', avatar }] });
  for (const species of ['mixy', 'labrador', 'corgi']) {
    const avatar = { kind: 'mascot', species, accessory: 'none', expression: 'calm', color: '#e6e6e6' };
    const feetRow = Math.max(...mascotCells(avatar).map((cell) => cell.y));
    flushSync(() => showView({ ...view, face: face(avatar), scale: 100, screenRight: 600 }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(root.style.getPropertyValue('--pet-feet-gap'), String(11 - feetRow), species);
  }
  assert.notEqual(root.style.getPropertyValue('--pet-feet-gap'), '0', 'the corgi stands on short legs');
});

test('the publisher sends no composer while the app still shows its boot cover', async (t) => {
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  const gate = document.createElement('div');
  gate.className = 'desktop-boot-gate';
  gate.setAttribute('data-ready', 'false');
  const cell = document.createElement('div');
  cell.className = 'pane-cell is-focused';
  const form = document.createElement('form');
  form.className = 'composer';
  form.getBoundingClientRect = () => ({ left: 300, top: 600, width: 700, height: 120 });
  cell.append(form);
  gate.append(cell);
  document.body.append(gate);
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  assert.deepEqual(on.calls.composer, [null], 'behind the cover: no composer, so no overlay yet');
  await act(async () => {
    gate.setAttribute('data-ready', 'true');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(on.calls.composer.at(-1), { x: 300, y: 600, width: 700, height: 120, island: null });
});

test('the pet window paints nothing but the pet: html/body out-rank every root background in its sheets', async () => {
  // The installed build painted a black plate behind the pet: the tokens'
  // `:root { background: var(--mx-bg-deep) }` (0,1,0) beat the pet's
  // `html, body { background: transparent }` (html: 0,0,1). jsdom ignores
  // specificity, so compare it here: in every theme state (light, swap,
  // ligatures) the pet's own rule must win on html and body regardless of
  // bundle order.
  const { readFile } = await import('node:fs/promises');
  const sheet = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const main = await sheet('./desktop-pet-main.tsx');
  const imported = [...main.matchAll(/^import '\.\/(.+\.css)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imported, ['desktop/01-tokens.css', 'desktop/16-overlays.css', 'desktop-pet.css']);
  const specificity = (selector) => {
    const ids = (selector.match(/#[\w-]+/g) ?? []).length;
    const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
    const types = (selector.replace(/\[[^\]]*\]|:[\w-]+|\.[\w-]+|#[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) ?? []).length;
    return ids * 10000 + classes * 100 + types;
  };
  /** Rules whose selector targets the root or body element itself. */
  const rootSelector = /^(?:html|body|:root)(?::root|\[[^\]]*\])*$/;
  const rules = (css) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) =>
      selectors
        .split(',')
        .map((selector) => selector.trim())
        .filter((selector) => rootSelector.test(selector))
        .map((selector) => ({ selector, body }))
    );
  const pet = rules(await sheet('./desktop-pet.css')).filter((rule) => /background:\s*transparent/.test(rule.body));
  for (const element of ['html', 'body']) {
    const own = pet.filter((rule) => rule.selector.replace(/:root/, '') === element || rule.selector === element);
    assert.ok(own.length, `${element} is transparent in desktop-pet.css`);
    const strength = Math.max(...own.map((rule) => specificity(rule.selector)));
    for (const file of imported.slice(0, 2)) {
      for (const rule of rules(await sheet(`./${file}`))) {
        if (!/background(?:-color)?\s*:/.test(rule.body)) continue;
        const hits = element === 'html' ? !rule.selector.startsWith('body') : rule.selector.startsWith('body');
        if (!hits) continue;
        assert.ok(
          specificity(rule.selector) < strength,
          `${file} ${rule.selector} would paint the pet window's ${element}`
        );
      }
    }
  }
  // The trigger itself: the old selector lost to the tokens' :root.
  assert.ok(specificity('html') < specificity(':root'));
  // Transparent from the first frame: inline in <head>, before any script or stylesheet.
  const html = await sheet('./desktop-pet.html');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<style>\s*html:root,\s*body \{[^}]*background: transparent;/);
  assert.equal(/<script|<link/.test(head.slice(0, head.indexOf('<style>'))), false);
  // The window shows only after the pet drew with its first view (main waits for it).
  assert.match(main, /requestAnimationFrame\(\(\) => pet\.painted\(\)\)/);
});

test("the app's chat look lands on the pet window: light/dark and the composer tokens, replaced live", async (t) => {
  const dom = installTestDom(t, { rootId: 'root' });
  const { applyPetTheme } = await import('./desktop-pet-menu');
  const root = dom.document.documentElement;
  applyPetTheme({ scheme: 'light', vars: { '--mx-composer-surface': '#fafafa', '--mx-accent': '#3b82f6' } }, root);
  assert.equal(root.dataset.mixdogTheme, 'light');
  assert.equal(root.style.getPropertyValue('--mx-composer-surface'), '#fafafa');
  assert.equal(root.style.getPropertyValue('--mx-accent'), '#3b82f6');
  applyPetTheme({ scheme: 'dark', vars: { '--mx-composer-surface': '#1c1c1f' } }, root);
  assert.equal(root.dataset.mixdogTheme, undefined);
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(root.style.getPropertyValue('--mx-composer-surface'), '#1c1c1f');
  assert.equal(root.style.getPropertyValue('--mx-accent'), '', 'a token the app no longer sets is dropped');
  applyPetTheme(null, root);
  assert.equal(root.style.getPropertyValue('--mx-composer-surface'), '#1c1c1f', 'nothing yet: unchanged');
});

// ---- The setting and the followed session (app window) ------------------------

function fakeDesktop(
  initial = {
    enabled: true,
    pinned: true,
    keepAbove: false,
    collapsed: false,
    autoAdvance: true,
    autoClose: true,
    scale: 100,
  }
) {
  let config = { ...initial };
  const calls = {
    scale: [],
    enabled: [],
    published: [],
    composer: [],
    theme: [],
    layers: [],
    backdrop: [],
    available: [],
    options: [],
    reset: 0,
  };
  let push = null;
  return {
    calls,
    push: (next) => push?.(next),
    api: {
      getDesktopPetConfig: async () => config,
      setDesktopPetEnabled: async (on) => {
        calls.enabled.push(on);
        config = { ...config, enabled: on };
        return config;
      },
      setDesktopPetOption: async (name, value) => {
        calls.options.push([name, value]);
        // Main keeps the three placements mutually exclusive.
        const exclusive = ['pinned', 'pinnedHere', 'onScreen'];
        const others = value && exclusive.includes(name) ? Object.fromEntries(exclusive.map((k) => [k, false])) : {};
        config = { ...config, ...others, [name]: value };
        return config;
      },
      setDesktopPetScale: async (scale) => {
        calls.scale.push(scale);
        config = { ...config, scale };
        return config;
      },
      resetDesktopPetPosition: async () => {
        calls.reset += 1;
        config = { ...config, pinned: true };
        return config;
      },
      publishDesktopPetTheme: (theme) => calls.theme.push(theme),
      publishDesktopPetLayers: (layers) => {
        calls.layers.push(layers.rects);
        calls.backdrop.push(layers.backdrop);
      },
      publishDesktopPetAvailable: (on) => calls.available.push(on),
      subscribeDesktopPetConfig: (listener) => {
        push = listener;
        return () => {};
      },
      publishDesktopPet: (state) => calls.published.push(state),
      publishDesktopPetComposer: (rect) => calls.composer.push(rect),
      subscribeDesktopPetAppLayout: (listener) => {
        calls.layout = listener;
        return () => {
          calls.layout = null;
        };
      },
    },
  };
}

/** ResizeObserver stand-in: the test fires what the browser would. */
class FakeResizeObserver {
  static live = new Set();
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
  }
  observe(target) {
    this.targets.add(target);
    FakeResizeObserver.live.add(this);
  }
  unobserve(target) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    FakeResizeObserver.live.delete(this);
  }
  static fire() {
    for (const observer of [...FakeResizeObserver.live]) observer.callback([]);
  }
}

async function mountSettings(t, desktop, { legacy = null, remote = false, mixy = true } = {}) {
  // Whether the representative bot exists: the host's answer, as the Bots page reads it.
  const { publishMixyStatus } = await import('./mixy-identity');
  publishMixyStatus({ created: mixy });
  const dom = installTestDom(t, {
    rootId: 'root',
    expose: ['MouseEvent', 'Event', 'HTMLElement', 'MutationObserver'],
    globals: { ResizeObserver: FakeResizeObserver },
  });
  dom.window.mixdogDesktop = desktop?.api;
  if (remote) dom.window.mixdogRemoteServer = 'wss://relay.test';
  if (legacy !== null) dom.window.localStorage.setItem('mixdog.desktop.skin-buddy.v1', legacy);
  const publisher = await import('./desktop-pet-publisher');
  publisher.resetDesktopPetConfigForTests();
  t.after(() => publisher.resetDesktopPetConfigForTests());
  const { BotsPanel } = await import('./settings/desktop-pet-toggle');
  await act(async () => dom.root.render(React.createElement(BotsPanel)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { ...dom, publisher };
}

const switchOf = (document) =>
  document.querySelector('input[type="checkbox"][aria-label="Representative bot overlay"]');

const optionSwitch = (document, label) => document.querySelector(`input[type="checkbox"][aria-label="${label}"]`);

test('Settings → Bots holds every overlay option, synced with the pet menu through main', async (t) => {
  const desktop = fakeDesktop();
  const { document } = await mountSettings(t, desktop);
  const labels = ['Keep above other windows', 'Collapse bubble'];
  const position = () => document.querySelector('[role="combobox"][aria-label="Position"]');
  assert.deepEqual(
    labels.map((label) => optionSwitch(document, label)?.checked),
    [false, false],
    'following the app window, bubble shown'
  );
  assert.equal(position().textContent.trim(), 'Pin above the message box', 'pinned by default');
  await act(async () => optionSwitch(document, 'Keep above other windows').click());
  await act(async () => position().click());
  await act(async () =>
    [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'Pin here').click()
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(desktop.calls.options, [
    ['keepAbove', true],
    ['pinnedHere', true],
  ]);
  assert.equal(position().textContent.trim(), 'Pin here');
  assert.equal(optionSwitch(document, 'Keep above other windows').checked, true);
  const reset = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Reset position');
  await act(async () => reset.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(desktop.calls.reset, 1);
  assert.equal(position().textContent.trim(), 'Pin above the message box', 'reset re-pins');
  // The pet's own menu changed something: main pushes it, the page follows.
  await act(async () => desktop.push({ enabled: true, pinned: false, keepAbove: false, collapsed: true }));
  assert.equal(optionSwitch(document, 'Collapse bubble').checked, true);
  assert.equal(optionSwitch(document, 'Keep above other windows').checked, false);
  // Off: the options stay visible but cannot change.
  await act(async () => desktop.push({ enabled: false, pinned: true, keepAbove: false, collapsed: false }));
  assert.equal(optionSwitch(document, 'Collapse bubble').disabled, true);
});

test('Settings → Bots: Position is one dropdown over the four mutually exclusive placements', async (t) => {
  const desktop = fakeDesktop();
  const { document } = await mountSettings(t, desktop);
  const position = () => document.querySelector('[role="combobox"][aria-label="Position"]');
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const choose = async (label) => {
    await act(async () => position().click());
    await act(async () =>
      [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === label).click()
    );
    await settle();
  };
  for (const label of ['Pin above the message box', 'Pin here', 'Free on screen']) {
    assert.equal(optionSwitch(document, label), null, `${label} is no longer a toggle`);
  }
  await act(async () => position().click());
  assert.deepEqual(
    [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim()),
    ['Pin above the message box', 'Pin here', 'Free in the app window', 'Free on screen']
  );
  await act(async () => position().click());
  await choose('Free on screen');
  await choose('Pin here');
  await choose('Pin above the message box');
  await choose('Free on screen');
  await choose('Free in the app window');
  assert.deepEqual(desktop.calls.options, [
    ['onScreen', true],
    ['pinnedHere', true],
    ['pinned', true],
    ['onScreen', true],
    ['onScreen', false],
  ]);
  assert.equal(position().textContent.trim(), 'Free in the app window');
  await act(async () => desktop.push({ enabled: true, pinned: false, pinnedHere: true, keepAbove: false }));
  assert.equal(position().textContent.trim(), 'Pin here', 'a push from main updates the value');
  await act(async () => desktop.push({ enabled: false, pinned: true, keepAbove: false }));
  assert.equal(position().disabled, true);
});

test('Settings → Bots: Position waits for a placement write before taking the next choice', async (t) => {
  const desktop = fakeDesktop();
  const answer = desktop.api.setDesktopPetOption;
  let release = null;
  desktop.api.setDesktopPetOption = (name, value) =>
    new Promise((resolve) => {
      release = () => resolve(answer(name, value));
    });
  const { document } = await mountSettings(t, desktop);
  const position = () => document.querySelector('[role="combobox"][aria-label="Position"]');
  await act(async () => position().click());
  await act(async () =>
    [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'Free on screen').click()
  );
  assert.equal(position().disabled, true, 'locked while main applies the choice');
  await act(async () => release());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(position().disabled, false);
  assert.equal(position().textContent.trim(), 'Free on screen');
  await act(async () => position().click());
  await act(async () =>
    [...document.querySelectorAll('[role="option"]')]
      .find((o) => o.textContent.trim() === 'Free in the app window')
      .click()
  );
  await act(async () => release());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(desktop.calls.options, [
    ['onScreen', true],
    ['onScreen', false],
  ]);
  assert.equal(position().textContent.trim(), 'Free in the app window');
});

async function keyboardSelectPosition(t) {
  const desktop = fakeDesktop();
  const answer = desktop.api.setDesktopPetOption;
  let release = null;
  desktop.api.setDesktopPetOption = (name, value) =>
    new Promise((resolve) => {
      release = () => resolve(answer(name, value));
    });
  const dom = await mountSettings(t, desktop);
  const { document, window } = dom;
  const position = () => document.querySelector('[role="combobox"][aria-label="Position"]');
  const press = (key) =>
    act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  position().focus();
  await press('ArrowDown'); // opens
  await press('ArrowDown'); // Pin here
  await press('Enter');
  assert.equal(position().disabled, true, 'locked while main applies the choice');
  return { ...dom, position, release: () => act(async () => release()), settle: () => act(async () => new Promise((r) => setTimeout(r, 0))) };
}

test('Settings → Bots: a keyboard choice of Position returns focus to the trigger once the write settles', async (t) => {
  const { document, position, release, settle } = await keyboardSelectPosition(t);
  await release();
  await settle();
  assert.equal(position().disabled, false);
  assert.equal(position().textContent.trim(), 'Pin here');
  assert.equal(document.activeElement, position(), 'focus is back on the Position trigger');
});

test('Settings → Bots: a pointer choice of Position does not pull focus to the trigger when re-enabled', async (t) => {
  const desktop = fakeDesktop();
  const answer = desktop.api.setDesktopPetOption;
  let release = null;
  desktop.api.setDesktopPetOption = (name, value) =>
    new Promise((resolve) => {
      release = () => resolve(answer(name, value));
    });
  const { document } = await mountSettings(t, desktop);
  const position = () => document.querySelector('[role="combobox"][aria-label="Position"]');
  await act(async () => position().click());
  await act(async () =>
    [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'Pin here').click()
  );
  assert.equal(position().disabled, true);
  await act(async () => release());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(position().disabled, false);
  assert.notEqual(document.activeElement, position(), 'pointer choices keep their behaviour');
});

test('Settings → Bots: focus that moved elsewhere during the write is left alone', async (t) => {
  const { document, position, release, settle } = await keyboardSelectPosition(t);
  const other = optionSwitch(document, 'Collapse bubble');
  other.focus();
  await release();
  await settle();
  assert.equal(position().disabled, false);
  assert.equal(document.activeElement, other, 'focus stays where the user moved it');
});

test('Settings → Bots: auto-advance and auto-close are on by default and set through main', async (t) => {
  const desktop = fakeDesktop();
  const { document } = await mountSettings(t, desktop);
  const labels = ['Auto-advance long replies', 'Close replies automatically'];
  assert.deepEqual(
    labels.map((label) => optionSwitch(document, label)?.checked),
    [true, true]
  );
  await act(async () => optionSwitch(document, 'Auto-advance long replies').click());
  await act(async () => optionSwitch(document, 'Close replies automatically').click());
  assert.deepEqual(desktop.calls.options, [
    ['autoAdvance', false],
    ['autoClose', false],
  ]);
  assert.equal(optionSwitch(document, 'Close replies automatically').checked, false);
  await act(async () =>
    desktop.push({
      enabled: false,
      pinned: true,
      keepAbove: false,
      collapsed: false,
      autoAdvance: true,
      autoClose: true,
    })
  );
  assert.equal(optionSwitch(document, 'Auto-advance long replies').disabled, true, 'off: cannot change');
});

test('Settings → Bots: Size shows the bot size in percent and sets it through main', async (t) => {
  const desktop = fakeDesktop();
  const { document } = await mountSettings(t, desktop);
  const size = () => document.querySelector('[role="combobox"][aria-label="Size"]');
  assert.ok(size(), 'a Size control next to the overlay toggles');
  assert.equal(size().textContent.trim(), '100%', 'the default');
  await act(async () => size().click());
  const options = [...document.querySelectorAll('[role="option"]')];
  assert.deepEqual(
    options.map((option) => option.textContent.trim()),
    [
      '50%',
      '60%',
      '70%',
      '80%',
      '90%',
      '100%',
      '110%',
      '120%',
      '130%',
      '140%',
      '150%',
      '160%',
      '170%',
      '180%',
      '190%',
      '200%',
    ]
  );
  await act(async () => options.find((option) => option.textContent.trim() === '150%').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(desktop.calls.scale, [150], 'a number, through main');
  assert.equal(size().textContent.trim(), '150%');
  // The overlay off: the size cannot change.
  await act(async () => desktop.push({ enabled: false, pinned: true, keepAbove: false, collapsed: false, scale: 150 }));
  assert.equal(size().disabled, true);
});

test('Settings → Bots: the overlay is on by default; the switch turns it off and back on', async (t) => {
  const desktop = fakeDesktop();
  const { document, window } = await mountSettings(t, desktop);
  const toggle = switchOf(document);
  assert.ok(toggle, 'the switch is there');
  assert.ok(document.body.textContent.includes('Always overlay the representative bot on your screen.'));
  assert.equal(toggle.checked, true, 'on by default');
  await act(async () => toggle.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(desktop.calls.enabled, [false]);
  assert.equal(switchOf(document).checked, false);
  await act(async () => switchOf(document).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(desktop.calls.enabled, [false, true]);
  assert.equal(document.body.textContent.includes('Follow'), false, 'no Follow option: always Mixy');
  // Main pushes a change (the overlay's own "Turn off overlay"): the switch follows.
  await act(async () => desktop.push({ enabled: false }));
  assert.equal(switchOf(document).checked, false);
  assert.equal(window.localStorage.getItem('mixdog.desktop.skin-buddy.v1'), null);
});

test('the old corner-mascot flag migrates once: an explicit off is kept as a stored off', async (t) => {
  const off = fakeDesktop();
  const { document, window } = await mountSettings(t, off, { legacy: 'off' });
  assert.deepEqual(off.calls.enabled, [false]);
  assert.equal(switchOf(document).checked, false);
  assert.equal(window.localStorage.getItem('mixdog.desktop.skin-buddy.v1'), null, 'migrated once');
});

test('an old on, or no old flag, leaves the default on without writing anything', async (t) => {
  const on = fakeDesktop();
  const first = await mountSettings(t, on, { legacy: 'on' });
  assert.deepEqual(on.calls.enabled, []);
  assert.equal(switchOf(first.document).checked, true);
  assert.equal(first.window.localStorage.getItem('mixdog.desktop.skin-buddy.v1'), null);
});

test('a stored off in main stays off (no old flag)', async (t) => {
  const stored = fakeDesktop({ enabled: false });
  const { document } = await mountSettings(t, stored);
  assert.deepEqual(stored.calls.enabled, []);
  assert.equal(switchOf(document).checked, false);
});

test('no desktop pet on a remote/phone window or without the desktop bridge', async (t) => {
  const remote = await mountSettings(t, fakeDesktop(), { remote: true });
  assert.equal(switchOf(remote.document), null);
});

test('without the desktop bridge (web) there is no switch', async (t) => {
  const web = await mountSettings(t, null);
  assert.equal(switchOf(web.document), null);
});

for (const surface of ['remote', 'ssh']) {
  test(`PC only: a ${surface === 'ssh' ? 'server (ssh)' : 'phone/web/remote'} window neither shows the page nor publishes to the pet`, async (t) => {
    const desktop = fakeDesktop();
    if (surface === 'ssh') desktop.api.connection = { kind: 'ssh', id: 'srv' };
    const { document, publisher, root } = await mountSettings(t, desktop, { remote: surface === 'remote' });
    assert.equal(switchOf(document), null, 'no overlay options');
    await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher, { focusKey: 'a' })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    for (const channel of ['published', 'composer', 'theme', 'layers', 'available']) {
      assert.deepEqual(desktop.calls[channel], [], `nothing sent on ${channel}`);
    }
    assert.deepEqual(desktop.calls.enabled, [], 'the setting is never written');
  });
}

test('no representative bot: the overlay options are disabled with a note; the stored setting is untouched', async (t) => {
  const desktop = fakeDesktop();
  const { document, publisher, root } = await mountSettings(t, desktop, { mixy: false });
  assert.ok(document.body.textContent.includes('Create the representative bot to use the overlay.'));
  for (const label of ['Representative bot overlay', 'Keep above other windows', 'Collapse bubble']) {
    assert.equal(optionSwitch(document, label).disabled, true, `${label} disabled`);
  }
  assert.equal(document.querySelector('[role="combobox"][aria-label="Position"]').disabled, true);
  assert.equal(switchOf(document).checked, true, 'still shows the stored on');
  const reset = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Reset position');
  assert.equal(reset.disabled, true);
  // The publisher tells main: no bot, no overlay; then the bot is created.
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  assert.deepEqual(desktop.calls.available, [false]);
  const { publishMixyStatus } = await import('./mixy-identity');
  await act(async () => publishMixyStatus({ created: true }));
  assert.deepEqual(desktop.calls.available, [false, true], 'it appears once the bot exists');
  await act(async () => publishMixyStatus({ created: false }));
  assert.deepEqual(desktop.calls.available, [false, true, false], 'and goes when it is removed');
  assert.deepEqual(desktop.calls.enabled, [], 'the setting is never flipped');
});

test("the pet always talks to Mixy's home chat; the publisher sends nothing while off", async (t) => {
  const { agentHomeSessionId, MIXY_AGENT_ID } = await import(
    '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs'
  );
  const off = fakeDesktop({ enabled: false });
  const { publisher, root } = await mountSettings(t, off);
  assert.equal(publisher.DESKTOP_PET_SESSION_ID, agentHomeSessionId(MIXY_AGENT_ID));
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  assert.deepEqual(off.calls.published, [], 'off: nothing published');
});

test("while on, the publisher sends Mixy's chat state with Mixy's face", async (t) => {
  const { MIXY_AGENT_ID } = await import('../../../../src/runtime/agent/orchestrator/session/agent-home.mjs');
  const on = fakeDesktop({ enabled: true });
  const { publisher, root } = await mountSettings(t, on);
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  const state = on.calls.published.at(-1);
  assert.equal(state.sessionId, publisher.DESKTOP_PET_SESSION_ID);
  assert.deepEqual(state.bubble, { kind: 'idle' });
  assert.equal(state.face.room, false);
  assert.deepEqual(
    state.face.members.map((member) => member.id),
    [MIXY_AGENT_ID]
  );
});

test("on Mixy's own view the pet goes quiet: no symbols or reply, the reply counts as seen, a click focuses the composer", async (t) => {
  const desktop = fakeDesktop({ enabled: true });
  let opened;
  desktop.api.onNotificationOpenSession = (listener) => {
    opened = listener;
    return () => {};
  };
  const { publisher, root, document } = await mountSettings(t, desktop);
  publisher.resetDesktopPetSeenForTests();
  t.after(() => publisher.resetDesktopPetSeenForTests());
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  t.after(() => defaultSessionLaneStore.clear());
  const sessionId = publisher.DESKTOP_PET_SESSION_ID;
  const later = Date.now() + 60_000;
  let revision = 0;
  const lane = (items, busy = false) =>
    act(async () => {
      revision += 1;
      defaultSessionLaneStore.apply({
        sessionId,
        frameSource: 'live',
        snapshot: { sessionId, contentRevision: revision, busy, items },
      });
    });
  const show = (mixyFocused) =>
    act(async () => root.render(React.createElement(publisher.DesktopPetPublisher, { mixyFocused })));
  const last = () => desktop.calls.published.at(-1);
  // The composer the click should focus.
  const composer = document.createElement('div');
  composer.className = 'pane-cell is-focused';
  composer.innerHTML = '<form class="composer"><textarea></textarea></form>';
  document.body.append(composer);

  await show(true);
  await lane([prompt('u1')], true);
  assert.deepEqual(last().bubble, { kind: 'idle' }, 'working: no "…" on Mixy\'s view');
  assert.equal(last().quiet, true);
  await lane([prompt('u1'), reply('a1', 'Fixed it'), done('d1', later)]);
  assert.deepEqual(last().bubble, { kind: 'idle' }, 'the reply is in the chat: no bubble');
  // A click on the quiet pet: main opens Mixy's chat; its message field takes the keyboard.
  await act(async () => opened('other-session'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.notEqual(document.activeElement, composer.querySelector('textarea'), 'only for Mixy');
  await act(async () => opened(sessionId));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(document.activeElement, composer.querySelector('textarea'));

  // Leaving Mixy's view: normal again, the seen reply is not replayed.
  await show(false);
  assert.equal(last().quiet, false);
  assert.deepEqual(last().bubble, { kind: 'idle' }, 'not replayed');
  await lane([prompt('u1'), reply('a1', 'Fixed it'), done('d1', later), prompt('u2')], true);
  assert.deepEqual(last().bubble, { kind: 'working' });
  await lane([
    prompt('u1'),
    reply('a1', 'Fixed it'),
    done('d1', later),
    prompt('u2'),
    reply('a2', 'Next'),
    done('d2', later + 1),
  ]);
  assert.deepEqual(last().bubble, { kind: 'reply', key: 'd2', text: 'Next' }, 'a new reply shows');
  composer.querySelector('textarea').blur();
  await act(async () => opened(sessionId));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.notEqual(
    document.activeElement,
    composer.querySelector('textarea'),
    "off Mixy's view the open path is untouched"
  );
});

test('the quiet pet shows no bubble and its click opens the chat instead of the quick message', async (t) => {
  const { $, mascot, render, calls, window } = await mountPet(t, { quiet: true });
  await render({ bubble: { kind: 'reply', key: 'd1', text: 'Done.' } });
  assert.equal($('.skin-companion-bubble'), null);
  await act(async () => mascot().click());
  assert.equal($('.skin-companion-quick'), null, 'no quick message');
  assert.equal(calls.open, 1, "Mixy's chat opens");
  assert.equal(mascot().hasAttribute('aria-expanded'), false);
  await act(async () => mascot().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })));
  assert.equal(calls.open, 2, 'Enter too');
  // Back to normal off Mixy's view; turning quiet closes an open quick message.
  await render({ quiet: false });
  assert.ok($('.skin-companion-bubble'));
  await act(async () => mascot().click());
  assert.ok($('.skin-companion-quick'));
  await render({ quiet: true });
  assert.equal($('.skin-companion-quick'), null);
  assert.equal(calls.open, 2);
});

test("while on, the publisher sends the focused pane's composer card rect, and null when it goes", async (t) => {
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document, window } = await mountSettings(t, on);
  let rect = { left: 300, top: 600, width: 700, height: 120 };
  const card = (focused) => {
    const cell = document.createElement('div');
    cell.className = focused ? 'pane-cell is-focused' : 'pane-cell';
    const form = document.createElement('form');
    form.className = 'composer';
    form.getBoundingClientRect = () => (focused ? rect : { left: 0, top: 0, width: 10, height: 10 });
    cell.append(form);
    document.body.append(cell);
    return cell;
  };
  card(false);
  const focused = card(true);
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  assert.deepEqual(
    on.calls.composer,
    [{ x: 300, y: 600, width: 700, height: 120, island: null }],
    "the focused pane's card"
  );
  // It grows: the observer reports, the new rect goes out once.
  rect = { left: 300, top: 480, width: 700, height: 240 };
  await act(async () => FakeResizeObserver.fire());
  await act(async () => FakeResizeObserver.fire());
  assert.deepEqual(on.calls.composer.at(-1), { x: 300, y: 480, width: 700, height: 240, island: null });
  assert.equal(on.calls.composer.length, 2, 'unchanged rects are not sent again');
  // The window resizes (zoom): re-measured.
  rect = { left: 240, top: 384, width: 560, height: 192 };
  await act(async () => window.dispatchEvent(new window.Event('resize')));
  assert.deepEqual(on.calls.composer.at(-1), { x: 240, y: 384, width: 560, height: 192, island: null });
  // The card goes (settings page): null.
  await act(async () => {
    focused.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(on.calls.composer.at(-1), null);
});

test('an open side panel is cut out of the bot: the bot stays behind it, a hidden or closed panel cuts nothing', async (t) => {
  const { document } = installTestDom(t, { expose: ['HTMLElement'] });
  const { floatingLayers } = await import('./desktop-pet-publisher');
  document.body.innerHTML = `
    <div class="pane-cell is-focused"></div>
    <aside class="workbench-side-panel" data-side="right"></aside>
    <div class="pane-side-dock"></div>`;
  const panel = document.querySelector('.workbench-side-panel');
  const dock = document.querySelector('.pane-side-dock');
  panel.getBoundingClientRect = () => ({ left: 900, top: 40, width: 380, height: 680 });
  dock.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  assert.deepEqual(floatingLayers().rects, [{ x: 900, y: 40, width: 380, height: 680 }], 'the panel, in static flow');
  panel.style.display = 'none';
  assert.deepEqual(floatingLayers().rects, [], 'a hidden panel cuts nothing');
  panel.style.display = '';
  panel.remove();
  assert.deepEqual(floatingLayers().rects, [], 'a closed panel cuts nothing');
});

test("the composer report carries the island pill's real bottom edge while a pill rests above the card", async (t) => {
  const { document } = installTestDom(t, { expose: ['HTMLElement'] });
  const { islandPillLine } = await import('./desktop-pet-publisher');
  document.body.innerHTML = `
    <div class="pane-cell is-focused"><div class="composer-region">
      <div class="composer-island-slot"><div class="composer-island-stage">
        <div class="composer-island" data-mode="pill"></div>
      </div></div>
      <form class="composer"></form>
    </div></div>`;
  const card = document.querySelector('form.composer');
  const island = document.querySelector('.composer-island');
  island.getBoundingClientRect = () => ({ left: 400, top: 537, width: 300, height: 34 });
  assert.equal(islandPillLine(card), 571, 'the pill rect bottom: top 537 + 34');
  island.getBoundingClientRect = () => ({ left: 400, top: 540.4, width: 300, height: 33 });
  assert.equal(islandPillLine(card), 573, 'rounded to a whole CSS px');
  island.dataset.mode = 'flash';
  assert.equal(islandPillLine(card), 573, 'a flash notice rests as the same capsule');
  for (const mode of ['approval', 'panel']) {
    island.dataset.mode = mode;
    assert.equal(islandPillLine(card), null, `${mode}: no capsule, main takes the resting line`);
  }
  island.dataset.mode = 'pill';
  island.style.visibility = 'hidden';
  assert.equal(islandPillLine(card), null, 'an empty island is not shown');
  island.style.visibility = '';
  island.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  assert.equal(islandPillLine(card), null, 'a closed slot takes no room');
  island.remove();
  assert.equal(islandPillLine(card), null, 'no island at all');
});

test('the composer report carries the transcript column; the over-transcript flag sets html[data-pet-over-transcript]', async (t) => {
  const { TRANSCRIPT_BOTTOM_SPACER } = await import('./transcript-virtual-cache.ts');
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="pane-cell is-focused"><div class="conversation">
      <div class="transcript-shell"><div class="transcript"></div></div>
      <div class="composer-region"><form class="composer"></form></div>
    </div></div>`
  );
  document.querySelector('form.composer').getBoundingClientRect = () => ({
    left: 20,
    top: 600,
    width: 460,
    height: 120,
  });
  document.querySelector('.transcript').getBoundingClientRect = () => ({ left: 0.4, top: 0, width: 500, height: 560 });
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  assert.deepEqual(on.calls.composer.at(-1).transcript, {
    left: 0,
    right: 500,
    bottom: 560 - TRANSCRIPT_BOTTOM_SPACER,
  });
  const html = document.documentElement;
  const over = (on_) => on.calls.layout({ overTranscript: on_, islandReserve: 0 });
  assert.equal(html.hasAttribute('data-pet-over-transcript'), false);
  await act(async () => over(true));
  assert.equal(html.hasAttribute('data-pet-over-transcript'), true, 'over the column');
  await act(async () => over(false));
  assert.equal(html.hasAttribute('data-pet-over-transcript'), false, 'clear');
  await act(async () => over(true));
  await act(async () => root.render(null));
  assert.equal(html.hasAttribute('data-pet-over-transcript'), false, 'publisher gone (overlay off): taken off');
});

test("the bot's island reserve goes to the focused composer's island only, and goes with the publisher", async (t) => {
  const { petIslandReserveFor } = await import('./composer-island-state.ts');
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  const pane = (focused) =>
    `<div class="pane-cell${focused ? ' is-focused' : ''}"><div class="conversation">
      <div class="composer-region"><div class="composer-island"></div><form class="composer"></form></div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', pane(false) + pane(true));
  for (const card of document.querySelectorAll('form.composer')) {
    card.getBoundingClientRect = () => ({ left: 20, top: 600, width: 460, height: 120 });
  }
  const [other, focused] = document.querySelectorAll('.composer-island');
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  assert.equal(petIslandReserveFor(focused), 0, 'nothing heard yet');
  await act(async () => on.calls.layout({ overTranscript: false, islandReserve: 66 }));
  assert.equal(petIslandReserveFor(focused), 66, "the bot's composer");
  assert.equal(petIslandReserveFor(other), 0, 'another pane');
  await act(async () => on.calls.layout({ overTranscript: false, islandReserve: 0 }));
  assert.equal(petIslandReserveFor(focused), 0, 'unpinned');
  await act(async () => on.calls.layout({ overTranscript: false, islandReserve: 122 }));
  assert.equal(petIslandReserveFor(focused), 122, 'a larger bot');
  await act(async () => root.render(null));
  assert.equal(petIslandReserveFor(focused), 0, 'publisher gone (overlay off)');
});

test("switching focus between panes hands the bot's island reserve to the new pane at once", async (t) => {
  const { petIslandReserveFor } = await import('./composer-island-state.ts');
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  const pane = (id) =>
    `<div class="pane-cell" data-pane="${id}"><div class="conversation">
      <div class="composer-region"><div class="composer-island"></div><form class="composer"></form></div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', pane('a') + pane('b'));
  for (const card of document.querySelectorAll('form.composer')) {
    card.getBoundingClientRect = () => ({ left: 20, top: 600, width: 460, height: 120 });
  }
  const [a, b] = document.querySelectorAll('.composer-island');
  const html = document.documentElement;
  const focus = (id) =>
    act(async () => {
      for (const cell of document.querySelectorAll('.pane-cell')) {
        cell.classList.toggle('is-focused', cell.dataset.pane === id);
      }
      root.render(React.createElement(publisher.DesktopPetPublisher, { focusKey: id }));
    });
  await focus('a');
  await act(async () => on.calls.layout({ overTranscript: true, islandReserve: 66 }));
  assert.equal(petIslandReserveFor(a), 66);
  // Main resends its layout only when it changes: the same bot beside the
  // other pane's card sends nothing new.
  await focus('b');
  assert.equal(petIslandReserveFor(b), 66, "the newly focused pane's island makes room for the bot");
  assert.equal(petIslandReserveFor(a), 0, 'the pane left behind does not');
  assert.equal(html.hasAttribute('data-pet-over-transcript'), true, 'the over-transcript flag holds too');
  await focus('a');
  assert.equal(petIslandReserveFor(a), 66, 'and back again');
  await act(async () => root.render(null));
  assert.equal(petIslandReserveFor(a), 0, 'publisher gone (overlay off)');
  assert.equal(html.hasAttribute('data-pet-over-transcript'), false);
});

test('the composer report carries the island pill extent and top, and re-measures as the pill alone widens', async (t) => {
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="pane-cell is-focused"><div class="composer-region">
      <div class="composer-island" data-mode="pill"></div>
      <form class="composer"></form>
    </div></div>`
  );
  document.querySelector('form.composer').getBoundingClientRect = () => ({
    left: 300,
    top: 600,
    width: 700,
    height: 120,
  });
  const island = document.querySelector('.composer-island');
  let pill = { left: 500.4, top: 554, width: 300, height: 34 };
  island.getBoundingClientRect = () => pill;
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  const card = { x: 300, y: 600, width: 700, height: 120 };
  assert.deepEqual(on.calls.composer.at(-1), { ...card, island: 588, islandSpan: { left: 500, right: 800, top: 554 } });
  assert.ok(
    [...FakeResizeObserver.live].some((observer) => observer.targets.has(island)),
    'the pill itself is observed'
  );
  // Its status text grows: only the pill resizes, the new extent goes out.
  pill = { left: 320, top: 554, width: 680, height: 34 };
  await act(async () => FakeResizeObserver.fire());
  assert.deepEqual(on.calls.composer.at(-1), {
    ...card,
    island: 588,
    islandSpan: { left: 320, right: 1000, top: 554 },
  });
});

test("while on, the publisher reports the app's open floating menus/dialogs, once a frame, and [] when they close", async (t) => {
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  assert.deepEqual(on.calls.layers.at(-1), [], 'nothing open');
  const layer = (role, position, rect) => {
    const element = document.createElement('div');
    element.setAttribute('role', role);
    element.style.position = position;
    element.style.zIndex = '10';
    element.getBoundingClientRect = () => rect;
    document.body.append(element);
    return element;
  };
  const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
  // An inline listbox (not floating) is not a layer; the portaled model menu is.
  layer('listbox', 'static', { left: 0, top: 0, width: 100, height: 100 });
  const menu = layer('menu', 'fixed', { left: 900, top: 380, width: 240, height: 300 });
  const sub = layer('menu', 'fixed', { left: 700, top: 420, width: 200, height: 120 });
  await act(frame);
  assert.deepEqual(on.calls.layers.at(-1), [
    { x: 900, y: 380, width: 240, height: 300 },
    { x: 700, y: 420, width: 200, height: 120 },
  ]);
  const count = on.calls.layers.length;
  await act(async () => {
    document.body.append(document.createElement('span'));
    await frame();
  });
  assert.equal(on.calls.layers.length, count, 'unchanged layers are not resent');
  await act(async () => {
    sub.remove();
    menu.remove();
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [], 'closed');
  // A popover that stays mounted and opens in place (the context gauge's card):
  // only its holder's data-open and its own style change.
  const holder = document.createElement('div');
  document.body.append(holder);
  const card = document.createElement('div');
  card.setAttribute('role', 'tooltip');
  card.style.position = 'absolute';
  card.style.zIndex = '20';
  card.style.visibility = 'hidden';
  card.getBoundingClientRect = () => ({ left: 1000, top: 600, width: 180, height: 120 });
  holder.append(card);
  await act(frame);
  assert.deepEqual(on.calls.layers.at(-1), [], 'mounted but hidden');
  await act(async () => {
    card.style.visibility = 'visible';
    holder.dataset.open = 'true';
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [{ x: 1000, y: 600, width: 180, height: 120 }], 'opened in place');
  await act(async () => {
    card.style.visibility = 'hidden';
    holder.dataset.open = 'false';
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [], 'closed in place');
});

test('a side panel resized mid-drag or reopened in place updates the bot cut-out without a pointer-up', async (t) => {
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
  const panel = document.createElement('aside');
  panel.className = 'workbench-side-panel';
  let box = { left: 900, top: 40, width: 380, height: 680 };
  panel.getBoundingClientRect = () => box;
  document.body.append(panel);
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  await act(frame);
  assert.deepEqual(on.calls.layers.at(-1), [{ x: 900, y: 40, width: 380, height: 680 }]);
  // Mid-drag: the width token moves on the element, no pointer-up, no insertion.
  box = { left: 780, top: 40, width: 500, height: 680 };
  await act(async () => {
    panel.style.setProperty('--workbench-side-panel-width', '500px');
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [{ x: 780, y: 40, width: 500, height: 680 }], 'style change');
  box = { left: 700, top: 40, width: 580, height: 680 };
  await act(async () => {
    FakeResizeObserver.fire();
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [{ x: 700, y: 40, width: 580, height: 680 }], 'size change');
  // Closed and retained, then reopened in place (`hidden` toggles).
  await act(async () => {
    panel.hidden = true;
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [], 'retained panel closed');
  await act(async () => {
    panel.hidden = false;
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [{ x: 700, y: 40, width: 580, height: 680 }], 'reopened');
});

test('panel discovery runs once a frame however many unrelated mutations arrive, and a new panel is still tracked', async (t) => {
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  await act(frame);
  let queries = 0;
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = (selector) => {
    if (selector === '.workbench-side-panel, .pane-side-dock') queries += 1;
    return query(selector);
  };
  t.after(() => {
    document.querySelectorAll = query;
  });
  // Streaming chat: many unrelated insertions inside one frame.
  await act(async () => {
    for (let n = 0; n < 50; n += 1) {
      const row = document.createElement('div');
      row.textContent = `chunk ${n}`;
      document.body.append(row);
      await Promise.resolve();
    }
    await frame();
  });
  assert.ok(queries <= 1, `at most one panel query for the frame, saw ${queries}`);
  // A panel added later is found, observed and cut out; its in-place changes publish.
  const panel = document.createElement('aside');
  panel.className = 'workbench-side-panel';
  let box = { left: 900, top: 40, width: 380, height: 680 };
  panel.getBoundingClientRect = () => box;
  await act(async () => {
    document.body.append(panel);
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [{ x: 900, y: 40, width: 380, height: 680 }], 'new panel cut out');
  box = { left: 800, top: 40, width: 480, height: 680 };
  await act(async () => {
    panel.style.setProperty('--workbench-side-panel-width', '480px');
    await frame();
  });
  assert.deepEqual(on.calls.layers.at(-1), [{ x: 800, y: 40, width: 480, height: 680 }], 'and tracked in place');
});

test('while on, a backdrop modal (scrim claim or isolating modal) is flagged apart from the transient layers, nested ones until the last closes', async (t) => {
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  const { acquireTitleBarDim } = await import('./titlebar-dim');
  const { openModal } = await import('./settings/dialog-modality');
  const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(publisher.modalBackdropOpen(), false);
  assert.deepEqual(on.calls.layers.at(-1), []);
  assert.equal(on.calls.backdrop.at(-1), false);
  // Settings-style dialog: the fullscreen scrim claim. A flag, not a rect.
  let releaseDim;
  await act(async () => {
    releaseDim = acquireTitleBarDim();
    await frame();
  });
  assert.equal(on.calls.backdrop.at(-1), true);
  assert.deepEqual(on.calls.layers.at(-1), [], 'no whole-window rect');
  // A nested modal registered with the modality owner (the Context usage surface).
  const host = document.createElement('div');
  document.body.append(host);
  let closeModal;
  await act(async () => {
    closeModal = openModal(host);
    await frame();
  });
  assert.equal(on.calls.backdrop.at(-1), true);
  await act(async () => {
    releaseDim();
    await frame();
  });
  assert.equal(on.calls.backdrop.at(-1), true, 'the outer modal still dims');
  await act(async () => {
    closeModal();
    await frame();
  });
  assert.equal(on.calls.backdrop.at(-1), false, 'the last one closed');
  assert.deepEqual(on.calls.layers.at(-1), []);
  assert.equal(publisher.modalBackdropOpen(), false);
});

test("while on, the publisher sends the app's chat look and resends it when the theme or skin changes", async (t) => {
  const on = fakeDesktop({ enabled: true });
  const { publisher, root, document } = await mountSettings(t, on);
  const html = document.documentElement;
  html.style.setProperty('--mx-composer-surface', '#202024');
  html.style.setProperty('--mx-text', '#eeeeee');
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  const first = on.calls.theme.at(-1);
  assert.equal(first.scheme, 'dark');
  assert.equal(first.vars['--mx-composer-surface'], '#202024');
  assert.equal(first.vars['--mx-text'], '#eeeeee');
  // Light theme with a skin accent: <html> changes, the look goes out again.
  await act(async () => {
    html.dataset.mixdogTheme = 'light';
    html.style.setProperty('--mx-composer-surface', '#ffffff');
    html.style.setProperty('--mx-accent', '#e11d48');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const next = on.calls.theme.at(-1);
  assert.equal(next.scheme, 'light');
  assert.equal(next.vars['--mx-composer-surface'], '#ffffff');
  assert.equal(next.vars['--mx-accent'], '#e11d48');
  const count = on.calls.theme.length;
  await act(async () => {
    html.setAttribute('data-unrelated', '1');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(on.calls.theme.length, count, 'an unchanged look is not resent');
});
