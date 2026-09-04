// Aesthetic review of rendered pages: page roles, per-role density targets,
// the issues the render can raise (contrast, density, rhythm, repetition) and
// the v2 score. Sampling lives in design-aesthetics-metrics.mjs.
import { clamp } from '../shared/values.mjs';
import {
  deviation,
  mean,
  metricDistance,
  renderedAestheticMetric,
  rounded,
  structureSimilarity,
} from './design-aesthetics-metrics.mjs';

function normalizedPageRole(page, pageCount, pageRoles = {}) {
  const explicit = pageRoles?.[page] || pageRoles?.[String(page)] || '';
  const value = typeof explicit === 'string'
    ? explicit
    : explicit?.visualType || explicit?.slideRole || explicit?.role || '';
  const normalized = String(value).trim().toLowerCase();
  // The deck role decides beats before the visual type does: a statement
  // slide carrying one metric is still a beat, not a scorecard.
  const slideRole = typeof explicit === 'string' ? '' : String(explicit?.slideRole || '').trim().toLowerCase();
  if (/cover|opening/.test(normalized) || page === 1) return 'opening';
  if (/closing|decision-close/.test(normalized) || page === pageCount) return 'closing';
  if (/section|statement/.test(slideRole) || /section|statement/.test(normalized)) return 'section';
  if (/diagram/.test(normalized)) return 'diagram';
  if (/picture|photo|image/.test(normalized)) return 'picture';
  if (/chart/.test(normalized)) return 'chart';
  if (/timeline|process|roadmap/.test(normalized)) return 'timeline';
  if (/allocation|comparison|matrix/.test(normalized)) return 'allocation';
  if (/scorecard|metric/.test(normalized)) return 'scorecard';
  return 'content';
}

const ROLE_TARGETS = Object.freeze({
  opening: Object.freeze({ foreground: [0.035, 0.24], spatial: [0.16, 0.5], quadrants: 2 }),
  closing: Object.freeze({ foreground: [0.03, 0.22], spatial: [0.16, 0.5], quadrants: 2 }),
  // Section and statement beats carry one thesis and air, like a cover.
  section: Object.freeze({ foreground: [0.03, 0.24], spatial: [0.16, 0.5], quadrants: 2 }),
  // A diagram's evidence is native shapes on tinted fields and hairlines; the
  // sampler reads a fraction of it as foreground, so the floor sits low.
  diagram: Object.freeze({ foreground: [0.015, 0.44], spatial: [0.08, 0.74], quadrants: 3 }),
  // A picture slide is mostly picture: the sampler reads the whole frame as
  // foreground, so the ceiling is open and the floor is the frame itself.
  picture: Object.freeze({ foreground: [0.12, 1], spatial: [0.3, 1], quadrants: 3 }),
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
  const accentRange = ['opening', 'closing', 'section'].includes(role) ? [0.12, 0.64] : [0.08, 0.52];
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
  // Balance and quadrant spread only mean something once the role's density
  // is met; an empty page is not "balanced", so both are weighted by density.
  const presence = Math.sqrt(clamp(densityFit));
  return {
    densityFit,
    score: clamp((densityFit * 0.45) + (presence * ((metric.spatialBalance * 0.35) + (quadrantFit * 0.2)))),
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
    // Beat pages (section/statement) are sparse on purpose; density gates
    // apply to inner pages that carry evidence.
    const role = normalizedPageRole(metric.page, measured.length, pageRoles);
    const beatPage = role === 'section';
    // A diagram role is granted from the saved shapes (they cover a quarter of
    // the canvas with the text registered to them), so the canvas is not empty
    // however little of its tinted fields and hairlines the sampler sees at the
    // document scale; its density still weighs on the composition score.
    const densityGated = !beatPage && role !== 'diagram';
    // The mean foreground delta drops when tinted fields (planes, lanes, cards)
    // make up most of the foreground; the marks are judged by the ink decile.
    if (
      metric.foregroundCoverage >= 0.008
      && metric.foregroundContrast < 0.15
      && (metric.inkContrast || 0) < 0.35
    ) {
      issues.push(aestheticIssue(
        'low_visual_contrast',
        `/${normalized === 'pptx' ? 'slide' : 'page'}[${metric.page}]`,
        `Rendered foreground contrast is ${metric.foregroundContrast.toFixed(2)}; foreground and background are too similar.`,
      ));
    }
    if (
      normalized === 'pptx'
      && densityGated
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
      && !beatPage
      && metric.page > 1
      && metric.page < measured.length
      && densityGated
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
    (Math.max(metric.contrastSpan, metric.foregroundContrast, metric.inkContrast || 0) - 0.1) / 0.65,
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
