//! Twin test `docx_revisions`: the recording of Node's Word-revision, package-validation and chart-fault modules
//! (`native/core/fixtures/office-docx-revisions/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-docx-revisions.mjs`) against this crate. `pure` replays the functions of
//! docx-revisions and portable-chart-faults on their recorded arguments; `packages` writes each recorded package to a file
//! and compares what `validate_portable_ooxml` answers with what Node's `validatePortableOoxml` answered, the XML
//! well-formedness messages of jsdom/saxes included; `charts` scans recorded presentation packages for chart faults.
//! Re-recording is `twin_live_docx_revisions` (ignored: it runs Node).

use std::path::Path;

use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_ooxml::chart_faults::{chart_data_link_faults, chart_fault_issues, chart_faults_in_xml};
use mixdog_ooxml::docx_revisions::{
    ResolveOptions, RevisionKind, RevisionSpan, Story, StoryParts, audit_docx_redlining, audit_docx_redlining_stories,
    count_docx_property_changes, docx_revision_tree, lint_docx_revisions, rendered_word_text, resolve_docx_property_changes,
    resolve_docx_revisions, revision_owner,
};
use mixdog_ooxml::opc::relationship_map;
use mixdog_ooxml::validation_package::{ValidateOptions, validate_portable_ooxml};
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-docx-revisions")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string argument")
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn recorded(case: &Value) -> Value {
    match case.get("error") {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": case["result"] }),
    }
}

fn project(spans: &[RevisionSpan], xml: &str) -> Value {
    Value::Array(
        spans
            .iter()
            .map(|span| {
                json!({
                    "tag": span.tag,
                    "kind": if span.kind == RevisionKind::Insertion { "ins" } else { "del" },
                    "attrs": span.attrs,
                    "id": span.id,
                    "author": span.author,
                    "date": span.date,
                    "text": span.text,
                    "outer": &xml[span.start..span.end],
                    "inner": &xml[span.inner_start..span.inner_end],
                    "children": project(&span.children, xml),
                })
            })
            .collect(),
    )
}

fn story_parts(value: &Value) -> StoryParts {
    value.as_object().expect("an object of parts").iter().map(|(name, xml)| (name.clone(), text(xml).to_owned())).collect()
}

fn resolve_options(value: &Value) -> ResolveOptions<'_> {
    ResolveOptions {
        resolution: value["resolution"].as_str().unwrap_or(""),
        target: value["target"].as_u64().map_or(0, |target| target as usize),
        id: value["id"].as_str().unwrap_or(""),
        author: value["author"].as_str().unwrap_or(""),
    }
}

fn pure(name: &str, args: &[Value]) -> Value {
    let arg = |at: usize| &args[at];
    match name {
        "revisionOwner" => json!(revision_owner(text(arg(0)))),
        "renderedWordText" => json!(rendered_word_text(text(arg(0)), text(arg(1)))),
        "docxRevisionTree" => project(&docx_revision_tree(text(arg(0))), text(arg(0))),
        "auditDocxRedlining" => audit_docx_redlining(text(arg(0)), text(arg(1)), text(arg(2))).to_value(),
        "auditDocxRedliningStories" => {
            audit_docx_redlining_stories(&story_parts(arg(0)), &story_parts(arg(1)), text(arg(2))).to_value()
        }
        "lintDocxRevisions" => {
            let stories: Vec<Story<'_>> = match arg(0) {
                Value::String(body) => vec![Story { part: "word/document.xml", xml: body }],
                other => other
                    .as_array()
                    .expect("a list of stories")
                    .iter()
                    .map(|story| Story { part: text(&story["part"]), xml: story["xml"].as_str().unwrap_or("") })
                    .collect(),
            };
            Value::Array(lint_docx_revisions(&stories, text(arg(1))).iter().map(|finding| finding.to_value()).collect())
        }
        "resolveDocxRevisions" => {
            let (xml, resolved) = resolve_docx_revisions(text(arg(0)), &resolve_options(arg(1)));
            json!({ "xml": xml, "resolved": resolved })
        }
        "resolveDocxPropertyChanges" => {
            let (xml, changes) = resolve_docx_property_changes(text(arg(0)), text(arg(1)), text(arg(2)));
            json!({ "xml": xml, "changes": changes })
        }
        "countDocxPropertyChanges" => json!(count_docx_property_changes(text(arg(0)))),
        "chartFaultsInXml" => Value::Array(chart_faults_in_xml(text(arg(0)), text(arg(1)))),
        "chartDataLinkFaults" => {
            let rels: String = arg(2)
                .as_object()
                .map(|map| map.iter().map(|(id, target)| format!(r#"<Relationship Id="{id}" Target="{}"/>"#, text(target))).collect())
                .unwrap_or_default();
            let present: Vec<&str> = arg(3).as_array().map(|list| list.iter().map(text).collect()).unwrap_or_default();
            Value::Array(chart_data_link_faults(text(arg(0)), text(arg(1)), &relationship_map(&rels), &|name| present.contains(&name)))
        }
        other => panic!("the recording has a function this test does not replay: {other}"),
    }
}

/// The package a recording describes, from its files in order.
fn package_of(files: &Value) -> Package {
    let mut package = Package::new();
    for (name, content) in files.as_object().expect("the files of a package") {
        package.set(name, text(content));
    }
    package
}

/// The bytes of a recorded file: a package, or a flat file that is not one.
fn write_package(path: &Path, files: &Value) {
    let bytes = match files.get("raw").and_then(Value::as_str) {
        Some(raw) => raw.as_bytes().to_vec(),
        None => package_of(files).generate().expect("a package"),
    };
    mixdog_fsio::write(&Unlaned, path, bytes).expect("the package written");
}

/// A path inside the work directory is written `<work>/...`, as the recorder writes it.
fn scrub(value: &Value, work: &str) -> Value {
    match value {
        Value::String(item) => Value::String(item.replace(work, "<work>").replace("<work>\\", "<work>/")),
        Value::Array(items) => Value::Array(items.iter().map(|item| scrub(item, work)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), scrub(item, work))).collect::<Map<_, _>>()),
        other => other.clone(),
    }
}

fn validate_recorded(case: &Value) -> Value {
    let work = tempfile::tempdir().expect("work directory");
    let current = work.path().join("current.pkg");
    write_package(&current, &case["files"]);
    let original = match &case["original"] {
        Value::Null => String::new(),
        Value::String(_) => work.path().join("absent.pkg").display().to_string(),
        files => {
            let path = work.path().join("original.pkg");
            write_package(&path, files);
            path.display().to_string()
        }
    };
    let options = &case["options"];
    let given = ValidateOptions {
        original: &original,
        saved_by: options["savedBy"].as_str().unwrap_or(""),
        audit_profile: options["auditProfile"].as_str().unwrap_or(""),
        author: options["author"].as_str().unwrap_or(""),
    };
    let outcome = validate_portable_ooxml(&Unlaned, &current, text(&case["format"]), &given);
    let answer = match outcome {
        Ok(result) => json!({ "result": result }),
        Err(error) => json!({ "error": error }),
    };
    scrub(&answer, &work.path().display().to_string())
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let cases = golden["pure"].as_array().expect("pure cases");
    assert!(cases.len() > 100, "the recording lost cases: {}", cases.len());
    for case in cases {
        let name = text(&case["fn"]);
        let args = case["args"].as_array().expect("arguments");
        let produced = json!({ "result": pure(name, args) });
        twin::assert_matches(&format!("{name}({})", Value::Array(args.clone())), &recorded(case), &produced);
    }
    let packages = golden["packages"].as_array().expect("packages");
    assert!(packages.len() >= 35, "the recording lost packages: {}", packages.len());
    for case in packages {
        let expected = recorded(case);
        let what = format!("package \"{}\"", text(&case["name"]));
        twin::assert_matches(&what, &expected, &validate_recorded(case));
    }
    let decks = golden["charts"].as_array().expect("chart packages");
    assert_eq!(decks.len(), 2, "the recording lost chart packages");
    for case in decks {
        let package = package_of(&case["files"]);
        let produced = json!({ "result": Value::Array(chart_fault_issues(&package)) });
        twin::assert_matches(&format!("charts \"{}\"", text(&case["name"])), &recorded(case), &produced);
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_docx_revisions -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_docx_revisions() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-docx-revisions.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
