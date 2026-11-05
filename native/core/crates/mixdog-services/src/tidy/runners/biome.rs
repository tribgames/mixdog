//! Biome — JSON reporter for check, `--write` (1.x: `--apply`) for fix. Output can be huge and
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
pub const BIOME_TRUNCATED_NOTE: &str = "biome JSON output was truncated; split the scope and re-run to get complete diagnostics";
const EXPLAIN_CONCURRENCY: usize = 4;
const EXPLAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

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
        if f.code.starts_with("format") {
            f.fix_kind = Some("safe".into());
            f.fixable = true;
            continue;
        }
        if f.code_fix == Some(false) {
            f.fix_kind = Some("manual".into());
            f.fixable = false;
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
    for row in rows {
        let category = row.get("category").and_then(Value::as_str).or_else(|| row.pointer("/code/value").and_then(Value::as_str)).or_else(|| row.get("code").and_then(Value::as_str)).unwrap_or("");
        let (file, line, col) = location_of(row, cwd);
        if category.starts_with("format") {
            changed.push(file.clone());
        }
        let kind = payload_fix_kind(row, category);
        let rdjson = row.pointer("/code/value").is_some_and(Value::is_string);
        let code_fix = if category.starts_with("format") {
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
    Parsed { diagnostics, changed_files: unique_paths(changed), truncated }
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
    for doc in &docs {
        rows.extend(doc.get("diagnostics").and_then(Value::as_array).cloned().unwrap_or_default());
        if number(doc.pointer("/summary/diagnosticsNotPrinted")) > 0 {
            omitted = true;
        }
    }
    rows_to_result(&rows, cwd, truncated_input || parse_truncated || omitted)
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

struct Chunks {
    parts: Vec<Parsed>,
    failure: Option<Chunked>,
    stderr: String,
}

fn run_json_chunks<'a>(req: &'a RunRequest, files: &'a [String], files_per_spawn: usize) -> std::pin::Pin<Box<dyn std::future::Future<Output = Chunks> + Send + 'a>> {
    Box::pin(async move {
        let mut out = Chunks { parts: Vec::new(), failure: None, stderr: String::new() };
        for chunk in chunk_files(files, files_per_spawn) {
            let args: Vec<String> = req.args.iter().cloned().chain(BIOME_CHECK_ARGS.map(String::from)).chain(chunk.iter().cloned()).collect();
            let result = req.spawn.run(&req.bin, &args, &req.cwd, req.timeout, req.cancel.as_ref(), None, None).await;
            out.stderr.push_str(&result.stderr);
            if !result.error.is_empty() && out.failure.is_none() {
                out.failure = Some(Chunked { code: result.code, stdout: String::new(), stderr: result.stderr.clone(), timed_out: result.timed_out, truncated: false, error: result.error.clone() });
            }
            // A truncated answer is split in half and re-run so every diagnostic is seen.
            if result.error.is_empty() && result.truncated && chunk.len() > 1 {
                let nested = run_json_chunks(req, &chunk, chunk.len().div_ceil(2)).await;
                out.parts.extend(nested.parts);
                out.stderr.push_str(&nested.stderr);
                if out.failure.is_none() {
                    out.failure = nested.failure;
                }
                continue;
            }
            out.parts.push(parse_biome_json(&result.stdout, &req.cwd, result.truncated));
        }
        out
    })
}

pub struct Biome;

#[async_trait]
impl Runner for Biome {
    fn id(&self) -> &'static str {
        "biome"
    }

    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let result = run_json_chunks(req, &req.files, req.files_per_spawn).await;
        if let Some(failure) = &result.failure {
            return spawn_failure("biome", failure);
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
        RunnerResult {
            counts: Some(biome_counts(&parsed.diagnostics, &parsed.changed_files)),
            stderr_tail: biome_stderr_tail(&result.stderr),
            truncated: parsed.truncated,
            note: parsed.truncated.then(|| BIOME_TRUNCATED_NOTE.to_owned()),
            diagnostics: parsed.diagnostics,
            changed_files: parsed.changed_files,
            ..Default::default()
        }
    }

    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let legacy = JsRegex::new_static(r"unexpected argument|unrecognized|unknown (?:option|argument)", "i");
        let mut r = run_chunked(req, &args_with(req, &["check", "--write", "--max-diagnostics=none"]), &req.files, false).await;
        if r.code != 0 && legacy.is_match(&r.stderr) {
            r = run_chunked(req, &args_with(req, &["check", "--apply", "--max-diagnostics=none"]), &req.files, false).await;
        }
        if !r.error.is_empty() {
            return spawn_failure("biome", &r);
        }
        RunnerResult::default().with_stderr(biome_stderr_tail(&r.stderr))
    }
}

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

    struct Splitting(std::sync::Mutex<Vec<usize>>);

    #[async_trait]
    impl Spawn for Splitting {
        async fn run(&self, _: &str, args: &[String], _: &Path, _: std::time::Duration, _: Option<&tokio_util::sync::CancellationToken>, _: Option<&HashMap<String, String>>, _: Option<Vec<u8>>) -> crate::tidy::process::ProcessResult {
            if args.first().map(String::as_str) == Some("explain") {
                return crate::tidy::process::ProcessResult { stdout: "- Fix: safe".into(), ..Default::default() };
            }
            let files: Vec<&String> = args.iter().skip(3).collect();
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
    async fn a_truncated_chunk_is_halved_until_every_file_is_covered() {
        let spawn = std::sync::Arc::new(Splitting(Default::default()));
        let files: Vec<String> = (0..5).map(|n| format!("f{n}.ts")).collect();
        let mut req = RunRequest::new(Path::new(CWD), "biome", files);
        req.spawn = spawn.clone();
        let out = Biome.check(&req).await;
        assert!(!out.truncated);
        assert_eq!(out.changed_files.len(), 5);
        assert_eq!(out.counts.unwrap()["filesToFormat"], 5);
        assert_eq!(spawn.0.lock().unwrap()[0], 5, "the whole set is tried first");
    }
}
