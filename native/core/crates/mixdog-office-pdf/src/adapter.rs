//! `pdf/pdf-adapter.mjs`: the session-facing surface of the PDF backend. A snapshot reads a document (its pages with
//! their text and geometry, its form fields, attachments, outline and metadata, which pages look scanned), a
//! validation answers whether it opens, an audit lists what a reviewer should know, and a batch applies edit operations
//! to one document held in memory with one save at the end. The form vocabulary and the content operations are other
//! modules' ([`FormView`], [`OperationSet`]); this one holds what the session does with them.
//!
//! A snapshot of an encrypted file has no form, attachments, outline or metadata (strings and streams stay ciphered, so
//! those views would be noise): it says the file is encrypted, and `passwordRequired` when the text layer is locked.

use std::any::Any;
use std::collections::HashMap;
use std::path::Path;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::{json_number, to_number, value_to_string};
use mixdog_ooxml::placeholder_scan::placeholder_text_issues;
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use mixdog_pdf::inspect::{Detail, InspectError, InspectOptions, PageRange, inspect_pdf_buffer};
use mixdog_pdf::write::{PdfDocument, SaveOptions};
use mixdog_pdf::Obj;
use serde_json::{Map, Value, json};

use crate::analysis::outline::extract_pdf_outline;
use crate::analysis::round2;
use crate::document::{AnalysisError, PdfSource};
use crate::edit_document::{PDF_ENCRYPTED_HINT, edit_error, js_string, load_pdf, pdf_attachments, read_file};
use crate::limits::DEFAULT_MAX_OUTLINE_ENTRIES;
use crate::safety::active_content_issues;

/// What a page with no text layer reads as in the extraction.
const NO_TEXT_MARKER: &str = "(no extractable text on this page)";

/// How much page text one audit call reads: the bound on its work, not on the document. Past it the answer says how
/// many pages it covered.
pub const PDF_AUDIT_MAX_CHARS: f64 = 4_000_000.0;

/// The form vocabulary of the session surface (`pdf/pdf-forms.mjs`: `describeFormField`, `minimumFieldSize`,
/// `rectanglesOverlap`), which the forms module implements. A described field is
/// `{ path, index, name, label?, type, value, options?, ...flags, widgets: [{ page, x, y, width, height }] }`.
pub trait FormView {
    /// The fields of the document's form, described, in the form's order.
    fn describe_fields(&self, document: &PdfDocument) -> Vec<Value>;

    /// The smallest box a person can hit or read for a field of this type, `(width, height)`.
    fn minimum_size(&self, field_type: &str) -> (f64, f64);

    /// Whether two widgets (`{ x, y, width, height }`) cover each other.
    fn rectangles_overlap(&self, left: &Value, right: &Value) -> bool;
}

/// The options of a snapshot, as `snapshotPdf(path, options)` coerces them (a number that is not one is NaN).
#[derive(Debug, Clone)]
pub struct SnapshotOptions {
    /// `Number(options.maxChars)`.
    pub max_chars: f64,
    pub paged: bool,
    /// `Number(options.offset)`.
    pub offset: f64,
    /// `Number(options.limit)`.
    pub limit: f64,
    /// The pages asked for when `options.pages` is a non-empty array, each as `Number(page)`.
    pub pages: Option<Vec<f64>>,
    pub password: String,
    /// `options.outline !== false`.
    pub outline: bool,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        SnapshotOptions {
            max_chars: f64::NAN,
            paged: false,
            offset: f64::NAN,
            limit: f64::NAN,
            pages: None,
            password: String::new(),
            outline: true,
        }
    }
}

impl SnapshotOptions {
    /// The options object a call carries.
    pub fn from_json(options: &Value) -> Self {
        let number = |key: &str| options.get(key).map_or(f64::NAN, to_number);
        SnapshotOptions {
            max_chars: number("maxChars"),
            paged: options.get("paged").is_some_and(truthy),
            offset: number("offset"),
            limit: number("limit"),
            pages: match options.get("pages") {
                Some(Value::Array(pages)) if !pages.is_empty() => Some(pages.iter().map(to_number).collect()),
                _ => None,
            },
            password: match options.get("password") {
                Some(password) if truthy(password) => value_to_string(password),
                _ => String::new(),
            },
            outline: options.get("outline") != Some(&Value::Bool(false)),
        }
    }
}

/// `Number(x) || fallback`.
fn number_or(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 { fallback } else { value }
}

/// `/password/i.test(...)` of a failure's message.
fn is_password_failure(error: &InspectError) -> bool {
    error.message().to_lowercase().contains("password")
}

fn inspection_error(error: InspectError) -> AnalysisError {
    match error {
        InspectError::Pdf(error) => AnalysisError::from_pdf(&error),
        other => AnalysisError::plain(other.message()),
    }
}

/// The page count of a document whose page tree can be read: a file that keeps it in ciphered object streams has none.
fn structure_pages(document: &PdfDocument) -> Result<usize, AnalysisError> {
    let store = document.store();
    let has_tree = document
        .catalog_ref()
        .and_then(|root| store.dict(root))
        .is_some_and(|catalog| matches!(store.lookup(catalog, "Pages"), Some(Obj::Dict(_))));
    if has_tree {
        Ok(document.page_count())
    } else {
        Err(AnalysisError::plain("Expected instance of PDFDict, but got instance of undefined"))
    }
}

/// `structurePageCount(structure)`: pdf-lib cannot decrypt. An encrypted file that keeps its page tree in ciphered
/// object streams (what qpdf and most current writers produce) reads as having no page tree at all; `None` says so.
fn structure_page_count(document: &PdfDocument) -> Result<Option<usize>, AnalysisError> {
    match structure_pages(document) {
        Ok(count) => Ok(Some(count)),
        Err(_) if document.is_encrypted() => Ok(None),
        Err(error) => Err(error),
    }
}

/// `decryptedPageCount(buffer, password)`: the reader decrypts with the user password, or with none under an owner-only
/// lock. `None` when the file is locked and no working password was given.
fn decrypted_page_count(buffer: &[u8], password: &str) -> Result<Option<u64>, AnalysisError> {
    let options = InspectOptions { password: Some(password.to_owned()), ..InspectOptions::default() };
    match inspect_pdf_buffer(buffer, &options) {
        Ok(inspection) => Ok(Some(inspection.page_count)),
        Err(error) if is_password_failure(&error) => Ok(None),
        Err(error) => Err(inspection_error(error)),
    }
}

/// `pageGeometry(structure, index)`: the size of the page's media box, its turn, and, when its crop box does not start
/// at 0,0, the origin that bottom-left coordinates need added.
fn page_geometry(document: &PdfDocument, index: usize) -> Result<Map<String, Value>, AnalysisError> {
    let page = *document
        .pages()
        .get(index - 1)
        .ok_or_else(|| AnalysisError::plain(format!("PDF page out of range: {index}")))?;
    let media = document.media_box(page).map_err(edit_error)?;
    let crop = document.crop_box(page).map_err(edit_error)?;
    let mut geometry = Map::new();
    geometry.insert("width".to_owned(), json_number(round2(media.width)));
    geometry.insert("height".to_owned(), json_number(round2(media.height)));
    geometry.insert("rotation".to_owned(), json_number(document.rotation(page).map_err(edit_error)?));
    if crop.x != 0.0 || crop.y != 0.0 {
        geometry.insert(
            "origin".to_owned(),
            json!({ "x": json_number(round2(crop.x)), "y": json_number(round2(crop.y)) }),
        );
    }
    Ok(geometry)
}

fn metadata_of(document: &PdfDocument) -> Value {
    json!({
        "title": document.title().unwrap_or_default(),
        "author": document.author().unwrap_or_default(),
        "subject": document.subject().unwrap_or_default(),
        "keywords": document.keywords().unwrap_or_default(),
    })
}

/// The `n` of a `--- Page n ---` heading that starts at `at` (the lookahead of the page-text pattern, with the heading's
/// line break in front of it).
fn heading_at(text: &str, at: usize) -> bool {
    let Some(rest) = text[at..].strip_prefix("\n\n--- Page ") else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && rest[digits..].starts_with(" ---")
}

/// The text of each page of the extraction, by page number:
/// `/--- Page (\d+) ---\n([\s\S]*?)(?=\n\n--- Page \d+ ---|$)/g`.
fn split_page_texts(text: &str) -> HashMap<u64, String> {
    const HEAD: &str = "--- Page ";
    let mut texts = HashMap::new();
    let mut position = 0;
    while let Some(found) = text[position..].find(HEAD) {
        let start = position + found;
        let digits_at = start + HEAD.len();
        let digits = text[digits_at..].bytes().take_while(u8::is_ascii_digit).count();
        let after = digits_at + digits;
        if digits == 0 || !text[after..].starts_with(" ---\n") {
            position = start + 1;
            continue;
        }
        let body_start = after + " ---\n".len();
        let mut end = text.len();
        let mut search = body_start;
        while let Some(next) = text[search..].find("\n\n--- Page ") {
            let candidate = search + next;
            if heading_at(text, candidate) {
                end = candidate;
                break;
            }
            search = candidate + 1;
        }
        if let Ok(number) = text[digits_at..after].parse::<u64>() {
            texts.insert(number, text[body_start..end].to_owned());
        }
        position = end;
    }
    texts
}

/// `.replace(/ {2,}/g, ' ')`.
fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous_space = false;
    for c in text.chars() {
        if c == ' ' && previous_space {
            continue;
        }
        previous_space = c == ' ';
        out.push(c);
    }
    out
}

/// `snapshotPdf(path, options)`.
pub fn snapshot_pdf<P: ReadProof>(
    proof: &P,
    path: &Path,
    options: &SnapshotOptions,
    forms: &dyn FormView,
) -> Result<Value, AnalysisError> {
    let max_chars = number_or(options.max_chars, 30_000.0).max(1_000.0);
    let buffer = read_file(proof, path)?;
    let structure = load_pdf(&buffer, true)?;
    let encrypted = structure.is_encrypted();
    let structure_count = structure_page_count(&structure)?;
    let page_count: Option<u64> = match structure_count {
        Some(count) => Some(count as u64),
        None => decrypted_page_count(&buffer, &options.password)?,
    };
    let known_pages = page_count.unwrap_or(0) as f64;
    let offset = if options.paged { number_or(options.offset, 0.0).max(0.0) } else { 0.0 };
    let limit = if options.paged { number_or(options.limit, 20.0).max(1.0) } else { known_pages };
    // A locked file whose pages could not be counted selects none.
    let mut selected: Vec<f64> = Vec::new();
    if let Some(count) = page_count {
        if let Some(pages) = &options.pages {
            selected = pages.clone();
        } else {
            let length = limit.min(count as f64 - offset).max(0.0).floor() as usize;
            selected = (0..length).map(|index| offset + index as f64 + 1.0).collect();
        }
    }
    for index in &selected {
        if index.fract() != 0.0 || !index.is_finite() || *index < 1.0 || *index > known_pages {
            return Err(AnalysisError::plain(format!(
                "PDF page out of range: {}",
                mixdog_js::number_to_string(*index)
            )));
        }
    }
    let from = selected.iter().copied().reduce(f64::min).unwrap_or(1.0);
    let to = selected.iter().copied().reduce(f64::max).unwrap_or(1.0);
    let inspected = inspect_pdf_buffer(
        &buffer,
        &InspectOptions {
            extract_text: true,
            max_pages: Some(known_pages.max(500.0) as u64),
            max_output_bytes: max_chars,
            page_range: Some(PageRange { from, to }),
            password: Some(options.password.clone()),
            ..InspectOptions::default()
        },
    );
    let mut password_required = false;
    let (joined, truncated) = match inspected {
        Ok(inspection) => match inspection.detail {
            Detail::Text { text, truncated, .. } => (text, truncated),
            _ => (String::new(), false),
        },
        // A user password blocks the text layer (unless the caller supplied it); an owner-only password does not.
        Err(error) if encrypted && is_password_failure(&error) => {
            password_required = true;
            (String::new(), false)
        }
        Err(error) => return Err(inspection_error(error)),
    };
    let texts = split_page_texts(&joined);
    let mut pages = Vec::new();
    for index in &selected {
        let number = *index as u64;
        if !(password_required || texts.contains_key(&number)) {
            continue;
        }
        let mut page = Map::new();
        page.insert("path".to_owned(), json!(format!("/page[{number}]")));
        page.insert("index".to_owned(), json!(number));
        page.insert(
            "text".to_owned(),
            json!(collapse_spaces(texts.get(&number).map_or("", String::as_str))),
        );
        // A ciphered page tree has no page boxes to read.
        if structure_count.is_some() {
            page.extend(page_geometry(&structure, number as usize)?);
        }
        pages.push(Value::Object(page));
    }
    // Strings and streams stay ciphered under ignoreEncryption, so the form and attachment views of an encrypted file
    // would be noise rather than data.
    let fields = if encrypted { Vec::new() } else { forms.describe_fields(&structure) };
    let attachments = if encrypted { Vec::new() } else { pdf_attachments(&structure) };
    let mut outline: Vec<Value> = Vec::new();
    // The outline costs a second parse; a caller that only wants issues skips it.
    if !encrypted && options.outline {
        // The outline is a convenience view; an unreadable one leaves it empty rather than failing the snapshot of a
        // readable document.
        if let Ok(read) = extract_pdf_outline(proof, PdfSource::Path(path), DEFAULT_MAX_OUTLINE_ENTRIES) {
            outline = read
                .entries
                .iter()
                .enumerate()
                .map(|(index, entry)| {
                    let mut row = Map::new();
                    row.insert("path".to_owned(), json!(format!("/outline[{}]", index + 1)));
                    if let Value::Object(fields) = entry.to_json() {
                        row.extend(fields);
                    }
                    Value::Object(row)
                })
                .collect();
        }
    }
    let likely_scanned: Vec<Value> = if password_required {
        Vec::new()
    } else {
        pages
            .iter()
            .filter(|page| page["text"].as_str().is_some_and(|text| text.contains(NO_TEXT_MARKER)))
            .map(|page| page["index"].clone())
            .collect()
    };
    let returned = pages.len();
    let mut result = Map::new();
    result.insert("format".to_owned(), json!("pdf"));
    result.insert("pageCount".to_owned(), page_count.map_or(Value::Null, |count| json!(count)));
    result.insert("truncated".to_owned(), json!(truncated));
    result.insert("pages".to_owned(), Value::Array(pages));
    let field_count = fields.len();
    result.insert("fields".to_owned(), Value::Array(fields));
    result.insert("fieldCount".to_owned(), json!(field_count));
    result.insert("attachmentCount".to_owned(), json!(attachments.len()));
    result.insert("attachments".to_owned(), Value::Array(attachments));
    result.insert("outlineCount".to_owned(), json!(outline.len()));
    result.insert("outline".to_owned(), Value::Array(outline));
    result.insert(
        "metadata".to_owned(),
        if encrypted {
            json!({ "title": "", "author": "", "subject": "", "keywords": "" })
        } else {
            metadata_of(&structure)
        },
    );
    let ocr_required = !likely_scanned.is_empty();
    result.insert("likelyScannedPages".to_owned(), Value::Array(likely_scanned));
    result.insert("ocrRequired".to_owned(), json!(ocr_required));
    result.insert("encrypted".to_owned(), json!(encrypted));
    if encrypted {
        result.insert("passwordRequired".to_owned(), json!(password_required));
        result.insert("hint".to_owned(), json!(PDF_ENCRYPTED_HINT));
    }
    if options.paged {
        // A page range asked for by number has no next page to offer.
        let next_offset = if options.pages.is_none() && offset + (returned as f64) < known_pages {
            json_number(offset + returned as f64)
        } else {
            Value::Null
        };
        result.insert(
            "pagination".to_owned(),
            json!({
                "unit": "page",
                "offset": json_number(offset),
                "limit": json_number(limit),
                "returned": returned,
                "total": json_number(known_pages),
                "nextOffset": next_offset,
            }),
        );
    }
    Ok(Value::Object(result))
}

/// `validatePdf(path)`.
pub fn validate_pdf<P: ReadProof>(proof: &P, path: &Path) -> Result<Value, AnalysisError> {
    let buffer = read_file(proof, path)?;
    let document = load_pdf(&buffer, true)?;
    let encrypted = document.is_encrypted();
    let pages = match structure_page_count(&document)? {
        Some(count) => Some(count as u64),
        None => decrypted_page_count(&buffer, "")?,
    };
    let mut result = Map::new();
    result.insert("ok".to_owned(), json!(true));
    result.insert("format".to_owned(), json!("pdf"));
    result.insert("pages".to_owned(), pages.map_or(Value::Null, |count| json!(count)));
    result.insert("validation".to_owned(), json!("pdf-parse"));
    result.insert("encrypted".to_owned(), json!(encrypted));
    if encrypted {
        result.insert("warning".to_owned(), json!(PDF_ENCRYPTED_HINT));
    }
    Ok(Value::Object(result))
}

fn issue(severity: &str, code: &str, path: &str, message: String) -> Value {
    json!({ "severity": severity, "code": code, "path": path, "message": message })
}

/// `issuesPdf(path, options)`: the audit reads the whole document, not the readable excerpt a snapshot shows: bounded
/// to 30K the text stopped a few pages in, and a scanned page past that boundary went unreported under "ok, nothing
/// found".
pub fn issues_pdf<P: ReadProof>(
    proof: &P,
    path: &Path,
    options: &SnapshotOptions,
    forms: &dyn FormView,
) -> Result<Value, AnalysisError> {
    let audit = SnapshotOptions {
        max_chars: if options.max_chars.is_nan() || options.max_chars == 0.0 { PDF_AUDIT_MAX_CHARS } else { options.max_chars },
        outline: false,
        ..options.clone()
    };
    let snapshot = snapshot_pdf(proof, path, &audit, forms)?;
    let encrypted = snapshot["encrypted"] == Value::Bool(true);
    let page_entries = snapshot["pages"].as_array().cloned().unwrap_or_default();
    let mut issues: Vec<Value> = Vec::new();
    if let Some(total) = snapshot["pageCount"].as_u64()
        && !encrypted
        && (page_entries.len() as u64) < total
    {
        // A fact about this call's reach, not a defect in the document.
        issues.push(issue(
            "info",
            "audit_scope_limited",
            "/",
            format!(
                "Only {} of {total} pages were read for this audit; audit the rest with issues pages:[…].",
                page_entries.len()
            ),
        ));
    }
    if encrypted {
        let severity = if snapshot["passwordRequired"] == Value::Bool(true) { "error" } else { "warning" };
        issues.push(issue(severity, "encrypted", "/metadata", PDF_ENCRYPTED_HINT.to_owned()));
    }
    if !encrypted {
        issues.extend(active_content_issues(&load_pdf(&read_file(proof, path)?, false)?));
    }
    for page in snapshot["likelyScannedPages"].as_array().into_iter().flatten() {
        issues.push(issue(
            "warning",
            "ocr_required",
            &format!("/page[{}]", value_to_string(page)),
            "Page has no text layer. Run ocr_pages or render it and read the image instead of treating it as empty."
                .to_owned(),
        ));
    }
    for page in &page_entries {
        let text = page["text"].as_str().unwrap_or_default();
        let at = page["path"].as_str().unwrap_or_default();
        issues.extend(placeholder_text_issues(text, at, &Map::new()));
    }
    issues.extend(form_field_issues(snapshot["fields"].as_array().map_or(&[][..], Vec::as_slice), forms));
    Ok(json!({ "ok": true, "format": "pdf", "issueCount": issues.len(), "issues": issues }))
}

fn field_number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// Form fields a filler cannot address, cannot hit, or that cover each other.
fn form_field_issues(fields: &[Value], forms: &dyn FormView) -> Vec<Value> {
    let mut issues = Vec::new();
    for field in fields {
        let name = field.get("name").filter(|name| truthy(name));
        let path = field["path"].as_str().unwrap_or_default();
        if name.is_none() {
            issues.push(issue(
                "warning",
                "unnamed_form_field",
                path,
                "Form field has no name, so fill_form cannot address it.".to_owned(),
            ));
        }
        let field_type = field["type"].as_str().unwrap_or_default();
        let (min_width, min_height) = forms.minimum_size(field_type);
        let small = field["widgets"].as_array().into_iter().flatten().find(|widget| {
            field_number(widget, "width") < min_width || field_number(widget, "height") < min_height
        });
        if let Some(widget) = small {
            let label = name.map_or_else(|| value_to_string(&field["index"]), value_to_string);
            issues.push(issue(
                "warning",
                "field_too_small",
                path,
                format!(
                    "Form field {label} has a {} x {} pt box on page {}; a {field_type} field needs at least {} x {}.",
                    mixdog_js::number_to_string(round2(field_number(widget, "width"))),
                    mixdog_js::number_to_string(round2(field_number(widget, "height"))),
                    value_to_string(&widget["page"]),
                    mixdog_js::number_to_string(mixdog_js::math::round(min_width)),
                    mixdog_js::number_to_string(mixdog_js::math::round(min_height)),
                ),
            ));
        }
    }
    // Each widget with the name and path of its field.
    let mut widgets: Vec<(Value, String, String)> = Vec::new();
    for field in fields {
        let name = js_string(field.get("name"));
        let path = field["path"].as_str().unwrap_or_default().to_owned();
        for widget in field["widgets"].as_array().into_iter().flatten() {
            widgets.push((widget.clone(), name.clone(), path.clone()));
        }
    }
    for left in 0..widgets.len() {
        for right in left + 1..widgets.len() {
            if widgets[left].0["page"] == widgets[right].0["page"]
                && forms.rectangles_overlap(&widgets[left].0, &widgets[right].0)
            {
                issues.push(issue(
                    "warning",
                    "overlapping_form_fields",
                    &widgets[left].2,
                    format!("Form fields {} and {} overlap.", widgets[left].1, widgets[right].1),
                ));
            }
        }
    }
    issues
}

/// Batch state the handlers share: a handler that must continue on a fresh load (marks, previews, page reorders, OCR)
/// replaces `document`.
pub struct BatchState<'a, P: WriteProof> {
    pub proof: &'a P,
    /// The call's note of the files it writes.
    pub note: &'a dyn WriteNote,
    pub path: &'a Path,
    /// The file as the batch found it.
    pub source: &'a [u8],
    pub document: PdfDocument,
    /// Set by a handler that continues on a fresh load of its own (it replaces `document`): the new document starts clean, so
    /// its being unedited says nothing about the file.
    pub replaced: bool,
    /// Text positions measured for a mark, valid across further marks; any other operation drops them.
    pub measure: Option<Box<dyn Any + Send>>,
}

/// A set of batch operations by name (`CONTENT_OPERATIONS`, `STRUCTURE_OPERATIONS`).
pub trait OperationSet<P: WriteProof> {
    /// Whether the set has this operation.
    fn supports(&self, op: &str) -> bool;

    /// Whether the operation leaves the text positions measured for earlier marks valid (the mark operations).
    fn keeps_measurement(&self, _op: &str) -> bool {
        false
    }

    /// Runs one operation on the batch's document and answers its result row.
    fn run(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError>;
}

/// `applyPdfBatch(path, operations, context)`: the operations in order on one document in memory, one save, the file
/// rewritten in place. Every file written (the document, a split, an extracted attachment) is reported to `note` first.
pub fn apply_pdf_batch<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    path: &Path,
    operations: &[Value],
    sets: &[&dyn OperationSet<P>],
) -> Result<Vec<Value>, AnalysisError> {
    let source = read_file(proof, path)?;
    let document = load_pdf(&source, false)?;
    let mut state = BatchState { proof, note, path, source: &source, document, replaced: false, measure: None };
    let mut results: Vec<Value> = Vec::new();
    for operation in operations {
        let op = js_string(operation.get("op"));
        let Some(set) = sets.iter().find(|set| set.supports(&op)) else {
            return Err(AnalysisError::plain(format!("PDF backend does not support operation: {op}")));
        };
        // Text positions measured for a mark stay valid across further marks; any other operation may move text, so it
        // drops the measurement.
        if !set.keeps_measurement(&op) {
            state.measure = None;
        }
        results.push(set.run(&mut state, operation)?);
    }
    // A batch that edited nothing leaves the file as it was: the rewrite of an untouched pdf-lib file is byte for byte the file
    // in Node, where this writer's would differ in its compression and its bookkeeping streams. A compression is the exception:
    // its work is the rewrite itself.
    let compression_asked = operations.iter().any(|operation| js_string(operation.get("op")) == "compress");
    let untouched = !state.replaced && !state.document.store().is_dirty() && !compression_asked;
    let mut bytes = if untouched { source.clone() } else { state.document.save(SaveOptions::default()) };
    // Object streams can cost more than they save on a file that is already compact. When compression was the only
    // thing asked for and the rewrite came back larger, the file it started with is the better answer: keeping it and
    // reporting no change beats reporting growth as a successful compression.
    let compression_only =
        !operations.is_empty() && operations.iter().all(|operation| js_string(operation.get("op")) == "compress");
    let grew = bytes.len() > source.len();
    if compression_only && grew {
        bytes = source.clone();
    }
    note.note_write(path);
    mixdog_fsio::write(proof, path, &bytes).map_err(|error| AnalysisError::plain(error.to_string()))?;
    for entry in results.iter_mut() {
        if entry["op"] != "compress" {
            continue;
        }
        let Value::Object(row) = entry else {
            continue;
        };
        row.insert("bytesAfter".to_owned(), json!(bytes.len()));
        row.insert("changed".to_owned(), json!(bytes.len() != source.len()));
        let note_text = if compression_only && grew {
            "Object streams cost more than they saved here, so the file was left as it was; images are not resampled. Pass allowNoChange to accept that outcome."
        } else if grew {
            row.insert("grew".to_owned(), json!(true));
            "The batch's other edits grew the file; object streams did not shrink it. Images are not resampled."
        } else {
            "Re-serialized with object streams; images are not resampled, so savings are usually small."
        };
        row.insert("note".to_owned(), json!(note_text));
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_texts_split_at_the_headings_and_a_page_keeps_what_precedes_the_next_heading() {
        let text = "--- Page 1 ---\nfirst line\nsecond\n\n--- Page 3 ---\n(no extractable text on this page)\n\n--- Page 4 ---\n";
        let texts = split_page_texts(text);
        assert_eq!(texts.len(), 3);
        assert_eq!(texts[&1], "first line\nsecond");
        assert_eq!(texts[&3], "(no extractable text on this page)");
        assert_eq!(texts[&4], "");
        assert!(split_page_texts("").is_empty());
        assert!(split_page_texts("--- Page x ---\nbody").is_empty());
    }

    #[test]
    fn a_heading_that_is_not_followed_by_a_line_break_is_not_one() {
        let texts = split_page_texts("--- Page 2 --- body\n--- Page 5 ---\nreal");
        assert_eq!(texts.len(), 1);
        assert_eq!(texts[&5], "real");
    }

    #[test]
    fn a_repeated_page_number_keeps_the_last_text() {
        let texts = split_page_texts("--- Page 1 ---\na\n\n--- Page 1 ---\nb");
        assert_eq!(texts[&1], "b");
    }

    #[test]
    fn runs_of_spaces_collapse_and_other_white_space_stays() {
        assert_eq!(collapse_spaces("a  b   c d\t\t e"), "a b c d\t\t e");
    }

    #[test]
    fn the_options_are_coerced_as_the_node_call_coerces_them() {
        let options = SnapshotOptions::from_json(&json!({
            "maxChars": "5000", "paged": 1, "offset": "2", "limit": 3, "pages": [1, "2"], "password": "pw", "outline": false,
        }));
        assert_eq!((options.max_chars, options.offset, options.limit), (5000.0, 2.0, 3.0));
        assert!(options.paged && !options.outline);
        assert_eq!(options.pages, Some(vec![1.0, 2.0]));
        assert_eq!(options.password, "pw");
        let none = SnapshotOptions::from_json(&json!({ "pages": [], "outline": null }));
        assert!(none.max_chars.is_nan() && none.pages.is_none() && none.outline && !none.paged);
    }

    #[test]
    fn the_number_or_fallback_replaces_zero_and_nan() {
        assert_eq!(number_or(f64::NAN, 30.0), 30.0);
        assert_eq!(number_or(0.0, 30.0), 30.0);
        assert_eq!(number_or(5.0, 30.0), 5.0);
    }

    struct NoForms;

    impl FormView for NoForms {
        fn describe_fields(&self, _document: &PdfDocument) -> Vec<Value> {
            Vec::new()
        }

        fn minimum_size(&self, field_type: &str) -> (f64, f64) {
            if field_type == "checkbox" { (7.99, 7.99) } else { (23.99, 11.99) }
        }

        fn rectangles_overlap(&self, left: &Value, right: &Value) -> bool {
            let n = |value: &Value, key: &str| value[key].as_f64().unwrap_or(0.0);
            n(left, "x") < n(right, "x") + n(right, "width")
                && n(left, "x") + n(left, "width") > n(right, "x")
                && n(left, "y") < n(right, "y") + n(right, "height")
                && n(left, "y") + n(left, "height") > n(right, "y")
        }
    }

    fn field(name: &str, kind: &str, widgets: Vec<Value>) -> Value {
        json!({ "path": "/field[1]", "index": 1, "name": name, "type": kind, "widgets": widgets })
    }

    fn widget(page: u64, x: f64, y: f64, width: f64, height: f64) -> Value {
        json!({ "page": page, "x": x, "y": y, "width": width, "height": height })
    }

    #[test]
    fn an_unnamed_field_a_small_box_and_two_fields_over_each_other_are_issues() {
        let fields = vec![
            field("", "text", vec![widget(1, 0.0, 0.0, 100.0, 20.0)]),
            field("tiny", "checkbox", vec![widget(1, 200.0, 0.0, 5.0, 8.0)]),
            field("a", "text", vec![widget(2, 0.0, 0.0, 100.0, 20.0)]),
            field("b", "text", vec![widget(2, 50.0, 10.0, 100.0, 20.0)]),
        ];
        let issues = form_field_issues(&fields, &NoForms);
        let codes: Vec<&str> = issues.iter().map(|issue| issue["code"].as_str().expect("code")).collect();
        assert_eq!(codes, ["unnamed_form_field", "field_too_small", "overlapping_form_fields"]);
        assert_eq!(
            issues[1]["message"],
            "Form field tiny has a 5 x 8 pt box on page 1; a checkbox field needs at least 8 x 8."
        );
        assert_eq!(issues[2]["message"], "Form fields a and b overlap.");
    }
}
