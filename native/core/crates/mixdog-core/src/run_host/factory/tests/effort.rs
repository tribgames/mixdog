use super::*;

/// Once turn preparation has seated a picker edit, the provider receives those fields, not the
/// previous send's options or the fallback chain's defaults.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_next_provider_request_uses_the_seated_model_effort_and_speed() {
    let (provider, mut sent) = handing();
    let world = turn_world(provider).await;
    let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "fallback", "fast": false })).await;
    let mut requests = Vec::new();
    for (n, op) in ["first", "second"].into_iter().enumerate() {
        if n == 1 {
            handle
                .request(CoreRequest {
                    method: Method("thread/header/patch"),
                    params: json!({ "threadId": id, "set": {
                        "model": "selected", "effort": "high", "autoEffort": false, "fast": true, "modelParameters": { "serviceTier": "ultrafast" }
                    }}),
                    op: None,
                    ctx: CallContext::internal("test"),
                })
                .await
                .unwrap();
        }
        let before = handle.header_snapshot().get("turnCoverage").cloned();
        handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": op } }), op)).await.unwrap();
        requests.push(tokio::time::timeout(Duration::from_secs(30), sent.recv()).await.expect("provider send").unwrap());
        settled_turns(&world, &id, &handle, n + 1, before).await;
    }
    assert_eq!(requests[0].model.as_str(), "fallback");
    assert!(!requests[0].options.fast);
    assert_eq!(requests[1].model.as_str(), "selected");
    assert_eq!(requests[1].options.effort.as_deref(), Some("high"));
    assert!(requests[1].options.fast);
    assert_eq!(requests[1].options.model_parameters, Some(json!({ "serviceTier": "ultrafast" })));
}

#[test]
fn a_fresh_turn_at_saved_effort_supersedes_the_previous_turns_stamp() {
    use mixdog_agent::effort::{EffortMode, EffortRoute, EffortSnapshot, EffortWiring, ProjectingAdapter};

    let saved = EffortSnapshot {
        provider: "openai".into(),
        model: "gpt-6".into(),
        mode: EffortMode::Responses,
        initial_effort: "high".into(),
        effort: "medium".into(),
    };
    let previous = EffortSnapshot { effort: "high".into(), ..saved.clone() };
    let mut config = RunConfig::new(ThreadId::from("thread"), TurnId::from("turn"), "gpt-6");
    config.options.effort = Some("medium".into());
    config.effort = Some(EffortWiring {
        route: EffortRoute {
            provider: saved.provider.clone(),
            model: saved.model.clone(),
            mode: Some(saved.mode),
            allowed: vec!["medium".into(), "high".into()],
            seed: Some(saved),
            wire: Arc::new(|effort| Some(effort.to_owned())),
        },
        adapter: Arc::new(ProjectingAdapter::new(Arc::new(Scripted {
            id: ProviderId::from("openai"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::default(),
            requests: Mutex::default(),
            fail_first: Default::default(),
        }))),
    });
    let mut row = json!({"role": "user", "content": "new question"});
    stamp_outgoing_effort(&mut row, &config);
    let mut earlier = AgentMessage::user("earlier question");
    earlier.effort = Some(previous);
    let messages = [earlier, AgentMessage::assistant("answer", Vec::new()), message_of(&row).unwrap()];
    let projection = config.effort.unwrap().route.project(&messages).unwrap();
    assert_eq!(projection.initial_effort, "high");
    assert_eq!(projection.updates.get(&2).map(String::as_str), Some("medium"));
}

#[tokio::test]
async fn the_first_outbound_request_uses_judged_effort_without_changing_the_saved_route() {
    use super::super::super::auto_effort::{ConfigAutoEffort, EffortConfiguration, EffortDiagnostics, JudgeAnswer, TurnAutoEffort, TurnJudge, TurnJudgeInput};
    struct JudgeRoute;
    #[async_trait]
    impl EffortConfiguration for JudgeRoute {
        async fn configured(&self, _: &mixdog_store::schema::record::Header) -> bool {
            true
        }
    }
    #[async_trait]
    impl super::super::super::step_judge::LadderSources for JudgeRoute {
        fn cached_row(&self, _: &str, _: &str) -> Option<serde_json::Map<String, Value>> {
            json!({"reasoningLevels": ["low", "medium", "high"]}).as_object().cloned()
        }
        async fn rejected(&self, _: &str, _: &str) -> Option<mixdog_ai::effort::RejectionEntry> {
            None
        }
        fn custom_config(&self, _: &str) -> Option<(mixdog_ai::providers::custom::Protocol, String)> {
            None
        }
        fn anthropic_levels(&self, _: &str) -> Vec<String> {
            Vec::new()
        }
    }
    #[async_trait]
    impl TurnJudge for JudgeRoute {
        async fn judge(&self, input: TurnJudgeInput) -> JudgeAnswer {
            assert_eq!(input.request, "hard problem");
            JudgeAnswer::Probs { probs: vec![0.0, 0.0, 1.0, 0.0], ms: 0 }
        }
    }
    impl EffortDiagnostics for JudgeRoute {
        fn record(&self, _: serde_json::Map<String, Value>) {}
        fn warn(&self, _: &str) {}
    }
    let root = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let (cfg, _) = mixdog_core_config::config::Config::open(
        root.path().join("config.json"),
        Arc::new(mixdog_core_api::mock::MockStatePublisher::default()),
        mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io },
    )
    .await
    .unwrap();
    let auto = Arc::new(TurnAutoEffort::new(
        Arc::new(ConfigAutoEffort::new(cfg, Arc::new(|name| (name == "MIXDOG_AUTO_EFFORT").then(|| "on".to_owned())))),
        Arc::new(JudgeRoute),
        Arc::new(JudgeRoute),
        Arc::new(JudgeRoute),
        Arc::new(JudgeRoute),
        Arc::new(String::new),
    ));
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([vec![
            StreamEvent::TextDelta("answer".into()),
            StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
        ]])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let World { workspace, directory, ledger, .. } = turn_world_at(
        provider.clone(),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        None,
        Arc::new(MockFileService::default()),
        false,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        Some(auto),
    )
    .await;
    let reply =
        directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.path() }), "op-start")).await.unwrap();
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().unwrap());
    let handle = directory.handle(&id).unwrap();
    handle
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": id, "set": { "provider": "scripted", "model": "m", "effort": "low" } }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .unwrap();
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "hard problem" } }), "op-1")).await.unwrap();
    eventually_on_awaiting(|| "the turn's usage record".to_owned(), &[&ledger.1], || (!lock(&ledger.0).is_empty()).then_some(())).await;
    assert_eq!(lock(&provider.requests)[0].options.effort.as_deref(), Some("high"));
    assert_eq!(handle.live_header().header()["effort"], "low");
}
