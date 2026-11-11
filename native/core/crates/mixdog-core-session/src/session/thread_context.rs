//! `thread/contextStatus`: the context gauge (`contextStatus(options)` of the runtime facade,
//! Node `context-status*.mjs`). The number is `mixdog_agent::compact::pressure::context_status`
//! (the compaction meter and pressure code); this service only routes the call to the session
//! that owns the live inputs (route, transcript, request tools, meters) and returns its record.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::pressure::Inspections;
use mixdog_agent::compact::pressure::Route;
use mixdog_agent::compact::pressure::StatusInput;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::compact::pressure::context_status;
use mixdog_agent::compact::tool_schema::RequestTools;
use mixdog_agent::compact::tool_schema::ToolAnnotations;
use mixdog_agent::compact::tool_schema::tool_schema_breakdown;
use mixdog_agent::message::AgentMessage;
use mixdog_app_protocol::v2::params::ThreadContextStatusParams;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::wrong_method;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;

pub const CONTEXT_STATUS: &str = "thread/contextStatus";
const DOMAIN: &str = "thread context";

/// The session side: the status record of one thread (`None` = the current session), built from
/// that session's live inputs by `context_status`. A thread that is not loaded answers the empty
/// status of no session, as Node's facade does.
#[async_trait]
pub trait ContextStatusHost: Send + Sync {
    async fn context_status(&self, thread: Option<ThreadId>, options: Option<Value>) -> Result<Value, CoreError>;
}

pub struct ThreadContextService {
    host: Arc<dyn ContextStatusHost>,
}

impl ThreadContextService {
    pub fn new(host: Arc<dyn ContextStatusHost>) -> Self {
        Self { host }
    }
}

#[async_trait]
impl DomainService for ThreadContextService {
    fn methods(&self) -> &'static [&'static str] {
        &[CONTEXT_STATUS]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            CONTEXT_STATUS => {
                let params: ThreadContextStatusParams = decode(&req)?;
                Ok(Reply::Value(self.host.context_status(params.thread_id, params.options).await?))
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

/// What one status computation reads of a loaded session (the `StatusInput` fields the session
/// owns): its header, the route it runs on, the working transcript (the in-flight turn's while one
/// runs, else the committed one) and the tools the next request carries.
pub struct ContextSnapshot {
    pub header: Map<String, Value>,
    pub provider: String,
    pub model: String,
    /// `route.contextWindow`, `Null` when the route states none.
    pub context_window: Value,
    /// `getCurrentCwd()` and `getMode()`.
    pub cwd: Value,
    pub mode: Value,
    pub messages: Vec<AgentMessage>,
    /// `hasRouteHistoryMessage(messages)`.
    pub active: bool,
    /// The request's provider-native wire tools and its defined tools, and the session's own tool list.
    pub request_native: Vec<Value>,
    pub request_defined: Vec<ToolDefinition>,
    pub session_defined: Vec<ToolDefinition>,
    /// `isAgentModeSession(session)`.
    pub agent_mode: bool,
    /// The annotations of the defined tools, by name (`tool.annotations`), for the breakdown buckets.
    pub annotations: HashMap<String, ToolAnnotations>,
    /// The session's meters: the run host's media lowering (the one compaction uses, so the gauge
    /// and the trigger never disagree) and the stored message rows.
    pub media: Arc<dyn MediaMeter>,
    pub images: Arc<dyn ImageIdentities>,
    pub rows: Arc<dyn MessageRows>,
    /// The provider whose replay payloads the transcript is metered for.
    pub replay_owner: ProviderId,
}

/// The run host's side of the gauge: the live facts of a session.
#[async_trait]
pub trait ContextWorld: Send + Sync {
    /// The snapshot of `thread` (`None` = the current session); `None` when no such session is loaded.
    async fn snapshot(&self, thread: Option<&ThreadId>) -> Result<Option<ContextSnapshot>, CoreError>;

    /// The media meter and the image identities of `thread` on `provider` (the ones its snapshot carries).
    fn lowering(&self, thread: &ThreadId, provider: &str) -> (Arc<dyn MediaMeter>, Arc<dyn ImageIdentities>);
}

/// [`ContextStatusHost`] over the live world: `context_status` (the compaction meter and pressure
/// code) fed by the session's own snapshot. No loaded session is Node's status of no session, `null`.
pub struct LiveContextStatus {
    world: Arc<dyn ContextWorld>,
    /// The readings the Context inspector listed, for its entry previews.
    inspections: Inspections,
}

impl LiveContextStatus {
    pub fn new(world: Arc<dyn ContextWorld>) -> Self {
        Self { world, inspections: Inspections::new() }
    }
}

#[async_trait]
impl ContextStatusHost for LiveContextStatus {
    async fn context_status(&self, thread: Option<ThreadId>, options: Option<Value>) -> Result<Value, CoreError> {
        let Some(snapshot) = self.world.snapshot(thread.as_ref()).await? else { return Ok(Value::Null) };
        let meter = MessageMeter { media: &*snapshot.media, replay_owner: &snapshot.replay_owner };
        let signer = TranscriptSigner { meter: &meter, images: &*snapshot.images, rows: &*snapshot.rows };
        let request_tools = RequestTools { native: &snapshot.request_native, defined: &snapshot.request_defined };
        let session_tools = RequestTools { native: &[], defined: &snapshot.session_defined };
        let breakdown = tool_schema_breakdown(&request_tools, &|name| snapshot.annotations.get(name).cloned().unwrap_or_default());
        let input = StatusInput {
            session: &snapshot.header,
            route: Route { provider: &snapshot.provider, model: &snapshot.model, context_window: snapshot.context_window.clone() },
            cwd: snapshot.cwd.clone(),
            mode: snapshot.mode.clone(),
            messages: &snapshot.messages,
            active: snapshot.active,
            request_tools,
            session_tools,
            tool_breakdown: &breakdown,
            agent_mode: snapshot.agent_mode,
            meter: &meter,
            signer: &signer,
        };
        let annotations_of = |name: &str| snapshot.annotations.get(name).cloned().unwrap_or_default();
        Ok(self.inspections.attach(context_status(&input), &input, &annotations_of, options.as_ref()))
    }
}
#[cfg(test)]
mod tests {
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use serde_json::json;

    use super::*;

    /// A host answering each golden case's status for the thread named after the case.
    struct Recorded(Vec<(String, Value)>);

    #[async_trait]
    impl ContextStatusHost for Recorded {
        async fn context_status(&self, thread: Option<ThreadId>, options: Option<Value>) -> Result<Value, CoreError> {
            assert_eq!(options, Some(json!({ "probe": true })), "options reach the host untouched");
            let wanted = thread.map(|t| t.as_str().to_owned()).unwrap_or_default();
            Ok(self.0.iter().find(|(name, _)| *name == wanted).map(|(_, status)| status.clone()).unwrap_or(Value::Null))
        }
    }

    /// Node's recorded statuses come back through the handler byte for byte.
    #[tokio::test]
    async fn answers_nodes_status() {
        let text = mixdog_testkit::fixture!("../../fixtures/context-status/golden.json");
        let golden: Value = serde_json::from_str(text).expect("golden json");
        let cases: Vec<(String, Value)> =
            golden["cases"].as_array().expect("cases").iter().map(|c| (c["name"].as_str().expect("name").to_owned(), c["status"].clone())).collect();
        let service = ThreadContextService::new(Arc::new(Recorded(cases.clone())));
        for (name, status) in &cases {
            let answer = value(&service, request(CONTEXT_STATUS, json!({ "threadId": name, "options": { "probe": true } }), None)).await.expect("status");
            assert_eq!(&answer, status, "{name}");
        }
        assert!(cases.iter().any(|(_, s)| s["usedSource"] == "post_compact"));
    }

    #[tokio::test]
    async fn other_methods_refused() {
        let service = ThreadContextService::new(Arc::new(Recorded(Vec::new())));
        let error = value(&service, request("thread/list", json!({}), None)).await.expect_err("refused");
        assert!(matches!(error, CoreError::InvalidParams { .. }), "{error:?}");
    }

    struct TextOnly;
    impl MediaMeter for TextOnly {
        fn part(&self, part: &mixdog_core_api::domain::provider::ContentPart) -> mixdog_agent::compact::estimate::PartMeter {
            panic!("media part in a text-only golden: {part:?}")
        }
    }
    impl ImageIdentities for TextOnly {
        fn images(&self, _: &AgentMessage) -> Vec<mixdog_agent::compact::pressure::ImageDescriptor> {
            Vec::new()
        }
    }
    impl MessageRows for TextOnly {
        fn row(&self, message: &AgentMessage) -> Value {
            panic!("row of a message in an empty-transcript golden: {message:?}")
        }
    }

    fn definitions(tools: &Value) -> Vec<ToolDefinition> {
        tools
            .as_array()
            .expect("tools")
            .iter()
            .map(|t| ToolDefinition {
                name: t["name"].as_str().expect("name").to_owned(),
                description: t["description"].as_str().expect("description").to_owned(),
                input_schema: t["inputSchema"].clone(),
                defer_loading: t["deferLoading"] == Value::Bool(true),
                freeform: None,
            })
            .collect()
    }

    /// The loaded sessions of the golden's empty-transcript cases, by case name.
    struct GoldenWorld(Value);

    #[async_trait]
    impl ContextWorld for GoldenWorld {
        async fn snapshot(&self, thread: Option<&ThreadId>) -> Result<Option<ContextSnapshot>, CoreError> {
            let name = thread.map(|t| t.as_str()).unwrap_or_default();
            let Some(case) = self.0["cases"].as_array().expect("cases").iter().find(|c| c["name"] == name) else { return Ok(None) };
            let Some(header) = case["header"].as_object() else { return Ok(None) };
            Ok(Some(ContextSnapshot {
                header: header.clone(),
                provider: case["route"]["provider"].as_str().expect("provider").to_owned(),
                model: case["route"]["model"].as_str().expect("model").to_owned(),
                context_window: case["route"]["contextWindow"].clone(),
                cwd: case["cwd"].clone(),
                mode: case["mode"].clone(),
                messages: Vec::new(),
                active: case["active"].as_bool().expect("active"),
                request_native: Vec::new(),
                request_defined: definitions(&case["requestTools"]),
                session_defined: definitions(&case["tools"]),
                agent_mode: case["agentMode"].as_bool().expect("agentMode"),
                annotations: HashMap::new(),
                media: Arc::new(TextOnly),
                images: Arc::new(TextOnly),
                rows: Arc::new(TextOnly),
                replay_owner: ProviderId::from(case["route"]["provider"].as_str().expect("provider")),
            }))
        }

        fn lowering(&self, _: &ThreadId, _: &str) -> (Arc<dyn MediaMeter>, Arc<dyn ImageIdentities>) {
            let media: Arc<dyn MediaMeter> = Arc::new(TextOnly);
            let images: Arc<dyn ImageIdentities> = Arc::new(TextOnly);
            (media, images)
        }
    }

    /// The gauge over a loaded session equals Node's for every golden case whose transcript is
    /// empty (the cases with messages are compared in `mixdog-agent`'s `compact_context_status`);
    /// a session that is not loaded is `null`.
    #[tokio::test]
    async fn live_gauge_equals_nodes_for_empty_transcripts() {
        let text = mixdog_testkit::fixture!("../../fixtures/context-status/golden.json");
        let golden: Value = serde_json::from_str(text).expect("golden json");
        let host = LiveContextStatus::new(Arc::new(GoldenWorld(golden.clone())));
        let mut compared = 0;
        for case in golden["cases"].as_array().expect("cases") {
            if case["header"].is_null() || !case["messages"].as_array().expect("messages").is_empty() || case["nativePrefix"] != 0 {
                continue;
            }
            let name = case["name"].as_str().expect("name");
            let answer = host.context_status(Some(ThreadId::from(name.to_owned())), None).await.expect("status");
            assert_eq!(answer, case["status"], "{name}");
            compared += 1;
        }
        assert_eq!(compared, 2, "empty-transcript cases compared");
        assert_eq!(host.context_status(Some(ThreadId::from("nope".to_owned())), None).await.expect("status"), Value::Null);
    }
}
