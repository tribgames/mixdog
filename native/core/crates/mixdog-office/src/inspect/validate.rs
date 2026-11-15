//! `validate` (`core/office-actions-inspect.mjs`): whether a session's document is sound.
//!
//! The package check of the backend (the OOXML package, the PDF parse, the delimited file's shape), the OOXML schema check
//! (on a copy when Microsoft Office holds the file open), the assertions of a workbook, the LibreOffice reopen when the call
//! asks for compatibility, and the Office host's own validation with the gate that follows a save.

use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_fsio::WriteProof;
use mixdog_office_base::formats::is_ooxml_format;
use mixdog_office_base::ids::office_session_id;
use mixdog_office_base::values::truthy;
use mixdog_office_pdf::adapter::validate_pdf;
use mixdog_office_quality::pipeline::evaluate_office_submission_gate;
use mixdog_ooxml::ooxml_validator::{DEFAULT_OFFICE_VERSION, Request, validate_in};
use mixdog_ooxml::validation_package::{ValidateOptions, validate_portable_ooxml};
use mixdog_ooxml::xlsx_assertions::evaluate_xlsx_assertions;
use serde_json::{Map, Value, json};

use super::{Facts, InspectContext, failure_text, list_of, spread, text_arg};
use crate::session::{Mode, SessionHandle};
use crate::snapshot::{ComHost, snapshot};
use crate::tabular::{self, Format};

/// How long the host has to validate a document it has just saved.
const POST_SAVE_TIMEOUT: Duration = Duration::from_millis(300_000);

/// `value === true`.
fn is_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

/// `Boolean(value[key])`.
fn holds(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(truthy)
}

/// The Office host's own read of the document; none off the Microsoft Office backend.
async fn native_validation<P: WriteProof, H: ComHost>(cx: &InspectContext<'_, P, H>, facts: &Facts, args: &Value) -> Result<Option<Value>, String> {
    if !facts.is_microsoft_office() {
        return Ok(None);
    }
    if is_true(args.get("__skipNative")) {
        return Ok(Some(json!({ "ok": true, "opened": true, "issueCount": 0, "issues": [], "documentSaved": true, "reusedReview": true })));
    }
    let post_save = is_true(args.get("__postSave")) || facts.mode == Mode::Background;
    let payload = json!({
        "action": if post_save { "post_save_validate" } else { "validate" },
        "session": facts.id,
        "format": facts.format,
        "mode": facts.mode.as_str(),
        "path": facts.target,
        "inspectIssues": !is_true(args.get("__skipNativeIssues")),
        "includeSnapshot": !is_true(args.get("__skipNativeSnapshot")),
    });
    let response = cx.snapshot.com.call(&payload, facts.signal.as_ref(), post_save.then_some(POST_SAVE_TIMEOUT)).await;
    if !response.get("ok").is_some_and(truthy) {
        return Err(failure_text(&response, "Microsoft Office native validation failed"));
    }
    Ok(Some(response.get("value").cloned().unwrap_or(Value::Null)))
}

fn package_validation<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, facts: &Facts, args: &Value) -> Result<Value, String> {
    let path = Path::new(&facts.target);
    match facts.format.as_str() {
        "pdf" => validate_pdf(cx.lane(), path).map_err(|error| error.message),
        "csv" | "tsv" => {
            let format = Format::from_name(&facts.format).ok_or_else(|| format!("Unsupported delimited format: {}", facts.format))?;
            tabular::validate(cx.lane(), path, format)
        }
        format => {
            let (audit_profile, author) = (text_arg(args, "auditProfile"), text_arg(args, "author"));
            let original = if facts.source == facts.target { "" } else { facts.source.as_str() };
            validate_portable_ooxml(
                cx.lane(),
                path,
                format,
                &ValidateOptions { original, saved_by: facts.backend.as_str(), audit_profile: &audit_profile, author: &author },
            )
        }
    }
}

/// OOXML schema validation; the Office host holds its file open, so the validator reads a copy. A validator that cannot run is
/// an answer (`available: false` with the reason), not a failure of the call.
fn schema_validation<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, facts: &Facts, args: &Value) -> Option<Value> {
    if !is_ooxml_format(&facts.format) {
        return None;
    }
    let mut copy: Option<PathBuf> = None;
    let outcome = (|| -> Result<Value, String> {
        let mut path = PathBuf::from(&facts.target);
        if facts.is_microsoft_office() {
            let extension = Path::new(&facts.target).extension().map_or_else(String::new, |extension| format!(".{}", extension.to_string_lossy()));
            let made = std::env::temp_dir().join(format!("mixdog-schema-{}{extension}", office_session_id()));
            copy = Some(made.clone());
            mixdog_fsio::copy(cx.lane(), &facts.target, &made).map_err(|error| error.to_string())?;
            path = made;
        }
        let request = Request {
            data_dir: &facts.data_dir,
            download: args.get("downloadDependencies") != Some(&Value::Bool(false)),
            office_version: DEFAULT_OFFICE_VERSION,
            cancel: cx.flag(),
        };
        validate_in(cx.lane(), cx.validator, &path, &request).map(|result| result.to_json()).map_err(|error| error.0)
    })();
    if let Some(copy) = copy {
        let _ = mixdog_fsio::remove_file(cx.lane(), &copy);
    }
    Some(outcome.unwrap_or_else(|reason| json!({ "available": false, "ok": false, "errors": [], "reason": reason })))
}

async fn assertion_validation<P: WriteProof, H: ComHost>(
    cx: &InspectContext<'_, P, H>,
    handle: &SessionHandle,
    facts: &Facts,
    args: &Value,
) -> Result<Option<Value>, String> {
    let Some(assertions) = args.get("assertions").and_then(Value::as_array).filter(|list| !list.is_empty()) else { return Ok(None) };
    if facts.format != "xlsx" {
        return Err("assertions are supported for XLSX sessions only".to_owned());
    }
    let asserted = snapshot(&cx.snapshot, handle, &json!({ "limit": 10_000, "maxChars": 100_000, "includeStyles": false }), true).await?;
    evaluate_xlsx_assertions(asserted.get("document").unwrap_or(&Value::Null), assertions).map(Some)
}

/// `validate(session, args)`: the package answer of the backend with the verdicts of every other check beside it. `ok` holds
/// when each check that ran holds: the package, the schema (unless it is off, or needs a download the call refused), the
/// assertions, the host's validation (and a saved document, outside a background session), the post-save gate and, where
/// LibreOffice is there, the reopen.
pub async fn validate<P: WriteProof, H: ComHost>(cx: &InspectContext<'_, P, H>, handle: &SessionHandle, args: &Value) -> Result<Value, String> {
    let facts = Facts::of(handle);
    let native = native_validation(cx, &facts, args).await?;
    let package = package_validation(cx, &facts, args)?;
    let schema = schema_validation(cx, &facts, args);
    let assertions = assertion_validation(cx, handle, &facts, args).await?;
    let compatibility = if is_true(args.get("compatibility")) && is_ooxml_format(&facts.format) {
        Some(cx.soffice.validate_reopen(cx.lane(), Path::new(&facts.target), cx.flag())?)
    } else {
        None
    };
    let post_save_gate = native.as_ref().filter(|native| native.get("persisted").is_some_and(|persisted| !persisted.is_null())).map(|native| {
        evaluate_office_submission_gate(&list_of(native.get("issues")), &Value::Bool(is_true(native.get("persisted"))), &Value::Null)
    });
    // `a && b && c` of JavaScript answers the first falsy operand itself, so a missing `ok` of a part (the Office host's read has
    // none) leaves the verdict `undefined`, which JSON drops; `None` is that.
    let field = |value: &Value, key: &str| value.get(key).cloned();
    let schema_holds = schema.as_ref().map_or(Some(Value::Bool(true)), |schema| {
        if holds(schema, "ok") || is_true(schema.get("disabled")) {
            return Some(Value::Bool(true));
        }
        Some(Value::Bool(args.get("downloadDependencies") == Some(&Value::Bool(false)) && is_true(schema.get("downloadRequired"))))
    });
    let native_holds = native.as_ref().map_or(Some(Value::Bool(true)), |native| {
        let verdict = field(native, "ok");
        if !verdict.as_ref().is_some_and(truthy) {
            return verdict;
        }
        if facts.mode == Mode::Background { Some(Value::Bool(true)) } else { field(native, "documentSaved") }
    });
    let operands: [Option<Value>; 6] = [
        field(&package, "ok"),
        schema_holds,
        assertions.as_ref().map_or(Some(Value::Bool(true)), |assertions| field(assertions, "ok")),
        native_holds,
        post_save_gate.as_ref().map_or(Some(Value::Bool(true)), |gate| field(gate, "ok")),
        compatibility.as_ref().map_or(Some(Value::Bool(true)), |reopen| if holds(reopen, "available") { field(reopen, "opened") } else { Some(Value::Bool(true)) }),
    ];
    let ok = operands.iter().find(|operand| !operand.as_ref().is_some_and(truthy)).cloned().unwrap_or_else(|| operands[5].clone());
    let mut answer = Map::new();
    answer.insert("session".to_owned(), json!(facts.id));
    answer.insert("mode".to_owned(), json!(facts.mode.as_str()));
    answer.insert("backend".to_owned(), json!(facts.backend.as_str()));
    answer.insert("path".to_owned(), json!(facts.target));
    spread(&mut answer, &package);
    match ok {
        Some(verdict) => {
            answer.insert("ok".to_owned(), verdict);
        }
        None => {
            answer.shift_remove("ok");
        }
    }
    for (key, value) in [("schema", schema), ("assertions", assertions), ("native", native), ("postSaveGate", post_save_gate), ("compatibility", compatibility)] {
        answer.insert(key.to_owned(), value.unwrap_or(Value::Null));
    }
    Ok(Value::Object(answer))
}
