import { fontFamilyKey, isMotifShape } from '../design/design-discipline.mjs';
import { annotatePptxSnapshotRoles } from '../design/library/design-template-induct.mjs';
import { auditXlsxFormulas } from '../portable/xlsx-formula-audit.mjs';

export function issue(code, path, message, source = 'format-review', severity = 'warning') {
  return { severity, code, path, message, source };
}

// A heading is read as a heading because its type leads the body's, and one
// level carries one type through the document. A heading set at the body size
// with no weight of its own, or a level set two ways, is a hierarchy the reader
// cannot see however correct the styles behind it are.
const HEADING_TYPE_TOLERANCE = 0.05;

function paragraphSize(paragraph) {
  return Number(paragraph?.font?.size) || 0;
}

function reviewDocxHeadingType(content, headings, issues) {
  const bodySizes = content
    .filter((paragraph) => headingLevel(paragraph) === null)
    .map(paragraphSize)
    .filter((size) => size > 0)
    .sort((left, right) => left - right);
  const body = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 0;
  const byLevel = new Map();
  for (const { paragraph, level } of headings) {
    const size = paragraphSize(paragraph);
    if (!size) continue;
    byLevel.set(level, [...(byLevel.get(level) || []), { paragraph, size }]);
    if (body && size <= body && !paragraph.font?.bold) {
      issues.push(
        issue(
          'heading_not_distinct',
          paragraph.path || '/body',
          `Heading is set at ${size} pt against ${body} pt body text and carries no weight of its own; the hierarchy is not visible.`
        )
      );
    }
  }
  for (const [level, members] of byLevel) {
    const sizes = members.map((entry) => entry.size);
    if (members.length < 2 || Math.max(...sizes) <= Math.min(...sizes) * (1 + HEADING_TYPE_TOLERANCE)) continue;
    issues.push(
      issue(
        'heading_style_inconsistent',
        members[1].paragraph.path || '/body',
        `Level ${level} headings are set at ${[...new Set(sizes)].sort((left, right) => left - right).join(' / ')} pt; one level carries one type.`
      )
    );
  }
}

function headingLevel(paragraph) {
  const style = String(paragraph?.style || '');
  if (!/(?:title|heading|제목|표제)/i.test(style)) return null;
  if (/(?:title|제목|표제)/i.test(style) && !/(?:heading|제목\s*\d)/i.test(style)) return 0;
  const level = Number(/([1-9])/.exec(style)?.[1]);
  return Number.isInteger(level) ? level : 1;
}

function wordBlockOrder(document) {
  const blocks =
    Array.isArray(document?.blockOrder) && document.blockOrder.length
      ? document.blockOrder.map((entry) => ({ ...entry, start: Number(entry.start) }))
      : [
          ...(document?.paragraphs || []).map((entry) => ({
            type: 'paragraph',
            index: entry.index,
            path: entry.path,
            start: Number(entry.start),
          })),
          ...(document?.tables || []).map((entry) => ({
            type: 'table',
            index: entry.index,
            path: entry.path,
            start: Number(entry.start),
          })),
        ];
  if (blocks.every((entry) => Number.isFinite(entry.start))) {
    blocks.sort((left, right) => left.start - right.start);
  }
  return blocks;
}

function reviewDocxStructure(document) {
  const issues = [];
  const paragraphs = Array.isArray(document?.paragraphs) ? document.paragraphs : [];
  const tables = Array.isArray(document?.tables) ? document.tables : [];
  const content = paragraphs.filter((paragraph) => paragraph?.inTable !== true && String(paragraph.text || '').trim());
  const headings = content
    .map((paragraph) => ({ paragraph, level: headingLevel(paragraph) }))
    .filter((entry) => entry.level !== null);
  reviewDocxHeadingType(content, headings, issues);
  if (content.length >= 8 && headings.length === 0) {
    issues.push(
      issue(
        'heading_hierarchy_missing',
        '/body',
        'Document has substantial content but no visible title or heading hierarchy.'
      )
    );
  }
  let priorLevel = null;
  for (const { paragraph, level } of headings) {
    if (priorLevel !== null && level > priorLevel + 1) {
      issues.push(
        issue(
          'heading_hierarchy_jump',
          paragraph.path || '/body',
          `Heading level jumps from ${priorLevel} to ${level}.`
        )
      );
    }
    priorLevel = level;
  }
  const paragraphsByIndex = new Map(paragraphs.map((entry) => [Number(entry.index), entry]));
  const tablesByIndex = new Map(tables.map((entry) => [Number(entry.index), entry]));
  const order = wordBlockOrder(document);
  for (let index = 0; index < order.length; index += 1) {
    const block = order[index];
    if (block.type !== 'paragraph') continue;
    const paragraph = paragraphsByIndex.get(Number(block.index));
    if (paragraph?.inTable === true || headingLevel(paragraph) === null || !String(paragraph?.text || '').trim())
      continue;
    const nextBlock = order.slice(index + 1).find((entry) => {
      if (entry.type === 'table') return true;
      return String(paragraphsByIndex.get(Number(entry.index))?.text || '').trim();
    });
    const next =
      nextBlock?.type === 'table'
        ? tablesByIndex.get(Number(nextBlock.index))
        : paragraphsByIndex.get(Number(nextBlock?.index));
    const headingPage = Number(paragraph?.pageStart || paragraph?.page);
    const nextPage = Number(next?.pageStart || next?.page);
    if (!nextBlock || (headingPage > 0 && nextPage > 0 && headingPage !== nextPage)) {
      issues.push(
        issue('orphan_heading', paragraph.path || '/body', 'Heading is separated from the content it introduces.')
      );
    }
  }
  for (const paragraph of content) {
    if (String(paragraph.text || '').length > 900) {
      issues.push(
        issue('dense_paragraph', paragraph.path || '/body', 'Paragraph is too dense for fast document scanning.')
      );
    }
  }
  // Machine tells: a bullet typed as text and a newline inside a paragraph
  // both read as authoring by string instead of by structure.
  for (const paragraph of content) {
    const text = String(paragraph.text || '');
    if (/^[•·●▪◦■*-]\s/.test(text)) {
      issues.push(
        issue(
          'literal_bullet',
          paragraph.path || '/body',
          'Paragraph starts with a typed bullet character; a list marker comes from list formatting (listKind, set_list), never from text.'
        )
      );
    }
    // A soft break reads back as a newline too, and Word draws that one as a
    // line break; only the newlines beyond the paragraph's breaks are the typed
    // ones that collapse to a space.
    const newlines = (text.match(/\n/g) || []).length;
    if (newlines > (Number(paragraph.softBreaks) || 0)) {
      issues.push(
        issue(
          'newline_in_text',
          paragraph.path || '/body',
          'Paragraph text carries a newline character, which Word renders as a space; split it into separate paragraphs.'
        )
      );
    }
  }
  for (const table of tables) {
    const pageStart = Number(table.pageStart);
    const pageEnd = Number(table.pageEnd);
    const rows = Array.isArray(table.rows) ? table.rows.length : 0;
    if (rows > 0 && rows <= 6 && pageStart > 0 && pageEnd > 0 && pageStart !== pageEnd) {
      issues.push(
        issue(
          'short_table_split',
          table.path || '/body',
          `A ${rows}-row table is split across pages ${pageStart}-${pageEnd}.`
        )
      );
    }
  }
  return issues;
}

function cellRow(ref) {
  return Number(/([1-9]\d*)$/.exec(String(ref || '').replaceAll('$', ''))?.[1] || 0);
}

function formulaRanges(formula) {
  const ranges = [];
  for (const match of String(formula || '').matchAll(/\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)/gi)) {
    ranges.push({
      startColumn: columnIndex(match[1]),
      start: Number(match[2]),
      endColumn: columnIndex(match[3]),
      end: Number(match[4]),
    });
  }
  return ranges;
}

// How far a series may stop above the data before the gap reads as a deliberate
// window rather than as the row someone forgot to include.
const CHART_SHORT_ROWS = 2;

function cellColumn(ref) {
  return columnIndex(/^\$?([A-Z]{1,3})/i.exec(String(ref || ''))?.[1] || '');
}

// A number the sheet holds, whatever notation it wears; a note or a label under
// the table is text and is not data the chart left out.
function numericCell(cell) {
  const raw = String(cell?.value ?? '').trim();
  if (!raw) return false;
  return Number.isFinite(Number(raw.replaceAll(',', '').replace(/%$/, '')));
}

function columnIndex(label) {
  let index = 0;
  for (const character of String(label).toUpperCase()) index = index * 26 + (character.charCodeAt(0) - 64);
  return index;
}

// A print area is one or more A1 ranges; Excel prints each as its own page set.
function printAreas(reference) {
  return String(reference || '')
    .split(',')
    .map((part) => {
      const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(part.trim());
      if (!match) return null;
      return {
        startColumn: columnIndex(match[1]),
        startRow: Number(match[2]),
        endColumn: columnIndex(match[3] || match[1]),
        endRow: Number(match[4] || match[2]),
      };
    })
    .filter(Boolean);
}

function reviewXlsxStructure(document, auditProfile = '') {
  const issues = [];
  const sheets = Array.isArray(document?.sheets) ? document.sheets : [];
  for (const sheet of sheets) {
    const cells = Array.isArray(sheet.cells) ? sheet.cells : [];
    if (cells.length >= 8) {
      const styled = cells.filter((cell) => cell.style && Object.keys(cell.style).length);
      if (styled.length === 0) {
        issues.push(
          issue(
            'worksheet_hierarchy_missing',
            sheet.path || `/sheet[${sheet.name || ''}]`,
            'Data sheet has no styled title, header, table, or visual hierarchy.'
          )
        );
      }
    }
    const totalRows = new Set(
      cells
        .filter((cell) =>
          /^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))/i.test(String(cell.value || '').trim())
        )
        .map((cell) => cellRow(cell.ref))
        .filter(Boolean)
    );
    for (const cell of cells) {
      if (/^#(?:DIV\/0|VALUE|REF|NAME|N\/A|NUM|NULL|SPILL|CALC|FIELD)\??!?$/i.test(String(cell.value || '').trim())) {
        issues.push(
          issue(
            'formula_error',
            cell.path || `${sheet.path || `/sheet[${sheet.name || ''}]`}/cell[${cell.ref || ''}]`,
            `Formula evaluates to ${cell.value}.`,
            'format-review',
            'error'
          )
        );
      }
    }
    for (const chart of sheet.charts || []) {
      const formulas = (chart.series || [])
        .flatMap((series) => [series.formula, series.categoryFormula, series.valueFormula])
        .filter(Boolean);
      const included = [...totalRows].find((row) =>
        formulas.some((formula) => formulaRanges(formula).some((range) => row >= range.start && row <= range.end))
      );
      if (included) {
        issues.push(
          issue(
            'chart_includes_total_row',
            chart.path || `${sheet.path || `/sheet[${sheet.name || ''}]`}/chart`,
            `Chart source includes total or subtotal row ${included}; separate summary rows from comparison series.`
          )
        );
      }
      // The opposite error renders just as cleanly: a series that stops one row
      // above the data draws a picture the sheet does not support. A chart
      // showing a deliberate window stops far short, and a total row is left
      // out on purpose, so only the last row or two count.
      const ranges = formulas.flatMap((formula) => formulaRanges(formula));
      const lastRead = ranges.length ? Math.max(...ranges.map((range) => range.end)) : 0;
      const readColumns = ranges.length
        ? {
            first: Math.min(...ranges.map((range) => range.startColumn)),
            last: Math.max(...ranges.map((range) => range.endColumn)),
          }
        : null;
      const missed = readColumns
        ? cells
            .filter((cell) => {
              const row = cellRow(cell.ref);
              const column = cellColumn(cell.ref);
              return (
                row > lastRead &&
                !totalRows.has(row) &&
                column >= readColumns.first &&
                column <= readColumns.last &&
                numericCell(cell)
              );
            })
            .map((cell) => cellRow(cell.ref))
        : [];
      const lastData = missed.length ? Math.max(...missed) : 0;
      if (lastRead && lastData && lastData - lastRead <= CHART_SHORT_ROWS) {
        issues.push(
          issue(
            'chart_stops_short_of_data',
            chart.path || `${sheet.path || `/sheet[${sheet.name || ''}]`}/chart`,
            `Chart source stops at row ${lastRead} while the columns it reads hold data through row ${lastData}; widen the series range.`
          )
        );
      }
    }
    const rows = Number(sheet.rows) || 0;
    const columns = Number(sheet.columns) || 0;
    const pageSetup = sheet.pageSetup || {};
    if ((rows >= 40 || columns >= 12) && Number(pageSetup.fitToPagesWide) !== 1 && Number(pageSetup.zoom) > 100) {
      issues.push(
        issue(
          'worksheet_print_fit_missing',
          sheet.path || `/sheet[${sheet.name || ''}]`,
          'Large worksheet has no one-page-wide print fit and uses an enlarged print zoom.'
        )
      );
    }
    // A chart or picture the print area leaves out is cut in half by the page
    // break, and a sheet with no print area at all paginates around it.
    const areas = printAreas(pageSetup.printArea);
    const drawings = [
      ...(sheet.charts || []).map((entry) => ({ kind: 'Chart', entry })),
      ...(sheet.images || []).map((entry) => ({ kind: 'Picture', entry })),
    ].filter((item) => Number(item.entry?.anchor?.endColumn) > 0);
    for (const { kind, entry } of drawings.slice(0, 3)) {
      const anchor = entry.anchor;
      const inside = areas.some(
        (area) =>
          Number(anchor.startColumn) >= area.startColumn &&
          Number(anchor.startRow) >= area.startRow &&
          Number(anchor.endColumn) <= area.endColumn &&
          Number(anchor.endRow) <= area.endRow
      );
      if (inside) continue;
      // A sheet fitted to one page wide exports whole with or without a print
      // area; a declared print area that leaves the drawing out cuts it.
      if (!areas.length && Number(pageSetup.fitToPagesWide) === 1) continue;
      issues.push(
        issue(
          'drawing_outside_print_area',
          entry.path || sheet.path || `/sheet[${sheet.name || ''}]`,
          areas.length
            ? `${kind} spans ${anchor.from}:${anchor.to}, past the print area ${pageSetup.printArea}; a print or PDF export cuts it.`
            : `${kind} spans ${anchor.from}:${anchor.to} and the sheet declares no print area or one-page-wide fit, so an export may paginate through it.`,
          'format-review',
          areas.length ? 'warning' : 'info'
        )
      );
    }
    // Two drawings on one cell block hide each other: a second chart anchored
    // inside the first one's rows prints as one chart drawn over another.
    for (let first = 0; first < drawings.length; first += 1) {
      for (let second = first + 1; second < drawings.length; second += 1) {
        const left = drawings[first].entry.anchor;
        const right = drawings[second].entry.anchor;
        const columns =
          Math.min(Number(left.endColumn), Number(right.endColumn)) -
          Math.max(Number(left.startColumn), Number(right.startColumn));
        const rows =
          Math.min(Number(left.endRow), Number(right.endRow)) - Math.max(Number(left.startRow), Number(right.startRow));
        if (columns < 1 || rows < 1) continue;
        issues.push(
          issue(
            'drawing_overlap',
            drawings[second].entry.path || sheet.path || `/sheet[${sheet.name || ''}]`,
            `${drawings[second].kind} spans ${right.from}:${right.to}, over the ${drawings[first].kind.toLowerCase()} at ${left.from}:${left.to}; place it below or beside it.`,
            'format-review',
            'warning'
          )
        );
      }
    }
  }
  for (const finding of auditXlsxFormulas(sheets, { auditProfile })) {
    issues.push(issue(finding.code, finding.path, finding.message, 'format-review', finding.severity));
  }
  return issues;
}

function overlapRatio(left, right) {
  const width = Math.max(
    0,
    Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left)
  );
  const height = Math.max(
    0,
    Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top)
  );
  const smallest = Math.min(left.width * left.height, right.width * right.height);
  return smallest > 0 ? (width * height) / smallest : 0;
}

function officeColorRgb(value) {
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/u, '');
    if (/^[0-9a-f]{6}$/iu.test(hex)) {
      return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  const color = Number(value);
  if (!Number.isFinite(color) || color < 0 || color > 0xffffff) return null;
  return [color & 255, (color >> 8) & 255, (color >> 16) & 255];
}

function relativeLuminance(rgb) {
  if (!rgb) return null;
  const channels = rgb.map((entry) => {
    const channel = entry / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function colorContrastRatio(left, right) {
  const leftLuminance = relativeLuminance(officeColorRgb(left));
  const rightLuminance = relativeLuminance(officeColorRgb(right));
  if (!Number.isFinite(leftLuminance) || !Number.isFinite(rightLuminance)) return null;
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

// A PowerPoint session reports a fill as fillColor with its transparency; a
// portable snapshot reports it as fill: { color }. Reading only the first left
// every card, band and field on an authored deck invisible to the checks that
// ask what a text or a chart sits on, and a fill with no transparency recorded
// is an opaque fill.
function solidShapeFill(shape) {
  const color = shape?.fillColor ?? shape?.fill?.color;
  const transparency = Number(shape?.fillTransparency ?? shape?.fill?.transparency ?? 0);
  if (!officeColorRgb(color) || !Number.isFinite(transparency) || transparency >= 0.2) return null;
  return color;
}

function containingSurface(textShape, shapes) {
  const centerX = textShape.left + textShape.width / 2;
  const centerY = textShape.top + textShape.height / 2;
  return (
    (shapes || [])
      .filter(
        (shape) =>
          Number(shape?.index) < Number(textShape.index) &&
          !String(shape?.text || '').trim() &&
          solidShapeFill(shape) != null &&
          Number(shape.left) <= centerX &&
          Number(shape.top) <= centerY &&
          Number(shape.left) + Number(shape.width) >= centerX &&
          Number(shape.top) + Number(shape.height) >= centerY
      )
      .sort(
        (left, right) => Number(left.width) * Number(left.height) - Number(right.width) * Number(right.height)
      )[0] || null
  );
}

// Presentation body copy stays at 12 pt or more, but page chrome (kickers,
// page badges, captions, source lines) is legitimately smaller and may sit
// closer to the edge. Chrome is a short line at caption size; anything
// longer is body copy whatever its size.
const PPTX_BODY_MIN_PT = 12;
const PPTX_CHROME_MIN_PT = 9;
const PPTX_EDGE_PT = 18;
const PPTX_CHROME_EDGE_PT = 10;
const PPTX_CHROME_MAX_CHARS = 90;

// Slide-number fields (master placeholders) carry their size in the field run,
// which the snapshot does not always surface; the numeral itself is the chrome.
const PPTX_PAGE_NUMBER = /^\s*(?:\d+\s*(?:\/|of)\s*\d+|\d{1,3})\s*$/i;

function isPptxChromeText(shape) {
  const text = String(shape.text || '').trim();
  const fontSize = Number(shape.font?.size) || 0;
  if (shape.placeholder && PPTX_PAGE_NUMBER.test(text)) return true;
  return fontSize > 0 && fontSize <= PPTX_BODY_MIN_PT && text.length <= PPTX_CHROME_MAX_CHARS && !/[\r\n]/.test(text);
}

// A numeral or short lead directly above its own description is one unit
// (a hero number and its label, a step number and its detail); the tight gap
// is the design, not a spacing defect.
// Near-miss alignment: an element a few points off an axis the slide already
// shares reads as a mistake, not as a decision — the eye registers the step
// without being able to name it. The reference axis must already be held by two
// other edges, so a deliberate offset never trips this; only the almost-aligned
// element does.
const PPTX_AXIS_SNAP_PT = 1;
const PPTX_AXIS_DRIFT_PT = 6;
// The kit's icon bands: glyph 0.3 in, marker 0.45 in (kit.md §5) — a picture that small is a mark inside a unit.
const PPTX_INLINE_ICON_PT = 36;
// A picture is `p:pic` in the portable snapshot and msoPicture (13) in the COM one (pptx-receipt.mjs isPicture);
// PowerPoint reports a picture that carries an SVG source (the kit's icons) as msoGraphic (28).
const isPptxInlineIcon = (shape) =>
  (shape.picture || shape.image || shape.type === 'p:pic' || Number(shape.type) === 13 || Number(shape.type) === 28) &&
  Math.max(Number(shape.width) || 0, Number(shape.height) || 0) <= PPTX_INLINE_ICON_PT;
const PPTX_AXIS_MEMBERS = 2;
const PPTX_AXIS_REPORTS_PER_SLIDE = 3;

// An edge is compared only with edges of its own kind: left edges make a column,
// tops make a row, centres make a spine. A left edge that lands near an unrelated
// shape's right edge is two objects meeting, not a broken axis.
const PPTX_AXIS_KINDS = Object.freeze(['left edge', 'centre', 'right edge', 'top edge', 'middle', 'bottom edge']);

// A line has no width or no height, so its two edges and its centre are one
// position. Registering that single position as three different kinds would let
// any box's edge drift against a rule it has nothing to do with, so the collapsed
// dimension reports its centre only; the drawn dimension keeps both ends.
function pptxShapeAxes(shape) {
  const flat = { x: shape.width === 0, y: shape.height === 0 };
  return [
    ...(flat.x
      ? []
      : [
          ['left edge', shape.left],
          ['right edge', shape.left + shape.width],
        ]),
    ['centre', shape.left + shape.width / 2],
    ...(flat.y
      ? []
      : [
          ['top edge', shape.top],
          ['bottom edge', shape.top + shape.height],
        ]),
    ['middle', shape.top + shape.height / 2],
  ];
}

// The axes the slide itself establishes: positions three or more shapes already
// share, to the point, on the same kind of edge. A pair is a coincidence; a third
// shape makes it the slide's grid, which is what a drifting element breaks.
function pptxEstablishedAxes(shapes) {
  const axes = new Map(PPTX_AXIS_KINDS.map((kind) => [kind, []]));
  const members = new Map(PPTX_AXIS_KINDS.map((kind) => [kind, []]));
  for (const shape of shapes) {
    for (const [kind, value] of pptxShapeAxes(shape)) members.get(kind).push({ value, shape });
  }
  for (const kind of PPTX_AXIS_KINDS) {
    const entries = members.get(kind).sort((left, right) => left.value - right.value);
    let cluster = [];
    const flush = () => {
      if (new Set(cluster.map((entry) => entry.shape)).size >= PPTX_AXIS_MEMBERS) {
        axes.get(kind).push(cluster.reduce((sum, entry) => sum + entry.value, 0) / cluster.length);
      }
      cluster = [];
    };
    for (const entry of entries) {
      if (cluster.length && entry.value - cluster[0].value > PPTX_AXIS_SNAP_PT) flush();
      cluster.push(entry);
    }
    flush();
  }
  return axes;
}

// A row of identical cards is read as one rhythm, so the gaps between them are
// part of the shape: neighbours spaced by hand differ by a few points and the eye
// registers a wobble it cannot name. Only cards of the same size on the same row
// band qualify — measured text boxes and mixed objects have honest reasons to
// differ, and a deliberately varied row is never three identical rectangles.
const PPTX_ROW_BAND_PT = 2;
const PPTX_ROW_SIZE_RATIO = 0.02;
const PPTX_ROW_GAP_RATIO = 0.05;
const PPTX_ROW_GAP_PT = 2;
// A gap half again wider than its peers is a break between groups — the reader
// sees two clusters, which is a composition. Only the near-miss is the defect.
const PPTX_ROW_BREAK_RATIO = 1.5;
// The gaps carry the rhythm only while they are small beside the objects they
// separate: a row of cards is read as one band, but small markers (icons, dots)
// spread across wide columns are positioned by those columns, and the distance
// between them is a consequence, not a measurement anyone made.
const PPTX_ROW_GAP_TO_WIDTH = 0.5;

function pptxPeerRows(shapes) {
  const rows = [];
  for (const shape of shapes) {
    if (!(shape.width > 0 && shape.height > 0)) continue;
    const row = rows.find(
      ([first]) =>
        Math.abs(first.top - shape.top) <= PPTX_ROW_BAND_PT &&
        Math.abs(first.height - shape.height) <= Math.max(1, first.height * PPTX_ROW_SIZE_RATIO) &&
        Math.abs(first.width - shape.width) <= Math.max(1, first.width * PPTX_ROW_SIZE_RATIO)
    );
    if (row) row.push(shape);
    else rows.push([shape]);
  }
  return rows.filter((row) => row.length >= 3).map((row) => [...row].sort((left, right) => left.left - right.left));
}

function pptxRowGapSpread(row) {
  const gaps = row.slice(1).map((shape, index) => shape.left - (row[index].left + row[index].width));
  if (gaps.some((gap) => gap <= 0)) return null;
  const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const smallest = Math.min(...gaps);
  const largest = Math.max(...gaps);
  const spread = largest - smallest;
  if (largest > (row[0].width || 0) * PPTX_ROW_GAP_TO_WIDTH) return null;
  if (spread <= PPTX_ROW_GAP_PT || spread <= average * PPTX_ROW_GAP_RATIO) return null;
  if (largest >= smallest * PPTX_ROW_BREAK_RATIO) return null;
  return { smallest, largest, average, count: row.length };
}

function pptxAxisDrift(shape, axes) {
  for (const [kind, value] of pptxShapeAxes(shape)) {
    const candidates = axes.get(kind) || [];
    if (candidates.some((axis) => Math.abs(axis - value) <= PPTX_AXIS_SNAP_PT)) continue;
    const axis = candidates.find((candidate) => Math.abs(candidate - value) <= PPTX_AXIS_DRIFT_PT);
    if (axis != null) return { name: kind, offset: Math.abs(axis - value), axis };
  }
  return null;
}

// A figure and the words that name it sit close on purpose, whichever way round
// the page sets them: a value over its caption, or a short label introducing the
// number under it. The label is short and the sizes say which line is which; a
// stat pair reported as crowded sent the next fix round after the one grouping
// the page had right.
const LABEL_UNIT_CHARS = 16;
// The kicker is the other half of that pair and it is not short: an eyebrow line sits a hair over the title it
// introduces, and the two read as one head — every reference deck sets them that way, and the kit draws them so.
// It is recognised by its type, not its length: one line, at most three fifths of the size of the line under it.
const KICKER_SIZE_SHARE = 0.6;
const LABEL_UNIT_WIDTH_SHARE = 0.6;
const LABEL_HEADING_CHARS = 28;

function isPptxKickerOverTitle(upper, lower) {
  const upperSize = Number(upper.font?.size) || 0;
  const lowerSize = Number(lower.font?.size) || 0;
  const upperHeight = Number(upper.height) || 0;
  if (!upperSize || !lowerSize || upperSize > lowerSize * KICKER_SIZE_SHARE) return false;
  // One line of that size, with the slack a text box carries around its own line.
  return upperHeight > 0 && upperHeight <= (upperSize / 72) * 1.2 * 1.9 * 72;
}

function isPptxLabelledUnit(left, right) {
  const [upper, lower] = left.top <= right.top ? [left, right] : [right, left];
  const upperText = String(upper.text || '').trim();
  const upperSize = Number(upper.font?.size) || 0;
  const lowerSize = Number(lower.font?.size) || 0;
  if (!upperSize || !lowerSize) return false;
  if (isPptxKickerOverTitle(upper, lower)) return true;
  // A heading line over the detail it names is the same unit as a figure over its caption; what marks it is the step
  // in type, not a short string. Held to one line of label length, so a paragraph crowding another is still reported.
  const stepped = upperSize >= lowerSize * 1.2 || lowerSize >= upperSize * 1.2;
  if (stepped && !upperText.includes('\n') && upperText.length <= LABEL_HEADING_CHARS) return true;
  if (upperText.length > LABEL_UNIT_CHARS) return false;
  if (stepped) return true;
  // Two lines a step apart in size are still a label and its detail when the measure says so: a short line in a box
  // little more than half the width of the paragraph under it is the name of that paragraph, not a block of copy
  // crowding it (the card title over its body, which the reference decks set tight on purpose).
  const upperWidth = Number(upper.width) || 0;
  const lowerWidth = Number(lower.width) || 0;
  return upperWidth > 0 && lowerWidth > 0 && upperWidth <= lowerWidth * LABEL_UNIT_WIDTH_SHARE;
}

// A row of peers is read as one set: the reader takes boxes that look alike to
// belong together, so column titles at 20 pt beside one at 18 pt read as a
// mistake rather than as emphasis. The page's own geometry says which boxes
// form the row.
const PEER_TYPE_TOLERANCE = 0.05;
const PEER_WIDTH_SHARE = 0.6;
const PEER_SLOT = /^((?:column|metric|step)-(?:title|body|value|label|detail))-\d+$/;
// A page that fits its words is not a page anyone reads from a seat: past the
// top of every reference body page and covering half the canvas, the slide is a
// document being projected. Two readings at once keep a table page and a long
// quotation out of it.
const TEXT_WALL_CHARS = 900;
const TEXT_WALL_COVERAGE = 0.45;

function shapeFaces(shape) {
  const names = Array.isArray(shape.fonts) ? shape.fonts : [shape.font?.name];
  return names.map(fontFamilyKey).filter(Boolean);
}

// How much of a text box an opaque object may cover before the words behind it
// stop being read.
const TEXT_OCCLUSION_SHARE = 0.25;

// Slack an auto-fitting text box carries below its last line: two boxes in one
// column may share this much without a reader seeing it. Past it the lines are
// in each other's space.
const PPTX_TEXT_COLLISION_PT = 4;

function isPptxPicture(shape) {
  return Boolean(shape?.picture || shape?.image || shape?.type === 'p:pic' || Number(shape?.type) === 13);
}

// The kit signs the glow it draws under a hero object; it is a gradient that ends at zero alpha, not a plane.
function isHaloDevice(shape) {
  return String(shape?.name || shape?.objectName || '') === 'mixdog-device:glow';
}

// Two or more series drawn in two or more colours are read by whatever names
// them: the chart's legend, labels carrying the series name, or the page's own
// words (a deck often sets its legend beside the chart as text, which is a
// legend the reader can read). With none of those the colours mean nothing, and
// the chart is a picture of a difference nobody can attribute.
function reviewPptxChartSeriesNaming(slide, shape, issues) {
  const chart = shape?.chart;
  if (!chart || Number(chart.seriesCount) < 2) return;
  if (chart.legend !== false || chart.seriesNamesShown === true) return;
  const names = (chart.series || [])
    .map((series) => String(series?.name || '').trim())
    .filter((name) => name.length > 1);
  if (names.length < 2) return;
  const words = (slide.shapes || [])
    .filter((entry) => entry !== shape)
    .map((entry) => String(entry.text || ''))
    .join('\n');
  if (names.every((name) => words.includes(name))) return;
  issues.push(
    issue(
      'chart_series_unnamed',
      chart.path || `${shape.path || slide.path}/chart`,
      `${names.length} series (${names.slice(0, 3).join(', ')}) are told apart by colour alone: the chart draws no legend, its labels carry no series name, and the page does not name them either.`
    )
  );
}

function reviewPptxPeerType(slide, issues) {
  const groups = new Map();
  for (const shape of slide.shapes || []) {
    const role = PEER_SLOT.exec(String(shape.slot || ''))?.[1];
    if (!role || !String(shape.text || '').trim()) continue;
    groups.set(role, [...(groups.get(role) || []), shape]);
  }
  const path = slide.path || `/slide[${slide.index}]`;
  for (const [role, members] of groups) {
    if (members.length < 2) continue;
    // Peers in one row hold the same column: a 140 pt label beside a 665 pt lead
    // line is a label and its sentence, and reading them as one set reported the
    // grammar the page had right.
    const widths = members.map((shape) => Number(shape.width) || 0);
    if (Math.min(...widths) < Math.max(...widths) * PEER_WIDTH_SHARE) continue;
    const sizes = members.map((shape) => Number(shape.font?.size) || 0).filter((size) => size > 0);
    if (sizes.length === members.length && Math.max(...sizes) > Math.min(...sizes) * (1 + PEER_TYPE_TOLERANCE)) {
      issues.push(
        issue(
          'peer_style_inconsistent',
          path,
          `The ${role} boxes are set at ${[...new Set(sizes)].sort((left, right) => left - right).join(' / ')} pt; peers in one row read as one set.`
        )
      );
      continue;
    }
    const faces = new Set(members.flatMap(shapeFaces));
    if (faces.size > 1) {
      issues.push(
        issue('peer_style_inconsistent', path, `The ${role} boxes mix ${[...faces].join(', ')}; peers in one row carry one face.`)
      );
    }
  }
}

// A page of boxes all set in one size has no voice the eye reaches first. The
// induction names a title only where one box leads the rest, so a text page of
// several boxes that induced none is a page with no hierarchy to see — a
// statement or a captioned picture is not, since neither is a page of peers.
const FLAT_PAGE_TEXT_BOXES = 3;
// Type itself can lead where the induction names no title: a page whose loudest box runs a third larger than the
// type around it has a place to start, whatever the geometry made of its rows. Two boxes sharing that size (a title
// beside its hero numeral) lead together — the reading is the step down to the rest of the page, not which one wins.
const HIERARCHY_LEAD_RATIO = 1.3;

function leadsByType(sizes) {
  const largest = Math.max(...sizes);
  const rest = [...sizes].sort((left, right) => right - left).slice(1);
  if (!rest.length) return true;
  const middle = rest.slice().sort((left, right) => left - right);
  const median =
    middle.length % 2 ? middle[(middle.length - 1) / 2] : (middle[middle.length / 2 - 1] + middle[middle.length / 2]) / 2;
  return largest >= median * HIERARCHY_LEAD_RATIO;
}

function reviewPptxHierarchy(slide, issues) {
  const shapes = slide.shapes || [];
  if (shapes.some((shape) => shape.chart || shape.table || shape.group || isPptxPicture(shape))) return;
  const textShapes = shapes.filter((shape) => String(shape.text || '').trim() && !isMotifShape(shape));
  if (textShapes.length < FLAT_PAGE_TEXT_BOXES) return;
  if (textShapes.some((shape) => shape.slot === 'title')) return;
  const sizes = textShapes.map((shape) => Number(shape.font?.size) || 0).filter((size) => size > 0);
  if (sizes.length !== textShapes.length) return;
  if (leadsByType(sizes)) return;
  issues.push(
    issue(
      'slide_hierarchy_flat',
      slide.path || `/slide[${slide.index}]`,
      `The slide's ${textShapes.length} text boxes are set at ${[...new Set(sizes)].sort((left, right) => left - right).join(' / ')} pt with none leading the others; the reader has no place to start.`
    )
  );
}

function reviewPptxTextWall(slide, width, height, issues) {
  const shapes = slide.shapes || [];
  // A chart, table, picture, or group carries the page instead of the words.
  if (!width || !height) return;
  if (shapes.some((shape) => shape.chart || shape.table || shape.group || shape.type === 'p:pic')) return;
  let chars = 0;
  let area = 0;
  for (const shape of shapes) {
    const text = String(shape.text || '').trim();
    if (!text) continue;
    chars += text.length;
    area += Math.max(0, Number(shape.width) || 0) * Math.max(0, Number(shape.height) || 0);
  }
  const coverage = area / Math.max(1, width * height);
  if (chars <= TEXT_WALL_CHARS || coverage < TEXT_WALL_COVERAGE) return;
  issues.push(
    issue(
      'slide_text_dense',
      slide.path || `/slide[${slide.index}]`,
      `The slide carries ${chars} characters over ${Math.round(coverage * 100)}% of the canvas with no carrier; split it or cut it rather than projecting a document.`
    )
  );
}

function reviewPptxStructure(document, auditProfile = '') {
  const issues = [];
  const width = Number(document?.slideWidth) || 0;
  const height = Number(document?.slideHeight) || 0;
  // A deck read from the file carries no slots; the roles come from the same
  // induction the snapshot uses, and annotating twice changes nothing.
  if (!(document?.slides || []).some((slide) => (slide.shapes || []).some((shape) => shape.slot))) {
    annotatePptxSnapshotRoles(document);
  }
  for (const source of document?.slides || []) {
    // A hidden slide is not in the deck the reader receives.
    if (source.hidden === true) continue;
    // A shape the slide hides is not on the page; measuring it reports defects
    // no reader can see and sends the next fix round after an invisible box.
    const slide = (source.shapes || []).some((shape) => shape.hidden === true)
      ? { ...source, shapes: source.shapes.filter((shape) => shape.hidden !== true) }
      : source;
    reviewPptxPeerType(slide, issues);
    reviewPptxTextWall(slide, width, height, issues);
    reviewPptxHierarchy(slide, issues);
    for (const shape of slide.shapes || []) {
      if (shape.chart && Number(shape.chart.seriesCount) === 0) {
        issues.push(
          issue(
            'empty_chart',
            shape.chart.path || `${shape.path || slide.path}/chart`,
            'Chart has no persisted data series.',
            'format-review',
            'error'
          )
        );
      }
      reviewPptxChartSeriesNaming(slide, shape, issues);
    }
    const textShapes = (slide.shapes || [])
      .filter(
        (shape) =>
          String(shape.text || '').trim() &&
          !isMotifShape(shape) &&
          [shape.left, shape.top, shape.width, shape.height].every((entry) => Number.isFinite(Number(entry)))
      )
      .map((shape) => ({
        ...shape,
        left: Number(shape.left),
        top: Number(shape.top),
        width: Number(shape.width),
        height: Number(shape.height),
      }));
    for (const shape of textShapes) {
      const fontSize = Number(shape.font?.size) || 0;
      const chrome = isPptxChromeText(shape);
      if (fontSize > 0 && fontSize < PPTX_CHROME_MIN_PT) {
        issues.push(issue('small_font', shape.path || slide.path, `Text is smaller than ${PPTX_CHROME_MIN_PT} pt.`));
      } else if (fontSize > 0 && fontSize < PPTX_BODY_MIN_PT && !chrome) {
        issues.push(issue('small_font', shape.path || slide.path, `Body text is smaller than ${PPTX_BODY_MIN_PT} pt.`));
      }
      const surface = containingSurface(shape, slide.shapes || []);
      const backgroundColor = solidShapeFill(shape) ?? solidShapeFill(surface) ?? slide.background?.color;
      const contrast = colorContrastRatio(shape.font?.color, backgroundColor);
      if (Number.isFinite(contrast) && contrast < 1.8) {
        issues.push(
          issue(
            'low_contrast',
            shape.path || slide.path,
            `Text contrast is ${contrast.toFixed(2)}:1 against ${surface?.path || 'the slide background'}; the text is visually indistinguishable from its surface.`
          )
        );
      }
      const margin = chrome ? PPTX_CHROME_EDGE_PT : PPTX_EDGE_PT;
      if (
        width > 0 &&
        height > 0 &&
        (shape.left < margin ||
          shape.top < margin ||
          shape.left + shape.width > width - margin ||
          shape.top + shape.height > height - margin)
      ) {
        issues.push(issue('edge_margin', shape.path || slide.path, `Text is within ${margin} pt of a slide edge.`));
      }
    }
    // Page-number fields live on the master; their distance to content is chrome, not spacing — but a body block
    // drawn over the page number is still an overlap (PowerPoint's own read reports it; the portable read used to
    // leave the field out of both checks and pass a column that ran into the foot).
    const isPageNumber = (shape) =>
      Boolean(shape.placeholder) && PPTX_PAGE_NUMBER.test(String(shape.text || '').trim());
    const pairShapes = textShapes;
    for (let leftIndex = 0; leftIndex < pairShapes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < pairShapes.length; rightIndex += 1) {
        const left = pairShapes[leftIndex];
        const right = pairShapes[rightIndex];
        if (overlapRatio(left, right) >= 0.25) {
          issues.push(
            issue(
              'shape_overlap',
              slide.path || `/slide[${slide.index}]`,
              `Text shapes ${left.index || leftIndex + 1} and ${right.index || rightIndex + 1} overlap by at least 25%.`
            )
          );
          continue;
        }
        if (isPageNumber(left) || isPageNumber(right)) continue;
        const horizontalOverlap = Math.max(
          0,
          Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left)
        );
        const verticalGap = Math.max(right.top - (left.top + left.height), left.top - (right.top + right.height));
        if (horizontalOverlap < Math.min(left.width, right.width) * 0.3) continue;
        // A band laid across a column it does not belong to covers a small share
        // of its own area, so the area rule above passes it while the page shows
        // two blocks running into each other. Where the boxes share a column,
        // the reading is the overlap itself: past the slack an auto-fitting box
        // carries, the lines are in each other's space.
        if (verticalGap < -PPTX_TEXT_COLLISION_PT) {
          issues.push(
            issue(
              'shape_overlap',
              slide.path || `/slide[${slide.index}]`,
              `Text shapes ${left.index || leftIndex + 1} and ${right.index || rightIndex + 1} run into each other over ${Math.round(-verticalGap)} pt of the column they share; the two blocks read as one.`
            )
          );
          continue;
        }
        // A label and the line it names sit tight by design, so the pair is exempt from the spacing step — never from
        // a collision: two boxes in each other's space read as one block whatever they say to each other.
        if (isPptxLabelledUnit(left, right)) continue;
        if (verticalGap >= 0 && verticalGap < 6) {
          issues.push(
            issue(
              'text_spacing_tight',
              slide.path || `/slide[${slide.index}]`,
              `Text shapes ${left.index || leftIndex + 1} and ${right.index || rightIndex + 1} have less than 6 pt vertical spacing.`
            )
          );
        }
      }
    }
    // The evidence frames are compared with what is drawn over them. A takeaway
    // band laid across the foot of a chart hides the category axis, so the page
    // shows three bars with no names and the audit used to pass: only text boxes
    // were ever compared with each other.
    const evidenceFrames = (slide.shapes || []).filter(
      (shape) =>
        (shape.chart || shape.table || shape.picture || shape.image) &&
        [shape.left, shape.top, shape.width, shape.height].every((entry) => Number.isFinite(Number(entry)))
    );
    for (const frame of evidenceFrames) {
      const area = Number(frame.width) * Number(frame.height);
      if (!(area > 0)) continue;
      for (const cover of slide.shapes || []) {
        if (cover === frame || !solidShapeFill(cover)) continue;
        if (!(Number(cover.index) > Number(frame.index))) continue;
        if (![cover.left, cover.top, cover.width, cover.height].every((entry) => Number.isFinite(Number(entry))))
          continue;
        const width = Math.max(
          0,
          Math.min(Number(frame.left) + Number(frame.width), Number(cover.left) + Number(cover.width)) -
            Math.max(Number(frame.left), Number(cover.left))
        );
        const height = Math.max(
          0,
          Math.min(Number(frame.top) + Number(frame.height), Number(cover.top) + Number(cover.height)) -
            Math.max(Number(frame.top), Number(cover.top))
        );
        if ((width * height) / area < 0.05) continue;
        const kind = frame.chart ? 'chart' : frame.table ? 'table' : 'picture';
        issues.push(
          issue(
            'shape_overlap',
            frame.path || slide.path || `/slide[${slide.index}]`,
            `Shape ${cover.index} is drawn over the ${kind}, covering ${Math.round(((width * height) / area) * 100)}% of it;` +
              ' a band across the foot of a chart hides its category axis.'
          )
        );
        break;
      }
      // A text box over a table is never an annotation (a chart or a picture may carry one): a source line whose
      // box starts inside the table's last row is a table that ran into the foot, and the fill check above sees
      // only solid shapes.
      if (!frame.table) continue;
      for (const textShape of pairShapes) {
        // A snapshot lists the table's own cell text on the table shape; that is the frame, not a box over it.
        if (textShape === frame || textShape.table || textShape.chart || textShape.index === frame.index) continue;
        const textArea = Number(textShape.width) * Number(textShape.height);
        if (!(textArea > 0)) continue;
        const width = Math.max(
          0,
          Math.min(Number(frame.left) + Number(frame.width), Number(textShape.left) + Number(textShape.width)) -
            Math.max(Number(frame.left), Number(textShape.left))
        );
        const height = Math.max(
          0,
          Math.min(Number(frame.top) + Number(frame.height), Number(textShape.top) + Number(textShape.height)) -
            Math.max(Number(frame.top), Number(textShape.top))
        );
        const share = (width * height) / textArea;
        if (share < 0.2) continue;
        issues.push(
          issue(
            'shape_overlap',
            frame.path || slide.path || `/slide[${slide.index}]`,
            `Text shape ${textShape.index} runs into the table (${Math.round(share * 100)}% of the text box lies over it); move the text or give the table fewer rows.`
          )
        );
        break;
      }
    }
    // The words a later object covers are the defect a rendered page hides best:
    // the box still measures as fitting and its text still reads back from the
    // file. A card drawn under its own text sits below it in z-order, so only an
    // object added after the text can hide it.
    for (const textShape of pairShapes) {
      const textArea = Number(textShape.width) * Number(textShape.height);
      if (!(textArea > 0)) continue;
      for (const cover of slide.shapes || []) {
        // A halo is a radial wash that fades to nothing at its edge — the kit signs the one it draws under a product
        // render — so the words it reaches are still read. Only an object that paints over them hides them.
        if (cover === textShape || isMotifShape(cover) || isHaloDevice(cover) || String(cover.text || '').trim())
          continue;
        if (!(Number(cover.index) > Number(textShape.index))) continue;
        if (!isPptxPicture(cover) && !solidShapeFill(cover)) continue;
        if (![cover.left, cover.top, cover.width, cover.height].every((entry) => Number.isFinite(Number(entry))))
          continue;
        const width = Math.max(
          0,
          Math.min(Number(textShape.left) + Number(textShape.width), Number(cover.left) + Number(cover.width)) -
            Math.max(Number(textShape.left), Number(cover.left))
        );
        const height = Math.max(
          0,
          Math.min(Number(textShape.top) + Number(textShape.height), Number(cover.top) + Number(cover.height)) -
            Math.max(Number(textShape.top), Number(cover.top))
        );
        const share = (width * height) / textArea;
        if (share < TEXT_OCCLUSION_SHARE) continue;
        issues.push(
          issue(
            'shape_overlap',
            textShape.path || slide.path || `/slide[${slide.index}]`,
            `Shape ${cover.index} is drawn over text shape ${textShape.index}, covering ${Math.round(share * 100)}% of it; the words behind it are not read.`
          )
        );
        break;
      }
    }
    // Axes are read from drawn objects only: rules, connectors, bands, pictures,
    // charts, tables. A text box is sized to its measured copy, so its box edges
    // are a consequence of the wrap, not a position anyone chose.
    // A glyph- or marker-size picture (the icon in a node, the mark before a list line) registers to the unit it
    // marks, not to the page: a hub's satellites stand on a circle, so their icons' edges land wherever the angle
    // puts them, and reading those as axes flagged every radial structure.
    const placedShapes = (slide.shapes || [])
      .filter(
        (shape) =>
          !isMotifShape(shape) &&
          !isPptxInlineIcon(shape) &&
          !String(shape.text || '').trim() &&
          [shape.left, shape.top, shape.width, shape.height].every((entry) => Number.isFinite(Number(entry)))
      )
      .map((shape) => ({
        ...shape,
        left: Number(shape.left),
        top: Number(shape.top),
        width: Number(shape.width),
        height: Number(shape.height),
      }));
    const slideAxes = pptxEstablishedAxes(placedShapes);
    let drifts = 0;
    for (const shape of placedShapes) {
      if (drifts >= PPTX_AXIS_REPORTS_PER_SLIDE) break;
      const drift = pptxAxisDrift(shape, slideAxes);
      if (!drift) continue;
      drifts += 1;
      issues.push(
        issue(
          'axis_drift',
          shape.path || slide.path,
          `The ${drift.name} sits ${drift.offset.toFixed(1)} pt off the axis the slide shares at ${drift.axis.toFixed(1)} pt.`
        )
      );
    }
    for (const row of pptxPeerRows(placedShapes)) {
      const spread = pptxRowGapSpread(row);
      if (!spread) continue;
      issues.push(
        issue(
          'peer_gap_uneven',
          slide.path || `/slide[${slide.index}]`,
          `A row of ${spread.count} equal shapes is spaced from ${spread.smallest.toFixed(1)} to ${spread.largest.toFixed(1)} pt; the gaps read as a wobble rather than one rhythm.`
        )
      );
    }
    if (auditProfile === 'model-backed-deck') {
      const allText = textShapes.map((shape) => shape.text).join(' ');
      if (
        /\d/.test(allText) &&
        !/(?:source\s*:|[\w .-]+!\$?[A-Z]{1,3}\$?\d+|출처\s*:)/i.test(String(slide.notes || ''))
      ) {
        issues.push(
          issue(
            'number_without_source',
            slide.path || `/slide[${slide.index}]`,
            'Slide contains numbers but its notes do not cite a workbook cell or source.'
          )
        );
      }
    }
  }
  return issues;
}

export function reviewOfficeStructure({ format, document, auditProfile = '' } = {}) {
  const normalized = String(format || document?.format || '').toLowerCase();
  if (normalized === 'docx') return reviewDocxStructure(document);
  if (normalized === 'xlsx') return reviewXlsxStructure(document, auditProfile);
  if (normalized === 'pptx') return reviewPptxStructure(document, auditProfile);
  return [];
}
