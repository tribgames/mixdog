//! `create`, `open` and `attach` share one path: bind a session, optionally apply the operations this call named, then snapshot or
//! finalize (`core/office-actions-open.mjs`).

use std::time::Instant;

use mixdog_fsio::WriteLane;
use mixdog_js::to_number_of;
use mixdog_office_base::values::truthy;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value};

use crate::actions::{ComSessions, Host, Machine};
use crate::batch::{BatchHost, apply_batch};
use crate::render::RenderEngine;
use crate::session::create::{create_session, initial_office_operations, remove_failed_create};
use crate::session::open::{OpenedSession, SessionCloser, SessionEnv, open_session};
use crate::session::registry::lock;
use crate::session::{EnsureOptions, Session, SessionHandle, ensure_office_session_design};
use crate::snapshot::snapshot;
use crate::transactions::TransactionError;

/// The identity every answer of the three actions carries (`openedOfficeIdentity(session, action, extra)`).
fn opened_identity(session: &Session, action: &str, reused: bool, extra: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut identity = Map::new();
    identity.insert("opened".to_owned(), Value::Bool(true));
    identity.insert("created".to_owned(), Value::Bool(action == "create"));
    identity.insert("reused".to_owned(), Value::Bool(reused));
    if !session.converted_from.is_empty() {
        identity.insert("convertedFrom".to_owned(), Value::String(session.converted_from.clone()));
    }
    if let Some(Value::Object(receipt)) = &session.create_receipt {
        identity.extend(receipt.clone());
    }
    for (key, value) in extra {
        identity.insert(key.to_owned(), value);
    }
    identity
}

/// `{ mode, ownership, visible, appPid, windowHwnd, foregroundActivated, backgroundIsolation, documentId }` of a session
/// (`microsoftOfficeOpenFields(session)`): its mode is always there, the rest as the Office host named it.
fn open_fields(session: &Session) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("mode".to_owned(), Value::String(session.mode.as_str().to_owned()));
    if let Value::Object(com) = session.com.to_value() {
        fields.extend(com.into_iter().filter(|(key, _)| key != "mode"));
    }
    fields
}

/// `{ ...args, key: value }`.
fn with_field(args: &Value, key: &str, value: Value) -> Value {
    let mut fields = args.as_object().cloned().unwrap_or_default();
    fields.insert(key.to_owned(), value);
    Value::Object(fields)
}

/// The call's arguments as the rest of a create reads them: the contract engine rewrote the initial operations in place (the call's
/// `operations`, or `design.operations` when those were the ones taken).
fn with_operations(args: &Value, operations: &[Value]) -> Value {
    let mut rewritten = args.clone();
    let listed = args.get("operations").and_then(Value::as_array).is_some_and(|operations| !operations.is_empty());
    let slot = if listed {
        rewritten.get_mut("operations")
    } else if args.pointer("/design/operations").is_some_and(Value::is_array) {
        rewritten.pointer_mut("/design/operations")
    } else {
        None
    };
    if let Some(slot) = slot {
        *slot = Value::Array(operations.to_vec());
    }
    rewritten
}

impl<L: WriteLane, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, L, H, C, R, B> {
    pub(crate) fn call_env<'e>(&'e self, signal: Option<&'e CancellationToken>) -> SessionEnv<'e, L, H> {
        let env = &self.author.env;
        SessionEnv { design: env.design, note: env.note, registry: env.registry, host: env.host, legacy: env.legacy, data_dir: env.data_dir, cwd: env.cwd, cancel: signal }
    }

    /// `discardFailedOfficeSession(session, { action, initialEditSettled })`.
    async fn discard_failed_session(&self, opened: &OpenedSession, action: &str, initial_edit_settled: bool) {
        if opened.reused {
            return;
        }
        let (id, microsoft_office) = {
            let session = lock(&opened.handle);
            (session.id.clone(), session.is_microsoft_office())
        };
        if microsoft_office {
            let _ = ComSessions::close_session(self.host(), &id, false, None).await;
        }
        self.registry().release(self.environment(), &opened.handle);
        self.forget(&opened.handle);
        // A create whose own operations failed must not leave the empty file it just wrote: the obvious retry would hit "target
        // already exists" and the caller would be stuck choosing between overwrite and delete. Only a file this call brought into
        // being is removed.
        if action == "create" {
            remove_failed_create(self.design().lane, opened, initial_edit_settled);
        }
    }

    /// `openCreateOrAttachOffice({ action, args, cwd, dataDir, signal, startedAt })`: the answer as a tool result.
    pub async fn open_create_or_attach(&self, action: &str, args: &Value, cwd: &str, signal: Option<&CancellationToken>, started: Instant) -> Result<Value, TransactionError> {
        if action == "attach" && args.get("finalize") == Some(&Value::Bool(true)) {
            return Err("attach does not support finalize:true; attach first, then use batch with finalize:true when closing the document is intended".into());
        }
        let env = self.call_env(signal);
        let (opened, operations, args) = match action {
            "create" => {
                let created = create_session(&env, self.tools, args).await?;
                let rewritten = with_operations(args, &created.operations);
                (created.session, created.operations, rewritten)
            }
            "attach" => (open_session(&env, &with_field(args, "mode", Value::String("attach".to_owned())), false).await?, initial_office_operations(args), args.clone()),
            _ => (open_session(&env, args, false).await?, initial_office_operations(args), args.clone()),
        };
        let handle = opened.handle.clone();
        {
            let mut session = lock(&handle);
            let created = session.created;
            ensure_office_session_design(self.design(), self.data_dir(), &mut session, &args, EnsureOptions { created: Some(created), ..EnsureOptions::default() })?;
            session.active_signal = signal.cloned();
        }
        let mut settled = false;
        let outcome = self.open_flow(&opened, action, &args, operations, cwd, started, &mut settled).await;
        lock(&handle).active_signal = None;
        if outcome.is_err() {
            self.discard_failed_session(&opened, action, settled).await;
        }
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    async fn open_flow(&self, opened: &OpenedSession, action: &str, args: &Value, operations: Vec<Value>, cwd: &str, started: Instant, settled: &mut bool) -> Result<Value, TransactionError> {
        let handle: &SessionHandle = &opened.handle;
        let finalizing = args.get("finalize") == Some(&Value::Bool(true));
        let mut initial_edit: Option<Value> = None;
        if !operations.is_empty() {
            let mut request = args.as_object().cloned().unwrap_or_default();
            request.insert("operations".to_owned(), Value::Array(operations));
            request.insert("__cwd".to_owned(), Value::String(cwd.to_owned()));
            if finalizing {
                request.insert("save".to_owned(), Value::Bool(true));
            }
            initial_edit = Some(apply_batch(self.batch, handle, &Value::Object(request)).await?);
        }
        *settled = true;
        if finalizing {
            let mut next = args.as_object().cloned().unwrap_or_default();
            next.insert("__alreadySaved".to_owned(), Value::Bool(initial_edit.as_ref().and_then(|edit| edit.get("saved")) == Some(&Value::Bool(true))));
            let mut completed = self.finalize(handle, &Value::Object(next), cwd).await?;
            let images = super::take_images(&mut completed);
            lock(handle).active_signal = None;
            let mut answer = completed.as_object().cloned().unwrap_or_default();
            let extra = initial_edit.map(|edit| vec![("batch", edit)]).unwrap_or_default();
            answer.extend(opened_identity(&lock(handle), action, opened.reused, extra));
            return Ok(self.tool_result(Value::Object(answer), action, Some(handle), started, &images));
        }
        let snapshot_after = args.get("snapshotAfter");
        let skip_snapshot = snapshot_after == Some(&Value::Bool(false)) || (initial_edit.is_some() && snapshot_after != Some(&Value::Bool(true)));
        let mut initial: Map<String, Value>;
        if skip_snapshot {
            let session = lock(handle);
            initial = Map::new();
            initial.insert("session".to_owned(), Value::String(session.id.clone()));
            initial.insert("mode".to_owned(), Value::String(session.mode.as_str().to_owned()));
            initial.insert("backend".to_owned(), Value::String(session.backend.as_str().to_owned()));
            initial.insert("fileKind".to_owned(), Value::String(session.file_kind.clone()));
            initial.insert("source".to_owned(), Value::String(session.source.clone()));
            initial.insert("output".to_owned(), Value::String(session.target.clone()));
            initial.extend(open_fields(&session));
            initial.insert("batch".to_owned(), initial_edit.clone().unwrap_or(Value::Null));
        } else {
            initial = snapshot(&self.inspect().snapshot, handle, args, false).await?.as_object().cloned().unwrap_or_default();
            if let Some(edit) = &initial_edit {
                initial.insert("batch".to_owned(), edit.clone());
            }
            // A PDF written from blocks answers with what the writer made (its page count, its fields, any page that reads as a
            // picture), not the words the caller just sent, as a created Word or Excel file does; snapshotAfter asks for the full
            // read. A scan of content the caller wrote has nothing to report either.
            let is_pdf = lock(handle).format == "pdf";
            if action == "create" && is_pdf && snapshot_after != Some(&Value::Bool(true)) && initial.get("document").is_some_and(truthy) {
                let document = initial.get("document").cloned().unwrap_or(Value::Null);
                let mut kept = Map::new();
                for key in ["format", "pageCount", "fieldCount", "likelyScannedPages"] {
                    if let Some(value) = document.get(key) {
                        kept.insert(key.to_owned(), value.clone());
                    }
                }
                initial.insert("document".to_owned(), Value::Object(kept));
                let findings = to_number_of(initial.get("trust").and_then(|trust| trust.get("findingCount")));
                if findings.is_nan() || findings <= 0.0 {
                    initial.shift_remove("trust");
                }
            }
        }
        let isolation = initial_edit
            .as_ref()
            .and_then(|edit| edit.get("backgroundIsolation"))
            .filter(|isolation| truthy(isolation))
            .cloned()
            .or_else(|| lock(handle).com.background_isolation.clone())
            .unwrap_or(Value::Null);
        let foreground = lock(handle).com.foreground_activated;
        let identity = opened_identity(&lock(handle), action, opened.reused, vec![("foregroundActivated", Value::Bool(foreground)), ("backgroundIsolation", isolation)]);
        initial.extend(identity);
        lock(handle).active_signal = None;
        Ok(self.tool_result(Value::Object(initial), action, Some(handle), started, &[]))
    }
}
