// The runs of a table cell that holds links: `full` is the text the browser shows for the cell (its trimmed
// `innerText`, line breaks included), cut into the parts a link covers and the parts none does. Each visible text node
// is found in `full` in order, so hidden text and breaks come out exactly as `innerText` has them; a cell whose runs
// would not rebuild `full` (text-transform, say) answers no runs and stays plain text.
function linkedCellRuns(td, full) {
  const view = td.ownerDocument.defaultView;
  const hidden = (node) => {
    for (let el = node.parentElement; el; el = el.parentElement) {
      const cs = view.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (el === td) return false;
    }
    return false;
  };
  const runs = [];
  const push = (text, href) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && (last.href || '') === href) last.text += text;
    else runs.push(href ? { text, href } : { text });
  };
  const walker = td.ownerDocument.createTreeWalker(td, 4);
  // Offsets found in folded text are cut from `full`, so the fold must keep every length: a character that folds to
  // more (İ) would shift each link after it onto the wrong part.
  const fold = (text) => text.toLowerCase();
  const lower = fold(full);
  if (lower.length !== full.length) return [];
  let at = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (hidden(node)) continue;
    // Only the HTML whitespace collapses: a non-breaking space stays what `full` has. One at the cell's very edge is
    // cut from `full` by its trim, so the piece is tried without it when it is not found whole.
    const whole = node.textContent.replace(/[ \t\n\r\f]+/g, ' ').replace(/^ | $/g, '');
    if (!whole.trim()) continue;
    const anchor = node.parentElement.closest('a[href]');
    const href = anchor && /^(https?|mailto|tel):/i.test(anchor.href) ? anchor.href : '';
    // Whichever form occurs first from the cursor on, so a later label of the same text is never taken for this one.
    const found = [whole, whole.trim()]
      .filter((form) => fold(form).length === form.length)
      .map((form) => ({ piece: form, start: lower.indexOf(fold(form), at) }))
      .filter((hit) => hit.start >= 0)
      .sort((a, b) => a.start - b.start)[0];
    if (!found) return [];
    const { piece, start } = found;
    const gap = full.slice(at, start);
    const last = runs[runs.length - 1];
    push(gap, last && last.href === href && !gap.includes('\n') ? href : '');
    push(full.slice(start, start + piece.length), href);
    at = start + piece.length;
  }
  push(full.slice(at), '');
  return runs.map((run) => run.text).join('') === full ? runs : [];
}

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
      const anchor = node.parentElement.closest('a[href]');
      const href = anchor && /^(https?|mailto|tel):/i.test(anchor.href) ? anchor.href : '';
      const style = {
        ...(href ? { href } : {}),
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
        const full = td.innerText.trim();
        // A cell with a link keeps its text as runs, each with its own target.
        const runs = td.querySelector('a[href]') ? linkedCellRuns(td, full) : [];
        return {
          text: full,
          ...(runs.length ? { runs } : {}),
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
function injectIcons(table, viewBox) {
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
