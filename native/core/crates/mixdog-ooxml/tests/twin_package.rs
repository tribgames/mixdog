//! Twin test `package`: the recording of Node's portable package modules (`native/core/fixtures/office-package/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-package.mjs`) against this crate. `pure` replays the helpers
//! of portable-xml, portable-opc, portable-cells, pptx-relations and placeholder-scan on their recorded arguments;
//! `sequences` replays the package operations step by step and compares what each step answered, then the package's
//! names, its content types and the text of every part, and the fingerprints of the saved files. Re-recording is
//! `twin_live_package` (ignored: it runs Node).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::Unlaned;
use mixdog_js::json_number;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::blank::chart_workbook;
use mixdog_ooxml::cells::{expand_range, formula_references, set_cell_in_sheet, workbook_sheets};
use mixdog_ooxml::fingerprint::document_fingerprint;
use mixdog_ooxml::opc::{
    add_package_relationship, ensure_content_type_override, ensure_default_content_type, image_pixel_size,
    next_relationship_id, part_from_target, part_relationship_path, provenance_citation, relationship_map,
    relationship_owner, relationship_target, relationship_target_by_type, remove_content_type_override,
    remove_package_relationship,
};
use mixdog_ooxml::package::{CreateOptions, create_portable_ooxml_document, load_package, save_package};
use mixdog_ooxml::placeholder_scan::placeholder_text_issues;
use mixdog_ooxml::relations::relation_options;
use mixdog_ooxml::template_tokens::{FillTemplate, fill_template_parts};
use mixdog_ooxml::xml::{
    ParagraphTags, Replaced, block_text, container_body, container_inner, element_spans, replace_across_runs,
    replace_in_paragraphs, set_xml_attribute, settings_track_changes, tag_pattern, top_level_elements,
    upsert_ordered_child, xml_attribute, xml_decode, xml_encode,
};
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-package")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string argument")
}

fn texts(value: &Value) -> Vec<&str> {
    value.as_array().expect("a list argument").iter().map(text).collect()
}

fn replaced(outcome: Result<Replaced, String>) -> Result<Value, String> {
    outcome.map(|found| json!({ "xml": found.xml, "count": found.count }))
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn attempt(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
}

fn pure(name: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |at: usize| &args[at];
    Ok(match name {
        "xmlDecode" => json!(xml_decode(text(arg(0)))),
        "xmlEncode" => json!(xml_encode(text(arg(0)))),
        "tagPattern" => json!(tag_pattern(text(arg(0)))),
        "replaceAcrossRuns" => {
            return replaced(replace_across_runs(text(arg(0)), text(arg(1)), text(arg(2)), text(arg(3))));
        }
        "replaceInParagraphs" => {
            return replaced(replace_in_paragraphs(text(arg(0)), text(arg(1)), text(arg(2)), &ParagraphTags::default()));
        }
        "blockText" => json!(block_text(text(arg(0)), text(arg(1)))),
        "topLevelElements" => Value::Array(
            top_level_elements(text(arg(0)), &texts(arg(1)))
                .into_iter()
                .map(|item| json!({ "name": item.name, "start": item.start, "end": item.end, "xml": item.xml }))
                .collect(),
        ),
        "containerInner" => container_inner(text(arg(0)), text(arg(1)), arg(2).as_u64().expect("an offset") as usize)
            .map_or(Value::Null, |found| json!({ "start": found.start, "end": found.end, "inner": found.inner })),
        "elementSpans" => Value::Array(
            element_spans(text(arg(0)), text(arg(1)))
                .into_iter()
                .map(|item| json!({ "start": item.start, "end": item.end, "attrs": item.attrs, "xml": item.xml }))
                .collect(),
        ),
        "containerBody" => json!(container_body(text(arg(0)), text(arg(1)))),
        "upsertOrderedChild" => {
            json!(upsert_ordered_child(text(arg(0)), &texts(arg(1)), text(arg(2)), text(arg(3))))
        }
        "setXmlAttribute" => json!(set_xml_attribute(text(arg(0)), text(arg(1)), text(arg(2)))),
        "xmlAttribute" => json!(xml_attribute(text(arg(0)), text(arg(1)))),
        "settingsTrackChanges" => json!(settings_track_changes(text(arg(0)))),
        "partRelationshipPath" => json!(part_relationship_path(text(arg(0)))),
        "partFromTarget" => json!(part_from_target(text(arg(0)), text(arg(1)))),
        "relationshipOwner" => json!(relationship_owner(text(arg(0)))),
        "relationshipTarget" => json!(relationship_target(text(arg(0)), text(arg(1)))),
        "nextRelationshipId" => json!(next_relationship_id(text(arg(0)))),
        "relationshipTargetByType" => json!(relationship_target_by_type(text(arg(0)), text(arg(1)))),
        "relationshipMap" => Value::Array(
            relationship_map(text(arg(0))).iter().map(|(id, target)| json!([id, target])).collect(),
        ),
        "provenanceCitation" => json!(provenance_citation(arg(0))),
        "imagePixelSize" => {
            let data = STANDARD.decode(text(&arg(0)["base64"])).expect("base64");
            image_pixel_size(&data).map_or(Value::Null, |size| json!({ "width": size.width, "height": size.height }))
        }
        "placeholderTextIssues" => {
            let extra: Map<String, Value> = arg(2).as_object().cloned().unwrap_or_default();
            Value::Array(placeholder_text_issues(text(arg(0)), text(arg(1)), &extra))
        }
        "expandRange" => {
            let bounds = expand_range(text(arg(0)))?;
            json!({
                "startCol": json_number(bounds.start_col), "startRow": json_number(bounds.start_row),
                "endCol": json_number(bounds.end_col), "endRow": json_number(bounds.end_row),
            })
        }
        "formulaReferences" => Value::Array(
            formula_references(text(arg(0)), text(arg(1)))
                .into_iter()
                .map(|found| json!({ "sheet": found.sheet, "ref": found.reference, "path": found.path }))
                .collect(),
        ),
        "setCellInSheet" => json!(set_cell_in_sheet(text(arg(0)), text(arg(1)), arg(2), text(arg(3)))?),
        "relationOptions" => json!({ "objectName": relation_options(arg(0))? }),
        other => panic!("the recording has a function this test does not replay: {other}"),
    })
}

/// What one step of a sequence answers, with the package it works on.
fn step(zip: &mut Option<Package>, work: &std::path::Path, step: &Value) -> Result<Value, String> {
    let field = |name: &str| step.get(name).and_then(Value::as_str).unwrap_or("");
    let package = |zip: &mut Option<Package>| -> Package { zip.take().expect("a step before the package was made") };
    match field("op") {
        "create" => {
            let kind = field("kind");
            let path = work.join(format!("created.{}", kind.to_lowercase()));
            let options = CreateOptions { file_kind: kind, title: field("title"), sheet_name: field("sheetName") };
            let made = create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &options)?;
            *zip = Some(load_package(&Unlaned, &path)?);
            Ok(json!({ "format": made.format, "fileKind": made.file_kind, "parts": made.parts }))
        }
        "ensureOverride" => with(zip, |package| ensure_content_type_override(package, field("part"), field("type"))),
        "removeOverride" => with(zip, |package| remove_content_type_override(package, field("part"))),
        "ensureDefault" => with(zip, |package| ensure_default_content_type(package, field("extension"), field("type"))),
        "addRel" => {
            let mut held = package(zip);
            let id = add_package_relationship(&mut held, field("rels"), field("type"), field("target"), field("mode"));
            *zip = Some(held);
            Ok(json!(id))
        }
        "removeRel" => with(zip, |package| remove_package_relationship(package, field("rels"), field("id"))),
        "set" => with(zip, |package| package.set(field("name"), field("text"))),
        "remove" => with(zip, |package| package.remove(field("name"))),
        "fill" => {
            let mut held = package(zip);
            let parts: Vec<String> = texts(&step["parts"]).into_iter().map(str::to_owned).collect();
            let operation = FillTemplate { tokens: &step["tokens"], strict: step["strict"].as_bool().unwrap_or(false) };
            let outcome = fill_template_parts(&mut held, &parts, field("tag"), &operation, &|xml, tag, find, replacement| {
                replace_across_runs(xml, tag, find, replacement)
            });
            *zip = Some(held);
            outcome.map(|done| done.to_value())
        }
        "fingerprint" => {
            let held = package(zip);
            let path = work.join(format!("saved.{}", field("format")));
            save_package(&Unlaned, &NoWriteNote, &held, &path)?;
            *zip = Some(held);
            document_fingerprint(&Unlaned, &path, field("format")).map(Value::from)
        }
        "flatFingerprint" => {
            let path = work.join(format!("flat.{}", field("format")));
            mixdog_fsio::write(&Unlaned, &path, field("text")).map_err(|error| error.to_string())?;
            document_fingerprint(&Unlaned, &path, field("format")).map(Value::from)
        }
        "load" => {
            let path = work.join("loaded.bin");
            mixdog_fsio::write(&Unlaned, &path, STANDARD.decode(field("base64")).expect("base64"))
                .map_err(|error| error.to_string())?;
            let target = if step["missing"].as_bool() == Some(true) { work.join("absent.docx") } else { path };
            Ok(match load_package(&Unlaned, &target) {
                Ok(_) => json!({ "loaded": true }),
                Err(error) => json!({ "error": error.replace(&target.display().to_string(), "<path>") }),
            })
        }
        "chartWorkbook" => {
            let rows = step["rows"].as_array().expect("rows");
            *zip = Some(Package::load(&chart_workbook(rows, field("sheetName"))?)?);
            Ok(Value::Null)
        }
        "workbookSheets" => Ok(Value::Array(
            workbook_sheets(zip.as_ref().expect("a package"))
                .into_iter()
                .map(|sheet| json!({ "name": sheet.name, "path": sheet.path, "rid": sheet.rid, "visibility": sheet.visibility }))
                .collect(),
        )),
        other => panic!("the recording has a step this test does not replay: {other}"),
    }
}

fn with(zip: &mut Option<Package>, change: impl FnOnce(&mut Package)) -> Result<Value, String> {
    change(zip.as_mut().expect("a step before the package was made"));
    Ok(Value::Null)
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
    let pure_cases = golden["pure"].as_array().expect("pure cases");
    assert!(pure_cases.len() > 60, "the recording lost cases: {}", pure_cases.len());
    for case in pure_cases {
        let name = text(&case["fn"]);
        let args = case["args"].as_array().expect("arguments");
        let produced = attempt(pure(name, args));
        let expected = match case.get("error") {
            Some(error) => json!({ "error": error }),
            None => json!({ "result": case["result"] }),
        };
        twin::assert_matches(&format!("{name}({})", Value::Array(args.clone())), &expected, &produced);
    }
    let sequences = golden["sequences"].as_array().expect("sequences");
    assert!(sequences.len() >= 15, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        let name = text(&sequence["name"]);
        let work = tempfile::tempdir().expect("work directory");
        let mut zip: Option<Package> = None;
        let steps = sequence["steps"].as_array().expect("steps");
        let recorded = sequence["outputs"].as_array().expect("outputs");
        assert_eq!(steps.len(), recorded.len(), "{name}");
        for (index, (one, expected)) in steps.iter().zip(recorded).enumerate() {
            let produced = attempt(step(&mut zip, work.path(), one));
            twin::assert_matches(&format!("{name}, step {index} ({})", text(&one["op"])), expected, &produced);
        }
        let produced = zip.as_ref().map_or(Value::Null, snapshot);
        twin::assert_matches(&format!("{name}, the package"), &sequence["snapshot"], &produced);
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_package -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_package() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-package.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
