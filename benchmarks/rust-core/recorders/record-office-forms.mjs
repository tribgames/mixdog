#!/usr/bin/env node
// Golden of the office PDF form fields (crate mixdog-office-pdf: forms). The Node functions of
// src/runtime/office/pdf/pdf-forms.mjs run over pdf-lib documents and give what Rust must equal:
//   - create: addFormField for every kind (text single and multiline, with maxLength and font size, check box, dropdown
//     with an editable free value, option list with several selected, radio group, dotted names, Latin-1 text) and the
//     form after updateFieldAppearances: describeFormField of every field and, per widget, its rectangle, state,
//     default appearance and the decoded content of its normal and down appearance streams;
//   - lint: lintPdfFormFields over good and bad layouts, with the fields as it adopted them;
//   - fill: a saved form loaded again, fillFormValues with the values of each case, updateFieldAppearances,
//     clippedFormValues and the form described again; the errors with the texts Node gives.
// Numbers are compared within 1e-9 (relative), every text exactly; the appearance streams are compared as the content
// they hold (the rendering of a stream is its content), which is stricter than a rendered page.
//
//   node benchmarks/rust-core/recorders/record-office-forms.mjs --tree <product tree>
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-forms.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const forms = await importFrom(tree, 'src/runtime/office/pdf/pdf-forms.mjs');
const { addFormField, clippedFormValues, describeFormField, fillFormValues, lintPdfFormFields } = forms;
const { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } = createRequire(
  path.join(tree, 'package.json'),
)('pdf-lib');

const out = { note: 'Node (pdf-forms.mjs over pdf-lib) forms; see the recorder header.', create: [], lint: [], fill: [] };

/** What a widget's appearance stream holds, as text. */
function contentsOf(document, reference) {
  const stream = document.context.lookup(reference);
  if (stream instanceof PDFRawStream) return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  return stream.getContentsString();
}

function streamRecord(document, reference) {
  const stream = document.context.lookup(reference);
  const dict = stream.dict ?? stream;
  const box = dict.lookup(PDFName.of('BBox'), PDFArray).asRectangle();
  const resources = dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  return {
    box: [box.x, box.y, box.width, box.height],
    fonts: fonts ? fonts.keys().map((key) => key.decodeText()) : [],
    content: contentsOf(document, reference),
  };
}

function appearanceRecord(document, entry) {
  if (!entry) return null;
  const target = document.context.lookup(entry);
  if (target instanceof PDFDict) {
    const record = {};
    for (const key of target.keys()) record[key.decodeText()] = streamRecord(document, target.get(key));
    return record;
  }
  return streamRecord(document, entry);
}

function widgetRecord(document, widget) {
  const rect = widget.getRectangle();
  const ap = widget.AP();
  const pick = (key) => (ap ? appearanceRecord(document, ap.get(PDFName.of(key))) : null);
  return {
    rect: [rect.x, rect.y, rect.width, rect.height],
    as: widget.getAppearanceState()?.decodeText() ?? null,
    flags: widget.getFlags(),
    da: widget.getDefaultAppearance() ?? null,
    normal: pick('N'),
    down: pick('D'),
    rollover: pick('R'),
  };
}

function formRecord(document) {
  const form = document.getForm();
  const fields = form.getFields();
  return {
    described: fields.map((field, index) => describeFormField(field, document, index)),
    detail: fields.map((field) => ({
      name: field.getName(),
      da: field.acroField.getDefaultAppearance() ?? null,
      flags: field.acroField.getFlags(),
      indices: field.acroField.dict.lookupMaybe(PDFName.of('I'), PDFArray)?.asArray().map((entry) => entry.asNumber()) ?? null,
      widgets: field.acroField.getWidgets().map((widget) => widgetRecord(document, widget)),
    })),
  };
}

const attempt = async (run) => {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

async function newDocument(pages) {
  const document = await PDFDocument.create();
  for (const [width, height] of pages) document.addPage([width, height]);
  const font = document.embedStandardFont(StandardFonts.Helvetica);
  return { document, font };
}

async function build(pages, fields) {
  const { document, font } = await newDocument(pages);
  const added = [];
  for (const field of fields) {
    const result = await attempt(() => addFormField(document, field, font));
    added.push(result.error ?? null);
    if (result.error) break;
  }
  const refreshed = await attempt(() => document.getForm().updateFieldAppearances(font));
  return { document, font, added, refreshed: refreshed.error ?? null };
}

const PAGE = [595.28, 841.89];

const CREATE_CASES = [
  {
    name: 'text-single',
    fields: [
      { name: 'full_name', type: 'text', page: 1, x: 50, y: 700, width: 200, height: 22, value: 'Ada Lovelace', label: ' Full name ' },
      { name: 'code', x: 50, y: 660, width: 120, height: 20, maxLength: 8, fontSize: 12, value: 'AB-12', required: true },
      { name: 'ro', type: 'text', x: 50, y: 620, width: 180, height: 18, value: 'fixed', readOnly: true, borderWidth: 2, borderColor: '#ff0000', backgroundColor: 'EEEEEE', textColor: '0000FF' },
      { name: 'empty', x: 300, y: 700, width: 150, height: 24 },
      { name: 'long', x: 300, y: 660, width: 90, height: 20, value: 'A value that is much longer than its box' },
      { name: 'accent', x: 300, y: 620, width: 150, height: 20, value: 'Café señor ÀÉ' },
    ],
  },
  {
    name: 'text-multiline',
    fields: [
      { name: 'reason', x: 50, y: 500, width: 240, height: 80, value: 'First line of the reason.\nSecond line that is long enough to wrap around the right edge of the box at the body size used.' },
      { name: 'comment', x: 320, y: 500, width: 200, height: 60, multiline: false, value: 'one line only' },
      { name: 'auto', x: 50, y: 380, width: 200, height: 70, multiline: true, fontSize: 0, value: 'Auto sized text that fills the box and wraps to several lines as needed' },
      { name: 'tabs', x: 300, y: 380, width: 220, height: 50, value: 'a\tb\r\nc' },
    ],
  },
  {
    name: 'checkbox',
    fields: [
      { name: 'agree', type: 'checkbox', x: 60, y: 300, width: 14, height: 14, value: true, label: 'I agree' },
      { name: 'later', type: 'checkbox', x: 60, y: 270, width: 12, height: 12, value: 'off' },
      { name: 'yes', type: 'checkbox', x: 60, y: 240, width: 20, height: 20, value: 'yes', borderWidth: 0, backgroundColor: 'FFFFCC' },
    ],
  },
  {
    name: 'dropdown',
    fields: [
      { name: 'country', type: 'dropdown', x: 50, y: 200, width: 160, height: 22, options: ['Korea', 'Japan', 'Germany'], value: 'Japan' },
      { name: 'custom', type: 'dropdown', x: 230, y: 200, width: 160, height: 22, options: ['a', 'b'], editable: true, value: 'free text' },
      { name: 'unset', type: 'dropdown', x: 410, y: 200, width: 120, height: 22, options: [1, 2] },
      { name: 'implied', type: 'dropdown', x: 410, y: 170, width: 120, height: 22, options: ['x'], value: 'not listed' },
    ],
  },
  {
    name: 'optionlist',
    fields: [
      { name: 'colours', type: 'optionlist', x: 50, y: 60, width: 150, height: 90, options: ['Red', 'Green', 'Blue', 'Amber'], value: ['Green', 'Amber'] },
      { name: 'one', type: 'optionlist', x: 230, y: 60, width: 150, height: 60, options: ['Alpha', 'Beta'], value: 'Beta' },
      { name: 'multi', type: 'optionlist', x: 410, y: 60, width: 130, height: 60, options: ['p', 'q', 'r'], multiselect: true },
    ],
  },
  {
    name: 'radio',
    fields: [
      {
        name: 'size',
        type: 'radio',
        x: 60,
        y: 400,
        width: 14,
        height: 14,
        options: [{ value: 'S', x: 60, y: 400 }, { value: 'M', x: 120, y: 400 }, { value: 'L', x: 180, y: 400 }],
        value: 'M',
        label: 'Size',
      },
      { name: 'plain', type: 'radio', x: 60, y: 360, width: 12, height: 12, options: ['yes', 'no'] },
    ],
  },
  {
    name: 'dotted',
    fields: [
      { name: 'person.first', x: 50, y: 700, width: 150, height: 20, value: 'Ada' },
      { name: 'person.last', x: 220, y: 700, width: 150, height: 20, value: 'Lovelace' },
      { name: 'person.address.city', x: 50, y: 660, width: 150, height: 20 },
    ],
  },
  {
    name: 'second-page',
    pages: [PAGE, [300, 400]],
    fields: [
      { name: 'p1', page: 1, x: 10, y: 10, width: 100, height: 20 },
      { name: 'p2', page: 2, x: 20, y: 300, width: 200, height: 24, value: 'on page two' },
    ],
  },
  { name: 'err-page', fields: [{ name: 'x', page: 3, x: 1, y: 1, width: 50, height: 20 }] },
  {
    name: 'err-duplicate',
    fields: [
      { name: 'dup', x: 10, y: 10, width: 50, height: 20 },
      { name: 'dup', x: 10, y: 40, width: 50, height: 20 },
    ],
  },
  { name: 'err-nonterminal', fields: [{ name: 'a.b', x: 10, y: 10, width: 50, height: 20 }, { name: 'a', x: 10, y: 40, width: 50, height: 20 }] },
  { name: 'err-empty-part', fields: [{ name: 'a..b', x: 10, y: 10, width: 50, height: 20 }] },
  { name: 'err-colour', fields: [{ name: 'c', x: 10, y: 10, width: 50, height: 20, textColor: 'nothex' }] },
  { name: 'err-maxlength', fields: [{ name: 'm', x: 10, y: 10, width: 100, height: 20, maxLength: 3, value: 'toolong' }] },
  { name: 'err-unencodable', fields: [{ name: 'u', x: 10, y: 10, width: 100, height: 20, value: '한국어' }] },
];

for (const entry of CREATE_CASES) {
  const pages = entry.pages ?? [PAGE];
  const fields = structuredClone(entry.fields);
  const { document, added, refreshed } = await build(pages, fields);
  const record = { name: entry.name, pages, fields: entry.fields, added, refreshed };
  if (!added.some(Boolean) && !refreshed) Object.assign(record, formRecord(document));
  out.create.push(record);
}

// ---- lint ----------------------------------------------------------------------------------------------------------

const box = (name, x, y, width, height, extra = {}) => ({ name, x, y, width, height, ...extra });
const LINT_CASES = [
  { name: 'clean', pages: [PAGE], fields: [box('a', 10, 10, 100, 20), box('b', 10, 40, 100, 20, { type: 'checkbox', width: 12, height: 12 })] },
  { name: 'missing-name', pages: [PAGE], fields: [box('', 10, 10, 100, 20), { x: 10, y: 40, width: 100, height: 20 }] },
  { name: 'duplicate', pages: [PAGE], fields: [box('a', 10, 10, 100, 20), box('a', 10, 40, 100, 20)] },
  { name: 'bad-box', pages: [PAGE], fields: [box('a', 10, 10, 0, 20), box('b', 'x', 10, 5, 5), { name: 'c' }, box('d', 10, 10, -3, 5)] },
  { name: 'outside', pages: [PAGE, [200, 200]], fields: [box('a', 500, 10, 100, 20), box('b', 10, 10, 100, 20, { page: 2 }), box('c', -1, 10, 20, 20), box('d', 100, 150, 120, 80, { page: 2 })] },
  { name: 'page-out-of-range', pages: [PAGE], fields: [box('a', 10, 10, 100, 20, { page: 5 }), box('b', 10, 10, 100, 20, { page: 1.5 }), box('c', 10, 10, 100, 20, { page: 0 }), box('d', 10, 10, 100, 20, { page: '2' })] },
  { name: 'too-small', pages: [PAGE], fields: [box('a', 10, 10, 20, 20), box('b', 10, 40, 100, 8), box('c', 10, 60, 7, 7, { type: 'Radio' }), box('d', 10, 80, 7.995, 8, { type: 'checkbox' }), box('e', 10, 100, 23.995, 11.995)] },
  { name: 'overlap', pages: [PAGE], fields: [box('a', 10, 10, 100, 20), box('b', 50, 20, 100, 20), box('c', 110, 10, 50, 20), box('d', 10, 10, 100, 20, { page: 2 })] },
  { name: 'aliases', pages: [PAGE], fields: [{ name: 'a', rect: [10, 20, 100, 24], kind: 'checkbox' }, { name: 'b', box: ['10', '50', 100, 20] }, { name: 'c', rect: [1, 2, 3], x: 5 }, { name: 'd', rect: [1, 2, 3, 4], x: 5, kind: 'dropdown', type: 'text' }, { name: 'e', rect: [1, 2, 3, 4], kind: null }] },
  { name: 'coercions', pages: [PAGE], fields: [{ name: 7, x: '10', y: 10, width: 100, height: 20, type: 'TEXT' }, { name: ['a', 'b'], x: null, y: 10, width: 100, height: 20 }, { name: 'z', x: 10, y: true, width: 100, height: 20, page: null }] },
];
for (const entry of LINT_CASES) {
  const fields = structuredClone(entry.fields);
  const result = lintPdfFormFields(fields, entry.pages);
  out.lint.push({ name: entry.name, pages: entry.pages, fields: entry.fields, result, adopted: fields });
}

// ---- fill ----------------------------------------------------------------------------------------------------------

const BASE_FIELDS = [
  { name: 'name', x: 50, y: 750, width: 180, height: 22, value: 'old' },
  { name: 'note', x: 50, y: 660, width: 220, height: 70 },
  { name: 'agree', type: 'checkbox', x: 300, y: 750, width: 14, height: 14 },
  { name: 'country', type: 'dropdown', x: 50, y: 620, width: 160, height: 22, options: ['Korea', 'Japan', 'Germany'] },
  { name: 'free', type: 'dropdown', x: 230, y: 620, width: 160, height: 22, options: ['a', 'b'], editable: true },
  { name: 'colours', type: 'optionlist', x: 50, y: 520, width: 150, height: 80, options: ['Red', 'Green', 'Blue'] },
  { name: 'size', type: 'radio', x: 300, y: 600, width: 14, height: 14, options: [{ value: 'S', x: 300, y: 600 }, { value: 'M', x: 350, y: 600 }, { value: 'L', x: 400, y: 600 }] },
  { name: 'tiny', x: 300, y: 520, width: 60, height: 16 },
  { name: 'person.first', x: 50, y: 480, width: 150, height: 20 },
  { name: 'sized', x: 300, y: 480, width: 100, height: 24, fontSize: 14 },
];
const base = await build([PAGE], structuredClone(BASE_FIELDS));
const basePdf = Buffer.from(await base.document.save({ useObjectStreams: true, addDefaultPage: false }));
out.fillBase = { pages: [PAGE], fields: BASE_FIELDS, pdf: basePdf.toString('base64') };

const FILL_CASES = [
  { name: 'text-and-checks', values: { name: 'Ada Lovelace', note: 'Short note', agree: true } },
  { name: 'checkbox-words', values: { agree: 'No' } },
  { name: 'checkbox-off-zero', values: { agree: 0 } },
  { name: 'checkbox-yes-word', values: { agree: 'yes' } },
  { name: 'checkbox-unchecked', values: { agree: 'Unchecked' } },
  { name: 'checkbox-slash-off', values: { agree: '/Off' } },
  { name: 'checkbox-false', values: { agree: false } },
  { name: 'checkbox-empty', values: { agree: '' } },
  { name: 'checkbox-null', values: { agree: null } },
  { name: 'choice', values: { country: 'Japan', colours: ['Red', 'Blue'], size: 'M' } },
  { name: 'choice-slash', values: { country: '/Korea', size: '/L' } },
  { name: 'editable-free', values: { free: 'anything at all' } },
  { name: 'colours-single', values: { colours: 'Green' } },
  { name: 'dotted', values: { 'person.first': 'Ada' } },
  { name: 'empty-text', values: { name: '' } },
  { name: 'null-text', values: { name: null } },
  { name: 'number-text', values: { name: 12.5 } },
  { name: 'clipped-width', values: { tiny: 'This does not fit the tiny box', name: 'Short' } },
  { name: 'clipped-height', values: { note: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three' } },
  { name: 'clipped-newlines', values: { note: 'a\nb\nc\nd\ne\nf\ng\nh' } },
  { name: 'fits', values: { note: 'fits', sized: 'ok' } },
  { name: 'blank-not-measured', values: { tiny: '   ' } },
  { name: 'err-unknown-name', values: { nope: 'x', alsonope: 'y', name: 'z' } },
  { name: 'err-unknown-option', values: { country: 'France' } },
  { name: 'err-unknown-radio', values: { size: 'XL' } },
  { name: 'err-unknown-list', values: { colours: ['Red', 'Pink', 'Mauve'] } },
  { name: 'dropdown-two-values', values: { country: ['Korea', 'Japan'] } },
  { name: 'no-values', values: {} },
];
for (const entry of FILL_CASES) {
  const document = await PDFDocument.load(basePdf);
  const font = document.embedStandardFont(StandardFonts.Helvetica);
  const form = document.getForm();
  const record = { name: entry.name, values: entry.values };
  const filled = await attempt(() => fillFormValues(form, entry.values));
  if (filled.error) record.error = filled.error;
  else {
    record.filled = filled.value;
    form.updateFieldAppearances(font);
    record.clipped = clippedFormValues(document, form, entry.values, font);
    Object.assign(record, formRecord(document));
  }
  out.fill.push(record);
}

// A loaded form with no font given to the clip check, and a check with no values at all.
{
  const document = await PDFDocument.load(basePdf);
  const form = document.getForm();
  out.clippedNoFont = clippedFormValues(document, form, { tiny: 'This does not fit the tiny box' }, null);
}

const fixtures = path.join(FIXTURES_ROOT, 'office-forms');
mkdirSync(fixtures, { recursive: true });
const data = `${JSON.stringify(out, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value))}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-forms', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.create.length} create cases, ${out.lint.length} lint cases, ${out.fill.length} fill cases`);
