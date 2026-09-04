// Rendered-page sampling for the aesthetic review: one metric object per page
// image (luminance, colorfulness, foreground occupancy, a 16×9 structure grid,
// ink contrast). No judgement lives here; design-aesthetics.mjs reads these.
import sharp from 'sharp';
import { clamp } from '../shared/values.mjs';

const SAMPLE_WIDTH = 160;
const SAMPLE_HEIGHT = 90;
export const STRUCTURE_COLUMNS = 16;
export const STRUCTURE_ROWS = 9;

export function rounded(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
}

function pageNumber(image, index) {
  if (Array.isArray(image?.pages) && image.pages.length === 1) return Number(image.pages[0]) || index + 1;
  return Number(image?.page) || index + 1;
}

export function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

export function deviation(values) {
  if (!values.length) return 0;
  const center = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - center) ** 2)));
}

// The most frequent color among the sampled pixels (quantized to 32 levels per
// channel), averaged over its members so the estimate is a real page color.
function dominantColor(pixels) {
  if (!pixels.length) return [255, 255, 255];
  const bins = new Map();
  for (const [red, green, blue] of pixels) {
    const key = `${red >> 3}:${green >> 3}:${blue >> 3}`;
    const bin = bins.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
    bin.count += 1;
    bin.red += red;
    bin.green += green;
    bin.blue += blue;
    bins.set(key, bin);
  }
  const top = [...bins.values()].sort((left, right) => right.count - left.count)[0];
  // No color owns half the border (a checkerboard, a full-bleed gradient): there
  // is no page background to speak of, and the mean is the honest estimate.
  if (top.count / pixels.length < 0.5) {
    return [mean(pixels.map((entry) => entry[0])), mean(pixels.map((entry) => entry[1])), mean(pixels.map((entry) => entry[2]))];
  }
  return [top.red / top.count, top.green / top.count, top.blue / top.count];
}

function quantile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
}

function normalizedEntropy(histogram) {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (!total) return 0;
  const raw = histogram.reduce((sum, count) => {
    if (!count) return sum;
    const probability = count / total;
    return sum - (probability * Math.log2(probability));
  }, 0);
  return raw / Math.log2(histogram.length);
}

function colorfulness(redValues, greenValues, blueValues) {
  const redGreen = redValues.map((red, index) => red - greenValues[index]);
  const yellowBlue = redValues.map((red, index) => ((red + greenValues[index]) / 2) - blueValues[index]);
  return Math.sqrt((deviation(redGreen) ** 2) + (deviation(yellowBlue) ** 2))
    + (0.3 * Math.sqrt((mean(redGreen) ** 2) + (mean(yellowBlue) ** 2)));
}

// Similarity of two pages' 16×9 occupancy grids (1 = identical structure).
export function structureSimilarity(left, right) {
  if (!left.length || left.length !== right.length) return 0;
  const distance = mean(left.map((value, index) => Math.abs(value - right[index])));
  return clamp(1 - distance);
}

function structureStats(structure) {
  if (!structure.length) return { spatialCoverage: 0, spatialBalance: 0, occupiedQuadrants: 0 };
  const active = structure.map((value) => value >= 0.08 ? 1 : 0);
  const spatialCoverage = mean(active);
  let total = 0;
  let weightedX = 0;
  let weightedY = 0;
  const quadrants = [0, 0, 0, 0];
  structure.forEach((value, index) => {
    const x = index % STRUCTURE_COLUMNS;
    const y = Math.floor(index / STRUCTURE_COLUMNS);
    total += value;
    weightedX += value * ((x + 0.5) / STRUCTURE_COLUMNS);
    weightedY += value * ((y + 0.5) / STRUCTURE_ROWS);
    quadrants[(y >= STRUCTURE_ROWS / 2 ? 2 : 0) + (x >= STRUCTURE_COLUMNS / 2 ? 1 : 0)] += value;
  });
  const centerX = total ? weightedX / total : 0.5;
  const centerY = total ? weightedY / total : 0.5;
  const spatialBalance = clamp(1 - ((Math.abs(centerX - 0.5) + Math.abs(centerY - 0.5)) * 1.25));
  const occupiedQuadrants = quadrants.filter((value) => value >= total * 0.08).length;
  return { spatialCoverage, spatialBalance, occupiedQuadrants };
}

function hueBin(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const range = maximum - minimum;
  if (!range) return 0;
  let hue;
  if (maximum === red) hue = ((green - blue) / range) % 6;
  else if (maximum === green) hue = ((blue - red) / range) + 2;
  else hue = ((red - green) / range) + 4;
  const degrees = (hue * 60 + 360) % 360;
  return Math.min(11, Math.floor(degrees / 30));
}

// Feature distance between two pages: what the rhythm review reads as change.
export function metricDistance(left, right) {
  return mean([
    Math.abs(left.backgroundLuminance - right.backgroundLuminance),
    Math.abs(left.colorfulnessScore - right.colorfulnessScore),
    Math.abs(left.entropy - right.entropy),
    Math.abs(left.edgeDensity - right.edgeDensity),
    Math.abs(left.foregroundCoverage - right.foregroundCoverage),
  ]);
}

const INK_WIDTH = 640;
const INK_HEIGHT = 360;
const INK_FOREGROUND = 28 / 255;

// Legibility of the marks themselves. The 160-sample grid blends type strokes
// into the background, so the strongest decile of foreground luminance deltas
// is read at a resolution where strokes survive.
async function measureInkContrast(image, backgroundLuminance) {
  const grey = await sharp(Buffer.from(image.data, 'base64'))
    .flatten({ background: '#ffffff' })
    .resize(INK_WIDTH, INK_HEIGHT, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
  const deltas = [];
  for (let index = 0; index < grey.length; index += 1) {
    const delta = Math.abs((grey[index] / 255) - backgroundLuminance);
    if (delta >= INK_FOREGROUND) deltas.push(delta);
  }
  deltas.sort((left, right) => left - right);
  return quantile(deltas, 0.9);
}

export async function renderedAestheticMetric(image, index) {
  if (!image?.data) return null;
  const decoded = await sharp(Buffer.from(image.data, 'base64'))
    .flatten({ background: '#ffffff' })
    .resize(SAMPLE_WIDTH, SAMPLE_HEIGHT, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = decoded.data;
  const channels = decoded.info.channels;
  const reds = [];
  const greens = [];
  const blues = [];
  const luminance = [];
  const histogram = Array.from({ length: 16 }, () => 0);
  const border = [];
  for (let y = 0; y < SAMPLE_HEIGHT; y += 1) {
    for (let x = 0; x < SAMPLE_WIDTH; x += 1) {
      const offset = ((y * SAMPLE_WIDTH) + x) * channels;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const light = ((0.2126 * red) + (0.7152 * green) + (0.0722 * blue)) / 255;
      reds.push(red);
      greens.push(green);
      blues.push(blue);
      luminance.push(light);
      histogram[Math.min(15, Math.floor(light * 16))] += 1;
      if (x < 3 || y < 3 || x >= SAMPLE_WIDTH - 3 || y >= SAMPLE_HEIGHT - 3) {
        border.push([red, green, blue]);
      }
    }
  }
  // The page background is the border's dominant color, not its mean: a page
  // field that reaches the edge (a plane on the right third, a picture band)
  // would otherwise blend into the estimate and read every mark as low
  // contrast against a color that exists nowhere on the page.
  const background = dominantColor(border);
  const backgroundLuminance = ((0.2126 * background[0]) + (0.7152 * background[1]) + (0.0722 * background[2])) / 255;
  const occupancy = Array.from({ length: STRUCTURE_COLUMNS * STRUCTURE_ROWS }, () => 0);
  const occupancySamples = Array.from({ length: occupancy.length }, () => 0);
  let foreground = 0;
  let foregroundLuminanceDelta = 0;
  const inkContrast = await measureInkContrast(image, backgroundLuminance);
  let colorfulForeground = 0;
  const hueHistogram = Array.from({ length: 12 }, () => 0);
  let edges = 0;
  let edgeSamples = 0;
  for (let y = 0; y < SAMPLE_HEIGHT; y += 1) {
    for (let x = 0; x < SAMPLE_WIDTH; x += 1) {
      const pixelIndex = (y * SAMPLE_WIDTH) + x;
      const red = reds[pixelIndex];
      const green = greens[pixelIndex];
      const blue = blues[pixelIndex];
      const distance = Math.max(
        Math.abs(red - background[0]),
        Math.abs(green - background[1]),
        Math.abs(blue - background[2]),
      );
      const occupied = distance >= 28 ? 1 : 0;
      foreground += occupied;
      if (occupied) foregroundLuminanceDelta += Math.abs(luminance[pixelIndex] - backgroundLuminance);
      if (occupied) {
        const channelMaximum = Math.max(red, green, blue);
        const channelMinimum = Math.min(red, green, blue);
        const saturation = channelMaximum ? (channelMaximum - channelMinimum) / channelMaximum : 0;
        if (saturation >= 0.22) {
          colorfulForeground += 1;
          hueHistogram[hueBin(red, green, blue)] += 1;
        }
      }
      const cellX = Math.min(STRUCTURE_COLUMNS - 1, Math.floor((x / SAMPLE_WIDTH) * STRUCTURE_COLUMNS));
      const cellY = Math.min(STRUCTURE_ROWS - 1, Math.floor((y / SAMPLE_HEIGHT) * STRUCTURE_ROWS));
      const cell = (cellY * STRUCTURE_COLUMNS) + cellX;
      occupancy[cell] += occupied;
      occupancySamples[cell] += 1;
      if (x > 0) {
        edges += Math.abs(luminance[pixelIndex] - luminance[pixelIndex - 1]) >= 0.12 ? 1 : 0;
        edgeSamples += 1;
      }
      if (y > 0) {
        edges += Math.abs(luminance[pixelIndex] - luminance[pixelIndex - SAMPLE_WIDTH]) >= 0.12 ? 1 : 0;
        edgeSamples += 1;
      }
    }
  }
  const sortedLuminance = [...luminance].sort((left, right) => left - right);
  const rawColorfulness = colorfulness(reds, greens, blues);
  const structure = occupancy.map((value, cell) => occupancySamples[cell] ? value / occupancySamples[cell] : 0);
  const spatial = structureStats(structure);
  const paletteThreshold = Math.max(3, colorfulForeground * 0.05);
  const paletteHueCount = hueHistogram.filter((count) => count >= paletteThreshold).length;
  const paletteDominance = colorfulForeground ? Math.max(...hueHistogram) / colorfulForeground : 0;
  return {
    page: pageNumber(image, index),
    width: Number(image.width) || decoded.info.width,
    height: Number(image.height) || decoded.info.height,
    backgroundLuminance: rounded(backgroundLuminance),
    luminanceMean: rounded(mean(luminance)),
    contrastSpan: rounded(quantile(sortedLuminance, 0.9) - quantile(sortedLuminance, 0.1)),
    foregroundContrast: rounded(foreground ? foregroundLuminanceDelta / foreground : 0),
    // The marks themselves: anti-aliased type and tinted fields pull the mean
    // toward the background, so legibility is read from the strongest decile.
    inkContrast: rounded(inkContrast),
    colorfulness: rounded(rawColorfulness, 2),
    colorfulnessScore: rounded(clamp(rawColorfulness / 45)),
    accentCoverage: rounded(foreground ? colorfulForeground / foreground : 0),
    paletteHueCount,
    paletteDominance: rounded(paletteDominance),
    entropy: rounded(normalizedEntropy(histogram)),
    edgeDensity: rounded(edgeSamples ? edges / edgeSamples : 0),
    foregroundCoverage: rounded(foreground / luminance.length),
    spatialCoverage: rounded(spatial.spatialCoverage),
    spatialBalance: rounded(spatial.spatialBalance),
    occupiedQuadrants: spatial.occupiedQuadrants,
    _structure: structure,
  };
}
