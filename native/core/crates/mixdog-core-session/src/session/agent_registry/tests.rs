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
    /// Every row write.
    written: tokio::sync::Notify,
    /// What a row write tells the agent status listener.
    on_write: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// Reading the index takes a turn of the executor, as a read of the stored index does.
    slow: std::sync::atomic::AtomicBool,
    /// Bumped by each change of the index, the kept maps or the agent sessions.
    revision: std::sync::atomic::AtomicU64,
    /// An index read fails.
    fail: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl WorkerStore for Store {
    async fn index_since(&self, since: Option<Revision>) -> Result<Index, String> {
        // What the read saw is fixed before it takes its turn.
        let index = self.index_at(since);
        if self.slow.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err("the index cannot be read".into());
        }
        Ok(index)
    }

    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        Ok(self.listed())
    }

    fn kept_sessions(&self) -> Vec<String> {
        self.kept.lock().unwrap().iter().map(|(id, _)| id.clone()).collect()
    }

    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        Ok(self.sessions.lock().unwrap().clone())
    }

    fn keep(&self, session: &str, worker: Option<Row>) {
        self.revision.fetch_add(1, Ordering::SeqCst);
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
        if WorkerStore::kept(self, session) {
            self.keep(session, worker);
        } else {
            self.write_row(session, worker);
        }
        // `registry.onWorkerRowsChange`: the product's `StoreWorkers::write` announces each row change where it is made.
        if let Some(changed) = self.on_write.get() {
            changed();
        }
    }
}

impl Store {
    fn write_row(&self, session: &str, worker: Option<Row>) {
        let mut maps = self.maps.lock().unwrap();
        self.revision.fetch_add(1, Ordering::SeqCst);
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
    /// The agent sessions, or the index, were changed in place.
    fn touch_sessions(&self) {
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    /// The index's maps, then the kept maps of sessions it does not list.
    fn listed(&self) -> Vec<(String, Row)> {
        let mut maps = self.maps.lock().unwrap().clone();
        let kept: Vec<(String, Row)> = self.kept.lock().unwrap().iter().filter(|(id, _)| !maps.iter().any(|(m, _)| m == id)).cloned().collect();
        maps.extend(kept);
        maps
    }

    /// The index as a load holding revision `since` is handed it: nothing when nothing was written since, else all of it.
    fn index_at(&self, since: Option<Revision>) -> Index {
        let revision = Revision { index: self.revision.load(Ordering::SeqCst), generation: 0, kept: 0 };
        if since == Some(revision) {
            return Index::Unchanged;
        }
        let maps = self.listed().into_iter().enumerate().map(|(at, (id, map))| (id, Place::At(at as i64), map)).collect();
        let sessions = self.sessions.lock().unwrap().iter().enumerate().map(|(at, s)| (Place::At(at as i64), s.clone())).collect();
        Index::Full { revision: Some(revision), maps, sessions }
    }

    fn map(&self, session: &str) -> Option<Row> {
        let maps = self.maps.lock().unwrap();
        let kept = self.kept.lock().unwrap();
        maps.iter().chain(kept.iter()).find(|(id, _)| id == session).map(|(_, m)| m.clone())
    }
}

#[derive(Default)]
struct Live {
    headers: Mutex<HashMap<String, Row>>,
    /// The header each session's stamp was last taken of, and the identity that stands for it (the product's stamp holds
    /// the published header itself).
    stamped: Mutex<HashMap<String, (Row, Arc<()>)>>,
}

impl LiveSessions for Live {
    fn stamp(&self, session: &str) -> Option<LiveStamp> {
        let header = self.headers.lock().unwrap().get(session).cloned()?;
        let mut stamped = self.stamped.lock().unwrap();
        let held = match stamped.get(session) {
            Some((row, held)) if *row == header => held.clone(),
            _ => {
                let held = Arc::new(());
                stamped.insert(session.to_owned(), (header, held.clone()));
                held
            }
        };
        Some(LiveStamp { header: held, running: false, stage: None })
    }

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
    rig.store.touch_sessions();
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
    let warmed = view_counts();
    assert!(warmed.rows_normalized > 0 && warmed.tombstones_normalized > 0 && warmed.tombstones_keyed > 0 && warmed.rows_tested > 0, "{warmed:?}");
    for pass in 0..4 {
        assert_eq!(recompute().await, first, "pass {pass} answers what the first did");
    }
    assert_eq!(view_counts(), warmed, "four recomputes of an unchanged index did per-row or per-tombstone work");

    // A write is seen by the next read, and costs one rebuild, not one per read.
    registry.mark_released(&["s-crowd-0".into()]);
    let released = |registry: &AgentRegistry| {
        let st = registry.lock();
        st.rows(&scope, registry.now()).iter().find(|r| r["tag"] == "c0").map(|r| r.get("released").cloned())
    };
    assert_eq!(released(&registry), Some(Some(json!(true))));
    let rebuilt = view_counts();
    assert!(rebuilt.rows_normalized > warmed.rows_normalized);
    for _ in 0..3 {
        assert_eq!(released(&registry), Some(Some(json!(true))));
    }
    assert_eq!(view_counts(), rebuilt);
}

/// The work the views do, without the comparison each reload of the index makes with what is held (the signal test counts that).
fn view_counts() -> rows::work::Counts {
    rows::work::Counts { maps_rebuilt: 0, maps_compared: 0, sessions_compared: 0, stamps_taken: 0, reloads: 0, ..rows::work::counts() }
}

/// What the registry's reads answer, whole, at its clock.
fn index_reads(registry: &AgentRegistry) -> (Vec<Row>, Vec<Row>, Vec<Row>, Vec<Row>) {
    let now = registry.now();
    let st = registry.lock();
    (
        st.rows(&Scope::default(), now).iter().cloned().collect(),
        old_all_rows(&st, now),
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
    rig.store.touch_sessions();
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
    rig.store.touch_sessions();
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
/// or other event; a row already past its deadline when the timer starts (the core was down) is reaped by the first pass, one
/// event delay after the start (Node's first pass looks at every deadline after 0); a row that became active again before its deadline is reaped at its new one.
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
    // The first pass is the event pass one `MAINTENANCE_EVENT_DELAY_MS` after the start (maintenance-pass.mjs:23,129).
    clock.advance(999);
    assert!(!reaped("s-overdue"), "not before the first pass");
    clock.advance(1);
    until_written(&rig.store, "the row that came due while the core was down", || reaped("s-overdue")).await;
    assert!(!reaped("s-early") && !reaped("s-late") && !reaped("s-active"), "nothing else is due yet");

    // `s-active` works again 5 s in: its stamps move, and its deadline with them.
    clock.advance(4_000);
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

    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent-row-deadline/golden.json")).unwrap();
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
        let (indexed, tombstoned) = (strings("indexed"), strings("tombstones"));
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
    rig.store.touch_sessions();
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
    rig.store.touch_sessions();
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

/// The composed sessions over a data folder, as the daemon builds them: the real thread store and index, the session
/// directory, the worker rows' store and the kept-row table; a new one over the same folder is the next process.
struct Core {
    directory: Arc<crate::session::SessionDirectory>,
    threads: Arc<crate::session::thread_state::SessionThreads>,
    workers: Arc<StoreWorkers>,
    registry: AgentRegistry,
    state: mixdog_store::state::CoreState,
    index: mixdog_store::sqlite::SqliteStore,
    store: Arc<crate::session::StoreThreads>,
    _rig: crate::session::testing::Rig,
}

impl Core {
    async fn up(data: &std::path::Path) -> Self {
        let t = mixdog_rt::testing::tokens();
        let root = data.to_path_buf();
        let index = mixdog_rt::LaneToken::submit(t.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            mixdog_store::sqlite::SqliteStore::open(lane, t.sqlite_writer_thread, t.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let ownership = Arc::new(mixdog_core_api::domain::mock::MockOwnership::default());
        let store = Arc::new(crate::session::StoreThreads::over_data_dir(data, index.clone(), ownership, t.maintenance_io).await.expect("the thread store"));
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(crate::session::SessionDirectory::new(Arc::new(rig.deps_parts(store.clone()))));
        let threads = Arc::new(crate::session::thread_state::SessionThreads::new(directory.clone()));
        let (state, _) = mixdog_store::state::CoreState::open(t.sqlite_writer_thread, t.interactive_io, &data.join("core.sqlite")).expect("core state");
        let workers = Arc::new(StoreWorkers::new(index.clone(), threads.clone(), t.interactive_io, Arc::new(KeptRows::new(state.clone()))));
        let registry = AgentRegistry::new(workers.clone(), directory.clone(), Arc::new(Hour), Arc::new(TestClock(AtomicI64::new(NOW))));
        Self { directory, threads, workers, registry, state, index, store, _rig: rig }
    }

    /// Returns once every worker map written so far is in the index: applied to its header, and projected.
    async fn written(&self) {
        self.workers.settled().await.expect("the writes reached the headers");
        self.store.projected().await;
    }

    /// A loaded thread's header fields, as its turns would have left them.
    async fn set_header(&self, thread: &str, fields: Row) {
        mixdog_core_ports::ports::threads::ThreadState::patch_header(&*self.threads, &ThreadId::from(thread), fields, Vec::new()).await.expect("the header patch");
    }

    async fn start(&self, op: &str, session: Value) -> ThreadId {
        use mixdog_core_api::ThreadDirectory;
        let start = mixdog_core_api::call::CoreRequest {
            method: mixdog_core_api::ids::Method("thread/start"),
            params: json!({ "opId": op, "kind": "task", "projectPath": "/ws", "session": session }),
            op: Some(mixdog_core_api::ids::OpId::from(op)),
            ctx: mixdog_core_api::call::CallContext::internal("test"),
        };
        let mixdog_core_api::Reply::Subscribe(started) = self.directory.request(start).await.expect("thread/start") else { panic!("thread/start subscribes") };
        ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"))
    }

    /// The owner's queue as its log holds it: the entries a restart hands its next turn.
    async fn queued(&self, owner: &ThreadId) -> usize {
        let handle = self.directory.open_handle(owner, &mixdog_core_api::call::CallContext::internal("test")).await.expect("the owner opens");
        handle.cell.queue.load().len()
    }

    async fn notify(&self) -> usize {
        struct Frozen;
        impl mixdog_agent::env::Clock for Frozen {
            fn now_ms(&self) -> i64 {
                NOW
            }
        }
        let board = mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(Frozen), None, None);
        let told = restart::notify_restart_failures(&self.registry, &*self.directory, &board, &at(NOW)).await.expect("the pass ran");
        self.workers.settled().await.expect("the writes reached the headers");
        told
    }
}

/// How long the kill of an overdue child, and the wait for it to end, may take.
const KILL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

/// `command`'s output, hidden, within `deadline`: a child still running then is killed and the test fails naming `what`.
fn output_within(mut command: std::process::Command, deadline: std::time::Duration, what: &str) -> std::process::Output {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().expect("the child started");
    let pid = child.id().to_string();
    let (ended, ending) = std::sync::mpsc::channel::<()>();
    let reaper = std::thread::spawn(move || {
        let output = child.wait_with_output().expect("the child's output");
        let _ = ended.send(());
        output
    });
    if ending.recv_timeout(deadline).is_err() {
        #[cfg(windows)]
        let mut kill = {
            let mut kill = std::process::Command::new("taskkill");
            kill.args(["/T", "/F", "/PID", &pid]);
            std::os::windows::process::CommandExt::creation_flags(&mut kill, 0x0800_0000);
            kill
        };
        #[cfg(not(windows))]
        let mut kill = {
            let mut kill = std::process::Command::new("kill");
            kill.args(["-9", &pid]);
            kill
        };
        // Both waits are bounded: a kill that hangs or fails leaves its thread and the reaper behind, and the test still fails.
        let (killed, kill_ended) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _ = kill.output();
            let _ = killed.send(());
        });
        let kill_done = kill_ended.recv_timeout(KILL_DEADLINE).is_ok();
        let reaped = kill_done && ending.recv_timeout(KILL_DEADLINE).is_ok();
        panic!("{what}: the child ended within the deadline (kill finished: {kill_done}, child reaped: {reaped})");
    }
    reaper.join().expect("the reaper")
}

/// A child that outlives the deadline is killed and fails the test, rather than hanging it.
#[test]
#[should_panic(expected = "the child ended within the deadline")]
fn a_child_that_outlives_its_deadline_fails_the_test() {
    #[cfg(windows)]
    let command = {
        let mut command = std::process::Command::new("ping");
        command.args(["-n", "30", "127.0.0.1"]);
        command
    };
    #[cfg(not(windows))]
    let command = {
        let mut command = std::process::Command::new("sleep");
        command.arg("30");
        command
    };
    let _ = output_within(command, std::time::Duration::from_secs(1), "a sleeping child");
}

/// A kept write the table refused stays queued and reaches the table once it takes writes again (Node's index queue keeps a
/// failed write and retries it, `index-write-queue.mjs:231-245`), with no later write of the session to carry it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kept_row_the_table_refused_reaches_it_when_the_table_takes_writes_again() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    // A second writer holding the file's write lock: the table refuses every write until it lets go.
    let t = mixdog_rt::testing::tokens();
    let (other, _) = mixdog_store::state::CoreState::open(t.sqlite_writer_thread, t.interactive_io, &dir.path().join("core.sqlite")).unwrap();
    let (locked, lock_held) = std::sync::mpsc::channel::<()>();
    let (unlock, unlocked) = std::sync::mpsc::channel::<()>();
    let holder = tokio::spawn(async move {
        other
            .write(move |_| {
                locked.send(()).unwrap();
                unlocked.recv_timeout(std::time::Duration::from_secs(60)).expect("the test lets the lock go");
                Ok(())
            })
            .await
    });
    lock_held.recv_timeout(std::time::Duration::from_secs(60)).expect("the lock was taken within the deadline");
    let row = obj(json!({ "sessionId": "s-owed", "tag": "owed", "status": "failed" }));
    WorkerStore::keep(&*core.workers, "s-owed", Some(row.clone()));
    // Node's `flush` rejects while a batch is unpersisted: the barrier is not settled while a write is owed.
    let flushed = core.workers.settled().await;
    assert!(flushed.is_err(), "a write is still owed, so the flush is refused: {flushed:?}");
    let stored = || async { core.state.meta_prefix("agent-kept-worker:").await.unwrap() };
    assert!(stored().await.is_empty(), "the table refused the write");
    unlock.send(()).unwrap();
    holder.await.unwrap().unwrap();
    core.workers.settled().await.expect("nothing is owed once the table took the write");
    assert_eq!(stored().await, [("agent-kept-worker:s-owed".to_owned(), serde_json::to_string(&row).unwrap())], "the table took the write once it could");
}

/// `restart-notify.mjs:104-109`: the notice is stored under its stable id before the row is stamped. A real process (this test
/// binary again) is ended by the crate's crash gate on either side of the store, then the core starts again on the same data
/// folder. Ended before the store: nothing was queued and the row is still owed, so the restart tells it. Ended after it: the
/// stored notice survived and the row is still owed, so the restart queues it again under the same id, which Node's queue
/// takes as the entry it already holds (`pending-messages.mjs:476`, `pendingIdStillQueued` over the hydrated queue): the owner
/// is told once either way, and nothing is owed after.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_notice_cut_off_at_either_side_of_its_store_is_told_once_after_the_restart() {
    const DATA: &str = "MIXDOG_RESTART_NOTICE_DATA";
    const NAME: &str = "a_restart_notice_cut_off_at_either_side_of_its_store_is_told_once_after_the_restart";
    #[allow(clippy::disallowed_methods, reason = "the child process of this test reads the folder its parent named")]
    let child_data = std::env::var_os(DATA);
    if let Some(data) = child_data {
        // The child: one pass, which the crash gate ends.
        Core::up(std::path::Path::new(&data)).await.notify().await;
        return;
    }
    for (point, survived) in [("restart-notice-unstored", 0), ("restart-notice-stored", 1)] {
        let dir = tempfile::tempdir().unwrap();
        let owner = {
            let core = Core::up(dir.path()).await;
            let owner = core.start("op-owner", json!({ "autoWakeCompletions": false })).await;
            let worker = core.start("op-worker", json!({})).await;
            let row = json!({
                "tag": "owed", "sessionId": worker.as_str(), "parentSessionId": owner.as_str(), "ownerSessionId": owner.as_str(),
                "agent": "worker", "clientHostPid": PID, "status": "failed", "failureReason": "process-restart", "task_id": "t-1",
                "finishedAt": at(NOW), "updatedAt": at(NOW),
            });
            let mut set = serde_json::Map::new();
            set.insert("worker".into(), row);
            mixdog_core_ports::ports::threads::ThreadState::patch_header(&*core.threads, &worker, set, Vec::new()).await.expect("the worker row");
            core.directory.shutdown().await;
            owner
        };
        let test = format!("{}::{NAME}", module_path!().trim_start_matches("mixdog_core_session::"));
        let mut command = std::process::Command::new(std::env::current_exe().expect("the test binary"));
        command.args(["--exact", &test, "--nocapture", "--test-threads=1"]).env(DATA, dir.path()).env("MIXDOG_NEW_TASK_CRASH_AT", point);
        let child = output_within(command, std::time::Duration::from_secs(120), point);
        let stderr = String::from_utf8_lossy(&child.stderr);
        assert!(!child.status.success() && !stderr.contains("panicked"), "{point}: the gate ended the child: {stderr}");

        let core = Core::up(dir.path()).await;
        assert_eq!(core.queued(&owner).await, survived, "{point}: what the cut-off pass stored");
        assert_eq!(core.registry.pending_restart_failures().await.unwrap().len(), 1, "{point}: the row is still owed");
        assert_eq!(core.notify().await, 1, "{point}: the restart tells the owner");
        assert_eq!(core.queued(&owner).await, 1, "{point}: one notice");
        assert_eq!(core.notify().await, 0, "{point}: nothing is owed after");
        assert_eq!(core.queued(&owner).await, 1, "{point}: still one notice");
        core.directory.shutdown().await;
    }
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

/// A write the table refused changes nothing a listing reads: the kept rows in memory stay what the table holds, for an add,
/// a replace and a removal alike.
#[tokio::test]
async fn a_kept_row_the_table_refused_leaves_the_listing_as_the_table_is() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let t = mixdog_rt::testing::tokens();
    let (state, _) = mixdog_store::state::CoreState::open(t.sqlite_writer_thread, t.interactive_io, &path).unwrap();
    let kept = KeptRows::new(state.clone());
    let row = obj(json!({ "sessionId": "s-1", "tag": "one" }));
    kept.put("s-1", Some(row.clone())).await.unwrap();
    // The table fails every write from here on.
    state.close();
    assert!(kept.put("s-2", Some(obj(json!({ "sessionId": "s-2" })))).await.is_err());
    assert!(kept.put("s-1", Some(obj(json!({ "sessionId": "s-1", "tag": "two" })))).await.is_err());
    assert!(kept.put("s-1", None).await.is_err());
    let listed = kept.load().await.unwrap();
    let (stored, _) = mixdog_store::state::CoreState::open(t.sqlite_writer_thread, t.interactive_io, &path).unwrap();
    let table = KeptRows::new(stored).load().await.unwrap();
    assert_eq!((listed, kept.holds("s-1")), (table, true), "memory is the table");
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

/// The agent tool's `read` of a worker with no task reads the worker's own text: its sensitive values come back as the
/// marker, as its report does (Node `execute.mjs` `readJob`).
#[tokio::test]
async fn a_workers_text_read_by_its_owner_has_its_sensitive_values_as_the_marker() {
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
    let fill = json!({ "id": "c1", "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "482913" } } });
    assert!(srig.sensitive.remember("sess_worker", &[fill]));
    assert_eq!(sessions.redact_text("sess_worker", "the code is 482913".into()), "the code is [redacted]");
    assert_eq!(sessions.redact_text("sess_other", "the code is 482913".into()), "the code is 482913");
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

/// The status-signal scenario of the Node daemon's profile (`status-pulse.test.mjs` "activity bursts over a large unchanged
/// index") over the product's store (the index, `StoreWorkers`, the session directory): one Lead, 300 worker rows (30
/// running, 270 finished and kept for the day) with their stored agent sessions, 500 tag tombstones, and 30 loaded threads
/// (the Lead and 29 running workers, real threads whose rows the registry wrote through the store).
struct Crowd {
    core: Core,
    _dir: tempfile::TempDir,
    /// The scope of every loaded thread, as `AgentToolStatus::status` reads it.
    scopes: Vec<Scope>,
    /// A loaded running worker's session record and tag.
    running: Vec<(Row, String)>,
}

const LOADED: usize = 30;

/// A stored session's catalog row, as the index writes it from the session's header.
fn stored_head(id: &str, mut header: Row) -> mixdog_store::summary::CatalogHead {
    header.insert("id".into(), json!(id));
    mixdog_store::summary::CatalogHead { session: id.to_owned(), log_id: "log".into(), base_session: None, header }
}

async fn put_stored(core: &Core, id: &str, header: Row) {
    core.index.upsert(stored_head(id, header), mixdog_store::sqlite::DirtyMark::Clear).await.expect("the index takes the row");
}

async fn crowd_rig() -> Crowd {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let lead = core.start("op-lead", json!({})).await.as_str().to_owned();
    core.set_header(&lead, obj(json!({ "status": "idle", "updatedAt": at(NOW - 60_000), "clientHostPid": PID }))).await;
    let scope_of = |id: &str| Scope { caller_session_id: Some(id.to_owned()), host_pid: Some(PID) };
    let owned = json!({ "parentSessionId": lead, "ownerSessionId": lead });
    let mut scopes = vec![scope_of(&lead)];
    let mut running = Vec::new();
    for i in 0..300 {
        let busy = i < 30;
        let tag = if busy { format!("r{i}") } else { format!("d{i}") };
        let (status, created, updated) = if busy { ("running", NOW - HOUR, NOW - 60_000) } else { ("completed", NOW - 3 * HOUR, NOW - 2 * HOUR) };
        let mut fields = obj(json!({ "status": if busy { "running" } else { "idle" }, "updatedAt": at(updated), "cwd": "/w", "visibility": "agent-only" }));
        fields.extend(obj(owned.clone()));
        if busy && i < LOADED - 1 {
            let id = core.start(&format!("op-w{i}"), json!({})).await.as_str().to_owned();
            let session = session(&id, &tag, &at(created), Value::Object(fields));
            let mut live = session.clone();
            live.shift_remove("id");
            core.set_header(&id, live).await;
            core.registry.upsert_worker_row(&session, &tag, &obj(json!({ "status": "running", "stage": "running" })));
            scopes.push(scope_of(&id));
            running.push((session, tag));
            continue;
        }
        let id = format!("sess_crowd_{i}");
        let mut row = worker_row(&id, &tag, json!({ "status": status, "stage": status, "createdAt": at(created), "updatedAt": at(updated), "cwd": "/w" }));
        row.extend(obj(owned.clone()));
        if !busy {
            row.insert("finishedAt".into(), json!(at(updated)));
        }
        let mut header = session(&id, &tag, &at(created), Value::Object(fields));
        header.insert("worker".into(), Value::Object(row));
        put_stored(&core, &id, header).await;
    }
    for i in 0..500 {
        let id = format!("sess_gone_{i}");
        let gone = obj(json!({ "tombstone": tombstone(&format!("g{i}"), &at(NOW - HOUR - i), owned.clone()) }));
        let mut header = obj(json!({ "createdAt": at(NOW - 4 * HOUR) }));
        header.insert("worker".into(), Value::Object(without_row(&gone).unwrap()));
        put_stored(&core, &id, header).await;
    }
    core.written().await;
    Crowd { core, _dir: dir, scopes, running }
}

/// A status signal as the product runs it (`AgentActivity::everyone`): every loaded thread re-reads its status at once
/// (`AgentToolStatus::status`): `refresh_tags_from_sessions`, which reloads the index, then the scope's agents. The tags
/// each lists.
async fn signal(crowd: &Crowd) -> Vec<Vec<String>> {
    let registry = &crowd.core.registry;
    futures::future::join_all(crowd.scopes.iter().map(|scope| async move {
        registry.refresh_tags_from_sessions(false, scope).await;
        registry.status_entries(scope).iter().map(|(tag, _)| tag.clone()).collect::<Vec<_>>()
    }))
    .await
}

/// The index loads a signal may make: one per thread at most (threads that ask while a load is under way share the next
/// one, `a_reload_waiting_behind_*`; here a load of an unchanged index ends before the next thread asks). A load of an
/// unchanged index reads the revision and finds no row past it.
const SIGNAL_LOADS: usize = LOADED;
/// The rows a signal may visit one by one: the Lead's 30 working rows checked for staleness, and the row written, bound
/// again; never the 270 finished ones.
const VISITED_PER_SIGNAL: usize = LOADED + 4;
/// The per-row, per-tombstone and per-tag operations a status signal may cost: each loaded thread's re-read (its refresh and
/// its listing) takes the stamp of every loaded session, and the Lead's refresh visits its working rows and reads their sessions for staleness; never a
/// pass over the finished rows or the tombstones, no tag's session read again while its stamp holds, and no comparison of
/// a load with the index held.
fn signal_budget() -> usize {
    2 * LOADED * LOADED + 2 * VISITED_PER_SIGNAL
}

/// The operations that are not a loaded thread looking at what it holds (the stamps, the tags and sessions behind them, the
/// rows it visits): loading, normalising, keying, copying and scoping rows and tombstones, and comparing a load with what is
/// held. They follow what was written.
fn index_work(c: &rows::work::Counts) -> usize {
    c.total() - c.tags_visited - c.sessions_visited - c.rows_tested - c.rows_visited - c.stamps_taken
}

/// What one written row may cost besides the threads' re-reads: its row normalised twice, compared once, and tested against
/// each loaded thread's scope.
const WRITE_WORK: usize = LOADED + 8;
/// The session records one written row has read again: the written session's, whose header and row changed.
const WRITE_READS: usize = 8;

/// The work of a status signal is what changed, not the size of the index: 1,000 signals over an unchanged index, and 1,000
/// single-row writes (one worker's stage change, each followed by its signal), stay within what the loaded threads cost,
/// while every re-read answers what it answered before.
// The body runs on the test's own thread (the counts are per thread); the session tasks run on the runtime's workers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_status_signal_costs_what_changed_not_the_finished_rows_and_tombstones() {
    let crowd = crowd_rig().await;
    let first = signal(&crowd).await;
    assert_eq!(first[0].len(), 30, "the Lead's status lists its working agents");
    assert!(first[1..].iter().all(Vec::is_empty), "a worker has no agents of its own");
    {
        let st = crowd.core.registry.lock();
        let now = crowd.core.registry.now();
        assert_eq!((old_all_rows(&st, now).len(), st.stored_tombstones(now).len()), (300, super::rows::MAX_TAG_TOMBSTONES.min(500)), "the data set is loaded");
    }

    let (start, loads, visits) = (rows::work::counts().total(), rows::work::counts().reloads, rows::work::counts().rows_visited);
    let before = rows::work::counts();
    for n in 1..=1000 {
        assert_eq!(signal(&crowd).await, first);
        let now = rows::work::counts();
        let visited = now.rows_visited - visits;
        if n == 1 {
            eprintln!("one signal over an unchanged index: {} operations, {} loads, {now:?} from {before:?}", now.total() - start, now.reloads - loads);
        }
        assert_eq!(index_work(&now), index_work(&before), "{n} signal(s) over an unchanged index did work that follows what changed");
        // No thread reads the sessions behind its loaded tags again; the session records read are the Lead's staleness
        // check of its working rows.
        assert_eq!(now.tags_visited, before.tags_visited, "{n} signal(s) over an unchanged index read a tag's session again");
        let records = now.sessions_visited - before.sessions_visited;
        assert!(records <= n * VISITED_PER_SIGNAL, "{n} signal(s) over an unchanged index read {records} session records");
        assert!(visited <= n * VISITED_PER_SIGNAL, "{n} signal(s) over an unchanged index visited {visited} rows (at most {VISITED_PER_SIGNAL} each)");
        let spent = rows::work::counts().total() - start;
        assert!(spent <= n * signal_budget(), "{n} signal(s) over an unchanged index did {spent} operations (budget {} each)", signal_budget());
        let loaded = rows::work::counts().reloads - loads;
        assert!(loaded <= n * SIGNAL_LOADS, "{n} signal(s) loaded the index {loaded} times (at most {SIGNAL_LOADS} each)");
    }
    let unchanged = rows::work::counts().total() - start;

    let (start, loads, visits) = (rows::work::counts().total(), rows::work::counts().reloads, rows::work::counts().rows_visited);
    let before = rows::work::counts();
    for n in 1..=1000 {
        let (session, tag) = &crowd.running[n % crowd.running.len()];
        let stage = if n % 2 == 0 { "streaming" } else { "tool_running" };
        crowd.core.registry.upsert_worker_row(session, tag, &obj(json!({ "status": "running", "stage": stage })));
        // The write reaches the index before the signal's loads read it, so each load reads the row written.
        crowd.core.written().await;
        let read = signal(&crowd).await;
        assert_eq!(read[0].len(), 30);
        if n == 1 {
            let c = rows::work::counts();
            eprintln!("one signal after one write: {} operations, {:?} from {before:?}", c.total() - start, c);
        }
        let spent = rows::work::counts().total() - start;
        let budget = signal_budget() + WRITE_WORK + WRITE_READS;
        assert!(spent <= n * budget, "{n} write(s) did {spent} operations (budget {budget} each)");
        let written = index_work(&rows::work::counts()) - index_work(&before);
        assert!(written <= n * WRITE_WORK, "{n} write(s) did {written} operations that follow what changed (at most {WRITE_WORK} each)");
        let c = rows::work::counts();
        let reads = c.tags_visited + c.sessions_visited - before.tags_visited - before.sessions_visited;
        let most = VISITED_PER_SIGNAL + WRITE_READS;
        assert!(reads <= n * most, "{n} write(s) read {reads} session records (at most {most} each: the staleness check's and the written session's)");
        let visited = rows::work::counts().rows_visited - visits;
        assert!(visited <= n * VISITED_PER_SIGNAL, "{n} write(s) visited {visited} rows (at most {VISITED_PER_SIGNAL} each)");
        let loaded = rows::work::counts().reloads - loads;
        assert!(loaded <= n * SIGNAL_LOADS, "{n} write(s) loaded the index {loaded} times (at most {SIGNAL_LOADS} each)");
    }
    let written = rows::work::counts().total() - start;
    eprintln!(
        "status signal work per signal: unchanged index {} operations; one single-row write {} operations (1,000 each: {unchanged} and {written})",
        unchanged / 1000,
        written / 1000
    );
    let registry = &crowd.core.registry;
    let st = registry.lock();
    let stages: Vec<String> = st.rows(&crowd.scopes[0], registry.now()).iter().filter(|r| r["status"] == "running").map(|r| clean(r.get("stage"))).collect();
    assert_eq!(stages.len(), 30);
    assert_eq!(stages.iter().filter(|s| *s == "streaming" || *s == "tool_running").count(), LOADED - 1, "{stages:?}");
    drop(st);
    crowd.core.directory.shutdown().await;
}

/// The worker index another connection (another process) committed is what the registry's next load shows, through the
/// product's store, and that load reads the one row written.
#[tokio::test]
async fn a_worker_row_another_connection_wrote_is_seen_by_the_next_load() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let row = |status: &str| worker_row("sess_other", "o", json!({ "status": status }));
    for (id, status) in [("sess_other", "running"), ("sess_quiet", "completed")] {
        let mut header = obj(json!({ "createdAt": at(NOW - HOUR) }));
        header.insert("worker".into(), Value::Object(worker_row(id, id, json!({ "status": status }))));
        put_stored(&core, id, header).await;
    }
    let status = |core: &Core| core.registry.lock().map("sess_other").map(|m| m["status"].clone());
    core.registry.reload().await;
    assert_eq!(status(&core), Some(json!("running")));

    core.index.set_worker_elsewhere("sess_other", Some(&row("failed")));
    let before = rows::work::counts();
    core.registry.reload().await;
    assert_eq!(status(&core), Some(json!("failed")), "the other connection's commit is loaded");
    assert_eq!(rows::work::counts().maps_compared - before.maps_compared, 1, "the load compared the one row written");
    core.directory.shutdown().await;
}

/// The product's store answering every load whole: the registry over it is what a registry fed deltas is compared with.
struct Whole(Arc<StoreWorkers>);

#[async_trait]
impl WorkerStore for Whole {
    async fn index_since(&self, _: Option<Revision>) -> Result<Index, String> {
        self.0.index_since(None).await
    }
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        WorkerStore::worker_maps(&*self.0).await
    }
    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        WorkerStore::agent_sessions(&*self.0).await
    }
    async fn header(&self, session: &str) -> Option<Row> {
        WorkerStore::header(&*self.0, session).await
    }
    async fn is_directory(&self, _: &str) -> bool {
        false
    }
    fn write(&self, session: &str, worker: Option<Row>) {
        WorkerStore::write(&*self.0, session, worker);
    }
    fn keep(&self, session: &str, worker: Option<Row>) {
        WorkerStore::keep(&*self.0, session, worker);
    }
    fn kept(&self, session: &str) -> bool {
        WorkerStore::kept(&*self.0, session)
    }
    fn kept_sessions(&self) -> Vec<String> {
        WorkerStore::kept_sessions(&*self.0)
    }
}

/// What a registry holds of the index: every map at its place, and the agent-only sessions at theirs.
fn held(registry: &AgentRegistry) -> (Vec<(String, Place, Row)>, Vec<(Place, Row)>) {
    let st = registry.lock();
    let maps = st.maps.iter().map(|(id, map)| (id.clone(), st.maps.key(id).cloned().expect("held"), map.clone())).collect();
    (maps, st.sessions.iter().map(|(place, row)| (place.clone(), row.clone())).collect())
}

/// Over the product's store, for a random sequence of this registry's writes, another connection's writes, new sessions
/// at every place in the index order, deletes and agent-only sessions' changes, a registry fed deltas holds, and reads, what
/// a registry that loads the whole index after every step holds and reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_registry_fed_deltas_holds_what_one_that_loads_the_whole_index_holds() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let whole = AgentRegistry::new(Arc::new(Whole(core.workers.clone())), core.directory.clone(), Arc::new(Hour), Arc::new(TestClock(AtomicI64::new(NOW))));
    let lead = core.start("op-lead", json!({})).await.as_str().to_owned();
    let owned = json!({ "parentSessionId": lead, "ownerSessionId": lead });
    let mut own: Vec<(Row, String)> = Vec::new();
    for i in 0..4 {
        let id = core.start(&format!("op-own-{i}"), json!({})).await.as_str().to_owned();
        let tag = format!("own{i}");
        own.push((session(&id, &tag, &at(NOW - HOUR), owned.clone()), tag));
    }
    // The sessions another process writes: (id, tag, created at, worker map, agent-only status).
    let mut foreign: Vec<(String, String, i64, Option<Row>, Option<String>)> = Vec::new();
    let header_of = |(id, tag, created, worker, agent): &(String, String, i64, Option<Row>, Option<String>)| {
        let mut header = session(id, tag, &at(*created), owned.clone());
        if let Some(status) = agent {
            header.insert("visibility".into(), json!("agent-only"));
            header.insert("status".into(), json!(status));
        }
        if let Some(worker) = worker {
            header.insert("worker".into(), Value::Object(worker.clone()));
        }
        header
    };
    let mut dice = Dice(0x5eed_1234);
    const STATUSES: [&str; 5] = ["running", "streaming", "completed", "failed", "idle"];
    for step in 0..160 {
        let status = *dice.pick(&STATUSES);
        let (session, tag) = dice.pick(&own).clone();
        let id = clean(session.get("id"));
        match dice.below(10) {
            // This process's writes: both registries make each (the same map, written twice), as each would alone.
            0 | 1 => {
                for registry in [&core.registry, &whole] {
                    registry.upsert_worker_row(&session, &tag, &obj(json!({ "status": status, "stage": status })));
                }
            }
            2 => {
                for registry in [&core.registry, &whole] {
                    registry.mark_released(std::slice::from_ref(&id));
                }
            }
            3 => {
                for registry in [&core.registry, &whole] {
                    registry.remove_worker_row(&id);
                }
            }
            4 => {
                let forgot = core.registry.forget_deleted_session(&id).await;
                assert_eq!(whole.forget_deleted_session(&id).await, forgot, "forget, step {step}");
            }
            5 | 6 if !foreign.is_empty() => {
                // Another process writes a worker map, or removes it.
                let at = dice.below(foreign.len());
                let (id, tag) = (foreign[at].0.clone(), foreign[at].1.clone());
                let map = (dice.below(4) != 0).then(|| {
                    let mut map = worker_row(&id, &tag, json!({ "status": status }));
                    map.extend(obj(owned.clone()));
                    if dice.below(3) == 0 {
                        map.insert("tombstone".into(), Value::Object(tombstone(&tag, &at_ms(NOW - HOUR - step as i64), owned.clone())));
                    }
                    map
                });
                core.index.set_worker_elsewhere(&id, map.as_ref());
                foreign[at].3 = map;
            }
            7 if !foreign.is_empty() => {
                // An agent-only session's record changes, or the session is deleted.
                let at = dice.below(foreign.len());
                if dice.below(3) == 0 {
                    core.index.mark_deleted(&foreign.remove(at).0).await.unwrap();
                } else {
                    foreign[at].4 = Some(status.to_owned());
                    put_stored(&core, &foreign[at].0.clone(), header_of(&foreign[at])).await;
                }
            }
            _ => {
                // A new session, created at any instant: its place may be anywhere in the index order.
                let id = format!("sess_new_{step}");
                let tag = format!("n{step}");
                let mut map = worker_row(&id, &tag, json!({ "status": status }));
                map.extend(obj(owned.clone()));
                let created = NOW - (dice.below(5) as i64) * HOUR;
                let entry = (id.clone(), tag, created, Some(map), (dice.below(2) == 0).then(|| status.to_owned()));
                put_stored(&core, &id, header_of(&entry)).await;
                foreign.push(entry);
            }
        }
        // Twice: a load may keep a map the index stopped listing, and that keep is written in turn.
        for _ in 0..2 {
            core.written().await;
            core.registry.reload().await;
        }
        whole.reload().await;
        assert_eq!(held(&core.registry), held(&whole), "what the registries hold, step {step}");
        assert_eq!(index_reads(&core.registry), index_reads(&whole), "what the registries read, step {step}");
    }
    core.directory.shutdown().await;
}

fn at_ms(ms: i64) -> String {
    at(ms)
}

/// A caller that asks for a reload after a write completed answers from an index that shows it, whatever became of the load
/// it waited behind: a load that started after it arrived but failed, or was cancelled, did not update the index.
async fn a_reload_waiting_behind_a_lost_load_loads_for_itself(cancelled: bool) {
    let rig = Rig::new();
    rig.store.write("s-a", Some(worker_row("s-a", "a", json!({}))));
    rig.store.slow.store(true, Ordering::SeqCst);
    let registry = rig.registry();
    registry.reload().await;

    // A load is under way and one more waits behind it; then a write completes and the caller asks.
    let mut under_way = Box::pin(registry.reload());
    assert!(futures::poll!(under_way.as_mut()).is_pending());
    let mut next = Box::pin(registry.reload());
    assert!(futures::poll!(next.as_mut()).is_pending());
    rig.store.write("s-b", Some(worker_row("s-b", "b", json!({}))));
    let mut caller = Box::pin(registry.reload());
    assert!(futures::poll!(caller.as_mut()).is_pending());

    under_way.await;
    assert!(registry.lock().map("s-b").is_none(), "the load under way read the store before the write");
    if cancelled {
        assert!(futures::poll!(next.as_mut()).is_pending(), "the next load started");
        drop(next);
    } else {
        rig.store.fail.store(true, Ordering::SeqCst);
        next.await;
        rig.store.fail.store(false, Ordering::SeqCst);
    }
    caller.await;
    assert!(registry.lock().map("s-b").is_some(), "the caller's reload showed the write that completed before it asked");
}

#[tokio::test]
async fn a_reload_waiting_behind_a_failed_load_loads_for_itself() {
    a_reload_waiting_behind_a_lost_load_loads_for_itself(false).await;
}

#[tokio::test]
async fn a_reload_waiting_behind_a_cancelled_load_loads_for_itself() {
    a_reload_waiting_behind_a_lost_load_loads_for_itself(true).await;
}

// ---- the reads before the views, as the reference ------------------------------------------

/// `readAllWorkerRows` as the registry computed it before its views.
fn old_all_rows(st: &State, now: f64) -> Vec<Row> {
    st.maps.iter().filter_map(|(id, map)| st.row(id, map, now)).collect()
}

/// `store.readTombstones` as computed before (`State::stored_tombstones`).
fn old_stored_tombstones(st: &State, now: f64) -> Vec<Row> {
    let rows = st.maps.iter().filter_map(|(id, map)| normalize_tombstone(map.get("tombstone")?.as_object()?, id, now)).collect();
    order_tombstones(rows)
}

/// `readAllTagTombstones` as computed before (`State::tombstones`).
fn old_tombstones(st: &State, now: f64) -> Vec<Row> {
    old_stored_tombstones(st, now)
        .into_iter()
        .map(|row| match st.owners.get(&identity(&row)) {
            Some(Some(fields)) if is_legacy(&row) => {
                let mut out = row;
                out.extend(fields.clone());
                out
            }
            _ => row,
        })
        .collect()
}

/// `tagTombstoneIndex` as computed before (`State::tombstone_index`).
fn old_tombstone_index(st: &State, now: f64) -> HashMap<String, Row> {
    let mut by_key = HashMap::new();
    for row in old_tombstones(st, now) {
        by_key.entry(tombstone_key(&row)).or_insert(row);
    }
    by_key
}

/// `readWorkerRows(context)` as computed before (`State::rows`).
fn old_rows(st: &State, scope: &Scope, now: f64) -> Vec<Row> {
    let by_key = old_tombstone_index(st, now);
    old_all_rows(st, now)
        .into_iter()
        .filter(|row| {
            let tag = clean(either(row, "tag", "agentTag"));
            !blocks_work(row, find_tombstone(row, &by_key, &tag))
        })
        .filter(|row| matches_scope(row, scope))
        .collect()
}

/// `tombstoneBlocksScan` as computed before: the scan guard over every unblocked row.
fn old_blocks_scan(registry: &AgentRegistry, st: &State, session: &Row, tag: &str, by_key: &HashMap<String, Row>, now: f64) -> bool {
    if registry.scan_is_terminal(session) && past_settled_retention(&registry.reap_ms(), session, now) {
        return true;
    }
    let tag = clean_str(tag);
    let id = clean(session.get("id"));
    if tag.is_empty() || id.is_empty() || !blocks_work(session, find_tombstone(session, by_key, &tag)) {
        return false;
    }
    !old_rows(st, &Scope::default(), now).iter().any(|row| clean(row.get("sessionId")) == id && clean(row.get("tag")) == tag)
}

/// The rows `transitionStaleNonterminalRows` reaped before: every row of the scope checked.
fn old_stale_rows(registry: &AgentRegistry, st: &State, scope: &Scope, now: f64) -> Vec<Row> {
    let reap = registry.reap_ms();
    old_rows(st, scope, now)
        .into_iter()
        .filter(|row| {
            if is_lead_pool_agent(row.get("agent")) {
                return false;
            }
            let id = clean(row.get("sessionId"));
            if is_terminal_row(row) {
                return !is_unnotified_restart_failure(row) && past_settled_retention(&reap, row, now) && !registry.live.has_live_work(&id);
            }
            if registry.live_session_row(st, &id).is_some() {
                return false;
            }
            now >= nonterminal_reap_deadline(&reap, row)
        })
        .collect()
}

/// `tags`, `tagAgents`, `tagCwds`.
#[derive(Debug, PartialEq)]
struct TagMaps {
    tags: Vec<(String, String)>,
    agents: HashMap<String, String>,
    cwds: HashMap<String, String>,
}

fn tag_maps(st: &State) -> TagMaps {
    TagMaps { tags: st.tags.iter().map(|(t, id)| (t.clone(), id.clone())).collect(), agents: st.tag_agents.clone(), cwds: st.tag_cwds.clone() }
}

/// What a refresh did to the tag maps before (its staleness pass already run): every row of the scope bound, then every
/// tag the rows do not hold read again and unbound when its session is gone or the scan guard blocks it.
fn old_bind_and_unbind(registry: &AgentRegistry, st: &State, scope: &Scope, now: f64) -> TagMaps {
    let mut maps = tag_maps(st);
    let indexed = old_rows(st, scope, now);
    for row in &indexed {
        let (tag, id) = (clean(row.get("tag")), clean(row.get("sessionId")));
        match maps.tags.iter_mut().find(|(t, _)| *t == tag) {
            Some(entry) => entry.1 = id,
            None => maps.tags.push((tag.clone(), id)),
        }
        for (key, into) in [("agent", &mut maps.agents), ("cwd", &mut maps.cwds)] {
            let value = clean(row.get(key));
            if !value.is_empty() {
                into.insert(tag.clone(), value);
            }
        }
    }
    let keys: HashSet<String> = indexed.iter().map(|r| format!("{}\0{}", clean(r.get("tag")), clean(r.get("sessionId")))).collect();
    let by_key = old_tombstone_index(st, now);
    for (tag, id) in maps.tags.clone() {
        if keys.contains(&format!("{tag}\0{id}")) {
            continue;
        }
        let session = registry.live_session_row(st, &id);
        if session.as_ref().is_none_or(|s| old_blocks_scan(registry, st, s, &tag, &by_key, now)) {
            maps.tags.retain(|(t, _)| *t != tag);
            maps.agents.remove(&tag);
            maps.cwds.remove(&tag);
        }
    }
    maps
}

/// What `agentSessionEntries({ context })` listed before from the rows, and (when it scans) from the sessions: the
/// entries and the sessions they stand for. Nothing in it reads what a scan writes.
fn old_entries_head(registry: &AgentRegistry, st: &State, scope: &Scope, now: f64, scan: bool) -> (Vec<(String, Row)>, HashSet<String>) {
    let by_key = old_tombstone_index(st, now);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in old_rows(st, scope, now) {
        let (tag, id) = (clean(row.get("tag")), clean(row.get("sessionId")));
        if tag.is_empty() || id.is_empty() || is_lead_pool_agent(row.get("agent")) || !seen.insert(id) {
            continue;
        }
        out.push((tag, row_to_session(&row)));
    }
    if scan {
        for session in registry.list_sessions(st, false) {
            let tag = agent_tag_of(&session);
            if !tag.is_empty() && old_blocks_scan(registry, st, &session, &tag, &by_key, now) {
                continue;
            }
            let listed = Some(tag.clone()).filter(|t| !t.is_empty());
            let id = clean(session.get("id"));
            if listed.is_none() || id.is_empty() || session.get("closed") == Some(&json!(true)) || is_lead_pool_agent(session.get("agent")) {
                continue;
            }
            if !matches_scope(&session, scope) || !seen.insert(id) {
                continue;
            }
            out.push((tag, session));
        }
    }
    (out, seen)
}

/// `agentSessionEntries({ context })` as listed before.
fn old_entries(registry: &AgentRegistry, st: &State, scope: &Scope, now: f64) -> Vec<(String, Row)> {
    let head = old_entries_head(registry, st, scope, now, false);
    old_entries_tail(registry, st, scope, now, head)
}

/// The tag-bound sessions a listing adds after the rows (and the scan), over the tag maps as they are then.
fn old_entries_tail(registry: &AgentRegistry, st: &State, scope: &Scope, now: f64, head: (Vec<(String, Row)>, HashSet<String>)) -> Vec<(String, Row)> {
    let by_key = old_tombstone_index(st, now);
    let (mut out, mut seen) = head;
    for (tag, id) in tag_maps(st).tags {
        if seen.contains(&id) {
            continue;
        }
        let Some(session) = registry.live_session_row(st, &id) else { continue };
        if old_blocks_scan(registry, st, &session, &tag, &by_key, now) {
            continue;
        }
        let tag = Some(agent_tag_of(&session)).filter(|t| !t.is_empty()).unwrap_or_else(|| clean_str(&tag));
        let sid = clean(session.get("id"));
        if tag.is_empty() || sid.is_empty() || session.get("closed") == Some(&json!(true)) || is_lead_pool_agent(session.get("agent")) {
            continue;
        }
        if !matches_scope(&session, scope) || !seen.insert(sid) {
            continue;
        }
        out.push((tag, session));
    }
    out
}

/// What the agent status keeps of a listing: the entries whose state is active (`AgentToolStatus::status`).
fn listed_by_status(entries: Vec<(String, Row)>) -> Vec<(String, Row)> {
    entries
        .into_iter()
        .filter(|(_, session)| {
            let (status, stage) = status_rows::row_state(session, None);
            mixdog_agent::agent_tool::views::is_active_worker(&status, &stage)
        })
        .collect()
}

/// Every read of the registry at its clock, against the reads made before its views; then a refresh and the listings.
fn check_reads(registry: &AgentRegistry, scope: &Scope, tag: &str, label: &str) {
    let now = registry.now();
    {
        // The public reads over the same index.
        let st = registry.lock();
        let record = |row: &Row| tag_record(row, "tag", "sessionId");
        let rows: Vec<TagRecord> = old_rows(&st, scope, now).iter().map(record).collect();
        let tombstones = old_tombstones(&st, now);
        let for_tag = (!tag.is_empty())
            .then(|| tombstones.iter().find(|row| matches_scope(row, scope) && clean(row.get("tag")) == tag).map(record))
            .flatten();
        let all: Vec<TagRecord> = tombstones.iter().map(record).collect();
        drop(st);
        assert_eq!(registry.read_worker_rows(scope).unwrap(), rows, "read worker rows, {label}");
        assert_eq!(registry.read_all_tag_tombstones(), all, "read all tag tombstones, {label}");
        assert_eq!(registry.tag_tombstone_for_tag(tag, scope), for_tag, "tag tombstone for tag, {label}");
    }
    {
        let st = registry.lock();
        assert_eq!(*st.stored_tombstones(now), old_stored_tombstones(&st, now), "stored tombstones, {label}");
        assert_eq!(*st.tombstones(now), old_tombstones(&st, now), "tombstones, {label}");
        assert_eq!(*st.tombstone_index(now), old_tombstone_index(&st, now), "tombstone index, {label}");
        assert_eq!(st.rows(scope, now).iter().cloned().collect::<Vec<_>>(), old_rows(&st, scope, now), "rows, {label}");
        assert_eq!(registry.stale_rows(&st, scope), old_stale_rows(registry, &st, scope, now), "stale rows, {label}");
    }
    let mut st = registry.lock();
    // The refresh's own owners and staleness passes, until they change nothing more; then its tag passes.
    for _ in 0..4 {
        registry.resolve_owners(&mut st);
        if registry.stale_rows(&st, scope).is_empty() {
            break;
        }
        registry.transition_stale(&mut st, scope);
    }
    let want = old_bind_and_unbind(registry, &st, scope, now);
    registry.refresh(&mut st, false, scope);
    assert_eq!(tag_maps(&st), want, "tag maps after a refresh, {label}");
    let want = old_entries(registry, &st, scope, now);
    drop(st);
    let have: Vec<(String, Row)> = registry.session_entries(false, scope).into_iter().map(|(tag, s)| (tag, (*s).clone())).collect();
    assert_eq!(have, want, "listing, {label}");
    let status: Vec<(String, Row)> = registry.status_entries(scope).into_iter().map(|(tag, s)| (tag, (*s).clone())).collect();
    assert_eq!(listed_by_status(status), listed_by_status(want), "status listing, {label}");
}

/// A deterministic generator for the sequence below (xorshift64*).
struct Dice(u64);

impl Dice {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

struct AllAlive;
impl restart::ProcessProbe for AllAlive {
    fn alive(&self, _: u64) -> bool {
        true
    }
}

/// For random sequences of every kind of write (this process's and another's, the exit flush, the restart's settlement, a
/// restart that restores the index, the scans), expiries, loads and reads, every public read of the registry, every refresh
/// and every listing (scanning ones too) answers what the reads made before the views answered over the same index.
#[tokio::test]
async fn the_views_answer_what_the_reads_before_them_answered() {
    const STATUSES: [&str; 8] = ["running", "streaming", "tool_running", "idle", "completed", "failed", "cancelled", ""];
    let ttl = TAG_TOMBSTONE_TTL_MS as i64;
    for seed in [7_u64, 1_234_567, 0x00de_c0de, 99_991] {
        let mut dice = Dice(seed);
        let rig = Rig::new();
        let workers: Vec<(String, String, String)> =
            (0..14).map(|i| (format!("w-{i}"), format!("t{}", i % 9), ["lead-a", "lead-b", ""][i % 3].to_owned())).collect();
        let stored = |id: &str, tag: &str, owner: &str, status: &str| {
            session(id, tag, &at(NOW - 3 * HOUR), json!({ "parentSessionId": owner, "ownerSessionId": owner, "status": status, "updatedAt": at(NOW - 2 * HOUR), "cwd": "/w" }))
        };
        for (i, (id, tag, owner)) in workers.iter().enumerate() {
            let status = *dice.pick(&STATUSES);
            let mut map = if i % 4 == 3 {
                Row::new()
            } else {
                worker_row(id, tag, json!({ "parentSessionId": owner, "ownerSessionId": owner, "status": status, "createdAt": at(NOW - 3 * HOUR), "updatedAt": at(NOW - 2 * HOUR) }))
            };
            if i % 3 == 1 {
                let legacy = if i % 2 == 0 { json!({ "parentSessionId": null, "ownerSessionId": null }) } else { json!({ "parentSessionId": owner, "ownerSessionId": owner }) };
                map.insert("tombstone".into(), Value::Object(tombstone(tag, &at(NOW - HOUR - i as i64), legacy)));
            }
            if i % 5 == 2 {
                map.insert("releasedAt".into(), json!(at(NOW - DAY)));
            }
            let map = if map.contains_key("sessionId") { Some(map) } else { without_row(&map) };
            rig.store.write(id, map);
            if i % 6 != 5 {
                rig.store.sessions.lock().unwrap().push(stored(id, tag, owner, status));
                rig.store.touch_sessions();
            }
            if i % 4 == 0 {
                rig.live.headers.lock().unwrap().insert(id.clone(), stored(id, tag, owner, status));
            }
        }
        let future = obj(json!({ "tombstone": tombstone("t1", &at(NOW + 2 * HOUR), json!({})) }));
        rig.store.write("s-future", without_row(&future));
        let mut registry = rig.registry();
        registry.reload().await;
        let scopes = [
            lead("lead-a"),
            lead("lead-b"),
            Scope { caller_session_id: Some("lead-a".into()), host_pid: Some(PID) },
            Scope { caller_session_id: None, host_pid: Some(PID) },
            Scope::default(),
            lead("w-0"),
        ];
        for step in 0..250 {
            let (id, tag, owner) = dice.pick(&workers).clone();
            let status = *dice.pick(&STATUSES);
            match dice.below(20) {
                0 | 1 => registry.upsert_worker_row(&stored(&id, &tag, &owner, status), &tag, &obj(json!({ "status": status, "stage": status, "runtimePid": PID }))),
                2 => registry.mark_released(std::slice::from_ref(&id)),
                3 => crate::session::TurnStarts::turn_started(&registry, &mixdog_core_api::ids::ThreadId::from(id.as_str())),
                4 => registry.remove_worker_row(&id),
                5 => {
                    registry.forget_deleted_session(&id).await;
                }
                6 => {
                    let tombstones = registry.read_all_tag_tombstones();
                    if !tombstones.is_empty() {
                        registry.consume_tag_tombstone(dice.pick(&tombstones));
                    }
                }
                7 => {
                    // Another process wrote the index.
                    let mut map = rig.store.map(&id).unwrap_or_default();
                    match dice.below(3) {
                        0 => map = worker_row(&id, &tag, json!({ "parentSessionId": owner, "ownerSessionId": owner, "status": status, "createdAt": at(NOW - HOUR) })),
                        1 => {
                            map.insert("tombstone".into(), Value::Object(tombstone(&tag, &at(registry.now() as i64 - HOUR), json!({ "parentSessionId": null, "ownerSessionId": null }))));
                        }
                        _ => map = Row::new(),
                    }
                    let map = if map.contains_key("sessionId") { Some(map) } else { without_row(&map) };
                    rig.store.write(&id, map);
                    registry.reload().await;
                }
                8 => {
                    // A stored session changed (or left the store), then a reload.
                    let mut sessions = rig.store.sessions.lock().unwrap();
                    sessions.retain(|s| s["id"] != json!(id));
                    if dice.below(4) != 0 {
                        let mut s = stored(&id, &tag, &owner, status);
                        if dice.below(5) == 0 {
                            s.insert("closed".into(), json!(true));
                        }
                        let at = dice.below(sessions.len() + 1);
                        sessions.insert(at, s);
                    }
                    drop(sessions);
                    rig.store.touch_sessions();
                    registry.reload().await;
                }
                9 => {
                    // A session loads, unloads, or its live header changes.
                    let mut headers = rig.live.headers.lock().unwrap();
                    if dice.below(3) == 0 {
                        headers.remove(&id);
                    } else {
                        headers.insert(id.clone(), stored(&id, &tag, &owner, status));
                    }
                }
                10 => {
                    // The clock: a step, a day, across the TTL, or back.
                    let now = registry.now() as i64;
                    let to = match dice.below(6) {
                        0 => now + 1,
                        1 => now + HOUR,
                        2 => now + DAY + 1,
                        3 => NOW + ttl - HOUR + *dice.pick(&[-1_i64, 0, 1]),
                        4 => NOW + 2 * HOUR + *dice.pick(&[-1_i64, 0, 1]),
                        _ => now - HOUR,
                    };
                    rig.clock.0.store(to, Ordering::SeqCst);
                }
                11 => {
                    if dice.below(2) == 0 {
                        registry.bind_tag(&tag, &session_facts(&stored(&id, &tag, &owner, status)), &at(registry.now() as i64));
                    } else {
                        registry.unbind_tag(&tag);
                    }
                }
                12 => registry.forget_terminal_session(Some(&tag), &id),
                13 => registry.reap_terminal_trace_for_tag(&tag, dice.pick(&scopes)),
                14 => {
                    registry.update_lead_worker_cwd(&id, "/moved").await;
                }
                15 => {
                    // The exit flush settles the rows this process still runs.
                    let running = |_: &str| false;
                    let live = restart::Liveness { probe: &AllAlive, own_pid: PID, running: &running, reap: &Hour, now_ms: registry.now() as i64 };
                    registry.flush_active_worker_rows(&live);
                }
                16 => {
                    // The next process restores the index from the store.
                    registry = rig.registry();
                    registry.reload().await;
                }
                17 => {
                    // The restart's own settlement and notification stamps go to the store; the registry loads them.
                    let running = |_: &str| false;
                    let live = restart::Liveness { probe: &AllAlive, own_pid: PID, running: &running, reap: &Hour, now_ms: registry.now() as i64 };
                    registry.recover_stale_worker_rows(dice.below(2) == 0, &live).await.unwrap();
                    registry.mark_restart_notified(std::slice::from_ref(&id), "stamp").await.unwrap();
                    registry.reload().await;
                }
                18 => {
                    // A scanning listing adds the stored sessions it finds, and writes their rows.
                    let scope = dice.pick(&scopes).clone();
                    let head = old_entries_head(&registry, &registry.lock(), &scope, registry.now(), true);
                    let have: Vec<(String, Row)> = registry.session_entries(true, &scope).into_iter().map(|(t, s)| (t, (*s).clone())).collect();
                    let want = old_entries_tail(&registry, &registry.lock(), &scope, registry.now(), head);
                    assert_eq!(have, want, "scanning listing, seed {seed} step {step} scope {scope:?}");
                }
                _ => {
                    let scope = dice.pick(&scopes).clone();
                    if dice.below(3) == 0 {
                        // The listing before the scan's writes, over the index as the refresh at the head of the resolve leaves it.
                        registry.refresh(&mut registry.lock(), true, &scope);
                        let head = old_entries_head(&registry, &registry.lock(), &scope, registry.now(), true);
                        let have = registry.resolve_tag(&tag, &scope, ResolveOptions { scan_sessions: true, exclude_terminal_traces: false }).map_err(|_| ());
                        let st = registry.lock();
                        let ids: Vec<String> =
                            old_entries_tail(&registry, &st, &scope, registry.now(), head).iter().filter(|(t, _)| *t == tag).map(|(_, s)| clean(s.get("id"))).collect();
                        let want = match ids.as_slice() {
                            [one] => Ok(Some(one.clone())),
                            [] => Ok(st.tag(&tag).cloned().and_then(|id| registry.live_session_row(&st, &id).filter(|s| matches_scope(s, &scope)).map(|_| id))),
                            _ => Err(()),
                        };
                        assert_eq!(have, want, "scanning resolve, seed {seed} step {step} scope {scope:?}");
                    } else {
                        let have = registry.resolve_tag(&tag, &scope, ResolveOptions::default()).map_err(|_| ());
                        let st = registry.lock();
                        let ids: Vec<String> =
                            old_entries(&registry, &st, &scope, registry.now()).iter().filter(|(t, _)| *t == tag).map(|(_, s)| clean(s.get("id"))).collect();
                        let want = match ids.as_slice() {
                            [one] => Ok(Some(one.clone())),
                            [] => Ok(st.tag(&tag).cloned().and_then(|id| registry.live_session_row(&st, &id).filter(|s| matches_scope(s, &scope)).map(|_| id))),
                            _ => Err(()),
                        };
                        assert_eq!(have, want, "resolve, seed {seed} step {step} scope {scope:?}");
                    }
                }
            }
            for _ in 0..2 {
                let scope = dice.pick(&scopes).clone();
                let tag = dice.pick(&workers).1.clone();
                check_reads(&registry, &scope, &tag, &format!("seed {seed} step {step} scope {scope:?}"));
            }
        }
    }
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

/// The stale-row pass and the scan guard against real Node's (`fixtures/agent-stale-rows/golden.json`, from
/// `benchmarks/rust-core/recorders/record-agent-stale-rows.mjs`): the rows and sessions of Node's own stale-row tests
/// go through a refresh, and the rows the index still holds, the tombstones it left and the scan's verdicts are
/// compared whole. A session Node's manager reports a runtime stage for is a running turn here: the core's stage is
/// only ever active inside a run.
const STALE_GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/agent-stale-rows/golden.json");

struct ConfigReap(Value);

impl ReapWindow for ConfigReap {
    fn terminal_reap_ms(&self, provider: &str) -> f64 {
        mixdog_agent::compact::settings::agent_terminal_reap_ms(self.0.get("autoClear"), provider)
    }
}

struct WorkLive {
    open: HashSet<String>,
    work: HashSet<String>,
}

impl LiveSessions for WorkLive {
    fn loaded(&self) -> Vec<String> {
        self.open.iter().cloned().collect()
    }

    fn header(&self, session: &str) -> Option<Row> {
        self.open.contains(session).then(|| obj(json!({ "id": session })))
    }

    fn running(&self, session: &str) -> bool {
        self.work.contains(session)
    }

    fn has_live_work(&self, session: &str) -> bool {
        self.work.contains(session)
    }

    fn runtime_stage(&self, _: &str) -> Option<String> {
        None
    }
}

fn ids(value: &Value) -> HashSet<String> {
    value.as_array().into_iter().flatten().map(|v| v.as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn the_stale_row_pass_and_the_scan_guard_equal_nodes() {
    let golden: Value = serde_json::from_str(&STALE_GOLDEN).unwrap();
    assert_eq!(golden["now"].as_i64(), Some(NOW));
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let config = case.get("config").cloned().unwrap_or_else(|| json!({}));
        let mgr = &case["mgr"];
        let mut work = ids(&mgr["turnInFlight"]);
        work.extend(ids(&mgr["pending"]));
        work.extend(mgr["stages"].as_object().into_iter().flatten().map(|(id, _)| id.clone()));
        let live = Arc::new(WorkLive { open: ids(&case["live"]), work });
        let rig = Rig::new();
        for row in case["rows"].as_array().unwrap() {
            rig.store.write(row["sessionId"].as_str().unwrap(), Some(obj(row.clone())));
        }
        let registry = AgentRegistry::new(rig.store.clone(), live.clone(), Arc::new(ConfigReap(config.clone())), rig.clock.clone());
        registry.refresh_tags_from_sessions(false, &Scope::default()).await;
        let mut workers = Vec::new();
        let mut tombstoned = Vec::new();
        for (id, map) in rig.store.listed() {
            if map.contains_key("sessionId") && map.get("agent").and_then(Value::as_str) != Some("lead") {
                workers.push(id.clone());
            }
            if let Some(tombstone) = map.get("tombstone") {
                tombstoned.push(format!("{}:{id}", tombstone["tag"].as_str().unwrap()));
            }
        }
        workers.sort();
        tombstoned.sort();
        assert_eq!(json!(workers), case["result"]["workers"], "{name}: rows held");
        assert_eq!(json!(tombstoned), case["result"]["tombstoned"], "{name}: tombstones");

        if let Some(sessions) = case["scan"].as_array() {
            let scan = Rig::new();
            *scan.store.sessions.lock().unwrap() = sessions.iter().map(|s| obj(s.clone())).collect();
            scan.store.touch_sessions();
            let registry = AgentRegistry::new(scan.store.clone(), Arc::new(WorkLive { open: HashSet::new(), work: HashSet::new() }), Arc::new(ConfigReap(config)), scan.clock.clone());
            registry.reload().await;
            let st = registry.lock();
            let by_key = st.tombstone_index(registry.now());
            let verdicts: Vec<bool> = sessions.iter().map(|s| registry.blocks_scan(&st, &obj(s.clone()), s["agentTag"].as_str().unwrap(), &by_key)).collect();
            assert_eq!(json!(verdicts), case["result"]["blocked"], "{name}: scan");
        }
    }
}
