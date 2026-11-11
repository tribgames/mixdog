//! Anthropic's server-side fallback against Node's recordings (`fixtures/provider-wire/anthropic-fallback`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs`): the subscription adapter sends the turn, the recorded stream
//! (a `fallback` block before any output, after some, or naming a snapshot of the requested model) comes back. The
//! provider is built by the production builder from the recorded sign-in: every request is compared whole with Node's,
//! the whole result (the model that answered and the fallback record included), the stream callbacks in order, and the
//! ledger row the accounting writes.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use super::ModelCaps;
use crate::providers::google::wire_tests::Rows;
use crate::providers::google::wire_tests::empty_pricing;
use crate::providers::wire_fixtures::Hub;
use crate::providers::wire_fixtures::Inputs;
use crate::providers::wire_fixtures::assert_same_events;
use crate::providers::wire_fixtures::assert_same_requests;
use crate::providers::wire_fixtures::assert_same_result;
use crate::providers::wire_fixtures::attempt;
use crate::providers::wire_fixtures::built;
use crate::providers::wire_fixtures::core_result;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::node_result;
use crate::providers::wire_fixtures::request_of;
use crate::providers::wire_fixtures::scenarios;
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

/// The ledger rows with the first-output time left out: no adapter reports where generation starts in its stream
/// (`Completed::generation_ms` is never set), so every Rust row has none where Node's has one.
fn without_ttft(rows: &Value) -> Value {
    let mut rows = rows.clone();
    for row in rows.as_array_mut().expect("rows") {
        row.as_object_mut().expect("row").shift_remove("ttftMs");
    }
    rows
}

#[test]
fn a_turn_the_fallback_model_answers_is_booked_and_reported_as_node_does() {
    // The recorder ran with TZ=Asia/Seoul: a row's day is that local day.
    mixdog_js::time::with_local_zone("Asia/Seoul".parse().unwrap(), || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(replay_fallbacks());
    });
}

async fn replay_fallbacks() {
    let names = scenarios("anthropic-fallback");
    assert_eq!(names, ["before-output", "mid-output", "snapshot-target"]);
    for name in names {
        let recorded = load("anthropic-fallback", &name);
        let hub = Hub::new(&recorded);
        // Node's catalog answers for claude-opus-5: adaptive thinking with effort, 64k output.
        let caps = Arc::new(|_: &str| {
            Some(ModelCaps {
                adaptive_thinking: true,
                manual_thinking: false,
                ladder_stated: false,
                effort_levels: vec!["low".into(), "medium".into(), "high".into()],
                max_output_tokens: Some(65536),
                fast_mode: false,
                context_window: None,
                thinking_display_updates: false,
            })
        });
        let (inner, _dir) = built(&recorded, hub.clone(), Inputs { caps, ..Inputs::default() }).await;
        let rows = Arc::new(Rows::default());
        let ledger = rows.clone();
        let mut deps = AccountingDeps::new(empty_pricing().await, Arc::new(move || Some(ledger.clone() as Arc<dyn UsageSink>)));
        deps.now = Arc::new(|| 1_700_000_000_000);
        deps.new_id = Arc::new(|| "<req>".to_owned());
        deps.account = Arc::new(DefaultAccount);
        let adapter = AccountedAdapter::wrap(inner, "anthropic-oauth", Arc::new(deps));
        let request = Arc::new(request_of(&recorded));
        let events = attempt(adapter.as_ref(), request.clone()).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_same_requests(&hub.sent(), &recorded, &[], &name);
        assert_same_result(&core_result(&events, &request.model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_same_events(&events, &recorded, &name);
        assert_eq!(without_ttft(&Value::Array(rows.0.lock().unwrap().clone())), without_ttft(&recorded.result["rows"]), "{name}: usage rows");
    }
}
