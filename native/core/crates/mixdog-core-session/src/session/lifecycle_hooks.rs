//! The user hooks a session's life fires (Node's session runtime over `hooks.dispatch`), as the
//! session layer sees them. The bus and the payloads are the host's
//! (`mixdog-core` `run_host::lifecycle_hooks::BusLifecycleHooks`); a session only says when:
//! - **`SessionStart`** (`session-create/session-start-hook.mjs` `dispatchSessionStart`): a
//!   runtime built its session (`thread/start`), before anything else uses it. The context the
//!   handlers add is stored ahead of the first user turn ([`session_start_rows`]).
//! - **`UserPromptSubmit`** (`turn/turn-run/turn-prepare.mjs` `dispatchPromptSubmit`): every turn,
//!   after its prompt row and before the model is asked. A block refuses the turn; added context
//!   rides the turn.
//! - **`Stop`** (`turn-settle.mjs` `completeTurn`): a turn completed, after its final text.
//! - **`StopFailure`** (`turn-settle.mjs` `reportTurnError`): a turn ended any other way.
//! - **`SessionEnd`** (`lifecycle/teardown/session-close.mjs` `dispatchSessionEnd`): the session's
//!   runtime closes (an unload, the core's shutdown).
//! - **`CwdChanged`** (`cwd-plugins/cwd-apply.mjs` `applyResolvedCwd`): the session's folder moved;
//!   the session's MCP scope follows it (`onCwdChanged`).
//!
//! Every call takes the session's header as the caller holds it: the payload's `cwd`, permission
//! mode, effort and model are read from it (`hookCommonPayload`).

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

/// What `UserPromptSubmit`'s handlers decided.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct PromptVerdict {
    /// `promptDispatch.blocked === true`: the turn is refused.
    pub blocked: bool,
    pub reason: Option<String>,
    /// `promptDispatch.additionalContext`, one entry per handler that added some.
    pub context: Vec<String>,
}

#[async_trait]
pub trait LifecycleHooks: Send + Sync {
    /// `SessionStart`: the context the handlers add. Best-effort: a hook problem adds none.
    async fn session_start(&self, _thread: &ThreadId, _header: &Header) -> Vec<String> {
        Vec::new()
    }
    /// `UserPromptSubmit` for the turn's `prompt` (the input row's content). A hook failure
    /// decides nothing.
    async fn prompt_submit(&self, _thread: &ThreadId, _header: &Header, _prompt: &Value) -> PromptVerdict {
        PromptVerdict::default()
    }
    /// `Stop`: awaited by the turn, whatever the handlers answer.
    async fn stop(&self, _thread: &ThreadId, _header: &Header) {}
    /// `StopFailure` with the failure's class (`stopFailureType`).
    async fn stop_failure(&self, _thread: &ThreadId, _header: &Header, _error_type: &str) {}
    /// `SessionEnd` with Node's reason (`clear`, `exit`, `other`).
    async fn session_end(&self, _thread: &ThreadId, _header: &Header, _reason: &str) {}
    /// `CwdChanged`, and the MCP reconcile that follows a moved folder (`onCwdChanged`); `header`
    /// carries the new `cwd`.
    async fn cwd_changed(&self, _thread: &ThreadId, _header: &Header) {}
}

/// For a core with no hook bus.
pub struct NoLifecycleHooks;

impl LifecycleHooks for NoLifecycleHooks {}

/// How long a closing runtime waits for its `SessionEnd` handlers (`withTeardownDeadline(.., 300)`):
/// a slow hook goes on by itself and never holds the close.
pub const SESSION_END_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

/// The rows `dispatchSessionStart` puts before the first user turn for the handlers' context
/// (joined with a blank line): the context as a `system-reminder` user message, then the context
/// ack (`contextAckMessage()`), so the next prompt stays its own message. `None` when the
/// handlers added nothing but whitespace.
pub fn session_start_rows(context: &[String]) -> Option<Vec<Value>> {
    let joined = context.join("\n\n");
    let context = mixdog_js::js_trim(&joined);
    if context.is_empty() {
        return None;
    }
    Some(vec![
        json!({ "role": "user", "content": format!("<system-reminder>\n# SessionStart Hook Context\n{context}\n</system-reminder>") }),
        json!({ "role": "assistant", "content": ".", "meta": { "source": "context-ack" } }),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_start_context_is_a_reminder_and_its_ack() {
        assert_eq!(session_start_rows(&[]), None);
        assert_eq!(session_start_rows(&[" \n".to_owned()]), None);
        let rows = session_start_rows(&[" one".to_owned(), "two \n".to_owned()]).expect("rows");
        assert_eq!(
            rows,
            [
                json!({ "role": "user", "content": "<system-reminder>\n# SessionStart Hook Context\none\n\ntwo\n</system-reminder>" }),
                json!({ "role": "assistant", "content": ".", "meta": { "source": "context-ack" } }),
            ]
        );
    }
}
