//! `announceSettingsChange` (`session-runtime/boot/providers.mjs`): the step that announces a settings change to the attached surfaces.
//! Node runs it from `applyConfigChange` (`config-lifecycle.mjs`) when `diffConfigSnapshots` finds `settings` changed: the stored
//! settings root without its `desktop` section, and the secret change tokens, differ from what this runtime last applied
//! (`configChangeSnapshot`, `config-change-effects.mjs`). The baseline is the configuration at boot. A rewrite of identical content,
//! a change of the `desktop` section alone, and a token refresh nobody announced are not settings changes.

use std::sync::Arc;

use mixdog_core_config::config::Config;
use mixdog_core_config::config::SecretChanges;
use mixdog_rt::TaskClass;
use serde_json::json;
use tokio::sync::watch;

/// `configChangeSnapshot(...).settings`.
fn settings_signature(config: &Config, secrets: &SecretChanges) -> String {
    let mut root = (*config.full()).clone();
    root.remove("desktop");
    json!([root, secrets.tokens()]).to_string()
}

pub struct SettingsChanges {
    announced: watch::Sender<u64>,
}

impl SettingsChanges {
    /// Starts following `config`: the configuration as it is now is the applied baseline.
    pub fn start(config: Config, secrets: Arc<SecretChanges>) -> Arc<Self> {
        let (announced, _) = watch::channel(0_u64);
        let this = Arc::new(Self { announced });
        let mut ticks = config.changes();
        let mut applied = settings_signature(&config, &secrets);
        let sender = this.announced.clone();
        drop(mixdog_rt::spawn("settings-changes", TaskClass::Work, async move {
            while ticks.changed().await.is_ok() {
                let next = settings_signature(&config, &secrets);
                if next != applied {
                    applied = next;
                    sender.send_modify(|count| *count += 1);
                }
            }
        }));
        this
    }

    /// The count of settings changes announced so far; it moves once per announcement.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.announced.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::Reply;
    use mixdog_core_api::ThreadDirectory;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::ids::OpId;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_config::config::ConfigLanes;
    use mixdog_core_session::session::NewThreadRoute;
    use mixdog_core_session::session::SessionDirectory;
    use mixdog_core_session::session::testing::Rig;
    use mixdog_core_session::session::testing::lock;
    use serde_json::Value;

    use super::*;

    /// The route a draft carries, adopted: the save `route/set` makes (`save_agent_config`, here `Config::update` of the same `agent`
    /// section, the preset the real-turn harness's `route-set.json` records) while the thread is being created.
    struct ConfigSavingRoute(Config);

    #[async_trait::async_trait]
    impl NewThreadRoute for ConfigSavingRoute {
        async fn adopt(&self, _: &ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
            self.0
                .update(|doc| {
                    doc.insert("agent".into(), serde_json::json!({ "default": "workflow-lead", "presets": [{ "id": "workflow-lead", "provider": "custom-harness", "model": "harness-model" }] }));
                    Ok(())
                })
                .await
                .map_err(|error| format!("{error:?}"))?;
            Ok(serde_json::Map::new())
        }

        async fn adopt_control(&self, _: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
            Ok(serde_json::Map::new())
        }

        async fn seat(&self, _: &ThreadId) -> Result<(), String> {
            Ok(())
        }
    }

    /// The chain a draft route's save travels, in the order the real-turn harness runs it (`thread/start` with `draft.route`): the session
    /// exists, the route's write reaches the config -> the config's change tick -> [`SettingsChanges`] (the stored settings differ from the
    /// boot baseline) -> the counter the thread's actor follows -> `setupChanged` in the runtime state the thread publishes, equal to what the
    /// Node daemon recorded for that flow. The config, the secret tokens and the counter are the daemon's own types (`compose_flip`); the
    /// thread is the session actor on the session test doubles.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_saved_route_reaches_the_threads_state_as_setup_changed() {
        let dir = tempfile::tempdir().expect("dir");
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.expect("config");
        let secrets = mixdog_core_config::config::secret_changes::SecretChanges::open(config.clone()).await;
        let changes = SettingsChanges::start(config.clone(), secrets);

        let rig = Rig::new();
        *lock(&rig.compaction.settings) = Some(changes.subscribe());
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.new_route = Arc::new(ConfigSavingRoute(config.clone()));
        let directory = SessionDirectory::new(Arc::new(deps));
        let request = |method: &'static str, params: Value, op: &str| CoreRequest {
            method: Method(method),
            params,
            op: Some(OpId::from(op)),
            ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
        };
        let reply = directory.request(request("thread/start", serde_json::json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");

        let setup = || {
            rig.feeds
                .frames(id.as_str())
                .into_iter()
                .rev()
                .find(|(_, method, params)| method == "thread/runtime/updated" && params["value"]["setupChanged"].is_object())
                .map(|(_, _, params)| params["value"]["setupChanged"].clone())
        };
        let found = loop {
            let stepped = handle.stepped().notified();
            tokio::pin!(stepped);
            stepped.as_mut().enable();
            if let Some(found) = setup() {
                break found;
            }
            stepped.await;
        };
        let recorded: Value = serde_json::from_str(include_str!("../../../mixdog-core-session/testdata/node-setup-changed.json")).expect("the recording parses");
        let node = &recorded["frame"]["patch"]["set"]["setupChanged"];
        assert_eq!((&found["action"], &found["seq"]), (&node["action"], &node["seq"]));
    }
}
