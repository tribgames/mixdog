//! `SetupService` answers what Node's `createSetupToolExecutor` answered (receipt or refusal
//! text) for 188 recorded calls (`record-setup-dispatch.mjs`). The Node facade echoed its input,
//! so the fields compared are the ones the dispatcher decides.

use std::path::Path;
use std::sync::Mutex;

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
    async fn request(&self, _: &ThreadId, _: &Value) -> Result<DesktopAnswer, PortError> {
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
