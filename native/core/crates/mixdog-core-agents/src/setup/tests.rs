//! `SetupService` answers what Node's `createSetupToolExecutor` answered (receipt or refusal
//! text) for 188 recorded calls (`record-setup-dispatch.mjs`). The Node facade echoed its input,
//! so the fields compared are the ones the dispatcher decides.

use std::path::Path;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;

use super::*;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_config::config::NoEffects;
use mixdog_core_config::tool_modules::EffortJudgeState;
use mixdog_core_config::tool_modules::External;
use mixdog_core_config::tool_modules::ToolModulesHost;

struct Host(watch::Sender<u64>);

#[async_trait]
impl ToolModulesHost for Host {
    async fn external(&self) -> External {
        External {
            embedding_info: json!({ "model": "m" }),
            onnx_supported: true,
            git_available: true,
            local_provider: json!({ "runtime": { "installed": true } }),
            installation_command_error: None,
            effort_judge: EffortJudgeState { available: true, installing: false, ready: false, last_error: json!(""), info: json!({}) },
        }
    }
    fn changes(&self) -> watch::Receiver<u64> {
        self.0.subscribe()
    }
    async fn prepare_builtin_feature(&self, _: &str, _: Option<&[String]>) -> Result<(), String> {
        Ok(())
    }
    async fn stop_local_provider_server(&self) {}
    async fn sync_local_provider_registry(&self, _: bool) {}
    async fn shutdown_effort_judge(&self) {}
    fn invalidate_context_status_cache(&self) {}
    fn invalidate_pre_session_tool_surface(&self) {}
}

/// Who calls, what the session layer says of it, and how the voice toggle ends: per case.
#[derive(Default)]
struct World {
    caller: Mutex<String>,
    reach: Mutex<bool>,
    voice: Mutex<String>,
}

struct Callers(Arc<World>);

#[async_trait]
impl SetupCallers for Callers {
    async fn scope(&self, _: &ThreadId) -> CallerScope {
        match self.0.caller.lock().unwrap().as_str() {
            "human" => CallerScope::Human,
            "agent" => CallerScope::Agent { agent_id: "helper".into(), unattended: false },
            "heartbeat" => CallerScope::Agent { agent_id: "mixy".into(), unattended: false },
            "acting" | "mixy_acting" | "open_fails" => CallerScope::Human,
            "unattended" => CallerScope::Agent { agent_id: "helper".into(), unattended: true },
            "room" => CallerScope::RoomMember,
            _ => CallerScope::Headless,
        }
    }
    async fn is_heartbeat(&self, _: &ThreadId) -> bool {
        self.0.caller.lock().unwrap().as_str() == "heartbeat"
    }
    async fn settings_reach_session(&self, _: &ThreadId) -> bool {
        *self.0.reach.lock().unwrap()
    }
    async fn acting_agent(&self, thread: &ThreadId) -> Result<String, mixdog_core_api::CoreError> {
        if self.0.caller.lock().unwrap().as_str() == "open_fails" {
            return Err(mixdog_core_api::CoreError::ThreadNotFound { thread_id: thread.clone() });
        }
        Ok(match self.0.caller.lock().unwrap().as_str() {
            "acting" => "writer".into(),
            "mixy_acting" => "lead".into(),
            _ => String::new(),
        })
    }
}

struct Desktop;

#[async_trait]
impl SetupDesktop for Desktop {
    async fn request(&self, _: &ThreadId, args: &Value) -> Result<DesktopAnswer, PortError> {
        // The window that hosts the desktop settings takes these; every other request is unclaimed.
        if let Some(action) = args["action"].as_str().filter(|action| super::DESKTOP_ROUTED.contains(action)) {
            return Ok(DesktopAnswer::Done(json!({ "desktopHandled": action, "echo": args })));
        }
        Ok(DesktopAnswer::Unclaimed("setup: no attached Desktop surface; nothing was changed".into()))
    }
}

struct Voice(Arc<World>);

#[async_trait]
impl SetupVoice for Voice {
    async fn set_enabled(&self, enabled: bool) -> Result<Value, PortError> {
        Ok(match self.0.voice.lock().unwrap().as_str() {
            "fail" => json!({ "status": { "enabled": false, "installed": false, "components": {} }, "error": "download failed" }),
            "silent" => json!({ "status": { "enabled": !enabled, "installed": false, "components": {} } }),
            _ => json!({ "status": { "enabled": enabled, "installed": true, "busy": false, "components": { "whisper": true } } }),
        })
    }
}

/// An owner of actions other packages serve: the dispatcher's part is the gate and the receipt.
struct Owner;

#[async_trait]
impl SetupActions for Owner {
    fn actions(&self) -> &'static [&'static str] {
        &[
            "set_auto_update", "set_ai_session_titles", "set_heartbeat_enabled", "set_quota_auto_resume",
            "set_model_preferences", "set_system_shell", "set_reactions_enabled", "reconnect_mcp",
            "set_agent_route", "connect_connector", "restore_definition", "delete_definition",
        ]
    }
    async fn run(&self, _: &SetupCall<'_>) -> Result<Value, PortError> {
        Ok(json!({}))
    }
}

fn message(error: &PortError) -> String {
    match error {
        PortError::Denied(message) => message.clone(),
        PortError::Failed { message, .. } | PortError::Unavailable { message, .. } => message.clone(),
        PortError::Invalid { reason, .. } => reason.clone(),
        other => format!("{other:?}"),
    }
}

const KEPT: [&str; 8] = [
    "saved", "scope", "appliesTo", "appliedToCurrentSession", "configured", "promptCacheWarming", "voice", "botOrder",
];

fn kept(answer: &Value) -> Value {
    let fields = answer.as_object().unwrap();
    Value::Object(fields.iter().filter(|(key, _)| KEPT.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect())
}

#[tokio::test]
async fn the_dispatcher_answers_what_the_recorded_node_executor_answered() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-dispatch-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let entries = twin["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 287);

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let publisher = Arc::new(MockStatePublisher::default());
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), publisher.clone(), lanes).await.unwrap();
    let modules = ToolModules::with_env(config.clone(), Arc::new(Host(watch::channel(0).0)), publisher, CancellationToken::new(), Arc::new(|_| None));
    let shipped = dir.path().join("shipped");
    std::fs::create_dir_all(&shipped).unwrap();
    std::fs::write(shipped.join("minimal.md"), "---\ntitle: Minimal\n---\n").unwrap();
    let world = Arc::new(World::default());
    let service = SetupService::new(config.clone(), modules, Arc::new(Callers(world.clone())), Arc::new(Desktop), Arc::new(Voice(world.clone())))
        .with_settings(Settings::new(config.clone(), Arc::new(NoEffects), Arc::new(|_| None)))
        .with_output_styles(OutputStyles::new(config, &shipped, dir.path()))
        .with_actions(Arc::new(Owner));

    let thread = ThreadId::from("s");
    let cwd = AbsPath::new(std::env::temp_dir()).unwrap();
    let cancel = CancellationToken::new();
    let mut failures = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        *world.caller.lock().unwrap() = entry["caller"].as_str().unwrap().to_owned();
        *world.reach.lock().unwrap() = entry["reach"].as_bool().unwrap();
        *world.voice.lock().unwrap() = entry["voice"].as_str().unwrap().to_owned();
        let args = entry["args"].clone();
        let answer = service.call(ServiceCall { thread: &thread, surface: SurfaceKind::Lead, cwd: &cwd, args: &args, cancel: &cancel }).await;
        let expected = &entry["result"];
        let verdict = match (answer, expected["ok"].as_bool().unwrap()) {
            (Ok(parts), true) => {
                let ToolPart::Text(text) = &parts[0] else { panic!("text part") };
                let got: Value = serde_json::from_str(text).unwrap();
                let (got, want) = (kept(&got), kept(&expected["answer"]));
                (got == want).then_some(()).ok_or_else(|| format!("{got} != {want}"))
            }
            (Err(error), false) => {
                let (got, want) = (message(&error), expected["error"].as_str().unwrap());
                (got == want).then_some(()).ok_or_else(|| format!("{got:?} != {want:?}"))
            }
            (Ok(_), false) => Err(format!("answered, Node refused: {}", expected["error"])),
            (Err(error), true) => Err(format!("refused {error:?}, Node answered")),
        };
        if let Err(why) = verdict {
            failures.push(format!("#{index} {} {} {}: {why}", entry["caller"], args["action"], args["name"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), entries.len(), failures.join("\n"));
}

/// `getUpdateSettings()` over a fixed check state, as the recorder's runtime answered it.
struct UpdateView {
    settings: Settings,
    config: Config,
}

#[async_trait]
impl UpdateSettings for UpdateView {
    async fn set_auto_update(&self, enabled: bool) -> Result<Value, PortError> {
        self.settings.set_auto_update(&Value::Bool(enabled)).await.map_err(from_modules)?;
        let auto = self.config.agent().get("update").and_then(Value::as_object).and_then(|update| update.get("auto")).cloned();
        Ok(json!({
            "autoUpdate": auto != Some(Value::Bool(false)),
            "currentVersion": "1.0.0",
            "latestVersion": null,
            "updateAvailable": false,
            "lastCheckedAt": null,
        }))
    }
}

async fn settings_service(
    dir: &Path,
    document: Value,
    world: &Arc<World>,
    pending: bool,
) -> (SetupService, Config, Arc<mixdog_core_base::quota_resume::QuotaResumeStore>) {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    let publisher = Arc::new(MockStatePublisher::default());
    let (config, _) = Config::open(path, publisher.clone(), lanes).await.unwrap();
    let modules = ToolModules::with_env(config.clone(), Arc::new(Host(watch::channel(0).0)), publisher, CancellationToken::new(), Arc::new(|_| None));
    let store = Arc::new(mixdog_core_base::quota_resume::QuotaResumeStore::open(dir, tokens.durability_io, CancellationToken::new()).await.unwrap());
    if pending {
        let request = json!({ "sessionId": "sess_a", "turnKey": "t1", "provider": "openai", "resetAt": 4_102_444_800_000u64 });
        store.schedule(&request).await.unwrap();
    }
    let settings = Settings::new(config.clone(), Arc::new(NoEffects), Arc::new(|_| None));
    let owner = SettingsSetup::new(
        settings.clone(),
        Arc::new(UpdateView { settings, config: config.clone() }),
        QuotaAutoResume::new(config.clone(), store.clone()),
    );
    let service = SetupService::new(config.clone(), modules, Arc::new(Callers(world.clone())), Arc::new(Desktop), Arc::new(Voice(world.clone())))
        .with_actions(Arc::new(owner));
    (service, config, store)
}

async fn settings_call(service: &SetupService, args: &Value) -> Result<Value, String> {
    settings_call_on(service, "s", args).await
}

async fn settings_call_on(service: &SetupService, thread: &str, args: &Value) -> Result<Value, String> {
    let cwd = AbsPath::new(std::env::temp_dir()).unwrap();
    let cancel = CancellationToken::new();
    let thread = ThreadId::from(thread);
    match service.call(ServiceCall { thread: &thread, surface: SurfaceKind::Lead, cwd: &cwd, args, cancel: &cancel }).await {
        Ok(parts) => {
            let ToolPart::Text(text) = &parts[0] else { panic!("text part") };
            Ok(serde_json::from_str(text).unwrap())
        }
        Err(error) => Err(message(&error)),
    }
}

#[tokio::test]
async fn the_scalar_actions_answer_what_the_recorded_node_executor_answered() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-settings-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let node_is_windows = twin["platform"] == "win32";
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let mut failures = Vec::new();
    let mut compared = 0;
    for (index, entry) in twin["entries"].as_array().unwrap().iter().enumerate() {
        let args = &entry["args"];
        // The shell rule depends on the platform the twin was recorded on.
        if args["action"] == "set_system_shell" && node_is_windows != cfg!(windows) {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let (service, ..) = settings_service(dir.path(), json!({ "agent": entry["config"], "desktop": { "zoom": 1 } }), &world, false).await;
        let got = settings_call(&service, args).await;
        let want = &entry["result"];
        let verdict = match (got, want["ok"].as_bool().unwrap()) {
            (Ok(got), true) => (got == want["answer"]).then_some(()).ok_or_else(|| format!("{got} != {}", want["answer"])),
            (Err(got), false) => (got == want["error"].as_str().unwrap()).then_some(()).ok_or_else(|| format!("{got:?} != {}", want["error"])),
            (Ok(got), false) => Err(format!("answered {got}, Node refused: {}", want["error"])),
            (Err(got), true) => Err(format!("refused {got:?}, Node answered")),
        };
        compared += 1;
        if let Err(why) = verdict {
            failures.push(format!("#{index} {args}: {why}"));
        }
    }
    assert!(compared >= 600, "{compared} compared");
    assert!(failures.is_empty(), "{} of {compared} differ:\n{}", failures.len(), failures.join("\n"));
}

#[tokio::test]
async fn the_quota_switch_lives_in_the_quota_resume_section_and_off_drops_pending_resumes() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-settings-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let quota = twin["quota"].as_array().unwrap();
    assert_eq!(quota.len(), 16);
    for entry in quota {
        let dir = tempfile::tempdir().unwrap();
        let stored = if entry["stored"].is_null() { json!({}) } else { entry["stored"].clone() };
        let document = json!({ "agent": {}, "desktop": { "zoom": 1 }, "quotaResume": stored });
        let (service, config, store) = settings_service(dir.path(), document, &world, entry["pending"].as_bool().unwrap()).await;
        let got = settings_call(&service, &entry["args"]).await.unwrap();
        assert_eq!(got, entry["result"]["answer"], "{entry}");
        assert_eq!(config.get("quotaResume").unwrap(), entry["section"], "{entry}");
        assert_eq!(store.list().len() as u64, entry["entries"].as_u64().unwrap(), "{entry}");
    }
}

/// A stand-in for the local-model owner: the services crate's handlers are replayed against Node
/// in that crate; what is checked here is the receipt this dispatcher wraps around any answer.
struct LocalOwner;

#[async_trait]
impl SetupActions for LocalOwner {
    fn actions(&self) -> &'static [&'static str] {
        &[
            "install_local_model", "start_local_installation", "cancel_local_installation", "set_local_idle_ttl",
            "search_local_models", "inspect_hf_model", "register_hf_model", "local_model_details",
            "maintain_local_model", "delete_local_model",
        ]
    }
    async fn run(&self, _: &SetupCall<'_>) -> Result<Value, PortError> {
        Ok(json!({ "idleTtlSeconds": 3600 }))
    }
}

#[tokio::test]
async fn the_local_model_receipts_carry_what_the_recorded_node_executor_wrapped_them_in() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/services/setup-local-voice-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let dir = tempfile::tempdir().unwrap();
    let (service, ..) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
    let service = service.with_actions(Arc::new(LocalOwner));
    let mut compared = 0;
    for case in twin["cases"].as_array().unwrap() {
        let (true, Some(want)) = (case["kind"] == "local", case.get("receipt")) else { continue };
        let got = settings_call(&service, &case["args"]).await.unwrap();
        for key in ["saved", "background", "scope", "appliesTo"] {
            assert_eq!(got.get(key), want.get(key), "{key} of {case}");
        }
        compared += 1;
    }
    assert!(compared >= 6, "{compared} compared");
}

/// The domain table, recording what a setup action calls on it. The answer names the Node facade
/// method the recorded twin calls, so receipts compare whole.
struct Recorded(Mutex<Vec<(&'static str, Value)>>);

#[async_trait]
impl DomainCalls for Recorded {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        self.0.lock().unwrap().push((method, params));
        let node = match method {
            "config/setWebSearchRoute" => "setWebSearchRoute",
            "config/setModelPreferences" => "setModelPreferences",
            "config/setCompactionSettings" => "setCompactionSettings",
            "config/setAutoClear" => "setAutoClear",
            "config/setNetworkProxy" => "setNetworkProxy",
            "thread/setWorkflow" => "setWorkflow",
            "thread/setOrchestrationMode" => "setOrchestrationMode",
            "localProvider/setLocalProviderContext" | "config/getToolModuleSettings" => "setLocalProviderContext",
            other => panic!("unexpected domain call {other}"),
        };
        Ok(json!({ "answered": node }))
    }
}

/// What `validateSetupInput` (the tool-input layer, `mixdog-tools`) answers before a handler.
fn is_input_layer(error: &str) -> bool {
    error.starts_with("[tool-input-validation]")
        || error.contains("is only accepted by")
        || error.contains("supported settings is required")
        || error.ends_with("requires at least one setting")
}

#[tokio::test]
async fn the_domain_settings_make_the_calls_and_answer_the_receipts_the_recorded_node_executor_did() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-domain-settings-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let (mut ok, mut refused) = (0, 0);
    for case in twin["cases"].as_array().unwrap() {
        if case.get("error").and_then(Value::as_str).is_some_and(is_input_layer) {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let (service, ..) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
        let recorded = Arc::new(Recorded(Mutex::default()));
        let service = service.with_actions(Arc::new(DomainSettings::new(recorded.clone())));
        let got = settings_call(&service, &case["args"]).await;
        let calls: Vec<Value> = recorded
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| *method != "config/getToolModuleSettings")
            .map(|(method, params)| {
                let (name, args) = match *method {
                    "config/setWebSearchRoute" => ("setWebSearchRoute", json!([params["next"]])),
                    "config/setModelPreferences" => ("setModelPreferences", json!([params["providerId"], params["changes"]])),
                    "config/setCompactionSettings" => ("setCompactionSettings", json!([params["input"]])),
                    "config/setAutoClear" => ("setAutoClear", json!([params["input"]])),
                    "thread/setWorkflow" => ("setWorkflow", json!([params["workflowId"]])),
                    "thread/setOrchestrationMode" => ("setOrchestrationMode", json!([params["mode"]])),
                    "localProvider/setLocalProviderContext" => ("setLocalProviderContext", json!([params["modelId"], params["tokens"]])),
                    _ => ("setNetworkProxy", json!([params["patch"]])),
                };
                json!({ "method": name, "args": args })
            })
            .collect();
        assert_eq!(Value::Array(calls), case["calls"], "{case}");
        match case.get("error").and_then(Value::as_str) {
            Some(error) => {
                refused += 1;
                assert_eq!(got.unwrap_err(), error, "{case}");
            }
            None => {
                ok += 1;
                assert_eq!(got.unwrap(), case["receipt"], "{case}");
            }
        }
    }
    assert!(ok >= 12 && refused >= 8, "{ok} answered, {refused} refused");
}

/// The media catalog, the pin store and the account roster of a recorded `set_media_default` world,
/// logging each call under the Node facade method that made it.
struct MediaWorld {
    lanes: Value,
    rosters: Value,
    calls: Mutex<Vec<Value>>,
}

#[async_trait]
impl DomainCalls for MediaWorld {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let mut calls = self.calls.lock().unwrap();
        match method {
            "media/listMediaLanes" => {
                calls.push(json!({ "method": "listMediaLanes", "args": [] }));
                Ok(self.lanes.clone())
            }
            "media/setMediaPin" => {
                let input = &params["input"];
                calls.push(json!({ "method": "setMediaPin", "args": [input] }));
                // The facade's pin store: a blank lane clears, anything else is kept as given.
                let lane = input["lane"].as_str().unwrap().trim();
                Ok(if lane.is_empty() {
                    Value::Null
                } else {
                    json!({ "kind": input["kind"], "lane": lane, "model": input["model"].as_str().unwrap_or(""), "account": input["account"].as_str().unwrap_or("") })
                })
            }
            other => panic!("unexpected domain call {other}"),
        }
    }
}

#[async_trait]
impl ProviderAccounts for MediaWorld {
    async fn accounts(&self, provider: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(json!({ "method": "getProviderAccounts", "args": [if provider.is_empty() { Value::Null } else { json!(provider) }] }));
        self.rosters.get(provider).cloned().ok_or_else(|| "Unknown OAuth provider.".to_owned())
    }
}

#[tokio::test]
async fn set_media_default_checks_the_catalog_and_the_roster_and_pins_as_the_recorded_node_executor_did() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-media-default-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let (mut ok, mut refused) = (0, 0);
    for case in twin["cases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let (service, ..) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
        let media = Arc::new(MediaWorld { lanes: case.get("lanes").unwrap_or(&twin["lanes"]).clone(), rosters: twin["rosters"].clone(), calls: Mutex::default() });
        let service = service.with_actions(Arc::new(MediaDefaultSetup::new(media.clone(), media.clone())));
        let got = settings_call(&service, &case["args"]).await;
        assert_eq!(Value::Array(media.calls.lock().unwrap().clone()), case["calls"], "{case}");
        match case.get("error").and_then(Value::as_str) {
            Some(error) => {
                refused += 1;
                assert_eq!(got.unwrap_err(), error, "{case}");
            }
            None => {
                ok += 1;
                assert_eq!(got.unwrap(), case["receipt"], "{case}");
            }
        }
    }
    assert!(ok >= 10 && refused >= 25, "{ok} answered, {refused} refused");
}

#[tokio::test]
async fn the_six_desktop_routed_actions_are_forwarded_whole_and_answered_with_the_recorded_wrapper() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-domain-settings-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    // The wrapper Node puts around any receipt of an action without its own `appliesTo`.
    let wrapper = twin["cases"].as_array().unwrap().iter().find(|case| case["args"]["action"] == "set_workflow" && case.get("receipt").is_some()).unwrap()["receipt"].clone();
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let dir = tempfile::tempdir().unwrap();
    let (service, ..) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
    let requests = [
        json!({ "action": "set_desktop_settings", "desktop": { "keepAwake": true } }),
        json!({ "action": "set_appearance", "appearance": { "theme": "dark" } }),
        json!({ "action": "save_project", "project": { "path": "/p" } }),
        json!({ "action": "remove_project", "projectPath": "/p" }),
        json!({ "action": "revoke_linked_device", "deviceId": "d1" }),
        json!({ "action": "set_activity_rail_pins", "pins": ["sessions"] }),
    ];
    for args in requests {
        let got = settings_call(&service, &args).await.unwrap();
        let mut want = json!({ "saved": true, "scope": wrapper["scope"], "appliesTo": wrapper["appliesTo"] });
        want["desktopHandled"] = args["action"].clone();
        want["echo"] = args.clone();
        assert_eq!(got, want, "{args}");
    }
}

/// An attached UI that takes (or declines) every navigation and remembers what it was asked.
struct OpenUi(bool, Mutex<Vec<(String, String)>>);

#[async_trait]
impl SetupUiSurface for OpenUi {
    async fn notify(&self, _: &ThreadId, _: &str, _: std::time::Duration) -> bool {
        false
    }
    async fn settled(&self, _: &ThreadId, _: &str) {}
    async fn open(&self, thread: &ThreadId, command: &str) -> bool {
        self.1.lock().unwrap().push((thread.as_str().to_owned(), command.to_owned()));
        self.0
    }
}

#[tokio::test]
async fn open_answers_and_notifies_as_the_recorded_node_executor_did() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-open-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(twin["targets"].as_array().unwrap().len(), super::OPEN_TARGETS.len());
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let mut compared = 0;
    for case in twin["cases"].as_array().unwrap() {
        // The tool-input layer answers a target the tool does not list, and Node's `takes`
        // is any value its `=== true` test sees; only booleans are a port's answer.
        if case.get("error").is_some() || !case["takes"].is_boolean() {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let (service, ..) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
        let ui = Arc::new(OpenUi(case["takes"].as_bool().unwrap(), Mutex::default()));
        let service = service.with_ui(ui.clone());
        let got = settings_call_on(&service, case["session"].as_str().unwrap(), &case["args"]).await.unwrap();
        assert_eq!(got, case["result"], "{case}");
        let asked: Vec<Value> = ui.1.lock().unwrap().iter().map(|(thread, command)| json!({ "id": thread, "command": command })).collect();
        let expected: Vec<Value> = case["notified"].as_array().unwrap().iter().map(|n| json!({ "id": n["id"], "command": n["extra"]["command"] })).collect();
        assert_eq!(asked, expected, "{case}");
        for node in case["notified"].as_array().unwrap() {
            assert_eq!(node["text"], format!("Open /{}", node["extra"]["command"].as_str().unwrap()));
            assert_eq!(node["extra"]["kind"], "ui-open");
        }
        compared += 1;
    }
    assert_eq!(compared, 21 * 3);
}

#[tokio::test]
async fn status_answers_capabilities_and_forwards_the_desktop_domains_as_the_recorded_node_executor_did() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-status-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let domains: Vec<&str> = twin["domains"].as_array().unwrap().iter().map(|d| d.as_str().unwrap()).collect();
    assert_eq!(domains, super::status::STATUS_DOMAINS);
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let dir = tempfile::tempdir().unwrap();
    let (service, ..) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
    let mut compared = 0;
    for case in twin["cases"].as_array().unwrap() {
        // With no session the broker (SetupRequests, replayed with its own twin) answers, not the dispatcher.
        let session = case["session"].as_str().unwrap();
        if session.is_empty() {
            continue;
        }
        let got = settings_call_on(&service, session, &case["args"]).await;
        match case.get("error").and_then(Value::as_str) {
            Some(error) => assert_eq!(got.unwrap_err(), error, "{case}"),
            // Key order is part of the text the model reads.
            None => assert_eq!(got.unwrap().to_string(), case["result"].to_string(), "{case}"),
        }
        compared += 1;
    }
    assert_eq!(compared, 5);
    // A domain whose reader is another owner's is reported as not wired, never answered by a guess.
    let error = settings_call(&service, &json!({ "action": "status", "domain": "providers" })).await.unwrap_err();
    assert!(error.contains("providers status reader is not wired"), "{error}");
}

/// The domain table answering a recorded case's getters, and remembering which were called.
struct Getters(Value, Mutex<Vec<String>>);

#[async_trait]
impl DomainCalls for Getters {
    async fn call(&self, method: &'static str, _: Value) -> Result<Value, CoreError> {
        let node = method.strip_prefix("config/").or_else(|| method.strip_prefix("voice/")).unwrap();
        self.1.lock().unwrap().push(node.to_owned());
        Ok(self.0[node].clone())
    }
}

#[async_trait]
impl WorkflowFacts for Getters {
    fn web_search_route(&self) -> Result<Value, PortError> {
        self.1.lock().unwrap().push("getWebSearchRoute".to_owned());
        Ok(self.0["getWebSearchRoute"].clone())
    }
    fn onboarding(&self) -> Result<Value, PortError> {
        self.1.lock().unwrap().push("getOnboardingStatus".to_owned());
        Ok(self.0["getOnboardingStatus"].clone())
    }
    async fn workflows(&self) -> Result<Value, PortError> {
        self.1.lock().unwrap().push("listWorkflows".to_owned());
        Ok(self.0["listWorkflows"].clone())
    }
}

/// The desktop's bridges, as the recorded case's answer shows them (the host's fact).
struct Bridges(Value);

impl FeatureActivity for Bridges {
    fn active(&self, id: &str) -> bool {
        let shown = if self.0.get(id).is_some() { &self.0[id] } else { &self.0["features"][id] };
        shown["active"] == true
    }
}

/// The session's live Lead route, as the recorded facade carried it.
struct Route(Value, Arc<Getters>);

impl LiveRoute for Route {
    fn route(&self) -> Value {
        self.0.clone()
    }
    fn lead_fallbacks(&self) -> Value {
        self.1.1.lock().unwrap().push("listPresets".to_owned());
        let presets = self.1.0["listPresets"].as_array().cloned().unwrap_or_default();
        presets.iter().find(|preset| preset["id"] == "workflow-lead").map_or(Value::Null, |preset| preset["fallbacks"].clone())
    }
    fn positions(&self, _: &ThreadId, _: bool) -> Value {
        json!({ "sessions": [] })
    }
}

#[tokio::test]
async fn the_config_backed_status_domains_read_the_same_getters_and_print_what_the_recorded_node_executor_did() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-status-config-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let (mut compared, mut domains) = (0, std::collections::BTreeSet::new());
    for case in twin["cases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let (service, config, _) = settings_service(dir.path(), json!({ "agent": case["config"], "desktop": { "zoom": 1 } }), &world, false).await;
        let getters = Arc::new(Getters(case["values"].clone(), Mutex::default()));
        let settings = Settings::new(config.clone(), Arc::new(NoEffects), Arc::new(|_| None));
        let bridges = Arc::new(Bridges(case["result"].clone()));
        let features = Arc::new(FeatureStatus::new(getters.clone(), settings, bridges));
        let service = service
            .with_status(Arc::new(ConfigStatus::new(getters.clone())))
            .with_status(Arc::new(WorkflowStatus::new(getters.clone(), getters.clone())))
            .with_status(features.clone())
            .with_status(Arc::new(SummaryStatus::new(getters.clone(), getters.clone(), features, Arc::new(Route(case["values"]["props"].clone(), getters.clone())))))
            .with_status(Arc::new(ModelStatus::new(Arc::new(Route(case["values"]["props"].clone(), getters.clone())))));
        let got = settings_call_on(&service, "sess_a", &json!({ "action": "status", "domain": case["domain"] })).await.unwrap();
        // Key order is part of the text the model reads.
        assert_eq!(got.to_string(), case["result"].to_string(), "{case}");
        let called: Vec<Value> = getters.1.lock().unwrap().iter().map(|m| json!(m)).collect();
        let node: Vec<Value> = case["calls"].as_array().unwrap().iter().map(|c| c["method"].clone()).collect();
        assert_eq!(called, node, "{case}");
        domains.insert(case["domain"].as_str().unwrap().to_owned());
        compared += 1;
    }
    assert_eq!(compared, 61);
    assert_eq!(domains.len(), 17);
}

/// The model catalog and the web-search model list, answering a recorded case's rows.
struct Catalog(Value, Mutex<Vec<(String, bool)>>);

#[async_trait]
impl DomainCalls for Catalog {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let (rows, refresh) = match method {
            "model/list" => (&self.0["rows"], &params["refresh"]),
            "account/listWebSearchModels" => (&self.0["webRows"], &params["options"]["refresh"]),
            other => panic!("unexpected domain call {other}"),
        };
        self.1.lock().unwrap().push((method.to_owned(), refresh.as_bool().unwrap()));
        Ok(rows.clone())
    }
}

#[tokio::test]
async fn list_models_shapes_the_catalog_as_the_recorded_node_executor_did() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/setup-list-models-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let (mut answered, mut refused) = (0, 0);
    for case in twin["cases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let (service, ..) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
        let catalog = Arc::new(Catalog(json!({ "rows": case["rows"], "webRows": case["webRows"] }), Mutex::default()));
        let service = service.with_actions(Arc::new(DomainSettings::new(catalog.clone())));
        let got = settings_call(&service, &case["args"]).await;
        let asked = catalog.1.lock().unwrap().clone();
        let node: Vec<(String, bool)> = case["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|call| {
                let method = if call["method"] == "listWebSearchModels" { "account/listWebSearchModels" } else { "model/list" };
                (method.to_owned(), call["args"][0]["refresh"].as_bool().unwrap())
            })
            .collect();
        assert_eq!(asked, node, "{case}");
        match case.get("error").and_then(Value::as_str) {
            Some(error) => {
                refused += 1;
                assert_eq!(got.unwrap_err(), error, "{case}");
            }
            None => {
                answered += 1;
                // Key order is part of the text the model reads.
                assert_eq!(got.unwrap().to_string(), case["result"].to_string(), "{case}");
            }
        }
    }
    assert_eq!((answered, refused), (29, 6));
}