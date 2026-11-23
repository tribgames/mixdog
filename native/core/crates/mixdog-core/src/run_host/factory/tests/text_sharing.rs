use super::*;

/// Answers with a text long enough to be held once by the process.
struct Long(ToolSpec);

fn long_text() -> String {
    format!("the result of the long call: {}", "row ".repeat(600))
}

#[async_trait]
impl Tool for Long {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text(long_text())], ..ToolOutput::default() })
    }
}

/// A tool result's text is one allocation for everything that holds it: the row in view, the message of the turn that made
/// it in the request that follows, and the message the next turn reads back from the store in its own request. Each of the
/// three was made on its own (from the tool's output, from the committed record, from the stored row), and before the text
/// was shared each held a copy, the request and the registered row two more.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_results_text_is_one_allocation_in_view_in_the_turn_and_in_the_next_turns_request() {
    let spec = ToolSpec {
        name: "long".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "long".into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    };
    let provider = scripted_rounds(vec![vec![tool_call("c1", "long"), tool_use()], answer_events("read"), answer_events("again")]);
    let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
    let adapter: Arc<dyn ProviderAdapter> = provider.clone();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(mixdog_core_session::session::testing::RecordTranscript::new());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: adapter, workspace: workspace.path().to_path_buf(), more: vec![Arc::new(Long(spec))], settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    for (turn, sent) in [(1, 2), (2, 3)] {
        let op = format!("op-{turn}");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": "go" } }), &op)).await.expect("turn/start");
        eventually_on_awaiting(|| format!("the end of turn {turn}"), &[handle.stepped()], || (lock(&provider.requests).len() == sent && !handle.turn_busy()).then_some(()))
            .await;
    }

    let shown = handle
        .view_items()
        .iter()
        .find_map(|item| match item.as_ref() {
            ThreadItem::ToolCall { run, .. } => match &run.result {
                Some(MaybeBlob::Inline(text)) => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .expect("the call's card shows its result");
    assert_eq!(shown, long_text());
    let requests = lock(&provider.requests);
    let result_in = |request: &ModelRequest| {
        request
            .messages
            .iter()
            .find_map(|message| match &message.content {
                Content::Text(text) if message.role == Role::Tool => Some(text.clone()),
                _ => None,
            })
            .expect("the request carries the result")
    };
    assert!(shown.shares(&result_in(&requests[1])), "the row in view and the request of the turn that made it");
    assert!(shown.shares(&result_in(&requests[2])), "the row in view and the request the next turn built from the store");
}
