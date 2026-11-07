//! `fixtures/services/media-ledger-twin.json` (`record-media-ledger.mjs`): the row Node's
//! `recordMediaUsage` hands the ledger, over lanes, reported usage and sessions. Every field of
//! the row must equal Node's except `rates`, the pricing layer's own snapshot (tested with it).
//! Without a catalog price a model is unpriced; the lanes whose cost is the provider's figure are
//! priced by the figure the provider reported.

use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::catalog::{PricedUsage, UsageArgs};
use mixdog_ai::registry::accounting::{UsagePricing, UsageRow, UsageSink};
use serde_json::{Map, Value};

use super::ledger::{MediaUsageCall, record_media_usage};

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-ledger-twin.json");

/// Prices nothing, as an empty catalog does.
struct Unpriced;

impl UsagePricing for Unpriced {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        let cached = args.cache_read_tokens;
        let input = if args.input_tokens_inclusive == Some(true) { (args.input_tokens - cached - args.cache_write_tokens).max(0.0) } else { args.input_tokens };
        PricedUsage { input, cost_usd: None, rates: Map::new() }
    }
}

#[derive(Default)]
struct Collect(Mutex<Vec<UsageRow>>);

#[async_trait]
impl UsageSink for Collect {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        self.0.lock().unwrap().push(row);
        Ok(())
    }
}

struct Refuse;

#[async_trait]
impl UsageSink for Refuse {
    async fn record_queued(&self, _: UsageRow) -> Result<(), String> {
        Err("disk full".to_owned())
    }
}

#[tokio::test]
async fn the_ledger_row_is_the_one_node_writes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let now = golden["clock"].as_i64().unwrap();
    for case in golden["rows"].as_array().unwrap() {
        let sink = Collect::default();
        let usage = if case["usage"].is_null() { None } else { Some(&case["usage"]) };
        let call = MediaUsageCall {
            lane: case["lane"].as_str().unwrap(),
            model: case["model"].as_str().unwrap(),
            pricing_model: case["pricingModel"].as_str(),
            usage,
            session_id: case["sessionId"].as_str().unwrap_or_default(),
            source_type: case["sourceType"].as_str().unwrap_or_default(),
            account: "",
        };
        record_media_usage(&sink, &Unpriced, &|| "00000000-0000-4000-8000-000000000001".to_owned(), now, call).await;
        let mut got = serde_json::to_value(sink.0.lock().unwrap().first().expect("a row")).unwrap();
        let mut want = case["row"].clone();
        for row in [&mut got, &mut want] {
            row.as_object_mut().unwrap().shift_remove("rates");
        }
        // The key order the ledger reads: compare as text.
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&want).unwrap(), "{} {} {} {}", case["lane"], case["model"], case["usage"], case["sessionId"]);
    }
}

#[tokio::test]
async fn a_ledger_that_refuses_never_fails_the_generation() {
    let call = |lane| MediaUsageCall { lane, model: "m", pricing_model: None, usage: Some(&Value::Null), session_id: "", source_type: "", account: "" };
    record_media_usage(&Refuse, &Unpriced, &|| "id".to_owned(), 1_700_000_000_000, call("gemini")).await;
    let sink = Collect::default();
    record_media_usage(&sink, &Unpriced, &|| "id".to_owned(), 1_700_000_000_000, call("")).await;
    assert!(sink.0.lock().unwrap().is_empty(), "a row without a lane is not written");
}