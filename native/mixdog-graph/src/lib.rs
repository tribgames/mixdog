// mixdog-graph engine library.
//
// The modules below carry language classification, the resident search
// server, and Windows USN journal support. `src/main.rs` is the crash-isolated
// executable front end used for graph builds and `--serve-search`.
pub mod calls;
pub mod lang;
pub mod outline;
pub mod scan;
pub mod scan_lang;
pub mod serve_search;
mod serve_search_lifecycle;
pub mod serve_search_usn;
pub mod spans;
pub mod tokens;

// A source file above this size is not indexed at all. The extraction walk,
// the `--files` path, the symbol search and the structural scan all apply the
// same cap, so a file is either in every mode's answer or in none of them.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

use std::path::{Path, PathBuf};

/// Every file under `root` that `classify` assigns a language, in walk order,
/// with no stat yet. The extraction walk and the structural scan share this
/// one walker configuration (standard ignore filters on, hidden files kept),
/// so both modes see the same file set; a walk error is fatal to either.
pub fn walk_classified_files<T>(
    root: &Path,
    classify: impl Fn(&Path) -> Option<T>,
) -> Result<Vec<(PathBuf, T)>, String> {
    let mut candidates = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .standard_filters(true)
        .hidden(false)
        .build()
    {
        let dir_entry =
            entry.map_err(|err| format!("walk failed under {}: {err}", root.display()))?;
        if !dir_entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let path = dir_entry.path();
        let Some(lang) = classify(path) else {
            continue;
        };
        candidates.push((path.to_path_buf(), lang));
    }
    Ok(candidates)
}

/// Write one JSON line per item. Every serialization and write failure is
/// fatal and names the failing `noun` and index: a dropped line would leave
/// the caller with a silently short list and exit code 0.
pub fn write_jsonl<T: serde::Serialize>(
    items: &[T],
    noun: &str,
    out: &mut impl std::io::Write,
) -> Result<(), String> {
    for (index, item) in items.iter().enumerate() {
        let line = serde_json::to_string(item)
            .map_err(|err| format!("serialize failed for {noun} {index}: {err}"))?;
        writeln!(out, "{line}")
            .map_err(|err| format!("stdout write failed for {noun} {index}: {err}"))?;
    }
    Ok(())
}
