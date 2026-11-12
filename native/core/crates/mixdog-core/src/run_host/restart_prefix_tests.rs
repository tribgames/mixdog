//! `fixtures/session-restart-prefix/recording.json` (`record-session-restart-prefix.mjs`): Node's
//! `restart-prefix-parity` scenario run by the core. A lead session on anthropic-oauth `claude-opus-5-5`
//! (Korean, so every request carries the turn-scoped language reminder) answers scripted steps; the
//! process stops while idle, inside a tool run or with a request on the wire, and a new process over the
//! same data directory resumes the session with a third task.
//!
//! A process runs over a real store (`StoreThreads` on a temp data directory) with the production Anthropic
//! adapter (`AnthropicAdapter::oauth` over `ReqwestLink`) pointed at a loopback HTTP server the test holds.
//! The first process is a child process (this test binary running `restart_prefix_first_process`), killed at
//! the recorded point: no shutdown path runs and only its files survive; the second process reopens the
//! directory, so what it resumes is what was on disk. The server keeps every request body as the bytes it received; each must equal Node's body
//! as Node's `JSON.stringify` writes it (the recorded object in its recorded key order), before and after
//! the restart. Node's `changes` and `comparisons` are a walk over those bodies, so equal bodies give equal
//! walks. The kill with a request on the wire lands when that request arrives, so the resumed process
//! holding the tool result the request carried shows the row was durable before the request left.
//!
//! Inputs, not outputs: the session's system texts (Node's composed prompt, with the recording machine's
//! environment block) are put in the header's prompt fields as recorded, and the tools are Node's
//! definitions, `read` calling the core's own read tool. The scripted answers are Anthropic event
//! streams the server sends.

use std::sync::atomic::AtomicUsize;

use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::AnthropicAdapter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

/// The loopback provider: every request body as received, answered from the script; a `Hang` step is the
/// recorded kill point with a request on the wire, so it is never answered.
struct Wire {
    bodies: Mutex<Vec<Vec<u8>>>,
    script: Mutex<VecDeque<Step>>,
    kill: tokio::sync::mpsc::UnboundedSender<&'static str>,
}

/// One HTTP/1.1 request off `stream`: its body, by its `Content-Length`; `None` once the peer closed.
async fn read_request(stream: &mut tokio::net::TcpStream, buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    let head = loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
        let mut chunk = [0u8; 8192];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let text = String::from_utf8_lossy(&buf[..head]).to_ascii_lowercase();
    assert!(!text.contains("transfer-encoding"), "a request body without a length:\n{text}");
    let length: usize = text
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .map(|value| value.trim().parse().expect("a numeric Content-Length"))
        .unwrap_or(0);
    while buf.len() < head + length {
        let mut chunk = [0u8; 65536];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = buf[head..head + length].to_vec();
    buf.drain(..head + length);
    Some(body)
}

async fn serve(listener: tokio::net::TcpListener, wire: Arc<Wire>) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { return };
        let wire = wire.clone();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            while let Some(body) = read_request(&mut stream, &mut buf).await {
                lock(&wire.bodies).push(body);
                let step = lock(&wire.script).pop_front().expect("an unscripted send");
                if let Step::Hang = step {
                    let _ = wire.kill.send("a request on the wire");
                    std::future::pending::<()>().await;
                }
                let sse = sse(&step);
                let head = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n", sse.len());
                if stream.write_all(head.as_bytes()).await.is_err() || stream.write_all(&sse).await.is_err() {
                    return;
                }
            }
        });
    }
}

/// Node's tool definition; `read` runs the core's read tool, and the run that reaches `hang_at` reads is the
/// recorded kill point inside a tool run.
struct NodeTool {
    spec: ToolSpec,
    read: Option<Arc<mixdog_tools::fs::ReadTool>>,
    reads: Arc<AtomicUsize>,
    hang_at: Option<usize>,
    /// The recorded `killrequestcancelled` scenario: the read of `call_2.txt` really returns the text `Cancelled`.
    cancelled: bool,
    kill: tokio::sync::mpsc::UnboundedSender<&'static str>,
}

#[async_trait]
impl Tool for NodeTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    /// The turn path requires a delegated agent's `git`/`task` definition (`check_pool`); the recording has only the
    /// Lead's, and no delegated agent runs here.
    fn agent_spec(&self) -> Option<&ToolSpec> {
        matches!(self.spec.name.as_str(), "git" | "task").then_some(&self.spec)
    }
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let read = self.read.as_ref().expect("only read is called");
        let n = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if self.hang_at == Some(n) {
            let _ = self.kill.send("a tool run");
            std::future::pending::<()>().await;
        }
        if self.cancelled && args["path"] == "call_2.txt" {
            return Ok(mixdog_core_api::domain::tool::ToolOutput { parts: vec![mixdog_core_api::domain::tool::ToolPart::Text("Cancelled".to_owned())], ..Default::default() });
        }
        read.call(ctx, args).await
    }
}

struct Session {
    provider: Arc<dyn ProviderAdapter>,
    workspace: std::path::PathBuf,
    tools: Value,
    reads: Arc<AtomicUsize>,
    hang_at: Option<usize>,
    cancelled: bool,
    kill: tokio::sync::mpsc::UnboundedSender<&'static str>,
}

#[async_trait]
impl RunParts for Session {
    async fn reconcile_turn(&self, _: &ThreadId, header: mixdog_store::schema::record::Header, _: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
        Ok(header)
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let tools = node_tools(&self.tools, &self.reads, self.hang_at, self.cancelled, &self.kill);
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

/// Node's tool definitions as tools, `read` calling the core's read tool.
fn node_tools(tools: &Value, reads: &Arc<AtomicUsize>, hang_at: Option<usize>, cancelled: bool, kill: &tokio::sync::mpsc::UnboundedSender<&'static str>) -> Vec<Arc<dyn Tool>> {
    let read = Arc::new(mixdog_tools::fs::ReadTool::new(None, None));
    tools
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
            Arc::new(NodeTool { spec, read: (name == "read").then(|| read.clone()), reads: reads.clone(), hang_at, cancelled, kill: kill.clone() }) as Arc<dyn Tool>
        })
        .collect()
}

/// What a process of the fixture is started with.
#[derive(Clone)]
struct Boot {
    data: std::path::PathBuf,
    credentials: std::path::PathBuf,
    url: String,
    config: AnthropicConfig,
    workspace: std::path::PathBuf,
    tools: Value,
    hang_at: Option<usize>,
    cancelled: bool,
    kill: tokio::sync::mpsc::UnboundedSender<&'static str>,
}

/// A process of the fixture: a directory over the data directory's real store, sending through the production adapter.
struct Process {
    rig: Rig,
    directory: SessionDirectory,
}

/// The data directory's real thread store and the production Anthropic adapter sending to the test's server.
async fn opened(boot: &Boot) -> (mixdog_core_session::session::StoreThreads, Arc<dyn ProviderAdapter>) {
    let tokens = mixdog_rt::testing::tokens();
    let root = boot.data.clone();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("the maintenance lane takes the index open")
    .await
    .expect("the index open ran")
    .expect("the index opens");
    let threads = mixdog_core_session::session::StoreThreads::over_data_dir(&boot.data, index, Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()), tokens.maintenance_io)
        .await
        .expect("the thread store opens");
    let http: Arc<dyn mixdog_ai::transport::HttpSend> = Arc::new(mixdog_ai::transport::ReqwestLink::new(&mixdog_ai::transport::KeepaliveSchedule::SPEC, false).expect("the HTTP link"));
    let file = mixdog_ai::oauth::CredentialFile::new(boot.credentials.clone(), mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let mut config = boot.config.clone();
    config.base_url = boot.url.clone();
    let session = Arc::new(mixdog_ai::providers::anthropic::OAuthSession::new(file, http.clone()));
    let provider: Arc<dyn ProviderAdapter> = Arc::new(AnthropicAdapter::oauth(config, http, session, false, tokens.cpu_bulk));
    (threads, provider)
}

/// Run inside the process's own runtime: the store, its index and every task the session starts belong to it.
async fn process(boot: Boot) -> Process {
    process_over(boot, None).await
}

/// [`process`] whose store calls `hook` around every commit: a hook that never returns holds the write there.
async fn process_over(boot: Boot, hook: Option<mixdog_core_session::session::testing::CommitHook>) -> Process {
    let (threads, provider) = opened(&boot).await;
    let threads: Arc<dyn mixdog_core_session::session::ThreadStore> = match hook {
        Some(hook) => mixdog_core_session::session::testing::CallCounted::with_commit_hook(Arc::new(threads), hook),
        None => Arc::new(threads),
    };
    let rig = Rig::new();
    // Node's recording runs under one frozen clock (`Date.now()` is 1700000000000 throughout): the session's clock reads what the run
    // host's `Fixed` clock does, so a turn's elapsed time is `now - at` on one clock, as Node measures it.
    rig.clock.0.store(1_700_000_000_000, std::sync::atomic::Ordering::SeqCst);
    let mut deps = rig.deps_parts(threads);
    // The production display of stored rows: what a client reads is compared with Node's read below.
    deps.transcript = Arc::new(mixdog_core_session::session::transcript::RecordTranscript::new());
    let session = Session { provider, workspace: boot.workspace.clone(), tools: boot.tools.clone(), reads: Arc::default(), hang_at: boot.hang_at, cancelled: boot.cancelled, kill: boot.kill.clone() };
    deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(session)));
    let directory = SessionDirectory::new(Arc::new(deps));
    Process { rig, directory }
}

struct NoProbe;

#[async_trait]
impl mixdog_ai::accounts::rotation::UsageProbe for NoProbe {
    async fn measure(&self, _: &str, _: &str, _: bool) {}
}

struct Switched;

impl mixdog_ai::warmer::gate::ProviderSwitch for Switched {
    fn available(&self, _: &str) -> bool {
        true
    }
}

impl mixdog_ai::warmer::gate::QuotaResumes for Switched {
    fn paused(&self, _: &str) -> bool {
        false
    }
}

#[async_trait]
impl mixdog_ai::warmer::gate::UsageSnapshots for Switched {
    /// A reading taken now with room: Node's recorded warm is the rebuilt body (`cache-warm.mjs:356`), sent past its
    /// gate, so the replay's account has room.
    async fn cached(&self, _: &str) -> Option<(Vec<mixdog_ai::accounts::Window>, i64)> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        Some((vec![mixdog_ai::accounts::Window { label: "5h".to_owned(), used_pct: Some(10.0), ..Default::default() }], now))
    }
}

/// Node's `rearmCacheWarmsAfterRestart` in a restarted process (`cache-warm.mjs:771`): the warm of the session's last sent
/// request, rebuilt from the stored session (`lastSentMainRequest`, `side-question.mjs:108`, whose system prompt is the
/// one the session stored) and sent once. Here through the production pieces: the turn path's assembly
/// (`HostRunParts::next_request` behind `NextRequestSource::last_sent`, over the reopened store with Node's tools as its
/// tool pool), `SessionsWarm::last_sent_request` and `ProvidersWarm::send` to the production adapter, whose body the
/// test's server keeps. Opened and dropped before the process that runs the next task opens the directory. `false` when
/// the session has no request to warm (`lastSentMainRequest` null: Node then sends none).
async fn warm_after_restart(boot: &Boot, id: &ThreadId) -> bool {
    use mixdog_ai::warmer::process::WarmProviders;
    use mixdog_ai::warmer::process::WarmSessions;
    let tokens = mixdog_rt::testing::tokens();
    let (threads, provider) = opened(boot).await;
    // The turn path's `Skill` tool, which the session's list leaves out when no skill is visible (`NoSkills`), as Node's
    // recorded tool list does.
    let mut pool = node_tools(&boot.tools, &Arc::default(), None, boot.cancelled, &boot.kill);
    pool.push(super::named("Skill"));
    let world = super::turn_world_over(provider, Some(Arc::new(threads)), Some(pool)).await;
    world.directory.open_handle(id, &CallContext::internal("test")).await.expect("the stored session opens");
    let catalog = crate::run_host::process_tests::world(&[], json!({}), Vec::new()).await;
    let caps = crate::run_host::builder_env::CatalogCaps::new(catalog.services.catalog.clone(), &*catalog.services.env);
    let tail: Arc<dyn crate::run_host::warm_ports::WarmTail> = world.next.clone();
    let sessions = crate::run_host::warm_ports::SessionsWarm::new(world.next.clone(), world.path.registry.clone(), caps, tail);
    let Some(request) = sessions.last_sent_request(id.as_str()).await.expect("the session reads") else { return false };
    let dir = tempfile::tempdir().unwrap();
    let store = mixdog_ai::accounts::AccountStore::new(dir.path().to_path_buf(), mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let rotation = Arc::new(mixdog_ai::accounts::rotation::AccountRotation::new(store.clone(), Arc::new(NoProbe), Arc::new(mixdog_ai::oauth::SystemPace)));
    let gate = mixdog_ai::warmer::gate::AccountGate::new(
        Arc::new(mixdog_ai::admission::Admission::new()),
        Arc::new(|_: &mixdog_ai::admission::LaneKey| mixdog_ai::admission::LaneSettings::default()),
        store,
        rotation,
        Arc::new(Switched),
        Arc::new(Switched),
        Arc::new(Switched),
    );
    let providers = crate::run_host::warm_ports::ProvidersWarm::new(world.path.registry.clone(), catalog.services.catalog.clone(), Arc::new(gate), mixdog_core_api::domain::cache_warm::Deadlines::DEFAULT, Arc::new(|_: &str| {}));
    let target = mixdog_ai::warmer::chain::WarmTarget { account_id: String::new() };
    providers.send(&*request, &target, &mixdog_rt::CancellationToken::new(), &mut |_| {}).await.expect("the warm is sent");
    true
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
}

/// The paths where `core` and `node` differ, each with both values (cut).
fn differences(core: &Value, node: &Value, at: &str, out: &mut Vec<String>) {
    match (core, node) {
        (Value::Object(a), Value::Object(b)) => {
            if !a.keys().eq(b.keys()) {
                out.push(format!("{at}: core keys {:?} | node keys {:?}", a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>()));
            }
            for key in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => differences(x, y, &format!("{at}.{key}"), out),
                    (x, y) => out.push(format!("{at}.{key}: core {x:?} | node {y:?}")),
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!("{at}: core {} entries | node {}", a.len(), b.len()));
            }
            for (n, (x, y)) in a.iter().zip(b).enumerate() {
                differences(x, y, &format!("{at}[{n}]"), out);
            }
        }
        _ if core != node => {
            let cut = |v: &Value| v.to_string().chars().take(400).collect::<String>();
            out.push(format!("{at}: core {} | node {}", cut(core), cut(node)));
        }
        _ => {}
    }
}

/// The body the core sent equals Node's byte for byte: Node sends `JSON.stringify(body)`, which is the recorded
/// object written in its recorded key order.
fn same(core: &[u8], node: &Value, what: &str) {
    let expected = serde_json::to_vec(node).expect("Node's body serializes");
    if core == expected.as_slice() {
        return;
    }
    let mut out = Vec::new();
    match serde_json::from_slice::<Value>(core) {
        Ok(parsed) => differences(&parsed, node, "$", &mut out),
        Err(error) => out.push(format!("the body is not JSON: {error}")),
    }
    let at = core.iter().zip(&expected).position(|(a, b)| a != b).unwrap_or(core.len().min(expected.len()));
    let around = |bytes: &[u8]| String::from_utf8_lossy(&bytes[at.saturating_sub(80)..(at + 80).min(bytes.len())]).into_owned();
    panic!("{what}: the bytes differ at {at} (core {} bytes, node {})\ncore …{}…\nnode …{}…\n{}", core.len(), expected.len(), around(core), around(&expected), out.join("\n"));
}

/// The conversation of a `thread/read` answer, in order: each user message's text, each agent message's text and each
/// tool call's name and input. Left out, each with where the same case compares it: the reasoning, tool output and turn
/// end items, which hold the thinking blocks and tool results of the stored rows; the first request after the restart is
/// built from those same reopened rows and is compared to Node's byte for byte (`replay`, "request {n} after the restart").
fn read_conversation(read: &Value) -> Vec<(String, String)> {
    read["items"]
        .as_array()
        .expect("the read's items")
        .iter()
        .filter_map(|item| match item["type"].as_str()? {
            "userMessage" => Some(("user".to_owned(), item["content"].as_array()?.iter().filter_map(|part| part["text"].as_str()).collect::<String>())),
            "agentMessage" => Some(("assistant".to_owned(), item["text"].as_str()?.to_owned())),
            "toolCall" => Some(("call".to_owned(), format!("{} {}", item["name"].as_str()?, item["input"]))),
            _ => None,
        })
        .collect()
}

/// The rows a client holds for a `thread/read` answer: the product's own fold (`packages/protocol-client/src/rows.ts`, run by
/// node over the answer's items by `benchmarks/rust-core/recorders/fold-thread-read.mjs`), which derives the rows' counters and
/// error flags from the items as Node's restore does (`attachRestoredToolResult`).
async fn client_rows(read: &Value) -> Vec<Value> {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let mut command = tokio::process::Command::new("node");
    command
        .current_dir(&root)
        .args(["--import", "./apps/desktop/scripts/test-env.mjs", "--import", "./apps/desktop/scripts/test-tsx.mjs"])
        .arg("benchmarks/rust-core/recorders/fold-thread-read.mjs")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().expect("node runs");
    let mut stdin = child.stdin.take().expect("stdin");
    stdin.write_all(read.to_string().as_bytes()).await.expect("the script reads");
    drop(stdin);
    let mut out = String::new();
    child.stdout.take().expect("stdout").read_to_string(&mut out).await.expect("the script's rows");
    assert!(child.wait().await.expect("the script ends").success(), "the fold script failed");
    serde_json::from_str(out.trim()).expect("the folded rows")
}

/// Rows as compared with Node's recorded read, each exclusion declared in the manifest: the ids (generated: Node's are
/// `hist_<session>_<ordinal>_<n>`, the core's are its own; a turn end's `finalAssistantId` is compared as the position of the row it
/// names), the turn ids, and what only the core's rows carry or read differently:
/// - `verb`: the recorded Node scenario drives the session manager without a client, so no `completionVerb` reaches it and its stored
///   completion says `Thought` (`ask-turn-settle.mjs:34`); the core's thread picks `pickDoneVerb(stats.turns)` for every turn, as Node's
///   session service does for a client's turn (`actor.rs` `begin_turn`);
/// - the row keys the recording does not keep (`at`, `messageId`, `modelId`, `device`, `checkpointId` and the like): the recording holds
///   only the keys of [`PROBE_KEYS`] for a row, and each of those is compared.
fn comparable(rows: &[Value]) -> Vec<Value> {
    let position = |id: &Value| rows.iter().position(|row| row["id"] == *id);
    rows.iter()
        .map(|row| {
            let mut row = row.clone();
            let fields = row.as_object_mut().expect("a row");
            let final_assistant = fields.get("finalAssistantId").map(|id| position(id).map_or(Value::Null, |n| json!(n)));
            fields.remove("id");
            fields.remove("verb");
            fields.retain(|key, _| PROBE_KEYS.contains(&key.as_str()));
            if let Some(position) = final_assistant {
                fields.insert("finalAssistant".into(), position);
            }
            row
        })
        .collect()
}

/// The row keys Node's cold read prints for the rows of these scenarios.
const PROBE_KEYS: [&str; 15] = [
    "kind", "text", "name", "args", "expanded", "count", "completedCount", "callId", "result", "isError", "errorCount", "callErrorCount", "exitErrorCount", "status",
    "elapsedMs",
];
/// The conversation Node's first request after the restart carries before the new task: each user message's text blocks,
/// each assistant message's text and each of its tool calls' name and input, in order. Not tool results, thinking blocks or
/// the turn reminders Node sends as system messages: that request is compared whole in the same case (`replay`). The new
/// task rides the request's last user message, after the restart notice (its own text block, or folded into a cancelled
/// tool result's content), so that message is not part of what was resumed.
fn node_conversation(body: &Value) -> Vec<(String, String)> {
    let messages = body["messages"].as_array().unwrap();
    let last = messages.iter().rposition(|message| message["role"] == "user").expect("Node's request has a user message");
    let tail = messages[last]["content"].as_array().and_then(|parts| parts.last()).expect("the last user message's parts");
    let tail = tail["text"].as_str().or_else(|| tail["content"].as_str()).unwrap_or_default();
    assert!(tail.ends_with("third task"), "Node's request ends with the new task: {tail:?}");
    let mut conversation = Vec::new();
    for message in &messages[..last] {
        let role = message["role"].as_str().unwrap();
        let Some(parts) = message["content"].as_array() else { continue };
        if role != "user" && role != "assistant" {
            continue;
        }
        let text: String = parts.iter().filter(|part| part["type"] == "text").filter_map(|part| part["text"].as_str()).collect();
        if !text.is_empty() {
            conversation.push((role.to_owned(), text));
        }
        for call in parts.iter().filter(|part| part["type"] == "tool_use") {
            conversation.push(("call".to_owned(), format!("{} {}", call["name"].as_str().unwrap(), call["input"])));
        }
    }
    conversation
}

/// What both processes of a case are started with, rebuilt by each from the recording and the case's paths.
struct Case {
    phase: String,
    before: Vec<Value>,
    after: Vec<Value>,
    warm: Value,
    set: Value,
    tools: Value,
    /// Node's cold read of the stored session once the scenario had ended.
    read: Value,
}

fn case(name: &str) -> Case {
    let recorded = recording();
    let case = recorded["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).unwrap().clone();
    let result = &case["result"];
    let before = result["before"]["bodies"].as_array().unwrap().clone();
    let after = result["after"]["bodies"].as_array().unwrap().clone();
    let system = before[0]["system"].as_array().unwrap().clone();
    let text = |n: usize| system[n]["text"].as_str().unwrap().to_owned();
    let set = json!({
        "provider": "anthropic-oauth", "model": MODEL, "responseLanguage": { "id": "ko", "name": "Korean" },
        "bp3EnvSplit": true, "sessionStartMetaInjected": true,
        "promptBase": text(1), "promptStable": text(2), "bp3CoreContext": text(3), "promptEnv": text(4),
    });
    let warm = result["after"]["warmBody"].clone();
    Case { phase: case["input"]["phases"][0].as_str().unwrap().to_owned(), tools: before[0]["tools"].clone(), before, after, warm, set, read: result["read"].clone() }
}

async fn boot(dir: &std::path::Path, url: String, case: &Case, hang_at: Option<usize>, kill: tokio::sync::mpsc::UnboundedSender<&'static str>) -> Boot {
    let w = crate::run_host::process_tests::world(&[], json!({}), Vec::new()).await;
    let caps = crate::run_host::builder_env::CatalogCaps::new(w.services.catalog.clone(), &*w.services.env).lookup();
    let mut config = AnthropicConfig::new(caps);
    // Node's recorded body is the one its request builder makes (`_buildRequestBodyForCacheSmoke`): unthreaded.
    config.message_threads = false;
    Boot {
        data: dir.join("data"),
        credentials: dir.join("data").join("anthropic-oauth-credentials.json"),
        url,
        config,
        workspace: dir.join("workspace"),
        tools: case.tools.clone(),
        hang_at,
        cancelled: case.phase == "killrequestcancelled",
        kill,
    }
}

const CHILD: &str = "MIXDOG_RESTART_PREFIX_CHILD";

/// The first process of a case, run as a child of the test by [`replay`] (`MIXDOG_RESTART_PREFIX_CHILD` holds
/// `<case>|<dir>|<url>`): it starts the session, runs the first two tasks and reports on its stdout, then waits to
/// be killed. Without the variable it is not a child and does nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_prefix_first_process() {
    let Ok(spec) = std::env::var(CHILD) else { return };
    let mut parts = spec.splitn(3, '|');
    let (name, dir, url) = (parts.next().unwrap(), std::path::PathBuf::from(parts.next().unwrap()), parts.next().unwrap().to_owned());
    let case = case(name);
    let (kill, mut killed) = tokio::sync::mpsc::unbounded_channel();
    // killtool: the second tool run of the second turn, the third read of the session.
    let boot = boot(&dir, url, &case, (case.phase == "killtool").then_some(3), kill).await;
    let first = process(boot.clone()).await;
    let reply = first.directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": boot.workspace }), "op-start")).await.expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().unwrap());
    // The cache policy the core gives a lead session on this route (`buildSessionProviderCacheOpts`).
    let mut lead = case.set.as_object().unwrap().clone();
    lead.insert("agent".into(), json!("lead"));
    let cache = crate::run_host::session_cache_opts::session_provider_cache_opts("anthropic-oauth", id.as_str(), Some("lead"), &lead, &json!({}));
    let mut set = case.set.clone();
    set["providerCacheOpts"] = cache.unwrap_or(Value::Null);
    // Node's `session.tools`, the session's active tools a rebuilt request lists (`side-question.mjs:83`): the surface's
    // `tools` (`SessionSurface::from_header`), as Node's session holds them.
    set["tools"] = case.tools.clone();
    let handle = first.directory.handle(&id).unwrap();
    handle.request(CoreRequest { method: Method("thread/header/patch"), params: json!({ "threadId": id, "set": set, "unset": [] }), op: None, ctx: CallContext::internal("test") }).await.expect("the session's route and prompt");
    println!("RP:SESSION {}", id.as_str());
    first.turn(&id, "first task", "op-1").await;
    first.settled(&id, 1).await;
    first.turn(&id, "second task", "op-2").await;
    match case.phase.as_str() {
        "idle" => {
            first.settled(&id, 2).await;
            println!("RP:KILL idle");
        }
        "killtool" => {
            let at = mixdog_core_session::session::testing::awaiting(|| "the third read to start".to_owned(), killed.recv()).await.expect("the tool run's signal");
            // Node is stopped once its journal holds the assistant message calling call_3 (the recorder's patch,
            // `node-fix-restart-prefix-settle.patch`): the core is stopped once the row is released, which is after its
            // barrier is on disk. The read itself starts while the response streams, ahead of that row.
            let handle = first.directory.handle(&id).expect("loaded");
            let stored = || first.rig.feeds.frames(id.as_str()).into_iter().any(|(_, method, params)| method == "item/completed" && params.to_string().contains("\"call_3\""));
            eventually_on_awaiting(|| "the row calling call_3 on disk".to_owned(), &[handle.stepped(), &*first.rig.feeds.published], || stored().then_some(())).await;
            println!("RP:KILL {at}");
        }
        _ => {}
    }
    // The process stays up until it is killed.
    std::future::pending::<()>().await;
}

const RECOVER: &str = "MIXDOG_RESTART_PREFIX_RECOVER";

/// The process that recovers the killed session and is itself killed (`MIXDOG_RESTART_PREFIX_RECOVER` holds
/// `<case>|<dir>|<url>|<point>`): it opens the stored session with a hook that holds at the `point`-th write of the
/// recovery, reporting `HELD` there, or `DONE` once the recovery was saved with no write left to hold. Without the variable
/// it does nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_prefix_recovery_process() {
    use std::io::Write;
    let Ok(spec) = std::env::var(RECOVER) else { return };
    let mut parts = spec.splitn(4, '|');
    let (name, dir, url) = (parts.next().unwrap(), std::path::PathBuf::from(parts.next().unwrap()), parts.next().unwrap().to_owned());
    let point: usize = parts.next().unwrap().parse().expect("a write point");
    let case = case(name);
    let (kill, _killed) = tokio::sync::mpsc::unbounded_channel();
    let boot = boot(&dir, url, &case, None, kill).await;
    let session = std::fs::read_to_string(dir.join("session-id")).expect("the session's id");
    let seen = Arc::new(AtomicUsize::new(0));
    let hook: mixdog_core_session::session::testing::CommitHook = Arc::new(move |_| {
        let at = seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if at == point {
            println!("RP:HELD {at}");
            let _ = std::io::stdout().flush();
            loop {
                std::thread::park();
            }
        }
    });
    let recovering = process_over(boot, Some(hook)).await;
    recovering.directory.open_handle(&ThreadId::from(session.as_str()), &CallContext::internal("test")).await.expect("the stored session opens");
    println!("RP:DONE");
    let _ = std::io::stdout().flush();
    std::future::pending::<()>().await;
}

/// The child's report lines, read on a thread of their own.
fn reports(stdout: std::process::ChildStdout) -> tokio::sync::mpsc::UnboundedReceiver<String> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            // The test harness may print the test's name on the same line, before the report.
            if let Some((_, report)) = line.split_once("RP:") {
                let _ = tx.send(report.to_owned());
            }
        }
    });
    rx
}

/// The first process, killed when the test ends whichever way it ends.
struct Killed(std::process::Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Kills the process that recovers the session at its `point`-th write (the second kill of the case): `true` when it was
/// held there and killed, `false` when the recovery ended before reaching it.
async fn kill_recovery_at(name: &str, dir: &std::path::Path, url: &str, point: usize) -> bool {
    use mixdog_core_session::session::testing::awaiting;
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["run_host::factory::tests::restart_prefix::restart_prefix_recovery_process", "--exact", "--nocapture", "--test-threads=1"])
        .env(RECOVER, format!("{name}|{}|{url}|{point}", dir.display()))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .expect("the recovering process starts");
    let mut child_reports = reports(child.stdout.take().unwrap());
    let child = Killed(child);
    let report = awaiting(|| format!("{name}: the recovering process's report at write {point}"), child_reports.recv()).await;
    let report = report.unwrap_or_else(|| panic!("{name}: the recovering process ended without a report at write {point}"));
    drop(child);
    match report.as_str() {
        "DONE" => false,
        held if held.starts_with("HELD ") => true,
        other => panic!("{name}: the recovering process reported {other:?}"),
    }
}

async fn replay(name: &str) {
    replay_after(name, None).await;
}

/// [`replay`] with the process killed once more during the recovery of the first kill, at the write `recovery_kill` names.
/// Returns whether that second kill happened (the recovery had a write to cut there).
async fn replay_after(name: &str, recovery_kill: Option<usize>) -> bool {
    use mixdog_core_session::session::testing::awaiting;
    let case = case(name);
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    for name in ["call_1", "call_2", "call_3"] {
        std::fs::write(workspace.join(format!("{name}.txt")), format!("{name}\n")).unwrap();
    }
    let stored = json!({ "claudeAiOauth": { "accessToken": "test-access-token", "refreshToken": "test-refresh-token", "expiresAt": 4_000_000_000_000u64, "scopes": ["user:inference", "user:profile"], "subscriptionType": "max" } });
    std::fs::write(dir.path().join("data").join("anthropic-oauth-credentials.json"), serde_json::to_vec(&stored).unwrap()).unwrap();

    let script = match case.phase.as_str() {
        "idle" => vec![Step::Tool("call_1"), Step::Text("done one"), Step::Tool("call_2"), Step::Text("done two")],
        "killtool" => vec![Step::Tool("call_1"), Step::Text("done one"), Step::Tool("call_2"), Step::Tool("call_3")],
        _ => vec![Step::Tool("call_1"), Step::Text("done one"), Step::Tool("call_2"), Step::Hang],
    };
    let (kill, mut killed) = tokio::sync::mpsc::unbounded_channel();
    let mut script: VecDeque<Step> = script.into();
    script.push_back(Step::Text("warm"));
    script.push_back(Step::Text("resumed"));
    let wire = Arc::new(Wire { bodies: Mutex::new(Vec::new()), script: Mutex::new(script), kill: kill.clone() });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(serve(listener, wire.clone()));

    // The first process is a child of this one, killed at the recorded point: nothing of it survives but its files.
    let errors = dir.path().join("first-process.stderr");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["run_host::factory::tests::restart_prefix::restart_prefix_first_process", "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD, format!("{name}|{}|{url}", dir.path().display()))
        .stdout(std::process::Stdio::piped())
        .stderr(std::fs::File::create(&errors).expect("the first process's error file"))
        .spawn()
        .expect("the first process starts");
    let mut child_reports = reports(child.stdout.take().unwrap());
    let mut child = Killed(child);
    let said = || std::fs::read_to_string(&errors).unwrap_or_default();
    let session = awaiting(|| format!("{name}: the first process started the session; it wrote:\n{}", said()), child_reports.recv()).await;
    let session = session.unwrap_or_else(|| panic!("{name}: the first process ended without its session; it wrote:\n{}", said()));
    let id = ThreadId::from(session.strip_prefix("SESSION ").unwrap_or_else(|| panic!("{name}: the first report was {session:?}, not the session; it wrote:\n{}", said())));
    let at = awaiting(|| format!("{name}: the kill point (requests seen {})", lock(&wire.bodies).len()), async {
        tokio::select! {
            at = killed.recv() => at.map(str::to_owned),
            report = child_reports.recv() => report.and_then(|r| r.strip_prefix("KILL ").map(str::to_owned)),
        }
    })
    .await
    .expect("a kill point");
    let expected = match case.phase.as_str() {
        "idle" => "idle",
        "killtool" => "a tool run",
        _ => "a request on the wire",
    };
    assert_eq!(at, expected, "{name}: the kill point");
    child.0.kill().expect("the first process is killed");
    child.0.wait().expect("the first process ended");
    // Shown only when the test fails.
    eprintln!("{name}: the first process wrote:\n{}", said());
    let sent = lock(&wire.bodies).clone();
    assert_eq!(sent.len(), case.before.len(), "{name}: requests before the restart");
    for (n, (core, node)) in sent.iter().zip(&case.before).enumerate() {
        same(core, node, &format!("{name}: request {n} before the restart"));
    }

    // The second kill: a process recovering the stored session is itself killed at one of the recovery's writes. The stored
    // transcript is then the one the first kill left, each row once, so everything below is Node's after one kill.
    let second_kill = match recovery_kill {
        Some(point) => {
            std::fs::write(dir.path().join("session-id"), id.as_str()).expect("the session id for the recovering process");
            kill_recovery_at(name, dir.path(), &url, point).await
        }
        None => false,
    };
    // The restarted process re-arms the session's warm (`rearmCacheWarmsAfterRestart`): the body the provider receives is
    // Node's `warmBody`.
    // Node's `warmBody` is null after a restart inside a turn: its rebuilt request does not end in the reply it produced.
    let second = boot(dir.path(), url, &case, None, kill).await;
    let warmed = warm_after_restart(&second, &id).await;
    assert_eq!(warmed, !case.warm.is_null(), "{name}: a warm after the restart");
    let warms = usize::from(warmed);
    let sent = lock(&wire.bodies).clone();
    assert_eq!(sent.len(), case.before.len() + warms, "{name}: the warm request");
    if warmed {
        same(&sent[case.before.len()], &case.warm, &format!("{name}: the warm after the restart"));
    } else {
        // The script's warm answer is never asked for.
        assert!(matches!(lock(&wire.script).pop_front(), Some(Step::Text("warm"))));
    }

    // The second process opens the same data directory. What a client reads of the session then is what Node resumed
    // from (`turn-checkpoint-recovery.mjs`): the conversation its next request carries, before the new task.
    let resumed = process(second).await;
    resumed.directory.open_handle(&id, &CallContext::internal("test")).await.expect("the stored session opens");
    let handle = resumed.directory.handle(&id).expect("loaded");
    let read = handle.request(request("thread/read", json!({ "threadId": id }), "op-read")).await.expect("thread/read");
    let Reply::Value(read) = read else { panic!("thread/read answers a value") };
    assert_eq!(read_conversation(&read), node_conversation(&case.after[0]), "{name}: the session a client reads after the restart");
    resumed.turn(&id, "third task", "op-3").await;
    resumed.settled(&id, 1).await;
    // What a client reads when the scenario is over: Node's cold read of the stored session (`result.read`, the recording's
    // `restart-read-probe.mjs`) on the same conversation.
    let read = handle.request(request("thread/read", json!({ "threadId": id }), "op-read-end")).await.expect("thread/read");
    let Reply::Value(read) = read else { panic!("thread/read answers a value") };
    let (core_rows, node_rows) = (Value::Array(comparable(&client_rows(&read).await)), Value::Array(comparable(case.read["items"].as_array().expect("Node's read items"))));
    let mut out = Vec::new();
    if core_rows != node_rows {
        differences(&core_rows, &node_rows, "$", &mut out);
    }
    assert!(out.is_empty(), "{name}: the session a client reads when the scenario is over differs from Node's:\n{}", out.join("\n"));
    let sent = lock(&wire.bodies).clone();
    let sent = &sent[case.before.len() + warms..];
    assert_eq!(sent.len(), case.after.len(), "{name}: requests after the restart");
    for (n, (core, node)) in sent.iter().zip(&case.after).enumerate() {
        same(core, node, &format!("{name}: request {n} after the restart"));
    }
    second_kill
}

/// The core is killed in the case's first phase, and killed again at each point of the recovery in turn: the request the provider
/// then receives for the next task is the case's recorded one, whole. The points are the commit boundaries and the prefixes of
/// each commit's records (`CommitPoint`; `recovery_kill_tests.rs` says why those are every state a kill can leave): a recovery is
/// cut after any number of its records, and the next open derives it again from what was stored.
async fn killed_at_every_point_of_the_recovery(name: &str) {
    let mut killed = 0;
    for point in 0..64 {
        // Shown only when the test fails.
        eprintln!("the second kill at point {point} of the recovery");
        if !replay_after(name, Some(point)).await {
            assert!(killed >= 2, "the recovery wrote nothing to cut: {killed}");
            return;
        }
        killed += 1;
    }
    panic!("the recovery never ended within 64 points");
}

/// After one kill in a tool run (`restart-killtool`): Node's request after one kill.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_kill_during_the_recovery_keeps_nodes_requests() {
    killed_at_every_point_of_the_recovery("restart-killtool").await;
}

/// A tool that really returned `Cancelled`, then the kill with the next request on the wire (Node recovers from its checkpoint,
/// so the real result keeps its `sentRequestTail`): the next task's request is Node's, whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_cancelled_result_before_a_kill_keeps_nodes_requests() {
    replay("restart-killrequest-cancelled").await;
}

/// The same, killed again at every point of the recovery: Node's recording of the second kill (`recoverkill`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_kill_after_a_real_cancelled_result_keeps_nodes_requests() {
    killed_at_every_point_of_the_recovery("restart-killrequest-cancelled-recoverkill").await;
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
