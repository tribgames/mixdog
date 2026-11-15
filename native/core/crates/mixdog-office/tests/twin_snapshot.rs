//! Twin test `snapshot`: the recording of Node's snapshot action (`native/core/fixtures/office-snapshot/golden.json`, written
//! by `benchmarks/rust-core/recorders/record-office-snapshot.mjs`) against `mixdog_office::snapshot`.
//!
//! `pure` replays the helpers on their literal inputs (page requests, finalised pages with their cursors, queries, document
//! paths, selections, contract checks, Excel normalisation): each answer's JSON text, or the error message, equals Node's.
//! `scenarios` open one session per scenario over the recorded fixture documents (delimited files, a Word, Excel and PowerPoint
//! package, a PDF) and run its steps in order: the answer's JSON text (cursors included), the contract violations of its
//! document, and the requests the Microsoft Office host saw equal the recording. Microsoft Office is a scripted host that gives
//! the recorded answers (an answer that names a fixture file first writes it to the request's `output`, as Excel saves a copy).
//! Re-recording is `twin_live_snapshot` (ignored: it runs Node).

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::{json_stringify, slice_utf16};
use mixdog_office::session::registry::lock;
use mixdog_office::session::{Backend, DesignState, Mode, Session, SessionHandle, SessionInit};
use mixdog_office::snapshot::pagination::Position;
use mixdog_office::snapshot::{
    ComHost, SnapshotContext, create_office_snapshot_request, finalize_office_snapshot_page, find_by_document_path, normalize_excel_snapshot_styles,
    office_snapshot_contract_violations, query_object, snapshot, snapshot_selection_for_target, trust_for_mutation,
};
use mixdog_office_base::twin;
use mixdog_office_pdf::adapter::FormView;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_pdf::write::PdfDocument;
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

/// The recorded documents have no form fields: the form vocabulary is empty (the forms module's own twin covers it).
struct NoForms;

impl FormView for NoForms {
    fn describe_fields(&self, _document: &PdfDocument) -> Vec<Value> {
        Vec::new()
    }

    fn minimum_size(&self, _field_type: &str) -> (f64, f64) {
        (24.0 - 0.01, 12.0 - 0.01)
    }

    fn rectangles_overlap(&self, _left: &Value, _right: &Value) -> bool {
        false
    }
}

/// The Microsoft Office host of a scenario: the recorded answers in order, the requests it saw.
struct ScriptedHost {
    answers: RefCell<Vec<Value>>,
    seen: RefCell<Vec<Value>>,
    directory: std::path::PathBuf,
}

impl ComHost for ScriptedHost {
    fn call(&self, payload: &Value, _cancel: Option<&CancellationToken>, _timeout: Option<Duration>) -> impl Future<Output = Value> {
        let answer = if self.answers.borrow().is_empty() { json!({ "reply": { "ok": false, "error": "no answer scripted" } }) } else { self.answers.borrow_mut().remove(0) };
        let mut request = payload.clone();
        if let Some(copy) = answer.get("copy").and_then(Value::as_str) {
            let output = payload["output"].as_str().expect("the output of a save_copy request");
            mixdog_fsio::copy(&Unlaned, self.directory.join(copy), output).expect("write the saved copy");
            request["output"] = json!("<copy>");
        }
        self.seen.borrow_mut().push(request);
        let reply = answer["reply"].clone();
        async move { reply }
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).expect("hex byte")).collect()
}

/// The text of the recording with the temporary directory named `<dir>`, as the recorder writes it.
fn named(text: &str, dir: &Path) -> String {
    let quoted = |text: &str| {
        let json = json_stringify(&Value::String(text.to_owned()));
        json[1..json.len() - 1].to_owned()
    };
    let dir = dir.display().to_string();
    let separator = std::path::MAIN_SEPARATOR.to_string();
    text.replace(&format!("{}{}", quoted(&dir), quoted(&separator)), "<dir>/").replace(&format!("{dir}{separator}"), "<dir>/").replace(&dir, "<dir>")
}

/// How much of a cut snapshot's `preview` the recording keeps.
const PREVIEW_UNITS: usize = 400;

fn text(value: &Value) -> &str {
    value.as_str().expect("a text")
}

/// The first place two texts differ, with what lies around it.
fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(200).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n recorded: {}\n produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

fn assert_text(what: &str, expected: &str, produced: &str) {
    assert!(expected == produced, "{what} differs from the recording {}", first_difference(expected, produced));
}

/// Checks an outcome against the recorded `result` (the JSON text) or `error` of a case.
fn assert_outcome(what: &str, recorded: &Value, outcome: Result<String, String>) {
    match outcome {
        Ok(produced) => {
            assert!(recorded.get("error").is_none(), "{what}: Node failed with {}, this answered {produced}", recorded["error"]);
            assert_text(what, text(&recorded["result"]), &produced);
        }
        Err(message) => {
            assert!(recorded.get("result").is_none(), "{what}: Node answered, this failed with {message}");
            assert_eq!(message, text(&recorded["error"]), "{what}: the error");
        }
    }
}

fn position(session: &Value) -> Position<'_> {
    Position { id: text(&session["id"]), format: text(&session["format"]), snapshot_version: session["snapshotVersion"].as_u64().expect("version") }
}

// ---- the helpers on literal inputs -------------------------------------------------------------------------------------

fn replay_pure(golden: &Value) {
    let pure = &golden["pure"];
    for (number, case) in pure["requests"].as_array().expect("requests").iter().enumerate() {
        let outcome = create_office_snapshot_request(position(&case["session"]), &case["args"], case["full"] == json!(true)).map(|request| json_stringify(&Value::Object(request)));
        assert_outcome(&format!("request {number} ({} {})", case["label"], json_stringify(&case["args"])), case, outcome);
    }
    for (number, case) in pure["pages"].as_array().expect("pages").iter().enumerate() {
        let request = create_office_snapshot_request(position(&case["session"]), &case["args"], false).expect("a request");
        let mut document = case["document"].clone();
        finalize_office_snapshot_page(&mut document, position(&case["session"]), &request);
        let produced = json_stringify(&json!({ "request": Value::Object(request), "document": document }));
        assert_text(&format!("page {number}"), text(&case["result"]), &produced);
    }
    for (number, case) in pure["query"].as_array().expect("query").iter().enumerate() {
        let mut matches = Vec::new();
        query_object(&case["value"], text(&case["query"]), "$", &mut matches);
        assert_text(&format!("query {number} ({})", case["query"]), text(&case["result"]), &json_stringify(&Value::Array(matches)));
    }
    for (number, case) in pure["find"].as_array().expect("find").iter().enumerate() {
        let found = find_by_document_path(&case["value"], text(&case["target"])).cloned().unwrap_or(Value::Null);
        assert_text(&format!("find {number} ({})", case["target"]), text(&case["result"]), &json_stringify(&found));
    }
    for (number, case) in pure["selection"].as_array().expect("selection").iter().enumerate() {
        let selection = snapshot_selection_for_target(text(&case["format"]), text(&case["target"]));
        assert_text(&format!("selection {number} ({} {})", case["format"], case["target"]), text(&case["result"]), &json_stringify(&selection));
    }
    for (number, case) in pure["contract"].as_array().expect("contract").iter().enumerate() {
        let violations = office_snapshot_contract_violations(&case["document"], text(&case["format"]), case["paged"] == json!(true));
        let produced = json_stringify(&Value::Array(violations.iter().map(|violation| violation.to_value()).collect()));
        assert_text(&format!("contract {number} ({})", case["format"]), text(&case["result"]), &produced);
    }
    for (number, case) in pure["normalize"].as_array().expect("normalize").iter().enumerate() {
        let mut document = case["document"].clone();
        normalize_excel_snapshot_styles(&mut document);
        assert_text(&format!("normalize {number}"), text(&case["result"]), &json_stringify(&document));
    }
}

// ---- the scenarios -----------------------------------------------------------------------------------------------------

fn handle_of(scenario: &Value, directory: &Path) -> SessionHandle {
    let target = directory.join(text(&scenario["file"])).display().to_string();
    let file_kind = Path::new(text(&scenario["file"])).extension().and_then(|extension| extension.to_str()).unwrap_or_default().to_owned();
    let mut session = Session::new(SessionInit {
        id: text(&scenario["id"]).to_owned(),
        source: target.clone(),
        target,
        file_kind,
        format: text(&scenario["format"]).to_owned(),
        mode: Mode::parse(text(&scenario["mode"])).expect("a mode"),
        backend: Backend::parse(text(&scenario["backend"])).expect("a backend"),
        opened_at: String::new(),
        data_dir: std::path::PathBuf::new(),
        created: scenario["created"] == json!(true),
        created_new_file: None,
        design_state: DesignState::default(),
    });
    if let Some(com) = scenario.get("com") {
        let field = |name: &str| Some(com[name].clone()).filter(|value| !value.is_null());
        session.com.ownership = com["ownership"].as_str().map(str::to_owned);
        session.com.visible = com["visible"].as_bool();
        session.com.app_pid = field("appPid");
        session.com.window_hwnd = field("windowHwnd");
        session.com.document_id = field("documentId");
    }
    Arc::new(Mutex::new(session))
}

fn replay_scenario(scenario: &Value, directory: &Path) {
    let name = text(&scenario["name"]);
    let handle = handle_of(scenario, directory);
    let host = ScriptedHost {
        answers: RefCell::new(scenario.get("host").and_then(Value::as_array).cloned().unwrap_or_default()),
        seen: RefCell::new(Vec::new()),
        directory: directory.to_path_buf(),
    };
    let registry = Registry::new();
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let cx = SnapshotContext { proof: &Unlaned, measurer: &measurer, forms: &NoForms, com: &host };
    let runtime = tokio::runtime::Builder::new_current_thread().build().expect("runtime");
    let steps = scenario["steps"].as_array().expect("steps");
    for (number, step) in steps.iter().enumerate() {
        let at = format!("{name}, step {number} ({})", step["kind"]);
        host.seen.borrow_mut().clear();
        let outcome = if text(&step["kind"]) == "trust" {
            runtime.block_on(trust_for_mutation(&cx, &handle)).map(|value| named(&json_stringify(&value), directory))
        } else {
            let mut args = step["args"].clone();
            if let Some(version) = step.get("version").and_then(Value::as_u64) {
                lock(&handle).snapshot_version = version;
            }
            if let Some(from) = step.get("cursorFrom").and_then(Value::as_u64) {
                // The cursor of the page Node answered at that step (a step that failed gave none).
                let earlier = &steps[from as usize];
                if let Some(answer) = earlier.get("result").and_then(Value::as_str) {
                    let answer: Value = serde_json::from_str(answer).expect("the earlier answer");
                    args["cursor"] = answer["document"]["pagination"]["nextCursor"].clone();
                }
            }
            let own_id = lock(&handle).id.clone();
            if let Some(other) = step.get("asSession").and_then(Value::as_str) {
                lock(&handle).id = other.to_owned();
            }
            let full = step.get("full") == Some(&json!(true));
            let result = runtime.block_on(snapshot(&cx, &handle, &args, full));
            lock(&handle).id = own_id;
            match result {
                Ok(mut value) => {
                    if let Some(recorded) = step.get("violations").and_then(Value::as_str) {
                        let document = value.get("document").unwrap_or(&Value::Null);
                        let violations = office_snapshot_contract_violations(document, text(&scenario["format"]), !full);
                        let produced = json_stringify(&Value::Array(violations.iter().map(|violation| violation.to_value()).collect()));
                        assert_text(&format!("{at}: the contract violations"), recorded, &produced);
                    }
                    // The head of a cut snapshot holds as much of the document as the folder's name leaves room for.
                    if value.get("truncated") == Some(&json!(true))
                        && let Some(preview) = value.get("preview").and_then(Value::as_str)
                    {
                        value["preview"] = json!(slice_utf16(&named(preview, directory), PREVIEW_UNITS));
                    }
                    Ok(named(&json_stringify(&value), directory))
                }
                Err(message) => Err(message),
            }
        };
        let outcome = outcome.map_err(|message| named(&message, directory));
        assert_outcome(&at, step, outcome);
        let requests: Vec<String> = host.seen.borrow().iter().map(|request| named(&json_stringify(request), directory)).collect();
        let recorded: Vec<&str> = step["requests"].as_array().expect("requests").iter().map(text).collect();
        assert_eq!(requests, recorded, "{at}: the requests the Office host saw");
    }
}

fn replay_all(golden: &Value) {
    replay_pure(golden);
    let directory = tempfile::tempdir().expect("temp dir");
    let mut files: HashMap<&str, Vec<u8>> = HashMap::new();
    for (file, bytes) in golden["files"].as_object().expect("files") {
        files.insert(file, unhex(text(bytes)));
    }
    for (file, bytes) in &files {
        mixdog_fsio::write(&Unlaned, directory.path().join(file), bytes).expect("write a fixture");
    }
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 14, "the recording lost scenarios");
    for scenario in scenarios {
        replay_scenario(scenario, directory.path());
    }
}

#[test]
fn every_case_equals_the_recording() {
    replay_all(&twin::load_golden("office-snapshot"));
}

#[test]
fn the_recording_holds_the_cases_of_the_contract_tests() {
    let golden = twin::load_golden("office-snapshot");
    let requests = golden["pure"]["requests"].as_array().expect("requests");
    let refused: Vec<&str> = requests.iter().filter_map(|case| case["error"].as_str()).collect();
    for expected in [
        "Office snapshot cursor is stale because the document changed",
        "Office snapshot cursor belongs to a different document session",
        "Office snapshot cursor selector does not match this request",
        "Invalid Office snapshot cursor",
    ] {
        assert!(refused.contains(&expected), "no recorded case for: {expected}");
    }
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_snapshot -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/office-sessions.mjs)"]
fn twin_live_snapshot() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-snapshot.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_case_equals_the_recording();
}
