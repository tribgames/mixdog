// compose_document → docx operations: front matter, one block per section,
// then page numbers or the footer (see design-docx/*.mjs).
import { createDocxWriter } from './design-docx/writer.mjs';
import { writeDocxFrontMatter } from './design-docx/front-matter.mjs';
import { writeDocxSection } from './design-docx/section.mjs';

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

export function expandDocxDocument(operation, design, state, _backend, composition) {
  const writer = createDocxWriter({ operation, design, state, composition });
  writeDocxFrontMatter(writer, operation);
  const sections = Array.isArray(operation.sections) ? operation.sections : [];
  for (const [sectionIndex, section] of sections.entries()) {
    writeDocxSection(writer, section, sectionIndex, operation);
  }
  writeDocxFooter(writer.output, operation);
  return writer.output;
}
