//! Managed worktrees: create, snapshot, list, remove, prune and merge. Every mutation runs
//! under the repository's whole-repository write lock and revalidates only what it needs from
//! git; refusals are the typed ones of [`crate::worktree::errors`].

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_workspace::pathguard::canonical_path;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::engine::Repo;
use crate::engine::Scm;
use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::locks::path_key;
use crate::repo::on_lane;
use crate::repo::operation_in_progress;
use crate::repo::operation_verb;
use crate::inspect::status::path_text;
use crate::worktree::errors;
use crate::worktree::merge::MergeResult;
use crate::worktree::names;
use crate::worktree::ownership::Owner;
use crate::worktree::registry::Registry;
use crate::worktree::include;
use crate::worktree::registry::WorktreeRecord;
use crate::worktree::settings::SettingsSource;
use crate::worktree::settings::WorktreeSettings;
use crate::worktree::snapshots::SnapshotLedger;

/// Who is alive and who keeps what, as the session layer knows it.
pub trait Retention: Send + Sync {
    /// A live session or a running lease holder.
    fn owner_live(&self, record: &WorktreeRecord) -> bool;
    /// The session store still keeps the owning session.
    fn retained(&self, record: &WorktreeRecord) -> bool;
}

/// Repository facts every managed operation starts from.
#[derive(Clone, Debug)]
pub struct RepoFacts {
    pub project_path: PathBuf,
    pub top_level: PathBuf,
    pub common_dir: PathBuf,
    pub head: String,
    pub current_branch: Option<String>,
}

/// One line of `git worktree list`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub prunable: bool,
    /// The lock reason (empty for a lock without one); `None` when not locked.
    pub locked: Option<String>,
}

pub fn parse_worktree_list(text: &str) -> Vec<GitWorktree> {
    let mut rows = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for field in text.split('\0') {
        if field.is_empty() {
            rows.extend(current.take());
            continue;
        }
        if let Some(path) = field.strip_prefix("worktree ") {
            rows.extend(current.take());
            current = Some(GitWorktree {
                path: path.to_owned(),
                head: String::new(),
                branch: None,
                detached: false,
                prunable: false,
                locked: None,
            });
        } else if let Some(row) = current.as_mut() {
            if let Some(head) = field.strip_prefix("HEAD ") {
                row.head = head.to_owned();
            } else if let Some(branch) = field.strip_prefix("branch ") {
                row.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_owned());
            } else if field == "detached" {
                row.detached = true;
            } else if field.starts_with("prunable") {
                row.prunable = true;
            } else if field == "locked" || field.starts_with("locked ") {
                row.locked = Some(field.strip_prefix("locked ").unwrap_or("").to_owned());
            }
        }
    }
    rows.extend(current);
    rows
}

#[derive(Clone, Debug, Default)]
pub struct CreateRequest {
    pub project_path: PathBuf,
    pub session_id: String,
    pub tx_id: String,
    pub name_hint: String,
    pub base_branch: Option<String>,
    /// An exact branch name (`create` makes it; otherwise it must exist).
    pub branch: Option<String>,
    pub existing_branch: bool,
    pub start_commit: Option<String>,
    /// The user confirmed a repository over the size threshold.
    pub confirm_large: bool,
    /// What to do with the project folder's uncommitted changes: `ask` (refuse while there are
    /// any), `leave`, `carry`; `None` leaves them unexamined.
    pub carry: Option<String>,
    /// The runtime of the owning session, bound by the owner lease.
    pub runtime_token: String,
}

/// The runtime token of this process's worker snapshots (`worker-snapshots.mjs state()`: a random
/// `worker-snapshots-<uuid>` per process).
fn process_runtime_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| {
        use sha2::Digest;
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let digest = sha2::Sha256::digest(format!("{}:{nanos}:{:p}", std::process::id(), &TOKEN).as_bytes());
        format!("worker-snapshots-{}", digest.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>())
    })
}

/// A created worktree and what creation did.
#[derive(Clone, Debug)]
pub struct Created {
    pub record: WorktreeRecord,
    /// `{root, copied, linked, skipped}`: what the first turn tells the agent.
    pub prepared: Value,
    /// `{mode: carried|left, count, recoveryRef?}` for the project folder's changes.
    pub changes: Option<Value>,
}

impl Created {
    /// The entry plus `prepared` and `changes`, as `createManagedWorktree` returns it.
    pub fn to_json(&self) -> Value {
        let mut out = entry_json(&self.record);
        out["prepared"] = self.prepared.clone();
        if let Some(changes) = &self.changes {
            out["changes"] = changes.clone();
        }
        out
    }
}

pub struct Worktrees {
    scm: Arc<Scm>,
    registry: Arc<Registry>,
    data_dir: PathBuf,
    ledger: Arc<SnapshotLedger>,
    settings: Option<Arc<dyn SettingsSource>>,
    activity: Option<Arc<crate::worktree::activity::Activity>>,
    cleanups: Vec<Arc<dyn crate::worktree::removal::RootCleanup>>,
    sizes: Arc<crate::worktree::disk::SizeCache>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The public shape of a record.
pub fn entry_json(record: &WorktreeRecord) -> Value {
    let mut entry = json!({
        "id": record.id,
        "repoCommonDir": record.repo_common_dir,
        "projectPath": record.project_path,
        "path": record.path,
        "branch": record.branch,
        "baseCommit": record.base_commit,
        "createdAt": record.created_at,
        "ownerSessionId": record.owner_session_id,
        "state": record.state,
        "projectSubdir": record.extra.get("projectSubdir").cloned().unwrap_or_else(|| json!("")),
        "mergeTarget": record.merge_target,
        "warnings": record.extra.get("warnings").cloned().unwrap_or_else(|| json!([])),
        "disposable": record.extra.get("disposable") == Some(&Value::Bool(true)),
    });
    if record.extra.get("kind").and_then(Value::as_str) == Some("snapshot") {
        entry["kind"] = json!("snapshot");
        entry["holderSessionId"] = record.extra.get("holderSessionId").cloned().unwrap_or(Value::Null);
    }
    entry
}

fn tracked_warnings(tracked: &crate::worktree::disk::Tracked) -> Vec<String> {
    if tracked.submodules { vec!["submodules".to_owned()] } else { Vec::new() }
}

pub(crate) fn is_snapshot(record: &WorktreeRecord) -> bool {
    record.extra.get("kind").and_then(Value::as_str) == Some("snapshot")
}

impl Worktrees {
    pub fn new(scm: Arc<Scm>, data_dir: PathBuf) -> Self {
        Self {
            registry: Arc::new(Registry::new(&data_dir)),
            ledger: SnapshotLedger::new(),
            settings: None,
            activity: None,
            cleanups: Vec::new(),
            sizes: Arc::default(),
            scm,
            data_dir,
        }
    }

    pub(crate) fn sizes(&self) -> &Arc<crate::worktree::disk::SizeCache> {
        &self.sizes
    }

    /// A host cleanup that runs when a folder is removed (desktop terminals, caches keyed by it).
    pub fn with_root_cleanup(mut self, cleanup: Arc<dyn crate::worktree::removal::RootCleanup>) -> Self {
        if !self.cleanups.iter().any(|known| Arc::ptr_eq(known, &cleanup)) {
            self.cleanups.push(cleanup);
        }
        self
    }

    pub(crate) fn cleanups(&self) -> &[Arc<dyn crate::worktree::removal::RootCleanup>] {
        &self.cleanups
    }

    /// The workspace admission a snapshot's folder is held against before its removal.
    pub fn with_activity(mut self, activity: Arc<crate::worktree::activity::Activity>) -> Self {
        self.activity = Some(activity);
        self
    }

    pub(crate) fn activity(&self) -> Option<&Arc<crate::worktree::activity::Activity>> {
        self.activity.as_ref()
    }

    /// Reads the worktree settings (branch prefix, size threshold) from `source` at use time;
    /// without one the defaults apply.
    pub fn with_settings(mut self, source: Arc<dyn SettingsSource>) -> Self {
        self.settings = Some(source);
        self
    }

    pub(crate) async fn current_settings(&self) -> WorktreeSettings {
        match &self.settings {
            Some(source) => source.worktree_settings().await,
            None => WorktreeSettings::default(),
        }
    }

    pub fn ledger(&self) -> Arc<SnapshotLedger> {
        self.ledger.clone()
    }

    /// The id of the snapshot `holder` made in transaction `tx`.
    pub async fn snapshot_of(&self, holder: &str, tx: &str, cancel: &CancellationToken) -> Result<Option<String>, ScmFailure> {
        Ok(self.all(cancel).await?.into_iter().find(|r| {
            is_snapshot(r)
                && r.extra.get("txId").and_then(Value::as_str) == Some(tx)
                && r.extra.get("holderSessionId").and_then(Value::as_str) == Some(holder)
        }).map(|r| r.id))
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn scm(&self) -> &Arc<Scm> {
        &self.scm
    }

    pub(crate) async fn put_record(&self, cancel: &CancellationToken, record: WorktreeRecord) -> Result<(), ScmFailure> {
        self.put(cancel, record).await
    }

    pub(crate) async fn all_records(&self, cancel: &CancellationToken) -> Result<Vec<WorktreeRecord>, ScmFailure> {
        self.all(cancel).await
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }

    pub(crate) async fn with_registry<R: Send + 'static>(
        &self,
        cancel: &CancellationToken,
        job: impl FnOnce(&Registry) -> Result<R, ScmFailure> + Send + 'static,
    ) -> Result<R, ScmFailure> {
        let registry = self.registry.clone();
        on_lane(self.scm.lane, cancel, move || job(&registry)).await?
    }

    pub async fn record(&self, cancel: &CancellationToken, id: &str) -> Result<Option<WorktreeRecord>, ScmFailure> {
        let id = id.to_owned();
        self.with_registry(cancel, move |r| r.get(&id)).await
    }

    async fn put(&self, cancel: &CancellationToken, record: WorktreeRecord) -> Result<(), ScmFailure> {
        self.with_registry(cancel, move |r| r.put(record)).await
    }

    async fn all(&self, cancel: &CancellationToken) -> Result<Vec<WorktreeRecord>, ScmFailure> {
        self.with_registry(cancel, |r| Ok(r.read()?.into_values().collect())).await
    }

    /// Repository facts of `project`: `WORKTREE_PROJECT_UNKNOWN` when the folder is gone,
    /// `WORKTREE_UNSUPPORTED_REPO` for a non-repository, a bare one or one without a commit.
    pub async fn inspect_repo(&self, project: &Path, cancel: &CancellationToken) -> Result<RepoFacts, ScmFailure> {
        let project = &self.canonical_paths(vec![project.to_path_buf()], cancel).await?[0];
        let project_text = path_text(project);
        if !project.is_dir() {
            return Err(errors::project_unknown_text(project_text, "missing", "The project folder no longer exists."));
        }
        let repo = match self.scm.open(project, cancel).await {
            Ok(repo) => repo,
            Err(ScmFailure::NotARepository) => {
                return Err(errors::unsupported_repo_text(project_text, "The project folder is not a git repository."))
            }
            Err(other) => return Err(other),
        };
        let Ok(top_level) = repo.root().map(Path::to_path_buf) else {
            return Err(errors::unsupported_repo_text(project_text, "Bare repositories cannot host managed worktrees."));
        };
        let head = self
            .scm
            .git
            .outcome(cancel, &top_level, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], &RunOptions::default())
            .await?;
        if !head.success() {
            return Err(errors::unsupported_repo_text(project_text, "The repository has no commits yet; commit once first."));
        }
        let [top_level, common_dir]: [PathBuf; 2] = self
            .canonical_paths(vec![top_level, repo.identity.common_dir.clone()], cancel)
            .await?
            .try_into()
            .expect("two paths in, two out");
        Ok(RepoFacts {
            project_path: project.clone(),
            current_branch: self.scm.checked_out_branch(cancel, &top_level).await?,
            top_level,
            common_dir,
            head: head.stdout_text().trim().to_owned(),
        })
    }

    /// Node's `canonicalPath` for each path (git reports `C:/…`, short names and links; callers
    /// compare and key by these).
    async fn canonical_paths(&self, paths: Vec<PathBuf>, cancel: &CancellationToken) -> Result<Vec<PathBuf>, ScmFailure> {
        on_lane(self.scm.lane, cancel, move || paths.iter().map(|p| canonical_path(p)).collect()).await
    }

    pub async fn list_git_worktrees(&self, cwd: &Path, cancel: &CancellationToken) -> Result<Vec<GitWorktree>, ScmFailure> {
        let text = self.scm.git.read(cancel, cwd, &["worktree", "list", "--porcelain", "-z"]).await?;
        let mut rows = parse_worktree_list(&text);
        let real = self.canonical_paths(rows.iter().map(|r| PathBuf::from(&r.path)).collect(), cancel).await?;
        for (row, path) in rows.iter_mut().zip(real) {
            row.path = path_text(&path);
        }
        Ok(rows)
    }

    async fn local_branches(&self, cwd: &Path, cancel: &CancellationToken) -> Result<HashSet<String>, ScmFailure> {
        let text = self
            .scm
            .git
            .read(cancel, cwd, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
            .await?;
        Ok(text.lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()).collect())
    }

    /// A managed worktree on a (new or existing) branch, retained by `session_id`. Creation is
    /// recorded `creating` before git runs and `ready` after, so a failure leaves nothing a
    /// removal cannot roll back.
    pub async fn create(&self, request: CreateRequest, cancel: &CancellationToken) -> Result<WorktreeRecord, ScmFailure> {
        Ok(self.create_full(request, cancel).await?.record)
    }

    /// [`Worktrees::create`] with what creation did: the include summary the first turn tells
    /// the agent, and the fate of the project folder's uncommitted changes.
    pub async fn create_full(&self, request: CreateRequest, cancel: &CancellationToken) -> Result<Created, ScmFailure> {
        let facts = self.inspect_repo(&request.project_path, cancel).await?;
        let repo = self.scm.open(&facts.top_level, cancel).await?;
        let _lock = repo.lock_repository().await?;
        let common = path_text(&facts.common_dir);
        // A retried call (same transaction) returns the worktree it made.
        let tx = request.tx_id.clone();
        let session = request.session_id.clone();
        let all = self.all(cancel).await?;
        // The transaction's ready worktree retained by another session (`settleSessionAttempts`, manager.mjs:1387-1391: the record
        // with this `txId`, whatever its repository): a new task that was refused at another address after its worktree was made.
        if let Some(prior) = all.iter().find(|r| r.extra.get("txId").and_then(Value::as_str) == Some(tx.as_str()))
            && prior.state == "ready"
            && prior.owner_session_id.as_deref() != Some(session.as_str())
        {
            return Err(errors::transaction_of_another_session(tx));
        }
        let existing = all
            .into_iter()
            .find(|r| {
                r.repo_common_dir == common
                    && r.extra.get("txId").and_then(Value::as_str) == Some(tx.as_str())
                    && r.owner_session_id.as_deref() == Some(session.as_str())
            });
        if let Some(found) = existing {
            let prepared = found
                .extra
                .get("setup")
                .and_then(|s| s.get("prepared"))
                .cloned()
                .unwrap_or(Value::Null);
            return Ok(Created { record: found, prepared, changes: None });
        }
        if request.start_commit.is_some() && (request.existing_branch || request.branch.is_none()) {
            return Err(ScmFailure::invalid("startCommit", "a new exact branch only"));
        }
        if !matches!(request.carry.as_deref(), None | Some("ask" | "leave" | "carry")) {
            return Err(ScmFailure::invalid("carryChanges", "ask, leave or carry"));
        }
        let subdir = facts
            .project_path
            .strip_prefix(&facts.top_level)
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        // The project folder's uncommitted changes: a carry is judged by the same status read
        // that counts them; `ask` refuses while there are any.
        let pending = match request.carry.as_deref() {
            Some("carry") => self.assert_carryable(&facts.top_level, &subdir, cancel).await?,
            Some(_) => self.uncommitted_changes(&facts.top_level, &subdir, cancel).await?,
            None => Vec::new(),
        };
        if !pending.is_empty() && request.carry.as_deref() == Some("ask") {
            return Err(errors::dirty_choice(pending));
        }
        let base_commit = match (&request.start_commit, &request.base_branch) {
            (Some(commit), _) => commit.clone(),
            (None, Some(branch)) => self
                .scm
                .git
                .read(cancel, &facts.top_level, &["rev-parse", "--verify", &format!("refs/heads/{branch}^{{commit}}")])
                .await
                .map_err(|_| errors::missing(None, None, None))?
                .trim()
                .to_owned(),
            (None, None) => facts.head.clone(),
        };
        let settings = self.current_settings().await;
        let root = names::managed_root(&self.data_dir, &facts.common_dir);
        // The main checkout's local env files come along on their own; `.worktreeinclude`
        // applies on top. The estimate must fit before anything is made.
        let entries = {
            let file = facts.top_level.join(include::INCLUDE_FILE);
            let text = on_lane(self.scm.lane, cancel, move || match std::fs::read_to_string(file) {
                Ok(text) => Ok(text),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
                Err(error) => Err(ScmFailure::from(error)),
            })
            .await??;
            include::parse_include_entries(&text)?
        };
        let env_files = self.untracked_env_files(&facts.top_level, cancel).await?;
        let plan = self.plan_includes(&facts.top_level, &entries, env_files, cancel).await?;
        let (tracked, _needed) = self
            .assert_checkout_fits(
            &facts.top_level,
            &base_commit,
            plan.copy_bytes,
            &root,
            settings.size_warn_bytes,
            request.confirm_large,
            cancel,
        )
        .await?;
        let mut branches = self.local_branches(&facts.top_level, cancel).await?;
        let prefix = settings.branch_prefix.clone();
        // Reserve a name, then add the checkout; when another process took the branch or the folder
        // between the two, git refuses before making anything and the next free name is reserved
        // once (`manager.mjs:1771-1790`). A branch asked for by name is not retried (:1772).
        let mut attempt = 0;
        let (mut record, path) = loop {
            attempt += 1;
            // `x` is also taken while a branch `x/...` exists (the ref would be a directory).
            let taken = |name: &str| {
                let key = format!("{prefix}{name}").to_lowercase();
                branches.contains(&key) || branches.iter().any(|b| b.starts_with(&format!("{key}/")))
            };
            let ids: HashSet<String> = self.all(cancel).await?.into_iter().map(|r| r.id.to_lowercase()).collect();
            let slug = names::unique_slug(&names::slug_from_hint(&request.name_hint), |candidate| {
                ids.contains(&candidate.to_lowercase()) || taken(candidate) || root.join(candidate).exists()
            });
            let branch = request.branch.clone().unwrap_or_else(|| format!("{prefix}{slug}"));
            if !self.scm.git.succeeds(cancel, &facts.top_level, &["check-ref-format", "--branch", &branch]).await? {
                return Err(ScmFailure::coded(
                    errors::WORKTREE_UNSUPPORTED_REPO,
                    mixdog_protocol::DomainErrorDetail::WorktreeUnsupportedRepo {
                        project_path: Some(path_text(&facts.project_path)),
                        file: None,
                        line: None,
                        rel: None,
                        base_branch: None,
                        branch: Some(branch),
                    },
                ));
            }
            if request.branch.is_some() && !request.existing_branch && branches.contains(&branch.to_lowercase()) {
                return Err(errors::branch_occupied(branch, None, None, None));
            }
            let path = names::managed_path(&self.data_dir, &facts.common_dir, &slug);
            // A new checkout at this path: no size measured for an earlier one counts.
            self.sizes.forget(&path);
            let mut record = WorktreeRecord {
                id: slug.clone(),
                repo_common_dir: common.clone(),
                project_path: path_text(&facts.project_path),
                path: path_text(&path),
                branch: Some(branch.clone()),
                base_commit: Some(base_commit.clone()),
                created_at: now_ms(),
                owner_session_id: Some(request.session_id.clone()),
                state: "creating".into(),
                // An existing branch has no base it branched from: it merges where a merge first
                // takes it (recorded then).
                merge_target: if request.existing_branch {
                    None
                } else {
                    request.base_branch.clone().or_else(|| facts.current_branch.clone())
                },
                shared_session_ids: Vec::new(),
                extra: Default::default(),
            };
            record.extra.insert("txId".into(), json!(request.tx_id));
            record.extra.insert("existingBranch".into(), json!(request.existing_branch));
            record.extra.insert("exactBranch".into(), json!(request.branch.is_some()));
            record.extra.insert("projectSubdir".into(), json!(subdir));
            record.extra.insert("disposable".into(), json!(false));
            record.extra.insert(
                "warnings".into(),
                json!(tracked_warnings(&tracked).into_iter().chain(plan.warnings.clone()).collect::<Vec<_>>()),
            );
            record.extra.insert("resources".into(), json!({ "worktree": null, "lock": null, "owner": null, "includes": [] }));
            self.put(cancel, record.clone()).await?;
            let target = path_text(&path);
            let parent = root.clone();
            on_lane(self.scm.lane, cancel, move || std::fs::create_dir_all(parent)).await??;
            let args: Vec<&str> = if request.existing_branch {
                vec!["worktree", "add", &target, &branch]
            } else {
                vec!["worktree", "add", "-b", &branch, &target, &base_commit]
            };
            match self.scm.git.run(cancel, &facts.top_level, &args).await {
                Ok(_) => break (record, path),
                Err(failure) => {
                    let text = failure.to_string().to_lowercase();
                    if attempt == 1 && request.branch.is_none() && (text.contains("already exists") || text.contains("exists; cannot create")) {
                        branches.insert(branch.to_lowercase());
                        let id = record.id.clone();
                        if let Err(error) = self.with_registry(cancel, move |r| r.delete(&id)).await {
                            self.undo_failed_creation(&mut record, &[("worktree", "pending")], &error, cancel).await;
                            return Err(error);
                        }
                        continue;
                    }
                    // `failCreation`: the same rollback as any later failure (the checkout may be half
                    // made, and `-b` may have made the branch); the git failure is the one surfaced.
                    self.undo_failed_creation(&mut record, &[("worktree", "pending")], &failure, cancel).await;
                    return Err(failure);
                }
            }
        };
        let populated = self
            .populate_checkout(&mut record, &request, &facts, &subdir, &plan, &pending, &path, &base_commit, cancel)
            .await;
        match populated {
            Ok((prepared, changes, _carried)) => {
                repo.touched();
                Ok(Created { record, prepared, changes })
            }
            Err((failure, carried)) => {
                // Carried already: the changes go back to the project folder before the
                // worktree that holds them is rolled back (the recovery ref keeps them either way).
                if let Some(reference) = carried
                    && let Err(error) = self.restore_from_recovery_ref(&facts.top_level, &subdir, &reference, cancel).await
                {
                    // Node keeps this as `carryRestore` on the failure, which nothing reads.
                    tracing::warn!(id = %record.id, reference = %reference, "the carried changes were not put back: {error}");
                }
                self.undo_failed_creation(&mut record, &[("worktree", "created"), ("lock", "created"), ("owner", "created")], &failure, cancel).await;
                Err(failure)
            }
        }
    }

    /// `setResource`: one resource of the creation ledger, persisted.
    async fn set_resource(&self, record: &mut WorktreeRecord, key: &str, state: &str, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let mut resources = record.extra.get("resources").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
        resources[key] = json!(state);
        record.extra.insert("resources".into(), resources);
        self.put(cancel, record.clone()).await
    }

    /// `failCreation`'s rollback: the record goes through the ledger-proved `rollbackCreation`
    /// (`rollback_record`), never a forced removal of the branch: a branch that moved since the
    /// creation holds someone's commits and stays. Node writes `pending` before it makes a resource
    /// and `created` after; the resources named in `made` are the ones this failure may have made.
    /// The creation's own failure is the one surfaced, so what the rollback could not undo is
    /// logged (Node attaches it to that error as `rollback`, which nothing reads).
    async fn undo_failed_creation(&self, record: &mut WorktreeRecord, made: &[(&str, &str)], failure: &ScmFailure, cancel: &CancellationToken) {
        let mut resources = record.extra.get("resources").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
        for (key, state) in made {
            resources[*key] = json!(state);
        }
        record.extra.insert("resources".into(), resources);
        match self.rollback_record(record, Some(&failure.to_string()), cancel).await {
            Ok((true, _)) => {}
            Ok((false, remaining)) => tracing::warn!(id = %record.id, remaining = %json!(remaining), "a failed creation was not fully rolled back"),
            Err(error) => tracing::warn!(id = %record.id, "a failed creation was not rolled back: {error}"),
        }
    }

    /// Locks the fresh checkout, binds its owner lease, moves or leaves the project folder's
    /// changes and applies the includes. On failure the carried recovery ref (if any) comes
    /// back with the error so the caller can put the changes back.
    #[allow(clippy::too_many_arguments)]
    async fn populate_checkout(
        &self,
        record: &mut WorktreeRecord,
        request: &CreateRequest,
        facts: &RepoFacts,
        subdir: &str,
        plan: &include::IncludePlan,
        pending: &[String],
        path: &Path,
        base_commit: &str,
        cancel: &CancellationToken,
    ) -> Result<(Value, Option<Value>, Option<String>), (ScmFailure, Option<String>)> {
        let git = &self.scm.git;
        let target = path_text(path);
        let plain = |failure: ScmFailure| (failure, None);
        let reason = format!("mixdog session={}", request.session_id);
        git.run(cancel, &facts.project_path, &["worktree", "lock", "--reason", &reason, &target])
            .await
            .map_err(plain)?;
        if !request.runtime_token.trim().is_empty() {
            let owner = crate::worktree::ownership::Owner {
                session_id: request.session_id.clone(),
                runtime_token: request.runtime_token.clone(),
                pid: Some(std::process::id()),
            };
            self.write_owner_lease(record, &owner, cancel).await.map_err(plain)?;
        }
        // Carried before the include entries are copied, so an include never stands in the way
        // of a carried file; the status is read again inside, right before acting.
        let mut changes = (!pending.is_empty()).then(|| json!({ "mode": "left", "count": pending.len() }));
        let mut carried: Option<String> = None;
        if request.carry.as_deref() == Some("carry") {
            let label = record.id.clone();
            let (count, reference) = self
                .carry_uncommitted_changes(&facts.top_level, subdir, path, base_commit, &label, cancel)
                .await
                .map_err(plain)?;
            carried = reference.clone();
            // The recovery ref stays until the caller has committed the move or put the changes back.
            changes = (count > 0).then(|| json!({ "mode": "carried", "count": count, "recoveryRef": reference }));
        }
        // The include copies and links: the ledger is written `pending` before each resource is
        // made and `created` after, so a rollback knows what this transaction produced.
        let applied = if plan.items.is_empty() {
            Vec::new()
        } else {
            self.apply_includes_recorded(record, plan, path, cancel)
                .await
                .map_err(|failure| (failure, carried.clone()))?
        };
        let mut warnings: Vec<String> = record
            .extra
            .get("warnings")
            .and_then(|w| serde_json::from_value(w.clone()).ok())
            .unwrap_or_default();
        warnings.extend(applied.iter().cloned());
        record.extra.insert("warnings".into(), json!(warnings));
        let made: Vec<include::IncludeItem> = include::ledger_of(record).into_iter().filter(|i| i.status == "created").collect();
        let rels = |mode: &str| made.iter().filter(|i| i.mode == mode).map(|i| i.rel.clone()).collect::<Vec<_>>();
        let prepared = json!({
            "root": path_text(&facts.top_level),
            "copied": rels("copy"),
            "linked": rels("link"),
            "skipped": plan.warnings.iter().chain(applied.iter()).collect::<Vec<_>>(),
        });
        // Whichever path made it, the first turn a session runs here installs its dependencies
        // in the worktree folder (the setup claim).
        record.extra.insert("setup".into(), json!({ "pending": true, "prepared": prepared }));
        record.state = "ready".into();
        self.put(cancel, record.clone())
            .await
            .map_err(|failure| (failure, carried.clone()))?;
        Ok((prepared, changes, carried))
    }

    /// A read-only detached checkout of `commit`, held by `holder` and removed with its turn. The
    /// holder's runtime is this process's worker-snapshot runtime (`worker-snapshots.mjs state()`).
    pub async fn snapshot(
        &self,
        project: &Path,
        holder: &str,
        commit: &str,
        tx_id: &str,
        confirm_large: bool,
        cancel: &CancellationToken,
    ) -> Result<WorktreeRecord, ScmFailure> {
        let owner = Owner { session_id: holder.to_owned(), runtime_token: process_runtime_token().to_owned(), pid: Some(std::process::id()) };
        self.snapshot_held(project, &owner, commit, tx_id, confirm_large, cancel).await
    }

    /// [`Self::snapshot`] for a holder with its own runtime (`createSnapshotWorktree`,
    /// `manager.mjs:1846-1940`): the checkout is locked with `mixdog snapshot session=<holder>` and
    /// the holder's owner lease is written, the record carrying the resources ledger a rollback
    /// reads (`worktree`, `lock`, `owner`: `pending` before each is made, `created` after).
    pub async fn snapshot_held(
        &self,
        project: &Path,
        holder: &Owner,
        commit: &str,
        tx_id: &str,
        confirm_large: bool,
        cancel: &CancellationToken,
    ) -> Result<WorktreeRecord, ScmFailure> {
        holder.validate()?;
        let holder_id = holder.session_id.as_str();
        let facts = self.inspect_repo(project, cancel).await?;
        let repo = self.scm.open(&facts.top_level, cancel).await?;
        let _lock = repo.lock_repository().await?;
        let common = path_text(&facts.common_dir);
        if let Some(found) = self.all(cancel).await?.into_iter().find(|r| {
            r.repo_common_dir == common
                && is_snapshot(r)
                && r.extra.get("txId").and_then(Value::as_str) == Some(tx_id)
                && r.extra.get("holderSessionId").and_then(Value::as_str) == Some(holder_id)
        }) {
            return Ok(found);
        }
        let ids: HashSet<String> = self.all(cancel).await?.into_iter().map(|r| r.id.to_lowercase()).collect();
        let root = names::managed_root(&self.data_dir, &facts.common_dir);
        // The same size preflight as a branch worktree, before anything is made.
        let settings = self.current_settings().await;
        self.assert_checkout_fits(&facts.top_level, commit, 0, &root, settings.size_warn_bytes, confirm_large, cancel)
            .await?;
        let slug = names::unique_slug("snapshot", |c| ids.contains(&c.to_lowercase()) || root.join(c).exists());
        let path = names::managed_path(&self.data_dir, &facts.common_dir, &slug);
        let mut record = WorktreeRecord {
            id: slug,
            repo_common_dir: common,
            project_path: path_text(&facts.project_path),
            path: path_text(&path),
            branch: None,
            base_commit: Some(commit.to_owned()),
            created_at: now_ms(),
            owner_session_id: None,
            state: "creating".into(),
            merge_target: None,
            shared_session_ids: Vec::new(),
            extra: Default::default(),
        };
        record.extra.insert("kind".into(), json!("snapshot"));
        record.extra.insert("holderSessionId".into(), json!(holder_id));
        record.extra.insert("txId".into(), json!(tx_id));
        // No branch of its own: nothing is ever deleted from refs/heads.
        record.extra.insert("existingBranch".into(), json!(true));
        record.extra.insert("exactBranch".into(), json!(false));
        record.extra.insert("disposable".into(), json!(true));
        record.extra.insert("resources".into(), json!({ "worktree": null, "lock": null, "owner": null, "includes": [] }));
        self.put(cancel, record.clone()).await?;
        let parent = root.clone();
        on_lane(self.scm.lane, cancel, move || std::fs::create_dir_all(parent)).await??;
        let target = path_text(&path);
        let made: Result<(), ScmFailure> = async {
            self.set_resource(&mut record, "worktree", "pending", cancel).await?;
            self.scm.git.run(cancel, &facts.top_level, &["worktree", "add", "--detach", &target, commit]).await?;
            self.set_resource(&mut record, "worktree", "created", cancel).await?;
            self.set_resource(&mut record, "lock", "pending", cancel).await?;
            let reason = format!("mixdog snapshot session={holder_id}");
            self.scm.git.run(cancel, &facts.project_path, &["worktree", "lock", "--reason", &reason, &target]).await?;
            self.set_resource(&mut record, "lock", "created", cancel).await?;
            self.set_resource(&mut record, "owner", "pending", cancel).await?;
            self.write_owner_lease(&record, holder, cancel).await?;
            self.set_resource(&mut record, "owner", "created", cancel).await?;
            record.state = "ready".into();
            self.put(cancel, record.clone()).await
        }
        .await;
        if let Err(failure) = made {
            // `rollbackCreation` over the ledger as far as it got; the creation's failure is the one surfaced.
            self.undo_failed_creation(&mut record, &[], &failure, cancel).await;
            return Err(failure);
        }
        self.ledger.register(&record.id, &path);
        Ok(record)
    }

    /// Managed worktrees (optionally of one repository) with who keeps them.
    pub async fn list(
        &self,
        repo_common_dir: Option<&Path>,
        retention: &dyn Retention,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>, ScmFailure> {
        let scope = repo_common_dir.map(path_key);
        let mut rows = Vec::new();
        for record in self.all(cancel).await? {
            if scope.as_ref().is_some_and(|s| *s != path_key(Path::new(&record.repo_common_dir))) {
                continue;
            }
            let live = retention.owner_live(&record);
            let removable = record.state == "ready"
                && !live
                && (!retention.retained(&record) || record.extra.get("disposable") == Some(&Value::Bool(true)));
            let mut row = entry_json(&record);
            row["ownerLive"] = json!(live);
            row["removable"] = json!(removable);
            rows.push(row);
        }
        Ok(rows)
    }

    pub(crate) fn assert_not_shared(record: &WorktreeRecord, session: Option<&str>) -> Result<(), ScmFailure> {
        let mut others: Vec<String> = record.shared_session_ids.clone();
        others.extend(record.owner_session_id.clone());
        others.retain(|id| Some(id.as_str()) != session);
        others.sort();
        others.dedup();
        if others.is_empty() {
            Ok(())
        } else {
            Err(errors::shared_by_others(others))
        }
    }

    /// `WORKTREE_DIRTY` / `WORKTREE_UNMERGED` that a ready worktree's removal would refuse.
    pub(crate) async fn assert_removable(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let path = PathBuf::from(&record.path);
        // A merge, rebase, pick, revert or bisect may hold work that neither the files nor HEAD
        // show yet.
        if path.exists() {
            if let Ok(identity) = self.scm.open(&path, cancel).await {
                if operation_in_progress(&identity.identity.git_dir).is_some() {
                    return Err(errors::dirty(Some(record.id.clone()), None, None, None));
                }
            }
        }
        let dirty = self.dirty_paths(record, cancel).await?;
        if !dirty.is_empty() {
            return Err(errors::dirty_files(record.id.clone(), dirty));
        }
        let unmerged = self.checkout_unmerged_count(record, cancel).await?;
        if unmerged > 0 {
            return Err(errors::unmerged_commits(
                record.id.clone(),
                record.branch.clone(),
                record.merge_target.clone(),
                unmerged,
            ));
        }
        Ok(())
    }

    /// The folder must be a registered git worktree inside the managed store.
    pub(crate) async fn assert_managed_path(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let path = Path::new(&record.path);
        let root = names::managed_root(&self.data_dir, Path::new(&record.repo_common_dir));
        let inside = path_key(path).starts_with(&format!("{}/", path_key(&root)));
        let registered = self
            .list_git_worktrees(Path::new(&record.project_path), cancel)
            .await
            .map(|rows| rows.iter().any(|row| path_key(Path::new(&row.path)) == path_key(path)))
            .unwrap_or(false);
        // `assertManagedCheckoutPath`: a folder without its `.git` link (a checkout git never made,
        // or one half removed) passes after a recorded attempt (a removal tried, a rollback begun)
        // or while empty.
        let unlinked = path.join(".git").symlink_metadata().is_err() && {
            let truthy = |value: Option<&Value>| value.is_some_and(|v| !v.is_null() && v != &json!(false) && v != &json!(0) && v != &json!(""));
            let attempted = truthy(record.extra.get("deleting").and_then(|deleting| deleting.get("lastAttemptAt")))
                || truthy(record.extra.get("recovery").and_then(|recovery| recovery.get("remaining")))
                || record.state == "recovery";
            attempted || std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
        };
        if inside && (registered || !path.exists() || unlinked) {
            Ok(())
        } else {
            Err(errors::path_unsafe(record.id.clone(), record.path.clone(), None))
        }
    }

    /// `assertWorktreeRemovable`: the refusal a removal would raise, checked before anything
    /// moves. An unknown entry is `WORKTREE_MISSING`; another session's reference and retained
    /// recovery records refuse whatever `force` is; only a ready entry has a checkout to check,
    /// and dirty or unmerged work in it needs `force`. `session_id` is the session asking (the
    /// owner when none).
    pub async fn assert_worktree_removable(
        &self,
        entry_id: &str,
        force: bool,
        session_id: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<(), ScmFailure> {
        let mut record = self
            .record(cancel, entry_id)
            .await?
            .ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        record.branch = self.checked_out_branch_of(&record, cancel).await?;
        Self::assert_not_shared(&record, session_id.or(record.owner_session_id.as_deref()))?;
        self.assert_recovery_stores_clear(&record, cancel).await?;
        if record.state != "ready" {
            return Ok(());
        }
        self.assert_managed_path(&record, cancel).await?;
        if force {
            return Ok(());
        }
        self.assert_removable(&record, cancel).await
    }

    /// Removes a managed worktree. Dirty or unmerged work needs `force`; the branch goes with it
    /// once git considers it merged.
    pub async fn remove(
        &self,
        entry_id: &str,
        force: bool,
        session_id: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let request = crate::worktree::removal::RemoveRequest {
            entry_id: entry_id.to_owned(),
            force,
            session_id: session_id.map(str::to_owned),
            ..Default::default()
        };
        self.remove_managed(request, cancel).await
    }

    /// Removes the managed worktree at `path` (`git worktree remove <path>`).
    pub async fn remove_by_path(
        &self,
        path: &Path,
        force: bool,
        session_id: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let wanted = path_key(path);
        let record = self
            .all(cancel)
            .await?
            .into_iter()
            .find(|r| path_key(Path::new(&r.path)) == wanted)
            .ok_or_else(|| errors::path_unsafe(String::new(), path_text(path), Some("not-managed")))?;
        self.remove(&record.id, force, session_id, cancel).await
    }

    /// Removes what no session keeps: clean, merged, unretained worktrees of the repository
    /// (every repository with `None`). `dry_run` only names them.
    pub async fn prune(
        &self,
        repo_common_dir: Option<&Path>,
        retention: &dyn Retention,
        dry_run: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let rows = self.list(repo_common_dir, retention, cancel).await?;
        let removable: Vec<Value> = rows.into_iter().filter(|row| row["removable"] == true).collect();
        if dry_run {
            return Ok(json!({ "dryRun": true, "wouldRemove": removable }));
        }
        let (mut removed, mut kept) = (Vec::new(), Vec::new());
        for row in removable {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            match self.remove(&id, false, row["ownerSessionId"].as_str(), cancel).await {
                Ok(_) => removed.push(json!(id)),
                Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
                Err(failure) => kept.push(json!({ "id": id, "code": failure.code() })),
            }
        }
        Ok(json!({ "removed": removed, "kept": kept }))
    }

    /// Merges the worktree's branch into the project folder's branch; the target is remembered
    /// on the record so a later removal checks against it.
    pub async fn merge(
        &self,
        entry_id: &str,
        target: Option<&str>,
        confirmed: bool,
        cancel: &CancellationToken,
    ) -> Result<MergeResult, ScmFailure> {
        let record = self
            .record(cancel, entry_id)
            .await?
            .ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        let Some(branch) = record.branch.clone() else {
            return Err(errors::missing(Some(entry_id.to_owned()), None, None));
        };
        let project = PathBuf::from(&record.project_path);
        let repo: Repo = self.scm.open(&project, cancel).await?;
        let _lock = repo.lock_repository().await?;
        let source = PathBuf::from(&record.path);
        let operation = self.scm.open(&source, cancel).await.ok().and_then(|r| operation_in_progress(&r.identity.git_dir));
        let dirty = self.scm.uncommitted_paths(cancel, &source).await?;
        if operation.is_some() || !dirty.is_empty() {
            return Err(errors::dirty(
                Some(record.id.clone()),
                operation.map(|o| operation_verb(o).to_owned()),
                Some(dirty.len() as u64),
                None,
            ));
        }
        let merged = self
            .scm
            .merge_branch_into_checkout(cancel, &project, &branch, target, confirmed, None)
            .await?;
        if merged.merged {
            let mut current = self.record(cancel, entry_id).await?.unwrap_or(record);
            if current.merge_target.as_deref() != Some(merged.target.as_str()) {
                current.merge_target = Some(merged.target.clone());
                self.put(cancel, current).await?;
            }
        }
        repo.touched();
        Ok(merged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Named(&'static str);

    #[async_trait::async_trait]
    impl crate::worktree::removal::RootCleanup for Named {
        fn name(&self) -> &str {
            self.0
        }

        async fn run(&self, _root: &Path, _entry_id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn a_root_cleanup_given_twice_runs_once_and_another_still_joins_it() {
        let scm = crate::engine::Scm::new(
            crate::testing::TestProcesses::shared(),
            mixdog_rt::testing::tokens().maintenance_io,
            std::env::temp_dir(),
        );
        let same: Arc<dyn crate::worktree::removal::RootCleanup> = Arc::new(Named("same"));
        let other: Arc<dyn crate::worktree::removal::RootCleanup> = Arc::new(Named("other"));
        let worktrees = Worktrees::new(scm, std::env::temp_dir())
            .with_root_cleanup(same.clone())
            .with_root_cleanup(same.clone())
            .with_root_cleanup(other);
        let names: Vec<&str> = worktrees.cleanups().iter().map(|cleanup| cleanup.name()).collect();
        assert_eq!(names, ["same", "other"]);
    }

    #[test]
    fn the_porcelain_list_names_branch_detached_and_prunable_rows() {
        let rows = parse_worktree_list(
            "worktree /r\0HEAD aaa\0branch refs/heads/main\0\0worktree /w/x\0HEAD bbb\0detached\0prunable gitdir file points to non-existent location\0\0",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].branch.as_deref(), Some("main"));
        assert!(rows[1].detached && rows[1].prunable);
    }
}
