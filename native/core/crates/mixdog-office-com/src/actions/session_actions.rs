//! `Invoke-SessionAction` and the session handler around it: every action of an open session, on the document its state
//! holds (`office-com-session-host.ps1`).
//!
//! A session answers through `Session-Response` ([`crate::state::session_response`]): the common fields, the isolation report
//! of a background session, then the action's own fields.

use mixdog_fsio::WriteProof;

use super::Actions;
use super::apply::Batch;
use super::apply::apply_operations;
use super::document::render_document;
use super::document::restore_excel_checkpoint;
use super::document::rollback_live_document;
use super::document::save_document_copy;
use super::empty_payload;
use super::import::replace_presentation_from_source;
use super::null_call;
use super::path_extension;
use super::reopen::reload_session_document;
use super::reopen::reopen_background_excel_session;
use super::reopen::reopen_background_powerpoint_session;
use super::reopen::reopen_background_word_session;
use super::restore_saved;
use super::saved;
use super::text;
use crate::com::Obj;
use crate::com::Result;
use crate::com::retry;
use crate::drivers::Drivers;
use crate::host::Closed;
use crate::host::Emitter;
use crate::host::SessionHandler;
use crate::identity::Ownership;
use crate::office::Applications;
use crate::office::Env;
use crate::office::get_full_path;
use crate::office::save_document;
use crate::platform::Platform;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::fingerprint::snapshot_fingerprint;
use crate::ps::payload;
use crate::ps::pipeline_items;
use crate::ps::text::to_lower_invariant;
use crate::state::Mode;
use crate::state::SessionState;
use crate::state::close_session;
use crate::state::close_session_state;
use crate::state::open_session_response;
use crate::state::open_session_state;
use crate::state::session_response;

impl<P: WriteProof> Actions<'_, P> {
    /// `Snapshot-SessionDocument`: a workbook read is tried again while Excel answers busy.
    pub fn session_snapshot(&self, document: &Obj, format: &str, request: &Value) -> Result<Value> {
        if format == "xlsx" {
            return retry::excel(&self.env, "Excel session snapshot", &[], || self.snapshot(document, format, request));
        }
        self.snapshot(document, format, request)
    }

    /// `Issues-SessionDocument`.
    pub fn session_issues(&self, document: &Obj, format: &str, request: &Value) -> Result<Value> {
        if format == "xlsx" {
            return retry::excel(&self.env, "Excel session issue inspection", &[], || self.issues(document, format, Some(request)));
        }
        self.issues(document, format, Some(request))
    }
}

/// An action's own fields, in order.
fn fields(pairs: Vec<(&str, Value)>) -> Value {
    Value::object(ObjectKind::Ordered, pairs)
}

fn document_of(state: &SessionState) -> std::result::Result<Obj, String> {
    state.document.clone().ok_or_else(|| text(null_call()))
}

fn owned_background(state: &SessionState) -> bool {
    state.mode == Mode::Background && state.ownership == Ownership::Owned
}

fn output_path(request: &Value) -> std::result::Result<String, String> {
    get_full_path(&convert::to_ps_string(&payload::property(request, "output")))
}

fn issue_list(inspection: &Value) -> Value {
    Value::Array(pipeline_items(&payload::property(inspection, "issues")))
}

/// `validate`: the persistent session already proves that the exact document is open, so it is read and inspected where it
/// is. Starting a second application can bind to the same process, and quitting that validator would destroy this session.
fn validate<P: WriteProof>(actions: &Actions<'_, P>, state: &SessionState, request: &Value) -> std::result::Result<Value, String> {
    let document = document_of(state)?;
    let format = state.format.as_str();
    let was_saved = saved(&document).map_err(text)?;
    let snapshot = actions.session_snapshot(&document, format, &empty_payload()).map_err(text)?;
    let skip = payload::property(request, "inspectIssues");
    let inspection = if !skip.is_null() && !convert::to_bool(&skip) {
        fields(vec![("ok", Value::Bool(true)), ("issueCount", Value::Int(0)), ("issues", Value::Array(Vec::new()))])
    } else {
        actions.session_issues(&document, format, &empty_payload()).map_err(text)?
    };
    restore_saved(&document, was_saved).map_err(text)?;
    Ok(fields(vec![
        ("ok", Value::Bool(convert::to_bool(&payload::property(&inspection, "ok")))),
        ("opened", Value::Bool(true)),
        ("issueCount", Value::Int(convert::to_int(&payload::property(&inspection, "issueCount"))?)),
        ("issues", issue_list(&inspection)),
        ("snapshotFingerprint", Value::String(snapshot_fingerprint(&snapshot))),
        ("documentSaved", Value::Bool(saved(&document).map_err(text)?)),
    ]))
}

/// `batch`'s work: the operations, the save a background session or the request asks for, and the answer.
fn run_batch<P: WriteProof>(
    actions: &Actions<'_, P>,
    state: &mut SessionState,
    document: &Obj,
    format: &str,
    request: &Value,
) -> std::result::Result<Value, String> {
    let background = state.mode == Mode::Background;
    let operations = payload::property(request, "operations");
    let spec = Batch {
        operations: &operations,
        live: true,
        require_changes: convert::to_bool(&payload::property(request, "requireChanges")),
        allow_ui_activation: !background,
    };
    let applied = apply_operations(actions, &mut state.chart_excel, document, format, &spec)?;
    let should_save = background || convert::to_bool(&payload::property(request, "save"));
    if should_save {
        save_document(Some(document), format).map_err(text)?;
    }
    let answer = fields(vec![
        ("saved", Value::Bool(should_save)),
        ("results", payload::property(&applied, "results")),
        ("undoUnits", payload::property(&applied, "undoUnits")),
    ]);
    session_response(state, &actions.env, &answer)
}

/// `batch`: a workbook is checkpointed (a copy in the temporary directory) for any mode, and so is the deck of an owned
/// background PowerPoint session, whose Undo command needs a window it does not have. A batch that fails puts the checkpoint
/// back, and the copies are always removed.
fn batch<P: WriteProof>(
    actions: &Actions<'_, P>,
    out: &mut Emitter,
    state: &mut SessionState,
    document: Obj,
    request: &Value,
) -> std::result::Result<Value, String> {
    let format = state.format.clone();
    let mut excel_checkpoint = String::new();
    if format == "xlsx" {
        excel_checkpoint = actions.temporary_name("mixdog-excel-batch", path_extension(&state.path));
        save_document_copy(&document, &format, &excel_checkpoint).map_err(text)?;
    }
    let mut deck_checkpoint = String::new();
    if format == "pptx" && owned_background(state) {
        deck_checkpoint = actions.temporary_name("mixdog-pptx-batch", path_extension(&state.path));
        save_document_copy(&document, &format, &deck_checkpoint).map_err(text)?;
    }
    let outcome = run_batch(actions, state, &document, &format, request);
    if outcome.is_err() {
        if !excel_checkpoint.is_empty() {
            let _ = if owned_background(state) {
                reopen_background_excel_session(actions, state, "")
            } else {
                restore_excel_checkpoint(actions, &document, &excel_checkpoint).map_err(text)
            };
        }
        // This handle is the reference the batch took to the deck. A reload that falls back to a full reopen quits the
        // application and waits for its process to end, and an application that something still holds a reference to does
        // not end: the handle is released before the reload, as the PowerShell host's collection of garbage did.
        drop(document);
        if !deck_checkpoint.is_empty() {
            let _ = reload_session_document(actions, out, state, &deck_checkpoint);
        }
    }
    for checkpoint in [&excel_checkpoint, &deck_checkpoint] {
        if !checkpoint.is_empty() {
            actions.remove_quietly(checkpoint);
        }
    }
    outcome
}

/// `post_save_validate`: the document saved, read back from disk for an owned background session (a new document of the
/// same application, or for a deck the running application's reload), and inspected there.
fn post_save_validate<P: WriteProof>(
    actions: &Actions<'_, P>,
    out: &mut Emitter,
    state: &mut SessionState,
    request: &Value,
) -> std::result::Result<Value, String> {
    let format = state.format.clone();
    let mut document = document_of(state)?;
    save_document(Some(&document), &format).map_err(text)?;
    let mut reopened = false;
    if owned_background(state) {
        match format.as_str() {
            "docx" => reopen_background_word_session(state)?,
            "xlsx" => reopen_background_excel_session(actions, state, "")?,
            // The saved deck is read back from disk in the running PowerPoint, as re-authoring reloads it: a new PowerPoint
            // process proved nothing more about the file and cost seconds on every finalize.
            "pptx" => {
                // A reload that falls back to a full reopen quits the application and waits for its process: this handle
                // to the old deck is released first.
                drop(document);
                reload_session_document(actions, out, state, "")?;
            }
            _ => {}
        }
        document = document_of(state)?;
        reopened = true;
    }
    if format == "xlsx" && !saved(&document).map_err(text)? {
        save_document(Some(&document), &format).map_err(text)?;
    }
    let was_saved = saved(&document).map_err(text)?;
    // The reopened workbook's reading travels with the result: a caller checks a persisted freeze or print setup against it.
    // A deck's or a document's is read by nothing after this, and the issue read below already walks the reopened file.
    // Finalize drops the workbook's reading from its answer and does not ask for it (includeSnapshot false).
    let include = payload::property(request, "includeSnapshot");
    let snapshot = if format == "xlsx" && !convert::equals(&include, &Value::Bool(false)) {
        Some(actions.session_snapshot(&document, &format, &empty_payload()).map_err(text)?)
    } else {
        None
    };
    let inspection = actions.session_issues(&document, &format, &empty_payload()).map_err(text)?;
    restore_saved(&document, was_saved).map_err(text)?;
    let dpi_repairs = if format == "xlsx" { state.excel_dpi_repairs } else { 0 };
    let mut value = fields(vec![
        ("ok", Value::Bool(convert::to_bool(&payload::property(&inspection, "ok")))),
        ("opened", Value::Bool(true)),
        ("reopened", Value::Bool(reopened)),
        ("persisted", Value::Bool(reopened)),
        ("excelDpiRepairs", Value::Int(dpi_repairs)),
        ("issueCount", Value::Int(convert::to_int(&payload::property(&inspection, "issueCount"))?)),
        ("issues", issue_list(&inspection)),
        ("documentSaved", Value::Bool(saved(&document).map_err(text)?)),
    ]);
    if let (Some(snapshot), Value::Object(object)) = (snapshot, &mut value) {
        let fingerprint = snapshot_fingerprint(&snapshot);
        object.set("snapshot", snapshot);
        object.set("snapshotFingerprint", Value::String(fingerprint));
    }
    session_response(state, &actions.env, &fields(vec![("value", value)]))
}

/// `render`: PowerPoint honours only the first PDF export of an open presentation, so a repeat render saves the deck and
/// reopens it to get a fresh export slot; the other formats leave the document looking as saved as it was.
fn render<P: WriteProof>(
    actions: &Actions<'_, P>,
    out: &mut Emitter,
    state: &mut SessionState,
    request: &Value,
) -> std::result::Result<Value, String> {
    let format = state.format.clone();
    let mut document = document_of(state)?;
    let output = output_path(request)?;
    if format == "pptx" {
        if !saved(&document).map_err(text)? {
            save_document(Some(&document), &format).map_err(text)?;
        }
        if state.pptx_exports > 0 && owned_background(state) {
            // The reopen quits the application and waits for its process: this handle to the old deck is released first.
            drop(document);
            reopen_background_powerpoint_session(actions, out, state, "")?;
            document = document_of(state)?;
        }
        render_document(actions, &document, &format, &output)?;
        state.pptx_exports += 1;
    } else {
        let was_saved = saved(&document).map_err(text)?;
        render_document(actions, &document, &format, &output)?;
        restore_saved(&document, was_saved).map_err(text)?;
    }
    session_response(state, &actions.env, &fields(vec![("output", Value::String(output))]))
}

/// `Invoke-SessionAction`: an action of the open session, answered through `Session-Response`.
pub fn invoke_session_action<P: WriteProof>(
    actions: &Actions<'_, P>,
    out: &mut Emitter,
    state: &mut SessionState,
    request: &Value,
) -> std::result::Result<Value, String> {
    let format = state.format.clone();
    let action = convert::to_ps_string(&payload::property(request, "action"));
    match to_lower_invariant(&action).as_str() {
        "snapshot" => {
            let document = document_of(state)?;
            let value = actions.session_snapshot(&document, &format, request).map_err(text)?;
            session_response(state, &actions.env, &fields(vec![("value", value)]))
        }
        "issues" => {
            let document = document_of(state)?;
            let was_saved = saved(&document).map_err(text)?;
            let value = actions.session_issues(&document, &format, request).map_err(text)?;
            restore_saved(&document, was_saved).map_err(text)?;
            session_response(state, &actions.env, &fields(vec![("value", value)]))
        }
        "validate" => {
            let value = validate(actions, state, request)?;
            session_response(state, &actions.env, &fields(vec![("value", value)]))
        }
        "checkpoint" => {
            let document = document_of(state)?;
            let output = output_path(request)?;
            let value = actions.session_snapshot(&document, &format, request).map_err(text)?;
            if format == "docx" {
                let fingerprint = snapshot_fingerprint(&value);
                let document_saved = saved(&document).map_err(text)?;
                return session_response(
                    state,
                    &actions.env,
                    &fields(vec![("fingerprint", Value::String(fingerprint)), ("saved", Value::Bool(document_saved)), ("value", value)]),
                );
            }
            save_document_copy(&document, &format, &output).map_err(text)?;
            let document_saved = saved(&document).map_err(text)?;
            session_response(
                state,
                &actions.env,
                &fields(vec![("output", Value::String(output)), ("saved", Value::Bool(document_saved)), ("value", value)]),
            )
        }
        "save_copy" => {
            let document = document_of(state)?;
            let output = output_path(request)?;
            save_document_copy(&document, &format, &output).map_err(text)?;
            let document_saved = saved(&document).map_err(text)?;
            session_response(state, &actions.env, &fields(vec![("output", Value::String(output)), ("saved", Value::Bool(document_saved))]))
        }
        "reload_document" => {
            reload_session_document(actions, out, state, &convert::to_ps_string(&payload::property(request, "source")))?;
            let answer = fields(vec![
                ("reloaded", Value::Bool(true)),
                ("path", Value::string(&state.path)),
                ("appPid", Value::Int(state.app_pid)),
                ("documentId", Value::string(&state.document_id)),
            ]);
            session_response(state, &actions.env, &answer)
        }
        "replace_presentation_from_source" => replace_presentation_from_source(actions, out, state, request),
        "batch" => {
            let document = document_of(state)?;
            batch(actions, out, state, document, request)
        }
        "rollback" => {
            let mut document = document_of(state)?;
            let checkpoint = convert::to_ps_string(&payload::property(request, "checkpoint"));
            if format == "xlsx" && owned_background(state) {
                reopen_background_excel_session(actions, state, &checkpoint)?;
                document = document_of(state)?;
            } else {
                let undo_units = convert::to_int(&payload::property(request, "undoUnits"))?;
                rollback_live_document(actions, &document, &format, &checkpoint, undo_units).map_err(text)?;
            }
            let value = actions.session_snapshot(&document, &format, request).map_err(text)?;
            if state.mode == Mode::Background {
                save_document(Some(&document), &format).map_err(text)?;
            }
            session_response(state, &actions.env, &fields(vec![("rolledBack", Value::Bool(true)), ("value", value)]))
        }
        "save" => {
            let document = document_of(state)?;
            save_document(Some(&document), &format).map_err(text)?;
            session_response(state, &actions.env, &fields(vec![("saved", Value::Bool(true)), ("path", Value::string(&state.path))]))
        }
        "post_save_validate" => post_save_validate(actions, out, state, request),
        "render" => render(actions, out, state, request),
        _ => Err(format!("Unsupported Office session action: {action}")),
    }
}

/// The session host's handler: the state of the one session this host serves.
pub struct SessionActions<'a, P: WriteProof> {
    proof: &'a P,
    platform: Box<dyn Platform + 'a>,
    applications: Box<dyn Applications + 'a>,
    drivers: Drivers<'a>,
    state: Option<SessionState>,
}

impl<'a, P: WriteProof> SessionActions<'a, P> {
    pub fn new(proof: &'a P, platform: Box<dyn Platform + 'a>, applications: Box<dyn Applications + 'a>, drivers: Drivers<'a>) -> Self {
        Self { proof, platform, applications, drivers, state: None }
    }
}

const NO_DOCUMENT: &str = "Office session host has no open document";

impl<P: WriteProof> SessionHandler for SessionActions<'_, P> {
    fn session_id(&self) -> Option<String> {
        self.state.as_ref().map(|state| state.id.clone())
    }

    fn app_pid(&self) -> Value {
        self.state.as_ref().map_or(Value::Null, |state| Value::Int(state.app_pid))
    }

    fn open(&mut self, out: &mut Emitter, request: &Value) -> std::result::Result<Value, String> {
        let env = Env { platform: &*self.platform, applications: &*self.applications };
        self.state = Some(open_session_state(self.proof, &env, out, request)?);
        let state = self.state.as_mut().ok_or_else(|| NO_DOCUMENT.to_owned())?;
        open_session_response(state, &env)
    }

    fn record_foreground(&mut self) {
        if let Some(state) = self.state.as_mut() {
            state.record_foreground(&*self.platform);
        }
    }

    fn action(&mut self, out: &mut Emitter, request: &Value) -> std::result::Result<Value, String> {
        let env = Env { platform: &*self.platform, applications: &*self.applications };
        let actions = Actions { env, proof: self.proof, drivers: self.drivers };
        let state = self.state.as_mut().ok_or_else(|| NO_DOCUMENT.to_owned())?;
        invoke_session_action(&actions, out, state, request)
    }

    fn close(&mut self, _out: &mut Emitter, request: &Value) -> std::result::Result<Closed, String> {
        let env = Env { platform: &*self.platform, applications: &*self.applications };
        let state = self.state.as_mut().ok_or_else(|| NO_DOCUMENT.to_owned())?;
        let closed = close_session(state, &env, request)?;
        if closed.closed {
            self.state = None;
        }
        Ok(closed)
    }

    fn end(&mut self) -> std::result::Result<Value, String> {
        let env = Env { platform: &*self.platform, applications: &*self.applications };
        match self.state.as_mut() {
            Some(state) => Ok(close_session_state(state, false, &env)?.to_value()),
            None => Ok(Value::Null),
        }
    }
}
