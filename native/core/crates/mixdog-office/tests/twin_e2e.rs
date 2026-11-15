//! Twin test `e2e`: the Office tool end to end. `native/core/fixtures/office-e2e/scenarios.json` lists ordered call sequences (the cases
//! of the Office suites that need neither a live model nor Microsoft Office); `benchmarks/rust-core/recorders/record-office-e2e.mjs`
//! ran them through Node's `executeOfficeTool` inside the write ledger and wrote `golden.json`; this test runs the same calls through
//! `mixdog_office::engine::Engine::execute` and compares, per call, (1) the text of the answer (exactly, so key order is compared too),
//! whether it is an error and how many image blocks it carries (a refused call's error text is the text), (2) the receipts: the
//! workspace files the call's write routes changed with their state before and after, and per scenario (3) the files it names and
//! (4) with `data` the journal JSON of the data folder.
//!
//! What is normalised, and nothing else (the recorder applies the same rules; the list is also in its header):
//! - the call's folder is `<dir>`, the data folder `<data>`, the system temporary folder `<tmp>`, every separator a `/`;
//! - session ids and transaction ids are numbered in the order they appear in a scenario; a `"nextCursor"` (base64 of JSON that names the
//!   session) is shown as its decoded JSON with its ids numbered;
//! - every `"<name>Ms":<number>` is 0 (durations) and a `"reviewToken":"<value>"` is `"reviewToken":"<token>"` (the token itself is carried
//!   to the next call unchanged);
//! - `.mixdog-backup-<uuid>` and the uuid of a transaction checkpoint name;
//! - in a zip the `dcterms:created` and `dcterms:modified` values of `docProps/core.xml` and `docProps/app.xml`; a zip is compared by its
//!   entry names (in order) and the sha256 of each entry's uncompressed bytes, never by its compressed bytes;
//! - in a data-folder JSON file, ISO timestamps and the numbers under keys that end in `At`, `Ms` or `Time`.
//!
//! The wall time of every scenario is recorded by Node. A release build of this test fails when the total here is longer than Node's
//! (nothing is made slower); a debug build prints both and does not compare them, since an unoptimised build says nothing of speed.
//! Every difference is listed with its scenario and call; the test fails once, at the end, with all of them.
//! Re-recording is `twin_live_e2e` (ignored: it runs Node).

use std::cell::RefCell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mixdog_core_api::domain::ext::{BrowserEndpoint, BrowserHold};
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_js::JsRegex;
use mixdog_office::batch::BatchHost;
use mixdog_office::engine::{Engine, Platform};
use mixdog_office_author::brief::{html_brief_script, parse_authoring_brief, review_fact_coverage, review_source_grounding};
use mixdog_office_base::ledger::{CallLedger, ChangeSide, FileChange};
use mixdog_office_base::twin;
use mixdog_office_com::{OfficeCom, OfficeComConfig};
use mixdog_office_design::library::{Environment, Fetch, FetchRequest, FetchResponse, TemplateIndexer};
use mixdog_office_design::templates::OfficeTemplateIndexer;
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_quality::document_brief::BriefReadings;
use mixdog_ooxml::ooxml_validator::Environment as ValidatorEnvironment;
use mixdog_ooxml::zipio::Package;
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken, LaneTokens, MaintenanceIo};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

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

// ---- the platform: what a process supplies to the engine ------------------------------------------------------------------

/// The brief parser and readings of the authoring crate.
struct Briefs;

impl BriefReadings for Briefs {
    fn html_brief_script(&self, html: &str) -> String {
        html_brief_script(html)
    }

    fn parse_authoring_brief(&self, script: &str) -> Value {
        parse_authoring_brief(script)
    }

    fn review_fact_coverage(&self, document: &Value, brief: &Value) -> Vec<Value> {
        review_fact_coverage(document, brief)
    }

    fn review_source_grounding(&self, brief: &Value) -> Vec<Value> {
        review_source_grounding(brief)
    }
}

/// The machine of a batch: no Word chart is drawn here (a picture of a chart needs the renderer), and no scenario asks for one.
struct Machinery;

impl BatchHost for Machinery {
    fn pdf_operations(&self, _data_dir: &Path, cancel: Option<CancellationToken>) -> ContentOperations {
        ContentOperations::new(FontEnv::host(), SvgFonts::none(), None, cancel)
    }

    fn chart_picture(&self, _block: &Value, _width: f64, _pdf: &Path) -> impl Future<Output = Result<String, String>> {
        async { Err("the twin draws no Word chart".to_owned()) }
    }

    fn brief_readings(&self) -> &dyn BriefReadings {
        &Briefs
    }
}

struct NoNetwork;

impl Fetch for NoNetwork {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        Err(format!("the script has no network: {}", request.url))
    }
}

/// No browser is launched: nothing in the scenarios draws a page through one.
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

struct World {
    tokens: LaneTokens,
    office: OfficeCom,
    fonts: Arc<FontRegistry>,
    font_env: FontEnv,
    svg_fonts: SvgFonts,
    environment: Environment,
    validator: ValidatorEnvironment,
    machinery: Machinery,
}

impl Platform for World {
    type Batch = Machinery;

    fn lanes(&self) -> LaneTokens {
        self.tokens.clone()
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

    fn indexer(&self) -> &dyn TemplateIndexer<mixdog_fsio::Unlaned> {
        &OfficeTemplateIndexer
    }

    fn validator(&self) -> &ValidatorEnvironment {
        &self.validator
    }

    fn batch_host(&self) -> &Machinery {
        &self.machinery
    }
}

fn world(dir: &Path, data: &Path) -> World {
    let tokens = mixdog_rt::testing::tokens();
    World {
        office: OfficeCom::new(OfficeComConfig::new(data.to_path_buf(), tokens.clone())),
        tokens,
        fonts: Arc::new(FontRegistry::new()),
        font_env: FontEnv::host(),
        svg_fonts: SvgFonts::none(),
        // Node reads the design library's environment from the process (the template folders of an Office installation, the user's
        // own, MIXDOG_OFFICE_TEMPLATE_DIRS and the pack settings) and its packaged templates beside its source; the same files are the
        // assets of mixdog-office-design.
        environment: Environment {
            cwd: dir.to_path_buf(),
            bundled_templates: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mixdog-office-design/assets/templates"),
            now_ms: Arc::new(|| CLOCK),
            ..Environment::process()
        },
        // The recorder sets MIXDOG_OOXML_VALIDATOR_DISABLED before it loads the tool.
        validator: ValidatorEnvironment { disabled: true, ..ValidatorEnvironment::from_process() },
        machinery: Machinery,
    }
}

// ---- naming what a run leaves ---------------------------------------------------------------------------------------------

static TRANSACTION: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"office_tx_[0-9a-f]{16}", "g"));
static SESSION: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"office_[0-9a-f]{16}", "g"));
static CURSOR: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r#""nextCursor":"([A-Za-z0-9+/=_-]+)""#, "g"));
static DURATION: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r#""([A-Za-z]+Ms)":\d+(\.\d+)?"#, "g"));
static TOKEN: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r#""reviewToken":"[^"]*""#, "g"));
static BACKUP: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"\.mixdog-backup-[0-9a-f-]{32,36}", "g"));
static CHECKPOINT: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"(mixdog-office-transaction-[A-Za-z0-9_<> ]+)-[0-9a-f-]{32,36}", "g"));
static STAMP: std::sync::LazyLock<JsRegex> =
    std::sync::LazyLock::new(|| JsRegex::new_static(r"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:(?:created|modified)>)", "g"));
static ISO_TIME: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", "g"));

/// The parts the recorder's `STAMPED` set names: their timestamps are the run's.
const STAMPED: [&str; 2] = ["docProps/core.xml", "docProps/app.xml"];

/// Standard or URL-safe base64 to text (what `Buffer.from(text, 'base64').toString('utf8')` makes of it).
fn decode_base64(encoded: &str) -> String {
    let mut bits = 0u32;
    let mut have = 0;
    let mut out = Vec::new();
    for byte in encoded.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        have += 6;
        if have >= 8 {
            have -= 8;
            out.push(u8::try_from((bits >> have) & 0xff).expect("a byte"));
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).expect("hex")).collect()
}

/// What the recorder's `scrub` does.
struct Scrub {
    dir: PathBuf,
    data: PathBuf,
    sessions: RefCell<Vec<String>>,
    transactions: RefCell<Vec<String>>,
}

impl Scrub {
    fn new(dir: &Path, data: &Path) -> Self {
        Self { dir: dir.to_path_buf(), data: data.to_path_buf(), sessions: RefCell::new(Vec::new()), transactions: RefCell::new(Vec::new()) }
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

    fn number(list: &RefCell<Vec<String>>, id: &str, label: &str) -> String {
        let mut known = list.borrow_mut();
        let at = known.iter().position(|held| held == id).unwrap_or_else(|| {
            known.push(id.to_owned());
            known.len() - 1
        });
        format!("<{label} {}>", at + 1)
    }

    fn ids(&self, input: &str) -> String {
        let out = TRANSACTION.replace_all_with(input, |found| Self::number(&self.transactions, found.get(0).unwrap_or(""), "tx"));
        SESSION.replace_all_with(&out, |found| Self::number(&self.sessions, found.get(0).unwrap_or(""), "session"))
    }

    fn apply(&self, input: &str) -> String {
        let mut out = Self::named(input.to_owned(), &self.data, "<data>");
        out = Self::named(out, &self.dir, "<dir>");
        let temporary = std::env::temp_dir();
        out = Self::named(out, Path::new(temporary.display().to_string().trim_end_matches(['\\', '/'])), "<tmp>");
        out = CURSOR.replace_all_with(&out, |found| format!("\"nextCursor\":\"<cursor {}>\"", self.ids(&decode_base64(found.get(1).unwrap_or("")))));
        out = self.ids(&out);
        out = DURATION.replace_all_with(&out, |found| format!("\"{}\":0", found.get(1).unwrap_or("")));
        out = TOKEN.replace_all_with(&out, |_| r#""reviewToken":"<token>""#.to_owned());
        out = BACKUP.replace_all_with(&out, |_| ".mixdog-backup-<uuid>".to_owned());
        out = CHECKPOINT.replace_all_with(&out, |found| format!("{}-<uuid>", found.get(1).unwrap_or("")));
        out.replace("\\\\", "/").replace('\\', "/")
    }
}

fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(200).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n    recorded: {}\n    produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

/// One file's bytes as the recorder's `describeBytes` states them: a zip by its entries, anything else exactly.
fn describe_bytes(bytes: &[u8], scrub: &Scrub) -> Value {
    if bytes.starts_with(b"PK\x03\x04") {
        let package = match Package::load(bytes) {
            Ok(package) => package,
            Err(reason) => return json!({ "unreadable zip": reason }),
        };
        let mut entries = Vec::new();
        for name in package.names() {
            if name.ends_with('/') {
                entries.push(json!({ "name": name, "dir": true }));
                continue;
            }
            let raw = package.file(&name).expect("an entry the package lists").to_vec();
            let settled = if STAMPED.contains(&name.as_str()) {
                STAMP.replace_all_with(&String::from_utf8_lossy(&raw), |found| format!("{}<timestamp>{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))).into_bytes()
            } else {
                raw.clone()
            };
            entries.push(json!({ "name": name, "size": raw.len(), "sha256": hex(&Sha256::digest(&settled)) }));
        }
        return json!({ "zip": entries });
    }
    let mut state = Map::new();
    state.insert("bytes".to_owned(), Value::from(bytes.len()));
    state.insert("sha256".to_owned(), Value::from(hex(&Sha256::digest(bytes))));
    if bytes.len() <= 2000
        && let Ok(readable) = std::str::from_utf8(bytes)
        && !readable.contains('\0')
    {
        state.insert("text".to_owned(), Value::from(scrub.apply(readable)));
    }
    Value::Object(state)
}

fn describe_side(side: &ChangeSide, scrub: &Scrub) -> Value {
    match side {
        ChangeSide::Absent => Value::Null,
        ChangeSide::Bytes(bytes) => describe_bytes(bytes, scrub),
        ChangeSide::Uncaptured { size, reason } => json!({ "omitted": true, "size": size, "reason": reason }),
    }
}

fn receipts(changes: &[FileChange], docs: &Path, scrub: &Scrub) -> Value {
    Value::Array(
        changes
            .iter()
            .map(|change| {
                let relative = change.path.strip_prefix(docs).unwrap_or(&change.path).display().to_string();
                json!({
                    "path": scrub.apply(&relative.replace('\\', "/")),
                    "before": describe_side(&change.before, scrub),
                    "after": describe_side(&change.after, scrub),
                })
            })
            .collect(),
    )
}

/// The recorder's `settleJournal`.
fn settle_journal(value: &Value, key: &str) -> Value {
    match value {
        Value::String(word) => Value::String(ISO_TIME.replace_all_with(word, |_| "<timestamp>".to_owned())),
        Value::Number(_) if ["At", "Ms", "Time"].iter().any(|suffix| key.ends_with(suffix)) => Value::from(0),
        Value::Array(items) => Value::Array(items.iter().map(|item| settle_journal(item, key)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(name, item)| (name.clone(), settle_journal(item, name))).collect()),
        other => other.clone(),
    }
}

fn data_files(data: &Path, scrub: &Scrub, lane: &InLane<DurabilityIo>) -> Value {
    fn walk(folder: &Path, lane: &InLane<DurabilityIo>, out: &mut Vec<PathBuf>) {
        let Ok(entries) = mixdog_fsio::read_dir(lane, folder) else { return };
        for entry in entries.flatten() {
            let full = entry.path();
            if mixdog_fsio::is_dir(lane, &full) {
                walk(&full, lane, out);
            } else {
                out.push(full);
            }
        }
    }
    let mut files = Vec::new();
    walk(data, lane, &mut files);
    let mut listed: Vec<(String, Value)> = files
        .iter()
        .map(|full| {
            let relative = full.strip_prefix(data).unwrap_or(full).display().to_string().replace('\\', "/");
            let name = scrub.apply(&relative);
            let entry = if full.extension().is_some_and(|extension| extension == "json") {
                match mixdog_fsio::read_to_string(lane, full).ok().and_then(|body| serde_json::from_str::<Value>(&body).ok()) {
                    Some(parsed) => json!({ "name": name, "json": scrub.apply(&serde_json::to_string(&settle_journal(&parsed, "")).expect("json")) }),
                    None => json!({ "name": name, "unreadable": true }),
                }
            } else {
                json!({ "name": name })
            };
            (name, entry)
        })
        .collect();
    listed.sort_by(|left, right| left.0.cmp(&right.0));
    Value::Array(listed.into_iter().map(|(_, entry)| entry).collect())
}

/// `args` with the placeholders put: `<session>` is the latest session id any answer named, `<session:NAME>` the one a call marked `as:NAME`
/// named, `<reviewToken>` the latest review token.
fn with_placeholders(args: &Value, latest: &str, token: &str, named: &std::collections::HashMap<String, String>) -> Value {
    match args {
        Value::String(word) if word == "<session>" => Value::String(latest.to_owned()),
        Value::String(word) if word == "<reviewToken>" => Value::String(token.to_owned()),
        Value::String(word) if word.starts_with("<session:") && word.ends_with('>') => {
            Value::String(named.get(&word["<session:".len()..word.len() - 1]).cloned().unwrap_or_else(|| "<none>".to_owned()))
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| with_placeholders(item, latest, token, named)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (key.clone(), with_placeholders(value, latest, token, named))).collect()),
        other => other.clone(),
    }
}

fn first_match(pattern: &JsRegex, raw: &str) -> Option<String> {
    pattern.find(raw).map(|found| raw[found].to_owned())
}

/// Puts a scenario's `setup` files in the call's folder.
fn put_setup(scenario: &Value, docs: &Path, lane: &InLane<DurabilityIo>) {
    for entry in scenario.get("setup").and_then(Value::as_array).into_iter().flatten() {
        let full = docs.join(text(&entry["file"]));
        if let Some(parent) = full.parent() {
            mixdog_fsio::create_dir_all(lane, parent).expect("folder");
        }
        let bytes = if let Some(zip) = entry.get("zip").and_then(Value::as_object) {
            let mut package = Package::new();
            for (name, body) in zip {
                package.set(name, text(body).as_bytes().to_vec());
            }
            package.generate().expect("the setup zip")
        } else if let Some(hex_text) = entry.get("hex").and_then(Value::as_str) {
            from_hex(hex_text)
        } else {
            text(&entry["text"]).as_bytes().to_vec()
        };
        mixdog_fsio::write(lane, &full, bytes).expect("setup file");
    }
}

/// Replays one scenario; answers what differs from the recording and the wall time of its calls.
fn replay_scenario(scenario: &Value, recorded: &Value) -> (Vec<String>, Duration) {
    let name = text(&scenario["name"]).to_owned();
    let directory = tempfile::tempdir().expect("temp dir");
    let dir = directory.path().to_path_buf();
    let (docs, data) = (dir.join("docs"), dir.join("data"));
    {
        let (docs, data, scenario) = (docs.clone(), data.clone(), scenario.clone());
        on_lane(move |lane| {
            for folder in [&docs, &data] {
                mixdog_fsio::create_dir_all(lane, folder).expect("folder");
            }
            put_setup(&scenario, &docs, lane);
        });
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let engine = runtime.block_on(async { Engine::new(world(&dir, &data)) });
    let scrub = Scrub::new(&dir, &data);
    let mut found = Vec::new();
    let (mut latest, mut token) = ("<none>".to_owned(), "<none>".to_owned());
    let mut named = std::collections::HashMap::new();
    let recorded_calls = recorded["calls"].as_array().expect("calls");
    let calls = scenario["calls"].as_array().expect("calls");
    if recorded_calls.len() != calls.len() {
        found.push(format!("{name}: the recording holds {} calls, the scenario {}: record again", recorded_calls.len(), calls.len()));
        return (found, Duration::ZERO);
    }
    let started = Instant::now();
    for (number, call) in calls.iter().enumerate() {
        let at = format!("{name}, call {number} ({})", call["args"]["action"]);
        let given = with_placeholders(&call["args"], &latest, &token, &named);
        let cancel = CancellationToken::new();
        let cancelled = call.get("cancelled") == Some(&Value::Bool(true));
        if cancelled {
            cancel.cancel();
        }
        let ledger = Arc::new(CallLedger::new(&docs, &data).expect("ledger"));
        let (result, changes) = runtime.block_on(engine.execute(given, docs.clone(), Some(data.clone()), Some(ledger), cancel));
        let content = result["content"].as_array().expect("content");
        let produced = text(&content[0]["text"]).to_owned();
        if !cancelled && let Some(id) = first_match(&SESSION, &produced) {
            latest = id;
        }
        if let Some(found_token) = TOKEN_VALUE.captures(&produced).and_then(|groups| groups.get(1).map(str::to_owned)) {
            token = found_token;
        }
        if let Some(label) = call.get("as").and_then(Value::as_str) {
            named.insert(label.to_owned(), first_match(&SESSION, &produced).unwrap_or_else(|| "<none>".to_owned()));
        }
        // The recorder describes the receipts before it scrubs the text: ids are numbered in that order.
        let produced_receipts = receipts(&changes, &docs, &scrub);
        let scrubbed = scrub.apply(&produced);
        let want = &recorded_calls[number];
        let want_text = text(&want["text"]);
        if scrubbed != want_text {
            found.push(format!("{at}: the answer differs from the recording {}", first_difference(want_text, &scrubbed)));
        }
        let is_error = result.get("isError") == Some(&Value::Bool(true));
        if is_error != (want["isError"] == json!(true)) {
            found.push(format!("{at}: isError is {is_error}, recorded {}", want["isError"]));
        }
        if content.len() - 1 != want["images"].as_u64().expect("images") as usize {
            found.push(format!("{at}: {} image blocks, recorded {}", content.len() - 1, want["images"]));
        }
        let receipt_differences = twin::differences(&want["receipts"], &produced_receipts);
        if !receipt_differences.is_empty() {
            found.push(format!("{at}: the receipts differ: {}", receipt_differences.iter().take(6).cloned().collect::<Vec<_>>().join("; ")));
        }
    }
    let elapsed = started.elapsed();
    drop(engine);
    // Files and the data folder, after the last call.
    let (outputs, with_data) = (scenario["outputs"].as_array().cloned().unwrap_or_default(), scenario.get("data") == Some(&Value::Bool(true)));
    let (docs_after, data_after, scrub_after) = (docs.clone(), data.clone(), scrub);
    let (produced_files, produced_data) = on_lane(move |lane| {
        let mut files = Map::new();
        for output in &outputs {
            let file = text(output).to_owned();
            let state = match mixdog_fsio::read(lane, docs_after.join(&file)) {
                Ok(bytes) => describe_bytes(&bytes, &scrub_after),
                Err(_) => Value::Null,
            };
            files.insert(file, state);
        }
        (Value::Object(files), with_data.then(|| data_files(&data_after, &scrub_after, lane)))
    });
    let file_differences = twin::differences(&recorded["files"], &produced_files);
    if !file_differences.is_empty() {
        found.push(format!("{name}: the written files differ: {}", file_differences.iter().take(8).cloned().collect::<Vec<_>>().join("; ")));
    }
    if let Some(produced_data) = produced_data {
        let data_differences = twin::differences(&recorded["data"], &produced_data);
        if !data_differences.is_empty() {
            found.push(format!("{name}: the data folder's journal differs: {}", data_differences.iter().take(8).cloned().collect::<Vec<_>>().join("; ")));
        }
    }
    (found, elapsed)
}

static TOKEN_VALUE: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r#""reviewToken":"([^"]*)""#, ""));

fn scenarios() -> Vec<Value> {
    let path = twin::repo_root().join("native/core/fixtures/office-e2e/scenarios.json");
    let body = on_lane({
        let path = path.clone();
        move |lane| mixdog_fsio::read_to_string(lane, &path)
    })
    .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let parsed: Value = serde_json::from_str(&body).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    parsed["scenarios"].as_array().expect("scenarios").clone()
}

#[test]
fn every_scenario_equals_the_recording() {
    let golden = twin::load_golden("office-e2e");
    let recorded = golden["scenarios"].as_array().expect("scenarios").clone();
    let scenarios = scenarios();
    assert_eq!(recorded.len(), scenarios.len(), "the recording and scenarios.json hold different scenarios: record again");
    let mut found = Vec::new();
    let mut total = Duration::ZERO;
    for (scenario, want) in scenarios.iter().zip(&recorded) {
        assert_eq!(scenario["name"], want["name"], "the recording is of other scenarios: record again");
        let (differences, elapsed) = replay_scenario(scenario, want);
        total += elapsed;
        found.extend(differences);
    }
    let node_ms = golden["totalMs"].as_f64().expect("totalMs");
    let rust_ms = total.as_secs_f64() * 1000.0;
    println!("wall time of the calls: Rust {rust_ms:.0} ms, Node {node_ms:.0} ms");
    assert!(found.is_empty(), "{} differences from the recording:\n{}", found.len(), found.join("\n"));
    if !cfg!(debug_assertions) {
        assert!(rust_ms <= node_ms, "the Rust engine took {rust_ms:.0} ms for the scenarios, Node {node_ms:.0} ms: nothing may be made slower");
    }
}

#[test]
fn the_recording_holds_the_scenarios_and_their_calls() {
    let golden = twin::load_golden("office-e2e");
    let recorded = golden["scenarios"].as_array().expect("scenarios");
    for (scenario, want) in scenarios().iter().zip(recorded) {
        assert_eq!(scenario["name"], want["name"]);
        let calls: Vec<&Value> = scenario["calls"].as_array().expect("calls").iter().map(|call| &call["args"]).collect();
        let heard: Vec<&Value> = want["calls"].as_array().expect("calls").iter().map(|call| &call["args"]).collect();
        assert_eq!(calls, heard, "{}: the recorded calls are not the scenario's", text(&scenario["name"]));
    }
    let answers: Vec<&str> = recorded.iter().flat_map(|scenario| scenario["calls"].as_array().expect("calls")).filter_map(|call| call["text"].as_str()).collect();
    for expected in ["Error: session or path is required", "Error: Unknown or closed Office Use session: office_missing", "Error: Unsupported Office mode: unsupported-mode"] {
        assert!(answers.contains(&expected), "no recorded case for: {expected}");
    }
    assert!(answers.iter().any(|answer| answer.contains(r#""finalized":true"#)), "no recorded finalize that completed");
}

#[test]
fn the_normalisations_hide_only_what_differs_from_run_to_run() {
    let scrub = Scrub::new(Path::new("/work/dir"), Path::new("/work/data"));
    let cursor = "eyJ2IjoxLCJzZXNzaW9uIjoib2ZmaWNlXzAxMjM0NTY3ODlhYmNkZWYifQ";
    let raw = format!(
        r#"{{"session":"office_0123456789abcdef","tx":"office_tx_fedcba9876543210","parseMs":12.5,"reviewToken":"abc","nextCursor":"{cursor}","path":"/work/dir/docs/a.docx","kept":"1.5"}}"#
    );
    let scrubbed = scrub.apply(&raw);
    assert_eq!(decode_base64(cursor), r#"{"v":1,"session":"office_0123456789abcdef"}"#);
    assert_eq!(
        scrubbed,
        r#"{"session":"<session 1>","tx":"<tx 1>","parseMs":0,"reviewToken":"<token>","nextCursor":"<cursor {"v":1,"session":"<session 1>"}>","path":"<dir>/docs/a.docx","kept":"1.5"}"#
    );
    // Something that is not a duration, a token, an id or a folder is left as written.
    assert_eq!(scrub.apply(r#"{"note":"other 42","count":3}"#), r#"{"note":"other 42","count":3}"#);
}

#[test]
fn a_zip_is_described_by_its_entries_with_the_stamps_of_the_run_settled() {
    let scrub = Scrub::new(Path::new("/work/dir"), Path::new("/work/data"));
    let build = |stamp: &str| {
        let mut package = Package::new();
        package.set("docProps/core.xml", format!("<cp><dcterms:created xsi:type=\"dcterms:W3CDTF\">{stamp}</dcterms:created></cp>").into_bytes());
        package.set("word/document.xml", b"<w:document/>".to_vec());
        package.generate().expect("zip")
    };
    assert_eq!(describe_bytes(&build("2023-11-14T22:13:20Z"), &scrub), describe_bytes(&build("2030-01-01T00:00:00Z"), &scrub));
    let changed = {
        let mut package = Package::new();
        package.set("docProps/core.xml", b"<cp/>".to_vec());
        package.set("word/document.xml", b"<w:document>text</w:document>".to_vec());
        package.generate().expect("zip")
    };
    assert_ne!(describe_bytes(&build("2023-11-14T22:13:20Z"), &scrub), describe_bytes(&changed, &scrub));
}

#[test]
fn the_journal_settles_timestamps_and_nothing_else() {
    let settled = settle_journal(&json!({ "startedAt": 1_700_000_000_000_u64, "phase": "active", "at": "2023-11-14T22:13:20.000Z", "count": 3, "steps": [{ "durationMs": 9, "id": 4 }] }), "");
    assert_eq!(settled, json!({ "startedAt": 0, "phase": "active", "at": "<timestamp>", "count": 3, "steps": [{ "durationMs": 0, "id": 4 }] }));
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_e2e -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/index.mjs)"]
fn twin_live_e2e() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-e2e.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_scenario_equals_the_recording();
}
