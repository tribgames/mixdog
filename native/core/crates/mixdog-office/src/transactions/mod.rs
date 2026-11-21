//! Office transactions: begin, commit, rollback and the journal that lets one finish after a restart
//! (`core/office-transactions.mjs`).
//!
//! A transaction is a checkpoint of the document taken before any edit (a copy in the temporary folder named
//! `mixdog-office-transaction-<session>-<uuid>.<ext>`), the document read as the model sees it, its fingerprint and a journal
//! record at `<data dir>/office-transactions/<id>.json`. Every batch moves the expected fingerprint on; a commit or a
//! rollback that finds the document at another fingerprint refuses (`transaction_conflict`, with the diff of what changed
//! outside) rather than overwrite what a person did meanwhile. The order of the journal is the contract: the record is
//! written before anything mutates, and the phases `committing` and `rolling_back` are on disk before the work they name.
//!
//! - [`documents`]: the fingerprint, the diff of two reads of a document (at most 500 entries) and the paths an operation touches.
//! - [`recover`]: finishing (`commit`, `rollback`) or dropping (`discard`) a transaction from its journal, after a restart too.
//!
//! The functions are async only for the Microsoft Office host's answers; the session's lock is never held across one.

pub mod documents;
pub mod recover;

use std::fmt;
use std::path::{Path, PathBuf};

use mixdog_fsio::WriteProof;
use mixdog_js::{json_stringify, value_to_string};
use mixdog_office_base::envelope::{CONFLICT_MESSAGE, OfficeConflictError};
use mixdog_office_base::ids::office_transaction_id;
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_design::library::{Environment, iso_string};
use mixdog_ooxml::fingerprint::document_fingerprint;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use self::documents::{diff, document_snapshot_fingerprint, operation_change_kind, operation_document_paths};
use crate::session::registry::{Registry, lock};
use crate::session::{SessionHandle, SessionState, Transaction, TransactionPhase};
use crate::snapshot::{ComHost, SnapshotContext, snapshot};

pub use self::recover::{pending_office_transactions, recover_office_transaction};

/// Why a transaction call failed: the document changed outside the transaction (the caller returns the conflict's details as
/// the result) or a message.
#[derive(Debug, Clone, PartialEq)]
pub enum TransactionError {
    Conflict(OfficeConflictError),
    Failed(String),
}

impl fmt::Display for TransactionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransactionError::Conflict(_) => f.write_str(CONFLICT_MESSAGE),
            TransactionError::Failed(message) => f.write_str(message),
        }
    }
}

impl From<String> for TransactionError {
    fn from(message: String) -> Self {
        TransactionError::Failed(message)
    }
}

impl From<&str> for TransactionError {
    fn from(message: &str) -> Self {
        TransactionError::Failed(message.to_owned())
    }
}

/// What a transaction call runs with: the snapshot context (the lane proof, the text measurer, the form vocabulary and the
/// Office host), the write note of the call, the sessions and the environment (the clock).
pub struct TransactionContext<'a, P: WriteProof, H> {
    pub snapshot: &'a SnapshotContext<'a, P, H>,
    pub note: &'a dyn WriteNote,
    pub registry: &'a Registry,
    pub env: &'a Environment,
}

impl<P: WriteProof, H> TransactionContext<'_, P, H> {
    pub(crate) fn lane(&self) -> &P {
        self.snapshot.proof
    }

    /// `new Date().toISOString()`.
    pub(crate) fn now(&self) -> String {
        iso_string((self.env.now_ms)())
    }
}

/// `captureSessionState(session, checkpoint)`: what the document is now.
#[derive(Debug, Clone)]
pub struct CapturedState {
    pub fingerprint: String,
    pub document: Value,
}

/// The facts of a session a capture reads, taken once under the session's lock.
struct Facts {
    id: String,
    format: String,
    mode: &'static str,
    target: String,
    microsoft_office: bool,
    interactive: bool,
    signal: Option<CancellationToken>,
}

impl Facts {
    fn of(handle: &SessionHandle) -> Self {
        let session = lock(handle);
        Self {
            id: session.id.clone(),
            format: session.format.clone(),
            mode: session.mode.as_str(),
            target: session.target.clone(),
            microsoft_office: session.is_microsoft_office(),
            interactive: session.is_interactive(),
            signal: session.active_signal.clone(),
        }
    }

    /// `{ session, format, mode, path }` of a call to the Office host, then the request's own fields.
    fn request(&self, action: &str, extra: &[(&str, Value)]) -> Value {
        let mut payload = Map::new();
        payload.insert("action".to_owned(), json!(action));
        payload.insert("session".to_owned(), json!(self.id));
        payload.insert("format".to_owned(), json!(self.format));
        payload.insert("mode".to_owned(), json!(self.mode));
        payload.insert("path".to_owned(), json!(self.target));
        for (key, value) in extra {
            payload.insert((*key).to_owned(), value.clone());
        }
        Value::Object(payload)
    }
}

/// `path.extname(path)`: from the last dot of the file name, nothing when the dot starts the name.
fn extname(path: &str) -> String {
    let name = Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot..].to_owned(),
        _ => String::new(),
    }
}

/// A random token as long as a UUID without its dashes (two transaction ids' digits), for names in the temporary folder.
pub(crate) fn unique_token() -> String {
    let digits = |id: String| id.trim_start_matches("office_tx_").to_owned();
    format!("{}{}", digits(office_transaction_id()), digits(office_transaction_id()))
}

/// `rm(path, { force: true })`: a failure is not reported.
pub(crate) fn remove_quietly<P: WriteProof>(lane: &P, path: &str) {
    if !path.is_empty() {
        let _ = mixdog_fsio::remove_file(lane, path);
    }
}

fn host_error(answer: &Value, fallback: String) -> String {
    answer.get("error").filter(|error| truthy(error)).map_or(fallback, value_to_string)
}

/// The transaction a session holds, or `None`.
fn transaction_of(handle: &SessionHandle) -> Option<Transaction> {
    lock(handle).state.transaction().cloned()
}

/// Runs `change` on the open transaction (a no-op without one).
pub(crate) fn update_transaction(handle: &SessionHandle, change: impl FnOnce(&mut Transaction)) {
    if let Some(transaction) = lock(handle).state.transaction_mut() {
        change(transaction);
    }
}

fn text_field(value: &Value) -> String {
    value.as_str().map(str::to_owned).unwrap_or_default()
}

/// `mergeTransactionDiff(diff, operationChanges, limit)`: the paths the operations named that the read of the document did not
/// show changed are added, as what the checkpoint captured and what the operation did.
fn merge_transaction_diff(document_diff: &Value, operation_changes: &[Value], limit: usize) -> Value {
    let mut summary = document_diff["summary"].as_object().cloned().unwrap_or_default();
    let mut changes: Vec<Value> = document_diff["changes"].as_array().cloned().unwrap_or_default();
    let mut truncated = document_diff["truncated"].clone();
    let mut known: Vec<String> = changes.iter().map(|change| text_field(&change["path"])).collect();
    for change in operation_changes {
        let path = text_field(&change["path"]);
        if known.contains(&path) {
            continue;
        }
        let kind = text_field(&change["kind"]);
        for key in [kind.as_str(), "total"] {
            let count = summary.get(key).and_then(Value::as_u64).unwrap_or(0) + 1;
            summary.insert(key.to_owned(), json!(count));
        }
        if changes.len() < limit {
            changes.push(json!({
                "path": path,
                "kind": kind,
                "before": if kind == "added" { Value::Null } else { json!({ "state": "captured by transaction checkpoint" }) },
                "after": if kind == "removed" { Value::Null } else { json!({ "operation": change["operation"] }) },
            }));
            known.push(path);
        } else {
            truncated = json!(true);
        }
    }
    json!({ "summary": Value::Object(summary), "changes": changes, "truncated": truncated })
}

/// `transactionDocumentDiff(transaction, currentDocument)`.
pub fn transaction_document_diff(transaction: &Transaction, current_document: &Value) -> Value {
    merge_transaction_diff(&diff(&transaction.before_document, current_document), &transaction.operation_changes, documents::DIFF_LIMIT)
}

/// `recordTransactionOperations(transaction, format, operations, results)`: the paths the batch touched are kept on the
/// transaction, a path first added and then modified staying added.
pub fn record_transaction_operations(transaction: &mut Transaction, format: &str, operations: &[Value], results: &[Value]) {
    let mut changes: Vec<Value> = std::mem::take(&mut transaction.operation_changes);
    for (index, operation) in operations.iter().enumerate() {
        let result = results.get(index).filter(|result| truthy(result)).cloned().unwrap_or_else(|| json!({}));
        if result.get("changed") == Some(&Value::Bool(false)) {
            continue;
        }
        let kind = operation_change_kind(operation);
        let op = operation.get("op").filter(|op| truthy(op)).map(value_to_string).unwrap_or_default();
        for path in operation_document_paths(format, operation, &result) {
            let position = changes.iter().position(|change| change["path"] == json!(path));
            let kept = match position.map(|at| changes[at]["kind"].as_str() == Some("added")) {
                Some(true) if kind == "modified" => "added",
                _ => kind,
            };
            let entry = json!({ "path": path, "kind": kept, "operation": op });
            match position {
                Some(at) => changes[at] = entry,
                None => changes.push(entry),
            }
        }
    }
    transaction.operation_changes = changes;
}

/// `transactionView(transaction, diff)`: what a result shows of a transaction.
pub fn transaction_view(transaction: &Transaction, document_diff: Option<&Value>) -> Value {
    json!({
        "id": transaction.id,
        "startedAt": transaction.started_at,
        "conflict": false,
        "undoUnits": transaction.undo_units,
        "diff": document_diff.unwrap_or(&transaction.diff),
    })
}

/// The journal's text of `phase`: the transaction's own, or the one the batch pipeline marks while it applies (`applying`).
fn journal_record(handle: &SessionHandle, now: String, phase: Option<&str>) -> Option<Value> {
    let session = lock(handle);
    let transaction = session.state.transaction()?;
    let phase = phase.unwrap_or_else(|| transaction.phase.as_str());
    let review = transaction.review.clone().unwrap_or(Value::Null);
    Some(json!({
        "version": 1,
        "id": transaction.id,
        "startedAt": transaction.started_at,
        "updatedAt": now,
        "phase": phase,
        "checkpoint": transaction.checkpoint,
        "baselinePdf": transaction.baseline_pdf,
        "session": {
            "id": session.id,
            "source": session.source,
            "target": session.target,
            "format": session.format,
            "mode": session.mode.as_str(),
            "backend": session.backend.as_str(),
            "created": session.created,
            "openedAt": session.opened_at,
            "dataDir": session.data_dir.to_string_lossy(),
        },
        "transaction": {
            "id": transaction.id,
            "startedAt": transaction.started_at,
            "checkpoint": transaction.checkpoint,
            "baselinePdf": transaction.baseline_pdf,
            "beforeFingerprint": transaction.before_fingerprint,
            "expectedFingerprint": transaction.expected_fingerprint,
            "beforeDocument": transaction.before_document,
            "currentDocument": transaction.current_document,
            "operationChanges": transaction.operation_changes,
            "undoUnits": transaction.undo_units,
            "diff": transaction.diff,
            "phase": phase,
            "review": review,
        },
    }))
}

/// `persistOfficeTransaction(session)`: the journal record written. `phase` names the phase the record carries when it is not
/// the transaction's own (the batch marks `applying`).
pub fn persist_office_transaction<P: WriteProof, H>(cx: &TransactionContext<'_, P, H>, handle: &SessionHandle, phase: Option<&str>) -> Result<(), String> {
    let Some(record) = journal_record(handle, cx.now(), phase) else { return Ok(()) };
    let data_dir = lock(handle).data_dir.clone();
    let path = mixdog_office_base::journal::write_office_journal(cx.lane(), &record, &data_dir).map_err(|error| error.to_string())?;
    update_transaction(handle, |transaction| transaction.journal_path = Some(path.to_string_lossy().into_owned()));
    Ok(())
}

/// `clearOfficeTransactionArtifacts(session, transaction)`: the journal, the checkpoint and the baseline PDF removed; a file that
/// cannot be removed is left.
pub(crate) fn clear_transaction_artifacts<P: WriteProof>(lane: &P, data_dir: &Path, id: &str, checkpoint: &str, baseline_pdf: &str) {
    let _ = mixdog_office_base::journal::remove_office_journal(lane, id, data_dir);
    remove_quietly(lane, checkpoint);
    remove_quietly(lane, baseline_pdf);
}

/// `{ ok, session, mode, backend }` of a transaction result.
fn result_head(handle: &SessionHandle) -> Map<String, Value> {
    let session = lock(handle);
    let mut head = Map::new();
    head.insert("ok".to_owned(), json!(true));
    head.insert("session".to_owned(), json!(session.id));
    head.insert("mode".to_owned(), json!(session.mode.as_str()));
    head.insert("backend".to_owned(), json!(session.backend.as_str()));
    head
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transaction() -> Transaction {
        Transaction {
            id: "office_tx_1".to_owned(),
            started_at: "2026-01-01T00:00:00.000Z".to_owned(),
            checkpoint: String::new(),
            baseline_pdf: String::new(),
            before_fingerprint: json!("a"),
            expected_fingerprint: json!("a"),
            before_document: json!({ "path": "/", "rows": [{ "path": "/sheet[S]/cell[A1]", "value": "1" }] }),
            current_document: Value::Null,
            operation_changes: Vec::new(),
            undo_units: 0,
            diff: Value::Null,
            phase: TransactionPhase::Active,
            review: None,
            journal_path: None,
        }
    }

    #[test]
    fn operations_are_recorded_by_path_and_an_added_path_stays_added() {
        let mut held = transaction();
        let operations = [
            json!({ "op": "add_table", "sheet": "S", "cell": "b1" }),
            json!({ "op": "set_cell", "sheet": "S", "cell": "b1" }),
            json!({ "op": "set_cell", "sheet": "S", "cell": "c1" }),
        ];
        let results = [json!({}), json!({}), json!({ "changed": false })];
        record_transaction_operations(&mut held, "xlsx", &operations, &results);
        assert_eq!(held.operation_changes, [json!({ "path": "/sheet[S]/cell[B1]", "kind": "added", "operation": "set_cell" })]);
    }

    #[test]
    fn a_path_the_read_did_not_show_changed_is_added_from_what_the_operations_did() {
        let mut held = transaction();
        held.operation_changes = vec![
            json!({ "path": "/sheet[S]/cell[B1]", "kind": "modified", "operation": "set_cell" }),
            json!({ "path": "/sheet[S]/cell[A1]", "kind": "modified", "operation": "set_cell" }),
        ];
        let current = json!({ "path": "/", "rows": [{ "path": "/sheet[S]/cell[A1]", "value": "2" }] });
        let merged = transaction_document_diff(&held, &current);
        assert_eq!(merged["summary"], json!({ "added": 0, "removed": 0, "modified": 2, "total": 2 }));
        assert_eq!(
            merged["changes"][1],
            json!({ "path": "/sheet[S]/cell[B1]", "kind": "modified", "before": { "state": "captured by transaction checkpoint" }, "after": { "operation": "set_cell" } })
        );
    }

    #[test]
    fn the_merge_marks_the_diff_truncated_past_the_limit() {
        let changes: Vec<Value> = (0..3).map(|index| json!({ "path": format!("/p[{index}]"), "kind": "added", "operation": "add_text" })).collect();
        let merged = merge_transaction_diff(&diff(&Value::Null, &Value::Null), &changes, 2);
        assert_eq!(merged["changes"].as_array().map(Vec::len), Some(2));
        assert_eq!(merged["truncated"], json!(true));
        assert_eq!(merged["summary"]["total"], json!(3));
        assert_eq!(merged["changes"][0]["before"], Value::Null);
    }

    #[test]
    fn a_view_shows_the_given_diff_or_the_transactions_own() {
        let mut held = transaction();
        held.diff = json!({ "own": true });
        assert_eq!(transaction_view(&held, None)["diff"], json!({ "own": true }));
        assert_eq!(transaction_view(&held, Some(&json!({ "given": 1 })))["diff"], json!({ "given": 1 }));
        assert_eq!(transaction_view(&held, None)["conflict"], json!(false));
    }

    #[test]
    fn the_checkpoint_keeps_the_documents_extension_and_a_name_is_unique() {
        assert_eq!(extname("C:\\work\\a.b.docx"), ".docx");
        // `/` separates on every host; a backslash only on Windows (`C:\work\.hidden` is one file name elsewhere).
        assert_eq!(extname("/work/.hidden"), "");
        assert_ne!(unique_token(), unique_token());
        assert_eq!(unique_token().len(), 32);
    }

    #[test]
    fn a_conflict_displays_as_node_words_it() {
        let error = TransactionError::Conflict(OfficeConflictError::new(json!({ "code": "transaction_conflict" })));
        assert_eq!(error.to_string(), "Office transaction conflict: the document changed outside this transaction");
        assert_eq!(TransactionError::from("x").to_string(), "x");
    }
}

impl std::error::Error for TransactionError {}
/// `transactionCheckpointPath(session)`: `<tmp>/mixdog-office-transaction-<session>-<uuid><ext>`.
fn transaction_checkpoint_path(facts: &Facts) -> PathBuf {
    std::env::temp_dir().join(format!("mixdog-office-transaction-{}-{}{}", facts.id, unique_token(), extname(&facts.target)))
}
/// `captureSessionState(session, checkpoint)`: the document read and fingerprinted. With a `checkpoint` path the document is also
/// copied (a portable one) or saved (an Office workbook or deck) there first, so the fingerprint is the checkpoint's.
pub async fn capture_session_state<P: WriteProof, H: ComHost>(
    cx: &TransactionContext<'_, P, H>,
    handle: &SessionHandle,
    checkpoint: &str,
) -> Result<CapturedState, String> {
    let facts = Facts::of(handle);
    let lane = cx.lane();
    if facts.microsoft_office {
        let file_backed = matches!(facts.format.as_str(), "xlsx" | "pptx");
        let temporary = if checkpoint.is_empty() && file_backed { transaction_checkpoint_path(&facts).to_string_lossy().into_owned() } else { String::new() };
        let snapshot_path = if checkpoint.is_empty() { temporary.clone() } else { checkpoint.to_owned() };
        let action = if snapshot_path.is_empty() { "snapshot" } else { "checkpoint" };
        let extra: Vec<(&str, Value)> = if snapshot_path.is_empty() { Vec::new() } else { vec![("output", json!(snapshot_path))] };
        let answer = cx.snapshot.com.call(&facts.request(action, &extra), facts.signal.as_ref(), None).await;
        if !answer.get("ok").is_some_and(truthy) {
            return Err(host_error(&answer, format!("Microsoft Office {action} failed")));
        }
        let document = answer.get("value").cloned().unwrap_or(Value::Null);
        let fingerprint = if file_backed {
            let source = if snapshot_path.is_empty() { facts.target.as_str() } else { snapshot_path.as_str() };
            document_fingerprint(lane, Path::new(source), &facts.format)
        } else {
            Ok(document_snapshot_fingerprint(&document))
        };
        remove_quietly(lane, &temporary);
        return Ok(CapturedState { fingerprint: fingerprint?, document });
    }
    if !checkpoint.is_empty() {
        mixdog_fsio::copy(lane, &facts.target, checkpoint).map_err(|error| error.to_string())?;
    }
    let current = snapshot(cx.snapshot, handle, &json!({ "maxChars": 100_000 }), true).await?;
    let document = current.get("document").cloned().unwrap_or(Value::Null);
    let fingerprint_path = if checkpoint.is_empty() { facts.target.as_str() } else { checkpoint };
    Ok(CapturedState { fingerprint: document_fingerprint(lane, Path::new(fingerprint_path), &facts.format)?, document })
}
/// `assertTransactionUnchanged(session)`: the document is read again; it must be the one the last operation left. Answers the
/// read, or `None` when no transaction is open.
pub async fn assert_transaction_unchanged<P: WriteProof, H: ComHost>(
    cx: &TransactionContext<'_, P, H>,
    handle: &SessionHandle,
) -> Result<Option<CapturedState>, TransactionError> {
    let Some(transaction) = transaction_of(handle) else { return Ok(None) };
    let current = capture_session_state(cx, handle, "").await?;
    if json!(current.fingerprint) != transaction.expected_fingerprint {
        let (id, format) = {
            let session = lock(handle);
            (session.id.clone(), session.format.clone())
        };
        return Err(TransactionError::Conflict(OfficeConflictError::new(json!({
            "ok": false,
            "code": "transaction_conflict",
            "session": id,
            "format": format,
            "transaction": transaction.id,
            "expectedFingerprint": transaction.expected_fingerprint,
            "actualFingerprint": current.fingerprint,
            "externalDiff": diff(&transaction.current_document, &current.document),
            "message": "The document changed outside Mixdog after the last transaction operation. Commit and rollback are blocked to avoid overwriting user edits.",
        }))));
    }
    Ok(Some(current))
}
/// `beginTransaction(session)`: the checkpoint, the fingerprint and the full read of the document, a baseline PDF of a Word
/// document open in the user's own window, and the journal record written before anything mutates.
pub async fn begin_transaction<P: WriteProof, H: ComHost>(cx: &TransactionContext<'_, P, H>, handle: &SessionHandle) -> Result<Value, TransactionError> {
    if let Some(open) = transaction_of(handle) {
        return Err(TransactionError::Failed(format!("Office transaction already active: {}", open.id)));
    }
    let facts = Facts::of(handle);
    let checkpoint = transaction_checkpoint_path(&facts).to_string_lossy().into_owned();
    let state = capture_session_state(cx, handle, &checkpoint).await?;
    let mut baseline_pdf = String::new();
    if facts.microsoft_office && facts.interactive && facts.format == "docx" {
        let path = std::env::temp_dir().join(format!("mixdog-office-transaction-{}-{}-before.pdf", facts.id, unique_token())).to_string_lossy().into_owned();
        let rendered = cx.snapshot.com.call(&facts.request("render", &[("output", json!(path))]), facts.signal.as_ref(), None).await;
        if rendered.get("ok").is_some_and(truthy) {
            baseline_pdf = path;
        }
    }
    let transaction = Transaction {
        id: office_transaction_id(),
        started_at: cx.now(),
        checkpoint: checkpoint.clone(),
        baseline_pdf,
        before_fingerprint: json!(state.fingerprint),
        expected_fingerprint: json!(state.fingerprint),
        before_document: state.document.clone(),
        current_document: state.document.clone(),
        operation_changes: Vec::new(),
        undo_units: 0,
        diff: diff(&state.document, &state.document),
        phase: TransactionPhase::Active,
        review: None,
        journal_path: None,
    };
    lock(handle).state = SessionState::InTransaction(Box::new(transaction));
    if let Err(error) = persist_office_transaction(cx, handle, None) {
        lock(handle).state.close();
        remove_quietly(cx.lane(), &checkpoint);
        return Err(TransactionError::Failed(error));
    }
    let opened = transaction_of(handle).ok_or("The transaction vanished")?;
    let mut result = result_head(handle);
    result.insert("transaction".to_owned(), transaction_view(&opened, None));
    Ok(Value::Object(result))
}
/// `commitTransaction(session)`: the document must be the one the last operation left; the journal says `committing` before the
/// transaction is closed and its artifacts removed.
pub async fn commit_transaction<P: WriteProof, H: ComHost>(cx: &TransactionContext<'_, P, H>, handle: &SessionHandle) -> Result<Value, TransactionError> {
    let Some(opened) = transaction_of(handle) else { return Err("No active Office transaction to commit".into()) };
    let current = assert_transaction_unchanged(cx, handle).await?.ok_or("No active Office transaction to commit")?;
    let document_diff = transaction_document_diff(&opened, &current.document);
    update_transaction(handle, |transaction| {
        transaction.diff = document_diff;
        transaction.current_document = current.document.clone();
        transaction.phase = TransactionPhase::Committing;
    });
    persist_office_transaction(cx, handle, None)?;
    let (transaction, data_dir, saved) = {
        let mut session = lock(handle);
        let transaction = session.state.close().ok_or("No active Office transaction to commit")?;
        session.snapshot_version += 1;
        (transaction, session.data_dir.clone(), !session.is_interactive())
    };
    clear_transaction_artifacts(cx.lane(), &data_dir, &transaction.id, &transaction.checkpoint, &transaction.baseline_pdf);
    let mut result = result_head(handle);
    result.insert("committed".to_owned(), json!(true));
    result.insert("saved".to_owned(), json!(saved));
    result.insert("transaction".to_owned(), transaction_view(&transaction, None));
    Ok(Value::Object(result))
}
/// `rollbackTransaction(session)`: the checkpoint restored (a copy for a portable document, Office's own undo for a live one),
/// read again and held to the document it was: a difference that remains fails the call with the diff in its message.
pub async fn rollback_transaction<P: WriteProof, H: ComHost>(cx: &TransactionContext<'_, P, H>, handle: &SessionHandle) -> Result<Value, TransactionError> {
    let Some(opened) = transaction_of(handle) else { return Err("No active Office transaction to roll back".into()) };
    let current = assert_transaction_unchanged(cx, handle).await?.ok_or("No active Office transaction to roll back")?;
    let mut transaction = opened;
    transaction.current_document = current.document.clone();
    transaction.diff = transaction_document_diff(&transaction, &current.document);
    transaction.phase = TransactionPhase::RollingBack;
    update_transaction(handle, |held| *held = transaction.clone());
    persist_office_transaction(cx, handle, None)?;
    let facts = Facts::of(handle);
    // A recovered rollback restores the document outside any session verb.
    cx.note.note_write(Path::new(&facts.target));
    if facts.microsoft_office {
        let request = facts.request("rollback", &[("checkpoint", json!(transaction.checkpoint)), ("undoUnits", json!(transaction.undo_units))]);
        let answer = cx.snapshot.com.call(&request, facts.signal.as_ref(), None).await;
        if !answer.get("ok").is_some_and(truthy) {
            return Err(TransactionError::Failed(host_error(&answer, "Microsoft Office rollback failed".to_owned())));
        }
    } else {
        mixdog_fsio::copy(cx.lane(), &transaction.checkpoint, &facts.target).map_err(|error| error.to_string())?;
    }
    // The checkpoint restored the document behind the snapshot version.
    lock(handle).caches.snapshot = None;
    let restored = capture_session_state(cx, handle, "").await?;
    let remaining = diff(&transaction.before_document, &restored.document);
    let fingerprint_restored = json!(restored.fingerprint) == transaction.before_fingerprint;
    if remaining["summary"]["total"].as_u64().unwrap_or(0) > 0 {
        return Err(TransactionError::Failed(format!(
            "Office rollback verification failed: fingerprintRestored={fingerprint_restored}; diff={}",
            json_stringify(&remaining)
        )));
    }
    let data_dir = {
        let mut session = lock(handle);
        session.state.close();
        session.data_dir.clone()
    };
    clear_transaction_artifacts(cx.lane(), &data_dir, &transaction.id, &transaction.checkpoint, &transaction.baseline_pdf);
    let undone = diff(&transaction.before_document, &transaction.current_document);
    let mut result = result_head(handle);
    result.insert("rolledBack".to_owned(), json!(true));
    result.insert("fingerprintRestored".to_owned(), json!(fingerprint_restored));
    result.insert("fingerprintDrift".to_owned(), json!(!fingerprint_restored));
    result.insert("remainingDiff".to_owned(), remaining);
    result.insert("transaction".to_owned(), transaction_view(&transaction, Some(&undone)));
    Ok(Value::Object(result))
}
