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

fn put(r: &mut Value, k: &str, v: Value) {
    r[k] = v;
}

/// What `files` hold now, by path; an unreadable file is absent. One lane job. `Err` when the job
/// never ran: an empty map there would read as "every file is gone" and make an engine's in-place
/// rewrite look like no change, or go unrecorded.
async fn read_files(lane: DurabilityIo, paths: Vec<PathBuf>) -> Result<HashMap<PathBuf, Vec<u8>>, String> {
    on_lane(lane, move || read_files_blocking(paths)).await.map_err(|_| UNREAD.to_owned())
}

const UNREAD: &str = "the files could not be read: their lane did not run the read";

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_files_blocking(paths: Vec<PathBuf>) -> HashMap<PathBuf, Vec<u8>> {
    paths.into_iter().filter_map(|p| std::fs::read(&p).ok().map(|b| (p, b))).collect()
}

/// SHA-256 of each file in `files` by name; an unreadable file digests as empty.
async fn digests(lane: DurabilityIo, cwd: &Path, files: &[String]) -> Result<HashMap<String, String>, String> {
    let paths: Vec<PathBuf> = files.iter().map(|f| full_path_for(cwd, f)).collect();
    let mut read = read_files(lane, paths.clone()).await?;
    Ok(files.iter().zip(paths).map(|(f, p)| (f.clone(), read.remove(&p).map(|b| Sha256::digest(&b).iter().map(|x| format!("{x:02x}")).collect()).unwrap_or_default())).collect())
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

/// What the per-engine wrapper reports for a runner that threw (`run-engines.mjs:134-142`): the engine's id and
/// source (not its version), nothing checked, and the error's message.
fn thrown(engine: &Resolved, error: &str) -> Value {
    json!({"id": engine.id, "source": engine.source, "filesChecked": 0, "filesChanged": [], "diagnostics": [], "error": error})
}

/// The `error` of a run whose engine worked and left files unprocessed: how many, and the first.
fn unprocessed_error(id: &str, unprocessed: &[(String, String)]) -> Option<String> {
    let (file, reason) = unprocessed.first()?;
    let rest = if unprocessed.len() > 1 { format!(" (and {} more, see unprocessed)", unprocessed.len() - 1) } else { String::new() };
    Some(format!("{id} could not process {} file(s): {file}: {reason}{rest}", unprocessed.len()))
}

fn unprocessed_json(unprocessed: &[(String, String)]) -> Value {
    unprocessed.iter().map(|(file, reason)| json!({"file": file, "reason": reason})).collect()
}

/// One engine's part of a run, and whether the engine itself could not run: an apply pass ends
/// there, since what that engine left on disk is not known. Files an engine could not process
/// do not end it: the engine worked, and said which files it did not touch.
struct Ran {
    result: Value,
    stopped: bool,
}

async fn run_one(engine: &Resolved, o: &SuiteOptions) -> Ran {
    let mut base = json!({"id": engine.id, "source": engine.source});
    if !engine.version.is_empty() {
        base["version"] = json!(engine.version);
    }
    let with = |extra: Value| {
        let mut b = base.clone();
        b.as_object_mut().expect("object").extend(extra.as_object().cloned().unwrap_or_default());
        b
    };
    let done = |result: Value| Ran { result, stopped: false };
    let halted = |result: Value| Ran { result, stopped: true };
    let Some(runner) = runner_for(&engine.id) else {
        return done(with(json!({"filesChecked": 0, "filesChanged": [], "diagnostics": [], "skipped": "no runner for this engine in this build"})));
    };
    let scope = files_for_languages(&o.files, &engine.languages, o.extensions.as_ref());
    if scope.is_empty() {
        return done(with(json!({"filesChecked": 0, "filesChanged": [], "diagnostics": []})));
    }
    let check = runner.check(&request(engine, scope.clone(), o)).await;
    if check.thrown {
        return halted(thrown(engine, check.error.as_deref().unwrap_or_default()));
    }
    let checked = check.files_checked.unwrap_or(if check.error.is_some() { 0 } else { scope.len() });
    let mut result = with(json!({
        "filesChecked": checked, "filesChanged": check.changed_files,
        "diagnostics": check.diagnostics.iter().map(|d| d.to_json()).collect::<Vec<_>>(),
    }));
    if !check.ignored.is_empty() {
        put(&mut result, "ignored", json!(check.ignored));
    }
    if !check.unprocessed.is_empty() {
        put(&mut result, "unprocessed", unprocessed_json(&check.unprocessed));
    }
    if !check.stderr_tail.is_empty() {
        put(&mut result, "stderrTail", json!(check.stderr_tail));
    }
    if let Some(e) = check.error.clone().or_else(|| unprocessed_error(&engine.id, &check.unprocessed)) {
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
    let unusable = check.error.is_some() || check.truncated;
    if o.mode != "fix" || !o.apply || unusable {
        if o.mode == "fix" {
            put(&mut result, "dryRun", json!(true));
        }
        return Ran { result, stopped: unusable };
    }
    // Only a file this engine was given is a file it may write: a path it names beyond those (a
    // file it followed an include into, a path printed in another form) was not asked for.
    let (candidates, unrequested): (Vec<String>, Vec<String>) = fix_candidates(&check).into_iter().filter(|f| guard_tidy_write_path(&full_path_for(&o.cwd, f)).is_none()).partition(|f| scope.contains(f));
    if let Some(first) = unrequested.first() {
        let left_out = format!("{} file(s) the engine named were not among those requested and were not written, the first being {first}", unrequested.len());
        put(&mut result, "note", json!(check.note.iter().cloned().chain([left_out]).collect::<Vec<_>>().join("; ")));
    }
    if candidates.is_empty() {
        put(&mut result, "applied", json!(true));
        put(&mut result, "filesChanged", json!([]));
        return done(result);
    }
    // Both reads come BEFORE the engine rewrites anything: if either never ran, nothing is written.
    let unwritten = |result: &mut Value, why: String| {
        put(result, "error", json!(why));
        put(result, "applied", json!(false));
    };
    let before = match digests(o.lane, &o.cwd, &candidates).await {
        Ok(before) => before,
        Err(why) => {
            unwritten(&mut result, why);
            return halted(result);
        }
    };
    // The turn review needs each file's bytes before the engine rewrites it in place.
    let baselines: Option<HashMap<PathBuf, Vec<u8>>> = match &o.session_id {
        Some(_) => match read_files(o.lane, candidates.iter().map(|f| full_path_for(&o.cwd, f)).collect()).await {
            Ok(baselines) => Some(baselines),
            Err(why) => {
                unwritten(&mut result, why);
                return halted(result);
            }
        },
        None => None,
    };
    let fixed = runner.fix(&request(engine, candidates.clone(), o)).await;
    let after = match digests(o.lane, &o.cwd, &candidates).await {
        Ok(after) => after,
        Err(why) => {
            // The engine has run: say so, and that what it changed is not known.
            put(&mut result, "error", json!(format!("{why}; the engine ran, so these files may have been rewritten")));
            put(&mut result, "applied", json!(false));
            return halted(result);
        }
    };
    let changed: Vec<String> = candidates.iter().filter(|f| after[*f] != before[*f]).cloned().collect();
    // The engine wrote in place: run the invalidation a pipeline write would have run.
    let changed_paths: Vec<_> = changed.iter().map(|f| full_path_for(&o.cwd, f)).collect();
    if let Some(host) = &o.host {
        host.note_written(&changed_paths, o.session_id.as_deref()).await;
        if let (Some(session), Some(baselines)) = (o.session_id.as_deref(), baselines) {
            match read_files(o.lane, changed_paths.clone()).await {
                Ok(mut written) => {
                    let changes: Vec<FileChange> = changed_paths.iter().filter_map(|p| Some(FileChange { full_path: p.clone(), before: baselines.get(p)?.clone(), after: written.remove(p)? })).collect();
                    if !changes.is_empty() {
                        host.record_changes(&o.cwd, session, changes).await;
                    }
                }
                // The files were rewritten and the turn review cannot be told what they became.
                Err(why) => put(&mut result, "error", json!(format!("{why}; the changes were written but not recorded for the turn review"))),
            }
        }
    }
    put(&mut result, "filesChanged", json!(changed));
    let stopped = fixed.error.is_some() || fixed.truncated;
    // A file the check could not process and one the fix could not are both unprocessed files of this run.
    let unprocessed: Vec<(String, String)> = check.unprocessed.iter().chain(&fixed.unprocessed).cloned().collect();
    if !unprocessed.is_empty() {
        put(&mut result, "unprocessed", unprocessed_json(&unprocessed));
    }
    if let Some(e) = fixed.error.clone().or_else(|| unprocessed_error(&engine.id, &unprocessed)) {
        put(&mut result, "error", json!(e));
    }
    if fixed.truncated {
        put(&mut result, "truncated", json!(true));
    }
    put(&mut result, "applied", json!(!stopped && fixed.unprocessed.is_empty()));
    if !fixed.stderr_tail.is_empty() {
        put(&mut result, "stderrTail", json!(fixed.stderr_tail));
    }
    if !fixed.diagnostics.is_empty() {
        put(&mut result, "diagnostics", json!(fixed.diagnostics.iter().map(|d| d.to_json()).collect::<Vec<_>>()));
    }
    Ran { result, stopped }
}

/// What a suite ran: one result per engine reached, and, per result, whether that engine could
/// not run or its output was truncated. In apply mode a `true` there is the last result: the pass
/// ended at it.
pub struct SuiteRun {
    pub results: Vec<Value>,
    pub failed: Vec<bool>,
}

impl SuiteRun {
    /// Whether an apply pass ended before running every engine it was given.
    pub fn stopped(&self) -> bool {
        self.failed.last() == Some(&true)
    }
}

/// Runs every runnable engine over `files`. Checks run three at a time; apply mode runs one engine
/// after another and stops at the first engine that could not run or whose output was truncated.
pub async fn run_engine_suite(engines: &[&Resolved], options: &SuiteOptions) -> SuiteRun {
    let ran: Vec<Ran> = if options.apply {
        let mut ran = Vec::new();
        for engine in engines {
            let one = run_one(engine, options).await;
            let stopped = one.stopped;
            ran.push(one);
            if stopped {
                break;
            }
        }
        ran
    } else {
        let owned: Vec<Resolved> = engines.iter().map(|e| (*e).clone()).collect();
        map_limit(owned, CHECK_CONCURRENCY, |engine| async move { run_one(&engine, options).await }).await
    };
    let (results, failed) = ran.into_iter().map(|r| (r.result, r.stopped)).unzip();
    SuiteRun { results, failed }
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
        let check = run_engine_suite(&[&engine], &o).await.results;
        assert_eq!((check[0]["filesChecked"].clone(), check[0]["filesChanged"].clone(), check[0]["version"].clone()), (json!(1), json!(["a.sh"]), json!("3.0")));
        assert_eq!(std::fs::read_to_string(dir.path().join("a.sh")).unwrap(), "messy");
        o.mode = "fix".into();
        let dry = run_engine_suite(&[&engine], &o).await.results;
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
        let out = run_engine_suite(&[&engine], &o).await.results;
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
        let swift = Resolved { id: "swift-format".into(), languages: vec!["swift".into()], ..Default::default() };
        let other = Resolved { languages: vec!["python".into()], ..shfmt() };
        let out = run_engine_suite(&[&swift, &other], &o).await.results;
        assert_eq!(out[0]["skipped"], "no runner for this engine in this build");
        assert_eq!((out[1]["filesChecked"].clone(), out[1].get("skipped").is_none()), (json!(0), true));
        assert!(spawn.calls.lock().unwrap().is_empty());
    }

    /// A shfmt that lists `a.sh` and a file nobody asked about, cannot parse `bad.sh`, and writes what `-w` names.
    struct Picky(std::path::PathBuf);

    #[async_trait]
    impl Spawn for Picky {
        async fn run(&self, _: &str, args: &[String], _: &Path, _: Duration, _: Option<&CancellationToken>, _: Option<&HashMap<String, String>>, _: Option<Vec<u8>>) -> ProcessResult {
            let files: Vec<&String> = args.iter().filter(|a| a.ends_with(".sh")).collect();
            if args.iter().any(|a| a == "-w") {
                files.iter().for_each(|f| std::fs::write(self.0.join(f), "formatted\n").unwrap());
                return ProcessResult::default();
            }
            let listed = if files.iter().any(|f| *f == "a.sh") { "a.sh\nelsewhere.sh\n" } else { "" };
            let stderr = if files.iter().any(|f| *f == "bad.sh") { "bad.sh:2:10: `then` must be followed by a statement list" } else { "" };
            ProcessResult { code: 1, stdout: listed.into(), stderr: stderr.into(), ..Default::default() }
        }
    }

    #[tokio::test]
    async fn apply_fixes_the_requested_files_an_engine_could_process_and_writes_no_other() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.sh", "bad.sh", "elsewhere.sh"] {
            std::fs::write(dir.path().join(name), "messy").unwrap();
        }
        let mut o = SuiteOptions::new(dir.path(), vec!["a.sh".into(), "bad.sh".into()], &Processes::for_tests());
        (o.spawn, o.mode, o.apply) = (Arc::new(Picky(dir.path().to_owned())), "fix".into(), true);
        let ran = run_one(&shfmt(), &o).await;
        let text = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
        assert_eq!((text("a.sh"), text("bad.sh"), text("elsewhere.sh")), ("formatted\n".to_owned(), "messy".to_owned(), "messy".to_owned()));
        let r = &ran.result;
        assert_eq!((r["filesChecked"].clone(), r["filesChanged"].clone(), r["applied"].clone()), (json!(1), json!(["a.sh"]), json!(true)));
        assert_eq!(r["unprocessed"][0]["file"], "bad.sh");
        assert!(r["error"].as_str().unwrap().starts_with("shfmt could not process 1 file(s): bad.sh: "), "{}", r["error"]);
        assert!(r["note"].as_str().unwrap().contains("elsewhere.sh"), "{}", r["note"]);
        assert!(!ran.stopped, "an engine that worked does not end the apply pass over the files it could not process");
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




    /// A read that never ran is an error: an empty map would make a rewritten file look unchanged.
    #[tokio::test]
    async fn a_file_read_that_never_ran_is_an_error_not_an_empty_digest() {
        let (dir, _spawn) = setup();
        let lane = Processes::for_tests().durability();
        assert!(digests(lane, dir.path(), &["a.sh".into()]).await.is_ok());
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        assert!(digests(lane, dir.path(), &["a.sh".into()]).await.unwrap_err().contains("did not run the read"));
        assert!(read_files(lane, vec![dir.path().join("a.sh")]).await.is_err());
    }


}
