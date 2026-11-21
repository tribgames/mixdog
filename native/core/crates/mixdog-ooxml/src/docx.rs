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

    fn section(width: u32, height: u32, left: u32, right: u32) -> String {
        format!(
            "<w:sectPr><w:pgSz w:w=\"{width}\" w:h=\"{height}\"/><w:pgMar w:top=\"1000\" w:right=\"{right}\" w:bottom=\"1000\" w:left=\"{left}\" w:header=\"500\" w:footer=\"500\" w:gutter=\"0\"/></w:sectPr>"
        )
    }

    #[test]
    fn a_note_mark_follows_the_cited_phrase_and_the_note_is_written_to_its_part() {
        let mut zip = document("<w:p><w:r><w:t>Revenue grew 10% last year.</w:t></w:r></w:p>");
        let results = batch(&mut zip, &[json!({ "op": "add_note", "text": "Source: annual report", "find": "10%" })]).expect("the note is added");
        assert_eq!(results, vec![json!({ "op": "add_note", "changed": true, "kind": "footnote", "note": 1, "anchor": "phrase" })]);
        let text = zip.text(DOCUMENT_PART);
        let phrase = text.find("10%").expect("the phrase stays");
        let mark = text.find("<w:footnoteReference w:id=\"1\"/>").expect("the mark is written");
        let rest = text.find(" last year.").expect("the rest of the sentence stays");
        assert!(phrase < mark && mark < rest, "{text}");
        let notes = zip.text("word/footnotes.xml");
        assert!(notes.contains("<w:footnote w:id=\"1\">") && notes.contains("> Source: annual report</w:t>"), "{notes}");
    }

    #[test]
    fn a_note_on_a_missing_paragraph_names_what_was_asked() {
        let mut zip = document("<w:p><w:r><w:t>one</w:t></w:r></w:p>");
        let error = batch(&mut zip, &[json!({ "op": "add_note", "text": "n", "paragraph": 4 })]).expect_err("no fourth paragraph");
        assert_eq!(error, "DOCX paragraph 4 not found");
        let error = batch(&mut zip, &[json!({ "op": "add_note", "text": "n", "find": "absent" })]).expect_err("no such text");
        assert_eq!(error, "DOCX text not found for note anchor: absent");
    }

    #[test]
    fn the_document_font_reaches_the_defaults_and_a_normal_style_that_names_its_own() {
        let mut zip = document("<w:p/>");
        zip.set(
            "word/styles.xml",
            format!(
                "<w:styles xmlns:w=\"{WORD}\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\"/><w:sz w:val=\"22\"/></w:rPr></w:rPrDefault></w:docDefaults>\
<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"a\"><w:name w:val=\"Normal\"/><w:rPr><w:rFonts w:ascii=\"Calibri\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Other\"><w:name w:val=\"Other\"/><w:rPr><w:rFonts w:ascii=\"Calibri\"/></w:rPr></w:style></w:styles>"
            ),
        );
        let results = batch(&mut zip, &[json!({ "op": "set_document_font", "properties": { "name": "Malgun Gothic", "size": 10 } })]).expect("the font is set");
        assert_eq!(results, vec![json!({ "op": "set_document_font", "changed": true, "name": "Malgun Gothic", "nameEastAsia": "", "size": 10, "color": "" })]);
        let styles = zip.text("word/styles.xml");
        let (defaults, rest) = styles.split_once("</w:docDefaults>").expect("the defaults stay");
        assert!(defaults.contains("w:ascii=\"Malgun Gothic\"") && defaults.contains("<w:sz w:val=\"20\"/>"), "{defaults}");
        let (normal, other) = rest.split_once("w:styleId=\"Other\"").expect("the other style stays");
        assert!(normal.contains("w:ascii=\"Malgun Gothic\""), "{normal}");
        assert!(other.contains("w:ascii=\"Calibri\""), "{other}");
    }

    #[test]
    fn a_page_is_turned_and_sized_and_keeps_the_margins_it_was_not_told_to_change() {
        let mut zip = document(&format!("<w:p/>{}", section(11_906, 16_838, 1_000, 1_000)));
        let results = batch(
            &mut zip,
            &[json!({ "op": "set_page", "properties": { "orientation": "landscape", "pageWidth": 612, "pageHeight": 792, "leftMargin": 72, "columns": 2, "columnSpacing": 36 } })],
        )
        .expect("the page is set");
        assert_eq!(results, vec![json!({ "op": "set_page", "changed": true, "orientation": "landscape", "columns": 2 })]);
        let text = zip.text(DOCUMENT_PART);
        assert!(text.contains("<w:pgSz w:w=\"15840\" w:h=\"12240\" w:orient=\"landscape\"/>"), "{text}");
        assert!(text.contains("w:left=\"1440\"") && text.contains("w:right=\"1000\""), "{text}");
        assert!(text.contains("<w:cols w:num=\"2\" w:equalWidth=\"1\" w:space=\"720\"/>"), "{text}");
    }

    #[test]
    fn a_table_is_fitted_to_the_text_column_in_the_shares_its_columns_had() {
        let cell = |width: u32| format!("<w:tc><w:tcPr><w:tcW w:w=\"{width}\" w:type=\"dxa\"/></w:tcPr><w:p/></w:tc>");
        let table = format!(
            "<w:tbl><w:tblPr><w:tblStyle w:val=\"Grid\"/></w:tblPr><w:tblGrid><w:gridCol w:w=\"1000\"/><w:gridCol w:w=\"3000\"/></w:tblGrid><w:tr>{}{}</w:tr></w:tbl>",
            cell(1_000),
            cell(3_000)
        );
        let mut zip = document(&format!("{table}<w:p/>{}", section(12_000, 16_000, 1_000, 1_000)));
        let results = batch(&mut zip, &[json!({ "op": "fit_table", "table": 1 })]).expect("the table is fitted");
        assert_eq!(results, vec![json!({ "op": "fit_table", "changed": true, "table": 1, "width": 10000, "columns": 2 })]);
        let text = zip.text(DOCUMENT_PART);
        assert!(text.contains("<w:tblGrid><w:gridCol w:w=\"2500\"/><w:gridCol w:w=\"7500\"/></w:tblGrid>"), "{text}");
        assert!(text.contains("<w:tblStyle w:val=\"Grid\"/><w:tblW w:w=\"10000\" w:type=\"dxa\"/>"), "{text}");
        assert!(text.contains("<w:tcW w:w=\"2500\" w:type=\"dxa\"/>") && text.contains("<w:tcW w:w=\"7500\" w:type=\"dxa\"/>"), "{text}");
    }

    #[test]
    fn a_cell_takes_its_weight_size_and_alignment_and_a_bad_alignment_is_refused() {
        let table = "<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w=\"1000\"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w=\"1000\" w:type=\"dxa\"/></w:tcPr><w:p><w:r><w:t>total</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
        let mut zip = document(table);
        let cell = |properties: Value| json!({ "op": "set_table_cell_style", "table": 1, "row": 1, "col": 1, "properties": properties });
        let results = batch(&mut zip, &[cell(json!({ "bold": true, "fontSize": 10, "horizontalAlignment": "center" }))]).expect("the cell is styled");
        assert_eq!(results, vec![json!({ "op": "set_table_cell_style", "changed": true, "table": 1, "row": 1, "col": 1 })]);
        let text = zip.text(DOCUMENT_PART);
        assert!(text.contains("<w:b/><w:bCs/>") && text.contains("<w:sz w:val=\"20\"/><w:szCs w:val=\"20\"/>"), "{text}");
        assert!(text.contains("<w:jc w:val=\"center\"/>"), "{text}");
        let error = batch(&mut zip, &[cell(json!({ "horizontalAlignment": "middle" }))]).expect_err("an alignment Word has no word for");
        assert_eq!(error, "set_table_cell_style horizontalAlignment must be left, center, right, or justify, not middle");
    }

    fn tracked_document() -> Package {
        document(
            "<w:p><w:ins w:id=\"1\" w:author=\"Ann\" w:date=\"2024-01-01T00:00:00Z\"><w:r><w:t>new</w:t></w:r></w:ins>\
<w:del w:id=\"2\" w:author=\"Bob\" w:date=\"2024-01-01T00:00:00Z\"><w:r><w:delText>old</w:delText></w:r></w:del></w:p>",
        )
    }

    #[test]
    fn accepting_every_revision_keeps_the_insertion_and_drops_the_deletion() {
        let mut zip = tracked_document();
        let results = batch(&mut zip, &[json!({ "op": "resolve_revisions", "resolution": "accept" })]).expect("the revisions are resolved");
        assert_eq!(results, vec![json!({ "op": "resolve_revisions", "changed": true, "resolution": "accept", "resolved": 2 })]);
        let text = zip.text(DOCUMENT_PART);
        assert!(text.contains("<w:t>new</w:t>") && !text.contains("old") && !text.contains("<w:ins") && !text.contains("<w:del"), "{text}");
    }

    #[test]
    fn rejecting_one_reviewers_revisions_leaves_the_other_reviewers_tracked() {
        let mut zip = tracked_document();
        let results = batch(&mut zip, &[json!({ "op": "resolve_revisions", "resolution": "reject", "author": "Ann" })]).expect("Ann's revision is resolved");
        assert_eq!(results[0]["resolved"], json!(1));
        let text = zip.text(DOCUMENT_PART);
        assert!(!text.contains("new") && text.contains("<w:del w:id=\"2\""), "{text}");
    }

    #[test]
    fn an_author_nobody_wrote_as_is_answered_with_the_authors_present() {
        let mut zip = tracked_document();
        let results = batch(&mut zip, &[json!({ "op": "resolve_revisions", "author": "Zed" })]).expect("nothing to resolve is not a failure");
        assert_eq!(
            results,
            vec![json!({
                "op": "resolve_revisions", "changed": false, "resolution": "accept", "resolved": 0, "author": "Zed",
                "note": "No revision by \"Zed\"; the tracked changes are by \"Ann\", \"Bob\"."
            })]
        );
    }

    #[test]
    fn a_missing_revision_id_stops_the_batch() {
        let mut zip = tracked_document();
        let error = batch(&mut zip, &[json!({ "op": "resolve_revision", "id": "99" })]).expect_err("no such revision");
        assert_eq!(error, "DOCX revision id 99 not found");
    }

    #[test]
    fn rendered_pages_become_the_page_numbers_of_the_contents_entries() {
        use crate::docx_operations::write_docx_toc_pages;
        let heading = |text: &str| format!("<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>");
        let field = "<w:p><w:fldSimple w:instr=\" TOC \\o &quot;1-3&quot; \"><w:r><w:t>stale</w:t></w:r></w:fldSimple></w:p>";
        let mut zip = document(&format!("{field}{}{}{}", heading("Intro"), heading("Method"), section(11_906, 16_838, 1_440, 1_440)));
        let changed =
            write_docx_toc_pages(&mut zip, &["ContentsIntroMethod".to_owned(), "IntroBody".to_owned(), "Method".to_owned()]).expect("the pages are written");
        assert!(changed);
        let text = zip.text(DOCUMENT_PART);
        assert!(
            text.contains("<w:t xml:space=\"preserve\">Intro</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>2</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space=\"preserve\">Method</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>3</w:t></w:r>"),
            "{text}"
        );
        assert!(text.contains("w:leader=\"dot\"") && text.contains("w:pos=\"9026\""), "{text}");
        assert!(!write_docx_toc_pages(&mut zip, &["ContentsIntroMethod".to_owned(), "IntroBody".to_owned(), "Method".to_owned()]).expect("a second write"));
    }
}
