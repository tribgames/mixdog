//! The header a manual compaction commits equals Node's session after `runSessionCompaction`
//! (fixtures/compaction-commit/golden.json, `record-compaction-commit.mjs`): the usage totals, the
//! `compaction` record, the invalidated baseline, the post-compaction usage snapshot and the
//! cache-break intent, the fallback title, with the answer: the whole header is compared, every key.

use std::collections::HashMap;

use mixdog_agent::compact::estimate::{MediaMeter, PartMeter};
use mixdog_agent::compact::pressure::{ImageDescriptor, ImageIdentities};
use mixdog_core_api::domain::provider::{ContentPart, ToolDefinition};
use mixdog_protocol::ProviderId;

use super::super::context_world::StoredBodies;
use super::*;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}
impl ImageIdentities for TextOnly {
    fn images(&self, _: &AgentMessage) -> Vec<ImageDescriptor> {
        Vec::new()
    }
}

/// A manual pass archives each message as its stored row (Node's `serializeExecutionArchive` over `session.messages`),
/// never as `null`.
#[test]
fn a_manual_pass_archives_each_message_as_its_stored_row() {
    use mixdog_agent::compact::execution_tail::MessageRows;
    let rows = vec![
        json!({ "role": "user", "content": "hi" }),
        json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "c1", "name": "read", "arguments": {} }] }),
        json!({ "role": "tool", "content": "body", "toolCallId": "c1" }),
    ];
    let messages: Vec<AgentMessage> = rows.iter().map(|row| message_of(row).unwrap()).collect();
    let stored = registered(&messages, &rows);
    for (message, row) in messages.iter().zip(&rows) {
        assert_eq!(&stored.row(message), row);
    }
}

fn definitions(tools: &[Value]) -> Vec<ToolDefinition> {
    tools
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

fn header_of(session: &Value) -> Header {
    session.as_object().expect("session").iter().filter(|(key, _)| key.as_str() != "messages").map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// The whole header, every key: `header_of` leaves out `messages` only because a header is the session without its transcript.
fn comparable(header: &Header) -> Value {
    Value::Object(header.clone())
}

fn snapshot_of(case: &Value, header: &Header, messages: &[AgentMessage]) -> Arc<ContextSnapshot> {
    let wire = case["beforeRequestTools"].as_array().expect("tools");
    let prefix = case["beforeNativePrefix"].as_u64().expect("prefix") as usize;
    let provider = header["provider"].as_str().expect("provider").to_owned();
    Arc::new(ContextSnapshot {
        header: header.clone(),
        provider: provider.clone(),
        model: header["model"].as_str().expect("model").to_owned(),
        context_window: Value::Null,
        cwd: Value::Null,
        mode: Value::Null,
        messages: messages.to_vec(),
        active: true,
        request_native: wire[..prefix].to_vec(),
        request_defined: definitions(&wire[prefix..]),
        session_defined: definitions(case["before"]["tools"].as_array().expect("tools")),
        agent_mode: false,
        annotations: HashMap::new(),
        media: Arc::new(TextOnly),
        images: Arc::new(TextOnly),
        rows: Arc::new(StoredBodies),
        replay_owner: ProviderId::from(provider.as_str()),
    })
}

/// A session whose `messages` lead with four system blocks plans and commits over them as Node does
/// (fixtures/compaction-system-blocks/golden.json, `record-compaction-system-blocks.mjs`, recorded from
/// b6f10295a): the whole result object and the record equal Node's, counts and tokens included. The
/// blocks come from the header; the compactor and the stored rows keep the transcript alone.
#[test]
fn a_plan_and_its_commit_count_the_system_blocks_of_the_request() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/compaction-system-blocks/golden.json")).expect("golden json");
    let now = golden["now"].as_f64().expect("now");
    let rows_of = |messages: &Value| -> Vec<Value> { messages.as_array().expect("messages").iter().filter(|m| m["role"] != "system").cloned().collect() };
    let mut compared = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let value = &case["result"]["value"];
        let mut header = header_of(&case["before"]);
        for (key, system) in ["promptBase", "promptStable", "bp3CoreContext", "promptEnv"].into_iter().zip(case["before"]["messages"].as_array().expect("messages")) {
            header.insert(key.into(), system["content"].clone());
        }
        header.insert("bp3EnvSplit".into(), json!(true));
        let before_rows = rows_of(&case["before"]["messages"]);
        let transcript: Vec<AgentMessage> = before_rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        // The header's blocks are the recorded ones, message for message.
        let recorded: Vec<AgentMessage> = case["before"]["messages"].as_array().expect("messages")[..4].iter().map(|row| message_of(row).expect("a system block")).collect();
        let blocks = super::super::factory::system_messages(&header);
        assert_eq!(blocks.iter().map(|m| &m.message).collect::<Vec<_>>(), recorded.iter().map(|m| &m.message).collect::<Vec<_>>(), "{name}: the header rebuilds Node's four system messages");
        let snapshot = snapshot_of(case, &header, &transcript);
        let session_messages = priced(&header, &transcript);
        let plan = forced_plan(&snapshot, &session_messages).expect("a window").expect("a plan");
        let after_rows = rows_of(&case["after"]["messages"]);
        let compacted: Vec<AgentMessage> = after_rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        let mode = case["compactMode"].as_str().unwrap_or_default();
        let mut parts = mode.split(':');
        let (pipeline_mode, kind, route) = (parts.next().map(str::to_owned), parts.next(), parts.next().map(str::to_owned));
        let record = &case["after"]["compaction"];
        let changed = value["changed"] == Value::Bool(true);
        let facts = CommitFacts {
            snapshot: snapshot.clone(),
            messages: session_messages,
            before_rows,
            plan,
            compacted,
            compacted_rows: after_rows,
            fresh: SummaryFacts {
                usage: Some(value["usage"].clone()).filter(|u| !u.is_null()),
                fresh_context: value["freshContext"] == Value::Bool(true),
                handoff_source: text(&value["handoffSource"]),
                summary_provider: text(&record["lastSummaryProvider"]),
                summary_model: text(&record["lastSummaryModel"]),
                pipeline_mode,
                summary_route: route,
                forked: kind == Some("fork"),
                generated_ms: record["lastSummaryMs"].as_f64(),
                total_ms: record["lastPipelineMs"].as_f64(),
            },
            archived: changed.then(|| Archived { dropped: value["droppedMessages"].as_u64().unwrap_or(0), identities: Some(value["droppedIdentities"].clone()).filter(|i| !i.is_null()) }),
            now,
            started_at: now,
            commit_started_at: now,
            committed_at: std::sync::Arc::new(move || now),
        };
        let (working, result) = committed_header(&facts, &header, &[]);
        assert_eq!(&result, value, "{name}: the reply");
        let mut want = header_of(&case["after"]);
        for key in ["promptBase", "promptStable", "bp3CoreContext", "promptEnv", "bp3EnvSplit"] {
            want.insert(key.into(), header[key].clone());
        }
        assert_eq!(comparable(&working), comparable(&want), "{name}: the header");
        compared += 1;
    }
    assert_eq!(compared, 2);
}

#[test]
fn a_committed_header_equals_nodes_session() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/compaction-commit/golden.json")).expect("golden json");
    let now = golden["now"].as_f64().expect("now");
    let sampled = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (mut differ, mut compared) = (Vec::new(), 0);
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let value = &case["result"]["value"];
        if value.get("error").is_some() {
            continue;
        }
        let before = &case["before"];
        let header = header_of(before);
        let before_rows: Vec<Value> = before["messages"].as_array().expect("messages").clone();
        let messages: Vec<AgentMessage> = before_rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        let snapshot = snapshot_of(case, &header, &messages);
        let plan = with_status(&snapshot, &header, &messages, |status| compaction_plan(status, false, true)).expect("a window").expect("a plan");
        let after = &case["after"];
        let appended_count = case["appendedCount"].as_u64().expect("appendedCount") as usize;
        let after_rows = after["messages"].as_array().expect("after messages");
        let (compacted_rows, appended_rows) = after_rows.split_at(after_rows.len() - appended_count);
        let compacted: Vec<AgentMessage> = compacted_rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        let mode = case["compactMode"].as_str().unwrap_or_default();
        let mut parts = mode.split(':');
        let (pipeline_mode, kind, route) = (parts.next().map(str::to_owned), parts.next(), parts.next().map(str::to_owned));
        let record = &after["compaction"];
        let changed = value["changed"] == Value::Bool(true);
        let facts = CommitFacts {
            snapshot: snapshot.clone(),
            messages,
            before_rows,
            plan,
            compacted,
            compacted_rows: compacted_rows.to_vec(),
            fresh: SummaryFacts {
                usage: Some(value["usage"].clone()).filter(|u| !u.is_null()),
                fresh_context: value["freshContext"] == Value::Bool(true),
                handoff_source: text(&value["handoffSource"]),
                summary_provider: text(&record["lastSummaryProvider"]),
                summary_model: text(&record["lastSummaryModel"]),
                pipeline_mode,
                summary_route: route,
                forked: kind == Some("fork"),
                generated_ms: record["lastSummaryMs"].as_f64(),
                total_ms: record["lastPipelineMs"].as_f64(),
            },
            archived: changed.then(|| Archived { dropped: value["droppedMessages"].as_u64().unwrap_or(0), identities: Some(value["droppedIdentities"].clone()).filter(|i| !i.is_null()) }),
            now,
            started_at: now,
            commit_started_at: now,
            committed_at: { let sampled = sampled.clone(); std::sync::Arc::new(move || { sampled.fetch_add(1, std::sync::atomic::Ordering::SeqCst); now }) },
        };
        let appended: Vec<(ItemId, Value)> = appended_rows.iter().enumerate().map(|(n, row)| (ItemId::from(format!("late_{n}")), row.clone())).collect();
        let (working, result) = committed_header(&facts, &header, &appended);
        if &result != value {
            differ.push(format!("{name}: result Rust {result}, Node {value}"));
        }
        let (got, want) = (comparable(&working), comparable(&header_of(after)));
        if got != want {
            differ.push(format!("{name}: header Rust {got}, Node {want}"));
        }
        compared += 1;
    }
    assert_eq!(compared, 8, "the recorded cases that commit or leave the transcript");
    assert_eq!(sampled.load(std::sync::atomic::Ordering::SeqCst), compared, "`recordCompactionTiming` samples the clock once per commit");
    assert!(differ.is_empty(), "{} differ: {}", differ.len(), differ.iter().take(3).cloned().collect::<Vec<_>>().join(" ; "));
}

#[test]
fn a_header_change_names_what_was_set_and_what_went() {
    let before = json!({ "a": 1, "b": 2, "c": 3 }).as_object().cloned().unwrap();
    let after = json!({ "a": 1, "b": 5, "d": 4 }).as_object().cloned().unwrap();
    let change = header_change(&before, &after);
    assert_eq!(Value::Object(change.set), json!({ "b": 5, "d": 4 }));
    assert_eq!(change.unset, ["c"]);
}

/// Node's `runSessionCompaction` by hand over a conversation that opens with a pasted text
/// (`fixtures/session-gaps/compaction-pasted-text.json`, `record-session-gaps.mjs`): the text stored
/// by the intake, a blob the store no longer has, and a blob another process holds open with no
/// sharing. The same transcript, the same blob in a real attachment store, the plan the manual
/// compaction forces, the session's real compactor over the process world: every summary request
/// the registered provider is sent equals what Node's provider was sent, and a blob that cannot be
/// read for now fails the compaction before any summary is asked.
#[tokio::test]
async fn a_pasted_text_reaches_the_summary_request_as_nodes() {
    use base64::Engine as _;
    use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
    use mixdog_ai::registry::warm::WarmLedger;
    use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
    use mixdog_core_api::domain::mock::{MockAttempt, MockProvider};
    use mixdog_core_api::domain::provider::{Content, ModelRequest, ModelStream, ProviderAdapter, ProviderError, Role, WireCodec};
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_core_domains::domains::ai_admin::model_proxy::StoreAttachments;
    use super::super::compaction_world::tests::services_over;
    use super::super::compaction_world::ProcessCompactionWorld;
    use super::super::compactors::SessionCompactors;
    use super::super::attachment_store::StoreFacts;
    use super::super::media::MediaLowering;
    use super::super::side_question_store::SideQuestionStore;
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::ids::{ConnectionId, Method, OpId};
    use mixdog_core_api::{CoreRequest, Reply, ThreadDirectory, ThreadHandle};

    /// The provider the session routes to: it records each request and answers Node's fixed summary.
    struct Recording {
        inner: MockProvider,
        sent: Mutex<Vec<Arc<ModelRequest>>>,
        /// The error each attempt fails with, when the case's provider throws.
        fail: Option<ProviderError>,
        /// A summary send that stays in flight until its request is dropped (a session closing under it): told once it is sent.
        in_flight: Option<Arc<tokio::sync::Notify>>,
        /// The in-flight streams dropped so far.
        dropped: Arc<std::sync::atomic::AtomicUsize>,
    }
    /// A response that never produces an event; the count says how many were dropped.
    struct Pending(Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for Pending {
        fn drop(&mut self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    #[async_trait]
    impl ModelStream for Pending {
        async fn next(&mut self) -> Option<Result<mixdog_core_api::domain::provider::StreamEvent, ProviderError>> {
            std::future::pending().await
        }
        fn delivery(&self) -> mixdog_core_api::domain::provider::DeliveryState {
            mixdog_core_api::domain::provider::DeliveryState::Accepted
        }
        fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
    }
    #[async_trait]
    impl ProviderAdapter for Recording {
        fn release_send(&self, _group: &str) {}
        fn id(&self) -> &ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            self.sent.lock().unwrap().push(request.clone());
            // Only the first send stays in flight: a start after the session's end is answered.
            if let Some(sent) = &self.in_flight
                && self.sent.lock().unwrap().len() == 1
            {
                sent.notify_one();
                return Ok(Box::new(Pending(self.dropped.clone())));
            }
            if let Some(error) = &self.fail {
                return Err(error.clone());
            }
            self.inner.attempt(request).await
        }
    }
    struct Builds(Arc<Recording>);
    #[async_trait]
    impl ProviderBuilder for Builds {
        async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(self.0.clone())
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
    }
    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_800_000_000_000
        }
    }
    use mixdog_core_api::domain::provider::{Message, RequestOptions};
    use mixdog_testkit::exact::Exact;
    /// The request Node's `provider.send(messages, model, tools, opts)` was handed, as the core's request: every
    /// argument and every option is read, and one the core has no field for must hold what the core sends in its
    /// place (no callback, no abort, no tools).
    fn request_of(sent: &Exact) -> ModelRequest {
        let [messages, model, tools, opts] = sent.as_array() else { panic!("four arguments: {sent:?}") };
        assert_eq!(tools, &Exact::Undefined, "no tools");
        let messages = messages
            .as_array()
            .iter()
            .map(|m| {
                let keys: Vec<&str> = m.entries().iter().map(|(k, _)| k.as_str()).collect();
                assert_eq!(keys, ["role", "content"], "a summary message");
                let role = match m.get("role").as_str() {
                    "system" => Role::System,
                    "user" => Role::User,
                    other => panic!("a summary request role: {other}"),
                };
                Message::new(role, Content::Text(m.get("content").as_str().to_owned()))
            })
            .collect();
        let text = |e: &Exact| match e {
            Exact::Undefined => None,
            other => Some(other.as_str().to_owned()),
        };
        let mut options = RequestOptions::default();
        for (key, value) in opts.entries() {
            match key.as_str() {
                "session" => {
                    let keys: Vec<&str> = value.entries().iter().map(|(k, _)| k.as_str()).collect();
                    assert_eq!(keys, ["id", "sourceType", "provider", "model", "cwd"], "the session handle");
                    assert_eq!((value.get("provider").as_str(), value.get("model").as_str()), ("openai", model.as_str()), "the session's route is the request's");
                    assert_eq!((value.get("sourceType"), value.get("cwd")), (&Exact::Undefined, &Exact::Undefined));
                    assert_eq!(Some(value.get("id").as_str()), text(opts.get("sessionId")).as_deref(), "the session handle names the request's session");
                }
                "effort" => options.effort = text(value),
                "fast" => options.fast = value.as_bool(),
                "requestKind" => options.request_kind = text(value),
                "maxOutputTokens" => options.max_output_tokens_override = Some(value.as_f64() as u32),
                "sessionId" => options.session_id = text(value),
                "usageSessionId" => options.usage_session_id = text(value),
                "effortConfigurationEnabled" => assert!(!value.as_bool(), "{key}"),
                "signal" => assert_eq!(value.get("aborted"), &Exact::Bool(false), "{key}"),
                // Effort spellings of other wires, the configuration, a continuation and the stream callbacks: absent.
                _ => assert_eq!(value, &Exact::Undefined, "{key}"),
            }
        }
        ModelRequest { model: model.as_str().to_owned(), messages, tools: Vec::new(), options }
    }

    use mixdog_core_ports::ports::route::Route;
    use mixdog_tools::orch::util::PortError;
    /// The runtime's live route: the session's own header names its provider and model, so the route adds nothing.
    struct NoRoute;
    impl mixdog_core_ports::ports::route::LiveRoute for NoRoute {
        fn route(&self, _: &ThreadId) -> Route {
            Route::new()
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {
            unreachable!("no route is held")
        }
    }
    /// The route session as the world reads it: no first turn is in flight (the conversation is stored), and the user
    /// conversation is Node's `hasUserConversationMessage`.
    struct Settled;
    #[async_trait]
    impl mixdog_core_ports::ports::route::RouteSession for Settled {
        fn generation(&self, _: &ThreadId) -> u64 {
            0
        }
        async fn live_turn_messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(Vec::new())
        }
        fn has_user_conversation(&self, messages: &[Value]) -> bool {
            mixdog_core_session::session::route_session::has_user_conversation(messages)
        }
        async fn update_route(&self, _: &ThreadId, _: Route, _: bool) -> Result<bool, PortError> {
            unreachable!("no route change")
        }
        async fn record_boundary(&self, _: &ThreadId, _: &str, _: Value) -> Result<bool, PortError> {
            unreachable!("no route change")
        }
        async fn rebuild_tool_surface(&self, _: &ThreadId, _: &str) -> Result<(), PortError> {
            unreachable!("no route change")
        }
        async fn owner_fallbacks(&self, _: &ThreadId, _: &Header, _: &str, _: &str) -> Result<Option<Vec<Value>>, PortError> {
            unreachable!("no route change")
        }
        fn write_statusline(&self, _: &ThreadId, _: &Route) {}
        fn invalidate_context_status(&self, _: &ThreadId) {}
    }
    /// The tool mode the recorder's runtime had (none set).
    struct DefaultMode;
    #[async_trait]
    impl mixdog_core_ports::ports::tools_status::SurfaceHost for DefaultMode {
        fn mode(&self, _: Option<&Header>) -> String {
            String::new()
        }
        async fn preview(&self) -> Result<mixdog_tools::orch::status::StatusSurface, CoreError> {
            unreachable!("the session exists")
        }
        async fn reconcile_empty(&self, _: &ThreadId) -> Result<(), CoreError> {
            unreachable!("the session has its conversation")
        }
    }
    /// The hooks the session ops dispatch (`preCompactHook`, `postCompactHook`), as the recorder's session recorded them.
    struct Hooks(Arc<Mutex<Vec<(String, String)>>>);
    #[async_trait]
    impl super::super::compact_hooks::CompactHooks for Hooks {
        async fn pre(&self, _: &ThreadId, trigger: &str) {
            self.0.lock().unwrap().push(("pre".to_owned(), trigger.to_owned()));
        }
        async fn post(&self, _: &ThreadId, trigger: &str) {
            self.0.lock().unwrap().push(("post".to_owned(), trigger.to_owned()));
        }
    }
    struct NoGauge;
    impl mixdog_core_session::session::route_session::ContextStatusCache for NoGauge {
        fn invalidate(&self, _: &ThreadId) {}
    }

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/session-gaps/compaction-pasted-text.json");
    let exact = Exact::load(&path);
    let recorded: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let mut compared = 0;
    for (case, whole) in recorded["cases"].as_array().unwrap().iter().zip(exact.get("cases").as_array()) {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let blobs = mixdog_store::blobs::BlobStore::new(dir.path());
        let reference = case["part"]["attachmentRef"].as_str().unwrap();
        let path = blobs.path(&mixdog_store::schema::bounded::Digest::try_from(format!("sha256:{reference}")).unwrap());
        let _held = case["blob"].as_str().map(|data| {
            super::super::fixture_fs::write(&path, base64::engine::general_purpose::STANDARD.decode(data).unwrap());
            (name == "held-open").then(|| hold_open(&path))
        });
        // Node's summary provider as scripted per case: the fixed summary, an empty one, or a request error it throws once.
        let body: &[u8] = if name == "empty-summary" { b"u:1000,50\ndone\n" } else { b"t:SUMMARY of the conversation so far\nu:1000,50\ndone\n" };
        let script = (0..case["sends"].as_array().unwrap().len()).map(|_| MockAttempt::Body(body.to_vec()));
        let fail = (name == "provider-error").then(|| {
            let mut error = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::InvalidRequest, mixdog_core_api::domain::provider::DeliveryState::Accepted);
            error.status = Some(400);
            error.message = "openai: 400 invalid request".to_owned();
            error
        });
        const ENDED_IN_FLIGHT: [&str; 3] = ["closed", "deleted", "shutdown"];
        let sent_in_flight = ENDED_IN_FLIGHT.contains(&name).then(|| Arc::new(tokio::sync::Notify::new()));
        let dropped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let provider = Arc::new(Recording { inner: MockProvider::new(script), sent: Mutex::new(Vec::new()), fail, in_flight: sent_in_flight.clone(), dropped: dropped.clone() });
        let hook_calls = Arc::new(Mutex::new(Vec::new()));
        let registry = Arc::new(ProviderRegistry::new(Arc::new(Builds(provider.clone()))));
        let saved = json!({ "providers": { "openai": { "enabled": true } } }).as_object().cloned().unwrap();
        // A session's own route is ready by the time it runs a turn or a compaction: the providers were initialised at its start.
        registry.init_providers(saved["providers"].as_object().unwrap()).await.expect("the providers initialise");
        let mut services = services_over(dir.path(), json!({}), Arc::default(), WarmLedger::new(), Arc::new(SideQuestionStore::new()), registry.clone(), saved.clone()).await;
        let reader: Arc<dyn mixdog_ai::service::model_proxy_inline::AttachmentReader> = Arc::new(StoreAttachments { store: blobs.clone(), interactive: tokens.interactive_io });
        let facts: Arc<dyn super::super::media::AttachmentFacts> = Arc::new(StoreFacts::new(blobs.clone(), &tokens));
        services.reader = reader.clone();
        services.attachment_facts = facts.clone();
        let docs = services.docs.clone();
        let compactors = SessionCompactors::new(Arc::new(ProcessCompactionWorld::new(services)), Arc::new(Fixed));

        // A core transcript row carries its id from the start; Node stamps the same ids on the unstamped messages
        // before the pass (`stampMessageIds`, what migration assigns them).
        let thread = ThreadId::from(format!("gaps-pasted-{name}"));
        let mut rows: Vec<Value> = case["messages"].as_array().unwrap().clone();
        for (row, id) in rows.iter_mut().zip(mixdog_migrate::session::ids::message_iids(thread.as_str(), &case["messages"].as_array().unwrap().clone())) {
            row["meta"]["transcript"]["messageId"] = json!(id);
        }
        let mut header = Header::new();
        for (key, value) in [("provider", json!("openai")), ("model", json!("gpt-x")), ("contextWindow", json!(8000)), ("rawContextWindow", json!(8000)), ("effectiveContextWindowPercent", json!(100)), ("tools", json!([])), ("compaction", json!({ "auto": true }))] {
            header.insert(key.into(), value);
        }

        // The product's composition of the manual compaction (`compose_flip.rs`): the live context world and the thread
        // state over the session directory, bound once the directory is up, and the directory's own transcript.
        let late = Arc::new(super::super::compose_parts::LateDirectory::default());
        let threads = Arc::new(super::super::compose_parts::LateThreads(late.clone()));
        let lowering: Arc<super::super::context_world::LoweringFor> = Arc::new(move |thread: &ThreadId, provider: &str| {
            let lowering = Arc::new(MediaLowering::new(thread.clone(), docs.clone(), reader.clone(), facts.clone(), false, ProviderId::from(provider)));
            (lowering.clone() as Arc<dyn MediaMeter>, lowering as Arc<dyn ImageIdentities>)
        });
        let world = super::super::context_world::LiveContextWorld { threads: threads.clone(), messages: threads.clone(), routes: Arc::new(NoRoute), session: Arc::new(Settled), host: Arc::new(DefaultMode), lowering };
        let (dir_seams, seams) = run_seams().await;
        let manual: Arc<dyn ManualCompaction> = Arc::new(HostManualCompaction::new(ManualParts {
            world: Arc::new(world),
            threads: threads.clone(),
            config: Arc::new(seams),
            compactors: Arc::new(compactors),
            directory: late.clone(),
            hooks: Arc::new(Hooks(hook_calls.clone())),
            gauge: Arc::new(NoGauge),
            clock: Arc::new(Fixed),
            recover: Arc::new(|_| {}),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            data_dir: dir_seams.path().to_path_buf(),
            blobs: Arc::new(super::super::attachment_store::StoreBlobs::new(blobs.clone(), &tokens)),
            reuses: Arc::default(),
        }));
        let rig =mixdog_core_session::session::testing::Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.compaction = manual.clone();
        let directory = Arc::new(mixdog_core_session::session::SessionDirectory::new(Arc::new(deps)));
        late.bind(&directory);
        // Node's session as its store holds it (`saveSessionAsync(live)` before the compaction): the header and the rows.
        directory.create_with_id(thread.clone(), header, json!({})).await.expect("the session");
        let log = mixdog_core_session::session::room_log::SessionRoomLog::new(directory.clone());
        assert_eq!(mixdog_core_session::session::room_log::RoomLog::append_rows(&log, thread.as_str(), rows.clone()).await.expect("the conversation"), rows.len());
        directory.open(&thread, &CallContext::internal("test")).await.expect("the session opens");
        let handle = directory.handle(&thread).expect("loaded");
        let header_before = threads.header(&thread).await.expect("the stored header");

        // The client's compact request (`thread/compact/start`, Node's `compactSessionMessages(sessionId)`).
        let request = CoreRequest {
            method: Method("thread/compact/start"),
            params: json!({ "threadId": thread.as_str(), "opId": "op-compact" }),
            op: Some(OpId::from("op-compact")),
            ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
        };
        let outcome = if name == "cancelled" {
            // A signal that is already aborted (an agent session linked to a cancelled parent, `linkParentSignalToSession`) reaches
            // `compactSessionMessages` as the session's signal: handed to the product's manual compaction as the reason Node's
            // parent aborted with (a client's request carries none: the compaction's own signal is the session's).
            let cancel = Cancel::new();
            cancel.abort("parent turn cancelled");
            manual.compact(&thread, "manual", false, &cancel).await.map(|value| Reply::Value(value.unwrap_or(Value::Null)))
        } else if let Some(sent_in_flight) = sent_in_flight {
            // The session ends while the summary send is in flight: through the product's own close, delete and shutdown. Node's
            // recording closed the same session (`closeSession`, the delete's `desktop-session-delete` close and the runtime's
            // `cli-exit`); the client's answer is what the compaction recorded.
            struct NoShells;
            impl mixdog_core_session::session::shell_jobs::OwnedShells for NoShells {
                fn cancel_owned(&self, _: &ThreadId) {}
            }
            let delete = CoreRequest {
                method: Method("thread/delete"),
                params: json!({ "threadId": thread.as_str(), "opId": "op-delete" }),
                op: Some(OpId::from("op-delete")),
                ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
            };
            let ending = async {
                sent_in_flight.notified().await;
                match name {
                    "closed" => {
                        let close = mixdog_core_session::session::close::SessionClose::new(directory.clone(), registry.clone(), Arc::new(NoShells), Arc::new(mixdog_tools::fs::ReadState::new(None)));
                        assert!(close.close(thread.as_str(), "cli-agent-close").await, "the close landed");
                        None
                    }
                    "deleted" => {
                        // The catalog lists the session (`isAvailableSession`), as Node's does the one it saved.
                        rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
                        Some(handle.request(delete).await)
                    }
                    _ => {
                        directory.shutdown().await;
                        None
                    }
                }
            };
            let (outcome, deleted) = tokio::time::timeout(std::time::Duration::from_secs(60), async { tokio::join!(handle.request(request), ending) })
                .await
                .unwrap_or_else(|_| panic!("{name}: the compaction did not end within 60 s of its session ending"));
            if name == "deleted" {
                let Ok(Reply::Value(answer)) = deleted.expect("the delete was asked") else { panic!("{name}: the delete answers a value") };
                assert_eq!(answer, case["deleted"], "{name}: the delete's answer");
            }
            outcome
        } else {
            handle.request(request).await
        };
        // The send group ties the core loop's own retries of one send; Node retries inside `provider.send`, which is
        // handed no such id.
        let sent: Vec<ModelRequest> = provider
            .sent
            .lock()
            .unwrap()
            .iter()
            .map(|r| ModelRequest { options: RequestOptions { send_group: None, ..r.options.clone() }, ..(**r).clone() })
            .collect();
        let node: Vec<ModelRequest> = whole.get("sends").as_array().iter().map(request_of).collect();
        assert_eq!(sent, node, "{name}: the summary requests, outcome {outcome:?}");
        // The client's answer, whole. A thrown failure is Node's error as it crosses to a client (`name`, `message`, and
        // its errno `code`, `errno`, `syscall` and `path`, which the core's attachment reader does not carry: its
        // `ReadError::Other` is the read's text, `media.rs` `resolve_ref`).
        let (answered, node) = match outcome {
            Ok(Reply::Value(value)) => (Exact::plain(&json!({ "value": value })), whole.get("result").clone()),
            Ok(other) => panic!("{name}: thread/compact/start answers a value: {other:?}"),
            Err(CoreError::DomainError { message, .. }) => {
                let text = message.as_deref().unwrap_or_default().replace(&dir.path().display().to_string(), "<data>");
                let error = &case["result"]["error"];
                (
                    Exact::plain(&json!({ "error": { "name": "Error", "message": text } })),
                    Exact::plain(&json!({ "error": { "name": error["name"], "message": error["message"] } })),
                )
            }
            Err(other) => panic!("{name}: not a domain failure: {other:?}"),
        };
        assert_eq!(answered, node, "{name}: the outcome differs");
        if ENDED_IN_FLIGHT.contains(&name) {
            let after = whole.get("after");
            assert_eq!(case["after"]["signalsAborted"], json!([true]), "{name}: the recording's summary send was aborted");
            // The summary request in flight ended with the session: its stream was dropped, not left open.
            assert_eq!(dropped.load(std::sync::atomic::Ordering::SeqCst), 1, "{name}: the core dropped the summary stream in flight");
            // What the session published: the hooks the session ops dispatch.
            let want: Vec<(String, String)> = case["after"]["events"].as_array().unwrap().iter().map(|e| (e[0].as_str().unwrap().to_owned(), e[1].as_str().unwrap().to_owned())).collect();
            assert_eq!(*hook_calls.lock().unwrap(), want, "{name}: the events published");
            // What is stored afterwards: the transcript whole, no header key changed that Node's did not (a half-applied
            // summary writes the `compaction` record, the new transcript and the usage totals).
            if case["after"]["stored"].is_null() {
                // Node's store holds nothing for it. The core's log keeps the delete mark (and may keep a failure record the
                // abort wrote); what it must not hold is an applied summary.
                let kept = directory.try_stored_header(&thread).await.expect("the read");
                assert!(kept.as_ref().is_none_or(|h| h.get("deleted") == Some(&json!(true)) && h["compaction"]["lastChanged"] != json!(true)), "{name}: a deleted session leaves nothing stored: {kept:?}");
            } else {
                use mixdog_core_ports::ports::memory_source::ThreadMessages as _;
                let stored = threads.messages(&thread).await.expect("the stored transcript");
                assert_eq!(Exact::plain(&Value::Array(stored)), after.get("stored").get("messages").clone(), "{name}: the transcript is unchanged");
                let kept = threads.header(&thread).await.expect("the stored header");
                let changed: Vec<String> = header_before.iter().map(|(k, _)| k).chain(kept.keys()).filter(|k| header_before.get(*k) != kept.get(*k)).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
                let allowed: Vec<String> = case["after"]["stored"]["headerChangedKeys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_owned()).collect();
                assert!(changed.iter().all(|k| allowed.contains(k)), "{name}: the header changed {changed:?}, Node's changed only {allowed:?}");
            }
            // A start after it finds no compaction pending: none is begun and no summary is asked (Node's session ends: a
            // start answers nothing; a runtime that stays up is not a core's shutdown, which ends the directory: named in the manifest).
            if name != "shutdown" {
                assert_eq!(case["after"]["next"]["sendsAfter"], 0);
                let sent_before = provider.sent.lock().unwrap().len();
                let again = CoreRequest {
                    method: Method("thread/compact/start"),
                    params: json!({ "threadId": thread.as_str(), "opId": "op-compact-again" }),
                    op: Some(OpId::from("op-compact-again")),
                    ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
                };
                let answer = tokio::time::timeout(std::time::Duration::from_secs(30), directory.request(again))
                    .await
                    .unwrap_or_else(|_| panic!("{name}: a start after the session's end was not answered within 30 s"));
                assert!(matches!(answer, Ok(Reply::Value(Value::Null)) | Err(_)), "{name}: a start after the end begins no compaction: {answer:?}");
                assert_eq!(provider.sent.lock().unwrap().len(), sent_before, "{name}: no summary is asked");
            }
        }
        compared += 1;
    }
    assert_eq!(compared, 9);
}

/// The configuration seams over an empty saved configuration and environment (the recorder ran with neither).
async fn run_seams() -> (tempfile::TempDir, super::super::run_seams::ConfigRunSeams) {
    use mixdog_core_agents::agents::{AgentDefinitions, AgentEvidence};
    use mixdog_core_config::config::{AgentRoutes, Config, ConfigLanes};
    struct NoEvidence;
    #[async_trait]
    impl AgentEvidence for NoEvidence {
        async fn home_greeted(&self, _: &str) -> bool {
            false
        }
        async fn home_chatted(&self, _: &str) -> bool {
            false
        }
        async fn mixy_owns_routines(&self) -> Result<bool, String> {
            Ok(false)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
    let agents = AgentDefinitions::new(dir.path(), dir.path(), tokens.interactive_io, AgentRoutes::new(config.clone(), dir.path()), Arc::new(NoEvidence), Arc::new(|| Value::Null), dir.path().join("workspace"));
    let seams = super::super::run_seams::ConfigRunSeams::new(config, Arc::new(agents), dir.path().to_path_buf(), dir.path().to_path_buf(), Arc::new(|_| None));
    (dir, seams)
}

/// Holds `path` open with no sharing, as another process holding the file does, until dropped.
#[cfg(windows)]
fn hold_open(path: &std::path::Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap()
}

/// Takes every permission off `path` (EACCES, transient in Node too) until the guard is dropped.
#[cfg(unix)]
fn hold_open(path: &std::path::Path) -> impl Drop {
    use std::os::unix::fs::PermissionsExt as _;
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o644));
        }
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0)).unwrap();
    Restore(path.to_path_buf())
}

/// `compactConversationForHeir` hands the compactor the source's whole transcript: the system blocks its requests lead with
/// (`source.messages` holds them), then the conversation. Each case is what Node's `compactConversation` received
/// (fixtures/inheritance-carry/golden.json, `record-inheritance-carry.mjs`).
#[test]
fn the_compactor_of_an_heir_sees_the_source_transcript_with_its_system_blocks() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/inheritance-carry/golden.json")).expect("golden json");
    let wire = |message: &AgentMessage| {
        let role = match message.message.role {
            mixdog_core_api::domain::provider::Role::System => "system",
            mixdog_core_api::domain::provider::Role::User => "user",
            mixdog_core_api::domain::provider::Role::Assistant => "assistant",
            other => panic!("a role the golden has none of: {other:?}"),
        };
        let mixdog_core_api::domain::provider::Content::Text(content) = &message.message.content else { panic!("text content") };
        let tier = message.message.cache_tier.map(|tier| match tier {
            mixdog_core_api::domain::provider::CacheTier::Tier3 => "tier3",
            mixdog_core_api::domain::provider::CacheTier::Env => "env",
        });
        match tier {
            Some(tier) => json!({ "role": role, "content": content, "cacheTier": tier }),
            None => json!({ "role": role, "content": content }),
        }
    };
    let mut compared = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let Some(call) = case["compactorCalls"].as_array().expect("calls").first() else { continue };
        let source = case["setup"]["source"]["messages"].as_array().expect("source messages");
        let block = |tier: Option<&str>| source.iter().find(|m| m["role"] == "system" && m["cacheTier"].as_str() == tier).map(|m| m["content"].clone()).expect("the system block");
        let mut header = Header::new();
        header.insert("bp3EnvSplit".into(), json!(true));
        header.insert("promptBase".into(), block(None));
        header.insert("bp3CoreContext".into(), block(Some("tier3")));
        header.insert("promptEnv".into(), block(Some("env")));
        let rows: Vec<Value> = source.iter().filter(|m| m["role"] != "system").cloned().collect();
        let got: Vec<Value> = super::super::factory::session_messages(&header, &rows).expect("messages").iter().map(wire).collect();
        assert_eq!(Value::Array(got), call["messages"], "{}", case["name"]);
        compared += 1;
    }
    assert_eq!(compared, 6);
}