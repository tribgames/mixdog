import { normalizeOfficeContentModel, summarizeOfficeContentModel } from './content-model.mjs';
import { resolveOfficeCompositionContext } from './composition-system.mjs';
import { resolveOfficeArtDirection } from './design-art-direction.mjs';
import { plainObject } from '../shared/values.mjs';
const PPTX_BACKGROUND_MODES = new Set(['sandwich', 'light', 'dark', 'custom']);

const PPTX_TEMPLATE_MODES = new Set(['prefer', 'strict', 'scratch']);
const PPTX_COMPOSITION_MODES = new Set(['model', 'legacy']);

function resolvePptxDeckPlan(input, tokens, artDirection) {
  const source = plainObject(input.deck) ? input.deck : {};
  const direction = artDirection?.applyTokens ? artDirection.selected?.deck || {} : {};
  const backgroundMode = PPTX_BACKGROUND_MODES.has(String(source.backgroundMode || '').toLowerCase())
    ? String(source.backgroundMode).toLowerCase()
    : PPTX_BACKGROUND_MODES.has(String(direction.backgroundMode || '').toLowerCase())
      ? String(direction.backgroundMode).toLowerCase()
      : 'sandwich';
  const defaults = backgroundMode === 'dark'
    ? { cover: 'inverse', content: 'inverse', section: 'inverse', closing: 'inverse' }
    : backgroundMode === 'light'
      ? { cover: 'canvas', content: 'canvas', section: 'canvas', closing: 'canvas' }
      : { cover: 'inverse', content: 'canvas', section: 'inverse', closing: 'inverse' };
  const requestedRoles = plainObject(source.roles) ? source.roles : {};
  const roles = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const requested = String(requestedRoles[key] || '').trim();
    return [key, Object.hasOwn(tokens.colors, requested) ? requested : fallback];
  }));
  const dominantColorRole = String(source.dominantColorRole || roles.content);
  const requestedTemplateMode = String(source.templateMode || '').trim().toLowerCase();
  const requestedCompositionMode = String(source.compositionMode || '').trim().toLowerCase();
  return {
    backgroundMode,
    dominantColorRole: Object.hasOwn(tokens.colors, dominantColorRole) ? dominantColorRole : roles.content,
    motif: String(source.motif || direction.motif || input.signature || ''),
    spacingScale: String(source.spacingScale || 'consistent'),
    imageTreatment: String(source.imageTreatment || direction.imageTreatment || 'contained-evidence'),
    layoutBias: strings(source.layoutBias).length ? strings(source.layoutBias) : strings(direction.layoutBias),
    grid: String(source.grid || direction.grid || 'twelve-column editorial grid'),
    shapeLanguage: String(source.shapeLanguage || direction.shapeLanguage || 'native evidence fields'),
    chartTreatment: String(source.chartTreatment || direction.chartTreatment || 'native annotated chart'),
    densityPattern: strings(source.densityPattern).length ? strings(source.densityPattern) : strings(direction.densityPattern),
    motifRules: strings(source.motifRules).length ? strings(source.motifRules) : strings(direction.motifRules),
    directionId: String(artDirection?.selected?.id || ''),
    directionCandidates: (artDirection?.candidates || []).map((candidate) => candidate.id),
    sectionSlides: slideNumbers(source.sectionSlides),
    roles,
    templateMode: PPTX_TEMPLATE_MODES.has(requestedTemplateMode) ? requestedTemplateMode : 'scratch',
    compositionMode: PPTX_COMPOSITION_MODES.has(requestedCompositionMode)
      ? requestedCompositionMode
      : 'model',
    enforce: source.enforce !== false,
    requireSlidePlan: source.requireSlidePlan !== false,
  };
}

const FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'tsv']);

const DESIGN_PACKS = Object.freeze({
  executive: Object.freeze({
    id: 'executive',
    label: 'Executive',
    bestFor: 'Decision briefs, operating reviews, dashboards, and leadership presentations.',
    tokens: Object.freeze({
      colors: Object.freeze({
        canvas: 'F8F9F6',
        ink: '17221C',
        muted: '66716B',
        accent: '1F7A55',
        accent2: 'D89224',
        surface: 'E8F1EC',
        surface2: 'DDE4DF',
        inverse: '132C24',
        onAccent: 'FFFFFF',
        onInverse: 'FFFFFF',
      }),
      typography: Object.freeze({
        display: 'Segoe UI',
        body: 'Segoe UI',
        data: 'Arial',
      }),
      spacing: Object.freeze({
        compact: 10,
        block: 22,
        section: 40,
        page: 52,
      }),
    }),
    formats: Object.freeze({
      pptx: Object.freeze({ title: 40, body: 17, caption: 11, canvasWidth: 960, canvasHeight: 540 }),
      docx: Object.freeze({ title: 30, heading1: 17, heading2: 13, body: 10.5, margin: 50.4 }),
      xlsx: Object.freeze({ title: 20, heading: 10, body: 9.5, tableStyle: 'TableStyleMedium4' }),
      pdf: Object.freeze({ title: 29, heading: 17, body: 10.5, margin: 50 }),
    }),
  }),
  editorial: Object.freeze({
    id: 'editorial',
    label: 'Editorial',
    bestFor: 'Reports, proposals, briefs, and narrative presentations.',
    tokens: Object.freeze({
      colors: Object.freeze({
        canvas: 'FFFFFF',
        ink: '171717',
        muted: '5F6368',
        accent: 'C43E2F',
        accent2: 'D89B2B',
        surface: 'F1F2F4',
        surface2: 'E7E9EC',
        inverse: '151515',
        onAccent: 'FFFFFF',
        onInverse: 'FFFFFF',
      }),
      typography: Object.freeze({
        display: 'Segoe UI',
        body: 'Segoe UI',
        data: 'Segoe UI',
      }),
      spacing: Object.freeze({
        compact: 12,
        block: 24,
        section: 42,
        page: 54,
      }),
    }),
    formats: Object.freeze({
      pptx: Object.freeze({ title: 40, body: 18, caption: 12, canvasWidth: 960, canvasHeight: 540 }),
      docx: Object.freeze({ title: 28, heading1: 18, heading2: 14, body: 10.5, margin: 64.8 }),
      xlsx: Object.freeze({ title: 18, heading: 11, body: 10, tableStyle: 'TableStyleMedium2' }),
      pdf: Object.freeze({ title: 28, heading: 18, body: 10.5, margin: 54 }),
    }),
  }),
  technical: Object.freeze({
    id: 'technical',
    label: 'Technical',
    bestFor: 'Product, engineering, architecture, and operational material.',
    tokens: Object.freeze({
      colors: Object.freeze({
        canvas: 'F7FAFC',
        ink: '102A43',
        muted: '627D98',
        accent: '008C8C',
        accent2: 'E0A526',
        surface: 'E8F1F5',
        surface2: 'D9E7EC',
        inverse: '0B1F33',
        onAccent: 'FFFFFF',
        onInverse: 'F7FAFC',
      }),
      typography: Object.freeze({
        display: 'Segoe UI',
        body: 'Segoe UI',
        data: 'Cascadia Mono',
      }),
      spacing: Object.freeze({
        compact: 10,
        block: 22,
        section: 38,
        page: 50,
      }),
    }),
    formats: Object.freeze({
      pptx: Object.freeze({ title: 38, body: 17, caption: 12, canvasWidth: 960, canvasHeight: 540 }),
      docx: Object.freeze({ title: 26, heading1: 17, heading2: 13, body: 10.5, margin: 61.2 }),
      xlsx: Object.freeze({ title: 18, heading: 11, body: 10, tableStyle: 'TableStyleMedium4' }),
      pdf: Object.freeze({ title: 27, heading: 17, body: 10.5, margin: 52 }),
    }),
  }),
  data: Object.freeze({
    id: 'data',
    label: 'Data',
    bestFor: 'Financial models, analytical reports, dashboards, and KPI reviews.',
    tokens: Object.freeze({
      colors: Object.freeze({
        canvas: 'FFFFFF',
        ink: '1F2933',
        muted: '66788A',
        accent: '287A4B',
        accent2: 'D97706',
        surface: 'EDF5F0',
        surface2: 'E3EAF0',
        inverse: '183028',
        onAccent: 'FFFFFF',
        onInverse: 'FFFFFF',
      }),
      typography: Object.freeze({
        display: 'Segoe UI',
        body: 'Segoe UI',
        data: 'Segoe UI',
      }),
      spacing: Object.freeze({
        compact: 9,
        block: 20,
        section: 36,
        page: 48,
      }),
    }),
    formats: Object.freeze({
      pptx: Object.freeze({ title: 38, body: 17, caption: 12, canvasWidth: 960, canvasHeight: 540 }),
      docx: Object.freeze({ title: 26, heading1: 17, heading2: 13, body: 10, margin: 57.6 }),
      xlsx: Object.freeze({ title: 18, heading: 11, body: 10, tableStyle: 'TableStyleMedium4' }),
      pdf: Object.freeze({ title: 27, heading: 17, body: 10, margin: 50 }),
    }),
  }),
});


const DEFAULT_PROFILE = Object.freeze({
  docx: 'executive',
  xlsx: 'executive',
  pptx: 'executive',
  pdf: 'executive',
  csv: 'data',
  tsv: 'data',
});


function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}


export function merge(base, override) {
  if (!plainObject(override)) return clone(base);
  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = plainObject(value) && plainObject(result[key])
      ? merge(result[key], value)
      : clone(value);
  }
  return result;
}


export function hex(value, fallback) {
  const normalized = String(value || '').replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(normalized) ? normalized : fallback;
}


export function strings(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '')).filter(Boolean);
  if (value == null || value === '') return [];
  return [String(value)];
}


export function slideNumbers(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0))]
    .sort((left, right) => left - right);
}


export function compactDesign(design) {
  return {
    profile: design.profile,
    label: design.label,
    intent: design.intent,
    audience: design.audience,
    tone: design.tone,
    density: design.density,
    purpose: design.purpose,
    expressionMode: design.expressionMode,
    signature: design.signature,
    source: design.source,
    artDirection: design.artDirection,
    creative: design.creative,
    library: design.library,
    tokens: design.tokens,
    format: design.format,
    deck: design.deck,
    content: summarizeOfficeContentModel(design.content),
    slidePlans: design.slidePlans,
    review: design.review,
  };
}


function compactLibrary(library) {
  if (!plainObject(library)) {
    return {
      source: 'mixdog-starter',
      pack: null,
      template: null,
      pinned: false,
      warning: '',
    };
  }
  return {
    source: String(library.source || 'mixdog-starter'),
    pack: library.pack ? {
      id: String(library.pack.id || ''),
      version: String(library.pack.version || ''),
      keyId: String(library.pack.keyId || ''),
    } : null,
    template: library.template ? {
      id: String(library.template.id || ''),
      version: String(library.template.version || ''),
      source: String(library.template.source || ''),
      ...(library.coverage ? { coverage: clone(library.coverage) } : {}),
    } : null,
    templateIndexRevision: String(library.templateIndexRevision || ''),
    recentCompositionCount: Array.isArray(library.recentCompositions) ? library.recentCompositions.length : 0,
    pinned: library.pinned === true,
    warning: String(library.warning || ''),
  };
}


function resolvedDesignPacks(library) {
  const remote = plainObject(library?.pack?.profiles) ? library.pack.profiles : {};
  const output = { ...DESIGN_PACKS };
  for (const [id, profile] of Object.entries(remote)) {
    const parentId = String(profile?.extends || (DESIGN_PACKS[id] ? id : 'editorial')).toLowerCase();
    const parent = DESIGN_PACKS[parentId] || DESIGN_PACKS.editorial;
    output[id] = merge({
      ...parent,
      id,
      label: profile?.label || id,
    }, profile);
  }
  return output;
}


export function officeDesignCatalog(format = '', { library = null } = {}) {
  const normalized = String(format || '').toLowerCase();
  if (normalized && !FORMATS.has(normalized)) throw new Error(`Unsupported Office design format: ${format}`);
  return Object.values(resolvedDesignPacks(library)).map((pack) => ({
    id: pack.id,
    label: pack.label,
    bestFor: pack.bestFor,
    formats: Object.keys(pack.formats),
    ...(normalized && pack.formats[normalized] ? { defaults: clone(pack.formats[normalized]) } : {}),
  }));
}


export function resolveOfficeDesign(format, request = {}, { library = null } = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  if (!FORMATS.has(normalizedFormat)) throw new Error(`Unsupported Office design format: ${format}`);
  const input = typeof request === 'string'
    ? { profile: request }
    : plainObject(request)
      ? request
      : {};
  const packs = resolvedDesignPacks(library);
  const libraryDefault = library?.pack?.defaultProfiles?.[normalizedFormat];
  const profile = String(input.profile || libraryDefault || DEFAULT_PROFILE[normalizedFormat] || 'editorial').toLowerCase();
  const pack = packs[profile];
  if (!pack) {
    throw new Error(`Unknown Office design profile "${profile}". Use one of: ${Object.keys(packs).join(', ')}`);
  }
  const composition = resolveOfficeCompositionContext(normalizedFormat, input, {
    recentCompositions: library?.recentCompositions,
  });
  const artDirection = resolveOfficeArtDirection(normalizedFormat, input, {
    profile,
    purpose: composition.purpose,
    expressionMode: composition.expressionMode,
  });
  const directionTokens = artDirection.applyTokens ? {
    colors: artDirection.selected.palette,
    typography: artDirection.selected.typography,
  } : {};
  const palette = plainObject(input.palette) ? input.palette : {};
  const typography = plainObject(input.typography) ? input.typography : {};
  const tokens = merge(merge(pack.tokens, directionTokens), {
    colors: Object.fromEntries(Object.entries(palette).map(([key, value]) => [
      key,
      hex(value, pack.tokens.colors[key] || pack.tokens.colors.ink),
    ])),
    typography,
  });
  const deck = normalizedFormat === 'pptx' ? resolvePptxDeckPlan(input, tokens, artDirection) : null;
  return {
    profile,
    label: pack.label,
    bestFor: pack.bestFor,
    intent: String(input.intent || ''),
    audience: String(input.audience || ''),
    tone: String(input.tone || ''),
    density: ['light', 'balanced', 'dense'].includes(String(input.density || '').toLowerCase())
      ? String(input.density).toLowerCase()
      : 'balanced',
    purpose: composition.purpose,
    expressionMode: composition.expressionMode,
    recentCompositions: composition.recentCompositions,
    signature: String(input.signature || ''),
    source: String(input.source || library?.source || 'mixdog-starter'),
    artDirection,
    creative: plainObject(input.creative) ? clone(input.creative) : null,
    content: normalizeOfficeContentModel(input.content),
    library: compactLibrary(library),
    layouts: Array.isArray(library?.layouts) ? clone(library.layouts) : [],
    tokens,
    format: clone(pack.formats[normalizedFormat] || {}),
    ...(deck ? { deck } : {}),
    ...(normalizedFormat === 'pptx' ? {
      slidePlans: Array.isArray(input.slidePlans) ? clone(input.slidePlans) : [],
    } : {}),
    compositions: Array.isArray(input.compositions) ? clone(input.compositions) : [],
    review: {
      required: normalizedFormat === 'pptx'
        ? true
        : input.review !== false && normalizedFormat !== 'csv' && normalizedFormat !== 'tsv',
      allowTextOnly: input.allowTextOnly === true,
      allowRepetition: input.allowRepetition === true,
      allowDecorativeLines: input.allowDecorativeLines === true,
      allowSyntheticVisuals: input.allowSyntheticVisuals === true,
      allowFlatRhythm: input.allowFlatRhythm === true,
      frontier: input.frontier !== false && Boolean(input.content || input.creative),
    },
  };
}


export function metricDisplayValue(metric) {
  const value = metric?.display ?? metric?.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
  const format = String(metric?.numberFormat || '');
  const decimals = Math.max(0, (format.match(/0\.(0+)/)?.[1] || '').length);
  if (format.includes('%')) return `${(value * 100).toFixed(decimals)}%`;
  if (!format || format === 'General') return String(value);
  return new Intl.NumberFormat('en-US', {
    useGrouping: format.includes(','),
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}


export function provenanceText(source) {
  if (!source) return '';
  if (typeof source === 'string') return source.trim();
  if (!plainObject(source)) return '';
  const document = String(source.document || source.label || '').trim();
  const target = String(source.target || '').trim();
  if (!document) return '';
  return target ? `${document}#${target}` : document;
}
