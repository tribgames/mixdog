import { normalizeOfficeContentModel, summarizeOfficeContentModel } from './content-model.mjs';
import { COMPOSE_OPERATION } from './design-creative-director.mjs';
import { clone, plainObject } from '../shared/values.mjs';

/** A profile or composer is an explicit request for a preset. Native operations
 *  otherwise carry the author's design; no automatic art direction is needed. */
export function usesNativeOfficeDesign(format, request = {}, operations = []) {
  if (!['docx', 'xlsx', 'pdf'].includes(format)) return false;
  if (typeof request === 'string' || request?.profile) return false;
  return !operations.some((operation) => operation?.op === COMPOSE_OPERATION[format]);
}

export function nativeOfficeDesign(format, request = {}) {
  const input = plainObject(request) ? request : {};
  return {
    authoring: 'native',
    source: 'author-specified',
    format,
    intent: String(input.intent || ''),
    audience: String(input.audience || ''),
    ...(input.palette ? { palette: clone(input.palette) } : {}),
    ...(input.typography ? { typography: clone(input.typography) } : {}),
    content: normalizeOfficeContentModel(input.content),
    review: { required: input.review !== false },
  };
}

export function nativeDesignReceipt(design) {
  return { ...design, content: summarizeOfficeContentModel(design.content) };
}
