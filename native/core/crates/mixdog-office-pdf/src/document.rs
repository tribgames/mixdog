//! Opening a PDF with the office options and choosing the pages of a call (`pdf/pdf-document.mjs`).

use std::collections::HashSet;
use std::fmt;
use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_pdf::PdfError;
use mixdog_pdf::document::{Document, OpenOptions, wrap_reason};
use mixdog_pdf::error::CancelCheck;

use crate::limits::MAX_PDF_ANALYSIS_PAGES;

/// What went wrong in an analysis call: the `name` and `message` of the exception Node would have thrown. The errors
/// of this crate are plain `Error`s; a failure of the reader keeps its pdf.js exception name (`PasswordException`,
/// `InvalidPDFException`, `UnknownErrorException`, `AbortException`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalysisError {
    pub name: String,
    pub message: String,
}

impl AnalysisError {
    /// `new Error(message)`.
    pub fn plain(message: impl Into<String>) -> Self {
        AnalysisError {
            name: "Error".to_owned(),
            message: message.into(),
        }
    }

    /// A failure of the reader, as the exception pdf.js's worker reports it.
    pub fn from_pdf(error: &PdfError) -> Self {
        let exception = wrap_reason(error);
        AnalysisError {
            name: exception.name.to_owned(),
            message: exception.message,
        }
    }

    /// A failure of the reader, except that the caller's cancellation is the call's own message.
    pub fn from_pdf_or_cancelled(error: &PdfError, cancelled: &str) -> Self {
        if matches!(error, PdfError::Cancelled) {
            AnalysisError::plain(cancelled)
        } else {
            AnalysisError::from_pdf(error)
        }
    }
}

impl fmt::Display for AnalysisError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AnalysisError {}

/// Where the document comes from: a path reads the file; bytes let a batch measure a document it is editing before
/// anything reaches the disk.
#[derive(Debug, Clone, Copy)]
pub enum PdfSource<'a> {
    Path(&'a Path),
    Bytes(&'a [u8]),
}

/// `openPdfJs`: the document with the office analysis configuration (`useSystemFonts: true`, no cMap or standard-font
/// URLs, errors ignored as pdf.js's default does). `cancel` is asked while pages are read.
pub fn open_pdf<P: ReadProof>(
    proof: &P,
    source: PdfSource<'_>,
    cancel: Option<CancelCheck>,
) -> Result<Document, AnalysisError> {
    let bytes = match source {
        PdfSource::Path(path) => mixdog_fsio::read(proof, path)
            .map_err(|error| AnalysisError::plain(error.to_string()))?,
        PdfSource::Bytes(bytes) => bytes.to_vec(),
    };
    let options = OpenOptions {
        cancel,
        ..OpenOptions::default()
    };
    Document::open(bytes, &options).map_err(|error| AnalysisError::from_pdf(&error))
}

/// `selectedPages`: the 1-based pages of a call, in the order given and each once, or every page when none are named.
/// More than [`MAX_PDF_ANALYSIS_PAGES`] is an error, and so is a page that is not a whole number inside the document.
pub fn selected_pages(total: i64, pages: Option<&[f64]>) -> Result<Vec<usize>, AnalysisError> {
    let values: Vec<f64> = match pages {
        Some(pages) if !pages.is_empty() => {
            let mut seen = HashSet::new();
            pages
                .iter()
                .copied()
                .filter(|page| seen.insert(same_value_zero_key(*page)))
                .collect()
        }
        _ => {
            if usize::try_from(total).is_ok_and(|total| total > MAX_PDF_ANALYSIS_PAGES) {
                return Err(too_many());
            }
            (1..=total.max(0)).map(|page| page as f64).collect()
        }
    };
    if values.len() > MAX_PDF_ANALYSIS_PAGES {
        return Err(too_many());
    }
    let mut out = Vec::with_capacity(values.len());
    for page in values {
        if !(page.is_finite() && page.fract() == 0.0) || page < 1.0 || page > total as f64 {
            return Err(AnalysisError::plain(format!(
                "PDF page out of range: {}",
                mixdog_js::number_to_string(page)
            )));
        }
        out.push(page as usize);
    }
    Ok(out)
}

fn too_many() -> AnalysisError {
    AnalysisError::plain(format!(
        "PDF analysis accepts at most {MAX_PDF_ANALYSIS_PAGES} pages per call"
    ))
}

/// `Set` membership: NaN equals NaN and -0 equals +0.
fn same_value_zero_key(value: f64) -> u64 {
    if value.is_nan() {
        f64::NAN.to_bits()
    } else if value == 0.0 {
        0.0f64.to_bits()
    } else {
        value.to_bits()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_page_when_none_are_named() {
        assert_eq!(selected_pages(3, None).unwrap(), [1, 2, 3]);
        assert_eq!(selected_pages(3, Some(&[])).unwrap(), [1, 2, 3]);
    }

    #[test]
    fn named_pages_keep_their_order_and_appear_once() {
        assert_eq!(
            selected_pages(5, Some(&[3.0, 1.0, 3.0, 1.0, 2.0])).unwrap(),
            [3, 1, 2]
        );
    }

    #[test]
    fn a_page_outside_the_document_is_named() {
        for (page, text) in [
            (0.0, "0"),
            (4.0, "4"),
            (1.5, "1.5"),
            (f64::NAN, "NaN"),
            (-2.0, "-2"),
        ] {
            let error = selected_pages(3, Some(&[page])).unwrap_err();
            assert_eq!(error.message, format!("PDF page out of range: {text}"));
            assert_eq!(error.name, "Error");
        }
    }

    #[test]
    fn more_than_the_limit_is_refused_before_the_range_is_checked() {
        let many: Vec<f64> = (1..=101).map(f64::from).collect();
        let error = selected_pages(1000, Some(&many)).unwrap_err();
        assert_eq!(
            error.message,
            "PDF analysis accepts at most 100 pages per call"
        );
        let range: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(selected_pages(100, Some(&range)).unwrap().len(), 100);
        assert_eq!(
            selected_pages(101, None).unwrap_err().message,
            "PDF analysis accepts at most 100 pages per call"
        );
        let beyond: Vec<f64> = (1..=100).map(|page| f64::from(page) + 5.0).collect();
        assert_eq!(
            selected_pages(100, Some(&beyond)).unwrap_err().message,
            "PDF page out of range: 101"
        );
    }

    #[test]
    fn a_repeated_page_does_not_count_twice_toward_the_limit() {
        let repeated = vec![1.0; 500];
        assert_eq!(selected_pages(2, Some(&repeated)).unwrap(), [1]);
    }

    #[test]
    fn the_reader_failure_keeps_its_exception_name() {
        let error = AnalysisError::from_pdf(&PdfError::incorrect_password());
        assert_eq!(
            (error.name.as_str(), error.message.as_str()),
            ("PasswordException", "Incorrect Password")
        );
        let cancelled = AnalysisError::from_pdf_or_cancelled(
            &PdfError::Cancelled,
            "PDF layout extraction was cancelled",
        );
        assert_eq!(cancelled.message, "PDF layout extraction was cancelled");
    }
}
