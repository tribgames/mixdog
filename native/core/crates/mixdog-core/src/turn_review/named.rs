//! A git-format patch of exact before/after bytes under the names a viewer shows (Node
//! `namedChangePatch`), for the edits a record cannot replay.

use mixdog_core_api::turn_review::ReviewContent;

use super::line_diff::LineDiffBudget;
use super::line_diff::LineDiffer;
use super::patch::TrackedFileInput;
use super::patch::tracked_change_file;
use super::review_diff::Obj;

const VIEW_PATCH_MAX_BYTES: usize = 256 * 1024;

pub struct Named {
    pub status: char,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    /// The patch under the viewer's names; empty when it passed the byte cap.
    pub patch: String,
}

/// Counts and a placeholder-named patch of exact before/after bytes.
pub struct Measured {
    pub status: char,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    pub text: String,
}

pub fn measure_change(differ: &LineDiffer, before: &ReviewContent, after: &ReviewContent, renamed: bool, budget: &mut LineDiffBudget) -> Measured {
    let (old_path, new_path) = if renamed { ("mx-old-file", "mx-new-file") } else { ("mx-file", "mx-file") };
    let measured = tracked_change_file(differ, &TrackedFileInput { old_path, new_path, before, after, object_format: "sha1" }, budget);
    let count = |obj: &Obj, key: &str| obj.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0);
    Measured {
        status: measured.meta.get("status").and_then(|s| s.as_str()).and_then(|s| s.chars().next()).unwrap_or('M'),
        additions: count(&measured.meta, "additions"),
        deletions: count(&measured.meta, "deletions"),
        binary: measured.meta.get("binary") == Some(&serde_json::Value::Bool(true)),
        text: measured.patch.map(|p| String::from_utf8_lossy(&p).into_owned()).unwrap_or_default(),
    }
}

/// A measured patch with its placeholders replaced by the names a viewer shows.
pub fn name_measured_patch(text: &str, old_name: &str, new_name: &str) -> String {
    // `text.search(/\n@@ /)`
    let split = text.find("\n@@ ");
    let head = match split {
        Some(at) => &text[..at],
        None => text,
    };
    let head = head.replace("mx-old-file", old_name).replace("mx-new-file", new_name).replace("mx-file", new_name);
    match split {
        Some(at) => format!("{head}{}", &text[at..]),
        None => head,
    }
}

pub fn named_change_patch(
    differ: &LineDiffer,
    before: &ReviewContent,
    after: &ReviewContent,
    old_name: &str,
    new_name: &str,
    budget: &mut LineDiffBudget,
) -> Named {
    let measured = measure_change(differ, before, after, old_name != new_name, budget);
    let patch = name_measured_patch(&measured.text, old_name, new_name);
    Named {
        status: measured.status,
        additions: measured.additions,
        deletions: measured.deletions,
        binary: measured.binary,
        patch: if patch.len() > VIEW_PATCH_MAX_BYTES { String::new() } else { patch },
    }
}
