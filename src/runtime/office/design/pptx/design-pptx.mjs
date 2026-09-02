import { hex, metricDisplayValue, provenanceText, strings } from '../design-tokens.mjs';
import { expandExecutivePptxSlide } from './design-pptx-executive.mjs';
import {
  balancedPptTitle,
  pptBodyParagraphs,
  pptBulletParagraphs,
  pptShape,
  pptText,
  pptTitleSize,
} from './design-pptx-primitives.mjs';
import { plainObject } from '../../shared/values.mjs';

const PPTX_VISUAL_TYPES = new Set(['statement', 'typography', 'comparison', 'process', 'metrics', 'chart', 'table', 'image', 'diagram', 'matrix']);

const PPTX_FOCAL_REGIONS = new Set(['full', 'left', 'right', 'center', 'top', 'bottom']);

export const PPTX_CRITIQUE_AXES = Object.freeze(['hierarchy', 'balance', 'legibility', 'cohesion', 'evidence']);


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


export function pptxBackgroundSpec(operation, design, kind, slide) {
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


export function pptxSlidePlan(operation, kind, slide) {
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


export function selectPptxLayout(operation, design, usage = new Map()) {
  if (design.deck?.templateMode === 'scratch') return null;
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
  const ranked = viable;
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
  if (role === 'subtitle') return operation.subtitle ?? operation.takeaway;
  if (role === 'takeaway') return operation.takeaway ?? operation.subtitle;
  if (role === 'eyebrow') return operation.eyebrow;
  if (role === 'body') return strings(operation.body || operation.bullets).join('\r') || operation.takeaway;
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


export function expandTemplatePptxSlide(operation, layout, slide, backend = '') {
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
  const vacantShapes = [];
  for (const slot of layout.slots || []) {
    if (slot.type === 'text') {
      const value = templateSlotText(operation, slot.role);
      if (value == null || String(value) === '') {
        vacantShapes.push(Number(slot.shape));
        continue;
      }
      output.push({
        op: 'set_text',
        slide,
        shape: Number(slot.shape),
        text: String(value),
      });
    } else if (slot.type === 'image') {
      if (!imagePath) {
        vacantShapes.push(Number(slot.shape));
        continue;
      }
      output.push({
        op: 'replace_image',
        slide,
        shape: Number(slot.shape),
        path: imagePath,
      });
    } else if (slot.type === 'chart' && plainObject(operation.chart)) {
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
  for (const shape of [...new Set(vacantShapes)].sort((left, right) => right - left)) {
    output.push({ op: 'delete_shape', slide, shape });
  }
  const source = provenanceText(operation.source);
  const notes = [String(operation.notes || '').trim(), source ? `Source: ${source}` : ''].filter(Boolean).join('\r\n');
  if (notes) output.push({ op: 'set_notes', slide, text: notes });
  return output;
}


export function coalesceCreatedPptxTemplateImports(operations) {
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


export function expandPptxSlide(operation, design, slide) {
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
  const executiveContent = expandExecutivePptxSlide(operation, design, slide, kind);

  if (executiveContent) {
    output.push(...executiveContent);
  } else if (kind === 'cover') {
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
    const showMetric = metric.value != null;
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
    const statementDetail = operation.bullets
      ? pptBulletParagraphs(operation.bullets, design, { size: 15 })
      : pptBodyParagraphs(operation.body, design, { size: 15 });
    if (statementDetail.length) {
      output.push(pptText(slide, '', {
        left: 58, top: subtitle ? 424 : 366, width: 650, height: 96,
      }, statementDetail));
    }
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
    const compactMetricStack = metrics.length >= 4;
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
        const top = primary
          ? 208
          : compactMetricStack
            ? 162 + ((index - 1) * 122)
            : 192 + ((index - 1) * 118);
        output.push(pptText(slide, metricDisplayValue(metric), {
          left, top, width: primary ? 392 : 320, height: primary ? 96 : compactMetricStack ? 54 : 62,
          fontName: type.display, fontSize: primary ? 58 : 40, bold: true,
          color: primary ? colors.accent : colors.ink,
        }));
        output.push(pptText(slide, String(metric.label || ''), {
          left,
          top: top + (primary ? 104 : compactMetricStack ? 60 : 58),
          width: primary ? 360 : 320,
          height: primary ? 32 : compactMetricStack ? 20 : 32,
          fontName: type.body, fontSize: 13, bold: true, color: colors.muted,
        }));
        if (metric.detail) output.push(pptText(slide, String(metric.detail), {
          left,
          top: top + (primary ? 148 : 86),
          width: primary ? 390 : 340,
          height: primary ? 38 : compactMetricStack ? 26 : 38,
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
    output.push(pptText(slide, operation.visualText ? balancedPptTitle(title) : title, {
      left: decisionFocus ? 120 : 58, top: 156, width: decisionFocus ? 720 : operation.visualText ? 650 : 760, height: 142,
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
