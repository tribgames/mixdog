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
// overlap: true draws a bullet — series[0] the track or target (muted), series[1] the actual (accent), bars laid over each other.
// note: { at, text } annotates one column (single-series 'col' only): the plot area is pinned (PLOT) so the bar's
// position is known, a leader rises from above its value label to a short label at the top of the frame.
// Stacked-bar labels must sit inside ('inEnd' | 'ctr' | 'inBase'); zero segments are hidden by the format code.
const PLOT = { x: 0.03, y: 0.14, w: 0.94, h: 0.72 };   // plot area as fractions of the chart frame when a note pins it
function chart(slide, x, y, w, h, { type = 'col', labels, series, accent = -1, overlap = false, max, min = 0, format = '#,##0', size = TYPE.caption, note = null,
  colors, legend, legendPos = 'b', plot, categoryLabels = true, showValues = true, grouping = 'clustered',
  valueColor = T.body, categoryColor = T.muted } = {}) {
  const bar = type === 'col' || type === 'bar';
  const paint = (fallback) => Array.isArray(colors) && colors.length ? [...colors] : fallback;
  const legendOptions = { showLegend: legend ?? (series.length > 1 && type !== 'doughnut'), legendPos,
    legendColor: valueColor, legendFontSize: size, legendFontFace: T.sans };
  const pinned = Boolean(note) && type === 'col' && series.length === 1;
  const top = max ?? (pinned ? Math.ceil(Math.max(...series[0].values) * 1.15) : undefined);
  const base = { ...box(x, y, w, h), fontFace: T.sans, ...legendOptions,
    catAxisHidden: !categoryLabels, catAxisLabelColor: categoryColor, catAxisLabelFontSize: size, catAxisLabelFontFace: T.sans, catAxisLineShow: false,
    valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
    ...(top != null ? { valAxisMaxVal: top, valAxisMinVal: min } : {}),
    ...(plot ? { layout: { ...plot } } : pinned ? { layout: PLOT } : {}),
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
      barOverlapPct: 100, barGapWidthPct: 45, chartColors: paint([T.paperAlt, T.accent]), showValue: false });
    return;
  }
  if (type === 'doughnut') {
    slide.addChart(pres.ChartType.doughnut, [{ name: series[0].name, labels, values: series[0].values }], { ...base, holeSize: 62,
      chartColors: paint([T.accent, T.muted, T.line, T.paperAlt, T.tint]), dataLabelPosition: 'bestFit', dataLabelColor: valueColor, showLabel: false, showPercent: false });
    return;
  }
  if (type === 'radar') {
    slide.addChart(pres.ChartType.radar, series.map((s) => ({ ...s, labels })), { ...base, radarStyle: 'marker', lineSize: 2,
      chartColors: paint([T.accent, T.muted]), showValue: false });
    return;
  }
  if (type === 'scatter' || type === 'bubble') {
    slide.addChart(type === 'bubble' ? pres.ChartType.bubble : pres.ChartType.scatter, series, { ...base, valAxisHidden: false, catAxisHidden: false,
      valAxisLineShow: true, catAxisLineShow: true, valAxisLineColor: T.line, catAxisLineColor: T.line, valAxisLabelColor: T.muted, valAxisLabelFontSize: size,
      lineSize: 0, lineDataSymbol: 'circle', lineDataSymbolSize: type === 'bubble' ? 12 : 9, chartColors: paint([T.accent, T.muted, T.line]), showValue: false });
    return;
  }
  if (bar && accent >= 0 && series.length === 1) {
    const values = series[0].values;
    slide.addChart(pres.ChartType.bar, [
      { name: series[0].name, labels, values: values.map((v, i) => (i === accent ? 0 : v)) },
      { name: series[0].name + ' ·', labels, values: values.map((v, i) => (i === accent ? v : 0)) },
    ], { ...base, barDir: type === 'bar' ? 'bar' : 'col', barGrouping: 'stacked', barGapWidthPct: 60,
      chartColors: paint([T.paperAlt, T.accent]), dataLabelPosition: 'inEnd', dataLabelColor: valueColor });
    annotate();
    return;
  }
  if (bar) {
    // One series is one color (PowerPoint would otherwise cycle a color per bar); the accent is reserved for `accent`.
    slide.addChart(pres.ChartType.bar, series.map((s) => ({ ...s, labels })), { ...base, barDir: type === 'bar' ? 'bar' : 'col',
      barGrouping: grouping, barGapWidthPct: 60, chartColors: paint(series.length === 1 ? [T.muted] : [T.muted, T.accent, T.line]),
      dataLabelPosition: grouping === 'stacked' || grouping === 'percentStacked' ? 'ctr' : 'outEnd' });
    annotate();
    return;
  }
  slide.addChart(type === 'area' ? pres.ChartType.area : pres.ChartType.line, series.map((s) => ({ ...s, labels })), { ...base, lineSize: 2.5, lineDataSymbol: 'none',
    chartColors: paint([T.accent, T.muted, T.line]), dataLabelPosition: 't', ...(type === 'area' ? { chartColorsOpacity: 35 } : {}) });
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
  ], { ...box(x, y, w, h), barDir: 'col', barGrouping: 'stacked', barGapWidthPct: 40, chartColors: [surface, T.accent, T.muted],
    fontFace: T.sans, showLegend: false, showValue: false, catAxisLabelColor: T.muted, catAxisLabelFontSize: size, catAxisLabelFontFace: T.sans,
    catAxisLineShow: false, valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' } });
}
// Dumbbell: two values per item joined by a rule — before/after, plan/actual, min/max. rows: [{ label, a, b }]; a muted, b accent.
// Drawn with rules and dots (not bars), so it is a diagram of two points, never a picture of a bar chart.
function dumbbell(slide, x, y, w, rows, { min, max, labelW = 2.2, rowH = 0.6, format = (v) => String(v), size = TYPE.caption } = {}) {
  const values = rows.flatMap((r) => [r.a, r.b]);
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  const x0 = x + labelW + 1.0, span = w - labelW - 2.0, d = 0.18;
  const at = (v) => x0 + ((v - lo) / ((hi - lo) || 1)) * span;
  rows.forEach((r, i) => {
    const cy = y + i * rowH + rowH / 2;
    slide.addText(r.label, { ...box(x, cy - 0.15, labelW, 0.3), fontFace: T.sans, fontSize: size, color: T.ink, margin: 0, valign: 'middle' });
    const xa = at(r.a), xb = at(r.b), lead = xb >= xa;
    slide.addShape(pres.ShapeType.line, { x: Math.min(xa, xb), y: cy, w: Math.abs(xb - xa), h: 0, line: { color: T.line, width: 2 } });
    slide.addShape(pres.ShapeType.ellipse, { x: xa - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: T.muted }, line: { color: T.muted, width: 0 } });
    slide.addShape(pres.ShapeType.ellipse, { x: xb - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: T.accent }, line: { color: T.accent, width: 0 } });
    slide.addText(format(r.a), { ...box(lead ? xa - 0.95 : xa + 0.15, cy - 0.15, 0.8, 0.3), fontFace: T.data, fontSize: DIAG.note, color: T.muted, align: lead ? 'right' : 'left', margin: 0, valign: 'middle' });
    slide.addText(format(r.b), { ...box(lead ? xb + 0.15 : xb - 0.95, cy - 0.15, 0.8, 0.3), fontFace: T.data, fontSize: DIAG.note, color: T.ink, bold: true, align: lead ? 'left' : 'right', margin: 0, valign: 'middle' });
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
// A table is a readable page object, not a tiny appendix squeezed below a chart.
// Give numeric columns explicit alignment; banding and emphasis are optional. Anatomy from SPEC.table: the header on the
// basement surface, row rules in the subtle line (repeated items), the verdict column bold on the tint — or, with
// tones: ['positive', 'warning', ...] one per body row, each verdict word on its state's weak field in its state text.
function table(slide, x, y, w, header, rows, { colW, rowH, verdict = -1, tones = [], size,
  headerFill, headerColor, banded = false, alignments = [], highlightRows = [], emphasisCells = [], border } = {}) {
  const sp = spec('table');
  rowH ??= sp.rowH; size ??= sp.size; headerFill ??= sp.header.fill; headerColor ??= sp.header.color; border ??= sp.border;
  const head = (t, j) => ({ text: t, options: { bold: true, color: headerColor, fill: { color: headerFill }, fontFace: sp.font, fontSize: size, align: alignments[j] || 'left' } });
  // emphasisCells: explicit [body-row, column] pairs, zero-based. Comparing
  // different dimensions may require different cells, not one highlighted row.
  const cell = (t, i, j) => {
    const emphasized = emphasisCells.some(([row, column]) => row === i && column === j);
    const state = j === verdict && tones[i] ? tone(tones[i]) : null;
    return { text: t, options: { fontFace: sp.font, fontSize: size, color: state ? state.color : emphasized ? T.accent : j === 0 ? T.ink : T.body, bold: emphasized || j === 0 || j === verdict,
      align: alignments[j] || 'left', fill: { color: state ? state.fill : emphasized || j === verdict || highlightRows.includes(i) ? T.tint : banded && i % 2 ? T.paperAlt : T.paper } } };
  };
  slide.addTable([header.map(head), ...rows.map((r, i) => r.map((t, j) => cell(t, i, j)))],
    { x, y, w, colW: colW || header.map(() => w / header.length), rowH, border: Array.isArray(border) ? border.map((edge) => ({ ...edge })) : { ...border }, margin: [...sp.margin], valign: 'middle',
      objectName: specName('table', tones.length ? 'toned' : verdict >= 0 ? 'verdict' : banded ? 'banded' : 'plain') });
  return y + rowH * (rows.length + 1);
}
```
