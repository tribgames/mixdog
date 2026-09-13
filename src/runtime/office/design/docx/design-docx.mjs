import { presetLabels, strings } from '../design-tokens.mjs';
import { STATE_ROLES } from '../design-discipline.mjs';
import {
  addDocxDecisionCallout,
  addDocxMetricStrip,
  addDocxRoadmap,
  addDocxSectionTable,
} from './design-docx-components.mjs';
import { plainObject } from '../../shared/values.mjs';
import { composeTableRows } from '../design-table-input.mjs';
import { documentTypography } from './document-typography.mjs';


export function expandDocxDocument(operation, design, state, backend, composition) {
  const output = [];
  const colors = design.tokens.colors;
  const type = documentTypography(operation, design.tokens.typography);
  const format = design.format;
  const compositionId = String(composition?.id || 'decision-brief');
  const compactMemo = compositionId === 'compact-memo';
  const editorialReport = compositionId === 'editorial-report';
  const evidenceBrief = compositionId === 'evidence-brief';
  const decisionBrief = compositionId === 'decision-brief';
  const pageMargin = compactMemo
    ? Math.max(46.8, format.margin * 0.84)
    : editorialReport
      ? format.margin * 1.08
      : format.margin;
  const bodySize = compactMemo ? Math.max(9.5, format.body - 0.5) : format.body;
  if (operation.page !== false) {
    output.push({
      op: 'set_page',
      properties: {
        orientation: operation.orientation || 'portrait',
        topMargin: pageMargin,
        bottomMargin: pageMargin,
        leftMargin: pageMargin,
        rightMargin: pageMargin,
      },
    });
  }
  const append = (text, style, properties = {}) => {
    if (text == null || text === '') return 0;
    state.paragraph += 1;
    output.push({
      op: 'append_text',
      text: String(text),
      style,
      properties: {
        alignment: 'left',
        keepWithNext: false,
        widowControl: true,
        ...(type.eastAsia ? { nameEastAsia: type.eastAsia } : {}),
        ...properties,
      },
    });
    return state.paragraph;
  };
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
    spacingAfter: editorialReport ? 12 : compactMemo ? 5 : 8,
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
    if (operation.summaryLabel && (decisionBrief || evidenceBrief)) {
      addDocxDecisionCallout(
        output,
        state,
        strings(operation.summary).join(' '),
        design,
        {
          label: String(operation.summaryLabel),
          emphasis: decisionBrief ? 'inverse' : 'accent',
        },
      );
    } else {
      append(strings(operation.summary).join(' '), 'Normal', {
        name: type.display,
        size: bodySize + 1,
        bold: true,
        color: colors.ink,
        spacingBefore: compactMemo ? 2 : 4,
        spacingAfter: editorialReport ? 18 : compactMemo ? 9 : 14,
        lineSpacing: (bodySize + 1) * 1.35,
        keepWithNext: true,
      });
    }
  }
  if (Array.isArray(operation.metrics) && operation.metrics.length) {
    addDocxMetricStrip(output, state, operation.metrics, design);
  }
  const sections = Array.isArray(operation.sections) ? operation.sections : [];
  for (const [sectionIndex, section] of sections.entries()) {
    const sectionKind = String(section.kind || '').trim().toLowerCase();
    const spreadBreak = section.pageBreak === true;
    if (section.eyebrow) {
      append(String(section.eyebrow), 'Normal', {
        name: type.data,
        size: 8,
        bold: true,
        color: colors.muted,
        spacingBefore: compactMemo ? 5 : 10,
        spacingAfter: 2,
        keepWithNext: true,
        pageBreakBefore: spreadBreak,
      });
    }
    append(section.heading || section.title, Number(section.level) === 2 ? 'Heading 2' : 'Heading 1', {
      name: type.display,
      size: Number(section.level) === 2 ? format.heading2 : format.heading1,
      bold: true,
      color: section.accent === true ? colors.accent : colors.ink,
      spacingBefore: section.eyebrow
        ? 0
        : compactMemo
          ? (Number(section.level) === 2 ? 6 : 10)
          : Number(section.level) === 2 ? 9 : 14,
      spacingAfter: editorialReport ? 7 : 5,
      keepWithNext: true,
      pageBreakBefore: spreadBreak && !section.eyebrow,
    });
    for (const paragraph of strings(section.paragraphs || section.body)) {
      append(paragraph, 'Normal', {
        name: type.body,
        size: bodySize,
        color: colors.ink,
        spacingBefore: 0,
        spacingAfter: compactMemo ? 4 : editorialReport ? 8 : 6,
        lineSpacing: bodySize * (compactMemo ? 1.32 : 1.4),
      });
    }
    const sectionBullets = strings(section.bullets);
    // A section that names steps draws them. They used to reach the page only
    // when the section also declared kind:'roadmap', so a plan section landed as
    // a heading with nothing under it - and the audit reported the orphan heading
    // the composer had just written.
    const sectionSteps = Array.isArray(section.steps) ? section.steps : [];
    const stepSource = sectionSteps.length ? sectionSteps : sectionBullets;
    const drewSteps = (sectionKind === 'roadmap' || sectionSteps.length)
      && addDocxRoadmap(output, state, stepSource, design);
    if (sectionSteps.length && !drewSteps) {
      throw new Error(`compose_document section "${String(section.heading || '')}" has steps this writer cannot read;`
        + " a step is { title, detail } or a 'Label: text' string.");
    }
    if (drewSteps) {
      // The roadmap carries the section's list.
    } else {
      for (const bullet of sectionBullets) {
        append(bullet, 'Normal', {
          name: type.body,
          size: bodySize,
          color: colors.ink,
          spacingBefore: 0,
          spacingAfter: 3,
          lineSpacing: bodySize * 1.35,
          listKind: 'bullet',
          listLevel: 0,
        });
      }
    }
    if (section.quote) {
      append(section.quote, 'Quote', {
        name: type.display,
        size: bodySize + (editorialReport ? 2 : 1),
        italic: true,
        color: colors.accent,
        spacingBefore: 5,
        spacingAfter: 9,
        lineSpacing: (bodySize + 1) * 1.35,
      });
    }
    const sectionTable = composeTableRows(section.table, {
      field: `compose_document sections[${sectionIndex + 1}].table`,
    });
    if (sectionTable.length) {
      addDocxSectionTable(output, state, sectionTable, design, sectionKind);
    }
    if (section.callout) {
      addDocxDecisionCallout(output, state, String(section.callout), design, {
        label: String(section.calloutLabel || presetLabels([section.callout, section.heading, operation.title]).checkpoint),
        emphasis: STATE_ROLES.includes(String(section.calloutTone || '')) ? String(section.calloutTone) : 'accent',
      });
    }
  }
  if (operation.pageNumbers === true) {
    output.push({
      op: 'add_page_numbers',
      includeTotal: true,
      alignment: 'center',
      ...(operation.footer ? { prefix: `${String(operation.footer)} · `, separator: ' / ' } : { prefix: '', separator: ' / ' }),
    });
  } else if (operation.footer) {
    output.push({ op: 'set_header_footer', header: false, text: String(operation.footer) });
  }
  return output;
}
