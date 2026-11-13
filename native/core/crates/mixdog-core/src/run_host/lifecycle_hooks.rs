//! A session's lifecycle hooks over the hook bus (`SessionDeps.lifecycle`): `SessionStart`,
//! `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd` and `CwdChanged`, each dispatched with
//! Node's payload (`hooks.dispatch(event, hookCommonPayload({ session_id, ...extra }))`). This layer
//! supplies what the session knows: its working directory and the common fields of its hook
//! payloads, read from the header the session hands over. It also holds what a turn does with a
//! `UserPromptSubmit` answer: the context the turn carries (`dispatchPromptSubmit`'s return) and
//! the user message built around it (`buildUserTurn`'s `# Additional context` block).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::lifecycle_hooks::LifecycleHooks;
use mixdog_core_session::session::lifecycle_hooks::PromptVerdict;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::mcp_glue::McpScopes;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

pub struct BusLifecycleHooks {
    bus: Arc<HookBus>,
    /// The folder the daemon started in: a session with no folder of its own runs hooks there.
    startup_cwd: PathBuf,
    /// The sessions' MCP scopes, which follow a moved folder (`onCwdChanged`).
    scopes: Arc<dyn McpScopes>,
}

impl BusLifecycleHooks {
    pub fn new(bus: Arc<HookBus>, startup_cwd: PathBuf, scopes: Arc<dyn McpScopes>) -> Self {
        Self { bus, startup_cwd, scopes }
    }

    /// `rt.currentCwd` and `hookCommonPayload`'s permission mode and effort, of the session whose
    /// header this is. The transcript path is the bus's (`HookBus::bind_transcripts`).
    fn context(&self, header: &Header) -> (PathBuf, HookCommon) {
        let cwd = header.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()).map_or_else(|| self.startup_cwd.clone(), PathBuf::from);
        (cwd, super::compose_parts::common_of_header(header))
    }
}

#[async_trait]
impl LifecycleHooks for BusLifecycleHooks {
    /// `dispatchSessionStart`: every runtime-built session is a `startup` (`sessionStartSource` of
    /// the daemon's create reasons: `reservation`, `turn`, `goal`, ...); `model` is the route's.
    async fn session_start(&self, thread: &ThreadId, header: &Header) -> Vec<String> {
        let (cwd, common) = self.context(header);
        let model = header.get("model").and_then(Value::as_str).filter(|model| !model.is_empty());
        self.bus.session_start(thread.as_str(), "startup", model, &cwd, &common).await
    }

    async fn prompt_submit(&self, thread: &ThreadId, header: &Header, prompt: &Value) -> PromptVerdict {
        let (cwd, common) = self.context(header);
        let answer = self.bus.user_prompt_submit(thread.as_str(), prompt, &cwd, &common).await;
        PromptVerdict { blocked: answer.blocked, reason: answer.reason, context: answer.additional_context }
    }

    async fn stop(&self, thread: &ThreadId, header: &Header) {
        let (cwd, common) = self.context(header);
        self.bus.stop(thread.as_str(), &cwd, &common).await;
    }

    async fn stop_failure(&self, thread: &ThreadId, header: &Header, error_type: &str) {
        let (cwd, common) = self.context(header);
        self.bus.stop_failure(thread.as_str(), error_type, &cwd, &common).await;
    }

    async fn session_end(&self, thread: &ThreadId, header: &Header, reason: &str) {
        let (cwd, common) = self.context(header);
        self.bus.session_end(thread.as_str(), reason, &cwd, &common).await;
    }

    /// `applyResolvedCwd` (`cwd-apply.mjs:91-100`): the `CwdChanged` dispatch is started and not
    /// waited for, and `onCwdChanged` follows at once, so the session's MCP scope reconciles for
    /// the new folder while the handlers run.
    async fn cwd_changed(&self, thread: &ThreadId, header: &Header) {
        let (cwd, common) = self.context(header);
        let reconcile = async {
            if let Some(scope) = super::session_tools::header_scope(header) {
                self.scopes.cwd_changed(scope, &cwd).await;
            }
        };
        tokio::join!(self.bus.cwd_changed(thread.as_str(), &cwd, &common), reconcile);
    }
}

/// `CTX_CHAR_CAP` (`ask-turn-prepare.mjs`).
const CONTEXT_CHAR_CAP: usize = 32 * 1024;

/// What `dispatchPromptSubmit` returns: the turn's own context (`options.context`) and the hook's
/// (`additionalContext` joined with a blank line), each trimmed, the empty ones dropped, joined
/// with a blank line. Empty: the turn carries no context.
pub fn turn_context(own: Option<&str>, hook: &[String]) -> String {
    let hook = hook.join("\n\n");
    [own.unwrap_or_default(), hook.as_str()].into_iter().map(mixdog_js::js_trim).filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// `capContext(text)`: context over the cap is cut, with a visible marker naming its length.
fn cap_context(text: &str) -> String {
    let length = mixdog_js::utf16_len(text);
    if length <= CONTEXT_CHAR_CAP {
        return text.to_owned();
    }
    format!("{}\n\n... [context truncated; original {length} chars]", mixdog_js::slice_utf16(text, CONTEXT_CHAR_CAP))
}

/// The user message of a turn that carries `context` (`buildUserTurn`:
/// `prefixUserTurnContent(prompt, '# Additional context\n' + capContext(context) + '\n\n')`): the
/// context and a `# Task` heading lead the prompt, as text before text and as a text part before
/// parts. A turn with no context keeps its message. `None` for content that is neither.
pub fn with_turn_context(message: &Value, context: &str) -> Option<Value> {
    if context.is_empty() {
        return Some(message.clone());
    }
    let lead = format!("# Additional context\n{}\n\n# Task\n", cap_context(context));
    let mut carried = message.clone();
    match carried.get_mut("content")? {
        Value::String(text) => text.insert_str(0, &lead),
        Value::Array(parts) => parts.insert(0, json!({ "type": "text", "text": lead })),
        _ => return None,
    }
    Some(carried)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turns_context_is_its_own_then_the_hooks() {
        assert_eq!(turn_context(None, &[]), "");
        assert_eq!(turn_context(Some("  "), &[" \n".to_owned()]), "");
        assert_eq!(turn_context(Some(" brief "), &[]), "brief");
        assert_eq!(turn_context(None, &["one".to_owned(), "two\n".to_owned()]), "one\n\ntwo");
        assert_eq!(turn_context(Some("brief"), &["one".to_owned()]), "brief\n\none");
    }

    #[test]
    fn the_context_leads_the_prompt_under_its_headings() {
        let text = json!({ "role": "user", "content": "do it", "meta": { "transcript": { "messageId": "m" } } });
        assert_eq!(with_turn_context(&text, ""), Some(text.clone()));
        assert_eq!(
            with_turn_context(&text, "remember X"),
            Some(json!({ "role": "user", "content": "# Additional context\nremember X\n\n# Task\ndo it", "meta": { "transcript": { "messageId": "m" } } }))
        );
        let parts = json!({ "role": "user", "content": [{ "type": "text", "text": "look" }, { "type": "image", "attachmentRef": "a" }] });
        assert_eq!(
            with_turn_context(&parts, "remember X"),
            Some(json!({ "role": "user", "content": [{ "type": "text", "text": "# Additional context\nremember X\n\n# Task\n" }, { "type": "text", "text": "look" }, { "type": "image", "attachmentRef": "a" }] }))
        );
        assert_eq!(with_turn_context(&json!({ "role": "user", "content": null }), "x"), None);
    }

    #[test]
    fn context_over_the_cap_is_cut_with_a_marker() {
        let long = "x".repeat(CONTEXT_CHAR_CAP + 5);
        let carried = with_turn_context(&json!({ "role": "user", "content": "go" }), &long).expect("a message");
        let expected = format!("# Additional context\n{}\n\n... [context truncated; original {} chars]\n\n# Task\ngo", "x".repeat(CONTEXT_CHAR_CAP), CONTEXT_CHAR_CAP + 5);
        assert_eq!(carried["content"], json!(expected));
        assert_eq!(cap_context(&"y".repeat(CONTEXT_CHAR_CAP)), "y".repeat(CONTEXT_CHAR_CAP));
    }
}
