/**
 * Annotation marks of a visualize tab (the agent's `annotate`): outlined boxes
 * with a small label over the elements a selector matches. The marks live in
 * the tab state, per displayed pane, so the desktop window and every paired
 * device draw the same ones with the same overlay script: main injects it
 * into the desktop's pane frames, a remote client puts it inside the page it
 * runs (or, for a page that may not run scripts yet, plain CSS outlines).
 * A tab reload drops them with the revision they were made for.
 *
 * The overlay is plain ES5 text (not a stringified function) so no bundler
 * helper can leak into the page; it draws in a closed shadow root on a fixed,
 * click-through host, never changing the page's own DOM.
 */
import { withHeadScript } from './sandbox-storage-shim';

/** One mark on displayed pane `pane`. */
export interface VisualizeAnnotation {
  pane: number;
  selector: string;
  label?: string;
}

/** Marks a tab keeps at most (every pane together). */
export const MAX_VISUALIZE_ANNOTATIONS = 120;
const MAX_SELECTOR_CHARS = 500;
const MAX_LABEL_CHARS = 120;

/** An `annotate` operation (validated by the tool parser). */
export type VisualizeAnnotationOp =
  | { add: Array<{ selector: string; label?: string }> }
  | { remove: string[] }
  | { clear: true };

/** `list` after `op`, applied to every pane in `panes` (the tab's HTML panes):
 *  `add` replaces a mark of the same selector, `remove` drops by selector,
 *  `clear` drops them all. */
export function applyVisualizeAnnotationOp(
  list: readonly VisualizeAnnotation[],
  op: VisualizeAnnotationOp,
  panes: readonly number[]
): VisualizeAnnotation[] {
  if ('clear' in op) return [];
  if ('remove' in op) return list.filter((mark) => !op.remove.includes(mark.selector));
  const selectors = new Set(op.add.map((mark) => mark.selector));
  const added = panes.flatMap((pane) =>
    op.add.map((mark) => ({ pane, selector: mark.selector, ...(mark.label ? { label: mark.label } : {}) }))
  );
  return [...list.filter((mark) => !selectors.has(mark.selector)), ...added].slice(-MAX_VISUALIZE_ANNOTATIONS);
}

/** The marks of displayed pane `pane`, as the overlay takes them. */
export function visualizePaneMarks(
  list: readonly VisualizeAnnotation[] | undefined,
  pane: number
): Array<{ selector: string; label: string }> {
  return (list ?? [])
    .filter((mark) => mark.pane === pane)
    .map((mark) => ({ selector: mark.selector, label: mark.label ?? '' }));
}

/** `value` as a list of well-formed marks (what a client accepts from a host). */
export function visualizeAnnotations(value: unknown): VisualizeAnnotation[] {
  if (!Array.isArray(value)) return [];
  const out: VisualizeAnnotation[] = [];
  for (const entry of value.slice(0, MAX_VISUALIZE_ANNOTATIONS)) {
    const mark = entry as Partial<VisualizeAnnotation> | null;
    if (!mark || typeof mark !== 'object') continue;
    if (typeof mark.pane !== 'number' || !Number.isInteger(mark.pane) || mark.pane < 0) continue;
    if (typeof mark.selector !== 'string' || !mark.selector || mark.selector.length > MAX_SELECTOR_CHARS) continue;
    const label = typeof mark.label === 'string' ? mark.label.slice(0, MAX_LABEL_CHARS) : '';
    out.push({ pane: mark.pane, selector: mark.selector, ...(label ? { label } : {}) });
  }
  return out;
}

export interface VisualizeOverlayResult {
  invalid: string[];
  marks: Array<{ selector: string; label: string; count: number }>;
}

const OVERLAY_SOURCE = `(function (marks) {
  var KEY = '__mixdogVisualizeMarks';
  var state = window[KEY];
  if (!state) {
    var host = document.createElement('mixdog-visualize-marks');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;';
    state = { host: host, root: host.attachShadow({ mode: 'closed' }), marks: [], frame: 0 };
    window[KEY] = state;
    state.schedule = function () {
      if (state.frame) return;
      state.frame = requestAnimationFrame(function () { state.frame = 0; state.draw(); });
    };
    addEventListener('scroll', state.schedule, true);
    addEventListener('resize', state.schedule);
    new MutationObserver(state.schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  state.draw = function () {
    var root = state.root;
    while (root.firstChild) root.removeChild(root.firstChild);
    if (!state.marks.length) return;
    var style = document.createElement('style');
    style.textContent = '.box{position:fixed;box-sizing:border-box;border:2px solid #ff3b6b;border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.75);background:rgba(255,59,107,.06)}' +
      '.tag{position:fixed;font:600 11px/16px system-ui,-apple-system,sans-serif;color:#fff;background:#ff3b6b;padding:0 6px;border-radius:3px;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}';
    root.appendChild(style);
    for (var m = 0; m < state.marks.length; m++) {
      var mark = state.marks[m];
      var nodes;
      try { nodes = document.querySelectorAll(mark.selector); } catch (error) { continue; }
      var labelled = false;
      for (var i = 0; i < nodes.length && i < 20; i++) {
        var rect = nodes[i].getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        var box = document.createElement('div');
        box.className = 'box';
        box.style.left = (rect.left - 2) + 'px';
        box.style.top = (rect.top - 2) + 'px';
        box.style.width = (rect.width + 4) + 'px';
        box.style.height = (rect.height + 4) + 'px';
        root.appendChild(box);
        if (mark.label && !labelled) {
          labelled = true;
          var tag = document.createElement('div');
          tag.className = 'tag';
          tag.textContent = mark.label;
          tag.style.left = Math.max(0, rect.left - 2) + 'px';
          tag.style.top = (rect.top - 20 < 0 ? rect.bottom + 4 : rect.top - 20) + 'px';
          root.appendChild(tag);
        }
      }
    }
  };
  if (!state.host.isConnected) document.documentElement.appendChild(state.host);
  var invalid = [];
  state.marks = [];
  for (var n = 0; n < marks.length; n++) {
    var entry = marks[n];
    try { document.querySelector(entry.selector); } catch (error) { invalid.push(entry.selector); continue; }
    state.marks.push({ selector: entry.selector, label: entry.label || '' });
  }
  state.draw();
  return {
    invalid: invalid,
    marks: state.marks.map(function (entry) {
      var count = 0;
      try { count = document.querySelectorAll(entry.selector).length; } catch (error) {}
      return { selector: entry.selector, label: entry.label, count: count };
    })
  };
})`;

const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/** The script that shows exactly `marks` in a page (replacing what it showed);
 *  the marks travel as JSON only. Evaluates to the overlay result. */
export function visualizeOverlayScript(marks: ReadonlyArray<{ selector: string; label?: string }>): string {
  return `${OVERLAY_SOURCE}(${json(marks.map((mark) => ({ selector: mark.selector, label: mark.label ?? '' })))})`;
}

/** `html` that draws `marks` once its document is parsed (a remote page that
 *  runs scripts). Unchanged when there are none. */
export function withVisualizeOverlay(html: string, marks: ReadonlyArray<{ selector: string; label?: string }>): string {
  if (!marks.length) return html;
  const script = `(function () {
  var run = function () { try { ${visualizeOverlayScript(marks)}; } catch (error) {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();`;
  return withHeadScript(html, script);
}
