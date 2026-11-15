//! `Open-SessionState` and the `open_session` answer (`office-com-session-host.ps1`).
//!
//! * `attach` and `visible` first look for the exact document a running application holds (the running object table, then
//!   the active application's collection) and take it as `attached`. `attach` refuses when it is not registered;
//!   `visible` refuses to open a duplicate of a file that appears open.
//! * Otherwise a new application is started, and it is owned only when its process is a new one. A background session
//!   refuses a shared or unidentified application before it opens anything, and one that reused an existing process after.
//! * The identity line (`ownership`, `ownsApplication`, `appPid`) is written before an open that can block.
//! * On any failure the state built so far is closed through [`close_state`], owning the application only when it was not
//!   shared; a failed cleanup is written to stderr and appended to the error.

use mixdog_fsio::WriteProof;

use super::Leftovers;
use super::Mode;
use super::SessionState;
use super::cleanup::close_state;
use super::create::create_owned_document;
use super::isolation::session_response;
use super::isolation::window_process_id;
use super::ownership_text;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Value as Com;
use crate::host::Emitter;
use crate::identity::Ownership;
use crate::office::Env;
use crate::office::active_application;
use crate::office::file_name;
use crate::office::find_open_document;
use crate::office::get_full_path;
use crate::office::item_of;
use crate::office::initialize_owned_application;
use crate::office::long_of;
use crate::office::prog_id_for_format;
use crate::office::same_document_path;
use crate::office::set_office_visible;
use crate::office::text_of;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;

/// How many times the running object table is asked for the document, and the pause after each.
const LOOKUP_ATTEMPTS: u32 = 10;
const LOOKUP_PAUSE_MS: u32 = 100;
/// How many times a new process of the format is looked for, and the pause after each.
const PROCESS_ATTEMPTS: u32 = 20;
const PROCESS_PAUSE_MS: u32 = 50;
/// How many times a visible deck's window handle is asked for, and the pause after each.
const WINDOW_ATTEMPTS: u32 = 20;
const WINDOW_PAUSE_MS: u32 = 100;
/// How many times the foreground is requested for a visible deck, and the pause after each.
const FOREGROUND_ATTEMPTS: u32 = 10;
const FOREGROUND_PAUSE_MS: u32 = 50;

fn text(error: Error) -> String {
    error.message().to_owned()
}

/// `Find-RunningDocumentExact`: the exact document a running application holds, or none.
pub fn find_running_document_exact(env: &Env<'_>, format: &str, path: &str) -> Result<Option<Obj>, String> {
    if format == "xlsx" {
        env.platform.register_excel_instances();
    }
    for _ in 0..LOOKUP_ATTEMPTS {
        if let Some(running) = env.platform.try_get_running_file(path)
            && let Some(candidate) = env.applications.running(running)
            && same_document_path(&candidate, path)
        {
            return Ok(Some(candidate));
        }
        env.platform.sleep(LOOKUP_PAUSE_MS);
    }
    let Some(app) = active_application(env, prog_id_for_format(format)) else { return Ok(None) };
    find_open_document(&app, format, path).map_err(text)
}

/// `Wait-NewOfficeProcessId`: the one process of the format that was not there before, 0 when none or several appear.
fn wait_new_office_process_id(env: &Env<'_>, format: &str, baseline: &[i32]) -> i32 {
    for _ in 0..PROCESS_ATTEMPTS {
        let new: Vec<i32> = env.platform.office_process_ids(format).into_iter().filter(|id| !baseline.contains(id)).collect();
        if let [only] = new.as_slice() {
            return *only;
        }
        env.platform.sleep(PROCESS_PAUSE_MS);
    }
    0
}

/// `$value` of a property read that may fail, as the hosts' `try { [long]... } catch {}` takes it: a nonzero handle.
fn handle_of(read: crate::com::Result<Com>) -> Option<i64> {
    read.ok().and_then(|value| long_of(&value)).filter(|hwnd| *hwnd != 0)
}

/// `Application-Hwnd`: the window handle of the document's window, the application's, or (a deck) a window found by title.
pub fn application_hwnd(env: &Env<'_>, app: Option<&Obj>, document: Option<&Obj>, format: &str) -> i64 {
    if format == "docx"
        && let Some(document) = document
        && let Some(hwnd) = handle_of(document.get("ActiveWindow").and_then(|window| window.member("Hwnd")))
    {
        return hwnd;
    }
    if format == "pptx"
        && let Some(document) = document
    {
        let window = document.get("Windows").and_then(|windows| item_of(&windows, 1));
        if let Some(hwnd) = handle_of(window.and_then(|window| window.member("HWND"))) {
            return hwnd;
        }
    }
    if let Some(app) = app {
        for name in ["Hwnd", "HWND"] {
            if let Some(hwnd) = handle_of(app.get(name)) {
                return hwnd;
            }
        }
    }
    if format == "pptx"
        && let Some(document) = document
        && let Ok(name) = document.get("FullName")
    {
        let hwnd = env.platform.find_window_by_class_and_title("PPTFrameClass", file_name(&text_of(&name)));
        if hwnd != 0 {
            return hwnd;
        }
    }
    0
}

/// `Set-OfficeForeground`: the window is activated, tried 10 times 50 ms apart.
fn set_office_foreground(env: &Env<'_>, hwnd: i64) -> bool {
    if hwnd == 0 {
        return false;
    }
    for _ in 0..FOREGROUND_ATTEMPTS {
        if env.platform.activate_window(hwnd) {
            return true;
        }
        env.platform.sleep(FOREGROUND_PAUSE_MS);
    }
    false
}

/// `Open-OwnedDocument`.
fn open_owned_document(app: &Obj, format: &str, path: &str, visible: bool) -> Result<Obj, String> {
    let opened = match format {
        "docx" => app.get("Documents").and_then(|documents| documents.call_member("Open", &[Com::from(path)])),
        "xlsx" => {
            let book = app.get("Workbooks").and_then(|books| books.call_member("Open", &[Com::from(path)]));
            if book.is_ok() {
                let _ = app.call("CalculateFullRebuild", &[]);
            }
            book
        }
        "pptx" => app
            .get("Presentations")
            .and_then(|decks| decks.call_member("Open", &[Com::from(path), Com::Bool(false), Com::Bool(false), Com::Bool(visible)])),
        _ => Ok(Com::Null),
    };
    let document = opened.map_err(text)?.into_obj().ok_or_else(|| "Microsoft Office did not answer a document.".to_owned())?;
    if visible {
        set_office_visible(Some(app), &document, format);
    }
    Ok(document)
}

/// What an open has built so far, for the cleanup of a failed one.
struct Work {
    app: Option<Obj>,
    document: Option<Obj>,
    ownership: Ownership,
    shared_background_process: bool,
    owns_application: bool,
    process_id: i32,
    app_start_ticks: i64,
}

/// The request, validated.
struct Request {
    id: String,
    format: String,
    path: String,
    mode: Mode,
    create: bool,
    overwrite: bool,
}

fn parse_request(payload: &Value) -> Result<Request, String> {
    let id = convert::to_ps_string(&payload::property(payload, "session"));
    if id.trim().is_empty() {
        return Err("open_session requires session".to_owned());
    }
    let format = convert::to_ps_string(&payload::property(payload, "format")).to_lowercase();
    if !["docx", "xlsx", "pptx"].contains(&format.as_str()) {
        return Err(format!("Unsupported Office session format: {format}"));
    }
    let path = get_full_path(&convert::to_ps_string(&payload::property(payload, "path")))?;
    let mode = convert::to_ps_string(&payload::property(payload, "mode")).to_lowercase();
    let mode = match mode.as_str() {
        "live" | "attach" => Mode::Attach,
        "visible" => Mode::Visible,
        "background" => Mode::Background,
        other => return Err(format!("Unsupported Office session mode: {other}")),
    };
    let create = convert::to_bool(&payload::property(payload, "create"));
    if create && mode == Mode::Attach {
        return Err("create does not support attach mode".to_owned());
    }
    let overwrite = convert::to_bool(&payload::property(payload, "overwrite"));
    Ok(Request { id, format, path, mode, create, overwrite })
}

fn identity_line(id: &str, owns_application: bool, process_id: i32) -> Value {
    Value::object(
        ObjectKind::Ordered,
        vec![
            ("ok", Value::Bool(true)),
            ("session", Value::string(id)),
            ("ownership", Value::string("owned")),
            ("ownsApplication", Value::Bool(owns_application)),
            ("appPid", Value::Int(process_id)),
            ("lifecycle", Value::string("initializing")),
        ],
    )
}

/// The directory a created document's path needs, made when it does not exist.
fn make_parent<P: WriteProof>(proof: &P, path: &str) -> Result<(), String> {
    let Some(directory) = std::path::Path::new(path).parent().filter(|directory| !directory.as_os_str().is_empty()) else {
        return Ok(());
    };
    mixdog_fsio::create_dir_all(proof, directory)
        .map_err(|error| format!("Exception calling \"CreateDirectory\" with \"1\" argument(s): \"{error}\""))
}

struct Opening<'a, P> {
    proof: &'a P,
    env: Env<'a>,
    out: &'a mut Emitter,
    request: &'a Request,
    foreground_before: i64,
    baseline: &'a [i32],
}

impl<P: WriteProof> Opening<'_, P> {
    fn run(&mut self, work: &mut Work) -> Result<SessionState, String> {
        let env_copy = self.env;
        let env = &env_copy;
        let request = self.request;
        let (format, path, mode) = (request.format.as_str(), request.path.as_str(), request.mode);
        if !request.create && matches!(mode, Mode::Attach | Mode::Visible) {
            work.document = find_running_document_exact(env, format, path)?;
            if let Some(document) = &work.document {
                // The document belongs to the application that already held it: nothing below may close it.
                work.ownership = Ownership::Attached;
                work.app = document.get("Application").map_err(text)?.into_obj();
            } else if mode == Mode::Attach {
                return Err(format!("The exact document is not registered as open in Microsoft Office: {path}"));
            } else if env.platform.file_appears_open(std::path::Path::new(path)) {
                return Err(format!(
                    "The document appears open but its exact COM object is unavailable; refusing to open a duplicate: {path}"
                ));
            }
        }
        if work.document.is_none() {
            self.start_application_and_document(work)?;
        } else if mode == Mode::Visible {
            if let Some(document) = &work.document {
                set_office_visible(work.app.as_ref(), document, format);
            }
        }

        let mut hwnd = application_hwnd(env, work.app.as_ref(), work.document.as_ref(), format);
        if mode == Mode::Visible && format == "pptx" {
            for _ in 0..WINDOW_ATTEMPTS {
                if hwnd != 0 {
                    break;
                }
                env.platform.sleep(WINDOW_PAUSE_MS);
                hwnd = application_hwnd(env, work.app.as_ref(), work.document.as_ref(), format);
            }
        }
        let foreground_activated = mode == Mode::Visible && format == "pptx" && set_office_foreground(env, hwnd);
        work.process_id = window_process_id(env.platform, hwnd);
        if mode == Mode::Background && work.process_id == 0 {
            work.process_id = wait_new_office_process_id(env, format, self.baseline);
        }
        let isolated_process = mode != Mode::Background || (work.process_id > 0 && !self.baseline.contains(&work.process_id));
        if mode == Mode::Background && !isolated_process {
            work.shared_background_process = true;
            return Err(format!(
                "Background Office refused a COM application that reused an existing Office process (pid {}). Close that Office window, or end the process if it is a leftover background instance, then retry.",
                work.process_id
            ));
        }
        Ok(SessionState {
            id: request.id.clone(),
            format: request.format.clone(),
            path: request.path.clone(),
            mode,
            ownership: work.ownership,
            owns_application: work.owns_application,
            app_start_ticks: work.app_start_ticks,
            app: work.app.take(),
            document: work.document.take(),
            visible: mode != Mode::Background,
            app_pid: work.process_id,
            window_hwnd: hwnd,
            foreground_activated,
            foreground_before_action: self.foreground_before,
            isolated_process,
            background_isolation_checks: 0,
            background_hidden_windows: 0,
            background_focus_restorations: 0,
            excel_dpi_repairs: 0,
            pptx_exports: 0,
            document_id: format!("{}:{}", request.format, request.path.to_lowercase()),
            chart_excel: super::ChartExcel::default(),
        })
    }

    /// A new application, identified before anything is opened in it, and the document in it.
    fn start_application_and_document(&mut self, work: &mut Work) -> Result<(), String> {
        let env_copy = self.env;
        let env = &env_copy;
        let request = self.request;
        let (format, path) = (request.format.as_str(), request.path.as_str());
        if request.create {
            if mixdog_fsio::exists(self.proof, path).unwrap_or(false) && !request.overwrite {
                return Err(format!("Office create target already exists: {path}"));
            }
            make_parent(self.proof, path)?;
        } else if !mixdog_fsio::exists(self.proof, path).unwrap_or(false) {
            return Err(format!("Office document not found: {path}"));
        }
        let visible = request.mode == Mode::Visible;
        let prog_id = prog_id_for_format(format).ok_or_else(|| format!("Unsupported Office session format: {format}"))?;
        let app = env.applications.create(prog_id).map_err(text)?;
        let application_hwnd = application_hwnd(env, Some(&app), None, format);
        work.process_id = window_process_id(env.platform, application_hwnd);
        if work.process_id == 0 {
            work.process_id = wait_new_office_process_id(env, format, self.baseline);
        }
        work.owns_application = work.process_id > 0 && !self.baseline.contains(&work.process_id);
        work.shared_background_process = !work.owns_application;
        let process_id = work.process_id;
        let owns = work.owns_application;
        work.app = Some(app.clone());
        if request.mode == Mode::Background && !owns {
            return Err(format!(
                "Background Office refused a shared or unidentified application before opening the document (pid {process_id}). Existing documents were not opened, hidden, or closed."
            ));
        }
        if owns {
            work.app_start_ticks = env.platform.process_start_ticks(process_id);
            initialize_owned_application(&app, format, visible);
        }
        // Ownership is published before a document open can block: a cancellation still lets this host finish its
        // operation and run the end cleanup.
        self.out.line(&identity_line(&request.id, owns, process_id));
        work.document = Some(if request.create {
            create_owned_document(&app, format, path, visible)?
        } else {
            open_owned_document(&app, format, path, visible)?
        });
        Ok(())
    }
}

/// `Open-SessionState`: the state of the opened session, or why it could not be opened (the error already says when the
/// cleanup of what was half-built was incomplete).
pub fn open_session_state<P: WriteProof>(
    proof: &P,
    env: &Env<'_>,
    out: &mut Emitter,
    payload: &Value,
) -> Result<SessionState, String> {
    let request = parse_request(payload)?;
    let foreground_before = env.platform.foreground_window();
    let baseline = env.platform.office_process_ids(&request.format);
    let mut work = Work {
        app: None,
        document: None,
        ownership: Ownership::Owned,
        shared_background_process: false,
        owns_application: false,
        process_id: 0,
        app_start_ticks: 0,
    };
    let opened = Opening { proof, env: *env, out: &mut *out, request: &request, foreground_before, baseline: &baseline }.run(&mut work);
    let mut message = match opened {
        Ok(state) => return Ok(state),
        Err(message) => message,
    };
    let mut leftovers = SessionState::from_leftovers(Leftovers {
        format: request.format.clone(),
        mode: request.mode,
        ownership: work.ownership,
        owns_application: work.owns_application && !work.shared_background_process,
        app_pid: work.process_id,
        app_start_ticks: work.app_start_ticks,
        app: work.app.take(),
        document: work.document.take(),
    });
    let cleanup = close_state(&mut leftovers, env);
    out.cleanup_failure(&cleanup.to_value());
    if !cleanup.ok() {
        message.push_str(&format!("; cleanup incomplete: {}", cleanup.errors.join("; ")));
    }
    Err(message)
}

/// The answer to `open_session`: the common fields (and a background session's isolation report), then what the open
/// says of itself.
pub fn open_session_response(state: &mut SessionState, env: &Env<'_>) -> Result<Value, String> {
    let fields = Value::object(
        ObjectKind::Ordered,
        vec![
            ("opened", Value::Bool(true)),
            ("ownership", Value::string(ownership_text(state.ownership))),
            ("visible", Value::Bool(state.visible)),
            ("appPid", Value::Int(state.app_pid)),
            ("windowHwnd", Value::Long(state.window_hwnd)),
            ("foregroundActivated", Value::Bool(state.foreground_activated)),
            ("documentId", Value::string(&state.document_id)),
            ("path", Value::string(&state.path)),
        ],
    );
    session_response(state, env, &fields)
}
