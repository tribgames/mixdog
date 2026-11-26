pub mod calls;
pub mod lang;
pub mod outline;
pub mod resolve;
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
pub fn walk_classified_files<T>(root: &Path, classify: impl Fn(&Path) -> Option<T>) -> Result<Vec<(PathBuf, T)>, String> {
    let mut candidates = Vec::new();
    for entry in ignore::WalkBuilder::new(root).standard_filters(true).hidden(false).build() {
        let dir_entry = entry.map_err(|err| format!("walk failed under {}: {err}", root.display()))?;
        if !dir_entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
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

/// Every file under `root` that `classify` assigns a language, collected in parallel
/// with each entry's metadata (reading directory-entry metadata directly without a
/// second stat on Windows). Directories matching `skip_dir` (other than `root`) are
/// pruned during traversal. Uses the same walker configuration as [`walk_classified_files`].
pub fn walk_classified_files_with_meta<T: Send>(
    root: &Path,
    classify: impl Fn(&Path) -> Option<T> + Sync,
    skip_dir: impl Fn(&Path) -> bool + Sync,
) -> Result<Vec<(PathBuf, T, std::fs::Metadata)>, String> {
    use std::sync::Mutex;

    struct Flush<'a, T> {
        local: Vec<(PathBuf, T, std::fs::Metadata)>,
        out: &'a Mutex<Vec<(PathBuf, T, std::fs::Metadata)>>,
    }

    impl<T> Drop for Flush<'_, T> {
        fn drop(&mut self) {
            if !self.local.is_empty() {
                self.out.lock().unwrap_or_else(std::sync::PoisonError::into_inner).append(&mut self.local);
            }
        }
    }

    let out: Mutex<Vec<(PathBuf, T, std::fs::Metadata)>> = Mutex::new(Vec::new());
    let first_err: Mutex<Option<String>> = Mutex::new(None);
    ignore::WalkBuilder::new(root).standard_filters(true).hidden(false).build_parallel().run(|| {
        let mut flush = Flush { local: Vec::new(), out: &out };
        let first_err = &first_err;
        let classify = &classify;
        let skip_dir = &skip_dir;
        Box::new(move |entry| match entry {
            Ok(dir_entry) => {
                if dir_entry.depth() > 0 && dir_entry.file_type().is_some_and(|kind| kind.is_dir()) && skip_dir(dir_entry.path()) {
                    return ignore::WalkState::Skip;
                }
                if dir_entry.file_type().is_some_and(|kind| kind.is_file()) {
                    let path = dir_entry.path();
                    if let Some(lang) = classify(path) {
                        if let Ok(meta) = dir_entry.metadata() {
                            flush.local.push((path.to_path_buf(), lang, meta));
                        }
                    }
                }
                ignore::WalkState::Continue
            }
            Err(err) => {
                let mut slot = first_err.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if slot.is_none() {
                    *slot = Some(format!("walk failed under {}: {err}", root.display()));
                }
                ignore::WalkState::Quit
            }
        })
    });
    if let Some(err) = first_err.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner) {
        return Err(err);
    }
    Ok(out.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner))
}

/// Write one JSON line per item. Every serialization and write failure is
/// fatal and names the failing `noun` and index: a dropped line would leave
/// the caller with a silently short list and exit code 0.
pub fn write_jsonl<T: serde::Serialize>(items: &[T], noun: &str, out: &mut impl std::io::Write) -> Result<(), String> {
    for (index, item) in items.iter().enumerate() {
        let line = serde_json::to_string(item).map_err(|err| format!("serialize failed for {noun} {index}: {err}"))?;
        writeln!(out, "{line}").map_err(|err| format!("stdout write failed for {noun} {index}: {err}"))?;
    }
    Ok(())
}
