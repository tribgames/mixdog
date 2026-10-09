// The HTML authoring path, first half: a local Chrome/Edge lays out an HTML
// deck (one <section class="slide"> per page on a 1920×1080 canvas) and this
// module reads back what the browser drew — boxes, fills, borders, shadows,
// text with the line breaks the browser chose, tables, chart specs, inline
// SVG, and pictures — plus one screenshot per slide as the visual reference.
// pptx-html-build.mjs turns the measurement into native PowerPoint shapes.
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { launchHtmlBrowser, runInBrowser } from './html-browser.mjs';
import { iconGlobal } from './pptx-icons.mjs';
import { GEOMETRY_TOLERANCE_PX, NEAR_MISS_PX, readGeometry } from './pptx-html-geometry.mjs';

const require = createRequire(import.meta.url);

/** The deck canvas in CSS px and the page it lands on in inches; a PDF's designed pages pass their sheet instead. */
export const HTML_CANVAS = { width: 1920, height: 1080, inchWidth: 13.333, inchHeight: 7.5 };

const viewport = (canvas, deviceScaleFactor) => ({ width: canvas.width, height: canvas.height, deviceScaleFactor });

// Runs inside the page: everything it needs is defined here. Returns one
// slide's items in paint order (a parent's box before its children).
function extractSlide(index) {
  const slide = document.querySelectorAll('section.slide')[index];
  const base = slide.getBoundingClientRect();
  const px = (value) => parseFloat(value) || 0;
  const color = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!match) return null;
    const parts = match[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(parseFloat);
    const alpha = parts.length > 3 ? parts[3] : 1;
    if (alpha === 0) return null;
    return {
      hex: parts
        .slice(0, 3)
        .map((v) => Math.round(v).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
      a: alpha,
    };
  };
  const rel = (r) => ({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
  const visible = (el, cs) =>
    cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
  const hasOwnText = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
  const family = (value) =>
    value
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
  const items = [];
  const notes = [];
  const captures = [];

  // CSS opacity multiplies down the tree; it travels as the alpha of every colour the element paints.
  const opacityOf = (el) => {
    let alpha = 1;
    for (let node = el; node && node !== slide.parentElement; node = node.parentElement) {
      alpha *= parseFloat(getComputedStyle(node).opacity);
    }
    return Number.isFinite(alpha) ? alpha : 1;
  };
  const faded = (c, alpha) => (c && alpha < 1 ? { ...c, a: c.a * alpha } : c);

  // A 2×2 transform part other than the identity: [rotation in degrees, whether it is a pure rotation].
  const turn = (cs) => {
    const m = /matrix\(([^)]+)\)/.exec(cs.transform || '');
    if (!m) return null;
    const [a, b, c, d] = m[1].split(',').map(parseFloat);
    if (Math.abs(a - 1) < 1e-4 && Math.abs(b) < 1e-4 && Math.abs(c) < 1e-4 && Math.abs(d - 1) < 1e-4) return null;
    const pure = Math.abs(Math.hypot(a, b) - 1) < 1e-3 && Math.abs(a - d) < 1e-3 && Math.abs(b + c) < 1e-3;
    return { deg: (Math.atan2(b, a) * 180) / Math.PI, pure };
  };

  // Paint PowerPoint has no native form for: gradients and background pictures, clip paths, masks, filters,
  // blend modes, non-solid or several borders and shadows, rotation and skew, ::before/::after decoration.
  // Such an element's own paint is taken from the browser as a picture; its text stays native.
  function richPaint(el, cs) {
    const reasons = [];
    const set = (value) => value && value !== 'none';
    if (/gradient\(|url\(/.test(cs.backgroundImage)) reasons.push('background-image');
    if (set(cs.clipPath)) reasons.push('clip-path');
    if (set(cs.maskImage) || set(cs.webkitMaskImage)) reasons.push('mask');
    if (set(cs.filter)) reasons.push('filter');
    if (set(cs.backdropFilter)) reasons.push('backdrop-filter');
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') reasons.push('mix-blend-mode');
    // A rotated box of text is read upright by the caller and turned natively; anything else turned is drawn.
    if (turn(cs)) reasons.push('transform');
    if (
      ['Top', 'Right', 'Bottom', 'Left'].some(
        (s) => px(cs[`border${s}Width`]) > 0 && !['solid', 'none', 'hidden'].includes(cs[`border${s}Style`])
      )
    ) {
      reasons.push('border-style');
    }
    if (set(cs.boxShadow) && (/inset/.test(cs.boxShadow) || cs.boxShadow.split(/,(?![^(]*\))/).length > 1))
      reasons.push('box-shadow');
    for (const which of ['::before', '::after']) {
      const p = getComputedStyle(el, which);
      if (p.content && p.content !== 'none' && p.content !== 'normal' && p.display !== 'none') reasons.push(which);
    }
    // The page clips a box that runs past it. A square fill is cut natively; a rounded or outlined box past
    // the edge would show its corner or border there, so its on-page part is taken as drawn.
    if (el !== slide && !hasOwnText(el)) {
      const r = el.getBoundingClientRect();
      const s = slide.getBoundingClientRect();
      const past = r.left < s.left - 0.5 || r.top < s.top - 0.5 || r.right > s.right + 0.5 || r.bottom > s.bottom + 0.5;
      const bordered = ['Top', 'Right', 'Bottom', 'Left'].some(
        (side) => px(cs[`border${side}Width`]) > 0 && !['none', 'hidden'].includes(cs[`border${side}Style`])
      );
      const rounded = px(cs.borderTopLeftRadius) > 0 && color(cs.backgroundColor);
      if (past && (bordered || rounded)) reasons.push('bleed');
    }
    return reasons;
  }

  // The colour actually visible behind an element: the nearest ancestor with a background.
  const backdrop = (el) => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const fill = color(getComputedStyle(parent).backgroundColor);
      if (fill) return fill;
      if (parent === slide) break;
    }
    return null;
  };

  // The element's own box paint: a rect (fill and/or one uniform stroke, radius, one outer shadow)
  // and a line per remaining border side.
  function paint(el, cs) {
    const out = { rect: null, lines: [] };
    const r = el.getBoundingClientRect();
    const alpha = opacityOf(el);
    const fill = faded(color(cs.backgroundColor), alpha);
    const sides = ['Top', 'Right', 'Bottom', 'Left']
      .map((side) => ({
        side,
        w: px(cs[`border${side}Width`]),
        c: faded(color(cs[`border${side}Color`]), alpha),
        style: cs[`border${side}Style`],
      }))
      .map((b) => ({ ...b, on: b.w > 0 && b.c && b.style !== 'none' }));
    const uniform = sides.every((b) => b.on) && sides.every((b) => b.w === sides[0].w && b.c.hex === sides[0].c.hex);
    // A percentage radius is relative to the box (50% on a square is a circle).
    const rawRadius = cs.borderTopLeftRadius.trim().endsWith('%')
      ? (px(cs.borderTopLeftRadius) / 100) * Math.min(r.width, r.height)
      : px(cs.borderTopLeftRadius);
    const radius = Math.min(rawRadius, r.width / 2, r.height / 2);
    let shadow = null;
    if (cs.boxShadow && cs.boxShadow !== 'none') {
      const m = /(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(cs.boxShadow);
      if (m && !/inset/.test(cs.boxShadow)) {
        shadow = { color: faded(color(m[1]), alpha), x: parseFloat(m[2]), y: parseFloat(m[3]), blur: parseFloat(m[4]) };
      }
    }
    if (fill || uniform) {
      out.rect = {
        kind: 'rect',
        box: rel(r),
        fill,
        radius,
        stroke: uniform ? { ...sides[0].c, w: sides[0].w } : null,
        shadow,
      };
    }
    if (!uniform) {
      const b = rel(r);
      for (const side of sides.filter((s) => s.on)) {
        const half = side.w / 2;
        const seg = {
          Top: [b.x, b.y + half, b.x + b.w, b.y + half],
          Bottom: [b.x, b.y + b.h - half, b.x + b.w, b.y + b.h - half],
          Left: [b.x + half, b.y, b.x + half, b.y + b.h],
          Right: [b.x + b.w - half, b.y, b.x + b.w - half, b.y + b.h],
        }[side.side];
        out.lines.push({ kind: 'line', seg, color: side.c, w: side.w });
      }
    }
    return out;
  }

  // A text element becomes one text shape: its border box, the padding and border as insets, its own
  // fill/stroke (a pill, a chip, a disc) as the shape, and every rendered character grouped into the
  // lines the browser laid out.
  function text(el, cs, frame) {
    const r = el.getBoundingClientRect();
    const inset = {
      l: px(cs.paddingLeft) + px(cs.borderLeftWidth),
      r: px(cs.paddingRight) + px(cs.borderRightWidth),
      t: px(cs.paddingTop) + px(cs.borderTopWidth),
      b: px(cs.paddingBottom) + px(cs.borderBottomWidth),
    };
    const chars = [];
    const alpha = opacityOf(el);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const ps = getComputedStyle(node.parentElement);
      // An inline run with its own background is a marker highlight.
      const highlight = node.parentElement !== el && ps.display.startsWith('inline') ? color(ps.backgroundColor) : null;
      const style = {
        hl: highlight ? highlight.hex : null,
        font: family(ps.fontFamily),
        size: px(ps.fontSize),
        bold: (parseInt(ps.fontWeight, 10) || 400) >= 600,
        italic: ps.fontStyle === 'italic',
        color: faded(color(ps.color) || { hex: '000000', a: 1 }, alpha),
        ls: ps.letterSpacing === 'normal' ? 0 : px(ps.letterSpacing),
      };
      const str = node.textContent;
      for (let k = 0; k < str.length; k += 1) {
        range.setStart(node, k);
        range.setEnd(node, k + 1);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        const cr = rects[0];
        const ch = /\s/.test(str[k]) ? ' ' : str[k];
        if (ch === ' ' && cr.width === 0) continue;
        chars.push({ ch, top: cr.top, bottom: cr.bottom, left: cr.left, right: cr.right, style });
      }
    }
    const lines = [];
    for (const c of chars) {
      const cur = lines[lines.length - 1];
      const overlap = cur ? Math.min(cur.bottom, c.bottom) - Math.max(cur.top, c.top) : -1;
      // Tight leading lets two lines' glyph boxes overlap; a character that returns to the left
      // below the previous one has still wrapped.
      const prev = cur?.chars[cur.chars.length - 1];
      const wrapped = prev && c.left < prev.left - 0.5 && c.top > prev.top + 0.5;
      if (!cur || wrapped || overlap < 0.3 * Math.min(cur.bottom - cur.top, c.bottom - c.top)) {
        lines.push({ top: c.top, bottom: c.bottom, chars: [c] });
      } else {
        cur.chars.push(c);
        cur.top = Math.min(cur.top, c.top);
        cur.bottom = Math.max(cur.bottom, c.bottom);
      }
    }
    const key = (s) => JSON.stringify(s);
    const outLines = lines
      .map((line) => {
        let cs2 = line.chars;
        while (cs2.length && cs2[0].ch === ' ') cs2 = cs2.slice(1);
        while (cs2.length && cs2[cs2.length - 1].ch === ' ') cs2 = cs2.slice(0, -1);
        const runs = [];
        for (const c of cs2) {
          const last = runs[runs.length - 1];
          if (last && key(last.style) === key(c.style)) last.text += c.ch;
          else runs.push({ text: c.ch, style: c.style });
        }
        const width = cs2.length ? cs2[cs2.length - 1].right - cs2[0].left : 0;
        return { top: line.top - base.top, bottom: line.bottom - base.top, width, runs };
      })
      .filter((line) => line.runs.length);
    if (!outLines.length) return;
    const lineHeight = cs.lineHeight === 'normal' ? px(cs.fontSize) * 1.45 : px(cs.lineHeight);
    const align = { center: 'center', right: 'right', end: 'right', justify: 'left' }[cs.textAlign] || 'left';
    items.push({
      kind: 'text',
      box: rel(r),
      inset,
      frame,
      align,
      lineHeight,
      fontSize: px(cs.fontSize),
      inkW: Math.max(0, ...outLines.map((line) => line.width)),
      lines: outLines,
    });
  }

  // A real <table> becomes a native table: every cell's box, text, type, fill, padding, and rules.
  function table(el) {
    const rows = [...el.rows].map((tr) =>
      [...tr.cells].map((td) => {
        const s = getComputedStyle(td);
        const side = (name) => {
          const w = px(s[`border${name}Width`]);
          const c = color(s[`border${name}Color`]);
          return w > 0 && c && s[`border${name}Style`] !== 'none' ? { w, c: c.hex } : null;
        };
        return {
          text: td.innerText.trim(),
          box: rel(td.getBoundingClientRect()),
          font: family(s.fontFamily),
          size: px(s.fontSize),
          bold: (parseInt(s.fontWeight, 10) || 400) >= 600,
          color: color(s.color) || { hex: '000000', a: 1 },
          fill: color(s.backgroundColor) || backdrop(td),
          align: { center: 'center', right: 'right', end: 'right' }[s.textAlign] || 'left',
          pad: { t: px(s.paddingTop), r: px(s.paddingRight), b: px(s.paddingBottom), l: px(s.paddingLeft) },
          border: { t: side('Top'), r: side('Right'), b: side('Bottom'), l: side('Left') },
          span: td.colSpan > 1 ? td.colSpan : 1,
        };
      })
    );
    items.push({ kind: 'table', box: rel(el.getBoundingClientRect()), rows });
  }

  // An inline <svg> travels as its own markup at its laid-out size, currentColor resolved.
  function svg(el, cs) {
    const r = el.getBoundingClientRect();
    const clone = el.cloneNode(true);
    clone.setAttribute('width', String(r.width));
    clone.setAttribute('height', String(r.height));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const ink = color(cs.color);
    let markup = new XMLSerializer().serializeToString(clone);
    if (ink) markup = markup.replace(/currentColor/g, `#${ink.hex}`);
    if (/pathLength=/.test(markup))
      notes.push('pathLength in <svg> is not honoured by the rasterizer; write dash lengths in user units.');
    const holder = el.closest('[data-alt]');
    items.push({
      kind: 'svg',
      box: rel(r),
      markup,
      alt: holder ? holder.getAttribute('data-alt') : '',
      alpha: opacityOf(el),
    });
  }

  function picture(el, cs) {
    const r = el.getBoundingClientRect();
    const radius = Math.min(px(cs.borderTopLeftRadius), r.width / 2, r.height / 2);
    items.push({
      kind: 'image',
      box: rel(r),
      src: el.currentSrc || el.src,
      natural: { w: el.naturalWidth, h: el.naturalHeight },
      fit: cs.objectFit,
      position: cs.objectPosition,
      radius: cs.borderTopLeftRadius.trim().endsWith('%') ? Math.min(r.width, r.height) / 2 : radius,
      alt: el.getAttribute('alt') || '',
      alpha: opacityOf(el),
    });
  }

  const speakerNotes = [...slide.querySelectorAll('aside.notes')]
    .map((aside) => aside.innerText.trim())
    .filter(Boolean);

  function walk(el) {
    if (el.matches('aside.notes')) return;
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'table') return table(el);
    if (tag === 'svg') return svg(el, cs);
    if (tag === 'img') return picture(el, cs);
    // A box of text turned by a pure rotation is measured upright; PowerPoint turns the shape and its words.
    const t = turn(cs);
    const upright = Boolean(t?.pure && hasOwnText(el));
    const inline = el.style.transform;
    if (upright) el.style.transform = 'none';
    try {
      measureElement(el, cs, tag, upright ? t.deg : 0);
    } finally {
      if (upright) el.style.transform = inline;
    }
  }

  function measureElement(el, cs, tag, rotate) {
    const rich = richPaint(el, cs);
    if (rich.length) {
      // The element's own paint becomes a picture the runner takes after this read; a box of text keeps a
      // native fill under it so the words are read against their real background.
      const id = `${index}-${captures.length}`;
      el.setAttribute('data-mixdog-capture', String(id));
      captures.push({ id, reasons: rich });
      const r = el.getBoundingClientRect();
      const plain = !turn(cs) && !['clip-path', 'mask'].some((reason) => rich.includes(reason));
      items.push({
        kind: 'capture',
        id,
        box: rel(r),
        alt: el.dataset.alt || '',
        slide: el === slide,
        underlay:
          el !== slide && plain && el.textContent.trim()
            ? { box: rel(r), radius: Math.min(px(cs.borderTopLeftRadius), r.width / 2, r.height / 2), rotate }
            : null,
      });
      if (rich.includes('mix-blend-mode') || rich.includes('backdrop-filter')) {
        notes.push(
          `${rich.includes('mix-blend-mode') ? 'mix-blend-mode' : 'backdrop-filter'} on <${tag}> is drawn without the layers behind it.`
        );
      }
      if (turn(cs) && el.children.length)
        notes.push(`transform on <${tag}> with children: the children are placed as drawn but set upright.`);
    }
    const own = el === slide || rich.length ? { rect: null, lines: [] } : paint(el, cs);
    if (el.dataset.chart) {
      if (own.rect) items.push(own.rect);
      items.push(...own.lines);
      let spec = null;
      try {
        spec = JSON.parse(el.dataset.chart);
      } catch (error) {
        notes.push(`data-chart is not valid JSON: ${error.message}`);
      }
      if (spec) items.push({ kind: 'chart', box: rel(el.getBoundingClientRect()), spec, font: family(cs.fontFamily) });
      return;
    }
    if (hasOwnText(el)) {
      // An outlined chip is painted over its backdrop, so the text has a real background.
      const frame = own.rect && !own.rect.fill ? { ...own.rect, fill: backdrop(el) } : own.rect;
      const before = items.length;
      text(el, cs, frame);
      if (rotate) {
        if (items.length > before) items[items.length - 1].rotate = rotate;
        const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
        if (Math.abs(ox - el.offsetWidth / 2) > 1 || Math.abs(oy - el.offsetHeight / 2) > 1) {
          notes.push(`rotated <${tag}> turns about its centre in PowerPoint; transform-origin is not kept.`);
        }
        if (own.lines.length) notes.push(`rotated <${tag}>: its one-sided borders are drawn upright.`);
      }
      items.push(...own.lines);
      return;
    }
    if (own.rect) items.push(own.rect);
    items.push(...own.lines);
    for (const child of el.children) walk(child);
  }

  walk(slide);
  return {
    bg: color(getComputedStyle(slide).backgroundColor),
    items,
    speakerNotes: speakerNotes.join('\n\n'),
    notes: [...new Set(notes)],
    captures: captures.map((c) => c.id),
  };
}

// Leaves one marked element's own paint on an otherwise empty, transparent page (its text and children
// hidden), or restores the page with id null.
function isolateCapture(id) {
  let style = document.getElementById('mixdog-isolate');
  if (!style) {
    style = document.createElement('style');
    style.id = 'mixdog-isolate';
    document.head.appendChild(style);
  }
  const target = `section.slide[data-mixdog-capture="${id}"], section.slide [data-mixdog-capture="${id}"]`;
  style.textContent =
    id === null
      ? ''
      : `html, body { background: transparent !important; }
         section.slide, section.slide * { visibility: hidden !important; }
         ${target} { visibility: visible !important; color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }
         ${target
           .split(', ')
           .map((s) => `${s} *`)
           .join(', ')} { visibility: hidden !important; }`;
}

// Shows one slide at a time whatever the deck's own CSS does with the others.
function showSlide(index) {
  document.querySelectorAll('section.slide').forEach((section, other) => {
    section.classList.toggle('active', other === index);
    section.style.display = other === index ? '' : 'none';
    if (other === index && getComputedStyle(section).display === 'none') section.style.display = 'block';
  });
}

// <i data-icon="name" data-sw="1.75"> becomes the offline Lucide SVG, sized by the <i>'s CSS box
// and stroked in its CSS color.
export function injectIcons(table, viewBox) {
  const missing = [];
  for (const i of document.querySelectorAll('i[data-icon]')) {
    const markup = table[String(i.dataset.icon || '').toLowerCase()];
    if (!markup) {
      missing.push(i.dataset.icon);
      continue;
    }
    const box = document.createElement('span');
    box.className = i.className;
    box.setAttribute('style', i.getAttribute('style') || '');
    if (i.dataset.alt) box.dataset.alt = i.dataset.alt;
    else box.dataset.alt = i.dataset.icon;
    if (!box.style.display) box.style.display = 'block';
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="${i.dataset.sw || 2}" stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`;
    i.replaceWith(box);
  }
  return missing;
}

const CAPTURE_SCALE = 2;

// Each marked element photographed alone at twice the canvas density on a transparent page, trimmed to
// what it painted (shadows, pseudo-elements and turned corners included): id → { png, box } in CSS px.
async function captureRichPaint(page, slideBox, ids, canvas) {
  const out = new Map();
  if (!ids.length) return out;
  const sharp = require('sharp');
  await page.setViewport(viewport(canvas, CAPTURE_SCALE));
  try {
    for (const id of ids) {
      await page.evaluate(isolateCapture, id);
      // Runtimes with Uint8Array.fromBase64 get a plain Uint8Array back, whose toString is not base64.
      const shot = Buffer.from(
        await page.screenshot({
          clip: { x: slideBox.x, y: slideBox.y, width: canvas.width, height: canvas.height },
          omitBackground: true,
          type: 'png',
        })
      );
      // A shot the element covers edge to edge comes back without an alpha channel: it is the whole page.
      const { channels } = await sharp(shot).stats();
      const alpha = channels[3];
      if (alpha && alpha.max === 0) continue;
      if (!alpha || alpha.min === 255) {
        out.set(id, {
          png: shot.toString('base64'),
          draw: { x: 0, y: 0, w: canvas.width, h: canvas.height },
        });
        continue;
      }
      const { data, info } = await sharp(shot).trim({ threshold: 0 }).png().toBuffer({ resolveWithObject: true });
      const left = -(info.trimOffsetLeft || 0);
      const top = -(info.trimOffsetTop || 0);
      out.set(id, {
        png: data.toString('base64'),
        draw: {
          x: left / CAPTURE_SCALE,
          y: top / CAPTURE_SCALE,
          w: info.width / CAPTURE_SCALE,
          h: info.height / CAPTURE_SCALE,
        },
      });
    }
  } finally {
    await page.evaluate(isolateCapture, null);
    await page.setViewport(viewport(canvas, 1));
  }
  return out;
}

/** The offline Lucide table `injectIcons` takes, keyed by icon name. */
export function iconTable() {
  const icons = iconGlobal();
  return { icons, table: Object.fromEntries(icons.names.map((name) => [name, icons(name)])) };
}

/**
 * Lays out an HTML deck in a local browser and measures it.
 * @param {string} html the deck
 * @param {{ sourcePath: string, shotPath: (page: number) => string, timeoutMs?: number, signal?: AbortSignal,
 *   prepare?: (page: object) => Promise<object> }} options
 *   sourcePath: where the HTML is written before loading (beside the deck, so relative <img> paths resolve)
 *   prepare: run on the loaded page; returns the canvas (`HTML_CANVAS` shape) the slides are measured on
 * @returns {Promise<{ width: number, height: number, inchWidth: number, inchHeight: number, slides: object[], shots: string[], notes: string[], geometry: object[] }>}
 *   geometry: per slide with findings, `{ slide, findings }` from pptx-html-geometry.mjs
 */
export async function measureHtmlDeck(
  html,
  { sourcePath, shotPath, timeoutMs = 90_000, signal = null, prepare = null }
) {
  await writeFile(sourcePath, html, 'utf8');
  const browser = await launchHtmlBrowser('pptx-html-browser');
  const work = async () => {
    const page = await browser.newPage();
    await page.setViewport(viewport(HTML_CANVAS, 1));
    await page.goto(pathToFileURL(sourcePath).href, { waitUntil: 'load' });
    const canvas = prepare ? await prepare(page) : HTML_CANVAS;
    if (canvas !== HTML_CANVAS) await page.setViewport(viewport(canvas, 1));
    const { icons, table } = iconTable();
    const missing = await page.evaluate(injectIcons, table, '0 0 24 24');
    if (missing.length) {
      const hint = missing.map((name) => {
        try {
          icons(name);
          return name;
        } catch (error) {
          return error.message;
        }
      });
      throw new Error(`Unknown data-icon: ${hint.join(' ')}`);
    }
    const count = await page.$$eval('section.slide', (sections) => sections.length);
    if (!count)
      throw new Error(
        `The HTML holds no <section class="slide">; every page is one section.slide on a ${canvas.width}×${canvas.height} canvas.`
      );
    const slides = [];
    const shots = [];
    const notes = [];
    const geometry = [];
    for (let index = 0; index < count; index += 1) {
      await page.evaluate(showSlide, index);
      await page.evaluate(() => document.fonts.ready);
      const element = (await page.$$('section.slide'))[index];
      const box = await element.boundingBox();
      if (Math.round(box.width) !== canvas.width || Math.round(box.height) !== canvas.height) {
        throw new Error(
          `slide ${index + 1} measures ${Math.round(box.width)}×${Math.round(box.height)} px; every section.slide is exactly ${canvas.width}×${canvas.height}.`
        );
      }
      const shot = shotPath(index + 1);
      await element.screenshot({ path: shot });
      shots.push(shot);
      const measured = await page.evaluate(extractSlide, index);
      for (const note of measured.notes) notes.push(`slide ${index + 1}: ${note}`);
      const findings = await page.evaluate(readGeometry, index, GEOMETRY_TOLERANCE_PX, NEAR_MISS_PX);
      if (findings.length) geometry.push({ slide: index + 1, findings });
      const drawn = await captureRichPaint(page, box, measured.captures, canvas);
      const items = measured.items
        .map((item) => {
          if (item.kind !== 'capture') return item;
          const paint = drawn.get(item.id);
          return paint ? { ...item, ...paint } : null;
        })
        .filter(Boolean);
      slides.push({ bg: measured.bg, items, notes: measured.speakerNotes });
    }
    return { ...canvas, slides, shots, notes, geometry };
  };
  return runInBrowser(browser, { signal, timeoutMs }, work);
}
