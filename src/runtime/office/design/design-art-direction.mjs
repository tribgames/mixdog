import { createHash } from 'node:crypto';
import { hslToHex, normalizePaletteTokens } from './design-discipline.mjs';
import { plainObject } from '../shared/values.mjs';

const DIRECTION_BLUEPRINTS = Object.freeze([
  Object.freeze({
    id: 'evidence-grid',
    label: 'Evidence Grid',
    purposes: ['monitor', 'inspect', 'compare', 'decide'],
    modes: ['conservative', 'strong-fit'],
    hueOffset: 0,
    motif: 'measured evidence windows',
    backgroundMode: 'light',
    imageTreatment: 'contained-evidence',
    layoutBias: ['evidence', 'data', 'comparison', 'process'],
    grid: 'twelve-column analytical grid with one dominant evidence field',
    shapeLanguage: 'square evidence fields, quiet dividers, numeric anchors',
    chartTreatment: 'native chart with direct labels and a decision commentary rail',
    densityPattern: ['light opening', 'dense proof', 'balanced choice', 'light close'],
    motifRules: ['repeat measured windows', 'use one dominant number per proof beat', 'avoid equal card grids'],
    typography: Object.freeze({
      display: 'Calibri',
      body: 'Calibri',
      data: 'Arial',
    }),
    style: Object.freeze({
      id: 'swiss-grid',
      motif: 'grid-marks',
      corners: 'sharp',
      boundaries: 'rules-and-planes',
      elevation: 'flat',
      composition: 'one oversized geometric plane zoning the page; content flush to one axis; hero numeral at architectural scale',
      pageRhythm: ['anchor', 'dense', 'dense', 'breathing', 'anchor'],
    }),
  }),
  Object.freeze({
    id: 'editorial-contrast',
    label: 'Editorial Contrast',
    purposes: ['decide', 'explain', 'compare'],
    modes: ['strong-fit', 'divergent'],
    hueOffset: 22,
    motif: 'editorial crops and decisive whitespace',
    backgroundMode: 'sandwich',
    imageTreatment: 'editorial-crop',
    layoutBias: ['editorial', 'typography', 'evidence', 'decision'],
    grid: 'asymmetric editorial grid with controlled crops and wide outer margins',
    shapeLanguage: 'hairline fields, serif display contrast, offset captions',
    chartTreatment: 'chart as editorial evidence with annotation blocks and selective labels',
    densityPattern: ['quiet opening', 'alternating proof density', 'decisive close'],
    motifRules: ['repeat editorial crops', 'pair serif thesis with sans evidence', 'preserve asymmetry'],
    typography: Object.freeze({
      display: 'Cambria',
      body: 'Calibri',
      data: 'Arial',
    }),
    style: Object.freeze({
      id: 'editorial',
      motif: 'oversized-numeral',
      corners: 'minimal',
      boundaries: 'hairlines-and-columns',
      elevation: 'flat',
      composition: 'oversized numeral anchoring the page; asymmetric column split; a figure crossing a column edge; kicker → headline → standfirst hierarchy',
      pageRhythm: ['anchor', 'dense', 'breathing', 'dense', 'anchor'],
    }),
  }),
  Object.freeze({
    id: 'immersive-signal',
    label: 'Immersive Signal',
    purposes: ['explain', 'decide', 'monitor'],
    modes: ['divergent'],
    hueOffset: -18,
    motif: 'immersive fields with one sharp signal',
    backgroundMode: 'dark',
    imageTreatment: 'full-bleed-focus',
    layoutBias: ['minimal', 'rhythm', 'split', 'data'],
    grid: 'cinematic split field with one oversized signal and compressed support',
    shapeLanguage: 'deep fields, oversized type, sharp signal chips',
    chartTreatment: 'minimal native chart with luminous signal series and direct callouts',
    densityPattern: ['immersive opening', 'high-contrast proof', 'compressed decision close'],
    motifRules: ['one sharp signal per slide', 'alternate immersive and analytical fields', 'never decorate without evidence'],
    typography: Object.freeze({
      display: 'Arial',
      body: 'Calibri',
      data: 'Courier New',
    }),
    style: Object.freeze({
      id: 'dark-tech',
      motif: 'halo-field',
      corners: 'slight',
      boundaries: 'glow-and-layering',
      elevation: 'glow',
      composition: 'concentric halo staging one central metric; oversized type floating on dark negative space; monospace labels with wide tracking',
      pageRhythm: ['anchor', 'dense', 'breathing', 'dense', 'anchor'],
    }),
  }),
]);

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function stableHue(value) {
  return Number.parseInt(hash(value).slice(0, 6), 16) % 360;
}

// One hue family drives the whole palette as a lightness ladder: near-white
// canvas, tinted dark field, low-saturation text, and a single saturated
// accent with one secondary. Steps sit 6-12% apart so they read as distinct
// without jumping. The result is then contrast-repaired like any palette.
function directionPalette(hue, blueprint) {
  const primary = hue + blueprint.hueOffset;
  const immersive = blueprint.id === 'immersive-signal';
  const secondary = immersive ? primary + 155 : primary + 38;
  return normalizePaletteTokens({
    canvas: hslToHex(primary, 14, 97),
    ink: hslToHex(primary, 22, 14),
    muted: hslToHex(primary, 16, 40),
    accent: hslToHex(primary, immersive ? 74 : 62, immersive ? 46 : 40),
    accent2: hslToHex(secondary, 64, 46),
    surface: hslToHex(primary, 20, 92),
    surface2: hslToHex(primary, 18, 85),
    inverse: hslToHex(primary, immersive ? 30 : 26, immersive ? 11 : 14),
    onAccent: 'FFFFFF',
    onInverse: hslToHex(primary, 12, 96),
  }).colors;
}

function subjectSeed(input, profile) {
  const artDirection = plainObject(input.artDirection) ? input.artDirection : {};
  const content = plainObject(input.content) ? input.content : {};
  return [
    artDirection.seed,
    input.signature,
    input.intent,
    content.objective,
    content.decision,
    content.packageId,
    input.audience,
    input.tone,
  ].map((entry) => String(entry || '').trim()).filter(Boolean).join('|') || String(profile || '');
}

function subjectDomain(input) {
  const content = plainObject(input.content) ? input.content : {};
  const value = [
    input.intent,
    input.signature,
    input.audience,
    input.tone,
    content.objective,
    content.decision,
    ...(Array.isArray(content.claims) ? content.claims.map((entry) => entry?.text) : []),
  ].map((entry) => String(entry || '')).join(' ');
  if (/(revenue|profit|investment|finance|growth|margin|매출|이익|투자|성장|재무)/i.test(value)) {
    return { id: 'financial-decision', hue: 158 };
  }
  if (/(health|patient|clinical|care|병원|환자|의료|건강)/i.test(value)) {
    return { id: 'healthcare', hue: 174 };
  }
  if (/(climate|energy|sustain|carbon|환경|에너지|탄소|기후)/i.test(value)) {
    return { id: 'climate', hue: 112 };
  }
  if (/(product|software|platform|developer|ai|tech|제품|소프트웨어|플랫폼|개발|기술)/i.test(value)) {
    return { id: 'technology', hue: 214 };
  }
  return { id: 'subject-seeded', hue: null };
}

function subjectLabel(input) {
  const content = plainObject(input.content) ? input.content : {};
  return String(
    input.signature
      || input.intent
      || content.decision
      || content.objective
      || '',
  ).trim().replace(/\s+/g, ' ').slice(0, 72);
}

function requestedDirection(input) {
  if (typeof input.artDirection === 'string') return { id: input.artDirection };
  return plainObject(input.artDirection) ? input.artDirection : {};
}

function directionScore(blueprint, {
  purpose,
  expressionMode,
  tone,
  requestedId,
  seed,
}) {
  let score = 0;
  if (blueprint.purposes.includes(purpose)) score += 20;
  if (blueprint.modes.includes(expressionMode)) score += 6;
  if (expressionMode === 'divergent' && blueprint.id === 'immersive-signal') score += 10;
  if (expressionMode === 'conservative' && blueprint.id === 'evidence-grid') score += 8;
  if (/(bold|dramatic|launch|premium|강렬|대담|출시)/i.test(tone) && blueprint.id === 'immersive-signal') score += 12;
  if (/(editorial|narrative|story|보고서|서사)/i.test(tone) && blueprint.id === 'editorial-contrast') score += 12;
  if (requestedId && requestedId === blueprint.id) score += 1_000;
  score += (Number.parseInt(hash(`${seed}|${blueprint.id}`).slice(0, 4), 16) % 100) / 1_000;
  return score;
}

export function resolveOfficeArtDirection(format, input = {}, {
  profile = '',
  purpose = 'explain',
  expressionMode = 'strong-fit',
} = {}) {
  const request = plainObject(input) ? input : {};
  const requested = requestedDirection(request);
  const rawSubject = subjectLabel(request);
  const seed = subjectSeed(request, profile);
  const domain = subjectDomain(request);
  const baseHue = domain.hue ?? stableHue(seed);
  const candidates = DIRECTION_BLUEPRINTS.map((blueprint) => {
    const palette = directionPalette(baseHue, blueprint);
    return {
      id: blueprint.id,
      label: blueprint.label,
      rationale: `${blueprint.label} fits ${purpose} through ${blueprint.motif}.`,
      motif: rawSubject ? `${blueprint.motif} · ${rawSubject}` : blueprint.motif,
      palette,
      typography: { ...blueprint.typography },
      style: { ...blueprint.style, pageRhythm: [...blueprint.style.pageRhythm] },
      creativeSystem: {
        grid: blueprint.grid,
        shapeLanguage: blueprint.shapeLanguage,
        chartTreatment: blueprint.chartTreatment,
        densityPattern: [...blueprint.densityPattern],
        motifRules: [...blueprint.motifRules],
      },
      deck: {
        backgroundMode: blueprint.backgroundMode,
        motif: rawSubject ? `${blueprint.motif} · ${rawSubject}` : blueprint.motif,
        imageTreatment: blueprint.imageTreatment,
        layoutBias: [...blueprint.layoutBias],
        grid: blueprint.grid,
        shapeLanguage: blueprint.shapeLanguage,
        chartTreatment: blueprint.chartTreatment,
        densityPattern: [...blueprint.densityPattern],
        motifRules: [...blueprint.motifRules],
      },
      score: directionScore(blueprint, {
        purpose,
        expressionMode,
        tone: String(request.tone || ''),
        requestedId: String(requested.id || ''),
        seed,
      }),
    };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const selected = candidates[0];
  const hasSubject = Boolean(rawSubject || requested.seed || requested.id);
  const disabled = request.artDirection === false || requested.enabled === false;
  return {
    format: String(format || '').toLowerCase(),
    source: disabled ? 'disabled' : requested.id ? 'explicit' : hasSubject ? 'content-seeded' : 'profile-default',
    seedFingerprint: hash(seed).slice(0, 16),
    subjectDomain: domain.id,
    applyTokens: !disabled && hasSubject,
    selected: {
      ...selected,
      selectionReason: requested.id
        ? 'explicit direction'
        : `${purpose}/${expressionMode} fit`,
    },
    candidates,
  };
}
