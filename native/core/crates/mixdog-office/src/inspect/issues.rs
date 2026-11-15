//! `issues` (`core/office-actions-inspect.mjs`): the findings of a session's document, per backend, merged with the format
//! review and normalised.
//!
//! A portable session's findings come from its package reader (a PDF from the PDF adapter, a delimited file from the tabular
//! backend). A Microsoft Office session's come from the application, plus what the application cannot see: the portable
//! audits of a saved copy of the live document (a deck's measured read, a workbook's sheet audits), the shared formula audit
//! and the picture description rule. The structure review of the format is read from the document and merged into either.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use mixdog_fsio::WriteProof;
use mixdog_js::JsRegex;
use mixdog_office_base::formats::is_ooxml_format;
use mixdog_office_base::values::truthy;
use mixdog_office_pdf::adapter::{SnapshotOptions, issues_pdf};
use mixdog_office_quality::pipeline::normalize_office_review_issues;
use mixdog_office_quality::structure::review_office_structure;
use mixdog_ooxml::cells::{Sheet, workbook_sheets};
use mixdog_ooxml::package::load_package;
use mixdog_ooxml::sheet_audits::{cell_ink_issues, column_fit_issues, protected_input_issues};
use mixdog_ooxml::validation::{issues_portable_ooxml, picture_description_issues};
use mixdog_ooxml::xlsx_formula_audit::merge_xlsx_formula_audit;
use serde_json::{Map, Value, json};

use super::{Facts, InspectContext, both, failure_text, finding_key, known_findings, list_of, review_snapshot, spread, text_arg, with_fields};
use crate::session::SessionHandle;
use crate::snapshot::{ComHost, read_com_saved_copy, snapshot};
use crate::tabular::{self, Format};

/// How long Excel has to answer an audit of a financial model.
const FINANCIAL_MODEL_TIMEOUT: Duration = Duration::from_millis(300_000);

/// PowerPoint's host reads what COM exposes: text bounds, a shape's own fill, fonts, edges. The measured read the portable
/// backend runs on the package (vertical balance and hollow bands, contrast against the plane that actually covers a box,
/// block spacing, stat labels, fragmentation, dead vector charts, chart package faults) never ran on a PowerPoint session, so
/// the same deck passed on one backend and failed on the other. The live document is copied aside (never saved over the user's
/// file) and read as a package; the host's own overflow verdict, measured by PowerPoint itself, stays authoritative.
const HOST_OWNED_PPTX_CODES: [&str; 1] = ["text_overflow"];

static CELL_COLUMN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\/sheet\[(.*)\]\/cell\[\$?([A-Z]+)\$?\d+\]$", ""));

fn is_error(issue: &Value) -> bool {
    issue.get("severity").and_then(Value::as_str) == Some("error")
}

fn code_is(issue: &Value, code: &str) -> bool {
    issue.get("code").and_then(Value::as_str) == Some(code)
}

/// What the format review owns (an orphan heading, a chart the page break cuts, a sheet with no reading order) is read from
/// the document, not the package. A document the reader cannot open is already reported by the package checks; the review
/// simply has nothing to add.
async fn structure_issues<P: WriteProof, H: ComHost>(cx: &InspectContext<'_, P, H>, handle: &SessionHandle, facts: &Facts, args: &Value) -> Vec<Value> {
    if !is_ooxml_format(&facts.format) {
        return Vec::new();
    }
    let Ok(read) = review_snapshot(cx, handle, args).await else { return Vec::new() };
    let Some(document) = read.get("document").filter(|document| truthy(document)) else { return Vec::new() };
    // A PDF's designed sheets are held to the print type floors.
    let mut reviewed = document.clone();
    if facts.print_sheet
        && let Value::Object(fields) = &mut reviewed
    {
        fields.insert("printSheet".to_owned(), Value::Bool(true));
    }
    review_office_structure(Some(facts.format.as_str()), &reviewed, &text_arg(args, "auditProfile"))
}

/// The findings of a package read in this process.
fn portable_ooxml<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, path: &Path, format: &str, options: &Value) -> Result<Value, String> {
    // The deck's structure review, which lives above the package reader.
    let structure = |document: &Value| review_office_structure(Some("pptx"), document, "");
    issues_portable_ooxml(cx.lane(), cx.snapshot.measurer, &structure, path, format, options)
}

fn portable_issues<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, facts: &Facts, args: &Value) -> Result<Value, String> {
    let path = Path::new(&facts.target);
    match facts.format.as_str() {
        "pdf" => issues_pdf(cx.lane(), path, &SnapshotOptions::from_json(args), cx.snapshot.forms).map_err(|error| error.message),
        "csv" | "tsv" => {
            let format = Format::from_name(&facts.format).ok_or_else(|| format!("Unsupported delimited format: {}", facts.format))?;
            tabular::issues(cx.lane(), path, format, args)
        }
        format => {
            let options = if facts.print_sheet { with_fields(args, vec![("printSheet", Value::Bool(true))]) } else { args.clone() };
            portable_ooxml(cx, path, format, &options)
        }
    }
}

/// `cellColumn(path)`: the sheet and the column of a cell path, joined; none for any other path.
fn cell_column(issue: &Value) -> Option<String> {
    let path = text_arg(issue, "path");
    CELL_COLUMN.captures(&path).map(|found| format!("{}\0{}", found.get(1).unwrap_or_default(), found.get(2).unwrap_or_default()))
}

/// A saved copy's sheet audits for a workbook: Excel's host reads a sample of the cells it shows (### in the first 32) and
/// nothing of a protected sheet's validated cells, so a cut label, a figure run into the label beside it, ink nobody can see,
/// a number cut below the sample, and a form nobody can type into passed on Excel while the portable audit reported them.
fn xlsx_sheet_audits<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, copy: &Path, args: &Value) -> Result<Value, String> {
    let zip = load_package(cx.lane(), copy)?;
    let wanted = args.get("sheet").filter(|sheet| truthy(sheet));
    let sheets: Vec<Sheet> = workbook_sheets(&zip).into_iter().filter(|sheet| wanted.is_none_or(|name| name.as_str() == Some(sheet.name.as_str()))).collect();
    let mut found = column_fit_issues(cx.snapshot.measurer, &zip, &sheets)?;
    found.extend(protected_input_issues(&zip, &sheets)?);
    found.extend(cell_ink_issues(&zip, &sheets)?);
    Ok(Value::Array(found))
}

/// A number the host already saw cut in a column stays the host's finding.
fn merge_xlsx_sheet_audits(result: &Value, audit: Result<Value, String>) -> Value {
    let found = match audit {
        Ok(found) => list_of(Some(&found)),
        Err(reason) => return with_fields(result, vec![("sheetAudit", json!({ "status": "unavailable", "reason": reason }))]),
    };
    let known = known_findings(result);
    let issues = list_of(result.get("issues"));
    let overflowing: HashSet<Option<String>> = issues.iter().filter(|entry| code_is(entry, "cell_overflow")).map(cell_column).collect();
    let added: Vec<Value> = found
        .into_iter()
        .filter(|entry| !known.contains(&finding_key(entry)) && !(code_is(entry, "column_too_narrow") && overflowing.contains(&cell_column(entry))))
        .collect();
    if added.is_empty() {
        return with_fields(result, vec![("sheetAudit", json!({ "status": "merged", "added": 0 }))]);
    }
    let count = added.len();
    let mut all = issues;
    all.extend(added);
    with_fields(result, vec![("issues", Value::Array(normalize_office_review_issues(&all))), ("sheetAudit", json!({ "status": "merged", "added": count }))])
}

fn merge_pptx_measured_read(result: &Value, audit: Result<Value, String>) -> Value {
    let measured = match audit {
        Ok(measured) => measured,
        Err(reason) => return with_fields(result, vec![("measuredRead", json!({ "status": "unavailable", "reason": reason }))]),
    };
    let seen = known_findings(result);
    let added: Vec<Value> = list_of(measured.get("issues"))
        .into_iter()
        .filter(|issue| !HOST_OWNED_PPTX_CODES.contains(&text_arg(issue, "code").as_str()) && !seen.contains(&finding_key(issue)))
        .collect();
    if added.is_empty() {
        return with_fields(result, vec![("measuredRead", json!({ "status": "merged", "added": 0 }))]);
    }
    let count = added.len();
    let mut all = list_of(result.get("issues"));
    all.extend(added);
    let issues = normalize_office_review_issues(&all);
    let ok = !issues.iter().any(is_error);
    with_fields(
        result,
        vec![
            ("issues", Value::Array(issues.clone())),
            ("issueCount", Value::from(issues.len())),
            ("ok", Value::Bool(ok)),
            ("measuredRead", json!({ "status": "merged", "added": count })),
        ],
    )
}

/// The request a host is sent for the findings: what the call named, left out where it named nothing.
fn issues_request(facts: &Facts, args: &Value) -> Value {
    let mut payload = Map::new();
    payload.insert("action".to_owned(), json!("issues"));
    payload.insert("session".to_owned(), json!(facts.id));
    payload.insert("format".to_owned(), json!(facts.format));
    payload.insert("mode".to_owned(), json!(facts.mode.as_str()));
    payload.insert("path".to_owned(), json!(facts.target));
    for key in ["sheet", "range", "pages", "target", "auditProfile"] {
        if let Some(value) = args.get(key) {
            payload.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(payload)
}

async fn microsoft_office_issues<P: WriteProof, H: ComHost>(cx: &InspectContext<'_, P, H>, handle: &SessionHandle, facts: &Facts, args: &Value) -> Result<Value, String> {
    // A saved copy's portable audits start before the application's own issues pass. The host takes requests in order, so the
    // copy is written first and its audits run in this process while the application answers: a deck's measured read
    // (0.4-1 s) had followed PowerPoint's 1.7 s pass instead of overlapping it.
    let audit = async {
        match facts.format.as_str() {
            "pptx" => Some(read_com_saved_copy(&cx.snapshot, handle, |copy| portable_ooxml(cx, copy, "pptx", args)).await),
            "xlsx" => Some(read_com_saved_copy(&cx.snapshot, handle, |copy| xlsx_sheet_audits(cx, copy, args)).await),
            _ => None,
        }
    };
    let timeout = (args.get("auditProfile").and_then(Value::as_str) == Some("financial-model")).then_some(FINANCIAL_MODEL_TIMEOUT);
    // The host's future holds the request (a trait's `impl Future` captures every borrow it is given): the request outlives it.
    let request = issues_request(facts, args);
    // Asked inside a future of its own: the request leaves when `both` polls it, after the copy's request.
    let call = async { cx.snapshot.com.call(&request, facts.signal.as_ref(), timeout).await };
    let (copy_audit, response) = both(audit, call).await;
    if !response.get("ok").is_some_and(truthy) {
        return Err(failure_text(&response, "Microsoft Office issue inspection failed"));
    }
    let mut result = response.get("value").cloned().unwrap_or(Value::Null);
    match facts.format.as_str() {
        // Excel's host reports its own subset; the shared formula audit reads the same cells (cached for an owned background
        // session) and adds the rest.
        "xlsx" => {
            let read = snapshot(&cx.snapshot, handle, &json!({ "includeStyles": true }), true).await?;
            let document = read.get("document").unwrap_or(&Value::Null);
            result = merge_xlsx_formula_audit(&result, document, &text_arg(args, "auditProfile"), &text_arg(args, "sheet"));
            result = merge_xlsx_sheet_audits(&result, copy_audit.unwrap_or_else(|| Ok(Value::Array(Vec::new()))));
        }
        "pptx" => result = merge_pptx_measured_read(&result, copy_audit.unwrap_or_else(|| Ok(Value::Null))),
        // Word's host audits no picture's description; its reading lists every picture with the one Word holds, so the
        // portable rule applies to it and an unlabelled figure no longer passes on Word alone.
        "docx" => {
            let read = snapshot(&cx.snapshot, handle, &json!({}), true).await?;
            let document = read.get("document").filter(|document| truthy(document)).cloned().unwrap_or_else(|| json!({}));
            let known = known_findings(&result);
            let added: Vec<Value> = picture_description_issues(&document).into_iter().filter(|entry| !known.contains(&finding_key(entry))).collect();
            if !added.is_empty() {
                let mut all = list_of(result.get("issues"));
                all.extend(added);
                result = with_fields(&result, vec![("issues", Value::Array(normalize_office_review_issues(&all)))]);
            }
        }
        _ => {}
    }
    Ok(result)
}

/// `issues(session, args)`: the session's findings with the format review merged in, normalised: a finding the package reader
/// already made at the same place is the same finding worded twice (the portable contrast measure, against the resolved
/// surface, and the format review's, against the slide, both reported "Hard to read" once the portable snapshot carried text
/// colours), and the package reader's, the more exact, stays.
pub async fn issues<P: WriteProof, H: ComHost>(cx: &InspectContext<'_, P, H>, handle: &SessionHandle, args: &Value) -> Result<Value, String> {
    let facts = Facts::of(handle);
    let result = if facts.is_microsoft_office() { microsoft_office_issues(cx, handle, &facts, args).await? } else { portable_issues(cx, &facts, args)? };
    let found = known_findings(&result);
    let structural = structure_issues(cx, handle, &facts, args).await.into_iter().filter(|entry| !found.contains(&finding_key(entry)));
    // Normalised whether or not the structure review added anything: skipped when it found nothing, a portable deck's overflow
    // and overlap kept the warning the Office backend's copy of the same finding had been raised from.
    let mut all = list_of(result.get("issues"));
    all.extend(structural);
    let merged = normalize_office_review_issues(&all);
    let ok = !merged.iter().any(is_error);
    let mut answer = Map::new();
    answer.insert("session".to_owned(), json!(facts.id));
    answer.insert("mode".to_owned(), json!(facts.mode.as_str()));
    answer.insert("backend".to_owned(), json!(facts.backend.as_str()));
    answer.insert("path".to_owned(), json!(facts.target));
    spread(&mut answer, &result);
    answer.insert("issues".to_owned(), Value::Array(merged.clone()));
    answer.insert("issueCount".to_owned(), Value::from(merged.len()));
    answer.insert("ok".to_owned(), Value::Bool(ok));
    Ok(Value::Object(answer))
}
