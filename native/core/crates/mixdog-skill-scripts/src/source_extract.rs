//! `pptx/scripts/source-extract.mjs`: supplied material as quotable blocks with locators, so a deck's facts line can
//! cite where each figure came from: `[p3]` for a page, `[Sheet1!B4]` for a cell, `[slide 4]` for a slide, `[line 42]`
//! for text. Office files (pdf, docx, xlsx, pptx) are read through the office engine in a portable session that is
//! closed without saving; anything else is read as UTF-8 text. Output is bounded by `--chars` (default 4000) and every
//! block is cut at [`BLOCK_CHARS`].
//!
//! This module also holds what the three office scripts share: the office engine they are handed
//! ([`OfficeEngine`], installed once by the process that runs them), the host they run in ([`OfficeHost`]) and the
//! few JavaScript conventions their ported code leans on (truthiness, template-literal text of an absent value, the
//! `node:path` pieces).

use std::path::Path;
use std::sync::OnceLock;

use mixdog_fsio::ReadProof;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::js_words;
use mixdog_js::nodepath;
use mixdog_js::slice_utf16;
use mixdog_js::string_to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::Outcome;
use crate::mixdogd_exec::ExecRunner;
use crate::node_fs_message;
use crate::parse_args::OptionSpec;
use crate::parse_args::ParseConfig;
use crate::parse_args::parse_args;

pub const DEFAULT_CHARS: &str = "4000";
pub const BLOCK_CHARS: usize = 600;
pub const OFFICE_EXTENSIONS: [&str; 4] = [".pdf", ".docx", ".xlsx", ".pptx"];

const USAGE: &str = "Usage: source-extract.mjs <file.pdf|docx|xlsx|pptx|md|txt> [--chars 4000]";

/// What the office scripts ask of the office engine: its tool entry point (the result of `executeOfficeTool`, parsed,
/// or the text of the error it answered) and the measurement of a saved deck.
pub trait OfficeEngine: Send + Sync {
    /// One office tool call: `args` are the tool's arguments, `cwd` the folder relative paths mean.
    fn call(&self, args: &Value, cwd: &Path) -> Result<Value, String>;
    /// The portable OOXML issues and snapshot of a `.pptx` file (`issuesPortableOoxml` and `snapshotPortableOoxml`).
    fn measure(&self, deck: &Path) -> Result<Measured, String>;
}

/// The measurement of one deck.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Measured {
    pub issues: Vec<Value>,
    pub document: Value,
}

static ENGINE: OnceLock<Box<dyn OfficeEngine>> = OnceLock::new();

/// Installs the office engine this process's scripts use. The process that serves the office tool calls it once at
/// start; a second call hands the engine back.
pub fn install_office_engine(engine: Box<dyn OfficeEngine>) -> Result<(), Box<dyn OfficeEngine>> {
    ENGINE.set(engine)
}

/// The installed office engine, when there is one.
pub fn installed_office_engine() -> Option<&'static dyn OfficeEngine> {
    ENGINE.get().map(|engine| &**engine)
}

/// What the office scripts run against: the office engine (absent where the process has none), the model-turn runner
/// and the folder relative paths mean.
pub struct OfficeHost<'a> {
    pub engine: Option<&'a dyn OfficeEngine>,
    pub exec: &'a dyn ExecRunner,
    pub cwd: &'a Path,
}

impl OfficeHost<'_> {
    /// The engine, or the one reason the feature is off.
    pub(crate) fn engine(&self) -> Result<&dyn OfficeEngine, String> {
        self.engine.ok_or_else(|| "the office engine is not available in this process".to_owned())
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// JavaScript conventions shared by the office scripts.
// ---------------------------------------------------------------------------------------------------------------------

/// A property of an object value; `None` for an absent property and for anything that is not an object.
pub(crate) fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

/// Whether the value is JavaScript-truthy (`undefined` is `None`).
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `${value}` in a template literal: an absent value is `undefined`, a null `null`.
pub(crate) fn template(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `String(value ?? '')`.
pub(crate) fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// `a ?? b`.
pub(crate) fn first_present<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

/// `typeof value === 'string' ? value.trim() : ''`.
pub(crate) fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| js_trim(text).to_owned()).unwrap_or_default()
}

/// `Number.isFinite(value)` of a JSON value, and the number.
pub(crate) fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|number| number.is_finite())
}

/// `Number(value.toFixed(2))`: JavaScript rounds an exact tie up in magnitude, where Rust's formatter rounds it to even.
pub(crate) fn to_fixed_2(value: f64) -> f64 {
    let exact = format!("{:.40}", value.abs());
    let Some((whole, fraction)) = exact.split_once('.') else { return value };
    let rest = &fraction[2..];
    let tie = rest.starts_with('5') && rest[1..].bytes().all(|digit| digit == b'0');
    let rounded: f64 = if tie {
        let hundredths: u128 = format!("{whole}{}", &fraction[..2]).parse().unwrap_or(0);
        (hundredths + 1) as f64 / 100.0
    } else {
        format!("{:.2}", value.abs()).parse().unwrap_or(0.0)
    };
    if value < 0.0 { -rounded } else { rounded }
}

/// A failed file-system call as Node words it.
pub(crate) fn fs_message(error: &std::io::Error, syscall: &str, path: &Path) -> String {
    let path = path.to_string_lossy();
    match mixdog_js::uv_error::error_code(error) {
        Some("EEXIST") => format!("EEXIST: file already exists, {syscall} '{path}'"),
        Some("ENOTEMPTY") => format!("ENOTEMPTY: directory not empty, {syscall} '{path}'"),
        _ => node_fs_message(error, syscall, &path),
    }
}

fn separators() -> &'static [char] {
    if cfg!(windows) { &['/', '\\'] } else { &['/'] }
}

fn separator() -> char {
    if cfg!(windows) { '\\' } else { '/' }
}

/// `path.dirname` of a resolved path.
pub(crate) fn dirname(path: &str) -> String {
    let Some(at) = path.rfind(separators()) else { return ".".to_owned() };
    let head = &path[..at];
    if head.is_empty() {
        return path[..=at].to_owned();
    }
    if cfg!(windows) && head.len() == 2 && head.as_bytes()[1] == b':' {
        return path[..=at].to_owned();
    }
    head.to_owned()
}

fn base(path: &str) -> &str {
    let trimmed = path.trim_end_matches(separators());
    trimmed.rfind(separators()).map_or(trimmed, |at| &trimmed[at + 1..])
}

/// `path.extname`.
pub(crate) fn extname(path: &str) -> String {
    let name = base(path);
    match name.rfind('.') {
        Some(at) if at > 0 && name != ".." => name[at..].to_owned(),
        _ => String::new(),
    }
}

/// `path.basename(path, path.extname(path))`.
pub(crate) fn basename_without_extension(path: &str) -> String {
    let name = base(path);
    let extension = extname(path);
    name.strip_suffix(extension.as_str()).filter(|stem| !stem.is_empty()).unwrap_or(name).to_owned()
}

// ---------------------------------------------------------------------------------------------------------------------
// source-extract
// ---------------------------------------------------------------------------------------------------------------------

/// Plain text: one block per non-empty line, numbered from 1 so a fact can cite `[line 42]`.
pub fn from_plain_text(text: &str, limit: f64) -> Vec<String> {
    let mut out = Vec::new();
    let mut used = 0.0;
    for (index, line) in text.split('\n').enumerate() {
        if used >= limit {
            break;
        }
        let line = js_trim(line);
        if line.is_empty() {
            continue;
        }
        out.push(format!("[line {}] {line}", index + 1));
        used += utf16_len(line) as f64;
    }
    out
}

/// Page chrome (slide number, footer and date placeholders) is not source material.
fn is_page_chrome(shape: &Value) -> bool {
    if !truthy(get(shape, "placeholder")) {
        return false;
    }
    let name = get(shape, "name").filter(|name| truthy(Some(*name)));
    let name = js_to_lowercase(&string_or_empty(name));
    name.contains("slidenumber") || name.contains("slide number") || name.contains("footer") || name.contains("date")
}

/// The elements of an array value; empty for anything else (`value || []` of a list the scripts read).
pub(crate) fn items(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// What one file was read into.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Extract {
    pub source: String,
    pub blocks: Vec<String>,
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_fsio::Unlaned;
    use mixdog_js::number_to_string;

    use super::*;
    use crate::mixdogd_exec::ExecOptions;
    use crate::mixdogd_exec::ExecResult;

    struct NoExec;

    impl ExecRunner for NoExec {
        fn run(&self, _options: &ExecOptions) -> ExecResult {
            panic!("source-extract starts no model turn");
        }
    }

    struct Engine {
        document: Value,
        calls: Mutex<Vec<Value>>,
    }

    impl OfficeEngine for Engine {
        fn call(&self, args: &Value, _cwd: &Path) -> Result<Value, String> {
            self.calls.lock().expect("calls").push(args.clone());
            Ok(match args["action"].as_str() {
                Some("open") => json!({ "session": "s1" }),
                Some("snapshot") => json!({ "document": self.document }),
                _ => json!({}),
            })
        }

        fn measure(&self, _deck: &Path) -> Result<Measured, String> {
            Err("not measured here".to_owned())
        }
    }

    fn host<'a>(engine: Option<&'a dyn OfficeEngine>, cwd: &'a Path) -> OfficeHost<'a> {
        OfficeHost { engine, exec: &NoExec, cwd }
    }

    #[test]
    fn plain_text_is_one_block_per_non_empty_line_with_its_line_number() {
        let blocks = from_plain_text("  first \n\n second\n", 4000.0);
        assert_eq!(blocks, ["[line 1] first", "[line 3] second"]);
        // The limit is checked before each line, so the line that crosses it is still taken.
        assert_eq!(from_plain_text("aaaa\nbbbb\ncccc", 5.0), ["[line 1] aaaa", "[line 2] bbbb"]);
    }

    #[test]
    fn the_node_path_pieces_follow_node() {
        assert_eq!(extname("/a/b.TXT"), ".TXT");
        assert_eq!(extname("/a/.env"), "");
        assert_eq!(extname("/a/b."), ".");
        assert_eq!(extname("/a/.."), "");
        assert_eq!(basename_without_extension("/a/deck.pptx"), "deck");
        assert_eq!(dirname("/a/deck.pptx"), "/a");
        assert_eq!(dirname("/deck.pptx"), "/");
        assert_eq!(to_fixed_2(12.375), 12.38);
        assert_eq!(to_fixed_2(0.125), 0.13);
        assert_eq!(to_fixed_2(1.0049), 1.0);
        assert_eq!(number_to_string(to_fixed_2(-0.001)), "0");
    }

    #[test]
    fn a_document_gives_pages_slides_blocks_and_cells_their_locators() {
        let document = json!({
            "pages": [{ "number": 3, "text": "page  three" }, { "index": 4, "text": "" }],
            "slides": [{
                "number": 2,
                "shapes": [
                    { "text": "Title", "placeholder": true, "name": "Title 1" },
                    { "text": "7", "placeholder": true, "name": "Slide Number Placeholder 5" },
                    { "text": "footer words", "placeholder": true, "name": "Footer 3" },
                    { "text": "body" }
                ]
            }],
            "blocks": [{ "page": 9, "text": "on nine" }, { "text": "loose" }],
            "sheets": [{ "name": "Sheet1", "cells": [{ "ref": "B4", "value": 12 }, { "ref": "C1", "formula": "=A1" }] }]
        });
        assert_eq!(
            from_document(&document, 4000.0),
            ["[p3] page three", "[slide 2] Title", "[slide 2] body", "[p9] on nine", "[¶5] loose", "[Sheet1!B4] 12", "[Sheet1!C1] =A1"]
        );
    }
    #[test]
    fn a_block_is_cut_at_the_block_limit_and_the_total_at_the_chars_limit() {
        let long = "x".repeat(900);
        let document = json!({ "pages": [{ "number": 1, "text": long }, { "number": 2, "text": "second" }] });
        let blocks = from_document(&document, 4000.0);
        assert_eq!(blocks[0].len(), "[p1] ".len() + BLOCK_CHARS);
        assert_eq!(blocks.len(), 2);
        // A block that starts under the limit is taken whole; the next one is not.
        assert_eq!(from_document(&document, 100.0).len(), 1);
    }
    #[test]
    fn the_extract_prints_a_heading_the_blocks_and_the_sources_line() {
        let extract = Extract { source: "a.md".into(), blocks: vec!["[line 1] x".into()] };
        assert_eq!(format_extract(&extract), "# a.md — 1 blocks (cite the bracketed locator in the brief's facts line)\n\n[line 1] x\n\n# sources: a.md");
    }
    #[test]
    fn a_text_file_is_read_without_the_engine_and_a_bad_chars_value_is_refused() {
        let dir = tempfile::tempdir().expect("temp dir");
        mixdog_testkit::write(dir.path().join("notes.md"), "alpha\nbeta\n");
        let host = host(None, dir.path());
        let ok = run_source_extract(&Unlaned, &["notes.md".into()], &host);
        assert_eq!(ok.code, 0);
        let heading = "# notes.md — 2 blocks (cite the bracketed locator in the brief's facts line)";
        assert_eq!(ok.stdout, format!("{heading}\n\n[line 1] alpha\n[line 2] beta\n\n# sources: notes.md\n"));
        let bad = run_source_extract(&Unlaned, &["notes.md".into(), "--chars".into(), "0".into()], &host);
        assert_eq!((bad.code, bad.stderr.as_str()), (1, "--chars must be a positive number, got 0\n"));
        let missing = run_source_extract(&Unlaned, &["gone.md".into()], &host);
        assert!(missing.stderr.starts_with("source file not found: "), "{}", missing.stderr);
        let usage = run_source_extract(&Unlaned, &[], &host);
        assert_eq!((usage.code, usage.stderr), (1, format!("{USAGE}\n")));
    }
    #[test]
    fn an_office_file_is_opened_portable_read_and_closed_without_saving() {
        let dir = tempfile::tempdir().expect("temp dir");
        mixdog_testkit::write(dir.path().join("deck.PPTX"), "zip");
        let engine = Engine { document: json!({ "slides": [{ "number": 1, "shapes": [{ "text": "Hello" }] }] }), calls: Mutex::new(Vec::new()) };
        let outcome = run_source_extract(&Unlaned, &["deck.PPTX".into()], &host(Some(&engine), dir.path()));
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        assert!(outcome.stdout.contains("[slide 1] Hello"));
        let calls = engine.calls.lock().expect("calls");
        let actions: Vec<&str> = calls.iter().map(|call| call["action"].as_str().expect("action")).collect();
        assert_eq!(actions, ["open", "snapshot", "close"]);
        assert_eq!(calls[0]["mode"], "portable");
        assert_eq!(calls[0]["snapshotAfter"], false);
        assert_eq!((calls[1]["limit"].clone(), calls[1]["maxChars"].clone(), calls[1]["session"].clone()), (json!(200), json!(100_000), json!("s1")));
        assert_eq!(calls[2]["save"], false);
    }
    #[test]
    fn an_office_file_without_an_engine_reports_why_it_is_off() {
        let dir = tempfile::tempdir().expect("temp dir");
        mixdog_testkit::write(dir.path().join("a.pdf"), "pdf");
        let outcome = run_source_extract(&Unlaned, &["a.pdf".into()], &host(None, dir.path()));
        assert_eq!(outcome.code, 1);
        assert!(outcome.stderr.starts_with("the office engine is not available in this process: cannot read "));
    }
}

/// `value.replace(/\s+/g, ' ').trim()`.
pub(crate) fn collapse_spaces(value: &str) -> String {
    js_words(value).collect::<Vec<_>>().join(" ")
}
/// `path.join(directory, name)` for a resolved directory.
pub(crate) fn join(directory: &str, name: &str) -> String {
    let joined = if directory.ends_with(separators()) { format!("{directory}{name}") } else { format!("{directory}{}{name}", separator()) };
    nodepath::normalize_host(&joined)
}
/// A snapshot document (pages for a PDF, slides for a PPTX, blocks or paragraphs for a DOCX, sheets for an XLSX) as
/// blocks prefixed with the locator the facts line quotes.
pub fn from_document(document: &Value, limit: f64) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut used = 0.0;
    let mut push = |out: &mut Vec<String>, locator: String, text: Option<&Value>| {
        let body = collapse_spaces(&string_or_empty(text));
        if body.is_empty() || used >= limit {
            return;
        }
        out.push(format!("[{locator}] {}", slice_utf16(&body, BLOCK_CHARS)));
        used += utf16_len(&body).min(BLOCK_CHARS) as f64;
    };
    for page in items(get(document, "pages")) {
        let number = template(first_present(get(page, "number"), get(page, "index")));
        push(&mut out, format!("p{number}"), get(page, "text"));
    }
    for slide in items(get(document, "slides")) {
        for shape in items(get(slide, "shapes")) {
            if is_page_chrome(shape) {
                continue;
            }
            let number = template(first_present(get(slide, "number"), get(slide, "index")));
            push(&mut out, format!("slide {number}"), get(shape, "text"));
        }
    }
    let blocks = if truthy(get(document, "blocks")) { get(document, "blocks") } else { get(document, "paragraphs") };
    for block in items(blocks) {
        let locator = if truthy(get(block, "page")) {
            format!("p{}", template(get(block, "page")))
        } else {
            let fallback = json!(out.len() + 1);
            format!("¶{}", template(first_present(get(block, "index"), Some(&fallback))))
        };
        push(&mut out, locator, get(block, "text"));
    }
    for sheet in items(get(document, "sheets")) {
        for cell in items(get(sheet, "cells")) {
            let locator = format!("{}!{}", template(get(sheet, "name")), template(get(cell, "ref")));
            push(&mut out, locator, first_present(get(cell, "value"), get(cell, "formula")));
        }
    }
    out
}
/// Reads one file into locator-prefixed blocks; `chars` is the text of `--chars`.
pub fn extract_source<P: ReadProof>(proof: &P, target: &str, chars: &str, host: &OfficeHost<'_>) -> Result<Extract, String> {
    let source = js_trim(target).to_owned();
    if source.is_empty() {
        return Err("source-extract needs a file path".to_owned());
    }
    let limit = string_to_number(chars);
    if !limit.is_finite() || limit <= 0.0 {
        return Err(format!("--chars must be a positive number, got {chars}"));
    }
    let cwd = host.cwd.to_string_lossy();
    let path = nodepath::resolve_host(&[&cwd, &source]);
    if !mixdog_fsio::exists(proof, &path).unwrap_or(false) {
        return Err(format!("source file not found: {path}"));
    }
    let extension = js_to_lowercase(&extname(&path));
    if !OFFICE_EXTENSIONS.contains(&extension.as_str()) {
        let bytes = mixdog_fsio::read(proof, &path).map_err(|error| {
            if mixdog_js::uv_error::error_code(&error) == Some("EISDIR") {
                "EISDIR: illegal operation on a directory, read".to_owned()
            } else {
                fs_message(&error, "open", Path::new(&path))
            }
        })?;
        return Ok(Extract { source, blocks: from_plain_text(&String::from_utf8_lossy(&bytes), limit) });
    }
    let engine = host.engine().map_err(|reason| format!("{reason}: cannot read {path}"))?;
    let opened = engine.call(&json!({ "action": "open", "path": path, "mode": "portable", "snapshotAfter": false }), host.cwd)?;
    let session = get(&opened, "session");
    let with_session = |action: &str, rest: Value| {
        let mut args = Map::new();
        args.insert("action".to_owned(), json!(action));
        if let Some(session) = session {
            args.insert("session".to_owned(), session.clone());
        }
        if let Value::Object(rest) = rest {
            args.extend(rest);
        }
        Value::Object(args)
    };
    let snapshot = engine.call(&with_session("snapshot", json!({ "limit": 200, "maxChars": 100_000 })), host.cwd);
    // The session is closed without saving whether or not the snapshot came.
    let _ = engine.call(&with_session("close", json!({ "save": false })), host.cwd);
    let snapshot = snapshot?;
    let document = get(&snapshot, "document").cloned().unwrap_or(Value::Null);
    Ok(Extract { source, blocks: from_document(&document, limit) })
}
/// The text the script prints for one extract.
pub fn format_extract(extract: &Extract) -> String {
    let source = &extract.source;
    let heading = format!("# {source} — {} blocks (cite the bracketed locator in the brief's facts line)", extract.blocks.len());
    let mut lines = vec![heading, String::new()];
    lines.extend(extract.blocks.iter().cloned());
    lines.push(String::new());
    lines.push(format!("# sources: {source}"));
    lines.join("\n")
}
/// `source-extract.mjs <file> [--chars N]`.
pub fn run_source_extract<P: ReadProof>(proof: &P, args: &[String], host: &OfficeHost<'_>) -> Outcome {
    let mut outcome = Outcome::default();
    let options = [OptionSpec::string("chars")];
    let result = parse_args(args, &ParseConfig { options: &options, allow_positionals: true }).map_err(|error| error.message).and_then(|parsed| {
        if parsed.positionals.len() != 1 {
            return Err(USAGE.to_owned());
        }
        extract_source(proof, &parsed.positionals[0], parsed.text("chars").unwrap_or(DEFAULT_CHARS), host)
    });
    match result {
        Ok(extract) => outcome.print(&format_extract(&extract)),
        Err(message) => {
            outcome.eprint(&message);
            outcome.code = 1;
        }
    }
    outcome
}
