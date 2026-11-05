//! `git` (T §3.8): Git run without a shell, a port of the Node tool (`git-command-tool.mjs`).
//! Commands are argv vectors parsed in [`argv`]; reads take no lock and writes hold the
//! repository's write lock from `mixdog-scm`; a stageable `git diff` can be staged by id
//! ([`stage`]); worktrees are managed only ([`worktree`]). Every answer is text, exactly as the
//! Node tool returns it: failures are `error: …` strings, not tool errors.

mod argv;
pub mod path_locks;
mod run;
mod stage;
#[cfg(test)]
mod tests;
mod worktree;

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_scm::exec::Exec;
use mixdog_scm::locks::RepoGuard;
use mixdog_scm::locks::RepoLocks;
use serde_json::Map;
use serde_json::json;

pub use self::argv::git_call_mutates;
use self::argv::Plan;
use self::argv::localize_config_plan;
use self::argv::parse_command;
use self::argv::parse_stringified_array;
use self::argv::resolve;
use self::argv::split_chained_git_commands;
use self::argv::with_git_prefix;
use self::run::ARRAY_CHAR_BUDGET;
use self::run::COMMAND_CHAR_BUDGET;
use self::run::Cap;
use self::run::GitRun;
use self::run::LOG_LINES_DEFAULT;
use self::run::MIN_COMMAND_CHARS;
use self::run::OUTPUT_LIMIT_MAX;
use self::run::OUTPUT_LINES_DEFAULT;
use self::run::Rendered;
use self::run::Runner;
use self::run::append_text;
use self::run::command_result;
use self::run::fail;
use self::run::lock_wait_note;
use self::run::u16len;
use self::stage::SnapshotPlan;
use self::worktree::Env;
use self::worktree::WORKTREE_INPUT_FIELDS;
pub use self::worktree::SessionOp;
pub use self::worktree::SessionWorktrees;
pub use self::worktree::WorktreeServices;

use crate::code_graph::spec_from;
use crate::code_graph::text_output;

type Object = Map<String, JsonValue>;

const SPEC: &str = include_str!("specs/git.json");
const COMMAND_ARRAY_LIMIT: usize = 10;
const REPO_FREE_OPERATIONS: [&str; 2] = ["version", "help"];
const REPO_WIDE_OPERATIONS: [&str; 5] = ["gc", "maintenance", "prune", "prune-packed", "repack"];
const NOT_UTF8_STAGE_NOTE: &str = "staging ids unavailable: this diff has bytes that are not UTF-8 (a file in another encoding), and staging its text would replace them; stage those files whole with git add -- <paths>";
const CREATION_VALUE_FLAGS: [&str; 23] = [
    "-b", "--branch", "-c", "--config", "--depth", "-j", "--jobs", "-o", "--origin", "--reference",
    "--reference-if-able", "--separate-git-dir", "--template", "-u", "--upload-pack", "--filter",
    "--server-option", "--shallow-since", "--shallow-exclude", "--bundle-uri", "--revision", "--ref-format",
    "--object-format",
];

pub struct GitTool {
    spec: ToolSpec,
    locks: Arc<RepoLocks>,
    worktrees: Option<Arc<WorktreeServices>>,
}

impl GitTool {
    /// Without worktree services only `list` works and every other worktree operation is
    /// refused as "not the Lead".
    pub fn new() -> Self {
        Self::with_locks(RepoLocks::new())
    }

    /// A tool sharing the engine's per-repository write locks, so a pane's write and the
    /// tool's wait for each other.
    pub fn with_locks(locks: Arc<RepoLocks>) -> Self {
        Self { spec: spec_from(SPEC, false), locks, worktrees: None }
    }

    /// The managed-worktree services: `mixdog-scm`'s manager and the session transitions.
    #[must_use]
    pub fn with_worktrees(mut self, services: Arc<WorktreeServices>) -> Self {
        self.worktrees = Some(services);
        self
    }
}

impl Default for GitTool {
    fn default() -> Self {
        Self::new()
    }
}

fn ok(data: Object) -> String {
    let mut out = Object::new();
    out.insert("ok".into(), json!(true));
    for (key, value) in data {
        out.insert(key, value);
    }
    JsonValue::Object(out).to_string()
}

fn rejected(message: &str) -> Rendered {
    Rendered { text: fail(message), failed: true }
}

/// `Number(value) || fallback`, clamped to 1..=1000.
fn output_limit(value: Option<&JsonValue>, fallback: usize) -> usize {
    let number = match value {
        Some(JsonValue::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(JsonValue::String(s)) => s.trim().parse().unwrap_or(0.0),
        Some(JsonValue::Bool(true)) => 1.0,
        _ => 0.0,
    };
    let number = if number.is_finite() && number != 0.0 { number } else { fallback as f64 };
    number.clamp(1.0, OUTPUT_LIMIT_MAX as f64) as usize
}

fn clean_text(value: &str) -> String {
    value.replace("\r\n", "\n").trim_end().to_owned()
}

fn prepare(plan: &Plan) -> Vec<String> {
    const SHORT: [&str; 6] = ["-s", "--short", "-b", "--branch", "-sb", "-bs"];
    if plan.operation == "status" && plan.args.iter().all(|a| SHORT.contains(&a.as_str())) {
        return vec!["status".into(), "--short".into(), "--branch".into()];
    }
    let mut argv = vec![plan.operation.clone()];
    if ["diff", "diff-files", "diff-index", "diff-tree"].contains(&plan.operation.as_str()) {
        argv.push("--no-ext-diff".into());
        argv.push("--no-color".into());
    }
    argv.extend(plan.args.iter().cloned());
    argv
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

struct RepoInfo {
    root: Option<PathBuf>,
    common_dir: Option<PathBuf>,
    probe: Option<GitRun>,
}

const REPO_ROOT_CACHE_MAX: usize = 64;

/// Repo-root resolution used to spawn an extra `git rev-parse` on every call. The answer is
/// cached per resolved cwd (oldest dropped first) and re-validated with a few stats: a cached
/// root stays correct only while it is still the NEAREST repository, so an init, clone or
/// worktree that appears closer to the cwd invalidates it. Explicit `--git-dir`/`--work-tree`
/// overrides re-point resolution and never read the cache.
static REPO_ROOTS: std::sync::Mutex<Vec<(String, PathBuf, PathBuf)>> = std::sync::Mutex::new(Vec::new());

#[allow(clippy::disallowed_methods, reason = "runs only as a maintenance-lane job body (Runner::blocking)")]
fn nearest_git_dir(start: &Path) -> Option<PathBuf> {
    start.ancestors().find(|dir| dir.join(".git").exists()).map(Path::to_path_buf)
}

async fn cached_repo_root(runner: &Runner<'_>, key: &str, cwd: &Path) -> Option<(PathBuf, PathBuf)> {
    let hit = REPO_ROOTS.lock().expect("repo roots").iter().find(|(k, ..)| k == key).cloned()?;
    let start = cwd.to_path_buf();
    let nearest = runner.blocking(move || nearest_git_dir(&start)).await.flatten();
    let mut cache = REPO_ROOTS.lock().expect("repo roots");
    cache.retain(|(k, ..)| k != key);
    let valid = nearest.is_some_and(|n| mixdog_scm::locks::path_key(&n) == mixdog_scm::locks::path_key(&hit.1));
    if !valid {
        return None;
    }
    cache.push((hit.0, hit.1.clone(), hit.2.clone()));
    Some((hit.1, hit.2))
}

fn remember_repo_root(key: &str, root: &Path, common: &Path) {
    let mut cache = REPO_ROOTS.lock().expect("repo roots");
    cache.retain(|(k, ..)| k != key);
    cache.push((key.to_owned(), root.to_path_buf(), common.to_path_buf()));
    while cache.len() > REPO_ROOT_CACHE_MAX {
        cache.remove(0);
    }
}

async fn resolve_repo(runner: &Runner<'_>, plan: &Plan) -> RepoInfo {
    let key = plan.global_args.is_empty().then(|| mixdog_scm::locks::path_key(&plan.cwd));
    if let Some(key) = &key
        && let Some((root, common)) = cached_repo_root(runner, key, &plan.cwd).await
    {
        return RepoInfo { root: Some(root), common_dir: Some(common), probe: None };
    }
    let info = probe_repo(runner, plan).await;
    if let (Some(key), Some(root), Some(common)) = (&key, &info.root, &info.common_dir) {
        remember_repo_root(key, root, common);
    }
    info
}

async fn probe_repo(runner: &Runner<'_>, plan: &Plan) -> RepoInfo {
    let result = runner
        .run(plan, &strings(&["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"]), false)
        .await;
    if result.succeeded() {
        let text = clean_text(&result.out());
        let mut lines = text.split('\n');
        let root = lines.next().unwrap_or("").to_owned();
        let common = lines.next().filter(|c| !c.is_empty()).unwrap_or(&root).to_owned();
        return RepoInfo { root: Some(PathBuf::from(root)), common_dir: Some(PathBuf::from(common)), probe: Some(result) };
    }
    // A bare repository has no work tree, so `--show-toplevel` refuses; it is still a repository.
    let must_be_in_work_tree = result.err().to_lowercase().contains("must be run in a work tree");
    if must_be_in_work_tree {
        let bare = runner.run(plan, &strings(&["rev-parse", "--absolute-git-dir"]), false).await;
        if !bare.succeeded() {
            return RepoInfo { root: None, common_dir: None, probe: Some(bare) };
        }
        let root = PathBuf::from(clean_text(&bare.out()));
        return RepoInfo { root: Some(root.clone()), common_dir: Some(root), probe: Some(bare) };
    }
    RepoInfo { root: None, common_dir: None, probe: Some(result) }
}

fn option_free_positionals(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = &args[index];
        if value == "--" {
            out.extend(args[index + 1..].iter().cloned());
            break;
        }
        if CREATION_VALUE_FLAGS.contains(&value.as_str()) {
            index += 2;
            continue;
        }
        if !value.starts_with('-') {
            out.push(value.clone());
        }
        index += 1;
    }
    out
}

fn creation_target(plan: &Plan) -> PathBuf {
    let positional = option_free_positionals(&plan.args);
    if plan.operation == "init" {
        return resolve(&plan.cwd, positional.last().map_or(".", String::as_str));
    }
    if plan.operation != "clone" {
        return plan.cwd.clone();
    }
    if positional.len() >= 2 {
        return resolve(&plan.cwd, positional.last().map_or(".", String::as_str));
    }
    let source = positional.first().map_or("", String::as_str).trim_end_matches(['/', '\\']);
    let tail = source.rsplit_once(':').map_or(source, |(_, t)| t);
    let leaf = Path::new(tail).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let leaf = leaf.strip_suffix(".git").or_else(|| leaf.strip_suffix(".GIT")).unwrap_or(&leaf).to_owned();
    resolve(&plan.cwd, if leaf.is_empty() { "repo" } else { &leaf })
}

/// The locks a write holds: the repository lock on the worktrees it touches, then the path
/// lock of the folder it changes (shared with edit/write of files there).
struct WriteGuard {
    _repo: RepoGuard,
    _paths: path_locks::PathLocks,
}

/// Takes the repository lock on `scopes` (`None` = the whole repository), then the path lock
/// of `path`; returns the guard and how long acquiring took.
async fn acquire(
    locks: &Arc<RepoLocks>,
    runner: &Runner<'_>,
    lock_key: &Path,
    scopes: Option<&[&Path]>,
    path: &Path,
) -> Result<(WriteGuard, u64), Rendered> {
    let started = Instant::now();
    let Ok(repo) = locks.acquire(lock_key, scopes, runner.cancel).await else {
        return Err(rejected("git command aborted"));
    };
    let Some(paths) = path_locks::lock_paths(&[path], runner.cancel).await else {
        return Err(rejected("git command aborted"));
    };
    Ok((WriteGuard { _repo: repo, _paths: paths }, started.elapsed().as_millis() as u64))
}

fn is_listed_plainly(path: &str) -> String {
    if path.chars().any(|c| (c as u32) < 0x20 || c == '"') {
        JsonValue::String(path.to_owned()).to_string()
    } else {
        path.to_owned()
    }
}

fn stageable_diff_result(plan: &Plan, run: &GitRun, snapshot: &stage::DiffSnapshot, cap: Cap) -> Rendered {
    let mut rendered = command_result(plan, run, cap);
    let Some(diff_id) = &snapshot.diff_id else { return rendered };
    // The hunk headers are already in the body; one line per file names the id range.
    struct FileRange {
        path: String,
        start: String,
        end: String,
        kind: Option<&'static str>,
    }
    let mut files: Vec<FileRange> = Vec::new();
    for change in &snapshot.changes {
        match files.last_mut() {
            Some(last) if last.path == change.path && change.kind.is_none() && last.kind.is_none() => {
                last.end = change.id.clone();
            }
            _ => files.push(FileRange {
                path: change.path.clone(),
                start: change.id.clone(),
                end: change.id.clone(),
                kind: change.kind,
            }),
        }
    }
    let mut lines = vec![format!(
        "diff_id: {diff_id} (ids number the +/- runs in diff order; [whole file] ids stage the entire file)"
    )];
    for f in files {
        let range = if f.start == f.end { f.start.clone() } else { format!("{}-{}", f.start, f.end) };
        lines.push(format!(
            "{}: {range}{}",
            is_listed_plainly(&f.path),
            if f.kind.is_some() { " [whole file]" } else { "" }
        ));
    }
    rendered.text = append_text(&rendered.text, &lines.join("\n"));
    rendered
}

/// Per-file staged counts; the paths and ranges the model already holds are not repeated.
fn staged_summary(changes: &[stage::Change]) -> Object {
    let mut files: Vec<(String, usize, usize, usize)> = Vec::new();
    for change in changes {
        match files.iter_mut().find(|f| f.0 == change.path) {
            Some(entry) => {
                entry.1 += 1;
                entry.2 += change.additions;
                entry.3 += change.deletions;
            }
            None => files.push((change.path.clone(), 1, change.additions, change.deletions)),
        }
    }
    let mut out = Object::new();
    out.insert("changes".into(), json!(changes.len()));
    out.insert("additions".into(), json!(files.iter().map(|f| f.2).sum::<usize>()));
    out.insert("deletions".into(), json!(files.iter().map(|f| f.3).sum::<usize>()));
    out.insert(
        "files".into(),
        JsonValue::Array(
            files
                .iter()
                .map(|(path, count, add, del)| {
                    json!(format!("{path}: {count} {} +{add} -{del}", if *count == 1 { "change" } else { "changes" }))
                })
                .collect(),
        ),
    );
    out
}

/// A stage applies the text of this diff, so a diff with bytes that are not UTF-8 is shown but
/// never staged by id. Untracked files are appended as new-file patches.
async fn run_stageable_diff(runner: &Runner<'_>, plan: &Plan, argv: &[String], repo: &Path) -> GitRun {
    let mut result = runner.run(plan, argv, true).await;
    if !result.succeeded() {
        return result;
    }
    result.not_utf8 = std::str::from_utf8(&result.stdout).is_err();
    result.stdout = result.out().into_bytes();
    result.stderr = result.err().into_bytes();
    let mut ls = strings(&["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--"]);
    ls.extend(plan.args.iter().skip(1).cloned());
    let untracked = runner.run(plan, &ls, true).await;
    if !untracked.succeeded() {
        return untracked;
    }
    for path in untracked.out().split('\0').filter(|p| !p.is_empty()) {
        let argv = strings(&[
            "diff", "--no-index", "--binary", "--no-ext-diff", "--no-textconv", "--no-color",
            "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", path,
        ]);
        let added = runner.run_in(repo, &plan.global_args, &argv, true).await;
        // --no-index uses exit 1 for a successfully produced patch.
        let produced = added.error.is_none() && (added.code == Some(0) || added.code == Some(1));
        if !produced {
            return added;
        }
        if std::str::from_utf8(&added.stdout).is_err() {
            result.not_utf8 = true;
        }
        result.stdout = append_text(&result.out(), &added.out()).into_bytes();
        result.stderr = append_text(&result.err(), &added.err()).into_bytes();
    }
    result
}

fn js_string(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Bool(true) => "true".to_owned(),
        _ => String::new(),
    }
}

fn run_dir_name() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "mixdog-git-stage-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

async fn execute_git_stage(locks: &Arc<RepoLocks>, runner: &Runner<'_>, input: &Object, work_dir: &Path) -> String {
    let diff_id = input.get("diff_id").and_then(JsonValue::as_str).map(str::trim).unwrap_or("").to_owned();
    let raw_ids: Vec<JsonValue> = match input.get("change_ids") {
        Some(JsonValue::Array(items)) => items.clone(),
        Some(other) => vec![other.clone()],
        None => vec![JsonValue::Null],
    };
    let mut change_ids: Vec<String> = Vec::new();
    for id in raw_ids.iter().map(|v| js_string(v).trim().to_owned()).filter(|v| !v.is_empty()) {
        if !change_ids.contains(&id) {
            change_ids.push(id);
        }
    }
    if diff_id.is_empty() {
        return fail("git stage requires diff_id from a prior git diff");
    }
    if change_ids.is_empty() {
        return fail("git stage requires at least one change_id");
    }
    if change_ids.len() > 50 {
        return fail("git stage accepts at most 50 change_ids");
    }
    let Some(snapshot) = stage::get_diff_snapshot(&diff_id) else {
        return ok(object(json!({
            "staged": false,
            "reason": "expired_diff",
            "hint": "Run git diff with include_stage_ids:true again and use its new diff_id/change_ids."
        })));
    };
    if snapshot.scope != work_dir {
        return ok(object(json!({
            "staged": false,
            "reason": "scope_mismatch",
            "hint": "Run git diff with include_stage_ids:true in the current Project and use its diff_id/change_ids."
        })));
    }
    let limit = Cap { lines: output_limit(input.get("output_limit"), OUTPUT_LINES_DEFAULT), chars: COMMAND_CHAR_BUDGET };
    let repo = snapshot.repo.clone();
    let base_plan = Plan {
        command: String::new(),
        cwd: snapshot.plan.cwd.clone(),
        global_args: snapshot.plan.global_args.clone(),
        operation: "diff".to_owned(),
        args: snapshot.plan.args.clone(),
    };
    let repo_plan = Plan { cwd: repo.clone(), ..base_plan.clone() };
    let info = resolve_repo(runner, &repo_plan).await;
    // The diff check and the index apply form one transaction on this worktree's index.
    let lock_key = info.common_dir.clone().unwrap_or_else(|| repo.clone());
    let (_guard, waited_ms) = match acquire(locks, runner, &lock_key, Some(&[repo.as_path()]), &repo).await {
        Ok(held) => held,
        Err(aborted) => return aborted.text,
    };
    let noted = |text: String, run: Option<&GitRun>| append_text(&text, &lock_wait_note(waited_ms, run));
    let answer = |mut data: Object, run: Option<&GitRun>| {
        let note = lock_wait_note(waited_ms, run);
        if !note.is_empty() {
            data.insert("note".into(), json!(note));
        }
        ok(data)
    };
    let current = run_stageable_diff(runner, &base_plan, &snapshot.argv, &repo).await;
    if !current.succeeded() {
        return noted(command_result(&base_plan, &current, limit).text, None);
    }
    if current.not_utf8 {
        return noted(fail(NOT_UTF8_STAGE_NOTE), None);
    }
    let raw = current.out();
    if !stage::diff_snapshot_matches(&snapshot, &raw) {
        return answer(
            object(json!({
                "staged": false,
                "reason": "stale_diff",
                "hint": "The working diff changed. Run git diff with include_stage_ids:true again and select current change_ids."
            })),
            None,
        );
    }
    let built = stage::build_selected_stage_patch(&raw, &change_ids);
    if !built.missing.is_empty() || built.patch.is_empty() {
        let listed = if built.missing.is_empty() { "(none selected)".to_owned() } else { built.missing.join(", ") };
        return noted(fail(&format!("git stage change_ids are not present in the diff: {listed}")), None);
    }
    let directory = std::env::temp_dir().join(run_dir_name());
    let patch_path = directory.join("selected.patch");
    let written = {
        let (directory, patch_path, patch) = (directory.clone(), patch_path.clone(), built.patch.clone());
        runner.blocking(move || write_patch_file(&directory, &patch_path, &patch)).await
    };
    if written != Some(true) {
        remove_run_dir(runner, &directory).await;
        return noted(fail("git stage could not write its patch file"), None);
    }
    let patch = patch_path.to_string_lossy().into_owned();
    let apply_plan = Plan {
        cwd: repo.clone(),
        operation: "apply".to_owned(),
        args: strings(&["--cached", "--unidiff-zero", &patch]),
        ..base_plan.clone()
    };
    let check = runner
        .run(&apply_plan, &strings(&["apply", "--cached", "--check", "--unidiff-zero", &patch]), false)
        .await;
    let text = if !check.succeeded() {
        noted(command_result(&apply_plan, &check, limit).text, None)
    } else {
        let applied = runner
            .run_write(&apply_plan, &strings(&["apply", "--cached", "--unidiff-zero", &patch]))
            .await;
        if !applied.succeeded() {
            noted(command_result(&apply_plan, &applied, limit).text, Some(&applied))
        } else {
            stage::delete_diff_snapshot(&diff_id);
            let mut data = object(json!({"staged": true}));
            data.extend(staged_summary(&built.changes));
            answer(data, Some(&applied))
        }
    };
    remove_run_dir(runner, &directory).await;
    text
}

#[allow(clippy::disallowed_methods, reason = "runs only as a maintenance-lane job body (Runner::blocking)")]
fn write_patch_file(directory: &Path, patch_path: &Path, patch: &str) -> bool {
    std::fs::create_dir_all(directory).and_then(|()| std::fs::write(patch_path, patch)).is_ok()
}

#[allow(clippy::disallowed_methods, reason = "runs only as a maintenance-lane job body (Runner::blocking)")]
fn folder_exists(path: &Path) -> bool {
    path.exists()
}

#[allow(clippy::disallowed_methods, reason = "runs only as a maintenance-lane job body (Runner::blocking)")]
fn remove_dir(path: &Path) {
    let _ = std::fs::remove_dir_all(path);
}

async fn remove_run_dir(runner: &Runner<'_>, directory: &Path) {
    let directory = directory.to_path_buf();
    runner.blocking_cleanup(move || remove_dir(&directory)).await;
}

fn object(value: JsonValue) -> Object {
    match value {
        JsonValue::Object(map) => map,
        _ => Object::new(),
    }
}

struct CallEnv<'a> {
    locks: &'a Arc<RepoLocks>,
    runner: &'a Runner<'a>,
    session_id: String,
    tool_call_id: String,
    work_dir: PathBuf,
    services: Option<&'a Arc<WorktreeServices>>,
}

impl CallEnv<'_> {
    /// `input` carries the user's `confirm_large` answer, which a mapped `git worktree add`
    /// forwards exactly as `action:"worktree"` does.
    fn worktree_env(&self, input: &Object) -> Env<'_> {
        Env {
            runner: self.runner,
            session_id: self.session_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            services: self.services,
            confirm_large: input.get("confirm_large") == Some(&JsonValue::Bool(true)),
        }
    }
}

async fn execute_single(call: &CallEnv<'_>, input: &Object, char_budget: Option<usize>) -> Rendered {
    let command = input.get("command").and_then(JsonValue::as_str).filter(|c| !c.trim().is_empty());
    let Some(command) = command else {
        return rejected(if input.get("include_stage_ids") == Some(&json!(true)) {
            "git requires command; staging IDs come from command:\"git diff\" (or \"git diff -- <paths>\") with include_stage_ids:true"
        } else {
            "git requires command: a full command starting with git, e.g. command:\"git status\""
        });
    };
    let plan = match parse_command(command, &call.work_dir).and_then(localize_config_plan) {
        Ok(plan) => plan,
        Err(message) => return rejected(&message),
    };
    // No unmanaged worktree is ever made here: worktree commands run as their managed
    // operations; only `list --porcelain` stays git.
    if plan.operation == "worktree"
        && let Some(mapped) = worktree::execute_raw_worktree(&plan, &call.worktree_env(input)).await
    {
        return Rendered { text: mapped.text, failed: mapped.failed };
    }
    if plan.operation == "archive"
        && !plan.args.iter().any(|v| v == "-o" || v == "--output" || v.starts_with("--output="))
    {
        return rejected("git archive requires -o/--output; binary stdout is not returned");
    }
    let default_lines = if plan.operation == "log" { LOG_LINES_DEFAULT } else { OUTPUT_LINES_DEFAULT };
    let cap = Cap {
        lines: output_limit(input.get("output_limit"), default_lines),
        chars: char_budget.unwrap_or(COMMAND_CHAR_BUDGET),
    };
    let runner = call.runner;
    if plan.operation == "init" || plan.operation == "clone" {
        let target = creation_target(&plan);
        let (_guard, waited) = match acquire(call.locks, runner, &target, None, &target).await {
            Ok(held) => held,
            Err(aborted) => return aborted,
        };
        let mut argv = vec![plan.operation.clone()];
        argv.extend(plan.args.iter().cloned());
        let result = runner.run(&plan, &argv, false).await;
        let mut rendered = command_result(&plan, &result, cap);
        rendered.text = append_text(&rendered.text, &lock_wait_note(waited, None));
        return rendered;
    }
    if REPO_FREE_OPERATIONS.contains(&plan.operation.as_str()) {
        let mut argv = vec![plan.operation.clone()];
        argv.extend(plan.args.iter().cloned());
        let result = runner.run(&plan, &argv, false).await;
        return command_result(&plan, &result, cap);
    }
    // Report the command the caller actually ran, not the internal probe.
    let info = resolve_repo(runner, &plan).await;
    let (Some(repo), Some(lock_key)) = (info.root.clone(), info.common_dir.clone()) else {
        let missing = match info.probe {
            Some(probe) => probe,
            None => runner.run(&plan, &strings(&["rev-parse", "--show-toplevel"]), false).await,
        };
        return command_result(&plan, &missing, cap);
    };
    // A command in a snapshot worktree uses it like a worker would: it holds a workspace lease
    // while it runs, and a snapshot being removed refuses it.
    let _lease = match call.services {
        Some(services) => {
            let ledger = services.worktrees.ledger();
            match ledger.admit(&repo) {
                Ok(lease) => Some(lease),
                Err(()) => {
                    let held = ledger.containing(&repo).map_or_else(String::new, |(_, path)| path.display().to_string());
                    return rejected(&format!("the snapshot worktree {held} is being removed; nothing ran"));
                }
            }
        }
        None => None,
    };
    run_in_repository(call, input, &plan, &repo, &lock_key, cap).await
}

async fn run_in_repository(
    call: &CallEnv<'_>,
    input: &Object,
    plan: &Plan,
    repo: &Path,
    lock_key: &Path,
    cap: Cap,
) -> Rendered {
    let runner = call.runner;
    let mut argv = prepare(plan);
    let stageable_request = plan.operation == "diff" && (plan.args.is_empty() || plan.args[0] == "--");
    if stageable_request {
        for (offset, flag) in ["--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"].iter().enumerate() {
            argv.insert(1 + offset, (*flag).to_owned());
        }
    }
    // A read takes no lock, so it never waits behind another read or a write.
    if plan.read_only() {
        let result = if stageable_request {
            run_stageable_diff(runner, plan, &argv, repo).await
        } else {
            runner.run(plan, &argv, true).await
        };
        if !result.succeeded() {
            return command_result(plan, &result, cap);
        }
        if stageable_request && input.get("include_stage_ids") == Some(&json!(true)) {
            if result.not_utf8 {
                let mut rendered = command_result(plan, &result, cap);
                rendered.text = append_text(&rendered.text, NOT_UTF8_STAGE_NOTE);
                return rendered;
            }
            let snapshot = stage::create_diff_snapshot(
                repo,
                &call.work_dir,
                SnapshotPlan { cwd: plan.cwd.clone(), global_args: plan.global_args.clone(), args: plan.args.clone() },
                &argv,
                &result.out(),
            );
            return stageable_diff_result(plan, &result, &snapshot, cap);
        }
        return command_result(plan, &result, cap);
    }
    let repo_wide = REPO_WIDE_OPERATIONS.contains(&plan.operation.as_str());
    let scopes = [repo];
    let (_guard, waited) = match acquire(call.locks, runner, lock_key, (!repo_wide).then_some(&scopes[..]), repo).await {
        Ok(held) => held,
        Err(aborted) => return aborted,
    };
    // A managed removal holds the same folder lock while it deletes: once it is ours, a folder
    // that is gone was removed, and nothing runs there.
    let present = {
        let repo = repo.to_path_buf();
        runner.blocking(move || folder_exists(&repo)).await
    };
    if present == Some(false) {
        return rejected(&format!("the worktree folder {} was removed meanwhile; nothing ran", repo.display()));
    }
    let result = runner.run_write(plan, &argv).await;
    let mut rendered = command_result(plan, &result, cap);
    rendered.text = append_text(&rendered.text, &lock_wait_note(waited, Some(&result)));
    rendered
}

async fn execute_git_tool(
    locks: &Arc<RepoLocks>,
    services: Option<&Arc<WorktreeServices>>,
    ctx: &ToolContext,
    raw_input: JsonValue,
) -> String {
    let JsonValue::Object(raw) = raw_input else {
        return fail("git requires an arguments object");
    };
    let mut input = raw.clone();
    if let Some(command) = raw.get("command") {
        let prefixed = match parse_stringified_array(command) {
            JsonValue::Array(items) => JsonValue::Array(
                items
                    .into_iter()
                    .map(|item| match item {
                        JsonValue::String(s) => JsonValue::String(with_git_prefix(&s)),
                        other => other,
                    })
                    .collect(),
            ),
            JsonValue::String(s) => JsonValue::String(with_git_prefix(&s)),
            other => other,
        };
        input.insert("command".into(), prefixed);
    }
    if let Some(change_ids) = raw.get("change_ids") {
        input.insert("change_ids".into(), parse_stringified_array(change_ids));
    }
    let exec = Exec::new(ctx.processes.clone());
    let runner = Runner { exec: &exec, cancel: &ctx.cancel, lane: ctx.io.maintenance };
    let call = CallEnv {
        locks,
        runner: &runner,
        session_id: ctx.thread_id.to_string(),
        tool_call_id: ctx.call_id.to_string(),
        work_dir: ctx.cwd.as_path().to_path_buf(),
        services,
    };
    let action = match input.get("action") {
        None | Some(JsonValue::Null) => JsonValue::String("command".into()),
        Some(other) => other.clone(),
    };
    if action.as_str() == Some("worktree") {
        return worktree::execute_worktree_action(&input, &call.work_dir, &call.worktree_env(&input)).await;
    }
    if let Some(field) = WORKTREE_INPUT_FIELDS.iter().find(|f| input.contains_key(**f)) {
        return fail(&format!("git {field} requires action:worktree"));
    }
    if input.contains_key("confirm_large") && action.as_str() != Some("command") {
        return fail("git confirm_large applies to action:worktree or a git worktree add command");
    }
    if action.as_str() == Some("stage") {
        if input.contains_key("command") || input.contains_key("include_stage_ids") {
            return fail("git action:stage accepts diff_id/change_ids, not command/include_stage_ids");
        }
        return execute_git_stage(locks, &runner, &input, &call.work_dir).await;
    }
    if action.as_str() != Some("command") {
        return fail("git action must be command, stage or worktree");
    }
    if input.contains_key("diff_id") || input.contains_key("change_ids") {
        return fail("git diff_id/change_ids require action:stage");
    }
    let chained = input.get("command").and_then(JsonValue::as_str).and_then(split_chained_git_commands);
    let commands: Vec<JsonValue> = match (input.get("command"), chained) {
        (_, Some(chain)) => chain.into_iter().map(JsonValue::String).collect(),
        (Some(JsonValue::Array(items)), None) => items.clone(),
        _ => return execute_single(&call, &input, None).await.text,
    };
    if commands.is_empty() || commands.len() > COMMAND_ARRAY_LIMIT {
        return fail(&format!("git command array requires 1 to {COMMAND_ARRAY_LIMIT} commands"));
    }
    let mut operations: Vec<String> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    for (index, command) in commands.iter().enumerate() {
        let Some(text) = command.as_str().filter(|c| !c.trim().is_empty()) else {
            return fail(&format!("git command {} must be a non-empty string", index + 1));
        };
        match parse_command(text, &call.work_dir).and_then(localize_config_plan) {
            Ok(plan) => operations.push(plan.operation),
            Err(message) => return fail(&format!("git command {}: {message}", index + 1)),
        }
        texts.push(text.to_owned());
    }
    // Ordered execution with fail-fast; every command is parsed above before any runs.
    let mut results: Vec<String> = Vec::new();
    let mut used = 0usize;
    for (index, text) in texts.iter().enumerate() {
        let label = format!("{}: git {}", index + 1, operations[index]);
        let budget = COMMAND_CHAR_BUDGET.min(MIN_COMMAND_CHARS.max(ARRAY_CHAR_BUDGET.saturating_sub(used)));
        let mut single = input.clone();
        single.insert("command".into(), JsonValue::String(text.clone()));
        let result = execute_single(&call, &single, Some(budget)).await;
        let section = format!("## {label}\n{}", result.text);
        used += u16len(&section);
        results.push(section);
        if result.failed {
            return append_text(&results.join("\n"), &format!("error: command failed: {label}"));
        }
    }
    results.join("\n")
}

#[async_trait]
impl Tool for GitTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        Ok(text_output(execute_git_tool(&self.locks, self.worktrees.as_ref(), ctx, args).await))
    }
}
