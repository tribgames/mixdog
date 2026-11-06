//! `thread/search` against the answers of Node's real `searchSessionContent`
//! (`fixtures/thread-search`, recorded by `record-thread-search.mjs`) over the same stored messages.

use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use serde_json::Value;
use serde_json::json;

use super::ThreadSearchService;
use crate::memory::pg::db::Schema;
use crate::memory::session_search::db::SessionSearchDb;
use crate::memory::tests::support::TestPg;

const GOLDEN: &str = include_str!("../../../../fixtures/thread-search/golden.json");

#[tokio::test]
async fn search_answers_what_nodes_search_session_content_answered() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let pg = TestPg::start().await;
    let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.unwrap();
    for (session, rows) in golden["messages"].as_object().unwrap() {
        db.append(session, rows.as_array().unwrap()).await.unwrap();
    }
    let service = ThreadSearchService::new(db);
    for case in golden["cases"].as_array().unwrap() {
        let request = CoreRequest {
            method: Method("thread/search"),
            params: json!({ "query": case["query"] }),
            op: None,
            ctx: CallContext::internal("thread-search-test"),
        };
        let got = service.call(request).await;
        let want = &case["result"];
        match (got, want.get("ok"), want.get("error")) {
            (Ok(Reply::Value(got)), Some(ok), _) => assert_eq!(&got, ok, "{}", case["query"]),
            (Err(error), _, Some(want)) => {
                assert!(error.to_string().contains(want["message"].as_str().unwrap()), "{}: {error}", case["query"]);
            }
            (other, ..) => panic!("{}: unexpected {:?}", case["query"], other.map(|_| ())),
        }
    }
}

