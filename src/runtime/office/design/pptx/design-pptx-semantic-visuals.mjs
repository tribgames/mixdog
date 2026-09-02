import { metricDisplayValue, strings } from '../design-tokens.mjs';
import { pptShape, pptText } from './design-pptx-primitives.mjs';
import {
  semanticChartSeries,
  timelineFlowSegments,
  timelineStageRole,
  twoTrackBranchSegments,
} from './design-pptx-semantic-flow.mjs';
import { clamp, plainObject } from '../../shared/values.mjs';

const MIN_FONT = 12;

function color(design, role, fallback) {
  const value = design.tokens.colors[String(role || '')];
  return value || fallback;
}

function frame(region, design) {
  const fillRole = region.style?.fillRole;
  if (!fillRole) return [];
  return [pptShape(region.slide, 'rectangle', {
    left: region.left,
    top: region.top,
    width: region.width,
    height: region.height,
    fillColor: color(design, fillRole, design.tokens.colors.surface),
    lineColor: color(design, region.style?.lineRole || fillRole, design.tokens.colors.surface),
    lineTransparency: region.style?.lineRole ? 0 : 100,
  })];
}

function displayValue(entry) {
  return String(entry?.displayValue || entry?.display || metricDisplayValue(entry));
}

function supportingDetail(entry) {
  const detail = String(entry?.detail || '').trim();
  if (!detail) return '';
  return displayValue(entry).trim().endsWith(detail) ? '' : detail;
}

function allocationGateParts(entry) {
  let release = String(entry?.release || '').trim();
  let stop = String(entry?.stop || '').trim();
  const detail = String(entry?.detail || entry?.gate || '').trim();
  const remainder = [];
  for (const part of detail.split(/\s*[·|]\s*/u).filter(Boolean)) {
    if (!release && /^release\b/iu.test(part)) release = part.replace(/^release\s*/iu, '');
    else if (!stop && /^stop\b/iu.test(part)) stop = part.replace(/^stop\s*/iu, '');
    else remainder.push(part);
  }
  return { release, stop, detail: remainder.join(' · ') || (!release && !stop ? detail : '') };
}

function annotationEntries(operation, chart) {
  const explicit = Array.isArray(operation.annotations)
    ? operation.annotations
    : Array.isArray(chart.annotations)
      ? chart.annotations
      : [];
  if (explicit.length) return explicit.slice(0, 4);
  return (Array.isArray(chart.series) ? chart.series : []).slice(0, 3).map((series) => {
    const values = Array.isArray(series.values) ? series.values : [];
    return {
      label: series.name,
      value: values.at(-1),
      note: values.length > 1 && Number(values.at(-2))
        ? `${(((Number(values.at(-1)) / Number(values.at(-2))) - 1) * 100).toFixed(1)}% vs prior`
        : '',
    };
  });
}

function renderBottomAnnotatedChart(region, operation, design, slide, chart) {
  const gap = clamp(region.style?.gutter || 16, 12, 24);
  const railHeight = clamp(region.height * 0.34, 112, 148);
  const chartHeight = region.height - railHeight - gap;
  const railTop = region.top + chartHeight + gap;
  const annotations = annotationEntries(operation, chart);
  const labelWidth = clamp(region.width * 0.17, 118, 158);
  const cellsLeft = region.left + labelWidth;
  const cellWidth = (region.width - labelWidth) / Math.max(1, annotations.length);
  const output = [
    ...frame({ ...region, slide }, design),
    {
      op: 'add_chart',
      slide,
      chartType: chart.type || chart.chartType || 'column',
      title: chart.title || '',
      categories: Array.isArray(chart.categories) ? chart.categories : [],
      series: semanticChartSeries(chart, design.tokens.colors),
      left: region.left,
      top: region.top,
      width: region.width,
      height: chartHeight,
      showValues: chart.showValues !== false,
      dataLabelPosition: chart.dataLabelPosition || 'outside_end',
      valueNumberFormat: chart.valueNumberFormat || '',
      showLegend: chart.showLegend ?? (chart.series?.length > 1),
      zeroBaseline: chart.zeroBaseline ?? ['column', 'bar'].includes(String(chart.type || '').toLowerCase()),
    },
    pptShape(slide, 'rectangle', {
      left: region.left,
      top: railTop,
      width: region.width,
      height: railHeight,
      fillColor: design.tokens.colors.inverse,
      lineColor: design.tokens.colors.inverse,
    }),
    pptText(slide, String(operation.annotationLabel || 'DECISION SIGNALS').toUpperCase(), {
      left: region.left + 18,
      top: railTop + 20,
      width: labelWidth - 34,
      height: 32,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.accent2,
    }),
  ];
  annotations.forEach((entry, index) => {
    const left = cellsLeft + (cellWidth * index);
    const value = entry?.value == null ? '' : metricDisplayValue(entry);
    const note = String(entry?.note || entry?.detail || '');
    output.push(pptText(slide, `SIGNAL ${String(index + 1).padStart(2, '0')}`, {
      left: left + 12,
      top: railTop + 14,
      width: cellWidth - 24,
      height: 15,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: index === 0 ? design.tokens.colors.accent : design.tokens.colors.accent2,
    }));
    output.push(pptText(slide, String(entry?.label || '').toUpperCase(), {
      left: left + 12,
      top: railTop + 34,
      width: cellWidth - 24,
      height: 16,
      fontName: design.tokens.typography.body,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.onInverse,
    }));
    if (value) output.push(pptText(slide, value, {
      left: left + 12,
      top: railTop + 56,
      width: cellWidth - 24,
      height: 26,
      fontName: design.tokens.typography.data,
      fontSize: clamp(entry?.fontSize || 22, 18, 27),
      bold: true,
      color: index === 0 ? design.tokens.colors.accent2 : design.tokens.colors.onInverse,
    }));
    if (note) output.push(pptText(slide, note, {
      left: left + 12,
      top: railTop + (value ? 90 : 58),
      width: cellWidth - 24,
      height: Math.max(18, railHeight - (value ? 100 : 68)),
      fontName: design.tokens.typography.body,
      fontSize: MIN_FONT,
      color: design.tokens.colors.surface2,
    }));
  });
  return output;
}

function renderAnnotatedChart(region, operation, design, slide) {
  const chart = plainObject(operation.chart) ? operation.chart : null;
  if (!chart) throw new Error('annotated-chart requires operation.chart');
  const variant = String(region.style?.variant || 'signal-right');
  if (variant === 'signal-bottom') {
    return renderBottomAnnotatedChart(region, operation, design, slide, chart);
  }
  const gap = clamp(region.style?.gutter || 20, 14, 30);
  const railWidth = clamp(region.width * 0.29, 170, 250);
  const chartWidth = region.width - railWidth - gap;
  const railOnLeft = variant === 'signal-left';
  const railLeft = railOnLeft ? region.left : region.left + chartWidth + gap;
  const chartLeft = railOnLeft ? region.left + railWidth + gap : region.left;
  const annotations = annotationEntries(operation, chart);
  const output = [
    ...frame({ ...region, slide }, design),
    {
      op: 'add_chart',
      slide,
      chartType: chart.type || chart.chartType || 'column',
      title: chart.title || '',
      categories: Array.isArray(chart.categories) ? chart.categories : [],
      series: semanticChartSeries(chart, design.tokens.colors),
      left: chartLeft,
      top: region.top,
      width: chartWidth,
      height: region.height,
      showValues: chart.showValues !== false,
      dataLabelPosition: chart.dataLabelPosition || 'outside_end',
      valueNumberFormat: chart.valueNumberFormat || '',
      showLegend: chart.showLegend ?? (chart.series?.length > 1),
      zeroBaseline: chart.zeroBaseline ?? ['column', 'bar'].includes(String(chart.type || '').toLowerCase()),
    },
    pptShape(slide, 'rectangle', {
      left: railLeft,
      top: region.top,
      width: railWidth,
      height: region.height,
      fillColor: design.tokens.colors.inverse,
      lineColor: design.tokens.colors.inverse,
    }),
    pptText(slide, String(operation.annotationLabel || 'DECISION SIGNALS').toUpperCase(), {
      left: railLeft + 18,
      top: region.top + 15,
      width: railWidth - 36,
      height: 16,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.accent2,
    }),
  ];
  const contentTop = region.top + 44;
  const cellHeight = (region.height - 54) / Math.max(1, annotations.length);
  annotations.forEach((entry, index) => {
    const top = contentTop + (cellHeight * index);
    const value = entry?.value == null ? '' : metricDisplayValue(entry);
    if (index > 0) output.push(pptShape(slide, 'rectangle', {
      left: railLeft + 18,
      top: top - 5,
      width: railWidth - 36,
      height: 1,
      fillColor: design.tokens.colors.surface2,
      lineColor: design.tokens.colors.surface2,
    }));
    output.push(pptText(slide, `SIGNAL ${String(index + 1).padStart(2, '0')}`, {
      left: railLeft + 18,
      top: top + 3,
      width: 74,
      height: 16,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.accent,
    }));
    output.push(pptText(slide, String(entry?.label || '').toUpperCase(), {
      left: railLeft + 92,
      top: top + 3,
      width: railWidth - 110,
      height: 16,
      fontName: design.tokens.typography.body,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.onInverse,
      alignment: 'right',
    }));
    if (value) output.push(pptText(slide, value, {
      left: railLeft + 18,
      top: top + 27,
      width: railWidth - 36,
      height: 34,
      fontName: design.tokens.typography.data,
      fontSize: clamp(entry?.fontSize || 25, 19, 31),
      bold: true,
      color: index === 0 ? design.tokens.colors.accent2 : design.tokens.colors.onInverse,
    }));
    const note = String(entry?.note || entry?.detail || '');
    if (note) output.push(pptText(slide, note, {
      left: railLeft + 18,
      top: top + (value ? 68 : 28),
      width: railWidth - 36,
      height: Math.max(18, cellHeight - (value ? 75 : 35)),
      fontName: design.tokens.typography.body,
      fontSize: MIN_FONT,
      color: design.tokens.colors.surface2,
    }));
  });
  return output;
}

function allocationEntries(operation) {
  if (Array.isArray(operation.allocations) && operation.allocations.length) return operation.allocations.slice(0, 4);
  if (Array.isArray(operation.metrics) && operation.metrics.length) return operation.metrics.slice(0, 4);
  return (Array.isArray(operation.columns) ? operation.columns : []).slice(0, 4).map((entry) => ({
    label: entry.title,
    value: entry.value,
    detail: strings(entry.items || entry.body).join(' · '),
  }));
}

function renderAllocation(region, operation, design, slide) {
  const entries = allocationEntries(operation);
  if (!entries.length) throw new Error('allocation requires operation.allocations, metrics, or columns');
  const values = entries.map((entry) => Math.max(0, Number(entry?.value) || 0));
  const total = values.reduce((sum, value) => sum + value, 0) || entries.length;
  const compact = region.style?.compact === true || region.width < 320;
  const output = [...frame({ ...region, slide }, design)];
  const cardInk = design.tokens.colors.inverse;
  const cardMuted = design.inverse ? cardInk : design.tokens.colors.muted;
  const totalLabel = String(operation.allocationLabel || operation.visualLabel || 'TOTAL ALLOCATION').toUpperCase();
  const totalValue = operation.visualText || metricDisplayValue({
    value: total,
    numberFormat: operation.allocationNumberFormat || '',
  });
  if (compact) {
    const compactHeaderHeight = clamp(region.height * 0.18, 34, 42);
    output.push(pptShape(slide, 'rectangle', {
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height,
      fillColor: design.tokens.colors.canvas,
      lineColor: design.tokens.colors.accent,
    }));
    output.push(pptShape(slide, 'rectangle', {
      left: region.left,
      top: region.top,
      width: region.width,
      height: compactHeaderHeight,
      fillColor: design.tokens.colors.accent,
      lineColor: design.tokens.colors.accent,
    }));
    output.push(pptText(slide, totalLabel, {
      left: region.left + 14,
      top: region.top + ((compactHeaderHeight - 16) / 2),
      width: region.width - 28,
      height: 16,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.onAccent,
      alignment: 'center',
    }));
    output.push(pptText(slide, totalValue, {
      left: region.left + 14,
      top: region.top + compactHeaderHeight + 12,
      width: region.width - 28,
      height: 38,
      fontName: design.tokens.typography.data,
      fontSize: clamp(region.height * 0.15, 24, 32),
      bold: true,
      color: cardInk,
      alignment: 'center',
    }));
    output.push(pptText(slide, `${entries.length} TRACKS · DECISION STAMP`, {
      left: region.left + 14,
      top: region.top + compactHeaderHeight + 51,
      width: region.width - 28,
      height: 16,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.accent,
      alignment: 'center',
    }));
    const rowGap = 8;
    const minimumRowHeight = 28;
    const desiredRowsTop = region.top + Math.max(
      compactHeaderHeight + 75,
      region.height * 0.48,
    );
    const latestRowsTop = region.top + region.height
      - (minimumRowHeight * entries.length)
      - (rowGap * (entries.length - 1))
      - 10;
    const rowsTop = Math.min(desiredRowsTop, latestRowsTop);
    const rowHeight = Math.max(
      minimumRowHeight,
      ((region.top + region.height) - rowsTop - (rowGap * (entries.length - 1)) - 10) / entries.length,
    );
    entries.forEach((entry, index) => {
      const top = rowsTop + (index * (rowHeight + rowGap));
      output.push(pptShape(slide, 'rectangle', {
        left: region.left + 14,
        top,
        width: region.width - 28,
        height: rowHeight,
        fillColor: index % 2 === 0 ? design.tokens.colors.surface : design.tokens.colors.surface2,
        lineColor: index % 2 === 0 ? design.tokens.colors.surface : design.tokens.colors.surface2,
      }));
      output.push(pptText(slide, String(entry?.label || ''), {
        left: region.left + 26,
        top: top + 12,
        width: region.width - 84,
        height: 18,
        fontName: design.tokens.typography.body,
        fontSize: MIN_FONT,
        bold: true,
        color: cardInk,
      }));
      output.push(pptText(slide, displayValue(entry), {
        left: region.left + region.width - 64,
        top: top + 10,
        width: 40,
        height: 20,
        fontName: design.tokens.typography.data,
        fontSize: 14,
        bold: true,
        color: cardInk,
        alignment: 'right',
      }));
    });
    return output;
  }
  const headerHeight = clamp(region.height * 0.3, 78, 96);
  output.push(pptShape(slide, 'rectangle', {
    left: region.left,
    top: region.top,
    width: region.width,
    height: headerHeight,
    fillColor: design.tokens.colors.inverse,
    lineColor: design.tokens.colors.inverse,
  }));
  output.push(pptText(slide, totalLabel, {
    left: region.left + 22,
    top: region.top + 16,
    width: region.width * 0.55,
    height: 16,
    fontName: design.tokens.typography.data,
    fontSize: MIN_FONT,
    bold: true,
    color: design.tokens.colors.accent,
  }));
  output.push(pptText(slide, totalValue, {
    left: region.left + 22,
    top: region.top + 39,
    width: region.width * 0.55,
    height: 36,
    fontName: design.tokens.typography.data,
    fontSize: 28,
    bold: true,
    color: design.tokens.colors.onInverse,
  }));
  output.push(pptText(slide, `${entries.length} TRACKS`, {
    left: region.left + (region.width * 0.66),
    top: region.top + 22,
    width: region.width * 0.28,
    height: 18,
    fontName: design.tokens.typography.data,
    fontSize: 15,
    bold: true,
    color: design.tokens.colors.onInverse,
    alignment: 'right',
  }));
  output.push(pptText(slide, 'RELEASE / STOP LOGIC', {
    left: region.left + (region.width * 0.6),
    top: region.top + 50,
    width: region.width * 0.34,
    height: 16,
    fontName: design.tokens.typography.body,
    fontSize: MIN_FONT,
    color: design.tokens.colors.surface2,
    alignment: 'right',
  }));
  const gap = entries.length === 2 ? 24 : 14;
  const columns = Math.min(2, entries.length);
  const rows = Math.ceil(entries.length / columns);
  const cardsTop = region.top + headerHeight + gap;
  const cardWidth = (region.width - (gap * (columns - 1))) / columns;
  const cardHeight = ((region.top + region.height) - cardsTop - (gap * (rows - 1))) / rows;
  twoTrackBranchSegments({
    left: region.left,
    top: region.top,
    width: region.width,
    headerHeight,
    gap,
    count: entries.length,
  }).forEach((segment) => {
    const segmentColor = design.tokens.colors[segment.colorRole];
    output.push(pptShape(slide, 'rectangle', {
      left: segment.left,
      top: segment.top,
      width: segment.width,
      height: segment.height,
      fillColor: segmentColor,
      lineColor: segmentColor,
    }));
  });
  entries.forEach((entry, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = region.left + (column * (cardWidth + gap));
    const top = cardsTop + (row * (cardHeight + gap));
    const gate = allocationGateParts(entry);
    const signal = index % 2 === 0 ? design.tokens.colors.accent : design.tokens.colors.accent2;
    const gateGap = 8;
    const gateLabelWidth = clamp(cardWidth * 0.32, 56, 72);
    const gateValueLeft = left + 40 + gateLabelWidth;
    const gateValueWidth = cardWidth - gateLabelWidth - 76;
    const gateRowsTop = top + 62;
    const gateRowHeight = Math.max(40, (cardHeight - 86 - gateGap) / 2);
    output.push(pptShape(slide, 'rectangle', {
      left,
      top,
      width: cardWidth,
      height: cardHeight,
      fillColor: index % 2 === 0 ? design.tokens.colors.surface : design.tokens.colors.surface2,
      lineColor: design.tokens.colors.surface2,
    }));
    output.push(pptShape(slide, 'oval', {
      left: left + 18,
      top: top + 16,
      width: 28,
      height: 28,
      fillColor: signal,
      lineColor: signal,
    }));
    output.push(pptText(slide, String(index + 1).padStart(2, '0'), {
      left: left + 18,
      top: top + 22,
      width: 28,
      height: 14,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.onAccent,
      alignment: 'center',
    }));
    output.push(pptText(slide, String(entry?.label || ''), {
      left: left + 58,
      top: top + 15,
      width: cardWidth - 142,
      height: 30,
      fontName: design.tokens.typography.display,
      fontSize: 15,
      bold: true,
      color: cardInk,
    }));
    output.push(pptText(slide, displayValue(entry), {
      left: left + cardWidth - 88,
      top: top + 15,
      width: 68,
      height: 28,
      fontName: design.tokens.typography.data,
      fontSize: 18,
      bold: true,
      color: cardInk,
      alignment: 'right',
    }));
    if (gate.release) {
      output.push(pptShape(slide, 'rectangle', {
        left: left + 18,
        top: gateRowsTop,
        width: cardWidth - 36,
        height: gateRowHeight,
        fillColor: design.tokens.colors.canvas,
        lineColor: design.tokens.colors.surface2,
      }));
      output.push(pptShape(slide, 'rectangle', {
        left: left + 18,
        top: gateRowsTop,
        width: 4,
        height: gateRowHeight,
        fillColor: design.tokens.colors.accent,
        lineColor: design.tokens.colors.accent,
      }));
      output.push(pptText(slide, 'RELEASE', {
        left: left + 34,
        top: gateRowsTop + (gateRowHeight * 0.5) - 8,
        width: gateLabelWidth,
        height: 16,
        fontName: design.tokens.typography.data,
        fontSize: MIN_FONT,
        bold: true,
        color: design.tokens.colors.accent,
      }));
      output.push(pptText(slide, gate.release, {
        left: gateValueLeft,
        top: gateRowsTop + (gateRowHeight * 0.5) - 10,
        width: gateValueWidth,
        height: 24,
        fontName: design.tokens.typography.body,
        fontSize: MIN_FONT,
        bold: true,
        color: cardInk,
      }));
    }
    if (gate.stop) {
      const stopTop = gateRowsTop + gateRowHeight + gateGap;
      output.push(pptShape(slide, 'rectangle', {
        left: left + 18,
        top: stopTop,
        width: cardWidth - 36,
        height: gateRowHeight,
        fillColor: design.tokens.colors.canvas,
        lineColor: design.tokens.colors.surface2,
      }));
      output.push(pptShape(slide, 'rectangle', {
        left: left + 18,
        top: stopTop,
        width: 4,
        height: gateRowHeight,
        fillColor: design.tokens.colors.accent2,
        lineColor: design.tokens.colors.accent2,
      }));
      output.push(pptText(slide, 'STOP', {
        left: left + 34,
        top: stopTop + (gateRowHeight * 0.5) - 8,
        width: gateLabelWidth,
        height: 16,
        fontName: design.tokens.typography.data,
        fontSize: MIN_FONT,
        bold: true,
        color: design.tokens.colors.accent2,
      }));
      output.push(pptText(slide, gate.stop, {
        left: gateValueLeft,
        top: stopTop + (gateRowHeight * 0.5) - 10,
        width: gateValueWidth,
        height: 24,
        fontName: design.tokens.typography.body,
        fontSize: MIN_FONT,
        color: cardInk,
      }));
    }
    if (gate.detail) output.push(pptText(slide, gate.detail, {
      left: left + 18,
      top: top + 64,
      width: cardWidth - 36,
      height: Math.max(22, cardHeight - 78),
      fontName: design.tokens.typography.body,
      fontSize: MIN_FONT,
      color: cardMuted,
    }));
  });
  return output;
}

function renderTimeline(region, operation, design, slide) {
  const steps = Array.isArray(operation.steps) ? operation.steps.slice(0, 6) : [];
  if (!steps.length) throw new Error('timeline requires operation.steps');
  const output = [
    ...frame({ ...region, slide }, design),
    pptShape(slide, 'rectangle', {
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height,
      fillColor: design.tokens.colors.inverse,
      lineColor: design.tokens.colors.inverse,
    }),
  ];
  const gap = 16;
  const stride = region.width / steps.length;
  const marker = clamp(stride * 0.16, 22, 36);
  const lineTop = region.top + 56;
  const cardsTop = lineTop + marker + 12;
  const phaseLabels = steps.map((step, index) => (
    String(step?.phase || step?.date || index + 1).padStart(2, '0')
  ));
  const phaseNumbers = phaseLabels.map((label) => {
    const match = label.match(/\d+(?:\.\d+)?/u);
    return match ? Number(match[0]) : Number.NaN;
  });
  const numericMaximum = Math.max(
    1,
    ...phaseNumbers.filter((value) => Number.isFinite(value) && value > 0),
  );
  const terminalPhase = phaseLabels.at(-1);
  output.push(pptText(slide, String(operation.timelineLabel || 'OPERATING CADENCE · 30 DAYS').toUpperCase(), {
    left: region.left + 20,
    top: region.top + 16,
    width: region.width * 0.62,
    height: 18,
    fontName: design.tokens.typography.data,
    fontSize: MIN_FONT,
    bold: true,
    color: design.tokens.colors.accent2,
  }));
  output.push(pptText(slide, `${steps.length} CHECKPOINTS`, {
    left: region.left + (region.width * 0.68),
    top: region.top + 16,
    width: region.width * 0.28,
    height: 18,
    fontName: design.tokens.typography.data,
    fontSize: MIN_FONT,
    bold: true,
    color: design.tokens.colors.onInverse,
    alignment: 'right',
  }));
  output.push(pptShape(slide, 'rectangle', {
    left: region.left + (stride * 0.08),
    top: lineTop + (marker / 2) - 2,
    width: region.width - (stride * 0.16),
    height: 4,
    fillColor: design.tokens.colors.surface2,
    lineColor: design.tokens.colors.surface2,
  }));
  timelineFlowSegments({
    left: region.left,
    lineTop,
    stride,
    marker,
    count: steps.length,
    cardsTop,
  }).forEach((segment) => {
    const segmentColor = design.tokens.colors[segment.colorRole];
    output.push(pptShape(slide, 'rectangle', {
      left: segment.left,
      top: segment.top,
      width: segment.width,
      height: segment.height,
      fillColor: segmentColor,
      lineColor: segmentColor,
    }));
  });
  steps.forEach((step, index) => {
    const center = region.left + (stride * index) + (stride / 2);
    const left = center - (marker / 2);
    const stageRole = timelineStageRole(index, steps.length);
    const active = stageRole !== 'surface2';
    const fill = design.tokens.colors[stageRole];
    const outline = fill;
    const cardLeft = region.left + (stride * index) + (gap / 2);
    const cardTop = cardsTop;
    const cardWidth = stride - gap;
    const cardHeight = Math.max(96, (region.top + region.height) - cardTop - 16);
    const compactCard = region.style?.compact === true || cardHeight < 230;
    const cardFill = index % 2 === 0 ? design.tokens.colors.canvas : design.tokens.colors.surface;
    const phaseLabel = phaseLabels[index];
    const cadenceRatio = Number.isFinite(phaseNumbers[index])
      ? clamp(phaseNumbers[index] / numericMaximum, 0.06, 1)
      : clamp((index + 1) / steps.length, 0.06, 1);
    output.push(pptShape(slide, 'rectangle', {
      left: cardLeft,
      top: cardTop,
      width: cardWidth,
      height: cardHeight,
      fillColor: cardFill,
      lineColor: design.tokens.colors.surface2,
    }));
    output.push(pptShape(slide, 'oval', {
      left,
      top: lineTop,
      width: marker,
      height: marker,
      fillColor: fill,
      lineColor: outline,
    }));
    output.push(pptText(slide, phaseLabel, {
      left,
      top: lineTop + (marker * 0.22),
      width: marker,
      height: marker * 0.55,
      fontName: design.tokens.typography.data,
      fontSize: clamp(marker * 0.32, MIN_FONT, 14),
      bold: true,
      color: active ? design.tokens.colors.onAccent : design.tokens.colors.inverse,
      alignment: 'center',
    }));
    output.push(pptText(slide, 'CHECKPOINT', {
      left: cardLeft + 14,
      top: cardTop + 15,
      width: cardWidth - 28,
      height: 14,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.muted,
    }));
    output.push(pptText(slide, phaseLabel, {
      left: cardLeft + 14,
      top: cardTop + 34,
      width: cardWidth - 28,
      height: 24,
      fontName: design.tokens.typography.data,
      fontSize: 16,
      bold: true,
      color: active ? fill : design.tokens.colors.accent2,
    }));
    output.push(pptText(slide, 'ACTION', {
      left: cardLeft + 14,
      top: cardTop + 70,
      width: cardWidth - 28,
      height: 14,
      fontName: design.tokens.typography.data,
      fontSize: MIN_FONT,
      bold: true,
      color: design.tokens.colors.muted,
    }));
    output.push(pptText(slide, String(step?.title || step?.label || ''), {
      left: cardLeft + 14,
      top: cardTop + (compactCard ? 88 : 90),
      width: cardWidth - 28,
      height: compactCard ? 30 : 34,
      fontName: design.tokens.typography.display,
      fontSize: clamp(region.style?.titleSize || 15, 12, 18),
      bold: true,
      color: design.tokens.colors.inverse,
    }));
    const detailTop = cardTop + (compactCard ? 124 : 132);
    const detailBottom = cardTop + cardHeight - (compactCard ? 14 : 58);
    const detailHeight = detailBottom - detailTop;
    if (detailHeight >= 18) {
      output.push(pptText(slide, String(step?.detail || step?.body || ''), {
        left: cardLeft + 14,
        top: detailTop,
        width: cardWidth - 28,
        height: detailHeight,
        fontName: design.tokens.typography.body,
        fontSize: MIN_FONT,
        color: design.tokens.colors.muted,
      }));
    }
    if (!compactCard) {
      output.push(pptText(slide, `CADENCE ${phaseLabel} / ${terminalPhase}`, {
        left: cardLeft + 14,
        top: cardTop + cardHeight - 48,
        width: cardWidth - 28,
        height: 14,
        fontName: design.tokens.typography.data,
        fontSize: MIN_FONT,
        bold: true,
        color: active ? fill : design.tokens.colors.accent2,
      }));
      output.push(pptShape(slide, 'rectangle', {
        left: cardLeft + 14,
        top: cardTop + cardHeight - 22,
        width: cardWidth - 28,
        height: 4,
        fillColor: design.tokens.colors.surface2,
        lineColor: design.tokens.colors.surface2,
      }));
      output.push(pptShape(slide, 'rectangle', {
        left: cardLeft + 14,
        top: cardTop + cardHeight - 22,
        width: (cardWidth - 28) * cadenceRatio,
        height: 4,
        fillColor: active ? fill : design.tokens.colors.accent2,
        lineColor: active ? fill : design.tokens.colors.accent2,
      }));
    }
  });
  return output;
}

function renderScorecard(region, operation, design, slide) {
  const metrics = Array.isArray(operation.metrics) ? operation.metrics.slice(0, 5) : [];
  if (!metrics.length) throw new Error('scorecard requires operation.metrics');
  const output = [...frame({ ...region, slide }, design)];
  const gap = 14;
  const variant = String(region.style?.variant || 'proof-left');
  const heroWidth = metrics.length === 1
    ? region.width
    : region.width * (variant === 'proof-band' ? 0.56 : 0.46);
  const heroRight = variant === 'proof-right';
  const heroLeft = heroRight ? region.left + region.width - heroWidth : region.left;
  const hero = metrics[0];
  output.push(pptShape(slide, 'rectangle', {
    left: heroLeft,
    top: region.top,
    width: heroWidth,
    height: region.height,
    fillColor: design.tokens.colors.inverse,
    lineColor: design.tokens.colors.inverse,
  }));
  output.push(pptText(slide, 'PRIMARY PROOF', {
    left: heroLeft + 22,
    top: region.top + 22,
    width: heroWidth - 90,
    height: 18,
    fontName: design.tokens.typography.data,
    fontSize: MIN_FONT,
    bold: true,
    color: design.tokens.colors.accent,
  }));
  output.push(pptText(slide, '01', {
    left: heroLeft + heroWidth - 56,
    top: region.top + 21,
    width: 34,
    height: 18,
    fontName: design.tokens.typography.data,
    fontSize: MIN_FONT,
    bold: true,
    color: design.tokens.colors.onInverse,
    alignment: 'right',
  }));
  output.push(pptText(slide, String(hero?.label || '').toUpperCase(), {
    left: heroLeft + 22,
    top: region.top + 58,
    width: heroWidth - 44,
    height: 20,
    fontName: design.tokens.typography.body,
    fontSize: 13,
    bold: true,
    color: design.tokens.colors.surface2,
  }));
  output.push(pptText(slide, metricDisplayValue(hero), {
    left: heroLeft + 22,
    top: region.top + (region.height * 0.33),
    width: heroWidth - 44,
    height: region.height * 0.3,
    fontName: design.tokens.typography.data,
    fontSize: clamp(region.height * 0.17, 32, 60),
    bold: true,
    color: design.tokens.colors.onInverse,
  }));
  output.push(pptText(slide, supportingDetail(hero), {
    left: heroLeft + 22,
    top: region.top + (region.height * 0.72),
    width: heroWidth - 44,
    height: region.height * 0.18,
    fontName: design.tokens.typography.body,
    fontSize: MIN_FONT,
    color: design.tokens.colors.surface2,
  }));
  const supporting = metrics.slice(1);
  if (!supporting.length) return output;
  const columns = supporting.length >= 3 ? 2 : 1;
  const rows = Math.ceil(supporting.length / columns);
  const supportLeft = heroRight ? region.left : region.left + heroWidth + gap;
  const supportWidth = region.width - heroWidth - gap;
  const cellWidth = (supportWidth - (gap * (columns - 1))) / columns;
  const cellHeight = (region.height - (gap * (rows - 1))) / rows;
  supporting.forEach((metric, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = supportLeft + (column * (cellWidth + gap));
    const top = region.top + (row * (cellHeight + gap));
    output.push(pptShape(slide, 'rectangle', {
      left,
      top,
      width: cellWidth,
      height: cellHeight,
      fillColor: index % 2 === 0 ? design.tokens.colors.surface : design.tokens.colors.surface2,
      lineColor: design.tokens.colors.surface2,
    }));
    const proofColor = index === 0 ? design.tokens.colors.accent : design.tokens.colors.accent2;
    const detail = supportingDetail(metric);
    output.push(pptText(slide, `SUPPORTING PROOF ${String(index + 2).padStart(2, '0')}`, {
      left: left + 16,
      top: top + 14,
      width: cellWidth - 82,
      height: 18,
      fontName: design.tokens.typography.body,
      fontSize: MIN_FONT,
      bold: true,
      color: proofColor,
    }));
    output.push(pptText(slide, String(index + 2).padStart(2, '0'), {
      left: left + cellWidth - 54,
      top: top + 12,
      width: 36,
      height: 22,
      fontName: design.tokens.typography.data,
      fontSize: 15,
      bold: true,
      color: proofColor,
      alignment: 'right',
    }));
    output.push(pptText(slide, String(metric?.label || ''), {
      left: left + 16,
      top: top + 48,
      width: cellWidth - 32,
      height: 20,
      fontName: design.tokens.typography.body,
      fontSize: 13,
      bold: true,
      color: design.tokens.colors.ink,
    }));
    output.push(pptText(slide, metricDisplayValue(metric), {
      left: left + 16,
      top: top + 78,
      width: detail ? cellWidth - 132 : cellWidth - 32,
      height: 48,
      fontName: design.tokens.typography.data,
      fontSize: clamp(cellHeight * 0.24, 24, 38),
      bold: true,
      color: design.tokens.colors.ink,
    }));
    if (detail) output.push(pptText(slide, detail, {
      left: left + cellWidth - 104,
      top: top + 92,
      width: 86,
      height: 18,
      fontName: design.tokens.typography.body,
      fontSize: MIN_FONT,
      color: design.tokens.colors.muted,
      alignment: 'right',
    }));
  });
  return output;
}

export const PPTX_SEMANTIC_ROLES = new Set([
  'annotated-chart',
  'allocation',
  'timeline',
  'scorecard',
]);

export function renderPptxSemanticRegion(region, operation, design, slide) {
  if (region.role === 'annotated-chart') return renderAnnotatedChart(region, operation, design, slide);
  if (region.role === 'allocation') return renderAllocation(region, operation, design, slide);
  if (region.role === 'timeline') return renderTimeline(region, operation, design, slide);
  if (region.role === 'scorecard') return renderScorecard(region, operation, design, slide);
  return [];
}
