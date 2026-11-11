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
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/compaction-commit/golden.json")).expect("golden json");
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

    /// The provider the session routes to: it records each request and answers Node's fixed summary.
    struct Recording {
        inner: MockProvider,
        sent: Mutex<Vec<Arc<ModelRequest>>>,
    }
    #[async_trait]
    impl ProviderAdapter for Recording {
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

    /// The pass reads its snapshot from the caller here; the world is never asked.
    struct NoWorld;
    #[async_trait]
    impl ContextWorld for NoWorld {
        async fn snapshot(&self, _: Option<&ThreadId>) -> Result<Option<ContextSnapshot>, CoreError> {
            unreachable!("the pass is handed its snapshot")
        }
        fn lowering(&self, _: &ThreadId, _: &str) -> Meters {
            unreachable!("the pass is handed its snapshot")
        }
    }
    /// The live session's header, which a failed pass patches.
    struct Headers(Mutex<Header>);
    #[async_trait]
    impl ThreadState for Headers {
        async fn header(&self, _: &ThreadId) -> Result<Header, mixdog_tools::orch::util::PortError> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn patch_header(&self, _: &ThreadId, set: serde_json::Map<String, Value>, unset: Vec<String>) -> Result<(), mixdog_tools::orch::util::PortError> {
            let mut header = self.0.lock().unwrap();
            header.extend(set);
            for key in unset {
                header.remove(&key);
            }
            Ok(())
        }
        async fn patch_header_if(&self, _: &ThreadId, _: serde_json::Map<String, Value>, _: serde_json::Map<String, Value>, _: Vec<String>) -> Result<Option<serde_json::Map<String, Value>>, mixdog_tools::orch::util::PortError> {
            unreachable!("a manual pass patches unconditionally")
        }
        async fn publish(&self, _: &ThreadId, _: mixdog_core_ports::ports::threads::Section) -> Result<(), mixdog_tools::orch::util::PortError> {
            Ok(())
        }
    }
    /// The recorder ran no hook.
    struct NoHooks;
    #[async_trait]
    impl super::super::compact_hooks::CompactHooks for NoHooks {
        async fn pre(&self, _: &ThreadId, _: &str) {}
        async fn post(&self, _: &ThreadId, _: &str) {}
    }
    struct NoGauge;
    impl mixdog_core_session::session::route_session::ContextStatusCache for NoGauge {
        fn invalidate(&self, _: &ThreadId) {}
    }
    /// Node's live session: the pass reads its transcript, and the commit lands with no row appended meanwhile.
    struct Committed {
        rows: Vec<Value>,
        header: Header,
    }
    #[async_trait]
    impl PassTranscript for Committed {
        async fn context(&self, _: &ThreadId) -> Result<Vec<(ItemId, Value)>, CoreError> {
            Ok(self.rows.iter().enumerate().map(|(n, row)| (ItemId::from(format!("item_{n}")), row.clone())).collect())
        }
        async fn commit(&self, _: &ThreadId, _: Vec<ItemId>, _: Compaction, header: CompactionHeader) -> Result<CompactionCommit, CoreError> {            header(&self.header, &[]);
            Ok(CompactionCommit::Applied)
        }
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
        let script = (0..case["sends"].as_array().unwrap().len()).map(|_| MockAttempt::Body(b"t:SUMMARY of the conversation so far\nu:1000,50\ndone\n".to_vec()));
        let provider = Arc::new(Recording { inner: MockProvider::new(script), sent: Mutex::new(Vec::new()) });
        let registry = Arc::new(ProviderRegistry::new(Arc::new(Builds(provider.clone()))));
        let saved = json!({ "providers": { "openai": { "enabled": true } } }).as_object().cloned().unwrap();
        let mut services = services_over(dir.path(), json!({}), Arc::default(), WarmLedger::new(), Arc::new(SideQuestionStore::new()), registry, saved).await;
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
        let messages: Vec<AgentMessage> = rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        let mut header = Header::new();
        for (key, value) in [("provider", json!("openai")), ("model", json!("gpt-x")), ("contextWindow", json!(8000)), ("rawContextWindow", json!(8000)), ("effectiveContextWindowPercent", json!(100)), ("tools", json!([])), ("compaction", json!({ "auto": true }))] {
            header.insert(key.into(), value);
        }
        let lowering = Arc::new(MediaLowering::new(thread.clone(), docs, reader, facts, false, ProviderId::from("openai")));
        let snapshot = ContextSnapshot {
            header: header.clone(),
            provider: "openai".into(),
            model: "gpt-x".into(),
            context_window: Value::Null,
            cwd: Value::Null,
            mode: Value::Null,
            messages: messages.clone(),
            active: true,
            request_native: Vec::new(),
            request_defined: Vec::new(),
            session_defined: Vec::new(),
            agent_mode: false,
            annotations: HashMap::new(),
            media: lowering.clone(),
            images: lowering,
            rows: Arc::new(StoredBodies),
            replay_owner: ProviderId::from("openai"),
        };
        let (dir_seams, seams) = run_seams().await;
        let manual = HostManualCompaction::new(ManualParts {
            world: Arc::new(NoWorld),
            threads: Arc::new(Headers(Mutex::new(header.clone()))),
            config: Arc::new(seams),
            compactors: Arc::new(compactors),
            next: super::super::next_request_source::NextRequestSource::new(),
            hooks: Arc::new(NoHooks),
            gauge: Arc::new(NoGauge),
            clock: Arc::new(Fixed),
            recover: Arc::new(|_| {}),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            data_dir: dir_seams.path().to_path_buf(),
            blobs: Arc::new(super::super::attachment_store::StoreBlobs::new(blobs.clone(), &tokens)),
        });
        let committed = Committed { rows: rows.clone(), header: header.clone() };
        // Node's `runSessionCompaction(live, { mode: 'manual', force: true })` is the core's manual pass.
        let outcome = manual.pass(&thread, "manual", false, snapshot, &committed).await;
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
        // A failure reaches the client as its message (`compactFailureNotice` presents the error's text); Node's
        // errno code and props do not cross the core's attachment reader, which carries text only.
        let (answered, node) = match outcome {
            Ok(Some(value)) => (Exact::plain(&json!({ "value": value })), whole.get("result").clone()),
            Ok(None) => (Exact::plain(&json!({ "value": null })), whole.get("result").clone()),
            Err(CoreError::DomainError { message, .. }) => {
                let text = message.as_deref().unwrap_or_default().replace(&dir.path().display().to_string(), "<data>");
                (
                    Exact::plain(&json!({ "error": { "message": text } })),
                    Exact::plain(&json!({ "error": { "message": case["result"]["error"]["message"] } })),
                )
            }
            Err(other) => panic!("{name}: not a domain failure: {other:?}"),
        };
        assert_eq!(answered, node, "{name}: the outcome differs");
        compared += 1;
    }
    assert_eq!(compared, 3);
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
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/inheritance-carry/golden.json")).expect("golden json");
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