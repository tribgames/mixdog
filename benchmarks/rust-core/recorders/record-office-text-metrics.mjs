#!/usr/bin/env node
// What src/runtime/office/portable/text-metrics.mjs answers: text widths, wrapped lines (Korean line-break rules, long
// words, punctuation at line ends), text blocks (soft breaks, mixed run sizes, line spacing), and the reviews built on
// them (text-box fit, contrast, spacing, vertical balance, stat labels, CJK tracking) with the font-size repair. Rust
// `mixdog-ooxml` (crates/mixdog-ooxml/tests/twin_text_metrics.rs) must answer the same: line breaks and review findings
// exactly, widths and heights within 1e-3.
//
// The same font files are registered on both sides. The deterministic cases use three small OFL faces kept beside the
// office-measure recording (native/core/fixtures/office-measure/faces) under names no installed font has, so the machine's
// own fonts do not take part; 'Liberation Sans' carries one of them so that 'Helvetica' resolves to its metric twin.
// The Hangul cases use the provisioned Noto Sans KR under the twin name 'Twin Noto Sans KR' (a CJK family by name) and are
// recorded only when it is installed, with the sha256 of the file recorded from. A Latin face handing Hangul to the East
// Asian fallback depends on the machine's fonts and is not recorded.
//
//   node benchmarks/rust-core/recorders/record-office-text-metrics.mjs --tree <dir with node_modules> [--faces <dir>]
//
// `--faces` names the folder of the three faces when this checkout does not hold native/core/fixtures/office-measure.
// Output: native/core/fixtures/office-text-metrics/golden.json.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const recorder = 'benchmarks/rust-core/recorders/record-office-text-metrics.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-text-metrics');
const stage = stageSet(finalDir, ['golden.json']);
const { GlobalFonts } = createRequire(join(tree, 'package.json'))('@napi-rs/canvas');

const FACES = args.has('faces') ? resolve(args.get('faces')) : join(FIXTURES_ROOT, 'office-measure', 'faces');
const FIXTURE_FACES = {
  'Twin Lisu': [
    { file: 'NotoSansLisu-Regular.ttf', weight: 400 },
    { file: 'NotoSansLisu-Bold.ttf', weight: 700 },
  ],
  'Twin Hebrew': [{ file: 'NotoSansHebrew-Regular.ttf', weight: 400 }],
  'Twin Miriam': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
  'Liberation Sans': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
};
for (const [alias, list] of Object.entries(FIXTURE_FACES)) for (const { file } of list) GlobalFonts.registerFromPath(join(FACES, file), alias);

const userFontDirectory = () => {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Fonts');
  return join(homedir(), '.local', 'share', 'fonts');
};
const systemFontDirectory = () => {
  if (process.platform === 'win32') return join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  if (process.platform === 'darwin') return '/Library/Fonts';
  return '/usr/share/fonts';
};
const NOTO = { id: 'noto-sans-kr', alias: 'Twin Noto Sans KR', fileName: 'NotoSansKR-Variable.ttf' };
let noto = null;
const notoPath = [join(userFontDirectory(), NOTO.fileName), join(systemFontDirectory(), NOTO.fileName)].find((candidate) => existsSync(candidate));
if (notoPath) {
  const bytes = readFileSync(notoPath);
  GlobalFonts.registerFromPath(notoPath, NOTO.alias);
  noto = { ...NOTO, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const installedFamilies = new Set((GlobalFonts.families || []).map((entry) => String(entry?.family || '').toLowerCase()));
const free = (name) => !installedFamilies.has(name.toLowerCase());

const metrics = await importFrom(tree, 'src/runtime/office/portable/text-metrics.mjs');

// ---- corpus ---------------------------------------------------------------------------------------------------------

const LATIN = ['Twin Miriam', 'Twin Lisu'];
const SIZES = [9, 13, 18, 36];
const KOREAN = '시장 점유율이 전년 대비 크게 늘었고, 신규 고객(기업)의 비중도 커졌습니다.';
const TEXTS = [
  'Hello World',
  'The quick brown fox jumps over the lazy dog and keeps running.',
  'AVATAR To Ty 47,210 (12.5%)',
  'https://example.com/a/very/long/path/that/never/breaks/anywhere?x=1&y=2',
  'Supercalifragilisticexpialidocious',
  'ends with a mark, and "quoted" text: yes; no! maybe? (done)',
  '  leading and trailing  ',
  'one two',
  '',
  'ש ל ו ם Hello',
];
const KOREAN_TEXTS = [KOREAN, '안녕하세요 반갑습니다', 'GPT-5.6 Sol 대비 +4.3%p 상승', '가격: 47,210원 (12.5%)', '「인용」과 “따옴표”, 그리고 말줄임…', 'Hello 안녕 ABC 123'];

const font = (fontName, fontSize, extra = {}) => ({ fontName, fontSize, ...extra });
const cases = { widths: [], wraps: [], blocks: [], spacing: [], contrast: [], tracking: [], fit: [], balance: [], stat: [], shrink: [], luminance: [] };

for (const name of LATIN) {
  for (const size of SIZES) {
    for (const value of TEXTS) {
      for (const style of [{}, { bold: true }, { italic: true }]) cases.widths.push({ text: value, font: font(name, size, style) });
    }
  }
}
for (const [fontName, size] of [
  ['Twin Lisu Semibold', 18],
  ['Twin Lisu Light', 18],
  ['Twin Lisu Light', 13],
  ['Helvetica', 18],
  ['"Twin Miriam"', 18],
  ['Twin Miriam', undefined],
  ['Twin Miriam', 0.4],
  ['Twin Miriam', 14.88],
]) {
  if (fontName === 'Helvetica' && !free('Helvetica')) continue;
  cases.widths.push({ text: 'Hello World 123', font: font(fontName, size) });
}
if (noto) {
  for (const size of SIZES) {
    for (const value of [...KOREAN_TEXTS, ...TEXTS.slice(0, 4)]) {
      for (const style of [{}, { bold: true }]) cases.widths.push({ text: value, font: font(NOTO.alias, size, style), requires: NOTO.id });
    }
  }
}

const WIDTHS = [24, 60, 90, 140, 220, 400, 900];
for (const name of LATIN) {
  for (const size of [13, 18, 24]) {
    for (const value of TEXTS) for (const width of WIDTHS) cases.wraps.push({ text: value, width, font: font(name, size) });
  }
}
for (const width of [0, -5, null, 1]) cases.wraps.push({ text: 'Hello World', width, font: font('Twin Miriam', 18) });
if (noto) {
  for (const size of [13, 18, 24]) {
    for (const value of KOREAN_TEXTS) for (const width of [60, 100, 160, 240, 400]) cases.wraps.push({ text: value, width, font: font(NOTO.alias, size), requires: NOTO.id });
  }
}

const para = (value, extra = {}) => ({ text: value, fontName: 'Twin Miriam', fontSize: 18, ...extra });
const blockInputs = [
  { paragraphs: [para('Hello World this is a paragraph that wraps')], options: { width: 160 } },
  { paragraphs: [para('Hello World this is a paragraph that wraps')], options: { width: 0 } },
  { paragraphs: [para('Line one\nLine two is longer than line one\n\nLine four')], options: { width: 200 } },
  { paragraphs: [para('A', { spaceBefore: 6, spaceAfter: 12 }), para('B', { lineSpacing: 1.5 }), para('C', { lineSpacing: 0 })], options: { width: 100, lineSpacing: 2 } },
  { paragraphs: [para('A b c d e f g h i j k l m n o p', { fontSize: 14 })], options: { width: 120, lineHeightRatio: 1.5 } },
  { paragraphs: [para('+4.3%p', { fontSize: 47, runs: [{ text: '+4.3', fontSize: 47 }, { text: '%p', fontSize: 19 }] })], options: { width: 400 } },
  { paragraphs: [para('+4.3%p', { fontSize: 47, runs: [{ text: '+4.3', fontSize: 47 }, { text: '%p', fontSize: 19 }] })], options: { width: 60 } },
  { paragraphs: [para('+4.3%p', { fontSize: 47, runs: [{ text: '+4.3', fontSize: 47 }, { text: '%p', fontSize: 19 }] })], options: {} },
  {
    paragraphs: [
      para('Big\nsmall words here', { fontSize: 14, runs: [{ text: 'Big\n', fontSize: 14 }, { text: 'small words here', fontSize: 10 }], spaceBefore: 3, spaceAfter: 4 }),
    ],
    options: { width: 90 },
  },
  { paragraphs: [para('Same\nsizes', { runs: [{ text: 'Same\nsi', fontSize: 18 }, { text: 'zes', fontSize: 18 }] })], options: { width: 90 } },
  { paragraphs: [para('Supercalifragilisticexpialidocious and more')], options: { width: 80 } },
  { paragraphs: [], options: { width: 100 } },
  { paragraphs: [{ text: 'defaults only', fontName: 'Twin Miriam' }], options: { width: 300 } },
  { paragraphs: [para('Bold bits', { bold: true, italic: true, fontName: 'Twin Lisu' })], options: { width: 70 } },
];
if (noto) {
  const kp = (value, extra = {}) => ({ text: value, fontName: NOTO.alias, fontSize: 18, ...extra });
  blockInputs.push(
    { paragraphs: [kp(KOREAN)], options: { width: 200 } },
    { paragraphs: [kp(KOREAN, { fontSize: 13 }), kp('두 번째 문단입니다.', { spaceBefore: 6 })], options: { width: 160 } },
    {
      paragraphs: [kp('GPT-5.6 Sol\nCodex CLI 대비', { runs: [{ text: 'GPT-5.6 Sol\n', fontSize: 14 }, { text: 'Codex CLI 대비', fontSize: 10 }] })],
      options: { width: 120 },
    }
  );
}
for (const input of blockInputs) cases.blocks.push({ ...input, requires: JSON.stringify(input).includes(NOTO.alias) ? NOTO.id : undefined });

const box = (slide, shape, left, top, width, height, paragraphs, extra = {}) => ({ slide, shape, left, top, width, height, paragraphs, ...extra });
const copy = (value, extra = {}) => para(value, { fontSize: 14, ...extra });
const miriam = (value, extra = {}) => para(value, { fontSize: 18, ...extra });

// Spacing: neighbours in rows and columns, labels, aligned columns, diagonals, overlaps.
const spacingBoxes = [
  box(1, 1, 0, 0, 200, 60, [copy('A block of body copy that is long')]),
  box(1, 2, 0, 66, 200, 60, [copy('Another block of body copy that is long')]),
  box(1, 3, 210, 0, 200, 60, [copy('A third block of body copy here')]),
  box(1, 4, 205, 200, 100, 40, [copy('Step 1')]),
  box(1, 5, 300, 200, 100, 40, [copy('Notes for the step here, long enough')]),
  box(1, 6, 10, 70, 100, 40, [copy('Overlapping the second block entirely')]),
  box(2, 1, 0, 0, 100, 40, [copy('Slide two block with plenty of words')]),
  box(2, 2, 0, 50, 60, 40, [copy('Narrower block below, misaligned text')]),
  box(2, 3, 90, 50, 60, 40, [copy('Right one misaligned as well, ok')]),
  box(3, 1, 0, 0, 50, 20, []),
];
cases.spacing.push({ boxes: spacingBoxes, options: {} });
cases.spacing.push({ boxes: spacingBoxes, options: { minimumGap: 8 } });

// Contrast.
cases.contrast.push({
  boxes: [
    box(1, 1, 0, 0, 100, 40, [copy('Dark on white', { color: '222222' })], { background: 'FFFFFF' }),
    box(1, 2, 0, 0, 100, 40, [copy('Grey on white small', { color: '999999', fontSize: 12 })], { background: 'FFFFFF' }),
    box(1, 3, 0, 0, 100, 40, [copy('Grey on white large', { color: '999999', fontSize: 20 })], { background: 'FFFFFF' }),
    box(1, 4, 0, 0, 100, 40, [copy('Grey on white bold', { color: '999999', fontSize: 14, bold: true })], { background: 'FFFFFF' }),
    box(1, 5, 0, 0, 100, 40, [copy('Default colour on black')], { background: '000000' }),
    box(1, 6, 0, 0, 100, 40, [copy('Two paragraphs', { color: 'AAAAAA', fontSize: 12 }), copy('Worse', { color: 'CCCCCC', fontSize: 12 })], { background: '#FFFFFF' }),
    box(1, 7, 0, 0, 100, 40, [copy('Bad colour', { color: 'nothex' })], { background: 'FFFFFF' }),
    box(1, 8, 0, 0, 100, 40, [copy('   ', { color: 'FFFFFF' })], { background: 'FFFFFF' }),
    box(1, 9, 0, 0, 100, 40, [copy('No background', { color: 'FFFFFF' })]),
  ],
});
for (const [foreground, background] of [
  ['000000', 'FFFFFF'],
  ['#336699', 'ffffff'],
  ['12345', 'FFFFFF'],
  ['ABCDEF', 'zzzzzz'],
  ['xx336699', '112233'],
  [null, 'FFFFFF'],
  ['FF0000', '00FF00'],
]) {
  cases.luminance.push({ foreground, background });
}

// Tracking.
cases.tracking.push({
  boxes: [
    box(1, 1, 0, 0, 200, 40, [copy('안녕하세요', { fontSize: 20, charSpacing: 2 })]),
    box(1, 2, 0, 0, 200, 40, [copy('KICKER', { fontSize: 20, charSpacing: 4 })]),
    box(1, 3, 0, 0, 200, 40, [copy('안녕', { fontSize: 20, charSpacing: 0.5 }), copy('하세요', { fontSize: 10, charSpacing: 3 })]),
    box(1, 4, 0, 0, 200, 40, [copy('漢字かな', { fontSize: 12, charSpacing: 1.234 })]),
  ],
});

// Fit.
const fitBoxes = [
  box(1, 1, 0, 0, 300, 100, [miriam('Fits comfortably')]),
  box(1, 2, 0, 0, 300, 20, [miriam('alpha beta gamma delta epsilon zeta eta theta iota')]),
  box(1, 3, 0, 0, 40, 400, [miriam('Supercalifragilistic word')]),
  box(1, 4, 0, 0, 90, 400, [miriam('one two three four five six seven')]),
  box(1, 5, 0, 0, 100, 30, [miriam('Unwrapped text that is way too wide for the shape')], { wrap: false }),
  box(1, 6, 0, 0, 300, 100, [miriam('Unknown font', { fontName: 'Zzz Missing' })]),
  box(1, 7, 0, 0, 300, 10, [miriam('Unknown font overflowing here', { fontName: 'Zzz Missing' })]),
  box(1, 8, 600, 0, 200, 100, [miriam('Past the edge')]),
  box(1, 9, 0, 0, 300, 10, [miriam('Autofit skips this')], { autofit: true }),
  box(1, 10, 0, 0, 300, 10, [miriam('   ')]),
  box(1, 11, 0, 0, 120, 80, [miriam('Inset box with text'), miriam('Second paragraph wraps too here')], { insetLeft: 10, insetRight: 10, insetTop: 5, insetBottom: 5 }),
  box(1, 13, 0, 0, 300, 60, [miriam('Light weight', { fontName: 'Twin Lisu Light' })]),
  box(1, 15, 0, 0, 300, 60, [miriam('Empty font name', { fontName: '' }), miriam('Spaced name', { fontName: '  Zzz Missing  ' })]),
];
if (free('Helvetica')) fitBoxes.push(box(1, 12, 0, 0, 300, 60, [miriam('Helvetica named', { fontName: 'Helvetica' })]));
cases.fit.push({ boxes: fitBoxes, options: { slideWidth: 720, slideHeight: 540 } });
cases.fit.push({ boxes: fitBoxes, options: { slideWidth: 0, slideHeight: 0, tolerance: 1 } });
if (noto) {
  const kp = (value, extra = {}) => para(value, { fontName: NOTO.alias, fontSize: 18, ...extra });
  cases.fit.push({
    boxes: [box(1, 1, 0, 0, 200, 40, [kp(KOREAN)]), box(1, 2, 0, 0, 100, 300, [kp('가격은 47,210원입니다')]), box(1, 3, 0, 0, 300, 100, [kp(KOREAN, { fontSize: 13 })])],
    options: { slideWidth: 720, slideHeight: 540 },
    requires: NOTO.id,
  });
}

// Vertical balance, statement pages and carriers.
const bound = (slide, top, height, extra = {}) => ({ slide, left: 0, top, width: 300, height, kind: 'p:sp', name: 'Shape', ...extra });
cases.balance.push({
  bounds: [
    bound(1, 10, 100),
    bound(1, 130, 40),
    bound(2, 30, 60),
    bound(2, 400, 40),
    bound(3, 250, 200),
    bound(4, 10, 40),
    bound(4, 100, 40),
    bound(4, 300, 200),
    bound(5, 20, 60),
    bound(5, 400, 40, { kind: 'p:graphicFrame', name: 'Table 1' }),
    bound(6, 20, 60),
    bound(6, 400, 40, { kind: 'p:pic', name: 'mixdog-device:orb' }),
    bound(7, 0, 540, { width: 720 }),
    bound(7, 10, 20),
    bound(8, 380, 100),
  ],
  boxes: [
    box(2, 1, 0, 30, 600, 60, [miriam('A claim set large', { fontSize: 28 })]),
    box(2, 2, 0, 400, 600, 40, [miriam('The takeaway line', { fontSize: 16 })]),
    box(5, 1, 0, 20, 600, 60, [miriam('A title over a table', { fontSize: 28 })]),
    box(5, 2, 0, 400, 600, 40, [miriam('Takeaway under it', { fontSize: 16 })]),
    box(6, 1, 0, 20, 600, 60, [miriam('A title over a device', { fontSize: 28 })]),
    box(6, 2, 0, 400, 600, 40, [miriam('Takeaway under it', { fontSize: 16 })]),
    box(3, 1, 0, 250, 600, 60, [miriam('Poster size', { fontSize: 60 })]),
  ],
  options: { slideWidth: 720, slideHeight: 540 },
});
cases.balance.push({ bounds: [bound(1, 10, 100)], boxes: [], options: { slideWidth: 0, slideHeight: 540 } });

// Stat labels.
const rel = (id, role, extra = {}) => ({ id, role, ...extra });
const statBoxes = [
  box(1, 1, 0, 0, 100, 60, [miriam('47,210', { fontSize: 40 })]),
  box(1, 2, 0, 300, 100, 20, [miriam('Revenue', { fontSize: 12 })]),
  box(1, 3, 200, 0, 100, 60, [miriam('+4.3%p', { fontSize: 40 })]),
  box(1, 4, 200, 70, 100, 20, [miriam('Margin', { fontSize: 12 })]),
  box(1, 5, 400, 0, 100, 60, [miriam('Version', { fontSize: 40 })]),
  box(1, 6, 400, 0, 100, 60, [miriam('12345678901234567', { fontSize: 40 })]),
  box(1, 7, 0, 100, 100, 60, [miriam('99', { fontSize: 20 })]),
  box(2, 1, 0, 0, 100, 60, [miriam('88', { fontSize: 40 })], { relation: rel('v1', 'value', { label: 'l1' }) }),
  box(2, 2, 0, 200, 100, 20, [miriam('Far label', { fontSize: 12 })], { relation: rel('l1', 'label') }),
  box(2, 3, 200, 0, 100, 60, [miriam('77', { fontSize: 40 })], { relation: rel('v2', 'value', { label: 'missing' }) }),
  box(2, 4, 300, 0, 100, 60, [miriam('66', { fontSize: 40 })], { relation: rel('dup', 'label') }),
  box(2, 5, 300, 70, 100, 60, [miriam('55', { fontSize: 40 })], { relation: rel('dup', 'label') }),
  box(2, 6, 0, 400, 100, 20, [miriam('Bad', { fontSize: 12 })], { relationError: 'Invalid shape relationship declaration' }),
  box(3, 1, 0, 0, 100, 60, [miriam('12.5', { fontSize: 36 })]),
];
cases.stat.push({ boxes: statBoxes, options: {} });
cases.stat.push({ boxes: statBoxes, options: { maximumGap: 500 } });

// Shrink.
const shrinkParagraphs = (size) => [
  miriam('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda', { fontSize: size }),
  miriam('second paragraph of the box', { fontSize: Math.round(size / 2) }),
];
for (const [size, width, height, options] of [
  [30, 2000, 100, {}],
  [30, 300, 100, {}],
  [30, 200, 120, {}],
  [60, 300, 60, {}],
  [30, 200, 10, {}],
  [30, 200, 120, { minimumFontSize: 12 }],
  [30, 200, 150, { steps: [30, 27, 24, 21, 18] }],
  [30, 200, 100, { steps: [] }],
]) {
  cases.shrink.push({ paragraphs: shrinkParagraphs(size), options: { width, height, ...options } });
}
cases.shrink.push({ paragraphs: [], options: { width: 100, height: 100 } });

// ---- record ---------------------------------------------------------------------------------------------------------

const clean = (value) => JSON.parse(JSON.stringify(value));
const run = {
  widths: ({ text: value, font: spec }) => ({ width: metrics.measureTextWidth(value, spec) }),
  wraps: ({ text: value, width, font: spec }) => ({ lines: metrics.wrapParagraph(value, width, spec) }),
  blocks: ({ paragraphs, options }) => metrics.measureTextBlock(paragraphs, options),
  spacing: ({ boxes, options }) => metrics.reviewShapeSpacing(boxes, options),
  contrast: ({ boxes }) => metrics.reviewTextContrast(boxes),
  tracking: ({ boxes }) => metrics.reviewCjkTracking(boxes),
  fit: ({ boxes, options }) => metrics.reviewTextBoxFit(boxes, options),
  balance: ({ bounds, boxes, options }) => metrics.reviewVerticalBalance(bounds, { ...options, boxes }),
  stat: ({ boxes, options }) => metrics.reviewStatLabelProximity(boxes, options),
  shrink: ({ paragraphs, options }) => metrics.shrinkFontSizeToFit(paragraphs, options),
  luminance: ({ foreground, background }) => ({ luminance: metrics.relativeLuminance(foreground), contrast: metrics.contrastRatio(foreground, background) }),
};
const recorded = {};
let count = 0;
for (const [kind, list] of Object.entries(cases)) {
  recorded[kind] = list.map((input) => {
    count += 1;
    const { requires, ...rest } = input;
    return clean({ input: rest, ...(requires ? { requires } : {}), output: run[kind](input) });
  });
}

writeJson(join(stage, 'golden.json'), {
  engine: '@napi-rs/canvas 1.0.11',
  platform: process.platform,
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))])),
  noto,
  cases: recorded,
});
writeSetManifest(stage, {
  set: 'office-text-metrics',
  recorder,
  command: `node ${recorder} --tree <dir with node_modules>`,
  identityTree: tree,
  extra: { provenance: recordingProvenance(recorder) },
});
commitStage(stage, finalDir);
console.log(`wrote ${join(finalDir, 'golden.json')} (${count} cases${noto ? ', with Noto Sans KR' : ', without Noto Sans KR'})`);
