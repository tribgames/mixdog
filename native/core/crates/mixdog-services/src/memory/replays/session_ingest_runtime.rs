//! memory-session-ingest-runtime: `SessionIngest::ingest_session` (the `ingest_session` action) over a private cluster
//! (module `pg`), one test per recorded case.
//!
//! Compared per case: each call's reply text, the entries statements in order (text and params, observed under
//! `cfg(test)` where the core sends them; Node's texts are the core's byte for byte), the rows after the steps that
//! recorded them, the row count, the flush calls in order (`flushRawEmbeddings` options `{limit, ids}` ↔
//! `RawEmbedFlush::flush(limit, ids)`, observed under `cfg(test)`), and the saved high-water.
//!
//! Mappings:
//! - A row id is the database's: the test file's stand-in numbers a stored row by the count of rows stored, while
//!   PostgreSQL's serial also advances on an insert that conflicts. Ids (in rows and in flush calls) are compared as
//!   the row's rank among the stored rows, which is the stand-in's number.
//! - The durable high-water is Node's injected `loadOrdinalHighWater` / `saveOrdinalHighWater` (the facade's `meta`
//!   key-value; the test file's hooks record the save and hand it to the restarted runtime); in the core it is the
//!   `meta` row `state.session_ingest_ordinals.<session>`, which the restarted `SessionIngest` reads. `savedAfter` is
//!   compared with that row after its step, and the case's `saved` (the saves of the runtime Node gave the save hook,
//!   the first one: its restarted runtime has only the load hook) with that row when the first runtime is replaced.
//!   A case whose runtime Node built without the hooks records no save.
//! - A runtime "restart" is a new `SessionIngest` over the same database and the database's one flusher
//!   (`MemoryStack::embed_flush`), as the daemon builds it.
//! - Node's background flushes are awaited by the recorder before it reads them; here `SessionIngest::settle` (with a
//!   deadline) after each call, so the calls' flushes are logged in call order.

use std::sync::Arc;
use std::time::Duration;

use mixdog_testkit::Exact;
use serde_json::Value;

use super::{assert_case_count, case, golden, int, object, string};
use crate::memory::ingest::SessionIngest;
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::replays::pg::{ReplayPg, memory_db};

const SET: &str = "memory-session-ingest-runtime";
const DEADLINE: Duration = Duration::from_secs(30);

struct Run {
    pg: ReplayPg,
    flush: Arc<RawEmbedFlush>,
    now_ms: i64,
    /// Every runtime made so far; the statements are theirs, concatenated in step order.
    statements: Vec<Exact>,
    seen: usize,
}

impl Run {
    async fn new(g: &Exact) -> Self {
        let pg = memory_db().await;
        let flush = Arc::new(RawEmbedFlush::new(pg.db.clone(), None));
        Self { pg, flush, now_ms: g.get("clock").get("dateNowMs").as_f64() as i64, statements: Vec::new(), seen: 0 }
    }

    fn runtime(&mut self) -> SessionIngest {
        self.seen = 0;
        let now = self.now_ms;
        SessionIngest::new(
            self.pg.db.clone(),
            Arc::clone(&self.flush),
            None,
            Arc::new(move || now),
            mixdog_rt::testing::tokens().durability_io,
        )
    }

    async fn call(&mut self, runtime: &SessionIngest, what: &str, step: &Exact) {
        let args = step.get("args").to_plain().expect("JSON args");
        let reply = tokio::time::timeout(DEADLINE, runtime.ingest_session(&args))
            .await
            .unwrap_or_else(|_| panic!("{what}: the ingest did not settle within 30 s"))
            .unwrap_or_else(|e| panic!("{what}: {e}"));
        tokio::time::timeout(DEADLINE, runtime.settle())
            .await
            .unwrap_or_else(|_| panic!("{what}: the background flushes did not settle within 30 s"));
        assert_eq!(&Exact::plain(&serde_json::json!({ "text": reply })), step.get("result"), "{what}: result");
        let sent = runtime.statements();
        for (sql, params) in &sent[self.seen..] {
            self.statements.push(object(vec![("sql", string(*sql)), ("params", Exact::plain(params))]));
        }
        self.seen = sent.len();
        if let Some(rows) = step.try_get("rows") {
            assert_eq!(rows, &self.rows().await, "{what}: rows");
        }
        if let Some(count) = step.try_get("rowCount") {
            assert_eq!(count, &int(self.rows().await.as_array().len() as i64), "{what}: rowCount");
        }
        if let Some(saved) = step.try_get("savedAfter") {
            assert_eq!(saved, &self.saved(&args).await, "{what}: savedAfter");
        }
        if let Some(flushes) = step.try_get("flushes") {
            assert_eq!(flushes, &self.take_flushes().await, "{what}: flushes");
        }
    }

    async fn ids(&self) -> Vec<i64> {
        let rows = self.pg.db.query("SELECT id FROM entries ORDER BY id", &[]).await.expect("ids");
        rows.iter().map(|r| r.get::<_, i64>(0)).collect()
    }

    fn rank(ids: &[i64], id: i64) -> i64 {
        ids.iter().position(|&i| i == id).unwrap_or_else(|| panic!("no stored row {id}")) as i64 + 1
    }

    async fn rows(&self) -> Exact {
        let ids = self.ids().await;
        let rows = self
            .pg
            .db
            .query("SELECT id, ts, role, content, source_ref, source_turn, time_source FROM entries ORDER BY id", &[])
            .await
            .expect("rows");
        Exact::Array(
            rows.iter()
                .map(|r| {
                    object(vec![
                        ("id", int(Self::rank(&ids, r.get(0)))),
                        ("ts", int(r.get(1))),
                        ("role", string(r.get::<_, String>(2))),
                        ("content", string(r.get::<_, String>(3))),
                        ("source_ref", string(r.get::<_, String>(4))),
                        ("source_turn", int(i64::from(r.get::<_, i32>(5)))),
                        ("time_source", string(r.get::<_, String>(6))),
                    ])
                })
                .collect(),
        )
    }

    async fn saved(&self, args: &Value) -> Exact {
        let session = args["sessionId"].as_str().expect("sessionId");
        let stored = crate::memory::schema::get_meta(&self.pg.db, &format!("state.session_ingest_ordinals.{session}"))
            .await
            .expect("meta");
        Exact::Array(stored.into_iter().map(|map| Exact::Array(vec![string(session), Exact::plain(&map)])).collect())
    }

    async fn take_flushes(&self) -> Exact {
        let ids = self.ids().await;
        let calls: Vec<_> = std::mem::take(&mut *self.flush.calls.lock().expect("flush calls"));
        Exact::Array(
            calls
                .into_iter()
                .map(|(limit, scoped)| {
                    let mut entries = vec![("limit", int(limit as i64))];
                    if let Some(scoped) = scoped {
                        entries.push(("ids", Exact::Array(scoped.iter().map(|&id| int(Self::rank(&ids, id))).collect())));
                    }
                    object(entries)
                })
                .collect(),
        )
    }
}

/// The steps of one case, with a fresh runtime at the steps the recorder made one (`restarts`), then the case-level
/// flushes, statements and saves.
async fn replay(index: usize, name: &str, restarts: &[usize]) {
    let g = golden(SET);
    let c = case(&g, index, name);
    let mut run = Run::new(&g).await;
    let first_args = c.get("steps").as_array()[0].get("args").to_plain().expect("args");
    let mut runtime = run.runtime();
    let mut hooked_saved = None;
    for (at, step) in c.get("steps").as_array().iter().enumerate() {
        if restarts.contains(&at) {
            hooked_saved.get_or_insert(run.saved(&first_args).await);
            runtime = run.runtime();
        }
        let phase = step.try_get("phase").map_or(String::new(), |p| format!(" ({})", p.as_str()));
        run.call(&runtime, &format!("{name}: step {at}{phase}"), step).await;
    }
    if let Some(flushes) = c.try_get("flushes") {
        assert_eq!(flushes, &run.take_flushes().await, "{name}: flushes");
    }
    if let Some(saved) = c.try_get("saved") {
        let at_end = run.saved(&first_args).await;
        assert_eq!(saved, hooked_saved.as_ref().unwrap_or(&at_end), "{name}: saved");
    }
    assert_eq!(c.get("statements"), &Exact::Array(run.statements), "{name}: statements");
}

#[test]
fn the_recording_has_six_cases() {
    assert_case_count(&golden(SET), 6);
}

mod pg {
    use super::replay;

    #[tokio::test(flavor = "multi_thread")]
    async fn a_re_ingest_of_the_same_array_inserts_nothing_timestamped_rows_keep_their_recorded_time() {
        replay(0, "a re-ingest of the same array inserts nothing; timestamped rows keep their recorded time (test line 53)", &[]).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn identical_untimestamped_turns_are_distinct_rows_and_a_json_cloned_replay_stays_idempotent() {
        replay(1, "identical untimestamped turns are distinct rows, and a JSON-cloned replay stays idempotent (test line 71)", &[]).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn after_compaction_dropped_an_identical_copy_a_genuine_append_still_lands_above_the_persisted_rows() {
        replay(2, "after compaction dropped an identical copy, a genuine append still lands above the persisted rows (test line 87)", &[])
            .await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_subset_re_ingest_reproduces_the_full_ingest_identities() {
        replay(3, "a subset re-ingest (limit) reproduces the full-ingest identities (test line 100)", &[1]).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_durable_untimestamped_high_water_is_saved_when_a_repeat_appears_and_lifts_a_warm_append_after_restart() {
        replay(
            4,
            "the durable untimestamped high-water is saved when a repeat appears and lifts a warm append after restart (test line 111)",
            &[1],
        )
        .await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn excluded_and_empty_messages_are_skipped_the_flush_is_scoped_to_this_call_and_then_sweeps_the_backlog() {
        replay(5, "excluded and empty messages are skipped; the flush is scoped to this call and then sweeps the backlog (test line 134)", &[])
            .await;
    }
}
