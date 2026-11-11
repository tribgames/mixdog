//! A private PostgreSQL cluster per replay (the shared `memory::tests::support::TestPg`, which reads `MIXDOG_PG_RUNTIME`,
//! starts in its own temp directory and stops the postmaster on drop; the temp directory goes with it), the memory schema
//! over it, and recorded rows written as `entries` rows. The cases that use it live in a `pg` module of their set
//! (nextest group `pg-cluster`).

use std::sync::Arc;
use std::time::Duration;

use mixdog_testkit::Exact;
use tokio_postgres::types::ToSql;

use crate::memory::pg::db::{Db, Schema};
use crate::memory::recall::period::Clock;
use crate::memory::recall::{Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

const START_DEADLINE: Duration = Duration::from_secs(120);

pub(crate) struct ReplayPg {
    pub db: Db,
    // Dropped after `db`: the cluster stops and its directory is removed.
    _pg: TestPg,
}

/// A fresh cluster with the memory schema.
pub(crate) async fn memory_db() -> ReplayPg {
    assert!(
        std::env::var_os("MIXDOG_PG_RUNTIME").is_some(),
        "MIXDOG_PG_RUNTIME is unset: it names the bundled PostgreSQL runtime the database replays start"
    );
    let pg = tokio::time::timeout(START_DEADLINE, TestPg::start())
        .await
        .unwrap_or_else(|_| panic!("the private PostgreSQL cluster did not start within {START_DEADLINE:?}"));
    let db = tokio::time::timeout(START_DEADLINE, async {
        let db = pg.db(Schema::Memory).await;
        ensure_memory_schema(&db, 384, &serde_json::json!({ "model": crate::memory::embed::config::DEFAULT_MODEL_ID }))
            .await
            .expect("memory schema");
        db
    })
    .await
    .unwrap_or_else(|_| panic!("the memory schema was not ready within {START_DEADLINE:?}"));
    ReplayPg { db, _pg: pg }
}

type Param = Box<dyn ToSql + Sync + Send>;

fn text(row: &Exact, key: &str) -> Option<String> {
    match row.try_get(key) {
        Some(Exact::String(s)) => Some(s.clone()),
        Some(Exact::Null | Exact::Undefined) | None => None,
        Some(other) => panic!("{key}: not a string: {other:?}"),
    }
}

fn number(row: &Exact, key: &str) -> Option<i64> {
    match row.try_get(key) {
        Some(Exact::Number(n)) if n.fract() == 0.0 => Some(*n as i64),
        Some(Exact::Null | Exact::Undefined) | None => None,
        Some(other) => panic!("{key}: not an integer: {other:?}"),
    }
}

/// Writes recorded row objects as `entries` rows with their own ids, then their links (a link may name a later row).
/// `source_ref` is `NOT NULL UNIQUE`: a row recorded without one gets `replay:<id>`, which no rendering reads as a
/// legacy reference.
pub(crate) async fn insert_entries(db: &Db, rows: &[&Exact]) {
    for row in rows {
        let id = number(row, "id").expect("a recorded row has an id");
        let params: Vec<Param> = vec![
            Box::new(id),
            Box::new(number(row, "ts").expect("a recorded row has a ts")),
            Box::new(text(row, "role").unwrap_or_default()),
            Box::new(text(row, "content").unwrap_or_default()),
            Box::new(text(row, "source_ref").unwrap_or_else(|| format!("replay:{id}"))),
            Box::new(text(row, "session_id")),
            Box::new(text(row, "project_id")),
            Box::new(number(row, "source_turn").map(|t| t as i32)),
            Box::new(text(row, "time_source")),
            Box::new(number(row, "is_root").unwrap_or(0) as i16),
            Box::new(text(row, "element")),
            Box::new(text(row, "category")),
            Box::new(text(row, "summary")),
            Box::new(text(row, "status")),
            Box::new(number(row, "last_seen_at")),
            Box::new(row.try_get("chunk_quality").filter(|v| !matches!(v, Exact::Null | Exact::Undefined)).map(|v| {
                v.to_plain().expect("a recorded chunk_quality is JSON")
            })),
        ];
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p.as_ref() as &(dyn ToSql + Sync)).collect();
        db.execute(
            "INSERT INTO entries (id, ts, role, content, source_ref, session_id, project_id, source_turn, time_source, is_root,
               element, category, summary, status, last_seen_at, chunk_quality)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text::entry_status,$15,$16)",
            &refs,
        )
        .await
        .unwrap_or_else(|e| panic!("insert entry {id}: {}", e.message()));
    }
    for row in rows {
        let id = number(row, "id");
        let links = (number(row, "chunk_root"), number(row, "duplicate_of"), number(row, "concept_id"), number(row, "supersedes_id"));
        db.execute(
            "UPDATE entries SET chunk_root = $2, duplicate_of = $3, concept_id = $4, supersedes_id = $5 WHERE id = $1",
            &[&id, &links.0, &links.1, &links.2, &links.3],
        )
        .await
        .unwrap_or_else(|e| panic!("link entry {id:?}: {}", e.message()));
    }
    db.query("SELECT setval(pg_get_serial_sequence('entries','id'), (SELECT max(id) FROM entries))", &[])
        .await
        .expect("sequence");
}

/// The recall the `memory/recall` request reaches, at the recorded clock in UTC, with no embedder.
pub(crate) fn recall(db: &Db, now_ms: i64) -> Recall {
    Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(move || Clock { now_ms, zone: chrono_tz::UTC }),
        embedder: None,
        session_cwd: None,
        lane: mixdog_rt::testing::tokens().durability_io,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    })
}
