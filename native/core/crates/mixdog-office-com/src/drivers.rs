//! The two tables of the formats: which reader and which editor serves `docx`, `xlsx` and `pptx`.
//!
//! Each application task adds its own line to the table it fills (through its wire fragment), so the readers and the editors
//! of one application are written independently of the shared actions. A format with no line is answered as a format
//! nobody can read or edit yet.

use crate::format::FormatEditor;
use crate::format::FormatReader;

/// The readers: one line per format, `("docx", &crate::word::Reader)`.
static READERS: &[(&str, &dyn FormatReader)] = &[];

/// The editors: one line per format, `("docx", &crate::word::Editor)`.
static EDITORS: &[(&str, &dyn FormatEditor)] = &[];

/// The tables the actions run against; a test passes tables of its own.
#[derive(Clone, Copy)]
pub struct Drivers<'a> {
    readers: &'a [(&'a str, &'a dyn FormatReader)],
    editors: &'a [(&'a str, &'a dyn FormatEditor)],
}

impl<'a> Drivers<'a> {
    pub fn new(readers: &'a [(&'a str, &'a dyn FormatReader)], editors: &'a [(&'a str, &'a dyn FormatEditor)]) -> Self {
        Self { readers, editors }
    }

    /// The tables the host runs on.
    pub fn registered() -> Drivers<'static> {
        Drivers { readers: READERS, editors: EDITORS }
    }

    pub fn reader(&self, format: &str) -> Option<&'a dyn FormatReader> {
        self.readers.iter().find(|(name, _)| *name == format).map(|(_, reader)| *reader)
    }

    pub fn editor(&self, format: &str) -> Option<&'a dyn FormatEditor> {
        self.editors.iter().find(|(name, _)| *name == format).map(|(_, editor)| *editor)
    }
}
