// Page setup and the document's opening block: eyebrow, title, subtitle, meta
// line, the summary (as a decision callout for brief compositions) and the
// metric strip.
import { strings } from '../../design-tokens.mjs';
import { addDocxDecisionCallout, addDocxMetricStrip } from '../design-docx-components.mjs';

export function writeDocxFrontMatter(w, operation) {
  const { append, colors, type, format, bodySize, compactMemo, spacing } = w;
  if (operation.page !== false) {
    w.output.push({
      op: 'set_page',
      properties: {
        orientation: operation.orientation || 'portrait',
        topMargin: w.pageMargin,
        bottomMargin: w.pageMargin,
        leftMargin: w.pageMargin,
        rightMargin: w.pageMargin,
      },
    });
  }
  if (operation.eyebrow) {
    append(operation.eyebrow, 'Normal', {
      name: type.data,
      size: 8.5,
      bold: true,
      color: colors.accent,
      spacingBefore: 0,
      spacingAfter: 6,
      keepWithNext: true,
    });
  }
  append(operation.title, 'Title', {
    name: type.display,
    size: Number(operation.titleSize) || Math.min(24, format.title),
    bold: true,
    color: colors.ink,
    spacingBefore: 0,
    spacingAfter: spacing(12, 5, 8),
    keepWithNext: true,
  });
  append(operation.subtitle, 'Normal', {
    name: type.body,
    size: bodySize,
    color: colors.muted,
    spacingBefore: 0,
    spacingAfter: compactMemo ? 7 : 12,
    lineSpacing: bodySize * 1.35,
  });
  const meta = strings(operation.meta);
  if (meta.length) {
    append(meta.join(' · '), 'Normal', {
      name: type.body,
      size: Math.max(8.5, bodySize - 1),
      color: colors.muted,
      spacingBefore: 0,
      spacingAfter: compactMemo ? 8 : 14,
    });
  }
  if (operation.summary) {
    if (operation.summaryLabel && (w.decisionBrief || w.evidenceBrief)) {
      addDocxDecisionCallout(w.output, w.state, strings(operation.summary).join(' '), w.design, {
        label: String(operation.summaryLabel),
        emphasis: w.decisionBrief ? 'inverse' : 'accent',
      });
    } else {
      append(strings(operation.summary).join(' '), 'Normal', {
        name: type.display,
        size: bodySize + 1,
        bold: true,
        color: colors.ink,
        spacingBefore: compactMemo ? 2 : 4,
        spacingAfter: spacing(18, 9, 14),
        lineSpacing: (bodySize + 1) * 1.35,
        keepWithNext: true,
      });
    }
  }
  if (Array.isArray(operation.metrics) && operation.metrics.length) {
    addDocxMetricStrip(w.output, w.state, operation.metrics, w.design);
  }
}
