//! The generation window and the ledger's first-output time against Node's recordings (`fixtures/provider-wire/
//! generation-timing`, recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs`): each answer is read in
//! two parts, the virtual clock stepped 700 ms before the first (which ends with the first text) and 1300 ms before the
//! rest, as Node's endpoint stepped it. Node measures the window from its stream's first output (generation-window.mjs:
//! Anthropic's first block opening, a Responses stream's first item, a compatible Chat stream's first visible delta) to
//! its end, and the ledger's `ttftMs` as the request's time less that window for the timed providers
//! (usage-accounting.mjs:15-33, :140). The provider is built by the production builder and accounted as production
//! accounts it, over the hub's clock: every request, the whole result (`generationMs` included), the callbacks in order
//! and the ledger rows are compared with Node's.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use super::hosted_wire_tests::inputs;
use super::wire_fixtures::Hub;
use super::wire_fixtures::assert_same_events;
use super::wire_fixtures::assert_same_requests;
use super::wire_fixtures::assert_same_result;
use super::wire_fixtures::built;
use super::wire_fixtures::core_result_at;
use super::wire_fixtures::load;
use super::wire_fixtures::node_result;
use super::wire_fixtures::request_of;
use super::wire_fixtures::scenarios;
use super::wire_fixtures::timed_attempt;
use crate::providers::google::wire_tests::Rows;
use crate::providers::google::wire_tests::empty_pricing;
use crate::registry::accounted::AccountOf;
use crate::registry::accounted::AccountedAdapter;
use crate::registry::accounted::AccountingDeps;
use crate::registry::accounting::UsageSink;

/// The recorder's account roster: the default account.
struct DefaultAccount;

#[async_trait]
impl AccountOf for DefaultAccount {
    async fn of(&self, _: &str) -> Result<String, String> {
        Ok("default".into())
    }
}

#[test]
fn the_generation_window_and_first_output_time_are_measured_as_node_measures_them() {
    // The recorder ran with TZ=Asia/Seoul: a row's day is that local day.
    mixdog_js::time::with_local_zone("Asia/Seoul".parse().unwrap(), || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(replay_timing());
    });
}

async fn replay_timing() {
    let names = scenarios("generation-timing");
    assert_eq!(names, ["anthropic-oauth", "deepseek", "openai"]);
    for name in names {
        let recorded = load("generation-timing", &name);
        let hub = Hub::new(&recorded);
        let (inner, _dir) = built(&recorded, hub.clone(), inputs()).await;
        let rows = Arc::new(Rows::default());
        let ledger = rows.clone();
        let mut deps = AccountingDeps::new(empty_pricing().await, Arc::new(move || Some(ledger.clone() as Arc<dyn UsageSink>)));
        deps.now = hub.clock();
        deps.new_id = Arc::new(|| "<req>".to_owned());
        deps.account = Arc::new(DefaultAccount);
        let adapter = AccountedAdapter::wrap(inner, recorded.input["provider"].as_str().expect("provider"), Arc::new(deps));
        let request = Arc::new(request_of(&recorded));
        let (events, at) = timed_attempt(adapter.as_ref(), request.clone(), &hub).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_same_requests(&hub.sent(), &recorded, &[], &name);
        assert_same_result(&core_result_at(&events, &at, &request.model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_same_events(&events, &recorded, &name);
        assert_eq!(Value::Array(rows.0.lock().unwrap().clone()), recorded.result["rows"], "{name}: usage rows");
    }
}
