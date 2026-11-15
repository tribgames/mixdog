#!/usr/bin/env node
// Golden of pdf.js 6.4's colour conversion (crate mixdog-pdf: color.rs, function.rs, function_ps.rs). A generated PDF
// per case holds one colour space (and the PDF functions behind its tint transform); a content stream sets the colour
// space and then a grid of sample colours with `sc`; pdf.js (the legacy build the office engine loads, opened with the
// office engine's own options: no worker, no wasm URL) turns each colour into `#rrggbb` through ColorSpace.getRgbHex,
// which is what the evaluator emits as setFillRGBColor. The Rust side parses the same colour space object out of the
// same bytes and must give every byte alike. Writes native/core/fixtures/office-colour/golden.json and the manifest.
//
//   node benchmarks/rust-core/recorders/record-office-colour.mjs --tree <product tree>
//
// A colour space pdf.js cannot build is skipped by the evaluator (ignoreErrors), so the page keeps its DeviceGray: such a
// case is recorded as { fallback: "gray" } when its colours equal the gray reading of the first component, which the
// replay takes as "parse fails". `icc.qcmsLoads` records whether ICCBased built a real transform (pdf.js without a
// `wasmUrl` cannot, so the alternate space or the component count decides); the replay asserts it is false.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-colour.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const pdfjs = await importFrom(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const { OPS } = pdfjs;

// ---- samples -------------------------------------------------------------------------------------------------------

const text = (value) => String(Number(value.toFixed(6)));

/** Grid of `steps + 1` values per component between lo and hi, every combination. */
function grid(components, steps, lo = 0, hi = 1) {
  const axis = [];
  for (let i = 0; i <= steps; i += 1) axis.push(lo + ((hi - lo) * i) / steps);
  let rows = [[]];
  for (let c = 0; c < components; c += 1) rows = rows.flatMap((row) => axis.map((v) => [...row, v]));
  return rows.map((row) => row.map(text));
}

/** Deterministic pseudo-random colours inside the per-component ranges. */
function scatter(count, ranges, seed = 12345) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(ranges.map(([lo, hi]) => text(lo + (hi - lo) * next())));
  return rows;
}

const unit = (n) => Array.from({ length: n }, () => [0, 1]);
/** Points of one axis, past both ends of [0, 1]. */
const axisPoints = (n = 32) => [...Array.from({ length: n + 1 }, (_, i) => text(i / n)), '-0.2', '1.3'].map((v) => [v]);

// ---- PDF -----------------------------------------------------------------------------------------------------------

/** A binary stream object: the dictionary text without the Length entry, and the bytes. */
const stream = (dict, bytes) => ({ dict, bytes: Buffer.from(bytes) });
const lcg = (count, seed) => {
  let state = seed >>> 0;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  });
};
const hex = (bytes) => `<${Buffer.from(bytes).toString('hex')}>`;

function buildPdf(objects, content) {
  const all = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /ColorSpace << /CS0 10 0 R >> >> >>'],
    [4, stream('', Buffer.from(content, 'latin1'))],
    ...Object.entries(objects).map(([num, body]) => [Number(num), body]),
  ]);
  const parts = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const offsets = new Map();
  let size = parts[0].length;
  for (const [num, body] of [...all].sort((a, b) => a[0] - b[0])) {
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
  const last = Math.max(...all.keys());
  let xref = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= last; n += 1) xref += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** The PDF whose page selects `operand` and then each sample. */
function colourPdf(objects, operand, samples) {
  const content = `${operand} cs\n${samples.map((s) => `${s.join(' ')} sc`).join('\n')}\n`;
  return buildPdf(objects, content);
}

async function run(bytes) {
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: false, isEvalSupported: false, verbosity: pdfjs.VerbosityLevel.ERRORS });
  const document = await loading.promise;
  const page = await document.getPage(1);
  const list = await page.getOperatorList();
  const out = [];
  for (let i = 0; i < list.fnArray.length; i += 1) if (list.fnArray[i] === OPS.setFillRGBColor) out.push(list.argsArray[i][0]);
  await loading.destroy();
  return out;
}

// ---- the cases -----------------------------------------------------------------------------------------------------

const WHITE_D50 = '[0.9642 1 0.8249]';
const WHITE_D65 = '[0.9505 1 1.089]';
const fnExp = (c0, c1, n, domain = '[0 1]') => `<< /FunctionType 2 /Domain ${domain} /C0 [${c0}] /C1 [${c1}] /N ${n} >>`;
const separation = (alt, fn) => `[/Separation /Spot ${alt} ${fn}]`;
const deviceN = (names, alt, fn) => `[/DeviceN [${names.map((n) => `/${n}`).join(' ')}] ${alt} ${fn}]`;
const psFn = (code, domain, range) => stream(`/FunctionType 4 /Domain [${domain}] /Range [${range}]`, Buffer.from(code, 'latin1'));
const RANGE3 = '0 1 0 1 0 1';
const RANGE4 = '0 1 0 1 0 1 0 1';
const sampledFn = (sizes, bps, outputs, extra = '', domainOverride = null, seed = 7) => {
  const total = sizes.reduce((a, b) => a * b, outputs);
  const bytes = Math.ceil((total * bps) / 8);
  const domain = domainOverride ?? sizes.map(() => '0 1').join(' ');
  const range = Array.from({ length: outputs }, () => '0 1').join(' ');
  return stream(`/FunctionType 0 /Domain [${domain}] /Range [${range}] /Size [${sizes.join(' ')}] /BitsPerSample ${bps} ${extra}`, lcg(bytes, seed));
};

const cases = [];
const add = (name, group, objects, comps, samples, operand = '/CS0') => cases.push({ name, group, objects, comps, samples, operand });

// Device spaces, named directly and through the resource dictionary.
for (const [name, comps] of [['DeviceGray', 1], ['G', 1], ['DeviceRGB', 3], ['RGB', 3], ['DeviceCMYK', 4], ['CMYK', 4]]) {
  const steps = comps === 1 ? 64 : comps === 3 ? 8 : 6;
  const samples = [...grid(comps, steps), ...scatter(60, Array.from({ length: comps }, () => [-0.1, 1.1]), 99 + comps)];
  add(`device ${name}`, 'device', {}, comps, samples, `/${name}`);
  add(`device ${name} by resource`, 'device', { 10: `/${name}` }, comps, samples.slice(0, 80));
}
add('device cmyk corners and mid tones', 'device', {}, 4, [...grid(4, 1), ...grid(4, 3), ...scatter(400, unit(4), 5)], '/DeviceCMYK');

add('CalGray gamma 2.2', 'cal', { 10: `[/CalGray << /WhitePoint ${WHITE_D65} /Gamma 2.2 >>]` }, 1, axisPoints(64));
add('CalGray default gamma', 'cal', { 10: `[/CalGray << /WhitePoint ${WHITE_D65} >>]` }, 1, axisPoints(32));
add('CalGray gamma below one and black point', 'cal', { 10: `[/CalGray << /WhitePoint ${WHITE_D50} /Gamma 0.5 /BlackPoint [0.01 0.01 0.01] >>]` }, 1, axisPoints(32));
add('CalGray negative black point', 'cal', { 10: `[/CalGray << /WhitePoint ${WHITE_D65} /Gamma 1.8 /BlackPoint [-1 0 0] >>]` }, 1, axisPoints(32));
add('CalRGB sRGB-like', 'cal', {
  10: `[/CalRGB << /WhitePoint ${WHITE_D65} /Gamma [2.2 2.2 2.2] /Matrix [0.4124 0.2126 0.0193 0.3576 0.7152 0.1192 0.1805 0.0722 0.9505] >>]`,
}, 3, [...grid(3, 8), ...scatter(80, unit(3), 21)]);
add('CalRGB D50 with black point', 'cal', {
  10: `[/CalRGB << /WhitePoint ${WHITE_D50} /BlackPoint [0.02 0.03 0.04] /Gamma [1.8 1.9 2.0] /Matrix [0.4361 0.2225 0.0139 0.3851 0.7169 0.0971 0.1431 0.0606 0.7141] >>]`,
}, 3, [...grid(3, 8), ...scatter(80, unit(3), 22)]);
add('CalRGB defaults', 'cal', { 10: `[/CalRGB << /WhitePoint ${WHITE_D65} >>]` }, 3, [...grid(3, 6), ...scatter(40, unit(3), 23)]);
add('CalRGB white point of one', 'cal', { 10: '[/CalRGB << /WhitePoint [1 1 1] /Gamma [1 1 1] >>]' }, 3, grid(3, 6));
add('CalRGB negative gamma and black point', 'cal', {
  10: `[/CalRGB << /WhitePoint ${WHITE_D65} /Gamma [-1 2 2] /BlackPoint [-0.1 0 0] >>]`,
}, 3, grid(3, 5));
add('Lab D50 default range', 'lab', { 10: `[/Lab << /WhitePoint ${WHITE_D50} >>]` }, 3, [...grid(3, 4, 0, 100).map(([l, a, b]) => [l, text(Number(a) - 50), text(Number(b) - 50)]), ...scatter(120, [[0, 100], [-100, 100], [-100, 100]], 31)]);
add('Lab wide range', 'lab', { 10: `[/Lab << /WhitePoint ${WHITE_D50} /Range [-128 127 -128 127] >>]` }, 3, scatter(300, [[0, 100], [-130, 130], [-130, 130]], 32));
add('Lab white point z below one', 'lab', { 10: '[/Lab << /WhitePoint [0.9 1 0.9] /Range [-50 50 -60 60] >>]' }, 3, scatter(200, [[0, 100], [-60, 60], [-70, 70]], 33));
add('Lab bad range and black point', 'lab', { 10: `[/Lab << /WhitePoint ${WHITE_D65} /Range [10 -10 5 -5] /BlackPoint [-1 0 0] >>]` }, 3, scatter(100, [[0, 100], [-100, 100], [-100, 100]], 34));

// ICCBased: without qcms the alternate (when it has the right number of components) or the component count decides.
const profile = readFileSync(path.join(tree, 'node_modules/pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc'));
const iccStream = (n, extra = '') => stream(`/N ${n} ${extra}`, lcg(64, 5));
add('ICC N 1', 'icc', { 10: '[/ICCBased 11 0 R]', 11: iccStream(1) }, 1, axisPoints(16));
add('ICC N 3', 'icc', { 10: '[/ICCBased 11 0 R]', 11: iccStream(3) }, 3, grid(3, 4));
add('ICC N 4', 'icc', { 10: '[/ICCBased 11 0 R]', 11: iccStream(4) }, 4, grid(4, 3));
add('ICC N 3 alternate CalRGB', 'icc', { 10: '[/ICCBased 11 0 R]', 11: iccStream(3, `/Alternate [/CalRGB << /WhitePoint ${WHITE_D65} /Gamma [2.2 2.2 2.2] >>]`) }, 3, grid(3, 4));
add('ICC N 3 alternate Lab', 'icc', { 10: '[/ICCBased 11 0 R]', 11: iccStream(3, `/Alternate [/Lab << /WhitePoint ${WHITE_D50} >>]`) }, 3, scatter(60, [[0, 100], [-80, 80], [-80, 80]], 41));
add('ICC N 3 alternate with wrong component count', 'icc', { 10: '[/ICCBased 11 0 R]', 11: iccStream(3, '/Alternate /DeviceCMYK') }, 3, grid(3, 4));
add('ICC N 4 alternate DeviceGray ignored', 'icc', { 10: '[/ICCBased 11 0 R]', 11: iccStream(4, '/Alternate /DeviceGray') }, 4, grid(4, 3));
add('ICC N 2 falls to gray', 'icc', { 10: '[/ICCBased 11 0 R]', 11: iccStream(2) }, 2, grid(2, 4));
add('ICC real CMYK profile', 'icc', { 10: '[/ICCBased 11 0 R]', 11: stream('/N 4', profile) }, 4, grid(4, 4));

// Indexed.
const palette = (n, comps, seed) => hex(lcg(n * comps, seed));
const indexSamples = ['0', '1', '2', '3', '1.5', '2.5', '0.49', '0.5', '-1', '7', '255', '300', '3'].map((v) => [v]);
const upTo = (n) => Array.from({ length: n }, (_, i) => [String(i)]);
add('Indexed RGB string', 'indexed', { 10: `[/Indexed /DeviceRGB 3 ${palette(4, 3, 1)}]` }, 1, indexSamples);
add('Indexed I abbreviation', 'indexed', { 10: `[/I /RGB 3 ${palette(4, 3, 2)}]` }, 1, indexSamples);
add('Indexed RGB stream', 'indexed', { 10: '[/Indexed /DeviceRGB 255 11 0 R]', 11: stream('', lcg(768, 3)) }, 1, [...Array.from({ length: 70 }, (_, i) => [String(i * 4)]), ['255'], ['256'], ['0.5']]);
add('Indexed short stream', 'indexed', { 10: '[/Indexed /DeviceRGB 9 11 0 R]', 11: stream('', lcg(12, 4)) }, 1, upTo(12));
add('Indexed Gray', 'indexed', { 10: `[/Indexed /DeviceGray 7 ${palette(8, 1, 5)}]` }, 1, upTo(9));
add('Indexed CMYK', 'indexed', { 10: `[/Indexed /DeviceCMYK 5 ${palette(6, 4, 6)}]` }, 1, upTo(7));
add('Indexed Lab', 'indexed', { 10: `[/Indexed [/Lab << /WhitePoint ${WHITE_D50} /Range [-128 127 -128 127] >>] 5 ${palette(6, 3, 7)}]` }, 1, upTo(7));
add('Indexed CalRGB', 'indexed', { 10: `[/Indexed [/CalRGB << /WhitePoint ${WHITE_D65} /Gamma [2.2 2.2 2.2] >>] 5 ${palette(6, 3, 8)}]` }, 1, upTo(7));
add('Indexed Separation', 'indexed', { 10: `[/Indexed ${separation('/DeviceRGB', fnExp('1 1 1', '0.8 0.1 0.2', 1))} 3 ${hex([0, 85, 170, 255])}]` }, 1, indexSamples);
add('Indexed ICC base', 'indexed', { 10: `[/Indexed [/ICCBased 11 0 R] 3 ${palette(4, 3, 9)}]`, 11: iccStream(3) }, 1, indexSamples);
add('Indexed high value above 255', 'indexed', { 10: `[/Indexed /DeviceGray 400 ${palette(256, 1, 10)}]` }, 1, [['0'], ['100'], ['255'], ['300'], ['-5']]);

// Separation and DeviceN with each kind of function.
const tintSamples = axisPoints(32);
add('Separation exponential to RGB', 'tint', { 10: separation('/DeviceRGB', fnExp('1 1 1', '0.9 0.2 0.1', 1)) }, 1, tintSamples);
add('Separation exponential power 2.2', 'tint', { 10: separation('/DeviceRGB', fnExp('0 0 0', '1 0.5 0.25', 2.2)) }, 1, tintSamples);
add('Separation exponential power 0.5 to CMYK', 'tint', { 10: separation('/DeviceCMYK', fnExp('0 0 0 0', '0.1 0.8 0.9 0.05', 0.5)) }, 1, tintSamples);
add('Separation exponential default C0 C1', 'tint', { 10: separation('/DeviceGray', '<< /FunctionType 2 /Domain [0 1] /N 1 >>') }, 1, tintSamples);
add('Separation exponential through reference', 'tint', { 10: separation('/DeviceRGB', '11 0 R'), 11: fnExp('1 0.5 0', '0 0.5 1', 1) }, 1, tintSamples);
add('Separation exponential to CalRGB', 'tint', { 10: separation(`[/CalRGB << /WhitePoint ${WHITE_D65} /Gamma [2.2 2.2 2.2] >>]`, fnExp('1 1 1', '0.2 0.4 0.9', 1)) }, 1, tintSamples);
add('Separation exponential to Lab', 'tint', {
  10: separation(`[/Lab << /WhitePoint ${WHITE_D50} /Range [-128 127 -128 127] >>]`, fnExp('100 0 0', '20 80 -60', 1)),
}, 1, tintSamples);
add('Separation exponential to ICC', 'tint', { 10: separation('[/ICCBased 11 0 R]', fnExp('1 1 1', '0 0.3 0.6', 1)), 11: iccStream(3) }, 1, tintSamples);
add('Separation sampled 1 to 3 8 bit', 'tint', { 10: separation('/DeviceRGB', '11 0 R'), 11: sampledFn([5], 8, 3) }, 1, tintSamples);
add('Separation sampled encode and decode', 'tint', {
  10: separation('/DeviceRGB', '11 0 R'),
  11: sampledFn([6], 8, 3, '/Encode [1 4] /Decode [1 0 0 0.5 0.25 1]'),
}, 1, tintSamples);
for (const bps of [1, 2, 4, 12, 16, 24, 32]) {
  add(`Separation sampled bps ${bps}`, 'tint', { 10: separation('/DeviceRGB', '11 0 R'), 11: sampledFn([7], bps, 3, '', null, 40 + bps) }, 1, tintSamples);
}
add('Separation sampled to CMYK', 'tint', { 10: separation('/DeviceCMYK', '11 0 R'), 11: sampledFn([4], 8, 4) }, 1, tintSamples);
add('Separation sampled to Gray', 'tint', { 10: separation('/DeviceGray', '11 0 R'), 11: sampledFn([3], 8, 1) }, 1, tintSamples);
add('Separation sampled short data', 'tint', { 10: separation('/DeviceRGB', '11 0 R'), 11: stream('/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [8] /BitsPerSample 8', lcg(10, 3)) }, 1, tintSamples);
add('Separation sampled domain 0 to 2', 'tint', { 10: separation('/DeviceRGB', '11 0 R'), 11: sampledFn([5], 8, 3, '', '0 2') }, 1, [...axisPoints(16), ['2'], ['1.5'], ['2.5']]);
add('Separation stitching of exponentials', 'tint', {
  10: separation('/DeviceRGB', '<< /FunctionType 3 /Domain [0 1] /Functions [11 0 R 12 0 R] /Bounds [0.4] /Encode [0 1 1 0] >>'),
  11: fnExp('1 1 1', '1 0 0', 1),
  12: fnExp('0 0 1', '0 1 0', 1.5),
}, 1, tintSamples);
add('Separation stitching of three with sampled', 'tint', {
  10: separation('/DeviceRGB', '<< /FunctionType 3 /Domain [0 1] /Functions [11 0 R 12 0 R 13 0 R] /Bounds [0.25 0.75] /Encode [0 1 0 1 1 0] >>'),
  11: fnExp('1 1 1', '1 0 0', 1),
  12: sampledFn([4], 8, 3, '', null, 77),
  13: fnExp('0 0 0', '0 0 1', 2),
}, 1, [...tintSamples, ['0.25'], ['0.75'], ['0.4']]);
add('Separation stitching nested', 'tint', {
  10: separation('/DeviceRGB', '<< /FunctionType 3 /Domain [0 1] /Functions [11 0 R 13 0 R] /Bounds [0.5] /Encode [0 1 0 1] >>'),
  11: '<< /FunctionType 3 /Domain [0 1] /Functions [12 0 R 14 0 R] /Bounds [0.5] /Encode [0 1 0 1] >>',
  12: fnExp('1 0 0', '0 1 0', 1),
  13: fnExp('0 0 1', '1 1 1', 1),
  14: fnExp('0.5 0.5 0', '0 0.5 0.5', 3),
}, 1, tintSamples);

// DeviceN with several inputs.
const names2 = ['Cyan2', 'Spot2'];
add('DeviceN sampled 2 inputs', 'devicen', { 10: deviceN(names2, '/DeviceRGB', '11 0 R'), 11: sampledFn([4, 3], 8, 3, '', null, 51) }, 2, grid(2, 8));
add('DeviceN sampled 2 inputs 16 bit', 'devicen', { 10: deviceN(names2, '/DeviceRGB', '11 0 R'), 11: sampledFn([3, 5], 16, 3, '', null, 52) }, 2, grid(2, 8));
add('DeviceN sampled 3 inputs', 'devicen', { 10: deviceN(['A', 'B', 'C'], '/DeviceRGB', '11 0 R'), 11: sampledFn([3, 3, 3], 8, 3, '', null, 53) }, 3, [...grid(3, 5), ...scatter(60, unit(3), 54)]);
add('DeviceN sampled 4 inputs to CMYK', 'devicen', { 10: deviceN(['C', 'M', 'Y', 'K'], '/DeviceCMYK', '11 0 R'), 11: sampledFn([2, 2, 2, 2], 8, 4, '', null, 55) }, 4, [...grid(4, 3), ...scatter(80, unit(4), 56)]);
add('DeviceN sampled 9 inputs simplex', 'devicen', {
  10: deviceN(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], '/DeviceRGB', '11 0 R'),
  11: sampledFn(Array.from({ length: 9 }, () => 2), 8, 3, '', null, 57),
}, 9, scatter(200, unit(9), 58));
add('DeviceN sampled 2 inputs to Lab', 'devicen', {
  10: deviceN(names2, `[/Lab << /WhitePoint ${WHITE_D50} /Range [-128 127 -128 127] >>]`, '11 0 R'),
  11: stream('/FunctionType 0 /Domain [0 1 0 1] /Range [0 100 -128 127 -128 127] /Size [3 3] /BitsPerSample 8', lcg(27, 59)),
}, 2, grid(2, 8));
add('DeviceN name array of one', 'devicen', { 10: deviceN(['Only'], '/DeviceRGB', fnExp('1 1 1', '0 0.5 1', 1)) }, 1, tintSamples);
add('DeviceN name given alone', 'devicen', { 10: `[/DeviceN /Alone /DeviceRGB ${fnExp('1 1 1', '0 0.5 1', 1)}]` }, 1, tintSamples);

// PostScript calculator functions.
const ps = (name, code, nIn, nOut, samples, alt = null) => {
  const names = Array.from({ length: nIn }, (_, i) => `N${i}`);
  const base = alt ?? (nOut === 1 ? '/DeviceGray' : nOut === 3 ? '/DeviceRGB' : '/DeviceCMYK');
  const domain = Array.from({ length: nIn }, () => '0 1').join(' ');
  const range = nOut === 1 ? '0 1' : nOut === 3 ? RANGE3 : RANGE4;
  const target = nIn === 1 ? separation(base, '11 0 R') : deviceN(names, base, '11 0 R');
  add(name, 'postscript', { 10: target, 11: psFn(code, domain, range) }, nIn, samples);
};
const ONE = axisPoints(48);
const TWO = [...grid(2, 8), ...scatter(30, unit(2), 61)];
ps('PS stack shuffling', '{ dup 0.5 mul exch dup 0.25 add exch 1 exch sub }', 1, 3, ONE);
ps('PS ifelse', '{ dup 0.5 gt { 1 exch sub 2 mul 0 0 } { 2 mul 1 1 } ifelse }', 1, 3, ONE);
ps('PS roll const', '{ dup 1 exch sub 0.3 3 -1 roll }', 1, 3, ONE);
ps('PS roll positive', '{ dup 1 exch sub 0.3 3 1 roll }', 1, 3, ONE);
ps('PS trig', '{ dup sqrt exch dup 360 mul sin 2 div 0.5 add exch 90 mul cos 2 div 0.5 add }', 1, 3, ONE);
ps('PS atan ln exp', '{ dup 0.1 add 1 atan 90 div exch dup 1 add ln exch 2 exp 2 exch sub }', 1, 3, ONE);
ps('PS log and sqrt', '{ dup 0.01 add log -2 div exch dup 2 mul sqrt exch pop 0.5 }', 1, 3, ONE);
ps('PS booleans', '{ dup 0.5 gt exch dup 0.25 lt exch 0.9 gt or xor { 1 0 0 } { 0 1 1 } ifelse }', 1, 3, ONE);
ps('PS and not', '{ dup 0.3 gt exch dup 0.8 lt exch pop and not { 0.9 0.1 0.1 } { 0.1 0.1 0.9 } ifelse }', 1, 3, ONE);
ps('PS integer ops', '{ 255 mul cvi dup 85 idiv 3 div exch dup 7 mod 7 div exch -3 bitshift 255 div }', 1, 3, ONE);
ps('PS bitshift left', '{ 255 mul cvi dup 2 bitshift 1023 div exch 3 bitshift 2047 div 0.5 }', 1, 3, ONE);
ps('PS and or xor integers', '{ 255 mul cvi dup 170 and 255 div exch dup 85 or 255 div exch 15 xor 255 div }', 1, 3, ONE);
ps('PS not integer', '{ 255 mul cvi dup not abs 256 div exch 0 gt { 0.5 } { 0.25 } ifelse 1 }', 1, 3, ONE);
ps('PS rounding', '{ dup 3 mul round 3 div exch dup 2 mul 1 sub abs exch 5 mul floor 5 div }', 1, 3, ONE);
ps('PS ceiling truncate neg', '{ dup 4 mul ceiling 4 div exch dup 3 mul neg truncate -3 div exch 0.5 sub neg }', 1, 3, ONE);
ps('PS div by zero', '{ dup 0 div exch dup 0 idiv exch 1 add }', 1, 3, ONE);
ps('PS if without else', '{ dup 0.3 lt { pop 0 } if dup 0.7 gt { pop 1 } if dup dup }', 1, 3, ONE);
ps('PS if pushing', '{ dup 0.5 gt { 0.25 } if 0.1 }', 1, 3, ONE);
ps('PS copy and index', '{ dup 1 exch sub dup 2 index mul exch 3 copy pop pop pop }', 1, 3, ONE);
ps('PS copy of two', '{ 2 copy add 0.5 mul }', 1, 3, ONE);
ps('PS dynamic roll falls to the interpreter', '{ dup 0.5 add 0.25 3 3 index 3 mul cvi roll }', 1, 3, ONE);
ps('PS dynamic copy falls to the interpreter', '{ dup 2 mul cvi 1 add copy pop pop 0.5 0.25 }', 1, 3, ONE);
ps('PS short stack falls to the interpreter', '{ dup 0.5 gt { pop } if 0.5 0.25 }', 1, 3, ONE);
ps('PS true false cvr', '{ cvr dup 0.5 ge { true } { false } ifelse { 1 0 } { 0 1 } ifelse 0.3 }', 1, 3, ONE);
ps('PS shared sub expression', '{ dup dup mul dup 0.3 mul exch 0.6 mul exch 0.9 mul }', 1, 3, ONE);
ps('PS min max abs', '{ dup 0.5 sub abs 2 mul dup 1 gt { pop 1 } if exch dup 0.3 lt { pop 0.3 } { 0.6 } ifelse exch pop 0.2 }', 1, 3, ONE);
ps('PS constants fold', '{ pop 0.5 0.25 add 2 mul 3 4 mul 12 div 0.1 }', 1, 3, ONE);
ps('PS power forms', '{ dup 0.5 exp exch dup 2 exp exch 3 exp }', 1, 3, ONE);
ps('PS power negative base', '{ -0.5 add dup 3 exp exch dup 0.25 exp exch 4 exp }', 1, 3, ONE);
ps('PS two inputs', '{ 2 copy add 2 div 3 1 roll 2 copy mul 3 1 roll sub abs }', 2, 3, TWO);
ps('PS two inputs ifelse', '{ 2 copy gt { exch } if 0.5 }', 2, 3, TWO);
ps('PS to CMYK', '{ dup dup dup 0.3 mul }', 1, 4, ONE);
ps('PS to Gray', '{ dup mul }', 1, 1, ONE);
ps('PS comment and whitespace', '{ % comment\n dup 0.5\tmul\r\n exch 1 exch sub 0.25 }', 1, 3, ONE);
ps('PS unknown operator reads as zero', '{ dup frobnicate 0.5 }', 1, 3, ONE);
ps('PS to Lab', '{ dup 100 mul exch dup 160 mul 80 sub exch 100 mul 50 sub }', 1, 3, ONE, `[/Lab << /WhitePoint ${WHITE_D50} /Range [-128 127 -128 127] >>]`);

// Colour spaces pdf.js cannot build: the evaluator keeps DeviceGray.
const failing = [];
const fail = (name, objects, comps) => failing.push({ name, objects, comps, samples: [['0.5', '0.2', '0.1', '0.3'].slice(0, Math.max(comps, 1))], operand: '/CS0' });
fail('Lab without white point', { 10: '[/Lab << /Range [-100 100 -100 100] >>]' }, 3);
fail('CalRGB white point Y not one', { 10: '[/CalRGB << /WhitePoint [0.95 0.9 1.089] >>]' }, 3);
fail('CalGray without white point', { 10: '[/CalGray << /Gamma 2 >>]' }, 1);
fail('Separation with unknown function type', { 10: separation('/DeviceRGB', '<< /FunctionType 9 /Domain [0 1] >>') }, 1);
fail('Separation sampled without domain', { 10: separation('/DeviceRGB', '11 0 R'), 11: stream('/FunctionType 0 /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8', [1, 2, 3, 4, 5, 6]) }, 1);
fail('Stitching of a two input function', {
  10: separation('/DeviceRGB', '<< /FunctionType 3 /Domain [0 1] /Functions [11 0 R] /Bounds [] /Encode [0 1] >>'),
  11: stream('/FunctionType 0 /Domain [0 1 0 1] /Range [0 1 0 1 0 1] /Size [2 2] /BitsPerSample 8', lcg(12, 3)),
}, 1);
fail('PostScript without braces', { 10: separation('/DeviceRGB', '11 0 R'), 11: psFn('dup mul', '0 1', RANGE3) }, 1);
fail('PostScript if without block', { 10: separation('/DeviceRGB', '11 0 R'), 11: psFn('{ dup if }', '0 1', RANGE3) }, 1);

// ---- record --------------------------------------------------------------------------------------------------------

const out = {
  note: 'Recorded from pdf.js 6.4 (legacy build, the office engine opens documents with it); tests/twin_colour.rs replays it.',
  pdfjs: pdfjs.version,
  csObject: 10,
  cases: [],
  failing: [],
  icc: {},
};

for (const spec of cases) {
  const pdf = colourPdf(spec.objects, spec.operand, spec.samples);
  const hexes = await run(pdf);
  if (hexes.length !== spec.samples.length) throw new Error(`${spec.name}: ${hexes.length} colours for ${spec.samples.length} samples`);
  out.cases.push({ name: spec.name, group: spec.group, comps: spec.comps, operand: spec.operand, pdf: pdf.toString('hex'), samples: spec.samples.map((s) => s.map(Number)), rgb: hexes });
}

for (const spec of failing) {
  const hexes = await run(colourPdf(spec.objects, spec.operand, spec.samples));
  const gray = await run(colourPdf({}, '/DeviceGray', spec.samples));
  if (hexes.length !== 1 || hexes[0] !== gray[0]) throw new Error(`${spec.name}: pdf.js built a colour space: ${hexes}`);
  out.failing.push({ name: spec.name, comps: spec.comps, operand: spec.operand, pdf: colourPdf(spec.objects, spec.operand, spec.samples).toString('hex'), fallback: 'gray' });
}

// Does ICCBased build a transform? Compare the real CMYK profile with DeviceCMYK on a grid.
{
  const samples = grid(4, 4);
  const withProfile = await run(colourPdf({ 10: '[/ICCBased 11 0 R]', 11: stream('/N 4', profile) }, '/CS0', samples));
  const device = await run(colourPdf({}, '/DeviceCMYK', samples));
  out.icc = { profile: 'CGATS001Compat-v2-micro.icc', samples: samples.length, qcmsLoads: withProfile.some((value, i) => value !== device[i]) };
}

const fixtures = path.join(FIXTURES_ROOT, 'office-colour');
mkdirSync(fixtures, { recursive: true });
const lines = [
  '{',
  `  "note": ${JSON.stringify(out.note)},`,
  `  "pdfjs": ${JSON.stringify(out.pdfjs)},`,
  `  "csObject": ${out.csObject},`,
  `  "icc": ${JSON.stringify(out.icc)},`,
  `  "cases": [\n${out.cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ],`,
  `  "failing": [\n${out.failing.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
  '}',
  '',
];
const data = lines.join('\n');
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-colour', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.cases.length} cases, ${out.failing.length} failing, qcmsLoads ${out.icc.qcmsLoads}`);
