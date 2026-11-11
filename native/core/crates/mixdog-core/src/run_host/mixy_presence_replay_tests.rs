//! Replay of `native/core/fixtures/mixy-presence-cases` (`record-mixy-presence-cases.mjs`, Node's
//! `apps/desktop/src/main/mixy-presence.test.mjs`, issue #243): one answer to "does Mixy exist" from
//! every reader. Each case writes the Node profile the recorder wrote (`agents/lead/agent.json`,
//! `sessions/sess_home_lead.json`, `bots/migration.json`), imports it through the 1.4.5 migration
//! (`mixdog-migrate`), and asks the core's readers over the imported store:
//! - `heartbeat`: a first tick of the daemon's heartbeat ([`production_heartbeat`]) over a fresh
//!   state file, the config's heartbeat on (Node's `isEnabled: true`), her presence from [`DefinitionAgents`];
//! - `routines`: [`SessionRoutineHost::owner_problem`] of the ownerless owner (`routineOwnerProblem('')`);
//! - `reports`: a heartbeat report queued for her home ([`RoutineResultQueue::add`]), drained as the
//!   daemon drains every home with work owed ([`AgentHomeDelivery::recover`], which finds the home
//!   through `pending_homes`) over the production [`DefinitionsDirectory`] (her thread not loaded, as
//!   Node's `loadSession: () => null`), then the queue's items;
//! - `desktop`: `agent/getLeadStatus` of [`DesktopLeadStatus`], the method the window asks (it decides
//!   `created` once, as `resolveMixyCreated`), its `created`;
//! - `status`: the runtime route the desktop reads under it (`withMixyExists`): [`AgentDefinitions::lead_status`]
//!   with `exists` from [`AgentDefinitions::mixy_exists`].
//!
//! Node's schedule and webhook row stores were in-memory rows in the recording; here they are the
//! same rows behind [`RoutineRecords`]. "The user wrote to her" is her thread's user turn. The
//! comparison is whole, but for `profileFilesAfter` (Node's per-check state file names, declared in the
//! manifest).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use mixdog_core_agents::agents::{AgentDefinitions, AgentEffects, AgentHomeSessions, DesktopLeadStatus, LeadAppearance, LeadService, OwnedRoutines};
use mixdog_core_api::call::{CallContext, CoreRequest};
use mixdog_core_api::domain::ext::{DocumentText, ExtError, PdfIntake};
use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_api::ids::{ConnectionId, Method, OpId, ThreadId};
use mixdog_core_api::{DomainService, Reply, ThreadHandle};
use mixdog_core_config::config::{AgentRoutes, Config, ConfigLanes, NoEffects, Settings};
use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_session::session::agent_evidence::SessionAgentEvidence;
use mixdog_core_session::session::search_backfill::StoredSearchSessions;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_core_session::session::{SessionDirectory, SessionLanes, StoreThreads};
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::{MigrateOptions, Migrator, product_drivers};
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_rt::{CancellationToken, LaneToken};
use mixdog_services::bots::beat::{CatalogPage, HeartbeatStore, HeldRequests, SessionCatalog, UserActivity};
use mixdog_services::bots::delivery::env::{DeliveryConfig, HomeThreads, LiveSlot, RetryTimer, RoomRelay, ThreadSnapshot, WakeFollow};
use mixdog_services::bots::delivery::home::AgentHomeDelivery;
use mixdog_services::bots::delivery::queue::{AddOptions, HOME_QUEUE_LIMIT, Handoffs, QUEUE_CAPS, RoutineResultQueue};
use mixdog_services::bots::ids::schedule_owner_agent_id;
use mixdog_services::bots::live::{LiveSurface, WakeOptions, WakeTurn};
use mixdog_services::bots::state_json::StateJson;
use mixdog_services::bots::{
    AnnouncedRun, DeliveryItem, ExecutorRun, HeartbeatSessions, RoutineHost, RoutineKind, RoutineRecords, RoutineRuntime, RoutineState, RoutineTurn, TurnSettle, WakeHost,
};
use mixdog_services::scheduler::Clock;
use mixdog_services::webhooks::RunStamp;
use mixdog_store::sqlite::SqliteStore;
use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::agent_home_deps::{RoomMembers, SessionHomeDeps};
use super::directory_sessions::DirectorySessions;
use super::heartbeat_parts::{HeartbeatHolds, production_heartbeat};
use super::home_directory::DefinitionsDirectory;
use super::summary_host::SummaryServices;
use super::routine_host::{DefinitionAgents, RoutineAgents, RoutineSessions, SessionRoutineHost};

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/mixy-presence-cases/golden.json");
const HOME: &str = "sess_home_lead";
/// How long one drain of the home delivery may take before the replay fails naming it.
const DRAIN_DEADLINE: Duration = Duration::from_secs(5);

// ---- the recording's world -----------------------------------------------------------------------

/// `Date.now` held at the recording's value.
struct Held(i64);

impl Clock for Held {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(self.0).expect("the recording's clock")
    }
}

/// The schedule and webhook rows (Node's mocked `listSchedules` / `listEndpoints`), changed mid-case
/// as the recorder changed them.
#[derive(Default)]
struct Rows {
    schedules: Mutex<Vec<RoutineState>>,
    webhooks: Mutex<Vec<RoutineState>>,
}

fn states(rows: &Value) -> Vec<RoutineState> {
    rows.as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| RoutineState {
                    name: row["name"].as_str().expect("name").to_owned(),
                    owner_agent_id: row["ownerAgentId"].as_str().unwrap_or_default().to_owned(),
                    enabled: row["enabled"].as_bool().unwrap_or(true),
                    consecutive_failures: 0,
                    last_failed_at: None,
                    result_delivery: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl RoutineRecords for Rows {
    async fn state(&self, _: RoutineKind, _: &str) -> Result<Option<RoutineState>, String> {
        unreachable!("the readers list")
    }
    async fn list(&self, kind: RoutineKind) -> Result<Vec<RoutineState>, String> {
        Ok(match kind {
            RoutineKind::Schedule => self.schedules.lock().unwrap().clone(),
            RoutineKind::Webhook => self.webhooks.lock().unwrap().clone(),
        })
    }
    async fn record_skip(&self, _: RoutineKind, _: &str, _: DateTime<Utc>) -> Result<(), String> {
        unreachable!("no routine runs")
    }
    async fn record_delivery(&self, _: RoutineKind, _: &str, _: &str, _: Option<Value>) -> Result<(), String> {
        unreachable!("no routine runs")
    }
    async fn record_webhook_run(&self, _: &str, _: RunStamp, _: DateTime<Utc>) -> Result<(), String> {
        unreachable!("no routine runs")
    }
}

/// The parts of a heartbeat a first check never reaches (Node's `collect` throws "a first check only arms").
struct Unreached;

#[async_trait]
impl SessionCatalog for Unreached {
    async fn page(&self, _: usize, _: Option<&str>) -> Result<CatalogPage, String> {
        unreachable!("a first check only arms")
    }
    fn awaiting_approval(&self, _: &str) -> bool {
        unreachable!("a first check only arms")
    }
}

#[async_trait]
impl HeldRequests for Unreached {
    async fn pending(&self) -> Result<usize, String> {
        unreachable!("a first check only arms")
    }
}

#[async_trait]
impl WakeHost for Unreached {
    fn session_service_running(&self) -> bool {
        unreachable!("no wake")
    }
    async fn lead_route(&self) -> Result<Option<Value>, String> {
        unreachable!("no wake")
    }
    async fn create_hidden_session(&self, _: &Value, _: &Value) -> Result<String, String> {
        unreachable!("no wake")
    }
    async fn close_hidden_session(&self, _: &str) -> Result<bool, String> {
        unreachable!("no wake")
    }
    async fn deliver(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        unreachable!("no wake")
    }
}

#[async_trait]
impl RoutineSessions for Unreached {
    async fn home_thread_open(&self, _: &str) -> Result<bool, String> {
        unreachable!("no routine runs")
    }
    async fn run_turn(&self, _: RoutineTurn, _: CancellationToken) -> TurnSettle {
        unreachable!("no routine runs")
    }
    async fn run_executor(&self, _: ExecutorRun, _: CancellationToken) -> Result<String, String> {
        unreachable!("no routine runs")
    }
    async fn deliver_result(&self, _: &str, _: &str, _: &DeliveryItem) -> Result<(), String> {
        unreachable!("no routine runs")
    }
    async fn announce_run(&self, _: &str, _: &str, _: &AnnouncedRun) -> Result<(), String> {
        unreachable!("no routine runs")
    }
}

#[async_trait]
impl RoomRelay for Unreached {
    async fn relay(&self, _: &str, _: &str, _: WakeOptions, _: WakeFollow) -> Result<Option<WakeTurn>, String> {
        unreachable!("no room")
    }
}

#[async_trait]
impl RoomMembers for Unreached {
    async fn forget_room_member(&self, _: &str) -> Result<(), RoomError> {
        unreachable!("no agent is deleted")
    }
}

#[async_trait]
impl AgentEffects for Unreached {
    async fn agents_changed(&self) {}
    async fn reload_routines(&self) -> Result<(), String> {
        unreachable!("no definition is saved")
    }
    async fn set_agent_route(&self, _: &str, _: &Value) -> Result<(), String> {
        unreachable!("no definition is saved")
    }
    async fn delete_owned_routines(&self, _: &str) -> Result<OwnedRoutines, String> {
        unreachable!("no definition is deleted")
    }
}

#[async_trait]
impl DocumentText for Unreached {
    async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, ExtError> {
        unreachable!("no attachment is recorded")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("no attachment is recorded")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("no attachment is recorded")
    }
}

impl Handoffs for Unreached {
    fn note(&self, _: &Value) {}
    fn end(&self, _: &str) {}
}

/// Node's delivery options of the recording: no thread is loaded (`loadSession: () => null`), none
/// runs a turn, and a retry is never fired (`retryLater: () => {}`).
struct NoThread;

#[async_trait]
impl HomeThreads for NoThread {
    async fn load(&self, _: &str) -> Result<Option<ThreadSnapshot>, String> {
        Ok(None)
    }
    async fn append(&self, _: &str, _: Vec<Value>, _: Option<i64>) -> Result<(), String> {
        unreachable!("nothing is posted into a thread that is not loaded")
    }
    fn turn_in_flight(&self, _: &str) -> bool {
        false
    }
    async fn session_deleted(&self, _: &str) -> bool {
        false
    }
}

impl RetryTimer for NoThread {
    fn arm(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

/// `live: () => ({ busy: () => false, notice: () => {} })`.
#[async_trait]
impl LiveSurface for NoThread {
    fn busy(&self, _: &str) -> bool {
        false
    }
    async fn notice(&self, _: &str, _: Value) -> Result<bool, String> {
        Ok(false)
    }
    async fn wake(&self, _: &str, _: &str, _: WakeOptions) -> Result<Option<WakeTurn>, String> {
        unreachable!("a heartbeat report wakes nobody")
    }
}

struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

// ---- one profile ---------------------------------------------------------------------------------

struct Profile {
    _dir: tempfile::TempDir,
    data: PathBuf,
    rows: Arc<Rows>,
    clock: Arc<Held>,
    settings: Settings,
    agents: Arc<AgentDefinitions>,
    routine_agents: Arc<dyn RoutineAgents>,
    routine_host: Arc<SessionRoutineHost>,
    desktop: DesktopLeadStatus,
    directory: Arc<SessionDirectory>,
    /// The Maintainer's providers (a first check never asks them).
    summaries: Arc<SummaryServices>,
    /// The per-check state files (Node's `fresh(dataDir, name)`).
    checks: std::sync::atomic::AtomicUsize,
}

fn node_manifest(manifest: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(manifest).unwrap())
}

/// The recorder's `profile(setup)` (and the bot store split), imported as the core imports a 1.4.5 profile.
async fn profile(setup: &Value, split: bool, now: i64) -> Profile {
    let dir = tempfile::tempdir().expect("temp dir");
    let roots = MigrationRoots { data: dir.path().join("data"), home: dir.path().join("home"), profile: None };
    let data = roots.data.clone();
    crate::run_host::fixture_fs::create_dir_all(&data);
    if let Some(manifest) = setup.get("manifest") {
        crate::run_host::fixture_fs::write(data.join("agents").join("lead").join("agent.json"), node_manifest(manifest));
    }
    if let Some(thread) = setup.get("thread") {
        crate::run_host::fixture_fs::write(data.join("sessions").join(format!("{HOME}.json")), serde_json::to_vec(&json!({"id": HOME, "messages": thread})).unwrap());
    }
    if split {
        crate::run_host::fixture_fs::write(data.join("bots").join("migration.json"), serde_json::to_vec(&json!({"version": 1, "bots": []})).unwrap());
    }
    crate::run_host::fixture_fs::write(roots.home.join("projects.json"), "{}");
    let office = OfficeExtractor { docs: Arc::new(Unreached), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default()).run().expect("the profile imports");

    let tokens = mixdog_rt::testing::tokens();
    let root = data.clone();
    let index = tokens
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root))
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
    let threads = Arc::new(StoreThreads::over_data_dir(&data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store"));
    let lanes = SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io };
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(threads.clone())));
    let stored = Arc::new(StoredSearchSessions::new(threads, lanes));

    let rows = Arc::new(Rows::default());
    *rows.schedules.lock().unwrap() = states(&setup["schedules"]);
    *rows.webhooks.lock().unwrap() = states(&setup["webhooks"]);

    // Node's heartbeat was built with `isEnabled: async () => true`: the setting is on.
    let config_path = dir.path().join("config").join("mixdog-config.json");
    crate::run_host::fixture_fs::write(&config_path, r#"{"agent":{"heartbeat":true}}"#);
    let config_lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(config_path, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), config_lanes).await.expect("config");
    let evidence = Arc::new(SessionAgentEvidence::new(directory.clone(), rows.clone()));
    let agents = Arc::new(
        AgentDefinitions::new(dir.path().join("shipped"), &data, tokens.interactive_io, AgentRoutes::new(config.clone(), &data), evidence, Arc::new(|| Value::Null), dir.path().join("task"))
            .with_writes(tokens.durability_io, Arc::new(Unreached), Arc::new(String::new)),
    );
    let routine_agents: Arc<dyn RoutineAgents> = Arc::new(DefinitionAgents::new(agents.clone()));
    let routine_host = SessionRoutineHost::new(routine_agents.clone(), Arc::new(Unreached), HeartbeatSessions::new());
    let state = Arc::new(SessionThreads::new(directory.clone()));
    let sessions = Arc::new(DirectorySessions::new(directory.clone(), state));
    let homes = AgentHomeSessions::new(Arc::new(SessionHomeDeps::new(agents.clone(), sessions, directory.clone(), stored, Arc::new(Unreached))));
    crate::run_host::fixture_fs::create_dir_all(dir.path().join("state"));
    let scopes = mixdog_core_base::support::testing::scopes(&dir.path().join("state"), "agent").await;
    let desktop = DesktopLeadStatus::new(LeadService::new(agents.clone(), LeadAppearance::new(config.clone()), scopes), agents.clone(), homes);
    let settings = Settings::with_process_env(config, Arc::new(NoEffects));
    let summaries_dir = dir.path().join("summaries");
    crate::run_host::fixture_fs::create_dir_all(&summaries_dir);
    let summaries = super::compaction_world::tests::services(&summaries_dir, json!({}), Arc::default()).await.summaries;
    Profile {
        _dir: dir,
        data,
        rows,
        clock: Arc::new(Held(now)),
        settings,
        agents,
        routine_agents,
        routine_host,
        desktop,
        directory,
        summaries,
        checks: std::sync::atomic::AtomicUsize::new(0),
    }
}

impl Profile {
    fn fresh(&self, name: &str) -> PathBuf {
        let n = self.checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        self.data.join(format!("{name}-{n}.json"))
    }

    /// The home delivery over `queue` (Node's `createAgentHomeDelivery` of the recording).
    fn delivery(&self, queue: Arc<RoutineResultQueue>) -> Arc<AgentHomeDelivery> {
        let live = LiveSlot::new();
        live.set(Some(Arc::new(NoThread)));
        let clock: Arc<dyn Clock> = self.clock.clone();
        AgentHomeDelivery::new(Arc::new(NoThread), Arc::new(DefinitionsDirectory::new(self.agents.clone())), live, Arc::new(Unreached), queue, clock, Arc::new(NoThread), DeliveryConfig::node())
    }

    fn queue(&self, name: &str) -> Arc<RoutineResultQueue> {
        let lane = mixdog_rt::testing::tokens().durability_io;
        let clock: Arc<dyn Clock> = self.clock.clone();
        Arc::new(RoutineResultQueue::new(StateJson::new(self.data.join(name), lane), HOME_QUEUE_LIMIT, QUEUE_CAPS, clock, Arc::new(Unreached)))
    }

    /// `heartbeatRuns`: the daemon's heartbeat over a fresh state file, ticked once.
    async fn heartbeat(&self) -> Value {
        let lane = mixdog_rt::testing::tokens().durability_io;
        let store = HeartbeatStore::new(StateJson::new(self.fresh("heartbeat"), lane));
        let clock: Arc<dyn Clock> = self.clock.clone();
        let unreached = Arc::new(Unreached);
        let heartbeat = production_heartbeat(HeartbeatHolds {
            clock: clock.clone(),
            store: store.clone(),
            activity: UserActivity::new(store, clock.clone()),
            settings: self.settings.clone(),
            agents: self.routine_agents.clone(),
            directory: self.directory.clone(),
            summaries: self.summaries.clone(),
            delivery: self.delivery(self.queue("routine-results.json")),
            catalog: unreached.clone(),
            held: unreached.clone(),
            records: self.rows.clone(),
            routines: RoutineRuntime::new(self.routine_host.clone(), self.rows.clone(), clock, mixdog_js::time::Tz::UTC),
            wake_host: unreached,
            marks: HeartbeatSessions::new(),
        });
        json!(heartbeat.tick().await.word())
    }

    /// `routineOwnerProblem('')`.
    async fn routines(&self) -> Value {
        let problem = self.routine_host.owner_problem(&schedule_owner_agent_id(Some("")), false).await.expect("the owner rule reads");
        json!(problem.map_or("", |problem| problem.code()))
    }

    /// `reportWaits`: a heartbeat report queued for her home, drained, the items left. The daemon
    /// finds the homes with work owed through `pending_homes` and drains each (`recover`); the
    /// `drain` call after it is served by that pass (one more pass if it is still running).
    async fn reports(&self) -> Value {
        let n = self.checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let queue = self.queue(&format!("routine-results-{n}.json"));
        let delivery = self.delivery(queue.clone());
        let item = json!({"runId": "heartbeat_1", "kind": "agent-message", "text": "Project A got to step 3.", "at": 1});
        queue.add(HOME, item, AddOptions::default()).await.expect("queued");
        assert_eq!(delivery.recover().await.expect("the queue reads"), [HOME], "the queued home is the one pending");
        tokio::time::timeout(DRAIN_DEADLINE, delivery.drain(HOME).wait())
            .await
            .unwrap_or_else(|_| panic!("timed out after {DRAIN_DEADLINE:?} awaiting the drain of {HOME}"));
        json!(queue.items(HOME).await.expect("the queue reads"))
    }

    /// `desktopShows`: the window's `agent/getLeadStatus`, its `created`.
    async fn desktop(&self) -> Value {
        let request = CoreRequest { method: Method("agent/getLeadStatus"), params: json!({}), op: None, ctx: CallContext::internal("replay") };
        let Reply::Value(status) = self.desktop.call(request).await.expect("agent/getLeadStatus") else { panic!("a status value") };
        status["created"].clone()
    }

    /// `routes.getLeadStatus()`: the stored status with `exists`, the one rule.
    async fn status(&self) -> Value {
        let mut status = self.agents.lead_status().await.expect("the lead status reads").to_json();
        status["exists"] = json!(self.agents.mixy_exists().await.expect("the rule reads"));
        status
    }

    /// `answers(dataDir)`.
    async fn answers(&self) -> Value {
        let heartbeat = self.heartbeat().await;
        let routines = self.routines().await;
        let reports = self.reports().await;
        let desktop = self.desktop().await;
        let desktop_again = self.desktop().await;
        json!({"heartbeat": heartbeat, "routines": routines, "reports": reports, "desktop": desktop, "desktopAgain": desktop_again, "heartbeatAfter": self.heartbeat().await})
    }

    /// `manifestOf(dataDir)`: `agents/lead/agent.json` parsed, `null` when absent.
    fn lead_manifest(&self) -> Value {
        let path = self.data.join("agents").join("lead").join("agent.json");
        crate::run_host::fixture_fs::read_to_string(&path).map_or(Value::Null, |text| serde_json::from_str(&text).expect("a JSON manifest"))
    }

    /// The user writes `text` in her thread: one user turn of `sess_home_lead`, durable before it answers.
    async fn user_writes(&self, text: &str) {
        let thread = ThreadId::from(HOME);
        let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new());
        let handle = self.directory.open_handle(&thread, &ctx).await.expect("her thread opens");
        let op = OpId::from(uuid::Uuid::now_v7().to_string());
        let params = json!({ "threadId": thread, "opId": op.as_str(), "input": { "prompt": text } });
        handle.request(CoreRequest { method: Method("turn/start"), params, op: Some(op), ctx: ctx.clone() }).await.expect("turn/start");
        let said = async || {
            let request = CoreRequest { method: Method("thread/read"), params: json!({ "threadId": thread }), op: None, ctx: ctx.clone() };
            let Reply::Value(view) = handle.request(request).await.expect("thread/read") else { return false };
            view["items"].as_array().is_some_and(|items| items.iter().any(|item| item["type"] == "userMessage" && item["content"][0]["text"] == text))
                && view["state"]["runtime"]["busy"] != json!(true)
        };
        let settled = async {
            loop {
                let stepped = handle.stepped().notified();
                tokio::pin!(stepped);
                stepped.as_mut().enable();
                if said().await {
                    return;
                }
                stepped.await;
            }
        };
        tokio::time::timeout(DRAIN_DEADLINE, settled).await.unwrap_or_else(|_| panic!("timed out after {DRAIN_DEADLINE:?} awaiting her thread to hold {text:?} and settle"));
    }
}

/// The recorded observation with the manifest's declaration applied: `profileFilesAfter` (the
/// recorder's per-check state file names and Node's session path) is not compared; the lead
/// manifest it lists is compared byte for byte as `leadManifestAfter`.
fn expected(observed: &Exact) -> Exact {
    Exact::Object(observed.entries().iter().filter(|(key, _)| key != "profileFilesAfter").cloned().collect())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_mixy_presence_case_gives_one_answer_through_the_core_readers() {
    let golden = Exact::decode(&serde_json::from_str::<Value>(&GOLDEN).unwrap()).unwrap();
    let now = golden.get("clock").get("dateNow").as_f64() as i64;
    let cases = golden.get("cases").as_array();
    assert_eq!(cases.len(), 12);
    // The recorder's `botSchedule`, which replaces her routine mid-case.
    let bot_schedule = json!({"name": "pr-watch", "ownerAgentId": "reviewer", "enabled": true});
    let mut failures = Vec::new();
    for case in cases {
        let name = case.get("case").as_str();
        let recorded = case.get("observed");
        let observed = if name.starts_with("one answer everywhere: ") {
            let setup = recorded.get("setup").to_plain().unwrap();
            let p = profile(&setup, false, now).await;
            let answers = p.answers().await;
            json!({"setup": setup, "answers": answers, "leadManifestAfter": p.lead_manifest()})
        } else if name.starts_with("a legacy Mixy with routines stays visible") {
            let setup = recorded.get("setup").to_plain().unwrap();
            let split = recorded.get("botStoreSplit").as_bool();
            let p = profile(&setup, split, now).await;
            let with_routine = p.answers().await;
            let status = p.status().await;
            *p.rows.schedules.lock().unwrap() = states(&json!([bot_schedule]));
            let manifest = p.lead_manifest();
            json!({"setup": setup, "botStoreSplit": split, "withRoutine": with_routine, "status": status, "leadManifestAfter": manifest, "withoutHerRoutine": p.answers().await})
        } else if name == "an undecided profile is decided once by the desktop, and the decision changes no answer" {
            let thread = recorded.get("thread").to_plain().unwrap();
            let p = profile(&json!({"thread": thread}), false, now).await;
            let mut log = vec![json!({"step": "undecided", "status": p.status().await})];
            log.push(json!({"step": "desktop shows", "shows": p.desktop().await}));
            let status = p.status().await;
            log.push(json!({"step": "after the desktop decided", "status": status, "heartbeat": p.heartbeat().await}));
            // The recorder rewrote her thread as `[...reports, said('hi')]`: the user's message "hi".
            p.user_writes("hi").await;
            let desktop = p.desktop().await;
            let heartbeat = p.heartbeat().await;
            log.push(json!({"step": "the user wrote to her", "desktop": desktop, "heartbeat": heartbeat, "routineOwnerProblem": p.routines().await}));
            json!({"thread": thread, "log": log, "leadManifestAfter": p.lead_manifest()})
        } else {
            panic!("no replay for {name:?}")
        };
        let (got, want) = (Exact::plain(&observed), expected(recorded));
        if got != want {
            failures.push(format!("{name}\n  core: {}\n  node: {}", serde_json::to_string(&observed).unwrap(), serde_json::to_string(&want.to_plain().unwrap()).unwrap()));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
