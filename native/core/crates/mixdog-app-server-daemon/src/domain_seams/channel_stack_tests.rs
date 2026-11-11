//! The channel ports against Node's recorded run (`fixtures/channel-settings/golden.json`).

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::ConfigLanes;
use mixdog_remote::identity::device::DeviceFiles;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use super::*;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/channel-settings/golden.json")).expect("the golden is JSON")
}

async fn open(dir: &std::path::Path, channels: Option<&Value>) -> Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.expect("open");
    if let Some(channels) = channels {
        let channels = channels.clone();
        config
            .update(move |doc: &mut Map<String, Value>| {
                doc.insert("channels".into(), channels);
                Ok::<(), ConfigError>(())
            })
            .await
            .expect("seed");
    }
    config
}

/// Node's `webhook` object read as the receiver reads it.
fn expected(webhook: &Value) -> WebhookSettings {
    // `config.port || 3333`
    let port = match &webhook["port"] {
        Value::Number(n) if n.as_f64() != Some(0.0) => webhook["port"].clone(),
        Value::String(s) if !s.is_empty() => webhook["port"].clone(),
        _ => json!(3333),
    };
    WebhookSettings {
        enabled: webhook["enabled"] == json!(true),
        port,
        domain: webhook["domain"].as_str().filter(|d| !d.is_empty()).map(str::to_owned),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_patch_leaves_the_section_node_leaves() {
    let golden = golden();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let config = open(dir.path(), case["seeded"].as_bool().unwrap().then(|| &case["seed"])).await;
        let settings = ConfigChannelSettings::new(config.clone());
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} step {i} {}", step["patch"]);
            let got = settings.update_webhook(&WebhookPatch::from_params(&step["patch"])).await.unwrap();
            assert_eq!(got, expected(&step["returned"]["webhook"]), "{label}: returned");
            let saved = config.get("channels").unwrap_or(Value::Null);
            assert_eq!(saved, step["channels"], "{label}: channels section");
            assert_eq!(settings.webhook().await.unwrap(), got, "{label}: a read answers what the write returned");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_receivers_secret_and_opt_in_come_from_the_section() {
    let dir = tempfile::tempdir().unwrap();
    let seed = json!({ "secret": "s", "allowUnsignedWebhooks": true, "endpoints": { "gh": { "parser": "github", "allowUnsigned": true } }, "webhook": { "port": 5000 } });
    let settings = ConfigChannelSettings::new(open(dir.path(), Some(&seed)).await);
    let config = settings.webhook_config().await.unwrap();
    assert_eq!(config.secret.as_deref(), Some("s"));
    assert!(config.allow_unsigned_webhooks);
    assert_eq!(config.endpoints["gh"].allow_unsigned, Some(true));
    assert_eq!(settings.webhook().await.unwrap(), WebhookSettings { enabled: true, port: json!(5000), domain: None });
}

/// The reload calls the composition's watch makes (compose_flip.rs passes `ChannelRuntime::reload_runtime`), counted as
/// Node's recorder counts its reload callback.
/// Each call carries the `voice` section as it stood when the reload was made.
struct Reloads {
    calls: tokio::sync::mpsc::UnboundedReceiver<Value>,
    seen: Vec<Value>,
}

impl Reloads {
    /// Every reload already made, without waiting.
    fn now(&mut self) -> usize {
        while let Ok(voice) = self.calls.try_recv() {
            self.seen.push(voice);
        }
        self.seen.len()
    }

    /// Waits for the `n`-th reload; the deadline only bounds a run that never hears it.
    async fn reached(&mut self, n: usize, label: &str) -> usize {
        while self.now() < n {
            let voice = tokio::time::timeout(std::time::Duration::from_secs(30), self.calls.recv()).await.unwrap_or_else(|_| panic!("{label}: no reload {n}")).unwrap();
            self.seen.push(voice);
        }
        self.seen.len()
    }
}

fn watched(config: &Config, cancel: &CancellationToken) -> (tokio::task::JoinHandle<()>, Reloads) {
    let (tx, calls) = tokio::sync::mpsc::unbounded_channel();
    let read = config.clone();
    let watch = watch_channels_config(
        config.clone(),
        move || {
            let _ = tx.send(read.get("voice").unwrap_or(Value::Null));
            async { Ok(()) }
        },
        cancel.clone(),
    );
    (watch, Reloads { calls, seen: Vec::new() })
}

/// The instance id every guard of the replay creates (a UUID, as Node's `randomUUID`; written <instance-id> as Node's).
const INSTANCE: &str = "00000000-0000-4000-8000-000000000000";

/// One process's user-data guard over the replay's backup root: its own sequence, as each Node process has; the clock is
/// the replay's one virtual clock, a millisecond further at every read (Node's backups were named by a clock that moved).
fn guard_of(root: &std::path::Path, clock: &Arc<std::sync::atomic::AtomicI64>) -> Arc<mixdog_core_config::user_data::UserData> {
    use mixdog_core_config::user_data::{Env, UserData};
    let backups = root.join("backups").display().to_string();
    let clock = clock.clone();
    Arc::new(UserData::new(
        Env::new(move |name| (name == "MIXDOG_USER_DATA_BACKUP_ROOT").then(|| backups.clone()), Some(root.join("home"))),
        move || clock.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
        || INSTANCE.to_owned(),
        |_| {},
    ))
}

/// `text` with what Node's recorder normalised: the data dir (as JSON writes it), UUIDs, ISO timestamps.
fn normalised(text: &str, data_dir: &str) -> String {
    let escaped = serde_json::to_string(data_dir).unwrap();
    let text = text.replace(&escaped[1..escaped.len() - 1], "<data-dir>");
    let (bytes, mut out, mut i) = (text.as_bytes(), String::new(), 0);
    let shape = |at: usize, pattern: &str| -> bool {
        bytes.len() >= at + pattern.len()
            && pattern.bytes().zip(&bytes[at..at + pattern.len()]).all(|(p, b)| match p {
                b'h' => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
                b'd' => b.is_ascii_digit(),
                literal => literal == *b,
            })
    };
    while i < bytes.len() {
        if shape(i, "hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh") {
            out.push_str("<instance-id>");
            i += 36;
        } else if shape(i, "dddd-dd-ddTdd:dd:dd.dddZ") {
            out.push_str("<time>");
            i += 24;
        } else {
            let c = text[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// Every file under `base` (names sorted, folders walked in place), paths `/`-joined, texts normalised: Node's `walk`.
#[allow(clippy::disallowed_methods, reason = "test: reads the replay's own temp directory")]
fn walk(base: &std::path::Path, data_dir: &str) -> Vec<Value> {
    fn visit(dir: &std::path::Path, base: &std::path::Path, data_dir: &str, out: &mut Vec<Value>) {
        let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        for name in names {
            let full = dir.join(&name);
            if std::fs::metadata(&full).unwrap().is_dir() {
                visit(&full, base, data_dir, out);
            } else {
                let path = full.strip_prefix(base).unwrap().components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
                out.push(json!({ "path": path, "text": normalised(&String::from_utf8(std::fs::read(&full).unwrap()).unwrap(), data_dir) }));
            }
        }
    }
    let mut out = Vec::new();
    if std::fs::metadata(base).is_ok() {
        visit(base, base, data_dir, &mut out);
    }
    out
}

/// The data dir and the backups, as Node's recorder lists them (backup folders: `scope-<hash>` as <scope>, the time in
/// `<time>-<seq>-<kind>` as <time>).
fn disk(root: &std::path::Path) -> Value {
    let data = root.join("data");
    let shown = data.display().to_string();
    let backups: Vec<Value> = walk(&root.join("backups"), &shown)
        .into_iter()
        .map(|mut file| {
            let path = file["path"].as_str().unwrap().to_owned();
            let mut parts: Vec<String> = path.split('/').map(str::to_owned).collect();
            if parts[0].starts_with("scope-") {
                parts[0] = "<scope>".into();
                if let Some(at) = parts.get(1).and_then(|name| name.find("Z-")) {
                    parts[1] = format!("<time>-{}", &parts[1][at + 2..]);
                }
            }
            file["path"] = json!(parts.join("/"));
            file
        })
        .collect();
    json!({ "dataDir": walk(&data, &shown), "backups": backups })
}

/// Node's config reload watch (config-reload-watch.mjs over the shared config change feed), recorded by
/// `record-channels-config-reload-order.mjs` (`fixtures/channels-config-reload-order`, cases 55 and 75), compared whole
/// after every step: the reload count and the files on disk (the data dir and the user-data backups). Another process's
/// write is another core's `Config` (its own opening and guard, as Node's child process had), heard through the real file
/// watch; the in-process writes go through the watched `Config`. Node's absences are proven as Node's recorder proves them:
/// the agent write's step is read before the voice write, whose reload is then the first, and the stopped watch is read
/// right after the write.
///
/// One thread: the lane jobs run inline, so the other process's whole write (file and snapshots) ends before the watch's
/// reload reads, as Node's parent, which never read, could not see a write half done.
#[tokio::test(flavor = "current_thread")]
async fn a_config_edit_reloads_the_channels_runtime_as_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/channels-config-reload-order/golden.json")).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    let set = |config: &Config, section: &'static str, key: &'static str, value: Value| {
        let config = config.clone();
        async move {
            config
                .update(move |doc: &mut Map<String, Value>| {
                    let entry = doc.entry(section).or_insert_with(|| json!({}));
                    entry.as_object_mut().unwrap().insert(key.into(), value);
                    Ok::<(), ConfigError>(())
                })
                .await
                .unwrap();
        }
    };
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_700_000_000_000));
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let core = guard_of(root.path(), &clock);
    let (config, _) = Config::open_guarded(data.join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes, core).await.unwrap();
    let _file_watch = mixdog_core_config::config::ConfigWatcher::start(config.clone()).unwrap();

    // Case 55.
    let steps = cases[0]["steps"].as_array().unwrap();
    let cancel = CancellationToken::new();
    let (watch, mut reloads) = watched(&config, &cancel);
    assert_eq!(json!({"step": steps[0]["step"], "reloads": reloads.now(), "disk": disk(root.path())}), steps[0]);
    for (write, step) in steps[1..4].iter().enumerate() {
        // Another process: its own opening and guard, one write of the section, then gone.
        let other = guard_of(root.path(), &clock);
        let (writer, _) = Config::open_guarded(data.join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes, other).await.unwrap();
        set(&writer, "channels", "revision", json!(write + 1)).await;
        drop(writer);
        let got = reloads.reached(write + 1, step["step"].as_str().unwrap()).await;
        assert_eq!(json!({"step": step["step"], "reloads": got, "disk": disk(root.path())}), *step);
    }
    cancel.cancel();
    watch.await.unwrap();
    let before_stop = reloads.now();
    set(&config, "channels", "revision", json!(4)).await;
    let step = &steps[4];
    assert_eq!(json!({"step": step["step"], "reloadsBeforeStop": before_stop, "reloadsAfterTheWrite": reloads.now(), "disk": disk(root.path())}), *step);

    // Case 75, on the same file.
    let steps = cases[1]["steps"].as_array().unwrap();
    let cancel = CancellationToken::new();
    let (watch, mut reloads) = watched(&config, &cancel);
    set(&config, "agent", "promptCacheWarming", json!(false)).await;
    assert_eq!(json!({"step": steps[0]["step"], "reloads": reloads.now(), "disk": disk(root.path())}), steps[0]);
    set(&config, "voice", "language", json!("ko")).await;
    let got = reloads.reached(1, "the reload after the voice change").await;
    assert_eq!(json!({"step": steps[1]["step"], "reloads": got, "disk": disk(root.path())}), steps[1]);
    // A reload the agent write had made would have run before the voice write and read no voice section.
    assert_eq!(reloads.seen, vec![json!({"language": "ko"})], "the first reload is the voice write's");
    cancel.cancel();
    watch.await.unwrap();
}

/// The session service's routine boundary (Node: the live surface's `submit`, daemon.mjs:1199-1201): every routine turn
/// is accepted and settles done; kept in order as Node's recorder keeps the submits.
#[derive(Default)]
struct HomeTurns {
    turns: std::sync::Mutex<Vec<Value>>,
    submitted: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl mixdog_services::bots::RoutineHost for HomeTurns {
    async fn owner_problem(&self, _owner: &str, _stored: bool) -> Result<Option<mixdog_services::bots::OwnerProblem>, String> {
        Ok(None)
    }
    async fn executor_facts(&self, _agent_id: &str) -> Result<mixdog_services::bots::ExecutorFacts, String> {
        Ok(Default::default())
    }
    /// The recording's home thread is a stored, open session.
    async fn home_thread_open(&self, _session_id: &str) -> Result<bool, String> {
        Ok(true)
    }
    fn is_heartbeat_session(&self, _session_id: &str) -> bool {
        false
    }
    async fn run_turn(&self, turn: mixdog_services::bots::RoutineTurn, _cancel: CancellationToken) -> mixdog_services::bots::TurnSettle {
        self.turns.lock().unwrap().push(json!({
            "sessionId": turn.session_id,
            "prompt": turn.content,
            "skillSelection": turn.skill_selection,
            "transcriptMeta": { "routineTrigger": turn.trigger },
        }));
        self.submitted.notify_one();
        mixdog_services::bots::TurnSettle::Done { result: String::new() }
    }
    async fn run_executor(&self, _run: mixdog_services::bots::ExecutorRun, _cancel: CancellationToken) -> Result<String, String> {
        Err("no executor in this recording".into())
    }
    async fn deliver_result(&self, _owner: &str, _name: &str, _item: &mixdog_services::bots::DeliveryItem) -> Result<(), String> {
        Ok(())
    }
    async fn announce_run(&self, _owner: &str, _name: &str, _run: &mixdog_services::bots::AnnouncedRun) -> Result<(), String> {
        Ok(())
    }
}

/// The provider init the start runs (Node's recorder holds it at its gate and releases it).
struct NoProviders;

#[async_trait::async_trait]
impl mixdog_services::channels::AgentRuntime for NoProviders {
    async fn init_providers(&self) -> Result<(), String> {
        Ok(())
    }
}

struct WallClock(i64);

impl mixdog_services::scheduler::Clock for WallClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp_millis(self.0).unwrap()
    }
}

/// The webhook automation, counting the reload syncs it finished and, when armed, sending the recorded delivery the
/// moment a reload sync is entered (Node's recorder sends it once `WebhookServer.reloadConfig` was entered).
struct ArmedReloads {
    inner: mixdog_services::channels::WebhookAutomation,
    reloaded: tokio::sync::watch::Sender<usize>,
    armed: std::sync::Mutex<Option<(u16, String, Value, tokio::sync::oneshot::Sender<Value>)>>,
}

#[async_trait::async_trait]
impl mixdog_services::channels::AutomationServices for ArmedReloads {
    async fn sync(&self, reload: bool) -> Result<(), String> {
        if reload && let Some((port, body, headers, sent)) = self.armed.lock().unwrap().take() {
            tokio::spawn(async move {
                let _ = sent.send(deliver(port, &body, &headers).await);
            });
        }
        let synced = self.inner.sync(reload).await;
        if reload {
            self.reloaded.send_modify(|count| *count += 1);
        }
        synced
    }
    async fn stop(&self) {
        self.inner.stop().await;
    }
}

/// One delivery on a fresh connection: `{status, body}`, or the error the connection ended with under Node's code.
async fn deliver(port: u16, body: &str, headers: &Value) -> Value {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
        Ok(stream) => stream,
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => return json!({"error": "ECONNREFUSED"}),
        Err(error) => return json!({"error": error.to_string()}),
    };
    let mut request = format!("POST /webhook/gh HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    for (name, value) in headers.as_object().unwrap() {
        request += &format!("{name}: {}\r\n", value.as_str().unwrap());
    }
    request += "\r\n";
    request += body;
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).await.unwrap();
    let status: u16 = reply[9..12].parse().unwrap();
    let (_, text) = reply.split_once("\r\n\r\n").unwrap();
    json!({"status": status, "body": serde_json::from_str::<Value>(text).unwrap()})
}

/// Waits for `what` with one deadline.
async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(30), future).await.unwrap_or_else(|_| panic!("never happened: {what}"))
}

/// `record-webhook-late-reload.mjs` (`fixtures/webhook-late-reload`, step `configEdit`, Node b6f10295a with
/// node-fix-webhook-late-reload.patch): with the receiver listening and the session service running, another process
/// edits the channels section of the config file on disk (port kept). The composition's watch (`watch_channels_config`
/// over the real file watch) hears it and reloads the runtime; a delivery not seen before, sent as the reload syncs the
/// receiver, is answered and runs one routine turn in the owner's home thread. Compared whole: the reply, the reload
/// count, the receiver still listening, and the turns the session boundary received.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delivery_during_a_config_edit_reload_is_answered_and_runs_once_as_node() {
    use mixdog_services::bots::{HomeScheduleRunner, HomeWebhookDispatch, RoutineRuntime, StoreRoutineRecords};
    use mixdog_services::channels::{AdminDeps, ChannelAdmin, ChannelSettings, RunningWork, WebhookAutomation, WebhookPatch};
    use mixdog_services::scheduler::{Scheduler, StateScheduleStore};
    use mixdog_services::webhooks::{StateWebhookStore, WebhookConfig, WebhookService};
    let rec: Value = serde_json::from_str(include_str!("../../../../fixtures/webhook-late-reload/golden.json")).unwrap();
    let step = &rec["configEdit"];
    let port = rec["port"].as_u64().unwrap() as u16;
    let tz: chrono_tz::Tz = rec["timeZone"].as_str().unwrap().parse().unwrap();
    let wall: Arc<dyn mixdog_services::scheduler::Clock> = Arc::new(WallClock(rec["wallClock"].as_i64().unwrap()));
    let tokens = mixdog_rt::testing::tokens();

    let root = tempfile::tempdir().unwrap();
    let config = open(root.path(), None).await;
    let _file_watch = mixdog_core_config::config::ConfigWatcher::start(config.clone()).unwrap();
    let settings: Arc<dyn ChannelSettings> = Arc::new(ConfigChannelSettings::new(config.clone()));
    // `setWebhookConfigAsync({ port })`, as the recorder seeds the receiver's port.
    settings.update_webhook(&WebhookPatch::from_params(&json!({ "port": port }))).await.unwrap();

    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &root.path().join("core.sqlite")).unwrap();
    let schedules = Arc::new(StateScheduleStore::new(state.clone(), wall.clone()));
    let webhooks = Arc::new(StateWebhookStore::new(state.clone(), wall.clone()));
    let host = Arc::new(HomeTurns::default());
    let routines = RoutineRuntime::new(host.clone(), Arc::new(StoreRoutineRecords::new(schedules.clone(), webhooks.clone())), wall.clone(), tz);
    let work = RunningWork::default();
    let service = Arc::new(WebhookService::new(
        webhooks.clone(),
        Arc::new(HomeWebhookDispatch::new(routines.clone(), webhooks.clone(), None, work.clone())),
        WebhookConfig::default(),
        work.clone(),
        Arc::new(|| 0),
    ));
    let relay = "ws://127.0.0.1:9";
    let tunnels = Arc::new(mixdog_services::webhooks::relay::RelayTunnelStarter::new(tokens.durability_io, root.path().to_path_buf(), Some(relay.into())));
    let reloaded = tokio::sync::watch::Sender::new(0usize);
    let automation = Arc::new(ArmedReloads {
        inner: WebhookAutomation::new(settings.clone(), service.clone(), Arc::new(ServerListener::new(service.clone(), tunnels))),
        reloaded: reloaded.clone(),
        armed: std::sync::Mutex::new(None),
    });
    let scheduler = Scheduler::new(schedules.clone(), Arc::new(HomeScheduleRunner::new(routines.clone())), wall.clone(), work.clone(), tz, Vec::new());
    let runtime = mixdog_services::channels::runtime::ChannelRuntime::new(scheduler, schedules.clone(), automation.clone(), Arc::new(NoProviders));
    let admin = ChannelAdmin::new(AdminDeps {
        schedules: schedules.clone(),
        webhooks: webhooks.clone(),
        owned: Arc::new(mixdog_services::channels::routines_db::OwnedRoutines::new(state.clone())),
        routines: routines.clone(),
        runtime: runtime.clone(),
        settings: settings.clone(),
        base: Arc::new(HookIdentityBase::new(tokens.durability_io, root.path().to_path_buf(), Some(relay.into()))),
        probe: Arc::new(mixdog_services::channels::ports::ReqwestProbe::new(reqwest::Client::new())),
        clock: wall.clone(),
        local_tz: tz,
        channel_start_disabled: false,
        close_requested: CancellationToken::new(),
    });
    let cancel = CancellationToken::new();
    let reloading = runtime.clone();
    let watch = watch_channels_config(
        config.clone(),
        move || {
            let runtime = reloading.clone();
            async move { runtime.reload_runtime().await }
        },
        cancel.clone(),
    );

    // The save starts the runtime, the edit reloads it: the receiver listens with the edited instructions.
    assert_eq!(admin.save_webhook(&rec["entry"]).await.unwrap(), rec["saveReply"]);
    within("the save's start", runtime.scheduled_start_settled()).await;
    let mut reloads = reloaded.subscribe();
    let saved = *reloads.borrow_and_update();
    assert_eq!(admin.save_webhook(&rec["edit"]).await.unwrap(), rec["editReply"]);
    within("the edit's reload", reloads.wait_for(|count| *count > saved)).await.unwrap();
    within("the edit's restart", runtime.scheduled_start_settled()).await;
    let before = *reloads.borrow_and_update();

    // Another process's edit of the file on disk: its own opening, one write of the section, then gone.
    let (sent, delivered) = tokio::sync::oneshot::channel();
    *automation.armed.lock().unwrap() = Some((port, step["body"].as_str().unwrap().to_owned(), step["headers"].clone(), sent));
    let writer = open(root.path(), None).await;
    let set = step["set"].clone();
    writer
        .update(move |doc: &mut Map<String, Value>| {
            let channels = doc.entry("channels").or_insert_with(|| json!({})).as_object_mut().unwrap();
            for (key, value) in set.as_object().unwrap() {
                channels.insert(key.clone(), value.clone());
            }
            Ok::<(), ConfigError>(())
        })
        .await
        .unwrap();
    drop(writer);
    let delivery = within("the delivery sent as the edit's reload syncs the receiver", delivered).await.unwrap();
    within("the edit's reload ends", reloads.wait_for(|count| *count > before)).await.unwrap();
    within("the delivery's routine turn", async {
        while host.turns.lock().unwrap().is_empty() {
            host.submitted.notified().await;
        }
    })
    .await;
    let listening = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok();
    let turns = host.turns.lock().unwrap().clone();
    // The routine submit's `mode` and `priority` are the session host's own options, past the boundary compared here.
    let recorded_turns: Vec<Value> = step["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|turn| json!({"sessionId": turn["sessionId"], "prompt": turn["prompt"], "skillSelection": turn["skillSelection"], "transcriptMeta": turn["transcriptMeta"]}))
        .collect();
    assert_eq!(
        json!({"delivery": delivery, "reloads": *reloads.borrow() - before, "listeningAfter": listening, "turns": turns}),
        json!({"delivery": step["delivery"], "reloads": step["reloads"], "listeningAfter": step["listeningAfter"], "turns": recorded_turns}),
    );
    cancel.cancel();
    watch.await.unwrap();
    mixdog_services::channels::ChannelLifecycle::stop_owned_runtime(&*runtime, "test").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_public_base_exists_once_a_tunnel_persisted_an_identity() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let relay = Some("wss://relay.example/".to_owned());
    let base = HookIdentityBase::new(tokens.durability_io, dir.path().to_path_buf(), relay.clone());
    assert_eq!(base.hook_public_base().await, Ok(None), "no identity is created by a read");
    let files = DeviceFiles::at(dir.path().to_path_buf(), "relay-hook-device.json");
    let identity = mixdog_core_base::support::on_lane(tokens.durability_io, &CancellationToken::new(), move |lane| files.load_or_create(lane))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(base.hook_public_base().await, Ok(Some(format!("https://relay.example/hook/{}", identity.device_id))));
    let off = HookIdentityBase::new(tokens.durability_io, dir.path().to_path_buf(), Some("off".to_owned()));
    assert_eq!(off.hook_public_base().await, Ok(None), "a switched-off relay has no public base");
    let bad = HookIdentityBase::new(tokens.durability_io, dir.path().to_path_buf(), Some("ftp://relay.example".to_owned()));
    assert!(bad.hook_public_base().await.is_err(), "an invalid relay URL is Node's thrown TypeError");
}
