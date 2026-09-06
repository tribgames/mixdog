// Stage a rendered deck for SlidesGen-Bench's aesthetics metrics (refs/slidesgen-bench/eval/aesthetics_metrics.py):
//   node scripts/office/aesthetics-probe.mjs <deck.pptx> <page-image-prefix> <out-dir>
// Copies <prefix>-page-N.png into <out-dir>/slide_images/slide_000N.png and writes the deck's own text-box geometry
// into <out-dir>/detection/slide_000N.json in the benchmark's layout-detection format ({ boxes: [{ label, coordinate }] }),
// so the figure-ground contrast (Usability) metric reads text regions from the file the way the benchmark reads its
// PaddleOCR output — the geometry comes from the saved deck, not from a detector. Then:
//   python eval/aesthetics_metrics.py <out-dir>/slide_images --compute-score --config eval/aesthetics_config.json --no-parallel -o <result.json>
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { snapshotPortableOoxml } from '../../src/runtime/office/portable/portable-snapshot.mjs';
import { measureTextBlock } from '../../src/runtime/office/portable/text-metrics.mjs';

// A detector's box hugs the glyphs; a kit box is often wider than its text (a kicker in a 6 in box, a source line,
// a hero label). Width is tightened to the measured text so the contrast reads the type, not the empty paper beside
// it; height is kept, since the snapshot does not say where in the box the text is anchored.
function tightWidth(shape) {
  if (shape.table) return shape.width;
  const size = Number(shape.font?.size) || 18;
  const measured = measureTextBlock([{ text: String(shape.text), fontName: shape.font?.name || 'Noto Sans KR', fontSize: size, bold: Boolean(shape.font?.bold) }], { width: shape.width });
  return Math.min(shape.width, Math.max(size, measured.width + 4));
}

const [deck, prefix, out] = process.argv.slice(2);
if (!deck || !prefix || !out) {
  console.error('usage: node scripts/office/aesthetics-probe.mjs <deck.pptx> <page-image-prefix> <out-dir>');
  process.exit(1);
}
const CANVAS = { width: 960, height: 540 };   // 13.33 × 7.5 in, in points — the snapshot's unit
const snapshot = await snapshotPortableOoxml(resolve(deck), 'pptx', {});
const slides = snapshot?.slides || snapshot?.document?.slides || [];
if (!slides.length) throw new Error(`no slides read from ${deck}`);
await mkdir(join(out, 'slide_images'), { recursive: true });
await mkdir(join(out, 'detection'), { recursive: true });
let total = 0;
for (const slide of slides) {
  const stem = `slide_${String(slide.index).padStart(4, '0')}`;
  const source = `${prefix}-page-${slide.index}.png`;
  const target = join(out, 'slide_images', `${stem}.png`);
  await copyFile(source, target);
  const { width, height } = await sharp(target).metadata();
  const sx = width / CANVAS.width, sy = height / CANVAS.height;
  // Text carriers only: text boxes and native tables. Charts draw their own labels; pictures and fields carry none.
  const boxes = (slide.shapes || [])
    .filter((shape) => String(shape.text || '').trim() && !shape.chart && [shape.left, shape.top, shape.width, shape.height].every(Number.isFinite))
    .map((shape) => ({
      label: 'text',
      score: 1,
      coordinate: [
        Math.max(0, Math.round(shape.left * sx)), Math.max(0, Math.round(shape.top * sy)),
        Math.min(width, Math.round((shape.left + tightWidth(shape)) * sx)), Math.min(height, Math.round((shape.top + shape.height) * sy)),
      ],
    }))
    .filter((box) => box.coordinate[2] - box.coordinate[0] > 2 && box.coordinate[3] - box.coordinate[1] > 2);
  await writeFile(join(out, 'detection', `${stem}.json`), JSON.stringify({ source: 'pptx-snapshot', image: `${stem}.png`, boxes }, null, 2));
  total += boxes.length;
  console.log(`${stem}: ${boxes.length} text regions (${width}×${height})`);
}
console.log(`${slides.length} pages staged under ${out} with ${total} text regions`);
