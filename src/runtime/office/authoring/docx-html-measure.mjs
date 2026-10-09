// The Word HTML route, first half: the browser lays the document out at the printable width of its @page sheet and
// this page function reads it back as Word's own flow — paragraphs with their runs, tables (data tables, and the flex
// or grid rows a layout draws, as borderless tables), boxes (a filled or bordered block, as a one-cell table), lists,
// pictures, and the vertical space between blocks as the browser measured it. docx-html-build.mjs writes the flow as
// native WordprocessingML. The approach follows dom-docx (computed styles from Chromium, flex rows as borderless
// tables, boxes as one-cell tables); CSS that has no place in Word's flow (position, transform) is reported, not drawn.

/**
 * Runs inside the page (page.evaluate): self-contained. Reads document.body as Word blocks.
 * @returns {{ blocks: object[], header: object|null, footer: object|null, body: object, notes: string[], captures: number }}
 */
export function extractDocxFlow() {
  const PT = 0.75;
  const pt = (px) => Math.round(px * PT * 100) / 100;
  const n = (value) => parseFloat(value) || 0;
  const notes = [];
  let captures = 0;
  let lists = 0;
  const styles = new Map();
  const gcs = (el) => {
    if (!styles.has(el)) styles.set(el, getComputedStyle(el));
    return styles.get(el);
  };
  // A colour as Word writes it: six hex digits, a translucent one laid over white; null for none.
  const hex = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!match) return null;
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((part) => (part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part)));
    const alpha = parts.length > 3 ? (match[1].includes('/') || parts[3] <= 1 ? parts[3] : parts[3] / 255) : 1;
    if (!(alpha > 0.04)) return null;
    return [0, 1, 2]
      .map((index) =>
        Math.round(parts[index] * alpha + 255 * (1 - alpha))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
      .toUpperCase();
  };
  const GENERIC = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-sans-serif',
    'ui-serif',
  ]);
  const face = (cs) => {
    const first = String(cs.fontFamily || '')
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    return GENERIC.has(first.toLowerCase()) ? '' : first;
  };
  // Word sets Hangul in the run's East Asian face, so that face is the first family of the stack that carries
  // Hangul or CJK — the one the browser fell back to — not the stack's Latin lead ("Georgia, 'Noto Serif KR'").
  // A stack with no such family in a Korean document takes the system face of the stack's class.
  const CJK_FAMILY =
    /(\bKR\b|\bJP\b|\bSC\b|\bTC\b|\bHK\b|CJK|Korean|Malgun|맑은|Batang|바탕|Gulim|굴림|Dotum|돋움|Gungsuh|궁서|Nanum|나눔|Pretendard|Spoqa|Apple SD Gothic|AppleMyungjo|Source Han|본고딕|본명조|Gowun|Yu Gothic|Yu Mincho|Meiryo|MS Gothic|MS Mincho|YaHei|SimSun|SimHei|DengXian|PingFang|Hiragino|JhengHei)/i;
  const SERIF_FAMILY = /(Georgia|Cambria|Times|Garamond|Book Antiqua|Palatino|Constantia|Serif|Myungjo|Mincho)/i;
  let koreanDocument = null;
  // A family renders Hangul itself when it is installed (its Latin metrics differ from a generic's) and its drawn
  // Hangul matches none of the system fallbacks a Latin-only face gets (Chromium picks the fallback per primary
  // face, so several Latin references and the generics are compared). Pixels, not advance widths: Hangul is set on
  // a near-uniform em advance in most Korean faces, so widths rarely differ.
  const GENERIC_FAMILY = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[\w-]+|emoji|math|fangsong)$/i;
  const GENERIC_CLASSES = ['serif', 'sans-serif', 'monospace'];
  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 120;
  probeCanvas.height = 40;
  const hangulProbe = probeCanvas.getContext('2d', { willReadFrequently: true });
  const hangulCover = new Map();
  const glyphs = (stack) => {
    hangulProbe.clearRect(0, 0, probeCanvas.width, probeCanvas.height);
    hangulProbe.font = `28px ${stack}`;
    hangulProbe.textBaseline = 'top';
    hangulProbe.fillText('한글가', 2, 4);
    const { data } = hangulProbe.getImageData(0, 0, probeCanvas.width, probeCanvas.height);
    let alpha = '';
    for (let index = 3; index < data.length; index += 4) alpha += String.fromCharCode(data[index]);
    return alpha;
  };
  const latinWidth = (stack) => {
    hangulProbe.font = `28px ${stack}`;
    return hangulProbe.measureText('mmmmmmmmmmlli').width;
  };
  let fallbackGlyphs = null;
  const rendersHangul = (family) => {
    if (GENERIC_FAMILY.test(family)) return false;
    if (!hangulCover.has(family)) {
      const quoted = `"${family.replace(/"/g, '')}"`;
      const installed = GENERIC_CLASSES.some((generic) => latinWidth(`${quoted}, ${generic}`) !== latinWidth(generic));
      fallbackGlyphs ??= ['"Arial"', '"Times New Roman"', '"Courier New"', ...GENERIC_CLASSES].map(glyphs);
      const own = installed ? glyphs(quoted) : '';
      hangulCover.set(family, installed && fallbackGlyphs.every((reference) => own !== reference));
    }
    return hangulCover.get(family);
  };
  const eastAsiaFace = (cs) => {
    const families = String(cs.fontFamily || '')
      .split(',')
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    if (koreanDocument === null) koreanDocument = /[\uAC00-\uD7A3]/.test(document.body.textContent || '');
    // CSS order: the first family that is a known CJK face or (in a Korean document) renders Hangul wins.
    const cjk = families.find((family) => CJK_FAMILY.test(family) || (koreanDocument && rendersHangul(family)));
    if (cjk) return cjk;
    if (!koreanDocument) return '';
    const serif = families.some((family) => family.toLowerCase() === 'serif') || SERIF_FAMILY.test(families[0] || '');
    return serif ? 'Batang' : 'Malgun Gothic';
  };
  const describe = (el) => {
    const classes =
      typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return `<${el.localName}${classes}>${text ? ` "${text}"` : ''}`;
  };
  const visible = (el) => {
    const cs = gcs(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const BLOCK = new Set(['block', 'flex', 'grid', 'table', 'list-item', 'flow-root', 'table-row-group', 'table-row']);
  const blockChildren = (el) => [...el.children].filter((child) => visible(child) && BLOCK.has(gcs(child).display));
  const contentBox = (el) => {
    const cs = gcs(el);
    const r = el.getBoundingClientRect();
    return {
      left: r.left + n(cs.borderLeftWidth) + n(cs.paddingLeft),
      right: r.right - n(cs.borderRightWidth) - n(cs.paddingRight),
      top: r.top + n(cs.borderTopWidth) + n(cs.paddingTop),
      bottom: r.bottom - n(cs.borderBottomWidth) - n(cs.paddingBottom),
    };
  };
  const side = (cs, name) => {
    const width = n(cs[`border${name}Width`]);
    const style = cs[`border${name}Style`];
    const color = hex(cs[`border${name}Color`]);
    if (!(width > 0) || style === 'none' || style === 'hidden' || !color) return null;
    return { width: pt(width), color, style: ['dashed', 'dotted', 'double'].includes(style) ? style : 'single' };
  };
  const borders = (cs) => {
    const sides = {
      top: side(cs, 'Top'),
      left: side(cs, 'Left'),
      bottom: side(cs, 'Bottom'),
      right: side(cs, 'Right'),
    };
    return Object.values(sides).some(Boolean) ? sides : null;
  };
  const decorated = (cs) => Boolean(hex(cs.backgroundColor)) || Boolean(borders(cs));
  const checkUnsupported = (el, cs) => {
    if (['absolute', 'fixed'].includes(cs.position)) {
      notes.push(`${describe(el)}: position ${cs.position} has no place in Word's flow; it was left out`);
      return true;
    }
    if (cs.transform && cs.transform !== 'none')
      notes.push(`${describe(el)}: transform is not carried to Word; drawn upright`);
    if (n(cs.columnCount) > 1) notes.push(`${describe(el)}: CSS columns are not carried; the text runs in one column`);
    return false;
  };

  // The runs of a block's inline content, in its own type.
  const runStyle = (el) => {
    const cs = gcs(el);
    const weight = Number(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : 400);
    const decoration = String(cs.textDecorationLine || cs.textDecoration || '');
    const inlineFill = ['inline', 'inline-block'].includes(cs.display) ? hex(cs.backgroundColor) : null;
    return {
      font: face(cs),
      fontEastAsia: eastAsiaFace(cs),
      size: pt(n(cs.fontSize)),
      bold: weight >= 600,
      italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
      underline: decoration.includes('underline'),
      strike: decoration.includes('line-through'),
      color: hex(cs.color) || '000000',
      ...(inlineFill ? { shading: inlineFill } : {}),
      ...(['super', 'sub'].includes(cs.verticalAlign)
        ? { vertAlign: cs.verticalAlign === 'super' ? 'superscript' : 'subscript' }
        : {}),
      transform: cs.textTransform,
    };
  };
  const collectRuns = (node, runs, skip = () => false) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.replace(/[\t\n\r ]+/g, ' ');
        if (!text) continue;
        const style = runStyle(child.parentElement);
        let value = text;
        if (style.transform === 'uppercase') value = value.toUpperCase();
        else if (style.transform === 'lowercase') value = value.toLowerCase();
        const { transform: _transform, ...format } = style;
        runs.push({ text: value, ...format });
        continue;
      }
      if (child.nodeType !== 1 || !visible(child) || skip(child)) continue;
      const tag = child.localName;
      if (tag === 'br') {
        runs.push({ br: true });
        continue;
      }
      if (['img', 'svg', 'canvas'].includes(tag)) {
        notes.push(`${describe(child)}: a picture inside a line of text is left out; set it as a block of its own`);
        continue;
      }
      collectRuns(child, runs, skip);
    }
  };
  // Whitespace as the browser collapses it: one space between words, none at a line's ends.
  const tidyRuns = (runs) => {
    const out = [];
    for (const run of runs) {
      if (run.br) {
        if (out.length && out.at(-1).text) out.at(-1).text = out.at(-1).text.replace(/ $/, '');
        out.push(run);
        continue;
      }
      let text = run.text;
      const previous = out.at(-1);
      if (!previous || previous.br || / $/.test(previous.text || '')) text = text.replace(/^ /, '');
      if (text) out.push({ ...run, text });
    }
    while (out.length && out[0].br) out.shift();
    if (out.length && out.at(-1).text) out.at(-1).text = out.at(-1).text.replace(/ $/, '');
    return out.filter((run) => run.br || run.text);
  };
  const alignOf = (cs) => {
    const value = String(cs.textAlign || '');
    if (value === 'center') return 'center';
    if (value === 'right' || value === 'end') return 'right';
    if (value === 'justify') return 'both';
    return 'left';
  };
  const lineOf = (cs) => (cs.lineHeight === 'normal' ? pt(n(cs.fontSize) * 1.3) : pt(n(cs.lineHeight)));

  const paragraphOf = (el, frame, extra = {}) => {
    const cs = gcs(el);
    const runs = tidyRuns(
      (() => {
        const list = [];
        collectRuns(el, list, extra.skip);
        return list;
      })()
    );
    const box = contentBox(el);
    const tag = el.localName;
    const level = /^h([1-6])$/.exec(tag)?.[1];
    const ownBorders = extra.noDecoration ? null : borders(cs);
    const fill = extra.noDecoration ? null : hex(cs.backgroundColor);
    return {
      kind: 'p',
      tag,
      ...(level ? { heading: Number(level) } : {}),
      runs,
      align: alignOf(cs),
      line: lineOf(cs),
      size: pt(n(cs.fontSize)),
      indentLeft: Math.max(0, pt(box.left - frame.left)),
      indentRight: Math.max(0, pt(frame.right - box.right)),
      firstLine: pt(n(cs.textIndent)),
      keepNext: Boolean(level) || cs.breakAfter === 'avoid' || cs.pageBreakAfter === 'avoid',
      keepLines: cs.breakInside === 'avoid' || cs.pageBreakInside === 'avoid',
      ...(fill ? { shading: fill } : {}),
      ...(ownBorders
        ? {
            borders: ownBorders,
            borderSpace: {
              top: pt(n(cs.paddingTop)),
              left: pt(n(cs.paddingLeft)),
              bottom: pt(n(cs.paddingBottom)),
              right: pt(n(cs.paddingRight)),
            },
          }
        : {}),
      // Word sets a top or bottom rule and its gap (the padding) on the paragraph itself, so the space around it is
      // measured from the rule's outer edge: from the text, the rule's gap and width were counted twice.
      top: extra.top ?? (ownBorders?.top ? el.getBoundingClientRect().top : box.top),
      bottom: extra.bottom ?? (ownBorders?.bottom ? el.getBoundingClientRect().bottom : box.bottom),
      ...(extra.list ? { list: extra.list } : {}),
    };
  };

  // A grid of cells from their boxes: the columns are the distinct vertical edges, so a flex row of cards, a CSS grid,
  // and a data table with colspans all become one Word grid; a gap between cells is a column of its own, left empty.
  const gridTable = (cells, frame, { data = false } = {}) => {
    const rows = [];
    for (const cell of [...cells].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
      const row = rows.find(
        (entry) => Math.abs(entry.top - cell.rect.top) <= 2 && (data ? entry.tr === cell.tr : true)
      );
      if (row) {
        row.cells.push(cell);
        row.bottom = Math.max(row.bottom, cell.rect.bottom);
      } else
        rows.push({ top: cell.rect.top, bottom: cell.rect.bottom, cells: [cell], tr: cell.tr, header: cell.header });
    }
    const edges = [];
    const addEdge = (x) => {
      if (!edges.some((edge) => Math.abs(edge - x) <= 1)) edges.push(x);
    };
    for (const cell of cells) {
      addEdge(cell.rect.left);
      addEdge(cell.rect.right);
    }
    edges.sort((a, b) => a - b);
    const edgeIndex = (x) => edges.findIndex((edge) => Math.abs(edge - x) <= 1);
    const columns = edges.slice(1).map((edge, index) => pt(edge - edges[index]));
    const outRows = [];
    rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) {
        const gap = row.top - rows[rowIndex - 1].bottom;
        if (gap > 1) outRows.push({ spacer: true, height: pt(gap) });
      }
      const placed = [];
      let at = 0;
      for (const cell of row.cells.sort((a, b) => a.rect.left - b.rect.left)) {
        const start = edgeIndex(cell.rect.left);
        const end = edgeIndex(cell.rect.right);
        if (start > at) placed.push({ span: start - at, empty: true });
        placed.push({ ...cell.content, span: Math.max(1, end - start) });
        at = Math.max(at, end);
      }
      if (at < columns.length) placed.push({ span: columns.length - at, empty: true });
      outRows.push({ height: pt(row.bottom - row.top), header: Boolean(row.header), cells: placed });
    });
    return {
      kind: 'table',
      data,
      indent: Math.max(0, pt(edges[0] - frame.left)),
      columns,
      rows: outRows,
      top: rows[0]?.top ?? 0,
      bottom: rows.at(-1)?.bottom ?? 0,
    };
  };

  // A cell's own decoration and its content, read as a flow inside its padding.
  // `given` blocks stand in for the element's own flow (a decorated row's grid, already read).
  const cellOf = (el, { tr = null, header = false, given = null } = {}) => {
    const cs = gcs(el);
    const rect = el.getBoundingClientRect();
    const inner = contentBox(el);
    const fill = hex(cs.backgroundColor) || (tr ? hex(gcs(tr).backgroundColor) : null);
    const blocks = given ? [...given] : [];
    if (!given && blockChildren(el).length) flow(el, inner, blocks);
    else if (!given) blocks.push(paragraphOf(el, inner, { noDecoration: true }));
    spaceBlocks(blocks, inner.top);
    const vertical = cs.verticalAlign === 'middle' ? 'center' : cs.verticalAlign === 'bottom' ? 'bottom' : 'top';
    const centred = ['center'].includes(cs.alignItems) && /flex|grid/.test(cs.display) ? 'center' : vertical;
    return {
      rect,
      tr,
      header,
      content: {
        ...(fill ? { fill } : {}),
        ...(borders(cs) ? { borders: borders(cs) } : {}),
        padding: {
          top: pt(n(cs.paddingTop) + n(cs.borderTopWidth)),
          left: pt(n(cs.paddingLeft) + n(cs.borderLeftWidth)),
          bottom: pt(n(cs.paddingBottom) + n(cs.borderBottomWidth)),
          right: pt(n(cs.paddingRight) + n(cs.borderRightWidth)),
        },
        vAlign: centred,
        blocks,
      },
    };
  };

  const sideBySide = (children) =>
    children.some((a, i) =>
      children.some(
        (b, j) =>
          i !== j &&
          a.getBoundingClientRect().right <= b.getBoundingClientRect().left + 1 &&
          Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) <
            Math.max(a.getBoundingClientRect().height, 1)
      )
    );

  const listBlocks = (list, level, frame, out) => {
    const ordered = list.localName === 'ol';
    lists += 1;
    const instance = lists;
    for (const item of list.children) {
      if (item.localName !== 'li' || !visible(item)) continue;
      const cs = gcs(item);
      const marked = cs.listStyleType !== 'none';
      const nested = [...item.children].filter((child) => ['ul', 'ol'].includes(child.localName));
      const box = contentBox(item);
      const bottom = nested.length ? nested[0].getBoundingClientRect().top : box.bottom;
      out.push(
        paragraphOf(item, frame, {
          skip: (child) => ['ul', 'ol'].includes(child.localName),
          top: box.top,
          bottom,
          ...(marked ? { list: { kind: ordered ? 'number' : 'bullet', level, instance: ordered ? instance : 0 } } : {}),
        })
      );
      for (const sub of nested) listBlocks(sub, Math.min(level + 1, 2), frame, out);
    }
  };

  const pictureOf = (el, frame) => {
    const rect = el.getBoundingClientRect();
    const tag = el.localName;
    const picture = {
      kind: 'image',
      width: pt(rect.width),
      height: pt(rect.height),
      indent: Math.max(0, pt(rect.left - frame.left)),
      alt: el.getAttribute('alt') || el.getAttribute('aria-label') || el.dataset?.alt || '',
      top: rect.top,
      bottom: rect.bottom,
    };
    if (tag === 'img' && !/^data:image\/svg/.test(el.currentSrc || '')) {
      picture.src = el.currentSrc || el.getAttribute('src') || '';
    } else {
      captures += 1;
      el.setAttribute('data-docx-capture', String(captures));
      picture.capture = captures;
    }
    // A picture centred in its column is set centred, so it stays centred when the reader edits the margins.
    if (
      Math.abs(rect.left - frame.left - (frame.right - rect.right)) <= 2 &&
      rect.width < frame.right - frame.left - 4
    ) {
      picture.align = 'center';
      picture.indent = 0;
    }
    return picture;
  };

  // The blocks of one container, in order, each carrying its top and bottom in px for the spacing pass.
  function flow(container, frame, out) {
    let pendingBreak = false;
    const anonymous = [];
    const flushText = () => {
      if (!anonymous.length) return;
      const range = document.createRange();
      range.setStartBefore(anonymous[0]);
      range.setEndAfter(anonymous.at(-1));
      const textRect = range.getBoundingClientRect();
      const runs = [];
      for (const node of anonymous) {
        if (node.nodeType === 3) {
          const text = node.textContent.replace(/[\t\n\r ]+/g, ' ');
          if (text.trim()) {
            const { transform: _t, ...format } = runStyle(container);
            runs.push({ text, ...format });
          }
        } else collectRuns({ childNodes: [node] }, runs);
      }
      anonymous.length = 0;
      const tidy = tidyRuns(runs);
      if (!tidy.length) return;
      const cs = gcs(container);
      out.push({
        kind: 'p',
        tag: 'p',
        runs: tidy,
        align: alignOf(cs),
        line: lineOf(cs),
        size: pt(n(cs.fontSize)),
        indentLeft: 0,
        indentRight: 0,
        firstLine: 0,
        top: textRect.top,
        bottom: textRect.bottom,
      });
    };
    for (const node of container.childNodes) {
      if (node.nodeType === 3) {
        if (node.textContent.trim()) anonymous.push(node);
        continue;
      }
      if (node.nodeType !== 1 || !visible(node)) continue;
      const el = node;
      const cs = gcs(el);
      if (!BLOCK.has(cs.display) && !['table', 'ul', 'ol', 'hr', 'img', 'svg', 'canvas'].includes(el.localName)) {
        anonymous.push(el);
        continue;
      }
      flushText();
      if (checkUnsupported(el, cs)) continue;
      const before = out.length;
      const breakHere = pendingBreak || cs.breakBefore === 'page' || cs.pageBreakBefore === 'always';
      pendingBreak = cs.breakAfter === 'page' || cs.pageBreakAfter === 'always';
      const tag = el.localName;
      if (tag === 'img' || tag === 'svg' || tag === 'canvas' || el.hasAttribute('data-docx-picture'))
        out.push(pictureOf(el, frame));
      else if (tag === 'table') {
        const cells = [];
        const head = el.tHead;
        for (const row of el.rows) {
          if (!visible(row)) continue;
          for (const cell of row.cells)
            if (visible(cell)) cells.push(cellOf(cell, { tr: row, header: row.parentElement === head }));
        }
        if (cells.length) {
          const table = gridTable(cells, frame, { data: true });
          table.keepTogether = cs.breakInside === 'avoid';
          out.push(table);
        }
      } else if (tag === 'ul' || tag === 'ol') listBlocks(el, 0, frame, out);
      else if (tag === 'hr') {
        const rect = el.getBoundingClientRect();
        const rule = side(cs, 'Top') ||
          side(cs, 'Bottom') || { width: 0.75, color: hex(cs.color) || '999999', style: 'single' };
        out.push({
          kind: 'p',
          tag: 'hr',
          runs: [],
          align: 'left',
          line: 1,
          size: 1,
          indentLeft: Math.max(0, pt(rect.left - frame.left)),
          indentRight: Math.max(0, pt(frame.right - rect.right)),
          firstLine: 0,
          borders: { bottom: rule },
          top: rect.top,
          bottom: rect.bottom,
        });
      } else {
        const kids = blockChildren(el);
        const row =
          /flex/.test(cs.display) && !/column/.test(cs.flexDirection) ? kids : cs.display === 'grid' ? kids : null;
        if (row && row.length >= 2 && sideBySide(row)) {
          // A row of cards: the container's own fill or border wraps the grid as an outer one-cell table.
          const table = gridTable(
            row.map((child) => cellOf(child)),
            contentBox(el)
          );
          if (decorated(cs)) {
            out.push(gridTable([cellOf(el, { given: [table] })], frame));
          } else {
            table.indent = Math.max(0, table.indent + pt(contentBox(el).left - frame.left));
            out.push(table);
          }
        } else if (decorated(cs) && (kids.length || n(cs.paddingTop) + n(cs.paddingLeft) > 3)) {
          out.push(gridTable([cellOf(el)], frame));
        } else if (kids.length) {
          flow(el, frame, out);
        } else {
          const paragraph = paragraphOf(el, frame);
          if (paragraph.runs.length || paragraph.borders || paragraph.shading) out.push(paragraph);
        }
      }
      if (breakHere && out.length > before) out[before].pageBreakBefore = true;
    }
    flushText();
  }

  // Space between blocks as the browser laid it: a paragraph takes the gap above it as its own space before; a table
  // has none, so the gap above it goes to the paragraph before it, or to a spacer paragraph.
  function spaceBlocks(blocks, top) {
    const spaced = [];
    let previousBottom = top;
    for (const block of blocks) {
      const gap = pt(Math.max(0, block.top - previousBottom));
      if (block.kind === 'table') {
        const previous = spaced.at(-1);
        if (gap > 0.5 && previous && previous.kind !== 'table') previous.after = (previous.after || 0) + gap;
        else if (gap > 0.5) spaced.push({ kind: 'spacer', height: gap });
      } else block.before = gap;
      spaced.push(block);
      previousBottom = Math.max(previousBottom, block.bottom);
    }
    blocks.splice(0, blocks.length, ...spaced);
  }

  const running = (tag) => {
    const el = [...document.body.children].find((child) => child.localName === tag);
    if (!el) return null;
    const textEl =
      [...el.querySelectorAll('*')].find(
        (child) =>
          child.childNodes.length &&
          [...child.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())
      ) || el;
    const cs = gcs(textEl);
    const result = {
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
      font: face(cs),
      fontEastAsia: eastAsiaFace(cs),
      size: pt(n(cs.fontSize)),
      color: hex(cs.color) || '000000',
      bold: (Number(cs.fontWeight) || 400) >= 600,
      align: alignOf(cs),
      firstPage: el.dataset.firstPage || el.getAttribute('data-first-page') || '',
    };
    el.style.setProperty('display', 'none', 'important');
    return result;
  };
  const header = running('header');
  const footer = running('footer');
  const bodyStyle = gcs(document.body);
  const frame = contentBox(document.body);
  const blocks = [];
  flow(document.body, frame, blocks);
  spaceBlocks(blocks, frame.top);
  return {
    blocks,
    header,
    footer,
    body: {
      font: face(bodyStyle),
      fontEastAsia: eastAsiaFace(bodyStyle),
      size: pt(n(bodyStyle.fontSize)),
      color: hex(bodyStyle.color) || '000000',
      line: lineOf(bodyStyle),
    },
    notes,
    captures,
  };
}
