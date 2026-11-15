#!/usr/bin/env node
// Golden of pdf.js 6.4's operator-list pass, annotations and outline (crate mixdog-pdf: oplist, annotations,
// outline_read). Generated PDFs (paths and clipping, images and inline images, form XObjects and groups, graphics
// states, marked content, patterns, Type3 fonts, damaged content streams, rotated and offset boxes, links, named
// destinations and outlines) go through pdf.js (the legacy build the office engine loads, opened with the office
// engine's own options: no worker, system fonts) and are reduced to what the analysis and the renderer read:
//   ops     the operator list page.getOperatorList() returns (the oplist intent: no queue optimizer), each operator with its
//           arguments in the shapes the Rust events have (single-precision path data as stored, image ids numbered by
//           first use, text operators by name only: the font object is another task's), and for the operators that
//           paint a path or an image the transform in force there (the analysis's `applyGraphicsOp` walk)
//   annots  page.getAnnotations(): subtype, rectangle, id, flags, contents, quad points and the link's action
//   outline document.getOutline() as a tree, with the page each destination opens
//   dests   document.getDestination(name) for the names the cases define
// Writes native/core/fixtures/office-oplist/golden.json and the manifest.
//
//   node benchmarks/rust-core/recorders/record-office-oplist.mjs --tree <product tree>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-oplist.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const pdfjs = await importFrom(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs');
try {
  const canvas = await importFrom(tree, 'node_modules/@napi-rs/canvas/index.js');
  globalThis.DOMMatrix ??= canvas.DOMMatrix;
  globalThis.ImageData ??= canvas.ImageData;
  globalThis.Path2D ??= canvas.Path2D;
} catch {}
const { OPS, Util } = pdfjs;
const OP_NAMES = Object.fromEntries(Object.entries(OPS).map(([name, id]) => [id, name]));

// ---- PDF construction --------------------------------------------------------------------------------------------

const stream = (dict, bytes) => ({ dict, bytes: Buffer.from(bytes, typeof bytes === 'string' ? 'latin1' : undefined) });
const hexData = (bytes) => `${Buffer.from(bytes).toString('hex')}>`;

function writePdf(objects) {
  const all = [...Object.entries(objects)].map(([num, body]) => [Number(num), body]).sort((a, b) => a[0] - b[0]);
  const parts = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const offsets = new Map();
  let size = parts[0].length;
  for (const [num, body] of all) {
    offsets.set(num, size);
    const chunk =
      typeof body === 'string'
        ? Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1')
        : Buffer.concat([
            Buffer.from(`${num} 0 obj\n<< ${body.dict} /Length ${body.bytes.length} >>\nstream\n`, 'latin1'),
            body.bytes,
            Buffer.from('\nendstream\nendobj\n', 'latin1'),
          ]);
    parts.push(chunk);
    size += chunk.length;
  }
  const last = all[all.length - 1][0];
  let xref = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= last; n += 1) xref += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** One page document: catalog 1, pages 2, page 3, content 4, then `extra` objects (numbers 10 and up). */
function onePage({ content, resources = '', pageExtra = '', box = '[0 0 200 200]', extra = {}, catalogExtra = '' }) {
  return writePdf({
    1: `<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Contents 4 0 R /Resources << ${resources} >> ${pageExtra} >>`,
    4: stream('', content),
    ...extra,
  });
}

// ---- the cases -----------------------------------------------------------------------------------------------------

const rgbImage = stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode', hexData([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]));
const grayImage = (w, h) =>
  stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode`, hexData(Array.from({ length: w * h }, (_, i) => (i * 7) & 255)));
const maskImage = stream('/Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Filter /ASCIIHexDecode', hexData([0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55]));
const smaskImage = stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /SMask 13 0 R /Filter /ASCIIHexDecode', hexData([10, 20, 30, 40]));
const smaskData = stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode', hexData([255, 128, 64, 0]));
const inlineSmall = `BI /W 4 /H 4 /CS /G /BPC 8 /F /AHx ID ${hexData(Array.from({ length: 16 }, (_, i) => i * 16))} EI`;
const inlineLarge = `BI /W 150 /H 100 /CS /G /BPC 8 /F /AHx ID ${hexData(Array.from({ length: 15000 }, (_, i) => (i * 13) & 255))} EI`;

const type3Font = '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 100 100] /FontMatrix [0.01 0 0 0.01 0 0] /CharProcs << /sq 20 0 R /dot 21 0 R >> /Encoding << /Type /Encoding /Differences [97 /sq /dot] >> /FirstChar 97 /LastChar 98 /Widths [100 60] >>';

const documents = [];
const addDocument = (name, bytes, note) => documents.push({ name, bytes, note });

addDocument(
  'paths',
  onePage({
    content: [
      'q 1 0 0 1 10 20 cm 0 0 50 30 re f Q',
      'q 2 0 0 2 0 0 cm 5 5 20 10 re S Q',
      'q 1 0 0 1 3 4 cm 5 5 20 10 re S Q',
      '10 100 m 90 100 l S',
      '10 120 m 40 150 70 90 100 120 c S',
      '10 10 m 60 10 l 60 60 l h b',
      '0 0 0 40 re f',
      '50 50 20 20 re B*',
      'q 0 1 -1 0 100 100 cm 0 0 10 10 re f Q',
      '0 0 100 100 re W n',
      '50 50 m 80 80 l s',
      '30 30 m 40 40 50 30 v 60 20 70 30 y f*',
      '0.5 g 1 0 0 rg 0 0 1 RG 0 0 0 1 k 0.2 0.4 0.6 sc 0.1 0.2 0.3 SC',
      '[3 2] 1 d 2.5 w 1 J 1 j 4 M 0.5 i /Perceptual ri',
      '-3 w []  0 d',
      '5 5 m 6 6 l W* n',
      'q q q 1 0 0 1 1 1 cm 0 0 5 5 re f',
    ].join('\n'),
  }),
  'paths, fills and strokes, clipping, colours, line state, and the optimizer fold of q cm path Q'
);

addDocument(
  'rotated-offset',
  onePage({
    content: ['q 1 0 0 1 10 10 cm 0 0 40 20 re f Q', '30 30 m 90 30 l S', 'q 0.5 0 0 0.5 100 100 cm 0 0 10 10 re B Q'].join('\n'),
    box: '[10 20 210 220]',
    pageExtra: '/CropBox [20 30 180 190] /Rotate 90',
  }),
  'a rotated page with a crop box inside an offset media box'
);

addDocument(
  'rotated-270',
  onePage({
    content: '10 10 80 40 re f 5 5 m 95 5 l S',
    box: '[0 0 100 150]',
    pageExtra: '/Rotate 270 /UserUnit 2',
  }),
  'a page rotated 270 with a user unit'
);

addDocument(
  'images',
  onePage({
    content: [
      'q 40 0 0 40 10 10 cm /Im1 Do Q',
      'q 40 0 0 40 60 10 cm /Im1 Do Q',
      'q 40 0 0 40 110 10 cm /Im1 Do Q',
      'q 40 0 0 40 150 10 cm /Im1 Do Q',
      'q 30 10 -10 30 20 100 cm /Im2 Do Q',
      'q 20 0 0 20 100 100 cm /Im3 Do Q',
      'q 30 0 0 30 140 100 cm /Im4 Do Q',
      'q 30 0 0 30 10 150 cm /Im5 Do Q',
      'q 8 0 0 8 60 150 cm',
      inlineSmall,
      'Q',
      'q 50 0 0 40 80 150 cm',
      inlineLarge,
      'Q',
      'q 50 0 0 40 130 150 cm',
      inlineLarge,
      'Q',
      '/Im1 Do',
    ].join('\n'),
    resources: '/XObject << /Im1 10 0 R /Im2 11 0 R /Im3 12 0 R /Im4 14 0 R /Im5 15 0 R >>',
    extra: { 10: rgbImage, 11: grayImage(30, 30), 12: maskImage, 13: smaskData, 14: smaskImage, 15: stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /OC 16 0 R /Filter /ASCIIHexDecode', hexData([1, 2, 3, 4])), 16: '<< /Type /OCG /Name (layer) >>' },
  }),
  'image XObjects painted several times (the repeat group), a mask, a soft-masked image, optional content, inline images'
);

addDocument(
  'forms',
  onePage({
    content: [
      'q 1 0 0 1 10 10 cm /F1 Do Q',
      'q 0.5 0 0 0.5 100 20 cm /F1 Do Q',
      'q /F3 Do Q',
      '/F4 Do',
      '/F5 Do',
      'q /GS1 gs 0 0 20 20 re f Q',
      '/GS2 gs 1 0 0 rg 5 5 10 10 re f',
      '/GS3 gs',
      '/F6 Do',
    ].join('\n'),
    resources:
      '/XObject << /F1 10 0 R /F3 12 0 R /F4 13 0 R /F5 14 0 R /F6 17 0 R >> /ExtGState << /GS1 << /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 12 0 R /BC [0.5] >> /BM /Multiply /LW 3 /ca 0.5 /D [[2 1] 0] >> /GS2 << /LW -2 /SMask /None /BM [/Foo /Screen] /TR 15 0 R /LC 1 >> /GS3 << /Font [16 0 R 14] /Foo 1 >> >>',
    extra: {
      10: stream('/Type /XObject /Subtype /Form /Matrix [1 0 0 1 5 5] /BBox [0 0 50 50] /Resources << /XObject << /F2 11 0 R >> >>', '0 0 20 20 re f /F2 Do'),
      11: stream('/Type /XObject /Subtype /Form /Matrix [2 0 0 2 0 0] /BBox [0 0 10 10]', '1 0 0 rg 0 0 5 5 re f q'),
      12: stream('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true /K false /CS /DeviceRGB >>', '0 0 1 rg 10 10 30 30 re f'),
      13: stream('/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /F4 13 0 R >> >>', '0 0 5 5 re f /F4 Do 6 6 2 2 re f'),
      14: stream('/Type /XObject /Subtype /Form /BBox [0 0 10 10] /OC 18 0 R', '1 1 3 3 re f'),
      15: '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >>',
      16: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      17: stream('/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency >>', '/GS1 gs 2 2 4 4 re f'),
      18: '<< /Type /OCMD /OCGs [19 0 R] /P /AllOn >>',
      19: '<< /Type /OCG /Name (a) >>',
    },
  }),
  'form XObjects with matrices and boxes, a transparency group, a circular form, unbalanced q in a form, optional content, graphics states'
);

addDocument(
  'marked-content',
  onePage({
    content: [
      '/Artifact BMC 0 0 10 10 re f EMC',
      '/P << /MCID 3 >> BDC 1 1 5 5 re f EMC',
      '/OC /MC0 BDC 2 2 5 5 re f EMC',
      '/OC << /Type /OCMD /OCGs [10 0 R 11 0 R] /P /AnyOn >> BDC 3 3 5 5 re f EMC',
      '/Span /Props BDC 4 4 5 5 re f EMC',
      '/OC /Missing BDC 5 5 5 5 re f EMC',
      'EMC EMC',
      '/X BMC /Y BMC 6 6 1 1 re f',
      '/Mark MP /Mark << /A 1 >> DP BX 7 7 1 1 re f EX',
    ].join('\n'),
    resources: '/Properties << /MC0 10 0 R /Props 12 0 R >>',
    extra: { 10: '<< /Type /OCG /Name (a) >>', 11: '<< /Type /OCG /Name (b) >>', 12: '<< /MCID 9 /Other 1 >>' },
  }),
  'marked content: properties, optional content groups and memberships, unbalanced and extra ends'
);

addDocument(
  'patterns-shadings',
  onePage({
    content: [
      '/Pattern cs /P1 scn 0 0 50 50 re f',
      '/CS1 cs 0.5 0.1 0.2 /P2 scn 60 0 50 50 re f',
      '/Pattern CS /P3 SCN 0 60 50 50 re S',
      '/Sh1 sh',
      '/Missing sh',
      '/CS2 cs 0.3 sc 0.6 scn',
      '/Cs3 cs 0.1 0.2 0.3 sc',
    ].join('\n'),
    resources:
      '/Pattern << /P1 10 0 R /P2 11 0 R /P3 12 0 R >> /Shading << /Sh1 13 0 R >> /ColorSpace << /CS1 [/Pattern /DeviceRGB] /CS2 /DeviceGray /Cs3 [/CalRGB << /WhitePoint [0.95 1 1.09] >>] >>',
    extra: {
      10: stream('/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Matrix [1 0 0 1 2 2]', '1 0 0 rg 0 0 5 5 re f'),
      11: stream('/Type /Pattern /PatternType 1 /PaintType 2 /TilingType 2 /BBox [0 0 8 8] /XStep 9 /YStep 9 /Resources << >>', '0 0 4 4 re f'),
      12: '<< /Type /Pattern /PatternType 2 /Shading 13 0 R /Matrix [1 0 0 1 0 60] >>',
      13: '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >>',
    },
  }),
  'tiling and shading patterns, colour space operators with and without a pattern'
);

addDocument(
  'type3',
  onePage({
    content: ['BT /T3 12 Tf 10 100 Td (ab) Tj ET', 'BT /F1 10 Tf 1 0 0 1 20 50 Tm [(Hi) -20 (there)] TJ 5 TL T* (x) \' 1 2 (y) " ET', '(no font) Tj'].join('\n'),
    resources: '/Font << /T3 10 0 R /F1 11 0 R >>',
    extra: {
      10: type3Font.replace('/sq 20 0 R /dot 21 0 R', '/sq 20 0 R /dot 21 0 R'),
      11: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      20: stream('', '100 0 0 0 100 100 d1 0 0 100 100 re f'),
      21: stream('', '60 0 d0 1 0 0 rg 20 20 20 20 re f'),
    },
  }),
  'Type3 glyph procedures and text operators (by name: the font object is another task)'
);

addDocument(
  'damaged',
  onePage({
    content: ['q 1 2 m', '1 2 3 l', 'foo bar baz', '10 20 30 re', '0 0 5 5 re f', 'Q Q Q', '0 0 1 1 re f', 'q', '1 0 0 1 0 0 0 cm', '1 2 3 4 5 6 7 cm', '3 4 m 5 6 l S', '1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re', '9 9 9 9 re f'].join('\n'),
  }),
  'operands that do not fit, unknown operators, unbalanced q and Q, a run of invalid path operators'
);

// Links, named destinations and an outline over three pages (the second and third under a nested Pages node).
function linkDocument() {
  const link = (rect, body, extra = '') => `<< /Type /Annot /Subtype /Link /Rect ${rect} ${body} ${extra} >>`;
  const objects = {
    1: '<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(chapter2) [4 0 R /Fit] (zeta) << /D [3 0 R /FitH 100] >> <FEFFD55C> [5 0 R /XYZ 10 20 null]] >> >> /Dests << /Named1 [5 0 R /Fit] /Obj << /D [4 0 R /FitR 0 0 10 10] >> /Bad [4 0 R /Foo] >> /Outlines 40 0 R /URI << /Base (http://base.test/dir/) >> >>',
    2: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 20 0 R /Resources << >> /Annots [100 0 R 101 0 R 102 0 R 103 0 R 104 0 R 105 0 R 106 0 R 107 0 R 108 0 R 109 0 R 110 0 R 111 0 R 112 0 R 113 0 R 114 0 R 115 0 R 116 0 R 117 0 R 118 0 R 119 0 R 120 0 R 121 0 R 122 0 R << /Subtype /Link /Rect [1 2 3 4] /A << /S /URI /URI /Foo >> >>] >>',
    4: '<< /Type /Page /Parent 6 0 R /MediaBox [0 0 612 792] /Contents 20 0 R >>',
    5: '<< /Type /Page /Parent 6 0 R /MediaBox [0 0 612 792] /Contents 20 0 R >>',
    6: '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 >>',
    20: stream('', ''),
    100: link('[10 700 100 720]', '/A << /S /URI /URI (http://example.com) >>'),
    101: link('[10 680 100 700]', '/A << /S /URI /URI (www.test.org/x) >>'),
    102: link('[10 660 100 680]', '/A << /S /URI /URI (mailto:a@b.co) >>'),
    103: link('[10 640 100 660]', '/A << /S /URI /URI (javascript:alert(1)) >>'),
    104: link('[10 620 100 640]', '/Dest [4 0 R /XYZ 0 792 null]'),
    105: link('[10 600 100 620]', '/Dest (chapter2)'),
    106: link('[10 580 100 600]', '/A << /S /GoTo /D /Named1 >>'),
    107: link('[10 560 100 580]', '/A << /S /GoToR /F (other.pdf) /D [2 /Fit] >>'),
    108: link('[10 540 100 560]', '/A << /S /Launch /F << /F (C:\\\\dir\\\\x.pdf) /UF (u.pdf) >> /NewWindow true >>'),
    109: link('[10 520 100 540]', '/A << /S /Named /N /NextPage >>'),
    110: link('[10 500 100 520]', '/A << /S /JavaScript /JS (app.launchURL("http://js.test", true)) >>'),
    111: link('[10 480 100 500]', '/QuadPoints [0 0 50 0 0 50 50 50]', '/F 32'),
    112: '<< /Type /Annot /Subtype /Highlight /Rect [10 460 100 480] /QuadPoints [10 480 100 480 10 460 100 460] /Contents (marked) >>',
    113: '<< /Type /Annot /Subtype /Highlight /Rect [10 440 100 460] /QuadPoints [1 2 3] >>',
    114: '<< /Type /Annot /Subtype /Text /Rect [200 700 220 720] /Contents <FEFF00480069> /F 4 /M (D:20240101000000Z) >>',
    115: '<< /Type /Annot /Subtype /Popup /Rect [300 300 300 300] /Parent 114 0 R >>',
    116: '<< /Type /Annot /Subtype /Foo /Rect [5 5 6 6] /F 1 >>',
    117: link('[10 420 100 440]', '/A << /S /URI /URI (http://ex.test/\xc3\xa9) >>'),
    118: link('[10 400 100 420]', '/A << /S /ResetForm /Fields [(a) 5 0 R] /Flags 1 >>'),
    119: link('[10 380 100 400]', '/AA << /D << /S /URI /URI (http://aa.test) >> >>'),
    120: link('[10 360 100 380]', '/Dest <FEFFD55C>'),
    121: link('[10 340 100 360]', '/A << /S /URI /URI (page.html#top) >>'),
    122: link('[10 320 100 340]', '/A << /S /SetOCGState /State [/ON 5 0 R] /PreserveRB false >>'),
    40: '<< /Type /Outlines /First 41 0 R /Last 44 0 R /Count 5 >>',
    41: '<< /Title (Chapter 1) /Parent 40 0 R /Dest [3 0 R /Fit] /Next 42 0 R /First 45 0 R /Last 45 0 R /Count 1 /F 2 /C [1 0 0] >>',
    42: '<< /Title (Chapter 2) /Parent 40 0 R /Dest (chapter2) /Prev 41 0 R /Next 43 0 R /Count -1 /F 1 /C [0 0 0] >>',
    43: '<< /Title <FEFFD55C> /Parent 40 0 R /A << /S /URI /URI (http://o.test) >> /Prev 42 0 R /Next 44 0 R >>',
    44: '<< /Title (Last) /Parent 40 0 R /A << /S /GoTo /D [5 0 R /XYZ 0 0 0] >> /Prev 43 0 R /Next 46 0 R >>',
    45: '<< /Title (Child) /Parent 41 0 R /Dest [4 0 R /Fit] >>',
    46: '<< /Parent 40 0 R /A << /S /Named /N /Print >> /Prev 44 0 R >>',
  };
  return writePdf(objects);
}
const DEST_NAMES = ['chapter2', 'zeta', 'Named1', 'Obj', 'Bad', '한', 'missing'];
addDocument('links-outline', linkDocument(), 'annotations (links and markup), named destinations, the outline and page indexes');

// ---- reductions ----------------------------------------------------------------------------------------------------

const plain = (value) => {
  if (value === undefined) return null;
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, plain);
  if (typeof value.num === 'number' && typeof value.gen === 'number') return { ref: `${value.num}R${value.gen ? value.gen : ''}` };
  if (typeof value.name === 'string' && Object.keys(value).length === 1) return { name: value.name };
  if (value instanceof Map) return null;
  return '[object]';
};

function reduceOps(list) {
  const ids = new Map();
  const norm = (id) => {
    if (!ids.has(id)) ids.set(id, `img${ids.size + 1}`);
    return ids.get(id);
  };
  const state = { stack: [], ctm: [1, 0, 0, 1, 0, 0] };
  const ops = [];
  const num = (array) => Array.from(array, (x) => (typeof x === 'number' ? x : plain(x)));
  for (let i = 0; i < list.fnArray.length; i += 1) {
    const fn = list.fnArray[i];
    const name = OP_NAMES[fn];
    const a = list.argsArray[i] || [];
    if (name === 'dependency') continue;
    // The analysis's walk.
    if (fn === OPS.save) state.stack.push(state.ctm);
    else if (fn === OPS.restore) state.ctm = state.stack.pop() || state.ctm;
    else if (fn === OPS.transform) state.ctm = Util.transform(state.ctm, Array.from(a));
    else if (fn === OPS.paintFormXObjectBegin) {
      state.stack.push(state.ctm);
      if (a[0]) state.ctm = Util.transform(state.ctm, Array.from(a[0]));
    } else if (fn === OPS.paintFormXObjectEnd) state.ctm = state.stack.pop() || state.ctm;
    let args;
    switch (name) {
      case 'transform':
      case 'setTextMatrix':
        args = num(a);
        break;
      case 'constructPath': {
        const [paint, [data], minMax] = a;
        args = [OP_NAMES[paint], data ? Array.from(data) : null, minMax ? Array.from(minMax) : null];
        break;
      }
      case 'paintFormXObjectBegin':
        args = [a[0] ? Array.from(a[0]) : null, a[1] ? Array.from(a[1]) : null];
        break;
      case 'beginGroup':
      case 'endGroup': {
        const g = a[0];
        args = [{ isolated: !!g.isolated, knockout: !!g.knockout, needsIsolation: !!g.needsIsolation, hasSoftMask: !!g.hasSoftMask, isGray: !!g.isGray, smask: g.smask ? { subtype: g.smask.subtype, backdrop: g.smask.backdrop ?? null, transferMap: g.smask.transferMap ? Array.from(g.smask.transferMap) : null } : null, bbox: g.bbox ? Array.from(g.bbox) : null, matrix: g.matrix ? Array.from(g.matrix) : null }];
        break;
      }
      case 'paintImageXObject':
        args = [norm(a[0]), a[1], a[2]];
        break;
      case 'paintImageXObjectRepeat':
        args = [norm(a[0]), a[1], a[2], Array.from(a[3])];
        break;
      case 'paintInlineImageXObject':
        args = [a[0].width, a[0].height];
        break;
      case 'paintImageMaskXObject':
        args = [a[0].width, a[0].height];
        break;
      case 'setFillRGBColor':
      case 'setStrokeRGBColor':
      case 'setLineWidth':
        args = [a[0]];
        break;
      case 'setDash':
        args = [Array.from(a[0]), a[1]];
        break;
      case 'setGState':
        args = a[0].map(([key, value]) => [key, key === 'Font' ? [value[1]] : key === 'TR' ? (value ? value.map((m) => (m ? Array.from(m) : null)) : null) : plain(value)]);
        break;
      case 'beginMarkedContent':
        args = [plain(a[0]?.name ?? a[0])];
        break;
      case 'beginMarkedContentProps':
        args = [a[0], a[0] === 'OC' ? (a[1] ? JSON.parse(JSON.stringify(a[1])) : null) : plain(a[1])];
        break;
      case 'setFont':
        args = [a[1]];
        break;
      case 'showText':
      case 'shadingFill':
      case 'setFillColorN':
      case 'setStrokeColorN':
        args = [];
        break;
      default:
        args = Array.from(a, (x) => (typeof x === 'number' ? x : plain(x)));
    }
    const entry = { op: name, args };
    if (['constructPath', 'paintImageXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObject', 'paintImageMaskXObject'].includes(name)) entry.ctm = [...state.ctm];
    ops.push(entry);
  }
  return ops;
}

const destValue = (dest) => (typeof dest === 'string' ? dest : Array.isArray(dest) ? dest.map(plain) : null);

async function pageOfDest(document, dest) {
  try {
    let value = dest;
    if (typeof value === 'string') value = await document.getDestination(value);
    const target = Array.isArray(value) ? value[0] : null;
    if (target && typeof target === 'object') return (await document.getPageIndex(target)) + 1;
    if (Number.isInteger(target)) return target + 1;
  } catch {}
  return null;
}

async function reduceAnnotations(document, page) {
  const out = [];
  for (const annotation of await page.getAnnotations()) {
    const entry = {
      id: annotation.id,
      subtype: annotation.subtype ?? null,
      rect: Array.isArray(annotation.rect) ? Array.from(annotation.rect) : null,
      flags: annotation.annotationFlags,
      contents: annotation.contentsObj?.str ?? '',
      hasAppearance: !!annotation.hasAppearance,
      quadPoints: annotation.quadPoints ? Array.from(annotation.quadPoints) : null,
      url: annotation.url ?? null,
      unsafeUrl: annotation.unsafeUrl ?? null,
      dest: destValue(annotation.dest),
      action: annotation.action ?? null,
      newWindow: annotation.newWindow ?? null,
      setOCGState: annotation.setOCGState ? { state: annotation.setOCGState.state, preserveRB: annotation.setOCGState.preserveRB } : null,
      resetForm: annotation.resetForm ? { fields: annotation.resetForm.fields, refs: annotation.resetForm.refs, include: annotation.resetForm.include } : null,
    };
    entry.page = await pageOfDest(document, annotation.dest);
    out.push(entry);
  }
  return out;
}

async function reduceOutline(document, items) {
  const out = [];
  for (const item of items || []) {
    out.push({
      title: item.title,
      dest: destValue(item.dest),
      url: item.url ?? null,
      unsafeUrl: item.unsafeUrl ?? null,
      action: item.action ?? null,
      newWindow: item.newWindow ?? null,
      setOCGState: item.setOCGState ? { state: item.setOCGState.state, preserveRB: item.setOCGState.preserveRB } : null,
      color: Array.from(item.color),
      count: item.count ?? null,
      bold: item.bold,
      italic: item.italic,
      page: await pageOfDest(document, item.dest),
      items: await reduceOutline(document, item.items),
    });
  }
  return out;
}

async function record(bytes, withLinks) {
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: true, isEvalSupported: false, verbosity: pdfjs.VerbosityLevel.ERRORS });
  const document = await loading.promise;
  const result = { pages: [] };
  for (let n = 1; n <= document.numPages; n += 1) {
    const page = await document.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const entry = { viewport: Array.from(viewport.transform) };
    if (!withLinks) entry.ops = reduceOps(await page.getOperatorList());
    else entry.annots = await reduceAnnotations(document, page);
    result.pages.push(entry);
  }
  if (withLinks) {
    result.outline = await reduceOutline(document, await document.getOutline());
    result.dests = {};
    for (const name of DEST_NAMES) {
      const dest = await document.getDestination(name);
      result.dests[name] = dest ? dest.map(plain) : null;
    }
  }
  await loading.destroy();
  return result;
}

// ---- the recording -------------------------------------------------------------------------------------------------

const out = {
  note: 'pdf.js 6.4 operator list, annotations and outline of generated PDFs (see the recorder). Each document: its bytes in hex and what pdf.js read.',
  pdfjs: pdfjs.version,
  documents: [],
};
for (const doc of documents) {
  const links = doc.name === 'links-outline';
  out.documents.push({ name: doc.name, note: doc.note, links, pdf: doc.bytes.toString('hex'), recorded: await record(doc.bytes, links) });
}

const fixtures = path.join(FIXTURES_ROOT, 'office-oplist');
mkdirSync(fixtures, { recursive: true });
const lines = [
  '{',
  `  "note": ${JSON.stringify(out.note)},`,
  `  "pdfjs": ${JSON.stringify(out.pdfjs)},`,
  `  "destNames": ${JSON.stringify(DEST_NAMES)},`,
  `  "documents": [\n${out.documents.map((d) => `    ${JSON.stringify(d)}`).join(',\n')}\n  ]`,
  '}',
  '',
];
const data = lines.join('\n');
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-oplist', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.documents.length} documents`);
