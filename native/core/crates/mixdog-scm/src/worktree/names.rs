//! Names and managed paths: the slug that is a worktree's folder and branch, and where the
//! managed store keeps it (`<dataDir>/worktrees-v1/<repoHash>/<slug>`).

use std::path::Path;
use std::path::PathBuf;

use sha2::Digest;
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

use crate::locks::path_key;
use crate::repo::hex;
use crate::worktree::registry::STORE_DIR;

pub const SLUG_MAX_LENGTH: usize = 40;
const FALLBACK_SLUG: &str = "task";
const NAME_MAX_LENGTH: usize = 64;

/// Why `name` cannot be a worktree slug (folder name and branch component), or `None`.
pub fn name_error(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("a name is required");
    }
    if name.len() > NAME_MAX_LENGTH {
        return Some("at most 64 characters");
    }
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    if !first_ok || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Some("use letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit");
    }
    if name.contains("..") || name.ends_with('.') || name.to_lowercase().ends_with(".lock") {
        return Some("not a valid git branch component");
    }
    None
}

/// Stable short hash of a canonical git common dir (case-insensitive on Windows).
pub fn repo_hash(common_dir: &Path) -> String {
    hex(&Sha256::digest(path_key(common_dir).as_bytes())[..8])
}

pub fn managed_root(data_dir: &Path, common_dir: &Path) -> PathBuf {
    data_dir.join(STORE_DIR).join(repo_hash(common_dir))
}

pub fn managed_path(data_dir: &Path, common_dir: &Path, slug: &str) -> PathBuf {
    managed_root(data_dir, common_dir).join(slug)
}

/// DOS device names stay reserved on Windows, even with an extension, and a managed folder must
/// stay valid when the data moves between machines: Windows asks the shared device-path guard,
/// and elsewhere Node's slug rule (the same names, whatever the platform) applies, which the
/// shared guard does not (it answers for Windows only).
fn is_reserved(slug: &str) -> bool {
    if mixdog_js::device_paths::is_windows_device_path(slug) {
        return true;
    }
    let lower = slug.to_lowercase();
    !cfg!(windows)
        && (matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
            || ((lower.starts_with("com") || lower.starts_with("lpt"))
                && lower.len() == 4
                && lower.as_bytes()[3].is_ascii_digit()))
}

fn trim_slug(value: &str, max: usize) -> String {
    let cut: String = value.chars().take(max).collect();
    cut.trim_end_matches('-').to_owned()
}

/// A short, Windows-safe folder name and branch suffix derived from the task's first message.
pub fn slug_from_hint(hint: &str) -> String {
    let mut slug = String::new();
    // `normalize('NFKD')`, the combining marks (U+0300..U+036F) dropped, lower-cased, then every run of anything else a space.
    let lowered: String = hint
        .nfkd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { ' ' })
        .collect();
    for word in lowered.split_whitespace() {
        let next = if slug.is_empty() { word.to_owned() } else { format!("{slug}-{word}") };
        if next.len() > SLUG_MAX_LENGTH {
            if slug.is_empty() {
                slug = trim_slug(word, SLUG_MAX_LENGTH);
            }
            break;
        }
        slug = next;
    }
    if slug.is_empty() {
        slug = FALLBACK_SLUG.to_owned();
    }
    if is_reserved(&slug) {
        slug = format!("{slug}-{FALLBACK_SLUG}");
    }
    slug
}

/// The first of `base`, `base-2`, `base-3`, … that `is_taken` rejects; every candidate is a
/// valid name.
pub fn unique_slug(base: &str, is_taken: impl Fn(&str) -> bool) -> String {
    let root = if name_error(base).is_some() { FALLBACK_SLUG } else { base };
    for attempt in 1..=50usize {
        let suffix = if attempt == 1 { String::new() } else { format!("-{attempt}") };
        let candidate = format!("{}{suffix}", trim_slug(root, SLUG_MAX_LENGTH - suffix.len()));
        if name_error(&candidate).is_none() && !is_taken(&candidate) {
            return candidate;
        }
    }
    let mut counter = 0u64;
    loop {
        counter += 1;
        let suffix = format!("-{:08x}", counter.wrapping_mul(2_654_435_761));
        let candidate = format!("{}{suffix}", trim_slug(root, SLUG_MAX_LENGTH - suffix.len()));
        if !is_taken(&candidate) {
            return candidate;
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_come_from_the_first_words_and_stay_unique() {
        assert_eq!(slug_from_hint("Fix the Login bug!"), "fix-the-login-bug");
        assert_eq!(slug_from_hint("!!!"), "task");
        assert_eq!(slug_from_hint("con"), "con-task");
        let taken = ["task".to_owned(), "task-2".to_owned()];
        assert_eq!(unique_slug("task", |c| taken.iter().any(|t| t == c)), "task-3");
        assert!(name_error("a..b").is_some());
        assert!(name_error("ok-name_1.2").is_none());
    }

    /// `<prefix>-` and exactly eight lowercase hex digits.
    fn is_random_suffixed(candidate: &str, prefix: &str) -> bool {
        candidate.strip_prefix(prefix).and_then(|rest| rest.strip_prefix('-')).is_some_and(|hex| hex.len() == 8 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    }


    /// Accents fold to their base letters, anything else becomes a word break, words join with `-` while the slug stays within 40
    /// characters, and a first word longer than that is cut and loses a trailing `-`.
    #[test]
    fn a_hint_becomes_a_folded_lowercase_dashed_slug_within_the_length_limit() {
        assert_eq!(slug_from_hint("Résumé  Déjà-vu: 42 things"), "resume-deja-vu-42-things");
        assert_eq!(slug_from_hint("  ...  "), "task");
        assert_eq!(slug_from_hint("日本語"), "task");
        // 30 + 1 + 9 fits exactly; one more letter does not, so the slug stops before that word.
        let thirty = "a".repeat(30);
        assert_eq!(slug_from_hint(&format!("{thirty} bbbbbbbbb")), format!("{thirty}-bbbbbbbbb"));
        assert_eq!(slug_from_hint(&format!("{thirty} bbbbbbbbbb ccc")), thirty);
        assert_eq!(slug_from_hint(&"z".repeat(60)), "z".repeat(40));
        for reserved in ["con", "PRN", "aux", "nul", "com1", "lpt9"] {
            assert_eq!(slug_from_hint(reserved), format!("{}-task", reserved.to_lowercase()), "{reserved}");
        }
        assert!(name_error(&slug_from_hint("Fix the Login bug!")).is_none());
    }

    /// A taken base is followed by `-2`, `-3`, …; the suffix counts inside the 40-character limit; after fifty candidates the
    /// answer is the base and eight hex digits; an invalid base falls back to `task`.
    #[test]
    fn a_taken_slug_gets_a_numeric_then_a_random_suffix_within_the_limit() {
        let taken = ["fix".to_owned(), "fix-2".to_owned(), "fix-4".to_owned()];
        assert_eq!(unique_slug("fix", |c| taken.iter().any(|t| t == c)), "fix-3");
        assert_eq!(unique_slug("not valid!", |c| c == "task"), "task-2");
        let long = "a".repeat(40);
        let slug = unique_slug(&long, |c| c == long);
        assert_eq!(slug, format!("{}-2", "a".repeat(38)));
        let slug = unique_slug("fix", |candidate| !is_random_suffixed(candidate, "fix"));
        assert!(is_random_suffixed(&slug, "fix"), "{slug}");
        let slug = unique_slug(&long, |candidate| !is_random_suffixed(candidate, &"a".repeat(31)));
        assert!(is_random_suffixed(&slug, &"a".repeat(31)) && slug.len() == 40 && name_error(&slug).is_none(), "{slug}");
    }

    #[test]
    fn a_name_that_cannot_be_a_folder_or_a_branch_is_refused_with_its_reason() {
        assert_eq!(name_error(""), Some("a name is required"));
        assert_eq!(name_error(&"a".repeat(65)), Some("at most 64 characters"));
        assert!(name_error(&"a".repeat(64)).is_none());
        for bad in ["-lead", ".lead", "a b", "a/b", "é"] {
            assert_eq!(name_error(bad), Some("use letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit"), "{bad}");
        }
        for bad in ["a..b", "trail.", "x.lock", "X.LOCK"] {
            assert_eq!(name_error(bad), Some("not a valid git branch component"), "{bad}");
        }
    }
}
