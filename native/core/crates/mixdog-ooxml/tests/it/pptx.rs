use serde_json::json;

use crate::support::{Doc, count, png};

fn deck() -> Doc {
    let doc = Doc::new("pptx");
    doc.apply(json!([{ "op": "add_slide", "layout": "blank" }, { "op": "add_slide", "layout": "blank" }]));
    doc
}

fn slide_ids(doc: &Doc) -> Vec<String> {
    let xml = doc.part("ppt/presentation.xml");
    xml.split("<p:sldId ").skip(1).map(|rest| rest.split("id=\"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("").to_owned()).collect()
}

fn slide_texts(doc: &Doc) -> Vec<Vec<String>> {
    doc.snapshot()["slides"]
        .as_array()
        .expect("slides")
        .iter()
        .map(|slide| slide["text"].as_array().map_or_else(Vec::new, |lines| lines.iter().map(|l| l.as_str().unwrap_or("").to_owned()).collect()))
        .collect()
}

#[test]
fn a_blank_deck_has_a_master_a_layout_a_theme_and_no_slide_and_validates() {
    let doc = Doc::new("pptx");
    for part in ["ppt/presentation.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/theme/theme1.xml"] {
        assert!(doc.has_part(part), "{part}");
    }
    assert!(doc.package().names().iter().any(|name| name.starts_with("ppt/slideLayouts/slideLayout")));
    assert!(slide_ids(&doc).is_empty());
    doc.assert_valid();
}

#[test]
fn slides_are_added_in_order_with_their_part_relationship_and_content_type() {
    let doc = deck();
    assert_eq!(slide_ids(&doc).len(), 2);
    for part in ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"] {
        assert!(doc.has_part(part), "{part}");
        assert!(doc.part("[Content_Types].xml").contains(&format!("/{part}")));
    }
    let rels = doc.part("ppt/_rels/presentation.xml.rels");
    assert_eq!(count(&rels, "slides/slide"), 2);
    doc.assert_valid();
}

#[test]
fn moving_a_slide_reorders_the_slide_list_and_deleting_one_removes_its_part() {
    let doc = deck();
    let before = slide_ids(&doc);
    doc.apply(json!([{ "op": "move_slide", "slide": 1, "index": 2 }]));
    assert_eq!(slide_ids(&doc), [before[1].clone(), before[0].clone()]);
    doc.apply(json!([{ "op": "delete_slide", "slide": 1 }]));
    assert_eq!(slide_ids(&doc), [before[0].clone()]);
    let slides = doc.package().names().into_iter().filter(|name| name.starts_with("ppt/slides/slide")).count();
    assert_eq!(slides, 1, "the deleted slide's part is swept");
    assert!(doc.try_apply(json!([{ "op": "delete_slide", "slide": 9 }])).is_err());
    doc.assert_valid();
}

#[test]
fn a_duplicated_slide_is_a_slide_of_its_own() {
    let doc = deck();
    doc.apply(json!([{ "op": "add_textbox", "slide": 1, "text": "Original" }, { "op": "duplicate_slide", "slide": 1 }]));
    assert_eq!(slide_ids(&doc).len(), 3);
    let texts = slide_texts(&doc);
    assert_eq!(texts.iter().filter(|lines| lines.iter().any(|line| line == "Original")).count(), 2);
    doc.apply(json!([{ "op": "set_text", "slide": 2, "shape": 1, "text": "Changed" }]));
    let texts = slide_texts(&doc);
    assert_eq!(texts.iter().filter(|lines| lines.iter().any(|line| line == "Original")).count(), 1, "{texts:?}");
    doc.assert_valid();
}

#[test]
fn shape_text_is_escaped_in_the_slide_and_read_back_as_typed() {
    let doc = deck();
    doc.apply(json!([{ "op": "add_textbox", "slide": 1, "text": "Plain" }, { "op": "set_text", "slide": 1, "shape": 1, "text": "Revenue & <more>" }]));
    assert!(doc.part("ppt/slides/slide1.xml").contains("Revenue &amp; &lt;more&gt;"));
    assert_eq!(slide_texts(&doc)[0], ["Revenue & <more>"]);
    let error = doc.try_apply(json!([{ "op": "set_text", "slide": 1, "shape": 9, "text": "x" }])).expect_err("no such shape");
    assert_eq!(error, "PPTX shape 9 not found on slide 1");
}

#[test]
fn shapes_are_added_deleted_and_stacked() {
    let doc = deck();
    doc.apply(json!([
        { "op": "add_shape", "slide": 1, "shapeType": "Rounded Rectangle", "text": "Card", "fillColor": "#0A1B2C" },
        { "op": "add_textbox", "slide": 1, "text": "Label" }
    ]));
    let xml = doc.part("ppt/slides/slide1.xml");
    assert!(xml.contains("prst=\"roundRect\"") && xml.contains("0A1B2C"), "{xml}");
    doc.apply(json!([{ "op": "z_order", "slide": 1, "shape": 1, "command": "front" }]));
    let xml = doc.part("ppt/slides/slide1.xml");
    assert!(xml.find("Label").expect("label") < xml.find("Card").expect("card"), "the card is in front: drawn last");
    doc.apply(json!([{ "op": "delete_shape", "slide": 1, "shape": 1 }]));
    assert_eq!(slide_texts(&doc)[0].len(), 1);
    doc.assert_valid();
}

#[test]
fn shapes_can_be_grouped_and_ungrouped_and_aligned() {
    let doc = deck();
    doc.apply(json!([
        { "op": "add_textbox", "slide": 1, "text": "A", "left": 10, "top": 10 },
        { "op": "add_textbox", "slide": 1, "text": "B", "left": 200, "top": 100 },
        { "op": "align_shapes", "slide": 1, "shapes": [1, 2], "align": "left" }
    ]));
    let xml = doc.part("ppt/slides/slide1.xml");
    let offsets: Vec<&str> = xml.split("<a:off x=\"").skip(1).map(|rest| rest.split('"').next().unwrap_or("")).collect();
    assert_eq!(offsets.len(), 3, "the shape tree's own frame and the two boxes");
    assert_eq!(offsets[1], offsets[2], "left edges agree");
    doc.apply(json!([{ "op": "group_shapes", "slide": 1, "shapes": [1, 2] }]));
    assert!(doc.part("ppt/slides/slide1.xml").contains("<p:grpSp>"));
    doc.apply(json!([{ "op": "ungroup_shape", "slide": 1, "shape": 1 }]));
    assert!(!doc.part("ppt/slides/slide1.xml").contains("<p:grpSp>"));
    doc.assert_valid();
}

#[test]
fn notes_visibility_background_and_transition_are_written_to_their_elements() {
    let doc = deck();
    doc.apply(json!([
        { "op": "set_notes", "slide": 1, "text": "Speaker line one\nline two & <more>" },
        { "op": "set_slide_visibility", "slide": 2, "visible": false },
        { "op": "set_slide_background", "slide": 1, "color": "#102030" },
        { "op": "set_transition", "slide": 1, "effect": "fade" }
    ]));
    assert!(doc.has_part("ppt/notesSlides/notesSlide1.xml"));
    assert!(doc.part("ppt/notesSlides/notesSlide1.xml").contains("line two &amp; &lt;more&gt;"));
    let snapshot = doc.snapshot();
    assert_eq!(snapshot["slides"][0]["notes"], json!("Speaker line one\nline two & <more>"));
    assert_eq!((snapshot["slides"][0]["hidden"].clone(), snapshot["slides"][1]["hidden"].clone()), (json!(false), json!(true)));
    assert!(doc.part("ppt/slides/slide2.xml").contains("show=\"0\""));
    let slide = doc.part("ppt/slides/slide1.xml");
    assert!(slide.contains("<p:bg>") && slide.contains("102030") && slide.contains("<p:transition"), "{slide}");
    doc.assert_valid();
}

#[test]
fn a_table_is_a_graphic_frame_whose_cells_can_be_replaced() {
    let doc = deck();
    doc.apply(json!([{ "op": "add_table", "slide": 1, "values": [["Region", "Sales"], ["North", "1,500"]] }]));
    let xml = doc.part("ppt/slides/slide1.xml");
    assert!(xml.contains("<a:tbl>") && count(&xml, "<a:tc>") == 4, "{xml}");
    doc.apply(json!([{ "op": "set_table_data", "slide": 1, "shape": 1, "values": [["Region", "Sales"], ["South", "9"]] }]));
    let xml = doc.part("ppt/slides/slide1.xml");
    assert!(xml.contains("South") && !xml.contains("North"));
    doc.assert_valid();
}

#[test]
fn a_picture_is_embedded_and_replacing_it_leaves_no_unreachable_media() {
    let doc = deck();
    let first = doc.dir().join("a.png");
    let second = doc.dir().join("b.png");
    std::fs::write(&first, png(2, 2)).expect("a picture");
    std::fs::write(&second, png(4, 3)).expect("a picture");
    doc.apply(json!([{ "op": "add_image", "slide": 1, "path": first.to_string_lossy() }]));
    let media = |doc: &Doc| doc.package().names().into_iter().filter(|name| name.starts_with("ppt/media/") && !name.ends_with('/')).collect::<Vec<_>>();
    assert_eq!(media(&doc).len(), 1);
    assert!(doc.part("ppt/slides/slide1.xml").contains("<p:pic>"));
    assert!(doc.part("[Content_Types].xml").contains("Extension=\"png\""));
    doc.apply(json!([{ "op": "replace_image", "slide": 1, "shape": 1, "path": second.to_string_lossy() }]));
    let after = media(&doc);
    assert_eq!(after.len(), 1, "{after:?} {} {}", doc.part("ppt/slides/_rels/slide1.xml.rels"), doc.part("ppt/slides/slide1.xml"));
    assert_eq!(doc.package().file(&after[0]).expect("the media").to_vec(), png(4, 3));
    doc.assert_valid();
}

#[test]
fn a_chart_is_a_part_with_its_workbook_and_its_data_can_be_replaced() {
    let doc = deck();
    doc.apply(json!([{
        "op": "add_chart", "slide": 1, "chartType": "column", "title": "Units",
        "categories": ["Jan", "Feb"], "series": [{ "name": "Alpha", "values": [1, 2] }]
    }]));
    assert!(doc.has_part("ppt/charts/chart1.xml"));
    assert!(doc.package().names().iter().any(|name| name.starts_with("ppt/embeddings/")));
    let chart = doc.part("ppt/charts/chart1.xml");
    assert!(chart.contains("<c:barChart>") && chart.contains("Alpha") && chart.contains("Feb"), "{chart}");
    doc.apply(json!([{ "op": "set_chart_data", "slide": 1, "shape": 1, "categories": ["Mar", "Apr", "May"], "series": [{ "name": "Beta", "values": [4, 5, 6] }] }]));
    let chart = doc.part("ppt/charts/chart1.xml");
    assert!(chart.contains("Beta") && chart.contains("May") && !chart.contains("Alpha"), "{chart}");
    doc.apply(json!([{ "op": "set_chart_axis", "slide": 1, "shape": 1, "axis": "value", "minimum": 0, "maximum": 10 }]));
    assert!(doc.part("ppt/charts/chart1.xml").contains("<c:max val=\"10\"/>"));
    doc.assert_valid();
}

#[test]
fn replacing_text_reaches_every_slide_and_an_unknown_operation_is_named() {
    let doc = deck();
    doc.apply(json!([{ "op": "add_textbox", "slide": 1, "text": "Q3 plan" }, { "op": "add_textbox", "slide": 2, "text": "Q3 risks" }]));
    doc.apply(json!([{ "op": "replace_text", "find": "Q3", "replace": "Q4" }]));
    assert_eq!(slide_texts(&doc), [vec!["Q4 plan".to_owned()], vec!["Q4 risks".to_owned()]]);
    let error = doc.try_apply(json!([{ "op": "frobnicate" }])).expect_err("unsupported");
    assert_eq!(error, "Portable PPTX backend does not support operation: frobnicate");
}
