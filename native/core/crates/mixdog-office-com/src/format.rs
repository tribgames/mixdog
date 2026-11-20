//! What every Office format has to give the shared actions: a reader (snapshot, issues, selection) and an editor (one
//! operation at a time), and the dispatch the hosts' `Snapshot-Document`, `Issues-Document` and `Snapshot-Selection` do over
//! them.
//!
//! The application tasks write a reader and an editor of their own and add one line each to [`crate::drivers`]; nothing here
//! knows what a Word paragraph or an Excel range is, except the one rule of `Snapshot-Document` that chooses between
//! Excel's whole read and its page read.

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::drivers::Drivers;
use crate::office::Env;
use crate::office::get_full_path;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::state::ChartExcel;

/// Reads a document of one format.
pub trait FormatReader: Sync {
    /// `Snapshot-Word`, `Snapshot-Excel` or `Snapshot-PowerPoint`.
    fn snapshot(&self, env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value>;

    /// `Issues-Word`, `Issues-Excel` or `Issues-PowerPoint`: either the list of issues or an object holding it as
    /// `issues` (and, for Excel, an `auditCoverage` beside it).
    fn issues(&self, env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value>;

    /// The body of `Snapshot-Selection` for this format: what the user has selected in the document's window.
    fn selection(&self, env: &Env<'_>, document: &Obj) -> Result<Value>;
}

/// What an editor needs besides the document: the host's world and the Excel applications the chart data of slides starts.
pub struct EditContext<'a> {
    pub env: Env<'a>,
    pub chart_excel: &'a mut ChartExcel,
}

/// Edits a document of one format.
pub trait FormatEditor: Sync {
    /// `Apply-WordOperation`, `Apply-ExcelOperation` or `Apply-PowerPointOperation`: the operation's structured result (the
    /// last dictionary it emitted), `None` when it emitted none. A refusal is the error.
    fn apply_operation(&self, context: &mut EditContext<'_>, document: &Obj, op: &Value, live: bool, allow_ui_activation: bool) -> Result<Option<Value>>;

    /// The operations this editor serves, in the order of the registry (`tests/fixtures/registry/operations.json`).
    fn operation_names(&self) -> &'static [&'static str];

    /// `Word-AppendRunLength`: how many operations from `position` the editor takes as one block (1 when this one is not
    /// part of a run). Only Word has runs.
    fn append_run_length(&self, _context: &mut EditContext<'_>, _document: &Obj, _queue: &[Value], _position: usize) -> Result<usize> {
        Ok(1)
    }

    /// `Apply-WordAppendRun`: one result per operation of the run.
    fn apply_append_run(&self, _context: &mut EditContext<'_>, _document: &Obj, _run: &[Value]) -> Result<Vec<Value>> {
        Err(Error::host("Appended runs are not supported for this format."))
    }
}

fn missing_reader(format: &str) -> Error {
    Error::host(format!("No Office reader is registered for .{format}"))
}

/// `Snapshot-Document`: the reader of the format, and the selection when the request includes it.
pub fn snapshot_document(drivers: &Drivers<'_>, env: &Env<'_>, document: &Obj, format: &str, payload: &Value) -> Result<Value> {
    let reader = drivers.reader(format).ok_or_else(|| missing_reader(format))?;
    // A paged read of a workbook is one read of every format, answered by the reader's snapshot: Excel walks sheet by sheet and by
    // populated cell from the request's `sheet`, `sheetOffset`, `range` and `offset`, whatever the size of the sheet or the limit.
    let mut value = reader.snapshot(env, document, payload)?;
    if convert::to_bool(&payload::property(payload, "includeSelection")) {
        let selection = snapshot_selection(drivers, env, document, format);
        if let Value::Object(object) = &mut value {
            object.set("selection", selection);
        }
    }
    Ok(value)
}

fn unavailable(reason: &str) -> Value {
    Value::object(ObjectKind::Ordered, vec![("available", Value::Bool(false)), ("reason", Value::string(reason))])
}

/// `Snapshot-Selection`: a failure of the read is the selection being unavailable, with the failure as the reason.
pub fn snapshot_selection(drivers: &Drivers<'_>, env: &Env<'_>, document: &Obj, format: &str) -> Value {
    match drivers.reader(format) {
        Some(reader) => reader.selection(env, document).unwrap_or_else(|error| unavailable(error.message())),
        None => unavailable("Selection is unsupported for this format."),
    }
}

/// `Issues-Document`: the reader's inspection as `{ ok, format, issueCount, issues[, auditCoverage] }`.
pub fn issues_document(drivers: &Drivers<'_>, env: &Env<'_>, document: &Obj, format: &str, payload: Option<&Value>) -> Result<Value> {
    let reader = drivers.reader(format).ok_or_else(|| missing_reader(format))?;
    let empty = Value::object(ObjectKind::Ordered, Vec::new());
    let inspection = reader.issues(env, document, payload.unwrap_or(&empty))?;
    let listed = match &inspection {
        Value::Object(object) if object.get("issues").is_some() => payload::property(&inspection, "issues"),
        other => other.clone(),
    };
    let issues = crate::ps::pipeline_items(&listed);
    let has_error = issues.iter().any(|issue| payload::names_equal(&convert::to_ps_string(&payload::property(issue, "severity")), "error"));
    let mut result = Value::object(
        ObjectKind::Ordered,
        vec![
            ("ok", Value::Bool(!has_error)),
            ("format", Value::string(format)),
            ("issueCount", Value::Int(i32::try_from(issues.len()).unwrap_or(i32::MAX))),
            ("issues", Value::Array(issues)),
        ],
    );
    if let (Value::Object(source), Value::Object(object)) = (&inspection, &mut result) {
        if let Some(coverage) = source.get("auditCoverage") {
            object.set("auditCoverage", coverage.clone());
        }
    }
    Ok(result)
}

/// `Same-OfficePath`: both paths made absolute and compared ignoring case; a path that cannot be made absolute is not the
/// same.
pub fn same_office_path(left: &str, right: &str) -> bool {
    match (get_full_path(left), get_full_path(right)) {
        (Ok(left), Ok(right)) => left.to_uppercase() == right.to_uppercase(),
        _ => false,
    }
}
