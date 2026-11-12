//! Recall against goldens recorded from the Node product: the same seeded
//! history (rows and embeddings from `seed.json`), the same frozen clock, and
//! the real embedding model for query vectors. Needs `MIXDOG_PG_RUNTIME`,
//! `MIXDOG_MEMORY_MODELS` and `MIXDOG_ORT_LIBRARY`.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio_postgres::types::ToSql;

use crate::memory::embed::engine::EmbedConfig;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::pg::db::{Db, Schema};
use crate::memory::recall::period::Clock;
use crate::memory::recall::{QueryEmbedder, Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

pub(super) const SEED: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/tools/memory/recall/seed.json");
pub(super) const CASES: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/tools/memory/recall/cases.json");

type Param<'a> = &'a (dyn ToSql + Sync);

pub(super) async fn load_seed(db: &Db, seed: &Value) {
    for e in seed["entries"].as_array().expect("entries") {
        let text = |k: &str| e[k].as_str().map(str::to_owned);
        let int = |k: &str| e[k].as_i64();
        let (id, ts, role, content, source_ref) = (int("id"), int("ts"), text("role"), text("content"), text("source_ref"));
        let (session, project, turn) = (text("session_id"), text("project_id"), int("source_turn").map(|v| v as i32));
        let (time_source, is_root) = (text("time_source"), e["is_root"].as_i64().map(|v| v as i16));
        let (element, category, summary, status) = (text("element"), text("category"), text("summary"), text("status"));
        let (last_seen, embedding) = (int("last_seen_at"), text("embedding"));
        let params: [Param; 16] = [
            &id, &ts, &role, &content, &source_ref, &session, &project, &turn, &time_source, &is_root, &element,
            &category, &summary, &status, &last_seen, &embedding,
        ];
        db.execute(
            "INSERT INTO entries (id, ts, role, content, source_ref, session_id, project_id, source_turn, time_source,
               is_root, element, category, summary, status, last_seen_at, embedding)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text::entry_status,$15,$16::text::halfvec)",
            &params,
        )
        .await
        .expect("insert entry");
    }
    for e in seed["entries"].as_array().expect("entries") {
        let (id, chunk_root, duplicate_of) = (e["id"].as_i64(), e["chunk_root"].as_i64(), e["duplicate_of"].as_i64());
        let (concept, supersedes, score) = (e["concept_id"].as_i64(), e["supersedes_id"].as_i64(), e["score"].as_f64().map(|v| v as f32));
        let params: [Param; 5] = [&id, &chunk_root, &duplicate_of, &concept, &supersedes];
        db.execute(
            "UPDATE entries SET chunk_root = $2, duplicate_of = $3, concept_id = $4, supersedes_id = $5 WHERE id = $1",
            &params,
        )
        .await
        .expect("link entry");
        if score.is_some() {
            db.execute("UPDATE entries SET score = $2 WHERE id = $1", &[&id, &score]).await.expect("score");
        }
    }
    let next = seed["entries"].as_array().expect("entries").len() as i64 + 1;
    db.query("SELECT setval(pg_get_serial_sequence('entries','id'), $1)", &[&next]).await.expect("sequence");
    for r in seed["relations"].as_array().expect("relations") {
        let (entry, concept, supersedes, created) =
            (r["entry_id"].as_i64(), r["concept_id"].as_i64(), r["supersedes_id"].as_i64(), r["created_at"].as_i64());
        db.execute(
            "INSERT INTO entry_concepts(entry_id, concept_id, supersedes_id, created_at) VALUES ($1,$2,$3,$4)",
            &[&entry, &concept, &supersedes, &created],
        )
        .await
        .expect("relation");
    }
    for c in seed["core"].as_array().expect("core") {
        let text = |k: &str| c[k].as_str().map(str::to_owned);
        let (element, summary, category, project, agent) = (text("element"), text("summary"), text("category"), text("project_id"), text("agent_id"));
        let (created, updated) = (c["created_at"].as_i64(), c["updated_at"].as_i64());
        db.execute(
            "INSERT INTO core_entries(element, summary, category, project_id, agent_id, created_at, updated_at, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'active')",
            &[&element, &summary, &category, &project, &agent, &created, &updated],
        )
        .await
        .expect("core entry");
    }
}

/// The provider as the product's recall asks it: through `RecallEmbedder` (memory/boot.rs), its bounded cold wait.
pub(super) struct Provider(pub(super) Arc<EmbeddingProvider>);

#[async_trait]
impl QueryEmbedder for Provider {
    async fn query_vector(&self, text: &str, cancel: &tokio_util::sync::CancellationToken) -> crate::memory::error::Result<Option<Vec<f32>>> {
        crate::memory::recall::readiness::RecallEmbedder::new(self.0.clone(), false).query_vector(text, cancel).await
    }
}

fn first_difference(expected: &str, got: &str) -> String {
    let (e, g): (Vec<&str>, Vec<&str>) = (expected.lines().collect(), got.lines().collect());
    for i in 0..e.len().max(g.len()) {
        if e.get(i) != g.get(i) {
            return format!("line {i}\n  want: {:?}\n  got:  {:?}", e.get(i), g.get(i));
        }
    }
    "identical lines, different ends".into()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME), the staged ONNX Runtime (MIXDOG_ORT_LIBRARY) and the e5 files (MIXDOG_MEMORY_MODELS)"]
async fn recall_matches_recorded_goldens() {
    let seed: Value = serde_json::from_str(&SEED).expect("seed");
    let cases: Vec<Value> = serde_json::from_str(&CASES).expect("cases");
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &serde_json::json!({ "model": "Xenova/multilingual-e5-small" })).await.expect("schema");
    load_seed(&db, &seed).await;

    let provider = Arc::new(EmbeddingProvider::new(EmbedConfig {
        model_id: crate::memory::embed::config::DEFAULT_MODEL_ID.into(),
        cache_dir: PathBuf::from(std::env::var_os("MIXDOG_MEMORY_MODELS").expect("MIXDOG_MEMORY_MODELS")),
        ort_library: PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY")),
        dtype: None,
        sessions: 2,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    }));
    provider.warmup().await.expect("embedding model loads").expect("embedding model installed");
    let now_ms = seed["now"].as_i64().expect("now");
    let recall = Recall::new(RecallDeps {
        db,
        clock: Arc::new(move || Clock { now_ms, zone: chrono_tz::Asia::Seoul }),
        embedder: Some(Arc::new(Provider(provider))),
        session_cwd: None,
        lane: mixdog_rt::testing::tokens().durability_io,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });

    let mut failures = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().expect("name");
        let outcome = match case["tool"].as_str() {
            Some("search_memories") => recall.search_memories(&case["args"], &tokio_util::sync::CancellationToken::new()).await,
            _ => recall.recall_cancellable(&case["args"], &tokio_util::sync::CancellationToken::new()).await,
        };
        let expected = case["text"].as_str().expect("text");
        if outcome.text != expected {
            failures.push(format!("{name}: {}", first_difference(expected, &outcome.text)));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
}
