/**
 * User → agent feedback from a visualize HTML pane: point-and-comment pins
 * and `data-choice` picks. The page half is plain ES5 text run inside the
 * pane (injected by main on the desktop, inlined into the srcdoc on a paired
 * remote client); it talks to the renderer only by `postMessage` with the
 * `__mixdogVisualize` tag, and redacts secret-looking values (password/token
 * fields, long tokens) before anything leaves the page.
 *
 * Trust: the page script shares its world with the page's own scripts, so
 * every page message is untrusted. A pin starts only from a trusted click on
 * the panel's own Comment layer over the pane: the panel asks the page to
 * describe the element under that point (`pick` with a one-time id) and the
 * note is typed into the panel's own box. The page never creates a pin.
 */

import {
  INSPECT_SHARED_SOURCE,
  type PageInspection,
  VISUALIZE_INSPECT_LIB_SOURCE,
  visualizePageInspection,
} from './visualize-inspect';
import {
  VISUALIZE_ARIA_ROLES,
  VISUALIZE_INPUT_ROLES,
  VISUALIZE_TAG_ROLES,
  type VisualizeElementRole,
  visualizeElementRole,
} from './visualize-comment-kinds';
import { withHeadScript } from './sandbox-storage-shim';
import { MAX_VISUALIZE_TWEAKS_CHARS, type VisualizeTweakOp } from './visualize-tweaks';

export const VISUALIZE_FEEDBACK_TAG = '__mixdogVisualize';
/** Hover, selection and pins share this one pink (panel CSS: --mx-visualize-pin). */
export const VISUALIZE_PIN_COLOR = '#ff3b6b';

export interface VisualizeFeedbackRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Rectangles (one set, for the panel and the gates) ────────────────────

export const sameRect = (a: VisualizeFeedbackRect, b: VisualizeFeedbackRect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** The overlap of two rectangles, or null under 1px either way. */
export function intersectRect(a: VisualizeFeedbackRect, b: VisualizeFeedbackRect): VisualizeFeedbackRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null;
}

/** A DOMRect-like box as a rectangle. */
export const rectOfBox = (box: {
  left: number;
  top: number;
  width: number;
  height: number;
}): VisualizeFeedbackRect => ({
  x: box.left,
  y: box.top,
  width: box.width,
  height: box.height,
});

/** The rectangle two points span. */
export const spanRect = (a: { x: number; y: number }, b: { x: number; y: number }): VisualizeFeedbackRect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

const unit = (value: number): number => Math.min(1, Math.max(0, value));

/** `rect` as fractions (0-1, clamped) of `frame`; both in one space. */
export function rectToFractions(rect: VisualizeFeedbackRect, frame: VisualizeFeedbackRect): VisualizeFeedbackRect {
  if (!frame.width || !frame.height) return { x: 0, y: 0, width: 0, height: 0 };
  const x = unit((rect.x - frame.x) / frame.width);
  const y = unit((rect.y - frame.y) / frame.height);
  return {
    x,
    y,
    width: Math.max(0, unit((rect.x + rect.width - frame.x) / frame.width) - x),
    height: Math.max(0, unit((rect.y + rect.height - frame.y) / frame.height) - y),
  };
}

/** Fractions of `frame` back in `frame`'s space. */
export const rectFromFractions = (
  rect: VisualizeFeedbackRect,
  frame: VisualizeFeedbackRect
): VisualizeFeedbackRect => ({
  x: frame.x + rect.x * frame.width,
  y: frame.y + rect.y * frame.height,
  width: rect.width * frame.width,
  height: rect.height * frame.height,
});

export const roundRect = (rect: VisualizeFeedbackRect, digits = 4): VisualizeFeedbackRect => {
  const round = (value: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
};

const UNIT_FRAME: VisualizeFeedbackRect = { x: 0, y: 0, width: 1, height: 1 };

/** A rectangle of fractions (0-1) clamped inside the unit square and
 *  rounded, or null when nothing of it is left. */
export function visualizeUnitRect(rect: VisualizeFeedbackRect): VisualizeFeedbackRect | null {
  const unitRect = roundRect(rectToFractions(rect, UNIT_FRAME));
  return unitRect.width > 0 && unitRect.height > 0 ? unitRect : null;
}

/** One element as the page names it: a selector, its kind and a short text. */
export interface VisualizePageNode {
  selector: string;
  role: VisualizeElementRole;
  name: string;
}

/** The element a pick landed on, as the page describes it. `box` is in page
 *  (document) CSS px; `view` and `masks` in the pane's viewport, for the
 *  crop. `masksOverflow`: the page reported more secret fields than can be
 *  masked (or no usable mask list), so no crop may be taken. `path`: its
 *  nearest ancestors, outermost first; `child`: its first visible child. */
export interface VisualizePagePick extends VisualizePageNode {
  html: string;
  styles: Record<string, string>;
  box: VisualizeFeedbackRect;
  view: VisualizeFeedbackRect;
  masks: VisualizeFeedbackRect[];
  masksOverflow: boolean;
  path: VisualizePageNode[];
  child: VisualizePageNode | null;
}

/** Where a dragged area lies in the page: the smallest element whose border
 *  box wholly holds it, the area as fractions (0-1) of that box, and the
 *  element's human path (its ancestors, then itself; empty for body/html). */
export interface VisualizePageAnchor {
  selector: string;
  rect: VisualizeFeedbackRect;
  path: VisualizePageNode[];
}

/** What lies in a dragged area of the page: how many elements sit wholly
 *  inside it (outermost only), the secret fields to mask in its crop, and
 *  the element it lies in (null: none holds it). */
export interface VisualizePageMeasure {
  count: number;
  masks: VisualizeFeedbackRect[];
  masksOverflow: boolean;
  anchor: VisualizePageAnchor | null;
}

/** A pin number the page draws: an element pin's on its element, or an
 *  anchored region's (`region`: its pin id and its area as fractions of the
 *  element's border box) on that area. */
export interface VisualizePageMarker {
  n: number;
  selector: string;
  region?: { pin: string; rect: VisualizeFeedbackRect };
}

/** Page → renderer. */
export type VisualizeFeedbackPageMessage =
  | { type: 'ready' }
  /** `pin`: the pick landed on that anchored region's number. */
  | { type: 'picked'; id: string; pick: VisualizePagePick; pin?: string }
  | ({ type: 'measured'; id: string } & VisualizePageMeasure)
  | { type: 'choice'; group: string; choice: string; label: string; selected: boolean }
  | { type: 'exit-comment' }
  /** The answer to `inspect` (screen reading: elements and layout findings). */
  | { type: 'inspected'; id: string; inspection: PageInspection | { error: string } }
  /** The page's mx-tweaks block text (null: it has none), sent once the page is ready. */
  | { type: 'tweaks'; raw: string | null };

/** Renderer → page. `choices` (the pane's queued picks) is sent only in
 *  answer to `ready`, so a reloaded page shows them again. Points are in the
 *  pane's viewport CSS px. */
export type VisualizeFeedbackParentMessage =
  | {
      type: 'state';
      comment: boolean;
      markers: VisualizePageMarker[];
      choices?: Array<{ group: string; choice: string }>;
      /** Element kind nouns in the UI language, for the hover label. */
      nouns?: Record<string, string>;
    }
  | { type: 'hover'; x: number; y: number }
  /** Move the hovered target to its parent (`up`) or back toward the point (`down`). */
  | { type: 'hover-step'; dir: 'up' | 'down' }
  | { type: 'pick'; id: string; x: number; y: number }
  /** The element a comment is being written for (null: none); `pin`: the
   *  anchored region it is written for. */
  | { type: 'select'; selector: string | null; pin?: string | null }
  /** Count and mask what lies in a viewport area; answered as `measured`. */
  | { type: 'measure'; id: string; rect: VisualizeFeedbackRect }
  /** Re-describe a pinned element (fresh box and secret-field masks) right
   *  before its crop; answered as `picked` with this id. */
  | { type: 'describe'; id: string; selector: string }
  /** Read the page (elements and layout findings); answered as `inspected`. */
  | { type: 'inspect'; id: string; selector?: string }
  /** Outline one element (the Elements list's hover); null clears it. */
  | { type: 'highlight'; selector: string | null }
  | { type: 'scroll'; dx: number; dy: number }
  /** Set (or, alue: null, remove) the tweak overrides on the page root. */
  | { type: 'tweaks'; ops: VisualizeTweakOp[] }
  /** The page's mx-tweaks block is malformed: the page logs it as a console error. */
  | { type: 'tweaks-problem'; reason: string }
  | { type: 'hide' }
  | { type: 'show' };

const MAX_SELECTOR = 1_000;
const MAX_LABEL = 120;
const MAX_NAME = 80;
const MAX_HTML = 600;
const MAX_STYLES = 16;
/** Ancestors a pick names (its crumbs). */
export const MAX_VISUALIZE_PATH = 4;
/** Most secret-field masks one crop carries; more and the crop is dropped. */
export const MAX_VISUALIZE_MASKS = 16;
const MAX_MEASURE_COUNT = 10_000;

/** Send `message` to a pane's page script. */
export function postToPage(
  frame: { readonly contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null },
  message: VisualizeFeedbackParentMessage
): void {
  frame.contentWindow?.postMessage({ ...message, [VISUALIZE_FEEDBACK_TAG]: 1 }, '*');
}

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function rect(value: unknown): VisualizeFeedbackRect {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    x: finite(raw.x),
    y: finite(raw.y),
    width: Math.max(0, finite(raw.width)),
    height: Math.max(0, finite(raw.height)),
  };
}

/** A page message, bounded and typed, or null. The page is project content,
 *  so nothing it sends is trusted beyond its shape. */
export function visualizeFeedbackPageMessage(value: unknown): VisualizeFeedbackPageMessage | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data[VISUALIZE_FEEDBACK_TAG] !== 1) return null;
  if (data.type === 'ready' || data.type === 'exit-comment') return { type: data.type };
  if (data.type === 'inspected') {
    const inspection = visualizePageInspection(data.inspection);
    const id = clip(data.id, 64);
    return inspection && id ? { type: 'inspected', id, inspection } : null;
  }
  if (data.type === 'tweaks') {
    return { type: 'tweaks', raw: typeof data.raw === 'string' ? data.raw.slice(0, MAX_VISUALIZE_TWEAKS_CHARS) : null };
  }
  if (data.type === 'choice') {
    const choice = clip(data.choice, MAX_LABEL);
    if (!choice) return null;
    return {
      type: 'choice',
      group: clip(data.group, MAX_LABEL),
      choice,
      label: clip(data.label, MAX_LABEL),
      selected: data.selected === true,
    };
  }
  if (data.type === 'measured') {
    const id = clip(data.id, 64);
    if (!id) return null;
    const count = typeof data.count === 'number' && Number.isFinite(data.count) ? Math.round(data.count) : 0;
    return {
      type: 'measured',
      id,
      count: Math.min(MAX_MEASURE_COUNT, Math.max(0, count)),
      ...maskList(data),
      anchor: pageAnchor(data.anchor),
    };
  }
  if (data.type !== 'picked' || !data.pick || typeof data.pick !== 'object') return null;
  const id = clip(data.id, 64);
  const pick = data.pick as Record<string, unknown>;
  const node = pageNode(pick);
  if (!id || !node) return null;
  const styles: Record<string, string> = {};
  if (pick.styles && typeof pick.styles === 'object') {
    for (const [key, style] of Object.entries(pick.styles as Record<string, unknown>).slice(0, MAX_STYLES)) {
      if (/^[a-z-]{1,40}$/.test(key) && typeof style === 'string' && style) styles[key] = style.slice(0, MAX_LABEL);
    }
  }
  const pin = clip(data.pin, 64);
  return {
    type: 'picked',
    id,
    ...(pin ? { pin } : {}),
    pick: {
      ...node,
      html: clip(pick.html, MAX_HTML),
      styles,
      box: rect(pick.box),
      view: rect(pick.view),
      ...maskList(pick),
      path: pageNodes(pick.path, MAX_VISUALIZE_PATH),
      child: pageNode(pick.child),
    },
  };
}

function pageNode(value: unknown): VisualizePageNode | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const selector = clip(raw.selector, MAX_SELECTOR);
  return selector ? { selector, role: visualizeElementRole(raw.role), name: clip(raw.name, MAX_NAME) } : null;
}

function pageNodes(value: unknown, max: number): VisualizePageNode[] {
  const nodes = Array.isArray(value) ? value.slice(-max).map(pageNode) : [];
  return nodes.every((node) => node !== null) ? (nodes as VisualizePageNode[]) : [];
}

function pageAnchor(value: unknown): VisualizePageAnchor | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const selector = clip(raw.selector, MAX_SELECTOR);
  const area = raw.rect && typeof raw.rect === 'object' ? (raw.rect as Record<string, unknown>) : {};
  const numbers = [area.x, area.y, area.width, area.height];
  if (!selector || !numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const rect = visualizeUnitRect(area as unknown as VisualizeFeedbackRect);
  return rect ? { selector, rect, path: pageNodes(raw.path, MAX_VISUALIZE_PATH + 1) } : null;
}

/** Fail closed: a crop is only ever taken with every secret field masked. */
function maskList(raw: Record<string, unknown>): { masks: VisualizeFeedbackRect[]; masksOverflow: boolean } {
  const masks = Array.isArray(raw.masks) ? raw.masks : null;
  const masksOverflow = raw.masksOverflow === true || !masks || masks.length > MAX_VISUALIZE_MASKS;
  return { masks: masksOverflow ? [] : (masks ?? []).map(rect), masksOverflow };
}

// Plain ES5 (no bundler helpers may leak into the page). `target` is the
// window feedback goes to: the panel's renderer.
const FEEDBACK_SOURCE = String.raw`(function (target) {
  var KEY = '__mixdogVisualizeFeedback';
  var TAG = '__mixdogVisualize';
  var MAX_MASKS = ${MAX_VISUALIZE_MASKS};
  var MAX_PATH = ${MAX_VISUALIZE_PATH};
  var MAX_WALK = 4000;
  var TAG_ROLES = ${JSON.stringify(VISUALIZE_TAG_ROLES)};
  var INPUT_ROLES = ${JSON.stringify(VISUALIZE_INPUT_ROLES)};
  var ARIA_ROLES = ${JSON.stringify(VISUALIZE_ARIA_ROLES)};
  var PIN = '${VISUALIZE_PIN_COLOR}';
  var PIN_RGB = '${hexRgb(VISUALIZE_PIN_COLOR)}';
  if (!target || target === window) return false;
  if (window[KEY]) return true;
  var api = {};
  window[KEY] = api;
  // hover: the element under the point; lifted: the hover target after
  // Alt+Up/Down (hover or one of its ancestors); badges: drawn pin numbers.
  // selectedPin: the anchored region a comment is being written for.
  var state = { comment: false, markers: [], hover: null, lifted: null, selected: null, selectedPin: null, focus: null, nouns: {}, badges: [], frame: 0, hideTimer: 0 };

  ${INSPECT_SHARED_SOURCE}
  var inspector = ${VISUALIZE_INSPECT_LIB_SOURCE};
  var STYLE_KEYS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'border-radius'];

  function secretFieldsIn(node) {
    var list = secretField(node) ? [node] : [];
    var inner = node.querySelectorAll ? node.querySelectorAll('input, textarea') : [];
    for (var i = 0; i < inner.length; i++) if (secretField(inner[i])) list.push(inner[i]);
    return list;
  }
  function htmlOf(node) {
    var clone = node.cloneNode(true);
    var own = clone.querySelectorAll ? clone.querySelectorAll('mixdog-visualize-feedback, mixdog-visualize-marks') : [];
    for (var d = 0; d < own.length; d++) own[d].parentNode.removeChild(own[d]);
    var fields = secretFieldsIn(clone);
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].hasAttribute('value')) fields[i].setAttribute('value', '[redacted]');
      if (fields[i].tagName.toLowerCase() === 'textarea') fields[i].textContent = '[redacted]';
    }
    return cut(redact(clone.outerHTML || '').replace(/\s+/g, ' ').trim(), 600);
  }
  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }
  function uniqueId(node) {
    var id = node.getAttribute('id');
    if (!id) return '';
    var selector = '#' + escapeIdent(id);
    try { return document.querySelectorAll(selector).length === 1 ? selector : ''; } catch (error) { return ''; }
  }
  function selectorFor(node) {
    var parts = [];
    for (var current = node; current && current.nodeType === 1; current = current.parentElement) {
      var id = uniqueId(current);
      if (id) { parts.unshift(id); break; }
      var tag = current.tagName.toLowerCase();
      var part = tag;
      var parent = current.parentElement;
      if (parent && tag !== 'html' && tag !== 'body') {
        var count = 0;
        var index = 0;
        for (var sibling = parent.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
          if (sibling.tagName === current.tagName) {
            count += 1;
            if (sibling === current) index = count;
          }
        }
        if (count > 1) part += ':nth-of-type(' + index + ')';
      }
      parts.unshift(part);
      if (tag === 'body' || tag === 'html') break;
    }
    return parts.join(' > ');
  }
  function own(table, key) { return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : ''; }
  function roleOf(node) {
    var aria = own(ARIA_ROLES, String(node.getAttribute('role') || '').toLowerCase().split(/\s+/)[0]);
    if (aria) return aria;
    var tag = node.tagName.toLowerCase();
    if (tag === 'input') {
      var typed = own(INPUT_ROLES, String(node.getAttribute('type') || '').toLowerCase());
      if (typed) return typed;
    }
    return own(TAG_ROLES, tag) || 'box';
  }
  // The element's text without what a secret field inside it holds (the
  // fields htmlOf redacts) or the overlay; enough of it for a name.
  function textOf(node) {
    var out = '';
    var stack = [node];
    while (stack.length && out.length < 400) {
      var current = stack.pop();
      if (current.nodeType === 3) { out += current.nodeValue; continue; }
      if (current.nodeType !== 1 || current === host || secretField(current)) continue;
      var tag = current.tagName.toLowerCase();
      if (tag === 'mixdog-visualize-feedback' || tag === 'mixdog-visualize-marks') continue;
      for (var child = current.lastChild; child; child = child.previousSibling) stack.push(child);
    }
    return out;
  }
  // A short human text for the element; never a field's value.
  function nameOf(node) {
    if (secretField(node)) return '';
    var tag = node.tagName.toLowerCase();
    var field = tag === 'input' || tag === 'textarea' || tag === 'select';
    var text = node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title') ||
      (field ? node.getAttribute('placeholder') || '' : textOf(node));
    return cut(redact(String(text).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')), 40);
  }
  function nodeInfo(node) { return { selector: selectorFor(node), role: roleOf(node), name: nameOf(node) }; }
  function ancestorOf(node) {
    var up = node && node.parentElement;
    return up && up !== document.body && up !== document.documentElement ? up : null;
  }
  function pathOf(node) {
    var list = [];
    for (var up = ancestorOf(node); up && list.length < MAX_PATH; up = ancestorOf(up)) list.unshift(nodeInfo(up));
    return list;
  }
  function visibleChild(node) {
    for (var child = node.firstElementChild; child; child = child.nextElementSibling) {
      if (child === host) continue;
      var r = child.getBoundingClientRect();
      if (r.width && r.height) return child;
    }
    return null;
  }
  function stylesOf(node) {
    var out = {};
    var computed = window.getComputedStyle ? window.getComputedStyle(node) : null;
    if (!computed) return out;
    for (var i = 0; i < STYLE_KEYS.length; i++) {
      var value = computed.getPropertyValue(STYLE_KEYS[i]);
      if (value) out[STYLE_KEYS[i]] = cut(redact(value), 120);
    }
    return out;
  }
  function rectOf(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  function describe(node) {
    var view = rectOf(node);
    var masks = [];
    var fields = secretFieldsIn(node);
    for (var i = 0; i < fields.length; i++) {
      var mask = rectOf(fields[i]);
      if (mask.width && mask.height) masks.push(mask);
    }
    // More secret fields than masks: report none, and the panel takes no crop.
    var overflow = masks.length > MAX_MASKS;
    var child = visibleChild(node);
    return {
      selector: selectorFor(node),
      role: roleOf(node),
      name: nameOf(node),
      path: pathOf(node),
      child: child ? nodeInfo(child) : null,
      html: htmlOf(node),
      styles: stylesOf(node),
      box: {
        x: Math.round(view.x + (window.scrollX || 0)),
        y: Math.round(view.y + (window.scrollY || 0)),
        width: Math.round(view.width),
        height: Math.round(view.height)
      },
      view: view,
      masks: overflow ? [] : masks,
      masksOverflow: overflow
    };
  }
  // A dragged area (viewport px): the outermost elements wholly inside it,
  // and every secret field it touches.
  function measure(area) {
    var right = area.x + area.width;
    var bottom = area.y + area.height;
    var count = 0;
    var walked = 0;
    var stack = document.body ? [document.body] : [];
    while (stack.length && walked < MAX_WALK) {
      var node = stack.pop();
      for (var child = node.lastElementChild; child; child = child.previousElementSibling) {
        if (child === host) continue;
        walked += 1;
        var r = child.getBoundingClientRect();
        if (r.width && r.height && r.left >= area.x && r.top >= area.y && r.right <= right && r.bottom <= bottom) count += 1;
        else stack.push(child);
      }
    }
    var masks = [];
    var fields = document.querySelectorAll('input, textarea');
    for (var i = 0; i < fields.length; i++) {
      if (!secretField(fields[i])) continue;
      var m = rectOf(fields[i]);
      if (m.width && m.height && m.x < right && m.y < bottom && m.x + m.width > area.x && m.y + m.height > area.y) masks.push(m);
    }
    var overflow = masks.length > MAX_MASKS;
    return { count: count, masks: overflow ? [] : masks, masksOverflow: overflow, anchor: anchorOf(area) };
  }
  function fraction(value) { return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000; }
  // The smallest element whose border box wholly holds a dragged area (body
  // and html included, the overlay never), and the area as fractions of
  // that box: the page draws the region from it, so it follows scroll and
  // reflow.
  function anchorOf(area) {
    var right = area.x + area.width;
    var bottom = area.y + area.height;
    var best = null;
    var bestBox = null;
    var walked = 0;
    var stack = [document.documentElement];
    while (stack.length && walked < MAX_WALK) {
      var node = stack.pop();
      walked += 1;
      var r = node.getBoundingClientRect();
      // Parents come before their children: an equal box goes to the child.
      if (r.width && r.height && r.left <= area.x && r.top <= area.y && r.right >= right && r.bottom >= bottom &&
        (!bestBox || r.width * r.height <= bestBox.width * bestBox.height)) {
        best = node;
        bestBox = r;
      }
      for (var child = node.lastElementChild; child; child = child.previousElementSibling) {
        var tag = child.tagName.toLowerCase();
        if (child !== host && tag !== 'mixdog-visualize-feedback' && tag !== 'mixdog-visualize-marks') stack.push(child);
      }
    }
    if (!best) return null;
    var root = best === document.body || best === document.documentElement;
    return {
      selector: selectorFor(best),
      rect: {
        x: fraction((area.x - bestBox.left) / bestBox.width),
        y: fraction((area.y - bestBox.top) / bestBox.height),
        width: fraction(area.width / bestBox.width),
        height: fraction(area.height / bestBox.height)
      },
      path: root ? [] : pathOf(best).concat([nodeInfo(best)])
    };
  }
  function post(message) {
    message[TAG] = 1;
    try { target.postMessage(message, '*'); } catch (error) {}
  }

  var host = document.createElement('mixdog-visualize-feedback');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
  var root = host.attachShadow({ mode: 'closed' });
  // Constructed sheets first: a page CSP without 'unsafe-inline' styles
  // blocks a <style> element (and would report it), not the CSSOM.
  function addSheet(owner, css, before) {
    if (window.CSSStyleSheet && 'adoptedStyleSheets' in owner) {
      try {
        var constructed = new CSSStyleSheet();
        constructed.replaceSync(css);
        var adopted = Array.prototype.slice.call(owner.adoptedStyleSheets);
        owner.adoptedStyleSheets = before ? [constructed].concat(adopted) : adopted.concat([constructed]);
        return;
      } catch (error) {}
    }
    var element = document.createElement('style');
    element.setAttribute('data-mixdog-visualize', '');
    element.textContent = css;
    var parent = owner === document ? (document.head || document.documentElement) : owner;
    parent.insertBefore(element, before ? parent.firstChild : null);
  }
  addSheet(root, '.box{position:fixed;box-sizing:border-box;border-radius:3px;pointer-events:none}' +
    // Saved pins: the full pin colour with a light halo, for contrast on any
    // picture; hover and selected stay stronger (the panel's region boxes match).
    '.pin{outline:1.5px solid ' + PIN + ';outline-offset:1px;box-shadow:0 0 0 1px rgba(255,255,255,.55)}' +
    '.hover{outline:2px solid ' + PIN + ';outline-offset:1px;box-shadow:0 0 0 1px rgba(255,255,255,.55);background:rgba(' + PIN_RGB + ',.1)}' +
    '.sel{outline:2px solid ' + PIN + ';outline-offset:1px;box-shadow:0 0 0 5px rgba(' + PIN_RGB + ',.22)}' +
    '.num{position:fixed;min-width:20px;height:20px;padding:0 4px;box-sizing:border-box;border:2px solid #fff;border-radius:10px;background:' + PIN + ';color:#fff;font:700 11px/16px system-ui,-apple-system,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.35);pointer-events:none}' +
    '.tag{position:fixed;max-width:min(360px,calc(100vw - 16px));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box;padding:3px 8px;border-radius:6px;background:#18181b;color:#f2f2f2;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none}' +
    '.tag em{font-style:normal;color:#a8a8a8;margin-left:6px;font-variant-numeric:tabular-nums}', false);
  var layer = document.createElement('div');
  root.appendChild(layer);

  function find(selector) {
    try { return document.querySelector(selector); } catch (error) { return null; }
  }
  function addBox(r, className) {
    var box = document.createElement('div');
    box.className = 'box ' + className;
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    layer.appendChild(box);
  }
  function addNumber(r, n, selector, pin) {
    var badge = document.createElement('div');
    badge.className = 'num';
    badge.textContent = String(n);
    var left = Math.max(2, r.left - 10);
    var top = Math.max(2, r.top - 10);
    badge.style.left = left + 'px';
    badge.style.top = top + 'px';
    layer.appendChild(badge);
    state.badges.push({ selector: selector, pin: pin || '', left: left, top: top });
  }
  // An anchored region's box now: its fractions of the element's live box.
  function regionBox(r, area) {
    if (!area || typeof area !== 'object') return null;
    var numbers = [area.x, area.y, area.width, area.height];
    for (var i = 0; i < numbers.length; i++) if (typeof numbers[i] !== 'number' || !isFinite(numbers[i])) return null;
    return { left: r.left + area.x * r.width, top: r.top + area.y * r.height, width: area.width * r.width, height: area.height * r.height };
  }
  // "Button · Save  120×32" under the hovered element (above it near the bottom).
  function addTag(node, r) {
    var info = nodeInfo(node);
    var noun = typeof state.nouns[info.role] === 'string' ? cut(state.nouns[info.role], 40) : info.role;
    var tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = info.name ? noun + ' \u00b7 ' + info.name : noun;
    var size = document.createElement('em');
    size.textContent = Math.round(r.width) + '\u00d7' + Math.round(r.height);
    tag.appendChild(size);
    tag.style.left = Math.max(4, r.left) + 'px';
    var below = r.bottom + 6;
    tag.style.top = (below + 26 > window.innerHeight ? Math.max(4, r.top - 30) : below) + 'px';
    layer.appendChild(tag);
  }
  function draw() {
    state.frame = 0;
    state.badges = [];
    if (!host.isConnected) document.documentElement.appendChild(host);
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    var selected = state.comment && state.selected ? find(state.selected) : null;
    for (var i = 0; i < state.markers.length; i++) {
      var marker = state.markers[i];
      var node = marker && typeof marker.selector === 'string' ? find(marker.selector) : null;
      if (!node) continue;
      var r = node.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (marker.region && typeof marker.region === 'object') {
        var pin = typeof marker.region.pin === 'string' ? marker.region.pin : '';
        var area = regionBox(r, marker.region.rect);
        if (!pin || !area) continue;
        addBox(area, state.comment && pin === state.selectedPin ? 'sel' : 'pin');
        addNumber(area, marker.n, marker.selector, pin);
        continue;
      }
      if (node !== selected) addBox(r, 'pin');
      addNumber(r, marker.n, marker.selector);
    }
    if (selected) addBox(selected.getBoundingClientRect(), 'sel');
    var hovered = state.comment && !selected && state.lifted && state.lifted.isConnected ? state.lifted : null;
    if (hovered) {
      var h = hovered.getBoundingClientRect();
      addBox(h, 'hover');
      addTag(hovered, h);
    }
    // The panel's Elements list points at one element.
    if (state.focus && state.focus.isConnected) addBox(state.focus.getBoundingClientRect(), 'hover');
  }
  // A pin number under the point (a click there reopens the pin).
  function badgeAt(x, y) {
    for (var i = state.badges.length - 1; i >= 0; i--) {
      var b = state.badges[i];
      if (x >= b.left && x <= b.left + 20 && y >= b.top && y <= b.top + 20) return b;
    }
    return null;
  }
  function schedule() {
    if (!state.frame) state.frame = requestAnimationFrame(draw);
  }
  function show() {
    clearTimeout(state.hideTimer);
    host.style.visibility = '';
    schedule();
  }
  function elementAt(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || !document.elementFromPoint) return null;
    var node = document.elementFromPoint(x, y);
    return node && node.nodeType === 1 && node !== host && node !== document.documentElement ? node : null;
  }

  // Tweaks: the page reports its 'mx-tweaks' block; the panel parses it and
  // sends back the root overrides to set. Names are re-checked here.
  function readTweaks() {
    var node = document.getElementById('mx-tweaks');
    if (!node || node.tagName.toLowerCase() !== 'script') return null;
    return String(node.textContent || '').slice(0, 20000);
  }
  var tweakOriginals = {};
  function applyTweaks(ops) {
    if (!Array.isArray(ops)) return;
    var root = document.documentElement;
    for (var i = 0; i < ops.length && i < 16; i++) {
      var op = ops[i];
      if (!op || typeof op !== 'object') continue;
      var value = typeof op.value === 'string' ? op.value.slice(0, 80) : null;
      if (typeof op.var === 'string' && /^--[a-z0-9-]{1,40}$/.test(op.var)) {
        if (value === null) root.style.removeProperty(op.var);
        else root.style.setProperty(op.var, value);
      } else if (typeof op.attr === 'string' && /^data-[a-z0-9-]{1,40}$/.test(op.attr)) {
        if (!(op.attr in tweakOriginals)) tweakOriginals[op.attr] = root.getAttribute(op.attr);
        var original = tweakOriginals[op.attr];
        var next = value === null ? original : value;
        if (next === null) root.removeAttribute(op.attr);
        else root.setAttribute(op.attr, next);
      }
    }
  }

  function groupOf(node) { return cut(redact(node.getAttribute('data-choice-group') || ''), 120); }
  function choiceOf(node) { return cut(redact(node.getAttribute('data-choice') || ''), 120); }
  function choiceLabel(node) {
    var text = node.getAttribute('data-choice-label') || node.getAttribute('aria-label') || node.textContent || '';
    return cut(redact(text.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')), 80);
  }
  function choose(start) {
    var node = start && start.closest ? start.closest('[data-choice]') : null;
    if (!node) return;
    var group = groupOf(node);
    var choice = choiceOf(node);
    if (!choice) return;
    var selected = !node.hasAttribute('data-choice-selected');
    var all = document.querySelectorAll('[data-choice]');
    for (var i = 0; i < all.length; i++) if (groupOf(all[i]) === group) all[i].removeAttribute('data-choice-selected');
    if (selected) node.setAttribute('data-choice-selected', '');
    post({ type: 'choice', group: group, choice: choice, label: choiceLabel(node), selected: selected });
  }
  function markChoices(list) {
    var all = document.querySelectorAll('[data-choice]');
    for (var i = 0; i < all.length; i++) {
      var on = false;
      for (var j = 0; j < list.length; j++) {
        if (list[j] && list[j].group === groupOf(all[i]) && list[j].choice === choiceOf(all[i])) on = true;
      }
      if (on) all[i].setAttribute('data-choice-selected', '');
      else all[i].removeAttribute('data-choice-selected');
    }
  }

  // Comment mode lays the panel's own layer over the pane, so a page click
  // here is always an ordinary click (a choice, or the page's own). The panel
  // takes a choice only with live user activation (visualize-feedback-gate).
  addEventListener('click', function (event) {
    if (!state.comment) choose(event.target);
  }, true);
  addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.comment) post({ type: 'exit-comment' });
  }, true);

  api.apply = function (message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'show') { show(); return; }
    if (message.type === 'hide') {
      host.style.visibility = 'hidden';
      clearTimeout(state.hideTimer);
      state.hideTimer = setTimeout(show, 3000);
      return;
    }
    if (message.type === 'hover') {
      var hovered = state.comment ? elementAt(message.x, message.y) : null;
      if (hovered !== state.hover) { state.hover = hovered; state.lifted = hovered; schedule(); }
      return;
    }
    if (message.type === 'hover-step') {
      if (!state.comment || !state.lifted) return;
      if (message.dir === 'up') {
        state.lifted = ancestorOf(state.lifted) || state.lifted;
      } else if (message.dir === 'down') {
        var down = null;
        if (state.hover && state.lifted !== state.hover && state.lifted.contains(state.hover)) {
          for (down = state.hover; down.parentElement !== state.lifted; down = down.parentElement) {}
        } else {
          down = visibleChild(state.lifted);
        }
        if (down) state.lifted = down;
      }
      schedule();
      return;
    }
    if (message.type === 'pick') {
      var at = elementAt(message.x, message.y);
      var badge = badgeAt(message.x, message.y);
      var badged = badge ? find(badge.selector) : null;
      var picked = badged ||
        (at && state.lifted && state.lifted.isConnected && state.lifted.contains(at) ? state.lifted : at);
      if (!picked || typeof message.id !== 'string') return;
      var answer = { type: 'picked', id: message.id, pick: describe(picked) };
      // An anchored region's number names its pin.
      if (badged && badge.pin) answer.pin = badge.pin;
      post(answer);
      return;
    }
    if (message.type === 'select') {
      state.selected = typeof message.selector === 'string' ? message.selector : null;
      state.selectedPin = typeof message.pin === 'string' ? message.pin : null;
      schedule();
      return;
    }
    if (message.type === 'measure') {
      var area = message.rect;
      if (typeof message.id !== 'string' || !area || typeof area !== 'object') return;
      var numbers = [area.x, area.y, area.width, area.height];
      for (var n = 0; n < numbers.length; n++) if (typeof numbers[n] !== 'number' || !isFinite(numbers[n])) return;
      var measured = measure(area);
      post({ type: 'measured', id: message.id, count: measured.count, masks: measured.masks, masksOverflow: measured.masksOverflow, anchor: measured.anchor });
      return;
    }
    if (message.type === 'highlight') {
      state.focus = typeof message.selector === 'string' ? find(message.selector) : null;
      schedule();
      return;
    }
    if (message.type === 'inspect') {
      if (typeof message.id !== 'string') return;
      var inspected;
      try { inspected = inspector.inspect({ selector: typeof message.selector === 'string' ? message.selector : '' }); } catch (error) { inspected = { error: 'the page could not be read' }; }
      post({ type: 'inspected', id: message.id, inspection: inspected });
      return;
    }
    if (message.type === 'describe') {
      var pinned = typeof message.selector === 'string' ? find(message.selector) : null;
      if (pinned && typeof message.id === 'string') post({ type: 'picked', id: message.id, pick: describe(pinned) });
      return;
    }
    if (message.type === 'tweaks') { applyTweaks(message.ops); return; }
    if (message.type === 'tweaks-problem') {
      if (typeof message.reason === 'string') console.error('tweaks: ' + message.reason.slice(0, 200));
      return;
    }
    if (message.type === 'scroll') {
      if (typeof message.dx === 'number' && typeof message.dy === 'number') window.scrollBy(message.dx, message.dy);
      return;
    }
    if (message.type !== 'state') return;
    state.comment = message.comment === true;
    if (!state.comment) { state.hover = null; state.lifted = null; }
    if (message.nouns && typeof message.nouns === 'object') state.nouns = message.nouns;
    state.markers = Array.isArray(message.markers) ? message.markers : [];
    if (Array.isArray(message.choices)) markChoices(message.choices);
    schedule();
  };
  addEventListener('message', function (event) {
    if (event.source !== target || !event.data || event.data[TAG] !== 1) return;
    api.apply(event.data);
  });

  function install() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    // The default selected look: zero specificity, so any mockup rule wins.
    addSheet(document, ':where([data-choice]){cursor:pointer}' +
      ':where([data-choice][data-choice-selected]){outline:2px solid #2f6feb;outline-offset:2px;box-shadow:0 0 0 5px rgba(47,111,235,.18)}', true);
    addEventListener('scroll', schedule, true);
    addEventListener('resize', schedule);
    if (window.MutationObserver) {
      new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    post({ type: 'ready' });
    post({ type: 'tweaks', raw: readTweaks() });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
  return true;
})`;

function hexRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
}

/** The page half, posting to `window.parent` (the panel's renderer). */
export function visualizeFeedbackScript(): string {
  return `(${FEEDBACK_SOURCE})(window.parent)`;
}

/** The page half for tests: posting to `targetExpression` instead. */
export function visualizeFeedbackScriptFor(targetExpression: string): string {
  return `(${FEEDBACK_SOURCE})(${targetExpression})`;
}

/** A remote pane's self-contained page with the page half inlined first in
 *  its head (the sandboxed frame runs inline scripts through the relay's
 *  /preview-frame page). */
export function withVisualizeFeedbackScript(html: string): string {
  return withHeadScript(html, visualizeFeedbackScript());
}
