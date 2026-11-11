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
