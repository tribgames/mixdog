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
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::apply::{WriteHost, apply_structural_fixes};
use super::function_length::{OutlineSource, summarize_function_lengths};
use super::install::{install_engines, plan_install, read_engines_manifest};
use super::languages::{Detected, GraphLangs, detect_languages};
use super::process::Processes;
use super::report::{DIAGNOSTIC_CAP, RESULTS_PAGE_MAX, ReportInput, build_tidy_report, tidy_tool_result};
use super::resolve::{DownloadPolicy, ResolveOptions, Resolved, resolve_engines};
use super::run_engines::{SuiteOptions, run_engine_suite};
use super::shadow::detect_engine_shadows;
use super::structural::{GraphStructuralAdapter, StructuralEngineUnavailable, files_for_structural_group, groups_for_languages, load_rule_packs, probe_graph_langs, resolve_structural_adapter, structural_unavailable_message};
use super::worktree::{list_working_tree_changes, split_findings_by_worktree};
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
    fn graph_binary(&self) -> Option<PathBuf>;
    fn write_host(&self) -> Arc<dyn WriteHost>;
    fn outline_source(&self) -> Arc<dyn OutlineSource>;
    fn fetcher(&self) -> Arc<dyn Fetcher>;
}

struct CachedRun {
    languages: Vec<Value>,
    language_source: String,
    engines: Vec<Resolved>,
    results: Option<Vec<Value>>,
    structural: Value,
    scope: Vec<String>,
}

pub struct TidyTool {
    host: Arc<dyn TidyHost>,
    processes: Processes,
    cache: Mutex<Vec<(String, Arc<CachedRun>)>>,
}

#[derive(Debug)]
struct ToolError(String);

impl From<StructuralEngineUnavailable> for ToolError {
    fn from(e: StructuralEngineUnavailable) -> Self {
        Self(e.to_string())
    }
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

fn match_file_key(file: &str, cwd: &Path) -> String {
    let raw = file.replace('\\', "/");
    if raw.is_empty() {
        return raw;
    }
    let root = cwd.to_string_lossy().replace('\\', "/");
    let root = root.trim_end_matches('/');
    if !root.is_empty() && (raw == root || raw.starts_with(&format!("{root}/"))) {
        return raw[root.len() + 1..].to_owned();
    }
    raw.strip_prefix("./").unwrap_or(&raw).to_owned()
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
                let n = value.replace('\\', "/");
                let n = n.strip_prefix("./").unwrap_or(&n).to_owned();
                if n.split('/').any(|s| s == "..") {
                    return Err(ToolError(format!("paths must stay inside the project: {value}")));
                }
                return Ok(n);
            }
            let rel = super::runners::shared::to_rel(cwd, value);
            if rel.starts_with("..") || Path::new(&rel).is_absolute() {
                return Err(ToolError(format!("paths must stay inside the project: {value}")));
            }
            Ok(if rel.is_empty() { ".".to_owned() } else { rel })
        })
        .collect()
}

fn policy_json(p: &DownloadPolicy) -> Value {
    let mut v = json!({"downloads": p.downloads, "source": p.source});
    if let Some(w) = &p.warning {
        v["warning"] = json!(w);
    }
    v
}

fn env_map() -> HashMap<String, String> {
    std::env::vars().collect()
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

impl TidyTool {
    /// `processes` is the one process manager every engine child runs under, with the lane
    /// engine binaries are hashed on.
    pub fn new(host: Arc<dyn TidyHost>, processes: Processes) -> Self {
        Self { host, processes, cache: Mutex::default() }
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
            Err(ToolError(message)) => tidy_tool_result(&json!({"ok": false, "status": "failed", "action": action, "error": message, "elapsedMs": started.elapsed().as_millis() as u64}), Some(true)),
        }
    }

    async fn dispatch(&self, action: &str, args: &Value, cwd: &Path, session_id: Option<&str>, cancel: Option<&CancellationToken>, started: Instant) -> Result<(Value, Option<bool>), ToolError> {
        if !TIDY_ACTIONS.contains(&action) {
            return Err(ToolError(format!("Unsupported tidy action \"{action}\"; use {}", TIDY_ACTIONS.join(", "))));
        }
        let scope = normalize_scope(&list(args, "paths"), cwd)?;
        if ["scan", "check", "fix"].contains(&action) && scope.is_empty() {
            return Err(ToolError("paths requires a user-selected scope; ask for files or directories, or use \".\" for an explicitly requested whole project".into()));
        }
        let run = Run { cwd, scope: scope.clone(), language_filter: list(args, "languages"), engine_filter: list(args, "engines"), session_id, cancel, started };
        let report = match action {
            "scan" => self.scan(&run).await,
            "install" => self.install(&run, args).await?,
            "rules" => self.rules(&run).await,
            // Paging a stored run succeeds even when that run was incomplete; the report's
            // ok/status still describe the run itself.
            "results" => return Ok((self.results(&run, args)?, Some(false))),
            _ => self.run_action(action, &run, args).await?,
        };
        Ok((report, None))
    }

    async fn detect(&self, run: &Run<'_>) -> Detection {
        let graph_bin = self.host.graph_binary();
        // One `--langs` call answers both: which extension map to detect with, and whether this
        // binary owns the structural scan protocol.
        let graph_langs = match &graph_bin {
            Some(bin) => probe_graph_langs(&self.processes, bin, run.cwd, run.cancel).await,
            None => None,
        };
        let detected = detect_languages(&self.processes, run.cwd, &run.scope, &run.language_filter, graph_langs.as_ref(), run.cancel).await;
        Detection { detected, graph_bin, graph_langs }
    }

    async fn resolve(&self, run: &Run<'_>, detection: Option<&Detected>, probe_versions: bool) -> (super::resolve::Resolution, Value) {
        let manifest = read_engines_manifest();
        let resolution = resolve_engines(&self.processes, run.cwd, ResolveOptions {
            languages: detection.map(|d| d.languages.iter().map(|(l, _)| l.clone()).collect()).unwrap_or_default(),
            engine_ids: run.engine_filter.clone(),
            plugin_data: self.host.plugin_data(),
            manifest: Some(manifest.clone()),
            probe_versions,
            cancel: run.cancel.cloned(),
            ..Default::default()
        })
        .await;
        (resolution, manifest)
    }

    /// Missing-but-downloadable engines: installed when policy or the caller approves, otherwise
    /// the approval request goes back to the caller.
    async fn satisfy_missing(&self, run: &Run<'_>, resolution: &mut super::resolve::Resolution, manifest: &Value, approve: bool) -> (Value, Value) {
        let installable: Vec<String> = resolution.engines.iter().filter(|e| e.missing && e.installable).map(|e| e.id.clone()).collect();
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
        let refreshed = resolve_engines(&self.processes, run.cwd, ResolveOptions { languages, engine_ids: ids, plugin_data, manifest: Some(manifest.clone()), cancel: run.cancel.cloned(), probe_versions: true, ..Default::default() }).await;
        resolution.engines = refreshed.engines;
        let mut installed = json!({"engines": outcome["installed"]});
        if outcome["errors"].as_array().is_some_and(|e| !e.is_empty()) {
            installed["errors"] = outcome["errors"].clone();
        }
        (Value::Null, installed)
    }

    async fn scan_structural(&self, adapter: &GraphStructuralAdapter, run: &Run<'_>, groups: &[&super::structural::RuleGroup], files: &[String], extensions: Option<&HashMap<String, String>>) -> Result<(Vec<Value>, Vec<Value>), ToolError> {
        let allowed: std::collections::HashSet<String> = files.iter().map(|f| match_file_key(f, run.cwd)).collect();
        let (mut matches, mut rule_errors) = (Vec::new(), Vec::new());
        // One unusable pack takes down its own language only; the rest still run.
        for group in groups {
            for chunk in chunk_structural_files(&files_for_structural_group(files, group, extensions), MAX_STRUCTURAL_FILE_ARGS) {
                let scan = adapter.scan(run.cwd, &group.rules_text, &chunk, true, run.cancel).await?;
                matches.extend(scan["matches"].as_array().into_iter().flatten().filter(|m| allowed.contains(&match_file_key(m["file"].as_str().unwrap_or(""), run.cwd))).cloned());
                if let Some(error) = scan.get("error").filter(|e| !e.is_null()) {
                    let mut e = json!({"language": group.language});
                    e.as_object_mut().expect("object").extend(error.as_object().cloned().unwrap_or_default());
                    rule_errors.push(e);
                }
            }
        }
        Ok((matches, rule_errors))
    }

    async fn run_structural(&self, run: &Run<'_>, d: &Detection, apply: bool) -> Result<Value, ToolError> {
        let (_, groups) = load_rule_packs();
        if groups.is_empty() {
            return Ok(json!({"adapter": "none", "matches": [], "applied": [], "packs": [], "note": "no structural rule packs are installed"}));
        }
        // No fallback engine: an old or missing mixdog-graph fails the call with the rebuild remedy.
        let adapter = resolve_structural_adapter(&self.processes, run.cwd, d.graph_bin.as_deref(), Some(d.graph_langs.is_some()), run.cancel).await?;
        if d.detected.files.is_empty() {
            return Ok(json!({"adapter": GraphStructuralAdapter::ID, "packs": [], "matches": [], "applied": [], "note": "no files in scope"}));
        }
        let languages: Vec<String> = d.detected.languages.iter().map(|(l, _)| l.clone()).collect();
        let runnable = groups_for_languages(&groups, &languages);
        let (matches, rule_errors) = self.scan_structural(&adapter, run, &runnable, &d.detected.files, d.detected.extensions.as_ref()).await?;
        let mut structural = json!({"adapter": GraphStructuralAdapter::ID, "packs": runnable.iter().flat_map(|g| g.packs.clone()).collect::<Vec<_>>(), "matches": matches, "applied": []});
        if !rule_errors.is_empty() {
            structural["error"] = rule_errors[0].clone();
            structural["ruleErrors"] = json!(rule_errors);
        }
        if !apply || structural.get("error").is_some() || structural["matches"].as_array().is_some_and(Vec::is_empty) {
            return Ok(structural);
        }
        // `--fix` emitted the payloads; tidy stays the only writer.
        let mut by_file: Vec<(String, Vec<Value>)> = Vec::new();
        for m in structural["matches"].as_array().into_iter().flatten().filter(|m| m.get("fix").is_some_and(|f| !f.is_null())) {
            let file = m["file"].as_str().unwrap_or("").to_owned();
            match by_file.iter_mut().find(|(f, _)| *f == file) {
                Some((_, v)) => v.push(m.clone()),
                None => by_file.push((file, vec![m.clone()])),
            }
        }
        let host = self.host.write_host();
        let outcome = apply_structural_fixes(host.as_ref(), run.cwd, &by_file, run.session_id).await;
        structural["applied"] = json!(outcome.applied);
        if !outcome.rejected.is_empty() {
            structural["rejected"] = json!(outcome.rejected);
        }
        Ok(structural)
    }

    async fn outdated_graph_note(d: &Detection) -> Vec<String> {
        match (&d.graph_bin, &d.graph_langs) {
            (Some(bin), None) => vec![structural_unavailable_message(&bin.to_string_lossy())],
            _ => Vec::new(),
        }
    }

    async fn scan(&self, run: &Run<'_>) -> Value {
        let d = self.detect(run).await;
        let (resolution, _) = self.resolve(run, Some(&d.detected), true).await;
        let mut notes: Vec<String> = Vec::new();
        notes.extend(d.detected.note.clone());
        if !resolution.config.error.is_empty() {
            notes.push(resolution.config.error.clone());
        }
        if !resolution.unknown_engines.is_empty() {
            notes.push(format!("unknown engines ignored: {}", resolution.unknown_engines.join(", ")));
        }
        if d.detected.languages.is_empty() {
            notes.push("no non-ignored file of a known language in scope".into());
        }
        // Scan does not run structural rules, but an outdated binary that would fail check/fix is
        // named here so it cannot look like a clean project.
        notes.extend(Self::outdated_graph_note(&d).await);
        build_tidy_report(ReportInput {
            action: "scan".into(),
            languages: d.detected.languages.iter().map(|(l, n)| json!({"id": l, "files": n})).collect(),
            language_source: d.detected.source.into(),
            policy: policy_json(&resolution.policy),
            shadows: Some(detect_engine_shadows(&self.processes, &resolution.engines, &env_map(), None).await),
            scope: if run.scope.is_empty() { Value::Null } else { json!(run.scope) },
            engines: resolution.engines,
            notes,
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            ..Default::default()
        })
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
        let d = self.detect(run).await;
        let (mut resolution, manifest) = self.resolve(run, Some(&d.detected), true).await;
        let (needs_approval, installed) = self.satisfy_missing(run, &mut resolution, &manifest, args.get("approveDownloads") == Some(&Value::Bool(true))).await;
        let runnable: Vec<&Resolved> = resolution.engines.iter().filter(|e| e.runnable()).collect();
        let mut options = SuiteOptions::new(run.cwd, d.detected.files.clone(), &self.processes);
        options.mode = if action == "fix" { "fix" } else { "check" }.into();
        options.apply = apply;
        options.cancel = run.cancel.cloned();
        options.session_id = run.session_id.map(str::to_owned);
        options.extensions = d.detected.extensions.clone();
        options.host = Some(self.host.write_host());
        let results = run_engine_suite(&runnable, &options).await;
        let engines_failed = results.iter().any(|r| r.get("error").is_some_and(|e| !e.is_null()) || r["truncated"] == true);
        let structural = if args.get("structural") == Some(&Value::Bool(false)) { Value::Null } else { self.run_structural(run, &d, apply && !engines_failed).await? };
        let languages: Vec<Value> = d.detected.languages.iter().map(|(l, n)| json!({"id": l, "files": n})).collect();
        self.remember(run.cwd, run.session_id, CachedRun {
            languages: languages.clone(),
            language_source: d.detected.source.into(),
            engines: resolution.engines.clone(),
            results: Some(results.clone()),
            structural: structural.clone(),
            scope: run.scope.clone(),
        });
        let mut notes: Vec<String> = Vec::new();
        notes.extend(d.detected.note.clone());
        if !resolution.config.error.is_empty() {
            notes.push(resolution.config.error.clone());
        }
        if action == "fix" && !apply {
            notes.push("dry run: pass apply:true to write these changes".into());
        }
        for e in installed["errors"].as_array().into_iter().flatten() {
            notes.push(format!("{}: {}", e["id"].as_str().unwrap_or(""), e["error"].as_str().unwrap_or("")));
        }
        let function_length = summarize_function_lengths(self.host.outline_source().as_ref(), run.cwd, &d.detected.files, &run.cancel.cloned().unwrap_or_default()).await;
        let working_tree = self.split_run_findings(run, &results, &structural).await;
        let shadows = detect_engine_shadows(&self.processes, &resolution.engines, &env_map(), None).await;
        let mut report = build_tidy_report(ReportInput {
            action: action.into(),
            languages,
            language_source: d.detected.source.into(),
            policy: policy_json(&resolution.policy),
            shadows: Some(shadows),
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
        let more = report["results"].as_array().into_iter().flatten().any(|r| r["more"].as_i64().unwrap_or(0) > 0) || report["structural"]["more"].as_i64().unwrap_or(0) > 0;
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
        let prefixes: Vec<String> = run.scope.iter().map(|p| p.trim_end_matches('/').to_owned()).collect();
        let cwd = run.cwd;
        let matches_path = |file: &str| {
            let path = match_file_key(file, cwd);
            prefixes.is_empty() || prefixes.iter().any(|p| p.is_empty() || p == "." || path == *p || path.starts_with(&format!("{p}/")))
        };
        let matches_row = |row: &Value| {
            let rule = row.get("ruleId").filter(|v| !v.is_null()).or_else(|| row.get("code")).and_then(Value::as_str).unwrap_or("");
            (rules.is_empty() || rules.iter().any(|r| r == rule)) && matches_path(row["file"].as_str().unwrap_or(""))
        };
        let mut structural = if args.get("structural") == Some(&Value::Bool(false)) { Value::Null } else { cached.structural.clone() };
        let filtered = !rules.is_empty() || !prefixes.is_empty();
        if filtered {
            results = results.map(|rs| {
                rs.into_iter()
                    .map(|mut r| {
                        r["diagnostics"] = json!(r["diagnostics"].as_array().into_iter().flatten().filter(|d| matches_row(d)).cloned().collect::<Vec<_>>());
                        r["filesChanged"] = json!(r["filesChanged"].as_array().into_iter().flatten().filter(|f| matches_path(f.as_str().unwrap_or(""))).cloned().collect::<Vec<_>>());
                        r
                    })
                    .collect()
            });
            if !structural.is_null() {
                structural["matches"] = json!(structural["matches"].as_array().into_iter().flatten().filter(|m| matches_row(m)).cloned().collect::<Vec<_>>());
            }
        }
        let mut notes = vec!["paged from the last check/fix; engines were not re-run".to_owned()];
        if filtered {
            notes.push("diagnosticsCount/matchesCount and byRule/byDir describe filtered rows; counts/filesChecked retain run totals".into());
        }
        Ok(build_tidy_report(ReportInput {
            action: "results".into(),
            engines: cached.engines.clone(),
            results,
            structural,
            scope: if cached.scope.is_empty() { Value::Null } else { json!(cached.scope) },
            languages: cached.languages.clone(),
            language_source: cached.language_source.clone(),
            notes,
            offset: parse_offset(args.get("offset")),
            limit: parse_limit(args.get("limit")),
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            ..Default::default()
        }))
    }

    async fn install(&self, run: &Run<'_>, args: &Value) -> Result<Value, ToolError> {
        if run.engine_filter.is_empty() {
            return Err(ToolError("install requires engines:[...]".into()));
        }
        let (resolution, manifest) = self.resolve(run, None, false).await;
        let fetcher = self.host.fetcher();
        let cancel = run.cancel.cloned().unwrap_or_default();
        let outcome = install_engines(&self.processes, &run.engine_filter, Some(&manifest), &self.host.plugin_data(), &resolution.policy.downloads, args.get("approveDownloads") == Some(&Value::Bool(true)), fetcher.as_ref(), &cancel, None, None).await;
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

    async fn rules(&self, run: &Run<'_>) -> Value {
        let (packs, _) = load_rule_packs();
        // Listing the packs still works without the engine; the report says so explicitly
        // (ok:false + the remedy) instead of showing a usable adapter.
        let bin = self.host.graph_binary();
        let adapter = resolve_structural_adapter(&self.processes, run.cwd, bin.as_deref(), None, run.cancel).await;
        let (adapter_id, unavailable) = match &adapter {
            Ok(_) => (GraphStructuralAdapter::ID, String::new()),
            Err(e) => ("none", e.to_string()),
        };
        build_tidy_report(ReportInput {
            action: "rules".into(),
            ok: unavailable.is_empty(),
            rules: json!({"adapter": adapter_id, "packs": packs.iter().map(|p| json!({"id": p.id, "languages": p.languages, "rules": p.rules})).collect::<Vec<_>>()}),
            errors: if unavailable.is_empty() { Vec::new() } else { vec![json!(unavailable)] },
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::apply::tests::Recording;
    use super::super::process::which;
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
        fn graph_binary(&self) -> Option<PathBuf> {
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
        if which("git", None, None).is_some() {
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

    #[tokio::test]
    async fn results_pages_the_cached_run_and_filters_before_paging() {
        let (data, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let t = tool(data.path());
        let diag = |file: &str, code: &str| json!({"file": file, "line": 1, "col": 1, "code": code, "message": "m", "severity": "warning", "fixable": false});
        t.remember(cwd.path(), Some("s"), CachedRun {
            languages: vec![],
            language_source: "git".into(),
            engines: vec![],
            results: Some(vec![json!({"id": "biome", "filesChecked": 3, "diagnostics": [diag("src/a.ts", "r1"), diag("src/b.ts", "r2"), diag("lib/c.ts", "r1")], "filesChanged": ["src/a.ts"]})]),
            structural: Value::Null,
            scope: vec![],
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
