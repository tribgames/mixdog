//! The structure review of a document snapshot: what it reports for a Word document, a workbook and a deck, in the order
//! and wording a person fixing the document reads.

use mixdog_office_quality::structure::review_office_structure;
use serde_json::{Value, json};

fn codes(issues: &[Value]) -> Vec<&str> {
    issues.iter().map(|issue| issue["code"].as_str().expect("code")).collect()
}

fn only<'a>(issues: &'a [Value], code: &str) -> Vec<&'a Value> {
    issues.iter().filter(|issue| issue["code"] == code).collect()
}

fn docx(paragraphs: Value, tables: Value) -> Vec<Value> {
    review_office_structure(Some("docx"), &json!({ "paragraphs": paragraphs, "tables": tables }), "")
}

fn heading(text: &str, style: &str, size: f64) -> Value {
    json!({ "text": text, "style": style, "font": { "size": size, "bold": true } })
}

fn body(text: &str) -> Value {
    json!({ "text": text, "font": { "size": 11 } })
}

#[test]
fn a_format_with_no_review_and_an_empty_document_report_nothing() {
    assert!(review_office_structure(Some("pdf"), &json!({}), "").is_empty());
    assert!(review_office_structure(Some("docx"), &json!({}), "").is_empty());
    // The format comes from the snapshot when none is named, whatever its case.
    let found = review_office_structure(None, &json!({ "format": "DOCX", "paragraphs": [body("a\nb")] }), "");
    assert_eq!(codes(&found), ["newline_in_text"]);
}

#[test]
fn a_heading_that_skips_a_level_is_reported_at_the_heading() {
    let issues = docx(json!([heading("Intro", "Heading 1", 20.0), { "text": "Deep", "style": "Heading 3", "path": "/p[2]", "font": { "size": 14, "bold": true } }]), json!([]));
    let jump = only(&issues, "heading_hierarchy_jump");
    assert_eq!(jump.len(), 1);
    assert_eq!(jump[0]["message"], "Heading level jumps from 1 to 3.");
    assert_eq!(jump[0]["path"], "/p[2]");
    assert_eq!(jump[0]["severity"], "warning");
    assert_eq!(jump[0]["source"], "format-review");
}

#[test]
fn eight_paragraphs_with_no_heading_are_a_document_with_no_hierarchy() {
    let paragraphs: Vec<Value> = (1..=8).map(|n| body(&format!("Paragraph {n}"))).collect();
    let issues = docx(json!(paragraphs), json!([]));
    assert_eq!(codes(&issues), ["heading_hierarchy_missing"]);
    assert_eq!(issues[0]["message"], "Document has substantial content but no visible title or heading hierarchy.");
    assert_eq!(issues[0]["path"], "/body");
    let seven: Vec<Value> = (1..=7).map(|n| body(&format!("Paragraph {n}"))).collect();
    assert!(docx(json!(seven), json!([])).is_empty());
}

#[test]
fn a_heading_that_looks_like_the_body_is_not_a_visible_hierarchy_and_one_level_keeps_one_size() {
    let plain = json!({ "text": "Overview", "style": "Heading 1", "font": { "size": 11 } });
    let issues = docx(json!([body("one"), body("two"), body("three"), plain]), json!([]));
    let flat = only(&issues, "heading_not_distinct");
    assert_eq!(flat.len(), 1);
    assert_eq!(
        flat[0]["message"],
        "Heading is set at 11 pt against 11 pt body text and differs in no size, weight, colour, letter-spacing, caps, or spacing; the hierarchy is not visible."
    );
    // Level 1 headings: the first may be a lead-in; the rest must agree within 5 %.
    let sized = docx(
        json!([body("x"), heading("A", "Heading 1", 24.0), heading("B", "Heading 1", 20.0), heading("C", "Heading 1", 14.0), heading("D", "Heading 1", 14.0)]),
        json!([]),
    );
    let drift = only(&sized, "heading_style_inconsistent");
    assert_eq!(drift.len(), 1);
    assert_eq!(drift[0]["message"], "Level 1 headings are set at 14 / 20 pt; one level carries one type.");
}

#[test]
fn a_heading_left_alone_at_a_page_end_is_an_orphan() {
    let split = docx(
        json!([
            { "index": 0, "text": "Chapter", "style": "Heading 1", "page": 1, "font": { "size": 20, "bold": true } },
            { "index": 1, "text": "Its text", "page": 2, "font": { "size": 11 } },
        ]),
        json!([]),
    );
    assert_eq!(only(&split, "orphan_heading").len(), 1);
    assert_eq!(only(&split, "orphan_heading")[0]["message"], "Heading is separated from the content it introduces.");
    let together = docx(
        json!([
            { "index": 0, "text": "Chapter", "style": "Heading 1", "page": 1, "font": { "size": 20, "bold": true } },
            { "index": 1, "text": "Its text", "page": 1, "font": { "size": 11 } },
        ]),
        json!([]),
    );
    assert!(only(&together, "orphan_heading").is_empty());
    let last = docx(json!([{ "index": 0, "text": "Closing", "style": "Heading 1", "font": { "size": 20, "bold": true } }]), json!([]));
    assert_eq!(only(&last, "orphan_heading").len(), 1, "nothing follows the heading");
}

#[test]
fn typed_bullets_stray_newlines_and_walls_of_text_are_reported_per_paragraph() {
    let long = "x".repeat(901);
    let issues = docx(json!([body("• typed bullet"), body("one\ntwo"), json!({ "text": "one\ntwo", "softBreaks": 1 }), body(&long)]), json!([]));
    assert_eq!(codes(&issues), ["dense_paragraph", "literal_bullet", "newline_in_text"]);
    assert_eq!(
        only(&issues, "newline_in_text")[0]["message"],
        "Paragraph text carries a newline character, which Word renders as a space; split it into separate paragraphs."
    );
    let display = docx(json!([{ "text": "y".repeat(181), "font": { "size": 18 } }]), json!([]));
    assert_eq!(codes(&display), ["oversized_heading_text"]);
}

#[test]
fn a_short_table_split_over_pages_an_unmarked_total_and_an_oversized_label_are_reported() {
    let cell = |text: &str| json!({ "text": text, "font": { "size": 10 } });
    let table = json!({
        "path": "/table[1]",
        "pageStart": 1,
        "pageEnd": 2,
        "rows": [
            { "cells": [cell("Item"), cell("Amount")] },
            { "cells": [cell("Rent"), cell("100")] },
            { "cells": [cell("Total"), cell("100")] },
        ],
    });
    let issues = docx(json!([]), json!([table]));
    assert_eq!(codes(&issues), ["short_table_split", "total_row_unmarked"]);
    assert_eq!(issues[0]["message"], "A 3-row table is split across pages 1-2.");
    assert_eq!(
        issues[1]["message"],
        "The \"Total\" row is set like the rows it sums; set it apart (add_table properties.totalRow:true, or bold with a rule above)."
    );
    let marked = json!({
        "rows": [
            { "cells": [cell("Item")] },
            { "cells": [cell("Rent")] },
            { "cells": [json!({ "text": "Total", "font": { "size": 10, "bold": true } })] },
        ],
    });
    assert!(docx(json!([]), json!([marked])).is_empty());
    let label = json!({ "rows": [{ "cells": [json!({ "text": "Quarterly revenue", "font": { "size": 20 } }), json!({ "text": "1,200", "font": { "size": 20 } })] }] });
    let oversized = docx(json!([]), json!([label]));
    assert_eq!(codes(&oversized), ["table_label_oversized"], "a figure may be large; its label may not");
    assert!(oversized[0]["message"].as_str().expect("message").starts_with("\"Quarterly revenue\" is set at 20 pt: display size is for figures."));
}

fn cell(reference: &str, value: Value) -> Value {
    json!({ "ref": reference, "value": value })
}

fn bold_cell(reference: &str, value: Value) -> Value {
    json!({ "ref": reference, "value": value, "style": { "bold": true } })
}

fn xlsx(sheet: Value) -> Vec<Value> {
    let mut sheet = sheet;
    sheet["name"] = json!("Data");
    review_office_structure(Some("xlsx"), &json!({ "sheets": [sheet] }), "")
}

#[test]
fn a_data_sheet_with_no_styled_cell_has_no_hierarchy_and_one_styled_cell_is_enough() {
    let plain: Vec<Value> = (1..=8).map(|n| cell(&format!("A{n}"), json!(n))).collect();
    let issues = xlsx(json!({ "cells": plain }));
    assert_eq!(codes(&issues), ["worksheet_hierarchy_missing"]);
    assert_eq!(issues[0]["path"], "/sheet[Data]");
    assert_eq!(issues[0]["message"], "Data sheet has no styled title, header, table, or visual hierarchy.");
    let mut styled: Vec<Value> = (2..=8).map(|n| cell(&format!("A{n}"), json!(n))).collect();
    styled.push(bold_cell("A1", json!("Heading")));
    assert!(only(&xlsx(json!({ "cells": styled })), "worksheet_hierarchy_missing").is_empty());
}

#[test]
fn an_error_value_in_a_cell_is_an_error_at_that_cell() {
    let issues = xlsx(json!({ "cells": [cell("B2", json!("#DIV/0!")), cell("B3", json!("#N/A"))] }));
    assert_eq!(codes(&issues), ["formula_error", "formula_error"]);
    assert_eq!(issues[0]["severity"], "error");
    assert_eq!(issues[0]["path"], "/sheet[Data]/cell[B2]");
    assert_eq!(issues[0]["message"], "Formula evaluates to #DIV/0!.");
}

#[test]
fn a_total_row_must_be_set_apart_and_a_chart_must_not_plot_it() {
    let cells = json!([bold_cell("A1", json!("Item")), cell("A2", json!("Rent")), cell("B2", json!(100)), cell("A3", json!("Total")), cell("B3", json!(100))]);
    let issues = xlsx(json!({ "cells": cells, "charts": [{ "series": [{ "formula": "Data!$B$2:$B$3" }] }] }));
    let unmarked = only(&issues, "total_row_unmarked");
    assert_eq!(unmarked.len(), 1);
    assert_eq!(unmarked[0]["path"], "/sheet[Data]/cell[A3]");
    assert_eq!(
        unmarked[0]["message"],
        "The \"Total\" row is set like the rows it sums; set it bold with a rule above (set_style bold, borders.top)."
    );
    let plotted = only(&issues, "chart_includes_total_row");
    assert_eq!(plotted.len(), 1);
    assert_eq!(plotted[0]["message"], "Chart source includes total or subtotal row 3; separate summary rows from comparison series.");
    assert_eq!(plotted[0]["path"], "/sheet[Data]/chart");
    let marked = json!([cell("A2", json!("Rent")), bold_cell("A3", json!("Total"))]);
    assert!(only(&xlsx(json!({ "cells": marked })), "total_row_unmarked").is_empty());
}

#[test]
fn a_chart_that_stops_a_row_short_of_its_data_is_reported() {
    let cells: Vec<Value> = (2..=6).map(|n| cell(&format!("B{n}"), json!(n * 10))).collect();
    let short = xlsx(json!({ "cells": cells, "charts": [{ "series": [{ "formula": "Data!$B$2:$B$5" }] }] }));
    let found = only(&short, "chart_stops_short_of_data");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["message"], "Chart source stops at row 5 while the columns it reads hold data through row 6; widen the series range.");
    let whole = xlsx(json!({ "cells": cells, "charts": [{ "series": [{ "formula": "Data!$B$2:$B$6" }] }] }));
    assert!(only(&whole, "chart_stops_short_of_data").is_empty());
}

#[test]
fn a_bold_header_over_figures_must_be_aligned_with_them() {
    let cells = json!([bold_cell("B1", json!("Revenue")), cell("B2", json!(10)), cell("B3", json!(20))]);
    let issues = xlsx(json!({ "cells": cells }));
    let found = only(&issues, "header_alignment_mismatch");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["path"], "/sheet[Data]/cell[B1]");
    assert_eq!(
        found[0]["message"],
        "Header \"Revenue\" is set left over a column of figures set right; align it right (set_style horizontalAlignment:'right')."
    );
    let aligned = json!([json!({ "ref": "B1", "value": "Revenue", "style": { "bold": true, "horizontalAlignment": "right" } }), cell("B2", json!(10)), cell("B3", json!(20))]);
    assert!(only(&xlsx(json!({ "cells": aligned })), "header_alignment_mismatch").is_empty());
}

#[test]
fn a_large_sheet_printed_at_an_enlarged_zoom_without_a_one_page_fit_is_reported() {
    let issues = xlsx(json!({ "rows": 50, "columns": 3, "pageSetup": { "zoom": 120 } }));
    assert_eq!(codes(&issues), ["worksheet_print_fit_missing"]);
    assert!(xlsx(json!({ "rows": 50, "pageSetup": { "zoom": 120, "fitToPagesWide": 1 } })).is_empty());
    assert!(xlsx(json!({ "rows": 10, "pageSetup": { "zoom": 120 } })).is_empty());
}

fn text_shape(index: u32, text: &str, left: f64, top: f64, width: f64, height: f64, size: f64) -> Value {
    json!({ "path": format!("/slide[1]/shape[{index}]"), "index": index, "text": text, "left": left, "top": top, "width": width, "height": height, "font": { "size": size } })
}

fn deck(shapes: Vec<Value>) -> Vec<Value> {
    let document = json!({ "slideWidth": 960, "slideHeight": 540, "slides": [{ "path": "/slide[1]", "index": 1, "shapes": shapes }] });
    review_office_structure(Some("pptx"), &document, "")
}

#[test]
fn text_that_hugs_a_slide_edge_or_is_too_small_is_reported() {
    let issues = deck(vec![text_shape(1, "Quarterly results for the board", 4.0, 60.0, 400.0, 40.0, 24.0)]);
    let edge = only(&issues, "edge_margin");
    assert_eq!(edge.len(), 1);
    assert_eq!(edge[0]["path"], "/slide[1]/shape[1]");
    assert!(deck(vec![text_shape(1, "Quarterly results for the board", 60.0, 60.0, 400.0, 40.0, 24.0)]).is_empty());
}

#[test]
fn light_text_on_a_light_slide_is_reported_as_low_contrast() {
    let mut shape = text_shape(1, "Pale words on pale paper", 60.0, 60.0, 400.0, 40.0, 24.0);
    shape["font"]["color"] = json!("F4F4F4");
    let document = json!({ "slideWidth": 960, "slideHeight": 540, "slides": [{ "path": "/slide[1]", "index": 1, "background": { "color": "FFFFFF" }, "shapes": [shape] }] });
    let issues = review_office_structure(Some("pptx"), &document, "");
    let low = only(&issues, "low_contrast");
    assert_eq!(low.len(), 1);
    assert!(low[0]["message"].as_str().expect("message").ends_with("against the slide background; the text is visually indistinguishable from its surface."));
}

#[test]
fn two_text_boxes_laid_over_each_other_are_reported_and_a_hidden_slide_is_not_reviewed() {
    let shapes = vec![
        text_shape(1, "First block of words here", 60.0, 100.0, 400.0, 60.0, 24.0),
        text_shape(2, "Second block of words here", 70.0, 110.0, 400.0, 60.0, 24.0),
    ];
    let issues = deck(shapes.clone());
    assert!(!only(&issues, "shape_overlap").is_empty());
    let hidden = json!({ "slideWidth": 960, "slideHeight": 540, "slides": [{ "path": "/slide[1]", "index": 1, "hidden": true, "shapes": shapes }] });
    assert!(review_office_structure(Some("pptx"), &hidden, "").is_empty());
}

#[test]
fn a_chart_with_no_series_is_an_error_and_a_slide_of_small_boxes_with_no_leader_is_flat() {
    let chart = json!({ "path": "/slide[1]/shape[1]", "index": 1, "chart": { "seriesCount": 0 }, "left": 60, "top": 60, "width": 500, "height": 300 });
    let issues = deck(vec![chart]);
    let empty = only(&issues, "empty_chart");
    assert_eq!(empty.len(), 1);
    assert_eq!(empty[0]["severity"], "error");
    assert_eq!(empty[0]["message"], "Chart has no persisted data series.");
    let flat = deck(vec![
        text_shape(1, "First idea in words", 60.0, 60.0, 250.0, 40.0, 16.0),
        text_shape(2, "Second idea in words", 340.0, 60.0, 250.0, 40.0, 16.0),
        text_shape(3, "Third idea in words", 620.0, 60.0, 250.0, 40.0, 16.0),
    ]);
    assert!(!only(&flat, "slide_hierarchy_flat").is_empty());
}
