/**
 * The annotation overlay injected into a visualize HTML pane. It draws
 * outlined boxes with a small label over the elements a selector matches, in
 * a closed shadow root on a fixed, click-through host: the page's own DOM and
 * the file on disk are never changed. The marks live on the page's window, so
 * a reload or navigation drops them with the document.
 *
 * Kept as plain ES5 text (not a stringified function) so no bundler helper can
 * leak into the page.
 */
import type { VisualizeAnnotateOp } from './targets';

export interface VisualizeOverlayResult {
  invalid: string[];
  marks: Array<{ selector: string; label: string; count: number }>;
}

const OVERLAY_SOURCE = `(function (op) {
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
  var keep = function (selector) {
    state.marks = state.marks.filter(function (entry) { return entry.selector !== selector; });
  };
  if (op.clear) state.marks = [];
  (op.remove || []).forEach(keep);
  (op.add || []).forEach(function (entry) {
    try { document.querySelector(entry.selector); } catch (error) { invalid.push(entry.selector); return; }
    keep(entry.selector);
    state.marks.push({ selector: entry.selector, label: entry.label || '' });
  });
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

/** The script for one annotate operation; the operation travels as JSON. */
export function visualizeOverlayScript(op: VisualizeAnnotateOp): string {
  return `${OVERLAY_SOURCE}(${JSON.stringify(op)})`;
}
