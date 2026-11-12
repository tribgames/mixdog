//! Node's agent-loop cases (`fixtures/agent-loop-cases`, `record-agent-loop-cases.mjs`): each case's provider script
//! driven through `Run::run` with the case's options, its whole outcome against Node's (transcript, result or error and
//! carried report, the requests the loop built, what reached the case's callbacks).

use mixdog_agent::cancel::Cancel;
use mixdog_agent::todo::TodoGuards;
use mixdog_agent::todo::TodoView;
use mixdog_tools::state::todo as todos;

use super::*;

/// The session actor's todo list, as the `todo` tool and the turn guards both see it.
#[derive(Default)]
struct Todos(Mutex<todos::TodoList>);

impl Todos {
    fn apply(&self, args: JsonValue) {
        let mut list = self.0.lock().unwrap();
        match todos::run(&list, &args, 0).unwrap() {
            todos::TodoRun::Commit { list: next, .. } => *list = next,
            todos::TodoRun::View(_) => panic!("not an edit"),
        }
    }
}

#[async_trait]
impl todos::TodoStore for Todos {
    async fn read(&self, _thread: &ThreadId) -> todos::TodoList {
        self.0.lock().unwrap().clone()
    }

    async fn update(&self, _thread: &ThreadId, f: &mut todos::TodoEdit<'_>) -> Result<(), String> {
        let mut list = self.0.lock().unwrap();
        *list = f(&list)?;
        Ok(())
    }

    fn note_user_wait(&self, _thread: &ThreadId) {}

    fn user_waiting(&self, _thread: &ThreadId) -> bool {
        false
    }

    fn turn_started(&self, _thread: &ThreadId) {}
}

#[async_trait]
impl TodoView for Todos {
    async fn phases(&self) -> Vec<mixdog_agent::todo::TodoPhase> {
        use mixdog_agent::todo::TodoStatus as S;
        self.0
            .lock()
            .unwrap()
            .phases
            .iter()
            .map(|p| mixdog_agent::todo::TodoPhase {
                tasks: p
                    .tasks
                    .iter()
                    .map(|t| mixdog_agent::todo::TodoTask {
                        content: t.content.clone(),
                        status: match t.status {
                            todos::TodoStatus::Pending => S::Pending,
                            todos::TodoStatus::InProgress => S::InProgress,
                            todos::TodoStatus::Completed => S::Completed,
                            todos::TodoStatus::Abandoned => S::Abandoned,
                        },
                    })
                    .collect(),
            })
            .collect()
    }
    async fn goal_active(&self) -> bool {
        false
    }
    async fn awaiting_background_work(&self) -> bool {
        false
    }
    async fn user_waiting(&self) -> bool {
        false
    }
    fn is_mutation(&self, _call: &ToolCall) -> bool {
        false
    }
    async fn genuine_prompt(&self) {}
}

/// The case's provider: each send answers the script entry the test's provider answers, with its side effects.
struct CaseProvider {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    script: Vec<JsonValue>,
    repeat_last: bool,
    sends: Mutex<usize>,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
    todos: Option<Arc<Todos>>,
    signal: Cancel,
    /// `steerOnSend`: the message the user sends while that send streams.
    steer_on_send: JsonValue,
    pending: Arc<Mutex<Vec<(String, String)>>>,
}

#[async_trait]
impl ProviderAdapter for CaseProvider {
    fn release_send(&self, _group: &str) {}
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
        self.requests.lock().unwrap().push(request);
        let entry = {
            let mut sends = self.sends.lock().unwrap();
            *sends += 1;
            let index = if self.repeat_last { (*sends).min(self.script.len()) - 1 } else { *sends - 1 };
            self.script.get(index).unwrap_or_else(|| panic!("script exhausted at send {sends}")).clone()
        };
        if let Some(item) = entry["todoDone"].as_str() {
            self.todos.as_ref().unwrap().apply(json!({"op": "done", "item": item}));
        }
        if entry["abort"] == true {
            match entry["abortReason"].as_str() {
                Some(reason) => self.signal.abort(reason),
                None => self.signal.abort_default(),
            }
        }
        if let Some(thrown) = entry.get("throw") {
            let incomplete = thrown["incomplete"] == true;
            let mut error = ProviderError::new(if incomplete { ErrorKind::Transient } else { ErrorKind::Unknown }, DeliveryState::Accepted);
            error.message = thrown["message"].as_str().unwrap().to_owned();
            if incomplete {
                error.code = Some("PROVIDER_INCOMPLETE".into());
            }
            return Err(error);
        }
        let mut steps = Vec::new();
        let content = entry["content"].as_str().unwrap_or("");
        if !content.is_empty() {
            steps.push(text(content));
        }
        let calls = entry["toolCalls"].as_array().cloned().unwrap_or_default();
        for c in &calls {
            steps.push(call(c["id"].as_str().unwrap(), c["name"].as_str().unwrap(), c["arguments"].clone()));
        }
        if self.steer_on_send.get("send").and_then(JsonValue::as_u64) == Some(*self.sends.lock().unwrap() as u64) {
            let entry = &self.steer_on_send["entry"];
            self.pending.lock().unwrap().push((entry["id"].as_str().unwrap().to_owned(), entry["content"].as_str().unwrap().to_owned()));
        }
        let stop = match entry["stopReason"].as_str() {
            Some(stop) => stop_of(stop),
            None if entry["endTurn"] == false => StopReason::ContinueTurn,
            None if calls.is_empty() => StopReason::EndTurn,
            None => StopReason::ToolUse,
        };
        steps.push(done(stop));
        Ok(Box::new(ScriptedStream(steps.into(), None)))
    }
    async fn settle_send(&self, _group: &str, _end: mixdog_core_api::domain::provider::SendEnd) {}
}

/// What reached the case's callbacks.
struct CaseObserver {
    retract: Option<Retracted>,
    deltas: Mutex<Vec<String>>,
    resets: Mutex<Vec<JsonValue>>,
    texts: Mutex<Vec<String>>,
}

impl RunObserver for CaseObserver {
    fn event(&self, event: RunEvent) {
        match event {
            RunEvent::TextDelta(t) => self.deltas.lock().unwrap().push(t),
            RunEvent::AssistantText { text, .. } => self.texts.lock().unwrap().push(text),
            _ => {}
        }
    }
    fn can_retract(&self) -> bool {
        self.retract.is_some()
    }
    fn retract_text(&self, retraction: TextRetraction) -> Retracted {
        // No `onTextReset`: Node keeps the text and records nothing.
        let Some(answer) = self.retract else { return Retracted::Refused };
        let reason = match retraction.reason {
            RetractReason::OutputLimitEscalation => "output-limit-escalation",
            RetractReason::TransportRetraction => "transport-retraction",
        };
        self.resets.lock().unwrap().push(json!({"chars": retraction.chars, "reason": reason}));
        answer
    }
}

/// The test's pre-send queue: taken whole at the first pre-send drain; and the host queue a
/// `steerOnSend` message waits in, taken at whichever drain comes next.
struct CaseSteer {
    queue: Mutex<Vec<String>>,
    drained: Mutex<Vec<String>>,
    pending: Arc<Mutex<Vec<(String, String)>>>,
}

#[async_trait]
impl SteerSource for CaseSteer {
    async fn drain(&self, request: DrainRequest) -> Vec<SteerEntry> {
        let sent: Vec<(String, String)> = self.pending.lock().unwrap().drain(..).collect();
        if !sent.is_empty() {
            self.drained.lock().unwrap().push(request.stage.label().into());
            return sent
                .into_iter()
                .map(|(id, text)| SteerEntry {
                    content: Content::Text(text),
                    text: None,
                    ids: vec![id],
                    submitted_at: None,
                    message_id: None,
                    mode: SteerMode::Prompt,
                    execution: None,
                })
                .collect();
        }
        let mut queue = self.queue.lock().unwrap();
        if request.stage != DrainStage::PreSend || queue.is_empty() {
            return Vec::new();
        }
        self.drained.lock().unwrap().push("pre-send".into());
        queue
            .drain(..)
            .map(|text| SteerEntry {
                content: Content::Text(text),
                text: None,
                ids: Vec::new(),
                submitted_at: None,
                message_id: None,
                mode: SteerMode::Prompt,
                execution: None,
            })
            .collect()
    }
}

/// The test's `onToolResult` rewrite of a tool result's text.
struct Rewrite(String);

#[async_trait]
impl ToolHooks for Rewrite {
    async fn after_tool(&self, _call: &GateCall, _result: &str) -> Option<String> {
        Some(self.0.clone())
    }
}

/// The test's internal `lookup` tool: `Found item <item>.`.
struct Lookup(ToolSpec);

#[async_trait]
impl Tool for Lookup {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let text = format!("Found item {}.", args["item"]);
        Ok(ToolOutput { parts: vec![ToolPart::Text(text)], ..ToolOutput::default() })
    }
}

fn spec(name: &str) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: name.into(),
        input_schema: json!({"type": "object"}),
        annotations: ToolAnnotations::default(),
        parallel_safe: false,
        exclusive_with: Vec::new(),
    }
}

fn history(messages: &JsonValue) -> Vec<AgentMessage> {
    messages
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let content = m["content"].as_str().unwrap();
            match m["role"].as_str().unwrap() {
                "user" => AgentMessage::user(content),
                "assistant" => AgentMessage::assistant(
                    content,
                    m["toolCalls"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|c| ToolCall {
                            id: c["id"].as_str().unwrap().into(),
                            name: c["name"].as_str().unwrap().into(),
                            arguments: c["arguments"].clone(),
                            native_type: None,
                        })
                        .collect(),
                ),
                "tool" => {
                    let mut message = AgentMessage::tool_text(m["toolCallId"].as_str().unwrap(), content, ToolKind::Normal);
                    message.tool_kind = None;
                    message
                }
                other => panic!("role {other}"),
            }
        })
        .collect()
}

fn request_json(r: &ModelRequest) -> JsonValue {
    json!({
        "override": r.options.max_output_tokens_override,
        "toolChoice": r.options.tool_choice,
        "messages": r.messages.iter().map(|m| json!({
            "role": format!("{:?}", m.role).to_lowercase(),
            "content": match &m.content { Content::Text(t) => t.clone(), Content::Parts(_) => String::new() },
            "toolCallId": m.tool_call_id,
        })).collect::<Vec<_>>(),
    })
}

fn result_json(output: &RunOutput) -> JsonValue {
    json!({
        "content": output.response.content,
        "historyContent": output.response.history_content,
        "reportContent": output.response.report_content,
        "terminationReason": output.termination.map(|t| format!("{t:?}").to_lowercase()),
        "iterations": output.iterations,
        "toolCallsTotal": output.tool_calls_total,
        "maxOutputRecoveryAttempts": output.response.max_output_recovery_attempts,
        "providerContinuations": output.provider_continuations,
    })
}

/// Replays one case: every run of it on one provider, as the test asks them.
async fn replay(case: &JsonValue, hidden_name: &str) -> JsonValue {
    let h = Harness::new(Vec::new());
    let todo_list = case.get("todo").map(|items| {
        let list = Arc::new(Todos::default());
        list.apply(json!({"op": "init", "items": items}));
        list
    });
    let signal = Cancel::from_token(&h.cancel);
    let provider = Arc::new(CaseProvider {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: case["script"].as_array().unwrap().clone(),
        repeat_last: case["repeatLast"] == true,
        sends: Mutex::new(0),
        requests: Mutex::new(Vec::new()),
        todos: todo_list.clone(),
        signal: signal.clone(),
        steer_on_send: case.get("steerOnSend").cloned().unwrap_or(JsonValue::Null),
        pending: Arc::new(Mutex::new(Vec::new())),
    });
    let hidden = case["session"]["agent"] == "<hidden>";
    let _ = hidden_name;
    let runs: Vec<JsonValue> = match case.get("runs") {
        Some(runs) => runs.as_array().unwrap().iter().map(|r| r["messages"].clone()).collect(),
        None => vec![case["messages"].clone()],
    };
    let mut outs = Vec::new();
    for messages in runs {
        let observer = Arc::new(CaseObserver {
            retract: match case["textReset"].as_str() {
                Some("withdraw") => Some(Retracted::Withdrawn),
                Some("refuse") => Some(Retracted::Refused),
                _ => None,
            },
            deltas: Mutex::new(Vec::new()),
            resets: Mutex::new(Vec::new()),
            texts: Mutex::new(Vec::new()),
        });
        let steer = Arc::new(CaseSteer {
            queue: Mutex::new(
                case["steer"]["pre-send"].as_array().into_iter().flatten().map(|s| s.as_str().unwrap().to_owned()).collect(),
            ),
            drained: Mutex::new(Vec::new()),
            pending: provider.pending.clone(),
        });
        let sink = Arc::new(Sink::default());
        let mut env = h.run_env();
        env.observer = observer.clone();
        env.steer = steer.clone();
        env.sink = sink.clone();
        if let Some(list) = &todo_list {
            let guards = TodoGuards::new(list.clone(), hidden);
            guards.start_turn(true).await;
            env.guards = Arc::new(guards);
        }
        if let Some(rewrite) = case.get("rewrite") {
            env.hooks = Some(Arc::new(Rewrite(rewrite["content"].as_str().unwrap().to_owned())));
        }
        let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
        // `lookup-found` passes `async () => 'Found.'` where Node takes no executor: its `lookup` stays unknown.
        if case["tools"].as_array().into_iter().flatten().any(|name| name == "lookup") {
            tools.push(Arc::new(Lookup(spec("lookup"))));
        }
        let calls_read = case["script"].as_array().unwrap().iter().any(|entry| {
            entry["toolCalls"].as_array().into_iter().flatten().any(|c| c["name"] == "read")
        });
        if calls_read {
            tools.push(Arc::new(mixdog_tools::fs::ReadTool::new(None, None)));
        }
        if let Some(list) = &todo_list {
            tools.push(Arc::new(todos::TodoTool::new(list.clone())));
        }
        let names = tools.iter().map(|t| t.spec().name.clone()).collect();
        let mut cfg = config();
        cfg.model = "fake-model".into();
        cfg.hidden_agent = hidden;
        cfg.agent_mode = case["session"]["owner"] == "agent";
        cfg.signal = Some(signal.clone());
        cfg.escalated_max_output_tokens = case["escalated"].as_u64().map(|v| v as u32);
        if let Some(limits) = case.get("limits") {
            cfg.limits = Some(TurnLimits {
                max_tool_calls: limits["maxToolCalls"].as_u64(),
                wrap_up_at_ms: limits["wrapUpOffsetMs"].as_i64().map(|offset| h.clock.now_ms() + offset),
                ..TurnLimits::default()
            });
        }
        let run = Run::new(
            env,
            h.cancel.clone(),
            provider.clone(),
            ToolSet::with_builtins(tools, names),
            h.tool_env(),
            cfg,
            history(&messages),
            RunCarry::default(),
        );
        let mut out = serde_json::Map::new();
        let transcript = match run.run().await {
            Ok(output) => {
                out.insert("result".into(), result_json(&output));
                output.transcript
            }
            Err(failure) => {
                let carried = (!failure.carried_report.is_empty()).then(|| failure.carried_report.clone());
                out.insert("error".into(), json!({"message": failure.error.to_string(), "carriedReport": carried}));
                failure.transcript
            }
        };
        out.insert("messages".into(), transcript.iter().map(normalized).collect());
        let mut lists: Vec<(&str, Vec<JsonValue>)> = Vec::new();
        if case["textDelta"] == true {
            lists.push(("deltas", observer.deltas.lock().unwrap().iter().map(|d| json!(d)).collect()));
        }
        lists.push(("resets", observer.resets.lock().unwrap().clone()));
        if case["watchAssistant"] == true {
            lists.push(("assistantTexts", observer.texts.lock().unwrap().iter().map(|t| json!(t)).collect()));
            let committed = sink.committed.lock().unwrap();
            lists.push((
                "committed",
                committed.iter().filter(|m| m.role() == mixdog_core_api::domain::provider::Role::Assistant).map(normalized).collect(),
            ));
        }
        lists.push(("drained", steer.drained.lock().unwrap().iter().map(|d| json!(d)).collect()));
        lists.push((
            "submissionIds",
            transcript.iter().filter(|m| !m.submission_ids.is_empty()).map(|m| json!(m.submission_ids)).collect(),
        ));
        for (key, list) in lists {
            if !list.is_empty() {
                out.insert(key.into(), JsonValue::Array(list));
            }
        }
        outs.push(JsonValue::Object(out));
    }
    let requests: Vec<JsonValue> = provider.requests.lock().unwrap().iter().map(|r| request_json(r)).collect();
    json!({"runs": outs, "requests": requests})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_agent_loop_case_is_nodes_whole_outcome() {
    let path = golden_dir().join("../agent-loop-cases/golden.json");
    let golden: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let hidden = golden["hiddenAgent"].as_str().unwrap();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        let (owned, hidden_owned) = (case.clone(), hidden.to_owned());
        // A case that panics is reported with the rest, not ending the replay.
        let got = match tokio::spawn(async move { replay(&owned, &hidden_owned).await }).await
        {
            Ok(got) => got,
            Err(error) => {
                failures.push(format!("{name}: panicked: {error}"));
                continue;
            }
        };
        if got != case["recorded"] {
            failures.push(format!(
                "{name}:\n  want {}\n  got  {}",
                serde_json::to_string(&case["recorded"]).unwrap().chars().take(6000).collect::<String>(),
                serde_json::to_string(&got).unwrap().chars().take(6000).collect::<String>()
            ));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
