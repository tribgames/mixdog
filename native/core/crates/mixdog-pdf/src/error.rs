//! The failures of the reader, named and worded as pdf.js's exception classes (`InvalidPDFException`,
//! `FormatError`, `PasswordException`, `XRefEntryException`, `XRefParseException`, `ParserEOFException`), and the
//! cancellation and resource budget every loop of the crate checks.

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// `PasswordResponses.NEED_PASSWORD`.
pub const NEED_PASSWORD: u8 = 1;
/// `PasswordResponses.INCORRECT_PASSWORD`.
pub const INCORRECT_PASSWORD: u8 = 2;

/// One failure of the reader. `name()` and `message()` are the pdf.js exception's `name` and `message`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfError {
    /// `PasswordException`: `code` is [`NEED_PASSWORD`] or [`INCORRECT_PASSWORD`].
    Password { message: String, code: u8 },
    /// `InvalidPDFException`, for example `Invalid PDF structure.`.
    InvalidPdf(String),
    /// `FormatError`.
    Format(String),
    /// `ParserEOFException`: the file ended inside an array or a dictionary.
    ParserEof(String),
    /// `XRefEntryException`: an xref entry does not lead to the object it names. Triggers the reconstruction.
    XRefEntry(String),
    /// `XRefParseException`: the cross-reference data cannot be used. Triggers the reconstruction.
    XRefParse,
    /// `UnknownErrorException`.
    Unknown(String),
    /// The caller's [`CancelCheck`] said stop (pdf.js: `AbortException`).
    Cancelled,
    /// A bound of the [`Budget`] was reached.
    ResourceLimit(String),
}

/// `Result` of the reader.
pub type Result<T> = std::result::Result<T, PdfError>;

impl PdfError {
    /// `PasswordException` with code 1 (`No password given`).
    pub fn need_password() -> Self {
        PdfError::Password {
            message: "No password given".to_owned(),
            code: NEED_PASSWORD,
        }
    }

    /// `PasswordException` with code 2 (`Incorrect Password`).
    pub fn incorrect_password() -> Self {
        PdfError::Password {
            message: "Incorrect Password".to_owned(),
            code: INCORRECT_PASSWORD,
        }
    }

    /// The exception class name pdf.js gives this failure.
    pub fn name(&self) -> &'static str {
        match self {
            PdfError::Password { .. } => "PasswordException",
            PdfError::InvalidPdf(_) => "InvalidPDFException",
            PdfError::Format(_) => "FormatError",
            PdfError::ParserEof(_) => "ParserEOFException",
            PdfError::XRefEntry(_) => "XRefEntryException",
            PdfError::XRefParse => "XRefParseException",
            PdfError::Unknown(_) => "UnknownErrorException",
            PdfError::Cancelled => "AbortException",
            PdfError::ResourceLimit(_) => "ResourceLimitException",
        }
    }

    /// The exception's message (`XRefParseException` has none, as in pdf.js).
    pub fn message(&self) -> &str {
        match self {
            PdfError::Password { message, .. }
            | PdfError::InvalidPdf(message)
            | PdfError::Format(message)
            | PdfError::ParserEof(message)
            | PdfError::XRefEntry(message)
            | PdfError::Unknown(message)
            | PdfError::ResourceLimit(message) => message,
            PdfError::XRefParse => "",
            PdfError::Cancelled => "Worker was terminated.",
        }
    }

    /// A failure no recovery step of pdf.js swallows: the caller stopped the work or a bound was reached. Where
    /// pdf.js catches every exception (`tryShift`, the `readXRef` loop, an invalid stream filter), these still
    /// propagate.
    pub fn is_fatal(&self) -> bool {
        matches!(self, PdfError::Cancelled | PdfError::ResourceLimit(_))
    }

    pub(crate) fn format(message: impl Into<String>) -> Self {
        PdfError::Format(message.into())
    }
}

impl fmt::Display for PdfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PdfError::XRefParse | PdfError::Cancelled => f.write_str(self.name()),
            _ => write!(f, "{}: {}", self.name(), self.message()),
        }
    }
}

impl std::error::Error for PdfError {}

/// Asked at the loops of the reader; `true` stops the work with [`PdfError::Cancelled`].
pub type CancelCheck = Arc<dyn Fn() -> bool + Send + Sync>;

/// The bounds of one reader: what a hostile file cannot push past.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    /// Objects one parser may read, and cross-reference entries one document may hold.
    pub max_objects: usize,
    /// Nesting of arrays and dictionaries.
    pub max_depth: usize,
    /// Bytes one decoded stream may produce.
    pub max_bytes: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Budget {
            max_objects: 50_000_000,
            max_depth: 1000,
            max_bytes: 1 << 30,
        }
    }
}

/// How many ticks pass between two asks of the [`CancelCheck`].
const CANCEL_EVERY: usize = 256; // a power of two: `tick` masks instead of dividing

/// The cancel callback and the budget of one reader, shared by its lexers, parsers and cross-reference table.
pub struct Guard {
    cancel: Option<CancelCheck>,
    budget: Budget,
    ticks: AtomicUsize,
}

impl fmt::Debug for Guard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Guard")
            .field("budget", &self.budget)
            .field("cancel", &self.cancel.is_some())
            .finish()
    }
}

impl Guard {
    pub fn new(cancel: Option<CancelCheck>, budget: Budget) -> Arc<Self> {
        Arc::new(Guard {
            cancel,
            budget,
            ticks: AtomicUsize::new(0),
        })
    }

    /// No cancellation, the default budget.
    pub fn unbounded() -> Arc<Self> {
        Guard::new(None, Budget::default())
    }

    pub fn budget(&self) -> Budget {
        self.budget
    }

    /// One step of a loop: asks the cancel callback every [`CANCEL_EVERY`] steps.
    pub fn tick(&self) -> Result<()> {
        let Some(cancel) = &self.cancel else {
            return Ok(());
        };
        if self.ticks.fetch_add(1, Ordering::Relaxed) & (CANCEL_EVERY - 1) == 0 && cancel() {
            return Err(PdfError::Cancelled);
        }
        Ok(())
    }

    /// Asks the cancel callback now (before a long call into code that does not tick).
    pub fn check_now(&self) -> Result<()> {
        match &self.cancel {
            Some(cancel) if cancel() => Err(PdfError::Cancelled),
            _ => Ok(()),
        }
    }

    pub(crate) fn check_objects(&self, count: usize) -> Result<()> {
        if count > self.budget.max_objects {
            return Err(PdfError::ResourceLimit(format!(
                "more than {} objects",
                self.budget.max_objects
            )));
        }
        Ok(())
    }

    pub(crate) fn check_depth(&self, depth: usize) -> Result<()> {
        if depth > self.budget.max_depth {
            return Err(PdfError::ResourceLimit(format!(
                "nesting deeper than {}",
                self.budget.max_depth
            )));
        }
        Ok(())
    }
}
