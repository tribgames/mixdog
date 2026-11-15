//! Twin test `docx_operations`: the recording of Node's Word document operations and tracked edits
//! (`native/core/fixtures/office-docx-operations/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-docx-operations.mjs`) against this crate. `pure` replays the functions that take
//! XML and answer XML (the tracked paragraph rewrite, phrase anchor and find-and-replace, the contents entries, the style
//! definitions) on their recorded arguments; `sequences` replays the package operations step by step and compares what each step
//! answered, then the names and the text of every part. A time of day is scrubbed on both sides. The review fixes of
//! `portable-review-fixes.test.mjs` that concern the Word parts are ported below the twin. Re-recording is
//! `twin_live_docx_operations` (ignored: it runs Node).

use std::collections::HashMap;

use mixdog_js::value_to_string;
use mixdog_office_base::twin;
use mixdog_ooxml::docx_operations::{
    TocEntry, add_docx_note, define_docx_styles, docx_style_definitions, docx_toc_cache_runs, docx_toc_entries, edit_docx_paragraph,
    fill_docx_content_control, fit_docx_table, refresh_docx_table_of_contents, replace_tracked_paragraphs, resolve_docx_revisions,
    set_docx_document_font, set_docx_page, style_or_merge_docx_table_cell, write_docx_toc_pages,
};
use mixdog_ooxml::docx_parts::{HeaderFooter, write_header_footer_part};
use mixdog_ooxml::docx_tracked_edits::{PhraseMarkers, anchor_phrase_in_paragraph, tracked_paragraph_replace, tracked_paragraph_rewrite};
use mixdog_ooxml::xml::compiled;
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-docx-operations")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn number(value: &Value) -> u64 {
    value.as_u64().expect("a whole number argument")
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn recorded(case: &Value) -> Value {
    match case.get("error") {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": case["result"] }),
    }
}

fn markers(value: &Value) -> Option<PhraseMarkers> {
    value.as_object().map(|object| PhraseMarkers {
        start: object.get("start").and_then(Value::as_str).map(str::to_owned),
        end: object.get("end").and_then(Value::as_str).map(str::to_owned),
        replace: object.get("replace").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn pure(name: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |at: usize| &args[at];
    Ok(match name {
        "trackedParagraphRewrite" => json!(tracked_paragraph_rewrite(text(arg(0)), text(arg(1)), number(arg(2)), text(arg(3)))?),
        "anchorPhraseInParagraph" => {
            json!(anchor_phrase_in_paragraph(text(arg(0)), text(arg(1)), value_to_string(arg(2)), markers(arg(3)).as_ref()))
        }
        "trackedParagraphReplace" => {
            let cut = tracked_paragraph_replace(text(arg(0)), text(arg(1)), text(arg(2)), number(arg(3)), text(arg(4)))?;
            json!({ "xml": cut.xml, "count": cut.count, "nextId": cut.next_id })
        }
        "replaceTrackedParagraphs" => {
            let done = replace_tracked_paragraphs(text(arg(0)), text(arg(1)), text(arg(2)), text(arg(3)))?;
            json!({ "xml": done.xml, "count": done.count, "paragraphRewrites": done.paragraph_rewrites })
        }
        "docxTocEntries" => {
            let levels: HashMap<String, u32> =
                arg(3).as_object().expect("levels").iter().map(|(style, level)| (style.clone(), number(level) as u32)).collect();
            let entries = docx_toc_entries(text(arg(0)), arg(1).as_f64().unwrap_or(f64::NAN), arg(2).as_f64().unwrap_or(f64::NAN), &levels);
            Value::Array(entries.iter().map(|entry| json!({ "level": entry.level, "text": entry.text })).collect())
        }
        "docxTocCacheRuns" => {
            let entries: Vec<TocEntry> = arg(0)
                .as_array()
                .expect("entries")
                .iter()
                .map(|entry| TocEntry {
                    level: number(&entry["level"]) as u32,
                    text: text(&entry["text"]).to_owned(),
                    page: entry.get("page").and_then(Value::as_f64),
                })
                .collect();
            json!(docx_toc_cache_runs(&entries, arg(1).as_f64().unwrap_or(f64::NAN)))
        }
        "docxStyleDefinitions" => {
            let definitions = docx_style_definitions(arg(0))?;
            Value::Array(definitions.into_iter().map(|(name, fields)| json!([name, fields])).collect())
        }
        other => panic!("the recording has a function this test does not replay: {other}"),
    })
}

/// The package a recording describes, from its files in order.
fn package_of(files: &Value) -> Package {
    let mut package = Package::new();
    for (name, content) in files.as_object().expect("the files of a package") {
        package.set(name, text(content));
    }
    package
}

/// `Object.keys(zip.files).filter(name => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))`.
fn story_parts(zip: &Package) -> Vec<String> {
    let pattern = compiled(r"^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$", "i");
    zip.names().into_iter().filter(|name| pattern.is_match(name)).collect()
}

/// What one step of a sequence answers, with the package it works on.
fn step(zip: &mut Package, step: &Value) -> Result<Value, String> {
    let field = |name: &str| step.get(name).and_then(Value::as_str).unwrap_or("");
    let operation = &step["op"];
    match field("fn") {
        "refreshDocxTableOfContents" => Ok(json!(refresh_docx_table_of_contents(zip))),
        "writeDocxTocPages" => {
            let pages: Vec<String> = step["pages"].as_array().expect("pages").iter().map(|page| text(page).to_owned()).collect();
            Ok(json!(write_docx_toc_pages(zip, &pages)?))
        }
        "addDocxNote" => add_docx_note(zip, operation),
        "setDocxDocumentFont" => set_docx_document_font(zip, operation),
        "defineDocxStyles" => define_docx_styles(zip, operation),
        "setDocxPage" => set_docx_page(zip, operation),
        "fitDocxTable" => fit_docx_table(zip, operation),
        "fillDocxContentControl" => fill_docx_content_control(zip, operation),
        "editDocxParagraph" => edit_docx_paragraph(zip, operation, step["tracking"].as_bool().unwrap_or(false)),
        "styleOrMergeDocxTableCell" => style_or_merge_docx_table_cell(zip, operation),
        "resolveDocxRevisions" => {
            let parts = story_parts(zip);
            resolve_docx_revisions(zip, &parts, operation)
        }
        "set" => {
            zip.set(field("name"), field("text"));
            Ok(Value::Null)
        }
        "remove" => {
            zip.remove(field("name"));
            Ok(Value::Null)
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
    let cases = golden["pure"].as_array().expect("pure cases");
    assert!(cases.len() > 100, "the recording lost cases: {}", cases.len());
    for case in cases {
        let name = text(&case["fn"]);
        let args = case["args"].as_array().expect("arguments");
        let produced = match pure(name, args) {
            Ok(value) => json!({ "result": value }),
            Err(error) => json!({ "error": error }),
        };
        twin::assert_matches(&format!("{name}({})", Value::Array(args.clone())), &recorded(case), &produced);
    }
    let sequences = golden["sequences"].as_array().expect("sequences");
    assert!(sequences.len() >= 30, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        let name = text(&sequence["name"]);
        let mut zip = package_of(&sequence["files"]);
        let steps = sequence["steps"].as_array().expect("steps");
        let outputs = sequence["outputs"].as_array().expect("outputs");
        assert_eq!(steps.len(), outputs.len(), "{name}");
        for (index, (one, expected)) in steps.iter().zip(outputs).enumerate() {
            let produced = match step(&mut zip, one) {
                Ok(value) => json!({ "result": value }),
                Err(error) => json!({ "error": error }),
            };
            twin::assert_matches(&format!("{name}, step {index} ({})", text(&one["fn"])), &recorded(expected), &produced);
        }
        twin::assert_matches(&format!("{name}, the package"), &sequence["snapshot"], &snapshot(&zip));
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_docx_operations -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_docx_operations() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-docx-operations.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}

// ---- the review fixes of portable-review-fixes.test.mjs that concern the Word parts and these operations ----------------------

const RELATIONSHIP_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn relationships(kind: &str, target: &str) -> String {
    format!(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{RELATIONSHIP_BASE}/{kind}\" Target=\"{target}\"/></Relationships>"
    )
}

/// 'a root-absolute header target is rewritten in place'.
#[test]
fn a_root_absolute_header_target_is_rewritten_in_place() {
    let mut zip = Package::new();
    zip.set("word/_rels/document.xml.rels", relationships("header", "/word/header1.xml"));
    zip.set("word/header1.xml", "<w:hdr xmlns:w=\"w\"><w:p/></w:hdr>");
    let document_xml = "<w:sectPr><w:headerReference w:type=\"default\" r:id=\"rId1\"/></w:sectPr>";
    let compose = |_: &str| "<w:p>new</w:p>".to_owned();
    let written = write_header_footer_part(&mut zip, &HeaderFooter { header: true, body: &compose, document_xml, kind: "default" });
    assert_eq!(written.part, "word/header1.xml");
    assert!(!zip.contains("word/word/header1.xml"));
    assert!(zip.text("word/header1.xml").contains("new"));
}

/// A tracked replacement after a document's own revisions continues their ids (recorded from Node: three matches, one deletion
/// and one insertion each, the middle one cut across a run that carries a tab).
#[test]
fn tracked_replacement_ids_continue_across_paragraphs() {
    let xml = "<w:body><w:p><w:ins w:id=\"7\" w:author=\"Eve\"><w:r><w:t>x</w:t></w:r></w:ins><w:r><w:t>fox</w:t></w:r></w:p>\
<w:p><w:r><w:t>f</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>ox</w:t></w:r></w:p><w:p><w:r><w:t>fox</w:t></w:r></w:p></w:body>";
    let done = replace_tracked_paragraphs(xml, "fox", "cat", "Reviewer").expect("a replacement");
    assert_eq!(done.count, 3);
    assert_eq!(done.paragraph_rewrites, 0);
    let ids: Vec<u64> = compiled(r#"<w:(?:ins|del) w:id="(\d+)""#, "g")
        .captures_iter(&done.xml)
        .map(|found| found.get(1).and_then(|digits| digits.parse().ok()).unwrap_or(0))
        .collect();
    assert_eq!(ids, vec![7, 8, 9, 10, 11, 12, 13, 14]);
    assert!(replace_tracked_paragraphs(xml, "", "x", "Reviewer").is_err());
}
