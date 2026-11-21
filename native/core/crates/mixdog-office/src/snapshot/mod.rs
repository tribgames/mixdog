//! The snapshot action of the office engine (`snapshot`, `trustForMutation` and what they call in `core/office-sessions.mjs`):
//! a session's document read as the model sees it.
//!
//! - [`pagination`], [`cursor`]: the page a call asks for and the opaque cursors a page hands back.
//! - [`query`]: searching a snapshot and addressing into it.
//! - [`contract`]: the one shape both backends owe.
//! - [`excel_normalize`]: what Excel answers, in the portable reader's shape.
//!
//! A snapshot is read from the document's backend: Microsoft Office through its host ([`ComHost`]), the PDF adapter, the
//! delimited-file backend, or the portable OOXML readers. It is wrapped with the session's identity and the prompt-injection
//! review of the document, and read again with a smaller page (up to eight times) until the text the model reads of it fits
//! `maxChars`.
//!
//! The functions are async only for the host's answers; everything else runs on the caller's thread with the proofs it
//! passes, and the future is not `Send` (the text measurer holds a cache cell): drive it on the thread that owns the lane.

pub mod contract;
pub mod cursor;
pub mod excel_normalize;
pub mod pagination;
pub mod query;

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::time::Duration;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::{json_number, json_stringify, to_number_of, utf16_len, value_to_string};
use mixdog_office_base::ids::office_session_id;
use mixdog_office_base::values::truthy;
use mixdog_office_com::{CallOptions, DEFAULT_TIMEOUT, OfficeCom};
use mixdog_office_design::templates::annotate_pptx_snapshot_roles;
use mixdog_office_pdf::adapter::{FormView, SnapshotOptions, snapshot_pdf};
use mixdog_office_quality::trust::{analyze_office_file_prompt_injection, analyze_office_prompt_injection, combine_office_trust_reviews};
use mixdog_ooxml::cells::workbook_sheets;
use mixdog_ooxml::package::load_package;
use mixdog_ooxml::snapshot::snapshot_portable_ooxml;
use mixdog_ooxml::snapshot_xlsx::worksheet_validations;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::xlsx_conventions::summarize_xlsx_conventions;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use crate::bounded::{bounded, serialized_tool_value};
use crate::digest::office_document_digest;
use crate::session::registry::lock;
use crate::session::{Backend, Mode, SessionHandle, SnapshotCache};
use crate::tabular::{self, Format};

pub use contract::{Violation, describe_office_snapshot_violations, office_snapshot_contract_violations};
pub use excel_normalize::normalize_excel_snapshot_styles;
pub use pagination::{Position, Request, create_office_snapshot_request, finalize_office_snapshot_page, selector_from_args};
pub use query::{find_by_document_path, query_object, snapshot_selection_for_target};

/// How many times a snapshot is read again with a smaller page before the text is cut instead.
const SHRINK_ATTEMPTS: usize = 8;
/// How long Excel has to save the copy a protected sheet's rules are read from.
const SAVE_COPY_TIMEOUT: Duration = Duration::from_millis(120_000);

/// The calls the engine makes to Microsoft Office (`callMicrosoftOffice(payload, { signal, timeoutMs })`): the host's
/// answer as JSON, its failures in the same shape.
pub trait ComHost {
    fn call(&self, payload: &Value, cancel: Option<&CancellationToken>, timeout: Option<Duration>) -> impl Future<Output = Value>;
}

impl ComHost for OfficeCom {
    async fn call(&self, payload: &Value, cancel: Option<&CancellationToken>, timeout: Option<Duration>) -> Value {
        let options = CallOptions { timeout: timeout.unwrap_or(DEFAULT_TIMEOUT), cancel: cancel.cloned().unwrap_or_default() };
        OfficeCom::call(self, payload, options).await.value
    }
}

/// What a snapshot reads with: the lane proof of the caller, the text measurer of the portable readers, the form
/// vocabulary of the PDF adapter and the Office host.
pub struct SnapshotContext<'a, P: ReadProof, H> {
    pub proof: &'a P,
    pub measurer: &'a TextMeasurer<'a, P>,
    pub forms: &'a dyn FormView,
    pub com: &'a H,
}

/// The facts of a session a snapshot reads, taken once under the session's lock (the lock is never held across the host's
/// answer).
struct View {
    id: String,
    format: String,
    backend: Backend,
    mode: Mode,
    target: String,
    source: String,
    file_kind: String,
    created: bool,
    snapshot_version: u64,
    interactive: bool,
    signal: Option<CancellationToken>,
    com: Map<String, Value>,
    owned_background: bool,
}

impl View {
    fn of(handle: &SessionHandle) -> Self {
        let session = lock(handle);
        let com = session.com.to_value();
        let com = match com {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        Self {
            id: session.id.clone(),
            format: session.format.clone(),
            backend: session.backend,
            mode: session.mode,
            target: session.target.clone(),
            source: session.source.clone(),
            file_kind: session.file_kind.clone(),
            created: session.created,
            snapshot_version: session.snapshot_version,
            interactive: session.is_interactive(),
            signal: session.active_signal.clone(),
            com,
            owned_background: session.is_microsoft_office()
                && session.mode == Mode::Background
                && session.com.ownership.as_deref() == Some("owned")
                && session.com.visible != Some(true),
        }
    }

    fn position(&self) -> Position<'_> {
        Position { id: &self.id, format: &self.format, snapshot_version: self.snapshot_version }
    }

    fn is_microsoft_office(&self) -> bool {
        self.backend == Backend::MicrosoftOfficeCom
    }
}

/// `x || fallback` over a number.
fn or_number(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 { fallback } else { value }
}

/// The text of a host's failure: its `error` when it has one.
fn failure_text(answer: &Value, fallback: &str) -> String {
    answer.get("error").filter(|error| truthy(error)).map_or_else(|| fallback.to_owned(), value_to_string)
}

fn model_facing_length(value: &Value) -> usize {
    let Value::Object(map) = value else { return utf16_len(&serialized_tool_value(value)) };
    match map.get("document") {
        Some(document @ (Value::Object(_) | Value::Array(_))) => utf16_len(&serialized_tool_value(&office_document_digest(document))),
        _ => utf16_len(&serialized_tool_value(value)),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::sync::{Arc, Mutex};

    use mixdog_fonts::registry::Registry;
    use mixdog_fsio::Unlaned;
    use mixdog_pdf::write::PdfDocument;

    use super::*;
    use crate::session::{DesignState, Session, SessionInit};

    struct NoForms;

    impl FormView for NoForms {
        fn describe_fields(&self, _document: &PdfDocument) -> Vec<Value> {
            Vec::new()
        }

        fn minimum_size(&self, _field_type: &str) -> (f64, f64) {
            (24.0, 12.0)
        }

        fn rectangles_overlap(&self, _left: &Value, _right: &Value) -> bool {
            false
        }
    }

    /// A host that answers from a script and keeps the requests it saw.
    struct ScriptedHost {
        answers: RefCell<Vec<Value>>,
        seen: RefCell<Vec<Value>>,
    }

    impl ScriptedHost {
        fn new(answers: Vec<Value>) -> Self {
            Self { answers: RefCell::new(answers), seen: RefCell::new(Vec::new()) }
        }
    }

    impl ComHost for ScriptedHost {
        fn call(&self, payload: &Value, _cancel: Option<&CancellationToken>, _timeout: Option<Duration>) -> impl Future<Output = Value> {
            self.seen.borrow_mut().push(payload.clone());
            let answer =
                if self.answers.borrow().is_empty() { json!({ "ok": false, "error": "no answer scripted" }) } else { self.answers.borrow_mut().remove(0) };
            async move { answer }
        }
    }

    fn session(format: &str, backend: Backend, mode: Mode, target: &str) -> SessionHandle {
        let mut session = Session::new(SessionInit {
            id: "office_1".to_owned(),
            source: target.to_owned(),
            target: target.to_owned(),
            file_kind: format.to_owned(),
            format: format.to_owned(),
            mode,
            backend,
            opened_at: String::new(),
            data_dir: std::path::PathBuf::new(),
            created: false,
            created_new_file: None,
            design_state: DesignState::default(),
        });
        if backend == Backend::MicrosoftOfficeCom {
            session.com.ownership = Some("owned".to_owned());
            session.com.visible = Some(false);
        }
        Arc::new(Mutex::new(session))
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().build().expect("runtime").block_on(future)
    }

    fn with_context<R>(host: &ScriptedHost, body: impl FnOnce(&SnapshotContext<'_, Unlaned, ScriptedHost>) -> R) -> R {
        let registry = Registry::new();
        let measurer = TextMeasurer::new(&Unlaned, &registry);
        body(&SnapshotContext { proof: &Unlaned, measurer: &measurer, forms: &NoForms, com: host })
    }

    fn workbook(cells: Value) -> Value {
        json!({ "ok": true, "value": { "format": "xlsx", "sheets": [{ "path": "/sheet[S]", "name": "S", "cells": cells }], "pagination": { "unit": "populated-cell", "offset": 0, "limit": 2000, "returned": 1, "total": 1, "nextOffset": null } } })
    }

    #[test]
    fn a_background_session_we_own_reads_once_per_version_and_request() {
        let handle = session("xlsx", Backend::MicrosoftOfficeCom, Mode::Background, "C:/nowhere/a.xlsx");
        let answer = workbook(json!([{ "ref": "A1", "path": "/sheet[S]/cell[A1]", "value": "hello", "style": { "font": { "color": "FF0000" } } }]));
        let host = ScriptedHost::new(vec![answer.clone(), answer.clone(), answer]);
        with_context(&host, |cx| {
            let first = run(snapshot(cx, &handle, &json!({}), false)).expect("first read");
            let again = run(snapshot(cx, &handle, &json!({}), false)).expect("cached read");
            assert_eq!(first, again);
            assert_eq!(host.seen.borrow().len(), 1);
            assert_eq!(first["document"]["sheets"][0]["cells"][0]["dataType"], json!("text"));
            assert_eq!(first["backend"], json!("microsoft-office-com"));
            assert_eq!(first["ownership"], json!("owned"));
            assert_eq!(first["visible"], json!(false));
            assert_eq!(first["document"]["pagination"]["hasMore"], json!(false));
            // A new request is a new read, and so is an edit.
            run(snapshot(cx, &handle, &json!({ "sheet": "S" }), false)).expect("another request");
            assert_eq!(host.seen.borrow().len(), 2);
            lock(&handle).snapshot_version += 1;
            run(snapshot(cx, &handle, &json!({ "sheet": "S" }), false)).expect("after an edit");
            assert_eq!(host.seen.borrow().len(), 3);
            let request = host.seen.borrow()[0].clone();
            assert_eq!(request["action"], json!("snapshot"));
            assert_eq!(request["session"], json!("office_1"));
            assert_eq!(request["includeSelection"], json!(false));
            assert_eq!(request["paged"], json!(true));
        });
    }

    #[test]
    fn an_attached_session_is_never_cached_and_asks_for_the_selection() {
        let handle = session("xlsx", Backend::MicrosoftOfficeCom, Mode::Attach, "C:/nowhere/a.xlsx");
        let answer = workbook(json!([]));
        let host = ScriptedHost::new(vec![answer.clone(), answer]);
        with_context(&host, |cx| {
            run(snapshot(cx, &handle, &json!({}), false)).expect("first");
            run(snapshot(cx, &handle, &json!({ "includeSelection": false }), false)).expect("second");
            let seen = host.seen.borrow();
            assert_eq!(seen.len(), 2);
            assert_eq!((seen[0]["includeSelection"].clone(), seen[1]["includeSelection"].clone()), (json!(true), json!(false)));
        });
    }

    #[test]
    fn a_host_failure_is_the_error_of_the_snapshot() {
        let handle = session("docx", Backend::MicrosoftOfficeCom, Mode::Background, "C:/nowhere/a.docx");
        let host = ScriptedHost::new(vec![json!({ "ok": false, "error": "Word is busy" }), json!({ "ok": false })]);
        with_context(&host, |cx| {
            assert_eq!(run(snapshot(cx, &handle, &json!({}), false)), Err("Word is busy".to_owned()));
            assert_eq!(run(snapshot(cx, &handle, &json!({}), false)), Err("Microsoft Office snapshot failed".to_owned()));
        });
    }

    #[test]
    fn the_rules_of_a_protected_sheet_come_from_a_saved_copy_that_is_removed() {
        let handle = session("xlsx", Backend::MicrosoftOfficeCom, Mode::Background, "C:/nowhere/a.xlsx");
        let mut answer = workbook(json!([]));
        answer["value"]["sheets"][0]["protection"] = json!({ "protected": true });
        let host = ScriptedHost::new(vec![answer, json!({ "ok": false, "error": "cannot save" })]);
        with_context(&host, |cx| {
            assert_eq!(run(snapshot(cx, &handle, &json!({}), false)), Err("cannot save".to_owned()));
            let seen = host.seen.borrow();
            assert_eq!(seen[1]["action"], json!("save_copy"));
            assert_eq!(seen[1]["format"], json!("xlsx"));
            assert!(seen[1]["output"].as_str().is_some_and(|output| output.contains("mixdog-office-copy-") && output.ends_with(".xlsx")));
        });
    }

    #[test]
    fn a_delimited_file_is_wrapped_with_its_identity_and_trust_and_shrunk_to_fit() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("rows.csv");
        let rows: String = (1..=200).map(|row| format!("row-{row} with some padding text to make it long,{row}\r\n")).collect();
        mixdog_fsio::write(&Unlaned, &path, rows).expect("write the file");
        let handle = session("csv", Backend::MixdogTabular, Mode::Portable, &path.display().to_string());
        let host = ScriptedHost::new(Vec::new());
        with_context(&host, |cx| {
            let whole = run(snapshot(cx, &handle, &json!({ "maxChars": 1_000_000 }), false)).expect("a roomy read");
            assert_eq!(whole["document"]["pagination"]["limit"], json!(2000));
            assert_eq!(whole["document"]["pagination"]["hasMore"], json!(false));
            let small = run(snapshot(cx, &handle, &json!({ "maxChars": 6_000 }), false)).expect("a page that fits");
            let limit = small["document"]["pagination"]["limit"].as_f64().expect("limit");
            assert!(limit < 200.0, "the page was shrunk: {limit}");
            assert_eq!(small["document"]["pagination"]["hasMore"], json!(true));
            assert!(small["document"]["pagination"]["nextCursor"].is_string());
            assert_eq!((small["session"].clone(), small["mode"].clone(), small["fileKind"].clone()), (json!("office_1"), json!("portable"), json!("csv")));
            assert!(small.get("trust").is_some() && small.get("ownership").is_none());
            assert!(lock(&handle).caches.trust_review.is_some());
            assert_eq!(selector_from_args(&json!({})).len(), 6);
        });
    }

    #[test]
    fn the_trust_of_a_created_document_needs_no_read_and_an_existing_one_is_read_once() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("a.csv");
        mixdog_fsio::write(&Unlaned, &path, "a,b\r\n").expect("write the file");
        let handle = session("csv", Backend::MixdogTabular, Mode::Portable, &path.display().to_string());
        let host = ScriptedHost::new(Vec::new());
        with_context(&host, |cx| {
            assert!(lock(&handle).caches.trust_review.is_none());
            let trust = run(trust_for_mutation(cx, &handle)).expect("trust");
            assert_eq!(lock(&handle).caches.trust_review.as_ref(), Some(&trust));
            lock(&handle).created = true;
            let created = run(trust_for_mutation(cx, &handle)).expect("created trust");
            assert_ne!(created, Value::Null);
        });
    }
}

/// `readComSavedCopy(session, read)`: the live Office document saved to a copy in the temporary folder and read as a package,
/// for what the application will not report itself. The copy is removed afterwards; the user's file is never saved over.
pub async fn read_com_saved_copy<P: WriteProof, H: ComHost, T>(
    cx: &SnapshotContext<'_, P, H>,
    handle: &SessionHandle,
    read: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    read_saved_copy(cx, &View::of(handle), read).await
}
async fn read_saved_copy<P: WriteProof, H: ComHost, T>(
    cx: &SnapshotContext<'_, P, H>,
    view: &View,
    read: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let copy = std::env::temp_dir().join(format!("mixdog-office-copy-{}.{}", office_session_id(), view.format));
    let payload = json!({
        "action": "save_copy",
        "session": view.id,
        "format": view.format,
        "mode": view.mode.as_str(),
        "path": view.target,
        "output": copy.display().to_string(),
    });
    let saved = cx.com.call(&payload, view.signal.as_ref(), Some(SAVE_COPY_TIMEOUT)).await;
    let result = if truthy(saved.get("ok").unwrap_or(&Value::Null)) { read(&copy) } else { Err(failure_text(&saved, "save-copy failed")) };
    // The copy may not exist (the host failed before writing it).
    let _ = mixdog_fsio::remove_file(cx.proof, &copy);
    result
}
/// `readProtectedSheetValidations(session, document)`: Excel will not look for the validated cells of a protected sheet
/// (SpecialCells refuses there), so a finished form read back on Excel with no dropdowns at all while the portable reader
/// named them. A protected sheet's rules come from the saved copy instead, in the portable reader's shape.
async fn read_protected_sheet_validations<P: WriteProof, H: ComHost>(cx: &SnapshotContext<'_, P, H>, view: &View, document: &mut Value) -> Result<(), String> {
    let guarded: Vec<(usize, String)> = document
        .get("sheets")
        .and_then(Value::as_array)
        .map(|sheets| {
            sheets
                .iter()
                .enumerate()
                .filter(|(_, sheet)| {
                    sheet.pointer("/protection/protected") == Some(&Value::Bool(true))
                        && !sheet.get("validations").and_then(Value::as_array).is_some_and(|rules| !rules.is_empty())
                })
                .map(|(at, sheet)| (at, sheet.get("name").and_then(Value::as_str).unwrap_or_default().to_owned()))
                .collect()
        })
        .unwrap_or_default();
    if guarded.is_empty() {
        return Ok(());
    }
    let rules = read_saved_copy(cx, view, |copy| {
        let zip = load_package(cx.proof, copy)?;
        let parts: HashMap<String, String> = workbook_sheets(&zip).into_iter().map(|sheet| (sheet.name, sheet.path)).collect();
        let mut found: Vec<(usize, Vec<Value>)> = Vec::new();
        for (at, name) in &guarded {
            if let Some(part) = parts.get(name) {
                found.push((*at, worksheet_validations(&zip.text(part), name)));
            }
        }
        Ok(found)
    })
    .await?;
    for (at, list) in rules {
        if let Some(Value::Object(sheet)) = document.get_mut("sheets").and_then(|sheets| sheets.get_mut(at)) {
            let count = list.len();
            sheet.insert("validations".to_owned(), Value::Array(list));
            sheet.insert("validationCount".to_owned(), Value::from(count));
        }
    }
    Ok(())
}
/// The document of a session read once from its backend, for the request.
async fn fetch_snapshot_document<P: WriteProof, H: ComHost>(
    cx: &SnapshotContext<'_, P, H>,
    view: &View,
    request: &Request,
    max_chars: f64,
    password: Option<&Value>,
) -> Result<Value, String> {
    let path = Path::new(&view.target);
    if view.is_microsoft_office() {
        let mut payload = Map::new();
        payload.insert("action".to_owned(), json!("snapshot"));
        payload.insert("session".to_owned(), json!(view.id));
        payload.insert("format".to_owned(), json!(view.format));
        payload.insert("mode".to_owned(), json!(view.mode.as_str()));
        payload.insert("path".to_owned(), json!(view.target));
        for (key, value) in request {
            payload.insert(key.clone(), value.clone());
        }
        let result = cx.com.call(&Value::Object(payload), view.signal.as_ref(), None).await;
        if !result.get("ok").is_some_and(truthy) {
            return Err(failure_text(&result, "Microsoft Office snapshot failed"));
        }
        let mut document = result.get("value").cloned().unwrap_or(Value::Null);
        if view.format == "xlsx" {
            normalize_excel_snapshot_styles(&mut document);
            read_protected_sheet_validations(cx, view, &mut document).await?;
        }
        return Ok(document);
    }
    match view.format.as_str() {
        "pdf" => {
            // A user password only unlocks this read; it is never kept on the session.
            let mut options = Map::new();
            options.insert("maxChars".to_owned(), json_number(max_chars));
            for (key, value) in request {
                options.insert(key.clone(), value.clone());
            }
            if let Some(password) = password.filter(|password| truthy(password)) {
                options.insert("password".to_owned(), Value::String(value_to_string(password)));
            }
            snapshot_pdf(cx.proof, path, &SnapshotOptions::from_json(&Value::Object(options)), cx.forms).map_err(|error| error.message)
        }
        "csv" | "tsv" => {
            let format = Format::from_name(&view.format).ok_or_else(|| format!("Unsupported delimited format: {}", view.format))?;
            tabular::snapshot(cx.proof, path, format, &Value::Object(request.clone()))
        }
        format => snapshot_portable_ooxml(cx.proof, cx.measurer, path, format, &Value::Object(request.clone())),
    }
}
/// `wrappedSnapshot(session, value)`: the document with the identity of the session that read it and the review of what the
/// document says to the agent that reads it.
fn wrapped_snapshot<P: ReadProof>(proof: &P, view: &View, value: Value) -> Value {
    let trust = combine_office_trust_reviews(&[
        analyze_office_prompt_injection(&value, Some(view.format.as_str()), Some("structured-snapshot")),
        analyze_office_file_prompt_injection(proof, Path::new(&view.target), Some(view.format.as_str())),
    ]);
    let mut wrapped = Map::new();
    wrapped.insert("session".to_owned(), json!(view.id));
    wrapped.insert("mode".to_owned(), json!(view.mode.as_str()));
    wrapped.insert("backend".to_owned(), json!(view.backend.as_str()));
    wrapped.insert("fileKind".to_owned(), json!(view.file_kind));
    wrapped.insert("source".to_owned(), json!(view.source));
    wrapped.insert("output".to_owned(), json!(view.target));
    for key in ["ownership", "visible", "appPid", "windowHwnd", "documentId"] {
        if let Some(field) = view.com.get(key) {
            wrapped.insert(key.to_owned(), field.clone());
        }
    }
    wrapped.insert("document".to_owned(), value);
    wrapped.insert("trust".to_owned(), trust);
    Value::Object(wrapped)
}
/// One page of the document for `request`, finished the way the format reads best. An owned background session changes only
/// through its own batches, which bump the snapshot version, so its last document is served again until then.
async fn read_page<P: WriteProof, H: ComHost>(
    cx: &SnapshotContext<'_, P, H>,
    handle: &SessionHandle,
    view: &View,
    request: &Request,
    max_chars: f64,
    password: Option<&Value>,
) -> Result<Value, String> {
    let mut value = if view.owned_background {
        let key = format!("{}|{}", view.snapshot_version, json_stringify(&Value::Object(request.clone())));
        let cached = lock(handle).caches.snapshot.as_ref().filter(|cache| cache.key == key).map(|cache| cache.value.clone());
        match cached {
            Some(value) => value,
            None => {
                let value = fetch_snapshot_document(cx, view, request, max_chars, password).await?;
                lock(handle).caches.snapshot = Some(SnapshotCache { key, value: value.clone() });
                value
            }
        }
    } else {
        fetch_snapshot_document(cx, view, request, max_chars, password).await?
    };
    finalize_office_snapshot_page(&mut value, view.position(), request);
    if view.format == "xlsx"
        && value.get("sheets").is_some_and(Value::is_array)
        && let Some(conventions) = summarize_xlsx_conventions(&value)
        && let Value::Object(document) = &mut value
    {
        document.insert("conventions".to_owned(), conventions);
    }
    if view.format == "pptx" {
        annotate_pptx_snapshot_roles(&mut value);
    }
    Ok(value)
}

/// The request for the next, smaller page, scaled from what the last read returned.
fn shrink_request(request: &mut Request, view: &View, wrapped: &Value, serialized_length: usize, max_chars: f64) {
    let limit = to_number_of(request.get("limit"));
    let measured = serialized_length.max(1) as f64;
    let returned = to_number_of(wrapped.pointer("/document/pagination/returned"));
    let base = if returned > 0.0 { limit.min(returned) } else { limit };
    let next_limit = (limit - 1.0).min((base * max_chars * 0.8 / measured).floor()).max(1.0);
    request.insert("limit".to_owned(), json_number(next_limit));
    if view.format == "xlsx" {
        request.insert("pageCells".to_owned(), Value::Bool(true));
    }
}

/// `snapshot(session, args, { full })`: the document of a session as a page, or whole when `full`. `args` are the call's
/// (`maxChars`, `limit`, `cursor`, `sheet`, `range`, `target`, `pages`, `includeStyles`, `includeSelection`, `password`).
/// A page too long for `maxChars` is read again with a smaller limit, up to eight times, and then cut by [`bounded`].
pub async fn snapshot<P: WriteProof, H: ComHost>(cx: &SnapshotContext<'_, P, H>, handle: &SessionHandle, args: &Value, full: bool) -> Result<Value, String> {
    let max_chars = or_number(to_number_of(args.get("maxChars")), 30_000.0).clamp(1_000.0, 100_000.0);
    let view = View::of(handle);
    let mut request_args = match args {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let include_selection = args.get("includeSelection") != Some(&Value::Bool(false)) && view.is_microsoft_office() && view.interactive;
    request_args.insert("includeSelection".to_owned(), Value::Bool(include_selection));
    let mut request = create_office_snapshot_request(view.position(), &Value::Object(request_args), full)?;
    let mut wrapped = Value::Null;
    for _ in 0..SHRINK_ATTEMPTS {
        let value = read_page(cx, handle, &view, &request, max_chars, args.get("password")).await?;
        wrapped = wrapped_snapshot(cx.proof, &view, value);
        if !view.created {
            lock(handle).caches.trust_review = wrapped.get("trust").cloned();
        }
        let serialized_length = model_facing_length(&wrapped);
        let limit = to_number_of(request.get("limit"));
        if full || (serialized_length as f64) <= max_chars || limit <= 1.0 {
            break;
        }
        shrink_request(&mut request, &view, &wrapped, serialized_length, max_chars);
    }
    if full {
        return Ok(wrapped);
    }
    let length = model_facing_length(&wrapped);
    Ok(bounded(&wrapped, max_chars.floor() as usize, Some(length)))
}
/// `trustForMutation(session)`: the review of what the document says to the agent, for the gate before an edit. A document
/// the session created has nothing to review; otherwise the review of the last snapshot, or of a whole read.
pub async fn trust_for_mutation<P: WriteProof, H: ComHost>(cx: &SnapshotContext<'_, P, H>, handle: &SessionHandle) -> Result<Value, String> {
    let (created, format, review) = {
        let session = lock(handle);
        (session.created, session.format.clone(), session.caches.trust_review.clone())
    };
    if created {
        return Ok(combine_office_trust_reviews(&[analyze_office_prompt_injection(&json!({}), Some(format.as_str()), Some("created-document"))]));
    }
    if let Some(review) = review.filter(|review| truthy(review)) {
        return Ok(review);
    }
    let current = snapshot(cx, handle, &json!({}), true).await?;
    Ok(current.get("trust").cloned().unwrap_or(Value::Null))
}
