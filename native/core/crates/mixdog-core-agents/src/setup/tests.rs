//! `SetupService`: the lead permission receipt does not promise the coding lead, and the quota switch going off through the config
//! drops pending resumes.

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

mod dispatch_rules;
mod media_default;
mod scalar_settings;
mod status_domains;

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
    async fn prepare_builtin_feature(&self, _: &str, _: Option<&[String]>) -> Result<Option<Value>, String> {
        Ok(None)
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

fn message(error: &PortError) -> String {
    match error {
        PortError::Denied(message) => message.clone(),
        PortError::Failed { message, .. } | PortError::Unavailable { message, .. } => message.clone(),
        PortError::Invalid { reason, .. } => reason.clone(),
        other => format!("{other:?}"),
    }
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

/// An attached UI that takes (or declines) every navigation and remembers what it was asked.
struct OpenUi(bool, Mutex<Vec<(String, String)>>);

/// A saved `lead` permission row is Mixy's policy: its receipt names where it applies; another agent's keeps the generic one
/// (a deliberate difference from Node, which promised "every session").
#[test]
fn the_lead_permission_receipt_does_not_promise_the_coding_lead() {
    let lead: Value = serde_json::from_str(&receipt("set_agent_permission", json!({ "agent": "lead", "permissions": [] }))).unwrap();
    assert_eq!(lead["saved"], json!(true));
    let applies = lead["appliesTo"].as_str().unwrap();
    assert!(applies.contains("Mixy") && applies.contains("coding Lead sessions have no outbound rule"), "{applies}");
    let other: Value = serde_json::from_str(&receipt("set_agent_permission", json!({ "agent": "alpha", "permissions": [] }))).unwrap();
    assert_eq!(other["appliesTo"], json!(applies_to("set_agent_permission")));
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
    let owner =
        SettingsSetup::new(settings.clone(), Arc::new(UpdateView { settings, config: config.clone() }), QuotaAutoResume::new(config.clone(), store.clone()));
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
/// `config/value/write` of `quotaAutoResume: false` (or any writer) drops the pending resumes through the config follow, as
/// Node's setter does; turning it on again drops nothing.
#[tokio::test]
async fn the_quota_switch_going_off_through_the_config_drops_pending_resumes() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let (_service, config, store) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, true).await;
    assert_eq!(store.list().len(), 1);
    let cancel = CancellationToken::new();
    let follow = QuotaAutoResume::new(config.clone(), store.clone()).follow(cancel.clone());
    config
        .update(move |doc| {
            doc.insert("quotaAutoResume".into(), Value::Bool(false));
            Ok(())
        })
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while !store.list().is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "the pending resume was not dropped");
        mixdog_rt::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    // On again: a resume scheduled now stays.
    config
        .update(move |doc| {
            doc.insert("quotaAutoResume".into(), Value::Bool(true));
            Ok(())
        })
        .await
        .unwrap();
    let request = json!({ "sessionId": "sess_b", "turnKey": "t2", "provider": "openai", "resetAt": 4_102_444_800_000u64 });
    store.schedule(&request).await.unwrap();
    mixdog_rt::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(store.list().len(), 1);
    cancel.cancel();
    follow.await.unwrap();
}
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
