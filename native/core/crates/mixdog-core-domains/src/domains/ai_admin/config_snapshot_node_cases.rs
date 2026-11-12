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

/// The one deadline of a wait on an event: what it waits for, named in the failure.
async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    match mixdog_rt::time::timeout(Duration::from_secs(5), wait).await {
        Ok(done) => done,
        Err(_) => panic!("waited 5 s for {what}"),
    }
}

static LOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
static LOGGED: Notify = Notify::const_new();

/// The process's warnings, kept as their messages: the log lines Node's recording compares against. Installed by the test
/// that reads them (the reads run on the io lane's own threads, so a thread-local subscriber would not see them).
struct Capture;

struct Message(String);

impl tracing::field::Visit for Message {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
}

impl tracing::Subscriber for Capture {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        *metadata.level() <= tracing::Level::WARN
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut message = Message(String::new());
        event.record(&mut message);
        LOG.lock().unwrap().push(message.0);
        LOGGED.notify_waiters();
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

/// A `[watch] re-read of <path> failed: <error>` line as its comparable head: the path, then (the error text is the
/// operating system's own) nothing; a streak of equal lines is one.
fn rewatched(lines: &[String]) -> Vec<String> {
    let mut heads: Vec<String> = Vec::new();
    for line in lines {
        let head = line.trim_end().split(" failed: ").next().unwrap().replace('\\', "/");
        if heads.last() != Some(&head) {
            heads.push(head);
        }
    }
    heads
}

/// The core's `[watch] re-read of` lines for files under `root`, once there is one: the credential folder is `accounts/` where
/// Node's data dir holds the file itself, so the folder is written as the data dir.
async fn logged_rereads(root: &str, accounts: &std::path::Path) -> Vec<String> {
    let accounts = accounts.to_string_lossy().into_owned();
    loop {
        let logged = LOGGED.notified();
        tokio::pin!(logged);
        logged.as_mut().enable();
        let lines: Vec<String> = LOG
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.starts_with("[watch] re-read of ") && line.contains(root))
            .map(|line| line.replace(&accounts, "<data>"))
            .collect();
        if !lines.is_empty() {
            return rewatched(&lines);
        }
        logged.await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_replayed_config_snapshot_read_is_nodes() {
    let _ = tracing::subscriber::set_global_default(Capture);
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
        // The rebuilds applied when the last observation was taken, and the credential another process writes while the first
        // build runs.
        let mut applied_at = 0;
        let mut during_build: Option<String> = None;
        // What the first build returned to the read that made it, when another process wrote during that build.
        let mut first_read: Option<Value> = None;
        // The lines Node logged for the removal made while its stat was denied, compared at the observation that follows it.
        let mut denied: Option<Vec<String>> = None;
        // A config-change listener, subscribed after each observation as the test subscribes its own.
        let mut listener = rig.config.changes();
        for (index, step) in steps.iter().enumerate() {
            let text = step["text"].as_str().unwrap_or_default();
            // The snapshot is made at the first read, as Node's is.
            if step["op"] == "observe" && started.is_none() {
                let initial = super::provider_sync::load_config(&rig.config, &rig.effective).await.unwrap();
                // After the build read the credential file and before the sync that watches it began.
                if let Some(text) = during_build.take() {
                    foreign_write(&credentials, &text);
                    first_read = Some(stored(base, &initial));
                }
                rig.loaded.replace(initial);
                let mut sync = spawn_provider_sync_on(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone(), pace.clone());
                // The clock and the files move only once the sync has its first pass behind it and its expiry read.
                within(&format!("{name}, step {index}: the sync's first pass"), sync.ready.wait_for(|ready| *ready)).await.unwrap();
                started = Some(sync);
            }
            match step["op"].as_str().unwrap() {
                "writeConfig" => foreign_write(&path, text),
                // The first build's own loader writes the credential file: placed in the first observation's build.
                "writeDuringBuild" => during_build = Some(text.to_owned()),
                "writeCredential" => {
                    let target = if step["at"] == "nested" { nested_file.clone().unwrap() } else { credentials.clone() };
                    if target.is_dir() {
                        std::fs::remove_dir(&target).unwrap();
                    }
                    foreign_write(&target, text);
                }
                "removeCredential" => {
                    std::fs::remove_file(&credentials).unwrap();
                    // The recorded removal ran while Node's stat of the file was denied (`logged` is what its cache wrote). The
                    // core keeps no stat, so its read of the file is what is denied: a folder where the file was.
                    if let Some(lines) = step.get("logged") {
                        std::fs::create_dir(&credentials).unwrap();
                        denied = Some(lines.as_array().unwrap().iter().map(|line| line.as_str().unwrap().to_owned()).collect());
                    }
                }
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
                // The clock moves by the recorded tick; the pass at the expiry is the event that tells the listeners.
                "tick" => {
                    let sync = started.as_mut().unwrap();
                    let before = *sync.applied.borrow_and_update();
                    ticks.advance(step["ms"].as_u64().unwrap());
                    if step["epochMoved"] == true {
                        within(&format!("{name}, step {index}: the rebuild at the credential's expiry"), sync.applied.changed()).await.unwrap();
                    } else {
                        assert_eq!(*sync.applied.borrow(), before, "{name}, step {index}: nothing fires before the deadline");
                    }
                }
                // Another process writing the file in place, caught halfway, then completing it.
                "writeConfigInPlace" => {
                    // A torn file makes no `changes` notification (the reload fails and the config keeps its last good document):
                    // the watch's pass over its first bytes is awaited through the pass counter.
                    let mut passes = rig.config.watch_passes();
                    passes.borrow_and_update();
                    let mut file = std::fs::File::create(&path).unwrap();
                    file.write_all(text.as_bytes()).unwrap();
                    file.sync_all().unwrap();
                    within(&format!("{name}, step {index}: the config watch's pass over the first bytes"), passes.changed()).await.unwrap();
                    in_place = Some(file);
                }
                "appendConfig" => {
                    let mut file = in_place.take().unwrap();
                    file.write_all(text.as_bytes()).unwrap();
                }
                // While the file stays torn no rebuild is applied (Node: the epoch holds).
                "quiet" => {
                    let sync = started.as_ref().unwrap();
                    assert_eq!(*sync.applied.borrow() > applied_at, step["epochMoved"] == true, "{name}, step {index}: rebuilds while the file stays torn");
                }
                // The config-change listener's notification, and the config it reads then.
                "listener" => {
                    within(&format!("{name}, step {index}: the config-change notification"), listener.changed()).await.unwrap();
                    let agent = rig.config.loaded_agent().await.unwrap();
                    assert_eq!(json!([agent.get("heartbeat")]), step["seen"], "{name}, step {index}: what the listener reads");
                }
                "observe" if denied.is_some() => {
                    let want = rewatched(&denied.take().unwrap());
                    let root = rig._dir.path().to_string_lossy().into_owned();
                    let got = within(&format!("{name}, step {index}: the core's log of the read that failed"), logged_rereads(&root, &accounts_dir)).await;
                    assert_eq!(got, want, "{name}, step {index}: what the failed re-read logged");
                    applied_at = *started.as_ref().unwrap().applied.borrow();
                    listener = rig.config.changes();
                }
                "observe" => {                    // The loaded config at Node's recorded moment: the step is held until the rebuilds it causes (each announced by
                    // the sync's own notification) have taken it in. One deadline for the whole wait; the states in between are
                    // not judged, and the last one read is named when the wait runs out.
                    let want = &step["stored"];
                    let sync = started.as_mut().unwrap();
                    // The read that built the snapshot got what it read before the write, whatever the sync has taken in since.
                    if let Some(first) = first_read.take() {
                        assert_eq!(first, *want, "{name}, step {index}: the build's own read");
                        listener = rig.config.changes();
                        continue;
                    }
                    let mut got = Value::Null;
                    let reached = mixdog_rt::time::timeout(Duration::from_secs(5), async {
                        loop {
                            sync.applied.borrow_and_update();
                            got = stored(base, &rig.loaded.get());
                            if got == *want {
                                return;
                            }
                            sync.applied.changed().await.unwrap();
                        }
                    })
                    .await
                    .is_ok();
                    assert!(reached, "{name}, step {index}: waited 5 s for the rebuild that takes the step in\n last read: {got}\n want: {want}");
                    applied_at = *sync.applied.borrow();
                    listener = rig.config.changes();
                }                other => panic!("{name}: step {other} has no replay"),
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
