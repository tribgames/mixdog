/**
 * Screen reading for HTML panes: a compact read-out of the rendered page (the
 * agent's `inspect`, the panel's Elements list) without a screenshot. The page
 * half is plain ES5 text run inside the pane; it reads layout and computed
 * style only, never writes, and leaves out secret field values. Its answer is
 * page-controlled data, so every consumer passes it through
 * `visualizePageInspection`, which bounds and types it.
 */

export type InspectSeverity = 'error' | 'warning' | 'info';

export const INSPECT_FINDING_KINDS = [
  'overflow-x',
  'clipped-text',
  'overlap',
  'small-target',
  'low-contrast',
  'image-alt',
  'unlabeled-input',
] as const;
export type InspectFindingKind = (typeof INSPECT_FINDING_KINDS)[number];

export interface InspectBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InspectOutlineItem {
  /** Landmarks above it. */
  depth: number;
  kind: 'landmark' | 'heading';
  role: string;
  /** Heading level (0 for a landmark). */
  level: number;
  name: string;
  selector: string;
}

export interface InspectElement extends InspectBox {
  role: string;
  name: string;
  selector: string;
  tag: string;
  /** Text-like inputs only; `[redacted]` for a secret field. */
  value?: string;
  flags: string[];
}

export interface InspectFinding extends InspectBox {
  kind: InspectFindingKind;
  severity: InspectSeverity;
  message: string;
  selector: string;
}

export interface PageInspection {
  viewport: { width: number; height: number };
  page: { width: number; height: number };
  /** The scoping selector, '' for the whole page. */
  scope: string;
  outline: InspectOutlineItem[];
  /** At most MAX_INSPECT_ELEMENTS; `elementCount` is how many there are. */
  elements: InspectElement[];
  elementCount: number;
  findings: InspectFinding[];
  findingCount: number;
  /** Text over images or gradients, whose contrast was not checked. */
  contrastUnknown: number;
  /** The page has more nodes than were read. */
  partial: boolean;
}

export const MAX_INSPECT_ELEMENTS = 200;
export const MAX_INSPECT_OUTLINE = 80;
export const MAX_INSPECT_FINDINGS = 60;
/** Characters of the text read-out. */
export const MAX_INSPECT_TEXT = 8_000;

/** What the page half shares with the feedback script: secret-looking field
 *  and token redaction. */
export const INSPECT_SHARED_SOURCE = String.raw`
  var SECRET_HINT = /pass(?:word|wd|code|phrase)?|token|secret|api[-_ ]?key|apikey|credential|authorization|bearer|session[-_ ]?id|cookie|private[-_ ]?key|\botp\b|one[-_ ]?time|\bpin\b|pin[-_ ]?code|\bcvc\b|\bcvv\b|card[-_ ]?number|cc-number|\bssn\b/i;
  var KNOWN_TOKENS = [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g
  ];
  var LONG_TOKEN = /[A-Za-z0-9_+-]{32,}={0,2}/g;
  function redact(value) {
    var text = String(value == null ? '' : value);
    text = text.replace(/data:[^"'\s)<>]{48,}/g, 'data:[omitted]');
    for (var i = 0; i < KNOWN_TOKENS.length; i++) text = text.replace(KNOWN_TOKENS[i], '[redacted]');
    return text.replace(LONG_TOKEN, function (match) {
      return /[0-9]/.test(match) && /[A-Za-z]/.test(match) ? '[redacted]' : match;
    });
  }
  function cut(text, max) { return text.length > max ? text.slice(0, max - 1) + '\u2026' : text; }
  function secretField(node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = node.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    var type = (node.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    var hints = [node.getAttribute('name'), node.getAttribute('id'), node.getAttribute('autocomplete'), node.getAttribute('aria-label'), node.getAttribute('placeholder')].join(' ');
    return SECRET_HINT.test(hints);
  }
`;

// Plain ES5 (no bundler helpers may leak into the page). Evaluates to
// { parseColor, over, contrast, inspect }; `inspect` needs `document`/`window`.
const INSPECT_SOURCE = String.raw`(function () {
  ${INSPECT_SHARED_SOURCE}
  var MAX_ELEMENTS = 200;
  var MAX_NODES = 4000;
  var MAX_OUTLINE = 80;
  var MAX_FINDINGS = 60;
  var PER_KIND = 12;
  var MAX_TEXT_CHECKS = 800;
  var GRID_CELL = 128;
  var MAX_GRID_CELLS = 64;
  var MAX_SCANS = 4000000;
  var MAX_PAIRS = 1000000;
  var INTERACTIVE_ROLES = /^(button|link|checkbox|radio|tab|menuitem|menuitemcheckbox|menuitemradio|switch|slider|textbox|combobox|searchbox|spinbutton|option|treeitem)$/;
  var LANDMARK_ROLES = /^(banner|navigation|main|complementary|contentinfo|region|search|form)$/;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1, BR: 1 };
  var SKIP_TEXT = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  function squash(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/^ | $/g, ''); }

  function parseColor(value) {
    var s = String(value || '').toLowerCase().replace(/^\s+|\s+$/g, '');
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    var m = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)(?:\s*[,\/]\s*([\d.]+)(%?))?\s*\)$/.exec(s);
    if (!m) return null;
    function channel(v, percent) {
      var n = parseFloat(v);
      return Math.max(0, Math.min(255, percent ? n * 2.55 : n));
    }
    var alpha = m[7] === undefined ? 1 : parseFloat(m[7]) / (m[8] ? 100 : 1);
    return { r: channel(m[1], m[2]), g: channel(m[3], m[4]), b: channel(m[5], m[6]), a: Math.max(0, Math.min(1, alpha)) };
  }
  function over(top, under) {
    var a = top.a;
    return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
  }
  function luminance(c) {
    function lin(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  }
  function contrast(a, b) {
    var l1 = luminance(a);
    var l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function hex(c) {
    function two(v) { var s = Math.round(v).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + two(c.r) + two(c.g) + two(c.b);
  }

  function esc(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }
  function unique(selector, el) {
    try {
      var found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch (error) { return false; }
  }
  function selectorOf(el) {
    if (el.id && unique('#' + esc(el.id), el)) return '#' + esc(el.id);
    var parts = [];
    for (var cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      var tag = cur.tagName.toLowerCase();
      if (cur.id && unique('#' + esc(cur.id), cur)) { parts.unshift('#' + esc(cur.id)); break; }
      var part = tag;
      var first = String(cur.getAttribute('class') || '').split(/\s+/)[0];
      if (first) part += '.' + esc(first);
      var parent = cur.parentElement;
      if (parent && tag !== 'html' && tag !== 'body') {
        var same = 0;
        var index = 0;
        for (var s = parent.firstElementChild; s; s = s.nextElementSibling) {
          if (s.tagName === cur.tagName) {
            same += 1;
            if (s === cur) index = same;
          }
        }
        if (same > 1) part += ':nth-of-type(' + index + ')';
      }
      parts.unshift(part);
      if (unique(parts.join(' > '), el) || tag === 'body' || tag === 'html') break;
    }
    return cut(redact(parts.join(' > ')), 160);
  }

  // What a user typed or picked is never a name: form controls (and
  // everything in them) and editable regions are skipped wherever text is read.
  function isUserContent(n) {
    var tag = n.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION' || tag === 'DATALIST' || secretField(n)) return true;
    var editable = n.getAttribute('contenteditable');
    return editable !== null && editable.toLowerCase() !== 'false';
  }
  // Editability and form-control state are inherited: anything inside an
  // editable region (even a contenteditable="false" island) or a form control
  // is user content, whatever the descendant's own attributes say.
  var USER_AREA = '[contenteditable]:not([contenteditable="false"]),input,textarea,select,datalist,option';
  function inUserArea(n) {
    if (!n || n.nodeType !== 1) return false;
    if (n.isContentEditable === true || isUserContent(n)) return true;
    for (var p = n.parentElement; p; p = p.parentElement) {
      if (p.isContentEditable === true || (p.matches && p.matches(USER_AREA)) || secretField(p)) return true;
    }
    return false;
  }
  function textOf(node, max) {
    var out = '';
    if (node.nodeType === 1 && inUserArea(node)) return '';
    (function walk(n) {
      for (var c = n.firstChild; c && out.length <= max; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue + ' ';
        else if (c.nodeType === 1 && !SKIP_TEXT[c.tagName] && !isUserContent(c)) {
          if (c.tagName === 'IMG' && c.getAttribute('alt')) out += c.getAttribute('alt') + ' ';
          walk(c);
        }
      }
    })(node);
    return squash(out);
  }
  function ownText(el) {
    var out = '';
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) out += c.nodeValue;
    return squash(out);
  }
  function byIds(ids) {
    if (!ids) return '';
    var parts = ids.split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var node = parts[i] ? document.getElementById(parts[i]) : null;
      if (node) out.push(textOf(node, 200));
    }
    return squash(out.join(' '));
  }
  function labelFor(el) {
    var found = [];
    if (el.id) {
      var all = document.getElementsByTagName('label');
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute('for') === el.id) found.push(textOf(all[i], 200));
    }
    var wrap = el.closest ? el.closest('label') : null;
    if (wrap) found.push(textOf(wrap, 200));
    return squash(found.join(' '));
  }
  function nameOf(el) {
    var labelled = byIds(el.getAttribute('aria-labelledby'));
    if (labelled) return { name: labelled, source: 'aria' };
    var aria = squash(el.getAttribute('aria-label'));
    if (aria) return { name: aria, source: 'aria' };
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    var title = squash(el.getAttribute('title'));
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (tag === 'input' && type === 'image') {
        var alt = squash(el.getAttribute('alt'));
        return alt ? { name: alt, source: 'alt' } : { name: title, source: title ? 'title' : '' };
      }
      if (tag === 'input' && /^(button|submit|reset)$/.test(type)) {
        var caption = (secretField(el) ? '' : squash(el.getAttribute('value'))) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
        if (caption) return { name: caption, source: 'value' };
      }
      var label = labelFor(el);
      if (label) return { name: label, source: 'label' };
      if (title) return { name: title, source: 'title' };
      var hint = squash(el.getAttribute('placeholder'));
      return hint ? { name: hint, source: 'placeholder' } : { name: '', source: '' };
    }
    var content = textOf(el, 200);
    if (content) return { name: content, source: 'content' };
    return title ? { name: title, source: 'title' } : { name: '', source: '' };
  }

  function landmarkRole(el) {
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (role) return LANDMARK_ROLES.test(role) ? role : '';
    var tag = el.tagName.toLowerCase();
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'aside') return 'complementary';
    if (tag === 'header' || tag === 'footer') {
      if (el.closest && el.parentElement && el.parentElement.closest('article, aside, main, nav, section')) return '';
      return tag === 'header' ? 'banner' : 'contentinfo';
    }
    var labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
    if (labelled && tag === 'section') return 'region';
    if (labelled && tag === 'form') return 'form';
    return '';
  }
  function landmarkDepth(el) {
    var depth = 0;
    for (var p = el.parentElement; p; p = p.parentElement) if (landmarkRole(p)) depth += 1;
    return depth;
  }
  function headingLevel(el) {
    var m = /^h([1-6])$/.exec(el.tagName.toLowerCase());
    if (m) return parseInt(m[1], 10);
    if ((el.getAttribute('role') || '').toLowerCase() === 'heading') return parseInt(el.getAttribute('aria-level'), 10) || 2;
    return 0;
  }
  function interactiveRole(el) {
    var tag = el.tagName.toLowerCase();
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (INTERACTIVE_ROLES.test(role)) return role;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'hidden') return '';
      if (/^(button|submit|reset|image)$/.test(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    var editable = (el.getAttribute('contenteditable') || '').toLowerCase();
    if (editable === '' ? el.hasAttribute('contenteditable') : editable === 'true') return 'textbox';
    var tabindex = el.getAttribute('tabindex');
    if (el.hasAttribute('onclick') || el.hasAttribute('data-choice') || (tabindex !== null && parseInt(tabindex, 10) >= 0)) return 'clickable';
    return '';
  }

  function inspect(opts) {
    opts = opts || {};
    var root = document.body || document.documentElement;
    if (opts.selector) {
      try { root = document.querySelector(opts.selector); } catch (error) { return { error: 'invalid selector' }; }
      if (!root) return { error: 'the selector matched nothing' };
    }
    var sx = window.pageXOffset || 0;
    var sy = window.pageYOffset || 0;
    var de = document.documentElement;
    var vw = de.clientWidth || window.innerWidth || 0;
    var vh = window.innerHeight || de.clientHeight || 0;
    // Walk lazily and stop at the cap: a huge document is never materialized.
    var nodes = [root];
    var partial = false;
    var walker = document.createTreeWalker(root, 1);
    for (var step = walker.nextNode(); step; step = walker.nextNode()) {
      if (nodes.length > MAX_NODES) { partial = true; break; }
      nodes.push(step);
    }
    var result = {
      viewport: { width: Math.round(window.innerWidth || vw), height: Math.round(vh) },
      page: { width: Math.round(de.scrollWidth || 0), height: Math.round(de.scrollHeight || 0) },
      scope: opts.selector ? cut(redact(String(opts.selector)), 200) : '',
      outline: [], elements: [], elementCount: 0, findings: [], findingCount: 0, contrastUnknown: 0,
      partial: partial
    };
    var counts = {};
    function find(kind, severity, message, el, box) {
      result.findingCount += 1;
      counts[kind] = (counts[kind] || 0) + 1;
      if (counts[kind] > PER_KIND || result.findings.length >= MAX_FINDINGS) return;
      if (typeof message === 'function') message = message();
      result.findings.push({ kind: kind, severity: severity, message: cut(redact(message), 200), selector: selectorOf(el), x: box.x, y: box.y, w: box.w, h: box.h });
    }
    function boxOf(el) {
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) };
    }

    var interactive = [];
    var textChecks = 0;
    var overflowers = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (SKIP[el.tagName]) continue;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
      var box = boxOf(el);
      var seen = box.w > 0 && box.h > 0;
      var tag = el.tagName.toLowerCase();

      var landmark = landmarkRole(el);
      var level = headingLevel(el);
      var inside = !!el.parentElement && inUserArea(el.parentElement);
      if ((landmark || level) && !inside && result.outline.length < MAX_OUTLINE) {
        result.outline.push({
          depth: landmarkDepth(el), kind: landmark ? 'landmark' : 'heading', role: landmark || 'heading', level: landmark ? 0 : level,
          name: cut(redact(landmark ? (byIds(el.getAttribute('aria-labelledby')) || squash(el.getAttribute('aria-label'))) : textOf(el, 200)), 80),
          selector: selectorOf(el)
        });
      }

      var role = seen ? interactiveRole(el) : '';
      var disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      var faint = parseFloat(cs.opacity) === 0;
      if (role) {
        var secret = secretField(el);
        var named = inside ? { name: '', source: '' } : nameOf(el);
        var flags = [];
        if (disabled) flags.push('disabled');
        if (secret) flags.push('secret');
        if (named.source === 'placeholder') flags.push('placeholder-only');
        if (el.checked === true) flags.push('checked');
        if (faint) flags.push('invisible');
        // The selector is only needed for the listed elements; overlaps compute theirs on demand.
        var record = { role: role, name: cut(redact(named.name), 60), selector: result.elements.length < MAX_ELEMENTS ? selectorOf(el) : '', tag: tag, x: box.x, y: box.y, w: box.w, h: box.h, flags: flags };
        if (tag === 'input' || tag === 'textarea') {
          var type = (el.getAttribute('type') || 'text').toLowerCase();
          if (secret || inside) record.value = '[redacted]';
          else if (!/^(checkbox|radio|button|submit|reset|image|file|range|color)$/.test(type) && el.value) record.value = cut(redact(String(el.value)), 40);
        }
        result.elementCount += 1;
        if (result.elements.length < MAX_ELEMENTS) result.elements.push(record);
        if (!disabled && !faint) interactive.push({ el: el, record: record, inlineLink: role === 'link' && cs.display === 'inline', named: named });

        // Form controls need a name from something other than a placeholder.
        if (tag === 'input' || tag === 'select' || tag === 'textarea') {
          var ctype = (el.getAttribute('type') || 'text').toLowerCase();
          if (!/^(hidden|submit|button|reset|image)$/.test(ctype) && (!named.name || named.source === 'placeholder') && !faint) {
            find('unlabeled-input', 'warning', named.source === 'placeholder' ? 'form field has only a placeholder, no label' : 'form field has no label or accessible name', el, box);
          }
        }
      }

      if (seen && (tag === 'img' || (el.getAttribute('role') || '') === 'img' || (tag === 'input' && el.getAttribute('type') === 'image'))) {
        var described = tag === 'img' ? el.hasAttribute('alt') : !!(squash(el.getAttribute('aria-label')) || byIds(el.getAttribute('aria-labelledby')) || squash(el.getAttribute('alt')) || squash(el.getAttribute('title')));
        if (!described) find('image-alt', 'warning', 'image has no alt text (use alt="" if it is decorative)', el, box);
      }

      if (seen && el !== root && tag !== 'html' && tag !== 'body') {
        if (box.x + box.w > vw + 1 && !(el.parentElement && overflowers.length && overflowers[overflowers.length - 1] === el.parentElement)) overflowers.push(el);
        var clipsX = /hidden|clip/.test(cs.overflowX || cs.overflow || '');
        var clipsY = /hidden|clip/.test(cs.overflowY || cs.overflow || '');
        if ((clipsX || clipsY) && el.clientWidth > 0 && ((clipsX && el.scrollWidth > el.clientWidth + 1) || (clipsY && el.scrollHeight > el.clientHeight + 1)) && textOf(el, 1)) {
          var ellipsis = cs.textOverflow === 'ellipsis';
          find('clipped-text', ellipsis ? 'info' : 'warning',
            ellipsis ? 'text is cut off with an ellipsis' : 'text is clipped: content ' + el.scrollWidth + 'x' + el.scrollHeight + 'px in a ' + el.clientWidth + 'x' + el.clientHeight + 'px box',
            el, box);
        }
      }

      if (seen && !disabled && textChecks < MAX_TEXT_CHECKS && ownText(el)) {
        textChecks += 1;
        var fg = parseColor(cs.color);
        var bg = fg ? backdrop(el) : null;
        if (!fg || !bg) { result.contrastUnknown += 1; }
        else {
          var opacity = 1;
          for (var up = el; up && up.nodeType === 1; up = up.parentElement) {
            var layer = parseFloat(window.getComputedStyle(up).opacity);
            if (!isNaN(layer)) opacity *= layer;
          }
          var flat = over({ r: fg.r, g: fg.g, b: fg.b, a: fg.a * opacity }, bg);
          var ratio = contrast(flat, bg);
          var size = parseFloat(cs.fontSize) || 16;
          var weight = cs.fontWeight === 'bold' ? 700 : parseInt(cs.fontWeight, 10) || 400;
          var needed = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
          if (ratio < needed) {
            find('low-contrast', ratio < 3 ? 'error' : 'warning', 'text contrast ' + (Math.floor(ratio * 10) / 10) + ':1 is below ' + needed + ':1 (' + hex(flat) + ' on ' + hex(bg) + ')', el, box);
          }
        }
      }
    }

    function backdrop(el) {
      var layers = [];
      for (var cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
        var style = window.getComputedStyle(cur);
        if (style.backgroundImage && style.backgroundImage !== 'none') return null;
        var color = parseColor(style.backgroundColor);
        if (!color) return null;
        if (color.a > 0) layers.push(color);
        if (color.a >= 1) break;
      }
      var base = { r: 255, g: 255, b: 255, a: 1 };
      for (var k = layers.length - 1; k >= 0; k--) base = over(layers[k], base);
      return base;
    }

    if (de.scrollWidth > vw + 1) {
      var names = [];
      for (var o = 0; o < overflowers.length && o < 3; o++) names.push(selectorOf(overflowers[o]));
      find('overflow-x', 'error', 'page scrolls horizontally: content is ' + de.scrollWidth + 'px wide in a ' + vw + 'px viewport' + (names.length ? '; wider than the viewport: ' + names.join(', ') : ''),
        overflowers[0] || de, overflowers.length ? boxOf(overflowers[0]) : { x: 0, y: 0, w: de.scrollWidth, h: 0 });
    }

    // Overlaps: targets are bucketed by the grid cells their box covers, so each
    // one is only compared with its neighbours (not all pairs). A box spanning
    // many cells goes in a shared "wide" list; the visit budget bounds the rest.
    var cells = {};
    var wide = { list: [], from: 0 };
    var cellsOf = [];
    for (var g = 0; g < interactive.length; g++) {
      var gb = interactive[g].record;
      var cx0 = Math.floor(gb.x / GRID_CELL);
      var cx1 = Math.floor((gb.x + gb.w - 1) / GRID_CELL);
      var cy0 = Math.floor(gb.y / GRID_CELL);
      var cy1 = Math.floor((gb.y + gb.h - 1) / GRID_CELL);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_GRID_CELLS) {
        wide.list.push(g);
        cellsOf.push(null);
        continue;
      }
      var mine = [];
      for (var cx = cx0; cx <= cx1; cx++) {
        for (var cy = cy0; cy <= cy1; cy++) {
          var key = cx + ',' + cy;
          var bucket = cells[key] || (cells[key] = { list: [], from: 0 });
          bucket.list.push(g);
          mine.push(bucket);
        }
      }
      cellsOf.push(mine);
    }
    // Two budgets bound the work: bucket entries scanned and distinct pairs
    // compared. Running out leaves later rows unchecked, so the result says partial.
    var scans = 0;
    var pairs = 0;
    var exhausted = false;
    var stamp = [];
    function byIndex(p, q) { return p - q; }

    for (var a = 0; a < interactive.length; a++) {
      var first = interactive[a];
      var fb = first.record;
      if (!first.inlineLink && (fb.w < 24 || fb.h < 24)) {
        find('small-target', 'warning', 'tap target is ' + fb.w + 'x' + fb.h + 'px (WCAG minimum 24x24)', first.el, fb);
      }
      if (exhausted) continue;
      var candidates = [];
      if (cellsOf[a]) {
        var buckets = cellsOf[a].concat([wide]);
        for (var u = 0; u < buckets.length; u++) {
          var bk = buckets[u];
          while (bk.from < bk.list.length && bk.list[bk.from] <= a) bk.from += 1;
          scans += bk.list.length - bk.from;
          if (scans > MAX_SCANS) { exhausted = true; break; }
          for (var k = bk.from; k < bk.list.length; k++) {
            var near = bk.list[k];
            // A pair sharing several cells is still checked once per row.
            if (stamp[near] !== a) { stamp[near] = a; candidates.push(near); }
          }
        }
        candidates.sort(byIndex);
      } else {
        for (var all = a + 1; all < interactive.length; all++) candidates.push(all);
      }
      if (exhausted) continue;
      pairs += candidates.length;
      if (pairs > MAX_PAIRS) { exhausted = true; continue; }
      for (var c = 0; c < candidates.length; c++) {
        var second = interactive[candidates[c]];
        var sb = second.record;
        var width = Math.min(fb.x + fb.w, sb.x + sb.w) - Math.max(fb.x, sb.x);
        var height = Math.min(fb.y + fb.h, sb.y + sb.h) - Math.max(fb.y, sb.y);
        if (width <= 0 || height <= 0) continue;
        if (width * height > 0.2 * Math.min(fb.w * fb.h, sb.w * sb.h)) {
          if (first.el.contains(second.el) || second.el.contains(first.el)) continue;
          find('overlap', 'warning', function () { return 'overlaps ' + sb.role + ' "' + sb.name + '" (' + (sb.selector || selectorOf(second.el)) + ')'; }, first.el, fb);
        }
      }
    }
    if (exhausted) result.partial = true;
    // Last pass: no string that leaves the page carries a token-like value.
    (function scrub(value) {
      for (var key in value) {
        if (typeof value[key] === 'string') value[key] = redact(value[key]);
        else if (value[key] && typeof value[key] === 'object') scrub(value[key]);
      }
    })(result);
    var rank = { error: 0, warning: 1, info: 2 };
    result.findings = result.findings.map(function (item, index) { return { item: item, index: index }; })
      .sort(function (p, q) { return rank[p.item.severity] - rank[q.item.severity] || p.index - q.index; })
      .map(function (entry) { return entry.item; });
    return result;
  }

  return { parseColor: parseColor, over: over, contrast: contrast, inspect: inspect };
})()`;

/** Page script text that evaluates to a raw inspection result. `selector`
 *  scopes it to one subtree. */
export function visualizeInspectScript(options: { selector?: string } = {}): string {
  return `(${INSPECT_SOURCE}).inspect(${JSON.stringify(options.selector ? { selector: options.selector } : {})})`;
}

/** The page half as an expression for the feedback script to embed. */
export const VISUALIZE_INSPECT_LIB_SOURCE = INSPECT_SOURCE;

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const int = (value: unknown, max = 1_000_000): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(-max, Math.min(max, Math.round(value))) : 0;
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function box(raw: Record<string, unknown>): InspectBox {
  return { x: int(raw.x), y: int(raw.y), w: Math.max(0, int(raw.w)), h: Math.max(0, int(raw.h)) };
}

const SEVERITIES: readonly string[] = ['error', 'warning', 'info'];

/** A page's answer, bounded and typed; `{ error }` when it reported one, null
 *  when it is not an inspection at all. */
export function visualizePageInspection(value: unknown): PageInspection | { error: string } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.error === 'string') return { error: text(raw.error, 200) };
  if (!Array.isArray(raw.elements) || !Array.isArray(raw.findings) || !Array.isArray(raw.outline)) return null;
  const viewport = record(raw.viewport);
  const page = record(raw.page);
  const elements = list(raw.elements, MAX_INSPECT_ELEMENTS).map((entry): InspectElement => {
    const item = record(entry);
    const secret = Array.isArray(item.flags) && item.flags.includes('secret');
    return {
      role: text(item.role, 24),
      name: text(item.name, 80),
      selector: text(item.selector, 200),
      tag: text(item.tag, 24),
      ...(typeof item.value === 'string' ? { value: secret ? '[redacted]' : text(item.value, 60) } : {}),
      flags: list(item.flags, 6)
        .map((flag) => text(flag, 24))
        .filter(Boolean),
      ...box(item),
    };
  });
  const findings = list(raw.findings, MAX_INSPECT_FINDINGS).flatMap((entry): InspectFinding[] => {
    const item = record(entry);
    const kind = (INSPECT_FINDING_KINDS as readonly string[]).includes(item.kind as string)
      ? (item.kind as InspectFindingKind)
      : null;
    if (!kind) return [];
    return [
      {
        kind,
        severity: SEVERITIES.includes(item.severity as string) ? (item.severity as InspectSeverity) : 'warning',
        message: text(item.message, 240),
        selector: text(item.selector, 200),
        ...box(item),
      },
    ];
  });
  return {
    viewport: { width: Math.max(0, int(viewport.width)), height: Math.max(0, int(viewport.height)) },
    page: { width: Math.max(0, int(page.width)), height: Math.max(0, int(page.height)) },
    scope: text(raw.scope, 200),
    outline: list(raw.outline, MAX_INSPECT_OUTLINE).map((entry): InspectOutlineItem => {
      const item = record(entry);
      return {
        depth: Math.max(0, Math.min(8, int(item.depth))),
        kind: item.kind === 'landmark' ? 'landmark' : 'heading',
        role: text(item.role, 24),
        level: Math.max(0, Math.min(6, int(item.level))),
        name: text(item.name, 100),
        selector: text(item.selector, 200),
      };
    }),
    elements,
    elementCount: Math.max(elements.length, int(raw.elementCount)),
    findings,
    findingCount: Math.max(findings.length, int(raw.findingCount)),
    contrastUnknown: Math.max(0, int(raw.contrastUnknown)),
    partial: raw.partial === true,
  };
}

const boxText = (item: InspectBox): string => `${item.x},${item.y} ${item.w}×${item.h}`;

/** Lines that fit `budget` characters; the rest is summarized. */
function fit(lines: string[], budget: number, noun: string): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.length < lines.length
    ? [...kept, `  …${lines.length - kept.length} more ${noun} omitted (output capped)`]
    : kept;
}

/** The agent's text read-out of one pane's inspection: findings first, then
 *  the outline and the interactive elements, within MAX_INSPECT_TEXT. */
export function formatPageInspection(inspection: PageInspection, title: string): string {
  const head = [
    `${title}: viewport ${inspection.viewport.width}×${inspection.viewport.height}, page ${inspection.page.width}×${inspection.page.height}${inspection.scope ? `, scope ${inspection.scope}` : ''}${inspection.partial ? ' (very large page: only the first part was read)' : ''}`,
  ];
  if (inspection.contrastUnknown) {
    head.push(
      `${inspection.contrastUnknown} text element${inspection.contrastUnknown === 1 ? '' : 's'} over images or gradients: contrast not checked.`
    );
  }
  const findings = inspection.findings.map(
    (finding) =>
      `  - [${finding.severity}] ${finding.kind}: ${finding.message} · ${finding.selector} (${boxText(finding)})`
  );
  const unlisted = inspection.findingCount - inspection.findings.length;
  const unlistedLine = unlisted > 0 ? [`  …${unlisted} more not listed`] : [];
  const outline = inspection.outline.map((item) => {
    const pad = '  '.repeat(item.depth + 1);
    return item.kind === 'landmark'
      ? `${pad}[${item.role}]${item.name ? ` "${item.name}"` : ''} ${item.selector}`
      : `${pad}h${item.level} "${item.name}" ${item.selector}`;
  });
  const elements = inspection.elements.map((element) => {
    const flags = element.flags.length ? ` [${element.flags.join(', ')}]` : '';
    const value = element.value !== undefined ? ` value="${element.value}"` : '';
    return `  - ${element.role} "${element.name}"${value}${flags} · ${element.selector} (${boxText(element)})`;
  });
  const sections = [
    head.join('\n'),
    inspection.findingCount
      ? [`Layout findings (${inspection.findingCount}):`, ...fit(findings, 3_200, 'findings'), ...unlistedLine].join(
          '\n'
        )
      : 'Layout findings: none.',
    outline.length
      ? ['Outline:', ...fit(outline, 1_800, 'outline rows')].join('\n')
      : 'Outline: no landmarks or headings.',
    elements.length
      ? [
          `Interactive elements (${inspection.elementCount}${inspection.elementCount > inspection.elements.length ? `, first ${inspection.elements.length} listed` : ''}):`,
          ...fit(elements, 2_600, 'elements'),
        ].join('\n')
      : 'Interactive elements: none.',
  ];
  const out = sections.join('\n');
  return out.length > MAX_INSPECT_TEXT
    ? `${out.slice(0, MAX_INSPECT_TEXT - 40)}\n…output capped at ${MAX_INSPECT_TEXT} characters`
    : out;
}

/** "3 layout findings — run inspect", or '' when there are none. */
export function inspectFindingsSummary(count: number): string {
  return count > 0 ? `${count} layout finding${count === 1 ? '' : 's'} — run inspect` : '';
}
