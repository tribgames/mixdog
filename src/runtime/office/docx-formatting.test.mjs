import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatFirstBodyPhrase, patchParagraphFormat } from './portable/docx-formatting.mjs';
import { wordRunProperties, paragraphFormatXml } from './portable/portable-docx-xml.mjs';
import { applyPortableOoxmlBatch } from './portable/portable-ooxml.mjs';
import { expandOfficeDesignOperations } from './design/design-system.mjs';
import { parts, workspace, writeZip } from './office-test-support.mjs';

const run = (text, props = '') => `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const fonts = '<w:rFonts w:ascii="Cambria" w:eastAsia="Malgun Gothic" w:cs="Arial"/>';
const original = `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run('아무것도 ', fonts + '<w:b/><w:sz w:val="66"/>')}${run('하지 않는 시간', fonts + '<w:color w:val="112233"/><w:sz w:val="66"/>')}</w:p>`;

test('body font edits cross fragments, preserve formatting, and never match the footer instead', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'fragments.docx');
  const body = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${original}</w:body></w:document>`;
  const footer = `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${run('아무것도 하지 않는 시간', '<w:sz w:val="18"/>')}</w:p></w:ftr>`;
  await writeZip(path, { 'word/document.xml': body, 'word/footer1.xml': footer });
  await applyPortableOoxmlBatch(path, 'docx', [{ op: 'set_font', find: '아무것도 하지 않는 시간', properties: { size: 24 } }]);
  const result = await parts(path);
  const edited = await result.text('word/document.xml');
  assert.equal((edited.match(/w:sz w:val="48"/g) || []).length, 2);
  assert.equal((edited.match(/w:eastAsia="Malgun Gothic"/g) || []).length, 2);
  assert.match(edited, /<w:b\/>/);
  assert.match(edited, /w:color w:val="112233"/);
  assert.equal(await result.text('word/footer1.xml'), footer);
  await assert.rejects(applyPortableOoxmlBatch(path, 'docx', [{
    op: 'set_font', find: 'footer-only', properties: { size: 30 },
  }]), /not found in document body/);
});

test('a substring edit changes only its characters and only the first occurrence', () => {
  const paragraph = `<w:p>${run('before target after target', fonts + '<w:b/>')}</w:p>`;
  const result = formatFirstBodyPhrase(paragraph, 'target', { bold: false, color: 'FF0000' });
  assert.match(result.xml, /<w:b w:val="0"\/><w:color w:val="FF0000"\/>.*?<w:t xml:space="preserve">target<\/w:t>/);
  assert.equal((result.xml.match(/FF0000/g) || []).length, 1);
  assert.match(result.xml, /<w:b\/><\/w:rPr><w:t xml:space="preserve"> after target<\/w:t>/);
});

test('fields and breaks are barriers rather than disappearing from the searched phrase', () => {
  const paragraph = `<w:p>${run('a')}<w:r><w:tab/></w:r>${run('b')}</w:p>`;
  assert.throws(() => formatFirstBodyPhrase(paragraph, 'ab', { size: 12 }), /not found/);
});

test('changing a page break preserves paragraph spacing, keep rules, tabs and section metadata', () => {
  const properties = '<w:pStyle w:val="Heading1"/><w:keepNext/><w:pageBreakBefore/>'
    + '<w:tabs><w:tab w:val="right" w:pos="2000"/></w:tabs>'
    + '<w:spacing w:before="200" w:after="140"/><w:ind w:left="120"/>'
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
  const paragraph = `<w:p><w:pPr>${properties}</w:pPr>${run('Heading')}</w:p>`;
  const edited = patchParagraphFormat(paragraph, { pageBreakBefore: false });
  assert.equal(edited, paragraph.replace('<w:pageBreakBefore/>', '<w:pageBreakBefore w:val="0"/>'));
  assert.equal(patchParagraphFormat(edited, { pageBreakBefore: false }), edited);
  const spacing = patchParagraphFormat(edited, { spacingAfter: 8 });
  assert.match(spacing, /<w:spacing w:before="200" w:after="160"\/>/);
});

test('font slots stay independent and spacing uses points, not OOXML line multiples', () => {
  const changed = formatFirstBodyPhrase(`<w:p>${run('Korean 한국어', fonts)}</w:p>`, 'Korean 한국어', { name: 'Georgia' });
  assert.match(changed.xml, /w:ascii="Georgia"/);
  assert.match(changed.xml, /w:eastAsia="Malgun Gothic"/);
  assert.match(changed.xml, /w:cs="Arial"/);
  assert.match(wordRunProperties({ nameEastAsia: 'Batang' }), /w:eastAsia="Batang"/);
  assert.doesNotMatch(wordRunProperties({ nameEastAsia: 'Batang' }), /w:ascii=/);
  assert.match(paragraphFormatXml({ lineSpacing: 14.7 }), /w:line="294" w:lineRule="atLeast"/);
});

test('prose composition preserves content without synthetic labels or forced page breaks', () => {
  const operation = {
    op: 'compose_document', title: '아무것도 하지 않는 시간의 쓸모', summary: '요약',
    sections: Array.from({ length: 4 }, (_, index) => ({ heading: `소제목 ${index}`, paragraphs: [`본문 ${index}`] })),
  };
  const expanded = expandOfficeDesignOperations({ format: 'docx', operations: [operation], created: true });
  const paragraphs = expanded.operations.filter((op) => op.op === 'append_text');
  assert.deepEqual(paragraphs.map((op) => op.text), [
    operation.title, operation.summary, ...operation.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
  ]);
  assert.ok(paragraphs.every((op) => op.properties.nameEastAsia === 'Malgun Gothic'));
  assert.ok(paragraphs.every((op) => op.properties.alignment === 'left'));
  assert.ok(paragraphs.every((op) => op.properties.pageBreakBefore !== true));
  assert.equal(paragraphs[0].properties.size, 24);
  const body = paragraphs.find((op) => op.text === '본문 0');
  assert.equal(body.properties.keepWithNext, false);
  assert.equal(body.properties.widowControl, true);
});
