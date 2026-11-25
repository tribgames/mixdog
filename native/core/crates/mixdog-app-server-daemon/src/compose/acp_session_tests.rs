//! A session on an ACP agent's route in the composed core: the real session directory, tool builder and prompt composition,
//! with a fake agent as the one preset. The fake agent's process is this test binary, started on [`the_fake_agents_process`].
#![allow(clippy::disallowed_methods, reason = "test setup: the settings files, the workspace folder and the test's own provider endpoint")]

use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_acp::preset::AgentPreset;
use mixdog_acp::preset::Distribution;
use mixdog_app_server_client::api::Connector;
use mixdog_app_server_client::api::Target;
use mixdog_app_server_client::api::TransportEvent;
use mixdog_app_server_client::api::TransportHalves;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::server::serve_in_process;

#[allow(dead_code, reason = "the fake agent's own `main` is its binary's")]
#[path = "../../../mixdog-acp/fake/agent.rs"]
mod fake_agent;

/// The argument that makes a run of this binary the fake agent: what follows it are the agent's own arguments.
const AGENT: &str = "acp-fake-agent";
/// The Mixdog provider and model `seed_default_model` writes.
const PROVIDER: &str = "custom-test";
const MODEL: &str = "test-model";
/// Each wait of these tests: a composition, an agent's check, a turn.
const LIMIT: Duration = Duration::from_secs(90);

/// No test of anything: started with [`AGENT`] among its arguments, this binary is the fake agent on the arguments after it.
#[test]
fn the_fake_agents_process() {
    let args: Vec<String> = std::env::args().collect();
    let Some(at) = args.iter().position(|arg| arg == AGENT) else { return };
    // The harness's own line of this test ends before the agent's first.
    println!();
    fake_agent::run(args[at + 1..].to_vec());
}

/// The shipped CLI preset with this binary as its CLI: nothing to install, update or sign in to.
fn fake_preset() -> AgentPreset {
    let test = format!("{}::the_fake_agents_process", module_path!().split_once("::").expect("a module of the crate").1);
    let run = |argument: &str| -> Vec<String> { ["--exact", &test, "--nocapture", "--", AGENT, argument].map(str::to_owned).to_vec() };
    let shipped = crate::acp_tools::builtin_presets().into_iter().find(|preset| preset.id == "antigravity-cli").expect("the CLI's preset");
    AgentPreset {
        command: std::env::current_exe().expect("the test binary").to_string_lossy().into_owned(),
        args: run("acp"),
        version_args: run("--version"),
        env: Vec::new(),
        distribution: Distribution::Cli { installer: None, installed_at: Vec::new(), update_args: None },
        login: None,
        usage: None,
        ..shipped
    }
}

/// The fake agent's model the session's route names: the CLI's preset offers no default model.
const FAKE_MODEL: &str = "m1";

/// What the session title request's system prompt says (`run_host::title_completion`).
const TITLE_REQUEST: &str = "concise, natural session title";

/// A request the Mixdog provider was sent: its first line, and whether it asked for a session title.
#[derive(Clone, Debug)]
struct Sent {
    line: String,
    title: bool,
}

/// The requests of the session's own turns: what was posted, without the maintainer's title requests. The provider's
/// reachability and model-list reads are no turn's.
fn turn_requests(sent: &Mutex<Vec<Sent>>) -> Vec<String> {
    sent.lock().unwrap().iter().filter(|sent| !sent.title && sent.line.starts_with("POST")).map(|sent| sent.line.clone()).collect()
}

/// The address of the Mixdog provider: each request is kept and refused, so a turn sent there ends at once.
fn provider() -> (u16, Arc<Mutex<Vec<Sent>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let port = listener.local_addr().expect("the port").port();
    let requests: Arc<Mutex<Vec<Sent>>> = Arc::default();
    let kept = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Ok(read) = stream.try_clone() else { continue };
            let mut reader = std::io::BufReader::new(read);
            let (mut first, mut length) = (String::new(), 0_usize);
            let _ = reader.read_line(&mut first);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; length];
            let _ = reader.read_exact(&mut body);
            kept.lock().unwrap().push(Sent { line: first.trim().to_owned(), title: String::from_utf8_lossy(&body).contains(TITLE_REQUEST) });
            let answer = r#"{"error":{"message":"refused by the test's provider"}}"#;
            let _ = write!(
                stream,
                "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                answer.len()
            );
        }
    });
    (port, requests)
}

/// The tools of the session's own a handed call is tried with, in order of preference.
const DIRECT: [&str; 4] = ["list", "read", "glob", "grep"];

/// The user's hooks: every call's PreToolUse payload is appended to `hook-calls.log`, and a call of a [`DIRECT`] tool asks.
fn seed_hooks(data: &Path) {
    let log = data.join("hook-calls.log");
    let (command, args) = if cfg!(windows) {
        let script = data.join("note.cmd");
        std::fs::write(&script, format!("@findstr \"^\" >>\"{0}\"\r\n@echo.>>\"{0}\"\r\n@exit /b 0\r\n", log.display())).expect("the hook's script");
        ("cmd".to_owned(), vec!["/C".to_owned(), script.to_string_lossy().into_owned()])
    } else {
        let script = data.join("note.sh");
        std::fs::write(&script, format!("cat >> '{0}'\necho >> '{0}'\n", log.display())).expect("the hook's script");
        ("sh".to_owned(), vec![script.to_string_lossy().into_owned()])
    };
    let rules: Vec<Value> = DIRECT.iter().map(|tool| json!({ "tool": tool, "action": "ask", "enabled": true })).collect();
    let hooks = json!({ "PreToolUse": [{ "hooks": [{ "type": "command", "command": command, "args": args, "timeout": 30 }] }] });
    std::fs::write(data.join("hooks.json"), json!({ "toolBefore": rules, "hooks": hooks }).to_string()).expect("the hooks file");
}

/// The tool of each call the PreToolUse hook was run for, in order.
fn hooked(data: &Path) -> Vec<String> {
    let log = std::fs::read_to_string(data.join("hook-calls.log")).unwrap_or_default();
    let payloads = log.lines().filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok());
    payloads.filter_map(|payload| payload["tool_name"].as_str().map(str::to_owned)).collect()
}

/// A user's settings with the ACP agents turned on and the Mixdog provider at `port`, which is also the Maintainer's route.
fn seed(data: &Path, port: u16) {
    seed_hooks(data);
    crate::compose_test_support::seed_default_model(data);
    let file = data.join("mixdog-config.json");
    let mut config: Value = serde_json::from_str(&std::fs::read_to_string(&file).expect("the settings file")).expect("JSON");
    config["agent"]["builtins"] = json!({ mixdog_acp::FEATURE: { "installed": true } });
    config["agent"]["providers"][PROVIDER]["baseURL"] = json!(format!("http://127.0.0.1:{port}"));
    config["agent"]["agents"]["maintainer"] = json!({ "provider": PROVIDER, "model": MODEL });
    std::fs::write(file, config.to_string()).expect("the settings file");
}

async fn until<T>(what: &str, mut found: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + LIMIT;
    loop {
        if let Some(found) = found() {
            return found;
        }
        assert!(tokio::time::Instant::now() < deadline, "{what} did not happen");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

struct Desktop {
    halves: TransportHalves,
    next: u64,
    /// The tool of each approval card this client was shown and allowed.
    approved: Vec<String>,
    /// By thread, the turns this client asked for, and the turn ends it was told of.
    asked: std::collections::HashMap<String, usize>,
    ended: std::collections::HashMap<String, usize>,
}

impl Desktop {
    async fn open(server: &Arc<dyn Connector>) -> Self {
        let halves = server.open(&Target { id: "in-process".into() }).await.expect("a connection");
        let mut desktop = Self { halves, next: 0, approved: Vec::new(), asked: Default::default(), ended: Default::default() };
        desktop
            .call("initialize", json!({ "clientInfo": { "name": "desktop", "version": env!("CARGO_PKG_VERSION"), "kind": "desktop" }, "capabilities": {} }))
            .await;
        desktop
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        self.halves.writer.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()).await.expect("send");
        let answer = tokio::time::timeout(LIMIT, async {
            loop {
                let frame = self.frame(&format!("the reply to {method}")).await;
                if frame["id"] == id && frame.get("method").is_none() {
                    return frame;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no reply to {method}"));
        assert!(answer.get("result").is_some(), "{method}: {answer}");
        answer["result"].clone()
    }

    /// The next frame the server sends, once the approval cards before it are allowed; the turn ends it tells are counted.
    async fn frame(&mut self, waiting: &str) -> Value {
        loop {
            let TransportEvent::Frame(text) = self.halves.reader.recv().await else { panic!("the server closed before {waiting}") };
            let frame: Value = serde_json::from_str(&text).expect("a frame");
            // The gate's approval card: the user allows the call.
            if frame["method"] == "item/tool/requestApproval" {
                self.approved.push(frame["params"]["name"].as_str().unwrap_or_default().to_owned());
                let allowed = json!({ "jsonrpc": "2.0", "id": frame["id"], "result": { "approved": true } });
                self.halves.writer.send(allowed.to_string()).await.expect("send");
                continue;
            }
            if frame["method"] == "turn/completed"
                && let Some(thread) = frame["params"]["threadId"].as_str()
            {
                *self.ended.entry(thread.to_owned()).or_default() += 1;
            }
            return frame;
        }
    }

    /// Once every turn this client asked of `thread` has ended.
    async fn turns_ended(&mut self, thread: &str) {
        let asked = self.asked.get(thread).copied().unwrap_or_default();
        tokio::time::timeout(LIMIT, async {
            while self.ended.get(thread).copied().unwrap_or_default() < asked {
                self.frame("a turn's end").await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the turns asked of {thread} never ended"));
    }

    fn op(&self) -> String {
        format!("01900000-0000-7000-8000-{:012}", self.next + 1)
    }

    /// The session's route becomes `provider` and `model`, as the picker sets it.
    async fn route(&mut self, thread: &str, provider: &str, model: &str) {
        let op = self.op();
        let route = json!({ "provider": provider, "model": model, "applyToCurrentSession": true, "keepMainModel": false });
        self.call("route/set", json!({ "opId": op, "threadId": thread, "route": route })).await;
    }

    async fn ask(&mut self, thread: &str, prompt: &str) {
        let op = self.op();
        let turn = self.call("turn/start", json!({ "opId": op, "threadId": thread, "input": { "prompt": prompt } })).await;
        assert!(matches!(turn["kind"].as_str(), Some("started" | "queued")), "{turn}");
        *self.asked.entry(thread.to_owned()).or_default() += 1;
    }

    /// The thread's items, as text, once they hold `text`.
    async fn until_shown(&mut self, thread: &str, text: &str) -> String {
        let deadline = tokio::time::Instant::now() + LIMIT;
        loop {
            let items = self.call("thread/items/list", json!({ "threadId": thread })).await.to_string();
            if items.contains(text) {
                return items;
            }
            assert!(tokio::time::Instant::now() < deadline, "the thread never showed {text:?}: {items}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// The composed core with the fake agent as its one preset, and a session on that agent's route.
struct World {
    core: Arc<ComposedCore>,
    desktop: Desktop,
    shutdown: crate::server::Shutdown,
    preset: AgentPreset,
    thread: String,
    data: PathBuf,
    /// Each request the Mixdog provider was sent.
    provider_requests: Arc<Mutex<Vec<Sent>>>,
    /// The core's log.
    log: PathBuf,
}

impl World {
    async fn open(dir: &Path) -> Self {
        let (port, provider_requests) = provider();
        let data = crate::compose_test_support::data_in(dir);
        seed(&data, port);
        let ws = dir.join("ws");
        std::fs::create_dir_all(&ws).expect("the workspace");
        let tokens = mixdog_rt::testing::tokens();
        let outgoing = mixdog_app_server::Outgoing::new();
        let preset = fake_preset();
        let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new());
        log.enable_file_logging();
        let config = ComposeConfig {
            outgoing: outgoing.clone(),
            agent_presets: vec![preset.clone()],
            ..tests::config_in(&data, dir, log, mixdog_rt::CancellationToken::new())
        };
        let core = Arc::new(compose(&tokens, config).await.expect("the composed core"));
        let (server, shutdown) = serve_in_process(core.clone(), outgoing).expect("the in-process server");
        let mut desktop = Desktop::open(&server).await;
        // The agent's route can be chosen once the feature's own check of its CLI has ended.
        let agents = core.real.acp_agents.clone();
        until("the agent's check", || agents.selectable(&preset).is_ok().then_some(())).await;
        let op = desktop.op();
        let route = json!({ "provider": preset.provider, "model": FAKE_MODEL });
        let started = desktop.call("thread/start", json!({ "opId": op, "kind": "project", "projectPath": ws, "draft": { "route": route } })).await;
        let thread = started["thread"]["id"].as_str().expect("thread id").to_owned();
        desktop.route(&thread, &preset.provider, FAKE_MODEL).await;
        // The session's approval cards are shown to this client.
        desktop.call("thread/resume", json!({ "threadId": thread, "window": { "lastItems": 10 } })).await;
        Self { core, desktop, shutdown, preset, thread, data, provider_requests, log: dir.join("daemon.log") }
    }

    /// One prompt of the agent, to the end of its turn and of every turn asked before it; the client answers the cards it is
    /// shown meanwhile. The thread's items.
    async fn turn(&mut self, prompt: &str) -> String {
        self.desktop.ask(&self.thread, prompt).await;
        self.desktop.turns_ended(&self.thread).await;
        self.desktop.call("thread/items/list", json!({ "threadId": self.thread })).await.to_string()
    }

    fn thread(&self) -> ThreadId {
        ThreadId::from(self.thread.as_str())
    }

    fn header(&self) -> mixdog_store::schema::record::Header {
        self.core.real.directory.handle(&self.thread()).expect("the session is loaded").live_header().header().as_ref().clone()
    }

    /// The lines of the core's log that hold `part`, once there are any.
    async fn logged(&self, part: &str) -> Vec<String> {
        let deadline = tokio::time::Instant::now() + LIMIT;
        loop {
            self.core.flush_log().await;
            let text = std::fs::read_to_string(&self.log).unwrap_or_default();
            let lines: Vec<String> = text.lines().filter(|line| line.contains(part)).map(str::to_owned).collect();
            if !lines.is_empty() {
                return lines;
            }
            assert!(tokio::time::Instant::now() < deadline, "the log never said {part:?}: {text}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// One turn of the session that its agent answers with how it was started.
    async fn agent_turn(&mut self) -> String {
        self.desktop.ask(&self.thread, "whoami").await;
        self.desktop.until_shown(&self.thread, "session=sess-1").await
    }
}

fn runtime() -> tokio::runtime::Builder {
    let mut runtime = tokio::runtime::Builder::new_multi_thread();
    runtime.worker_threads(2);
    runtime
}

/// The names the deferred roster of `prompt` lists.
fn roster(prompt: &str) -> Vec<String> {
    let listed =
        prompt.split_once("<available-deferred-tools>").and_then(|(_, rest)| rest.split_once("</available-deferred-tools>")).map_or("", |(listed, _)| listed);
    listed.lines().filter_map(|line| line.strip_prefix("- ")).map(|entry| entry.split_once(':').map_or(entry, |(name, _)| name).to_owned()).collect()
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn a_session_on_an_agents_route_is_a_bridge_session_and_its_agent_is_handed_that_sessions_tools_and_prompt() {
    crate::compose_test_support::in_child(
        module_path!(),
        "a_session_on_an_agents_route_is_a_bridge_session_and_its_agent_is_handed_that_sessions_tools_and_prompt",
        runtime(),
        |dir| async move {
            let mut world = World::open(&dir).await;
            // The turn's start ran Mixdog's own reconcile and did not fail the turn: the agent answered it.
            let answered = world.agent_turn().await;

            let header = world.header();
            assert_eq!(header.get("provider").and_then(Value::as_str), Some(world.preset.provider.as_str()), "{header:?}");
            assert_eq!(header.get("toolExposureMode"), Some(&json!(mixdog_core::run_host::tool_exposure::TOOL_EXPOSURE_BRIDGE)), "{header:?}");

            // What a request of the session sends: tools of the pool defined directly, and the two bridge tools.
            let sent: Vec<String> =
                world.core.real.handed_tools.0.definitions(&world.thread()).await.expect("the session's tools").into_iter().map(|tool| tool.name).collect();
            let pool: Vec<String> = world.core.real.tool_pool.iter().filter_map(|tool| tool.definition()["name"].as_str().map(str::to_owned)).collect();
            assert!(sent.iter().any(|name| name == "load_tool") && sent.iter().any(|name| name == "call_tool"), "{sent:?}");
            assert!(sent.iter().any(|name| pool.contains(name)), "no tool of the pool is defined directly: {sent:?}");

            // The session's prompt, as its header holds it: the roster of the tools left to `load_tool`, none of them sent, and the bridge's section.
            let blocks = mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(&header);
            let prompt = [blocks.base, blocks.stable, blocks.core, blocks.env].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
            let deferred = roster(&prompt);
            assert!(!deferred.is_empty(), "the prompt lists no deferred tool: {prompt}");
            assert!(deferred.iter().all(|name| !sent.contains(name)), "a deferred tool is sent: {deferred:?} among {sent:?}");
            assert!(prompt.contains("<tool-bridge>"), "{prompt}");

            // The agent was handed both: the prompt as its appendix, and the sent definitions as its MCP server's listing.
            assert!(answered.contains("<available-deferred-tools>") && answered.contains("<tool-bridge>"), "{answered}");
            world.desktop.ask(&world.thread, "tools").await;
            world.desktop.until_shown(&world.thread, &format!("tools={}", sent.join(","))).await;
            world.shutdown.run().await;
        },
    );
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn a_handed_call_and_a_call_tool_each_run_once_through_the_sessions_own_gate_and_hooks() {
    crate::compose_test_support::in_child(
        module_path!(),
        "a_handed_call_and_a_call_tool_each_run_once_through_the_sessions_own_gate_and_hooks",
        runtime(),
        |dir| async move {
            let mut world = World::open(&dir).await;
            world.agent_turn().await;
            let sent: Vec<String> =
                world.core.real.handed_tools.0.definitions(&world.thread()).await.expect("the session's tools").into_iter().map(|tool| tool.name).collect();
            let pool: Vec<String> = world.core.real.tool_pool.iter().filter_map(|tool| tool.definition()["name"].as_str().map(str::to_owned)).collect();
            let direct =
                DIRECT.iter().find(|name| sent.iter().any(|sent| sent == *name)).unwrap_or_else(|| panic!("none of {DIRECT:?} is defined directly: {sent:?}"));
            let blocks = mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(&world.header());
            let prompt = [blocks.base, blocks.stable, blocks.core, blocks.env].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
            let deferred = roster(&prompt)
                .into_iter()
                .find(|name| pool.contains(name) && !sent.contains(name))
                .unwrap_or_else(|| panic!("the roster names no tool of the pool: {prompt}"));

            // A directly defined tool, called by the agent through the session's server: the user's rule asks, on the session's own
            // card, and the user's PreToolUse hook hears of the call once.
            let items = world.turn(&format!("tool {direct} {}", json!({ "path": "." }))).await;
            assert_eq!(world.desktop.approved, [*direct], "{items}");
            assert_eq!(hooked(&world.data), [*direct], "{items}");
            assert!(items.contains(&format!("\"{direct}\"")), "the call has no card: {items}");

            // A deferred tool through `call_tool`: the loop runs the target, which the hook hears of once; of `call_tool` it hears nothing.
            let bridged = json!({ "name": deferred, "arguments": {} });
            let items = world.turn(&format!("tool call_tool {bridged}")).await;
            assert_eq!(hooked(&world.data), [direct.to_string(), deferred.clone()], "{items}");
            assert!(items.contains("\"call_tool\""), "the bridged call has no card: {items}");
            world.shutdown.run().await;
        },
    );
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn a_route_pick_held_for_the_turn_that_leaves_the_agent_runs_the_turn_on_the_route_the_header_then_names() {
    crate::compose_test_support::in_child(
        module_path!(),
        "a_route_pick_held_for_the_turn_that_leaves_the_agent_runs_the_turn_on_the_route_the_header_then_names",
        runtime(),
        |dir| async move {
            let mut world = World::open(&dir).await;
            world.agent_turn().await;
            // The Maintainer's title request is no request of the agent's turn.
            assert!(turn_requests(&world.provider_requests).is_empty(), "an agent's turn sends the Mixdog provider nothing");

            // The pick is held for the next turn: the session's header is the agent's until that turn starts.
            world.desktop.route(&world.thread, PROVIDER, MODEL).await;
            assert_eq!(world.header().get("provider").and_then(Value::as_str), Some(world.preset.provider.as_str()));
            world.desktop.ask(&world.thread, "over to the provider").await;

            let requests = world.provider_requests.clone();
            until("the Mixdog provider's request", || turn_requests(&requests).iter().any(|line| line.starts_with("POST")).then_some(())).await;
            assert_eq!(world.header().get("provider").and_then(Value::as_str), Some(PROVIDER));
            assert!(world.core.real.acp_agents.running(&world.thread()).is_none(), "the agent's process outlived the session's move off its route");
            world.shutdown.run().await;
        },
    );
}

/// An agent's model is saved as a workflow agent's route as a provider's is, and a worker spawned on it runs its turn in the agent, on
/// that model: the Mixdog provider is sent no turn.
#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn a_worker_whose_saved_route_is_an_agents_model_runs_its_turn_in_the_agent() {
    crate::compose_test_support::in_child(
        module_path!(),
        "a_worker_whose_saved_route_is_an_agents_model_runs_its_turn_in_the_agent",
        runtime(),
        |dir| async move {
            let mut world = World::open(&dir).await;
            let op = world.desktop.op();
            let route = json!({ "provider": world.preset.provider, "model": "m2" });
            world.desktop.call("route/set", json!({ "opId": op, "threadId": world.thread, "agentId": "worker", "route": route })).await;
            let saved: Value = serde_json::from_str(&std::fs::read_to_string(world.data.join("mixdog-config.json")).expect("the settings file")).expect("JSON");
            let worker = &saved["agent"]["agents"]["worker"];
            assert_eq!((&worker["provider"], &worker["model"]), (&json!(world.preset.provider), &json!("m2")), "{saved}");

            // The Lead, itself on the agent, delegates: the worker answers how its own agent session was started.
            let sent: Vec<String> =
                world.core.real.handed_tools.0.definitions(&world.thread()).await.expect("the session's tools").into_iter().map(|tool| tool.name).collect();
            let spawn = json!({ "type": "spawn", "agent": "worker", "tag": "w1", "prompt": "whoami" });
            let prompt = if sent.iter().any(|name| name == "agent") {
                format!("tool agent {spawn}")
            } else {
                format!("tool call_tool {}", json!({ "name": "agent", "arguments": spawn }))
            };
            world.desktop.ask(&world.thread, &prompt).await;
            let items = world.desktop.until_shown(&world.thread, "model=m2").await;
            assert!(turn_requests(&world.provider_requests).is_empty(), "a turn was sent to the Mixdog provider: {items}");
            world.shutdown.run().await;
        },
    );
}

/// The title of a session on an agent's route is asked of the Maintainer's route, the Mixdog provider here, which refuses it: the session
/// keeps the title its first prompt gave it, and the core's log says once that the title failed.
#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn a_session_on_an_agents_route_is_titled_through_the_maintainers_route() {
    crate::compose_test_support::in_child(
        module_path!(),
        "a_session_on_an_agents_route_is_titled_through_the_maintainers_route",
        runtime(),
        |dir| async move {
            let mut world = World::open(&dir).await;
            world.agent_turn().await;

            let requests = world.provider_requests.clone();
            until("the title request", || requests.lock().unwrap().iter().any(|sent| sent.title).then_some(())).await;
            assert!(turn_requests(&requests).is_empty(), "the agent's turn was sent to the Mixdog provider: {:?}", requests.lock().unwrap());
            let failed = world.logged(&format!("[mixdog] llm-title failed id={} stage=first", world.thread)).await;
            assert_eq!(world.logged(&format!("[mixdog] llm-title start id={} stage=first", world.thread)).await.len(), 1);

            // A second turn is no first prompt: nothing is asked again.
            world.turn("whoami").await;
            assert_eq!(world.logged("[mixdog] llm-title failed").await, failed, "one failure line");
            assert_eq!(failed.len(), 1, "{failed:?}");
            assert_eq!(requests.lock().unwrap().iter().filter(|sent| sent.title).count(), 1);
            assert_eq!(world.header().get("title").and_then(Value::as_str), Some("whoami"));
            assert_eq!(world.header().get("generatedTitleStage"), None);
            world.shutdown.run().await;
        },
    );
}
