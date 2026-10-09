import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { snapshotDocx } from './portable-snapshot-docx.mjs';
import { reviewDocxStructure } from '../quality/assurance-structure-docx.mjs';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const style = (id, name, inner, based = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${based}${inner}</w:style>`;

async function review(heading) {
  const zip = new JSZip();
  const run = (text, rpr = '') => `<w:r><w:rPr><w:sz w:val="22"/>${rpr}</w:rPr><w:t>${text}</w:t></w:r>`;
  const body = (id, text, rpr) => `<w:p><w:pPr><w:pStyle w:val="${id}"/></w:pPr>${run(text, rpr)}</w:p>`;
  zip.file('word/document.xml', `<w:document ${W}><w:body>${body('Heading1', 'Overview')}${body('Normal', 'Body one.', '<w:color w:val="222222"/>')}${body('Normal', 'Body two.', '<w:color w:val="222222"/>')}</w:body></w:document>`);
  zip.file('word/styles.xml', `<w:styles ${W}>${style('Normal', 'Normal', '<w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr>')}${style('Heading1', 'heading 1', heading, '<w:basedOn w:val="Normal"/>')}</w:styles>`);
  const snapshot = await snapshotDocx(zip);
  return reviewDocxStructure(snapshot).some((entry) => entry.code === 'heading_not_distinct');
}

async function snapshotOf(headingStyle, headingRun, bodyRun = '') {
  const zip = new JSZip();
  const para = (id, text, rpr = '') =>
    `<w:p><w:pPr><w:pStyle w:val="${id}"/></w:pPr><w:r><w:rPr><w:sz w:val="22"/>${rpr}</w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  zip.file('word/document.xml', `<w:document ${W}><w:body>${para('Heading1', 'Overview', headingRun)}${para('Normal', 'Body one.', bodyRun)}${para('Normal', 'Body two.', bodyRun)}</w:body></w:document>`);
  zip.file('word/styles.xml', `<w:styles ${W}>${style('Normal', 'Normal', '')}${style('Heading1', 'heading 1', headingStyle, '<w:basedOn w:val="Normal"/>')}</w:styles>`);
  return snapshotDocx(zip);
}

test('explicit caps and tracking resets override the style they inherit; unstated values inherit', async () => {
  const styled = '<w:rPr><w:caps/><w:spacing w:val="40"/></w:rPr>';
  const reset = await snapshotOf(styled, '<w:caps w:val="0"/><w:spacing w:val="0"/>');
  assert.equal(reset.paragraphs[0].font.caps, undefined);
  assert.equal(reset.paragraphs[0].font.letterSpacing, undefined);
  const inherited = await snapshotOf(styled, '');
  assert.equal(inherited.paragraphs[0].font.caps, true);
  assert.equal(inherited.paragraphs[0].font.letterSpacing, 2);
});

test('an explicit colour against automatic-black body text is a distinct heading', async () => {
  const snapshot = await snapshotOf('', '<w:color w:val="FF0000"/>', '<w:color w:val="auto"/>');
  assert.equal(reviewDocxStructure(snapshot).some((entry) => entry.code === 'heading_not_distinct'), false);
});

test('a heading distinct only by style colour or preceding space is not reported heading_not_distinct', async () => {
  assert.equal(await review('<w:rPr><w:color w:val="C0392B"/></w:rPr>'), false);
  assert.equal(await review('<w:pPr><w:spacing w:before="480" w:after="120"/></w:pPr>'), false);
  assert.equal(await review('<w:rPr><w:caps/></w:rPr>'), false);
  assert.equal(await review('<w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr><w:rPr><w:color w:val="222222"/></w:rPr>'), true);
});
