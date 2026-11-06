//! `thread/search` (`session-host.ts` `searchSessionContent`): the best-matching message of each
//! session for a query, strongest first, at most 50.

use std::sync::Arc;

use async_trait::async_trait;
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
use mixdog_app_protocol::v2::thread::ThreadSearchParams;
use serde_json::Value;
use serde_json::json;

use super::session_search::db::SessionSearchDb;

const METHOD: &str = "thread/search";
const DOMAIN: &str = "memory";
const LIMIT: i64 = 50;
const MAX_QUERY_UNITS: usize = 1_024;

pub struct ThreadSearchService {
    search: SessionSearchDb,
}

impl ThreadSearchService {
    pub fn new(search: SessionSearchDb) -> Arc<Self> {
        Arc::new(Self { search })
    }

    /// `requiredSessionContentQuery` then the search: `[{ sessionId, snippet, rank }]`.
    pub async fn run(&self, query: &str) -> Result<Value, CoreError> {
        let text = mixdog_js::js_trim(query);
        if text.is_empty() || mixdog_js::utf16_len(&text) > MAX_QUERY_UNITS {
            return Err(failed(DOMAIN, "session search query is invalid."));
        }
        let hits = self.search.search(&text, LIMIT).await.map_err(|e| failed(DOMAIN, e.to_string()))?;
        Ok(Value::Array(
            hits.into_iter()
                .map(|hit| {
                    // JS prints a whole rank without a fraction.
                    let rank = if hit.rank.fract() == 0.0 { json!(hit.rank as i64) } else { json!(hit.rank) };
                    json!({ "sessionId": hit.session_id, "snippet": hit.snippet, "rank": rank })
                })
                .collect(),
        ))
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
