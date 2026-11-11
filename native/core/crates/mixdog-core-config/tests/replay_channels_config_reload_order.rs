//! Replay of `native/core/fixtures/channels-config-reload-order` (Node `config-reload-watch.test.mjs`, cases 55, 75 and 92).
//!
//! Driven: the channels' config follow (`ChannelConfigFollow`, Node's `createConfigReloadWatch`) on a guarded config in a
//! private data dir and backup root, with the config file's external-edit watch (`ConfigWatcher`) running. The three
//! cases share one data dir in the recording (the backup sequence runs on across them), so each test runs the cases
//! before its own as they were recorded and compares its own.
//!
//! - "another process" (case 55) is a second guarded config of its own (its own guard state and sequence, as a new
//!   Node process has) that opens the file, writes and goes away; the first config hears it only through its watch.
//! - `reload` of cases 55 and 75 is a counter, as in Node's test (a `ChannelLifecycle` whose `reload_config` counts).
//! - Case 92 reloads the real `ChannelRuntime` (Node's `createConfigReloader`), live (`automationRunning: true`: its
//!   automation started before the follow). Mapping of Node's reloader ports to the runtime's:
//!   `load()` ↔ the schedule rows read (`ScheduleRecords::list`, held by the replay and settled with
//!   `value.schedules ?? []`); `setConfig(value)` ↔ the load settled in that step is the one applied (the runtime keeps
//!   no copy of the config: it reads the stores, so the applied value shows as the rows the scheduler is reloaded with
//!   in the same step); `scheduler.reloadConfig(schedules, {restart})` ↔ `Scheduler::reload_config` (call recorder);
//!   `syncWebhookAndEventRuntime({reload})` / `stopWebhookAndEventRuntime()` ↔ `AutomationServices::sync` / `stop`.
//!   The reloads' promises Node awaits are the `reload_config` calls the follow starts, observed by a delegating
//!   `ChannelLifecycle`.
//! - Normalised as declared: the data dir path, UUIDs and ISO times in file texts; `scope-<hash>` and the time in backup
//!   directory names. The guard's clock is a counter of milliseconds, so backup names sort in the order they were made.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::ChannelConfigFollow;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_config::config::ConfigWatcher;
use mixdog_core_config::user_data::Env;
use mixdog_core_config::user_data::UserData;
use mixdog_services::channels::ChannelLifecycle;
use mixdog_services::channels::ChannelRuntime;
use mixdog_services::channels::RunningWork;
use mixdog_services::channels::ports::AgentRuntime;
use mixdog_services::channels::ports::AutomationServices;
use mixdog_services::scheduler::Schedule;
use mixdog_services::scheduler::ScheduleError;
use mixdog_services::scheduler::Scheduler;
use mixdog_services::scheduler::store::MemoryScheduleStore;
use mixdog_services::scheduler::store::RunOutcome;
use mixdog_services::scheduler::store::ScheduleRecords;
use mixdog_services::scheduler::store::ScheduleRunner;
use mixdog_services::scheduler::store::ScheduleStore;
use mixdog_services::scheduler::store::SystemClock;
use mixdog_services::scheduler::store::Ts;
use mixdog_testkit::Exact;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;
use tokio::sync::watch;

const DEADLINE: Duration = Duration::from_secs(30);

fn recorded() -> Exact {
    Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/channels-config-reload-order/golden.json"))
}

fn obj(fields: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn text(s: &str) -> Exact {
    Exact::String(s.to_owned())
}

fn count(n: usize) -> Exact {
    Exact::Number(n as f64)
}

async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(DEADLINE, future).await.unwrap_or_else(|_| panic!("{what} did not happen within 30 s"))
}

// ---- normalisation (declared in the manifest) ----

fn replace_runs(text: &str, len: usize, matches: impl Fn(&[u8]) -> bool, with: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if i + len <= bytes.len() && text.is_char_boundary(i) && text.is_char_boundary(i + len) && matches(&bytes[i..i + len]) {
            out.push_str(with);
            i += len;
        } else {
            let ch = text[i..].chars().next().expect("a char at a boundary");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn shape(bytes: &[u8], pattern: &str) -> bool {
    bytes.iter().zip(pattern.bytes()).all(|(b, p)| match p {
        b'h' => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        b'd' => b.is_ascii_digit(),
        other => *b == other,
    })
}

const UUID: &str = "hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh";
const ISO: &str = "dddd-dd-ddTdd:dd:dd.dddZ";

fn normalise_text(text: &str, data_dir: &Path) -> String {
    let escaped = serde_json::to_string(&data_dir.to_string_lossy()).unwrap();
    let text = text.replace(&escaped[1..escaped.len() - 1], "<data-dir>");
    let text = replace_runs(&text, UUID.len(), |b| shape(b, UUID), "<instance-id>");
    replace_runs(&text, ISO.len(), |b| shape(b, ISO), "<time>")
}

fn walk(base: &Path, data_dir: &Path) -> Vec<(String, String)> {
    fn visit(dir: &Path, rel: &str, data_dir: &Path, out: &mut Vec<(String, String)>) {
        let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for name in names {
            let full = dir.join(&name);
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if full.is_dir() {
                visit(&full, &path, data_dir, out);
            } else {
                out.push((path, normalise_text(&std::fs::read_to_string(&full).unwrap(), data_dir)));
            }
        }
    }
    let mut out = Vec::new();
    if base.exists() {
        visit(base, "", data_dir, &mut out);
    }
    out
}

/// `scope-<hash>/` is `<scope>/`; `<scope>/<iso>Z-<seq>-<kind>/` is `<scope>/<time>-<seq>-<kind>/`.
fn backup_path(path: &str) -> String {
    let Some(rest) = path.strip_prefix("scope-").and_then(|p| p.split_once('/')).map(|(_, rest)| rest) else { return path.to_owned() };
    let rest = match rest.split_once('/') {
        Some((dir, tail)) if dir.len() > 4 && dir.as_bytes()[..4].iter().all(u8::is_ascii_digit) && dir.contains("Z-") => {
            let (_, kind) = dir.split_once("Z-").unwrap();
            format!("<time>-{kind}/{tail}")
        }
        _ => rest.to_owned(),
    };
    format!("<scope>/{rest}")
}

fn files(list: Vec<(String, String)>) -> Exact {
    Exact::Array(list.into_iter().map(|(path, body)| obj(vec![("path", text(&path)), ("text", text(&body))])).collect())
}

// ---- the private data dir and its writers ----

struct Dir {
    _root: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
    backups: PathBuf,
    clock: Arc<AtomicI64>,
}

impl Dir {
    fn new() -> Self {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path().to_path_buf();
        let data = root.join("data");
        std::fs::create_dir(&data).unwrap();
        Self { root, data, backups: root_dir.path().join("backups"), _root: root_dir, clock: Arc::new(AtomicI64::new(1_800_000_000_000)) }
    }

    fn disk(&self) -> Exact {
        let backups = walk(&self.backups, &self.data).into_iter().map(|(path, body)| (backup_path(&path), body)).collect();
        obj(vec![("dataDir", files(walk(&self.data, &self.data))), ("backups", files(backups))])
    }

    /// A guarded config with a guard of its own: one process's view of the file.
    async fn open(&self) -> Config {
        let backups = self.backups.to_string_lossy().into_owned();
        let env = Env::new(move |name| (name == "MIXDOG_USER_DATA_BACKUP_ROOT").then(|| backups.clone()), Some(self.root.join("home")));
        let clock = self.clock.clone();
        let guard = UserData::new(env, move || clock.fetch_add(1, Ordering::SeqCst), || uuid::Uuid::new_v4().to_string(), |_| {});
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open_guarded(self.data.join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes, Arc::new(guard))
            .await
            .expect("the config opens");
        config
    }
}

/// Node's `updateSection(section, (s) => ({ ...s, [key]: value }))`, through the config's in-process writer.
async fn write(config: &Config, path: &str, value: Value) {
    let (section, key) = path.split_once('.').expect("a section.key path");
    let (section, key) = (section.to_owned(), key.to_owned());
    config
        .update(move |doc| {
            let entry = doc.entry(section).or_insert_with(|| json!({}));
            entry.as_object_mut().expect("the section is an object").insert(key, value);
            Ok(())
        })
        .await
        .unwrap_or_else(|e| panic!("write {path}: {e}"));
}

// ---- reload targets ----

/// Node's test `reload`: counts its calls.
struct Counter {
    seen: watch::Sender<usize>,
    inner: Option<Arc<ChannelRuntime>>,
    settled: watch::Sender<usize>,
}

impl Counter {
    fn new(inner: Option<Arc<ChannelRuntime>>) -> Arc<Self> {
        Arc::new(Self { seen: watch::Sender::new(0), inner, settled: watch::Sender::new(0) })
    }

    fn seen(&self) -> usize {
        *self.seen.borrow()
    }

    async fn reached(&self, n: usize, what: &str) {
        within(what, self.seen.subscribe().wait_for(|seen| *seen >= n)).await.unwrap();
    }

    async fn settled(&self, n: usize, what: &str) {
        within(what, self.settled.subscribe().wait_for(|settled| *settled >= n)).await.unwrap();
    }
}

#[async_trait]
impl ChannelLifecycle for Counter {
    fn bridge_active(&self) -> bool {
        unreachable!("the follow only reloads")
    }
    async fn set_bridge_active(&self, _active: bool) {
        unreachable!("the follow only reloads")
    }
    async fn start_bridge(&self) -> Result<(), String> {
        unreachable!("the follow only reloads")
    }
    async fn stop_owned_runtime(&self, _reason: &str) -> Result<(), String> {
        unreachable!("the follow only reloads")
    }
    async fn reload_config(&self) -> Result<String, String> {
        self.seen.send_modify(|seen| *seen += 1);
        let result = match &self.inner {
            Some(runtime) => runtime.reload_config().await,
            None => Ok(String::new()),
        };
        self.settled.send_modify(|settled| *settled += 1);
        result
    }
    async fn rename_schedule(&self, _name: &str, _def: &Value, _timing_changed: bool) -> Result<Value, ScheduleError> {
        unreachable!("the follow only reloads")
    }
}

type Events = Arc<Mutex<Vec<Exact>>>;

/// The schedule rows, read through until `hold` and then held per read until the replay settles it.
struct Loads {
    rows: MemoryScheduleStore,
    events: Events,
    hold: Mutex<bool>,
    calls: Mutex<usize>,
    pending: Mutex<HashMap<usize, oneshot::Sender<Vec<Schedule>>>>,
    started: watch::Sender<usize>,
}

impl Loads {
    async fn started(&self, id: usize) {
        within(&format!("load #{id} to start after the config write"), self.started.subscribe().wait_for(|n| *n >= id)).await.unwrap();
    }

    fn settle(&self, id: usize, rows: Vec<Schedule>) {
        let gate = self.pending.lock().unwrap().remove(&id).unwrap_or_else(|| panic!("load #{id} is not pending"));
        gate.send(rows).expect("the load is still waited on");
    }
}

#[async_trait]
impl ScheduleStore for Loads {
    async fn get(&self, name: &str) -> Result<Option<Schedule>, ScheduleError> {
        self.rows.get(name).await
    }
    async fn list(&self) -> Result<Vec<Schedule>, ScheduleError> {
        if !*self.hold.lock().unwrap() {
            return self.rows.list().await;
        }
        let id = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        let (gate, settled) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, gate);
        self.events.lock().unwrap().push(obj(vec![("event", text("load started")), ("id", count(id))]));
        self.started.send_replace(id);
        Ok(settled.await.expect("the replay settles every load it started"))
    }
    async fn mark_fired(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.rows.mark_fired(name, at).await
    }
    async fn set_next_fire(&self, name: &str, at: Option<Ts>) -> Result<(), ScheduleError> {
        self.rows.set_next_fire(name, at).await
    }
    async fn advance_cursor(&self, name: &str, scheduled_at: Ts, next: Option<Ts>) -> Result<bool, ScheduleError> {
        self.rows.advance_cursor(name, scheduled_at, next).await
    }
    async fn claim_run(&self, name: &str, scheduled_at: Ts, started_at: Ts, next: Option<Ts>) -> Result<bool, ScheduleError> {
        self.rows.claim_run(name, scheduled_at, started_at, next).await
    }
    async fn mark_success(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.rows.mark_success(name, at).await
    }
    async fn mark_failure(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.rows.mark_failure(name, at).await
    }
    async fn mark_skipped(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.rows.mark_skipped(name, at).await
    }
    async fn mark_done(&self, name: &str) -> Result<(), ScheduleError> {
        self.rows.mark_done(name).await
    }
    async fn set_deferred(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError> {
        self.rows.set_deferred(name, until).await
    }
    async fn set_skipped_until(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError> {
        self.rows.set_skipped_until(name, until).await
    }
}

#[async_trait]
impl ScheduleRecords for Loads {
    async fn upsert(&self, def: &Schedule) -> Result<Schedule, ScheduleError> {
        self.rows.upsert(def).await
    }
    async fn rename(&self, old: &str, def: &Schedule, timing_changed: bool) -> Result<Option<Schedule>, ScheduleError> {
        self.rows.rename(old, def, timing_changed).await
    }
    async fn delete(&self, name: &str) -> Result<bool, ScheduleError> {
        self.rows.delete(name).await
    }
    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<Option<Schedule>, ScheduleError> {
        self.rows.set_enabled(name, enabled).await
    }
    async fn record_delivery(&self, name: &str, run_id: &str, entry: Option<Value>) -> Result<(), ScheduleError> {
        self.rows.record_delivery(name, run_id, entry).await
    }
}

struct NoRuns;

#[async_trait]
impl ScheduleRunner for NoRuns {
    async fn run(&self, schedule: &Schedule, _prompt: &str) -> Result<RunOutcome, String> {
        panic!("no schedule is loaded, yet {} fired", schedule.name)
    }
}

struct Providers;

#[async_trait]
impl AgentRuntime for Providers {
    async fn init_providers(&self) -> Result<(), String> {
        Ok(())
    }
}

struct Services(Events);

#[async_trait]
impl AutomationServices for Services {
    async fn sync(&self, reload: bool) -> Result<(), String> {
        self.0.lock().unwrap().push(obj(vec![("event", text("syncWebhookAndEventRuntime")), ("options", obj(vec![("reload", Exact::Bool(reload))]))]));
        Ok(())
    }
    async fn stop(&self) {
        self.0.lock().unwrap().push(obj(vec![("event", text("stopWebhookAndEventRuntime"))]));
    }
}

// ---- the cases, in recorded order ----

#[track_caller]
fn same(what: &str, expected: &Exact, actual: &Exact) {
    assert_eq!(actual, expected, "{what}");
}

/// Runs the recorded cases in order up to `target` (the earlier ones set the shared data dir up as recorded) and
/// compares the steps of `target`.
async fn replay(target: usize) {
    let golden = recorded();
    let cases = golden.get("cases").as_array();
    assert_eq!(cases.len(), 3, "the recorded cases");
    let dir = Dir::new();
    let config = dir.open().await;
    let _watch = ConfigWatcher::start(config.clone()).expect("the config dir is watched");

    // Case 55.
    {
        let case = &cases[0];
        let steps = case.get("steps").as_array();
        let mut actual = Vec::new();
        let counter = Counter::new(None);
        let follow = ChannelConfigFollow::start(config.clone(), counter.clone());
        actual.push(obj(vec![("step", text("watch.start()")), ("reloads", count(counter.seen())), ("disk", dir.disk())]));
        for revision in 1..=3 {
            let other = dir.open().await;
            write(&other, "channels.revision", json!(revision)).await;
            drop(other);
            counter.reached(revision, &format!("reload {revision} after the write by another process")).await;
            actual.push(obj(vec![
                ("step", text(&format!("another process writes channels.revision = {revision}"))),
                ("reloads", count(counter.seen())),
                ("disk", dir.disk()),
            ]));
        }
        drop(follow);
        let settled = counter.seen();
        write(&config, "channels.revision", json!(4)).await;
        actual.push(obj(vec![
            ("step", text("watch.stop(), then an in-process write of channels.revision = 4")),
            ("reloadsBeforeStop", count(settled)),
            ("reloadsAfterTheWrite", count(counter.seen())),
            ("disk", dir.disk()),
        ]));
        if target == 0 {
            same(case.get("name").as_str(), &Exact::Array(steps.to_vec()), &Exact::Array(actual));
            return;
        }
    }

    // Case 75.
    {
        let case = &cases[1];
        let steps = case.get("steps").as_array();
        let mut actual = Vec::new();
        let counter = Counter::new(None);
        let follow = ChannelConfigFollow::start(config.clone(), counter.clone());
        write(&config, "agent.promptCacheWarming", json!(false)).await;
        actual.push(obj(vec![("step", text("write agent.promptCacheWarming = false")), ("reloads", count(counter.seen())), ("disk", dir.disk())]));
        write(&config, "voice.language", json!("ko")).await;
        counter.reached(1, "the reload after the voice change").await;
        actual.push(obj(vec![
            ("step", text("write voice.language = \"ko\" (a reload arrives; the agent write produced none before it)")),
            ("reloads", count(counter.seen())),
            ("disk", dir.disk()),
        ]));
        drop(follow);
        if target == 1 {
            same(case.get("name").as_str(), &Exact::Array(steps.to_vec()), &Exact::Array(actual));
            return;
        }
    }

    // Case 92.
    let case = &cases[2];
    let steps = case.get("steps").as_array();
    let events: Events = Arc::default();
    let loads = Arc::new(Loads {
        rows: MemoryScheduleStore::default(),
        events: events.clone(),
        hold: Mutex::new(false),
        calls: Mutex::new(0),
        pending: Mutex::default(),
        started: watch::Sender::new(0),
    });
    let work = RunningWork::new();
    let scheduler = Scheduler::new(Arc::new(MemoryScheduleStore::default()), Arc::new(NoRuns), Arc::new(SystemClock), work, chrono_tz::Tz::UTC, Vec::new());
    let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
    scheduler.record_calls(calls.clone());
    let runtime = ChannelRuntime::new(scheduler, loads.clone(), Arc::new(Services(events.clone())), Arc::new(Providers));
    runtime.start_automation().await.expect("the automation runtime starts");
    events.lock().unwrap().clear();
    calls.lock().unwrap().clear();
    *loads.hold.lock().unwrap() = true;
    let reloads = Counter::new(Some(runtime.clone()));
    let follow = ChannelConfigFollow::start(config.clone(), reloads.clone());
    // The scheduler's calls and the services' calls, in the order they were made.
    let take = |events: &Events| -> Vec<Exact> {
        let scheduler: Vec<Value> = std::mem::take(&mut *calls.lock().unwrap());
        let mut out: Vec<Exact> = Vec::new();
        for call in scheduler {
            assert_eq!(call[0], "scheduler.reload", "a scheduler call other than a reload: {call}");
            out.push(obj(vec![
                ("event", text("scheduler.reloadConfig")),
                ("schedules", Exact::plain(&call[1])),
                ("options", obj(vec![("restart", Exact::plain(&call[2]["restart"]))])),
            ]));
        }
        out.extend(std::mem::take(&mut *events.lock().unwrap()));
        out
    };
    let value_of = |step: &Exact, at: usize| -> Exact {
        step.get("events").as_array().get(at).map(|e| e.get("value").clone()).unwrap_or_else(|| panic!("the recorded setConfig value"))
    };
    let rows_of = |value: &Exact| -> Vec<Schedule> {
        match value.try_get("schedules") {
            Some(rows) => serde_json::from_value(rows.to_plain().unwrap()).expect("recorded schedule rows"),
            None => Vec::new(),
        }
    };
    let mut actual = Vec::new();

    write(&config, "channels.revision", json!(101)).await;
    loads.started(1).await;
    actual.push(obj(vec![
        ("step", text("write channels revision 101 -> the watch calls reload; load #1 started")),
        ("events", Exact::Array(take(&events))),
        ("disk", dir.disk()),
    ]));
    write(&config, "channels.revision", json!(102)).await;
    loads.started(2).await;
    actual.push(obj(vec![
        ("step", text("write channels revision 102 -> load #2 started while #1 is pending")),
        ("events", Exact::Array(take(&events))),
        ("disk", dir.disk()),
    ]));

    // Load #2 settles with the value Node's load #2 resolved with; what is applied in this step is that value.
    let second = value_of(&steps[2], 0);
    loads.settle(2, rows_of(&second));
    reloads.settled(1, "reload #2 to apply").await;
    let mut applied = take(&events);
    let config_now = if applied.is_empty() { Exact::Null } else { second.clone() };
    if !applied.is_empty() {
        applied.insert(0, obj(vec![("event", text("setConfig")), ("value", second.clone())]));
    }
    actual.push(obj(vec![("step", text("load #2 resolves with {revision: 2} -> applied")), ("events", Exact::Array(applied)), ("config", config_now.clone())]));

    let first = obj(vec![("revision", Exact::Number(1.0))]);
    loads.settle(1, rows_of(&first));
    reloads.settled(2, "reload #1 to settle").await;
    let mut discarded = take(&events);
    let config_last = if discarded.is_empty() { config_now } else { first.clone() };
    if !discarded.is_empty() {
        discarded.insert(0, obj(vec![("event", text("setConfig")), ("value", first)]));
    }
    actual.push(obj(vec![
        ("step", text("load #1 (older) resolves with {revision: 1} last -> discarded")),
        ("events", Exact::Array(discarded)),
        ("config", config_last),
    ]));
    drop(follow);
    same(case.get("name").as_str(), &Exact::Array(steps.to_vec()), &Exact::Array(actual));
    same("loadCalls", case.get("loadCalls"), &count(*loads.calls.lock().unwrap()));
    same("finalDisk", golden.get("finalDisk"), &dir.disk());
    let (data, backups) = (dir.data.clone(), dir.backups.clone());
    drop(config);
    drop(dir);
    same(
        "afterRemoval",
        golden.get("afterRemoval"),
        &obj(vec![("dataDirExists", Exact::Bool(data.exists())), ("backupRootExists", Exact::Bool(backups.exists()))]),
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_config_write_by_another_process_reloads_the_channels_runtime_test_line_55() {
    replay(0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changes_outside_the_channels_and_voice_sections_never_restart_the_listeners_test_line_75() {
    replay(1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slower_load_of_an_older_config_never_overwrites_a_newer_one_test_line_92() {
    replay(2).await;
}
