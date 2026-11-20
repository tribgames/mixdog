//! Biome — JSON reporter for check, `--write` for fix (both need Biome 1.8 or later: before it,
//! `check` refuses `--max-diagnostics=none`, so there is no older spelling to fall back to). Output can be huge and
//! arrive truncated, so documents are scanned incrementally, a truncated chunk is split and
//! re-run, and fix safety comes from the row or from `biome explain <rule>`.

use std::collections::HashMap;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_js::{JsRegex, js_trim, js_words};
use serde_json::{Value, json};

use super::shared::*;
use crate::tidy::process::map_limit;

pub const BIOME_CHECK_ARGS: [&str; 3] = ["check", "--reporter=json", "--max-diagnostics=none"];
/// Biome ends lines as its configuration says; tidy does not report or rewrite a file for its
/// line endings, so the files are run by how they end theirs, each group told its own.
const BIOME_LINE_ENDINGS: LineEndingFlags = LineEndingFlags { lf: &["--line-ending=lf"], crlf: &["--line-ending=crlf"] };
pub const BIOME_TRUNCATED_NOTE: &str = "biome JSON output was truncated; split the scope and re-run to get complete diagnostics";
const EXPLAIN_CONCURRENCY: usize = 4;

fn severity_of(value: &str) -> &'static str {
    match value.to_lowercase().as_str() {
        "error" | "fatal" => "error",
        "warning" | "warn" => "warning",
        _ => "info",
    }
}

#[derive(Debug, Default, Clone)]
pub struct Parsed {
    pub diagnostics: Vec<Diagnostic>,
    pub changed_files: Vec<String>,
    pub truncated: bool,
    /// Files biome itself says it processed (`summary.changed + unchanged - skipped`); `None` without a summary.
    pub processed: Option<i64>,
}

/// Byte index just past a JSON object/array starting at `start`, or `None` if truncated.
fn end_of_json_value(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = start;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let open = *bytes.get(i)?;
    if open != b'{' && open != b'[' {
        return None;
    }
    let close = if open == b'{' { b'}' } else { b']' };
    let (mut depth, mut in_string, mut escaped) = (0i32, false, false);
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
        } else if c == b'"' {
            in_string = true;
        } else if c == b'{' || c == b'[' {
            depth += 1;
        } else if c == b'}' || c == b']' {
            depth -= 1;
            if depth == 0 {
                return (c == close).then_some(i + 1);
            }
        }
        i += 1;
    }
    None
}

fn recover_diagnostics_array(text: &str) -> Vec<Value> {
    let Some(key) = text.find("\"diagnostics\"") else { return Vec::new() };
    let Some(bracket) = text[key + 13..].find('[').map(|p| p + key + 13) else { return Vec::new() };
    let bytes = text.as_bytes();
    let (mut rows, mut i) = (Vec::new(), bracket + 1);
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b']' || bytes[i] != b'{' {
            break;
        }
        let Some(end) = end_of_json_value(text, i) else { break };
        let Ok(row) = serde_json::from_str::<Value>(&text[i..end]) else { break };
        rows.push(row);
        i = end;
    }
    rows
}

fn parse_json_documents(text: &str) -> (Vec<Value>, bool) {
    let (mut docs, mut truncated, mut i) = (Vec::new(), false, 0);
    let bytes = text.as_bytes();
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        if bytes[i] != b'{' && bytes[i] != b'[' {
            match text[i..].find('{') {
                Some(next) => i += next,
                None => break,
            }
        }
        let Some(end) = end_of_json_value(text, i) else {
            truncated = true;
            let recovered = recover_diagnostics_array(&text[i..]);
            if !recovered.is_empty() {
                docs.push(json!({"diagnostics": recovered}));
            }
            break;
        };
        match serde_json::from_str::<Value>(&text[i..end]) {
            Ok(doc) => docs.push(doc),
            Err(_) => {
                truncated = true;
                break;
            }
        }
        i = end;
    }
    (docs, truncated)
}

fn location_of(row: &Value, cwd: &std::path::Path) -> (String, i64, i64) {
    let loc = row.get("location").cloned().unwrap_or(Value::Null);
    let path = loc.pointer("/path/file").or_else(|| loc.get("path")).and_then(Value::as_str).unwrap_or("");
    let file = to_rel(cwd, path);
    let source = loc.get("sourceCode").and_then(Value::as_str).unwrap_or("");
    if let (Some(span), false) = (loc.get("span").and_then(Value::as_array), source.is_empty()) {
        let (line, col) = position_at(source, span.first().and_then(Value::as_u64).unwrap_or(0) as usize);
        return (file, line, col);
    }
    let start = loc.get("start").or_else(|| loc.pointer("/range/start")).cloned().unwrap_or(Value::Null);
    (file, number(start.get("line")), number(start.get("column")))
}

/// Lint/assist rule id from a category (`lint/style/useConst` → `useConst`).
fn rule_name(category: &str) -> String {
    if category.starts_with("lint/") || category.starts_with("assist/") { category.rsplit('/').next().unwrap_or("").to_owned() } else { String::new() }
}

/// Parses `biome explain <rule>`: `- Fix: safe|unsafe` or `No fix available.`
pub fn parse_explain_fix(text: &str) -> &'static str {
    static UNSAFE: OnceLock<JsRegex> = OnceLock::new();
    static SAFE: OnceLock<JsRegex> = OnceLock::new();
    let unsafe_re = UNSAFE.get_or_init(|| JsRegex::new_static(r"^- Fix:\s*unsafe\b", "i"));
    let safe_re = SAFE.get_or_init(|| JsRegex::new_static(r"^- Fix:\s*safe\b", "i"));
    for line in text.lines() {
        let t = js_trim(line);
        if unsafe_re.is_match(t) {
            return "unsafe";
        }
        if safe_re.is_match(t) {
            return "safe";
        }
        if t.to_lowercase().contains("no fix available") {
            return "none";
        }
    }
    "none"
}

/// Safety from the JSON row itself. Empty means Biome 2.5 omitted it; ask `explain`.
fn payload_fix_kind(row: &Value, category: &str) -> &'static str {
    if category.starts_with("format") {
        return "safe";
    }
    let tags: Vec<String> = row.get("tags").and_then(Value::as_array).map(|t| t.iter().filter_map(|v| v.as_str()).map(str::to_lowercase).collect()).unwrap_or_default();
    if tags.iter().any(|t| t == "unsafe") {
        "unsafe"
    } else if tags.iter().any(|t| t == "fixable") {
        "safe"
    } else {
        ""
    }
}

pub fn apply_biome_fix_kinds(diagnostics: &mut [Diagnostic], kinds: &HashMap<String, String>) {
    for f in diagnostics {
        if f.code_fix == Some(false) {
            f.fix_kind = Some("manual".into());
            f.fixable = false;
            continue;
        }
        if f.code.starts_with("format") {
            f.fix_kind = Some("safe".into());
            f.fixable = true;
            continue;
        }
        match kinds.get(&rule_name(&f.code)).map(String::as_str) {
            Some(k @ ("safe" | "unsafe")) => {
                f.fix_kind = Some(k.into());
                f.fixable = k == "safe";
                continue;
            }
            Some("none") => {
                f.fix_kind = Some("manual".into());
                f.fixable = false;
                continue;
            }
            _ => {}
        }
        if f.fix_kind.as_deref().is_none_or(str::is_empty) {
            f.fix_kind = Some(if f.fixable { "safe" } else { "manual" }.into());
        }
        f.fixable = f.fix_kind.as_deref() == Some("safe");
    }
}

fn rows_to_result(rows: &[Value], cwd: &std::path::Path, truncated: bool) -> Parsed {
    let (mut diagnostics, mut changed) = (Vec::new(), Vec::new());
    let category_of = |row: &Value| row.get("category").and_then(Value::as_str).or_else(|| row.pointer("/code/value").and_then(Value::as_str)).or_else(|| row.get("code").and_then(Value::as_str)).unwrap_or("").to_owned();
    // The formatter refuses a file that does not parse and says so as a `format` row: nothing
    // would be rewritten there, so it is neither a file to format nor a fixable finding.
    let unparsable: std::collections::HashSet<String> = rows.iter().filter(|r| category_of(r) == "parse").map(|r| location_of(r, cwd).0).collect();
    for row in rows {
        let category = category_of(row);
        let category = category.as_str();
        let (file, line, col) = location_of(row, cwd);
        let blocked = category.starts_with("format") && unparsable.contains(&file);
        if category.starts_with("format") && !blocked {
            changed.push(file.clone());
        }
        let kind = if blocked { "" } else { payload_fix_kind(row, category) };
        let rdjson = row.pointer("/code/value").is_some_and(Value::is_string);
        let code_fix = if blocked {
            Some(false)
        } else if category.starts_with("format") {
            Some(true)
        } else if let Some(s) = row.get("suggestions").and_then(Value::as_array) {
            Some(!s.is_empty())
        } else if rdjson {
            Some(false)
        } else {
            None
        };
        let message = row.get("description").and_then(Value::as_str).or_else(|| row.get("message").and_then(Value::as_str)).unwrap_or("");
        let mut d = diagnostic(DiagnosticInit {
            file: &file,
            line,
            col,
            code: category,
            message: &js_words(message).collect::<Vec<_>>().join(" "),
            severity: severity_of(row.get("severity").and_then(Value::as_str).unwrap_or("")),
            fixable: kind == "safe",
        });
        d.fix_kind = Some(kind.to_owned());
        d.code_fix = code_fix;
        diagnostics.push(d);
    }
    Parsed { diagnostics, changed_files: unique_paths(changed), truncated, processed: None }
}

/// Parses `biome check --reporter=json` output (one document, many, or a truncated tail).
pub fn parse_biome_json(stdout: &str, cwd: &std::path::Path, truncated_input: bool) -> Parsed {
    let text = js_trim(stdout);
    if text.is_empty() {
        return Parsed { truncated: truncated_input, ..Default::default() };
    }
    let (docs, parse_truncated) = parse_json_documents(text);
    if docs.is_empty() {
        return Parsed { truncated: truncated_input || parse_truncated || text.contains('{'), ..Default::default() };
    }
    let mut rows = Vec::new();
    let mut omitted = false;
    let mut processed: Option<i64> = None;
    for doc in &docs {
        rows.extend(doc.get("diagnostics").and_then(Value::as_array).cloned().unwrap_or_default());
        if number(doc.pointer("/summary/diagnosticsNotPrinted")) > 0 {
            omitted = true;
        }
        if doc.pointer("/summary/changed").or_else(|| doc.pointer("/summary/unchanged")).is_some() {
            // A file biome could not decode it counts as unchanged and as skipped; one that is not
            // there, or that its configuration leaves out, it does not count at all.
            *processed.get_or_insert(0) += number(doc.pointer("/summary/changed")) + number(doc.pointer("/summary/unchanged")) - number(doc.pointer("/summary/skipped"));
        }
    }
    Parsed { processed, ..rows_to_result(&rows, cwd, truncated_input || parse_truncated || omitted) }
}

pub fn merge_biome_parses(parts: Vec<Parsed>) -> Parsed {
    let mut merged = Parsed::default();
    let mut changed = Vec::new();
    for p in parts {
        merged.diagnostics.extend(p.diagnostics);
        changed.extend(p.changed_files);
        merged.truncated |= p.truncated;
    }
    merged.changed_files = unique_paths(changed);
    merged
}

pub fn biome_counts(diagnostics: &[Diagnostic], changed_files: &[String]) -> Value {
    let (mut by_sev, mut by_fix) = ([0i64; 3], [0i64; 5]);
    let mut by_rule: std::collections::BTreeMap<String, i64> = Default::default();
    for f in diagnostics {
        by_sev[match f.severity.as_str() { "error" => 0, "warning" => 1, _ => 2 }] += 1;
        let kind = match f.fix_kind.as_deref() {
            Some("unsafe") => 1,
            Some("safe") => 0,
            _ if f.fixable => 0,
            _ => 2,
        };
        by_fix[kind] += 1;
        if kind == 0 { by_fix[3] += 1 } else { by_fix[4] += 1 }
        *by_rule.entry(if f.code.is_empty() { "unknown".into() } else { f.code.clone() }).or_default() += 1;
    }
    json!({
        "filesToFormat": changed_files.len(), "diagnostics": diagnostics.len(),
        "bySeverity": {"error": by_sev[0], "warning": by_sev[1], "info": by_sev[2]},
        "byFixability": {"safe": by_fix[0], "unsafe": by_fix[1], "manual": by_fix[2], "fixable": by_fix[3], "unfixable": by_fix[4]},
        "byRule": by_rule,
    })
}

/// Biome's stderr repeats a fixed banner on every run; only the rest is worth a tail.
pub fn biome_stderr_tail(stderr: &str) -> String {
    static BANNERS: OnceLock<Vec<JsRegex>> = OnceLock::new();
    let banners = BANNERS.get_or_init(|| {
        [r"^The `json` and `json-pretty` reporters are experimental", r"^\w+ ━+$", r"^[×✖]\s+Some errors were emitted while running checks\.?$"].iter().map(|p| JsRegex::new_static(p, "")).collect()
    });
    let kept: Vec<&str> = stderr.lines().filter(|l| !js_trim(l).is_empty() && !banners.iter().any(|b| b.is_match(js_trim(l)))).collect();
    tail600(&kept.join("\n"))
}

#[derive(Default)]
struct Chunks {
    parts: Vec<Parsed>,
    /// Biome could not run: it did not start, timed out or was cancelled.
    failure: Option<String>,
    /// Biome exited non-zero without a report: its configuration or invocation was rejected.
    incomplete: Option<(i32, String)>,
    /// Files biome itself listed as "provided but ignored", with no diagnostic against them.
    ignored: Vec<String>,
    /// Files biome did not process and did not say were ignored (an unreadable file, a missing one).
    unexplained: Vec<String>,
    stderr: String,
}

impl Chunks {
    fn absorb_nested(&mut self, nested: Chunks) {
        self.parts.extend(nested.parts);
        self.stderr.push_str(&nested.stderr);
        self.failure = self.failure.take().or(nested.failure);
        self.incomplete = self.incomplete.take().or(nested.incomplete);
        self.ignored.extend(nested.ignored);
        self.unexplained.extend(nested.unexplained);
    }
}

/// Biome's own word on a file it could not read: a diagnostic against it in its file categories
/// (`internalError/io` up to 2.5; `fs/io` and `fs/cantRead` from 2.6).
fn could_not_read<'a>(diagnostics: &'a [Diagnostic], file: &str) -> Option<&'a Diagnostic> {
    diagnostics.iter().find(|d| d.file == normalize_path(file) && (d.code.starts_with("internalError/") || d.code.starts_with("fs/")))
}

fn normalize_path(path: &str) -> String {
    let p = path.replace('\\', "/");
    p.strip_prefix("./").unwrap_or(&p).to_owned()
}

/// The paths biome's own "These paths were provided but ignored:" stderr block names.
fn ignored_paths(stderr: &str) -> Vec<String> {
    let mut lines = stderr.lines().map(js_trim).skip_while(|l| !l.contains("provided but ignored"));
    lines.next();
    lines.filter_map(|l| l.strip_prefix("- ")).map(|p| normalize_path(js_trim(p))).collect()
}

/// `biome check` over `files`, a group at a time, with `line_ending` added for the files that need it said.
fn run_json_chunks<'a>(req: &'a RunRequest, files: &'a [String], files_per_spawn: usize, line_ending: &'a [&'a str]) -> std::pin::Pin<Box<dyn std::future::Future<Output = Chunks> + Send + 'a>> {
    Box::pin(async move {
        let mut out = Chunks::default();
        for chunk in chunk_files(files, files_per_spawn) {
            // A run that stopped says nothing about the files it had not reached.
            if out.failure.is_some() {
                break;
            }
            let args: Vec<String> = req.args.iter().cloned().chain(BIOME_CHECK_ARGS.iter().chain(line_ending).map(|flag| (*flag).to_owned())).chain(chunk.iter().map(|file| path_arg(file))).collect();
            let result = req.spawn.run(&req.bin, &args, &req.cwd, req.timeout, req.cancel.as_ref(), None, None).await;
            out.stderr.push_str(&result.stderr);
            if let Some(why) = stopped(req, "biome", &result) {
                out.failure = Some(why);
                break;
            }
            // A truncated answer is split in half and re-run so every diagnostic is seen.
            if result.truncated && chunk.len() > 1 {
                let nested = run_json_chunks(req, &chunk, chunk.len().div_ceil(2), line_ending).await;
                out.absorb_nested(nested);
                continue;
            }
            let parsed = parse_biome_json(&result.stdout, &req.cwd, result.truncated);
            if !result.truncated {
                if parsed.processed.is_none() && result.code != 0 && js_trim(&result.stdout).is_empty() {
                    out.incomplete.get_or_insert((result.code, result.stderr.clone()));
                    continue;
                }
                if let Some(n) = parsed.processed.filter(|n| (*n as usize) < chunk.len()) {
                    // Biome lists the paths it ignored only when it processed nothing, so a partly
                    // processed set is split until each leftover file is asked about alone.
                    if n > 0 && chunk.len() > 1 {
                        let nested = run_json_chunks(req, &chunk, chunk.len().div_ceil(2), line_ending).await;
                        out.absorb_nested(nested);
                        continue;
                    }
                    let listed = ignored_paths(&result.stderr);
                    for file in &chunk {
                        let has_diagnostic = parsed.diagnostics.iter().any(|d| d.file == normalize_path(file));
                        if listed.contains(&normalize_path(file)) && !has_diagnostic {
                            out.ignored.push(file.clone());
                        } else {
                            out.unexplained.push(file.clone());
                        }
                    }
                }
            }
            out.parts.push(parsed);
        }
        out
    })
}

pub struct Biome;

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    const CWD: &str = "/r";

    fn doc() -> String {
        json!({"summary": {"diagnosticsNotPrinted": 0}, "diagnostics": [
            {"category": "format", "severity": "error", "description": "Formatter  would\nhave printed", "location": {"path": {"file": "/r/a.ts"}}},
            {"category": "lint/style/useConst", "severity": "warning", "description": "Use const.", "tags": ["fixable"], "location": {"path": {"file": "/r/a.ts"}, "span": [4, 6], "sourceCode": "ab\ncd\nef"}, "suggestions": [1]},
            {"category": "lint/suspicious/noExplicitAny", "severity": "error", "description": "No any", "location": {"path": "/r/b.ts"}, "suggestions": []},
        ]}).to_string()
    }

    #[test]
    fn json_is_parsed_with_positions_fix_kinds_and_counts() {
        let p = parse_biome_json(&doc(), Path::new(CWD), false);
        assert_eq!(p.changed_files, ["a.ts"]);
        let d = &p.diagnostics;
        assert_eq!(d[0].message, "Formatter would have printed");
        assert_eq!((d[1].line, d[1].col, d[1].fix_kind.as_deref(), d[1].fixable), (2, 2, Some("safe"), true));
        assert_eq!((d[2].code_fix, d[2].file.as_str()), (Some(false), "b.ts"));
        let mut diags = p.diagnostics.clone();
        apply_biome_fix_kinds(&mut diags, &HashMap::from([("noExplicitAny".to_owned(), "none".to_owned())]));
        assert_eq!(diags[2].fix_kind.as_deref(), Some("manual"));
        let counts = biome_counts(&diags, &p.changed_files);
        assert_eq!((counts["bySeverity"]["error"].clone(), counts["byFixability"]["fixable"].clone(), counts["filesToFormat"].clone()), (json!(2), json!(2), json!(1)));
    }

    #[test]
    fn a_truncated_document_recovers_complete_rows_and_flags_the_gap() {
        let full = doc();
        let cut = &full[..full.rfind("{\"category\":\"lint/suspicious").unwrap() + 20];
        let p = parse_biome_json(cut, Path::new(CWD), true);
        assert!(p.truncated);
        assert_eq!(p.diagnostics.len(), 2);
        assert!(parse_biome_json("garbage { oops", Path::new(CWD), false).truncated);
        assert!(!parse_biome_json("", Path::new(CWD), false).truncated);
        let omitted = json!({"summary": {"diagnosticsNotPrinted": 3}, "diagnostics": []}).to_string();
        assert!(parse_biome_json(&omitted, Path::new(CWD), false).truncated);
    }

    #[test]
    fn explain_output_and_stderr_banner_are_understood() {
        assert_eq!(parse_explain_fix("x\n- Fix: Unsafe\n"), "unsafe");
        assert_eq!(parse_explain_fix("- Fix: safe"), "safe");
        assert_eq!(parse_explain_fix("No fix available."), "none");
        assert_eq!(biome_stderr_tail("The `json` and `json-pretty` reporters are experimental\ncheck ━━━━\n× Some errors were emitted while running checks.\nreal problem"), "real problem");
        assert_eq!(rule_name("lint/style/useConst"), "useConst");
        assert_eq!(rule_name("format"), "");
    }

    /// Answers every spawn from a function of its argv.
    struct Reply(Box<dyn Fn(&[String]) -> crate::tidy::process::ProcessResult + Send + Sync>);

    #[test]
    fn a_format_row_for_a_file_that_does_not_parse_is_not_a_planned_rewrite() {
        let rows = json!({"diagnostics": [
            {"category": "parse", "severity": "error", "description": "Expected an expression", "location": {"path": {"file": "/r/p.ts"}}},
            {"category": "format", "severity": "error", "description": "Code formatting aborted due to parsing errors.", "location": {"path": {"file": "/r/p.ts"}}},
            {"category": "format", "severity": "error", "description": "Formatter would have printed", "location": {"path": {"file": "/r/q.ts"}}},
        ]})
        .to_string();
        let mut p = parse_biome_json(&rows, Path::new(CWD), false);
        assert_eq!(p.changed_files, ["q.ts"]);
        apply_biome_fix_kinds(&mut p.diagnostics, &HashMap::new());
        let fixable: Vec<&str> = p.diagnostics.iter().filter(|d| d.fixable).map(|d| d.file.as_str()).collect();
        assert_eq!(fixable, ["q.ts"]);
        assert_eq!(biome_counts(&p.diagnostics, &p.changed_files)["filesToFormat"], 1);
    }

    struct Splitting(std::sync::Mutex<Vec<usize>>);


    #[async_trait]
    impl Spawn for Reply {
        async fn run(&self, _: &str, args: &[String], _: &Path, _: std::time::Duration, _: Option<&tokio_util::sync::CancellationToken>, _: Option<&HashMap<String, String>>, _: Option<Vec<u8>>) -> crate::tidy::process::ProcessResult {
            (self.0)(args)
        }
    }
    /// A directory holding `files`, each one line that ends with LF: Biome is told how a file ends
    /// its lines, which tidy reads from the file.
    fn on_disk(files: &[String]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for file in files {
            std::fs::write(dir.path().join(file), "x\n").unwrap();
        }
        dir
    }

    /// The files a fake Biome was given: what follows the command's three flags and the line ending.
    fn given(args: &[String]) -> Vec<&String> {
        assert_eq!(args[3], "--line-ending=lf");
        args.iter().skip(4).collect()
    }

    fn request(files: &[&str], reply: impl Fn(&[String]) -> crate::tidy::process::ProcessResult + Send + Sync + 'static) -> (tempfile::TempDir, RunRequest) {
        let files: Vec<String> = files.iter().map(|f| (*f).to_owned()).collect();
        let dir = on_disk(&files);
        let req = RunRequest::new(dir.path(), "biome", files, std::sync::Arc::new(Reply(Box::new(reply))), mixdog_rt::testing::tokens().durability_io);
        (dir, req)
    }
    #[tokio::test]
    async fn a_file_biome_did_not_process_is_ignored_not_checked_and_a_rejected_config_is_a_failure() {
        use crate::tidy::process::ProcessResult;
        // Biome processes everything but `ignored.ts`; with nothing processed it exits 1 and names no file.
        let by_config = |args: &[String]| {
            let files = given(args);
            let processed = files.iter().filter(|f| f.as_str() != "ignored.ts" && f.as_str() != "unreadable.ts").count();
            let rows: Vec<Value> = files.iter().filter(|f| f.as_str() == "unreadable.ts").map(|f| json!({"category": "internalError/io", "severity": "error", "description": "stream did not contain valid UTF-8", "location": {"path": f}})).collect();
            let stdout = json!({"summary": {"changed": 0, "unchanged": processed}, "diagnostics": rows}).to_string();
            // Biome names the paths only when nothing at all was processed; it names unreadable ones too.
            let stderr = if processed == 0 { format!("  × No files were processed in the specified paths.\n  \n  i These paths were provided but ignored:\n  \n{}", files.iter().map(|f| format!("  - {f}\n")).collect::<String>()) } else { String::new() };
            ProcessResult { stdout, stderr, code: i32::from(processed == 0), ..Default::default() }
        };
        let mixed = Biome.check(&request(&["a.ts", "ignored.ts", "b.ts"], by_config).1).await;
        assert_eq!((mixed.files_checked, mixed.ignored.clone(), mixed.error.clone()), (Some(2), vec!["ignored.ts".to_owned()], None));
        let only = Biome.check(&request(&["ignored.ts"], by_config).1).await;
        assert_eq!((only.files_checked, only.ignored.clone(), only.error.clone()), (Some(0), vec!["ignored.ts".to_owned()], None));
        // Biome lists an unreadable file as "ignored" too, but with an error against it: unprocessed
        // for the reason that error gives, with the diagnostic kept.
        let unreadable = Biome.check(&request(&["a.ts", "unreadable.ts"], by_config).1).await;
        assert_eq!(unreadable.unprocessed, [("unreadable.ts".to_owned(), "stream did not contain valid UTF-8".to_owned())]);
        assert_eq!((unreadable.files_checked, unreadable.ignored.is_empty(), unreadable.diagnostics.iter().map(|d| d.code.as_str()).collect::<Vec<_>>()), (Some(1), true, vec!["internalError/io"]));
        // A file tidy itself cannot read is not handed to Biome.
        let (dir, mut gone) = request(&["a.ts"], by_config);
        gone.files.push("gone.ts".to_owned());
        let missing = Biome.check(&gone).await;
        assert_eq!((missing.files_checked, missing.unprocessed.iter().map(|(file, _)| file.as_str()).collect::<Vec<_>>()), (Some(1), vec!["gone.ts"]));
        drop(dir);
        // An invalid biome.json: exit 1, no report at all.
        let rejected = Biome.check(&request(&["a.ts"], |_| ProcessResult { code: 1, stderr: "biome.json:1:11 deserialize\n\n  × Found an unknown key `bogus`.".into(), ..Default::default() }).1).await;
        assert!(rejected.error.as_deref().is_some_and(|e| e.contains("unknown key")), "{:?}", rejected.error);
        assert!(rejected.files_checked.is_none() && rejected.diagnostics.is_empty());
    }
    #[async_trait]
    impl Spawn for Splitting {
        async fn run(&self, _: &str, args: &[String], _: &Path, _: std::time::Duration, _: Option<&tokio_util::sync::CancellationToken>, _: Option<&HashMap<String, String>>, _: Option<Vec<u8>>) -> crate::tidy::process::ProcessResult {
            if args.first().map(String::as_str) == Some("explain") {
                return crate::tidy::process::ProcessResult { stdout: "- Fix: safe".into(), ..Default::default() };
            }
            let files = given(args);
            self.0.lock().unwrap().push(files.len());
            // More than two files overflows the capture; each file alone reports one diagnostic.
            if files.len() > 2 {
                return crate::tidy::process::ProcessResult { stdout: "{\"diagnostics\":[{\"category\":\"format\"".into(), truncated: true, ..Default::default() };
            }
            let rows: Vec<Value> = files.iter().map(|f| json!({"category": "format", "severity": "error", "description": "d", "location": {"path": f}})).collect();
            crate::tidy::process::ProcessResult { stdout: json!({"diagnostics": rows}).to_string(), ..Default::default() }
        }
    }
    #[tokio::test]
    async fn a_fix_that_leaves_findings_is_applied_and_one_biome_refuses_is_not() {
        use crate::tidy::process::ProcessResult;
        // Findings remain after the fixes: exit 1, with a report that counts the one file processed.
        let remaining = |args: &[String]| {
            assert_eq!(&args[..5], ["check", "--write", "--reporter=json", "--max-diagnostics=none", "--line-ending=lf"]);
            ProcessResult { code: 1, stdout: json!({"summary": {"changed": 1, "unchanged": 0, "errors": 1}, "diagnostics": []}).to_string(), stderr: "× Some errors were emitted while applying fixes.".into(), ..Default::default() }
        };
        let applied = Biome.fix(&request(&["a.ts"], remaining).1).await;
        assert_eq!((applied.error, applied.unprocessed.len(), applied.files_checked), (None, 0, Some(1)));
        // The same report for two files leaves one of them unaccounted for: neither counts as fixed.
        let partial = Biome.fix(&request(&["a.ts", "b.ts"], remaining).1).await;
        assert_eq!((partial.files_checked, partial.unprocessed.len()), (Some(0), 2));
        assert!(partial.unprocessed[0].1.contains("biome processed 1 of the 2 files"), "{:?}", partial.unprocessed);
        let rejected = Biome.fix(&request(&["a.ts", "b.ts"], |_| ProcessResult { code: 1, stderr: "biome.json:1:2 deserialize\n  × Found an unknown key `bogus`.".into(), ..Default::default() }).1).await;
        assert!(rejected.error.as_deref().is_some_and(|e| e.contains("unknown key")), "{:?}", rejected.error);
        // Biome exits 0 after writing one file and failing to open the other, as 2.5.13 does: the
        // file it names is unprocessed for the reason it gives, and the other is written.
        let one_gone = |args: &[String]| {
            let rows = json!([{"category": "internalError/io", "severity": "error", "description": "The system cannot find the file specified.", "location": {"path": &args[6]}}]);
            ProcessResult { stdout: json!({"summary": {"changed": 1, "unchanged": 0, "errors": 1}, "diagnostics": rows}).to_string(), ..Default::default() }
        };
        let skipped = Biome.fix(&request(&["a.ts", "b.ts"], one_gone).1).await;
        assert_eq!((skipped.files_checked, skipped.unprocessed, skipped.error), (Some(1), vec![("b.ts".to_owned(), "The system cannot find the file specified.".to_owned())], None));
        // A file it cannot decode it counts as unchanged and as skipped (2.6.8 names it under `fs/io`):
        // with a.ts written, the two account for a group of two, and not for one of three, whose third
        // file (one its configuration left out) the report does not name.
        let undecodable = |args: &[String]| {
            let rows = json!([{"category": "fs/io", "severity": "error", "description": "stream did not contain valid UTF-8", "location": {"path": &args[6]}}]);
            ProcessResult { stdout: json!({"summary": {"changed": 1, "unchanged": 1, "skipped": 1}, "diagnostics": rows}).to_string(), ..Default::default() }
        };
        let two = Biome.fix(&request(&["a.ts", "b.ts"], undecodable).1).await;
        assert_eq!((two.files_checked, two.unprocessed), (Some(1), vec![("b.ts".to_owned(), "stream did not contain valid UTF-8".to_owned())]));
        let three = Biome.fix(&request(&["a.ts", "b.ts", "c.ts"], undecodable).1).await;
        assert_eq!((three.files_checked, three.unprocessed.len()), (Some(0), 3));
        assert!(three.unprocessed[0].1.contains("biome processed 1 of the 3 files") && three.unprocessed[2].1 == three.unprocessed[0].1, "{:?}", three.unprocessed);
        assert_eq!(three.unprocessed[1], ("b.ts".to_owned(), "stream did not contain valid UTF-8".to_owned()));
    }

    #[tokio::test]
    async fn a_truncated_chunk_is_halved_until_every_file_is_covered() {
        let spawn = std::sync::Arc::new(Splitting(Default::default()));
        let files: Vec<String> = (0..5).map(|n| format!("f{n}.ts")).collect();
        let dir = on_disk(&files);
        let req = RunRequest::new(dir.path(), "biome", files, spawn.clone(), mixdog_rt::testing::tokens().durability_io);
        let out = Biome.check(&req).await;
        assert!(!out.truncated);
        assert_eq!(out.changed_files.len(), 5);
        assert_eq!(out.counts.unwrap()["filesToFormat"], 5);
        assert_eq!(spawn.0.lock().unwrap()[0], 5, "the whole set is tried first");
    }
}


const EXPLAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
#[async_trait]
impl Runner for Biome {
    fn id(&self) -> &'static str {
        "biome"
    }

    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let files = match files_by_line_ending(req, "biome").await {
            Ok(files) => files,
            Err(why) => return engine_stopped(why),
        };
        let mut result = Chunks::default();
        for (group, line_ending) in [(&files.lf, BIOME_LINE_ENDINGS.lf), (&files.crlf, BIOME_LINE_ENDINGS.crlf)] {
            // With no path biome checks the whole directory.
            if !group.is_empty() && result.failure.is_none() {
                result.absorb_nested(run_json_chunks(req, group, req.files_per_spawn, line_ending).await);
            }
        }
        if let Some(why) = result.failure {
            return engine_stopped(why);
        }
        if let Some((code, stderr)) = &result.incomplete {
            let detail = biome_stderr_tail(stderr);
            return RunnerResult { error: Some(format!("biome exited {code} without completing: {detail}")), stderr_tail: detail, ..Default::default() };
        }
        let mut parsed = merge_biome_parses(result.parts);
        let mut names: Vec<String> = parsed.diagnostics.iter().map(|f| rule_name(&f.code)).filter(|n| !n.is_empty()).collect();
        names.sort();
        names.dedup();
        let kinds: HashMap<String, String> = map_limit(names, EXPLAIN_CONCURRENCY, |name| async move {
            let args = vec!["explain".to_owned(), name.clone()];
            let r = req.spawn.run(&req.bin, &args, &req.cwd, EXPLAIN_TIMEOUT, req.cancel.as_ref(), None, None).await;
            (name, parse_explain_fix(&format!("{}\n{}", r.stdout, r.stderr)).to_owned())
        })
        .await
        .into_iter()
        .collect();
        apply_biome_fix_kinds(&mut parsed.diagnostics, &kinds);
        // Biome's reason for a file it did not process is what it reported against it.
        let reason = |file: &String| {
            let against = could_not_read(&parsed.diagnostics, file).or_else(|| parsed.diagnostics.iter().find(|d| d.file == normalize_path(file) && d.severity == "error"));
            against.map_or_else(|| "biome did not process it and gave no reason".to_owned(), |d| d.message.clone())
        };
        let unprocessed: Vec<(String, String)> = result.unexplained.iter().map(|file| (file.clone(), reason(file))).chain(files.unreadable).collect();
        RunnerResult {
            counts: Some(biome_counts(&parsed.diagnostics, &parsed.changed_files)),
            stderr_tail: biome_stderr_tail(&result.stderr),
            truncated: parsed.truncated,
            note: parsed.truncated.then(|| BIOME_TRUNCATED_NOTE.to_owned()),
            diagnostics: parsed.diagnostics,
            changed_files: parsed.changed_files,
            files_checked: Some(req.files.len() - result.ignored.len() - unprocessed.len()),
            ignored: result.ignored,
            unprocessed,
            ..Default::default()
        }
    }

    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let pass = write(req).await;
        RunnerResult { stderr_tail: biome_stderr_tail(&pass.stderr), ..pass.into_result() }
    }
}

/// `biome check --write` over the files. Biome's exit code does not say what it wrote: it exits 1
/// when findings remain after its fixes and for a configuration it rejects, and 0 after skipping
/// a file it could not read. Its report does: the summary counts the files it processed, and a
/// file it could not read has a diagnostic against it. A group is settled when those two account
/// for every file; a file left over (one its configuration came to exclude) has no name in the
/// report, so every file of the group is then unprocessed, for the reason biome gave it or, where
/// it gave none, for that.
async fn write(req: &RunRequest) -> Pass {
    let wrote = |r: &crate::tidy::process::ProcessResult, files: &[String]| {
        let report = parse_biome_json(&r.stdout, &req.cwd, r.truncated);
        let left_out: Vec<(String, String)> = files.iter().filter_map(|file| could_not_read(&report.diagnostics, file).map(|d| (file.clone(), d.message.clone()))).collect();
        match report.processed {
            Some(n) if n + left_out.len() as i64 >= files.len() as i64 => Batch::Partly(Findings::default(), left_out),
            // Which of the others it left out it does not say: each file keeps the reason biome
            // gave for it, and the rest share what is known.
            Some(n) => {
                let unknown = format!("biome processed {n} of the {} files it was given and did not say which", files.len());
                let reason = |file: &String| left_out.iter().find(|(named, _)| named == file).map_or_else(|| unknown.clone(), |(_, why)| why.clone());
                Batch::Partly(Findings::default(), files.iter().map(|file| (file.clone(), reason(file))).collect())
            }
            None if r.truncated => Batch::Incomplete("biome printed more than tidy captures, its summary included".to_owned()),
            // No report at all: biome rejected its configuration or the invocation.
            None => Batch::Refused(said(r)),
        }
    };
    let call = |line_ending: &[&str], files: &[String]| Invocation::over(req, &[&["check", "--write", "--reporter=json", "--max-diagnostics=none"][..], line_ending].concat(), files);
    run_by_line_ending(req, "biome", Command::Writes, &BIOME_LINE_ENDINGS, &call, &wrote).await
}
