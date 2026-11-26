use super::*;

/// The done-when turn: `TurnPath::new` over test implementations of the missing owner traits, a
/// scripted provider behind the accounted registry, a tool call, the stored rows and the ledger row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_runs_through_the_turn_path() {
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![
                StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "list".into(), arguments: json!({ "path": "." }), native_type: None }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ],
            vec![StreamEvent::TextDelta("listed".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            // The side question's answer, then the answer after the saved request was forgotten.
            vec![
                StreamEvent::TextDelta(" it listed the path ".into()),
                StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
            ],
            vec![StreamEvent::TextDelta("rebuilt".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
        ])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let World { workspace, rig, ledger, asked, store, directory, .. } = turn_world(provider.clone()).await;
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.path() }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": id, "set": { "provider": "scripted", "model": "m" } }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("route");
    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    let Reply::Value(started) = started else { panic!("turn/start answers a value") };
    assert_eq!(started["kind"], "started");
    let roles = || -> Vec<String> {
        rig.store
            .records(&id)
            .into_iter()
            .filter_map(|(_, record)| match record {
                Record::Item(item) => match item.body {
                    Slot::Inline(body) => body["role"].as_str().map(str::to_owned),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    };
    eventually_on_awaiting(
        || "the four-role transcript in the store and two usage rows in the ledger".to_owned(),
        &[&rig.store.committed, &ledger.1],
        || (roles().len() >= 4 && lock(&ledger.0).len() >= 2).then_some(()),
    )
    .await;
    assert_eq!(roles(), ["user", "assistant", "tool", "assistant"]);
    // The turn's two approval entry points (the policy gate and the tool environment a nested call is judged with) both went through the composition's choice.
    assert_eq!(*lock(&asked.0), [id.as_str(), id.as_str()]);
    let requests = lock(&provider.requests).clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::Tool]);
    let rows = lock(&ledger.0).clone();
    assert!(rows.iter().all(|r| r.provider == "scripted" && r.model == "m" && r.session_id == id.as_str()), "{rows:?}");

    // `thread/askSide` end to end: the real service forks the request the loop saved, on a scope of
    // its own, and the answer comes back trimmed without entering the transcript.
    let asked =
        handle.request(request("thread/askSide", json!({ "opId": "op-side", "question": " what did it list? " }), "op-side")).await.expect("thread/askSide");
    let Reply::Value(asked) = asked else { panic!("thread/askSide answers a value") };
    assert_eq!(asked["text"], "it listed the path");
    let requests = lock(&provider.requests).clone();
    let fork = requests.last().expect("the fork's request");
    assert_eq!(requests.len(), 3);
    assert_eq!(
        fork.messages.iter().map(|m| m.role).collect::<Vec<_>>(),
        [Role::User, Role::Assistant, Role::Tool, Role::Assistant, Role::User],
        "the saved request, its reply, the question"
    );
    assert!(
        fork.options.transport_scope.as_deref().is_some_and(|scope| scope.starts_with(&format!("{}#side:", id.as_str()))),
        "{:?}",
        fork.options.transport_scope
    );
    assert_eq!(roles(), ["user", "assistant", "tool", "assistant"], "the question never enters the transcript");
    assert_eq!(lock(&ledger.0).len(), 3, "the fork's usage row is the provider's own accounting row");

    // With no saved request (a restart, a forgotten one) the question forks the request the next turn
    // would send, rebuilt from the stored rows by the turn's own assembly.
    store.end(&id, mixdog_core_session::session::turn_ops::SideEnd::Transcript);
    let rebuilt = handle.request(request("thread/askSide", json!({ "opId": "op-side-2", "question": "again?" }), "op-side-2")).await.expect("thread/askSide");
    let Reply::Value(rebuilt) = rebuilt else { panic!("thread/askSide answers a value") };
    assert_eq!(rebuilt["text"], "rebuilt");
    let requests = lock(&provider.requests).clone();
    let fork = requests.last().expect("the rebuilt fork");
    assert_eq!(fork.messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::Tool, Role::Assistant, Role::User]);
    assert_eq!((fork.model.as_str(), fork.options.session_id.as_deref()), ("m", Some(id.as_str())));
}

/// Issue #327 through the real assembly: a turn whose primary provider is not available at preflight sends its first
/// request on the configured Codex fallback, as a mid-turn hop would leave it (the landing model and its minted wire
/// identity, no provider state or replay of the primary), tells the switch once, books the usage on the landing model;
/// the next turn goes back to the primary once its provider is there again, a turn that starts on the fallback while
/// that one is gone and the primary is back runs on the primary, and once the fallback is back a mid-turn hop off the
/// primary takes it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_primary_unavailable_at_preflight_runs_the_turn_on_the_fallback_and_the_next_turn_returns() {
    let scripted = |id: &str, script: Vec<Vec<StreamEvent>>| {
        Arc::new(Scripted {
            id: ProviderId::from(id),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script.into()),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        })
    };
    let done = || StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None };
    let primary_state = mixdog_core_api::domain::provider::ProviderState { gemini: None, rest: json!({ "primarySlot": "p0" }).as_object().unwrap().clone() };
    let primary = scripted(
        "primary",
        vec![
            vec![
                StreamEvent::ThinkingBlocks(json!([{ "type": "thinking", "thinking": "plan", "signature": "sig-primary" }])),
                StreamEvent::ProviderState(primary_state),
                StreamEvent::TextDelta("first".into()),
                done(),
            ],
            vec![StreamEvent::TextDelta("primary again".into()), done()],
            vec![StreamEvent::TextDelta("primary while the fallback is gone".into()), done()],
        ],
    );
    let fallback = scripted(
        "openai-oauth",
        vec![
            vec![StreamEvent::TextDelta("fallback answer".into()), done()],
            vec![StreamEvent::TextDelta("fallback again".into()), done()],
            vec![StreamEvent::TextDelta("fallback after the hop".into()), done()],
        ],
    );
    let refusing = ArmedRefusal::new(primary.clone());
    let providers =
        GatedProviders::new(vec![("primary", refusing.clone() as Arc<dyn ProviderAdapter>), ("openai-oauth", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": "openai-oauth", "model": "m2" }] }],
        "providers": { "primary": { "enabled": true }, "openai-oauth": { "enabled": true } },
    });
    let routed = routed(providers.clone(), config);
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;
    let run_turn = |op: &'static str, count: usize| {
        let (handle, id, world) = (handle.clone(), id.clone(), &world);
        async move {
            let covered = handle.header_snapshot().get("turnCoverage").cloned();
            let started =
                handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": op } }), op)).await.expect("turn/start");
            let Reply::Value(started) = started else { panic!("turn/start answers a value") };
            assert_eq!(started["kind"], "started", "{op}");
            settled_turns(world, &id, &handle, count, covered).await;
        }
    };
    let notices = |needle: &str| {
        world
            .rig
            .feeds
            .frames(id.as_str())
            .iter()
            .filter(|(_, method, params)| method == "item/completed" && params["item"].to_string().contains(needle))
            .count()
    };
    let route = || {
        let header = handle.live_header().header();
        (header["provider"].as_str().unwrap_or_default().to_owned(), header["model"].as_str().unwrap_or_default().to_owned())
    };
    let on = |provider: &str, model: &str| (provider.to_owned(), model.to_owned());

    // The primary answers a turn and leaves its replay and its provider state on the session.
    run_turn("op-1", 1).await;
    assert_eq!(handle.live_header().header()["providerState"]["primarySlot"], "p0", "the primary's saved state");

    // Its provider is gone at the next preflight: the turn runs on the Codex fallback.
    providers.set("primary", false);
    run_turn("op-2", 2).await;
    assert_eq!(lock(&primary.requests).len(), 1, "nothing reached the unavailable primary");
    let landed = lock(&fallback.requests).first().cloned().expect("the turn's request went to the fallback");
    let header = handle.live_header().header();
    let wire = header["codexWireSessionId"].as_str().expect("the landing Codex route's wire identity is minted").to_owned();
    assert!(wire.len() == 36 && wire.as_bytes()[14] == b'7' && wire != id.as_str(), "a v7 wire id of its own: {wire}");
    assert_eq!(landed.model, "m2");
    assert_eq!(landed.options.session_id.as_deref(), Some(wire.as_str()), "the first request names the minted wire id");
    assert_eq!(landed.options.provider_state, None, "the primary's continuation state stays with the primary");
    assert!(
        landed.messages.iter().all(|m| m.thinking_blocks.is_none() && m.provider_replay().is_empty()),
        "the primary's replay reached the fallback: {:?}",
        landed.messages
    );
    assert_eq!(route(), on("openai-oauth", "m2"));
    assert_eq!(header["routeFallbackFailures"][0]["kind"], mixdog_core_run::run_host::route_fallback::PROVIDER_UNAVAILABLE);
    assert_eq!(notices("switched to"), 1, "the switch is told once");

    // The provider is back: the next turn returns to the primary before its first request.
    providers.set("primary", true);
    run_turn("op-3", 3).await;
    assert_eq!(lock(&fallback.requests).len(), 1);
    assert_eq!(lock(&primary.requests).get(1).map(|r| r.model.clone()).as_deref(), Some("m1"), "the recovered primary takes the turn");
    assert_eq!(route(), on("primary", "m1"));
    assert_eq!(notices("available again"), 1);

    // Gone again: the session moves to the fallback; then the fallback is gone and the primary back before the next turn,
    // which starts on the fallback and runs on the primary.
    providers.set("primary", false);
    run_turn("op-4", 4).await;
    assert_eq!((lock(&fallback.requests).len(), route()), (2, on("openai-oauth", "m2")));
    providers.set("primary", true);
    providers.set("openai-oauth", false);
    run_turn("op-5", 5).await;
    assert_eq!(lock(&primary.requests).get(2).map(|r| r.model.clone()).as_deref(), Some("m1"), "the recovered primary takes the turn the fallback cannot");
    assert_eq!(route(), on("primary", "m1"));
    assert_eq!(notices("switched to"), 3, "each preflight switch is told once");

    // The fallback is back, and the primary answers the next turn's request with a 503 before any output: the hop takes
    // the fallback, whose earlier absence no longer holds.
    providers.set("openai-oauth", true);
    let mut overloaded = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Transient, DeliveryState::Accepted);
    overloaded.status = Some(503);
    overloaded.message = "Service Unavailable".into();
    *lock(&refusing.refusal) = Some(overloaded);
    run_turn("op-6", 6).await;
    assert_eq!(lock(&primary.requests).len(), 3, "the refused attempt never reached the script");
    assert_eq!(lock(&fallback.requests).len(), 3, "the hop's request went to the recovered fallback");
    assert_eq!(route(), on("openai-oauth", "m2"));
    assert_eq!(notices("switched to"), 4);

    // Every send the server answered is a ledger row (`accountProviderSend`): the primary's 503 is the sixth turn's failed
    // row, ahead of the fallback's.
    eventually_on_awaiting(|| "a usage row per sent request".to_owned(), &[&world.ledger.1], || (lock(&world.ledger.0).len() >= 7).then_some(())).await;
    let booked: Vec<(String, String, String)> = lock(&world.ledger.0).iter().map(|row| (row.provider.clone(), row.model.clone(), row.status.clone())).collect();
    let row = |provider: &str, model: &str, status: &str| (provider.to_owned(), model.to_owned(), status.to_owned());
    assert_eq!(
        booked,
        [
            row("primary", "m1", "completed"),
            row("openai-oauth", "m2", "completed"),
            row("primary", "m1", "completed"),
            row("openai-oauth", "m2", "completed"),
            row("primary", "m1", "completed"),
            row("primary", "m1", "failed"),
            row("openai-oauth", "m2", "completed"),
        ]
    );
}

/// A turn that hops off its primary mid-turn and then fails on the fallback stores the failure as the fallback's: the
/// provider the run ended on, not the one it started on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_after_a_mid_turn_hop_names_the_provider_the_turn_ended_on() {
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_store::schema::record::RunPhase;
    let (primary, fallback, _) = switched_off_pair(0);
    let (left, landed) = (ArmedRefusal::new(primary.clone()), ArmedRefusal::new(fallback));
    let refusal = |kind: ErrorKind, status: u16, message: &str| {
        let mut error = ProviderError::new(kind, DeliveryState::Accepted);
        error.status = Some(status);
        error.message = message.into();
        error
    };
    *lock(&left.refusal) = Some(refusal(ErrorKind::Transient, 503, "Service Unavailable"));
    *lock(&landed.refusal) = Some(refusal(ErrorKind::InvalidRequest, 400, "Bad Request"));
    let providers = GatedProviders::new(vec![("primary", left as Arc<dyn ProviderAdapter>), ("openai-oauth", landed as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": "openai-oauth", "model": "m2" }] }],
        "providers": { "primary": { "enabled": true }, "openai-oauth": { "enabled": true } },
    });
    let world = turn_world_routed(
        primary,
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
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;
    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    let failure = || {
        world.rig.store.records(&id).into_iter().find_map(|(_, record)| match record {
            Record::Run(run) if run.phase == RunPhase::Failed => match run.detail {
                Some(Slot::Inline(detail)) => Some(detail),
                _ => None,
            },
            _ => None,
        })
    };
    let detail = eventually_on_awaiting(|| "the failed turn's end record".to_owned(), &[&world.rig.store.committed, handle.stepped()], failure).await;
    let header = handle.live_header().header();
    assert_eq!((header["provider"].as_str(), header["model"].as_str()), (Some("openai-oauth"), Some("m2")), "the turn hopped");
    assert_eq!(detail["providerError"]["provider"], "openai-oauth", "{detail}");
}

/// A → B → C with A not available at preflight and B a removed custom provider (no family serves it): B is absent, not
/// an error, and the turn runs on C.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_intermediate_provider_is_skipped_at_preflight() {
    let third = Arc::new(Scripted {
        id: ProviderId::from("third"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([vec![
            StreamEvent::TextDelta("from c".into()),
            StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
        ]])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let primary = Arc::new(Scripted {
        id: ProviderId::from("primary"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::new()),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let providers = GatedProviders::new(vec![("primary", primary.clone() as Arc<dyn ProviderAdapter>), ("third", third.clone() as Arc<dyn ProviderAdapter>)]);
    providers.set("primary", false);
    // The removed custom provider is in the route, not in the providers the config enables.
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": "custom-gone", "model": "mb" }, { "provider": "third", "model": "m3" }] }],
        "providers": { "primary": { "enabled": true }, "third": { "enabled": true } },
    });
    let routed = routed(providers.clone(), config);
    let world = turn_world_routed(
        third.clone(),
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
        None,
        Some(routed),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;
    let covered = handle.header_snapshot().get("turnCoverage").cloned();
    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    settled_turns(&world, &id, &handle, 1, covered).await;
    assert_eq!(lock(&third.requests).first().map(|r| r.model.clone()).as_deref(), Some("m3"), "the turn ran on C");
    assert!(lock(&primary.requests).is_empty());
    let header = handle.live_header().header();
    assert_eq!((header["provider"].as_str(), header["model"].as_str()), (Some("third"), Some("m3")));
}

/// A cold registry, the primary switched off by the user and the fallback known only by its stored key (no entry in the
/// providers map): the primary is absent, not a registry refusal, and the turn runs on the fallback.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_switched_off_primary_on_a_cold_registry_runs_the_turn_on_a_key_only_fallback() {
    let (primary, fallback, providers) = switched_off_pair(1);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": "openai-oauth", "model": "m2" }] }],
        "providers": { "primary": { "enabled": false } },
    });
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;
    settled_turn(&world, &id, &handle, "op-1", 1).await;
    assert!(lock(&primary.requests).is_empty());
    assert_eq!(lock(&fallback.requests).first().map(|r| r.model.clone()).as_deref(), Some("m2"), "the turn ran on the fallback");
    let header = handle.live_header().header();
    assert_eq!((header["provider"].as_str(), header["model"].as_str()), (Some("openai-oauth"), Some("m2")));
}

/// The primary answered a turn and is registered; the user then switches it off. The next turn does not take the
/// registered adapter: it runs on the fallback, and stays there while the primary is off.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_primary_switched_off_after_it_was_registered_is_not_used() {
    let (primary, fallback, providers) = switched_off_pair(2);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": "openai-oauth", "model": "m2" }] }],
        "providers": { "primary": { "enabled": true }, "openai-oauth": { "enabled": true } },
    });
    let routed = routed(providers, config);
    let config = routed.config.clone();
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;
    settled_turn(&world, &id, &handle, "op-1", 1).await;
    assert_eq!(lock(&primary.requests).len(), 1, "the primary answered while on");
    lock(&config)["providers"]["primary"]["enabled"] = json!(false);
    settled_turn(&world, &id, &handle, "op-2", 2).await;
    settled_turn(&world, &id, &handle, "op-3", 3).await;
    assert_eq!(lock(&primary.requests).len(), 1, "nothing reached the switched-off primary");
    assert_eq!(lock(&fallback.requests).iter().map(|r| r.model.clone()).collect::<Vec<_>>(), ["m2", "m2"]);
    let header = handle.live_header().header();
    assert_eq!((header["provider"].as_str(), header["model"].as_str()), (Some("openai-oauth"), Some("m2")));
}

/// The route facts of the composition as far as the tool surface goes: a route change rebuilds the header's surface for
/// its new provider from the tools the session resolves to (`.1`), over a host that defines the bridge's two tools (`.0`).
struct SurfaceFacts(Vec<Value>, Vec<Value>);

impl crate::run_host::tool_surface::SurfaceHost for SurfaceFacts {
    fn defined(&self, _: &str) -> bool {
        true
    }
    fn bridge_tools(&self) -> Vec<Value> {
        self.0.clone()
    }
    fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
        json!({})
    }
}

#[async_trait]
impl crate::run_host::route_change::RouteFacts for SurfaceFacts {
    fn context_meta(&self, _: &str, _: &str, _: &Value) -> Option<mixdog_core_run::run_host::session_context_meta::ContextMeta> {
        None
    }
    fn cache_opts(&self, _: &str, _: &str, _: Option<&str>, _: &mixdog_store::schema::record::Header) -> Option<Value> {
        None
    }
    fn surface_change(
        &self,
        header: &mixdog_store::schema::record::Header,
        previous: &mixdog_core_ports::ports::route::Route,
        _: &crate::run_host::route_change::SurfaceLookup,
    ) -> mixdog_store::schema::record::HeaderChange {
        let surface = crate::run_host::tool_surface::ToolSurface { host: self, clock: &Fixed };
        let prepared = crate::run_host::route_surface::PreparedTools { tools: json!(self.1), tool_spec: json!("full") };
        crate::run_host::route_surface::route_surface_change(&surface, &Fixed, header, previous, Some(prepared), false)
    }
}

/// An agent's session through the real hop, on each bridge route. Its direct route answers a turn; the next turn's
/// request is refused there and the hop takes the bridge route mid-turn: that request leads with the roster and the
/// guidance the hop wrote, which is what the session's header gives. The turn after builds the same prefix from the
/// header. With the bridge route gone the following turn returns to the direct route, which is sent the text it was
/// sent before the hop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mid_turn_hop_to_a_bridge_route_sends_its_roster_and_the_return_sends_the_direct_routes_text() {
    use crate::run_host::tool_exposure::TOOL_BRIDGE_GUIDANCE;
    use mixdog_core_api::domain::provider::{Content, Role};

    let system_of = |request: &ModelRequest| -> Vec<String> {
        let leading = request.messages.iter().take_while(|m| m.role == Role::System);
        leading.map(|m| if let Content::Text(text) = &m.content { text.to_string() } else { panic!("a system message is text") }).collect()
    };
    for bridge in ["grok-oauth", "gemini", "opencode-go-oauth"] {
        let scripted = |id: &str| {
            let reply = |text: &str| {
                vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
            };
            Arc::new(Scripted {
                id: ProviderId::from(id),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(VecDeque::from([reply("one"), reply("two")])),
                requests: Mutex::new(Vec::new()),
                fail_first: std::sync::atomic::AtomicBool::new(false),
            })
        };
        let (direct, bridged) = (scripted("openai-oauth"), scripted(bridge));
        let refusing = ArmedRefusal::new(direct.clone());
        let providers =
            GatedProviders::new(vec![("openai-oauth", refusing.clone() as Arc<dyn ProviderAdapter>), (bridge, bridged.clone() as Arc<dyn ProviderAdapter>)]);
        let bridge_cfg = if bridge == "gemini" { json!({ "enabled": true, "apiKey": "sk-test" }) } else { json!({ "enabled": true }) };
        let config = json!({
            "default": "lead-route",
            "presets": [{ "id": "lead-route", "provider": "openai-oauth", "model": "m1", "fallbacks": [{ "provider": bridge, "model": "m2" }] }],
            "providers": { "openai-oauth": { "enabled": true }, bridge: bridge_cfg },
        });
        let tool = |name: &str| json!({ "name": name, "description": format!("{name}."), "inputSchema": { "type": "object", "properties": {} } });
        let resolved = vec![tool("read"), tool("git"), tool("load_tool"), tool("computer")];
        let facts = Arc::new(SurfaceFacts(vec![tool("load_tool"), tool("call_tool")], resolved.clone()));
        let mut routed = routed(providers.clone(), config);
        routed.facts = facts.clone();
        let world = turn_world_routed(
            bridged.clone(),
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
            None,
            Some(routed),
        )
        .await;

        // The session as its direct route built it: `git` defined, `computer` in the prompt's roster.
        let surface = crate::run_host::tool_surface::ToolSurface { host: facts.as_ref(), clock: &Fixed };
        let mut session = json!({
            "owner": "agent", "provider": "openai-oauth", "model": "m1",
            "tools": resolved,
            "messages": [{ "role": "system", "content": "rules" }, { "role": "system", "content": "skills" }],
        });
        surface.apply(&mut session, "lead", &[], &crate::run_host::tool_surface::ApplyOptions::default());
        let mut header = session.as_object().unwrap().clone();
        let messages = header.shift_remove("messages").unwrap();
        header.insert("agent".into(), json!("reviewer"));
        header.insert("routeFallbackSource".into(), json!({ "agent": "reviewer" }));
        header.insert("bp3EnvSplit".into(), json!(true));
        header.insert("promptBase".into(), messages[0]["content"].clone());
        header.insert("promptStable".into(), messages[1]["content"].clone());
        let native = header["promptStable"].as_str().unwrap().to_owned();
        assert!(native.contains("\n- computer") && !native.contains("\n- git"), "{bridge}: the direct route's roster: {native}");
        let (id, handle) = started_thread(&world, Value::Object(header)).await;
        let of_header = || {
            let header = handle.live_header().header();
            crate::run_host::factory::system_messages(&header).iter().map(|m| m.text()).collect::<Vec<_>>()
        };

        settled_turn(&world, &id, &handle, "op-1", 1).await;
        let before = system_of(&lock(&direct.requests)[0]);
        assert_eq!(before[..2], ["rules".to_owned(), native.clone()], "{bridge}: the direct route's prompt");

        let mut overloaded = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Transient, DeliveryState::Accepted);
        overloaded.status = Some(503);
        overloaded.message = "Service Unavailable".into();
        *lock(&refusing.refusal) = Some(overloaded);
        settled_turn(&world, &id, &handle, "op-2", 2).await;
        assert_eq!(lock(&direct.requests).len(), 1, "{bridge}: the refused attempt never reached the script");
        let hopped = system_of(&lock(&bridged.requests)[0]);
        assert_eq!(handle.live_header().header()["provider"], bridge);
        assert_eq!(hopped[0], "rules");
        assert!(hopped[1].contains("\n- git") && hopped[1].ends_with(TOOL_BRIDGE_GUIDANCE), "{bridge}: the request after the hop: {}", hopped[1]);
        assert_eq!(hopped, of_header(), "{bridge}: the hopped turn was sent what the session holds");

        settled_turn(&world, &id, &handle, "op-3", 3).await;
        assert_eq!(system_of(&lock(&bridged.requests)[1]), hopped, "{bridge}: the next turn's prefix is the hopped turn's");

        // Age the earlier 503 transient failure past the 60 s cooldown before taking the bridge route offline so
        // preflight rescan legitimately returns to the direct route.
        let mut aged_failures = handle.live_header().header().get("routeFallbackFailures").and_then(Value::as_array).cloned().unwrap_or_default();
        for entry in &mut aged_failures {
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("failedAt".into(), json!(1));
                obj.insert("recoverAfterMs".into(), json!(1));
            }
        }
        handle
            .request(CoreRequest {
                method: Method("thread/header/patch"),
                params: json!({ "threadId": id, "set": { "routeFallbackFailures": aged_failures } }),
                op: None,
                ctx: CallContext::internal("test"),
            })
            .await
            .expect("age transient cooldown");
        providers.set(bridge, false);
        settled_turn(&world, &id, &handle, "op-4", 4).await;
        assert_eq!(handle.live_header().header()["provider"], "openai-oauth");
        let returned = system_of(&lock(&direct.requests)[1]);
        assert_eq!(returned[..2], before[..2], "{bridge}: the direct route is sent the text it was sent before the hop");
        assert_eq!(returned, of_header(), "{bridge}: the returning turn was sent what the session holds");
    }
}

/// Pre-flight fallback, recovery, and mid-turn fallback each emit a structured `route_switch` stage event on the thread
/// feed alongside the concise recovery notice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn route_switches_emit_structured_stage_events_for_preflight_recovery_and_fallback() {
    let scripted = |id: &str, script: Vec<Vec<StreamEvent>>| {
        Arc::new(Scripted {
            id: ProviderId::from(id),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script.into()),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        })
    };
    let done = || StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None };
    let primary = scripted("primary", vec![vec![StreamEvent::TextDelta("primary recovered".into()), done()]]);
    let fallback = scripted(
        "openai-oauth",
        vec![vec![StreamEvent::TextDelta("preflight fallback".into()), done()], vec![StreamEvent::TextDelta("midturn fallback".into()), done()]],
    );
    let refusing = ArmedRefusal::new(primary.clone());
    let providers =
        GatedProviders::new(vec![("primary", refusing.clone() as Arc<dyn ProviderAdapter>), ("openai-oauth", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": "openai-oauth", "model": "m2" }] }],
        "providers": { "primary": { "enabled": true }, "openai-oauth": { "enabled": true } },
    });
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed(providers.clone(), config)),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;
    let switch_stages = || -> Vec<Value> {
        world
            .rig
            .feeds
            .frames(id.as_str())
            .into_iter()
            .filter_map(|(_, method, params)| (method == "thread/stage/updated" && params["stage"] == "route_switch").then(|| params["detail"].clone()))
            .collect()
    };

    // 1. Primary unavailable at pre-flight: skips cleanly before sending and emits a structured preflight route_switch stage
    // strictly before turn settlement.
    providers.set("primary", false);
    settled_turn(&world, &id, &handle, "op-1", 1).await;
    assert_eq!(lock(&primary.requests).len(), 0, "primary must never receive a failing turn");
    let stages = switch_stages();
    assert_eq!(stages.len(), 1, "preflight route_switch stage must be flushed before turn settles");
    assert_eq!(stages[0]["phase"], "preflight");
    assert_eq!(stages[0]["fromProvider"], "primary");
    assert_eq!(stages[0]["toProvider"], "openai-oauth");
    assert_eq!(stages[0]["runner"], "loop");

    // 2. Primary returns: reconsider emits a recovery route_switch stage strictly before turn settlement.
    providers.set("primary", true);
    settled_turn(&world, &id, &handle, "op-2", 2).await;
    let stages = switch_stages();
    assert_eq!(stages.len(), 2, "recovery route_switch stage must be flushed before turn settles");
    assert_eq!(stages[1]["phase"], "recovery");
    assert_eq!(stages[1]["kind"], "recovered");
    assert_eq!(stages[1]["toProvider"], "primary");

    // 3. Primary fails mid-turn: fallback emits a fallback route_switch stage strictly before turn settlement.
    let mut overloaded = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Transient, DeliveryState::Accepted);
    overloaded.status = Some(503);
    overloaded.message = "Service Unavailable".into();
    *lock(&refusing.refusal) = Some(overloaded);
    settled_turn(&world, &id, &handle, "op-3", 3).await;
    let stages = switch_stages();
    assert_eq!(stages.len(), 3, "fallback route_switch stage must be flushed before turn settles");
    assert_eq!(stages[2]["phase"], "fallback");
    assert_eq!(stages[2]["fromProvider"], "primary");
    assert_eq!(stages[2]["toProvider"], "openai-oauth");
}

#[test]
fn route_switch_bus_preserves_strict_fifo_order_across_buffered_and_live_events() {
    use mixdog_core_run::run_host::route_fallback::RouteSwitchEvent;
    let bus = RouteSwitchBus::new();
    let event = |phase: &'static str, to: &str| RouteSwitchEvent {
        from_provider: "p0".into(),
        from_model: "m0".into(),
        to_provider: to.into(),
        to_model: "m1".into(),
        phase,
        kind: "provider_unavailable".into(),
        runner: "loop",
        notice: format!("switched to {to}"),
    };
    bus.push(event("preflight", "p1"));
    bus.push(event("recovery", "p2"));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    bus.attach(tx);
    bus.push(event("fallback", "p3"));

    let mut received = Vec::new();
    while let Ok(shown) = rx.try_recv() {
        if let crate::run_host::factory::forwarding::Shown::Stage(stage, Some(detail)) = shown {
            assert_eq!(stage, "route_switch");
            received.push((detail["phase"].as_str().unwrap().to_owned(), detail["toProvider"].as_str().unwrap().to_owned()));
        }
    }
    assert_eq!(received, vec![("preflight".to_owned(), "p1".to_owned()), ("recovery".to_owned(), "p2".to_owned()), ("fallback".to_owned(), "p3".to_owned()),]);
}

/// An unknown/removed `acp-*` primary route falls back cleanly at pre-flight to a ready HTTP fallback instead of failing
/// before fallback selection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_acp_primary_falls_back_to_ready_http_provider_end_to_end() {
    let fallback = Arc::new(Scripted {
        id: ProviderId::from("openai-oauth"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([vec![
            StreamEvent::TextDelta("from http fallback".into()),
            StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
        ]])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let providers = GatedProviders::new(vec![("openai-oauth", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "acp-removed",
            "model": "default",
            "fallbacks": [{ "provider": "openai-oauth", "model": "m2" }],
        }],
        "providers": { "openai-oauth": { "enabled": true } },
    });
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "acp-removed", "model": "default", "agent": "lead" })).await;
    settled_turn(&world, &id, &handle, "op-1", 1).await;
    assert_eq!(lock(&fallback.requests).len(), 1, "ready HTTP fallback must take the turn");
    let header = handle.live_header().header();
    assert_eq!((header["provider"].as_str(), header["model"].as_str()), (Some("openai-oauth"), Some("m2")));
    let stages: Vec<Value> = world
        .rig
        .feeds
        .frames(id.as_str())
        .into_iter()
        .filter_map(|(_, method, params)| (method == "thread/stage/updated" && params["stage"] == "route_switch").then(|| params["detail"].clone()))
        .collect();
    assert_eq!(stages.len(), 1);
    assert_eq!(stages[0]["phase"], "preflight");
    assert_eq!(stages[0]["fromProvider"], "acp-removed");
    assert_eq!(stages[0]["toProvider"], "openai-oauth");
}

/// When preflight persists a route switch and buffers its stage event, an early failure inside `carry_turn`
/// (e.g., an unreadable prompt text attachment) still drains and emits the `route_switch` stage event before
/// the turn settles.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persisted_preflight_switch_emits_stage_event_even_when_carry_turn_fails() {
    let fallback = Arc::new(Scripted {
        id: ProviderId::from("openai-oauth"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::new()),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let providers = GatedProviders::new(vec![("openai-oauth", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "acp-removed",
            "model": "default",
            "fallbacks": [{ "provider": "openai-oauth", "model": "m2" }],
        }],
        "providers": { "openai-oauth": { "enabled": true } },
    });
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(
        &world,
        json!({
            "provider": "acp-removed",
            "model": "default",
            "agent": "lead",
            "orchestrationModeSwitch": { "to": "missing-mode", "revision": 1 },
        }),
    )
    .await;
    let started = handle
        .request(request(
            "turn/start",
            json!({
                "threadId": id,
                "opId": "op-carry-fail",
                "input": { "prompt": "go" },
            }),
            "op-carry-fail",
        ))
        .await
        .expect("turn/start");
    assert!(matches!(started, Reply::Value(_)));
    let failed_settled = || {
        world
            .rig
            .store
            .records(&id)
            .into_iter()
            .any(|(_, record)| matches!(record, Record::Run(run) if run.phase == mixdog_store::schema::record::RunPhase::Failed))
            .then_some(())
    };
    eventually_on_awaiting(|| "failed turn settled".to_owned(), &[handle.stepped()], failed_settled).await;

    let header = handle.live_header().header();
    assert_eq!((header["provider"].as_str(), header["model"].as_str()), (Some("openai-oauth"), Some("m2")));
    assert!(lock(&fallback.requests).is_empty(), "turn failed inside carry_turn before sending");
    let stages: Vec<Value> = world
        .rig
        .feeds
        .frames(id.as_str())
        .into_iter()
        .filter_map(|(_, method, params)| (method == "thread/stage/updated" && params["stage"] == "route_switch").then(|| params["detail"].clone()))
        .collect();
    assert_eq!(stages.len(), 1, "buffered preflight route_switch stage must emit even when carry_turn fails");
    assert_eq!(stages[0]["phase"], "preflight");
    assert_eq!(stages[0]["fromProvider"], "acp-removed");
    assert_eq!(stages[0]["toProvider"], "openai-oauth");
}

/// Even when the turn's `CancellationToken` has already been cancelled (e.g., `carry_turn` exited because the turn
/// was cancelled), flushing a persisted preflight `RouteSwitchBus` still delivers the `route_switch` stage event over
/// `port.closing()`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persisted_preflight_switch_emits_stage_event_even_when_turn_is_cancelled() {
    let rig = Rig::new();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));
    rig.set_script(Arc::new(move |run| {
        let done_tx = done_tx.clone();
        Box::pin(async move {
            // Simulate turn cancellation before flushing buffered preflight route switches.
            run.cancel.cancel();
            let bus = Arc::new(super::super::RouteSwitchBus::default());
            bus.push(mixdog_core_run::run_host::route_fallback::RouteSwitchEvent {
                from_provider: "acp-removed".into(),
                from_model: "default".into(),
                to_provider: "openai-oauth".into(),
                to_model: "m2".into(),
                phase: "preflight",
                kind: "provider_unavailable".into(),
                runner: "loop",
                notice: "switched to m2".into(),
            });
            super::super::drive::flush_buffered_switches(Some(&bus), &run.port).await;
            if let Some(tx) = lock(&done_tx).take() {
                let _ = tx.send(());
            }
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    tokio::time::timeout(std::time::Duration::from_secs(10), done_rx).await.expect("turn script completed").expect("done signal");
    let settled = || {
        rig.feeds.frames(id.as_str()).into_iter().any(|(_, method, params)| method == "thread/stage/updated" && params["stage"] == "route_switch").then_some(())
    };
    eventually_on_awaiting(|| "cancelled turn route_switch stage frame".to_owned(), &[handle.stepped()], settled).await;

    let stages: Vec<Value> = rig
        .feeds
        .frames(id.as_str())
        .into_iter()
        .filter_map(|(_, method, params)| (method == "thread/stage/updated" && params["stage"] == "route_switch").then(|| params["detail"].clone()))
        .collect();
    assert_eq!(stages.len(), 1, "persisted preflight route_switch stage must emit even when turn token is cancelled");
    assert_eq!(stages[0]["phase"], "preflight");
    assert_eq!(stages[0]["fromProvider"], "acp-removed");
    assert_eq!(stages[0]["toProvider"], "openai-oauth");
}

/// Regression for Finding 2:
/// 1. When `preflight_turn` returns `PreflightTurn::Cancelled { switch_events }` after persisting a preflight switch
///    (e.g. cancelled during post-switch budget refresh), `drive` flushes those buffered switch events via
///    `port.closing()` before returning `RunOutcome::Interrupted`.
/// 2. When `spawn_forwarder` receives queued `Shown::Stage("route_switch", ..)` events and the turn cancels before
///    they are forwarded, the forwarder still drains and emits them via `port.closing()`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_preflight_and_forwarder_still_emit_persisted_route_switch_stage_events() {
    // Window 1: `PreflightTurn::Cancelled { switch_events }` flushed through the real `RunHostFactory` drive loop.
    struct CancelledPreflightParts;
    #[async_trait]
    impl crate::run_host::factory::RunParts for CancelledPreflightParts {
        async fn preflight_turn(
            &self,
            _: &ThreadId,
            _: &mixdog_core_api::ids::TurnId,
            _: &mixdog_store::schema::record::Header,
            cancel: &tokio_util::sync::CancellationToken,
        ) -> Result<crate::run_host::factory::PreflightTurn, TurnError> {
            cancel.cancel();
            Ok(crate::run_host::factory::PreflightTurn::Cancelled {
                switch_events: vec![mixdog_core_run::run_host::route_fallback::RouteSwitchEvent {
                    from_provider: "acp-removed".into(),
                    from_model: "default".into(),
                    to_provider: "openai-oauth".into(),
                    to_model: "m2".into(),
                    phase: "preflight",
                    kind: "provider_unavailable".into(),
                    runner: "loop",
                    notice: "switched to m2".into(),
                }],
            })
        }
        async fn assemble(&self, _: crate::run_host::factory::AssembleInput<'_>) -> Result<crate::run_host::factory::Assembled, TurnError> {
            unreachable!("cancelled preflight must not assemble")
        }
        async fn reconcile_turn(
            &self,
            _: &ThreadId,
            header: mixdog_store::schema::record::Header,
            _: bool,
        ) -> Result<mixdog_store::schema::record::Header, TurnError> {
            Ok(header)
        }
    }

    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(CancelledPreflightParts),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-cancel-preflight", "input": { "prompt": "go" } }), "op-cancel-preflight"))
        .await
        .expect("turn/start");
    let settled = || {
        rig.feeds.frames(id.as_str()).into_iter().any(|(_, method, params)| method == "thread/stage/updated" && params["stage"] == "route_switch").then_some(())
    };
    eventually_on_awaiting(|| "cancelled preflight route_switch stage frame".to_owned(), &[handle.stepped()], settled).await;
    let stages: Vec<Value> = rig
        .feeds
        .frames(id.as_str())
        .into_iter()
        .filter_map(|(_, method, params)| (method == "thread/stage/updated" && params["stage"] == "route_switch").then(|| params["detail"].clone()))
        .collect();
    assert_eq!(stages.len(), 1, "PreflightTurn::Cancelled must flush persisted switch_events");
    assert_eq!(stages[0]["toProvider"], "openai-oauth");

    // Window 2: queued `Shown::Stage("route_switch", ..)` in `spawn_forwarder` must not be dropped when cancel fires.
    let rig2 = Rig::new();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));
    rig2.set_script(Arc::new(move |run| {
        let done_tx = done_tx.clone();
        Box::pin(async move {
            let (shown_tx, shown_rx) = tokio::sync::mpsc::unbounded_channel();
            let bus = Arc::new(super::super::RouteSwitchBus::default());
            bus.attach(shown_tx);
            // Queue a persisted mid-turn route_switch and immediately cancel before spawn_forwarder even starts.
            bus.push(mixdog_core_run::run_host::route_fallback::RouteSwitchEvent {
                from_provider: "openai-oauth".into(),
                from_model: "m1".into(),
                to_provider: "anthropic-oauth".into(),
                to_model: "m2".into(),
                phase: "fallback",
                kind: "transient".into(),
                runner: "loop",
                notice: "switched mid-turn".into(),
            });
            run.cancel.cancel();
            let forwarder = super::super::forwarding::spawn_forwarder(run.port.clone(), shown_rx, run.cancel.clone());
            let _ = forwarder.await;
            if let Some(tx) = lock(&done_tx).take() {
                let _ = tx.send(());
            }
            RunOutcome::Interrupted
        })
    }));
    let directory2 = SessionDirectory::new(rig2.deps());
    let reply2 = directory2
        .request(request("thread/start", json!({ "opId": "op-start-2", "kind": "task", "projectPath": "/ws" }), "op-start-2"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe2) = reply2 else { panic!("thread/start subscribes") };
    let id2 = ThreadId::from(subscribe2.result["thread"]["id"].as_str().expect("thread id"));
    let handle2 = directory2.handle(&id2).expect("loaded");
    handle2
        .request(request("turn/start", json!({ "threadId": id2, "opId": "op-cancel-fwd", "input": { "prompt": "go" } }), "op-cancel-fwd"))
        .await
        .expect("turn/start");
    tokio::time::timeout(std::time::Duration::from_secs(10), done_rx).await.expect("forwarder script completed").expect("done signal");
    let settled2 = || {
        rig2.feeds
            .frames(id2.as_str())
            .into_iter()
            .any(|(_, method, params)| method == "thread/stage/updated" && params["stage"] == "route_switch")
            .then_some(())
    };
    eventually_on_awaiting(|| "cancelled forwarder route_switch stage frame".to_owned(), &[handle2.stepped()], settled2).await;
    let stages2: Vec<Value> = rig2
        .feeds
        .frames(id2.as_str())
        .into_iter()
        .filter_map(|(_, method, params)| (method == "thread/stage/updated" && params["stage"] == "route_switch").then(|| params["detail"].clone()))
        .collect();
    assert_eq!(stages2.len(), 1, "spawn_forwarder must drain queued route_switch events via closing port on cancel");
    assert_eq!(stages2[0]["phase"], "fallback");
    assert_eq!(stages2[0]["toProvider"], "anthropic-oauth");
}

/// Regression for Finding 1: if cancellation fires and `spawn_forwarder` closes `shown_rx` and exits BEFORE a
/// committed mid-turn hop calls `RouteSwitchBus::push(...)`, the bus retains the event in its fallback buffer and
/// `drive_turn` flushes it via `port.closing()` after joining the forwarder.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_mid_turn_route_switch_emits_even_if_published_after_forwarder_exits_on_cancel() {
    let rig = Rig::new();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));
    rig.set_script(Arc::new(move |run| {
        let done_tx = done_tx.clone();
        Box::pin(async move {
            let (shown_tx, shown_rx) = tokio::sync::mpsc::unbounded_channel();
            let bus = Arc::new(super::super::RouteSwitchBus::default());
            bus.attach(shown_tx);
            let forwarder = super::super::forwarding::spawn_forwarder(run.port.clone(), shown_rx, run.cancel.clone());
            // Cancel fires and forwarder drains an empty channel, closes shown_rx, and exits BEFORE publish().
            run.cancel.cancel();
            let _ = forwarder.await;
            // Now the committed hop publishes its route_switch event after the forwarder has already exited.
            bus.push(mixdog_core_run::run_host::route_fallback::RouteSwitchEvent {
                from_provider: "openai-oauth".into(),
                from_model: "m1".into(),
                to_provider: "anthropic-oauth".into(),
                to_model: "m2".into(),
                phase: "fallback",
                kind: "transient".into(),
                runner: "loop",
                notice: "committed before cancel".into(),
            });
            // Final drive_turn flush emits the fallback-buffered event over port.closing().
            super::super::drive::flush_buffered_switches(Some(&bus), &run.port).await;
            if let Some(tx) = lock(&done_tx).take() {
                let _ = tx.send(());
            }
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start-post-cancel", "kind": "task", "projectPath": "/ws" }), "op-start-post-cancel"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-post-cancel-publish", "input": { "prompt": "go" } }), "op-post-cancel-publish"))
        .await
        .expect("turn/start");
    tokio::time::timeout(std::time::Duration::from_secs(10), done_rx).await.expect("post-cancel publish script completed").expect("done signal");
    let settled = || {
        rig.feeds.frames(id.as_str()).into_iter().any(|(_, method, params)| method == "thread/stage/updated" && params["stage"] == "route_switch").then_some(())
    };
    eventually_on_awaiting(|| "post-cancel committed route_switch stage frame".to_owned(), &[handle.stepped()], settled).await;
    let stages: Vec<Value> = rig
        .feeds
        .frames(id.as_str())
        .into_iter()
        .filter_map(|(_, method, params)| (method == "thread/stage/updated" && params["stage"] == "route_switch").then(|| params["detail"].clone()))
        .collect();
    assert_eq!(stages.len(), 1, "committed switch published after forwarder exit must still emit via port.closing()");
    assert_eq!(stages[0]["phase"], "fallback");
    assert_eq!(stages[0]["fromProvider"], "openai-oauth");
    assert_eq!(stages[0]["toProvider"], "anthropic-oauth");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pre_output_acp_account_refusal_fails_over_to_http_fallback_and_post_output_does_not() {
    struct RefusingAcp {
        emit_before_fail: bool,
        runs: Mutex<usize>,
        loop_turns: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl OutsideAgents for RefusingAcp {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            header.get("provider").and_then(Value::as_str) == Some("outside")
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            *lock(&self.runs) += 1;
            if self.emit_before_fail {
                turn.progress.send_modify(|p| {
                    p.ask_start(1_000);
                    p.stream_delta(mixdog_core_run::run_host::progress::StreamKind::Text, 1_000);
                });
            }
            RunOutcome::Failed(TurnError {
                message: "Gemini has been disabled in this account".to_owned(),
                data: json!({ "reason": "acpAgentAccount" }),
                provider_error: None,
            })
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            lock(&self.loop_turns).push(header.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned());
            None
        }
    }

    // 1. Pre-output refusal fails over cleanly to the HTTP fallback route.
    let agent = Arc::new(RefusingAcp { emit_before_fail: false, runs: Mutex::new(0), loop_turns: Mutex::new(Vec::new()) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let fallback = scripted(&["from the http fallback"]);
    let providers = GatedProviders::new(vec![("scripted", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "outside", "model": "default", "fallbacks": [{ "provider": "scripted", "model": "m" }] }],
        "providers": { "scripted": { "enabled": true } },
    });
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed(providers, config.clone())),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-acp-failover", "input": { "prompt": "go" } }), "op-acp-failover"))
        .await
        .expect("turn/start");
    let finished = || {
        world
            .rig
            .feeds
            .frames(id.as_str())
            .iter()
            .any(|(_, method, params)| method == "turn/completed" && params["turn"]["status"] == "completed")
            .then_some(())
    };
    eventually_on_awaiting(|| "turn completed on http fallback".to_owned(), &[handle.stepped()], finished).await;

    assert_eq!(*lock(&agent.runs), 1, "ACP agent ran once before failing over");
    assert_eq!(lock(&fallback.requests).len(), 1, "HTTP fallback answered the turn");
    assert_eq!(*lock(&agent.loop_turns), ["outside"], "session left the failed ACP agent");
    let header = handle.live_header().header();
    assert_eq!(header["provider"], "scripted");
    assert_eq!(header["model"], "m");
    assert_eq!(header["routeFallbackFailures"][0]["error"], "Gemini has been disabled in this account");
    let stages: Vec<Value> = world
        .rig
        .feeds
        .frames(id.as_str())
        .into_iter()
        .filter_map(|(_, method, params)| (method == "thread/stage/updated" && params["stage"] == "route_switch").then(|| params["detail"].clone()))
        .collect();
    assert_eq!(stages.len(), 1, "runtime ACP->HTTP failover must emit route_switch stage");
    assert_eq!(stages[0]["phase"], "fallback");
    assert_eq!(stages[0]["fromProvider"], "outside");
    assert_eq!(stages[0]["toProvider"], "scripted");

    // 2. Post-output failure does NOT fail over to the HTTP fallback.
    let agent2 = Arc::new(RefusingAcp { emit_before_fail: true, runs: Mutex::new(0), loop_turns: Mutex::new(Vec::new()) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent2.clone()));
    let fallback2 = scripted(&["must not be called"]);
    let providers2 = GatedProviders::new(vec![("scripted", fallback2.clone() as Arc<dyn ProviderAdapter>)]);
    let world2 = turn_world_routed(
        fallback2.clone(),
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
        None,
        Some(routed(providers2, config)),
    )
    .await;
    let (id2, handle2) = started_thread(&world2, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
    handle2
        .request(request("turn/start", json!({ "threadId": id2, "opId": "op-acp-no-failover", "input": { "prompt": "go" } }), "op-acp-no-failover"))
        .await
        .expect("turn/start");
    let failed_turn = || {
        world2.rig.feeds.frames(id2.as_str()).iter().any(|(_, method, params)| method == "turn/completed" && params["turn"]["status"] == "failed").then_some(())
    };
    eventually_on_awaiting(|| "post-output ACP failure surfaces".to_owned(), &[handle2.stepped()], failed_turn).await;

    assert_eq!(*lock(&agent2.runs), 1);
    assert!(lock(&fallback2.requests).is_empty(), "post-output ACP failure must not fail over to HTTP");
    assert_eq!(handle2.live_header().header()["provider"], "outside");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_failover_allows_pre_prompt_compaction_and_blocks_visible_image_card_output() {
    struct CompactingAcp {
        emit_image_card: bool,
        runs: Mutex<usize>,
    }

    #[async_trait]
    impl OutsideAgents for CompactingAcp {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            header.get("provider").and_then(Value::as_str) == Some("outside")
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            let run_no = {
                let mut n = lock(&self.runs);
                *n += 1;
                *n
            };
            // First two turns build a multi-row prior conversation so turn 3 can compact it.
            if run_no <= 2 {
                turn.port
                    .commit_item(mixdog_core_session::session::ItemCommit {
                        iid: ItemId::from(format!("seed-reply-{run_no}")),
                        role: Some("assistant".into()),
                        model: true,
                        visible: true,
                        body: json!({ "role": "assistant", "content": format!("earlier answer {run_no}") }),
                        prompt: None,
                    })
                    .await
                    .expect("seed assistant row");
                return RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                    content: format!("earlier answer {run_no}"),
                    report_content: None,
                    termination: None,
                    iterations: 1,
                    tool_calls_total: 0,
                    stop_reason: None,
                }));
            }
            let compacted = turn.history.compact().await.expect("pre-prompt compaction succeeds");
            assert!(compacted.is_some(), "prior conversation must be compacted before refusal");
            if self.emit_image_card {
                // Simulate `turn.rs::show_picture` emitting visible image card rows after compaction shrank rows
                // so total stored row count can match pre-turn count, while visible output was shown to the user.
                turn.report.mark_output();
                turn.port
                    .commit_item(mixdog_core_session::session::ItemCommit {
                        iid: ItemId::from("img-card-call"),
                        role: Some("assistant".into()),
                        model: true,
                        visible: true,
                        body: json!({
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [{ "id": "call-img-1", "name": "media", "arguments": { "prompt": "cat" } }]
                        }),
                        prompt: None,
                    })
                    .await
                    .expect("image card assistant row");
                turn.port
                    .commit_item(mixdog_core_session::session::ItemCommit {
                        iid: ItemId::from("img-card-result"),
                        role: Some("tool".into()),
                        model: true,
                        visible: true,
                        body: json!({ "role": "tool", "tool_call_id": "call-img-1", "content": "{\"ok\":true}" }),
                        prompt: None,
                    })
                    .await
                    .expect("image card tool row");
            }
            RunOutcome::Failed(TurnError {
                message: "Gemini has been disabled in this account".to_owned(),
                data: json!({ "reason": "acpAgentAccount" }),
                provider_error: None,
            })
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            None
        }
    }

    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "outside", "model": "default", "fallbacks": [{ "provider": "scripted", "model": "m" }] }],
        "providers": { "scripted": { "enabled": true } },
    });

    // (a) Pre-prompt compaction shrinks row count before pre-output refusal: failover MUST still happen.
    let agent = Arc::new(CompactingAcp { emit_image_card: false, runs: Mutex::new(0) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let fallback = scripted(&["answered after compaction failover"]);
    let providers = GatedProviders::new(vec![("scripted", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    let world = turn_world_routed(
        fallback.clone(),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        None,
        Arc::new(MockFileService::default()),
        true,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        None,
        Some(routed(providers, config.clone())),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
    let completed_count = |w: &World, tid: &ThreadId, status: &str| {
        w.rig.feeds.frames(tid.as_str()).iter().filter(|(_, method, params)| *method == "turn/completed" && params["turn"]["status"] == status).count()
    };
    for (op, prompt, want) in [("op-seed-1", "earlier question 1", 1), ("op-seed-2", "earlier question 2", 2)] {
        handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("seed turn");
        eventually_on_awaiting(|| format!("seed turn {want} done"), &[handle.stepped()], || (completed_count(&world, &id, "completed") >= want).then_some(()))
            .await;
    }
    *lock(&world.rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "summary of earlier turns" })]);
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-compact-failover", "input": { "prompt": "go" } }), "op-compact-failover"))
        .await
        .expect("turn/start");
    eventually_on_awaiting(
        || "turn completed after compaction + failover".to_owned(),
        &[handle.stepped()],
        || (completed_count(&world, &id, "completed") >= 3).then_some(()),
    )
    .await;
    assert_eq!(*lock(&agent.runs), 3);
    assert_eq!(lock(&fallback.requests).len(), 1, "compaction before pre-output refusal must still fail over to HTTP");
    assert_eq!(handle.live_header().header()["provider"], "scripted");

    // (b) Compaction + visible image card preserves/changes row count, yet MUST block failover.
    let agent2 = Arc::new(CompactingAcp { emit_image_card: true, runs: Mutex::new(0) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent2.clone()));
    let fallback2 = scripted(&["must not run after image card"]);
    let providers2 = GatedProviders::new(vec![("scripted", fallback2.clone() as Arc<dyn ProviderAdapter>)]);
    let world2 = turn_world_routed(
        fallback2.clone(),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        None,
        Arc::new(MockFileService::default()),
        true,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        None,
        Some(routed(providers2, config)),
    )
    .await;
    let (id2, handle2) = started_thread(&world2, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
    for (op, prompt, want) in [("op-seed2-1", "earlier question 1", 1), ("op-seed2-2", "earlier question 2", 2)] {
        handle2.request(request("turn/start", json!({ "threadId": id2, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("seed turn");
        eventually_on_awaiting(
            || format!("seed2 turn {want} done"),
            &[handle2.stepped()],
            || (completed_count(&world2, &id2, "completed") >= want).then_some(()),
        )
        .await;
    }
    *lock(&world2.rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "summary of earlier turns" })]);
    handle2
        .request(request("turn/start", json!({ "threadId": id2, "opId": "op-card-no-failover", "input": { "prompt": "draw" } }), "op-card-no-failover"))
        .await
        .expect("turn/start");
    eventually_on_awaiting(
        || "turn failed after image card output".to_owned(),
        &[handle2.stepped()],
        || (completed_count(&world2, &id2, "failed") >= 1).then_some(()),
    )
    .await;
    assert_eq!(*lock(&agent2.runs), 3);
    assert!(lock(&fallback2.requests).is_empty(), "visible image card output must block failover even if row count matches");
    assert_eq!(handle2.live_header().header()["provider"], "outside");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pre_output_acp_failover_unsets_freshly_saved_acp_session() {
    struct SavingSessionRefusingAcp {
        saw_acp_session: Mutex<bool>,
    }

    #[async_trait]
    impl OutsideAgents for SavingSessionRefusingAcp {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            header.get("provider").and_then(Value::as_str) == Some("outside")
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            // Simulate `turn.rs:1944` saving `acpSession` on a fresh session right before the refusal arrives.
            let mut set = serde_json::Map::new();
            set.insert("acpSession".to_owned(), json!({ "agent": "outside", "sessionId": "fresh-acp-1" }));
            turn.port
                .save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() })
                .await
                .expect("save acpSession");
            RunOutcome::Failed(TurnError { message: "account refused".to_owned(), data: json!({ "reason": "acpAgentAccount" }), provider_error: None })
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            let has = header.contains_key("acpSession");
            *lock(&self.saw_acp_session) = has;
            has.then(|| mixdog_store::schema::record::HeaderChange { set: Default::default(), unset: vec!["acpSession".to_owned()], patch: Default::default() })
        }
    }

    let agent = Arc::new(SavingSessionRefusingAcp { saw_acp_session: Mutex::new(false) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let fallback = scripted(&["fallback ok"]);
    let providers = GatedProviders::new(vec![("scripted", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "outside", "model": "default", "fallbacks": [{ "provider": "scripted", "model": "m" }] }],
        "providers": { "scripted": { "enabled": true } },
    });
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
    assert!(handle.live_header().header().get("acpSession").is_none(), "fresh session starts without acpSession");
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-unset-acp", "input": { "prompt": "go" } }), "op-unset-acp"))
        .await
        .expect("turn/start");
    let finished = || {
        world
            .rig
            .feeds
            .frames(id.as_str())
            .iter()
            .any(|(_, method, params)| method == "turn/completed" && params["turn"]["status"] == "completed")
            .then_some(())
    };
    eventually_on_awaiting(|| "turn completed on http fallback".to_owned(), &[handle.stepped()], finished).await;

    assert!(*lock(&agent.saw_acp_session), "leave_agent must receive the live header containing freshly saved acpSession");
    let header = handle.live_header().header();
    assert_eq!(header["provider"], "scripted");
    assert!(header.get("acpSession").is_none(), "freshly saved acpSession must be unset after failover: {header:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_during_acp_fallback_probe_interrupts_and_reclaims_prompt() {
    struct RefusingAcp {
        leave_called: Mutex<bool>,
    }

    #[async_trait]
    impl OutsideAgents for RefusingAcp {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            header.get("provider").and_then(Value::as_str) == Some("outside")
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            let mut set = serde_json::Map::new();
            set.insert("acpSession".to_owned(), json!({ "agent": "outside", "sessionId": "probe-cancel-acp-1" }));
            turn.port
                .save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() })
                .await
                .expect("save acpSession");
            RunOutcome::Failed(TurnError { message: "account refused".to_owned(), data: json!({ "reason": "acpAgentAccount" }), provider_error: None })
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            *lock(&self.leave_called) = true;
            header.contains_key("acpSession").then(|| mixdog_store::schema::record::HeaderChange {
                set: Default::default(),
                unset: vec!["acpSession".to_owned()],
                patch: Default::default(),
            })
        }
    }

    struct BlockingProbeProviders {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        adapter: Arc<dyn ProviderAdapter>,
    }

    #[async_trait]
    impl mixdog_ai::registry::providers::ProviderBuilder for BlockingProbeProviders {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            if name == "scripted" {
                self.entered.notify_waiters();
                self.release.notified().await;
                Ok(self.adapter.clone())
            } else {
                Err(format!("unknown provider: {name}"))
            }
        }
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, name: &str) -> bool {
            name == "scripted"
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(true)
        }
    }

    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let fallback = scripted(&["never"]);
    let providers: Arc<dyn mixdog_ai::registry::providers::ProviderBuilder> =
        Arc::new(BlockingProbeProviders { entered: entered.clone(), release: release.clone(), adapter: fallback.clone() });
    let agent = Arc::new(RefusingAcp { leave_called: Mutex::new(false) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "outside", "model": "default", "fallbacks": [{ "provider": "scripted", "model": "m" }] }],
        "providers": { "scripted": { "enabled": true } },
    });
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
    let probe_wait = entered.notified();
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-cancel-probe", "input": { "prompt": "hello" } }), "op-cancel-probe"))
        .await
        .expect("turn/start");
    tokio::time::timeout(std::time::Duration::from_secs(5), probe_wait).await.expect("fallback probe entered");

    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: None, ctx }).await.expect("stop");
    let ended = || {
        world
            .rig
            .feeds
            .frames(id.as_str())
            .into_iter()
            .find_map(|(_, method, params)| (method == "turn/completed").then(|| params["turn"]["status"].as_str().unwrap_or_default().to_owned()))
    };
    let status = eventually_on_awaiting(|| "turn interrupted during fallback probe".to_owned(), &[handle.stepped()], ended).await;
    release.notify_waiters();

    assert_eq!(status, "interrupted", "cancellation during fallback probe must interrupt rather than fail");
    assert!(!*lock(&agent.leave_called), "cancelling before route write must not call leave_agent");
    let header = handle.live_header().header();
    assert_eq!(header["provider"], "outside");
    assert!(header.contains_key("acpSession"), "acpSession must stay intact when cancelled before route write: {header:?}");
    let records = world.rig.store.records(&id);
    assert!(records.iter().any(|(_, r)| matches!(r, Record::Rewind(_))), "unanswered prompt must be reclaimed on cancel during fallback probe: {records:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_after_fallback_route_write_unsets_acp_session_and_interrupts() {
    struct SavingSessionRefusingAcp {
        saw_acp_session: Mutex<bool>,
    }

    #[async_trait]
    impl OutsideAgents for SavingSessionRefusingAcp {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            header.get("provider").and_then(Value::as_str) == Some("outside")
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            let mut set = serde_json::Map::new();
            set.insert("acpSession".to_owned(), json!({ "agent": "outside", "sessionId": "post-write-cancel-acp-1" }));
            turn.port
                .save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() })
                .await
                .expect("save acpSession");
            RunOutcome::Failed(TurnError { message: "account refused".to_owned(), data: json!({ "reason": "acpAgentAccount" }), provider_error: None })
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            let has = header.contains_key("acpSession");
            *lock(&self.saw_acp_session) = has;
            has.then(|| mixdog_store::schema::record::HeaderChange { set: Default::default(), unset: vec!["acpSession".to_owned()], patch: Default::default() })
        }
    }

    /// Serves the first fallback (`scripted`) immediately so `route_hop.decide` writes the fallback route,
    /// then blocks inside the post-write `refresh_has_fallbacks` probe when lazily building the second fallback (`openai-oauth`).
    struct PostWriteBlockingProviders {
        post_write_entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        adapter: Arc<dyn ProviderAdapter>,
    }

    #[async_trait]
    impl mixdog_ai::registry::providers::ProviderBuilder for PostWriteBlockingProviders {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            match name {
                "scripted" => Ok(self.adapter.clone()),
                "openai-oauth" => {
                    self.post_write_entered.notify_waiters();
                    self.release.notified().await;
                    Ok(self.adapter.clone())
                }
                other => Err(format!("unknown provider: {other}")),
            }
        }
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, name: &str) -> bool {
            matches!(name, "scripted" | "openai-oauth")
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(true)
        }
    }

    let post_write_entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let fallback = scripted(&["never"]);
    let providers: Arc<dyn mixdog_ai::registry::providers::ProviderBuilder> =
        Arc::new(PostWriteBlockingProviders { post_write_entered: post_write_entered.clone(), release: release.clone(), adapter: fallback.clone() });
    let agent = Arc::new(SavingSessionRefusingAcp { saw_acp_session: Mutex::new(false) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "outside",
            "model": "default",
            "fallbacks": [
                { "provider": "scripted", "model": "m" },
                { "provider": "openai-oauth", "model": "m2" }
            ]
        }],
        "providers": { "scripted": { "enabled": true } },
    });
    let world = turn_world_routed(
        fallback.clone(),
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
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
    let post_write_wait = post_write_entered.notified();
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-cancel-post-write", "input": { "prompt": "hello" } }), "op-cancel-post-write"))
        .await
        .expect("turn/start");
    tokio::time::timeout(std::time::Duration::from_secs(5), post_write_wait).await.expect("post-write refresh_has_fallbacks probe entered");
    // Confirm the fallback route write has already landed while `acpSession` is still attached before Stop.
    let mid_header = handle.live_header().header();
    assert_eq!(mid_header["provider"], "scripted");
    assert!(mid_header.contains_key("acpSession"));

    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: None, ctx }).await.expect("stop");
    let ended = || {
        world
            .rig
            .feeds
            .frames(id.as_str())
            .into_iter()
            .find_map(|(_, method, params)| (method == "turn/completed").then(|| params["turn"]["status"].as_str().unwrap_or_default().to_owned()))
    };
    let status = eventually_on_awaiting(|| "turn interrupted after fallback route write".to_owned(), &[handle.stepped()], ended).await;
    release.notify_waiters();

    assert_eq!(status, "interrupted", "cancellation after fallback route write must return interrupted");
    assert!(*lock(&agent.saw_acp_session), "leave_agent must run with the old ACP header when cancelled after route write");
    let header = handle.live_header().header();
    assert_eq!(header["provider"], "scripted", "fallback route remains persisted");
    assert!(header.get("acpSession").is_none(), "acpSession must be unset on the fallback route after post-write cancel: {header:?}");
    let records = world.rig.store.records(&id);
    assert!(records.iter().any(|(_, r)| matches!(r, Record::Rewind(_))), "unanswered prompt must be reclaimed on post-write cancel: {records:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_during_handoff_leave_agent_unsets_acp_session_and_interrupts() {
    struct StopOnLeaveAcp {
        stop_handle: Mutex<Option<Arc<mixdog_core_session::session::SessionHandle>>>,
        fallback_runs: Mutex<usize>,
        saw_acp_session: Mutex<bool>,
    }

    #[async_trait]
    impl OutsideAgents for StopOnLeaveAcp {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            matches!(header.get("provider").and_then(Value::as_str), Some("outside" | "acp-agent"))
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            match turn.header.get("provider").and_then(Value::as_str) {
                Some("outside") => {
                    let mut set = serde_json::Map::new();
                    set.insert("acpSession".to_owned(), json!({ "agent": "outside", "sessionId": "handoff-cancel-acp-1" }));
                    turn.port
                        .save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() })
                        .await
                        .expect("save acpSession");
                    RunOutcome::Failed(TurnError { message: "account refused".to_owned(), data: json!({ "reason": "acpAgentAccount" }), provider_error: None })
                }
                Some("acp-agent") => {
                    *lock(&self.fallback_runs) += 1;
                    RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                        content: "should not run after stop".into(),
                        report_content: None,
                        termination: None,
                        iterations: 1,
                        tool_calls_total: 0,
                        stop_reason: None,
                    }))
                }
                other => panic!("unexpected outside provider {other:?}"),
            }
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            let has = header.contains_key("acpSession");
            *lock(&self.saw_acp_session) = has;
            // Fire a real Stop right before `leave_agent` persists the `acpSession` unset on the handoff path.
            if let Some(handle) = lock(&self.stop_handle).take() {
                tokio::task::block_in_place(|| {
                    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
                    tokio::runtime::Handle::current()
                        .block_on(handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: None, ctx }))
                        .expect("stop during handoff");
                });
            }
            has.then(|| mixdog_store::schema::record::HeaderChange { set: Default::default(), unset: vec!["acpSession".to_owned()], patch: Default::default() })
        }
    }

    // (a) SwitchOutside: ACP -> ACP fallback cancelled during handoff before `leave_agent` saves the header change.
    {
        let agent = Arc::new(StopOnLeaveAcp { stop_handle: Mutex::new(None), fallback_runs: Mutex::new(0), saw_acp_session: Mutex::new(false) });
        outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
        let fallback = scripted(&["unused"]);
        let providers = GatedProviders::new(vec![("scripted", fallback.clone() as Arc<dyn ProviderAdapter>)]);
        let config = json!({
            "default": "lead-route",
            "presets": [{ "id": "lead-route", "provider": "outside", "model": "default", "fallbacks": [{ "provider": "acp-agent", "model": "default" }] }],
            "providers": {},
        });
        let world = turn_world_routed(
            fallback,
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
            None,
            Some(routed(providers, config)),
        )
        .await;
        let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
        *lock(&agent.stop_handle) = Some(handle.clone());
        handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-handoff-outside", "input": { "prompt": "hello" } }), "op-handoff-outside"))
            .await
            .expect("turn/start");
        let ended = || {
            world
                .rig
                .feeds
                .frames(id.as_str())
                .into_iter()
                .find_map(|(_, method, params)| (method == "turn/completed").then(|| params["turn"]["status"].as_str().unwrap_or_default().to_owned()))
        };
        let status = eventually_on_awaiting(|| "SwitchOutside interrupted on handoff stop".to_owned(), &[handle.stepped()], ended).await;
        assert_eq!(status, "interrupted", "SwitchOutside cancelled during handoff must return interrupted, not failed");
        assert!(*lock(&agent.saw_acp_session), "leave_agent must receive old header with acpSession");
        assert_eq!(*lock(&agent.fallback_runs), 0, "cancelled SwitchOutside must not start the fallback ACP run");
        let header = handle.live_header().header();
        assert_eq!(header["provider"], "acp-agent", "fallback outside route remains persisted");
        assert!(header.get("acpSession").is_none(), "acpSession must be unset on SwitchOutside handoff cancel: {header:?}");
        let records = world.rig.store.records(&id);
        assert!(records.iter().any(|(_, r)| matches!(r, Record::Rewind(_))), "unanswered prompt must be reclaimed on cancelled SwitchOutside: {records:?}");
    }

    // (b) SwitchLoop: ACP -> HTTP fallback cancelled during `leave_after_assemble` handoff.
    {
        let agent = Arc::new(StopOnLeaveAcp { stop_handle: Mutex::new(None), fallback_runs: Mutex::new(0), saw_acp_session: Mutex::new(false) });
        outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
        let fallback = scripted(&["should not run"]);
        let providers = GatedProviders::new(vec![("scripted", fallback.clone() as Arc<dyn ProviderAdapter>)]);
        let config = json!({
            "default": "lead-route",
            "presets": [{ "id": "lead-route", "provider": "outside", "model": "default", "fallbacks": [{ "provider": "scripted", "model": "m" }] }],
            "providers": { "scripted": { "enabled": true } },
        });
        let world = turn_world_routed(
            fallback.clone(),
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
            None,
            Some(routed(providers, config)),
        )
        .await;
        let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
        *lock(&agent.stop_handle) = Some(handle.clone());
        handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-handoff-loop", "input": { "prompt": "hello" } }), "op-handoff-loop"))
            .await
            .expect("turn/start");
        let ended = || {
            world
                .rig
                .feeds
                .frames(id.as_str())
                .into_iter()
                .find_map(|(_, method, params)| (method == "turn/completed").then(|| params["turn"]["status"].as_str().unwrap_or_default().to_owned()))
        };
        let status = eventually_on_awaiting(|| "SwitchLoop interrupted on handoff stop".to_owned(), &[handle.stepped()], ended).await;
        assert_eq!(status, "interrupted", "SwitchLoop cancelled during handoff must return interrupted, not failed");
        assert!(*lock(&agent.saw_acp_session), "leave_agent must receive old header with acpSession");
        assert!(lock(&fallback.requests).is_empty(), "cancelled SwitchLoop must not start the HTTP fallback run");
        let header = handle.live_header().header();
        assert_eq!(header["provider"], "scripted", "fallback HTTP route remains persisted");
        assert!(header.get("acpSession").is_none(), "acpSession must be unset on SwitchLoop handoff cancel: {header:?}");
        let records = world.rig.store.records(&id);
        assert!(records.iter().any(|(_, r)| matches!(r, Record::Rewind(_))), "unanswered prompt must be reclaimed on cancelled SwitchLoop: {records:?}");
    }

    // (c) Stop arriving after `leave_agent` / `port.notice` right before the second `SwitchOutside` dispatch
    // must still return `Interrupted`, reclaim the unanswered prompt, and never invoke `agents.run` on the fallback agent.
    {
        struct StopBeforeSecondDispatchAcp {
            stop_handle: Mutex<Option<Arc<mixdog_core_session::session::SessionHandle>>>,
            prompt_checks: Mutex<usize>,
            fallback_runs: Mutex<usize>,
        }

        #[async_trait]
        impl OutsideAgents for StopBeforeSecondDispatchAcp {
            fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
                matches!(header.get("provider").and_then(Value::as_str), Some("outside" | "acp-agent"))
            }
            fn prompts(&self, _: &Value) -> bool {
                let mut checks = lock(&self.prompt_checks);
                *checks += 1;
                // Second `drive_outside` entry (after `leave_agent` + `port.notice` in `SwitchOutside`):
                // fire Stop before `agents.run(begun)` is reached.
                if *checks == 2
                    && let Some(handle) = lock(&self.stop_handle).take()
                {
                    tokio::task::block_in_place(|| {
                        let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
                        tokio::runtime::Handle::current()
                            .block_on(handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: None, ctx }))
                            .expect("stop before second dispatch");
                    });
                }
                true
            }
            async fn run(&self, turn: OutsideTurn) -> RunOutcome {
                match turn.header.get("provider").and_then(Value::as_str) {
                    Some("outside") => {
                        let mut set = serde_json::Map::new();
                        set.insert("acpSession".to_owned(), json!({ "agent": "outside", "sessionId": "notice-cancel-acp-1" }));
                        turn.port
                            .save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() })
                            .await
                            .expect("save acpSession");
                        RunOutcome::Failed(TurnError {
                            message: "account refused".to_owned(),
                            data: json!({ "reason": "acpAgentAccount" }),
                            provider_error: None,
                        })
                    }
                    Some("acp-agent") => {
                        *lock(&self.fallback_runs) += 1;
                        RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                            content: "should never run".into(),
                            report_content: None,
                            termination: None,
                            iterations: 1,
                            tool_calls_total: 0,
                            stop_reason: None,
                        }))
                    }
                    other => panic!("unexpected outside provider {other:?}"),
                }
            }
            async fn unrun(&self, _: &ThreadId, _: &str) {}
            fn loop_turn(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
                header.contains_key("acpSession").then(|| mixdog_store::schema::record::HeaderChange {
                    set: Default::default(),
                    unset: vec!["acpSession".to_owned()],
                    patch: Default::default(),
                })
            }
        }

        let agent = Arc::new(StopBeforeSecondDispatchAcp { stop_handle: Mutex::new(None), prompt_checks: Mutex::new(0), fallback_runs: Mutex::new(0) });
        outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
        let fallback = scripted(&["unused"]);
        let providers = GatedProviders::new(vec![("scripted", fallback.clone() as Arc<dyn ProviderAdapter>)]);
        let config = json!({
            "default": "lead-route",
            "presets": [{ "id": "lead-route", "provider": "outside", "model": "default", "fallbacks": [{ "provider": "acp-agent", "model": "default" }] }],
            "providers": {},
        });
        let world = turn_world_routed(
            fallback,
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
            None,
            Some(routed(providers, config)),
        )
        .await;
        let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;
        *lock(&agent.stop_handle) = Some(handle.clone());
        handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-notice-stop", "input": { "prompt": "hello" } }), "op-notice-stop"))
            .await
            .expect("turn/start");
        let ended = || {
            world
                .rig
                .feeds
                .frames(id.as_str())
                .into_iter()
                .find_map(|(_, method, params)| (method == "turn/completed").then(|| params["turn"]["status"].as_str().unwrap_or_default().to_owned()))
        };
        let status = eventually_on_awaiting(|| "SwitchOutside interrupted before second dispatch".to_owned(), &[handle.stepped()], ended).await;
        assert_eq!(status, "interrupted", "stop before second SwitchOutside dispatch must return interrupted");
        assert_eq!(*lock(&agent.prompt_checks), 2, "must have reached second drive_outside after leave_agent and port.notice");
        assert_eq!(*lock(&agent.fallback_runs), 0, "agents.run must never be invoked when already cancelled before dispatch");
        let header = handle.live_header().header();
        assert_eq!(header["provider"], "acp-agent");
        assert!(header.get("acpSession").is_none(), "acpSession must stay unset: {header:?}");
        let records = world.rig.store.records(&id);
        assert!(records.iter().any(|(_, r)| matches!(r, Record::Rewind(_))), "unanswered prompt must be reclaimed: {records:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chained_acp_http_acp_handoff_preserves_preloaded_skill_rows() {
    struct MockSkillTool {
        spec: ToolSpec,
        calls: Arc<Mutex<usize>>,
    }

    #[async_trait]
    impl Tool for MockSkillTool {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        async fn call(&self, _: &ToolContext, args: JsonValue) -> ToolOutcome {
            *lock(&self.calls) += 1;
            let name = args["name"].as_str().unwrap_or_default();
            Ok(ToolOutput {
                parts: vec![ToolPart::Text(format!("Loaded skill: {name}"))],
                follow_up_messages: vec![mixdog_core_api::domain::tool::FollowUpMessage {
                    text: format!("<skill>\n<name>{name}</name>\nSKILL-BODY-42\n</skill>"),
                    meta: None,
                }],
                ..ToolOutput::default()
            })
        }
    }

    struct TwoStageAcp {
        acp1_inputs: Mutex<Vec<Value>>,
        acp2_inputs: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl OutsideAgents for TwoStageAcp {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            matches!(header.get("provider").and_then(Value::as_str), Some("outside" | "acp-agent"))
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            match turn.header.get("provider").and_then(Value::as_str) {
                Some("outside") => {
                    lock(&self.acp1_inputs).push(turn.input);
                    RunOutcome::Failed(TurnError {
                        message: "acp-one account refused".to_owned(),
                        data: json!({ "reason": "acpAgentAccount" }),
                        provider_error: None,
                    })
                }
                Some("acp-agent") => {
                    lock(&self.acp2_inputs).push(turn.input);
                    RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                        content: "done on acp-two".into(),
                        report_content: None,
                        termination: None,
                        iterations: 1,
                        tool_calls_total: 0,
                        stop_reason: None,
                    }))
                }
                other => panic!("unexpected outside provider {other:?}"),
            }
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            None
        }
    }

    let skill_calls = Arc::new(Mutex::new(0));
    let skill_tool: Arc<dyn Tool> = Arc::new(MockSkillTool {
        spec: ToolSpec {
            name: "Skill".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "Skill".into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        },
        calls: skill_calls.clone(),
    });
    let agent = Arc::new(TwoStageAcp { acp1_inputs: Mutex::new(Vec::new()), acp2_inputs: Mutex::new(Vec::new()) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));

    let http_inner = scripted(&["never"]);
    let http_fail = ArmedRefusal::new(http_inner);
    *lock(&http_fail.refusal) = Some(ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::RateLimited, DeliveryState::NotSent));
    let providers = GatedProviders::new(vec![("scripted", http_fail.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "outside",
            "model": "default",
            "fallbacks": [
                { "provider": "scripted", "model": "m" },
                { "provider": "acp-agent", "model": "default" }
            ]
        }],
        "providers": { "scripted": { "enabled": true } },
    });
    let world = turn_world_routed(
        scripted(&["unused"]),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        Some(vec![skill_tool]),
        Arc::new(MockFileService::default()),
        false,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(
        &world,
        json!({
            "provider": "outside",
            "model": "default",
            "agent": "lead",
            "tools": [{ "name": "Skill" }],
            "availableSkills": ["demo-skill"],
        }),
    )
    .await;
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-chain", "input": { "prompt": "please use $demo-skill" } }), "op-chain"))
        .await
        .expect("turn/start");
    let finished = || {
        world
            .rig
            .feeds
            .frames(id.as_str())
            .iter()
            .any(|(_, method, params)| method == "turn/completed" && params["turn"]["status"] == "completed")
            .then_some(())
    };
    eventually_on_awaiting(|| "chained ACP->HTTP->ACP turn completed".to_owned(), &[handle.stepped()], finished).await;

    assert_eq!(*lock(&skill_calls), 1, "skill must be preloaded once and reused across hops");
    let acp1 = lock(&agent.acp1_inputs);
    let acp2 = lock(&agent.acp2_inputs);
    assert_eq!(acp1.len(), 1);
    assert_eq!(acp2.len(), 1);
    assert!(acp1[0].to_string().contains("SKILL-BODY-42"), "acp-one received skill: {:?}", acp1[0]);
    assert!(acp2[0].to_string().contains("SKILL-BODY-42"), "acp-two must preserve preloaded skill across HTTP hop: {:?}", acp2[0]);
    assert_eq!(handle.live_header().header()["provider"], "acp-agent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_skill_selection_skips_retried_and_injected_turns() {
    struct CountingSkillTool {
        spec: ToolSpec,
        calls: Arc<Mutex<usize>>,
    }

    #[async_trait]
    impl Tool for CountingSkillTool {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        async fn call(&self, _: &ToolContext, args: JsonValue) -> ToolOutcome {
            *lock(&self.calls) += 1;
            let name = args["name"].as_str().unwrap_or_default();
            Ok(ToolOutput {
                parts: vec![ToolPart::Text(format!("Loaded skill: {name}"))],
                follow_up_messages: vec![mixdog_core_api::domain::tool::FollowUpMessage {
                    text: format!("<skill>\n<name>{name}</name>\nLOADED\n</skill>"),
                    meta: None,
                }],
                ..ToolOutput::default()
            })
        }
    }

    struct ScriptedOutside {
        fail_first: std::sync::atomic::AtomicBool,
        inputs: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl OutsideAgents for ScriptedOutside {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            header.get("provider").and_then(Value::as_str) == Some("outside")
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            lock(&self.inputs).push(turn.input);
            if self.fail_first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                // Commit a user row carrying `messageId` right before failing so `retained_retry_input` finds it on Turn 2.
                turn.port
                    .commit_item(mixdog_core_session::session::ItemCommit {
                        iid: ItemId::from("failed-user-row"),
                        role: Some("user".into()),
                        model: true,
                        visible: true,
                        body: json!({
                            "role": "user",
                            "content": "run $demo-skill",
                            "meta": { "transcript": { "messageId": "m-retry-1" } }
                        }),
                        prompt: None,
                    })
                    .await
                    .expect("commit failed user row");
                return RunOutcome::Failed(TurnError { message: "boom".into(), data: Value::Null, provider_error: None });
            }
            RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                content: "ok".into(),
                report_content: None,
                termination: None,
                iterations: 1,
                tool_calls_total: 0,
                stop_reason: None,
            }))
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            None
        }
    }

    let skill_calls = Arc::new(Mutex::new(0));
    let skill_tool: Arc<dyn Tool> = Arc::new(CountingSkillTool {
        spec: ToolSpec {
            name: "Skill".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "Skill".into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        },
        calls: skill_calls.clone(),
    });
    let agent = Arc::new(ScriptedOutside { fail_first: std::sync::atomic::AtomicBool::new(true), inputs: Mutex::new(Vec::new()) });
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));

    let world = turn_world_routed(
        scripted(&["unused"]),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        Some(vec![skill_tool]),
        Arc::new(MockFileService::default()),
        false,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        None,
        None,
    )
    .await;
    let (id, handle) = started_thread(
        &world,
        json!({
            "provider": "outside",
            "model": "default",
            "tools": [{ "name": "Skill" }],
            "availableSkills": ["demo-skill"],
        }),
    )
    .await;

    let completed_count = || world.rig.feeds.frames(id.as_str()).iter().filter(|(_, method, _)| *method == "turn/completed").count();

    // Turn 1: seeds a failed user message (`m-retry-1`) without triggering skill selection.
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-t1", "input": { "prompt": "seed" } }), "op-t1")).await.expect("turn 1");
    eventually_on_awaiting(|| "turn 1 failed".to_owned(), &[handle.stepped()], || (completed_count() >= 1).then_some(())).await;
    assert_eq!(*lock(&skill_calls), 0, "seed turn did not invoke skill selection");

    // Turn 2: retried failed turn (`retried == true`) must reach the agent and skip explicit skill selection.
    let retry_attempt_id = handle
        .model_messages(None)
        .await
        .expect("model messages")
        .into_iter()
        .rev()
        .find_map(|body| body.pointer("/meta/transcript/completion/attemptId").and_then(Value::as_str).map(str::to_owned))
        .expect("turn 1 failed row has completion.attemptId");
    handle
        .request(request(
            "turn/start",
            json!({
                "threadId": id,
                "opId": "op-t2",
                "input": {
                    "prompt": "run $demo-skill",
                    "options": { "retryFailedTurn": true, "retryTurnId": "m-retry-1", "retryAttemptId": retry_attempt_id }
                }
            }),
            "op-t2",
        ))
        .await
        .expect("turn 2 retry");
    eventually_on_awaiting(|| "turn 2 finished".to_owned(), &[handle.stepped()], || (completed_count() >= 2).then_some(())).await;
    assert_eq!(lock(&agent.inputs).len(), 2, "retried turn must reach the outside agent");
    assert_eq!(*lock(&skill_calls), 0, "retried outside turn must skip skill selection");

    // Turn 3: injected channel/task-notification turn mentioning `$demo-skill` must skip explicit skill selection.
    assert!(world.directory.queue_channel_notification(&id, "done: please check $demo-skill".into()).await, "queue injected channel notification");
    eventually_on_awaiting(|| "turn 3 injected finished".to_owned(), &[handle.stepped()], || (completed_count() >= 3).then_some(())).await;
    assert_eq!(*lock(&skill_calls), 0, "injected outside turn must skip skill selection");

    // Turn 4: normal user prompt mentioning `$demo-skill` DOES select it (positive control).
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-t4", "input": { "prompt": "fresh run $demo-skill" } }), "op-t4"))
        .await
        .expect("turn 4 normal");
    eventually_on_awaiting(|| "turn 4 normal finished".to_owned(), &[handle.stepped()], || (completed_count() >= 4).then_some(())).await;
    assert_eq!(*lock(&skill_calls), 1, "normal outside turn must still run explicit skill selection");
    assert_eq!(lock(&agent.inputs).len(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_after_hidden_skill_preload_reclaims_unanswered_prompt() {
    struct MockSkillTool(ToolSpec);

    #[async_trait]
    impl Tool for MockSkillTool {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, args: JsonValue) -> ToolOutcome {
            let name = args["name"].as_str().unwrap_or_default();
            Ok(ToolOutput {
                parts: vec![ToolPart::Text(format!("Loaded skill: {name}"))],
                follow_up_messages: vec![mixdog_core_api::domain::tool::FollowUpMessage {
                    text: format!("<skill>\n<name>{name}</name>\nHIDDEN-PRELOAD\n</skill>"),
                    meta: None,
                }],
                ..ToolOutput::default()
            })
        }
    }

    struct WaitCancelAcp {
        entered: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl OutsideAgents for WaitCancelAcp {
        fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
            header.get("provider").and_then(Value::as_str) == Some("outside")
        }
        fn prompts(&self, _: &Value) -> bool {
            true
        }
        async fn run(&self, turn: OutsideTurn) -> RunOutcome {
            self.entered.notify_waiters();
            turn.cancel.cancelled().await;
            RunOutcome::Interrupted
        }
        async fn unrun(&self, _: &ThreadId, _: &str) {}
        fn loop_turn(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
            None
        }
    }

    let skill_tool: Arc<dyn Tool> = Arc::new(MockSkillTool(ToolSpec {
        name: "Skill".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "Skill".into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations::default(),
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }));
    let entered = Arc::new(tokio::sync::Notify::new());
    outside_tests::OUTSIDE.with(|slot| *slot.borrow_mut() = Some(Arc::new(WaitCancelAcp { entered: entered.clone() })));

    let world = turn_world_routed(
        scripted(&["unused"]),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        Some(vec![skill_tool]),
        Arc::new(MockFileService::default()),
        false,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        None,
        None,
    )
    .await;
    let (id, handle) = started_thread(
        &world,
        json!({
            "provider": "outside",
            "model": "default",
            "tools": [{ "name": "Skill" }],
            "availableSkills": ["demo-skill"],
        }),
    )
    .await;

    let entered_wait = entered.notified();
    handle
        .request(request(
            "turn/start",
            json!({ "threadId": id, "opId": "op-preload-stop", "input": { "prompt": "please use $demo-skill" } }),
            "op-preload-stop",
        ))
        .await
        .expect("turn/start");
    tokio::time::timeout(std::time::Duration::from_secs(5), entered_wait).await.expect("ACP run entered after hidden skill preload");

    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: None, ctx }).await.expect("stop");
    let interrupted = || {
        world
            .rig
            .feeds
            .frames(id.as_str())
            .iter()
            .any(|(_, method, params)| method == "turn/completed" && params["turn"]["status"] == "interrupted")
            .then_some(())
    };
    eventually_on_awaiting(|| "turn interrupted after hidden preload".to_owned(), &[handle.stepped()], interrupted).await;

    let records = world.rig.store.records(&id);
    assert!(
        records.iter().any(|(_, r)| matches!(r, Record::Rewind(_))),
        "hidden preloaded skill row must not block prompt reclamation on interrupt: {records:?}"
    );
}
