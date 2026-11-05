//! The first turn a session runs in a managed worktree claims its dependency preparation once
//! (Node `claimWorktreeSetup`), and detaches the dependency links an earlier version recorded
//! at creation: a reset (`npm ci`) through such a link would empty the main checkout's
//! `node_modules`.

use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::repo::on_lane;
use crate::worktree::dependencies::linked_artefacts;
use crate::worktree::include;
use crate::worktree::include::IncludeItem;
use crate::worktree::manager::Worktrees;
use crate::worktree::registry::WorktreeRecord;

/// `{ prepared, blocked }` or `{ prepared, shared }` of Node's claim.
#[derive(Clone, Debug, PartialEq)]
pub struct SetupClaim {
    /// What creation did, while the setup was pending; otherwise `None`.
    pub prepared: Option<Value>,
    /// Links an install could reach through; nothing is installed while any exists.
    pub blocked: Vec<String>,
    /// Links the user asked for in `.worktreeinclude`, which the planner leaves alone.
    pub shared: Vec<String>,
}

fn is_dependency_link(item: &IncludeItem) -> bool {
    item.mode == "link" && item.dependency
}

fn setup_pending(record: &WorktreeRecord) -> bool {
    record.extra.get("setup").and_then(|s| s.get("pending")) == Some(&Value::Bool(true))
}

fn subdir_of(record: &WorktreeRecord) -> String {
    record.extra.get("projectSubdir").and_then(Value::as_str).unwrap_or("").to_owned()
}

fn session_root(record: &WorktreeRecord) -> PathBuf {
    let subdir = subdir_of(record);
    subdir.split('/').filter(|s| !s.is_empty()).fold(PathBuf::from(&record.path), |p, s| p.join(s))
}

fn set_ledger(record: &mut WorktreeRecord, items: &[IncludeItem]) {
    let value = serde_json::to_value(items).unwrap_or(Value::Null);
    let resources = record.extra.entry("resources").or_insert_with(|| json!({}));
    if let Some(map) = resources.as_object_mut() {
        map.insert("includes".into(), value);
    }
}

fn set_setup(record: &mut WorktreeRecord, pending: bool, claimed_at: Option<u64>) {
    let mut setup = record.extra.get("setup").and_then(Value::as_object).cloned().unwrap_or_default();
    setup.insert("pending".into(), json!(pending));
    if let Some(at) = claimed_at {
        setup.insert("claimedAt".into(), json!(at));
    }
    record.extra.insert("setup".into(), Value::Object(setup));
}

impl Worktrees {
    /// The claim of `entry_id`'s dependency preparation, or `None` when there is nothing to
    /// claim. Claimed before it runs, so a failed or cancelled preparation is never repeated.
    pub async fn claim_setup(&self, entry_id: &str, cancel: &CancellationToken) -> Result<Option<SetupClaim>, ScmFailure> {
        let Some(record) = self.record(cancel, entry_id).await? else { return Ok(None) };
        if !setup_pending(&record) && !include::ledger_of(&record).iter().any(is_dependency_link) {
            return Ok(None);
        }
        let repo = self.scm().open(Path::new(&record.project_path), cancel).await?;
        let _lock = repo.lock_repository().await?;
        let Some(mut current) = self.record(cancel, entry_id).await? else { return Ok(None) };
        if current.state != "ready" {
            return Ok(None);
        }
        let pending = setup_pending(&current);
        // Unlink (never empty) the recorded dependency links; one that cannot be unlinked
        // stays recorded, so removal still unlinks it first and every install is blocked.
        let mut ledger = include::ledger_of(&current);
        let links: Vec<IncludeItem> = ledger.iter().filter(|i| is_dependency_link(i)).cloned().collect();
        let mut detached = false;
        if !links.is_empty() {
            let doomed = links.clone();
            let stuck = on_lane(self.scm().lane, cancel, move || include::remove_include_links(&doomed)).await?;
            ledger.retain(|item| !is_dependency_link(item) || stuck.contains(&item.path));
            set_ledger(&mut current, &ledger);
            detached = stuck.len() < links.len();
        }
        let mut blocked: Vec<String> = ledger.iter().filter(|i| is_dependency_link(i)).map(|i| i.rel.clone()).collect();
        if blocked.is_empty() && !pending && !detached {
            return Ok(None);
        }
        let mut shared = Vec::new();
        if blocked.is_empty() {
            let asked: Vec<&str> = ledger
                .iter()
                .filter(|i| i.mode == "link" && i.status == "created" && !i.dependency)
                .map(|i| i.rel.as_str())
                .collect();
            let subdir = subdir_of(&current);
            for rel in linked_artefacts(self.scm(), cancel, &session_root(&current)).await? {
                let top = if subdir.is_empty() { rel.clone() } else { format!("{subdir}/{rel}") };
                if asked.contains(&top.as_str()) {
                    shared.push(rel);
                } else {
                    blocked.push(top);
                }
            }
        }
        if !blocked.is_empty() {
            set_setup(&mut current, true, None);
            self.put_record(cancel, current).await?;
            return Ok(Some(SetupClaim { prepared: None, blocked, shared: Vec::new() }));
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        set_setup(&mut current, false, Some(now));
        let prepared = if pending { current.extra.get("setup").and_then(|s| s.get("prepared")).cloned() } else { None };
        self.put_record(cancel, current).await?;
        Ok(Some(SetupClaim { prepared, blocked: Vec::new(), shared }))
    }
}
