//! Bounds of a review reply (Node `review-diff.mjs`): every changed file is listed with its counts,
//! and its patch text rides along only within the per-file and total caps.

use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;

const TRUNCATED: &str = "… [diff truncated for display]";

/// Largest single-file patch a review reply carries inline.
pub const REVIEW_FILE_PATCH_MAX_BYTES: usize = 1024 * 1024;
/// Largest total patch text a review reply carries.
pub const REVIEW_PATCH_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Largest single-file patch a file-patch read returns.
pub const REVIEW_FILE_PATCH_SHOW_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const PATCH_TOO_LARGE: &str = "too_large";

pub type Obj = Map<String, Value>;

/// A reply file listed with its counts but without its patch, for size (`{ ...file, patchOmitted,
/// reason }`).
pub fn patch_omitted_file(mut file: Obj) -> Obj {
    file.insert("patchOmitted".into(), Value::Bool(true));
    file.insert("reason".into(), Value::String(PATCH_TOO_LARGE.into()));
    file
}

/// A `diff --git` section whose hunks [`bound_review_patch`] cut.
pub fn review_section_truncated(section: &str) -> bool {
    section.contains(TRUNCATED)
}

/// Nothing of the reply's patch fit: no patch text, a file omitted for size.
pub fn review_diff_too_large(files: &[Obj], patch: &str) -> bool {
    patch.is_empty()
        && files.iter().any(|file| {
            file.get("patchOmitted") == Some(&Value::Bool(true)) && file.get("reason").and_then(Value::as_str) == Some(PATCH_TOO_LARGE)
        })
}

/// The per-file and total caps of one reply.
pub struct ReviewPatchBudget {
    remaining: i64,
}

impl ReviewPatchBudget {
    pub fn new(total: i64) -> Self {
        Self { remaining: total }
    }

    #[cfg(test)]
    pub fn remaining(&self) -> i64 {
        self.remaining
    }

    /// Takes a patch of that size from the remaining total, or refuses it.
    pub fn admit(&mut self, bytes: usize) -> bool {
        if bytes > REVIEW_FILE_PATCH_MAX_BYTES || bytes as i64 > self.remaining {
            return false;
        }
        self.remaining -= bytes as i64;
        true
    }
}

impl Default for ReviewPatchBudget {
    fn default() -> Self {
        Self::new(REVIEW_PATCH_MAX_BYTES as i64)
    }
}

/// One file-patch read's reply: its patch, or none when past `max_bytes`.
pub fn file_patch_reply(path: &str, patch: &str, max_bytes: usize) -> Obj {
    let mut reply = Obj::new();
    reply.insert("supported".into(), Value::Bool(true));
    reply.insert("path".into(), Value::String(path.to_owned()));
    if patch.len() > max_bytes {
        reply.insert("patch".into(), Value::String(String::new()));
        reply.insert("patchOmitted".into(), Value::Bool(true));
        reply.insert("reason".into(), Value::String(PATCH_TOO_LARGE.into()));
    } else {
        reply.insert("patch".into(), Value::String(patch.to_owned()));
    }
    reply
}

/// The offsets where a multiline `^` matches: the start, and after each JS line terminator.
pub fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (index, c) in text.char_indices() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            starts.push(index + c.len_utf8());
        }
    }
    starts
}

/// `text.search(/^<prefix>/m)`: the first line start where `prefix` begins.
pub fn search_line_start(text: &str, prefix: &str) -> Option<usize> {
    line_starts(text).into_iter().find(|start| text[*start..].starts_with(prefix))
}

/// Bound hunk bodies, never the inventory of changed files. Headers are kept even when the
/// inventory itself exceeds the display budget. Returns `(patch, truncated)`.
pub fn bound_review_patch(patch: &str, max_chars: usize) -> (String, bool) {
    let already = patch.contains(TRUNCATED);
    if utf16_len(patch) <= max_chars {
        return (patch.to_owned(), already);
    }
    // `patch.split(/(?=^diff --git )/m).filter(Boolean)`
    let mut cuts: Vec<usize> = line_starts(patch).into_iter().filter(|s| *s > 0 && patch[*s..].starts_with("diff --git ")).collect();
    cuts.insert(0, 0);
    cuts.push(patch.len());
    let mut sections: Vec<(&str, &str)> = Vec::new();
    for pair in cuts.windows(2) {
        let section = &patch[pair[0]..pair[1]];
        if section.is_empty() {
            continue;
        }
        match search_line_start(section, "@@") {
            None => sections.push((section, "")),
            Some(start) => sections.push((&section[..start], &section[start..])),
        }
    }
    let truncated_len = utf16_len(TRUNCATED) + 1;
    let reserved: usize = sections.iter().map(|(header, _)| utf16_len(header) + truncated_len).sum();
    let mut remaining = max_chars.saturating_sub(reserved);
    let mut truncated = already;
    let mut out = String::new();
    for (header, body) in sections {
        let body_len = utf16_len(body);
        if body_len <= remaining {
            remaining -= body_len;
            out.push_str(header);
            out.push_str(body);
        } else {
            truncated = true;
            out.push_str(header);
            out.push_str(TRUNCATED);
            out.push('\n');
        }
    }
    (out, truncated)
}
