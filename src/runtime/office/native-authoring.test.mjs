import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { expandOfficeDesignOperations, applyPdfDesign } from './design/design-system.mjs';
import { reviewOfficeDesign } from './quality/design-review.mjs';
import { reviewDocumentPages } from './quality/document-acceptance.mjs';
import { executeOfficeTool } from './index.mjs';
import { parts, value, workspace } from './office-test-support.mjs';

test('native operations retain the supplied design without generated art direction', () => {
  for (const format of ['docx', 'xlsx']) {
    const operations = format === 'docx' ? [
      { op: 'set_page', properties: { leftMargin: 83, rightMargin: 67 } },
      { op: 'append_text', text: 'A quiet essay', style: 'Title', properties: { name: 'Georgia', size: 19, color: '28231E', bold: false } },
    ] : [
      { op: 'set_range', sheet: 'Report', range: 'B3:C4', values: [['Item', 'Value'], ['A', 12]] },
      { op: 'set_style', sheet: 'Report', range: 'B3:C3', properties: { fontName: 'Georgia', fontSize: 13, fillColor: 'EFEFEF' } },
    ];
    const result = expandOfficeDesignOperations({ format, operations, created: true });
    assert.deepEqual(result.operations, operations);
    assert.equal(result.design.authoring, 'native');
    assert.equal(result.design.artDirection, undefined);
    assert.equal(result.design.creative, undefined);
    assert.equal(result.design.library, undefined);
    assert.deepEqual(result.semantic, []);
  }
});

test('PDF blocks keep explicit typography and spacing without implicit preset styling', () => {
  const blocks = [
    { type: 'heading', text: 'An essay', size: 19, color: '29231F', after: 0 },
    { type: 'paragraph', text: 'Opening paragraph', size: 11, lineHeight: 16, after: 0 },
    { type: 'table', rows: [['Label', 'Value']], headerFill: 'FFFFFF', borderColor: 'EEEEEE' },
  ];
  const native = applyPdfDesign(blocks);
  assert.deepEqual(native.blocks, blocks);
  assert.deepEqual(native.properties, {});
  assert.equal(native.design.authoring, 'native');
  const preset = applyPdfDesign(blocks, { profile: 'data' });
  assert.equal(preset.design.profile, 'data');
  assert.ok(preset.properties.margin > 0);
});

test('composers remain available as explicit presets', () => {
  const word = expandOfficeDesignOperations({
    format: 'docx', operations: [{ op: 'compose_document', title: 'Preset brief', sections: [] }],
  });
  assert.equal(word.semantic[0].op, 'compose_document');
  assert.ok(word.operations.some((operation) => operation.op === 'append_text'));
  const sheet = expandOfficeDesignOperations({
    format: 'xlsx', operations: [{ op: 'compose_sheet', rows: [['A', 1]] }],
  });
  assert.equal(sheet.semantic[0].op, 'compose_sheet');
});

test('native review preserves integrity findings without imposing a presentation structure', () => {
  const reviewed = reviewOfficeDesign({
    format: 'xlsx', document: { sheets: [{ name: 'Data', cells: [{ ref: 'A1', value: '#REF!' }] }] },
  });
  assert.equal(reviewed.authoring, 'native');
  assert.equal(reviewed.status, 'diagnostics-only');
  assert.equal(reviewed.ok, false);
  assert.ok(reviewed.issues.some((issue) => issue.code === 'formula_error'));
});

test('page observations record agent judgement without requiring boilerplate booleans', () => {
  const state = {
    renderedPageCount: 1, reviewToken: 'current', renderedVersion: 1,
    snapshotVersion: 1, renderedCoverage: { complete: true },
  };
  const design = {
    reviewed: true, reviewToken: 'current',
    critique: [{ page: 1, verdict: 'pass', note: 'The essay title is subordinate to its opening; paragraphs and footer are separated.' }],
  };
  const result = reviewDocumentPages('docx', design, state);
  assert.equal(result.acknowledged, true);
  assert.equal(result.authority, 'agent-self-review');
  assert.equal(result.userAcceptance, 'not-recorded');
  assert.equal(reviewDocumentPages('docx', {
    ...design, critique: [{ ...design.critique[0], fixes: ['Reduce the crowded heading'] }],
  }, state).acknowledged, false);
});

test('native Word authoring persists distinct author-chosen treatments and remains editable', async (t) => {
  const cwd = await workspace(t);
  for (const [name, size, bold, margin] of [['essay', 19, false, 80], ['letter', 13, true, 62]]) {
    const path = join(cwd, `${name}.docx`);
    const created = value(await executeOfficeTool({
      action: 'create', path, mode: 'portable',
      operations: [
        { op: 'set_page', properties: { leftMargin: margin, rightMargin: margin } },
        { op: 'append_text', text: '작성자가 정한 제목', style: 'Title', properties: { name: 'Georgia', nameEastAsia: 'Batang', size, bold, alignment: 'left' } },
        { op: 'append_text', text: '본문은 독자와 문서의 성격에 맞춰 배치합니다.', style: 'Normal', properties: { name: 'Georgia', nameEastAsia: 'Batang', size: 11, lineSpacing: 17, spacingAfter: 6 } },
      ],
    }, { cwd }));
    try {
      assert.equal(created.batch.design.authoring, 'native');
      const packaged = await parts(path);
      const xml = await packaged.text('word/document.xml');
      assert.match(xml, new RegExp(`w:left="${margin * 20}"`));
      assert.match(xml, new RegExp(`w:sz w:val="${size * 2}"`));
      assert.match(xml, /w:eastAsia="Batang"/);
      assert.match(xml, new RegExp(`<w:b w:val="${bold ? '1' : '0'}"/>`));
      assert.match(xml, /w:line="340" w:lineRule="atLeast"/);
      const validation = value(await executeOfficeTool({ action: 'validate', session: created.session }, { cwd }));
      assert.equal(validation.ok, true);
    } finally {
      value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
    }
  }
});
