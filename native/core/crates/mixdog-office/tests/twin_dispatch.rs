//! Twin test `dispatch`: the recording of Node's Office tool entry point
//! (`native/core/fixtures/office-dispatch/golden.json`, written by `benchmarks/rust-core/recorders/record-office-dispatch.mjs`)
//! against `mixdog_office::actions` and `mixdog_office::dispatch`: whole call sequences answered as tool results, with no Microsoft
//! Office, no LibreOffice and no browser.
//!
//! A scenario is a list of calls. After the ids of the sessions and transactions are numbered in the order they appear, the folders
//! are named (`<dir>` for the call's folder, `<data>`, `<tmp>`), every separator is a `/` and every duration is 0, the text of each
//! answer, whether it is an error and how many image blocks it carries equal the recording. A string argument `<session>` stands for
//! the first session id the previous answer names. The clock is fixed. The scenarios hold the cancelled call of
//! `office-runtime-contract.test.mjs` and the initial operations of `office-actions-open.test.mjs` (the files they leave are compared
//! too), the refusals of a call, and the life of a delimited-file session.
//! Re-recording is `twin_live_dispatch` (ignored: it runs Node).

use std::cell::RefCell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::{Pin, pin};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll, Waker};
use std::time::Duration;

use mixdog_core_api::domain::ext::{BrowserEndpoint, BrowserHold};
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_js::JsRegex;
use mixdog_office::actions::{ComSessions, Machine};
use mixdog_office::author::SystemAuthor;
use mixdog_office::batch::{BatchContext, BatchHost};
use mixdog_office::engine::{AuthoringReads, Closer};
use mixdog_office::inspect::{InspectContext, ReviewSnapshots};
use mixdog_office::render::RenderEngine;
use mixdog_office::render::page_cache::PageSignature;
use mixdog_office::render::preview::View;
use mixdog_office::session::create::CreateTools;
use mixdog_office::session::mode::OfficeHost;
use mixdog_office::session::open::{LegacyConverter, SessionEnv};
use mixdog_office::session::registry::Registry;
use mixdog_office::snapshot::{ComHost, SnapshotContext};
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_design::library::{Context, Environment, Fetch, FetchRequest, FetchResponse, LibraryConfig, TemplateIndexer, iso_string, library_paths, read_json, write_json_atomic};
use mixdog_office_pdf::adapter::FormView;
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_quality::document_brief::BriefReadings;
use mixdog_ooxml::ooxml_validator::Environment as ValidatorEnvironment;
use mixdog_ooxml::soffice::Soffice;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_pdf::embed::FontEnv;
use mixdog_pdf::write::PdfDocument;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Value, json};

/// The recorder's clock.
const CLOCK: f64 = 1_700_000_000_000.0;

fn text(value: &Value) -> &str {
    value.as_str().expect("a text")
}

/// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(async { lanes.durability_io.submit(&CancellationToken::new(), job).expect("submit").await.expect("job") })
}

/// The answer of a future whose every await is ready at once.
fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = pin!(future);
    let mut cx = TaskContext::from_waker(Waker::noop());
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("the scripted world answers at once, yet the call waited"),
    }
}

// ---- the scripted world --------------------------------------------------------------------------------------------------

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

/// Microsoft Office does not run here.
struct NoOffice;

impl OfficeHost for NoOffice {
    fn supported(&self) -> bool {
        false
    }

    fn detect(&self, _format: &str, _path: &str) -> impl Future<Output = Value> {
        async { json!({ "ok": false, "available": false }) }
    }

    fn open_session(&self, _payload: &Value, _cancel: Option<&CancellationToken>) -> impl Future<Output = Value> {
        async { json!({ "ok": false, "error": "no Office here" }) }
    }
}

impl ComHost for NoOffice {
    fn call(&self, _payload: &Value, _cancel: Option<&CancellationToken>, _timeout: Option<Duration>) -> impl Future<Output = Value> {
        async { json!({ "ok": false, "error": "no Office here" }) }
    }
}

impl ComSessions for NoOffice {
    fn close_session(&self, _id: &str, _save: bool, _cancel: Option<&CancellationToken>) -> impl Future<Output = Value> {
        async { json!({ "ok": false, "reaped": true, "error": "no Office here" }) }
    }
}

struct NoLegacy;

impl LegacyConverter for NoLegacy {
    fn convert(&self, _path: &Path, _output: &Path) -> Result<(), String> {
        Err("no LibreOffice here".to_owned())
    }
}

struct NoNetwork;

impl Fetch for NoNetwork {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        Err(format!("the script has no network: {}", request.url))
    }
}

/// What `indexOfficeTemplates` writes when no template directory holds a template.
struct EmptyIndexer;

impl<L: mixdog_fsio::WriteLane> TemplateIndexer<L> for EmptyIndexer {
    fn index(&self, lane: &InLane<L>, env: &Environment, data_dir: &Path, config: &LibraryConfig) -> Result<Value, String> {
        let paths = library_paths(env, data_dir);
        mixdog_fsio::create_dir_all(lane, &paths.templates).map_err(|error| error.to_string())?;
        let previous = read_json(lane, &paths.template_index, json!({ "templates": [] }));
        let revision = mixdog_office_base::values::sha256("[]");
        let changed = previous.get("revision") != Some(&Value::String(revision.clone()));
        let index = json!({
            "schemaVersion": 1,
            "indexedAt": iso_string(env.now()),
            "revision": revision,
            "directories": config.template_directories,
            "templates": [],
        });
        if changed || !previous.get("revision").is_some_and(mixdog_office_base::values::truthy) {
            write_json_atomic(lane, &paths.template_index, &index)?;
        }
        let mut answer = index;
        answer["changed"] = Value::Bool(changed);
        answer["count"] = Value::from(0);
        Ok(answer)
    }
}

/// No page is drawn: a delimited file has none.
struct NoRender {
    fonts: FontRegistry,
    note: Arc<Notes>,
}

impl RenderEngine for NoRender {
    fn note(&self) -> &dyn WriteNote {
        self.note.as_ref()
    }

    fn fonts(&self) -> &FontRegistry {
        &self.fonts
    }

    fn exists(&self, _path: &Path) -> impl Future<Output = bool> {
        async { false }
    }

    fn make_directory(&self, _directory: &Path) -> impl Future<Output = Result<(), String>> {
        async { Ok(()) }
    }

    fn page_signatures(&self, _target: &Path) -> impl Future<Output = Result<Vec<PageSignature>, String>> {
        async { Err("no pages".to_owned()) }
    }

    fn export_document(&self, _session: &View, _output: &Path) -> impl Future<Output = Result<(), String>> {
        async { Err("no renderer".to_owned()) }
    }

    fn rasterize(&self, _output: &Path, _pages: Option<&[f64]>, _max_width: f64, _cancel: Option<CancellationToken>) -> impl Future<Output = Result<Value, String>> {
        async { Err("no renderer".to_owned()) }
    }

    fn recalculate_workbook(&self, _target: &Path, _force: bool, _cancel: Option<CancellationToken>) -> impl Future<Output = Result<Value, String>> {
        async { Err("no workbook".to_owned()) }
    }

    fn refit_columns(&self, _target: &Path, _operations: &[Value]) -> impl Future<Output = Result<Vec<Value>, String>> {
        async { Err("no workbook".to_owned()) }
    }
}

/// No browser is launched.
struct NoBrowser;

impl BrowserEndpoint for NoBrowser {
    fn lease<'life0, 'async_trait>(&'life0 self) -> Pin<Box<dyn Future<Output = Result<(String, BrowserHold), String>> + Send + 'async_trait>>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async { Err("no browser here".to_owned()) })
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

fn design_environment(dir: &Path) -> Environment {
    Environment {
        library_config: String::new(),
        pack_url: String::new(),
        pack_key_id: String::new(),
        pack_public_key: String::new(),
        template_dirs: String::new(),
        windows: cfg!(windows),
        program_files: String::new(),
        program_files_x86: String::new(),
        app_data: String::new(),
        home: dir.display().to_string(),
        cwd: dir.to_path_buf(),
        bundled_templates: PathBuf::new(),
        now_ms: Arc::new(|| CLOCK),
    }
}

// ---- naming what a run leaves ---------------------------------------------------------------------------------------------

static TRANSACTION: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"office_tx_[0-9a-f]{16}", "g"));
static SESSION: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"office_[0-9a-f]{16}", "g"));
static DURATION: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r#""([A-Za-z]+Ms)":\d+(\.\d+)?"#, "g"));
static BACKUP: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"\.mixdog-backup-[0-9a-f-]{32,36}", "g"));
static CHECKPOINT: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"(mixdog-office-transaction-[A-Za-z0-9_<> ]+)-[0-9a-f-]{32,36}", "g"));

/// What the recorder's `scrub` does.
struct Scrub {
    dir: PathBuf,
    data: PathBuf,
    sessions: RefCell<Vec<String>>,
    transactions: RefCell<Vec<String>>,
}

impl Scrub {
    fn quoted(text: &str) -> String {
        let mut out = String::new();
        mixdog_js::json_quote(text, &mut out);
        out[1..out.len() - 1].to_owned()
    }

    fn named(out: String, folder: &Path, name: &str) -> String {
        let plain = folder.display().to_string();
        let mut out = out;
        for form in [plain.clone(), plain.replace('\\', "/")] {
            out = out.replace(&Self::quoted(&form), name).replace(&form, name);
        }
        out
    }

    fn number(list: &RefCell<Vec<String>>, id: &str, label: &str) -> String {
        let mut known = list.borrow_mut();
        let at = known.iter().position(|held| held == id).unwrap_or_else(|| {
            known.push(id.to_owned());
            known.len() - 1
        });
        format!("<{label} {}>", at + 1)
    }

    fn apply(&self, input: &str) -> String {
        let mut out = Self::named(input.to_owned(), &self.data, "<data>");
        out = Self::named(out, &self.dir, "<dir>");
        let temporary = std::env::temp_dir();
        out = Self::named(out, Path::new(temporary.display().to_string().trim_end_matches(['\\', '/'])), "<tmp>");
        out = TRANSACTION.replace_all_with(&out, |found| Self::number(&self.transactions, found.get(0).unwrap_or(""), "tx"));
        out = SESSION.replace_all_with(&out, |found| Self::number(&self.sessions, found.get(0).unwrap_or(""), "session"));
        out = DURATION.replace_all_with(&out, |found| format!("\"{}\":0", found.get(1).unwrap_or("")));
        out = BACKUP.replace_all_with(&out, |_| ".mixdog-backup-<uuid>".to_owned());
        out = CHECKPOINT.replace_all_with(&out, |found| format!("{}-<uuid>", found.get(1).unwrap_or("")));
        out.replace("\\\\", "/").replace('\\', "/")
    }
}

fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(200).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n recorded: {}\n produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

/// `args` with every `<session>` put as the session `known`.
fn with_session(args: &Value, known: &str) -> Value {
    match args {
        Value::String(word) if word == "<session>" => Value::String(known.to_owned()),
        Value::Array(items) => Value::Array(items.iter().map(|item| with_session(item, known)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (key.clone(), with_session(value, known))).collect()),
        other => other.clone(),
    }
}

fn first_session(raw: &str) -> String {
    SESSION.find(raw).map_or_else(|| "<none>".to_owned(), |found| raw[found].to_owned())
}

fn replay_scenario(scenario: &Value, lane: &InLane<DurabilityIo>) {
    let name = text(&scenario["name"]).to_owned();
    let directory = tempfile::tempdir().expect("temp dir");
    let dir = directory.path().to_path_buf();
    let (docs, data) = (dir.join("docs"), dir.join("data"));
    for folder in [&docs, &data] {
        mixdog_fsio::create_dir_all(lane, folder).expect("folder");
    }
    let environment = design_environment(&dir);
    let (fetch, indexer) = (NoNetwork, EmptyIndexer);
    let design = Context { lane, env: &environment, fetch: &fetch, indexer: &indexer };
    let registry = Registry::new();
    let (host, legacy, notes) = (NoOffice, NoLegacy, Arc::new(Notes::default()));
    let fonts = Arc::new(FontRegistry::new());
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
    let render = NoRender { fonts: FontRegistry::new(), note: Arc::clone(&notes) };
    let closer = Closer { host: &host, registry: &registry, env: &environment, reviews: &reviews };
    let cwd = docs.display().to_string();
    let (font_env, svg_fonts, world) = (FontEnv::default(), SvgFonts::none(), World);
    let author = SystemAuthor {
        env: SessionEnv { design: &design, note: notes.as_ref(), registry: &registry, host: &host, legacy: &legacy, data_dir: &data, cwd: &cwd, cancel: None },
        inspect: &inspect,
        render: &render,
        closer: &closer,
        endpoint: &NoBrowser,
        lanes: mixdog_rt::testing::tokens(),
        fonts: Arc::clone(&fonts),
        svg_fonts: &svg_fonts,
        note: notes.clone(),
        deliveries: Mutex::default(),
    };
    let batch = BatchContext { inspect: &inspect, note: notes.as_ref(), registry: &registry, env: &environment, host: &world };
    let tools = CreateTools { closer: &closer, fonts: &font_env, svg_fonts: &svg_fonts };
    let machine = Machine { author: &author, batch: &batch, tools: &tools, reads: &AuthoringReads };
    let scrub = Scrub { dir: dir.clone(), data: data.clone(), sessions: RefCell::new(Vec::new()), transactions: RefCell::new(Vec::new()) };
    let mut last = String::new();
    for (number, call) in scenario["calls"].as_array().expect("calls").iter().enumerate() {
        let at = format!("{name}, call {number} ({})", call["args"]["action"]);
        let args = with_session(&call["args"], &first_session(&last));
        let cancel = CancellationToken::new();
        let cancelled = call.get("cancelled") == Some(&Value::Bool(true));
        if cancelled {
            cancel.cancel();
        }
        let result = ready(machine.run_office_tool(&args, Some(&cancel)));
        let content = result["content"].as_array().expect("content");
        let produced = text(&content[0]["text"]).to_owned();
        if !cancelled {
            last.clone_from(&produced);
        }
        let scrubbed = scrub.apply(&produced);
        let recorded = text(&call["text"]);
        assert!(scrubbed == recorded, "{at}: the answer differs from the recording {}", first_difference(recorded, &scrubbed));
        assert_eq!(result.get("isError") == Some(&Value::Bool(true)), call["isError"] == json!(true), "{at}: whether the answer is an error");
        assert_eq!(content.len() - 1, call["images"].as_u64().expect("images") as usize, "{at}: the image blocks");
    }
    if let Some(files) = scenario.get("files").and_then(Value::as_object) {
        for (file, recorded) in files {
            let bytes = mixdog_fsio::read(lane, docs.join(file)).unwrap_or_else(|error| panic!("{name}: {file} was not written: {error}"));
            assert_eq!(String::from_utf8_lossy(&bytes), text(recorded), "{name}: the text of {file}");
        }
    }
    if name.contains("delimited-file session") {
        let reported: Vec<String> = notes.0.lock().expect("lock").iter().map(|path| path.display().to_string().replace('\\', "/")).collect();
        let target = docs.join("people.csv").display().to_string().replace('\\', "/");
        assert!(reported.contains(&target), "{name}: the created file was reported before it was written: {reported:?}");
    }
}

#[test]
fn every_scenario_equals_the_recording() {
    let golden = twin::load_golden("office-dispatch");
    let scenarios = golden["scenarios"].as_array().expect("scenarios").clone();
    assert!(scenarios.len() >= 4, "the recording lost scenarios");
    for scenario in scenarios {
        on_lane(move |lane| replay_scenario(&scenario, lane));
    }
}

#[test]
fn the_recording_holds_the_cases_of_the_contract_tests() {
    let golden = twin::load_golden("office-dispatch");
    let answers: Vec<&str> = golden["scenarios"].as_array().expect("scenarios").iter().flat_map(|scenario| scenario["calls"].as_array().expect("calls")).filter_map(|call| call["text"].as_str()).collect();
    for expected in [
        "Error: session or path is required",
        "Error: Unknown or closed Office Use session: office_missing",
        "Error: attach does not support finalize:true; attach first, then use batch with finalize:true when closing the document is intended",
        "Error: create requires path or output",
        r#"{"ok":false,"code":"cancelled","message":"Office Use operation was cancelled","detail":"Office Use operation was cancelled"}"#,
    ] {
        assert!(answers.contains(&expected), "no recorded case for: {expected}");
    }
    assert!(answers.iter().any(|answer| answer.contains(r#""finalized":true"#)), "no recorded finalize that completed");
    assert!(answers.iter().any(|answer| answer.contains(r#""reason":"review_issues""#)), "no recorded finalize that held");
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_dispatch -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/index.mjs)"]
fn twin_live_dispatch() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-dispatch.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_scenario_equals_the_recording();
}
