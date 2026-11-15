// The Excel HTML route, first half: each <section data-sheet="이름"> is one worksheet the browser lays out, and this
// page function reads it back as what a grid can hold — every text (a title, a card's figure and label, a table cell)
// with its box, type, alignment and value or formula; every filled or ruled box; charts and pictures by their boxes.
// xlsx-html-build.mjs turns the distinct edges of those boxes into the sheet's columns and rows, so a CSS grid of
// cards becomes cells, merges, fills and native charts on a column grid that reproduces it.

/**
 * Runs inside the page (page.evaluate): self-contained.
 * @returns {{ sheets: object[], notes: string[], captures: number }}
 */
function extractXlsxSheets() {
  const PT = 0.75;
  const n = (value) => parseFloat(value) || 0;
  const notes = [];
  let captures = 0;
  const hex = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!match) return null;
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(parseFloat);
    const alpha = parts.length > 3 ? parts[3] : 1;
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
  const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy']);
  const face = (cs) => {
    const first = String(cs.fontFamily || '')
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    return GENERIC.has(first.toLowerCase()) ? '' : first;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const side = (cs, name) => {
    const width = n(cs[`border${name}Width`]);
    const style = cs[`border${name}Style`];
    const color = hex(cs[`border${name}Color`]);
    if (!(width > 0) || ['none', 'hidden'].includes(style) || !color) return null;
    return {
      style: width >= 2.5 ? 'medium' : style === 'dashed' ? 'dashed' : style === 'dotted' ? 'dotted' : 'thin',
      color,
    };
  };
  const bordersOf = (cs) => {
    const sides = {
      top: side(cs, 'Top'),
      right: side(cs, 'Right'),
      bottom: side(cs, 'Bottom'),
      left: side(cs, 'Left'),
    };
    return Object.values(sides).some(Boolean) ? sides : null;
  };
  const describe = (el) =>
    `<${el.localName}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}>`;
  const alignOf = (cs) => {
    const value = String(cs.textAlign || '');
    if (value === 'center') return 'center';
    if (value === 'right' || value === 'end') return 'right';
    return 'left';
  };
  const typeOf = (cs) => {
    const weight = Number(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : 400);
    return {
      font: face(cs),
      size: Math.round(n(cs.fontSize) * PT * 2) / 2,
      bold: weight >= 600,
      italic: cs.fontStyle === 'italic',
      color: hex(cs.color) || '000000',
    };
  };
  const textOf = (el) =>
    (el.innerText || el.textContent || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
  const hasBlockChildren = (el) =>
    [...el.children].some(
      (child) =>
        visible(child) &&
        !['inline', 'inline-block', 'contents'].includes(getComputedStyle(child).display) &&
        child.localName !== 'br'
    );
  const hasOwnText = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
  // Lines counted from the text's own height: a cell stretched by its row (a table that is a grid item stretches to
  // the tallest item beside it) holds one line in a tall box.
  const lines = (el, cs) => {
    const line = cs.lineHeight === 'normal' ? n(cs.fontSize) * 1.25 : n(cs.lineHeight);
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set(
      [...range.getClientRects()]
        .filter((rect) => rect.width > 0)
        .map((rect) => Math.round(rect.top / Math.max(1, line / 2)))
    );
    const height = range.getBoundingClientRect().height;
    return Math.max(1, tops.size > 1 ? Math.round(height / Math.max(1, line)) : 1);
  };

  const sheets = [];
  for (const section of document.querySelectorAll('section[data-sheet]')) {
    if (!visible(section)) continue;
    const origin = section.getBoundingClientRect();
    const rel = (r) => ({
      left: r.left - origin.left,
      top: r.top - origin.top,
      right: r.right - origin.left,
      bottom: r.bottom - origin.top,
    });
    const sectionPadding = getComputedStyle(section);
    const sheet = {
      name: section.dataset.sheet,
      width: origin.width,
      height: origin.height,
      padRight: n(sectionPadding.paddingRight),
      padBottom: n(sectionPadding.paddingBottom),
      gridlines: section.dataset.gridlines === 'show',
      freeze: section.dataset.freeze || '',
      fit: section.dataset.fit || '',
      orientation: section.dataset.orientation || '',
      hidden: section.dataset.hidden === 'true',
      texts: [],
      boxes: [],
      tables: [],
      charts: [],
      pictures: [],
    };
    const sectionStyle = getComputedStyle(section);
    sheet.font = face(sectionStyle);
    const cellValue = (el) => {
      const value = { text: textOf(el), ...(el.id ? { id: el.id } : {}) };
      if (el.dataset.formula) value.formula = el.dataset.formula;
      if (el.dataset.value !== undefined) value.value = el.dataset.value;
      if (el.dataset.format) value.format = el.dataset.format;
      if (el.dataset.note) value.note = el.dataset.note;
      return value;
    };
    const textItem = (el, cs, extra = {}) => {
      const rect = rel(el.getBoundingClientRect());
      sheet.texts.push({
        rect,
        ...cellValue(el),
        ...typeOf(cs),
        align: alignOf(cs),
        lines: lines(el, cs),
        indent: alignOf(cs) === 'left' && n(cs.paddingLeft) >= 6 ? 1 : 0,
        ...extra,
      });
    };
    const boxItem = (el, cs) => {
      const fill = hex(cs.backgroundColor);
      const borders = bordersOf(cs);
      if (fill || borders)
        sheet.boxes.push({
          rect: rel(el.getBoundingClientRect()),
          ...(fill ? { fill } : {}),
          ...(borders ? { borders } : {}),
        });
    };
    const walk = (el) => {
      for (const child of el.children) {
        if (!visible(child)) continue;
        const cs = getComputedStyle(child);
        const tag = child.localName;
        if (['absolute', 'fixed'].includes(cs.position))
          notes.push(
            `${sheet.name} ${describe(child)}: position ${cs.position} is placed where it lies; check the cell it lands on`
          );
        if (child.hasAttribute('data-chart')) {
          let spec = null;
          try {
            spec = JSON.parse(child.dataset.chart);
          } catch (error) {
            notes.push(`${sheet.name} ${describe(child)}: data-chart is not valid JSON (${error.message})`);
          }
          if (spec)
            sheet.charts.push({
              rect: rel(child.getBoundingClientRect()),
              spec,
              range: child.dataset.range || '',
              title: child.dataset.title || spec.title || '',
              font: face(cs),
              alt: child.dataset.alt || '',
            });
          continue;
        }
        if (tag === 'img' || tag === 'svg' || tag === 'canvas') {
          captures += 1;
          child.setAttribute('data-xlsx-capture', String(captures));
          sheet.pictures.push({
            rect: rel(child.getBoundingClientRect()),
            capture: captures,
            alt: child.getAttribute('alt') || child.getAttribute('aria-label') || child.dataset.alt || '',
          });
          continue;
        }
        if (tag === 'table') {
          const table = {
            name: child.dataset.table || '',
            style: child.dataset.tableStyle || '',
            rect: rel(child.getBoundingClientRect()),
            freezeHeader: child.dataset.freeze === 'header',
            rows: [],
          };
          for (const row of child.rows) {
            if (!visible(row)) continue;
            const cells = [];
            for (const cell of row.cells) {
              if (!visible(cell)) continue;
              const ccs = getComputedStyle(cell);
              const fill = hex(ccs.backgroundColor) || hex(getComputedStyle(row).backgroundColor);
              const rect = rel(cell.getBoundingClientRect());
              const valign = { top: 'top', bottom: 'bottom' }[ccs.verticalAlign] || '';
              cells.push({
                rect,
                ...cellValue(cell),
                ...typeOf(ccs),
                align: alignOf(ccs),
                ...(valign ? { valign } : {}),
                lines: lines(cell, ccs),
                header: cell.localName === 'th' || row.parentElement === child.tHead,
                ...(fill ? { fill } : {}),
                ...(bordersOf(ccs) ? { borders: bordersOf(ccs) } : {}),
                indent: alignOf(ccs) === 'left' && n(ccs.paddingLeft) >= 6 ? 1 : 0,
              });
              // A spanning cell merges across the rows its box covers; an Excel table (data-table) holds no merges.
              if ((cell.rowSpan > 1 || cell.colSpan > 1) && child.dataset.table)
                notes.push(`${sheet.name}: a data-table cannot merge; the spanning cell keeps its first cell`);
            }
            table.rows.push(cells);
          }
          sheet.tables.push(table);
          continue;
        }
        boxItem(child, cs);
        if (hasBlockChildren(child)) walk(child);
        else if (textOf(child)) textItem(child, cs);
        if (hasOwnText(child) && hasBlockChildren(child))
          notes.push(`${sheet.name} ${describe(child)}: text beside blocks is left out; wrap it in its own element`);
      }
    };
    walk(section);
    sheets.push(sheet);
  }
  return { sheets, notes, captures };
}
