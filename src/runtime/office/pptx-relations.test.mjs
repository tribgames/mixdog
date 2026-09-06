import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runPptxAuthoringScript } from './authoring/pptx-script-runner.mjs';
import { loadPackage } from './portable/portable-opc.mjs';
import { inspectPptxTextBoxes } from './portable/portable-pptx-core.mjs';
import { snapshotPortableOoxml } from './portable/portable-snapshot.mjs';
import { reviewStatLabelProximity } from './portable/text-metrics.mjs';
import { reviewTextFragmentation } from './portable/review-editability.mjs';
import { workspace } from './office-test-support.mjs';

test('authored relationships survive the file and distinguish adjacent metric rows from prose', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'relations.pptx');
  const authored = await runPptxAuthoringScript(`
    const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
    const s = p.addSlide();
    for (let i = 0; i < 3; i++) {
      s.addText(String(10 + i), { x: 1, y: 1 + i * .5, w: 1, h: .35, fontSize: 30,
        ...RELATE({ id: 'value-' + i, role: 'value', label: 'label-' + i }) });
      s.addText('Revenue ' + i, { x: 2.1, y: 1 + i * .5, w: 3, h: .35, fontSize: 18,
        ...RELATE({ id: 'label-' + i, role: 'label' }) });
    }
    await p.writeFile({ fileName: OUTPUT });
  `, path);
  assert.equal(authored.ok, true, JSON.stringify(authored));
  const inspected = await inspectPptxTextBoxes(await loadPackage(path));
  const snapshot = await snapshotPortableOoxml(path, 'pptx');
  assert.equal(snapshot.slides[0].shapes[0].relation.label, 'label-0');
  assert.ok(snapshot.slides[0].slideId);
  assert.ok(snapshot.slides[0].shapes[0].shapeId);
  assert.deepEqual(reviewStatLabelProximity(inspected.boxes), []);
  assert.deepEqual(reviewTextFragmentation(inspected.boxes), []);
  inspected.boxes[1].left = 700;
  const detached = reviewStatLabelProximity(inspected.boxes);
  assert.equal(detached[0].code, 'stat_label_detached');
  assert.equal(detached[0].confidence, 'declared');
  inspected.boxes.splice(1, 1);
  assert.ok(reviewStatLabelProximity(inspected.boxes).some((issue) => issue.code === 'shape_relation_invalid'));
});

test('inferred geometry is advisory and declared table cells remain independent', () => {
  const boxes = Array.from({ length: 3 }, (_, i) => ({
    slide: 1, shape: i + 1, left: 72, top: 100 + i * 26, width: 200, height: 25,
    paragraphs: [{ text: 'Separate meaning', fontSize: 18 }],
  }));
  assert.equal(reviewTextFragmentation(boxes)[0].severity, 'info');
  const cells = boxes.flatMap((box, i) => [0, 1].map((column) => ({
    ...box, shape: i * 2 + column + 1, left: 72 + column * 220,
    relation: { id: `cell-${i}-${column}`, role: 'table-cell', group: 'ledger', row: String(i), column: String(column) },
  })));
  assert.deepEqual(reviewTextFragmentation(cells), []);
  const stat = { ...boxes[0], paragraphs: [{ text: '51.4%', fontSize: 32 }], width: 100 };
  const label = { ...boxes[1], top: 100, left: 180, paragraphs: [{ text: 'Cloud', fontSize: 18 }] };
  assert.deepEqual(reviewStatLabelProximity([stat, label, { ...label, top: 400 }]), []);
  assert.equal(reviewStatLabelProximity([stat, { ...label, top: 400 }])[0].severity, 'info');
});

test('ambiguous relationship IDs cannot silently satisfy a value label', () => {
  const make = (shape, relation) => ({ slide: 1, shape, left: 0, top: 0, width: 100, height: 20, relation, paragraphs: [] });
  const issues = reviewStatLabelProximity([
    make(1, { id: 'v', role: 'value', label: 'l' }),
    make(2, { id: 'l', role: 'label' }),
    make(3, { id: 'l', role: 'label' }),
    make(4, { id: 'l', role: 'label' }),
  ]);
  assert.ok(issues.some((issue) => issue.code === 'shape_relation_invalid' && issue.path.endsWith('shape[1]')));
});
