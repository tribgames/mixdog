//! Finishing an interrupted transaction from its journal: `recoverOfficeTransaction` and `pendingOfficeTransactions` of
//! `core/office-transactions.mjs`.
//!
//! `recover` takes a transaction id and a strategy. `discard` drops the journal, the checkpoint and the baseline PDF and forgets the
//! session. `commit` and `rollback` bring the session back (re-attached to Microsoft Office when it was an Office session) and
//! run the ordinary commit or rollback on it, so the same fingerprint check holds after a restart.

use std::path::Path;
use std::sync::{Arc, Mutex};

use mixdog_fsio::WriteLane;
use mixdog_js::{js_to_lowercase, js_trim, value_to_string};
use mixdog_office_base::formats::document_file_kind;
use mixdog_office_base::journal::{list_office_journals, read_office_journal};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use super::{TransactionContext, TransactionError, clear_transaction_artifacts, commit_transaction, rollback_transaction};
use crate::session::mode::OfficeHost;
use crate::session::registry::lock;
use crate::session::working_copy::exists;
use crate::session::{Backend, DesignState, Mode, Session, SessionHandle, SessionInit, SessionState, Transaction, TransactionPhase};
use crate::snapshot::ComHost;

/// `officeJournalSummary(record)`: what a listing shows of one journal.
fn journal_summary(record: &Value) -> Value {
    let transaction = record.get("transaction").filter(|value| truthy(value)).cloned().unwrap_or_else(|| json!({}));
    let session = record.get("session").filter(|value| truthy(value)).cloned().unwrap_or_else(|| json!({}));
    let text = |first: Option<&Value>, second: Option<&Value>| -> Value {
        first.filter(|value| truthy(value)).or(second.filter(|value| truthy(value))).cloned().unwrap_or_else(|| json!(""))
    };
    let phase = record.get("phase").filter(|value| truthy(value)).or(transaction.get("phase").filter(|value| truthy(value))).cloned().unwrap_or_else(|| json!("active"));
    let mut summary = Map::new();
    // `undefined` is left out of the object, as JSON leaves it.
    let mut put = |key: &str, value: Option<&Value>| {
        if let Some(value) = value {
            summary.insert(key.to_owned(), value.clone());
        }
    };
    put("id", record.get("id"));
    put("phase", Some(&phase));
    put("startedAt", record.get("startedAt"));
    put("updatedAt", record.get("updatedAt"));
    put("session", session.get("id"));
    put("format", session.get("format"));
    put("mode", session.get("mode"));
    put("backend", session.get("backend"));
    put("source", session.get("source"));
    put("output", session.get("target"));
    put("checkpoint", Some(&text(record.get("checkpoint"), transaction.get("checkpoint"))));
    put("baselinePdf", Some(&text(record.get("baselinePdf"), transaction.get("baselinePdf"))));
    put("diff", Some(&transaction.get("diff").filter(|value| truthy(value)).cloned().unwrap_or(Value::Null)));
    put("review", Some(&transaction.get("review").filter(|value| truthy(value)).cloned().unwrap_or(Value::Null)));
    Value::Object(summary)
}

/// `pendingOfficeTransactions(dataDir)`: the journals on disk (the ones older than 30 days are removed first), newest first.
pub fn pending_office_transactions<L: WriteLane, H>(cx: &TransactionContext<'_, L, H>, data_dir: &Path) -> Result<Vec<Value>, String> {
    let records = list_office_journals(cx.lane(), data_dir, true).map_err(|error| error.to_string())?;
    Ok(records.iter().map(journal_summary).collect())
}

fn text_of(value: Option<&Value>) -> String {
    value.filter(|value| truthy(value)).map(value_to_string).unwrap_or_default()
}

/// `Transaction` of what a journal saved: the fields a journal records, the phase the record names.
fn saved_transaction(id: &str, record: &Value, saved: &Value) -> Transaction {
    let field = |name: &str| saved.get(name).cloned().unwrap_or(Value::Null);
    let first = |name: &str| {
        let own = text_of(saved.get(name));
        if own.is_empty() { text_of(record.get(name)) } else { own }
    };
    let phase = record.get("phase").filter(|phase| truthy(phase)).or(saved.get("phase")).and_then(Value::as_str).map_or(TransactionPhase::Active, TransactionPhase::parse);
    Transaction {
        id: id.to_owned(),
        started_at: text_of(saved.get("startedAt")),
        checkpoint: first("checkpoint"),
        baseline_pdf: first("baselinePdf"),
        before_fingerprint: field("beforeFingerprint"),
        expected_fingerprint: field("expectedFingerprint"),
        before_document: field("beforeDocument"),
        current_document: field("currentDocument"),
        operation_changes: saved.get("operationChanges").and_then(Value::as_array).cloned().unwrap_or_default(),
        undo_units: saved.get("undoUnits").and_then(Value::as_u64).unwrap_or(0),
        diff: field("diff"),
        phase,
        review: saved.get("review").filter(|review| !review.is_null()).cloned(),
        journal_path: None,
    }
}

/// A session rebuilt from what a journal saved of it.
fn saved_session(saved: &Value, data_dir: &Path) -> Session {
    let target = text_of(saved.get("target"));
    let format = text_of(saved.get("format"));
    let own_dir = text_of(saved.get("dataDir"));
    Session::new(SessionInit {
        id: text_of(saved.get("id")),
        source: text_of(saved.get("source")),
        file_kind: document_file_kind(&target).unwrap_or_else(|_| format.clone()),
        target,
        format,
        mode: Mode::parse(&text_of(saved.get("mode"))).unwrap_or(Mode::Portable),
        backend: Backend::parse(&text_of(saved.get("backend"))).unwrap_or(Backend::MixdogOoxml),
        opened_at: text_of(saved.get("openedAt")),
        data_dir: if own_dir.is_empty() { data_dir.to_path_buf() } else { own_dir.into() },
        created: saved.get("created") == Some(&Value::Bool(true)),
        created_new_file: None,
        design_state: DesignState::default(),
    })
}

/// The long answer to a recover without a transaction id: what `recover` is, and what to do about a damaged document.
const RECOVER_NEEDS_ID: &str = "recover finishes an interrupted Office transaction and needs its transaction id. Call office with {\"action\":\"transactions\"} to list pending ones. A damaged document is a different matter: it cannot be repaired here — ask for an intact copy, or open it in Microsoft Office and save a fresh file.";

/// `recoverOfficeTransaction(args, dataDir)`: `args.transaction` is the id and `args.strategy` one of `commit`, `rollback`,
/// `discard`. A live Office document that is no longer open is answered, not failed: a commit finalizes the journal without
/// touching the disk, a rollback says to reopen the document.
pub async fn recover_office_transaction<L: WriteLane, H: ComHost + OfficeHost>(cx: &TransactionContext<'_, L, H>, args: &Value, data_dir: &Path) -> Result<Value, TransactionError> {
    let id = js_trim(&text_of(args.get("transaction"))).to_owned();
    if id.is_empty() {
        return Err(RECOVER_NEEDS_ID.into());
    }
    let strategy = js_to_lowercase(&text_of(args.get("strategy")));
    if !["commit", "rollback", "discard"].contains(&strategy.as_str()) {
        return Err("recover requires strategy: commit, rollback, or discard".into());
    }
    let lane = cx.lane();
    let Some(record) = read_office_journal(lane, &id, data_dir).map_err(|error| error.to_string())? else {
        return Err(format!("Office transaction journal not found: {id}").into());
    };
    let empty = json!({});
    let saved_session_value = record.get("session").filter(|value| truthy(value)).unwrap_or(&empty);
    let saved_transaction_value = record.get("transaction").filter(|value| truthy(value)).unwrap_or(&empty);
    let session_id = text_of(saved_session_value.get("id"));
    let handle: SessionHandle = cx.registry.get(&session_id).unwrap_or_else(|| Arc::new(Mutex::new(saved_session(saved_session_value, data_dir))));
    let opened = saved_transaction(&id, &record, saved_transaction_value);
    lock(&handle).state = SessionState::InTransaction(Box::new(opened));
    let saved_data_dir = lock(&handle).data_dir.clone();
    // What the journal itself recorded, for removing its artifacts.
    let (saved_id, saved_checkpoint, saved_baseline) = (text_of(saved_transaction_value.get("id")), text_of(saved_transaction_value.get("checkpoint")), text_of(saved_transaction_value.get("baselinePdf")));
    let clear = |session_dir: &Path| clear_transaction_artifacts(lane, session_dir, &saved_id, &saved_checkpoint, &saved_baseline);
    if strategy == "discard" {
        lock(&handle).state = SessionState::Idle;
        clear(&saved_data_dir);
        cx.registry.remove(&session_id);
        return Ok(json!({ "ok": true, "recovered": true, "discarded": true, "transaction": id }));
    }
    let saved_target = text_of(saved_session_value.get("target"));
    let saved_format = text_of(saved_session_value.get("format"));
    let interactive = Mode::parse(&text_of(saved_session_value.get("mode"))).is_some_and(Mode::is_interactive);
    if interactive {
        let detected = cx.snapshot.com.detect(&saved_format, &saved_target).await;
        let document_open = detected
            .get("applications")
            .and_then(Value::as_array)
            .and_then(|applications| applications.iter().find(|item| item.get("format").and_then(Value::as_str) == Some(saved_format.as_str())))
            .and_then(|application| application.get("documentOpen"))
            .is_some_and(truthy);
        if !document_open {
            if strategy == "commit" {
                lock(&handle).state = SessionState::Idle;
                clear(&saved_data_dir);
                return Ok(json!({
                    "ok": true,
                    "recovered": true,
                    "committed": true,
                    "transaction": id,
                    "documentOpen": false,
                    "message": "The live Office document is no longer open; the journal was finalized without modifying disk.",
                }));
            }
            return Ok(json!({
                "ok": false,
                "code": "live_document_not_open",
                "transaction": id,
                "recoverable": false,
                "message": "Reopen the exact document in Microsoft Office before rolling back this transaction.",
            }));
        }
    } else if !exists(lane, &saved_target) {
        return Ok(json!({ "ok": false, "code": "document_missing", "transaction": id, "recoverable": false, "path": saved_target }));
    }
    let (microsoft_office, session_mode, target) = {
        let session = lock(&handle);
        (session.is_microsoft_office(), session.is_interactive(), session.target.clone())
    };
    if microsoft_office {
        let payload = json!({
            "session": session_id,
            "format": saved_format,
            "mode": if session_mode { "attach" } else { "background" },
            "path": target,
        });
        let signal = lock(&handle).active_signal.clone();
        let reopened = cx.snapshot.com.open_session(&payload, signal.as_ref()).await;
        if !reopened.get("ok").is_some_and(truthy) {
            let reason = text_of(reopened.get("error"));
            let message = if reason.is_empty() { "Unable to restore Microsoft Office session".to_owned() } else { reason };
            return Err(TransactionError::Failed(message));
        }
        let mut session = lock(&handle);
        let isolation = session.com.background_isolation.clone();
        session.apply_com_fields(&reopened);
        session.com.background_isolation = isolation;
    }
    cx.registry.index(cx.env, &handle);
    if strategy == "commit" { commit_transaction(cx, &handle).await } else { rollback_transaction(cx, &handle).await }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_journal_is_summarised_with_the_phase_and_the_checkpoint_it_names() {
        let record = json!({
            "id": "office_tx_1", "phase": "committing", "startedAt": "s", "updatedAt": "u", "checkpoint": "C:/tmp/a.docx",
            "session": { "id": "office_1", "format": "docx", "mode": "portable", "backend": "mixdog-ooxml", "source": "a.docx", "target": "a.mixdog-edit.docx" },
            "transaction": { "diff": { "summary": { "total": 1 } }, "review": null, "baselinePdf": "p.pdf" }
        });
        let summary = journal_summary(&record);
        assert_eq!(summary["phase"], json!("committing"));
        assert_eq!(summary["output"], json!("a.mixdog-edit.docx"));
        assert_eq!(summary["checkpoint"], json!("C:/tmp/a.docx"));
        assert_eq!(summary["baselinePdf"], json!("p.pdf"));
        assert_eq!(summary["review"], Value::Null);
        assert_eq!(summary["diff"]["summary"]["total"], json!(1));
        let bare = journal_summary(&json!({ "id": "x" }));
        assert_eq!(bare["phase"], json!("active"));
        assert_eq!(bare["checkpoint"], json!(""));
        assert_eq!(bare["diff"], Value::Null);
    }

    #[test]
    fn a_saved_transaction_takes_the_checkpoint_of_the_record_when_it_has_none() {
        let record = json!({ "phase": "rolling_back", "checkpoint": "C:/tmp/cp.xlsx" });
        let saved = json!({ "startedAt": "s", "undoUnits": 3, "operationChanges": [{ "path": "/" }] });
        let held = saved_transaction("office_tx_9", &record, &saved);
        assert_eq!(held.checkpoint, "C:/tmp/cp.xlsx");
        assert_eq!(held.phase, TransactionPhase::RollingBack);
        assert_eq!(held.undo_units, 3);
        assert_eq!(held.operation_changes.len(), 1);
        assert!(held.review.is_none());
    }

    #[test]
    fn a_recovered_session_is_rebuilt_from_what_the_journal_saved() {
        let saved = json!({ "id": "office_1", "source": "a.xlsx", "target": "a.mixdog-edit.xlsx", "format": "xlsx", "mode": "background", "backend": "microsoft-office-com", "created": true, "openedAt": "t" });
        let session = saved_session(&saved, Path::new("data"));
        assert!(session.is_microsoft_office() && !session.is_interactive() && session.created);
        assert_eq!(session.data_dir, Path::new("data"));
        assert_eq!(session.format, "xlsx");
    }
}
