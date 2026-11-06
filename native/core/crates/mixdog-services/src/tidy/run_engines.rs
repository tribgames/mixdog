//! Engine execution. Each engine sees only the files of its languages inside the requested
//! scope, runs with a timeout, and runs concurrently with the others, except in apply mode,
//! where engines run one at a time so two formatters can never write the same file at once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::lane::on_lane;

use super::apply::{FileChange, WriteHost, full_path_for, guard_tidy_write_path};
use super::languages::files_for_languages;
use super::process::{Processes, map_limit};
use super::resolve::Resolved;
use super::runners::shared::{DEFAULT_ENGINE_TIMEOUT, RunRequest, RunnerResult, Spawn, SystemSpawn};
use super::runners::runner_for;

const CHECK_CONCURRENCY: usize = 3;

/// What `files` hold now, by path; an unreadable file is absent. One lane job.
async fn read_files(lane: DurabilityIo, paths: Vec<PathBuf>) -> HashMap<PathBuf, Vec<u8>> {
    on_lane(lane, move || read_files_blocking(paths)).await.unwrap_or_default()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_files_blocking(paths: Vec<PathBuf>) -> HashMap<PathBuf, Vec<u8>> {
    paths.into_iter().filter_map(|p| std::fs::read(&p).ok().map(|b| (p, b))).collect()
}

/// SHA-256 of each file in `files` by name; an unreadable file digests as empty.
async fn digests(lane: DurabilityIo, cwd: &Path, files: &[String]) -> HashMap<String, String> {
    let paths: Vec<PathBuf> = files.iter().map(|f| full_path_for(cwd, f)).collect();
    let mut read = read_files(lane, paths.clone()).await;
    files.iter().zip(paths).map(|(f, p)| (f.clone(), read.remove(&p).map(|b| Sha256::digest(&b).iter().map(|x| format!("{x:02x}")).collect()).unwrap_or_default())).collect()
}

/// Files an engine's check pass says it would rewrite, plus fixable findings.
pub fn fix_candidates(check: &RunnerResult) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    check
        .changed_files
        .iter()
        .cloned()
        .chain(check.diagnostics.iter().filter(|d| d.fixable && !d.file.is_empty()).map(|d| d.file.clone()))
        .filter(|f| seen.insert(f.clone()))
        .collect()
}

pub struct SuiteOptions {
    pub files: Vec<String>,
    pub cwd: std::path::PathBuf,
    /// `check` or `fix`; a fix without `apply` is a dry run (check only).
    pub mode: String,
    pub apply: bool,
    pub timeout: Duration,
    pub cancel: Option<CancellationToken>,
    pub session_id: Option<String>,
    /// The capability table detection classified the files with.
    pub extensions: Option<HashMap<String, String>>,
    pub host: Option<Arc<dyn WriteHost>>,
    pub spawn: Arc<dyn Spawn>,
    /// The lane the files an engine rewrites are read on.
    pub lane: DurabilityIo,
}

impl SuiteOptions {
    pub fn new(cwd: &Path, files: Vec<String>, processes: &Processes) -> Self {
        Self { files, cwd: cwd.to_owned(), mode: "check".into(), apply: false, timeout: DEFAULT_ENGINE_TIMEOUT, cancel: None, session_id: None, extensions: None, host: None, spawn: Arc::new(SystemSpawn(processes.clone())), lane: processes.durability() }
    }
}

fn request(engine: &Resolved, files: Vec<String>, o: &SuiteOptions) -> RunRequest {
    let mut req = RunRequest::new(&o.cwd, &engine.command, files, o.spawn.clone(), o.lane);
    req.args = engine.args.clone();
    req.timeout = o.timeout;
    req.cancel = o.cancel.clone();
    req.module_path = engine.module_path.clone();
    req
}

async fn run_one(engine: &Resolved, o: &SuiteOptions) -> Value {
    let mut base = json!({"id": engine.id, "source": engine.source});
    if !engine.version.is_empty() {
        base["version"] = json!(engine.version);
    }
    let with = |extra: Value| {
        let mut b = base.clone();
        b.as_object_mut().expect("object").extend(extra.as_object().cloned().unwrap_or_default());
        b
    };
    let Some(runner) = runner_for(&engine.id) else {
        return with(json!({"filesChecked": 0, "filesChanged": [], "diagnostics": [], "skipped": "no runner for this engine in this build"}));
    };
    let scope = files_for_languages(&o.files, &engine.languages, o.extensions.as_ref());
    if scope.is_empty() {
        return with(json!({"filesChecked": 0, "filesChanged": [], "diagnostics": []}));
    }
    let check = runner.check(&request(engine, scope.clone(), o)).await;
    let mut result = with(json!({
        "filesChecked": scope.len(), "filesChanged": check.changed_files,
        "diagnostics": check.diagnostics.iter().map(|d| d.to_json()).collect::<Vec<_>>(),
    }));
    let put = |r: &mut Value, k: &str, v: Value| r[k] = v;
    if !check.stderr_tail.is_empty() {
        put(&mut result, "stderrTail", json!(check.stderr_tail));
    }
    if let Some(e) = &check.error {
        put(&mut result, "error", json!(e));
    }
    if check.truncated {
        put(&mut result, "truncated", json!(true));
    }
    if let Some(c) = &check.counts {
        put(&mut result, "counts", c.clone());
    }
    if let Some(n) = &check.note {
        put(&mut result, "note", json!(n));
    }
    if o.mode != "fix" || !o.apply || check.error.is_some() || check.truncated {
        if o.mode == "fix" {
            put(&mut result, "dryRun", json!(true));
        }
        return result;
    }
    let candidates: Vec<String> = fix_candidates(&check).into_iter().filter(|f| guard_tidy_write_path(&full_path_for(&o.cwd, f)).is_none()).collect();
    if candidates.is_empty() {
        put(&mut result, "applied", json!(true));
        put(&mut result, "filesChanged", json!([]));
        return result;
    }
    let before = digests(o.lane, &o.cwd, &candidates).await;
    // The turn review needs each file's bytes before the engine rewrites it in place.
    let baselines: Option<HashMap<PathBuf, Vec<u8>>> = match &o.session_id {
        Some(_) => Some(read_files(o.lane, candidates.iter().map(|f| full_path_for(&o.cwd, f)).collect()).await),
        None => None,
    };
    let fixed = runner.fix(&request(engine, candidates.clone(), o)).await;
    let after = digests(o.lane, &o.cwd, &candidates).await;
    let changed: Vec<String> = candidates.iter().filter(|f| after[*f] != before[*f]).cloned().collect();
    // The engine wrote in place: run the invalidation a pipeline write would have run.
    let changed_paths: Vec<_> = changed.iter().map(|f| full_path_for(&o.cwd, f)).collect();
    if let Some(host) = &o.host {
        host.note_written(&changed_paths, o.session_id.as_deref()).await;
        if let (Some(session), Some(baselines)) = (o.session_id.as_deref(), baselines) {
            let mut written = read_files(o.lane, changed_paths.clone()).await;
            let changes: Vec<FileChange> = changed_paths.iter().filter_map(|p| Some(FileChange { full_path: p.clone(), before: baselines.get(p)?.clone(), after: written.remove(p)? })).collect();
            if !changes.is_empty() {
                host.record_changes(&o.cwd, session, changes).await;
            }
        }
    }
    put(&mut result, "filesChanged", json!(changed));
    let failed = fixed.error.is_some() || fixed.truncated;
    if let Some(e) = &fixed.error {
        put(&mut result, "error", json!(e));
    }
    if fixed.truncated {
        put(&mut result, "truncated", json!(true));
    }
    put(&mut result, "applied", json!(!failed));
    if !fixed.stderr_tail.is_empty() {
        put(&mut result, "stderrTail", json!(fixed.stderr_tail));
    }
    if !fixed.diagnostics.is_empty() {
        put(&mut result, "diagnostics", json!(fixed.diagnostics.iter().map(|d| d.to_json()).collect::<Vec<_>>()));
    }
    result
}

/// Runs every runnable engine over `files`. Checks run three at a time; apply mode runs one engine
/// after another and stops at the first engine that errored or was truncated.
pub async fn run_engine_suite(engines: &[&Resolved], options: &SuiteOptions) -> Vec<Value> {
    if !options.apply {
        let owned: Vec<Resolved> = engines.iter().map(|e| (*e).clone()).collect();
        return map_limit(owned, CHECK_CONCURRENCY, |engine| async move { run_one(&engine, options).await }).await;
    }
    let mut results = Vec::new();
    for engine in engines {
        let result = run_one(engine, options).await;
        let stop = result.get("error").is_some_and(|e| !e.is_null()) || result["truncated"] == true;
        results.push(result);
        if stop {
            break;
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::super::apply::tests::Recording;
    use super::super::process::ProcessResult;
    use super::*;

    /// A fake engine: `-l` lists a.sh as unformatted, `-w` rewrites it.
    struct FakeShfmt {
        dir: std::path::PathBuf,
        calls: Mutex<Vec<Vec<String>>>,
    }

    #[async_trait]
    impl Spawn for FakeShfmt {
        async fn run(&self, _: &str, args: &[String], _: &Path, _: Duration, _: Option<&CancellationToken>, _: Option<&HashMap<String, String>>, _: Option<Vec<u8>>) -> ProcessResult {
            self.calls.lock().unwrap().push(args.to_vec());
            if args.iter().any(|a| a == "-w") {
                std::fs::write(self.dir.join("a.sh"), "formatted\n").unwrap();
                return ProcessResult::default();
            }
            ProcessResult { stdout: "a.sh\n".into(), ..Default::default() }
        }
    }

    fn shfmt() -> Resolved {
        Resolved { id: "shfmt".into(), source: "path".into(), command: "shfmt".into(), languages: vec!["bash".into()], kind: vec!["format".into()], version: "3.0".into(), ..Default::default() }
    }

    fn setup() -> (tempfile::TempDir, Arc<FakeShfmt>) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.sh"), "messy").unwrap();
        let spawn = Arc::new(FakeShfmt { dir: dir.path().to_owned(), calls: Mutex::default() });
        (dir, spawn)
    }

    #[tokio::test]
    async fn check_reports_without_writing_and_a_fix_without_apply_is_a_dry_run() {
        let (dir, spawn) = setup();
        let mut o = SuiteOptions::new(dir.path(), vec!["a.sh".into(), "b.md".into()], &Processes::for_tests());
        o.spawn = spawn.clone();
        let engine = shfmt();
        let check = run_engine_suite(&[&engine], &o).await;
        assert_eq!((check[0]["filesChecked"].clone(), check[0]["filesChanged"].clone(), check[0]["version"].clone()), (json!(1), json!(["a.sh"]), json!("3.0")));
        assert_eq!(std::fs::read_to_string(dir.path().join("a.sh")).unwrap(), "messy");
        o.mode = "fix".into();
        let dry = run_engine_suite(&[&engine], &o).await;
        assert_eq!(dry[0]["dryRun"], true);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.sh")).unwrap(), "messy");
    }

    #[tokio::test]
    async fn apply_writes_through_the_engine_notes_the_change_and_records_before_and_after() {
        let (dir, spawn) = setup();
        let host = Arc::new(Recording::default());
        let mut o = SuiteOptions::new(dir.path(), vec!["a.sh".into()], &Processes::for_tests());
        (o.spawn, o.mode, o.apply, o.session_id) = (spawn.clone(), "fix".into(), true, Some("s1".into()));
        o.host = Some(host.clone());
        let engine = shfmt();
        let out = run_engine_suite(&[&engine], &o).await;
        assert_eq!((out[0]["filesChanged"].clone(), out[0]["applied"].clone()), (json!(["a.sh"]), json!(true)));
        assert_eq!(std::fs::read_to_string(dir.path().join("a.sh")).unwrap(), "formatted\n");
        assert_eq!(host.noted.lock().unwrap().len(), 1);
        let recorded = host.recorded.lock().unwrap();
        assert_eq!((recorded[0].before.clone(), recorded[0].after.clone()), (b"messy".to_vec(), b"formatted\n".to_vec()));
    }

    #[tokio::test]
    async fn engines_without_a_runner_or_in_scope_files_are_reported_not_run() {
        let (dir, spawn) = setup();
        let mut o = SuiteOptions::new(dir.path(), vec!["a.sh".into()], &Processes::for_tests());
        o.spawn = spawn.clone();
        let zig = Resolved { id: "zig".into(), languages: vec!["zig".into()], ..Default::default() };
        let other = Resolved { languages: vec!["python".into()], ..shfmt() };
        let out = run_engine_suite(&[&zig, &other], &o).await;
        assert_eq!(out[0]["skipped"], "no runner for this engine in this build");
        assert_eq!((out[1]["filesChecked"].clone(), out[1].get("skipped").is_none()), (json!(0), true));
        assert!(spawn.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn fix_candidates_are_changed_files_plus_fixable_findings_without_duplicates() {
        use super::super::runners::shared::{DiagnosticInit, diagnostic};
        let fixable = diagnostic(DiagnosticInit { file: "b.ts", fixable: true, ..Default::default() });
        let manual = diagnostic(DiagnosticInit { file: "c.ts", ..Default::default() });
        let again = diagnostic(DiagnosticInit { file: "a.ts", fixable: true, ..Default::default() });
        let result = RunnerResult { changed_files: vec!["a.ts".into()], diagnostics: vec![fixable, manual, again], ..Default::default() };
        assert_eq!(fix_candidates(&result), ["a.ts", "b.ts"]);
    }
}
