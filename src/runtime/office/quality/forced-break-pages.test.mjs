import assert from 'node:assert/strict';
import test from 'node:test';
import {
  docxBreakOpenings,
  forcedBreakPagesFromTexts,
  htmlBreakOpenings,
} from './forced-break-pages.mjs';

// A page of the preview PDF layout: a running head, the body lines, and a folio.
const page = (number, ...lines) => ({
  page: number,
  height: 800,
  items: [
    { text: 'Annual report', x: 50, top: 20 },
    ...lines.map((text, index) => ({ text, x: 50, top: 100 + index * 20 })),
    { text: String(number), x: 300, top: 780 },
  ],
});

test('HTML: a stylesheet rule and an inline style both mark a forced-break opening', () => {
  const html = `<html><head><style>
    .chapter { break-before: page; color: #123 }
    h2.part, #appendix { page-break-before: always }
    p { margin: 0 }
  </style></head><body>
    <p>Cover words and the summary.</p>
    <h1 class="chapter">Chapter One &amp; its aim</h1><p>Body.</p>
    <p>Filler paragraph.</p>
    <h2 class="part">Part Two begins here</h2>
    <div id="appendix"><b>Appendix</b> A: the tables</div>
    <p style="break-before: page">Inline break opening</p>
    <p style="page-break-before: avoid">Not a break</p>
  </body></html>`;
  assert.deepEqual(htmlBreakOpenings(html), [
    'Chapter One & its aim',
    'Part Two begins here',
    'Appendix A: the tables',
    'Inline break opening',
  ]);
  const pages = [
    page(1, 'Cover words and the summary.'),
    page(2, 'Chapter One & its aim', 'Body.', 'Filler paragraph.'),
    page(3, 'More text of chapter one'),
    page(4, 'Part Two begins here', 'Appendix', 'A: the tables'),
  ];
  assert.deepEqual([...forcedBreakPagesFromTexts(htmlBreakOpenings(html), pages)], [2, 4]);
});

test('native DOCX: pageBreakBefore and a preceding page-break run open a forced page', () => {
  const xml = `<w:body>
    <w:p><w:r><w:t>Front matter text</w:t></w:r></w:p>
    <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Chapter Alpha starts</w:t></w:r></w:p>
    <w:p><w:r><w:t>Ordinary paragraph</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p><w:r><w:t>Chapter Beta starts</w:t></w:r></w:p>
    <w:p><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr><w:r><w:t>Switched off paragraph</w:t></w:r></w:p>
  </w:body>`;
  assert.deepEqual(docxBreakOpenings(xml), ['Chapter Alpha starts', 'Chapter Beta starts']);
  const pages = [
    page(1, 'Front matter text', 'Ordinary paragraph'),
    page(2, 'Chapter Alpha starts', 'Ordinary paragraph'),
    page(3, 'Chapter Beta starts', 'Switched off paragraph'),
  ];
  assert.deepEqual([...forcedBreakPagesFromTexts(docxBreakOpenings(xml), pages)], [2, 3]);
});

test('a chapter heading at the 20 mm margin of an A4 page is a forced-break page', () => {
  const a4 = (number, ...lines) => ({
    page: number,
    height: 842,
    items: [
      { text: 'Annual report', x: 50, top: 20 },
      ...lines.map((text, index) => ({ text, x: 57, top: 57 + index * 20 })),
      { text: String(number), x: 300, top: 800 },
    ],
  });
  const pages = [a4(1, 'Intro text'), a4(2, 'Chapter Two', 'Body.'), a4(3, 'More')];
  assert.deepEqual([...forcedBreakPagesFromTexts(['Chapter Two'], pages)], [2]);
});

test('HTML: a later rule, inline style or screen-only media rule decides whether a break is effective', () => {
  const html = `<style>
    .chapter { break-before: page } .chapter { break-before: auto }
    .part { break-before: auto } .part { break-before: page }
    .both { break-before: page } @media screen { .both { break-before: auto } }
    @media print { .printed { break-before: page } }
    @media screen { .screened { break-before: page } }
    .over { break-before: page } p.over { break-before: auto }
  </style>
  <h1 class="chapter">Overridden chapter</h1>
  <h1 class="part">Effective part</h1>
  <h1 class="both">Print-effective both</h1>
  <h1 class="printed">Printed only rule</h1>
  <h1 class="screened">Screen only rule</h1>
  <p class="over">Higher specificity override</p>
  <h1 class="chapter" style="break-before: page">Inline wins</h1>`;
  assert.deepEqual(htmlBreakOpenings(html), [
    'Effective part',
    'Print-effective both',
    'Printed only rule',
    'Inline wins',
  ]);
});

test('HTML: declarations within one block resolve by !important, then source order', () => {
  const html = `<style>
    .a { break-before: page; break-before: auto }
    .b { break-before: page !important; break-before: auto }
    .c { color: red; break-before: auto; page-break-before: always }
  </style>
  <h1 class="a">Later auto wins</h1>
  <h1 class="b">Important page wins</h1>
  <h1 class="c">Later always wins</h1>`;
  assert.deepEqual(htmlBreakOpenings(html), ['Important page wins', 'Later always wins']);
});

test('body text repeated at the same position on several pages still opens a forced-break page', () => {
  const pages = [1, 2, 3].map((number) => ({
    page: number,
    height: 800,
    items: [
      { text: 'Annual report', x: 50, top: 20 },
      { text: 'Summary', x: 50, top: 100 },
      { text: `Findings of part ${number}`, x: 50, top: 120 },
      { text: String(number), x: 300, top: 780 },
    ],
  }));
  assert.deepEqual([...forcedBreakPagesFromTexts(['Summary'], pages)], [1, 2, 3]);
});

test('a running head or folio line is not the opening of a page', () => {
  const pages = [page(1, 'Annual report overview'), page(2, 'Something else')];
  assert.deepEqual([...forcedBreakPagesFromTexts(['Annual report overview'], pages)], [1]);
  assert.deepEqual([...forcedBreakPagesFromTexts(['Annual reportSomething'], pages)], []);
});
