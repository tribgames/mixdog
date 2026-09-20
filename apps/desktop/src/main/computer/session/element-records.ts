/**
 * Element records as the worker reports them, normalized into the shape the
 * host stores, and the alias targets a later command may name a mark by: a
 * semantic ref for UIA/MSAA elements, a frame-bound point for OCR words.
 */
import type { ChromeUiaAncestor } from '../../browser/chrome-uia';
import type { ComputerElementRecord, ElementAliasTarget } from '../shared/types';

/** An optional worker field: absent, null and '' all mean "not reported". */
function optionalText(value: unknown): string | undefined {
  return String(value || '') || undefined;
}

function normalizeAncestors(value: unknown): ChromeUiaAncestor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawAncestor) => {
    if (!rawAncestor || typeof rawAncestor !== 'object') return [];
    const ancestor = rawAncestor as Record<string, unknown>;
    return [
      {
        runtime_id: String(ancestor.runtime_id || ''),
        role: String(ancestor.role || ''),
        name: String(ancestor.name || ''),
      },
    ];
  });
}

export function normalizeElementRecords(value: unknown): ComputerElementRecord[] {
  if (!Array.isArray(value)) return [];
  const elements: ComputerElementRecord[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const mark = Number(row.mark);
    const ref = String(row.ref || '');
    if (!Number.isInteger(mark) || mark < 1 || !ref) continue;
    elements.push({
      mark,
      ref,
      source: row.source === 'msaa' ? 'msaa' : 'uia',
      role: String(row.role || ''),
      name: String(row.name || ''),
      value: String(row.value || ''),
      state: String(row.state || ''),
      enabled: row.enabled === true,
      x: Number(row.x) || 0,
      y: Number(row.y) || 0,
      width: Number(row.width) || 0,
      height: Number(row.height) || 0,
      center_x: Number(row.center_x) || 0,
      center_y: Number(row.center_y) || 0,
      actions: Array.isArray(row.actions) ? row.actions.map((action) => String(action)).filter(Boolean) : [],
      accelerator: optionalText(row.accelerator),
      access_key: optionalText(row.access_key),
      runtime_id: optionalText(row.runtime_id),
      parent_runtime_id: optionalText(row.parent_runtime_id),
      class_name: optionalText(row.class_name),
      has_keyboard_focus: row.has_keyboard_focus === true,
      in_document: row.in_document === true,
      ancestors: normalizeAncestors(row.ancestors),
    });
  }
  return elements;
}

/** The alias target behind each mark. An OCR word without a frame cannot be
 *  addressed again and is left out. */
export function elementTargetsFromRecords(elements: ComputerElementRecord[]): Map<number, ElementAliasTarget> {
  const targets = new Map<number, ElementAliasTarget>();
  for (const element of elements) {
    if (element.source === 'ocr') {
      if (!element.frame_id) continue;
      targets.set(element.mark, {
        kind: 'point',
        frameId: element.frame_id,
        windowId: element.window_id,
        x: element.center_x,
        y: element.center_y,
      });
    } else {
      targets.set(element.mark, {
        kind: 'ref',
        ref: element.ref,
        x: element.center_x,
        y: element.center_y,
      });
    }
  }
  return targets;
}
