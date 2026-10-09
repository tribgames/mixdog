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

function writeSectionList(w, section, sectionKind, blockFollows = false) {
  const { append, colors, type, bodySize, spacing } = w;
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
  // A table or callout takes no space above itself, so the list's last item leaves the paragraph gap: at the items'
  // own 3 pt the table's header sat on the last bullet.
  // A short list keeps together and a long one keeps its first two and last two items together, as the PDF writer
  // breaks a list: a three-item list left its first bullet alone at the foot of a page.
  const count = sectionBullets.length;
  sectionBullets.forEach((bullet, index) => {
    const last = index === count - 1;
    append(bullet, 'Normal', {
      name: type.body,
      size: bodySize,
      color: colors.ink,
      spacingBefore: 0,
      spacingAfter: last && blockFollows ? spacing(8, 4, 6) : 3,
      lineSpacing: bodySize * 1.35,
      listKind: 'bullet',
      listLevel: 0,
      keepWithNext: count <= 6 ? !last : index === 0 || index === count - 2,
    });
  });
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
  'quoteBy',
  'table',
  'source',
  'callout',
  'calloutLabel',
  'calloutTone',
]);

// The section's source, in the muted caption a table carries in the native anatomy: every number needs one, and the
// preset had nowhere to say it, so a report written through it lost the table's 자료 line.
function writeSectionSource(w, section) {
  if (!section.source) return;
  const { append, colors, type, bodySize, spacing } = w;
  append(String(section.source), 'Normal', {
    name: type.body,
    size: Math.max(8.5, bodySize - 1.5),
    color: colors.muted,
    spacingBefore: 4,
    spacingAfter: spacing(12, 8, 10),
  });
}

export function writeDocxSection(w, section, sectionIndex) {
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
  const sectionTable = composeTableRows(section.table, {
    field: `compose_document sections[${sectionIndex + 1}].table`,
  });
  writeSectionList(w, section, sectionKind, !section.quote && (sectionTable.length > 0 || Boolean(section.callout)));
  if (section.quote) {
    append(section.quote, 'Quote', {
      name: type.display,
      size: bodySize + (editorialReport ? 2 : 1),
      // Hangul, kana, and Han have no italic, only a synthetic slant; a CJK quote is set apart by the accent alone.
      italic: !/[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u9FFF\uAC00-\uD7AF]/.test(String(section.quote)),
      color: colors.accent,
      spacingBefore: 5,
      spacingAfter: section.quoteBy ? 3 : 9,
      lineSpacing: (bodySize + 1) * 1.35,
      // The inset is the composer's, not the Quote style's: a Korean Word's own Quote has none, so the same quote sat
      // flush with the body in Word and 36 pt in from both edges in the portable file.
      indentLeft: 36,
      indentRight: 36,
      keepWithNext: Boolean(section.quoteBy),
    });
    // Who said it, under the quote in the caption's muted type: a quote had no speaker in the preset.
    if (section.quoteBy) {
      append(`— ${String(section.quoteBy).replace(/^[\s—–-]+/, '')}`, 'Normal', {
        name: type.body,
        size: Math.max(8.5, bodySize - 1.5),
        color: colors.muted,
        spacingBefore: 0,
        spacingAfter: 9,
        indentLeft: 36,
      });
    }
  }
  if (sectionTable.length) {
    addDocxSectionTable(w.output, w.state, sectionTable, w.design, sectionKind, {
      style: String(section.tableStyle || w.tableStyle || ''),
    });
    if (section.source) {
      // The table keeps with its source line, as a native table keeps with its caption.
      const table = [...w.output].reverse().find((entry) => entry.op === 'add_table');
      if (table) table.properties = { ...table.properties, keepWithNext: true };
      writeSectionSource(w, section);
    } else if (section.callout) {
      // A callout is a box of its own. Straight under the table, the table's 2 pt spacer set the box on its last
      // rule as one slab; the spacer leaves the gap a callout keeps below itself.
      const spacer = [...w.output].reverse().find((entry) => entry.op === 'append_text' && entry.text === '\u00A0');
      if (spacer) spacer.properties = { ...spacer.properties, spacingAfter: 10 };
    }
  }
  if (section.callout) {
    addDocxDecisionCallout(w.output, w.state, String(section.callout), w.design, {
      label: section.calloutLabel ? String(section.calloutLabel) : null,
      emphasis: STATE_ROLES.includes(String(section.calloutTone || '')) ? String(section.calloutTone) : 'accent',
      eastAsia: w.type.eastAsiaFor(w.type.display),
    });
  }
  // A section without a table ends on its source.
  if (!sectionTable.length) writeSectionSource(w, section);
}
