//! `portable/portable-docx.mjs`: the Word batch. The operations of a batch run one after the other on one package; each is handed
//! to the edit its name selects (the body, table, comment and story edits of [`crate::docx_edits`] and the document-level
//! operations of [`crate::docx_operations`]), and what the edit reports is collected. After the batch a table the batch left at
//! the end of the body gets its closing paragraph, and two tables the batch made meet are parted by an empty one.

use mixdog_fsio::ReadProof;
use mixdog_js::value_to_string;
use serde_json::Value;

use crate::docx_edits::{
    DocxContext, add_docx_bookmark, add_docx_comment, add_docx_hyperlink, add_docx_image, add_docx_page_numbers, add_docx_table, append_docx_text,
    delete_docx_comment, edit_docx_table_rows_or_columns, fill_docx_template, insert_docx_break, insert_docx_toc, normalize_docx_story_runs, replace_docx_text,
    reply_or_resolve_docx_comment, set_docx_font, set_docx_header_footer, set_docx_list, set_docx_paragraph_format, set_docx_paragraph_style,
    set_docx_table_cell, set_docx_table_style, set_docx_track_changes,
};
pub use crate::docx_operations::refresh_docx_table_of_contents;
use crate::docx_operations::{
    add_docx_note, define_docx_styles, edit_docx_paragraph, fill_docx_content_control, fit_docx_table, resolve_docx_revisions, set_docx_document_font,
    set_docx_page, style_or_merge_docx_table_cell,
};
use crate::docx_parts::document_tracks_changes;
use crate::snapshot_docx::{close_trailing_table, has_adjacent_tables, separate_adjacent_tables};
use crate::text_metrics::TextMeasurer;
use crate::xml::compiled;
use crate::zipio::Package;

const DOCUMENT_PART: &str = "word/document.xml";

/// Every operation the portable backend applies to a document, by name. An edit receives the package, the operation and the
/// context (the story part list and the current track-changes state) and answers the result row; `None` for a name that is no
/// operation.
fn run<P: ReadProof>(
    proof: &P,
    measurer: &TextMeasurer<'_, P>,
    zip: &mut Package,
    name: &str,
    op: &Value,
    context: &DocxContext<'_>,
) -> Option<Result<Value, String>> {
    Some(match name {
        "fill_template" => fill_docx_template(zip, op, context),
        "replace_text" => replace_docx_text(zip, op, context),
        "append_text" => append_docx_text(zip, op, context),
        "add_table" => add_docx_table(measurer, zip, op),
        "set_paragraph_text" | "set_run_text" | "remove_paragraph" | "move_paragraph" => edit_docx_paragraph(zip, op, context.tracking),
        "set_paragraph_style" => set_docx_paragraph_style(zip, op),
        "set_table_cell" => set_docx_table_cell(zip, op, context),
        "set_table_style" => set_docx_table_style(zip, op),
        "set_table_cell_style" | "merge_table_cells" => style_or_merge_docx_table_cell(zip, op),
        "set_paragraph_format" => set_docx_paragraph_format(zip, op),
        "add_image" => add_docx_image(proof, zip, op),
        "set_page" => set_docx_page(zip, op),
        "set_document_font" => set_docx_document_font(zip, op),
        "define_styles" => define_docx_styles(zip, op),
        "insert_table_row" | "delete_table_row" | "insert_table_column" | "delete_table_column" => edit_docx_table_rows_or_columns(zip, op),
        "set_list" => set_docx_list(zip, op),
        "add_hyperlink" => add_docx_hyperlink(zip, op),
        "set_font" => set_docx_font(zip, op),
        "add_comment" | "add_provenance" => add_docx_comment(zip, op),
        "add_comment_reply" | "set_comment_resolved" => reply_or_resolve_docx_comment(zip, op),
        "delete_comment" => delete_docx_comment(zip, op),
        "resolve_revision" | "resolve_revisions" => resolve_docx_revisions(zip, context.parts, op),
        "fit_table" => fit_docx_table(zip, op),
        "insert_toc" => insert_docx_toc(zip, op),
        "set_content_control" => fill_docx_content_control(zip, op),
        "add_note" => add_docx_note(zip, op),
        "add_bookmark" => add_docx_bookmark(zip, op),
        "set_header_footer" => set_docx_header_footer(zip, op),
        "add_page_numbers" => add_docx_page_numbers(zip, op),
        "insert_break" => insert_docx_break(zip, op),
        "normalize_runs" => Ok(normalize_docx_story_runs(zip, op, context)),
        _ => return None,
    })
}

/// `applyDocx(zip, operations)`: the operations applied to the document in order (`proof` reads the pictures an operation names,
/// `measurer` holds the faces a table that names no widths is measured in), answering what each one reported. The first
/// operation that fails stops the batch with its message; what the operations before it changed stays in the package, as in
/// Node.
pub fn apply_docx<P: ReadProof>(proof: &P, measurer: &TextMeasurer<'_, P>, zip: &mut Package, operations: &[Value]) -> Result<Vec<Value>, String> {
    let story = compiled(r"^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$", "i");
    let parts: Vec<String> = zip.names().into_iter().filter(|name| story.is_match(name)).collect();
    let mut results = Vec::new();
    let mut tracking = document_tracks_changes(zip);
    // Only a table this batch left at the end gets its closing paragraph: a document that already ended in one is the file as it
    // was, and under tracking an untracked paragraph would read as an edit the redline never marked.
    let before = zip.text(DOCUMENT_PART);
    let ended_in_table = close_trailing_table(&before) != before;
    // Tables the file already set side by side read as one table there too; only a meeting this batch made is parted.
    let tables_already_met = has_adjacent_tables(&before);
    for op in operations {
        let name = op.get("op").map_or_else(|| "undefined".to_owned(), value_to_string);
        if op.get("op").and_then(Value::as_str) == Some("track_changes") {
            let (result, enabled) = set_docx_track_changes(zip, op);
            tracking = enabled;
            results.push(result);
            continue;
        }
        let context = DocxContext { parts: &parts, tracking };
        let Some(result) = run(proof, measurer, zip, &name, op, &context) else {
            return Err(format!("Portable DOCX backend does not support operation: {name}"));
        };
        results.push(result?);
    }
    let document = if tracking { String::new() } else { zip.text(DOCUMENT_PART) };
    if !document.is_empty() {
        let mut next = if tables_already_met { document.clone() } else { separate_adjacent_tables(&document) };
        if !ended_in_table {
            next = close_trailing_table(&next);
        }
        if next != document {
            zip.set(DOCUMENT_PART, next);
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use mixdog_fonts::registry::Registry;
    use mixdog_fsio::Unlaned;
    use serde_json::json;

    use super::*;

    const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

    fn batch(zip: &mut Package, operations: &[Value]) -> Result<Vec<Value>, String> {
        let registry = Registry::new();
        let measurer = TextMeasurer::new(&Unlaned, &registry);
        apply_docx(&Unlaned, &measurer, zip, operations)
    }

    fn document(body: &str) -> Package {
        let mut zip = Package::new();
        zip.set(DOCUMENT_PART, format!("<w:document xmlns:w=\"{WORD}\" xmlns:r=\"{REL}\"><w:body>{body}</w:body></w:document>"));
        zip
    }

    #[test]
    fn an_inherited_name_is_not_a_docx_operation() {
        let mut zip = document("<w:p><w:r><w:t>x</w:t></w:r></w:p>");
        for name in ["constructor", "toString", "__proto__", "hasOwnProperty"] {
            let error = batch(&mut zip, &[json!({ "op": name })]).expect_err("an unknown operation");
            assert_eq!(error, format!("Portable DOCX backend does not support operation: {name}"));
        }
    }

    #[test]
    fn deleting_a_comment_removes_a_reference_run_that_carries_attributes() {
        let mut zip = Package::new();
        zip.set("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
        zip.set(
            "word/_rels/document.xml.rels",
            format!("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/comments\" Target=\"comments.xml\"/></Relationships>"),
        );
        zip.set(
            "word/comments.xml",
            format!("<w:comments xmlns:w=\"{WORD}\"><w:comment w:id=\"1\" w:author=\"a\"><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:comment></w:comments>"),
        );
        zip.set(
            DOCUMENT_PART,
            "<w:document xmlns:w=\"x\"><w:body><w:p><w:commentRangeStart w:id=\"1\"/><w:r><w:t>t</w:t></w:r><w:commentRangeEnd w:id=\"1\"/><w:r w:rsidR=\"00AA\"><w:commentReference w:id=\"1\"/></w:r></w:p></w:body></w:document>",
        );
        let results = batch(&mut zip, &[json!({ "op": "delete_comment", "comment": 1 })]).expect("the comment is deleted");
        assert_eq!(results, vec![json!({ "op": "delete_comment", "changed": true, "comment": 1 })]);
        let text = zip.text(DOCUMENT_PART);
        assert!(!text.contains("commentReference") && !text.contains("w:rsidR"), "{text}");
        assert!(!zip.text("word/comments.xml").contains("<w:comment "));
    }

    #[test]
    fn a_table_the_batch_leaves_at_the_end_is_closed_and_two_that_meet_are_parted() {
        let mut zip = document("<w:p><w:r><w:t>x</w:t></w:r></w:p>");
        let table = json!({ "op": "add_table", "values": [["a", "b"]], "properties": { "columnWidths": [100, 100] } });
        let results = batch(&mut zip, &[table.clone(), table]).expect("two tables are added");
        assert_eq!(results.iter().map(|result| result["table"].as_u64()).collect::<Vec<_>>(), vec![Some(1), Some(2)]);
        let text = zip.text(DOCUMENT_PART);
        assert!(text.contains("</w:tbl><w:p/><w:tbl>"), "{text}");
        assert!(text.ends_with("</w:tbl><w:p/></w:body></w:document>"), "{text}");
    }

    #[test]
    fn track_changes_carries_to_the_operations_after_it() {
        let mut zip = document("<w:p><w:r><w:t>old text</w:t></w:r></w:p>");
        let results = batch(&mut zip, &[json!({ "op": "track_changes" }), json!({ "op": "replace_text", "find": "old", "replace": "new", "author": "Eve" })])
            .expect("a tracked batch");
        assert_eq!(results[0], json!({ "op": "track_changes", "changed": true, "enabled": true }));
        assert_eq!(results[1]["tracked"], json!(true));
        assert!(zip.text(DOCUMENT_PART).contains("<w:del "));
        assert!(zip.text("word/settings.xml").contains("<w:trackRevisions/>"));
    }
}
