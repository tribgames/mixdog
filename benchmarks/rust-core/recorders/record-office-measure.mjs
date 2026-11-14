#!/usr/bin/env node
// What @napi-rs/canvas 1.0.11 answers for ctx.measureText (the engine behind src/runtime/office/portable/text-metrics.mjs):
// a corpus of fonts, sizes and texts measured after the same font files are registered, and for each case the face that
// sets every character. Rust `mixdog-fonts` must answer the same for the same files (crates/mixdog-fonts/tests/twin_measure.rs).
//
// The deterministic cases register three small OFL faces kept beside the recording (native/core/fixtures/office-measure/faces:
// Noto Sans Lisu Regular and Bold, Noto Sans Hebrew Regular, Miriam Libre Regular) under names no installed font has, so the
// machine's own fonts do not take part. The cases that use the provisioned Noto faces (Noto Sans, Noto Sans KR) are recorded
// only when those files are installed, each with the sha256 of the file it was recorded from.
//
//   node benchmarks/rust-core/recorders/record-office-measure.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/office-measure/golden.json.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const recorder = 'benchmarks/rust-core/recorders/record-office-measure.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-measure');
const stage = stageSet(finalDir, ['golden.json']);
const requireFromTree = createRequire(join(tree, 'package.json'));
const { createCanvas, GlobalFonts } = requireFromTree('@napi-rs/canvas');
const fontkit = requireFromTree('@pdf-lib/fontkit');

const FACES = join(finalDir, 'faces');
// alias -> the files registered under it, with the weight each carries.
const FIXTURE_FACES = {
  'Twin Lisu': [
    { file: 'NotoSansLisu-Regular.ttf', weight: 400 },
    { file: 'NotoSansLisu-Bold.ttf', weight: 700 },
  ],
  'Twin Hebrew': [{ file: 'NotoSansHebrew-Regular.ttf', weight: 400 }],
  'Twin Miriam': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
};

// The provisioned faces (portable/font-provisioner.mjs NOTO_FONT_DEFINITIONS), registered under twin names.
const NOTO = [
  { id: 'noto-sans-latin', alias: 'Twin Noto Sans', fileName: 'NotoSans-Variable.ttf' },
  { id: 'noto-sans-kr', alias: 'Twin Noto Sans KR', fileName: 'NotoSansKR-Variable.ttf' },
];
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

const faceFiles = {}; // alias -> [{ path, name, weight, font (fontkit) }]
for (const [alias, list] of Object.entries(FIXTURE_FACES)) {
  faceFiles[alias] = list.map(({ file, weight }) => {
    const path = join(FACES, file);
    GlobalFonts.registerFromPath(path, alias);
    return { path, name: file, weight, font: fontkit.create(readFileSync(path)) };
  });
}
const installedNoto = [];
for (const entry of NOTO) {
  const path = [join(userFontDirectory(), entry.fileName), join(systemFontDirectory(), entry.fileName)].find((candidate) => existsSync(candidate));
  if (!path) continue;
  const bytes = readFileSync(path);
  GlobalFonts.registerFromPath(path, entry.alias);
  faceFiles[entry.alias] = [{ path, name: entry.fileName, weight: 400, font: fontkit.create(bytes) }];
  installedNoto.push({ ...entry, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}

const context = createCanvas(8, 8).getContext('2d');

// The face that sets `character` for a family list: the first family's face (bold picks the bold file where there is one)
// whose cmap has it, else the first family's face (its .notdef).
function pickFile(alias, bold) {
  const list = faceFiles[alias];
  return (bold && list.find((face) => face.weight >= 600)) || list[0];
}
function facesOf(families, bold, text) {
  const chain = families.map((alias) => pickFile(alias, bold));
  return [...text].map((character) => (chain.find((face) => face.font.hasGlyphForCodePoint(character.codePointAt(0))) ?? chain[0]).name);
}

const cases = [];
function record({ families, size, bold = false, italic = false, text, letterSpacing = 0, requires = null }) {
  const font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${families.map((alias) => `"${alias}"`).join(', ')}`;
  context.letterSpacing = `${letterSpacing}px`;
  context.font = font;
  const m = context.measureText(text);
  // The horizontal ink is reproducible for TrueType outlines set in a face that really has the style: a synthesised bold or
  // italic widens the ink, and the CFF face's outlines are bounded differently by Skia. Only printable ASCII text is marked:
  // right-to-left and fallback runs order their glyphs differently.
  const trueTypeOnly = families.every((alias) => alias !== 'Twin Miriam' && !alias.startsWith('Twin Noto Sans KR'));
  const realStyle = !italic && (!bold || families.every((alias) => (faceFiles[alias] ?? []).some((face) => face.weight >= 600)));
  cases.push({
    font,
    text,
    letterSpacing,
    ...(requires ? { requires } : {}),
    inkHorizontal: trueTypeOnly && realStyle && letterSpacing === 0 && /^[\x20-\x7e]*$/.test(text),
    faces: facesOf(families, bold, text),
    metrics: {
      width: m.width,
      actualBoundingBoxLeft: m.actualBoundingBoxLeft,
      actualBoundingBoxRight: m.actualBoundingBoxRight,
      actualBoundingBoxAscent: m.actualBoundingBoxAscent,
      actualBoundingBoxDescent: m.actualBoundingBoxDescent,
      fontBoundingBoxAscent: m.fontBoundingBoxAscent,
      fontBoundingBoxDescent: m.fontBoundingBoxDescent,
      alphabeticBaseline: m.alphabeticBaseline,
      emHeightAscent: m.emHeightAscent,
      emHeightDescent: m.emHeightDescent,
    },
  });
  context.letterSpacing = '0px';
}

const LATIN = [
  'Hello World',
  'The quick brown fox jumps over the lazy dog',
  'AVATAR To Ty',
  'fi fl ffi office',
  '0123456789 47,210.5%',
  'Tel: +82-10-1234-5678',
  '(abc)[def]{ghi}',
  'a',
  'j',
  ' lead',
  'tail ',
  '',
  '   ',
];
const SIZES = [6, 9, 12, 16, 24, 36, 96];

for (const size of SIZES) {
  for (const style of [{}, { bold: true }, { italic: true }, { bold: true, italic: true }]) {
    for (const text of LATIN) record({ families: ['Twin Lisu'], size, text, ...style });
  }
}
for (const size of [9, 16, 36]) for (const text of LATIN) record({ families: ['Twin Miriam'], size, text });
for (const size of [12, 16, 24]) {
  for (const text of ['שלום עולם', 'abc שלום def', 'Hello', 'שלום 123 עולם']) record({ families: ['Twin Hebrew'], size, text });
}
// A family list: each character in the first family that has it.
for (const text of ['Hello שלום', 'שלום Hello', 'a שלום b 12']) {
  record({ families: ['Twin Lisu', 'Twin Hebrew'], size: 16, text });
  record({ families: ['Twin Hebrew', 'Twin Lisu'], size: 16, text });
  record({ families: ['Twin Lisu', 'Twin Hebrew'], size: 16, bold: true, text });
}
// Characters no face has are the .notdef of the first family's face.
for (const text of ['안녕', 'Hello 안녕 ABC', '€ → ★ 漢字', '、。「」', '😀 ok']) {
  for (const size of [9, 16, 36]) record({ families: ['Twin Lisu'], size, text });
}
record({ families: ['Twin Lisu', 'Twin Hebrew'], size: 16, text: 'Hello 안녕 שלום' });
// Control and format characters, line breaks.
for (const text of ['a\nb', 'a\nbb\nc', 'a\tb', 'a\u200bb', 'a\u00a0b', 'a\r\nb', 'e\u0301']) record({ families: ['Twin Lisu'], size: 16, text });
// Fractional sizes and letter spacing.
for (const size of [12.5, 23.4571, 0.5]) record({ families: ['Twin Lisu'], size, text: 'Hello World' });
for (const letterSpacing of [2, 0.5]) record({ families: ['Twin Lisu'], size: 16, text: 'Hello', letterSpacing });
// The provisioned Noto faces, when installed.
for (const entry of installedNoto) {
  const texts = ['Hello World', '안녕하세요 반갑습니다', 'Hello 안녕 ABC 123', '가격: 47,210원 (12.5%)', '、。「」・…', 'AVATAR To Ty', '€ → ★ ✓'];
  for (const size of [9, 13, 18, 36]) {
    for (const text of texts) {
      record({ families: [entry.alias], size, text, requires: entry.id });
      record({ families: [entry.alias], size, text, bold: true, requires: entry.id });
    }
  }
}

writeJson(join(stage, 'golden.json'), {
  engine: '@napi-rs/canvas 1.0.11',
  platform: process.platform,
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))])),
  noto: installedNoto,
  cases,
});
writeSetManifest(stage, {
  set: 'office-measure',
  recorder,
  command: `node ${recorder} --tree <dir with node_modules>`,
  identityTree: tree,
  extra: { provenance: recordingProvenance(recorder) },
});
commitStage(stage, finalDir);
console.log(`wrote ${join(finalDir, 'golden.json')} (${cases.length} cases, ${installedNoto.length} provisioned faces)`);
