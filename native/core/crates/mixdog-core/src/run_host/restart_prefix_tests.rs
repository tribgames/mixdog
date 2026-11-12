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
    kill: tokio::sync::mpsc::UnboundedSender<&'static str>,
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
            let _ = self.kill.send("a tool run");
            std::future::pending::<()>().await;
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
    kill: tokio::sync::mpsc::UnboundedSender<&'static str>,
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
                Arc::new(NodeTool { spec, read: (name == "read").then(|| read.clone()), reads: self.reads.clone(), hang_at: self.hang_at, kill: self.kill.clone() }) as Arc<dyn Tool>
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
    kill: tokio::sync::mpsc::UnboundedSender<&'static str>,
}

/// A process of the fixture: a directory over the data directory's real store, sending through the production adapter.
struct Process {
    rig: Rig,
    directory: SessionDirectory,
}

/// Run inside the process's own runtime: the store, its index and every task the session starts belong to it.
async fn process(boot: Boot) -> Process {
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
    let rig = Rig::new();
    let mut deps = rig.deps_parts(Arc::new(threads));
    let session = Session { provider, workspace: boot.workspace.clone(), tools: boot.tools.clone(), reads: Arc::default(), hang_at: boot.hang_at, kill: boot.kill.clone() };
    deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(session)));
    let directory = SessionDirectory::new(Arc::new(deps));
    Process { rig, directory }
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

/// What both processes of a case are started with, rebuilt by each from the recording and the case's paths.
struct Case {
    phase: String,
    before: Vec<Value>,
    after: Vec<Value>,
    set: Value,
    tools: Value,
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
    Case { phase: case["input"]["phases"][0].as_str().unwrap().to_owned(), tools: before[0]["tools"].clone(), before, after, set }
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

async fn replay(name: &str) {
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
    let sent = lock(&wire.bodies).clone();
    assert_eq!(sent.len(), case.before.len(), "{name}: requests before the restart");
    for (n, (core, node)) in sent.iter().zip(&case.before).enumerate() {
        same(core, node, &format!("{name}: request {n} before the restart"));
    }

    // The second process opens the same data directory.
    let resumed = process(boot(dir.path(), url, &case, None, kill).await).await;
    resumed.directory.open_handle(&id, &CallContext::internal("test")).await.expect("the stored session opens");
    resumed.turn(&id, "third task", "op-3").await;
    resumed.settled(&id, 1).await;
    let sent = lock(&wire.bodies).clone();
    let sent = &sent[case.before.len()..];
    assert_eq!(sent.len(), case.after.len(), "{name}: requests after the restart");
    for (n, (core, node)) in sent.iter().zip(&case.after).enumerate() {
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
