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

/// config-reload-watch.test.mjs: every edit another process makes to the file reloads the channels
/// runtime (heard through the real file watch); an edit outside `channels`/`voice` does not, a
/// `voice` edit does, and a stopped watch reloads nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_external_channels_edit_reloads_the_runtime_and_other_sections_do_not() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, r#"{"channels":{"revision":0}}"#).unwrap();
    let config = open(dir.path(), None).await;
    let _watcher = mixdog_core_config::config::ConfigWatcher::start(config.clone()).unwrap();
    let reloads = Arc::new(AtomicUsize::new(0));
    let counted = reloads.clone();
    let cancel = CancellationToken::new();
    let watch = watch_channels_config(
        config.clone(),
        move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        },
        cancel.clone(),
    );
    let reached = |want: usize| {
        let reloads = reloads.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                while reloads.load(Ordering::SeqCst) < want {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .is_ok()
        }
    };
    for revision in 1..=3 {
        std::fs::write(&path, format!(r#"{{"channels":{{"revision":{revision}}}}}"#)).unwrap();
        assert!(reached(revision).await, "external write {revision} reloaded");
    }
    std::fs::write(&path, r#"{"channels":{"revision":3},"agent":{"promptCacheWarming":false}}"#).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while config.get("agent.promptCacheWarming").is_none() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the agent edit was heard");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(reloads.load(Ordering::SeqCst), 3, "an agent setting leaves the webhook server running");
    std::fs::write(&path, r#"{"channels":{"revision":3},"agent":{"promptCacheWarming":false},"voice":{"language":"ko"}}"#).unwrap();
    assert!(reached(4).await, "a voice change reloads");
    cancel.cancel();
    watch.await.unwrap();
    std::fs::write(&path, r#"{"channels":{"revision":5}}"#).unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(reloads.load(Ordering::SeqCst), 4, "a stopped watch reloads nothing");
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
