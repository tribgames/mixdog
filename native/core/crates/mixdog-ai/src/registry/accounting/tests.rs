//! The rows of every send outcome against the rows Node writes
//! (`benchmarks/rust-core/recorders/record-usage-accounting.mjs`): completed, cancelled and failed
//! sends, abandoned attempts included.

use std::sync::Mutex;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::UsdTicks;
use serde_json::Map;

use super::*;

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
    let store =
        crate::accounts::AccountStore::new(dir.path().to_path_buf(), crate::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
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
    assert_eq!(sink.events(), [StreamEvent::TextDelta("hi".into()), StreamEvent::Completed { stop: None, pricing_model: None, request_ms: Some(2_345) }]);

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
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::Ordering;

    use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
    use mixdog_core_api::domain::provider::SendEnd;
    use mixdog_core_api::domain::provider::{
        ErrorResponse, ModelRequest, ModelStream, ProviderAdapter, RequestOptions, StreamEvent, WireCodec, WireDecoder, WireRequest,
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

    fn rows_of_sink(sink: &Collect) -> Vec<Value> {
        sink.0.lock().unwrap().iter().map(|row| serde_json::to_value(row).unwrap()).collect()
    }

    /// The registry path with `scripts` (one per attempt) and a clock that reads 1.5 s later at the end of a send.
    async fn inline_adapter(scripts: Vec<Script>) -> (Arc<dyn ProviderAdapter>, Arc<Collect>) {
        let sink = Arc::new(Collect::default());
        let ledger: Arc<dyn UsageSink> = sink.clone();
        let calls = Arc::new(AtomicI64::new(0));
        let mut deps = AccountingDeps::new(Arc::new(Unpriced), Arc::new(move || Some(ledger.clone())));
        deps.now = Arc::new(move || STARTED + if calls.fetch_add(1, Ordering::SeqCst) == 0 { 0 } else { 1500 });
        deps.new_id = Arc::new(|| "<req>".into());
        deps.account = Arc::new(Roster(Mutex::new("default".into())));
        let registry = ProviderRegistry::new(Arc::new(Builder(Mutex::new(scripts)))).with_accounting(deps);
        registry.init_providers(&crate::service::admin_route::ensure_provider_enabled(&Map::new(), "anthropic")).await.unwrap();
        (registry.get("anthropic").await.unwrap(), sink)
    }

    fn inline_request(group: Option<&str>) -> Arc<ModelRequest> {
        Arc::new(ModelRequest {
            model: "claude-x".into(),
            messages: Vec::new(),
            tools: Vec::new(),
            options: RequestOptions {
                session_id: Some("session-1".into()),
                request_kind: Some("lead".into()),
                send_group: group.map(str::to_owned),
                ..RequestOptions::default()
            },
        })
    }

    fn completed_script(input: u64, output: u64) -> Script {
        vec![
            Ok(StreamEvent::Usage(usage_of(&json!({ "inputTokens": input, "outputTokens": output })))),
            Ok(StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None }),
        ]
    }

    fn billed_failure(input: u64, output: u64) -> Script {
        let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::Accepted);
        error.partial_usage = Some(Box::new(usage_of(&json!({ "inputTokens": input, "outputTokens": output }))));
        vec![Err(error)]
    }

    async fn settle_in_the_background() {
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
    }

    /// The row is in the ledger before the terminal event is released, and that event carries the row's measured time.
    #[tokio::test]
    async fn a_registry_send_writes_its_row_before_it_releases_completed_with_the_duration() {
        let (adapter, sink) = inline_adapter(vec![completed_script(100, 20)]).await;
        let mut stream = adapter.attempt(inline_request(None)).await.unwrap();
        let mut released = None;
        while let Some(step) = stream.next().await {
            match step.unwrap() {
                StreamEvent::Completed { request_ms, .. } => {
                    assert_eq!(sink.0.lock().unwrap().len(), 1, "the row is written before Completed");
                    released = Some(request_ms);
                }
                _ => assert!(sink.0.lock().unwrap().is_empty(), "nothing is written while the send runs"),
            }
        }
        assert_eq!(released, Some(Some(1500)));
        let row = sink.0.lock().unwrap()[0].clone();
        assert_eq!((row.status.as_str(), row.input, row.output, row.duration_ms), ("completed", 100.0, 20.0, 1500.0));
    }

    /// Attempts of one send group land in one set of rows: each retried attempt as its own row, the send's own row with
    /// the attempt count and `retried`. Nothing is written until the group's last attempt ends.
    #[tokio::test]
    async fn the_retried_attempts_of_one_send_group_fold_into_one_set_of_rows() {
        let (adapter, sink) = inline_adapter(vec![billed_failure(10, 1), billed_failure(20, 2), completed_script(100, 20)]).await;
        for _ in 0..2 {
            let mut stream = adapter.attempt(inline_request(Some("g1"))).await.unwrap();
            assert!(matches!(stream.next().await, Some(Err(_))));
            assert!(sink.0.lock().unwrap().is_empty(), "a retried attempt writes nothing yet");
        }
        let mut stream = adapter.attempt(inline_request(Some("g1"))).await.unwrap();
        while stream.next().await.is_some() {}
        let rows = sink.0.lock().unwrap().clone();
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[0].input, rows[1].input, rows[2].input), (10.0, 20.0, 100.0));
        assert_eq!((rows[2].status.as_str(), rows[2].attempts), ("retried", 3));
    }

    /// The last failure of a group waits for the loop's verdict; once the failure is surfaced it is booked as a failed request.
    #[tokio::test]
    async fn the_last_failure_of_a_group_is_booked_when_the_loop_surfaces_it() {
        let (adapter, sink) = inline_adapter(vec![billed_failure(40, 3)]).await;
        let mut stream = adapter.attempt(inline_request(Some("g1"))).await.unwrap();
        assert!(matches!(stream.next().await, Some(Err(_))));
        assert!(sink.0.lock().unwrap().is_empty());
        adapter.settle_send("g1", SendEnd::Surfaced).await;
        let rows = sink.0.lock().unwrap().clone();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].status.as_str(), rows[0].input, rows[0].output), ("failed", 40.0, 3.0));
    }

    /// A send aborted before it produced anything writes no request row, and a cancel between attempts books only the
    /// retried attempt's usage.
    #[tokio::test]
    async fn an_aborted_inline_send_writes_no_request_row() {
        let (adapter, sink) = inline_adapter(vec![vec![]]).await;
        let mut stream = adapter.attempt(inline_request(None)).await.unwrap();
        drop(stream.next());
        drop(stream);
        settle_in_the_background().await;
        assert!(sink.0.lock().unwrap().is_empty());

        let (adapter, sink) = inline_adapter(vec![billed_failure(10, 1)]).await;
        let mut stream = adapter.attempt(inline_request(Some("g1"))).await.unwrap();
        assert!(matches!(stream.next().await, Some(Err(_))));
        adapter.settle_send("g1", SendEnd::Cancelled).await;
        let rows = sink.0.lock().unwrap().clone();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].input, rows[0].output), (10.0, 1.0));
    }
}

// ---- the rows of one send, with inline usage ------------------------------------------------------------------------

struct DefaultRoster;

#[async_trait]
impl crate::registry::accounted::AccountOf for DefaultRoster {
    async fn of(&self, _: &str) -> Result<String, String> {
        Ok("default".into())
    }
}

const STARTED: i64 = 1_700_000_000_000;

/// One send of `anthropic`/`claude-x` whose clock reads `STARTED + 1500` at its end.
fn send(inclusive: bool) -> (SendAccounting, Arc<Collect>) {
    let sink = Arc::new(Collect::default());
    let case = json!({ "provider": "anthropic", "model": "claude-x", "inputExcludesCache": !inclusive });
    let accounting = SendAccounting::new(identity(&case, STARTED), Arc::new(Unpriced), Some(sink.clone()))
        .with_sources(Arc::new(|| STARTED + 1500), Arc::new(|| "<random>".into()))
        .with_account(Arc::new(DefaultRoster));
    (accounting, sink)
}

fn completed(usage: &Value) -> Outcome<'static> {
    Outcome::Completed(Completed { facts: Some(Facts::from(&usage_of(usage))), stream_ended_at: STARTED + 1500, ..Completed::default() })
}

fn rows(sink: &Collect) -> Vec<UsageRow> {
    sink.0.lock().unwrap().clone()
}

#[tokio::test]
async fn a_completed_send_writes_one_row_with_its_tokens_and_its_measured_time() {
    let (accounting, sink) = send(true);
    let recorded = accounting.finish(completed(&json!({ "inputTokens": 100, "outputTokens": 20, "cachedTokens": 30 }))).await;
    assert_eq!(recorded, Recorded { error: None, request_ms: Some(1500) });
    let rows = rows(&sink);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!((row.provider.as_str(), row.model.as_str(), row.status.as_str(), row.attempts), ("anthropic", "claude-x", "completed", 1));
    assert_eq!((row.output, row.cache_read, row.cache_write), (20.0, 30.0, 0.0));
    assert_eq!(row.input, 70.0, "an input that includes the cache is billed without it");
    assert_eq!(row.cost_source, "unpriced", "a model the catalog does not know has no cost");
}

#[tokio::test]
async fn a_completed_cursor_request_preserves_whether_usage_reported_its_zero_output() {
    let case = json!({ "provider": "cursor-api", "model": "m" });
    let sink = Arc::new(Collect::default());
    let accounting = SendAccounting::new(identity(&case, STARTED), Arc::new(Unpriced), Some(sink.clone()))
        .with_sources(Arc::new(|| STARTED + 1500), Arc::new(|| "<random>".into()));
    let zero = Usage {
        raw: Some(json!({
            "input_tokens_known": false, "cache_tokens_known": false,
            "context_tokens": null, "completion_tokens": 0,
        })),
        ..Usage::default()
    };
    for (facts, expected) in [(None, json!(false)), (Some(Facts::from(&zero)), Value::Null)] {
        accounting.finish(Outcome::Completed(Completed { facts, stream_ended_at: STARTED + 1500, ..Completed::default() })).await;
        let row = rows(&sink).pop().unwrap();
        let rates: Value = serde_json::from_str(row.rates.as_deref().unwrap()).unwrap();
        assert_eq!(row.output, 0.0);
        assert_eq!(rates["outputTokensKnown"], expected);
    }
}

#[tokio::test]
async fn an_input_that_excludes_the_cache_is_billed_whole() {
    let (accounting, sink) = send(false);
    accounting.finish(completed(&json!({ "inputTokens": 100, "outputTokens": 20, "cachedTokens": 30 }))).await;
    assert_eq!(rows(&sink)[0].input, 100.0);
}

#[tokio::test]
async fn attempts_the_broker_retried_are_billed_as_their_own_rows_and_the_final_row_says_retried() {
    let (mut accounting, sink) = send(true);
    accounting.note_abandoned(&usage_of(&json!({ "inputTokens": 10, "outputTokens": 1 })), None);
    accounting.note_abandoned(&usage_of(&json!({ "inputTokens": 20, "outputTokens": 2 })), None);
    accounting.finish(completed(&json!({ "inputTokens": 100, "outputTokens": 20 }))).await;
    let rows = rows(&sink);
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["<req>:abandoned:0", "<req>:abandoned:1", "<req>"]);
    assert_eq!((rows[0].input, rows[1].input, rows[2].input), (10.0, 20.0, 100.0), "each attempt keeps its own usage");
    assert_eq!((rows[2].status.as_str(), rows[2].attempts), ("retried", 3));
}

#[tokio::test]
async fn an_abandoned_attempt_that_used_nothing_writes_no_row() {
    let (mut accounting, sink) = send(true);
    accounting.note_abandoned(&usage_of(&json!({})), None);
    accounting.finish(completed(&json!({ "inputTokens": 5, "outputTokens": 1 }))).await;
    assert_eq!(rows(&sink).len(), 1);
    assert_eq!(rows(&sink)[0].attempts, 2, "the attempt still counts");
}

#[tokio::test]
async fn a_failed_send_is_a_request_with_the_usage_the_provider_reported_or_with_zero_tokens() {
    let (accounting, sink) = send(true);
    accounting.finish(Outcome::Failed(&ProviderError::new(ErrorKind::Unknown, DeliveryState::Ambiguous))).await;
    let row = rows(&sink).remove(0);
    assert_eq!((row.status.as_str(), row.input, row.output), ("failed", 0.0, 0.0));

    let (accounting, sink) = send(true);
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Ambiguous);
    error.partial_usage = Some(Box::new(usage_of(&json!({ "inputTokens": 40, "outputTokens": 3 }))));
    accounting.finish(Outcome::Failed(&error)).await;
    let row = rows(&sink).remove(0);
    assert_eq!((row.status.as_str(), row.input, row.output), ("failed", 40.0, 3.0));
}

#[tokio::test]
async fn a_cancelled_send_is_recorded_only_when_the_stream_had_shown_usage() {
    let (accounting, sink) = send(true);
    accounting.finish(Outcome::Cancelled { reported: None, model: None }).await;
    assert!(rows(&sink).is_empty());

    let (accounting, sink) = send(true);
    let shown = Facts::from(&usage_of(&json!({ "inputTokens": 7, "outputTokens": 2 })));
    accounting.finish(Outcome::Cancelled { reported: Some(shown), model: None }).await;
    let row = rows(&sink).remove(0);
    assert_eq!((row.status.as_str(), row.input, row.output), ("cancelled", 7.0, 2.0));
}
