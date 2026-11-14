//! The seam through which a writer reports the workspace file it is about to write (`noteOfficeWrite`, which found the
//! call's ledger through an `AsyncLocalStorage`).
//!
//! Every route that writes a workspace file (the session's working copy, a created or converted document, a render's
//! preview and page images, a split/extract/query output, an authored document and its sidecars, a secured PDF) hands
//! the path to [`WriteNote::note_write`] BEFORE it writes, so the call's turn review can capture the file's prior state
//! and count the change as its own. The engine receives the note as a parameter; the tool call supplies the ledger.

use std::path::Path;

/// Reports a workspace file that is about to be written.
pub trait WriteNote: Send + Sync {
    fn note_write(&self, path: &Path);
}

/// The note of a caller outside a tool call: nothing is recorded.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoWriteNote;

impl WriteNote for NoWriteNote {
    fn note_write(&self, _path: &Path) {}
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Recording(Mutex<Vec<String>>);

    impl WriteNote for Recording {
        fn note_write(&self, path: &Path) {
            self.0.lock().expect("lock").push(path.display().to_string());
        }
    }

    #[test]
    fn the_noop_note_accepts_any_path_and_a_ledger_sees_each() {
        NoWriteNote.note_write(Path::new("a.docx"));
        let ledger = Recording(Mutex::new(Vec::new()));
        let note: &dyn WriteNote = &ledger;
        note.note_write(Path::new("a.docx"));
        note.note_write(Path::new("b.pdf"));
        assert_eq!(*ledger.0.lock().expect("lock"), ["a.docx", "b.pdf"]);
    }
}
