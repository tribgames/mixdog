//! `fixtures/session-restart-prefix/recording.json` (`record-session-restart-prefix.mjs`): Node's
//! `restart-prefix-parity` scenario run by the core. A lead session on anthropic-oauth `claude-opus-5-5`
//! (Korean, so every request carries the turn-scoped language reminder) answers scripted steps; the
//! process stops while idle, inside a tool run or with a request on the wire; a new directory over what
//! the store held then (a SIGKILL keeps only what was durable) resumes the session with a third task.
//! Every request body the turns put on the wire, built by the production Anthropic codec from what the
//! loop asks, must equal Node's block for block, before and after the restart. Node's `changes` and
//! `comparisons` are a walk over those bodies, so equal bodies give equal walks.
//!
//! Inputs, not outputs: the session's system texts (Node's composed prompt, with the recording
//! machine's environment block) are put in the header's prompt fields as recorded, and the tools are
//! Node's definitions, `read` calling the core's own read tool. The scripted answers enter as
//! Anthropic event streams through the codec's decoder. Not replayed: the cache warm body after the
//! restart (`warmBody`), which the core rebuilds through the production assembly
//! (`NextRequestSource::last_sent`, not the test's `RunParts`).

use std::sync::atomic::AtomicUsize;

use mixdog_ai::providers::anthropic::{AnthropicCodec, AnthropicConfig, Flavor};

use super::*;

const MODEL: &str = "claude-opus-5-5";

fn recording() -> Value {
    #[allow(clippy::disallowed_methods)] // test fixture loading
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/session-restart-prefix/recording.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// One scripted answer of the fixture (`toolStep`, `textStep`), or a request that is never answered.
#[derive(Clone)]
enum Step {
    Tool(&'static str),
    Text(&'static str),
    Hang,
}

/// The Anthropic event stream of a step. A tool step: a thinking block `plan <id>` signed `sig-<id>`, the text,
/// and the tool call. A text step: the text alone — the fixture's `textStep` hands Node's loop `thinkingBlocks`
/// with no `providerReplay`, and Node's terminal commit (`appendAssistantTurnMessage`) keeps only the replay, so
/// Node's wire carries no thinking for that turn; a real stream would carry it on both sides.
fn sse(step: &Step) -> Vec<u8> {
    let (text, call) = match step {
        Step::Tool(id) => ("Reading.", Some(*id)),
        Step::Text(text) => (*text, None),
        Step::Hang => unreachable!(),
    };
    let mut events = vec![json!({ "type": "message_start", "message": { "id": "msg_1", "type": "message", "role": "assistant", "model": MODEL, "content": [], "stop_reason": null, "usage": { "input_tokens": 10, "output_tokens": 0 } } })];
    let mut index = 0;
    if let Some(id) = call {
        events.push(json!({ "type": "content_block_start", "index": index, "content_block": { "type": "thinking", "thinking": format!("plan {id}"), "signature": format!("sig-{id}") } }));
        events.push(json!({ "type": "content_block_stop", "index": index }));
        index += 1;
    }
    events.push(json!({ "type": "content_block_start", "index": index, "content_block": { "type": "text", "text": "" } }));
    events.push(json!({ "type": "content_block_delta", "index": index, "delta": { "type": "text_delta", "text": text } }));
    events.push(json!({ "type": "content_block_stop", "index": index }));
    index += 1;
    if let Some(call) = call {
        events.push(json!({ "type": "content_block_start", "index": index, "content_block": { "type": "tool_use", "id": call, "name": "read", "input": {} } }));
        events.push(json!({ "type": "content_block_delta", "index": index, "delta": { "type": "input_json_delta", "partial_json": json!({ "path": format!("{call}.txt") }).to_string() } }));
        events.push(json!({ "type": "content_block_stop", "index": index }));
    }
    let stop = if call.is_some() { "tool_use" } else { "end_turn" };
    events.push(json!({ "type": "message_delta", "delta": { "stop_reason": stop }, "usage": { "output_tokens": 5 } }));
    events.push(json!({ "type": "message_stop" }));
    events.iter().map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap())).collect::<String>().into_bytes()
}

struct Hanging;

#[async_trait]
impl ModelStream for Hanging {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        std::future::pending().await
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

/// The fixture's fake provider: records the body the Anthropic codec builds for every send and answers from the script.
struct Recorder {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: AnthropicCodec,
    script: Mutex<VecDeque<Step>>,
    bodies: Mutex<Vec<Value>>,
    killed: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl ProviderAdapter for Recorder {
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
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let wire = self.codec.encode(&request)?;
        lock(&self.bodies).push(serde_json::from_slice(&wire.body).expect("a JSON body"));
        let step = lock(&self.script).pop_front().expect("an unscripted send");
        if let Step::Hang = step {
            self.killed.notify_one();
            return Ok(Box::new(Hanging));
        }
        let mut decoder = self.codec.decoder(&request);
        let mut events = decoder.feed(&sse(&step))?;
        events.extend(decoder.finish()?);
        Ok(Box::new(Steps(events.into())))
    }
}

/// Node's tool definition; `read` runs the core's read tool, and the run that reaches `hang_at` reads stops there.
struct NodeTool {
    spec: ToolSpec,
    read: Option<Arc<mixdog_tools::fs::ReadTool>>,
    reads: Arc<AtomicUsize>,
    hang_at: Option<usize>,
    killed: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl Tool for NodeTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let read = self.read.as_ref().expect("only read is called");
        let n = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if self.hang_at == Some(n) {
            self.killed.notify_one();
            std::future::pending::<()>().await;
        }
        read.call(ctx, args).await
    }
}

struct Session {
    provider: Arc<Recorder>,
    workspace: std::path::PathBuf,
    tools: Value,
    reads: Arc<AtomicUsize>,
    hang_at: Option<usize>,
}

#[async_trait]
impl RunParts for Session {
    async fn reconcile_turn(&self, _: &ThreadId, header: mixdog_store::schema::record::Header, _: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
        Ok(header)
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let read = Arc::new(mixdog_tools::fs::ReadTool::new(None, None));
        let tools: Vec<Arc<dyn Tool>> = self
            .tools
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| {
                let name = tool["name"].as_str().unwrap().to_owned();
                let spec = ToolSpec {
                    name: name.clone(),
                    title: None,
                    trigger: None,
                    public: true,
                    aliases: Vec::new(),
                    description: tool["description"].as_str().unwrap().to_owned(),
                    input_schema: tool["input_schema"].clone(),
                    annotations: ToolAnnotations::default(),
                    parallel_safe: name == "read",
                    exclusive_with: Vec::new(),
                };
                Arc::new(NodeTool { spec, read: (name == "read").then(|| read.clone()), reads: self.reads.clone(), hang_at: self.hang_at, killed: self.provider.killed.clone() }) as Arc<dyn Tool>
            })
            .collect();
        let tokens = mixdog_rt::testing::tokens();
        let context = crate::run_host::tail::tail_context(input.header, || None);
        Ok(Assembled {
            provider: self.provider.clone(),
            tools: ToolSet::new(tools),
            tool_env: ToolEnv {
                thread_id: input.thread.clone(),
                turn_id: input.turn.clone(),
                cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
                processes: Arc::new(MockProcessManager::default()),
                progress: input.progress.clone(),
                deadline_of: None,
                notify: input.notify.clone(),
                review: None,
            },
            gate: Box::new(|_| Arc::new(AllowAll)),
            worktree: self.workspace.to_string_lossy().into_owned(),
            config: {
                // The request options the production assembly gives a turn (`request_parts`).
                let mut config = RunConfig::new(input.thread.clone(), input.turn.clone(), MODEL);
                crate::run_host::assemble::apply_identity(&mut config.options, input.thread, input.header, Some(input.turn.clone()));
                crate::run_host::assemble::apply_cache_opts(&mut config.options, input.header);
                config
            },
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
            tail: Some(crate::run_host::tail::session_tail_reminder(context)),
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

/// A process of the fixture: a directory over `rig`'s store whose sends follow `script`.
struct Process {
    rig: Rig,
    directory: SessionDirectory,
    provider: Arc<Recorder>,
}

async fn process(rig: Rig, codec: AnthropicCodec, script: Vec<Step>, workspace: &std::path::Path, tools: &Value, hang_at: Option<usize>) -> Process {
    let provider = Arc::new(Recorder {
        id: ProviderId::from("anthropic-oauth"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec,
        script: Mutex::new(script.into()),
        bodies: Mutex::new(Vec::new()),
        killed: Arc::new(tokio::sync::Notify::new()),
    });
    let mut deps = rig.deps_parts(rig.store.clone());
    let session = Session { provider: provider.clone(), workspace: workspace.to_path_buf(), tools: tools.clone(), reads: Arc::default(), hang_at };
    deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(session)));
    let directory = SessionDirectory::new(Arc::new(deps));
    Process { rig, directory, provider }
}

impl Process {
    async fn turn(&self, id: &ThreadId, prompt: &str, op: &str) {
        let handle = self.directory.handle(id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("turn/start");
    }

    /// Waits until `turns` turns of the thread have completed.
    async fn settled(&self, id: &ThreadId, turns: usize) {
        let handle = self.directory.handle(id).expect("loaded");
        let completed = || self.rig.feeds.frames(id.as_str()).into_iter().filter(|(_, method, params)| method == "turn/completed" && params["turn"]["status"] == "completed").count();
        eventually_on_awaiting(|| format!("{turns} completed turns (seen {})", completed()), &[handle.stepped(), &*self.rig.feeds.published], || (completed() >= turns).then_some(())).await;
    }

    /// What a SIGKILL leaves: the records durable now, once no write is landing.
    async fn killed(&self, id: &ThreadId) -> Vec<Record> {
        self.provider.killed.notified().await;
        let mut seen = usize::MAX;
        loop {
            let now = self.rig.store.records(id).len();
            if now == seen {
                break;
            }
            seen = now;
            for _ in 0..200 {
                tokio::task::yield_now().await;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.rig.store.records(id).into_iter().map(|(_, record)| record).collect()
    }

    fn bodies(&self) -> Vec<Value> {
        lock(&self.provider.bodies).clone()
    }
}

/// The paths where `core` and `node` differ, each with both values (cut).
fn differences(core: &Value, node: &Value, at: &str, out: &mut Vec<String>) {
    match (core, node) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
                differences(a.get(key).unwrap_or(&Value::Null), b.get(key).unwrap_or(&Value::Null), &format!("{at}.{key}"), out);
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!("{at}: core {} entries | node {}", a.len(), b.len()));
            }
            for n in 0..a.len().max(b.len()) {
                differences(a.get(n).unwrap_or(&Value::Null), b.get(n).unwrap_or(&Value::Null), &format!("{at}[{n}]"), out);
            }
        }
        _ if core != node => {
            let cut = |v: &Value| v.to_string().chars().take(400).collect::<String>();
            out.push(format!("{at}: core {} | node {}", cut(core), cut(node)));
        }
        _ => {}
    }
}

fn same(core: &Value, node: &Value, what: &str) {
    let mut out = Vec::new();
    differences(core, node, "$", &mut out);
    assert!(out.is_empty(), "{what}:\n{}", out.join("\n"));
}

async fn replay(name: &str) {
    let recorded = recording();
    let case = recorded["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).unwrap().clone();
    let result = &case["result"];
    let before = result["before"]["bodies"].as_array().unwrap();
    let after = result["after"]["bodies"].as_array().unwrap();
    let system = before[0]["system"].as_array().unwrap();
    let tools = before[0]["tools"].clone();
    let workspace = tempfile::tempdir().unwrap();
    for name in ["call_1", "call_2", "call_3"] {
        std::fs::write(workspace.path().join(format!("{name}.txt")), format!("{name}\n")).unwrap();
    }
    let w = crate::run_host::process_tests::world(&[], json!({}), Vec::new()).await;
    let caps = crate::run_host::builder_env::CatalogCaps::new(w.services.catalog.clone(), &*w.services.env).lookup();
    let codec = || {
        let mut config = AnthropicConfig::new(caps.clone());
        // Node's recorded body is the one its request builder makes (`_buildRequestBodyForCacheSmoke`): unthreaded.
        config.message_threads = false;
        AnthropicCodec::new(Flavor::OAuth, config)
    };
    let phase = case["input"]["phases"][0].as_str().unwrap();
    let script = match phase {
        "idle" => vec![Step::Tool("call_1"), Step::Text("done one"), Step::Tool("call_2"), Step::Text("done two")],
        "killtool" => vec![Step::Tool("call_1"), Step::Text("done one"), Step::Tool("call_2"), Step::Tool("call_3")],
        _ => vec![Step::Tool("call_1"), Step::Text("done one"), Step::Tool("call_2"), Step::Hang],
    };
    // killtool: the second tool run of the second turn, the third read of the session.
    let first = process(Rig::new(), codec(), script, workspace.path(), &tools, (phase == "killtool").then_some(3)).await;
    let reply = first.directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.path() }), "op-start")).await.expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().unwrap());
    let text = |n: usize| system[n]["text"].as_str().unwrap().to_owned();
    let set = json!({
        "provider": "anthropic-oauth", "model": MODEL, "responseLanguage": { "id": "ko", "name": "Korean" },
        "bp3EnvSplit": true, "sessionStartMetaInjected": true,
        "promptBase": text(1), "promptStable": text(2), "bp3CoreContext": text(3), "promptEnv": text(4),
    });
    // The cache policy the core gives a lead session on this route (`buildSessionProviderCacheOpts`).
    let mut lead = set.as_object().unwrap().clone();
    lead.insert("agent".into(), json!("lead"));
    let cache = crate::run_host::session_cache_opts::session_provider_cache_opts("anthropic-oauth", id.as_str(), Some("lead"), &lead, &json!({}));
    let mut set = set;
    set["providerCacheOpts"] = cache.unwrap_or(Value::Null);
    let handle = first.directory.handle(&id).unwrap();
    handle.request(CoreRequest { method: Method("thread/header/patch"), params: json!({ "threadId": id, "set": set, "unset": [] }), op: None, ctx: CallContext::internal("test") }).await.expect("the session's route and prompt");
    first.turn(&id, "first task", "op-1").await;
    first.settled(&id, 1).await;
    first.turn(&id, "second task", "op-2").await;
    let left = if phase == "idle" {
        first.settled(&id, 2).await;
        first.rig.store.records(&id).into_iter().map(|(_, record)| record).collect()
    } else {
        first.killed(&id).await
    };
    let sent = first.bodies();
    assert_eq!(sent.len(), before.len(), "{name}: requests before the restart");
    for (n, (core, node)) in sent.iter().zip(before).enumerate() {
        same(core, node, &format!("{name}: request {n} before the restart"));
    }

    let rig = Rig::new();
    rig.store.seed(&id, left);
    let second = process(rig, codec(), vec![Step::Text("resumed")], workspace.path(), &tools, None).await;
    second.directory.open_handle(&id, &CallContext::internal("test")).await.expect("the stored session opens");
    second.turn(&id, "third task", "op-3").await;
    second.settled(&id, 1).await;
    let sent = second.bodies();
    assert_eq!(sent.len(), after.len(), "{name}: requests after the restart");
    for (n, (core, node)) in sent.iter().zip(after).enumerate() {
        same(core, node, &format!("{name}: request {n} after the restart"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_while_idle_keeps_nodes_requests() {
    replay("restart-idle").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_inside_a_tool_run_keeps_nodes_requests() {
    replay("restart-killtool").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_with_a_request_on_the_wire_keeps_nodes_requests() {
    replay("restart-killrequest").await;
}
