#!/usr/bin/env node
// What @napi-rs/canvas 1.0.11 (Skia) draws for the CanvasRenderingContext2D calls the Office code makes: a corpus of drawing
// scripts (a JSON list of canvas calls each) run on the product's canvas, every script recorded as the pixels it leaves
// (getImageData) and as the reads it makes. Rust `mixdog-raster` (tiny-skia) replays the same scripts and must leave the same
// image size exactly and pixels within the tolerance recorded with each case
// (crates/mixdog-raster/tests/twin_canvas.rs).
//
// A script is a list of operations:
//   ["set", name, value]                       a context property (a fill or stroke style may be { gradient: id } or { pattern: id })
//   ["call", name, ...args]                    a context method (an image argument is { image: id })
//   ["gradient", id, "linear"|"radial", [coordinates], [[offset, colour], ...]]
//   ["pattern", id, imageId, repetition]
//   ["putImageData", width, height, base64 of straight RGBA, dx, dy, dirtyX?, dirtyY?, dirtyWidth?, dirtyHeight?]
//   ["get", x, y, width, height]               a getImageData whose pixels are recorded
// The text scripts use three small OFL faces kept beside the office-measure recording (native/core/fixtures/office-measure/faces,
// registered under the names `Twin Lisu`) and, when they are installed, the provisioned Noto Sans and Noto Sans KR faces (each with
// the sha256 of the file the case was recorded from; the Korean script needs Noto Sans KR).
//
//   node benchmarks/rust-core/recorders/record-office-canvas.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/office-canvas/golden.json (and MANIFEST.json).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const recorder = 'benchmarks/rust-core/recorders/record-office-canvas.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-canvas');
const stage = stageSet(finalDir, ['golden.json']);
const requireFromTree = createRequire(join(tree, 'package.json'));
const { createCanvas, loadImage, GlobalFonts, ImageData } = requireFromTree('@napi-rs/canvas');

const FACES = join(FIXTURES_ROOT, 'office-measure', 'faces');
const FIXTURE_FACES = {
  'Twin Lisu': [
    { file: 'NotoSansLisu-Regular.ttf', weight: 400 },
    { file: 'NotoSansLisu-Bold.ttf', weight: 700 },
  ],
};
for (const [alias, list] of Object.entries(FIXTURE_FACES)) {
  for (const { file } of list) GlobalFonts.registerFromPath(join(FACES, file), alias);
}
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
const installedNoto = [];
for (const entry of NOTO) {
  const path = [join(userFontDirectory(), entry.fileName), join(systemFontDirectory(), entry.fileName)].find((candidate) => existsSync(candidate));
  if (!path) continue;
  const bytes = readFileSync(path);
  GlobalFonts.registerFromPath(path, entry.alias);
  installedNoto.push({ ...entry, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}

const b64 = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');

// ---- the pictures the scripts draw ------------------------------------------------------------------------------------

function pictureCanvas(width, height, pixel) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
  }
  context.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.toBuffer('image/png');
}
const PICTURES = {
  tile: pictureCanvas(8, 8, (x, y) => [x * 32, y * 32, (x + y) % 2 ? 255 : 60, 255 - ((x * y * 4) % 100)]),
  photo: pictureCanvas(16, 12, (x, y) => [x * 16, y * 20, 128, 255]),
};
const images = {};
for (const [id, png] of Object.entries(PICTURES)) images[id] = await loadImage(png);

// ---- the scripts ------------------------------------------------------------------------------------------------------

const set = (name, value) => ['set', name, value];
const call = (name, ...args) => ['call', name, ...args];
const WHITE = [set('fillStyle', '#ffffff'), call('fillRect', 0, 0, 4096, 4096)];

// Tolerance classes: the largest difference of any channel (premultiplied) and the mean difference over the image.
const EXACT = { max: 0, mean: 0 };
const ROUNDING = { max: 2, mean: 0.3 };
const EDGES = { max: 3, mean: 0.5 };
const TEXT = { max: 255, mean: 4.0, ink: 0.06 };

const cases = [];
const addCase = (id, width, height, tolerance, ops, extra = {}) => cases.push({ id, width, height, tolerance, ...extra, ops });

addCase('rects', 48, 32, EXACT, [
  set('fillStyle', '#336699'), call('fillRect', 2, 2, 20, 12),
  set('fillStyle', 'rgb(200,30,60)'), call('fillRect', 10, 8, 20, 18),
  call('clearRect', 12, 10, 6, 6),
  set('fillStyle', 'rebeccapurple'), call('fillRect', 46, 30, -6, -6),
  set('fillStyle', '#00aa00'), call('fillRect', 0, 28, 8, 4),
  set('fillStyle', '#ffffff'), call('fillRect', 40, 0, 8, 8),
  set('fillStyle', '#000'), call('fillRect', 44, 2, 2, 2),
]);

const colours = [
  'aliceblue', 'tomato', 'lightgoldenrodyellow', '#abc', '#aabbccdd', '#12345678', 'rgb(10 20 30)', 'rgba(10,20,30,0.5)',
  'rgb(100%,50%,0%)', 'hsl(210,50%,40%)', 'hsla(300,100%,50%,0.4)', 'RGB(0, 128, 255)', 'transparent', 'darkslategray', 'hsl(0.25turn 80% 50%)', 'rgba(255,255,255,0.25)',
];
addCase('colours', 40, 20, ROUNDING, [
  ...WHITE,
  ...colours.flatMap((colour, i) => [set('fillStyle', colour), call('fillRect', (i % 8) * 5, Math.floor(i / 8) * 5, 5, 5)]),
]);

addCase('fill_rules', 80, 40, EDGES, [
  ...WHITE,
  set('fillStyle', '#cc0033'),
  call('beginPath'), call('moveTo', 20, 2), call('lineTo', 32, 38), call('lineTo', 2, 14), call('lineTo', 38, 14), call('lineTo', 8, 38), call('closePath'), call('fill', 'nonzero'),
  set('fillStyle', '#0033cc'),
  call('beginPath'), call('moveTo', 60, 2), call('lineTo', 72, 38), call('lineTo', 42, 14), call('lineTo', 78, 14), call('lineTo', 48, 38), call('closePath'), call('fill', 'evenodd'),
]);

const strokeOps = [...WHITE, set('strokeStyle', '#000000')];
for (const [i, width] of [1, 3, 6].entries()) {
  strokeOps.push(set('lineWidth', width), call('beginPath'), call('moveTo', 4, 6 + i * 8), call('lineTo', 40, 6 + i * 8), call('stroke'));
}
for (const [i, cap] of ['butt', 'round', 'square'].entries()) {
  strokeOps.push(set('lineWidth', 8), set('lineCap', cap), call('beginPath'), call('moveTo', 52, 8 + i * 14), call('lineTo', 84, 8 + i * 14), call('stroke'));
}
strokeOps.push(set('lineCap', 'butt'));
for (const [i, join] of ['miter', 'round', 'bevel'].entries()) {
  strokeOps.push(set('lineWidth', 5), set('lineJoin', join), call('beginPath'), call('moveTo', 4 + i * 30, 52), call('lineTo', 16 + i * 30, 34), call('lineTo', 28 + i * 30, 52), call('stroke'));
}
strokeOps.push(set('lineJoin', 'miter'), set('lineWidth', 4), set('miterLimit', 1), call('beginPath'), call('moveTo', 4, 60), call('lineTo', 12, 56), call('lineTo', 20, 60), call('stroke'));
strokeOps.push(set('miterLimit', 10), call('beginPath'), call('moveTo', 24, 60), call('lineTo', 32, 56), call('lineTo', 40, 60), call('stroke'));
strokeOps.push(set('lineWidth', 2), call('setLineDash', [4, 3]), call('beginPath'), call('moveTo', 48, 54), call('lineTo', 92, 54), call('stroke'));
strokeOps.push(set('lineDashOffset', 2), call('beginPath'), call('moveTo', 48, 58), call('lineTo', 92, 58), call('stroke'));
strokeOps.push(call('setLineDash', [5]), set('lineDashOffset', 0), call('beginPath'), call('moveTo', 48, 62), call('lineTo', 92, 62), call('stroke'));
strokeOps.push(call('setLineDash', []), set('lineWidth', 2), call('strokeRect', 44, 36, 14, 10));
addCase('strokes', 96, 64, EDGES, strokeOps);

addCase('curves', 96, 64, EDGES, [
  ...WHITE,
  set('strokeStyle', '#202020'), set('lineWidth', 2), set('fillStyle', '#e8a317'),
  call('beginPath'), call('moveTo', 4, 30), call('bezierCurveTo', 14, 2, 24, 58, 34, 30), call('stroke'),
  call('beginPath'), call('moveTo', 40, 30), call('quadraticCurveTo', 50, 2, 60, 30), call('stroke'),
  call('beginPath'), call('arc', 78, 16, 12, 0, Math.PI * 2), call('fill'), call('stroke'),
  call('beginPath'), call('arc', 20, 48, 10, 0.3, 4.2, true), call('stroke'),
  call('beginPath'), call('moveTo', 36, 40), call('arcTo', 56, 40, 56, 60, 8), call('lineTo', 56, 60), call('stroke'),
  call('beginPath'), call('ellipse', 74, 46, 14, 8, 0.5, 0, Math.PI * 2), call('fill'),
  call('beginPath'), call('roundRect', 4, 4, 28, 20, [6, 2, 6, 2]), call('stroke'),
  call('beginPath'), call('roundRect', 40, 44, 12, 16, 5), call('fill'),
]);

addCase('clips', 64, 48, EDGES, [
  ...WHITE,
  call('save'), call('beginPath'), call('rect', 4, 4, 40, 30), call('clip'),
  set('fillStyle', '#4477aa'), call('fillRect', 0, 0, 64, 48),
  call('beginPath'), call('arc', 40, 30, 16, 0, Math.PI * 2), call('clip'),
  set('fillStyle', '#cc6677'), call('fillRect', 0, 0, 64, 48),
  call('restore'),
  call('save'), call('beginPath'), call('rect', 0, 0, 64, 48), call('rect', 10, 10, 20, 20), call('clip', 'evenodd'),
  set('fillStyle', 'rgba(0,0,0,0.25)'), call('fillRect', 0, 36, 64, 12),
  call('restore'),
  set('fillStyle', '#000000'), call('fillRect', 50, 40, 6, 6),
]);

addCase('gradients', 96, 64, EDGES, [
  ['gradient', 'lin', 'linear', [4, 0, 44, 0], [[0, '#ff0000'], [0.5, '#00ff00'], [1, '#0000ff']]],
  set('fillStyle', { gradient: 'lin' }), call('fillRect', 4, 4, 40, 14),
  ['gradient', 'diag', 'linear', [4, 22, 44, 42], [[0.2, 'black'], [0.8, 'rgba(255,255,255,0.2)']]],
  set('fillStyle', { gradient: 'diag' }), call('fillRect', 4, 22, 40, 20),
  ['gradient', 'rad', 'radial', [70, 20, 0, 70, 20, 16], [[0, 'white'], [1, '#003366']]],
  set('fillStyle', { gradient: 'rad' }), call('fillRect', 48, 2, 44, 36),
  ['gradient', 'ring', 'radial', [24, 52, 4, 24, 52, 11], [[0, '#ffff00'], [1, '#aa0000']]],
  set('fillStyle', { gradient: 'ring' }), call('fillRect', 8, 42, 32, 22),
  ['gradient', 'edge', 'linear', [50, 0, 94, 0], [[0, '#222222'], [1, '#dddddd']]],
  set('strokeStyle', { gradient: 'edge' }), set('lineWidth', 8), call('beginPath'), call('moveTo', 52, 50), call('lineTo', 92, 50), call('stroke'),
  call('save'), call('scale', 0.5, 1),
  ['gradient', 'scaled', 'linear', [100, 0, 180, 0], [[0, '#00aaaa'], [1, '#aa00aa']]],
  set('fillStyle', { gradient: 'scaled' }), call('fillRect', 100, 56, 80, 6),
  call('restore'),
]);

addCase('images', 96, 64, EDGES, [
  ...WHITE,
  call('drawImage', { image: 'tile' }, 2, 2),
  call('drawImage', { image: 'tile' }, 14, 2, 24, 24),
  set('imageSmoothingEnabled', false), call('drawImage', { image: 'tile' }, 42, 2, 24, 24),
  set('imageSmoothingEnabled', true), set('imageSmoothingQuality', 'high'), call('drawImage', { image: 'tile' }, 70, 2, 24, 24),
  set('imageSmoothingQuality', 'low'),
  call('drawImage', { image: 'photo' }, 4, 2, 8, 6, 2, 30, 32, 24),
  call('drawImage', { image: 'photo' }, 40, 30, 8, 6),
  set('globalAlpha', 0.5), call('drawImage', { image: 'photo' }, 52, 30, 16, 12), set('globalAlpha', 1),
  call('drawImage', { image: 'tile' }, 90, 58, 16, 16),
  call('drawImage', { image: 'tile' }, -4, 56, 16, 16),
  ['pattern', 'repeat', 'tile', 'repeat'], set('fillStyle', { pattern: 'repeat' }), call('fillRect', 40, 40, 24, 14),
  ['pattern', 'none', 'tile', 'no-repeat'], set('fillStyle', { pattern: 'none' }), call('save'), call('translate', 70, 36), call('fillRect', 0, 0, 24, 14), call('restore'),
]);

const OPERATIONS = [
  'source-over', 'source-in', 'source-out', 'source-atop', 'destination-over', 'destination-in', 'destination-out', 'destination-atop', 'lighter', 'copy',
  'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue',
  'saturation', 'color', 'luminosity',
];
addCase('composites', 96, 80, EDGES, OPERATIONS.flatMap((operation, i) => {
  const x = (i % 6) * 16;
  const y = Math.floor(i / 6) * 16;
  return [
    call('save'), call('beginPath'), call('rect', x, y, 16, 16), call('clip'),
    set('globalCompositeOperation', 'source-over'), set('fillStyle', 'rgba(220,40,40,0.8)'), call('fillRect', x + 1, y + 1, 10, 10),
    set('globalCompositeOperation', operation), set('fillStyle', 'rgba(30,60,220,0.6)'), call('fillRect', x + 5, y + 5, 10, 10),
    call('restore'),
  ];
}));

addCase('transforms', 96, 64, EDGES, [
  ...WHITE,
  set('fillStyle', '#336699'),
  call('save'), call('translate', 10, 10), call('fillRect', 0, 0, 16, 10), call('restore'),
  call('save'), call('translate', 60, 20), call('rotate', 0.5), call('fillRect', -8, -5, 16, 10), call('restore'),
  call('save'), call('translate', 20, 40), call('scale', 2, 1.5), call('fillRect', 0, 0, 10, 8), set('strokeStyle', '#cc3300'), set('lineWidth', 2), call('strokeRect', 14, 2, 8, 6), call('restore'),
  call('save'), call('transform', 1, 0.3, -0.3, 1, 70, 40), call('fillRect', 0, 0, 12, 10), call('restore'),
  call('save'), call('setTransform', 2, 0, 0, 2, 0, 0), call('fillRect', 40, 2, 4, 4), call('resetTransform'), call('fillRect', 88, 56, 8, 8), call('restore'),
]);

const ramp = (width, height) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([(i * 37) % 256, (i * 91 + 20) % 256, (i * 13 + 200) % 256, (i * 53 + 7) % 256], i * 4);
  return b64(data);
};
addCase('image_data', 20, 10, { max: 1, mean: 0.1 }, [
  ['putImageData', 4, 2, ramp(4, 2), 2, 2],
  ['putImageData', 4, 2, ramp(4, 2), 10, 2, 1, 0, 2, 1],
  set('fillStyle', 'rgba(255,0,0,0.5)'), call('fillRect', 0, 6, 6, 4),
  ['get', 0, 0, 20, 10], ['get', -2, -2, 8, 6], ['get', 15, 5, 10, 10],
]);

const text = (font, size) => set('font', `${size}px "${font}"`);
addCase('text_latin', 200, 128, TEXT, [
  ...WHITE,
  set('fillStyle', '#000000'),
  text('Twin Lisu', 20), call('fillText', 'Hello, World 123', 4, 24),
  set('font', 'bold 28px "Twin Lisu"'), call('fillText', 'Bold Text', 4, 56),
  text('Twin Lisu', 16), set('textAlign', 'center'), call('fillText', 'centered', 100, 80), set('textAlign', 'right'), call('fillText', 'right', 196, 80), set('textAlign', 'left'),
  set('textBaseline', 'middle'), call('fillText', 'Mid', 4, 100), set('textBaseline', 'hanging'), call('fillText', 'Hang', 50, 100), set('textBaseline', 'ideographic'), call('fillText', 'Ideo', 100, 100),
  set('textBaseline', 'alphabetic'),
  set('strokeStyle', '#cc0000'), set('lineWidth', 1), text('Twin Lisu', 24), call('strokeText', 'Outline', 4, 124),
  text('Twin Lisu', 14), call('fillText', 'squeezed into a narrow width', 104, 122, 60),
  set('letterSpacing', 2), call('fillText', 'spaced', 110, 44), set('letterSpacing', 0),
  ['gradient', 'ink', 'linear', [130, 0, 196, 0], [[0, '#cc0000'], [1, '#0000cc']]], set('fillStyle', { gradient: 'ink' }), text('Twin Lisu', 22), call('fillText', 'Gradient', 120, 66),
]);

if (installedNoto.some((entry) => entry.id === 'noto-sans-kr')) {
  addCase('text_korean', 220, 100, TEXT, [
    ...WHITE,
    set('fillStyle', '#000000'),
    text('Twin Noto Sans KR', 16), call('fillText', '안녕하세요 반갑습니다', 4, 22),
    text('Twin Noto Sans KR', 13), call('fillText', 'Hello 안녕 ABC 123', 4, 46),
    set('font', 'bold 18px "Twin Noto Sans KR"'), call('fillText', '가격: 47,210원 (12.5%)', 4, 72),
    text('Twin Noto Sans', 14), call('fillText', 'Latin text in Noto Sans', 4, 94),
  ], { requires: ['noto-sans-kr', 'noto-sans-latin'].filter((id) => installedNoto.some((entry) => entry.id === id)) });
}

// ---- running them -----------------------------------------------------------------------------------------------------

function run(item) {
  const canvas = createCanvas(item.width, item.height);
  const context = canvas.getContext('2d');
  const gradients = {};
  const patterns = {};
  const resolve = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.gradient) return gradients[value.gradient];
      if (value.pattern) return patterns[value.pattern];
      if (value.image) return images[value.image];
    }
    return value;
  };
  const reads = [];
  for (const [op, ...args] of item.ops) {
    if (op === 'set') {
      const [name, value] = args;
      context[name] = name === 'letterSpacing' ? `${value}px` : resolve(value);
    } else if (op === 'call') {
      const [name, ...rest] = args;
      context[name](...rest.map(resolve));
    } else if (op === 'gradient') {
      const [id, kind, coordinates, stops] = args;
      const gradient = kind === 'linear' ? context.createLinearGradient(...coordinates) : context.createRadialGradient(...coordinates);
      for (const [offset, colour] of stops) gradient.addColorStop(offset, colour);
      gradients[id] = gradient;
    } else if (op === 'pattern') {
      const [id, imageId, repetition] = args;
      patterns[id] = context.createPattern(images[imageId], repetition);
    } else if (op === 'putImageData') {
      const [width, height, data, ...position] = args;
      context.putImageData(new ImageData(new Uint8ClampedArray(Buffer.from(data, 'base64')), width, height), ...position);
    } else if (op === 'get') {
      const [x, y, width, height] = args;
      reads.push({ x, y, width, height, rgba: b64(context.getImageData(x, y, width, height).data) });
    } else throw new Error(`unknown operation ${op}`);
  }
  return { rgba: b64(context.getImageData(0, 0, item.width, item.height).data), reads };
}

const recorded = cases.map((item) => ({ ...item, ...run(item) }));

writeJson(join(stage, 'golden.json'), {
  engine: '@napi-rs/canvas 1.0.11',
  platform: process.platform,
  note: 'rgba is the straight RGBA8 getImageData of the whole canvas; tolerance is the largest premultiplied channel difference, the mean over the image and (text) the relative difference of the summed ink',
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `office-measure/faces/${file}`, weight }))])),
  noto: installedNoto,
  images: Object.fromEntries(Object.entries(PICTURES).map(([id, png]) => [id, { png: png.toString('base64') }])),
  cases: recorded,
});
writeSetManifest(stage, {
  set: 'office-canvas',
  recorder,
  command: `node ${recorder} --tree <dir with node_modules>`,
  identityTree: tree,
  extra: { provenance: recordingProvenance(recorder) },
});
commitStage(stage, finalDir);
console.log(`wrote ${join(finalDir, 'golden.json')} (${recorded.length} cases)`);
