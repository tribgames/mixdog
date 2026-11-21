use mixdog_ooxml::portable::image_pixel_size;
use serde_json::json;

use crate::support::{Doc, count, png, word_texts};

fn memo() -> Doc {
    let doc = Doc::new("docx");
    doc.apply(json!([{ "op": "append_text", "text": "Quarterly memo" }, { "op": "append_text", "text": "The brown fox jumps" }]));
    doc
}

fn paragraph_texts(doc: &Doc) -> Vec<String> {
    doc.snapshot()["paragraphs"].as_array().expect("paragraphs").iter().map(|p| p["text"].as_str().unwrap_or("").to_owned()).collect()
}

#[test]
fn a_blank_document_has_the_parts_word_needs_a_title_and_a_clean_validation() {
    let doc = Doc::new("docx");
    for part in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "docProps/core.xml"] {
        assert!(doc.has_part(part), "{part}");
    }
    assert!(doc.part("docProps/core.xml").contains("feature title"));
    doc.assert_valid();
}

#[test]
fn appended_and_replaced_text_reads_back_in_order() {
    let doc = memo();
    let results = doc.apply(json!([{ "op": "replace_text", "find": "Quarterly", "replace": "Annual" }]));
    assert_eq!(results[0]["changed"], json!(true));
    assert_eq!(paragraph_texts(&doc), ["Annual memo", "The brown fox jumps"]);
    doc.assert_valid();
}

#[test]
fn text_is_xml_escaped_in_the_part_and_read_back_as_typed() {
    let doc = Doc::new("docx");
    doc.apply(json!([{ "op": "append_text", "text": "R&D <draft> \"quoted\"" }]));
    assert!(doc.part("word/document.xml").contains("R&amp;D &lt;draft&gt;"));
    assert_eq!(paragraph_texts(&doc), ["R&D <draft> \"quoted\""]);
}

#[test]
fn a_paragraph_is_rewritten_moved_and_removed_by_its_number() {
    let doc = memo();
    doc.apply(json!([{ "op": "append_text", "text": "Third" }]));
    doc.apply(json!([{ "op": "set_paragraph_text", "paragraph": 1, "text": "Rewritten first" }]));
    assert_eq!(paragraph_texts(&doc), ["Rewritten first", "The brown fox jumps", "Third"]);
    doc.apply(json!([{ "op": "move_paragraph", "paragraph": 1, "index": 3 }]));
    assert_eq!(paragraph_texts(&doc), ["The brown fox jumps", "Third", "Rewritten first"]);
    doc.apply(json!([{ "op": "remove_paragraph", "paragraph": 2 }]));
    assert_eq!(paragraph_texts(&doc), ["The brown fox jumps", "Rewritten first"]);
    let error = doc.try_apply(json!([{ "op": "remove_paragraph", "paragraph": 9 }])).expect_err("no such paragraph");
    assert_eq!(error, "DOCX paragraph 9 not found");
    doc.assert_valid();
}

#[test]
fn template_tokens_are_filled_and_the_unfilled_ones_are_reported() {
    let doc = Doc::new("docx");
    doc.apply(json!([{ "op": "append_text", "text": "Hello {{name}}, welcome to {{place}}" }]));
    let results = doc.apply(json!([{ "op": "fill_template", "tokens": { "name": "Ann" } }]));
    assert_eq!(results[0]["filled"], json!({ "name": 1 }));
    assert_eq!(results[0]["unfilledTokens"], json!(["place"]));
    assert_eq!(paragraph_texts(&doc), ["Hello Ann, welcome to {{place}}"]);
}

#[test]
fn a_table_grows_and_shrinks_by_rows_and_columns_and_its_cells_are_set() {
    let doc = Doc::new("docx");
    doc.apply(json!([{ "op": "add_table", "values": [["Name", "Score"], ["Ann", "9"]], "properties": { "columnWidths": [100, 60] } }]));
    let xml = doc.part("word/document.xml");
    assert_eq!((count(&xml, "<w:tbl>"), count(&xml, "<w:tr>") + count(&xml, "<w:tr "), count(&xml, "<w:tc>")), (1, 2, 4));
    assert_eq!(word_texts(&xml), ["Name", "Score", "Ann", "9"]);
    doc.apply(json!([{ "op": "set_table_cell", "table": 1, "row": 2, "col": 2, "text": "10" }]));
    assert_eq!(word_texts(&doc.part("word/document.xml")), ["Name", "Score", "Ann", "10"]);
    doc.apply(json!([{ "op": "insert_table_row", "table": 1 }]));
    let xml = doc.part("word/document.xml");
    assert_eq!(count(&xml, "<w:tr>") + count(&xml, "<w:tr "), 3);
    doc.apply(json!([{ "op": "delete_table_row", "table": 1, "row": 1 }, { "op": "insert_table_column", "table": 1, "column": 1 }]));
    let xml = doc.part("word/document.xml");
    assert_eq!((count(&xml, "<w:tr>") + count(&xml, "<w:tr "), count(&xml, "<w:tc>")), (2, 6));
    doc.apply(json!([{ "op": "delete_table_column", "table": 1, "column": 1 }]));
    assert_eq!(count(&doc.part("word/document.xml"), "<w:tc>"), 4);
    doc.assert_valid();
}

#[test]
fn table_styling_writes_the_elements_word_reads() {
    let doc = Doc::new("docx");
    doc.apply(json!([
        { "op": "add_table", "values": [["a", "b"], ["c", "d"]] },
        { "op": "set_table_style", "table": 1, "properties": { "style": "Table Grid" } },
        { "op": "set_table_cell_style", "table": 1, "row": 1, "col": 1, "properties": { "fillColor": "FFFF00", "bold": true } },
        { "op": "merge_table_cells", "table": 1, "row": 2, "col": 1, "colSpan": 2 }
    ]));
    let xml = doc.part("word/document.xml");
    assert!(xml.contains("<w:tblStyle w:val=\"TableGrid\"/>"), "{xml}");
    assert!(xml.contains("w:fill=\"FFFF00\""));
    assert!(xml.contains("<w:gridSpan w:val=\"2\"/>"));
    doc.assert_valid();
}

#[test]
fn a_tracked_replacement_is_a_deletion_and_an_insertion_by_the_author_and_accepting_settles_it() {
    let doc = memo();
    doc.apply(json!([{ "op": "track_changes" }, { "op": "replace_text", "find": "brown", "replace": "red", "author": "Eve" }]));
    let xml = doc.part("word/document.xml");
    assert!(xml.contains("<w:del ") && xml.contains("<w:ins ") && xml.contains("w:author=\"Eve\""), "{xml}");
    assert!(xml.contains("<w:delText") && xml.contains("brown"));
    assert!(doc.part("word/settings.xml").contains("<w:trackRevisions/>"));
    let revisions = doc.snapshot()["revisions"].as_array().expect("revisions").clone();
    assert_eq!(revisions.len(), 2);
    assert!(revisions.iter().all(|revision| revision["author"] == json!("Eve")));
    let results = doc.apply(json!([{ "op": "resolve_revisions" }]));
    assert_eq!(results[0]["resolution"], json!("accept"));
    let settled = doc.part("word/document.xml");
    assert!(!settled.contains("<w:ins ") && !settled.contains("<w:del "));
    assert_eq!(paragraph_texts(&doc), ["Quarterly memo", "The red fox jumps"]);
    doc.assert_valid();
}

#[test]
fn rejecting_a_tracked_change_restores_the_original_words() {
    let doc = memo();
    doc.apply(json!([{ "op": "track_changes" }, { "op": "replace_text", "find": "brown", "replace": "red", "author": "Eve" }]));
    doc.apply(json!([{ "op": "resolve_revisions", "resolution": "reject" }]));
    assert_eq!(paragraph_texts(&doc), ["Quarterly memo", "The brown fox jumps"]);
    let error = doc.try_apply(json!([{ "op": "resolve_revisions", "resolution": "maybe" }])).expect_err("a bad resolution");
    assert_eq!(error, "resolve_revisions resolution must be accept or reject");
}

#[test]
fn a_comment_anchors_to_the_found_text_is_answered_resolved_and_deleted() {
    let doc = memo();
    doc.apply(json!([{ "op": "add_comment", "find": "brown fox", "text": "Check this", "author": "Rev" }]));
    let xml = doc.part("word/document.xml");
    for marker in ["<w:commentRangeStart", "<w:commentRangeEnd", "<w:commentReference"] {
        assert!(xml.contains(marker), "{marker}");
    }
    assert!(doc.part("word/comments.xml").contains("Check this"));
    assert!(doc.part("[Content_Types].xml").contains("/word/comments.xml"));
    assert!(doc.part("word/_rels/document.xml.rels").contains("comments.xml"));
    let comments = doc.snapshot()["comments"].as_array().expect("comments").clone();
    assert_eq!(
        (comments[0]["text"].clone(), comments[0]["author"].clone(), comments[0]["anchoredText"].clone()),
        (json!("Check this"), json!("Rev"), json!("brown fox"))
    );
    doc.assert_valid();
    doc.apply(json!([{ "op": "add_comment_reply", "comment": 1, "text": "Done" }, { "op": "set_comment_resolved", "comment": 1 }]));
    assert_eq!(doc.snapshot()["comments"].as_array().expect("comments").len(), 2);
    assert!(doc.part("word/commentsExtended.xml").contains("w15:done=\"1\""));
    doc.assert_valid();
    doc.apply(json!([{ "op": "delete_comment", "comment": 2 }, { "op": "delete_comment", "comment": 1 }]));
    assert!(!doc.part("word/document.xml").contains("commentReference"), "{}", doc.part("word/document.xml"));
    let error = doc.try_apply(json!([{ "op": "add_comment", "find": "absent words", "text": "x" }])).expect_err("no anchor");
    assert_eq!(error, "DOCX text not found for comment anchor: absent words");
}

#[test]
fn a_picture_is_embedded_with_its_media_part_relationship_and_content_type() {
    let doc = Doc::new("docx");
    let bytes = png(3, 2);
    let source = doc.dir().join("pic.png");
    std::fs::write(&source, &bytes).expect("a picture");
    assert_eq!(image_pixel_size(&bytes).map(|size| (size.width, size.height)), Some((3, 2)));
    doc.apply(json!([{ "op": "add_image", "path": source.to_string_lossy() }]));
    let xml = doc.part("word/document.xml");
    assert!(xml.contains("<w:drawing") && xml.contains("r:embed=\"rId"), "{xml}");
    let media: Vec<String> = doc.package().names().into_iter().filter(|name| name.starts_with("word/media/") && !name.ends_with('/')).collect();
    assert_eq!(media.len(), 1);
    assert_eq!(doc.package().file(&media[0]).expect("the media part").to_vec(), bytes);
    assert!(doc.part("[Content_Types].xml").contains("Extension=\"png\""));
    assert_eq!(doc.snapshot()["images"].as_array().expect("images").len(), 1);
    doc.assert_valid();
}

#[test]
fn a_hyperlink_is_an_external_relationship() {
    let doc = memo();
    doc.apply(json!([{ "op": "add_hyperlink", "address": "https://example.com/a?b=1&c=2", "find": "brown fox" }]));
    let rels = doc.part("word/_rels/document.xml.rels");
    assert!(rels.contains("TargetMode=\"External\"") && rels.contains("https://example.com/a?b=1&amp;c=2"), "{rels}");
    assert!(doc.part("word/document.xml").contains("<w:hyperlink "));
    doc.assert_valid();
}

#[test]
fn a_bookmark_is_a_named_range() {
    let doc = memo();
    doc.apply(json!([{ "op": "add_bookmark", "name": "intro", "paragraph": 1 }]));
    let xml = doc.part("word/document.xml");
    assert!(xml.contains("<w:bookmarkStart") && xml.contains("w:name=\"intro\""), "{xml}");
    doc.assert_valid();
}

#[test]
fn a_header_page_numbers_and_page_setup_land_in_their_parts() {
    let doc = memo();
    doc.apply(json!([{ "op": "set_header_footer", "text": "Quarterly report" }, { "op": "add_page_numbers" }, { "op": "set_page", "properties": { "orientation": "landscape" } }]));
    assert!(doc.has_part("word/header1.xml"));
    assert!(doc.part("word/header1.xml").contains("Quarterly report"));
    let xml = doc.part("word/document.xml");
    assert!(xml.contains("<w:headerReference") && xml.contains("<w:footerReference"), "{xml}");
    assert!(xml.contains("w:orient=\"landscape\""));
    let footers: String = doc.package().names().into_iter().filter(|name| name.starts_with("word/footer")).map(|name| doc.part(&name)).collect();
    assert!(footers.contains("PAGE"), "{footers}");
    doc.assert_valid();
}

#[test]
fn page_numbers_take_the_prefix_total_and_alignment_asked_for_and_a_second_call_does_not_stack_a_number() {
    let doc = memo();
    let operations = json!([{ "op": "add_page_numbers", "prefix": "Page", "separator": " of ", "alignment": "right" }]);
    doc.apply(operations.clone());
    let results = doc.apply(operations);
    assert_eq!(results[0]["includeTotal"], json!(true));
    let footers: String = doc.package().names().into_iter().filter(|name| name.starts_with("word/footer")).map(|name| doc.part(&name)).collect();
    assert_eq!(count(&footers, "w:instr=\" PAGE \""), 1, "{footers}");
    assert!(footers.contains("w:instr=\" NUMPAGES \"") && footers.contains("<w:jc w:val=\"right\"/>") && footers.contains(">Page </w:t>"), "{footers}");
    doc.assert_valid();
}

#[test]
fn a_tracked_table_cell_edit_deletes_the_old_words_and_inserts_the_new_ones() {
    let doc = Doc::new("docx");
    doc.apply(json!([
        { "op": "add_table", "values": [["Name", "Score"], ["Ann", "9"]] },
        { "op": "track_changes" },
        { "op": "set_table_cell", "table": 1, "row": 2, "col": 2, "text": "10", "author": "Eve" }
    ]));
    let xml = doc.part("word/document.xml");
    assert!(xml.contains("<w:del ") && xml.contains("<w:ins ") && xml.contains("w:author=\"Eve\""), "{xml}");
    assert!(xml.contains("9</w:delText>") && xml.contains("10</w:t>"), "{xml}");
    doc.assert_valid();
}

#[test]
fn a_comment_reply_spans_its_parents_words_and_ends_after_the_parents_reference() {
    let doc = memo();
    doc.apply(json!([{ "op": "add_comment", "find": "brown fox", "text": "Check this" }, { "op": "add_comment_reply", "comment": 1, "text": "Done" }]));
    let xml = doc.part("word/document.xml");
    let at = |marker: &str| xml.find(marker).unwrap_or_else(|| panic!("{marker} in {xml}"));
    let order = [
        at("<w:commentRangeStart w:id=\"1\""),
        at("<w:commentRangeStart w:id=\"2\""),
        at("<w:commentReference w:id=\"1\""),
        at("<w:commentRangeEnd w:id=\"2\""),
        at("<w:commentReference w:id=\"2\""),
    ];
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{xml}");
}

#[test]
fn a_hyperlink_lands_over_a_phrase_at_the_end_of_a_paragraph_or_appended() {
    let doc = memo();
    let results = doc.apply(json!([
        { "op": "add_hyperlink", "address": "https://a.example", "paragraph": 1, "display": "site" },
        { "op": "add_hyperlink", "address": "https://b.example", "display": "last" },
        { "op": "add_hyperlink", "address": "https://c.example", "find": "brown fox" }
    ]));
    let anchors: Vec<_> = results.iter().map(|result| result["anchor"].clone()).collect();
    assert_eq!(anchors, [json!("paragraph"), json!("appended"), json!("phrase")]);
    let xml = doc.part("word/document.xml");
    assert_eq!(count(&xml, "<w:hyperlink "), 3, "{xml}");
    assert!(xml.find("site").expect("the first link") < xml.find("The ").expect("the second paragraph"), "{xml}");
    assert!(xml.find("last").expect("the appended link") > xml.find("jumps").expect("the second paragraph's end"), "{xml}");
}

#[test]
fn styles_lists_breaks_and_notes_are_written_as_the_elements_word_expects() {
    let doc = memo();
    doc.apply(json!([
        { "op": "set_paragraph_style", "paragraph": 1, "style": "Heading 1" },
        { "op": "set_paragraph_format", "paragraph": 2, "properties": { "alignment": "center" } },
        { "op": "set_list", "paragraph": 2 },
        { "op": "insert_break" },
        { "op": "add_note", "text": "Source: annual report", "find": "fox" },
        { "op": "set_font", "find": "memo", "properties": { "bold": true, "color": "#C00000" } }
    ]));
    let xml = doc.part("word/document.xml");
    assert!(xml.contains("<w:pStyle w:val=\"Heading1\"/>"), "{xml}");
    assert!(xml.contains("<w:jc w:val=\"center\"/>") && xml.contains("<w:numPr>") && xml.contains("<w:br w:type=\"page\"/>"));
    assert!(xml.contains("<w:footnoteReference") && xml.contains("w:val=\"C00000\""));
    assert!(doc.part("word/footnotes.xml").contains("Source: annual report"));
    assert!(doc.has_part("word/numbering.xml"));
    doc.assert_valid();
}

#[test]
fn a_table_of_contents_lists_the_headings_when_the_document_is_saved() {
    let doc = Doc::new("docx");
    doc.apply(
        json!([{ "op": "insert_toc" }, { "op": "append_text", "text": "Chapter one" }, { "op": "set_paragraph_style", "paragraph": 2, "style": "Heading 1" }]),
    );
    let xml = doc.part("word/document.xml");
    assert!(xml.contains("TOC "), "{xml}");
    assert!(count(&xml, "Chapter one") >= 2, "the heading is listed under the contents: {xml}");
}

#[test]
fn an_operation_that_is_no_edit_stops_the_batch_and_an_unknown_one_is_named() {
    let doc = memo();
    let error = doc.try_apply(json!([{ "op": "append_text", "text": "lost" }, { "op": "frobnicate" }])).expect_err("unsupported");
    assert_eq!(error, "Portable DOCX backend does not support operation: frobnicate");
    assert_eq!(paragraph_texts(&doc), ["Quarterly memo", "The brown fox jumps"]);
}
