import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPackage, zipText } from './portable-opc.mjs';
import { createPortableOoxmlDocument } from './portable-package.mjs';
import { summarizePivotFields, writePivotTable } from './portable-pivot.mjs';

test('pivot cache records index each text value by its position in the shared items', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-pivot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'pivot.xlsx');
  await createPortableOoxmlDocument(path, { fileKind: 'xlsx' });
  const zip = await loadPackage(path);
  const headers = ['Region', 'Channel', 'Sales'];
  const records = [
    ['North', 'Web', 10],
    ['South', 'Store', 20],
    ['North', 'Store', 5],
    ['East', 'Web', 7],
    [null, 'Web', 1],
  ];
  const written = await writePivotTable(zip, {
    fields: summarizePivotFields(headers, records),
    records,
    sourceSheet: 'Sheet1',
    sourceRef: 'A1:C6',
    destinationSheetPath: 'xl/worksheets/sheet1.xml',
    destination: 'E1',
    name: 'Probe',
    rowField: 0,
    columnField: -1,
    valueFields: [2],
  });
  const xml = await zipText(zip, written.recordsPart);
  const rows = [...xml.matchAll(/<r>([\s\S]*?)<\/r>/g)].map((match) => match[1]);
  // Shared items keep first-seen order: Region North, South, East, ''; Channel Web, Store.
  assert.deepEqual(rows, [
    '<x v="0"/><x v="0"/><n v="10"/>',
    '<x v="1"/><x v="1"/><n v="20"/>',
    '<x v="0"/><x v="1"/><n v="5"/>',
    '<x v="2"/><x v="0"/><n v="7"/>',
    '<x v="3"/><x v="0"/><n v="1"/>',
  ]);
});
