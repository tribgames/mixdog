//! A bot's `session action=send` through the daemon's own composition: the `session` tool of the composed tool pool, the task-report
//! host `real_core` wires behind it, and the session directory's real turns over a provider answering on a loopback port. The answer is
//! Node's recorded `send-bot-other` (`reportsBack: true`), and that promise holds: the sent turn runs to its final answer and the report
//! of it reaches the bot's home chat.
#![allow(clippy::disallowed_methods, reason = "test setup: reads the recorded fixture and writes the settings a user's setup would have")]

use std::time::Duration;

use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ThreadId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use super::*;

const GOLDEN: &str = include_str!("../../../../fixtures/session-tool-control/golden.json");
/// Each wait of this test: a composition, a turn, a report.
const LIMIT: Duration = Duration::from_secs(60);

/// The OpenAI chat endpoint the seeded provider calls: the sent turn (its input carries the sent prompt) answers the recorded final
/// text; any other turn (the bot's own, woken by the report) answers something else, so the final text in the bot's chat is the report's.
async fn serve(listener: tokio::net::TcpListener, sent: String, final_text: String) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else { return };
        let (sent, final_text) = (sent.clone(), final_text.clone());
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            let body_start = loop {
                let read = socket.read(&mut chunk).await.unwrap_or(0);
                if read == 0 {
                    return;
                }
                buf.extend_from_slice(&chunk[..read]);
                if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let head = String::from_utf8_lossy(&buf[..body_start]).to_lowercase();
            let length: usize = head.lines().find_map(|line| line.strip_prefix("content-length:")).and_then(|n| n.trim().parse().ok()).unwrap_or(0);
            while buf.len() < body_start + length {
                let read = socket.read(&mut chunk).await.unwrap_or(0);
                if read == 0 {
                    return;
                }
                buf.extend_from_slice(&chunk[..read]);
            }
            let body: Value = serde_json::from_slice(&buf[body_start..body_start + length]).unwrap_or(Value::Null);
            let asks_the_sent_turn = body["messages"].as_array().into_iter().flatten().any(|m| m["role"] == "user" && m["content"].to_string().contains(&sent));
            let text = if asks_the_sent_turn { final_text } else { "Noted.".to_owned() };
            let chunk = |delta: Value, finish: Value| json!({ "id": "c1", "object": "chat.completion.chunk", "model": "test-model", "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] });
            let events = [
                chunk(json!({ "role": "assistant", "content": text }), Value::Null),
                chunk(json!({}), json!("stop")),
                json!({ "id": "c1", "object": "chat.completion.chunk", "model": "test-model", "choices": [], "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15 } }),
            ];
            let mut sse: String = events.iter().map(|event| format!("data: {event}\n\n")).collect();
            sse.push_str("data: [DONE]\n\n");
            let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{sse}", sse.len());
            let _ = socket.write_all(reply.as_bytes()).await;
        });
    }
}

/// Waits for `runtime`'s next state change, failing with `what` at the deadline or when the runtime goes away.
async fn next_change(changes: &mut tokio::sync::mpsc::UnboundedReceiver<()>, what: &str) {
    match tokio::time::timeout(LIMIT, changes.recv()).await {
        Ok(Some(())) => {}
        Ok(None) => panic!("the runtime closed while waiting for {what}"),
        Err(_) => panic!("timed out after {LIMIT:?} waiting for {what}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bots_send_through_the_composed_core_reports_the_final_answer_to_its_home() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scenario = golden["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "send-bot-other").expect("send-bot-other").clone();
    let final_text = golden["send"]["final"].as_str().unwrap().to_owned();
    let (caller, target) = (ThreadId::from(scenario["caller"]["id"].as_str().unwrap()), ThreadId::from(scenario["args"]["session_id"].as_str().unwrap()));
    let bot = golden["bots"][0].clone();

    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(serve(listener, scenario["args"]["prompt"].as_str().unwrap().to_owned(), final_text.clone()));
    // The provider a user signed in, answering here; the bot as its folder holds it.
    crate::compose_test_support::seed_default_model(&data);
    let settings = std::fs::read_to_string(data.join("mixdog-config.json")).unwrap().replace("http://127.0.0.1:9", &base);
    std::fs::write(data.join("mixdog-config.json"), settings).unwrap();
    let bot_dir = data.join("agents").join(bot["id"].as_str().unwrap());
    std::fs::create_dir_all(&bot_dir).unwrap();
    std::fs::write(bot_dir.join("agent.json"), json!({ "name": bot["name"] }).to_string()).unwrap();
    std::fs::write(bot_dir.join("AGENT.md"), "---\nkind: bot\n---\n\nYou help with builds.\n").unwrap();

    let tokens = mixdog_rt::testing::tokens();
    let stop = mixdog_rt::CancellationToken::new();
    let core = tokio::time::timeout(
        LIMIT,
        compose(&tokens, ComposeConfig {
            data_dir: data.clone(),
            user_data_dir: dir.path().join("userdata"),
            js_runtime: crate::js_runtime::fixture(dir.path()),
            ort_library: OrtRuntime::NoBinding,
            outgoing: mixdog_app_server::Outgoing::new(),
            ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
            log: crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone()),
            stop,
            catalog_http: crate::compose_test_support::offline_http(),
            pg_install: Some(Arc::new(|_| Box::pin(async { Err(mixdog_services::memory::error::MemoryError::Runtime("the send test installs no PostgreSQL".into())) }))),
        }),
    )
    .await
    .expect("the core composed within the limit")
    .expect("the core composes");

    let outcome = async {
        let directory = core.real.directory.clone();
        let cwd = dir.path().to_string_lossy().into_owned();
        // The sessions of the recording, on the seeded route: the bot's home chat and the session it sends to.
        for (id, title) in [(&caller, golden["send"]["targets"][caller.as_str()]["title"].clone()), (&target, golden["send"]["targets"][target.as_str()]["title"].clone())] {
            let mut header = Map::new();
            for (key, value) in scenario["caller"].as_object().unwrap().iter().filter(|_| id == &caller) {
                if key != "id" {
                    header.insert(key.clone(), value.clone());
                }
            }
            header.insert("title".into(), title);
            header.insert("provider".into(), json!("custom-test"));
            header.insert("model".into(), json!("test-model"));
            header.insert("cwd".into(), json!(cwd));
            directory.create_with_id(id.clone(), header, json!({})).await.unwrap_or_else(|e| panic!("create {id:?}: {e:?}"));
        }
        let (sent_runtime, home_runtime) = (directory.report_runtime(&target).await.expect("the target's runtime"), directory.report_runtime(&caller).await.expect("the home's runtime"));
        let (mut sent_changes, mut home_changes) = (sent_runtime.subscribe(), home_runtime.subscribe());

        let tool = core.real.tool_pool.iter().find(|tool| tool.spec().name == "session").expect("the composed core has the session tool");
        let ctx = ToolContext {
            call_id: mixdog_protocol::ToolCallId::from("call-1"),
            thread_id: caller.clone(),
            turn_id: mixdog_protocol::TurnId::from("r"),
            tool: "session".into(),
            cwd: mixdog_core_api::domain::common::AbsPath::new(dir.path().to_owned()).unwrap(),
            surface: SurfaceKind::Lead,
            cancel: mixdog_rt::CancellationToken::new(),
            deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: core.file_service.clone(),
            processes: Arc::new(core.local_processes().clone()),
            options: Default::default(),
            review: Some(core.real.turn_review.clone()),
        };
        let out = tool.call(&ctx, scenario["args"].clone()).await.expect("the send is accepted");
        let [ToolPart::Text(text)] = &out.parts[..] else { panic!("one text part: {:?}", out.parts) };
        // The send's id is minted per call; the recording names it `atask_<send>`.
        let send_id = serde_json::from_str::<Value>(text).unwrap()["sendId"].as_str().expect("a send id").to_owned();
        assert_eq!(text.replace(&send_id, "atask_<send>"), scenario["expected"]["text"].as_str().unwrap(), "the answer is Node's");

        // The sent turn runs to its end, on the recorded final answer.
        loop {
            let messages = directory.session_messages(&target).await.unwrap().unwrap_or_default();
            if !sent_runtime.busy() && messages.iter().any(|m| m["role"] == "assistant" && m["content"].to_string().contains(&final_text)) {
                break;
            }
            next_change(&mut sent_changes, "the sent turn to end on the recorded final answer").await;
        }
        // Its report reaches the bot's home chat, carrying that final answer (the bot's own reply to it says something else).
        loop {
            let home = directory.session_messages(&caller).await.unwrap().unwrap_or_default();
            if home.iter().any(|m| m["content"].to_string().contains(&final_text)) {
                break;
            }
            next_change(&mut home_changes, "the report to reach the bot's home chat").await;
        }
    };
    use futures::FutureExt;
    let result = std::panic::AssertUnwindSafe(outcome).catch_unwind().await;
    tokio::time::timeout(LIMIT, core.stop("session send test")).await.expect("the core stopped within the limit");
    server.abort();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
