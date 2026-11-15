#!/usr/bin/env node
// Golden of the pptx writer (crate mixdog-office-author, module pptx_writer): the package pptxgenjs 4.0.1 writes for
// scripted API calls, the subset `authoring/pptx-html-build.mjs` uses and the options around it (layout, defineLayout,
// the document properties and theme fonts, addSlide, addShape with fills, outlines, shadows, corner radius, arcs,
// rotation, flips and hyperlinks, addImage with sizing, rounding, transparency, shadow and hyperlink, slide
// backgrounds, slide numbers, notes, hidden slides). Writes native/core/fixtures/office-pptx-writer/golden.json and the
// set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-pptx-writer.mjs --tree <product tree>
//
// A case is a list of calls, JSON as the replay reads it back: { op, slide?, ... } (op is layout, defineLayout, set,
// addSlide, hidden, background, slideNumber, addShape, addImage, addNotes), each run against pptxgenjs on a deep copy
// of its options (pptxgenjs rewrites a shadow object it is given). A call that throws is recorded with `thrown`.
// What a case records is the package: every entry of the zip in order, the content of each by a blob id (an XML part
// or a relationships part as text, anything else as base64; identical parts of different cases are one blob).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-pptx-writer.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-pptx-writer');
const stage = stageSet(finalDir);

const need = createRequire(join(tree, 'package.json'));
const PptxGenJS = need('pptxgenjs');
const JSZip = need('jszip');

// ---- pictures: small ones, with the data URI headers pptxgenjs reads types from ------------------------------------
const PNG = 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = 'image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const GIF = 'image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const WEBP = 'image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

// ---- call helpers ------------------------------------------------------------------------------------------------
const shape = (slide, name, options) => ({ op: 'addShape', slide, shape: name, options });
const image = (slide, options) => ({ op: 'addImage', slide, options });
const add = () => ({ op: 'addSlide' });

// What authoring/pptx-html-build.mjs passes for its measured items: inches from px, points from px, shadow of a CSS box shadow.
const htmlRect = (slide, i) =>
  shape(slide, i % 3 === 0 ? 'roundRect' : i % 3 === 1 ? 'ellipse' : 'rect', {
    x: 0.5 + i * 0.37,
    y: 0.3 + i * 0.21,
    w: 2.4,
    h: 1.15,
    fill: i % 2 ? { color: 'FFFFFF', transparency: 0 } : { color: '1A73E8', transparency: 35 },
    line: i % 4 === 0 ? { color: '202124', width: 0.75 } : { type: 'none' },
    ...(i % 3 === 0 ? { rectRadius: 0.18 } : {}),
    ...(i % 5 === 0 ? { rotate: 4.5 } : {}),
    ...(i % 2 === 0 ? { shadow: { type: 'outer', color: '000000', opacity: 0.25, blur: 6, offset: 4.2, angle: 45 } } : {}),
  });

const cases = [];
const addCase = (name, calls) => cases.push({ name, calls });

addCase('empty deck', []);
addCase('one empty default slide', [add()]);
addCase('three empty slides', [add(), add(), add()]);
addCase('wide layout, html-build shapes', [
  { op: 'layout', name: 'LAYOUT_WIDE' },
  add(),
  { op: 'background', slide: 0, props: { color: 'F8F9FA' } },
  ...Array.from({ length: 9 }, (_, i) => htmlRect(0, i)),
  shape(0, 'line', { x: 1, y: 3, w: 5, h: 0, line: { color: '5F6368', width: 1.5, transparency: 20 } }),
  shape(0, 'line', { x: 6, y: 1, w: 0, h: 4.25, line: { color: 'DADCE0', width: 0.5 } }),
  shape(0, 'rect', { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: '000000', transparency: 90 }, line: { type: 'none' }, shadow: { type: 'outer', color: '112233', opacity: 1, blur: 0.01, offset: 0, angle: 0 } }),
  { op: 'addNotes', slide: 0, text: 'Opening slide\nSecond line of the notes' },
]);
addCase('a measured sheet (defineLayout)', [
  { op: 'defineLayout', name: 'MIXDOG_SHEET', width: 8.268, height: 11.693 },
  { op: 'layout', name: 'MIXDOG_SHEET' },
  add(),
  shape(0, 'rect', { x: 0.4, y: 0.4, w: 7.4, h: 0.6, fill: { color: '123456' } }),
  add(),
  shape(0, 'ellipse', { x: 1, y: 1, w: 1, h: 1, fill: { color: 'ABCDEF' } }),
]);
addCase('other built-in layouts', [{ op: 'layout', name: 'LAYOUT_4x3' }, add(), { op: 'layout', name: 'LAYOUT_16x10' }, add(), { op: 'layout', name: 'LAYOUT_16x9' }, add()]);
addCase('unknown layout throws, a redefined layout takes the new size', [
  { op: 'layout', name: 'LAYOUT_NOPE' },
  { op: 'defineLayout', name: 'LAYOUT_WIDE', width: 20, height: 10 },
  { op: 'layout', name: 'LAYOUT_WIDE' },
  add(),
]);
addCase('document properties and theme fonts', [
  { op: 'set', key: 'title', value: 'A <title> & "more"' },
  { op: 'set', key: 'subject', value: "Subject 'x'" },
  { op: 'set', key: 'author', value: 'Åuthor & Co' },
  { op: 'set', key: 'company', value: 'Co <raw> & unescaped' },
  { op: 'set', key: 'revision', value: '7' },
  { op: 'set', key: 'rtlMode', value: true },
  { op: 'set', key: 'theme', value: { headFontFace: 'Noto Serif KR', bodyFontFace: 'Noto Sans KR' } },
  add(),
  add(),
]);
addCase('theme with only a head font', [{ op: 'set', key: 'theme', value: { headFontFace: 'Georgia' } }, add()]);
addCase('shape fills', [
  add(),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: 'ff8800' }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: '#ff8800' }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: { color: 'accent3' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: { color: 'not-a-colour' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: { type: 'none' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: { color: '00FF00', alpha: 25 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: { color: '00FF00', alpha: 25, transparency: 50 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: { transparency: 40 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, fill: { color: '0000FF', transparency: 100 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1 }),
]);
addCase('shape outlines', [
  add(),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, line: { color: 'FF0000' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, line: { color: 'FF0000', width: 3, dashType: 'dash' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, line: { width: 0.25 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, line: { color: 'FF0000', width: 2.5, transparency: 60 } }),
  shape(0, 'line', { x: 1, y: 1, w: 4, h: 0, line: { color: '00AA00', width: 2, beginArrowType: 'triangle', endArrowType: 'arrow' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, line: { type: 'none' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, line: { type: 'none', width: 2 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, line: { type: 'dash', color: 'FF0000' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, line: { color: 'FF0000', width: 0 } }),
]);
addCase('shape positions and sizes', [
  add(),
  shape(0, 'rect', {}),
  shape(0, 'rect', { x: 0, y: 0, w: 0, h: 0 }),
  shape(0, 'rect', { x: '50%', y: '25%', w: '10%', h: '12.5%' }),
  shape(0, 'rect', { x: '2', y: '3.5', w: '1.5', h: 1 }),
  shape(0, 'rect', { x: 914400, y: 457200, w: 1828800, h: 914400 }),
  shape(0, 'rect', { x: 99.9, y: 0.0001, w: 100, h: 100.5 }),
  shape(0, 'rect', { x: -1, y: -0.5, w: 2.333333, h: 1.666667 }),
  shape(0, 'rect', { x: 0.1 + 0.2, y: 1 / 3, w: 2 / 3, h: 1e-7 }),
]);
addCase('shape geometry, radius and angles', [
  add(),
  shape(0, 'roundRect', { x: 1, y: 1, w: 3, h: 2, rectRadius: 0.5 }),
  shape(0, 'roundRect', { x: 1, y: 1, w: 3, h: 2, rectRadius: 1.6 }),
  shape(0, 'roundRect', { x: 1, y: 1, w: 0, h: 2, rectRadius: 0.5 }),
  shape(0, 'roundRect', { x: 1, y: 1, w: 3, h: 2, rectRadius: 0 }),
  shape(0, 'pie', { x: 1, y: 1, w: 3, h: 3, angleRange: [30, 150] }),
  shape(0, 'blockArc', { x: 1, y: 1, w: 3, h: 3, angleRange: [270, 90], arcThicknessRatio: 0.4 }),
  shape(0, 'arc', { x: 1, y: 1, w: 3, h: 3, angleRange: [0, 400] }),
  shape(0, 'pie', { x: 1, y: 1, w: 3, h: 3, angleRange: [30, 150], rectRadius: 0.2 }),
  shape(0, 'triangle', { x: 1, y: 1, w: 3, h: 3 }),
  shape(0, 'rightArrow', { x: 1, y: 1, w: 3, h: 3 }),
]);
addCase('shape rotation and flips', [
  add(),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, rotate: 45 }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, rotate: 359.999 }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, rotate: 380 }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, rotate: -30 }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, rotate: 0 }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, flipH: true }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, flipV: true, rotate: 12.5 }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, flipH: true, flipV: true, rotate: 90 }),
]);
addCase('shape shadows', [
  add(),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, shadow: { type: 'outer' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, shadow: {} }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, shadow: { type: 'inner', color: 'FF0000', blur: 3, offset: 2, angle: 180, opacity: 0.5 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, shadow: { type: 'none', blur: 20 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, shadow: { type: 'outer', blur: 0, offset: 0, angle: 0, opacity: 0 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, shadow: { type: 'outer', blur: 2.345, offset: 1.5, angle: 33.3, opacity: 0.333 } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, shadow: { type: 'engraved', color: 'abc' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, shadow: { color: '#123456', angle: 720, opacity: 7 } }),
]);
addCase('shape names and hyperlinks', [
  add(),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, objectName: 'Card <1> & "two"' }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, hyperlink: { url: 'https://example.com/?a=1&b=2', tooltip: 'Go "there"' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, hyperlink: { slide: 2, tooltip: 'To slide 2' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, hyperlink: { url: 'https://example.com' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, hyperlink: { tooltip: 'neither url nor slide' } }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, hyperlink: { url: 'https://a.test', slide: 3 } }),
  shape(0, '', { x: 1, y: 1, w: 1, h: 1 }),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1 }),
]);
addCase('pictures: types, names, alt text', [
  { op: 'layout', name: 'LAYOUT_WIDE' },
  add(),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1 }),
  image(0, { data: JPEG, x: 1, y: 1, w: 2, h: 1, altText: 'A <photo> & "more"' }),
  image(0, { data: GIF, x: 1, y: 1, w: 2, h: 1, objectName: 'Hero & logo' }),
  image(0, { data: WEBP, x: 1, y: 1, w: 2, h: 1 }),
  image(0, { data: 'data:image/png;base64,' + PNG.split(',')[1], x: 1, y: 1, w: 2, h: 1 }),
  image(0, { data: PNG }),
  image(0, { data: PNG, x: '10%', y: '20%', w: '30%', h: '40%' }),
  image(0, { data: PNG, x: 0, y: 0, w: 0, h: 0 }),
  add(),
  image(1, { data: PNG, x: 1, y: 1, w: 2, h: 1 }),
  image(1, { data: JPEG, x: 1, y: 1, w: 2, h: 1 }),
]);
addCase('pictures: transparency, rounding, rotation, flips, shadow', [
  add(),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, transparency: 30 }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 2, rounding: true }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, rotate: 15, flipH: true, flipV: true }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, shadow: { type: 'outer', color: '000000', opacity: 0.3, blur: 5, offset: 3, angle: 90 } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, shadow: { type: 'inner' } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, shadow: { type: 'bogus', angle: 500, opacity: 3, color: '#FFAA00' } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, shadow: { type: 'none' } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, shadow: { blur: 0, offset: 0, angle: 0, opacity: 0 } }),
]);
addCase('pictures: sizing', [
  add(),
  image(0, { data: PNG, x: 1, y: 1, w: 4, h: 2, sizing: { type: 'cover', w: 2, h: 2 } }),
  image(0, { data: PNG, x: 1, y: 1, w: 4, h: 2, sizing: { type: 'contain', w: 2, h: 2 } }),
  image(0, { data: PNG, x: 1, y: 1, w: 4, h: 2, sizing: { type: 'crop', x: 0.5, y: 0.25, w: 2, h: 1 } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 4, sizing: { type: 'cover', w: 3, h: 1 } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 4, sizing: { type: 'contain', w: 3, h: 1 } }),
  image(0, { data: PNG, x: 1, y: 1, w: 3, h: 3, sizing: { type: 'cover' } }),
  image(0, { data: PNG, x: 1, y: 1, w: 3, h: 3, sizing: { type: 'crop', w: '50%', h: '50%', x: '10%', y: '10%' } }),
]);
addCase('pictures: hyperlinks and refused calls', [
  add(),
  shape(0, 'rect', { x: 1, y: 1, w: 1, h: 1, hyperlink: { url: 'https://first.test' } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, hyperlink: { url: 'https://example.com/a&b', tooltip: 'Open "it"' } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, hyperlink: { slide: 2 } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1, hyperlink: { tooltip: 'neither' } }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1 }),
  image(0, {}),
  image(0, { data: 'QUJDREVG', x: 1, y: 1, w: 2, h: 1 }),
  image(0, { data: PNG, x: 1, y: 1, w: 2, h: 1 }),
]);
addCase('backgrounds', [
  add(),
  { op: 'background', slide: 0, props: { color: '102030' } },
  add(),
  { op: 'background', slide: 1, props: { fill: 'AABBCC' } },
  add(),
  { op: 'background', slide: 2, props: { color: '000000', fill: 'EEEEEE', transparency: 25 } },
  add(),
  { op: 'background', slide: 3, props: { data: JPEG } },
  shape(3, 'rect', { x: 1, y: 1, w: 1, h: 1 }),
  add(),
  { op: 'background', slide: 4, props: { color: '445566', data: PNG } },
  add(),
  { op: 'background', slide: 5, props: { data: PNG } },
  { op: 'background', slide: 5, props: { color: 'FF00FF' } },
  add(),
  { op: 'background', slide: 6, props: {} },
  add(),
  image(7, { data: GIF, x: 1, y: 1, w: 1, h: 1 }),
  { op: 'background', slide: 7, props: { data: JPEG } },
  image(7, { data: GIF, x: 1, y: 1, w: 1, h: 1 }),
]);
addCase('slide numbers', [
  { op: 'layout', name: 'LAYOUT_WIDE' },
  add(),
  add(),
  { op: 'slideNumber', slide: 1, props: { x: 12.3, y: 7.0, w: 0.8, h: 0.3, fontFace: 'Arial', fontSize: 10, color: '808080', align: 'right', valign: 'bottom', bold: true, margin: [1, 2, 3, 4] } },
  add(),
  { op: 'slideNumber', slide: 2, props: { x: '90%', y: '95%' } },
  add(),
  { op: 'slideNumber', slide: 3, props: { x: 0, y: 0, margin: 5, align: 'center', valign: 'middle' } },
  add(),
  { op: 'slideNumber', slide: 4, props: { x: 1, y: 1, fontSize: 20, margin: [3] } },
  add(),
  { op: 'slideNumber', slide: 5, props: { x: 1, y: 1, color: 'accent2', align: 'cc', valign: 'top', margin: 0 } },
  add(),
  { op: 'slideNumber', slide: 6, props: { x: 1, y: 1, fontFace: 'Noto Sans KR' } },
  add(),
  { op: 'slideNumber', slide: 7, props: {} },
]);
addCase('slide number on a default sheet', [add(), { op: 'slideNumber', slide: 0, props: { x: '50%', y: '90%', w: '10%', h: '5%' } }]);
addCase('notes', [
  add(),
  { op: 'addNotes', slide: 0, text: 'plain' },
  add(),
  { op: 'addNotes', slide: 1, text: 'Line one\nLine two\r\nLine three\r\r\nLine four' },
  add(),
  { op: 'addNotes', slide: 2, text: 'Tags <b> & "quotes" \'single\'' },
  add(),
  { op: 'addNotes', slide: 3, text: 'first' },
  { op: 'addNotes', slide: 3, text: ' second' },
  add(),
  { op: 'addNotes', slide: 4, text: '' },
  add(),
  { op: 'addNotes', slide: 5, text: '한국어 메모 — 발표자 노트' },
  add(),
  { op: 'addNotes', slide: 6, text: 'before shapes' },
  shape(6, 'rect', { x: 1, y: 1, w: 1, h: 1 }),
  { op: 'addNotes', slide: 6, text: 'after' },
  shape(6, 'rect', { x: 1, y: 1, w: 1, h: 1 }),
  image(6, { data: PNG, x: 1, y: 1, w: 1, h: 1 }),
]);
addCase('hidden slides', [add(), { op: 'hidden', slide: 0 }, add()]);
addCase('a mixed deck as the html build writes it', [
  { op: 'layout', name: 'LAYOUT_WIDE' },
  ...Array.from({ length: 6 }, (_, s) => [
    add(),
    ...(s % 2 === 0 ? [{ op: 'background', slide: s, props: { color: s === 0 ? '0B1B33' : 'FFFFFF' } }] : []),
    ...Array.from({ length: 4 }, (_, i) => htmlRect(s, i + s)),
    image(s, { data: s % 2 ? PNG : JPEG, x: 7 + s * 0.2, y: 1, w: 3, h: 2, altText: `picture ${s}`, ...(s === 3 ? { transparency: 40 } : {}) }),
    ...(s === 2 ? [image(s, { data: GIF, x: 1, y: 5, w: 1, h: 1, altText: 'decoration', objectName: 'Mixdog Motif drawing' })] : []),
    ...(s % 3 === 1 ? [{ op: 'addNotes', slide: s, text: `Speaker notes for slide ${s + 1}` }] : []),
  ]).flat(),
]);

// ---- run each case against pptxgenjs --------------------------------------------------------------------------------
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
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
async function run(calls) {
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
          case 'defineLayout':
            pres.defineLayout({ name: call.name, width: call.width, height: call.height });
            break;
          case 'set':
            pres[call.key] = clone(call.value);
            break;
          case 'addSlide':
            slides.push(pres.addSlide());
            break;
          case 'hidden':
            slides[call.slide].hidden = true;
            break;
          case 'background':
            slides[call.slide].background = clone(call.props);
            break;
          case 'slideNumber':
            slides[call.slide].slideNumber = clone(call.props);
            break;
          case 'addShape':
            slides[call.slide].addShape(call.shape, options);
            break;
          case 'addImage':
            slides[call.slide].addImage(options);
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
for (const { name, calls } of cases) recorded.push({ name, ...(await run(calls)) });

const golden = {
  note: 'Recorded from pptxgenjs 4.0.1 (dist/pptxgen.cjs.js) driven by scripted calls; tests/twin_pptx_writer.rs replays the calls against the Rust writer.',
  pptxgenjs: JSON.parse(readFileSync(join(tree, 'node_modules', 'pptxgenjs', 'package.json'), 'utf8')).version,
  blobs,
  cases: recorded,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-pptx-writer', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json: ${recorded.length} cases, ${Object.keys(blobs).length} blobs`);
