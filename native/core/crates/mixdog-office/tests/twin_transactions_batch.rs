//! Twin test `transactions_batch`: the recording of Node's transactions and atomic batch
//! (`native/core/fixtures/office-transactions-batch/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-transactions-batch.mjs`) against `mixdog_office::transactions` and
//! `mixdog_office::batch`.
//!
//! A scenario is one session over a recorded fixture document and a list of steps run in order: `begin`, `batch`, `commit`,
//! `rollback`, `external` (another program overwrites the document), `restart` (the process ends: the session is gone and the journals,
//! the checkpoint and the document are what Node left, which this test writes before going on, so the recovery that follows reads a
//! journal Node wrote), `recover` and `pending`. After each step the answer's JSON text (or the error, with a conflict's details), the
//! journal files that exist, the document as the engine left it (a delimited file's text; the text of every part of a package, or the
//! SHA-256 of a part that is not XML, without docProps) and the files the call reported before writing them equal the recording; so do
//! the requests the scripted Microsoft Office host saw. The clock is fixed; every file lives in a temporary directory named `<dir>`, the
//! system temporary folder is `<tmp>`, the transaction ids are numbered in the order they appear and the random part of a checkpoint's
//! name is `<uuid>`. The delimited-file writer reports the file it writes, which Node's does not: for a csv or tsv the recorded files are
//! a subset of the reported ones, for every other format they are equal.
//! Re-recording is `twin_live_transactions_batch` (ignored: it runs Node).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_fsio::Unlaned;
use mixdog_js::{JsRegex, json_quote, json_stringify};
use mixdog_office::batch::{BatchContext, BatchHost, apply_batch};
use mixdog_office::inspect::{InspectContext, ReviewSnapshots};
use mixdog_office::session::mode::OfficeHost;
use mixdog_office::session::registry::Registry;
use mixdog_office::session::{Backend, DesignState, Mode, Session, SessionHandle, SessionInit};
use mixdog_office::snapshot::{ComHost, SnapshotContext};
use mixdog_office::transactions::{TransactionContext, TransactionError, begin_transaction, commit_transaction, pending_office_transactions, recover_office_transaction, rollback_transaction};
use mixdog_office_base::envelope::CONFLICT_MESSAGE;
use mixdog_office_base::twin;
use mixdog_office_base::values::sha256;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_design::library::{Environment as DesignEnvironment, iso_string};
use mixdog_office_pdf::adapter::FormView;
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_quality::document_brief::BriefReadings;
use mixdog_ooxml::ooxml_validator::Environment as ValidatorEnvironment;
use mixdog_ooxml::soffice::Soffice;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::zipio::Package;
use mixdog_pdf::embed::FontEnv;
use mixdog_pdf::write::PdfDocument;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Value, json};

/// The recorder's clock.
const CLOCK: f64 = 1_700_000_000_000.0;
/// The random part of a checkpoint's name as a journal seeded from the recording has it.
const SEEDED_UUID: &str = "0123456789abcdef0123456789abcdef";

fn text(value: &Value) -> &str {
    value.as_str().expect("a text")
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).expect("hex byte")).collect()
}

fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(200).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n recorded: {}\n produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

fn assert_text(what: &str, expected: &str, produced: &str) {
    assert!(expected == produced, "{what} differs from the recording {}", first_difference(expected, produced));
}

// ---- the scripted world -------------------------------------------------------------------------------------------------

/// The recorded documents have no form fields.
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

/// No brief is written in these scenarios.
struct NoBriefs;

impl BriefReadings for NoBriefs {
    fn html_brief_script(&self, _html: &str) -> String {
        String::new()
    }

    fn parse_authoring_brief(&self, _script: &str) -> Value {
        json!({ "present": false })
    }

    fn review_fact_coverage(&self, _document: &Value, _brief: &Value) -> Vec<Value> {
        Vec::new()
    }

    fn review_source_grounding(&self, _brief: &Value) -> Vec<Value> {
        Vec::new()
    }
}

/// The machine of a batch: no chart is drawn and no brief read in the recording.
struct World;

impl BatchHost for World {
    fn pdf_operations(&self, _data_dir: &Path, cancel: Option<CancellationToken>) -> ContentOperations {
        ContentOperations::new(FontEnv::default(), SvgFonts::none(), None, cancel)
    }

    fn chart_picture(&self, _block: &Value, _width: f64, _pdf: &Path) -> impl Future<Output = Result<String, String>> {
        async { Err("the recording draws no chart".to_owned()) }
    }

    fn brief_readings(&self) -> &dyn BriefReadings {
        &NoBriefs
    }
}

/// The Microsoft Office host of a scenario: the recorded answers in order, the requests it saw. An answer that names a `copy` first
/// writes that fixture to the request's `output`, as Excel saves a copy.
struct ScriptedHost {
    answers: RefCell<Vec<Value>>,
    seen: RefCell<Vec<Value>>,
    fixtures: PathBuf,
}

impl ComHost for ScriptedHost {
    fn call(&self, payload: &Value, _cancel: Option<&CancellationToken>, _timeout: Option<Duration>) -> impl Future<Output = Value> {
        let answer = if self.answers.borrow().is_empty() { json!({ "reply": { "ok": false, "error": "no answer scripted" } }) } else { self.answers.borrow_mut().remove(0) };
        if let Some(copy) = answer.get("copy").and_then(Value::as_str) {
            let output = payload["output"].as_str().expect("the output of a checkpoint request");
            mixdog_fsio::copy(&Unlaned, self.fixtures.join(copy), output).expect("write the saved copy");
        }
        self.seen.borrow_mut().push(payload.clone());
        let reply = answer["reply"].clone();
        async move { reply }
    }
}

impl OfficeHost for ScriptedHost {
    fn supported(&self) -> bool {
        true
    }

    fn detect(&self, _format: &str, _path: &str) -> impl Future<Output = Value> {
        async { json!({ "ok": true, "applications": [] }) }
    }

    fn open_session(&self, _payload: &Value, _cancel: Option<&CancellationToken>) -> impl Future<Output = Value> {
        async { json!({ "ok": false, "error": "no answer scripted" }) }
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

// ---- naming what a run leaves ---------------------------------------------------------------------------------------------

static CHECKPOINT: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"(mixdog-office-transaction-[A-Za-z0-9_]+)-[0-9a-f-]{32,36}", "g"));
static BACKUP: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"\.mixdog-backup-[0-9a-f-]{32,36}", "g"));
static TRANSACTION: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"office_tx_[0-9a-f]{16}", "g"));

/// What the recorder's `scrub` does: the folders, the random parts and the transaction ids named, every separator a `/`.
struct Scrub {
    dir: PathBuf,
    transactions: RefCell<Vec<String>>,
}

impl Scrub {
    fn quoted(text: &str) -> String {
        let mut out = String::new();
        json_quote(text, &mut out);
        out[1..out.len() - 1].to_owned()
    }

    /// `json`: the text is JSON, where a path separator is two backslashes; otherwise it is one.
    fn apply(&self, input: &str, json: bool) -> String {
        let mut out = input.to_owned();
        let named = |out: String, folder: &Path, name: &str| {
            let plain = folder.display().to_string();
            let slashed = plain.replace('\\', "/");
            let mut out = out;
            for form in [plain, slashed] {
                out = out.replace(&Self::quoted(&form), name).replace(&form, name);
            }
            out
        };
        out = named(out, &self.dir, "<dir>");
        let temporary = std::env::temp_dir();
        out = named(out, Path::new(temporary.display().to_string().trim_end_matches(['\\', '/'])), "<tmp>");
        out = CHECKPOINT.replace_all_with(&out, |found| format!("{}-<uuid>", found.get(1).unwrap_or("")));
        out = BACKUP.replace_all_with(&out, |_| ".mixdog-backup-<uuid>".to_owned());
        out = TRANSACTION.replace_all_with(&out, |found| {
            let id = found.get(0).unwrap_or("").to_owned();
            let mut known = self.transactions.borrow_mut();
            let at = known.iter().position(|held| *held == id).unwrap_or_else(|| {
                known.push(id);
                known.len() - 1
            });
            format!("<tx {}>", at + 1)
        });
        out.replace(if json { "\\\\" } else { "\\" }, "/")
    }

    /// The text of the recording put back as a file of this run: `<dir>` and `<tmp>` named, the checkpoint's random part given, the
    /// transactions numbered as the seed numbers them.
    fn restore(&self, recorded: &str) -> String {
        let forward = |path: &Path| path.display().to_string().replace('\\', "/");
        let mut out = recorded.replace("<dir>", &forward(&self.dir)).replace("<tmp>", &forward(&std::env::temp_dir())).replace("<uuid>", SEEDED_UUID);
        for number in 1..=16 {
            out = out.replace(&format!("<tx {number}>"), &seeded_id(number));
        }
        out
    }
}

/// The id a transaction of the seed has in this run.
fn seeded_id(number: usize) -> String {
    format!("office_tx_{number:016x}")
}

// ---- the state of a document -----------------------------------------------------------------------------------------------

/// The document as the recorder describes it: a delimited file's text, or a package's parts.
fn document_of(target: &Path, format: &str) -> Value {
    let Ok(bytes) = mixdog_fsio::read(&Unlaned, target) else { return Value::Null };
    if matches!(format, "csv" | "tsv") {
        return json!({ "text": String::from_utf8_lossy(&bytes) });
    }
    let package = Package::load_unchecked(&bytes).expect("a package");
    let mut parts = serde_json::Map::new();
    let mut names: Vec<String> = package.entries().into_iter().filter(|entry| !entry.dir && !entry.name.starts_with("docProps/")).map(|entry| entry.name.clone()).collect();
    names.sort();
    for name in names {
        let data = package.file(&name).unwrap_or_default();
        let part = if name.ends_with(".xml") || name.ends_with(".rels") { json!(String::from_utf8_lossy(data)) } else { json!({ "sha256": sha256(data) }) };
        parts.insert(name, part);
    }
    json!({ "parts": Value::Object(parts) })
}

/// The journal files that exist, by their scrubbed names.
fn journals_of(scrub: &Scrub, data_dir: &Path) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    let Ok(entries) = mixdog_fsio::read_dir(&Unlaned, data_dir.join("office-transactions")) else { return found };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let body = String::from_utf8_lossy(&mixdog_fsio::read(&Unlaned, entry.path()).expect("a journal")).into_owned();
        found.insert(scrub.apply(&name, false), scrub.apply(&body, true));
    }
    found
}

/// Whether `path` is inside `parent`, as the write ledger asks.
fn inside(parent: &Path, path: &Path) -> bool {
    let fold = |path: &Path| path.display().to_string().replace('\\', "/").to_lowercase();
    let (parent, path) = (fold(parent), fold(path));
    path == parent || path.starts_with(&format!("{}/", parent.trim_end_matches('/')))
}

/// The paths the ledger of a call records: the ones not inside the data folder, and not in the system temporary folder unless they are
/// inside the call's folder, each once.
fn recorded_notes(scrub: &Scrub, data_dir: &Path, notes: &Notes) -> Vec<String> {
    let temporary = std::env::temp_dir();
    let mut kept: Vec<String> = Vec::new();
    for path in notes.0.lock().expect("lock").iter() {
        if inside(data_dir, path) || (inside(&temporary, path) && !inside(&scrub.dir, path)) {
            continue;
        }
        let shown = scrub.apply(&path.display().to_string(), false);
        if !kept.iter().any(|held| held.to_lowercase() == shown.to_lowercase()) {
            kept.push(shown);
        }
    }
    kept.sort();
    kept
}

// ---- a scenario ----------------------------------------------------------------------------------------------------------------

fn design_environment(dir: &Path) -> DesignEnvironment {
    DesignEnvironment {
        library_config: String::new(),
        pack_url: String::new(),
        pack_key_id: String::new(),
        pack_public_key: String::new(),
        template_dirs: String::new(),
        windows: cfg!(windows),
        program_files: String::new(),
        program_files_x86: String::new(),
        app_data: String::new(),
        home: String::new(),
        cwd: dir.to_path_buf(),
        bundled_templates: PathBuf::new(),
        now_ms: Arc::new(|| CLOCK),
    }
}

fn session_of(scenario: &Value, target: &Path, data_dir: &Path) -> SessionHandle {
    let file_kind = target.extension().and_then(|extension| extension.to_str()).unwrap_or_default().to_owned();
    let target = target.display().to_string();
    Arc::new(Mutex::new(Session::new(SessionInit {
        id: text(&scenario["id"]).to_owned(),
        source: target.clone(),
        target,
        file_kind,
        format: text(&scenario["format"]).to_owned(),
        mode: Mode::parse(text(&scenario["mode"])).expect("a mode"),
        backend: Backend::parse(text(&scenario["backend"])).expect("a backend"),
        opened_at: iso_string(CLOCK),
        data_dir: data_dir.to_path_buf(),
        created: true,
        created_new_file: None,
        design_state: DesignState::default(),
    })))
}

/// What a new process finds after the recording's `restart`: this run's own journals and checkpoints are replaced by Node's, and so is
/// the document.
fn seed(step: &Value, scrub: &Scrub, data_dir: &Path, target: &Path) {
    let journals = data_dir.join("office-transactions");
    if let Ok(entries) = mixdog_fsio::read_dir(&Unlaned, &journals) {
        for entry in entries.flatten() {
            let held: Value = serde_json::from_slice(&mixdog_fsio::read(&Unlaned, entry.path()).expect("a journal")).expect("a journal is JSON");
            for field in ["checkpoint", "baselinePdf"] {
                if let Some(file) = held[field].as_str().filter(|file| !file.is_empty()) {
                    let _ = mixdog_fsio::remove_file(&Unlaned, file);
                }
            }
            mixdog_fsio::remove_file(&Unlaned, entry.path()).expect("remove a journal");
        }
    }
    mixdog_fsio::create_dir_all(&Unlaned, &journals).expect("journal folder");
    let mut known = scrub.transactions.borrow_mut();
    for (name, body) in step["journals"].as_object().expect("journals") {
        let number: usize = name.trim_start_matches("<tx ").trim_end_matches(">.json").parse().expect("a transaction number");
        let id = seeded_id(number);
        while known.len() < number {
            known.push(String::new());
        }
        known[number - 1] = id.clone();
        mixdog_fsio::write(&Unlaned, journals.join(format!("{id}.json")), scrub.restore(text(body))).expect("write a journal");
    }
    for (file, bytes) in step["seed"]["files"].as_object().expect("seed files") {
        mixdog_fsio::write(&Unlaned, scrub.restore(file), unhex(text(bytes))).expect("write a checkpoint");
    }
    mixdog_fsio::write(&Unlaned, target, unhex(text(&step["seed"]["document"]))).expect("write the document");
}

fn replay_scenario(scenario: &Value, golden: &Value, lane: &InLane<DurabilityIo>) {
    let name = text(&scenario["name"]).to_owned();
    let directory = tempfile::tempdir().expect("temp dir");
    let dir = directory.path().to_path_buf();
    let (docs, data_dir, fixtures) = (dir.join("docs"), dir.join("data"), dir.join("fixtures"));
    for folder in [&docs, &data_dir, &fixtures] {
        mixdog_fsio::create_dir_all(&Unlaned, folder).expect("folder");
    }
    for (file, bytes) in golden["files"].as_object().expect("files") {
        mixdog_fsio::write(&Unlaned, fixtures.join(file), unhex(text(bytes))).expect("write a fixture");
    }
    let target = docs.join(text(&scenario["file"]));
    mixdog_fsio::copy(&Unlaned, fixtures.join(text(&scenario["file"])), &target).expect("copy the document");
    let format = text(&scenario["format"]).to_owned();
    let original = session_of(scenario, &target, &data_dir);
    let environment = design_environment(&dir);
    let registry = Registry::new();
    registry.index(&environment, &original);
    let host = ScriptedHost { answers: RefCell::new(scenario.get("host").and_then(Value::as_array).cloned().unwrap_or_default()), seen: RefCell::new(Vec::new()), fixtures };
    let mut fonts = FontRegistry::new();
    let face = twin::repo_root().join("native/core/fixtures/office-measure/faces/MiriamLibre-Regular.otf");
    fonts.register_file(&Unlaned, &face, Some("Twin Miriam")).expect("register the face the measurer falls back to");
    let measurer = TextMeasurer::new(lane, &fonts);
    let validator = ValidatorEnvironment { disabled: true, ..ValidatorEnvironment::from_process() };
    let reviews = ReviewSnapshots::new();
    let inspect = InspectContext {
        snapshot: SnapshotContext { proof: lane, measurer: &measurer, forms: &NoForms, com: &host },
        soffice: Soffice::process(),
        validator: &validator,
        reviews: &reviews,
        abort: None,
    };
    let scrub = Scrub { dir: dir.clone(), transactions: RefCell::new(Vec::new()) };
    for (number, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
        let kind = text(&step["kind"]);
        let at = format!("{name}, step {number} ({kind})");
        host.seen.borrow_mut().clear();
        let notes = Notes::default();
        let current = registry.get(text(&scenario["id"])).unwrap_or_else(|| Arc::clone(&original));
        let world = World;
        let batch = BatchContext { inspect: &inspect, note: &notes, registry: &registry, env: &environment, host: &world };
        let transactions = TransactionContext { snapshot: &inspect.snapshot, note: &notes, registry: &registry, env: &environment };
        let outcome: Result<Value, TransactionError> = match kind {
            "begin" => ready(begin_transaction(&transactions, &current)),
            "batch" => {
                let mut args = step["args"].clone();
                args["__cwd"] = json!(docs.display().to_string());
                ready(apply_batch(&batch, &current, &args))
            }
            "commit" => ready(commit_transaction(&transactions, &current)),
            "rollback" => ready(rollback_transaction(&transactions, &current)),
            "external" => {
                mixdog_fsio::write(&Unlaned, &target, unhex(text(&golden["files"][text(&step["file"])]))).expect("replace the document");
                Ok(json!({ "replaced": step["file"] }))
            }
            "restart" => {
                registry.remove(text(&scenario["id"]));
                seed(step, &scrub, &data_dir, &target);
                Ok(json!({ "restarted": true }))
            }
            "recover" => {
                let transaction = step.get("tx").and_then(Value::as_u64).and_then(|tx| scrub.transactions.borrow().get(tx as usize - 1).cloned()).unwrap_or_default();
                ready(recover_office_transaction(&transactions, &json!({ "transaction": transaction, "strategy": step["strategy"] }), &data_dir))
            }
            "pending" => pending_office_transactions(&transactions, &data_dir).map(Value::Array).map_err(TransactionError::Failed),
            other => panic!("{at}: unknown step {other}"),
        };
        match outcome {
            Ok(value) => {
                assert!(step.get("error").is_none(), "{at}: Node failed with {}, this answered {}", step["error"], json_stringify(&value));
                assert_text(&format!("{at}: the answer"), text(&step["result"]), &scrub.apply(&json_stringify(&value), true));
            }
            Err(error) => {
                assert!(step.get("result").is_none(), "{at}: Node answered, this failed with {error}");
                assert_eq!(scrub.apply(&error.to_string(), false), text(&step["error"]), "{at}: the error");
                match error {
                    TransactionError::Conflict(conflict) => assert_text(&format!("{at}: the conflict's details"), text(&step["details"]), &scrub.apply(&json_stringify(&conflict.details), true)),
                    TransactionError::Failed(_) => assert!(step.get("details").is_none(), "{at}: Node's error carried details"),
                }
            }
        }
        let recorded: BTreeMap<String, String> = step["journals"].as_object().expect("journals").iter().map(|(file, body)| (file.clone(), text(body).to_owned())).collect();
        let produced = journals_of(&scrub, &data_dir);
        assert_eq!(produced.keys().collect::<Vec<_>>(), recorded.keys().collect::<Vec<_>>(), "{at}: the journal files");
        for (file, body) in &recorded {
            assert_text(&format!("{at}: journal {file}"), body, &produced[file]);
        }
        let document = document_of(&target, &format);
        assert!(document == step["document"], "{at}: the document differs from the recording {}", first_difference(&json_stringify(&step["document"]), &json_stringify(&document)));
        let reported = recorded_notes(&scrub, &data_dir, &notes);
        let expected: Vec<String> = step["notes"].as_array().expect("notes").iter().map(|note| text(note).to_owned()).collect();
        if matches!(format.as_str(), "csv" | "tsv") {
            assert!(expected.iter().all(|note| reported.contains(note)), "{at}: the files reported before writing: recorded {expected:?}, reported {reported:?}");
        } else {
            assert_eq!(reported, expected, "{at}: the files reported before writing");
        }
        let requests: Vec<String> = host.seen.borrow().iter().map(|request| scrub.apply(&json_stringify(request), true)).collect();
        let recorded_requests: Vec<&str> = step["requests"].as_array().expect("requests").iter().map(text).collect();
        assert_eq!(requests, recorded_requests, "{at}: the requests the Office host saw");
    }
}

fn replay_all(golden: &Value) {
    let scenarios = golden["scenarios"].as_array().expect("scenarios").clone();
    assert!(scenarios.len() >= 12, "the recording lost scenarios");
    for scenario in scenarios {
        let golden = golden.clone();
        on_lane(move |lane| replay_scenario(&scenario, &golden, lane));
    }
}

#[test]
fn every_scenario_equals_the_recording() {
    replay_all(&twin::load_golden("office-transactions-batch"));
}

#[test]
fn the_recording_holds_the_cases_of_the_contract_tests() {
    let golden = twin::load_golden("office-transactions-batch");
    let errors: Vec<&str> = golden["scenarios"].as_array().expect("scenarios").iter().flat_map(|scenario| scenario["steps"].as_array().expect("steps")).filter_map(|step| step["error"].as_str()).collect();
    for expected in [
        CONFLICT_MESSAGE,
        "Office transaction already active: <tx 1>",
        "No active Office transaction to commit",
        "batch requires at least one operation",
        "recover requires strategy: commit, rollback, or discard",
        "Office transaction journal not found: <tx 2>",
        "Excel refused the batch",
    ] {
        assert!(errors.contains(&expected), "no recorded case for: {expected}");
    }
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_transactions_batch -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/office-transactions.mjs)"]
fn twin_live_transactions_batch() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-transactions-batch.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_scenario_equals_the_recording();
}
