import { reviewOfficeStructure } from './assurance.mjs';
import {
  bindOfficeContent,
  normalizeOfficeContentModel,
  summarizeOfficeContentModel,
} from './content-model.mjs';
import {
  planOfficeComposition,
  resolveOfficeCompositionContext,
  reviewOfficeCompositionSequence,
  summarizeOfficeCompositions,
} from './composition-system.mjs';

const FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'tsv']);
const PPTX_BACKGROUND_MODES = new Set(['sandwich', 'light', 'dark', 'custom']);
const PPTX_TEMPLATE_MODES = new Set(['prefer', 'strict', 'scratch']);
const PPTX_VISUAL_TYPES = new Set(['statement', 'typography', 'comparison', 'process', 'metrics', 'chart', 'table', 'image', 'diagram', 'matrix']);
const PPTX_FOCAL_REGIONS = new Set(['full', 'left', 'right', 'center', 'top', 'bottom']);
const PPTX_CRITIQUE_AXES = Object.freeze(['hierarchy', 'balance', 'legibility', 'cohesion', 'evidence']);

const DESIGN_PACKS = Object.freeze({
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
  docx: 'editorial',
  xlsx: 'data',
  pptx: 'editorial',
  pdf: 'editorial',
  csv: 'data',
  tsv: 'data',
});

const PPTX_COMPONENTS = Object.freeze([
  'cover',
  'statement',
  'content',
  'split',
  'comparison',
  'metrics',
  'process',
  'chart',
  'table',
  'closing',
]);

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function merge(base, override) {
  if (!plainObject(override)) return clone(base);
  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = plainObject(value) && plainObject(result[key])
      ? merge(result[key], value)
      : clone(value);
  }
  return result;
}

function hex(value, fallback) {
  const normalized = String(value || '').replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(normalized) ? normalized : fallback;
}

function strings(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '')).filter(Boolean);
  if (value == null || value === '') return [];
  return [String(value)];
}

function slideNumbers(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0))]
    .sort((left, right) => left - right);
}

function resolvePptxDeckPlan(input, tokens) {
  const source = plainObject(input.deck) ? input.deck : {};
  const backgroundMode = PPTX_BACKGROUND_MODES.has(String(source.backgroundMode || '').toLowerCase())
    ? String(source.backgroundMode).toLowerCase()
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
  return {
    backgroundMode,
    dominantColorRole: Object.hasOwn(tokens.colors, dominantColorRole) ? dominantColorRole : roles.content,
    motif: String(source.motif || input.signature || ''),
    spacingScale: String(source.spacingScale || 'consistent'),
    sectionSlides: slideNumbers(source.sectionSlides),
    roles,
    templateMode: PPTX_TEMPLATE_MODES.has(requestedTemplateMode) ? requestedTemplateMode : 'prefer',
    enforce: source.enforce !== false,
    requireSlidePlan: source.requireSlidePlan !== false,
  };
}

function pptxBackgroundSpec(operation, design, kind, slide) {
  const deck = design.deck;
  const slideRole = String(operation.slideRole || (
    kind === 'cover' || kind === 'closing'
      ? kind
      : deck.sectionSlides.includes(slide)
        ? 'section'
        : 'content'
  )).toLowerCase();
  const fallbackRole = deck.roles[slideRole] || deck.roles.content;
  const requestedRole = String(operation.backgroundRole || '').trim();
  if (requestedRole && !Object.hasOwn(design.tokens.colors, requestedRole)) {
    throw new Error(`Unknown PPTX background role "${requestedRole}"`);
  }
  const backgroundRole = requestedRole || fallbackRole;
  const fallbackColor = design.tokens.colors[backgroundRole] || design.tokens.colors.canvas;
  return {
    slideRole,
    backgroundRole,
    color: hex(operation.background, fallbackColor),
    custom: Boolean(operation.background),
  };
}

function pptxSlidePlan(operation, kind, slide) {
  const source = plainObject(operation.plan) ? operation.plan : {};
  const defaults = {
    cover: ['statement', 'left'],
    statement: ['statement', 'left'],
    content: ['diagram', 'right'],
    split: [operation.image || operation.imagePath ? 'image' : 'diagram', 'right'],
    comparison: ['comparison', 'full'],
    metrics: ['metrics', 'full'],
    process: ['process', 'full'],
    closing: ['statement', 'left'],
  };
  const [defaultVisualType, defaultFocalRegion] = defaults[kind] || defaults.content;
  const requestedVisualType = String(source.visualType || defaultVisualType).toLowerCase();
  const requestedFocalRegion = String(source.focalRegion || defaultFocalRegion).toLowerCase();
  const evidence = strings(source.evidence).length
    ? strings(source.evidence)
    : Array.isArray(operation.metrics)
      ? operation.metrics.map((entry) => String(entry?.value ?? entry?.label ?? '')).filter(Boolean)
      : Array.isArray(operation.steps)
        ? operation.steps.map((entry) => String(entry?.title ?? entry?.label ?? '')).filter(Boolean)
        : Array.isArray(operation.columns)
          ? operation.columns.map((entry) => String(entry?.title ?? '')).filter(Boolean)
          : strings(operation.visualText || operation.body || operation.bullets).slice(0, 3);
  return {
    slide,
    message: String(source.message || operation.title || ''),
    evidence,
    visualType: PPTX_VISUAL_TYPES.has(requestedVisualType) ? requestedVisualType : defaultVisualType,
    focalRegion: PPTX_FOCAL_REGIONS.has(requestedFocalRegion) ? requestedFocalRegion : defaultFocalRegion,
    readingOrder: strings(source.readingOrder).length
      ? strings(source.readingOrder)
      : ['message', 'visual', 'support'],
    hierarchy: strings(source.hierarchy).length
      ? strings(source.hierarchy)
      : ['message', 'visual', 'support'],
    source: plainObject(operation.plan) ? 'explicit' : 'inferred',
  };
}

function compactDesign(design) {
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
  const palette = plainObject(input.palette) ? input.palette : {};
  const typography = plainObject(input.typography) ? input.typography : {};
  const tokens = merge(pack.tokens, {
    colors: Object.fromEntries(Object.entries(palette).map(([key, value]) => [
      key,
      hex(value, pack.tokens.colors[key] || pack.tokens.colors.ink),
    ])),
    typography,
  });
  const composition = resolveOfficeCompositionContext(normalizedFormat, input, {
    recentCompositions: library?.recentCompositions,
  });
  const deck = normalizedFormat === 'pptx' ? resolvePptxDeckPlan(input, tokens) : null;
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
    },
  };
}

function pptxRequiredCapabilities(operation) {
  const output = [];
  if (operation.image || operation.imagePath) output.push('image');
  if (plainObject(operation.chart) || operation.chart === true) output.push('chart');
  if (plainObject(operation.table) || Array.isArray(operation.table)) output.push('table');
  return output;
}

function pptxOperationText(operation) {
  return [
    operation.title,
    operation.subtitle,
    operation.takeaway,
    operation.eyebrow,
    operation.visualText,
    operation.chart?.title,
    ...strings(operation.body),
    ...strings(operation.bullets),
    ...strings(operation.meta),
    ...(operation.metrics || []).flatMap((entry) => [entry?.value, entry?.label, entry?.detail]),
    ...(operation.columns || []).flatMap((entry) => [entry?.title, ...strings(entry?.items || entry?.body)]),
    ...(operation.steps || []).flatMap((entry) => [entry?.title || entry?.label, entry?.detail || entry?.body]),
  ].filter((entry) => entry !== undefined && entry !== null).map(String);
}

function pptxOperationDemand(operation, design) {
  const text = pptxOperationText(operation);
  const textChars = text.reduce((total, entry) => total + entry.length, 0);
  const explicitDensity = String(operation.density || '').toLowerCase();
  const density = ['light', 'balanced', 'dense'].includes(explicitDensity)
    ? explicitDensity
    : textChars > 340 ? 'dense' : textChars > 120 ? 'balanced' : design.density;
  return {
    density,
    textChars,
    textItems: text.filter((entry) => entry.trim()).length,
    metrics: Array.isArray(operation.metrics) ? operation.metrics.length : 0,
    columns: Array.isArray(operation.columns) ? operation.columns.length : 0,
    steps: Array.isArray(operation.steps) ? operation.steps.length : 0,
    capabilities: pptxRequiredCapabilities(operation),
  };
}

function layoutNumberedGroups(layout, prefix) {
  return new Set((layout.slots || []).flatMap((slot) => {
    const match = new RegExp(`^${prefix}-(?:value|label|detail|title|body)-(\\d+)$`).exec(String(slot.role || ''));
    return match ? [Number(match[1])] : [];
  })).size;
}

function densityDistance(left, right) {
  const order = ['light', 'balanced', 'dense'];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  return leftIndex >= 0 && rightIndex >= 0 ? Math.abs(leftIndex - rightIndex) : 1;
}

function pptxLayoutFit(layout, operation, design, usage) {
  const demand = pptxOperationDemand(operation, design);
  const slots = Array.isArray(layout.slots) ? layout.slots : [];
  const capacity = layout.capacity || {};
  const available = {
    metrics: Math.max(Number(capacity.metricGroups) || 0, layoutNumberedGroups(layout, 'metric')),
    columns: Math.max(Number(capacity.columnGroups) || 0, layoutNumberedGroups(layout, 'column')),
    steps: Math.max(Number(capacity.stepGroups) || 0, layoutNumberedGroups(layout, 'step')),
  };
  const missingGroups = Object.entries({
    metrics: Math.max(0, demand.metrics - available.metrics),
    columns: Math.max(0, demand.columns - available.columns),
    steps: Math.max(0, demand.steps - available.steps),
  }).filter(([, count]) => count > 0);
  const nativeSample = Boolean(layout.templatePath && Number(layout.sourceSlide) > 0);
  const densityPenalty = densityDistance(layout.density || design.density, demand.density);
  const textSlots = Math.max(Number(capacity.textSlots) || 0, slots.filter((slot) => slot.type === 'text').length);
  const textSlotShortfall = nativeSample ? Math.max(0, demand.textItems - textSlots) : 0;
  const plannedVariant = String(operation.__composition?.variant || '').toLowerCase();
  const purposeFit = !layout.purposes?.length || layout.purposes.includes(design.purpose);
  const expressionFit = !layout.expressionModes?.length || layout.expressionModes.includes(design.expressionMode);
  const score = (
    (layout.profile === design.profile ? 4 : 0)
    + (layout.density === demand.density ? 7 : 0)
    - densityPenalty * 2
    + (String(operation.variant || '').toLowerCase() && layout.variant === String(operation.variant).toLowerCase() ? 2 : 0)
    + (plannedVariant && layout.variant === plannedVariant ? 3 : 0)
    + (purposeFit ? 4 : -6)
    + (expressionFit ? 2 : -3)
    + demand.capabilities.filter((capability) => layout.capabilities?.includes(capability)).length * 4
    + Math.min(demand.metrics, available.metrics) * 3
    + Math.min(demand.columns, available.columns) * 3
    + Math.min(demand.steps, available.steps) * 3
    - missingGroups.reduce((total, [, count]) => total + count * 8, 0)
    - textSlotShortfall * 2
    + (Number(layout.priority) || 0)
    - ((usage.get(layout.id) || 0) * 5)
  );
  return {
    layout,
    score,
    demand,
    fit: {
      density: layout.density || '',
      available,
      missingGroups: Object.fromEntries(missingGroups),
      textSlots,
      textSlotShortfall,
      nativeSample,
      purpose: purposeFit,
      expressionMode: expressionFit,
    },
  };
}

function selectPptxLayout(operation, design, usage = new Map()) {
  const layouts = Array.isArray(design.layouts) ? design.layouts : [];
  const requestedId = String(operation.layoutId || '').toLowerCase();
  if (requestedId) {
    const selected = layouts.find((layout) => layout.id === requestedId);
    if (!selected) throw new Error(`Unknown Office semantic layout "${operation.layoutId}" for the pinned design library`);
    return pptxLayoutFit(selected, operation, design, usage);
  }
  const kind = String(operation.kind || 'content').toLowerCase();
  const variant = String(operation.variant || '').toLowerCase();
  const requiredCapabilities = pptxRequiredCapabilities(operation);
  const candidates = layouts.filter((layout) => (
    layout.format === 'pptx'
    && layout.kind === kind
    && (!layout.profile || layout.profile === design.profile)
    && (!variant || !layout.variant || layout.variant === variant)
    && requiredCapabilities.every((capability) => layout.capabilities?.includes(capability))
  ));
  const scored = candidates.map((layout) => pptxLayoutFit(layout, operation, design, usage));
  const viable = scored.filter((entry) => (
    !entry.fit.nativeSample || Object.keys(entry.fit.missingGroups).length === 0
  ));
  const ranked = design.deck?.templateMode === 'strict' ? viable : (viable.length ? viable : scored);
  ranked.sort((left, right) => right.score - left.score || left.layout.id.localeCompare(right.layout.id));
  return ranked[0] || null;
}

function templateSlotText(operation, role) {
  const metrics = Array.isArray(operation.metrics) ? operation.metrics : [];
  const columns = Array.isArray(operation.columns) ? operation.columns : [];
  const steps = Array.isArray(operation.steps) ? operation.steps : [];
  const indexed = (pattern, values) => {
    const match = pattern.exec(role);
    return match ? values[Number(match[2]) - 1]?.[match[1]] : undefined;
  };
  if (role === 'title') return operation.title;
  if (role === 'subtitle') return operation.subtitle;
  if (role === 'eyebrow') return operation.eyebrow;
  if (role === 'body') return strings(operation.body || operation.bullets).join('\r');
  if (role === 'visual-text') return operation.visualText;
  if (role === 'meta') return strings(operation.meta).join(' · ');
  let value = indexed(/^metric-(value|label|detail)-(\d+)$/, metrics);
  if (value != null) return value;
  value = indexed(/^column-(title|body)-(\d+)$/, columns.map((column) => ({
    title: column?.title,
    body: strings(column?.items || column?.body).join('\r'),
  })));
  if (value != null) return value;
  value = indexed(/^step-(title|detail)-(\d+)$/, steps.map((step) => ({
    title: step?.title || step?.label,
    detail: step?.detail || step?.body,
  })));
  if (value != null) return value;
  return undefined;
}

function expandTemplatePptxSlide(operation, layout, slide, backend = '') {
  if (
    operation.create === false
    || !layout?.templatePath
    || !Number.isInteger(Number(layout.sourceSlide))
    || Number(layout.sourceSlide) < 1
  ) return null;
  const output = [{
    op: 'import_slides',
    path: layout.templatePath,
    slides: [Number(layout.sourceSlide)],
    ...(slide > 1 ? { after: slide - 1 } : {}),
  }];
  if (operation.background) {
    output.push({
      op: 'set_slide_background',
      slide,
      color: String(operation.background),
    });
  }
  const imagePath = operation.image?.path || operation.imagePath;
  for (const slot of layout.slots || []) {
    if (slot.type === 'text') {
      const value = templateSlotText(operation, slot.role);
      output.push({
        op: 'set_text',
        slide,
        shape: Number(slot.shape),
        text: String(value ?? ''),
        ...(value == null || value === '' ? { allowNoChange: true } : {}),
      });
    } else if (slot.type === 'image' && imagePath) {
      output.push({
        op: 'replace_image',
        slide,
        shape: Number(slot.shape),
        path: imagePath,
      });
    } else if (slot.type === 'chart' && plainObject(operation.chart)) {
      if (backend === 'mixdog-ooxml') {
        throw new Error('compose_slide chart requires Microsoft PowerPoint; omit chart or create the deck with PowerPoint installed');
      }
      output.push({
        op: 'set_chart_data',
        slide,
        shape: Number(slot.shape),
        series: Array.isArray(operation.chart.series) ? operation.chart.series : [],
        ...(Array.isArray(operation.chart.categories) ? { categories: operation.chart.categories } : {}),
        ...(operation.chart.title ? { title: String(operation.chart.title) } : {}),
      });
    } else if (slot.type === 'table') {
      const values = Array.isArray(operation.table)
        ? operation.table
        : operation.table?.values;
      if (Array.isArray(values)) {
        output.push({
          op: 'set_table_data',
          slide,
          shape: Number(slot.shape),
          values,
        });
      }
    }
  }
  if (operation.notes) output.push({ op: 'set_notes', slide, text: String(operation.notes) });
  return output;
}

function coalesceCreatedPptxTemplateImports(operations) {
  const imports = operations.filter((operation) => operation.op === 'import_slides');
  if (imports.length < 2 || operations[0]?.op !== 'import_slides') return operations;
  const path = imports[0].path;
  if (!imports.every((operation, index) => (
    operation.path === path
    && Array.isArray(operation.slides)
    && operation.slides.length === 1
    && Number(operation.after || 0) === index
  ))) return operations;
  const first = {
    ...imports[0],
    slides: imports.map((operation) => Number(operation.slides[0])),
  };
  delete first.after;
  let emitted = false;
  return operations.flatMap((operation) => {
    if (operation.op !== 'import_slides') return [operation];
    if (emitted) return [];
    emitted = true;
    return [first];
  });
}

function pptText(slide, text, properties = {}, paragraphs = null) {
  return {
    op: 'add_textbox',
    slide,
    text: String(text || ''),
    ...(paragraphs?.length ? { paragraphs } : {}),
    properties: {
      marginLeft: 0,
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      ...properties,
    },
  };
}

function pptShape(slide, shapeType, properties = {}, text = '') {
  return {
    op: 'add_shape',
    slide,
    shapeType,
    text,
    properties,
  };
}

function pptBodyParagraphs(body, design, { size, color } = {}) {
  return strings(body).map((text) => ({
    text,
    fontName: design.tokens.typography.body,
    fontSize: size || design.format.body,
    color: color || design.tokens.colors.ink,
    breakLine: true,
  }));
}

function pptBulletParagraphs(body, design, { size, color } = {}) {
  return strings(body).map((text) => ({
    text,
    bullet: true,
    fontName: design.tokens.typography.body,
    fontSize: size || design.format.body,
    color: color || design.tokens.colors.ink,
    breakLine: true,
  }));
}

function pptTitleSize(text, preferred = 34) {
  const length = [...String(text || '').trim()].reduce(
    (total, character) => total + (/[\u2E80-\u9FFF\uAC00-\uD7AF]/u.test(character) ? 1.7 : 1),
    0,
  );
  if (length > 64) return Math.min(preferred, 25);
  if (length > 48) return Math.min(preferred, 28);
  if (length > 34) return Math.min(preferred, 31);
  return preferred;
}

function metricDisplayValue(metric) {
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

function provenanceText(source) {
  if (!source) return '';
  if (typeof source === 'string') return source.trim();
  if (!plainObject(source)) return '';
  const document = String(source.document || source.label || '').trim();
  const target = String(source.target || '').trim();
  if (!document) return '';
  return target ? `${document}#${target}` : document;
}

function expandPptxSlide(operation, design, slide, backend = '') {
  const portable = backend === 'mixdog-ooxml';
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const kind = String(operation.kind || 'content').toLowerCase();
  const compositionVariant = String(operation.__composition?.variant || '').toLowerCase();
  if (!PPTX_COMPONENTS.includes(kind)) {
    throw new Error(`Unknown compose_slide kind "${kind}". Use one of: ${PPTX_COMPONENTS.join(', ')}`);
  }
  const output = [];
  if (operation.create !== false) {
    output.push({
      op: 'add_slide',
      ...(operation.index ? { index: Number(operation.index) } : {}),
      ...(operation.layout ? { layout: operation.layout } : {}),
    });
  }
  const backgroundSpec = pptxBackgroundSpec(operation, design, kind, slide);
  const background = backgroundSpec.color;
  output.push({ op: 'set_slide_background', slide, color: background });
  const inverseBackground = backgroundSpec.backgroundRole === 'inverse';
  const titleColor = inverseBackground ? colors.onInverse : colors.ink;
  const mutedColor = inverseBackground ? colors.surface2 : colors.muted;
  const title = String(operation.title || '');
  const subtitle = String(operation.takeaway || operation.subtitle || '');
  const eyebrow = String(operation.eyebrow || '');
  const contentTitleSize = pptTitleSize(title, Number(operation.titleSize) || 34);

  if (kind === 'cover') {
    const minimalFocus = compositionVariant === 'minimal-focus';
    if (eyebrow) output.push(pptText(slide, eyebrow.toUpperCase(), {
      left: 58, top: 58, width: 420, height: 24,
      fontName: type.body, fontSize: 12, bold: true, color: colors.accent,
    }));
    output.push(pptText(slide, title, {
      left: 58, top: minimalFocus ? 150 : 126, width: minimalFocus ? 842 : 720, height: 180,
      fontName: type.display, fontSize: pptTitleSize(title, Number(operation.titleSize) || (minimalFocus ? 48 : 44)), bold: true, color: colors.onInverse,
    }));
    if (subtitle) output.push(pptText(slide, subtitle, {
      left: 58, top: minimalFocus ? 350 : 326, width: minimalFocus ? 760 : 650, height: 72,
      fontName: type.body, fontSize: 18, color: mutedColor,
    }));
    const meta = strings(operation.meta);
    if (meta.length) output.push(pptText(slide, meta.join(' · '), {
      left: 58, top: 474, width: 720, height: 22,
      fontName: type.body, fontSize: 12, color: mutedColor,
    }));
  } else if (kind === 'statement') {
    if (eyebrow) output.push(pptText(slide, eyebrow.toUpperCase(), {
      left: 58, top: 52, width: 420, height: 22,
      fontName: type.body, fontSize: 12, bold: true, color: colors.accent,
    }));
    const metric = operation.metric || operation.metrics?.[0] || {};
    const showMetric = metric.value != null && compositionVariant !== 'typographic-statement';
    if (showMetric) {
      output.push(pptShape(slide, 'oval', {
        left: 714, top: 154, width: 164, height: 164,
        fillColor: colors.surface, lineColor: colors.surface,
      }));
      output.push(pptText(slide, metricDisplayValue(metric), {
        left: 674, top: 188, width: 244, height: 92,
        fontName: type.display, fontSize: 64, bold: true, color: colors.accent, alignment: 'center',
      }));
      if (metric.label) output.push(pptText(slide, String(metric.label), {
        left: 734, top: 286, width: 124, height: 24,
        fontName: type.body, fontSize: 12, bold: true, color: colors.muted, alignment: 'center',
      }));
    }
    output.push(pptText(slide, title, {
      left: 58, top: showMetric ? 144 : 132, width: showMetric ? 560 : 810, height: showMetric ? 150 : 188,
      fontName: type.display, fontSize: pptTitleSize(title, Number(operation.titleSize) || (showMetric ? 38 : 44)), bold: true, color: colors.ink,
    }));
    if (subtitle) output.push(pptText(slide, subtitle, {
      left: 58, top: 356, width: 650, height: 76,
      fontName: type.body, fontSize: 17, color: colors.muted,
    }));
  } else if (kind === 'metrics') {
    output.push(pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: contentTitleSize, bold: true, color: colors.ink,
    }));
    if (subtitle) output.push(pptText(slide, subtitle, {
      left: 58, top: 114, width: 760, height: 42,
      fontName: type.body, fontSize: 15, color: colors.muted,
    }));
    const metrics = Array.isArray(operation.metrics) ? operation.metrics.slice(0, 4) : [];
    if (compositionVariant === 'metric-band') {
      const metricWidth = 824 / Math.max(1, metrics.length);
      metrics.forEach((metric, index) => {
        const left = 58 + (metricWidth * index);
        output.push(pptText(slide, metricDisplayValue(metric), {
          left, top: 214, width: metricWidth - 18, height: 88,
          fontName: type.display, fontSize: metrics.length >= 4 ? 42 : 50, bold: true,
          color: index === 0 ? colors.accent : colors.ink,
        }));
        output.push(pptText(slide, String(metric.label || ''), {
          left, top: 316, width: metricWidth - 18, height: 34,
          fontName: type.body, fontSize: 13, bold: true, color: colors.muted,
        }));
        if (metric.detail) output.push(pptText(slide, String(metric.detail), {
          left, top: 360, width: metricWidth - 22, height: 54,
          fontName: type.body, fontSize: 12, color: colors.muted,
        }));
      });
    } else {
      metrics.forEach((metric, index) => {
        const primary = index === 0;
        const left = primary ? 58 : 520;
        const top = primary ? 208 : 192 + ((index - 1) * 118);
        output.push(pptText(slide, metricDisplayValue(metric), {
          left, top, width: primary ? 392 : 320, height: primary ? 96 : 62,
          fontName: type.display, fontSize: primary ? 58 : 40, bold: true,
          color: primary ? colors.accent : colors.ink,
        }));
        output.push(pptText(slide, String(metric.label || ''), {
          left, top: top + (primary ? 104 : 58), width: primary ? 360 : 320, height: 32,
          fontName: type.body, fontSize: 13, bold: true, color: colors.muted,
        }));
        if (metric.detail) output.push(pptText(slide, String(metric.detail), {
          left, top: top + (primary ? 148 : 86), width: primary ? 390 : 340, height: 38,
          fontName: type.body, fontSize: 12, color: colors.muted,
        }));
        if (!primary) output.push(pptShape(slide, 'oval', {
          left: 486, top: top + 16, width: 14, height: 14,
          fillColor: index === 1 ? colors.accent2 : colors.surface2,
          lineColor: index === 1 ? colors.accent2 : colors.surface2,
        }));
      });
    }
  } else if (kind === 'comparison') {
    output.push(pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: contentTitleSize, bold: true, color: colors.ink,
    }));
    const columns = Array.isArray(operation.columns) ? operation.columns.slice(0, 2) : [];
    const alignedEvidence = compositionVariant === 'aligned-evidence';
    const fills = alignedEvidence ? [colors.canvas, colors.canvas] : [colors.surface, colors.inverse];
    columns.forEach((column, index) => {
      const left = index === 0 ? 58 : 492;
      const fill = fills[index];
      const foreground = alignedEvidence ? colors.ink : index === 0 ? colors.ink : colors.onInverse;
      if (!alignedEvidence) {
        output.push(pptShape(slide, 'rectangle', {
          left, top: 142, width: 410, height: 328,
          fillColor: fill, lineColor: fill,
        }));
      }
      output.push(pptText(slide, String(column.title || ''), {
        left: left + 28, top: 174, width: 340, height: 48,
        fontName: type.display, fontSize: 24, bold: true, color: alignedEvidence ? colors.accent : foreground,
      }));
      const paragraphs = pptBulletParagraphs(column.items || column.body, design, {
        size: 15,
        color: alignedEvidence || index === 0 ? colors.muted : colors.surface2,
      });
      output.push(pptText(slide, '', {
        left: left + 28, top: 244, width: 340, height: 176,
      }, paragraphs));
    });
  } else if (kind === 'process') {
    output.push(pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: contentTitleSize, bold: true, color: colors.ink,
    }));
    const steps = Array.isArray(operation.steps) ? operation.steps.slice(0, 5) : [];
    const width = 820 / Math.max(1, steps.length);
    const staggered = compositionVariant === 'staggered-flow';
    steps.forEach((step, index) => {
      const left = 58 + (width * index);
      const top = staggered ? (index % 2 === 0 ? 160 : 236) : 172;
      output.push(pptShape(slide, 'oval', {
        left, top, width: 58, height: 58,
        fillColor: index === 0 ? colors.accent : colors.surface2,
        lineColor: index === 0 ? colors.accent : colors.surface2,
      }));
      output.push(pptText(slide, String(index + 1).padStart(2, '0'), {
        left, top: top + 15, width: 58, height: 30,
        fontName: type.data, fontSize: 22, bold: true,
        color: index === 0 ? colors.onAccent : colors.muted,
        alignment: 'center',
      }));
      output.push(pptText(slide, String(step.title || step.label || ''), {
        left: left - 24, top: top + 88, width: 106, height: 50,
        fontName: type.body, fontSize: 15, bold: true, color: colors.ink, alignment: 'center',
      }));
      if (step.detail || step.body) output.push(pptText(slide, String(step.detail || step.body), {
        left: Math.max(20, left - 40), top: top + 146, width: 150, height: 80,
        fontName: type.body, fontSize: 12, color: colors.muted, alignment: 'center',
      }));
      if (index < steps.length - 1) output.push(pptShape(slide, 'right_arrow', {
        left: left + width - 78, top: staggered ? 220 : 190, width: 52, height: 20,
        fillColor: colors.accent2, lineColor: colors.accent2,
      }));
    });
  } else if (kind === 'chart' || (kind === 'content' && plainObject(operation.chart))) {
    if (portable) {
      throw new Error('compose_slide chart requires Microsoft PowerPoint; use kind "metrics" or "table" for a portable deck');
    }
    output.push(pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: contentTitleSize, bold: true, color: colors.ink,
    }));
    if (subtitle) output.push(pptText(slide, subtitle, {
      left: 58, top: 116, width: 820, height: 40,
      fontName: type.body, fontSize: 14, color: colors.muted,
    }));
    const paragraphs = operation.bullets
      ? pptBulletParagraphs(operation.bullets, design, { size: 14 })
      : pptBodyParagraphs(operation.body, design, { size: 14 });
    const chartLed = compositionVariant === 'chart-led';
    if (paragraphs.length) output.push(pptText(slide, '', chartLed ? {
      left: 58, top: 440, width: 842, height: 54,
    } : {
      left: 58, top: 184, width: 274, height: 238,
    }, paragraphs));
    const chart = operation.chart || {};
    output.push({
      op: 'add_chart',
      slide,
      chartType: chart.type || chart.chartType || 'column',
      title: chart.title || '',
      categories: Array.isArray(chart.categories) ? chart.categories : [],
      series: Array.isArray(chart.series) ? chart.series.map((entry, index) => ({
        ...entry,
        color: entry?.color || (index === 0 ? colors.accent : index === 1 ? colors.accent2 : colors.muted),
      })) : [],
      left: chartLed || !paragraphs.length ? 58 : 360,
      top: 176,
      width: chartLed || !paragraphs.length ? 842 : 540,
      height: chartLed && paragraphs.length ? 244 : 286,
    });
  } else if (kind === 'table' || (kind === 'content' && (Array.isArray(operation.table) || plainObject(operation.table)))) {
    const tableCallout = compositionVariant === 'table-callout';
    output.push(pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: contentTitleSize, bold: true, color: colors.ink,
    }));
    if (subtitle) output.push(pptText(slide, subtitle, {
      left: 58, top: 116, width: 820, height: 40,
      fontName: type.body, fontSize: 14, color: colors.muted,
    }));
    const values = Array.isArray(operation.table) ? operation.table : operation.table?.values;
    const rowCount = Math.max(1, Array.isArray(values) ? values.length : 0);
    const bodyRowHeight = rowCount > 1
      ? Math.min(64, Math.max(40, (288 - 42) / (rowCount - 1)))
      : 0;
    const tableHeight = 42 + (bodyRowHeight * Math.max(0, rowCount - 1));
    output.push({
      op: 'add_table',
      slide,
      values: Array.isArray(values) ? values : [],
      left: tableCallout ? 116 : 58,
      top: tableCallout ? 184 : 174,
      width: tableCallout ? 728 : 842,
      height: tableHeight,
      properties: {
        fontName: type.body,
        fontSize: 13,
        color: colors.ink,
        headerFillColor: tableCallout ? colors.accent : colors.inverse,
        headerColor: tableCallout ? colors.onAccent : colors.onInverse,
        bodyFillColor: tableCallout ? colors.canvas : colors.surface,
        headerRowHeight: 42,
        bodyRowHeight,
      },
    });
  } else if (kind === 'split') {
    output.push(pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: contentTitleSize, bold: true, color: colors.ink,
    }));
    const paragraphs = operation.bullets
      ? pptBulletParagraphs(operation.bullets, design, { size: 16 })
      : pptBodyParagraphs(operation.body, design, { size: 16 });
    const visualLeft = compositionVariant === 'visual-left';
    output.push(pptText(slide, '', {
      left: visualLeft ? 526 : 58, top: 156, width: 374, height: 280,
    }, paragraphs));
    const imagePath = operation.image?.path || operation.imagePath;
    if (imagePath) {
      output.push({
        op: 'add_image',
        slide,
        path: imagePath,
        left: visualLeft ? 58 : 492,
        top: 142,
        width: 408,
        height: 306,
      });
    } else {
      output.push(pptShape(slide, 'rectangle', {
        left: visualLeft ? 58 : 492, top: 142, width: 408, height: 306,
        fillColor: colors.inverse, lineColor: colors.inverse,
      }));
      output.push(pptText(slide, String(operation.visualText || subtitle || ''), {
        left: visualLeft ? 96 : 530, top: 214, width: 330, height: 156,
        fontName: type.display, fontSize: 30, bold: true, color: colors.onInverse,
      }));
    }
  } else if (kind === 'closing') {
    const decisionFocus = compositionVariant === 'decision-focus';
    if (eyebrow) output.push(pptText(slide, eyebrow.toUpperCase(), {
      left: decisionFocus ? 220 : 58, top: 68, width: decisionFocus ? 520 : 420, height: 22,
      fontName: type.body, fontSize: 12, bold: true, color: colors.accent,
      ...(decisionFocus ? { alignment: 'center' } : {}),
    }));
    output.push(pptText(slide, title, {
      left: decisionFocus ? 120 : 58, top: 156, width: decisionFocus ? 720 : operation.visualText ? 410 : 760, height: 142,
      fontName: type.display, fontSize: pptTitleSize(title, 42), bold: true, color: colors.onInverse,
      ...(decisionFocus ? { alignment: 'center' } : {}),
    }));
    if (subtitle) output.push(pptText(slide, subtitle, {
      left: decisionFocus ? 150 : 58, top: 330, width: decisionFocus ? 660 : 690, height: 72,
      fontName: type.body, fontSize: 17, color: mutedColor,
      ...(decisionFocus ? { alignment: 'center' } : {}),
    }));
    if (operation.visualText) {
      output.push(pptShape(slide, 'oval', {
        left: decisionFocus ? 417 : 770, top: decisionFocus ? 398 : 160, width: 126, height: 126,
        fillColor: colors.accent, lineColor: colors.accent,
      }));
      output.push(pptText(slide, String(operation.visualText), {
        left: decisionFocus ? 417 : 770, top: decisionFocus ? 422 : 184, width: 126, height: 54,
        fontName: type.display, fontSize: 34, bold: true, color: colors.onAccent, alignment: 'center',
      }));
      if (operation.visualLabel) output.push(pptText(slide, String(operation.visualLabel), {
        left: decisionFocus ? 432 : 785, top: decisionFocus ? 484 : 246, width: 96, height: 24,
        fontName: type.body, fontSize: 12, bold: true, color: colors.onAccent, alignment: 'center',
      }));
    }
  } else {
    output.push(pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: contentTitleSize, bold: true, color: titleColor,
    }));
    if (subtitle) output.push(pptText(slide, subtitle, {
      left: 58, top: 116, width: 760, height: 38,
      fontName: type.body, fontSize: 14, color: mutedColor,
    }));
    const visualText = String(operation.visualText || '');
    const editorialWide = compositionVariant === 'editorial-wide';
    const body = strings(operation.bullets || operation.body);
    if (editorialWide) {
      const lead = visualText || body.shift() || subtitle;
      if (lead) output.push(pptText(slide, lead, {
        left: 58, top: 176, width: 804, height: 132,
        fontName: type.display, fontSize: pptTitleSize(lead, 42), bold: true, color: colors.accent,
      }));
      const support = operation.bullets
        ? pptBulletParagraphs(body, design, { size: 16 })
        : pptBodyParagraphs(body, design, { size: 16 });
      if (support.length) output.push(pptText(slide, '', {
        left: 58, top: 332, width: 760, height: 118,
      }, support));
    } else {
      const paragraphs = operation.bullets
        ? pptBulletParagraphs(operation.bullets, design)
        : pptBodyParagraphs(operation.body, design);
      output.push(pptText(slide, '', {
        left: 58, top: 178, width: 590, height: 250,
      }, paragraphs));
    }
    if (visualText && !editorialWide) {
      output.push(pptShape(slide, 'rectangle', {
        left: 680, top: 178, width: 220, height: 220,
        fillColor: colors.surface, lineColor: colors.surface,
      }));
      output.push(pptText(slide, visualText, {
        left: 710, top: 224, width: 160, height: 130,
        fontName: type.display, fontSize: 30, bold: true, color: colors.accent,
      }));
    }
  }
  const source = provenanceText(operation.source);
  const notes = [String(operation.notes || '').trim(), source ? `Source: ${source}` : ''].filter(Boolean).join('\r\n');
  if (notes) output.push({ op: 'set_notes', slide, text: notes });
  return output;
}

function expandDocxDocument(operation, design, state, backend, composition) {
  const output = [];
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const format = design.format;
  const compositionId = String(composition?.id || 'decision-brief');
  const compactMemo = compositionId === 'compact-memo';
  const editorialReport = compositionId === 'editorial-report';
  const evidenceBrief = compositionId === 'evidence-brief';
  const decisionBrief = compositionId === 'decision-brief';
  const pageMargin = compactMemo
    ? Math.max(46.8, format.margin * 0.84)
    : editorialReport
      ? format.margin * 1.08
      : format.margin;
  const bodySize = compactMemo ? Math.max(9.5, format.body - 0.5) : format.body;
  if (backend === 'microsoft-office-com' && operation.page !== false) {
    output.push({
      op: 'set_page',
      properties: {
        orientation: operation.orientation || 'portrait',
        topMargin: pageMargin,
        bottomMargin: pageMargin,
        leftMargin: pageMargin,
        rightMargin: pageMargin,
      },
    });
  }
  const append = (text, style, properties = {}) => {
    if (text == null || text === '') return 0;
    state.paragraph += 1;
    output.push({
      op: 'append_text',
      text: String(text),
      style,
      properties,
    });
    return state.paragraph;
  };
  append(operation.title, 'Title', {
    name: type.display,
    size: Number(operation.titleSize) || format.title + (editorialReport ? 3 : compactMemo ? -1 : 0),
    bold: true,
    color: colors.ink,
    spacingBefore: 0,
    spacingAfter: editorialReport ? 12 : compactMemo ? 5 : 8,
    keepWithNext: true,
  });
  append(operation.subtitle, 'Normal', {
    name: type.body,
    size: bodySize,
    color: colors.muted,
    spacingBefore: 0,
    spacingAfter: compactMemo ? 7 : 12,
    lineSpacing: bodySize * 1.35,
  });
  const meta = strings(operation.meta);
  if (meta.length) {
    append(meta.join(' · '), 'Normal', {
      name: type.body,
      size: Math.max(8.5, bodySize - 1),
      color: colors.muted,
      spacingBefore: 0,
      spacingAfter: compactMemo ? 8 : 14,
    });
  }
  if (operation.summary) {
    append(strings(operation.summary).join(' '), 'Normal', {
      name: type.display,
      size: bodySize + (decisionBrief ? 1.5 : 1),
      bold: true,
      color: decisionBrief ? colors.accent : colors.ink,
      spacingBefore: compactMemo ? 2 : 4,
      spacingAfter: editorialReport ? 18 : compactMemo ? 9 : 14,
      lineSpacing: (bodySize + 1) * 1.35,
      keepWithNext: true,
    });
  }
  for (const section of Array.isArray(operation.sections) ? operation.sections : []) {
    append(section.heading || section.title, Number(section.level) === 2 ? 'Heading 2' : 'Heading 1', {
      name: type.display,
      size: (Number(section.level) === 2 ? format.heading2 : format.heading1) + (editorialReport ? 1 : 0),
      bold: true,
      color: section.accent === false || evidenceBrief ? colors.ink : colors.accent,
      spacingBefore: compactMemo ? (Number(section.level) === 2 ? 6 : 10) : Number(section.level) === 2 ? 9 : 14,
      spacingAfter: editorialReport ? 7 : 5,
      keepWithNext: true,
      pageBreakBefore: section.pageBreak === true,
    });
    for (const paragraph of strings(section.paragraphs || section.body)) {
      append(paragraph, 'Normal', {
        name: type.body,
        size: bodySize,
        color: colors.ink,
        spacingBefore: 0,
        spacingAfter: compactMemo ? 4 : editorialReport ? 8 : 6,
        lineSpacing: bodySize * (compactMemo ? 1.32 : 1.4),
      });
    }
    for (const bullet of strings(section.bullets)) {
      append(bullet, 'Normal', {
        name: type.body,
        size: bodySize,
        color: colors.ink,
        spacingBefore: 0,
        spacingAfter: 3,
        lineSpacing: bodySize * 1.35,
        listKind: 'bullet',
        listLevel: 0,
      });
    }
    if (section.quote) {
      append(section.quote, 'Quote', {
        name: type.display,
        size: bodySize + (editorialReport ? 2 : 1),
        italic: true,
        color: colors.accent,
        spacingBefore: 5,
        spacingAfter: 9,
        lineSpacing: (bodySize + 1) * 1.35,
      });
    }
    if (Array.isArray(section.table) && section.table.length) {
      state.table += 1;
      output.push({
        op: 'add_table',
        values: section.table,
        properties: {
          style: 'Table Grid',
          textStyle: 'Normal',
          fontName: type.body,
          fontSize: Math.max(9, bodySize - 1),
          color: colors.ink,
          spacingAfter: 0,
          borders: true,
        },
      });
      if (backend === 'microsoft-office-com') {
        output.push({ op: 'fit_table', table: state.table });
        const columns = Math.max(1, ...section.table.map((row) => Array.isArray(row) ? row.length : 1));
        for (let column = 1; column <= columns; column += 1) {
          output.push({
            op: 'set_table_cell_style',
            table: state.table,
            row: 1,
            col: column,
            properties: {
              fillColor: evidenceBrief ? colors.accent : colors.inverse,
              color: evidenceBrief ? colors.onAccent : colors.onInverse,
              bold: true,
              verticalAlignment: 'center',
            },
          });
        }
      }
    }
  }
  if (backend === 'microsoft-office-com' && operation.pageNumbers === true) {
    output.push({
      op: 'add_page_numbers',
      includeTotal: true,
      alignment: 'center',
      ...(operation.footer ? { prefix: `${String(operation.footer)} · Page ` } : {}),
    });
  } else if (backend === 'microsoft-office-com' && operation.footer) {
    output.push({ op: 'set_header_footer', header: false, text: String(operation.footer) });
  }
  return output;
}

function columnLabel(column) {
  let value = Math.max(1, Number(column) || 1);
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function safeTableName(value) {
  const normalized = String(value || 'MixdogTable').replace(/[^A-Za-z0-9_]/g, '');
  const leading = /^[A-Za-z_]/.test(normalized) ? normalized : `T${normalized}`;
  return (leading || 'MixdogTable').slice(0, 240);
}

function isExcelTotalRow(row) {
  return /^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))/i.test(String(row?.[0] || '').trim());
}

function expandXlsxSheet(operation, design, composition, backend = '') {
  const portable = backend === 'mixdog-ooxml';
  const output = [];
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const format = design.format;
  const compositionId = String(composition?.id || 'monitor-dashboard');
  const trendDashboard = compositionId === 'trend-dashboard';
  const comparisonBoard = compositionId === 'comparison-board';
  const analysisSheet = compositionId === 'analysis-sheet';
  const narrativeScorecard = compositionId === 'narrative-scorecard';
  const sheet = String(operation.sheet || 'Sheet1');
  const headers = strings(operation.headers);
  const rows = Array.isArray(operation.rows) ? operation.rows : [];
  const metrics = Array.isArray(operation.metrics) ? operation.metrics.slice(0, 4) : [];
  const dashboard = String(operation.kind || '').toLowerCase() === 'dashboard' || metrics.length > 0;
  const dataColumns = Math.max(
    1,
    headers.length,
    ...rows.map((entry) => Array.isArray(entry) ? entry.length : 1),
  );
  const columns = Math.max(
    dataColumns,
    dashboard ? metrics.length * 2 : 1,
  );
  const lastColumn = columnLabel(columns);
  const dataLastColumn = columnLabel(dataColumns);
  let row = 1;
  if (operation.title) {
    output.push({ op: 'set_cell', sheet, cell: 'A1', value: String(operation.title) });
    if (columns > 1) output.push({ op: 'merge_cells', sheet, range: `A1:${lastColumn}1` });
    output.push({
      op: 'set_style',
      sheet,
      range: `A1:${lastColumn}1`,
      properties: {
        fontName: type.display,
        fontSize: Number(operation.titleSize) || format.title,
        bold: true,
        color: analysisSheet ? colors.ink : narrativeScorecard ? colors.onAccent : colors.onInverse,
        fillColor: analysisSheet ? colors.surface2 : narrativeScorecard ? colors.accent : colors.inverse,
        verticalAlignment: 'center',
        wrapText: true,
      },
    });
    row += 1;
  }
  if (operation.subtitle) {
    output.push({ op: 'set_cell', sheet, cell: `A${row}`, value: String(operation.subtitle) });
    if (columns > 1) output.push({ op: 'merge_cells', sheet, range: `A${row}:${lastColumn}${row}` });
    output.push({
      op: 'set_style',
      sheet,
      range: `A${row}:${lastColumn}${row}`,
      properties: {
        fontName: type.body,
        fontSize: format.body,
        italic: true,
        color: colors.muted,
        fillColor: colors.surface,
        wrapText: true,
      },
    });
    row += 2;
  } else if (operation.title) {
    row += 1;
  }
  if (metrics.length) {
    metrics.forEach((metric, index) => {
      const startColumn = (index * 2) + 1;
      const endColumn = startColumn + 1;
      const start = columnLabel(startColumn);
      const end = columnLabel(endColumn);
      const valueRow = row;
      const labelRow = row + 1;
      const detailRow = row + 2;
      const valueCell = `${start}${valueRow}`;
      if (metric?.formula) output.push({ op: 'set_formula', sheet, cell: valueCell, formula: String(metric.formula) });
      else output.push({ op: 'set_cell', sheet, cell: valueCell, value: metric?.value ?? '' });
      output.push({ op: 'merge_cells', sheet, range: `${start}${valueRow}:${end}${valueRow}` });
      output.push({ op: 'set_cell', sheet, cell: `${start}${labelRow}`, value: String(metric?.label || '') });
      output.push({ op: 'merge_cells', sheet, range: `${start}${labelRow}:${end}${labelRow}` });
      output.push({ op: 'set_cell', sheet, cell: `${start}${detailRow}`, value: String(metric?.detail || '') });
      output.push({ op: 'merge_cells', sheet, range: `${start}${detailRow}:${end}${detailRow}` });
      output.push({
        op: 'set_style',
        sheet,
        range: `${start}${valueRow}:${end}${valueRow}`,
        properties: {
          fontName: type.data,
          fontSize: narrativeScorecard ? 25 : comparisonBoard ? 20 : 22,
          bold: true,
          color: index === 0 && !analysisSheet ? colors.onAccent : colors.ink,
          fillColor: index === 0 && !analysisSheet ? colors.accent : trendDashboard ? colors.canvas : colors.surface,
          numberFormat: metric?.numberFormat || 'General',
          horizontalAlignment: 'center',
          verticalAlignment: 'center',
        },
      });
      output.push({
        op: 'set_style',
        sheet,
        range: `${start}${labelRow}:${end}${detailRow}`,
        properties: {
          fontName: type.body,
          fontSize: 9,
          bold: true,
          color: colors.muted,
          fillColor: colors.surface,
          horizontalAlignment: 'center',
          verticalAlignment: 'center',
          wrapText: true,
        },
      });
    });
    row += 4;
  }
  const insights = strings(operation.insights);
  if (insights.length) {
    output.push({ op: 'set_cell', sheet, cell: `A${row}`, value: insights.join(' • ') });
    if (columns > 1) output.push({ op: 'merge_cells', sheet, range: `A${row}:${lastColumn}${row}` });
    output.push({
      op: 'set_style',
      sheet,
      range: `A${row}:${lastColumn}${row}`,
      properties: {
        fontName: type.body,
        fontSize: format.body,
        bold: true,
        color: narrativeScorecard ? colors.onInverse : colors.ink,
        fillColor: narrativeScorecard ? colors.inverse : trendDashboard ? colors.surface : colors.surface2,
        wrapText: true,
      },
    });
    row += 2;
  }
  const startRow = row;
  const values = headers.length ? [headers, ...rows] : rows;
  if (values.length) {
    const endRow = startRow + values.length - 1;
    output.push({
      op: 'set_range',
      sheet,
      range: `A${startRow}:${dataLastColumn}${endRow}`,
      values,
    });
    if (headers.length) {
      output.push({
        op: 'set_style',
        sheet,
        range: `A${startRow}:${dataLastColumn}${startRow}`,
        properties: {
          fontName: type.body,
          fontSize: format.heading,
          bold: true,
          color: colors.onAccent,
          fillColor: colors.accent,
          horizontalAlignment: 'center',
          verticalAlignment: 'center',
          wrapText: true,
        },
      });
      if (!portable) {
        output.push({
          op: 'add_table',
          sheet,
          range: `A${startRow}:${dataLastColumn}${endRow}`,
          name: safeTableName(operation.tableName || `${sheet}Data`),
          style: operation.tableStyle || format.tableStyle,
        });
      }
      output.push({ op: 'freeze_panes', sheet, row: startRow + 1, column: 1 });
    }
    output.push({
      op: 'set_style',
      sheet,
      range: `A${startRow + (headers.length ? 1 : 0)}:${dataLastColumn}${endRow}`,
      properties: {
        fontName: type.body,
        fontSize: format.body,
        color: colors.ink,
        verticalAlignment: 'center',
      },
    });
    if (plainObject(operation.columnFormats) && headers.length) {
      headers.forEach((header, index) => {
        const numberFormat = operation.columnFormats[header] || operation.columnFormats[columnLabel(index + 1)];
        if (!numberFormat || rows.length === 0) return;
        output.push({
          op: 'set_style',
          sheet,
          range: `${columnLabel(index + 1)}${startRow + 1}:${columnLabel(index + 1)}${endRow}`,
          properties: { numberFormat: String(numberFormat) },
        });
      });
    }
    if (plainObject(operation.chart)) {
      if (portable) {
        throw new Error('compose_sheet chart requires Microsoft Excel; omit chart or create the workbook with Excel installed');
      }
      let chartRows = rows.length;
      while (chartRows > 0 && isExcelTotalRow(rows[chartRows - 1])) chartRows -= 1;
      const chartEndRow = startRow + (headers.length ? 1 : 0) + chartRows - 1;
      const chartRange = operation.chart.range
        || `A${startRow}:${dataLastColumn}${Math.max(startRow, chartEndRow)}`;
      const chartType = operation.chart.type || 'column';
      const showValues = operation.chart.showValues ?? (dashboard && chartRows <= 6);
      const dataLabelPosition = operation.chart.dataLabelPosition
        || (showValues && ['column', 'bar'].includes(String(chartType).toLowerCase()) ? 'inside_end' : '');
      const chartDefaults = trendDashboard
        ? { left: 360, top: 172, width: 510, height: 286 }
        : comparisonBoard
          ? { left: 390, top: 184, width: 480, height: 278 }
          : analysisSheet
            ? { left: 520, top: 40, width: 480, height: 280 }
            : narrativeScorecard
              ? { left: 430, top: 206, width: 450, height: 258 }
              : { left: dashboard ? 410 : 520, top: dashboard ? 190 : 40, width: dashboard ? 420 : 480, height: 280 };
      output.push({
        op: 'add_chart',
        sheet,
        range: chartRange,
        chartType,
        title: operation.chart.title || '',
        left: Number(operation.chart.left) || chartDefaults.left,
        top: Number(operation.chart.top) || chartDefaults.top,
        width: Number(operation.chart.width) || chartDefaults.width,
        height: Number(operation.chart.height) || chartDefaults.height,
        seriesColors: operation.chart.seriesColors || [colors.accent, colors.accent2, colors.muted],
        showValues,
        ...(dataLabelPosition ? { dataLabelPosition } : {}),
        ...(dataLabelPosition === 'inside_end' ? {
          dataLabelColor: operation.chart.dataLabelColor || colors.onAccent,
        } : {}),
        zeroBaseline: operation.chart.zeroBaseline ?? ['column', 'bar'].includes(String(chartType).toLowerCase()),
        ...(operation.chart.showLegend == null ? {} : { showLegend: operation.chart.showLegend }),
        ...(operation.chart.valueNumberFormat ? { valueNumberFormat: operation.chart.valueNumberFormat } : {}),
      });
    }
  }
  if (operation.source) {
    const attribution = `Source: ${provenanceText(operation.source) || String(operation.source)}`;
    if (portable) {
      const captionRow = Math.max(row, startRow + values.length) + 1;
      output.push({ op: 'set_cell', sheet, cell: `A${captionRow}`, value: attribution });
      output.push({
        op: 'set_style',
        sheet,
        range: `A${captionRow}:${dataLastColumn}${captionRow}`,
        properties: {
          fontName: type.body,
          fontSize: 9,
          italic: true,
          color: colors.muted,
        },
      });
    } else {
      output.push({ op: 'add_note', sheet, cell: 'A1', text: attribution });
    }
  }
  output.push({ op: 'autofit_range', sheet, range: `A:${dataLastColumn}` });
  const printColumns = plainObject(operation.chart) ? Math.max(columns, 14) : columns;
  output.push({
    op: 'set_page_setup',
    sheet,
    printArea: `A1:${columnLabel(printColumns)}${Math.max(row, startRow + values.length + 1, dashboard ? 24 : 1)}`,
    orientation: dashboard || plainObject(operation.chart) ? 'landscape' : 'portrait',
    fitToPagesWide: 1,
    fitToPagesTall: dashboard ? 1 : 0,
    centerHorizontally: true,
    centerVertically: dashboard && !analysisSheet,
  });
  output.push({
    op: 'set_sheet_view',
    sheet,
    showGridlines: false,
    zoom: analysisSheet ? 100 : trendDashboard ? 85 : dashboard ? 90 : 100,
  });
  return output;
}

export function expandOfficeDesignOperations({
  format,
  backend = '',
  operations = [],
  design: request = {},
  library = null,
  created = false,
  snapshotVersion = 0,
} = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  const design = resolveOfficeDesign(normalizedFormat, request, { library });
  const output = [];
  const semantic = [];
  let nextSlide = created && Number(snapshotVersion || 0) === 0 ? 1 : null;
  const docxState = { paragraph: 0, table: 0 };
  const layoutUsage = new Map();
  const compositionUsage = new Map();
  for (const operation of operations || []) {
    const bound = bindOfficeContent(operation, design.content);
    const contentOperation = bound.operation;
    const name = String(contentOperation?.op || '');
    if (normalizedFormat === 'pptx' && name === 'compose_slide') {
      const composition = planOfficeComposition(normalizedFormat, contentOperation, design, {
        usage: compositionUsage,
      });
      const plannedOperation = {
        ...contentOperation,
        kind: composition.kind,
        __composition: composition,
      };
      const slide = Number(plannedOperation.slide) || nextSlide;
      if (!slide) throw new Error('compose_slide requires slide for an existing presentation');
      const selectedLayout = selectPptxLayout(plannedOperation, design, layoutUsage);
      const layout = selectedLayout?.layout || null;
      const composed = layout ? merge(layout.defaults || {}, plannedOperation) : plannedOperation;
      const backgroundSpec = pptxBackgroundSpec(composed, design, composition.kind, slide);
      const plan = pptxSlidePlan(composed, composition.kind, slide);
      const templateOperations = expandTemplatePptxSlide(composed, layout, slide, backend);
      if (templateOperations) {
        output.push(...templateOperations);
        layoutUsage.set(layout.id, (layoutUsage.get(layout.id) || 0) + 1);
      } else {
        if (design.deck.templateMode === 'strict') {
          throw new Error(`compose_slide requires an approved native template layout for kind "${operation.kind}" in strict mode`);
        }
        output.push(...expandPptxSlide(composed, design, slide, backend));
      }
      semantic.push({
        op: name,
        kind: composition.kind,
        requestedKind: String(contentOperation.kind || 'content'),
        slide,
        slideRole: backgroundSpec.slideRole,
        backgroundRole: backgroundSpec.backgroundRole,
        plan,
        composition: layout ? {
          ...composition,
          id: `${composition.kind}:template:${layout.id}`,
          family: 'native-template',
          variant: layout.variant || composition.variant,
          source: 'native-template',
        } : composition,
        renderMode: templateOperations ? 'native-template' : 'scratch',
        ...(bound.binding ? { contentBinding: bound.binding } : {}),
        ...(layout ? {
          layout: layout.id,
          variant: layout.variant || '',
          sourceSlide: Number(layout.sourceSlide) || 0,
          templateId: layout.templateId || '',
          selection: {
            score: selectedLayout.score,
            demand: selectedLayout.demand,
            fit: selectedLayout.fit,
          },
        } : {}),
      });
      if (nextSlide != null) nextSlide += 1;
      continue;
    }
    if (normalizedFormat === 'docx' && name === 'compose_document') {
      const composition = planOfficeComposition(normalizedFormat, contentOperation, design, {
        usage: compositionUsage,
      });
      output.push(...expandDocxDocument(contentOperation, design, docxState, backend, composition));
      semantic.push({
        op: name,
        sections: Array.isArray(contentOperation.sections) ? contentOperation.sections.length : 0,
        composition,
        ...(bound.binding ? { contentBinding: bound.binding } : {}),
      });
      continue;
    }
    if (normalizedFormat === 'xlsx' && name === 'compose_sheet') {
      const composition = planOfficeComposition(normalizedFormat, contentOperation, design, {
        usage: compositionUsage,
      });
      output.push(...expandXlsxSheet(contentOperation, design, composition, backend));
      semantic.push({
        op: name,
        sheet: String(contentOperation.sheet || 'Sheet1'),
        composition,
        ...(bound.binding ? { contentBinding: bound.binding } : {}),
      });
      continue;
    }
    output.push(contentOperation);
  }
  const expandedOperations = normalizedFormat === 'pptx' && created && Number(snapshotVersion || 0) === 0
    ? coalesceCreatedPptxTemplateImports(output)
    : output;
  return {
    operations: expandedOperations,
    semantic,
    design: compactDesign(design),
    content: summarizeOfficeContentModel(design.content),
    composition: summarizeOfficeCompositions(normalizedFormat, semantic),
  };
}

export function applyPdfDesign(blocks = [], designRequest = {}, { library = null } = {}) {
  const design = resolveOfficeDesign('pdf', designRequest, { library });
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  let headingIndex = 0;
  const styledBlocks = (blocks || []).map((block) => {
    const typeName = String(block?.type || 'paragraph').toLowerCase();
    if (typeName === 'heading') {
      headingIndex += 1;
      return {
        ...block,
        font: block.font || type.display,
        size: block.size || (headingIndex === 1 ? design.format.title : design.format.heading),
        color: block.color || (headingIndex === 1 ? colors.ink : colors.accent),
        after: block.after ?? (headingIndex === 1 ? 18 : 10),
      };
    }
    if (typeName === 'paragraph') {
      return {
        ...block,
        font: block.font || type.body,
        size: block.size || design.format.body,
        color: block.color || colors.ink,
        lineHeight: block.lineHeight || design.format.body * 1.5,
        after: block.after ?? 8,
      };
    }
    if (typeName === 'table') {
      return {
        ...block,
        font: block.font || type.data,
        color: block.color || colors.ink,
        headerFill: block.headerFill || colors.inverse,
        headerColor: block.headerColor || colors.onInverse,
        zebraFill: block.zebraFill || colors.surface,
        borderColor: block.borderColor || colors.surface2,
      };
    }
    return block;
  });
  return {
    blocks: styledBlocks,
    properties: {
      margin: design.format.margin,
      background: colors.canvas,
      fontName: type.body,
      ...compactDesign(design),
    },
    design: compactDesign(design),
  };
}

function designIssue(code, path, message, severity = 'warning') {
  return { severity, code, path, message, source: 'design-review' };
}

function pptxSlideBackgroundColor(slide) {
  const value = String(slide?.background?.color || '').replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(value) ? value : '';
}

function pptxExpectedBackgroundRole(slide, slides, deck) {
  if (slide.index === 1) return deck.roles.cover;
  if (slide.index === slides.length) return deck.roles.closing;
  if (deck.sectionSlides.includes(slide.index)) return deck.roles.section;
  return deck.roles.content;
}

function reviewPptxTheme(slides, design, issues) {
  const deck = design.deck;
  if (!deck?.enforce || deck.backgroundMode === 'custom' || slides.length < 2) return;
  const backgrounds = slides.map(pptxSlideBackgroundColor);
  if (backgrounds.some((color) => !color)) return;
  const mismatches = [];
  slides.forEach((slide, index) => {
    const role = pptxExpectedBackgroundRole(slide, slides, deck);
    const expected = String(design.tokens.colors[role] || '').toUpperCase();
    if (expected && backgrounds[index] !== expected) {
      mismatches.push(`${slide.index}:${backgrounds[index]}→${role}`);
    }
  });
  if (mismatches.length) {
    issues.push(designIssue(
      'theme_background_drift',
      '/',
      `Slide backgrounds violate the ${deck.backgroundMode} deck plan (${mismatches.join(', ')}).`,
    ));
  }
  const contentColors = slides
    .filter((slide) => slide.index !== 1 && slide.index !== slides.length && !deck.sectionSlides.includes(slide.index))
    .map(pptxSlideBackgroundColor);
  if (new Set(contentColors).size > 1) {
    issues.push(designIssue(
      'theme_body_backgrounds',
      '/',
      'Content slides use multiple background colors instead of one dominant canvas.',
    ));
  }
}

function normalizedShapeSignature(slide) {
  return (slide.shapes || [])
    .filter((shape) => String(shape.text || '').trim())
    .map((shape) => [
      Number(shape.type) || 0,
      Math.round((Number(shape.left) || 0) / 24),
      Math.round((Number(shape.top) || 0) / 24),
      Math.round((Number(shape.width) || 0) / 24),
      Math.round((Number(shape.height) || 0) / 24),
    ].join(':'))
    .sort()
    .join('|');
}

function reviewPptx(document, design) {
  const issues = [];
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const plansBySlide = new Map((design.slidePlans || []).map((plan) => [Number(plan.slide), plan]));
  reviewPptxTheme(slides, design, issues);
  let cardGridSlides = 0;
  const signatures = new Map();
  let nativeEvidenceSlides = 0;
  for (const slide of slides) {
    const shapes = Array.isArray(slide.shapes) ? slide.shapes : [];
    const textShapes = shapes.filter((shape) => String(shape.text || '').trim());
    const pictures = shapes.filter((shape) => Number(shape.type) === 13);
    const richVisuals = shapes.filter((shape) => shape.chart || shape.table || shape.group);
    if (pictures.length || shapes.some((shape) => shape.chart || shape.table)) nativeEvidenceSlides += 1;
    const nonTextShapes = shapes.filter((shape) => !String(shape.text || '').trim() && !shape.placeholder);
    const typographicVisual = textShapes.some((shape) => Number(shape.font?.size) >= 42)
      || textShapes.filter((shape) => Number(shape.font?.size) >= 34).length >= 2;
    const semanticVisual = String(plansBySlide.get(Number(slide.index))?.visualType || '');
    const purposefulDiagram = ['comparison', 'diagram', 'matrix', 'process'].includes(semanticVisual)
      && nonTextShapes.length > 0;
    const contentSlide = slides.length <= 2 || (slide.index !== 1 && slide.index !== slides.length);
    if (
      contentSlide
      && textShapes.length
      && pictures.length === 0
      && richVisuals.length === 0
      && nonTextShapes.length < 2
      && !typographicVisual
      && !purposefulDiagram
      && !design.review.allowTextOnly
    ) {
      issues.push(designIssue(
        'meaningful_visual_missing',
        `/slide[${slide.index}]`,
        'Content slide has no image, chart, table, group, or purposeful diagram.',
      ));
    }
    const textLength = textShapes.reduce((total, shape) => total + String(shape.text || '').length, 0);
    if (textLength > 650) {
      issues.push(designIssue(
        'excessive_slide_text',
        `/slide[${slide.index}]`,
        `Slide contains ${textLength} characters; split or visualize the content.`,
      ));
    }
    const ornamental = nonTextShapes.filter((shape) => {
      const width = Number(shape.width) || 0;
      const height = Number(shape.height) || 0;
      return (width <= 14 && height >= 180) || (height <= 7 && width >= 320);
    });
    if (ornamental.length && !design.review.allowDecorativeLines) {
      issues.push(designIssue(
        'decorative_stripe',
        `/slide[${slide.index}]`,
        'Thin decorative stripe or rule resembles generic AI slide ornamentation.',
      ));
    }
    const rectangularText = textShapes.filter((shape) => Number(shape.type) === 1);
    const sizeGroups = new Map();
    for (const shape of rectangularText) {
      const key = `${Math.round((Number(shape.width) || 0) / 12)}:${Math.round((Number(shape.height) || 0) / 12)}`;
      sizeGroups.set(key, (sizeGroups.get(key) || 0) + 1);
    }
    if ([...sizeGroups.values()].some((count) => count >= 3)) cardGridSlides += 1;
    if (contentSlide) {
      const signature = normalizedShapeSignature(slide);
      if (signature) signatures.set(signature, (signatures.get(signature) || 0) + 1);
    }
  }
  const contentCount = slides.length > 2 ? slides.length - 2 : slides.length;
  const repeated = Math.max(0, ...signatures.values());
  if (contentCount >= 4 && repeated / contentCount >= 0.75 && !design.review.allowRepetition) {
    issues.push(designIssue(
      'repetitive_composition',
      '/',
      `${repeated} of ${contentCount} content slides repeat the same composition.`,
    ));
  }
  if (cardGridSlides >= 2 && !design.review.allowRepetition) {
    issues.push(designIssue(
      'card_grid_overuse',
      '/',
      `${cardGridSlides} slides use repeated same-size text cards; vary the visual structure.`,
    ));
  }
  const requiredNativeEvidence = Math.max(1, Math.ceil(contentCount / 3));
  if (
    slides.length >= 5
    && nativeEvidenceSlides < requiredNativeEvidence
    && !design.review.allowSyntheticVisuals
  ) {
    issues.push(designIssue(
      'native_evidence_too_weak',
      '/',
      `Deck uses native image, chart, or table evidence on ${nativeEvidenceSlides} slide(s); at least ${requiredNativeEvidence} are required.`,
    ));
  }
  return issues;
}

function reviewDocx(document) {
  const issues = [];
  const paragraphs = Array.isArray(document?.paragraphs) ? document.paragraphs : [];
  const content = paragraphs.filter((paragraph) => String(paragraph.text || '').trim());
  const headings = content.filter((paragraph) => /title|heading|제목/i.test(String(paragraph.style || '')));
  if (content.length >= 8 && headings.length === 0) {
    issues.push(designIssue(
      'heading_hierarchy_missing',
      '/body',
      'Document has substantial content but no visible title or heading hierarchy.',
    ));
  }
  for (const paragraph of content) {
    if (String(paragraph.text || '').length > 900) {
      issues.push(designIssue(
        'dense_paragraph',
        paragraph.path || '/body',
        'Paragraph is too dense for fast document scanning.',
      ));
    }
  }
  return issues;
}

function reviewXlsx(document) {
  const issues = [];
  const sheets = Array.isArray(document?.sheets) ? document.sheets : [];
  for (const sheet of sheets) {
    const cells = Array.isArray(sheet.cells) ? sheet.cells : [];
    if (cells.length < 8) continue;
    const styled = cells.filter((cell) => cell.style && Object.keys(cell.style).length);
    if (styled.length === 0) {
      issues.push(designIssue(
        'worksheet_hierarchy_missing',
        sheet.path || `/sheet[${sheet.name || ''}]`,
        'Data sheet has no styled title, header, table, or visual hierarchy.',
      ));
    }
  }
  return issues;
}

export function reviewPptxVisualCritique({ critique = [], pageCount = 0 } = {}) {
  const total = Math.max(0, Number(pageCount) || 0);
  const issues = [];
  const entries = [];
  const bySlide = new Map();
  for (const raw of Array.isArray(critique) ? critique : []) {
    if (!plainObject(raw)) continue;
    const slide = Number(raw.slide);
    if (!Number.isInteger(slide) || slide < 1 || slide > total || bySlide.has(slide)) {
      issues.push({
        severity: 'warning',
        code: 'visual_critique_invalid_slide',
        path: '/',
        message: `Visual critique has an invalid or duplicate slide index: ${raw.slide}`,
        source: 'visual-critique',
      });
      continue;
    }
    const scores = Object.fromEntries(PPTX_CRITIQUE_AXES.map((axis) => [axis, Number(raw[axis])]));
    const note = String(raw.note || '').trim();
    const fixes = strings(raw.fixes);
    const verdict = String(raw.verdict || '').toLowerCase();
    const validScores = PPTX_CRITIQUE_AXES.every((axis) => Number.isInteger(scores[axis]) && scores[axis] >= 1 && scores[axis] <= 5);
    const entry = { slide, verdict, ...scores, note, fixes };
    entries.push(entry);
    bySlide.set(slide, entry);
    if (!validScores || note.length < 40) {
      issues.push({
        severity: 'warning',
        code: 'visual_critique_incomplete',
        path: `/slide[${slide}]`,
        message: 'Visual critique requires five integer scores from 1-5 and a slide-specific note of at least 40 characters.',
        source: 'visual-critique',
      });
    } else if (verdict !== 'pass' || fixes.length || PPTX_CRITIQUE_AXES.some((axis) => scores[axis] < 4)) {
      issues.push({
        severity: 'warning',
        code: 'visual_critique_needs_polish',
        path: `/slide[${slide}]`,
        message: `Slide ${slide} still needs polish before finalization.`,
        source: 'visual-critique',
      });
    }
  }
  for (let slide = 1; slide <= total; slide += 1) {
    if (!bySlide.has(slide)) {
      issues.push({
        severity: 'warning',
        code: 'visual_critique_missing_slide',
        path: `/slide[${slide}]`,
        message: `Slide ${slide} has no visual critique.`,
        source: 'visual-critique',
      });
    }
  }
  const notes = entries.map((entry) => entry.note.toLowerCase()).filter(Boolean);
  if (total > 1 && notes.length === total && new Set(notes).size !== total) {
    issues.push({
      severity: 'warning',
      code: 'visual_critique_repeated_note',
      path: '/',
      message: 'Each slide needs a distinct visual critique note.',
      source: 'visual-critique',
    });
  }
  return {
    ok: total > 0 && issues.length === 0,
    status: total > 0 && issues.length === 0 ? 'pass' : 'needs-polish',
    axes: [...PPTX_CRITIQUE_AXES],
    pageCount: total,
    entries,
    issues,
  };
}

export function pptxVisualReviewAcknowledged({
  reviewed = false,
  providedToken = '',
  expectedToken = '',
  renderedVersion = null,
  snapshotVersion = 0,
  critiqueOk = false,
} = {}) {
  return reviewed === true
    && Boolean(expectedToken)
    && String(providedToken || '') === String(expectedToken)
    && Number(renderedVersion) === Number(snapshotVersion || 0)
    && critiqueOk === true;
}

export function reviewOfficeDesign({
  format,
  document,
  design: request = {},
  library = null,
  auditProfile = '',
} = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  const design = resolveOfficeDesign(normalizedFormat, request, { library });
  const compositionReview = reviewOfficeCompositionSequence({
    format: normalizedFormat,
    compositions: design.compositions,
    recentCompositions: design.recentCompositions,
    allowRepetition: design.review.allowRepetition,
  });
  if (!design.review.required) {
    return {
      ok: true,
      status: 'skipped',
      profile: design.profile,
      issues: [],
      composition: compositionReview.summary,
      requiresVisualInspection: false,
    };
  }
  const structureIssues = reviewOfficeStructure({
    format: normalizedFormat,
    document,
    auditProfile,
  });
  const issues = normalizedFormat === 'pptx'
    ? [...reviewPptx(document, design), ...structureIssues]
    : structureIssues;
  if (
    compositionReview.repeated
    && !issues.some((entry) => entry.code === 'repetitive_composition')
  ) {
    issues.push(designIssue(
      'repetitive_composition',
      '/',
      `${compositionReview.repeated.count} of ${compositionReview.repeated.total} semantic compositions reuse ${compositionReview.repeated.id}.`,
    ));
  }
  if (compositionReview.recentMatch) {
    issues.push(designIssue(
      'recent_composition_repeat',
      '/',
      'The complete composition sequence matches a recent deliverable; recompose the structure while preserving brand constraints.',
    ));
  }
  return {
    ok: issues.length === 0,
    status: issues.length ? 'needs-polish' : 'pass',
    profile: design.profile,
    issues,
    composition: compositionReview.summary,
    requiresVisualInspection: !['csv', 'tsv'].includes(normalizedFormat),
    modelReview: [
      'Inspect every rendered page, not only lint counts.',
      'Verify the reading path states the conclusion, evidence, and requested decision before supporting detail.',
      'Trace material numbers from source through calculation to the displayed claim; reject decorative or unsupported data.',
      'Reject generic palette, decorative stripes, repeated cards, weak hierarchy, and interchangeable layouts.',
      'Confirm the design is specific to the subject, audience, and intended action.',
      'Refine the current composition before adding decoration.',
    ],
  };
}
