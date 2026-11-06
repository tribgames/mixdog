//! A turn's worktree snapshot over the shadow repository (Node `createTurnWorktreeSnapshot`,
//! `resumeTurnWorktreeSnapshot`, `refreshTurnWorktreeSnapshot`, `materializeToolBaselines`,
//! `recordTurnWorktreeFileChange`).

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use indexmap::IndexMap;
use mixdog_core_api::turn_review::ReviewContent;
use serde_json::Value;

use super::nodepath;
use super::patch::clean;
use super::ports::SnapshotReview;
use super::ports::WorktreeBase;
use super::review_diff::Obj;
use super::review_diff::review_diff_too_large;
use super::shadow::BaselineEntry;
use super::shadow::MAX_UNTRACKED_FILE_BYTES;
use super::shadow::Root;
use super::shadow::ShadowRepos;
use super::shadow::TreeReview;
use super::shadow::canonical_path;
use super::shadow::pending_content;
use super::shadow::safe_relative_path;
use super::shadow::shadow_key;

type R<T> = Result<T, String>;

/// A tool-written path's first state, not yet folded into the baseline tree.
#[derive(Clone)]
struct Pending {
    content: Option<Vec<u8>>,
    omitted: Option<u64>,
}

struct Snap {
    baseline_tree: String,
    current_tree: String,
    /// The change stamp the last capture started from.
    captured: Option<u64>,
    refresh_seq: u64,
    review: TreeReview,
    scope_paths: Option<Vec<String>>,
    tool_paths: HashSet<String>,
    pending: IndexMap<String, Pending>,
    baseline_files: IndexMap<String, Value>,
}

pub(super) struct ShadowSnapshot {
    root: Arc<Root>,
    snap: Mutex<Snap>,
    /// A refresh in flight; a caller waits for it (`refreshing`).
    gate: tokio::sync::Mutex<()>,
}

impl ShadowSnapshot {
    fn snap(&self) -> std::sync::MutexGuard<'_, Snap> {
        self.snap.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `createTurnWorktreeSnapshot(worktree)`: `None` outside a repository.
    pub(super) async fn create(repos: &ShadowRepos, worktree: &str) -> Option<Arc<Self>> {
        let root_path = repos.repository_root(worktree).await?;
        let root = repos.state_for_root(&root_path);
        let guard = root.lock().await;
        let mark = root.change_stamp();
        let tree = root.capture_tree(&HashSet::new(), None).await.ok().filter(|t| !t.is_empty())?;
        drop(guard);
        root.schedule_gc();
        Some(Arc::new(Self {
            root,
            snap: Mutex::new(Snap {
                baseline_tree: tree.clone(),
                current_tree: tree,
                captured: Some(mark),
                refresh_seq: 0,
                review: TreeReview::default(),
                scope_paths: None,
                tool_paths: HashSet::new(),
                pending: IndexMap::new(),
                baseline_files: IndexMap::new(),
            }),
            gate: tokio::sync::Mutex::new(()),
        }))
    }

    /// `resumeTurnWorktreeSnapshot`: a recorded baseline re-opened after the in-memory tracker was
    /// lost. `paths` scopes both the diff and any later revert to what the recording session owns.
    pub(super) async fn resume(repos: &ShadowRepos, worktree: &str, baseline_tree: &str, paths: &[String], baseline_files: &[Value]) -> Option<Arc<Self>> {
        let tree = clean(baseline_tree).to_owned();
        if tree.is_empty() {
            return None;
        }
        let root_path = repos.repository_root(worktree).await?;
        let root = repos.state_for_root(&root_path);
        let after = root.capture_sequence();
        let guard = root.lock().await;
        if !root.recorded_tree(&tree).await.ok()? {
            return None;
        }
        let mut scope: Vec<String> = Vec::new();
        for p in paths {
            if !scope.contains(p) {
                scope.push(p.clone());
            }
        }
        let scope_paths = (!scope.is_empty()).then(|| scope.clone());
        let entries: Vec<BaselineEntry> = baseline_files.iter().filter_map(BaselineEntry::from_value).collect();
        let (baseline, files) = root.apply_baseline_files(&tree, &entries, None).await.ok()?;
        let tool_paths: HashSet<String> = scope.into_iter().collect();
        let current = root.capture_tree(&tool_paths, Some(after)).await.ok()?;
        let review = root.diff_trees(&baseline, &current, scope_paths.as_deref()).await.ok()?;
        drop(guard);
        let snapshot = Self {
            root,
            snap: Mutex::new(Snap {
                baseline_tree: baseline,
                current_tree: tree,
                captured: None,
                refresh_seq: 0,
                review: TreeReview::default(),
                scope_paths,
                tool_paths,
                pending: IndexMap::new(),
                baseline_files: files.into_iter().map(|e| (shadow_key(e["path"].as_str().unwrap_or("")), e)).collect(),
            }),
            gate: tokio::sync::Mutex::new(()),
        };
        let review = snapshot.with_omitted_baselines(review).await;
        snapshot.snap().current_tree = review.current_tree.clone();
        snapshot.snap().review = review;
        Some(Arc::new(snapshot))
    }

    /// `resumeTurnWorktreeFilePatch`: one file's patch of a recorded baseline against the worktree
    /// now. `paths` is the recording session's scope, every target checked on its own. `None` when
    /// the baseline is gone.
    pub(super) async fn resume_file_patch(
        repos: &ShadowRepos,
        worktree: &str,
        baseline_tree: &str,
        paths: &[String],
        baseline_files: &[Value],
        path: &str,
        old_path: &str,
        max_bytes: usize,
    ) -> Option<Obj> {
        let tree = clean(baseline_tree).to_owned();
        if tree.is_empty() {
            return None;
        }
        let root_path = repos.repository_root(worktree).await?;
        let root = repos.state_for_root(&root_path);
        let scope: Option<HashSet<String>> = (!paths.is_empty()).then(|| paths.iter().map(|p| shadow_key(p)).collect());
        let allowed = |rel: &str| scope.as_ref().is_none_or(|s| s.contains(&shadow_key(rel)));
        let target = safe_relative_path(&root_path, path).ok()?;
        if !allowed(&target) {
            let mut reply = Obj::new();
            reply.insert("patch".into(), Value::String(String::new()));
            return Some(reply);
        }
        let source = if clean(old_path).is_empty() { String::new() } else { safe_relative_path(&root_path, old_path).ok()? };
        // Only authorized paths reach the diff.
        let targets: Vec<String> = if !source.is_empty() && allowed(&source) && shadow_key(&source) != shadow_key(&target) { vec![target, source] } else { vec![target] };
        let keys: HashSet<String> = targets.iter().map(|t| shadow_key(t)).collect();
        let after = root.capture_sequence();
        let _guard = root.lock().await;
        if !root.recorded_tree(&tree).await.ok()? {
            return None;
        }
        // Only this file's recorded first states change its side of the tree.
        let entries: Vec<BaselineEntry> = baseline_files
            .iter()
            .filter_map(BaselineEntry::from_value)
            .filter(|e| safe_relative_path(&root_path, &e.path).is_ok_and(|rel| keys.contains(&shadow_key(&rel))))
            .collect();
        let (baseline, _) = root.apply_baseline_files(&tree, &entries, None).await.ok()?;
        let current = root.capture_tree(&targets.iter().cloned().collect(), Some(after)).await.ok()?;
        root.file_patch(&baseline, &current, &targets[0], targets.get(1).map_or("", String::as_str), max_bytes).await.ok()
    }

    /// `withOmittedBaselines`: rows and patch sections for omitted baselines inside the review scope.
    async fn with_omitted_baselines(&self, mut review: TreeReview) -> TreeReview {
        let omitted: Vec<(String, u64)> = {
            let snap = self.snap();
            let scope = snap.scope_paths.as_ref().map(|p| p.iter().map(|v| shadow_key(v)).collect::<HashSet<_>>());
            let omitted = snap
                .baseline_files
                .values()
                .filter(|e| e.get("omitted") == Some(&Value::Bool(true)))
                .filter_map(|e| Some((e.get("path")?.as_str()?.to_owned(), e.get("size").and_then(Value::as_f64).unwrap_or(0.0) as u64)))
                .filter(|(path, _)| scope.as_ref().is_none_or(|s| s.contains(&shadow_key(path))))
                .collect();
            omitted
        };
        if omitted.is_empty() {
            return review;
        }
        let keys: HashSet<String> = omitted.iter().map(|(p, _)| shadow_key(p)).collect();
        review.files.retain(|f| !keys.contains(&shadow_key(f["path"].as_str().unwrap_or(""))));
        for (path, size) in omitted {
            let present = self.root_disk_exists(&path).await;
            let new_header = if present { format!("b/{path}") } else { "/dev/null".to_owned() };
            review.patch.push_str(&format!(
                "diff --git a/{path} b/{path}\n{}binary/large file {} ({size} bytes; content not captured)\nBinary files a/{path} and {new_header} differ\n",
                if present { "" } else { "deleted file mode 100644\n" },
                if present { "changed" } else { "deleted" },
            ));
            let mut file = Obj::new();
            file.insert("path".into(), Value::String(path));
            file.insert("oldPath".into(), Value::Null);
            file.insert("status".into(), Value::String(if present { "M" } else { "D" }.into()));
            file.insert("additions".into(), Value::Null);
            file.insert("deletions".into(), Value::Null);
            file.insert("binary".into(), Value::Bool(true));
            file.insert("omitted".into(), Value::Bool(true));
            file.insert("size".into(), Value::from(size));
            review.files.push(file);
        }
        review.files.sort_by(|a, b| mixdog_js::locale_compare(a["path"].as_str().unwrap_or(""), b["path"].as_str().unwrap_or("")));
        review.diff_too_large = review_diff_too_large(&review.files, &review.patch);
        review
    }

    async fn root_disk_exists(&self, rel: &str) -> bool {
        self.root.disk_exists(&nodepath::resolve_host(&[&self.root.root, rel])).await
    }

    fn capture_needed(&self) -> bool {
        let snap = self.snap();
        match snap.captured {
            None => true,
            Some(stamp) => !snap.pending.is_empty() || stamp != self.root.change_stamp(),
        }
    }

    /// `materializeToolBaselines`: the pending first states fill what the baseline tree lacks.
    async fn materialize(&self) -> R<()> {
        let (tree, pending): (String, Vec<(String, Pending)>) = {
            let snap = self.snap();
            (snap.baseline_tree.clone(), snap.pending.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        };
        if pending.is_empty() {
            return Ok(());
        }
        let paths: Vec<&str> = pending.iter().map(|(p, _)| p.as_str()).collect();
        let mut args = vec!["ls-tree", "-r", "-z", "--name-only", tree.as_str(), "--"];
        args.extend(&paths);
        let listed = self.root.shadow_run(&args, Vec::new()).await?;
        let nul_list = |bytes: &[u8]| -> Vec<String> { String::from_utf8_lossy(bytes).split('\0').map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).collect() };
        let present: HashSet<String> = nul_list(&listed.stdout).iter().map(|p| shadow_key(p)).collect();
        // A leading ':' is pathspec magic to ls-tree and check-ignore.
        let literal = paths.iter().all(|p| !p.starts_with(':'));
        let tracked = self.root.source_tracked();
        let asks_ignored = |(path, p): &(String, Pending)| {
            p.content.as_ref().is_some_and(|c| c.len() <= MAX_UNTRACKED_FILE_BYTES) && !present.contains(&shadow_key(path)) && !tracked.contains(&shadow_key(path))
        };
        let mut ignored: HashSet<String> = HashSet::new();
        if !literal || pending.iter().any(asks_ignored) {
            let input = format!("{}\0", paths.join("\0")).into_bytes();
            let out = self.root.plain_run(&["check-ignore", "--no-index", "-z", "--stdin"], input, true).await?;
            if out.code > 1 {
                return Err(format!("git check-ignore failed ({}): {}", out.code, clean(&String::from_utf8_lossy(&out.stderr))));
            }
            ignored = nul_list(&out.stdout).iter().map(|p| shadow_key(p)).collect();
        }
        let missing: Vec<BaselineEntry> = pending
            .iter()
            .filter(|(path, p)| {
                !present.contains(&shadow_key(path))
                    && (p.content.is_none()
                        || p.omitted.is_some()
                        || (!tracked.contains(&shadow_key(path)) && (ignored.contains(&shadow_key(path)) || p.content.as_ref().is_some_and(|c| c.len() > MAX_UNTRACKED_FILE_BYTES))))
            })
            // A path whose exact baseline is already in the tree keeps it; one that is not and whose
            // bytes were never captured is recorded as omitted.
            .map(|(path, p)| BaselineEntry { path: path.clone(), content: p.content.clone(), oid: None, omitted: p.omitted.is_some(), size: p.omitted.unwrap_or(0) })
            .collect();
        // A path ls-tree read literally and did not list is not in the tree.
        let absent: Option<HashSet<String>> = literal.then(|| paths.iter().map(|p| shadow_key(p)).filter(|k| !present.contains(k)).collect());
        let (next_tree, files) = self.root.apply_baseline_files(&tree, &missing, absent.as_ref()).await?;
        let mut snap = self.snap();
        snap.baseline_tree = next_tree;
        for entry in files {
            let key = shadow_key(entry["path"].as_str().unwrap_or(""));
            snap.baseline_files.insert(key, entry);
        }
        for (path, _) in &pending {
            snap.pending.shift_remove(path);
        }
        // A changed baseline can change the diff even when the current tree did not.
        snap.current_tree = String::new();
        Ok(())
    }

    async fn refresh_now(&self, force: bool) -> R<()> {
        let called_at = self.snap().refresh_seq;
        let _flight = self.gate.lock().await;
        if self.snap().refresh_seq > called_at {
            return Ok(());
        }
        if !force && !self.capture_needed() {
            return Ok(());
        }
        self.snap().refresh_seq += 1;
        let after = self.root.capture_sequence();
        let _lock = self.root.lock().await;
        let mark = self.root.change_stamp();
        self.materialize().await?;
        let (tool_paths, baseline, previous, scope) = {
            let snap = self.snap();
            (snap.tool_paths.clone(), snap.baseline_tree.clone(), snap.current_tree.clone(), snap.scope_paths.clone())
        };
        let current = self.root.capture_tree(&tool_paths, Some(after)).await?;
        if current != previous {
            let review = self.root.diff_trees(&baseline, &current, scope.as_deref()).await?;
            let review = self.with_omitted_baselines(review).await;
            let mut snap = self.snap();
            snap.current_tree = review.current_tree.clone();
            snap.review = review;
        }
        self.snap().captured = Some(mark);
        Ok(())
    }
}

#[async_trait]
impl WorktreeBase for ShadowSnapshot {
    fn root(&self) -> String {
        self.root.root.clone()
    }

    fn baseline_tree(&self) -> String {
        self.snap().baseline_tree.clone()
    }

    fn baseline_files(&self) -> Vec<Value> {
        self.snap().baseline_files.values().cloned().collect()
    }

    fn review(&self) -> SnapshotReview {
        let snap = self.snap();
        SnapshotReview { files: snap.review.files.clone(), patch: snap.review.patch.clone(), patch_truncated: snap.review.patch_truncated }
    }

    /// `recordTurnWorktreeFileChange`.
    fn record_file_change(&self, path: &str, before: &ReviewContent) {
        let rel = nodepath::relative_host(&self.root.root, &canonical_path(path)).replace('\\', "/");
        if rel.is_empty() || nodepath::is_absolute_host(&rel) || rel.split('/').any(|s| s == "..") {
            return;
        }
        self.root.bump_change();
        let mut snap = self.snap();
        if !snap.tool_paths.insert(rel.clone()) {
            return;
        }
        let (content, omitted) = pending_content(before);
        snap.pending.insert(rel, Pending { content, omitted });
    }

    /// `refreshTurnWorktreeSnapshot`. Best effort: a failure leaves the last capture standing.
    async fn refresh(&self, force: bool) {
        let _ = self.refresh_now(force).await;
    }
}
