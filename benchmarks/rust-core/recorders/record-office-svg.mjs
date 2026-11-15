#!/usr/bin/env node
// What sharp 0.35.5 (libvips 8.18, librsvg 2.63) does with an SVG, for the three ways the Office code hands it one:
//   * pdf-draw.mjs: an SVG logo on a PDF page. metadata() at the default density gives the declared size, then the SVG is rasterised at
//     density round(72 * clamp(4000 / size, 1, 4)) (step `pdf`);
//   * pptx-html-build.mjs addSvg: density 72 * 2.5 and resize(round(w * 2.5), round(h * 2.5), { fit: 'fill' }) (step `fill`);
//   * the pptx kit (kit.md): png(svg) = sharp(svg).png() at the default density (step `raster`), for the icon set (ICON.svg over
//     pptx-icons.json, a raw path icon), the orb's radial gradients and the motifs (rings, rays, dots, arcs, waves); and `metadata`.
// Rust `mixdog-raster` (usvg and resvg, text through the mixdog-fonts registry) replays each step and must give exactly the recorded
// error sentence or the recorded size, and pixels within the tolerance recorded with the case
// (crates/mixdog-raster/tests/twin_svg.rs).
//
// The corpus covers the sizing rules (px, in, pt, cm, mm, pc, em, ex and % units, viewBox only, one side declared, nothing declared, odd
// fractions, zero and negative sizes, the pixel limit) at several densities. The pixels of the cases that have no text are compared; text is
// not recorded (sharp draws it with the system's fontconfig faces, which a recording cannot pin).
//
//   node benchmarks/rust-core/recorders/record-office-svg.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/office-svg/golden.json (and MANIFEST.json).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const recorder = 'benchmarks/rust-core/recorders/record-office-svg.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-svg');
const stage = stageSet(finalDir, ['golden.json']);
const sharp = createRequire(join(tree, 'package.json'))('sharp');
const { iconGlobal } = await importFrom(tree, 'src/runtime/office/authoring/pptx-icons.mjs');
const ICON = iconGlobal();

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const TIGHT = { max: 4, mean: 0.6 };
// Anti-aliased curves, strokes and gradients are cairo's coverage against tiny-skia's: edges differ by a few levels more.
const SMOOTH = { max: 16, mean: 0.6 };

// kit.md: pdf-draw.mjs constants.
const SVG_RASTER_SCALE = 4;
const SVG_RASTER_MAX_PX = 4000;

const blend = (a, b, t) => [0, 2, 4].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('').toUpperCase();

const orb = (px, lit, shade, glowAlpha) => {
  const stop = (offset, color, opacity = 1) => `<stop offset="${offset}" stop-color="#${color}"${opacity < 1 ? ` stop-opacity="${opacity}"` : ''}/>`;
  const r = (1.0 / 1.8 / 2) * 100;
  return `<svg ${NS} width="${px}" height="${px}" viewBox="0 0 100 100"><defs>`
    + `<radialGradient id="halo" cx="50%" cy="50%" r="50%">${stop(0, lit, glowAlpha)}${stop(0.4, lit, glowAlpha * 0.35)}${stop(1, lit, 0)}</radialGradient>`
    + `<radialGradient id="body" cx="35%" cy="30%" r="72%">${stop(0, lit)}${stop(0.35, blend(lit, shade, 0.35))}${stop(0.7, blend(lit, shade, 0.85))}${stop(1, shade)}</radialGradient>`
    + `</defs><circle cx="50" cy="50" r="50" fill="url(#halo)"/><circle cx="50" cy="50" r="${r.toFixed(3)}" fill="url(#body)"/></svg>`;
};

const motif = (kind, pw, ph, color = '2F6FED', alpha = 0.22, stroke = 3, count = 7) => {
  const sw = (kind === 'rays' || kind === 'dots' ? stroke * 1.6 : stroke) * 160 / 96;
  const paint = `stroke="#${color}" stroke-opacity="${alpha}" fill="none" stroke-width="${sw}"`;
  let body = '';
  if (kind === 'rings') for (let i = 1; i <= count; i += 1) body += `<circle cx="${pw / 2}" cy="${ph / 2}" r="${Math.min(pw, ph) / 2 * i / count - sw}" ${paint}/>`;
  else if (kind === 'rays') for (let i = 0; i <= count; i += 1) { const t = (i / count) * (pw + ph); body += `<line x1="${t}" y1="0" x2="${t - ph}" y2="${ph}" ${paint}/>`; }
  else if (kind === 'dots') { const step = Math.max(pw, ph) / (count * 2); for (let gy = step / 2; gy < ph; gy += step) for (let gx = step / 2; gx < pw; gx += step) body += `<circle cx="${gx}" cy="${gy}" r="${sw * 1.5}" fill="#${color}" fill-opacity="${alpha}"/>`; }
  else if (kind === 'arcs') for (let i = 1; i <= count; i += 1) { const r = Math.max(pw, ph) * i / count; body += `<path d="M ${pw} ${ph - r} A ${r} ${r} 0 0 0 ${pw - r} ${ph}" ${paint}/>`; }
  else for (let i = 0; i <= count; i += 1) { const yy = ph * i / count, a = ph / (count * 2); body += `<path d="M 0 ${yy} C ${pw / 4} ${yy - a}, ${pw * 3 / 4} ${yy + a}, ${pw} ${yy}" ${paint}/>`; }
  return `<svg ${NS} width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}">${body}</svg>`;
};

const rect = (attrs, inner = '<rect width="10" height="10" fill="#d33"/>') => `<svg ${NS} ${attrs}>${inner}</svg>`;
const DOT = '<circle cx="10" cy="5" r="4" fill="#d33"/><rect x="0" y="0" width="4" height="10" fill="#36c"/>';
const SOLID = '<rect width="100%" height="100%" fill="#2a7"/>';
const DENSITIES = [72, 100, 144, 180];
const raster = (density) => ({ op: 'raster', density });
const meta = (density) => ({ op: 'metadata', density });

const cases = [];
const add = (name, svg, steps, tolerance = TIGHT) => cases.push({ name, svg, steps, tolerance });

// Sizing rules, each at four densities (metadata and the raster).
const sized = (name, svg, tolerance = TIGHT) => add(name, svg, [meta(undefined), ...DENSITIES.flatMap((d) => [meta(d), raster(d)])], tolerance);
sized('size px', rect('width="10" height="20"', '<rect width="10" height="20" fill="#d33"/>'));
sized('size fractional px', rect('width="10.5" height="20.4"', '<rect width="5" height="5" fill="#d33"/>'));
sized('size inches', rect('width="1in" height="0.5in"', '<rect width="100%" height="100%" fill="#2a7"/>'));
sized('size points', rect('width="100pt" height="50pt"', '<rect width="100%" height="50%" fill="#36c"/>'));
sized('size cm mm', rect('width="3cm" height="2mm"', '<rect width="100%" height="100%" fill="#36c"/>'));
sized('size pica', rect('width="6pc" height="12pc"', '<rect width="100%" height="100%" fill="#2a7"/>'));
sized('size em ex', rect('width="2em" height="3ex"', '<rect width="100%" height="100%" fill="#d33"/>'));
sized('size px suffix', rect('width="10px" height="12px"', '<rect width="100%" height="100%" fill="#d33"/>'));
sized('size exponent', rect('width="1e1" height="2.5e1"', '<rect width="100%" height="100%" fill="#d33"/>'));
sized('viewBox only', rect('viewBox="0 0 24 24"', '<rect x="4" y="4" width="16" height="16" fill="#d33"/>'));
sized('viewBox only fractional', rect('viewBox="0 0 24.4 10.6"', '<rect x="1" y="1" width="20" height="8" fill="#d33"/>'));
sized('viewBox with offset', rect('viewBox="10 10 30 20"', '<rect x="12" y="12" width="20" height="10" fill="#36c"/>'));
sized('percent sizes with viewBox', rect('width="50%" height="50%" viewBox="0 0 40 30"', '<rect width="40" height="30" fill="#2a7"/>'));
sized('width only with viewBox', rect('width="40" viewBox="0 0 20 10"', '<rect width="20" height="10" fill="#36c"/><rect width="10" height="5" fill="#d33"/>'));
sized('height only with viewBox', rect('height="30" viewBox="0 0 20 10"', '<rect width="20" height="10" fill="#36c"/><rect width="10" height="5" fill="#d33"/>'));
sized('mixed unit and percent with viewBox', rect('width="1in" height="50%" viewBox="0 0 10 10"', '<rect width="10" height="10" fill="#2a7"/>'));
sized('zero viewBox with sizes', rect('viewBox="0 0 0 0" width="5" height="5"', '<rect width="5" height="5" fill="#d33"/>'));
sized('viewBox against another aspect', rect('width="20" height="10" viewBox="0 0 10 10"', '<rect width="10" height="10" fill="#d33"/>'));
sized('viewBox stretched', rect('width="20" height="10" viewBox="0 0 10 10" preserveAspectRatio="none"', '<rect width="10" height="10" fill="#d33"/>'));
sized('no xmlns', '<svg width="10" height="10"><rect width="10" height="10" fill="#d33"/></svg>');
sized('nothing declared', `<svg ${NS}><rect width="5" height="5" fill="#d33"/></svg>`);
sized('nothing declared offset', `<svg ${NS}><rect x="3" y="4" width="5" height="6" fill="#d33"/></svg>`);
sized('nothing declared stroke', `<svg ${NS}><rect x="3" y="4" width="5" height="6" fill="none" stroke="#000" stroke-width="2"/></svg>`, SMOOTH);
sized('width without height or viewBox', `<svg ${NS} width="40"><rect width="5" height="5" fill="#d33"/></svg>`);
sized('percent without viewBox', `<svg ${NS} width="50%" height="50%"><rect x="3" y="4" width="5" height="6" fill="#d33"/></svg>`);
sized('rounded size at half', rect('width="10.5" height="10"', '<rect width="10.5" height="10" fill="#000"/>'));
sized('rounded size shrinks', rect('width="10.4" height="10"', '<rect width="10.4" height="10" fill="#000"/>'));

// Errors.
add('zero width', rect('width="0" height="10"'), [meta(undefined), raster(undefined)]);
add('negative width', rect('width="-5" height="10"'), [meta(undefined), raster(144)]);
add('empty svg', `<svg ${NS}/>`, [meta(undefined), raster(undefined)]);
add('rounds to zero', rect('width="0.2" height="0.2"'), [meta(undefined), raster(undefined)]);
add('truncated markup', `<svg ${NS}><rect`, [meta(undefined), raster(undefined)]);
add('not an svg', 'hello', [meta(undefined), raster(undefined)]);
add('over the pixel limit', rect('width="30000" height="30000"'), [meta(undefined), raster(144)]);
add('size overflow', rect('width="1e10" height="10"'), [meta(undefined), raster(undefined)]);
add('density below range', rect('width="10" height="10"'), [raster(0.5)]);
add('density above range', rect('width="10" height="10"'), [raster(100001)]);

// Drawing: shapes, strokes, opacity, transforms, gradients, clips, use, embedded images, styles.
add('shapes', `<svg ${NS} width="40" height="30" viewBox="0 0 40 30"><rect width="40" height="30" fill="#fff"/>${DOT}<ellipse cx="30" cy="20" rx="7" ry="4" fill="#2a7"/><polygon points="2,28 12,16 18,28" fill="#fb0"/></svg>`, [raster(72), raster(144), raster(288)], SMOOTH);
add('opacity and strokes', `<svg ${NS} width="40" height="30"><rect x="2" y="2" width="36" height="26" rx="4" fill="#36c" fill-opacity="0.5" stroke="#d33" stroke-width="3" stroke-opacity="0.6"/><path d="M5 25 L20 5 L35 25" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`, [raster(72), raster(180)], SMOOTH);
add('transform and clip', `<svg ${NS} width="40" height="30"><defs><clipPath id="c"><rect x="5" y="5" width="20" height="15"/></clipPath></defs><g transform="rotate(15 20 15)" clip-path="url(#c)"><rect width="40" height="30" fill="#36c"/><circle cx="15" cy="12" r="9" fill="#fb0"/></g></svg>`, [raster(72), raster(144)], SMOOTH);
add('linear gradient', `<svg ${NS} width="60" height="20"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#36c"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#d33"/></linearGradient></defs><rect width="60" height="20" fill="url(#g)"/></svg>`, [raster(72), raster(144)], SMOOTH);
add('radial gradient', `<svg ${NS} width="40" height="40"><defs><radialGradient id="g" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#36c"/></radialGradient></defs><circle cx="20" cy="20" r="18" fill="url(#g)"/></svg>`, [raster(72), raster(144)], SMOOTH);
add('use and symbol', `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="20"><defs><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="#36c"/></symbol></defs><use xlink:href="#s" x="0" y="0" width="20" height="20"/><use xlink:href="#s" x="22" y="4" width="12" height="12"/></svg>`, [raster(72), raster(144)], SMOOTH);
add('style sheet', `<svg ${NS} width="30" height="20"><style>.a{fill:#d33}#b{fill:#36c}</style><rect class="a" width="15" height="20"/><rect id="b" x="15" width="15" height="20"/></svg>`, [raster(72), raster(180)]);
// A 4 x 4 picture drawn at its own size on whole pixels: no resampling in either renderer.
const PIXEL = (await sharp(Buffer.from(Array.from({ length: 4 * 4 * 4 }, (_, i) => (i * 37 + (i % 4 === 3 ? 100 : 0)) % 256)), { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer()).toString('base64');
add('embedded png', `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="12" height="12"><image x="4" y="4" width="4" height="4" xlink:href="data:image/png;base64,${PIXEL}"/></svg>`, [raster(72)], { max: 4, mean: 0.6 });

// The kit's own SVGs.
const iconCase = (name, options) => add(`icon ${name} ${JSON.stringify(options)}`, ICON.svg(name, options), [raster(72), raster(160), raster(288)], SMOOTH);
for (const name of ['check', 'arrow-right', 'circle', 'star', 'house', 'chart-bar', 'user', 'settings']) {
  if (ICON.names.includes(name)) iconCase(name, { color: '2F6FED', size: 64, strokeWidth: 2 });
}
iconCase(ICON.names[0], { color: '111111', size: 24, strokeWidth: 1.5 });
iconCase(ICON.names[ICON.names.length - 1], { color: 'D33333', size: 96, strokeWidth: 3 });
add('icon path', `<svg ${NS} width="48" height="48" viewBox="0 0 24 24"><path d="M12 2 L15 9 L22 9.5 L16.5 14 L18.5 21 L12 17 L5.5 21 L7.5 14 L2 9.5 L9 9 Z" fill="#2F6FED"/></svg>`, [raster(72), raster(160)], SMOOTH);
add('orb', orb(288, '2F6FED', '0B1B3A', 0.3), [raster(72), raster(160)], SMOOTH);
for (const kind of ['rings', 'rays', 'dots', 'arcs', 'waves']) add(`motif ${kind}`, motif(kind, 320, 180), [raster(72)], SMOOTH);

// addSvg of pptx-html-build.mjs: density 180, resize fill to round(w * 2.5) x round(h * 2.5) of the placed box.
const FILL_SVG = `<svg ${NS} width="40" height="24" viewBox="0 0 40 24"><rect width="40" height="24" fill="#fff"/>${DOT}<path d="M0 24 L40 0" stroke="#d33" stroke-width="1"/></svg>`;
add('fill to box', FILL_SVG, [{ op: 'fill', density: 180, width: 100, height: 60 }, { op: 'fill', density: 180, width: 25, height: 12 }, { op: 'fill', density: 180, width: 53, height: 26 }, { op: 'fill', density: 180, width: 101, height: 59 }, { op: 'fill', density: 72, width: 7, height: 3 }, { op: 'fill', density: 144, width: 90, height: 9 }], SMOOTH);
add('fill physical units', rect('width="1in" height="0.5in" viewBox="0 0 20 10"', '<rect width="20" height="10" fill="#fff"/><circle cx="10" cy="5" r="4" fill="#d33"/>'), [{ op: 'fill', density: 100, width: 50, height: 20 }, { op: 'fill', density: 180, width: 80, height: 41 }], SMOOTH);
add('fill one pixel', FILL_SVG, [{ op: 'fill', density: 180, width: 1, height: 1 }], SMOOTH);

// pdf-draw.mjs rasterizeSvg: metadata at the default density, then density round(72 * scale).
const LOGO = (w, h, extra = '') => `<svg ${NS} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="6" fill="#0B1B3A"/><circle cx="${h / 2}" cy="${h / 2}" r="${h / 3}" fill="#fff"/><path d="M${h} ${h * 0.7} L${w - 10} ${h * 0.3}" stroke="#2F6FED" stroke-width="4" stroke-linecap="round"/>${extra}</svg>`;
add('pdf logo small', LOGO(120, 40), [{ op: 'pdf' }], SMOOTH);
add('pdf logo medium', LOGO(300, 90), [{ op: 'pdf' }], SMOOTH);
add('pdf logo wide', LOGO(1500, 120), [{ op: 'pdf' }], SMOOTH);
add('pdf logo tall', LOGO(40, 1400), [{ op: 'pdf' }], SMOOTH);
add('pdf logo large', LOGO(2600, 100), [{ op: 'pdf' }], SMOOTH);
add('pdf logo inches', `<svg ${NS} width="2in" height="0.75in" viewBox="0 0 80 30"><rect width="80" height="30" fill="#2a7"/><circle cx="15" cy="15" r="9" fill="#fff"/></svg>`, [{ op: 'pdf' }], SMOOTH);
add('pdf viewBox only', `<svg ${NS} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#36c"/></svg>`, [{ op: 'pdf' }], SMOOTH);
add('pdf unreadable', 'hello', [{ op: 'pdf' }]);

const png = async (input, options, size) => {
  let image = sharp(Buffer.from(input), options);
  if (size) image = image.resize(size.width, size.height, { fit: 'fill' });
  return image.png().toBuffer({ resolveWithObject: true });
};
const record = async (svg, step) => {
  try {
    const options = step.density === undefined ? {} : { density: step.density };
    if (step.op === 'metadata') {
      const { width, height, density, channels, hasAlpha, format } = await sharp(Buffer.from(svg), options).metadata();
      return { ...step, width, height, density, channels, hasAlpha, format };
    }
    if (step.op === 'raster' || step.op === 'fill') {
      const { data, info } = await png(svg, options, step.op === 'fill' ? step : null);
      return { ...step, width: info.width, height: info.height, png: data.toString('base64') };
    }
    // pdf-draw.mjs rasterizeSvg, as written there.
    const natural = await sharp(Buffer.from(svg)).metadata();
    const width = Number(natural?.width) || 0;
    const height = Number(natural?.height) || 0;
    if (!width || !height) throw new Error('PDF needs the SVG to declare its size (width/height or viewBox)');
    const scale = Math.max(1, Math.min(SVG_RASTER_SCALE, SVG_RASTER_MAX_PX / width, SVG_RASTER_MAX_PX / height));
    const density = Math.round(72 * scale);
    const { data, info } = await png(svg, { density });
    return { ...step, width, height, usedDensity: density, rasterWidth: info.width, rasterHeight: info.height, png: data.toString('base64') };
  } catch (error) {
    return { ...step, error: String(error.message) };
  }
};

const recorded = [];
for (const item of cases) {
  const steps = [];
  for (const step of item.steps) steps.push(await record(item.svg, step));
  recorded.push({ name: item.name, svg: item.svg, tolerance: item.tolerance, steps });
}

writeJson(join(stage, 'golden.json'), {
  engine: `sharp ${sharp.versions.sharp} (libvips ${sharp.versions.vips}, librsvg ${sharp.versions.rsvg})`,
  platform: process.platform,
  note: 'steps: metadata (width, height, density), raster (sharp(svg, { density }).png()), fill (the same with resize(width, height, { fit: "fill" })) and pdf (pdf-draw.mjs rasterizeSvg); png is the PNG sharp wrote; tolerance is the largest and the mean absolute difference of the premultiplied channels',
  cases: recorded,
});
writeSetManifest(stage, {
  set: 'office-svg',
  recorder,
  command: `node ${recorder} --tree <dir with node_modules>`,
  identityTree: tree,
  extra: { provenance: recordingProvenance(recorder) },
});
commitStage(stage, finalDir);
console.log(`wrote ${join(finalDir, 'golden.json')} (${recorded.length} cases)`);
