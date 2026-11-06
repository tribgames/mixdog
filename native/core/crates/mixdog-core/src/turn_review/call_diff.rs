//! The per-call card diff (Node `patch/ui-diff.mjs`): the change one tool call made, from its own
//! before and after states, and the side channel the tool card picks it up from. Display only.

use std::sync::Mutex;

use mixdog_core_api::turn_review::ReviewContent;
use mixdog_js::js_trim;

use super::content::decode_text;
use super::content::is_omitted;
use super::content::raw_bytes;
use super::line_diff::LineDiffBudget;
use super::line_diff::LineDiffer;
use super::line_diff::unified_hunks_body;
use super::nodepath;
use super::review_diff::bound_review_patch;

const APPLY_PATCH_UI_DIFF_MAX_CHARS: usize = 64 * 1024;
const APPLY_PATCH_UI_DIFF_REGISTRY_MAX: usize = 64;

/// One file's change as the review folds it: the call's own states under the display names the
/// tools showed. A rename carries the destination too.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TrackedChange {
    pub path: String,
    pub display_path: String,
    pub new_path: Option<String>,
    pub new_display_path: Option<String>,
    pub before: ReviewContent,
    pub after: ReviewContent,
    /// The line counts of the call's own diff; a fold that measured nothing (Undo/Reapply)
    /// reports none.
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

/// `patchHeaderPathForResolved(basePath, fullPath)`: the path relative to `base_path` when it lies
/// inside it, else the path as given.
pub fn patch_header_path_for_resolved(base_path: &str, full_path: &str) -> String {
    let rel = nodepath::relative_host(&nodepath::resolve_host(&[base_path]), &nodepath::resolve_host(&[full_path]));
    if !rel.is_empty() && !nodepath::is_absolute_host(&rel) && !nodepath::split_segments(&rel).iter().any(|part| *part == "..") {
        return rel.replace('\\', "/");
    }
    full_path.to_owned()
}

// A display path is a plain relative or absolute path; the patch header only needs forward
// slashes. Its own leading "a/" is part of the name.
fn header_path(value: &str) -> String {
    js_trim(value).replace('\\', "/")
}

// One file's change, from the call's own before and after states: absent, bytes, or an omitted
// marker when the bytes were not kept. `budget` is the call's line-diff budget.
fn render_call_change(differ: &LineDiffer, change: &TrackedChange, budget: &mut LineDiffBudget) -> String {
    let old_name = {
        let name = header_path(&change.display_path);
        if name.is_empty() { "unknown file".to_owned() } else { name }
    };
    let new_name = match change.new_display_path.as_deref().map(header_path) {
        Some(name) if !name.is_empty() => name,
        _ => old_name.clone(),
    };
    let (before, after) = (&change.before, &change.after);
    let before_absent = matches!(before, ReviewContent::Absent);
    let after_absent = matches!(after, ReviewContent::Absent);
    let old_header = if before_absent { "/dev/null".to_owned() } else { format!("a/{old_name}") };
    let new_header = if after_absent { "/dev/null".to_owned() } else { format!("b/{new_name}") };
    let mut head = format!("diff --git a/{old_name} b/{new_name}\n");
    if before_absent && !after_absent {
        head.push_str("new file mode 100644\n");
    } else if !before_absent && after_absent {
        head.push_str("deleted file mode 100644\n");
    }
    let binary = format!("{head}Binary files {old_header} and {new_header} differ\n");
    if is_omitted(before) || is_omitted(after) {
        return binary;
    }
    let (Some(old_text), Some(new_text)) = (decode_text(before), decode_text(after)) else {
        return binary;
    };
    if old_text == new_text {
        // An empty file created or deleted still changed: git writes the mode line alone.
        if before_absent != after_absent {
            return head;
        }
        return if old_name == new_name {
            String::new()
        } else {
            format!("{head}similarity index 100%\nrename from {old_name}\nrename to {new_name}\n")
        };
    }
    let rename = if old_name == new_name { String::new() } else { format!("rename from {old_name}\nrename to {new_name}\n") };
    let hunks = differ.hunks(old_text, new_text, budget, [raw_bytes(before), raw_bytes(after)]);
    format!("{head}{rename}{}", unified_hunks_body(&old_header, &new_header, &hunks.hunks))
}

// Added/deleted lines of one rendered change, counted in its hunks only.
fn hunk_line_counts(patch: &str) -> (u64, u64) {
    let (mut additions, mut deletions) = (0, 0);
    let mut in_hunk = false;
    for line in patch.split('\n') {
        if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk && line.starts_with('+') {
            additions += 1;
        } else if in_hunk && line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

/// Each change with the line counts of its own unbounded diff (the turn review sums them per
/// file), plus the call's whole diff, within the call's budget.
pub fn measure_call_changes(differ: &LineDiffer, changes: Vec<TrackedChange>, budget: &mut LineDiffBudget) -> (String, Vec<TrackedChange>) {
    let patches: Vec<String> = changes.iter().map(|change| render_call_change(differ, change, budget)).collect();
    let diff = patches.concat();
    let measured = changes
        .into_iter()
        .zip(&patches)
        .map(|(mut change, patch)| {
            let (additions, deletions) = hunk_line_counts(patch);
            change.additions = Some(additions);
            change.deletions = Some(deletions);
            change
        })
        .collect();
    (diff, measured)
}

/// A call's card shows the change that call made, its own before against its own after, never the
/// turn's running total for the same files.
pub fn call_ui_diff(differ: &LineDiffer, changes: Vec<TrackedChange>) -> String {
    measure_call_changes(differ, changes, &mut LineDiffBudget::default()).0
}

/// The card diffs of calls not yet picked up (a bounded registry, oldest out first).
#[derive(Default)]
pub struct CardDiffs {
    by_call: Mutex<Vec<(String, String)>>,
}

impl CardDiffs {
    pub fn register(&self, call_id: &str, diff: &str) {
        if call_id.is_empty() {
            return;
        }
        let (text, _) = bound_review_patch(diff, APPLY_PATCH_UI_DIFF_MAX_CHARS);
        let mut by_call = self.by_call.lock().unwrap_or_else(|e| e.into_inner());
        if by_call.len() >= APPLY_PATCH_UI_DIFF_REGISTRY_MAX {
            by_call.remove(0);
        }
        // A Map keeps a key's first position when it is set again.
        match by_call.iter_mut().find(|(id, _)| id == call_id) {
            Some(entry) => entry.1 = text,
            None => by_call.push((call_id.to_owned(), text)),
        }
    }

    pub fn take(&self, call_id: &str) -> Option<String> {
        if call_id.is_empty() {
            return None;
        }
        let mut by_call = self.by_call.lock().unwrap_or_else(|e| e.into_inner());
        let index = by_call.iter().position(|(id, _)| id == call_id)?;
        Some(by_call.remove(index).1)
    }
}
