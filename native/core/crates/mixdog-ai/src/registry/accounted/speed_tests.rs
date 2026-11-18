//! Which speed tier each recorded attempt is grouped under, through the accounted adapter and the record writer: the
//! tier of the request an attempt dispatched, nothing else, and never part of the price.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::SendEnd;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::AccountedAdapter;
use super::AccountingDeps;
use crate::catalog::PricedUsage;
use crate::catalog::UsageArgs;
use crate::registry::accounting::UsagePricing;
use crate::registry::accounting::UsageRow;
use crate::registry::accounting::UsageSink;

/// Prices by tokens alone and keeps the pricing tier each call was priced under.
#[derive(Default)]
struct Pricing(Mutex<Vec<Option<String>>>);

impl UsagePricing for Pricing {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        self.0.lock().unwrap().push(args.request_service_tier.clone());
        PricedUsage { input: args.input_tokens, cost_usd: Some(args.input_tokens + args.output_tokens), rates: Default::default() }
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

struct NoCodec;

impl WireCodec for NoCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }
    fn encode(&self, _: &ModelRequest) -> Result<WireRequest, ProviderError> {
        unreachable!()
    }
    fn decoder(&self, _: &ModelRequest) -> Box<dyn WireDecoder> {
        unreachable!()
    }
    fn classify(&self, _: &ErrorResponse) -> ProviderError {
        unreachable!()
    }
}

type Script = Vec<Result<StreamEvent, ProviderError>>;

struct Events(VecDeque<Result<StreamEvent, ProviderError>>);

#[async_trait]
impl ModelStream for Events {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        self.0.pop_front()
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

/// An adapter whose attempts dispatch what the plan says, the way a real one hands its request to the transport: the
/// tier is noted on the send's identity at that moment, and an attempt planned with none fails before anything is sent.
struct Provider {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    plan: Mutex<VecDeque<(&'static str, Script)>>,
}

#[async_trait]
impl ProviderAdapter for Provider {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &NoCodec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, request: std::sync::Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let (tier, script) = self.plan.lock().unwrap().pop_front().unwrap();
        if !tier.is_empty() {
            request.options.send_identity.note_dispatched_speed_tier(tier);
        }
        Ok(Box::new(Events(script.into())))
    }
}

fn usage(input: u64, output: u64) -> Usage {
    Usage { input_tokens: input, output_tokens: output, ..Usage::default() }
}

fn billed_failure(input: u64, output: u64) -> Script {
    let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::Accepted);
    error.partial_usage = Some(Box::new(usage(input, output)));
    vec![Err(error)]
}

fn unbilled_failure() -> Script {
    vec![Err(ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent))]
}

fn completed(input: u64, output: u64) -> Script {
    vec![Ok(StreamEvent::Usage(usage(input, output))), Ok(StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None })]
}

fn adapter(plan: Vec<(&'static str, Script)>) -> (std::sync::Arc<dyn ProviderAdapter>, std::sync::Arc<Ledger>, std::sync::Arc<Pricing>) {
    let ledger = std::sync::Arc::new(Ledger::default());
    let sink: std::sync::Arc<dyn UsageSink> = ledger.clone();
    let pricing = std::sync::Arc::new(Pricing::default());
    let deps = AccountingDeps::new(pricing.clone(), std::sync::Arc::new(move || Some(sink.clone())));
    let inner = Provider { id: ProviderId::from("openai"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC, plan: Mutex::new(plan.into()) };
    (AccountedAdapter::wrap(std::sync::Arc::new(inner), "openai", std::sync::Arc::new(deps)), ledger, pricing)
}

/// One request of the send group `g`: the attempts of a send share its identity, as the loop's retries do.
fn request(identity: &mixdog_core_api::domain::provider::SendIdentity) -> std::sync::Arc<ModelRequest> {
    std::sync::Arc::new(ModelRequest {
        model: "gpt-x".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        options: RequestOptions {
            session_id: Some("session-1".into()),
            request_kind: Some("lead".into()),
            send_group: Some("g".into()),
            send_identity: identity.clone(),
            ..RequestOptions::default()
        },
    })
}

fn sent_speed(row: &UsageRow) -> Option<String> {
    let rates: Value = serde_json::from_str(row.rates.as_deref().unwrap()).unwrap();
    rates.get("sentSpeedTier").and_then(Value::as_str).map(str::to_owned)
}

/// A retry that goes out at another tier does not relabel the attempt it replaced: each billed attempt keeps the tier of
/// its own request, and an attempt that failed before it dispatched anything has none.
#[tokio::test]
async fn each_attempt_keeps_the_tier_of_its_own_dispatched_request() {
    let (adapter, ledger, _) = adapter(vec![("priority", billed_failure(10, 1)), ("", unbilled_failure()), ("ultrafast", completed(100, 20))]);
    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    for _ in 0..2 {
        let mut stream = adapter.attempt(request(&identity)).await.unwrap();
        assert!(matches!(stream.next().await, Some(Err(_))));
    }
    let mut stream = adapter.attempt(request(&identity)).await.unwrap();
    while stream.next().await.is_some() {}
    let rows = ledger.0.lock().unwrap().clone();
    assert_eq!(rows.len(), 2, "the billed first attempt and the send's own row");
    assert_eq!((rows[0].input, sent_speed(&rows[0])), (10.0, Some("priority".into())));
    assert_eq!((rows[1].input, sent_speed(&rows[1])), (100.0, Some("ultrafast".into())));
}

/// An attempt that dispatched nothing is not marked premium by the attempt before it: the shared identity is cleared as
/// each attempt begins.
#[tokio::test]
async fn an_attempt_that_dispatches_nothing_does_not_inherit_the_previous_tier() {
    let (adapter, ledger, _) = adapter(vec![("priority", billed_failure(10, 1)), ("", completed(100, 20))]);
    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let mut stream = adapter.attempt(request(&identity)).await.unwrap();
    assert!(matches!(stream.next().await, Some(Err(_))));
    let mut stream = adapter.attempt(request(&identity)).await.unwrap();
    while stream.next().await.is_some() {}
    let rows = ledger.0.lock().unwrap().clone();
    assert_eq!(rows.len(), 2);
    assert_eq!(sent_speed(&rows[0]), Some("priority".into()));
    assert_eq!(sent_speed(&rows[1]), None, "standard: nothing carries the earlier attempt's tier");
}

/// The tier only groups: it is never an input of the price, so costs equal those of the same send with no tier.
#[tokio::test]
async fn the_tier_never_reaches_the_price() {
    let (adapter, ledger, pricing) = adapter(vec![("ultrafast", completed(100, 20))]);
    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let mut stream = adapter.attempt(request(&identity)).await.unwrap();
    while stream.next().await.is_some() {}
    let row = ledger.0.lock().unwrap()[0].clone();
    assert_eq!((row.cost_usd, sent_speed(&row)), (Some(120.0), Some("ultrafast".into())));
    assert_eq!(*pricing.0.lock().unwrap(), vec![None], "priced as a request that carried no tier");
}

/// A send ended after its last attempt failed books the failure under that attempt's own tier.
#[tokio::test]
async fn a_surfaced_failure_is_grouped_under_its_own_attempt() {
    let (adapter, ledger, _) = adapter(vec![("priority", billed_failure(40, 3))]);
    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let mut stream = adapter.attempt(request(&identity)).await.unwrap();
    assert!(matches!(stream.next().await, Some(Err(_))));
    adapter.settle_send("g", SendEnd::Surfaced).await;
    let rows = ledger.0.lock().unwrap().clone();
    assert_eq!((rows.len(), rows[0].input, sent_speed(&rows[0])), (1, 40.0, Some("priority".into())));
}
