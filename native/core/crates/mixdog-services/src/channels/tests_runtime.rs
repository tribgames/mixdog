//! The channel admin surface, the runtime lifecycle and the `channel/` service over the real
//! durable stores (one `state/core.sqlite` in a temp dir) and a scripted session host.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono_tz::Tz;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::{Method, OpId};
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use mixdog_protocol::DomainErrorDetail;
use mixdog_rt::testing::tokens;
use mixdog_store::state::CoreState;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::admin::{AdminDeps, AdminError, ChannelAdmin};
use super::bridge::BridgeCalls;
use super::call::CallDispatch;
use super::ports::{
    AgentRuntime, AutomationServices, ChannelSettings, ProbeError, ProbeResponse, PublicBase, WebhookAutomation, WebhookListener,
    WebhookPatch, WebhookProbe, WebhookSettings,
};
use super::running::RunningWork;
use super::runtime::ChannelRuntime;
use super::service::ChannelService;
use super::tools::{ACTIVATE_TOOL, ChannelLifecycle, ToolDispatch};
use crate::bots::tests::{FakeHost, sched};
use crate::bots::{
    HomeScheduleRunner, HomeWebhookDispatch, OwnerProblem, RoutineKind, RoutineRuntime, StoreRoutineRecords, TurnSettle,
};
use crate::scheduler::{
    Schedule, ScheduleError, ScheduleRecords, ScheduleStatus, ScheduleStore, Scheduler, StateScheduleStore, SystemClock,
};
use crate::webhooks::lifecycle::{TunnelStarter, WebhookServer};
use crate::webhooks::relay::{RelayTunnelStarter, hook_public_base};
use crate::webhooks::signature::{Headers, hmac_hex};
use crate::webhooks::{EndpointRecord, EndpointRecords, StateWebhookStore, WebhookConfig, WebhookService, WebhookStore};

#[derive(Default)]
struct FakeSettings {
    webhook: Mutex<WebhookSettings>,
}

#[async_trait]
impl ChannelSettings for FakeSettings {
    async fn webhook(&self) -> Result<WebhookSettings, String> {
        Ok(self.webhook.lock().unwrap().clone())
    }
    async fn update_webhook(&self, patch: &WebhookPatch) -> Result<WebhookSettings, String> {
        let mut current = self.webhook.lock().unwrap();
        *current = patch.apply(current.clone());
        Ok(current.clone())
    }
    async fn webhook_config(&self) -> Result<WebhookConfig, String> {
        Ok(WebhookConfig::default())
    }
}

#[derive(Default)]
struct FakeServices {
    log: Mutex<Vec<String>>,
    /// The sync waits for a permit of this semaphore (a listener that has not bound yet).
    sync_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    /// Notified when a sync has been entered.
    entered: tokio::sync::Notify,
}

/// Waits for a signal a test double gives; the bound only turns a missing signal into a failure.
async fn signal(notify: &tokio::sync::Notify, what: &str) {
    mixdog_rt::time::timeout(Duration::from_secs(15), notify.notified()).await.unwrap_or_else(|_| panic!("never signalled: {what}"));
}

#[async_trait]
impl AutomationServices for FakeServices {
    async fn sync(&self, reload: bool) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("sync:{reload}"));
        self.entered.notify_one();
        let gate = self.sync_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.acquire().await.expect("the gate stays open").forget();
        }
        Ok(())
    }
    async fn stop(&self) {
        self.log.lock().unwrap().push("stop".into());
    }
}

#[derive(Default)]
struct FakeAgent {
    inits: AtomicUsize,
    /// Provider inits that ran to their end (not dropped while held).
    init_finished: AtomicUsize,
    /// The provider init waits for a permit of this semaphore (a start stuck in it).
    init_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    /// Notified when a provider init has been entered.
    entered: tokio::sync::Notify,
}

#[async_trait]
impl AgentRuntime for FakeAgent {
    async fn init_providers(&self) -> Result<(), String> {
        self.inits.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        let gate = self.init_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.acquire().await.expect("the gate stays open").forget();
        }
        self.init_finished.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Default)]
struct FakeBase(Mutex<Option<String>>);

#[async_trait]
impl PublicBase for FakeBase {
    async fn hook_public_base(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
}

type Sent = (String, Vec<(String, String)>, String);

#[derive(Default)]
struct FakeProbe {
    reply: Mutex<Option<Result<ProbeResponse, ProbeError>>>,
    sent: Mutex<Vec<Sent>>,
}

#[async_trait]
impl WebhookProbe for FakeProbe {
    async fn post(&self, url: &str, headers: &[(String, String)], body: String, _timeout: Duration) -> Result<ProbeResponse, ProbeError> {
        self.sent.lock().unwrap().push((url.to_string(), headers.to_vec(), body));
        self.reply.lock().unwrap().clone().expect("a scripted reply")
    }
}

struct Env {
    host: Arc<FakeHost>,
    admin: Arc<ChannelAdmin>,
    runtime: Arc<ChannelRuntime>,
    routines: Arc<RoutineRuntime>,
    schedules: Arc<StateScheduleStore>,
    webhooks: Arc<StateWebhookStore>,
    settings: Arc<FakeSettings>,
    services: Arc<FakeServices>,
    agent: Arc<FakeAgent>,
    probe: Arc<FakeProbe>,
    base: Arc<FakeBase>,
    work: RunningWork,
    /// `isCloseRequested()` of the admin.
    closing: CancellationToken,
    _dir: tempfile::TempDir,
}

async fn env() -> Env {
    env_with(false).await
}

async fn env_with(channel_start_disabled: bool) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &dir.path().join("core.sqlite")).unwrap();
    let schedules = Arc::new(StateScheduleStore::new(state.clone(), Arc::new(SystemClock)));
    let webhooks = Arc::new(StateWebhookStore::new(state, Arc::new(SystemClock)));
    let host = Arc::new(FakeHost::default());
    let records = Arc::new(StoreRoutineRecords::new(schedules.clone(), webhooks.clone()));
    let routines = RoutineRuntime::new(host.clone(), records, Arc::new(SystemClock), Tz::UTC);
    let work = RunningWork::new();
    let scheduler = Scheduler::new(
        schedules.clone(),
        Arc::new(HomeScheduleRunner::new(routines.clone())),
        Arc::new(SystemClock),
        work.clone(),
        Tz::UTC,
        Vec::new(),
    );
    let (settings, services, agent, base, probe) = (
        Arc::new(FakeSettings::default()),
        Arc::new(FakeServices::default()),
        Arc::new(FakeAgent::default()),
        Arc::new(FakeBase::default()),
        Arc::new(FakeProbe::default()),
    );
    let runtime = ChannelRuntime::new(scheduler, schedules.clone(), services.clone(), agent.clone());
    let closing = CancellationToken::new();
    let admin = ChannelAdmin::new(AdminDeps {
        schedules: schedules.clone(),
        webhooks: webhooks.clone(),
        routines: routines.clone(),
        runtime: runtime.clone(),
        settings: settings.clone(),
        base: base.clone(),
        probe: probe.clone(),
        clock: Arc::new(SystemClock),
        local_tz: Tz::UTC,
        channel_start_disabled,
        close_requested: closing.clone(),
    });
    Env { host, admin, runtime, routines, schedules, webhooks, settings, services, agent, probe, base, work, closing, _dir: dir }
}

fn recurring(name: &str) -> Value {
    json!({"name": name, "time": "0 9 * * *", "instructions": "Report."})
}

fn message(error: AdminError) -> String {
    match error {
        AdminError::Message(m) => m,
        other => panic!("not a plain message: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saving_a_recurring_schedule_stores_it_and_lists_the_same_row() {
    let e = env().await;
    let entry = json!({
        "name": "weekday report", "time": "0 9 * * *", "days": "weekday", "timezone": "Asia/Seoul",
        "instructions": " Report. ", "description": " daily "
    });
    let saved = e.admin.save_schedule(&entry).await.unwrap();
    assert_eq!(
        (saved["time"].as_str(), saved["whenCron"].as_str(), saved["timezone"].as_str(), saved["instructions"].as_str()),
        (Some("0 9 * * 1-5"), Some("0 9 * * 1-5"), Some("Asia/Seoul"), Some("Report."))
    );
    assert_eq!((saved["owner"].as_str(), saved["enabled"].clone(), saved["description"].as_str()), (Some("lead"), json!(true), Some("daily")));
    assert!(saved.get("whenAt").is_none() && saved["executorAgentId"].is_null());
    let row = e.schedules.get("weekday report").await.unwrap().unwrap();
    assert_eq!((row.delivery.as_deref(), row.owner_agent_id.as_str(), row.status), (Some("app"), "lead", ScheduleStatus::Active));
    // The started runtime may have stamped the next fire meanwhile; everything else is the row.
    let mut listed = e.admin.list_schedules().await.unwrap();
    listed[0].as_object_mut().unwrap().shift_remove("nextFireAt");
    assert_eq!(listed, vec![saved]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_one_shot_takes_an_instant_and_a_cron_needs_a_valid_zone() {
    let e = env().await;
    let saved = e.admin.save_schedule(&json!({"name": "once", "at": "2031-05-06T07:08:09Z", "instructions": "Do it."})).await.unwrap();
    assert_eq!(saved["time"], "at 2031-05-06T07:08:09.000Z");
    assert_eq!(saved["nextFireAt"], "2031-05-06T07:08:09.000Z");
    assert!(saved["timezone"].is_null() || saved.get("timezone").is_none());
    let local = e.admin.save_schedule(&json!({"name": "local", "at": "2031-05-06 07:08", "instructions": "x"})).await.unwrap();
    assert_eq!(local["whenAt"], "2031-05-06T07:08:00.000Z");
    let dated = e.admin.save_schedule(&json!({"name": "dated", "at": "2031-05-06", "instructions": "x"})).await.unwrap();
    assert_eq!(dated["whenAt"], "2031-05-06T00:00:00.000Z");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bad_save_is_refused_with_the_reason() {
    let e = env().await;
    let refuse = |entry: Value| {
        let admin = e.admin.clone();
        async move { message(admin.save_schedule(&entry).await.unwrap_err()) }
    };
    assert_eq!(refuse(json!({})).await, "schedule name must be 1-64 letters, digits, spaces, dots, underscores, or hyphens");
    assert_eq!(refuse(json!({"name": "a/b", "instructions": "x"})).await, "schedule name must be 1-64 letters, digits, spaces, dots, underscores, or hyphens");
    assert_eq!(refuse(json!({"name": "a"})).await, "schedule instructions are required");
    assert_eq!(refuse(json!({"name": "a", "instructions": "x"})).await, "either `time` (recurring cron) or `at` (one-shot datetime) is required");
    assert_eq!(
        refuse(json!({"name": "a", "instructions": "x", "time": "0 9 * * *", "at": "2031-01-01"})).await,
        "provide either `time` (recurring) or `at` (one-shot), not both"
    );
    assert_eq!(refuse(json!({"name": "a", "instructions": "x", "time": "0 9 *"})).await, "time must be a 5- or 6-field cron expression");
    assert_eq!(refuse(json!({"name": "a", "instructions": "x", "time": "61 9 * * *"})).await, "invalid cron expression \"61 9 * * *\"");
    assert_eq!(
        refuse(json!({"name": "a", "instructions": "x", "time": "0 9 * * *", "timezone": "Mars/Base"})).await,
        "invalid schedule timezone \"Mars/Base\""
    );
    assert_eq!(
        refuse(json!({"name": "a", "instructions": "x", "time": "0 9 * * *", "days": "someday"})).await,
        "days \"someday\" is not a recognizable day selector"
    );
    assert_eq!(refuse(json!({"name": "a", "instructions": "x", "at": "soon"})).await, "at \"soon\" is not a valid datetime");
    assert_eq!(
        refuse(json!({"name": "a", "instructions": "x", "time": "0 9 * * *", "owner": "Bad Id"})).await,
        "schedule owner \"Bad Id\" is not a valid agent id"
    );
    assert!(refuse(json!({"name": "a", "instructions": "x", "time": "0 9 * * *", "executorAgentId": "ghost"})).await.contains("is not an available sub-agent"));
    *e.host.owner_problem.lock().unwrap() = Some(OwnerProblem::NoMixy);
    assert_eq!(refuse(recurring("a")).await, "Create the representative bot first.");
    assert!(e.schedules.list().await.unwrap().is_empty(), "nothing was stored");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saving_over_a_name_needs_overwrite_and_a_redefinition_clears_runtime_state() {
    let e = env().await;
    e.admin.save_schedule(&recurring("a")).await.unwrap();
    e.schedules.mark_failure("a", chrono::Utc::now()).await.unwrap();
    let taken = e.admin.save_schedule(&recurring("a")).await.unwrap_err();
    assert_eq!(taken, AdminError::Schedule(ScheduleError::NameTaken { name: "a".into() }));
    let mut again = recurring("a");
    again["overwrite"] = json!(true);
    let saved = e.admin.save_schedule(&again).await.unwrap();
    assert_eq!(saved["consecutiveFailures"], 0);
    assert_eq!(e.schedules.get("a").await.unwrap().unwrap().last_failed_at, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_moves_the_row_keeps_history_and_rearms_only_when_timing_changed() {
    let e = env().await;
    e.admin.save_schedule(&recurring("a")).await.unwrap();
    let at = chrono::Utc::now();
    e.schedules.mark_success("a", at).await.unwrap();
    e.schedules.mark_fired("a", at).await.unwrap();

    let mut rename = recurring("a");
    rename["newName"] = json!("b");
    rename["overwrite"] = json!(true);
    let saved = e.admin.save_schedule(&rename).await.unwrap();
    assert_eq!(saved["name"], "b");
    assert!(e.schedules.get("a").await.unwrap().is_none());
    let moved = e.schedules.get("b").await.unwrap().unwrap();
    assert_eq!((moved.last_success_at, moved.last_fired_at), (Some(at), Some(at)), "same timing keeps the history");

    let mut retimed = json!({"name": "b", "newName": "c", "time": "30 10 * * *", "instructions": "Report.", "overwrite": true});
    let saved = e.admin.save_schedule(&retimed).await.unwrap();
    assert_eq!(saved["whenCron"], "30 10 * * *");
    let row = e.schedules.get("c").await.unwrap().unwrap();
    assert_eq!((row.last_fired_at, row.last_success_at), (None, Some(at)), "new timing re-arms, history stays");

    e.admin.save_schedule(&recurring("d")).await.unwrap();
    retimed["name"] = json!("c");
    retimed["newName"] = json!("d");
    assert_eq!(e.admin.save_schedule(&retimed).await.unwrap_err(), AdminError::Schedule(ScheduleError::NameTaken { name: "d".into() }));
    retimed["name"] = json!("zz");
    retimed["newName"] = json!("zzz");
    assert_eq!(message(e.admin.save_schedule(&retimed).await.unwrap_err()), "schedule \"zz\" does not exist");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_is_refused_while_a_run_holds_the_name_and_goes_through_the_scheduler_when_up() {
    let e = env().await;
    e.admin.save_schedule(&recurring("a")).await.unwrap();
    let rename = json!({"name": "a", "newName": "b", "time": "0 9 * * *", "instructions": "Report.", "overwrite": true});
    let held = e.routines.runs().begin(RoutineKind::Schedule, "a").unwrap();
    assert_eq!(
        e.admin.save_schedule(&rename).await.unwrap_err(),
        AdminError::Schedule(ScheduleError::RenameRunning { name: "a".into() })
    );
    drop(held);

    e.runtime.start_automation().await.unwrap();
    assert!(e.runtime.automation_running());
    e.services.log.lock().unwrap().clear();
    let saved = e.admin.save_schedule(&rename).await.unwrap();
    assert_eq!(saved["name"], "b");
    assert!(e.schedules.get("a").await.unwrap().is_none() && e.schedules.get("b").await.unwrap().is_some());
    assert!(e.services.log.lock().unwrap().contains(&"sync:true".to_string()), "the scheduler was reloaded from the renamed row");
    e.runtime.stop_owned_runtime("test").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_and_deleting_schedules() {
    let e = env().await;
    e.admin.save_schedule(&recurring("a")).await.unwrap();
    assert_eq!(e.admin.set_schedule_enabled("a", false).await.unwrap(), json!({"name": "a", "enabled": false}));
    assert!(!e.schedules.get("a").await.unwrap().unwrap().enabled);
    assert_eq!(message(e.admin.set_schedule_enabled("zz", true).await.unwrap_err()), "schedule \"zz\" does not exist");
    assert_eq!(e.admin.delete_schedule("a").await.unwrap(), json!({"name": "a", "deleted": true}));
    assert_eq!(e.admin.delete_schedule("a").await.unwrap(), json!({"name": "a", "deleted": true}), "deleting a missing name is not an error");
    assert!(e.schedules.get("a").await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_webhook_save_mints_keeps_and_rotates_its_secret_and_never_lists_it() {
    let e = env().await;
    let entry = json!({"name": "gh", "instructions": "Summarise.", "parser": " GitHub "});
    let saved = e.admin.save_webhook(&entry).await.unwrap();
    let minted = saved["secret"].as_str().unwrap().to_string();
    assert_eq!(minted.len(), 48);
    assert!(minted.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!((saved["parser"].as_str(), saved["owner"].as_str(), saved["name"].as_str()), (Some("github"), Some("lead"), Some("gh")));

    let listed = e.admin.list_webhooks().await.unwrap();
    assert_eq!((listed[0]["secretSet"].clone(), listed[0].get("secret").is_none()), (json!(true), true));
    assert_eq!(listed[0]["hasLastPayload"], false);

    assert_eq!(message(e.admin.save_webhook(&entry).await.unwrap_err()), "webhook \"gh\" already exists");
    let mut overwrite = entry.clone();
    overwrite["overwrite"] = json!(true);
    assert_eq!(e.admin.save_webhook(&overwrite).await.unwrap()["secret"], minted.as_str(), "an empty secret keeps the stored one");
    overwrite["secret"] = json!(" fresh ");
    assert_eq!(e.admin.save_webhook(&overwrite).await.unwrap()["secret"], "fresh");
    assert_eq!(e.webhooks.read_secret("gh").await.unwrap().as_deref(), Some("fresh"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bad_webhook_save_is_refused_and_switching_and_deleting_work() {
    let e = env().await;
    let refuse = |entry: Value| {
        let admin = e.admin.clone();
        async move { message(admin.save_webhook(&entry).await.unwrap_err()) }
    };
    assert_eq!(refuse(json!({"name": "Bad Name", "instructions": "x"})).await, "webhook name must match /^[a-z0-9][a-z0-9-]{0,63}$/");
    assert_eq!(refuse(json!({"name": "gh", "instructions": "x", "parser": "slack"})).await, "parser must be github, generic, stripe, or sentry");
    assert_eq!(refuse(json!({"name": "gh"})).await, "webhook instructions are required");
    e.admin.save_webhook(&json!({"name": "gh", "instructions": "x", "enabled": false})).await.unwrap();
    assert!(!e.webhooks.load("gh").await.unwrap().unwrap().enabled);
    assert_eq!(e.admin.set_webhook_enabled("gh", true).await.unwrap(), json!({"name": "gh", "enabled": true}));
    assert_eq!(message(e.admin.set_webhook_enabled("zz", true).await.unwrap_err()), "webhook \"zz\" does not exist");
    assert_eq!(e.admin.delete_webhook("gh").await.unwrap(), json!({"name": "gh", "deleted": true}));
    assert!(e.webhooks.load("gh").await.unwrap().is_none());
}

fn probe_headers(sent: &Sent) -> Headers {
    sent.1.iter().cloned().collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_test_request_is_signed_the_way_the_receiver_verifies_it() {
    let e = env().await;
    *e.base.0.lock().unwrap() = Some("https://hooks.example/".into());
    e.admin.save_webhook(&json!({"name": "gh", "instructions": "x", "secret": "s3cret"})).await.unwrap();
    *e.probe.reply.lock().unwrap() = Some(Ok(ProbeResponse { status: 200, body: json!({"status": "verified"}).to_string() }));
    let result = e.admin.test_webhook("gh").await.unwrap();
    assert_eq!(result, json!({"name": "gh", "ok": true, "status": 200, "url": "https://hooks.example/webhook/gh"}));

    let sent = e.probe.sent.lock().unwrap()[0].clone();
    assert_eq!(sent.0, "https://hooks.example/webhook/gh");
    let headers = probe_headers(&sent);
    assert_eq!(headers["x-mixdog-webhook-test"], "1");
    assert_eq!(headers["x-github-event"], "ping");
    assert_eq!(headers["x-hub-signature-256"], format!("sha256={}", hmac_hex("s3cret", sent.2.as_bytes())));
    let body: Value = serde_json::from_str(&sent.2).unwrap();
    assert_eq!((body["mixdogWebhookTest"].clone(), body["webhook"].as_str()), (json!(true), Some("gh")));

    // The real receiver accepts exactly this request, answers `verified` and runs nothing.
    let dispatch = Arc::new(HomeWebhookDispatch::new(e.routines.clone(), e.webhooks.clone(), None, e.work.clone()));
    let service = WebhookService::new(e.webhooks.clone(), dispatch, WebhookConfig::default(), e.work.clone(), Arc::new(|| chrono::Utc::now().timestamp_millis()));
    let reply = service.handle_post("/webhook/gh", &headers, sent.2.as_bytes()).await;
    assert_eq!((reply.status, reply.body), (200, json!({"status": "verified", "test": true})));
    assert!(e.host.turns().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_parser_signs_in_its_own_format_and_failures_carry_a_code() {
    let e = env().await;
    *e.base.0.lock().unwrap() = Some("https://hooks.example".into());
    let ok = || Some(Ok(ProbeResponse { status: 200, body: json!({"status": "verified"}).to_string() }));
    let send = |name: &'static str, parser: &'static str| {
        let e = (&e.admin, &e.probe);
        async move {
            e.0.save_webhook(&json!({"name": name, "instructions": "x", "parser": parser, "secret": "k"})).await.unwrap();
            e.0.test_webhook(name).await.unwrap();
            e.1.sent.lock().unwrap().last().cloned().unwrap()
        }
    };
    *e.probe.reply.lock().unwrap() = ok();
    let sent = send("st", "stripe").await;
    let header = probe_headers(&sent)["stripe-signature"].clone();
    let (t, v1) = header.strip_prefix("t=").unwrap().split_once(",v1=").unwrap();
    assert_eq!(v1, hmac_hex("k", format!("{t}.{}", sent.2).as_bytes()));
    let sent = send("se", "sentry").await;
    assert_eq!(probe_headers(&sent)["sentry-hook-signature"], hmac_hex("k", sent.2.as_bytes()));
    let sent = send("ge", "generic").await;
    assert_eq!(probe_headers(&sent)["x-signature-256"], format!("sha256={}", hmac_hex("k", sent.2.as_bytes())));

    *e.probe.reply.lock().unwrap() = Some(Ok(ProbeResponse { status: 403, body: json!({"error": "invalid signature"}).to_string() }));
    assert_eq!(
        e.admin.test_webhook("ge").await.unwrap(),
        json!({"name": "ge", "ok": false, "status": 403, "url": "https://hooks.example/webhook/ge", "code": "rejected", "error": "invalid signature"})
    );
    *e.probe.reply.lock().unwrap() = Some(Ok(ProbeResponse { status: 502, body: "<html>".into() }));
    assert_eq!(e.admin.test_webhook("ge").await.unwrap()["error"], "Unexpected response (HTTP 502)");
    *e.probe.reply.lock().unwrap() = Some(Err(ProbeError::TimedOut));
    let timed_out = e.admin.test_webhook("ge").await.unwrap();
    assert_eq!((timed_out["code"].as_str(), timed_out["error"].as_str(), timed_out["status"].clone()), (Some("timeout"), Some("Request timed out after 15 seconds."), json!(0)));
    *e.probe.reply.lock().unwrap() = Some(Err(ProbeError::Network("connection refused".into())));
    let refused = e.admin.test_webhook("ge").await.unwrap();
    assert_eq!((refused["code"].as_str(), refused["error"].as_str()), (Some("network"), Some("connection refused")));

    let calls = e.probe.sent.lock().unwrap().len();
    *e.base.0.lock().unwrap() = None;
    let none = e.admin.test_webhook("ge").await.unwrap();
    assert_eq!((none["code"].as_str(), none["url"].as_str()), (Some("relay-unavailable"), Some("")));
    assert_eq!(e.probe.sent.lock().unwrap().len(), calls, "no request without a public URL");
    assert_eq!(message(e.admin.test_webhook("nope").await.unwrap_err()), "webhook \"nope\" does not exist");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_schedule_now_runs_in_the_owners_thread_and_stamps_the_outcome() {
    let e = env().await;
    e.schedules.upsert(&sched("a")).await.unwrap();
    let ran = e.admin.run_schedule_now(" a ").await.unwrap();
    assert_eq!(ran, json!({"name": "a", "ok": true, "sessionId": "sess_home_gh-bot", "result": "ok"}));
    assert!(e.schedules.get("a").await.unwrap().unwrap().last_success_at.is_some());

    e.host.settles.lock().unwrap().push_back(TurnSettle::Failed("provider down".into()));
    assert_eq!(message(e.admin.run_schedule_now("a").await.unwrap_err()), "provider down");
    assert_eq!(e.schedules.get("a").await.unwrap().unwrap().consecutive_failures, 1);
    // A person's run ignores the backoff the failure started.
    assert!(e.admin.run_schedule_now("a").await.is_ok());

    let held = e.routines.runs().begin(RoutineKind::Schedule, "a").unwrap();
    assert_eq!(message(e.admin.run_schedule_now("a").await.unwrap_err()), "\"a\" is still running; this run was skipped");
    assert!(e.schedules.get("a").await.unwrap().unwrap().last_skipped_at.is_some());
    drop(held);

    *e.host.owner_problem.lock().unwrap() = Some(OwnerProblem::OwnerDeleted);
    assert_eq!(message(e.admin.run_schedule_now("a").await.unwrap_err()), format!("\"a\" is paused: {}", OwnerProblem::OwnerDeleted.message()));
    assert_eq!(message(e.admin.run_schedule_now("zz").await.unwrap_err()), "schedule \"zz\" does not exist");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_webhook_now_replays_the_latest_payload_behind_the_fence() {
    let e = env().await;
    assert_eq!(message(e.admin.run_webhook_now("gh").await.unwrap_err()), "webhook \"gh\" does not exist");
    e.admin.save_webhook(&json!({"name": "gh", "instructions": "Summarise.", "owner": "gh-bot"})).await.unwrap();
    assert_eq!(message(e.admin.run_webhook_now("gh").await.unwrap_err()), "webhook \"gh\" has not received a payload yet");
    e.webhooks
        .record_event("gh", json!({"body": {"action": "opened"}, "headers": {"x-github-event": "issues"}}), chrono::Utc::now())
        .await
        .unwrap();
    let ran = e.admin.run_webhook_now("gh").await.unwrap();
    assert_eq!(ran, json!({"name": "gh", "ok": true, "sessionId": "sess_home_gh-bot", "result": "ok"}));
    let turn = &e.host.turns()[0];
    assert_eq!((turn.skill_selection.as_str(), turn.trigger.event.as_deref()), ("Summarise.", Some("issues · opened")));
    let text = turn.content.as_str().unwrap();
    assert!(text.contains("x-github-event: issues") && text.contains("\"action\": \"opened\""));
    assert!(e.webhooks.load("gh").await.unwrap().unwrap().last_success_at.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_bridge_tools_start_and_stop_the_runtime_and_count_as_running_work() {
    let e = env().await;
    e.schedules.upsert(&sched("a")).await.unwrap();
    let done = Schedule { status: ScheduleStatus::Done, ..sched("finished") };
    e.schedules.upsert(&done).await.unwrap();
    e.schedules.mark_done("finished").await.unwrap();
    let tools = ToolDispatch::new(e.runtime.clone(), e.work.clone(), Box::new(|| false));

    assert!(e.work.is_idle());
    let on = tools.handle_tool_call(ACTIVATE_TOOL, &json!({"active": true})).await;
    assert_eq!(on["content"][0]["text"], "channel bridge activated");
    assert!(e.runtime.status().running && !e.work.is_idle());
    assert!(e.agent.inits.load(Ordering::SeqCst) >= 1, "providers are registered before the first fire");
    assert_eq!(e.services.log.lock().unwrap().clone(), vec!["sync:false".to_string()]);
    assert_eq!(e.runtime.scheduler().status().iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["a"], "a finished one-shot is never armed");

    let off = tools.handle_tool_call(ACTIVATE_TOOL, &json!({"active": false})).await;
    assert_eq!(off["content"][0]["text"], "channel bridge deactivated");
    assert!(!e.runtime.status().running && e.work.is_idle());
    assert!(e.services.log.lock().unwrap().contains(&"stop".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reload_config_rearms_the_scheduler_and_leaves_the_agent_runtime_alone() {
    let e = env().await;
    let tools = ToolDispatch::new(e.runtime.clone(), e.work.clone(), Box::new(|| false));
    e.runtime.start_automation().await.unwrap();
    e.schedules.upsert(&sched("late")).await.unwrap();
    assert!(e.runtime.scheduler().status().is_empty());
    let reloaded = tools.handle_tool_call("reload_config", &json!({})).await;
    // Node's real `reload_config` after `ensureStandaloneEnvironment` (MIXDOG_STANDALONE=1): `fixtures/standalone-defaults`.
    let twin: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/standalone-defaults/twin.json")).unwrap()).unwrap();
    for recorded in twin["reloads"].as_array().unwrap() {
        assert_eq!(recorded["standaloneAfterStart"], "1");
        assert_eq!(recorded["runtimeReloads"], 1);
        assert_eq!(reloaded, recorded["result"]);
    }
    assert_eq!(e.runtime.scheduler().status().len(), 1, "a schedule saved after the start is armed by the reload");
    e.runtime.stop_owned_runtime("test").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_webhook_settings_patch_and_the_setup_view() {
    let e = env().await;
    *e.base.0.lock().unwrap() = Some("https://hooks.example".into());
    let patched = e.admin.set_webhook_config(&json!({"enabled": false, "port": "4000", "domain": " d.example "})).await.unwrap();
    assert_eq!(patched, json!({"webhook": {"enabled": false, "port": 4000, "domain": "d.example"}}));
    assert_eq!(*e.settings.webhook.lock().unwrap(), WebhookSettings { enabled: false, port: json!(4000), domain: Some("d.example".into()) });
    let setup = e.admin.get_channel_setup().await.unwrap();
    assert_eq!(setup["webhook"], json!({"enabled": false, "port": 4000, "domain": "d.example", "publicUrl": "https://hooks.example"}));
    assert_eq!((setup["schedules"].clone(), setup["webhooks"].clone()), (json!([]), json!([])));
    assert_eq!(e.admin.get_channel_settings(&json!({"includeStatus": false})), json!({}));
    assert_eq!(e.admin.get_channel_settings(&Value::Null)["status"]["mode"], "core");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automation_is_present_while_something_enabled_exists() {
    let e = env().await;
    assert!(!e.admin.has_active_automation().await);
    e.admin.save_webhook(&json!({"name": "gh", "instructions": "x", "enabled": false})).await.unwrap();
    assert!(!e.admin.has_active_automation().await);
    e.admin.set_webhook_enabled("gh", true).await.unwrap();
    assert!(e.admin.has_active_automation().await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleting_a_bots_routines_removes_only_its_own() {
    let e = env().await;
    e.schedules.upsert(&sched("mine")).await.unwrap();
    e.schedules.upsert(&Schedule { owner_agent_id: "other".into(), ..sched("theirs") }).await.unwrap();
    e.webhooks.upsert(&EndpointRecord { name: "hook".into(), owner_agent_id: "gh-bot".into(), ..Default::default() }).await.unwrap();
    assert_eq!(e.admin.delete_owned_routines("gh-bot").await.unwrap(), json!({"schedules": ["mine"], "webhooks": ["hook"]}));
    assert_eq!(e.schedules.list().await.unwrap().len(), 1);
    assert_eq!(message(e.admin.delete_owned_routines("lead").await.unwrap_err()), "the routines of \"lead\" cannot be deleted with a bot");
}

fn request(method: &'static str, params: Value, op: Option<&str>) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: op.map(OpId::from), ctx: CallContext::internal("test") }
}

fn service(e: &Env) -> ChannelService {
    let tools = ToolDispatch::new(e.runtime.clone(), e.work.clone(), Box::new(|| false));
    let calls = CallDispatch::new(Arc::new(BridgeCalls::new(tools)), e.work.clone());
    ChannelService::new(e.admin.clone(), calls)
}

async fn ask(service: &ChannelService, method: &'static str, params: Value) -> Result<Value, CoreError> {
    match service.call(request(method, params, Some("op-1"))).await? {
        Reply::Value(value) => Ok(value),
        Reply::Subscribe(_) => panic!("channel methods never subscribe"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_service_answers_admin_methods_and_maps_refusals_to_domain_errors() {
    let e = env().await;
    let svc = service(&e);
    let status = ask(&svc, "channel/getChannelWorkerStatus", json!({})).await.unwrap();
    assert_eq!((status["mode"].as_str(), status["running"].clone()), (Some("core"), json!(false)));

    let saved = ask(&svc, "channel/saveSchedule", json!({"entry": recurring("a"), "opId": "o1"})).await.unwrap();
    assert_eq!(saved["name"], "a");
    let taken = ask(&svc, "channel/saveSchedule", json!({"entry": recurring("a")})).await.unwrap_err();
    let CoreError::DomainError { domain, code, message, detail } = taken else { panic!("a coded error") };
    assert_eq!((&*domain, code.as_deref()), ("channel", Some("SCHEDULE_NAME_TAKEN")));
    assert!(message.is_some_and(|m| !m.is_empty()), "Node's message travels with the typed detail");
    assert_eq!(detail.as_deref(), Some(&DomainErrorDetail::ScheduleNameTaken { name: "a".into() }));
    let refused = ask(&svc, "channel/saveSchedule", json!({"entry": {"name": "b"}})).await.unwrap_err();
    assert_eq!(
        refused,
        CoreError::DomainError {
            domain: "channel".into(),
            code: Some("CHANNEL_FAILED".into()),
            message: Some("schedule instructions are required".into()),
            detail: None,
        }
    );
    assert_eq!(ask(&svc, "channel/setScheduleEnabled", json!({"name": "a", "enabled": false})).await.unwrap(), json!({"name": "a", "enabled": false}));
    assert_eq!(ask(&svc, "channel/deleteSchedule", json!({"name": "a"})).await.unwrap(), json!({"name": "a", "deleted": true}));
    let patched = ask(&svc, "channel/setWebhookConfig", json!({"patch": {"port": 4100}})).await.unwrap();
    assert_eq!(patched["webhook"]["port"], 4100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_service_rejects_malformed_params_and_unknown_methods() {
    let e = env().await;
    let svc = service(&e);
    let invalid = |path: &str, expected: &str| CoreError::InvalidParams { path: path.into(), expected: expected.into() };
    assert_eq!(ask(&svc, "channel/deleteSchedule", json!({})).await.unwrap_err(), invalid("name", "string"));
    assert_eq!(ask(&svc, "channel/setWebhookEnabled", json!({"name": "gh", "enabled": "yes"})).await.unwrap_err(), invalid("enabled", "boolean"));
    assert_eq!(ask(&svc, "channel/saveWebhook", json!({"entry": "x"})).await.unwrap_err(), invalid("entry", "object"));
    assert_eq!(ask(&svc, "channel/call", json!({"name": "reload_config", "args": 5})).await.unwrap_err(), invalid("args", "object"));
    assert_eq!(ask(&svc, "channel/nope", json!({})).await.unwrap_err(), invalid("method", "channel/*"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bridge_call_runs_once_per_op_and_a_reused_op_with_another_payload_conflicts() {
    let e = env().await;
    let svc = service(&e);
    let first = ask(&svc, "channel/call", json!({"name": "reload_config", "args": {}})).await.unwrap();
    let retried = ask(&svc, "channel/call", json!({"name": "reload_config", "args": {}})).await.unwrap();
    assert_eq!(first, retried);
    assert_eq!(first["content"][0]["text"], "config reloaded — schedules, webhooks, events re-registered");
    let conflict = ask(&svc, "channel/call", json!({"name": "reload_config", "args": {"x": 1}})).await.unwrap_err();
    assert_eq!(conflict, CoreError::DomainError { domain: "channel".into(), code: Some("ECALLIDCONFLICT".into()), message: None, detail: None });
    // A tool the core does not host answers as the worker's dispatch does for any unknown name.
    let reply = svc.call(request("channel/call", json!({"name": "reply", "args": {}}), Some("op-2"))).await.unwrap();
    let Reply::Value(unknown) = reply else { panic!("not a value") };
    assert_eq!(unknown, json!({"content": [{"type": "text", "text": "unknown tool: reply"}], "isError": true}));
}

/// Node's boot check (`scheduleAutomationAutostart`, `channel-start.test.mjs` / `prewarm.channels.test.mjs`):
/// enabled automation starts the runtime on its own, nothing enabled starts nothing, and
/// `MIXDOG_DISABLE_CHANNEL_START` or a close in progress starts nothing either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_boot_check_starts_the_runtime_for_enabled_automation_without_an_admin_call() {
    let e = env().await;
    e.admin.schedule_automation_start();
    e.runtime.scheduled_start_settled().await;
    assert!(!e.runtime.automation_running(), "nothing is enabled");

    e.schedules.upsert(&Schedule { enabled: false, ..sched("off") }).await.unwrap();
    e.admin.schedule_automation_start();
    e.runtime.scheduled_start_settled().await;
    assert!(!e.runtime.automation_running(), "a disabled schedule is not automation");

    e.schedules.upsert(&sched("on")).await.unwrap();
    e.admin.schedule_automation_start();
    e.runtime.scheduled_start_settled().await;
    assert!(e.runtime.automation_running());
    assert_eq!(e.services.log.lock().unwrap().clone(), vec!["sync:false".to_string()]);
    assert_eq!(e.runtime.scheduler().status().iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["on"]);
    e.runtime.stop_owned_runtime("test").await.unwrap();

    let closed = env().await;
    closed.schedules.upsert(&sched("on")).await.unwrap();
    closed.closing.cancel();
    closed.admin.schedule_automation_start();
    closed.runtime.scheduled_start_settled().await;
    assert!(!closed.runtime.automation_running(), "a close in progress starts nothing");

    let hook = env().await;
    hook.webhooks.upsert(&EndpointRecord { name: "hook".into(), owner_agent_id: "lead".into(), enabled: true, ..Default::default() }).await.unwrap();
    hook.admin.schedule_automation_start();
    hook.runtime.scheduled_start_settled().await;
    assert!(hook.runtime.automation_running(), "an enabled webhook starts it too");
    hook.runtime.stop_owned_runtime("test").await.unwrap();

    let disabled = env_with(true).await;
    disabled.schedules.upsert(&sched("on")).await.unwrap();
    disabled.admin.schedule_automation_start();
    disabled.runtime.scheduled_start_settled().await;
    assert!(!disabled.runtime.automation_running(), "MIXDOG_DISABLE_CHANNEL_START");
    disabled.admin.save_schedule(&recurring("saved")).await.unwrap();
    disabled.runtime.scheduled_start_settled().await;
    assert!(!disabled.runtime.automation_running(), "a save does not start it either");
}

/// `ensureAutomationRuntime` → `scheduleChannelStart(0)`: the enabling call returns before the
/// start, which then runs on its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enabling_a_webhook_returns_before_the_start_and_the_start_follows() {
    let e = env().await;
    e.admin.save_webhook(&json!({"name": "gh", "instructions": "x", "enabled": false})).await.unwrap();
    e.runtime.scheduled_start_settled().await;
    assert!(!e.runtime.automation_running(), "a disabled webhook starts nothing");
    let init = Arc::new(tokio::sync::Semaphore::new(0));
    *e.agent.init_gate.lock().unwrap() = Some(init.clone());
    e.admin.set_webhook_enabled("gh", true).await.unwrap();
    assert!(!e.runtime.automation_running(), "the call returned while the start waits in the provider init");
    init.add_permits(1);
    e.runtime.scheduled_start_settled().await;
    assert!(e.runtime.automation_running());
    e.runtime.stop_owned_runtime("test").await.unwrap();
}

/// `onChannelStartTimer` asks `hasActiveAutomation` when the deferred callback runs, not when
/// the save scheduled it: a row disabled in between starts nothing. Reverting to an answer
/// taken at save time (or no question) starts the service here.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_active_automation_check_runs_when_the_deferred_start_runs() {
    let e = env().await;
    // The probe lists schedules first and waits on the owner check of this disabled row; the
    // webhooks it lists afterwards are read once it is released.
    e.schedules.upsert(&Schedule { enabled: false, ..sched("off") }).await.unwrap();
    let listing = Arc::new(tokio::sync::Semaphore::new(0));
    *e.host.listing_gate.lock().unwrap() = Some(listing.clone());
    e.admin.save_webhook(&json!({"name": "gh", "instructions": "x"})).await.unwrap();
    signal(&e.host.listing_entered, "the active check is inside the listing").await;
    e.admin.set_webhook_enabled("gh", false).await.unwrap();
    listing.add_permits(8);
    e.runtime.scheduled_start_settled().await;
    assert!(!e.runtime.automation_running(), "nothing was enabled when the deferred start asked");
    assert!(!e.services.log.lock().unwrap().contains(&"sync:false".to_string()));
    assert_eq!(e.agent.inits.load(Ordering::SeqCst), 0, "no provider init for a start that is not made");
}

/// A shutdown while the deferred start waits on `hasActiveAutomation` (a stuck read) ends it and
/// waits for it: the start is neither left running nor made after the teardown.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_ends_a_deferred_start_waiting_on_the_active_automation_check() {
    let e = env().await;
    e.schedules.upsert(&sched("on")).await.unwrap();
    *e.host.listing_gate.lock().unwrap() = Some(Arc::new(tokio::sync::Semaphore::new(0)));
    e.admin.schedule_automation_start();
    signal(&e.host.listing_entered, "the active check is inside the listing").await;
    mixdog_rt::time::timeout(Duration::from_secs(10), e.runtime.shutdown_scheduled_start()).await.expect("the shutdown joins the stuck start");
    assert!(!e.runtime.automation_running());
    assert!(e.services.log.lock().unwrap().is_empty());
    assert_eq!(e.agent.inits.load(Ordering::SeqCst), 0);
    e.admin.schedule_automation_start();
    e.runtime.scheduled_start_settled().await;
    assert_eq!(e.agent.inits.load(Ordering::SeqCst), 0, "nothing is scheduled after the shutdown");
}

/// Node's `saveSchedule` readback (`channel-admin.mjs:324`, `scheduler.mjs:310-312`): `nextFireAt`
/// is the row's own (`whenAt` for a one-shot, none for a cron) until the deferred start arms the
/// scheduler, which stamps the cron's next fire only afterwards. A save that returned while the
/// start still waits in the provider init reads back without it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_schedule_read_back_before_the_deferred_start_has_no_scheduler_stamped_next_fire() {
    let e = env().await;
    let init = Arc::new(tokio::sync::Semaphore::new(0));
    *e.agent.init_gate.lock().unwrap() = Some(init.clone());
    let cron = e.admin.save_schedule(&recurring("cron")).await.unwrap();
    let once = e.admin.save_schedule(&json!({"name": "once", "at": "2031-05-06T07:08:09Z", "instructions": "x"})).await.unwrap();
    assert!(cron.get("nextFireAt").is_none(), "{cron}");
    assert_eq!(once["nextFireAt"], "2031-05-06T07:08:09.000Z");
    let listed = e.admin.list_schedules().await.unwrap();
    assert!(listed.iter().find(|r| r["name"] == "cron").unwrap().get("nextFireAt").is_none(), "the start has not armed the scheduler");
    init.add_permits(1);
    e.runtime.scheduled_start_settled().await;
    e.runtime.stop_owned_runtime("test").await.unwrap();
}
/// The same for a start stuck in the provider init, which `stop_owned_runtime` alone would leave
/// (nothing is running yet, so it returns early): the shutdown cancels and joins it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_ends_a_deferred_start_stuck_in_the_provider_init() {
    let e = env().await;
    e.schedules.upsert(&sched("on")).await.unwrap();
    *e.agent.init_gate.lock().unwrap() = Some(Arc::new(tokio::sync::Semaphore::new(0)));
    e.admin.schedule_automation_start();
    signal(&e.agent.entered, "the start is inside the provider init").await;
    mixdog_rt::time::timeout(Duration::from_secs(10), e.runtime.shutdown_scheduled_start()).await.expect("the shutdown joins the stuck start");
    e.runtime.stop_owned_runtime("test").await.unwrap();
    assert!(!e.runtime.automation_running());
    assert!(e.services.log.lock().unwrap().is_empty(), "nothing synced after the shutdown");
}
/// What the daemon wires around the webhook server: a loopback listener (ephemeral port) that
/// starts the relay tunnel once it is bound.
struct LoopbackServer {
    service: Arc<WebhookService>,
    tunnels: Arc<dyn TunnelStarter>,
    server: tokio::sync::Mutex<Option<WebhookServer>>,
    /// Notified once the receiver is bound and its tunnel started (the relay identity is persisted).
    bound: tokio::sync::Notify,
    /// Notified once a stop has closed the receiver.
    stopped: tokio::sync::Notify,
    /// The save's reload held as [`LateReloads`] holds it, when the test holds it.
    reloads: Option<Arc<LateReloads>>,
    /// The bind let a held reload go: that reload's restart is the next start.
    restarting: std::sync::atomic::AtomicBool,
}

impl LoopbackServer {
    fn new(service: Arc<WebhookService>, tunnels: Arc<dyn TunnelStarter>, reloads: Option<Arc<LateReloads>>) -> Self {
        Self { service, tunnels, server: tokio::sync::Mutex::new(None), bound: Default::default(), stopped: Default::default(), reloads, restarting: Default::default() }
    }

    async fn listening(&self) -> bool {
        self.server.lock().await.is_some()
    }
}

#[async_trait]
impl WebhookListener for LoopbackServer {
    async fn start(&self, _: &WebhookSettings) -> Result<(), String> {
        if self.restarting.load(Ordering::SeqCst) {
            // The late reload's restart (`syncWebhookAndEventRuntime({ reload: true })`) has stopped
            // the receiver the start bound; the bind is announced now, with the receiver down, and
            // the restart binds no more: the readback falls inside the restart.
            self.bound.notify_one();
            return std::future::pending().await;
        }
        let mut server = WebhookServer::new(self.service.clone(), self.tunnels.clone(), 0);
        server.start().await?;
        let replaced = self.server.lock().await.replace(server);
        if let Some(mut old) = replaced {
            old.stop().await;
        }
        if self.reloads.as_ref().is_some_and(|reloads| reloads.release_late()) {
            self.restarting.store(true, Ordering::SeqCst);
        } else {
            self.bound.notify_one();
        }
        Ok(())
    }
    async fn stop(&self) -> Result<(), String> {
        let server = self.server.lock().await.take();
        if let Some(mut server) = server {
            server.stop().await;
        }
        self.stopped.notify_one();
        Ok(())
    }
}

/// The runtime's schedule records with the save's background reload (`reload_soon`) made as late as
/// a busy machine may run it: a read made before the provider init is released is the reload's
/// (the start reads after the init), and it goes on only once the test waits for that reload, as
/// Node's recorder awaits `lastReload` (`record-schedule-save-start.mjs:176`, `:203`), or else once
/// the start's receiver has bound, where the reload finds the runtime up and restarts the receiver.
struct LateReloads {
    inner: Arc<StateScheduleStore>,
    init_released: std::sync::atomic::AtomicBool,
    /// Notified when a read is held.
    arrived: tokio::sync::Notify,
    /// The held reads go on.
    open: tokio::sync::watch::Sender<bool>,
}

impl LateReloads {
    fn new(inner: Arc<StateScheduleStore>) -> Arc<Self> {
        Arc::new(Self { inner, init_released: Default::default(), arrived: Default::default(), open: tokio::sync::watch::Sender::new(false) })
    }

    /// Lets the held reload go at the start's bind; true when it was still held there.
    fn release_late(&self) -> bool {
        self.open.send_if_modified(|open| !std::mem::replace(open, true))
    }
}

#[async_trait]
impl ScheduleStore for LateReloads {
    async fn get(&self, name: &str) -> Result<Option<Schedule>, ScheduleError> {
        self.inner.get(name).await
    }
    async fn list(&self) -> Result<Vec<Schedule>, ScheduleError> {
        if !self.init_released.load(Ordering::SeqCst) {
            self.arrived.notify_one();
            self.open.subscribe().wait_for(|open| *open).await.expect("the gate lives as long as the store");
        }
        self.inner.list().await
    }
    async fn mark_fired(&self, name: &str, at: chrono::DateTime<chrono::Utc>) -> Result<(), ScheduleError> {
        self.inner.mark_fired(name, at).await
    }
    async fn set_next_fire(&self, name: &str, at: Option<chrono::DateTime<chrono::Utc>>) -> Result<(), ScheduleError> {
        self.inner.set_next_fire(name, at).await
    }
    async fn advance_cursor(&self, name: &str, s: chrono::DateTime<chrono::Utc>, next: Option<chrono::DateTime<chrono::Utc>>) -> Result<bool, ScheduleError> {
        self.inner.advance_cursor(name, s, next).await
    }
    async fn claim_run(&self, name: &str, s: chrono::DateTime<chrono::Utc>, started: chrono::DateTime<chrono::Utc>, next: Option<chrono::DateTime<chrono::Utc>>) -> Result<bool, ScheduleError> {
        self.inner.claim_run(name, s, started, next).await
    }
    async fn mark_success(&self, name: &str, at: chrono::DateTime<chrono::Utc>) -> Result<(), ScheduleError> {
        self.inner.mark_success(name, at).await
    }
    async fn mark_failure(&self, name: &str, at: chrono::DateTime<chrono::Utc>) -> Result<(), ScheduleError> {
        self.inner.mark_failure(name, at).await
    }
    async fn mark_skipped(&self, name: &str, at: chrono::DateTime<chrono::Utc>) -> Result<(), ScheduleError> {
        self.inner.mark_skipped(name, at).await
    }
    async fn mark_done(&self, name: &str) -> Result<(), ScheduleError> {
        self.inner.mark_done(name).await
    }
    async fn set_deferred(&self, name: &str, until: Option<chrono::DateTime<chrono::Utc>>) -> Result<(), ScheduleError> {
        self.inner.set_deferred(name, until).await
    }
    async fn set_skipped_until(&self, name: &str, until: Option<chrono::DateTime<chrono::Utc>>) -> Result<(), ScheduleError> {
        self.inner.set_skipped_until(name, until).await
    }
}

#[async_trait]
impl ScheduleRecords for LateReloads {
    async fn upsert(&self, def: &Schedule) -> Result<Schedule, ScheduleError> {
        self.inner.upsert(def).await
    }
    async fn rename(&self, old: &str, def: &Schedule, timing_changed: bool) -> Result<Option<Schedule>, ScheduleError> {
        self.inner.rename(old, def, timing_changed).await
    }
    async fn delete(&self, name: &str) -> Result<bool, ScheduleError> {
        self.inner.delete(name).await
    }
    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<Option<Schedule>, ScheduleError> {
        self.inner.set_enabled(name, enabled).await
    }
    async fn record_delivery(&self, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), ScheduleError> {
        self.inner.record_delivery(name, run_id, entry).await
    }
}

/// `readHookPublicBase()`: the base of the identity file, `None` until a tunnel wrote one.
struct IdentityFileBase {
    data_dir: std::path::PathBuf,
    relay: String,
}

#[async_trait]
impl PublicBase for IdentityFileBase {
    async fn hook_public_base(&self) -> Result<Option<String>, String> {
        let Ok(bytes) = tokio::fs::read(self.data_dir.join("relay-hook-device.json")).await else { return Ok(None) };
        let identity: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        hook_public_base(&self.relay, identity["deviceId"].as_str().unwrap_or_default()).map(Some)
    }
}

/// The saved webhook's public URL: the relay identity is created lazily by the tunnel start
/// (`startHookTunnel` → `loadOrCreateHookIdentity`), which runs after the save has returned, so
/// the URL shows once that start has finished (the desktop shows `publicUrl` as the endpoint
/// URL). Real receiver, relay tunnel and data directory; the relay is a loopback port nobody
/// listens on, so the leg only logs and retries.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saving_a_webhook_leaves_the_hook_identity_and_the_setup_shows_the_public_url() {
    let e = env().await;
    let data = tempfile::tempdir().unwrap();
    let relay = "ws://127.0.0.1:9";
    let service = Arc::new(WebhookService::new(
        e.webhooks.clone(),
        Arc::new(HomeWebhookDispatch::new(e.routines.clone(), e.webhooks.clone(), None, e.work.clone())),
        WebhookConfig::default(),
        e.work.clone(),
        Arc::new(|| 0),
    ));
    let tunnels = Arc::new(RelayTunnelStarter::new(tokens().durability_io, data.path().to_path_buf(), Some(relay.into())));
    let listener = Arc::new(LoopbackServer::new(service.clone(), tunnels, None));
    let automation = Arc::new(WebhookAutomation::new(e.settings.clone(), service, listener));
    let scheduler = Scheduler::new(e.schedules.clone(), Arc::new(HomeScheduleRunner::new(e.routines.clone())), Arc::new(SystemClock), e.work.clone(), Tz::UTC, Vec::new());
    let runtime = ChannelRuntime::new(scheduler, e.schedules.clone(), automation, e.agent.clone());
    let admin = ChannelAdmin::new(AdminDeps {
        schedules: e.schedules.clone(),
        webhooks: e.webhooks.clone(),
        routines: e.routines.clone(),
        runtime: runtime.clone(),
        settings: e.settings.clone(),
        base: Arc::new(IdentityFileBase { data_dir: data.path().to_path_buf(), relay: relay.into() }),
        probe: e.probe.clone(),
        clock: Arc::new(SystemClock),
        local_tz: Tz::UTC,
        channel_start_disabled: false,
        close_requested: CancellationToken::new(),
    });

    assert_eq!(admin.get_channel_setup().await.unwrap()["webhook"]["publicUrl"], Value::Null, "a read creates no identity");
    let init = Arc::new(tokio::sync::Semaphore::new(0));
    *e.agent.init_gate.lock().unwrap() = Some(init.clone());
    admin.save_webhook(&json!({"name": "gh", "instructions": "x"})).await.unwrap();
    assert!(!data.path().join("relay-hook-device.json").exists(), "the save created no identity before it replied");
    init.add_permits(1);
    runtime.scheduled_start_settled().await;
    let stored: Value = serde_json::from_slice(&tokio::fs::read(data.path().join("relay-hook-device.json")).await.unwrap()).unwrap();
    let id = stored["deviceId"].as_str().unwrap();
    assert_eq!(admin.get_channel_setup().await.unwrap()["webhook"]["publicUrl"], format!("http://127.0.0.1:9/hook/{id}"));
    runtime.stop_owned_runtime("test").await.unwrap();
}

/// The schedule store of the scheduler with its next-fire write held until a permit is given: the
/// boundary "stamp write pending" of Node's unawaited `setNextFire` (`scheduler.mjs:311`).
struct GatedStamps {
    inner: Arc<StateScheduleStore>,
    gate: Arc<tokio::sync::Semaphore>,
    /// Notified once a held write has been persisted.
    persisted: Arc<tokio::sync::Notify>,
}

/// The scheduler's clock, set by the test: the replay drives Rust with the instant Node armed at.
struct FixedClock(std::sync::atomic::AtomicI64);

impl FixedClock {
    fn set(&self, at: chrono::DateTime<chrono::Utc>) {
        self.0.store(at.timestamp_millis(), Ordering::SeqCst);
    }
}

impl crate::scheduler::Clock for FixedClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp_millis(self.0.load(Ordering::SeqCst)).unwrap()
    }
}

#[async_trait]
impl ScheduleStore for GatedStamps {
    async fn get(&self, name: &str) -> Result<Option<Schedule>, ScheduleError> {
        self.inner.get(name).await
    }
    async fn list(&self) -> Result<Vec<Schedule>, ScheduleError> {
        self.inner.list().await
    }
    async fn mark_fired(&self, name: &str, at: chrono::DateTime<chrono::Utc>) -> Result<(), ScheduleError> {
        self.inner.mark_fired(name, at).await
    }
    async fn set_next_fire(&self, name: &str, at: Option<chrono::DateTime<chrono::Utc>>) -> Result<(), ScheduleError> {
        self.gate.acquire().await.expect("the gate stays open").forget();
        let written = self.inner.set_next_fire(name, at).await;
        self.persisted.notify_one();
        written
    }
    async fn advance_cursor(&self, name: &str, s: chrono::DateTime<chrono::Utc>, next: Option<chrono::DateTime<chrono::Utc>>) -> Result<bool, ScheduleError> {
        self.inner.advance_cursor(name, s, next).await
    }
    async fn claim_run(&self, name: &str, s: chrono::DateTime<chrono::Utc>, started: chrono::DateTime<chrono::Utc>, next: Option<chrono::DateTime<chrono::Utc>>) -> Result<bool, ScheduleError> {
        self.inner.claim_run(name, s, started, next).await
    }
    async fn mark_success(&self, name: &str, at: chrono::DateTime<chrono::Utc>) -> Result<(), ScheduleError> {
        self.inner.mark_success(name, at).await
    }
    async fn mark_failure(&self, name: &str, at: chrono::DateTime<chrono::Utc>) -> Result<(), ScheduleError> {
        self.inner.mark_failure(name, at).await
    }
    async fn mark_skipped(&self, name: &str, at: chrono::DateTime<chrono::Utc>) -> Result<(), ScheduleError> {
        self.inner.mark_skipped(name, at).await
    }
    async fn mark_done(&self, name: &str) -> Result<(), ScheduleError> {
        self.inner.mark_done(name).await
    }
    async fn set_deferred(&self, name: &str, until: Option<chrono::DateTime<chrono::Utc>>) -> Result<(), ScheduleError> {
        self.inner.set_deferred(name, until).await
    }
    async fn set_skipped_until(&self, name: &str, until: Option<chrono::DateTime<chrono::Utc>>) -> Result<(), ScheduleError> {
        self.inner.set_skipped_until(name, until).await
    }
}

/// A readback with the generated parts normalised the same way on both sides: the relay base and
/// the device id of the public URL (their structure is checked, not copied).
fn normalise_setup(mut setup: Value, relay_base: &str) -> Value {
    if let Some(url) = setup["webhook"]["publicUrl"].as_str() {
        let id = url.strip_prefix(&format!("{relay_base}/hook/")).unwrap_or_else(|| panic!("public url {url} is not {relay_base}/hook/<id>"));
        assert!(id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'), "device id {id}");
        setup["webhook"]["publicUrl"] = json!("<relay>/hook/<id>");
    }
    setup
}

/// The real stack of a webhook-and-schedule save: webhook server, relay tunnel starter, identity
/// file and the scheduler over a store whose next-fire write is held until a permit is given (the
/// boundary "stamp write pending" of Node's unawaited `setNextFire`, `scheduler.mjs:311`).
struct Rig {
    e: Env,
    admin: Arc<ChannelAdmin>,
    runtime: Arc<ChannelRuntime>,
    data: tempfile::TempDir,
    init: Arc<tokio::sync::Semaphore>,
    stamps: Arc<tokio::sync::Semaphore>,
    stamped: Arc<tokio::sync::Notify>,
    listener: Arc<LoopbackServer>,
    /// The scheduler's `now`.
    clock: Arc<FixedClock>,
    /// The save's reload, held until awaited ([`LateReloads`]), when the rig holds it.
    reloads: Option<Arc<LateReloads>>,
}

async fn rig() -> Rig {
    rig_with(false).await
}

/// The rig with the save's background reload held as late as [`LateReloads`] holds it.
async fn rig_holding_the_reload() -> Rig {
    rig_with(true).await
}

async fn rig_with(hold_reload: bool) -> Rig {
    let e = env().await;
    // The recording's webhook port (the loopback listener binds an ephemeral one regardless).
    e.settings.webhook.lock().unwrap().port = json!(47311);
    let data = tempfile::tempdir().unwrap();
    let relay = "ws://127.0.0.1:9";
    let service = Arc::new(WebhookService::new(
        e.webhooks.clone(),
        Arc::new(HomeWebhookDispatch::new(e.routines.clone(), e.webhooks.clone(), None, e.work.clone())),
        WebhookConfig::default(),
        e.work.clone(),
        Arc::new(|| 0),
    ));
    let tunnels = Arc::new(RelayTunnelStarter::new(tokens().durability_io, data.path().to_path_buf(), Some(relay.into())));
    let reloads = hold_reload.then(|| LateReloads::new(e.schedules.clone()));
    let listener = Arc::new(LoopbackServer::new(service.clone(), tunnels, reloads.clone()));
    let automation = Arc::new(WebhookAutomation::new(e.settings.clone(), service, listener.clone()));
    let stamps = Arc::new(tokio::sync::Semaphore::new(0));
    let stamped = Arc::new(tokio::sync::Notify::new());
    let store = Arc::new(GatedStamps { inner: e.schedules.clone(), gate: stamps.clone(), persisted: stamped.clone() });
    let clock = Arc::new(FixedClock(std::sync::atomic::AtomicI64::new(chrono::Utc::now().timestamp_millis())));
    let scheduler = Scheduler::new(store, Arc::new(HomeScheduleRunner::new(e.routines.clone())), clock.clone(), e.work.clone(), Tz::UTC, Vec::new());
    let records: Arc<dyn ScheduleRecords> = match &reloads {
        Some(reloads) => reloads.clone(),
        None => e.schedules.clone(),
    };
    let runtime = ChannelRuntime::new(scheduler, records, automation, e.agent.clone());
    let admin = ChannelAdmin::new(AdminDeps {
        schedules: e.schedules.clone(),
        webhooks: e.webhooks.clone(),
        routines: e.routines.clone(),
        runtime: runtime.clone(),
        settings: e.settings.clone(),
        base: Arc::new(IdentityFileBase { data_dir: data.path().to_path_buf(), relay: relay.into() }),
        probe: e.probe.clone(),
        clock: Arc::new(SystemClock),
        local_tz: Tz::UTC,
        channel_start_disabled: false,
        close_requested: CancellationToken::new(),
    });
    let init = Arc::new(tokio::sync::Semaphore::new(0));
    *e.agent.init_gate.lock().unwrap() = Some(init.clone());
    Rig { e, admin, runtime, data, init, stamps, stamped, listener, clock, reloads }
}

impl Rig {
    fn identity_file(&self) -> bool {
        self.data.path().join("relay-hook-device.json").exists()
    }

    /// The start is inside the provider init.
    async fn wait_for_init_entered(&self) {
        signal(&self.e.agent.entered, "the start reaches the provider init").await;
    }

    /// The receiver is bound and its tunnel started: the relay identity is persisted.
    async fn wait_for_bound(&self) {
        signal(&self.listener.bound, "the receiver binds").await;
    }

    /// The held next-fire write is persisted.
    async fn wait_for_stamp(&self) {
        signal(&self.stamped, "the next-fire stamp is persisted").await;
    }

    /// The save's background reload has run (Node's recorder awaits `lastReload`): with the runtime
    /// not up yet it tears the receiver down (`reloadRuntimeConfig` → `stopWebhookAndEventRuntime`,
    /// config-reload.mjs:35-39), its last step.
    async fn wait_for_reload(&self) {
        let reloads = self.reloads.as_ref().expect("the rig holds the reload");
        reloads.open.send_replace(true);
        signal(&self.listener.stopped, "the save's reload tears the receiver down").await;
    }

    /// Releases the provider init. A held reload has read the stores by then, so the read the
    /// start makes after the init is the start's.
    async fn release_init(&self) {
        if let Some(reloads) = &self.reloads {
            signal(&reloads.arrived, "the save's reload reads the stores").await;
            reloads.init_released.store(true, Ordering::SeqCst);
        }
        self.init.add_permits(1);
    }

    /// The scheduler arms at the instant Node armed at (the recording's release of the provider init).
    fn arm_at_recorded_release(&self, rec: &Value) {
        self.clock.set(chrono::DateTime::from_timestamp_millis(rec["releasedAt"].as_i64().unwrap()).unwrap());
    }
}

const SCHEDULE_ENTRY: &str = r#"{"name": "harness-schedule", "description": "A schedule", "time": "0 9 * * *", "timezone": "Asia/Seoul", "instructions": "Say hello."}"#;

/// The recording of Node b6f10295a (`native/core/fixtures/schedule-save-start/golden.json`, written by
/// `benchmarks/rust-core/recorders/record-schedule-save-start.mjs` from an exact export through
/// `createChannelConfigApi` and the real owned-runtime start, in an isolated data directory).
fn recorded(scenario: &str) -> Value {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/schedule-save-start/golden.json")).unwrap();
    golden["scenarios"][scenario].clone()
}

fn recorded_step(rec: &Value, label: &str) -> Value {
    rec["steps"].as_array().unwrap().iter().find(|s| s["label"] == label).unwrap_or_else(|| panic!("no recorded step {label}")).clone()
}

/// Compares the observable state with a recorded step in full: the readback (the generated relay id
/// replaced by a marker on both sides after its structure is checked; `nextFireAt` is Rust's own),
/// the identity file, and whether the receiver listens. `attached` is true in every recorded step
/// (the core runs in-process, so it is always attached). `virtualTimers` counts the recorder's held
/// `channel-start.mjs` timers, a second route into the same start (`invokeChannelStart` returns the
/// start in flight and `channels.start` is a no-op once attached); Rust has one route and no timer.
async fn assert_step(rig: &Rig, setup: Value, rec: &Value, label: &str) {
    let step = recorded_step(rec, label);
    let base = rec["relayBase"].as_str().unwrap_or("http://127.0.0.1:9");
    assert_eq!(normalise_setup(setup, "http://127.0.0.1:9"), normalise_setup(step["setup"].clone(), base), "readback at {label}");
    assert_eq!(rig.identity_file(), step["identityFile"], "identity file at {label}");
    assert_eq!(rig.listener.listening().await, step["listening"], "listening at {label}");
    assert_eq!(step["attached"], true, "attached at {label}");
}

/// `saveSchedule` → reload → deferred start: the readbacks at Node's boundaries (start pending;
/// listener bound with the identity persisted while the next-fire write is pending; the write
/// done). Rust gets to each boundary through the real mechanisms: the provider init gate, the
/// real receiver and relay starter, and the gated store. The save's background reload is held
/// until the test awaits it before the init is released, as Node's recorder does: a reload that
/// lands after the start is up restarts the receiver, Node's as Rust's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_schedule_save_reads_back_as_node_does_at_each_boundary_of_the_start() {
    let rec = recorded("start-after-save");
    let rig = rig_holding_the_reload().await;
    let saved = rig.admin.save_schedule(&serde_json::from_str(SCHEDULE_ENTRY).unwrap()).await.unwrap();
    assert_eq!(saved, rec["saveReply"]);
    rig.wait_for_init_entered().await;
    assert_step(&rig, rig.admin.get_channel_setup().await.unwrap(), &rec, "start-pending").await;

    rig.wait_for_reload().await;
    rig.arm_at_recorded_release(&rec);
    rig.release_init().await;
    rig.wait_for_bound().await;
    assert_step(&rig, rig.admin.get_channel_setup().await.unwrap(), &rec, "identity-persisted-stamp-pending").await;

    rig.stamps.add_permits(1);
    rig.wait_for_stamp().await;
    assert_step(&rig, rig.admin.get_channel_setup().await.unwrap(), &rec, "stamp-persisted").await;
    rig.runtime.scheduled_start_settled().await;
    rig.runtime.stop_owned_runtime("test").await.unwrap();
}

/// A stop issued while the start is inside the provider init (`owned-stop.mjs`: the stop awaits
/// `automationStartPromise`, then the start sees the stop and arms nothing). Rust matches: the stop
/// does not settle while the init is held (the recorded `stopSettledWhileInit`), and once the init
/// ends the state is the recorded one: not running, no listener, no identity, no stamp, the same
/// readbacks, and nothing synced.
#[tokio::test(flavor = "current_thread")]
async fn a_stop_during_the_provider_init_ends_in_the_state_node_left() {
    let rec = recorded("stop-during-provider-init");
    let rig = rig().await;
    let saved = rig.admin.save_schedule(&serde_json::from_str(SCHEDULE_ENTRY).unwrap()).await.unwrap();
    assert_eq!(saved, rec["saveReply"]);
    rig.wait_for_init_entered().await;

    // The init gate is observed entered above. The stop is polled by hand: it runs to its first
    // suspension, having marked the start for abort and queued behind it on the start gate that the
    // start, held in the provider init, still owns. Node's stop does not settle here either.
    let runtime = rig.runtime.clone();
    let mut stop = Box::pin(async move { runtime.stop_owned_runtime("test").await });
    let first = std::future::poll_fn(|cx| std::task::Poll::Ready(stop.as_mut().poll(cx))).await;
    assert_eq!(first.is_pending(), !rec["stopSettledWhileInit"].as_bool().unwrap(), "the stop settles while the init is held only if Node's did");
    assert_step(&rig, rig.admin.get_channel_setup().await.unwrap(), &rec, "stop-issued-start-pending").await;

    // Releasing the gate lets the init finish: a stop that had cancelled it would drop the init
    // before it returns, so `init_finished` would stay 0.
    rig.init.add_permits(1);
    stop.await.unwrap();
    assert_eq!(rig.e.agent.init_finished.load(Ordering::SeqCst), 1, "the stop awaited the init instead of cancelling it");
    rig.runtime.scheduled_start_settled().await;
    assert!(!rig.runtime.status().running && !rig.runtime.automation_running());
    assert_step(&rig, rig.admin.get_channel_setup().await.unwrap(), &rec, "after-stop").await;
}

/// A save that lands while a start (made before the schedule existed) is still in the provider init:
/// Node's start arms the saved schedule once released and the readbacks follow the same boundaries.
/// Rust lists the stores at the start (not a config loaded earlier) and ends the same: the schedule
/// is armed, the stamp pending, then persisted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_between_the_config_load_and_the_start_is_armed_as_in_node() {
    let rec = recorded("save-during-provider-init");
    let rig = rig_holding_the_reload().await;
    let runtime = rig.runtime.clone();
    let daemon_start = tokio::spawn(async move { runtime.start_automation().await });
    rig.wait_for_init_entered().await;
    let saved = rig.admin.save_schedule(&serde_json::from_str(SCHEDULE_ENTRY).unwrap()).await.unwrap();
    assert_eq!(saved, rec["saveReply"]);
    rig.wait_for_reload().await;
    assert_step(&rig, rig.admin.get_channel_setup().await.unwrap(), &rec, "saved-start-pending").await;

    rig.arm_at_recorded_release(&rec);
    rig.release_init().await;
    rig.wait_for_bound().await;
    assert_step(&rig, rig.admin.get_channel_setup().await.unwrap(), &rec, "started-stamp-pending").await;

    rig.stamps.add_permits(1);
    rig.wait_for_stamp().await;
    assert_step(&rig, rig.admin.get_channel_setup().await.unwrap(), &rec, "stamp-persisted").await;
    daemon_start.await.unwrap().unwrap();
    rig.runtime.scheduled_start_settled().await;
    rig.runtime.stop_owned_runtime("test").await.unwrap();
}

/// `channel-start.mjs:50-56`: a save's deferred start parks while a turn runs or a session is being
/// created, and runs once the busy state clears and wakes it; the boot autostart
/// (`channel-start.mjs:75-95`) does not look at the busy state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_runtime_parks_the_saved_schedules_start_until_it_is_woken_idle() {
    let e = env().await;
    let busy = Arc::new(std::sync::atomic::AtomicBool::new(true));
    // The start asks the busy state before every attempt: each answer is a signal, so "the start has
    // looked and parked" is an ordering the test waits on, not a time.
    let asked = Arc::new(tokio::sync::Notify::new());
    e.admin.bind_busy({
        let (busy, asked) = (busy.clone(), asked.clone());
        Arc::new(move || {
            asked.notify_one();
            busy.load(Ordering::SeqCst).then_some("turn-active")
        })
    });
    e.admin.save_schedule(&recurring("a")).await.unwrap();
    signal(&asked, "the start asks whether a turn runs").await;
    assert_eq!(e.agent.inits.load(Ordering::SeqCst), 0, "parked while a turn runs");
    e.admin.wake_deferred_start();
    signal(&asked, "the woken start asks again").await;
    assert_eq!(e.agent.inits.load(Ordering::SeqCst), 0, "a wake while still busy parks it again");
    busy.store(false, Ordering::SeqCst);
    e.admin.wake_deferred_start();
    e.runtime.scheduled_start_settled().await;
    assert_eq!(e.agent.inits.load(Ordering::SeqCst), 1, "started once idle");
    assert!(e.runtime.automation_running());
    e.runtime.stop_owned_runtime("test").await.unwrap();

    // A real running turn (the session runtime's liveness map, as the daemon's `busy_reason` reads it).
    let live = crate::task_reports::runtime_state::RuntimeLiveness::new();
    let real = env().await;
    let real_asked = Arc::new(tokio::sync::Notify::new());
    real.admin.bind_busy({
        let (live, asked) = (live.clone(), real_asked.clone());
        Arc::new(move || {
            asked.notify_one();
            (!live.in_flight_session_activity().working.is_empty()).then_some("turn-active")
        })
    });
    let turn = live.dispatched("lead-session");
    real.admin.save_schedule(&recurring("a")).await.unwrap();
    signal(&real_asked, "the start asks whether a turn runs").await;
    assert_eq!(real.agent.inits.load(Ordering::SeqCst), 0, "a running turn parks the save's start");
    drop(turn);
    real.admin.wake_deferred_start();
    real.runtime.scheduled_start_settled().await;
    assert_eq!(real.agent.inits.load(Ordering::SeqCst), 1, "the turn ended: the start ran");
    real.runtime.stop_owned_runtime("test").await.unwrap();

    let autostart = env().await;
    autostart.admin.bind_busy(Arc::new(|| Some("session-create")));
    autostart.schedules.upsert(&sched("a")).await.unwrap();
    autostart.admin.schedule_automation_autostart();
    autostart.runtime.scheduled_start_settled().await;
    assert_eq!(autostart.agent.inits.load(Ordering::SeqCst), 1, "the boot autostart ignores the busy state");
    autostart.runtime.stop_owned_runtime("test").await.unwrap();
}

/// `automation-start.mjs:30-42`: the runtime counts as running as soon as the webhook sync is launched
/// (Node's `syncWebhookAndEventRuntime()` is synchronous), not when the listener has bound.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_runtime_is_running_as_soon_as_the_sync_is_launched() {
    let e = env().await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *e.services.sync_gate.lock().unwrap() = Some(gate.clone());
    let runtime = e.runtime.clone();
    let start = tokio::spawn(async move { runtime.start_automation().await });
    signal(&e.services.entered, "the sync is entered").await;
    assert!(e.runtime.automation_running() && e.runtime.status().running, "running while the sync is pending");
    assert!(!start.is_finished());
    gate.add_permits(1);
    start.await.unwrap().unwrap();
    e.runtime.stop_owned_runtime("test").await.unwrap();
}
