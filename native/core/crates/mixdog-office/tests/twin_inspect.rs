//! Twin test `inspect`: the recording of Node's inspection actions (`native/core/fixtures/office-inspect/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-inspect.mjs`) against `mixdog_office::inspect` and `mixdog_office::inline_audit`.
//!
//! `pure` replays the helpers on their literal inputs (the CSV quoting, the audit summary, the touched locations, the round
//! counter): each answer's JSON text equals Node's. `scenarios` open one session per scenario over the recorded fixture documents
//! (delimited files, Word, Excel and PowerPoint packages, PDFs) and run its steps in order: `issues`, `validate`, `get`, `query`
//! and the inline audit. The answer's JSON text or the error message equals the recording; a picture's pixels are compared by
//! the PNG's dimensions (the encoders differ in bytes); the files a query wrote are compared (a CSV by its bytes, a PNG by its
//! dimensions) and each was reported to the write note first; the requests the Microsoft Office host saw equal the recording.
//! Microsoft Office is a scripted host that gives the recorded answers (an answer that names a fixture file first writes it to
//! the request's `output`, as Excel saves a copy). The OOXML schema validator is off, as it was when recording. Re-recording is
//! `twin_live_inspect` (ignored: it runs Node).

use std::cell::RefCell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::json_stringify;
use mixdog_office::inline_audit::{inline_office_audit, record_inline_audit_round, summarize_office_audit, touched_locations};
use mixdog_office::inspect::{InspectContext, ReviewSnapshots, csv_cell, get_office_element, issues, query_office_document, validate};
use mixdog_office::session::registry::lock;
use mixdog_office::session::{Backend, DesignState, Mode, Session, SessionHandle, SessionInit};
use mixdog_office::snapshot::{ComHost, SnapshotContext};
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::adapter::FormView;
use mixdog_ooxml::ooxml_validator::Environment;
use mixdog_ooxml::soffice::Soffice;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_pdf::write::PdfDocument;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
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
    directory: PathBuf,
}

impl ComHost for ScriptedHost {
    fn call(&self, payload: &Value, _cancel: Option<&CancellationToken>, _timeout: Option<Duration>) -> impl Future<Output = Value> {
        let answer = if self.answers.borrow().is_empty() { json!({ "reply": { "ok": false, "error": "no answer scripted" } }) } else { self.answers.borrow_mut().remove(0) };
        let mut request = payload.clone();
        if let Some(copy) = answer.get("copy").and_then(Value::as_str) {
            let output = payload["output"].as_str().expect("the output of a save_copy request");
            mixdog_fsio::copy(&Unlaned, self.directory.join(copy), output).expect("write the saved copy");
        }
        if request["action"] == "save_copy" {
            request["output"] = json!("<copy>");
        }
        self.seen.borrow_mut().push(request);
        let reply = answer["reply"].clone();
        async move { reply }
    }
}

/// The files a call reported before writing them.
#[derive(Default)]
struct Notes(Mutex<Vec<PathBuf>>);

impl WriteNote for Notes {
    fn note_write(&self, path: &Path) {
        self.0.lock().expect("lock").push(path.to_path_buf());
    }
}

/// Runs a future whose every await is ready at once (the scripted host answers immediately).
fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("a scripted answer is ready at once, yet the call waited"),
    }
}

/// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(async { lanes.durability_io.submit(&CancellationToken::new(), job).expect("submit").await.expect("job") })
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).expect("hex byte")).collect()
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a text")
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

/// The value of a base64 digit.
fn digit(character: u8) -> u32 {
    match character {
        b'A'..=b'Z' => u32::from(character - b'A'),
        b'a'..=b'z' => u32::from(character - b'a') + 26,
        b'0'..=b'9' => u32::from(character - b'0') + 52,
        b'+' => 62,
        _ => 63,
    }
}

/// The width and height a PNG's header holds, from the start of its base64 text.
fn png_dimensions_of_base64(encoded: &str) -> (u32, u32) {
    let mut bytes = Vec::new();
    for group in encoded.as_bytes().chunks(4).take(8) {
        let mut value = 0_u32;
        for at in 0..4 {
            value = (value << 6) | group.get(at).map_or(0, |character| digit(*character));
        }
        bytes.extend([(value >> 16) as u8, (value >> 8) as u8, value as u8]);
    }
    (u32::from_be_bytes(bytes[16..20].try_into().expect("width")), u32::from_be_bytes(bytes[20..24].try_into().expect("height")))
}

/// A picture's pixels are a PNG whose bytes depend on the encoder: the answer keeps its dimensions.
fn with_pictures_named(json: &str) -> String {
    const MARK: &str = "\"data\":\"";
    let mut out = String::new();
    let mut rest = json;
    while let Some(at) = rest.find(MARK) {
        let (before, after) = rest.split_at(at + MARK.len());
        out.push_str(before);
        let length = after.find('"').unwrap_or(after.len());
        let data = &after[..length];
        if !data.is_empty() && data.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')) {
            let (width, height) = png_dimensions_of_base64(data);
            out.push_str(&format!("<png {width}x{height}>"));
        } else {
            out.push_str(data);
        }
        rest = &after[length..];
    }
    out.push_str(rest);
    out
}

fn png_dimensions(bytes: &[u8]) -> (u32, u32) {
    (u32::from_be_bytes(bytes[16..20].try_into().expect("width")), u32::from_be_bytes(bytes[20..24].try_into().expect("height")))
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

/// Checks an outcome against the recorded `result` (the JSON text) or `error` of a step.
fn assert_outcome(what: &str, recorded: &Value, outcome: Result<String, String>) {
    match outcome {
        Ok(produced) => {
            assert!(recorded.get("error").is_none(), "{what}: Node failed with {}, this answered {}", recorded["error"], produced.chars().take(300).collect::<String>());
            assert_text(what, text(&recorded["result"]), &produced);
        }
        Err(message) => {
            assert!(recorded.get("result").is_none(), "{what}: Node answered, this failed with {message}");
            assert_eq!(message, text(&recorded["error"]), "{what}: the error");
        }
    }
}

// ---- the helpers on literal inputs -------------------------------------------------------------------------------------

fn replay_pure(golden: &Value) {
    let pure = &golden["pure"];
    for case in pure["csv"].as_array().expect("csv") {
        assert_eq!(csv_cell(text(&case["cell"])), text(&case["result"]), "csv cell {}", case["cell"]);
    }
    for (number, case) in pure["summary"].as_array().expect("summary").iter().enumerate() {
        let touched: Vec<String> = case["touched"].as_array().expect("touched").iter().map(|entry| text(entry).to_owned()).collect();
        let issues = case["issues"].as_array().expect("issues");
        assert_text(&format!("summary {number}"), text(&case["result"]), &json_stringify(&summarize_office_audit(issues, &touched)));
    }
    for (number, case) in pure["touched"].as_array().expect("touched").iter().enumerate() {
        let operations = case["operations"].as_array().expect("operations");
        assert_text(&format!("touched {number}"), text(&case["result"]), &json_stringify(&json!(touched_locations(text(&case["format"]), operations))));
    }
    for case in pure["rounds"].as_array().expect("rounds") {
        let format = text(&case["format"]);
        let mut session = bare_session(format);
        let failing = || summarize_office_audit(&[json!({ "severity": "warning", "code": "text_overflow", "path": "/slide[1]/shape[1]", "message": "over" })], &[]);
        let audits = [failing(), failing(), failing(), failing(), summarize_office_audit(&[], &[]), failing()];
        for (number, (audit, recorded)) in audits.into_iter().zip(case["results"].as_array().expect("results")).enumerate() {
            assert_text(&format!("round {number} of {format}"), text(recorded), &json_stringify(&record_inline_audit_round(&mut session, audit)));
        }
    }
}

fn bare_session(format: &str) -> Session {
    Session::new(SessionInit {
        id: "office_pure".to_owned(),
        source: String::new(),
        target: String::new(),
        file_kind: format.to_owned(),
        format: format.to_owned(),
        mode: Mode::Portable,
        backend: Backend::MixdogOoxml,
        opened_at: String::new(),
        data_dir: PathBuf::new(),
        created: false,
        created_new_file: None,
        design_state: DesignState::default(),
    })
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
        data_dir: directory.to_path_buf(),
        created: false,
        created_new_file: None,
        design_state: DesignState::default(),
    });
    session.authored.print_sheet = scenario["printSheet"] == json!(true);
    session.authored.authored = scenario["authored"] == json!(true);
    if let Some(com) = scenario.get("com") {
        session.com.ownership = com["ownership"].as_str().map(str::to_owned);
        session.com.visible = com["visible"].as_bool();
    }
    Arc::new(Mutex::new(session))
}

/// The files a query wrote, against what Node wrote: each reported to the note first, a CSV equal in bytes, a PNG in dimensions.
fn check_written(at: &str, step: &Value, directory: &Path, notes: &Notes) {
    let written = step["written"].as_array().expect("written");
    let mut reported: Vec<String> = notes
        .0
        .lock()
        .expect("lock")
        .iter()
        .map(|path| path.strip_prefix(directory).unwrap_or(path).display().to_string().replace('\\', "/"))
        .collect();
    reported.sort();
    let mut recorded: Vec<String> = written.iter().map(|file| text(&file["file"]).to_owned()).collect();
    recorded.sort();
    assert_eq!(reported, recorded, "{at}: the files reported to the write note");
    for file in written {
        let bytes = mixdog_fsio::read(&Unlaned, directory.join(text(&file["file"]))).unwrap_or_else(|error| panic!("{at}: {} was not written: {error}", file["file"]));
        match file.get("png") {
            Some(dimensions) => assert_eq!(json!([png_dimensions(&bytes).0, png_dimensions(&bytes).1]), *dimensions, "{at}: dimensions of {}", file["file"]),
            None => assert_eq!(bytes, unhex(text(&file["hex"])), "{at}: bytes of {}", file["file"]),
        }
    }
}

fn replay_scenario(scenario: &Value, directory: &Path, lane: &InLane<DurabilityIo>) {
    let name = text(&scenario["name"]);
    let handle = handle_of(scenario, directory);
    let host = ScriptedHost {
        answers: RefCell::new(scenario.get("host").and_then(Value::as_array).cloned().unwrap_or_default()),
        seen: RefCell::new(Vec::new()),
        directory: directory.to_path_buf(),
    };
    let registry = Registry::new();
    let measurer = TextMeasurer::new(lane, &registry);
    let validator = Environment { disabled: true, ..Environment::from_process() };
    let reviews = ReviewSnapshots::new();
    let cx = InspectContext {
        snapshot: SnapshotContext { proof: lane, measurer: &measurer, forms: &NoForms, com: &host },
        soffice: Soffice::process(),
        validator: &validator,
        reviews: &reviews,
        abort: None,
    };
    for (number, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
        let at = format!("{name}, step {number} ({} {})", step["kind"], json_stringify(&step["args"]));
        host.seen.borrow_mut().clear();
        if let Some(version) = step.get("version").and_then(Value::as_u64) {
            lock(&handle).snapshot_version = version;
        }
        let notes = Notes::default();
        let args = &step["args"];
        let outcome = match text(&step["kind"]) {
            "issues" => ready(issues(&cx, &handle, args)),
            "validate" => ready(validate(&cx, &handle, args)),
            "get" => ready(get_office_element(&cx, &handle, args)),
            "query" => ready(query_office_document(&cx, &handle, args, directory, &notes)),
            _ => {
                let operations = step.get("operations").and_then(Value::as_array).cloned().unwrap_or_default();
                let exclude: Vec<String> = step.get("exclude").and_then(Value::as_array).map(|list| list.iter().map(|code| text(code).to_owned()).collect()).unwrap_or_default();
                Ok(ready(inline_office_audit(&cx, &handle, &operations, &exclude)).unwrap_or(Value::Null))
            }
        };
        let outcome = outcome.map(|value| with_pictures_named(&named(&json_stringify(&value), directory))).map_err(|message| named(&message, directory));
        assert_outcome(&at, step, outcome);
        if text(&step["kind"]) == "inline" {
            let round = lock(&handle).caches.inline_audit.clone().unwrap_or(Value::Null);
            assert_eq!(json_stringify(&round), text(&step["round"]), "{at}: the session's audit round");
        }
        if step.get("written").is_some() {
            check_written(&at, step, directory, &notes);
        }
        if let Some(recorded) = step.get("requests").and_then(Value::as_array) {
            let requests: Vec<String> = host.seen.borrow().iter().map(|request| named(&json_stringify(request), directory)).collect();
            let recorded: Vec<&str> = recorded.iter().map(text).collect();
            assert_eq!(requests, recorded, "{at}: the requests the Office host saw");
        }
    }
}

fn replay_all(golden: &Value) {
    replay_pure(golden);
    let directory = tempfile::tempdir().expect("temp dir");
    for (file, bytes) in golden["files"].as_object().expect("files") {
        mixdog_fsio::write(&Unlaned, directory.path().join(file), unhex(text(bytes))).expect("write a fixture");
    }
    let (scenarios, root) = (golden["scenarios"].clone(), directory.path().to_path_buf());
    assert!(scenarios.as_array().expect("scenarios").len() >= 28, "the recording lost scenarios");
    on_lane(move |lane| {
        for scenario in scenarios.as_array().expect("scenarios") {
            replay_scenario(scenario, &root, lane);
        }
    });
}

#[test]
fn every_case_equals_the_recording() {
    replay_all(&twin::load_golden("office-inspect"));
}

#[test]
fn the_recording_holds_a_case_for_each_inspection() {
    let golden = twin::load_golden("office-inspect");
    let mut seen = std::collections::HashSet::new();
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        for step in scenario["steps"].as_array().expect("steps") {
            seen.insert((text(&scenario["format"]).to_owned(), text(&step["kind"]).to_owned()));
        }
    }
    for format in ["csv", "tsv", "docx", "xlsx", "pptx", "pdf"] {
        for kind in ["issues", "validate", "get", "query"] {
            assert!(seen.contains(&(format.to_owned(), kind.to_owned())) || format == "tsv" && kind == "get", "no recorded {kind} on {format}");
        }
    }
    let queries: Vec<&str> = golden["scenarios"]
        .as_array()
        .expect("scenarios")
        .iter()
        .flat_map(|scenario| scenario["steps"].as_array().expect("steps"))
        .filter_map(|step| step["args"]["queryKind"].as_str())
        .collect();
    for kind in ["pdf-layout", "pdf-tables", "pdf-images"] {
        assert!(queries.iter().any(|recorded| recorded.eq_ignore_ascii_case(kind)), "no recorded {kind} query");
    }
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_inspect -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/office-actions-inspect.mjs)"]
fn twin_live_inspect() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-inspect.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_case_equals_the_recording();
}
