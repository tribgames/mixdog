//! Structural rules adapter. mixdog-graph is the only structural engine: it embeds the ast-grep
//! crates, so the rule packs run against the same grammars the code graph parses with.
//!
//! `mixdog-graph <cwd> --scan --rules - [--files …] [--fix]`: rules YAML on stdin, JSONL on stdout,
//! a final `{"summary":…}` line; exit 0 ok / 1 internal / 2 usage or rule-parse; positions are
//! zero-based. Positions normalize to 1-based line/column and byte offsets stay verbatim because
//! apply edits by byte range. The engine never writes: tidy takes the fix payloads and applies them
//! through the write pipeline.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::lane::on_lane;

use super::apply::sha256_hex;
use super::history_comment::refine_history_comment_matches;
use super::languages::{files_for_languages, parse_graph_langs};
use super::process::{MAX_CAPTURE_BYTES, ProcessResult, Processes, RunOptions};
use super::rule_files::RULE_FILES;

/// The deadline a `--langs` probe has in production.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const STRUCTURAL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
pub struct RulePack {
    pub id: String,
    pub languages: Vec<String>,
    pub rules: Vec<String>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct RuleGroup {
    pub language: String,
    pub packs: Vec<String>,
    pub rules_text: String,
}

/// Values of a top-level `key:` in each rule document. Indented keys belong to nested mappings
/// (a rewriter's `id:`), not to the rule.
fn scan_ids(text: &str, key: &str) -> Vec<String> {
    let pattern = format!(r#"^{key}:[ \t]*["']?([\w.+#-]+)["']?[ \t]*\r?$"#);
    mixdog_js::JsRegex::new_static(&pattern, "m").captures_iter(text).filter_map(|c| c.get(1).map(str::to_owned)).collect()
}

/// Loads the shipped rule packs from `files` (relative path, YAML text). An empty set is simply
/// "no structural rules".
pub fn load_rule_packs_from(files: &[(&str, &str)]) -> (Vec<RulePack>, Vec<RuleGroup>) {
    let mut sorted: Vec<&(&str, &str)> = files.iter().filter(|(_, t)| !mixdog_js::js_trim(t).is_empty()).collect();
    sorted.sort_by_key(|(p, _)| *p);
    let packs: Vec<RulePack> = sorted
        .into_iter()
        .map(|(path, text)| {
            let mut languages: Vec<String> = Vec::new();
            for l in scan_ids(text, "language").into_iter().map(|l| l.to_lowercase()) {
                if !languages.contains(&l) {
                    languages.push(l);
                }
            }
            let id = path.trim_end_matches(".yml").trim_end_matches(".yaml").to_owned();
            RulePack { id, languages, rules: scan_ids(text, "id"), text: mixdog_js::js_trim(text).to_owned() }
        })
        .collect();
    let groups = group_rule_packs(&packs);
    (packs, groups)
}

pub fn load_rule_packs() -> (Vec<RulePack>, Vec<RuleGroup>) {
    load_rule_packs_from(RULE_FILES)
}

/// Rule packs grouped by language, because a scan takes one rule document and a single bad rule
/// fails all of it: a `kind:` a grammar does not have makes the engine exit 2 with zero matches
/// for every language in that document.
pub fn group_rule_packs(packs: &[RulePack]) -> Vec<RuleGroup> {
    let mut groups: Vec<(String, Vec<&RulePack>)> = Vec::new();
    for pack in packs {
        let language = pack
            .languages
            .first()
            .cloned()
            .or_else(|| pack.id.split('/').next().filter(|s| !s.is_empty()).map(str::to_owned))
            .unwrap_or_else(|| "other".into());
        match groups.iter_mut().find(|(l, _)| *l == language) {
            Some((_, members)) => members.push(pack),
            None => groups.push((language, vec![pack])),
        }
    }
    groups
        .into_iter()
        .map(|(language, members)| RuleGroup {
            language,
            packs: members.iter().map(|p| p.id.clone()).collect(),
            rules_text: members.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n---\n"),
        })
        .collect()
}

/// `.tsx` is where the scan grammar and the detection id diverge: the binary calls a .tsx file
/// `typescript`, while the scan parses it with the `tsx` grammar, so the tsx packs have to run
/// whenever typescript is in scope.
fn group_aliases(language: &str) -> &'static [&'static str] {
    if language == "tsx" { &["typescript"] } else { &[] }
}

/// Rule groups that can apply to `languages`; an empty list means all.
pub fn groups_for_languages<'a>(groups: &'a [RuleGroup], languages: &[String]) -> Vec<&'a RuleGroup> {
    groups
        .iter()
        .filter(|g| languages.is_empty() || languages.contains(&g.language) || group_aliases(&g.language).iter().any(|a| languages.iter().any(|l| l == a)))
        .collect()
}

/// Packs that can apply to `languages`, with the same `tsx`→`typescript` alias scans use; an empty list means all.
pub fn packs_for_languages<'a>(packs: &'a [RulePack], languages: &[String]) -> Vec<&'a RulePack> {
    packs
        .iter()
        .filter(|p| {
            languages.is_empty() || p.languages.iter().any(|l| languages.contains(l) || group_aliases(l).iter().any(|a| languages.iter().any(|x| x == a)))
        })
        .collect()
}

/// Files one structural language group should scan; never an unfiltered tree.
pub fn files_for_structural_group(files: &[String], group: &RuleGroup, extensions: Option<&HashMap<String, String>>) -> Vec<String> {
    if group.language == "tsx" {
        return files.iter().filter(|f| f.to_lowercase().ends_with(".tsx")).cloned().collect();
    }
    let wanted: Vec<String> = std::iter::once(group.language.clone()).chain(group_aliases(&group.language).iter().map(|s| (*s).to_owned())).collect();
    files_for_languages(files, &wanted, extensions)
}

fn one_based(v: &Value) -> i64 {
    v.as_f64().filter(|n| n.is_finite()).map_or(0, |n| n as i64 + 1)
}

fn byte_range(source: &Value) -> Option<(i64, i64)> {
    let pair = match source {
        Value::Array(a) => (a.first()?.as_f64()?, a.get(1)?.as_f64()?),
        Value::Object(o) => {
            let at = |k: &str, i: usize| o.get(k).or_else(|| o.get(&i.to_string())).and_then(Value::as_f64);
            (at("start", 0)?, at("end", 1)?)
        }
        _ => return None,
    };
    Some((pair.0 as i64, pair.1 as i64))
}

/// Why a fix without the scanner's digest is never written.
const NO_SCAN_DIGEST: &str = "the scanner did not send the SHA-256 of the file it parsed (a mixdog-graph build from before fix digests), so the fix cannot be checked against the bytes it was computed for";

/// The fix payload, with `scanned`: the scanner's SHA-256 of the exact bytes it parsed, which apply
/// requires the file to still hash to. A fix without it is `stale`.
fn normalize_fix(raw: &Value, range: Option<(i64, i64)>) -> Value {
    let stamped = |mut fix: Value, digest: Option<&str>| {
        match digest.filter(|d| !d.is_empty()) {
            Some(d) => fix["scanned"] = json!(d),
            None => fix["stale"] = json!(NO_SCAN_DIGEST),
        }
        fix
    };
    match raw {
        Value::Null => Value::Null,
        Value::String(s) => range.map_or(Value::Null, |r| stamped(json!({"byteOffset": [r.0, r.1], "text": s}), None)),
        _ => {
            let offset = raw.get("byteOffset").or_else(|| raw.get("range")).or_else(|| raw.get("span")).and_then(byte_range).or(range);
            let text = ["text", "replacement"].iter().find_map(|k| raw.get(*k).and_then(Value::as_str));
            match (offset, text) {
                (Some(o), Some(t)) => stamped(json!({"byteOffset": [o.0, o.1], "text": t}), raw.get("sha256").and_then(Value::as_str)),
                _ => Value::Null,
            }
        }
    }
}

fn first_str<'a>(row: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter().find_map(|k| row.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty())).unwrap_or("")
}

/// Normalizes one graph JSONL row into the adapter match shape; `None` without a usable position.
pub fn normalize_structural_match(row: &Value, zero_based: bool) -> Option<Value> {
    let obj = row.as_object()?;
    let file = first_str(row, &["file", "rel", "path"]).replace('\\', "/");
    if file.is_empty() {
        return None;
    }
    let raw_range = obj.get("range").or_else(|| obj.get("position")).cloned().unwrap_or(Value::Null);
    let (start, end) = (raw_range.get("start").cloned().unwrap_or(Value::Null), raw_range.get("end").cloned().unwrap_or(Value::Null));
    let shift = |v: &Value| if zero_based { one_based(v) } else { v.as_f64().map_or(0, |n| n as i64) };
    let column = |p: &Value| p.get("column").or_else(|| p.get("col")).cloned().unwrap_or(Value::Null);
    let offsets = raw_range.get("byteOffset").or_else(|| raw_range.get("byteOffsets")).or_else(|| row.get("byteOffset")).and_then(byte_range).or_else(|| {
        let (s, e) = (start.get("byteOffset").and_then(Value::as_f64)?, end.get("byteOffset").and_then(Value::as_f64)?);
        Some((s as i64, e as i64))
    });
    let mut range = json!({"start": {"line": shift(start.get("line").unwrap_or(&Value::Null)), "column": shift(&column(&start))},
                           "end": {"line": shift(end.get("line").unwrap_or(&Value::Null)), "column": shift(&column(&end))}});
    if let Some(o) = offsets {
        range["byteOffset"] = json!([o.0, o.1]);
    }
    let severity = Some(first_str(row, &["severity"])).filter(|s| !s.is_empty()).map_or_else(|| "warning".to_owned(), str::to_lowercase);
    Some(json!({
        "file": file,
        "lang": first_str(row, &["lang", "language"]),
        "ruleId": first_str(row, &["ruleId", "rule", "id"]),
        "severity": severity,
        "message": mixdog_js::js_trim(first_str(row, &["message", "text"])),
        "range": range,
        "fix": normalize_fix(row.get("fix").filter(|v| !v.is_null()).or_else(|| row.get("replacement")).unwrap_or(&Value::Null), offsets),
    }))
}

fn stderr_error(exit_code: i32, kind: &str, stderr: &str, fallback: &str) -> Value {
    let message = mixdog_js::slice_utf16(mixdog_js::js_trim(stderr), 400);
    json!({"exitCode": exit_code, "kind": kind, "message": if message.is_empty() { fallback.to_owned() } else { message }})
}

/// Parses the graph binary's JSONL stream. The final `{"summary":…}` line is the run summary;
/// everything else is a match. Exit 2 is a usage or rule-parse error (the rule pack, not the file
/// set, is at fault).
pub fn parse_structural_jsonl(stdout: &str, exit_code: i32, stderr: &str) -> Value {
    if exit_code == 2 {
        return json!({"matches": [], "summary": {"matches": 0, "files": 0}, "error": stderr_error(exit_code, "rules", stderr, "rule parse or usage error")});
    }
    let (mut matches, mut summary, mut malformed) = (Vec::new(), None, 0);
    for line in stdout.lines().map(mixdog_js::js_trim).filter(|l| !l.is_empty()) {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            malformed += 1;
            continue;
        };
        if let Some(s) = row.get("summary").filter(|s| !s.is_null()) {
            summary = Some(s.clone());
            continue;
        }
        if let Some(m) = normalize_structural_match(&row, true) {
            matches.push(m);
        }
    }
    let files = matches.iter().filter_map(|m| m["file"].as_str()).collect::<std::collections::HashSet<_>>().len();
    let mut result = json!({"matches": matches, "summary": summary.clone().unwrap_or_else(|| json!({"matches": matches.len(), "files": files}))});
    // A scan-capable binary always emits the summary line, even for zero matches. Exit 0 with
    // empty stdout is what a pre-scan mixdog-graph does when it treats `--scan` as a symbol
    // search: that must never read as "no findings".
    if exit_code == 0 && summary.is_none() && matches.is_empty() {
        result["error"] = json!({"exitCode": 0, "kind": "protocol", "message": "structural scan produced no summary line; this mixdog-graph build does not own the --scan protocol"});
    } else if exit_code != 0 {
        result["error"] = stderr_error(exit_code, "internal", stderr, &format!("structural scan exited {exit_code}"));
    }
    if malformed > 0 {
        result["malformedLines"] = json!(malformed);
    }
    if result.get("error").is_some() {
        for m in result["matches"].as_array_mut().into_iter().flatten() {
            m["fix"] = Value::Null;
            m["manual"] = json!(true);
        }
    }
    result
}

fn probe_cache() -> &'static Mutex<HashMap<PathBuf, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

pub fn reset_structural_probe_cache() {
    probe_cache().lock().unwrap().clear();
}

/// Probes `mixdog-graph <cwd> --langs`. A clean exit is not proof: a binary from before the scan
/// mode exits 0 with no output. Only the language registry payload proves this binary owns the
/// scan protocol. Returns the table when it does.
pub async fn probe_graph_langs(processes: &Processes, bin: &Path, cwd: &Path, cancel: Option<&CancellationToken>) -> Option<super::languages::GraphLangs> {
    probe_graph_langs_within(processes, bin, cwd, Some(PROBE_TIMEOUT), cancel).await
}

/// [`probe_graph_langs`] under another deadline (`None`: none), for the tool's own tests.
pub(crate) async fn probe_graph_langs_within(
    processes: &Processes,
    bin: &Path,
    cwd: &Path,
    deadline: Option<Duration>,
    cancel: Option<&CancellationToken>,
) -> Option<super::languages::GraphLangs> {
    let bin_path = bin.to_owned();
    if !on_lane(processes.durability(), move || binary_exists(&bin_path)).await.unwrap_or(false) {
        return None;
    }
    let mut options = RunOptions::new(cwd);
    options.timeout = deadline.unwrap_or(Duration::ZERO);
    options.cancel = cancel;
    let result = processes.run(&bin.to_string_lossy(), &[cwd.to_string_lossy().into_owned(), "--langs".into()], options).await;
    if result.code != 0 || !result.error.is_empty() {
        return None;
    }
    parse_graph_langs(&result.stdout)
}

pub async fn graph_supports_scan(processes: &Processes, bin: &Path, cwd: &Path, cancel: Option<&CancellationToken>) -> bool {
    graph_supports_scan_within(processes, bin, cwd, Some(PROBE_TIMEOUT), cancel).await
}

pub(crate) async fn graph_supports_scan_within(
    processes: &Processes,
    bin: &Path,
    cwd: &Path,
    deadline: Option<Duration>,
    cancel: Option<&CancellationToken>,
) -> bool {
    if let Some(cached) = probe_cache().lock().unwrap().get(bin) {
        return *cached;
    }
    let supported = probe_graph_langs_within(processes, bin, cwd, deadline, cancel).await.is_some();
    probe_cache().lock().unwrap().insert(bin.to_owned(), supported);
    supported
}

#[derive(Debug, thiserror::Error)]
#[error("{}", structural_unavailable_message(bin))]
pub struct StructuralEngineUnavailable {
    pub bin: String,
}

/// Why structural rules cannot run, and what to do about it.
pub fn structural_unavailable_message(bin: &str) -> String {
    let wher = if bin.is_empty() { "no mixdog-graph binary was found".to_owned() } else { format!("\"{bin}\" does not answer `--langs`") };
    format!(
        "structural rules need a mixdog-graph build with the --scan mode: {wher}. Rebuild it (cargo build --release --manifest-path native/mixdog-graph/Cargo.toml) or update the packaged mixdog-graph native tool; pass structural:false to run only the formatters and linters."
    )
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn binary_exists(bin: &Path) -> bool {
    bin.exists()
}

/// Reads a file the scan reported. Blocking: used only inside a durability-lane job.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn scan_source_reader(cwd: PathBuf) -> impl Fn(&str) -> Option<Vec<u8>> {
    // The scan may report a file absolute, cwd-relative, or with either slash style.
    move |file: &str| {
        let rel = file.replace('\\', "/");
        let mut candidates: Vec<PathBuf> = Vec::new();
        if !rel.is_empty() {
            if Path::new(file).is_absolute() || Path::new(&rel).is_absolute() {
                candidates.push(PathBuf::from(file));
                candidates.push(PathBuf::from(&rel));
            }
            candidates.push(cwd.join(&rel));
            candidates.push(cwd.join(file));
        }
        candidates.into_iter().find_map(|c| std::fs::read(c).ok())
    }
}

/// What a scan run says about itself before its output is read: it could not start, ran out of
/// time, or its output was cut. Each leaves the matches incomplete.
fn run_failure(result: &ProcessResult) -> Option<Value> {
    if result.timed_out {
        return Some(json!({"exitCode": result.code, "kind": "timeout", "message": format!("structural scan {}; its matches are incomplete", result.error)}));
    }
    if !result.error.is_empty() && result.code == -1 {
        return Some(json!({"exitCode": -1, "kind": "spawn", "message": result.error}));
    }
    if result.truncated {
        return Some(
            json!({"exitCode": result.code, "kind": "truncated", "message": format!("structural scan output passed {MAX_CAPTURE_BYTES} bytes and was cut; split the scope")}),
        );
    }
    None
}

/// The scanner's digest of each file it sent a fix for.
fn scan_digests(matches: &[Value]) -> HashMap<String, String> {
    matches.iter().filter_map(|m| Some((m["file"].as_str()?.to_owned(), m["fix"]["scanned"].as_str()?.to_owned()))).collect()
}

fn refine_scanned(matches: Vec<Value>, fix: bool, read: &dyn Fn(&str) -> Option<Vec<u8>>) -> Vec<Value> {
    let digests = scan_digests(&matches);
    let mut refined = refine_history_comment_matches(matches, &|f: &str| read(f).filter(|bytes| digests.get(f).is_none_or(|d| *d == sha256_hex(bytes))));
    if !fix {
        return refined;
    }
    for m in &mut refined {
        let digest = m["file"].as_str().and_then(|f| digests.get(f)).cloned();
        let Some(fix) = m.get_mut("fix").filter(|f| f.is_object() && f.get("scanned").is_none() && f.get("stale").is_none()) else { continue };
        match digest {
            Some(d) => fix["scanned"] = json!(d),
            None => fix["stale"] = json!(NO_SCAN_DIGEST),
        }
    }
    refined
}

pub struct GraphStructuralAdapter {
    pub bin: PathBuf,
    pub processes: Processes,
}

impl GraphStructuralAdapter {
    pub const ID: &'static str = "graph-binary";

    /// Scans; with `fix` the binary emits fix payloads (byte range + text, and the SHA-256 of the
    /// bytes it parsed, kept as `scanned`) and writes nothing.
    pub async fn scan(
        &self,
        cwd: &Path,
        rules_text: &str,
        files: &[String],
        fix: bool,
        cancel: Option<&CancellationToken>,
    ) -> Result<Value, StructuralEngineUnavailable> {
        let mut args = vec![cwd.to_string_lossy().into_owned(), "--scan".into(), "--rules".into(), "-".into()];
        if !files.is_empty() {
            args.push("--files".into());
            args.extend(files.iter().cloned());
        }
        if fix {
            args.push("--fix".into());
        }
        let mut options = RunOptions::new(cwd);
        options.input = Some(rules_text.as_bytes().to_vec());
        options.timeout = STRUCTURAL_TIMEOUT;
        options.cancel = cancel;
        let result = self.processes.run(&self.bin.to_string_lossy(), &args, options).await;
        if let Some(error) = run_failure(&result) {
            return Ok(json!({"matches": [], "summary": {"matches": 0, "files": 0}, "error": error}));
        }
        let mut parsed = parse_structural_jsonl(&result.stdout, result.code, &result.stderr);
        if parsed["error"]["kind"] == "protocol" {
            return Err(StructuralEngineUnavailable { bin: self.bin.to_string_lossy().into_owned() });
        }
        if parsed.get("error").is_none() {
            let matches = parsed["matches"].as_array().cloned().unwrap_or_default();
            let (owned_cwd, owned_matches) = (cwd.to_owned(), matches.clone());
            let refined =
                on_lane(self.processes.durability(), move || refine_scanned(owned_matches, fix, &scan_source_reader(owned_cwd))).await.unwrap_or(matches);
            let files = refined.iter().filter_map(|m| m["file"].as_str()).collect::<std::collections::HashSet<_>>().len();
            parsed["summary"]["matches"] = json!(refined.len());
            parsed["summary"]["files"] = json!(files);
            parsed["matches"] = json!(refined);
        }
        Ok(parsed)
    }
}

/// The structural implementation: the local graph binary, once it proves it owns the scan
/// protocol. An old or missing binary must never read as "no findings".
pub async fn resolve_structural_adapter(
    processes: &Processes,
    cwd: &Path,
    graph_bin: Option<&Path>,
    graph_ready: Option<bool>,
    cancel: Option<&CancellationToken>,
) -> Result<GraphStructuralAdapter, StructuralEngineUnavailable> {
    resolve_structural_adapter_within(processes, cwd, graph_bin, graph_ready, Some(PROBE_TIMEOUT), cancel).await
}

pub(crate) async fn resolve_structural_adapter_within(
    processes: &Processes,
    cwd: &Path,
    graph_bin: Option<&Path>,
    graph_ready: Option<bool>,
    probe_deadline: Option<Duration>,
    cancel: Option<&CancellationToken>,
) -> Result<GraphStructuralAdapter, StructuralEngineUnavailable> {
    let ready = match (graph_ready, graph_bin) {
        (Some(r), _) => r,
        (None, Some(bin)) => graph_supports_scan_within(processes, bin, cwd, probe_deadline, cancel).await,
        (None, None) => false,
    };
    match graph_bin {
        Some(bin) if ready => Ok(GraphStructuralAdapter { bin: bin.to_owned(), processes: processes.clone() }),
        other => Err(StructuralEngineUnavailable { bin: other.map(|b| b.to_string_lossy().into_owned()).unwrap_or_default() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_packs_load_grouped_by_language_without_test_cases() {
        let (packs, groups) = load_rule_packs();
        assert!(packs.len() >= 50 && !packs.iter().any(|p| p.id.contains("__tests__")));
        let langs: Vec<&str> = groups.iter().map(|g| g.language.as_str()).collect();
        assert!(["typescript", "tsx", "python", "rust"].iter().all(|l| langs.contains(l)), "{langs:?}");
        let ts = groups.iter().find(|g| g.language == "typescript").unwrap();
        assert!(ts.rules_text.contains("\n---\n") && ts.packs.iter().all(|p| p.starts_with("typescript/")));
        let history = packs.iter().find(|p| p.rules.iter().any(|r| r == "no-history-comment")).unwrap();
        assert!(!history.languages.is_empty());
    }

    #[test]
    fn tsx_packs_run_whenever_typescript_is_in_scope() {
        let (_, groups) = load_rule_packs();
        let ts_scope = groups_for_languages(&groups, &["typescript".to_owned()]);
        assert!(ts_scope.iter().any(|g| g.language == "tsx") && ts_scope.iter().any(|g| g.language == "typescript"));
        assert!(groups_for_languages(&groups, &["python".to_owned()]).iter().all(|g| g.language == "python"));
        assert_eq!(groups_for_languages(&groups, &[]).len(), groups.len());
        let tsx = groups.iter().find(|g| g.language == "tsx").unwrap();
        let files: Vec<String> = ["a.ts", "b.tsx", "c.TSX"].iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(files_for_structural_group(&files, tsx, None), ["b.tsx", "c.TSX"]);
        let ts = groups.iter().find(|g| g.language == "typescript").unwrap();
        assert_eq!(files_for_structural_group(&files, ts, None), files, "the detection id for .tsx is typescript");
    }

    #[test]
    fn rows_normalize_to_one_based_positions_with_verbatim_byte_offsets() {
        let row = json!({"file": "src\\a.ts", "lang": "typescript", "ruleId": "no-var", "severity": "ERROR", "message": " Use let ",
                         "range": {"start": {"line": 0, "column": 4, "byteOffset": 10}, "end": {"line": 0, "column": 7, "byteOffset": 13}}, "fix": "let"});
        let m = normalize_structural_match(&row, true).unwrap();
        assert_eq!((m["file"].clone(), m["severity"].clone(), m["message"].clone()), (json!("src/a.ts"), json!("error"), json!("Use let")));
        assert_eq!(m["range"]["start"], json!({"line": 1, "column": 5}));
        assert_eq!(m["range"]["byteOffset"], json!([10, 13]));
        assert_eq!(m["fix"], json!({"byteOffset": [10, 13], "text": "let", "stale": NO_SCAN_DIGEST}));
        assert!(normalize_structural_match(&json!({"ruleId": "x"}), true).is_none());
        let object_fix =
            normalize_structural_match(&json!({"file": "a", "range": {"byteOffset": [1, 2]}, "fix": {"replacement": "z", "sha256": "ab"}}), false).unwrap();
        assert_eq!(object_fix["fix"], json!({"byteOffset": [1, 2], "text": "z", "scanned": "ab"}));
    }

    #[test]
    fn the_jsonl_protocol_distinguishes_clean_rule_errors_and_old_binaries() {
        let ok = parse_structural_jsonl(
            "{\"file\":\"a.ts\",\"ruleId\":\"r\",\"range\":{\"start\":{\"line\":1,\"column\":0}}}\nnot json\n{\"summary\":{\"matches\":1,\"files\":1}}\n",
            0,
            "",
        );
        assert_eq!((ok["matches"].as_array().unwrap().len(), ok["malformedLines"].clone(), ok.get("error").is_none()), (1, json!(1), true));
        let clean = parse_structural_jsonl("{\"summary\":{\"matches\":0,\"files\":0}}\n", 0, "");
        assert!(clean.get("error").is_none());
        let old = parse_structural_jsonl("", 0, "");
        assert_eq!(old["error"]["kind"], "protocol");
        let rules = parse_structural_jsonl("{\"file\":\"a\",\"ruleId\":\"r\",\"fix\":\"x\"}", 2, "bad kind");
        assert_eq!(
            (rules["error"]["kind"].clone(), rules["error"]["message"].clone(), rules["matches"].clone()),
            (json!("rules"), json!("bad kind"), json!([]))
        );
        let internal = parse_structural_jsonl("{\"file\":\"a\",\"ruleId\":\"r\",\"range\":{\"byteOffset\":[0,1]},\"fix\":\"x\"}\n", 1, "");
        assert_eq!(internal["error"]["kind"], "internal");
        assert_eq!((internal["matches"][0]["fix"].clone(), internal["matches"][0]["manual"].clone()), (Value::Null, json!(true)));
    }

    /// A rule's ids are its top-level `id:` keys; a rewriter's nested `id:` is not a rule.
    #[test]
    fn rule_ids_are_top_level_keys_only() {
        let yaml = "id: outer\nlanguage: rust\nrule:\n  pattern: $A\nrewriters:\n  - id: inner\n    language: python\n    rule:\n      pattern: x\n---\nid: second\r\nlanguage: rust\r\n";
        let (packs, _) = load_rule_packs_from(&[("rust/x.yml", yaml)]);
        assert_eq!((packs[0].rules.clone(), packs[0].languages.clone()), (vec!["outer".to_owned(), "second".to_owned()], vec!["rust".to_owned()]));
    }

    /// A scan that ran out of time, or whose output was cut, says so instead of passing for a
    /// complete scan with fewer matches.
    #[test]
    fn a_timed_out_or_cut_scan_is_an_error_of_its_kind() {
        let timed_out = ProcessResult { code: -1, timed_out: true, error: "timed out after 120000ms".into(), ..Default::default() };
        assert_eq!(run_failure(&timed_out).unwrap()["kind"], "timeout");
        assert!(run_failure(&timed_out).unwrap()["message"].as_str().unwrap().contains("timed out after 120000ms"));
        let cut = ProcessResult { truncated: true, stdout: "{\"file\":\"a\"}\n".into(), ..Default::default() };
        assert_eq!(run_failure(&cut).unwrap()["kind"], "truncated");
        assert_eq!(run_failure(&ProcessResult { code: -1, error: "x: program not found".into(), ..Default::default() }).unwrap()["kind"], "spawn");
        assert!(run_failure(&ProcessResult::default()).is_none());
    }

    /// A fix's `scanned` is the scanner's own digest of the bytes it parsed; a fix without one is
    /// stale. A history-comment fix the refinement rebuilds takes its file's scanner digest, and is
    /// withheld when the file no longer holds those bytes.
    #[test]
    fn fixes_carry_the_scanners_digest_or_are_stale() {
        let source = "// moved from b.ts\nlet a;\n";
        let digest = sha256_hex(source.as_bytes());
        let row = |file: &str, fix: Value| {
            normalize_structural_match(&json!({"file": file, "ruleId": "r", "range": {"byteOffset": [0, 3]}, "fix": fix}), true).unwrap()
        };
        assert_eq!(row("a.ts", json!({"byteOffset": [0, 3], "text": "x", "sha256": digest}))["fix"]["scanned"], json!(digest));
        let old = row("a.ts", json!({"byteOffset": [0, 3], "text": "x"}));
        assert_eq!((old["fix"]["stale"].clone(), old["fix"].get("scanned")), (json!(NO_SCAN_DIGEST), None));

        let history = |file: &str| {
            let mut m = row(file, json!({"byteOffset": [0, 18], "text": "", "sha256": digest}));
            m["ruleId"] = json!("no-history-comment");
            m["range"]["byteOffset"] = json!([0, 18]);
            m
        };
        let disk = |text: &'static str| move |_: &str| Some(text.as_bytes().to_vec());
        let fresh = refine_scanned(vec![history("a.ts")], true, &disk(source));
        assert_eq!(fresh.len(), 1);
        assert_eq!((fresh[0]["fix"]["scanned"].clone(), fresh[0]["manual"].clone()), (json!(digest), json!(false)));
        // A same-length edit after the scanner parsed the file: no fix is rebuilt from it.
        let edited = refine_scanned(vec![history("a.ts")], true, &disk("// moved from c.ts\nlet a;\n"));
        assert!(edited.iter().all(|m| m["fix"].is_null()), "{edited:?}");
        // No digest from the scanner: the rebuilt fix is stale.
        let mut unsigned = history("a.ts");
        unsigned["fix"] = json!({"byteOffset": [0, 18], "text": "", "stale": NO_SCAN_DIGEST});
        let rebuilt = refine_scanned(vec![unsigned], true, &disk(source));
        assert_eq!(rebuilt[0]["fix"]["stale"], json!(NO_SCAN_DIGEST));
    }

    #[tokio::test]
    async fn an_absent_or_non_scanning_binary_is_unavailable_with_the_remedy() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_structural_adapter(&Processes::for_tests(), dir.path(), None, None, None).await.err().unwrap();
        assert!(err.to_string().contains("no mixdog-graph binary was found") && err.to_string().contains("structural:false"));
        let missing = dir.path().join("nope");
        assert!(resolve_structural_adapter(&Processes::for_tests(), dir.path(), Some(&missing), None, None).await.is_err());
        assert!(
            resolve_structural_adapter(&Processes::for_tests(), dir.path(), Some(&missing), Some(true), None).await.is_ok(),
            "a caller-probed table is trusted"
        );
        reset_structural_probe_cache();
    }
}
