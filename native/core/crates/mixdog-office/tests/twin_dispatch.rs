//! Twin test `dispatch`: the recording of Node's Office tool entry point
//! (`native/core/fixtures/office-dispatch/golden.json`, written by `benchmarks/rust-core/recorders/record-office-dispatch.mjs`)
//! against `mixdog_office::engine::Engine::execute`, the call a process makes: whole call sequences answered as tool results, with
//! no Microsoft Office, no LibreOffice and no browser.
//!
//! The recording holds the hand-written scenarios (the calls that need no session, the cancelled call, the initial operations of a
//! delimited file, the life of a delimited-file session) and every call the Node test files `office-runtime-contract`,
//! `office-runtime-design`, `office-runtime-pdf-marks` and `xlsx-portable-snapshot` make through `executeOfficeTool`.
//!
//! A scenario is a list of calls in a folder of its own. Before a call the files the test put in the folder are written (`seeds`) and
//! the ones it removed are removed. After the ids of the sessions, transactions and snapshot cursors are numbered in the order they
//! appear in answers, the folders are named (`<dir>`, `<data>`, `<tmp>`), every separator is a `/` and every duration is 0, the text of
//! each answer, whether it is an error, the image blocks it carries, the cursors it introduces, the write receipts of the call's
//! ledger (path, and the state of the file before and after: absent, uncaptured, its bytes or the parts of its package) and the
//! files of the folder the call created, changed or removed equal the recording. The clock is fixed.
//! Re-recording is `twin_live_dispatch` (ignored: it runs Node).

use std::cell::RefCell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};

use mixdog_core_api::domain::ext::{BrowserEndpoint, BrowserHold};
use mixdog_fonts::discovery::{HostEnv, scan};
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_fsio::Unlaned;
use mixdog_js::JsRegex;
use mixdog_office::batch::BatchHost;
use mixdog_office::engine::{Engine, Platform};
use mixdog_office_base::ledger::{CallLedger, ChangeSide};
use mixdog_office_base::twin;
use mixdog_office_com::{OfficeCom, OfficeComConfig};
use mixdog_office_design::library::{Environment, Fetch, FetchRequest, FetchResponse, TemplateIndexer};
use mixdog_office_design::templates::OfficeTemplateIndexer;
use mixdog_office_pdf::forms::PdfForm;
use mixdog_office_pdf::{LayoutOptions, PdfSource, extract_pdf_text_layout};
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_quality::document_brief::BriefReadings;
use mixdog_ooxml::ooxml_validator::Environment as ValidatorEnvironment;
use mixdog_ooxml::zipio::Package;
use mixdog_pdf::Guard;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::embed::FontEnv;
use mixdog_pdf::write::{LoadOptions, PdfDocument};
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, LaneTokens};
use serde_json::{Map, Value, json};

/// The recorder's clock.
const CLOCK: f64 = 1_700_000_000_000.0;

fn text(value: &Value) -> &str {
    value.as_str().expect("a text")
}

// ---- the world the call runs in --------------------------------------------------------------------------------------------------

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
        ContentOperations::new(FontEnv::host(), SvgFonts::none(), None, cancel)
    }

    fn chart_picture(&self, _block: &Value, _width: f64, _pdf: &Path) -> impl Future<Output = Result<String, String>> {
        async { Err("the recording draws no chart".to_owned()) }
    }

    fn brief_readings(&self) -> &dyn BriefReadings {
        &NoBriefs
    }
}

struct NoNetwork;

impl Fetch for NoNetwork {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        Err(format!("the script has no network: {}", request.url))
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
        bundled_templates: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mixdog-office-design/assets/templates"),
        now_ms: Arc::new(|| CLOCK),
    }
}

/// The system's faces, scanned once: the ones Node measures with.
fn system_fonts() -> Arc<FontRegistry> {
    static FONTS: LazyLock<Arc<FontRegistry>> = LazyLock::new(|| {
        let home = std::env::home_dir().unwrap_or_default();
        let env = HostEnv::current(&|name| std::env::var(name).ok(), &home);
        Arc::new(scan(&Unlaned, &env).registry)
    });
    Arc::clone(&FONTS)
}

/// What a process supplies to the engine, as the recording's world has it: Microsoft Office is never started (the recorded calls
/// need none), no browser, no network, the system's fonts and the recorder's clock.
struct TestPlatform {
    lanes: LaneTokens,
    office: OfficeCom,
    fonts: Arc<FontRegistry>,
    font_env: FontEnv,
    svg_fonts: SvgFonts,
    environment: Environment,
    validator: ValidatorEnvironment,
}

impl TestPlatform {
    fn new(dir: &Path, data: &Path) -> Self {
        let lanes = mixdog_rt::testing::tokens();
        Self {
            lanes,
            office: OfficeCom::new(OfficeComConfig::new(data.join("office-com"), lanes)),
            fonts: system_fonts(),
            font_env: FontEnv::host(),
            svg_fonts: SvgFonts::none(),
            environment: design_environment(dir),
            validator: ValidatorEnvironment { disabled: true, ..ValidatorEnvironment::from_process() },
        }
    }
}

impl Platform for TestPlatform {
    type Batch = World;

    fn lanes(&self) -> LaneTokens {
        self.lanes
    }

    fn office(&self) -> &OfficeCom {
        &self.office
    }

    fn fonts(&self) -> Arc<FontRegistry> {
        Arc::clone(&self.fonts)
    }

    fn font_env(&self) -> &FontEnv {
        &self.font_env
    }

    fn svg_fonts(&self) -> &SvgFonts {
        &self.svg_fonts
    }

    fn endpoint(&self) -> &dyn BrowserEndpoint {
        &NoBrowser
    }

    fn design_environment(&self) -> &Environment {
        &self.environment
    }

    fn fetch(&self) -> &dyn Fetch {
        &NoNetwork
    }

    fn indexer(&self) -> &dyn TemplateIndexer<Unlaned> {
        &OfficeTemplateIndexer
    }

    fn validator(&self) -> &ValidatorEnvironment {
        &self.validator
    }

    fn batch_host(&self) -> &World {
        &World
    }
}

// ---- naming what a run leaves --------------------------------------------------------------------------------------------------

static TRANSACTION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"office_tx_[0-9a-f]{16}", "g"));
static SESSION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"office_[0-9a-f]{16}", "g"));
static DURATION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#""([A-Za-z]+Ms)":\d+(\.\d+)?"#, "g"));
static BACKUP: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\.mixdog-backup-[0-9a-f-]{32,36}", "g"));
static AUTHORING: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\.mixdog-authoring-[A-Za-z0-9]{6}", "g"));
static CHECKPOINT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(mixdog-office-transaction-[A-Za-z0-9_<> ]+)-[0-9a-f-]{32,36}", "g"));
static CURSOR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#""(cursor|nextCursor)":"([A-Za-z0-9_-]{16,})""#, "g"));
static TOKEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<(session|tx|cursor) (\d+|\?)>", "g"));

/// What the recorder's `Scrub` does.
struct Scrub {
    dir: PathBuf,
    data: PathBuf,
    sessions: RefCell<Vec<String>>,
    transactions: RefCell<Vec<String>>,
    cursors: RefCell<Vec<String>>,
    fresh: RefCell<Map<String, Value>>,
}

impl Scrub {
    fn new(dir: &Path, data: &Path) -> Self {
        Self { dir: dir.to_path_buf(), data: data.to_path_buf(), sessions: RefCell::default(), transactions: RefCell::default(), cursors: RefCell::default(), fresh: RefCell::default() }
    }

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

    fn folders(&self, input: &str) -> String {
        let mut out = Self::named(input.to_owned(), &self.data, "<data>");
        out = Self::named(out, &self.dir, "<dir>");
        let temporary = std::env::temp_dir();
        Self::named(out, Path::new(temporary.display().to_string().trim_end_matches(['\\', '/'])), "<tmp>")
    }

    fn number(list: &RefCell<Vec<String>>, id: &str, label: &str, learn: bool) -> String {
        let mut known = list.borrow_mut();
        let at = match known.iter().position(|held| held == id) {
            Some(at) => at,
            None if learn => {
                known.push(id.to_owned());
                known.len() - 1
            }
            None => return format!("<{label} ?>"),
        };
        format!("<{label} {}>", at + 1)
    }

    fn plain(&self, input: &str, learn: bool) -> String {
        let mut out = self.folders(input);
        out = TRANSACTION.replace_all_with(&out, |found| Self::number(&self.transactions, found.get(0).unwrap_or(""), "tx", learn));
        out = SESSION.replace_all_with(&out, |found| Self::number(&self.sessions, found.get(0).unwrap_or(""), "session", learn));
        out = DURATION.replace_all_with(&out, |found| format!("\"{}\":0", found.get(1).unwrap_or("")));
        out = BACKUP.replace_all_with(&out, |_| ".mixdog-backup-<uuid>".to_owned());
        out = AUTHORING.replace_all_with(&out, |_| ".mixdog-authoring-<id>".to_owned());
        out = CHECKPOINT.replace_all_with(&out, |found| format!("{}-<uuid>", found.get(1).unwrap_or("")));
        out.replace("\\\\", "/").replace('\\', "/")
    }

    /// An answer: its cursors numbered and described, then [`Scrub::plain`].
    fn answer(&self, input: &str) -> String {
        self.fresh.borrow_mut().clear();
        let folded = self.folders(input);
        let swapped = CURSOR.replace_all_with(&folded, |found| {
            let (key, value) = (found.get(1).unwrap_or(""), found.get(2).unwrap_or(""));
            let known = self.cursors.borrow().iter().position(|held| held == value);
            let at = known.unwrap_or_else(|| {
                let at = {
                    let mut cursors = self.cursors.borrow_mut();
                    cursors.push(value.to_owned());
                    cursors.len() - 1
                };
                let decoded = String::from_utf8_lossy(&base64_bytes(value)).into_owned();
                self.fresh.borrow_mut().insert((at + 1).to_string(), Value::String(self.plain(&decoded, true)));
                at
            });
            format!("\"{key}\":\"<cursor {}>\"", at + 1)
        });
        self.plain(&swapped, true)
    }

    /// What a recorded argument stood for: the folders, and the id or cursor an answer carried.
    fn restore(&self, input: &str, known: &str) -> String {
        if input == "<session>" {
            return known.to_owned();
        }
        let named = |folder: &Path| folder.display().to_string().trim_end_matches(['\\', '/']).to_owned();
        let out = input.replace("<dir>", &named(&self.dir)).replace("<data>", &named(&self.data)).replace("<tmp>", &named(&std::env::temp_dir()));
        TOKEN.replace_all_with(&out, |found| {
            let (label, number) = (found.get(1).unwrap_or(""), found.get(2).unwrap_or(""));
            let at = number.parse::<usize>().ok().map(|n| n - 1);
            let pick = |list: &RefCell<Vec<String>>, fallback: &str| at.and_then(|at| list.borrow().get(at).cloned()).unwrap_or_else(|| fallback.to_owned());
            match label {
                "session" => pick(&self.sessions, "office_0000000000000000"),
                "tx" => pick(&self.transactions, "office_tx_0000000000000000"),
                _ => pick(&self.cursors, "cursor-not-recorded"),
            }
        })
    }
}

/// `Buffer.from(value, 'base64')` (and `'base64url'`: both alphabets are read).
fn base64_bytes(value: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut bits, mut held) = (0u32, 0u32);
    for byte in value.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(digit);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    out
}

fn restored(value: &Value, scrub: &Scrub, known: &str) -> Value {
    match value {
        Value::String(word) => Value::String(scrub.restore(word, known)),
        Value::Array(items) => Value::Array(items.iter().map(|item| restored(item, scrub, known)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), restored(item, scrub, known))).collect()),
        other => other.clone(),
    }
}

// ---- the files of a folder ------------------------------------------------------------------------------------------------------

/// The package properties' stamps (the content of `<dcterms:created ...>` and `<dcterms:modified ...>`) are the clock's: each is `<stamp>`.
fn without_stamps(xml: &str) -> String {
    let mut out = String::new();
    let mut at = 0;
    loop {
        let found = ["<dcterms:created", "<dcterms:modified"].iter().filter_map(|marker| xml[at..].find(marker).map(|index| index + at)).min();
        let Some(open) = found else { break };
        let Some(close) = xml[open..].find('>').map(|index| index + open) else { break };
        let Some(end) = xml[close + 1..].find('<').map(|index| index + close + 1) else { break };
        out.push_str(&xml[at..=close]);
        out.push_str("<stamp>");
        at = end;
    }
    out.push_str(&xml[at..]);
    out
}

/// `Math.floor(value * 1000 + 0.5) / 1000`, as the JSON number JavaScript writes it (a whole number has no fraction).
fn milli(value: f64) -> Value {
    let rounded = (value * 1000.0 + 0.5).floor() / 1000.0;
    if rounded.fract() == 0.0 && rounded.abs() < 9e15 { Value::from(rounded as i64) } else { Value::from(rounded) }
}

/// A PDF as the golden holds it: per page its size and the text items a reader finds (positions to the thousandth of a point, as the
/// PDF writer's twin compares them), and the fields of a form. This engine's PDF writer does not write Node's bytes.
fn pdf_fingerprint(bytes: &[u8]) -> Value {
    let file = tempfile::Builder::new().suffix(".pdf").tempfile().expect("a temporary file");
    mixdog_fsio::write(&Unlaned, file.path(), bytes).expect("the PDF is written");
    let options = LayoutOptions { shapes: false, ..LayoutOptions::default() };
    let layout = match extract_pdf_text_layout(&Unlaned, PdfSource::Path(file.path()), &options) {
        Ok(layout) => layout,
        Err(error) => return json!({ "pdf": { "unreadable": error.message } }),
    };
    let pages: Vec<Value> = layout
        .pages
        .iter()
        .map(|page| {
            json!({
                "width": milli(page.width),
                "height": milli(page.height),
                "items": page.items.iter().map(|item| json!({ "text": item.text, "x": milli(item.x), "top": milli(item.top), "width": milli(item.width), "height": milli(item.height) })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let load = LoadOptions { ignore_encryption: false, filters: Arc::new(CodecFilters), guard: Guard::unbounded() };
    let fields = PdfDocument::load(bytes.to_vec(), &load).ok().and_then(|mut document| PdfForm::new().describe_fields(&mut document).ok()).filter(|fields| !fields.is_empty());
    let mut pdf = json!({ "pages": pages });
    if let Some(fields) = fields {
        pdf["fields"] = Value::Array(fields);
    }
    json!({ "pdf": pdf })
}

/// A file as the golden holds it: a PDF by what a reader finds in it, a package by its parts (the stamps of the package's properties,
/// which are the clock's, left out), else its bytes.
fn fingerprint(bytes: &[u8]) -> Value {
    if bytes.starts_with(b"%PDF-") {
        return pdf_fingerprint(bytes);
    }
    if bytes.starts_with(b"PK\x03\x04")
        && let Ok(package) = Package::load(bytes)
    {
        let parts: Vec<Value> = package
            .entries()
            .iter()
            .map(|entry| {
                let held = if entry.name == "docProps/core.xml" {
                    without_stamps(&String::from_utf8_lossy(&entry.data)).into_bytes()
                } else {
                    entry.data.clone()
                };
                // A package inside a package (a chart's workbook) is its parts and has no byte count: its compression is not Node's.
                if entry.data.starts_with(b"PK\x03\x04") {
                    return json!([entry.name, Value::Null, fingerprint(&entry.data)]);
                }
                json!([entry.name, entry.data.len(), mixdog_office_base::values::sha256(&held)])
            })
            .collect();
        return json!({ "zip": parts });
    }
    json!({ "bytes": bytes.len(), "sha256": mixdog_office_base::values::sha256(bytes) })
}

/// What a folder holds: a file's bytes, `None` for a folder (its path ends in a `/`).
type Files = Vec<(String, Option<Vec<u8>>)>;

/// The files and folders under `root` but the data folder, by their path from `root` with `/`.
fn walk(root: &Path, skip: &Path) -> Files {
    fn visit(directory: &Path, root: &Path, skip: &Path, out: &mut Files) {
        let Ok(entries) = mixdog_fsio::read_dir(&Unlaned, directory) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path == skip {
                continue;
            }
            let name = path.strip_prefix(root).unwrap_or(&path).display().to_string().replace('\\', "/");
            match entry.file_type(&Unlaned) {
                Ok(kind) if kind.is_dir() => {
                    out.push((format!("{name}/"), None));
                    visit(&path, root, skip, out);
                }
                Ok(kind) if kind.is_file() => {
                    if let Ok(bytes) = mixdog_fsio::read(&Unlaned, &path) {
                        out.push((name, Some(bytes)));
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    visit(root, root, skip, &mut out);
    out
}

/// What `after` has that `before` lacks or has otherwise (a folder is `{ dir: true }`), and `null` for what it lost.
fn difference(before: &Files, after: &Files, scrub: &Scrub) -> Map<String, Value> {
    let mut changed = Map::new();
    for (name, bytes) in after {
        let was = before.iter().find(|(held, _)| held == name).map(|(_, was)| was);
        match bytes {
            None if was.is_none() => {
                changed.insert(scrub.plain(name, false), json!({ "dir": true }));
            }
            Some(bytes) if was.is_none_or(|was| was.as_ref() != Some(bytes)) => {
                changed.insert(scrub.plain(name, false), fingerprint(bytes));
            }
            _ => {}
        }
    }
    for (name, _) in before {
        if !after.iter().any(|(held, _)| held == name) {
            changed.insert(scrub.plain(name, false), Value::Null);
        }
    }
    changed
}

fn side(change: &ChangeSide) -> Value {
    match change {
        ChangeSide::Absent => json!("absent"),
        ChangeSide::Uncaptured { .. } => json!("uncaptured"),
        ChangeSide::Bytes(bytes) => fingerprint(bytes),
    }
}

fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(200).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n recorded: {}\n produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

/// The names of the package parts at which two fingerprints differ.
fn parts_differing(recorded: &Value, produced: &Value, out: &mut Vec<String>) {
    if let (Some(left), Some(right)) = (recorded.get("zip").and_then(Value::as_array), produced.get("zip").and_then(Value::as_array)) {
        for part in left {
            match right.iter().find(|other| other[0] == part[0]) {
                Some(other) if other == part => {}
                Some(_) => out.push(format!("part {} differs", part[0])),
                None => out.push(format!("part {} is missing", part[0])),
            }
        }
        for part in right.iter().filter(|part| !left.iter().any(|other| other[0] == part[0])) {
            out.push(format!("part {} is extra", part[0]));
        }
    }
}

/// The first places two recordings of a value differ.
fn summary(recorded: &Value, produced: &Value) -> String {
    let found = twin::differences(recorded, produced);
    let mut parts = Vec::new();
    match (recorded, produced) {
        (Value::Object(left), Value::Object(right)) => {
            for (name, print) in left {
                if let Some(other) = right.get(name) {
                    parts_differing(print, other, &mut parts);
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            for (one, other) in left.iter().zip(right) {
                for side in ["before", "after"] {
                    parts_differing(&one[side], &other[side], &mut parts);
                }
            }
        }
        _ => {}
    }
    format!("{} difference(s), e.g. {}{}", found.len(), found.iter().take(3).cloned().collect::<Vec<_>>().join("; "), if parts.is_empty() { String::new() } else { format!(" [{}]", parts.join(", ")) })
}

fn first_session(raw: &str) -> String {
    SESSION.find(raw).map_or_else(|| "<none>".to_owned(), |found| raw[found].to_owned())
}

// ---- the replay -----------------------------------------------------------------------------------------------------------------

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime")
}

/// Replays one scenario through `Engine::execute`; answers what differs from the recording.
fn replay_scenario(scenario: &Value, runtime: &tokio::runtime::Runtime) -> Vec<String> {
    let name = text(&scenario["name"]).to_owned();
    let mut failures = Vec::new();
    let root = tempfile::tempdir().expect("temp dir");
    let dir = root.path().to_path_buf();
    let layout = &scenario["layout"];
    let cwd = layout["cwd"].as_str().filter(|folder| !folder.is_empty()).map_or_else(|| dir.clone(), |folder| dir.join(folder));
    let data = dir.join(layout["data"].as_str().unwrap_or("mixdog-data"));
    for folder in [&cwd, &data] {
        mixdog_fsio::create_dir_all(&Unlaned, folder).expect("folder");
    }
    let engine = Engine::new(TestPlatform::new(&dir, &data));
    let scrub = Scrub::new(&dir, &data);
    let mut last = String::new();
    for (number, call) in scenario["calls"].as_array().expect("calls").iter().enumerate() {
        let at = format!("{name}, call {number} ({})", call["args"]["action"]);
        for file in call.get("removed").and_then(Value::as_array).into_iter().flatten() {
            let target = cwd.join(text(file));
            let _ = if text(file).ends_with('/') { mixdog_fsio::remove_dir_all(&Unlaned, target) } else { mixdog_fsio::remove_file(&Unlaned, target) };
        }
        for (file, content) in call.get("seeds").and_then(Value::as_object).into_iter().flatten() {
            let target = cwd.join(file);
            if content.get("dir") == Some(&Value::Bool(true)) {
                mixdog_fsio::create_dir_all(&Unlaned, &target).expect("seed folder");
                continue;
            }
            if let Some(parent) = target.parent() {
                mixdog_fsio::create_dir_all(&Unlaned, parent).expect("seed folder");
            }
            let bytes = match content.get("text") {
                Some(held) => text(held).as_bytes().to_vec(),
                None => base64_bytes(text(&content["base64"])),
            };
            mixdog_fsio::write(&Unlaned, &target, bytes).expect("seed file");
        }
        let before = walk(&cwd, &data);
        let args = restored(&call["args"], &scrub, &first_session(&last));
        let cancel = CancellationToken::new();
        let cancelled = call.get("cancelled") == Some(&Value::Bool(true));
        if cancelled {
            cancel.cancel();
        }
        let ledger = Arc::new(CallLedger::new(&cwd, &data).expect("ledger"));
        let (result, changes) = runtime.block_on(engine.execute(args, cwd.clone(), Some(data.clone()), Some(ledger), cancel));
        let content = result["content"].as_array().expect("content");
        let produced = text(&content[0]["text"]).to_owned();
        if !cancelled {
            last.clone_from(&produced);
        }
        let scrubbed = scrub.answer(&produced);
        let recorded = text(&call["text"]);
        if scrubbed != recorded {
            failures.push(format!("{at}: the answer differs from the recording {}", first_difference(recorded, &scrubbed)));
            continue;
        }
        if (result.get("isError") == Some(&Value::Bool(true))) != (call["isError"] == json!(true)) {
            failures.push(format!("{at}: whether the answer is an error"));
        }
        if content.len() - 1 != call["images"].as_u64().expect("images") as usize {
            failures.push(format!("{at}: the image blocks"));
        }
        let fresh = Value::Object(scrub.fresh.borrow().clone());
        let recorded_fresh = call.get("cursors").cloned().unwrap_or_else(|| json!({}));
        if fresh != recorded_fresh {
            failures.push(format!("{at}: the cursors it introduces: recorded {recorded_fresh}, produced {fresh}"));
        }
        let writes: Vec<Value> = changes.iter().map(|change| json!({ "path": scrub.plain(&change.path.display().to_string(), false), "before": side(&change.before), "after": side(&change.after) })).collect();
        if Value::Array(writes.clone()) != call["writes"] {
            failures.push(format!("{at}: the write receipts differ: {}", summary(&call["writes"], &Value::Array(writes))));
        }
        let disk = Value::Object(difference(&before, &walk(&cwd, &data), &scrub));
        if disk != call["disk"] {
            failures.push(format!("{at}: the files the call changed differ: {}", summary(&call["disk"], &disk)));
        }
    }
    failures
}

#[test]
fn every_scenario_equals_the_recording() {
    let golden = twin::load_golden("office-dispatch");
    let scenarios = golden["scenarios"].as_array().expect("scenarios").clone();
    assert!(scenarios.len() >= 60, "the recording lost scenarios");
    let runtime = runtime();
    let mut failures = Vec::new();
    for scenario in &scenarios {
        failures.extend(replay_scenario(scenario, &runtime));
    }
    assert!(failures.is_empty(), "{} calls differ from the recording:\n{}", failures.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn the_recording_holds_the_cases_of_the_contract_tests() {
    let golden = twin::load_golden("office-dispatch");
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    let sources: Vec<&str> = scenarios.iter().filter_map(|scenario| scenario["source"].as_str()).collect();
    for suite in ["hand-written", "office-runtime-contract.test.mjs", "office-runtime-design.test.mjs", "office-runtime-pdf-marks.test.mjs", "xlsx-portable-snapshot.test.mjs"] {
        assert!(sources.contains(&suite), "no recorded scenario of {suite}");
    }
    let calls: Vec<&Value> = scenarios.iter().flat_map(|scenario| scenario["calls"].as_array().expect("calls")).collect();
    let answers: Vec<&str> = calls.iter().filter_map(|call| call["text"].as_str()).collect();
    for expected in [
        "Error: session or path is required",
        "Error: attach does not support finalize:true; attach first, then use batch with finalize:true when closing the document is intended",
        "Error: create requires path or output",
        r#"{"ok":false,"code":"cancelled","message":"Office Use operation was cancelled","detail":"Office Use operation was cancelled"}"#,
    ] {
        assert!(answers.contains(&expected), "no recorded case for: {expected}");
    }
    assert!(answers.iter().any(|answer| answer.contains(r#""finalized":true"#)), "no recorded finalize that completed");
    assert!(answers.iter().any(|answer| answer.contains(r#""reason":"review_issues""#)), "no recorded finalize that held");
    assert!(calls.len() >= 250, "the recording lost calls: {}", calls.len());
    for left_out in golden["omitted"].as_array().expect("the scenarios the recorder left out") {
        assert!(text(&left_out["why"]).contains("pptxgenjs script"), "a scenario is left out for a reason other than the script runtime: {left_out}");
    }
    assert!(calls.iter().any(|call| call["writes"].as_array().is_some_and(|writes| !writes.is_empty())), "no recorded write receipt");
}

/// Twelve calls at once, each from a thread of its own: every call runs on a thread of its own and none waits for a lane thread
/// another call holds, so all answer.
#[test]
fn calls_made_together_all_answer() {
    let root = tempfile::tempdir().expect("temp dir");
    let dir = root.path().to_path_buf();
    let data = dir.join("mixdog-data");
    mixdog_fsio::create_dir_all(&Unlaned, &data).expect("folder");
    let engine = Engine::new(TestPlatform::new(&dir, &data));
    let answers = Arc::new(Mutex::new(Vec::new()));
    let threads: Vec<_> = (0..12)
        .map(|_| {
            let (engine, answers, dir, data) = (Arc::clone(&engine), Arc::clone(&answers), dir.clone(), data.clone());
            std::thread::spawn(move || {
                let (result, _) = runtime().block_on(engine.execute(json!({ "action": "describe", "format": "csv" }), dir, Some(data), None, CancellationToken::new()));
                answers.lock().expect("lock").push(result["content"][0]["text"].as_str().expect("text").to_owned());
            })
        })
        .collect();
    for thread in threads {
        thread.join().expect("a call's thread");
    }
    let answers = answers.lock().expect("lock");
    assert_eq!(answers.len(), 12);
    assert!(answers.iter().all(|answer| *answer == answers[0]), "the same call answered differently");
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_dispatch -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/index.mjs)"]
fn twin_live_dispatch() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-dispatch.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_scenario_equals_the_recording();
}
