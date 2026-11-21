//! Bounded PDF inspection and text extraction shared by prompt intake and `read` (`attachments/pdf-extract.mjs`).
//!
//! Native PDF-capable providers receive the original content-addressed file. Providers without a document contract
//! receive the page-ordered text extracted here. [`inspect_pdf_buffer`] opens the document with the reference
//! configuration (system fonts on, font faces off, errors ignored) and answers the page count, the text of the pages in
//! a range cut to a byte budget, or the text-layer counts of the whole document.
//!
//! pdf.js's `timeoutMs` destroys a document that is still loading; here the deadline is checked between pages and inside
//! the reader's loops (through its cancel check), and answers [`InspectError::Timeout`].

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::document::{Document, OpenOptions, wrap_reason};
use crate::error::{CancelCheck, PdfError};
use crate::fonts::font::FontLoader;
use crate::text::{TextContent, font_loader};

/// `MAX_PDF_PAGES` of `attachments/limits.mjs`: most pages a native PDF block may carry.
pub const MAX_PDF_PAGES: u64 = 100;
/// `DEFAULT_MAX_OUTPUT_BYTES`.
pub const DEFAULT_MAX_OUTPUT_BYTES: f64 = 1024.0 * 1024.0;
/// `PDF_INTAKE_TIMEOUT_MS`: the deadline prompt intake passes, because it runs inside a room's post queue, which a
/// document that never loads would otherwise hold forever.
pub const PDF_INTAKE_TIMEOUT_MS: f64 = 60_000.0;
/// `PDF_TEXT_LAYER_MIN_CHARS`: a page carries a text layer when its text holds this many non-white-space characters. A
/// scan often keeps a stamped page number or a few stray glyphs; those alone do not make its content readable as text.
const PDF_TEXT_LAYER_MIN_CHARS: usize = 16;
/// What follows the text a byte budget cut short.
const TRUNCATION_SUFFIX: &str = "\n\n... [PDF text truncated to the prompt input budget]";

/// A page range as the caller wrote it: `Number(...)` of the two bounds, `NaN` where one was left out.
#[derive(Debug, Clone, Copy)]
pub struct PageRange {
    pub from: f64,
    pub to: f64,
}

/// The options of [`inspect_pdf_buffer`]; the default is the one of `inspectPdfBuffer` called without any.
#[derive(Clone)]
pub struct InspectOptions {
    pub extract_text: bool,
    pub measure_text: bool,
    /// The most pages the document may have; `None` is no limit.
    pub max_pages: Option<u64>,
    /// `Number(maxOutputBytes)`; zero and `NaN` mean the default, and the budget is at least one byte.
    pub max_output_bytes: f64,
    pub page_range: Option<PageRange>,
    /// Empty or absent: the empty user password is tried.
    pub password: Option<String>,
    /// The deadline in milliseconds when it is above zero.
    pub timeout_ms: Option<f64>,
    /// Asked at the reader's loops and between pages; `true` stops the work with [`InspectError::Cancelled`].
    pub cancel: Option<CancelCheck>,
}

impl Default for InspectOptions {
    fn default() -> Self {
        InspectOptions {
            extract_text: false,
            measure_text: false,
            max_pages: Some(MAX_PDF_PAGES),
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            page_range: None,
            password: None,
            timeout_ms: None,
            cancel: None,
        }
    }
}

/// The text of one page and its layer classification before any output cut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageText {
    pub page: u64,
    pub text: String,
    pub has_text_layer: bool,
}

/// What was asked of the pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Detail {
    /// Neither extraction nor measurement: `{pageCount, text: '', truncated: false}`.
    Nothing,
    /// `measureText`: the pages that carry a text layer and the characters (UTF-16 units) they hold.
    Counts { text_pages: u64, text_chars: u64 },
    /// `extractText`.
    Text { text: String, truncated: bool, pages: Vec<PageText> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspection {
    pub page_count: u64,
    pub detail: Detail,
}

/// Why an inspection did not answer.
#[derive(Debug, Clone, PartialEq)]
pub enum InspectError {
    /// `TypeError('PDF payload is empty')`.
    Empty,
    /// `RangeError`: the document has more pages than the limit.
    TooManyPages { count: u64, limit: u64 },
    /// The document or one of its pages cannot be read: pdf.js's exception.
    Pdf(PdfError),
    /// `PDF_INSPECTION_TIMEOUT`, with the deadline in milliseconds as the caller gave it.
    Timeout(f64),
    /// `Error('Invalid page request.')`: a page range with a fractional bound.
    InvalidPage,
    /// The caller's cancel check said stop.
    Cancelled,
}

impl InspectError {
    /// The `code` of the error the Node worker answers (`String(error.code ?? 'failed')`): a pdf.js
    /// `PasswordException` carries its number, the deadline its name, everything else none.
    pub fn code(&self) -> String {
        match self {
            InspectError::Pdf(PdfError::Password { code, .. }) => code.to_string(),
            InspectError::Timeout(_) => "PDF_INSPECTION_TIMEOUT".to_owned(),
            InspectError::Cancelled => "cancelled".to_owned(),
            _ => "failed".to_owned(),
        }
    }

    /// The error's `message`.
    pub fn message(&self) -> String {
        match self {
            InspectError::Empty => "PDF payload is empty".to_owned(),
            InspectError::TooManyPages { count, limit } => {
                format!("PDF has {count} pages; maximum supported attachment is {limit} pages")
            }
            InspectError::Pdf(error) => wrap_reason(error).message,
            InspectError::Timeout(ms) => {
                format!("PDF inspection timed out after {} ms", mixdog_js::number_to_string(*ms))
            }
            InspectError::InvalidPage => "Invalid page request.".to_owned(),
            InspectError::Cancelled => "call cancelled".to_owned(),
        }
    }
}

impl std::fmt::Display for InspectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// A text cut to a byte budget (`boundedUtf8`'s answer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bounded {
    pub text: String,
    pub bytes: usize,
    pub truncated: bool,
}

/// `value` cut to at most `max_bytes` of UTF-8, never inside a multi-byte sequence (`boundedUtf8` with
/// `stripTrailingReplacementChars`: the U+FFFD characters a byte cut leaves behind are removed, so a replacement character
/// the text itself held at the cut goes with them). `max_bytes` is a JavaScript number: a fractional bound cuts at its
/// integer part.
pub fn bounded_utf8(value: &str, max_bytes: f64) -> Bounded {
    let length = value.len();
    if length as f64 <= max_bytes {
        return Bounded { text: value.to_owned(), bytes: length, truncated: false };
    }
    if max_bytes <= 0.0 {
        return Bounded { text: String::new(), bytes: 0, truncated: true };
    }
    // `as usize` is 0 for NaN and saturates, as `subarray`'s integer conversion does.
    let mut cut = (max_bytes.trunc() as usize).min(length);
    while !value.is_char_boundary(cut) {
        cut -= 1;
    }
    let text = value[..cut].trim_end_matches('\u{fffd}').to_owned();
    Bounded { bytes: text.len(), text, truncated: true }
}

/// One run of a page's text as `pageBodyText` reads it.
#[derive(Debug, Clone, Copy)]
pub struct Run<'a> {
    pub text: &'a str,
    pub transform: [f64; 6],
    pub width: f64,
    pub has_eol: bool,
}

/// Where a text run sits on its line: the baseline identifies the line, and the start and end positions say whether the next
/// run continues a word or stands apart from it.
#[derive(Clone, Copy)]
struct Placement {
    line: f64,
    start: f64,
    end: f64,
    size: f64,
}

/// `runPlacement`: rotated or skewed runs, and runs with a transform that is not finite, have no horizontal line to measure.
fn run_placement(run: &Run<'_>) -> Option<Placement> {
    if run.transform.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let [a, b, _, d, e, f] = run.transform;
    if b != 0.0 {
        return None;
    }
    let size = [d.abs(), a.abs()].into_iter().find(|value| *value != 0.0).unwrap_or(1.0);
    Some(Placement { line: mixdog_js::math::round(f * 10.0) / 10.0, start: e, end: e + if run.width.is_finite() { run.width } else { 0.0 }, size })
}

/// One page's text. pdf.js marks where each text line ends; keeping that as a newline preserves paragraphs and table rows
/// instead of one long run (`pageBodyText`).
pub fn page_body_text<'a>(runs: impl IntoIterator<Item = Run<'a>>) -> String {
    let mut body = String::new();
    let mut cursor: Option<Placement> = None;
    for run in runs {
        if !run.text.is_empty() {
            let placement = run_placement(&run);
            // A run on another baseline is another line even when the writer marked no line end (a browser's print does not):
            // "784" over its label read as "784office". A baseline shift under half the smaller run's size (a superscript,
            // a mixed-size run) stays on the line.
            let shift = match (&placement, &cursor) {
                (Some(now), Some(before)) => (now.line - before.line).abs(),
                _ => 0.0,
            };
            let smaller = placement.map_or(0.0, |now| now.size).min(cursor.map_or(0.0, |before| before.size));
            let new_line = shift > smaller * 0.5;
            if new_line && !body.is_empty() && !body.ends_with('\n') {
                body.push('\n');
            }
            // A writer splits one word into several runs for kerning, and a Korean line into a run per token; joining those
            // with a space invents "2026 년". Only a gap the page itself leaves is a space.
            let separated = match (&placement, &cursor) {
                (Some(now), Some(before)) if !new_line => now.start - before.end > before.size * 0.22,
                (now, before) => now.is_none() || before.is_none(),
            };
            let glued = body.is_empty() || body.ends_with('\n') || body.ends_with(' ') || run.text.starts_with(' ') || !separated;
            if !glued {
                body.push(' ');
            }
            body.push_str(run.text);
            cursor = placement;
        }
        if run.has_eol && !body.ends_with('\n') {
            body.push('\n');
            cursor = None;
        }
    }
    tidy(&body)
}

/// The closing clean-up of `pageBodyText`: `/[ \t]+\n/g` to a newline, `/\n{3,}/g` to two, then `trim`.
fn tidy(body: &str) -> String {
    let mut lines = String::with_capacity(body.len());
    let mut blanks = String::new();
    for c in body.chars() {
        match c {
            ' ' | '\t' => blanks.push(c),
            '\n' => {
                blanks.clear();
                lines.push('\n');
            }
            other => {
                lines.push_str(&blanks);
                blanks.clear();
                lines.push(other);
            }
        }
    }
    lines.push_str(&blanks);
    let mut collapsed = String::with_capacity(lines.len());
    let mut newlines = 0usize;
    for c in lines.chars() {
        if c == '\n' {
            newlines += 1;
            if newlines <= 2 {
                collapsed.push('\n');
            }
        } else {
            newlines = 0;
            collapsed.push(c);
        }
    }
    mixdog_js::js_trim(&collapsed).to_owned()
}

/// The page text of a `getTextContent` answer.
fn content_text(content: &TextContent) -> String {
    let texts: Vec<String> = content.items.iter().map(|item| item.text()).collect();
    page_body_text(content.items.iter().zip(&texts).map(|(item, text)| Run { text, transform: item.transform, width: item.width, has_eol: item.has_eol }))
}

/// `pageHasTextLayer`: whether one page's extracted text is a real text layer. The count is of UTF-16 units, as `length` of
/// the white-space-free string is.
pub fn page_has_text_layer(text: &str) -> bool {
    let units: usize = text.chars().filter(|c| !mixdog_js::is_js_space(*c)).map(char::len_utf16).sum();
    units >= PDF_TEXT_LAYER_MIN_CHARS
}

/// The deadline and the caller's cancel check of one inspection.
struct Watch {
    deadline: Option<(Instant, f64)>,
    external: Option<CancelCheck>,
    expired: AtomicBool,
}

impl Watch {
    /// Whether the work must stop; a passed deadline is remembered.
    fn stopped(&self) -> bool {
        if let Some((at, _)) = self.deadline
            && Instant::now() >= at
        {
            self.expired.store(true, Ordering::Relaxed);
            return true;
        }
        self.external.as_ref().is_some_and(|check| check())
    }

    /// Between two steps: the error that stops the inspection, if one does.
    fn check(&self) -> Result<(), InspectError> {
        if self.stopped() { Err(self.stop_error()) } else { Ok(()) }
    }

    fn stop_error(&self) -> InspectError {
        match self.deadline {
            Some((_, ms)) if self.expired.load(Ordering::Relaxed) => InspectError::Timeout(ms),
            _ => InspectError::Cancelled,
        }
    }

    /// The error of a failed step: a reader that stopped because it was asked to is the deadline or the cancellation, not
    /// the document's failure.
    fn map(&self, error: PdfError) -> InspectError {
        match error {
            PdfError::Cancelled => self.stop_error(),
            other => InspectError::Pdf(other),
        }
    }
}

/// `Number(x) || fallback`.
fn number_or(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 { fallback } else { value }
}

/// Inspects a PDF (`inspectPdfBuffer`). With `timeout_ms` above zero, a document that has not finished by then answers
/// [`InspectError::Timeout`]; without it there is no deadline.
pub fn inspect_pdf_buffer(buffer: &[u8], options: &InspectOptions) -> Result<Inspection, InspectError> {
    inspect_pdf_input(buffer, options, false)
}

/// Inspects owned or shared PDF bytes without first copying them into a temporary `Vec`.
/// `bound_page_text` limits the per-page payload to what a caller's output budget could display.
pub fn inspect_pdf_input(buffer: impl Into<Arc<[u8]>>, options: &InspectOptions, bound_page_text: bool) -> Result<Inspection, InspectError> {
    let deadline = options.timeout_ms.filter(|ms| *ms > 0.0).and_then(|ms| {
        let span = Duration::try_from_secs_f64(ms / 1000.0).ok()?;
        Some((Instant::now().checked_add(span)?, ms))
    });
    let watch = Arc::new(Watch { deadline, external: options.cancel.clone(), expired: AtomicBool::new(false) });
    watch.check()?;
    let buffer = buffer.into();
    watch.check()?;
    if buffer.is_empty() {
        return Err(InspectError::Empty);
    }
    let reader_watch = watch.clone();
    let open = OpenOptions {
        password: options.password.clone().filter(|password| !password.is_empty()),
        cancel: Some(Arc::new(move || reader_watch.stopped())),
        ..OpenOptions::default()
    };
    let document = Document::open(buffer, &open).map_err(|error| watch.map(error))?;
    let page_count = u64::try_from(document.num_pages().max(0)).unwrap_or(0);
    if let Some(limit) = options.max_pages
        && page_count > limit
    {
        return Err(InspectError::TooManyPages { count: page_count, limit });
    }
    if options.measure_text {
        let (text_pages, text_chars) = measure_text_layer(&document, page_count, &watch)?;
        return Ok(Inspection { page_count, detail: Detail::Counts { text_pages, text_chars } });
    }
    if !options.extract_text {
        return Ok(Inspection { page_count, detail: Detail::Nothing });
    }
    extract(&document, page_count, options, &watch, bound_page_text)
}

/// The text of one page, by its 1-based number.
fn page_text(document: &Document, fonts: &FontLoader, number: u64, watch: &Watch) -> Result<String, InspectError> {
    let index = usize::try_from(number - 1).map_err(|_| InspectError::InvalidPage)?;
    let page = document.page(index).map_err(|error| watch.map(error))?;
    let content = page.text_content(document, fonts).map_err(|error| watch.map(error))?;
    Ok(content_text(&content))
}

/// `end` moved forward to a char boundary of `text`: up to three bytes past the cut keep the complete scalar there.
fn char_boundary_from(text: &str, mut end: usize) -> usize {
    while !text.is_char_boundary(end) {
        end += 1;
    }
    end
}

/// The page heading and the page's text cut to `remaining` bytes of the output budget, without copying the whole page.
fn page_chunk(body: &str, page: u64, remaining: f64) -> Bounded {
    let head = format!("--- Page {page} ---\n");
    let text = if body.is_empty() { "(no extractable text on this page)" } else { body };
    let end = char_boundary_from(text, (remaining as usize).min(text.len()));
    bounded_utf8(&(head + &text[..end]), remaining)
}

fn extract(document: &Document, page_count: u64, options: &InspectOptions, watch: &Watch, bound_page_text: bool) -> Result<Inspection, InspectError> {
    let count = page_count as f64;
    let (range_from, range_to) = options.page_range.map_or((f64::NAN, f64::NAN), |range| (range.from, range.to));
    let from = number_or(range_from, 1.0).max(1.0);
    let to = count.min(from.max(number_or(range_to, count)));
    let byte_limit = number_or(options.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES).max(1.0);
    let fonts = font_loader(document);
    let mut chunks: Vec<String> = Vec::new();
    // Each page's own text (before the output budget cuts it), so a caller can tell text pages from scanned ones.
    let mut pages: Vec<PageText> = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    let mut number = from;
    while number <= to {
        watch.check()?;
        if number.fract() != 0.0 {
            return Err(InspectError::InvalidPage);
        }
        let page = number as u64;
        let mut body = page_text(document, &fonts, page, watch)?;
        let has_text_layer = page_has_text_layer(&body);
        let separator_bytes = if chunks.is_empty() { 0 } else { 2 };
        let remaining = byte_limit - bytes as f64 - separator_bytes as f64;
        let bounded = (remaining > 0.0).then(|| page_chunk(&body, page, remaining));
        if bound_page_text {
            let end = char_boundary_from(&body, (byte_limit as usize).saturating_add(1).min(body.len()));
            if end < body.len() {
                body = body[..end].to_owned();
            }
        }
        pages.push(PageText { page, text: body, has_text_layer });
        let Some(bounded) = bounded else {
            truncated = true;
            break;
        };
        if !chunks.is_empty() {
            chunks.push("\n\n".to_owned());
            bytes += 2;
        }
        bytes += bounded.bytes;
        chunks.push(bounded.text);
        if bounded.truncated {
            truncated = true;
            break;
        }
        number += 1.0;
    }
    let joined = chunks.concat();
    if truncated {
        let room = (byte_limit - TRUNCATION_SUFFIX.len() as f64).max(0.0);
        let bounded = bounded_utf8(&joined, room);
        return Ok(Inspection { page_count, detail: Detail::Text { text: format!("{}{TRUNCATION_SUFFIX}", bounded.text), truncated: true, pages } });
    }
    Ok(Inspection { page_count, detail: Detail::Text { text: joined, truncated: false, pages } })
}

/// How much of the document reads as text: the pages that carry a text layer and the characters they hold. Nothing is kept
/// but the counts (`measureTextLayer`).
fn measure_text_layer(document: &Document, page_count: u64, watch: &Watch) -> Result<(u64, u64), InspectError> {
    let fonts = font_loader(document);
    let (mut text_pages, mut text_chars) = (0u64, 0u64);
    for number in 1..=page_count {
        watch.check()?;
        let body = page_text(document, &fonts, number, watch)?;
        if page_has_text_layer(&body) {
            text_pages += 1;
            text_chars += mixdog_js::utf16_len(&body) as u64;
        }
    }
    Ok((text_pages, text_chars))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, x: f64, y: f64, size: f64, width: f64, eol: bool) -> Run<'_> {
        Run { text, transform: [size, 0.0, 0.0, size, x, y], width, has_eol: eol }
    }

    #[test]
    fn a_cut_never_lands_inside_a_character_and_never_leaves_replacement_characters() {
        assert_eq!(bounded_utf8("abc", 3.0), Bounded { text: "abc".into(), bytes: 3, truncated: false });
        assert_eq!(bounded_utf8("abc", 0.0), Bounded { text: String::new(), bytes: 0, truncated: true });
        // A Hangul syllable is three bytes: a cut after the third byte keeps only "a".
        assert_eq!(bounded_utf8("a가", 3.0), Bounded { text: "a".into(), bytes: 1, truncated: true });
        assert_eq!(bounded_utf8("a가", 4.0), Bounded { text: "a가".into(), bytes: 4, truncated: false });
        assert_eq!(bounded_utf8("ab\u{fffd}\u{fffd}cd", 7.0).text, "ab");
        assert_eq!(bounded_utf8("abcd", 2.9).text, "ab");
    }

    #[test]
    fn runs_of_one_line_join_without_a_space_unless_the_page_leaves_a_gap() {
        let runs = [run("2026", 0.0, 100.0, 10.0, 20.0, false), run("년", 20.5, 100.0, 10.0, 10.0, false), run("end", 40.0, 100.0, 10.0, 15.0, false)];
        assert_eq!(page_body_text(runs), "2026년 end");
    }

    #[test]
    fn a_baseline_shift_over_half_the_size_starts_a_line_and_a_small_one_does_not() {
        let apart = [run("label", 0.0, 100.0, 10.0, 30.0, false), run("784", 0.0, 112.0, 10.0, 15.0, false)];
        assert_eq!(page_body_text(apart), "label\n784");
        let superscript = [run("x", 0.0, 100.0, 10.0, 5.0, false), run("2", 5.0, 103.0, 10.0, 5.0, false)];
        assert_eq!(page_body_text(superscript), "x2");
    }

    #[test]
    fn a_rotated_run_has_no_line_and_is_separated_from_its_neighbours() {
        let rotated = Run { text: "up", transform: [0.0, 10.0, -10.0, 0.0, 5.0, 5.0], width: 5.0, has_eol: false };
        assert_eq!(page_body_text([run("a", 0.0, 0.0, 10.0, 5.0, false), rotated]), "a up");
    }

    #[test]
    fn line_ends_are_newlines_and_the_clean_up_trims_blanks_and_collapses_blank_lines() {
        let runs = [
            run("one", 0.0, 100.0, 10.0, 15.0, true),
            run("", 0.0, 90.0, 10.0, 0.0, true),
            run("", 0.0, 80.0, 10.0, 0.0, true),
            run("two ", 0.0, 70.0, 10.0, 20.0, true),
        ];
        assert_eq!(page_body_text(runs), "one\ntwo");
        assert_eq!(tidy("a \t \nb\n\n\n\nc  "), "a\nb\n\nc");
    }

    #[test]
    fn the_baseline_is_rounded_the_way_math_round_rounds_it() {
        let line = |y: f64| run_placement(&run("a", 0.0, y, 10.0, 1.0, false)).map(|placement| placement.line);
        assert_eq!(line(100.04), Some(100.0));
        // -0.25 * 10 = -2.5, which Math.round takes up to -2.
        assert_eq!(line(-0.25), Some(-0.2));
    }

    #[test]
    fn a_text_layer_needs_sixteen_characters_besides_white_space() {
        assert!(!page_has_text_layer("1234567890 12345"));
        assert!(page_has_text_layer("1234567890 123456"));
        assert!(!page_has_text_layer(""));
        // Astral characters count as two UTF-16 units each.
        assert!(page_has_text_layer(&"😀".repeat(8)));
    }

    #[test]
    fn an_empty_payload_is_a_type_error_and_garbage_is_a_pdf_error() {
        let empty = inspect_pdf_buffer(&[], &InspectOptions::default()).unwrap_err();
        assert_eq!((empty.code().as_str(), empty.message().as_str()), ("failed", "PDF payload is empty"));
        let garbage = inspect_pdf_buffer(b"this is not a pdf", &InspectOptions::default()).unwrap_err();
        assert_eq!(garbage.message(), "Invalid PDF structure.");
    }

    #[test]
    fn the_messages_and_codes_follow_the_node_errors() {
        let many = InspectError::TooManyPages { count: 101, limit: 100 };
        assert_eq!(many.message(), "PDF has 101 pages; maximum supported attachment is 100 pages");
        assert_eq!(many.code(), "failed");
        assert_eq!(InspectError::Timeout(60000.0).message(), "PDF inspection timed out after 60000 ms");
        assert_eq!(InspectError::Timeout(60000.0).code(), "PDF_INSPECTION_TIMEOUT");
        assert_eq!(InspectError::Pdf(PdfError::need_password()).code(), "1");
        assert_eq!(InspectError::Pdf(PdfError::incorrect_password()).code(), "2");
        assert_eq!(InspectError::Pdf(PdfError::incorrect_password()).message(), "Incorrect Password");
    }

    #[test]
    fn a_deadline_already_past_times_out_and_a_cancel_check_cancels() {
        let past = Watch { deadline: Some((Instant::now(), 5.0)), external: None, expired: AtomicBool::new(false) };
        assert_eq!(past.check(), Err(InspectError::Timeout(5.0)));
        assert_eq!(past.map(PdfError::Cancelled), InspectError::Timeout(5.0));
        let asked = Watch { deadline: None, external: Some(Arc::new(|| true)), expired: AtomicBool::new(false) };
        assert_eq!(asked.check(), Err(InspectError::Cancelled));
        let cancelled = InspectOptions { cancel: Some(Arc::new(|| true)), ..InspectOptions::default() };
        assert_eq!(inspect_pdf_buffer(b"%PDF-1.4", &cancelled).unwrap_err(), InspectError::Cancelled);
        let fine = Watch { deadline: None, external: None, expired: AtomicBool::new(false) };
        assert_eq!(fine.check(), Ok(()));
    }

    #[test]
    fn inspection_checks_cancellation_on_both_sides_of_input_conversion() {
        struct Input<'a>(&'a AtomicBool);

        impl From<Input<'_>> for Arc<[u8]> {
            fn from(input: Input<'_>) -> Self {
                assert!(!input.0.swap(true, Ordering::Relaxed), "cancelled input must not be converted");
                Arc::from(&b"not a PDF"[..])
            }
        }

        let cancelled = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&cancelled);
        let options = InspectOptions { cancel: Some(Arc::new(move || flag.load(Ordering::Relaxed))), ..InspectOptions::default() };
        assert_eq!(inspect_pdf_input(Input(&cancelled), &options, false), Err(InspectError::Cancelled));
        cancelled.store(false, Ordering::Relaxed);
        assert_eq!(inspect_pdf_input(Input(&cancelled), &options, false), Err(InspectError::Cancelled));
    }
}

impl std::error::Error for InspectError {}
