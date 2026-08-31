import { createHash } from 'node:crypto';
import { TABULAR_FORMATS, stableJson } from './office-core.mjs';

export function documentSnapshotFingerprint(document) {
  return createHash('sha256').update(stableJson(document)).digest('hex');
}


function scalarState(value) {
  if (!value || typeof value !== 'object') return value;
  const state = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'path' || (item && typeof item === 'object')) continue;
    state[key] = item;
  }
  return state;
}


function documentPathIndex(document) {
  const entries = new Map();
  const visit = (value, fallback = '') => {
    if (!value || typeof value !== 'object') return;
    const path = typeof value.path === 'string' ? value.path : fallback;
    if (path) entries.set(path, scalarState(value));
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(document, '/');
  return entries;
}


export function diffDocuments(before, after, limit = 500) {
  const left = documentPathIndex(before);
  const right = documentPathIndex(after);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes = [];
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const path of paths) {
    const beforeValue = left.get(path);
    const afterValue = right.get(path);
    let kind = '';
    if (beforeValue === undefined) { kind = 'added'; added += 1; }
    else if (afterValue === undefined) { kind = 'removed'; removed += 1; }
    else if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) { kind = 'modified'; modified += 1; }
    if (kind && changes.length < limit) changes.push({ path, kind, before: beforeValue, after: afterValue });
  }
  const total = added + removed + modified;
  return {
    summary: { added, removed, modified, total },
    changes,
    truncated: total > changes.length,
  };
}


export function operationDocumentPaths(format, operation, result = {}) {
  const op = String(operation?.op || '');
  if (format === 'docx') {
    if (operation.paragraph) return [`/body/p[${Number(operation.paragraph)}]`];
    if (operation.table && operation.row && operation.col) return [`/body/tbl[${Number(operation.table)}]/row[${Number(operation.row)}]/cell[${Number(operation.col)}]`];
    if (operation.table && operation.row) return [`/body/tbl[${Number(operation.table)}]/row[${Number(operation.row)}]`];
    if (operation.table) return [`/body/tbl[${Number(operation.table)}]`];
    if (operation.comment) return [`/body/comment[${Number(operation.comment)}]`];
    if (operation.revision) return [`/body/revision[${Number(operation.revision)}]`];
    return ['/body'];
  }
  if (format === 'xlsx' || TABULAR_FORMATS.has(format)) {
    const sheet = String(operation.sheet || result.sheet || '');
    if (sheet && operation.cell) return [`/sheet[${sheet}]/cell[${String(operation.cell).toUpperCase()}]`];
    if (sheet && operation.range) return [`/sheet[${sheet}]/range[${String(operation.range).toUpperCase()}]`];
    if (sheet) return [`/sheet[${sheet}]`];
    if (op === 'add_sheet' && result.sheet) return [`/sheet[${String(result.sheet)}]`];
    if (operation.name) return [`/defined-name[${String(operation.name)}]`];
    return ['/'];
  }
  if (format === 'pptx') {
    const slide = Number(operation.slide || result.slide);
    const shape = Number(operation.shape);
    if (slide && shape) return [`/slide[${slide}]/shape[${shape}]`];
    if (slide) return [`/slide[${slide}]`];
    return ['/'];
  }
  if (format === 'pdf') {
    const pages = Array.isArray(operation.pages) ? operation.pages : operation.page ? [operation.page] : [];
    return pages.length ? pages.map((page) => `/page[${Number(page)}]`) : ['/'];
  }
  return ['/'];
}


export function operationChangeKind(operation) {
  const op = String(operation?.op || '');
  if (['delete_sheet', 'delete_slide', 'delete_shape', 'remove_paragraph', 'delete_pages'].includes(op)) return 'removed';
  if (op.startsWith('add_') || op.startsWith('append_') || op.startsWith('insert_') || op === 'duplicate_slide') return 'added';
  return 'modified';
}
