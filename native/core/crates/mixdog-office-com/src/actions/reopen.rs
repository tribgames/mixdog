//! Closing and reopening the document of a background session. Only for a session whose application is the host's own: an
//! attached or visible session holds the user's document, and nothing here may close it.

use mixdog_fsio::WriteProof;

use super::Actions;
use super::dpi::repair_excel_page_setup_dpi;
use super::null_call;
use super::text;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Value as Com;
use crate::host::Emitter;
use crate::identity::Ownership;
use crate::office::close_office_document;
use crate::office::get_full_path;
use crate::office::open_background_document;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::state::Mode;
use crate::state::SessionState;
use crate::state::close_session_state;
use crate::state::open_session_state;

fn owned_background(state: &SessionState, format: &str) -> bool {
    state.format == format && state.mode == Mode::Background && state.ownership == Ownership::Owned
}

fn application_of(state: &SessionState) -> Result<&Obj, String> {
    state.app.as_ref().ok_or_else(|| text(null_call()))
}

/// `Close-StateDocumentWithoutSaving`: the document closed without saving; the reference is dropped even when `Close`
/// throws, so the caller reopens from a clean state.
pub fn close_state_document_without_saving(state: &mut SessionState) -> Result<(), String> {
    let current = state.document.take();
    match current {
        Some(document) => document.call("Close", &[Com::Bool(false)]).map(|_| ()).map_err(text),
        None => Err(text(null_call())),
    }
}

/// `Reopen-BackgroundExcelSession`: the workbook closed, optionally replaced by a copy of the file at `restore_path`, its
/// zero DPIs repaired (counted into the session's `ExcelDpiRepairs`), opened again and recalculated in full.
pub fn reopen_background_excel_session<P: WriteProof>(actions: &Actions<'_, P>, state: &mut SessionState, restore_path: &str) -> Result<(), String> {
    if !owned_background(state, "xlsx") {
        return Err("Full-file Excel restore is available only for owned background sessions".to_owned());
    }
    close_state_document_without_saving(state)?;
    if !restore_path.trim().is_empty() {
        actions.copy_over(restore_path, &state.path)?;
    }
    state.excel_dpi_repairs = i32::try_from(repair_excel_page_setup_dpi(actions, &state.path)?).unwrap_or(i32::MAX);
    let app = application_of(state)?;
    let book = app.get("Workbooks").and_then(|books| books.call_member("Open", &[Com::from(state.path.as_str())])).map_err(text)?.into_obj();
    let _ = app.call("CalculateFullRebuild", &[]);
    state.document = book;
    Ok(())
}

/// `Reopen-BackgroundWordSession`: the document closed and opened again from disk.
pub fn reopen_background_word_session(state: &mut SessionState) -> Result<(), String> {
    if !owned_background(state, "docx") {
        return Err("Word reopen validation is available only for owned background sessions".to_owned());
    }
    close_state_document_without_saving(state)?;
    let opened =
        application_of(state)?.get("Documents").and_then(|documents| documents.call_member("Open", &[Com::from(state.path.as_str())])).map_err(text)?;
    state.document = opened.into_obj();
    Ok(())
}

/// `Reopen-BackgroundPowerPointSession`: the whole session closed and opened again, so the application is a new process
/// (optionally after the file at `restore_path` replaced the deck); the state adopts what the new open made.
pub fn reopen_background_powerpoint_session<P: WriteProof>(
    actions: &Actions<'_, P>,
    out: &mut Emitter,
    state: &mut SessionState,
    restore_path: &str,
) -> Result<Obj, String> {
    if !owned_background(state, "pptx") {
        return Err("PowerPoint process reopen is available only for owned background sessions".to_owned());
    }
    let cleanup = close_session_state(state, false, &actions.env)?;
    if !cleanup.ok() {
        return Err(format!("PowerPoint reopen cleanup incomplete: {}", cleanup.errors.join("; ")));
    }
    if !restore_path.trim().is_empty() {
        actions.copy_over(restore_path, &state.path)?;
    }
    let request = Value::object(
        ObjectKind::Custom,
        vec![
            ("session", Value::string(&state.id)),
            ("format", Value::string("pptx")),
            ("path", Value::string(&state.path)),
            ("mode", Value::string("background")),
        ],
    );
    let mut opened = open_session_state(actions.proof, &actions.env, out, &request)?;
    state.app = opened.app.take();
    state.document = opened.document.take();
    state.window_hwnd = opened.window_hwnd;
    state.app_pid = opened.app_pid;
    state.owns_application = opened.owns_application;
    state.app_start_ticks = opened.app_start_ticks;
    state.isolated_process = opened.isolated_process;
    state.document.clone().ok_or_else(|| text(null_call()))
}

/// `Reload-SessionDocument`: re-authoring rewrites the whole deck, and starting PowerPoint again costs seconds, so the
/// application stays and only the document is swapped: the freshly written file at `source_path` is moved onto the session's
/// path while nothing holds it open, then opened in place. A dead application falls back to a full reopen.
pub fn reload_session_document<P: WriteProof>(actions: &Actions<'_, P>, out: &mut Emitter, state: &mut SessionState, source_path: &str) -> Result<Obj, String> {
    if !owned_background(state, "pptx") {
        return Err("Document reload is available only for owned background PowerPoint sessions".to_owned());
    }
    if let Some(document) = &state.document {
        close_office_document(document, "pptx").map_err(text)?;
        state.document = None;
    }
    let target = get_full_path(&state.path)?;
    if !source_path.trim().is_empty() {
        let source = get_full_path(source_path)?;
        if !actions.exists(&source) {
            return Err(format!("Document reload source not found: {source}"));
        }
        if source.to_lowercase() != target.to_lowercase() {
            actions.copy_over(&source, &target)?;
            actions.remove_quietly(&source);
        }
    }
    let opened = application_of(state).map_err(Error::host).and_then(|app| open_background_document(app, "pptx", &target));
    match opened {
        Ok(document) => {
            state.document = Some(document.clone());
            Ok(document)
        }
        Err(_) => {
            state.document = None;
            reopen_background_powerpoint_session(actions, out, state, "")
        }
    }
}
