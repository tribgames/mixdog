//! Node's config snapshot cases (`fixtures/config-snapshot-cases`, `record-config-snapshot-cases.mjs`): each recorded
//! step against the daemon's own pieces (the config, its file watch, the production provider builder, the provider
//! admin's logout, the OAuth provider's own credential save and forget, and the provider sync that rebuilds the
//! runtime's loaded config), and after each step the whole loaded config (`LoadedConfig`, the runtime's `getConfig()`)
//! against the config Node's read returned. A case with a `tick` runs on a clock that starts at Node's `now` and moves
//! only by the recorded ticks, carried over from case to case as Node's one mocked clock is.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::Pace;
use mixdog_core_config::config::ConfigWatcher;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::model_list_node_tests::Rig;
use super::model_list_node_tests::rig_paced;
use super::model_list_tests::Offline;
use super::provider_sync::spawn_provider_sync_on;
use crate::domains::ai_account::ProviderAdmin;
use crate::domains::ai_account::collaborators::AuthRefresh;
use crate::domains::ai_account::collaborators::OAuthProvider;
use crate::domains::ai_account::collaborators::VertexAdc;
use crate::domains::ai_account::production::OAuthWiring;
use crate::domains::ai_account::production::oauth_providers;

fn fixture(name: &str) -> Value {
    let text = match name {
        "golden.json" => mixdog_testkit::fixture!("../../fixtures/config-snapshot-cases/golden.json"),
        _ => mixdog_testkit::fixture!("../../fixtures/config-snapshot-cases/MANIFEST.json"),
    };
    serde_json::from_str(text).unwrap()
}

/// A clock that stands still between the recorded ticks (Node's `mock.timers`), waking its waits when it moves.
struct Ticks {
    now: AtomicU64,
    moved: Notify,
}

impl Ticks {
    fn advance(&self, ms: u64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
        self.moved.notify_waiters();
    }
}

#[async_trait]
impl Pace for Ticks {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }

    async fn wait(&self, duration: Duration) {
        let until = self.now_ms() + u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
        loop {
            let moved = self.moved.notified();
            tokio::pin!(moved);
            moved.as_mut().enable();
            if self.now_ms() >= until {
                return;
            }
            moved.await;
        }
    }
}

struct NoRefresh;

impl AuthRefresh for NoRefresh {
    fn after_credential_change(&self) {}
    fn adopt_credentials(&self) {}
    fn after_usage_auth_change(&self) {}
    fn release_admission_cooldowns(&self) {}
    fn account_selection_changed(&self) {}
}

struct NoAdc;

#[async_trait]
impl VertexAdc for NoAdc {
    async fn login(&self, _: &str) -> Result<Option<String>, String> {
        unreachable!("a logout runs no gcloud check")
    }
}

struct NoHistory;

#[async_trait]
impl mixdog_ai::service::oauth_usage::QuotaHistory for NoHistory {
    async fn record(&self, _: Vec<mixdog_ai::service::oauth_usage::QuotaSample>) -> Result<(), String> {
        Ok(())
    }
}

/// The ten OAuth providers' credential modules and the provider admin over the rig's own builder, account store,
/// config and registry: what `forgetProviderAuth` and a provider's own token save and forget run through.
fn admin_of(rig: &Rig) -> (Arc<ProviderAdmin>, Arc<dyn OAuthProvider>) {
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let http: Arc<dyn mixdog_ai::transport::HttpSend> = Arc::new(Offline);
    let data = rig._dir.path().to_path_buf();
    let versions = mixdog_ai::client_versions::ClientVersions::new(http.clone(), data.clone(), io, rig.env.clone());
    let wiring = Arc::new(OAuthWiring {
        accounts: rig.accounts.clone(),
        http: http.clone(),
        pace: Arc::new(mixdog_ai::oauth::SystemPace),
        file: OAuthWiring::files_of(rig.accounts.clone()),
        io,
        plugin_data: data.clone(),
        versions: versions.clone(),
        now_ms: Arc::new(|| i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap()),
        env: rig.env.clone(),
        cli_auth: data.join("command-code-cli-auth.json"),
    });
    let providers = oauth_providers(&wiring);
    let openai = providers.iter().find(|provider| provider.id() == "openai-oauth").unwrap().clone();
    let oauth_usage = mixdog_ai::service::oauth_usage::OAuthUsage::new(mixdog_ai::service::oauth_usage::UsageDeps {
        http: Arc::new(mixdog_ai::service::usage_ports::RoutedUsageHttp::new(http.clone())),
        source: Arc::new(mixdog_ai::service::usage_ports::ProviderUsageSource::new(rig.accounts.clone(), http).with_versions(versions.clone())),
        grok: Arc::new(mixdog_ai::service::usage_ports::GrokVersionHeaders::new(versions)),
        history: Arc::new(NoHistory),
        store: rig.accounts.clone(),
        io,
        log: Arc::new(|_| {}),
        data_dir: data,
    });
    let admin = ProviderAdmin::new(
        providers,
        rig.builder.clone(),
        rig.accounts.clone(),
        Arc::new(mixdog_ai::registry::keys::MemoryVault::default()),
        rig.config.clone(),
        Arc::new(NoRefresh),
        Arc::new(NoAdc),
        rig.registry.clone(),
        oauth_usage,
        io,
    );
    (admin, openai)
}

/// Another process's write: a whole new file renamed into place.
fn foreign_write(path: &std::path::Path, text: &str) {
    let tmp = path.with_extension("json.foreign-tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

/// The loaded config as its change from the base read over an empty data dir, through the production
/// `create_config_patch`, as Node's recording took it with its own from its own base.
fn stored(base: &serde_json::Map<String, Value>, loaded: &serde_json::Map<String, Value>) -> Value {
    use mixdog_core_config::config::patch::ChangeOp;
    let changes = mixdog_core_config::config::patch::create_config_patch(base, loaded);
    Value::Array(
        changes
            .into_iter()
            .map(|change| match change.op {
                ChangeOp::Set(value) => json!({ "path": change.path, "value": value }),
                ChangeOp::Remove => json!({ "path": change.path, "remove": true }),
            })
            .collect(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_replayed_config_snapshot_read_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let cases = golden["cases"].as_array().unwrap();
    let mut replayed = 0;
    // Node's mocked clock is enabled once for the file: each case starts where the previous case's ticks left it.
    let mut clock = golden["now"].as_u64().unwrap();
    for case in cases {
        let name = case["case"].as_str().unwrap();
        let steps = case["steps"].as_array().unwrap();
        // The data dir's credential file is where the account store keeps a provider's own file.
        let nested = steps.iter().find(|s| s["op"] == "credentialPath").map(|s| s["at"].as_str().unwrap().to_owned());
        let env = nested.as_ref().map_or(json!({}), |at| json!({ "OPENAI_OAUTH_CREDENTIALS_PATH": format!("__DATA_DIR__/accounts/{at}") }));
        let ticks = Arc::new(Ticks { now: AtomicU64::new(clock), moved: Notify::new() });
        let paced = steps.iter().any(|s| s["op"] == "tick");
        let pace: Arc<dyn Pace> = if paced { ticks.clone() } else { Arc::new(mixdog_ai::oauth::SystemPace) };
        let rig = rig_paced(&json!({ "agent": {}, "env": env }), &json!({ "modelsDev": {}, "litellm": {} }), false, None, Some(pace.clone())).await;
        let path = rig._dir.path().join("mixdog-config.json");
        let accounts_dir: PathBuf = rig._dir.path().join("accounts");
        // The data dir exists before anything reads it, as Node's does.
        std::fs::create_dir_all(&accounts_dir).unwrap();
        let credentials = accounts_dir.join("openai-oauth.json");
        let nested_file = nested.as_ref().map(|at| accounts_dir.join(at));
        // A credential the case writes before its first read is there when the loaded config is first built.
        let (admin, openai) = admin_of(&rig);
        let _watch = ConfigWatcher::start(rig.config.clone()).unwrap();
        let stop = CancellationToken::new();
        let mut started = None;
        // The core's own base: its loaded config over the case's empty data dir, as Node's base is its read there.
        let base = (*rig.loaded.get()).clone();
        let base = &base;
        let mut in_place: Option<std::fs::File> = None;
        for (index, step) in steps.iter().enumerate() {
            let text = step["text"].as_str().unwrap_or_default();
            // The snapshot is made at the first read, as Node's is.
            if step["op"] == "observe" && started.is_none() {
                let initial = super::provider_sync::load_config(&rig.config, &rig.effective).await.unwrap();
                rig.loaded.replace(initial);
                started = Some(spawn_provider_sync_on(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone(), pace.clone()));
            }
            match step["op"].as_str().unwrap() {
                "writeConfig" => foreign_write(&path, text),
                "writeCredential" => {
                    let target = if step["at"] == "nested" { nested_file.clone().unwrap() } else { credentials.clone() };
                    foreign_write(&target, text);
                }
                "removeCredential" => std::fs::remove_file(&credentials).unwrap(),
                // Read when the rig was made (its environment names the file).
                "credentialPath" => {}
                "mkdir" => std::fs::create_dir_all(accounts_dir.join(step["at"].as_str().unwrap())).unwrap(),
                "updateAgent" => {
                    let set = step["set"].as_object().unwrap().clone();
                    rig.config
                        .update_agent(move |doc| {
                            doc.extend(set);
                            Ok(())
                        })
                        .await
                        .unwrap();
                }
                "forgetProviderAuth" => {
                    admin.forget_provider_auth(step["provider"].as_str().unwrap(), None).await.unwrap();
                }
                // The OAuth login's own save of the exchanged tokens (`openai/login.rs`, `CredentialFile::save`).
                "saveTokens" => rig.accounts.credential_file("openai-oauth", "default").unwrap().save(&step["tokens"]).await.unwrap(),
                "forgetTokens" => {
                    openai.forget("default").await.unwrap();
                }
                "tick" => ticks.advance(step["ms"].as_u64().unwrap()),
                // Another process writing the file in place, caught halfway, then completing it.
                "writeConfigInPlace" => {
                    let mut file = std::fs::File::create(&path).unwrap();
                    file.write_all(text.as_bytes()).unwrap();
                    file.sync_all().unwrap();
                    in_place = Some(file);
                    // Node's own wait for the first bytes' events and notification pass.
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                }
                "appendConfig" => {
                    let mut file = in_place.take().unwrap();
                    file.write_all(text.as_bytes()).unwrap();
                }
                "observe" => {
                    // Node waited until its snapshot took the step in; this waits as long for the loaded config.
                    let want = &step["stored"];
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                    while stored(base, &rig.loaded.get()) != *want && tokio::time::Instant::now() < deadline {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    let got = stored(base, &rig.loaded.get());
                    assert!(got == *want, "{name}, step {index}\n got: {got}\nwant: {want}");
                }
                other => panic!("{name}: step {other} has no replay"),
            }
        }
        stop.cancel();
        clock = ticks.now_ms();
        replayed += 1;
    }
    // Every recorded case is replayed; the two named cases with no recording make up the test's fifteen.
    let unrecorded = excluded.keys().filter(|name| !cases.iter().any(|c| name.starts_with(c["case"].as_str().unwrap()))).count();
    assert_eq!((replayed, replayed + unrecorded), (cases.len(), 15), "every case is replayed or named");
}
