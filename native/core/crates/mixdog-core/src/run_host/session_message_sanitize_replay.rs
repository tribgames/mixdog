//! `fixtures/session-message-sanitize/recording.json` line 66 (`record-session-message-sanitize.mjs`): a shell
//! task's completion reaches a turn in flight, the steering drain before the first model call adds it to the
//! conversation, and the next turn's request keeps everything the previous one sent. Played as a client and a
//! background job produce it: `turn/start`, the job's completion through the directory's `TaskNotifier::finished`
//! (the call `mixdog-tools` exec makes), the real agent loop of the run host asking an in-process provider, and the
//! conversation read back with `thread/modelMessages/list` at each request. The other cases of the set are in
//! `mixdog-core-session` (`session/message_sanitize_replay.rs`).

use mixdog_core_session::session::testing::awaiting;
use mixdog_testkit::exact::Exact;

use super::*;

fn recording() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/session-message-sanitize/recording.json");
    Exact::decode(&serde_json::from_str(text).expect("the recording is JSON")).expect("the recording decodes")
}

/// A provider that reports each attempt and answers it only once the test lets it.
struct Gated {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    script: Mutex<VecDeque<Vec<StreamEvent>>>,
    attempted: tokio::sync::mpsc::UnboundedSender<()>,
    go: tokio::sync::Semaphore,
}

#[async_trait]
impl ProviderAdapter for Gated {
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, _request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let _ = self.attempted.send(());
        self.go.acquire().await.expect("the gate stays open").forget();
        let steps = lock(&self.script).pop_front().expect("provider script exhausted");
        Ok(Box::new(Steps(steps.into())))
    }
}

/// The test's `read`: the tool work the recording holds answers "The check passed.".
struct Read(ToolSpec);

#[async_trait]
impl Tool for Read {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text("The check passed.".into())], ..ToolOutput::default() })
    }
}

/// The run's parts; the first assembly waits until the test has queued the completion, so the turn is in flight
/// when it arrives.
struct HeldParts {
    provider: Arc<dyn ProviderAdapter>,
    workspace: std::path::PathBuf,
    assembling: tokio::sync::mpsc::UnboundedSender<()>,
    release: tokio::sync::Semaphore,
}

#[async_trait]
impl RunParts for HeldParts {
    async fn reconcile_turn(&self, _: &ThreadId, header: mixdog_store::schema::record::Header, _: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
        Ok(header)
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let _ = self.assembling.send(());
        self.release.acquire().await.expect("the gate stays open").forget();
        let spec = ToolSpec {
            name: "read".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "read".into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        let tokens = mixdog_rt::testing::tokens();
        Ok(Assembled {
            provider: self.provider.clone(),
            tools: ToolSet::new(vec![Arc::new(Read(spec)) as Arc<dyn Tool>]),
            tool_env: ToolEnv {
                thread_id: input.thread.clone(),
                turn_id: input.turn.clone(),
                cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: input.progress.clone(),
                deadline_of: None,
                notify: input.notify.clone(),
                review: None,
            },
            gate: Box::new(|_| Arc::new(AllowAll)),
            worktree: self.workspace.to_string_lossy().into_owned(),
            config: RunConfig::new(input.thread.clone(), input.turn.clone(), "m"),
            clock: Arc::new(Fixed),
            decider: Arc::new(MockRetryDecider),
            guards: Arc::new(NoGuards),
            compactor: None,
            route: None,
            skills: None,
            hooks: None,
            reuse: None,
            reactions: None,
            reaction_scope: None,
            rows: Arc::default(),
            tail: None,
            side: None,
            step_judge: None,
            artifacts: None,
            images: None,
            failures: None,
            blobs: Arc::new(NoBlobs),
            carry: RunCarry::default(),
        })
    }
}

/// `thread/modelMessages/list` from the first message, as a client reads it.
async fn model_messages(directory: &SessionDirectory, id: &ThreadId) -> Vec<Value> {
    let read = request("thread/modelMessages/list", json!({ "threadId": id, "start": 0 }), "op-read");
    let Reply::Value(reply) = directory.request(read).await.expect("thread/modelMessages/list") else { panic!("a value reply") };
    reply["messages"].as_array().cloned().expect("the messages")
}

/// The ids every message the core makes carries in `meta.transcript.messageId` (`msg_` + 32 hex, random): a
/// drained notification's as the recorder masked it (`msg_<id>`), a prompt row's removed where the recording holds the
/// test's literal prompt without one (both declared in the manifest).
fn as_recorded(rows: &[Value]) -> Exact {
    let is_id = |value: &str| value.strip_prefix("msg_").is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let rows: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut row = row.clone();
            let notification = row.pointer("/meta/source") == Some(&json!("task-notification"));
            if let Some(meta) = row.get_mut("meta").and_then(Value::as_object_mut) {
                if notification {
                    // The product entry's queue ids and execution, which the recorder's hand-built entry lacks.
                    meta.shift_remove("execution");
                    meta.shift_remove("submissionIds");
                }
                if let Some(transcript) = meta.get_mut("transcript").and_then(Value::as_object_mut)
                    && transcript.get("messageId").and_then(Value::as_str).is_some_and(is_id)
                {
                    if notification {
                        transcript.insert("messageId".into(), json!("msg_<id>"));
                    } else {
                        transcript.shift_remove("messageId");
                    }
                    if transcript.is_empty() {
                        meta.shift_remove("transcript");
                    }
                }
                if meta.is_empty() {
                    row.as_object_mut().expect("a row").shift_remove("meta");
                }
            }
            row
        })
        .collect();
    Exact::plain(&Value::Array(rows))
}

/// Line 66: a completion that reaches a running turn is drained into its conversation as a task-notification row
/// (`drained`, no skill prompt, the row of `afterDrain`), and the next turn's request keeps every row the previous
/// request sent, in order, before its answer and new prompt (`nextRequest`). The product drains at the first request
/// after a tool batch (`send-phase.mjs:53`, the core's `run.rs` `begin_iteration`), where the recorder called the
/// drain before the first request; the recorder's literal tool rows (`sentHistory`) and the cache guard's state
/// (`guardFirst`, `retained`, `shrunk`) are not product values. The manifest declares each.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_66_a_drained_notification_keeps_the_provider_prefix_across_a_turn() {
    let recording = recording();
    let case = recording.get("cases").as_array().iter().find(|case| case.get("testLine").as_f64() == 66.0).expect("the case at line 66");
    let (input, result) = (case.get("input"), case.get("result"));
    let prompt = input.get("prompt").as_str().to_owned();
    let drained = input.get("drained").as_array();
    assert_eq!(drained.len(), 1, "one drained entry");
    assert_eq!(drained[0].get("mode").as_str(), "task-notification");
    let notification = drained[0].get("content").as_str().to_owned();
    let work = input.get("toolWork").as_array();
    let call = work[0].get("toolCalls").as_array()[0].clone();
    let answer = result.get("nextRequest").as_array()[4].get("content").as_str().to_owned();
    let follow_up = result.get("nextRequest").as_array()[5].get("content").as_str().to_owned();

    let (attempted, mut attempts) = tokio::sync::mpsc::unbounded_channel();
    let provider = Arc::new(Gated {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![
                StreamEvent::TextDelta(work[0].get("content").as_str().to_owned()),
                StreamEvent::ToolCallDone(ToolCall {
                    id: call.get("id").as_str().to_owned(),
                    name: call.get("name").as_str().to_owned(),
                    arguments: call.get("args").to_plain().expect("the call's arguments"),
                    native_type: None,
                }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ],
            vec![StreamEvent::TextDelta(answer.clone()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            vec![StreamEvent::TextDelta("Continuing.".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
        ])),
        attempted,
        go: tokio::sync::Semaphore::new(0),
    });
    let (assembling, mut assembled) = tokio::sync::mpsc::unbounded_channel();
    let workspace = tempfile::tempdir().unwrap();
    let parts = Arc::new(HeldParts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), assembling, release: tokio::sync::Semaphore::new(0) });
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), parts.clone()));
    let directory = SessionDirectory::new(Arc::new(deps));
    let Reply::Subscribe(subscribe) = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start") else {
        panic!("thread/start subscribes")
    };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");

    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": prompt } }), "op-1")).await.expect("turn/start");
    awaiting(|| "the first turn's assembly".to_owned(), assembled.recv()).await.expect("assembled");
    mixdog_tools::exec::TaskNotifier::finished(&directory, &id, "shell", "task_history", "completed", notification).await;
    parts.release.add_permits(1);
    awaiting(|| "the first request".to_owned(), attempts.recv()).await.expect("attempted");
    let first_request = model_messages(&directory, &id).await;
    provider.go.add_permits(1);
    awaiting(|| "the request after the tool work".to_owned(), attempts.recv()).await.expect("attempted");
    let sent_history = model_messages(&directory, &id).await;
    provider.go.add_permits(1);
    let completed = || rig.feeds.frames(id.as_str()).into_iter().filter(|(_, method, params)| method == "turn/completed" && params["turn"]["status"] == "completed").count();
    eventually_on_awaiting(|| format!("the first turn to complete (seen {})", completed()), &[handle.stepped(), &*rig.feeds.published], || (completed() >= 1).then_some(())).await;

    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": follow_up } }), "op-2")).await.expect("turn/start");
    awaiting(|| "the second turn's assembly".to_owned(), assembled.recv()).await.expect("assembled");
    parts.release.add_permits(1);
    awaiting(|| "the next turn's request".to_owned(), attempts.recv()).await.expect("attempted");
    let next_request = model_messages(&directory, &id).await;
    provider.go.add_permits(1);

    // What the drain added between the first request and the one after the tool batch.
    let added = &sent_history[first_request.len()..];
    let notifications: Vec<Value> = added.iter().filter(|row| row.pointer("/meta/source") == Some(&json!("task-notification"))).cloned().collect();
    let skill_prompts: Vec<Value> = added.iter().filter(|row| row.pointer("/meta/source") == Some(&json!("skill"))).cloned().collect();
    let after_drain = [vec![first_request[0].clone()], notifications.clone()].concat();
    let next_tail = &next_request[sent_history.len()..];
    let tail = |rows: &[Value]| Exact::plain(&Value::Array(rows.iter().map(|row| json!({ "role": row["role"], "content": row["content"] })).collect()));
    let recorded_next = result.get("nextRequest").as_array();
    let got = [
        ("drained", Exact::Bool(notifications.len() == 1), result.get("drained").clone()),
        ("skillPromptCalls", Exact::plain(&Value::Array(skill_prompts)), result.get("skillPromptCalls").clone()),
        ("afterDrain", as_recorded(&after_drain), result.get("afterDrain").clone()),
        ("nextRequest prefix", as_recorded(&next_request[..sent_history.len()]), as_recorded(&sent_history)),
        ("nextRequest answer and prompt", tail(next_tail), tail(&recorded_next[recorded_next.len() - 2..].iter().map(|row| row.to_plain().expect("a row")).collect::<Vec<_>>())),
    ];
    let differ: Vec<String> = got.iter().filter(|(_, core, node)| core != node).map(|(key, core, node)| format!("{key}:\n core {core:?}\n node {node:?}")).collect();
    assert!(differ.is_empty(), "{}", differ.join("\n"));
}
