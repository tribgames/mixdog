//! `portable/portable-soffice.mjs`: the driver of the LibreOffice program (it stays an external program). It finds the program
//! (soffice.com on Windows, PATH, the folders each system's installers use, Flatpak, the Windows registry), runs headless
//! conversions in one private profile with every macro off, and builds on them: rendering a document to PDF or PNG, recalculating
//! a workbook and reading the computed values back, validating that a file reopens, and converting a legacy `.doc` / `.xls` /
//! `.ppt` file to its package beside the original (never overwriting it).
//!
//! One profile means one LibreOffice at a time: a second process sharing it either fails outright or blocks until the first exits,
//! so conversions run in the order they were requested. A conversion that failed drops the profile; the next one builds a clean
//! copy. The profile is removed by [`Soffice::shutdown`], which the process calls as it ends.
//!
//! The calls block the thread of the job that makes them (every file access takes the job's proof) and run the program on a
//! runtime of their own; a run is cancelled by setting the flag it was given.

pub mod args;
pub mod profile;
pub mod run;

use std::cell::Cell;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use mixdog_fonts::discovery::{HostEnv, Os};
use mixdog_fonts::provision::mac_office_font_dir;
use mixdog_fsio::{OpenOptions, WriteProof};
use mixdog_js::{JsRegex, js_trim};
use serde_json::{Map, Value, json};

pub use self::args::Host;
use self::args::{REGISTRY_QUERIES, candidates, convert_arguments, converted_output_path, mac_font_config, registry_soffice_programs};
use self::profile::{ProfileError, Profiles, make_temp_dir, redact_directories, remove_quietly, remove_scratch};
use self::run::{RunOptions, RunResult, block_on, command_exists, command_output, run_soffice_blocking};
use crate::cells::{computed_cell_values, iterate_sheet_cells, shared_strings, workbook_calculation, workbook_sheets, write_cached_values};
use crate::package::os_message;
use crate::xlsx_charts::refresh_chart_caches;
use crate::xml::xml_decode;
use crate::zipio::Package;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(5);
const RENDER_TIMEOUT: Duration = Duration::from_secs(120);
const CONVERT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ERROR_LOCATIONS: usize = 100;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Conversions in the order they asked: a ticket is taken on arrival and served in turn.
struct Queue {
    tickets: Mutex<(u64, u64)>,
    turn: Condvar,
}

struct Turn<'a>(&'a Queue);

impl Queue {
    fn enter(&self) -> Turn<'_> {
        let mut tickets = lock(&self.tickets);
        let mine = tickets.0;
        tickets.0 += 1;
        while tickets.1 != mine {
            tickets = self.turn.wait(tickets).unwrap_or_else(PoisonError::into_inner);
        }
        Turn(self)
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        lock(&self.0.tickets).1 += 1;
        self.0.turn.notify_all();
    }
}

/// What one headless conversion is asked to do.
struct Conversion<'a> {
    to: &'a str,
    out_dir: &'a Path,
    cancel: Option<&'a AtomicBool>,
    timeout: Duration,
    timeout_message: String,
    cancelled_message: &'a str,
}

/// How a legacy conversion failed: it was cancelled by the caller (an abort, not a conversion failure), or could not be done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConvertError {
    Aborted(String),
    Failed(String),
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Aborted(message) | Self::Failed(message) => f.write_str(message),
        }
    }
}

/// How a scratch folder is removed and what is said of one that stays; the driver's own when none is given.
#[derive(Default)]
pub struct ScratchHooks<'a> {
    pub remove: Option<&'a dyn Fn(&Path) -> std::io::Result<()>>,
    pub log: Option<&'a dyn Fn(&str)>,
}

/// `removeDirectoryWithRetry(dir, { remove, log })` with the hooks' removal and log where given: a busy folder is retried, a failure
/// that persists is logged and never raised.
pub fn remove_scratch_with<P: WriteProof>(proof: &P, dir: &Path, hooks: &ScratchHooks) {
    match hooks {
        ScratchHooks { remove: None, log: None } => remove_scratch(proof, dir),
        ScratchHooks { remove, log } => profile::remove_directory_with_retry(
            proof,
            dir,
            &|dir: &Path| match remove {
                Some(remove) => remove(dir),
                None => mixdog_fsio::remove_dir_all(proof, dir),
            },
            &|line: &str| match log {
                Some(log) => log(line),
                None => drop(std::io::stderr().write_all(line.as_bytes())),
            },
            Duration::from_millis(100),
        ),
    }
}

/// The picture a document is rendered to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderFormat {
    Pdf,
    /// The first page as a picture.
    Png,
}

impl RenderFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Png => "png",
        }
    }
}

/// Error cells of a recalculated workbook, by error type with their locations.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FormulaErrors {
    pub total: usize,
    pub by_type: Vec<(String, ErrorLocations)>,
    pub unparsed: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ErrorLocations {
    pub count: usize,
    pub cells: Vec<String>,
    pub truncated: usize,
}

static FORMULA_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<f(?:\s[^>]*)?>([\s\S]*?)<\/f>", ""));
static LOWER_FUNCTION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:^|[^A-Za-z0-9_.])[a-z][a-z0-9.]*\s*\(", ""));
static QUOTED_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#""(?:[^"]|"")*""#, "g"));
static ERROR_TYPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bt="e""#, ""));
static VALUE_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<v(?:\s[^>]*)?>([\s\S]*?)<\/v>", ""));
static SHEET_PART: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^xl\/worksheets\/sheet\d+\.xml$", "i"));
static CELL_BODY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<c\b[^>]*>([\s\S]*?)<\/c>", "gi"));
static FORMULA_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<f(?:\s[^>]*)?>", "i"));
static VALUE_PRESENT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<v(?:\s[^>]*)?>[\s\S]*?<\/v>|<v(?:\s[^>]*)?\/>", "i"));
static CACHED_FORMULA: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(<f\b[^>]*>[\s\S]*?<\/f>)\s*<v\b[^>]*>[\s\S]*?<\/v>", "g"));
static CALC_PR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<calcPr\b([^>]*?)\/?>", "i"));
static TRAILING_SLASH: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\/\s*$", ""));
static FULL_CALC: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\s*\bfullCalcOnLoad="[^"]*""#, "i"));
static FORCE_FULL_CALC: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\s*\bforceFullCalc="[^"]*""#, "i"));
static EXTERNAL_LINK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^xl\/externalLinks\/", "i"));

/// `workbookFormulaErrors(zip)`: error cells after a recalculation, tallied by error type with their locations, so the caller can
/// name what to fix instead of counting.
pub fn workbook_formula_errors(zip: &Package) -> FormulaErrors {
    let mut found = FormulaErrors::default();
    for sheet in workbook_sheets(zip) {
        let xml = zip.text(&sheet.path);
        for cell in iterate_sheet_cells(&xml) {
            let formula = FORMULA_TEXT.captures(cell.body).and_then(|caught| caught.get(1).map(str::to_owned)).unwrap_or_default();
            // LibreOffice writes every formula it parsed back in upper case; one it could not parse keeps a lower-case function
            // name beside its #NAME?.
            if !formula.is_empty() && LOWER_FUNCTION.is_match(&QUOTED_TEXT.replace_all_with(&formula, |_| "\"\"".to_owned())) && found.unparsed.len() < MAX_ERROR_LOCATIONS {
                found.unparsed.push(format!("{}!{}", sheet.name, cell.reference));
            }
            if !ERROR_TYPE.is_match(cell.attributes) {
                continue;
            }
            let value = xml_decode(&VALUE_TEXT.captures(cell.body).and_then(|caught| caught.get(1).map(str::to_owned)).unwrap_or_default());
            let value = js_trim(&value);
            if value.is_empty() {
                continue;
            }
            found.total += 1;
            let at = match found.by_type.iter().position(|(kind, _)| kind == value) {
                Some(at) => at,
                None => {
                    found.by_type.push((value.to_owned(), ErrorLocations::default()));
                    found.by_type.len() - 1
                }
            };
            let entry = &mut found.by_type[at].1;
            entry.count += 1;
            if entry.cells.len() < MAX_ERROR_LOCATIONS {
                entry.cells.push(format!("{}!{}", sheet.name, cell.reference));
            } else {
                entry.truncated += 1;
            }
        }
    }
    found
}

/// Formula cells in the workbook, and how many of them carry no cached value.
fn workbook_formula_counts(zip: &Package) -> (usize, usize) {
    let (mut formulas, mut missing) = (0, 0);
    for name in zip.files_matching(&SHEET_PART) {
        let xml = zip.text(&name);
        for cell in CELL_BODY.captures_iter(&xml) {
            let body = cell.get(1).unwrap_or("");
            if !FORMULA_OPEN.is_match(body) {
                continue;
            }
            formulas += 1;
            // An empty-string result is a value: Excel writes it as a self-closing <v/> on a t="str" cell.
            if !VALUE_PRESENT.is_match(body) {
                missing += 1;
            }
        }
    }
    (formulas, missing)
}

/// The mark an edit leaves says the values are stale. Once they have been calculated it comes off, or every later read pays for a
/// recalculation that has nothing left to do.
fn clear_forced_recalculation(xml: &str) -> String {
    let Some(found) = CALC_PR.captures(xml) else { return xml.to_owned() };
    let source = found.get(1).unwrap_or("");
    let strip = |pattern: &JsRegex, text: String| match pattern.find(&text) {
        Some(range) => format!("{}{}", &text[..range.start], &text[range.end..]),
        None => text,
    };
    let attributes = strip(&FORCE_FULL_CALC, strip(&FULL_CALC, strip(&TRAILING_SLASH, source.to_owned())));
    let range = found.range();
    format!("{}<calcPr{attributes}/>{}", &xml[..range.start], &xml[range.end..])
}

/// LibreOffice keeps a cached formula value exactly as it finds it and computes only the cells that have none: handing it an edited
/// workbook returned the answers from before the edit, which is how a corrected input still rendered its old number. Dropping the
/// cached values from the copy it is handed is what makes it calculate every formula: a full calculation, the way Excel would.
fn without_formula_cache(source: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut package = Package::load(&source)?;
    let stripped = Cell::new(0_usize);
    for name in package.files_matching(&SHEET_PART) {
        let xml = package.text(&name);
        let next = CACHED_FORMULA.replace_all_with(&xml, |found| {
            stripped.set(stripped.get() + 1);
            found.get(1).unwrap_or("").to_owned()
        });
        if next != xml {
            package.set(&name, next);
        }
    }
    if stripped.get() == 0 {
        return Ok(source);
    }
    package.generate()
}

/// The roundtrip is asked for values and nothing else. What LibreOffice writes back is its own reading of the workbook: its own
/// style table, where the authored faces came back on other cells, its own chart parts, its own widths and flags. Each computed value
/// is carried into the workbook as authored instead, each chart's copy of its cells is taken again from them, and the copy is dropped.
fn with_computed_values(original: &mut Package, produced: &Package) -> Result<Vec<u8>, String> {
    let strings = shared_strings(produced);
    let calculated: HashMap<String, String> = workbook_sheets(produced).into_iter().map(|sheet| (sheet.name, sheet.path)).collect();
    for sheet in workbook_sheets(original) {
        let Some(part) = calculated.get(&sheet.name) else { continue };
        let computed = computed_cell_values(&produced.text(part), &strings)?;
        if !computed.is_empty() {
            let written = write_cached_values(&original.text(&sheet.path), &computed);
            original.set(&sheet.path, written);
        }
    }
    refresh_chart_caches(original)?;
    let workbook = original.text("xl/workbook.xml");
    if !workbook.is_empty() {
        original.set("xl/workbook.xml", clear_forced_recalculation(&workbook));
    }
    original.generate()
}

fn read_error(error: &std::io::Error, path: &Path) -> String {
    os_message(error, "open", path)
}

/// The size of a file a conversion wrote, or 0 when it wrote nothing usable.
fn produced_file_size<P: WriteProof>(proof: &P, path: &Path) -> u64 {
    mixdog_fsio::metadata(proof, path).ok().filter(|details| details.is_file() && details.len() > 0).map_or(0, |details| details.len())
}

fn seconds(timeout: Duration) -> u64 {
    timeout.as_secs()
}

/// The driver: where LibreOffice is, its private profile and the queue conversions wait in.
pub struct Soffice {
    host: Host,
    program: Mutex<String>,
    profiles: Profiles,
    queue: Queue,
}

static PROCESS_DRIVER: LazyLock<Soffice> = LazyLock::new(|| Soffice::new(Host::process()));

impl Soffice {
    pub fn new(host: Host) -> Self {
        let profiles = Profiles::new(host.temp_dir.clone());
        Self { host, program: Mutex::new(String::new()), profiles, queue: Queue { tickets: Mutex::new((0, 0)), turn: Condvar::new() } }
    }

    /// The driver of this process: one profile and one queue for everything in it.
    pub fn process() -> &'static Self {
        &PROCESS_DRIVER
    }

    /// `sharedProfileDir()`: the private profile, built if there is none.
    pub fn profile_dir<P: WriteProof>(&self, proof: &P) -> Result<PathBuf, ProfileError> {
        self.profiles.shared_dir(proof)
    }

    /// Removes the private profile; the process calls it as it ends.
    pub fn shutdown<P: WriteProof>(&self, proof: &P) {
        self.profiles.remove_all(proof);
    }

    async fn find_program(&self) -> String {
        for candidate in candidates(&self.host) {
            if command_exists(&candidate, PROBE_TIMEOUT).await {
                return candidate;
            }
        }
        if self.host.os != Os::Windows {
            return String::new();
        }
        for (hive, view) in REGISTRY_QUERIES {
            let output = command_output("reg.exe", &["query", &format!("{hive}\\SOFTWARE\\LibreOffice\\UNO\\InstallPath"), "/ve", view], REGISTRY_TIMEOUT).await;
            for candidate in registry_soffice_programs(&output) {
                if command_exists(&candidate, PROBE_TIMEOUT).await {
                    return candidate;
                }
            }
        }
        String::new()
    }

    /// The program that answered, found once and shared by everything waiting on it. A program that answered stays found for the
    /// life of the driver; a negative answer is not remembered, because the user may install LibreOffice and retry without
    /// restarting the app.
    pub fn program(&self) -> Option<String> {
        let mut known = lock(&self.program);
        if known.is_empty()
            && let Ok(found) = block_on(self.find_program())
        {
            *known = found;
        }
        Some(known.clone()).filter(|program| !program.is_empty())
    }

    /// `libreOfficeAvailable()`: whether a LibreOffice front-end answers on this machine; portable rendering and recalculation need it.
    pub fn available(&self) -> bool {
        self.program().is_some()
    }

    /// Headless LibreOffice on macOS finds fonts through its bundled fontconfig, which names none of the Mac's font folders.
    fn font_environment<P: WriteProof>(&self, proof: &P, profile: &Path) -> Result<Vec<(String, String)>, String> {
        if self.host.os != Os::Mac {
            return Ok(Vec::new());
        }
        let file = profile.join("mixdog-fonts.conf");
        let env = HostEnv::current(&|name| self.host.variable(name).map(str::to_owned), &self.host.home);
        let office = mac_office_font_dir(proof, &env);
        mixdog_fsio::write(proof, &file, mac_font_config(&self.host.home, &profile.join("fontconfig-cache"), office.as_deref()))
            .map_err(|error| os_message(&error, "open", &file))?;
        Ok(vec![("FONTCONFIG_FILE".to_owned(), file.display().to_string())])
    }

    /// One headless conversion, queued behind the others. The profile is resolved inside the queue: a failed conversion ahead of this
    /// one discards it, and the path it used is gone by the time this one runs.
    fn convert<P: WriteProof>(&self, proof: &P, program: &str, input: &Path, job: &Conversion<'_>) -> Result<RunResult, String> {
        let _turn = self.queue.enter();
        let profile = self.profiles.shared_dir(proof).map_err(|error| error.message)?;
        let mut options = RunOptions::new(job.timeout, job.timeout_message.clone(), job.cancelled_message).cancelled_by(job.cancel);
        options.env = self.font_environment(proof, &profile)?;
        let result = run_soffice_blocking(program, &convert_arguments(&profile, job.to, job.out_dir, input), &options);
        match result {
            RunResult::Failed(error) => {
                self.profiles.discard(proof);
                // The profile is the converter's private folder; what it printed about it stays out of the error.
                Ok(RunResult::Failed(redact_directories(&error, &[&profile])))
            }
            done => Ok(done),
        }
    }

    /// Round-trips the workbook through LibreOffice in a scratch folder and returns the recalculated bytes, or the reason none came back.
    fn convert_workbook<P: WriteProof>(&self, proof: &P, program: &str, path: &Path, source: &[u8], cancel: Option<&AtomicBool>) -> Result<Result<Vec<u8>, String>, String> {
        let root = make_temp_dir(proof, &self.host.temp_dir, "mixdog-office-recalculate-").map_err(|error| os_message(&error, "mkdtemp", &self.host.temp_dir))?;
        let outcome = self.convert_workbook_in(proof, program, path, source, cancel, &root);
        remove_quietly(proof, &root);
        outcome
    }

    fn convert_workbook_in<P: WriteProof>(
        &self,
        proof: &P,
        program: &str,
        path: &Path,
        source: &[u8],
        cancel: Option<&AtomicBool>,
        root: &Path,
    ) -> Result<Result<Vec<u8>, String>, String> {
        let (input_dir, output_dir) = (root.join("input"), root.join("output"));
        for directory in [&input_dir, &output_dir] {
            mixdog_fsio::create_dir_all(proof, directory).map_err(|error| os_message(&error, "mkdir", directory))?;
        }
        let input = input_dir.join(path.file_name().unwrap_or_default());
        mixdog_fsio::write(proof, &input, source).map_err(|error| os_message(&error, "open", &input))?;
        let job = Conversion {
            to: "xlsx",
            out_dir: &output_dir,
            cancel,
            timeout: CONVERT_TIMEOUT,
            timeout_message: format!("Portable XLSX recalculation timed out after {} seconds", seconds(CONVERT_TIMEOUT)),
            cancelled_message: "Portable XLSX recalculation was cancelled",
        };
        if let RunResult::Failed(reason) = self.convert(proof, program, &input, &job)? {
            return Ok(Err(reason));
        }
        let generated = converted_output_path(&output_dir, path, "xlsx");
        if produced_file_size(proof, &generated) == 0 {
            return Ok(Err("LibreOffice produced no recalculated workbook.".to_owned()));
        }
        let recalculated = mixdog_fsio::read(proof, &generated).map_err(|error| read_error(&error, &generated))?;
        Ok(Ok(recalculated))
    }

    /// `recalculateLibreOfficeWorkbook(path, { force, signal })`: recalculates the workbook's formulas through LibreOffice and writes the
    /// computed values into the file as authored. The answer says whether it was needed, whether LibreOffice was there, and how it went.
    pub fn recalculate_workbook<P: WriteProof>(&self, proof: &P, path: &Path, force: bool, cancel: Option<&AtomicBool>) -> Result<Value, String> {
        let source = mixdog_fsio::read(proof, path).map_err(|error| read_error(&error, path))?;
        let mut zip = Package::load(&source)?;
        let (formula_count, missing_cached_values) = workbook_formula_counts(&zip);
        // A cached value is not a fresh one. Editing an input leaves every dependent formula's cache in place, so a workbook that was
        // written, closed, and reopened answered with the numbers from before the edit, and an error a guard had swallowed stayed
        // swallowed. The edit path marks the workbook for a full calculation, and that mark is what staleness looks like on disk.
        let stale = workbook_calculation(&zip.text("xl/workbook.xml")).full_calc_on_load;
        let needed = formula_count > 0 && (force || stale || missing_cached_values > 0);
        let counts = |report: &mut Map<String, Value>| {
            report.insert("formulaCount".to_owned(), Value::from(formula_count));
            report.insert("missingCachedValues".to_owned(), Value::from(missing_cached_values));
        };
        if !needed {
            let mut report = Map::new();
            report.insert("needed".to_owned(), Value::Bool(false));
            report.insert("recalculated".to_owned(), Value::Bool(false));
            counts(&mut report);
            return Ok(Value::Object(report));
        }
        let unavailable = |available: bool, reason: String| {
            let mut report = Map::new();
            report.insert("needed".to_owned(), Value::Bool(true));
            report.insert("available".to_owned(), Value::Bool(available));
            report.insert("recalculated".to_owned(), Value::Bool(false));
            if stale {
                report.insert("stale".to_owned(), Value::Bool(true));
            }
            counts(&mut report);
            report.insert("reason".to_owned(), Value::String(reason));
            Value::Object(report)
        };
        if path.extension().map(|extension| extension.to_string_lossy().to_lowercase()).as_deref() != Some("xlsx") {
            return Ok(unavailable(
                false,
                "Portable formula recalculation currently supports .xlsx only; use Microsoft Office background mode for macro-enabled or template workbooks.".to_owned(),
            ));
        }
        if zip.names().iter().any(|name| EXTERNAL_LINK.is_match(name)) {
            return Ok(unavailable(false, "Portable formula recalculation is blocked because LibreOffice may invalidate external workbook links.".to_owned()));
        }
        let Some(program) = self.program() else {
            return Ok(unavailable(false, "LibreOffice is unavailable for portable XLSX recalculation.".to_owned()));
        };
        let handed = if stale || force { without_formula_cache(source)? } else { source };
        let recalculated = match self.convert_workbook(proof, &program, path, &handed, cancel)? {
            Ok(done) => done,
            Err(reason) => return Ok(unavailable(true, reason)),
        };
        let produced = Package::load(&recalculated)?;
        // Read in LibreOffice's copy, which writes every formula it parsed back in upper case: that is how one it could not parse is
        // told apart.
        let errors = workbook_formula_errors(&produced);
        let bytes = with_computed_values(&mut zip, &produced)?;
        mixdog_fsio::write(proof, path, &bytes).map_err(|error| read_error(&error, path))?;
        let mut report = Map::new();
        report.insert("needed".to_owned(), Value::Bool(true));
        report.insert("available".to_owned(), Value::Bool(true));
        report.insert("recalculated".to_owned(), Value::Bool(true));
        if stale {
            report.insert("stale".to_owned(), Value::Bool(true));
        }
        report.insert("backend".to_owned(), Value::from("libreoffice"));
        // A clean status proves the formulas evaluate, not that they are right.
        report.insert("status".to_owned(), Value::from(if errors.total > 0 { "errors_found" } else { "success" }));
        counts(&mut report);
        report.insert("totalErrors".to_owned(), Value::from(errors.total));
        let summary: Map<String, Value> = errors
            .by_type
            .iter()
            .map(|(kind, entry)| (kind.clone(), json!({ "count": entry.count, "cells": entry.cells, "truncated": entry.truncated })))
            .collect();
        report.insert("errorSummary".to_owned(), Value::Object(summary));
        if !errors.unparsed.is_empty() {
            report.insert("unparsedFormulas".to_owned(), json!(errors.unparsed));
        }
        report.insert("outputBytes".to_owned(), Value::from(bytes.len()));
        Ok(Value::Object(report))
    }

    /// `validateLibreOfficeReopen(path, { signal })`: whether LibreOffice opens the file (it is converted to a PDF in a scratch folder).
    pub fn validate_reopen<P: WriteProof>(&self, proof: &P, path: &Path, cancel: Option<&AtomicBool>) -> Result<Value, String> {
        let Some(program) = self.program() else {
            return Ok(json!({ "available": false, "opened": false, "backend": "libreoffice" }));
        };
        let output_dir = make_temp_dir(proof, &self.host.temp_dir, "mixdog-office-libreoffice-").map_err(|error| os_message(&error, "mkdtemp", &self.host.temp_dir))?;
        let outcome = (|| {
            let job = Conversion {
                to: "pdf",
                out_dir: &output_dir,
                cancel,
                timeout: CONVERT_TIMEOUT,
                timeout_message: format!("LibreOffice reopen timed out after {} seconds", seconds(CONVERT_TIMEOUT)),
                cancelled_message: "LibreOffice reopen was cancelled",
            };
            if let RunResult::Failed(error) = self.convert(proof, &program, path, &job)? {
                return Ok(json!({ "available": true, "opened": false, "backend": "libreoffice", "error": error }));
            }
            let bytes = produced_file_size(proof, &converted_output_path(&output_dir, path, "pdf"));
            if bytes == 0 {
                return Ok(json!({ "available": true, "opened": false, "backend": "libreoffice", "error": "LibreOffice produced no review PDF" }));
            }
            Ok(json!({ "available": true, "opened": true, "backend": "libreoffice", "outputBytes": bytes }))
        })();
        remove_quietly(proof, &output_dir);
        outcome
    }

    /// `convertLegacyOffice(path, output, { signal, remove, log })`: saves an Office 97-2003 binary file as the package named by
    /// `output`'s extension (`report.doc` to `report.docx`). The conversion runs in a scratch folder and lands with an exclusive copy,
    /// so a file already at `output` is never replaced.
    pub fn convert_legacy_office<P: WriteProof>(
        &self,
        proof: &P,
        path: &Path,
        output: &Path,
        cancel: Option<&AtomicBool>,
        hooks: &ScratchHooks<'_>,
    ) -> Result<PathBuf, ConvertError> {
        let Some(program) = self.program() else {
            return Err(ConvertError::Failed(format!(
                "{} is a legacy binary file, not an Office package, and converting it needs LibreOffice. Install the Office feature in Mixdog settings (it installs LibreOffice), or open it in Microsoft Office and save it as {}.",
                path.display(),
                output.display()
            )));
        };
        let extension = output.extension().map(|extension| extension.to_string_lossy().to_lowercase()).unwrap_or_default();
        let output_dir = make_temp_dir(proof, &self.host.temp_dir, "mixdog-office-legacy-")
            .map_err(|error| ConvertError::Failed(os_message(&error, "mkdtemp", &self.host.temp_dir)))?;
        let outcome = self.convert_legacy_in(proof, &program, path, output, &extension, cancel, &output_dir);
        remove_scratch_with(proof, &output_dir, hooks);
        outcome
    }

    #[allow(clippy::too_many_arguments, reason = "one conversion's own facts")]
    fn convert_legacy_in<P: WriteProof>(
        &self,
        proof: &P,
        program: &str,
        path: &Path,
        output: &Path,
        extension: &str,
        cancel: Option<&AtomicBool>,
        output_dir: &Path,
    ) -> Result<PathBuf, ConvertError> {
        let aborted = || cancel.is_some_and(|flag| flag.load(Ordering::SeqCst));
        // The scratch folder is this function's own: no error leaves naming it (a failed copy reports both of its paths). A
        // cancellation stays an abort.
        let hidden = |message: String| {
            if aborted() { ConvertError::Aborted(message) } else { ConvertError::Failed(redact_directories(&message, &[output_dir])) }
        };
        let job = Conversion {
            to: extension,
            out_dir: output_dir,
            cancel,
            timeout: CONVERT_TIMEOUT,
            timeout_message: format!("LibreOffice conversion timed out after {} seconds", seconds(CONVERT_TIMEOUT)),
            cancelled_message: "LibreOffice conversion was cancelled",
        };
        let result = self.convert(proof, program, path, &job).map_err(&hidden)?;
        // A cancellation is the caller's abort, not a conversion failure.
        if aborted() {
            return Err(ConvertError::Aborted(match result {
                RunResult::Failed(message) => message,
                RunResult::Done => "This operation was aborted".to_owned(),
            }));
        }
        if let RunResult::Failed(error) = result {
            return Err(hidden(format!("LibreOffice could not convert {} to .{extension}: {error}", path.display())));
        }
        let generated = converted_output_path(output_dir, path, extension);
        if produced_file_size(proof, &generated) == 0 {
            return Err(hidden(format!("LibreOffice produced no .{extension} from {}; the file may be damaged or password-protected.", path.display())));
        }
        let bytes = mixdog_fsio::read(proof, &generated).map_err(|error| hidden(read_error(&error, &generated)))?;
        // COPYFILE_EXCL: a file already at `output` is never replaced.
        let copied = OpenOptions::new().write(true).create_new(true).open(proof, output).and_then(|mut file| file.write_all(&bytes));
        copied.map_err(|error| hidden(format!("{} -> '{}'", os_message(&error, "copyfile", &generated), output.display())))?;
        Ok(output.to_path_buf())
    }

    /// `renderPortableOoxml(path, output, { signal })`: renders the document to a PDF (or its first page to a PNG) at `output`.
    pub fn render<P: WriteProof>(&self, proof: &P, path: &Path, output: &Path, format: RenderFormat, cancel: Option<&AtomicBool>) -> Result<PathBuf, String> {
        let Some(program) = self.program() else {
            return Err("Portable Office rendering requires LibreOffice; install LibreOffice or open the document in background mode to render through Microsoft Office".to_owned());
        };
        let output_dir = output.parent().filter(|dir| !dir.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let extension = format.extension();
        let job = Conversion {
            to: extension,
            out_dir: output_dir,
            cancel,
            timeout: RENDER_TIMEOUT,
            timeout_message: format!("LibreOffice rendering timed out after {} seconds", seconds(RENDER_TIMEOUT)),
            cancelled_message: "Office rendering was cancelled",
        };
        if let RunResult::Failed(error) = self.convert(proof, &program, path, &job)? {
            return Err(error);
        }
        let generated = converted_output_path(output_dir, path, extension);
        // LibreOffice can exit 0 without writing anything (a missing or unreadable source).
        if produced_file_size(proof, &generated) == 0 {
            return Err(format!(
                "LibreOffice produced no {} from {}; the file may be missing, damaged or password-protected.",
                extension.to_uppercase(),
                path.display()
            ));
        }
        if generated != output {
            mixdog_fsio::rename(proof, &generated, output).map_err(|error| os_message(&error, "rename", &generated))?;
        }
        Ok(output.to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(parts: &[(&str, &str)]) -> Package {
        let mut package = Package::new();
        for (name, text) in parts {
            package.set(name, *text);
        }
        package
    }

    fn workbook_with(sheet: &str) -> Package {
        package(&[
            ("xl/workbook.xml", "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Data\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"),
            ("xl/_rels/workbook.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>"),
            ("xl/worksheets/sheet1.xml", sheet),
        ])
    }

    #[test]
    fn error_cells_are_tallied_by_type_with_their_locations_and_unparsed_formulas_are_named() {
        let sheet = "<worksheet><sheetData><row r=\"1\">\
            <c r=\"A1\" t=\"e\"><f>1/0</f><v>#DIV/0!</v></c>\
            <c r=\"A2\" t=\"e\"><f>1/0</f><v>#DIV/0!</v></c>\
            <c r=\"A3\" t=\"e\"><f>nosuchfn(1)</f><v>#NAME?</v></c>\
            <c r=\"A4\"><f>SUM(\"nosuch(\")</f><v>0</v></c>\
            <c r=\"A5\" t=\"e\"><v>  </v></c>\
            </row></sheetData></worksheet>";
        let errors = workbook_formula_errors(&workbook_with(sheet));
        assert_eq!(errors.total, 3);
        assert_eq!(errors.by_type.iter().map(|(kind, entry)| (kind.as_str(), entry.count)).collect::<Vec<_>>(), [("#DIV/0!", 2), ("#NAME?", 1)]);
        assert_eq!(errors.by_type[0].1.cells, ["Data!A1", "Data!A2"]);
        assert_eq!(errors.unparsed, ["Data!A3"]);
    }

    #[test]
    fn error_locations_stop_at_a_hundred_and_the_rest_is_counted() {
        let cells: String = (1..=130).map(|row| format!("<c r=\"A{row}\" t=\"e\"><v>#N/A</v></c>")).collect();
        let errors = workbook_formula_errors(&workbook_with(&format!("<worksheet><sheetData><row r=\"1\">{cells}</row></sheetData></worksheet>")));
        assert_eq!(errors.total, 130);
        assert_eq!(errors.by_type[0].1.cells.len(), 100);
        assert_eq!(errors.by_type[0].1.truncated, 30);
    }

    #[test]
    fn formula_cells_are_counted_and_the_ones_without_a_cached_value() {
        let sheet = "<worksheet><sheetData><row r=\"1\">\
            <c r=\"A1\"><f>1+1</f><v>2</v></c>\
            <c r=\"A2\"><f>B1</f></c>\
            <c r=\"A3\" t=\"str\"><f>IF(1,\"\",1)</f><v/></c>\
            <c r=\"A4\"><v>7</v></c>\
            </row></sheetData></worksheet>";
        assert_eq!(workbook_formula_counts(&workbook_with(sheet)), (3, 1));
    }

    #[test]
    fn the_stale_mark_comes_off_the_calculation_properties() {
        assert_eq!(
            clear_forced_recalculation("<workbook><calcPr calcId=\"1\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/></workbook>"),
            "<workbook><calcPr calcId=\"1\"/></workbook>"
        );
        assert_eq!(clear_forced_recalculation("<workbook><calcPr fullCalcOnLoad=\"true\"></workbook>"), "<workbook><calcPr/></workbook>");
        assert_eq!(clear_forced_recalculation("<workbook/>"), "<workbook/>");
    }

    #[test]
    fn the_copy_handed_to_libreoffice_carries_formulas_without_their_cached_values() {
        let zip = workbook_with("<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>1+1</f><v>2</v></c><c r=\"B1\"><v>5</v></c></row></sheetData></worksheet>");
        let stripped = Package::load(&without_formula_cache(zip.generate().expect("package")).expect("stripped")).expect("loads");
        assert_eq!(stripped.text("xl/worksheets/sheet1.xml"), "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>1+1</f></c><c r=\"B1\"><v>5</v></c></row></sheetData></worksheet>");
        let plain = workbook_with("<worksheet><sheetData/></worksheet>").generate().expect("package");
        assert_eq!(without_formula_cache(plain.clone()).expect("unchanged"), plain);
    }

    #[test]
    fn computed_values_are_carried_into_the_workbook_as_authored_and_the_stale_mark_is_dropped() {
        let mut original = workbook_with("<worksheet><sheetData><row r=\"1\"><c r=\"A1\" s=\"3\"><f>1+1</f></c></row></sheetData></worksheet>");
        original.set("xl/workbook.xml", original.text("xl/workbook.xml").replace("</workbook>", "<calcPr fullCalcOnLoad=\"1\"/></workbook>"));
        let produced = workbook_with("<worksheet><sheetData><row r=\"1\"><c r=\"A1\" s=\"9\"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>");
        let bytes = with_computed_values(&mut original, &produced).expect("carried");
        let written = Package::load(&bytes).expect("loads");
        assert_eq!(written.text("xl/worksheets/sheet1.xml"), "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" s=\"3\"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>");
        assert!(written.text("xl/workbook.xml").ends_with("<calcPr/></workbook>"));
    }

    #[test]
    fn conversions_are_served_in_the_order_they_asked() {
        let queue = Queue { tickets: Mutex::new((0, 0)), turn: Condvar::new() };
        let served = Mutex::new(Vec::new());
        let first = queue.enter();
        std::thread::scope(|scope| {
            for name in 1..=3_u32 {
                scope.spawn({
                    let (queue, served) = (&queue, &served);
                    move || {
                        let _turn = queue.enter();
                        lock(served).push(name);
                    }
                });
                // Each waits behind the one before it: wait until it has taken its ticket.
                while lock(&queue.tickets).0 < u64::from(name) + 1 {
                    std::thread::yield_now();
                }
            }
            drop(first);
        });
        assert_eq!(*lock(&served), [1, 2, 3]);
    }
}


impl std::error::Error for ConvertError {}
