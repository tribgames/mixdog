//! `thread/list`: the stored-session summary listing (`listStoredSessionSummaryPage`,
//! `store-summary-reader.mjs`, behind `listSessions({ page })`). It reads the catalog index's
//! list rows only (the header-only summaries `_sessionSummary` built), never a session's log,
//! and answers a page of the lead-visible rows in catalog order (newest activity first, ties by
//! id): `limit` rows (`Math.floor(limit)`, default 50, at most 1000) after the keyset `cursor`,
//! with a `nextCursor` naming the last row only when more follow.
//!
//! The runtime overlay `daemon-stored-session-views.mjs` (`withRuntimeActivity`) and
//! `session-action.mjs` (`withApprovalWaits`) lay over a row is the host's ([`RowOverlay`]).
//! What only the v2 protocol names (`searchTerm`, `sortKey`, `sortDirection`) is decided in
//! `decisions.md` (D-list-*).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::SortDirection;
use mixdog_app_protocol::v2::thread::ThreadListParams;
use mixdog_app_protocol::v2::thread::ThreadListResponse;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::coded;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use mixdog_protocol::ThreadSummary;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::sqlite::lead::LeadFilter;
use mixdog_store::sqlite::lead::decode_catalog_cursor;
use mixdog_store::sqlite::lead::encode_catalog_cursor;

use super::transcript::summary_of_list_row;

pub const LIST: &str = "thread/list";
const DOMAIN: &str = "thread list";

/// `DEFAULT_PAGE_LIMIT` and `MAX_PAGE_LIMIT` (`store-summary-reader.mjs`).
const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 1000;

/// What the running daemon knows of a listed session that storage does not: the fields
/// `withRuntimeActivity` (`working`, `agentWorking`) and `withApprovalWaits` (`awaitingApproval`,
/// `awaitingQuestion`, `handedBy`) add to a row. A field the session has no fact for stays `None`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RowOverlay {
    pub working: Option<bool>,
    pub agent_working: Option<bool>,
    pub awaiting_approval: Option<bool>,
    pub awaiting_question: Option<bool>,
    pub handed_by: Option<Vec<String>>,
}

impl RowOverlay {
    fn lay_over(self, row: &mut ThreadSummary) {
        row.working = self.working.or(row.working);
        row.agent_working = self.agent_working.or(row.agent_working);
        row.awaiting_approval = self.awaiting_approval.or(row.awaiting_approval);
        row.awaiting_question = self.awaiting_question.or(row.awaiting_question);
        row.handed_by = self.handed_by.or_else(|| row.handed_by.take());
    }
}

/// The host side of the overlay: the live facts of one session.
pub trait ListOverlay: Send + Sync {
    fn of(&self, thread: &ThreadId) -> RowOverlay;
}

/// `thread/list` over the catalog index.
pub struct ThreadListService {
    store: Arc<SqliteStore>,
    overlay: Arc<dyn ListOverlay>,
}

impl ThreadListService {
    pub fn new(store: Arc<SqliteStore>, overlay: Arc<dyn ListOverlay>) -> Self {
        Self { store, overlay }
    }

    async fn list(&self, params: ThreadListParams) -> Result<ThreadListResponse, CoreError> {
        if params.search_term.as_deref().is_some_and(|term| !term.is_empty()) {
            return Err(invalid("searchTerm", "absent: the listing has no text search (`thread/search` is the search)"));
        }
        if params.sort_key.is_some() {
            return Err(invalid("sortKey", "absent: the listing is in catalog order"));
        }
        if params.sort_direction.is_some_and(|direction| direction != SortDirection::Desc) {
            return Err(invalid("sortDirection", "desc: the listing is newest activity first"));
        }
        let limit = match params.limit.map(|limit| limit as usize) {
            Some(requested) if requested > 0 => requested.min(MAX_PAGE_LIMIT),
            _ => DEFAULT_PAGE_LIMIT,
        };
        let after = decode_catalog_cursor(params.cursor.as_deref())
            .map_err(|error| coded(DOMAIN, "EINVALIDCURSOR", error.to_string()))?;
        let filter = LeadFilter { archived: params.archived, cwd: params.cwd };
        let page = self.store.lead_page(after, filter, limit).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        let next_cursor = if page.more { page.rows.last().map(|row| encode_catalog_cursor(&row.row)) } else { None };
        let data = page
            .rows
            .iter()
            .map(|listed| {
                let id = ThreadId::from(listed.row.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned());
                let mut row = summary_of_list_row(&id, &serde_json::Value::Object(listed.row.clone()), listed.archived);
                self.overlay.of(&id).lay_over(&mut row);
                row
            })
            .collect();
        Ok(ThreadListResponse { data, next_cursor, backwards_cursor: None })
    }
}

#[async_trait]
impl DomainService for ThreadListService {
    fn methods(&self) -> &'static [&'static str] {
        &[LIST]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            LIST => {
                let response = self.list(decode(&req)?).await?;
                Ok(Reply::Value(serde_json::to_value(response).map_err(|error| failed(DOMAIN, error.to_string()))?))
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn notify(&self, _method: Method, _params: serde_json::Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use mixdog_store::sqlite::DirtyMark;
    use mixdog_store::summary::CatalogHead;
    use serde_json::Value;
    use serde_json::json;

    use super::*;

    /// The overlay of the golden run: `s_a` has a turn in flight.
    struct Busy;
    impl ListOverlay for Busy {
        fn of(&self, thread: &ThreadId) -> RowOverlay {
            if thread.as_str() == "s_a" {
                RowOverlay { working: Some(true), ..RowOverlay::default() }
            } else {
                RowOverlay::default()
            }
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/session-list/golden.json")).expect("golden json")
    }

    async fn service(data: &std::path::Path, golden: &Value) -> ThreadListService {
        let tokens = mixdog_rt::testing::tokens();
        let root = data.to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let store = Arc::new(index);
        for entry in golden["sessions"].as_array().expect("sessions") {
            let mut header = entry["record"].as_object().expect("record").clone();
            header.shift_remove("messages");
            let id = header["id"].as_str().expect("id").to_owned();
            store.upsert(CatalogHead { session: id, log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.expect("upsert");
        }
        ThreadListService::new(store, Arc::new(Busy))
    }

    /// Every page `listStoredSessionSummaryPage` answered over Node's crafted records (the limit
    /// rules, the order, `nextCursor`), and the rows of those pages as Node's `_sessionSummary` built
    /// them. A limit the protocol cannot carry (negative, fractional) is refused by the wire type
    /// before it reaches the handler, so only the in-range limits run here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pages_equal_nodes() {
        let golden = golden();
        let data = tempfile::tempdir().expect("data dir");
        let service = service(data.path(), &golden).await;
        let summaries: std::collections::HashMap<&str, &Value> =
            golden["sessions"].as_array().expect("sessions").iter().map(|s| (s["record"]["id"].as_str().expect("id"), &s["summary"])).collect();
        let mut walked = 0;
        for walk in golden["walks"].as_array().expect("walks") {
            let limit = walk["limit"].as_f64();
            if limit.is_some_and(|l| l.fract() != 0.0 || l < 0.0) {
                continue;
            }
            for page in walk["pages"].as_array().expect("pages") {
                let mut params = json!({});
                if let Some(limit) = limit {
                    params["limit"] = json!(limit as u64);
                }
                if let Some(cursor) = page["cursor"].as_str() {
                    params["cursor"] = json!(cursor);
                }
                let answer = value(&service, request(LIST, params, None)).await.expect("list");
                let ids: Vec<&str> = answer["data"].as_array().expect("data").iter().map(|row| row["id"].as_str().expect("id")).collect();
                let want: Vec<&str> = page["ids"].as_array().expect("ids").iter().map(|id| id.as_str().expect("id")).collect();
                assert_eq!(ids, want, "limit {} cursor {}", walk["limit"], page["cursor"]);
                assert_eq!(answer["nextCursor"].as_str(), page["nextCursor"].as_str());
                for row in answer["data"].as_array().expect("data") {
                    let node = summaries[row["id"].as_str().expect("id")];
                    for field in ["title", "updatedAt", "messageCount", "cwd", "preview"] {
                        assert_eq!(row[field], node[field], "{field} of {}", row["id"]);
                    }
                    assert_eq!(row["working"] == json!(true), row["id"] == "s_a");
                }
                walked += 1;
            }
        }
        assert!(walked > 8);
    }

    /// A cursor that does not decode is Node's `EINVALIDCURSOR` failure; a text search or another
    /// ordering is not served by this listing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refusals() {
        let golden = golden();
        let data = tempfile::tempdir().expect("data dir");
        let service = service(data.path(), &golden).await;
        let refused = |params: Value| {
            let service = &service;
            async move { value(service, request(LIST, params, None)).await.expect_err("refused") }
        };
        match refused(json!({ "cursor": "!!!" })).await {
            CoreError::DomainError { code, message, .. } => {
                assert_eq!(code.as_deref(), Some("EINVALIDCURSOR"));
                assert_eq!(message.as_deref(), Some("invalid session catalog cursor"));
            }
            other => panic!("{other:?}"),
        }
        for params in [json!({ "searchTerm": "x" }), json!({ "sortKey": "createdAt" }), json!({ "sortDirection": "asc" })] {
            assert!(matches!(refused(params).await, CoreError::InvalidParams { .. }));
        }
    }
}
