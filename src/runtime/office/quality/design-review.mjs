import { reviewOfficeStructure } from './assurance.mjs';
import { reviewOfficeCompositionSequence } from '../design/composition-system.mjs';
import { reviewPptxDeckDiversity } from './design-deck-diversity.mjs';
import { reviewPptxFrontierQuality } from './design-frontier-review.mjs';
import { PPTX_CRITIQUE_AXES } from '../design/pptx/design-pptx.mjs';
import { resolveOfficeDesign, strings } from '../design/design-tokens.mjs';
import {
  MAX_ACCENT_HUE_FAMILIES,
  MAX_FONT_FAMILIES_PER_SLIDE,
  fontFamilyKey,
  isMotifShape,
  isSafeFontFamily,
  saturatedHueFamilies,
} from '../design/design-discipline.mjs';
import { plainObject } from '../shared/values.mjs';

function designIssue(code, path, message, severity = 'warning') {
  return { severity, code, path, message, source: 'design-review' };
}


function pptxSlideBackgroundColor(slide) {
  const value = String(slide?.background?.color || '').replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(value) ? value : '';
}


function pptxExpectedSlideRole(slide, slides, deck, plansBySlide) {
  const plannedRole = String(
    plansBySlide.get(Number(slide.index))?.slideRole
      || plansBySlide.get(Number(slide.index))?.kind
      || '',
  ).toLowerCase();
  if (['cover', 'content', 'section', 'closing'].includes(plannedRole)) return plannedRole;
  if (slide.index === 1) return 'cover';
  if (deck.sectionSlides.includes(slide.index)) return 'section';
  if (slides.length >= 3 && slide.index === slides.length) return 'closing';
  return 'content';
}


function pptxExpectedBackgroundRole(slide, slides, deck, plansBySlide) {
  const plannedBackground = String(
    plansBySlide.get(Number(slide.index))?.backgroundRole || '',
  ).trim();
  return plannedBackground || deck.roles[pptxExpectedSlideRole(slide, slides, deck, plansBySlide)];
}


function reviewPptxTheme(document, design, issues) {
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const deck = design.deck;
  if (!deck?.enforce || deck.backgroundMode === 'custom' || slides.length < 2) return;
  const plansBySlide = new Map((design.slidePlans || []).map((plan) => [Number(plan.slide), plan]));
  const slideCount = Math.max(slides.length, Number(document?.slideCount) || 0);
  const roleSlides = Array.from({ length: slideCount }, (_, index) => ({ index: index + 1 }));
  const backgrounds = slides.map(pptxSlideBackgroundColor);
  if (backgrounds.some((color) => !color)) return;
  const mismatches = [];
  slides.forEach((slide, index) => {
    const role = pptxExpectedBackgroundRole(slide, roleSlides, deck, plansBySlide);
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
  const completePlan = slideCount > 0
    && roleSlides.every((slide) => plansBySlide.has(slide.index));
  const contentColors = completePlan
    ? roleSlides
      .filter((slide) => pptxExpectedSlideRole(slide, roleSlides, deck, plansBySlide) === 'content')
      .map((slide) => {
        const role = pptxExpectedBackgroundRole(slide, roleSlides, deck, plansBySlide);
        return String(design.tokens.colors[role] || '').toUpperCase();
      })
      .filter(Boolean)
    : slides.length === slideCount
      ? slides
        .filter((slide) => pptxExpectedSlideRole(slide, roleSlides, deck, plansBySlide) === 'content')
        .map(pptxSlideBackgroundColor)
      : [];
  const contentColorCounts = new Map();
  for (const color of contentColors) {
    contentColorCounts.set(color, (contentColorCounts.get(color) || 0) + 1);
  }
  const dominantContentCount = Math.max(0, ...contentColorCounts.values());
  if (contentColors.length && dominantContentCount / contentColors.length < 0.75) {
    issues.push(designIssue(
      'theme_body_backgrounds',
      '/',
      'Content slides use multiple background colors instead of one dominant canvas.',
    ));
  }
}


function comColorHex(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '';
  const blue = Math.floor(number / 65_536) % 256;
  const green = Math.floor(number / 256) % 256;
  const red = number % 256;
  return [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
}


function shapeFontFamilies(shape) {
  const names = Array.isArray(shape.fonts) ? shape.fonts : [shape.font?.name];
  return [...new Set(names.map(fontFamilyKey).filter(Boolean))];
}


function shapeColors(shape) {
  if (Array.isArray(shape.colors)) return shape.colors;
  return [comColorHex(shape.font?.color), comColorHex(shape.fill?.color)].filter(Boolean);
}


// Fonts and colors are read straight from the saved shapes, so a deck that
// slipped past authoring (template edits, add_textbox, COM sessions) still
// answers to the same discipline as an authored scene.
function reviewPptxDiscipline(slides, design, issues) {
  const unsafe = new Map();
  const deckColors = new Set();
  for (const slide of slides) {
    const families = new Set();
    for (const shape of Array.isArray(slide.shapes) ? slide.shapes : []) {
      if (!String(shape.text || '').trim()) continue;
      for (const family of shapeFontFamilies(shape)) {
        families.add(family);
        if (!isSafeFontFamily(family)) unsafe.set(family, (unsafe.get(family) || 0) + 1);
      }
      for (const color of shapeColors(shape)) deckColors.add(String(color).toUpperCase());
    }
    if (families.size > MAX_FONT_FAMILIES_PER_SLIDE) {
      issues.push(designIssue(
        'font_family_overuse',
        `/slide[${slide.index}]`,
        `Slide mixes ${families.size} font families (${[...families].join(', ')}); keep display, body, and data only.`,
      ));
    }
  }
  const scratch = !design.deck || design.deck.templateMode === 'scratch';
  if (unsafe.size && scratch && !design.review.allowUnsafeFonts) {
    issues.push(designIssue(
      'unsafe_font_family',
      '/',
      `Deck uses fonts that substitute unpredictably or are missing on older Office installs: ${[...unsafe.keys()].join(', ')}. Use ${design.tokens.typography.display}, ${design.tokens.typography.body}, or ${design.tokens.typography.data}.`,
    ));
  }
  const hueFamilies = saturatedHueFamilies([...deckColors]);
  if (hueFamilies.length > MAX_ACCENT_HUE_FAMILIES) {
    issues.push(designIssue(
      'accent_hue_overuse',
      '/',
      `Deck spreads saturated color across ${hueFamilies.length} hue families; keep one dominant accent and at most one secondary.`,
    ));
  }
}


// Shape kind arrives in two vocabularies: Microsoft Office reports integer
// MsoShapeType values while the portable backend reports the OOXML element name.
// Every rule below reads through these helpers so both backends agree.
function isPictureShape(shape) {
  return Number(shape.type) === 13 || shape.type === 'p:pic';
}


function isAutoShape(shape) {
  return Number(shape.type) === 1 || shape.type === 'p:sp';
}


function normalizedShapeSignature(slide) {
  return (slide.shapes || [])
    .filter((shape) => String(shape.text || '').trim())
    .map((shape) => [
      String(shape.type ?? ''),
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
  reviewPptxTheme(document, design, issues);
  reviewPptxDiscipline(slides, design, issues);
  let cardGridSlides = 0;
  const signatures = new Map();
  let nativeEvidenceSlides = 0;
  for (const slide of slides) {
    const shapes = (Array.isArray(slide.shapes) ? slide.shapes : []).filter((shape) => !isMotifShape(shape));
    const textShapes = shapes.filter((shape) => String(shape.text || '').trim());
    const pictures = shapes.filter(isPictureShape);
    const richVisuals = shapes.filter((shape) => shape.chart || shape.table || shape.group);
    const nonTextShapes = shapes.filter((shape) => !String(shape.text || '').trim() && !shape.placeholder);
    const typographicVisual = textShapes.some((shape) => Number(shape.font?.size) >= 42)
      || textShapes.filter((shape) => Number(shape.font?.size) >= 34).length >= 2;
    const semanticVisual = String(plansBySlide.get(Number(slide.index))?.visualType || '');
    const inferredDiagram = nonTextShapes.length >= 2
      && nonTextShapes.length <= 8
      && textShapes.length >= 4;
    const purposefulDiagram = (
      ['comparison', 'diagram', 'matrix', 'process', 'table'].includes(semanticVisual)
      && nonTextShapes.length > 0
    ) || inferredDiagram;
    if (
      pictures.length
      || shapes.some((shape) => shape.chart || shape.table)
      || purposefulDiagram
    ) nativeEvidenceSlides += 1;
    // The opening slide is a cover and never owes a chart or table. Treating a
    // short deck as all-content flagged its own cover for missing evidence, a
    // demand no author can satisfy without wrecking the cover.
    const contentSlide = slide.index !== 1
      && !(slides.length >= 3 && slide.index === slides.length);
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
    const rectangularText = textShapes.filter(isAutoShape);
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
  const contentCount = slides.length >= 3 ? slides.length - 2 : Math.max(0, slides.length - 1);
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
  issues.push(...reviewPptxDeckDiversity({ document, design }));
  issues.push(...reviewPptxFrontierQuality({ document, design }));
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
