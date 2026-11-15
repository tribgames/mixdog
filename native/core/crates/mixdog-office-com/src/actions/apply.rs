//! `Apply-Operations`: a batch of operations on one document, as one transaction.
//!
//! The editor of the format applies each operation; this is what surrounds them. A live Word batch is one custom undo
//! record, consecutive appendable paragraphs go to the editor as one run, a live PowerPoint batch starts a new undo entry
//! before each operation, and a batch that fails is taken back (Word's `Undo(1)` when the batch touched the document,
//! PowerPoint's `Undo` until the fingerprint of the deck is the one it started from) before the failure is raised.

use mixdog_fsio::WriteProof;

use super::Actions;
use super::location;
use super::saved;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Value as Com;
use crate::format::EditContext;
use crate::format::FormatEditor;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::pipeline_items;
use crate::state::ChartExcel;

/// The undo record of a live Word batch.
const WORD_RECORD_NAME: &str = "Mixdog Office transaction";

/// What the caller asks of a batch.
pub struct Batch<'a> {
    /// `$operations`.
    pub operations: &'a Value,
    pub live: bool,
    pub require_changes: bool,
    pub allow_ui_activation: bool,
}

/// What one pass of the loop did: the results it added, how many operations it took, and the undo units it adds.
struct Step {
    results: Vec<Value>,
    consumed: usize,
    undo_units: i32,
}

fn op_name(op: &Value) -> String {
    convert::to_ps_string(&payload::property(op, "op"))
}

fn changed_of(entry: &Value) -> Option<bool> {
    match entry {
        Value::Object(object) => object.get("changed").map(convert::to_bool),
        _ => None,
    }
}

/// The reason an operation that changed nothing is refused: a phrase that matched nothing says so, as the portable path
/// does.
fn no_change_reason(op: &Value) -> String {
    let name = op_name(op);
    if payload::names_equal(&name, "replace_text") {
        let find = convert::to_ps_string(&payload::property(op, "find"));
        return format!(
            "replace_text produced no change (\"{find}\" appears nowhere; read the wording as written with action:query and a word from it)"
        );
    }
    format!("{name} produced no change")
}

fn run_step(
    context: &mut EditContext<'_>,
    editor: Option<&dyn FormatEditor>,
    document: &Obj,
    format: &str,
    queue: &[Value],
    position: usize,
    batch: &Batch<'_>,
) -> Result<Step, Error> {
    let editor = editor.ok_or_else(|| Error::host(format!("No Office editor is registered for .{format}")))?;
    let op = &queue[position];
    if format == "docx" {
        // Consecutive paragraphs are appended as one block (Apply-WordAppendRun).
        let length = editor.append_run_length(context, document, queue, position)?.min(queue.len() - position);
        if length > 1 {
            let results = editor.apply_append_run(context, document, &queue[position..position + length])?;
            return Ok(Step { results, consumed: length, undo_units: 0 });
        }
    }
    if batch.live && format == "pptx" {
        let _ = document.get("Application").and_then(|application| application.call_member("StartNewUndoEntry", &[]));
    }
    let Some(entry) = editor.apply_operation(context, document, op, batch.live, batch.allow_ui_activation)? else {
        return Err(Error::host(format!("{} returned no structured operation result", op_name(op))));
    };
    let allow_no_change = convert::to_bool(&payload::property(op, "allowNoChange"));
    if batch.require_changes && !allow_no_change && changed_of(&entry) == Some(false) {
        return Err(Error::host(no_change_reason(op)));
    }
    Ok(Step { results: vec![entry], consumed: 1, undo_units: i32::from(batch.live && format == "pptx") })
}

/// The custom undo record of a live Word batch, started; `None` when Word would not start one.
fn start_word_record(document: &Obj) -> Option<Com> {
    let start = || -> Result<Com, Error> {
        let record = document.get("Application")?.member("UndoRecord")?;
        record.call_member("StartCustomRecord", &[Com::from(WORD_RECORD_NAME)])?;
        Ok(record)
    };
    start().ok()
}

/// `Apply-Operations`: `{ results, undoUnits }`, or the failure `<op> failed at <location>: <message>` after the batch was
/// taken back as far as the application allows.
pub fn apply_operations<P: WriteProof>(
    actions: &Actions<'_, P>,
    chart_excel: &mut ChartExcel,
    document: &Obj,
    format: &str,
    batch: &Batch<'_>,
) -> Result<Value, String> {
    let message = |error: Error| error.message().to_owned();
    let live = batch.live;
    // What a failed batch is measured against, to know whether it touched the document. A saved Word document says so
    // itself (every edit clears Saved and no reading does), so a background session, saved after every batch, starts
    // without reading the whole document first. PowerPoint takes a failed batch back through its Undo command, which needs
    // a window; a deck without one (the background session reloads its checkpoint instead) needs no reading either.
    let saved_before = live && format == "docx" && saved(document).unwrap_or(false);
    let mut before_fingerprint = String::new();
    if live && ((format == "docx" && !saved_before) || (format == "pptx" && batch.allow_ui_activation)) {
        before_fingerprint = actions.fingerprint_of(document, format).map_err(message)?;
    }
    let word_record = if live && format == "docx" { start_word_record(document) } else { None };

    let editor = actions.drivers.editor(format);
    let mut context = EditContext { env: actions.env, chart_excel };
    let queue = pipeline_items(batch.operations);
    let mut results: Vec<Value> = Vec::new();
    let mut undo_units = 0;
    let mut failure: Option<String> = None;
    let mut position = 0;
    while position < queue.len() {
        match run_step(&mut context, editor, document, format, &queue, position, batch) {
            Ok(step) => {
                results.extend(step.results);
                undo_units += step.undo_units;
                position += step.consumed;
            }
            Err(error) => {
                failure = Some(format!("{} failed at {}: {}", op_name(&queue[position]), location(file!(), line!()), error.message()));
                break;
            }
        }
    }
    if let Some(record) = &word_record {
        let _ = record.call_member("EndCustomRecord", &[]);
    }

    let word_changed = results.iter().any(|entry| changed_of(entry).unwrap_or(true));
    if let Some(failure) = failure {
        // Word keeps an empty custom record off the undo stack, so Undo(1) after an operation that failed before touching
        // the document took back the previous batch instead. Only a batch that changed something is undone.
        if live && format == "docx" && word_record.is_some() {
            let touched = word_changed
                || if saved_before {
                    !saved(document).map_err(message)?
                } else {
                    actions.fingerprint_of(document, format).map_err(message)? != before_fingerprint
                };
            if touched {
                let _ = document.call("Undo", &[Com::I4(1)]);
            }
        } else if live && format == "pptx" && batch.allow_ui_activation {
            let maximum_attempts = queue.len() + 5;
            let mut attempts = 0;
            while attempts < maximum_attempts {
                if actions.fingerprint_of(document, format).map_err(message)? == before_fingerprint {
                    break;
                }
                let undone = document
                    .get("Application")
                    .and_then(|application| application.member("CommandBars"))
                    .and_then(|bars| bars.call_member("ExecuteMso", &[Com::from("Undo")]));
                if undone.is_err() {
                    break;
                }
                attempts += 1;
            }
        }
        return Err(failure);
    }
    // A batch that changed nothing (allowNoChange) left no record for a later rollback to take back.
    if live && format == "docx" && word_changed {
        undo_units = 1;
    }
    if live && format == "xlsx" && !queue.is_empty() {
        undo_units = 1;
    }
    Ok(Value::object(ObjectKind::Ordered, vec![("results", Value::Array(results)), ("undoUnits", Value::Int(undo_units))]))
}
