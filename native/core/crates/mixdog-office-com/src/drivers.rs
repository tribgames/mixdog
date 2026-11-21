//! The two tables of the formats: which reader and which editor serves `docx`, `xlsx` and `pptx`.

use crate::format::FormatEditor;
use crate::format::FormatReader;

/// The readers: one line per format, `("docx", &crate::word::Reader)`.
static READERS: &[(&str, &dyn FormatReader)] = &[("docx", &crate::word::Reader), ("xlsx", &crate::excel::Reader), ("pptx", &crate::ppt::Reader)];

/// The editors: one line per format, `("docx", &crate::word::Editor)`.
static EDITORS: &[(&str, &dyn FormatEditor)] = &[("docx", &crate::word::Editor), ("xlsx", &crate::excel::edit::Editor), ("pptx", &crate::ppt::edit::Editor)];

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
