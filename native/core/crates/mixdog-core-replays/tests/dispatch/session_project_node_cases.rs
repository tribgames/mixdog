//! Node's `session` tool Project and worktree cases (`fixtures/session-tool-project-cases`,
//! `record-session-tool-project-cases.mjs`): each recorded call through the `SessionTool` over the
//! `DirectorySessionPort`, the whole outcome (the tool's text or its error message) against Node's.
//! The threads are real: `sess-1`, `worker-1` and `w` live in a `SessionDirectory` over the session rig, their headers
//! are the directory's, and a fork and a compaction run the thread actors. The Project switch is the product's: the port's
//! requests go through `SettingsRequests` to the thread settings service over the real workspace host, so what the call
//! answers and what the thread's header stores are the product's. Node's test answered with a double (`switchProject:ok`,
//! or `<path>::caller` for a call's own `setCallerCwd`); the product answers the folder it stored, which is what those
//! doubles stood for (the manifest's `compared`). The calls run while the Lead's own turn runs, as a tool call does
//! (`ownTurn: true`, recorded in `switches`).

use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_tools::orch::session::SessionTool;

use mixdog_core::run_host::tool_pool::session_port::SettingsRequests;
use super::*;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/session-tool-project-cases/golden.json")).expect("json")
}

/// The Lead's own turn, held running until released: a `session set-project` call is made inside it.
async fn hold_turn(directory: &SessionDirectory, rig: &Rig, thread: &str) -> Arc<tokio::sync::Notify> {
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = release.clone();
    rig.set_script(Arc::new(move |_run| {
        let gate = gate.clone();
        Box::pin(async move {
            gate.notified().await;
            mixdog_core_session::session::RunOutcome::Completed(Box::default())
        })
    }));
    let id = ThreadId::from(thread);
    let handle = directory.open_handle(&id, &connection()).await.expect("opens");
    let op = OpId::from(uuid::Uuid::now_v7().to_string());
    let params = json!({ "threadId": id, "opId": op.as_str(), "input": { "prompt": "work" } });
    handle.request(CoreRequest { method: Method("turn/start"), params, op: Some(op), ctx: connection() }).await.expect("turn/start");
    mixdog_core_session::session::testing::awaiting(
        || format!("the turn of {thread} to run"),
        async {
            loop {
                let stepped = handle.stepped().notified();
                tokio::pin!(stepped);
                stepped.as_mut().enable();
                if mixdog_core_session::session::agent_registry::LiveSessions::running(directory, thread) {
                    return;
                }
                stepped.await;
            }
        },
    )
    .await;
    release
}

/// The Settings switch of AI titles, which a case turns off between calls (`rt.config.aiSessionTitles = false`).
struct Toggle(std::sync::atomic::AtomicBool);

impl AiTitleSetting for Toggle {
    fn enabled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// The store the title saves go through; armed, the user's manual rename lands right after the AI
/// title is saved, as in the test's awaited save.
struct Racing {
    threads: Arc<SessionThreads>,
    armed: bool,
}

#[async_trait]
impl ThreadState for Racing {
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        self.threads.header(thread).await
    }
    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError> {
        self.threads.patch_header(thread, set, unset).await
    }
    async fn patch_header_if(&self, thread: &ThreadId, expect: Map<String, Value>, set: Map<String, Value>, unset: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        let saves_ai_title = set.get("titleSource") == Some(&json!("ai"));
        let refused = self.threads.patch_header_if(thread, expect, set, unset).await?;
        if refused.is_none() && saves_ai_title && self.armed {
            let manual = json!({ "title": "Mine", "titleLocked": true, "titleSource": "user" }).as_object().cloned().expect("object");
            self.threads.patch_header(thread, manual, Vec::new()).await?;
        }
        Ok(refused)
    }
    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
        self.threads.publish(thread, section).await
    }
}

/// The call asks for a Project switch: `action=set-project`, or a `path` and no action.
fn args_set_project(args: &Value) -> bool {
    match args["action"].as_str() {
        Some(action) => action == "set-project",
        None => args["path"].is_string(),
    }
}

fn call_ctx(thread: &str, surface: SurfaceKind) -> ToolContext {
    ToolContext { thread_id: ThreadId::from(thread), surface, cwd: AbsPath::new(std::path::PathBuf::from("C:/work")).expect("absolute"), tool: "session".into(), ..ctx() }
}

fn connection() -> CallContext {
    CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new())
}

/// The fork's answer names the copy the directory minted; the test's lifecycle double minted `new-1`, which stands for it.
fn minted(outcome: Value, copies: &mut Vec<String>) -> Value {
    let Some(text) = outcome["ok"].as_str() else { return outcome };
    let Ok(mut answer) = serde_json::from_str::<Value>(text) else { return outcome };
    if answer["action"] != "fork" {
        return outcome;
    }
    copies.push(answer["sessionId"].as_str().expect("the copy's id").to_owned());
    answer["sessionId"] = json!("new-1");
    json!({ "ok": serde_json::to_string_pretty(&answer).expect("json") })
}

/// `[source, compacted]` of each copy the forks made: the copy's own header names its source, and the compaction engine ran
/// (on the copy: the tool compacts nothing else) once the fork answered.
async fn forks_made(threads: &SessionThreads, rig: &Rig, copies: &[String]) -> Vec<Value> {
    let compacted = mixdog_core_session::session::testing::lock(&rig.compaction.calls).first().map(String::as_str) == Some("compact manual false");
    let mut forks = Vec::new();
    for copy in copies {
        let header = threads.header(&ThreadId::from(copy.as_str())).await.expect("the copy");
        forks.push(json!([header["inheritedFromSessionId"], compacted]));
    }
    forks
}

/// One finished user turn in `thread`: a conversation the fork has to carry (`inheritFrom` refuses a source with none).
async fn converse(directory: &SessionDirectory, thread: &str) {
    let id = ThreadId::from(thread);
    let handle = directory.open_handle(&id, &connection()).await.expect("opens");
    let op = OpId::from(uuid::Uuid::now_v7().to_string());
    let params = json!({ "threadId": id, "opId": op.as_str(), "input": { "prompt": "write a haiku" } });
    handle.request(CoreRequest { method: Method("turn/start"), params, op: Some(op), ctx: connection() }).await.expect("turn/start");
    mixdog_core_session::session::testing::awaiting(
        || format!("the turn of {thread} to finish"),
        async {
            loop {
                let stepped = handle.stepped().notified();
                tokio::pin!(stepped);
                stepped.as_mut().enable();
                let request = CoreRequest { method: Method("thread/read"), params: json!({ "threadId": id }), op: None, ctx: connection() };
                if let Ok(Reply::Value(view)) = handle.request(request).await
                    && view["items"].as_array().is_some_and(|items| items.iter().any(|item| item["type"] == "userMessage"))
                    && view["state"]["runtime"]["busy"] != json!(true)
                {
                    return;
                }
                stepped.await;
            }
        },
    )
    .await;
}

/// What `session compact` marked: the next completed turn of `thread` runs one manual compaction in its actor. The answer
/// lists the threads whose turn did.
async fn completed_turn_compacts(directory: &SessionDirectory, rig: &Rig, thread: &str) -> Value {
    let id = ThreadId::from(thread);
    let handle = directory.open_handle(&id, &connection()).await.expect("opens");
    let op = OpId::from(uuid::Uuid::now_v7().to_string());
    let params = json!({ "threadId": id, "opId": op.as_str(), "input": { "prompt": "go on" } });
    handle.request(CoreRequest { method: Method("turn/start"), params, op: Some(op), ctx: connection() }).await.expect("turn/start");
    mixdog_core_session::session::testing::awaiting(
        || format!("the compaction `session compact` scheduled to follow the turn of {thread}"),
        async {
            loop {
                let stepped = handle.stepped().notified();
                tokio::pin!(stepped);
                stepped.as_mut().enable();
                if mixdog_core_session::session::testing::lock(&rig.compaction.calls).len() >= 4 {
                    return;
                }
                stepped.await;
            }
        },
    )
    .await;
    assert_eq!(*mixdog_core_session::session::testing::lock(&rig.compaction.calls), ["compact manual false", "post manual", "rearm", "invalidate"]);
    json!([thread])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_session_project_call_answers_as_in_node() {
    let golden = golden();
    let dir = tempfile::tempdir().expect("dir");
    let shown_dir = dir.path().to_string_lossy().into_owned();
    for case in golden["cases"].as_array().unwrap() {
        let rig = Rig::new();
        *mixdog_core_session::session::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        for id in ["sess-1", "worker-1", "w"] {
            // The runtime session's fields the case set (`rt.session.title`, its route), or the session store the test's
            // session manager holds, as the thread's stored header.
            let header = if id == "sess-1" { case["recorded"]["session"].as_object().or(case["recorded"]["store"].as_object()).cloned().unwrap_or_default() } else { Map::new() };
            directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("the thread");
        }
        if case["recorded"].get("forks").is_some() {
            converse(&directory, "sess-1").await;
        }
        let racing: Arc<dyn ThreadState> = Arc::new(Racing { threads: threads.clone(), armed: case["recorded"]["store"]["title"] == "old" });
        let titles_on = Arc::new(Toggle(std::sync::atomic::AtomicBool::new(true)));
        let hosted = mixdog_core_session::session::thread_settings_rig::hosted(&directory, threads.clone());
        let built = mixdog_core_session::session::thread_settings_rig::build(
            directory.clone(),
            hosted.workspaces.clone(),
            hosted.worktrees.clone(),
            Vec::new(),
            hosted.dir.path().join("task").to_string_lossy().into_owned(),
        )
        .await;
        let requests = Arc::new(SettingsRequests::new(directory.clone(), Arc::new(built.settings)));
        // A tool call runs inside its caller's turn.
        let turn = if case["recorded"].get("switches").is_some() { Some(hold_turn(&directory, &rig, "sess-1").await) } else { None };
        let marks = HeartbeatSessions::new();
        let runs = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let callers = Arc::new(ThreadCallers::new(threads.clone(), marks, runs));
        let port = DirectorySessionPort::new(SessionPortParts {
            callers: callers.clone(),
            threads: racing.clone(),
            requests,
            titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(racing.clone(), Arc::new(Messages), Arc::new(Now))),
            ai_titles: titles_on.clone(),
            projects: Arc::new(NoProjects),
            bots: Arc::new(Bots(Vec::new())),
            suggestions: Arc::new(Suggested::default()),
            io: mixdog_rt::testing::tokens().interactive_io,
        });
        let tool = SessionTool::new(Arc::new(port), callers);
        let mut calls = Vec::new();
        let mut live = None;
        let mut copies = Vec::new();
        // The folder the Lead's header stored after each `set-project` the runtime answered (no `setCallerCwd`).
        let mut stored = Vec::new();
        for call in case["recorded"]["calls"].as_array().unwrap() {
            match call["label"].as_str() {
                // The test's store now answers `user-title`: the stored title is the user's.
                Some("rename over a user title") => {
                    let user = json!({ "titleLocked": true, "titleSource": "user" }).as_object().cloned().expect("object");
                    threads.patch_header(&ThreadId::from("sess-1"), user, Vec::new()).await.expect("the thread");
                }
                Some("rename with AI titles off") => titles_on.0.store(false, std::sync::atomic::Ordering::SeqCst),
                _ => {}
            }
            // Named in the manifest: Node's executor answering for a tool the core does not have.
            if call["tool"] != "session" {
                continue;
            }
            let args: Value = serde_json::from_str(&call["args"].to_string().replace("<dir>", &shown_dir.replace('\\', "\\\\"))).unwrap();
            if call["label"] == "status in a worktree" {
                let workspace = Map::from_iter([("workspace".to_owned(), case["recorded"]["workspace"].clone())]);
                threads.patch_header(&ThreadId::from("sess-1"), workspace, Vec::new()).await.expect("the thread");
            }
            let caller = call["context"]["callerSessionId"].as_str().unwrap_or("sess-1");
            let surface = if caller == "sess-1" { SurfaceKind::Lead } else { SurfaceKind::Agent };
            let outcome = match tool.call(&call_ctx(caller, surface), args).await {
                Ok(output) => {
                    let text: String = output.parts.iter().filter_map(|part| if let ToolPart::Text(text) = part { Some(text.as_str()) } else { None }).collect();
                    json!({ "ok": text.replace(&shown_dir.replace('\\', "\\\\"), "<dir>").replace(&shown_dir, "<dir>") })
                }
                Err(error) => json!({ "error": error.message_for_model.replace(&shown_dir, "<dir>") }),
            };
            let outcome = minted(outcome, &mut copies);
            if let Some(text) = outcome["ok"].as_str().filter(|_| args_set_project(&call["args"])) {
                // The answer names the folder the header now stores.
                let answered: Value = serde_json::from_str(text).expect("the answer");
                let header = threads.header(&ThreadId::from("sess-1")).await.expect("the thread");
                let folder = header["cwd"].as_str().expect("a stored folder").replace(&shown_dir, "<dir>");
                assert_eq!(answered["cwd"], json!(folder), "{}: the answer is the stored folder", call["label"]);
                if call["context"].get("setCallerCwd").is_none() {
                    stored.push(json!(folder));
                }
            }
            calls.push(json!({ "label": call["label"], "tool": call["tool"], "args": call["args"], "context": call["context"], "outcome": outcome }));
            // The live session's title after the case's first call (`rt.session.title`/`titleSource`).
            if live.is_none() {
                let header = threads.header(&ThreadId::from("sess-1")).await.expect("the thread");
                live = Some(json!({ "title": header.get("title").cloned().unwrap_or(Value::Null), "titleSource": header.get("titleSource").cloned().unwrap_or(Value::Null) }));
            }
        }
        let mut got = json!({ "calls": calls });
        let mut want = json!({ "calls": case["recorded"]["calls"].as_array().unwrap().iter().filter(|c| c["tool"] == "session").collect::<Vec<_>>() });
        // Node's doubles answered `switchProject:ok` and `<path>::caller`; the product answers the folder it stored.
        for call in want["calls"].as_array_mut().unwrap() {
            if let Some(text) = call["outcome"]["ok"].as_str() {
                call["outcome"]["ok"] = json!(text.replace("switchProject:ok", "<dir>").replace("<dir>::caller", "<dir>"));
            }
        }
        if let Some(switches) = case["recorded"].get("switches") {
            // Node's workspace switch got the resolved directory (and its own-turn flag, which the held turn stands for); the
            // product's is the folder the Lead's header stored.
            got["switches"] = json!(stored);
            want["switches"] = json!(switches.as_array().unwrap().iter().map(|s| s[0].clone()).collect::<Vec<_>>());
        }
        if let Some(pending) = case["recorded"].get("pending") {
            got["pending"] = completed_turn_compacts(&directory, &rig, "sess-1").await;
            want["pending"] = pending.clone();
        }
        if let Some(want_live) = case["recorded"].get("live") {
            got["live"] = live.clone().expect("a call");
            want["live"] = want_live.clone();
        }
        if let Some(forks) = case["recorded"].get("forks") {
            got["forks"] = json!(forks_made(&threads, &rig, &copies).await);
            want["forks"] = json!(forks.as_array().unwrap().iter().map(|f| json!([f[0], f[1]["compact"]])).collect::<Vec<_>>());
        }
        if let Some(touched) = case["recorded"].get("touched") {
            got["touched"] = json!(stored);
            want["touched"] = touched.clone();
        }
        if let Some(turn) = turn {
            turn.notify_one();
        }
        let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap();
        assert!(got == want, "{}\n--- core\n{}\n--- node\n{}", case["case"], pretty(&got), pretty(&want));
    }
}
