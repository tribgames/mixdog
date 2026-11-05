use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_protocol::SectionName;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::config::ConfigLanes;

struct MockHost {
    external: Mutex<External>,
    calls: Mutex<Vec<Value>>,
    tick: watch::Sender<u64>,
}

impl MockHost {
    fn new(external: External) -> Arc<Self> {
        Arc::new(Self {
            external: Mutex::new(external),
            calls: Mutex::default(),
            tick: watch::channel(0).0,
        })
    }

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
    ) -> Result<(), String> {
        self.record(match engines {
            Some(engines) => json!(["prepare", name, { "engines": engines }]),
            None => json!(["prepare", name]),
        });
        Ok(())
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
        std::fs::write(&path, serde_json::to_vec(config).unwrap()).unwrap();
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

/// The value, the saved config, the host calls and the errors of Node's setters over 100
/// recorded configs (`record-tool-modules.mjs`).
#[tokio::test]
async fn the_value_and_every_setter_match_the_recorded_node_module() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/desktop/settings/tool-modules-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let entries = twin["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 100);
    let mut compared = 0;
    for (index, entry) in entries.iter().enumerate() {
        let external = external_of(&entry["external"]);
        let env = || env_of(&entry["env"]);
        let dir = tempfile::tempdir().unwrap();
        let (modules, _, _, _, cancel) = service(&dir, Some(&entry["config"]), external.clone(), env()).await;
        assert_eq!(modules.settings().await, entry["value"], "entry {index}: value");
        cancel.cancel();
        compared += 1;

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
            assert_eq!(&Value::Object((*config.full()).clone()), expected_doc, "{label}: config");
            assert_eq!(Value::Array(host.calls()), setter["calls"], "{label}: host calls");
            cancel.cancel();
            compared += 1;
        }
    }
    assert_eq!(compared, 900);
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
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the push did not arrive");
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
        .update(|doc| {
            doc.insert("autoEffortBase".into(), json!("high"));
            Ok(())
        })
        .await
        .unwrap();
    until(|| tool_modules_frames(&publisher) == 3).await;
    assert_eq!(modules.settings().await["autoEffortBase"], "high");

    cancel.cancel();
}
