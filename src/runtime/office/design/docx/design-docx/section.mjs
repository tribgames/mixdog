// One compose_document section: eyebrow + heading, paragraphs, the roadmap or
// bullet list, quote, table, and callout.
import { strings } from '../../design-tokens.mjs';
import { STATE_ROLES } from '../../design-discipline.mjs';
import { addDocxDecisionCallout, addDocxRoadmap, addDocxSectionTable } from '../design-docx-components.mjs';
import { composeTableRows } from '../../design-table-input.mjs';

function writeSectionHeading(w, section) {
  const { append, colors, type, format, compactMemo, editorialReport } = w;
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
  const subLevel = Number(section.level) === 2;
  let headingSpacingBefore = subLevel ? 9 : 14;
  if (section.eyebrow) headingSpacingBefore = 0;
  else if (compactMemo) headingSpacingBefore = subLevel ? 6 : 10;
  append(section.heading || section.title, subLevel ? 'Heading 2' : 'Heading 1', {
    name: type.display,
    size: subLevel ? format.heading2 : format.heading1,
    bold: true,
    color: section.accent === true ? colors.accent : colors.ink,
    spacingBefore: headingSpacingBefore,
    spacingAfter: editorialReport ? 7 : 5,
    keepWithNext: true,
    pageBreakBefore: spreadBreak && !section.eyebrow,
  });
}

function writeSectionList(w, section, sectionKind) {
  const { append, colors, type, bodySize } = w;
  const sectionBullets = strings(section.bullets);
  // A section that names steps draws them. They used to reach the page only
  // when the section also declared kind:'roadmap', so a plan section landed as
  // a heading with nothing under it - and the audit reported the orphan heading
  // the composer had just written.
  const sectionSteps = Array.isArray(section.steps) ? section.steps : [];
  const stepSource = sectionSteps.length ? sectionSteps : sectionBullets;
  const drewSteps =
    (sectionKind === 'roadmap' || sectionSteps.length) && addDocxRoadmap(w.output, w.state, stepSource, w.design);
  if (sectionSteps.length && !drewSteps) {
    throw new Error(
      `compose_document section "${String(section.heading || '')}" has steps this writer cannot read;` +
        " a step is { title, detail } or a 'Label: text' string."
    );
  }
  // The roadmap carries the section's list.
  if (drewSteps) return;
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

// What a section can carry. A field outside this list used to vanish: a plan written as `roadmap:[…]` reached the
// page as a heading with nothing under it, and the composer reported success.
const SECTION_FIELDS = new Set([
  'heading',
  'title',
  'eyebrow',
  'level',
  'pageBreak',
  'accent',
  'kind',
  'paragraphs',
  'body',
  'bullets',
  'steps',
  'quote',
  'table',
  'callout',
  'calloutLabel',
  'calloutTone',
]);

export function writeDocxSection(w, section, sectionIndex, operation) {
  const unknown = Object.keys(section || {}).filter((field) => !SECTION_FIELDS.has(field));
  if (unknown.length) {
    throw new Error(
      `compose_document sections[${sectionIndex + 1}] has field(s) it cannot draw: ${unknown.join(', ')}. ` +
        `A section takes ${[...SECTION_FIELDS].join(', ')}; a plan is steps:[{ title, detail }].`
    );
  }
  const { append, colors, type, bodySize, compactMemo, editorialReport, spacing } = w;
  const sectionKind = String(section.kind || '')
    .trim()
    .toLowerCase();
  writeSectionHeading(w, section);
  for (const paragraph of strings(section.paragraphs || section.body)) {
    append(paragraph, 'Normal', {
      name: type.body,
      size: bodySize,
      color: colors.ink,
      spacingBefore: 0,
      spacingAfter: spacing(8, 4, 6),
      lineSpacing: bodySize * (compactMemo ? 1.32 : 1.4),
    });
  }
  writeSectionList(w, section, sectionKind);
  if (section.quote) {
    append(section.quote, 'Quote', {
      name: type.display,
      size: bodySize + (editorialReport ? 2 : 1),
      // Hangul, kana, and Han have no italic, only a synthetic slant; a CJK quote is set apart by the accent alone.
      italic: !/[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u9FFF\uAC00-\uD7AF]/.test(String(section.quote)),
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
    addDocxSectionTable(w.output, w.state, sectionTable, w.design, sectionKind);
  }
  if (section.callout) {
    addDocxDecisionCallout(w.output, w.state, String(section.callout), w.design, {
      label: section.calloutLabel ? String(section.calloutLabel) : null,
      emphasis: STATE_ROLES.includes(String(section.calloutTone || '')) ? String(section.calloutTone) : 'accent',
      eastAsia: w.type.eastAsiaFor(w.type.display),
    });
  }
}
