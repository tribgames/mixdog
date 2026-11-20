//! The channel ports: the receiver's opt-in and listener settings from the webhook config, signed deliveries beside database auth,
//! the public base once a tunnel persisted an identity, and the event rules a reload hands the running pipeline.

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::ConfigLanes;
use mixdog_remote::identity::device::DeviceFiles;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use super::*;

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_receivers_opt_in_and_listener_settings_come_from_webhook_config() {
    let dir = tempfile::tempdir().unwrap();
    let seed = json!({ "webhook": { "allowUnsignedWebhooks": true, "endpoints": { "manual": { "allowUnsigned": true } }, "enabled": true, "port": 5000 } });
    let settings = ConfigChannelSettings::new(open(dir.path(), Some(&seed)).await);
    let config = settings.webhook_config().await.unwrap();
    assert!(config.allow_unsigned_webhooks);
    assert_eq!(config.endpoints["manual"].allow_unsigned, Some(true));
    assert_eq!(settings.webhook().await.unwrap(), WebhookSettings { enabled: Some(true), port: json!(5000), domain: None });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "Write the existing configuration fixture before opening it.")]
async fn existing_file_webhook_routes_signed_deliveries_without_displacing_database_auth() {
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_services::bots::{HomeWebhookDispatch, RoutineRuntime, StoreRoutineRecords};
    use mixdog_services::channels::RunningWork;
    use mixdog_services::scheduler::{StateScheduleStore, SystemClock};
    use mixdog_services::webhooks::signature::{Headers, hmac_hex};
    use mixdog_services::webhooks::{EndpointRecord, EndpointRecords, StateWebhookStore};
    use mixdog_workspace::localfs::LocalFileService;

    struct NoInjections;
    #[async_trait]
    impl EventSink for NoInjections {
        async fn inject(&self, _: &str, _: &str) -> Result<(), String> {
            unreachable!("the queue is not run in this test")
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let file = json!({
        "channels": {
            "webhook": { "secret": "file-key", "endpoints": { "gh": { "parser": "github" } } },
            "events": { "rules": [{
                "source": "webhook", "name": "gh", "parser": "github",
                "filter": "action == 'opened'", "execute": "Review {{title}}"
            }] }
        }
    });
    std::fs::write(crate::compose_flip::config_file(dir.path()), file.to_string()).unwrap();
    let settings = ConfigChannelSettings::new(open(dir.path(), None).await);
    let tokens = mixdog_rt::testing::tokens();
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).unwrap();
    let clock = Arc::new(SystemClock);
    let store = Arc::new(StateWebhookStore::new(state.clone(), clock.clone()));
    let pipeline = settings.event_pipeline(
        QueueFiles {
            fs: Arc::new(LocalFileService::new()),
            read: tokens.interactive_io,
            write: tokens.durability_io,
            root: AbsPath::new(dir.path().join("events")).unwrap(),
        },
        Arc::new(NoInjections),
        store.clone(),
        Arc::new(|| 0),
    );
    store.upsert(&EndpointRecord { name: "db".into(), secret: Some("db-key".into()), ..Default::default() }).await.unwrap();
    let schedules = Arc::new(StateScheduleStore::new(state, clock.clone()));
    let routines = RoutineRuntime::new(Arc::new(HomeTurns::default()), Arc::new(StoreRoutineRecords::new(schedules, store.clone())), clock, chrono_tz::UTC);
    let work = RunningWork::default();
    let service = WebhookService::new(
        store.clone(),
        Arc::new(HomeWebhookDispatch::new(routines, store, Some(pipeline), work.clone())),
        settings.webhook_config().await.unwrap(),
        work,
        Arc::new(|| 0),
    );
    let sign = |headers: &Headers, secret: &str, body: &[u8]| {
        let mut headers = headers.clone();
        headers.insert("x-hub-signature-256".into(), format!("sha256={}", hmac_hex(secret, body)));
        headers
    };

    // A matched rule consumes a filtered delivery without starting background queue work.
    let body = br#"{"action":"closed"}"#;
    let headers = Headers::from_iter([("content-type".into(), "application/json".into())]);
    let unsigned = service.handle_post("/webhook/gh", &headers, body).await;
    assert_eq!(unsigned.status, 403);
    let forged = service.handle_post("/webhook/gh", &sign(&headers, "wrong-key", body), body).await;
    assert_eq!(forged.status, 403);
    let signed = service.handle_post("/webhook/gh", &sign(&headers, "file-key", body), body).await;
    assert_eq!(signed.status, 200, "{}", signed.body);
    assert_eq!(signed.body["status"], "accepted");

    let probe_body = br#"{"mixdogWebhookTest":true}"#;
    let probe = Headers::from_iter([("x-mixdog-webhook-test".into(), "1".into())]);
    let wrong_secret = service.handle_post("/webhook/db", &sign(&probe, "file-key", probe_body), probe_body).await;
    assert_eq!(wrong_secret.status, 403);
    let db_secret = service.handle_post("/webhook/db", &sign(&probe, "db-key", probe_body), probe_body).await;
    assert_eq!(db_secret.status, 200, "{}", db_secret.body);
    assert_eq!(db_secret.body["status"], "verified");
}

/// The session service's routine boundary: every routine turn is accepted and settles done.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_public_base_exists_once_a_tunnel_persisted_an_identity() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let relay = Some("wss://relay.example/".to_owned());
    let base = HookIdentityBase::new(tokens.durability_io, dir.path().to_path_buf(), relay.clone());
    assert_eq!(base.hook_public_base().await, Ok(None), "no identity is created by a read");
    let files = DeviceFiles::at(dir.path().to_path_buf(), "relay-hook-device.json");
    let identity =
        mixdog_core_base::support::on_lane(tokens.durability_io, &CancellationToken::new(), move |lane| files.load_or_create(lane)).await.unwrap().unwrap();
    assert_eq!(base.hook_public_base().await, Ok(Some(format!("https://relay.example/hook/{}", identity.device_id))));
    let off = HookIdentityBase::new(tokens.durability_io, dir.path().to_path_buf(), Some("off".to_owned()));
    assert_eq!(off.hook_public_base().await, Ok(None), "a switched-off relay has no public base");
    let bad = HookIdentityBase::new(tokens.durability_io, dir.path().to_path_buf(), Some("ftp://relay.example".to_owned()));
    assert!(bad.hook_public_base().await.is_err(), "an invalid relay URL is Node's thrown TypeError");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reload_hands_the_running_pipeline_the_new_event_rules() {
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_services::bots::runner::WebhookEvents;
    use mixdog_services::scheduler::SystemClock;
    use mixdog_services::webhooks::StateWebhookStore;
    use mixdog_workspace::localfs::LocalFileService;

    struct NoInjections;
    #[async_trait]
    impl EventSink for NoInjections {
        async fn inject(&self, _: &str, _: &str) -> Result<(), String> {
            unreachable!("the queue is not run in this test")
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let config = open(dir.path(), Some(&json!({ "events": { "rules": [] } }))).await;
    let settings = ConfigChannelSettings::new(config.clone());
    let tokens = mixdog_rt::testing::tokens();
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).unwrap();
    let pipeline = settings.event_pipeline(
        QueueFiles {
            fs: Arc::new(LocalFileService::new()),
            read: tokens.interactive_io,
            write: tokens.durability_io,
            root: AbsPath::new(dir.path().join("events")).unwrap(),
        },
        Arc::new(NoInjections),
        Arc::new(StateWebhookStore::new(state, Arc::new(SystemClock))),
        Arc::new(|| 0),
    );
    assert!(!pipeline.matches("gh"));
    config
        .update(|doc: &mut Map<String, Value>| {
            doc.insert("channels".into(), json!({ "events": { "rules": [{ "source": "webhook", "name": "gh", "parser": "github", "execute": "Review" }] } }));
            Ok::<(), ConfigError>(())
        })
        .await
        .unwrap();
    settings.reload_events().await;
    assert!(pipeline.matches("gh"));
}
