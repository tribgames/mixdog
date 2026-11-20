use std::sync::Mutex;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_protocol::SectionName;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::config::ConfigLanes;

struct MockHost {
    external: Mutex<External>,
    prepare_error: Mutex<Option<String>>,
    calls: Mutex<Vec<Value>>,
    tick: watch::Sender<u64>,
}

impl MockHost {
    fn new(external: External) -> Arc<Self> {
        Arc::new(Self {
            external: Mutex::new(external),
            prepare_error: Mutex::default(),
            calls: Mutex::default(),
            tick: watch::channel(0).0,
        })
    }


    fn record(&self, call: Value) {
        self.calls.lock().unwrap().push(call);
    }
}

#[async_trait]
impl ToolModulesHost for MockHost {
    async fn external(&self) -> External {
        self.external.lock().unwrap().clone()
    }

    fn changes(&self) -> watch::Receiver<u64> {
        self.tick.subscribe()
    }

    async fn prepare_builtin_feature(
        &self,
        name: &str,
        engines: Option<&[String]>,
    ) -> Result<Option<Value>, String> {
        self.record(match engines {
            Some(engines) => json!(["prepare", name, { "engines": engines }]),
            None => json!(["prepare", name]),
        });
        if let Some(error) = self.prepare_error.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(None)
    }

    async fn stop_local_provider_server(&self) {
        self.record(json!(["stopServer"]));
    }

    async fn sync_local_provider_registry(&self, enabled: bool) {
        self.record(json!(["syncRegistry", enabled]));
    }

    async fn shutdown_effort_judge(&self) {
        // Node's call goes to the real judge client, which the recorder does not observe.
    }

    fn invalidate_context_status_cache(&self) {
        self.record(json!(["invalidateContext"]));
    }

    fn invalidate_pre_session_tool_surface(&self) {
        self.record(json!(["invalidateSurface"]));
    }
}

fn lanes() -> ConfigLanes {
    let tokens = mixdog_rt::testing::tokens();
    ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io }
}



async fn service(
    dir: &tempfile::TempDir,
    config: Option<&Value>,
    external: External,
    env: FeatureEnv,
) -> (Arc<ToolModules>, Arc<MockHost>, Arc<MockStatePublisher>, Config, CancellationToken) {
    let path = dir.path().join("mixdog-config.json");
    if let Some(config) = config {
        // The recorded configs are Node's flat agent config; on disk it is the `agent` section.
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": config })).unwrap()).unwrap();
    }
    let publisher = Arc::new(MockStatePublisher::default());
    let (config, _) = Config::open(path, publisher.clone(), lanes()).await.unwrap();
    let host = MockHost::new(external);
    let cancel = CancellationToken::new();
    let modules = ToolModules::with_env(config.clone(), host.clone(), publisher.clone(), cancel.clone(), env);
    (modules, host, publisher, config, cancel)
}

fn tool_modules_frames(publisher: &MockStatePublisher) -> usize {
    publisher
        .published()
        .iter()
        .filter(|(section, _, _)| *section == SectionName::ToolModules)
        .count()
}

#[tokio::test]
async fn explicit_enable_does_not_accept_runtime_display_status_as_verification() {
    let dir = tempfile::tempdir().unwrap();
    let (modules, host, _, _, cancel) = service(&dir, None, plain_external(), Arc::new(|_| None)).await;
    *host.prepare_error.lock().unwrap() = Some("runtime verification failed".into());
    let error = modules.set_builtin_tool_enabled("localProvider", true).await.unwrap_err();
    assert_eq!(error.to_string(), "runtime verification failed");
    assert_eq!(modules.settings().await["localProvider"]["enabled"], false);
    assert_eq!(*host.calls.lock().unwrap(), [json!(["prepare", "localProvider"])]);
    cancel.cancel();
}

#[tokio::test]
async fn runtime_completion_activates_unless_off_was_saved_after_the_start() {
    use mixdog_services::local_provider::provider::ToolSettings;

    for concurrent_off in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (modules, host, _, config, cancel) =
            service(&dir, None, plain_external(), Arc::new(|_| None)).await;
        let epoch = modules.runtime_activation_epoch();
        if concurrent_off {
            modules.set_builtin_tool_enabled("localProvider", false).await.unwrap();
        }
        modules.runtime_installed(epoch).await.unwrap();
        let settings = modules.settings().await;
        assert_eq!(settings["localProvider"]["installed"], true);
        assert_eq!(settings["localProvider"]["enabled"], !concurrent_off);
        assert_eq!(config.agent()["providers"]["mixdog-local"]["enabled"], !concurrent_off);
        let calls = host.calls.lock().unwrap().clone();
        let expected = if concurrent_off {
            vec![json!(["stopServer"]), json!(["syncRegistry", false])]
        } else {
            vec![json!(["syncRegistry", true])]
        };
        assert_eq!(calls, expected);
        cancel.cancel();
    }
}

fn plain_external() -> External {
    External {
        embedding_info: json!({ "model": "m" }),
        onnx_supported: true,
        git_available: true,
        local_provider: json!({ "runtime": { "installed": true } }),
        installation_command_error: None,
        effort_judge: EffortJudgeState {
            available: true,
            installing: false,
            ready: false,
            last_error: json!(""),
            info: json!({}),
        },
    }
}




/// A 1.4.5 profile holding only `agent.autoClear.enabled:false` (the desktop settings store's write, no install marker) is
/// grandfathered by Node's load. In the product every writer works from the config loaded from disk, so a first write by any of
/// them keeps Git, Memory and Office installed, as the next start reads them.
#[tokio::test]
async fn every_production_writer_keeps_the_three_on_an_autoclear_only_profile() {
    use mixdog_agent::compact::settings_service::AgentChange;
    use mixdog_agent::compact::settings_service::AgentConfigStore;

    let stored = json!({ "autoClear": { "enabled": false } });
    for writer in ["agent_store", "save_and_adopt", "tool_modules"] {
        let dir = tempfile::tempdir().unwrap();
        let (modules, _, _, config, cancel) = service(&dir, Some(&stored), plain_external(), Arc::new(|_| None)).await;
        assert_eq!(config.origin(), Origin::Loaded, "the product's handle");
        match writer {
            "agent_store" => {
                let change: AgentChange = Box::new(|agent| {
                    agent.insert("reactions".into(), json!(false));
                    Ok(())
                });
                AgentConfigStore::update(&config, change).await.unwrap();
            }
            "save_and_adopt" => {
                let before = config.agent();
                let mut after = before.clone();
                after.insert("reactions".into(), json!(false));
                crate::config::settings::save_and_adopt(&config, &before, &after).await.unwrap();
            }
            _ => {
                modules.set_instruction_files("claude").await.unwrap();
            }
        }
        cancel.cancel();
        // The next start: the file alone.
        let (reopened, _, _, config, cancel) = service(&dir, None, plain_external(), Arc::new(|_| None)).await;
        let panel = reopened.settings().await;
        for id in ["git", "memory", "office"] {
            assert_eq!(panel[id]["installed"], json!(true), "{writer}: {id}");
        }
        assert_eq!(panel["tidy"]["installed"], json!(false), "{writer}: tidy");
        assert!(config.agent()["builtins"].is_object(), "{writer}: the seed is stored");
        cancel.cancel();
    }
}

/// A fresh profile whose first agent write adds a user-mark key stays fresh: nothing is grandfathered afterwards.
#[tokio::test]
async fn a_first_write_on_a_fresh_profile_does_not_grandfather_it() {
    let dir = tempfile::tempdir().unwrap();
    let (modules, _, _, config, cancel) = service(&dir, None, plain_external(), Arc::new(|_| None)).await;
    let panel = modules.set_web_search_enabled(false).await.unwrap();
    for id in ["git", "memory", "office"] {
        assert_eq!(panel[id]["installed"], json!(false), "{id}");
    }
    assert_eq!(config.agent()["builtins"], json!({}));
    cancel.cancel();
}

#[tokio::test]
async fn a_setter_pushes_once_and_an_unchanged_value_pushes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (modules, _, publisher, _, cancel) =
        service(&dir, None, plain_external(), Arc::new(|_| None)).await;
    until(|| tool_modules_frames(&publisher) == 1).await;

    let value = modules.set_instruction_files("claude").await.unwrap();
    assert_eq!(value["instructionFiles"], "claude");
    assert_eq!(tool_modules_frames(&publisher), 2);
    modules.set_instruction_files("claude").await.unwrap();
    assert_eq!(tool_modules_frames(&publisher), 2);
    cancel.cancel();
}

async fn until(condition: impl Fn() -> bool) {
    while !condition() {
        tokio::task::yield_now().await;
    }
}

/// A status tick from the host and a config edit from any other writer both push; no timer.
#[tokio::test]
async fn host_status_and_other_config_writers_push_without_polling() {
    let dir = tempfile::tempdir().unwrap();
    let (modules, host, publisher, config, cancel) =
        service(&dir, None, plain_external(), Arc::new(|_| None)).await;
    until(|| tool_modules_frames(&publisher) == 1).await;

    host.external.lock().unwrap().local_provider =
        json!({ "runtime": { "installed": true }, "installations": [{ "phase": "model", "state": "running" }] });
    host.tick.send_modify(|tick| *tick += 1);
    until(|| tool_modules_frames(&publisher) == 2).await;

    config
        .update_agent(|doc| {
            doc.insert("autoEffortBase".into(), json!("high"));
            Ok(())
        })
        .await
        .unwrap();
    until(|| tool_modules_frames(&publisher) == 3).await;
    assert_eq!(modules.settings().await["autoEffortBase"], "high");

    cancel.cancel();
}


