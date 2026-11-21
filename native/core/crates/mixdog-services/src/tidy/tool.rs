//! The model-facing `tidy` tool: a multi-language cleanup multiplexer.
//!
//! * `scan`    detect languages → resolve engines → report policy
//! * `check`   run every resolved engine in check mode + structural rules, no writes
//! * `fix`     same, but reports the change plan; `apply:true` writes through the write host
//! * `install` download missing managed engines (sha256-verified, policy-gated)
//! * `rules`   list the structural rule packs and the languages they cover
//! * `results` page diagnostics/matches from the last check/fix (no engine re-run)
//!
//! Everything outside this package (the graph binary location, the plugin data directory, the
//! orchestrator write pipeline, the outline reader, the network) arrives through [`TidyHost`].

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::apply::{WriteHost, apply_structural_fixes, escaping_write_targets};
use super::catalog::{engine_entry, engines_for_languages};
use super::function_length::{OutlineSource, summarize_function_lengths};
use super::install::{install_engines, plan_install, read_engines_manifest};
use super::languages::{
    Detected, GraphLangs, detect_languages, files_for_languages, is_known_language, language_with, normalize_rel, project_relative, requested_paths_on_disk,
};
use super::process::Processes;
use super::report::{DIAGNOSTIC_CAP, RESULTS_PAGE_MAX, ReportInput, build_tidy_report, tidy_tool_result};
use super::resolve::{DownloadPolicy, ResolveOptions, Resolved, resolve_engines};
use super::run_engines::{SuiteOptions, SuiteRun, run_engine_suite};
use super::shadow::detect_engine_shadows;
use super::structural::{
    GraphStructuralAdapter, PROBE_TIMEOUT, RulePack, StructuralEngineUnavailable, files_for_structural_group, groups_for_languages, load_rule_packs,
    packs_for_languages, probe_graph_langs_within, resolve_structural_adapter_within, structural_unavailable_message,
};
use super::worktree::{list_working_tree_changes, split_findings_by_worktree};
use crate::lane::on_lane;
use crate::local_provider::assets::Fetcher;

pub const TIDY_ACTIONS: [&str; 6] = ["scan", "check", "fix", "install", "rules", "results"];
/// Argv-safe `--files` batches. Larger scopes stay scoped: omitting `--files` makes mixdog-graph
/// walk cwd, which is never an acceptable fallback.
pub const MAX_STRUCTURAL_FILE_ARGS: usize = 200;
const RESULT_CACHE_MAX: usize = 32;
const PAGING_NOTE: &str = "use byRule/byDir to triage; action results filters cached rows with rules/paths before offset/limit paging, omits the header, and does not re-run engines; structural.errors means ok:true/status:partial unless another failure occurred";

#[async_trait]
pub trait TidyHost: Send + Sync {
    fn plugin_data(&self) -> PathBuf;
    /// `graphBinaryPath()`, asked at each use: a binary that only became available later (a
    /// download the code-graph tool ran) is found by the next call.
    async fn graph_binary(&self) -> Option<PathBuf>;
    fn write_host(&self) -> Arc<dyn WriteHost>;
    fn outline_source(&self) -> Arc<dyn OutlineSource>;
    fn fetcher(&self) -> Arc<dyn Fetcher>;
}

struct CachedRun {
    scope: Vec<String>,
    outcome: (Value, Value),
    languages: Vec<Value>,
    language_source: String,
    engines: Vec<Resolved>,
    results: Option<Vec<Value>>,
    structural: Value,
    /// Every unprocessed group with all its files; the header showed the first page.
    unprocessed: Vec<Value>,
}

pub struct TidyTool {
    host: Arc<dyn TidyHost>,
    processes: Processes,
    /// How long a `--langs` probe of the graph binary may run.
    probe_deadline: Option<Duration>,
    cache: Mutex<Vec<(String, Arc<CachedRun>)>>,
}

#[derive(Debug)]
struct ToolError(String);

impl From<StructuralEngineUnavailable> for ToolError {
    fn from(e: StructuralEngineUnavailable) -> Self {
        Self(e.to_string())
    }
}

/// One note per engine whose lookup never ran: it did not run, and it is not missing.
fn unavailable_notes(engines: &[Resolved]) -> Vec<String> {
    engines.iter().filter_map(|e| e.unavailable.as_ref().map(|why| format!("{}: {why}", e.id))).collect()
}

/// Splits a file list into `--files` batches. Empty input means "do not scan".
pub fn chunk_structural_files(files: &[String], max_args: usize) -> Vec<Vec<String>> {
    if files.is_empty() { Vec::new() } else { files.chunks(max_args.max(1)).map(<[String]>::to_vec).collect() }
}

fn parse_offset(v: Option<&Value>) -> usize {
    v.and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0).map_or(0, |n| (n as usize).min(1_000_000_000))
}

fn parse_limit(v: Option<&Value>) -> usize {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => (n.trunc().max(1.0) as usize).min(RESULTS_PAGE_MAX),
        _ => DIAGNOSTIC_CAP,
    }
}

/// The project-relative key of a reported path; an absolute path under `cwd` (in any letter case
/// on Windows) loses the root, anything else keeps its form.
fn match_file_key(file: &str, cwd: &Path) -> String {
    let raw = file.replace('\\', "/");
    if raw.is_empty() {
        return raw;
    }
    if Path::new(file).has_root() || Path::new(file).is_absolute() {
        return project_relative(cwd, Path::new(file)).filter(|rel| !rel.is_empty()).unwrap_or(raw);
    }
    normalize_rel(&raw)
}

/// Rewrites every path an engine result row reports.
fn map_row_paths(row: &mut Value, map: impl Fn(&str) -> String) {
    for key in ["diagnostics", "unprocessed"] {
        for d in row.get_mut(key).and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(file) = d["file"].as_str().map(&map) {
                d["file"] = json!(file);
            }
        }
    }
    for key in ["filesChanged", "ignored"] {
        for f in row.get_mut(key).and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(path) = f.as_str().map(&map) {
                *f = json!(path);
            }
        }
    }
}

/// `file` (project-relative) as seen from the project directory `dir`.
fn relative_to_dir(file: &str, dir: &str) -> String {
    if dir.is_empty() {
        return file.to_owned();
    }
    match file.strip_prefix(&format!("{dir}/")) {
        Some(rest) => rest.to_owned(),
        None => format!("{}{file}", "../".repeat(dir.split('/').count())),
    }
}

/// A path reported relative to the project directory `dir`, made project-relative again.
fn rebase_onto(dir: &str, path: &str) -> String {
    if dir.is_empty() || Path::new(path).has_root() || Path::new(path).is_absolute() {
        return path.to_owned();
    }
    let path = normalize_rel(path);
    let mut parts: Vec<&str> = dir.split('/').collect();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    parts.join("/")
}

/// Runs the engines, each in the directory it runs in: an engine configured with a `cwd` runs
/// there, given the files relative to it, and its paths come back project-relative. In apply mode
/// the suite's own stop ends the whole pass, as within one suite.
async fn run_suite(engines: &[&Resolved], options: &SuiteOptions) -> SuiteRun {
    let mut all = SuiteRun { results: Vec::new(), failed: Vec::new() };
    for group in engines.chunk_by(|a, b| a.cwd == b.cwd) {
        let mut ran = match group[0].cwd.as_deref() {
            None => run_engine_suite(group, options).await,
            Some(dir) => {
                let prefix = project_relative(&options.cwd, Path::new(dir)).unwrap_or_default();
                let sub = SuiteOptions {
                    files: options.files.iter().map(|f| relative_to_dir(f, &prefix)).collect(),
                    cwd: PathBuf::from(dir),
                    mode: options.mode.clone(),
                    apply: options.apply,
                    timeout: options.timeout,
                    cancel: options.cancel.clone(),
                    session_id: options.session_id.clone(),
                    extensions: options.extensions.clone(),
                    host: options.host.clone(),
                    spawn: options.spawn.clone(),
                    lane: options.lane,
                };
                let mut ran = run_engine_suite(group, &sub).await;
                ran.results.iter_mut().for_each(|row| map_row_paths(row, |p| rebase_onto(&prefix, p)));
                ran
            }
        };
        ran.results.iter_mut().for_each(|row| map_row_paths(row, |p| match_file_key(p, &options.cwd)));
        let stopped = options.apply && ran.stopped();
        all.results.append(&mut ran.results);
        all.failed.append(&mut ran.failed);
        if stopped {
            break;
        }
    }
    all
}

async fn apply_after_preflight(preflight: SuiteRun, runnable: &[&Resolved], options: &SuiteOptions) -> SuiteRun {
    let eligible: Vec<_> = runnable.iter().zip(&preflight.failed).filter_map(|(&engine, failed)| (!*failed).then_some(engine)).collect();
    let applied = run_suite(&eligible, options).await;
    let stopper = applied.results.last().filter(|_| applied.stopped()).and_then(|r| r["id"].as_str()).unwrap_or("").to_owned();
    let mut applied = applied.results.into_iter().zip(applied.failed);
    let mut merged = SuiteRun { results: Vec::new(), failed: Vec::new() };
    for (row, failed) in preflight.results.into_iter().zip(preflight.failed) {
        let (row, failed) = if failed {
            (row, failed)
        } else {
            applied.next().unwrap_or_else(|| {
                let mut row = row;
                row["skipped"] = json!(not_run_reason(&stopper));
                (row, false)
            })
        };
        merged.results.push(row);
        merged.failed.push(failed);
    }
    merged
}

/// Whether a row's engine could not complete its run: it could not start, timed out, was
/// cancelled or had its configuration rejected. Files it could not process are not that.
fn engine_error(row: &Value, failed: bool) -> bool {
    failed && row["error"].as_str().is_some_and(|e| !e.is_empty())
}

/// Whether a row's engine got nowhere: it could not complete its run and its row says nothing
/// about any file. An engine that checked or wrote files before it failed did run.
fn got_nowhere(row: &Value, failed: bool) -> bool {
    engine_error(row, failed) && row["filesChecked"].as_u64().unwrap_or(0) == 0 && row["filesChanged"].as_array().is_none_or(Vec::is_empty)
}

fn not_run_reason(stopper: &str) -> String {
    format!("not run: the apply pass stopped at {stopper}, which could not run")
}

fn filter_engine_row(mut row: Value, matches_row: &dyn Fn(&Value) -> bool, matches_path: &dyn Fn(&str) -> bool) -> Value {
    let kept = |rows: &Value, file_of: fn(&Value) -> &str| -> Vec<Value> {
        rows.as_array().into_iter().flatten().filter(|r| matches_path(file_of(r))).cloned().collect()
    };
    row["diagnostics"] = json!(row["diagnostics"].as_array().into_iter().flatten().filter(|d| matches_row(d)).cloned().collect::<Vec<_>>());
    row["filesChanged"] = json!(kept(&row["filesChanged"], |f| f.as_str().unwrap_or("")));
    row["ignored"] = json!(kept(&row["ignored"], |f| f.as_str().unwrap_or("")));
    row["unprocessed"] = json!(kept(&row["unprocessed"], |u| u["file"].as_str().unwrap_or("")));
    row
}

fn withhold_uncovered_fixes(
    matches: &mut [Value],
    extensions: Option<&HashMap<String, String>>,
    covered: &std::collections::HashSet<String>,
) -> std::collections::BTreeSet<String> {
    let mut withheld = std::collections::BTreeSet::new();
    for m in matches {
        let file = m["file"].as_str().unwrap_or("").to_owned();
        let language = language_with(&file, extensions);
        if !engines_for_languages(std::slice::from_ref(&language)).is_empty() && !covered.contains(&language) {
            m["fix"] = Value::Null;
            m["manual"] = json!(true);
            withheld.insert(file);
        }
    }
    withheld
}

fn covered_languages(suite: &SuiteRun, runnable: &[&Resolved]) -> std::collections::HashSet<String> {
    suite
        .results
        .iter()
        .zip(&suite.failed)
        .filter(|(r, failed)| !**failed && r.get("skipped").is_none_or(Value::is_null))
        .filter_map(|(r, _)| runnable.iter().find(|e| r["id"] == e.id.as_str()))
        .flat_map(|e| e.languages.clone())
        .collect()
}

fn engines_that_ran(suite: &SuiteRun, runnable: &[&Resolved], files: &[String], extensions: Option<&HashMap<String, String>>) -> Vec<String> {
    suite
        .results
        .iter()
        .zip(&suite.failed)
        .filter(|(r, failed)| r["skipped"].as_str().is_none_or(str::is_empty) && !got_nowhere(r, **failed))
        .filter_map(|(r, _)| runnable.iter().find(|e| r["id"] == e.id.as_str()))
        .filter(|e| !files_for_languages(files, &e.languages, extensions).is_empty())
        .map(|e| e.id.clone())
        .collect()
}

fn append_not_run(suite: &mut SuiteRun, runnable: &[&Resolved]) {
    if suite.results.len() < runnable.len() {
        let stopper = suite.results.last().and_then(|r| r["id"].as_str()).unwrap_or("").to_owned();
        for e in &runnable[suite.results.len()..] {
            suite.results.push(not_run(e, &stopper));
            suite.failed.push(false);
        }
    }
}

/// The row of an engine the apply pass never reached.
fn not_run(engine: &Resolved, stopper: &str) -> Value {
    let mut row =
        json!({"id": engine.id, "source": engine.source, "filesChecked": 0, "filesChanged": [], "diagnostics": [], "skipped": not_run_reason(stopper)});
    if !engine.version.is_empty() {
        row["version"] = json!(engine.version);
    }
    row
}

/// Why `engine` did not process `file` in this call, or `None` when it did. `row` is `None` for
/// scan, which runs nothing: a runnable engine counts as processing its files.
fn engine_gap(engine: &Resolved, file: &str, row: Option<(&Value, bool)>, scan: bool, given: usize, cwd: &Path) -> Option<String> {
    let id = &engine.id;
    if let Some(why) = &engine.unavailable {
        return Some(format!("{id} is unavailable: {why}"));
    }
    if engine.missing {
        return Some(format!("{id} is missing"));
    }
    if let Some(why) = &engine.skipped {
        return Some(format!("{id} was skipped: {why}"));
    }
    if scan {
        return None;
    }
    let Some((row, failed)) = row else { return Some(format!("{id} did not run")) };
    if let Some(why) = row["skipped"].as_str().filter(|s| !s.is_empty()) {
        return Some(format!("{id} was skipped: {why}"));
    }
    let unprocessed = row["unprocessed"].as_array().map_or(&[][..], Vec::as_slice);
    if let Some(u) = unprocessed.iter().find(|u| u["file"].as_str().is_some_and(|f| match_file_key(f, cwd) == file)) {
        return Some(format!("{id} could not process it: {}", mixdog_js::slice_utf16(u["reason"].as_str().unwrap_or(""), 160)));
    }
    // An `error` of an engine that completed its run only summarizes its unprocessed files.
    if engine_error(row, failed) {
        return Some(format!("{id} failed: {}", mixdog_js::slice_utf16(row["error"].as_str().unwrap_or(""), 160)));
    }
    let ignored = row["ignored"].as_array().map_or(&[][..], Vec::as_slice);
    if ignored.iter().filter_map(Value::as_str).any(|f| match_file_key(f, cwd) == file) {
        return Some(format!("{id}'s configuration ignores it"));
    }
    let checked = row["filesChecked"].as_u64().unwrap_or(0) as usize;
    if checked + ignored.len() + unprocessed.len() < given {
        return Some(format!("{id} processed {checked} of the {given} file(s) it was given and did not name the rest"));
    }
    None
}

/// Per language, the files no formatter or linter engine processed in this call (scan: will
/// process) and why. Structural rules are not engines here. `excluded` are files kept from every
/// engine, with the reason.
fn unprocessed_files(
    files: &[String],
    extensions: Option<&HashMap<String, String>>,
    engines: &[Resolved],
    results: Option<&SuiteRun>,
    excluded: &[(String, String)],
    cwd: &Path,
) -> Vec<Value> {
    let row_of = |id: &str| results.and_then(|rs| rs.results.iter().position(|r| r["id"] == id).map(|i| (&rs.results[i], rs.failed[i])));
    let engine_files: Vec<String> = files.iter().filter(|f| !excluded.iter().any(|(x, _)| x == *f)).cloned().collect();
    let given: HashMap<&str, usize> = engines.iter().map(|e| (e.id.as_str(), files_for_languages(&engine_files, &e.languages, extensions).len())).collect();
    let mut groups: Vec<(String, String, Vec<String>)> = Vec::new();
    for file in files {
        let language = language_with(file, extensions);
        if language.is_empty() {
            continue;
        }
        let reason = if let Some((_, why)) = excluded.iter().find(|(x, _)| x == file) {
            why.clone()
        } else {
            let catalog: Vec<String> = engines_for_languages(std::slice::from_ref(&language)).iter().map(|e| e.id.clone()).collect();
            let candidates: Vec<&Resolved> = engines.iter().filter(|e| e.languages.contains(&language)).collect();
            if catalog.is_empty() {
                format!("no formatter or linter engine exists for {language}")
            } else if candidates.is_empty() {
                format!("no engine for {language} was selected; its engines are {}", catalog.join(", "))
            } else {
                let gaps: Vec<Option<String>> =
                    candidates.iter().map(|e| engine_gap(e, file, row_of(&e.id), results.is_none(), given[e.id.as_str()], cwd)).collect();
                if gaps.iter().any(Option::is_none) {
                    continue;
                }
                gaps.into_iter().flatten().collect::<Vec<_>>().join("; ")
            }
        };
        match groups.iter_mut().find(|(l, r, _)| *l == language && *r == reason) {
            Some((_, _, list)) => list.push(file.clone()),
            None => groups.push((language, reason, vec![file.clone()])),
        }
    }
    groups.sort_by(|a, b| mixdog_js::locale_compare(&a.0, &b.0));
    // Whole groups: the report pages `files` like the other file lists, and `results` pages the rest.
    groups.into_iter().map(|(language, reason, list)| json!({"language": language, "reason": reason, "count": list.len(), "files": list})).collect()
}

/// Rows `apply` would act on, per file: engine diagnostics, files an engine would rewrite (a
/// formatter reports no diagnostics at all) and structural matches.
fn finding_files_by_count(results: &[Value], structural: &Value, cwd: &Path) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    let mut add = |file: &str| {
        let key = match_file_key(file, cwd);
        if !key.is_empty() {
            *counts.entry(key).or_insert(0) += 1;
        }
    };
    for r in results {
        r["diagnostics"].as_array().into_iter().flatten().for_each(|d| add(d["file"].as_str().unwrap_or("")));
        r["filesChanged"].as_array().into_iter().flatten().for_each(|f| add(f.as_str().unwrap_or("")));
    }
    structural["matches"].as_array().into_iter().flatten().for_each(|m| add(m["file"].as_str().unwrap_or("")));
    counts
}

/// Files any engine result lists as ignored by its own configuration, by project-relative key.
fn ignored_files(results: &[Value], cwd: &Path) -> std::collections::HashSet<String> {
    results.iter().flat_map(|r| r["ignored"].as_array().into_iter().flatten()).filter_map(Value::as_str).map(|f| match_file_key(f, cwd)).collect()
}

/// A list argument: a string or an array of strings, trimmed, empties dropped.
fn list(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).filter(|s| !s.is_empty()).collect(),
        Some(Value::String(s)) => Some(mixdog_js::js_trim(s).to_owned()).filter(|s| !s.is_empty()).into_iter().collect(),
        Some(other) => Some(other.to_string()).into_iter().collect(),
    }
}

/// Scope paths are project-relative; an absolute path must live inside cwd.
fn normalize_scope(paths: &[String], cwd: &Path) -> Result<Vec<String>, ToolError> {
    paths
        .iter()
        .map(|value| {
            if !Path::new(value).is_absolute() {
                let n = normalize_rel(value);
                if n.split('/').any(|s| s == "..") {
                    return Err(ToolError(format!("paths must stay inside the project: {value}")));
                }
                return Ok(n);
            }
            // Component-wise, case-insensitive on Windows: `..cache` is a name, not a way out.
            match project_relative(cwd, Path::new(value)) {
                Some(rel) if rel.is_empty() => Ok(".".to_owned()),
                Some(rel) => Ok(rel),
                None => Err(ToolError(format!("paths must stay inside the project: {value}"))),
            }
        })
        .collect()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn missing_paths_blocking(cwd: &Path, scope: &[String]) -> Vec<String> {
    scope.iter().filter(|p| !cwd.join(p).exists()).cloned().collect()
}

fn policy_json(p: &DownloadPolicy) -> Value {
    let mut v = json!({"downloads": p.downloads, "source": p.source});
    if let Some(w) = &p.warning {
        v["warning"] = json!(w);
    }
    v
}

struct Detection {
    detected: Detected,
    graph_bin: Option<PathBuf>,
    graph_langs: Option<GraphLangs>,
}

struct Run<'a> {
    cwd: &'a Path,
    scope: Vec<String>,
    language_filter: Vec<String>,
    engine_filter: Vec<String>,
    session_id: Option<&'a str>,
    cancel: Option<&'a CancellationToken>,
    started: Instant,
}

#[cfg(test)]
mod tests {
    use super::super::apply::tests::Recording;
    use super::*;
    use crate::local_provider::assets::Fetched;

    struct NoOutline;
    #[async_trait]
    impl OutlineSource for NoOutline {
        async fn outline(&self, _: &Path, _: &[String], _: &CancellationToken) -> Result<Vec<Value>, String> {
            Err("no graph in tests".into())
        }
    }
    struct NoNet;
    #[async_trait]
    impl Fetcher for NoNet {
        async fn get(&self, _: &str, _: i64) -> Result<Fetched, String> {
            Err("offline".into())
        }
    }
    struct Host(PathBuf);
    #[async_trait]
    impl TidyHost for Host {
        fn plugin_data(&self) -> PathBuf {
            self.0.clone()
        }
        async fn graph_binary(&self) -> Option<PathBuf> {
            None
        }
        fn write_host(&self) -> Arc<dyn WriteHost> {
            Arc::new(Recording::default())
        }
        fn outline_source(&self) -> Arc<dyn OutlineSource> {
            Arc::new(NoOutline)
        }
        fn fetcher(&self) -> Arc<dyn Fetcher> {
            Arc::new(NoNet)
        }
    }

    fn tool(data: &Path) -> TidyTool {
        TidyTool::new(Arc::new(Host(data.to_owned())), Processes::for_tests())
    }

    fn body(result: &Value) -> Value {
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn argument_errors_come_back_as_failed_results() {
        let (data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = tool(data.path());
        let bad = t.execute(&json!({"action": "explode"}), cwd.path(), None, None).await;
        assert_eq!(bad["isError"], true);
        assert!(body(&bad)["error"].as_str().unwrap().contains("Unsupported tidy action \"explode\""));
        let unscoped = body(&t.execute(&json!({"action": "check"}), cwd.path(), None, None).await);
        assert!(unscoped["error"].as_str().unwrap().contains("paths requires a user-selected scope"));
        let outside = body(&t.execute(&json!({"action": "scan", "paths": ["../x"]}), cwd.path(), None, None).await);
        assert!(outside["error"].as_str().unwrap().contains("paths must stay inside the project"));
        let install = body(&t.execute(&json!({"action": "install"}), cwd.path(), None, None).await);
        assert_eq!(install["error"], "install requires engines:[...]");
        let results = body(&t.execute(&json!({"action": "results"}), cwd.path(), Some("s"), None).await);
        assert!(results["error"].as_str().unwrap().contains("no stored tidy results"));
    }

    #[tokio::test]
    async fn rules_lists_the_packs_and_says_when_the_engine_is_missing() {
        let (data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let result = tool(data.path()).execute(&json!({"action": "rules"}), cwd.path(), None, None).await;
        assert_eq!(result["isError"], true);
        let report = body(&result);
        assert_eq!((report["ok"].clone(), report["rules"]["adapter"].clone()), (json!(false), json!("none")));
        assert!(report["rules"]["packs"].as_array().unwrap().len() >= 50);
        assert!(report["errors"][0].as_str().unwrap().contains("no mixdog-graph binary was found"));
    }

    #[tokio::test]
    async fn install_refuses_toolchain_engines_and_scan_resolves_what_is_present() {
        let (data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = tool(data.path());
        let install = body(&t.execute(&json!({"action": "install", "engines": ["rustfmt"]}), cwd.path(), None, None).await);
        assert_eq!(install["ok"], false);
        assert!(install["errors"][0]["error"].as_str().unwrap().contains("toolchain engine"));
        if t.processes.which("git", None).await.is_some() {
            std::process::Command::new("git").args(["init", "-q"]).current_dir(cwd.path()).output().unwrap();
            std::fs::write(cwd.path().join("a.py"), "x = 1\n").unwrap();
            let scan = body(&t.execute(&json!({"action": "scan", "paths": ["."]}), cwd.path(), None, None).await);
            assert_eq!(scan["languages"], json!([{"id": "python", "files": 1}]));
            assert!(scan["engines"].is_array() && scan["policy"]["downloads"].is_string());
        }
    }

    #[test]
    fn scope_arguments_and_paging_parameters_are_normalized() {
        let cwd = Path::new(if cfg!(windows) { "C:\\proj" } else { "/proj" });
        assert_eq!(normalize_scope(&["./src\\a".into(), ".".into()], cwd).unwrap(), ["src/a", "."]);
        assert!(normalize_scope(&["a/../b".into()], cwd).is_err());
        let inside = if cfg!(windows) { "C:\\proj\\src" } else { "/proj/src" };
        let outside = if cfg!(windows) { "C:\\other" } else { "/other" };
        assert_eq!(normalize_scope(&[inside.into()], cwd).unwrap(), ["src"]);
        assert!(normalize_scope(&[outside.into()], cwd).is_err());
        assert_eq!((parse_offset(Some(&json!(-3))), parse_offset(Some(&json!(7.9))), parse_offset(None)), (0, 7, 0));
        assert_eq!((parse_limit(None), parse_limit(Some(&json!(0))), parse_limit(Some(&json!(500))), parse_limit(Some(&json!("x")))), (20, 1, 100, 20));
        assert_eq!(list(&json!({"paths": " a "}), "paths"), ["a"]);
        assert_eq!(chunk_structural_files(&(0..5).map(|n| n.to_string()).collect::<Vec<_>>(), 2).len(), 3);
        assert!(chunk_structural_files(&[], 2).is_empty());
        assert_eq!(match_file_key("/proj/src/a.ts", Path::new("/proj")), "src/a.ts");
        assert_eq!(match_file_key("./b.ts", Path::new("/proj")), "b.ts");
    }

    /// An absolute scope or reported path is placed by component, in any letter case on Windows;
    /// a directory named `..cache` is inside the project.
    #[test]
    fn absolute_paths_compare_by_component_and_case() {
        let cwd = Path::new(if cfg!(windows) { "C:\\Proj" } else { "/proj" });
        let lower = if cfg!(windows) { "c:\\PROJ\\src" } else { "/proj/src" };
        assert_eq!(normalize_scope(&[lower.into()], cwd).unwrap(), ["src"]);
        let dots = if cfg!(windows) { "C:\\Proj\\..cache" } else { "/proj/..cache" };
        assert_eq!(normalize_scope(&[dots.into(), "..cache/x".into()], cwd).unwrap(), ["..cache", "..cache/x"]);
        let reported = if cfg!(windows) { "c:/proj/src/a.ts" } else { "/proj/src/a.ts" };
        assert_eq!(match_file_key(reported, cwd), "src/a.ts");
        assert_eq!((relative_to_dir("src/a.ts", "web/app"), rebase_onto("web/app", "../../src/a.ts")), ("../../src/a.ts".to_owned(), "src/a.ts".to_owned()));
    }

    fn git_project(files: &[(&str, &str)]) -> Option<tempfile::TempDir> {
        std::process::Command::new("git").arg("--version").output().ok().filter(|o| o.status.success())?;
        let cwd = tempfile::tempdir().unwrap();
        std::process::Command::new("git").args(["init", "-q"]).current_dir(cwd.path()).output().unwrap();
        for (name, text) in files {
            let path = cwd.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        Some(cwd)
    }

    /// A requested path that yields no file is named with its reason; when none yields one the
    /// call fails instead of reporting a complete run over nothing.
    #[tokio::test]
    async fn requested_paths_that_yield_no_file_are_named_and_all_empty_fails() {
        let Some(cwd) = git_project(&[("a.py", "x = 1\n"), ("docs/notes.txt", "x")]) else { return eprintln!("skipped: git is missing") };
        let data = tempfile::tempdir().unwrap();
        let t = tool(data.path());
        let failed = body(&t.execute(&json!({"action": "scan", "paths": ["docs"]}), cwd.path(), None, None).await);
        assert_eq!(failed["ok"], false, "{failed}");
        assert!(
            failed["error"].as_str().unwrap().contains("no requested path yields a file: docs: none of its 1 listed file(s) is of a language tidy handles"),
            "{failed}"
        );
        let scan = body(&t.execute(&json!({"action": "scan", "paths": ["a.py", "docs"]}), cwd.path(), None, None).await);
        assert_eq!(scan["emptyPaths"][0]["path"], "docs", "{scan}");
    }

    /// Files of a language no engine handles are named, per language, with the reason.
    #[tokio::test]
    async fn files_no_engine_processes_are_named_by_language() {
        let Some(cwd) = git_project(&[("a.py", "x = 1\n"), ("a.rb", "x = 1\n")]) else { return eprintln!("skipped: git is missing") };
        let data = tempfile::tempdir().unwrap();
        let scan = body(&tool(data.path()).execute(&json!({"action": "scan", "paths": ["."]}), cwd.path(), None, None).await);
        let ruby = scan["unprocessed"].as_array().unwrap().iter().find(|u| u["language"] == "ruby").cloned().unwrap_or_default();
        assert_eq!((ruby["reason"].clone(), ruby["files"].clone()), (json!("no formatter or linter engine exists for ruby"), json!(["a.rb"])), "{scan}");
    }

    /// A project config the tool cannot honour fails the call with the parse error.
    #[tokio::test]
    async fn a_malformed_project_config_fails_the_call() {
        let Some(cwd) = git_project(&[("a.py", "x = 1\n"), (".mixdog/tidy.json", "{\"engines\":")]) else { return eprintln!("skipped: git is missing") };
        let data = tempfile::tempdir().unwrap();
        let t = tool(data.path());
        for action in ["scan", "check"] {
            let report = body(&t.execute(&json!({"action": action, "paths": ["a.py"], "structural": false}), cwd.path(), None, None).await);
            assert!(report["error"].as_str().unwrap_or("").starts_with(".mixdog/tidy.json: not valid JSON"), "{report}");
        }
        std::fs::write(cwd.path().join(".mixdog/tidy.json"), r#"{"engines":{"ruff":{"command":""}}}"#).unwrap();
        let empty = body(&t.execute(&json!({"action": "check", "paths": ["a.py"], "structural": false}), cwd.path(), None, None).await);
        assert!(empty["error"].as_str().unwrap_or("").contains("engines.ruff.command must be a non-empty string"), "{empty}");
    }

    /// Engines that would be skipped, or have no file in scope, are neither downloaded nor offered.
    #[tokio::test]
    async fn engines_that_would_not_run_are_not_offered_for_download() {
        let prettier = if cfg!(windows) { "node_modules/.bin/prettier.cmd" } else { "node_modules/.bin/prettier" };
        let files = [("a.sh", "echo a\n"), ("a.ts", "let a = 1;\n"), (prettier, "x"), (".mixdog/tidy.json", r#"{"policy":{"downloads":"ask"}}"#)];
        let Some(cwd) = git_project(&files) else { return eprintln!("skipped: git is missing") };
        let data = tempfile::tempdir().unwrap();
        let args = json!({"action": "check", "paths": ["a.sh", "a.ts"], "engines": ["dprint", "stylua", "biome", "prettier"], "structural": false});
        let report = body(&tool(data.path()).execute(&args, cwd.path(), None, None).await);
        let offered: Vec<&str> = report["needsApproval"]["engines"].as_array().into_iter().flatten().filter_map(|e| e["id"].as_str()).collect();
        assert!(offered.is_empty(), "dprint has no config, stylua no file, biome stands down for prettier: {report}");
    }

    #[tokio::test]
    async fn unknown_engines_languages_and_missing_paths_are_rejected() {
        let (data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::write(cwd.path().join("a.py"), "x = 1\n").unwrap();
        let t = tool(data.path());
        let (t, root) = (&t, cwd.path());
        let error = |args: Value| async move { body(&t.execute(&args, root, None, None).await)["error"].as_str().unwrap_or("").to_owned() };
        assert_eq!(error(json!({"action": "check", "paths": ["a.py"], "engines": ["bogus"]})).await, "unknown engine \"bogus\"");
        assert_eq!(error(json!({"action": "scan", "paths": ["a.py"], "languages": ["klingon"]})).await, "unknown language \"klingon\"");
        assert_eq!(error(json!({"action": "check", "paths": ["a.py"], "languages": ["klingon"]})).await, "unknown language \"klingon\"");
        assert_eq!(error(json!({"action": "fix", "paths": ["missing.py"]})).await, "path does not exist: missing.py");
    }

    #[tokio::test]
    async fn rules_honors_the_language_filter_and_paging() {
        let (data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = tool(data.path());
        let all = body(&t.execute(&json!({"action": "rules"}), cwd.path(), None, None).await);
        let ts = body(&t.execute(&json!({"action": "rules", "languages": ["typescript"], "limit": 3}), cwd.path(), None, None).await);
        let total = ts["rules"]["packsCount"].as_u64().unwrap();
        assert!(total > 3 && total < all["rules"]["packsCount"].as_u64().unwrap());
        assert_eq!(ts["rules"]["packs"].as_array().unwrap().len(), 3);
        assert!(ts["rules"]["packs"].as_array().unwrap().iter().all(|p| p["languages"].as_array().unwrap().iter().any(|l| l == "typescript" || l == "tsx")));
        assert_eq!(
            (ts["rules"]["more"].clone(), ts["rules"]["nextOffset"].clone(), ts["languages"][0]["id"].clone()),
            (json!(total - 3), json!(3), json!("typescript"))
        );
        let next = body(&t.execute(&json!({"action": "rules", "languages": ["typescript"], "limit": 3, "offset": 3}), cwd.path(), None, None).await);
        assert_ne!(next["rules"]["packs"][0]["id"], ts["rules"]["packs"][0]["id"]);
        let unknown = body(&t.execute(&json!({"action": "rules", "languages": ["klingon"]}), cwd.path(), None, None).await);
        assert_eq!(unknown["error"], "unknown language \"klingon\"");
    }

    struct GraphHost {
        data: PathBuf,
        graph: PathBuf,
    }

    #[async_trait]
    impl TidyHost for GraphHost {
        fn plugin_data(&self) -> PathBuf {
            self.data.clone()
        }
        async fn graph_binary(&self) -> Option<PathBuf> {
            Some(self.graph.clone())
        }
        fn write_host(&self) -> Arc<dyn WriteHost> {
            Arc::new(Recording::default())
        }
        fn outline_source(&self) -> Arc<dyn OutlineSource> {
            Arc::new(NoOutline)
        }
        fn fetcher(&self) -> Arc<dyn Fetcher> {
            Arc::new(NoNet)
        }
    }

    /// Stands in for mixdog-graph: knows `sh` and `ts`, and for every file given to `--scan` that
    /// holds `# gone` reports a match whose fix deletes it, with the SHA-256 of the bytes it read.
    const FAKE_GRAPH: &str = r##"
import hashlib, json, os, sys
a = sys.argv[1:]
if "--langs" in a:
    print(json.dumps({"languages": [{"id": "bash", "extensions": ["sh"], "scan": True}, {"id": "typescript", "extensions": ["ts"], "scan": True}]}))
    sys.exit(0)
files = [f for f in a[a.index("--files") + 1:] if f != "--fix"] if "--files" in a else []
n = 0
for f in files:
    data = open(os.path.join(a[0], f), "rb").read()
    i = data.find(b"# gone")
    if i >= 0:
        n += 1
        pos = lambda at: {"line": data[:at].count(b"\n"), "column": len(data[:at].split(b"\n")[-1].decode())}
        print(json.dumps({"file": f, "ruleId": "no-gone", "severity": "warning", "message": "m", "range": {"start": pos(i), "end": pos(i + 6), "byteOffset": [i, i + 6]}, "fix": {"byteOffset": [i, i + 6], "sha256": hashlib.sha256(data).hexdigest(), "text": ""}}))
print(json.dumps({"summary": {"matches": n, "files": n}}))
"##;

    /// shfmt stand-in: a line of only spaces is unformatted; `-w` removes it.
    const FAKE_SHFMT: &str = r#"
import sys
for f in [x for x in sys.argv[1:] if x not in ("-l", "-w")]:
    text = open(f, newline="").read()
    lines = text.split("\n")
    dirty = any(l != "" and l.strip() == "" for l in lines)
    if "-l" in sys.argv and dirty:
        print(f)
    if "-w" in sys.argv and dirty:
        open(f, "w", newline="").write("\n".join(l for l in lines if not (l != "" and l.strip() == "")))
"#;

    /// biome stand-in: `ignored.ts`-style names (containing `ignored`) are outside its config.
    const FAKE_BIOME: &str = r#"
import json, sys
files = [x for x in sys.argv[1:] if x.endswith(".ts")]
n = len([f for f in files if "ignored" not in f])
omitted = 1 if any("truncated" in f for f in files) else 0
print(json.dumps({"summary": {"changed": 0, "unchanged": n, "diagnosticsNotPrinted": omitted}, "diagnostics": []}))
if n == 0:
    # Real biome names the paths only when it processed nothing.
    sys.stderr.write("  x No files were processed in the specified paths.\n  \n  i These paths were provided but ignored:\n  \n" + "".join("  - %s\n" % f for f in files))
sys.exit(0 if n else 1)
"#;

    struct Fixture {
        _scripts: tempfile::TempDir,
        data: tempfile::TempDir,
        cwd: tempfile::TempDir,
        graph: PathBuf,
    }

    /// A git project wired to the fake graph and the fake engines; `None` when python or git is absent.
    async fn fixture(t: &TidyTool, files: &[(&str, &str)]) -> Option<Fixture> {
        let mut python = None;
        for name in ["python3", "python"] {
            if let Some(found) =
                t.processes.which(name, None).await.filter(|p| std::process::Command::new(p).args(["-c", "pass"]).status().is_ok_and(|s| s.success()))
            {
                python = Some(found);
                break;
            }
        }
        let python = python?;
        t.processes.which("git", None).await?;
        let (scripts, data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        for (name, text) in [("graph.py", FAKE_GRAPH), ("shfmt.py", FAKE_SHFMT), ("biome.py", FAKE_BIOME)] {
            std::fs::write(scripts.path().join(name), text).unwrap();
        }
        let graph = if cfg!(windows) { scripts.path().join("graph.cmd") } else { scripts.path().join("graph.sh") };
        let script = scripts.path().join("graph.py");
        if cfg!(windows) {
            std::fs::write(&graph, format!("@\"{}\" \"{}\" %*\r\n", python.display(), script.display())).unwrap();
        } else {
            std::fs::write(&graph, format!("#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n", python.display(), script.display())).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&graph, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        std::process::Command::new("git").args(["init", "-q"]).current_dir(cwd.path()).output().unwrap();
        let engine = |name: &str| json!({"command": python.to_string_lossy(), "args": [scripts.path().join(name).to_string_lossy()]});
        std::fs::create_dir_all(cwd.path().join(".mixdog")).unwrap();
        std::fs::write(
            cwd.path().join(".mixdog/tidy.json"),
            json!({"policy": {"downloads": "never"}, "engines": {"shfmt": engine("shfmt.py"), "biome": engine("biome.py")}}).to_string(),
        )
        .unwrap();
        for (name, text) in files {
            let path = cwd.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        Some(Fixture { _scripts: scripts, data, cwd, graph })
    }

    fn graph_tool(f: &Fixture) -> TidyTool {
        TidyTool::new(Arc::new(GraphHost { data: f.data.path().to_owned(), graph: f.graph.clone() }), Processes::for_tests()).with_probe_deadline(None)
    }

    #[tokio::test]
    async fn fix_applies_structural_edits_before_the_formatters_so_the_result_is_format_clean() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("a.sh", "echo a\n  # gone\necho b\n")]).await else { return eprintln!("skipped: python or git is missing") };
        let t = graph_tool(&f);
        let fixed = body(&t.execute(&json!({"action": "fix", "apply": true, "paths": ["a.sh"], "engines": ["shfmt"]}), f.cwd.path(), None, None).await);
        assert_eq!(fixed["structural"]["applied"][0]["file"], "a.sh", "{fixed}");
        assert_eq!(std::fs::read_to_string(f.cwd.path().join("a.sh")).unwrap(), "echo a\necho b\n");
        let again = body(&t.execute(&json!({"action": "check", "paths": ["a.sh"], "engines": ["shfmt"]}), f.cwd.path(), None, None).await);
        assert_eq!(again["results"][0]["diagnosticsCount"], 0, "{again}");
    }

    /// The check header lists the engines that ran, and a language nothing processed is named.
    #[tokio::test]
    async fn the_header_lists_engines_that_ran_and_unprocessed_languages_are_named() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("a.sh", "echo a\n"), ("A.java", "class A {}\n")]).await else { return eprintln!("skipped: python or git is missing") };
        let report = body(
            &graph_tool(&f)
                .execute(&json!({"action": "check", "structural": false, "paths": ["a.sh", "A.java"], "engines": ["shfmt", "biome"]}), f.cwd.path(), None, None)
                .await,
        );
        assert_eq!(report["engines"], json!([{"id": "shfmt"}]), "biome had no file in scope: {report}");
        let java = report["unprocessed"].as_array().unwrap().iter().find(|u| u["language"] == "java").cloned().unwrap_or_default();
        assert_eq!(java["files"], json!(["A.java"]), "{report}");
    }

    /// An apply runs only the engines it names, with or without the structural pass.
    #[tokio::test]
    async fn an_apply_runs_only_the_named_engines() {
        let probe = tool(Path::new("."));
        let dirty = "echo a\n  \necho b\n";
        let Some(f) = fixture(&probe, &[("a.sh", dirty), ("b.ts", "let b = 1;\n")]).await else { return eprintln!("skipped: python or git is missing") };
        for structural in [false, true] {
            let report = body(
                &graph_tool(&f)
                    .execute(
                        &json!({"action": "fix", "apply": true, "structural": structural, "paths": ["a.sh", "b.ts"], "engines": ["biome"]}),
                        f.cwd.path(),
                        None,
                        None,
                    )
                    .await,
            );
            let ids: Vec<&str> = report["results"].as_array().unwrap().iter().filter_map(|r| r["id"].as_str()).collect();
            assert_eq!(ids, ["biome"], "structural={structural}: {report}");
            assert_eq!(std::fs::read_to_string(f.cwd.path().join("a.sh")).unwrap(), dirty, "structural={structural}");
        }
    }

    /// After the apply pass stops at an engine that could not run, the engines after it are
    /// reported as not run instead of vanishing.
    #[tokio::test]
    async fn engines_after_an_apply_stop_are_reported_not_run() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("a.sh", "echo a\n"), ("b.ts", "let b = 1;\n")]).await else { return eprintln!("skipped: python or git is missing") };
        let mut config: Value = serde_json::from_str(&std::fs::read_to_string(f.cwd.path().join(".mixdog/tidy.json")).unwrap()).unwrap();
        config["engines"]["shfmt"] = json!({"command": f._scripts.path().join("no-such-shfmt.exe").to_string_lossy()});
        std::fs::write(f.cwd.path().join(".mixdog/tidy.json"), config.to_string()).unwrap();
        let report = body(
            &graph_tool(&f)
                .execute(
                    &json!({"action": "fix", "apply": true, "structural": false, "paths": ["a.sh", "b.ts"], "engines": ["shfmt", "biome"]}),
                    f.cwd.path(),
                    None,
                    None,
                )
                .await,
        );
        let results = report["results"].as_array().unwrap();
        assert_eq!(results.len(), 2, "{report}");
        assert_eq!(results[1]["id"], "biome");
        assert!(results[1]["skipped"].as_str().unwrap_or("").contains("not run: the apply pass stopped at shfmt"), "{report}");
    }

    /// `engine.cwd` is where the engine runs, with its paths reported project-relative.
    #[tokio::test]
    async fn an_engine_runs_in_its_configured_directory() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("a.sh", "echo a\n  \necho b\n"), ("sub/keep.txt", "")]).await else {
            return eprintln!("skipped: python or git is missing");
        };
        let script = format!("{FAKE_SHFMT}\nopen('cwd.log', 'w').write('ran')\n");
        std::fs::write(f._scripts.path().join("shfmt.py"), script).unwrap();
        let mut config: Value = serde_json::from_str(&std::fs::read_to_string(f.cwd.path().join(".mixdog/tidy.json")).unwrap()).unwrap();
        config["engines"]["shfmt"]["cwd"] = json!("sub");
        std::fs::write(f.cwd.path().join(".mixdog/tidy.json"), config.to_string()).unwrap();
        let report = body(
            &graph_tool(&f).execute(&json!({"action": "check", "structural": false, "paths": ["a.sh"], "engines": ["shfmt"]}), f.cwd.path(), None, None).await,
        );
        assert!(f.cwd.path().join("sub/cwd.log").exists() && !f.cwd.path().join("cwd.log").exists(), "{report}");
        assert_eq!(report["results"][0]["filesChanged"], json!(["a.sh"]), "{report}");
    }

    /// A structural fix is written only to the bytes the scanner read: a same-length edit on the
    /// same line after the scan rejects the file.
    #[tokio::test]
    async fn a_structural_fix_is_not_written_over_a_file_edited_after_the_scan() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("a.sh", "echo a\n  # gone\necho b\n")]).await else { return eprintln!("skipped: python or git is missing") };
        let edit = "\nfor f in files:\n    p = os.path.join(a[0], f)\n    d = open(p, 'rb').read()\n    if b'# gone' in d:\n        open(p, 'wb').write(d.replace(b'# gone', b'# GONE'))\n";
        std::fs::write(f._scripts.path().join("graph.py"), format!("{FAKE_GRAPH}{edit}")).unwrap();
        let report =
            body(&graph_tool(&f).execute(&json!({"action": "fix", "apply": true, "paths": ["a.sh"], "engines": ["shfmt"]}), f.cwd.path(), None, None).await);
        assert_eq!(report["structural"]["applied"], json!([]), "{report}");
        assert!(report["structural"]["rejected"][0]["reason"].as_str().unwrap_or("").contains("the file changed since the scan"), "{report}");
        assert_eq!(std::fs::read_to_string(f.cwd.path().join("a.sh")).unwrap(), "echo a\n  # GONE\necho b\n");
    }

    /// The digest is the scanner's own: a file that changes while it is parsed and changes back
    /// afterwards no longer holds the bytes the fix was computed from, and is not written.
    #[tokio::test]
    async fn a_file_changed_and_restored_around_the_parse_is_not_written() {
        let probe = tool(Path::new("."));
        let original = "echo a\n  # gone\necho b\n";
        let Some(f) = fixture(&probe, &[("a.sh", original)]).await else { return eprintln!("skipped: python or git is missing") };
        let swap = |from: &str, to: &str| {
            format!("for f in files:\n    p = os.path.join(a[0], f)\n    d = open(p, 'rb').read()\n    open(p, 'wb').write(d.replace(b'{from}', b'{to}'))\n")
        };
        let graph = FAKE_GRAPH.replacen("n = 0\n", &format!("{}n = 0\n", swap("echo a", "echo A")), 1);
        std::fs::write(f._scripts.path().join("graph.py"), format!("{graph}\n{}", swap("echo A", "echo a"))).unwrap();
        let report =
            body(&graph_tool(&f).execute(&json!({"action": "fix", "apply": true, "paths": ["a.sh"], "engines": ["shfmt"]}), f.cwd.path(), None, None).await);
        assert_eq!(report["structural"]["applied"], json!([]), "{report}");
        assert!(report["structural"]["rejected"][0]["reason"].as_str().unwrap_or("").contains("the file changed since the scan"), "{report}");
        assert_eq!(std::fs::read_to_string(f.cwd.path().join("a.sh")).unwrap(), original);
    }

    /// A scanner that sends no digest with its fixes: they are stale, said so, and never written.
    #[tokio::test]
    async fn a_fix_without_the_scanners_digest_is_never_written() {
        let probe = tool(Path::new("."));
        let original = "echo a\n  # gone\necho b\n";
        let Some(f) = fixture(&probe, &[("a.sh", original)]).await else { return eprintln!("skipped: python or git is missing") };
        std::fs::write(f._scripts.path().join("graph.py"), FAKE_GRAPH.replace(r#""sha256": hashlib.sha256(data).hexdigest(), "#, "")).unwrap();
        let report =
            body(&graph_tool(&f).execute(&json!({"action": "fix", "apply": true, "paths": ["a.sh"], "engines": ["shfmt"]}), f.cwd.path(), None, None).await);
        assert_eq!(report["structural"]["applied"], json!([]), "{report}");
        assert!(report["structural"]["rejected"][0]["reason"].as_str().unwrap_or("").contains("did not send the SHA-256"), "{report}");
        assert_eq!(std::fs::read_to_string(f.cwd.path().join("a.sh")).unwrap(), original);
    }

    /// An engine that could not run is left out of the header and keeps its row and error.
    #[tokio::test]
    async fn an_engine_that_could_not_run_is_not_in_the_header() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("a.sh", "echo a\n")]).await else { return eprintln!("skipped: python or git is missing") };
        let mut config: Value = serde_json::from_str(&std::fs::read_to_string(f.cwd.path().join(".mixdog/tidy.json")).unwrap()).unwrap();
        config["engines"]["shfmt"] = json!({"command": f._scripts.path().join("no-such-shfmt.exe").to_string_lossy()});
        std::fs::write(f.cwd.path().join(".mixdog/tidy.json"), config.to_string()).unwrap();
        let report = body(
            &graph_tool(&f).execute(&json!({"action": "check", "structural": false, "paths": ["a.sh"], "engines": ["shfmt"]}), f.cwd.path(), None, None).await,
        );
        assert_eq!(report["engines"], json!([]), "{report}");
        assert!(report["results"][0]["error"].as_str().is_some_and(|e| !e.is_empty()), "{report}");
    }

    #[test]
    fn an_engine_that_failed_after_working_on_files_did_run() {
        let wrote_then_failed = json!({"id": "shfmt", "filesChecked": 2, "filesChanged": ["a.sh"], "error": "shfmt timed out"});
        let never_started = json!({"id": "shfmt", "filesChecked": 0, "filesChanged": [], "error": "shfmt could not run: program not found"});
        assert!(!got_nowhere(&wrote_then_failed, true) && got_nowhere(&never_started, true));
        // Files it could not process are an error on the row, not a failed engine.
        assert!(!got_nowhere(&never_started, false));
    }

    /// A shfmt stand-in that lists `a.sh`, cannot parse `bad.sh`, and cannot be started to write.
    struct StartsOnlyToCheck(Mutex<Vec<PathBuf>>);

    #[async_trait]
    impl super::super::runners::shared::Spawn for StartsOnlyToCheck {
        async fn run(
            &self,
            _: &str,
            args: &[String],
            cwd: &Path,
            _: std::time::Duration,
            _: Option<&CancellationToken>,
            _: Option<&HashMap<String, String>>,
            _: Option<Vec<u8>>,
        ) -> super::super::process::ProcessResult {
            use super::super::process::ProcessResult;
            self.0.lock().unwrap().push(cwd.to_owned());
            if args.iter().any(|a| a == "-w") {
                return ProcessResult { code: -1, error: "shfmt: program not found".into(), error_code: "NotFound".into(), ..Default::default() };
            }
            let listed = if args.iter().any(|a| a == "a.sh") { "a.sh\n" } else { "" };
            let stderr = if args.iter().any(|a| a == "bad.sh") { "bad.sh:2:10: `then` must be followed by a statement list" } else { "" };
            ProcessResult { code: 1, stdout: listed.into(), stderr: stderr.into(), ..Default::default() }
        }
    }

    /// The apply pass ends where the suite itself stopped: an engine with both files it could not
    /// process and an engine error ends it, and the next directory's engines do not write.
    #[tokio::test]
    async fn an_apply_stop_in_one_engine_directory_ends_the_pass() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        for name in ["a.sh", "bad.sh"] {
            std::fs::write(sub.join(name), "messy").unwrap();
        }
        let spawn = Arc::new(StartsOnlyToCheck(Mutex::default()));
        let shfmt = Resolved {
            id: "shfmt".into(),
            source: "path".into(),
            command: "shfmt".into(),
            languages: vec!["bash".into()],
            kind: vec!["format".into()],
            cwd: Some(sub.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let at_root = Resolved { cwd: None, ..shfmt.clone() };
        let mut o = SuiteOptions::new(dir.path(), vec!["sub/a.sh".into(), "sub/bad.sh".into()], &Processes::for_tests());
        (o.spawn, o.mode, o.apply) = (spawn.clone(), "fix".into(), true);
        let ran = run_suite(&[&shfmt, &at_root], &o).await;
        assert_eq!((ran.results.len(), ran.failed.clone()), (1, vec![true]), "{:?}", ran.results);
        assert_eq!(ran.results[0]["unprocessed"][0]["file"], "sub/bad.sh", "{:?}", ran.results);
        assert!(spawn.0.lock().unwrap().iter().all(|cwd| *cwd == sub), "no engine ran in the project root after the stop");
    }

    /// Downloads follow the files the engines will be given: a file kept from the apply pass
    /// because its real path leaves the project needs no engine.
    #[tokio::test]
    async fn an_escaping_file_does_not_bring_its_engine_in() {
        let Some(cwd) = git_project(&[(".mixdog/tidy.json", r#"{"policy":{"downloads":"ask"}}"#)]) else { return eprintln!("skipped: git is missing") };
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("a.lua"), "x = 1\n").unwrap();
        #[cfg(windows)]
        let linked = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(cwd.path().join("linked"))
            .arg(outside.path())
            .output()
            .is_ok_and(|o| o.status.success());
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(outside.path(), cwd.path().join("linked")).is_ok();
        if !linked {
            return eprintln!("skipped: cannot create a link here");
        }
        let data = tempfile::tempdir().unwrap();
        let report = body(
            &tool(data.path())
                .execute(&json!({"action": "fix", "apply": true, "structural": false, "paths": ["linked"], "engines": ["stylua"]}), cwd.path(), None, None)
                .await,
        );
        if report["error"].as_str().is_some_and(|e| e.contains("no requested path yields a file")) {
            return eprintln!("skipped: git does not list files behind this link");
        }
        assert!(report.get("needsApproval").is_none(), "{report}");
        assert!(report["unprocessed"][0]["reason"].as_str().unwrap_or("").contains("outside the project"), "{report}");
    }

    #[tokio::test]
    async fn formatter_only_apply_checks_its_candidates_once() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("a.sh", "echo a\n  \necho b\n")]).await else { return eprintln!("skipped: python or git is missing") };
        let script = format!("{FAKE_SHFMT}\nif '-l' in sys.argv:\n    with open('shfmt-checks.log', 'a') as log: log.write('check\\n')\n");
        std::fs::write(f._scripts.path().join("shfmt.py"), script).unwrap();
        let report = body(
            &graph_tool(&f)
                .execute(&json!({"action": "fix", "apply": true, "structural": false, "paths": ["a.sh"], "engines": ["shfmt"]}), f.cwd.path(), None, None)
                .await,
        );
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(std::fs::read_to_string(f.cwd.path().join("a.sh")).unwrap(), "echo a\necho b\n");
        assert_eq!(std::fs::read_to_string(f.cwd.path().join("shfmt-checks.log")).unwrap().lines().collect::<Vec<_>>(), ["check"]);
    }

    #[tokio::test]
    async fn structural_rules_skip_files_the_engine_configuration_ignores() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("src/ignored.ts", "# gone\n"), ("src/b.ts", "# gone\n")]).await else {
            return eprintln!("skipped: python or git is missing");
        };
        let t = graph_tool(&f);
        let report = body(&t.execute(&json!({"action": "check", "paths": ["src"], "engines": ["biome"]}), f.cwd.path(), None, None).await);
        let biome = &report["results"][0];
        assert_eq!(
            (biome["filesChecked"].clone(), biome["ignored"].clone(), biome["diagnosticsCount"].clone()),
            (json!(1), json!(["src/ignored.ts"]), json!(0)),
            "{report}"
        );
        let matches = report["structural"]["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1, "{report}");
        assert!(matches[0]["loc"].as_str().unwrap().starts_with("src/b.ts"));
        let again = body(&t.execute(&json!({"action": "check", "paths": ["src/ignored.ts"], "engines": ["biome"]}), f.cwd.path(), None, None).await);
        assert_eq!(again["results"][0]["filesChecked"], 0);
        assert_eq!(again["structural"]["matchesCount"], 0, "{again}");
        // No engine for typescript ran: eligibility is unknown, so the match is reported but never fixable.
        let unverified =
            body(&t.execute(&json!({"action": "fix", "apply": true, "paths": ["src/b.ts"], "engines": ["shfmt"]}), f.cwd.path(), None, None).await);
        let s = &unverified["structural"];
        assert_eq!(
            (s["matchesCount"].clone(), s["manual"].clone(), s.get("fixable").is_none(), s["applied"].clone()),
            (json!(1), json!(1), true, json!([])),
            "{unverified}"
        );
        assert!(s["note"].as_str().unwrap().contains("src/b.ts"));
        assert_eq!(std::fs::read_to_string(f.cwd.path().join("src/b.ts")).unwrap(), "# gone\n");
    }

    #[tokio::test]
    async fn a_truncated_engine_result_does_not_establish_structural_eligibility() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("src/truncated.ts", "# gone\n")]).await else { return eprintln!("skipped: python or git is missing") };
        let t = graph_tool(&f);
        for apply in [false, true] {
            let report = body(
                &t.execute(&json!({"action": "fix", "apply": apply, "paths": ["src/truncated.ts"], "engines": ["biome"]}), f.cwd.path(), None, None).await,
            );
            assert_eq!(report["results"][0]["truncated"], true, "{report}");
            let s = &report["structural"];
            assert_eq!(
                (s["matchesCount"].clone(), s["manual"].clone(), s.get("fixable").is_none(), s["applied"].clone()),
                (json!(1), json!(1), true, json!([])),
                "{report}"
            );
            assert!(s["note"].as_str().unwrap().contains("src/truncated.ts"), "{report}");
            assert_eq!(std::fs::read_to_string(f.cwd.path().join("src/truncated.ts")).unwrap(), "# gone\n");
        }
    }

    #[tokio::test]
    async fn apply_keeps_a_preflight_failure_instead_of_retrying_that_engine() {
        let probe = tool(Path::new("."));
        let Some(f) = fixture(&probe, &[("src/a.ts", "# gone\n")]).await else { return eprintln!("skipped: python or git is missing") };
        let script = format!(
            "import os\nif any(x.endswith('.ts') for x in __import__('sys').argv[1:]) and not os.path.exists('preflight-seen'):\n    open('preflight-seen', 'w').close()\n    print('{{\"summary\":{{\"diagnosticsNotPrinted\":1}},\"diagnostics\":[]}}')\n    raise SystemExit(0)\n{FAKE_BIOME}"
        );
        std::fs::write(f._scripts.path().join("biome.py"), script).unwrap();
        let t = graph_tool(&f);
        let report = body(&t.execute(&json!({"action": "fix", "apply": true, "paths": ["src"], "engines": ["biome"]}), f.cwd.path(), Some("s"), None).await);
        assert_eq!(report["ok"], false, "{report}");
        assert_eq!(report["results"][0]["truncated"], true, "{report}");
        let page = body(&t.execute(&json!({"action": "results", "engines": ["shfmt"], "structural": false}), f.cwd.path(), Some("s"), None).await);
        assert_eq!(page["status"], report["status"]);
        assert_eq!(page["scope"], json!(["src"]));
    }

    #[tokio::test]
    async fn results_keep_the_checked_scope_and_original_outcome_while_paging() {
        let (data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = tool(data.path());
        let diag = |n: i64| json!({"file": "src/a.ts", "line": n, "col": 1, "code": "r", "message": "m", "severity": "warning", "fixable": false});
        t.remember(cwd.path(), Some("s"), CachedRun {
            scope: vec!["src".into()],
            outcome: (json!(false), json!("partial")),
            languages: vec![],
            language_source: "git".into(),
            engines: vec![],
            results: Some(vec![json!({"id": "biome", "filesChecked": 1, "diagnostics": [diag(1), diag(2), diag(3)], "filesChanged": ["src/a.ts", "src/b.ts"], "ignored": ["src/x.ts", "src/y.ts"]})]),
            structural: json!({
                "applied": [{"file": "src/a.ts"}, {"file": "src/b.ts"}],
                "rejected": [{"file": "src/a.ts"}, {"file": "src/b.ts"}],
            }),
            unprocessed: vec![json!({"language": "ruby", "reason": "no formatter or linter engine exists for ruby", "count": 3, "files": ["src/a.rb", "src/b.rb", "lib/c.rb"]})],
        });
        // The unprocessed files page like the other file lists, all of them reachable.
        let ruby = body(&t.execute(&json!({"action": "results", "paths": ["src"], "offset": 1, "limit": 1}), cwd.path(), Some("s"), None).await);
        assert_eq!((ruby["unprocessed"][0]["files"].clone(), ruby["unprocessed"][0]["count"].clone()), (json!(["src/b.rb"]), json!(2)), "{ruby}");
        let first = body(&t.execute(&json!({"action": "results", "paths": ["."], "offset": 0, "limit": 1}), cwd.path(), Some("s"), None).await);
        assert_eq!((first["unprocessed"][0]["files"].clone(), first["unprocessed"][0]["filesNextOffset"].clone()), (json!(["src/a.rb"]), json!(1)), "{first}");
        assert_eq!(first["scope"], json!(["src"]));
        assert_eq!(first["pathFilter"], json!(["."]));
        assert_eq!((first["ok"].clone(), first["status"].clone()), (json!(false), json!("partial")));
        assert_eq!(
            (
                first["results"][0]["filesChanged"].clone(),
                first["results"][0]["filesChangedNextOffset"].clone(),
                first["results"][0]["ignoredNextOffset"].clone()
            ),
            (json!(["src/a.ts"]), json!(1), json!(1))
        );
        let page = body(&t.execute(&json!({"action": "results", "paths": ["src"], "offset": 1, "limit": 1}), cwd.path(), Some("s"), None).await);
        assert_eq!(
            (page["results"][0]["filesChanged"].clone(), page["results"][0]["filesChangedCount"].clone(), page["results"][0]["ignored"].clone()),
            (json!(["src/b.ts"]), json!(2), json!(["src/y.ts"]))
        );
        assert!(page["results"][0].get("filesChangedNextOffset").is_none());
        let unfiltered = body(&t.execute(&json!({"action": "results"}), cwd.path(), Some("s"), None).await);
        assert_eq!(unfiltered["scope"], json!(["src"]));
        assert!(unfiltered.get("pathFilter").is_none());
        let file = body(&t.execute(&json!({"action": "results", "paths": ["src/a.ts"]}), cwd.path(), Some("s"), None).await);
        assert_eq!(file["scope"], json!(["src"]));
        assert_eq!(file["pathFilter"], json!(["src/a.ts"]));
        for field in ["applied", "rejected"] {
            assert_eq!(file["structural"][field], json!([{"file": "src/a.ts"}]));
        }
    }

    #[tokio::test]
    async fn results_pages_the_cached_run_and_filters_before_paging() {
        let (data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = tool(data.path());
        let diag = |file: &str, code: &str| json!({"file": file, "line": 1, "col": 1, "code": code, "message": "m", "severity": "warning", "fixable": false});
        t.remember(cwd.path(), Some("s"), CachedRun {
            scope: vec![".".into()],
            outcome: (json!(true), json!("complete")),
            languages: vec![],
            language_source: "git".into(),
            engines: vec![],
            results: Some(vec![json!({"id": "biome", "filesChecked": 3, "diagnostics": [diag("src/a.ts", "r1"), diag("src/b.ts", "r2"), diag("lib/c.ts", "r1")], "filesChanged": ["src/a.ts"]})]),
            structural: Value::Null,
            unprocessed: vec![],
        });
        let all = body(&t.execute(&json!({"action": "results", "limit": 2}), cwd.path(), Some("s"), None).await);
        assert_eq!((all["results"][0]["diagnosticsCount"].clone(), all["results"][0]["more"].clone()), (json!(3), json!(1)));
        assert!(all.get("engines").is_none(), "a results page omits the header");
        let filtered = body(&t.execute(&json!({"action": "results", "rules": ["r1"], "paths": ["src"]}), cwd.path(), Some("s"), None).await);
        assert_eq!(filtered["results"][0]["diagnosticsCount"], 1);
        assert!(filtered["notes"][1].as_str().unwrap().contains("describe filtered rows"));
        assert!(t.recall(cwd.path(), Some("other")).is_none());
        t.reset_result_cache();
        assert!(t.recall(cwd.path(), Some("s")).is_none());
    }
}

fn env_map() -> HashMap<String, String> {
    std::env::vars().collect()
}
impl TidyTool {
    /// `processes` is the one process manager every engine child runs under, with the lane
    /// engine binaries are hashed on.
    pub fn new(host: Arc<dyn TidyHost>, processes: Processes) -> Self {
        Self { host, processes, probe_deadline: Some(PROBE_TIMEOUT), cache: Mutex::default() }
    }

    /// The tool with another deadline for the graph probe (`None`: no deadline), for a test whose stand-in graph it controls.
    #[cfg(test)]
    fn with_probe_deadline(mut self, deadline: Option<Duration>) -> Self {
        self.probe_deadline = deadline;
        self
    }

    pub fn reset_result_cache(&self) {
        self.cache.lock().unwrap().clear();
    }

    fn remember(&self, cwd: &Path, session: Option<&str>, run: CachedRun) {
        let key = format!("{}::{}", session.unwrap_or(""), cwd.display());
        let mut cache = self.cache.lock().unwrap();
        cache.retain(|(k, _)| *k != key);
        cache.push((key, Arc::new(run)));
        while cache.len() > RESULT_CACHE_MAX {
            cache.remove(0);
        }
    }

    fn recall(&self, cwd: &Path, session: Option<&str>) -> Option<Arc<CachedRun>> {
        let key = format!("{}::{}", session.unwrap_or(""), cwd.display());
        self.cache.lock().unwrap().iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
    }

    /// Executes one `tidy` call. Failures come back as an error result, never a thrown error.
    pub async fn execute(&self, args: &Value, cwd: &Path, session_id: Option<&str>, cancel: Option<&CancellationToken>) -> Value {
        let started = Instant::now();
        let action = args.get("action").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or("").to_lowercase();
        match self.dispatch(&action, args, cwd, session_id, cancel, started).await {
            Ok((report, is_error)) => tidy_tool_result(&report, is_error),
            Err(ToolError(message)) => tidy_tool_result(
                &json!({"ok": false, "status": "failed", "action": action, "error": message, "elapsedMs": started.elapsed().as_millis() as u64}),
                Some(true),
            ),
        }
    }

    async fn dispatch(
        &self,
        action: &str,
        args: &Value,
        cwd: &Path,
        session_id: Option<&str>,
        cancel: Option<&CancellationToken>,
        started: Instant,
    ) -> Result<(Value, Option<bool>), ToolError> {
        if !TIDY_ACTIONS.contains(&action) {
            return Err(ToolError(format!("Unsupported tidy action \"{action}\"; use {}", TIDY_ACTIONS.join(", "))));
        }
        let scope = normalize_scope(&list(args, "paths"), cwd)?;
        if ["scan", "check", "fix"].contains(&action) && scope.is_empty() {
            return Err(ToolError(
                "paths requires a user-selected scope; ask for files or directories, or use \".\" for an explicitly requested whole project".into(),
            ));
        }
        let mut run =
            Run { cwd, scope: scope.clone(), language_filter: list(args, "languages"), engine_filter: list(args, "engines"), session_id, cancel, started };
        if ["scan", "check", "fix"].contains(&action) {
            if let Some(id) = run.engine_filter.iter().find(|id| engine_entry(id).is_none()) {
                return Err(ToolError(format!("unknown engine \"{id}\"")));
            }
            let (lane, root, paths) = (self.processes.durability(), cwd.to_owned(), scope.clone());
            let missing = on_lane(lane, move || missing_paths_blocking(&root, &paths))
                .await
                .map_err(|_| ToolError("the paths could not be checked: their lane did not run the check".into()))?;
            if let Some(path) = missing.first() {
                return Err(ToolError(format!("path does not exist: {path}")));
            }
            // git matches paths by exact case; the disk (on Windows) does not.
            run.scope = requested_paths_on_disk(&self.processes, cwd, &run.scope).await.map_err(ToolError)?;
        }
        let report = match action {
            "scan" => self.scan(&run, args).await?,
            "install" => self.install(&run, args).await?,
            "rules" => self.rules(&run, args).await?,
            // Paging a stored run succeeds even when that run was incomplete; the report's
            // ok/status still describe the run itself.
            "results" => return Ok((self.results(&run, args)?, Some(false))),
            _ => self.run_action(action, &run, args).await?,
        };
        Ok((report, None))
    }

    async fn detect(&self, run: &Run<'_>) -> Result<Detection, ToolError> {
        let graph_bin = self.host.graph_binary().await;
        // One `--langs` call answers both: which extension map to detect with, and whether this
        // binary owns the structural scan protocol.
        let graph_langs = match &graph_bin {
            Some(bin) => probe_graph_langs_within(&self.processes, bin, run.cwd, self.probe_deadline, run.cancel).await,
            None => None,
        };
        if let Some(id) = run.language_filter.iter().find(|id| !is_known_language(id, graph_langs.as_ref())) {
            return Err(ToolError(format!("unknown language \"{id}\"")));
        }
        let detected =
            detect_languages(&self.processes, run.cwd, &run.scope, &run.language_filter, graph_langs.as_ref(), run.cancel).await.map_err(ToolError)?;
        if detected.empty_paths.len() == run.scope.len() {
            let each: Vec<String> = detected.empty_paths.iter().map(|(p, why)| format!("{p}: {why}")).collect();
            return Err(ToolError(format!("no requested path yields a file: {}", each.join("; "))));
        }
        Ok(Detection { detected, graph_bin, graph_langs })
    }

    fn empty_paths(d: &Detected) -> Vec<Value> {
        d.empty_paths.iter().map(|(path, reason)| json!({"path": path, "reason": reason})).collect()
    }

    /// Resolves the engines; a project config that cannot be honoured fails the call.
    async fn resolve(&self, run: &Run<'_>, detection: Option<&Detected>, probe_versions: bool) -> Result<(super::resolve::Resolution, Value), ToolError> {
        let manifest = read_engines_manifest();
        let resolution = resolve_engines(
            &self.processes,
            run.cwd,
            ResolveOptions {
                languages: detection.map(|d| d.languages.iter().map(|(l, _)| l.clone()).collect()).unwrap_or_default(),
                engine_ids: run.engine_filter.clone(),
                plugin_data: self.host.plugin_data(),
                manifest: Some(manifest.clone()),
                probe_versions,
                cancel: run.cancel.cloned(),
                ..Default::default()
            },
        )
        .await;
        if !resolution.config.error.is_empty() {
            return Err(ToolError(resolution.config.error));
        }
        Ok((resolution, manifest))
    }

    async fn satisfy_missing(
        &self,
        run: &Run<'_>,
        resolution: &mut super::resolve::Resolution,
        manifest: &Value,
        approve: bool,
        files: &[String],
        extensions: Option<&HashMap<String, String>>,
    ) -> (Value, Value) {
        let installable: Vec<String> = resolution
            .engines
            .iter()
            .filter(|e| e.missing && e.installable && e.skipped.is_none() && !files_for_languages(files, &e.languages, extensions).is_empty())
            .map(|e| e.id.clone())
            .collect();
        let policy = resolution.policy.downloads.clone();
        if installable.is_empty() || policy == "never" {
            return (Value::Null, Value::Null);
        }
        let plugin_data = self.host.plugin_data();
        if policy != "auto" && !approve {
            let plan = plan_install(&self.processes, &installable, manifest, &plugin_data, &policy, false).await;
            return (plan.needs_approval.unwrap_or(Value::Null), Value::Null);
        }
        let fetcher = self.host.fetcher();
        let cancel = run.cancel.cloned().unwrap_or_default();
        let outcome = install_engines(&self.processes, &installable, Some(manifest), &plugin_data, &policy, true, fetcher.as_ref(), &cancel, None, None).await;
        let ids: Vec<String> = if run.engine_filter.is_empty() { resolution.engines.iter().map(|e| e.id.clone()).collect() } else { run.engine_filter.clone() };
        let languages: Vec<String> = resolution.engines.iter().flat_map(|e| e.languages.clone()).collect();
        let refreshed = resolve_engines(
            &self.processes,
            run.cwd,
            ResolveOptions {
                languages,
                engine_ids: ids,
                plugin_data,
                manifest: Some(manifest.clone()),
                cancel: run.cancel.cloned(),
                probe_versions: true,
                ..Default::default()
            },
        )
        .await;
        resolution.engines = refreshed.engines;
        let mut installed = json!({"engines": outcome["installed"]});
        if outcome["errors"].as_array().is_some_and(|e| !e.is_empty()) {
            installed["errors"] = outcome["errors"].clone();
        }
        (Value::Null, installed)
    }

    async fn scan_structural(
        &self,
        adapter: &GraphStructuralAdapter,
        run: &Run<'_>,
        groups: &[&super::structural::RuleGroup],
        files: &[String],
        extensions: Option<&HashMap<String, String>>,
    ) -> Result<(Vec<Value>, Vec<Value>), ToolError> {
        let allowed: std::collections::HashSet<String> = files.iter().map(|f| match_file_key(f, run.cwd)).collect();
        let (mut matches, mut rule_errors) = (Vec::new(), Vec::new());
        // One unusable pack takes down its own language only; the rest still run.
        for group in groups {
            for chunk in chunk_structural_files(&files_for_structural_group(files, group, extensions), MAX_STRUCTURAL_FILE_ARGS) {
                let scan = adapter.scan(run.cwd, &group.rules_text, &chunk, true, run.cancel).await?;
                for m in scan["matches"].as_array().into_iter().flatten() {
                    let key = match_file_key(m["file"].as_str().unwrap_or(""), run.cwd);
                    if allowed.contains(&key) {
                        let mut m = m.clone();
                        m["file"] = json!(key);
                        matches.push(m);
                    }
                }
                if let Some(error) = scan.get("error").filter(|e| !e.is_null()) {
                    let mut e = json!({"language": group.language});
                    e.as_object_mut().expect("object").extend(error.as_object().cloned().unwrap_or_default());
                    rule_errors.push(e);
                }
            }
        }
        Ok((matches, rule_errors))
    }

    async fn run_structural(
        &self,
        run: &Run<'_>,
        d: &Detection,
        apply: bool,
        ignored: &std::collections::HashSet<String>,
        covered: &std::collections::HashSet<String>,
    ) -> Result<Value, ToolError> {
        let (_, groups) = load_rule_packs();
        if groups.is_empty() {
            return Ok(json!({"adapter": "none", "matches": [], "applied": [], "packs": [], "note": "no structural rule packs are installed"}));
        }
        // No fallback engine: an old or missing mixdog-graph fails the call with the rebuild remedy.
        let adapter =
            resolve_structural_adapter_within(&self.processes, run.cwd, d.graph_bin.as_deref(), Some(d.graph_langs.is_some()), self.probe_deadline, run.cancel)
                .await?;
        let files: Vec<String> = d.detected.files.iter().filter(|f| !ignored.contains(&match_file_key(f, run.cwd))).cloned().collect();
        if files.is_empty() {
            return Ok(json!({"adapter": GraphStructuralAdapter::ID, "packs": [], "matches": [], "applied": [], "note": "no files in scope"}));
        }
        let languages: Vec<String> = d.detected.languages.iter().map(|(l, _)| l.clone()).collect();
        let runnable = groups_for_languages(&groups, &languages);
        let (mut matches, rule_errors) = self.scan_structural(&adapter, run, &runnable, &files, d.detected.extensions.as_ref()).await?;
        let withheld = withhold_uncovered_fixes(&mut matches, d.detected.extensions.as_ref(), covered);
        let mut structural = json!({"adapter": GraphStructuralAdapter::ID, "packs": runnable.iter().flat_map(|g| g.packs.clone()).collect::<Vec<_>>(), "matches": matches, "applied": []});
        if !withheld.is_empty() {
            structural["note"] = json!(format!(
                "structural fixes withheld for {} file(s) whose language has engines but none ran in this call, so the project's ignore configuration could not be consulted: {}",
                withheld.len(),
                withheld.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
        if !rule_errors.is_empty() {
            structural["error"] = rule_errors[0].clone();
            structural["ruleErrors"] = json!(rule_errors);
        }
        if !apply || structural.get("error").is_some() || structural["matches"].as_array().is_some_and(Vec::is_empty) {
            return Ok(structural);
        }
        self.write_structural_fixes(run, &mut structural).await;
        Ok(structural)
    }

    async fn write_structural_fixes(&self, run: &Run<'_>, structural: &mut Value) {
        let mut by_file: Vec<(String, Vec<Value>)> = Vec::new();
        for m in structural["matches"].as_array().into_iter().flatten().filter(|m| m.get("fix").is_some_and(|f| !f.is_null())) {
            let file = m["file"].as_str().unwrap_or("").to_owned();
            match by_file.iter_mut().find(|(f, _)| *f == file) {
                Some((_, v)) => v.push(m.clone()),
                None => by_file.push((file, vec![m.clone()])),
            }
        }
        let host = self.host.write_host();
        let outcome = apply_structural_fixes(self.processes.durability(), host.as_ref(), run.cwd, &by_file, run.session_id, run.cancel).await;
        structural["applied"] = json!(outcome.applied);
        if !outcome.rejected.is_empty() {
            structural["rejected"] = json!(outcome.rejected);
        }
    }

    async fn engine_shadows(&self, engines: &[Resolved], cwd: &Path, notes: &mut Vec<String>) -> Option<Vec<Value>> {
        match detect_engine_shadows(&self.processes, engines, &env_map(), cwd).await {
            Ok(rows) => Some(rows),
            Err(note) => {
                notes.push(note);
                None
            }
        }
    }

    async fn outdated_graph_note(d: &Detection) -> Vec<String> {
        match (&d.graph_bin, &d.graph_langs) {
            (Some(bin), None) => vec![structural_unavailable_message(&bin.to_string_lossy())],
            _ => Vec::new(),
        }
    }

    async fn scan(&self, run: &Run<'_>, args: &Value) -> Result<Value, ToolError> {
        let d = self.detect(run).await?;
        let (resolution, _) = self.resolve(run, Some(&d.detected), true).await?;
        let mut notes: Vec<String> = Vec::new();
        if !resolution.unknown_engines.is_empty() {
            notes.push(format!("unknown engines ignored: {}", resolution.unknown_engines.join(", ")));
        }
        // Scan does not run structural rules, but an outdated binary that would fail check/fix is
        // named here so it cannot look like a clean project.
        notes.extend(Self::outdated_graph_note(&d).await);
        notes.extend(unavailable_notes(&resolution.engines));
        let unprocessed = unprocessed_files(&d.detected.files, d.detected.extensions.as_ref(), &resolution.engines, None, &[], run.cwd);
        let shadows = self.engine_shadows(&resolution.engines, run.cwd, &mut notes).await;
        Ok(build_tidy_report(ReportInput {
            action: "scan".into(),
            languages: d.detected.languages.iter().map(|(l, n)| json!({"id": l, "files": n})).collect(),
            language_source: d.detected.source.into(),
            policy: policy_json(&resolution.policy),
            shadows,
            scope: if run.scope.is_empty() { Value::Null } else { json!(run.scope) },
            engines: resolution.engines,
            unprocessed,
            empty_paths: Self::empty_paths(&d.detected),
            notes,
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            // A scan keeps nothing: the next page of its file lists is the same scan from `offset`.
            offset: parse_offset(args.get("offset")),
            ..Default::default()
        }))
    }

    async fn split_run_findings(&self, run: &Run<'_>, results: &[Value], structural: &Value) -> Value {
        let findings = finding_files_by_count(results, structural, run.cwd);
        if findings.is_empty() {
            return Value::Null;
        }
        let changes = list_working_tree_changes(&self.processes, run.cwd, run.cancel).await;
        if let Some(skipped) = changes.skipped {
            return json!({"skipped": skipped});
        }
        match changes.files {
            Some(files) => split_findings_by_worktree(&findings, &files),
            None => json!({"error": changes.error}),
        }
    }

    async fn run_action(&self, action: &str, run: &Run<'_>, args: &Value) -> Result<Value, ToolError> {
        let apply = action == "fix" && args.get("apply") == Some(&Value::Bool(true));
        let d = self.detect(run).await?;
        let (mut resolution, manifest) = self.resolve(run, Some(&d.detected), true).await?;
        // Engines rewrite in place: a file whose real path leaves the project never reaches an
        // apply pass, and is reported instead.
        let excluded = if apply {
            escaping_write_targets(self.processes.durability(), run.cwd, &d.detected.files, &d.detected.links).await.map_err(ToolError)?
        } else {
            Vec::new()
        };
        let engine_files: Vec<String> = d.detected.files.iter().filter(|f| !excluded.iter().any(|(x, _)| x == *f)).cloned().collect();
        // Downloads follow the files the engines will be given.
        let (needs_approval, installed) = self
            .satisfy_missing(
                run,
                &mut resolution,
                &manifest,
                args.get("approveDownloads") == Some(&Value::Bool(true)),
                &engine_files,
                d.detected.extensions.as_ref(),
            )
            .await;
        let runnable: Vec<&Resolved> = resolution.engines.iter().filter(|e| e.runnable()).collect();
        let mut options = SuiteOptions::new(run.cwd, engine_files.clone(), &self.processes);
        options.mode = if action == "fix" { "fix" } else { "check" }.into();
        options.cancel = run.cancel.cloned();
        options.session_id = run.session_id.map(str::to_owned);
        options.extensions = d.detected.extensions.clone();
        options.host = Some(self.host.write_host());
        let structural_enabled = args.get("structural") != Some(&Value::Bool(false));
        // Only the structural pass needs an extra preflight. The apply suite checks its own candidates.
        options.apply = apply && !structural_enabled;
        let mut suite = run_suite(&runnable, &options).await;
        let structural = if structural_enabled {
            let engines_failed = suite.failed.iter().any(|f| *f);
            let ignored = ignored_files(&suite.results, run.cwd);
            let covered = covered_languages(&suite, &runnable);
            self.run_structural(run, &d, apply && !engines_failed, &ignored, &covered).await?
        } else {
            Value::Null
        };
        if apply && structural_enabled {
            options.apply = true;
            suite = apply_after_preflight(suite, &runnable, &options).await;
        }
        append_not_run(&mut suite, &runnable);
        let ran = engines_that_ran(&suite, &runnable, &engine_files, d.detected.extensions.as_ref());
        let unprocessed = unprocessed_files(&d.detected.files, d.detected.extensions.as_ref(), &resolution.engines, Some(&suite), &excluded, run.cwd);
        let results = suite.results;
        let languages: Vec<Value> = d.detected.languages.iter().map(|(l, n)| json!({"id": l, "files": n})).collect();
        let mut cached = CachedRun {
            scope: run.scope.clone(),
            outcome: (Value::Null, Value::Null),
            languages: languages.clone(),
            language_source: d.detected.source.into(),
            engines: resolution.engines.clone(),
            results: Some(results.clone()),
            structural: structural.clone(),
            unprocessed: unprocessed.clone(),
        };
        let mut notes: Vec<String> = Vec::new();
        if action == "fix" && !apply {
            notes.push("dry run: pass apply:true to write these changes".into());
        }
        for e in installed["errors"].as_array().into_iter().flatten() {
            notes.push(format!("{}: {}", e["id"].as_str().unwrap_or(""), e["error"].as_str().unwrap_or("")));
        }
        let function_length =
            summarize_function_lengths(self.host.outline_source().as_ref(), run.cwd, &d.detected.files, &run.cancel.cloned().unwrap_or_default()).await;
        let working_tree = self.split_run_findings(run, &results, &structural).await;
        notes.extend(unavailable_notes(&resolution.engines));
        let shadows = self.engine_shadows(&resolution.engines, run.cwd, &mut notes).await;
        let mut report = build_tidy_report(ReportInput {
            ran,
            unprocessed,
            empty_paths: Self::empty_paths(&d.detected),
            action: action.into(),
            languages,
            language_source: d.detected.source.into(),
            policy: policy_json(&resolution.policy),
            shadows,
            working_tree,
            results: Some(results),
            structural,
            function_length,
            needs_approval,
            installed: installed.get("engines").cloned().unwrap_or(Value::Null),
            scope: if run.scope.is_empty() { Value::Null } else { json!(run.scope) },
            engines: resolution.engines,
            notes,
            offset: parse_offset(args.get("offset")),
            limit: parse_limit(args.get("limit")),
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            ..Default::default()
        });
        cached.outcome = (report["ok"].clone(), report["status"].clone());
        self.remember(run.cwd, run.session_id, cached);
        let more = report["results"].as_array().into_iter().flatten().any(|r| r["more"].as_i64().unwrap_or(0) > 0)
            || report["structural"]["more"].as_i64().unwrap_or(0) > 0;
        if more {
            let mut notes = report["notes"].as_array().cloned().unwrap_or_default();
            notes.push(json!(PAGING_NOTE));
            report["notes"] = json!(notes);
        }
        Ok(report)
    }

    fn results(&self, run: &Run<'_>, args: &Value) -> Result<Value, ToolError> {
        let cached = self.recall(run.cwd, run.session_id).ok_or_else(|| ToolError("no stored tidy results for this session; run check or fix first".into()))?;
        let mut results = cached.results.clone().map(|rs| {
            if run.engine_filter.is_empty() { rs } else { rs.into_iter().filter(|r| run.engine_filter.iter().any(|e| r["id"] == e.as_str())).collect() }
        });
        let rules = list(args, "rules");
        // The stored rows are filtered as the disk would match them (on Windows, in any letter
        // case), whether or not their files are still there.
        let fold = |path: &str| if cfg!(windows) { path.to_lowercase() } else { path.to_owned() };
        let prefixes: Vec<String> = run.scope.iter().map(|p| fold(p.trim_end_matches('/'))).collect();
        let cwd = run.cwd;
        let matches_path = |file: &str| {
            let path = fold(&match_file_key(file, cwd));
            prefixes.is_empty() || prefixes.iter().any(|p| p.is_empty() || p == "." || path == *p || path.starts_with(&format!("{p}/")))
        };
        let matches_row = |row: &Value| {
            let rule = row.get("ruleId").filter(|v| !v.is_null()).or_else(|| row.get("code")).and_then(Value::as_str).unwrap_or("");
            (rules.is_empty() || rules.iter().any(|r| r == rule)) && matches_path(row["file"].as_str().unwrap_or(""))
        };
        let mut structural = if args.get("structural") == Some(&Value::Bool(false)) { Value::Null } else { cached.structural.clone() };
        let filtered = !rules.is_empty() || !prefixes.is_empty();
        if filtered {
            results = results.map(|rs| rs.into_iter().map(|r| filter_engine_row(r, &matches_row, &matches_path)).collect());
            if !structural.is_null() {
                structural["matches"] = json!(structural["matches"].as_array().into_iter().flatten().filter(|m| matches_row(m)).cloned().collect::<Vec<_>>());
                if !prefixes.is_empty() {
                    for field in ["applied", "rejected"] {
                        if let Some(rows) = structural.get_mut(field).and_then(Value::as_array_mut) {
                            rows.retain(|row| row["file"].as_str().is_some_and(matches_path));
                        }
                    }
                }
            }
        }
        let mut notes = vec!["paged from the last check/fix; engines were not re-run".to_owned()];
        if filtered {
            notes.push("diagnosticsCount/matchesCount and byRule/byDir describe filtered rows; counts/filesChecked retain run totals".into());
        }
        let unprocessed: Vec<Value> = cached
            .unprocessed
            .iter()
            .filter_map(|group| {
                let files: Vec<Value> = group["files"].as_array().into_iter().flatten().filter(|f| matches_path(f.as_str().unwrap_or(""))).cloned().collect();
                let mut group = group.clone();
                group["count"] = json!(files.len());
                group["files"] = json!(files);
                (group["count"] != 0).then_some(group)
            })
            .collect();
        let mut report = build_tidy_report(ReportInput {
            action: "results".into(),
            engines: cached.engines.clone(),
            results,
            structural,
            unprocessed,
            scope: json!(cached.scope),
            languages: cached.languages.clone(),
            language_source: cached.language_source.clone(),
            notes,
            offset: parse_offset(args.get("offset")),
            limit: parse_limit(args.get("limit")),
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            ..Default::default()
        });
        report["ok"] = cached.outcome.0.clone();
        report["status"] = cached.outcome.1.clone();
        if !run.scope.is_empty() {
            report["pathFilter"] = json!(run.scope);
        }
        Ok(report)
    }

    async fn install(&self, run: &Run<'_>, args: &Value) -> Result<Value, ToolError> {
        if run.engine_filter.is_empty() {
            return Err(ToolError("install requires engines:[...]".into()));
        }
        let (resolution, manifest) = self.resolve(run, None, false).await?;
        let fetcher = self.host.fetcher();
        let cancel = run.cancel.cloned().unwrap_or_default();
        let outcome = install_engines(
            &self.processes,
            &run.engine_filter,
            Some(&manifest),
            &self.host.plugin_data(),
            &resolution.policy.downloads,
            args.get("approveDownloads") == Some(&Value::Bool(true)),
            fetcher.as_ref(),
            &cancel,
            None,
            None,
        )
        .await;
        let errors = outcome["errors"].as_array().cloned().unwrap_or_default();
        Ok(build_tidy_report(ReportInput {
            action: "install".into(),
            ok: errors.is_empty(),
            policy: policy_json(&resolution.policy),
            engines: resolution.engines,
            installed: outcome["installed"].clone(),
            needs_approval: outcome["needsApproval"].clone(),
            errors,
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            ..Default::default()
        }))
    }

    async fn rules(&self, run: &Run<'_>, args: &Value) -> Result<Value, ToolError> {
        let (packs, _) = load_rule_packs();
        if let Some(id) = run.language_filter.iter().find(|id| !is_known_language(id, None) && !packs.iter().any(|p| p.languages.contains(id))) {
            return Err(ToolError(format!("unknown language \"{id}\"")));
        }
        let selected = packs_for_languages(&packs, &run.language_filter);
        // Paging only when asked: with no `limit` every matching pack is listed.
        let offset = parse_offset(args.get("offset")).min(selected.len());
        let take = if args.get("limit").is_some() { parse_limit(args.get("limit")) } else { selected.len() };
        let page: Vec<&RulePack> = selected.iter().skip(offset).take(take).copied().collect();
        let more = selected.len() - offset - page.len();
        // Listing the packs still works without the engine; the report says so explicitly
        // (ok:false + the remedy) instead of showing a usable adapter.
        let bin = self.host.graph_binary().await;
        let adapter = resolve_structural_adapter_within(&self.processes, run.cwd, bin.as_deref(), None, self.probe_deadline, run.cancel).await;
        let (adapter_id, unavailable) = match &adapter {
            Ok(_) => (GraphStructuralAdapter::ID, String::new()),
            Err(e) => ("none", e.to_string()),
        };
        let mut rules = json!({"adapter": adapter_id, "packsCount": selected.len(), "packs": page.iter().map(|p| json!({"id": p.id, "languages": p.languages, "rules": p.rules})).collect::<Vec<_>>()});
        if more > 0 {
            rules["more"] = json!(more);
            rules["nextOffset"] = json!(offset + page.len());
        }
        Ok(build_tidy_report(ReportInput {
            action: "rules".into(),
            ok: unavailable.is_empty(),
            languages: run.language_filter.iter().map(|l| json!({"id": l})).collect(),
            rules,
            errors: if unavailable.is_empty() { Vec::new() } else { vec![json!(unavailable)] },
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            ..Default::default()
        }))
    }
}
