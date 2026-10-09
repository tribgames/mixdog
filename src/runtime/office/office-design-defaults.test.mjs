import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPdf } from './pdf/pdf-writer.mjs';
import { expandOfficeDesignOperations, resolveOfficeDesign } from './design/design-system.mjs';
import { resolveOfficeArtDirection } from './design/design-art-direction.mjs';
import { workspace } from './office-test-support.mjs';

const docx = (design, operation) =>
  expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design,
    operations: [{ op: 'compose_document', title: 'Report', ...operation }],
  }).operations;

const xlsx = (design, operation) =>
  expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    design,
    operations: [{ op: 'compose_sheet', sheet: 'Data', headers: ['a', 'b'], rows: [[1, 2]], ...operation }],
  }).operations;

test('PDF blocks accept a palette that overrides the fallback ink and reject a malformed one', async (t) => {
  const cwd = await workspace(t);
  const blocks = [
    { type: 'cover', title: 'Cover', eyebrow: 'Eyebrow', meta: ['m'] },
    { type: 'callout', label: 'Note', text: 'Body' },
    { type: 'quote', text: 'Q', attribution: 'Who' },
  ];
  const plain = join(cwd, 'plain.pdf');
  const painted = join(cwd, 'painted.pdf');
  await createPdf(plain, { blocks });
  await createPdf(painted, {
    blocks,
    properties: { palette: { accent: 'B4232A', muted: '555555', field: 'FBEFEF', line: 'D9B8B8' } },
  });
  assert.notDeepEqual(await readFile(plain), await readFile(painted));
  await assert.rejects(
    createPdf(join(cwd, 'bad.pdf'), { blocks, properties: { palette: { accent: '#B4232A', bogus: '000000' } } }),
    /palette is invalid[\s\S]*palette\.accent must be a 6-digit hex[\s\S]*palette\.bogus/
  );
});

test('docx preset writes each meta item on its own line, no invented callout label, and a plain table anatomy', () => {
  const operations = docx(
    { profile: 'data' },
    {
      meta: ['Prepared by A', 'Version 2'],
      sections: [
        {
          heading: 'H',
          callout: 'Approve the plan.',
          paragraphs: ['text'],
        },
        { heading: 'T', table: { headers: ['a', 'b'], rows: [['1', '2']] } },
      ],
    }
  );
  const texts = operations.flatMap((entry) => [entry.text, entry.properties?.text]).filter(Boolean);
  assert.ok(texts.includes('Prepared by A') && texts.includes('Version 2'));
  assert.ok(!texts.some((text) => String(text).includes(' · ')));
  const tables = operations.filter((entry) => entry.op === 'add_table');
  assert.ok(tables.length >= 2);
  const callout = tables.find((entry) => entry.values.flat().includes('Approve the plan.'));
  assert.deepEqual(callout.values.flat(), ['Approve the plan.'], 'a callout without a label has no caption row');
  const data = tables.find((entry) => entry.values.flat().includes('a'));
  assert.equal(data.properties.style, undefined);
  assert.equal(data.properties.borders, undefined);

  const styled = docx(
    { profile: 'data' },
    { tableStyle: 'Table Grid', sections: [{ heading: 'T', table: { headers: ['a'], rows: [['1']] } }] }
  );
  assert.equal(styled.find((entry) => entry.op === 'add_table').properties.style, 'Table Grid');
});

test('docx keeps the Latin face and the East Asian face the author named', () => {
  const operations = docx(
    { profile: 'editorial' },
    { title: '도서관', nameEastAsia: 'Noto Serif KR', sections: [{ heading: '제목', paragraphs: ['본문'] }] }
  );
  const eastAsia = new Set(operations.map((entry) => entry.properties?.nameEastAsia).filter(Boolean));
  assert.deepEqual([...eastAsia], ['Noto Serif KR']);
  const faces = new Set(operations.map((entry) => entry.properties?.name).filter(Boolean));
  assert.ok(faces.has('Bookman Old Style') || faces.has('Calibri'));
  assert.ok(!faces.has('Batang') && !faces.has('Malgun Gothic'));
});

test('the xlsx composer wires the profile table style, the headline option, and the purpose-chosen profile', () => {
  const tableOf = (design, operation) => xlsx(design, operation).find((entry) => entry.op === 'add_table');
  assert.equal(tableOf({ profile: 'editorial' }, {}).style, 'TableStyleMedium2');
  assert.equal(tableOf({ profile: 'editorial' }, { tableStyle: 'TableStyleLight1' }).style, 'TableStyleLight1');

  const headlineFill = (design, operation) => {
    const ops = xlsx(design, { metrics: [{ value: 1, label: 'x' }], ...operation });
    const accent = resolveOfficeDesign('xlsx', design).tokens.colors.accent;
    // The metric value cell is the large bold figure; the lead card paints it with the accent.
    return ops.some(
      (entry) =>
        entry.op === 'set_style' && entry.properties?.fillColor === accent && Number(entry.properties?.fontSize) >= 20
    );
  };
  assert.equal(headlineFill({ profile: 'data' }, { variant: 'comparison-board' }), false, 'only dashboard compositions fill the lead card');
  assert.equal(headlineFill({ profile: 'data' }, { variant: 'monitor-dashboard' }), true);
  assert.equal(headlineFill({ profile: 'data' }, { accentHeadline: true }), true);

  assert.equal(resolveOfficeDesign('xlsx', { purpose: 'financial analysis' }).profile, 'data');
  assert.equal(resolveOfficeDesign('xlsx', { purpose: 'narrative report' }).profile, 'editorial');
  assert.equal(resolveOfficeDesign('xlsx', { purpose: 'technical spec' }).profile, 'technical');
  assert.equal(resolveOfficeDesign('xlsx', { purpose: 'financial', profile: 'technical' }).profile, 'technical');
  assert.equal(resolveOfficeDesign('xlsx', {}).profile, 'executive');
  assert.equal(resolveOfficeDesign('docx', { purpose: 'financial analysis' }).profile, 'executive');
});

test('art direction offers no dark blueprint for a workbook and varies accent2 by blueprint', () => {
  const input = { signature: 'quarterly review', tone: 'bold dramatic launch', expressionMode: 'divergent' };
  const sheet = resolveOfficeArtDirection('xlsx', input, { expressionMode: 'divergent' });
  assert.ok(!sheet.candidates.some((candidate) => candidate.deck.backgroundMode === 'dark'));
  assert.notEqual(sheet.selected.deck.backgroundMode, 'dark');
  const deck = resolveOfficeArtDirection('pptx', input, { expressionMode: 'divergent' });
  assert.ok(deck.candidates.some((candidate) => candidate.deck.backgroundMode === 'dark'));
  const accent2 = new Set(deck.candidates.map((candidate) => candidate.palette.accent2));
  assert.equal(accent2.size, deck.candidates.length);
});
