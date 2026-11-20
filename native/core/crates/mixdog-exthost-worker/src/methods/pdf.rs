//! The PDF methods (`pdfInspect`, `mediaPdfText` and `mediaPdfCounts` of `src/ext-host/methods.mjs`).
//!
//! `pdf.inspect` is the read tool's and the attachment intake's page count, text extraction and text-layer measurement over a
//! file inside the approved paths. `media.pdfText` is the text a provider without a document contract gets for an attached
//! PDF (`extractPdfText` of `media-normalization.mjs`), with the speed cache of that file; `media.pdfCounts` is the
//! text-layer counts the intake prices a PDF with. The bytes of the last two arrive base64, as a message part carries them,
//! and no path is touched.
//!
//! An error answers the code Node's worker did: `String(error.code ?? 'failed')`, so a pdf.js `PasswordException` is code
//! `1` or `2` and a `RangeError`, `TypeError` or `InvalidPDFException` is `failed`, each with its message.

use std::io;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_fsio::Unlaned;
use mixdog_pdf::inspect::{Detail, InspectError, InspectOptions, Inspection, MAX_PDF_PAGES, PDF_INTAKE_TIMEOUT_MS, PageRange, inspect_pdf_input};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{base64_param, js_string, node_base64};
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::{HandlerResult, Outcome, Registry};

/// `PDF_TEXT_MAX_BYTES`: the most text a PDF contributes; token estimates cap a text-lowered PDF here.
const PDF_TEXT_MAX_BYTES: f64 = 256.0 * 1024.0;
/// What a PDF the parser rejects is lowered to: a property of the bytes.
const PDF_UNREADABLE_TEXT: &str = "[PDF text unavailable: this PDF could not be read]";
/// `MEMO_MAX_ENTRIES`.
const MEMO_MAX_ENTRIES: usize = 64;

pub(super) fn register(registry: &mut Registry) {
    registry.register_blocking("pdf.inspect", inspect);
    registry.register_blocking("media.pdfText", pdf_text);
    registry.register_blocking("media.pdfCounts", pdf_counts);
}

/// The text of the extractions already made, keyed by the sha256 of the PDF's bytes (`pdfTextMemo`), oldest first: a hit moves
/// its entry to the end, an insertion past the bound drops the first. Nothing correctness-related depends on it: a cold memo
/// recomputes the identical text.
struct Memo {
    entries: Vec<(String, String)>,
}

impl Memo {
    const fn new() -> Self {
        Memo { entries: Vec::new() }
    }

    fn get(&mut self, key: &str) -> Option<String> {
        let at = self.entries.iter().position(|(known, _)| known == key)?;
        let hit = self.entries.remove(at);
        let text = hit.1.clone();
        self.entries.push(hit);
        Some(text)
    }

    fn put(&mut self, key: String, text: String) {
        if self.get(&key).is_some() {
            // Another call may have remembered the same file while this one extracted.
            return;
        }
        self.entries.push((key, text));
        if self.entries.len() > MEMO_MAX_ENTRIES {
            self.entries.remove(0);
        }
    }
}

static PDF_TEXT_MEMO: Mutex<Memo> = Mutex::new(Memo::new());

fn failure(error: &InspectError) -> CodedError {
    match error {
        InspectError::Cancelled => CodedError::cancelled(),
        other => CodedError::new(other.code(), other.message()),
    }
}

/// JavaScript truthiness of a parameter.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `maxPages`: the default for a missing one, else `Number.isFinite(Number(maxPages)) ? Math.max(1, Math.floor(...)) : Infinity`
/// (the read tool's `"unlimited"` is not a number, so it is no limit).
fn max_pages(value: Option<&Value>) -> Option<u64> {
    let Some(value) = value else { return Some(MAX_PDF_PAGES) };
    let number = mixdog_js::to_number(value);
    number.is_finite().then(|| number.floor().max(1.0) as u64)
}

/// The options of an inspection as `pdf.inspect` passes them through.
fn inspect_options(params: &Value, cancel: &tokio_util::sync::CancellationToken) -> InspectOptions {
    let range = match params.get("pageRange") {
        Some(Value::Object(range)) => Some(PageRange { from: mixdog_js::to_number_of(range.get("from")), to: mixdog_js::to_number_of(range.get("to")) }),
        _ => None,
    };
    let token = cancel.clone();
    InspectOptions {
        extract_text: truthy(params.get("extractText")),
        measure_text: truthy(params.get("measureText")),
        max_pages: max_pages(params.get("maxPages")),
        max_output_bytes: mixdog_js::to_number_of(params.get("maxOutputBytes")),
        page_range: range,
        password: truthy(params.get("password")).then(|| js_string(params.get("password"))),
        timeout_ms: Some(mixdog_js::to_number_of(params.get("timeoutMs"))).filter(|ms| *ms > 0.0),
        cancel: Some(Arc::new(move || token.is_cancelled())),
    }
}

/// `{pageCount, text, truncated, pages}`, or the counts, as `inspectPdfBuffer` returns them.
fn inspection_value(inspection: Inspection, read_pages: bool) -> Value {
    let count = inspection.page_count;
    match inspection.detail {
        Detail::Nothing => json!({"pageCount": count, "text": "", "truncated": false}),
        Detail::Counts { text_pages, text_chars } => {
            json!({"pageCount": count, "textPages": text_pages, "textChars": text_chars})
        }
        Detail::Text { text, truncated, pages } => {
            let pages: Vec<Value> = pages
                .into_iter()
                .map(|page| {
                    let mut entry = json!({"page": page.page});
                    entry["text"] = Value::String(page.text);
                    if read_pages {
                        entry["hasTextLayer"] = Value::Bool(page.has_text_layer);
                    }
                    entry
                })
                .collect();
            let mut value = json!({"pageCount": count});
            value["pages"] = Value::Array(pages);
            if !read_pages {
                value["text"] = Value::String(text);
                value["truncated"] = Value::Bool(truncated);
            }
            value
        }
    }
}

/// What `readFile` raises for a file that cannot be read, with its Node code.
fn read_error(error: &io::Error, path: &std::path::Path) -> CodedError {
    let text = match error.kind() {
        io::ErrorKind::NotFound => "no such file or directory",
        io::ErrorKind::PermissionDenied => "permission denied",
        io::ErrorKind::IsADirectory => "illegal operation on a directory",
        _ => return CodedError::failed(error.to_string()),
    };
    match mixdog_js::uv_error::error_code(error) {
        Some(code) => CodedError::new(code, format!("{code}: {text}, open '{}'", path.display())),
        None => CodedError::failed(error.to_string()),
    }
}

fn inspect(ctx: CallCtx) -> HandlerResult {
    let file = ctx.approved_path(&js_string(ctx.params.get("path")), "")?;
    if ctx.cancel.is_cancelled() {
        return Err(CodedError::cancelled());
    }
    let bytes = mixdog_fsio::read(&Unlaned, &file).map_err(|error| read_error(&error, &file))?;
    let options = inspect_options(&ctx.params, &ctx.cancel);
    let read_pages = ctx.params.get("readPages").and_then(Value::as_bool) == Some(true);
    let sha256 = (ctx.params["includeSha256"].as_bool() == Some(true)).then(|| pdf_key(&bytes));
    let inspection = inspect_pdf_input(bytes, &options, read_pages).map_err(|error| failure(&error))?;
    let mut result = inspection_value(inspection, read_pages);
    if let Some(sha256) = sha256 {
        result["sha256"] = Value::String(sha256);
    }
    Ok(Outcome::value(result))
}

/// `Buffer.from(data, 'base64')` of the call's `data`.
fn data_bytes(params: &Value) -> Result<Vec<u8>, CodedError> {
    Ok(node_base64(base64_param(params)?))
}

/// The sha256 of the bytes as hex (`pdfKey`).
fn pdf_key(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `extractPdfText`: a PDF longer than `MAX_PDF_PAGES` is read for its first pages. A PDF the parser rejects is a property of
/// the bytes, so it is the fixed text (and is remembered); a call that was cancelled is no property of the bytes, so it fails
/// and nothing is remembered.
fn extract_pdf_text(bytes: Vec<u8>, cancel: &tokio_util::sync::CancellationToken) -> Result<String, CodedError> {
    let key = pdf_key(&bytes);
    if let Some(text) = PDF_TEXT_MEMO.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
        return Ok(text);
    }
    let token = cancel.clone();
    let options = InspectOptions {
        extract_text: true,
        max_pages: None,
        page_range: Some(PageRange { from: 1.0, to: MAX_PDF_PAGES as f64 }),
        max_output_bytes: PDF_TEXT_MAX_BYTES,
        cancel: Some(Arc::new(move || token.is_cancelled())),
        ..InspectOptions::default()
    };
    let text = match inspect_pdf_input(bytes, &options, true) {
        Ok(Inspection { detail: Detail::Text { text, .. }, .. }) => text,
        Ok(_) => String::new(),
        Err(InspectError::Cancelled) => return Err(CodedError::cancelled()),
        Err(_) => PDF_UNREADABLE_TEXT.to_owned(),
    };
    PDF_TEXT_MEMO.lock().unwrap_or_else(PoisonError::into_inner).put(key, text.clone());
    Ok(text)
}

fn pdf_text(ctx: CallCtx) -> HandlerResult {
    let bytes = data_bytes(&ctx.params)?;
    let text = extract_pdf_text(bytes, &ctx.cancel)?;
    Ok(Outcome::value(json!({"text": text})))
}

/// The text-layer counts, with the page limit of a text-only provider (none) and the intake timeout. Bytes the parser rejects
/// answer `rejected`, the parser's own message; the intake timeout fails the call, as it fails the intake in Node.
fn pdf_counts(ctx: CallCtx) -> HandlerResult {
    let bytes = data_bytes(&ctx.params)?;
    let token = ctx.cancel.clone();
    let options = InspectOptions {
        measure_text: true,
        max_pages: None,
        timeout_ms: Some(PDF_INTAKE_TIMEOUT_MS),
        cancel: Some(Arc::new(move || token.is_cancelled())),
        ..InspectOptions::default()
    };
    match inspect_pdf_input(bytes, &options, false) {
        Ok(Inspection { page_count, detail: Detail::Counts { text_pages, text_chars } }) => {
            Ok(Outcome::value(json!({"counts": {"pageCount": page_count, "textPages": text_pages, "textChars": text_chars}})))
        }
        Ok(_) => Err(CodedError::failed("the inspection measured nothing")),
        Err(error @ (InspectError::Timeout(_) | InspectError::Cancelled)) => Err(failure(&error)),
        Err(error) => Ok(Outcome::value(json!({"rejected": error.message()}))),
    }
}

#[cfg(test)]
mod tests {
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[test]
    fn the_memo_keeps_sixty_four_and_drops_the_least_recently_used() {
        let mut memo = Memo::new();
        for number in 0..MEMO_MAX_ENTRIES {
            memo.put(format!("k{number}"), format!("v{number}"));
        }
        // A hit moves its entry to the end, so the next insertion drops the second one.
        assert_eq!(memo.get("k0").as_deref(), Some("v0"));
        memo.put("new".to_owned(), "v".to_owned());
        assert_eq!(memo.get("k1"), None);
        assert_eq!(memo.get("k0").as_deref(), Some("v0"));
        assert_eq!(memo.entries.len(), MEMO_MAX_ENTRIES);
        memo.put("k0".to_owned(), "other".to_owned());
        assert_eq!(memo.get("k0").as_deref(), Some("v0"), "a second insertion keeps the first");
    }

    #[test]
    fn a_pdf_the_parser_rejects_is_the_fixed_text_and_is_remembered() {
        let token = CancellationToken::new();
        let bytes = b"this is not a pdf";
        assert_eq!(extract_pdf_text(bytes.to_vec(), &token).unwrap(), PDF_UNREADABLE_TEXT);
        let key = pdf_key(bytes);
        assert_eq!(PDF_TEXT_MEMO.lock().unwrap().get(&key).as_deref(), Some(PDF_UNREADABLE_TEXT));
        assert_eq!(extract_pdf_text(Vec::new(), &token).unwrap(), PDF_UNREADABLE_TEXT);
    }

    #[test]
    fn a_cancelled_extraction_fails_and_remembers_nothing() {
        let token = CancellationToken::new();
        token.cancel();
        let error = extract_pdf_text(b"%PDF-1.4 not far enough".to_vec(), &token).unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(PDF_TEXT_MEMO.lock().unwrap().get(&pdf_key(b"%PDF-1.4 not far enough")).is_none());
    }

    #[test]
    fn the_page_limit_follows_the_javascript_reading_of_the_parameter() {
        assert_eq!(max_pages(None), Some(100));
        assert_eq!(max_pages(Some(&json!("unlimited"))), None);
        assert_eq!(max_pages(Some(&json!(5.9))), Some(5));
        assert_eq!(max_pages(Some(&json!(0))), Some(1));
        assert_eq!(max_pages(Some(&Value::Null)), Some(1));
        assert_eq!(max_pages(Some(&json!("7"))), Some(7));
    }

    #[test]
    fn parameters_are_truthy_as_javascript_has_them() {
        assert!(!truthy(None) && !truthy(Some(&json!(0))) && !truthy(Some(&json!(""))) && !truthy(Some(&Value::Null)));
        assert!(truthy(Some(&json!(true))) && truthy(Some(&json!("a"))) && truthy(Some(&json!([]))) && truthy(Some(&json!(2))));
    }

    #[test]
    fn the_options_read_the_parameters_the_way_the_node_call_did() {
        let token = CancellationToken::new();
        let options = inspect_options(
            &json!({"path": "x", "extractText": true, "pageRange": {"from": 2, "to": "3"}, "maxOutputBytes": 100, "password": "pw", "timeoutMs": 50}),
            &token,
        );
        assert!(options.extract_text && !options.measure_text);
        assert_eq!(options.max_pages, Some(100));
        assert_eq!(options.max_output_bytes, 100.0);
        assert_eq!(options.password.as_deref(), Some("pw"));
        assert_eq!(options.timeout_ms, Some(50.0));
        let range = options.page_range.unwrap();
        assert_eq!((range.from, range.to), (2.0, 3.0));
        let bare = inspect_options(&json!({"path": "x"}), &token);
        assert!(bare.max_output_bytes.is_nan());
        assert!(bare.timeout_ms.is_none() && bare.password.is_none() && bare.page_range.is_none());
    }

    #[test]
    fn an_error_answers_the_code_node_gave_it() {
        let password = failure(&InspectError::Pdf(mixdog_pdf::PdfError::need_password()));
        assert_eq!((password.code.as_str(), password.message.as_str()), ("1", "No password given"));
        let range = failure(&InspectError::TooManyPages { count: 101, limit: 100 });
        assert_eq!(range.code, "failed");
        assert_eq!(failure(&InspectError::Timeout(60000.0)).code, "PDF_INSPECTION_TIMEOUT");
        assert_eq!(failure(&InspectError::Cancelled).code, "cancelled");
    }
}
