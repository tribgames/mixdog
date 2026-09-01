import { createHash } from 'node:crypto';

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
      display: 'Segoe UI',
      body: 'Segoe UI',
      data: 'Arial',
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
      body: 'Arial',
      data: 'Arial',
    }),
  }),
]);

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function stableHue(value) {
  return Number.parseInt(hash(value).slice(0, 6), 16) % 360;
}

function hslToHex(hue, saturation, lightness) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = clamp(saturation, 0, 100) / 100;
  const l = clamp(lightness, 0, 100) / 100;
  const chroma = (1 - Math.abs((2 * l) - 1)) * s;
  const segment = h / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] = segment < 1
    ? [chroma, secondary, 0]
    : segment < 2
      ? [secondary, chroma, 0]
      : segment < 3
        ? [0, chroma, secondary]
        : segment < 4
          ? [0, secondary, chroma]
          : segment < 5
            ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const offset = l - (chroma / 2);
  return [red, green, blue]
    .map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function directionPalette(hue, blueprint) {
  const primary = hue + blueprint.hueOffset;
  const secondary = blueprint.id === 'immersive-signal' ? primary + 155 : primary + 38;
  return {
    canvas: hslToHex(primary, 16, 97),
    ink: hslToHex(primary, 24, 13),
    muted: hslToHex(primary, 16, 41),
    accent: hslToHex(primary, blueprint.id === 'immersive-signal' ? 78 : 66, 42),
    accent2: hslToHex(secondary, 72, 48),
    surface: hslToHex(primary, 22, 92),
    surface2: hslToHex(primary, 18, 86),
    inverse: hslToHex(primary, 32, blueprint.id === 'immersive-signal' ? 9 : 13),
    onAccent: 'FFFFFF',
    onInverse: 'FFFFFF',
  };
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

export function officeArtDirectionCatalog() {
  return DIRECTION_BLUEPRINTS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    purposes: [...entry.purposes],
    backgroundMode: entry.backgroundMode,
    imageTreatment: entry.imageTreatment,
    layoutBias: [...entry.layoutBias],
    grid: entry.grid,
    shapeLanguage: entry.shapeLanguage,
    chartTreatment: entry.chartTreatment,
    densityPattern: [...entry.densityPattern],
    motifRules: [...entry.motifRules],
  }));
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
