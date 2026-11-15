//! The Office applications and their documents (`office-com-host.ps1` lines 11-121 and `Save-Document`, `office-com-cleanup.ps1`'s
//! document helpers): which ProgID and save format a document kind has, the collections, finding a document an
//! application holds, starting an application that is not shown, opening a document in it, saving, closing, and counting.
//!
//! How an application is obtained is behind [`Applications`] (`New-Object -ComObject`, `Marshal.GetActiveObject` and the
//! object the running object table answers), as the Win32 layer is behind [`Platform`], so the lifecycle in
//! [`crate::state`] runs against a replayed call log and a scripted platform in the tests. Every property the hosts set with
//! its failure ignored is set here with its failure ignored.

use std::time::Duration;

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value;
use crate::com::errtext;
use crate::com::retry::Pause;
use crate::platform::Platform;
use crate::platform::RunningObject;
use crate::platform::full_path;
use crate::ps::convert;

/// How the host gets hold of an Office application.
pub trait Applications {
    /// `New-Object -ComObject <ProgId>`: a new application (a new process, unless Office hands out a shared one).
    fn create(&self, prog_id: &str) -> Result<Obj>;

    /// `Active-Application`: the running application of the class, `None` when there is none or it cannot be reached.
    fn active(&self, prog_id: &str) -> Option<Obj>;

    /// The object the running object table answered, as a handle; `None` when it is not a dispatch object.
    fn running(&self, object: RunningObject) -> Option<Obj>;
}

/// What the session code runs against: the Win32 layer and the way to get applications.
#[derive(Clone, Copy)]
pub struct Env<'a> {
    pub platform: &'a dyn Platform,
    pub applications: &'a dyn Applications,
}

impl Pause for Env<'_> {
    fn pause(&self, duration: Duration) {
        self.platform.sleep(u32::try_from(duration.as_millis()).unwrap_or(u32::MAX));
    }
}

/// The real applications: COM on this thread's apartment.
#[cfg(windows)]
pub struct LiveApplications;

#[cfg(windows)]
impl Applications for LiveApplications {
    fn create(&self, prog_id: &str) -> Result<Obj> {
        crate::com::live::create_object(prog_id).map_err(Error::Com)
    }

    fn active(&self, prog_id: &str) -> Option<Obj> {
        crate::com::live::active_object(prog_id).ok()
    }

    fn running(&self, object: RunningObject) -> Option<Obj> {
        use windows::Win32::System::Com::IDispatch;
        use windows::core::IUnknown;
        use windows::core::Interface;
        let unknown = object.downcast::<IUnknown>().ok()?;
        let dispatch: IDispatch = unknown.cast().ok()?;
        // SAFETY: `dispatch` is a valid IDispatch for the whole call; the handle adds a reference of its own.
        unsafe { crate::com::live::LiveObject::from_dispatch(dispatch.as_raw()) }
    }
}

/// Applications a test scripts: what `create` answers in order, which application is running, and which object each
/// label of the scripted platform's running object table stands for.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
pub struct ScriptedApplications {
    created: std::cell::RefCell<Vec<ScriptedCreation>>,
    active: std::cell::RefCell<Vec<(String, Obj)>>,
    running: std::cell::RefCell<Vec<(String, Obj)>>,
}

/// One creation a test scripts: its answer, and what happens in the world when it is asked for (a new process appears).
#[cfg(any(test, feature = "test-support"))]
struct ScriptedCreation {
    prog_id: String,
    outcome: Result<Obj>,
    then: Option<Box<dyn FnOnce()>>,
}

#[cfg(any(test, feature = "test-support"))]
impl ScriptedApplications {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the next `create` of this ProgID answers.
    pub fn queue_create(&self, prog_id: &str, outcome: Result<Obj>) {
        self.created.borrow_mut().push(ScriptedCreation { prog_id: prog_id.to_owned(), outcome, then: None });
    }

    /// Like [`ScriptedApplications::queue_create`], and `then` runs when the creation is asked for (the new process and
    /// its windows are put into the scripted platform).
    pub fn queue_create_then(&self, prog_id: &str, outcome: Result<Obj>, then: impl FnOnce() + 'static) {
        self.created.borrow_mut().push(ScriptedCreation { prog_id: prog_id.to_owned(), outcome, then: Some(Box::new(then)) });
    }

    /// The running application of a class.
    pub fn set_active(&self, prog_id: &str, application: Obj) {
        self.active.borrow_mut().push((prog_id.to_owned(), application));
    }

    /// The object `FakePlatform::add_running_file(display_name, label)` stands for.
    pub fn add_running(&self, label: &str, object: Obj) {
        self.running.borrow_mut().push((label.to_owned(), object));
    }

    /// How many scripted creations were not asked for.
    pub fn creations_left(&self) -> usize {
        self.created.borrow().len()
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Applications for ScriptedApplications {
    fn create(&self, prog_id: &str) -> Result<Obj> {
        let creation = {
            let mut created = self.created.borrow_mut();
            created.iter().position(|creation| creation.prog_id == prog_id).map(|at| created.remove(at))
        };
        match creation {
            Some(ScriptedCreation { outcome, then, .. }) => {
                if let Some(then) = then {
                    then();
                }
                outcome
            }
            None => Err(Error::host(format!("No application is scripted for {prog_id}"))),
        }
    }

    fn active(&self, prog_id: &str) -> Option<Obj> {
        self.active.borrow().iter().find(|(id, _)| id == prog_id).map(|(_, application)| application.clone())
    }

    fn running(&self, object: RunningObject) -> Option<Obj> {
        let label = object.downcast::<String>().ok()?;
        self.running.borrow().iter().find(|(known, _)| *known == label).map(|(_, found)| found.clone())
    }
}

/// `ProgId-ForFormat`.
pub fn prog_id_for_format(format: &str) -> Option<&'static str> {
    match format.to_lowercase().as_str() {
        "docx" => Some("Word.Application"),
        "xlsx" => Some("Excel.Application"),
        "pptx" => Some("PowerPoint.Application"),
        _ => None,
    }
}

/// `[System.IO.Path]::GetExtension`, then `TrimStart('.')` and `ToLowerInvariant()`.
fn extension_of(path: &str) -> String {
    let name_start = path.rfind(['\\', '/', ':']).map_or(0, |at| at + 1);
    let name = &path[name_start..];
    match name.rfind('.') {
        Some(at) if at + 1 < name.len() => name[at..].trim_start_matches('.').to_lowercase(),
        _ => String::new(),
    }
}

/// `Office-SaveFormatForPath`: the file format constant of the extension; `None` for a format that is not an Office one.
pub fn save_format_for_path(format: &str, path: &str) -> Option<i32> {
    let extension = extension_of(path);
    let extension = extension.as_str();
    match format {
        "docx" => Some(match extension {
            "docm" => 13,
            "dotx" => 14,
            "dotm" => 15,
            _ => 16,
        }),
        "xlsx" => Some(match extension {
            "xlsm" => 52,
            "xltm" => 53,
            "xltx" => 54,
            _ => 51,
        }),
        "pptx" => Some(match extension {
            "pptm" => 25,
            "potx" => 26,
            "potm" => 27,
            _ => 24,
        }),
        _ => None,
    }
}

/// `[System.IO.Path]::GetFullPath($path)` with the exception PowerShell shows for a path it refuses.
pub fn get_full_path(path: &str) -> std::result::Result<String, String> {
    full_path(path).ok_or_else(|| {
        let reason = if path.contains('\0') { "Illegal characters in path." } else { "The path is not of a legal form." };
        format!("Exception calling \"GetFullPath\" with \"1\" argument(s): \"{reason}\"")
    })
}

/// `[System.IO.Path]::GetFileName`.
pub fn file_name(path: &str) -> &str {
    path.rfind(['\\', '/', ':']).map_or(path, |at| &path[at + 1..])
}

/// `[string]$value` of a COM property: `$null` is the empty string.
pub fn text_of(value: &Value) -> String {
    match value {
        Value::Null | Value::Empty => String::new(),
        Value::Str(text) => text.clone(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        Value::R4(number) => convert::format_single(*number),
        Value::R8(number) => convert::format_double(*number),
        other => other.as_i64().map(|number| number.to_string()).unwrap_or_default(),
    }
}

/// `[long]$value`: `None` where the cast would throw.
pub fn long_of(value: &Value) -> Option<i64> {
    match value {
        Value::Null | Value::Empty => Some(0),
        Value::Bool(flag) => Some(i64::from(*flag)),
        Value::Str(text) => text.trim().parse().ok(),
        Value::R4(_) | Value::R8(_) => {
            let number = value.as_f64()?;
            let rounded = convert::round_half_even(number);
            (rounded.is_finite() && rounded.abs() < 9.2e18).then_some(rounded as i64)
        }
        other => other.as_i64(),
    }
}

/// `$value.Item(index)` of a collection or a style list: a parameterized property read; `$null` has no method to call.
pub fn item_of(value: &Value, index: i32) -> Result<Value> {
    match value.as_obj() {
        Some(collection) => collection.get_with("Item", &[Value::I4(index)]),
        None => Err(errtext::null_method_call()),
    }
}

/// `Set-OfficeVisible`: the application, and the document's window where the format has one, each with its failure
/// ignored.
pub fn set_office_visible(app: Option<&Obj>, document: &Obj, format: &str) {
    if let Some(app) = app {
        let _ = app.put("Visible", Value::Bool(true));
    }
    let window = |value: Result<Value>| {
        let _ = value.and_then(|window| window.set_member("Visible", Value::Bool(true)));
    };
    match format {
        "docx" => window(document.get("ActiveWindow")),
        "xlsx" => window(document.get("Windows").and_then(|windows| item_of(&windows, 1))),
        _ => {}
    }
}

/// `Collection-For`: the application's documents, workbooks or presentations (`$null` for another format).
pub fn collection_for(app: &Obj, format: &str) -> Result<Value> {
    match format {
        "docx" => app.get("Documents"),
        "xlsx" => app.get("Workbooks"),
        "pptx" => app.get("Presentations"),
        _ => Ok(Value::Null),
    }
}

/// Whether the document's `FullName` is `path`, ignoring case (`Same-DocumentPath`, a failure is not the same).
pub fn same_document_path(document: &Obj, path: &str) -> bool {
    let compare = || -> Result<bool> {
        let name = text_of(&document.get("FullName")?);
        let theirs = get_full_path(&name).map_err(Error::host)?;
        let ours = get_full_path(path).map_err(Error::host)?;
        Ok(theirs.to_uppercase() == ours.to_uppercase())
    };
    compare().unwrap_or(false)
}

/// `Find-OpenDocument`: the document of the application whose full path is `path`, ignoring case; a document that
/// cannot be read is skipped.
pub fn find_open_document(app: &Obj, format: &str, path: &str) -> Result<Option<Obj>> {
    let full = get_full_path(path).map_err(Error::host)?;
    let items = match collection_for(app, format)?.as_obj() {
        Some(collection) => collection.items()?,
        None => Vec::new(),
    };
    for item in items {
        let Some(document) = item.as_obj() else { continue };
        let matches = || -> Result<bool> {
            let name = text_of(&document.get("FullName")?);
            Ok(get_full_path(&name).map_err(Error::host)?.to_uppercase() == full.to_uppercase())
        };
        if matches().unwrap_or(false) {
            return Ok(Some(document.clone()));
        }
    }
    Ok(None)
}

/// `Active-Application`.
pub fn active_application(env: &Env<'_>, prog_id: Option<&str>) -> Option<Obj> {
    prog_id.and_then(|prog_id| env.applications.active(prog_id))
}

/// `$app.DisplayAlerts = 0`, `$app.AutomationSecurity = 3` (macros never run) and, but for PowerPoint, `$app.Visible`,
/// each with its failure ignored.
pub fn initialize_owned_application(app: &Obj, format: &str, visible: bool) {
    // PowerPoint's alert level is `ppAlertsNone` (1) or `ppAlertsAll` (2): the 0 the other applications take for "none" is not one
    // of them (Windows PowerShell's binding to the interop assembly refused it and the failure was ignored, so the level stayed
    // at the default, none), and through `IDispatch` PowerPoint takes it as "all", which asks "save your changes?" on closing an
    // edited deck: that dialog, in a hidden window, blocks the application for good.
    let _ = app.put("DisplayAlerts", Value::I4(if format == "pptx" { 1 } else { 0 }));
    let _ = app.put("AutomationSecurity", Value::I4(3));
    if format != "pptx" {
        let _ = app.put("Visible", Value::Bool(visible));
    }
}

/// `New-HiddenApplication`: a new application that is certainly this host's own process, or none.
pub fn new_hidden_application(env: &Env<'_>, format: &str, prog_id: &str) -> Result<Obj> {
    let baseline = env.platform.office_process_ids(format);
    let app = env.applications.create(prog_id)?;
    let new_processes = env.platform.office_process_ids(format).into_iter().filter(|id| !baseline.contains(id)).count();
    if new_processes != 1 {
        drop(app);
        return Err(Error::host("Background Office refused a shared or unidentified application before opening the document."));
    }
    initialize_owned_application(&app, format, false);
    Ok(app)
}

fn document_of(value: Value) -> Result<Obj> {
    value.into_obj().ok_or_else(|| Error::host("Microsoft Office did not answer a document."))
}

/// `Open-BackgroundDocument`.
pub fn open_background_document(app: &Obj, format: &str, path: &str) -> Result<Obj> {
    match format {
        "docx" => document_of(app.get("Documents").and_then(|documents| documents.call_member("Open", &[Value::from(path)]))?),
        "xlsx" => {
            let book = document_of(app.get("Workbooks").and_then(|books| books.call_member("Open", &[Value::from(path)]))?)?;
            let _ = app.call("CalculateFullRebuild", &[]);
            Ok(book)
        }
        "pptx" => {
            let arguments = [Value::from(path), Value::Bool(false), Value::Bool(false), Value::Bool(false)];
            document_of(app.get("Presentations").and_then(|decks| decks.call_member("Open", &arguments))?)
        }
        other => Err(Error::host(format!("Unsupported Office format: {other}"))),
    }
}

/// `Save-Document`: Excel recalculates in full and Word rebuilds its tables of contents first, each ignoring failure.
pub fn save_document(document: Option<&Obj>, format: &str) -> Result<()> {
    let value = document.map_or(Value::Null, |document| Value::Dispatch(document.clone()));
    if format == "xlsx" {
        let _ = value.member("Application").and_then(|app| app.call_member("CalculateFullRebuild", &[]));
    }
    if format == "docx" {
        let update = || -> Result<()> {
            let tables = value.member("TablesOfContents")?;
            let items = match tables.as_obj() {
                Some(collection) => collection.items()?,
                None => vec![tables.clone()],
            };
            for toc in items {
                let _ = toc.call_member("Update", &[]);
            }
            Ok(())
        };
        let _ = update();
    }
    value.call_member("Save", &[]).map(|_| ())
}

/// `Close-OfficeDocument`: pptx `Close()`, docx `Close(0)`, xlsx `Close(false)`.
pub fn close_office_document(document: &Obj, format: &str) -> Result<()> {
    let closed = match format {
        "pptx" => document.call("Close", &[]),
        "docx" => document.call("Close", &[Value::I4(0)]),
        "xlsx" => document.call("Close", &[Value::Bool(false)]),
        other => return Err(Error::host(format!("Unsupported Office close format: {other}"))),
    };
    closed.map(|_| ())
}

/// `Office-DocumentCount`: the size of the application's collection; its handle is dropped before this answers.
pub fn office_document_count(app: &Obj, format: &str) -> Result<i64> {
    let collection = match format {
        "docx" => app.get("Documents")?,
        "xlsx" => app.get("Workbooks")?,
        "pptx" => app.get("Presentations")?,
        other => return Err(Error::host(format!("Unsupported Office collection: {other}"))),
    };
    match collection.as_obj() {
        Some(collection) => collection.count(),
        None => Ok(0),
    }
}
