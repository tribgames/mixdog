//! `Close-SessionState` (`office-com-cleanup.ps1`) and the `close_session` request of the session host.
//!
//! Document ownership and application ownership are different: an owned document may live in an application that was
//! there before it. A shared application is never quit. The references the state holds are dropped (released) before
//! the wait for the process to end, so an accepted `Quit` really ends it; only a reference kept for a retry (the close
//! failed) stays.

use super::SessionState;
use super::isolation::session_response;
use super::ownership_text;
use crate::host::Closed;
use crate::identity::Ownership;
use crate::office::Env;
use crate::office::close_office_document;
use crate::office::office_document_count;
use crate::office::save_document;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;

/// How long an owned application is given to end after it accepted `Quit`: it flushes settings and unloads add-ins, which
/// takes seconds. The wait returns the moment the process is gone.
const EXIT_WAIT_MS: u32 = 8000;
/// How long a background application that was killed is waited for.
const KILL_WAIT_MS: u32 = 5000;

/// The record `Close-SessionState` answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cleanup {
    pub document_closed: bool,
    pub detached: bool,
    pub application_quit: bool,
    pub application_retained: bool,
    /// `$null` until the process was looked at.
    pub process_exited: Option<bool>,
    pub forced_process_cleanup: bool,
    pub errors: Vec<String>,
}

impl Cleanup {
    /// No error, and the document is closed or was never this session's to close.
    pub fn ok(&self) -> bool {
        self.errors.is_empty() && (self.document_closed || self.detached)
    }

    /// The record, its keys in the order the script builds them.
    pub fn to_value(&self) -> Value {
        Value::object(
            ObjectKind::Ordered,
            vec![
                ("ok", Value::Bool(self.ok())),
                ("documentClosed", Value::Bool(self.document_closed)),
                ("detached", Value::Bool(self.detached)),
                ("applicationQuit", Value::Bool(self.application_quit)),
                ("applicationRetained", Value::Bool(self.application_retained)),
                ("processExited", self.process_exited.map_or(Value::Null, Value::Bool)),
                ("forcedProcessCleanup", Value::Bool(self.forced_process_cleanup)),
                ("errors", Value::Array(self.errors.iter().map(|error| Value::String(error.clone())).collect())),
            ],
        )
    }
}

/// `Close-SessionState $state $save`: the optional save (a failure is the answer's error, nothing is closed), then
/// [`close_state`].
pub fn close_session_state(state: &mut SessionState, save: bool, env: &Env<'_>) -> Result<Cleanup, String> {
    if save {
        save_document(state.document.as_ref(), &state.format).map_err(|error| error.message().to_owned())?;
    }
    Ok(close_state(state, env))
}

/// The cleanup itself: close only an owned document, quit only an owned application whose collection is empty, release,
/// chart Excel cleanup for a deck, then confirm (and for a background application enforce) that the process is gone.
pub(crate) fn close_state(state: &mut SessionState, env: &Env<'_>) -> Cleanup {
    let mut errors: Vec<String> = Vec::new();
    let mut result = Cleanup {
        document_closed: state.document.is_none(),
        detached: state.ownership != Ownership::Owned,
        application_quit: false,
        application_retained: false,
        process_exited: None,
        forced_process_cleanup: false,
        errors: Vec::new(),
    };
    if state.ownership == Ownership::Owned
        && let Some(document) = &state.document
    {
        match close_office_document(document, &state.format) {
            Ok(()) => result.document_closed = true,
            Err(error) => errors.push(format!("Document close failed: {}", error.message())),
        }
    }
    // A document that failed to close is kept for an explicit retry.
    if result.document_closed || result.detached {
        state.document = None;
    }
    let owns_application = state.ownership == Ownership::Owned && state.owns_application;
    let mut empty = false;
    if owns_application
        && let Some(app) = &state.app
    {
        match office_document_count(app, &state.format) {
            Ok(count) => empty = count == 0,
            Err(error) => errors.push(format!("Application document count unavailable: {}", error.message())),
        }
    }
    match &state.app {
        Some(app) if owns_application && empty => match app.call("Quit", &[]) {
            Ok(_) => result.application_quit = true,
            Err(error) => errors.push(format!("Application quit failed: {}", error.message())),
        },
        Some(_) => result.application_retained = true,
        None => {}
    }
    if (result.document_closed || result.detached) && (!owns_application || !empty || result.application_quit) {
        state.app = None;
    }
    if state.format == "pptx" {
        state.chart_excel.close(owns_application && empty, env);
    }
    if owns_application && empty && state.app_pid > 0 {
        confirm_process_exit(state, env, &mut result, &mut errors);
    }
    result.errors = errors;
    result
}

/// The part of the cleanup that looks at the application's process: gone, or the same process (never another one that
/// reused the id), waited for, and killed only when it is an isolated background application that accepted `Quit`.
fn confirm_process_exit(state: &mut SessionState, env: &Env<'_>, result: &mut Cleanup, errors: &mut Vec<String>) {
    let platform = env.platform;
    let pid = state.app_pid;
    if !platform.process_exists(pid) {
        result.process_exited = Some(true);
    } else if state.app_start_ticks <= 0 || platform.process_start_ticks(pid) != state.app_start_ticks {
        errors.push("Application process identity changed; forced cleanup refused.".to_owned());
    } else {
        let mut exited = platform.wait_for_exit(pid, EXIT_WAIT_MS);
        result.process_exited = Some(exited);
        let mut confirmed = true;
        if !exited && result.application_quit && state.mode == super::Mode::Background {
            if platform.kill_process(pid) {
                result.forced_process_cleanup = true;
                exited = platform.wait_for_exit(pid, KILL_WAIT_MS);
                result.process_exited = Some(exited);
            } else {
                errors.push("Application exit confirmation failed: Access is denied".to_owned());
                confirmed = false;
            }
        }
        if confirmed && !exited {
            errors.push("Owned Office application is still running after cleanup.".to_owned());
        }
    }
    if result.process_exited == Some(true) {
        state.app_pid = 0;
    }
}

/// The `close_session` request: the save when asked, the answer as `Session-Response` builds it, then the cleanup. A
/// cleanup that is not ok keeps the state (and the loop) for a retry.
pub fn close_session(state: &mut SessionState, env: &Env<'_>, request: &Value) -> Result<Closed, String> {
    let save = convert::to_bool(&payload::property(request, "save"));
    if save {
        save_document(state.document.as_ref(), &state.format).map_err(|error| error.message().to_owned())?;
    }
    let fields = Value::object(
        ObjectKind::Ordered,
        vec![
            ("closed", Value::Bool(false)),
            ("saved", Value::Bool(save)),
            ("ownership", Value::string(ownership_text(state.ownership))),
            ("appPid", Value::Int(state.app_pid)),
            ("path", Value::string(&state.path)),
        ],
    );
    let mut result = session_response(state, env, &fields)?;
    let cleanup = close_state(state, env);
    let ok = cleanup.ok();
    if let Value::Object(object) = &mut result {
        object.set("cleanup", cleanup.to_value());
        object.set("ok", Value::Bool(ok));
        object.set("closed", Value::Bool(ok));
        if !ok {
            object.set("error", Value::String(format!("Office cleanup incomplete: {}", cleanup.errors.join("; "))));
        }
    }
    Ok(Closed { result, closed: ok })
}
