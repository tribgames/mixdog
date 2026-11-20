//! The actions of the Office hosts that sit between the request loop and the code of each application: what one-shot
//! requests do (`detect`, `snapshot`, `issues`, `validate`, `checkpoint`, `batch`, `rollback`, `save`, `render`), what a
//! session does with an open document (those, and `save_copy`, `reload_document`, `replace_presentation_from_source`,
//! `post_save_validate`), and the pieces they are built from.
//!
//! * [`oneshot_entry`]: the one-shot host's body (`office-com-host.ps1`'s `try` and `finally`).
//! * [`session_actions`]: `Invoke-SessionAction`.
//! * [`apply`]: `Apply-Operations`, the transaction around a batch.
//! * [`document`]: `Save-DocumentCopy`, `Restore-ExcelCheckpoint`, `Rollback-LiveDocument`, `Render-Document`.
//! * [`preview`]: the read-only open of the file preview and `Validate-NativeDocument`.
//! * [`reopen`]: closing and reopening a background session's document, and `Reload-SessionDocument`.
//! * [`import`]: `replace_presentation_from_source`.
//! * [`dpi`]: `Repair-ExcelPageSetupDpi`.
//!
//! [`one_shot_handler`] and [`session_handler`] are the two handlers `host::handlers::registered` hands the host.

pub mod apply;
pub mod document;
pub mod dpi;
pub mod import;
pub mod oneshot_entry;
pub mod preview;
pub mod reopen;
pub mod session_actions;

use std::io;

use mixdog_fsio::WriteProof;

pub use oneshot_entry::OneShotEntry;
pub use session_actions::SessionActions;

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::com::errtext;
use crate::drivers::Drivers;
use crate::format;
use crate::host::Closed;
use crate::host::Emitter;
use crate::host::HostEnv;
use crate::host::OneShotHandler;
use crate::host::SessionHandler;
use crate::office::Applications;
use crate::office::Env;
use crate::platform::Platform;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::fingerprint::snapshot_fingerprint;

/// What the actions run against: the host's world, the proof that file work runs on a lane, and the formats' readers and
/// editors.
pub struct Actions<'a, P: WriteProof> {
    pub env: Env<'a>,
    pub proof: &'a P,
    pub drivers: Drivers<'a>,
}

impl<P: WriteProof> Actions<'_, P> {
    /// `Snapshot-Document`.
    pub fn snapshot(&self, document: &Obj, format: &str, payload: &Value) -> Result<Value> {
        format::snapshot_document(&self.drivers, &self.env, document, format, payload)
    }

    /// `Issues-Document`.
    pub fn issues(&self, document: &Obj, format: &str, payload: Option<&Value>) -> Result<Value> {
        format::issues_document(&self.drivers, &self.env, document, format, payload)
    }

    /// `Snapshot-Fingerprint (Snapshot-Document $document $format ([ordered]@{}))`.
    pub fn fingerprint_of(&self, document: &Obj, format: &str) -> Result<String> {
        Ok(snapshot_fingerprint(&self.snapshot(document, format, &empty_payload())?))
    }
}

/// `[ordered]@{}`.
pub(crate) fn empty_payload() -> Value {
    Value::object(ObjectKind::Ordered, Vec::new())
}

/// `[ordered]@{ ok = $false; errors = @("<message>") }`: the record `Write-OfficeCleanupFailure` takes for a cleanup step
/// that failed.
pub(crate) fn failed_cleanup(message: &str) -> Value {
    Value::object(ObjectKind::Ordered, vec![("ok", Value::Bool(false)), ("errors", Value::Array(vec![Value::string(message)]))])
}

/// The message of a failure, as `$_.Exception.Message` has it.
pub(crate) fn text(error: Error) -> String {
    error.message().to_owned()
}

/// `[bool]$value` of a COM value.
pub(crate) fn truth_of(value: &Com) -> bool {
    match value {
        Com::Null | Com::Empty | Com::Missing => false,
        Com::Bool(flag) => *flag,
        Com::Str(text) => !text.is_empty(),
        Com::R4(number) => *number != 0.0,
        Com::R8(number) | Com::Date(number) => *number != 0.0,
        Com::Currency(amount) => *amount != 0,
        Com::Error(_) | Com::Dispatch(_) | Com::Unknown(_) | Com::Array(_) => true,
        other => other.as_i64().is_none_or(|number| number != 0),
    }
}

/// `[bool]$document.Saved`.
pub(crate) fn saved(document: &Obj) -> Result<bool> {
    Ok(truth_of(&document.get("Saved")?))
}

/// `if ($wasSaved -and -not [bool]$document.Saved) { $document.Saved = $true }`: a read that touched the document does not
/// leave it looking edited.
pub(crate) fn restore_saved(document: &Obj, was_saved: bool) -> Result<()> {
    if was_saved && !saved(document)? {
        document.put("Saved", Com::Bool(true))?;
    }
    Ok(())
}

/// `$null.Member(...)`: what a missing application or document answers to a call.
pub(crate) fn null_call() -> Error {
    errtext::null_method_call()
}

/// Where a failure was raised, as the text of a failed operation names it: the source file and line of the Rust port (the
/// location of the PowerShell script it replaces no longer exists).
pub(crate) fn location(file: &str, line: u32) -> String {
    let name = file.rsplit(['/', '\\']).next().unwrap_or(file);
    format!("{name}:{line}")
}

/// `[System.IO.Path]::GetExtension`: the extension with its dot, empty for a name without one.
pub(crate) fn path_extension(path: &str) -> &str {
    let name_start = path.rfind(['\\', '/', ':']).map_or(0, |at| at + 1);
    let name = &path[name_start..];
    match name.rfind('.') {
        Some(at) if at + 1 < name.len() => &name[at..],
        _ => "",
    }
}

/// The text a .NET file call raises for an I/O failure of `path`, inside PowerShell's wrapper for a method call.
pub(crate) fn file_error(call: &str, arguments: u32, path: &str, error: &io::Error) -> String {
    let reason = match (error.kind(), error.raw_os_error()) {
        (io::ErrorKind::NotFound, Some(3)) => format!("Could not find a part of the path '{path}'."),
        (io::ErrorKind::NotFound, _) => format!("Could not find file '{path}'."),
        (io::ErrorKind::PermissionDenied, _) => format!("Access to the path '{path}' is denied."),
        (_, Some(32)) => format!("The process cannot access the file '{path}' because it is being used by another process."),
        _ => error.to_string(),
    };
    format!("Exception calling \"{call}\" with \"{arguments}\" argument(s): \"{reason}\"")
}

impl<P: WriteProof> Actions<'_, P> {
    /// `[System.IO.File]::Copy($from, $to, $true)` of two paths made absolute first.
    pub(crate) fn copy_over(&self, from: &str, to: &str) -> std::result::Result<(), String> {
        let from = crate::office::get_full_path(from)?;
        let to = crate::office::get_full_path(to)?;
        mixdog_fsio::copy(self.proof, &from, &to).map(|_| ()).map_err(|error| file_error("Copy", 3, &from, &error))
    }

    /// `Test-Path -LiteralPath $path`.
    pub(crate) fn exists(&self, path: &str) -> bool {
        mixdog_fsio::exists(self.proof, path).unwrap_or(false)
    }

    /// `Remove-Item $path -Force -ErrorAction SilentlyContinue`.
    pub(crate) fn remove_quietly(&self, path: &str) {
        let _ = mixdog_fsio::remove_file(self.proof, path);
    }

    /// `Join-Path ([System.IO.Path]::GetTempPath()) "<prefix>-<guid N><extension>"`: a name in the temporary directory
    /// that nothing else uses.
    pub(crate) fn temporary_name(&self, prefix: &str, extension: &str) -> String {
        let name = format!("{prefix}-{}{extension}", self.env.platform.new_guid_n());
        self.env.platform.temp_dir().join(name).to_string_lossy().into_owned()
    }
}

/// The handler of an operation when the platform layer could not start: every request is answered with the reason.
struct Unavailable(String);

impl OneShotHandler for Unavailable {
    fn handle(&mut self, _out: &mut Emitter, _payload: &Value) -> std::result::Result<Value, String> {
        Err(self.0.clone())
    }

    fn finish(&mut self, _out: &mut Emitter) {}
}

impl SessionHandler for Unavailable {
    fn session_id(&self) -> Option<String> {
        None
    }

    fn app_pid(&self) -> Value {
        Value::Null
    }

    fn open(&mut self, _out: &mut Emitter, _payload: &Value) -> std::result::Result<Value, String> {
        Err(self.0.clone())
    }

    fn record_foreground(&mut self) {}

    fn action(&mut self, _out: &mut Emitter, _payload: &Value) -> std::result::Result<Value, String> {
        Err(self.0.clone())
    }

    fn close(&mut self, _out: &mut Emitter, _payload: &Value) -> std::result::Result<Closed, String> {
        Err(self.0.clone())
    }

    fn end(&mut self) -> std::result::Result<Value, String> {
        Ok(Value::Null)
    }
}

type World = (Box<dyn Platform>, Box<dyn Applications>);

/// The real platform layer and the real applications.
fn world() -> std::result::Result<World, String> {
    #[cfg(windows)]
    {
        let platform = crate::platform::WindowsPlatform::new().map_err(|error| format!("The Windows platform layer could not start: {error}"))?;
        Ok((Box::new(platform), Box::new(crate::office::LiveApplications)))
    }
    #[cfg(not(windows))]
    {
        Err("Microsoft Office COM is available on Windows only".to_owned())
    }
}

/// The one-shot host's handler, on the real world.
pub fn one_shot_handler(host: HostEnv<'_>) -> Box<dyn OneShotHandler + '_> {
    match world() {
        Ok((platform, applications)) => Box::new(OneShotEntry::new(host.lane(), platform, applications, Drivers::registered())),
        Err(reason) => Box::new(Unavailable(reason)),
    }
}

/// The session host's handler, on the real world.
pub fn session_handler(host: HostEnv<'_>) -> Box<dyn SessionHandler + '_> {
    match world() {
        Ok((platform, applications)) => Box::new(SessionActions::new(host.lane(), platform, applications, Drivers::registered())),
        Err(reason) => Box::new(Unavailable(reason)),
    }
}
