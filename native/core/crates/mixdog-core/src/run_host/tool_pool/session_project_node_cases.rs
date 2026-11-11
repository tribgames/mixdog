//! Node's `session` tool Project and worktree cases (`fixtures/session-tool-project-cases`,
//! `record-session-tool-project-cases.mjs`): each recorded call through the `SessionTool` over the
//! `DirectorySessionPort`, the whole outcome (the tool's text or its error message) against Node's.
//! The thread is `sess-1` in `C:/work` with an empty header and an empty Project registry, as the test's
//! harness runtime is; the test's workspace switch answers `switchProject:ok`, so this port's thread
//! answers the `thread/setCwd` request by storing that as the thread's cwd.

use mixdog_tools::orch::session::SessionTool;

use super::*;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/session-tool-project-cases/golden.json")).expect("json")
}

/// The test's workspace switch: records the switch and answers `switchProject:ok`. Its lifecycle API
/// (`inheritToNewSession`): a fork answers the copy `new-1`, and its compaction a changed summary.
struct Switch {
    threads: Arc<Threads>,
    calls: Mutex<Vec<Value>>,
    /// The threads a `session compact` marked.
    pending: Mutex<Vec<String>>,
    /// Per fork: the source thread and whether its copy was compacted.
    forks: Mutex<Vec<Value>>,
}

#[async_trait]
impl ThreadRequests for Switch {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        if method == "thread/fork" {
            self.threads.0.lock().expect("threads").insert("new-1".to_owned(), Map::new());
            self.forks.lock().expect("forks").push(json!([thread.as_str(), false]));
            return Ok(json!({ "thread": { "id": "new-1" } }));
        }
        if method == "thread/compact/start" && params.get("options").is_none() {
            assert_eq!(thread.as_str(), "new-1", "the copy is compacted, never the source");
            self.forks.lock().expect("forks").last_mut().expect("a fork")[1] = json!(true);
            return Ok(json!({ "changed": true }));
        }
        if method == "thread/compact/start" {
            // The thread's actor marks itself (`pendingCompactSessionIds`); its run is the actor's own test.
            assert_eq!(params["options"], json!({ "afterTurn": true }), "a compaction after the turn");
            self.pending.lock().expect("pending").push(thread.as_str().to_owned());
            return Ok(Value::Null);
        }
        self.calls.lock().expect("calls").push(json!([method, params["path"]]));
        let set = Map::from_iter([("cwd".to_owned(), json!("switchProject:ok"))]);
        self.threads.patch_header(thread, set, Vec::new()).await.expect("the thread");
        Ok(Value::Null)
    }
    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        Ok(false)
    }
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
    threads: Arc<Threads>,
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

fn call_ctx(thread: &str, surface: SurfaceKind) -> ToolContext {
    ToolContext { thread_id: ThreadId::from(thread), surface, cwd: AbsPath::new(std::path::PathBuf::from("C:/work")).expect("absolute"), tool: "session".into(), ..ctx() }
}

#[tokio::test]
async fn every_recorded_session_project_call_answers_as_in_node() {
    let golden = golden();
    let dir = tempfile::tempdir().expect("dir");
    let shown_dir = dir.path().to_string_lossy().into_owned();
    for case in golden["cases"].as_array().unwrap() {
        let threads = Arc::new(Threads::default());
        for id in ["sess-1", "worker-1", "w"] {
            threads.0.lock().expect("threads").insert(id.to_owned(), Map::new());
        }
        // The runtime session's fields the case set (`rt.session.title`, its route).
        if let Some(session) = case["recorded"]["session"].as_object() {
            threads.0.lock().expect("threads").insert("sess-1".to_owned(), session.clone());
        }
        // The session store the test's session manager holds, as the thread's stored header.
        if let Some(store) = case["recorded"]["store"].as_object() {
            threads.0.lock().expect("threads").insert("sess-1".to_owned(), store.clone());
        }
        let racing: Arc<dyn ThreadState> = Arc::new(Racing { threads: threads.clone(), armed: case["recorded"]["store"]["title"] == "old" });
        let titles_on = Arc::new(Toggle(std::sync::atomic::AtomicBool::new(true)));
        let switch = Arc::new(Switch { threads: threads.clone(), calls: Mutex::default(), pending: Mutex::default(), forks: Mutex::default() });
        let marks = HeartbeatSessions::new();
        let runs = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let callers = Arc::new(ThreadCallers::new(threads.clone(), marks, runs));
        let port = DirectorySessionPort::new(SessionPortParts {
            callers: callers.clone(),
            threads: racing.clone(),
            requests: switch.clone(),
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
            calls.push(json!({ "label": call["label"], "tool": call["tool"], "args": call["args"], "context": call["context"], "outcome": outcome }));
            // The live session's title after the case's first call (`rt.session.title`/`titleSource`).
            if live.is_none() {
                let header = threads.header(&ThreadId::from("sess-1")).await.expect("the thread");
                live = Some(json!({ "title": header.get("title").cloned().unwrap_or(Value::Null), "titleSource": header.get("titleSource").cloned().unwrap_or(Value::Null) }));
            }
        }
        let mut got = json!({ "calls": calls });
        let mut want = json!({ "calls": case["recorded"]["calls"].as_array().unwrap().iter().filter(|c| c["tool"] == "session").collect::<Vec<_>>() });
        if let Some(switches) = case["recorded"].get("switches") {
            // Node's switch got the resolved directory and its own-turn flag; the core's thread request carries the directory.
            got["switches"] = json!(switch.calls.lock().expect("calls").iter().map(|c| c[1].as_str().unwrap().replace(&shown_dir, "<dir>")).collect::<Vec<_>>());
            want["switches"] = json!(switches.as_array().unwrap().iter().map(|s| s[0].clone()).collect::<Vec<_>>());
        }
        if let Some(pending) = case["recorded"].get("pending") {
            got["pending"] = json!(*switch.pending.lock().expect("pending"));
            want["pending"] = pending.clone();
        }
        if let Some(want_live) = case["recorded"].get("live") {
            got["live"] = live.clone().expect("a call");
            want["live"] = want_live.clone();
        }
        if let Some(forks) = case["recorded"].get("forks") {
            got["forks"] = json!(*switch.forks.lock().expect("forks"));
            want["forks"] = json!(forks.as_array().unwrap().iter().map(|f| json!([f[0], f[1]["compact"]])).collect::<Vec<_>>());
        }
        if let Some(touched) = case["recorded"].get("touched") {
            got["touched"] = json!(switch.calls.lock().expect("calls").clone());
            want["touched"] = touched.clone();
        }
        let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap();
        assert!(got == want, "{}\n--- core\n{}\n--- node\n{}", case["case"], pretty(&got), pretty(&want));
    }
}
