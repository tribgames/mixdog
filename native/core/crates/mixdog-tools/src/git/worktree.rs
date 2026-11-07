//! The git tool's managed-worktree surface (`git-worktree-tool.mjs`). Agents never create
//! unmanaged worktrees: `action:"worktree"` drives the Lead session's managed worktree, and a
//! raw `git worktree …` command maps onto a managed operation instead of running.
//!
//! The managed operations are `mixdog-scm`'s [`Worktrees`] (list, add, snapshot and its lease,
//! remove by path, prune), called directly. Only the session transitions — enter, return,
//! merge into the session workspace, remove the session's worktree — belong to the session
//! runtime, which implements [`SessionWorktrees`] at composition. A caller the session runtime
//! does not claim as the Lead is no Lead.

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_protocol::JsonValue;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::manager::CreateRequest;
use mixdog_scm::worktree::manager::Worktrees;
use mixdog_scm::worktree::retention::SnapshotRetention;
use mixdog_scm::worktree::manager::entry_json;
use mixdog_scm::worktree::texts::failure_json;
use serde_json::Map;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::argv::Plan;
use super::argv::resolve;
use super::run::Runner;
use super::run::fail;

type Object = Map<String, JsonValue>;

/// One transition of the session's own workspace; the Node host request, typed.
#[derive(Clone, Debug)]
pub enum SessionOp {
    /// Create or re-enter the managed worktree (`branch` names it; otherwise `name`).
    Enter {
        session_id: Option<String>,
        name: Option<String>,
        branch: Option<String>,
        create: bool,
        carry: Option<String>,
        confirm_large: bool,
        tx_id: String,
    },
    /// Back to the project folder; the worktree stays retained.
    Return { session_id: Option<String>, tx_id: String },
    /// Merge into the worktree's merge target, then the cleanup auto-cleanup allows.
    Merge { session_id: Option<String>, tx_id: String },
    /// Remove the session's worktree (or, with `branch`, the one it owns on that branch).
    Remove { session_id: Option<String>, branch: Option<String>, force: bool, tx_id: String },
}

/// The session runtime's workspace transitions (WP-SESSION). A result is the operation's own
/// object (`workspace`, `revision`, …); a refusal is a coded [`ScmFailure`].
#[async_trait]
pub trait SessionWorktrees: Send + Sync {
    /// Whether `session_id` is a Lead session this runtime hosts.
    async fn is_lead(&self, session_id: &str) -> bool;
    async fn run(&self, op: SessionOp, caller_session_id: &str, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure>;
}

/// What the `git` tool needs to manage worktrees.
pub struct WorktreeServices {
    pub worktrees: Arc<Worktrees>,
    /// Who keeps a worktree, read again for every list and prune (Node's `maintenanceScope`):
    /// the stored sessions, and (`live`) the ids of every session open in this process.
    pub stored: Arc<dyn SessionSource>,
    pub live: Arc<dyn Fn() -> HashSet<String> + Send + Sync>,
    pub sessions: Arc<dyn SessionWorktrees>,
}

impl WorktreeServices {
    /// The workspace API's `listWorktrees({ includeSnapshots: true })` (`worktree-tool.mjs`):
    /// every managed worktree, snapshots included, with who keeps it now.
    async fn rows(&self, cancel: &CancellationToken) -> Result<Vec<JsonValue>, ScmFailure> {
        // Without details the list weighs no cleanup limit, so `now` is never read.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        self.worktrees.list_with_retention(&self.stored, &(self.live)(), false, now, cancel).await
    }

    /// Who keeps what now, for a prune.
    async fn retention(&self, cancel: &CancellationToken) -> Result<SnapshotRetention, ScmFailure> {
        let stored = self.stored.stored_session_ids().await?;
        self.worktrees.retention((self.live)(), stored, cancel).await
    }
}

/// A failed operation: a plain message from the tool or a failure from `mixdog-scm`.
pub(super) enum Failure {
    Plain(String),
    Scm(ScmFailure),
}

impl From<ScmFailure> for Failure {
    fn from(failure: ScmFailure) -> Self {
        Self::Scm(failure)
    }
}

fn plain(message: impl Into<String>) -> Failure {
    Failure::Plain(message.into())
}

pub(super) struct Env<'a> {
    pub runner: &'a Runner<'a>,
    pub session_id: String,
    pub tool_call_id: String,
    pub services: Option<&'a Arc<WorktreeServices>>,
    /// The user accepted the large-repository size (`confirm_large:true`).
    pub confirm_large: bool,
}

impl Env<'_> {
    fn cancel(&self) -> &CancellationToken {
        self.runner.cancel
    }

    async fn is_lead(&self) -> bool {
        match self.services {
            Some(s) => s.sessions.is_lead(&self.session_id).await,
            None => false,
        }
    }

    /// The services of the Lead session; a caller none claims is no Lead.
    async fn lead(&self, what: &str) -> Result<&Arc<WorktreeServices>, Failure> {
        let refused = || plain(format!("{what} belongs to the Lead session; delegated workers cannot create, change or remove worktrees"));
        let services = self.services.ok_or_else(refused)?;
        if services.sessions.is_lead(&self.session_id).await { Ok(services) } else { Err(refused()) }
    }
}

const WORKTREE_TOOL_ACTIONS: [&str; 6] = ["enter", "return", "merge", "remove", "list", "prune"];
const CARRY_CHOICES: [&str; 2] = ["leave", "carry"];
pub(super) const WORKTREE_INPUT_FIELDS: [&str; 7] =
    ["worktree_action", "session_id", "name", "branch", "create", "carry", "force"];
const ADD_BARE_FLAGS: [&str; 10] = [
    "-q", "--quiet", "-f", "--force", "--lock", "--checkout", "--track", "--no-track", "--guess-remote", "--no-guess-remote",
];
const FIXED_LOCATION_SUBCOMMANDS: [&str; 4] = ["move", "lock", "unlock", "repair"];
const SCOPED_CONFIG: [&str; 2] = ["-c", "core.longpaths=true"];

fn ok_json(data: Object) -> String {
    let mut out = Object::new();
    out.insert("ok".into(), JsonValue::Bool(true));
    merge(&mut out, data);
    JsonValue::Object(out).to_string()
}

fn merge(into: &mut Object, from: Object) {
    for (key, value) in from {
        into.insert(key, value);
    }
}

fn object(value: JsonValue) -> Object {
    match value {
        JsonValue::Object(map) => map,
        _ => Object::new(),
    }
}

fn truthy(value: Option<&JsonValue>) -> bool {
    match value {
        None | Some(JsonValue::Null) | Some(JsonValue::Bool(false)) => false,
        Some(JsonValue::String(s)) => !s.is_empty(),
        Some(JsonValue::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(_) => true,
    }
}

fn str_field<'a>(object: &'a Object, key: &str) -> Option<&'a str> {
    object.get(key).and_then(JsonValue::as_str)
}

fn request(entries: Vec<(&str, JsonValue)>) -> Object {
    let mut out = Object::new();
    for (key, value) in entries {
        out.insert(key.to_owned(), value);
    }
    out
}

/// A failed operation for the model: coded worktree refusals as JSON with their details and
/// next step (`mixdog-scm`'s texts), everything else as `error: …`.
fn failure_text(error: &Failure, raw: bool) -> String {
    match error {
        Failure::Plain(message) => fail(message),
        Failure::Scm(scm) => failure_json(scm, raw).map_or_else(|| fail(&scm.to_string()), |value| value.to_string()),
    }
}

// ---- paths -------------------------------------------------------------------------------

fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// `canonicalPath`: the real path of the nearest existing ancestor plus the rest. Blocking:
/// only [`canonical_paths`] calls it, inside a maintenance-lane job.
#[allow(clippy::disallowed_methods, reason = "runs only as a maintenance-lane job body (Runner::blocking)")]
fn canonical_path(value: &str) -> String {
    let full = resolve(&std::env::current_dir().unwrap_or_default(), if value.is_empty() { "." } else { value });
    let mut head = full.clone();
    while !head.exists() {
        match head.parent() {
            Some(parent) if parent != head => head = parent.to_path_buf(),
            _ => return full.to_string_lossy().into_owned(),
        }
    }
    let Ok(real) = head.canonicalize() else { return full.to_string_lossy().into_owned() };
    let real = strip_verbatim(&real);
    let rest = full.strip_prefix(&head).unwrap_or(Path::new(""));
    if rest.as_os_str().is_empty() { real } else { real.join(rest) }.to_string_lossy().into_owned()
}

/// The canonical form of each path, off the async workers.
async fn canonical_paths(env: &Env<'_>, values: Vec<String>) -> Vec<String> {
    let fallback = values.clone();
    env.runner
        .blocking(move || values.iter().map(|v| canonical_path(v)).collect())
        .await
        .unwrap_or(fallback)
}

/// Whether two canonical paths name one folder.
fn same_path(left: &str, right: &str) -> bool {
    mixdog_scm::locks::path_key(Path::new(left)) == mixdog_scm::locks::path_key(Path::new(right))
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_owned()
}

fn basename(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// ---- git probes --------------------------------------------------------------------------

async fn git_probe(env: &Env<'_>, cwd: &Path, args: &[&str]) -> super::run::GitRun {
    let argv: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    let scoped: Vec<String> = SCOPED_CONFIG.iter().map(|s| (*s).to_owned()).collect();
    env.runner.run_in(cwd, &scoped, &argv, false).await
}

/// Repository facts in `cwd` from git itself (`None` outside a repository).
async fn repository_at(env: &Env<'_>, cwd: &Path) -> Option<String> {
    let probe = git_probe(env, cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await;
    if !probe.succeeded() {
        return None;
    }
    canonical_paths(env, vec![first_line(&probe.out())]).await.pop()
}

async fn local_branch_exists(env: &Env<'_>, cwd: &Path, branch: &str) -> bool {
    let reference = format!("refs/heads/{branch}");
    git_probe(env, cwd, &["rev-parse", "--verify", "--quiet", &reference]).await.succeeded()
}

/// Full commit id of commit-ish `value` resolved in `cwd`.
async fn commit_in(env: &Env<'_>, cwd: &Path, value: &str) -> Option<String> {
    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    let spec = format!("{value}^{{commit}}");
    let run = git_probe(env, cwd, &["rev-parse", "--verify", "--quiet", &spec]).await;
    run.succeeded().then(|| first_line(&run.out()))
}

struct GitWorktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    prunable: Option<String>,
}

async fn list_git_worktrees(env: &Env<'_>, cwd: &Path) -> Result<Vec<GitWorktree>, Failure> {
    let args = ["worktree", "list", "--porcelain", "-z"];
    let run = git_probe(env, cwd, &args).await;
    if !run.succeeded() {
        let detail = {
            let text = if run.err().is_empty() { run.out() } else { run.err() };
            let text = text.trim().to_owned();
            if text.is_empty() { "no diagnostic".to_owned() } else { text }
        };
        let code = run.code.map_or("null".to_owned(), |c| c.to_string());
        return Err(plain(format!("git {} failed (exit {code}): {detail}", args.join(" "))));
    }
    let mut out: Vec<GitWorktree> = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for field in run.out().split('\0') {
        if field.is_empty() {
            out.extend(current.take());
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        if key == "worktree" {
            out.extend(current.take());
            current = Some(GitWorktree { path: value.to_owned(), head: None, branch: None, detached: false, prunable: None });
            continue;
        }
        let Some(c) = current.as_mut() else { continue };
        match key {
            "HEAD" => c.head = Some(value.to_owned()),
            "branch" => c.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_owned()),
            "detached" => c.detached = true,
            "prunable" => c.prunable = Some(value.to_owned()),
            _ => {}
        }
    }
    out.extend(current);
    let canonical = canonical_paths(env, out.iter().map(|w| w.path.clone()).collect()).await;
    for (worktree, path) in out.iter_mut().zip(canonical) {
        worktree.path = path;
    }
    Ok(out)
}

// ---- results -----------------------------------------------------------------------------

fn compact_workspace(workspace: &Object) -> JsonValue {
    let mut out = Object::new();
    let mut put = |key: &str, null_default: bool| match workspace.get(key) {
        Some(value) if !value.is_null() => {
            out.insert(key.into(), value.clone());
        }
        _ if null_default => {
            out.insert(key.into(), JsonValue::Null);
        }
        _ => {}
    };
    put("cwd", false);
    put("branch", true);
    put("mergeTarget", true);
    put("revision", false);
    put("worktreeId", true);
    JsonValue::Object(out)
}

/// A workspace operation's result: its own fields, the workspace compacted.
fn transition_result(fields: Object, result: JsonValue) -> String {
    let mut rest = object(result);
    let workspace = rest.shift_remove("workspace");
    rest.shift_remove("revision");
    rest.shift_remove("pending");
    let mut out = fields;
    merge(&mut out, rest);
    if let Some(JsonValue::Object(workspace)) = workspace.filter(|w| truthy(Some(w))) {
        out.insert("workspace".into(), compact_workspace(&workspace));
    }
    ok_json(out)
}

fn tx_id_of(env: &Env<'_>, discriminator: &str) -> String {
    let id = env.tool_call_id.trim();
    if id.is_empty() { String::new() } else { format!("{id}:{discriminator}") }
}

async fn session_op(env: &Env<'_>, op: SessionOp) -> Result<JsonValue, Failure> {
    let lead = env.lead(&format!("git worktree_action {}", op_name(&op))).await?;
    Ok(lead.sessions.run(op, &env.session_id, env.cancel()).await?)
}

fn op_name(op: &SessionOp) -> &'static str {
    match op {
        SessionOp::Enter { .. } => "enter",
        SessionOp::Return { .. } => "return",
        SessionOp::Merge { .. } => "merge",
        SessionOp::Remove { .. } => "remove",
    }
}

// ---- listing -----------------------------------------------------------------------------

/// Managed rows of the repository at `cwd` (every repository outside one) plus the
/// repository's other git worktrees: the main checkout and unmanaged ones, flagged.
async fn list_rows(env: &Env<'_>, cwd: &Path) -> Result<Vec<JsonValue>, Failure> {
    let lead = env.is_lead().await;
    let repo = repository_at(env, cwd).await;
    let managed: Vec<JsonValue> = match env.services {
        Some(s) => {
            let scope = repo.as_deref().map(|repo| mixdog_scm::locks::path_key(Path::new(repo)));
            let of_repo = |row: &JsonValue| {
                scope.as_ref().is_none_or(|scope| {
                    row["repoCommonDir"].as_str().is_some_and(|dir| mixdog_scm::locks::path_key(Path::new(dir)) == *scope)
                })
            };
            s.rows(env.cancel()).await?.into_iter().filter(of_repo).collect()
        }
        None => Vec::new(),
    };
    let ours: Vec<Object> = managed.into_iter().map(object).collect();
    let mut rows: Vec<JsonValue> = ours
        .iter()
        .map(|row| {
            let mut out = Object::new();
            for key in ["id", "path"] {
                if let Some(v) = row.get(key) {
                    out.insert(key.into(), v.clone());
                }
            }
            out.insert("branch".into(), row.get("branch").cloned().unwrap_or(JsonValue::Null));
            let get = |key: &str| row.get(key).cloned().unwrap_or(JsonValue::Null);
            if str_field(row, "kind") == Some("snapshot") {
                out.insert("snapshot".into(), json!(true));
                if let Some(v) = row.get("baseCommit") {
                    out.insert("commit".into(), v.clone());
                }
                out.insert("holderSessionId".into(), get("holderSessionId"));
            } else {
                out.insert("ownerSessionId".into(), get("ownerSessionId"));
                out.insert("mergeTarget".into(), get("mergeTarget"));
            }
            if let Some(v) = row.get("state") {
                out.insert("state".into(), v.clone());
            }
            if let Some(v) = row.get("ownerLive").filter(|v| v.is_boolean()) {
                out.insert("ownerLive".into(), v.clone());
            }
            if lead && let Some(v) = row.get("removable").filter(|v| v.is_boolean()) {
                out.insert("removable".into(), v.clone());
            }
            JsonValue::Object(out)
        })
        .collect();
    if repo.is_none() {
        return Ok(rows);
    }
    // git lists the main working tree first.
    let mut all = list_git_worktrees(env, cwd).await?.into_iter();
    let mut listed: Vec<JsonValue> = Vec::new();
    if let Some(main) = all.next() {
        listed.push(json!({"path": main.path, "branch": main.branch, "main": true}));
    }
    listed.append(&mut rows);
    for worktree in all {
        if ours.iter().any(|row| str_field(row, "path").is_some_and(|p| same_path(p, &worktree.path))) {
            continue;
        }
        let mut out = Object::new();
        out.insert("path".into(), json!(worktree.path));
        out.insert("branch".into(), json!(worktree.branch));
        if worktree.detached {
            out.insert("head".into(), json!(worktree.head));
        }
        out.insert("unmanaged".into(), json!(true));
        if worktree.prunable.as_deref().is_some_and(|p| !p.is_empty()) {
            out.insert("prunable".into(), json!(true));
        }
        listed.push(JsonValue::Object(out));
    }
    Ok(listed)
}

fn worktrees_object(rows: Vec<JsonValue>) -> Object {
    request(vec![("worktrees", JsonValue::Array(rows))])
}

// ---- raw `git worktree …` ------------------------------------------------------------------

async fn raw_add(plan: &Plan, env: &Env<'_>) -> Result<String, Failure> {
    let mut branch: Option<String> = None;
    let mut reset = false;
    let mut detach = false;
    let mut positional: Vec<String> = Vec::new();
    let args = &plan.args[1..];
    let mut index = 0;
    while index < args.len() {
        let value = args[index].as_str();
        if value == "--" {
            positional.extend(args[index + 1..].iter().cloned());
            break;
        }
        if value == "-b" || value == "-B" {
            index += 1;
            branch = args.get(index).cloned().filter(|b| !b.is_empty());
            reset = value == "-B";
            if branch.is_none() {
                return Err(plain(format!("git worktree add: {value} requires a branch name")));
            }
        } else if value == "--reason" {
            index += 1;
        } else if value.starts_with("--reason=") {
        } else if value == "--detach" || value == "-d" {
            detach = true;
        } else if value == "--orphan" || value == "--no-checkout" {
            return Err(plain(format!("git worktree add: {value} is not supported for managed worktrees")));
        } else if ADD_BARE_FLAGS.contains(&value) {
        } else if value.starts_with('-') {
            return Err(plain(format!("git worktree add: option {value} is not supported for managed worktrees")));
        } else {
            positional.push(value.to_owned());
        }
        index += 1;
    }
    let path = positional.first().cloned();
    let commitish = positional.get(1).cloned();
    let Some(path) = path.filter(|_| positional.len() <= 2) else {
        return Err(plain("git worktree add requires <path> [<commit-ish>]"));
    };
    if detach && branch.is_some() {
        return Err(plain("git worktree add: --detach excludes -b/-B"));
    }
    if !env.is_lead().await && !detach {
        return Err(plain(
            "git worktree add belongs to the Lead session; a delegated worker may only make a read-only snapshot: git worktree add --detach <path> [<commit>]",
        ));
    }
    if repository_at(env, &plan.cwd).await.is_none() {
        return Err(plain(format!("git worktree add: {} is not a git repository", plan.cwd.display())));
    }
    let tx_id = tx_id_of(env, &plan.command);
    let mapped = request(vec![
        ("mapped", json!(plan.command)),
        ("requestedPath", json!(resolve(&plan.cwd, &path).to_string_lossy())),
    ]);
    // A detached checkout, or a commit-ish that names no local branch: a snapshot.
    let mut snapshot_commit: Option<String> = None;
    if detach {
        snapshot_commit = Some(commitish.clone().unwrap_or_else(|| "HEAD".to_owned()));
    } else if branch.is_none()
        && let Some(c) = &commitish
        && !local_branch_exists(env, &plan.cwd, c).await
    {
        snapshot_commit = Some(c.clone());
    }
    let Some(services) = env.services else {
        return Err(plain("git worktree add: managed worktrees are unavailable in this runtime"));
    };
    if let Some(wanted) = snapshot_commit {
        let Some(commit) = commit_in(env, &plan.cwd, &wanted).await else {
            return Err(plain(format!("git worktree add: {wanted} is not a commit")));
        };
        // Held by the calling session and removed when its turn settles.
        let entry = services
            .worktrees
            .create_worker_snapshot(&env.session_id, &plan.cwd, &commit, &tx_id, env.confirm_large, env.cancel())
            .await?;
        let entry = object(entry);
        let mut out = mapped;
        out.insert("snapshot".into(), json!(true));
        for (key, from) in [("path", "path"), ("commit", "baseCommit"), ("worktreeId", "id")] {
            if let Some(v) = entry.get(from) {
                out.insert(key.into(), v.clone());
            }
        }
        out.insert(
            "note".into(),
            json!("Managed read-only snapshot at the path above (not the one requested); it is removed when this turn ends, and changes made in it are discarded. The session did not move."),
        );
        return Ok(ok_json(out));
    }
    let target_branch: String;
    let create: bool;
    let start_point: Option<String>;
    if let Some(requested) = branch {
        if local_branch_exists(env, &plan.cwd, &requested).await {
            return Err(plain(if reset {
                format!("git worktree add: -B would reset the existing branch {requested}; managed worktrees never reset a branch (omit -B to check it out as it is)")
            } else {
                format!("git worktree add: a branch named '{requested}' already exists (omit -b to check it out)")
            }));
        }
        let from = commitish.clone().unwrap_or_else(|| "HEAD".to_owned());
        let Some(start) = commit_in(env, &plan.cwd, &from).await else {
            return Err(plain(format!(
                "git worktree add: {} is not a commit",
                commitish.unwrap_or_else(|| "undefined".to_owned())
            )));
        };
        target_branch = requested;
        create = true;
        start_point = Some(start);
    } else {
        // git's convenience: no branch named, so the branch is the commit-ish (an existing
        // local branch) or the path's last segment.
        let chosen = commitish.clone().unwrap_or_else(|| basename(&resolve(&plan.cwd, &path)));
        create = !local_branch_exists(env, &plan.cwd, &chosen).await;
        start_point = if create { commit_in(env, &plan.cwd, "HEAD").await } else { None };
        target_branch = chosen;
    }
    let record = services
        .worktrees
        .create(
            CreateRequest {
                project_path: plan.cwd.clone(),
                session_id: env.session_id.clone(),
                tx_id,
                name_hint: target_branch.clone(),
                base_branch: None,
                branch: Some(target_branch.clone()),
                existing_branch: !create,
                start_commit: start_point,
                confirm_large: env.confirm_large,
                // Node's `add` carries nothing and binds no runtime lease here; the session
                // runtime binds the lease when it enters the worktree.
                carry: None,
                runtime_token: String::new(),
            },
            env.cancel(),
        )
        .await?;
    let mut out = mapped;
    merge(&mut out, object(entry_json(&record)));
    out.insert(
        "note".into(),
        json!(format!("Managed worktree at the path above (not the one requested), retained by this session. The session did not move; worktree_action:\"enter\" with branch:\"{target_branch}\" moves it there.")),
    );
    Ok(ok_json(out))
}

async fn raw_remove(plan: &Plan, env: &Env<'_>) -> Result<String, Failure> {
    let mut force = false;
    let mut positional: Vec<&String> = Vec::new();
    for value in &plan.args[1..] {
        if value == "-f" || value == "--force" {
            force = true;
        } else if value.starts_with('-') {
            return Err(plain(format!("git worktree remove: option {value} is not supported")));
        } else {
            positional.push(value);
        }
    }
    if positional.len() != 1 {
        return Err(plain("git worktree remove requires exactly one <path>"));
    }
    let lead = env.lead("git worktree remove").await?;
    let path = resolve(&plan.cwd, positional[0]);
    // A snapshot goes through its ledger, which refuses while a command still runs in it.
    let wanted = mixdog_scm::locks::path_key(&path);
    let rows = lead.rows(env.cancel()).await?;
    let snapshot = rows.iter().find(|row| {
        row["kind"] == "snapshot"
            && row["path"].as_str().is_some_and(|p| mixdog_scm::locks::path_key(Path::new(p)) == wanted)
    });
    let removed = match snapshot.and_then(|row| row["id"].as_str()) {
        Some(id) => lead.worktrees.remove_snapshot(id, force, env.cancel()).await,
        None => lead.worktrees.remove_by_path(&path, force, Some(&env.session_id), env.cancel()).await,
    };
    let result = removed.map_err(|failure| match failure {
        // Node's wording for a folder the registry does not manage.
        ScmFailure::Coded { code: "WORKTREE_PATH_UNSAFE", .. } if snapshot.is_none() => plain(format!(
            "git worktree remove: {} is not a Mixdog-managed worktree; unmanaged worktrees are not removed through the git tool",
            path.display()
        )),
        other => Failure::Scm(other),
    })?;
    let shown = path.to_string_lossy().into_owned();
    Ok(transition_result(request(vec![("mapped", json!(plan.command)), ("path", json!(shown))]), result))
}

/// `git worktree prune` arguments, all validated before anything runs.
fn parse_prune_args(args: &[String]) -> Result<bool, Failure> {
    let mut dry_run = false;
    for value in args {
        if value == "-n" || value == "--dry-run" {
            dry_run = true;
        } else if value == "-v" || value == "--verbose" {
        } else if value.starts_with('-') {
            return Err(plain(format!(
                "git worktree prune: option {value} is not supported (managed prune takes -n/--dry-run and -v/--verbose)"
            )));
        } else {
            return Err(plain(format!("git worktree prune: unexpected argument {value}")));
        }
    }
    Ok(dry_run)
}

async fn raw_prune(plan: &Plan, env: &Env<'_>) -> Result<String, Failure> {
    let dry_run = parse_prune_args(&plan.args[1..])?;
    let lead = env.lead("git worktree prune").await?;
    if dry_run {
        let rows = list_rows(env, &plan.cwd).await?;
        let removable: Vec<JsonValue> = rows
            .into_iter()
            .filter(|row| row.get("removable").is_some_and(|v| truthy(Some(v))))
            .collect();
        return Ok(ok_json(request(vec![
            ("mapped", json!(plan.command)),
            ("dryRun", json!(true)),
            ("wouldRemove", JsonValue::Array(removable)),
        ])));
    }
    let repo = repository_at(env, &plan.cwd).await;
    let retention = lead.retention(env.cancel()).await?;
    let result = lead.worktrees.prune(repo.as_deref().map(Path::new), &retention, false, env.cancel()).await?;
    let mut out = request(vec![("mapped", json!(plan.command))]);
    merge(&mut out, object(result));
    Ok(ok_json(out))
}

fn worktree_help(sub: &str) -> Option<&'static str> {
    Some(match sub {
        "add" => "git worktree add [-b <branch>] [--detach] <path> [<commit-ish>]: a managed worktree for the branch (the session stays put), or a read-only snapshot for a detached commit.",
        "remove" => "git worktree remove [-f] <path>: the managed removal of that worktree.",
        "list" => "git worktree list [-v]: managed worktrees plus the repository's other worktrees. --porcelain stays raw git.",
        "prune" => "git worktree prune [-n|--dry-run] [-v]: the managed prune of this repository (clean, merged worktrees no session retains); -n only lists what it would remove.",
        _ => return None,
    })
}

/// `-h`/`--help` before any `--` answers instead of the operation running.
fn wants_help(args: &[String]) -> bool {
    let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
    args[..end].iter().any(|v| v == "-h" || v == "--help")
}

fn check_list_args(args: &[String]) -> Result<(), Failure> {
    for value in args {
        if value == "-v" || value == "--verbose" {
            continue;
        }
        return Err(plain(format!(
            "git worktree list: {}",
            if value.starts_with('-') { format!("option {value} is not supported") } else { format!("unexpected argument {value}") }
        )));
    }
    Ok(())
}

pub(super) struct Mapped {
    pub text: String,
    pub failed: bool,
}

/// A raw `git worktree …` command as its managed operation, or `None` for the one form that
/// still runs as git (`list --porcelain`).
pub(super) async fn execute_raw_worktree(plan: &Plan, env: &Env<'_>) -> Option<Mapped> {
    let sub = plan.args.first().map(String::as_str).unwrap_or("");
    if let Some(help) = worktree_help(sub)
        && wants_help(&plan.args[1..])
    {
        return Some(Mapped {
            text: ok_json(request(vec![("mapped", json!(plan.command)), ("help", json!(help))])),
            failed: false,
        });
    }
    if sub == "list" && plan.args.iter().any(|a| a == "--porcelain") {
        return None;
    }
    let outcome: Result<String, Failure> = async {
        match sub {
            "list" => {
                check_list_args(&plan.args[1..])?;
                let rows = list_rows(env, &plan.cwd).await?;
                let mut out = request(vec![("mapped", json!(plan.command))]);
                merge(&mut out, worktrees_object(rows));
                Ok(ok_json(out))
            }
            "add" => raw_add(plan, env).await,
            "remove" => raw_remove(plan, env).await,
            "prune" => raw_prune(plan, env).await,
            s if FIXED_LOCATION_SUBCOMMANDS.contains(&s) => Ok(fail(&format!(
                "git worktree {sub} is refused: Mixdog-managed worktrees stay at their fixed, locked locations. Use git worktree list/remove/prune or action:\"worktree\""
            ))),
            _ => Ok(fail(&format!(
                "git worktree {} is not supported; use add, remove, list, prune or action:\"worktree\"",
                if sub.is_empty() { "(no subcommand)" } else { sub }
            ))),
        }
    }
    .await;
    Some(match outcome {
        Ok(text) => {
            let refused = text.starts_with("error: ");
            Mapped { text, failed: refused }
        }
        Err(error) => Mapped { text: failure_text(&error, true), failed: true },
    })
}

// ---- action:"worktree" ---------------------------------------------------------------------

/// Validation of `action:"worktree"` input; the problem text, or none.
fn worktree_input_error(input: &Object) -> Option<String> {
    let action = input.get("worktree_action").and_then(JsonValue::as_str);
    let Some(action) = action.filter(|a| WORKTREE_TOOL_ACTIONS.contains(a)) else {
        return Some(format!("git action:worktree requires worktree_action: {}", WORKTREE_TOOL_ACTIONS.join(", ")));
    };
    for field in ["command", "diff_id", "change_ids", "include_stage_ids", "output_limit"] {
        if input.contains_key(field) {
            return Some(format!("git action:worktree does not take {field}"));
        }
    }
    let only = |field: &str, allowed: &[&str]| {
        (input.contains_key(field) && !allowed.contains(&action))
            .then(|| format!("{field} applies to worktree_action {}, not {action}", allowed.join(", ")))
    };
    let misplaced = only("session_id", &["enter", "return", "merge", "remove"])
        .or_else(|| only("name", &["enter"]))
        .or_else(|| only("branch", &["enter", "remove"]))
        .or_else(|| only("create", &["enter"]))
        .or_else(|| only("carry", &["enter"]))
        .or_else(|| only("confirm_large", &["enter"]))
        .or_else(|| only("force", &["remove"]));
    if misplaced.is_some() {
        return misplaced;
    }
    if let Some(id) = input.get("session_id")
        && id.as_str().is_none_or(|s| s.trim().is_empty())
    {
        return Some("session_id must be a session id".to_owned());
    }
    if input.contains_key("create") && !truthy(input.get("branch")) {
        return Some("create needs branch".to_owned());
    }
    if let Some(branch) = input.get("branch")
        && branch.as_str().is_none_or(|s| s.trim().is_empty())
    {
        return Some("branch must be a branch name".to_owned());
    }
    if truthy(input.get("branch")) && (input.contains_key("name") || input.contains_key("carry")) {
        return Some("branch excludes name and carry (the branch names the worktree; changes stay in the project folder)".to_owned());
    }
    if let Some(carry) = input.get("carry")
        && !carry.as_str().is_some_and(|c| CARRY_CHOICES.contains(&c))
    {
        return Some("carry must be leave or carry".to_owned());
    }
    if action == "remove" && input.contains_key("branch") && input.contains_key("session_id") {
        return Some("branch names one of this session's own worktrees; it excludes session_id".to_owned());
    }
    None
}

/// `action:"worktree"`: one managed-worktree operation of the caller's (or `session_id`'s)
/// session.
pub(super) async fn execute_worktree_action(input: &Object, work_dir: &Path, env: &Env<'_>) -> String {
    if let Some(problem) = worktree_input_error(input) {
        return fail(&problem);
    }
    let action = input.get("worktree_action").and_then(JsonValue::as_str).unwrap_or_default().to_owned();
    let outcome: Result<String, Failure> = async {
        if action == "list" {
            let rows = list_rows(env, work_dir).await?;
            let mut out = request(vec![("worktree_action", json!(action))]);
            merge(&mut out, worktrees_object(rows));
            return Ok(ok_json(out));
        }
        let lead = env.lead(&format!("git worktree_action {action}")).await?;
        let session_id = input
            .get("session_id")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let branch = input.get("branch").and_then(JsonValue::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
        let flag = |key: &str| input.get(key) == Some(&json!(true));
        let mut fields = request(vec![("worktree_action", json!(action))]);
        if action == "prune" {
            let repo = repository_at(env, work_dir).await;
            let retention = lead.retention(env.cancel()).await?;
            let result = lead.worktrees.prune(repo.as_deref().map(Path::new), &retention, false, env.cancel()).await?;
            merge(&mut fields, object(result));
            return Ok(ok_json(fields));
        }
        let tx_id = tx_id_of(env, &action);
        let op = match action.as_str() {
            "enter" => SessionOp::Enter {
                session_id: session_id.clone(),
                name: input.get("name").and_then(JsonValue::as_str).map(str::to_owned),
                branch,
                create: flag("create"),
                carry: input.get("carry").and_then(JsonValue::as_str).map(str::to_owned),
                confirm_large: flag("confirm_large"),
                tx_id,
            },
            "return" => SessionOp::Return { session_id: session_id.clone(), tx_id },
            "merge" => SessionOp::Merge { session_id: session_id.clone(), tx_id },
            _ => SessionOp::Remove { session_id: session_id.clone(), branch, force: flag("force"), tx_id },
        };
        let result = session_op(env, op).await?;
        if let Some(id) = &session_id {
            fields.insert("sessionId".into(), json!(id));
        }
        Ok(transition_result(fields, result))
    }
    .await;
    outcome.unwrap_or_else(|error| failure_text(&error, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(value: JsonValue) -> Object {
        object(value)
    }

    #[test]
    fn input_validation_texts() {
        assert_eq!(
            worktree_input_error(&input(json!({}))).unwrap(),
            "git action:worktree requires worktree_action: enter, return, merge, remove, list, prune"
        );
        assert_eq!(
            worktree_input_error(&input(json!({"worktree_action": "list", "command": "git x"}))).unwrap(),
            "git action:worktree does not take command"
        );
        assert_eq!(
            worktree_input_error(&input(json!({"worktree_action": "merge", "force": true}))).unwrap(),
            "force applies to worktree_action remove, not merge"
        );
        assert_eq!(
            worktree_input_error(&input(json!({"worktree_action": "enter", "create": true}))).unwrap(),
            "create needs branch"
        );
        assert!(worktree_input_error(&input(json!({"worktree_action": "enter", "branch": "b", "create": true}))).is_none());
    }

    #[test]
    fn plain_failures_read_as_errors_and_coded_ones_as_json() {
        assert_eq!(failure_text(&plain("boom"), false), "error: boom");
        let coded = Failure::Scm(mixdog_scm::worktree::errors::dirty(Some("w".into()), None, Some(2), None));
        let text = failure_text(&coded, false);
        assert!(text.starts_with(r#"{"ok":false,"code":"WORKTREE_DIRTY","error":"The worktree has uncommitted changes.""#));
    }
}
