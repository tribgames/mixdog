//! The batch pipeline: `applyBatch` and what it calls in `core/office-actions-batch.mjs`.
//!
//! The order is the contract. The trust gate runs before anything is read for editing; the working copy exists before anything is
//! written; the journal says `applying` before the backend touches the document; the backup the batch falls back to is staged before
//! the backend runs. A backend that fails, or a batch that changed nothing, puts the target back from the backup and the transaction
//! back to `active`; the backup and the scratch folders are removed whatever happens.

use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_fsio::WriteProof;
use mixdog_js::{js_to_lowercase, slice_utf16, to_number, utf16_len, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_office_design::templates::inspect::create_pptx_slide_selection;
use mixdog_office_pdf::batch::apply_batch as apply_pdf_batch;
use mixdog_office_quality::trust::assert_office_mutation_allowed;
use mixdog_ooxml::opc::provenance_citation;
use mixdog_ooxml::pptx_package::clear_portable_presentation_slides;
use mixdog_ooxml::portable::apply_portable_ooxml_batch;
use serde_json::{Map, Value, json};

use super::prepare::{Prepared, prepare_batch_operations, with_shared_chart_defaults};
use super::{BatchContext, BatchHost};
use crate::inline_audit::inline_office_audit;
use crate::session::registry::lock;
use crate::session::working_copy::materialize_working_copy;
use crate::session::{Backend, Mode, SessionHandle};
use crate::snapshot::{ComHost, trust_for_mutation};
use crate::tabular::{self, Format};
use crate::transactions::{
    TransactionError, assert_transaction_unchanged, capture_session_state, persist_office_transaction, record_transaction_operations, remove_quietly,
    transaction_document_diff, transaction_view, unique_token, update_transaction,
};

/// How long Office has to save a copy or to replace a deck from a file.
const COPY_TIMEOUT: Duration = Duration::from_millis(120_000);

/// `String(x)` of an optional field: `undefined` is text too.
fn text_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `path.extname(path)` lower-cased: from the last dot of the file name, nothing when the dot starts the name.
fn extension_of(path: &str) -> String {
    let name = Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot > 0 => js_to_lowercase(&name[dot..]),
        _ => String::new(),
    }
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> u64 {
    let number = value.map_or(0.0, to_number);
    if number.is_nan() || number <= 0.0 { 0 } else { number as u64 }
}

/// The facts of a session the pipeline reads, taken under its lock (the lock is never held across the host's answer).
struct Facts {
    id: String,
    format: String,
    backend: Backend,
    mode: Mode,
    target: String,
    created: bool,
    snapshot_version: u64,
    data_dir: PathBuf,
    signal: Option<mixdog_rt::CancellationToken>,
    background_isolation: Option<Value>,
}

impl Facts {
    fn of(handle: &SessionHandle) -> Self {
        let session = lock(handle);
        Self {
            id: session.id.clone(),
            format: session.format.clone(),
            backend: session.backend,
            mode: session.mode,
            target: session.target.clone(),
            created: session.created,
            snapshot_version: session.snapshot_version,
            data_dir: session.data_dir.clone(),
            signal: session.active_signal.clone(),
            background_isolation: session.com.background_isolation.clone(),
        }
    }

    fn microsoft_office(&self) -> bool {
        self.backend == Backend::MicrosoftOfficeCom
    }
}

/// `microsoftOfficeCall(session, target, request, timeoutMs)`: `{ session, format, mode, path }` and the request's own fields.
async fn microsoft_call<P: WriteProof, H: ComHost, B>(cx: &BatchContext<'_, P, H, B>, facts: &Facts, target: &str, request: Vec<(&str, Value)>, timeout: Duration) -> Value {
    let mut payload = Map::new();
    payload.insert("session".to_owned(), json!(facts.id));
    payload.insert("format".to_owned(), json!(facts.format));
    payload.insert("mode".to_owned(), json!(facts.mode.as_str()));
    payload.insert("path".to_owned(), json!(target));
    for (key, value) in request {
        payload.insert(key.to_owned(), value);
    }
    cx.inspect.snapshot.com.call(&Value::Object(payload), facts.signal.as_ref(), Some(timeout)).await
}

fn answered(answer: &Value) -> bool {
    answer.get("ok").is_some_and(truthy)
}

/// `error || fallback` of a host answer.
fn failure(answer: &Value, fallback: &str) -> String {
    answer.get("error").filter(|error| truthy(error)).map_or_else(|| fallback.to_owned(), value_to_string)
}

/// A provenance citation is composed once, as the portable writer composes it (its prefix in the language the source is named in), and
/// the Office host writes it as handed.
fn with_provenance_citations(operations: Vec<Value>) -> Result<Vec<Value>, String> {
    operations
        .into_iter()
        .map(|operation| {
            if operation.get("op").and_then(Value::as_str) != Some("add_provenance") {
                return Ok(operation);
            }
            let citation = provenance_citation(operation.get("source").unwrap_or(&Value::Null));
            if citation.is_empty() {
                return Err("add_provenance requires source with a document or label".to_owned());
            }
            let mut fields = operation.as_object().cloned().unwrap_or_default();
            fields.insert("citation".to_owned(), json!(citation));
            Ok(Value::Object(fields))
        })
        .collect()
}

/// What a backend answers: the results, whether it saved, the undo units Office recorded and the isolation of a background window.
struct Outcome {
    results: Value,
    saved: Option<Value>,
    undo_units: u64,
    background_isolation: Option<Value>,
}

/// Where the batch falls back to if a backend fails half-way: a copy of the target for the portable writers (a save-copy checkpoint
/// for a COM import), and for an empty COM deck replaced by an import, the selection file that import is built from.
struct SafetyPlan {
    empty_deck_replacement: bool,
    portable_template_seed: String,
    needs_com_checkpoint: bool,
    backup: String,
    replacement_source: String,
}

fn batch_safety_plan(facts: &Facts, target: &str, operations: &[Value]) -> SafetyPlan {
    let first = &operations[0];
    let op = |operation: &Value| operation.get("op").and_then(Value::as_str).unwrap_or("").to_owned();
    let imports = operations.iter().find(|operation| op(operation) == "import_slides");
    let fresh = facts.created && facts.snapshot_version == 0;
    let after = first.get("after").filter(|after| truthy(after)).map_or(0.0, to_number);
    let empty_deck_replacement = facts.microsoft_office()
        && facts.format == "pptx"
        && facts.mode == Mode::Background
        && fresh
        && op(first) == "import_slides"
        && after == 0.0
        && extension_of(&first.get("path").map(value_to_string).unwrap_or_default()) == extension_of(target);
    let portable_template_seed = match imports {
        Some(import) if facts.backend == Backend::MixdogOoxml && facts.format == "pptx" && fresh => {
            import.get("path").filter(|path| truthy(path)).map(value_to_string).unwrap_or_default()
        }
        _ => String::new(),
    };
    let needs_com_checkpoint = facts.microsoft_office() && facts.mode == Mode::Background && imports.is_some();
    let backup = if !facts.microsoft_office() || needs_com_checkpoint { format!("{target}.mixdog-backup-{}", unique_dashed()) } else { String::new() };
    let replacement_source = if empty_deck_replacement && first.get("slides").is_some_and(Value::is_array) {
        std::env::temp_dir().join(format!("mixdog-pptx-selection-{}.pptx", unique_dashed())).to_string_lossy().into_owned()
    } else {
        String::new()
    };
    SafetyPlan { empty_deck_replacement, portable_template_seed, needs_com_checkpoint, backup, replacement_source }
}

/// A random token in the shape of a UUID.
fn unique_dashed() -> String {
    let token = unique_token();
    format!("{}-{}-{}-{}-{}", &token[0..8], &token[8..12], &token[12..16], &token[16..20], &token[20..32])
}

/// Stages what the batch falls back to.
async fn stage_batch_backup<P: WriteProof, H: ComHost, B>(cx: &BatchContext<'_, P, H, B>, facts: &Facts, target: &str, operations: &[Value], plan: &SafetyPlan) -> Result<(), String> {
    if !plan.replacement_source.is_empty() {
        let first = &operations[0];
        create_pptx_slide_selection(cx.lane(), &text_of(first.get("path")), first.get("slides").unwrap_or(&Value::Null), &plan.replacement_source)?;
    }
    if plan.backup.is_empty() {
        return Ok(());
    }
    if plan.needs_com_checkpoint {
        let checkpoint = microsoft_call(cx, facts, target, vec![("action", json!("save_copy")), ("output", json!(plan.backup))], COPY_TIMEOUT).await;
        if !answered(&checkpoint) {
            return Err(format!("Microsoft Office save-copy checkpoint failed: {}", failure(&checkpoint, "unknown error")));
        }
    } else {
        mixdog_fsio::copy(cx.lane(), target, &plan.backup).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Puts the target back from the backup after a failed batch (a failure of the restore itself is left unsaid).
async fn restore_batch_target<P: WriteProof, H: ComHost, B>(cx: &BatchContext<'_, P, H, B>, facts: &Facts, target: &str, plan: &SafetyPlan) {
    if plan.backup.is_empty() {
        return;
    }
    if plan.empty_deck_replacement {
        let request = vec![("action", json!("replace_presentation_from_source")), ("source", json!(plan.backup)), ("checkpoint", json!(plan.backup))];
        let _ = microsoft_call(cx, facts, target, request, COPY_TIMEOUT).await;
    } else {
        remove_quietly(cx.lane(), target);
        let _ = mixdog_fsio::rename(cx.lane(), &plan.backup, target);
    }
}

/// `microsoftBatch(session, args, target, operations)`: the batch on the Office host.
async fn microsoft_batch<P: WriteProof, H: ComHost, B>(cx: &BatchContext<'_, P, H, B>, facts: &Facts, args: &Value, target: &str, operations: &[Value]) -> Result<Value, String> {
    let shaped = with_provenance_citations(with_shared_chart_defaults(&facts.format, operations))?;
    let request = vec![
        ("action", json!("batch")),
        ("operations", Value::Array(shaped)),
        ("save", json!(args.get("save") == Some(&Value::Bool(true)))),
        ("requireChanges", json!(args.get("requireChanges") != Some(&Value::Bool(false)))),
    ];
    let timeout = Duration::from_millis(300_000.min(90_000 + operations.len() as u64 * 500));
    Ok(microsoft_call(cx, facts, target, request, timeout).await)
}

/// `x || fallback` of a host's `backgroundIsolation`.
fn isolation_of(answer: &Value, fallback: Option<Value>) -> Option<Value> {
    answer.get("backgroundIsolation").filter(|value| truthy(value)).cloned().or(fallback)
}

fn results_list(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(other) => vec![other.clone()],
        None => vec![Value::Null],
    }
}

/// `runMicrosoftBatch`: the batch on the Office host. An empty new deck first takes the imported presentation as its source, then the
/// remaining operations.
async fn run_microsoft_batch<P: WriteProof, H: ComHost, B>(cx: &BatchContext<'_, P, H, B>, facts: &Facts, args: &Value, target: &str, operations: &[Value], plan: &SafetyPlan) -> Result<Outcome, String> {
    let isolation = facts.background_isolation.clone();
    if !plan.empty_deck_replacement {
        let result = microsoft_batch(cx, facts, args, target, operations).await?;
        if !answered(&result) {
            return Err(failure(&result, "Microsoft Office batch failed"));
        }
        return Ok(Outcome { results: result.get("results").cloned().unwrap_or(Value::Null), saved: result.get("saved").cloned(), undo_units: number_or_zero(result.get("undoUnits")), background_isolation: isolation_of(&result, isolation) });
    }
    let operation = &operations[0];
    let source = if plan.replacement_source.is_empty() { text_of(operation.get("path")) } else { plan.replacement_source.clone() };
    let mut request = vec![("action", json!("replace_presentation_from_source")), ("source", json!(source))];
    if plan.replacement_source.is_empty() {
        request.push(("slides", operation.get("slides").cloned().unwrap_or(Value::Null)));
    }
    request.push(("checkpoint", json!(plan.backup)));
    let replaced = microsoft_call(cx, facts, target, request, COPY_TIMEOUT).await;
    if !answered(&replaced) {
        return Err(format!("PowerPoint source replacement failed: {}", failure(&replaced, "unknown error")));
    }
    let isolation = isolation_of(&replaced, isolation);
    let mut results = results_list(replaced.get("results"));
    let remaining = &operations[1..];
    if remaining.is_empty() {
        return Ok(Outcome { results: Value::Array(results), saved: Some(json!(replaced.get("saved") == Some(&Value::Bool(true)))), undo_units: 0, background_isolation: isolation });
    }
    let result = microsoft_batch(cx, facts, args, target, remaining).await?;
    if !answered(&result) {
        return Err(failure(&result, "Microsoft Office batch failed after native template import"));
    }
    results.extend(results_list(result.get("results")));
    Ok(Outcome { results: Value::Array(results), saved: result.get("saved").cloned(), undo_units: number_or_zero(result.get("undoUnits")), background_isolation: isolation_of(&result, isolation) })
}

/// Runs the operations on the session's backend and returns the raw results with what the Office host reports about the save and its
/// undo units.
async fn run_batch_backend<P: WriteProof, H: ComHost, B: BatchHost>(cx: &BatchContext<'_, P, H, B>, facts: &Facts, args: &Value, target: &str, operations: &[Value], plan: &SafetyPlan) -> Result<Outcome, String> {
    if facts.microsoft_office() {
        return run_microsoft_batch(cx, facts, args, target, operations, plan).await;
    }
    let snapshot = &cx.inspect.snapshot;
    let lane = cx.lane();
    let path = Path::new(target);
    let results = if facts.format == "pdf" {
        let content = cx.host.pdf_operations(&facts.data_dir, facts.signal.clone());
        apply_pdf_batch(lane, cx.note, path, operations, &content).map_err(|error| error.to_string())?
    } else if let Some(delimited) = Format::from_name(&facts.format) {
        tabular::apply_batch(lane, cx.note, path, delimited, operations)?
    } else {
        if !plan.portable_template_seed.is_empty() {
            mixdog_fsio::copy(lane, &plan.portable_template_seed, target).map_err(|error| error.to_string())?;
            clear_portable_presentation_slides(lane, cx.note, path)?;
        }
        apply_portable_ooxml_batch(lane, cx.note, snapshot.measurer, path, &facts.format, operations)?
    };
    Ok(Outcome { results: Value::Array(results), saved: Some(json!(true)), undo_units: 0, background_isolation: facts.background_isolation.clone() })
}

/// `normalizeBatchResults`: the objects among the results.
fn normalize_batch_results(results: &Value) -> Vec<Value> {
    results_list(Some(results)).into_iter().filter(Value::is_object).collect()
}

/// An operation may declare `allowNoChange` (a routine normalize_runs, a fit_text that already fits); the Office host honours it per
/// entry and the portable path does the same when results map onto operations. A phrase that matched nothing is the whole reason, and
/// the caller cannot see it from "no change" alone.
fn unchanged_results(operations: &[Value], results: &[Value]) -> Vec<Value> {
    let aligned = results.len() == operations.len();
    results
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let operation = aligned.then(|| &operations[index]);
            let reasoned = entry.get("unchangedReason").is_some_and(truthy);
            let Some(operation) = operation.filter(|operation| entry.get("changed") == Some(&Value::Bool(false)) && !reasoned && operation.get("op").and_then(Value::as_str) == Some("replace_text")) else {
                return entry.clone();
            };
            let find = operation.get("find").filter(|find| !find.is_null()).map(value_to_string).unwrap_or_default();
            let shown = if utf16_len(&find) > 40 { format!("{}…", slice_utf16(&find, 40)) } else { find };
            let slide = operation.get("slide").filter(|slide| truthy(slide)).map(|slide| format!(" on slide {}", value_to_string(slide))).unwrap_or_default();
            let mut fields = entry.as_object().cloned().unwrap_or_default();
            fields.insert("unchangedReason".to_owned(), json!(format!("\"{shown}\" appears nowhere{slide}; read the wording as written with action:query and a word from it")));
            Value::Object(fields)
        })
        .enumerate()
        .filter(|(index, entry)| entry.get("changed") == Some(&Value::Bool(false)) && !(aligned && operations[*index].get("allowNoChange") == Some(&Value::Bool(true))))
        .map(|(_, entry)| entry)
        .collect()
}

fn assert_batch_changed(facts: &Facts, args: &Value, no_change: &[Value]) -> Result<(), String> {
    if args.get("requireChanges") == Some(&Value::Bool(false)) || no_change.is_empty() || facts.microsoft_office() {
        return Ok(());
    }
    // An operation that knows why it changed nothing says so: "no change" on its own sends the caller back to look for a fault that is
    // not there.
    let named: Vec<String> = no_change
        .iter()
        .map(|entry| {
            let op = entry.get("op").filter(|op| truthy(op)).map_or_else(|| "operation".to_owned(), value_to_string);
            match entry.get("unchangedReason").filter(|reason| truthy(reason)) {
                Some(reason) => format!("{op} ({})", value_to_string(reason)),
                None => op,
            }
        })
        .collect();
    Err(format!("Office batch produced no change for: {}", named.join(", ")))
}

/// Records the applied batch on the open transaction; a journal that could not be written is reported, not fatal.
async fn record_applied_transaction<P: WriteProof, H: ComHost, B>(cx: &BatchContext<'_, P, H, B>, handle: &SessionHandle, format: &str, operations: &[Value], results: &[Value], undo_units: u64) -> Result<Value, String> {
    let transactions = cx.transactions();
    let current = capture_session_state(&transactions, handle, "").await?;
    update_transaction(handle, |transaction| {
        transaction.expected_fingerprint = json!(current.fingerprint);
        transaction.current_document = current.document.clone();
        transaction.undo_units += undo_units;
        record_transaction_operations(transaction, format, operations, results);
        transaction.diff = transaction_document_diff(transaction, &current.document);
        transaction.phase = crate::session::TransactionPhase::Active;
    });
    let warning = persist_office_transaction(&transactions, handle, None).err();
    let held = lock(handle).state.transaction().cloned().ok_or("The transaction vanished")?;
    let mut view = transaction_view(&held, None);
    if let (Some(warning), Some(fields)) = (warning, view.as_object_mut()) {
        fields.insert("journalWarning".to_owned(), json!(warning));
    }
    Ok(view)
}

/// `recordDesignState(session, prepared)`: what the design planned is counted on the session, and a deck that requires a visual review
/// keeps the plan of each slide.
fn record_design_state(handle: &SessionHandle, format: &str, prepared: &Prepared) {
    let mut session = lock(handle);
    session.design_state.semantic_count += prepared.semantic.len() as u64;
    session.design_state.compositions.extend(prepared.semantic.iter().filter_map(|entry| entry.get("composition")).filter(|composition| truthy(composition)).cloned());
    let required = session.design.as_ref().and_then(|design| design.get("review")).and_then(|review| review.get("required")).is_some_and(truthy);
    if format != "pptx" || !required {
        return;
    }
    session.design_state.requires_visual_review = true;
    let slide_of = |plan: &Value| to_number(plan.get("slide").unwrap_or(&Value::Null));
    let mut plans: Vec<(f64, Value)> = session.design_state.slide_plans.clone().unwrap_or_default().into_iter().map(|plan| (slide_of(&plan), plan)).collect();
    for semantic in &prepared.semantic {
        let Some(plan) = semantic.get("plan").filter(|plan| truthy(plan)) else { continue };
        let slide = to_number(semantic.get("slide").unwrap_or(&Value::Null));
        if !(slide > 0.0) {
            continue;
        }
        let mut fields = plan.as_object().cloned().unwrap_or_default();
        for key in ["kind", "slideRole", "backgroundRole"] {
            match semantic.get(key) {
                Some(value) => fields.insert(key.to_owned(), value.clone()),
                None => fields.shift_remove(key),
            };
        }
        let entry = (slide, Value::Object(fields));
        match plans.iter().position(|(held, _)| *held == slide) {
            Some(at) => plans[at] = entry,
            None => plans.push(entry),
        }
    }
    plans.sort_by(|left, right| slide_of(&left.1).partial_cmp(&slide_of(&right.1)).unwrap_or(std::cmp::Ordering::Equal));
    session.design_state.slide_plans = Some(plans.into_iter().map(|(_, plan)| plan).collect());
}

// A column fitted while its formulas were uncached was measured against empty cells: the widths are only final once the workbook has been
// recalculated, so the session remembers what to fit again then. The fit is replayed whole (its minWidth and whether it fits rows) and in
// order with the explicit widths and heights set after it: replayed bare, a composed report's 19-character columns shrank to their content,
// and a gutter set by set_column_width after the fit was widened again.
const SIZING_FIELDS: [&str; 9] = ["sheet", "range", "minWidth", "rows", "column", "row", "width", "height", "count"];

fn sizing_key(operation: &Value) -> String {
    let field = |name: &str| operation.get(name).filter(|value| !value.is_null());
    let op = operation.get("op").and_then(Value::as_str).unwrap_or("");
    let target = if op == "autofit_range" {
        format!("{}|{}", text_of(operation.get("range")), operation.get("rows") == Some(&Value::Bool(true)))
    } else {
        let which = field("column").or_else(|| field("row"));
        format!("{}|{}", which.map_or_else(|| "undefined".to_owned(), value_to_string), field("count").map_or_else(|| "1".to_owned(), value_to_string))
    };
    let sheet = operation.get("sheet").filter(|sheet| truthy(sheet)).map(value_to_string).unwrap_or_default();
    format!("{op}|{sheet}|{target}")
}

fn remember_autofit_ranges(handle: &SessionHandle, operations: &[Value]) {
    let sized: Vec<Value> = operations
        .iter()
        .filter(|operation| match operation.get("op").and_then(Value::as_str) {
            Some("autofit_range") => operation.get("range").is_some_and(truthy),
            Some("set_column_width" | "set_row_height") => true,
            _ => false,
        })
        .map(|operation| {
            let mut fields = Map::new();
            fields.insert("op".to_owned(), operation["op"].clone());
            for name in SIZING_FIELDS {
                if let Some(value) = operation.get(name) {
                    fields.insert(name.to_owned(), value.clone());
                }
            }
            Value::Object(fields)
        })
        .collect();
    if sized.is_empty() {
        return;
    }
    // The latest request for a target wins and takes its place in the order.
    let keys: Vec<String> = sized.iter().map(sizing_key).collect();
    let mut session = lock(handle);
    session.authored.autofit_ranges.retain(|entry| !keys.contains(&sizing_key(entry)));
    session.authored.autofit_ranges.extend(sized);
}

/// Marks the open transaction as applying and journals that; a journal that cannot be written leaves the transaction active and stops the
/// batch. Answers whether a transaction is open.
async fn mark_transaction_applying<P: WriteProof, H: ComHost, B>(cx: &BatchContext<'_, P, H, B>, handle: &SessionHandle) -> Result<bool, TransactionError> {
    if lock(handle).state.transaction().is_none() {
        return Ok(false);
    }
    let transactions = cx.transactions();
    assert_transaction_unchanged(&transactions, handle).await?;
    persist_office_transaction(&transactions, handle, Some("applying"))?;
    Ok(true)
}

/// What a successful batch is made of, and the result it builds.
struct Applied<'a> {
    trust: &'a Value,
    prepared: &'a Prepared,
    operations: &'a [Value],
    has_transaction: bool,
    target: &'a str,
    outcome: Outcome,
}

/// `commitBatch`: records the applied batch on the session and builds the batch result.
async fn commit_batch<P: WriteProof, H: ComHost, B: BatchHost>(cx: &BatchContext<'_, P, H, B>, handle: &SessionHandle, facts: &Facts, args: &Value, applied: Applied<'_>) -> Result<Value, String> {
    let Applied { trust, prepared, operations, has_transaction, target, outcome } = applied;
    let results = normalize_batch_results(&outcome.results);
    let no_change = unchanged_results(operations, &results);
    assert_batch_changed(facts, args, &no_change)?;
    let transaction = if has_transaction { Some(record_applied_transaction(cx, handle, &facts.format, operations, &results, outcome.undo_units).await?) } else { None };
    record_design_state(handle, &facts.format, prepared);
    if facts.format == "xlsx" {
        remember_autofit_ranges(handle, operations);
    }
    {
        let mut session = lock(handle);
        session.snapshot_version += 1;
        session.design_state.rendered_version = Value::Null;
        session.com.background_isolation = outcome.background_isolation.clone();
    }
    // The measured read rides on the mutation result so a fit, bounds, or package fault surfaces in the turn that caused it; qa owns the full
    // review and passes audit:false for its own repair batches.
    let audit = if args.get("audit") == Some(&Value::Bool(false)) { None } else { inline_office_audit(cx.inspect, handle, operations, &[]).await };
    let (id, mode, backend, design) = {
        let session = lock(handle);
        (session.id.clone(), session.mode.as_str(), session.backend.as_str(), session.design.clone().unwrap_or(Value::Null))
    };
    let mut result = Map::new();
    result.insert("ok".to_owned(), json!(true));
    result.insert("session".to_owned(), json!(id));
    result.insert("mode".to_owned(), json!(mode));
    result.insert("backend".to_owned(), json!(backend));
    result.insert("output".to_owned(), json!(target));
    if let Some(saved) = &outcome.saved {
        result.insert("saved".to_owned(), saved.clone());
    }
    result.insert("atomic".to_owned(), json!(true));
    let changed = results.iter().filter(|entry| entry.get("changed") == Some(&Value::Bool(true))).count();
    result.insert("results".to_owned(), Value::Array(results));
    result.insert("changeSummary".to_owned(), json!({ "requested": operations.len(), "changed": changed, "noChange": no_change.len() }));
    if let Some(audit) = audit {
        result.insert("audit".to_owned(), audit);
    }
    result.insert("design".to_owned(), design);
    result.insert("semanticOperations".to_owned(), Value::Array(prepared.semantic.clone()));
    // A template page's chart, table, or picture still shows the template's data until it is replaced.
    if !prepared.template_data.is_empty() {
        result.insert("templateData".to_owned(), Value::Array(prepared.template_data.clone()));
    }
    if let Some(isolation) = &outcome.background_isolation {
        result.insert("backgroundIsolation".to_owned(), isolation.clone());
    }
    result.insert("trust".to_owned(), trust.clone());
    if let Some(transaction) = transaction {
        result.insert("transaction".to_owned(), transaction);
    }
    Ok(Value::Object(result))
}

/// `applyBatch(session, args)`: the batch of `args.operations` applied to the session's document, all together or not at all.
pub async fn apply_batch<P: WriteProof, H: ComHost, B: BatchHost>(cx: &BatchContext<'_, P, H, B>, handle: &SessionHandle, args: &Value) -> Result<Value, TransactionError> {
    let trust = trust_for_mutation(&cx.inspect.snapshot, handle).await?;
    assert_office_mutation_allowed(Some(&trust), args.get("acknowledgeUntrustedContent") == Some(&Value::Bool(true)))?;
    let prepared = prepare_batch_operations(cx, handle, args).await?;
    // A session that was opened to read holds the user's file; the first edit moves it onto a working copy first.
    materialize_working_copy(cx.lane(), cx.note, cx.env, cx.registry, handle)?;
    let has_transaction = mark_transaction_applying(cx, handle).await?;
    let facts = Facts::of(handle);
    let target = facts.target.clone();
    let operations = prepared.operations.clone();
    let plan = batch_safety_plan(&facts, &target, &operations);
    let staged = stage_batch_backup(cx, &facts, &target, &operations, &plan).await;
    if let Err(error) = staged {
        return Err(TransactionError::Failed(error));
    }
    let attempt = async {
        let outcome = run_batch_backend(cx, &facts, args, &target, &operations, &plan).await?;
        commit_batch(cx, handle, &facts, args, Applied { trust: &trust, prepared: &prepared, operations: &operations, has_transaction, target: &target, outcome }).await
    }
    .await;
    if attempt.is_err() {
        restore_batch_target(cx, &facts, &target, &plan).await;
        if has_transaction {
            update_transaction(handle, |transaction| transaction.phase = crate::session::TransactionPhase::Active);
            let _ = persist_office_transaction(&cx.transactions(), handle, None);
        }
    }
    remove_quietly(cx.lane(), &plan.backup);
    remove_quietly(cx.lane(), &plan.replacement_source);
    for directory in &prepared.scratch {
        let _ = mixdog_fsio::remove_dir_all(cx.lane(), directory);
    }
    Ok(attempt?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(backend: Backend, format: &str, mode: Mode, created: bool, version: u64) -> Facts {
        Facts {
            id: "office_1".to_owned(),
            format: format.to_owned(),
            backend,
            mode,
            target: String::new(),
            created,
            snapshot_version: version,
            data_dir: PathBuf::new(),
            signal: None,
            background_isolation: None,
        }
    }

    #[test]
    fn a_portable_batch_keeps_a_backup_beside_the_target_and_office_keeps_none() {
        let portable = batch_safety_plan(&facts(Backend::MixdogOoxml, "docx", Mode::Portable, false, 0), "C:/w/a.docx", &[json!({ "op": "append_text" })]);
        assert!(portable.backup.starts_with("C:/w/a.docx.mixdog-backup-"));
        assert!(!portable.empty_deck_replacement && !portable.needs_com_checkpoint && portable.replacement_source.is_empty());
        let office = batch_safety_plan(&facts(Backend::MicrosoftOfficeCom, "docx", Mode::Background, false, 0), "C:/w/a.docx", &[json!({ "op": "append_text" })]);
        assert!(office.backup.is_empty());
    }

    #[test]
    fn an_import_into_a_background_office_deck_is_checkpointed_by_a_saved_copy() {
        let imports = [json!({ "op": "import_slides", "path": "C:/t/t.pptx", "after": 0, "slides": [1, 2] })];
        let plan = batch_safety_plan(&facts(Backend::MicrosoftOfficeCom, "pptx", Mode::Background, true, 0), "C:/w/d.pptx", &imports);
        assert!(plan.needs_com_checkpoint && plan.empty_deck_replacement);
        assert!(!plan.backup.is_empty());
        assert!(plan.replacement_source.ends_with(".pptx") && plan.replacement_source.contains("mixdog-pptx-selection-"));
        let later = batch_safety_plan(&facts(Backend::MicrosoftOfficeCom, "pptx", Mode::Background, true, 1), "C:/w/d.pptx", &imports);
        assert!(later.needs_com_checkpoint && !later.empty_deck_replacement && later.replacement_source.is_empty());
        let other_kind = [json!({ "op": "import_slides", "path": "C:/t/t.potx", "after": 0 })];
        assert!(!batch_safety_plan(&facts(Backend::MicrosoftOfficeCom, "pptx", Mode::Background, true, 0), "C:/w/d.pptx", &other_kind).empty_deck_replacement);
    }

    #[test]
    fn a_portable_new_deck_seeds_itself_from_the_template_it_imports() {
        let imports = [json!({ "op": "import_slides", "path": "C:/t/t.pptx" })];
        let plan = batch_safety_plan(&facts(Backend::MixdogOoxml, "pptx", Mode::Portable, true, 0), "C:/w/d.pptx", &imports);
        assert_eq!(plan.portable_template_seed, "C:/t/t.pptx");
        let edited = batch_safety_plan(&facts(Backend::MixdogOoxml, "pptx", Mode::Portable, true, 2), "C:/w/d.pptx", &imports);
        assert!(edited.portable_template_seed.is_empty());
        let unnamed = batch_safety_plan(&facts(Backend::MixdogOoxml, "pptx", Mode::Portable, true, 0), "C:/w/d.pptx", &[json!({ "op": "import_slides" })]);
        assert!(unnamed.portable_template_seed.is_empty());
    }

    #[test]
    fn a_phrase_that_matched_nothing_says_so_and_allow_no_change_is_honoured() {
        let operations = [json!({ "op": "replace_text", "find": "x".repeat(50), "slide": 3 }), json!({ "op": "normalize_runs", "allowNoChange": true }), json!({ "op": "set_text" })];
        let results = [json!({ "op": "replace_text", "changed": false }), json!({ "op": "normalize_runs", "changed": false }), json!({ "op": "set_text", "changed": true })];
        let unchanged = unchanged_results(&operations, &results);
        assert_eq!(unchanged.len(), 1);
        assert_eq!(unchanged[0]["unchangedReason"], json!(format!("\"{}…\" appears nowhere on slide 3; read the wording as written with action:query and a word from it", "x".repeat(40))));
        let misaligned = unchanged_results(&operations, &results[..2]);
        assert_eq!(misaligned.len(), 2);
        assert!(misaligned[0].get("unchangedReason").is_none());
    }

    #[test]
    fn a_batch_that_changed_nothing_is_refused_unless_the_caller_allows_it() {
        let session = facts(Backend::MixdogOoxml, "docx", Mode::Portable, false, 0);
        let none = [json!({ "op": "replace_text", "changed": false, "unchangedReason": "no match" }), json!({ "changed": false })];
        let error = assert_batch_changed(&session, &json!({}), &none).expect_err("refused");
        assert_eq!(error, "Office batch produced no change for: replace_text (no match), operation");
        assert!(assert_batch_changed(&session, &json!({ "requireChanges": false }), &none).is_ok());
        assert!(assert_batch_changed(&facts(Backend::MicrosoftOfficeCom, "docx", Mode::Background, false, 0), &json!({}), &none).is_ok());
        assert!(assert_batch_changed(&session, &json!({}), &[]).is_ok());
    }

    #[test]
    fn results_that_are_not_objects_are_dropped() {
        let kept = normalize_batch_results(&json!([{ "changed": true }, null, 3, [1], { "changed": false }]));
        assert_eq!(kept, [json!({ "changed": true }), json!({ "changed": false })]);
        assert_eq!(normalize_batch_results(&json!({ "changed": true })).len(), 1);
        assert!(normalize_batch_results(&Value::Null).is_empty());
    }

    #[test]
    fn a_later_sizing_of_a_target_replaces_the_earlier_one_and_takes_its_place_last() {
        let operations = [
            json!({ "op": "autofit_range", "sheet": "S", "range": "A:C", "minWidth": 8, "extra": 1 }),
            json!({ "op": "set_column_width", "sheet": "S", "column": "D", "width": 12 }),
            json!({ "op": "autofit_range", "sheet": "S", "range": "A:C", "minWidth": 10, "rows": false }),
            json!({ "op": "set_cell", "cell": "A1" }),
        ];
        assert_eq!(sizing_key(&operations[0]), "autofit_range|S|A:C|false");
        assert_eq!(sizing_key(&operations[1]), "set_column_width|S|D|1");
        let session = std::sync::Arc::new(std::sync::Mutex::new(crate::session::Session::new(crate::session::SessionInit {
            id: "s".to_owned(),
            source: String::new(),
            target: String::new(),
            file_kind: "xlsx".to_owned(),
            format: "xlsx".to_owned(),
            mode: Mode::Portable,
            backend: Backend::MixdogOoxml,
            opened_at: String::new(),
            data_dir: PathBuf::new(),
            created: false,
            created_new_file: None,
            design_state: crate::session::DesignState::default(),
        })));
        remember_autofit_ranges(&session, &operations[..2]);
        remember_autofit_ranges(&session, &operations[2..]);
        let kept = lock(&session).authored.autofit_ranges.clone();
        assert_eq!(kept, [json!({ "op": "set_column_width", "sheet": "S", "column": "D", "width": 12 }), json!({ "op": "autofit_range", "sheet": "S", "range": "A:C", "minWidth": 10, "rows": false })]);
    }

    #[test]
    fn a_provenance_citation_is_composed_once_and_needs_a_source() {
        let cited = with_provenance_citations(vec![json!({ "op": "add_provenance", "source": { "document": "Report" } }), json!({ "op": "set_cell" })]).expect("cited");
        assert_eq!(cited[1], json!({ "op": "set_cell" }));
        assert!(cited[0]["citation"].as_str().is_some_and(|citation| !citation.is_empty()));
        assert_eq!(with_provenance_citations(vec![json!({ "op": "add_provenance" })]).expect_err("refused"), "add_provenance requires source with a document or label");
    }

    #[test]
    fn a_deck_with_a_required_review_keeps_the_plan_of_each_slide_in_order() {
        let session = std::sync::Arc::new(std::sync::Mutex::new(crate::session::Session::new(crate::session::SessionInit {
            id: "s".to_owned(),
            source: String::new(),
            target: String::new(),
            file_kind: "pptx".to_owned(),
            format: "pptx".to_owned(),
            mode: Mode::Portable,
            backend: Backend::MixdogOoxml,
            opened_at: String::new(),
            data_dir: PathBuf::new(),
            created: false,
            created_new_file: None,
            design_state: crate::session::DesignState::default(),
        })));
        lock(&session).design = Some(json!({ "review": { "required": true } }));
        let prepared = Prepared {
            operations: Vec::new(),
            design: Value::Null,
            semantic: vec![
                json!({ "slide": 2, "kind": "cover", "plan": { "slide": 2 }, "composition": { "name": "a" } }),
                json!({ "slide": 1, "kind": "body", "slideRole": "content", "plan": { "slide": 1, "kind": "old" } }),
                json!({ "slide": 0, "plan": { "slide": 0 } }),
            ],
            template_data: Vec::new(),
            scratch: Vec::new(),
        };
        record_design_state(&session, "pptx", &prepared);
        let held = lock(&session);
        assert_eq!(held.design_state.semantic_count, 3);
        assert!(held.design_state.requires_visual_review);
        assert_eq!(held.design_state.compositions, [json!({ "name": "a" })]);
        assert_eq!(held.design_state.slide_plans, Some(vec![json!({ "slide": 1, "kind": "body", "slideRole": "content" }), json!({ "slide": 2, "kind": "cover" })]));
    }
}
