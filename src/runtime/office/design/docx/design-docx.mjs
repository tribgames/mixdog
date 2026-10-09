// compose_document → docx operations: front matter, one block per section,
// then page numbers or the footer (see design-docx/*.mjs).
import { createDocxWriter } from './design-docx/writer.mjs';
import { writeDocxFrontMatter } from './design-docx/front-matter.mjs';
import { writeDocxSection } from './design-docx/section.mjs';
import { pairTableEastAsia } from './document-typography.mjs';

function writeDocxFooter(output, operation) {
  if (operation.pageNumbers === true) {
    output.push({
      op: 'add_page_numbers',
      includeTotal: true,
      alignment: 'center',
      prefix: operation.footer ? `${String(operation.footer)} · ` : '',
      separator: ' / ',
    });
  } else if (operation.footer) {
    output.push({ op: 'set_header_footer', header: false, text: String(operation.footer) });
  }
}

export function expandDocxDocument(operation, sourceDesign, state, composition) {
  // The design's Latin faces are written as given; Korean text takes a face of the Latin face's class beside it
  // (nameEastAsia on runs, fontNameEastAsia on tables) only where no East Asian face was named.
  const writer = createDocxWriter({ operation, design: sourceDesign, state, composition });
  writeDocxFrontMatter(writer, operation);
  const sections = Array.isArray(operation.sections) ? operation.sections : [];
  for (const [sectionIndex, section] of sections.entries()) {
    writeDocxSection(writer, section, sectionIndex);
  }
  writeDocxFooter(writer.output, operation);
  return pairTableEastAsia(writer.output, writer.type);
}
