//! The session-wide review (Node `getSessionReviewDiff`, `getSessionReviewFilePatch`,
//! `sessionChangeReview` and its measuring helpers): inside a Git root the diff from the earliest
//! retained baseline tree to the worktree, scoped to the paths the session changed; everywhere
//! else each file's FIRST state observed in the session against the disk now. Unlike the turn
//! review it survives user-turn boundaries and has no revert contract.

use indexmap::IndexMap;
use indexmap::IndexSet;
use mixdog_core_api::turn_review::ReviewContent;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::baselines::CachedRow;
use super::baselines::Entry;
use super::baselines::Loaded;
use super::line_diff::LineDiffBudget;
use super::named::measure_change;
use super::named::name_measured_patch;
use super::nodepath;
use super::patch::change_path_key;
use super::patch::clean;
use super::patch::obj_str;
use super::patch::patch_of;
use super::ports::CurrentFile;
use super::ports::ResumeScope;
use super::review_diff::Obj;
use super::review_diff::PATCH_TOO_LARGE;
use super::review_diff::REVIEW_FILE_PATCH_MAX_BYTES;
use super::review_diff::REVIEW_FILE_PATCH_SHOW_MAX_BYTES;
use super::review_diff::REVIEW_PATCH_MAX_BYTES;
use super::review_diff::ReviewPatchBudget;
use super::review_diff::file_patch_reply;
use super::review_diff::patch_omitted_file;
use super::review_diff::review_diff_too_large;
use super::service::Inner;
use super::service::Tracker;
use super::store::SharedRecord;
use super::tracker::owned_paths_under;
use super::tracker::path_key;
use std::sync::Arc;

const DIGEST_MAX_BYTES: u64 = 64 * 1024 * 1024;
const CACHED_PATCH_MAX_BYTES: usize = 256 * 1024;
const UNREADABLE_REASON: &str = "the file cannot be read safely now";
const SEVERAL_TURNS_REASON: &str = "edited in several turns before its session baseline was recorded";

/// Why a listed file has no exact diff against the session's first state.
fn baseline_reason(status: &str) -> &'static str {
    match status {
        "omitted-binary" => "the session's original binary content was not captured",
        "omitted-oversized" => "the session's original content was too large to capture",
        "evicted" => "the session's original content was evicted to bound storage",
        _ => "the session's original state was not recorded",
    }
}

/// One file (or rename) as the session review measures it.
#[derive(Clone, Default, Debug)]
pub(in crate::turn_review) struct Change {
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    pub text: String,
    pub reason: Option<String>,
    pub partial: bool,
    pub baseline: Option<String>,
    pub unmeasured: bool,
    pub patch_omitted: bool,
    /// Matches the hash of a first state whose bytes were not kept: not listed, but it does not
    /// let the review vouch for the set either.
    pub hidden: bool,
    pub record_patch: String,
    pub record_name: String,
}

fn partial_change(status: &str, reason: &str, baseline: Option<&str>) -> Change {
    Change { status: status.into(), reason: Some(reason.into()), partial: true, baseline: baseline.map(str::to_owned), ..Change::default() }
}

fn too_large_change(status: &str) -> Change {
    Change { status: status.into(), patch_omitted: true, ..Change::default() }
}

fn baseline_gap(entry: &Entry, status: &str) -> Change {
    let mut change = partial_change(status, baseline_reason(&entry.status), Some(&entry.status));
    change.binary = entry.status == "omitted-binary";
    change
}

fn unvouched_unchanged() -> Change {
    Change { hidden: true, partial: true, ..Change::default() }
}

fn from_measured(m: super::named::Measured) -> Change {
    Change { status: m.status.to_string(), additions: m.additions, deletions: m.deletions, binary: m.binary, text: m.text, ..Change::default() }
}

fn slash_path(value: &str) -> String {
    clean(value).replace('\\', "/")
}

fn is_outside_path(path: &str) -> bool {
    super::disk::is_outside_path(path)
}

fn absolute_path(root: &str, path: &str) -> String {
    if is_outside_path(path) { nodepath::resolve_host(&[path]) } else { nodepath::resolve_host(&[root, path]) }
}

fn inside_directory(parent: &str, child: &str) -> bool {
    let rel = nodepath::relative_host(parent, child);
    rel.is_empty() || (!nodepath::is_absolute_host(&rel) && nodepath::split_segments(&rel).first().copied() != Some(".."))
}

/// An absolute file under the link rules of `currentText`: relative to its recorded root when
/// inside it, else its exact path.
fn file_ref(root: &str, abs: &str) -> (String, String) {
    if !root.is_empty() && inside_directory(root, abs) {
        (root.to_owned(), nodepath::relative_host(root, abs))
    } else {
        let parent = std::path::Path::new(abs).parent().map_or_else(|| ".".to_owned(), |p| p.display().to_string());
        (parent, abs.to_owned())
    }
}

fn current_sig(current: &CurrentFile) -> String {
    match current {
        CurrentFile::Present { sig, .. } => sig.clone(),
        CurrentFile::Absent => "absent".into(),
        CurrentFile::Unsafe => "unsafe".into(),
    }
}

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A unit the review names, measured or not.
struct Unit {
    key: String,
    abs: String,
    root: String,
    old_abs: Option<String>,
    old_root: Option<String>,
    change: Option<Change>,
    name_only: bool,
}

impl Inner {
    async fn current_of(&self, root: &str, abs: &str) -> CurrentFile {
        let (r, p) = file_ref(root, abs);
        self.disk.current_file(&r, &p).await
    }

    /// Bytes of a present file up to the file-patch read's cap; `None` past it or unreadable.
    async fn current_bytes(&self, current: &CurrentFile) -> Option<Vec<u8>> {
        let CurrentFile::Present { file, size, .. } = current else { return None };
        if *size > REVIEW_FILE_PATCH_SHOW_MAX_BYTES as u64 {
            return None;
        }
        self.disk.read_bounded(file, REVIEW_FILE_PATCH_SHOW_MAX_BYTES as u64).await
    }

    /// Whether a present file still holds the baseline's bytes; `None` when that cannot be told.
    async fn same_as_baseline(&self, entry: &Entry, current: &CurrentFile, after: Option<&[u8]>) -> Option<bool> {
        let CurrentFile::Present { file, size, .. } = current else { return None };
        if entry.size > 0 && entry.size != *size {
            return Some(false);
        }
        let sha = entry.sha256.as_ref()?;
        let hash = match after {
            Some(bytes) => Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect(),
            None => self.disk.file_digest(file, DIGEST_MAX_BYTES).await?,
        };
        Some(&hash == sha)
    }

    /// One file (or rename) measured from its first-seen state to the disk now; `None` when the
    /// session left it as it found it.
    async fn measure_baseline(&self, entry: &Entry, current: &CurrentFile, renamed: bool, loaded: &Loaded, budget: &mut LineDiffBudget) -> Option<Change> {
        let changed = if renamed { "R" } else { "M" };
        if matches!(current, CurrentFile::Unsafe) {
            return Some(partial_change(if entry.state == "absent" { "A" } else { changed }, UNREADABLE_REASON, None));
        }
        let present = matches!(current, CurrentFile::Present { .. });
        let after: Option<Vec<u8>> = if present { self.current_bytes(current).await } else { Some(Vec::new()) };
        // `after` is None when the present file is too large to read; absent files are measured as
        // absent content below.
        let after_content = |bytes: &Option<Vec<u8>>| if present { bytes.as_ref().map(|b| ReviewContent::bytes(b.clone())) } else { Some(ReviewContent::Absent) };
        if entry.state == "absent" {
            if !present {
                return None;
            }
            let Some(content) = after_content(&after) else { return Some(too_large_change("A")) };
            return Some(from_measured(measure_change(&self.differ, &ReviewContent::Absent, &content, false, budget)));
        }
        if present {
            let same = self.same_as_baseline(entry, current, after.as_deref()).await;
            let exact = entry.status == "captured";
            if same == Some(true) && !renamed {
                return if exact { None } else { Some(unvouched_unchanged()) };
            }
            if same == Some(true) {
                let moved = from_measured(measure_change(&self.differ, &ReviewContent::bytes(Vec::new()), &ReviewContent::bytes(Vec::new()), true, budget));
                return Some(if exact {
                    moved
                } else {
                    Change { partial: true, baseline: Some(entry.status.clone()), reason: Some(baseline_reason(&entry.status).into()), ..moved }
                });
            }
            if same.is_none() || !exact {
                return Some(baseline_gap(entry, changed));
            }
        }
        let before = if entry.status == "captured" { loaded.read_blob(entry).await } else { None };
        let Some(before) = before else {
            let gap = if entry.status == "captured" { Entry { status: "evicted".into(), ..entry.clone() } } else { entry.clone() };
            return Some(baseline_gap(&gap, if present { changed } else { "D" }));
        };
        let Some(content) = after_content(&after) else { return Some(too_large_change(changed)) };
        Some(from_measured(measure_change(&self.differ, &ReviewContent::bytes(before), &content, renamed, budget)))
    }

    /// Every baseline not `covered` by another source, measured against the disk within the
    /// review's line-diff `budget`. A path holding a renamed file pairs with the path it came
    /// from when that one is gone. With `target` only the units it matches are measured, with
    /// their whole text; every other unit is returned `name_only`.
    async fn baseline_changes(&self, loaded: &Loaded, covered: &(dyn Fn(&str) -> bool + Sync), unvouched: &mut IndexSet<String>, budget: &mut LineDiffBudget, target: Option<&(dyn Fn(&Entry) -> bool + Sync)>) -> Vec<Unit> {
        let mut entries: IndexMap<String, &Entry> = IndexMap::new();
        for entry in &loaded.files {
            if !covered(&entry.path) {
                entries.insert(entry.key.clone(), entry);
            }
        }
        let mut current: IndexMap<String, CurrentFile> = IndexMap::new();
        for entry in entries.values() {
            current.insert(entry.key.clone(), self.current_of(&entry.root, &entry.path).await);
        }
        let mut paired: IndexSet<String> = IndexSet::new();
        // (before, after) per unit.
        let mut units: Vec<(String, &Entry, &Entry)> = Vec::new();
        for (destination_key, origin_key) in &loaded.renames {
            let (Some(destination), Some(origin)) = (entries.get(destination_key), entries.get(origin_key)) else { continue };
            if paired.contains(destination_key) || paired.contains(origin_key) {
                continue;
            }
            if destination.state != "absent" || origin.state == "absent" {
                continue;
            }
            if matches!(current[destination_key], CurrentFile::Absent) || !matches!(current[origin_key], CurrentFile::Absent) {
                continue;
            }
            paired.insert(destination_key.clone());
            paired.insert(origin_key.clone());
            units.push((format!("{origin_key}\0{destination_key}"), origin, destination));
        }
        for entry in entries.values() {
            if !paired.contains(&entry.key) {
                units.push((entry.key.clone(), entry, entry));
            }
        }
        let mut out = Vec::new();
        for (unit_key, before, after) in units {
            let renamed = before.key != after.key;
            let mut unit = Unit {
                key: after.key.clone(),
                abs: after.path.clone(),
                root: after.root.clone(),
                old_abs: renamed.then(|| before.path.clone()),
                old_root: renamed.then(|| before.root.clone()),
                change: None,
                name_only: false,
            };
            let now = &current[&after.key];
            let sig = [
                before.state.clone(),
                before.status.clone(),
                before.sha256.clone().unwrap_or_default(),
                before.blob.clone().unwrap_or_default(),
                mixdog_js::number_to_string(before.at),
                mixdog_js::number_to_string(after.at),
                current_sig(now),
                current_sig(current.get(&before.key).unwrap_or(&CurrentFile::Absent)),
            ]
            .join("|");
            let cached = loaded.cache_get(&unit_key);
            if let Some(target) = target
                && !target(after) && !target(before) {
                    // Not measured: it names a file unless the cache knows it is unchanged.
                    let unchanged = cached.as_ref().is_some_and(|c| c.sig == sig && c.change.as_ref().is_none_or(|ch| ch.hidden));
                    if !unchanged {
                        unit.name_only = true;
                        out.push(unit);
                    }
                    continue;
                }
            // A file's own patch read measures again what was cached without its text.
            let hit = cached.as_ref().filter(|c| c.sig == sig && !(target.is_some() && c.stripped));
            let change: Option<Change> = match hit {
                Some(c) => c.change.clone(),
                None => {
                    let whole = self.measure_baseline(before, now, renamed, loaded, budget).await;
                    let inline = whole.as_ref().map(inline_change);
                    // Once the budget is spent a diff may have been cut short to the replacement
                    // hunk: such a measurement is not kept, a later review measures it again.
                    if budget.remaining_ms > 0.0 && inline.as_ref().map_or(0, |c| c.text.len()) <= CACHED_PATCH_MAX_BYTES {
                        let stripped = match (&inline, &whole) {
                            (Some(i), Some(w)) => i.patch_omitted != w.patch_omitted || i.text != w.text,
                            _ => false,
                        };
                        loaded.cache_set(&unit_key, CachedRow { sig: sig.clone(), change: inline.clone(), stripped });
                    }
                    if target.is_some() { whole } else { inline }
                }
            };
            if change.as_ref().is_some_and(|c| c.hidden) {
                unvouched.insert(after.key.clone());
            }
            match change {
                Some(change) if !change.hidden => {
                    unit.change = Some(change);
                    out.push(unit);
                }
                _ => {}
            }
        }
        out
    }

    /// Files of the retained turn records that no baseline lists — a session recorded before
    /// baselines existed. Never exact. Also returns the baseline keys such older records
    /// touched: those baselines were first seen after an unrecorded edit.
    async fn legacy_changes(&self, records: &[SharedRecord], kinds: &[&str], listed: &IndexSet<String>, covered: &(dyn Fn(&str) -> bool + Sync), since: f64, budget: &mut LineDiffBudget) -> (Vec<Unit>, IndexSet<String>) {
        struct Group {
            key: String,
            abs: String,
            root: String,
            file: Obj,
            first: Obj,
            turns: u32,
            old_abs: Option<String>,
            old_root: Option<String>,
        }
        let mut groups: IndexMap<String, Group> = IndexMap::new();
        let mut late: IndexSet<String> = IndexSet::new();
        for record in records {
            let root = clean(obj_str(record, "root")).to_owned();
            let mut entries: Vec<Obj> = Vec::new();
            if kinds.contains(&obj_str(record, "kind")) {
                entries.extend(record.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_object().cloned()));
            }
            entries.extend(record.get("outside").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_object().cloned()));
            for file in entries {
                if obj_str(&file, "path").is_empty() || obj_str(&file, "state") == "reverted" {
                    continue;
                }
                let abs = absolute_path(&root, obj_str(&file, "path"));
                let key = change_path_key(&abs);
                let old_abs = (!obj_str(&file, "oldPath").is_empty()).then(|| absolute_path(&root, obj_str(&file, "oldPath")));
                if covered(&abs) {
                    continue;
                }
                if listed.contains(&key) || old_abs.as_ref().is_some_and(|o| listed.contains(&change_path_key(o))) {
                    let created = mixdog_js::to_number_of(record.get("createdAt"));
                    if !matches!(created.partial_cmp(&since), Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)) {
                        late.insert(key);
                    }
                    continue;
                }
                let prior_key = if groups.contains_key(&key) { Some(key.clone()) } else { old_abs.as_ref().map(|o| change_path_key(o)).filter(|k| groups.contains_key(k)) };
                let prior = prior_key.and_then(|k| groups.shift_remove(&k));
                let (origin_abs, origin_root) = match (&prior, &old_abs) {
                    (Some(p), _) => (p.old_abs.clone(), p.old_root.clone()),
                    (None, Some(o)) => (Some(o.clone()), Some(root.clone())),
                    _ => (None, None),
                };
                groups.insert(
                    key.clone(),
                    Group {
                        key,
                        abs,
                        root: root.clone(),
                        first: prior.as_ref().map_or_else(|| file.clone(), |p| p.first.clone()),
                        turns: prior.as_ref().map_or(0, |p| p.turns) + 1,
                        file,
                        old_abs: origin_abs,
                        old_root: origin_root,
                    },
                );
            }
        }
        let mut changes = Vec::new();
        for group in groups.into_values() {
            let (file, first) = (&group.file, &group.first);
            if group.turns > 1 && obj_str(first, "status") == "A" && obj_str(file, "status") == "D" {
                continue;
            }
            let mut unit = Unit { key: group.key.clone(), abs: group.abs.clone(), root: group.root.clone(), old_abs: group.old_abs.clone(), old_root: group.old_root.clone(), change: None, name_only: false };
            if group.turns > 1 {
                let status = if obj_str(first, "status") == "A" { "A" } else { obj_str(file, "status") };
                let mut change = partial_change(status, SEVERAL_TURNS_REASON, Some("missing"));
                change.unmeasured = true;
                unit.change = Some(change);
                changes.push(unit);
                continue;
            }
            let measured = self.measure_legacy_change_file(file.clone(), &group.root, budget).await;
            let record_patch = patch_of(&measured);
            let additions = mixdog_js::to_number_of(measured.get("additions"));
            let deletions = mixdog_js::to_number_of(measured.get("deletions"));
            let (additions, deletions) = (if additions.is_nan() { 0.0 } else { additions } as u64, if deletions.is_nan() { 0.0 } else { deletions } as u64);
            let binary = measured.get("binary").is_some_and(|b| b != &Value::Bool(false) && b != &Value::Null);
            let counts = additions + deletions;
            let unmeasured = record_patch.is_empty() && counts == 0 && !binary;
            let reason = clean(obj_str(file, "reason"));
            unit.change = Some(Change {
                status: obj_str(file, "status").to_owned(),
                additions,
                deletions,
                binary,
                record_patch: record_patch.clone(),
                record_name: slash_path(obj_str(file, "path")),
                partial: true,
                baseline: Some("missing".into()),
                unmeasured,
                reason: unmeasured.then(|| if reason.is_empty() { baseline_reason("missing").to_owned() } else { reason.to_owned() }),
                patch_omitted: record_patch.is_empty() && file.get("patchOmitted") == Some(&Value::Bool(true)),
                ..Change::default()
            });
            changes.push(unit);
        }
        (changes, late)
    }

    /// Files the session claims but no baseline or record lists: the ones still present are
    /// listed without a diff.
    async fn missing_changes(&self, refs: Vec<(String, String)>, listed: &mut IndexSet<String>, covered: &(dyn Fn(&str) -> bool + Sync)) -> Vec<(Unit, bool)> {
        let mut files = Vec::new();
        for (root, abs) in refs {
            let key = change_path_key(&abs);
            if listed.contains(&key) || covered(&abs) {
                continue;
            }
            listed.insert(key.clone());
            files.push((key, abs, root));
        }
        let mut out = Vec::new();
        for (key, abs, root) in files {
            let gone = matches!(self.current_of(&root, &abs).await, CurrentFile::Absent);
            let change = (!gone).then(|| partial_change("M", baseline_reason("missing"), Some("missing")));
            out.push((Unit { key, abs, root, old_abs: None, old_root: None, change, name_only: false }, gone));
        }
        out
    }

    /// The session-wide review: the Git baseline review (`base`) completed with every file it
    /// does not cover, measured from its first-seen state against the disk now. `file` answers
    /// that one file's patch instead.
    pub(super) async fn session_change_review(&self, base: &Obj, loaded: Option<&Loaded>, records: &[SharedRecord], target: &str) -> Obj {
        let source = obj_str(base, "source").to_owned();
        let git_backed = source == "git";
        let base_root = clean(obj_str(base, "root")).to_owned();
        let covered = |abs: &str| git_backed && !base_root.is_empty() && inside_directory(&base_root, abs);
        let mut listed: IndexSet<String> = loaded.map(|l| l.files.iter().map(|e| e.key.clone()).collect()).unwrap_or_default();
        let kinds: &[&str] = if git_backed {
            &[]
        } else if source == "absent" || source == "unavailable" {
            &["git", "tracked"]
        } else {
            &["tracked"]
        };
        // Baselines nothing is listed for, yet whose emptiness cannot be vouched for.
        let mut unvouched: IndexSet<String> = IndexSet::new();
        // One line-diff budget for the whole review pass.
        let mut budget = LineDiffBudget::default();
        let target_key = if clean(target).is_empty() { String::new() } else { change_path_key(target) };
        let targeted = |entry: &Entry| {
            change_path_key(&entry.path) == target_key
                || (!entry.root.is_empty() && inside_directory(&entry.root, &entry.path) && change_path_key(&nodepath::relative_host(&entry.root, &entry.path)) == target_key)
        };
        let baseline_target: Option<&(dyn Fn(&Entry) -> bool + Sync)> = if target_key.is_empty() { None } else { Some(&targeted) };
        let baseline_units = match loaded {
            Some(l) => self.baseline_changes(l, &covered, &mut unvouched, &mut budget, baseline_target).await,
            None => Vec::new(),
        };
        // Units named but not measured still claim their names.
        let (named_only, measured): (Vec<Unit>, Vec<Unit>) = baseline_units.into_iter().partition(|u| u.name_only);
        let since = loaded.map_or(f64::INFINITY, |l| if l.created_at != 0.0 { l.created_at } else { f64::INFINITY });
        let (legacy_changes, late) = self.legacy_changes(records, kinds, &listed, &covered, since, &mut budget).await;
        for change in &legacy_changes {
            listed.insert(change.key.clone());
        }
        // Owned files of the non-Git root, and paths whose first state a clear in another process
        // removed.
        let mut refs: Vec<(String, String)> = loaded.map(|l| l.missing.iter().map(|m| (m.root.clone(), m.path.clone())).collect()).unwrap_or_default();
        if !git_backed {
            for path in base.get("owned").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                refs.push((base_root.clone(), absolute_path(&base_root, path)));
            }
        }
        let missing = self.missing_changes(refs, &mut listed, &covered).await;
        let mut measured = measured;
        for unit in &mut measured {
            if late.contains(&unit.key)
                && let Some(change) = &mut unit.change {
                    change.partial = true;
                    change.reason = Some(SEVERAL_TURNS_REASON.into());
                }
        }
        let missing_count = missing.len();
        let mut changes: Vec<Unit> = measured;
        changes.extend(legacy_changes);
        changes.extend(missing.into_iter().filter(|(u, _)| u.change.is_some()).map(|(u, _)| u));
        let base_files: Vec<Obj> = if git_backed { base.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_object().cloned()).collect() } else { Vec::new() };
        let base_patch = if git_backed { base.get("patch").and_then(Value::as_str).unwrap_or("").to_owned() } else { String::new() };
        // A relative name shared by different roots (or with a Git file) is shown absolute, so
        // each file stays distinct.
        let name_of = |abs: &str, root: &str| if !root.is_empty() && inside_directory(root, abs) { slash_path(&nodepath::relative_host(root, abs)) } else { slash_path(abs) };
        let mut owners: IndexMap<String, IndexSet<String>> = IndexMap::new();
        let mut claim = |name: &str, abs: &str| {
            if is_outside_path(name) {
                return;
            }
            owners.entry(change_path_key(name)).or_default().insert(change_path_key(abs));
        };
        for file in &base_files {
            let path = obj_str(file, "path");
            if !path.is_empty() {
                claim(path, &nodepath::resolve_host(&[&base_root, path]));
            }
        }
        for unit in changes.iter().chain(named_only.iter()) {
            claim(&name_of(&unit.abs, &unit.root), &unit.abs);
            if let (Some(old_abs), Some(old_root)) = (&unit.old_abs, &unit.old_root) {
                claim(&name_of(old_abs, old_root), old_abs);
            }
        }
        let show = |abs: &str, root: &str| {
            let name = name_of(abs, root);
            if is_outside_path(&name) || owners.get(&change_path_key(&name)).map_or(0, IndexSet::len) <= 1 { name } else { slash_path(abs) }
        };
        let mut rows: Vec<(Obj, String)> = Vec::new();
        for unit in &changes {
            let Some(change) = &unit.change else { continue };
            let path = show(&unit.abs, &unit.root);
            let old_name = match (&unit.old_abs, &unit.old_root) {
                (Some(a), Some(r)) => show(a, r),
                _ => path.clone(),
            };
            let mut patch = String::new();
            if !change.text.is_empty() {
                patch = name_measured_patch(&change.text, &old_name, &path);
            } else if !change.record_patch.is_empty() && change.record_name == path {
                patch = change.record_patch.clone();
            }
            let mut row = Obj::new();
            row.insert("path".into(), path.clone().into());
            row.insert("id".into(), slash_path(&unit.abs).into());
            row.insert("outside".into(), Value::Bool(unit.root.is_empty() || !inside_directory(&unit.root, &unit.abs)));
            if old_name != path {
                row.insert("oldPath".into(), old_name.into());
            }
            row.insert("status".into(), change.status.clone().into());
            row.insert("additions".into(), Value::from(change.additions));
            row.insert("deletions".into(), Value::from(change.deletions));
            if change.binary {
                row.insert("binary".into(), Value::Bool(true));
            }
            if let Some(reason) = &change.reason {
                row.insert("reason".into(), reason.clone().into());
            }
            if let Some(baseline) = &change.baseline {
                row.insert("baseline".into(), baseline.clone().into());
            }
            if change.unmeasured {
                row.insert("unmeasured".into(), Value::Bool(true));
            }
            // Its patch is past what can be kept or read: listed too large.
            if change.patch_omitted && patch.is_empty() {
                row.insert("patchOmitted".into(), Value::Bool(true));
                row.insert("reason".into(), PATCH_TOO_LARGE.into());
            }
            rows.push((row, patch));
        }
        rows.sort_by(|a, b| utf16_cmp(obj_str(&a.0, "path"), obj_str(&b.0, "path")));
        if !clean(target).is_empty() {
            let key = change_path_key(target);
            let row = rows.iter().find(|(r, _)| change_path_key(obj_str(r, "id")) == key || change_path_key(obj_str(r, "path")) == key);
            if let Some((row, patch)) = row
                && row.get("patchOmitted") == Some(&Value::Bool(true)) && patch.is_empty() {
                    let mut reply = file_patch_reply(obj_str(row, "path"), "", REVIEW_FILE_PATCH_SHOW_MAX_BYTES);
                    for (k, v) in patch_omitted_file(Obj::new()) {
                        reply.insert(k, v);
                    }
                    return reply;
                }
            return file_patch_reply(
                &row.map_or_else(|| slash_path(target), |(r, _)| obj_str(r, "path").to_owned()),
                row.map_or("", |(_, p)| p.as_str()),
                REVIEW_FILE_PATCH_SHOW_MAX_BYTES,
            );
        }
        // The merged response stays bounded: a file past the per-file cap or the total left is
        // listed with its counts but without its diff.
        let mut budget = ReviewPatchBudget::new(REVIEW_PATCH_MAX_BYTES as i64 - base_patch.len() as i64);
        let mut files: Vec<Obj> = Vec::new();
        let mut patches: Vec<String> = Vec::new();
        for (file, patch) in rows {
            let mut file = file;
            if !patch.is_empty() && budget.admit(patch.len()) {
                patches.push(patch);
            } else if !patch.is_empty() {
                file = patch_omitted_file(file);
            }
            files.push(file);
        }
        // A baseline first seen after an older recorded edit was not the session's first state:
        // even with no row it cannot vouch for the set. Baselines the disk refused (`unsaved`)
        // are known only to this process.
        let partial = loaded.is_some_and(|l| l.incomplete || l.unsaved) || !unvouched.is_empty() || !late.is_empty() || missing_count > 0 || changes.iter().any(|c| c.change.as_ref().is_some_and(|ch| ch.partial));
        let vouched = (git_backed || source == "empty" || loaded.is_some()) && !partial;
        let mut all: Vec<Obj> = base_files;
        all.extend(files);
        let mut kept = base.clone();
        for key in ["source", "reason", "owned", "diffTooLarge"] {
            kept.shift_remove(key);
        }
        // An unavailable Git baseline with nothing else to list stays unavailable.
        if all.is_empty() && !vouched && kept.get("supported") == Some(&Value::Bool(false)) {
            if let Some(reason) = base.get("reason") {
                kept.insert("reason".into(), reason.clone());
            }
            return kept;
        }
        let join = if base_patch.ends_with('\n') || base_patch.is_empty() { "" } else { "\n" };
        let patch = std::iter::once(base_patch.clone()).chain(patches).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(join);
        kept.insert("supported".into(), Value::Bool(true));
        // Emptiness is claimed only when it can be vouched for.
        kept.insert("authoritative".into(), Value::Bool(!all.is_empty() || vouched));
        if vouched {
            kept.insert("complete".into(), Value::Bool(true));
        }
        if partial {
            kept.insert("partial".into(), Value::Bool(true));
        }
        if loaded.is_some_and(|l| l.unsaved) {
            kept.insert("baselinesUnsaved".into(), Value::Bool(true));
        }
        let too_large = review_diff_too_large(&all, &patch);
        kept.insert("files".into(), Value::Array(all.into_iter().map(Value::Object).collect()));
        kept.insert("patch".into(), patch.into());
        kept.insert("patchTruncated".into(), Value::Bool(git_backed && base.get("patchTruncated") == Some(&Value::Bool(true))));
        if too_large {
            kept.insert("diffTooLarge".into(), Value::Bool(true));
        }
        if kept.get("snapshotKind").is_none_or(|v| v.as_str().is_none_or(|s| s.is_empty())) {
            kept.insert("snapshotKind".into(), "session".into());
        }
        kept
    }
}

/// A list measurement as a reply keeps it: text past the per-file inline cap is dropped at once,
/// its counts kept and the file marked too large.
fn inline_change(change: &Change) -> Change {
    if change.text.len() <= REVIEW_FILE_PATCH_MAX_BYTES {
        return change.clone();
    }
    Change { text: String::new(), patch_omitted: true, ..change.clone() }
}

// ── The scope and the Git side ───────────────────────────────────────────────────────

struct Scope {
    tracker: Option<Arc<Tracker>>,
    stored: Option<Obj>,
    root: String,
    owned_paths: IndexSet<String>,
    baseline_tree: String,
    baseline_files: Vec<Value>,
}

fn scope_matches_worktree(scope: &Obj, worktree: &str, tracker: Option<&Arc<Tracker>>) -> bool {
    let root = path_key(obj_str(scope, "root"));
    let tracked_root = tracker.and_then(|t| t.snapshot()).map(|s| path_key(&s.root())).unwrap_or_default();
    if !tracked_root.is_empty() {
        return root == tracked_root;
    }
    let resolved = nodepath::resolve_host(&[if clean(worktree).is_empty() { "." } else { clean(worktree) }]);
    let requested = path_key(&resolved).trim_end_matches(['/', '\\']).to_owned();
    if root.is_empty() || requested.is_empty() {
        return false;
    }
    let sep = if cfg!(windows) { '\\' } else { '/' };
    requested == root || requested.starts_with(&format!("{root}{sep}"))
}

/// `value` (absolute, or relative to `root`) as a path relative to `root`; `None` outside it.
fn relative_inside(root: &str, value: &str) -> Option<String> {
    let target = clean(value);
    if root.is_empty() || target.is_empty() {
        return None;
    }
    let base = nodepath::resolve_host(&[root]);
    let abs = if nodepath::is_absolute_host(target) { nodepath::resolve_host(&[target]) } else { nodepath::resolve_host(&[root, target]) };
    let rel = nodepath::relative_host(&base, &abs);
    if rel.is_empty() || nodepath::is_absolute_host(&rel) || nodepath::split_segments(&rel).contains(&"..") {
        return None;
    }
    Some(rel.replace('\\', "/"))
}

impl Inner {
    /// What the session review diffs inside a Git root: the stored scope (or live tracker) of
    /// this worktree, the paths the session owns there, and its earliest baseline tree with the
    /// recorded first states that complete it.
    async fn session_review_scope(&self, worktree: &str, owner: &str) -> Scope {
        let tracker = self.tracker_of(owner);
        let scopes = self.store.load_session_snapshot_records(owner).await;
        let stored = scopes.iter().filter_map(Value::as_object).find(|s| scope_matches_worktree(s, worktree, tracker.as_ref())).cloned();
        let snapshot = tracker.as_ref().and_then(|t| t.snapshot());
        let stored_str = |k: &str| stored.as_ref().map(|s| obj_str(s, k).to_owned()).unwrap_or_default();
        let root = [stored_str("root"), snapshot.as_ref().map(|s| s.root()).unwrap_or_default(), clean(worktree).to_owned()].into_iter().find(|r| !r.is_empty()).unwrap_or_default();
        let tool_files: Vec<String> = stored.as_ref().and_then(|s| s.get("toolFiles")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        let mut owned_paths: IndexSet<String> = tool_files.iter().cloned().collect();
        if let Some(tracker) = &tracker {
            let owned = tracker.lock().owned_paths.clone();
            owned_paths.extend(owned_paths_under(&root, &owned));
        }
        let baseline_tree = [stored_str("baselineTree"), snapshot.as_ref().map(|s| s.baseline_tree()).unwrap_or_default()].into_iter().find(|t| !t.is_empty()).unwrap_or_default();
        let mut baseline_files: IndexMap<String, Value> = IndexMap::new();
        for entry in stored.as_ref().and_then(|s| s.get("baselineFiles")).and_then(Value::as_array).into_iter().flatten() {
            baseline_files.insert(path_key(entry.get("path").and_then(Value::as_str).unwrap_or("")), entry.clone());
        }
        let stored_paths: IndexSet<String> = tool_files.iter().map(|p| path_key(p)).collect();
        for entry in snapshot.map(|s| s.baseline_files()).unwrap_or_default() {
            let key = path_key(entry.get("path").and_then(Value::as_str).unwrap_or(""));
            if !stored_paths.contains(&key) {
                baseline_files.insert(key, entry);
            }
        }
        Scope { tracker, stored, root, owned_paths, baseline_tree, baseline_files: baseline_files.into_values().collect() }
    }

    fn resume_scope(scope: &Scope) -> ResumeScope {
        ResumeScope { paths: scope.owned_paths.iter().cloned().collect(), baseline_files: scope.baseline_files.clone() }
    }

    async fn baseline_session_review_diff(&self, worktree: &str, owner: &str) -> Obj {
        let scope = self.session_review_scope(worktree, owner).await;
        // A running turn is still mutating the worktree: shell, office and script edits only reach
        // the checkpoint diff once it is refreshed, exactly as the turn review bar does.
        if let Some(tracker) = &scope.tracker
            && let Some(snapshot) = tracker.snapshot()
                && !tracker.sealed() {
                    snapshot.refresh(false).await;
                }
        let mut reply = Obj::new();
        let owned: Vec<Value> = scope.owned_paths.iter().cloned().map(Value::from).collect();
        if scope.owned_paths.is_empty() {
            // Authoritatively empty only when the session left ownership metadata behind (a stored
            // scope, a live tracker, or a deleted history); with none, the retained change records
            // are the only memory of what it changed.
            let known = scope.stored.is_some() || scope.tracker.is_some() || self.store.session_change_history_cleared(owner).await;
            reply.insert("supported".into(), Value::Bool(true));
            reply.insert("root".into(), scope.root.into());
            reply.insert("files".into(), Value::Array(Vec::new()));
            reply.insert("patch".into(), "".into());
            reply.insert("snapshotKind".into(), "session".into());
            reply.insert("authoritative".into(), Value::Bool(true));
            reply.insert("source".into(), if known { "empty" } else { "absent" }.into());
            return reply;
        }
        if !scope.root.is_empty() && !scope.baseline_tree.is_empty()
            && let Some(snapshot) = self.worktrees.resume(&scope.root, &scope.baseline_tree, &Self::resume_scope(&scope)).await {
                let review = snapshot.review();
                reply.insert("supported".into(), Value::Bool(true));
                reply.insert("root".into(), scope.root.into());
                reply.insert("files".into(), Value::Array(review.files.into_iter().map(Value::Object).collect()));
                reply.insert("patch".into(), review.patch.into());
                reply.insert("patchTruncated".into(), Value::Bool(review.patch_truncated));
                reply.insert("snapshotKind".into(), "session".into());
                reply.insert("authoritative".into(), Value::Bool(true));
                reply.insert("source".into(), "git".into());
                return reply;
            }
        // A non-Git first turn still has an exact apply_patch tracker. It cannot cross a runtime
        // restart, but remains preferable to widening into unrelated files.
        if scope.tracker.as_ref().is_some_and(|t| t.lock().valid) {
            reply.insert("supported".into(), Value::Bool(true));
            reply.insert("root".into(), scope.root.into());
            reply.insert("files".into(), Value::Array(Vec::new()));
            reply.insert("patch".into(), "".into());
            reply.insert("snapshotKind".into(), "session-tool".into());
            reply.insert("authoritative".into(), Value::Bool(true));
            reply.insert("source".into(), "tool".into());
            reply.insert("owned".into(), Value::Array(owned));
            return reply;
        }
        reply.insert("supported".into(), Value::Bool(false));
        reply.insert("root".into(), scope.root.into());
        reply.insert("files".into(), Value::Array(Vec::new()));
        reply.insert("patch".into(), "".into());
        reply.insert("snapshotKind".into(), "session".into());
        reply.insert("authoritative".into(), Value::Bool(false));
        reply.insert("reason".into(), "session baseline is unavailable".into());
        reply.insert("source".into(), "unavailable".into());
        reply.insert("owned".into(), Value::Array(owned));
        reply
    }

    /// The session's net change (`getSessionReviewDiff`).
    pub(super) async fn session_review_diff(&self, worktree: &str, session_id: &str) -> Obj {
        if self.cfg.disabled {
            let mut o = Obj::new();
            o.insert("supported".into(), Value::Bool(false));
            o.insert("files".into(), Value::Array(Vec::new()));
            o.insert("patch".into(), "".into());
            return o;
        }
        let owner = clean(session_id).to_owned();
        if owner.is_empty() {
            let mut o = Obj::new();
            o.insert("supported".into(), Value::Bool(true));
            o.insert("files".into(), Value::Array(Vec::new()));
            o.insert("patch".into(), "".into());
            o.insert("authoritative".into(), Value::Bool(true));
            return o;
        }
        let review = self.baseline_session_review_diff(worktree, &owner).await;
        let loaded = self.baselines.load(&owner).await;
        // Read through the mtime-keyed cache: only files no baseline knows come from them.
        let records = self.store.load_turn_change_records(&owner).await;
        self.session_change_review(&review, loaded.as_ref(), &records, "").await
    }

    /// One file of the session review with its whole patch (`getSessionReviewFilePatch`).
    pub(super) async fn session_review_file_patch(&self, worktree: &str, session_id: &str, file: &str, old_path: &str) -> Obj {
        let path = slash_path(file);
        let reply = |supported: bool, patch: &str| {
            let mut o = Obj::new();
            o.insert("supported".into(), Value::Bool(supported));
            o.insert("path".into(), path.clone().into());
            o.insert("patch".into(), patch.into());
            o
        };
        if self.cfg.disabled {
            return reply(false, "");
        }
        let owner = clean(session_id).to_owned();
        if owner.is_empty() || path.is_empty() {
            return reply(true, "");
        }
        let scope = self.session_review_scope(worktree, &owner).await;
        let rel = if scope.baseline_tree.is_empty() { None } else { relative_inside(&scope.root, &path) };
        if let Some(rel) = &rel {
            // Each target is authorized on its own: an unowned file is never read, an unowned
            // rename source never joins its diff.
            let owned: IndexSet<String> = scope.owned_paths.iter().map(|p| path_key(p)).collect();
            if !owned.contains(&path_key(rel)) {
                return reply(true, "");
            }
            let source = relative_inside(&scope.root, old_path).unwrap_or_default();
            let old_rel = if !source.is_empty() && owned.contains(&path_key(&source)) { source } else { String::new() };
            if let Some(result) = self.worktrees.resume_file_patch(&scope.root, &scope.baseline_tree, &Self::resume_scope(&scope), rel, &old_rel, REVIEW_FILE_PATCH_SHOW_MAX_BYTES).await {
                let mut o = Obj::new();
                o.insert("supported".into(), Value::Bool(true));
                o.insert("path".into(), path.clone().into());
                for (k, v) in result {
                    o.insert(k, v);
                }
                return o;
            }
        }
        // Beside a Git baseline a file outside its root is measured from its first state; the
        // Git side's own files need no diff for that.
        let base = if rel.is_none() && !scope.baseline_tree.is_empty() && !scope.root.is_empty() {
            let mut b = Obj::new();
            b.insert("supported".into(), Value::Bool(true));
            b.insert("root".into(), scope.root.clone().into());
            b.insert("files".into(), Value::Array(Vec::new()));
            b.insert("patch".into(), "".into());
            b.insert("source".into(), "git".into());
            b
        } else {
            self.baseline_session_review_diff(worktree, &owner).await
        };
        let loaded = self.baselines.load(&owner).await;
        let records = self.store.load_turn_change_records(&owner).await;
        self.session_change_review(&base, loaded.as_ref(), &records, &path).await
    }
}
