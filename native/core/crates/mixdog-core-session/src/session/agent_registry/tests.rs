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
    /// The index: one map per stored session.
    maps: Mutex<Vec<(String, Row)>>,
    /// The kept maps of deleted sessions (`StoreWorkers`' `KeptRows`): they outlive the index's rows and a restart.
    kept: Mutex<Vec<(String, Row)>>,
    sessions: Mutex<Vec<Row>>,
    headers: Mutex<HashMap<String, Row>>,
    dirs: Mutex<HashSet<String>>,
    /// The stored session records asked for.
    header_reads: std::sync::atomic::AtomicUsize,
    /// The process stops before its queued writes reach the store: they are lost.
    lose_writes: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl WorkerStore for Store {
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        let mut maps = self.maps.lock().unwrap().clone();
        let kept: Vec<(String, Row)> = self.kept.lock().unwrap().iter().filter(|(id, _)| !maps.iter().any(|(m, _)| m == id)).cloned().collect();
        maps.extend(kept);
        Ok(maps)
    }

    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        Ok(self.sessions.lock().unwrap().clone())
    }

    fn keep(&self, session: &str, worker: Option<Row>) {
        let mut kept = self.kept.lock().unwrap();
        kept.retain(|(id, _)| id != session);
        if let Some(map) = worker {
            kept.push((session.to_owned(), map));
        }
    }

    fn kept(&self, session: &str) -> bool {
        self.kept.lock().unwrap().iter().any(|(id, _)| id == session)
    }

    async fn header(&self, session: &str) -> Option<Row> {
        self.header_reads.fetch_add(1, Ordering::SeqCst);
        self.headers.lock().unwrap().get(session).cloned()
    }

    async fn is_directory(&self, path: &str) -> bool {
        self.dirs.lock().unwrap().contains(path)
    }

    fn write(&self, session: &str, worker: Option<Row>) {
        if self.lose_writes.load(Ordering::SeqCst) {
            return;
        }
        if WorkerStore::kept(self, session) {
            return self.keep(session, worker);
        }
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
    }
}

impl Store {
    fn map(&self, session: &str) -> Option<Row> {
        let maps = self.maps.lock().unwrap();
        let kept = self.kept.lock().unwrap();
        maps.iter().chain(kept.iter()).find(|(id, _)| id == session).map(|(_, m)| m.clone())
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

/// A session deleted while the daemon runs: Node's purge hook forgets it (`agent-tool.mjs:347`, `gone-rows.mjs:214`), its
/// index file keeps the working row, the Lead pool row and the owed restart failure, and every later listing shows them
/// (`store-agent-worker-rows.mjs` `projectChildWorkerRow` over a null header); the settled row leaves as a tombstone. The
/// core's index lists no row of a deleted session, so the registry keeps the rows Node keeps.
#[tokio::test]
async fn a_session_deleted_while_the_daemon_runs_keeps_the_rows_node_keeps() {
    let rig = Rig::new();
    // `isUnnotifiedRestartFailure`: failed by the process restart, its owner not told yet.
    let owed = json!({ "status": "failed", "failureReason": "process-restart" });
    for (id, tag, extra) in [
        ("s-done", "done", json!({ "cwd": "/w" })),
        ("s-busy", "busy", json!({ "status": "running" })),
        ("s-lead", "lead", json!({ "agent": "lead" })),
        ("s-owed", "owed", owed),
    ] {
        rig.store.write(id, Some(worker_row(id, tag, extra)));
    }
    let registry = rig.registry();
    let row_of = |(agents, leads): &(Value, Value), id: &str| {
        let rows = agents["workers"].as_array().unwrap().iter().chain(leads["workers"].as_array().unwrap());
        rows.filter(|row| row["sessionId"] == id).cloned().collect::<Vec<Value>>()
    };
    let before = registry.pool_index().await;
    let kept: Vec<(&str, Vec<Value>)> = ["s-busy", "s-lead", "s-owed"].into_iter().map(|id| (id, row_of(&before, id))).collect();
    for (id, rows) in &kept {
        assert_eq!(rows.len(), 1, "{id} is listed before the delete");
    }
    // The delete: the index drops every row of the deleted sessions.
    rig.store.maps.lock().unwrap().clear();
    assert!(registry.forget_deleted_session("s-done").await, "the settled row goes");
    for (id, _) in &kept {
        assert!(!registry.forget_deleted_session(id).await, "{id} stays");
    }
    for listing in 0..2 {
        let after = registry.pool_index().await;
        for (id, rows) in &kept {
            assert_eq!(&row_of(&after, id), rows, "listing {listing}: {id} as before the delete");
        }
        assert_eq!(row_of(&after, "s-done"), Vec::<Value>::new(), "listing {listing}: the settled row is gone");
        let tombstones = after.0["tombstones"].as_array().unwrap();
        assert_eq!(tombstones.iter().filter(|t| t["tag"] == "done").count(), 1, "listing {listing}: its tombstone: {tombstones:?}");
    }
}

/// A row kept for a session deleted while the core runs lives on as Node's does. Node's index file keeps it
/// (`gone-rows.mjs:214-226`, `forgetDeletedSession` takes only settled rows); `notifyRestartFailures` (`restart-notify.mjs:136`,
/// run at start and on each restart settlement, `agent-tool.mjs:103-105`, `:408-409`) tells its owner once and stamps it; and
/// `sweepGoneRows` (`gone-rows.mjs:162-200`, a maintenance step for every owner, `agent-tool.mjs:207`) tombstones it once it
/// is settled (`:107-115`: terminal, not owed, past the settled retention, no live work). Here: the owed failure is told
/// once after a restart of the core, and the told row leaves at the retention's end on the injected clock, by a refresh of
/// another owner's scope.
#[tokio::test]
async fn a_kept_row_is_told_once_survives_a_restart_and_leaves_once_settled() {
    struct Frozen(i64);
    impl mixdog_agent::env::Clock for Frozen {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }
    #[derive(Default)]
    struct Told(Mutex<Vec<(String, String)>>);
    #[async_trait]
    impl restart::RestartNotices for Told {
        async fn queue_durably(&self, owner: &ThreadId, execution: &str, _: String) -> Result<(), String> {
            self.0.lock().unwrap().push((owner.as_str().to_owned(), execution.to_owned()));
            Ok(())
        }
        async fn show(&self, _: &ThreadId, _: &str, _: String) {}
    }

    let rig = Rig::new();
    let owed = json!({ "status": "failed", "failureReason": "process-restart", "task_id": "t-1", "finishedAt": at(NOW), "updatedAt": at(NOW) });
    rig.store.write("s-owed", Some(worker_row("s-owed", "owed", owed)));
    let registry = rig.registry();
    registry.pool_index().await;
    // The delete: the index lists no row of the deleted session any more.
    rig.store.maps.lock().unwrap().clear();
    assert!(!registry.forget_deleted_session("s-owed").await, "an owed failure stays");
    assert!(WorkerStore::kept(&*rig.store, "s-owed"), "the row is kept apart from the index");
    drop(registry);

    // A restart of the core: a new registry over what was stored.
    let restarted = rig.registry();
    let pending: Vec<String> = restarted.pending_restart_failures().await.unwrap().into_iter().map(|(id, _)| id).collect();
    assert_eq!(pending, ["s-owed"], "the kept row is owed after the restart");
    let (told, board) = (Told::default(), mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(Frozen(NOW)), None, None));
    assert_eq!(restart::notify_restart_failures(&restarted, &told, &board, &at(NOW)).await.unwrap(), 1);
    assert_eq!(restart::notify_restart_failures(&restarted, &told, &board, &at(NOW)).await.unwrap(), 0, "told once");
    assert_eq!(*told.0.lock().unwrap(), [("lead-a".to_owned(), "restart:t-1".to_owned())]);
    assert_eq!(rig.store.map("s-owed").unwrap()["restartNotified"], json!(at(NOW)), "the stamp is kept with the row");

    async fn listed(registry: &AgentRegistry) -> bool {
        let (agents, _) = registry.pool_index().await;
        agents["workers"].as_array().unwrap().iter().any(|row| row["sessionId"] == "s-owed")
    }
    let other = lead("lead-b");
    rig.clock.0.store(NOW + DAY - 1, Ordering::SeqCst);
    restarted.refresh_tags_from_sessions(false, &other).await;
    assert!(listed(&restarted).await, "1 ms before the settled retention ends the row stays");
    rig.clock.0.store(NOW + DAY, Ordering::SeqCst);
    restarted.refresh_tags_from_sessions(false, &other).await;
    assert!(!listed(&restarted).await, "at the retention's end the told row leaves");
    let map = rig.store.map("s-owed").expect("its tombstone stays until its own end");
    assert!(!map.contains_key("sessionId") && map.contains_key("tombstone"), "{map:?}");
    // And a restart after that lists it no more.
    assert!(!listed(&rig.registry()).await);
}

/// `restart-notify.mjs:115-131`: the notice is stored under its stable id before the row is stamped, so a crash at any point
/// tells the owner exactly once. Each boundary is a process that stops there, then a restart (a new registry over what was
/// stored): before the notice is stored (nothing stored, the row still owed), after it is stored but before the stamp is
/// (the stamp's write lost: the restart queues the same id again, one entry), and after the stamp (nothing owed).
#[tokio::test]
async fn a_restart_failure_is_told_exactly_once_wherever_a_crash_stops_the_notice() {
    struct Frozen;
    impl mixdog_agent::env::Clock for Frozen {
        fn now_ms(&self) -> i64 {
            NOW
        }
    }
    /// The owner's queue: one entry per execution id, as the session's queue keeps one (`pendingIdStillQueued`).
    #[derive(Default)]
    struct Queue {
        stored: Mutex<Vec<(String, String)>>,
        crash_before_stored: std::sync::atomic::AtomicBool,
    }
    #[async_trait]
    impl restart::RestartNotices for Queue {
        async fn queue_durably(&self, owner: &ThreadId, execution: &str, _: String) -> Result<(), String> {
            if self.crash_before_stored.swap(false, Ordering::SeqCst) {
                return Err("the process stopped before the notice was stored".into());
            }
            let mut stored = self.stored.lock().unwrap();
            if !stored.iter().any(|(_, id)| id == execution) {
                stored.push((owner.as_str().to_owned(), execution.to_owned()));
            }
            Ok(())
        }
        async fn show(&self, _: &ThreadId, _: &str, _: String) {}
    }

    let rig = Rig::new();
    let owed = json!({ "status": "failed", "failureReason": "process-restart", "task_id": "t-1", "finishedAt": at(NOW), "updatedAt": at(NOW) });
    rig.store.write("s-owed", Some(worker_row("s-owed", "owed", owed)));
    let (queue, board) = (Queue::default(), mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(Frozen), None, None));
    let stamped = || rig.store.map("s-owed").unwrap().contains_key("restartNotified");
    let one = [("lead-a".to_owned(), "restart:t-1".to_owned())];

    queue.crash_before_stored.store(true, Ordering::SeqCst);
    assert_eq!(restart::notify_restart_failures(&rig.registry(), &queue, &board, &at(NOW)).await.unwrap(), 0);
    assert!(queue.stored.lock().unwrap().is_empty() && !stamped(), "stopped before the notice: nothing stored, still owed");

    rig.store.lose_writes.store(true, Ordering::SeqCst);
    restart::notify_restart_failures(&rig.registry(), &queue, &board, &at(NOW)).await.unwrap();
    rig.store.lose_writes.store(false, Ordering::SeqCst);
    assert_eq!(*queue.stored.lock().unwrap(), one, "the notice is stored");
    assert!(!stamped(), "stopped before the stamp was stored");

    assert_eq!(restart::notify_restart_failures(&rig.registry(), &queue, &board, &at(NOW)).await.unwrap(), 1, "the restart retries the row");
    assert_eq!(*queue.stored.lock().unwrap(), one, "under the same id: still one notice");
    assert!(stamped());

    assert_eq!(restart::notify_restart_failures(&rig.registry(), &queue, &board, &at(NOW)).await.unwrap(), 0, "after the stamp nothing is owed");
    assert_eq!(*queue.stored.lock().unwrap(), one);
}

/// Kept rows live in memory once loaded, and the table loses a kept map once it holds only a tombstone past the TTL, or one
/// beyond the newest [`MAX_TAG_TOMBSTONES`] (`worker-rows.mjs:7,96-102`: Node's index file is rewritten with only those).
#[tokio::test]
async fn expired_and_surplus_kept_tombstones_leave_the_kept_table() {
    let rig = Rig::new();
    let max = super::rows::MAX_TAG_TOMBSTONES;
    let tombstone = |n: usize, reaped: i64| obj(json!({ "tag": format!("t{n}"), "tombstone": { "tag": format!("t{n}"), "reapedAt": at(reaped), "ownerSessionId": "lead-a" } }));
    // One past the TTL, then MAX + 1 live ones, the oldest of which is beyond the cap.
    rig.store.keep("s-expired", Some(tombstone(0, NOW - super::rows::TAG_TOMBSTONE_TTL_MS as i64 - 1)));
    for n in 1..=max + 1 {
        rig.store.keep(&format!("s-{n}"), Some(tombstone(n, NOW - n as i64 * 1000)));
    }
    let kept = || rig.store.kept.lock().unwrap().iter().map(|(id, _)| id.clone()).collect::<HashSet<String>>();
    assert_eq!(kept().len(), max + 2);
    rig.registry().refresh_tags_from_sessions(false, &lead("lead-a")).await;
    let left = kept();
    assert_eq!(left.len(), max, "the table shrank");
    assert!(!left.contains("s-expired") && !left.contains(&format!("s-{}", max + 1)), "the expired one and the oldest beyond the cap left");
}

/// The production keeper reads its table once: later reads are memory, current with its own writes.
#[tokio::test]
async fn kept_rows_are_read_from_the_table_once_and_kept_current_in_memory() {
    let dir = tempfile::tempdir().unwrap();
    let t = mixdog_rt::testing::tokens();
    let (state, _) = mixdog_store::state::CoreState::open(t.sqlite_writer_thread, t.interactive_io, &dir.path().join("core.sqlite")).unwrap();
    let kept = KeptRows::new(state.clone());
    let row = obj(json!({ "sessionId": "s-1", "tag": "one" }));
    kept.put("s-1", Some(row.clone())).await.unwrap();
    // Written behind the keeper's back: a keeper that read the table again would list it.
    let text = serde_json::to_string(&row).unwrap();
    state.write(move |tx| tx.put_meta("agent-kept-worker:s-2", &text)).await.unwrap();
    assert_eq!(kept.load().await.unwrap(), [("s-1".to_owned(), row.clone())]);
    kept.put("s-1", None).await.unwrap();
    assert_eq!(kept.load().await.unwrap(), Vec::new());
}

/// The production keeper of those rows: what it kept is read back by a new keeper over the core's state database opened
/// again (a restart), and a row kept no more is gone from it.
#[tokio::test]
async fn kept_rows_are_read_back_after_the_core_state_is_opened_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let t = mixdog_rt::testing::tokens();
    let row = obj(json!({ "sessionId": "s-owed", "tag": "owed", "status": "failed" }));
    {
        let (state, _) = mixdog_store::state::CoreState::open(t.sqlite_writer_thread, t.interactive_io, &path).unwrap();
        KeptRows::new(state.clone()).put("s-owed", Some(row.clone())).await.unwrap();
        state.close();
    }
    let (state, _) = mixdog_store::state::CoreState::open(t.sqlite_writer_thread, t.interactive_io, &path).unwrap();
    let again = KeptRows::new(state);
    assert_eq!(again.load().await.unwrap(), [("s-owed".to_owned(), row)]);
    assert!(again.holds("s-owed"));
    again.put("s-owed", None).await.unwrap();
    assert_eq!(again.load().await.unwrap(), Vec::new());
    assert!(!again.holds("s-owed"));
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
