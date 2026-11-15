//! Twin test `pptx_base`: the recording of Node's presentation modules (`native/core/fixtures/office-pptx-base/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-pptx-base.mjs`) against this crate. `pure` replays the shape
//! builders, the chart readers, the snapshot helpers, the image layout, the editability review and the slide XML helpers on
//! their recorded arguments; `sequences` replays the slide operations step by step on a deck and compares what each step
//! answered, then the deck's names and the text of every part. Re-recording is `twin_live_pptx_base` (ignored: it runs Node).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::Unlaned;
use mixdog_js::{json_number, to_number};
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::image_layout::resolve_image_layout;
use mixdog_ooxml::package::{CreateOptions, create_portable_ooxml_document, load_package, save_package};
use mixdog_ooxml::pptx_chart::{
    chart_categories, chart_frame_xml, chart_title_text, detect_chart_type, read_chart_presentation, resolve_slide_chart,
    write_presentation_chart,
};
use mixdog_ooxml::pptx_core::{
    append_slide_shape, inspect_pptx_text_boxes, next_shape_id, pptx_related_part, presentation_slide_size,
    resolve_slide_background, selected_shape_spans, set_slide_background, set_table_values, shape_frame, shape_paragraphs,
    text_insets, theme_color, update_shape_geometry, write_shape_tree,
};
use mixdog_ooxml::pptx_package::{
    LayoutPart, add_presentation_slide, add_slide_image, clear_portable_presentation_slides, copy_slide_notes,
    delete_presentation_slide, ensure_comment_author, ensure_slide_comments, import_slides_into_presentation,
    move_presentation_slide, presentation_slides, read_slide_notes, renumber_presentation_slides, select_slide_layout,
    set_slide_notes, slide_at, slide_id_entries, slide_layout_parts, write_slide_id_list,
};
use mixdog_ooxml::pptx_targets::resolve_pptx_targets;
use mixdog_ooxml::review_editability::{review_dead_vector_chart, review_text_fragmentation};
use mixdog_ooxml::slide_shapes::{
    background_xml, from_emu, picture_xml, resolve_geometry, restyle_shape_text, restyled_paragraphs, shape_xml,
    solid_fill_xml, supported_shape_types, table_xml, text_anchor, text_body_xml, to_emu,
};
use mixdog_ooxml::snapshot_shared::{
    chart_part_snapshot, docx_paragraph_spacing, docx_run_font, next_page_offset, populated_cell_pagination, related_part_by_id,
    soft_break_facts, stated_run_font,
};
use mixdog_ooxml::xml::Container;
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-pptx-base")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string argument")
}

fn list(value: &Value) -> &Vec<Value> {
    value.as_array().expect("a list argument")
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn attempt(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
}

fn layouts_of(value: &Value) -> Vec<LayoutPart> {
    list(value)
        .iter()
        .map(|layout| LayoutPart {
            path: text(&layout["path"]).to_owned(),
            name: text(&layout["name"]).to_owned(),
            layout_type: text(&layout["type"]).to_owned(),
        })
        .collect()
}

/// The recording counts positions in UTF-16 units (a JS string index); the crate slices by byte offset. The harness
/// translates at the boundary, so a position names the same character on both sides.
fn units_at(source: &str, byte: usize) -> usize {
    source[..byte].encode_utf16().count()
}

fn bytes_at(source: &str, units: usize) -> usize {
    let mut seen = 0;
    for (at, c) in source.char_indices() {
        if seen >= units {
            return at;
        }
        seen += c.len_utf16();
    }
    source.len()
}

fn elements(source: &str, found: &[mixdog_ooxml::xml::Element]) -> Value {
    Value::Array(
        found
            .iter()
            .map(|item| json!({ "name": item.name, "start": units_at(source, item.start), "end": units_at(source, item.end), "xml": item.xml }))
            .collect(),
    )
}

fn pure(name: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |at: usize| &args[at];
    let option = |at: usize| args.get(at);
    Ok(match name {
        "toEmu" => json_number(to_emu(to_number(arg(0)))),
        "fromEmu" => json_number(from_emu(to_number(arg(0)), to_number(arg(1)))),
        "resolveGeometry" => json!(resolve_geometry(option(0))),
        "supportedShapeTypes" => json!(supported_shape_types()),
        "textBodyXml" => json!(text_body_xml(arg(0))),
        "shapeXml" => json!(shape_xml(arg(0))),
        "pictureXml" => json!(picture_xml(arg(0))),
        "tableXml" => json!(table_xml(arg(0))?),
        "restyleShapeText" => json!(restyle_shape_text(text(arg(0)), arg(1))),
        "restyledParagraphs" => json!(restyled_paragraphs(text(arg(0)), arg(1))),
        "textAnchor" => json!(text_anchor(option(0))),
        "solidFillXml" => json!(solid_fill_xml(option(0), option(1))),
        "backgroundXml" => json!(background_xml(option(0))?),
        "detectChartType" => json!(detect_chart_type(text(arg(0)))),
        "readChartPresentation" => read_chart_presentation(text(arg(0))),
        "chartFrameXml" => json!(chart_frame_xml(arg(0))),
        "chartCategories" => json!(chart_categories(text(arg(0)))),
        "chartTitleText" => json!(chart_title_text(text(arg(0)))),
        "chartPartSnapshot" => chart_part_snapshot(text(arg(0))),
        "docxRunFont" => docx_run_font(text(arg(0))),
        "docxParagraphSpacing" => docx_paragraph_spacing(text(arg(0))),
        "nextPageOffset" => {
            next_page_offset(to_number(arg(0)), to_number(arg(1)), to_number(arg(2))).map_or(Value::Null, json_number)
        }
        "populatedCellPagination" => {
            let given = arg(0);
            populated_cell_pagination(
                &given["options"],
                &given["page"],
                list(&given["selectedSheets"]),
                list(&given["sheets"]).len(),
                to_number(&given["sheetOffset"]),
            )
        }
        "statedRunFont" => stated_run_font(text(arg(0))),
        "softBreakFacts" => soft_break_facts(text(arg(0))),
        "resolveImageLayout" => resolve_image_layout(arg(0))?,
        "reviewTextFragmentation" => {
            let minimum = option(1).and_then(|options| options.get("minimumRun")).map_or(3.0, to_number);
            Value::Array(review_text_fragmentation(list(arg(0)), minimum))
        }
        "reviewDeadVectorChart" => {
            let minimum = option(2).and_then(|options| options.get("minimumBars")).map_or(4.0, to_number);
            Value::Array(review_dead_vector_chart(list(arg(0)), list(arg(1)), minimum))
        }
        "shapeParagraphs" => shape_paragraphs(text(arg(0))).map_or(Value::Null, Value::Array),
        "textInsets" => text_insets(text(arg(0))),
        "shapeFrame" => shape_frame(text(arg(0))).map_or(Value::Null, |frame| {
            json!({ "left": json_number(frame.left), "top": json_number(frame.top), "width": json_number(frame.width), "height": json_number(frame.height) })
        }),
        "setTableValues" => set_table_values(text(arg(0)), list(arg(1)))?,
        "setSlideBackground" => json!(set_slide_background(text(arg(0)), option(1))?),
        "appendSlideShape" => json!(append_slide_shape(text(arg(0)), text(arg(1)))?),
        "updateShapeGeometry" => json!(update_shape_geometry(text(arg(0)), arg(1))),
        "nextShapeId" => json_number(next_shape_id(text(arg(0)))),
        "selectedShapeSpans" => {
            let tree = Container { start: 0, end: 0, inner: text(&arg(0)["inner"]).to_owned() };
            let (shapes, selected) = selected_shape_spans(&tree, list(arg(1)))?;
            json!({ "shapes": elements(&tree.inner, &shapes), "selected": elements(&tree.inner, &selected) })
        }
        "writeShapeTree" => {
            let bounds = arg(1);
            let slide = text(arg(0));
            let tree = Container {
                start: bytes_at(slide, bounds["start"].as_u64().expect("a start") as usize),
                end: bytes_at(slide, bounds["end"].as_u64().expect("an end") as usize),
                inner: String::new(),
            };
            let shapes: Vec<String> = list(arg(2)).iter().map(|shape| text(shape).to_owned()).collect();
            json!(write_shape_tree(text(arg(0)), &tree, &shapes))
        }
        "selectSlideLayout" => {
            let layouts = layouts_of(arg(0));
            select_slide_layout(&layouts, option(1))?.to_value()
        }
        "writeSlideIdList" => {
            let entries: Vec<String> = list(arg(1)).iter().map(|entry| text(entry).to_owned()).collect();
            json!(write_slide_id_list(text(arg(0)), &entries))
        }
        "slideIdEntries" => json!(slide_id_entries(text(arg(0)))),
        other => panic!("the recording has a function this test does not replay: {other}"),
    })
}

fn deck(zip: &mut Option<Package>) -> &mut Package {
    zip.as_mut().expect("a step before the deck was made")
}

/// What one step of a sequence answers, with the deck it works on.
fn step(zip: &mut Option<Package>, work: &std::path::Path, step: &Value) -> Result<Value, String> {
    let field = |name: &str| step.get(name).and_then(Value::as_str).unwrap_or("");
    match field("op") {
        "create" => {
            let kind = field("kind");
            let path = work.join("created.pptx");
            let options = CreateOptions { file_kind: kind, title: field("title"), sheet_name: "" };
            let made = create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &options)?;
            *zip = Some(load_package(&Unlaned, &path)?);
            Ok(json!({ "format": made.format, "fileKind": made.file_kind, "parts": made.parts }))
        }
        "set" => {
            deck(zip).set(field("name"), field("text"));
            Ok(Value::Null)
        }
        "remove" => {
            deck(zip).remove(field("name"));
            Ok(Value::Null)
        }
        "slides" => Ok(Value::Array(presentation_slides(deck(zip)).iter().map(|slide| slide.to_value()).collect())),
        "layouts" => Ok(Value::Array(slide_layout_parts(deck(zip)).iter().map(LayoutPart::to_value).collect())),
        "selectLayout" => {
            let layouts = slide_layout_parts(deck(zip));
            Ok(select_slide_layout(&layouts, step.get("requested"))?.to_value())
        }
        "addSlide" => add_presentation_slide(deck(zip), &step["operation"]),
        "deleteSlide" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            delete_presentation_slide(package, &slides, &step["number"]).map(|()| Value::Null)
        }
        "moveSlide" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            move_presentation_slide(package, &slides, &step["number"], &step["index"]).map(|()| Value::Null)
        }
        "renumber" => Ok(json!(renumber_presentation_slides(deck(zip)))),
        "setNotes" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            set_slide_notes(package, &slides, &step["number"], &step["text"]).map(|()| Value::Null)
        }
        "readNotes" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            Ok(json!(read_slide_notes(package, slide_at(&slides, &step["number"]).expect("a slide"))))
        }
        "copyNotes" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            let from = slide_at(&slides, &step["from"]).expect("a slide").path.clone();
            let to = slide_at(&slides, &step["to"]).expect("a slide").path.clone();
            copy_slide_notes(package, &from, &to);
            Ok(Value::Null)
        }
        "commentAuthor" => Ok(json_number(ensure_comment_author(deck(zip), field("author"), field("initials")))),
        "slideComments" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            let slide = slide_at(&slides, &step["number"]).expect("a slide").clone();
            Ok(json!(ensure_slide_comments(package, &slide)))
        }
        "addImage" => {
            let source = work.join(format!("picture.{}", field("extension")));
            let missing = step["missing"].as_bool() == Some(true);
            if !missing {
                mixdog_fsio::write(&Unlaned, &source, STANDARD.decode(field("base64")).expect("base64")).map_err(|error| error.to_string())?;
            }
            let target = if missing { work.join("absent.png") } else { source };
            let package = deck(zip);
            let slides = presentation_slides(package);
            let slide = slide_at(&slides, &step["number"]).expect("a slide").path.clone();
            let shown = target.display().to_string();
            Ok(match add_slide_image(&Unlaned, package, &slide, &shown) {
                Ok(placed) => json!({ "part": placed.part, "relationshipId": placed.relationship_id }),
                Err(error) => json!({ "error": error.replace(&shown, "<path>") }),
            })
        }
        "importSlides" => {
            let source = work.join("import-source.pptx");
            mixdog_fsio::write(&Unlaned, &source, STANDARD.decode(field("base64")).expect("base64")).map_err(|error| error.to_string())?;
            import_slides_into_presentation(&Unlaned, deck(zip), &source.display().to_string(), step.get("numbers"), step.get("after"))
        }
        "clearSlides" => {
            let path = work.join("cleared.pptx");
            save_package(&Unlaned, &NoWriteNote, deck(zip), &path)?;
            let removed = clear_portable_presentation_slides(&Unlaned, &NoWriteNote, &path)?;
            *zip = Some(load_package(&Unlaned, &path)?);
            Ok(json!({ "removed": removed }))
        }
        "inspect" => inspect_pptx_text_boxes(deck(zip)),
        "resolveTargets" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            resolve_pptx_targets(package, &slides, &step["operation"])
        }
        "background" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            let slide = slide_at(&slides, &step["number"]).expect("a slide");
            resolve_slide_background(package, &slide.path, &package.text(&slide.path)).map(Value::from)
        }
        "themeColor" => theme_color(deck(zip), field("master"), field("token")).map(Value::from),
        "relatedPart" => Ok(json!(pptx_related_part(deck(zip), field("part"), field("suffix")))),
        "relatedPartById" => Ok(json!(related_part_by_id(deck(zip), field("part"), field("id")))),
        "slideSize" => {
            let (width, height) = presentation_slide_size(deck(zip));
            Ok(json!({ "width": json_number(width), "height": json_number(height) }))
        }
        "resolveChart" => {
            let package = deck(zip);
            let slides = presentation_slides(package);
            resolve_slide_chart(package, &slides, &step["operation"]).map(|found| json!({ "path": found.path, "part": found.part, "xml": found.xml }))
        }
        "writeChart" => {
            let args = &step["args"];
            write_presentation_chart(deck(zip), text(&args["chartPart"]), text(&args["embeddingPart"]), text(&args["chart"]), list(&args["rows"]))
                .map(|()| Value::Null)
        }
        other => panic!("the recording has a step this test does not replay: {other}"),
    }
}

/// `{ names, parts }`: every entry name in order and the text of every file.
fn snapshot(package: &Package) -> Value {
    let mut parts = Map::new();
    for entry in package.entries() {
        if !entry.dir {
            parts.insert(entry.name.clone(), Value::from(package.text(&entry.name)));
        }
    }
    json!({ "names": package.names(), "parts": parts })
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let pure_cases = list(&golden["pure"]);
    assert!(pure_cases.len() > 120, "the recording lost cases: {}", pure_cases.len());
    for case in pure_cases {
        let name = text(&case["fn"]);
        let args = list(&case["args"]);
        let produced = attempt(pure(name, args));
        let expected = match case.get("error") {
            Some(error) => json!({ "error": error }),
            None => json!({ "result": case["result"] }),
        };
        twin::assert_matches(&format!("{name}({})", Value::Array(args.clone())), &expected, &produced);
    }
    let sequences = list(&golden["sequences"]);
    assert!(sequences.len() >= 7, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        let name = text(&sequence["name"]);
        let work = tempfile::tempdir().expect("work directory");
        let mut zip: Option<Package> = None;
        let steps = list(&sequence["steps"]);
        let recorded = list(&sequence["outputs"]);
        assert_eq!(steps.len(), recorded.len(), "{name}");
        for (index, (one, expected)) in steps.iter().zip(recorded).enumerate() {
            let produced = attempt(step(&mut zip, work.path(), one));
            twin::assert_matches(&format!("{name}, step {index} ({})", text(&one["op"])), expected, &produced);
        }
        let produced = zip.as_ref().map_or(Value::Null, snapshot);
        twin::assert_matches(&format!("{name}, the deck"), &sequence["snapshot"], &produced);
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_pptx_base -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_pptx_base() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-pptx-base.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
