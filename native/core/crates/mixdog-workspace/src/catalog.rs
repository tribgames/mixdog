#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible)")]
//! The project registry (DS §4.1): the `projects` rows of the core state store, the only registry the core reads or writes (a Node
//! profile's `projects.json` joins them once, [`Catalog::import_registry`]). Every
//! root-taking method resolves its root here, so a path outside the registry is refused
//! (`permissionDenied`). A registry change and its op record commit in one store
//! transaction (SPEC R30).

use std::path::Path;
use std::path::PathBuf;

use mixdog_store::registry::ProjectEntry;
use mixdog_store::registry::Registry;
use mixdog_store::registry::ensure_project_id_marker;
use mixdog_store::state::CoreState;
use mixdog_store::state::OpRow;
use mixdog_store::state::OpRowState;
use mixdog_store::state::ProjectRow;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::lanes::Lanes;
use crate::lanes::run_fallible;
use crate::lanes::run_in;
use crate::pathguard::project_path;
use crate::pathguard::canonical;
use crate::pathguard::comparable;

/// The op record that commits with a registry change.
#[derive(Clone)]
pub struct OpRecord {
    pub scope: String,
    pub op_id: String,
    pub row: OpRow,
}

pub struct Catalog {
    state: CoreState,
    lanes: Lanes,
}

fn store(error: mixdog_store::sqlite::DbError) -> WsError {
    WsError::new(Reason::Io, error.to_string())
}

/// Node's `canonicalDirectory`: the real path of `requested`, which must be a folder. `given` is the path as the caller
/// wrote it, which is what Node's `ENOENT: ... realpath '<path>'` names.
pub fn canonical_directory(requested: &Path, given: &str) -> WsResult<PathBuf> {
    let real = canonical(requested).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound { WsError::new(Reason::PathMissing, given) } else { error.into() }
    })?;
    if real.is_dir() { Ok(real) } else { Err(WsError::new(Reason::NotADirectory, "Session workspace is not a directory.")) }
}

/// The wire shape of a project: its display name is the alias, else the folder name.
pub fn project_json(row: &ProjectRow) -> Value {
    json!({
        "path": row.path,
        "name": display_name(row),
        "alias": row.alias,
        "hidden": row.hidden,
        "lastUsedAt": row.last_used_at,
    })
}

fn folder_name(path: &str) -> String {
    Path::new(path).file_name().map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// The registry name Node lists a project under; a row without one (v1 or imported) is listed under its alias, else its folder.
pub fn display_name(row: &ProjectRow) -> String {
    row.name.clone().filter(|n| !n.is_empty()).or_else(|| row.alias.clone().filter(|a| !a.is_empty())).unwrap_or_else(|| folder_name(&row.path))
}

/// The registry's clock: the same one the editor backups read, so a debug build pinned by `MIXDOG_FIXED_NOW_MS` stamps rows on the
/// virtual clock the Node recording ran on (a release build reads the system clock).
pub fn now_ms() -> i64 {
    crate::editorcfg::now_ms()
}

/// The `meta` row that says `projects.json` was imported into the `projects` rows (the one-time step of [`Catalog::import_registry`]).
pub const REGISTRY_IMPORTED: &str = "import:projects.json";

/// Node's `normalizedProjectKey`: the resolved path without trailing separators, lowercase on Windows.
fn project_key(path: &str) -> String {
    let resolved = project_path(path).map_or_else(|| path.to_owned(), |p| p.to_string_lossy().into_owned());
    let trimmed = resolved.trim_end_matches(['/', '\\']);
    if cfg!(windows) { trimmed.to_lowercase() } else { trimmed.to_owned() }
}

/// `entry`'s recency as `compareProjects` reads it (`projectRecency`): the last selection, else when it was added.
fn recency(entry: &ProjectEntry) -> Option<i64> {
    let positive = |n: &serde_json::Number| n.as_f64().filter(|v| *v > 0.0).map(|v| v as i64);
    entry.last_selected_at.as_ref().and_then(positive).or_else(|| positive(&entry.added_at))
}

/// The rows after the registry `entries` joined the rows `rows`, as the rows to write and the paths to delete. The registry decides what is
/// listed (as in the desktop): a registered path is a visible row of the registry's spelling and name, keeping its alias and a later
/// recency; a row that only holds a preference of a path the registry does not have (no recency: the migration made it from
/// `desktop-projects.json`) becomes a tombstone, which keeps the alias and lists nothing.
fn joined(rows: Vec<ProjectRow>, entries: &[ProjectEntry]) -> (Vec<ProjectRow>, Vec<String>) {
    let (mut puts, mut deletes, mut matched) = (Vec::new(), Vec::new(), std::collections::HashSet::new());
    for entry in entries {
        let key = project_key(&entry.path);
        if !matched.insert(key.clone()) {
            continue;
        }
        let row = match rows.iter().find(|r| project_key(&r.path) == key) {
            Some(old) => {
                if old.path != entry.path {
                    deletes.push(old.path.clone());
                }
                // A Rust-made name (a rename after the cut) stays; a tombstone's or an imported row's is the registry's.
                let kept = if old.hidden { None } else { old.name.clone() };
                let name = kept.or_else(|| Some(entry.name.clone()));
                let last_used_at = [old.last_used_at, recency(entry)].into_iter().flatten().max();
                // The desktop lists an alias trimmed, and none for a blank one (`projectAlias`).
                let alias = old.alias.as_deref().map(mixdog_js::js_trim).filter(|alias| !alias.is_empty()).map(str::to_owned);
                ProjectRow { path: entry.path.clone(), alias, hidden: false, hidden_rank: None, last_used_at, name }
            }
            None => ProjectRow { path: entry.path.clone(), alias: None, hidden: false, hidden_rank: None, last_used_at: recency(entry), name: Some(entry.name.clone()) },
        };
        puts.push(row);
    }
    let mut rank = rows.iter().filter_map(|r| r.hidden_rank).max().unwrap_or(-1);
    for old in rows.iter().filter(|r| !r.hidden && r.last_used_at.is_none() && !matched.contains(&project_key(&r.path))) {
        rank += 1;
        puts.push(ProjectRow { hidden: true, hidden_rank: Some(rank), ..old.clone() });
    }
    (puts, deletes)
}

fn finish(mut op: OpRecord, outcome: &Value) -> OpRecord {
    op.row.state = OpRowState::Applied;
    op.row.outcome = Some(outcome.to_string());
    op.row.completed_at = Some(now_ms());
    op
}

impl Catalog {
    pub fn new(state: CoreState, lanes: Lanes) -> Self {
        Self { state, lanes }
    }

    /// The one-time step that makes the `projects` rows the registry of a profile that came from Node: `<home>/projects.json` (Node's registry,
    /// the list `list` must answer) joins the rows the migration made from `desktop-projects.json` ([`joined`]). It commits with the
    /// [`REGISTRY_IMPORTED`] row, so it runs once whatever happens to the file afterwards, and no reader opens the file again. No
    /// `projects.json` is an empty registry; an unreadable one fails and the step stays open. Answers whether it ran now.
    pub async fn import_registry(&self, home: &Path) -> WsResult<bool> {
        if self.state.meta(REGISTRY_IMPORTED).await.map_err(store)?.is_some() {
            return Ok(false);
        }
        let file = home.join("projects.json");
        let registry = Registry::new(file.clone());
        let read = run_in(self.lanes.durability, &CancellationToken::new(), move |lane| if file.exists() { registry.list_strict(lane) } else { Ok(Vec::new()) }).await?;
        let entries = read.map_err(|error| WsError::new(Reason::Io, error.to_string()))?;
        let (puts, deletes) = joined(self.state.projects().await.map_err(store)?, &entries);
        self.state
            .write(move |tx| {
                for path in &deletes {
                    tx.delete_project(path)?;
                }
                for row in &puts {
                    tx.put_project(row)?;
                }
                tx.put_meta(REGISTRY_IMPORTED, "1")
            })
            .await
            .map_err(store)?;
        Ok(true)
    }

    pub async fn list(&self) -> WsResult<Vec<ProjectRow>> {
        let rows = self.state.projects().await.map_err(store)?;
        // A hidden row is the legacy tombstone of a removed project (Node's `hidden` list of desktop-projects.json): it keeps the alias
        // and is no registered project, as `list` and `known` of desktop-project-registry.ts read the registry and never the tombstones.
        let mut rows: Vec<ProjectRow> = rows.into_iter().filter(|p| !p.hidden && Path::new(&p.path).is_absolute()).collect();
        // Node's `compareProjects`: most recently selected first (a project never selected counts by when it was added, which is when
        // its row was made: `add` stamps it), then by name, then by path.
        rows.sort_by(|a, b| {
            b.last_used_at.unwrap_or(0).cmp(&a.last_used_at.unwrap_or(0)).then_with(|| mixdog_js::locale_compare(&display_name(a), &display_name(b))).then_with(|| mixdog_js::locale_compare(&a.path, &b.path))
        });
        Ok(rows)
    }

    /// The registered project at `path`, or `permissionDenied`.
    pub async fn resolve(&self, path: &str) -> WsResult<PathBuf> {
        let requested = project_path(path).ok_or_else(|| WsError::coded("PROJECT_UNAVAILABLE", "Project is not available."))?;
        self.list()
            .await?
            .iter()
            .find(|p| comparable(Path::new(&p.path)) == comparable(&requested))
            .map(|p| PathBuf::from(&p.path))
            .ok_or_else(|| WsError::coded("PROJECT_UNAVAILABLE", "Project is not available."))
    }

    async fn find(&self, path: &str) -> WsResult<ProjectRow> {
        let resolved = self.resolve(path).await?;
        self.list()
            .await?
            .into_iter()
            .find(|p| comparable(Path::new(&p.path)) == comparable(&resolved))
            .ok_or_else(|| WsError::coded("PROJECT_UNAVAILABLE", "Project is not available."))
    }

    async fn commit(&self, row: Option<ProjectRow>, delete: Option<String>, op: Option<OpRecord>) -> WsResult<()> {
        self.state
            .write(move |tx| {
                if let Some(row) = &row {
                    tx.put_project(row)?;
                }
                if let Some(path) = &delete {
                    tx.delete_project(path)?;
                }
                if let Some(op) = &op {
                    tx.put_op(&op.scope, &op.op_id, &op.row)?;
                }
                Ok(())
            })
            .await
            .map_err(store)
    }

    /// `ensureProjectIdMarker` for the project's current name, after its registry change
    /// committed: memory classification reads only this marker. Best effort, as in Node.
    async fn write_marker(&self, row: &ProjectRow, cancel: &CancellationToken) {
        let (path, name) = (row.path.clone(), display_name(row));
        let _ = run_in(self.lanes.durability, cancel, move |lane| ensure_project_id_marker(lane, &path, &name)).await;
    }

    pub async fn add(&self, path: &str, cancel: &CancellationToken, op: Option<OpRecord>) -> WsResult<Value> {
        // `addProject` (remote-methods.ts:922) trims the argument and `realpath`s it as written: a relative path is the working
        // directory's, a rooted one the current drive's, and `..` is the file system's.
        let given = mixdog_js::js_trim(path).to_owned();
        if given.is_empty() || mixdog_js::utf16_len(&given) > 32_768 {
            return Err(WsError::invalid("projectPath is invalid."));
        }
        let requested = PathBuf::from(&given);
        let folder = run_fallible(self.lanes.interactive, cancel, move || canonical_directory(&requested, &given)).await?;
        let path = folder.to_string_lossy().into_owned();
        // A row's recency starts at its making: Node orders a never-selected project by when it was added (`projectRecency`,
        // projects.mjs:121-126), and two projects of one millisecond tie and order by name, then path (`compareProjects`, :128-134).
        let row = match self.state.project(&path).await.map_err(store)? {
            // Node's `enter` and `register` both undo the legacy hidden tombstone (`unhide`) of the Project they register.
            // A tombstoned project is made again: Node's store gets a fresh entry (`addedAt` now) while the alias of the preferences stays.
            // The registry name starts over as the folder's, while the alias of the preferences stays (Node's two stores).
            Some(existing) if existing.hidden => {
                ProjectRow { hidden: false, hidden_rank: None, last_used_at: Some(now_ms()), name: Some(folder_name(&existing.path)), ..existing }
            }
            Some(existing) => ProjectRow { hidden: false, hidden_rank: None, ..existing },
            None => ProjectRow { name: Some(folder_name(&path)), path, alias: None, hidden: false, hidden_rank: None, last_used_at: Some(now_ms()) },
        };
        let out = project_json(&row);
        self.commit(Some(row.clone()), None, op.map(|o| finish(o, &out))).await?;
        self.write_marker(&row, cancel).await;
        Ok(out)
    }

    pub async fn touch(&self, path: &str, op: Option<OpRecord>) -> WsResult<Value> {
        let mut row = self.find(path).await?;
        row.last_used_at = Some(now_ms());
        let out = project_json(&row);
        self.commit(Some(row.clone()), None, op.map(|o| finish(o, &out))).await?;
        self.write_marker(&row, &CancellationToken::new()).await;
        Ok(out)
    }

    pub async fn rename(&self, path: &str, alias: &str, op: Option<OpRecord>) -> WsResult<Value> {
        let mut row = self.find(path).await?;
        let trimmed = alias.trim();
        row.alias = (!trimmed.is_empty()).then(|| trimmed.to_owned());
        row.name = row.alias.clone();
        let out = project_json(&row);
        self.commit(Some(row), None, op.map(|o| finish(o, &out))).await?;
        Ok(out)
    }

    pub async fn remove(&self, path: &str, op: Option<OpRecord>) -> WsResult<Value> {
        let resolved = self.resolve(path).await.ok();
        let out = json!({ "removed": resolved.is_some() });
        // Node's `remove` puts the path first in `hidden` (desktop-project-registry.ts:116); hidden rows run in the order of that list.
        let tombstone = match resolved {
            Some(path) => {
                let path = path.to_string_lossy().into_owned();
                let front = self.state.projects().await.map_err(store)?.iter().filter(|p| p.hidden).filter_map(|p| p.hidden_rank).min();
                self.state.project(&path).await.map_err(store)?.map(|row| ProjectRow { hidden: true, hidden_rank: Some(front.map_or(0, |rank| rank - 1)), ..row })
            }
            None => None,
        };
        self.commit(tombstone, None, op.map(|o| finish(o, &out))).await?;
        Ok(out)
    }

    /// Creates the folder (for a new project) and returns the absolute path it was resolved to, as spelled: Node's `ensureDir`
    /// (projects.mjs:239) answers its `resolve`d path, not the real one, and any failure to make the folder is one message.
    pub async fn ensure_directory(&self, path: &str, cancel: &CancellationToken) -> WsResult<PathBuf> {
        let requested = project_path(path).ok_or_else(|| WsError::invalid("project path is required"))?;
        run_fallible(self.lanes.durability, cancel, move || {
            std::fs::create_dir_all(&requested).map_err(|_| WsError::new(Reason::Io, "project directory could not be created"))?;
            Ok(requested)
        })
        .await
    }
}
