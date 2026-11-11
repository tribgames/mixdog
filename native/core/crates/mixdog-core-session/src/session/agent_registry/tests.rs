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

/// The status-signal scenario of the Node daemon's profile (`status-pulse.test.mjs` "activity bursts over a large unchanged
/// index"): one Lead, 300 worker rows (30 running, 270 finished and kept for the day) with their stored sessions, 500 tag
/// tombstones, and 30 loaded threads (the Lead and 29 running workers).
struct Crowd {
    registry: AgentRegistry,
    /// The scope of every loaded thread, as `AgentToolStatus::status` reads it.
    scopes: Vec<Scope>,
    /// A running worker's session record and tag.
    running: Vec<(Row, String)>,
}

const LOADED: usize = 30;

fn crowd_rig() -> Crowd {
    let rig = Rig::new();
    let scope_of = |id: &str| Scope { caller_session_id: Some(id.to_owned()), host_pid: Some(PID) };
    let mut stored = Vec::new();
    let mut running = Vec::new();
    rig.live.headers.lock().unwrap().insert("lead-a".into(), obj(json!({ "status": "idle", "clientHostPid": PID })));
    let mut scopes = vec![scope_of("lead-a")];
    for i in 0..300 {
        let busy = i < 30;
        let (id, tag) = if busy { (format!("s-run-{i}"), format!("r{i}")) } else { (format!("s-done-{i}"), format!("d{i}")) };
        let (status, created, updated) = if busy { ("running", NOW - HOUR, NOW - 60_000) } else { ("completed", NOW - 3 * HOUR, NOW - 2 * HOUR) };
        let mut row = worker_row(&id, &tag, json!({ "status": status, "stage": status, "createdAt": at(created), "updatedAt": at(updated), "cwd": "/w" }));
        if !busy {
            row.insert("finishedAt".into(), json!(at(updated)));
        }
        rig.store.write(&id, Some(row));
        let session = session(&id, &tag, &at(created), json!({ "status": if busy { "running" } else { "idle" }, "updatedAt": at(updated), "cwd": "/w" }));
        if busy && i < LOADED - 1 {
            rig.live.headers.lock().unwrap().insert(id.clone(), session.clone());
            scopes.push(scope_of(&id));
        }
        if busy {
            running.push((session.clone(), tag));
        }
        stored.push(session);
    }
    *rig.store.sessions.lock().unwrap() = stored;
    for i in 0..500 {
        let gone = obj(json!({ "tombstone": tombstone(&format!("g{i}"), &at(NOW - HOUR - i), json!({})) }));
        rig.store.write(&format!("s-gone-{i}"), without_row(&gone));
    }
    let registry = rig.registry();
    Crowd { registry, scopes, running }
}

/// What one loaded thread's status re-read asks of the registry (`AgentToolStatus::status`) once the index is loaded: the
/// refresh, then the scope's agents. The tags it lists.
fn status_read(registry: &AgentRegistry, scope: &Scope) -> Vec<String> {
    let mut st = registry.lock();
    registry.refresh(&mut st, false, scope);
    drop(st);
    registry.status_entries(scope).iter().map(|(tag, _)| tag.clone()).collect()
}

/// A status signal: every loaded thread re-reads its status (`AgentActivity::everyone`), over one load of the index.
async fn signal(crowd: &Crowd) -> Vec<Vec<String>> {
    crowd.registry.reload().await;
    crowd.scopes.iter().map(|scope| status_read(&crowd.registry, scope)).collect()
}

/// The per-row, per-tombstone and per-tag operations a status signal may cost: what the loaded threads hold (each thread's
/// re-read reads the live sessions behind the loaded tags again, as their live state has no version), never the finished
/// rows or the tombstones.
fn signal_budget() -> usize {
    6 * LOADED * LOADED + 8 * LOADED
}

/// The work of a status signal is what changed, not the size of the index: 1,000 signals over an unchanged index, and 1,000
/// single-row writes (one worker's stage change, each followed by its signal), stay within what the loaded threads cost,
/// while every re-read answers what it answered before.
#[tokio::test]
async fn a_status_signal_costs_what_changed_not_the_finished_rows_and_tombstones() {
    let crowd = crowd_rig();
    let first = signal(&crowd).await;
    assert_eq!(first[0].len(), 30, "the Lead's status lists its working agents");
    assert!(first[1..].iter().all(Vec::is_empty), "a worker has no agents of its own");

    let start = rows::work::counts().total();
    for n in 1..=1000 {
        assert_eq!(signal(&crowd).await, first);
        let spent = rows::work::counts().total() - start;
        assert!(spent <= n * signal_budget(), "{n} signal(s) over an unchanged index did {spent} operations (budget {} each)", signal_budget());
    }
    let unchanged = rows::work::counts().total() - start;

    let start = rows::work::counts().total();
    for n in 1..=1000 {
        let (session, tag) = &crowd.running[n % crowd.running.len()];
        let stage = if n % 2 == 0 { "streaming" } else { "tool_running" };
        crowd.registry.upsert_worker_row(session, tag, &obj(json!({ "status": "running", "stage": stage })));
        let read = signal(&crowd).await;
        assert_eq!(read[0].len(), 30);
        let spent = rows::work::counts().total() - start;
        assert!(spent <= n * (signal_budget() + 64), "{n} write(s) did {spent} operations (budget {} each)", signal_budget() + 64);
    }
    let written = rows::work::counts().total() - start;
    eprintln!("status signal work: 1,000 signals {unchanged} operations; 1,000 single-row writes {written} operations");
    let st = crowd.registry.lock();
    let stages: Vec<String> = st.rows(&lead("lead-a"), crowd.registry.now()).iter().filter(|r| r["status"] == "running").map(|r| clean(r.get("stage"))).collect();
    assert_eq!(stages.len(), 30);
    assert!(stages.iter().all(|s| s == "streaming" || s == "tool_running"), "{stages:?}");
}

// ---- the reads before the views, as the reference ------------------------------------------

/// `readAllWorkerRows` as the registry computed it before its views (`State::all_rows`, uncached).
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

/// `agentSessionEntries({ context })` as listed before.
fn old_entries(registry: &AgentRegistry, st: &State, scope: &Scope, now: f64) -> Vec<(String, Row)> {
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
fn check_reads(registry: &AgentRegistry, scope: &Scope, label: &str) {
    let now = registry.now();
    {
        let st = registry.lock();
        assert_eq!(*st.all_rows(now), old_all_rows(&st, now), "all rows, {label}");
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

/// For random sequences of writes (this process's and another's), expiries, loads and reads, every read of the views, every
/// refresh and every listing answers what the reads made before the views answered over the same index.
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
            }
            if i % 4 == 0 {
                rig.live.headers.lock().unwrap().insert(id.clone(), stored(id, tag, owner, status));
            }
        }
        let future = obj(json!({ "tombstone": tombstone("t1", &at(NOW + 2 * HOUR), json!({})) }));
        rig.store.write("s-future", without_row(&future));
        let registry = rig.registry();
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
            match dice.below(12) {
                0 | 1 => registry.upsert_worker_row(&stored(&id, &tag, &owner, status), &tag, &obj(json!({ "status": status, "stage": status }))),
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
                _ => {
                    if dice.below(2) == 0 {
                        registry.bind_tag(&tag, &session_facts(&stored(&id, &tag, &owner, status)), &at(registry.now() as i64));
                    } else {
                        registry.unbind_tag(&tag);
                    }
                }
            }
            for _ in 0..2 {
                let scope = dice.pick(&scopes).clone();
                check_reads(&registry, &scope, &format!("seed {seed} step {step} scope {scope:?}"));
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
