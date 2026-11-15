//! The docx branch of `Snapshot-Selection`: what the user has selected in the document's window.

use crate::com::Obj;
use crate::com::Result;
use crate::format::same_office_path;
use crate::ps::ObjectKind;
use crate::ps::Value;

const OTHER_DOCUMENT: &str = "The active Word selection belongs to another document.";

fn unavailable(reason: &str) -> Value {
    Value::object(ObjectKind::Ordered, vec![("available", Value::Bool(false)), ("reason", Value::string(reason))])
}

/// The selection of the document, as an insertion point or as text, with the paragraph it starts in as its target. A selection
/// that belongs to another document is unavailable. A failure is the caller's: the selection is then unavailable with the
/// failure as its reason.
pub(super) fn snapshot_selection(document: &Obj) -> Result<Value> {
    let selection = document.get("Application")?.member("Selection")?;
    if !super::is_object(&selection) {
        return Ok(unavailable(OTHER_DOCUMENT));
    }
    let selection_name = super::string(&selection.member("Document")?.member("FullName")?);
    let document_name = super::string(&document.get("FullName")?);
    if !same_office_path(&selection_name, &document_name) {
        return Ok(unavailable(OTHER_DOCUMENT));
    }
    let range = selection.member("Range")?;
    let paragraph = super::paragraph_ordinal(document, super::int(&range.member("Start")?)?.max(0))?;
    let target = format!("/body/p[{paragraph}]");
    let kind = if super::int(&range.member("Start")?)? == super::int(&range.member("End")?)? { "insertion-point" } else { "text" };
    let key = format!("{target}:{}-{}", super::int(&range.member("Start")?)?, super::int(&range.member("End")?)?);
    let start = super::int(&range.member("Start")?)?;
    let end = super::int(&range.member("End")?)?;
    let text = super::range_text(&range)?;
    Ok(Value::object(
        ObjectKind::Ordered,
        vec![
            ("available", Value::Bool(true)),
            ("kind", Value::string(kind)),
            ("target", Value::String(target)),
            ("key", Value::String(key)),
            ("start", Value::Int(start)),
            ("end", Value::Int(end)),
            ("text", Value::String(text)),
        ],
    ))
}
