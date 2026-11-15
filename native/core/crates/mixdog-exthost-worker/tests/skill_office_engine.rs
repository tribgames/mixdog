//! The pptx skill scripts (`source-extract`, `qc-pages`) through the REAL office engine of this crate on real files: the decks,
//! document and workbook are authored by the engine itself, the scripts' output carries the locators
//! `fixtures/skill-scripts-office/golden.json` records Node's scripts printing (`[slide n]`, `[Sheet!B2]`, block text), and the
//! calls the scripts make are the recorded ones (`open` portable without a snapshot, `snapshot`, `close`).

use std::path::Path;

use mixdog_exthost_worker::methods::SkillOfficeEngine;
use mixdog_fsio::Unlaned;
use mixdog_skill_scripts::mixdogd_exec::ExecOptions;
use mixdog_skill_scripts::mixdogd_exec::ExecResult;
use mixdog_skill_scripts::mixdogd_exec::ExecRunner;
use mixdog_skill_scripts::qc_pages::run_qc_pages;
use mixdog_skill_scripts::source_extract::OfficeEngine;
use mixdog_skill_scripts::source_extract::OfficeHost;
use mixdog_skill_scripts::source_extract::run_source_extract;
use serde_json::Value;
use serde_json::json;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/skill-scripts-office/golden.json");

struct NoExec;

impl ExecRunner for NoExec {
    fn run(&self, _options: &ExecOptions) -> ExecResult {
        panic!("a clean deck starts no model turn");
    }
}

fn engine() -> SkillOfficeEngine {
    SkillOfficeEngine::new().expect("the engine runtime starts")
}

fn create(engine: &SkillOfficeEngine, dir: &Path, name: &str, operations: Value) -> String {
    let path = dir.join(name).to_string_lossy().into_owned();
    let made = engine.call(&json!({ "action": "create", "path": path, "mode": "portable", "operations": operations }), dir).expect("create answers");
    let _ = engine.call(&json!({ "action": "close", "session": made["session"], "save": true }), dir);
    path
}

fn deck(engine: &SkillOfficeEngine, dir: &Path) -> String {
    create(
        engine,
        dir,
        "deck.pptx",
        json!([
            { "op": "add_slide" },
            { "op": "add_textbox", "slide": 1, "text": "Quarterly revenue grew 12%", "properties": { "left": 40, "top": 40, "width": 500, "height": 60, "fontSize": 28 } },
            { "op": "add_slide" },
            { "op": "add_textbox", "slide": 2, "text": "Churn fell to 3 percent", "properties": { "left": 40, "top": 40, "width": 500, "height": 60, "fontSize": 28 } },
            { "op": "set_notes", "slide": 2, "text": "Speaker note." }
        ]),
    )
}

fn run_extract(engine: &SkillOfficeEngine, dir: &Path, args: &[&str]) -> mixdog_skill_scripts::Outcome {
    let host = OfficeHost { engine: Some(engine), exec: &NoExec, cwd: dir };
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    run_source_extract(&Unlaned, &args, &host)
}

#[test]
fn the_calls_the_golden_records_are_answered_with_a_session_a_document_and_a_close() {
    let recording: Value = serde_json::from_str(&GOLDEN).expect("golden.json is JSON");
    let recorded: Vec<Value> = recording["cases"]["extract"]
        .as_array()
        .expect("extract cases")
        .iter()
        .find(|case| case["case"] == "a deck without its page chrome")
        .expect("the deck case")["observed"]["office"]
        .as_array()
        .expect("office calls")
        .clone();
    let actions: Vec<&str> = recorded.iter().map(|call| call["action"].as_str().expect("an action")).collect();
    assert_eq!(actions, ["open", "snapshot", "close"]);

    let dir = tempfile::tempdir().expect("temp dir");
    let engine = engine();
    let path = deck(&engine, dir.path());
    let opened = engine.call(&json!({ "action": "open", "path": path, "mode": "portable", "snapshotAfter": false }), dir.path()).expect("open");
    assert!(opened["session"].is_string(), "{opened}");
    let snapshot = engine.call(&json!({ "action": "snapshot", "session": opened["session"], "limit": 200, "maxChars": 100000 }), dir.path()).expect("snapshot");
    assert_eq!(snapshot["document"]["slides"].as_array().map(Vec::len), Some(2), "{snapshot}");
    engine.call(&json!({ "action": "close", "session": opened["session"], "save": false }), dir.path()).expect("close");
}

#[test]
fn source_extract_quotes_a_real_deck_with_slide_locators() {
    let dir = tempfile::tempdir().expect("temp dir");
    let engine = engine();
    let path = deck(&engine, dir.path());
    let out = run_extract(&engine, dir.path(), &[&path]);
    assert_eq!(out.code, 0, "{} {}", out.stdout, out.stderr);
    assert!(out.stdout.contains("[slide 1] Quarterly revenue grew 12%"), "{}", out.stdout);
    assert!(out.stdout.contains("[slide 2] Churn fell to 3 percent"), "{}", out.stdout);
}

#[test]
fn source_extract_quotes_a_real_workbook_by_cell_and_a_real_document_by_block() {
    let dir = tempfile::tempdir().expect("temp dir");
    let engine = engine();
    let book = create(&engine, dir.path(), "book.xlsx", json!([{ "op": "set_range", "range": "A1:B2", "values": [["Region", "Revenue"], ["Korea", 120]] }]));
    let out = run_extract(&engine, dir.path(), &[&book]);
    assert_eq!(out.code, 0, "{} {}", out.stdout, out.stderr);
    assert!(out.stdout.contains("B2] 120"), "{}", out.stdout);
    assert!(out.stdout.contains("A2] Korea"), "{}", out.stdout);

    let doc = create(
        &engine,
        dir.path(),
        "doc.docx",
        json!([{ "op": "append_text", "text": "Heading one", "style": "Heading1" }, { "op": "append_text", "text": "Body paragraph about margin." }]),
    );
    let out = run_extract(&engine, dir.path(), &[&doc]);
    assert_eq!(out.code, 0, "{} {}", out.stdout, out.stderr);
    assert!(out.stdout.contains("Body paragraph about margin."), "{}", out.stdout);
}

#[test]
fn source_extract_answers_the_engines_refusal_of_a_file_it_cannot_open() {
    let dir = tempfile::tempdir().expect("temp dir");
    let engine = engine();
    mixdog_testkit::write(dir.path().join("broken.pptx"), "not a package");
    let out = run_extract(&engine, dir.path(), &[&dir.path().join("broken.pptx").to_string_lossy()]);
    assert_eq!(out.code, 1, "{} {}", out.stdout, out.stderr);
    assert!(!out.stderr.is_empty());
}

#[test]
fn the_measurement_of_a_real_deck_is_its_issues_and_its_snapshot() {
    let dir = tempfile::tempdir().expect("temp dir");
    let engine = engine();
    let path = deck(&engine, dir.path());
    let measured = engine.measure(Path::new(&path)).expect("the deck measures");
    assert_eq!(measured.document["slides"].as_array().map(Vec::len), Some(2), "{}", measured.document);
    assert!(measured.issues.iter().all(|issue| issue["severity"] != "error"), "a clean authored deck has no error: {:?}", measured.issues);
}

#[test]
fn qc_pages_measures_a_real_deck_and_asks_no_model_when_nothing_is_wrong() {
    let dir = tempfile::tempdir().expect("temp dir");
    let engine = engine();
    let path = deck(&engine, dir.path());
    let output = dir.path().join("out").join("qc.json").to_string_lossy().into_owned();
    let host = OfficeHost { engine: Some(&engine), exec: &NoExec, cwd: dir.path() };
    let args: Vec<String> = [path.as_str(), "--provider", "p", "--model", "m", "--output", output.as_str(), "--no-vision"].iter().map(|arg| (*arg).to_owned()).collect();
    let out = run_qc_pages(&Unlaned, &args, &host);
    assert_eq!(out.code, 0, "{} {}", out.stdout, out.stderr);
    let report: Value = serde_json::from_slice(&mixdog_testkit::read(&output)).expect("the report is JSON");
    assert_eq!(report["pages"].as_array().map(Vec::len), Some(2), "{report}");
}
