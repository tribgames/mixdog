//! Node's tool-call id cases (`fixtures/tool-call-id-cases`, `record-tool-call-id-cases.mjs`), driven through
//! `Run::run`: the case's history is the run's transcript, each round the model asks is one streamed turn of the
//! scripted provider, and the ids the loop gave every round (or, for the reuse case, the last request it built) are
//! compared with Node's.

use super::*;

/// `t`: answers `r`, as the test's history answers.
struct Answer(ToolSpec);

#[async_trait]
impl Tool for Answer {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text("r".into())], ..ToolOutput::default() })
    }
}

fn ids(round: &JsonValue) -> Vec<String> {
    round.as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect()
}

fn round_turn(ids: &[String]) -> Attempt {
    let mut steps: Vec<Step> = ids.iter().map(|id| call(id, "t", json!({}))).collect();
    steps.push(done(StopReason::ToolUse));
    turn(steps)
}

async fn replay_rounds(case: &JsonValue) -> JsonValue {
    let mut history = vec![AgentMessage::user("x")];
    let earlier = case["history"].as_array().unwrap();
    for round in earlier {
        let ids = ids(round);
        let calls = ids
            .iter()
            .map(|id| ToolCall { id: id.clone(), name: "t".into(), arguments: json!({}), native_type: None })
            .collect();
        history.push(AgentMessage::assistant("", calls));
        for id in &ids {
            history.push(AgentMessage::tool_text(id, "r", ToolKind::Normal));
        }
    }
    let mut script: Vec<Attempt> = case["rounds"].as_array().unwrap().iter().map(|r| round_turn(&ids(r))).collect();
    script.push(turn(vec![text("done"), done(StopReason::EndTurn)]));
    let h = Harness::new(script);
    let tool: Arc<dyn Tool> = Arc::new(Answer(ToolSpec {
        name: "t".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "t".into(),
        input_schema: json!({"type": "object"}),
        annotations: ToolAnnotations::default(),
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }));
    let output = finish(h.run(config(), vec![tool], history)).await;
    let rounds: Vec<JsonValue> = output
        .transcript
        .iter()
        .filter(|m| !m.tool_calls().is_empty())
        .skip(earlier.len())
        .map(|m| json!(m.tool_calls().iter().map(|c| c.id.clone()).collect::<Vec<_>>()))
        .collect();
    JsonValue::Array(rounds)
}

async fn replay_loop(case: &JsonValue) -> JsonValue {
    let tool = case["tool"].as_str().unwrap();
    let mut script: Vec<Attempt> = case["script"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let mut steps: Vec<Step> = ids(r).iter().map(|id| call(id, tool, json!({}))).collect();
            steps.push(done(StopReason::ToolUse));
            turn(steps)
        })
        .collect();
    script.push(turn(vec![text("done"), done(StopReason::EndTurn)]));
    let h = Harness::new(script);
    let mut cfg = config();
    cfg.agent_mode = true;
    let output = finish(h.run(cfg, Vec::new(), vec![AgentMessage::user("go")])).await;
    let requests = h.provider.requests();
    let last = requests.last().unwrap();
    let last_request: Vec<JsonValue> = last
        .messages
        .iter()
        .map(|m| {
            json!({
                "role": format!("{:?}", m.role).to_lowercase(),
                "callIds": m.tool_calls.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
                "toolCallId": m.tool_call_id,
                "content": match &m.content { Content::Text(t) => t.clone(), Content::Parts(_) => String::new() },
            })
        })
        .collect();
    let results: Vec<String> = output.transcript.iter().filter_map(|m| m.tool_call_id().map(str::to_owned)).collect();
    json!({"content": output.response.content, "sends": requests.len(), "lastRequest": last_request, "results": results})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_tool_call_id_case_is_nodes_whole_outcome() {
    let path = golden_dir().join("../tool-call-id-cases/golden.json");
    let golden: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        let got = if case["kind"] == "loop" { replay_loop(case).await } else { replay_rounds(case).await };
        if got != case["recorded"] {
            failures.push(format!("{name}:\n  want {}\n  got  {got}", case["recorded"]));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
