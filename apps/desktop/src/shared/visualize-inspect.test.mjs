import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import {
  formatPageInspection,
  inspectFindingsSummary,
  MAX_INSPECT_ELEMENTS,
  MAX_INSPECT_TEXT,
  VISUALIZE_INSPECT_LIB_SOURCE,
  visualizeInspectScript,
  visualizePageInspection,
} from './visualize-inspect.ts';

// jsdom has no layout: boxes and scroll sizes come from data attributes
// (`data-box="x,y,w,h"`, `data-sw`/`data-cw`/`data-sh`/`data-ch`).
function page(html, { width = 375, height = 812 } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  const number = (element, name) => Number(element.getAttribute(name) || 0);
  Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      const [x, y, w, h] = (this.getAttribute('data-box') || '0,0,0,0').split(',').map(Number);
      return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
    },
  });
  for (const [property, name] of [
    ['scrollWidth', 'data-sw'],
    ['clientWidth', 'data-cw'],
    ['scrollHeight', 'data-sh'],
    ['clientHeight', 'data-ch'],
  ]) {
    Object.defineProperty(window.Element.prototype, property, {
      configurable: true,
      get() {
        return number(this, name);
      },
    });
  }
  return window;
}

// A JSON round trip: results of the jsdom realm are not reference-equal to ours.
const run = (window, options) => JSON.parse(JSON.stringify(window.eval(visualizeInspectScript(options))));
const lib = () => (0, eval)(VISUALIZE_INSPECT_LIB_SOURCE);

const FIXTURE = `<html data-sw="500" data-cw="375" data-box="0,0,375,812"><body data-box="0,0,375,812">
<header data-box="0,0,375,60"><nav aria-label="Main" data-box="0,0,375,60"><a href="#home" id="home" data-box="10,10,60,40">Home</a></nav></header>
<main data-box="0,60,375,700">
  <h1 data-box="10,70,300,40">Dashboard</h1>
  <button id="save" data-box="10,120,100,40">Save</button>
  <button id="tiny" data-box="10,200,16,16">x</button>
  <button id="a" data-box="10,300,100,40">Alpha</button><button id="b" data-box="60,300,100,40">Beta</button>
  <img id="logo" src="x.png" data-box="10,400,50,50"><img src="d.png" alt="" data-box="70,400,50,50">
  <input id="email" placeholder="Email" data-box="10,460,200,40">
  <input id="pw" type="password" value="hunter2" aria-label="Password" data-box="10,510,200,40">
  <input id="nick" aria-label="Nick" value="ada" data-box="10,560,200,40">
  <div id="clip" style="overflow:hidden" data-box="10,610,100,20" data-sw="300" data-cw="100" data-sh="20" data-ch="20">A very long caption that does not fit</div>
  <p id="faint" style="color:#777;background-color:#fff" data-box="10,640,200,20">Low contrast copy</p>
  <p id="fine" style="color:#000;background-color:#fff" data-box="10,670,200,20">Fine copy</p>
  <p id="photo" style="color:#fff;background-image:linear-gradient(red, blue)" data-box="10,700,200,20">Over a gradient</p>
</main></body></html>`;

test('the outline lists landmarks and headings with depth', () => {
  const result = run(page(FIXTURE));
  assert.deepEqual(result.viewport, { width: 375, height: 812 });
  assert.deepEqual(result.page, { width: 500, height: 0 });
  const outline = result.outline.map((item) => [item.depth, item.role, item.level, item.name]);
  assert.deepEqual(outline, [
    [0, 'banner', 0, ''],
    [1, 'navigation', 0, 'Main'],
    [0, 'main', 0, ''],
    [1, 'heading', 1, 'Dashboard'],
  ]);
});

test('interactive elements carry role, accessible name, selector and box', () => {
  const result = run(page(FIXTURE));
  const save = result.elements.find((element) => element.selector === '#save');
  assert.deepEqual([save.role, save.name, save.x, save.y, save.w, save.h], ['button', 'Save', 10, 120, 100, 40]);
  assert.equal(result.elements.find((element) => element.selector === '#home').role, 'link');
  const email = result.elements.find((element) => element.selector === '#email');
  assert.deepEqual([email.role, email.name, email.flags], ['textbox', 'Email', ['placeholder-only']]);
});

test('layout findings: overflow, clipped text, overlap, tap targets, contrast, alt, labels', () => {
  const result = run(page(FIXTURE));
  const by = (kind) => result.findings.filter((finding) => finding.kind === kind);
  assert.match(by('overflow-x')[0].message, /500px wide in a 375px viewport/);
  assert.equal(by('overflow-x')[0].severity, 'error');
  assert.deepEqual(
    by('clipped-text').map((finding) => finding.selector),
    ['#clip']
  );
  assert.deepEqual(
    by('overlap').map((finding) => finding.selector),
    ['#a']
  );
  assert.match(by('overlap')[0].message, /Beta/);
  assert.deepEqual(
    by('small-target').map((finding) => finding.selector),
    ['#tiny']
  );
  assert.match(by('small-target')[0].message, /16x16/);
  assert.deepEqual(
    by('low-contrast').map((finding) => finding.selector),
    ['#faint']
  );
  assert.match(by('low-contrast')[0].message, /4\.4:1 is below 4\.5:1 \(#777777 on #ffffff\)/);
  assert.deepEqual(
    by('image-alt').map((finding) => finding.selector),
    ['#logo']
  );
  assert.deepEqual(
    by('unlabeled-input').map((finding) => finding.selector),
    ['#email']
  );
  assert.equal(result.contrastUnknown, 1, 'text over a gradient is unknown, not a finding');
  assert.equal(result.findingCount, result.findings.length);
});

test('the walk stops at the node cap instead of listing the whole document', () => {
  const spans = '<i></i>'.repeat(4100);
  const window = page(
    `<html><body data-box="0,0,375,812"><main data-box="0,0,375,100"><button id="first" data-box="0,0,100,44">Go</button></main>${spans}</body></html>`
  );
  let steps = 0;
  const create = window.document.createTreeWalker.bind(window.document);
  window.document.createTreeWalker = (...args) => {
    const walker = create(...args);
    const next = walker.nextNode.bind(walker);
    walker.nextNode = () => {
      steps += 1;
      return next();
    };
    return walker;
  };
  const every = window.Element.prototype.querySelectorAll;
  window.Element.prototype.querySelectorAll = function (selector) {
    assert.notEqual(selector, '*', 'the whole document is never materialized');
    return every.call(this, selector);
  };
  const result = run(window);
  assert.equal(result.partial, true);
  assert.equal(steps, 4001, 'one step past the cap, then it stops');
  assert.equal(result.elements.find((element) => element.selector === '#first').name, 'Go');
  const small = run(page('<html><body data-box="0,0,375,812"><i></i><i></i></body></html>'));
  assert.equal(small.partial, false);
});

test('overlap findings match an all-pairs check across grid cells, wide boxes and nesting', () => {
  const targets = [
    ['p1', '120,0,40,40'],
    ['p2', '130,10,40,40'], // straddle a cell edge: overlap
    ['q1', '300,300,50,50'],
    ['q2', '340,340,50,50'], // 100px² of 2500: below the threshold
    ['r1', '500,500,60,60'],
    ['r2', '505,505,60,60'], // overlap
    ['u', '200,1200,40,40'], // before the wide box
  ];
  const html = `<html data-cw="375" data-sw="375"><body data-box="0,0,375,812">
    ${targets.map(([id, box]) => `<button id="${id}" data-box="${box}">${id}</button>`).join('')}
    <a id="n1" href="#" data-box="700,0,100,50"><button id="n2" data-box="710,5,50,30">in</button></a>
    <div id="w" onclick="0" data-box="0,1000,3000,3000"><button id="s" data-box="10,1010,40,40">s</button></div>
    <button id="t" data-box="100,1100,40,40">t</button>
  </body></html>`;
  const boxes = new Map(
    [
      ...targets,
      ['n1', '700,0,100,50'],
      ['n2', '710,5,50,30'],
      ['w', '0,1000,3000,3000'],
      ['s', '10,1010,40,40'],
      ['t', '100,1100,40,40'],
    ].map(([id, box]) => [id, box.split(',').map(Number)])
  );
  const nested = new Set(['n1>n2', 'w>s']);
  const order = ['p1', 'p2', 'q1', 'q2', 'r1', 'r2', 'u', 'n1', 'n2', 'w', 's', 't'];
  const expected = [];
  for (let a = 0; a < order.length; a += 1) {
    for (let b = a + 1; b < order.length; b += 1) {
      if (nested.has(`${order[a]}>${order[b]}`)) continue;
      const [ax, ay, aw, ah] = boxes.get(order[a]);
      const [bx, by, bw, bh] = boxes.get(order[b]);
      const width = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
      const height = Math.min(ay + ah, by + bh) - Math.max(ay, by);
      if (width > 0 && height > 0 && width * height > 0.2 * Math.min(aw * ah, bw * bh))
        expected.push(`${order[a]}>${order[b]}`);
    }
  }
  assert.deepEqual(expected, ['p1>p2', 'r1>r2', 'u>w', 'w>t']);
  const result = run(page(html));
  const found = result.findings
    .filter((finding) => finding.kind === 'overlap')
    .map((finding) => `${finding.selector.slice(1)}>${/\((#\w+)\)$/.exec(finding.message)[1].slice(1)}`);
  assert.deepEqual(found, expected);
});

test('stacked large controls sharing many grid cells still report overlaps and stay complete', () => {
  const buttons = Array.from({ length: 84 }, (_, i) => `<button id="b${i}" data-box="0,0,800,800">b${i}</button>`).join(
    ''
  );
  const result = run(page(`<html><body data-box="0,0,375,812">${buttons}</body></html>`));
  assert.equal(result.partial, false);
  assert.ok(result.findings.some((finding) => finding.kind === 'overlap'));
});

test('an exhausted overlap budget marks the result partial instead of reporting it complete', () => {
  const wide = Array.from(
    { length: 1500 },
    (_, i) => `<button id="w${i}" data-box="0,0,3000,3000">w${i}</button>`
  ).join('');
  const result = run(page(`<html><body data-box="0,0,375,812">${wide}</body></html>`));
  assert.equal(result.partial, true);
  assert.ok(
    result.findings.some((finding) => finding.kind === 'overlap'),
    'rows before the budget ran out are still checked'
  );
});

test('a page that fits has no findings; a selector scopes the read-out', () => {
  const fits = run(
    page(
      '<html data-cw="375" data-sw="375"><body><main data-box="0,0,375,100"><button data-box="0,0,100,44">Go</button></main></body></html>'
    )
  );
  assert.equal(fits.findingCount, 0);
  const scoped = run(page(FIXTURE), { selector: 'main > h1' });
  assert.equal(scoped.scope, 'main > h1');
  assert.deepEqual(
    scoped.outline.map((item) => item.name),
    ['Dashboard']
  );
  assert.equal(scoped.elementCount, 0);
  assert.deepEqual(run(page(FIXTURE), { selector: '#missing' }), { error: 'the selector matched nothing' });
  assert.deepEqual(run(page(FIXTURE), { selector: ':::' }), { error: 'invalid selector' });
});

test('secret field values are never included', () => {
  const result = run(page(FIXTURE));
  assert.equal(result.elements.find((element) => element.selector === '#pw').value, '[redacted]');
  assert.equal(result.elements.find((element) => element.selector === '#nick').value, 'ada');
  const token = 'sk-' + 'a1'.repeat(20);
  const leaked = run(
    page(
      `<html><body data-box="0,0,100,100"><input name="api_key" value="${token}" aria-label="Key" data-box="0,0,100,40"><button data-box="0,50,100,40">Use ${token}</button></body></html>`
    )
  );
  assert.ok(!JSON.stringify(leaked).includes(token));
  assert.equal(leaked.elements[0].value, '[redacted]');
  assert.ok(!formatPageInspection(visualizePageInspection(leaked), 'x').includes(token));
});

test('contrast math follows WCAG', () => {
  const { parseColor, over, contrast } = lib();
  const black = parseColor('rgb(0, 0, 0)');
  const white = parseColor('rgb(255, 255, 255)');
  assert.equal(Math.round(contrast(black, white) * 100) / 100, 21);
  assert.equal(contrast(white, white), 1);
  const grey = parseColor('rgb(119, 119, 119)');
  assert.equal(Math.round(contrast(grey, white) * 100) / 100, 4.48);
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor('transparent').a, 0);
  assert.equal(parseColor('oklch(0.5 0.1 200)'), null);
  const half = over({ r: 0, g: 0, b: 0, a: 0.5 }, white);
  assert.deepEqual([half.r, half.g, half.b], [127.5, 127.5, 127.5]);
});

test('large text needs only 3:1, and a translucent backdrop is composited', () => {
  const big = run(
    page(
      '<html><body><h2 style="color:#888;background-color:#fff;font-size:30px" data-box="0,0,200,40">Big</h2></body></html>'
    )
  );
  assert.equal(big.findings.filter((finding) => finding.kind === 'low-contrast').length, 0, '#888 on white is 3.5:1');
  const dim = run(
    page(
      '<html><body style="background-color:#000"><div style="background-color:rgba(255,255,255,0.1)"><p style="color:#333" data-box="0,0,200,20">Dim</p></div></body></html>'
    )
  );
  assert.equal(dim.findings.filter((finding) => finding.kind === 'low-contrast').length, 1);
});

test('the element list is capped and the read-out stays within its budget', () => {
  const buttons = Array.from(
    { length: 260 },
    (_, index) =>
      `<button id="b${index}" data-box="0,${index * 50},120,44">Button number ${index} with a fairly long accessible name</button>`
  ).join('');
  const result = run(page(`<html data-cw="375" data-sw="375"><body>${buttons}</body></html>`));
  assert.equal(result.elements.length, MAX_INSPECT_ELEMENTS);
  assert.equal(result.elementCount, 260);
  const parsed = visualizePageInspection(result);
  const text = formatPageInspection(parsed, 'index.html');
  assert.ok(text.length <= MAX_INSPECT_TEXT, `${text.length}`);
  assert.match(text, /Interactive elements \(260, first 200 listed\)/);
  assert.match(text, /more elements omitted \(output capped\)/);
});

test('the sanitizer bounds a page-controlled answer', () => {
  assert.equal(visualizePageInspection(null), null);
  assert.equal(visualizePageInspection({ viewport: {} }), null);
  assert.deepEqual(visualizePageInspection({ error: 'x'.repeat(500) }), { error: 'x'.repeat(200) });
  const forged = visualizePageInspection({
    viewport: { width: 1e12, height: -5 },
    page: {},
    outline: [],
    elements: [{ role: 'button', name: 'n'.repeat(500), flags: ['secret'], value: 'hunter2', x: NaN, w: -4 }],
    findings: [
      { kind: 'not-a-kind', message: 'x' },
      { kind: 'overlap', severity: 'weird', message: 'm', selector: 's' },
    ],
    elementCount: 3,
    findingCount: 9,
  });
  assert.equal(forged.viewport.width, 1_000_000);
  assert.equal(forged.viewport.height, 0);
  assert.equal(forged.elements[0].name.length, 80);
  assert.equal(forged.elements[0].value, '[redacted]');
  assert.equal(forged.elements[0].w, 0);
  assert.deepEqual(
    forged.findings.map((finding) => [finding.kind, finding.severity]),
    [['overlap', 'warning']]
  );
  assert.deepEqual([forged.elementCount, forged.findingCount], [3, 9]);
});

test('the text read-out and the one-line summary', () => {
  const text = formatPageInspection(visualizePageInspection(run(page(FIXTURE))), 'index.html');
  assert.match(text, /^index\.html: viewport 375×812, page 500×0/);
  assert.match(text, /Layout findings \(\d+\):\n {2}- \[error\] overflow-x: page scrolls horizontally/);
  assert.match(text, /Outline:\n {2}\[banner\] header\n {4}\[navigation\] "Main"/);
  assert.match(text, /- button "Save" · #save \(10,120 100×40\)/);
  assert.match(text, /value="\[redacted\]"/);
  assert.match(text, /1 text element over images or gradients: contrast not checked\./);
  assert.equal(inspectFindingsSummary(0), '');
  assert.equal(inspectFindingsSummary(1), '1 layout finding — run inspect');
  assert.equal(inspectFindingsSummary(3), '3 layout findings — run inspect');
});
test('what a user typed never becomes a name: textareas, editable regions, referenced secret fields', () => {
  const secret = 'tinysecret-9f8e7d';
  const token = 'sk-' + 'b2'.repeat(20);
  const result = run(
    page(`<html><body data-box="0,0,300,600">
      <label data-box="0,0,300,40">Token<textarea name="api-token" data-box="0,0,200,30">${secret}</textarea></label>
      <label data-box="0,50,300,40">Notes<div contenteditable="true" role="textbox" data-box="0,50,200,30">${secret}</div></label>
      <label data-box="0,100,300,40">Pick<select data-box="0,100,100,30"><option>${secret}</option></select></label>
      <input id="pw" type="password" value="${secret}" aria-label="Password" data-box="0,150,200,30">
      <input id="other" aria-labelledby="pw" data-box="0,200,200,30">
      <input id="other2" aria-labelledby="ed" data-box="0,250,200,30"><div id="ed" contenteditable="">${secret}</div>
      <input type="button" name="api_token" value="${secret}" data-box="0,300,100,30">
      <h2 data-box="0,350,200,30">Key ${token} here</h2>
      <button data-box="0,400,200,30">Use ${token}</button>
    </body></html>`)
  );
  const json = JSON.stringify(result);
  assert.ok(!json.includes(secret), 'no typed content anywhere in the reading');
  assert.ok(!json.includes(token), 'no token-like string anywhere in the reading');
  const named = (selector) => result.elements.find((element) => element.selector === selector)?.name;
  const names = result.elements.map((element) => element.name);
  assert.ok(names.includes('Token'), 'the label text stays, without the field content');
  assert.equal(
    result.elements.find((element) => element.tag === 'div').name,
    '',
    'an editable region is named by none of its content'
  );
  assert.ok(names.includes('Pick'));
  assert.equal(named('#other'), '', 'aria-labelledby on a secret field names nothing');
  assert.equal(named('#other2'), '', 'nor does one on an editable region');
  assert.match(result.outline.find((item) => item.kind === 'heading').name, /^Key \[redacted\] here$/);
});

test('editability is inherited: nested headings, labelledby into a region and false-islands stay out', () => {
  const secret = 'privatetext-1a2b3c';
  const result = run(
    page(`<html><body data-box="0,0,300,600">
      <div contenteditable="true" data-box="0,0,300,200">
        <h2 data-box="0,0,200,30">Heading ${secret}</h2>
        <p data-box="0,40,200,30"><span id="deep">Span ${secret}</span></p>
        <div contenteditable="false" data-box="0,80,200,30"><h3 data-box="0,80,100,20">Island ${secret}</h3><a href="#" id="inner" data-box="0,100,100,20">Link ${secret}</a></div>
      </div>
      <button id="b" aria-labelledby="deep" data-box="0,300,100,30"></button>
      <button id="c" aria-labelledby="inner" data-box="0,340,100,30"></button>
      <h1 data-box="0,400,200,30">Public</h1>
    </body></html>`)
  );
  assert.ok(!JSON.stringify(result).includes(secret), 'nothing from the editable region is emitted');
  assert.deepEqual(
    result.outline.map((item) => item.name),
    ['Public'],
    'nested and island headings are not outlined'
  );
  const named = (selector) => result.elements.find((element) => element.selector === selector)?.name;
  assert.equal(named('#b'), '', 'aria-labelledby into the region names nothing');
  assert.equal(named('#c'), '', 'nor does one to the island');
  assert.equal(named('#inner'), '', 'an element inside the region has no name');
});
