//! Twin test `docx_parts`: the recording of Node's Word part writers and run walkers
//! (`native/core/fixtures/office-docx-parts/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-docx-parts.mjs`) against this crate. `pure` replays the functions that take
//! XML and answer XML (the run normaliser, the story settler, the section-properties upserts and the small helpers) on their
//! recorded arguments; `sequences` replays the package operations step by step and compares what each step answered, then the
//! names and the text of every part. A time of day is scrubbed on both sides. Re-recording is `twin_live_docx_parts` (ignored:
//! it runs Node).

use std::path::Path;

use mixdog_fsio::Unlaned;
use mixdog_js::value_to_string;
use mixdog_office_base::twin;
use mixdog_ooxml::docx_parts::{
    HeaderFooter, NumberingChoice, WordDrawing, add_document_image, anchor_docx_comment, appended_numbering, comment_paragraph_id,
    document_section_spans, document_tracks_changes, ensure_comments_part, ensure_docx_update_fields, ensure_note_part,
    ensure_numbering, forget_comment_identity, mark_runs_deleted, next_revision_id, numbered_list_scheme, numbering_after,
    register_comment_identity, register_comment_thread, revision_attributes, trailing_section_properties, upsert_section_child,
    upsert_section_reference, word_drawing_xml, write_every_section_properties, write_header_footer_part,
    write_section_properties_at,
};
use mixdog_ooxml::docx_runs::{SettleOptions, normalize_docx_runs, settle_docx_story};
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-docx-parts")
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

/// The mutation a recorded section-properties call names.
fn mutation(spec: &Value) -> Box<dyn Fn(&str) -> String + '_> {
    match text(&spec["op"]) {
        "child" => Box::new(|xml| upsert_section_child(xml, text(&spec["tag"]), text(&spec["element"]))),
        "reference" => Box::new(|xml| upsert_section_reference(xml, text(&spec["tag"]), text(&spec["kind"]), text(&spec["id"]))),
        other => panic!("the recording has a mutation this test does not replay: {other}"),
    }
}

fn pure(name: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |at: usize| &args[at];
    Ok(match name {
        "normalizeDocxRuns" => {
            let done = normalize_docx_runs(text(arg(0)));
            json!({
                "xml": done.xml,
                "merged": done.merged,
                "textMerged": done.text_merged,
                "proofErrRemoved": done.proof_err_removed,
                "rsidStripped": done.rsid_stripped,
            })
        }
        "settleDocxStory" => {
            let options = &args[1];
            let settled = settle_docx_story(
                text(arg(0)),
                &SettleOptions {
                    resolution: options["resolution"].as_str().unwrap_or(""),
                    target: options["target"].as_u64().map_or(0, |target| target as usize),
                    id: options["id"].as_str().unwrap_or(""),
                    author: options["author"].as_str().unwrap_or(""),
                },
            );
            json!({
                "xml": settled.xml,
                "resolved": settled.resolved,
                "merged": settled.merged,
                "cleared": settled.cleared,
                "unmerged": settled.unmerged,
                "rowsRemoved": settled.rows_removed,
                "rowsCleared": settled.rows_cleared,
                "propertyChanges": settled.property_changes,
            })
        }
        "trailingSectionProperties" => {
            let found = trailing_section_properties(text(arg(0)))?;
            let body = found.model.body.as_ref().expect("a body");
            json!({
                "index": found.found.as_ref().map(|(at, _)| *at),
                "text": found.found.as_ref().map(|(_, xml)| xml.as_str()),
                "bodyStart": body.start,
                "bodyEnd": body.end,
            })
        }
        "documentSectionSpans" => {
            let (_, spans) = document_section_spans(text(arg(0)))?;
            Value::Array(spans.iter().map(|span| json!({ "start": span.start, "end": span.end, "xml": span.xml })).collect())
        }
        "writeSectionPropertiesAt" => json!(write_section_properties_at(text(arg(0)), arg(1), &*mutation(arg(2)))?),
        "writeEverySectionProperties" => json!(write_every_section_properties(text(arg(0)), arg(1), &*mutation(arg(2)))?),
        "upsertSectionChild" => json!(upsert_section_child(text(arg(0)), text(arg(1)), text(arg(2)))),
        "upsertSectionReference" => json!(upsert_section_reference(text(arg(0)), text(arg(1)), text(arg(2)), text(arg(3)))),
        "commentParagraphId" => json!(comment_paragraph_id(number(arg(0)))),
        "numberedListScheme" => json!(numbered_list_scheme(text(arg(0)), text(arg(1)))?),
        "wordDrawingXml" => {
            let spec = arg(0);
            json!(word_drawing_xml(&WordDrawing {
                id: number(&spec["id"]),
                embed_id: text(&spec["embedId"]),
                name: text(&spec["name"]),
                width: spec["width"].as_f64().unwrap_or(f64::NAN),
                height: spec["height"].as_f64().unwrap_or(f64::NAN),
                alt_text: text(&spec["altText"]),
            }))
        }
        "nextRevisionId" => json!(next_revision_id(text(arg(0)))),
        "anchorDocxComment" => json!(anchor_docx_comment(text(arg(0)), value_to_string(arg(1)))),
        "markRunsDeleted" => json!(mark_runs_deleted(text(arg(0)), number(arg(1)), text(arg(2)))),
        "revisionAttributes" => json!(revision_attributes(number(arg(0)), text(arg(1)))),
        other => panic!("the recording has a function this test does not replay: {other}"),
    })
}

/// A path inside the work directory is written `<work>/...`, as the recorder writes it.
fn scrub(message: &str, work: &str) -> String {
    message.replace(work, "<work>").replace("<work>\\", "<work>/")
}

/// The package a recording describes, from its files in order.
fn package_of(files: &Value) -> Package {
    let mut package = Package::new();
    for (name, content) in files.as_object().expect("the files of a package") {
        package.set(name, text(content));
    }
    package
}

fn part_text(part: &mixdog_ooxml::docx_parts::PartText) -> Value {
    json!({ "part": part.part, "xml": part.xml })
}

fn numbering_part(made: &mixdog_ooxml::docx_parts::NumberingPart) -> Value {
    json!({ "xml": made.xml, "numId": made.num_id, "created": made.created })
}

fn choice(options: &Value) -> NumberingChoice<'_> {
    NumberingChoice {
        continued: options["continued"].as_bool().unwrap_or(false),
        scheme: options["scheme"].as_str().unwrap_or("number"),
    }
}

/// What one step of a sequence answers, with the package it works on.
fn step(zip: &mut Package, work: &Path, step: &Value) -> Result<Value, String> {
    let field = |name: &str| step.get(name).and_then(Value::as_str).unwrap_or("");
    match field("op") {
        "ensureNotePart" => {
            let note = ensure_note_part(zip, field("kind"))?;
            let definition = note.definition;
            Ok(json!({
                "part": definition.part,
                "root": definition.root,
                "tag": definition.tag,
                "reference": definition.reference,
                "style": definition.style,
                "textStyle": definition.text_style,
                "contentType": definition.content_type,
                "relationship": definition.relationship,
                "xml": note.xml,
            }))
        }
        "ensureCommentsPart" => Ok(part_text(&ensure_comments_part(zip))),
        "registerCommentThread" => {
            let arg = &step["arg"];
            Ok(json!(register_comment_thread(
                zip,
                number(&arg["commentId"]),
                arg["parentId"].as_u64().unwrap_or(0),
                arg["done"].as_bool().unwrap_or(false)
            )))
        }
        "registerCommentIdentity" => {
            let arg = &step["arg"];
            let (para_id, durable_id) = register_comment_identity(zip, number(&arg["commentId"]), text(&arg["date"]));
            Ok(json!({ "paraId": para_id, "durableId": durable_id }))
        }
        "forgetCommentIdentity" => Ok(json!({ "removed": forget_comment_identity(zip, field("xml")) })),
        "writeHeaderFooterPart" => {
            let body = &step["body"];
            let addition = text(&body["text"]).to_owned();
            let kind = text(&body["kind"]).to_owned();
            let compose = move |existing: &str| match kind.as_str() {
                "append" => format!("{existing}{addition}"),
                "wrap" => format!("<w:p>{existing}</w:p>{addition}"),
                _ => addition.clone(),
            };
            let written = write_header_footer_part(
                zip,
                &HeaderFooter {
                    header: step["header"].as_bool().unwrap_or(false),
                    body: &compose,
                    document_xml: field("documentXml"),
                    kind: field("kind"),
                },
            );
            let mut answer = Map::new();
            answer.insert("part".to_owned(), json!(written.part));
            answer.insert("relationshipId".to_owned(), json!(written.relationship_id));
            if written.replaced {
                answer.insert("replaced".to_owned(), json!(true));
            }
            Ok(Value::Object(answer))
        }
        "ensureDocxUpdateFields" => Ok(json!({ "part": ensure_docx_update_fields(zip) })),
        "ensureNumbering" => {
            let restart = step["options"]["restart"].as_bool().unwrap_or(false);
            Ok(numbering_part(&ensure_numbering(zip, field("kind"), restart)))
        }
        "appendedNumbering" => Ok(numbering_part(&appended_numbering(zip, field("documentXml"), &choice(&step["options"])))),
        "numberingAfter" => Ok(numbering_part(&numbering_after(zip, field("before"), &choice(&step["options"])))),
        "documentTracksChanges" => Ok(json!(document_tracks_changes(zip))),
        "addDocumentImage" => {
            let path = work.join(field("file"));
            let bytes = base64_decode(field("base64"));
            mixdog_fsio::write(&Unlaned, &path, bytes).map_err(|error| error.to_string())?;
            let target = if step["missing"].as_bool() == Some(true) { work.join("absent").join(field("file")) } else { path };
            let added = add_document_image(&Unlaned, zip, &target.display().to_string())?;
            Ok(json!({
                "part": added.part,
                "relationshipId": added.relationship_id,
                "pixels": added.pixels.map(|size| json!({ "width": size.width, "height": size.height })),
                "name": added.name,
            }))
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

fn base64_decode(encoded: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(encoded).expect("base64")
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
    assert!(cases.len() > 250, "the recording lost cases: {}", cases.len());
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
    assert!(sequences.len() >= 20, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        let name = text(&sequence["name"]);
        let work = tempfile::tempdir().expect("work directory");
        let work_name = work.path().display().to_string();
        let mut zip = package_of(&sequence["files"]);
        let steps = sequence["steps"].as_array().expect("steps");
        let outputs = sequence["outputs"].as_array().expect("outputs");
        assert_eq!(steps.len(), outputs.len(), "{name}");
        for (index, (one, expected)) in steps.iter().zip(outputs).enumerate() {
            let produced = match step(&mut zip, work.path(), one) {
                Ok(value) => json!({ "result": value }),
                Err(error) => json!({ "error": scrub(&error, &work_name) }),
            };
            twin::assert_matches(&format!("{name}, step {index} ({})", text(&one["op"])), &recorded(expected), &produced);
        }
        twin::assert_matches(&format!("{name}, the package"), &sequence["snapshot"], &snapshot(&zip));
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_docx_parts -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_docx_parts() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-docx-parts.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
