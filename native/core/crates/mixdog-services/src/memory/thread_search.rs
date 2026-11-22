//! `thread/search` (`session-host.ts` `searchSessionContent`): the best-matching message of each
//! session for a query, strongest first, at most 50. A hit names the history position of its message's record
//! (`position`), where the transcript opens at it; a row stored before positions were has none.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadSearchParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;
use serde_json::Value;
use serde_json::json;

use super::access::MemoryAccess;
use super::session_search::db::SessionSearchDb;

const METHOD: &str = "thread/search";
const DOMAIN: &str = "memory";
const LIMIT: i64 = 50;
const MAX_QUERY_UNITS: usize = 1_024;

/// The sessions a search must not answer now (those owing a sensitive rewrite: their copy holds text from before it).
pub type HiddenSessions = Arc<dyn Fn() -> Vec<String> + Send + Sync>;

/// Its searches are scoped operations of the memory stack's owner (`MemoryStack::search_access`).
pub struct ThreadSearchService {
    search: MemoryAccess,
    hidden: Option<HiddenSessions>,
}

impl ThreadSearchService {
    pub fn new(search: MemoryAccess) -> Arc<Self> {
        Arc::new(Self { search, hidden: None })
    }

    /// [`Self::new`] that never answers the sessions `hidden` names when a search runs.
    pub fn hiding(search: MemoryAccess, hidden: HiddenSessions) -> Arc<Self> {
        Arc::new(Self { search, hidden: Some(hidden) })
    }

    /// `requiredSessionContentQuery` then the search: `[{ sessionId, snippet, rank, position? }]`.
    pub async fn run(&self, query: &str) -> Result<Value, CoreError> {
        let text = mixdog_js::js_trim(query);
        if text.is_empty() || mixdog_js::utf16_len(text) > MAX_QUERY_UNITS {
            return Err(failed(DOMAIN, "session search query is invalid."));
        }
        let query = text.to_owned();
        let hidden = self.hidden.as_ref().map(|hidden| hidden()).unwrap_or_default();
        let hits = self
            .search
            .run("services.memory.thread-search", move |db| async move { SessionSearchDb::over(db).search_excluding(&query, LIMIT, &hidden).await })
            .await
            .map_err(|e| failed(DOMAIN, e.to_string()))?;
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            // `ts_rank_cd` is a float4, which node-postgres parses from its shortest decimal
            // text; a JS number with no fraction prints without one. f32's own text always
            // parses as f64, so a failure is a defect surfaced as an error.
            let shortest: f64 = (hit.rank as f32).to_string().parse().map_err(|e| failed(DOMAIN, format!("session search rank is not a number: {e}")))?;
            let rank = if shortest.fract() == 0.0 { json!(shortest as i64) } else { json!(shortest) };
            let mut found = json!({ "sessionId": hit.session_id, "snippet": hit.snippet, "rank": rank });
            if let Some(position) = hit.position {
                found["position"] = Value::String(position);
            }
            out.push(found);
        }
        Ok(Value::Array(out))
    }
}

#[async_trait]
impl DomainService for ThreadSearchService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str() != METHOD {
            return Err(wrong_method(DOMAIN, req.method.as_str()));
        }
        let params: ThreadSearchParams = decode(&req)?;
        self.run(&params.query).await.map(Reply::Value)
    }

    fn methods(&self) -> &'static [&'static str] {
        &[METHOD]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::DomainService;
    use mixdog_core_api::Reply;
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::ids::Method;
    use serde_json::{Value, json};

    use super::ThreadSearchService;
    use crate::memory::pg::db::Schema;
    use crate::memory::session_search::db::SessionSearchDb;
    use crate::memory::tests::support::TestPg;

    async fn service_over(pg: &TestPg, sessions: &[(&str, Vec<Value>)]) -> std::sync::Arc<ThreadSearchService> {
        let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.unwrap();
        for (session, rows) in sessions {
            db.append(session, rows).await.unwrap();
        }
        ThreadSearchService::new(crate::memory::access::MemoryAccess::over(db.db().clone()))
    }

    fn say(role: &str, text: &str) -> Value {
        json!({ "role": role, "content": text })
    }

    #[tokio::test]
    #[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
    async fn a_query_answers_each_session_once_with_its_best_snippet_and_a_rank() {
        let pg = TestPg::start().await;
        let service = service_over(
            &pg,
            &[
                ("s1", vec![say("user", "Deploy the staging cluster tonight"), say("assistant", "The staging cluster is deploying now")]),
                ("s2", vec![say("user", "Unrelated talk about lunch")]),
            ],
        )
        .await;
        let hits = service.run("staging cluster").await.unwrap();
        let hits = hits.as_array().unwrap();
        assert_eq!(hits.len(), 1, "one answer per matching session");
        assert_eq!(hits[0]["sessionId"], "s1");
        assert!(hits[0]["snippet"].as_str().unwrap().contains("staging"));
        assert!(hits[0]["rank"].as_f64().unwrap() > 0.0);
        assert_eq!(service.run("nothing like it anywhere").await.unwrap(), json!([]));
    }

    #[tokio::test]
    #[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
    async fn the_strongest_session_comes_first_and_no_more_than_fifty_are_answered() {
        let pg = TestPg::start().await;
        let mut sessions: Vec<(String, Vec<Value>)> = (0..55).map(|n| (format!("many-{n:02}"), vec![say("user", "rollout rollout checklist")])).collect();
        sessions.push(("strong".into(), vec![say("user", "rollout rollout rollout rollout rollout")]));
        let borrowed: Vec<(&str, Vec<Value>)> = sessions.iter().map(|(id, rows)| (id.as_str(), rows.clone())).collect();
        let service = service_over(&pg, &borrowed).await;
        let hits = service.run("rollout").await.unwrap();
        let hits = hits.as_array().unwrap();
        assert_eq!(hits.len(), 50);
        let ranks: Vec<f64> = hits.iter().map(|h| h["rank"].as_f64().unwrap()).collect();
        assert!(ranks.windows(2).all(|w| w[0] >= w[1]), "strongest first: {ranks:?}");
    }

    #[tokio::test]
    #[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
    async fn a_blank_or_over_long_query_is_refused_and_the_route_answers_the_same_as_run() {
        let pg = TestPg::start().await;
        let service = service_over(&pg, &[("s1", vec![say("user", "Deploy the staging cluster")])]).await;
        let long = "q".repeat(1025);
        for bad in ["", "   ", long.as_str()] {
            assert!(service.run(bad).await.unwrap_err().to_string().contains("session search query is invalid."), "{}", bad.len());
        }
        assert!(service.run(&"q".repeat(1024)).await.is_ok(), "1024 units is the limit");
        let request =
            CoreRequest { method: Method("thread/search"), params: json!({ "query": "staging" }), op: None, ctx: CallContext::internal("thread-search-test") };
        let Ok(Reply::Value(routed)) = service.call(request).await else { panic!("the route answers a value") };
        assert_eq!(routed, service.run("staging").await.unwrap());
        let wrong = CoreRequest { method: Method("thread/other"), params: json!({}), op: None, ctx: CallContext::internal("thread-search-test") };
        assert!(service.call(wrong).await.is_err());
    }
}
