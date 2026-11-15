//! The Word reader of `office-com-host.ps1`: `Snapshot-Word`, the docx branch of `Snapshot-Selection` and `Issues-Word`,
//! registered as the `docx` [`FormatReader`](crate::format::FormatReader).
//!
//! * [`reading`]: `Word-ReadingContext` and what is read through it (`Word-AcceptedText`, `Word-PageAt`, `Word-InTable`).
//! * [`snapshot`]: `Snapshot-Word`.
//! * [`styles`]: `Word-CanonicalStyleName`.
//! * [`selection`]: `Snapshot-Selection` of a document.
//! * [`issues`]: `Issues-Word`.
//! * [`edit`]: the editor, written by its own task.
//!
//! Every property is read from the document the way the script read it (one COM access per `$x.Y`, in the script's order,
//! each `try { } catch { }` of the script a place where a failure is dropped), so a replay of the PowerShell host's call log
//! is the same sequence. The casts of the script (`[int]`, `[double]`, `[string]`, `[bool]`) are those of PowerShell.

pub(crate) mod edit;
pub use edit::Editor;
mod issues;
mod reading;
mod selection;
mod snapshot;
pub(crate) mod styles;

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::com::errtext;
use crate::format::FormatReader;
use crate::office::Env;
use crate::office::item_of as item;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::datetime;

/// The reader of `docx` documents.
pub struct Reader;

impl FormatReader for Reader {
    fn snapshot(&self, _env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
        snapshot::snapshot_word(document, payload)
    }

    fn issues(&self, env: &Env<'_>, document: &Obj, _payload: &Value) -> Result<Value> {
        issues::issues_word(env, document)
    }

    fn selection(&self, _env: &Env<'_>, document: &Obj) -> Result<Value> {
        selection::snapshot_selection(document)
    }
}

/// A COM value as the PowerShell value a cast of it starts from; an object has none.
fn ps_value(value: &Com, target: &str) -> Result<Value> {
    Ok(match value {
        Com::Null | Com::Empty | Com::Missing => Value::Null,
        Com::Bool(flag) => Value::Bool(*flag),
        Com::I1(number) => Value::Int(i32::from(*number)),
        Com::I2(number) => Value::Int(i32::from(*number)),
        Com::UI1(number) => Value::Int(i32::from(*number)),
        Com::UI2(number) => Value::Int(i32::from(*number)),
        Com::I4(number) => Value::Int(*number),
        Com::UI4(number) => i32::try_from(*number).map_or(Value::Long(i64::from(*number)), Value::Int),
        Com::I8(number) => Value::Long(*number),
        Com::UI8(number) => i64::try_from(*number).map_or(Value::Double(*number as f64), Value::Long),
        Com::R4(number) => Value::Single(*number),
        Com::R8(number) => Value::Double(*number),
        Com::Error(code) => Value::Int(*code),
        Com::Str(text) => Value::String(text.clone()),
        Com::Currency(amount) => Value::Decimal(crate::ps::Decimal { negative: *amount < 0, mantissa: u128::from(amount.unsigned_abs()), scale: 4 }),
        Com::Decimal(number) => Value::Decimal(crate::ps::Decimal {
            negative: number.negative,
            mantissa: (u128::from(number.hi32) << 64) | u128::from(number.lo64),
            scale: number.scale,
        }),
        Com::Date(days) => Value::DateTime(crate::ps::DateTimeValue {
            ticks: datetime::oa_date_to_ticks(*days).map_err(Error::host)?,
            kind: crate::ps::DateKind::Unspecified,
        }),
        Com::Dispatch(_) | Com::Unknown(_) | Com::Array(_) => {
            return Err(Error::host(format!(
                "Cannot convert the \"{0}\" value of type \"{0}\" to type \"{target}\".",
                value.dotnet_type_name()
            )));
        }
    })
}

/// `[int]$value`.
fn int(value: &Com) -> Result<i32> {
    convert::to_int(&ps_value(value, "System.Int32")?).map_err(Error::host)
}

/// `[int64]$value`.
fn long(value: &Com) -> Result<i64> {
    convert::to_int64(&ps_value(value, "System.Int64")?).map_err(Error::host)
}

/// `[double]$value`.
fn double(value: &Com) -> Result<f64> {
    convert::to_double(&ps_value(value, "System.Double")?).map_err(Error::host)
}

/// `[single]$value`.
fn single(value: &Com) -> Result<f32> {
    convert::to_single(&ps_value(value, "System.Single")?).map_err(Error::host)
}

/// `[bool]$value`.
fn truth(value: &Com) -> bool {
    crate::actions::truth_of(value)
}

/// `[string]$value`: an object is its type name.
fn string(value: &Com) -> String {
    match value {
        Com::Dispatch(_) | Com::Unknown(_) => "System.__ComObject".to_owned(),
        other => crate::office::text_of(other),
    }
}

/// `([string]$text).TrimEnd("`r", "`a")`, the text of a range as the script reads it.
fn range_text(range: &Com) -> Result<String> {
    Ok(crate::ps::text::trim_end_cr_bel(&string(&range.member("Text")?)))
}

/// `$value.Name(args)` where `Name` is a parameterized property (`Item(n)`, `Information(12)`): a read with arguments.
fn indexed(value: &Com, name: &str, args: &[Com]) -> Result<Com> {
    match value.as_obj() {
        Some(object) => object.get_with(name, args),
        None => Err(errtext::null_method_call()),
    }
}

/// `[int]$collection.Count`.
fn count(collection: &Com) -> Result<i32> {
    int(&collection.member("Count")?)
}

/// `$null -ne $value`: a COM answer that is an object.
fn is_object(value: &Com) -> bool {
    value.as_obj().is_some()
}

/// `$document.Range($start, $end)`.
fn document_range(document: &Obj, start: i32, end: i32) -> Result<Com> {
    document.call("Range", &[Com::I4(start), Com::I4(end)])
}

/// `@($value)`: the items of a collection, or the one value that is not one.
fn items_of(value: &Com) -> Result<Vec<Com>> {
    crate::actions::document::items_of(value)
}

/// `[Math]::Max(1, [int]$document.Range(0, $head).Paragraphs.Count)`: the ordinal of the paragraph a range ends in.
fn paragraph_ordinal(document: &Obj, head: i32) -> Result<i32> {
    Ok(count(&document_range(document, 0, head)?.member("Paragraphs")?)?.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cast_of_a_com_value_is_powershells() {
        assert_eq!(int(&Com::R8(2.5)), Ok(2));
        assert_eq!(int(&Com::Null), Ok(0));
        assert_eq!(int(&Com::Str("12".to_owned())), Ok(12));
        assert_eq!(double(&Com::R4(1.5)), Ok(1.5));
        assert_eq!(string(&Com::Bool(true)), "True");
        assert!(truth(&Com::Bool(true)) && !truth(&Com::I4(0)));
    }
}
