//! The rows of every send outcome against the rows Node writes
//! (`benchmarks/rust-core/recorders/record-usage-accounting.mjs`): completed, cancelled and failed
//! sends, abandoned attempts included.

use std::sync::Mutex;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::UsdTicks;
use mixdog_js::time::Tz;
use serde_json::Map;

use super::*;

const GOLDEN: &str = include_str!("../../../../../fixtures/usage-accounting/golden.json");

/// Prices nothing, as an empty catalog does: the unpriced snapshot Node gives a
/// model it does not know.
struct Unpriced;

impl UsagePricing for Unpriced {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        let cached = args.cache_read_tokens;
        let written = args.cache_write_tokens;
        let input = if args.input_tokens_known == Some(false) {
            0.0
        } else if args.input_tokens_inclusive == Some(true) {
            (args.input_tokens - cached - written).max(0.0)
        } else {
            args.input_tokens
        };
        let mut rates = Map::new();
        let written_1h = args.cache_write_1h_tokens.min(written);
        rates.insert("requestedModel".into(), args.requested_model.clone().map_or(Value::Null, Value::from));
        rates.insert("pricingModel".into(), json!(args.pricing_model.clone().unwrap_or_else(|| args.model.clone())));
        rates.insert("pricingProvider".into(), json!(args.provider));
        rates.insert("pricingSource".into(), Value::Null);
        if args.input_tokens_known == Some(false) {
            rates.insert("inputTokensKnown".into(), json!(false));
        }
        for (key, tier) in [("requestServiceTier", &args.request_service_tier), ("serviceTier", &args.service_tier)] {
            if let Some(tier) = tier.as_ref().filter(|tier| !tier.is_empty()) {
                rates.insert(key.into(), json!(tier));
            }
        }
        if written_1h != 0.0 {
            rates.insert("cacheWrite1hTokens".into(), crate::service::admin_route::jnum(written_1h));
        }
        let reason = if args.input_tokens_known == Some(false) { "unmeasured-input" } else { "model-not-found" };
        rates.insert("unpricedReason".into(), json!(reason));
        PricedUsage { input, cost_usd: None, rates }
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

fn usage_of(spec: &Value) -> Usage {
    let n = |key: &str| spec.get(key).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: n("inputTokens"),
        output_tokens: n("outputTokens"),
        cache_read_tokens: n("cachedTokens"),
        cache_write_tokens: n("cacheWriteTokens"),
        cache_write_1h_tokens: n("cacheWrite1hTokens"),
        cost: spec.get("costUsd").and_then(Value::as_f64).and_then(UsdTicks::from_usd),
        ..Usage::default()
    }
}

/// Node's unbound default account is `default`.
struct UnboundRoster;

#[async_trait]
impl crate::registry::accounted::AccountOf for UnboundRoster {
    async fn of(&self, _: &str) -> Result<String, String> {
        Ok("default".into())
    }
}

fn identity(case: &Value, started_at: i64) -> SendIdentity {
    let text = |key: &str| case.get(key).and_then(Value::as_str).map(str::to_owned);
    let provider = text("provider").unwrap();
    let model = text("model").unwrap();
    SendIdentity {
        provider: provider.clone(),
        model: model.clone(),
        requested_provider: provider,
        requested_model: model,
        route_hop: false,
        session_id: Some(text("sessionId").unwrap_or_else(|| "session-1".into())),
        owner_session_id: text("ownerSessionId"),
        source_type: "lead".into(),
        input_tokens_inclusive: case.get("inputExcludesCache") != Some(&json!(true)),
        request_service_tier: String::new(),
        account: Ok(String::new()),
        request_id: "<req>".into(),
        started_at,
    }
}

async fn rows_of(case: &Value) -> Vec<Value> {
    let started_at = case["startedAt"].as_i64().unwrap();
    let end = &case["end"];
    let stream_ms = end.get("streamMs").and_then(Value::as_i64).unwrap_or(1500);
    let sink = Arc::new(Collect::default());
    let mut accounting = SendAccounting::new(identity(case, started_at), Arc::new(Unpriced), Some(sink.clone()))
        .with_sources(Arc::new(move || started_at + stream_ms), Arc::new(|| "<random>".into()))
        .with_account(Arc::new(UnboundRoster));
    for attempt in case.get("abandoned").and_then(Value::as_array).into_iter().flatten() {
        let model = attempt.get("model").and_then(Value::as_str).map(str::to_owned);
        accounting.note_abandoned(&usage_of(&attempt["usage"]), model);
    }
    let usage = end.get("usage").map(usage_of);
    let recorded = match end["kind"].as_str().unwrap() {
        "completed" => {
            let completed = Completed {
                facts: usage.as_ref().map(Facts::from),
                model: end.get("model").and_then(Value::as_str).map(str::to_owned),
                response_id: end.get("responseId").and_then(Value::as_str).map(str::to_owned),
                fallback: end.get("fallback") == Some(&json!(true)),
                generation_ms: end.get("generationMs").and_then(Value::as_f64),
                stream_ended_at: started_at + stream_ms,
                ..Completed::default()
            };
            accounting.finish(Outcome::Completed(completed)).await
        }
        "cancelled" => accounting.finish(Outcome::Cancelled { reported: usage.as_ref().map(Facts::from) }).await,
        _ => {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Ambiguous);
            error.partial_usage = usage.map(Box::new);
            error.partial_model = end.get("model").and_then(Value::as_str).map(Box::from);
            accounting.finish(Outcome::Failed(&error)).await
        }
    };
    // Only a completed send is timed: its measured time is the row's duration.
    let timed = (end["kind"] == "completed").then_some(stream_ms as u64);
    assert_eq!(recorded, Recorded { error: None, request_ms: timed });
    let rows = sink.0.lock().unwrap().iter().map(|row| serde_json::to_value(row).unwrap()).collect();
    rows
}

#[tokio::test]
async fn every_outcome_writes_the_rows_node_writes() {
    // The golden was recorded with TZ=UTC: the row's day is the local day.
    let _ = mixdog_js::time::set_process_zone(Tz::UTC);
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 17);
    for case in cases {
        let want = case["rows"].as_array().unwrap();
        let rows = rows_of(case).await;
        assert_eq!(&rows, want, "{}", case["name"]);
    }
}

/// `usage-accounting.mjs` `save`: `currentProviderAccountId` throwing inside the row's write
/// writes no row and sets `usageAccountingError` to the error's message; the send's result stands.
/// An I/O failure reading the account roster is that throw.
#[tokio::test]
async fn an_unreadable_account_roster_fails_the_recording_and_exposes_the_error() {
    use crate::registry::accounted::AccountOf;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let roster = dir.path().join("provider-accounts.json");
    {
        use mixdog_rt::LaneToken;
        tokens
            .durability_io
            .submit(&tokio_util::sync::CancellationToken::new(), move |lane| mixdog_statefile::create_private_dir_all(lane, &roster))
            .unwrap()
            .await
            .unwrap()
            .unwrap();
    }
    let store = crate::accounts::AccountStore::new(
        dir.path().to_path_buf(),
        crate::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    let why = store.of("openai-oauth").await.unwrap_err();
    assert!(!why.is_empty());

    let sink = Arc::new(Collect::default());
    let case = json!({ "provider": "openai-oauth", "model": "gpt-5" });
    let mut unbound = identity(&case, 10_000);
    unbound.account = Err(why.clone());
    let accounting = SendAccounting::new(unbound, Arc::new(Unpriced), Some(sink.clone())).with_sources(Arc::new(|| 11_000), Arc::new(|| "<random>".into()));
    let recorded = accounting.finish(Outcome::Completed(Completed { stream_ended_at: 11_000, ..Completed::default() })).await;
    assert_eq!(recorded, Recorded { error: Some(why), request_ms: Some(1_000) });
    assert!(sink.0.lock().unwrap().is_empty(), "no row is written for a send whose account could not be read");
}

#[tokio::test]
async fn a_completed_send_reports_the_time_its_row_measured() {
    let sink = Arc::new(Collect::default());
    let now = Arc::new(std::sync::atomic::AtomicI64::new(10_000));
    let clock = Arc::clone(&now);
    let case = json!({ "provider": "openai", "model": "gpt-5" });
    let accounting = SendAccounting::new(identity(&case, 10_000), Arc::new(Unpriced), Some(sink.clone()))
        .with_sources(Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst)), Arc::new(|| "<random>".into()));
    now.store(12_345, std::sync::atomic::Ordering::SeqCst);
    let recorded = accounting.finish(Outcome::Completed(Completed { stream_ended_at: 12_000, ..Completed::default() })).await;
    // Measured to the write, not to the stream's end (Node `Date.now() - startedAt`).
    assert_eq!(recorded.request_ms, Some(2_345));
    // Without a ledger nothing is measured, so the consumer keeps its own clock.
    let unrecorded = SendAccounting::new(identity(&case, 10_000), Arc::new(Unpriced), None);
    assert_eq!(unrecorded.finish(Outcome::Completed(Completed::default())).await.request_ms, None);
}

/// The duration the row measured lands on the terminal `Completed` the report is built from;
/// a send that measured none leaves the provider's event alone.
#[tokio::test]
async fn the_sink_stamps_the_measured_time_on_the_terminal_event() {
    use crate::broker::AttemptSink;
    use crate::registry::attempt::RecordingSink;
    use mixdog_core_api::domain::provider::StreamEvent;

    let case = json!({ "provider": "openai", "model": "gpt-5" });
    let completed = || StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None };
    let now = Arc::new(std::sync::atomic::AtomicI64::new(10_000));
    let clock = Arc::clone(&now);
    let accounting = SendAccounting::new(identity(&case, 10_000), Arc::new(Unpriced), Some(Arc::new(Collect::default())))
        .with_sources(Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst)), Arc::new(|| "<random>".into()));
    let mut sink = RecordingSink::collecting().with_accounting(accounting);
    sink.event(StreamEvent::TextDelta("hi".into()));
    sink.event(completed());
    now.store(12_345, std::sync::atomic::Ordering::SeqCst);
    let recorded = sink.finish_accounting(Outcome::Completed(Completed { stream_ended_at: 12_000, ..Completed::default() })).await;
    assert_eq!(recorded.and_then(|r| r.request_ms), Some(2_345));
    assert_eq!(
        sink.events(),
        [StreamEvent::TextDelta("hi".into()), StreamEvent::Completed { stop: None, pricing_model: None, request_ms: Some(2_345) }]
    );

    let mut unledgered = RecordingSink::collecting().with_accounting(SendAccounting::new(identity(&case, 10_000), Arc::new(Unpriced), None));
    unledgered.event(completed());
    unledgered.finish_accounting(Outcome::Completed(Completed::default())).await;
    assert_eq!(unledgered.events(), [completed()]);
    assert!(RecordingSink::collecting().finish_accounting(Outcome::Completed(Completed::default())).await.is_none());
}

#[test]
fn a_status_follows_failed_then_substituted_then_retried() {
    assert_eq!(usage_request_status(true, true, 3), "failed");
    assert_eq!(usage_request_status(false, true, 3), "substituted");
    assert_eq!(usage_request_status(false, false, 2), "retried");
    assert_eq!(usage_request_status(false, false, 1), "completed");
    assert!(!served_model_substituted("openai", "gpt-5", "openai/gpt-5-2026-01-01", false));
    assert!(served_model_substituted("openai", "gpt-5", "gpt-5-mini", false));
    assert!(!served_model_substituted("gemini-x", "a", "b", true));
}

mod through_the_registry {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicI64, Ordering};

    use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
    use mixdog_core_api::domain::provider::{
        ErrorResponse, ModelRequest, ModelStream, ProviderAdapter, RequestOptions, SendEnd, StreamEvent, WireCodec, WireDecoder, WireRequest,
    };
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_protocol::ProviderId;

    use super::*;
    use crate::registry::accounted::AccountingDeps;
    use crate::registry::providers::{ProviderBuilder, ProviderRegistry};

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

    struct Scripted(Mutex<VecDeque<Result<StreamEvent, ProviderError>>>);

    #[async_trait]
    impl ModelStream for Scripted {
        async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
            self.0.lock().unwrap().pop_front()
        }
        fn delivery(&self) -> DeliveryState {
            DeliveryState::Accepted
        }
        fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
    }

    struct Provider {
        id: ProviderId,
        policy: RetryPolicy,
        keepalive: KeepaliveSchedule,
        /// One script per attempt, in order.
        script: Mutex<VecDeque<Script>>,
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
        async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            let script = self.script.lock().unwrap().pop_front().unwrap();
            Ok(Box::new(Scripted(Mutex::new(script.into()))))
        }
    }

    struct Builder(Mutex<Vec<Script>>);

    #[async_trait]
    impl ProviderBuilder for Builder {
        async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(Arc::new(Provider {
                id: ProviderId::from(name),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                script: Mutex::new(std::mem::take(&mut *self.0.lock().unwrap()).into()),
            }))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// A send as the turn makes it: through the provider the registry hands out. The ledger row is
    /// Node's for the same send, and it is written before the terminal event is released.
    #[tokio::test]
    async fn a_registry_send_writes_nodes_row_before_it_releases_completed_with_the_duration() {
        let _ = mixdog_js::time::set_process_zone(Tz::UTC);
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let mut replayed = 0;
        for case in golden["cases"].as_array().unwrap() {
            let end = &case["end"];
            let plain = ["model", "responseId", "fallback", "generationMs"].iter().all(|k| end.get(k).is_none())
                && case.get("abandoned").is_none()
                && case.get("ownerSessionId").is_none()
                && case["provider"] != "anthropic"
                && end["kind"] != "cancelled";
            if !plain {
                continue;
            }
            let started_at = case["startedAt"].as_i64().unwrap();
            let stream_ms = end.get("streamMs").and_then(Value::as_i64).unwrap_or(1500);
            let usage = end.get("usage").map(usage_of);
            let script: Script = if end["kind"] == "completed" {
                usage
                    .clone()
                    .map(StreamEvent::Usage)
                    .into_iter()
                    .chain([StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None }])
                    .map(Ok)
                    .collect()
            } else {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Ambiguous);
                error.partial_usage = usage.map(Box::new);
                vec![Err(error)]
            };
            let sink = Arc::new(Collect::default());
            let ledger: Arc<dyn UsageSink> = sink.clone();
            let calls = Arc::new(AtomicI64::new(0));
            let mut deps = AccountingDeps::new(Arc::new(Unpriced), Arc::new(move || Some(ledger.clone())));
            deps.now = Arc::new(move || started_at + if calls.fetch_add(1, Ordering::SeqCst) == 0 { 0 } else { stream_ms });
            deps.new_id = Arc::new(|| "<req>".into());
            deps.account = Arc::new(DefaultAccount);
            let registry = ProviderRegistry::new(Arc::new(Builder(Mutex::new(vec![script])))).with_accounting(deps);
            let provider = case["provider"].as_str().unwrap();
            registry.init_providers(&crate::service::admin_route::ensure_provider_enabled(&Map::new(), provider)).await.unwrap();
            let adapter = registry.get(provider).await.unwrap();
            let request = ModelRequest {
                model: case["model"].as_str().unwrap().into(),
                messages: Vec::new(),
                tools: Vec::new(),
                options: RequestOptions {
                    session_id: Some(case["sessionId"].as_str().unwrap_or("session-1").into()),
                    request_kind: Some("lead".into()),
                    ..RequestOptions::default()
                },
            };
            let mut stream = adapter.attempt(Arc::new(request)).await.unwrap();
            let mut released = None;
            while let Some(step) = stream.next().await {
                match step {
                    Ok(StreamEvent::Completed { request_ms, .. }) => {
                        assert_eq!(sink.0.lock().unwrap().len(), 1, "{}: the row is written before Completed", case["name"]);
                        released = Some(request_ms);
                    }
                    Ok(_) => assert!(sink.0.lock().unwrap().is_empty(), "{}", case["name"]),
                    Err(_) => assert_eq!(sink.0.lock().unwrap().len(), 1, "{}", case["name"]),
                }
            }
            let rows: Vec<Value> = sink.0.lock().unwrap().iter().map(|row| serde_json::to_value(row).unwrap()).collect();
            assert_eq!(&rows, case["rows"].as_array().unwrap(), "{}", case["name"]);
            if end["kind"] == "completed" {
                assert_eq!(released, Some(Some(stream_ms as u64)), "{}: Completed carries the ledger's duration", case["name"]);
            } else {
                assert_eq!(released, None);
            }
            replayed += 1;
        }
        assert_eq!(replayed, 7);
    }

    struct DefaultAccount;
    #[async_trait]
    impl crate::registry::accounted::AccountOf for DefaultAccount {
        async fn of(&self, _: &str) -> Result<String, String> {
            Ok("default".into())
        }
    }

    /// The roster's current account, switchable.
    struct Roster(Mutex<String>);
    #[async_trait]
    impl crate::registry::accounted::AccountOf for Roster {
        async fn of(&self, _: &str) -> Result<String, String> {
            Ok(self.0.lock().unwrap().clone())
        }
    }

    /// `usage-accounting.mjs:161` reads `currentProviderAccountId` while the row is built, after
    /// the send: an account switched mid-request is the one recorded. A provider without
    /// accounts records none.
    #[tokio::test]
    async fn the_row_records_the_account_current_when_it_is_written() {
        for (provider, want) in [("openai-oauth", "second"), ("openai", "")] {
            let sink = Arc::new(Collect::default());
            let ledger: Arc<dyn UsageSink> = sink.clone();
            let roster = Arc::new(Roster(Mutex::new("first".into())));
            let mut deps = AccountingDeps::new(Arc::new(Unpriced), Arc::new(move || Some(ledger.clone())));
            deps.account = roster.clone();
            let script: Script = vec![
                Ok(StreamEvent::Usage(usage_of(&json!({"inputTokens": 10, "outputTokens": 5})))),
                Ok(StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None }),
            ];
            let registry = ProviderRegistry::new(Arc::new(Builder(Mutex::new(vec![script])))).with_accounting(deps);
            registry.init_providers(&crate::service::admin_route::ensure_provider_enabled(&Map::new(), provider)).await.unwrap();
            let adapter = registry.get(provider).await.unwrap();
            let request = ModelRequest {
                model: "m".into(),
                messages: Vec::new(),
                tools: Vec::new(),
                options: RequestOptions { session_id: Some("s".into()), request_kind: Some("lead".into()), ..RequestOptions::default() },
            };
            let mut stream = adapter.attempt(Arc::new(request)).await.unwrap();
            *roster.0.lock().unwrap() = "second".into();
            while stream.next().await.is_some() {}
            let rows = rows_of_sink(&sink);
            assert_eq!(rows.len(), 1, "{provider}");
            assert_eq!(rows[0]["account"], want, "{provider}");
        }
    }

    /// The host's scope: the request's own, plus the session this one runs for.
    struct OwnerScope(Option<String>);
    impl crate::registry::accounted::SendScope for OwnerScope {
        fn of(&self, provider: &str, request: &ModelRequest) -> crate::registry::accounted::Scope {
            let mut scope = crate::registry::accounted::RequestScope.of(provider, request);
            scope.owner_session_id = self.0.clone();
            scope
        }
    }

    /// The registry-path adapter for a golden case, with one script per attempt.
    async fn adapter_for(case: &Value, scripts: Vec<Script>) -> (Arc<dyn ProviderAdapter>, Arc<Collect>) {
        let started_at = case["startedAt"].as_i64().unwrap();
        let stream_ms = case["end"].get("streamMs").and_then(Value::as_i64).unwrap_or(1500);
        let sink = Arc::new(Collect::default());
        let ledger: Arc<dyn UsageSink> = sink.clone();
        let calls = Arc::new(AtomicI64::new(0));
        let mut deps = AccountingDeps::new(Arc::new(Unpriced), Arc::new(move || Some(ledger.clone())));
        deps.now = Arc::new(move || started_at + if calls.fetch_add(1, Ordering::SeqCst) == 0 { 0 } else { stream_ms });
        deps.new_id = Arc::new(|| "<req>".into());
        deps.account = Arc::new(DefaultAccount);
        deps.scope = Arc::new(OwnerScope(case.get("ownerSessionId").and_then(Value::as_str).map(str::to_owned)));
        let registry = ProviderRegistry::new(Arc::new(Builder(Mutex::new(scripts)))).with_accounting(deps);
        let provider = case["provider"].as_str().unwrap();
        registry.init_providers(&crate::service::admin_route::ensure_provider_enabled(&Map::new(), provider)).await.unwrap();
        (registry.get(provider).await.unwrap(), sink)
    }

    fn request_for(case: &Value, group: Option<&str>) -> Arc<ModelRequest> {
        Arc::new(ModelRequest {
            model: case["model"].as_str().unwrap().into(),
            messages: Vec::new(),
            tools: Vec::new(),
            options: RequestOptions {
                session_id: Some(case["sessionId"].as_str().unwrap_or("session-1").into()),
                request_kind: Some("lead".into()),
                send_group: group.map(str::to_owned),
                ..RequestOptions::default()
            },
        })
    }

    fn rows_of_sink(sink: &Collect) -> Vec<Value> {
        sink.0.lock().unwrap().iter().map(|row| serde_json::to_value(row).unwrap()).collect()
    }

    /// Attempts of one send group (the loop's retries of a billed failure) land in one ledger
    /// row: the retried attempts as abandoned rows, the send's own row with `attempts` and the
    /// `retried` status, exactly Node's rows for the same send. Nothing is written until the
    /// group's last attempt ends.
    #[tokio::test]
    async fn the_retried_attempts_of_one_send_group_fold_into_nodes_rows() {
        let _ = mixdog_js::time::set_process_zone(Tz::UTC);
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let mut replayed = 0;
        for case in golden["cases"].as_array().unwrap() {
            let end = &case["end"];
            let Some(abandoned) = case.get("abandoned").and_then(Value::as_array) else { continue };
            if ["model", "responseId", "fallback", "generationMs"].iter().any(|k| end.get(k).is_some()) {
                continue;
            }
            let billed = |attempt: &Value| {
                let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::Accepted);
                error.partial_usage = Some(Box::new(usage_of(&attempt["usage"])));
                error.partial_model = attempt.get("model").and_then(Value::as_str).map(Box::from);
                Err(error)
            };
            let mut scripts: Vec<Script> = abandoned.iter().map(|a| vec![billed(a)]).collect();
            let usage = end.get("usage").map(usage_of);
            scripts.push(match end["kind"].as_str().unwrap() {
                "completed" => usage
                    .clone()
                    .map(StreamEvent::Usage)
                    .into_iter()
                    .chain([StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None }])
                    .map(Ok)
                    .collect(),
                "cancelled" => usage.clone().map(StreamEvent::Usage).into_iter().map(Ok).collect(),
                _ => {
                    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Ambiguous);
                    error.partial_usage = usage.map(Box::new);
                    vec![Err(error)]
                }
            });
            let (adapter, sink) = adapter_for(case, scripts).await;
            for _ in abandoned {
                let mut stream = adapter.attempt(request_for(case, Some("g1"))).await.unwrap();
                assert!(matches!(stream.next().await, Some(Err(_))), "{}", case["name"]);
                assert!(sink.0.lock().unwrap().is_empty(), "{}: a retried attempt writes nothing yet", case["name"]);
            }
            let mut stream = adapter.attempt(request_for(case, Some("g1"))).await.unwrap();
            match end["kind"].as_str().unwrap() {
                "completed" => while stream.next().await.is_some() {},
                "failed" => {
                    assert!(matches!(stream.next().await, Some(Err(_))));
                    assert!(sink.0.lock().unwrap().is_empty(), "the last failure waits for the loop's verdict");
                    adapter.settle_send("g1", SendEnd::Surfaced).await;
                }
                _ => {
                    // The user cancelled mid-stream: the dropped stream records what it showed.
                    if end.get("usage").is_some() {
                        stream.next().await;
                    }
                    drop(stream);
                    for _ in 0..100 {
                        tokio::task::yield_now().await;
                    }
                }
            }
            assert_eq!(&rows_of_sink(&sink), case["rows"].as_array().unwrap(), "{}", case["name"]);
            replayed += 1;
        }
        assert_eq!(replayed, 3);
    }

    /// Node writes no request row for a send aborted before it produced anything
    /// (`cancelled without usage`): nothing for an attempt dropped before its stream exists, nothing
    /// for a stream dropped before it showed usage, and a cancel of a group that was between
    /// attempts records only the retried attempt's billed usage.
    #[tokio::test]
    async fn a_send_aborted_before_any_usage_writes_no_request_row() {
        let _ = mixdog_js::time::set_process_zone(Tz::UTC);
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        let quiet = cases.iter().find(|c| c["name"] == "cancelled without usage").unwrap();
        assert_eq!(quiet["rows"], json!([]));

        // Before the stream exists: the attempt future is dropped while the provider connects.
        let (adapter, sink) = adapter_for(quiet, vec![vec![]]).await;
        let pending = mixdog_rt::time::timeout(std::time::Duration::from_millis(1), async {
            std::future::pending::<()>().await;
            adapter.attempt(request_for(quiet, None)).await
        })
        .await;
        assert!(pending.is_err());
        // After the stream exists, before any usage.
        let mut stream = adapter.attempt(request_for(quiet, None)).await.unwrap();
        drop(stream.next());
        drop(stream);
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(rows_of_sink(&sink), Vec::<Value>::new());

        // Between attempts: the cancel records the retried attempt's usage and no request row.
        let retried = cases.iter().find(|c| c["name"] == "cancelled after an abandoned attempt").unwrap();
        let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::Accepted);
        error.partial_usage = Some(Box::new(usage_of(&retried["abandoned"][0]["usage"])));
        let (adapter, sink) = adapter_for(retried, vec![vec![Err(error)]]).await;
        let mut stream = adapter.attempt(request_for(retried, Some("g1"))).await.unwrap();
        assert!(matches!(stream.next().await, Some(Err(_))));
        adapter.settle_send("g1", SendEnd::Cancelled).await;
        let rows = rows_of_sink(&sink);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], retried["rows"][0]);
    }
}