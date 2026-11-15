//! The PowerPoint reader: `Snapshot-PowerPoint`, the pptx branch of `Snapshot-Selection` and `Issues-PowerPoint` of
//! `office-com-host.ps1`, registered as the `pptx` [`FormatReader`].
//!
//! * [`snapshot`]: `PowerPoint-NotesText` and `Snapshot-PowerPoint`.
//! * [`selection`]: what the user has selected in the deck's window.
//! * [`ink`]: `Ole-ColorChannel`, `Color-Luminance`, `Color-ContrastRatio` and `Ink-Luminance`.
//! * [`issues`]: `Issues-PowerPoint`.
//! * [`edit`]: the editor's place (`nr-office-comrs-ppt-edit`).
//!
//! The reads happen in the order and the number the script makes them (every dotted step of a PowerShell chain is a call
//! into PowerPoint, and the replayed call logs hold the port to that), each inside the failure the script tolerates and
//! nowhere else. The casts below are PowerShell's: `$null` is `0` and `''`, a COM boolean of -1 is true.

pub(crate) mod edit;
pub mod ink;
pub mod issues;
pub mod selection;
pub mod snapshot;

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::format::FormatReader;
use crate::office::Env;
use crate::office::long_of;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;

/// The reader of `.pptx` documents.
pub struct Reader;

impl FormatReader for Reader {
    fn snapshot(&self, _env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
        snapshot::snapshot_powerpoint(document, payload)
    }

    fn issues(&self, env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
        issues::issues_powerpoint(env, document, payload)
    }

    fn selection(&self, _env: &Env<'_>, document: &Obj) -> Result<Value> {
        selection::snapshot_selection(document)
    }
}

/// `[ordered]@{ ... }`.
pub(crate) fn ordered(pairs: Vec<(&str, Value)>) -> Value {
    Value::object(ObjectKind::Ordered, pairs)
}

/// `$(try { <read> } catch { $null })`.
pub(crate) fn or_null(read: Result<Value>) -> Value {
    read.unwrap_or(Value::Null)
}

/// `[bool]$value` (an object is true, `$null` false, a COM boolean of -1 true).
pub(crate) fn truth(value: &Com) -> bool {
    crate::actions::truth_of(value)
}

fn cannot_convert(value: &Com, target: &str) -> Error {
    let type_name = value.dotnet_type_name();
    Error::host(format!("Cannot convert the \"{type_name}\" value of type \"{type_name}\" to type \"{target}\"."))
}

/// `[double]$value`.
pub(crate) fn double_of(value: &Com) -> Result<f64> {
    match value {
        Com::Null | Com::Empty => Ok(0.0),
        Com::Bool(flag) => Ok(f64::from(u8::from(*flag))),
        Com::Str(text) => convert::to_double(&Value::string(text)).map_err(Error::host),
        Com::Dispatch(_) | Com::Unknown(_) | Com::Array(_) | Com::Missing | Com::Error(_) | Com::Date(_) => Err(cannot_convert(value, "System.Double")),
        other => other.as_f64().ok_or_else(|| cannot_convert(other, "System.Double")),
    }
}

/// `[single]$value`.
pub(crate) fn single_of(value: &Com) -> Result<f32> {
    match value {
        Com::Str(text) => convert::to_single(&Value::string(text)).map_err(Error::host),
        Com::R4(number) => Ok(*number),
        Com::Dispatch(_) | Com::Unknown(_) | Com::Array(_) | Com::Missing | Com::Error(_) | Com::Date(_) => Err(cannot_convert(value, "System.Single")),
        other => double_of(other).map(|number| number as f32),
    }
}

/// `[int64]$value`.
pub(crate) fn long_cast(value: &Com) -> Result<i64> {
    long_of(value).ok_or_else(|| cannot_convert(value, "System.Int64"))
}

/// `[int]$value`.
pub(crate) fn int_of(value: &Com) -> Result<i32> {
    long_of(value).and_then(|number| i32::try_from(number).ok()).ok_or_else(|| cannot_convert(value, "System.Int32"))
}

/// `$collection.Count` of a COM value (`$null` is none).
pub(crate) fn count_of(collection: &Com) -> Result<i64> {
    long_cast(&collection.member("Count")?)
}

/// `[string]$value`.
pub(crate) fn string_of(value: &Com) -> String {
    crate::office::text_of(value)
}

/// `$text -match '\S'`: the text holds something that is not white space.
pub(crate) fn has_ink(text: &str) -> bool {
    text.chars().any(|c| !c.is_whitespace())
}

/// The pointer of a document as a COM value, so a chain walks it as the script's `$presentation.A.B` does.
pub(crate) fn as_value(document: &Obj) -> Com {
    Com::Dispatch(document.clone())
}
