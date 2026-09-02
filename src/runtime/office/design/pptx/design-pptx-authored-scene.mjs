import {
  hex,
  provenanceText,
  strings,
} from '../design-tokens.mjs';
import { canvasSize, pptShape, pptText } from './design-pptx-primitives.mjs';
import { measuredTextHeight } from './design-pptx-stack.mjs';
import { clamp, plainObject } from '../../shared/values.mjs';

const SCENE_TYPES = new Set(['text', 'shape', 'line', 'image', 'chart', 'table']);
const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify']);
const VERTICAL_ALIGNMENTS = new Set(['top', 'middle', 'bottom']);
const MIN_FONT_SIZE = 12;
const MAX_ELEMENTS = 96;

function rounded(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sceneError(code, slide, message, details = {}) {
  const error = new Error(`AUTHORED_SCENE_${code} slide ${slide}: ${message}`);
  error.code = `AUTHORED_SCENE_${code}`;
  error.details = { slide, ...details };
  return error;
}

function rawBox(element) {
  if (Array.isArray(element.box) && element.box.length === 4) {
    return {
      left: element.box[0],
      top: element.box[1],
      width: element.box[2],
      height: element.box[3],
    };
  }
  return {
    left: element.x ?? element.left,
    top: element.y ?? element.top,
    width: element.w ?? element.width,
    height: element.h ?? element.height,
  };
}

function colorValue(value, design, fallback = '') {
  const requested = String(value || '').trim();
  if (!requested) return fallback;
  if (Object.hasOwn(design.tokens.colors, requested)) return design.tokens.colors[requested];
  return hex(requested, fallback);
}

function fontValue(value, design, fallback = 'body') {
  const requested = String(value || '').trim();
  if (requested && Object.hasOwn(design.tokens.typography, requested)) {
    return design.tokens.typography[requested];
  }
  return requested || design.tokens.typography[fallback] || design.tokens.typography.body;
}

function geometry(element) {
  return {
    left: element.left,
    top: element.top,
    width: element.width,
    height: element.height,
  };
}

function normalizeStyle(raw, type, design, slide, id) {
  const style = plainObject(raw) ? raw : {};
  const fontSize = Number(style.fontSize);
  if ((type === 'text' || (type === 'shape' && style.fontSize != null)) && fontSize < MIN_FONT_SIZE) {
    throw sceneError(
      'SMALL_FONT',
      slide,
      `Element "${id}" requests ${fontSize}pt text; authored scenes require at least ${MIN_FONT_SIZE}pt.`,
      { element: id, fontSize },
    );
  }
  return {
    fontName: fontValue(style.fontRole || style.fontName, design, style.display === true ? 'display' : 'body'),
    fontSize: clamp(fontSize || (style.display === true ? 34 : 16), MIN_FONT_SIZE, 96),
    color: colorValue(style.colorRole || style.color, design, design.tokens.colors.ink),
    bold: style.bold === true,
    italic: style.italic === true,
    alignment: ALIGNMENTS.has(String(style.align || style.alignment || '').toLowerCase())
      ? String(style.align || style.alignment).toLowerCase()
      : 'left',
    verticalAlignment: VERTICAL_ALIGNMENTS.has(String(style.verticalAlign || style.verticalAlignment || '').toLowerCase())
      ? String(style.verticalAlign || style.verticalAlignment).toLowerCase()
      : 'top',
    marginLeft: clamp(style.marginLeft ?? style.padding ?? 0, 0, 36),
    marginTop: clamp(style.marginTop ?? style.padding ?? 0, 0, 36),
    marginRight: clamp(style.marginRight ?? style.padding ?? 0, 0, 36),
    marginBottom: clamp(style.marginBottom ?? style.padding ?? 0, 0, 36),
    fillColor: colorValue(style.fillRole || style.fillColor, design, ''),
    lineColor: colorValue(style.lineRole || style.lineColor, design, ''),
    fillTransparency: clamp(style.fillTransparency ?? 0, 0, 100),
    lineTransparency: clamp(style.lineTransparency ?? 0, 0, 100),
    lineWidth: clamp(style.lineWidth ?? 1, 0.25, 12),
    rotation: clamp(style.rotation ?? 0, -360, 360),
    fit: ['contain', 'cover', 'stretch'].includes(String(style.fit || '').toLowerCase())
      ? String(style.fit).toLowerCase()
      : 'cover',
  };
}

function normalizeElement(raw, index, {
  units,
  canvas,
  safe,
  design,
  slide,
}) {
  if (!plainObject(raw)) {
    throw sceneError('INVALID_ELEMENT', slide, `Element ${index + 1} must be an object.`);
  }
  const type = String(raw.type || '').trim().toLowerCase();
  if (!SCENE_TYPES.has(type)) {
    throw sceneError(
      'UNKNOWN_TYPE',
      slide,
      `Element "${raw.id || index + 1}" uses unsupported type "${type}".`,
    );
  }
  const id = String(raw.id || `${type}-${index + 1}`).trim();
  const box = rawBox(raw);
  if (Object.values(box).some((value) => !Number.isFinite(Number(value)))) {
    throw sceneError('MISSING_GEOMETRY', slide, `Element "${id}" requires numeric x, y, w, h.`, { element: id });
  }
  if (Number(box.width) <= 0 || Number(box.height) <= 0) {
    throw sceneError('INVALID_GEOMETRY', slide, `Element "${id}" requires positive width and height.`, { element: id });
  }
  if (units === 'percent' && Object.values(box).some((value) => Math.abs(Number(value)) > 100)) {
    throw sceneError('INVALID_UNITS', slide, `Element "${id}" exceeds the 0-100 percent canvas.`, { element: id });
  }
  const scaleX = units === 'percent' ? canvas.width / 100 : 1;
  const scaleY = units === 'percent' ? canvas.height / 100 : 1;
  const normalized = {
    ...raw,
    id,
    type,
    role: String(raw.role || '').trim().toLowerCase(),
    layer: Number.isFinite(Number(raw.layer)) ? Number(raw.layer) : index,
    left: Number(box.left) * scaleX,
    top: Number(box.top) * scaleY,
    width: Number(box.width) * scaleX,
    height: Number(box.height) * scaleY,
  };
  const allowBleed = raw.allowBleed === true && ['shape', 'image'].includes(type);
  const bounds = allowBleed
    ? { left: 0, top: 0, right: canvas.width, bottom: canvas.height }
    : safe;
  if (
    normalized.left < bounds.left
    || normalized.top < bounds.top
    || normalized.left + normalized.width > bounds.right
    || normalized.top + normalized.height > bounds.bottom
  ) {
    throw sceneError(
      'OUT_OF_BOUNDS',
      slide,
      `Element "${id}" leaves the ${allowBleed ? 'canvas' : 'safe area'}; authored geometry is never silently moved.`,
      { element: id },
    );
  }
  normalized.style = normalizeStyle(raw.style, type, design, slide, id);
  if (type === 'text') {
    const text = String(raw.text || '');
    if (!text.trim()) throw sceneError('MISSING_TEXT', slide, `Text element "${id}" is empty.`, { element: id });
    const measured = measuredTextHeight(text, {
      fontName: normalized.style.fontName,
      fontSize: normalized.style.fontSize,
      bold: normalized.style.bold,
      width: Math.max(1, normalized.width - normalized.style.marginLeft - normalized.style.marginRight),
    });
    const available = normalized.height - normalized.style.marginTop - normalized.style.marginBottom;
    if (measured > available * 1.06) {
      throw sceneError(
        'TEXT_CAPACITY',
        slide,
        `Text element "${id}" needs about ${rounded(measured)}pt height but has ${rounded(available)}pt.`,
        { element: id, measured: rounded(measured), available: rounded(available) },
      );
    }
  }
  if (type === 'image' && !String(raw.path || '').trim()) {
    throw sceneError('MISSING_IMAGE', slide, `Image element "${id}" requires a path.`, { element: id });
  }
  if (type === 'chart' && !plainObject(raw.chart)) {
    throw sceneError('MISSING_CHART', slide, `Chart element "${id}" requires chart data.`, { element: id });
  }
  if (type === 'table' && !Array.isArray(raw.values || raw.table?.values)) {
    throw sceneError('MISSING_TABLE', slide, `Table element "${id}" requires values.`, { element: id });
  }
  return {
    ...normalized,
    left: rounded(normalized.left),
    top: rounded(normalized.top),
    width: rounded(normalized.width),
    height: rounded(normalized.height),
  };
}

export function hasPptxAuthoredScene(operation = {}) {
  return plainObject(operation?.plan?.authoredScene)
    && Array.isArray(operation.plan.authoredScene.elements);
}

export function normalizePptxAuthoredScene(operation, design, slide) {
  const source = operation?.plan?.authoredScene;
  if (!plainObject(source) || !Array.isArray(source.elements) || !source.elements.length) {
    throw sceneError('REQUIRED', slide, 'plan.authoredScene.elements is required.');
  }
  if (source.elements.length > MAX_ELEMENTS) {
    throw sceneError('TOO_MANY_ELEMENTS', slide, `A scene may contain at most ${MAX_ELEMENTS} native elements.`);
  }
  const units = String(source.units || operation?.plan?.units || 'percent').toLowerCase() === 'points'
    ? 'points'
    : 'percent';
  const canvas = canvasSize(design);
  const marginValue = Number(source.safeMargin ?? operation?.plan?.safeMargin ?? 4);
  const marginX = units === 'percent'
    ? clamp(marginValue, 0, 10) * canvas.width / 100
    : clamp(marginValue, 0, canvas.width * 0.1);
  const marginY = units === 'percent'
    ? clamp(marginValue, 0, 10) * canvas.height / 100
    : clamp(marginValue, 0, canvas.height * 0.1);
  const safe = {
    left: marginX,
    top: marginY,
    right: canvas.width - marginX,
    bottom: canvas.height - marginY,
  };
  const ids = new Set();
  const elements = source.elements.map((element, index) => {
    const normalized = normalizeElement(element, index, {
      units,
      canvas,
      safe,
      design,
      slide,
    });
    if (ids.has(normalized.id)) {
      throw sceneError('DUPLICATE_ELEMENT', slide, `Element id "${normalized.id}" is duplicated.`);
    }
    ids.add(normalized.id);
    return normalized;
  });
  if (!elements.some((element) => element.type === 'text' && element.role === 'title')) {
    throw sceneError('TITLE_REQUIRED', slide, 'Every authored scene requires one text element with role:"title".');
  }
  const kind = String(operation.kind || 'content').toLowerCase();
  if (
    !['cover', 'closing', 'statement'].includes(kind)
    && !elements.some((element) => (
      ['chart', 'table', 'image'].includes(element.type)
      || ['evidence', 'metric', 'visual'].includes(element.role)
    ))
  ) {
    throw sceneError('EVIDENCE_REQUIRED', slide, 'A content scene requires a chart, table, image, or evidence element.');
  }
  return {
    version: 1,
    contract: 'authored-scene-v1',
    units: 'points',
    canvas,
    safeArea: {
      left: rounded(safe.left),
      top: rounded(safe.top),
      right: rounded(safe.right),
      bottom: rounded(safe.bottom),
    },
    elementCount: elements.length,
    nativeElementCount: elements.length,
    elementTypes: [...new Set(elements.map((element) => element.type))],
    elements,
  };
}

function textOperation(element, slide) {
  return pptText(slide, element.text, {
    ...geometry(element),
    fontName: element.style.fontName,
    fontSize: element.style.fontSize,
    color: element.style.color,
    bold: element.style.bold,
    italic: element.style.italic,
    alignment: element.style.alignment,
    verticalAlignment: element.style.verticalAlignment,
    marginLeft: element.style.marginLeft,
    marginTop: element.style.marginTop,
    marginRight: element.style.marginRight,
    marginBottom: element.style.marginBottom,
    rotation: element.style.rotation,
  }, Array.isArray(element.paragraphs) ? element.paragraphs : null);
}

function shapeOperation(element, slide) {
  const shapeType = element.type === 'line'
    ? 'line'
    : String(element.shapeType || 'rectangle').toLowerCase();
  return pptShape(slide, shapeType, {
    ...geometry(element),
    fillColor: element.type === 'line' ? '' : element.style.fillColor,
    lineColor: element.style.lineColor || element.style.color,
    fillTransparency: element.style.fillTransparency,
    lineTransparency: element.style.lineTransparency,
    lineWidth: element.style.lineWidth,
    rotation: element.style.rotation,
    fontName: element.style.fontName,
    fontSize: element.style.fontSize,
    color: element.style.color,
    bold: element.style.bold,
    italic: element.style.italic,
    alignment: element.style.alignment,
    verticalAlignment: element.style.verticalAlignment,
    marginLeft: element.style.marginLeft,
    marginTop: element.style.marginTop,
    marginRight: element.style.marginRight,
    marginBottom: element.style.marginBottom,
  }, String(element.text || ''));
}

function chartOperation(element, design, slide) {
  const chart = element.chart;
  return {
    op: 'add_chart',
    slide,
    chartType: chart.type || chart.chartType || 'column',
    title: chart.title || '',
    categories: Array.isArray(chart.categories) ? chart.categories : [],
    series: Array.isArray(chart.series) ? chart.series.map((series, index) => ({
      ...series,
      color: series?.color || (
        index === 0
          ? design.tokens.colors.accent
          : index === 1
            ? design.tokens.colors.accent2
            : design.tokens.colors.muted
      ),
    })) : [],
    showValues: chart.showValues === true,
    showLegend: chart.showLegend === true,
    zeroBaseline: chart.zeroBaseline !== false,
    valueNumberFormat: chart.valueNumberFormat || '',
    dataLabelPosition: chart.dataLabelPosition || '',
    dataLabelColor: colorValue(chart.dataLabelColor, design, ''),
    ...geometry(element),
  };
}

function tableOperation(element, design, slide) {
  const table = plainObject(element.table) ? element.table : {};
  const values = Array.isArray(element.values) ? element.values : table.values;
  const rows = Math.max(1, values.length);
  return {
    op: 'add_table',
    slide,
    values,
    ...geometry(element),
    properties: {
      fontName: element.style.fontName,
      fontSize: element.style.fontSize,
      color: element.style.color,
      headerFillColor: colorValue(table.headerFillRole || table.headerFillColor, design, design.tokens.colors.inverse),
      headerColor: colorValue(table.headerColorRole || table.headerColor, design, design.tokens.colors.onInverse),
      bodyFillColor: colorValue(table.bodyFillRole || table.bodyFillColor, design, design.tokens.colors.surface),
      headerRowHeight: Math.min(38, Math.max(24, element.height / Math.max(2, rows + 0.5))),
      bodyRowHeight: rows > 1 ? Math.max(20, (element.height - 32) / (rows - 1)) : 0,
    },
  };
}

function elementOperation(element, design, slide) {
  if (element.type === 'text') return textOperation(element, slide);
  if (element.type === 'shape' || element.type === 'line') return shapeOperation(element, slide);
  if (element.type === 'image') {
    return {
      op: 'add_image',
      slide,
      path: element.path,
      fit: element.style.fit,
      focusX: Number(element.focusX) || 0.5,
      focusY: Number(element.focusY) || 0.5,
      ...geometry(element),
    };
  }
  if (element.type === 'chart') return chartOperation(element, design, slide);
  if (element.type === 'table') return tableOperation(element, design, slide);
  return null;
}

export function expandPptxAuthoredScene(operation, design, slide, backgroundSpec) {
  const scene = normalizePptxAuthoredScene(operation, design, slide);
  const operations = [];
  if (operation.create !== false) {
    operations.push({
      op: 'add_slide',
      ...(operation.index ? { index: Number(operation.index) } : {}),
      ...(operation.layout ? { layout: operation.layout } : {}),
    });
  }
  operations.push({
    op: 'set_slide_background',
    slide,
    color: backgroundSpec.color,
  });
  for (const element of [...scene.elements].sort((left, right) => left.layer - right.layer)) {
    const compiled = elementOperation(element, design, slide);
    if (compiled) operations.push(compiled);
  }
  const source = provenanceText(operation.source);
  const notes = [
    String(operation.notes || '').trim(),
    source ? `Source: ${source}` : '',
  ].filter(Boolean).join('\r\n');
  if (notes) operations.push({ op: 'set_notes', slide, text: notes });
  return {
    operations,
    plan: {
      ...operation.plan,
      slide,
      sourceContract: 'authored-scene-v1',
      source: 'model',
      units: 'points',
      authoredScene: scene,
      readingOrder: strings(operation.plan?.readingOrder).length
        ? strings(operation.plan.readingOrder)
        : scene.elements.map((element) => element.id),
      hierarchy: strings(operation.plan?.hierarchy).length
        ? strings(operation.plan.hierarchy)
        : scene.elements.map((element) => element.id),
      visualType: String(operation.plan?.visualType || 'authored-scene').toLowerCase(),
    },
  };
}
