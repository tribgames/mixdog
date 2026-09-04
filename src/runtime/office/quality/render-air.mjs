import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderedPageImages } from './assurance-rendered.mjs';

// Air on the rendered page, read the way AeSlides reads whitespace: a local-variance map over a
// downsampled grayscale, thresholded, with the outer border dropped (peripheral margin is meant to be
// empty). A region with no local pixel variation is air whether the surface is paper, a dark field,
// or the flat sky inside a picture — which is exactly what the shape footprint cannot see.
// The downsample stands in for the smoothing pass: a texture finer than one cell averages out.
// Returns { air, balance } — air a share in [0, 1], balance the visual-weight read below — or null when
// the image cannot be read. Numbers, never a verdict.
export async function renderedAir(base64, { width = 320, window = 0.05, threshold = 0.05, border = 0.04 } = {}) {
  let loaded;
  try {
    loaded = await loadImage(Buffer.from(String(base64 || ''), 'base64'));
  } catch {
    return null;
  }
  if (!loaded?.width || !loaded?.height) return null;
  const w = Math.max(32, Math.round(width));
  const h = Math.max(18, Math.round((loaded.height / loaded.width) * w));
  const canvas = createCanvas(w, h);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, w, h);
  context.drawImage(loaded, 0, 0, w, h);
  const pixels = context.getImageData(0, 0, w, h).data;
  const gray = new Float64Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    gray[i] = (0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2]) / 255;
  }
  // Integral images of x and x² give the local mean and variance in constant time per cell.
  const stride = w + 1;
  const sum = new Float64Array(stride * (h + 1)), sq = new Float64Array(stride * (h + 1));
  for (let y = 1; y <= h; y += 1) {
    let row = 0, rowSq = 0;
    for (let x = 1; x <= w; x += 1) {
      const v = gray[(y - 1) * w + (x - 1)];
      row += v; rowSq += v * v;
      sum[y * stride + x] = sum[(y - 1) * stride + x] + row;
      sq[y * stride + x] = sq[(y - 1) * stride + x] + rowSq;
    }
  }
  const r = Math.max(1, Math.round(w * window));
  const variance = new Float64Array(w * h);
  let peak = 0;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s = sum[y1 * stride + x1] - sum[y0 * stride + x1] - sum[y1 * stride + x0] + sum[y0 * stride + x0];
      const s2 = sq[y1 * stride + x1] - sq[y0 * stride + x1] - sq[y1 * stride + x0] + sq[y0 * stride + x0];
      const v = Math.max(0, s2 / n - (s / n) ** 2);
      variance[y * w + x] = v;
      if (v > peak) peak = v;
    }
  }
  const bx = Math.round(w * border), by = Math.round(h * border);
  let cells = 0, air = 0;
  for (let y = by; y < h - by; y += 1) {
    for (let x = bx; x < w - bx; x += 1) {
      cells += 1;
      if (!peak || variance[y * w + x] / peak < threshold) air += 1;
    }
  }
  return {
    air: cells ? Number((air / cells).toFixed(2)) : null,
    balance: weightBalance(gray, sum, stride, w, h, r),
  };
}

// Visual-weight balance, as DeepSlides (arXiv 2605.26451 §C.2) defines it: a weight map mixing each
// pixel's deviation from the page's median tone with its local contrast; from it the weight center of
// mass (centered = 1 at dead center, 0 at a corner) and the left/right and top/bottom weight shares
// (1 = even, 0 = all on one side). A page whose title band is empty and whose content sits low reads
// as topBottom well under 1 — the number for "the top is empty". Numbers, never a verdict.
function weightBalance(gray, sum, stride, w, h, r, lambda = 0.5) {
  const sorted = Float64Array.from(gray).sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  let total = 0, sx = 0, sy = 0, left = 0, top = 0;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const local = (sum[y1 * stride + x1] - sum[y0 * stride + x1] - sum[y1 * stride + x0] + sum[y0 * stride + x0]) / n;
      const v = gray[y * w + x];
      const weight = (1 - lambda) * Math.abs(v - median) + lambda * Math.abs(v - local);
      total += weight; sx += weight * (x + 0.5); sy += weight * (y + 0.5);
      if (x + 0.5 < w / 2) left += weight;
      if (y + 0.5 < h / 2) top += weight;
    }
  }
  if (!total) return null;
  const cx = sx / total, cy = sy / total;
  const centered = 1 - Math.sqrt(((cx - w / 2) / (w / 2)) ** 2 + ((cy - h / 2) / (h / 2)) ** 2) / Math.SQRT2;
  const leftRight = 1 - Math.abs(2 * left - total) / total;
  const topBottom = 1 - Math.abs(2 * top - total) / total;
  const clamp = (v) => Number(Math.min(1, Math.max(0, v)).toFixed(2));
  return { centered: clamp(centered), leftRight: clamp(leftRight), topBottom: clamp(topBottom), score: clamp((centered + leftRight + topBottom) / 3) };
}

// Every rendered page of a deck (contact sheets unfolded to their pages) → Map page → { air, balance }.
export async function renderedAirByPage(images = []) {
  const byPage = new Map();
  for (const image of renderedPageImages(images)) {
    const pages = Array.isArray(image?.pages) ? image.pages : [image?.page];
    if (pages.length !== 1 || !image?.data) continue;
    const read = await renderedAir(image.data);
    if (read && typeof read.air === 'number') byPage.set(Number(pages[0]), read);
  }
  return byPage;
}