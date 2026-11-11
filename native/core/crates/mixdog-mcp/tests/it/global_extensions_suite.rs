//! Node's recording `fixtures/session-global-extensions/recording.json` (`record-session-global-extensions.mjs`, test file
//! `src/session-runtime/global-extensions.test.mjs`), read when the test runs and decoded with [`Exact`]: one test per case.
//! The calls go to the real [`GlueHost`] over the real [`McpGlue`] and its scopes (`reconnect_mcp_and_announce`,
//! `reconnect_all_mcp_and_announce`, `schedule_mcp_toggle`, `announce`). Node's runtimes are the core's MCP scopes: the
//! runtime scope is the runtime the calls are made in (Node's writer, or its only runtime), an open session scope is a peer.
//! What Node's scripted connector saw (`connectConfiguredMcp`, `cancelMcpLogin`) is read off each scope's operations through
//! the scope runtime's test watch, and `invalidatePreSessionToolSurface` is the surface's `refresh_surface`. What the
//! manifest declares (the order across runtimes, the one process-wide surface, the change bus) is in its `exclusions`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_mcp::config::Env;
use mixdog_mcp::connector_accounts::AccountHealth;
use mixdog_mcp::declaration_cache::DeclarationCache;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::hub::McpHub;
use mixdog_mcp::mcp_glue::GlueHost;
use mixdog_mcp::mcp_glue::GlueInputs;
use mixdog_mcp::mcp_glue::McpGlue;
use mixdog_mcp::mcp_glue::McpScopes;
use mixdog_mcp::mcp_glue::McpSurface;
use mixdog_mcp::oauth::OAuthEnv;
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_mcp::plugin_admin::PluginAdmin;
use mixdog_mcp::scope_runtime::Op;
use mixdog_mcp::scope_runtime::OpWatch;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use mixdog_secrets::SecretError;
use mixdog_secrets::SecretStore;
use mixdog_testkit::exact::Exact;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn recording() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/session-global-extensions/recording.json");
    Exact::decode(&serde_json::from_str(text).expect("the recording is JSON")).expect("the recording decodes")
}

fn case(line: f64) -> Exact {
    recording().get("cases").as_array().iter().find(|case| *case.get("testLine") == Exact::Number(line)).cloned().unwrap_or_else(|| panic!("no case at line {line}"))
}

fn plain(value: Value) -> Exact {
    Exact::plain(&value)
}

/// The statuses as recorded: Node's scripted connector returned `{ servers: [] }`, so only `servers` is compared (manifest).
fn statuses(results: &[Value]) -> Exact {
    plain(Value::Array(results.iter().map(|status| json!({ "servers": status["servers"] })).collect()))
}

struct NoGit;

impl GitRunner for NoGit {
    fn run(&self, _: &[String], _: Duration) -> Result<String, String> {
        Err("git is not used".to_owned())
    }
}

/// No MCP server configured: the operations run their whole path over an empty server set.
struct Config;

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        Map::new()
    }
    async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
        Ok(())
    }
    fn set_disabled_skills(&self, _: &[String]) {}
}

struct NoSecrets;

#[async_trait]
impl SecretStore for NoSecrets {
    async fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
        Ok(None)
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
        Ok(())
    }
    async fn delete(&self, _: &str) -> Result<(), SecretError> {
        Ok(())
    }
}

struct NoSettings;

impl SkillSettingsSource for NoSettings {
    fn current(&self) -> SkillSettings {
        SkillSettings::default()
    }
}

/// What the recorder's scripted dependencies saw, as the core does it.
#[derive(Default)]
struct Seen {
    events: Mutex<Vec<Value>>,
    /// The label of each scope (Node's runtime names); a scope without one is not labelled in the events.
    labels: Mutex<HashMap<String, String>>,
    /// The process's runtime: the surface's refresh is its.
    runtime: Mutex<Option<String>>,
    recording: std::sync::atomic::AtomicBool,
    /// Case 57's connector: an enable stays pending until `cancelMcpLogin` releases it, and each connect's end is recorded.
    hold_enable: std::sync::atomic::AtomicBool,
    /// The overlapping-enables connector: the first enabled connect stays pending until released, each connect's end is recorded.
    hold_once: std::sync::atomic::AtomicBool,
    records_done: std::sync::atomic::AtomicBool,
    released: tokio::sync::Notify,
    entered: tokio::sync::Notify,
    /// The surface was refreshed after the recording began.
    refreshed: tokio::sync::Notify,
}

impl Seen {
    /// Records `event`, led by the label of `scope` when it has one (the recorder's `runtime` field).
    fn push(&self, scope: Option<&str>, event: Map<String, Value>) {
        if !self.recording.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let mut labelled = Map::new();
        if let Some(label) = scope.and_then(|scope| self.labels.lock().unwrap().get(scope).cloned()) {
            labelled.insert("runtime".to_owned(), json!(label));
        }
        labelled.extend(event);
        self.events.lock().unwrap().push(Value::Object(labelled));
    }

    /// Case 57's connector: it holds an enable, and records its ends and the sign-in cancels.
    fn scripted_57(&self) -> bool {
        self.hold_enable.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn events(&self) -> Vec<Value> {
        self.events.lock().unwrap().clone()
    }
}

fn op_of(op: &Op) -> Value {
    match op {
        Op::Reset => json!({ "reset": true }),
        Op::Only(name, enabled) => json!({ "only": name, "enabled": enabled }),
        Op::Reconcile => json!({ "reconcile": true }),
    }
}

fn one(key: &str, value: Value) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(key.to_owned(), value);
    map
}

struct Watch(Arc<Seen>);

#[async_trait]
impl OpWatch for Watch {
    async fn connecting(&self, scope: &str, op: &Op) {
        self.0.push(Some(scope), one("connect", op_of(op)));
        if matches!(op, Op::Only(_, true)) && (self.0.scripted_57() || self.0.hold_once.swap(false, std::sync::atomic::Ordering::SeqCst)) {
            self.0.entered.notify_one();
            tokio::time::timeout(Duration::from_secs(30), self.0.released.notified())
                .await
                .expect("the test to release the held connect within 30 s");
        }
    }
    fn connected(&self, scope: &str, op: &Op) {
        if self.0.scripted_57() || self.0.records_done.load(std::sync::atomic::Ordering::SeqCst) {
            self.0.push(Some(scope), one("connectDone", op_of(op)));
        }
    }
    fn cancelling_login(&self, server: &str) {
        if self.0.scripted_57() {
            self.0.push(None, one("cancelMcpLogin", json!(server)));
            self.0.released.notify_one();
        }
    }
}

struct Surface {
    cwd: PathBuf,
    seen: Arc<Seen>,
}

#[async_trait]
impl McpSurface for Surface {
    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(self.cwd.clone())
    }
    async fn thread_scope(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn refresh_surface(&self) {
        let runtime = self.seen.runtime.lock().unwrap().clone();
        self.seen.push(runtime.as_deref(), one("invalidatePreSessionToolSurface", json!(true)));
        if self.seen.recording.load(std::sync::atomic::Ordering::SeqCst) {
            self.seen.refreshed.notify_one();
        }
    }
    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn open_browser(&self, _: &str) {}
    fn announce_plugins(&self) {}
    async fn flush_skills_save(&self) {}
}

struct World {
    glue: Arc<McpGlue>,
    host: Arc<GlueHost>,
    seen: Arc<Seen>,
    _dir: tempfile::TempDir,
}

/// The real glue and host over a scratch data folder, its runtime scope connected and labelled `runtime` (none: not
/// labelled), and a session scope per `peers` label. Events are recorded from here on.
async fn world(runtime: Option<&str>, peers: &[&str]) -> World {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let data = dir.path().join("data");
    let cwd = dir.path().join("proj");
    std::fs::create_dir_all(&cwd).unwrap();
    let admin = Arc::new(PluginAdmin::new(data.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let hub = McpHub::new(
        mixdog_mcp::server::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io },
        data.join("tool-results"),
        mixdog_mcp::result::OutputPolicy::default(),
    );
    let seen = Arc::new(Seen::default());
    let glue = McpGlue::new(GlueInputs {
        hub,
        config: Arc::new(Config),
        admin,
        declarations: Arc::new(DeclarationCache::new()),
        maintenance: tokens.maintenance_io,
        oauth_env: OAuthEnv { store: Arc::new(NoSecrets), plugin_data: data.clone(), io: tokens.durability_io },
        env: std::env::vars().collect::<Env>(),
        surface: Arc::new(Surface { cwd: cwd.clone(), seen: seen.clone() }),
        health: Arc::new(AccountHealth::default()),
        login_feeds: Arc::new(mixdog_core_api::feed_publisher::LoginFeeds::new(Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(
            mixdog_core_api::mock::MockLimits::default(),
        )))),
    });
    let catalog = SkillCatalog::new(data, tokens.maintenance_io, Arc::new(|_: &InLane<MaintenanceIo>| Vec::<mixdog_mcp::skills::SkillRoot>::new()), Arc::new(NoSettings), &SkillsWatch::new());
    let host = Arc::new(GlueHost::new(glue.clone(), catalog));
    glue.connect_runtime_scope().await.expect("the runtime scope connects");
    if let Some(label) = runtime {
        seen.labels.lock().unwrap().insert(glue.hub().runtime_scope().to_owned(), label.to_owned());
        *seen.runtime.lock().unwrap() = Some(glue.hub().runtime_scope().to_owned());
    }
    for peer in peers {
        McpScopes::open(&*glue, peer, &format!("{peer}-session"), &cwd).await.expect("the session scope opens");
        seen.labels.lock().unwrap().insert((*peer).to_owned(), (*peer).to_owned());
    }
    glue.scope_runtime().watch(Arc::new(Watch(seen.clone())));
    seen.recording.store(true, std::sync::atomic::Ordering::SeqCst);
    World { glue, host, seen, _dir: dir }
}

/// `events` split by runtime label, each runtime's in its order (manifest: the order across runtimes is not compared).
fn by_runtime(events: &[Value]) -> Vec<(String, Vec<Value>)> {
    let mut out: Vec<(String, Vec<Value>)> = Vec::new();
    for event in events {
        let label = event["runtime"].as_str().unwrap_or_default().to_owned();
        match out.iter_mut().find(|(seen, _)| *seen == label) {
            Some((_, list)) => list.push(event.clone()),
            None => out.push((label, vec![event.clone()])),
        }
    }
    out
}

/// Line 17: a named reconnect (`only`, `drop`) and a full one reach every runtime: the writer applies them and its peers
/// get the same scoped change list (a full reset after the full one).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_17_named_mcp_reconnect_reaches_peers_as_a_scoped_change() {
    let case = case(17.0);
    let w = world(Some("writer"), &["peer"]).await;
    let mut results = Vec::new();
    for step in case.get("input").get("steps").as_array() {
        let args = step.get("args").as_array();
        let status = match args.first() {
            Some(options) => {
                let only = options.try_get("only").map(|only| only.as_str().to_owned());
                let enabled = options.try_get("enabled").is_none_or(|enabled| *enabled == Exact::Bool(true));
                let drop: Vec<String> = options.try_get("drop").map(|drop| drop.as_array().iter().map(|name| name.as_str().to_owned()).collect()).unwrap_or_default();
                w.host.reconnect_mcp_and_announce(only.as_deref(), enabled, &drop).await
            }
            None => w.host.reconnect_all_mcp_and_announce().await,
        };
        results.push(status);
    }
    let result = case.get("result");
    assert_eq!(statuses(&results), *result.get("results"), "line 17: the statuses");
    // The core's surface is the process's one: the peers' own invalidations are not compared (manifest).
    let recorded: Vec<Value> = result.get("events").to_plain().expect("plain").as_array().unwrap().iter().filter(|event| event["runtime"] == "writer" || event.get("invalidatePreSessionToolSurface").is_none()).cloned().collect();
    let expected = by_runtime(&recorded);
    let seen = by_runtime(&w.seen.events());
    // Groups taken in the recorded group order: which runtime connects first is not compared (manifest).
    let seen: Vec<(String, Vec<Value>)> = expected
        .iter()
        .map(|(label, _)| seen.iter().find(|(got, _)| got == label).cloned().unwrap_or((label.clone(), Vec::new())))
        .chain(seen.iter().filter(|(got, _)| !expected.iter().any(|(label, _)| label == got)).cloned())
        .collect();
    assert_eq!(seen, expected, "line 17: each runtime's events");
}

/// Line 39: enable, disable and a named reconnect run their connects and never start a sign-in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_39_enable_disable_reconnect_never_request_an_interactive_login() {
    let case = case(39.0);
    let w = world(Some("only"), &[]).await;
    let mut results = Vec::new();
    for step in case.get("input").get("steps").as_array() {
        let args = step.get("args").as_array();
        let status = match step.get("call").as_str() {
            "scheduleMcpToggle" => w.host.schedule_mcp_toggle(args[0].as_str(), args[1] == Exact::Bool(true)).await,
            _ => {
                let options = &args[0];
                w.host.reconnect_mcp_and_announce(Some(options.get("only").as_str()), *options.get("enabled") == Exact::Bool(true), &[]).await
            }
        };
        results.push(status);
    }
    let result = case.get("result");
    assert_eq!(statuses(&results), *result.get("results"), "line 39: the statuses");
    assert_eq!(plain(json!(w.seen.events())), *result.get("events"), "line 39: the events");
}

/// Line 57: a disable asked while the enable's connect is pending cancels the server's sign-in, rides the running chain
/// (the enable's connect ends, the disable's runs) and the surface is refreshed once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_57_disable_during_a_pending_enable_cancels_its_login() {
    let case = case(57.0);
    let w = world(None, &[]).await;
    w.seen.hold_enable.store(true, std::sync::atomic::Ordering::SeqCst);
    let steps = case.get("input").get("steps").as_array();
    let toggle = |step: &Exact| {
        let (host, args) = (w.host.clone(), step.get("args").as_array().to_vec());
        tokio::spawn(async move { host.schedule_mcp_toggle(args[0].as_str(), args[1] == Exact::Bool(true)).await })
    };
    let enable = toggle(&steps[0]);
    tokio::time::timeout(Duration::from_secs(30), w.seen.entered.notified()).await.expect("the enable's connect to start within 30 s");
    let disable = toggle(&steps[1]);
    let both = async { (enable.await.unwrap(), disable.await.unwrap()) };
    let (first, second) = tokio::time::timeout(Duration::from_secs(30), both).await.expect("both toggles to settle within 30 s");
    let result = case.get("result");
    assert_eq!(statuses(&[first, second]), *result.get("results"), "line 57: the statuses");
    assert_eq!(plain(json!(w.seen.events())), *result.get("events"), "line 57: the events");
}

/// Recorder case `overlapping-enables-connect-once`: an enable asked while the server's enable connect is pending rides
/// the running chain; the state asked did not change, so the server is connected once and the surface refreshed once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overlapping_enables_connect_once() {
    let case = recording().get("cases").as_array().iter().find(|case| case.get("name").as_str() == "overlapping-enables-connect-once").cloned().expect("the case");
    let w = world(None, &[]).await;
    w.seen.hold_once.store(true, std::sync::atomic::Ordering::SeqCst);
    w.seen.records_done.store(true, std::sync::atomic::Ordering::SeqCst);
    let steps = case.get("input").get("steps").as_array();
    let toggle = |step: &Exact| {
        let (host, args) = (w.host.clone(), step.get("args").as_array().to_vec());
        async move { host.schedule_mcp_toggle(args[0].as_str(), args[1] == Exact::Bool(true)).await }
    };
    let first = tokio::spawn(toggle(&steps[0]));
    tokio::time::timeout(Duration::from_secs(30), w.seen.entered.notified()).await.expect("the first enable's connect to start within 30 s");
    let mut second = Box::pin(toggle(&steps[1]));
    // Node asks both toggles before the pending connect ends: the second has joined the chain when it first waits.
    assert!(futures::poll!(second.as_mut()).is_pending(), "the second enable waits on the running chain");
    w.seen.released.notify_one();
    let both = async { (first.await.unwrap(), second.await) };
    let (first, second) = tokio::time::timeout(Duration::from_secs(30), both).await.expect("both toggles to settle within 30 s");
    let result = case.get("result");
    assert_eq!(statuses(&[first, second]), *result.get("results"), "the statuses");
    assert_eq!(plain(json!(w.seen.events())), *result.get("events"), "the events");
}

/// `scheduleMcpToggle` runs its toggle to the end whoever awaits it (`resource-extension-sync.mjs:56`): when the only caller is
/// cancelled while the connect is pending, the toggle still connects, refreshes the surface and frees its chain, and the
/// glue is not held by it afterwards.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_toggle_whose_callers_are_cancelled_completes_and_releases_the_glue() {
    let case = recording().get("cases").as_array().iter().find(|case| case.get("name").as_str() == "overlapping-enables-connect-once").cloned().expect("the case");
    let w = world(None, &[]).await;
    w.seen.hold_once.store(true, std::sync::atomic::Ordering::SeqCst);
    w.seen.records_done.store(true, std::sync::atomic::Ordering::SeqCst);
    let held_by_others = Arc::strong_count(&w.glue);
    let args = case.get("input").get("steps").as_array()[0].get("args").as_array().to_vec();
    let (host, name) = (w.host.clone(), args[0].as_str().to_owned());
    let caller = tokio::spawn(async move { host.schedule_mcp_toggle(&name, true).await });
    tokio::time::timeout(Duration::from_secs(30), w.seen.entered.notified()).await.expect("the enable's connect to start within 30 s");
    caller.abort();
    let ended = tokio::time::timeout(Duration::from_secs(30), caller).await.expect("the aborted caller's task to end within 30 s");
    assert!(ended.unwrap_err().is_cancelled(), "the only caller is cancelled while the connect is pending");
    w.seen.released.notify_one();
    tokio::time::timeout(Duration::from_secs(30), w.seen.refreshed.notified()).await.expect("the toggle to refresh the surface with no caller within 30 s");
    // A toggle asked next joins the chain if its cleanup has not run yet and starts a new one if it has; either way it ends
    // only after the chain it joined or started has dropped its glue.
    tokio::time::timeout(Duration::from_secs(30), w.host.schedule_mcp_toggle(args[0].as_str(), true))
        .await
        .expect("the next toggle to end after the chain it joined or started dropped its glue within 30 s");
    assert_eq!(Arc::strong_count(&w.glue), held_by_others, "no finished toggle holds the glue");
}

/// Line 86: a change reaches every other runtime, never the one that made it. The core's change is the writer's full
/// reconnect; each other scope that ran it is a receipt `{ to, kind: "mcp", detail: null }` (manifest).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_86_changes_fan_out_to_every_runtime_except_the_writer() {
    let case = case(86.0);
    let w = world(Some("writer"), &["peer"]).await;
    w.host.reconnect_all_mcp_and_announce().await;
    let mut receipts: Vec<Value> = Vec::new();
    for event in w.seen.events() {
        let to = event["runtime"].as_str().unwrap_or_default().to_owned();
        if to != "writer" && event.get("connect").is_some() {
            receipts.push(json!({ "to": to, "kind": "mcp", "detail": null }));
        }
    }
    let result = case.get("result");
    let got = Exact::Object(vec![("published".into(), Exact::Undefined), ("events".into(), plain(json!(receipts)))]);
    assert_eq!(got, *result, "line 86");
}

/// Line 99: a runtime that unsubscribed (a session scope released) receives no change.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_99_unsubscribed_runtimes_stop_receiving_changes() {
    let case = case(99.0);
    let w = world(Some("writer"), &["runtime"]).await;
    McpScopes::release(&*w.glue, "runtime-session");
    let kind = case.get("input").get("publish").get("args").as_array()[0].as_str().to_owned();
    w.host.announce(&kind).await;
    let receipts: Vec<Value> = w.seen.events().into_iter().filter(|event| event["runtime"] == "runtime" && event.get("connect").is_some()).collect();
    let got = Exact::Object(vec![("published".into(), Exact::Undefined), ("events".into(), plain(json!(receipts)))]);
    assert_eq!(got, *case.get("result"), "line 99");
}
