//! `ingest_session` against the golden recorded from the Node product: the
//! same ten calls in order over one temp database, with the frozen clock and
//! the real embedding model. After every call the stored rows (ids, times,
//! turns, references, whether embedded) and the durable ordinal map must equal
//! what Node left. Needs `MIXDOG_PG_RUNTIME`, `MIXDOG_MEMORY_MODELS` and
//! `MIXDOG_ORT_LIBRARY`.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::memory::embed::engine::EmbedConfig;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::ingest::SessionIngest;
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::pg::db::{Db, Schema};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/tools/memory/ingest/golden.json");

fn provider() -> Arc<EmbeddingProvider> {
    Arc::new(EmbeddingProvider::new(EmbedConfig {
        model_id: crate::memory::embed::config::DEFAULT_MODEL_ID.into(),
        cache_dir: PathBuf::from(std::env::var_os("MIXDOG_MEMORY_MODELS").expect("MIXDOG_MEMORY_MODELS")),
        ort_library: PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY")),
        dtype: None,
        sessions: 2,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    }))
}

async fn stored_rows(db: &Db) -> Value {
    let rows = db
        .query(
            "SELECT id, ts, role, content, source_ref, session_id, source_turn, project_id, time_source,
                    (embedding IS NOT NULL) FROM entries ORDER BY id",
            &[],
        )
        .await
        .expect("rows");
    Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": r.get::<_, i64>(0), "ts": r.get::<_, i64>(1), "role": r.get::<_, String>(2),
                    "content": r.get::<_, String>(3), "source_ref": r.get::<_, String>(4),
                    "session_id": r.get::<_, Option<String>>(5), "source_turn": r.get::<_, Option<i32>>(6),
                    "project_id": r.get::<_, Option<String>>(7), "time_source": r.get::<_, Option<String>>(8),
                    "embedded": r.get::<_, bool>(9),
                })
            })
            .collect(),
    )
}

async fn stored_ordinals(db: &Db) -> Value {
    let rows = db
        .query("SELECT key, value FROM meta WHERE key LIKE 'state.session_ingest_ordinals.%' ORDER BY key", &[])
        .await
        .expect("meta");
    Value::Object(rows.iter().map(|r| (r.get::<_, String>(0), r.get::<_, Value>(1))).collect())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME), the staged ONNX Runtime (MIXDOG_ORT_LIBRARY) and the e5 files (MIXDOG_MEMORY_MODELS)"]
async fn ingest_session_matches_the_recorded_node_runs() {
    let golden: Value = serde_json::from_str(&GOLDEN).expect("golden");
    let now = golden["now"].as_i64().expect("now");
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "Xenova/multilingual-e5-small" })).await.expect("schema");
    let provider = provider();
    provider.warmup().await.expect("model loads").expect("model installed");
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), Some(provider))), None, Arc::new(move || now), mixdog_rt::testing::tokens().durability_io);

    let mut failures = Vec::new();
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let mut args = case["args"].clone();
        args["action"] = json!("ingest_session");
        let text = ingest.ingest_session(&args).await.expect("ingest");
        ingest.settle().await;
        if text != case["text"].as_str().expect("text") {
            failures.push(format!("{name}: text {text:?} != {:?}", case["text"]));
        }
        let rows = stored_rows(&db).await;
        if rows != case["rows"] {
            let first = rows
                .as_array()
                .unwrap()
                .iter()
                .zip(case["rows"].as_array().unwrap())
                .find(|(a, b)| a != b)
                .map(|(a, b)| format!("got {a} want {b}"))
                .unwrap_or_else(|| format!("{} rows, want {}", rows.as_array().unwrap().len(), case["rows"].as_array().unwrap().len()));
            failures.push(format!("{name}: rows differ: {first}"));
        }
        let ordinals = stored_ordinals(&db).await;
        if ordinals != case["ordinals"] {
            failures.push(format!("{name}: ordinals {ordinals} != {}", case["ordinals"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
