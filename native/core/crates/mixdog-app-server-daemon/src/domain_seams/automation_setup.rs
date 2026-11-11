//! The setup tool's automation actions (`save_automation`, `delete_automation`,
//! `set_automation_enabled`, `run_automation`, `set_webhook_config`) as a `SetupActions` owner:
//! [`AutomationSetup`] (`setup-tool/extended-actions.mjs` over `channel-admin.mjs`) behind the
//! calling session's `scheduleCallerScope`. The reply text is the dispatcher's receipt around
//! what the handler returns, so the recorded Node replies are replayed through `SetupService`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::setup::StatusReader;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_core_ports::ports::setup_actions::SetupCallers;
use mixdog_services::channels::setup::AccessScope;
use mixdog_services::channels::setup::AgentDirectory;
use mixdog_services::channels::setup::AutomationAdmin;
use mixdog_services::channels::setup::AutomationSetup;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

/// `rt.listAgents()`: the fixed services, then every custom agent.
struct DefinitionDirectory(Arc<AgentDefinitions>);

#[async_trait]
impl AgentDirectory for DefinitionDirectory {
    async fn agent_ids(&self) -> Result<Vec<String>, String> {
        let rows = self.0.rows().await.map_err(|error| error.to_string())?;
        Ok(rows.into_iter().map(|row| row.id).collect())
    }
}

pub struct AutomationActions {
    setup: AutomationSetup,
    callers: Arc<dyn SetupCallers>,
}

impl AutomationActions {
    /// `admin` is the daemon's one `ChannelAdmin`; `callers` the one `SetupCallers` of the setup
    /// service, so the scope here is the scope its gate decided on; `agents` the agent catalog.
    pub fn new(admin: Arc<dyn AutomationAdmin>, agents: Arc<AgentDefinitions>, callers: Arc<dyn SetupCallers>) -> Self {
        Self::with_directory(admin, Arc::new(DefinitionDirectory(agents)), callers)
    }

    fn with_directory(admin: Arc<dyn AutomationAdmin>, agents: Arc<dyn AgentDirectory>, callers: Arc<dyn SetupCallers>) -> Self {
        Self { setup: AutomationSetup::new(admin, agents), callers }
    }
}

/// `scheduleCallerScope`: an unattended run is its bot's agent scope (it only narrows).
fn access_scope(scope: CallerScope) -> AccessScope {
    match scope {
        CallerScope::Human => AccessScope::Human,
        CallerScope::Agent { agent_id, .. } => AccessScope::Agent { agent_id },
        CallerScope::RoomMember => AccessScope::RoomMember,
        CallerScope::Headless => AccessScope::Headless,
    }
}

#[async_trait]
impl SetupActions for AutomationActions {
    fn actions(&self) -> &'static [&'static str] {
        self.setup.actions()
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let scope = access_scope(self.callers.scope(call.thread).await);
        self.setup.run(call.action, call.args, call.thread, &scope).await
    }
}

/// The `schedules` and `webhooks` domains of `status`: the same owner (and so the same
/// `ChannelAdmin`) as the actions; the listing is the caller-independent `getChannelSetup`.
#[async_trait]
impl StatusReader for AutomationActions {
    fn domains(&self) -> &'static [&'static str] {
        &["schedules", "webhooks"]
    }

    async fn read(&self, domain: &str, _detail: bool, _thread: &mixdog_core_api::ids::ThreadId) -> Result<Value, PortError> {
        self.setup.status(domain).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_agents::setup::DesktopAnswer;
    use mixdog_core_agents::setup::SetupDesktop;
    use mixdog_core_agents::setup::SetupService;
    use mixdog_core_agents::setup::SetupVoice;
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::tool::SurfaceKind;
    use mixdog_core_api::domain::tool::Tool;
    use mixdog_core_api::domain::tool::ToolPart;
    use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
    use mixdog_core_config::config::Config;
    use mixdog_core_config::config::ConfigLanes;
    use mixdog_core_config::tool_modules::EffortJudgeState;
    use mixdog_core_config::tool_modules::External;
    use mixdog_core_config::tool_modules::ToolModules;
    use mixdog_core_config::tool_modules::ToolModulesHost;
    use mixdog_protocol::ThreadId;
    use mixdog_tools::orch::service::ServiceCall;
    use mixdog_tools::orch::service::ServiceTool;
    use mixdog_tools::orch::service::ToolService;
    use serde_json::json;
    use tokio::sync::watch;

    use super::*;

    /// Chrono-free `new Date(ms).toISOString()` (days-from-civil, inverted).
    fn iso(ms: i64) -> String {
        let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
        let z = days + 719_468;
        let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
            rem / 3_600_000,
            rem / 60_000 % 60,
            rem / 1_000 % 60,
            rem % 1_000
        )
    }

    fn absent() -> Value {
        json!({"absent": true})
    }

    /// The fake runtime of the recorder: the same answers, and every call noted.
    struct Fake {
        state: Mutex<Value>,
        calls: Mutex<Vec<Value>>,
        /// The runtime's own signal: ticks when a call is noted (a run's call arrives on its own task).
        noted: watch::Sender<()>,
    }

    impl Fake {
        fn note(&self, method: &str, args: Vec<Value>) {
            self.calls.lock().unwrap().push(json!({"method": method, "args": args}));
            self.noted.send_replace(());
        }

        fn saved(entry: &Value) -> Value {
            let mut out = entry.as_object().unwrap().clone();
            if let Some(at) = entry.get("at").and_then(Value::as_str).filter(|at| !at.is_empty()) {
                out.insert("whenAt".into(), iso(mixdog_js::time::date_parse(at) as i64).into());
            }
            if let Some(time) = entry.get("time").filter(|time| time.as_str() != Some("")) {
                out.insert("whenCron".into(), time.clone());
            }
            out.insert("secret".into(), "sek".into());
            Value::Object(out)
        }
    }

    #[async_trait]
    impl AutomationAdmin for Fake {
        async fn get_channel_setup(&self) -> Result<Value, String> {
            Ok(self.state.lock().unwrap().clone())
        }
        async fn save_schedule(&self, entry: &Value) -> Result<Value, String> {
            self.note("saveSchedule", vec![entry.clone()]);
            Ok(Self::saved(entry))
        }
        async fn save_webhook(&self, entry: &Value) -> Result<Value, String> {
            self.note("saveWebhook", vec![entry.clone()]);
            Ok(Self::saved(entry))
        }
        async fn delete_schedule(&self, name: &str) -> Result<Value, String> {
            self.note("deleteSchedule", vec![name.into()]);
            Ok(json!({"name": name, "deleted": true}))
        }
        async fn delete_webhook(&self, name: &str) -> Result<Value, String> {
            self.note("deleteWebhook", vec![name.into()]);
            Ok(json!({"name": name, "deleted": true}))
        }
        async fn set_schedule_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String> {
            self.note("setScheduleEnabled", vec![name.into(), enabled.cloned().unwrap_or_else(absent)]);
            Ok(json!({"name": name, "enabled": enabled != Some(&Value::Bool(false))}))
        }
        async fn set_webhook_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String> {
            self.note("setWebhookEnabled", vec![name.into(), enabled.cloned().unwrap_or_else(absent)]);
            Ok(json!({"name": name, "enabled": enabled != Some(&Value::Bool(false))}))
        }
        async fn run_schedule_now(&self, name: &str) -> Result<Value, String> {
            self.note("runScheduleNow", vec![name.into()]);
            std::future::pending().await
        }
        async fn run_webhook_now(&self, name: &str) -> Result<Value, String> {
            self.note("runWebhookNow", vec![name.into()]);
            std::future::pending().await
        }
        async fn set_webhook_config(&self, patch: Option<&Value>) -> Result<Value, String> {
            self.note("setWebhookConfig", vec![patch.cloned().unwrap_or_else(absent)]);
            Ok(Value::Null)
        }
    }

    /// The recorder's `listAgents`.
    struct Directory(Vec<String>);

    #[async_trait]
    impl AgentDirectory for Directory {
        async fn agent_ids(&self) -> Result<Vec<String>, String> {
            Ok(self.0.clone())
        }
    }

    /// The kind of session the case calls from (the recorder's `CALLERS`).
    struct Callers(Mutex<String>);

    #[async_trait]
    impl SetupCallers for Callers {
        async fn scope(&self, _: &ThreadId) -> CallerScope {
            match self.0.lock().unwrap().as_str() {
                "human" => CallerScope::Human,
                "mixy_home" => CallerScope::Human,
                "reviewer_home" => CallerScope::Agent { agent_id: "reviewer".into(), unattended: false },
                "writer_home" => CallerScope::Agent { agent_id: "writer".into(), unattended: false },
                "reviewer_run" => CallerScope::Agent { agent_id: "reviewer".into(), unattended: true },
                "heartbeat" => CallerScope::Agent { agent_id: MIXY_AGENT_ID.into(), unattended: false },
                "room" => CallerScope::RoomMember,
                _ => CallerScope::Headless,
            }
        }
        async fn is_heartbeat(&self, _: &ThreadId) -> bool {
            self.0.lock().unwrap().as_str() == "heartbeat"
        }
        async fn acting_agent(&self, thread: &ThreadId) -> Result<String, mixdog_core_api::CoreError> {
            if self.0.lock().unwrap().as_str() == "unresolved" {
                return Err(mixdog_core_api::CoreError::ThreadNotFound { thread_id: thread.clone() });
            }
            Ok(String::new())
        }
    }

    struct Desktop;

    #[async_trait]
    impl SetupDesktop for Desktop {
        async fn request(&self, _: &ThreadId, _: &Value) -> Result<DesktopAnswer, PortError> {
            Ok(DesktopAnswer::Unclaimed("setup: no attached Desktop surface; nothing was changed".into()))
        }
    }

    struct Voice;

    #[async_trait]
    impl SetupVoice for Voice {
        async fn set_enabled(&self, _: bool) -> Result<Value, PortError> {
            Ok(Value::Null)
        }
    }

    struct Host(watch::Sender<u64>);

    #[async_trait]
    impl ToolModulesHost for Host {
        async fn external(&self) -> External {
            External {
                embedding_info: Value::Null,
                onnx_supported: false,
                git_available: false,
                local_provider: Value::Null,
                installation_command_error: None,
                effort_judge: EffortJudgeState { available: false, installing: false, ready: false, last_error: Value::Null, info: Value::Null },
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

    fn message(error: &PortError) -> String {
        match error {
            PortError::Denied(message) => message.clone(),
            PortError::Failed { message, .. } | PortError::Unavailable { message, .. } => message.clone(),
            PortError::Invalid { reason, .. } => reason.clone(),
            other => format!("{other:?}"),
        }
    }

    /// The `setup` tool over a `SetupService` with the one automation owner registered for both
    /// its actions and its `status` domains, the way `mcp_services` composes it.
    struct Rig {
        _dir: tempfile::TempDir,
        service: Arc<SetupService>,
        tool: ServiceTool,
        callers: Arc<Callers>,
        fake: Arc<Fake>,
    }

    async fn rig(agents: Vec<String>) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let publisher = Arc::new(mixdog_core_api::mock::MockStatePublisher::default());
        let (config, _) = Config::open(
            dir.path().join("mixdog-config.json"),
            publisher.clone(),
            ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io },
        )
        .await
        .unwrap();
        let modules = ToolModules::new(config.clone(), Arc::new(Host(watch::channel(0).0)), publisher, mixdog_rt::CancellationToken::new());
        let callers = Arc::new(Callers(Mutex::new(String::new())));
        let fake = Arc::new(Fake { state: Mutex::new(Value::Null), calls: Mutex::new(Vec::new()), noted: watch::channel(()).0 });
        let owner = Arc::new(AutomationActions::with_directory(fake.clone(), Arc::new(Directory(agents)), callers.clone()));
        assert_eq!(owner.actions(), mixdog_services::channels::setup::AUTOMATION_ACTIONS);
        let service = Arc::new(
            SetupService::new(config, modules, callers.clone(), Arc::new(Desktop), Arc::new(Voice))
                .with_actions(owner.clone())
                .with_status(owner),
        );
        let tool = ServiceTool::setup(service.clone());
        Rig { _dir: dir, service, tool, callers, fake }
    }

    /// `fixtures/automation-setup-reply/golden.json` (`record-automation-setup-reply.mjs`): the
    /// reply (or refusal) of the real Node `createSetupToolExecutor` for every automation action
    /// from every kind of calling session, with the runtime calls it made. `SetupService` with
    /// this owner registered must answer the same text and make the same calls, the input
    /// validation of the `setup` tool in front of it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_automation_reply_is_the_text_node_sends() {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/automation-setup-reply/golden.json")).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        assert!(cases.len() > 700);

        let agents: Vec<String> = golden["agents"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect();
        let Rig { _dir, service, tool, callers, fake } = rig(agents).await;

        let cwd = AbsPath::new(std::env::temp_dir()).unwrap();
        let cancel = mixdog_rt::CancellationToken::new();
        let mut failures = Vec::new();
        for (index, case) in cases.iter().enumerate() {
            // The recorder's sessions: an agent's home thread for its `_home` callers, else any.
            let home = |agent: &str| ThreadId::from(mixdog_core_base::rooms::ids::agent_home_session_id(agent).unwrap().as_str());
            let thread = match case["caller"].as_str().unwrap() {
                "mixy_home" => home(MIXY_AGENT_ID),
                "reviewer_home" => home("reviewer"),
                "writer_home" => home("writer"),
                _ => ThreadId::from("s"),
            };
            *callers.0.lock().unwrap() = case["caller"].as_str().unwrap().to_owned();
            *fake.state.lock().unwrap() = golden["states"][case["state"].as_str().unwrap()].clone();
            fake.calls.lock().unwrap().clear();
            let mut noted = fake.noted.subscribe();
            let args = &case["args"];
            let answer: Result<String, String> = match mixdog_tools::orch::setup_input::validate(args, &tool.spec().input_schema) {
                Err(error) => Err(error.message_for_model),
                Ok(()) => match service.call(ServiceCall { thread: &thread, surface: SurfaceKind::Lead, cwd: &cwd, args, cancel: &cancel }).await {
                    Ok(parts) => match &parts[0] {
                        ToolPart::Text(text) => Ok(text.clone()),
                        _ => panic!("#{index}: a text part was expected"),
                    },
                    Err(error) => Err(message(&error)),
                },
            };
            // A run starts on its own task: wait for the calls Node made, woken by the runtime's
            // own note of each (the receiver was made before the call).
            let expected = case["calls"].as_array().unwrap().len();
            while fake.calls.lock().unwrap().len() < expected {
                noted.changed().await.expect("the runtime is alive");
            }
            let label = format!("#{index} {} {} {} {}", case["caller"], case["state"], args["action"], args["name"]);
            match (&answer, case.get("reply"), case.get("error")) {
                (Ok(got), Some(want), None) => {
                    if Some(got.as_str()) != want.as_str() {
                        failures.push(format!("{label}: reply {got:?} != {want}"));
                    }
                }
                (Err(got), None, Some(want)) => {
                    if Some(got.as_str()) != want.as_str() {
                        failures.push(format!("{label}: refusal {got:?} != {want}"));
                    }
                }
                _ => failures.push(format!("{label}: got {answer:?}, node {case}")),
            }
            let calls = Value::Array(fake.calls.lock().unwrap().clone());
            if calls != case["calls"] {
                failures.push(format!("{label}: calls {calls} != {}", case["calls"]));
            }
        }
        assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
    }

    /// `fixtures/automation-status/golden.json` (`record-automation-status.mjs`): the reply (or
    /// error) of the real Node `createSetupToolExecutor` for `status` on `schedules` and
    /// `webhooks`, over listings of every shape (key order and unlisted keys, attachments,
    /// listener fields as stored, a listing the runtime left out).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_automation_status_is_the_text_node_sends() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/automation-status/golden.json")).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        assert!(cases.len() > 100);

        let Rig { _dir, service, tool, callers, fake } = rig(Vec::new()).await;
        let thread = ThreadId::from("s");
        let cwd = AbsPath::new(std::env::temp_dir()).unwrap();
        let cancel = mixdog_rt::CancellationToken::new();
        let mut failures = Vec::new();
        for (index, case) in cases.iter().enumerate() {
            *callers.0.lock().unwrap() = case["caller"].as_str().unwrap().to_owned();
            *fake.state.lock().unwrap() = golden["states"][case["state"].as_str().unwrap()].clone();
            let args = &case["args"];
            let answer: Result<String, String> = match mixdog_tools::orch::setup_input::validate(args, &tool.spec().input_schema) {
                Err(error) => Err(error.message_for_model),
                Ok(()) => match service.call(ServiceCall { thread: &thread, surface: SurfaceKind::Lead, cwd: &cwd, args, cancel: &cancel }).await {
                    Ok(parts) => match &parts[0] {
                        ToolPart::Text(text) => Ok(text.clone()),
                        _ => panic!("#{index}: a text part was expected"),
                    },
                    Err(error) => Err(message(&error)),
                },
            };
            let label = format!("#{index} {} {} {}", case["caller"], case["state"], args);
            match (&answer, case.get("reply"), case.get("error")) {
                (Ok(got), Some(want), None) if Some(got.as_str()) == want.as_str() => {}
                (Err(got), None, Some(want)) if Some(got.as_str()) == want.as_str() => {}
                _ => failures.push(format!("{label}: got {answer:?}, node {case}")),
            }
        }
        assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
        assert!(fake.calls.lock().unwrap().is_empty(), "a status read only lists");
    }

    #[test]
    fn a_callers_scope_is_the_scope_of_the_access_rules() {
        assert_eq!(access_scope(CallerScope::Human), AccessScope::Human);
        assert_eq!(
            access_scope(CallerScope::Agent { agent_id: "reviewer".into(), unattended: true }),
            AccessScope::Agent { agent_id: "reviewer".into() }
        );
        assert_eq!(access_scope(CallerScope::RoomMember), AccessScope::RoomMember);
        assert_eq!(access_scope(CallerScope::Headless), AccessScope::Headless);
    }
}
