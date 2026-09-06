import { xmlDecode } from './portable-xml.mjs';

const PREFIX = 'mixdog-relation:';
const ROLES = new Set(['value', 'label', 'table-cell', 'paragraph', 'object']);

// Standard shape names survive Office round-trips without custom XML parts.
// These declarations describe meaning; they never choose a layout.
export function relationOptions(relation) {
  if (!relation || !ROLES.has(relation.role) || !validId(relation.id)) {
    throw new Error('RELATE requires an id and role: value, label, table-cell, paragraph, or object');
  }
  const value = { id: relation.id, role: relation.role };
  for (const key of ['label', 'group', 'row', 'column']) {
    if (relation[key] == null) continue;
    if (!validId(String(relation[key]))) throw new Error(`RELATE ${key} must be a non-empty identifier of at most 100 characters`);
    value[key] = String(relation[key]);
  }
  return { objectName: PREFIX + encodeURIComponent(JSON.stringify(value)) };
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f]/.test(value);
}

export function shapeIdentity(xml) {
  const properties = /<p:cNvPr\b([^>]*)/.exec(xml)?.[1] || '';
  const name = xmlDecode(/\bname="([^"]*)"/.exec(properties)?.[1] || '');
  const shapeId = /\bid="([^"]*)"/.exec(properties)?.[1] || '';
  if (!name.startsWith(PREFIX)) return { shapeId };
  try {
    const relation = JSON.parse(decodeURIComponent(name.slice(PREFIX.length)));
    relationOptions(relation);
    return { shapeId, relation };
  } catch {
    return { shapeId, relationError: 'Invalid shape relationship declaration' };
  }
}

export function relationIndex(shapes) {
  const index = new Map();
  for (const shape of shapes) {
    const id = shape.relation?.id;
    if (id) index.set(id, index.has(id) ? null : shape);
  }
  return index;
}

export function independentTextUnit(box, shapes, index = relationIndex(shapes)) {
  const relation = box.relation;
  if (!relation || index.get(relation.id) !== box) return false;
  if (relation.role === 'value') return index.get(relation.label)?.relation?.role === 'label';
  if (relation.role === 'label') return shapes.some((shape) =>
    shape.relation?.role === 'value' && shape.relation.label === relation.id && index.get(shape.relation.id) === shape);
  if (relation.role === 'table-cell' && relation.group && relation.row && relation.column) {
    return shapes.some((shape) => shape !== box && shape.relation?.role === 'table-cell'
      && shape.relation.group === relation.group && shape.relation.row === relation.row
      && shape.relation.column && shape.relation.column !== relation.column);
  }
  return false;
}

export function rectangleGap(a, b) {
  return Math.hypot(
    Math.max(0, a.left - b.left - b.width, b.left - a.left - a.width),
    Math.max(0, a.top - b.top - b.height, b.top - a.top - a.height),
  );
}

export function reviewDeclaredRelations(shapes, maximumGap) {
  const index = relationIndex(shapes);
  const issues = [];
  for (const box of shapes) {
    const relation = box.relation;
    const path = `/slide[${box.slide}]/shape[${box.shape}]`;
    if (box.relationError || (relation && index.get(relation.id) === null)) {
      issues.push({ code: 'shape_relation_invalid', path, message: box.relationError || `Duplicate relationship id: ${relation.id}` });
    }
    if (relation?.role !== 'value') continue;
    const label = index.get(relation.label);
    if (!label || label.relation?.role !== 'label') {
      issues.push({ code: 'shape_relation_invalid', path, message: `Value ${relation.id} has no unique label ${relation.label || '(missing)'}.` });
      continue;
    }
    const gap = rectangleGap(box, label);
    if (gap > maximumGap) issues.push({
      code: 'stat_label_detached', path, confidence: 'declared',
      message: `Value ${relation.id} and its declared label ${relation.label} are ${Math.round(gap)}pt apart; review their association.`,
      gap: Math.round(gap), shapes: [box.shape, label.shape],
    });
  }
  return issues;
}
