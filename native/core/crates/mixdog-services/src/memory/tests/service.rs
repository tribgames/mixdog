//! The recall composition (which source answers, in which order, with which
//! arguments) against the Node product, and the PG-backed memory module
//! against the recall goldens.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_core_api::{CoreRequest, DomainService, Reply};
use serde_json::{Value, json};

use super::recall::{CASES, Provider, SEED, load_seed};
use crate::memory::embed::engine::EmbedConfig;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::ingest::SessionIngest;
use crate::memory::pg::db::Schema;
use crate::memory::recall::period::Clock;
use crate::memory::recall::{Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::service::{LocalMemory, MemoryModule, MemoryService, SessionData, SessionSource};
use crate::memory::tests::support::TestPg;

const COMPOSITION: &str = include_str!("../../../../../fixtures/tools/memory/service/recall.json");

#[derive(Default)]
struct FakeMemory {
    calls: Mutex<Vec<Value>>,
    results: Mutex<VecDeque<String>>,
}

#[async_trait]
impl MemoryModule for FakeMemory {
    async fn memory(&self, args: Value) -> String {
        self.calls.lock().expect("calls").push(json!(["memory", args]));
        "ingest_session: considered=1 inserted=1".into()
    }

    async fn recall(&self, args: Value, _: &tokio_util::sync::CancellationToken) -> String {
        self.calls.lock().expect("calls").push(json!(["recall", args]));
        self.results.lock().expect("results").pop_front().unwrap_or_else(|| "(no results)".into())
    }
}

struct Sessions {
    session: Option<SessionData>,
    cwd: Option<String>,
    title: String,
}

#[async_trait]
impl SessionSource for Sessions {
    async fn session(&self, _thread_id: Option<&str>) -> Option<SessionData> {
        self.session.clone()
    }

    async fn current_cwd(&self, _thread_id: Option<&str>) -> Option<String> {
        self.cwd.clone()
    }

    async fn profile_title(&self) -> String {
        self.title.clone()
    }
}

fn request(params: Value) -> CoreRequest {
    CoreRequest { method: Method("memory/recall"), params, op: None, ctx: CallContext::internal("test") }
}

async fn ask(service: &MemoryService, params: Value) -> String {
    match service.call(request(params)).await.expect("answers") {
        Reply::Value(Value::String(text)) => text,
        _ => panic!("a recall answers with text"),
    }
}

#[tokio::test]
async fn the_answer_order_and_memory_calls_match_the_node_product() {
    let scenarios: Vec<Value> = serde_json::from_str(COMPOSITION).expect("golden parses");
    assert!(scenarios.len() >= 16);
    for scenario in &scenarios {
        let name = scenario["name"].as_str().expect("name");
        let session = scenario["session"].as_object().map(|s| SessionData {
            id: s["id"].as_str().expect("id").to_owned(),
            messages: s["messages"].as_array().expect("messages").clone(),
        });
        let memory = Arc::new(FakeMemory {
            results: Mutex::new(scenario["results"].as_array().expect("results").iter().filter_map(|r| r.as_str().map(str::to_owned)).collect()),
            ..FakeMemory::default()
        });
        let sessions = Sessions {
            session,
            cwd: Some("/work/current".into()),
            title: scenario["title"].as_str().unwrap_or_default().to_owned(),
        };
        let service = MemoryService::new(memory.clone(), Arc::new(sessions));
        let answer = ask(&service, json!({ "query": scenario["query"], "args": scenario["args"] })).await;
        assert_eq!(answer, scenario["answer"].as_str().expect("answer"), "{name}: answer");
        assert_eq!(Value::Array(memory.calls.lock().expect("calls").clone()), scenario["calls"], "{name}: memory calls");
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME), the staged ONNX Runtime (MIXDOG_ORT_LIBRARY) and the e5 files (MIXDOG_MEMORY_MODELS)"]
async fn over_the_pg_module_a_session_less_recall_equals_the_recorded_recall_goldens() {
    let seed: Value = serde_json::from_str(&SEED).expect("seed");
    let cases: Vec<Value> = serde_json::from_str(&CASES).expect("cases");
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "Xenova/multilingual-e5-small" })).await.expect("schema");
    load_seed(&db, &seed).await;
    let provider = Arc::new(EmbeddingProvider::new(EmbedConfig {
        model_id: crate::memory::embed::config::DEFAULT_MODEL_ID.into(),
        cache_dir: std::path::PathBuf::from(std::env::var_os("MIXDOG_MEMORY_MODELS").expect("MIXDOG_MEMORY_MODELS")),
        ort_library: std::path::PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY")),
        dtype: None,
        sessions: 2,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    }));
    provider.warmup().await.expect("model loads").expect("model installed");
    let now_ms = seed["now"].as_i64().expect("now");
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(move || Clock { now_ms, zone: chrono_tz::Asia::Seoul }),
        embedder: Some(Arc::new(Provider(provider))),
        session_cwd: None,
        lane: mixdog_rt::testing::tokens().durability_io,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    // The seed's clock is the store's clock too: what the service ingests is stamped at the recall's `now`.
    let seed_now: crate::memory::ingest::NowMs = Arc::new(move || now_ms);
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), None)), None, seed_now.clone(), mixdog_rt::testing::tokens().durability_io);
    let memory = Arc::new(LocalMemory::new(db, pg.dir.path().join("data"), recall.clone(), ingest, mixdog_rt::testing::tokens().durability_io));
    let service = MemoryService::new(memory, Arc::new(Sessions { session: None, cwd: None, title: String::new() }));

    // The composition adds `query` to the arguments, so cases that already carry one are the
    // ones whose arguments pass through unchanged.
    let mut compared = 0;
    for case in cases.iter().filter(|c| c["tool"].as_str() != Some("search_memories")) {
        let Some(query) = case["args"]["query"].as_str().filter(|q| !q.is_empty() && !crate::memory::service::is_identity_query(q)) else {
            continue;
        };
        let answer = ask(&service, json!({ "query": query, "args": case["args"] })).await;
        assert_eq!(answer, case["text"].as_str().expect("text"), "{}", case["name"]);
        compared += 1;
    }
    assert!(compared >= 10, "{compared}");

    // With a live session whose own messages do not match, the service ingests the session and then runs the scoped recall, in the order of the Node
    // product's calls (`calls[0]` the `ingest_session`, `calls[1]` the recall): its answer is the recall of the arguments Node sent, over the store as that
    // ingest left it.
    let scenarios: Vec<Value> = serde_json::from_str(COMPOSITION).expect("golden");
    let scoped = scenarios.iter().find(|s| s["name"] == "no-own-match-ingests-then-scoped").expect("scenario");
    let session_id = seed["entries"][0]["session_id"].as_str().expect("seeded session").to_owned();
    let sessions = Sessions {
        session: Some(SessionData { id: session_id.clone(), messages: vec![json!({ "role": "user", "content": "nothing alike" })] }),
        cwd: Some("/work/current".into()),
        title: String::new(),
    };
    let scoped_db = service_db(&pg).await;
    let ingest = SessionIngest::new(scoped_db.clone(), Arc::new(RawEmbedFlush::new(scoped_db.clone(), None)), None, seed_now, mixdog_rt::testing::tokens().durability_io);
    let service = MemoryService::new(
        Arc::new(LocalMemory::new(scoped_db, pg.dir.path().join("data"), recall.clone(), ingest, mixdog_rt::testing::tokens().durability_io)),
        Arc::new(sessions),
    );
    let mut expected_args = scoped["calls"][1][1].clone();
    expected_args["query"] = json!("zzz unrelated");
    expected_args["sessionId"] = json!(session_id);
    expected_args["currentSessionId"] = json!(session_id);
    let answer = ask(&service, json!({ "query": "zzz unrelated", "args": {} })).await;
    let expected = recall.recall_cancellable(&expected_args, &tokio_util::sync::CancellationToken::new()).await.text;
    assert_eq!(answer, expected);
}

/// The first recall on a fresh profile whose runtime is installed (the stack opens the database at that call: `initdb`, the postmaster, the schema) from a new,
/// empty session answers what Node's answered (`record-memory-first-request.mjs`, the `value` of its `session.configure` result).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn the_first_recall_on_a_fresh_profile_answers_as_node() {
    use crate::memory::boot::{MemoryBoot, MemoryStack, PgRuntimeSource};
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/memory-first-request/golden.json")).expect("golden");
    let scenario = golden["scenarios"].as_array().expect("scenarios").iter().find(|s| s["name"] == "recall on a fresh profile whose runtime is installed").expect("recorded");
    let recorded = &scenario["requests"][0];
    let runtime = std::path::PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let dir = tempfile::tempdir().expect("dir");
    let stack = MemoryStack::start(MemoryBoot {
        data_dir: dir.path().to_owned(),
        pg_runtime: PgRuntimeSource::Dir(runtime),
        embedder: None,
        embedding_provider: None,
        flags: crate::memory::runtime::RuntimeFlags::default(),
        progress: None,
        sensitive: Arc::new(crate::memory::sensitive::SensitiveStore::default()),
        lane: mixdog_rt::testing::tokens().durability_io,
        maintenance: mixdog_rt::testing::tokens().maintenance_io,
        transcripts: None,
        cycles: None,
        backfill: None,
        processes: crate::tidy::process::Processes::for_tests(),
        cancel: tokio_util::sync::CancellationToken::new(),
    })
    .await
    .expect("built");
    let sessions = Sessions { session: Some(SessionData { id: "sess-new".into(), messages: Vec::new() }), cwd: Some(dir.path().join("work").to_string_lossy().into_owned()), title: String::new() };
    let service = MemoryService::new(stack.module(), Arc::new(sessions));
    let args = recorded["args"].as_array().expect("args");
    let answer = futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(super::awaiting::awaiting("the first recall", ask(&service, json!({ "query": args[0], "args": args[1] }))))).await;
    // The postmaster the call started is stopped whatever the call did.
    stack.stop().await.expect("stops");
    let answer = answer.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    assert_eq!(answer, recorded["answer"]["body"]["result"]["value"].as_str().expect("Node's answer"));
}

async fn service_db(pg: &TestPg) -> crate::memory::pg::db::Db {
    pg.db(Schema::Memory).await
}
