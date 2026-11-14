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
    let seed = json!({ "secret": "s", "allowUnsignedWebhooks": true, "endpoints": { "gh": { "parser": "github", "allowUnsigned": true } }, "webhook": { "enabled": true, "port": 5000 } });
    let settings = ConfigChannelSettings::new(open(dir.path(), Some(&seed)).await);
    let config = settings.webhook_config().await.unwrap();
    assert_eq!(config.secret.as_deref(), Some("s"));
    assert!(config.allow_unsigned_webhooks);
    assert_eq!(config.endpoints["gh"].allow_unsigned, Some(true));
    assert_eq!(settings.webhook().await.unwrap(), WebhookSettings { enabled: true, port: json!(5000), domain: None });
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
    let (head, text) = reply.split_once("\r\n\r\n").unwrap();
    // The listener frames a reply as Node's server does: chunked on HTTP/1.1.
    let chunked = head.lines().any(|line| line.to_ascii_lowercase().replace(' ', "") == "transfer-encoding:chunked");
    let body = if chunked { dechunked(text) } else { text.to_owned() };
    json!({"status": status, "body": serde_json::from_str::<Value>(&body).unwrap_or_else(|error| panic!("the reply's body is not JSON ({error}): {body:?}"))})
}

/// The body of a whole chunked message: each chunk's bytes, up to the zero chunk that ends it.
fn dechunked(mut rest: &str) -> String {
    let mut body = String::new();
    loop {
        let (size, after) = rest.split_once("\r\n").unwrap_or_else(|| panic!("a chunk size line: {rest:?}"));
        let size = usize::from_str_radix(size.trim(), 16).unwrap_or_else(|_| panic!("a hex chunk size: {size:?}"));
        if size == 0 {
            return body;
        }
        body.push_str(&after[..size]);
        rest = after[size..].strip_prefix("\r\n").unwrap_or_else(|| panic!("a chunk ends with CRLF: {:?}", &after[size..]));
    }
}

/// Waits for `what` with one deadline.
async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(30), future).await.unwrap_or_else(|_| panic!("never happened: {what}"))
}

/// The composition's channel stack (compose_flip.rs) over a real store and config in `root`: the admin, the runtime, the
/// stores, the automation (reload syncs counted, a delivery armable) and the session boundary's routine turns.
struct Stack {
    admin: Arc<mixdog_services::channels::ChannelAdmin>,
    runtime: Arc<mixdog_services::channels::runtime::ChannelRuntime>,
    schedules: Arc<mixdog_services::scheduler::StateScheduleStore>,
    webhooks: Arc<mixdog_services::webhooks::StateWebhookStore>,
    automation: Arc<ArmedReloads>,
    host: Arc<HomeTurns>,
}

fn channel_stack(root: &std::path::Path, config: &Config, wall: Arc<dyn mixdog_services::scheduler::Clock>, tz: chrono_tz::Tz) -> Stack {
    use mixdog_services::bots::{HomeScheduleRunner, HomeWebhookDispatch, RoutineRuntime, StoreRoutineRecords};
    use mixdog_services::channels::{AdminDeps, ChannelAdmin, ChannelSettings, RunningWork, WebhookAutomation};
    use mixdog_services::scheduler::{Scheduler, StateScheduleStore};
    use mixdog_services::webhooks::{StateWebhookStore, WebhookConfig, WebhookService};
    let tokens = mixdog_rt::testing::tokens();
    let settings: Arc<dyn ChannelSettings> = Arc::new(ConfigChannelSettings::new(config.clone()));
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &root.join("core.sqlite")).unwrap();
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
    let tunnels = Arc::new(mixdog_services::webhooks::relay::RelayTunnelStarter::new(tokens.durability_io, root.to_path_buf(), Some(relay.into())));
    let automation = Arc::new(ArmedReloads {
        inner: WebhookAutomation::new(settings.clone(), service.clone(), Arc::new(ServerListener::new(service.clone(), tunnels))),
        reloaded: tokio::sync::watch::Sender::new(0usize),
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
        base: Arc::new(HookIdentityBase::new(tokens.durability_io, root.to_path_buf(), Some(relay.into()))),
        probe: Arc::new(mixdog_services::channels::ports::ReqwestProbe::new(reqwest::Client::new())),
        clock: wall,
        local_tz: tz,
        channel_start_disabled: false,
        close_requested: CancellationToken::new(),
    });
    Stack { admin, runtime, schedules, webhooks, automation, host }
}

/// `record-webhook-late-reload.mjs` (`fixtures/webhook-late-reload`, step `configEdit`, Node b6f10295a with
/// node-fix-webhook-late-reload.patch): with the receiver listening and the session service running, another process
/// edits the channels section of the config file on disk (port kept). The composition's follow (`ChannelConfigFollow`
/// over the real file watch) hears it and reloads the runtime; a delivery not seen before, sent as the reload syncs the
/// receiver, is answered and runs one routine turn in the owner's home thread. Compared whole: the reply, the reload
/// count, the receiver still listening, and the turns the session boundary received.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delivery_during_a_config_edit_reload_is_answered_and_runs_once_as_node() {
    use mixdog_services::channels::{ChannelSettings, WebhookPatch};
    let rec: Value = serde_json::from_str(include_str!("../../../../fixtures/webhook-late-reload/golden.json")).unwrap();
    let step = &rec["configEdit"];
    let port = rec["port"].as_u64().unwrap() as u16;
    let tz: chrono_tz::Tz = rec["timeZone"].as_str().unwrap().parse().unwrap();
    let wall: Arc<dyn mixdog_services::scheduler::Clock> = Arc::new(WallClock(rec["wallClock"].as_i64().unwrap()));

    let root = tempfile::tempdir().unwrap();
    let config = open(root.path(), None).await;
    let _file_watch = mixdog_core_config::config::ConfigWatcher::start(config.clone()).unwrap();
    // `setWebhookConfigAsync({ port })`, as the recorder seeds the receiver's port (and, the receiver being off by default
    // here, switched on).
    ConfigChannelSettings::new(config.clone()).update_webhook(&WebhookPatch::from_params(&json!({ "enabled": true, "port": port }))).await.unwrap();
    let Stack { admin, runtime, automation, host, .. } = channel_stack(root.path(), &config, wall, tz);
    let reloaded = automation.reloaded.clone();
    // The composition's follow, as compose_flip.rs starts it.
    let _follow = mixdog_core_config::config::ChannelConfigFollow::start(config.clone(), runtime.clone());

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
    mixdog_services::channels::ChannelLifecycle::stop_owned_runtime(&*runtime, "test").await.unwrap();
}

struct NoEvidence;

#[async_trait::async_trait]
impl mixdog_core_agents::agents::AgentEvidence for NoEvidence {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

/// The recording saves its bots without a route, so no route is ever set.
struct NoRouteSets;

#[async_trait::async_trait]
impl super::super::agent_effects::AgentRouteSetting for NoRouteSets {
    async fn set(&self, agent_id: &str, _: &mixdog_ai::service::admin_route::Obj) -> Result<(), String> {
        panic!("the recording sets no route (asked for {agent_id})")
    }
}

/// `JSON.stringify` of a PostgreSQL `timestamptz`: ISO, milliseconds, `Z`.
fn pg_stamp(value: &Value) -> Value {
    match value.as_str() {
        Some(text) => json!(chrono::DateTime::parse_from_rfc3339(text).unwrap().to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        None => Value::Null,
    }
}

/// A stored row as Node's `SELECT` of its columns reads it: the snake-case column names; the stamps as above.
fn node_row(row: impl serde::Serialize, columns: &str) -> Value {
    let camel = serde_json::to_value(row).unwrap();
    let mut out = Map::new();
    for column in columns.split(", ") {
        let field: String = column.split('_').enumerate().map(|(i, part)| if i == 0 { part.to_owned() } else { part[..1].to_uppercase() + &part[1..] }).collect();
        let value = match column {
            "has_last_payload" => json!(!camel["lastPayload"].is_null()),
            _ if column.ends_with("_at") || matches!(column, "deferred_until" | "skipped_until") => pg_stamp(&camel[&field]),
            _ => camel.get(&field).cloned().unwrap_or_else(|| panic!("no column {column}")),
        };
        out.insert(column.to_owned(), value);
    }
    Value::Object(out)
}

/// Every file under `dir`, by its path below it.
fn files(dir: &std::path::Path) -> Value {
    fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Map<String, Value>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut paths: Vec<_> = entries.map(|entry| entry.unwrap().path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let key = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(key, json!(std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let mut out = Map::new();
    walk(dir, dir, &mut out);
    Value::Object(out)
}

/// `record-bot-routines-purge.mjs` (`fixtures/bot-routines-purge`, Node b6f10295a): a bot's whole deletion through the
/// admin entry — `deleteAgentDefinition`, then `purgeAgentDefinition` twice — on the composition's agent definitions
/// (`build_agents`, `DaemonAgentEffects` over `ServiceChannels`) and channel stack over a real store, config and data
/// folder. The bots are saved through the same entry; the routines, secrets and queued deliveries are written through the
/// stores as the recording seeds them; the clock stands at the seed's virtual instant. After every phase the whole state
/// is compared with Node's: every schedule, endpoint (secret included) and delivery column, every file under agents/,
/// and the config's agent bindings.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bots_whole_deletion_through_the_admin_entry_leaves_what_node_leaves() {
    use mixdog_services::scheduler::{Schedule, ScheduleRecords, ScheduleStore};
    use mixdog_services::webhooks::handler::{Claim, WebhookStore};
    use mixdog_services::webhooks::records::{EndpointRecord, EndpointRecords};
    const SCHEDULE_COLS: &str = "name, description, when_at, when_cron, timezone, cwd, attachments, delivery, prompt, enabled, status, last_fired_at, last_scheduled_at, last_started_at, last_success_at, last_failed_at, last_skipped_at, owner_agent_id, executor_agent_id, consecutive_failures, result_delivery, next_fire_at, deferred_until, skipped_until, created_at, updated_at";
    const ENDPOINT_COLS: &str = "name, description, parser, secret, cwd, attachments, delivery, instructions, enabled, owner_agent_id, executor_agent_id, last_event_at, last_success_at, last_failed_at, last_skipped_at, consecutive_failures, result_delivery, has_last_payload, created_at, updated_at";
    let rec: Value = serde_json::from_str(include_str!("../../../../fixtures/bot-routines-purge/golden.json")).unwrap();
    let seed = &rec["seed"];
    let tokens = mixdog_rt::testing::tokens();
    let root = tempfile::tempdir().unwrap();
    let config = open(root.path(), None).await;
    let wall: Arc<dyn mixdog_services::scheduler::Clock> = Arc::new(WallClock(rec["virtualClock"]["start"].as_i64().unwrap()));
    let stack = channel_stack(root.path(), &config, wall, chrono_tz::UTC);
    let effects = Arc::new(super::super::agent_effects::DaemonAgentEffects::new(
        Arc::new(super::super::profile_changes::AgentProfileChanges::default()),
        Arc::new(super::super::agent_effects::ServiceChannels { admin: stack.admin.clone(), runtime: stack.runtime.clone() }),
        Arc::new(NoRouteSets),
    ));
    let agents = crate::compose_mcp::build_agents(
        &tokens,
        &config,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.."),
        root.path(),
        &root.path().join("task"),
        crate::compose_mcp::AgentSeams {
            evidence: Arc::new(NoEvidence),
            main_route: Arc::new(|| json!({ "provider": "anthropic-oauth", "model": "claude-opus-5" })),
            effects,
            now: Arc::new(|| "2023-11-14T22:13:20.000Z".to_owned()),
        },
    );
    let state = || async {
        let mut schedules = stack.schedules.list().await.unwrap();
        schedules.sort_by(|a, b| a.name.cmp(&b.name));
        let mut endpoints = EndpointRecords::list(&*stack.webhooks).await.unwrap();
        endpoints.sort_by(|a, b| a.name.cmp(&b.name));
        json!({
            "schedules": schedules.iter().map(|row| node_row(row, SCHEDULE_COLS)).collect::<Vec<_>>(),
            "endpoints": endpoints.iter().map(|row| node_row(row, ENDPOINT_COLS)).collect::<Vec<_>>(),
            "deliveries": stack.webhooks.delivery_rows().await,
            "agents": files(&root.path().join("agents")),
            "config": { "agents": config.agent().get("agents"), "disabledAgents": config.agent().get("disabledAgents") },
        })
    };

    // The seed: the bots through the entry, the bindings in the agent config (Node's `rt.config`), the routines and
    // claims through the stores.
    let mut ids = Vec::new();
    for bot in seed["bots"].as_array().unwrap() {
        ids.push(agents.save(bot.as_object().unwrap()).await.unwrap()["id"].as_str().unwrap().to_owned());
    }
    assert_eq!(json!({ "reply": ids }), rec["saved"]);
    let route = seed["config"]["agents"]["route"].clone();
    let bound = ids.clone();
    config
        .update_agent(move |agent: &mut Map<String, Value>| {
            agent.insert("agents".into(), Value::Object(bound.iter().map(|id| (id.clone(), route.clone())).collect()));
            agent.insert("disabledAgents".into(), json!(bound));
            Ok(())
        })
        .await
        .unwrap();
    for def in seed["schedules"].as_array().unwrap() {
        let mut def = def.clone();
        def["ownerAgentId"] = json!(ids[def["owner"].as_u64().unwrap() as usize]);
        def.as_object_mut().unwrap().remove("owner");
        stack.schedules.upsert(&serde_json::from_value::<Schedule>(def).unwrap()).await.unwrap();
    }
    for def in seed["endpoints"].as_array().unwrap() {
        let mut def = def.clone();
        def["ownerAgentId"] = json!(ids[def["owner"].as_u64().unwrap() as usize]);
        def.as_object_mut().unwrap().remove("owner");
        stack.webhooks.upsert(&serde_json::from_value::<EndpointRecord>(def).unwrap()).await.unwrap();
    }
    let claim = &seed["claim"];
    for delivery in seed["deliveries"].as_array().unwrap() {
        let fields = Claim {
            status: claim["status"].as_str().unwrap(),
            event: claim["event"].as_str(),
            headers_summary: claim["headersSummary"].clone(),
            payload_preview: claim["payloadPreview"].as_str().unwrap().to_owned(),
        };
        assert!(stack.webhooks.claim_delivery(delivery["endpoint"].as_str().unwrap(), delivery["deliveryId"].as_str().unwrap(), fields).await.unwrap());
    }

    let phases = rec["phases"].as_array().unwrap();
    assert_eq!(json!({ "step": "seeded", "state": state().await }), phases[0]);
    for phase in &phases[1..] {
        let step = phase["step"].as_str().unwrap();
        let agent = phase["agentId"].as_str().unwrap();
        let outcome = if step == "deleteAgentDefinition" { agents.delete(agent).await } else { agents.purge(agent).await };
        let mut got = json!({ "step": step, "agentId": agent });
        match outcome {
            Ok(reply) => got["reply"] = reply,
            Err(error) => got["error"] = json!(error.to_string()),
        }
        got["state"] = state().await;
        assert_eq!(got, *phase, "{step}");
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
