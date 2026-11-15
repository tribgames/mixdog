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
use crate::com::Value as Com;
use crate::drivers::Drivers;
use crate::office::Env;
use crate::office::get_full_path;
use crate::office::long_of;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::state::ChartExcel;

/// The size in cells above which a whole-workbook read becomes a page read.
const EXCEL_WHOLE_READ_CELLS: i64 = 500;

/// Reads a document of one format.
pub trait FormatReader: Sync {
    /// `Snapshot-Word`, `Snapshot-Excel` or `Snapshot-PowerPoint`.
    fn snapshot(&self, env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value>;

    /// `Snapshot-ExcelPage`: a read of one range of a sheet. Only Excel has one; every other format answers its snapshot.
    fn snapshot_page(&self, env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
        self.snapshot(env, document, payload)
    }

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
    fn apply_operation(
        &self,
        context: &mut EditContext<'_>,
        document: &Obj,
        op: &Value,
        live: bool,
        allow_ui_activation: bool,
    ) -> Result<Option<Value>>;

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

/// `[int64]$value` of a COM value.
fn int64_of(value: &Com) -> Result<i64> {
    long_of(value)
        .ok_or_else(|| Error::host(format!("Cannot convert the value of type \"{}\" to type \"System.Int64\".", value.dotnet_type_name())))
}

/// `[Math]::Max(1, [int]$payload.limit)`.
fn page_limit(payload: &Value) -> Result<i64> {
    let limit = convert::to_int(&payload::property(payload, "limit")).map_err(Error::host)?;
    Ok(i64::from(limit.max(1)))
}

/// The rule of `Snapshot-Document` that sends a workbook read to the page reader: paged with a range, more than 500 cells,
/// an offset, or a whole-workbook read that did not fit the caller's size and asked for pages (`pageCells`). It is only
/// asked of a request that is `paged`.
fn excel_reads_a_page(document: &Obj, payload: &Value) -> Result<bool> {
    if !convert::to_bool(&payload::property(payload, "paged")) {
        return Ok(false);
    }
    let mut sheet = document.get("ActiveSheet")?;
    let sheet_name = payload::property(payload, "sheet");
    if convert::to_bool(&sheet_name) {
        let name = Com::Str(convert::to_ps_string(&sheet_name));
        sheet = document.get("Worksheets")?.call_member("Item", &[name])?;
    }
    let mut range = sheet.member("UsedRange")?;
    let range_text = payload::property(payload, "range");
    let has_range = convert::to_bool(&range_text);
    if has_range {
        range = sheet.call_member("Range", &[Com::Str(convert::to_ps_string(&range_text))])?;
    }
    let rows = int64_of(&range.member("Rows")?.member("Count")?)?;
    let columns = int64_of(&range.member("Columns")?.member("Count")?)?;
    let cell_total = rows * columns;
    let paged = convert::to_bool(&payload::property(payload, "pageCells")) && cell_total > page_limit(payload)?;
    Ok(has_range
        || cell_total > EXCEL_WHOLE_READ_CELLS
        || convert::to_int64(&payload::property(payload, "offset")).map_err(Error::host)? > 0
        || paged)
}

/// `Snapshot-Document`: the reader of the format, and the selection when the request includes it.
pub fn snapshot_document(drivers: &Drivers<'_>, env: &Env<'_>, document: &Obj, format: &str, payload: &Value) -> Result<Value> {
    let reader = drivers.reader(format).ok_or_else(|| missing_reader(format))?;
    let page = format == "xlsx" && excel_reads_a_page(document, payload)?;
    let mut value = if page { reader.snapshot_page(env, document, payload)? } else { reader.snapshot(env, document, payload)? };
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
    let has_error =
        issues.iter().any(|issue| payload::names_equal(&convert::to_ps_string(&payload::property(issue, "severity")), "error"));
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
