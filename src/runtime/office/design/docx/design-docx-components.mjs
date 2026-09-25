import { STATE_ROLES } from '../design-discipline.mjs';
import { presetLabels } from '../design-tokens.mjs';
import { officeNumberFormat } from '../content-model.mjs';

// A figure with its sign, currency, grouping, and a short unit: 38 · −4.2% · ₩740,000 · 1.6배 · 12건 · 2.6억 원.
const FIGURE_CELL = /^[(+\-−]?[₩$€£¥]?\s?\d[\d,.]*\s*(?:%|%p|(?:\s?[A-Za-z가-힣]{1,3}){0,2})\)?$/;

function tableBorders(colors) {
  return {
    style: 'single',
    color: colors.surface2,
    size: 4,
  };
}

function styleCell(output, table, row, col, properties) {
  output.push({ op: 'set_table_cell_style', table, row, col, properties });
}

// The widths a named preset variant draws at. A plain section table (null) takes the writer's widths from its own
// text (naturalTableColumnWidths): a fixed 150/165/165 split wrapped a description beside a two-word label column.
function tableWidths(columns, variant) {
  if (columns <= 1) return [480];
  if (variant === 'roadmap' && columns === 2) return [86, 394];
  if (variant === 'gates' && columns === 3) return [126, 190, 164];
  if (variant === 'metrics' && columns === 3) return [146, 128, 206];
  if (variant === 'scorecard') return Array.from({ length: columns }, () => 480 / columns);
  return null;
}

function pushTable(output, state, values, design, variant) {
  const columns = Math.max(1, ...values.map((row) => row.length));
  state.table += 1;
  const table = state.table;
  output.push({
    op: 'add_table',
    values,
    properties: {
      style: 'Table Grid',
      textStyle: 'Normal',
      fontName: design.tokens.typography.body,
      fontSize: Math.max(9, design.format.body - 0.5),
      color: design.tokens.colors.ink,
      spacingAfter: 0,
      ...(tableWidths(columns, variant) ? { columnWidths: tableWidths(columns, variant) } : {}),
      // The cells hold one exact line and no paragraph spacing, so the row's floor is the air around the centred
      // text: without it the header band and every row closed on the type's own height.
      rowHeights: values.map(() => Math.round(Math.max(9, design.format.body - 0.5) * 1.3 + 7)),
      // A roadmap row is a step, not a header, and a 92pt band pushed a
      // three-step plan onto a page of its own - with the first step repeated at
      // the top as though it were the header row.
      ...(variant === 'roadmap' ? { rowHeights: values.map(() => 40), repeatHeader: false } : {}),
      borders: tableBorders(design.tokens.colors),
      alignment: 'center',
    },
  });
  output.push({ op: 'fit_table', table });
  state.paragraph += 1;
  output.push({
    op: 'append_text',
    text: '\u00A0',
    style: 'Normal',
    properties: {
      name: design.tokens.typography.body,
      size: 1,
      color: design.tokens.colors.canvas,
      spacingBefore: 2,
      spacingAfter: 2,
      lineSpacing: 2,
    },
  });
  return { table, columns };
}

// emphasis: 'inverse' (the dark field) · 'accent' · a state tone ('positive' | 'warning' | 'critical' | 'informative'):
// the label sits on the state's weak field in its text color, so a verdict reads the same as in a deck's badge.
// label: null draws the field without a caption row — a section's callout names itself only when the author
// gave it a label; an invented one ("다음 점검" over an approval request) told the reader the wrong thing.
// eastAsia: the Korean face paired with the display face the callout's text is set in.
export function addDocxDecisionCallout(
  output,
  state,
  text,
  design,
  { label = '', emphasis = 'inverse', eastAsia = '' } = {}
) {
  const caption = label === null ? '' : label || presetLabels(text).recommendation;
  const colors = design.tokens.colors;
  const tone = STATE_ROLES.includes(emphasis) && colors[`${emphasis}Weak`] && colors[`${emphasis}Text`] ? emphasis : '';
  const accentEmphasis = emphasis === 'accent';
  const fallbackFill = accentEmphasis ? colors.accent : colors.inverse;
  const fallbackForeground = accentEmphasis ? colors.onAccent : colors.onInverse;
  const fillColor = tone ? colors[`${tone}Weak`] : fallbackFill;
  const foreground = tone ? colors[`${tone}Text`] : fallbackForeground;
  const { table } = pushTable(output, state, caption ? [[caption], [String(text)]] : [[String(text)]], design, 'callout');
  if (caption) {
    styleCell(output, table, 1, 1, {
      fillColor,
      color: foreground,
      fontName: design.tokens.typography.data,
      fontSize: 9.5,
      bold: true,
      verticalAlignment: 'center',
    });
  }
  styleCell(output, table, caption ? 2 : 1, 1, {
    fillColor: colors.surface,
    color: colors.ink,
    fontName: design.tokens.typography.display,
    ...(eastAsia ? { fontNameEastAsia: eastAsia } : {}),
    fontSize: design.format.body + 1.5,
    bold: true,
    verticalAlignment: 'center',
  });
}

// A figure in the strip is read beside the same figure in the prose, so it is
// written the same way: grouped thousands, and the metric's own number format
// where it carries one (the spreadsheet composer already honours it). Without
// this a bound fact printed as 47210 next to "47,210건" in the paragraph below.
function metricValueText(entry) {
  const unit = String(entry?.unit || '').trim();
  // A Korean counter closes on the figure (12명); a Latin unit takes the space
  // it is read with (47,210 orders).
  const unitGap = /^[A-Za-z(]/.test(unit) ? ' ' : '';
  const suffix = unit ? `${unitGap}${unit}` : '';
  const value = entry?.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${String(value ?? '')}${suffix}`;
  const format = officeNumberFormat(entry);
  const percent = format.includes('%');
  const decimals = /\.(0+)/.exec(format)?.[1].length;
  const scaled = percent ? value * 100 : value;
  const text = scaled.toLocaleString('en-US', {
    useGrouping: !format || /#,#|0,0/.test(format),
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? 20,
  });
  // The unit belongs to the figure it counts: "12명" reads as one number, while
  // a unit parked on the detail row left an orphan word under an empty band.
  return `${percent ? `${text}%` : text}${suffix}`;
}

export function addDocxMetricStrip(output, state, metrics, design) {
  const entries = (Array.isArray(metrics) ? metrics : []).slice(0, 4);
  if (!entries.length) return false;
  const colors = design.tokens.colors;
  const details = entries.map((entry) => String(entry?.detail || ''));
  // A detail row nobody filled is a blank band under the figures on the page,
  // so the strip carries it only when a metric actually says something there.
  const hasDetails = details.some((detail) => detail.trim());
  const values = [
    entries.map((entry) => String(entry?.label || '')),
    entries.map((entry) => metricValueText(entry)),
    ...(hasDetails ? [details] : []),
  ];
  const { table, columns } = pushTable(output, state, values, design, 'scorecard');
  for (let column = 1; column <= columns; column += 1) {
    styleCell(output, table, 1, column, {
      fillColor: colors.inverse,
      color: colors.onInverse,
      fontName: design.tokens.typography.data,
      fontSize: 8.5,
      bold: true,
      horizontalAlignment: 'center',
      verticalAlignment: 'center',
    });
    styleCell(output, table, 2, column, {
      fillColor: column === 1 ? colors.accent : colors.surface,
      color: column === 1 ? colors.onAccent : colors.ink,
      fontName: design.tokens.typography.data,
      fontSize: Math.max(15, design.format.body + 4),
      bold: true,
      horizontalAlignment: 'center',
      verticalAlignment: 'center',
    });
    if (!hasDetails) continue;
    styleCell(output, table, 3, column, {
      fillColor: column % 2 === 0 ? colors.canvas : colors.surface,
      color: colors.muted,
      fontName: design.tokens.typography.body,
      fontSize: 8.5,
      horizontalAlignment: 'center',
      verticalAlignment: 'center',
    });
  }
  return true;
}

export function addDocxRoadmap(output, state, steps, design) {
  const parsed = (Array.isArray(steps) ? steps : [])
    .map((entry, index) => {
      if (entry && typeof entry === 'object') {
        const title = String(entry.title || '');
        const detail = String(entry.detail || entry.body || '');
        return [
          String(entry.label || entry.phase || entry.week || String(index + 1).padStart(2, '0')),
          [title, detail].filter(Boolean).join('\n'),
        ];
      }
      const text = String(entry || '');
      const match = /^([^:：]{1,18})[:：]\s*(.+)$/.exec(text);
      return match ? [match[1], match[2]] : [String(index + 1).padStart(2, '0'), text];
    })
    .filter((row) => row[1]);
  if (!parsed.length) return false;
  const colors = design.tokens.colors;
  const { table } = pushTable(output, state, parsed, design, 'roadmap');
  parsed.forEach((_, index) => {
    const row = index + 1;
    styleCell(output, table, row, 1, {
      fillColor: index === 0 ? colors.accent : colors.inverse,
      color: index === 0 ? colors.onAccent : colors.onInverse,
      fontName: design.tokens.typography.data,
      fontSize: 11.5,
      bold: true,
      verticalAlignment: 'center',
    });
    styleCell(output, table, row, 2, {
      fillColor: index % 2 === 0 ? colors.canvas : colors.surface,
      color: colors.ink,
      fontSize: Math.max(11.5, design.format.body),
      verticalAlignment: 'center',
    });
  });
  return true;
}

export function addDocxSectionTable(output, state, values, design, variant = 'default') {
  if (!values.length) return false;
  const colors = design.tokens.colors;
  const resolvedVariant = variant === 'decision-gates' ? 'gates' : variant;
  if (resolvedVariant === 'metrics' && values.length > 2) {
    const metricRows = values.slice(1, 6).filter((row) => Array.isArray(row) && row.length >= 3);
    if (metricRows.length >= 3) {
      // The third column keeps its header on every figure under the value ("증차 후: 7분"): turned into a strip, the
      // table dropped its header row, and "7분" under "18분" no longer said what it was.
      const detailHeader = String(values[0]?.[2] ?? '').trim();
      const scorecard = [
        metricRows.map((row) => String(row[0] || '')),
        metricRows.map((row) => String(row[1] || '')),
        metricRows.map((row) => {
          const detail = String(row[2] || '');
          return detailHeader && detail ? `${detailHeader}: ${detail}` : detail;
        }),
      ];
      const { table, columns } = pushTable(output, state, scorecard, design, 'scorecard');
      for (let column = 1; column <= columns; column += 1) {
        styleCell(output, table, 1, column, {
          fillColor: colors.inverse,
          color: colors.onInverse,
          fontName: design.tokens.typography.body,
          fontSize: 8.5,
          bold: true,
          horizontalAlignment: 'center',
          verticalAlignment: 'center',
        });
        styleCell(output, table, 2, column, {
          fillColor: column === 1 ? colors.surface : colors.canvas,
          color: colors.accent,
          fontName: design.tokens.typography.data,
          fontSize: Math.max(12.5, design.format.body + 2),
          bold: true,
          horizontalAlignment: 'center',
          verticalAlignment: 'center',
        });
        styleCell(output, table, 3, column, {
          fillColor: column % 2 === 0 ? colors.surface : colors.canvas,
          color: colors.muted,
          fontName: design.tokens.typography.body,
          fontSize: 8.5,
          horizontalAlignment: 'center',
          verticalAlignment: 'center',
        });
      }
      return true;
    }
  }
  const { table, columns } = pushTable(output, state, values, design, resolvedVariant);
  // A column of figures is read down its right edge, its header over it (the docx skill's table anatomy); the
  // preset left 38, 21, 0 flush left under "대기 (분)".
  const figureColumn = Array.from({ length: columns }, (_, index) => {
    const body = values.slice(1).map((row) => String(row?.[index] ?? '').trim()).filter(Boolean);
    return index > 0 && body.length > 0 && body.every((cell) => FIGURE_CELL.test(cell));
  });
  const align = (column) => (figureColumn[column - 1] ? { horizontalAlignment: 'right' } : {});
  for (let column = 1; column <= columns; column += 1) {
    styleCell(output, table, 1, column, {
      fillColor: colors.inverse,
      color: colors.onInverse,
      fontName: design.tokens.typography.body,
      fontSize: Math.max(9, design.format.body - 0.5),
      bold: true,
      verticalAlignment: 'center',
      ...align(column),
    });
  }
  for (let row = 2; row <= values.length; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const metricValue = resolvedVariant === 'metrics' && column === 2;
      const releaseCell = resolvedVariant === 'gates' && column === 2;
      const stopCell = resolvedVariant === 'gates' && column === 3;
      // A release gate is a positive state, a stop gate a critical one: the state fields and words, never a literal tint.
      let fillColor = row % 2 === 0 ? colors.canvas : colors.surface;
      if (releaseCell) fillColor = colors.positiveWeak || colors.surface;
      else if (stopCell) fillColor = colors.criticalWeak || colors.surface2 || colors.surface;
      let color = colors.ink;
      if (metricValue) color = colors.accent;
      else if (releaseCell) color = colors.positiveText || colors.accent;
      else if (stopCell) color = colors.criticalText || colors.accent2;
      styleCell(output, table, row, column, {
        fillColor,
        color,
        bold: column === 1 || metricValue,
        verticalAlignment: 'center',
        ...align(column),
      });
    }
  }
  return true;
}
