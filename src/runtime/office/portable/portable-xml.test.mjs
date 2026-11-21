import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { fillTemplateParts } from './portable-opc.mjs';
import { containerInner, elementSpans, replaceInParagraphs, textNodes, topLevelElements } from './portable-xml.mjs';
import { reviewVerticalBalance } from './text-metrics.mjs';

test('text nodes preserve source spans, attributes, escaping, and empty runs', () => {
  const first = '<w:t xml:space="preserve"> A&amp;B </w:t>';
  const empty = '<w:t></w:t>';
  const xml = `${first}<w:br/>${empty}`;
  assert.deepEqual(textNodes(xml, 'w:t'), [
    { start: 0, end: first.length, attrs: ' xml:space="preserve"', text: ' A&B ' },
    { start: first.length + 7, end: xml.length, attrs: '', text: '' },
  ]);
  assert.deepEqual(textNodes('<w:t/>', 'w:t'), []);
});

test('top-level elements exclude nested matches and retain self-closing siblings in source order', () => {
  const nested = '<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>';
  const paragraph = '<w:p><w:r/></w:p>';
  const fragment = `${nested}${paragraph}<w:p/>`;
  assert.deepEqual(topLevelElements(fragment, ['w:p']), [
    { name: 'w:p', start: nested.length, end: nested.length + paragraph.length, xml: paragraph },
    { name: 'w:p', start: nested.length + paragraph.length, end: fragment.length, xml: '<w:p/>' },
  ]);
  assert.deepEqual(topLevelElements('<w:p>', ['w:p']), []);
});

test('container lookup skips empty siblings, balances nested containers, and respects the starting offset', () => {
  const inner = 'a<w:p>b</w:p><w:p/>c';
  const first = `<w:p/>x<w:p>${inner}</w:p>`;
  const xml = `${first}<w:p>last</w:p>`;
  assert.deepEqual(containerInner(xml, 'w:p'), { start: 12, end: 12 + inner.length, inner });
  assert.deepEqual(containerInner(xml, 'w:p', first.length), {
    start: first.length + 5,
    end: first.length + 9,
    inner: 'last',
  });
  assert.equal(containerInner('<w:p/>', 'w:p'), null);
  assert.equal(containerInner('<w:p>unclosed', 'w:p'), null);
});

test('element spans preserve attributes and both empty and paired elements without matching longer names', () => {
  const first = '<c r="A1"/>';
  const second = '<c r="B1"><v>7</v></c>';
  const fragment = `${first}${second}<cols/>`;
  assert.deepEqual(elementSpans(fragment, 'c'), [
    { start: 0, end: first.length, attrs: ' r="A1"', xml: first },
    { start: first.length, end: first.length + second.length, attrs: ' r="B1"', xml: second },
  ]);
  assert.deepEqual(elementSpans('<c>unclosed', 'c'), []);
});

test('replaceInParagraphs reads a soft break as the space it stands for and never crosses paragraphs', () => {
  const xml =
    '<a:p><a:r><a:t>올해</a:t></a:r><a:br/><a:r><a:t>상반기에도</a:t></a:r></a:p><a:p><a:r><a:t>상반기에도</a:t></a:r></a:p>';
  assert.deepEqual(replaceInParagraphs(xml, '올해 상반기에도', '내년 하반기에도'), {
    xml: '<a:p><a:r><a:t>내년 하반기에도</a:t></a:r><a:r><a:t></a:t></a:r></a:p><a:p><a:r><a:t>상반기에도</a:t></a:r></a:p>',
    count: 1,
  });
});

test('replaceInParagraphs preserves edge spaces and escapes the replacement text', () => {
  const result = replaceInParagraphs('<a:p><a:r><a:t>a b</a:t></a:r></a:p>', 'b', '& ');
  assert.deepEqual(result, { xml: '<a:p><a:r><a:t xml:space="preserve">a &amp; </a:t></a:r></a:p>', count: 1 });
});

test('fillTemplateParts fills tokens across runs with Korean particles and reports unfilled ones', async () => {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    '<w:p><w:r><w:t>{{company}}은 {{na</w:t></w:r><w:r><w:t>me}} {{missing}}</w:t></w:r></w:p>'
  );
  const result = await fillTemplateParts(zip, ['word/document.xml'], 'w:t', {
    tokens: { company: '모아페이', name: 'Kim' },
  });
  assert.deepEqual(result, {
    op: 'fill_template',
    changed: true,
    filled: { company: 1, name: 1 },
    unfilledTokens: ['missing'],
    strict: false,
  });
  assert.equal(
    await zip.file('word/document.xml').async('string'),
    '<w:p><w:r><w:t>모아페이는 Kim</w:t></w:r><w:r><w:t xml:space="preserve"> {{missing}}</w:t></w:r></w:p>'
  );
});

test('fillTemplateParts rejects strict fills with leftovers and fills that change nothing', async () => {
  const build = () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:p><w:r><w:t>{{a}}</w:t></w:r></w:p>');
    return zip;
  };
  await assert.rejects(
    fillTemplateParts(build(), ['word/document.xml'], 'w:t', { tokens: { b: '1' } }),
    /fill_template changed nothing: the document carries \{\{a\}\} and tokens named b/
  );
  await assert.rejects(
    fillTemplateParts(build(), ['word/document.xml'], 'w:t', { tokens: {}, strict: true }),
    /Unfilled template tokens: a/
  );
});

test('reviewVerticalBalance reports a hollow band and edge-heavy slides but not balanced ones', () => {
  const shape = (slide, top, height) => ({ slide, top, height, left: 0, width: 400 });
  const bounds = [shape(1, 0, 100), shape(1, 300, 100), shape(2, 0, 100), shape(3, 20, 200), shape(3, 240, 280)];
  assert.deepEqual(reviewVerticalBalance(bounds, { slideWidth: 960, slideHeight: 540 }), [
    {
      code: 'vertical_imbalance',
      path: '/slide[1]',
      message:
        'An empty band 200pt deep (2.78in) runs from 100pt to 300pt with content above and below it; extend a region into the band or move the lower block up.',
      hollowBand: 200,
      hollowTop: 100,
    },
    {
      code: 'vertical_imbalance',
      path: '/slide[2]',
      message:
        'Content ends 440pt above the slide bottom while starting 0pt from the top; rebalance the layout or extend content regions downward.',
      emptyTop: 0,
      emptyBottom: 440,
    },
  ]);
  assert.deepEqual(reviewVerticalBalance(bounds, { slideWidth: 0, slideHeight: 540 }), []);
});
