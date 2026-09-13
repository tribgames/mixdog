# Native charts and tables

Read this file when the slide plan names a chart or table carrier. The runtime
loads its code after `kit.md`, so the script calls these helpers without
pasting them; they depend on the kit's tokens, measurement, text, and shape
primitives. Data remains editable in PowerPoint.

```js
// Chart text belongs to the deck's reading scale. Assign colors to meanings
// explicitly (for example prior year neutral, current year accent), not series order.
// type: col | bar | line | area | doughnut | radar | scatter | bubble (composition.md §9 maps the relationship to the form).
// series: [{ name, values }], labels: categories. scatter/bubble take pptxgenjs' own shape: series[0] = { name: 'X', values },
// then { name, values[, sizes] } per set; labels unused. accent: index of the one category to color (single series bars only) —
// drawn as two stacked series here, merged by the runtime into one series with a per-point fill, so "Edit data" shows one column.
// Its default is the last category: the reference IR and analyst charts (Samsung, Kakao, Naver, Sequoia, September 2026)
// draw every bar in a light gray and the current period — the bar the title is about — in the bright accent, with dark
// value labels above the bars and no axis or grid; accent: null draws one gray series, accent: i names another category.
// Colours by meaning, not by series order: the accent goes to the series or bar the title names, gray to the rest.
// overlap: true draws a bullet — series[0] the track or target (muted), series[1] the actual (accent), bars laid over each other.
// note: { at, text } annotates one column (single-series 'col' only): the plot area is pinned (PLOT) so the bar's
// position is known, a leader rises from above its value label to a short label at the top of the frame.
// Stacked-bar labels must sit inside ('inEnd' | 'ctr' | 'inBase'); zero segments are hidden by the format code.
const PLOT = { x: 0.03, y: 0.14, w: 0.94, h: 0.72 };   // plot area as fractions of the chart frame when a note pins it
// field: a tint under the plot area (a16z draws every chart on a grey field so the plot reads as one object on the
// page — its largest; the IR decks leave it on the paper): `field: T.paperAlt` for the a16z reading, none by default.
// axis: how the reader gets the values. 'labels' — every mark carries its value and the value axis is hidden (the IR
// pages: one series, up to six categories). 'grid' — the data-journalism reading (the FiveThirtyEight, Urban Institute
// and LA Times chart themes, measured September 2026: a value axis in the muted colour at 10-12 pt, thin horizontal
// gridlines in a pale grey, no label on every mark, the category baseline drawn): more categories or several series,
// where a label on every bar is noise. Default by the data: labels for one series of ≤ 6 categories (a line of ≤ 8
// points), grid otherwise; stacked forms keep their inside labels.
function chart(slide, x, y, w, h, { type = 'col', labels, series, accent, overlap = false, max, min = 0, format = '#,##0', size = TYPE.caption + 1, note = null,
  colors, legend, legendPos = 'b', plot, categoryLabels = true, showValues = true, grouping = 'clustered',
  valueColor = T.body, categoryColor = T.muted, field = null, axis = null } = {}) {
  const bar = type === 'col' || type === 'bar';
  const count = labels?.length ?? 0, stackedForm = grouping === 'stacked' || grouping === 'percentStacked';
  const grid = axis === 'grid' || (axis == null && !stackedForm && !overlap && ['col', 'bar', 'line', 'area'].includes(type)
    && (series.length > 1 || count > (bar ? 6 : 8)));
  if (grid) showValues = false;
  if (accent === undefined) accent = bar && series.length === 1 && !overlap && grouping === 'clustered' ? (labels?.length ?? 0) - 1 : -1;
  if (accent === null) accent = -1;
  const paint = (fallback) => Array.isArray(colors) && colors.length ? [...colors] : fallback;
  const legendOptions = { showLegend: legend ?? (series.length > 1 && type !== 'doughnut'), legendPos,
    legendColor: valueColor, legendFontSize: size, legendFontFace: T.sans };
  const pinned = Boolean(note) && type === 'col' && series.length === 1;
  const top = max ?? (pinned ? Math.ceil(Math.max(...series[0].values) * 1.15) : undefined);
  // A declared axis is the reader's scale, and a value past it is drawn clipped at the plot edge — 240 and 95 end up the same
  // height with both labels shown. The scale is checked against the data it must carry: an axis widens, a value is never cropped.
  if (top != null) {
    const outside = (series || []).flatMap((s) => (Array.isArray(s.values) ? s.values : [])
      .map((v, i) => (Number.isFinite(v) && (v > top || v < min) ? `${s.name ?? '계열'} ${labels?.[i] ?? `#${i + 1}`} ${v}` : null)).filter(Boolean));
    if (outside.length) throw new Error(`chart: ${outside.join(', ')} outside the value axis ${min}–${top} — widen max/min, or drop them and let the axis follow the data`);
  }
  const base = { ...box(x, y, w, h), fontFace: T.sans, ...legendOptions,
    catAxisHidden: !categoryLabels, catAxisLabelColor: categoryColor, catAxisLabelFontSize: size, catAxisLabelFontFace: T.sans, catAxisLineShow: grid,
    ...(grid
      ? { catAxisLineColor: T.line, valAxisHidden: false, valAxisLineShow: false, valAxisLabelColor: T.muted, valAxisLabelFontSize: Math.max(10, size - 2), valAxisLabelFontFace: T.data,
        valAxisLabelFormatCode: format, valGridLine: { color: T.lineSubtle, style: 'solid', size: 0.75 }, catGridLine: { style: 'none' } }
      : { valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' } }),
    ...(top != null ? { valAxisMaxVal: top, valAxisMinVal: min } : {}),
    ...(plot ? { layout: { ...plot } } : pinned ? { layout: PLOT } : {}),
    ...(field ? { plotArea: { fill: { color: field } } } : {}),
    showValue: showValues, dataLabelColor: valueColor, dataLabelFontSize: size, dataLabelFontFace: T.data, dataLabelFormatCode: format + ';;' };
  const annotate = () => {
    if (!pinned) return;
    const values = series[0].values, n = values.length, i = Math.max(0, Math.min(n - 1, note.at));
    const cx = x + PLOT.x * w + (i + 0.5) * (PLOT.w * w) / n;
    const barTop = y + PLOT.y * h + PLOT.h * h * (1 - (values[i] - min) / ((top - min) || 1));
    // The label sits one between step above the bar's value label (a short leader), not at the frame top — a zero
    // bar would otherwise hang a leader the full height of the plot. Clamped to the frame.
    const lh = 0.32, ly = Math.max(y + 0.02, barTop - 0.34 - GAP.between - lh);
    connector(slide, cx, barTop - 0.34, cx, ly + lh + 0.04, { arrow: 'none', color: T.accent, width: 1.25 });
    // The label sits on whichever side of the leader has room for its measured width, never wrapped.
    const tw = textW(note.text, DIAG.label, T.sans, true) + 0.12;
    const leftSide = x + w - cx - 0.12 < tw;
    text(slide, note.text, leftSide ? cx - 0.12 - tw : cx + 0.12, ly, tw, DIAG.label, { color: T.accent, font: T.sans, bold: true, lh: 1.15, h: lh, valign: 'middle', align: leftSide ? 'right' : 'left' });
  };
  if (bar && overlap && series.length === 2) {
    slide.addChart(pres.ChartType.bar, series.map((s) => ({ ...s, labels })), { ...base, barDir: type === 'bar' ? 'bar' : 'col',
      barOverlapPct: 100, barGapWidthPct: 45, chartColors: paint([T.markSoft, T.accentFill]), showValue: false });
    return;
  }
  if (type === 'doughnut') {
    slide.addChart(pres.ChartType.doughnut, [{ name: series[0].name, labels, values: series[0].values }], { ...base, holeSize: 62,
      // A ring labels inside its own slices, and one chart carries one label colour: every slice therefore takes a
      // fill the on-accent white reads on, rather than a light tint that turns the figure on it into a guess.
      chartColors: paint([T.accent, T.mark, T.accentDeep, T.body, T.dark]), dataLabelPosition: 'bestFit', dataLabelColor: T.onAccent, showLabel: false, showPercent: false });
    return;
  }
  if (type === 'radar') {
    slide.addChart(pres.ChartType.radar, series.map((s) => ({ ...s, labels })), { ...base, radarStyle: 'marker', lineSize: 2,
      chartColors: paint([T.accentFill, T.mark]), showValue: false });
    return;
  }
  if (type === 'scatter' || type === 'bubble') {
    slide.addChart(type === 'bubble' ? pres.ChartType.bubble : pres.ChartType.scatter, series, { ...base, valAxisHidden: false, catAxisHidden: false,
      valAxisLineShow: true, catAxisLineShow: true, valAxisLineColor: T.line, catAxisLineColor: T.line, valAxisLabelColor: T.muted, valAxisLabelFontSize: size,
      lineSize: 0, lineDataSymbol: 'circle', lineDataSymbolSize: type === 'bubble' ? 12 : 9, chartColors: paint([T.accentFill, T.mark, T.markSoft]), showValue: false });
    return;
  }
  if (bar && accent >= 0 && series.length === 1) {
    const values = series[0].values;
    slide.addChart(pres.ChartType.bar, [
      { name: series[0].name, labels, values: values.map((v, i) => (i === accent ? 0 : v)) },
      { name: series[0].name + ' ·', labels, values: values.map((v, i) => (i === accent ? v : 0)) },
    ], { ...base, barDir: type === 'bar' ? 'bar' : 'col', barGrouping: 'stacked', barGapWidthPct: 60,
      // The runtime merges the pair into one clustered series, so the labels sit above the bars in the body colour
      // the way the reference charts label theirs; the unemphasized columns are the light neutral, the one the title
      // names the mark form of the accent.
      chartColors: paint([T.markSoft, T.accentFill]), dataLabelPosition: 'outEnd', dataLabelColor: valueColor });
    annotate();
    return;
  }
  if (bar) {
    // One series is one color (PowerPoint would otherwise cycle a color per bar); the accent is reserved for `accent`.
    // Several series: the earlier ones gray (light, then mid), the last — the current period — the mark form of the accent.
    slide.addChart(pres.ChartType.bar, series.map((s) => ({ ...s, labels })), { ...base, barDir: type === 'bar' ? 'bar' : 'col',
      barGrouping: grouping, barGapWidthPct: 60, chartColors: paint(series.length === 1 ? [T.mark] : series.length === 2 ? [T.markSoft, T.accentFill] : [T.markSoft, T.mark, T.accentFill]),
      dataLabelPosition: grouping === 'stacked' || grouping === 'percentStacked' ? 'ctr' : 'outEnd' });
    annotate();
    return;
  }
  slide.addChart(type === 'area' ? pres.ChartType.area : pres.ChartType.line, series.map((s) => ({ ...s, labels })), { ...base, lineSize: 2.5, lineDataSymbol: 'none',
    chartColors: paint([T.accentFill, T.mark, T.markSoft]), dataLabelPosition: 't', ...(type === 'area' ? { chartColorsOpacity: 35 } : {}) });
}
// Waterfall: native stacked columns — an invisible base (the surface color) carries each bar to its running start.
// steps: [{ label, value }] with a negative value for a drop, and { label, total: true } for a closing bar at the running total.
// Values stay editable; the closing figure is labeled by the author (a hero or a takeaway), not by the chart.
function waterfall(slide, x, y, w, h, steps, { size = DIAG.note, surface = T.paper } = {}) {
  let run = 0; const labels = [], base = [], rise = [], drop = [];
  for (const s of steps) {
    labels.push(s.label);
    if (s.total) { base.push(0); rise.push(run); drop.push(0); continue; }
    if (s.value >= 0) { base.push(run); rise.push(s.value); drop.push(0); run += s.value; }
    else { run += s.value; base.push(run); rise.push(0); drop.push(-s.value); }
  }
  slide.addChart(pres.ChartType.bar, [
    { name: 'base', labels, values: base }, { name: 'up', labels, values: rise }, { name: 'down', labels, values: drop },
  ], { ...box(x, y, w, h), barDir: 'col', barGrouping: 'stacked', barGapWidthPct: 40, chartColors: [surface, T.accentFill, T.mark],
    fontFace: T.sans, showLegend: false, showValue: false, catAxisLabelColor: T.muted, catAxisLabelFontSize: size, catAxisLabelFontFace: T.sans,
    catAxisLineShow: false, valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' } });
}
// Dumbbell: two values per item joined by a rule — before/after, plan/actual, min/max. rows: [{ label, a, b }]; a muted, b accent.
// Drawn with rules and dots (not bars), so it is a diagram of two points, never a picture of a bar chart.
function dumbbell(slide, x, y, w, rows, { min, max, labelW = 2.2, rowH = 0.6, format = (v) => String(v), size = TYPE.caption } = {}) {
  const values = rows.flatMap((r) => [r.a, r.b]);
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  // A declared range is the reader's scale: a value outside it would be drawn outside the track (often off the canvas),
  // so it is reported here, not left to the bounds check (never a silently misplaced point).
  const outside = rows.filter((r) => Math.min(r.a, r.b) < lo || Math.max(r.a, r.b) > hi);
  if (outside.length) throw new Error(`dumbbell: ${outside.map((r) => `${r.label} (${r.a} → ${r.b})`).join(', ')} outside the range ${lo}–${hi} — widen min/max or move the row to its own scale`);
  // A row under 0.5 in puts one row's 0.4 in label box within 6 pt of the next (the spacing check's collision).
  if (rowH < 0.5) throw new Error(`dumbbell: rowH ${rowH.toFixed(2)} in is under the 0.5 in floor for ${rows.length} rows — give the stage more height (st.h / ${rows.length}) or drop a row`);
  // The dots and the values are page objects, not annotations: a 0.28 in dot and a caption-size figure read from the
  // back of the room, where the 0.18 in dot of a first draft read as a scatter of specks.
  const x0 = x + labelW + 1.0, span = w - labelW - 2.0, d = 0.28, vs = Math.max(DIAG.note, TYPE.caption);
  const at = (v) => x0 + ((v - lo) / ((hi - lo) || 1)) * span;
  rows.forEach((r, i) => {
    const cy = y + i * rowH + rowH / 2;
    slide.addText(r.label, { ...box(x, cy - 0.2, labelW, 0.4), fontFace: T.sans, fontSize: size, color: T.ink, margin: 0, valign: 'middle' });
    const xa = at(r.a), xb = at(r.b), lead = xb >= xa;
    slide.addShape(pres.ShapeType.line, { x: Math.min(xa, xb), y: cy, w: Math.abs(xb - xa), h: 0, line: { color: T.line, width: 3 } });
    slide.addShape(pres.ShapeType.ellipse, { x: xa - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: T.mark }, line: { color: T.mark, width: 0 } });
    slide.addShape(pres.ShapeType.ellipse, { x: xb - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: T.accentFill }, line: { color: T.accentFill, width: 0 } });
    slide.addText(format(r.a), { ...box(lead ? xa - 1.05 : xa + 0.2, cy - 0.2, 0.85, 0.4), fontFace: T.data, fontSize: vs, color: T.muted, align: lead ? 'right' : 'left', margin: 0, valign: 'middle' });
    slide.addText(format(r.b), { ...box(lead ? xb + 0.2 : xb - 1.05, cy - 0.2, 0.85, 0.4), fontFace: T.data, fontSize: vs, color: T.ink, bold: true, align: lead ? 'left' : 'right', margin: 0, valign: 'middle' });
  });
  return y + rows.length * rowH;
}
// Small multiples: n identical charts on one row, one label above each, shared axis range.
function smallMultiples(slide, x, y, w, h, panels, { type = 'col', max, gap = GUTTER, format = '#,##0' } = {}) {
  const pw = (w - gap * (panels.length - 1)) / panels.length, th = lineH(DIAG.label, T.sans, 1.2), cy = y + th + GAP.within;
  const top = max ?? Math.max(...panels.flatMap((p) => p.series.flatMap((s) => s.values))) * 1.15;
  panels.forEach((p, i) => {
    const px = x + i * (pw + gap);
    text(slide, p.title, px, y, pw, 'label', { h: th });
    chart(slide, px, cy, pw, h - (cy - y), { type, labels: p.labels, series: p.series, max: top, accent: p.accent ?? -1, format });
  });
}
// The table's pitch: the type and the row height one table takes — dense sets the caption step (never under 12 pt) at
// 2.0 × its size, the default the body step at SPEC.table's 2.2 ×. table() and tableRows() read the same pair.
function tablePitch(dense = false, size) {
  const sp = spec('table');
  if (!dense) return { size: size ?? sp.size, rowH: sp.rowH };
  const s = size ?? Math.max(12, TYPE.caption + 1);
  return { size: s, rowH: Math.round(s * 2.0 / 72 * 100) / 100 };
}
// tableRows: how many body rows a height holds at the table's pitch (one header row plus the body) — decided at plan
// time so the table's granularity fills its column (monthly rows instead of quarterly, every division instead of the
// top three, `tableRows(avail(top))` rows) rather than three rows over a bare field: the reference tables run ten to
// fifteen rows in the body column, and a table that stops at a third of its column is the page's largest object only on paper.
function tableRows(h, { dense = false, size } = {}) {
  return Math.max(0, Math.floor(h / tablePitch(dense, size).rowH) - 1);
}
// A table is a readable page object, not a tiny appendix squeezed below a chart.
// Anatomy from SPEC.table (row pitch 2.2 × body — the Kakao and Samsung IR tables run 1.9-2.1 × their type): the header
// on the basement surface, row rules in the subtle line (repeated items), the verdict column bold on the tint — or, with
// tones: ['positive', 'warning', ...] one per body row, each verdict word on its state's weak field in its state text.
// Numbers align right on their own (a cell that reads as a figure — "2,028", "-14%", "4.3%pt", "1.6배"); the header
// above a numeric column aligns with it; alignments[j] overrides. The reference IR devices: highlightCol outlines the
// current-period column in the mark form of the accent (Samsung's navy box, Kakao's red one); groupRows (zero-based
// body rows) set a total or subtotal row bold on the basement surface; subRows indent a child row and mute it.
// The grouped IR table (LG 2Q25 p.3, measured September 2026: five divisions × Sales / OP / margin = 15 body rows on
// the right half of the page at 2.0 × the type, the current quarter's column tinted with its header in the accent,
// a stronger rule between groups): `groups: [{ name, sub?, rows: [[...cells without the first column]] }]` builds the
// body — the group's name spans its rows as one merged cell (its `sub` under it in the muted face), the rows inside
// a group are separated by the subtle rule and the groups by the section rule. `dense: true` sets the type to the
// caption step (never under 12 pt) and the pitch to 2.0 × — ten to fifteen rows in the body column, the reference
// density. `highlightStyle: 'filled'` tints the highlighted column's body cells and paints its header in the accent
// (LG, Samsung); 'outline' (the default) draws the four rules alone (Kakao).
function table(slide, x, y, w, header, rows, { colW, rowH, verdict = -1, tones = [], size,
  headerFill, headerColor, banded = false, alignments = [], highlightRows = [], emphasisCells = [], border,
  highlightCol = -1, highlightStyle = 'outline', groupRows = [], subRows = [], groups = null, dense = false } = {}) {
  const sp = spec('table'), pitch = tablePitch(dense, size);
  size ??= pitch.size; rowH ??= pitch.rowH; headerFill ??= sp.header.fill; headerColor ??= sp.header.color; border ??= sp.border;
  // Grouped input → flat body rows plus the merged label cell per group and the rule index of each group's last row.
  const groupStarts = new Map(), groupEnds = new Set();
  if (Array.isArray(groups) && groups.length) {
    rows = [];
    for (const g of groups) {
      groupStarts.set(rows.length, { name: g.name, sub: g.sub || '', span: g.rows.length });
      for (const r of g.rows) rows.push(['', ...r]);
      groupEnds.add(rows.length - 1);
    }
  }
  const numeric = (t) => /^[\s~+\-−–$€₩£(]*[\d.,]+\s*[%배건xX억조KMBT]*(?:pt|p)?[)]?[\s]*$|^[-–—]$/.test(String(t ?? ''));
  const columnNumeric = header.map((_, j) => rows.length > 0 && rows.every((r) => r[j] === '' || r[j] == null || numeric(r[j])));
  const alignOf = (j) => alignments[j] || (j > 0 && columnNumeric[j] ? 'right' : 'left');
  const filled = highlightStyle === 'filled' && highlightCol >= 0;
  const head = (t, j) => ({ text: t, options: { bold: true, color: filled && j === highlightCol ? T.accentLabel.color : headerColor, fill: { color: filled && j === highlightCol ? T.accentLabel.fill : headerFill }, fontFace: sp.font, fontSize: size, align: alignOf(j) } });
  const edge = (color, pt) => ({ type: 'solid', color, pt });
  const baseEdge = Array.isArray(border) ? border[2] || border[0] : border;
  // emphasisCells: explicit [body-row, column] pairs, zero-based. Comparing
  // different dimensions may require different cells, not one highlighted row.
  const cell = (t, i, j) => {
    const emphasized = emphasisCells.some(([row, column]) => row === i && column === j);
    const state = j === verdict && tones[i] ? tone(tones[i]) : null;
    const group = groupRows.includes(i), sub = subRows.includes(i);
    const start = j === 0 ? groupStarts.get(i) : null;
    const bottomEdge = groupEnds.size && groupEnds.has(i) ? edge(T.line, 1) : baseEdge;
    const options = { fontFace: sp.font, fontSize: size, color: state ? state.color : emphasized ? T.accent : sub ? T.muted : j === 0 || group ? T.ink : T.body, bold: emphasized || group || (j === 0 && !sub) || j === verdict,
      align: alignOf(j), fill: { color: state ? state.fill : emphasized || j === verdict || highlightRows.includes(i) || (filled && j === highlightCol) ? T.tint : group || (banded && i % 2) ? T.paperAlt : T.paper },
      ...(groupEnds.size ? { border: [baseEdge, baseEdge, bottomEdge, baseEdge].map((e) => ({ ...e })) } : {}) };
    if (start) {
      const runs = [{ text: start.name, options: { bold: true, color: T.ink, breakLine: Boolean(start.sub) } }];   // breakLine ends the run it sits on
      if (start.sub) runs.push({ text: start.sub, options: { fontSize: Math.max(9, size - 3), color: T.muted } });
      return { text: runs, options: { ...options, rowspan: start.span, align: 'center', valign: 'middle', border: [baseEdge, baseEdge, edge(T.line, 1), baseEdge].map((e) => ({ ...e })) } };
    }
    return { text: sub && j === 0 ? `    ${t}` : t, options };
  };
  const widths = colW || header.map(() => w / header.length);
  // A merged label cell owns the rows it spans: the rows under a group's first row start at the second column.
  const body = rows.map((r, i) => r.map((t, j) => cell(t, i, j)).filter((c, j) => !(j === 0 && groupEnds.size && !groupStarts.has(i))));
  // The frame's height is declared: with merged cells the generator falls back to a 1 in frame under rows that
  // reach 2 in, and the audit then reads a hollow band where the table's lower rows stand.
  const bottom = y + rowH * (rows.length + 1);
  footGuard('table', y, bottom, `${Math.max(0, Math.floor((Z.body.bottom - y) / rowH) - 1)} rows fit from this top (tableRows(avail(top))) — cut rows, dense: true, or start higher`);
  slide.addTable([header.map(head), ...body],
    { x, y, w, h: bottom - y, colW: widths, rowH, border: Array.isArray(border) ? border.map((e) => ({ ...e })) : { ...border }, margin: [...sp.margin], valign: 'middle',
      objectName: specName('table', tones.length ? 'toned' : verdict >= 0 ? 'verdict' : groupEnds.size ? 'grouped' : banded ? 'banded' : 'plain') });
  if (highlightCol >= 0 && highlightCol < widths.length && !filled) {
    // Four rules, not a filled frame: a shape with a fill drawn over the table reads as a cover to the structure audit.
    // The filled style needs no rules: the tint and the accent header already own the column.
    const cx = x + widths.slice(0, highlightCol).reduce((a, b) => a + b, 0), cw = widths[highlightCol];
    for (const [lx, ly, lw, lh] of [[cx, y, cw, 0], [cx, bottom, cw, 0], [cx, y, 0, bottom - y], [cx + cw, y, 0, bottom - y]]) {
      slide.addShape(S.line, { ...box(lx, ly, lw, lh), line: { color: T.accentFill, width: 1.5 } });
    }
  }
  return bottom;
}
```
