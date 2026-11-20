//! The tool call: one `action` of the Office tool answered as a tool result (`runOfficeTool` of `src/runtime/office/index.mjs`).
//!
//! - [`sessionless`]: the actions that answer without a document session.
//! - [`open_action`]: `create`, `open` and `attach`.
//! - [`session_actions`]: one resolved session, one action.
//!
//! A cancelled call answers `{ ok: false, code: 'cancelled' }`, a conflicting transaction its details, any other failure
//! `Error: <message>`; all of them as an error result.

pub mod open_action;
pub mod session_actions;
pub mod sessionless;

use std::time::Instant;

use mixdog_fsio::WriteProof;
use mixdog_js::{js_to_lowercase, value_to_string};
use mixdog_office_base::envelope::{ToolImage, tool_result};
use mixdog_office_base::values::truthy;
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use crate::actions::{Host, Machine};
use crate::batch::BatchHost;
use crate::digest::{FinalizeOptions, finalize_office_result};
use crate::render::RenderEngine;
use crate::session::open::{SessionCloser, resolve_session};
use crate::session::registry::lock;
use crate::session::{EnsureOptions, SessionHandle, ensure_office_session_design};
use crate::transactions::TransactionError;

/// Actions that only look at the document. Opening one of these on a path reads the file itself instead of stamping a working copy
/// over whatever an earlier edit left at that name. `qa` with `autoFix` repairs the document, so it is excluded at the call site.
const READ_ONLY_ACTIONS: [&str; 8] = ["snapshot", "get", "query", "issues", "validate", "describe", "render", "qa"];

/// The message of a call that was cancelled before it began.
const CANCELLED: &str = "Office Use operation was cancelled";

/// `value._images` taken off an answer: the page pixels the tool result carries as image blocks.
pub(crate) fn take_images(value: &mut Value) -> Vec<ToolImage> {
    let Some(fields) = value.as_object_mut() else { return Vec::new() };
    let Some(Value::Array(images)) = fields.shift_remove("_images") else { return Vec::new() };
    images
        .iter()
        .map(|image| ToolImage {
            mime_type: image.get("mimeType").map(value_to_string).unwrap_or_default(),
            data: image.get("data").map(value_to_string).unwrap_or_default(),
        })
        .collect()
}

impl<P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, P, H, C, R, B> {
    /// `toolResult(finalizeOfficeResult(value, { action, session, startedAt }), false, images)`.
    pub(crate) fn tool_result(&self, value: Value, action: &str, handle: Option<&SessionHandle>, started: Instant, images: &[ToolImage]) -> Value {
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let finalized = match handle {
            Some(handle) => {
                let mut result_session = lock(handle).result_session();
                let finalized = finalize_office_result(value, FinalizeOptions { action, session: Some(&mut result_session), elapsed_ms });
                lock(handle).absorb_result_session(result_session);
                finalized
            }
            None => finalize_office_result(value, FinalizeOptions { action, session: None, elapsed_ms }),
        };
        tool_result(&finalized, false, images)
    }

    /// `toolResult(value)`: an answer that is not shaped for the model.
    pub(crate) fn tool_result_plain(&self, value: Value) -> Value {
        tool_result(&value, false, &[])
    }

    /// The tool result of a call that failed.
    fn failure(&self, error: TransactionError, signal: Option<&CancellationToken>, active: Option<&SessionHandle>) -> Value {
        let message = match error {
            TransactionError::Conflict(conflict) => return tool_result(&conflict.details, true, &[]),
            TransactionError::Failed(message) => message,
        };
        if signal.is_some_and(CancellationToken::is_cancelled) || js_to_lowercase(&message).contains("cancelled") {
            if let Some(handle) = active
                && lock(handle).is_microsoft_office()
            {
                self.registry().release(self.environment(), handle);
            }
            return tool_result(&json!({ "ok": false, "code": "cancelled", "message": CANCELLED, "detail": message }), true, &[]);
        }
        tool_result(&Value::String(format!("Error: {message}")), true, &[])
    }

    async fn run_tool(
        &self,
        args: &Value,
        signal: Option<&CancellationToken>,
        started: Instant,
        active: &mut Option<SessionHandle>,
    ) -> Result<Value, TransactionError> {
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(CANCELLED.into());
        }
        let action = js_to_lowercase(&args.get("action").filter(|action| truthy(action)).map(value_to_string).unwrap_or_default());
        if let Some(answer) = self.sessionless_action(&action, args, signal, started).await? {
            return Ok(answer);
        }
        let cwd = self.author.env.cwd;
        let read_only = READ_ONLY_ACTIONS.contains(&action.as_str()) && args.get("autoFix") != Some(&Value::Bool(true));
        let env = self.call_env(signal);
        let resolved = resolve_session(&env, args, read_only).await?;
        let handle = resolved.opened.handle.clone();
        {
            let mut session = lock(&handle);
            let created = session.created;
            ensure_office_session_design(
                self.design(),
                self.data_dir(),
                &mut session,
                args,
                EnsureOptions { created: Some(created), allow_library_upgrade: true, preserve_native_design: true },
            )?;
            session.active_signal = signal.cloned();
        }
        *active = Some(handle.clone());
        let mut value = self.dispatch_session_action(&action, &handle, args, cwd, signal).await?;
        if resolved.implicit
            && action != "close"
            && let Some(fields) = value.as_object_mut()
        {
            fields.insert("implicitSession".to_owned(), Value::Bool(true));
        }
        let images = take_images(&mut value);
        Ok(self.tool_result(value, &action, Some(&handle), started, &images))
    }

    /// `runOfficeTool(args, { cwd, dataDir, signal })`: the call answered as a tool result.
    pub async fn run_office_tool(&self, args: &Value, signal: Option<&CancellationToken>) -> Value {
        let started = Instant::now();
        let mut active: Option<SessionHandle> = None;
        let outcome = self.run_tool(args, signal, started, &mut active).await;
        if let Some(handle) = &active {
            lock(handle).active_signal = None;
        }
        match outcome {
            Ok(result) => result,
            Err(error) => self.failure(error, signal, active.as_ref()),
        }
    }
}
