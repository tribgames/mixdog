import { isMotifShape } from '../design/design-discipline.mjs';

export function issue(code, path, message, source = 'format-review', severity = 'warning') {
  return { severity, code, path, message, source };
}

function headingLevel(paragraph) {
  const style = String(paragraph?.style || '');
  if (!/(?:title|heading|제목|표제)/i.test(style)) return null;
  if (/(?:title|제목|표제)/i.test(style) && !/(?:heading|제목\s*\d)/i.test(style)) return 0;
  const level = Number(/([1-9])/.exec(style)?.[1]);
  return Number.isInteger(level) ? level : 1;
}

function wordBlockOrder(document) {
  const blocks = Array.isArray(document?.blockOrder) && document.blockOrder.length
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
  const content = paragraphs.filter((paragraph) => (
    paragraph?.inTable !== true && String(paragraph.text || '').trim()
  ));
  const headings = content
    .map((paragraph) => ({ paragraph, level: headingLevel(paragraph) }))
    .filter((entry) => entry.level !== null);
  if (content.length >= 8 && headings.length === 0) {
    issues.push(issue(
      'heading_hierarchy_missing',
      '/body',
      'Document has substantial content but no visible title or heading hierarchy.',
    ));
  }
  let priorLevel = null;
  for (const { paragraph, level } of headings) {
    if (priorLevel !== null && level > priorLevel + 1) {
      issues.push(issue(
        'heading_hierarchy_jump',
        paragraph.path || '/body',
        `Heading level jumps from ${priorLevel} to ${level}.`,
      ));
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
    if (
      paragraph?.inTable === true
      || headingLevel(paragraph) === null
      || !String(paragraph?.text || '').trim()
    ) continue;
    const nextBlock = order.slice(index + 1).find((entry) => {
      if (entry.type === 'table') return true;
      return String(paragraphsByIndex.get(Number(entry.index))?.text || '').trim();
    });
    const next = nextBlock?.type === 'table'
      ? tablesByIndex.get(Number(nextBlock.index))
      : paragraphsByIndex.get(Number(nextBlock?.index));
    const headingPage = Number(paragraph?.pageStart || paragraph?.page);
    const nextPage = Number(next?.pageStart || next?.page);
    if (!nextBlock || (headingPage > 0 && nextPage > 0 && headingPage !== nextPage)) {
      issues.push(issue(
        'orphan_heading',
        paragraph.path || '/body',
        'Heading is separated from the content it introduces.',
      ));
    }
  }
  for (const paragraph of content) {
    if (String(paragraph.text || '').length > 900) {
      issues.push(issue(
        'dense_paragraph',
        paragraph.path || '/body',
        'Paragraph is too dense for fast document scanning.',
      ));
    }
  }
  for (const table of tables) {
    const pageStart = Number(table.pageStart);
    const pageEnd = Number(table.pageEnd);
    const rows = Array.isArray(table.rows) ? table.rows.length : 0;
    if (rows > 0 && rows <= 6 && pageStart > 0 && pageEnd > 0 && pageStart !== pageEnd) {
      issues.push(issue(
        'short_table_split',
        table.path || '/body',
        `A ${rows}-row table is split across pages ${pageStart}-${pageEnd}.`,
      ));
    }
  }
  return issues;
}

function cellRow(ref) {
  return Number(/([1-9]\d*)$/.exec(String(ref || '').replaceAll('$', ''))?.[1] || 0);
}

function formulaRanges(formula) {
  const ranges = [];
  for (const match of String(formula || '').matchAll(/\$?[A-Z]{1,3}\$?([1-9]\d*):\$?[A-Z]{1,3}\$?([1-9]\d*)/gi)) {
    ranges.push({ start: Number(match[1]), end: Number(match[2]) });
  }
  return ranges;
}

function reviewXlsxStructure(document) {
  const issues = [];
  const sheets = Array.isArray(document?.sheets) ? document.sheets : [];
  for (const sheet of sheets) {
    const cells = Array.isArray(sheet.cells) ? sheet.cells : [];
    if (cells.length >= 8) {
      const styled = cells.filter((cell) => cell.style && Object.keys(cell.style).length);
      if (styled.length === 0) {
        issues.push(issue(
          'worksheet_hierarchy_missing',
          sheet.path || `/sheet[${sheet.name || ''}]`,
          'Data sheet has no styled title, header, table, or visual hierarchy.',
        ));
      }
    }
    const totalRows = new Set(cells
      .filter((cell) => /^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))/i.test(String(cell.value || '').trim()))
      .map((cell) => cellRow(cell.ref))
      .filter(Boolean));
    for (const cell of cells) {
      if (/^#(?:DIV\/0|VALUE|REF|NAME|N\/A|NUM|NULL|SPILL|CALC|FIELD)\??!?$/i.test(String(cell.value || '').trim())) {
        issues.push(issue(
          'formula_error',
          cell.path || `${sheet.path || `/sheet[${sheet.name || ''}]`}/cell[${cell.ref || ''}]`,
          `Formula evaluates to ${cell.value}.`,
          'format-review',
          'error',
        ));
      }
    }
    for (const chart of sheet.charts || []) {
      const formulas = (chart.series || []).flatMap((series) => [
        series.formula,
        series.categoryFormula,
        series.valueFormula,
      ]).filter(Boolean);
      const included = [...totalRows].find((row) => formulas.some((formula) => (
        formulaRanges(formula).some((range) => row >= range.start && row <= range.end)
      )));
      if (included) {
        issues.push(issue(
          'chart_includes_total_row',
          chart.path || `${sheet.path || `/sheet[${sheet.name || ''}]`}/chart`,
          `Chart source includes total or subtotal row ${included}; separate summary rows from comparison series.`,
        ));
      }
    }
    const rows = Number(sheet.rows) || 0;
    const columns = Number(sheet.columns) || 0;
    const pageSetup = sheet.pageSetup || {};
    if (
      (rows >= 40 || columns >= 12)
      && Number(pageSetup.fitToPagesWide) !== 1
      && Number(pageSetup.zoom) > 100
    ) {
      issues.push(issue(
        'worksheet_print_fit_missing',
        sheet.path || `/sheet[${sheet.name || ''}]`,
        'Large worksheet has no one-page-wide print fit and uses an enlarged print zoom.',
      ));
    }
  }
  return issues;
}

function overlapRatio(left, right) {
  const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
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
  if (!Number.isFinite(color) || color < 0 || color > 0xFFFFFF) return null;
  return [
    color & 255,
    (color >> 8) & 255,
    (color >> 16) & 255,
  ];
}

function relativeLuminance(rgb) {
  if (!rgb) return null;
  const channels = rgb.map((entry) => {
    const channel = entry / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function colorContrastRatio(left, right) {
  const leftLuminance = relativeLuminance(officeColorRgb(left));
  const rightLuminance = relativeLuminance(officeColorRgb(right));
  if (!Number.isFinite(leftLuminance) || !Number.isFinite(rightLuminance)) return null;
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function solidShapeFill(shape) {
  const transparency = Number(shape?.fillTransparency);
  if (!officeColorRgb(shape?.fillColor) || !Number.isFinite(transparency) || transparency >= 0.2) return null;
  return shape.fillColor;
}

function containingSurface(textShape, shapes) {
  const centerX = textShape.left + (textShape.width / 2);
  const centerY = textShape.top + (textShape.height / 2);
  return (shapes || [])
    .filter((shape) => (
      Number(shape?.index) < Number(textShape.index)
      && !String(shape?.text || '').trim()
      && solidShapeFill(shape) != null
      && Number(shape.left) <= centerX
      && Number(shape.top) <= centerY
      && Number(shape.left) + Number(shape.width) >= centerX
      && Number(shape.top) + Number(shape.height) >= centerY
    ))
    .sort((left, right) => (
      (Number(left.width) * Number(left.height)) - (Number(right.width) * Number(right.height))
    ))[0] || null;
}

function reviewPptxStructure(document, auditProfile = '') {
  const issues = [];
  const width = Number(document?.slideWidth) || 0;
  const height = Number(document?.slideHeight) || 0;
  for (const slide of document?.slides || []) {
    for (const shape of slide.shapes || []) {
      if (shape.chart && Number(shape.chart.seriesCount) === 0) {
        issues.push(issue(
          'empty_chart',
          shape.chart.path || `${shape.path || slide.path}/chart`,
          'Chart has no persisted data series.',
          'format-review',
          'error',
        ));
      }
    }
    const textShapes = (slide.shapes || []).filter((shape) => (
      String(shape.text || '').trim()
      && !isMotifShape(shape)
      && [shape.left, shape.top, shape.width, shape.height].every((entry) => Number.isFinite(Number(entry)))
    )).map((shape) => ({
      ...shape,
      left: Number(shape.left),
      top: Number(shape.top),
      width: Number(shape.width),
      height: Number(shape.height),
    }));
    for (const shape of textShapes) {
      if (Number(shape.font?.size) > 0 && Number(shape.font.size) < 12) {
        issues.push(issue('small_font', shape.path || slide.path, 'Text is smaller than 12 pt.'));
      }
      const surface = containingSurface(shape, slide.shapes || []);
      const backgroundColor = solidShapeFill(shape)
        ?? solidShapeFill(surface)
        ?? slide.background?.color;
      const contrast = colorContrastRatio(shape.font?.color, backgroundColor);
      if (Number.isFinite(contrast) && contrast < 1.8) {
        issues.push(issue(
          'low_contrast',
          shape.path || slide.path,
          `Text contrast is ${contrast.toFixed(2)}:1 against ${surface?.path || 'the slide background'}; the text is visually indistinguishable from its surface.`,
        ));
      }
      if (width > 0 && height > 0 && (
        shape.left < 18
        || shape.top < 18
        || shape.left + shape.width > width - 18
        || shape.top + shape.height > height - 18
      )) {
        issues.push(issue('edge_margin', shape.path || slide.path, 'Text is within 18 pt of a slide edge.'));
      }
    }
    for (let leftIndex = 0; leftIndex < textShapes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < textShapes.length; rightIndex += 1) {
        const left = textShapes[leftIndex];
        const right = textShapes[rightIndex];
        if (overlapRatio(left, right) >= 0.25) {
          issues.push(issue(
            'shape_overlap',
            slide.path || `/slide[${slide.index}]`,
            `Text shapes ${left.index || leftIndex + 1} and ${right.index || rightIndex + 1} overlap by at least 25%.`,
          ));
          continue;
        }
        const horizontalOverlap = Math.max(
          0,
          Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left),
        );
        const verticalGap = Math.max(
          right.top - (left.top + left.height),
          left.top - (right.top + right.height),
        );
        if (horizontalOverlap >= Math.min(left.width, right.width) * 0.3 && verticalGap >= 0 && verticalGap < 6) {
          issues.push(issue(
            'text_spacing_tight',
            slide.path || `/slide[${slide.index}]`,
            `Text shapes ${left.index || leftIndex + 1} and ${right.index || rightIndex + 1} have less than 6 pt vertical spacing.`,
          ));
        }
      }
    }
    if (auditProfile === 'model-backed-deck') {
      const allText = textShapes.map((shape) => shape.text).join(' ');
      if (/\d/.test(allText) && !/(?:source\s*:|[\w .-]+!\$?[A-Z]{1,3}\$?\d+|출처\s*:)/i.test(String(slide.notes || ''))) {
        issues.push(issue(
          'number_without_source',
          slide.path || `/slide[${slide.index}]`,
          'Slide contains numbers but its notes do not cite a workbook cell or source.',
        ));
      }
    }
  }
  return issues;
}

export function reviewOfficeStructure({
  format,
  document,
  auditProfile = '',
} = {}) {
  const normalized = String(format || document?.format || '').toLowerCase();
  if (normalized === 'docx') return reviewDocxStructure(document);
  if (normalized === 'xlsx') return reviewXlsxStructure(document);
  if (normalized === 'pptx') return reviewPptxStructure(document, auditProfile);
  return [];
}
