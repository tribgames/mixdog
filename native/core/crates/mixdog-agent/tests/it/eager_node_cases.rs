//! Node's eager-dispatch cases (`fixtures/eager-dispatch-cases`, `record-eager-dispatch-cases.mjs`), each driven
//! through `Run::run`: the test's calls arrive in one assistant turn, their tools record what started and ended and
//! block where the test's do, and the replay checks the same points Node's recording took (a point is reached when
//! nothing more happens); the batch and repeat cases compare every tool answer.

use tokio::sync::watch;

use super::*;

type Label = Box<dyn Fn(&str, &JsonValue) -> String + Send + Sync>;

/// A test tool: records `start` (and `end` when given) and, for the calls `gated` picks, waits for its gate first.
struct Gated {
    spec: ToolSpec,
    events: Arc<Mutex<Vec<String>>>,
    start: Label,
    end: Option<Label>,
    gated: Box<dyn Fn(&JsonValue) -> bool + Send + Sync>,
    open: watch::Receiver<bool>,
}

#[async_trait]
impl Tool for Gated {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let name = self.spec.name.as_str();
        self.events.lock().unwrap().push((self.start)(name, &args));
        if (self.gated)(&args) {
            let _ = self.open.clone().wait_for(|open| *open).await;
        }
        if let Some(end) = &self.end {
            self.events.lock().unwrap().push(end(name, &args));
        }
        Ok(ToolOutput { parts: vec![ToolPart::Text("ok".into())], ..ToolOutput::default() })
    }
}

/// `probe`: every call fails as Node's executor that throws `missing` is answered.
struct Probe(ToolSpec);

#[async_trait]
impl Tool for Probe {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Err(ToolError::new(ToolErrorCode::Failed { reason: "missing".into() }, "Error: missing"))
    }
}

fn tool_spec(name: &str) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: name.into(),
        input_schema: json!({"type": "object"}),
        annotations: ToolAnnotations::default(),
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }
}

/// One turn with the case's calls, then a final answer.
fn calls_turn(calls: &JsonValue) -> Vec<Attempt> {
    let mut steps: Vec<Step> = calls
        .as_array()
        .unwrap()
        .iter()
        .map(|c| call(c["id"].as_str().unwrap(), c["name"].as_str().unwrap(), c["arguments"].clone()))
        .collect();
    steps.push(done(StopReason::ToolUse));
    vec![turn(steps), turn(vec![text("done"), done(StopReason::EndTurn)])]
}

/// What the tools recorded once nothing more happens (Node's `setImmediate` point).
async fn quiet(events: &Mutex<Vec<String>>, sorted: bool) -> Vec<String> {
    let mut last = events.lock().unwrap().clone();
    let mut still = 0;
    for _ in 0..250 {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let now = events.lock().unwrap().clone();
        if now == last {
            still += 1;
            if still == 10 {
                break;
            }
        } else {
            (last, still) = (now, 0);
        }
    }
    if sorted {
        last.sort();
    }
    last
}

fn answered(output: &RunOutput) -> Vec<JsonValue> {
    output
        .transcript
        .iter()
        .filter(|m| m.role() == mixdog_core_api::domain::provider::Role::Tool)
        .map(|m| json!({"toolCallId": m.tool_call_id(), "toolKind": m.tool_kind.map(kind_name), "content": m.text()}))
        .collect()
}

/// Replays a case whose tools block: the checkpoints the run reaches as the case releases its gates in Node's order.
async fn replay_gated(case: &JsonValue) -> JsonValue {
    let events = Arc::new(Mutex::new(Vec::new()));
    let kind = case["kind"].as_str().unwrap();
    let mut gates: Vec<(String, watch::Sender<bool>)> = Vec::new();
    let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
    let mut names: Vec<&str> =
        case["calls"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    names.dedup();
    for name in names {
        let (open_tx, open) = watch::channel(false);
        let owned = name.to_owned();
        let (start, end, gated, released): (Label, Option<Label>, Box<dyn Fn(&JsonValue) -> bool + Send + Sync>, &str) =
            match kind {
                "order" => (
                    Box::new(|name, _| format!("{name}:start")),
                    Some(Box::new(|name, _| format!("{name}:end"))),
                    Box::new(move |_| owned != "shell"),
                    name,
                ),
                "edits" => (
                    Box::new(|_, a| format!("start:{}#{}", a["file_path"].as_str().unwrap(), a["old_string"].as_str().unwrap())),
                    Some(Box::new(|_, a| format!("end:{}#{}", a["file_path"].as_str().unwrap(), a["old_string"].as_str().unwrap()))),
                    Box::new(|a| a["old_string"] == "a1"),
                    "e1",
                ),
                "computer" => (
                    Box::new(|name, a| format!("{name}:{}", a["value"])),
                    None,
                    Box::new(move |_| owned == "computer"),
                    "computer-1",
                ),
                other => panic!("kind {other}"),
            };
        gates.push((released.to_owned(), open_tx));
        tools.push(Arc::new(Gated { spec: tool_spec(name), events: events.clone(), start, end, gated, open }));
    }
    let sorted = kind == "computer";
    let h = Harness::new(calls_turn(&case["calls"]));
    let run = tokio::spawn(finish(h.run(config(), tools, vec![AgentMessage::user("go")])));
    let mut checkpoints = Vec::new();
    let marks: Vec<JsonValue> = case["checkpoints"].as_array().unwrap().iter().map(|c| c["released"].clone()).collect();
    for (i, released) in marks.iter().enumerate() {
        if let Some(released) = released.as_str() {
            for (name, gate) in &gates {
                if name == released {
                    gate.send_replace(true);
                }
            }
        }
        if i + 1 == marks.len() {
            run.await.unwrap();
            let mut all = events.lock().unwrap().clone();
            if sorted {
                all.sort();
            }
            checkpoints.push(json!({"released": released, "events": all}));
            break;
        }
        checkpoints.push(json!({"released": released, "events": quiet(&events, sorted).await}));
    }
    // A run waiting on a gate the case never opens stays open; drop it with the test.
    for (_, gate) in gates {
        gate.send_replace(true);
    }
    JsonValue::Array(checkpoints)
}

async fn replay_batch(case: &JsonValue) -> JsonValue {
    let events = Arc::new(Mutex::new(Vec::new()));
    let (_open_tx, open) = watch::channel(true);
    let tool: Arc<dyn Tool> = Arc::new(Gated {
        spec: tool_spec("computer"),
        events: events.clone(),
        start: Box::new(|name, a| format!("{name}:{}", a["value"])),
        end: None,
        gated: Box::new(|_| false),
        open,
    });
    let h = Harness::new(calls_turn(&case["calls"]));
    let output = finish(h.run(config(), vec![tool], vec![AgentMessage::user("go")])).await;
    let executed = events.lock().unwrap().clone();
    json!({"executed": executed, "answered": answered(&output)})
}

async fn replay_repeat(case: &JsonValue) -> JsonValue {
    let mut turns = Vec::new();
    let h0 = Harness::new(Vec::new());
    let cwd = h0.tool_env().cwd.as_path().display().to_string();
    let cwd = cwd.trim_end_matches(['\\', '/']).to_owned();
    for entry in case["script"].as_array().unwrap() {
        let mut steps = Vec::new();
        let content = entry["content"].as_str().unwrap();
        if !content.is_empty() {
            steps.push(text(content));
        }
        let calls = entry["toolCalls"].as_array().unwrap();
        for c in calls {
            let mut args = c["arguments"].clone();
            args["file_path"] = json!(args["file_path"].as_str().unwrap().replace("<cwd>", &cwd));
            steps.push(call(c["id"].as_str().unwrap(), c["name"].as_str().unwrap(), args));
        }
        steps.push(done(if calls.is_empty() { StopReason::EndTurn } else { StopReason::ToolUse }));
        turns.push(turn(steps));
    }
    let h = Harness::new(turns);
    let output = finish(h.run(config(), vec![Arc::new(Probe(tool_spec("probe")))], vec![AgentMessage::user("go")])).await;
    let answered: Vec<JsonValue> = answered(&output)
        .into_iter()
        .map(|mut m| {
            m["content"] = json!(m["content"].as_str().unwrap().replace(&cwd, "<cwd>"));
            m
        })
        .collect();
    json!({"content": output.response.content, "answered": answered})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_eager_dispatch_case_is_nodes_whole_outcome() {
    let path = golden_dir().join("../eager-dispatch-cases/golden.json");
    let golden: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        let (got, want) = match case["kind"].as_str().unwrap() {
            "batch" => (replay_batch(case).await, case["recorded"].clone()),
            "repeat" => (replay_repeat(case).await, case["recorded"].clone()),
            _ => (replay_gated(case).await, case["checkpoints"].clone()),
        };
        if got != want {
            failures.push(format!("{name}:\n  want {want}\n  got  {got}"));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
