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
// then { name, values[, sizes] } per set; labels unused. accent: with several series (bars or lines), the index of the
// series the title names, which alone takes the accent (default the last); with one series of bars, the index of the one category to color —
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
  // Several series: accent names the series the title is about (its index); by default the last — the current period.
  // "Pilot districts" against "other districts" put the pilot first, and order alone lit the comparison group instead.
  const lead = series.length > 1 && Number.isInteger(accent) && accent >= 0 && accent < series.length ? accent : series.length - 1;
  const byMeaning = (grays) => series.map((_, i) => (i === lead ? T.accentFill : grays[(i - (i > lead ? 1 : 0)) % grays.length]));
  if (accent === undefined) accent = bar && series.length === 1 && !overlap && grouping === 'clustered' ? (labels?.length ?? 0) - 1 : -1;
  if (accent === null) accent = -1;
  const paint = (fallback) => Array.isArray(colors) && colors.length ? [...colors] : fallback;
  // A doughnut's slices are its categories, and nothing else names them: its labels carry the share only, so without
  // the legend four coloured arcs read as four numbers of nothing. It keeps its legend beside the ring.
  const ring = type === 'doughnut';
  const legendOptions = { showLegend: legend ?? (ring || series.length > 1), legendPos: ring && legendPos === 'b' ? 'r' : legendPos,
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
    // Horizontal bars read top-down in the order they were given: PowerPoint stacks a bar chart's first category at
    // the bottom, so "반도체, 디스플레이, 가전, 모바일" came out upside down. The category axis runs max-to-min and the
    // value axis crosses it at the far end, so it stays under the bars.
    ...(type === 'bar' ? { catAxisOrientation: 'maxMin', catAxisCrossesAt: 'max' } : {}),
    // A series below zero: the category labels sit at the plot's foot, not on the zero line where PowerPoint puts them
    // by default and where they would run through the loss columns.
    ...((series || []).some((s) => (Array.isArray(s.values) ? s.values : []).some((v) => v < 0)) ? { catAxisLabelPos: 'low' } : {}),
    ...(plot ? { layout: { ...plot } } : pinned ? { layout: PLOT } : {}),
    ...(field ? { plotArea: { fill: { color: field } } } : {}),
    // The label format hides zero (the empty half of an accent pair or a stacked segment) and keeps negatives: `format;;`
    // left a loss column unlabelled. A format that already carries its own sections is the author's.
    showValue: showValues, dataLabelColor: valueColor, dataLabelFontSize: size, dataLabelFontFace: T.data, dataLabelFormatCode: String(format).includes(';') ? format : `${format};-${format};` };
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
    // A bullet whose actual passes its target covered the target bar whole: the over-achievers, the rows the reader
    // most wants to compare, showed no target at all. The plot is pinned to a known scale and each target also
    // stands as a tick across its bar, in the ink, so it reads over the accent as well as past it.
    const horizontal = type === 'bar';
    const scale = max ?? Math.max(...series.flatMap((s) => s.values)) * 1.1;
    const labelRoom = horizontal ? Math.max(...(labels || []).map((l) => textW(String(l), size, T.sans))) + 0.2 : 0;
    const frame = plot ?? (horizontal
      ? { x: Math.min(0.4, labelRoom / w), y: 0.02, w: 0.97 - Math.min(0.4, labelRoom / w), h: 0.82 }
      : { x: 0.03, y: 0.05, w: 0.94, h: 0.74 });
    slide.addChart(pres.ChartType.bar, series.map((s) => ({ ...s, labels })), { ...base, barDir: horizontal ? 'bar' : 'col',
      barOverlapPct: 100, barGapWidthPct: 45, chartColors: paint([T.markSoft, T.accentFill]), showValue: false,
      valAxisMaxVal: scale, valAxisMinVal: min, layout: { ...frame } });
    const targets = series[0].values, n = targets.length;
    targets.forEach((target, i) => {
      if (!Number.isFinite(target)) return;
      const share = (target - min) / ((scale - min) || 1);
      if (horizontal) {
        const slot = (frame.h * h) / n, cy = y + frame.y * h + (i + 0.5) * slot, tx = x + frame.x * w + frame.w * w * share;
        slide.addShape(S.line, { ...box(tx, cy - slot * 0.34, 0, slot * 0.68), line: { color: T.ink, width: 2.25 } });
      } else {
        const slot = (frame.w * w) / n, cx = x + frame.x * w + (i + 0.5) * slot, ty = y + frame.y * h + frame.h * h * (1 - share);
        slide.addShape(S.line, { ...box(cx - slot * 0.34, ty, slot * 0.68, 0), line: { color: T.ink, width: 2.25 } });
      }
    });
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
      barGrouping: grouping, barGapWidthPct: 60, chartColors: paint(series.length === 1 ? [T.mark] : byMeaning(series.length === 2 ? [T.markSoft] : [T.markSoft, T.mark])),
      dataLabelPosition: grouping === 'stacked' || grouping === 'percentStacked' ? 'ctr' : 'outEnd' });
    annotate();
    return;
  }
  // Lines follow the bars' reading: the earlier series gray, the last — the current period — in the accent. The
  // first series took the accent here, so "전년" glowed and "올해", the line the title was about, sat in gray.
  const lineColors = series.length === 1 ? [T.accentFill] : byMeaning(series.length === 2 ? [T.mark] : [T.markSoft, T.mark]);
  slide.addChart(type === 'area' ? pres.ChartType.area : pres.ChartType.line, series.map((s) => ({ ...s, labels })), { ...base, lineSize: 2.5, lineDataSymbol: 'none',
    chartColors: paint(lineColors), dataLabelPosition: 't', ...(type === 'area' ? { chartColorsOpacity: 35 } : {}) });
}
// Waterfall: native stacked columns — an invisible base (the surface color) carries each bar to its running start.
// steps: [{ label, value }] with a negative value for a drop, and { label, total: true } for a closing bar at the running total.
// Values stay editable; the closing figure is labeled by the author (a hero or a takeaway), not by the chart.
// The walk reads as three kinds of bar, each named where the chart starts: the totals (the opening figure and any
// { total: true } step) in the dark neutral, the rises in the accent, the drops in the light neutral — and every bar
// carries its figure (+380, −120, 4,200) over it, so the change is read from the number, not from the colour alone.
// The first step is the opening total. names: the legend words; Korean or English by the labels' script.
// Returns the bottom edge, like every other carrier, so a reading registers under it.
function waterfall(slide, x, y, w, h, steps, { size = DIAG.note, surface = T.paper, format = (v) => Number(v).toLocaleString('en-US'), names, floor } = {}) {
  let run = 0; const labels = [], base = [], total = [], rise = [], drop = [], figures = [];
  steps.forEach((s, i) => {
    labels.push(s.label);
    if (s.total || i === 0) {
      if (i === 0 && !s.total) run = Number(s.value) || 0;
      base.push(0); total.push(run); rise.push(0); drop.push(0); figures.push({ top: run, text: format(run) });
      return;
    }
    if (s.value >= 0) { base.push(run); total.push(0); rise.push(s.value); drop.push(0); run += s.value; figures.push({ top: run, text: `+${format(s.value)}` }); }
    else { run += s.value; base.push(run); total.push(0); rise.push(0); drop.push(-s.value); figures.push({ top: run - s.value, text: `\u2212${format(-s.value)}` }); }
  });
  const korean = HANGUL.test(labels.join(''));
  const legend = names ?? (korean ? { total: '합계', rise: '증가', drop: '감소' } : { total: 'Total', rise: 'Increase', drop: 'Decrease' });
  const colors = { total: T.mark, rise: T.accentFill, drop: T.markSoft };
  // The legend row sits over the plot; the plot is pinned under it so every figure lands over its own bar.
  const legendH = lineH(size, T.sans, 1.2) + GAP.within, plotY = y + legendH, plotH = h - legendH;
  const peak = Math.max(...figures.map((f) => f.top));
  // A bridge of small steps between large totals (3,060 → 2,940) drew every step as a hairline: on an axis from zero
  // a 150 on 3,060 is 3 % of the bar. The axis starts at a round floor under the lowest level the walk reaches (the
  // think-cell reading), and each total bar carries a break mark near its foot so no one reads it as its full height.
  // floor: 0 keeps the zero axis; by default the floor applies only when the walk stays above 60 % of its peak.
  const levels = steps.map((_, i) => base[i] + (total[i] || 0)).concat(figures.map((f) => f.top));
  const low = Math.min(...steps.map((_, i) => (total[i] ? total[i] : base[i])));
  const nice = (v) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, v))) - 1); return Math.floor(v / p) * p; };   // two significant digits: 2,646 → 2,600
  floor ??= low > Math.max(...levels) * 0.6 ? nice(low * 0.9) : 0;
  // Headroom for the figures over the bars is a share of the span the plot shows, not of the peak: on a floored axis
  // 15 % of 3,060 left the upper half of the plot empty.
  const top = peak + (peak - floor) * 0.18 || 1;
  slide.addChart(pres.ChartType.bar, [
    { name: '', labels, values: base }, { name: legend.total, labels, values: total }, { name: legend.rise, labels, values: rise }, { name: legend.drop, labels, values: drop },
  ], { ...box(x, plotY, w, plotH), barDir: 'col', barGrouping: 'stacked', barGapWidthPct: 40, chartColors: [surface, colors.total, colors.rise, colors.drop],
    fontFace: T.sans, showLegend: false, showValue: false, catAxisLabelColor: T.muted, catAxisLabelFontSize: size, catAxisLabelFontFace: T.sans,
    catAxisLineShow: false, valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
    valAxisMinVal: floor, valAxisMaxVal: top, layout: { ...PLOT } });
  let lx = x + PLOT.x * w;
  for (const key of ['total', 'rise', 'drop']) {
    const sw = 0.14, tw = textW(legend[key], size, T.sans) + 0.1;
    slide.addShape(S.rect, { ...box(lx, y + (legendH - GAP.within - sw) / 2, sw, sw), fill: { color: colors[key] }, line: { color: colors[key] } });
    text(slide, legend[key], lx + sw + GAP.bind, y, tw, size, { color: T.muted, h: legendH - GAP.within, valign: 'middle', lh: 1 });
    lx += sw + GAP.bind + tw + GAP.between;
  }
  const slot = (PLOT.w * w) / labels.length;
  figures.forEach((f, i) => {
    const cx = x + PLOT.x * w + (i + 0.5) * slot, barTop = plotY + PLOT.y * plotH + PLOT.h * plotH * (1 - (f.top - floor) / (top - floor));
    text(slide, f.text, cx - slot / 2, barTop - 0.3, slot, size, { color: T.body, font: T.data, align: 'center', h: 0.26, valign: 'bottom', lh: 1 });
    // The break mark: a band of the page across the total bar, a fifth of the way up, drawn only on a floored axis.
    if (floor > 0 && total[i]) {
      const foot = plotY + (PLOT.y + PLOT.h) * plotH, bw = slot * (1 - 0.4 / 1.4);
      slide.addShape(S.parallelogram, { ...box(cx - bw / 2 - 0.04, foot - PLOT.h * plotH * 0.2 - 0.05, bw + 0.08, 0.1), fill: { color: surface }, line: { color: surface, width: 0 } });
    }
  });
  return y + h;
}
// Dumbbell: two values per item joined by a rule — before/after, plan/actual, min/max. rows: [{ label, a, b }]; a muted, b accent.
// Drawn with rules and dots (not bars), so it is a diagram of two points, never a picture of a bar chart.
function dumbbell(slide, x, y, w, rows, { min, max, labelW, rowH = 0.6, format = (v) => String(v), size = TYPE.caption } = {}) {
  // The label column is as wide as its longest label (a fixed 2.2 in plus the value room left a 1.5 in track on a
  // 5.7 in stage, the four rows crowded into its right third); the track takes the rest.
  labelW ??= Math.min(2.2, Math.max(0.8, ...rows.map((r) => textW(String(r.label), size, T.sans))) + GAP.between);
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
  if (span < 1.5) throw new Error(`dumbbell: ${w.toFixed(2)} in leaves a ${span.toFixed(2)} in track beside ${labelW.toFixed(2)} in of labels (floor 1.5) — widen the column or shorten the labels`);
  const at = (v) => x0 + ((v - lo) / ((hi - lo) || 1)) * span;
  rows.forEach((r, i) => {
    const cy = y + i * rowH + rowH / 2;
    // The label box spans its row (the values' boxes are 0.4 in), so a row reads as a label and its two figures, not
    // as three peers of one size set in two faces.
    const lh = Math.max(0.46, rowH - 0.1);
    slide.addText(r.label, { ...box(x, cy - lh / 2, labelW, lh), fontFace: T.sans, fontSize: size, color: T.ink, margin: 0, valign: 'middle' });
    const xa = at(r.a), xb = at(r.b), lead = xb >= xa;
    slide.addShape(pres.ShapeType.line, { x: Math.min(xa, xb), y: cy, w: Math.abs(xb - xa), h: 0, line: { color: T.line, width: 3 } });
    slide.addShape(pres.ShapeType.ellipse, { x: xa - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: T.mark }, line: { color: T.mark, width: 0 } });
    slide.addShape(pres.ShapeType.ellipse, { x: xb - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: T.accentFill }, line: { color: T.accentFill, width: 0 } });
    slide.addText(format(r.a), { ...box(lead ? xa - 1.05 : xa + 0.2, cy - 0.2, 0.85, 0.4), fontFace: T.data, fontSize: vs, color: T.muted, align: lead ? 'right' : 'left', margin: 0, valign: 'middle' });
    slide.addText(format(r.b), { ...box(lead ? xb + 0.2 : xb - 1.05, cy - 0.2, 0.85, 0.4), fontFace: T.data, fontSize: vs, color: T.ink, bold: true, align: lead ? 'left' : 'right', margin: 0, valign: 'middle' });
  });
  return y + rows.length * rowH;
}
// Small multiples: n identical charts on one row, one label above each, shared axis range. The panels are the same
// shape across groups, so the categories are usually one row-wide `labels` — a panel may still carry its own.
// A panel names itself with `label` (or `title`); without categories the row is refused here, with the fix named,
// instead of failing inside the chart call on a missing array.
function smallMultiples(slide, x, y, w, h, panels, { type = 'col', max, gap = GUTTER, format = '#,##0', labels = null } = {}) {
  const pw = (w - gap * (panels.length - 1)) / panels.length, th = lineH(DIAG.label, T.sans, 1.2), cy = y + th + GAP.within;
  const top = max ?? Math.max(...panels.flatMap((p) => p.series.flatMap((s) => s.values))) * 1.15;
  panels.forEach((p, i) => {
    const px = x + i * (pw + gap), cats = p.labels ?? labels;
    if (!Array.isArray(cats) || !cats.length)
      throw new Error(`smallMultiples: panel ${i + 1} has no categories — pass one labels: [...] for the row, or labels on each panel`);
    text(slide, p.label ?? p.title ?? '', px, y, pw, 'label', { h: th });
    chart(slide, px, cy, pw, h - (cy - y), { type, labels: cats, series: p.series, max: top, accent: p.accent ?? -1, format });
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
// tableColW: the widths a table takes when the author names none — the rule a Word or PDF table follows. Equal columns
// while every cell fits its column on one line; otherwise each column its longest line and the rest shared evenly, or,
// when the lines cannot all fit, its longest word, then its whole line for a column whose line costs no more than an
// even share of what is left (cheapest first), and the remainder where the text is longest. Equal columns broke
// "서울 중앙 허브" over three lines beside four columns of short figures and ran the table into its source line.
// `measure(text, row, column)` is one line's width in inches, padding included; row -1 is the header.
function tableColW(matrix, w, measure) {
  const n = Math.max(...matrix.map((r) => r.length)), longest = Array(n).fill(0), word = Array(n).fill(0);
  matrix.forEach((r, i) => r.forEach((t, j) => {
    const s = String(t ?? '');
    longest[j] = Math.max(longest[j], measure(s, i - 1, j));
    for (const part of s.split(/\s+/).filter(Boolean)) word[j] = Math.max(word[j], measure(part, i - 1, j));
  }));
  const sum = (a) => a.reduce((x, v) => x + v, 0);
  if (longest.every((v) => v <= w / n)) return longest.map(() => w / n);
  if (sum(longest) <= w) return longest.map((v) => v + (w - sum(longest)) / n);
  if (sum(word) >= w) return word.map((v) => v * w / sum(word));
  const widths = [...word], open = new Set(widths.keys()), need = (j) => longest[j] - word[j];
  let room = w - sum(word);
  for (const j of [...open].sort((a, b) => need(a) - need(b))) {
    if (need(j) > room / open.size) break;
    widths[j] = longest[j]; room -= need(j); open.delete(j);
  }
  const flexible = sum([...open].map(need));
  for (const j of open) widths[j] += flexible > 0 ? room * need(j) / flexible : room / open.size;
  return widths;
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
  // A figure keeps its unit: "1.6시간", "2,840원", "3.1일" are figures as much as "94.1%", and read as text they sat
  // left in a column beside right-aligned percentages. A period ("1분기", "3주차") is a label and stays left. A unit
  // may stand a space from its multiplier ("2.6억 원").
  const numeric = (t) => /^[\s~+\-−–$€₩£(]*[\d.,]+(?:\s*(?:[%xXKMBT]|배|건|억|조|만|천|원|만원|억원|시간|일|개월|개|명|대|곳|분|초|회|점|년|위))*(?:pt|p)?[)]?[\s]*$|^[-–—]$/.test(String(t ?? ''));
  const columnNumeric = header.map((_, j) => rows.length > 0 && rows.every((r) => r[j] === '' || r[j] == null || numeric(r[j])));
  const alignOf = (j) => alignments[j] || (j > 0 && columnNumeric[j] ? 'right' : 'left');
  const filled = highlightStyle === 'filled' && highlightCol >= 0;
  // Widths follow the text (tableColW) unless colW names them; a cell wraps by the eojeol inside its column, and a row
  // grows to its tallest cell, so the frame, the foot guard, and the rules below stand where the rows end.
  const padX = sp.margin[1] + sp.margin[3], padY = sp.margin[0] + sp.margin[2];
  const boldAt = (i, j) => i < 0 || j === verdict || groupRows.includes(i) || emphasisCells.some(([r, c]) => r === i && c === j) || (j === 0 && !subRows.includes(i));
  const shown = (t, i, j) => (i >= 0 && subRows.includes(i) && j === 0 ? `    ${t ?? ''}` : String(t ?? ''));
  const matrix = [header, ...rows.map((r, i) => (groupStarts.has(i) ? [groupStarts.get(i).name, ...r.slice(1)] : r))];
  // A line is measured against the wrap's own margin (wrapKo breaks at 98 % of the column) with a hair to spare, or
  // the column made to hold "처리량 (건)" exactly would break it.
  const widths = colW || tableColW(matrix, w, (t, i, j) => textW(t, size, sp.font, boldAt(i, j)) / WRAP_MARGIN + padX + 0.01);
  const wrapped = (t, i, j) => wrapKo(shown(t, i, j), widths[j] - padX, size, sp.font, boldAt(i, j));
  const heightOf = (r, i) => Math.max(rowH, ...r.map((t, j) => (i >= 0 && j === 0 && groupStarts.size ? 0
    : MEASURE(wrapped(t, i, j), { font: sp.font, size, bold: boldAt(i, j), width: widths[j] - padX }).height + padY)));
  const heights = [heightOf(header, -1), ...rows.map((r, i) => heightOf(r, i))].map((v) => Math.round(v * 100) / 100);
  const head = (t, j) => ({ text: runsOf(wrapped(t, -1, j)), options: { bold: true, color: filled && j === highlightCol ? T.accentLabel.color : headerColor, fill: { color: filled && j === highlightCol ? T.accentLabel.fill : headerFill }, fontFace: sp.font, fontSize: size, align: alignOf(j) } });
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
    return { text: runsOf(wrapped(t, i, j)), options };
  };
  // A merged label cell owns the rows it spans: the rows under a group's first row start at the second column.
  const body = rows.map((r, i) => r.map((t, j) => cell(t, i, j)).filter((c, j) => !(j === 0 && groupEnds.size && !groupStarts.has(i))));
  // The frame's height is declared: with merged cells the generator falls back to a 1 in frame under rows that
  // reach 2 in, and the audit then reads a hollow band where the table's lower rows stand.
  const bottom = y + heights.reduce((a, v) => a + v, 0);
  const wraps = heights.some((v) => v > rowH) ? ` (${heights.filter((v) => v > rowH).length} rows wrap at these widths — name colW, or shorten the longest cells)` : '';
  footGuard('table', y, bottom, `${Math.max(0, Math.floor((Z.body.bottom - y) / rowH) - 1)} rows fit from this top (tableRows(avail(top)))${wraps} — cut rows, dense: true, or start higher`);
  slide.addTable([header.map(head), ...body],
    { x, y, w, h: bottom - y, colW: widths, rowH: heights, border: Array.isArray(border) ? border.map((e) => ({ ...e })) : { ...border }, margin: [...sp.margin], valign: 'middle',
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
