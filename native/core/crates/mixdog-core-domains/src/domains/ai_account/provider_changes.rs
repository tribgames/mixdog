//! What a change of the providers does: `change.providers` of `createConfigChangeEffects`
//! (`session-runtime/config-change-effects.mjs`), run by `applyConfigChange`
//! (`config-lifecycle.mjs`) after every persisted change.
//!
//! One subscriber follows [`Config::changes`], the one signal a config edit, an external edit
//! and a stored secret change (`SecretChanges`) all tick. It compares the providers' signature
//! with the one last applied and, when it differs, releases the admission cooldowns and
//! re-initializes the providers. An effect that fails is marked not applied and retried after a
//! backoff, whatever else changes meanwhile (`settleConfigEffects`).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use mixdog_ai::admission::Admission;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::SecretChanges;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::task::JoinHandle;

/// `effectRetryDelaysMs`: the last delay repeats.
pub const RETRY_DELAYS: [Duration; 4] =
    [Duration::from_secs(1), Duration::from_secs(4), Duration::from_secs(15), Duration::from_secs(60)];

/// `PROVIDER_SECRET_ACCOUNT`: `agent.<id>.apiKey`, a custom provider's `agent.<id>.apiKey.<keyId>`,
/// and `#deleted` (a deletion may remove a secret the marker never listed).
fn is_provider_secret(account: &str) -> bool {
    if account == "#deleted" {
        return true;
    }
    let Some(rest) = account.strip_prefix("agent.") else { return false };
    let Some((id, tail)) = rest.split_once('.') else { return false };
    !id.is_empty() && tail.strip_prefix("apiKey").is_some_and(|after| after.is_empty() || after.starts_with('.'))
}

/// `configChangeSnapshot(...).providers`: the stored `agent.providers`, the developer options
/// that shape provider clients, and the change tokens of the provider secrets. Tokens are
/// compared, never the secret values.
pub fn providers_signature(config: &Config, tokens: &BTreeMap<String, String>) -> String {
    let secrets: Vec<(&String, &String)> = tokens.iter().filter(|(account, _)| is_provider_secret(account)).collect();
    json!([config.get("agent.providers").unwrap_or(Value::Null), config.get("agent.developer").unwrap_or(Value::Null), secrets]).to_string()
}

/// The two effects of a providers change.
pub trait ProviderChangeEffects: Send + Sync + 'static {
    /// `resetProviderAdmissionCooldowns()`: the cooldowns belong to the old credentials.
    fn release_admission_cooldowns(&self);
    /// `reinitProviders()`: the registry is rebuilt from the reloaded config.
    fn reinit_providers(&self) -> BoxFuture<'static, Result<(), String>>;
}

/// The live services behind [`ProviderChangeEffects`].
pub struct LiveProviderEffects {
    pub admission: Arc<Admission>,
    pub readiness: Arc<ProviderReadiness>,
}

impl ProviderChangeEffects for LiveProviderEffects {
    fn release_admission_cooldowns(&self) {
        self.admission.reset_cooldowns(None);
    }

    fn reinit_providers(&self) -> BoxFuture<'static, Result<(), String>> {
        let readiness = self.readiness.clone();
        Box::pin(async move { readiness.reinit_providers().await.map_err(|error| error.message) })
    }
}

/// Starts the subscriber. The signature at the start is the baseline (Node's boot snapshot), so
/// nothing runs until something differs. Dropping the handle does not stop it; aborting does.
pub fn spawn_provider_changes(
    config: Config,
    secrets: Arc<SecretChanges>,
    effects: Arc<dyn ProviderChangeEffects>,
    retry_delays: Vec<Duration>,
) -> JoinHandle<()> {
    mixdog_rt::spawn("provider-changes", TaskClass::Work, async move {
        let mut changes = config.changes();
        let signature = || providers_signature(&config, &secrets.tokens());
        // `None`: an effect failed, so it differs from every signature and the next pass runs it.
        let mut applied = Some(signature());
        let mut attempt = 0usize;
        loop {
            let backoff = (applied.is_none() && !retry_delays.is_empty()).then(|| retry_delays[attempt.min(retry_delays.len() - 1)]);
            match backoff {
                Some(delay) => {
                    tokio::select! {
                        heard = changes.changed() => if heard.is_err() { return },
                        () = tokio::time::sleep(delay) => attempt += 1,
                    }
                }
                None => {
                    if changes.changed().await.is_err() {
                        return;
                    }
                }
            }
            let now = signature();
            if applied.as_ref() == Some(&now) {
                continue;
            }
            effects.release_admission_cooldowns();
            match effects.reinit_providers().await {
                Ok(()) => {
                    applied = Some(now);
                    attempt = 0;
                }
                Err(_) => applied = None,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::ConfigLanes;
    use mixdog_secrets::MemoryStore;
    use mixdog_secrets::SecretStore;
    use serde_json::Map;

    use super::*;

    /// Records the effects; the first `reinit` fails when `fail_first`.
    struct Recording {
        calls: Mutex<Vec<String>>,
        fail_first: bool,
    }

    impl ProviderChangeEffects for Recording {
        fn release_admission_cooldowns(&self) {
            self.calls.lock().unwrap().push("releaseAdmissionCooldowns".to_owned());
        }

        fn reinit_providers(&self) -> BoxFuture<'static, Result<(), String>> {
            let mut calls = self.calls.lock().unwrap();
            calls.push("reinitProviders".to_owned());
            let failed = self.fail_first && calls.iter().filter(|c| *c == "reinitProviders").count() == 1;
            Box::pin(async move { if failed { Err("registry refused".to_owned()) } else { Ok(()) } })
        }
    }

    fn set_in(doc: &mut Map<String, Value>, path: &[Value], value: &Value) {
        let (last, parents) = path.split_last().unwrap();
        let mut node = doc;
        for key in parents {
            let slot = node.entry(key.as_str().unwrap().to_owned()).or_insert_with(|| Value::Object(Map::new()));
            node = slot.as_object_mut().unwrap();
        }
        node.insert(last.as_str().unwrap().to_owned(), value.clone());
    }

    struct World {
        _dir: tempfile::TempDir,
        config: Config,
        store: Arc<dyn SecretStore>,
        secrets: Arc<SecretChanges>,
        effects: Arc<Recording>,
        task: JoinHandle<()>,
    }

    async fn world(fail_first: bool, retry: Duration) -> World {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let dir = tempfile::tempdir().unwrap();
        let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        config
            .update(|doc| {
                doc.insert("agent".into(), json!({ "providers": { "openai": { "enabled": false } }, "theme": "old" }));
                Ok(())
            })
            .await
            .unwrap();
        let secrets = SecretChanges::open(config.clone()).await;
        let store: Arc<dyn SecretStore> = mixdog_core_config::config::AnnouncingStore::new(Arc::new(MemoryStore::default()), secrets.clone());
        let effects = Arc::new(Recording { calls: Mutex::default(), fail_first });
        let task = spawn_provider_changes(config.clone(), secrets.clone(), effects.clone(), vec![retry]);
        World { _dir: dir, config, store, secrets, effects, task }
    }

    async fn quiet() {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    /// Which changes re-initialize the providers, against the recorded Node run: its real
    /// `applyConfigChange` over config edits and key saves. Only the provider effects are compared.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_same_changes_reinitialize_the_providers_as_in_node() {
        let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/provider-change-effects/golden.json")).unwrap();
        let w = world(false, Duration::from_secs(1)).await;
        let steps = golden["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 14);
        for step in steps {
            let name = step["name"].as_str().unwrap();
            w.effects.calls.lock().unwrap().clear();
            match step["op"].as_str().unwrap() {
                "agent" => {
                    let (path, value) = (step["path"].as_array().unwrap().clone(), step["value"].clone());
                    w.config.update_agent(move |agent| {
                        set_in(agent, &path, &value);
                        Ok(())
                    })
                    .await
                    .unwrap();
                }
                "secret" => w.store.set(step["account"].as_str().unwrap(), "value").await.unwrap(),
                "delete" => w.store.delete(step["account"].as_str().unwrap()).await.unwrap(),
                "announce" => w.secrets.announce(&format!("#{}", step["key"].as_str().unwrap()), false).await,
                _ => {}
            }
            quiet().await;
            let want: Vec<&str> = step["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c.as_str().unwrap())
                .filter(|c| matches!(*c, "releaseAdmissionCooldowns" | "reinitProviders"))
                .collect();
            assert_eq!(*w.effects.calls.lock().unwrap(), want, "{name}");
        }
        w.task.abort();
    }

    /// A re-init that fails is run again after the backoff, with the cooldowns released again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_reinit_is_retried_after_the_backoff() {
        let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/provider-change-effects/golden.json")).unwrap();
        let strings = |value: &Value| value.as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_owned()).collect::<Vec<_>>();
        let provider_calls = |calls: Vec<String>| calls.into_iter().filter(|c| matches!(c.as_str(), "releaseAdmissionCooldowns" | "reinitProviders")).collect::<Vec<_>>();
        let w = world(true, Duration::from_millis(60)).await;
        w.config
            .update_agent(|agent| {
                set_in(agent, &[json!("providers"), json!("openai"), json!("enabled")], &json!(true));
                Ok(())
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(*w.effects.calls.lock().unwrap(), provider_calls(strings(&golden["retried"]["firstAttempt"])));
        quiet().await;
        assert_eq!(*w.effects.calls.lock().unwrap(), provider_calls(strings(&golden["retried"]["afterBackoff"])));
        w.task.abort();
    }
}
