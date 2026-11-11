//! Node's `session` tool Project and worktree cases (`fixtures/session-tool-project-cases`,
//! `record-session-tool-project-cases.mjs`): each recorded call through the `SessionTool` over the
//! `DirectorySessionPort`, the whole outcome (the tool's text or its error message) against Node's.
//! The thread is `sess-1` in `C:/work` with an empty header and an empty Project registry, as the test's
//! harness runtime is; the test's workspace switch answers `switchProject:ok`, so this port's thread
//! answers the `thread/setCwd` request by storing that as the thread's cwd.

use mixdog_tools::orch::session::SessionTool;

use super::*;

fn golden() -> Value {
    #[allow(clippy::disallowed_methods)] // the recording, read at run time
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/session-tool-project-cases/golden.json")).expect("the recording");
    serde_json::from_str(&text).expect("json")
}

/// The test's workspace switch: records the switch and answers `switchProject:ok`.
struct Switch {
    threads: Arc<Threads>,
    calls: Mutex<Vec<Value>>,
}

#[async_trait]
impl ThreadRequests for Switch {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        self.calls.lock().expect("calls").push(json!([method, params["path"]]));
        let set = Map::from_iter([("cwd".to_owned(), json!("switchProject:ok"))]);
        self.threads.patch_header(thread, set, Vec::new()).await.expect("the thread");
        Ok(Value::Null)
    }
    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        Ok(false)
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
        for id in ["sess-1", "worker-1"] {
            threads.0.lock().expect("threads").insert(id.to_owned(), Map::new());
        }
        let switch = Arc::new(Switch { threads: threads.clone(), calls: Mutex::default() });
        let marks = HeartbeatSessions::new();
        let runs = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let callers = Arc::new(ThreadCallers::new(threads.clone(), marks, runs));
        let port = DirectorySessionPort::new(SessionPortParts {
            callers: callers.clone(),
            threads: threads.clone(),
            requests: switch.clone(),
            titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(threads.clone(), Arc::new(Messages), Arc::new(Now))),
            ai_titles: Arc::new(Titles(true)),
            projects: Arc::new(NoProjects),
            bots: Arc::new(Bots(Vec::new())),
            suggestions: Arc::new(Suggested::default()),
            io: mixdog_rt::testing::tokens().interactive_io,
        });
        let tool = SessionTool::new(Arc::new(port), callers);
        let mut calls = Vec::new();
        for call in case["recorded"]["calls"].as_array().unwrap() {
            // Named in the manifest: Node's executor answering for a tool the core does not have.
            if call["tool"] != "session" {
                continue;
            }
            let args: Value = serde_json::from_str(&call["args"].to_string().replace("<dir>", &shown_dir.replace('\\', "\\\\"))).unwrap();
            let caller = call["context"]["callerSessionId"].as_str().unwrap_or("sess-1");
            let surface = if caller == "worker-1" { SurfaceKind::Agent } else { SurfaceKind::Lead };
            let outcome = match tool.call(&call_ctx(caller, surface), args).await {
                Ok(output) => {
                    let text: String = output.parts.iter().filter_map(|part| if let ToolPart::Text(text) = part { Some(text.as_str()) } else { None }).collect();
                    json!({ "ok": text.replace(&shown_dir.replace('\\', "\\\\"), "<dir>").replace(&shown_dir, "<dir>") })
                }
                Err(error) => json!({ "error": error.message_for_model.replace(&shown_dir, "<dir>") }),
            };
            calls.push(json!({ "label": call["label"], "tool": call["tool"], "args": call["args"], "context": call["context"], "outcome": outcome }));
        }
        let mut got = json!({ "calls": calls });
        let mut want = json!({ "calls": case["recorded"]["calls"].as_array().unwrap().iter().filter(|c| c["tool"] == "session").collect::<Vec<_>>() });
        if let Some(switches) = case["recorded"].get("switches") {
            // Node's switch got the resolved directory and its own-turn flag; the core's thread request carries the directory.
            got["switches"] = json!(switch.calls.lock().expect("calls").iter().map(|c| c[1].as_str().unwrap().replace(&shown_dir, "<dir>")).collect::<Vec<_>>());
            want["switches"] = json!(switches.as_array().unwrap().iter().map(|s| s[0].clone()).collect::<Vec<_>>());
        }
        if let Some(touched) = case["recorded"].get("touched") {
            got["touched"] = json!(switch.calls.lock().expect("calls").clone());
            want["touched"] = touched.clone();
        }
        let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap();
        assert!(got == want, "{}\n--- core\n{}\n--- node\n{}", case["case"], pretty(&got), pretty(&want));
    }
}
