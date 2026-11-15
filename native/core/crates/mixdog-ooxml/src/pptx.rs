//! `portable/portable-pptx.mjs`: the presentation batch. The operations of a batch run one after the other on one package;
//! each is first resolved from slide and shape ids to positions, then handed to the handler its name selects (the deck, shape
//! and chart modules), and what the handler reports is collected. After a batch that added, deleted, moved, kept, duplicated
//! or imported slides the slide parts are renamed to their positions.

use mixdog_fsio::ReadProof;
use mixdog_js::value_to_string;
use mixdog_office_base::values::truthy;
use serde_json::Value;

use crate::pptx_charts::{
    handle_add_chart, handle_set_chart_axis, handle_set_chart_data, handle_set_chart_data_labels, handle_set_chart_series,
    handle_set_chart_trendline_or_set_chart_error_bars,
};
use crate::pptx_deck::{
    Handled, handle_add_comment_or_delete_comment, handle_add_provenance, handle_add_slide, handle_apply_theme, handle_delete_slide,
    handle_duplicate_slide, handle_fill_template, handle_import_slides, handle_keep_slides, handle_move_slide, handle_replace_text,
    handle_set_footer_or_set_slide_number, handle_set_layout, handle_set_notes, handle_set_slide_background,
    handle_set_slide_visibility, handle_set_transition,
};
use crate::pptx_package::{SlideRef, presentation_slides, renumber_presentation_slides};
use crate::pptx_shapes::{
    add_animation, add_image, add_media, add_table, add_textbox_or_shape, align_shapes_or_distribute_shapes, crop_image, delete_shape,
    fit_text, group_shapes_or_ungroup_shape, set_hyperlink, set_shape, set_table_cell_style, set_table_data_or_replace_image, set_text,
    z_order,
};
use crate::pptx_targets::resolve_pptx_targets;
use crate::text_metrics::TextMeasurer;
use crate::zipio::Package;

/// The operations that change which slide sits at which position; after them the slide parts are renamed to their positions
/// (see `renumber_presentation_slides`).
const STRUCTURAL_OPERATIONS: [&str; 6] = ["add_slide", "delete_slide", "move_slide", "keep_slides", "duplicate_slide", "import_slides"];

fn run<P: ReadProof>(proof: &P, measurer: &TextMeasurer<'_, P>, zip: &mut Package, slides: &mut Vec<SlideRef>, name: &str, op: &Value) -> Option<Handled> {
    Some(match name {
        "add_slide" => handle_add_slide(zip, slides, op),
        "delete_slide" => handle_delete_slide(zip, slides, op),
        "move_slide" => handle_move_slide(zip, slides, op),
        "keep_slides" => handle_keep_slides(zip, slides, op),
        "add_comment" | "delete_comment" => handle_add_comment_or_delete_comment(zip, slides, op),
        "add_provenance" => handle_add_provenance(zip, slides, op),
        "set_hyperlink" => set_hyperlink(zip, slides, op),
        "duplicate_slide" => handle_duplicate_slide(zip, slides, op),
        "z_order" => z_order(zip, slides, op),
        "align_shapes" | "distribute_shapes" => align_shapes_or_distribute_shapes(zip, slides, op),
        "set_notes" => handle_set_notes(zip, slides, op),
        "fill_template" => handle_fill_template(zip, op),
        "replace_text" => handle_replace_text(zip, slides, op),
        "set_text" => set_text(zip, slides, op),
        "add_textbox" | "add_shape" => add_textbox_or_shape(zip, slides, op),
        "delete_shape" => delete_shape(zip, slides, op),
        "import_slides" => handle_import_slides(proof, zip, slides, op),
        "set_slide_background" => handle_set_slide_background(zip, slides, op),
        "add_table" => add_table(zip, slides, op),
        "add_image" => add_image(proof, zip, slides, op),
        "add_chart" => handle_add_chart(zip, slides, op),
        "set_chart_data" => handle_set_chart_data(zip, slides, op),
        "set_chart_axis" => handle_set_chart_axis(zip, slides, op),
        "set_chart_series" => handle_set_chart_series(zip, slides, op),
        "set_chart_trendline" | "set_chart_error_bars" => handle_set_chart_trendline_or_set_chart_error_bars(zip, slides, op),
        "set_chart_data_labels" => handle_set_chart_data_labels(zip, slides, op),
        "fit_text" => fit_text(measurer, zip, slides, op),
        "set_table_data" | "replace_image" => set_table_data_or_replace_image(proof, zip, slides, op),
        "set_table_cell_style" => set_table_cell_style(zip, slides, op),
        "group_shapes" | "ungroup_shape" => group_shapes_or_ungroup_shape(zip, slides, op),
        "set_footer" | "set_slide_number" => handle_set_footer_or_set_slide_number(zip, slides, op),
        "apply_theme" => handle_apply_theme(proof, zip, op),
        "add_media" => add_media(proof, zip, slides, op),
        "set_layout" => handle_set_layout(zip, slides, op),
        "crop_image" => crop_image(zip, slides, op),
        "add_animation" => add_animation(zip, slides, op),
        "set_transition" => handle_set_transition(zip, slides, op),
        "set_slide_visibility" => handle_set_slide_visibility(zip, slides, op),
        "set_shape" => set_shape(zip, slides, op),
        _ => return None,
    })
}

/// `applyPptx(zip, operations)`: the operations applied to the presentation in order (`proof` reads the files an operation
/// names, `measurer` holds the faces that decide how large a text fits), answering what each one reported (an
/// operation that reports nothing adds nothing). The first operation that fails stops the batch with its message; what the
/// operations before it changed stays in the package, as in Node.
pub fn apply_pptx<P: ReadProof>(proof: &P, measurer: &TextMeasurer<'_, P>, zip: &mut Package, operations: &[Value]) -> Result<Vec<Value>, String> {
    let mut slides = presentation_slides(zip);
    let mut results = Vec::new();
    let mut structural = false;
    for operation in operations {
        let op = resolve_pptx_targets(zip, &slides, operation)?;
        let name = op.get("op").map_or_else(|| "undefined".to_owned(), value_to_string);
        let Some(handled) = run(proof, measurer, zip, &mut slides, &name, &op) else {
            return Err(format!("Portable PPTX backend does not support operation: {name}"));
        };
        let result = handled?;
        if truthy(&result) {
            results.push(result);
        }
        if STRUCTURAL_OPERATIONS.contains(&name.as_str()) {
            structural = true;
        }
    }
    if structural {
        renumber_presentation_slides(zip);
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use mixdog_fonts::registry::Registry;
    use mixdog_fsio::Unlaned;
    use mixdog_office_base::write_note::NoWriteNote;
    use serde_json::json;

    use super::*;
    use crate::chart::{ChartSpec, chart_xml};
    use crate::package::{CreateOptions, create_portable_ooxml_document, load_package};
    use crate::xml::compiled;

    fn new_deck() -> Package {
        let dir = tempfile::tempdir().expect("work directory");
        let path = dir.path().join("probe.pptx");
        let options = CreateOptions { file_kind: "pptx", title: "Probe", sheet_name: "" };
        create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &options).expect("a blank deck");
        load_package(&Unlaned, &path).expect("the deck loads")
    }

    fn batch(zip: &mut Package, operations: Vec<Value>) -> Result<Vec<Value>, String> {
        let registry = Registry::new();
        let measurer = TextMeasurer::new(&Unlaned, &registry);
        apply_pptx(&Unlaned, &measurer, zip, &operations)
    }

    fn found(pattern: &str, text: &str) -> bool {
        compiled(pattern, "").is_match(text)
    }

    fn group(pattern: &str, text: &str) -> String {
        compiled(pattern, "").captures(text).and_then(|caps| caps.get(1).map(str::to_owned)).unwrap_or_default()
    }

    /// A deck of one slide with one bar chart of two categories, and the shape id of the chart.
    fn deck_with_chart(extra: Value) -> (Package, Value) {
        let mut zip = new_deck();
        let mut chart = json!({
            "op": "add_chart", "slide": 1, "chartType": "bar", "title": "Retention",
            "categories": ["Self-serve", "Guided"], "series": [{ "name": "Retention", "values": [38, 52] }]
        });
        for (key, value) in extra.as_object().expect("an object") {
            chart[key] = value.clone();
        }
        let results = batch(&mut zip, vec![json!({ "op": "add_slide" }), chart]).expect("the chart is added");
        let shape = results.last().expect("a result")["shapeId"].clone();
        (zip, shape)
    }

    #[test]
    fn an_inherited_name_is_not_a_pptx_operation() {
        let mut zip = new_deck();
        for name in ["constructor", "toString", "__proto__", "hasOwnProperty"] {
            let error = batch(&mut zip, vec![json!({ "op": name })]).expect_err("not an operation");
            assert!(error.starts_with("Portable PPTX backend does not support operation"), "{name}: {error}");
        }
        assert_eq!(batch(&mut zip, vec![json!({})]).expect_err("no operation"), "Portable PPTX backend does not support operation: undefined");
    }

    #[test]
    fn a_batch_reports_what_its_operations_report_and_stops_at_the_first_failure() {
        let mut zip = new_deck();
        let results = batch(&mut zip, vec![json!({ "op": "add_slide" }), json!({ "op": "add_textbox", "slide": 1, "text": "Hello" })]).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[1]["op"], "add_textbox");
        let error =
            batch(&mut zip, vec![json!({ "op": "add_textbox", "slide": 1, "text": "kept" }), json!({ "op": "add_textbox", "slide": 9 })]).unwrap_err();
        assert_eq!(error, "PPTX slide 9 not found");
        assert!(zip.text("ppt/slides/slide1.xml").contains("kept"), "what ran before the failure stays");
    }

    // pptxgenjs writes the chart relationship as an absolute part name ("/ppt/charts/chart1.xml"), where a hand-built deck
    // writes "../charts/chart1.xml".
    #[test]
    fn set_chart_data_edits_a_chart_through_its_absolute_relationship_target_and_a_duplicated_slide_owns_its_copy() {
        let (mut zip, shape) = deck_with_chart(json!({}));
        let relationships = zip.text("ppt/slides/_rels/slide1.xml.rels");
        assert!(relationships.contains("Target=\"../charts/chart1.xml\""));
        zip.set("ppt/slides/_rels/slide1.xml.rels", relationships.replace("../charts/chart1.xml", "/ppt/charts/chart1.xml"));
        batch(&mut zip, vec![json!({ "op": "duplicate_slide", "slide": 1 })]).expect("the slide is duplicated");
        let edited = batch(
            &mut zip,
            vec![json!({
                "op": "set_chart_data", "slide": 2, "shapeId": shape,
                "categories": ["Self-serve", "Guided"], "series": [{ "name": "Retention", "values": [7, 9] }]
            })],
        )
        .expect("the chart is refreshed");
        assert_eq!(edited[0]["chart"], "ppt/charts/chart2.xml");
        assert!(zip.file("ppt/charts/chart2.xml").is_some(), "the copy owns its chart part instead of editing the source page");
        assert!(zip.text("ppt/slides/_rels/slide1.xml.rels").contains("Target=\"/ppt/charts/chart1.xml\""));
        assert!(zip.text("ppt/slides/_rels/slide2.xml.rels").contains("Target=\"/ppt/charts/chart2.xml\""));
        assert!(zip.text("ppt/charts/chart1.xml").contains("<c:v>38</c:v>"), "the page that was not edited keeps its numbers");
        let copy = zip.text("ppt/charts/chart2.xml");
        assert!(copy.contains("<c:v>7</c:v>") && copy.contains("<c:v>9</c:v>"));
        assert!(!copy.contains("<c:v>38</c:v>"));
    }

    // A chart PowerPoint saved cites its workbook as rId3 beside its style and colour parts, and may name its series in plain
    // text: the refresh keeps those relationships and renames the series.
    #[test]
    fn a_data_refresh_keeps_the_charts_own_relationships_and_renames_a_series_written_as_text() {
        let (mut zip, shape) = deck_with_chart(json!({}));
        let rels_path = "ppt/charts/_rels/chart1.xml.rels";
        let relationships = zip.text(rels_path);
        zip.set(
            rels_path,
            relationships.replace("Id=\"rId1\"", "Id=\"rId3\"").replace(
                "</Relationships>",
                "<Relationship Id=\"rId1\" Type=\"http://schemas.microsoft.com/office/2011/relationships/chartStyle\" Target=\"style1.xml\"/></Relationships>",
            ),
        );
        zip.set("ppt/charts/style1.xml", "<cs:chartStyle xmlns:cs=\"http://schemas.microsoft.com/office/drawing/2012/chartStyle\" id=\"201\"/>");
        let chart = zip.text("ppt/charts/chart1.xml");
        let cited = group(r#"(<c:externalData\b[^>]*\br:id=")[^"]*""#, &chart);
        assert!(!cited.is_empty(), "the chart cites its workbook");
        let chart = compiled(r#"(<c:externalData\b[^>]*\br:id=")[^"]*(")"#, "").replace_all_with(&chart, |caps| {
            format!("{}rId3{}", caps.get(1).unwrap_or(""), caps.get(2).unwrap_or(""))
        });
        let chart = compiled(r"<c:tx>\s*<c:strRef>[\s\S]*?</c:strRef>\s*</c:tx>", "").replace_all_with(&chart, |_| "<c:tx><c:v>Value</c:v></c:tx>".to_owned());
        assert!(chart.contains("<c:tx><c:v>Value</c:v></c:tx>"));
        zip.set("ppt/charts/chart1.xml", chart);
        batch(
            &mut zip,
            vec![json!({
                "op": "set_chart_data", "slide": 1, "shapeId": shape,
                "categories": ["Self-serve", "Guided"], "series": [{ "name": "유지율", "values": [41, 55] }]
            })],
        )
        .expect("the chart is refreshed");
        let saved = zip.text(rels_path);
        assert!(found(r#"Id="rId3"[^>]*/package""#, &saved), "{saved}");
        assert!(found(r#"Id="rId1"[^>]*chartStyle"[^>]*Target="style1\.xml""#, &saved), "the style part stays related");
        let chart = zip.text("ppt/charts/chart1.xml");
        assert!(chart.contains("<c:externalData r:id=\"rId3\">"));
        assert!(chart.contains("<c:tx><c:v>유지율</c:v></c:tx>"));
        assert!(chart.contains("<c:v>55</c:v>"));
    }

    #[test]
    fn a_column_starts_its_axis_at_zero_unless_the_caller_zooms_in_a_line_keeps_its_range() {
        let categories = [json!("1월"), json!("2월")];
        let series = [json!({ "name": "처리량", "values": [4610, 4720] })];
        let chart = |chart_type: &'static str, zero_baseline: Option<bool>| {
            chart_xml(&ChartSpec { chart_type, categories: &categories, series: &series, zero_baseline, ..ChartSpec::default() }).expect("a chart")
        };
        assert!(chart("column", None).contains("<c:min val=\"0\"/>"));
        assert!(!chart("column", Some(false)).contains("<c:min val=\"0\"/>"));
        assert!(!chart("line", None).contains("<c:min val=\"0\"/>"));
        assert!(chart("line", Some(true)).contains("<c:min val=\"0\"/>"));
    }

    #[test]
    fn new_numbers_keep_the_chart_the_deck_was_approved_with() {
        let mut zip = new_deck();
        let created = batch(
            &mut zip,
            vec![
                json!({ "op": "add_slide" }),
                json!({
                    "op": "add_chart", "slide": 1, "chartType": "column", "title": "분기 처리량",
                    "categories": ["10월", "11월", "12월"], "series": [{ "name": "처리량", "values": [4120, 4480, 4390], "color": "B04A2F" }],
                    "showValues": true, "dataLabelPosition": "outside_end", "valueNumberFormat": "#,##0", "zeroBaseline": true,
                    "left": 60, "top": 110, "width": 700, "height": 330
                }),
            ],
        )
        .unwrap();
        let shape = created[1]["shapeId"].clone();
        let refreshed = batch(
            &mut zip,
            vec![json!({
                "op": "set_chart_data", "slide": 1, "shapeId": shape,
                "categories": ["1월", "2월", "3월"], "series": [{ "name": "처리량", "values": [4610, 4720, 5010] }]
            })],
        )
        .unwrap();
        assert_eq!(refreshed[0]["preserved"], json!(["dataLabels", "numberFormat", "zeroBaseline", "seriesColors"]));
        let chart = zip.text("ppt/charts/chart1.xml");
        for wanted in [
            "<c:v>5010</c:v>",
            "<c:showVal val=\"1\"/>",
            "<c:dLblPos val=\"outEnd\"/>",
            "<c:min val=\"0\"/>",
            "formatCode=\"#,##0\"",
            "<a:srgbClr val=\"B04A2F\"/>",
            "<a:t>분기 처리량</a:t>",
        ] {
            assert!(chart.contains(wanted), "{wanted}");
        }
        // An explicit field still overrides what the chart carried.
        batch(
            &mut zip,
            vec![json!({ "op": "set_chart_data", "slide": 1, "shapeId": shape, "series": [{ "name": "처리량", "values": [4610, 4720, 5010] }], "showValues": false })],
        )
        .unwrap();
        let plain = zip.text("ppt/charts/chart1.xml");
        assert!(!plain.contains("<c:dLbls>"));
        assert!(plain.contains("<a:srgbClr val=\"B04A2F\"/>"));
    }

    // A bar chart authored bottom-up (PowerPoint's default, and what a template usually carries) keeps its order on a refresh
    // and says so; categoryOrder turns the bars to read from the top in the order given, or back.
    #[test]
    fn a_bar_chart_authored_bottom_up_keeps_its_order_says_so_and_turns_over_on_category_order() {
        let months = json!(["6월", "7월", "8월", "9월"]);
        let (mut zip, shape) =
            deck_with_chart(json!({ "categories": months, "series": [{ "name": "오류 (건)", "values": [8200, 5900, 3100, 2700] }] }));
        let chart = zip.text("ppt/charts/chart1.xml");
        let category_axis = group(r"(<c:catAx>[\s\S]*?</c:catAx>)", &chart);
        let value_axis = group(r"(<c:valAx>[\s\S]*?</c:valAx>)", &chart);
        let bottom_up = chart
            .replacen(&category_axis, &category_axis.replace("maxMin", "minMax"), 1)
            .replacen(&value_axis, &value_axis.replace("<c:crosses val=\"max\"/>", "<c:crosses val=\"autoZero\"/>"), 1);
        zip.set("ppt/charts/chart1.xml", bottom_up);
        let axes = |zip: &Package| {
            let chart = zip.text("ppt/charts/chart1.xml");
            (group(r#"<c:catAx>[\s\S]*?<c:orientation val="([^"]+)"/>"#, &chart), group(r#"<c:valAx>[\s\S]*?<c:crosses val="([^"]+)"/>"#, &chart))
        };
        let refresh = |zip: &mut Package, extra: Value| {
            let mut operation = json!({
                "op": "set_chart_data", "slide": 1, "shapeId": shape,
                "categories": months, "series": [{ "name": "오류 (건)", "values": [8200, 5900, 3100, 2700] }]
            });
            for (key, value) in extra.as_object().expect("an object") {
                operation[key] = value.clone();
            }
            batch(zip, vec![operation])
        };
        let kept = refresh(&mut zip, json!({})).unwrap();
        assert_eq!(kept[0]["readingOrder"], "bottomUp", "{}", kept[0]);
        assert!(kept[0]["note"].as_str().unwrap().contains("categoryOrder:'topDown'"));
        assert_eq!(axes(&zip), ("minMax".to_owned(), "autoZero".to_owned()), "the authored order stays");
        let turned = refresh(&mut zip, json!({ "categoryOrder": "topDown" })).unwrap();
        assert!(turned[0].get("readingOrder").is_none());
        assert_eq!(axes(&zip), ("maxMin".to_owned(), "max".to_owned()), "the first category on top, the value axis under the bars");
        assert!(refresh(&mut zip, json!({})).unwrap()[0].get("readingOrder").is_none(), "a later refresh keeps the order it was given");
        refresh(&mut zip, json!({ "categoryOrder": "bottomUp" })).unwrap();
        assert_eq!(axes(&zip), ("minMax".to_owned(), "autoZero".to_owned()));
        let refused = refresh(&mut zip, json!({ "categoryOrder": "sideways" })).unwrap_err();
        assert!(refused.contains("categoryOrder must be 'topDown' or 'bottomUp'"), "{refused}");

        // A column chart has no top or bottom to its categories: the field is refused rather than ignored.
        let (mut columns, column_shape) = deck_with_chart(json!({ "chartType": "column" }));
        let refused = batch(
            &mut columns,
            vec![json!({ "op": "set_chart_data", "slide": 1, "shapeId": column_shape, "series": [{ "name": "Retention", "values": [1, 2] }], "categoryOrder": "topDown" })],
        )
        .unwrap_err();
        assert!(refused.contains("orders a horizontal bar chart's categories"), "{refused}");
    }
}
