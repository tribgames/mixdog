// A Word document or workbook held to its brief, as an authored deck is: every figure its words show has a fact with
// a source, and a fact cites where a reader can open it. The brief is the deck's (`design.brief`, key: value lines);
// the readings are the deck's own (pptx-brief.mjs), over the document's text instead of its slides.
import {
  parseAuthoringBrief,
  reviewFactCoverage,
  reviewSourceGrounding,
} from '../authoring/pptx-brief.mjs';
import { htmlBriefScript } from '../authoring/pptx-html-runner.mjs';

/** The brief a docx/xlsx call names in design.brief (the HTML BRIEF's key: value lines), or null. */
export function documentBrief(text) {
  const source = String(text ?? '').trim();
  if (!source) return null;
  const brief = parseAuthoringBrief(htmlBriefScript(`<!-- BRIEF\n${source}\n-->`));
  return brief.present ? brief : null;
}

// The document read as the deck reader reads slides: one entry per page-like unit, its text as shapes. A Word body
// is one unit (paragraphs and table cells); a workbook is one per sheet, and only its words — a cell holding a number
// is the data a chart or table shows, not a figure quoted in prose, and the facts line cites where those came from.
function textUnits(format, document) {
  if (format === 'docx') {
    const paragraphs = (document?.paragraphs || []).map((paragraph) => ({ text: paragraph.text }));
    const cells = (document?.tables || []).flatMap((table) =>
      (table.rows || []).flatMap((row) => (row.cells || []).map((cell) => ({ text: cell?.text })))
    );
    return [{ index: 1, path: '/body', shapes: [...paragraphs, ...cells] }];
  }
  return (document?.sheets || []).map((sheet, index) => ({
    index: index + 1,
    path: `/sheet[${sheet.name}]`,
    shapes: (sheet.cells || []).filter((cell) => typeof cell.value === 'string').map((cell) => ({ text: cell.value })),
  }));
}

/** The brief's readings on a Word document or workbook: unfounded figures, a missing facts line, loose sources. */
export function documentBriefIssues(format, document, brief) {
  if (!brief?.present) return [];
  // PDF figures are reviewed from the rendered page text by the PDF pipeline.
  if (!['docx', 'xlsx'].includes(format)) return [];
  const units = textUnits(format, document);
  const paths = new Map(units.map((unit) => [`/slide[${unit.index}]`, unit.path]));
  return [
    ...reviewFactCoverage({ slides: units }, brief).map((entry) =>
      paths.has(entry.path) ? { ...entry, path: paths.get(entry.path) } : entry
    ),
    ...reviewSourceGrounding(brief),
  ];
}
