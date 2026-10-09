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
  // The document's own face and size are the body's: set per paragraph alone, a paragraph added later — by
  // append_text or by hand in Word — came out in Calibri 11 pt beside a Malgun Gothic 10.5 pt body.
  const eastAsia = type.eastAsiaFor(type.body);
  w.output.push({
    op: 'set_document_font',
    properties: { name: type.body, ...(eastAsia ? { nameEastAsia: eastAsia } : {}), size: bodySize, color: colors.ink },
  });
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
  // A title that wraps reads as one block at an exact 1.25 × its size: on the face's own line (Malgun Gothic's is
  // nearly twice the size) its two lines stood apart like two paragraphs.
  const titleSize = Number(operation.titleSize) || Math.min(24, format.title);
  append(operation.title, 'Title', {
    name: type.display,
    size: titleSize,
    bold: true,
    color: colors.ink,
    spacingBefore: 0,
    spacingAfter: spacing(12, 5, 8),
    lineSpacing: Math.round(titleSize * 1.25 * 2) / 2,
    lineSpacingRule: 'exact',
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
  // One meta item per line: a joined string invents a separator the author never chose.
  meta.forEach((item, index) => {
    const last = index === meta.length - 1;
    append(item, 'Normal', {
      name: type.body,
      size: Math.max(8.5, bodySize - 1),
      color: colors.muted,
      spacingBefore: 0,
      spacingAfter: last ? (compactMemo ? 8 : 14) : 0,
      keepWithNext: !last,
    });
  });
  if (operation.summary) {
    // A label the author gave is drawn whatever the composition reads the document as: labels are opt-in, and dropped
    // without a word it left a report's "결론" as a plain bold paragraph.
    if (operation.summaryLabel) {
      addDocxDecisionCallout(w.output, w.state, strings(operation.summary).join(' '), w.design, {
        label: String(operation.summaryLabel),
        emphasis: w.decisionBrief ? 'inverse' : 'accent',
        eastAsia: w.type.eastAsiaFor(w.type.display),
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
