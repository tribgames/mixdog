import sharp from 'sharp';

const SAMPLE_WIDTH = 160;
const SAMPLE_HEIGHT = 90;
const STRUCTURE_COLUMNS = 16;
const STRUCTURE_ROWS = 9;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function rounded(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
}

function pageNumber(image, index) {
  if (Array.isArray(image?.pages) && image.pages.length === 1) return Number(image.pages[0]) || index + 1;
  return Number(image?.page) || index + 1;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function deviation(values) {
  if (!values.length) return 0;
  const center = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - center) ** 2)));
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

function structureSimilarity(left, right) {
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

function normalizedPageRole(page, pageCount, pageRoles = {}) {
  const explicit = pageRoles?.[page] || pageRoles?.[String(page)] || '';
  const value = typeof explicit === 'string'
    ? explicit
    : explicit?.visualType || explicit?.slideRole || explicit?.role || '';
  const normalized = String(value).trim().toLowerCase();
  if (/cover|opening/.test(normalized) || page === 1) return 'opening';
  if (/closing|decision-close/.test(normalized) || page === pageCount) return 'closing';
  if (/chart/.test(normalized)) return 'chart';
  if (/timeline|process|roadmap/.test(normalized)) return 'timeline';
  if (/allocation|comparison|matrix/.test(normalized)) return 'allocation';
  if (/scorecard|metric/.test(normalized)) return 'scorecard';
  return 'content';
}

const ROLE_TARGETS = Object.freeze({
  opening: Object.freeze({ foreground: [0.035, 0.24], spatial: [0.16, 0.5], quadrants: 2 }),
  closing: Object.freeze({ foreground: [0.03, 0.22], spatial: [0.16, 0.5], quadrants: 2 }),
  chart: Object.freeze({ foreground: [0.1, 0.42], spatial: [0.42, 0.78], quadrants: 3 }),
  timeline: Object.freeze({ foreground: [0.08, 0.46], spatial: [0.38, 0.78], quadrants: 3 }),
  allocation: Object.freeze({ foreground: [0.07, 0.42], spatial: [0.34, 0.75], quadrants: 3 }),
  scorecard: Object.freeze({ foreground: [0.1, 0.48], spatial: [0.4, 0.78], quadrants: 3 }),
  content: Object.freeze({ foreground: [0.06, 0.44], spatial: [0.3, 0.74], quadrants: 3 }),
});

function rangeFit(value, [minimum, maximum]) {
  if (value >= minimum && value <= maximum) return 1;
  if (value < minimum) return clamp(value / Math.max(0.001, minimum));
  return clamp((1 - value) / Math.max(0.001, 1 - maximum));
}

function paletteDiscipline(metric, role) {
  const accentRange = ['opening', 'closing'].includes(role) ? [0.12, 0.64] : [0.08, 0.52];
  const hueScore = metric.paletteHueCount === 0
    ? 0.45
    : metric.paletteHueCount <= 3
      ? 1
      : clamp(1 - ((metric.paletteHueCount - 3) * 0.14));
  const dominantScore = metric.paletteHueCount === 0
    ? 0.45
    : rangeFit(metric.paletteDominance, [0.42, 0.94]);
  return clamp(
    (rangeFit(metric.accentCoverage, accentRange) * 0.4)
    + (hueScore * 0.35)
    + (dominantScore * 0.25),
  );
}

function roleAwareComposition(metric, role) {
  const target = ROLE_TARGETS[role] || ROLE_TARGETS.content;
  const densityFit = mean([
    rangeFit(metric.foregroundCoverage, target.foreground),
    rangeFit(metric.spatialCoverage, target.spatial),
  ]);
  const quadrantFit = clamp(metric.occupiedQuadrants / target.quadrants);
  return {
    densityFit,
    score: clamp((densityFit * 0.45) + (metric.spatialBalance * 0.35) + (quadrantFit * 0.2)),
  };
}

function metricDistance(left, right) {
  return mean([
    Math.abs(left.backgroundLuminance - right.backgroundLuminance),
    Math.abs(left.colorfulnessScore - right.colorfulnessScore),
    Math.abs(left.entropy - right.entropy),
    Math.abs(left.edgeDensity - right.edgeDensity),
    Math.abs(left.foregroundCoverage - right.foregroundCoverage),
  ]);
}

async function renderedAestheticMetric(image, index) {
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
  const background = [
    mean(border.map((entry) => entry[0])),
    mean(border.map((entry) => entry[1])),
    mean(border.map((entry) => entry[2])),
  ];
  const backgroundLuminance = ((0.2126 * background[0]) + (0.7152 * background[1]) + (0.0722 * background[2])) / 255;
  const occupancy = Array.from({ length: STRUCTURE_COLUMNS * STRUCTURE_ROWS }, () => 0);
  const occupancySamples = Array.from({ length: occupancy.length }, () => 0);
  let foreground = 0;
  let foregroundLuminanceDelta = 0;
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

function aestheticIssue(code, path, message) {
  return {
    severity: 'warning',
    code,
    path,
    message,
    source: 'aesthetic-review',
  };
}

function contentPages(pages) {
  return pages.length >= 3 ? pages.slice(1, -1) : pages.slice(1);
}

export async function reviewRenderedOfficeAesthetics(images = [], {
  format = '',
  pageRoles = {},
} = {}) {
  const normalized = String(format || '').toLowerCase();
  const measured = (await Promise.all((images || []).map(renderedAestheticMetric))).filter(Boolean);
  const issues = [];
  for (const metric of measured) {
    if (
      metric.foregroundCoverage >= 0.008
      && metric.foregroundContrast < 0.15
    ) {
      issues.push(aestheticIssue(
        'low_visual_contrast',
        `/${normalized === 'pptx' ? 'slide' : 'page'}[${metric.page}]`,
        `Rendered foreground contrast is ${metric.foregroundContrast.toFixed(2)}; foreground and background are too similar.`,
      ));
    }
    if (
      normalized === 'pptx'
      && metric.page > 1
      && metric.page < measured.length
      && metric.foregroundCoverage < 0.018
      && metric.entropy < 0.22
    ) {
      issues.push(aestheticIssue(
        'slide_visual_density_low',
        `/slide[${metric.page}]`,
        'The content slide has too little visual evidence or hierarchy for a presentation canvas.',
      ));
    }
    if (
      normalized === 'pptx'
      && metric.page > 1
      && metric.page < measured.length
      && metric.foregroundCoverage < 0.06
      && metric.spatialCoverage < 0.3
    ) {
      issues.push(aestheticIssue(
        'under_composed_slide',
        `/slide[${metric.page}]`,
        'The rendered content slide leaves too much of the canvas visually inactive for its evidence load.',
      ));
    }
    if (
      normalized === 'xlsx'
      && metric.foregroundCoverage > 0.62
      && metric.entropy > 0.45
      && metric.edgeDensity > 0.28
    ) {
      issues.push(aestheticIssue(
        'worksheet_visual_clutter',
        `/page[${metric.page}]`,
        'The worksheet render is visually saturated; separate the dashboard from supporting detail.',
      ));
    }
  }
  let rhythm = {
    pageCount: measured.length,
    featureSpread: 0,
    adjacentChange: 0,
    repeatedPairs: 0,
    maximumSimilarity: 0,
  };
  if (normalized === 'pptx') {
    const content = contentPages(measured);
    const featureSpread = mean([
      deviation(content.map((metric) => metric.backgroundLuminance)),
      deviation(content.map((metric) => metric.colorfulnessScore)),
      deviation(content.map((metric) => metric.entropy)),
      deviation(content.map((metric) => metric.edgeDensity)),
      deviation(content.map((metric) => metric.foregroundCoverage)),
    ]);
    const adjacentDistances = content.slice(1).map((metric, index) => metricDistance(content[index], metric));
    let repeatedPairs = 0;
    let maximumSimilarity = 0;
    for (let left = 0; left < content.length; left += 1) {
      for (let right = left + 1; right < content.length; right += 1) {
        const similarity = structureSimilarity(content[left]._structure, content[right]._structure);
        maximumSimilarity = Math.max(maximumSimilarity, similarity);
        if (similarity >= 0.985) repeatedPairs += 1;
      }
    }
    rhythm = {
      pageCount: measured.length,
      featureSpread: rounded(featureSpread),
      adjacentChange: rounded(mean(adjacentDistances)),
      repeatedPairs,
      maximumSimilarity: rounded(maximumSimilarity),
    };
    if (
      content.length >= 4
      && rhythm.featureSpread < 0.06
      && rhythm.adjacentChange < 0.065
      && rhythm.maximumSimilarity >= 0.9
    ) {
      issues.push(aestheticIssue(
        'flat_visual_rhythm',
        '/',
        'Rendered content slides keep nearly the same background, density, color, and complexity; introduce deliberate deck rhythm.',
      ));
    }
    if (
      content.length >= 4
      && repeatedPairs >= Math.max(2, Math.ceil(content.length / 2))
    ) {
      issues.push(aestheticIssue(
        'repeated_render_composition',
        '/',
        `${repeatedPairs} content-slide pairs share a near-identical rendered structure.`,
      ));
    }
  }
  const evaluated = measured.map((metric) => {
    const role = normalizedPageRole(metric.page, measured.length, pageRoles);
    const composition = roleAwareComposition(metric, role);
    return {
      ...metric,
      role,
      densityFit: rounded(composition.densityFit),
      paletteDiscipline: rounded(paletteDiscipline(metric, role)),
      compositionScore: rounded(composition.score),
    };
  });
  const pages = evaluated.map(({ _structure, ...metric }) => metric);
  const contrastScore = mean(pages.map((metric) => clamp(
    (Math.max(metric.contrastSpan, metric.foregroundContrast) - 0.1) / 0.65,
  )));
  const paletteScore = mean(pages.map((metric) => metric.paletteDiscipline));
  const compositionScore = mean(pages.map((metric) => metric.compositionScore));
  const rhythmScore = normalized === 'pptx'
    ? clamp(
      (rhythm.featureSpread * 3.5)
      + (rhythm.adjacentChange * 3)
      + ((1 - rhythm.maximumSimilarity) * 0.25),
    )
    : 1;
  const overallScore = (contrastScore * 0.32)
    + (paletteScore * 0.18)
    + (rhythmScore * 0.2)
    + (compositionScore * 0.3);
  if (normalized === 'pptx' && measured.length >= 5 && overallScore < 0.62) {
    issues.push(aestheticIssue(
      'frontier_aesthetic_score_low',
      '/',
      `Rendered aesthetics v2 score is ${overallScore.toFixed(2)}; frontier decks require at least 0.62.`,
    ));
  }
  return {
    ok: issues.length === 0,
    format: normalized,
    scoreVersion: 2,
    score: rounded(overallScore),
    confidence: rounded(clamp(measured.length / (normalized === 'pptx' ? 6 : 1))),
    dimensions: {
      contrast: rounded(contrastScore),
      palette: rounded(paletteScore),
      rhythm: rounded(rhythmScore),
      composition: rounded(compositionScore),
    },
    rhythm,
    pages,
    issues,
  };
}
