//! The workspace files one Office call wrote, with their exact before/after state, so the session's turn review counts
//! them as its own changes and Undo can restore them (`core/office-write-ledger.mjs`).
//!
//! Ownership is never inferred from the folder: every route that writes a workspace file hands the path to
//! [`WriteNote::note_write`] BEFORE it writes, which captures the file's prior state. After the call, only noted files
//! whose bytes changed are recorded ([`CallLedger::changes`]). Scratch files outside the workspace (the system temp
//! folder, the Office data folder) are never noted. The ledger is an explicit per-call object the tool call owns and
//! hands to the engine as its `WriteNote`; it replaces the `AsyncLocalStorage` Node found it through.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use mixdog_fsio::{ReadProof, Unlaned};
use mixdog_js::{js_to_lowercase, js_trim};

use crate::bounded_read::{PATCH_EDIT_BUDGET_BYTES, ReviewContent, SnapshotBudget, review_file_content};
use crate::data_dir::{resolve_from_process_cwd, resolve_path};
use crate::write_note::WriteNote;

/// One side of a changed file, shaped as the turn review takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeSide {
    Absent,
    /// The content, captured byte for byte.
    Bytes(Vec<u8>),
    /// The file changed but its bytes were not captured (oversized, over the budget): no undo. `reason` is Node's
    /// `'oversized'`, `'binary'` or `'budget'`.
    Uncaptured { size: u64, reason: Option<String> },
}

impl From<ReviewContent> for ChangeSide {
    fn from(content: ReviewContent) -> Self {
        match content {
            ReviewContent::Absent => Self::Absent,
            ReviewContent::Bytes(bytes) => Self::Bytes(bytes),
            ReviewContent::Omitted { size, reason } => Self::Uncaptured { size, reason: Some(reason.as_str().to_owned()) },
        }
    }
}

/// A file the call created, edited or removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: PathBuf,
    pub before: ChangeSide,
    pub after: ChangeSide,
}

/// A regular file's size and modification time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: Option<SystemTime>,
}

fn file_stamp<P: ReadProof>(proof: &P, path: &Path) -> Option<Stamp> {
    let meta = mixdog_fsio::metadata(proof, path).ok().filter(std::fs::Metadata::is_file)?;
    Some(Stamp { size: meta.len(), modified: meta.modified().ok() })
}

struct Noted {
    full_path: PathBuf,
    content: ChangeSide,
    stamp: Option<Stamp>,
}

struct Notes {
    budget: SnapshotBudget,
    keys: HashSet<String>,
    entries: Vec<Noted>,
}

/// The write receipts of one Office call.
pub struct CallLedger {
    cwd: PathBuf,
    data_dir: Option<PathBuf>,
    temp_dir: PathBuf,
    notes: Mutex<Notes>,
}

/// Windows paths compare without regard to case.
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) { js_to_lowercase(&text) } else { text.into_owned() }
}

fn folded_components(path: &Path) -> Vec<String> {
    path.components().map(|component: Component<'_>| path_key(Path::new(component.as_os_str()))).collect()
}

/// `inside(parent, child)`: `child` is `parent` or below it, both resolved. A name below `parent` that begins with two
/// dots counts as outside, as Node's `relative(...).startsWith('..')` test has it.
fn inside(parent: &Path, child: &Path) -> bool {
    if parent.as_os_str().is_empty() {
        return false;
    }
    let parent = folded_components(parent);
    let child = folded_components(child);
    if child.len() < parent.len() || child[..parent.len()] != parent[..] {
        return false;
    }
    child.get(parent.len()).is_none_or(|first| !first.starts_with(".."))
}

impl WriteNote for CallLedger {
    /// The seam of the engine's writers, which run inside a lane job of their own and carry no proof through the
    /// trait.
    fn note_write(&self, path: &Path) {
        self.note_write_in(&Unlaned, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct World {
        _dir: tempfile::TempDir,
        root: PathBuf,
        ledger: CallLedger,
    }

    fn world() -> World {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path().to_path_buf();
        for sub in ["work", "data", "scratch"] {
            mixdog_fsio::create_dir_all(&Unlaned, root.join(sub)).expect("dir");
        }
        // The scratch folder is the temp folder of this world, which the workspace is not under.
        let ledger = CallLedger::with_temp_dir(&root.join("work"), &root.join("data"), &root.join("scratch")).expect("ledger");
        World { _dir: dir, root, ledger }
    }

    fn put(path: &Path, bytes: &[u8]) {
        mixdog_fsio::write(&Unlaned, path, bytes).expect("write");
    }

    #[test]
    fn a_created_edited_and_removed_file_are_reported_with_both_sides() {
        let w = world();
        let work = w.root.join("work");
        put(&work.join("edit.docx"), b"old");
        put(&work.join("gone.docx"), b"bye");
        for name in ["new.docx", "edit.docx", "gone.docx"] {
            w.ledger.note_write(&work.join(name));
        }
        put(&work.join("new.docx"), b"created");
        put(&work.join("edit.docx"), b"edited");
        mixdog_fsio::remove_file(&Unlaned, work.join("gone.docx")).expect("remove");
        assert_eq!(
            w.ledger.changes(&Unlaned),
            vec![
                FileChange { path: work.join("new.docx"), before: ChangeSide::Absent, after: ChangeSide::Bytes(b"created".to_vec()) },
                FileChange { path: work.join("edit.docx"), before: ChangeSide::Bytes(b"old".to_vec()), after: ChangeSide::Bytes(b"edited".to_vec()) },
                FileChange { path: work.join("gone.docx"), before: ChangeSide::Bytes(b"bye".to_vec()), after: ChangeSide::Absent },
            ]
        );
    }

    #[test]
    fn a_noted_file_that_did_not_change_or_never_existed_is_not_reported() {
        let w = world();
        let work = w.root.join("work");
        put(&work.join("same.docx"), b"same");
        w.ledger.note_write(&work.join("same.docx"));
        w.ledger.note_write(&work.join("never.docx"));
        put(&work.join("same.docx"), b"same");
        assert!(w.ledger.changes(&Unlaned).is_empty());
    }

    #[test]
    fn the_first_receipt_of_a_path_wins_and_a_relative_or_padded_path_resolves_against_the_call_folder() {
        let w = world();
        let work = w.root.join("work");
        put(&work.join("a.docx"), b"one");
        w.ledger.note_write(Path::new("  a.docx "));
        put(&work.join("a.docx"), b"two");
        w.ledger.note_write(&work.join("a.docx"));
        put(&work.join("a.docx"), b"three");
        w.ledger.note_write(Path::new("   "));
        assert_eq!(
            w.ledger.changes(&Unlaned),
            vec![FileChange { path: work.join("a.docx"), before: ChangeSide::Bytes(b"one".to_vec()), after: ChangeSide::Bytes(b"three".to_vec()) }]
        );
    }

    #[test]
    fn the_data_folder_and_the_temp_folder_outside_the_workspace_are_never_noted() {
        let w = world();
        put(&w.root.join("data").join("j.json"), b"x");
        put(&w.root.join("scratch").join("t.bin"), b"x");
        w.ledger.note_write(&w.root.join("data").join("j.json"));
        w.ledger.note_write(&w.root.join("scratch").join("t.bin"));
        put(&w.root.join("data").join("j.json"), b"y");
        put(&w.root.join("scratch").join("t.bin"), b"y");
        assert!(w.ledger.changes(&Unlaned).is_empty());
        // The same temp folder holding the workspace: a file under the workspace is the call's.
        let dir = tempfile::tempdir().expect("dir");
        let nested = CallLedger::with_temp_dir(dir.path(), Path::new(""), dir.path()).expect("ledger");
        nested.note_write(&dir.path().join("w.docx"));
        put(&dir.path().join("w.docx"), b"w");
        assert_eq!(nested.changes(&Unlaned).len(), 1);
    }

    #[test]
    fn a_directory_is_not_a_regular_file_and_is_not_recorded() {
        let w = world();
        let folder = w.root.join("work").join("folder");
        mixdog_fsio::create_dir_all(&Unlaned, &folder).expect("dir");
        w.ledger.note_write(&folder);
        // The refusal does not occupy the key: once the path is a file, the first receipt after it records.
        mixdog_fsio::remove_dir(&Unlaned, &folder).expect("remove");
        w.ledger.note_write(&folder);
        put(&folder, b"now a file");
        assert_eq!(w.ledger.changes(&Unlaned).len(), 1);
    }

    #[test]
    fn the_budget_marks_what_does_not_fit_and_an_unchanged_uncaptured_file_is_not_reported() {
        let w = world();
        let work = w.root.join("work");
        w.ledger.notes.lock().expect("lock").budget = SnapshotBudget::new(10);
        put(&work.join("fits.bin"), b"123456");
        put(&work.join("big.bin"), b"123456");
        put(&work.join("big-same.bin"), b"123456");
        for name in ["fits.bin", "big.bin", "big-same.bin"] {
            w.ledger.note_write(&work.join(name));
        }
        put(&work.join("big.bin"), b"1234567");
        let changes = w.ledger.changes(&Unlaned);
        assert_eq!(changes.len(), 1, "{changes:?}");
        assert_eq!(changes[0].path, work.join("big.bin"));
        assert_eq!(changes[0].before, ChangeSide::Uncaptured { size: 6, reason: Some("budget".to_owned()) });
        assert_eq!(changes[0].after, ChangeSide::Bytes(b"1234567".to_vec()));
    }


    #[test]
    fn paths_that_differ_only_in_case_are_one_file_where_the_file_system_ignores_case() {
        let w = world();
        let work = w.root.join("work");
        put(&work.join("Case.docx"), b"one");
        w.ledger.note_write(&work.join("Case.docx"));
        put(&work.join("Case.docx"), b"two");
        // On Windows this names the same file, whose first receipt was already taken.
        w.ledger.note_write(&work.join("CASE.DOCX"));
        put(&work.join("Case.docx"), b"three");
        let changes = w.ledger.changes(&Unlaned);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].before, ChangeSide::Bytes(b"one".to_vec()));
        assert_eq!(changes[0].after, ChangeSide::Bytes(b"three".to_vec()));
    }

    #[test]
    fn a_name_that_begins_with_two_dots_is_outside_the_folder_it_is_in() {
        let root = std::env::temp_dir().join("office-ledger-inside");
        assert!(inside(&root, &root));
        assert!(inside(&root, &root.join("a").join("b")));
        assert!(!inside(&root, &root.join("..odd")));
        assert!(!inside(&root, &std::env::temp_dir()));
        assert!(!inside(Path::new(""), &root));
    }
}


impl CallLedger {
    /// A ledger for a call working in `cwd` (the process's working directory when empty) with `data_dir` as the Office
    /// data folder (none when empty). The system temp folder is the scratch folder.
    pub fn new(cwd: &Path, data_dir: &Path) -> std::io::Result<Self> {
        Self::with_temp_dir(cwd, data_dir, &std::env::temp_dir())
    }

    /// [`CallLedger::new`] with the scratch folder named.
    pub fn with_temp_dir(cwd: &Path, data_dir: &Path, temp_dir: &Path) -> std::io::Result<Self> {
        let process_cwd = std::env::current_dir()?;
        let cwd = if cwd.as_os_str().is_empty() { process_cwd.clone() } else { resolve_path(&process_cwd, cwd) };
        let data_dir = if data_dir.as_os_str().is_empty() { None } else { Some(resolve_from_process_cwd(data_dir)?) };
        Ok(Self {
            cwd,
            data_dir,
            temp_dir: resolve_from_process_cwd(temp_dir)?,
            notes: Mutex::new(Notes { budget: SnapshotBudget::new(PATCH_EDIT_BUDGET_BYTES), keys: HashSet::new(), entries: Vec::new() }),
        })
    }

    /// `noteOfficeWrite`: the call is about to write `path`. The first receipt of a path captures its state before the
    /// write; scratch paths and anything that is not a regular file are ignored.
    pub fn note_write_in<P: ReadProof>(&self, proof: &P, path: &Path) {
        let text = js_trim(&path.to_string_lossy()).to_owned();
        if text.is_empty() {
            return;
        }
        let full_path = resolve_path(&self.cwd, Path::new(&text));
        let key = path_key(&full_path);
        let mut notes = self.notes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if notes.keys.contains(&key) {
            return;
        }
        if self.data_dir.as_deref().is_some_and(|data| inside(data, &full_path)) {
            return;
        }
        if inside(&self.temp_dir, &full_path) && !inside(&self.cwd, &full_path) {
            return;
        }
        // Not a regular file (or unreadable): never recorded.
        let Ok(content) = review_file_content(proof, &full_path, Some(&mut notes.budget)) else {
            return;
        };
        let stamp = file_stamp(proof, &full_path);
        notes.keys.insert(key);
        notes.entries.push(Noted { full_path, content: content.into(), stamp });
    }

    /// `officeWriteChanges`: every noted file the call created, changed or removed, with its bytes read from disk now.
    pub fn changes<P: ReadProof>(&self, proof: &P) -> Vec<FileChange> {
        let notes = self.notes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut changes = Vec::new();
        for noted in &notes.entries {
            let stamp = file_stamp(proof, &noted.full_path);
            if noted.stamp.is_none() && stamp.is_none() {
                continue;
            }
            // Uncaptured bytes compare by their stamp; captured ones byte for byte.
            let untouched = noted.stamp.is_some() && noted.stamp == stamp;
            if untouched && !matches!(noted.content, ChangeSide::Bytes(_)) {
                continue;
            }
            let after = match stamp {
                Some(_) => match review_file_content(proof, &noted.full_path, None) {
                    Ok(content) => ChangeSide::from(content),
                    Err(_) => continue,
                },
                None => ChangeSide::Absent,
            };
            if let (ChangeSide::Bytes(before), ChangeSide::Bytes(now)) = (&noted.content, &after)
                && before == now
            {
                continue;
            }
            changes.push(FileChange { path: noted.full_path.clone(), before: noted.content.clone(), after });
        }
        changes
    }
}
