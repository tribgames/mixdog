#!/usr/bin/env node
// Golden of the pptx writer's text boxes and tables (crate mixdog-office-author, module pptx_writer: text and table):
// the package pptxgenjs 4.0.1 writes for scripted addText and addTable calls: the options `authoring/pptx-html-build.mjs`
// passes (runs with font, size, colour, transparency, letter spacing, highlight and soft breaks; the box with its margins,
// anchor, alignment, wrap, line spacing, rotation, frame shape, fill, outline and shadow; tables with cell fills, borders,
// margins, spans, column widths and row heights) and the options around them (bullets, paragraph spacing, tab stops,
// underline, strike, baseline, glow, outline, hyperlinks, autofit, insets, vertical text, table defaults and borders).
// Writes native/core/fixtures/office-pptx-writer-text/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-pptx-writer-text.mjs --tree <product tree>
//
// A case is a list of calls, JSON as the replay reads it back: { op, slide?, ... } (op is layout, addSlide, addShape,
// addText, addTable, addNotes), each run against pptxgenjs on a deep copy of its options (pptxgenjs rewrites the options
// it is given). A call that throws is recorded with `thrown`. What a case records is the package: every entry of the zip
// in order, the content of each by a blob id (an XML part or a relationships part as text, anything else as base64;
// identical parts of different cases are one blob).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-pptx-writer-text.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-pptx-writer-text');
const stage = stageSet(finalDir);

const need = createRequire(join(tree, 'package.json'));
const PptxGenJS = need('pptxgenjs');
const JSZip = need('jszip');

// ---- call helpers ------------------------------------------------------------------------------------------------
const add = () => ({ op: 'addSlide' });
const shape = (slide, name, options) => ({ op: 'addShape', slide, shape: name, options });
const text = (slide, content, options) => ({ op: 'addText', slide, text: content, ...(options === undefined ? {} : { options }) });
const table = (slide, rows, options) => ({ op: 'addTable', slide, rows, ...(options === undefined ? {} : { options }) });
const wide = { op: 'layout', name: 'LAYOUT_WIDE' };
const box = { x: 1, y: 1, w: 4, h: 1 };

// What authoring/pptx-html-build.mjs passes for a measured text item.
const run = (content, extra = {}) => ({
  text: content,
  options: { fontFace: 'Arial', fontSize: 18, bold: false, italic: false, color: '202124', charSpacing: 0, ...extra },
});
const htmlText = (i) => ({
  x: 0.6 + i * 0.3,
  y: 0.5 + i * 0.4,
  w: 5.5,
  h: 0.8,
  margin: [0, 0, 0, 2.5 + i],
  valign: i % 2 ? 'middle' : 'top',
  align: ['left', 'center', 'right', 'justify'][i % 4],
  wrap: i % 3 !== 0,
  lineSpacingMultiple: [1, 1.2, 0.95][i % 3],
  ...(i % 4 === 1 ? { rotate: 3.5 } : {}),
});

const cases = [];
const addCase = (name, calls) => cases.push({ name, calls });

addCase('html build: runs, soft breaks and a measured box', [
  wide,
  add(),
  text(0, [run('Retention rose '), run('after onboarding', { bold: true, color: 'B85042', fontSize: 20.25, charSpacing: -0.15 }), run('second line', { softBreakBefore: true }), run(' faded', { transparency: 40 }), run(' marked', { highlight: 'FFF2A8' })], htmlText(0)),
  text(0, [run('Aligned ', { italic: true })], htmlText(1)),
  text(0, [run('Right')], htmlText(2)),
  text(0, [run('Justify me please')], htmlText(3)),
  text(0, [run('Centre middle', { fontSize: 31.5 })], { ...htmlText(5), valign: 'middle', align: 'center' }),
]);
addCase('html build: framed boxes (shape, fill, outline, shadow, radius)', [
  wide,
  add(),
  text(0, [run('Pill label', { color: 'FFFFFF', bold: true })], { ...htmlText(0), shape: 'roundRect', rectRadius: 0.2, fill: { color: '1A73E8' }, line: { type: 'none' }, align: 'center' }),
  text(0, [run('Outlined card')], { ...htmlText(1), shape: 'rect', fill: { color: 'FFFFFF', transparency: 20 }, line: { color: '5F6368', width: 1.5 } }),
  text(0, [run('Ellipse')], { ...htmlText(2), shape: 'ellipse', fill: { color: 'E8F0FE' }, line: { color: '1A73E8', width: 0.75 }, shadow: { type: 'outer', color: '000000', opacity: 0.25, blur: 6, offset: 4.2, angle: 45 }, align: 'center' }),
  text(0, [run('Rounded with radius and rotation')], { ...htmlText(3), shape: 'roundRect', rectRadius: 0.1, rotate: 12.34, fill: { color: 'F8F9FA' }, line: { color: 'DADCE0', width: 1 } }),
  shape(0, 'rect', { x: 1, y: 6, w: 1, h: 1, fill: { color: '123456' } }),
  text(0, 'after a shape', box),
]);
addCase('plain strings', [
  add(),
  text(0, 'Hello'),
  text(0, 'Hello with options', { ...box, fontSize: 24, color: 'AA0000', bold: true }),
  text(0, 'Tags <b> & "quotes" \'single\'', box),
  text(0, '한국어 텍스트 — 발표', { ...box, fontFace: 'Noto Sans KR' }),
  text(0, '', box),
  text(0, 'Line one\nLine two\r\nLine three\r\r\nLine four', { ...box, fontSize: 14 }),
  text(0, 'trailing break\n', box),
  text(0, '\nleading break', box),
  text(0, 'Two\n\nblank lines', box),
]);
addCase('runs without options and empty runs', [
  add(),
  text(0, [{ text: 'plain' }, { text: ' more', options: {} }], box),
  text(0, [], box),
  text(0, [{ text: '' }], { ...box, fontSize: 10 }),
  text(0, [{ text: 'one\ntwo', options: { bold: true } }, { text: ' tail' }], box),
  text(0, [{ text: 'a', options: { breakLine: true } }, { text: 'b', options: { breakLine: true } }, { text: 'c' }], { ...box, fontSize: 12 }),
  text(0, [{ text: 'sized', options: { fontSize: 20 } }, { text: 'unsized', options: { breakLine: true } }, { text: 'after' }], box),
]);
addCase('paragraphs: alignment, bullets, numbering, spacing', [
  add(),
  text(0, [{ text: 'left', options: { align: 'left', breakLine: true } }, { text: 'centre', options: { align: 'center', breakLine: true } }, { text: 'right', options: { align: 'right' } }], box),
  text(0, [{ text: 'one', options: { bullet: true } }, { text: 'two', options: { bullet: true } }, { text: 'three', options: { bullet: { indent: 15 } } }], box),
  text(0, [{ text: 'first', options: { bullet: { type: 'number' } } }, { text: 'second', options: { bullet: { type: 'number', style: 'romanLcPeriod', numberStartAt: 4 } } }, { text: 'third', options: { bullet: { type: 'number', startAt: 2 } } }], box),
  text(0, [{ text: 'star', options: { bullet: { characterCode: '2605' } } }, { text: 'bad code', options: { bullet: { characterCode: 'XYZ' } } }, { text: 'old code', options: { bullet: { code: '25B6' } } }, { text: 'odd type', options: { bullet: { type: 'bullet' } } }], box),
  text(0, [{ text: 'level 0', options: { bullet: true } }, { text: 'level 1', options: { bullet: true, indentLevel: 1 } }, { text: 'level 2', options: { bullet: { indent: 20 }, indentLevel: 2 } }], box),
  text(0, 'Spaced', { ...box, lineSpacing: 24, paraSpaceBefore: 6, paraSpaceAfter: 12 }),
  text(0, 'Multiple', { ...box, lineSpacingMultiple: 1.5, paraSpaceAfter: 3 }),
  text(0, 'Both spacings', { ...box, lineSpacing: 20, lineSpacingMultiple: 2 }),
  text(0, 'bulleted string', { ...box, bullet: true }),
  text(0, [{ text: 'main bullet 1' }, { text: 'main bullet 2' }], { ...box, bullet: { type: 'number' } }),
  text(0, 'tabs\tand stops', { ...box, tabStops: [{ position: 2 }, { position: 4, alignment: 'r' }] }),
  text(0, [{ text: 'rtl', options: { rtlMode: true } }], box),
  text(0, 'no bullet', { ...box, bullet: false }),
  text(0, [{ text: 'line', options: { breakLine: true, bullet: true } }, { text: 'next', options: { bullet: true } }], box),
]);
addCase('run formatting', [
  add(),
  text(0, [{ text: 'bold italic', options: { bold: true, italic: true, fontSize: 11.5 } }], box),
  text(0, [{ text: 'struck', options: { strike: true } }, { text: 'double', options: { strike: 'dblStrike' } }], box),
  text(0, [{ text: 'u1', options: { underline: true } }, { text: 'u2', options: { underline: { style: 'wavy', color: 'FF0000' } } }, { text: 'u3', options: { underline: 'dbl' } }, { text: 'u4', options: { underline: { color: '00FF00' } } }], box),
  text(0, [{ text: 'base', options: { baseline: 20 } }, { text: 'sub', options: { subscript: true } }, { text: 'sup', options: { superscript: true } }], box),
  text(0, [{ text: 'spaced', options: { charSpacing: 2.5 } }, { text: 'tight', options: { charSpacing: -1 } }], box),
  text(0, [{ text: 'glow', options: { glow: { size: 10, color: 'FFCC00', opacity: 0.5 } } }, { text: 'glow defaults', options: { glow: {} } }], box),
  text(0, [{ text: 'outlined', options: { outline: { size: 2, color: 'FF0000' } } }, { text: 'outline defaults', options: { outline: {} } }], box),
  text(0, [{ text: 'tinted', options: { color: 'accent2', transparency: 30 } }, { text: 'hex hash', options: { color: '#0A0B0C' } }, { text: 'bad', options: { color: 'zzz' } }, { text: 'HI', options: { highlight: 'FFFF00' } }], box),
  text(0, [{ text: 'lang', options: { lang: 'ko-KR' } }, { text: 'font', options: { fontFace: 'Noto Serif KR', fontSize: 30 } }], box),
  text(0, 'Inherit', { ...box, bold: true, italic: true, fontSize: 22, fontFace: 'Georgia', color: '336699', charSpacing: 1, underline: true }),
  text(0, [{ text: 'a' }, { text: 'b', options: { bold: false, color: 'FF0000' } }], { ...box, bold: true, color: '00FF00', fontSize: 16 }),
]);
addCase('hyperlinks in text', [
  add(),
  add(),
  text(0, [{ text: 'site', options: { hyperlink: { url: 'https://example.com/?a=1&b=2', tooltip: 'Go "now"' } } }, { text: ' plain' }], box),
  text(0, [{ text: 'to slide', options: { hyperlink: { slide: 2, tooltip: 'Slide 2' } } }], box),
  text(0, [{ text: 'colored link', options: { hyperlink: { url: 'https://example.com' }, color: '0000FF' } }], box),
  text(0, 'whole box link', { ...box, hyperlink: { url: 'https://box.test' } }),
  text(0, [{ text: 'run' }], { ...box, hyperlink: { url: 'https://main-only.test' } }),
  shape(0, 'rect', { ...box, hyperlink: { url: 'https://shape.test' } }),
  text(0, [{ text: 'after', options: { hyperlink: { url: 'https://after.test' } } }], box),
  text(1, [{ text: 'slide two', options: { hyperlink: { url: 'https://two.test' } } }], box),
]);
addCase('body properties', [
  add(),
  text(0, 'fit none', { ...box, fit: 'none' }),
  text(0, 'fit shrink', { ...box, fit: 'shrink' }),
  text(0, 'fit resize', { ...box, fit: 'resize' }),
  text(0, 'autofit', { ...box, autoFit: true }),
  text(0, 'shrinkText', { ...box, shrinkText: true }),
  text(0, 'inset', { ...box, inset: 0.25 }),
  text(0, 'inset zero', { ...box, inset: 0 }),
  text(0, 'margin number', { ...box, margin: 4 }),
  text(0, 'margin zero', { ...box, margin: 0 }),
  text(0, 'margin array', { ...box, margin: [1, 2, 3, 4] }),
  text(0, 'margin short', { ...box, margin: [5] }),
  text(0, 'margin and inset', { ...box, inset: 0.5, margin: [6, 7, 8, 9] }),
  text(0, 'vertical', { ...box, vert: 'vert270' }),
  text(0, 'bottom', { ...box, valign: 'bottom' }),
  text(0, 'btm', { ...box, valign: 'btm' }),
  text(0, 'top', { ...box, valign: 'top' }),
  text(0, 'mid', { ...box, valign: 'm' }),
  text(0, 'nowrap', { ...box, wrap: false }),
  text(0, 'justify', { ...box, align: 'justify' }),
  text(0, 'jx', { ...box, align: 'J' }),
  text(0, 'unknown align', { ...box, align: 'sideways' }),
]);
addCase('positions, geometry and names', [
  add(),
  text(0, 'defaults'),
  text(0, 'zero', { x: 0, y: 0, w: 0, h: 0 }),
  text(0, 'percent', { x: '10%', y: '20%', w: '50%', h: '25%' }),
  text(0, 'emu', { x: 914400, y: 457200, w: 3657600, h: 914400 }),
  text(0, 'string numbers', { x: '2', y: '1.5', w: '3', h: '1' }),
  text(0, 'rotated', { ...box, rotate: 45 }),
  text(0, 'flipped', { ...box, flipH: true, flipV: true, rotate: 10 }),
  text(0, 'named <&>', { ...box, objectName: 'Title <&> "x"' }),
  text(0, [{ text: 'named runs' }], { ...box, objectName: 'Body & more' }),
  text(0, 'text box', { ...box, isTextBox: true }),
  text(0, 'round', { ...box, shape: 'roundRect', rectRadius: 0.5, fill: 'FFCC00' }),
  text(0, 'pie', { ...box, shape: 'pie', angleRange: [30, 150], fill: { color: 'CCCCCC' } }),
  text(0, 'arc', { ...box, shape: 'blockArc', angleRange: [270, 90], arcThicknessRatio: 0.4 }),
  text(0, 'string fill', { ...box, fill: 'abcdef' }),
  text(0, 'none fill', { ...box, fill: { type: 'none' } }),
  text(0, 'scheme fill', { ...box, fill: { color: 'accent3', transparency: 50 } }),
  text(0, 'line props', { ...box, line: { color: 'FF0000', width: 2, dashType: 'dash', beginArrowType: 'triangle', endArrowType: 'arrow' } }),
  text(0, 'line none', { ...box, line: { type: 'none' } }),
]);
addCase('shadows and the line shape', [
  add(),
  text(0, 'outer', { ...box, shadow: { type: 'outer' } }),
  text(0, 'empty shadow', { ...box, shadow: {} }),
  text(0, 'inner', { ...box, shadow: { type: 'inner', color: 'FF0000', blur: 3, offset: 2, angle: 180, opacity: 0.5 } }),
  text(0, 'none', { ...box, shadow: { type: 'none', blur: 20 } }),
  text(0, 'engraved', { ...box, shadow: { type: 'engraved', color: '#abc', angle: 720, opacity: 7 } }),
  text(0, 'line', { x: 1, y: 3, w: 5, h: 0, shape: 'line', line: { color: '00AA00', width: 2 } }),
  text(0, 'line with align', { x: 1, y: 3, w: 5, h: 0, shape: 'line', align: 'center', line: { color: '00AA00' } }),
  text(0, 'line none type', { x: 1, y: 3, w: 5, h: 0, shape: 'line', line: { type: 'none' } }),
  text(0, 'zero height align', { x: 1, y: 3, w: 5, h: 0, align: 'right' }),
]);
addCase('objects in order: shapes, texts, notes', [
  add(),
  shape(0, 'rect', { ...box, fill: 'EEEEEE' }),
  text(0, 'first text', box),
  { op: 'addNotes', slide: 0, text: 'notes between' },
  text(0, 'second text', box),
  shape(0, 'ellipse', box),
  text(0, [{ text: 'third text' }], box),
  add(),
  text(1, 'other slide', box),
  shape(1, 'rect', box),
  text(1, 'again', box),
]);

// ---- tables ---------------------------------------------------------------------------------------------------------
const edge = (e) => (e ? { type: 'solid', pt: e.w, color: e.c } : { type: 'none' });
const htmlCell = (content, extra = {}) => ({
  text: content,
  options: {
    fontFace: 'Arial',
    fontSize: 12.75,
    bold: false,
    color: '202124',
    fill: { color: 'FFFFFF' },
    align: 'left',
    valign: 'middle',
    margin: [0.05, 0.1, 0.05, 0.1],
    border: [edge(null), edge(null), edge({ w: 0.75, c: 'DADCE0' }), edge(null)],
    ...extra,
  },
});
const htmlTable = (rows, widths, heights) => ({
  x: 0.8,
  y: 1.6,
  w: widths.reduce((a, b) => a + b, 0),
  h: heights.reduce((a, b) => a + b, 0),
  colW: widths,
  rowH: heights,
});

addCase('html build: a measured table', [
  wide,
  add(),
  table(
    0,
    [
      [htmlCell('Metric', { bold: true, fill: { color: 'F1F3F4' } }), htmlCell('Q1', { bold: true, align: 'right', fill: { color: 'F1F3F4' } }), htmlCell('Q2', { bold: true, align: 'right', fill: { color: 'F1F3F4' } })],
      [htmlCell('Retention'), htmlCell('41%', { align: 'right' }), htmlCell('57%', { align: 'right', color: 'B85042' })],
      [htmlCell('Tickets', { border: [edge({ w: 1, c: '000000' }), edge({ w: 1, c: '000000' }), edge({ w: 1, c: '000000' }), edge({ w: 1, c: '000000' })] }), htmlCell('1,204', { align: 'right' }), htmlCell('987', { align: 'right' })],
    ],
    htmlTable(null, [3.2, 1.6, 1.6], [0.42, 0.42, 0.55]),
  ),
  table(0, [[htmlCell('Wide cell', { colspan: 2, fill: { color: 'E8F0FE' } }), htmlCell('x')], [htmlCell('a'), htmlCell('b'), htmlCell('c')]], { ...htmlTable(null, [2, 2, 2], [0.4, 0.4]), y: 4.5 }),
]);
addCase('plain rows with table defaults', [
  add(),
  table(0, [['a', 'b'], ['c', 'd']]),
  table(0, [['a', 'b'], ['c', 'd']], { x: 1, y: 3, w: 6, h: 2 }),
  table(0, [['x', 'y', 'z']], { x: 1, y: 6, colW: [1, 2, 3], rowH: 0.5, fontSize: 14, color: '336699', fill: { color: 'EEEEEE' }, align: 'center', valign: 'bottom', bold: true, fontFace: 'Georgia' }),
  table(0, [[1, 2.5], [{ text: 3 }, { text: 'four' }]], { x: 1, y: 7 }),
]);
addCase('table borders', [
  add(),
  table(0, [['a', 'b']], { x: 1, y: 1, border: { type: 'solid', color: '112233', pt: 2 } }),
  table(0, [['a', 'b']], { x: 1, y: 2, border: [{ type: 'solid', pt: 0 }, null, { type: 'dash', color: 'FF0000' }] }),
  table(0, [['a', { text: 'b', options: { border: { type: 'dash', color: 'AA00AA', pt: 3 } } }, { text: 'c', options: { border: [null, { type: 'solid', pt: 0 }, { pt: 1.25 }] } }]], { x: 1, y: 3, border: { type: 'solid', color: '000000', pt: 1 } }),
  table(0, [[{ text: 'plain cell border', options: {} }, 'str']], { x: 1, y: 4 }),
  table(0, [[{ text: 'default borders', options: { border: [{}, {}, {}, {}] } }]], { x: 1, y: 5 }),
  table(0, [['no border option']], { x: 1, y: 6, border: null }),
]);
addCase('table sizes: colW, w, h, rowH', [
  add(),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 1, colW: 2 }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 2, colW: [2] }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 3, colW: [1, 2] }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 4, colW: [1, 2, 3], w: 8 }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 5, w: 9 }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 6, w: '50%', h: '30%' }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 7, w: 9, h: 3 }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 8, rowH: 0.7 }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 9, rowH: [0.3] }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 1, y: 9, rowH: [0.3, 0] , h: 2}),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: '5%', y: '5%', colW: [1, 1, 1], rowH: [0.5, 0.5] }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 0, y: 0 }),
  table(0, [['a', 'b', 'c'], ['d', 'e', 'f']], { x: 914400, y: 457200, w: 7315200, h: 1828800 }),
  table(0, [['a']], { x: 0.00001, y: 12, w: 0.00002, h: 0.00003 }),
  table(0, [['a', 'b']], { colW: ['2', '3'] }),
]);
addCase('table cells: margins, anchors, text direction, spans', [
  add(),
  table(0, [[{ text: 'pts', options: { margin: [3, 4, 5, 6] } }, { text: 'zero', options: { margin: 0 } }, { text: 'num', options: { margin: 0.2 } }, { text: 'short', options: { margin: [0.3] } }]], { x: 1, y: 1 }),
  table(0, [[{ text: 'c', options: { valign: 'c' } }, { text: 'm', options: { valign: 'M' } }, { text: 'mid', options: { valign: 'middle' } }, { text: 'center', options: { valign: 'center' } }, { text: 'top', options: { valign: 'top' } }, { text: 'btm', options: { valign: 'btm' } }, { text: 'bot', options: { valign: 'bottom' } }, { text: 'odd', options: { valign: 'baseline' } }]], { x: 1, y: 2 }),
  table(0, [[{ text: 'vert', options: { textDirection: 'vert270' } }, { text: 'horz', options: { textDirection: 'horz' } }]], { x: 1, y: 3 }),
  table(0, [[{ text: 'span2', options: { colspan: 2 } }, 'c'], ['a', 'b', 'c']], { x: 1, y: 4 }),
  table(0, [[{ text: 'rowspan', options: { rowspan: 2 } }, 'b', 'c'], ['e', 'f']], { x: 1, y: 5 }),
  table(0, [[{ text: 'both', options: { rowspan: 2, colspan: 2 } }, 'c'], ['f'], ['g', 'h', 'i']], { x: 1, y: 6 }),
  table(0, [['a', { text: 'rs3', options: { rowspan: 3 } }, 'c'], ['d', 'f'], ['g', 'i']], { x: 1, y: 7 }),
  table(0, [[{ text: 'span3', options: { colspan: 3 } }], ['a', 'b', 'c']], { x: 1, y: 8, colW: [1, 1, 1] }),
  table(0, [[{ text: 'a', options: { colspan: 1, rowspan: 1 } }, 'b']], { x: 1, y: 9 }),
]);
addCase('table text: fonts, runs, breaks, links', [
  add(),
  add(),
  table(0, [[{ text: 'Line one\nLine two', options: { fontSize: 11, bold: true } }, { text: 'Tags <&>', options: { fontFace: 'Arial' } }]], { x: 1, y: 1 }),
  table(0, [[{ text: [{ text: 'bold ', options: { bold: true } }, { text: 'plain' }, { text: 'red', options: { color: 'FF0000', breakLine: true } }, { text: 'next line' }] }, 'b']], { x: 1, y: 2 }),
  table(0, [[{ text: [{ text: 'link', options: { hyperlink: { url: 'https://example.com/a&b', tooltip: 't' } } }], options: { color: '333333' } }, 'b']], { x: 1, y: 3 }),
  table(0, [[{ text: 'cell link', options: { hyperlink: { slide: 2 } } }]], { x: 1, y: 4 }),
  table(0, [['mentions hyperlink in text', 'b']], { x: 1, y: 5 }),
  table(0, [[{ text: 'underlined', options: { underline: true } }, { text: 'styled', options: { underline: { style: 'dbl', color: '00FF00' } } }, { text: 'inherits', options: {} }]], { x: 1, y: 6, underline: { style: 'sng' } }),
  table(0, [[{ text: '', options: { fontSize: 20 } }, { text: '', options: {} }, { text: 'x' }]], { x: 1, y: 7 }),
  table(0, [[{ text: [], options: {} }]], { x: 1, y: 8 }),
  table(0, [[{ text: 'zero size', options: { fontSize: 0 } }, { text: 'bold false', options: { bold: false } }]], { x: 1, y: 9, bold: true, fontSize: 9 }),
  table(1, [['slide two', 'b']], { x: 1, y: 1 }),
  table(1, [['second table on slide two']], { x: 1, y: 4 }),
]);
addCase('tables among shapes and texts', [
  add(),
  text(0, 'before', box),
  table(0, [['a']], { x: 1, y: 3 }),
  shape(0, 'rect', box),
  table(0, [['b']], { x: 1, y: 5, objectName: 'My <table>' }),
  text(0, 'after', box),
  add(),
  table(1, [['c']], { x: 1, y: 1 }),
  add(),
  table(2, [['d']], { x: 1, y: 1 }),
  table(2, [['e']], { x: 1, y: 3 }),
]);

// ---- run each case against pptxgenjs --------------------------------------------------------------------------------
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const blobs = {};
const blobOf = (name, bytes) => {
  const textual = /\.(xml|rels)$/.test(name);
  const body = textual ? { text: bytes.toString('utf8') } : { base64: bytes.toString('base64') };
  const id = sha(JSON.stringify(body));
  blobs[id] = body;
  return id;
};

const warn = console.warn;
const error = console.error;
const log = console.log;
async function runCase(calls) {
  console.warn = console.error = console.log = () => {};
  try {
    const pres = new PptxGenJS();
    const slides = [];
    const recorded = [];
    for (const call of calls) {
      const record = { ...call };
      try {
        const options = clone(call.options);
        switch (call.op) {
          case 'layout':
            pres.layout = call.name;
            break;
          case 'addSlide':
            slides.push(pres.addSlide());
            break;
          case 'addShape':
            slides[call.slide].addShape(call.shape, options);
            break;
          case 'addText':
            slides[call.slide].addText(clone(call.text), options);
            break;
          case 'addTable':
            slides[call.slide].addTable(clone(call.rows), options);
            break;
          case 'addNotes':
            slides[call.slide].addNotes(call.text);
            break;
          default:
            throw new Error(`recorder: unknown op ${call.op}`);
        }
      } catch (caught) {
        record.thrown = String(caught?.message ?? caught);
      }
      recorded.push(record);
    }
    const zip = await JSZip.loadAsync(await pres.write({ outputType: 'nodebuffer' }));
    const parts = [];
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (entry.dir) parts.push({ name, dir: true });
      else parts.push({ name, blob: blobOf(name, Buffer.from(await entry.async('uint8array'))) });
    }
    return { calls: recorded, parts };
  } finally {
    console.warn = warn;
    console.error = error;
    console.log = log;
  }
}

const recorded = [];
for (const { name, calls } of cases) recorded.push({ name, ...(await runCase(calls)) });

const golden = {
  note: 'Recorded from pptxgenjs 4.0.1 (dist/pptxgen.cjs.js) driven by scripted addText and addTable calls; tests/twin_pptx_writer_text.rs replays the calls against the Rust writer.',
  pptxgenjs: JSON.parse(readFileSync(join(tree, 'node_modules', 'pptxgenjs', 'package.json'), 'utf8')).version,
  blobs,
  cases: recorded,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-pptx-writer-text', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json: ${recorded.length} cases, ${Object.keys(blobs).length} blobs`);
