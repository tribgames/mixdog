//! A turn the server's fallback model answers is reported and booked under the model that answered, and the row keeps
//! the model that was asked for.

use super::*;
use crate::catalog::PricedUsage;
use crate::registry::accounted::AccountedAdapter;
use crate::registry::accounted::AccountingDeps;
use crate::registry::accounting::UsagePricing;
use crate::registry::accounting::UsageRow;
use crate::registry::accounting::UsageSink;
use crate::catalog::UsageArgs;

struct Unpriced;

impl UsagePricing for Unpriced {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        PricedUsage { input: args.input_tokens, cost_usd: None, rates: Default::default() }
    }
}

#[derive(Default)]
struct Ledger(Mutex<Vec<UsageRow>>);

#[async_trait]
impl UsageSink for Ledger {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        self.0.lock().unwrap().push(row);
        Ok(())
    }
}

fn sse(events: &[Value]) -> String {
    events.iter().map(|event| format!("data: {event}\n\n")).collect()
}

/// The stream of a turn whose primary model gave way to `fallback` before producing anything.
fn handed_over(fallback: &str) -> String {
    sse(&[
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 12, "output_tokens": 0 } } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "fallback", "from": "claude-sonnet-4-6", "to": fallback, "trigger": { "type": "overloaded" } } }),
        json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "answer" } }),
        json!({ "type": "content_block_stop", "index": 1 }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 3 } }),
        json!({ "type": "message_stop" }),
    ])
}

async fn run(body: String) -> (Vec<StreamEvent>, Vec<UsageRow>) {
    let http = ScriptedHttp::new([Scripted::body(200, &body)]);
    let inner = AnthropicAdapter::api_key(config("http://127.0.0.1:1"), http, Arc::new(FixedKey), cpu_bulk());
    let ledger = Arc::new(Ledger::default());
    let sink: Arc<dyn UsageSink> = ledger.clone();
    let deps = Arc::new(AccountingDeps::new(Arc::new(Unpriced), Arc::new(move || Some(sink.clone()))));
    let adapter = AccountedAdapter::wrap(Arc::new(inner), "anthropic", deps);
    let mut stream = adapter.attempt(Arc::new(request(base_messages(), RequestOptions::default()))).await.expect("the turn starts");
    let mut events = Vec::new();
    while let Some(next) = stream.next().await {
        events.push(next.expect("the stream ends cleanly"));
    }
    let rows = ledger.0.lock().unwrap().clone();
    (events, rows)
}

#[tokio::test]
async fn a_turn_the_fallback_model_answers_is_reported_and_booked_under_that_model() {
    let (events, rows) = run(handed_over("claude-haiku-4-5")).await;
    assert!(
        events.iter().any(|event| matches!(event, StreamEvent::ServedModel(model) if model == "claude-haiku-4-5")),
        "the answering model is reported: {events:?}"
    );
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.model, "claude-haiku-4-5", "booked under the model that answered");
    assert_eq!(row.requested_model, "claude-sonnet-4-6", "the row keeps what was asked for");
    assert_eq!(row.status, "substituted");
    assert_eq!(row.output, 3.0);
}

fn answer() -> String {
    sse(&[
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 12, "output_tokens": 0 } } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "answer" } }),
        json!({ "type": "content_block_stop", "index": 0 }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 3 } }),
        json!({ "type": "message_stop" }),
    ])
}

/// One turn of a fast-mode-capable model through the real adapter and the accounted wrapper: the ledger rows and the
/// body the adapter put on the wire.
async fn turn_asking_fast(fast: bool) -> (Vec<UsageRow>, Value) {
    let mut config = AnthropicConfig::new(Arc::new(|_: &str| Some(ModelCaps { fast_mode: true, ..sonnet_caps() })));
    config.base_url = "http://127.0.0.1:1".to_owned();
    config.fast_mode = Arc::new(crate::providers::anthropic::fast_mode::FastMode::new());
    let http = ScriptedHttp::new([Scripted::body(200, &answer())]);
    let inner = AnthropicAdapter::api_key(config, http.clone(), Arc::new(FixedKey), cpu_bulk());
    let ledger = Arc::new(Ledger::default());
    let sink: Arc<dyn UsageSink> = ledger.clone();
    let deps = Arc::new(AccountingDeps::new(Arc::new(Unpriced), Arc::new(move || Some(sink.clone()))));
    let adapter = AccountedAdapter::wrap(Arc::new(inner), "anthropic", deps);
    let mut req = request(base_messages(), RequestOptions { fast, ..RequestOptions::default() });
    req.model = "claude-opus-5".into();
    let mut stream = adapter.attempt(Arc::new(req)).await.expect("the turn starts");
    while let Some(next) = stream.next().await {
        next.expect("the stream ends cleanly");
    }
    let rows = ledger.0.lock().unwrap().clone();
    let body = serde_json::from_slice(&http.sent()[0].body).expect("a JSON body");
    (rows, body)
}

fn sent_speed(row: &UsageRow) -> Option<String> {
    let rates: Value = serde_json::from_str(row.rates.as_deref().expect("rates")).expect("rates are JSON");
    rates.get("sentSpeedTier").and_then(Value::as_str).map(str::to_owned)
}

/// A call whose request carried fast-mode speed is grouped as Fast by what was dispatched, and its recorded amounts and
/// cost are those of the same turn at standard speed.
#[tokio::test]
async fn a_turn_dispatched_at_fast_speed_is_grouped_fast_without_changing_its_amounts() {
    let (fast, body) = turn_asking_fast(true).await;
    assert_eq!(body["speed"], "fast", "the adapter asked for fast speed: {body}");
    let (standard, body) = turn_asking_fast(false).await;
    assert!(body.get("speed").is_none(), "{body}");
    assert_eq!((sent_speed(&fast[0]), sent_speed(&standard[0])), (Some("fast".to_owned()), None));
    let amounts = |row: &UsageRow| (row.input, row.output, row.cache_read, row.cache_write, row.cost_usd, row.cost_source.clone());
    assert_eq!(amounts(&fast[0]), amounts(&standard[0]));
}

#[tokio::test]
async fn a_turn_with_no_fallback_is_booked_under_the_requested_model() {
    let body = sse(&[
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 12, "output_tokens": 0 } } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "answer" } }),
        json!({ "type": "content_block_stop", "index": 0 }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 3 } }),
        json!({ "type": "message_stop" }),
    ]);
    let (events, rows) = run(body).await;
    assert!(!events.iter().any(|event| matches!(event, StreamEvent::ServedModel(_))));
    assert_eq!((rows[0].model.as_str(), rows[0].requested_model.as_str(), rows[0].status.as_str()), ("claude-sonnet-4-6", "", "completed"));
}
