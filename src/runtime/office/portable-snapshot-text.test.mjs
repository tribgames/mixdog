import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { value, workspace, writeZip } from './office-test-support.mjs';
import { blockText, paragraphTexts } from './portable/portable-xml.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

test('blockText keeps runs together and turns line and paragraph breaks into newlines', () => {
  const body = '<p:txBody><a:p><a:r><a:t>Reten</a:t></a:r><a:r><a:rPr b="1"/><a:t>tion</a:t></a:r><a:br/><a:r><a:t>rose</a:t></a:r></a:p>'
    + '<a:p><a:r><a:t>4주차</a:t></a:r><a:br><a:rPr lang="ko-KR"/></a:br><a:r><a:t>잔존율 &amp; 유지</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p></p:txBody>';
  assert.equal(blockText(body, 'a:t'), 'Retention\nrose\n4주차\n잔존율 & 유지');
  assert.deepEqual(paragraphTexts(body, 'a:t'), ['Reten', 'tion', 'rose', '4주차', '잔존율 & 유지']);
  assert.equal(blockText('<w:p><w:r><w:t xml:space="preserve">a </w:t></w:r><w:r><w:br/><w:t>b</w:t></w:r></w:p>', 'w:t'), 'a \nb');
  assert.equal(blockText('<a:r><a:t>no paragraph</a:t></a:r>', 'a:t'), 'no paragraph');
  assert.equal(blockText('', 'a:t'), '');
  // A comment range or revision span is a slice: runs outside a complete paragraph are kept, the ends it crosses are marked.
  assert.equal(blockText('<w:r><w:t>x</w:t></w:r></w:p><w:p><w:r><w:t>y</w:t></w:r>', 'w:t'), 'x\ny');
  assert.equal(blockText('<w:del><w:r><w:delText>gone</w:delText><w:br/><w:delText>too</w:delText></w:r></w:del>', 'w:delText'), 'gone\ntoo');
  assert.equal(blockText('<w:p><w:pPr/><w:r><w:t>A</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>B</w:t></w:r></w:p><w:p/>', 'w:t'), 'A\n\nB');
});

// A soft break (softBreakBefore → a:br) inside one paragraph, then a paragraph break (breakLine).
const DECK = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
slide.addText([
  { text: '안내형 온보딩이', options: { fontSize: 24 } },
  { text: '잔존율을 올린다', options: { fontSize: 24, softBreakBefore: true, breakLine: true } },
  { text: 'Second paragraph', options: { fontSize: 24 } },
], { x: 1, y: 1, w: 10, h: 2, fontFace: 'Arial' });
slide.addNotes('첫 줄\\n둘째 줄');
await pres.writeFile({ fileName: OUTPUT });
`;

test('a portable snapshot reads an authored shape with its soft break and paragraph break intact', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'breaks.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path: deck, script: DECK, mode: 'portable', render: false }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: authored.session, pages: [1] }, { cwd }));
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const [slide] = snapshot.document.slides;
  const shape = slide.shapes.find((entry) => entry.text?.includes('안내형'));
  assert.ok(shape, JSON.stringify(slide.shapes));
  assert.equal(shape.text, '안내형 온보딩이\n잔존율을 올린다\nSecond paragraph');
  assert.match(slide.notes, /^첫 줄\r?\n둘째 줄$/);   // pptxgenjs writes the note's newline as CRLF
});

test('a portable DOCX snapshot keeps line and paragraph breaks in paragraph and cell text', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'breaks.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:r><w:t>4주차</w:t><w:br/><w:t>잔존율</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Second</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p><w:p><w:r><w:t>Cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '<w:sectPr/></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output: join(cwd, 'breaks-out.docx'), mode: 'portable' }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
  const { paragraphs, tables } = snapshot.document;
  assert.equal(paragraphs[0].text, '4주차\n잔존율');
  assert.deepEqual(paragraphs[0].runs.map((run) => run.text), ['4주차', '잔존율']);
  assert.equal(paragraphs[1].text, 'Second');
  assert.equal(tables[0].rows[0].cells[0].text, 'Cell one\nCell two');
});
