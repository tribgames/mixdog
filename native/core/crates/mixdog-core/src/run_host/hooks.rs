//! `ToolHooks`: PostToolUse, PostToolUseFailure and PostToolBatch around the loop's tool calls
//! (`loop/tool-exec/after-hook.mjs`, `tool-batch/record-outcome.mjs`, `tool-batch/flush.mjs`).
//!
//! The loop's trait is best-effort by contract; this layer builds the event a hook receives and
//! reads a hook's answer exactly as Node does. Running the configured handlers is the
//! [`PostToolDispatch`] behind it (the hook bus).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::ToolHooks;
use mixdog_protocol::JsonValue;

/// What a PostToolUse / PostToolUseFailure hook receives.
#[derive(Clone, PartialEq, Debug)]
pub struct PostToolEvent {
    pub name: String,
    pub args: JsonValue,
    /// `effectiveToolCwd`: the shell call's own `cwd` argument, else the session's.
    pub cwd: String,
    pub session_id: String,
    pub result: String,
}

pub struct BatchDecision {
    pub blocked: bool,
    pub reason: Option<String>,
}

/// The configured handlers for the three post-tool events. Errors are the dispatcher's to
/// swallow: a hook never breaks the loop, so these answer `None` on any failure.
#[async_trait]
pub trait PostToolDispatch: Send + Sync {
    /// The hook's `updatedToolOutput`, if it set one.
    async fn post_tool(&self, event: &PostToolEvent) -> Option<JsonValue>;
    async fn post_failure(&self, event: &PostToolEvent);
    async fn post_batch(&self, session_id: &str, cwd: &str, tool_count: usize) -> Option<BatchDecision>;
}

pub struct SessionToolHooks {
    session_id: String,
    cwd: String,
    /// The session's folder as it stands now (`call.cwd = prepared.cwd`).
    live_cwd: Option<mixdog_agent::tools::LiveCwd>,
    dispatch: Arc<dyn PostToolDispatch>,
}

impl SessionToolHooks {
    pub fn new(session_id: &str, cwd: &Path, dispatch: Arc<dyn PostToolDispatch>) -> Self {
        Self { session_id: session_id.to_owned(), cwd: cwd.to_string_lossy().into_owned(), live_cwd: None, dispatch }
    }

    pub fn with_live_cwd(mut self, live: Option<mixdog_agent::tools::LiveCwd>) -> Self {
        self.live_cwd = live;
        self
    }

    fn cwd_now(&self) -> String {
        self.live_cwd.as_ref().and_then(|live| live()).map_or_else(|| self.cwd.clone(), |live| live.as_path().to_string_lossy().into_owned())
    }

    fn event(&self, call: &GateCall, result: &str) -> PostToolEvent {
        PostToolEvent {
            name: call.name.clone(),
            args: call.args.clone(),
            cwd: effective_tool_cwd(&call.name, &call.args, &self.cwd_now()),
            session_id: self.session_id.clone(),
            result: result.to_owned(),
        }
    }
}

fn expand_home(path: &str) -> String {
    let home = || std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    if path == "~" {
        return home();
    }
    match path.strip_prefix("~/").or_else(|| if cfg!(windows) { path.strip_prefix("~\\") } else { None }) {
        Some(rest) => super::result_reuse::resolve(&home(), rest),
        None => path.to_owned(),
    }
}

/// `effectiveToolCwd`: the shell's `cwd` argument resolved against the session cwd; the session
/// cwd for every other tool.
pub(crate) fn effective_tool_cwd(tool: &str, args: &JsonValue, session_cwd: &str) -> String {
    if tool != "shell" {
        return session_cwd.to_owned();
    }
    let Some(requested) = args.get("cwd").and_then(|c| c.as_str()).filter(|c| !mixdog_js::js_trim(c).is_empty()) else {
        return session_cwd.to_owned();
    };
    let resolved = super::result_reuse::resolve(session_cwd, &expand_home(requested));
    if cfg!(windows) { resolved.replace('/', "\\") } else { resolved }
}

/// `normalizeHookUpdatedToolOutput` for a text result: a string as is, null as empty, a legacy
/// MCP text envelope joined. A value with non-text parts or of another type is not text, so the
/// result stays as the tool gave it.
fn updated_text(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(s) => Some(s.clone()),
        JsonValue::Null => Some(String::new()),
        JsonValue::Object(map) => {
            let parts = map.get("content")?.as_array()?;
            let non_text = |c: &JsonValue| {
                c.is_object() && c.get("type").is_some_and(|t| !t.is_null() && t.as_str() != Some("") && t.as_str() != Some("text"))
            };
            if parts.iter().any(non_text) {
                return None;
            }
            Some(
                parts
                    .iter()
                    .map(|c| {
                        if c.get("type").and_then(|t| t.as_str()) == Some("text") {
                            c.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_owned()
                        } else {
                            mixdog_js::json_stringify(c)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }
        _ => None,
    }
}

#[async_trait]
impl ToolHooks for SessionToolHooks {
    async fn after_tool(&self, call: &GateCall, result: &str) -> Option<String> {
        let answer = self.dispatch.post_tool(&self.event(call, result)).await?;
        updated_text(&answer)
    }

    async fn after_failure(&self, call: &GateCall, result: &str) {
        self.dispatch.post_failure(&self.event(call, result)).await;
    }

    /// `Some(reason)` only for a blocking decision; the reason defaults to Node's text.
    async fn after_batch(&self, tool_count: usize) -> Option<String> {
        if tool_count == 0 {
            return None;
        }
        let decision = self.dispatch.post_batch(&self.session_id, &self.cwd, tool_count).await?;
        decision.blocked.then(|| {
            decision
                .reason
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| "PostToolBatch hook blocked continuation".to_owned())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct Fake {
        answer: Mutex<Option<JsonValue>>,
        seen: Mutex<Vec<PostToolEvent>>,
        decision: Mutex<Option<(bool, Option<String>)>>,
    }

    #[async_trait]
    impl PostToolDispatch for Fake {
        async fn post_tool(&self, event: &PostToolEvent) -> Option<JsonValue> {
            self.seen.lock().unwrap().push(event.clone());
            self.answer.lock().unwrap().clone()
        }
        async fn post_failure(&self, event: &PostToolEvent) {
            self.seen.lock().unwrap().push(event.clone());
        }
        async fn post_batch(&self, _: &str, _: &str, _: usize) -> Option<BatchDecision> {
            self.decision.lock().unwrap().clone().map(|(blocked, reason)| BatchDecision { blocked, reason })
        }
    }

    fn hooks(fake: &Arc<Fake>) -> SessionToolHooks {
        SessionToolHooks::new("s1", Path::new("/work"), fake.clone())
    }

    #[tokio::test]
    async fn a_hook_overrides_the_visible_text_only_with_text() {
        let fake = Arc::new(Fake::default());
        let h = hooks(&fake);
        let call = GateCall::new("shell", json!({"command": "ls", "cwd": "sub"}));
        assert_eq!(h.after_tool(&call, "out").await, None);
        let seen = fake.seen.lock().unwrap()[0].clone();
        assert_eq!((seen.session_id.as_str(), seen.result.as_str()), ("s1", "out"));
        assert!(seen.cwd.ends_with("sub") && seen.cwd.contains("work"), "{}", seen.cwd);
        *fake.answer.lock().unwrap() = Some(json!("replaced"));
        assert_eq!(h.after_tool(&call, "out").await.as_deref(), Some("replaced"));
        *fake.answer.lock().unwrap() = Some(json!({"content": [{"type": "text", "text": "a"}, {"type": "x"}]}));
        assert_eq!(h.after_tool(&call, "out").await, None);
        *fake.answer.lock().unwrap() = Some(json!({"content": [{"type": "text", "text": "a"}, {"text": "b"}]}));
        assert_eq!(h.after_tool(&call, "out").await.as_deref(), Some("a\n{\"text\":\"b\"}"));
        *fake.answer.lock().unwrap() = Some(JsonValue::Null);
        assert_eq!(h.after_tool(&call, "out").await.as_deref(), Some(""));
    }

    #[tokio::test]
    async fn only_a_blocking_batch_decision_gives_a_reason() {
        let fake = Arc::new(Fake::default());
        let h = hooks(&fake);
        assert_eq!(h.after_batch(2).await, None);
        *fake.decision.lock().unwrap() = Some((false, Some("x".into())));
        assert_eq!(h.after_batch(2).await, None);
        *fake.decision.lock().unwrap() = Some((true, None));
        assert_eq!(h.after_batch(0).await, None);
        assert_eq!(h.after_batch(1).await.as_deref(), Some("PostToolBatch hook blocked continuation"));
        *fake.decision.lock().unwrap() = Some((true, Some("stop".into())));
        assert_eq!(h.after_batch(1).await.as_deref(), Some("stop"));
    }
}

/// What a hook payload carries besides the event: the worker session's directory and common
/// fields (`hookCommonPayload`, which reads the transcript path of the session it is given).
pub type SubagentContext = Arc<dyn Fn(&str) -> (std::path::PathBuf, mixdog_mcp::hook_bus::HookCommon) + Send + Sync>;

/// `SubagentEvents` over the hook bus (`onSubagentEvent` → `hooks.dispatch`). Fire and forget:
/// a hook problem never reaches the worker's lifecycle.
pub struct HookSubagentEvents {
    bus: Arc<mixdog_mcp::hook_bus::HookBus>,
    context: SubagentContext,
}

impl HookSubagentEvents {
    pub fn new(bus: Arc<mixdog_mcp::hook_bus::HookBus>, context: SubagentContext) -> Self {
        Self { bus, context }
    }

    fn emit(&self, stop: bool, agent: &str, session_id: &str) {
        let bus = self.bus.clone();
        let (cwd, common) = (self.context)(session_id);
        let (agent, session_id) = (agent.to_owned(), session_id.to_owned());
        tokio::spawn(async move {
            bus.subagent(stop, &session_id, Some(&agent), &cwd, &common).await;
        });
    }
}

impl mixdog_agent::agent_tool::flow::seams::SubagentEvents for HookSubagentEvents {
    fn start(&self, agent: &str, session_id: &str, _tag: &str) {
        self.emit(false, agent, session_id);
    }

    // The bus takes the agent and session only: the tag and status are not part of the payload.
    fn stop(&self, agent: &str, session_id: &str, _tag: &str, _status: &str) {
        self.emit(true, agent, session_id);
    }
}