use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use serde_json::Value;
use serde_json::json;

use super::*;

const PID: u64 = 4242;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// 2026-11-06T00:00:00.000Z.
const NOW: i64 = 1_793_923_200_000;

fn obj(value: Value) -> Row {
    value.as_object().cloned().expect("an object")
}

fn at(ms: i64) -> String {
    iso(ms as f64)
}

#[derive(Default)]
struct Store {
    maps: Mutex<Vec<(String, Row)>>,
    sessions: Mutex<Vec<Row>>,
    headers: Mutex<HashMap<String, Row>>,
    dirs: Mutex<HashSet<String>>,
    /// The stored session records asked for.
    header_reads: std::sync::atomic::AtomicUsize,
    /// Every row write.
    written: tokio::sync::Notify,
    /// What a row write tells the agent status listener.
    on_write: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>,
}

#[async_trait]
impl WorkerStore for Store {
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        Ok(self.maps.lock().unwrap().clone())
    }

    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        Ok(self.sessions.lock().unwrap().clone())
    }

    async fn header(&self, session: &str) -> Option<Row> {
        self.header_reads.fetch_add(1, Ordering::SeqCst);
        self.headers.lock().unwrap().get(session).cloned()
    }

    async fn is_directory(&self, path: &str) -> bool {
        self.dirs.lock().unwrap().contains(path)
    }

    fn write(&self, session: &str, worker: Option<Row>) {
        self.write_row(session, worker);
        // `registry.onWorkerRowsChange`: the product's `StoreWorkers::write` announces each row change where it is made.
        if let Some(changed) = self.on_write.get() {
            changed();
        }
    }
}

impl Store {
    fn write_row(&self, session: &str, worker: Option<Row>) {
        let mut maps = self.maps.lock().unwrap();
        let at = maps.iter().position(|(id, _)| id == session);
        match (at, worker) {
            (Some(i), Some(m)) => maps[i].1 = m,
            (Some(i), None) => {
                maps.remove(i);
            }
            (None, Some(m)) => maps.insert(0, (session.to_owned(), m)),
            (None, None) => {}
        }
        drop(maps);
        self.written.notify_waiters();
    }
}

impl Store {
    fn map(&self, session: &str) -> Option<Row> {
        self.maps.lock().unwrap().iter().find(|(id, _)| id == session).map(|(_, m)| m.clone())
    }
}

#[derive(Default)]
struct Live {
    headers: Mutex<HashMap<String, Row>>,
}

impl LiveSessions for Live {
    fn loaded(&self) -> Vec<String> {
        self.headers.lock().unwrap().keys().cloned().collect()
    }

    fn header(&self, session: &str) -> Option<Row> {
        self.headers.lock().unwrap().get(session).cloned()
    }

    fn running(&self, _: &str) -> bool {
        false
    }

    fn has_live_work(&self, _: &str) -> bool {
        false
    }

    fn runtime_stage(&self, _: &str) -> Option<String> {
        None
    }
}

struct Hour;
impl ReapWindow for Hour {
    fn terminal_reap_ms(&self, _: &str) -> f64 {
        HOUR as f64
    }
}

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Rig {
    store: Arc<Store>,
    live: Arc<Live>,
    clock: Arc<TestClock>,
}

impl Rig {
    fn new() -> Self {
        Self { store: Arc::default(), live: Arc::default(), clock: Arc::new(TestClock(AtomicI64::new(NOW))) }
    }

    /// A registry over the rig's store: a fresh one is the next process.
    fn registry(&self) -> AgentRegistry {
        AgentRegistry::new(self.store.clone(), self.live.clone(), Arc::new(Hour), self.clock.clone())
    }
}

fn lead(id: &str) -> Scope {
    Scope { caller_session_id: Some(id.to_owned()), host_pid: None }
}

/// `tombstones.test.mjs` fixtures.
fn session(id: &str, tag: &str, created_at: &str, extra: Value) -> Row {
    let mut s = obj(json!({
        "id": id, "agentTag": tag, "parentSessionId": "lead-a", "ownerSessionId": "lead-a",
        "agent": "worker", "clientHostPid": PID, "status": "idle", "createdAt": created_at,
    }));
    s.extend(obj(extra));
    s
}

fn tombstone(tag: &str, reaped_at: &str, extra: Value) -> Row {
    let mut t = obj(json!({
        "tag": tag, "agent": "worker", "clientHostPid": PID,
        "parentSessionId": "lead-a", "ownerSessionId": "lead-a", "reapedAt": reaped_at,
    }));
    for (key, value) in obj(extra) {
        if value.is_null() {
            t.shift_remove(&key);
        } else {
            t.insert(key, value);
        }
    }
    t
}

fn worker_row(id: &str, tag: &str, extra: Value) -> Row {
    let mut r = obj(json!({
        "tag": tag, "sessionId": id, "parentSessionId": "lead-a", "ownerSessionId": "lead-a",
        "agent": "worker", "clientHostPid": PID, "status": "idle",
    }));
    r.extend(obj(extra));
    r
}

/// `tombstones.test.mjs` `setup()`: each tombstone on its session's map, with the row the
/// session has (a reaped session without one carries the tombstone's keys).
fn tombstone_rig() -> (Rig, Vec<(Row, String)>) {
    let rig = Rig::new();
    let three_hours = at(NOW - 3 * HOUR);
    let sessions = vec![
        session("s-blocked", "r1", &three_hours, json!({})),
        session("s-admitted", "r2", &three_hours, json!({})),
        session("s-row-reaped", "r3", &three_hours, json!({})),
        session("s-live", "live", &three_hours, json!({})),
        session("s-legacy", "legacy", &three_hours, json!({})),
        session("s-top", "top", &three_hours, json!({ "parentSessionId": "", "ownerSessionId": "" })),
        session("s-expired", "expired", &at(NOW - 9 * DAY), json!({})),
        session("s-new-turn", "turn", &three_hours, json!({ "turnStartedAt": at(NOW) })),
        session("s-other-lead", "other", &three_hours, json!({})),
    ];
    let reaped = at(NOW - HOUR);
    let rows = [
        worker_row("s-admitted", "r2", json!({ "turnStartedAt": at(NOW - 1000) })),
        worker_row("s-row-reaped", "r3", json!({ "createdAt": three_hours })),
        worker_row("s-live", "live", json!({ "createdAt": three_hours })),
    ];
    let legacy = json!({ "parentSessionId": null, "ownerSessionId": null });
    let tombstones = [
        ("s-blocked", tombstone("r1", &reaped, json!({}))),
        ("s-admitted", tombstone("r2", &reaped, json!({}))),
        ("s-row-reaped", tombstone("r3", &reaped, json!({}))),
        ("s-legacy", tombstone("legacy", &reaped, legacy.clone())),
        ("s-top", tombstone("top", &reaped, legacy)),
        ("s-expired", tombstone("expired", &at(NOW - (TAG_TOMBSTONE_TTL_MS as i64) - HOUR), json!({}))),
        ("s-new-turn", tombstone("turn", &reaped, json!({}))),
        ("s-other-x", tombstone("other", &reaped, json!({ "parentSessionId": "lead-b", "ownerSessionId": "lead-b" }))),
    ];
    for (id, t) in tombstones {
        let mut map = rows.iter().find(|r| r["sessionId"] == id).cloned().unwrap_or_default();
        map.insert("tombstone".into(), Value::Object(t));
        let map = if map.contains_key("sessionId") { map } else { without_row(&map).unwrap() };
        rig.store.write(id, Some(map));
    }
    for row in rows.iter().filter(|r| rig.store.map(r["sessionId"].as_str().unwrap()).is_none()) {
        rig.store.write(row["sessionId"].as_str().unwrap(), Some(row.clone()));
    }
    *rig.store.sessions.lock().unwrap() = sessions.clone();
    let mut checks: Vec<(Row, String)> = sessions.iter().map(|s| (s.clone(), clean(s.get("agentTag")))).collect();
    checks.push((sessions[3].clone(), "r1".into()));
    checks.push((sessions[0].clone(), "  r1  ".into()));
    checks.push((sessions[0].clone(), String::new()));
    checks.push((Row::new(), "r1".into()));
    let mut no_id = sessions[0].clone();
    no_id.insert("id".into(), json!(""));
    checks.push((no_id, "r1".into()));
    (rig, checks)
}

fn decisions(registry: &AgentRegistry, checks: &[(Row, String)]) -> Vec<bool> {
    let st = registry.lock();
    let by_key = st.tombstone_index(registry.now());
    checks.iter().map(|(s, tag)| registry.tombstone_blocks_scan(&st, s, tag, &by_key)).collect()
}

/// `tombstones.test.mjs` "scan decisions match the previous implementation": a tombstone
/// blocks a session created before the reap unless a row it admits proves a later turn; a
/// legacy tombstone, once its owner is resolved and it is consumed, blocks nothing.
#[tokio::test]
async fn a_tombstone_blocks_a_scan_of_its_reaped_session_only() {
    let (rig, checks) = tombstone_rig();
    let registry = rig.registry();
    registry.reload().await;
    let initial = [true, false, true, false, true, true, false, false, false, true, true, false, false, false];
    assert_eq!(decisions(&registry, &checks), initial);

    registry.resolve_tombstone_owners();
    assert_eq!(decisions(&registry, &checks), initial, "the recovered owner keeps it blocked");
    let legacy = registry.tag_tombstone_for_tag("legacy", &Scope::default()).expect("legacy tombstone");
    assert_eq!(legacy.owner.parent_session_id, "lead-a", "recovered from its one session");
    registry.consume_tag_tombstone(&legacy);
    assert!(!decisions(&registry, &checks)[4]);
    assert!(rig.store.map("s-legacy").is_none(), "nothing is left on the session");

    // A turn stamped after the reap is new work again.
    let mut turned = checks.clone();
    turned[0].0.insert("turnStartedAt".into(), json!(at(NOW + 1000)));
    assert!(!decisions(&registry, &turned)[0]);
}

/// Many rows and tombstones on top of [`tombstone_rig`]'s: sessions with a settled row, and sessions that kept
/// only the tombstone their reap left.
fn crowd(rig: &Rig, count: usize) {
    let (created, reaped) = (at(NOW - 3 * HOUR), at(NOW - HOUR));
    for i in 0..count {
        let id = format!("s-crowd-{i}");
        rig.store.write(&id, Some(worker_row(&id, &format!("c{i}"), json!({ "createdAt": created }))));
        let gone = obj(json!({ "tombstone": tombstone(&format!("g{i}"), &reaped, json!({})) }));
        rig.store.write(&format!("s-gone-{i}"), without_row(&gone));
    }
}

/// `decisions.md` "Node daemon hot paths found by profiling" 1: the agent status is recomputed on every session
/// activity change, and each recompute keyed every tombstone and tested every row again. With the worker index
/// unchanged a recompute does no per-tombstone and no per-row work; a write to the index is seen at once.
#[tokio::test]
async fn a_status_recompute_over_an_unchanged_index_visits_no_row_and_no_tombstone() {
    let (rig, _) = tombstone_rig();
    crowd(&rig, 40);
    let registry = rig.registry();
    let scope = lead("lead-a");
    let recompute = || async {
        registry.refresh_tags_from_sessions(false, &scope).await;
        (registry.session_entries(false, &scope), registry.read_worker_rows(&scope).unwrap(), registry.read_all_tag_tombstones())
    };

    let first = recompute().await;
    assert!(first.1.len() >= 40 && first.2.len() >= 40, "the index holds what the test counts: {} rows, {} tombstones", first.1.len(), first.2.len());
    let warmed = rows::work::counts();
    assert!(warmed.rows_normalized > 0 && warmed.tombstones_normalized > 0 && warmed.tombstones_keyed > 0 && warmed.rows_tested > 0, "{warmed:?}");
    for pass in 0..4 {
        assert_eq!(recompute().await, first, "pass {pass} answers what the first did");
    }
    assert_eq!(rows::work::counts(), warmed, "four recomputes of an unchanged index did per-row or per-tombstone work");

    // A write is seen by the next read, and costs one rebuild, not one per read.
    registry.mark_released(&["s-crowd-0".into()]);
    let released = |registry: &AgentRegistry| {
        let st = registry.lock();
        st.rows(&scope, registry.now()).iter().find(|r| r["tag"] == "c0").map(|r| r.get("released").cloned())
    };
    assert_eq!(released(&registry), Some(Some(json!(true))));
    let rebuilt = rows::work::counts();
    assert!(rebuilt.rows_normalized > warmed.rows_normalized);
    for _ in 0..3 {
        assert_eq!(released(&registry), Some(Some(json!(true))));
    }
    assert_eq!(rows::work::counts(), rebuilt);
}

/// What the registry's reads answer, whole, at its clock.
fn index_reads(registry: &AgentRegistry) -> (Vec<Row>, Vec<Row>, Vec<Row>, Vec<Row>) {
    let now = registry.now();
    let st = registry.lock();
    (
        st.rows(&Scope::default(), now).iter().cloned().collect(),
        st.all_rows(now).iter().cloned().collect(),
        st.stored_tombstones(now).iter().cloned().collect(),
        st.tombstones(now).iter().cloned().collect(),
    )
}

/// Reads that keep their answer while the index is unchanged still change with the clock exactly where a read
/// that keeps nothing does: a tombstone and a release marker end at the TTL, a tombstone stamped in the future
/// reads as now, and the clock going back reads as it did.
#[tokio::test]
async fn the_kept_reads_follow_the_clock_as_a_read_that_keeps_nothing_does() {
    let (rig, _) = tombstone_rig();
    crowd(&rig, 3);
    let future = obj(json!({ "tombstone": tombstone("fut", &at(NOW + 2 * HOUR), json!({})) }));
    rig.store.write("s-future", without_row(&future));
    let mut released = worker_row("s-released", "rel", json!({ "createdAt": at(NOW - 3 * HOUR) }));
    released.insert("releasedAt".into(), json!(at(NOW - 2 * DAY)));
    rig.store.write("s-released", Some(released));
    let kept = rig.registry();
    kept.reload().await;
    kept.resolve_tombstone_owners();

    let ttl = TAG_TOMBSTONE_TTL_MS as i64;
    // The reaps are at NOW - 1h and the marker at NOW - 2d: they end at NOW + ttl - 1h and NOW + ttl - 2d.
    let offsets = [0, 1, HOUR, 3 * HOUR, ttl - 2 * DAY, ttl - 2 * DAY + 1, ttl - HOUR, ttl - HOUR + 1, ttl + 1, ttl + DAY, 0, ttl - HOUR];
    for offset in offsets {
        rig.clock.0.store(NOW + offset, Ordering::SeqCst);
        let fresh = rig.registry();
        fresh.reload().await;
        fresh.resolve_tombstone_owners();
        let (have, want) = (index_reads(&kept), index_reads(&fresh));
        assert_eq!(have.0, want.0, "rows at +{offset}");
        assert_eq!(have.1, want.1, "all rows at +{offset}");
        assert_eq!(have.2, want.2, "stored tombstones at +{offset}");
        assert_eq!(have.3, want.3, "tombstones at +{offset}");
    }
}

/// The invalidation argument of the kept reads (`State::kept`, `window_at`) at its sharpest point: the exact instant a
/// tombstone, a release marker or a future-stamped tombstone starts to read differently. One registry keeps its answers
/// while the clock is walked up to, across and back over each such instant, a millisecond at a time, and at every
/// step its reads (all four index reads, and the scoped worker rows a tombstone blocks) equal those of a registry
/// that has kept nothing.
#[tokio::test]
async fn the_kept_reads_equal_a_fresh_computation_at_every_ms_around_each_expiry() {
    let (rig, _) = tombstone_rig();
    crowd(&rig, 2);
    let future_at = NOW + 2 * HOUR;
    let future = obj(json!({ "tombstone": tombstone("fut", &at(future_at), json!({})) }));
    rig.store.write("s-future", without_row(&future));
    // A legacy (owner-less) tombstone stamped in the future reads as `now`, so its identity moves with the clock, and the one
    // session that can have been its owner is found only from the instant that session exists at the tombstone's time.
    let created_at = NOW + HOUR;
    let owner = session("s-fut-legacy", "futleg", &at(created_at), json!({}));
    rig.store.sessions.lock().unwrap().push(owner);
    let legacy = json!({ "parentSessionId": null, "ownerSessionId": null });
    let future_legacy = obj(json!({ "tombstone": tombstone("futleg", &at(future_at), legacy) }));
    rig.store.write("s-fut-legacy", without_row(&future_legacy));
    let mut released = worker_row("s-released", "rel", json!({ "createdAt": at(NOW - 3 * HOUR) }));
    released.insert("releasedAt".into(), json!(at(NOW - 2 * DAY)));
    rig.store.write("s-released", Some(released));
    let kept = rig.registry();
    kept.reload().await;
    kept.resolve_tombstone_owners();

    let ttl = TAG_TOMBSTONE_TTL_MS as i64;
    let (reap_end, marker_end) = (NOW - HOUR + ttl, NOW - 2 * DAY + ttl);
    let scope = lead("lead-a");
    let reads = |registry: &AgentRegistry| {
        let scoped: Vec<Row> = registry.lock().rows(&scope, registry.now()).iter().cloned().collect();
        (index_reads(registry), scoped)
    };
    let tags = |rows: &[Row]| rows.iter().map(|r| clean(r.get("tag"))).collect::<Vec<_>>();
    let mut instants: Vec<i64> = [reap_end, marker_end, future_at, created_at, NOW].into_iter().flat_map(|b| (-2..=2).map(move |d| b + d)).collect();
    instants.sort_unstable();
    let back: Vec<i64> = instants.iter().rev().copied().collect();
    for now in instants.into_iter().chain(back) {
        rig.clock.0.store(now, Ordering::SeqCst);
        let fresh = rig.registry();
        fresh.reload().await;
        // A read made before the owners of this instant are resolved is kept, and the resolve must invalidate it (`owners` is
        // an input of `tombstones`): each refresh of the kept registry resolves the owners again, as the registry's own does.
        let _ = reads(&kept);
        kept.resolve_tombstone_owners();
        fresh.resolve_tombstone_owners();
        assert_eq!(reads(&kept), reads(&fresh), "at {now}");
        let (index, scoped) = reads(&kept);
        let future_legacy = index.3.iter().find(|t| t["tag"] == "futleg").expect("the future-stamped legacy tombstone is read at every instant");
        assert_eq!(rows::stamp_ms(future_legacy.get("reapedAt")) as i64, now.min(future_at), "a tombstone stamped in the future reads as now, at {now}");
        assert_eq!(clean(future_legacy.get("ownerSessionId")) == "lead-a", now >= created_at, "legacy owner recovered at {now}");
        // The boundaries are real: a tombstone is read through its last instant and not after, and the row it blocked
        // (r3, created before the reap) is work again only once the tombstone ended.
        assert_eq!(index.3.iter().any(|t| t["tag"] == "r3"), now <= reap_end, "r3 tombstone at {now}");
        assert_eq!(tags(&scoped).contains(&"r3".to_owned()), now > reap_end, "r3 row at {now}");
        assert_eq!(index.1.iter().any(|r| r["tag"] == "rel" && r.get("released") == Some(&json!(true))), now <= marker_end, "release marker at {now}");
    }
}

/// Hot path 2: whether a session is at work is answered from memory. No bookkeeping pass of the registry reads a
/// session's record (a busy worker's whole log) from the store.
#[tokio::test]
async fn a_bookkeeping_pass_over_running_rows_reads_no_session_record() {
    let rig = Rig::new();
    let created = at(NOW - HOUR);
    for i in 0..6 {
        let id = format!("s-run-{i}");
        let row = worker_row(&id, &format!("r{i}"), json!({ "status": "running", "stage": "streaming", "createdAt": created, "updatedAt": created }));
        rig.store.write(&id, Some(row));
        let header = obj(json!({ "agentTag": format!("r{i}"), "parentSessionId": "lead-a", "ownerSessionId": "lead-a", "agent": "worker", "status": "running", "createdAt": created }));
        rig.live.headers.lock().unwrap().insert(id, header);
    }
    let registry = rig.registry();
    let scope = lead("lead-a");
    for _ in 0..3 {
        registry.refresh_tags_from_sessions(true, &scope).await;
        assert_eq!(registry.session_entries(true, &scope).len(), 6);
        assert!(registry.read_worker_rows(&scope).unwrap().len() >= 6);
    }
    assert_eq!(rig.store.header_reads.load(Ordering::SeqCst), 0, "a pass loaded a session's record");
}

/// `worker-row-released.test.mjs` "close → restart + scan keeps the agent released" and "the
/// marker expires after 7 days on read": the owner's close survives a restart and a session
/// scan, and its `released` reading ends exactly at the TTL.
#[tokio::test]
async fn an_owner_close_keeps_the_agent_released_for_seven_days() {
    let rig = Rig::new();
    let created = at(NOW - HOUR);
    let rev = obj(json!({
        "id": "sess_rel_1", "agentTag": "rev", "ownerSessionId": "lead-rel", "parentSessionId": "lead-rel",
        "agent": "reviewer", "provider": "anthropic-oauth", "status": "idle",
        "createdAt": created, "updatedAt": created, "lastUsedAt": created,
    }));
    *rig.store.sessions.lock().unwrap() = vec![rev.clone()];
    let scope = lead("lead-rel");
    let row_of = |registry: &AgentRegistry| {
        let st = registry.lock();
        st.rows(&scope, registry.now()).into_iter().find(|r| r["tag"] == "rev")
    };

    let first = rig.registry();
    first.refresh_tags_from_sessions(false, &scope).await;
    first.bind_tag("rev", &session_facts(&rev), &at(NOW));
    assert!(!row_of(&first).expect("bound").contains_key("released"));
    // `close`: the row goes and the owner's marker is set.
    first.forget_terminal_session(Some("rev"), "sess_rel_1");
    first.mark_released(&["sess_rel_1".into()]);
    assert_eq!(rig.store.map("sess_rel_1"), Some(obj(json!({ "releasedAt": at(NOW) }))));

    let second = rig.registry();
    second.refresh_tags_from_sessions(true, &scope).await;
    assert_eq!(second.tag_session("rev").as_deref(), Some("sess_rel_1"), "the scan binds it again");
    assert_eq!(row_of(&second).expect("re-indexed")["released"], json!(true));
    assert!(!rig.store.map("sess_rel_1").unwrap().contains_key("released"), "released is never stored");

    rig.clock.0.store(NOW + 6 * DAY, Ordering::SeqCst);
    assert_eq!(row_of(&second).expect("row")["released"], json!(true), "still released on day 6");
    rig.clock.0.store(NOW + 7 * DAY + 1, Ordering::SeqCst);
    assert!(!row_of(&second).expect("row").contains_key("released"), "not released once 7 days passed");
}

/// `close-flow.stale-tag` shape: a tag without a session in scope does not resolve; a tag
/// bound twice across terminals is ambiguous; a row of another owner is invisible.
#[tokio::test]
async fn tags_resolve_inside_the_callers_scope_only() {
    let rig = Rig::new();
    for (id, owner) in [("sess_a", "lead-a"), ("sess_b", "lead-b")] {
        let header = obj(json!({
            "agentTag": "rev", "parentSessionId": owner, "ownerSessionId": owner, "agent": "reviewer",
            "status": "idle", "createdAt": at(NOW - HOUR), "cwd": "/w",
        }));
        rig.live.headers.lock().unwrap().insert(id.into(), header);
    }
    let registry = rig.registry();
    registry.refresh_tags_from_sessions(true, &lead("lead-a")).await;
    let none = ResolveOptions::default();
    assert_eq!(registry.resolve_tag("rev", &lead("lead-a"), none), Ok(Some("sess_a".into())));
    // lead-b's session is not indexed yet: only a scan finds it.
    assert_eq!(registry.resolve_tag("rev", &lead("lead-b"), none), Ok(None));
    let scan = ResolveOptions { scan_sessions: true, ..none };
    assert_eq!(registry.resolve_tag("rev", &lead("lead-b"), scan), Ok(Some("sess_b".into())));
    assert_eq!(registry.resolve_tag("rev", &lead("lead-c"), none), Ok(None));
    assert_eq!(registry.resolve_tag("sess_b", &lead("lead-a"), none), Ok(None));
    let everyone = Scope::default();
    assert_eq!(
        registry.resolve_tag("rev", &everyone, scan),
        Err("agent: tag \"rev\" is ambiguous across terminals; use sessionId".into())
    );
    // A trace check of an ambiguous tag raises the resolver's error to the caller.
    assert_eq!(
        TerminalTrace::has_terminal_trace(&registry, "rev", &everyone),
        Err("agent: tag \"rev\" is ambiguous across terminals; use sessionId".into())
    );
    assert_eq!(TerminalTrace::has_terminal_trace(&registry, "rev", &lead("lead-a")), Ok(false), "live: reused");
    let rows: Vec<String> = registry.read_worker_rows(&lead("lead-b")).unwrap().into_iter().map(|r| r.session_id).collect();
    assert_eq!(rows, ["sess_b"]);
}

/// The owners whose shells a close cancelled.
#[derive(Default)]
struct ClosedShells(Mutex<Vec<String>>);
impl crate::session::shell_jobs::OwnedShells for ClosedShells {
    fn cancel_owned(&self, owner: &mixdog_core_api::ids::ThreadId) {
        self.0.lock().unwrap().push(owner.as_str().to_owned());
    }
}

#[derive(Default)]
struct Statusline(Mutex<Vec<String>>);
impl AgentStatusline for Statusline {
    fn clear(&self, session: &str) {
        self.0.lock().unwrap().push(session.to_owned());
    }
}

/// `ask-turn-settle.mjs:137-139` stamps every completed turn; a turn start lifts the owner's
/// release (`worker-index.mjs:59`); an owner close (`bumpSessionGenerationAttempt` with
/// `ownerClose`) stamps the session durably, then cancels its running turn, leaving it open.
#[tokio::test(start_paused = true)]
async fn turns_stamp_the_session_and_an_owner_close_records_itself() {
    use std::sync::atomic::AtomicUsize;

    use mixdog_agent::agent_tool::host::Sessions;

    use crate::session::thread_state::SessionThreads;
    use crate::session::SessionDirectory;
    use crate::session::seams::RunOutcome;
    use crate::eventually_on;
    use crate::session::tests::idle;
    use crate::session::tests::start_thread;
    use crate::session::tests::turn;

    let srig = crate::session::testing::Rig::new();
    let runs = Arc::new(AtomicUsize::new(0));
    let counter = runs.clone();
    srig.set_script(Arc::new(move |run| {
        let first = counter.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if !first {
                run.cancel.cancelled().await;
                return RunOutcome::Interrupted;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    let rig = Rig::new();
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    assert!(srig.turn_starts.bind(registry.clone()).is_ok());
    let handle = start_thread(&directory).await;
    let id = handle.id.as_str().to_owned();

    turn(&handle, "one", "op-1").await;
    let stamped = eventually_on!(&[&handle.cell.stepped], || {
        let header = handle.cell.header.load_full();
        header.contains_key("lastTurnCompletedAt").then(|| (*header).clone())
    })
    .await;
    assert_eq!(stamped["closeProvenance"], json!(1));
    assert!(stamped["lastTurnCompletedAt"].is_number());

    registry.mark_released(std::slice::from_ref(&id));
    assert!(rig.store.map(&id).is_some_and(|m| m.contains_key("releasedAt")));
    turn(&handle, "two", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    assert!(rig.store.map(&id).is_none(), "the turn start lifted the release");

    let statusline = Arc::new(Statusline::default());
    let threads = Arc::new(SessionThreads::new(directory.clone()));
    let shells = Arc::new(ClosedShells::default());
    let read_state = Arc::new(mixdog_tools::fs::ReadState::default());
    let sessions = AgentSessions::new(directory.clone(), threads, registry.clone(), statusline.clone(), rig.clock.clone(), shells.clone(), read_state.clone());
    let options = mixdog_agent::agent_tool::host::CloseOptions { tombstone: false, owner_close: true };
    assert!(sessions.close_session(&id, "cli-agent-close", options).await);
    // `cancelOwnedShellTrees(id)` (`session-close.mjs:184`).
    assert_eq!(*shells.0.lock().unwrap(), [id.clone()]);
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let header = handle.cell.header.load_full();
    assert_eq!(header["ownerClosedAt"], json!(NOW));
    assert_eq!(header["detachedReason"], json!("cli-agent-close"));
    assert!(header["generation"].as_f64().is_some_and(|generation| generation >= 1.0), "the close moves the generation on (`lifecycle-barriers.mjs:272`)");
    assert_ne!(header.get("closed"), Some(&json!(true)), "the session stays open");
    sessions.clear_statusline_route(&id);
    assert_eq!(*statusline.0.lock().unwrap(), [id.clone()]);
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

/// The job board's cancel (`close_session(id, "agent-task-cancel", {tombstone: false,
/// owner_close: false})`) ends the worker's turn with Node's `closeSession` abort text, and the
/// session stays open without an owner-close stamp.
#[tokio::test(start_paused = true)]
async fn a_job_cancel_aborts_the_turn_with_the_close_session_text() {
    use mixdog_agent::agent_tool::host::Sessions;

    use crate::session::thread_state::SessionThreads;
    use crate::session::SessionDirectory;
    use crate::session::seams::RunOutcome;
    use crate::eventually_on;
    use crate::session::tests::idle;
    use crate::session::tests::start_thread;
    use crate::session::tests::turn;

    let srig = crate::session::testing::Rig::new();
    let aborted: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
    let seen = aborted.clone();
    srig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.cancel.cancelled().await;
            *seen.lock().unwrap() = Some(run.signal.reason());
            RunOutcome::Interrupted
        })
    }));
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    let rig = Rig::new();
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    let handle = start_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;

    let threads = Arc::new(SessionThreads::new(directory.clone()));
    let sessions = AgentSessions::new(
        directory.clone(),
        threads,
        registry,
        Arc::new(Statusline::default()),
        rig.clock.clone(),
        Arc::new(ClosedShells::default()),
        Arc::new(mixdog_tools::fs::ReadState::default()),
    );
    let options = mixdog_agent::agent_tool::host::CloseOptions { tombstone: false, owner_close: false };
    assert!(sessions.close_session(&id, "agent-task-cancel", options).await);
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(
        aborted.lock().unwrap().as_deref(),
        Some(format!("Session \"{id}\" closed: closeSession (reason=agent-task-cancel)").as_str())
    );
    let header = handle.cell.header.load_full();
    assert_eq!(header["detachedReason"], json!("agent-task-cancel"));
    assert!(header["generation"].as_f64().is_some_and(|generation| generation >= 1.0));
    assert!(header.get("ownerClosedAt").is_none(), "not an owner close");

    // `abortSessionTurn(id, reason)` for a session no outer turn holds.
    turn(&handle, "again", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    assert!(directory.abort_session_turn(&handle.id, "login-required"));
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(
        aborted.lock().unwrap().as_deref(),
        Some(format!("Session \"{id}\" closed: abortSessionTurn (reason=login-required)").as_str())
    );
    assert!(!directory.abort_session_turn(&mixdog_core_api::ids::ThreadId::from("sess_none"), "x"));
}

/// A virtual clock: it moves only when the test advances it, and a wait on it resolves at the advance that reaches it.
struct Virtual(tokio::sync::watch::Sender<i64>);
impl Virtual {
    fn advance(&self, ms: i64) {
        self.0.send_modify(|now| *now += ms);
    }
}
impl Clock for Virtual {
    fn now_ms(&self) -> i64 {
        *self.0.borrow()
    }
    fn until_ms(&self, at_ms: i64) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        let mut now = self.0.subscribe();
        Box::pin(async move {
            let _ = now.wait_for(|now| *now >= at_ms).await;
        })
    }
}

/// Resolves once `done` holds, re-checked at every row write; fails at the deadline naming `what`.
async fn until_written(store: &Store, what: &str, done: impl Fn() -> bool) {
    let wait = async {
        loop {
            let written = store.written.notified();
            tokio::pin!(written);
            written.as_mut().enable();
            if done() {
                return;
            }
            written.await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), wait).await.unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

/// The maintenance pass's deadline timer (`armDeadline`, maintenance-pass.mjs), on the registry's clock: a running row whose
/// session is gone leaves the index as a tombstone when the clock reaches its reap deadline, with no agent call, status read
/// or other event; a row already past its deadline when the timer starts (the core was down) is reaped at once (Node's first
/// pass looks at every deadline after 0); a row that became active again before its deadline is reaped at its new one.
#[tokio::test]
async fn a_rows_reap_deadline_tombstones_it_on_the_registry_clock_with_no_event() {
    let rig = Rig::new();
    let clock = Arc::new(Virtual(tokio::sync::watch::channel(NOW).0));
    let stamped = |due_in: i64| at(NOW - HOUR + due_in);
    let running = |id: &str, tag: &str, due_in: i64| worker_row(id, tag, json!({ "status": "running", "stage": "streaming", "createdAt": stamped(due_in), "updatedAt": stamped(due_in) }));
    rig.store.write("s-overdue", Some(running("s-overdue", "overdue", -60_000)));
    rig.store.write("s-late", Some(running("s-late", "late", 60_000)));
    rig.store.write("s-early", Some(running("s-early", "early", 10_000)));
    rig.store.write("s-active", Some(running("s-active", "active", 20_000)));
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), rig.live.clone(), Arc::new(Hour), clock.clone()));
    let reaped = |id: &str| rig.store.map(id).is_some_and(|map| map.contains_key("tombstone"));
    // The index is loaded (the boot's first read), then the timer starts.
    registry.refresh_tags_from_sessions(false, &lead("lead-b")).await;
    assert!(!reaped("s-overdue"), "another lead's read reaps nothing");
    let timer = tokio::spawn(AgentRegistry::keep_deadlines(Arc::downgrade(&registry)));
    until_written(&rig.store, "the row that came due while the core was down", || reaped("s-overdue")).await;
    assert!(!reaped("s-early") && !reaped("s-late") && !reaped("s-active"), "nothing else is due yet");

    // `s-active` works again 5 s in: its stamps move, and its deadline with them.
    clock.advance(5_000);
    {
        let mut st = registry.lock();
        let mut active = st.map("s-active").cloned().expect("the active row");
        active.insert("updatedAt".into(), json!(at(NOW + 5_000)));
        registry.persist(&mut st, "s-active", Some(active));
    }
    clock.advance(4_999);
    assert!(!reaped("s-early"), "not before its deadline");
    clock.advance(1);
    until_written(&rig.store, "the early row's tombstone at its deadline", || reaped("s-early")).await;
    assert!(!reaped("s-late") && !reaped("s-active"), "the others are not due yet");
    clock.advance(10_000);
    assert!(!reaped("s-active"), "its old deadline has passed, its new one (an hour after it worked) has not");
    clock.advance(40_000);
    until_written(&rig.store, "the late row's tombstone at its deadline", || reaped("s-late")).await;
    assert!(!reaped("s-active"), "the active row is not due yet");
    // Now NOW + 60 s; its new deadline is NOW + 5 s + the reap window.
    clock.advance(HOUR - 55_001);
    assert!(!reaped("s-active"), "not before its new deadline");
    clock.advance(1);
    until_written(&rig.store, "the active row's tombstone at its new deadline", || reaped("s-active")).await;
    drop(registry);
    clock.advance(HOUR);
    tokio::time::timeout(std::time::Duration::from_secs(10), timer).await.expect("the timer ends with its registry").unwrap();
}

/// `fixtures/agent-row-deadline` (record-agent-row-deadline.mjs): a Lead's settled worker rows leave the index at their
/// retention deadlines, on the registry's clock, as Node's maintenance pass removed them, and what the Lead's clients are
/// told is what Node's were: the status the thread publishes (`thread/agents/updated`, Node's `agentStatusState` after an
/// `onStatusChange`) lists none of them and changes at no removal, so nothing is published. The row due while the core was
/// down: Node removes it at its first pass, one event delay (1 s) after the Lead's first status read; the core removes it
/// at the timer's first look, before that read, so the first two steps differ by that row alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_leads_clients_are_told_of_rows_reaped_at_their_deadline_what_nodes_were() {
    use crate::session::SessionDirectory;
    use crate::session::agent_activity::AgentStatus;
    use crate::session::agent_registry::status_rows::AgentToolStatus;
    use crate::session::tests::caught_up;
    use crate::session::tests::start_thread;
    use mixdog_app_protocol::v2::thread::ThreadAgents;
    use mixdog_core_api::ids::ThreadId;

    struct NoJobs;
    impl mixdog_core_run::run_host::progress::WaitedJobs for NoJobs {
        fn silence(&self, _: &[String], _: i64) -> Option<mixdog_agent::agent_tool::progress::ToolSilence> {
            None
        }
    }
    /// The directory reads its threads' status through this; it is bound once the status is built over the directory.
    #[derive(Default)]
    struct LateStatus(std::sync::OnceLock<Arc<AgentToolStatus>>);
    #[async_trait]
    impl AgentStatus for LateStatus {
        async fn status(&self, thread: &ThreadId) -> ThreadAgents {
            self.0.get().expect("bound").status(thread).await
        }
    }

    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/agent-row-deadline/golden.json")).unwrap();
    let t0 = golden["t0"].as_i64().unwrap();
    let srig = crate::session::testing::Rig::new();
    let late = Arc::new(LateStatus::default());
    let mut deps = srig.deps_parts(srig.store.clone());
    deps.agent_status = late.clone() as Arc<dyn AgentStatus>;
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    let lead = start_thread(&directory).await;
    let rig = Rig::new();
    let clock = Arc::new(Virtual(tokio::sync::watch::channel(t0).0));
    for row in golden["rows"].as_array().unwrap() {
        let stamp = row["stampedAt"].clone();
        let id = row["sessionId"].as_str().unwrap();
        rig.store.write_row(
            id,
            Some(obj(json!({
                "tag": row["tag"], "sessionId": id, "ownerSessionId": lead.id.as_str(), "parentSessionId": lead.id.as_str(),
                "agent": "worker", "provider": "p", "model": "m", "status": "idle", "stage": "idle", "clientHostPid": PID,
                "createdAt": stamp, "updatedAt": stamp, "finishedAt": stamp,
            }))),
        );
    }
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), clock.clone()));
    /// The status reads the same virtual time through the run's clock trait.
    struct RunClock(Arc<Virtual>);
    impl mixdog_agent::env::Clock for RunClock {
        fn now_ms(&self) -> i64 {
            Clock::now_ms(self.0.as_ref())
        }
    }
    late.0.set(Arc::new(AgentToolStatus::new(registry.clone(), mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(RunClock(clock.clone())), None, None), directory.clone(), Arc::new(NoJobs), clock.clone()))).ok();
    // The one listener of the row signal (`AgentActivity::everyone`): every loaded thread re-reads its status.
    let weak = Arc::downgrade(&directory);
    rig.store.on_write.set(Box::new(move || {
        if let Some(directory) = weak.upgrade() {
            for thread in directory.loaded_ids() {
                directory.agent_activity(thread.as_str());
            }
        }
    })).ok();
    let timer = tokio::spawn(AgentRegistry::keep_deadlines(Arc::downgrade(&registry)));

    let tags = |tombstoned: bool| {
        let mut tags: Vec<String> = rig
            .store
            .maps
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(_, map)| if tombstoned { map.get("tombstone").and_then(|t| t.get("tag")) } else { map.get("sessionId").and(map.get("tag")) })
            .map(|tag| tag.as_str().unwrap().to_owned())
            .collect();
        tags.sort();
        tags
    };
    let published = || srig.feeds.frames(lead.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/agents/updated").count();
    // The thread's status pass at load (Node's runtime publishes its `agentWorkers` once as it loads, not through
    // `onStatusChange`): what follows is counted from it.
    crate::eventually_on!(&[&srig.feeds.published], || (published() == 1).then_some(())).await;
    let mut told = 1;
    for step in golden["steps"].as_array().unwrap() {
        let (step_at, what) = (step["at"].as_i64().unwrap(), step["what"].as_str().unwrap());
        let shift = Clock::now_ms(clock.as_ref()) - t0;
        clock.advance(step_at - shift);
        if step_at == 5000 {
            // The active row worked again and settled: its stamps move to now.
            let mut st = registry.lock();
            let mut active = st.map("sess_rows_active").cloned().expect("the active row");
            let now = json!(at(t0 + 5000));
            active.insert("updatedAt".into(), now.clone());
            active.insert("finishedAt".into(), now);
            registry.persist(&mut st, "sess_rows_active", Some(active));
        }
        let strings = |key: &str| step[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
        let (mut indexed, mut tombstoned) = (strings("indexed"), strings("tombstones"));
        if step_at < 1000 {
            // The core's timer removed the overdue row before the Lead's first read.
            indexed.retain(|tag| tag != "overdue");
            tombstoned.push("overdue".into());
            tombstoned.sort();
        }
        until_written(&rig.store, what, || tags(false) == indexed && tags(true) == tombstoned).await;
        let status = AgentStatus::status(late.as_ref(), &lead.id).await;
        let workers: Vec<String> = status.agent_workers.iter().map(|w| format!("{}:{}", w["tag"].as_str().unwrap(), w["status"].as_str().unwrap())).collect();
        assert_eq!(workers, strings("workers"), "{what}: the workers the Lead's status lists");
        caught_up(&lead).await;
        let now = published();
        assert_eq!((now - told) as u64, step["announced"].as_u64().unwrap(), "{what}: the status changes the Lead's clients were told");
        told = now;
        assert_eq!((tags(false), tags(true)), (indexed, tombstoned), "{what}: nothing else left the index");
    }
    // The directory's status holds the registry, so the timer is stopped here rather than by the registry going.
    timer.abort();
}

/// A settled row past its retention and its continuation window becomes a tombstone when the
/// registry refreshes (`transitionStaleNonterminalRows`); the tombstone keeps the row's keys
/// for the index, and a reuse of the tag consumes it.
#[tokio::test]
async fn a_settled_row_ages_into_a_tombstone_and_a_reuse_consumes_it() {
    let rig = Rig::new();
    let old = at(NOW - 2 * DAY);
    rig.store.write("sess_old", Some(worker_row("sess_old", "fix", json!({ "createdAt": old, "updatedAt": old, "cwd": "/w" }))));
    let registry = rig.registry();
    let scope = lead("lead-a");
    registry.refresh_tags_from_sessions(false, &scope).await;
    assert_eq!(
        rig.store.map("sess_old"),
        Some(obj(json!({
            "tag": "fix", "parentSessionId": "lead-a", "ownerSessionId": "lead-a", "clientHostPid": PID,
            "tombstone": {
                "tag": "fix", "agent": "worker", "cwd": "/w", "clientHostPid": PID,
                "parentSessionId": "lead-a", "ownerSessionId": "lead-a", "reapedAt": at(NOW),
            },
        })))
    );
    assert!(registry.read_worker_rows(&scope).unwrap().is_empty());
    let tombstone = registry.tag_tombstone_for_tag("fix", &scope).expect("tombstone");
    assert_eq!((tombstone.session_id.as_str(), tombstone.agent.as_str(), tombstone.cwd.as_str()), ("sess_old", "worker", "/w"));
    assert!(registry.tag_tombstone_for_tag("fix", &lead("lead-b")).is_none());
    registry.consume_tag_tombstone(&tombstone);
    assert!(rig.store.map("sess_old").is_none());
    assert!(registry.read_all_tag_tombstones().is_empty());
}

/// `forgetDeletedSession` (`gone-rows.mjs`): a deleted session's settled row leaves the index as
/// a tombstone; a working row, a Lead pool row and an owed restart failure stay.
#[tokio::test]
async fn a_deleted_sessions_settled_row_becomes_a_tombstone() {
    let rig = Rig::new();
    rig.store.write("s-done", Some(worker_row("s-done", "done", json!({ "cwd": "/w" }))));
    rig.store.write("s-busy", Some(worker_row("s-busy", "busy", json!({ "status": "running" }))));
    rig.store.write("s-lead", Some(worker_row("s-lead", "lead", json!({ "agent": "lead" }))));
    let registry = rig.registry();

    assert!(registry.forget_deleted_session(" s-done ").await);
    let map = rig.store.map("s-done").expect("the tombstone stays");
    assert!(!map.contains_key("sessionId"), "the row is gone: {map:?}");
    assert_eq!(
        map["tombstone"],
        json!({
            "tag": "done", "agent": "worker", "cwd": "/w", "clientHostPid": PID,
            "parentSessionId": "lead-a", "ownerSessionId": "lead-a", "reapedAt": at(NOW),
        })
    );
    for kept in ["s-busy", "s-lead", "s-missing", ""] {
        assert!(!registry.forget_deleted_session(kept).await, "{kept}");
    }
    assert!(rig.store.map("s-busy").unwrap().contains_key("sessionId"));
    assert!(rig.store.map("s-lead").unwrap().contains_key("sessionId"));
}

/// Releasing a tag whose session was deleted: Node's `closeSession` counts a record that is
/// already gone as closed (`session-close.mjs` `finishClose`, `outcome.absent`), so the close
/// flow goes on to forget the row and the tag can start a fresh session.
#[tokio::test]
async fn closing_a_deleted_session_counts_as_closed() {
    use mixdog_agent::agent_tool::host::Sessions;

    use crate::session::thread_state::SessionThreads;
    use crate::session::SessionDirectory;

    let srig = crate::session::testing::Rig::new();
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    let rig = Rig::new();
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    let sessions = AgentSessions::new(
        directory.clone(),
        Arc::new(SessionThreads::new(directory.clone())),
        registry,
        Arc::new(Statusline::default()),
        rig.clock.clone(),
        Arc::new(ClosedShells::default()),
        Arc::new(mixdog_tools::fs::ReadState::default()),
    );
    let options = mixdog_agent::agent_tool::host::CloseOptions { tombstone: false, owner_close: true };
    assert!(sessions.close_session("sess_deleted", "cli-agent-close", options).await);
}

/// `lead-worker-index.mjs` `updateLeadWorkerCwd` against the real Node index
/// (`fixtures/desktop/settings/lead-worker-cwd-twin.json`): every call answers what Node's did and
/// leaves, for each Lead row of its scenario, the row text Node left (key order included).
#[tokio::test]
async fn the_lead_row_follows_the_cwd_as_the_recorded_node_index_moved_it() {
    let twin: Value = serde_json::from_str(include_str!("../../../../../fixtures/desktop/settings/lead-worker-cwd-twin.json")).unwrap();
    for scenario in twin["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let rig = Rig::new();
        let mut seeded = HashMap::new();
        for text in scenario["seed"].as_array().unwrap() {
            let row = obj(serde_json::from_str(text.as_str().unwrap()).unwrap());
            let id = clean_str(row["sessionId"].as_str().unwrap());
            rig.store.headers.lock().unwrap().insert(id.clone(), obj(json!({ "worker": row.clone() })));
            seeded.insert(id, row);
        }
        let registry = rig.registry();
        for step in scenario["steps"].as_array().unwrap() {
            let (id, cwd) = (step["args"][0].as_str().unwrap(), step["args"][1].as_str().unwrap());
            let label = format!("{name}: {id:?} {cwd:?}");
            assert_eq!(registry.update_lead_worker_cwd(id, cwd).await, step["returns"], "{label}: answer");
            for (key, want) in step["rows"].as_object().unwrap() {
                let have = rig.store.map(key).or_else(|| seeded.get(key).cloned()).unwrap();
                assert_eq!(Value::Object(have).to_string(), want.as_str().unwrap(), "{label}: row {key}");
            }
        }
    }
}

/// A session the store does not hold has no row to move, and an agent row is not a Lead row.
#[tokio::test]
async fn only_an_existing_lead_row_moves() {
    let rig = Rig::new();
    rig.store.headers.lock().unwrap().insert("s-agent".into(), obj(json!({ "worker": worker_row("s-agent", "tag-a", json!({ "cwd": "/old" })) })));
    let registry = rig.registry();
    assert!(registry.update_lead_worker_cwd("s-agent", "/new").await);
    assert!(registry.update_lead_worker_cwd("s-absent", "/new").await);
    assert!(rig.store.map("s-agent").is_none() && rig.store.map("s-absent").is_none());
}

/// The exit flush settles the rows this process wrote as active and still holds, as failed
/// `process-restart` and stamped now; a row another process took over, and a row that went idle, stay.
#[test]
fn exit_flush_fails_only_the_rows_this_process_still_runs() {
    struct Alive;
    impl restart::ProcessProbe for Alive {
        fn alive(&self, _: u64) -> bool {
            true
        }
    }
    let rig = Rig::new();
    let registry = rig.registry();
    let active = |id: &str, pid: u64| worker_row(id, id, json!({ "status": "running", "stage": "streaming", "runtimePid": pid }));
    {
        let mut st = registry.lock();
        registry.persist(&mut st, "s-own", Some(active("s-own", PID)));
        registry.persist(&mut st, "s-taken", Some(active("s-taken", PID)));
        registry.persist(&mut st, "s-idle", Some(active("s-idle", PID)));
        registry.persist(&mut st, "s-other", Some(active("s-other", PID + 1)));
        registry.persist(&mut st, "s-idle", Some(worker_row("s-idle", "s-idle", json!({ "runtimePid": PID }))));
        registry.persist(&mut st, "s-taken", Some(active("s-taken", PID + 1)));
    }
    let running = |_: &str| false;
    let live = restart::Liveness { probe: &Alive, own_pid: PID, running: &running, reap: &Hour, now_ms: NOW };
    registry.flush_active_worker_rows(&live);
    let own = rig.store.map("s-own").unwrap();
    assert_eq!((own["status"].as_str(), own["failureReason"].as_str(), own["updatedAt"].as_str()), (Some("failed"), Some("process-restart"), Some(at(NOW).as_str())));
    for kept in ["s-taken", "s-other"] {
        assert_eq!(rig.store.map(kept).unwrap()["status"], "running", "{kept}");
    }
    assert_eq!(rig.store.map("s-idle").unwrap()["status"], "idle");
    // A second flush has nothing left to settle.
    registry.flush_active_worker_rows(&live);
    assert_eq!(rig.store.map("s-other").unwrap()["status"], "running");
}
