import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { value, workspace } from './office-test-support.mjs';
import {
  BLOCK_CHARS,
  DEFAULT_CHARS,
  extractSource,
  formatExtract,
  fromDocument,
  fromPlainText,
} from '../../defaults/skills/pptx/scripts/source-extract.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// No digits on either slide, so the facts gate has nothing to refuse.
const DECK = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const cover = pres.addSlide();
cover.addText('Retention rose after onboarding', { x: 0.8, y: 2.4, w: 11.5, h: 1.4, fontFace: 'Arial', fontSize: 40, bold: true, color: '1E2761' });
const body = pres.addSlide();
body.addText('Guided setup lifted retention in every cohort', { x: 0.8, y: 2.4, w: 11.5, h: 0.8, fontFace: 'Arial', fontSize: 24, color: '333333' });
await pres.writeFile({ fileName: OUTPUT });
`;

test('plain text becomes numbered line blocks bounded by the character budget', () => {
  assert.deepEqual(fromPlainText('alpha\n\n  beta  \ngamma', DEFAULT_CHARS), ['[line 1] alpha', '[line 3] beta', '[line 4] gamma']);
  assert.deepEqual(fromPlainText('one\ntwo\nthree', 4), ['[line 1] one', '[line 2] two']);
  assert.deepEqual(fromPlainText(''), []);
});

test('a snapshot document is quoted with the locator each fact will cite', () => {
  const long = 'x'.repeat(BLOCK_CHARS + 50);
  const blocks = fromDocument({
    pages: [{ number: 3, text: 'Revenue  grew\n12 %' }],
    slides: [{ index: 2, shapes: [{ text: 'Q4 plan' }, { text: '   ' }, { placeholder: true, name: 'Slide Number Placeholder 0', text: '2' }] }],
    blocks: [{ index: 1, text: long }],
    sheets: [{ name: 'Sheet1', cells: [{ ref: 'B4', value: 10.5 }, { ref: 'C4', formula: '=B4*2' }] }],
  });
  assert.deepEqual(blocks, [
    '[p3] Revenue grew 12 %',
    '[slide 2] Q4 plan',
    `[¶1] ${'x'.repeat(BLOCK_CHARS)}`,
    '[Sheet1!B4] 10.5',
    '[Sheet1!C4] =B4*2',
  ]);
  assert.deepEqual(fromDocument({ pages: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] }, 1), ['[p1] a']);
  assert.deepEqual(fromDocument(null), []);
});

test('extractSource reads text directly and office files through a portable session it closes', async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, 'notes.md'), '# Brief\n\n운영비 1Q 10.5\n', 'utf8');
  const text = await extractSource('notes.md', { cwd });
  assert.equal(text.kind, 'text');
  assert.deepEqual(text.blocks, ['[line 1] # Brief', '[line 3] 운영비 1Q 10.5']);

  const deck = join(cwd, 'source.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path: deck, script: DECK, mode: 'portable', render: false }, { cwd }));
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const calls = [];
  const office = async (args, callCwd) => {
    calls.push(args.action);
    return value(await executeOfficeTool(args, { cwd: callCwd }));
  };
  const extracted = await extractSource(deck, { cwd, office });
  assert.equal(extracted.kind, 'pptx');
  assert.deepEqual(calls, ['open', 'snapshot', 'close']);
  assert.ok(extracted.blocks.some((block) => /^\[slide 1\] .*Retention rose/.test(block)), JSON.stringify(extracted.blocks));
  assert.ok(extracted.blocks.some((block) => /^\[slide 2\] .*Guided setup/.test(block)), JSON.stringify(extracted.blocks));
  const report = formatExtract(extracted);
  assert.match(report, /^# .*source\.pptx — \d+ blocks/);
  assert.match(report, /\n# sources: .*source\.pptx$/);
});

test('a missing file or an invalid budget is an actionable error, never empty output', async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(extractSource('absent.pdf', { cwd }), /not found/);
  await assert.rejects(extractSource('absent.pdf', { cwd, chars: 0 }), /--chars/);
  await assert.rejects(extractSource('', { cwd }), /file path/);
});
