//! The statusline's gateway session routes, `<data>/gateway-session-routes.json`
//! (`vendor/statusline/src/gateway/session-routes.mjs`), kept in 1.4.5's format (the store
//! migration preserves it for its owner): a deleted or released session's route leaves it.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

use super::Clock;
use super::SystemClock;
use super::agent_registry::AgentStatusline;
use super::route_session::RouteStatusline;
use mixdog_core_ports::ports::route::Route;

use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `STORE_FILE`.
pub const STORE_FILE: &str = "gateway-session-routes.json";

/// `normalizeGatewaySessionId`: the trimmed id when it matches `/^[0-9a-z][0-9a-z._-]{7,}$/i`.
pub fn normalize_session_id(value: &str) -> Option<&str> {
    let id = mixdog_js::js_trim(value);
    let mut chars = id.chars();
    let first = chars.next()?.is_ascii_alphanumeric();
    let rest = chars.clone().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    (first && rest && chars.count() >= 7).then_some(id)
}

/// `{ ...map }` of a field read as `x && typeof x === 'object'`: an array spreads to its
/// index keys; anything else is empty.
fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        _ => Map::new(),
    }
}

/// `ROUTE_TTL_MS`: a route older than this belongs to a session whose provider pin is long gone.
const ROUTE_TTL_MS: f64 = 14.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const MAX_SESSION_ROUTES: usize = 300;
const MAX_HOST_ROUTES: usize = 100;

/// One queued route-store change (`queueChange`).
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    /// `writeGatewaySessionRoutes`' normalized entries.
    Entries(Vec<Entry>),
    /// `clearGatewaySessionRoute`.
    Clear { sid: String, pid: Option<u64> },
}

/// A normalized route entry: the session id, the route section and the client host pid (`None`
/// writes the legacy per-session slot).
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub sid: String,
    pub route: Map<String, Value>,
    pub pid: Option<u64>,
}

/// `Number(route?.updatedAt) || 0`.
fn updated_at(route: &Value) -> f64 {
    let at = mixdog_js::to_number_of(route.as_object().and_then(|object| object.get("updatedAt")));
    if at.is_nan() { 0.0 } else { at }
}

/// `pruneRouteMap`: routes inside the TTL with a stamp, newest first, at most `cap`.
fn prune_route_map(map: Map<String, Value>, now: f64, cap: usize) -> Map<String, Value> {
    let mut kept: Vec<(String, Value, f64)> = map
        .into_iter()
        .filter_map(|(key, route)| {
            let at = updated_at(&route);
            (at > 0.0 && now - at <= ROUTE_TTL_MS).then_some((key, route, at))
        })
        .collect();
    kept.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    kept.truncate(cap);
    kept.into_iter().map(|(key, route, _)| (key, route)).collect()
}

/// `hostRouteKey` of a normalized session id and client host pid.
fn host_key(sid: &str, pid: u64) -> String {
    format!("{sid}#{pid}")
}

/// `applyChanges(curRaw, changes)`: the store after `changes` in order, `None` when nothing
/// changed (Node's mutator answers `undefined` and nothing is written). Entries are written
/// with `now` as `updatedAt` and both maps pruned; a clear alone writes the maps unpruned.
pub fn apply_changes(raw: Option<Value>, changes: &[Change], now: i64) -> Option<Value> {
    let cur = match raw {
        Some(value @ (Value::Object(_) | Value::Array(_))) => value,
        _ => Value::Object(Map::new()),
    };
    let mut sessions = spread(cur.get("sessions"));
    let mut hosts = spread(cur.get("sessionHosts"));
    let (mut wrote, mut changed) = (false, false);
    for change in changes {
        match change {
            Change::Entries(entries) => {
                for Entry { sid, route, pid } in entries {
                    let mut stored = route.clone();
                    stored.insert("sessionId".into(), json!(sid));
                    if let Some(pid) = pid {
                        stored.insert("clientHostPid".into(), json!(pid));
                    }
                    stored.insert("updatedAt".into(), json!(now));
                    match pid {
                        Some(pid) => hosts.insert(host_key(sid, *pid), Value::Object(stored)),
                        None => sessions.insert(sid.clone(), Value::Object(stored)),
                    };
                }
                wrote = true;
            }
            Change::Clear { sid, pid } => {
                let gone = match pid {
                    Some(pid) => hosts.shift_remove(&host_key(sid, *pid)),
                    None => sessions.shift_remove(sid),
                };
                changed |= gone.is_some();
            }
        }
    }
    let at = now as f64;
    if wrote {
        let (sessions, hosts) = (prune_route_map(sessions, at, MAX_SESSION_ROUTES), prune_route_map(hosts, at, MAX_HOST_ROUTES));
        return Some(json!({ "version": 2, "updatedAt": now, "sessions": sessions, "sessionHosts": hosts }));
    }
    changed.then(|| json!({ "version": 2, "updatedAt": now, "sessions": sessions, "sessionHosts": hosts }))
}

/// One durable update of the store at `path` that lands `changes` (`updateJsonAtomic` with
/// `{ compact: true, backup: true }`).
pub fn apply_to_store(lane: &InLane<MaintenanceIo>, path: &Path, changes: &[Change], now: i64) -> Result<(), String> {
    let opts = mixdog_statefile::Opts { compact: true, backup: true, ..mixdog_statefile::Opts::default() };
    let mutate = |raw: Option<Value>| Ok::<_, std::convert::Infallible>(apply_changes(raw, changes, now));
    mixdog_statefile::update_json(lane, path, mutate, &opts).map(|_| ()).map_err(|e| e.to_string())
}

/// `clearGatewaySessionRoute(sessionId)` (no host pid) on `path`: the session's `sessions` entry
/// goes. As Node's mutator (`undefined` when nothing changed), a session with no entry leaves the
/// store untouched. False for an id the store never keys.
pub fn clear_session_route(lane: &InLane<MaintenanceIo>, path: &Path, session_id: &str, now_ms: i64) -> Result<bool, String> {
    let Some(sid) = normalize_session_id(session_id) else { return Ok(false) };
    apply_to_store(lane, path, &[Change::Clear { sid: sid.to_owned(), pid: None }], now_ms).map(|()| true)
}

/// `routeForStatusline(route)` through `normalizeGatewayRouteSection`: the section the store keeps
/// for a session's route, `None` when it has no usable provider and model (nothing is written).
/// The route fields are strings by contract; Node's `clean` stringifies a non-string display and
/// `cleanString` drops any other non-string.
pub fn statusline_section(route: &Map<String, Value>) -> Option<Map<String, Value>> {
    fn text(value: Option<&Value>) -> Option<&str> {
        value.and_then(Value::as_str).map(mixdog_js::js_trim).filter(|text| !text.is_empty())
    }
    let provider = text(route.get("provider"))?;
    let model = text(route.get("model"))?;
    let empty = Map::new();
    let preset = route.get("preset").and_then(Value::as_object).unwrap_or(&empty);
    // `clean(preset.modelDisplay) || clean(route.modelDisplay)`: `String(value ?? '')`, trimmed.
    let clean = |value: Option<&Value>| match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned(),
    };
    let display = Some(clean(preset.get("modelDisplay"))).filter(|text| !text.is_empty()).unwrap_or_else(|| clean(route.get("modelDisplay")));
    let mut out = Map::new();
    out.insert("mode".into(), json!("fixed"));
    out.insert("defaultProvider".into(), json!(provider));
    out.insert("defaultModel".into(), json!(model));
    let effort = text(route.get("effectiveEffort"));
    for (key, value) in [
        ("presetId", text(preset.get("id"))),
        ("presetName", text(preset.get("name"))),
        ("effort", effort),
        ("displayEffort", effort),
        ("modelDisplay", Some(display.as_str()).filter(|text| !text.is_empty())),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    let flag = |object: &Map<String, Value>| object.get("fast").and_then(Value::as_bool);
    if let Some(fast) = flag(route).or_else(|| flag(preset)) {
        out.insert("fast".into(), json!(fast));
    }
    Some(out)
}

/// `writeStatuslineRoute`'s entry for a session's route: nothing without a session id or a
/// usable route and a keyable id; the client host pid is the session's own or this process's.
pub fn statusline_entry(session: &str, route: &Map<String, Value>, client_host_pid: Option<u64>) -> Option<Entry> {
    if session.is_empty() {
        return None;
    }
    let route = statusline_section(route)?;
    let sid = normalize_session_id(session)?.to_owned();
    let pid = client_host_pid.filter(|pid| *pid > 0).unwrap_or_else(|| u64::from(std::process::id()));
    Some(Entry { sid, route, pid: Some(pid) })
}

struct Queued {
    change: Change,
    done: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Default)]
struct Queue {
    changes: Vec<Queued>,
    draining: bool,
}

struct Shared {
    path: PathBuf,
    clock: Arc<dyn Clock>,
    queue: Mutex<Queue>,
}

/// The data dir's gateway route store. This process's route changes queue in call order and one
/// durable update on the maintenance lane lands every change queued until it reads the store; the
/// next starts after it (`queueChange` / `drainChanges`), so a clear queued after a write is
/// applied after it.
#[derive(Clone)]
pub struct GatewaySessionRoutes {
    shared: Arc<Shared>,
    maintenance: MaintenanceIo,
}

impl GatewaySessionRoutes {
    /// Over `resolvePluginData()`.
    pub fn new(data_dir: &Path, maintenance: MaintenanceIo) -> Self {
        Self::with_clock(data_dir, maintenance, Arc::new(SystemClock))
    }

    /// `new` with the clock `updatedAt` is stamped from (`Date.now()`).
    pub fn with_clock(data_dir: &Path, maintenance: MaintenanceIo, clock: Arc<dyn Clock>) -> Self {
        let shared = Shared { path: data_dir.join(STORE_FILE), clock, queue: Mutex::new(Queue::default()) };
        Self { shared: Arc::new(shared), maintenance }
    }

    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.shared.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `queueChange`: appends `change` and starts the drain when none runs. `done` fires once the
    /// update that held the change has ended (landed or failed).
    fn enqueue(&self, change: Change, done: Option<tokio::sync::oneshot::Sender<()>>) {
        let start = {
            let mut queue = self.queue();
            queue.changes.push(Queued { change, done });
            !std::mem::replace(&mut queue.draining, true)
        };
        if !start {
            return;
        }
        let shared = self.shared.clone();
        if let Err(error) = self.maintenance.submit(&CancellationToken::new(), move |lane| drain(lane, &shared)) {
            // A route pin is best effort: the changes queued behind a refused drain are dropped.
            tracing::warn!(?error, "gateway route update refused by the maintenance lane");
            let mut queue = self.queue();
            queue.changes.clear();
            queue.draining = false;
        }
    }

    /// `statusRoutes.writeGatewaySessionRoute(...)` for a route entry; false when nothing is queued.
    fn write_entry(&self, entry: Option<Entry>, done: Option<tokio::sync::oneshot::Sender<()>>) -> bool {
        match entry {
            Some(entry) => {
                self.enqueue(Change::Entries(vec![entry]), done);
                true
            }
            None => false,
        }
    }

    /// `write` that returns once the update holding it has ended.
    pub async fn write_route(&self, session: &str, route: &Map<String, Value>, client_host_pid: Option<u64>) {
        let (done, wait) = tokio::sync::oneshot::channel();
        if self.write_entry(statusline_entry(session, route, client_host_pid), Some(done)) {
            let _ = wait.await;
        }
    }

    /// `statusRoutes.clearGatewaySessionRoute(id)` on the maintenance lane; returns once it has
    /// run. A failure is logged, as Node's caller ignores it. An id the store never keys is refused.
    pub async fn clear(&self, session_id: &str) {
        let Some(sid) = normalize_session_id(session_id) else { return };
        let (done, wait) = tokio::sync::oneshot::channel();
        self.enqueue(Change::Clear { sid: sid.to_owned(), pid: None }, Some(done));
        let _ = wait.await;
    }
}

/// `drainChanges`: until the queue is empty, one update that lands everything queued so far.
fn drain(lane: &InLane<MaintenanceIo>, shared: &Shared) {
    loop {
        let batch = {
            let mut queue = shared.queue.lock().unwrap_or_else(PoisonError::into_inner);
            if queue.changes.is_empty() {
                queue.draining = false;
                return;
            }
            std::mem::take(&mut queue.changes)
        };
        let (changes, done): (Vec<Change>, Vec<_>) = batch.into_iter().map(|queued| (queued.change, queued.done)).unzip();
        if let Err(error) = apply_to_store(lane, &shared.path, &changes, shared.clock.now_ms()) {
            // The changes this update held are dropped, never retried out of order.
            tracing::warn!(%error, "gateway route store not updated");
        }
        for done in done.into_iter().flatten() {
            let _ = done.send(());
        }
    }
}

/// `clearAgentStatuslineRoute(sessionId)` (agent-tool `helpers.mjs`): a closed worker's route
/// leaves the store. Node's call is synchronous and its store update off the caller, so the clear
/// is queued here and lands on the maintenance lane in call order, behind any write queued before.
impl AgentStatusline for GatewaySessionRoutes {
    fn clear(&self, session: &str) {
        let Some(sid) = normalize_session_id(session) else { return };
        self.enqueue(Change::Clear { sid: sid.to_owned(), pid: None }, None);
    }
}

impl RouteStatusline for GatewaySessionRoutes {
    /// `writeStatuslineRoute(statusRoutes, session, route)`: queues the session's route; the file
    /// lands off the caller (the maintenance lane), as Node's off-loop durable update.
    fn write(&self, session: &str, route: &Route, client_host_pid: Option<u64>) {
        self.write_entry(statusline_entry(session, route, client_host_pid), None);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::Ordering;

    use super::*;

    struct Fixed(Arc<AtomicI64>);
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn rig() -> (tempfile::TempDir, Arc<AtomicI64>, GatewaySessionRoutes) {
        let data = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicI64::new(0));
        let routes = GatewaySessionRoutes::with_clock(data.path(), mixdog_rt::testing::tokens().maintenance_io, Arc::new(Fixed(now.clone())));
        (data, now, routes)
    }

    fn text(path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    /// Node's `writeStatuslineRoute` into its real route store: the file and its `.bak` after each
    /// step are the recorded bytes. A step's calls run in one tick, so they land in one update.
    #[tokio::test]
    async fn the_route_store_bytes_equal_nodes() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/statusline-route/golden.json")).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 8);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let (data, clock, routes) = rig();
            let store = data.path().join(STORE_FILE);
            if let Some(initial) = case["initial"].as_str() {
                std::fs::write(&store, initial).unwrap();
            }
            for step in case["steps"].as_array().unwrap() {
                let calls = step["calls"].as_array().unwrap();
                clock.store(calls.last().unwrap()["now"].as_i64().unwrap(), Ordering::SeqCst);
                let usable: Vec<(&str, Option<u64>, &Map<String, Value>)> = calls
                    .iter()
                    .filter_map(|call| {
                        let id = call["session"]["id"].as_str()?;
                        Some((id, call["session"]["clientHostPid"].as_u64(), call["route"].as_object()?))
                    })
                    .collect();
                if calls.len() == 1 {
                    for (id, pid, route) in &usable {
                        routes.write_route(id, route, *pid).await;
                    }
                } else {
                    let entries: Vec<Entry> = usable.iter().filter_map(|(id, pid, route)| statusline_entry(id, route, *pid)).collect();
                    let (path, now) = (store.clone(), clock.load(Ordering::SeqCst));
                    let job = routes.maintenance.submit(&CancellationToken::new(), move |lane| apply_to_store(lane, &path, &[Change::Entries(entries)], now));
                    job.expect("lane").await.expect("ran").expect("updated");
                }
                assert_eq!(text(&store).as_deref(), step["file"].as_str(), "{name}: store");
                assert_eq!(text(&data.path().join(format!("{STORE_FILE}.bak"))).as_deref(), step["bak"].as_str(), "{name}: backup");
            }
        }
    }

    /// Without the session's own pid the route is keyed to this process (`session.clientHostPid ||
    /// process.pid`); no session id queues nothing.
    #[tokio::test]
    async fn a_session_without_a_host_pid_is_this_process() {
        let (data, clock, routes) = rig();
        clock.store(1_800_000_000_000, Ordering::SeqCst);
        let route: Map<String, Value> = serde_json::from_value(json!({ "provider": "openai", "model": "gpt-5" })).unwrap();
        routes.write_route("", &route, None).await;
        assert!(!data.path().join(STORE_FILE).exists());
        routes.write_route("sess_abcdef01", &route, None).await;
        let stored: Value = serde_json::from_str(&text(&data.path().join(STORE_FILE)).unwrap()).unwrap();
        let key = format!("sess_abcdef01#{}", std::process::id());
        assert_eq!(stored["sessionHosts"][&key]["clientHostPid"], json!(std::process::id()));
    }

    /// A clear queued after a write is applied after it, and returns once it has landed.
    #[tokio::test]
    async fn a_clear_after_a_write_removes_what_the_write_added() {
        let (data, clock, routes) = rig();
        clock.store(1_800_000_000_000, Ordering::SeqCst);
        let route = statusline_section(&serde_json::from_value(json!({ "provider": "openai", "model": "gpt-5" })).unwrap()).unwrap();
        // A legacy `sessions` slot (no host pid), written and then cleared in call order.
        routes.enqueue(Change::Entries(vec![Entry { sid: "sess_abcdef01".into(), route, pid: None }]), None);
        routes.clear("sess_abcdef01").await;
        let stored: Value = serde_json::from_str(&text(&data.path().join(STORE_FILE)).unwrap()).unwrap();
        assert_eq!((stored["sessions"].clone(), stored["sessionHosts"].clone()), (json!({}), json!({})));
    }

    /// The agent tool's synchronous clear drops the route of a closed worker; an id the store
    /// never keys is ignored. A later awaited clear is the barrier that the queue has drained.
    #[tokio::test]
    async fn the_agent_statusline_clear_removes_the_workers_route() {
        let (data, clock, routes) = rig();
        clock.store(1_800_000_000_000, Ordering::SeqCst);
        let route = statusline_section(&serde_json::from_value(json!({ "provider": "openai", "model": "gpt-5" })).unwrap()).unwrap();
        routes.enqueue(Change::Entries(vec![Entry { sid: "sess_abcdef01".into(), route, pid: None }]), None);
        AgentStatusline::clear(&routes, "not an id");
        AgentStatusline::clear(&routes, "sess_abcdef01");
        routes.clear("sess_barrier01").await;
        let stored: Value = serde_json::from_str(&text(&data.path().join(STORE_FILE)).unwrap()).unwrap();
        assert_eq!((stored["sessions"].clone(), stored["sessionHosts"].clone()), (json!({}), json!({})));
    }
}
