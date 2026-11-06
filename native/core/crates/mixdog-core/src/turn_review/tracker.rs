//! The diff tracker of one session (Node `turn-snapshot.mjs`): every file tool write folds its
//! exact before/after bytes into ordered own segments per file. A write that starts from the bytes
//! the file's last segment ended with extends that segment, any other opens a new one, so whatever
//! changed the file in between (a foreign edit) is in no segment. The turn review, its change
//! record and every Undo/Reapply work from those segments only, reverse-applied newest first
//! against the current disk with conflict detection.

use indexmap::IndexMap;
use indexmap::IndexSet;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_js::locale_compare;
use serde_json::Value;

use super::call_diff::TrackedChange;
use super::content::content_len;
use super::content::is_absent;
use super::content::is_binary_change_content;
use super::content::is_omitted;
use super::content::lossy;
use super::content::raw_bytes;
use super::content::same_content;
use super::line_diff::LineDiffBudget;
use super::line_diff::LineDiffer;
use super::line_diff::unified_hunks_body;
use super::nodepath;
use super::patch::clean;
use super::patch::change_path_key;
use super::ports::WorktreeBase;
use super::review_diff::Obj;
use super::review_diff::bound_review_patch;
use std::sync::Arc;

pub const MAX_PATCH_BYTES: usize = 2_000_000;
/// Per-file snapshot limit (Node `PATCH_EDIT_MAX_BYTES`).
pub const PATCH_EDIT_MAX_BYTES: usize = 64 * 1024 * 1024;
// Room for one maximum-size edit's before and after content plus small edits.
pub const MAX_TRACKED_CONTENT_BYTES: usize = 2 * PATCH_EDIT_MAX_BYTES + 32 * 1024 * 1024;

/// `pathKey`: trimmed, folded on Windows.
pub fn path_key(value: &str) -> String {
    let text = clean(value);
    if cfg!(windows) { text.to_lowercase() } else { text.to_owned() }
}

/// `displayPath`: forward slashes, no leading `a/` or `b/`.
pub fn display_path(value: &str) -> String {
    let text = clean(value).replace('\\', "/");
    let text = match text.strip_prefix("a/").or_else(|| text.strip_prefix("b/")) {
        Some(rest) => rest.to_owned(),
        None => text,
    };
    if text.is_empty() { "unknown file".to_owned() } else { text }
}

/// An owned path is the absolute file when the tool resolved one, otherwise the display path it
/// reported.
fn owned_path_entry(path: &str, display: &str) -> String {
    let full = clean(path);
    if !full.is_empty() && nodepath::is_absolute_host(full) { nodepath::resolve_host(&[full]) } else { display.to_owned() }
}

/// Owned paths as forward-slashed paths relative to `root`. Absolute entries outside the root
/// cannot scope a diff of that root and are dropped; relative entries pass through unchanged.
pub fn owned_paths_under(root: &str, owned: &IndexSet<String>) -> IndexSet<String> {
    let base = nodepath::resolve_host(&[if clean(root).is_empty() { "." } else { clean(root) }]);
    let mut out = IndexSet::new();
    for value in owned {
        let target = clean(value);
        if target.is_empty() {
            continue;
        }
        if !nodepath::is_absolute_host(target) {
            out.insert(target.replace('\\', "/"));
            continue;
        }
        let rel = nodepath::relative_host(&base, target);
        if rel.is_empty() || rel == "." || nodepath::is_absolute_host(&rel) || nodepath::split_segments(&rel).contains(&"..") {
            continue;
        }
        out.insert(rel.replace('\\', "/"));
    }
    out
}

#[derive(Clone, PartialEq, Debug)]
pub struct Side {
    pub path: String,
    pub display_path: String,
    pub content: ReviewContent,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Segment {
    pub before: Side,
    pub after: Side,
    pub first_seq: u64,
    pub last_seq: u64,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct Chain {
    pub segments: Vec<Segment>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct OwnStat {
    pub path: String,
    pub display: String,
    pub additions: u64,
    pub deletions: u64,
}

/// A chain an Undo restored, kept so a Reapply puts it back.
#[derive(Clone, PartialEq, Debug)]
pub struct Undone {
    pub chain: Chain,
    pub owned: Vec<String>,
    pub stats: Vec<(String, OwnStat)>,
}

/// The review rendered for one revision.
#[derive(Clone, Debug)]
pub struct View {
    pub revision: u64,
    pub root: String,
    pub files: Vec<Obj>,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Clone, Default, Debug)]
pub struct TrackerMeta {
    pub owner_session_id: Option<String>,
    pub owner_generation: u64,
    pub checkpoint_id: String,
    pub worktree_request: String,
    /// The directory the turn ran in: a non-Git record's patch root.
    pub worktree_root: String,
}

pub struct TrackerState {
    pub valid: bool,
    pub revision: u64,
    /// Current path key → the file's own segments in write order.
    pub chains: IndexMap<String, Chain>,
    pub undone_chains: IndexMap<String, Undone>,
    pub view: Option<View>,
    /// Session-owned paths. These outlive the before/after buffers on purpose: they are what scopes
    /// a revert once the exact content is gone.
    pub owned_paths: IndexSet<String>,
    /// Owned entry key → the summed line deltas of every own write of the file.
    pub own_stats: IndexMap<String, OwnStat>,
}

impl TrackerState {
    pub fn new() -> Self {
        Self {
            valid: true,
            revision: 0,
            chains: IndexMap::new(),
            undone_chains: IndexMap::new(),
            view: None,
            owned_paths: IndexSet::new(),
            own_stats: IndexMap::new(),
        }
    }

    pub fn release_content(&mut self) {
        self.chains.clear();
        self.undone_chains.clear();
        self.view = None;
    }

    pub fn tracked_content_bytes(&self) -> usize {
        self.chains
            .values()
            .flat_map(|chain| chain.segments.iter())
            .map(|segment| content_len(&segment.before.content) + content_len(&segment.after.content))
            .sum()
    }
}

impl Default for TrackerState {
    fn default() -> Self {
        Self::new()
    }
}

/// The root a tracker's own patches are relative to, and whether it is a Git root.
#[derive(Clone, Debug)]
pub struct PatchRoot {
    pub root: String,
    pub git: bool,
}

/// `trackerPatchRoot(tracker, fallback)`.
pub fn patch_root(meta: &TrackerMeta, snapshot: Option<&Arc<dyn WorktreeBase>>, fallback: &str) -> PatchRoot {
    let git_root = snapshot.map(|s| clean(&s.root()).to_owned()).filter(|r| !r.is_empty());
    let git = git_root.is_some();
    let root = git_root.unwrap_or_else(|| {
        let own = clean(&meta.worktree_root);
        if own.is_empty() { clean(fallback).to_owned() } else { own.to_owned() }
    });
    PatchRoot { root: if root.is_empty() { String::new() } else { nodepath::resolve_host(&[&root]) }, git }
}

/// A segment that leaves its file where and as it found it.
fn noop_segment(segment: &Segment) -> bool {
    path_key(&segment.before.path) == path_key(&segment.after.path) && same_content(&segment.before.content, &segment.after.content)
}

/// Join one own segment to the chain of the file it starts at. It extends the chain's last segment
/// when it starts from that segment's exact after bytes; otherwise something else changed the file
/// in between, and it opens a new segment so that change stays out of both. A move onto a path
/// another chain holds lands as a delete of its source and a write of its destination.
pub fn append_segment(state: &mut TrackerState, segment: Segment) {
    let start_key = path_key(&segment.before.path);
    let end_key = path_key(&segment.after.path);
    if start_key != end_key && state.chains.contains_key(&end_key) {
        let mut removal = segment.clone();
        removal.after = Side { content: ReviewContent::Absent, ..segment.before.clone() };
        append_segment(state, removal);
        let mut write = segment;
        write.before = Side { content: ReviewContent::Absent, ..write.after.clone() };
        append_segment(state, write);
        return;
    }
    let mut chain = state.chains.shift_remove(&start_key).unwrap_or_default();
    match chain.segments.last_mut() {
        Some(last) if same_content(&last.after.content, &segment.before.content) => {
            last.after = segment.after;
            last.last_seq = segment.last_seq;
        }
        _ => chain.segments.push(segment),
    }
    state.chains.insert(end_key, chain);
}

fn is_binary_side(content: &ReviewContent) -> bool {
    is_omitted(content) || is_binary_change_content(content)
}

/// `trackedRelativePath`: the path of a side relative to `root`, or `""` outside it (or without a
/// root).
pub fn tracked_relative_path(root: &str, side: &Side) -> String {
    let value = if clean(&side.path).is_empty() { clean(&side.display_path) } else { clean(&side.path) };
    if root.is_empty() || value.is_empty() {
        return String::new();
    }
    let target = if nodepath::is_absolute_host(value) { nodepath::resolve_host(&[value]) } else { nodepath::resolve_host(&[root, value]) };
    let rel = nodepath::relative_host(root, &target);
    if rel.is_empty() || nodepath::is_absolute_host(&rel) || nodepath::split_segments(&rel).contains(&"..") {
        return String::new();
    }
    rel.replace('\\', "/")
}

/// A side's name in the review: relative to `root` inside it, else the tool's display path.
pub fn view_path(root: &str, side: &Side) -> String {
    let rel = tracked_relative_path(root, side);
    if !rel.is_empty() {
        return rel;
    }
    display_path(if side.display_path.is_empty() { &side.path } else { &side.display_path })
}

#[derive(Clone, Debug)]
pub struct Step {
    pub before: Side,
    pub after: Side,
    pub old_path: String,
    pub new_path: String,
}

/// What a chain records, relative to `root`.
#[derive(Clone, Debug)]
pub struct Edit {
    pub steps: Vec<Step>,
    pub start: Side,
    pub end: Side,
    pub status: char,
    pub binary: bool,
    pub inside: bool,
    pub omitted: bool,
}

impl Edit {
    pub fn omitted_marker(&self) -> Option<&ReviewContent> {
        self.steps.iter().flat_map(|s| [&s.before.content, &s.after.content]).find(|c| is_omitted(c))
    }
}

/// Its segments that change something, of a binary file only the last, since bytes from before a
/// foreign rewrite cannot be restored around it. Null when the chain changes nothing.
pub fn chain_edit(chain: &Chain, root: &str) -> Option<Edit> {
    let mut segments: Vec<&Segment> = chain.segments.iter().filter(|s| !noop_segment(s)).collect();
    if segments.is_empty() {
        return None;
    }
    let binary = segments.iter().any(|s| is_binary_side(&s.before.content) || is_binary_side(&s.after.content));
    if binary {
        segments = vec![segments[segments.len() - 1]];
    }
    let steps: Vec<Step> = segments
        .iter()
        .map(|s| Step {
            before: s.before.clone(),
            after: s.after.clone(),
            old_path: tracked_relative_path(root, &s.before),
            new_path: tracked_relative_path(root, &s.after),
        })
        .collect();
    let first = &steps[0];
    let last = &steps[steps.len() - 1];
    let start = if is_absent(&first.before.content) { first.after.clone() } else { first.before.clone() };
    let end = if is_absent(&last.after.content) { last.before.clone() } else { last.after.clone() };
    let mut status = 'M';
    if is_absent(&first.before.content) && !is_absent(&last.after.content) {
        status = 'A';
    } else if is_absent(&last.after.content) && !is_absent(&first.before.content) {
        status = 'D';
    } else if path_key(&start.path) != path_key(&end.path) {
        status = 'R';
    }
    let inside = steps.iter().all(|s| !s.old_path.is_empty() && !s.new_path.is_empty());
    let omitted = steps.iter().any(|s| is_omitted(&s.before.content) || is_omitted(&s.after.content));
    Some(Edit { steps, start, end, status, binary, inside, omitted })
}

pub struct Rendered {
    pub text: String,
    pub additions: u64,
    pub deletions: u64,
}

/// One step's display section, named as the review shows it, with its line counts: hunks, a
/// `Binary files … differ` line, or the not-captured note.
pub fn render_step(differ: &LineDiffer, step: &Step, root: &str, budget: &mut LineDiffBudget) -> Rendered {
    let (before, after) = (&step.before, &step.after);
    let old_git = format!("a/{}", view_path(root, before));
    let new_git = format!("b/{}", view_path(root, after));
    let old_header = if is_absent(&before.content) { "/dev/null".to_owned() } else { old_git.clone() };
    let new_header = if is_absent(&after.content) { "/dev/null".to_owned() } else { new_git.clone() };
    let mut head = format!("diff --git {old_git} {new_git}\n");
    if is_absent(&before.content) {
        head.push_str("new file mode 100644\n");
    } else if is_absent(&after.content) {
        head.push_str("deleted file mode 100644\n");
    }
    let binary_line = format!("Binary files {old_header} and {new_header} differ\n");
    let omitted = [&before.content, &after.content].into_iter().find(|c| is_omitted(c));
    if let Some(ReviewContent::Omitted { size, .. }) = omitted {
        let change = if is_absent(&after.content) {
            "deleted"
        } else if is_absent(&before.content) {
            "added"
        } else {
            "changed"
        };
        let note = format!("binary/large file {change} ({size} bytes; content not captured)\n");
        return Rendered { text: format!("{head}{note}{binary_line}"), additions: 0, deletions: 0 };
    }
    if is_binary_change_content(&before.content) || is_binary_change_content(&after.content) {
        return Rendered { text: format!("{head}{binary_line}"), additions: 0, deletions: 0 };
    }
    let text = |content: &ReviewContent| match content {
        ReviewContent::Bytes(bytes) => lossy(bytes),
        _ => String::new(),
    };
    let hunks = differ.hunks(&text(&before.content), &text(&after.content), budget, [raw_bytes(&before.content), raw_bytes(&after.content)]);
    let (mut additions, mut deletions) = (0, 0);
    for line in hunks.hunks.iter().flat_map(|h| h.lines.iter()) {
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    Rendered { text: format!("{head}{}", unified_hunks_body(&old_header, &new_header, &hunks.hunks)), additions, deletions }
}

/// Lookup of the tracker's own-write counts by a reviewed file path: relative to `root`, or
/// (`display`) the tools' display path a tracked patch shows.
pub fn own_count_index(state: &TrackerState, root: &str, display: bool) -> impl Fn(&str) -> Option<OwnStat> {
    let key_of = {
        let root = root.to_owned();
        move |path: &str| path_key(&if display { path.to_owned() } else { nodepath::resolve_host(&[&root, path]) })
    };
    let mut index: IndexMap<String, OwnStat> = IndexMap::new();
    for entry in state.own_stats.values() {
        index.insert(key_of(if display { &entry.display } else { &entry.path }), entry.clone());
    }
    move |path: &str| if path.is_empty() { None } else { index.get(&key_of(path)).cloned() }
}

/// Files counted by the summed per-call deltas of their own writes (a rename's old path included).
/// A file no own write reported counts for keeps the counts it has.
pub fn with_own_counts(files: Vec<Obj>, find: impl Fn(&str) -> Option<OwnStat>) -> Vec<Obj> {
    files
        .into_iter()
        .map(|mut file| {
            let path = file.get("path").and_then(Value::as_str).unwrap_or("").to_owned();
            let old = file.get("oldPath").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_owned);
            let hits: Vec<OwnStat> = [find(&path), old.and_then(|p| find(&p))].into_iter().flatten().collect();
            if hits.is_empty() {
                return file;
            }
            file.insert("additions".into(), Value::from(hits.iter().map(|h| h.additions).sum::<u64>()));
            file.insert("deletions".into(), Value::from(hits.iter().map(|h| h.deletions).sum::<u64>()));
            file
        })
        .collect()
}

/// The tracker's own changes as the review shows them: a row per file with its own counts, and the
/// display patch of its segments, named relative to the tracker's patch root. Beside a Git root a
/// file outside it is left out, as from the record's undoable files. Cached per revision; `budget`
/// bounds a render.
pub fn tracker_view(differ: &LineDiffer, state: &mut TrackerState, root: &PatchRoot, budget: &mut LineDiffBudget) -> View {
    if let Some(view) = &state.view {
        if view.revision == state.revision && view.root == root.root {
            return view.clone();
        }
    }
    struct Row {
        obj: Obj,
        text: String,
    }
    let mut rows: Vec<Row> = Vec::new();
    if !state.valid {
        // The content is gone: which files changed is known, their diff is not.
        for path in owned_paths_under(&root.root, &state.owned_paths) {
            let mut obj = Obj::new();
            obj.insert("path".into(), Value::String(path));
            obj.insert("status".into(), Value::String("M".into()));
            obj.insert("additions".into(), Value::from(0));
            obj.insert("deletions".into(), Value::from(0));
            rows.push(Row { obj, text: String::new() });
        }
    }
    for chain in state.chains.values() {
        let Some(edit) = chain_edit(chain, &root.root) else { continue };
        if root.git && !edit.inside {
            continue;
        }
        let rendered: Vec<Rendered> = edit.steps.iter().map(|step| render_step(differ, step, &root.root, budget)).collect();
        let path = view_path(&root.root, &edit.end);
        let old_path = view_path(&root.root, &edit.start);
        let mut obj = Obj::new();
        obj.insert("path".into(), Value::String(path.clone()));
        if old_path != path {
            obj.insert("oldPath".into(), Value::String(old_path));
        }
        obj.insert("status".into(), Value::String(edit.status.to_string()));
        obj.insert("additions".into(), Value::from(rendered.iter().map(|r| r.additions).sum::<u64>()));
        obj.insert("deletions".into(), Value::from(rendered.iter().map(|r| r.deletions).sum::<u64>()));
        if edit.binary {
            obj.insert("binary".into(), Value::Bool(true));
        }
        // Its bytes were never captured: listed, never diffed or undone.
        if let Some(ReviewContent::Omitted { size, .. }) = edit.omitted_marker() {
            obj.insert("omitted".into(), Value::Bool(true));
            obj.insert("size".into(), Value::from(*size));
        }
        rows.push(Row { obj, text: rendered.iter().map(|r| r.text.as_str()).collect() });
    }
    rows.sort_by(|left, right| {
        let l = left.obj.get("path").and_then(Value::as_str).unwrap_or("");
        let r = right.obj.get("path").and_then(Value::as_str).unwrap_or("");
        locale_compare(l, r)
    });
    let joined: String = rows.iter().map(|r| r.text.as_str()).collect();
    let (patch, truncated) = bound_review_patch(&joined, MAX_PATCH_BYTES);
    let files: Vec<Obj> = rows.into_iter().map(|r| r.obj).collect();
    let files = if root.root.is_empty() {
        with_own_counts(files, own_count_index(state, "", true))
    } else {
        with_own_counts(files, own_count_index(state, &root.root, false))
    };
    let view = View { revision: state.revision, root: root.root.clone(), files, patch, truncated };
    state.view = Some(view.clone());
    view
}

/// True when `value` (absolute, or relative to `root`) names a path the chain touched.
pub fn chain_matches_path(chain: &Chain, root: &str, value: &str) -> bool {
    let target = clean(value);
    if target.is_empty() {
        return false;
    }
    let full = if nodepath::is_absolute_host(target) { nodepath::resolve_host(&[target]) } else { nodepath::resolve_host(&[root, target]) };
    let key = change_path_key(&nodepath::relative_host(root, &full));
    chain.segments.iter().any(|segment| {
        [&segment.before, &segment.after].into_iter().any(|entry| {
            let path = tracked_relative_path(root, entry);
            !path.is_empty() && change_path_key(&path) == key
        })
    })
}

/// The owned entries (and their counts) of every path a chain touched.
fn chain_ownership(state: &TrackerState, chain: &Chain) -> (Vec<String>, Vec<(String, OwnStat)>) {
    let mut seen = IndexSet::new();
    for segment in &chain.segments {
        for entry in [&segment.before, &segment.after] {
            seen.insert(owned_path_entry(&entry.path, &display_path(if entry.display_path.is_empty() { &entry.path } else { &entry.display_path })));
        }
    }
    let owned: Vec<String> = seen.into_iter().filter(|entry| state.owned_paths.contains(entry)).collect();
    let stats = owned
        .iter()
        .filter_map(|entry| {
            let key = path_key(entry);
            state.own_stats.get(&key).map(|stat| (key, stat.clone()))
        })
        .collect();
    (owned, stats)
}

/// An Undo reverse-applied the chains at `keys`: the turn no longer changes them, so they leave its
/// review. Each is kept for a Reapply.
pub fn undo_tracked_chains(state: &mut TrackerState, keys: &[String]) {
    for key in keys {
        let Some(chain) = state.chains.get(key).cloned() else { continue };
        let (owned, stats) = chain_ownership(state, &chain);
        for entry in &owned {
            state.owned_paths.shift_remove(entry);
        }
        for (stat_key, _) in &stats {
            state.own_stats.shift_remove(stat_key);
        }
        state.undone_chains.insert(key.clone(), Undone { chain, owned, stats });
        state.chains.shift_remove(key);
    }
    state.revision += 1;
}

/// A Reapply forward-applied the undone chains matching `files` again.
pub fn redo_tracked_chains(state: &mut TrackerState, root: &str, files: &[(String, Option<String>)]) {
    let keys: Vec<String> = state.undone_chains.keys().cloned().collect();
    for key in keys {
        let matches = {
            let undone = &state.undone_chains[&key];
            files.iter().any(|(path, old)| {
                chain_matches_path(&undone.chain, root, path) || old.as_deref().is_some_and(|p| chain_matches_path(&undone.chain, root, p))
            })
        };
        if !matches {
            continue;
        }
        let undone = state.undone_chains.shift_remove(&key).expect("undone chain");
        state.chains.insert(key, undone.chain);
        for entry in undone.owned {
            state.owned_paths.insert(entry);
        }
        for (stat_key, stat) in undone.stats {
            state.own_stats.insert(stat_key, stat);
        }
    }
    state.revision += 1;
}

/// A new write supersedes whatever an Undo set aside for the paths it touches.
pub fn drop_undone_chains(state: &mut TrackerState, keys: &IndexSet<String>) {
    let drop: Vec<String> = state
        .undone_chains
        .iter()
        .filter(|(_, undone)| {
            undone
                .chain
                .segments
                .iter()
                .any(|s| keys.contains(&path_key(&s.before.path)) || keys.contains(&path_key(&s.after.path)))
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in drop {
        state.undone_chains.shift_remove(&key);
    }
}

/// Fold one write's line counts into `stats` (owned entry key → summed counts). A rename moves the
/// source's counts to its destination; a change that reports no counts (an Undo/Reapply fold) adds
/// nothing.
pub struct OwnKey {
    pub key: String,
    pub path: String,
    pub display: String,
}

pub fn fold_own_stats(stats: &mut IndexMap<String, OwnStat>, additions: Option<u64>, deletions: Option<u64>, source: &OwnKey, destination: Option<&OwnKey>) {
    let measured = additions.is_some() || deletions.is_some();
    let prior = stats.get(&source.key).cloned();
    if destination.is_some() {
        stats.shift_remove(&source.key);
    }
    let target = destination.unwrap_or(source);
    let existing = destination.and_then(|d| stats.get(&d.key).cloned());
    if prior.is_none() && existing.is_none() && !measured {
        return;
    }
    let sum = |pick: fn(&OwnStat) -> u64, extra: Option<u64>| pick_sum(prior.as_ref(), existing.as_ref(), pick) + extra.unwrap_or(0);
    stats.insert(
        target.key.clone(),
        OwnStat {
            path: target.path.clone(),
            display: target.display.clone(),
            additions: sum(|s| s.additions, additions),
            deletions: sum(|s| s.deletions, deletions),
        },
    );
}

fn pick_sum(prior: Option<&OwnStat>, existing: Option<&OwnStat>, pick: fn(&OwnStat) -> u64) -> u64 {
    prior.map_or(0, pick) + existing.map_or(0, pick)
}

pub fn merge_own_stats(target: &mut IndexMap<String, OwnStat>, source: &IndexMap<String, OwnStat>) {
    for (key, entry) in source {
        match target.get_mut(key) {
            Some(prior) => {
                prior.additions += entry.additions;
                prior.deletions += entry.deletions;
            }
            None => {
                target.insert(key.clone(), entry.clone());
            }
        }
    }
}

/// A before-state for the worktree baseline without copying anything above the per-file snapshot
/// limit: such content becomes an omitted marker.
fn bounded_baseline_content(content: &ReviewContent) -> ReviewContent {
    let size = content_len(content);
    if size > PATCH_EDIT_MAX_BYTES {
        return ReviewContent::Omitted { size: size as u64, reason: Some("oversized".into()) };
    }
    content.clone()
}

/// Fold exact before/after states into the tracker as own segments (see [`append_segment`]).
/// `snapshot` (the owning Lead turn's Git baseline, when tools are writing) learns each written
/// path's first-before bytes.
pub fn fold_tracked_changes(
    state: &mut TrackerState,
    list: &[TrackedChange],
    snapshot: Option<&Arc<dyn WorktreeBase>>,
    next_seq: &mut dyn FnMut() -> u64,
) {
    // The content ceiling is enforced BEFORE anything is stored: an over-budget batch invalidates
    // the tracker up front instead of retaining its buffers.
    let incoming: usize = list.iter().map(|raw| content_len(&raw.before) + content_len(&raw.after)).sum();
    let store_content = state.tracked_content_bytes() + incoming <= MAX_TRACKED_CONTENT_BYTES;
    if !store_content {
        state.valid = false;
        state.release_content();
    }
    for raw in list {
        let source_path = clean(&raw.path);
        if source_path.is_empty() {
            continue;
        }
        let source_key = path_key(source_path);
        let source_display = display_path(if raw.display_path.is_empty() { source_path } else { &raw.display_path });
        // Nothing is converted or copied before the ceiling decision: a rejected batch only hands
        // the worktree baseline a bounded value.
        let before = if store_content { raw.before.clone() } else { bounded_baseline_content(&raw.before) };
        let destination_path = raw.new_path.as_deref().map(clean).unwrap_or("");
        if let Some(snapshot) = snapshot {
            snapshot.record_file_change(source_path, &before);
            if !destination_path.is_empty() {
                snapshot.record_file_change(destination_path, &ReviewContent::Absent);
            }
        }
        // WHICH files this session wrote has to survive releasing their content: that list is the
        // attribution a shared worktree cannot otherwise reconstruct. It keeps the ABSOLUTE file.
        let source_entry = owned_path_entry(source_path, &source_display);
        state.owned_paths.insert(source_entry.clone());
        let mut destination: Option<OwnKey> = None;
        if !destination_path.is_empty() {
            let display = display_path(raw.new_display_path.as_deref().filter(|d| !d.is_empty()).unwrap_or(destination_path));
            let entry = owned_path_entry(destination_path, &display);
            state.owned_paths.insert(entry.clone());
            destination = Some(OwnKey { key: path_key(&entry), path: entry, display });
        }
        fold_own_stats(
            &mut state.own_stats,
            raw.additions,
            raw.deletions,
            &OwnKey { key: path_key(&source_entry), path: source_entry.clone(), display: source_display.clone() },
            destination.as_ref(),
        );
        if !store_content {
            continue;
        }
        let after = raw.after.clone();
        if destination_path.is_empty() && is_absent(&before) && is_absent(&after) {
            continue;
        }
        let mut keys = IndexSet::new();
        keys.insert(source_key);
        if !destination_path.is_empty() {
            keys.insert(path_key(destination_path));
        }
        drop_undone_chains(state, &keys);
        let seq = next_seq();
        let after_side = match &destination {
            Some(d) => Side { path: destination_path.to_owned(), display_path: d.display.clone(), content: after },
            None => Side { path: source_path.to_owned(), display_path: source_display.clone(), content: after },
        };
        append_segment(
            state,
            Segment {
                before: Side { path: source_path.to_owned(), display_path: source_display, content: before },
                after: after_side,
                first_seq: seq,
                last_seq: seq,
            },
        );
    }
    state.revision += 1;
    if state.tracked_content_bytes() > MAX_TRACKED_CONTENT_BYTES {
        state.valid = false;
        state.release_content();
    }
}

/// Join a completed worker's own segments to its Lead's tracker: both sets replay in write order,
/// so a worker write between two Lead writes of one file continues their segment instead of
/// reading as a foreign gap. A worker whose content was dropped drops the Lead's exact content
/// too.
pub fn merge_tracked_content(target: &mut TrackerState, source: &TrackerState) {
    // The worker's owned paths and counts joined as well: any view is stale.
    target.revision += 1;
    if !target.valid {
        return;
    }
    if !source.valid {
        target.valid = false;
        target.release_content();
        return;
    }
    let segments_of = |state: &TrackerState| -> Vec<Segment> { state.chains.values().flat_map(|c| c.segments.iter().cloned()).collect() };
    let written: IndexSet<String> = segments_of(source)
        .iter()
        .flat_map(|s| [path_key(&s.before.path), path_key(&s.after.path)])
        .collect();
    let mut segments = segments_of(target);
    segments.extend(segments_of(source));
    segments.sort_by_key(|s| s.first_seq);
    target.chains = IndexMap::new();
    for segment in segments {
        append_segment(target, segment);
    }
    drop_undone_chains(target, &written);
    if target.tracked_content_bytes() > MAX_TRACKED_CONTENT_BYTES {
        target.valid = false;
        target.release_content();
    }
}
