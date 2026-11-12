//! A recall cancelled while one of its store reads is running, and the read then succeeds, is the caller's cancellation, not a
//! reply (`rpc.mjs:74-78`: the proxy rejects the call with the signal's reason). One test per await of the recall path.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::memory::pg::db::Schema;
use crate::memory::recall::period::Clock;
use crate::memory::recall::{AFTER_READ, QueryEmbedder, Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

struct NoVector;

#[async_trait]
impl QueryEmbedder for NoVector {
    async fn query_vector(&self, _text: &str, _cancel: &CancellationToken) -> crate::memory::error::Result<Option<Vec<f32>>> {
        Ok(None)
    }
}

/// Runs `args` with the request's cancel fired the moment `point`'s read has finished.
async fn cancelled_after(point: &'static str, args: Value) {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "Xenova/multilingual-e5-small" })).await.expect("schema");
    let recall = Recall::new(RecallDeps {
        db,
        clock: Arc::new(|| Clock { now_ms: 1_700_000_000_000, zone: chrono_tz::UTC }),
        embedder: Some(Arc::new(NoVector)),
        session_cwd: None,
        lane: mixdog_rt::testing::tokens().durability_io,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    let cancel = CancellationToken::new();
    let reached = Rc::new(RefCell::new(false));
    let (token, seen) = (cancel.clone(), reached.clone());
    AFTER_READ.with(|hook| {
        *hook.borrow_mut() = Some(Rc::new(move |name| {
            if name == point {
                *seen.borrow_mut() = true;
                token.cancel();
            }
        }));
    });
    let outcome = recall.recall_cancellable(&args, &cancel).await;
    AFTER_READ.with(|hook| *hook.borrow_mut() = None);
    assert!(*reached.borrow(), "the recall never reached the await `{point}`: {}", outcome.text);
    assert!(outcome.cancelled, "a recall cancelled during `{point}` answered a reply: {}", outcome.text);
}

macro_rules! cancelled_during {
    ($($name:ident: $point:literal, $args:expr;)*) => {$(
        #[tokio::test]
        async fn $name() {
            cancelled_after($point, $args).await;
        }
    )*};
}

cancelled_during! {
    a_recall_cancelled_during_the_session_read_is_cancelled: "session_rows", json!({ "sessionId": "s1" });
    a_recall_cancelled_during_the_project_scope_read_is_cancelled: "project_scope", json!({});
    a_recall_cancelled_during_the_id_lookup_is_cancelled: "ids", json!({ "id": 1 });
    a_recall_cancelled_during_the_last_browse_is_cancelled: "last", json!({ "period": "last" });
    a_recall_cancelled_during_the_browse_is_cancelled: "browse", json!({});
    a_recall_cancelled_during_the_query_embedding_is_cancelled: "embed", json!({ "query": "restart" });
    a_recall_cancelled_during_the_candidate_search_is_cancelled: "candidates", json!({ "query": "restart" });
    a_recall_cancelled_during_the_window_roots_read_is_cancelled: "window_roots", json!({ "query": "restart", "period": "yesterday" });
    a_recall_cancelled_during_the_raw_window_read_is_cancelled: "raw_window", json!({ "query": "restart", "includeRaw": true });
    a_recall_cancelled_during_the_core_rows_read_is_cancelled: "core_rows", json!({ "query": "restart" });
    a_recall_cancelled_during_the_context_expansion_is_cancelled: "expand", json!({ "query": "restart", "includeRaw": true });
}
