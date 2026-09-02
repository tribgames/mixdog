import { createHash } from 'node:crypto';
import { retrievePptxVisualReferences } from './design-reference-visual-catalog.mjs';
import { compact, plainObject, stableValue } from '../shared/values.mjs';

const MAX_CANDIDATES = 6;
const MAX_SLIDES = 12;
const EVIDENCE_ROLES = new Set([
  'metric',
  'metrics',
  'chart',
  'table',
  'image',
  'visual',
  'process',
  'comparison',
  'annotated-chart',
  'allocation',
  'timeline',
  'scorecard',
]);
const PROHIBITED_MOTIFS = [
  'decorative-stripe',
  'one-sided-border',
  'title-underline',
  'equal-card-grid',
  'generic-stock-image',
];

function strings(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .map((entry) => compact(entry, 120))
    .filter(Boolean))];
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex').slice(0, 16);
}

function contentFingerprint(content) {
  const semanticElements = plainObject(content.elements)
    ? Object.fromEntries(Object.entries(content.elements).map(([id, value]) => {
        if (!plainObject(value)) return [id, value];
        const { style: _style, ...semantic } = value;
        return [id, semantic];
      }))
    : {};
  const { elements: _elements, ...semantic } = content;
  return fingerprint({ ...semantic, elements: semanticElements });
}

function elementForRegion(region, elements) {
  if (!Object.hasOwn(elements, region.id)) return region;
  const element = elements[region.id];
  if (!plainObject(element)) return { ...region, text: String(element ?? '') };
  return {
    ...region,
    ...(element.text != null ? { text: String(element.text) } : {}),
    ...(plainObject(element.style) ? {
      style: {
        ...(plainObject(region.style) ? region.style : {}),
        ...element.style,
      },
    } : {}),
  };
}

function genericMotifs(candidate, slide, regions) {
  const declared = strings([
    ...(Array.isArray(candidate.motifs) ? candidate.motifs : []),
    ...(Array.isArray(slide.motifs) ? slide.motifs : []),
  ]).map((entry) => entry.toLowerCase());
  const issues = PROHIBITED_MOTIFS.filter((motif) => declared.some((entry) => entry.includes(motif)));
  const repeatedCards = regions.filter((region) => ['metric', 'shape'].includes(String(region.role || '').toLowerCase()));
  if (repeatedCards.length >= 3) {
    const sizes = repeatedCards.map((region) => `${Math.round(Number(region.w) || 0)}x${Math.round(Number(region.h) || 0)}`);
    if (new Set(sizes).size === 1) issues.push('equal-card-grid');
  }
  return [...new Set(issues)];
}

function elementForScene(raw, elements) {
  const element = plainObject(raw) ? { ...raw } : raw;
  if (!plainObject(element)) return element;
  if (
    element.text != null
    || element.path != null
    || element.chart != null
    || element.table != null
    || element.values != null
  ) {
    throw new Error(`Authored scene element "${element.id || ''}" embeds content; put payload in content.elements.`);
  }
  if (!Object.hasOwn(elements, element.id)) return element;
  const payload = elements[element.id];
  if (!plainObject(payload)) return { ...element, text: String(payload ?? '') };
  return {
    ...element,
    ...payload,
    style: {
      ...(plainObject(element.style) ? element.style : {}),
      ...(plainObject(payload.style) ? payload.style : {}),
    },
  };
}

function compositionPayload(slide) {
  const plan = slide.operation.plan;
  if (plainObject(plan.authoredScene)) {
    return plan.authoredScene.elements.map((element) => ({
      id: element.id,
      type: element.type,
      role: element.role,
      x: element.x,
      y: element.y,
      w: element.w,
      h: element.h,
      box: element.box,
      layer: element.layer,
      shapeType: element.shapeType,
      style: element.style,
    }));
  }
  return plan.regions;
}

function layoutSignature(slides) {
  return slides.map((slide) => {
    const scene = slide.operation.plan.authoredScene;
    if (plainObject(scene)) {
      const elements = scene.elements;
      const dominant = [...elements]
        .filter((element) => !['title', 'eyebrow', 'subtitle', 'source'].includes(String(element.role || '')))
        .sort((left, right) => ((Number(right.w) || 0) * (Number(right.h) || 0)) - ((Number(left.w) || 0) * (Number(left.h) || 0)))[0];
      return `${slide.grammar}:scene:${dominant?.type || 'text'}:${elements.map((element) => `${element.type}/${element.role || ''}`).join(',')}`;
    }
    const regions = slide.operation.plan.regions;
    const dominant = [...regions]
      .filter((region) => !['eyebrow', 'title', 'subtitle', 'source'].includes(region.role))
      .sort((left, right) => ((Number(right.w) || 0) * (Number(right.h) || 0)) - ((Number(left.w) || 0) * (Number(left.h) || 0)))[0];
    const horizontal = dominant && Number(dominant.w) >= Number(dominant.h) ? 'wide' : 'tall';
    const x = dominant ? Math.min(2, Math.floor((Number(dominant.x) || 0) / 34)) : 1;
    const y = dominant ? Math.min(2, Math.floor((Number(dominant.y) || 0) / 34)) : 1;
    return `${slide.grammar}:${dominant?.role || 'typography'}:${horizontal}:${x}:${y}:${regions.map((region) => region.role).join(',')}`;
  }).join('|');
}

function normalizeSlide(candidate, raw, slideIndex, catalog) {
  if (!plainObject(raw)) throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} must be an object.`);
  if (!plainObject(raw.background)) {
    throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} requires a separate background layer.`);
  }
  const hasScene = plainObject(raw.scene) && Array.isArray(raw.scene.elements) && raw.scene.elements.length;
  const hasRegions = plainObject(raw.layout) && Array.isArray(raw.layout.regions) && raw.layout.regions.length;
  if (!hasScene && !hasRegions) {
    throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} requires scene.elements or layout.regions.`);
  }
  if (!plainObject(raw.content)) {
    throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} requires a separate content layer.`);
  }
  const content = { ...raw.content };
  const semanticContentFingerprint = contentFingerprint(content);
  const elements = plainObject(content.elements) ? content.elements : {};
  delete content.elements;
  const regions = hasRegions ? raw.layout.regions.map((region, regionIndex) => {
    if (!plainObject(region)) throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} region ${regionIndex + 1} must be an object.`);
    if (region.text != null) {
      throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} embeds text in layout region "${region.id || regionIndex + 1}"; put it in content.elements.`);
    }
    return elementForRegion({
      ...region,
      layer: Number.isFinite(Number(region.layer)) ? Number(region.layer) : regionIndex,
    }, elements);
  }) : [];
  const sceneElements = hasScene
    ? raw.scene.elements.map((element, elementIndex) => elementForScene({
        ...element,
        layer: Number.isFinite(Number(element.layer)) ? Number(element.layer) : elementIndex,
      }, elements))
    : [];
  const role = compact(raw.semantic?.role || content.creativeBrief?.role || content.kind || 'content', 80).toLowerCase();
  const visualType = compact(raw.semantic?.visualType || raw.layout?.visualType || content.visualType || 'typography', 80).toLowerCase();
  const density = compact(raw.semantic?.density || content.creativeBrief?.density || 'balanced', 40).toLowerCase();
  const domain = compact(raw.semantic?.domain || candidate.domain || '', 80).toLowerCase();
  const tags = strings(raw.semantic?.tags || candidate.tags).map((entry) => entry.toLowerCase());
  const requestedReferenceIds = strings(raw.references || candidate.references);
  const available = new Map((catalog.entries || []).map((entry) => [entry.id, entry]));
  const selectedReferences = requestedReferenceIds.length
    ? requestedReferenceIds.map((id) => {
        const entry = available.get(id);
        if (!entry) throw new Error(`Candidate "${candidate.id}" references unknown catalog entry "${id}".`);
        return { ...entry, matchScore: 1 };
      })
    : retrievePptxVisualReferences(catalog, {
        role,
        visualType,
        density,
        domain,
        tags,
      }, { limit: 3 });
  if (!selectedReferences.length) {
    throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} has no visual reference.`);
  }
  const motifs = genericMotifs(candidate, raw, hasScene ? sceneElements.map((element) => ({
    role: element.role || element.type,
    w: element.w ?? element.width,
    h: element.h ?? element.height,
  })) : regions);
  if (motifs.length) {
    throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} uses prohibited generic motifs: ${motifs.join(', ')}.`);
  }
  const kind = compact(content.kind || 'content', 40).toLowerCase();
  const slideRole = role === 'opening' || kind === 'cover'
    ? 'cover'
    : role === 'decision-close' || kind === 'closing'
      ? 'closing'
      : role === 'section'
        ? 'section'
        : 'content';
  if (
    !['cover', 'closing', 'statement'].includes(kind)
    && !(
      regions.some((region) => EVIDENCE_ROLES.has(String(region.role || '').toLowerCase()))
      || sceneElements.some((element) => (
        ['chart', 'table', 'image'].includes(String(element.type || '').toLowerCase())
        || ['evidence', 'metric', 'visual'].includes(String(element.role || '').toLowerCase())
      ))
    )
  ) {
    throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} requires a dominant evidence region.`);
  }
  const grammar = compact(raw.grammar || candidate.grammar, 80).toLowerCase();
  if (!grammar) throw new Error(`Candidate "${candidate.id}" slide ${slideIndex + 1} requires a named composition grammar.`);
  const plan = {
    name: compact(raw.name || `${candidate.id}-slide-${slideIndex + 1}`, 120),
    rationale: compact(raw.rationale || candidate.rationale, 320),
    message: compact(content.title || content.takeaway, 220),
    units: compact((hasScene ? raw.scene.units : raw.layout.units) || 'percent', 20),
    safeMargin: Number(hasScene ? raw.scene.safeMargin : raw.layout.safeMargin) || 4,
    visualType,
    focalRegion: compact(raw.layout?.focalRegion || 'full', 40),
    readingOrder: strings((hasScene ? raw.scene.readingOrder : raw.layout.readingOrder)),
    hierarchy: strings((hasScene ? raw.scene.hierarchy : raw.layout.hierarchy)),
    sourceContract: hasScene ? 'authored-scene-v1' : 'freeform-board-v1',
    referenceSelection: {
      contract: catalog.contract,
      coordinatePolicy: 'inspiration-only',
      ids: selectedReferences.map((entry) => entry.id),
      matches: selectedReferences.map((entry) => ({
        id: entry.id,
        score: entry.matchScore,
        role,
        visualType,
      })),
    },
    freeform: {
      version: hasScene ? 2 : 1,
      candidateId: candidate.id,
      grammar,
      layers: ['background', 'layout', 'content'],
      genericMotifs: [],
      editableCompile: true,
      expression: hasScene ? 'authored-scene-v1' : 'region-board-v1',
    },
    ...(hasScene ? {
      authoredScene: {
        version: 1,
        units: compact(raw.scene.units || 'percent', 20),
        safeMargin: Number(raw.scene.safeMargin) || 4,
        elements: sceneElements,
      },
    } : { regions }),
  };
  const operation = {
    op: 'compose_slide',
    ...content,
    kind,
    slideRole,
    ...(raw.create === false ? { create: false } : {}),
    ...(Number(raw.slide) > 0 ? { slide: Number(raw.slide) } : {}),
    ...(raw.background.role ? { backgroundRole: String(raw.background.role) } : {}),
    ...(raw.background.color ? { background: String(raw.background.color) } : {}),
    plan,
  };
  return {
    slide: Number(raw.slide) || slideIndex + 1,
    grammar,
    role,
    visualType,
    density,
    domain,
    contentFingerprint: semanticContentFingerprint,
    referenceIds: selectedReferences.map((entry) => entry.id),
    operation,
  };
}

export function compilePptxFreeformCandidateBoards(input = [], catalog) {
  const rawCandidates = Array.isArray(input) ? input : [];
  if (rawCandidates.length < 3) throw new Error('Free-form PPTX preview requires at least three complete candidate boards.');
  if (rawCandidates.length > MAX_CANDIDATES) throw new Error(`Free-form PPTX preview accepts at most ${MAX_CANDIDATES} candidates.`);
  const ids = new Set();
  const candidates = rawCandidates.map((raw, index) => {
    if (!plainObject(raw)) throw new Error(`PPTX candidate ${index + 1} must be an object.`);
    const candidate = {
      ...raw,
      id: compact(raw.id || `candidate-${index + 1}`, 80),
      grammar: compact(raw.grammar, 80).toLowerCase(),
      rationale: compact(raw.rationale, 320),
      domain: compact(raw.domain, 80).toLowerCase(),
    };
    if (ids.has(candidate.id)) throw new Error(`PPTX candidate id is duplicated: ${candidate.id}`);
    ids.add(candidate.id);
    if (!candidate.grammar) throw new Error(`Candidate "${candidate.id}" requires grammar.`);
    if (!Array.isArray(raw.slides) || !raw.slides.length || raw.slides.length > MAX_SLIDES) {
      throw new Error(`Candidate "${candidate.id}" requires 1-${MAX_SLIDES} slides.`);
    }
    const slides = raw.slides.map((slide, slideIndex) => normalizeSlide(candidate, slide, slideIndex, catalog));
    const slideCompositionFingerprints = slides.map((slide) => fingerprint(compositionPayload(slide)));
    const compositionFingerprint = fingerprint(slideCompositionFingerprints);
    return {
      id: candidate.id,
      grammar: candidate.grammar,
      rationale: candidate.rationale,
      slides,
      operations: slides.map((slide) => slide.operation),
      expression: slides.every((slide) => slide.operation.plan.sourceContract === 'authored-scene-v1')
        ? 'authored-scene-v1'
        : 'region-board-v1',
      slideCompositionFingerprints,
      compositionFingerprint,
    };
  });
  const slideCount = candidates[0].slides.length;
  const baselineContent = candidates[0].slides.map((slide) => slide.contentFingerprint);
  for (const candidate of candidates.slice(1)) {
    if (candidate.slides.length !== slideCount) {
      throw new Error('Every free-form candidate must contain the same number of slides.');
    }
    const content = candidate.slides.map((slide) => slide.contentFingerprint);
    if (content.some((value, index) => value !== baselineContent[index])) {
      throw new Error(`Candidate "${candidate.id}" changes semantic content; candidates may vary composition only.`);
    }
  }
  const grammarNames = new Set(candidates.map((candidate) => candidate.grammar));
  const signatures = new Set(candidates.map((candidate) => layoutSignature(candidate.slides)));
  if (grammarNames.size !== candidates.length || signatures.size !== candidates.length) {
    throw new Error('Free-form candidates must use visibly distinct composition grammars, not coordinate variants of one layout.');
  }
  return {
    version: 2,
    contract: 'freeform-design-board-v2',
    slideCount,
    contentFingerprint: fingerprint(baselineContent),
    compositionFingerprint: fingerprint(candidates.map((candidate) => candidate.compositionFingerprint)),
    candidates,
  };
}

export function advancePptxFreeformRevision(previous, next, round = 1) {
  if (Number(round) >= 3) throw new Error('Free-form candidate preview accepts at most three visual revision rounds.');
  if (previous?.contentFingerprint !== next?.contentFingerprint) {
    throw new Error('A visual revision changes semantic content; revise composition only.');
  }
  if (previous?.compositionFingerprint === next?.compositionFingerprint) {
    throw new Error('A visual revision must change authored composition, not only labels or rationale.');
  }
  const changedSlides = [];
  for (let index = 0; index < Math.max(previous?.slideCount || 0, next?.slideCount || 0); index += 1) {
    const changed = next.candidates.some((candidate) => {
      const prior = previous.candidates.find((entry) => entry.id === candidate.id);
      return prior?.slideCompositionFingerprints?.[index] !== candidate.slideCompositionFingerprints?.[index];
    });
    if (changed) changedSlides.push(index + 1);
  }
  if (!changedSlides.length) {
    throw new Error('A visual revision must identify at least one changed slide composition.');
  }
  return {
    round: Number(round) + 1,
    fromComposition: previous.compositionFingerprint,
    toComposition: next.compositionFingerprint,
    changedSlides,
  };
}

export function summarizePptxFreeformCandidateBoards(compiled) {
  return {
    version: compiled.version,
    contract: compiled.contract,
    slideCount: compiled.slideCount,
    contentFingerprint: compiled.contentFingerprint,
    compositionFingerprint: compiled.compositionFingerprint,
    candidates: compiled.candidates.map((candidate) => ({
      id: candidate.id,
      grammar: candidate.grammar,
      rationale: candidate.rationale,
      expression: candidate.expression,
      compositionFingerprint: candidate.compositionFingerprint,
      slideCompositionFingerprints: candidate.slideCompositionFingerprints,
      slides: candidate.slides.map((slide) => ({
        slide: slide.slide,
        role: slide.role,
        visualType: slide.visualType,
        density: slide.density,
        referenceIds: slide.referenceIds,
      })),
    })),
  };
}
