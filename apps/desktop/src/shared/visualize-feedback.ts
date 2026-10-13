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
import { MAX_VISUALIZE_TWEAKS_CHARS, type VisualizeTweakOp } from './visualize-tweaks';

export const VISUALIZE_FEEDBACK_TAG = '__mixdogVisualize';

export interface VisualizeFeedbackRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The element a pick landed on, as the page describes it. `box` is in page
 *  (document) CSS px; `view` and `masks` in the pane's viewport, for the
 *  crop. `masksOverflow`: the page reported more secret fields than can be
 *  masked (or no usable mask list), so no crop may be taken. */
export interface VisualizePagePick {
  selector: string;
  label: string;
  html: string;
  styles: Record<string, string>;
  box: VisualizeFeedbackRect;
  view: VisualizeFeedbackRect;
  masks: VisualizeFeedbackRect[];
  masksOverflow: boolean;
}

/** Page → renderer. */
export type VisualizeFeedbackPageMessage =
  | { type: 'ready' }
  | { type: 'picked'; id: string; pick: VisualizePagePick }
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
      markers: Array<{ n: number; selector: string }>;
      choices?: Array<{ group: string; choice: string }>;
    }
  | { type: 'hover'; x: number; y: number }
  | { type: 'pick'; id: string; x: number; y: number }
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
const MAX_HTML = 600;
const MAX_STYLES = 16;
/** Most secret-field masks one crop carries; more and the crop is dropped. */
export const MAX_VISUALIZE_MASKS = 16;

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
  if (data.type !== 'picked' || !data.pick || typeof data.pick !== 'object') return null;
  const id = clip(data.id, 64);
  const pick = data.pick as Record<string, unknown>;
  const selector = clip(pick.selector, MAX_SELECTOR);
  if (!id || !selector) return null;
  const styles: Record<string, string> = {};
  if (pick.styles && typeof pick.styles === 'object') {
    for (const [key, style] of Object.entries(pick.styles as Record<string, unknown>).slice(0, MAX_STYLES)) {
      if (/^[a-z-]{1,40}$/.test(key) && typeof style === 'string' && style) styles[key] = style.slice(0, MAX_LABEL);
    }
  }
  // Fail closed: a crop is only ever taken with every secret field masked.
  const masks = Array.isArray(pick.masks) ? pick.masks : null;
  const masksOverflow = pick.masksOverflow === true || !masks || masks.length > MAX_VISUALIZE_MASKS;
  return {
    type: 'picked',
    id,
    pick: {
      selector,
      label: clip(pick.label, MAX_LABEL) || 'element',
      html: clip(pick.html, MAX_HTML),
      styles,
      box: rect(pick.box),
      view: rect(pick.view),
      masks: masksOverflow ? [] : (masks ?? []).map(rect),
      masksOverflow,
    },
  };
}

// Plain ES5 (no bundler helpers may leak into the page). `target` is the
// window feedback goes to: the panel's renderer.
const FEEDBACK_SOURCE = String.raw`(function (target) {
  var KEY = '__mixdogVisualizeFeedback';
  var TAG = '__mixdogVisualize';
  var MAX_MASKS = 16;
  if (!target || target === window) return false;
  if (window[KEY]) return true;
  var api = {};
  window[KEY] = api;
  var state = { comment: false, markers: [], hover: null, focus: null, frame: 0, hideTimer: 0 };

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
  function labelFor(node) {
    var label = node.tagName.toLowerCase();
    var id = node.getAttribute('id');
    if (id) label += '#' + id;
    var classes = String(node.getAttribute('class') || '').split(/\s+/).filter(function (name) { return name; }).slice(0, 2);
    if (classes.length) label += '.' + classes.join('.');
    return cut(redact(label), 80);
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
    return {
      selector: selectorFor(node),
      label: labelFor(node),
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
    '.hover{border:2px dashed #2f6feb;background:rgba(47,111,235,.08)}' +
    '.pin{border:2px solid #ff3b6b;box-shadow:0 0 0 1px rgba(255,255,255,.75)}' +
    '.num{position:fixed;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#ff3b6b;color:#fff;font:700 11px/18px system-ui,-apple-system,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.35);pointer-events:none}', false);
  var layer = document.createElement('div');
  root.appendChild(layer);

  function find(selector) {
    try { return document.querySelector(selector); } catch (error) { return null; }
  }
  function addBox(r, className) {
    var box = document.createElement('div');
    box.className = 'box ' + className;
    box.style.left = (r.left - 2) + 'px';
    box.style.top = (r.top - 2) + 'px';
    box.style.width = (r.width + 4) + 'px';
    box.style.height = (r.height + 4) + 'px';
    layer.appendChild(box);
  }
  function addNumber(r, n) {
    var badge = document.createElement('div');
    badge.className = 'num';
    badge.textContent = String(n);
    badge.style.left = Math.max(2, r.left - 9) + 'px';
    badge.style.top = Math.max(2, r.top - 9) + 'px';
    layer.appendChild(badge);
  }
  function draw() {
    state.frame = 0;
    if (!host.isConnected) document.documentElement.appendChild(host);
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    for (var i = 0; i < state.markers.length; i++) {
      var node = find(state.markers[i].selector);
      if (!node) continue;
      var r = node.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      addBox(r, 'pin');
      addNumber(r, state.markers[i].n);
    }
    if (state.comment && state.hover && state.hover.isConnected) addBox(state.hover.getBoundingClientRect(), 'hover');
    // The panel's Elements list points at one element.
    if (state.focus && state.focus.isConnected) addBox(state.focus.getBoundingClientRect(), 'hover');
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
      if (hovered !== state.hover) { state.hover = hovered; schedule(); }
      return;
    }
    if (message.type === 'pick') {
      var picked = elementAt(message.x, message.y);
      if (picked && typeof message.id === 'string') post({ type: 'picked', id: message.id, pick: describe(picked) });
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
    if (!state.comment) state.hover = null;
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
  const tag = `<script>${visualizeFeedbackScript()}</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) return `${tag}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${tag}${html.slice(at)}`;
}
