//! One resolved session, one action: the transaction verbs (begin, diff, commit, rollback), the read verbs (snapshot, get, query,
//! issues, validate, render, describe) and the write verbs (batch, qa, save, finalize, close). Session resolution, design hydration
//! and result finalization stay with the caller (`core/office-session-dispatch.mjs`).

use std::path::Path;

use mixdog_fsio::WriteProof;
use mixdog_office_author::source_drift::HtmlSource;
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use crate::actions::{Host, Machine};
use crate::author::AuthorHost;
use crate::batch::{BatchHost, apply_batch};
use crate::describe::{DescribeRequest, describe_office_capabilities};
use crate::inspect::{get_office_element, issues, query_office_document, text_arg, validate};
use crate::render::RenderEngine;
use crate::session::SessionHandle;
use crate::session::open::SessionCloser;
use crate::session::registry::lock;
use crate::snapshot::snapshot;
use crate::transactions::{
    TransactionError, assert_transaction_unchanged, begin_transaction, commit_transaction, rollback_transaction, transaction_document_diff, transaction_view,
};

/// Verbs that never write the session's document.
const READ_ACTIONS: [&str; 8] = ["describe", "begin", "diff", "snapshot", "get", "query", "issues", "validate"];

impl<P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, P, H, C, R, B> {
    /// `diffTransaction(session)`: what the document looks like now against the transaction's checkpoint.
    async fn diff_transaction(&self, handle: &SessionHandle) -> Result<Value, TransactionError> {
        if lock(handle).state.transaction().is_none() {
            return Err("No active Office transaction to diff".into());
        }
        let Some(current) = assert_transaction_unchanged(&self.batch.transactions(), handle).await? else {
            return Err("No active Office transaction to diff".into());
        };
        let mut session = lock(handle);
        let id = session.id.clone();
        let Some(transaction) = session.state.transaction_mut() else { return Err("No active Office transaction to diff".into()) };
        transaction.current_document = current.document.clone();
        transaction.diff = transaction_document_diff(transaction, &current.document);
        Ok(json!({ "ok": true, "session": id, "transaction": transaction_view(transaction, None) }))
    }

    /// `batchAction(session, args, cwd, signal)`: batch with `finalize: true` is one action: the batch runs with save forced on, and
    /// finalize is told the save already happened so it does not repeat it.
    pub(crate) async fn batch_action(&self, handle: &SessionHandle, args: &Value, cwd: &str) -> Result<Value, TransactionError> {
        let finalizing = args.get("finalize") == Some(&Value::Bool(true));
        if finalizing && lock(handle).state.transaction().is_some() {
            return Err("Commit or roll back the active Office transaction before using batch with finalize:true".into());
        }
        let mut request = args.as_object().cloned().unwrap_or_default();
        request.insert("__cwd".to_owned(), Value::String(cwd.to_owned()));
        if finalizing {
            request.insert("save".to_owned(), Value::Bool(true));
        }
        let mut batch = apply_batch(self.batch, handle, &Value::Object(request)).await?;
        let drift = {
            let mut session = lock(handle);
            let mut source = HtmlSource { source: session.authored.html_source.clone(), edits: session.authored.html_source_edits as f64 };
            let drift = source.note_batch_against_html(&batch);
            session.authored.html_source_edits = source.edits as u64;
            drift
        };
        if let (Some(drift), Some(fields)) = (drift, batch.as_object_mut()) {
            fields.insert("htmlSource".to_owned(), drift);
        }
        if !finalizing {
            return Ok(batch);
        }
        let mut next = args.as_object().cloned().unwrap_or_default();
        next.insert("__alreadySaved".to_owned(), Value::Bool(batch.get("saved") == Some(&Value::Bool(true))));
        let mut completed = self.finalize(handle, &Value::Object(next), cwd).await?;
        if let Some(fields) = completed.as_object_mut() {
            fields.insert("batch".to_owned(), batch);
        }
        Ok(completed)
    }

    /// `dispatchOfficeSessionAction({ action, session, args, cwd, signal })`.
    pub async fn dispatch_session_action(&self, action: &str, handle: &SessionHandle, args: &Value, cwd: &str, signal: Option<&CancellationToken>) -> Result<Value, TransactionError> {
        // Write receipt: every other verb may write the session's document (an edit, save, rollback, autoFix, or a render that
        // numbers its contents).
        if !READ_ACTIONS.contains(&action) {
            let target = lock(handle).target.clone();
            self.note().note_write(Path::new(&target));
        }
        let inspect = self.inspect();
        let transactions = self.batch.transactions();
        match action {
            "describe" => {
                let (format, backend) = {
                    let session = lock(handle);
                    (session.format.clone(), session.backend.as_str())
                };
                let (target, operation) = (text_arg(args, "target"), text_arg(args, "operation"));
                Ok(describe_office_capabilities(&DescribeRequest { format: &format, backend, target: &target, operation: &operation })?)
            }
            "begin" => begin_transaction(&transactions, handle).await,
            "diff" => self.diff_transaction(handle).await,
            "commit" => commit_transaction(&transactions, handle).await,
            "rollback" => rollback_transaction(&transactions, handle).await,
            "snapshot" => Ok(snapshot(&inspect.snapshot, handle, args, false).await?),
            "get" => Ok(get_office_element(inspect, handle, args).await?),
            "query" => Ok(query_office_document(inspect, handle, args, Path::new(cwd), self.note()).await?),
            "batch" => self.batch_action(handle, args, cwd).await,
            "issues" => Ok(issues(inspect, handle, args).await?),
            "qa" => self.qa(handle, args, cwd, false).await,
            "validate" => Ok(validate(inspect, handle, args).await?),
            "render" => Ok(AuthorHost::render(self.author, handle, args, Path::new(cwd)).await?),
            "save" => self.save(handle).await,
            "finalize" => self.finalize(handle, args, cwd).await,
            "close" => self.close(handle, args.get("save") == Some(&Value::Bool(true)), signal).await,
            _ => {
                let shown = if action.is_empty() { "(missing)".to_owned() } else { action.to_owned() };
                Err(format!("Unsupported Office Use action \"{shown}\". Use action:\"describe\" to inspect capabilities.").into())
            }
        }
    }
}
