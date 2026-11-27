use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use mixdog_core_ports::ports::threads::ThreadState;
use serde_json::Map;
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
    /// Mirrors `StoreWorkers`' `KeptMemory` change log so tests observe real `keep` -> `forget_session` ordering.
    kept_memory: Mutex<super::store_workers::KeptMemory>,
    sessions: Mutex<Vec<Row>>,
    /// The listings of every agent session read, closed ones included.
    listings: std::sync::atomic::AtomicUsize,
    headers: Mutex<HashMap<String, Row>>,
    dirs: Mutex<HashSet<String>>,
    /// The stored session records asked for.
    header_reads: std::sync::atomic::AtomicUsize,
    /// Every row write.
    written: tokio::sync::Notify,
    /// What a row write tells the agent status listener.
    on_write: std::sync::OnceLock<Box<dyn Fn(&str) + Send + Sync>>,
    /// The listener the product's store holds its row signals in.
    holds: std::sync::OnceLock<Arc<dyn signals::StatusSignals>>,
    /// The Lead index, and how many writes it had (told to the pool alone).
    leads: Mutex<HashMap<String, Row>>,
    lead_writes: std::sync::atomic::AtomicUsize,
    /// Reading the index takes a turn of the executor, as a read of the stored index does.
    slow: std::sync::atomic::AtomicBool,
    /// Bumped by each change of the index, the kept maps or the agent sessions.
    revision: std::sync::atomic::AtomicU64,
    /// An index read fails.
    fail: std::sync::atomic::AtomicBool,
    /// A read of every worker map fails (a session that could hold one was not projected).
    fail_maps: std::sync::atomic::AtomicBool,
    /// A release is answered refused and nothing of it is written.
    refuse_releases: std::sync::atomic::AtomicBool,
    /// The sessions this store can tell no identity of.
    unknown: Mutex<HashSet<String>>,
    /// The sessions the registry told the store were deleted.
    forgotten: Mutex<Vec<String>>,
    /// Reading the Lead index fails.
    fail_leads: std::sync::atomic::AtomicBool,
}

impl Store {
    fn announce(&self, session: &str) {
        if let Some(changed) = self.on_write.get() {
            changed(session);
        }
    }
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
        if self.fail_maps.load(Ordering::SeqCst) {
            return Err("index recovery failed for s-t: its rows were not projected".into());
        }
        Ok(self.listed())
    }

    fn kept_sessions(&self) -> Vec<String> {
        self.kept.lock().unwrap().iter().map(|(id, _)| id.clone()).collect()
    }

    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        self.listings.fetch_add(1, Ordering::SeqCst);
        Ok(self.sessions.lock().unwrap().clone())
    }

    async fn open_agent_sessions(&self) -> Result<Vec<Row>, String> {
        Ok(self.sessions.lock().unwrap().iter().filter(|row| row.get("closed") != Some(&json!(true))).cloned().collect())
    }

    fn keep(&self, session: &str, worker: Option<Row>) {
        self.revision.fetch_add(1, Ordering::SeqCst);
        let mut kept = self.kept.lock().unwrap();
        kept.retain(|(id, _)| id != session);
        if let Some(map) = worker.clone() {
            kept.push((session.to_owned(), map));
        }
        self.kept_memory.lock().unwrap().set(session, worker);
    }

    fn kept(&self, session: &str) -> bool {
        self.kept.lock().unwrap().iter().any(|(id, _)| id == session)
    }

    /// This store names every session by its id, kept or not, unless the session is in `unknown`. Its writes are its
    /// storage, so it has no record of a session holding anything but the registry's map.
    fn bound(&self, session: &str) -> Option<Bound> {
        if self.unknown.lock().unwrap().contains(session) {
            return None;
        }
        let target = if WorkerStore::kept(self, session) { ReleaseTarget::Kept } else { ReleaseTarget::Header };
        Some(Bound { target, incarnation: format!("store:{session}"), holds: None })
    }

    /// This store's write is its storage: the map is there when the write returns. While `refuse_releases` is set it stores no release and says so.
    fn release(&self, receipt: &ReleaseReceipt, _again: bool) -> ReleaseDone {
        if self.refuse_releases.load(Ordering::SeqCst) {
            return ReleaseDone::settled(ReleaseOutcome::Refused("the store refuses releases".into()));
        }
        self.write(&receipt.session_id, Some(receipt.released.clone()));
        ReleaseDone::settled(ReleaseOutcome::Stored)
    }

    async fn header(&self, session: &str) -> Result<Option<Row>, String> {
        self.header_reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.headers.lock().unwrap().get(session).cloned())
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
        self.announce(session);
    }

    async fn lead_rows(&self) -> Result<Vec<(String, Row)>, String> {
        if self.fail_leads.load(Ordering::SeqCst) {
            return Err("the Lead index could not be read".into());
        }
        Ok(self.leads.lock().unwrap().iter().map(|(id, row)| (id.clone(), row.clone())).collect())
    }

    fn write_lead(&self, session: &str, row: Option<Row>) {
        let mut leads = self.leads.lock().unwrap();
        match row {
            Some(row) => leads.insert(session.to_owned(), row),
            None => leads.remove(session),
        };
        self.lead_writes.fetch_add(1, Ordering::SeqCst);
    }

    fn forget_session(&self, session: &str) {
        self.forgotten.lock().unwrap().push(session.to_owned());
        self.kept_memory.lock().unwrap().forget(session);
    }

    fn hold_signals(&self, sessions: &[String]) -> Box<dyn Send> {
        self.holds.get().map_or_else(|| Box::new(()) as Box<dyn Send>, |signals| signals.hold(sessions))
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
        let sessions = self.sessions.lock().unwrap().iter().map(|s| (clean(s.get("id")), ListRow::of(s))).collect();
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
    /// Each session's header as published: a new `Arc` whenever the header changed, as the product publishes one.
    stamped: Mutex<HashMap<String, (Row, Arc<Row>)>>,
}

impl Live {
    fn published(&self, session: &str) -> Option<Arc<Row>> {
        let header = self.headers.lock().unwrap().get(session).cloned()?;
        let mut stamped = self.stamped.lock().unwrap();
        Some(match stamped.get(session) {
            Some((row, held)) if *row == header => held.clone(),
            _ => {
                let held = Arc::new(header.clone());
                stamped.insert(session.to_owned(), (header, held.clone()));
                held
            }
        })
    }

    /// The session leaves memory: its published header goes with it.
    fn unload(&self, session: &str) {
        self.headers.lock().unwrap().remove(session);
        self.stamped.lock().unwrap().remove(session);
    }
}

impl LiveSessions for Live {
    fn while_idle(&self, _session: &str, at: &mut dyn FnMut() -> bool) -> bool {
        at()
    }

    fn stamp(&self, session: &str) -> Option<LiveStamp> {
        let held: Arc<dyn std::any::Any + Send + Sync> = self.published(session)?;
        Some(LiveStamp { header: Arc::downgrade(&held), running: false, stage: None })
    }

    fn shared_header(&self, session: &str) -> Option<Arc<Row>> {
        self.published(session)
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
    registry.reload().await.unwrap();
    let initial = [true, false, true, false, true, true, false, false, false, true, true, false, false, false];
    assert_eq!(decisions(&registry, &checks), initial);

    registry.resolve_tombstone_owners().await;
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
        registry.refresh_tags_from_sessions(false, &scope).await.unwrap();
        (registry.session_entries(false, &scope).await, registry.read_worker_rows(&scope).unwrap(), registry.read_all_tag_tombstones())
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
    kept.reload().await.unwrap();
    kept.resolve_tombstone_owners().await;

    let ttl = TAG_TOMBSTONE_TTL_MS as i64;
    // The reaps are at NOW - 1h and the marker at NOW - 2d: they end at NOW + ttl - 1h and NOW + ttl - 2d.
    let offsets = [0, 1, HOUR, 3 * HOUR, ttl - 2 * DAY, ttl - 2 * DAY + 1, ttl - HOUR, ttl - HOUR + 1, ttl + 1, ttl + DAY, 0, ttl - HOUR];
    for offset in offsets {
        rig.clock.0.store(NOW + offset, Ordering::SeqCst);
        let fresh = rig.registry();
        fresh.reload().await.unwrap();
        fresh.resolve_tombstone_owners().await;
        let (have, want) = (index_reads(&kept), index_reads(&fresh));
        assert_eq!(have.0, want.0, "rows at +{offset}");
        assert_eq!(have.1, want.1, "all rows at +{offset}");
        assert_eq!(have.2, want.2, "stored tombstones at +{offset}");
        assert_eq!(have.3, want.3, "tombstones at +{offset}");
    }
}

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
    kept.reload().await.unwrap();
    kept.resolve_tombstone_owners().await;

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
        fresh.reload().await.unwrap();
        // A read made before the owners of this instant are resolved is kept, and the resolve must invalidate it (`owners` is
        // an input of `tombstones`): each refresh of the kept registry resolves the owners again, as the registry's own does.
        let _ = reads(&kept);
        kept.resolve_tombstone_owners().await;
        fresh.resolve_tombstone_owners().await;
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

/// An agent tool call's scan of the sessions reads only the open ones from the index; a listing that needs the closed ones
/// still reads them all.
#[tokio::test]
async fn a_scan_of_the_sessions_reads_only_the_open_ones_from_the_index() {
    let rig = Rig::new();
    let shut = json!({ "closed": true });
    rig.store.sessions.lock().unwrap().push(session("sess_open", "open", &at(NOW - HOUR), json!({})));
    rig.store.sessions.lock().unwrap().push(session("sess_shut", "shut", &at(NOW - HOUR), shut));
    rig.store.touch_sessions();
    let registry = rig.registry();
    registry.refresh_tags_from_sessions(true, &lead("lead-a")).await.unwrap();
    assert_eq!(registry.tag_session("open").as_deref(), Some("sess_open"), "the scan binds the open session's tag");
    assert_eq!(registry.tag_session("shut"), None);
    assert_eq!(rig.store.listings.load(Ordering::SeqCst), 0, "the scan read no listing of the closed sessions");
    assert_eq!(registry.descendants("lead-a").await.unwrap(), ["sess_open", "sess_shut"]);
    assert_eq!(rig.store.listings.load(Ordering::SeqCst), 1);
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
        let header = obj(
            json!({ "agentTag": format!("r{i}"), "parentSessionId": "lead-a", "ownerSessionId": "lead-a", "agent": "worker", "status": "running", "createdAt": created }),
        );
        rig.live.headers.lock().unwrap().insert(id, header);
    }
    let registry = rig.registry();
    let scope = lead("lead-a");
    for _ in 0..3 {
        registry.refresh_tags_from_sessions(true, &scope).await.unwrap();
        assert_eq!(registry.session_entries(true, &scope).await.len(), 6);
        assert!(registry.read_worker_rows(&scope).unwrap().len() >= 6);
    }
    assert_eq!(rig.store.header_reads.load(Ordering::SeqCst), 0, "a pass loaded a session's record");
}

/// The tag facts of a loaded session point at its published header instead of keeping a copy of it (a worker's header carries
/// its whole tool list), and neither they nor the stamp keep it alive: once the session leaves memory its header is freed,
/// with no pass of the registry in between.
#[tokio::test]
async fn the_tag_facts_share_a_loaded_header_and_keep_none_of_it_after_unload() {
    let rig = Rig::new();
    let tools = json!([{ "name": "read", "description": "d".repeat(4096), "inputSchema": { "type": "object" } }]);
    let header = session("s-a", "ta", &at(NOW - HOUR), json!({ "tools": tools }));
    rig.live.headers.lock().unwrap().insert("s-a".into(), header.clone());
    let registry = rig.registry();
    registry.bind_tag("ta", &session_facts(&header), &at(NOW)).await;
    let published = rig.live.published("s-a").expect("loaded");
    {
        let st = registry.lock();
        let now = registry.now();
        let pass = registry.tag_pass(&st, now);
        let facts = registry.facts_of(&st, &pass, "ta", "s-a", now);
        assert!(Arc::ptr_eq(facts.session.as_ref().expect("the loaded session"), &published), "the facts copied the header");
    }
    assert_eq!(Arc::strong_count(&published), 2, "the registry holds the published header");
    let kept = Arc::downgrade(&published);
    drop(published);
    rig.live.unload("s-a");
    assert!(kept.upgrade().is_none(), "the registry kept an unloaded session's header alive");
}

/// A cancelled session reads `cancelled` through a copy of its header made for the read only: once the session leaves memory
/// nothing of its header, the overlaid copy included, is left in the registry.
#[tokio::test]
async fn a_cancelled_session_leaves_no_header_copy_after_unload() {
    let rig = Rig::new();
    let tools = json!([{ "name": "read", "description": "d".repeat(4096) }]);
    let header = session("s-c", "tc", &at(NOW - HOUR), json!({ "tools": tools, "status": "running" }));
    rig.live.headers.lock().unwrap().insert("s-c".into(), header.clone());
    let registry = rig.registry();
    registry.bind_tag("tc", &session_facts(&header), &at(NOW)).await;
    registry.set_cancelled("s-c", true);
    let read = {
        let st = registry.lock();
        let now = registry.now();
        let pass = registry.tag_pass(&st, now);
        let facts = registry.facts_of(&st, &pass, "tc", "s-c", now);
        facts.session.expect("the loaded session")
    };
    assert_eq!(read["status"], json!("cancelled"));
    let copy = Arc::downgrade(&read);
    drop(read);
    assert!(copy.upgrade().is_none(), "the registry kept the overlaid copy of the header");
    let published = Arc::downgrade(&rig.live.published("s-c").expect("loaded"));
    rig.live.unload("s-c");
    assert!(published.upgrade().is_none(), "the registry kept a cancelled session's header alive");
    // Read again while loaded, it still reads cancelled: the overlay comes from the header, not from a kept copy.
    rig.live.headers.lock().unwrap().insert("s-c".into(), header);
    let st = registry.lock();
    let now = registry.now();
    let pass = registry.tag_pass(&st, now);
    assert_eq!(registry.facts_of(&st, &pass, "tc", "s-c", now).session.expect("loaded")["status"], json!("cancelled"));
}

/// A session that loads between the directory's answers: it has no published header when the tag facts ask, and a live
/// header right after.
struct LoadsMeanwhile(Row);

impl LiveSessions for LoadsMeanwhile {
    fn while_idle(&self, _session: &str, at: &mut dyn FnMut() -> bool) -> bool {
        at()
    }

    fn loaded(&self) -> Vec<String> {
        Vec::new()
    }

    fn header(&self, _: &str) -> Option<Row> {
        Some(self.0.clone())
    }

    fn shared_header(&self, _: &str) -> Option<Arc<Row>> {
        None
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

/// The tag facts ask the directory once: a session it has no header of is read from the index alone, so a session that
/// loads meanwhile is never copied from its live header into facts kept as an index row.
#[tokio::test]
async fn the_tag_facts_of_a_session_not_loaded_read_only_the_index() {
    let rig = Rig::new();
    let header = session("s-r", "tr", &at(NOW - HOUR), json!({}));
    let registry = AgentRegistry::new(rig.store.clone(), Arc::new(LoadsMeanwhile(header.clone())), Arc::new(Hour), rig.clock.clone());
    registry.bind_tag("tr", &session_facts(&header), &at(NOW)).await;
    let st = registry.lock();
    let now = registry.now();
    let pass = registry.tag_pass(&st, now);
    assert!(registry.facts_of(&st, &pass, "tr", "s-r", now).session.is_none(), "the facts copied a live header the directory did not publish");
}

/// A pass reads a tag's facts once: a header the session publishes during the pass, with the one the pass read freed by
/// everyone else, changes neither what the pass selects nor the rows it answers; the reading goes when the pass ends.
#[tokio::test]
async fn a_tag_pass_answers_from_its_one_reading() {
    let rig = Rig::new();
    let header = session("s-p", "tp", &at(NOW - HOUR), json!({}));
    rig.live.headers.lock().unwrap().insert("s-p".into(), header.clone());
    let registry = rig.registry();
    registry.bind_tag("tp", &session_facts(&header), &at(NOW)).await;
    // A first pass keeps the facts; the second takes them from the published header.
    {
        let st = registry.lock();
        drop(registry.tag_pass(&st, registry.now()));
    }
    let read = Arc::downgrade(&rig.live.published("s-p").expect("loaded"));
    let st = registry.lock();
    let now = registry.now();
    let pass = registry.tag_pass(&st, now);
    let mut moved = header.clone();
    moved.insert("status".into(), json!("running"));
    rig.live.headers.lock().unwrap().insert("s-p".into(), moved);
    let newer = rig.live.published("s-p").expect("loaded");
    assert!(!Arc::ptr_eq(&newer, &read.upgrade().expect("the pass holds its reading")), "a new header is published");
    let facts = registry.facts_of(&st, &pass, "tp", "s-p", now);
    assert!(Arc::ptr_eq(facts.session.as_ref().expect("loaded"), &read.upgrade().expect("held")), "the pass read the session twice");
    drop(facts);
    drop(pass);
    drop(st);
    assert!(read.upgrade().is_none(), "the pass's reading outlived the pass");
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
    first.refresh_tags_from_sessions(false, &scope).await.unwrap();
    first.bind_tag("rev", &session_facts(&rev), &at(NOW)).await;
    assert!(!row_of(&first).expect("bound").contains_key("released"));
    // `close`: the row goes and the owner's marker is set.
    first.forget_terminal_session(Some("rev"), "sess_rel_1");
    first.mark_released(&["sess_rel_1".into()]);
    assert_eq!(rig.store.map("sess_rel_1"), Some(obj(json!({ "releasedAt": at(NOW) }))));

    let second = rig.registry();
    second.refresh_tags_from_sessions(true, &scope).await.unwrap();
    // DECIDED DEPARTURE FROM NODE: this is what Node recorded and what a `send` still relies on (a closed agent is
    // revived by its tag). A SPAWN no longer sees it: `ResolveOptions::skip_released` frees the tag for a new session
    // (`a_spawn_resolve_gives_a_closed_session_its_tag_up`).
    assert_eq!(second.tag_session("rev").as_deref(), Some("sess_rel_1"), "the scan binds it again");
    assert_eq!(row_of(&second).expect("re-indexed")["released"], json!(true));
    assert!(!rig.store.map("sess_rel_1").unwrap().contains_key("released"), "released is never stored");

    rig.clock.0.store(NOW + 6 * DAY, Ordering::SeqCst);
    assert_eq!(row_of(&second).expect("row")["released"], json!(true), "still released on day 6");
    rig.clock.0.store(NOW + 7 * DAY + 1, Ordering::SeqCst);
    assert!(!row_of(&second).expect("row").contains_key("released"), "not released once 7 days passed");
}

/// DECIDED DEPARTURE FROM NODE: a spawn resolving the tag of an agent its owner closed finds the tag free (Node's scan
/// bound the closed session again and the spawn reused it, whatever it asked for), a send still reaches the closed
/// agent, and a new session that takes the tag is the one both resolve to, not an ambiguity with the closed one.
#[tokio::test]
async fn a_spawn_resolve_gives_a_closed_session_its_tag_up() {
    let rig = Rig::new();
    let created = at(NOW - HOUR);
    let row = |id: &str, cwd: &str| {
        obj(json!({
            "id": id, "agentTag": "rev", "ownerSessionId": "lead-rel", "parentSessionId": "lead-rel",
            "agent": "reviewer", "provider": "anthropic-oauth", "status": "idle", "cwd": cwd,
            "createdAt": created, "updatedAt": created, "lastUsedAt": created,
        }))
    };
    let (old, new) = (row("sess_rel_1", "/a"), row("sess_rel_2", "/b"));
    *rig.store.sessions.lock().unwrap() = vec![old.clone()];
    rig.store.touch_sessions();
    let scope = lead("lead-rel");
    let registry = rig.registry();
    registry.refresh_tags_from_sessions(false, &scope).await.unwrap();
    registry.bind_tag("rev", &session_facts(&old), &at(NOW)).await;
    registry.forget_terminal_session(Some("rev"), "sess_rel_1");
    registry.mark_released(&["sess_rel_1".into()]);

    let scan = ResolveOptions { scan_sessions: true, ..ResolveOptions::default() };
    // A send's scan binds the closed agent again (it is revived by its tag).
    registry.refresh_tags_from_sessions(true, &scope).await.unwrap();
    assert_eq!(registry.resolve_tag("rev", &scope, scan).await, Ok(Some("sess_rel_1".into())), "a send reaches a closed agent");
    // A spawn finds the tag free, however long ago the close was, and the scan does not take it back.
    let spawn = ResolveOptions { scan_sessions: true, skip_released: true, ..ResolveOptions::default() };
    assert_eq!(registry.resolve_tag("rev", &scope, spawn).await, Ok(None));
    assert_eq!(registry.tag_session("rev"), None);
    assert!(registry.is_released("sess_rel_1"), "the release marker stays");
    // The new session takes the tag; later scans resolve to it, never to both.
    *rig.store.sessions.lock().unwrap() = vec![old.clone(), new.clone()];
    rig.store.touch_sessions();
    registry.bind_tag("rev", &session_facts(&new), &at(NOW)).await;
    registry.refresh_tags_from_sessions(true, &scope).await.unwrap();
    assert_eq!(registry.resolve_tag("rev", &scope, scan).await, Ok(Some("sess_rel_2".into())));
}

/// A closed session yields its tag only to a session of the same owner: another lead's live agent under the same tag never
/// hides the caller's own closed one, so a send (`recover`: a scan) revives it, and the other lead's binding stays.
#[tokio::test]
async fn another_owners_binding_of_the_tag_does_not_hide_a_closed_session() {
    let rig = Rig::new();
    let created = at(NOW - HOUR);
    let row = |id: &str, owner: &str| {
        obj(json!({
            "id": id, "agentTag": "rev", "ownerSessionId": owner, "parentSessionId": owner,
            "agent": "reviewer", "provider": "anthropic-oauth", "status": "idle", "cwd": "/w",
            "createdAt": created, "updatedAt": created, "lastUsedAt": created,
        }))
    };
    let (mine, theirs) = (row("sess_a", "lead-a"), row("sess_b", "lead-b"));
    *rig.store.sessions.lock().unwrap() = vec![mine.clone(), theirs.clone()];
    rig.store.touch_sessions();
    let (scope_a, scope_b) = (lead("lead-a"), lead("lead-b"));
    let registry = rig.registry();
    registry.refresh_tags_from_sessions(false, &scope_a).await.unwrap();
    registry.bind_tag("rev", &session_facts(&mine), &at(NOW)).await;
    registry.forget_terminal_session(Some("rev"), "sess_a");
    registry.mark_released(&["sess_a".into()]);
    registry.bind_tag("rev", &session_facts(&theirs), &at(NOW)).await;

    let scan = ResolveOptions { scan_sessions: true, ..ResolveOptions::default() };
    assert_eq!(registry.resolve_tag("rev", &scope_a, scan).await, Ok(Some("sess_a".into())), "A's own closed session is revived");
    assert_eq!(registry.resolve_tag("rev", &scope_b, scan).await, Ok(Some("sess_b".into())));
    assert_eq!(registry.tag_session("rev").as_deref(), Some("sess_b"), "B's binding is untouched");
}

/// "Same owner" is the identity the scope rules use: a closed session yields its tag to an open one of the same owner
/// session, or, where no owner session is named, of the same host process; sessions of different host processes stay an
/// ambiguity (a global scanning resolve), and sessions with no owner identity are never the same owner.
#[tokio::test]
async fn a_closed_session_yields_its_tag_only_to_the_same_owner_identity() {
    let created = at(NOW - HOUR);
    let row = |id: &str, session_owner: &str, pid: Option<u64>| {
        obj(json!({
            "id": id, "agentTag": "rev", "ownerSessionId": session_owner, "parentSessionId": session_owner,
            "clientHostPid": pid, "agent": "reviewer", "provider": "anthropic-oauth", "status": "idle", "cwd": "/w",
            "createdAt": created, "updatedAt": created, "lastUsedAt": created,
        }))
    };
    let global = ResolveOptions { scan_sessions: true, ..ResolveOptions::default() };
    // (closed session, open session, what a global scanning resolve answers)
    let cases = [
        (
            "host pids 1 and 2",
            row("sess_c", "", Some(1)),
            row("sess_o", "", Some(2)),
            Err("agent: tag \"rev\" is ambiguous across terminals; use sessionId".to_owned()),
        ),
        ("one host pid", row("sess_c", "", Some(1)), row("sess_o", "", Some(1)), Ok(Some("sess_o".to_owned()))),
        (
            "no owner identity",
            row("sess_c", "", None),
            row("sess_o", "", None),
            Err("agent: tag \"rev\" is ambiguous across terminals; use sessionId".to_owned()),
        ),
        ("owner sessions", row("sess_c", "lead-a", Some(1)), row("sess_o", "lead-a", Some(2)), Ok(Some("sess_o".to_owned()))),
        (
            "owner session and a host process",
            row("sess_c", "lead-a", Some(1)),
            row("sess_o", "", Some(1)),
            Err("agent: tag \"rev\" is ambiguous across terminals; use sessionId".to_owned()),
        ),
    ];
    for (name, closed, open, want) in cases {
        let rig = Rig::new();
        *rig.store.sessions.lock().unwrap() = vec![closed.clone(), open.clone()];
        rig.store.touch_sessions();
        let registry = rig.registry();
        registry.reload().await.unwrap();
        registry.mark_released(&["sess_c".into()]);
        assert_eq!(registry.resolve_tag("rev", &Scope::default(), global).await, want, "{name}");
    }
}

/// An agent its owner closed is released for the list (Node's list drops a closed agent): the marker reads
/// released until a turn starts on the session or the TTL passes, and a session never closed is not.
#[tokio::test]
async fn a_closed_agent_reads_released_until_a_turn_starts_or_the_marker_expires() {
    let rig = Rig::new();
    let registry = rig.registry();
    assert!(!registry.is_released("sess_idle_closed"), "no marker, not released");
    registry.mark_released(&["sess_idle_closed".into()]);
    assert!(registry.is_released("sess_idle_closed"));
    assert!(!registry.is_released("sess_other"));
    crate::session::TurnStarts::turn_started(&registry, &mixdog_core_api::ids::ThreadId::from("sess_idle_closed"), &"turn".into());
    assert!(!registry.is_released("sess_idle_closed"), "a turn on it lifts the release");
    registry.mark_released(&["sess_idle_closed".into()]);
    rig.clock.0.store(NOW + 7 * DAY + 1, Ordering::SeqCst);
    assert!(!registry.is_released("sess_idle_closed"), "the marker expires with the TTL");
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
    registry.refresh_tags_from_sessions(true, &lead("lead-a")).await.unwrap();
    let none = ResolveOptions::default();
    assert_eq!(registry.resolve_tag("rev", &lead("lead-a"), none).await, Ok(Some("sess_a".into())));
    // lead-b's session is not indexed yet: only a scan finds it.
    assert_eq!(registry.resolve_tag("rev", &lead("lead-b"), none).await, Ok(None));
    let scan = ResolveOptions { scan_sessions: true, ..none };
    assert_eq!(registry.resolve_tag("rev", &lead("lead-b"), scan).await, Ok(Some("sess_b".into())));
    assert_eq!(registry.resolve_tag("rev", &lead("lead-c"), none).await, Ok(None));
    assert_eq!(registry.resolve_tag("sess_b", &lead("lead-a"), none).await, Ok(None));
    let everyone = Scope::default();
    assert_eq!(registry.resolve_tag("rev", &everyone, scan).await, Err("agent: tag \"rev\" is ambiguous across terminals; use sessionId".into()));
    // A trace check of an ambiguous tag raises the resolver's error to the caller.
    assert_eq!(
        TerminalTrace::has_terminal_trace(&registry, "rev", &everyone).await,
        Err("agent: tag \"rev\" is ambiguous across terminals; use sessionId".into())
    );
    assert_eq!(TerminalTrace::has_terminal_trace(&registry, "rev", &lead("lead-a")).await, Ok(false), "live: reused");
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

/// B-15: a close that stopped a running turn leaves the session reading `cancelled` after a restart too: the mark is on its worker
/// row, so the next process's scan builds the closed agent no open idle row; a turn that starts on it takes the mark off the row.
#[tokio::test]
async fn a_close_that_stopped_a_turn_is_still_read_cancelled_by_the_next_process() {
    let rig = Rig::new();
    rig.live.headers.lock().unwrap().insert("s1".to_owned(), session("s1", "t1", &at(NOW), json!({})));
    rig.store.write("s1", Some(worker_row("s1", "t1", json!({}))));
    let state = |row: &Row| (row.get("status").cloned(), row.get("stage").cloned());
    let cancelled = (Some(json!("cancelled")), Some(json!("cancelled")));

    let first = rig.registry();
    first.refresh_tags_from_sessions(false, &lead("lead-a")).await.unwrap();
    assert_ne!(state(&first.session_of("s1").await.expect("the session")), cancelled);
    first.set_cancelled("s1", true);
    assert_eq!(state(&first.session_of("s1").await.expect("the session")), cancelled);

    let next = rig.registry();
    next.refresh_tags_from_sessions(false, &lead("lead-a")).await.unwrap();
    assert_eq!(state(&next.session_of("s1").await.expect("the session")), cancelled, "the next process reads the mark off the row");
    crate::session::TurnStarts::turn_started(&next, &mixdog_core_api::ids::ThreadId::from("s1"), &"turn".into());
    assert_ne!(state(&next.session_of("s1").await.expect("the session")), cancelled, "a turn started on it");
    let after = rig.registry();
    after.refresh_tags_from_sessions(false, &lead("lead-a")).await.unwrap();
    assert_ne!(state(&after.session_of("s1").await.expect("the session")), cancelled, "and the row no longer holds the mark");
}

/// A listing gives the loaded sessions, then each stored agent-only row whole (its members in their order, its numbers exact)
/// in the index's order, without the closed ones and without a loaded one again; a lookup gives a loaded session's header, the
/// stored row of a session not loaded, closed or not, and nothing for a session the index does not list.
#[tokio::test]
async fn a_listing_and_a_lookup_give_the_stored_rows_whole_and_in_order() {
    let rig = Rig::new();
    let stored = [
        json!({ "id": "s-b", "title": "second", "messageCount": 3, "cost": 0.1, "ratio": 1e-7, "nested": { "z": 1, "a": [1, 2.5, "x", null] } }),
        json!({ "zeta": "members in their stored order", "id": "s-closed", "closed": true, "alpha": null }),
        json!({ "agentTag": "t-a", "id": "s-a", "createdAt": at(NOW - HOUR) }),
        json!({ "id": "s-live", "title": "as the index last saw it" }),
    ];
    *rig.store.sessions.lock().unwrap() = stored.iter().map(|row| obj(row.clone())).collect();
    rig.store.touch_sessions();
    let loaded = json!({ "id": "s-live", "title": "loaded" });
    rig.live.headers.lock().unwrap().insert("s-live".to_owned(), obj(loaded.clone()));
    let registry = rig.registry();
    registry.reload().await.unwrap();

    let text = |row: &Row| serde_json::to_string(row).unwrap();
    let listed: Vec<String> = registry.open_sessions().await.iter().map(|row| text(row)).collect();
    assert_eq!(listed, [loaded.to_string(), stored[0].to_string(), stored[2].to_string()]);
    assert_eq!(registry.session_of("s-closed").await.map(|row| text(&row)), Some(stored[1].to_string()));
    assert_eq!(registry.session_of("s-a").await.map(|row| text(&row)), Some(stored[2].to_string()));
    assert_eq!(registry.session_of("s-live").await.map(|row| text(&row)), Some(loaded.to_string()));
    assert!(registry.session_of("s-none").await.is_none());
}

/// `agent send` to a session by its id: an open agent-only session that is not loaded and has neither a worker row nor a tag
/// is resolved, and the lookup the send world makes of it once the resolve has ended (`SessionRows::row`) still finds it.
#[tokio::test]
async fn a_send_to_an_open_session_with_no_worker_row_and_no_tag_reaches_it() {
    let rig = Rig::new();
    let open = session("sess_open", "", &at(NOW - HOUR), json!({ "visibility": "agent-only" }));
    *rig.store.sessions.lock().unwrap() = vec![open.clone()];
    rig.store.touch_sessions();
    let registry = rig.registry();
    registry.reload().await.unwrap();
    assert_eq!(registry.resolve_tag("sess_open", &lead("lead-a"), ResolveOptions::default()).await, Ok(Some("sess_open".into())));
    assert_eq!(registry.session_row("sess_open").await, Some(open));
}

/// The agent-only sessions are read from the index when asked: one the index lists only after the registry loaded is found by
/// a lookup, a resolve of its id, a scanning listing and a resolve of the tag that listing bound; one whose tag a reap
/// tombstoned is neither listed by the scan nor resolved by its tag.
#[tokio::test]
async fn a_session_created_after_boot_is_found_and_a_tombstoned_one_is_not() {
    let rig = Rig::new();
    let reaped = session("sess_gone", "gone", &at(NOW - 2 * HOUR), json!({}));
    *rig.store.sessions.lock().unwrap() = vec![reaped];
    rig.store.touch_sessions();
    rig.store.write("sess_gone", without_row(&obj(json!({ "tombstone": tombstone("gone", &at(NOW - HOUR), json!({})) }))));
    let registry = rig.registry();
    registry.reload().await.unwrap();

    let created = session("sess_new", "fresh", &at(NOW - HOUR / 6), json!({}));
    rig.store.sessions.lock().unwrap().insert(0, created.clone());
    rig.store.touch_sessions();
    let scope = lead("lead-a");
    assert_eq!(registry.session_of("sess_new").await.map(|row| Row::clone(&row)), Some(created));
    assert_eq!(registry.resolve_tag("sess_new", &scope, ResolveOptions::default()).await, Ok(Some("sess_new".into())));
    let listed: Vec<(String, String)> = registry.session_entries(true, &scope).await.into_iter().map(|(tag, row)| (tag, clean(row.get("id")))).collect();
    assert_eq!(listed, [("fresh".to_owned(), "sess_new".to_owned())]);
    assert_eq!(registry.resolve_tag("fresh", &scope, ResolveOptions::default()).await, Ok(Some("sess_new".into())));
    let scan = ResolveOptions { scan_sessions: true, ..ResolveOptions::default() };
    assert_eq!(registry.resolve_tag("gone", &scope, scan).await, Ok(None));
}

#[derive(Default)]
struct CountedSweeps(std::sync::atomic::AtomicUsize);

#[async_trait::async_trait]
impl restart::RestartSweep for CountedSweeps {
    async fn sweep(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
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
    registry.refresh_tags_from_sessions(false, &scope).await.unwrap();
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
/// a tombstone; a working row and an owed restart failure stay; a deleted Lead's pool row goes with no
/// tombstone (`forgetLeadSession`).
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
    for kept in ["s-busy", "s-missing", ""] {
        assert!(!registry.forget_deleted_session(kept).await, "{kept}");
    }
    assert!(rig.store.map("s-busy").unwrap().contains_key("sessionId"));
    assert!(registry.forget_deleted_session("s-lead").await, "the Lead's row goes");
    assert!(rig.store.map("s-lead").is_none(), "with no tombstone");
}

/// What the registry keeps for one session (a cancellation mark and epoch, a removed Lead's row, the Lead's scope view and the
/// store's incarnation) goes when the session is deleted, and the other sessions keep theirs.
#[tokio::test]
async fn a_deleted_session_leaves_nothing_of_its_own_in_the_registry() {
    let rig = Rig::new();
    let registry = Arc::new(rig.registry());
    for id in ["s-gone", "s-kept"] {
        registry.set_cancelled(id, true);
        drop(registry.begin_cancellation(&[id.to_owned()]));
        registry.lock().lead_rows.insert(id.to_owned(), None);
    }

    registry.forget_deleted_session("s-gone").await;

    assert_eq!(*rig.store.forgotten.lock().unwrap(), ["s-gone"]);
    let cancelled = registry.cancelled.lock().unwrap().iter().cloned().collect::<Vec<_>>();
    assert_eq!(cancelled, ["s-kept"]);
    let st = registry.lock();
    assert_eq!(st.epochs.keys().collect::<Vec<_>>(), ["s-kept"]);
    assert_eq!(st.lead_rows.keys().collect::<Vec<_>>(), ["s-kept"]);
}

/// A Lead deleted while the Lead index could not be read leaves no tombstone once the removal is written, and the row does not come back
/// when the index is read later.
#[tokio::test]
async fn a_deleted_lead_stays_deleted_when_the_index_was_unreadable_at_the_delete() {
    let rig = Rig::new();
    rig.store.write("s-lead", Some(worker_row("s-lead", "lead", json!({ "agent": "lead" }))));
    rig.store.fail_leads.store(true, Ordering::SeqCst);
    let registry = rig.registry();
    assert!(registry.forget_deleted_session("s-lead").await);
    rig.store.fail_leads.store(false, Ordering::SeqCst);
    registry.reload().await.unwrap();
    assert!(registry.lock().lead_rows.get("s-lead").is_none_or(Option::is_none), "the deleted Lead's row is not read back");
    assert!(rig.store.leads.lock().unwrap().is_empty());
}

/// A Lead that unloads lets go of its scope view of its agents; another Lead's stays, and the read makes it again.
#[tokio::test]
async fn an_unloaded_leads_scope_view_is_released_and_made_again_by_the_next_read() {
    let rig = Rig::new();
    let registry = rig.registry();
    let now = registry.now();
    for id in ["lead-a", "lead-b"] {
        registry.lock().rows(&lead(id), now);
    }
    assert_eq!(registry.lock().views.get_mut().scopes_held(), 2);
    registry.forget_scope("lead-a");
    assert_eq!(registry.lock().views.get_mut().scopes_held(), 1);
    registry.lock().rows(&lead("lead-a"), now);
    assert_eq!(registry.lock().views.get_mut().scopes_held(), 2);
}

/// A session deleted while the daemon runs: Node's purge hook forgets it (`agent-tool.mjs:347`, `gone-rows.mjs:214`), its
/// index file keeps the working row and the owed restart failure, and every later listing shows them
/// (`store-agent-worker-rows.mjs` `projectChildWorkerRow` over a null header); the settled row leaves as a tombstone, and
/// the deleted Lead's pool row leaves at once (`forgetLeadSession`). The core's index lists no row of a deleted session, so
/// the registry keeps the rows Node keeps and removes the Lead row it keeps too.
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
    let before = registry.pool_index().await.unwrap();
    let kept: Vec<(&str, Vec<Value>)> = ["s-busy", "s-owed"].into_iter().map(|id| (id, row_of(&before, id))).collect();
    for (id, rows) in &kept {
        assert_eq!(rows.len(), 1, "{id} is listed before the delete");
    }
    assert_eq!(row_of(&before, "s-lead").len(), 1, "the Lead row is listed before the delete");
    // The delete: the index drops every row of the deleted sessions.
    rig.store.maps.lock().unwrap().clear();
    rig.store.touch_sessions();
    assert!(registry.forget_deleted_session("s-done").await, "the settled row goes");
    for (id, _) in &kept {
        assert!(!registry.forget_deleted_session(id).await, "{id} stays");
    }
    assert!(registry.forget_deleted_session("s-lead").await, "the Lead row goes");
    assert!(!WorkerStore::kept(&*rig.store, "s-lead"), "and is not kept apart from the index");
    for listing in 0..2 {
        let after = registry.pool_index().await.unwrap();
        for (id, rows) in &kept {
            assert_eq!(&row_of(&after, id), rows, "listing {listing}: {id} as before the delete");
        }
        assert_eq!(row_of(&after, "s-lead"), Vec::<Value>::new(), "listing {listing}: the Lead row is gone");
        assert_eq!(row_of(&after, "s-done"), Vec::<Value>::new(), "listing {listing}: the settled row is gone");
        let tombstones = after.0["tombstones"].as_array().unwrap();
        assert_eq!(tombstones.iter().filter(|t| t["tag"] == "done").count(), 1, "listing {listing}: its tombstone: {tombstones:?}");
    }
}

/// Kept rows live in memory once loaded, and the table loses a kept map once it holds only a tombstone past the TTL, or one
/// beyond the newest [`MAX_TAG_TOMBSTONES`] (`worker-rows.mjs:7,96-102`: Node's index file is rewritten with only those).
#[tokio::test]
async fn expired_and_surplus_kept_tombstones_leave_the_kept_table() {
    let rig = Rig::new();
    let max = super::rows::MAX_TAG_TOMBSTONES;
    let tombstone = |n: usize, reaped: i64| {
        obj(json!({ "tag": format!("t{n}"), "tombstone": { "tag": format!("t{n}"), "reapedAt": at(reaped), "ownerSessionId": "lead-a" } }))
    };
    // One past the TTL, then MAX + 1 live ones, the oldest of which is beyond the cap.
    rig.store.keep("s-expired", Some(tombstone(0, NOW - super::rows::TAG_TOMBSTONE_TTL_MS as i64 - 1)));
    for n in 1..=max + 1 {
        rig.store.keep(&format!("s-{n}"), Some(tombstone(n, NOW - n as i64 * 1000)));
    }
    let kept = || rig.store.kept.lock().unwrap().iter().map(|(id, _)| id.clone()).collect::<HashSet<String>>();
    assert_eq!(kept().len(), max + 2);
    rig.registry().refresh_tags_from_sessions(false, &lead("lead-a")).await.unwrap();
    let left = kept();
    assert_eq!(left.len(), max, "the table shrank");
    assert!(!left.contains("s-expired") && !left.contains(&format!("s-{}", max + 1)), "the expired one and the oldest beyond the cap left");
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

const LOADED: usize = 30;

/// A stored session's catalog row, as the index writes it from the session's header.
fn stored_head(id: &str, mut header: Row) -> mixdog_store::summary::CatalogHead {
    header.insert("id".into(), json!(id));
    mixdog_store::summary::CatalogHead { session: id.to_owned(), log_id: "log".into(), base_session: None, header: header.into() }
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

/// The product's store answering every load whole: the registry over it is what a registry fed deltas is compared with.
/// While held ([`Self::hold_writes`]), its map writes wait here instead of reaching the store.
struct Whole {
    workers: Arc<StoreWorkers>,
    held: Mutex<Option<Vec<(String, Option<Row>)>>>,
}

impl Whole {
    fn new(workers: Arc<StoreWorkers>) -> Self {
        Self { workers, held: Mutex::default() }
    }

    fn hold_writes(&self) {
        *self.held.lock().unwrap() = Some(Vec::new());
    }

    /// The writes held reach the store in order, and the next ones go straight there.
    fn release_writes(&self) {
        let held = self.held.lock().unwrap().take().unwrap_or_default();
        for (session, worker) in held {
            WorkerStore::write(&*self.workers, &session, worker);
        }
    }
}

#[async_trait]
impl WorkerStore for Whole {
    async fn index_since(&self, _: Option<Revision>) -> Result<Index, String> {
        self.workers.index_since(None).await
    }
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        WorkerStore::worker_maps(&*self.workers).await
    }
    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        WorkerStore::agent_sessions(&*self.workers).await
    }
    async fn header(&self, session: &str) -> Result<Option<Row>, String> {
        WorkerStore::header(&*self.workers, session).await
    }
    async fn is_directory(&self, _: &str) -> bool {
        false
    }
    fn write(&self, session: &str, worker: Option<Row>) {
        match self.held.lock().unwrap().as_mut() {
            Some(held) => held.push((session.to_owned(), worker)),
            None => WorkerStore::write(&*self.workers, session, worker),
        }
    }
    fn keep(&self, session: &str, worker: Option<Row>) {
        WorkerStore::keep(&*self.workers, session, worker);
    }
    fn kept(&self, session: &str) -> bool {
        WorkerStore::kept(&*self.workers, session)
    }
    fn kept_sessions(&self) -> Vec<String> {
        WorkerStore::kept_sessions(&*self.workers)
    }
    fn bound(&self, session: &str) -> Option<Bound> {
        WorkerStore::bound(&*self.workers, session)
    }
    fn release(&self, receipt: &ReleaseReceipt, again: bool) -> ReleaseDone {
        WorkerStore::release(&*self.workers, receipt, again)
    }
}

/// What a registry holds of the index: every map at its place, and the list row of each session a live agent stands for.
fn held(registry: &AgentRegistry) -> (Vec<(String, Place, Row)>, Vec<(String, Option<Row>)>) {
    let st = registry.lock();
    let maps = st.maps.iter().map(|(id, map)| (id.clone(), st.maps.key(id).cloned().expect("held"), map.clone())).collect();
    let mut rows: Vec<(String, Option<Row>)> = st.held.iter().map(|(id, row)| (id.clone(), row.as_deref().cloned())).collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    (maps, rows)
}

/// The state as an operation that lists the agent-only sessions holds it: with every one of them read from the index.
async fn listed(registry: &AgentRegistry) -> Operation<'_> {
    let reads = registry.read_index(Listed::Whole, &[]).await.expect("the index reads");
    registry.op(reads)
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
    registry.reload().await.unwrap();

    // A load is under way and one more waits behind it; then a write completes and the caller asks.
    let mut under_way = Box::pin(registry.reload());
    assert!(futures::poll!(under_way.as_mut()).is_pending());
    let mut next = Box::pin(registry.reload());
    assert!(futures::poll!(next.as_mut()).is_pending());
    rig.store.write("s-b", Some(worker_row("s-b", "b", json!({}))));
    let mut caller = Box::pin(registry.reload());
    assert!(futures::poll!(caller.as_mut()).is_pending());

    under_way.await.unwrap();
    assert!(registry.lock().map("s-b").is_none(), "the load under way read the store before the write");
    if cancelled {
        assert!(futures::poll!(next.as_mut()).is_pending(), "the next load started");
        drop(next);
    } else {
        rig.store.fail.store(true, Ordering::SeqCst);
        assert!(next.await.is_err(), "a load whose read failed answers the failure");
        rig.store.fail.store(false, Ordering::SeqCst);
    }
    caller.await.unwrap();
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
            out.push((tag, Row::clone(&session)));
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
        out.push((tag, Row::clone(&session)));
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
async fn check_reads(registry: &AgentRegistry, scope: &Scope, tag: &str, label: &str) {
    let now = registry.now();
    {
        // The public reads over the same index.
        let st = registry.lock();
        let record = |row: &Row| tag_record(row, "tag", "sessionId");
        let rows: Vec<TagRecord> = old_rows(&st, scope, now).iter().map(record).collect();
        let tombstones = old_tombstones(&st, now);
        let for_tag = (!tag.is_empty()).then(|| tombstones.iter().find(|row| matches_scope(row, scope) && clean(row.get("tag")) == tag).map(record)).flatten();
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
    let mut st = listed(registry).await;
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
    let have: Vec<(String, Row)> = registry.session_entries(false, scope).await.into_iter().map(|(tag, s)| (tag, (*s).clone())).collect();
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

struct Dead;
impl restart::ProcessProbe for Dead {
    fn alive(&self, _: u64) -> bool {
        false
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
            session(
                id,
                tag,
                &at(NOW - 3 * HOUR),
                json!({ "parentSessionId": owner, "ownerSessionId": owner, "status": status, "updatedAt": at(NOW - 2 * HOUR), "cwd": "/w" }),
            )
        };
        for (i, (id, tag, owner)) in workers.iter().enumerate() {
            let status = *dice.pick(&STATUSES);
            let mut map = if i % 4 == 3 {
                Row::new()
            } else {
                worker_row(
                    id,
                    tag,
                    json!({ "parentSessionId": owner, "ownerSessionId": owner, "status": status, "createdAt": at(NOW - 3 * HOUR), "updatedAt": at(NOW - 2 * HOUR) }),
                )
            };
            if i % 3 == 1 {
                let legacy = if i % 2 == 0 {
                    json!({ "parentSessionId": null, "ownerSessionId": null })
                } else {
                    json!({ "parentSessionId": owner, "ownerSessionId": owner })
                };
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
        registry.reload().await.unwrap();
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
                0 | 1 => {
                    registry.upsert_worker_row(&stored(&id, &tag, &owner, status), &tag, &obj(json!({ "status": status, "stage": status, "runtimePid": PID })))
                }
                2 => registry.mark_released(std::slice::from_ref(&id)),
                3 => crate::session::TurnStarts::turn_started(&registry, &mixdog_core_api::ids::ThreadId::from(id.as_str()), &"turn".into()),
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
                        0 => {
                            map = worker_row(
                                &id,
                                &tag,
                                json!({ "parentSessionId": owner, "ownerSessionId": owner, "status": status, "createdAt": at(NOW - HOUR) }),
                            )
                        }
                        1 => {
                            map.insert(
                                "tombstone".into(),
                                Value::Object(tombstone(&tag, &at(registry.now() as i64 - HOUR), json!({ "parentSessionId": null, "ownerSessionId": null }))),
                            );
                        }
                        _ => map = Row::new(),
                    }
                    let map = if map.contains_key("sessionId") { Some(map) } else { without_row(&map) };
                    rig.store.write(&id, map);
                    registry.reload().await.unwrap();
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
                    registry.reload().await.unwrap();
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
                        registry.bind_tag(&tag, &session_facts(&stored(&id, &tag, &owner, status)), &at(registry.now() as i64)).await;
                    } else {
                        registry.unbind_tag(&tag);
                    }
                }
                12 => registry.forget_terminal_session(Some(&tag), &id),
                13 => registry.reap_terminal_trace_for_tag(&tag, dice.pick(&scopes)).await,
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
                    registry.reload().await.unwrap();
                }
                17 => {
                    // The restart's own settlement and notification stamps go to the store; the registry loads them.
                    let running = |_: &str| false;
                    let live = restart::Liveness { probe: &AllAlive, own_pid: PID, running: &running, reap: &Hour, now_ms: registry.now() as i64 };
                    registry.recover_stale_worker_rows(dice.below(2) == 0, &live).await.unwrap();
                    registry.mark_restart_notified(std::slice::from_ref(&id), "stamp").await.unwrap();
                    registry.reload().await.unwrap();
                }
                18 => {
                    // A scanning listing adds the stored sessions it finds, and writes their rows.
                    let scope = dice.pick(&scopes).clone();
                    let head = {
                        let st = listed(&registry).await;
                        old_entries_head(&registry, &st, &scope, registry.now(), true)
                    };
                    let have: Vec<(String, Row)> = registry.session_entries(true, &scope).await.into_iter().map(|(t, s)| (t, (*s).clone())).collect();
                    let want = old_entries_tail(&registry, &registry.lock(), &scope, registry.now(), head);
                    assert_eq!(have, want, "scanning listing, seed {seed} step {step} scope {scope:?}");
                }
                _ => {
                    let scope = dice.pick(&scopes).clone();
                    if dice.below(3) == 0 {
                        // The listing before the scan's writes, over the index as the refresh at the head of the resolve leaves it.
                        let head = {
                            let mut st = listed(&registry).await;
                            registry.refresh(&mut st, true, &scope);
                            old_entries_head(&registry, &st, &scope, registry.now(), true)
                        };
                        let have = registry
                            .resolve_tag(&tag, &scope, ResolveOptions { scan_sessions: true, exclude_terminal_traces: false, skip_released: false })
                            .await
                            .map_err(|_| ());
                        let st = registry.lock();
                        let ids = tag_matches(&rig, registry.now() as i64, &old_entries_tail(&registry, &st, &scope, registry.now(), head), &tag);
                        let want = match ids.as_slice() {
                            [one] => Ok(Some(one.clone())),
                            [] => Ok(st.tag(&tag).cloned().and_then(|id| registry.live_session_row(&st, &id).filter(|s| matches_scope(s, &scope)).map(|_| id))),
                            _ => Err(()),
                        };
                        assert_eq!(have, want, "scanning resolve, seed {seed} step {step} scope {scope:?}");
                    } else {
                        let have = registry.resolve_tag(&tag, &scope, ResolveOptions::default()).await.map_err(|_| ());
                        let st = registry.lock();
                        let ids = tag_matches(&rig, registry.now() as i64, &old_entries(&registry, &st, &scope, registry.now()), &tag);
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
                check_reads(&registry, &scope, &tag, &format!("seed {seed} step {step} scope {scope:?}")).await;
            }
        }
    }
}

/// The sessions a resolve of `tag` is answered from, in the reference model, stated from the scripted world's own facts and
/// no production helper: the listed sessions under the tag, less each one its opener closed (the store holds a `releasedAt` less than
/// the seven-day marker TTL old) while another listed session under the tag is open and has the same opener. The opener is the
/// session that started it (`parentSessionId`, else `ownerSessionId`), and only when none is named the host process
/// (`clientHostPid`); sessions with neither are nobody's. Two open sessions stay an ambiguity.
fn tag_matches(rig: &Rig, now: i64, listed: &[(String, Row)], tag: &str) -> Vec<String> {
    let text = |s: &Row, key: &str| s.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_owned();
    let id = |s: &Row| text(s, "id");
    let opener = |s: &Row| {
        let parent = text(s, "parentSessionId");
        if parent.is_empty() { text(s, "ownerSessionId") } else { parent }
    };
    let host = |s: &Row| s.get("clientHostPid").and_then(Value::as_u64);
    let same_opener = |a: &Row, b: &Row| {
        let (x, y) = (opener(a), opener(b));
        if !x.is_empty() || !y.is_empty() { x == y } else { matches!((host(a), host(b)), (Some(p), Some(q)) if p == q) }
    };
    let oldest_marker = at(now - 7 * DAY);
    let closed = |s: &Row| {
        rig.store.map(&id(s)).and_then(|map| map.get("releasedAt").and_then(Value::as_str).map(|stamp| stamp >= oldest_marker.as_str())) == Some(true)
    };
    let under: Vec<&Row> = listed.iter().filter(|(t, _)| t == tag).map(|(_, s)| s).collect();
    under.iter().filter(|s| !closed(s) || !under.iter().any(|o| !closed(o) && same_opener(o, s))).map(|s| id(s)).collect()
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
    assert_eq!(
        (own["status"].as_str(), own["failureReason"].as_str(), own["updatedAt"].as_str()),
        (Some("failed"), Some("process-restart"), Some(at(NOW).as_str()))
    );
    for kept in ["s-taken", "s-other"] {
        assert_eq!(rig.store.map(kept).unwrap()["status"], "running", "{kept}");
    }
    assert_eq!(rig.store.map("s-idle").unwrap()["status"], "idle");
    // A second flush has nothing left to settle.
    registry.flush_active_worker_rows(&live);
    assert_eq!(rig.store.map("s-other").unwrap()["status"], "running");
}

/// The header seam of the close tests: a session whose header cannot be read fails its close; the stamps that land are kept in order.
#[derive(Default)]
struct Detaches {
    failing: Vec<String>,
    headers: Mutex<HashMap<String, serde_json::Map<String, Value>>>,
    /// The sessions whose close was refused, in order.
    refused: Mutex<Vec<String>>,
    /// The stamps that landed, in order: the session and whether it was an owner close.
    stamps: Mutex<Vec<(String, bool)>>,
}

#[async_trait]
impl ThreadState for Detaches {
    async fn header(&self, thread: &ThreadId) -> Result<mixdog_store::schema::record::Header, mixdog_tools::orch::util::PortError> {
        if self.failing.iter().any(|id| id == thread.as_str()) {
            self.refused.lock().unwrap().push(thread.as_str().to_owned());
            return Err(mixdog_tools::orch::util::PortError::Failed { capability: "session".into(), message: "the header cannot be written".into() });
        }
        Ok(self.headers.lock().unwrap().get(thread.as_str()).cloned().unwrap_or_default())
    }
    /// A close stamps through `patch_header_if`; the archive flag of a hidden or revealed session is the archive authority's.
    async fn patch_header(&self, _: &ThreadId, _: serde_json::Map<String, Value>, _: Vec<String>) -> Result<(), mixdog_tools::orch::util::PortError> {
        unreachable!("no header is patched: a hide and a reveal are the archive authority's")
    }
    async fn patch_header_at(
        &self,
        thread: &ThreadId,
        at: &mixdog_core_ports::ports::threads::RunFence,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<mixdog_core_ports::ports::threads::FencedPatch, mixdog_tools::orch::util::PortError> {
        mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
    }
    async fn patch_header_if(
        &self,
        thread: &ThreadId,
        _: serde_json::Map<String, Value>,
        set: serde_json::Map<String, Value>,
        _: Vec<String>,
    ) -> Result<Option<serde_json::Map<String, Value>>, mixdog_tools::orch::util::PortError> {
        self.stamps.lock().unwrap().push((thread.as_str().to_owned(), set.contains_key("ownerClosedAt")));
        self.headers.lock().unwrap().entry(thread.as_str().to_owned()).or_default().extend(set);
        Ok(None)
    }
    async fn store_header(&self, thread: &ThreadId, write: mixdog_core_ports::ports::threads::HeaderWrite) -> mixdog_core_ports::ports::threads::HeaderStored {
        mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
    }
    fn log_identity(&self, _: &ThreadId) -> Option<String> {
        None
    }
    /// This fake holds nothing but the header it answers.
    async fn held_fields(
        &self,
        thread: &ThreadId,
        keys: &'static [&'static str],
    ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
        Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
    }
    async fn publish(&self, _: &ThreadId, _: mixdog_core_ports::ports::threads::Section) -> Result<(), mixdog_tools::orch::util::PortError> {
        Ok(())
    }
}

/// The owner's queue as the actor keeps it, for the restart notices: an id already queued is one entry, the owner takes entries,
/// and the write is acknowledged when the test lets it (`gate`), or fails once with its entry rolled back.
struct OwnerQueue {
    queue: Mutex<Vec<String>>,
    taken: Mutex<Vec<String>>,
    queued: std::sync::atomic::AtomicUsize,
    gate: tokio::sync::Semaphore,
    fail_next: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl restart::RestartNotices for OwnerQueue {
    async fn queue_durably(&self, _: &ThreadId, execution: &str, _: String) -> Result<(), String> {
        self.queued.fetch_add(1, Ordering::SeqCst);
        {
            let mut queue = self.queue.lock().unwrap();
            if !queue.iter().any(|queued| queued == execution) {
                queue.push(execution.to_owned());
            }
        }
        self.gate.acquire().await.expect("the gate stays open").forget();
        if self.fail_next.swap(false, Ordering::SeqCst) {
            self.queue.lock().unwrap().retain(|queued| queued != execution);
            return Err("the write failed".into());
        }
        Ok(())
    }

    async fn show(&self, _: &ThreadId, _: &str, _: String) {}
}

impl OwnerQueue {
    fn new() -> Self {
        Self {
            queue: Mutex::default(),
            taken: Mutex::default(),
            queued: std::sync::atomic::AtomicUsize::new(0),
            gate: tokio::sync::Semaphore::new(0),
            fail_next: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The owner's turn takes what is queued for it.
    fn take(&self) {
        let mut queue = self.queue.lock().unwrap();
        self.taken.lock().unwrap().extend(queue.drain(..));
    }
}

/// The Lead pool row of `pool_index`'s Lead half, if any.
async fn lead_row_of(registry: &AgentRegistry, id: &str) -> Option<Value> {
    let (_, leads) = registry.pool_index().await.unwrap();
    leads["workers"].as_array().unwrap().iter().find(|row| row["sessionId"] == id).cloned()
}

/// `upsertLeadSession` (`turn-prepare.mjs:174`, `turn-settle.mjs:105`): a Lead with no pool row gets one at its next turn,
/// running while the turn runs and idle once it settled, so the pool keeps the Lead's agents listed under it; an agent's
/// own turn writes no Lead row.
#[tokio::test]
async fn a_leads_turn_writes_its_pool_row_running_then_idle() {
    use crate::session::TurnStarts;
    use mixdog_core_api::ids::ThreadId;
    let rig = Rig::new();
    rig.live.headers.lock().unwrap().insert(
        "lead-a".into(),
        obj(json!({ "id": "lead-a", "owner": "user", "agent": "lead", "sourceType": "lead", "provider": "p", "model": "m", "cwd": "/w", "createdAt": at(NOW - DAY), "clientHostPid": PID })),
    );
    rig.live.headers.lock().unwrap().insert("s-w".into(), session("s-w", "w", &at(NOW - HOUR), json!({ "owner": "agent" })));
    rig.store.write("s-w", Some(worker_row("s-w", "w", json!({ "status": "idle", "finishedAt": at(NOW - HOUR) }))));
    let registry = rig.registry();
    assert_eq!(lead_row_of(&registry, "lead-a").await, None, "a Lead from before the port has no row");

    registry.turn_started(&ThreadId::from("lead-a"), &"turn".into());
    registry.turn_started(&ThreadId::from("s-w"), &"turn".into());
    let running = lead_row_of(&registry, "lead-a").await.expect("the turn wrote the Lead's row");
    for (key, value) in [
        ("tag", json!("lead:lead-a")),
        ("ownerSessionId", json!("lead-a")),
        ("agent", json!("lead")),
        ("status", json!("running")),
        ("stage", json!("running")),
        ("turnStartedAt", json!(at(NOW))),
        ("updatedAt", json!(at(NOW))),
        ("finishedAt", Value::Null),
        ("cwd", json!("/w")),
        ("provider", json!("p")),
        ("createdAt", json!(at(NOW - DAY))),
    ] {
        assert_eq!(running[key], value, "{key}");
    }
    assert_eq!(lead_row_of(&registry, "s-w").await, None, "an agent's turn writes no Lead row");
    assert_eq!(rig.store.map("s-w").unwrap()["agent"], json!("worker"), "and leaves its worker row as it was");

    rig.clock.0.store(NOW + 60_000, Ordering::SeqCst);
    registry.turn_settled(&ThreadId::from("lead-a"));
    let idle = lead_row_of(&registry, "lead-a").await.expect("the settled turn keeps the row");
    for (key, value) in [
        ("status", json!("idle")),
        ("stage", json!("idle")),
        ("turnStartedAt", Value::Null),
        ("finishedAt", json!(at(NOW + 60_000))),
        ("updatedAt", json!(at(NOW + 60_000))),
        ("reapAt", json!(at(NOW + 60_000 + HOUR))),
    ] {
        assert_eq!(idle[key], value, "{key}");
    }
    assert_eq!(rig.registry().pool_index().await.unwrap().1, registry.pool_index().await.unwrap().1, "the row is stored: the next process lists it");
}

/// A Lead row write tells the pool alone (1.4.5 kept Lead rows in their own index, which no agent status read listened to):
/// a Lead's turns raise no worker-row signal, whose listener makes every loaded thread re-read its agents.
#[tokio::test]
async fn a_leads_turns_raise_no_worker_row_signal() {
    use crate::session::TurnStarts;
    use mixdog_core_api::ids::ThreadId;
    let rig = Rig::new();
    let told = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = told.clone();
    rig.store
        .on_write
        .set(Box::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }))
        .ok();
    rig.live.headers.lock().unwrap().insert("lead-a".into(), obj(json!({ "id": "lead-a", "owner": "user", "agent": "lead" })));
    let registry = rig.registry();
    for _ in 0..2 {
        registry.turn_started(&ThreadId::from("lead-a"), &"turn".into());
        registry.turn_settled(&ThreadId::from("lead-a"));
    }
    assert_eq!(rig.store.lead_writes.load(Ordering::SeqCst), 4, "each start and settle wrote the Lead row");
    assert_eq!(told.load(Ordering::SeqCst), 0, "and told no agent status reader");
    assert!(registry.forget_deleted_session("lead-a").await);
    assert_eq!((rig.store.lead_writes.load(Ordering::SeqCst), told.load(Ordering::SeqCst)), (5, 0), "nor did its removal");
}

/// `reap-timers.mjs`: a settled Lead row leaves at its reap deadline, never before the pane's hour from its finish; a row its
/// runtime left running (no finish stamp) is settled from its last update.
#[tokio::test]
async fn a_settled_lead_row_leaves_at_its_deadline() {
    use crate::session::TurnStarts;
    use mixdog_core_api::ids::ThreadId;
    let rig = Rig::new();
    rig.live.headers.lock().unwrap().insert("lead-a".into(), obj(json!({ "id": "lead-a", "owner": "user", "agent": "lead" })));
    // A row a crashed process left running two hours ago.
    rig.store.write(
        "lead-b",
        Some(obj(json!({ "tag": "lead:lead-b", "sessionId": "lead-b", "ownerSessionId": "lead-b", "agent": "lead", "status": "running", "stage": "running", "updatedAt": at(NOW - 2 * HOUR) }))),
    );
    let registry = rig.registry();
    registry.reload().await.unwrap();
    registry.turn_started(&ThreadId::from("lead-a"), &"turn".into());
    registry.turn_settled(&ThreadId::from("lead-a"));
    assert_eq!(registry.next_lead_reap_deadline(), NOW as f64 - HOUR as f64, "the crashed row is due an hour after its last update");
    registry.reap_lead_rows();
    assert!(rig.store.map("lead-b").is_none(), "the crashed row left");
    assert_eq!(registry.next_lead_reap_deadline(), (NOW + HOUR) as f64, "the settled row is due an hour after its finish");
    rig.clock.0.store(NOW + HOUR - 1, Ordering::SeqCst);
    registry.reap_lead_rows();
    assert!(rig.store.leads.lock().unwrap().contains_key("lead-a"), "not before its deadline");
    rig.clock.0.store(NOW + HOUR, Ordering::SeqCst);
    registry.reap_lead_rows();
    assert!(!rig.store.leads.lock().unwrap().contains_key("lead-a"), "gone at its deadline");
    assert_eq!(lead_row_of(&registry, "lead-a").await, None);
    assert_eq!(registry.next_lead_reap_deadline(), f64::INFINITY);
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
    let running = |id: &str, tag: &str, due_in: i64| {
        worker_row(id, tag, json!({ "status": "running", "stage": "streaming", "createdAt": stamped(due_in), "updatedAt": stamped(due_in) }))
    };
    rig.store.write("s-overdue", Some(running("s-overdue", "overdue", -60_000)));
    rig.store.write("s-late", Some(running("s-late", "late", 60_000)));
    rig.store.write("s-early", Some(running("s-early", "early", 10_000)));
    rig.store.write("s-active", Some(running("s-active", "active", 20_000)));
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), rig.live.clone(), Arc::new(Hour), clock.clone()));
    let reaped = |id: &str| rig.store.map(id).is_some_and(|map| map.contains_key("tombstone"));
    // The index is loaded (the boot's first read), then the timer starts.
    registry.refresh_tags_from_sessions(false, &lead("lead-b")).await.unwrap();
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
/// `sweepRestartFailures`, the first step of the maintenance pass: a row written (an agent event) asks for a pass, whose sweep runs
/// one event delay later and not before; with no event it does not run.
#[tokio::test]
async fn a_row_write_runs_the_restart_sweep_one_event_delay_later() {
    let rig = Rig::new();
    let clock = Arc::new(Virtual(tokio::sync::watch::channel(NOW).0));
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), rig.live.clone(), Arc::new(Hour), clock.clone()));
    let sweeps = Arc::new(CountedSweeps::default());
    assert!(registry.bind_sweeper(sweeps.clone()).is_ok());
    assert!(registry.bind_sweeper(sweeps.clone()).is_err(), "a second bind is refused");
    let timer = tokio::spawn(AgentRegistry::keep_deadlines(Arc::downgrade(&registry)));
    let swept = || sweeps.0.load(Ordering::SeqCst);
    clock.advance(1_000);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(swept(), 0, "no event, no sweep");
    // A write is an event only for a timer already waiting, so it is repeated until the sweep has run.
    let wait = async {
        while swept() == 0 {
            {
                let mut st = registry.lock();
                let row = worker_row("s-new", "new", json!({ "status": "running", "stage": "streaming", "createdAt": at(NOW), "updatedAt": at(NOW) }));
                registry.persist(&mut st, "s-new", Some(row));
            }
            clock.advance(1_000);
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), wait).await.expect("the event's pass swept");
    timer.abort();
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
    registry.pool_index().await.unwrap();
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
        let (agents, _) = registry.pool_index().await.unwrap();
        agents["workers"].as_array().unwrap().iter().any(|row| row["sessionId"] == "s-owed")
    }
    let other = lead("lead-b");
    rig.clock.0.store(NOW + DAY - 1, Ordering::SeqCst);
    restarted.refresh_tags_from_sessions(false, &other).await.unwrap();
    assert!(listed(&restarted).await, "1 ms before the settled retention ends the row stays");
    rig.clock.0.store(NOW + DAY, Ordering::SeqCst);
    restarted.refresh_tags_from_sessions(false, &other).await.unwrap();
    assert!(!listed(&restarted).await, "at the retention's end the told row leaves");
    let map = rig.store.map("s-owed").expect("its tombstone stays until its own end");
    assert!(!map.contains_key("sessionId") && map.contains_key("tombstone"), "{map:?}");
    // And a restart after that lists it no more.
    assert!(!listed(&rig.registry()).await);
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
fn lost_task_world() -> (Rig, AgentRegistry, mixdog_agent::agent_tool::board::JobBoard) {
    struct Frozen;
    impl mixdog_agent::env::Clock for Frozen {
        fn now_ms(&self) -> i64 {
            NOW
        }
    }
    let rig = Rig::new();
    let owed = json!({ "status": "failed", "failureReason": "process-restart", "task_id": "t-1", "finishedAt": at(NOW), "updatedAt": at(NOW) });
    rig.store.write("s-owed", Some(worker_row("s-owed", "owed", owed)));
    let registry = rig.registry();
    (rig, registry, mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(Frozen), None, None))
}
#[tokio::test]
async fn restart_ownership_keeps_all_failures_visible_independently_of_notice_delivery() {
    let (rig, registry, board) = lost_task_world();
    for n in 0..8 {
        let id = format!("s-{n}");
        rig.store.write(
            &id,
            Some(worker_row(
                &id,
                &id,
                json!({
                    "status": "running", "stage": "tool_running", "runtimePid": PID + 1,
                    "task_id": format!("t-{n}"), "updatedAt": at(NOW),
                }),
            )),
        );
        rig.store.sessions.lock().unwrap().push(session(&id, &id, &at(NOW), json!({ "updatedAt": at(NOW) })));
    }
    rig.store.write("s-owed", None);
    let live = restart::Liveness { probe: &Dead, own_pid: PID, running: &|_| false, reap: &Hour, now_ms: NOW };
    assert!(registry.recover_stale_worker_rows(true, &live).await.unwrap());

    let owner = OwnerQueue::new();
    owner.gate.add_permits(8);
    owner.fail_next.store(true, Ordering::SeqCst);
    assert_eq!(restart::notify_restart_failures(&registry, &owner, &board, &at(NOW)).await.unwrap(), 7);
    assert_eq!(board.list_jobs(&Scope::default()).len(), 8, "even the unqueued failure is a failed task");
    assert!(board.list_jobs(&Scope::default()).iter().all(|job| job.status == "failed"));
    assert_eq!(registry.pending_restart_failures().await.unwrap().len(), 1);
    owner.gate.add_permits(1);
    assert_eq!(restart::notify_restart_failures(&registry, &owner, &board, &at(NOW)).await.unwrap(), 1);
    owner.take();
    assert_eq!(owner.taken.lock().unwrap().len(), 8);

    // A fresh registry and board represent another core restart. Scanning idle headers
    // must not replace the task outcomes, and stamped notices must not erase status.
    let restarted = rig.registry();
    restarted.refresh_tags_from_sessions(true, &lead("lead-a")).await.unwrap();
    let listed = restarted.session_entries(true, &lead("lead-a")).await;
    assert_eq!(listed.len(), 8);
    assert!(listed.iter().all(|(_, row)| row["status"] == "failed"));
    let (_, _, fresh_board) = lost_task_world();
    assert_eq!(restart::notify_restart_failures(&restarted, &owner, &fresh_board, &at(NOW)).await.unwrap(), 0);
    assert_eq!(fresh_board.list_jobs(&Scope::default()).len(), 8);
    assert!(fresh_board.list_jobs(&Scope::default()).iter().all(|job| job.status == "failed"));
    for n in 0..8 {
        assert_eq!(rig.store.map(&format!("s-{n}")).unwrap()["status"], "failed");
    }
    restarted.upsert_worker_row(
        &session("s-0", "s-0", &at(NOW), json!({})),
        "s-0",
        &obj(json!({ "status": "running", "stage": "running", "task_id": "new-task" })),
    );
    assert_eq!(rig.store.map("s-0").unwrap()["status"], "running", "a genuine new task can still start");
}
/// An owner is told a restart notice once when its write is slow: the owner takes the entry before the write is acknowledged, and
/// a second pass (a compaction's `recoverAgentWorkers` starts one) finds the row still owed. The owner's queue knows an id only
/// while it holds the entry, so queued again the notice would be delivered again (Node told 19 owners every five seconds).
#[tokio::test]
async fn a_slow_write_does_not_tell_the_owner_again_when_it_took_the_entry() {
    let (_rig, registry, board) = lost_task_world();
    let owner = OwnerQueue::new();
    let stamp = at(NOW);
    let mut first = std::pin::pin!(restart::notify_restart_failures(&registry, &owner, &board, &stamp));
    assert!(futures::poll!(first.as_mut()).is_pending(), "the first pass waits for its write to be acknowledged");
    assert_eq!(owner.queued.load(Ordering::SeqCst), 1);
    owner.take();
    let mut second = std::pin::pin!(restart::notify_restart_failures(&registry, &owner, &board, &stamp));
    assert_eq!(futures::poll!(second.as_mut()), std::task::Poll::Ready(Ok(0)), "the notice is the first pass's");
    owner.gate.add_permits(1);
    assert_eq!(first.await, Ok(1));
    assert_eq!(*owner.taken.lock().unwrap(), ["restart:t-1"]);
    assert!(owner.queue.lock().unwrap().is_empty(), "no second entry for the owner to take");
    assert_eq!(owner.queued.load(Ordering::SeqCst), 1);
}
/// A write that fails once leaves the row owed and nothing queued: the next pass queues the notice again, and the owner is told once.
#[tokio::test]
async fn a_failed_write_is_queued_again_and_told_once() {
    let (_rig, registry, board) = lost_task_world();
    let owner = OwnerQueue::new();
    owner.gate.add_permits(2);
    owner.fail_next.store(true, Ordering::SeqCst);
    assert_eq!(restart::notify_restart_failures(&registry, &owner, &board, &at(NOW)).await, Ok(0), "the write failed");
    assert_eq!(registry.pending_restart_failures().await.unwrap().len(), 1, "the row is still owed");
    assert!(owner.queue.lock().unwrap().is_empty(), "the failed write left no entry");
    assert_eq!(restart::notify_restart_failures(&registry, &owner, &board, &at(NOW)).await, Ok(1));
    assert_eq!(restart::notify_restart_failures(&registry, &owner, &board, &at(NOW)).await, Ok(0), "told");
    owner.take();
    assert_eq!(*owner.taken.lock().unwrap(), ["restart:t-1"]);
    assert_eq!(owner.queued.load(Ordering::SeqCst), 2);
}

struct TurnWorld {
    _srig: crate::session::testing::Rig,
    directory: Arc<crate::session::SessionDirectory>,
    rig: Rig,
    registry: Arc<AgentRegistry>,
    handle: Arc<crate::session::SessionHandle>,
    id: String,
}

async fn turn_world(script: crate::session::testing::Script) -> TurnWorld {
    let srig = crate::session::testing::Rig::new();
    srig.set_script(script);
    let directory = Arc::new(crate::session::SessionDirectory::new(srig.deps()));
    let rig = Rig::new();
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    assert!(srig.turn_starts.bind(registry.clone()).is_ok());
    let handle = crate::session::tests::start_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    TurnWorld { _srig: srig, directory, rig, registry, handle, id }
}

fn sessions_over(world: &TurnWorld, statusline: Arc<Statusline>, shells: Arc<ClosedShells>) -> AgentSessions {
    AgentSessions::new(
        world.directory.clone(),
        Arc::new(crate::session::thread_state::SessionThreads::new(world.directory.clone())),
        world.registry.clone(),
        statusline,
        world.rig.clock.clone(),
        shells,
        Arc::new(mixdog_tools::fs::ReadState::default()),
    )
}

/// `ask-turn-settle.mjs:137-139` stamps every completed turn; a turn start lifts the owner's release (`worker-index.mjs:59`).
#[tokio::test(start_paused = true)]
async fn a_completed_turn_stamps_the_session_and_a_turn_start_lifts_the_release() {
    use std::sync::atomic::AtomicUsize;

    use crate::eventually_on;
    use crate::session::seams::RunOutcome;
    use crate::session::tests::turn;

    let runs = Arc::new(AtomicUsize::new(0));
    let counter = runs.clone();
    let world = turn_world(Arc::new(move |run| {
        let first = counter.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if !first {
                run.cancel.cancelled().await;
                return RunOutcome::Interrupted;
            }
            RunOutcome::Completed(Default::default())
        })
    }))
    .await;
    let TurnWorld { handle, id, registry, rig, .. } = &world;

    turn(handle, "one", "op-1").await;
    let stamped = eventually_on!(&[&handle.cell.stepped], || {
        let header = handle.cell.header.load_full();
        header.contains_key("lastTurnCompletedAt").then(|| (*header).clone())
    })
    .await;
    assert_eq!(stamped["closeProvenance"], json!(1));
    assert!(stamped["lastTurnCompletedAt"].is_number());

    registry.mark_released(std::slice::from_ref(id));
    assert!(rig.store.map(id).is_some_and(|m| m.contains_key("releasedAt")));
    turn(handle, "two", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    assert!(rig.store.map(id).is_none(), "the turn start lifted the release");
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

/// An owner close (`bumpSessionGenerationAttempt` with `ownerClose`) stamps the session durably, then cancels its running turn,
/// leaving it open.
#[tokio::test(start_paused = true)]
async fn an_owner_close_stamps_the_session_and_cancels_its_running_turn() {
    use mixdog_agent::agent_tool::host::Sessions;

    use crate::eventually_on;
    use crate::session::seams::RunOutcome;
    use crate::session::tests::idle;
    use crate::session::tests::turn;

    let world = turn_world(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }))
    .await;
    let TurnWorld { handle, id, .. } = &world;
    turn(handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;

    let statusline = Arc::new(Statusline::default());
    let shells = Arc::new(ClosedShells::default());
    let sessions = sessions_over(&world, statusline.clone(), shells.clone());
    let options = mixdog_agent::agent_tool::host::CloseOptions { tombstone: false, owner_close: true };
    assert!(sessions.close_session(id, "cli-agent-close", options).await);
    assert_eq!(
        world._srig.side.forgets.lock().unwrap().last(),
        Some(&(id.clone(), crate::session::turn_ops::SideEnd::Detach)),
        "the agent close is a detach: the warm chain ends, its touch stays"
    );
    // `cancelOwnedShellTrees(id)` (`session-close.mjs:184`).
    assert_eq!(*shells.0.lock().unwrap(), [id.clone()]);
    eventually_on!(&[&handle.cell.stepped], || idle(handle).then_some(())).await;
    let header = handle.cell.header.load_full();
    assert_eq!(header["ownerClosedAt"], json!(NOW));
    assert_eq!(header["detachedReason"], json!("cli-agent-close"));
    assert!(header["generation"].as_f64().is_some_and(|generation| generation >= 1.0), "the close moves the generation on (`lifecycle-barriers.mjs:272`)");
    assert_ne!(header.get("closed"), Some(&json!(true)), "the session stays open");
    sessions.clear_statusline_route(id);
    assert_eq!(*statusline.0.lock().unwrap(), [id.clone()]);
}

/// The job board's cancel (`close_session(id, "agent-task-cancel", {tombstone: false,
/// owner_close: false})`) ends the worker's turn with Node's `closeSession` abort text, and the
/// session stays open without an owner-close stamp.
#[tokio::test(start_paused = true)]
async fn a_job_cancel_aborts_the_turn_with_the_close_session_text() {
    use mixdog_agent::agent_tool::host::Sessions;

    use crate::eventually_on;
    use crate::session::seams::RunOutcome;
    use crate::session::tests::idle;
    use crate::session::tests::turn;

    let aborted: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
    let seen = aborted.clone();
    let world = turn_world(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.cancel.cancelled().await;
            *seen.lock().unwrap() = Some(run.signal.reason());
            RunOutcome::Interrupted
        })
    }))
    .await;
    let TurnWorld { handle, id, .. } = &world;
    turn(handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;

    let sessions = sessions_over(&world, Arc::new(Statusline::default()), Arc::new(ClosedShells::default()));
    let options = mixdog_agent::agent_tool::host::CloseOptions { tombstone: false, owner_close: false };
    assert!(sessions.close_session(id, "agent-task-cancel", options).await);
    eventually_on!(&[&handle.cell.stepped], || idle(handle).then_some(())).await;
    assert_eq!(aborted.lock().unwrap().as_deref(), Some(format!("Session \"{id}\" closed: closeSession (reason=agent-task-cancel)").as_str()));
    let header = handle.cell.header.load_full();
    assert_eq!(header["detachedReason"], json!("agent-task-cancel"));
    assert!(header["generation"].as_f64().is_some_and(|generation| generation >= 1.0));
    assert!(header.get("ownerClosedAt").is_none(), "not an owner close");
}

/// `abortSessionTurn(id, reason)` for a session no outer turn holds.
#[tokio::test(start_paused = true)]
async fn an_abort_of_a_running_turn_ends_it_with_the_abort_text() {
    use crate::eventually_on;
    use crate::session::seams::RunOutcome;
    use crate::session::tests::idle;
    use crate::session::tests::turn;

    let aborted: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
    let seen = aborted.clone();
    let world = turn_world(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.cancel.cancelled().await;
            *seen.lock().unwrap() = Some(run.signal.reason());
            RunOutcome::Interrupted
        })
    }))
    .await;
    let TurnWorld { handle, id, directory, .. } = &world;
    turn(handle, "again", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    assert!(directory.abort_session_turn(&handle.id, "login-required"));
    eventually_on!(&[&handle.cell.stepped], || idle(handle).then_some(())).await;
    assert_eq!(aborted.lock().unwrap().as_deref(), Some(format!("Session \"{id}\" closed: abortSessionTurn (reason=login-required)").as_str()));
    assert!(!directory.abort_session_turn(&mixdog_core_api::ids::ThreadId::from("sess_none"), "x"));
}
/// A turn is told started (its worker row counts it) only once it reads as running: a listing that finds the row's new
/// count finds the turn running, and fixes no settle identity for an outcome the turn has yet to produce.
#[tokio::test(start_paused = true)]
async fn a_turn_is_counted_on_its_row_once_it_reads_as_running() {
    use crate::eventually_on;
    use crate::session::SessionDirectory;
    use crate::session::TurnStarts;
    use crate::session::seams::RunOutcome;
    use crate::session::tests::idle;
    use crate::session::tests::start_thread;
    use crate::session::tests::turn;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_api::ids::TurnId;

    #[derive(Default)]
    struct Seen {
        directory: std::sync::OnceLock<std::sync::Weak<SessionDirectory>>,
        running: Mutex<Vec<bool>>,
    }
    impl TurnStarts for Seen {
        fn turn_started(&self, thread: &ThreadId, _: &TurnId) {
            let directory = self.directory.get().and_then(std::sync::Weak::upgrade).expect("the directory");
            self.running.lock().unwrap().push(LiveSessions::running(&*directory, thread.as_str()));
        }
    }

    let srig = crate::session::testing::Rig::new();
    srig.set_script(Arc::new(|_| Box::pin(async { RunOutcome::Completed(Default::default()) })));
    let seen = Arc::new(Seen::default());
    assert!(srig.turn_starts.bind(seen.clone()).is_ok());
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    assert!(seen.directory.set(Arc::downgrade(&directory)).is_ok());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(*seen.running.lock().unwrap(), [true], "the turn was counted before it read as running");
}

/// `closeRuntime` (`agent-cancel.mjs:96-102`): a close that stopped a running turn leaves the session reading `cancelled`,
/// its stage too, so a scan of the sessions builds no open idle row for it that a cleanup would close again; a turn that
/// starts on it reads it as its runtime again (`agent-turns.mjs`), and closing a finished agent keeps its status.
#[tokio::test(start_paused = true)]
async fn a_close_that_stops_a_running_turn_reads_cancelled_until_a_turn_starts() {
    use std::sync::atomic::AtomicUsize;

    use mixdog_agent::agent_tool::host::Sessions;

    use crate::eventually_on;
    use crate::session::SessionDirectory;
    use crate::session::seams::RunOutcome;
    use crate::session::tests::idle;
    use crate::session::tests::start_thread;
    use crate::session::tests::turn;
    use crate::session::thread_state::SessionThreads;

    let srig = crate::session::testing::Rig::new();
    let runs = Arc::new(AtomicUsize::new(0));
    let counter = runs.clone();
    // The first turn runs until it is stopped; every later one completes.
    srig.set_script(Arc::new(move |run| {
        let first = counter.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if first {
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
    let sessions = AgentSessions::new(
        directory.clone(),
        Arc::new(SessionThreads::new(directory.clone())),
        registry.clone(),
        Arc::new(Statusline::default()),
        rig.clock.clone(),
        Arc::new(ClosedShells::default()),
        Arc::new(mixdog_tools::fs::ReadState::default()),
    );
    // The job board's cancel: the same close, after which the session takes a turn again.
    let options = mixdog_agent::agent_tool::host::CloseOptions { tombstone: false, owner_close: false };
    let state = |session: &Row| (session.get("status").cloned(), session.get("stage").cloned());
    let cancelled = (Some(json!("cancelled")), Some(json!("cancelled")));

    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    assert!(sessions.close_session(&id, "agent-task-cancel", options).await);
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(state(&registry.session_of(&id).await.expect("the session")), cancelled);
    let listed = registry.open_sessions().await;
    let scanned = listed.iter().find(|session| session.get("id").and_then(Value::as_str) == Some(id.as_str())).expect("listed");
    assert_eq!(state(scanned), cancelled, "the scan reads it so");

    turn(&handle, "again", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (runs.load(Ordering::SeqCst) == 2 && idle(&handle)).then_some(())).await;
    assert_ne!(state(&registry.session_of(&id).await.expect("the session")), cancelled, "a turn started on it");
    assert!(sessions.close_session(&id, "agent-task-cancel", options).await);
    assert_ne!(state(&registry.session_of(&id).await.expect("the session")), cancelled, "it was not running");
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
        Self::up_over(data, |store| store).await
    }

    /// [`Self::up`] with the sessions reading and writing through what `over` makes of the thread store.
    async fn up_over(data: &std::path::Path, over: impl FnOnce(Arc<dyn crate::session::ThreadStore>) -> Arc<dyn crate::session::ThreadStore>) -> Self {
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
        let directory = Arc::new(crate::session::SessionDirectory::new(Arc::new(rig.deps_parts(over(store.clone())))));
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
        mixdog_core_ports::ports::threads::ThreadState::patch_header(&*self.threads, &ThreadId::from(thread), fields, Vec::new())
            .await
            .expect("the header patch");
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
/// A finished agent's status is asked for on every status pass, long after its runtime is gone: the facts come from its stored
/// record, the same each time, and are read again once the session's log has changed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_finished_agents_status_read_gives_the_same_facts_until_its_log_changes() {
    use mixdog_agent::agent_tool::views::Workers;

    struct NoJobs;
    impl mixdog_core_run::run_host::progress::WaitedJobs for NoJobs {
        fn silence(&self, _: &[String], _: i64) -> Option<mixdog_agent::agent_tool::progress::ToolSilence> {
            None
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    let registry = Arc::new(AgentRegistry::new(core.workers.clone(), core.directory.clone(), Arc::new(Hour), Arc::new(TestClock(AtomicI64::new(NOW)))));
    let workers =
        super::workers::AgentWorkers::new(core.directory.clone(), core.threads.clone(), registry, Arc::new(NoJobs), Arc::new(TestClock(AtomicI64::new(NOW))));
    let finished = |status: &str| obj(json!({ "agent": "worker", "model": "m-1", "status": status, "stage": status, "agentTag": "w1" }));
    let status_of = || async { workers.session_status(worker.as_str()).await.expect("the stored session answers") };

    core.set_header(worker.as_str(), finished("completed")).await;
    core.written().await;
    core.directory.release(&worker).await;
    assert!(core.directory.handle(&worker).is_none(), "the finished agent's runtime is gone");

    let first = status_of().await;
    assert_eq!((first.status.as_deref(), first.model.as_deref(), first.agent.as_deref()), (Some("completed"), Some("m-1"), Some("worker")));
    assert_eq!(status_of().await, first, "asked again with nothing changed, the facts are the same");

    core.set_header(worker.as_str(), finished("failed")).await;
    core.written().await;
    core.directory.release(&worker).await;
    assert!(core.directory.handle(&worker).is_none());
    let changed = status_of().await;
    assert_eq!((changed.status.as_deref(), changed.model.as_deref()), (Some("failed"), Some("m-1")), "the log changed, so the record is read again");
}
/// A kept write the table refused is answered failed and is not made again by the writer, on a timer or by a flush: the
/// flush that covers it is refused, and the session's next write, once the table takes writes again, stores what the
/// session is owed and leaves no failure behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kept_row_the_table_refused_is_failed_until_the_sessions_next_write_is_stored() {
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
    let flushed = core.workers.settled().await;
    assert!(flushed.as_ref().is_err_and(|error| error.contains("s-owed")), "the flush covers the refused write: {flushed:?}");
    unlock.send(()).unwrap();
    holder.await.unwrap().unwrap();
    let stored = || async { core.state.meta_prefix("agent-kept-worker:").await.unwrap() };
    assert!(core.workers.settled().await.is_err(), "the refused write is not made again by a flush");
    assert!(stored().await.is_empty(), "the table still lacks the row");
    WorkerStore::keep(&*core.workers, "s-owed", Some(row.clone()));
    core.workers.settled().await.expect("the session's next write stored what it is owed");
    assert_eq!(stored().await, [("agent-kept-worker:s-owed".to_owned(), serde_json::to_string(&row).unwrap())]);
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
/// Releasing a tag whose session was deleted: Node's `closeSession` counts a record that is
/// already gone as closed (`session-close.mjs` `finishClose`, `outcome.absent`), so the close
/// flow goes on to forget the row and the tag can start a fresh session.
#[tokio::test]
async fn closing_a_deleted_session_counts_as_closed() {
    use mixdog_agent::agent_tool::host::Sessions;

    use crate::session::SessionDirectory;
    use crate::session::thread_state::SessionThreads;

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

    use crate::session::SessionDirectory;
    use crate::session::thread_state::SessionThreads;

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
async fn put_stored(core: &Core, id: &str, header: Row) {
    core.index.upsert(stored_head(id, header), mixdog_store::sqlite::DirtyMark::Clear).await.expect("the index takes the row");
}
async fn crowd_rig() -> Crowd {
    // What is counted is the work of a signal, read back from the running OS: no flush to the device changes a count, and the
    // 800 index rows of the data set and the 1,000 single-row writes each waited for one (over 120 s on the Windows runner, where
    // the same test took 31 s on Linux; release gate run 44959677392).
    mixdog_store::fsio::elide_syncs();
    let began = std::time::Instant::now();
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
    eprintln!("[crowd] the data set was written in {:?}", began.elapsed());
    Crowd { core, _dir: dir, scopes, running }
}
/// A status signal as the product runs it (`AgentActivity::everyone`): every loaded thread re-reads its status at once
/// (`AgentToolStatus::status`): `refresh_tags_from_sessions`, which reloads the index, then the scope's agents. The tags
/// each lists.
async fn signal(crowd: &Crowd) -> Vec<Vec<String>> {
    let registry = &crowd.core.registry;
    futures::future::join_all(crowd.scopes.iter().map(|scope| async move {
        registry.refresh_tags_from_sessions(false, scope).await.unwrap();
        registry.status_entries(scope).iter().map(|(tag, _)| tag.clone()).collect::<Vec<_>>()
    }))
    .await
}
/// The work of a status signal is what changed, not the size of the index: 1,000 signals over an unchanged index stay within
/// what the loaded threads cost, while every re-read answers what it answered before.
// The body runs on the test's own thread (the counts are per thread); the session tasks run on the runtime's workers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_status_signal_over_an_unchanged_index_costs_what_the_loaded_threads_cost() {
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
    crowd.core.directory.shutdown().await;
}
/// 1,000 single-row writes (one worker's stage change, each followed by its signal) stay within what the loaded threads
/// cost plus the write's own work, and the stage written is the stage read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_status_signal_after_a_single_row_write_costs_what_the_write_changed() {
    let crowd = crowd_rig().await;
    signal(&crowd).await;

    let (start, loads, visits) = (rows::work::counts().total(), rows::work::counts().reloads, rows::work::counts().rows_visited);
    let before = rows::work::counts();
    let began = std::time::Instant::now();
    for n in 1..=1000 {
        // Of a run that is ended for its time, how far it had come and how fast.
        if n % 100 == 0 {
            eprintln!("[crowd] write {n} of 1000 begins {:?} after the first", began.elapsed());
        }
        let (session, tag) = &crowd.running[n % crowd.running.len()];
        let stage = if n % 2 == 0 { "streaming" } else { "tool_running" };
        crowd.core.registry.upsert_worker_row(session, tag, &obj(json!({ "status": "running", "stage": stage })));
        // The write reaches the index before the signal's loads read it, so each load reads the row written.
        crowd.core.written().await;
        let read = signal(&crowd).await;
        assert_eq!(read[0].len(), 30);
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
    core.registry.reload().await.unwrap();
    assert_eq!(status(&core), Some(json!("running")));

    core.index.set_worker_elsewhere("sess_other", Some(&row("failed")));
    let before = rows::work::counts();
    core.registry.reload().await.unwrap();
    assert_eq!(status(&core), Some(json!("failed")), "the other connection's commit is loaded");
    assert_eq!(rows::work::counts().maps_compared - before.maps_compared, 1, "the load compared the one row written");
    core.directory.shutdown().await;
}
/// Over the product's store, for a random sequence of this registry's writes, another connection's writes, new sessions
/// at every place in the index order, deletes and agent-only sessions' changes, a registry fed deltas holds, and reads, what
/// a registry that loads the whole index after every step holds and reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_registry_fed_deltas_holds_what_one_that_loads_the_whole_index_holds() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let whole_store = Arc::new(Whole::new(core.workers.clone()));
    let whole = AgentRegistry::new(whole_store.clone(), core.directory.clone(), Arc::new(Hour), Arc::new(TestClock(AtomicI64::new(NOW))));
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
            // A forget reads the index first: each reads it as both held it, the whole one first with its write held back, so
            // neither reads the other's write, which lands whenever the store gets to it.
            4 => {
                whole_store.hold_writes();
                let whole_forgot = whole.forget_deleted_session(&id).await;
                let forgot = core.registry.forget_deleted_session(&id).await;
                whole_store.release_writes();
                assert_eq!(whole_forgot, forgot, "forget, step {step}");
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
            core.registry.reload().await.unwrap();
        }
        whole.reload().await.unwrap();
        assert_eq!(held(&core.registry), held(&whole), "what the registries hold, step {step}");
        assert_eq!(index_reads(&core.registry), index_reads(&whole), "what the registries read, step {step}");
    }
    core.directory.shutdown().await;
}
/// `hideSessions` / `revealSession` (`close-flow/hide-sessions.mjs`): an owner's close takes the agent's session and those
/// below it out of the lists (the archive flag every listing reads); a session used again is listed again, alone.
#[tokio::test]
async fn an_owner_close_hides_the_agents_sessions_and_a_reuse_lists_one_again() {
    use mixdog_agent::agent_tool::dispatch::CloseParts;
    use mixdog_agent::agent_tool::host::Sessions;

    use crate::session::SessionDirectory;

    struct Frozen;
    impl mixdog_agent::env::Clock for Frozen {
        fn now_ms(&self) -> i64 {
            NOW
        }
    }
    let rig = Rig::new();
    for (id, parent) in [("sess_w1", "lead"), ("sess_w2", "sess_w1")] {
        let tag = id.trim_start_matches("sess_");
        rig.store.sessions.lock().unwrap().push(session(id, tag, &at(NOW - HOUR), json!({ "parentSessionId": parent, "ownerSessionId": "lead" })));
        rig.store.write_row(id, Some(worker_row(id, tag, json!({ "parentSessionId": parent, "ownerSessionId": "lead" }))));
    }
    rig.store.touch_sessions();
    let srig = crate::session::testing::Rig::new();
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    let threads = Arc::new(Detaches::default());
    let sessions = AgentSessions::new(
        directory,
        threads.clone(),
        registry.clone(),
        Arc::new(Statusline::default()),
        rig.clock.clone(),
        Arc::new(ClosedShells::default()),
        Arc::new(mixdog_tools::fs::ReadState::default()),
    );
    let board = mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(Frozen), None, None);
    let scope = lead("lead");
    registry.refresh_tags_from_sessions(false, &scope).await.unwrap();
    // The archive state as the authority resolves it over the headers the close left.
    let archived = |id: &str| {
        let header = threads.headers.lock().unwrap().get(id).and_then(|header| header.get("archivedAt").cloned());
        srig.archive.resolve(id, header.as_ref()).archived_at.map(|at| json!(at as i64))
    };

    let parts = CloseParts { registry: &*registry, sessions: &sessions, tasks: &board };
    let closed = mixdog_agent::agent_tool::dispatch::close_resolved(parts, "sess_w1", "w1", &scope, None, false).await.unwrap();
    assert!(closed.closed);
    assert_eq!((archived("sess_w1"), archived("sess_w2")), (Some(json!(NOW)), Some(json!(NOW))));

    sessions.reveal_session("sess_w1").await;
    assert_eq!((archived("sess_w1"), archived("sess_w2")), (None, Some(json!(NOW))));
}

/// The header seam of the cleanup tests: the stamps land in memory, in order, and the one numbered `.0` of `hold` (from 0)
/// waits there: it tells `.1` its session, then waits for `.2`.
#[derive(Default)]
struct HeldStamps {
    headers: Mutex<HashMap<String, serde_json::Map<String, Value>>>,
    stamps: Mutex<Vec<String>>,
    hold: Mutex<Option<(usize, tokio::sync::oneshot::Sender<String>, tokio::sync::oneshot::Receiver<()>)>>,
    /// The sessions whose stamp fails.
    refused: Mutex<HashSet<String>>,
    /// The stamp of session `.0` waits before it lands: it tells `.1`, then waits for `.2`.
    hold_of: Mutex<Option<(String, tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>,
}

#[async_trait]
impl ThreadState for HeldStamps {
    async fn header(&self, thread: &ThreadId) -> Result<mixdog_store::schema::record::Header, mixdog_tools::orch::util::PortError> {
        Ok(self.headers.lock().unwrap().get(thread.as_str()).cloned().unwrap_or_default())
    }
    async fn patch_header(&self, _: &ThreadId, _: serde_json::Map<String, Value>, _: Vec<String>) -> Result<(), mixdog_tools::orch::util::PortError> {
        unreachable!("a close stamps through patch_header_if; a hide is the archive authority's")
    }
    async fn patch_header_at(
        &self,
        thread: &ThreadId,
        at: &mixdog_core_ports::ports::threads::RunFence,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<mixdog_core_ports::ports::threads::FencedPatch, mixdog_tools::orch::util::PortError> {
        mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
    }
    async fn patch_header_if(
        &self,
        thread: &ThreadId,
        _: serde_json::Map<String, Value>,
        set: serde_json::Map<String, Value>,
        _: Vec<String>,
    ) -> Result<Option<serde_json::Map<String, Value>>, mixdog_tools::orch::util::PortError> {
        if self.refused.lock().unwrap().contains(thread.as_str()) {
            return Err(mixdog_tools::orch::util::PortError::Failed { capability: "store".into(), message: "the header was not written".into() });
        }
        let held = {
            let mut hold = self.hold.lock().unwrap();
            let at = self.stamps.lock().unwrap().len();
            if hold.as_ref().is_some_and(|(n, _, _)| *n == at) { hold.take() } else { None }
        };
        if let Some((_, arrived, go)) = held {
            let _ = arrived.send(thread.as_str().to_owned());
            let _ = go.await;
        }
        let held_of = {
            let mut hold = self.hold_of.lock().unwrap();
            if hold.as_ref().is_some_and(|(session, _, _)| session == thread.as_str()) { hold.take() } else { None }
        };
        if let Some((_, arrived, go)) = held_of {
            let _ = arrived.send(());
            let _ = go.await;
        }
        self.stamps.lock().unwrap().push(thread.as_str().to_owned());
        self.headers.lock().unwrap().entry(thread.as_str().to_owned()).or_default().extend(set);
        Ok(None)
    }
    async fn store_header(&self, thread: &ThreadId, write: mixdog_core_ports::ports::threads::HeaderWrite) -> mixdog_core_ports::ports::threads::HeaderStored {
        mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
    }
    fn log_identity(&self, _: &ThreadId) -> Option<String> {
        None
    }
    /// This fake holds nothing but the header it answers.
    async fn held_fields(
        &self,
        thread: &ThreadId,
        keys: &'static [&'static str],
    ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
        Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
    }
    async fn publish(&self, _: &ThreadId, _: mixdog_core_ports::ports::threads::Section) -> Result<(), mixdog_tools::orch::util::PortError> {
        Ok(())
    }
}

const CLEANUP_WORKERS: usize = 240;

struct CleanupWorld {
    rig: Rig,
    srig: crate::session::testing::Rig,
    registry: Arc<AgentRegistry>,
    threads: Arc<HeldStamps>,
    board: Arc<mixdog_agent::agent_tool::board::JobBoard>,
    shells: Arc<ClosedShells>,
    parts: mixdog_agent::agent_tool::dispatch::CleanupParts,
    /// Each idle leaf worker of the Lead `lead`, `(session, tag)`.
    workers: Vec<(String, String)>,
}

/// `CLEANUP_WORKERS` idle leaf workers whose results were delivered, and a row whose session was deleted; the stamp
/// numbered `hold_at` waits. With where the held stamp tells its session, and what lets it go.
async fn cleanup_world(hold_at: usize) -> (CleanupWorld, tokio::sync::oneshot::Receiver<String>, tokio::sync::oneshot::Sender<()>) {
    struct Frozen;
    impl mixdog_agent::env::Clock for Frozen {
        fn now_ms(&self) -> i64 {
            NOW
        }
    }
    let rig = Rig::new();
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    let mut workers = Vec::new();
    for i in 0..CLEANUP_WORKERS {
        let (id, tag) = (format!("sess_w{i:03}"), format!("w{i}"));
        rig.store.sessions.lock().unwrap().push(session(&id, &tag, &at(NOW - HOUR), owned.clone()));
        rig.store.write_row(&id, Some(worker_row(&id, &tag, owned.clone())));
        workers.push((id, tag));
    }
    rig.store.write_row("sess_deleted", Some(worker_row("sess_deleted", "gone", owned)));
    rig.store.touch_sessions();
    let srig = crate::session::testing::Rig::new();
    // A row write reaches the listener the sessions hold their signals in, as the product's does.
    let signals = srig.signals.clone();
    assert!(rig.store.holds.set(signals.clone()).is_ok());
    assert!(rig.store.on_write.set(Box::new(move |session| signals::StatusSignals::worker_rows(&*signals, session))).is_ok());
    let directory = Arc::new(crate::session::SessionDirectory::new(srig.deps()));
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    registry.refresh_tags_from_sessions(false, &lead("lead")).await.unwrap();
    let threads = Arc::new(HeldStamps::default());
    let (told, arrived) = tokio::sync::oneshot::channel();
    let (go, held) = tokio::sync::oneshot::channel();
    *threads.hold.lock().unwrap() = Some((hold_at, told, held));
    let shells = Arc::new(ClosedShells::default());
    let sessions = Arc::new(AgentSessions::new(
        directory,
        threads.clone(),
        registry.clone(),
        Arc::new(Statusline::default()),
        rig.clock.clone(),
        shells.clone(),
        Arc::new(mixdog_tools::fs::ReadState::default()),
    ));
    let board = Arc::new(mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(Frozen), None, None));
    let parts = mixdog_agent::agent_tool::dispatch::CleanupParts { registry: registry.clone(), sessions, tasks: board.clone() };
    (CleanupWorld { rig, srig, registry, threads, board, shells, parts, workers }, arrived, go)
}

impl CleanupWorld {
    fn cleanup(&self, cancel: mixdog_rt::CancellationToken) -> tokio::task::JoinHandle<Result<mixdog_agent::agent_tool::dispatch::CleanupReport, String>> {
        self.cleanup_scanning(false, cancel)
    }

    /// [`Self::cleanup`], its refresh scanning the stored sessions for workers no row names when `scan`.
    fn cleanup_scanning(
        &self,
        scan: bool,
        cancel: mixdog_rt::CancellationToken,
    ) -> tokio::task::JoinHandle<Result<mixdog_agent::agent_tool::dispatch::CleanupReport, String>> {
        let parts = self.parts.clone();
        tokio::spawn(async move {
            let scope = lead("lead");
            let listed = parts.registry.refresh_topology(scan, &scope).await.unwrap();
            mixdog_agent::agent_tool::dispatch::cleanup_idle(parts, &scope, listed, cancel).await
        })
    }

    /// Two workers the cleanup has not reached yet change: the first resumes, the second holds a result its owner has
    /// not read (its job runs). Answers them and the job.
    fn resume_two(&self, passed: &[String]) -> ((String, String), (String, String), String) {
        use mixdog_agent::agent_tool::board::{JobMeta, JobOwner, NewJob};
        let mut later = self.workers.iter().rev().filter(|(id, _)| !passed.contains(id));
        let (resumed, unread) = (later.next().unwrap().clone(), later.next().unwrap().clone());
        let running = worker_row(&resumed.0, &resumed.1, json!({ "parentSessionId": "lead", "ownerSessionId": "lead", "status": "running" }));
        {
            let mut st = self.registry.lock();
            self.registry.persist(&mut st, &resumed.0, Some(running));
        }
        let job = self
            .board
            .register(NewJob {
                owner: JobOwner { caller_session_id: Some("lead".into()), ..JobOwner::default() },
                meta: JobMeta { session_id: Some(unread.0.clone()), tag: Some(unread.1.clone()), ..JobMeta::default() },
                ..NewJob::default()
            })
            .unwrap();
        (resumed, unread, job)
    }

    /// The session was stamped, released, taken out of its row and hidden; it stays open, to be resumed.
    fn closed(&self, id: &str) -> bool {
        use mixdog_agent::agent_tool::host::Registry;
        let header = self.threads.headers.lock().unwrap().get(id).cloned().unwrap_or_default();
        let stamped = header.get("detachedReason") == Some(&json!("cli-agent-close")) && header.contains_key("ownerClosedAt");
        assert!(!header.contains_key("closed"), "{id} is detached, not tombstoned");
        let rowless = self.rig.store.map(id).is_some_and(|map| !map.contains_key("sessionId"));
        let (released, hidden) = (self.registry.is_released(id), self.srig.archive.resolve(id, None).archived());
        assert_eq!([stamped, released, rowless, hidden], [stamped; 4], "{id}: stamped, released, rowless, hidden: all or none");
        stamped
    }

    /// How many times a record or row change of a session was announced: each one told as it happened, and each end of
    /// a hold that was owed any.
    fn announcements(&self) -> usize {
        let told = self.srig.signals.0.lock().unwrap().iter().filter(|signal| signal.starts_with("rows:") || signal.starts_with("record:")).count();
        told + self.srig.signals.3.count()
    }
}

/// A cleanup of a few hundred idle workers does its work once: one listing of the agent sessions (not one walk per
/// worker), and one announcement of all the rows it changed. A worker that resumed after the plan, and one that holds a
/// result its owner has not read, are read again before their close and left alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cleanup_of_hundreds_of_idle_workers_lists_them_once_and_announces_once() {
    let (world, arrived, go) = cleanup_world(0).await;
    let (walks, announced) = (world.registry.walks.load(Ordering::SeqCst), world.announcements());
    let cleanup = world.cleanup(mixdog_rt::CancellationToken::new());
    let first = arrived.await.expect("the first close stamps");
    let (resumed, unread, job) = world.resume_two(std::slice::from_ref(&first));
    go.send(()).unwrap();
    let report = cleanup.await.unwrap().unwrap();

    assert_eq!((report.agents_closed, report.gone_rows_cleared), (CLEANUP_WORKERS as u64 - 2, 1));
    assert_eq!(report.tags_removed, CLEANUP_WORKERS as u64 - 1, "the tag of each closed worker and of the cleared row");
    assert!(!report.cancelled && report.not_closed.is_empty() && report.not_hidden.is_empty(), "{report:?}");
    assert_eq!(world.registry.walks.load(Ordering::SeqCst) - walks, 1, "one listing of the agent sessions, none per worker");
    assert_eq!(world.announcements() - announced, 1, "one announcement for the one owner whose rows changed");
    assert_eq!(world.threads.stamps.lock().unwrap().len(), CLEANUP_WORKERS - 2, "each closed worker stamped once");
    for (id, _) in &world.workers {
        let left = *id == resumed.0 || *id == unread.0;
        assert_eq!(world.closed(id), !left, "{id}");
    }
    assert_eq!(world.rig.store.map(&resumed.0).expect("its row")["status"], json!("running"));
    let unread_job = world.board.get(&job, &Scope::default()).expect("the job");
    assert_eq!(unread_job.status, "running", "the unread worker's job is not cancelled");
    assert_eq!(report.workers, 2, "the two left alone are what the scope still lists");
}

/// A worker a cleanup closed is none of the next cleanup's: a scan indexes the closed session again (a send still
/// reaches it), and that row, released with no turn since, is left as it is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cleanup_leaves_the_workers_an_earlier_one_closed_alone() {
    let (world, arrived, go) = cleanup_world(0).await;
    let first = world.cleanup(mixdog_rt::CancellationToken::new());
    arrived.await.expect("the first close stamps");
    go.send(()).unwrap();
    assert_eq!(first.await.unwrap().unwrap().agents_closed, CLEANUP_WORKERS as u64);
    let writes = |world: &CleanupWorld| world.workers.iter().map(|(id, _)| world.rig.store.map(id)).collect::<Vec<_>>();

    let scanned = world.cleanup_scanning(true, mixdog_rt::CancellationToken::new()).await.unwrap().unwrap();
    let indexed = writes(&world);
    assert!(indexed.iter().all(|map| map.as_ref().is_some_and(|map| map.contains_key("sessionId"))), "the scan indexed each closed worker again");
    assert_eq!((scanned.agents_closed, scanned.workers), (0, 0), "{scanned:?}");

    let again = world.cleanup_scanning(true, mixdog_rt::CancellationToken::new()).await.unwrap().unwrap();
    assert_eq!((again.agents_closed, again.workers), (0, 0), "{again:?}");
    assert_eq!(writes(&world), indexed, "a later cleanup writes none of them again");
    let told = world.announcements();
    world.registry.session_entries(true, &lead("lead")).await;
    assert_eq!(world.announcements(), told, "a scanning list writes none of them again");
}

/// A worker that closed while an agent below it could not be closed gives its tag back like any closed worker: the next
/// cleanup's scan indexes it again and closes what stayed open below it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cleanup_closes_the_agent_an_earlier_one_could_not_close_below_a_closed_worker() {
    let (world, arrived, go) = cleanup_world(0).await;
    let parent = world.workers[0].0.clone();
    let below = json!({ "parentSessionId": parent, "ownerSessionId": parent });
    world.rig.store.sessions.lock().unwrap().push(session("sess_kid", "kid", &at(NOW - HOUR), below.clone()));
    world.rig.store.write_row("sess_kid", Some(worker_row("sess_kid", "kid", below)));
    world.rig.store.touch_sessions();
    world.threads.refused.lock().unwrap().insert("sess_kid".to_owned());
    let first = world.cleanup(mixdog_rt::CancellationToken::new());
    arrived.await.expect("the first close stamps");
    go.send(()).unwrap();
    let report = first.await.unwrap().unwrap();
    assert_eq!(report.not_closed.len(), 1, "{report:?}");
    assert!(world.closed(&parent) && !world.closed("sess_kid"), "the worker closed, the agent below it did not");

    world.threads.refused.lock().unwrap().clear();
    let again = world.cleanup_scanning(true, mixdog_rt::CancellationToken::new()).await.unwrap().unwrap();
    assert!(again.not_closed.is_empty(), "{again:?}");
    assert!(world.closed("sess_kid"), "the next cleanup closed the agent left open");
}

/// A cleanup whose call is cancelled while a close is under way finishes that close (stamped, released, rowless,
/// hidden, still resumable), begins no other, and still announces what it changed; the workers it did not reach, a
/// resumed one and one holding an unread result among them, keep their rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_cleanup_finishes_the_close_it_began_and_begins_no_other() {
    let (world, arrived, go) = cleanup_world(9).await;
    let (announced, ended) = (world.announcements(), world.srig.signals.3.count());
    let cancel = mixdog_rt::CancellationToken::new();
    let caller = world.cleanup(cancel.clone());
    let tenth = arrived.await.expect("the tenth close stamps");
    let passed = world.threads.stamps.lock().unwrap().clone();
    let (resumed, unread, job) = world.resume_two(&[passed.clone(), vec![tenth.clone()]].concat());
    cancel.cancel();
    // The tool call stops waiting.
    caller.abort();
    go.send(()).unwrap();
    // The cleanup announces its changes as it ends.
    crate::session::testing::awaiting(|| "the cleanup's hold to end".to_owned(), world.srig.signals.3.reached(ended + 1)).await;

    let stamps = world.threads.stamps.lock().unwrap().clone();
    assert_eq!(stamps.len(), 10, "the close under way was finished and no other begun: {stamps:?}");
    assert_eq!(stamps.last(), Some(&tenth));
    for (id, _) in &world.workers {
        assert_eq!(world.closed(id), stamps.contains(id), "{id}");
    }
    assert_eq!(world.rig.store.map(&resumed.0).expect("its row")["status"], json!("running"));
    assert!(world.rig.store.map(&unread.0).expect("its row").contains_key("sessionId"));
    assert_eq!(world.board.get(&job, &Scope::default()).expect("the job").status, "running");
    assert_eq!(world.announcements() - announced, 1, "one announcement, cancelled as it was");
}

/// The rows a cleanup's own scan recovers are announced with what it closes, not one by one before it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_rows_a_cleanups_scan_recovers_are_announced_with_its_closes() {
    const LOST: usize = 8;
    let (world, arrived, go) = cleanup_world(0).await;
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    for i in 0..LOST {
        world.rig.store.sessions.lock().unwrap().push(session(&format!("sess_lost{i}"), &format!("lost{i}"), &at(NOW - HOUR), owned.clone()));
    }
    world.rig.store.touch_sessions();
    let announced = world.announcements();
    let cleanup = world.cleanup_scanning(true, mixdog_rt::CancellationToken::new());
    arrived.await.expect("the first close stamps");

    for i in 0..LOST {
        assert!(world.rig.store.map(&format!("sess_lost{i}")).is_some(), "sess_lost{i} has its row again");
    }
    assert_eq!(world.announcements() - announced, 0, "the recovered rows wait for the cleanup's announcement");
    go.send(()).unwrap();
    cleanup.await.unwrap().unwrap();
    assert_eq!(world.announcements() - announced, 1, "one announcement for the recovery and the closes");
}

/// A turn started on a worker's own session while its close stamp is being written keeps running: nothing of the
/// session is stopped and its row stays, while the cleanup closes the rest.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_on_a_worker_while_its_close_is_stamped_is_left_running() {
    use mixdog_agent::agent_tool::host::Registry;
    let (world, arrived, go) = cleanup_world(0).await;
    let cleanup = world.cleanup(mixdog_rt::CancellationToken::new());
    let first = arrived.await.expect("the first close stamps");
    crate::session::TurnStarts::turn_started(&*world.registry, &ThreadId::from(first.as_str()), &"direct".into());
    go.send(()).unwrap();
    let report = cleanup.await.unwrap().unwrap();

    let stopped = world.shells.0.lock().unwrap().clone();
    assert!(!stopped.contains(&first), "the session a turn started on keeps its shells");
    assert_eq!(stopped.len(), CLEANUP_WORKERS - 1, "every other worker's work was stopped");
    assert!(world.rig.store.map(&first).expect("its row").contains_key("sessionId"), "its row stays");
    assert!(!world.registry.is_released(&first) && !world.srig.archive.resolve(&first, None).archived(), "it is neither released nor hidden");
    assert_eq!(report.agents_closed, CLEANUP_WORKERS as u64 - 1, "{report:?}");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completion_ownership_survives_terminal_reads_dequeue_and_core_restart() {
    use crate::session::tests::idle;
    use crate::session::{ItemCommit, RunOutcome};
    use std::sync::atomic::AtomicUsize;

    let data = tempfile::tempdir().unwrap();
    let core = Core::up(data.path()).await;
    let turns = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (count, gate) = (turns.clone(), release.clone());
    core._rig.set_script(Arc::new(move |run| {
        let (count, gate) = (count.clone(), gate.clone());
        Box::pin(async move {
            run.port.input_durable().await.unwrap();
            let first = count.fetch_add(1, Ordering::SeqCst) == 0;
            if first {
                gate.acquire().await.unwrap().forget();
                for (task, status) in [("read-before-notice", "completed"), ("notice-before-read", "failed"), ("still-running", "running")] {
                    run.port
                        .commit_item(ItemCommit {
                            iid: mixdog_core_api::ids::ItemId::from(task),
                            role: Some("tool".into()),
                            model: true,
                            visible: true,
                            prompt: None,
                            body: json!({ "role": "tool", "content": "task output", "toolMeta": {
                                "code": "task-completion", "executionId": task, "status": status
                            }}),
                        })
                        .await
                        .unwrap();
                }
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let owner = core.start("completion-owner", json!({})).await;
    let handle = core.directory.handle(&owner).unwrap();
    core.directory.queue_channel_notification(&owner, "work".into()).await;
    crate::eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    let notice = |id: &str, status: &str| format!("<task-notification><task-id>{id}</task-id><status>{status}</status></task-notification>");
    core.directory.queue_completion_durably(&owner, "shell", "notice-before-read", "failed", notice("notice-before-read", "failed")).await.unwrap();
    release.add_permits(1);
    crate::eventually_on!(&[&handle.cell.stepped], || (turns.load(Ordering::SeqCst) > 0 && idle(&handle)).then_some(())).await;
    for task in ["notice-before-read", "read-before-notice"] {
        core.directory.queue_completion_durably(&owner, "shell", task, "completed", notice(task, "completed")).await.unwrap();
    }
    assert_eq!(turns.load(Ordering::SeqCst), 1, "terminal reads consume both racing notification paths");
    assert!(handle.cell.queue.load().is_empty());
    // Reading running output did not consume its future failure.
    core.directory.queue_completion_durably(&owner, "shell", "still-running", "failed", notice("still-running", "failed")).await.unwrap();
    crate::eventually_on!(&[&handle.cell.stepped], || (turns.load(Ordering::SeqCst) == 2 && idle(&handle)).then_some(())).await;
    core.directory.queue_completion_durably(&owner, "shell", "still-running", "failed", notice("still-running", "failed")).await.unwrap();
    assert_eq!(turns.load(Ordering::SeqCst), 2, "a dequeued completion cannot reopen a finished turn");
    core.directory.shutdown().await;
    drop(handle);
    drop(core);

    let reopened = Core::up(data.path()).await;
    let count = turns.clone();
    reopened._rig.set_script(Arc::new(move |run| {
        let count = count.clone();
        Box::pin(async move {
            run.port.input_durable().await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            RunOutcome::Completed(Default::default())
        })
    }));
    assert_eq!(reopened.queued(&owner).await, 0);
    for task in ["notice-before-read", "read-before-notice", "still-running"] {
        reopened.directory.queue_completion_durably(&owner, "shell", task, "failed", notice(task, "failed")).await.unwrap();
    }
    assert_eq!(turns.load(Ordering::SeqCst), 2, "receipts survive reopening the durable log");
    assert_eq!(reopened.queued(&owner).await, 0);
    reopened.directory.queue_completion_durably(&owner, "shell", "new-failure", "failed", notice("new-failure", "failed")).await.unwrap();
    let handle = reopened.directory.handle(&owner).unwrap();
    crate::eventually_on!(&[&handle.cell.stepped], || (turns.load(Ordering::SeqCst) == 3 && idle(&handle)).then_some(())).await;
    reopened.directory.shutdown().await;
}

/// A fixed-id create is for an id nothing holds: over the id of a stored session it is refused, and the record the
/// store holds is still the first one, with what was written to it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_create_under_the_id_of_a_stored_session_leaves_its_record_as_it_was() {
    use mixdog_core_ports::ports::threads::ThreadState;
    let data = tempfile::tempdir().unwrap();
    let thread = ThreadId::from("sess_taken");
    let core = Core::up(data.path()).await;
    core.directory.create_with_id(thread.clone(), obj(json!({ "cwd": "/first" })), json!({})).await.expect("the first create");
    core.set_header(thread.as_str(), obj(json!({ "probe": "written" }))).await;
    core.store.projected().await;
    core.directory.shutdown().await;
    drop(core);

    let next = Core::up(data.path()).await;
    let again = next.directory.create_with_id(thread.clone(), obj(json!({ "cwd": "/second" })), json!({})).await;
    assert!(again.is_err(), "a create over the id of a stored session is refused");
    next.directory.unload_settled(&thread).await;
    let held = ThreadState::header(&*next.threads, &thread).await.expect("the stored record");
    assert_eq!((held.get("cwd"), held.get("probe")), (Some(&json!("/first")), Some(&json!("written"))), "the first record and its content: {held:?}");
    next.directory.shutdown().await;
}
struct ParkWorld {
    _srig: crate::session::testing::Rig,
    registry: Arc<AgentRegistry>,
    loaded: Arc<crate::session::SessionHandle>,
    sessions: AgentSessions,
    workers: super::workers::AgentWorkers,
}

async fn park_world() -> ParkWorld {
    use crate::session::SessionDirectory;
    use crate::session::tests::start_thread;
    use crate::session::thread_state::SessionThreads;

    struct NoJobs;
    impl mixdog_core_run::run_host::progress::WaitedJobs for NoJobs {
        fn silence(&self, _: &[String], _: i64) -> Option<mixdog_agent::agent_tool::progress::ToolSilence> {
            None
        }
    }
    let srig = crate::session::testing::Rig::new();
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    let rig = Rig::new();
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    let loaded = start_thread(&directory).await;
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    rig.store.sessions.lock().unwrap().push(session("sess_w1", "w1", &at(NOW - HOUR), owned.clone()));
    rig.store.sessions.lock().unwrap().push(session(
        "sess_closed",
        "c1",
        &at(NOW - HOUR),
        json!({ "parentSessionId": "lead", "ownerSessionId": "lead", "closed": true }),
    ));
    rig.store.write_row("sess_w1", Some(worker_row("sess_w1", "w1", owned)));
    rig.store.touch_sessions();
    registry.refresh_tags_from_sessions(false, &lead("lead")).await.unwrap();
    let threads = Arc::new(SessionThreads::new(directory.clone()));
    let sessions = AgentSessions::new(
        directory.clone(),
        threads.clone(),
        registry.clone(),
        Arc::new(Statusline::default()),
        rig.clock.clone(),
        Arc::new(ClosedShells::default()),
        Arc::new(mixdog_tools::fs::ReadState::default()),
    );
    let workers = super::workers::AgentWorkers::new(directory, threads, registry.clone(), Arc::new(NoJobs), rig.clock.clone());
    ParkWorld { _srig: srig, registry, loaded, sessions, workers }
}

/// `parkSession` and the `parked` stage (`agent-tree.mjs`, main 6de9f07bc): an open agent with no runtime left is parked and
/// reads `parked` (`descriptor.parked === true && status === 'idle' && !owner`) until a turn starts on it
/// (`agent-turns.mjs`: `descriptor.parked = false`); an unknown or closed agent is not parked, and a loaded session keeps
/// its runtime.
#[tokio::test(start_paused = true)]
async fn an_idle_agent_with_no_runtime_left_is_parked_until_a_turn_starts() {
    use mixdog_agent::agent_tool::host::Sessions;
    use mixdog_agent::agent_tool::views::Workers;

    let ParkWorld { registry, loaded, sessions, workers, .. } = &park_world().await;
    let stage = || async { workers.entries(false, &lead("lead")).await.into_iter().find(|(tag, _)| tag == "w1").expect("w1 is listed").1.stage };

    assert!(!sessions.park_session("sess_unknown").await);
    assert!(!sessions.park_session("sess_closed").await);
    assert!(!sessions.park_session(loaded.id.as_str()).await, "a loaded session keeps its runtime");
    assert_eq!(stage().await.as_deref(), Some("idle"));
    assert!(sessions.park_session("sess_w1").await);
    assert_eq!(stage().await.as_deref(), Some("parked"));
    assert_eq!(workers.live("sess_w1").runtime_stage.as_deref(), Some("parked"));
    crate::session::TurnStarts::turn_started(&**registry, &ThreadId::from("sess_w1"), &"turn".into());
    assert_eq!(stage().await.as_deref(), Some("idle"));
    assert_eq!(workers.live("sess_w1").runtime_stage, None);
}

/// Closing or cleaning up an idle-unloaded worker releases its external (ACP) agent process, and parking it lets go of
/// the process while idle, keeping what the session approved and holds; a loaded session is not parked, and a cleanup
/// whose turn fence moved releases nothing.
#[tokio::test(start_paused = true)]
async fn closing_cleaning_up_or_parking_an_unloaded_worker_releases_its_agent_process() {
    use mixdog_agent::agent_tool::host::{CloseOptions, MemberClose, MemberOutcome, Sessions};

    let world = park_world().await;
    let steps_of = |prefix: &str| -> Vec<String> {
        world._srig.deletes.0.lock().unwrap().iter().filter_map(|step| step.strip_prefix(prefix).map(str::to_owned)).collect()
    };
    let agent_releases = || steps_of("releaseAgentProcess:");
    let idle_releases = || steps_of("releaseIdleAgentProcess:");

    // Loaded session is not parked and releases no agent process.
    assert!(!world.sessions.park_session(world.loaded.id.as_str()).await);
    assert!(agent_releases().is_empty() && idle_releases().is_empty());

    // Parking an idle-unloaded worker lets go of its idle ACP process, keeping its approvals.
    assert!(world.sessions.park_session("sess_w1").await);
    assert_eq!(idle_releases(), ["sess_w1"]);
    assert!(agent_releases().is_empty());

    // Cleanup with a mismatched turn fence does not release the ACP process.
    world._srig.deletes.0.lock().unwrap().clear();
    let stale_fence = MemberClose { turn: Some(mixdog_agent::agent_tool::host::TurnMark { started: 99, last: Some("stale".to_owned()) }), stamped: true };
    assert_eq!(
        world.sessions.close_member("sess_w1", "agent-cleanup", CloseOptions { tombstone: false, owner_close: true }, stale_fence).await.unwrap(),
        MemberOutcome::Moved
    );
    assert!(agent_releases().is_empty());

    // Cleanup with a matching idle fence releases the ACP process.
    let idle_fence = MemberClose { turn: world.registry.turn_mark("sess_w1"), stamped: true };
    assert_eq!(
        world.sessions.close_member("sess_w1", "agent-cleanup", CloseOptions { tombstone: false, owner_close: true }, idle_fence).await.unwrap(),
        MemberOutcome::Closed
    );
    assert_eq!(agent_releases(), ["sess_w1"]);

    // Closing an idle-unloaded worker releases its ACP process.
    world._srig.deletes.0.lock().unwrap().clear();
    assert!(world.sessions.close_session("sess_w1", "cli-agent-close", CloseOptions { tombstone: false, owner_close: true }).await);
    assert_eq!(agent_releases(), ["sess_w1"]);
}

/// What cleanup reads: the open agent sessions, the sessions a tag is bound to, and whether one is hidden already.
#[tokio::test(start_paused = true)]
async fn cleanup_reads_the_open_agent_sessions_the_bound_sessions_and_the_hidden_flag() {
    use mixdog_agent::agent_tool::host::Registry;
    use mixdog_agent::agent_tool::host::Sessions;

    let ParkWorld { registry, loaded, sessions, .. } = &park_world().await;
    let open: Vec<(String, String)> = sessions.open_sessions().await.into_iter().filter(|s| !s.tag.is_empty()).map(|s| (s.id, s.tag)).collect();
    assert_eq!(open, [("sess_w1".to_owned(), "w1".to_owned())], "a closed session is not listed");
    assert_eq!(registry.bound_sessions(), ["sess_w1".to_owned()]);
    let started = loaded.id.as_str().to_owned();
    assert!(!sessions.is_hidden(&started).await);
    let hide = mixdog_agent::agent_tool::host::Hide { session_id: started.clone(), released_at: None };
    assert!(sessions.hide_sessions(std::slice::from_ref(&hide)).await.is_empty());
    assert!(sessions.is_hidden(&started).await);
    sessions.reveal_session(&started).await;
    assert!(!sessions.is_hidden(&started).await);
}

/// A close's hide belongs to the release that close made: a session a turn or a send took up again between the release
/// and the hide stays listed, and one nothing touched is hidden.
#[tokio::test(start_paused = true)]
async fn a_closes_hide_lands_only_while_the_session_still_holds_its_release() {
    use mixdog_agent::agent_tool::host::Registry;
    use mixdog_agent::agent_tool::host::Sessions;

    let ParkWorld { registry, loaded, sessions, .. } = &park_world().await;
    let id = loaded.id.as_str().to_owned();
    let release = || {
        registry.mark_released(std::slice::from_ref(&id));
        let released_at = registry.released_stamp(&id);
        assert!(released_at.is_some(), "the release has its stamp");
        [mixdog_agent::agent_tool::host::Hide { session_id: id.clone(), released_at }]
    };

    let hides = release();
    crate::session::TurnStarts::turn_started(&**registry, &loaded.id, &"turn".into());
    assert!(sessions.hide_sessions(&hides).await.is_empty());
    assert!(!sessions.is_hidden(&id).await, "a turn started on it before the hide");

    let hides = release();
    sessions.reveal_session(&id).await;
    assert!(sessions.hide_sessions(&hides).await.is_empty());
    assert!(!sessions.is_hidden(&id).await, "a send revealed it before the hide");

    let hides = release();
    assert!(sessions.hide_sessions(&hides).await.is_empty());
    assert!(sessions.is_hidden(&id).await, "nothing took it up: it is hidden");
    sessions.reveal_session(&id).await;
    assert!(!sessions.is_hidden(&id).await, "a send revealed it after the hide");
    assert_eq!(registry.released_stamp(&id), None, "and its release is over");
}

/// An owner close's stamp is for an idle session: while the session runs a turn its own writer writes nothing and says
/// so, and the same stamp lands once the session is idle.
#[tokio::test(start_paused = true)]
async fn a_stamp_for_an_idle_session_is_not_written_while_it_runs() {
    use crate::eventually_on;
    use crate::session::SessionDirectory;
    use crate::session::close::Detached;
    use crate::session::close::write_detach;
    use crate::session::seams::RunOutcome;
    use crate::session::tests::idle;
    use crate::session::tests::start_thread;
    use crate::session::tests::turn;
    use crate::session::thread_state::SessionThreads;

    let srig = crate::session::testing::Rig::new();
    srig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    let handle = start_thread(&directory).await;
    let threads = SessionThreads::new(directory.clone());
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;

    let before = handle.cell.header.load_full().get("generation").cloned();
    let at_rest = mixdog_core_ports::ports::threads::RunFence::Idle;
    assert_eq!(write_detach(&threads, &handle.id, "cli-agent-close", true, 5, Some(&at_rest)).await.unwrap(), Detached::Moved);
    let header = handle.cell.header.load_full();
    assert_eq!((header.get("generation").cloned(), header.get("ownerClosedAt")), (before, None), "nothing was written");

    assert!(directory.abort_session_turn(&handle.id, "stop"));
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(write_detach(&threads, &handle.id, "cli-agent-close", true, 5, Some(&at_rest)).await.unwrap(), Detached::Stamped);
    assert_eq!(handle.cell.header.load_full().get("ownerClosedAt"), Some(&json!(5)));
}

/// A cancelled job closes the turn it submitted, named by its id: the stamp and the stop land while that turn runs, and
/// once it has ended nothing of the session is touched, whatever runs on it by then.
#[tokio::test(start_paused = true)]
async fn a_cancelled_jobs_close_reaches_the_turn_it_names_and_no_other() {
    use crate::eventually_on;
    use crate::session::seams::RunOutcome;
    use crate::session::tests::idle;
    use crate::session::tests::turn;
    use mixdog_agent::agent_tool::host::Sessions;

    let world = park_world().await;
    world._srig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let (sessions, handle) = (&world.sessions, &world.loaded);
    let id = handle.id.as_str();
    let running = || handle.cell.run.load_full().map(|run| run.turn.as_str().to_owned());
    let stamp = || {
        let header = handle.cell.header.load_full();
        (header.get("generation").cloned(), header.get("detachedReason").cloned())
    };

    turn(handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || running().map(|_| ())).await;
    let first = running().expect("the first turn runs");
    let before = stamp();
    assert!(!sessions.close_turn(id, "another-turn", "agent-task-cancel").await, "not the turn the session runs");
    assert_eq!((stamp(), running().as_deref()), (before, Some(first.as_str())), "nothing was written or stopped");
    assert!(sessions.close_turn(id, &first, "agent-task-cancel").await);
    assert_eq!(stamp().1, Some(json!("agent-task-cancel")));
    eventually_on!(&[&handle.cell.stepped], || idle(handle).then_some(())).await;

    // Its turn ended and another runs: the job has nothing on the session to stop.
    turn(handle, "second", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || running().map(|_| ())).await;
    let second = running().expect("the second turn runs");
    let before = stamp();
    assert!(!sessions.close_turn(id, &first, "agent-task-cancel").await, "its turn ended");
    assert_eq!(stamp(), before, "nothing was written on the session another turn runs on");
    let run = handle.cell.run.load_full().expect("the second turn still runs");
    assert!(run.turn.as_str() == second && !run.cancel.is_aborted(), "the turn that runs now keeps running");

    assert!(sessions.close_turn(id, &second, "agent-task-cancel").await);
    eventually_on!(&[&handle.cell.stepped], || idle(handle).then_some(())).await;
}

/// `sessionGone`: only a record proven absent is gone, never a loaded session. Neither the index nor the store knows the
/// session; one the index lists, and a loaded one, are not gone.
#[tokio::test(start_paused = true)]
async fn only_a_session_proven_absent_is_gone() {
    use mixdog_agent::agent_tool::host::Sessions;

    let ParkWorld { loaded, sessions, .. } = &park_world().await;
    assert!(sessions.session_gone("sess_never").await);
    assert!(!sessions.session_gone("sess_w1").await);
    assert!(!sessions.session_gone(loaded.id.as_str()).await);
    assert!(!sessions.session_gone("").await);
}
/// The idle release (`close-flow/idle-release.mjs` over `parkIdle`): an idle row past its period is released at once. The row
/// of a session whose record is gone is dropped (`dropGoneRow`); an agent whose session is still loaded is not parked and
/// keeps its row.
#[tokio::test(start_paused = true)]
async fn the_idle_release_drops_the_row_of_a_deleted_session_and_leaves_a_loaded_one() {
    use crate::session::SessionDirectory;
    use crate::session::tests::start_thread;
    use crate::session::thread_state::SessionThreads;

    struct Frozen;
    impl mixdog_agent::env::Clock for Frozen {
        fn now_ms(&self) -> i64 {
            NOW
        }
    }
    let srig = crate::session::testing::Rig::new();
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    let rig = Rig::new();
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    let loaded = start_thread(&directory).await;
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    rig.store.write_row("sess_deleted", Some(worker_row("sess_deleted", "d1", owned.clone())));
    rig.store.write_row(loaded.id.as_str(), Some(worker_row(loaded.id.as_str(), "l1", owned)));
    rig.store.touch_sessions();
    registry.refresh_tags_from_sessions(false, &lead("lead")).await.unwrap();
    assert_eq!(registry.idle_rows().len(), 2);
    let sessions = Arc::new(AgentSessions::new(
        directory.clone(),
        Arc::new(SessionThreads::new(directory.clone())),
        registry.clone(),
        Arc::new(Statusline::default()),
        rig.clock.clone(),
        Arc::new(ClosedShells::default()),
        Arc::new(mixdog_tools::fs::ReadState::default()),
    ));
    let board = mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(Frozen), None, None);
    let release = tokio::spawn(AgentSessions::keep_idle_release(Arc::downgrade(&sessions), board));
    crate::eventually_on!(&[&rig.store.written], || rig.store.map("sess_deleted").is_none().then_some(())).await;
    assert!(rig.store.map(loaded.id.as_str()).is_some());
    assert!(!registry.is_parked(loaded.id.as_str()));
    release.abort();
}
/// A Lead's turns through the composed stores, with other threads loaded: the row goes to the Lead index, not the Lead's
/// header, so its record does not change (no `session_record`, whose listener makes every loaded thread re-read its agent
/// status) and no worker-row signal is raised; the pool alone is told, lists the row, and the next process lists it too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_leads_turns_change_no_session_record_and_tell_the_pool_alone() {
    #[derive(Default)]
    struct Told(Mutex<Vec<String>>);
    impl signals::StatusSignals for Told {
        fn worker_rows(&self, session: &str) {
            self.0.lock().unwrap().push(format!("worker:{session}"));
        }
        fn lead_rows(&self, session: &str) {
            self.0.lock().unwrap().push(format!("lead:{session}"));
        }
    }
    let data = tempfile::tempdir().unwrap();
    let core = Core::up(data.path()).await;
    let told = Arc::new(Told::default());
    assert!(core.workers.bind_signals(told.clone()).is_ok());
    let lead = core.start("op-lead", json!({})).await;
    let _other = core.start("op-other", json!({})).await;
    core.written().await;
    core._rig.signals.0.lock().unwrap().clear();

    crate::session::TurnStarts::turn_started(&core.registry, &lead, &"turn".into());
    crate::session::TurnStarts::turn_settled(&core.registry, &lead);
    core.written().await;
    let records = core._rig.signals.0.lock().unwrap().clone();
    assert!(!records.contains(&format!("record:{}", lead.as_str())), "the Lead's record did not change: {records:?}");
    let lead_told = format!("lead:{}", lead.as_str());
    assert_eq!(*told.0.lock().unwrap(), [lead_told.clone(), lead_told], "the pool alone was told, at each turn boundary");
    let header = mixdog_core_ports::ports::threads::ThreadState::header(&*core.threads, &lead).await.expect("the Lead's header");
    assert!(!header.contains_key("worker"), "the row is not in the header: {header:?}");
    assert_eq!(lead_row_of(&core.registry, lead.as_str()).await.expect("the pool lists the row")["status"], json!("idle"));
    drop(core);

    let next = Core::up(data.path()).await;
    let row = lead_row_of(&next.registry, lead.as_str()).await.expect("the next process lists the row");
    assert_eq!((row["status"].clone(), row["ownerSessionId"].clone()), (json!("idle"), json!(lead.as_str())));
}

/// The settle identity the Agents pool keys a cleared outcome on: fixed once for a turn, kept by a terminal scan of that turn
/// that fills `finishedAt` and moves `updatedAt`, refused to a listing that read an earlier turn, and fixed anew for a new one.
#[tokio::test]
async fn a_settle_identity_is_fixed_once_per_turn_and_a_scan_of_that_turn_does_not_move_it() {
    use crate::session::TurnStarts;
    use mixdog_core_agents::agents::SettleFix;
    let rig = Rig::new();
    let row = worker_row("s-a", "a", json!({ "status": "completed", "turnStartedAt": at(NOW - 9_000), "updatedAt": at(NOW - 5_000) }));
    rig.store.write("s-a", Some(row));
    let registry = rig.registry();
    registry.reload().await.unwrap();
    let fix = |turns: u64, candidate: Value| SettleFix { session_id: "s-a".into(), turns, candidate };
    let first = json!(at(NOW - 5_000));
    assert_eq!(registry.settle_identities(&[fix(0, first.clone())]), [first.clone()]);

    let scanned = session("s-a", "a", &at(NOW - HOUR), json!({ "updatedAt": at(NOW - 1_000) }));
    {
        let mut st = registry.lock();
        assert!(registry.scan_upsert(&mut st, &scanned, "a", &HashMap::new()));
    }
    let stored = rig.store.map("s-a").expect("the row");
    assert_eq!((stored["finishedAt"].clone(), stored["updatedAt"].clone()), (json!(at(NOW - 1_000)), json!(at(NOW - 1_000))), "the scan stamped it");
    assert_eq!((stored["settledAt"].clone(), stored["settledTurn"].clone()), (first.clone(), json!(0)));
    assert_eq!(registry.settle_identities(&[fix(0, json!(at(NOW - 1_000)))]), [first.clone()]);

    TurnStarts::turn_started(&registry, &"s-a".into(), &"turn-1".into());
    registry.upsert_session_row(&scanned, "a", &obj(json!({ "status": "running", "turnStartedAt": at(NOW + 1_000) })));
    assert_eq!(rig.store.map("s-a").expect("the row")["startedTurns"], json!(1), "the start is counted");
    assert_eq!(registry.settle_identities(&[fix(0, json!(at(NOW)))]), [Value::Null], "a listing of the earlier turn fixes nothing");
    let next = json!(at(NOW + 2_000));
    assert_eq!(registry.settle_identities(&[fix(1, next.clone())]), [next.clone()]);
    assert_eq!(registry.settle_identities(&[fix(1, json!(at(NOW + 3_000)))]), [next]);
}

/// Restart settlement clears `turnStartedAt`, and a worker that is recovered, resumed and recovered again keeps the finish
/// time of its first failure: the second failure still gets its own, later, settle identity.
#[tokio::test]
async fn a_worker_recovered_twice_gets_a_later_settle_identity_for_its_second_restart_failure() {
    use crate::session::TurnStarts;
    use mixdog_core_agents::agents::SettleFix;
    let rig = Rig::new();
    let registry = rig.registry();
    registry.reload().await.unwrap();
    let header = session("s-a", "a", &at(NOW - HOUR), json!({}));
    let live = restart::Liveness { probe: &Dead, own_pid: PID, running: &|_| false, reap: &Hour, now_ms: NOW };
    let mut identities = Vec::new();
    for (turns, started) in [(1_u64, NOW - 9_000), (2, NOW - 4_000)] {
        let start = json!({ "status": "running", "turnStartedAt": at(started), "runtimePid": PID + 1 });
        registry.upsert_session_row(&header, "a", &obj(start));
        TurnStarts::turn_started(&registry, &"s-a".into(), &format!("turn-{turns}").as_str().into());
        assert!(registry.recover_stale_worker_rows(true, &live).await.unwrap());
        registry.reload().await.unwrap();
        let failed = rig.store.map("s-a").expect("the row");
        assert_eq!((failed["status"].clone(), failed["turnStartedAt"].clone(), failed["startedTurns"].clone()), (json!("failed"), Value::Null, json!(turns)));
        let fix = SettleFix { session_id: "s-a".into(), turns, candidate: failed["finishedAt"].clone() };
        identities.push(registry.settle_identities(&[fix])[0].clone());
    }
    assert!(stamp_ms(Some(&identities[1])) > stamp_ms(Some(&identities[0])), "two failures, two identities: {identities:?}");
}

/// A turn is counted by its turn id, where its session starts it: a second turn whose start stamp equals the first one's
/// (a clock set back) is a second outcome with a later settle identity, and the same start told twice is one turn.
#[tokio::test]
async fn two_turn_ids_with_equal_start_stamps_are_two_outcomes_with_two_settle_identities() {
    use crate::session::TurnStarts;
    use mixdog_agent::agent_tool::flow::seams::RowUpdate;
    use mixdog_agent::agent_tool::flow::seams::WorkerRows;
    use mixdog_core_agents::agents::SettleFix;
    let rig = Rig::new();
    rig.store.sessions.lock().unwrap().push(session("s-a", "a", &at(NOW - HOUR), json!({})));
    rig.store.touch_sessions();
    let registry = rig.registry();
    registry.reload().await.unwrap();
    let running =
        || RowUpdate { status: Some("running".into()), stage: Some("running".into()), turn_started_at: Some(at(NOW - 9_000)), ..RowUpdate::default() };
    let settle = || RowUpdate { status: Some("idle".into()), stage: Some("idle".into()), finished_at: Some(at(NOW - 5_000)), ..RowUpdate::default() };
    let stored = || rig.store.map("s-a").expect("the row");
    let fix = |turns: u64| SettleFix { session_id: "s-a".into(), turns, candidate: json!(at(NOW - 5_000)) };
    let start = |turn: &str| TurnStarts::turn_started(&registry, &"s-a".into(), &turn.into());
    // The dispatch of the session's turns holds what their row writes read of it, the session not being loaded.
    let _dispatch = WorkerRows::hold(&registry, "s-a").await;

    // The spawn's row, before any turn: a row write counts none.
    WorkerRows::upsert(&registry, "s-a", Some("a"), settle());
    assert!(!stored().contains_key("startedTurns"));
    start("turn-1");
    WorkerRows::upsert(&registry, "s-a", Some("a"), running());
    start("turn-1");
    assert_eq!(stored()["startedTurns"], json!(1), "the same start told twice is one turn");
    WorkerRows::upsert(&registry, "s-a", Some("a"), settle());
    let first = registry.settle_identities(&[fix(1)])[0].clone();

    start("turn-2");
    WorkerRows::upsert(&registry, "s-a", Some("a"), running());
    assert_eq!((stored()["startedTurns"].clone(), stored()["turnStartedAt"].clone()), (json!(2), json!(at(NOW - 9_000))));
    assert_eq!(registry.settle_identities(&[fix(1)]), [Value::Null], "a listing of the first turn fixes nothing");
    WorkerRows::upsert(&registry, "s-a", Some("a"), settle());
    let second = registry.settle_identities(&[fix(2)])[0].clone();
    assert!(stamp_ms(Some(&second)) > stamp_ms(Some(&first)), "two turns, two identities: {first} {second}");
}

/// A finished worker whose outcome was cleared takes a turn nothing observes (its session was opened and asked directly,
/// or it was not loaded when its work was claimed): the session's own start counts it, so the new outcome is fixed under
/// a later identity than the cleared one.
#[tokio::test(start_paused = true)]
async fn a_turn_nothing_observes_is_counted_on_its_workers_row_and_settles_under_a_later_identity() {
    use mixdog_core_agents::agents::SettleFix;

    use crate::eventually_on;
    use crate::session::SessionDirectory;
    use crate::session::tests::idle;
    use crate::session::tests::start_thread;
    use crate::session::tests::turn;

    let srig = crate::session::testing::Rig::new();
    let directory = Arc::new(SessionDirectory::new(srig.deps()));
    let rig = Rig::new();
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    assert!(srig.turn_starts.bind(registry.clone()).is_ok());
    let handle = start_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    rig.store.write(&id, Some(worker_row(&id, "a", json!({ "status": "completed", "finishedAt": at(NOW - 5_000), "updatedAt": at(NOW - 5_000) }))));
    registry.reload().await.unwrap();
    let fix = |turns: u64| SettleFix { session_id: id.clone(), turns, candidate: json!(at(NOW - 5_000)) };
    let cleared = registry.settle_identities(&[fix(0)])[0].clone();
    assert_eq!(cleared, json!(at(NOW - 5_000)));

    turn(&handle, "more work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(rig.store.map(&id).expect("the row")["startedTurns"], json!(1), "the session's own start counted the turn");
    assert_eq!(registry.settle_identities(&[fix(0)]), [Value::Null], "the cleared outcome is no longer the row's");
    let next = registry.settle_identities(&[fix(1)])[0].clone();
    assert!(stamp_ms(Some(&next)) > stamp_ms(Some(&cleared)), "the new outcome's identity is later: {cleared} {next}");
    let row = rig.store.map(&id).expect("the row");
    assert!(stamp_ms(row.get("finishedAt")) > stamp_ms(Some(&cleared)), "the row takes the turn's end, which the pool lists the outcome by: {row:?}");

    // A listener that records nothing of a turn (it joined after the start) takes nothing from the row: its finish is
    // the session's own.
    struct Deaf;
    impl mixdog_agent::agent_tool::flow::seams::TurnListener for Deaf {
        fn turn_started(&self, _: mixdog_agent::agent_tool::flow::seams::TurnStart) {}
        fn turn_settled(&self, _: mixdog_agent::agent_tool::flow::seams::TurnOutcome) {}
    }
    let _watching = mixdog_agent::agent_tool::flow::seams::TurnSource::observe_session_turns(&*directory, &id, Arc::new(Deaf)).expect("a hosted session");
    let first_end = stamp_ms(row.get("finishedAt"));
    rig.clock.0.store(NOW + 1_000, Ordering::SeqCst);
    turn(&handle, "and more", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && stamp_ms(rig.store.map(&id)?.get("finishedAt")) > first_end).then_some(())).await;
}

/// A turn started on a worker after its close stamp landed, before the cleanup releases its tree, keeps its row and its
/// tag: only the members still at the turn the cleanup judged idle, with no run registered at their start gate, are
/// released.
#[tokio::test]
async fn a_release_leaves_the_member_a_turn_started_on_since_its_close() {
    use mixdog_agent::agent_tool::host::Registry;
    /// The session a run is registered on at its start gate, before the registry counted its turn.
    struct Started(&'static str);
    impl LiveSessions for Started {
        fn loaded(&self) -> Vec<String> {
            Vec::new()
        }
        fn header(&self, _: &str) -> Option<Row> {
            None
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
        fn while_idle(&self, session: &str, at: &mut dyn FnMut() -> bool) -> bool {
            session != self.0 && at()
        }
    }
    let rig = Rig::new();
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    let members = [("sess_a", "a"), ("sess_b", "b"), ("sess_c", "c")];
    for (id, tag) in members {
        rig.store.sessions.lock().unwrap().push(session(id, tag, &at(NOW - HOUR), owned.clone()));
        rig.store.write_row(id, Some(worker_row(id, tag, owned.clone())));
    }
    rig.store.touch_sessions();
    let registry = AgentRegistry::new(rig.store.clone(), Arc::new(Started("sess_c")), Arc::new(Hour), rig.clock.clone());
    registry.refresh_tags_from_sessions(false, &lead("lead")).await.unwrap();
    let judged: HashMap<_, _> = members.into_iter().map(|(id, _)| (id.to_owned(), registry.turn_mark(id))).collect();
    crate::session::TurnStarts::turn_started(&registry, &"sess_b".into(), &"direct".into());

    let mixdog_agent::agent_tool::host::Released { releases: released, spared } =
        registry.release_closed_at(&lead("lead"), Some("a"), "sess_a", &["sess_b".to_owned(), "sess_c".to_owned()], Some(&judged));
    assert_eq!(released.iter().map(|release| release.receipt.session_id.as_str()).collect::<Vec<_>>(), ["sess_a"]);
    assert_eq!(spared.iter().map(|member| member.session_id.as_str()).collect::<Vec<_>>(), ["sess_b", "sess_c"], "each spared member is answered");
    assert!(spared.iter().all(|member| member.reason.contains("started another turn")), "{spared:?}");
    let receipt = &released[0].receipt;
    let held_before = Some(worker_row("sess_a", "a", owned.clone()));
    assert_eq!((receipt.incarnation.as_str(), receipt.prior.as_ref()), ("store:sess_a", held_before.as_ref()), "decided on the map the registry held");
    assert_eq!((receipt.tag.as_deref(), &receipt.turn, receipt.released.contains_key("releasedAt")), (Some("a"), &judged["sess_a"], true));
    assert_eq!(rig.store.map("sess_a").as_ref(), Some(&receipt.released), "the receipt names the map that was written");
    assert!(rig.store.map("sess_a").is_some_and(|map| !map.contains_key("sessionId")), "the released member's row goes");
    for (kept, tag) in [("sess_b", "b"), ("sess_c", "c")] {
        assert!(!registry.is_released(kept) && rig.store.map(kept).is_some_and(|map| map.contains_key("sessionId")), "{kept} keeps its row");
        assert_eq!(registry.tag_for_session(kept).await.as_deref(), Some(tag));
    }
    assert!(registry.is_released("sess_a"));
}

/// A cleanup over a tree of the first worker and a descendant `sess_kid` (whose header stamp `refused_stamp` names, if any is
/// refused), run until the root's close stamp waits: the descendant's has landed. The world, the root, the cleanup and the
/// release of the root's stamp.
async fn cleanup_held_at_the_root_stamp(
    refused_stamp: Option<&str>,
) -> (CleanupWorld, String, tokio::task::JoinHandle<Result<mixdog_agent::agent_tool::dispatch::CleanupReport, String>>, tokio::sync::oneshot::Sender<()>) {
    let (world, arrived, go) = cleanup_world(0).await;
    let parent = world.workers[0].0.clone();
    let below = json!({ "parentSessionId": parent, "ownerSessionId": parent });
    world.rig.store.sessions.lock().unwrap().push(session("sess_kid", "kid", &at(NOW - HOUR), below.clone()));
    world.rig.store.write_row("sess_kid", Some(worker_row("sess_kid", "kid", below)));
    world.rig.store.touch_sessions();
    if let Some(id) = refused_stamp {
        world.threads.refused.lock().unwrap().insert(id.to_owned());
    }
    // The root is stamped last: while its stamp waits, the descendant's has landed and the tree is not released yet.
    let (root_told, root_arrived) = tokio::sync::oneshot::channel();
    let (root_go, root_held) = tokio::sync::oneshot::channel();
    *world.threads.hold_of.lock().unwrap() = Some((parent.clone(), root_told, root_held));
    let cleanup = world.cleanup(mixdog_rt::CancellationToken::new());
    arrived.await.expect("the first close stamps");
    go.send(()).unwrap();
    root_arrived.await.expect("the root's close stamps");
    (world, parent, cleanup, root_go)
}

/// A tree is counted closed only when every member the cleanup planned to release has a receipt. A descendant a direct
/// turn started on after its close stamp landed and before the tree was released is spared by the turn fence and has
/// none: the tree is partial, the member is named, and the root that did close is released as in any partial tree.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tree_whose_descendant_started_a_turn_before_its_release_is_not_counted_closed() {
    use mixdog_agent::agent_tool::host::Registry;
    let (world, parent, cleanup, root_go) = cleanup_held_at_the_root_stamp(None).await;
    assert!(world.threads.stamps.lock().unwrap().contains(&"sess_kid".to_owned()), "the descendant's stamp landed first");
    crate::session::TurnStarts::turn_started(&*world.registry, &ThreadId::from("sess_kid"), &"direct".into());
    root_go.send(()).unwrap();
    let report = cleanup.await.unwrap().unwrap();

    assert_eq!(report.agents_closed, CLEANUP_WORKERS as u64 - 1, "the tree with a member that has no receipt is not counted: {report:?}");
    // The spared member is its own outcome, under its own id and with its own reason.
    let named: Vec<&Value> = report.not_closed.iter().filter(|entry| entry["sessionId"] == json!("sess_kid")).collect();
    assert!(
        matches!(named[..], [entry] if entry["reason"].as_str().is_some_and(|reason| reason.contains("sess_kid") && reason.contains("started another turn"))),
        "{:?}",
        report.not_closed
    );
    assert!(world.registry.is_released(&parent), "the root that closed is released");
    assert!(!world.registry.is_released("sess_kid") && world.rig.store.map("sess_kid").is_some_and(|map| map.contains_key("sessionId")), "the fence spared it");
}

/// Each member of a tree answers for itself. A descendant whose close stamp could not be written and a root a turn
/// started on after its own stamp landed are both reported, each under its own id: the first one's error does not
/// stand in for the second one's turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tree_reports_the_member_that_failed_and_the_member_that_started_another_turn() {
    use mixdog_agent::agent_tool::host::Registry;
    let (world, parent, cleanup, root_go) = cleanup_held_at_the_root_stamp(Some("sess_kid")).await;
    crate::session::TurnStarts::turn_started(&*world.registry, &ThreadId::from(parent.as_str()), &"direct".into());
    root_go.send(()).unwrap();
    let report = cleanup.await.unwrap().unwrap();

    let reasons = |id: &str| -> Vec<String> {
        let of = report.not_closed.iter().filter(|entry| entry["sessionId"] == json!(id));
        of.map(|entry| entry["reason"].as_str().unwrap_or_default().to_owned()).collect()
    };
    let (kid, root) = (reasons("sess_kid"), reasons(&parent));
    assert!(matches!(&kid[..], [reason] if reason.contains("could not be durably closed")), "{:?}", report.not_closed);
    assert!(matches!(&root[..], [reason] if reason.contains(&parent) && reason.contains("started another turn")), "{:?}", report.not_closed);
    assert_eq!(report.not_closed.len(), 2, "{:?}", report.not_closed);
    assert_eq!(report.agents_closed, CLEANUP_WORKERS as u64 - 1, "{report:?}");
    assert!(!world.registry.is_released(&parent) && !world.registry.is_released("sess_kid"), "neither was released");
}

/// A release that was not stored is recovered by the scope its tree was released under. A descendant's own owner is the
/// agent above it, which the cleanup's scope does not own: it is recovered all the same, with its root, and a cleanup
/// of another Lead recovers neither.
#[tokio::test]
async fn a_descendants_unstored_release_is_recovered_by_the_scope_that_released_its_tree() {
    use mixdog_agent::agent_tool::host::Registry;
    let rig = Rig::new();
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    let below = json!({ "parentSessionId": "sess_root", "ownerSessionId": "sess_root" });
    for (id, tag, owner) in [("sess_root", "root", &owned), ("sess_kid", "kid", &below)] {
        rig.store.sessions.lock().unwrap().push(session(id, tag, &at(NOW - HOUR), owner.clone()));
        rig.store.write_row(id, Some(worker_row(id, tag, owner.clone())));
    }
    // A descendant with no worker map at all: it has no owner of its own to match a scope on.
    rig.store.sessions.lock().unwrap().push(session("sess_bare", "bare", &at(NOW - HOUR), below));
    rig.store.touch_sessions();
    let registry = AgentRegistry::new(rig.store.clone(), rig.live.clone(), Arc::new(Hour), rig.clock.clone());
    registry.refresh_tags_from_sessions(false, &lead("lead")).await.unwrap();
    let members = ["sess_root", "sess_kid", "sess_bare"];
    let judged: HashMap<_, _> = members.into_iter().map(|id| (id.to_owned(), registry.turn_mark(id))).collect();

    rig.store.refuse_releases.store(true, Ordering::SeqCst);
    let released =
        registry.release_closed_at(&lead("lead"), Some("root"), "sess_root", &["sess_kid".to_owned(), "sess_bare".to_owned()], Some(&judged)).releases;
    assert_eq!(released.len(), 3);
    assert!(released.iter().all(|release| matches!(release.done.now(), Some(ReleaseOutcome::Refused(_)))), "the store refused each");
    assert!(rig.store.map("sess_kid").is_some_and(|map| map.contains_key("sessionId")), "nothing of the refused release is stored");

    rig.store.refuse_releases.store(false, Ordering::SeqCst);
    assert!(registry.recover_releases(&lead("other")).is_empty(), "another Lead's cleanup recovers none of them");
    let mut again = registry.recover_releases(&lead("lead"));
    again.sort_by(|a, b| a.receipt.session_id.cmp(&b.receipt.session_id));
    assert_eq!(again.iter().map(|release| release.receipt.session_id.as_str()).collect::<Vec<_>>(), ["sess_bare", "sess_kid", "sess_root"]);
    for (release, first) in again.iter().zip({
        let mut first: Vec<_> = released.iter().map(|release| &release.receipt).collect();
        first.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        first
    }) {
        assert_eq!(release.done.now(), Some(ReleaseOutcome::Stored));
        assert_eq!((&release.receipt.operation, &release.receipt.incarnation), (&first.operation, &first.incarnation), "the same operation, not a new one");
        assert_eq!(rig.store.map(&release.receipt.session_id).as_ref(), Some(&release.receipt.released));
    }
    assert!(registry.recover_releases(&lead("lead")).is_empty() && registry.lock().releases.is_empty(), "nothing is left to recover");
}

/// Unknown identity means no release decision. A member whose store can tell no identity of its session is spared before
/// anything of it changes: its tag stays bound, its map and its revision are as they were, no release is held for it
/// and it is not reported released; it is answered with its own reason, which is not a turn's. A member whose earlier
/// release is of unknown outcome is spared the same way: nothing is decided over it.
#[tokio::test]
async fn a_member_whose_identity_is_unknown_is_spared_with_nothing_of_it_changed() {
    use mixdog_agent::agent_tool::host::Registry;
    let rig = Rig::new();
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    let below = json!({ "parentSessionId": "sess_root", "ownerSessionId": "sess_root" });
    for (id, tag, owner) in [("sess_root", "root", &owned), ("sess_kid", "kid", &below)] {
        rig.store.sessions.lock().unwrap().push(session(id, tag, &at(NOW - HOUR), owner.clone()));
        rig.store.write_row(id, Some(worker_row(id, tag, owner.clone())));
    }
    rig.store.touch_sessions();
    let registry = AgentRegistry::new(rig.store.clone(), rig.live.clone(), Arc::new(Hour), rig.clock.clone());
    registry.refresh_tags_from_sessions(false, &lead("lead")).await.unwrap();
    let judged: HashMap<_, _> = ["sess_root", "sess_kid"].into_iter().map(|id| (id.to_owned(), registry.turn_mark(id))).collect();
    let held = |id: &str| {
        let st = registry.lock();
        (st.map(id).cloned(), st.writes, st.releases.contains_key(id))
    };
    let before = (held("sess_root"), held("sess_kid"));

    rig.store.unknown.lock().unwrap().extend(["sess_root".to_owned(), "sess_kid".to_owned()]);
    let released = registry.release_closed_at(&lead("lead"), Some("root"), "sess_root", &["sess_kid".to_owned()], Some(&judged));
    assert!(released.releases.is_empty(), "no release was decided");
    assert_eq!(released.spared.iter().map(|member| member.session_id.as_str()).collect::<Vec<_>>(), ["sess_root", "sess_kid"]);
    assert!(released.spared.iter().all(|member| member.reason.contains("identity") && !member.reason.contains("turn")), "{:?}", released.spared);
    assert_eq!((held("sess_root"), held("sess_kid")), before, "neither map, revision nor held release moved");
    assert_eq!(registry.tag_session("root").as_deref(), Some("sess_root"), "the root's tag is still bound");
    assert!(!registry.is_released("sess_root") && !registry.is_released("sess_kid"));
    assert!(rig.store.map("sess_kid").is_some_and(|map| map.contains_key("sessionId")), "nothing was written");

    // Known again, the root is released; its descendant alone stays spared, and the next cleanup decides it afresh.
    rig.store.unknown.lock().unwrap().remove("sess_root");
    let released = registry.release_closed_at(&lead("lead"), Some("root"), "sess_root", &["sess_kid".to_owned()], Some(&judged));
    assert_eq!(released.releases.iter().map(|release| release.receipt.session_id.as_str()).collect::<Vec<_>>(), ["sess_root"]);
    assert_eq!(released.spared.iter().map(|member| member.session_id.as_str()).collect::<Vec<_>>(), ["sess_kid"]);
    let (kid, was) = (held("sess_kid"), before.1);
    assert_eq!((kid.0, kid.2), (was.0, was.2));
}

/// The tombstones a cleanup's refresh leaves of stale rows are announced with what it closes, not one by one before it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_stale_rows_a_cleanups_refresh_tombstones_are_announced_with_its_closes() {
    const STALE: usize = 3;
    let (world, arrived, go) = cleanup_world(0).await;
    for i in 0..STALE {
        let id = format!("sess_stale{i}");
        let stale = json!({ "parentSessionId": "lead", "ownerSessionId": "lead", "status": "running", "updatedAt": at(NOW - 2 * HOUR) });
        world.rig.store.write_row(&id, Some(worker_row(&id, &format!("stale{i}"), stale)));
    }
    let announced = world.announcements();
    let cleanup = world.cleanup(mixdog_rt::CancellationToken::new());
    arrived.await.expect("the first close stamps");

    for i in 0..STALE {
        assert!(world.rig.store.map(&format!("sess_stale{i}")).is_some_and(|map| map.contains_key("tombstone")), "sess_stale{i} is a tombstone");
    }
    assert_eq!(world.announcements() - announced, 0, "the tombstones wait for the cleanup's announcement");
    go.send(()).unwrap();
    cleanup.await.unwrap().unwrap();
    assert_eq!(world.announcements() - announced, 1, "one announcement for the tombstones and the closes");
}

/// A start that holds the worker rows (its index is rebuilt behind the serving core) lets no reader see a worker before the
/// restart's settlement of it: the reader waits, and then reads the worker as the settlement left it.
#[tokio::test]
async fn held_worker_rows_are_read_only_as_the_restart_settled_them() {
    let rig = Rig::new();
    let registry = Arc::new(rig.registry());
    registry.reload().await.unwrap();
    let header = session("s-a", "a", &at(NOW - HOUR), json!({}));
    let start = json!({ "status": "running", "turnStartedAt": at(NOW - 9_000), "runtimePid": PID + 1, "ownerSessionId": "lead" });
    registry.upsert_session_row(&header, "a", &obj(start));
    registry.hold_worker_rows();
    let reader = {
        let registry = registry.clone();
        tokio::spawn(async move { registry.pending_restart_failures().await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!reader.is_finished(), "a held row is not read before the settlement");
    let live = restart::Liveness { probe: &Dead, own_pid: PID, running: &|_| false, reap: &Hour, now_ms: NOW };
    assert!(registry.recover_held_worker_rows(true, &live).await.unwrap());
    let pending = reader.await.unwrap().unwrap();
    assert_eq!(pending.iter().map(|(id, row)| (id.as_str(), row["status"].clone())).collect::<Vec<_>>(), [("s-a", json!("failed"))]);
}

/// While the worker rows are held (the session of the stored tag `t` is not projected yet), a pool listing, a spawn naming
/// `t` and a spawn taking the next tag all wait: no tag is named, none is reserved. When the settlement then fails, all three
/// answer its failure and still take no tag, whether or not the registry had loaded the rows before; when it succeeds, the
/// pool lists the worker, `t` is refused as taken and the next tag is another.
async fn spawns_and_the_pool_over_held_worker_rows(fails: bool, warm: bool) {
    let rig = Rig::new();
    rig.store.write("s-t", Some(worker_row("s-t", "t", json!({}))));
    rig.store.sessions.lock().unwrap().push(session("s-t", "t", &at(NOW - HOUR), json!({})));
    rig.store.touch_sessions();
    let registry = Arc::new(rig.registry());
    if warm {
        registry.reload().await.unwrap();
    }
    registry.hold_worker_rows();
    let scope = lead("lead-a");
    let options = ResolveOptions { scan_sessions: false, exclude_terminal_traces: false, skip_released: true };
    let named = std::sync::atomic::AtomicUsize::new(0);
    let next = || {
        named.fetch_add(1, Ordering::SeqCst);
        registry.next_tag("worker", &scope)
    };
    let mut pool = Box::pin(registry.pool_index());
    let mut explicit = Box::pin(Registry::claim_tag(&*registry, "t", &scope, options, &next));
    let mut automatic = Box::pin(Registry::claim_tag(&*registry, "", &scope, options, &next));
    assert!(futures::poll!(pool.as_mut()).is_pending(), "the pool was listed from held rows");
    assert!(futures::poll!(explicit.as_mut()).is_pending(), "a spawn naming the tag was admitted over held rows");
    assert!(futures::poll!(automatic.as_mut()).is_pending(), "a spawn taking the next tag was admitted over held rows");
    let taken = || (named.load(Ordering::SeqCst), registry.claimed.lock().unwrap().len());
    assert_eq!(taken(), (0, 0), "a tag was named or reserved while the rows were held");

    rig.store.fail_maps.store(fails, Ordering::SeqCst);
    let live = restart::Liveness { probe: &Dead, own_pid: PID, running: &|_| false, reap: &Hour, now_ms: NOW };
    let settled = registry.recover_held_worker_rows(true, &live).await;
    // The store reads again afterwards: a failed settlement is not tried again by a reader of this start.
    rig.store.fail_maps.store(false, Ordering::SeqCst);
    if fails {
        let why = settled.expect_err("the settlement fails with the read of the worker maps");
        assert!(why.contains("index recovery failed"), "{why}");
        for (what, answer) in
            [("the pool", pool.await.map(drop)), ("the named spawn", explicit.await.map(drop)), ("the next-tag spawn", automatic.await.map(drop))]
        {
            let error = answer.expect_err(what);
            assert!(error.contains("index recovery failed") && !error.contains("already exists"), "{what}: {error}");
        }
        assert_eq!(taken(), (0, 0), "a tag was named or reserved after the settlement failed");
        return;
    }
    settled.unwrap();
    let (agents, _) = pool.await.unwrap();
    assert!(agents["workers"].to_string().contains("s-t"), "the pool lists the stored worker: {agents}");
    let refused = explicit.await.map(|claim| claim.tag.clone()).expect_err("the stored tag is taken");
    assert!(refused.contains("already exists"), "{refused}");
    let claim = automatic.await.unwrap();
    assert_ne!(claim.tag, "t", "the next tag reused the stored worker's");
}

#[tokio::test]
async fn a_failed_settlement_fails_the_pool_and_every_spawn_and_takes_no_tag() {
    spawns_and_the_pool_over_held_worker_rows(true, false).await;
}

#[tokio::test]
async fn a_failed_settlement_fails_the_pool_and_every_spawn_over_a_warm_registry_too() {
    spawns_and_the_pool_over_held_worker_rows(true, true).await;
}

#[tokio::test]
async fn a_settled_worker_is_in_the_pool_and_its_tag_is_given_to_no_spawn() {
    spawns_and_the_pool_over_held_worker_rows(false, false).await;
}

#[tokio::test]
async fn deleting_a_worker_session_clears_kept_memory_and_registry_state() {
    let rig = Rig::new();
    let registry = rig.registry();

    // Production order: a kept migrated Lead row is removed by `forget_row` before `store.forget_session` runs,
    // so `KeptMemory::forget` sees it gone and prunes its `changed`/`changed_at` entries.
    rig.store.keep("lead-dead", Some(obj(json!({ "sessionId": "lead-dead", "agent": "lead", "status": "idle" }))));
    rig.store.keep("w-live", Some(worker_row("w-live", "w2", json!({}))));
    let (r_before, _) = rig.store.kept_memory.lock().unwrap().since(None);
    assert_eq!(rig.store.kept_memory.lock().unwrap().changed_counts(), (2, 2));

    registry.parked.lock().unwrap().insert("lead-dead".to_owned());
    registry.cancelled.lock().unwrap().insert("lead-dead".to_owned());
    registry.restart_notices.lock().unwrap().insert(
        "restart:task-dead".to_owned(),
        restart::RestartNotice { session: "lead-dead".to_owned(), owner: "lead-1".to_owned(), stage: restart::NoticeStage::Stored },
    );
    registry.restart_notices.lock().unwrap().insert(
        "restart:task-owned-by-dead".to_owned(),
        restart::RestartNotice { session: "w-other".to_owned(), owner: "lead-dead".to_owned(), stage: restart::NoticeStage::Stored },
    );
    registry.restart_notices.lock().unwrap().insert(
        "restart:task-live".to_owned(),
        restart::RestartNotice { session: "w-live".to_owned(), owner: "lead-1".to_owned(), stage: restart::NoticeStage::Stored },
    );

    // Transient `reload()` failure must not erase restart-notice dedup entries while an unnotified row may remain in storage.
    rig.store.fail.store(true, Ordering::SeqCst);
    assert!(!registry.forget_deleted_session("lead-dead").await);
    assert!(registry.restart_notices.lock().unwrap().contains_key("restart:task-dead"), "transient reload failure keeps restart-notice dedup entry");
    assert!(
        registry.restart_notices.lock().unwrap().contains_key("restart:task-owned-by-dead"),
        "transient reload failure keeps owned restart-notice dedup entry"
    );

    // Once reload succeeds, `forget_row` removes the kept row before `store.forget_session` prunes `KeptMemory`,
    // and the dead session's restart-notice entries are cleared.
    rig.store.fail.store(false, Ordering::SeqCst);
    assert!(registry.forget_deleted_session("lead-dead").await);
    assert_eq!(
        rig.store.kept_memory.lock().unwrap().changed_counts(),
        (1, 1),
        "forgetting a deleted session removes its changed and changed_at entries after forget_row removes the kept row"
    );
    let (_, answer) = rig.store.kept_memory.lock().unwrap().since(Some(r_before));
    assert!(matches!(answer, super::store_workers::KeptSince::All(rows) if rows.len() == 1 && rows[0].0 == "w-live"));
    assert!(!registry.parked.lock().unwrap().contains("lead-dead"), "deleted session leaves parked");
    assert!(!registry.cancelled.lock().unwrap().contains("lead-dead"), "deleted session leaves cancelled");
    let notices = registry.restart_notices.lock().unwrap();
    assert!(!notices.contains_key("restart:task-dead"), "deleted session's restart notice is removed");
    assert!(!notices.contains_key("restart:task-owned-by-dead"), "deleted owner's restart notice is removed");
    assert!(notices.contains_key("restart:task-live"), "unrelated session's restart notice stays");
}

#[path = "release_receipt_tests.rs"]
mod release_receipt_tests;
