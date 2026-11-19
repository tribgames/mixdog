#[cfg(node_twin)]
use std::path::Path;
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

    #[cfg(node_twin)]
    fn calls(&self) -> Vec<Value> {
        self.calls.lock().unwrap().clone()
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

#[cfg(node_twin)]
fn external_of(value: &Value) -> External {
    External {
        embedding_info: value["embeddingInfo"].clone(),
        onnx_supported: value["onnxSupported"].as_bool().unwrap(),
        git_available: value["gitAvailable"].as_bool().unwrap(),
        local_provider: value["localProvider"].clone(),
        installation_command_error: value["installationCommandError"].as_str().map(str::to_owned),
        effort_judge: EffortJudgeState {
            available: value["effortJudge"]["available"].as_bool().unwrap(),
            installing: value["effortJudge"]["installing"].as_bool().unwrap(),
            ready: value["effortJudge"]["ready"].as_bool().unwrap(),
            last_error: value["effortJudge"]["lastError"].clone(),
            info: value["effortJudge"]["info"].clone(),
        },
    }
}

#[cfg(node_twin)]
fn env_of(env: &Value) -> FeatureEnv {
    let env = env.clone();
    Arc::new(move |name| env.get(name).and_then(Value::as_str).map(str::to_owned))
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

/// The recorder's stand-in store keeps the document as given; Node's real store settles on
/// `canonicalizeUnifiedConfig` at every read and save, which drops the retired `modules.memory`
/// (the modules object stays, emptied or not).
#[cfg(node_twin)]
fn without_retired_memory_module(doc: &Value) -> Value {
    let mut doc = doc.clone();
    if let Some(modules) = doc.get_mut("modules").and_then(Value::as_object_mut) {
        modules.shift_remove("memory");
    }
    doc
}

/// The value, the saved config, the host calls and the errors of Node's setters over 100
/// recorded configs (`record-tool-modules.mjs`).
/// Recorded entries per test: each opens its own service for the value and every setter.
#[cfg(node_twin)]
const ENTRY_CHUNK: usize = 7;

/// What the panel, Doctor and `setup status` (the `toolModules` value) and the tool surface (`builtin_feature_active`, with and
/// without the surface's own grandfathering: there is one decision) read of `agent`.
#[cfg(node_twin)]
fn assert_installed_and_active(label: &str, expected: &Value, panel: &Value, agent: &value::Doc) {
    let env = |_: &str| None::<String>;
    for id in ["git", "memory", "office", "tidy"] {
        let installed = expected["installed"][id].as_bool().unwrap();
        let active = expected["active"][id].as_bool().unwrap();
        assert_eq!(panel[id]["installed"], json!(installed), "{label}: panel {id} installed");
        // The panel's git switch also needs git on PATH, which Node reads from outside the config.
        if id != "git" {
            assert_eq!(panel[id]["enabled"], json!(active), "{label}: panel {id} enabled");
        }
        assert_eq!(builtin_feature_active(agent, id, &env, true), active, "{label}: surface {id}");
        assert_eq!(
            builtin_feature_active(&adopted_stored_agent(agent), id, &env, true),
            active,
            "{label}: grandfathered surface {id}"
        );
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


#[cfg(node_twin)]
fn modules_twin() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/tool-modules-twin.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
#[cfg(node_twin)]
mixdog_rt::replay_chunks!(MODULE_TESTS, #[tokio::test] async the_modules_chunk; [
    the_value_and_every_setter_match_the_recorded_node_module_00 = 0,
    the_value_and_every_setter_match_the_recorded_node_module_01 = 1,
    the_value_and_every_setter_match_the_recorded_node_module_02 = 2,
    the_value_and_every_setter_match_the_recorded_node_module_03 = 3,
    the_value_and_every_setter_match_the_recorded_node_module_04 = 4,
    the_value_and_every_setter_match_the_recorded_node_module_05 = 5,
    the_value_and_every_setter_match_the_recorded_node_module_06 = 6,
    the_value_and_every_setter_match_the_recorded_node_module_07 = 7,
    the_value_and_every_setter_match_the_recorded_node_module_08 = 8,
    the_value_and_every_setter_match_the_recorded_node_module_09 = 9,
    the_value_and_every_setter_match_the_recorded_node_module_10 = 10,
    the_value_and_every_setter_match_the_recorded_node_module_11 = 11,
    the_value_and_every_setter_match_the_recorded_node_module_12 = 12,
    the_value_and_every_setter_match_the_recorded_node_module_13 = 13,
    the_value_and_every_setter_match_the_recorded_node_module_14 = 14,
]);
#[cfg(node_twin)]
#[test]
fn every_recorded_entry_has_its_modules_test() {
    let twin = modules_twin();
    let entries = twin["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 100);
    let setters: usize = entries.iter().map(|entry| entry["setters"].as_array().unwrap().len()).sum();
    assert_eq!(entries.len() + setters, 900);
    mixdog_rt::testing::assert_chunks_registered(MODULE_TESTS, entries.len(), ENTRY_CHUNK);
}
#[cfg(node_twin)]
async fn the_modules_chunk(chunk: usize) {
    let twin = modules_twin();
    let entries = twin["entries"].as_array().unwrap();
    let range = mixdog_rt::testing::chunk_range(entries.len(), chunk, ENTRY_CHUNK);
    for (index, entry) in entries.iter().enumerate().skip(range.start).take(range.len()) {
        // A config with no `builtins` section was recorded over an unadopted stand-in store; the runtime holds the grandfathered
        // config, which the profile-shape table below checks against Node.
        if entry["config"].get("builtins").is_none() {
            continue;
        }
        let external = external_of(&entry["external"]);
        let env = || env_of(&entry["env"]);
        let dir = tempfile::tempdir().unwrap();
        let (modules, _, _, _, cancel) = service(&dir, Some(&entry["config"]), external.clone(), env()).await;
        assert_eq!(modules.settings().await, entry["value"], "entry {index}: value");
        cancel.cancel();

        for setter in entry["setters"].as_array().unwrap() {
            let dir = tempfile::tempdir().unwrap();
            let (modules, host, _, config, cancel) =
                service(&dir, Some(&entry["config"]), external.clone(), env()).await;
            let args = setter["args"].as_array().unwrap();
            let method = setter["method"].as_str().unwrap();
            let flag = |i: usize| args[i].as_bool().unwrap();
            let name = |i: usize| args[i].as_str().unwrap();
            let result = match method {
                "setWebSearchEnabled" => modules.set_web_search_enabled(flag(0)).await,
                "setInstructionFiles" => modules.set_instruction_files(name(0)).await,
                "setAutoEffortBase" => modules.set_auto_effort_base(name(0)).await,
                "setRecapEnabled" => modules.set_recap_enabled(flag(0)).await,
                "setMemoryToolsEnabled" => modules.set_memory_tools_enabled(flag(0)).await,
                "setBuiltinToolEnabled" => modules.set_builtin_tool_enabled(name(0), flag(1)).await,
                "installBuiltinFeature" => {
                    let engines = args.get(1).map(|options| {
                        options["engines"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|e| e.as_str().unwrap().to_owned())
                            .collect()
                    });
                    modules.install_builtin_feature(name(0), engines).await
                }
                other => panic!("{other}"),
            };
            let label = format!("entry {index} {method} {args:?}");
            match (&result, setter.get("error")) {
                (Err(error), Some(expected)) => assert_eq!(&json!(error.to_string()), expected, "{label}"),
                (Ok(value), None) => assert_eq!(value, &setter["value"], "{label}: value"),
                _ => panic!("{label}: {result:?} vs {:?}", setter.get("error")),
            }
            let expected_doc = setter
                .get("saved")
                .filter(|saved| !saved.is_null())
                .unwrap_or(&entry["config"]);
            assert_eq!(&Value::Object(config.agent()), &without_retired_memory_module(expected_doc), "{label}: config");
            // Departure: Node skipped the runtime preparation of an explicit Local provider enable when the host's status already
            // read `runtime.installed: true`; the core verifies the runtime on every explicit enable, since that status is display
            // state, not verification (`explicit_enable_does_not_accept_runtime_display_status_as_verification`).
            let mut calls = setter["calls"].as_array().unwrap().clone();
            let prepare = json!(["prepare", "localProvider"]);
            if method == "setBuiltinToolEnabled" && name(0) == "localProvider" && flag(1) && calls.first() != Some(&prepare) {
                calls.insert(0, prepare);
            }
            assert_eq!(Value::Array(host.calls()), Value::Array(calls), "{label}: host calls");
            cancel.cancel();
        }
    }
}
#[cfg(node_twin)]
fn grandfathering_twin() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/builtin-grandfathering-twin.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
/// Every stored shape Node's writers leave (legacy, fresh, with `builtins`, a section holding only `autoClear` or `compaction`
/// from the desktop settings store, a setter's seeded first write on a fresh and on a legacy profile) × a read, installing,
/// enabling and disabling built-ins, against Node's values from the 1.4.5 tree (`record-builtin-grandfathering.mjs`: the real
/// `loadConfig`, `withGrandfatheredBuiltins`, `builtinInstalled`, `builtinFeatureActive` and the setters' config edits over
/// `saveConfigAndAdopt`). Each case is read by the panel and the surface, then again from the file as a restart reads it.
#[cfg(node_twin)]
#[tokio::test]
async fn the_install_markers_equal_nodes_over_every_profile_shape_and_toggle() {
    let twin = grandfathering_twin();
    assert_eq!(twin["cases"].as_array().unwrap().len(), 56);
    for case in twin["cases"].as_array().unwrap() {
        let label = format!("{} {}", case["shape"], case["op"]);
        let dir = tempfile::tempdir().unwrap();
        let stored = &twin["shapes"][case["shape"].as_str().unwrap()];
        // `null` is a first start: no stored agent section at all.
        let (modules, _, _, config, cancel) =
            service(&dir, Some(stored).filter(|stored| !stored.is_null()), plain_external(), Arc::new(|_| None)).await;
        let op = case["op"].as_str().unwrap();
        let panel = match op.split_once(':') {
            None => modules.settings().await,
            Some(("install", name)) => modules.install_builtin_feature(name, None).await.unwrap(),
            Some(("enable", name)) => modules.set_builtin_tool_enabled(name, true).await.unwrap(),
            Some(("disable", name)) => modules.set_builtin_tool_enabled(name, false).await.unwrap(),
            Some(other) => panic!("{other:?}"),
        };
        assert_installed_and_active(&label, case, &panel, &config.agent());
        cancel.cancel();

        // A restart: the file alone says the same.
        let (reopened, _, _, config, cancel) = service(&dir, None, plain_external(), Arc::new(|_| None)).await;
        assert_installed_and_active(&format!("{label} after a restart"), case, &reopened.settings().await, &config.agent());
        cancel.cancel();
    }
}
