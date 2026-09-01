function tableBorders(colors) {
  return {
    style: 'single',
    color: colors.surface2,
    size: 4,
  };
}


function tableWidths(columns, variant) {
  if (columns <= 1) return [480];
  if (columns === 2) return variant === 'roadmap' ? [86, 394] : [150, 330];
  if (columns === 3) {
    if (variant === 'gates') return [126, 190, 164];
    if (variant === 'metrics') return [146, 128, 206];
    return [150, 165, 165];
  }
  if (columns === 5 && variant === 'scorecard') return [96, 96, 96, 96, 96];
  return Array.from({ length: columns }, () => 480 / columns);
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
      columnWidths: tableWidths(columns, variant),
      ...(variant === 'roadmap' ? { rowHeights: values.map(() => 92) } : {}),
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


export function addDocxDecisionCallout(output, state, text, design, {
  label = 'RECOMMENDATION',
  emphasis = 'inverse',
} = {}) {
  const colors = design.tokens.colors;
  const fillColor = emphasis === 'accent' ? colors.accent : colors.inverse;
  const foreground = emphasis === 'accent' ? colors.onAccent : colors.onInverse;
  const { table } = pushTable(output, state, [[label], [String(text)]], design, 'callout');
  output.push({
    op: 'set_table_cell_style',
    table,
    row: 1,
    col: 1,
    properties: {
      fillColor,
      color: foreground,
      fontName: design.tokens.typography.data,
      fontSize: 9.5,
      bold: true,
      verticalAlignment: 'center',
    },
  });
  output.push({
    op: 'set_table_cell_style',
    table,
    row: 2,
    col: 1,
    properties: {
      fillColor: colors.surface,
      color: colors.ink,
      fontName: design.tokens.typography.display,
      fontSize: design.format.body + 1.5,
      bold: true,
      verticalAlignment: 'center',
    },
  });
}

export function addDocxMetricStrip(output, state, metrics, design) {
  const entries = (Array.isArray(metrics) ? metrics : []).slice(0, 4);
  if (!entries.length) return false;
  const colors = design.tokens.colors;
  const values = [
    entries.map((entry) => String(entry?.label || '')),
    entries.map((entry) => String(entry?.value ?? '')),
    entries.map((entry) => String(entry?.detail || entry?.unit || '')),
  ];
  const { table, columns } = pushTable(output, state, values, design, 'scorecard');
  for (let column = 1; column <= columns; column += 1) {
    output.push({
      op: 'set_table_cell_style',
      table,
      row: 1,
      col: column,
      properties: {
        fillColor: colors.inverse,
        color: colors.onInverse,
        fontName: design.tokens.typography.data,
        fontSize: 8.5,
        bold: true,
        horizontalAlignment: 'center',
        verticalAlignment: 'center',
      },
    });
    output.push({
      op: 'set_table_cell_style',
      table,
      row: 2,
      col: column,
      properties: {
        fillColor: column === 1 ? colors.accent : colors.surface,
        color: column === 1 ? colors.onAccent : colors.ink,
        fontName: design.tokens.typography.data,
        fontSize: Math.max(15, design.format.body + 4),
        bold: true,
        horizontalAlignment: 'center',
        verticalAlignment: 'center',
      },
    });
    output.push({
      op: 'set_table_cell_style',
      table,
      row: 3,
      col: column,
      properties: {
        fillColor: column % 2 === 0 ? colors.canvas : colors.surface,
        color: colors.muted,
        fontName: design.tokens.typography.body,
        fontSize: 8.5,
        horizontalAlignment: 'center',
        verticalAlignment: 'center',
      },
    });
  }
  return true;
}


export function addDocxRoadmap(output, state, steps, design) {
  const parsed = (Array.isArray(steps) ? steps : []).map((entry, index) => {
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
  }).filter((row) => row[1]);
  if (!parsed.length) return false;
  const colors = design.tokens.colors;
  const { table } = pushTable(output, state, parsed, design, 'roadmap');
  parsed.forEach((_, index) => {
    const row = index + 1;
    output.push({
      op: 'set_table_cell_style',
      table,
      row,
      col: 1,
      properties: {
        fillColor: index === 0 ? colors.accent : colors.inverse,
        color: index === 0 ? colors.onAccent : colors.onInverse,
        fontName: design.tokens.typography.data,
        fontSize: 11.5,
        bold: true,
        verticalAlignment: 'center',
      },
    });
    output.push({
      op: 'set_table_cell_style',
      table,
      row,
      col: 2,
      properties: {
        fillColor: index % 2 === 0 ? colors.canvas : colors.surface,
        color: colors.ink,
        fontSize: Math.max(11.5, design.format.body),
        verticalAlignment: 'center',
      },
    });
  });
  return true;
}


export function addDocxSectionTable(output, state, values, design, variant = 'default') {
  if (!values.length) return false;
  const colors = design.tokens.colors;
  const resolvedVariant = variant === 'decision-gates'
    ? 'gates'
    : variant === 'metrics'
      ? 'metrics'
      : variant;
  if (resolvedVariant === 'metrics' && values.length > 2) {
    const metricRows = values.slice(1, 6).filter((row) => Array.isArray(row) && row.length >= 3);
    if (metricRows.length >= 3) {
      const scorecard = [
        metricRows.map((row) => String(row[0] || '')),
        metricRows.map((row) => String(row[1] || '')),
        metricRows.map((row) => String(row[2] || '')),
      ];
      const { table, columns } = pushTable(output, state, scorecard, design, 'scorecard');
      for (let column = 1; column <= columns; column += 1) {
        output.push({
          op: 'set_table_cell_style',
          table,
          row: 1,
          col: column,
          properties: {
            fillColor: colors.inverse,
            color: colors.onInverse,
            fontName: design.tokens.typography.body,
            fontSize: 8.5,
            bold: true,
            horizontalAlignment: 'center',
            verticalAlignment: 'center',
          },
        });
        output.push({
          op: 'set_table_cell_style',
          table,
          row: 2,
          col: column,
          properties: {
            fillColor: column === 1 ? colors.surface : colors.canvas,
            color: colors.accent,
            fontName: design.tokens.typography.data,
            fontSize: Math.max(12.5, design.format.body + 2),
            bold: true,
            horizontalAlignment: 'center',
            verticalAlignment: 'center',
          },
        });
        output.push({
          op: 'set_table_cell_style',
          table,
          row: 3,
          col: column,
          properties: {
            fillColor: column % 2 === 0 ? colors.surface : colors.canvas,
            color: colors.muted,
            fontName: design.tokens.typography.body,
            fontSize: 8.5,
            horizontalAlignment: 'center',
            verticalAlignment: 'center',
          },
        });
      }
      return true;
    }
  }
  const { table, columns } = pushTable(output, state, values, design, resolvedVariant);
  for (let column = 1; column <= columns; column += 1) {
    output.push({
      op: 'set_table_cell_style',
      table,
      row: 1,
      col: column,
      properties: {
        fillColor: colors.inverse,
        color: colors.onInverse,
        fontName: design.tokens.typography.body,
        fontSize: Math.max(9, design.format.body - 0.5),
        bold: true,
        verticalAlignment: 'center',
      },
    });
  }
  for (let row = 2; row <= values.length; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const metricValue = resolvedVariant === 'metrics' && column === 2;
      const releaseCell = resolvedVariant === 'gates' && column === 2;
      const stopCell = resolvedVariant === 'gates' && column === 3;
      output.push({
        op: 'set_table_cell_style',
        table,
        row,
        col: column,
        properties: {
          fillColor: releaseCell
            ? colors.surface
            : stopCell
              ? 'FFF4E5'
              : row % 2 === 0
                ? colors.canvas
                : colors.surface,
          color: metricValue || releaseCell
            ? colors.accent
            : stopCell
              ? colors.accent2
              : colors.ink,
          bold: column === 1 || metricValue,
          verticalAlignment: 'center',
        },
      });
    }
  }
  return true;
}
