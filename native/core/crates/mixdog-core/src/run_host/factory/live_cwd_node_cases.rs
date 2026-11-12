//! Node's turn after the Lead's own `session set-project` call (`fixtures/switch-project-turn-cases`,
//! `record-switch-project-turn-cases.mjs`): each tool call of the turn starts from the session's live folder
//! (`prepareToolCall`, `call-prep.mjs:69`), not the folder the turn began in. The turn is the composed one
//! (`TurnPath` over the session directory, the scripted provider, the real `list` and `edit` tools over the real file
//! service); the switch is the thread settings service's own `setCallerCwd` over the real workspace host, which the
//! `session` tool calls and answers as Node's handler does. Compared per case: every tool result in order, the session's
//! folder afterwards, the names in each Project folder and the created file's text, against Node's.

use mixdog_core_session::session::thread_settings::ThreadSettings;
use mixdog_core_session::session::thread_state::SessionThreads;

use super::*;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/switch-project-turn-cases/golden.json")).expect("the recording")
}

/// The `session` tool's `set-project`: the settings service's own-turn switch, answered as Node's handler answers it.
struct Switch {
    spec: ToolSpec,
    settings: std::sync::OnceLock<Arc<ThreadSettings>>,
}

#[async_trait]
impl Tool for Switch {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let path = args["path"].as_str().expect("a path");
        let cwd = self.settings.get().expect("bound").set_caller_cwd(&ctx.thread_id, path).await.expect("the switch");
        Ok(ToolOutput { parts: vec![ToolPart::Text(serde_json::to_string_pretty(&json!({ "cwd": cwd, "sessionId": ctx.thread_id.as_str() })).expect("json"))], ..ToolOutput::default() })
    }
}

fn session_spec() -> ToolSpec {
    ToolSpec {
        name: "session".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "session".into(),
        input_schema: json!({ "type": "object", "properties": { "action": { "type": "string" }, "path": { "type": "string" } } }),
        annotations: ToolAnnotations::default(),
        parallel_safe: false,
        exclusive_with: Vec::new(),
    }
}

/// A recorded provider step as the stream it is: the calls it makes, or its reply.
fn step(entry: &Value) -> Vec<StreamEvent> {
    let calls = entry["toolCalls"].as_array().cloned().unwrap_or_default();
    if calls.is_empty() {
        return vec![StreamEvent::TextDelta(entry["reply"].as_str().expect("a reply").into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
    }
    let mut events: Vec<StreamEvent> = calls
        .iter()
        .map(|call| StreamEvent::ToolCallDone(ToolCall { id: call["id"].as_str().expect("id").into(), name: call["name"].as_str().expect("name").into(), arguments: call["arguments"].clone(), native_type: None }))
        .collect();
    events.push(StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None });
    events
}

fn names(dir: &std::path::Path) -> Vec<String> {
    #[allow(clippy::disallowed_methods)] // the folders the replay itself made
    let mut names: Vec<String> = std::fs::read_dir(dir).expect("a folder").map(|entry| entry.expect("an entry").file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_turn_runs_its_calls_in_the_folder_the_session_holds_then() {
    let golden = golden();
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["case"].as_str().expect("name");
        let root = tempfile::tempdir().expect("a folder");
        let shown = root.path().to_string_lossy().replace('\\', "/");
        let (a, b) = (root.path().join("a"), root.path().join("b"));
        #[allow(clippy::disallowed_methods)] // the folders the replay itself makes
        {
            std::fs::create_dir_all(&a).unwrap();
            std::fs::create_dir_all(&b).unwrap();
            std::fs::write(a.join("old.txt"), "in a\n").unwrap();
            std::fs::write(b.join("new.txt"), "in b\n").unwrap();
        }
        let script: Value = serde_json::from_str(&case["script"].to_string().replace("<root>", &shown)).expect("the script");
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script.as_array().expect("steps").iter().map(step).collect()),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let switch = Arc::new(Switch { spec: session_spec(), settings: std::sync::OnceLock::new() });
        let pool: Vec<Arc<dyn Tool>> = vec![switch.clone(), Arc::new(mixdog_tools::fs::ListTool::new()), Arc::new(mixdog_tools::fs::EditTool::new()), named("Skill")];
        let World { rig, directory, .. } = turn_world_with(provider.clone(), pool, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), true).await;
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        let hosted = mixdog_core_session::session::thread_settings_rig::hosted(&directory, threads);
        let built = mixdog_core_session::session::thread_settings_rig::build(directory.clone(), hosted.workspaces.clone(), hosted.worktrees.clone(), Vec::new(), hosted.dir.path().join("task").to_string_lossy().into_owned()).await;
        assert!(switch.settings.set(Arc::new(built.settings)).is_ok());

        // The Lead's thread as it stands once its tool surface is chosen: the header names the tools the turn can call.
        let header = json!({
            "createdAt": 1,
            "sourceType": "lead",
            "provider": "scripted",
            "model": "m",
            "cwd": a,
            "toolSpec": "full",
            "tools": [{ "name": "session" }, { "name": "list" }, { "name": "edit" }],
        })
        .as_object()
        .cloned()
        .expect("a header");
        let id = ThreadId::from("lead");
        directory.create_with_id(id.clone(), header, json!({})).await.expect("the thread");
        let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("opens");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

        let rows = || -> Vec<Value> {
            rig.store
                .records(&id)
                .into_iter()
                .filter_map(|(_, record)| match record {
                    Record::Item(item) => match item.body {
                        Slot::Inline(body) => Some(body),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        };
        let finished = || rows().iter().any(|row| row["role"] == "assistant" && row["content"] == "done");
        eventually_on_awaiting(|| format!("{name}: the turn's final reply `done` in the store"), &[handle.stepped()], || finished().then_some(())).await;

        let hide = |text: &str| text.replace('\\', "/").replace(&shown, "<root>");
        let answered: Vec<Value> = rows()
            .iter()
            .filter(|row| row["role"] == "tool")
            .map(|row| {
                let content = row["content"].as_str().map(str::to_owned).unwrap_or_else(|| row["content"].to_string());
                let content = if row["toolCallId"] == "c1" {
                    // The answer is JSON: its folder is written <root>-relative and its session id is the thread's own.
                    let mut answer: Value = serde_json::from_str(&content).expect("the switch's answer");
                    answer["cwd"] = json!(hide(answer["cwd"].as_str().expect("a folder")));
                    answer["sessionId"] = json!("<session>");
                    serde_json::to_string_pretty(&answer).expect("json")
                } else {
                    hide(&content)
                };
                json!({ "toolCallId": row["toolCallId"], "content": content })
            })
            .collect();
        let live = directory.live_header(&id).header();
        #[allow(clippy::disallowed_methods)] // the file the replay's turn made
        let created = std::fs::read_to_string(b.join("out.txt")).ok();
        let got = json!({
            "reply": "done",
            "toolResults": answered,
            "sessionCwd": hide(live.get("cwd").and_then(Value::as_str).expect("a folder")),
            "files": { "a": names(&a), "b": names(&b) },
            "created": created,
        });
        assert_eq!(got, case["recorded"], "{name}: offered {:?}", lock(&provider.requests).first().map(|request| request.tools.iter().map(|tool| tool.name.clone()).collect::<Vec<_>>()));
    }
}
