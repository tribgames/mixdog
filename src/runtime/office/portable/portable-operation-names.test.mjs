import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { applyDocx } from './portable-docx.mjs';
import { loadPackage } from './portable-opc.mjs';
import { createPortableOoxmlDocument } from './portable-package.mjs';
import { applyPptx } from './portable-pptx.mjs';
import { resolveGeometry, textBodyXml } from './portable-slide-shapes.mjs';
import { addWorksheetValidation } from './portable-xlsx-operations.mjs';

// Names that every plain object answers through its prototype. A caller's
// operation, type, or alignment spelled like one of these is still unknown.
const INHERITED_NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

async function freshPackage(t, fileKind) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-operation-names-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `probe.${fileKind}`);
  await createPortableOoxmlDocument(path, { fileKind });
  return loadPackage(path);
}

test('an inherited name is not a DOCX operation', async (t) => {
  const zip = await freshPackage(t, 'docx');
  for (const op of INHERITED_NAMES) {
    await assert.rejects(applyDocx(zip, [{ op }]), /Portable DOCX backend does not support operation/);
  }
});

test('an inherited name is not a PPTX operation', async (t) => {
  const zip = await freshPackage(t, 'pptx');
  for (const op of INHERITED_NAMES) {
    await assert.rejects(applyPptx(zip, [{ op }]), /Portable PPTX backend does not support operation/);
  }
});

test('an inherited name is neither a validation type nor a validation operator', () => {
  const zip = new JSZip();
  const sheet = { name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' };
  const xml = '<worksheet><sheetData/></worksheet>';
  for (const name of INHERITED_NAMES) {
    assert.throws(
      () =>
        addWorksheetValidation(zip, sheet, xml, { op: 'add_validation', range: 'A1:A3', type: name, formula1: '1' }),
      /add_validation type must be one of/
    );
    assert.throws(
      () =>
        addWorksheetValidation(zip, sheet, xml, {
          op: 'add_validation',
          range: 'A1:A3',
          type: 'whole',
          operator: name,
          formula1: '1',
        }),
      /add_validation operator must be one of/
    );
  }
});

test('an inherited name is not a shape geometry, alignment, or anchor', () => {
  for (const name of INHERITED_NAMES) {
    assert.equal(resolveGeometry(name), '');
    const body = textBodyXml({ paragraphs: [{ text: 'x', align: name }], anchor: name });
    assert.doesNotMatch(body, /\balgn=/);
    assert.doesNotMatch(body, /\banchor=/);
  }
});

test('an inherited name is not a file kind the portable backend creates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-operation-names-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const fileKind of INHERITED_NAMES) {
    await assert.rejects(
      createPortableOoxmlDocument(join(dir, 'probe.bin'), { fileKind }),
      /Portable Office creation supports/
    );
  }
});
