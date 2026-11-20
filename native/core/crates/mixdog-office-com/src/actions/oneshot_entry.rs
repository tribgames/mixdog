//! The one-shot host's body (`office-com-host.ps1`'s entry): the request names a document, the host opens it (the running
//! application's exact document in `live` mode, a new hidden application's otherwise), runs one action on it and answers; the
//! `finally` closes what the host opened and quits an application it started when nothing else is open in it.

use mixdog_fsio::WriteProof;

use super::Actions;
use super::apply::Batch;
use super::apply::apply_operations;
use super::document::render_document;
use super::document::restore_excel_checkpoint;
use super::document::rollback_live_document;
use super::document::save_document_copy;
use super::failed_cleanup;
use super::path_extension;
use super::preview::assert_preview_not_encrypted;
use super::preview::open_preview_document;
use super::preview::validate_native_document;
use super::restore_saved;
use super::saved;
use super::text;
use crate::com::Obj;
use crate::drivers::Drivers;
use crate::host::Emitter;
use crate::host::OneShotHandler;
use crate::office::Applications;
use crate::office::Env;
use crate::office::active_application;
use crate::office::close_office_document;
use crate::office::find_open_document;
use crate::office::get_full_path;
use crate::office::new_hidden_application;
use crate::office::office_document_count;
use crate::office::open_background_document;
use crate::office::prog_id_for_format;
use crate::office::save_document;
use crate::platform::Platform;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::fingerprint::snapshot_fingerprint;
use crate::ps::payload;
use crate::ps::text::to_lower_invariant;
use crate::session::BACKEND;
use crate::state::ChartExcel;

/// The formats `detect` reports on.
const FORMATS: [&str; 3] = ["docx", "xlsx", "pptx"];

/// What the host holds, which its `finally` lets go of.
#[derive(Default)]
struct Held {
    format: String,
    app: Option<Obj>,
    document: Option<Obj>,
    live: bool,
    created_app: bool,
    chart_excel: ChartExcel,
}

/// The one-shot handler: one request, one document.
pub struct OneShotEntry<'a, P: WriteProof> {
    proof: &'a P,
    platform: Box<dyn Platform + 'a>,
    applications: Box<dyn Applications + 'a>,
    drivers: Drivers<'a>,
    held: Held,
}

impl<'a, P: WriteProof> OneShotEntry<'a, P> {
    pub fn new(proof: &'a P, platform: Box<dyn Platform + 'a>, applications: Box<dyn Applications + 'a>, drivers: Drivers<'a>) -> Self {
        Self { proof, platform, applications, drivers, held: Held::default() }
    }
}

fn answer(mode: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut pairs = vec![("ok", Value::Bool(true)), ("backend", Value::string(BACKEND)), ("mode", Value::string(mode))];
    pairs.extend(fields);
    Value::object(ObjectKind::Ordered, pairs)
}

/// `detect`: which of the three applications are installed, running, and holding the request's document.
fn detect<P: WriteProof>(actions: &Actions<'_, P>, request: &Value, format: &str) -> Result<Value, String> {
    let request_path = payload::property(request, "path");
    let mut applications = Vec::new();
    let mut any_installed = false;
    for candidate in FORMATS {
        let prog_id = prog_id_for_format(candidate);
        let installed = prog_id.is_some_and(|id| actions.env.platform.installed(id));
        let mut active = false;
        let mut open = false;
        if installed && let Some(app) = active_application(&actions.env, prog_id) {
            active = true;
            if convert::to_bool(&request_path) && format == candidate {
                open = find_open_document(&app, candidate, &convert::to_ps_string(&request_path)).map_err(text)?.is_some();
            }
        }
        any_installed |= installed;
        applications.push(Value::object(
            ObjectKind::Ordered,
            vec![
                ("format", Value::string(candidate)),
                ("installed", Value::Bool(installed)),
                ("active", Value::Bool(active)),
                ("documentOpen", Value::Bool(open)),
            ],
        ));
    }
    Ok(Value::object(
        ObjectKind::Ordered,
        vec![
            ("ok", Value::Bool(true)),
            ("backend", Value::string(BACKEND)),
            ("available", Value::Bool(any_installed)),
            ("applications", Value::Array(applications)),
        ],
    ))
}

/// The document the request names, opened: the running application's in `live` mode, otherwise a hidden application's (the
/// file preview's read-only open when the request is `readOnly`).
fn open_document<P: WriteProof>(actions: &Actions<'_, P>, held: &mut Held, request: &Value, format: &str, prog_id: &str, path: &str) -> Result<(), String> {
    if payload::names_equal(&convert::to_ps_string(&payload::property(request, "mode")), "live") {
        held.app = active_application(&actions.env, Some(prog_id));
        let Some(app) = &held.app else {
            return Err(format!("No running Microsoft Office application for .{format}"));
        };
        let document = find_open_document(app, format, path).map_err(text)?;
        let Some(document) = document else {
            return Err(format!("The exact document is not open in Microsoft Office: {path}"));
        };
        held.document = Some(document);
        held.live = true;
        return Ok(());
    }
    // A read-only request (the file preview) opens the document read-only, with no link updates and no recalculation, and
    // never waits on a password prompt. The close at the end discards, so nothing can be written back.
    let read_only = convert::equals(&payload::property(request, "readOnly"), &Value::Bool(true));
    if read_only {
        assert_preview_not_encrypted(actions, path)?;
    }
    let app = new_hidden_application(&actions.env, format, prog_id).map_err(text)?;
    held.created_app = true;
    let opened = if read_only {
        let password = convert::to_ps_string(&payload::property(request, "password"));
        open_preview_document(&app, format, path, &password)
    } else {
        open_background_document(&app, format, path)
    };
    held.app = Some(app);
    held.document = Some(opened.map_err(text)?);
    Ok(())
}

fn batch<P: WriteProof>(actions: &Actions<'_, P>, held: &mut Held, document: &Obj, request: &Value, path: &str) -> Result<Value, String> {
    let live = held.live;
    let format = held.format.clone();
    let mode = if live { "live" } else { "background" };
    let mut excel_checkpoint = String::new();
    if live && format == "xlsx" {
        excel_checkpoint = actions.temporary_name("mixdog-excel-batch", path_extension(path));
        save_document_copy(document, &format, &excel_checkpoint).map_err(text)?;
    }
    let operations = payload::property(request, "operations");
    let spec =
        Batch { operations: &operations, live, require_changes: convert::to_bool(&payload::property(request, "requireChanges")), allow_ui_activation: live };
    let outcome = apply_operations(actions, &mut held.chart_excel, document, &format, &spec).and_then(|applied| {
        let save = !live || convert::to_bool(&payload::property(request, "save"));
        if save {
            save_document(Some(document), &format).map_err(text)?;
        }
        Ok(answer(
            mode,
            vec![("saved", Value::Bool(save)), ("results", payload::property(&applied, "results")), ("undoUnits", payload::property(&applied, "undoUnits"))],
        ))
    });
    if outcome.is_err() && !excel_checkpoint.is_empty() {
        let _ = restore_excel_checkpoint(actions, document, &excel_checkpoint);
    }
    if !excel_checkpoint.is_empty() {
        actions.remove_quietly(&excel_checkpoint);
    }
    outcome
}

fn run<P: WriteProof>(actions: &Actions<'_, P>, held: &mut Held, out: &mut Emitter, request: &Value) -> Result<Value, String> {
    let format = to_lower_invariant(&convert::to_ps_string(&payload::property(request, "format")));
    held.format = format.clone();
    if payload::names_equal(&convert::to_ps_string(&payload::property(request, "action")), "detect") {
        return detect(actions, request, &format);
    }
    let prog_id = prog_id_for_format(&format);
    let Some(prog_id) = prog_id.filter(|id| actions.env.platform.installed(id)) else {
        return Err(format!("Microsoft Office application for .{format} is not installed"));
    };
    let path = get_full_path(&convert::to_ps_string(&payload::property(request, "path")))?;
    open_document(actions, held, request, &format, prog_id, &path)?;
    let Some(document) = held.document.clone() else {
        return Err("Microsoft Office did not answer a document.".to_owned());
    };
    let mode = if held.live { "live" } else { "background" };
    let action = convert::to_ps_string(&payload::property(request, "action"));
    match to_lower_invariant(&action).as_str() {
        "snapshot" => {
            let value = actions.snapshot(&document, &format, request).map_err(text)?;
            Ok(answer(mode, vec![("value", value)]))
        }
        "issues" => {
            let value = actions.issues(&document, &format, Some(request)).map_err(text)?;
            Ok(answer(mode, vec![("value", value)]))
        }
        "validate" => {
            let mut value = validate_native_document(actions, out, &path, &format);
            let document_saved = saved(&document).map_err(text)?;
            if let Value::Object(object) = &mut value {
                object.set("documentSaved", Value::Bool(document_saved));
            }
            Ok(answer(mode, vec![("value", value)]))
        }
        "checkpoint" => {
            let output = get_full_path(&convert::to_ps_string(&payload::property(request, "output")))?;
            let value = actions.snapshot(&document, &format, request).map_err(text)?;
            if format == "docx" {
                let fingerprint = snapshot_fingerprint(&value);
                let document_saved = saved(&document).map_err(text)?;
                return Ok(answer(mode, vec![("fingerprint", Value::String(fingerprint)), ("saved", Value::Bool(document_saved)), ("value", value)]));
            }
            save_document_copy(&document, &format, &output).map_err(text)?;
            let document_saved = saved(&document).map_err(text)?;
            Ok(answer(mode, vec![("output", Value::String(output)), ("saved", Value::Bool(document_saved)), ("value", value)]))
        }
        "batch" => batch(actions, held, &document, request, &path),
        "rollback" => {
            if !held.live {
                return Err("Office COM rollback is available for live documents only".to_owned());
            }
            let checkpoint = convert::to_ps_string(&payload::property(request, "checkpoint"));
            let undo_units = convert::to_int(&payload::property(request, "undoUnits"))?;
            rollback_live_document(actions, &document, &format, &checkpoint, undo_units).map_err(text)?;
            let value = actions.snapshot(&document, &format, request).map_err(text)?;
            Ok(answer("live", vec![("rolledBack", Value::Bool(true)), ("value", value)]))
        }
        "save" => {
            save_document(Some(&document), &format).map_err(text)?;
            Ok(answer(mode, vec![("saved", Value::Bool(true)), ("path", Value::String(path))]))
        }
        "render" => {
            let output = get_full_path(&convert::to_ps_string(&payload::property(request, "output")))?;
            let was_saved = saved(&document).map_err(text)?;
            render_document(actions, &document, &format, &output)?;
            restore_saved(&document, was_saved).map_err(text)?;
            Ok(answer(mode, vec![("output", Value::String(output))]))
        }
        _ => Err(format!("Unsupported Office host action: {action}")),
    }
}

impl<P: WriteProof> OneShotHandler for OneShotEntry<'_, P> {
    fn handle(&mut self, out: &mut Emitter, request: &Value) -> Result<Value, String> {
        let env = Env { platform: &*self.platform, applications: &*self.applications };
        let actions = Actions { env, proof: self.proof, drivers: self.drivers };
        run(&actions, &mut self.held, out, request)
    }

    fn finish(&mut self, out: &mut Emitter) {
        let env = Env { platform: &*self.platform, applications: &*self.applications };
        let held = &mut self.held;
        if let Some(document) = held.document.take() {
            if !held.live
                && let Err(error) = close_office_document(&document, &held.format)
            {
                out.cleanup_failure(&failed_cleanup(&format!("Document close failed: {}", error.message())));
            }
            drop(document);
        }
        if let Some(app) = held.app.take() {
            if held.created_app {
                let quit = office_document_count(&app, &held.format).and_then(|count| if count == 0 { app.call("Quit", &[]).map(|_| ()) } else { Ok(()) });
                if let Err(error) = quit {
                    out.cleanup_failure(&failed_cleanup(&format!("Application cleanup failed: {}", error.message())));
                }
            }
            drop(app);
        }
        if held.format == "pptx" {
            held.chart_excel.close(held.created_app, &env);
        }
    }
}
