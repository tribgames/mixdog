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
        let config = json!({
            "default": "lead-route",
            "presets": [{ "id": "lead-route", "provider": "openai-oauth", "model": "m1", "fallbacks": [{ "provider": bridge, "model": "m2" }] }],
            "providers": { "openai-oauth": { "enabled": true }, bridge: { "enabled": true } },
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

        providers.set(bridge, false);
        settled_turn(&world, &id, &handle, "op-4", 4).await;
        assert_eq!(handle.live_header().header()["provider"], "openai-oauth");
        let returned = system_of(&lock(&direct.requests)[1]);
        assert_eq!(returned[..2], before[..2], "{bridge}: the direct route is sent the text it was sent before the hop");
        assert_eq!(returned, of_header(), "{bridge}: the returning turn was sent what the session holds");
    }
}
