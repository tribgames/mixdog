import { documentTracksChanges } from './portable-docx-parts.mjs';
import {
  addDocxBookmark,
  addDocxComment,
  addDocxHyperlink,
  addDocxImage,
  addDocxPageNumbers,
  addDocxTable,
  appendDocxText,
  deleteDocxComment,
  editDocxTableRowsOrColumns,
  fillDocxTemplate,
  insertDocxBreak,
  insertDocxToc,
  normalizeDocxStoryRuns,
  replaceDocxText,
  replyOrResolveDocxComment,
  setDocxFont,
  setDocxHeaderFooter,
  setDocxList,
  setDocxParagraphFormat,
  setDocxParagraphStyle,
  setDocxTableCell,
  setDocxTableStyle,
  setDocxTrackChanges,
} from './portable-docx-edits.mjs';
import {
  addDocxNote,
  editDocxParagraph,
  fillDocxContentControl,
  fitDocxTable,
  resolveDocxRevisions,
  setDocxPage,
  styleOrMergeDocxTableCell,
} from './portable-docx-operations.mjs';

export { refreshDocxTableOfContents } from './portable-docx-operations.mjs';

// Every operation the portable backend applies to a document. An edit
// receives (zip, op, context) — context carries the story part list and the
// current track-changes state — and returns the result row.
const DOCUMENT_EDITS = {
  fill_template: fillDocxTemplate,
  replace_text: replaceDocxText,
  append_text: appendDocxText,
  add_table: addDocxTable,
  set_paragraph_text: (zip, op, { tracking }) => editDocxParagraph(zip, op, tracking),
  set_run_text: (zip, op, { tracking }) => editDocxParagraph(zip, op, tracking),
  remove_paragraph: (zip, op, { tracking }) => editDocxParagraph(zip, op, tracking),
  move_paragraph: (zip, op, { tracking }) => editDocxParagraph(zip, op, tracking),
  set_paragraph_style: setDocxParagraphStyle,
  set_table_cell: setDocxTableCell,
  set_table_style: setDocxTableStyle,
  set_table_cell_style: styleOrMergeDocxTableCell,
  merge_table_cells: styleOrMergeDocxTableCell,
  set_paragraph_format: setDocxParagraphFormat,
  add_image: addDocxImage,
  set_page: setDocxPage,
  insert_table_row: editDocxTableRowsOrColumns,
  delete_table_row: editDocxTableRowsOrColumns,
  insert_table_column: editDocxTableRowsOrColumns,
  delete_table_column: editDocxTableRowsOrColumns,
  set_list: setDocxList,
  add_hyperlink: addDocxHyperlink,
  set_font: setDocxFont,
  add_comment: addDocxComment,
  add_provenance: addDocxComment,
  add_comment_reply: replyOrResolveDocxComment,
  set_comment_resolved: replyOrResolveDocxComment,
  delete_comment: deleteDocxComment,
  resolve_revision: (zip, op, { parts }) => resolveDocxRevisions(zip, parts, op),
  resolve_revisions: (zip, op, { parts }) => resolveDocxRevisions(zip, parts, op),
  fit_table: fitDocxTable,
  insert_toc: insertDocxToc,
  set_content_control: fillDocxContentControl,
  add_note: addDocxNote,
  add_bookmark: addDocxBookmark,
  set_header_footer: setDocxHeaderFooter,
  add_page_numbers: addDocxPageNumbers,
  insert_break: insertDocxBreak,
  normalize_runs: normalizeDocxStoryRuns,
};

export async function applyDocx(zip, operations) {
  const parts = Object.keys(zip.files).filter((name) =>
    /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name)
  );
  const results = [];
  let tracking = await documentTracksChanges(zip);
  for (const op of operations) {
    if (op.op === 'track_changes') {
      const changed = await setDocxTrackChanges(zip, op);
      tracking = changed.tracking;
      results.push(changed.result);
      continue;
    }
    const edit = DOCUMENT_EDITS[op.op];
    if (!edit) throw new Error(`Portable DOCX backend does not support operation: ${op.op}`);
    results.push(await edit(zip, op, { parts, tracking }));
  }
  return results;
}
