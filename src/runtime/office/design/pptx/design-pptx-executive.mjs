import { metricDisplayValue, strings } from '../design-tokens.mjs';
import {
  balancedPptTitle,
  pptShape,
  pptText,
  pptTitleSize,
} from './design-pptx-primitives.mjs';
import { plainObject } from '../../shared/values.mjs';


function evidenceCard(slide, design, {
  left,
  top,
  width,
  height,
  label,
  value,
  tone = 'neutral',
}) {
  const colors = design.tokens.colors;
  const fillColor = tone === 'positive'
    ? colors.surface
    : tone === 'warning'
      ? 'FFF4E5'
      : colors.canvas;
  const foreground = tone === 'positive'
    ? colors.accent
    : tone === 'warning'
      ? colors.accent2
      : colors.ink;
  return [
    pptShape(slide, 'rounded_rectangle', {
      left,
      top,
      width,
      height,
      fillColor,
      lineColor: fillColor,
    }),
    pptText(slide, String(label || '').toUpperCase(), {
      left: left + 18,
      top: top + 16,
      width: width - 36,
      height: 18,
      fontName: design.tokens.typography.data,
      fontSize: 12,
      bold: true,
      color: colors.muted,
    }),
    pptText(slide, value, {
      left: left + 18,
      top: top + 42,
      width: width - 36,
      height: height - 54,
      fontName: design.tokens.typography.body,
      fontSize: 13,
      bold: tone !== 'neutral',
      color: foreground,
    }),
  ];
}


function executiveCover(operation, design, slide) {
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const title = String(operation.title || '');
  const subtitle = String(operation.subtitle || operation.takeaway || '');
  const meta = strings(operation.meta);
  const period = String(design.content?.period || meta[0] || '');
  const month = /-(\d{2})$/.exec(period)?.[1] || '01';
  return [
    pptText(slide, String(operation.eyebrow || 'EXECUTIVE REVIEW').toUpperCase(), {
      left: 58, top: 58, width: 500, height: 22,
      fontName: type.data, fontSize: 12, bold: true, color: colors.accent2,
    }),
    pptText(slide, balancedPptTitle(title), {
      left: 58, top: 132, width: 620, height: 190,
      fontName: type.display, fontSize: pptTitleSize(title, 46), bold: true, color: colors.onInverse,
    }),
    pptText(slide, subtitle, {
      left: 58, top: 356, width: 610, height: 70,
      fontName: type.body, fontSize: 17, color: colors.surface2,
    }),
    pptShape(slide, 'rounded_rectangle', {
      left: 748, top: 62, width: 154, height: 414,
      fillColor: colors.accent, lineColor: colors.accent,
    }),
    pptText(slide, month, {
      left: 770, top: 124, width: 110, height: 92,
      fontName: type.data, fontSize: 62, bold: true, color: colors.onAccent, alignment: 'center',
    }),
    pptText(slide, 'MONTHLY\nDECISION BRIEF', {
      left: 770, top: 238, width: 110, height: 86,
      fontName: type.body, fontSize: 12, bold: true, color: colors.onAccent, alignment: 'center',
    }),
    pptText(slide, meta.join(' · '), {
      left: 58, top: 478, width: 620, height: 20,
      fontName: type.body, fontSize: 12, color: colors.surface2,
    }),
  ];
}


function executiveStatement(operation, design, slide) {
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const title = String(operation.title || '');
  const subtitle = String(operation.subtitle || operation.takeaway || '');
  const metric = operation.metric || operation.metrics?.[0] || {};
  const value = metricDisplayValue(metric);
  return [
    pptText(slide, String(operation.eyebrow || 'DECISION EVIDENCE').toUpperCase(), {
      left: 58, top: 54, width: 420, height: 20,
      fontName: type.data, fontSize: 12, bold: true, color: colors.accent,
    }),
    pptText(slide, balancedPptTitle(title), {
      left: 58, top: 112, width: 590, height: 188,
      fontName: type.display, fontSize: pptTitleSize(title, 40), bold: true, color: colors.ink,
    }),
    pptText(slide, subtitle, {
      left: 58, top: 354, width: 570, height: 62,
      fontName: type.body, fontSize: 16, color: colors.muted,
    }),
    pptShape(slide, 'rounded_rectangle', {
      left: 704, top: 92, width: 198, height: 350,
      fillColor: colors.surface, lineColor: colors.surface,
    }),
    pptText(slide, 'PRIMARY SIGNAL', {
      left: 728, top: 124, width: 150, height: 20,
      fontName: type.data, fontSize: 12, bold: true, color: colors.muted, alignment: 'center',
    }),
    pptText(slide, value, {
      left: 720, top: 184, width: 166, height: 92,
      fontName: type.data, fontSize: 52, bold: true, color: colors.accent, alignment: 'center',
    }),
    pptText(slide, String(metric.label || ''), {
      left: 730, top: 300, width: 146, height: 54,
      fontName: type.body, fontSize: 13, bold: true, color: colors.ink, alignment: 'center',
    }),
    pptText(slide, String(metric.detail || ''), {
      left: 730, top: 368, width: 146, height: 40,
      fontName: type.body, fontSize: 12, color: colors.muted, alignment: 'center',
    }),
  ];
}


function executiveChart(operation, design, slide) {
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const title = String(operation.title || '');
  const subtitle = String(operation.subtitle || operation.takeaway || '');
  const evidence = strings(operation.bullets || operation.body).slice(0, 3);
  const chart = operation.chart || {};
  const output = [
    pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: pptTitleSize(title, 35), bold: true, color: colors.ink,
    }),
  ];
  if (subtitle) output.push(pptText(slide, subtitle, {
    left: 58, top: 116, width: 842, height: 36,
    fontName: type.body, fontSize: 14, color: colors.muted,
  }));
  evidence.forEach((entry, index) => {
    output.push(...evidenceCard(slide, design, {
      left: 58,
      top: 174 + (index * 92),
      width: 220,
      height: 76,
      label: `Evidence ${String(index + 1).padStart(2, '0')}`,
      value: entry,
      tone: index === 0 ? 'positive' : 'neutral',
    }));
  });
  output.push({
    op: 'add_chart',
    slide,
    chartType: chart.type || chart.chartType || 'column',
    title: chart.title || '',
    categories: Array.isArray(chart.categories) ? chart.categories : [],
    series: Array.isArray(chart.series) ? chart.series.map((entry, index) => ({
      ...entry,
      color: entry?.color || (index === 0 ? colors.accent : index === 1 ? colors.accent2 : colors.muted),
    })) : [],
    left: 318,
    top: 170,
    width: 582,
    height: 286,
  });
  return output;
}


function executiveDecisionCards(operation, design, slide) {
  const values = Array.isArray(operation.table) ? operation.table : operation.table?.values;
  if (!Array.isArray(values) || values.length < 3 || values[0]?.length !== 3) return null;
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const title = String(operation.title || '');
  const subtitle = String(operation.subtitle || operation.takeaway || '');
  const output = [
    pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: pptTitleSize(title, 35), bold: true, color: colors.ink,
    }),
  ];
  if (subtitle) output.push(pptText(slide, subtitle, {
    left: 58, top: 116, width: 842, height: 34,
    fontName: type.body, fontSize: 14, color: colors.muted,
  }));
  values.slice(1, 3).forEach((row, index) => {
    const left = index === 0 ? 58 : 490;
    output.push(pptShape(slide, 'rounded_rectangle', {
      left, top: 174, width: 412, height: 278,
      fillColor: index === 0 ? colors.surface : colors.canvas,
      lineColor: index === 0 ? colors.surface : colors.surface2,
    }));
    output.push(pptText(slide, String(row[0] || ''), {
      left: left + 24, top: 198, width: 364, height: 42,
      fontName: type.display, fontSize: 22, bold: true, color: colors.ink,
    }));
    output.push(pptText(slide, 'RELEASE', {
      left: left + 24, top: 270, width: 110, height: 18,
      fontName: type.data, fontSize: 12, bold: true, color: colors.accent,
    }));
    output.push(pptText(slide, String(row[1] || ''), {
      left: left + 24, top: 298, width: 364, height: 54,
      fontName: type.body, fontSize: 14, bold: true, color: colors.ink,
    }));
    output.push(pptText(slide, 'STOP', {
      left: left + 24, top: 372, width: 110, height: 18,
      fontName: type.data, fontSize: 12, bold: true, color: colors.accent2,
    }));
    output.push(pptText(slide, String(row[2] || ''), {
      left: left + 24, top: 398, width: 364, height: 36,
      fontName: type.body, fontSize: 13, color: colors.muted,
    }));
  });
  return output;
}


function executiveProcess(operation, design, slide) {
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const title = String(operation.title || '');
  const steps = Array.isArray(operation.steps) ? operation.steps.slice(0, 4) : [];
  const safeLeft = 58;
  const safeWidth = 844;
  const gap = 16;
  const cardWidth = (safeWidth - (gap * Math.max(0, steps.length - 1))) / Math.max(1, steps.length);
  const output = [
    pptText(slide, title, {
      left: 58, top: 42, width: 842, height: 76,
      fontName: type.display, fontSize: pptTitleSize(title, 35), bold: true, color: colors.ink,
    }),
  ];
  steps.forEach((step, index) => {
    const left = safeLeft + ((cardWidth + gap) * index);
    const fillColor = index === 0 ? colors.inverse : colors.canvas;
    const foreground = index === 0 ? colors.onInverse : colors.ink;
    output.push(pptShape(slide, 'rounded_rectangle', {
      left, top: 174, width: cardWidth, height: 278,
      fillColor, lineColor: index === 0 ? fillColor : colors.surface2,
    }));
    output.push(pptText(slide, String(index + 1).padStart(2, '0'), {
      left: left + 18, top: 202, width: cardWidth - 36, height: 42,
      fontName: type.data, fontSize: 24, bold: true,
      color: index === 0 ? colors.accent2 : colors.accent,
    }));
    output.push(pptText(slide, String(step.title || step.label || ''), {
      left: left + 18, top: 270, width: cardWidth - 36, height: 58,
      fontName: type.display, fontSize: 18, bold: true, color: foreground,
    }));
    output.push(pptText(slide, String(step.detail || step.body || ''), {
      left: left + 18, top: 354, width: cardWidth - 36, height: 62,
      fontName: type.body, fontSize: 13,
      color: index === 0 ? colors.surface2 : colors.muted,
    }));
  });
  return output;
}


function executiveClosing(operation, design, slide) {
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const title = String(operation.title || '');
  const subtitle = String(operation.subtitle || operation.takeaway || '');
  return [
    pptText(slide, String(operation.eyebrow || 'DECISION REQUIRED').toUpperCase(), {
      left: 58, top: 64, width: 500, height: 22,
      fontName: type.data, fontSize: 12, bold: true, color: colors.accent2,
    }),
    pptText(slide, balancedPptTitle(title), {
      left: 58, top: 142, width: 610, height: 188,
      fontName: type.display, fontSize: pptTitleSize(title, 42), bold: true, color: colors.onInverse,
    }),
    pptText(slide, subtitle, {
      left: 58, top: 366, width: 610, height: 66,
      fontName: type.body, fontSize: 16, color: colors.surface2,
    }),
    pptShape(slide, 'rounded_rectangle', {
      left: 730, top: 112, width: 172, height: 326,
      fillColor: colors.accent, lineColor: colors.accent,
    }),
    pptText(slide, String(operation.visualLabel || 'APPROVAL'), {
      left: 750, top: 154, width: 132, height: 22,
      fontName: type.data, fontSize: 12, bold: true, color: colors.onAccent, alignment: 'center',
    }),
    pptText(slide, String(operation.visualText || ''), {
      left: 746, top: 238, width: 140, height: 88,
      fontName: type.data, fontSize: 42, bold: true, color: colors.onAccent, alignment: 'center',
    }),
    pptText(slide, 'GO / HOLD', {
      left: 750, top: 370, width: 132, height: 20,
      fontName: type.body, fontSize: 12, bold: true, color: colors.onAccent, alignment: 'center',
    }),
  ];
}


export function expandExecutivePptxSlide(operation, design, slide, kind) {
  if (design.profile !== 'executive') return null;
  if (kind === 'cover') return executiveCover(operation, design, slide);
  if (kind === 'statement') return executiveStatement(operation, design, slide);
  if (kind === 'chart' || (kind === 'content' && plainObject(operation.chart))) {
    return executiveChart(operation, design, slide);
  }
  if (kind === 'table') return executiveDecisionCards(operation, design, slide);
  if (kind === 'process') return executiveProcess(operation, design, slide);
  if (kind === 'closing') return executiveClosing(operation, design, slide);
  return null;
}
