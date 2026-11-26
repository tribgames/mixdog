//! `--route-profile` end to end: the boundary a profile builds, the roles it makes spawnable and the Lead fallback it gives the started thread.

use super::*;

/// The Terminal-Bench `fable-xhigh` routing profile, as the harness passes it.
const FABLE_PROFILE: &str = r#"{
  "leadFallback": { "provider": "anthropic-oauth", "model": "claude-opus-4-8", "effort": "xhigh", "fast": false },
  "routes": {
    "lead": { "provider": "anthropic-oauth", "model": "claude-fable-5", "effort": "xhigh", "fast": false },
    "worker": { "provider": "openai-oauth", "model": "gpt-5.6-terra", "effort": "high", "fast": true },
    "heavy-worker": { "provider": "openai-oauth", "model": "gpt-6.1-sol", "effort": "xhigh", "fast": true },
    "reviewer": { "provider": "openai-oauth", "model": "gpt-6.1-sol", "effort": "xhigh", "fast": true }
  }
}"#;

fn shipped_agents(dir: &Path, roles: &[&str]) -> PathBuf {
    let agents = dir.join("agents");
    for role in roles {
        std::fs::create_dir_all(agents.join(role)).unwrap();
        std::fs::write(agents.join(role).join("agent.json"), "{}").unwrap();
    }
    agents
}

fn profile_boundary(dir: &Path, profile: &str) -> Result<Boundary, String> {
    let host = dir.join("host-data");
    std::fs::create_dir_all(&host).unwrap();
    std::fs::write(host.join("anthropic-oauth-credentials.json"), "{}").unwrap();
    std::fs::write(host.join("openai-oauth.json"), "{}").unwrap();
    let agents = shipped_agents(dir, &["worker", "heavy-worker", "reviewer", "advisor", "explore"]);
    let tmp = dir.join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    Boundary::create(&BoundaryRequest {
        provider: "anthropic-oauth",
        model: "claude-fable-5",
        effort: Some("xhigh"),
        fast: false,
        provider_config: None,
        route_profile: Some(profile),
        agents_dir: &agents,
        agent_presets: &[],
        host_env: &BTreeMap::new(),
        host_data_dir: &host,
        temp_dir: &tmp,
        credentials: &Creds,
    })
}

struct NoBots;

#[async_trait]
impl mixdog_core_run::run_host::route_chain::BotRoutes for NoBots {
    async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
    async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
}

/// `--route-profile`: a multi-role profile reaches the run's config whole. A spawned worker, heavy worker and reviewer resolve
/// through the app's own route lookup (`configuredAgentRouteCandidates`, `resolveAgentSpawnPreset`) to the profile's routes, the
/// Lead's fallback is the default preset's chain, and the roles' provider is authenticated like the Lead's.
#[tokio::test]
async fn a_route_profiles_roles_resolve_as_spawned_agents_and_its_fallback_backs_the_lead() {
    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), FABLE_PROFILE).unwrap();
    let config = boundary.runtime_config.as_object().unwrap();
    let profile: Value = serde_json::from_str(FABLE_PROFILE).unwrap();
    for role in ["worker", "heavy-worker", "reviewer"] {
        let candidates =
            mixdog_core_run::run_host::route_chain::route_candidates(config, role, &NoBots).await.unwrap_or_else(|_| panic!("{role}: the config is read"));
        let spawn = mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset(config, &json!({ "agent": role }), &candidates).unwrap();
        let want = &profile["routes"][role];
        for key in ["provider", "model", "effort", "fast"] {
            assert_eq!(spawn.preset[key], want[key], "{role}: {key}");
        }
        assert_eq!(spawn.preset_name, json!(format!("AGENT {}", role.to_uppercase())), "{role}");
    }
    let lead = mixdog_ai::service::admin_route::find_preset(config, config.get("default")).unwrap();
    assert_eq!(lead["fallbacks"], json!([profile["leadFallback"]]));
    assert_eq!((&lead["provider"], &lead["model"]), (&json!("anthropic-oauth"), &json!("claude-fable-5")));
    assert_eq!(boundary.role_credentials.iter().map(|binding| binding.provider.as_str()).collect::<Vec<_>>(), ["openai-oauth"]);
    assert_eq!(boundary.role_credentials[0].path, dir.path().join("host-data").join("openai-oauth.json"));
    assert_eq!(boundary.runtime_config["providers"]["openai-oauth"], json!({ "enabled": true, "websocket": true }));
    assert_eq!(boundary.audit["routeProfile"]["agents"]["reviewer"]["model"], "gpt-6.1-sol");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// The headless Lead the exec starts on a route profile's boundary holds the `agent` tool (the session options
/// `thread/start` carries, written into its header as the core the exec established writes them), and the worker it
/// spawns resolves to the profile's route. The same Lead without a profile has no `agent` tool.
#[tokio::test]
async fn a_headless_lead_with_a_route_profile_can_spawn_a_worker_on_the_profiles_route() {
    let lead_surface = |boundary: &Boundary| {
        crate::exec::launcher::bind_exec_core(boundary);
        let route = crate::exec::Route { provider: "anthropic-oauth".into(), model: "claude-fable-5".into(), effort: Some("xhigh".into()), fast: false };
        let params = crate::exec::run::thread_start_params(&options(Path::new("/unused")), &route, crate::exec::run::delegates(boundary));
        let session: mixdog_app_protocol::v2::thread::ThreadSessionOptions = serde_json::from_value(params["session"].clone()).unwrap();
        let mut header = mixdog_store::schema::record::Header::new();
        mixdog_core_session::session::session_options::write_header(&session, &mut header);
        mixdog_tools::policy::surface::SessionSurface::from_header(&header, Vec::new())
    };
    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), FABLE_PROFILE).unwrap();
    assert!(lead_surface(&boundary).refusal("agent", None).is_none(), "the Lead may call agent");
    let config = boundary.runtime_config.as_object().unwrap();
    let candidates = mixdog_core_run::run_host::route_chain::route_candidates(config, "worker", &NoBots).await.unwrap_or_else(|_| panic!("the config is read"));
    let spawn = mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &candidates).unwrap();
    let want = json!({ "provider": "openai-oauth", "model": "gpt-5.6-terra", "effort": "high", "fast": true });
    for key in ["provider", "model", "effort", "fast"] {
        assert_eq!(spawn.preset[key], want[key], "{key}");
    }
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();

    let plain = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(plain.path(), r#"{"routes": {}}"#).unwrap();
    assert!(lead_surface(&boundary).refusal("agent", None).is_some(), "without roles the Lead has no agent tool");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// A profile the exec cannot apply fails before anything starts, naming what it cannot apply, and leaves no root.
#[test]
fn a_route_profile_the_exec_cannot_apply_is_refused_by_name() {
    let mut profile: Value = serde_json::from_str(FABLE_PROFILE).unwrap();
    let refused = |edit: &dyn Fn(&mut Value)| {
        let dir = tempfile::tempdir().unwrap();
        let mut changed = profile.clone();
        edit(&mut changed);
        let error = profile_boundary(dir.path(), &changed.to_string()).err().expect("refused");
        assert_eq!(std::fs::read_dir(dir.path().join("tmp")).unwrap().count(), 0, "{error}");
        error
    };
    let planner = refused(&|p| p["routes"]["planner"] = json!({ "provider": "openai-oauth", "model": "m" }));
    assert_eq!(planner, "--route-profile role \"planner\" is not an agent mixdog exec can run");
    let field = refused(&|p| p["routes"]["worker"]["contextTokens"] = json!(1000));
    assert_eq!(field, "--route-profile route \"worker\" field \"contextTokens\" cannot be applied by mixdog exec");
    let top = refused(&|p| p["notes"] = json!("x"));
    assert_eq!(top, "--route-profile field \"notes\" cannot be applied by mixdog exec");
    let lead = refused(&|p| p["routes"]["lead"]["model"] = json!("claude-opus-5"));
    assert!(lead.contains("route \"lead\""), "{lead}");
    let effort = refused(&|p| p["leadFallback"]["effort"] = json!("ultra"));
    assert_eq!(effort, "--route-profile route \"leadFallback\" field \"effort\" must be low, medium, high, xhigh, or max");
    let custom = refused(&|p| p["routes"]["worker"]["provider"] = json!("custom-x"));
    assert!(custom.contains("\"custom-x\""), "{custom}");
    // A role is the exact name of a shipped agent, never a path to one or another spelling of it.
    let elsewhere = tempfile::tempdir().unwrap();
    let outside = shipped_agents(elsewhere.path(), &["worker"]).join("worker");
    for role in ["../agents/worker", "./worker", "worker/", "Worker", outside.to_str().unwrap()] {
        let error = refused(&|p| p["routes"][role] = json!({ "provider": "openai-oauth", "model": "m" }));
        assert_eq!(error, format!("--route-profile role \"{role}\" is not an agent mixdog exec can run"));
    }
    // A route on a provider the core's config load drops (the retired local ones) is refused, by its name.
    for local in ["ollama", "lmstudio"] {
        let role = refused(&|p| p["routes"]["worker"]["provider"] = json!(local));
        assert_eq!(role, format!("--route-profile route \"worker\" provider \"{local}\" is not one mixdog exec can run"));
        let fallback = refused(&|p| p["leadFallback"]["provider"] = json!(local));
        assert_eq!(fallback, format!("--route-profile route \"leadFallback\" provider \"{local}\" is not one mixdog exec can run"));
    }
    // A provider behind a Developer option is unavailable on the run's config, which switches none on.
    for gated in ["cursor-oauth", "mimo-oauth", "antigravity-oauth"] {
        let role = refused(&|p| p["routes"]["reviewer"]["provider"] = json!(gated));
        assert_eq!(role, format!("--route-profile route \"reviewer\" provider \"{gated}\" is not one mixdog exec can run"));
        let fallback = refused(&|p| p["leadFallback"]["provider"] = json!(gated));
        assert_eq!(fallback, format!("--route-profile route \"leadFallback\" provider \"{gated}\" is not one mixdog exec can run"));
    }
    profile["routes"]["worker"]["provider"] = json!("xai");
    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), &profile.to_string()).unwrap();
    assert_eq!(boundary.runtime_config["providers"]["xai"]["apiKey"], "sk-test-key", "an API-key role provider's key is bound in memory");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// The Lead's own provider goes through the refusal every route does, with or without a profile, before anything is bound:
/// a retired local provider, or one behind a Developer option the run's config leaves off.
#[test]
fn a_lead_on_a_provider_the_core_drops_or_gates_is_refused() {
    for provider in ["ollama", "lmstudio", "cursor-oauth", "mimo-oauth", "antigravity-oauth"] {
        let lead = json!({ "provider": provider, "model": "m", "fast": false });
        let profile = json!({ "routes": { "lead": lead } }).to_string();
        for route_profile in [None, Some(profile.as_str())] {
            let dir = tempfile::tempdir().unwrap();
            let agents = shipped_agents(dir.path(), &["worker"]);
            let error = Boundary::create(&BoundaryRequest {
                provider,
                model: "m",
                effort: None,
                fast: false,
                provider_config: None,
                route_profile,
                agents_dir: &agents,
                agent_presets: &[],
                host_env: &BTreeMap::new(),
                host_data_dir: dir.path(),
                temp_dir: dir.path(),
                credentials: &Creds,
            })
            .err()
            .expect("refused");
            assert_eq!(error, format!("route \"lead\" provider \"{provider}\" is not one mixdog exec can run"), "{route_profile:?}");
            assert!(std::fs::read_dir(dir.path()).unwrap().flatten().all(|entry| entry.file_name() == "agents"), "no root is left");
        }
    }
}

/// `--route-profile` stands with the other value options, and a run whose profile gives roles routes lets the Lead delegate.
#[tokio::test]
async fn a_route_profile_on_the_command_line_opens_delegation() {
    let dir = tempfile::tempdir().unwrap();
    shipped_agents(dir.path(), &["worker"]);
    let profile = r#"{"routes": {"worker": {"provider": "openai", "model": "gpt-worker", "effort": "high", "fast": true}}}"#;
    let mut opts = parse(&["--provider", "openai", "--model", "gpt-test", "--route-profile", profile, "go"]).unwrap();
    assert_eq!(opts.route_profile.as_deref(), Some(profile));
    opts.usage_log = Some(dir.path().join("usage.json"));
    opts.json = true;
    let launcher = FakeLauncher::new("sess_profile", vec![Turn::Events(vec![assistant("done"), completed()])]);
    let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;
    assert_eq!((code, sink.stderr()), (0, Vec::<String>::new()));
    assert_eq!(launcher.calls()[0].1["session"]["disallowDelegation"], false);
    assert_eq!(json_lines(&sink)[0]["session"]["delegation"], true, "the session line reports the delegation the run has");
}

/// The config the run's core loads from the boundary's file (`Config::open`, the core's own load and migration).
async fn core_config(boundary: &Boundary) -> mixdog_core_config::config::Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let file = boundary.data_dir.join("mixdog-config.json");
    let (config, _) = mixdog_core_config::config::Config::open(&file, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
    config
}

mod adoption {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_ai::service::admin_route::Obj;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::WireRequest;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_domains::domains::ai_admin::chain::RouteFacts;
    use mixdog_core_domains::domains::ai_admin::route_service::LiveControls;
    use mixdog_core_domains::domains::ai_admin::route_service::SessionFollow;
    use mixdog_core_ports::ports::route::FollowOptions;
    use mixdog_core_ports::ports::route::Followed;
    use mixdog_core_ports::ports::route::Route;
    use mixdog_core_ports::ports::route_write::RouteWriter;
    use mixdog_tools::orch::util::PortError;
    use serde_json::Value;

    /// Every provider is ready and every model is one the catalog has not described.
    pub struct AnyModel;

    #[async_trait]
    impl RouteFacts for AnyModel {
        fn is_known(&self, _: &str, _: &Obj) -> bool {
            true
        }
        async fn ensure_ready(&self, _: &Obj, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn model_meta(&self, _: &str, _: &str) -> Value {
            Value::Null
        }
        fn window_meta(&self, _: &str, _: &str, _: &Value) -> Option<Value> {
            None
        }
        fn catalog_knows(&self, _: &str, _: &str) -> bool {
            true
        }
        fn fast_capable(&self, _: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
            true
        }
        fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
            false
        }
    }

    /// The live route of the thread being started.
    #[derive(Default)]
    pub struct Live(pub Mutex<Route>);

    #[async_trait]
    impl RouteWriter for Live {
        fn route(&self, _: &ThreadId) -> Route {
            self.0.lock().unwrap().clone()
        }
        fn set_route_state(&self, _: &ThreadId, route: Route) {
            *self.0.lock().unwrap() = route;
        }
        fn generation(&self, _: &ThreadId) -> u64 {
            0
        }
        async fn refresh_route_effort(&self, _: &ThreadId, _: Option<Value>, _: bool, _: Option<u64>) -> Result<Option<Route>, PortError> {
            Ok(None)
        }
        fn refresh_statusline_usage(&self, _: &ThreadId, _: &Route) {}
    }

    /// A thread that does not exist yet: nothing follows its route.
    pub struct Unborn;

    #[async_trait]
    impl SessionFollow for Unborn {
        fn open_lease(&self, _: &ThreadId, origin: Option<u64>) -> u64 {
            origin.unwrap_or(0)
        }
        async fn follow(&self, _: &ThreadId, _: &FollowOptions) -> Result<Followed, PortError> {
            Ok(Followed::default())
        }
        async fn tune(&self, _: &ThreadId) -> Result<(), PortError> {
            Ok(())
        }
        async fn has_session(&self, _: &ThreadId) -> Result<bool, PortError> {
            Ok(false)
        }
        async fn seat(&self, _: &ThreadId) -> Result<(), PortError> {
            Ok(())
        }
        async fn switch_now(&self, _: &ThreadId) -> Result<Option<Value>, PortError> {
            Ok(None)
        }
    }

    pub struct NoControls;

    impl LiveControls for NoControls {
        fn sync_live(&self, _: &mut dyn FnMut(&ThreadId)) {}
    }

    pub struct Offline;

    #[async_trait]
    impl mixdog_ai::transport::HttpSend for Offline {
        async fn send(&self, _: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<mixdog_ai::transport::HttpResponse, ProviderError> {
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }
}

/// R1: the thread the exec starts adopts the route its `thread/start` draft names (the core's `adopt_draft` over the config
/// the core loads); that thread's Lead falls back to the profile's `leadFallback` next.
#[tokio::test]
async fn the_started_threads_lead_falls_back_to_the_route_profiles_lead_fallback() {
    use mixdog_core_domains::domains::ai_admin::model_list::ModelListService;
    use mixdog_core_domains::domains::ai_admin::route_service::RouteService;
    use mixdog_core_session::session::NewThreadRoute;

    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), FABLE_PROFILE).unwrap();
    let config = core_config(&boundary).await;
    let tokens = mixdog_rt::testing::tokens();
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let source = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(adoption::Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), source).await);
    let models = Arc::new(ModelListService {
        catalog,
        config: config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::new(mixdog_ai::service::effort_configuration::UnsupportedEfforts::default()),
        host: None,
    });
    let live = Arc::new(adoption::Live::default());
    let routes = RouteService {
        config: config.clone(),
        facts: Arc::new(adoption::AnyModel),
        writer: live.clone(),
        session: Arc::new(adoption::Unborn),
        models,
        controls: Arc::new(adoption::NoControls),
    };

    let route = crate::exec::Route { provider: "anthropic-oauth".into(), model: "claude-fable-5".into(), effort: Some("xhigh".into()), fast: false };
    let params = crate::exec::run::thread_start_params(&options(Path::new("/unused")), &route, crate::exec::run::delegates(&boundary));
    let draft: mixdog_protocol::ModelSelection = serde_json::from_value(params["draft"]["route"].clone()).unwrap();
    let thread = mixdog_core_api::ids::ThreadId::from("sess_exec_lead");
    let adopted = routes.adopt(&thread, Some(&mixdog_core_session::session::new_route::draft_pick(&draft))).await.unwrap();

    let mut session = adopted.clone();
    session.extend(mixdog_core_session::session::new_route::create_keys(&adopted).unwrap());
    session.insert("id".into(), json!("sess_exec_lead"));
    session.insert("owner".into(), json!("user"));
    let position = mixdog_core_run::run_host::route_chain::route_fallback_position(&Value::Object(session), &config.agent(), &NoBots).await.unwrap();
    assert_eq!(position["current"], json!({ "provider": "anthropic-oauth", "model": "claude-fable-5" }));
    assert_eq!(position["next"], json!({ "provider": "anthropic-oauth", "model": "claude-opus-4-8" }), "{position}");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// R4, R5: every role the profile routes, the ones the shipped roster starts off (`advisor`, `explore`) among them, stays in
/// the config the core loads as the profile states it, is switched on, and resolves through the spawn plan's own checks
/// (`isAgentDisabled`, `configuredAgentRouteCandidates`, `resolveAgentSpawnPreset`) to its route.
#[tokio::test]
async fn every_role_a_route_profile_names_is_spawnable_on_the_config_the_core_loads() {
    let mut profile: Value = serde_json::from_str(FABLE_PROFILE).unwrap();
    profile["routes"]["advisor"] = json!({ "provider": "openai-oauth", "model": "gpt-6.1-sol", "effort": "high", "fast": false });
    profile["routes"]["explore"] = json!({ "provider": "anthropic-oauth", "model": "claude-haiku-5", "fast": false });
    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), &profile.to_string()).unwrap();
    let loaded = core_config(&boundary).await.loaded_agent().await.unwrap();
    let switch_on = mixdog_ai::service::admin_route::config_default_auto_effort(&loaded);
    for role in ["worker", "heavy-worker", "reviewer", "advisor", "explore"] {
        let mut kept = loaded["agents"][role].clone();
        let effort_auto = kept.as_object_mut().unwrap().shift_remove("effortAuto");
        assert_eq!(kept, boundary.runtime_config["agents"][role], "{role}: the core keeps the route as the exec wrote it");
        assert_eq!(effort_auto, Some(json!(switch_on)), "{role}: the load settles the unsaid Auto choice with the switch");
        assert!(!mixdog_core_config::config::agent_disabled(&loaded, role), "{role} is switched on");
        let candidates = mixdog_core_run::run_host::route_chain::route_candidates(&loaded, role, &NoBots).await.unwrap_or_else(|_| panic!("{role}"));
        let spawn = mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset(&loaded, &json!({ "agent": role }), &candidates).unwrap();
        for key in ["provider", "model"] {
            assert_eq!(spawn.preset[key], profile["routes"][role][key], "{role}: {key}");
        }
    }
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}
