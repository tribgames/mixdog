//! The production `EventSink`: a webhook event is delivered as Node's daemon delivers it.
//!
//! Node: `injectAndRecord` (`channels/lib/worker-main.mjs:153-175`, the event queue's inject handler
//! `:198-201`) strips soft-warn markers from the content and sends the channel notification
//! `{ content, meta }`; in the daemon `createChannelSessionRouter`
//! (`session-runtime/services/channel-session-router.mjs:10-34`) turns it into
//! `submitSession({ sessionId: getSessionId(), prompt: channelNotificationModelContent(params),
//! options: { source: 'channel', mode: 'task-notification', origin: 'channel' } })`. Here the submit is the
//! session directory's one task-notification queue path (`queue_channel_notification`).
//!
//! Like Node's fire-and-forget handler the sink never fails the pipeline: a delivery that cannot happen is
//! logged (`channel-session-router.mjs:18,31`) and the event counts as injected.

use std::sync::Arc;
use std::sync::LazyLock;

use async_trait::async_trait;
use mixdog_core::run_host::compose_parts::LateDirectory;
use mixdog_js::JsRegex;
use mixdog_protocol::ThreadId;

use crate::event_pipeline::EventSink;

/// `SOFT_WARN_RE` (`runtime/agent/orchestrator/tool-loop-guard.mjs:14-15`), evaluated as the same ES pattern.
static SOFT_WARN: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"⚠\s+(?:Tool-loop|Repeated-tool|Repeated-input|Tool-budget|Same-file\s+multi-chunk|Same-file\s+reads|Same-slice\s+reads|Edit-miss|Mixed-tool|Bash\s+file-lookup|Iteration|0-match)\([^\n]*\n?|⚠\s+(?:(?:Tool-loop|Repeated-tool|Repeated-input|Tool-budget|Same-file\s+multi-chunk|Same-file\s+reads|Same-slice\s+reads|Edit-miss|Mixed-tool|Bash\s+file-lookup|Iteration)\s+soft-warn|0-match\s+(?:family-switch\s+advisory|ESCALATED))[\s\S]*?(?:\n\s*\n|$)",
        "g",
    )
});

/// `stripSoftWarns` (`tool-loop-guard.mjs:17-20`).
pub fn strip_soft_warns(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    SOFT_WARN.replace_all_with(text, |_| String::new())
}

/// The options of `injectAndRecord(content, options)` that reach the model.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InjectOptions {
    pub instruction: Option<String>,
    /// `options.silent_to_agent === true` (`worker-main.mjs:172-174`): dropped, never sent.
    pub silent_to_agent: bool,
}

/// The `params` of `notifications/claude/channel` as far as the model sees them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelNotification {
    pub content: String,
    pub instruction: Option<String>,
}

/// `injectAndRecord` (`worker-main.mjs:153-175`); `None` when the ping is silent.
pub fn inject_and_record(content: &str, options: &InjectOptions) -> Option<ChannelNotification> {
    let content = strip_soft_warns(content);
    if options.silent_to_agent {
        return None;
    }
    Some(ChannelNotification { content, instruction: options.instruction.clone().filter(|i| !i.is_empty()) })
}

/// `channelNotificationModelContent` (`runtime/shared/channel-notification-routing.mjs:1-7`); the
/// `silent_to_agent` meta is already consumed by [`inject_and_record`].
pub fn model_content(notification: &ChannelNotification) -> String {
    let instruction = notification.instruction.as_deref().map_or("", mixdog_js::js_trim);
    if instruction.is_empty() { mixdog_js::js_trim(&notification.content).to_owned() } else { instruction.to_owned() }
}

/// `getSessionId` of the router (`channel-session-router.mjs:10`).
pub type SessionIdFn = Arc<dyn Fn() -> Option<ThreadId> + Send + Sync>;

/// The daemon's `getSessionId: () => null` (`standalone/daemon.mjs:924-929`, "channel-remote session
/// pinning is retired"): no session, so every notification is logged unavailable and dropped.
pub fn daemon_session_id() -> Option<ThreadId> {
    None
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SubmitError {
    /// `typeof service?.submitSession !== 'function'`.
    #[error("no session service")]
    NoService,
    #[error("{0}")]
    Refused(String),
}

/// `getSessionService().submitSession` for a channel notification.
#[async_trait]
pub trait ChannelSessions: Send + Sync {
    async fn submit(&self, thread: &ThreadId, prompt: &str) -> Result<(), SubmitError>;
}

/// The session directory, once the composition has bound it.
pub struct DirectorySessions(pub Arc<LateDirectory>);

#[async_trait]
impl ChannelSessions for DirectorySessions {
    async fn submit(&self, thread: &ThreadId, prompt: &str) -> Result<(), SubmitError> {
        let directory = self.0.directory().ok_or(SubmitError::NoService)?;
        if directory.queue_channel_notification(thread, prompt.to_owned()).await {
            Ok(())
        } else {
            Err(SubmitError::Refused("the thread did not accept the notification".into()))
        }
    }
}

/// Why a notification was not delivered; the `Display` is Node's log line.
#[derive(Debug, PartialEq, Eq)]
pub enum RouteError {
    Unavailable { session: Option<ThreadId> },
    Failed { session: ThreadId, source: SubmitError },
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable { session } => {
                write!(f, "channel session delivery unavailable session={}", session.as_ref().map_or("none", ThreadId::as_str))
            }
            Self::Failed { session, source } => write!(f, "channel session delivery failed session={}: {source}", session.as_str()),
        }
    }
}

impl std::error::Error for RouteError {}

/// What a routed notification came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// No model content: consumed, nothing submitted.
    Empty,
    Submitted(ThreadId),
}

/// `createChannelSessionRouter` for the channel method.
pub struct ChannelSessionRouter {
    session_id: SessionIdFn,
    sessions: Arc<dyn ChannelSessions>,
}

impl ChannelSessionRouter {
    pub fn new(session_id: SessionIdFn, sessions: Arc<dyn ChannelSessions>) -> Self {
        Self { session_id, sessions }
    }

    pub async fn route(&self, notification: &ChannelNotification) -> Result<Delivery, RouteError> {
        let prompt = model_content(notification);
        if prompt.is_empty() {
            return Ok(Delivery::Empty);
        }
        let session = (self.session_id)().filter(|id| !mixdog_js::js_trim(id.as_str()).is_empty());
        let Some(session) = session else { return Err(RouteError::Unavailable { session: None }) };
        let session = ThreadId::from(mixdog_js::js_trim(session.as_str()));
        match self.sessions.submit(&session, &prompt).await {
            Ok(()) => Ok(Delivery::Submitted(session)),
            Err(SubmitError::NoService) => Err(RouteError::Unavailable { session: Some(session) }),
            Err(source) => Err(RouteError::Failed { session, source }),
        }
    }
}

/// `EventSink` over the router: `injectAndRecord(' ', { type: 'webhook', instruction: prompt })`
/// (`channels/lib/event-queue.mjs:229-244`).
pub struct ChannelEventSink {
    router: ChannelSessionRouter,
}

impl ChannelEventSink {
    pub fn new(router: ChannelSessionRouter) -> Arc<Self> {
        Arc::new(Self { router })
    }

    /// The production wiring: Node daemon's session function, the submit into the (late-bound) session directory.
    pub fn over_directory(directory: Arc<LateDirectory>) -> Arc<Self> {
        Self::new(ChannelSessionRouter::new(Arc::new(daemon_session_id), Arc::new(DirectorySessions(directory))))
    }
}

#[async_trait]
impl EventSink for ChannelEventSink {
    async fn inject(&self, _event: &str, prompt: &str) -> Result<(), String> {
        let options = InjectOptions { instruction: Some(prompt.to_owned()), silent_to_agent: false };
        if let Some(notification) = inject_and_record(" ", &options)
            && let Err(error) = self.router.route(&notification).await
        {
            tracing::warn!("{error}");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::Value;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/channel-router/golden.json")).unwrap()
    }

    fn lead(id: Option<&str>) -> SessionIdFn {
        let id = id.map(str::to_owned);
        Arc::new(move || id.clone().map(ThreadId::from))
    }

    struct Sessions {
        kind: String,
        submits: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl ChannelSessions for Sessions {
        async fn submit(&self, thread: &ThreadId, prompt: &str) -> Result<(), SubmitError> {
            if self.kind == "none" {
                return Err(SubmitError::NoService);
            }
            self.submits.lock().unwrap().push((thread.as_str().to_owned(), prompt.to_owned()));
            if self.kind == "throws" { Err(SubmitError::Refused("boom".into())) } else { Ok(()) }
        }
    }

    #[test]
    fn soft_warns_are_stripped_as_nodes_do() {
        for case in golden()["strip"].as_array().unwrap() {
            assert_eq!(strip_soft_warns(case["input"].as_str().unwrap()), case["output"].as_str().unwrap(), "{case}");
        }
    }

    #[tokio::test]
    async fn every_recorded_injection_routes_as_nodes_router_does() {
        for case in golden()["inject"].as_array().unwrap() {
            let options = InjectOptions {
                instruction: case["options"]["instruction"].as_str().map(str::to_owned),
                silent_to_agent: case["options"]["silent_to_agent"] == Value::Bool(true),
            };
            let sessions = Arc::new(Sessions { kind: case["service"].as_str().unwrap().to_owned(), submits: Mutex::default() });
            let router = ChannelSessionRouter::new(lead(case["lead"].as_str()), sessions.clone());
            let mut logs = Vec::new();
            if let Some(notification) = inject_and_record(case["content"].as_str().unwrap(), &options)
                && let Err(error) = router.route(&notification).await
            {
                logs.push(error.to_string());
            }
            let want_submits: Vec<(String, String)> = case["submits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| (s["sessionId"].as_str().unwrap().to_owned(), s["prompt"].as_str().unwrap().to_owned()))
                .collect();
            assert_eq!(*sessions.submits.lock().unwrap(), want_submits, "{case}");
            let want_logs: Vec<String> = case["logs"].as_array().unwrap().iter().map(|l| l.as_str().unwrap().to_owned()).collect();
            assert_eq!(logs, want_logs, "{case}");
        }
    }

    #[tokio::test]
    async fn the_sink_never_fails_the_pipeline() {
        let sessions = Arc::new(Sessions { kind: "throws".into(), submits: Mutex::default() });
        let sink = ChannelEventSink::new(ChannelSessionRouter::new(lead(Some("sess_lead")), sessions.clone()));
        assert_eq!(sink.inject("event:ci", "red").await, Ok(()));
        assert_eq!(*sessions.submits.lock().unwrap(), vec![("sess_lead".to_owned(), "red".to_owned())]);
        let unpinned = ChannelEventSink::new(ChannelSessionRouter::new(Arc::new(daemon_session_id), sessions.clone()));
        assert_eq!(unpinned.inject("event:ci", "red").await, Ok(()));
        assert_eq!(sessions.submits.lock().unwrap().len(), 1, "Node daemon parity: no session, dropped");
    }
}
