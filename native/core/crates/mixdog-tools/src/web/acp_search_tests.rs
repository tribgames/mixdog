//! ACP web-search dispatch seam: unwired backend reports unavailable, wired backend normalizes
//! results and accounts usage through the same ledger/sink path as hosted search, zero `search_web`
//! calls is always a failure, and mixed hosted+ACP chains honor capacity fallback vs immediate
//! surfacing for sign-in, refusal, not-installed and cancellation.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ai::admission::Admission;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::catalog::PricedUsage;
use mixdog_ai::catalog::UsageArgs;
use mixdog_ai::registry::accounted::AccountOf;
use mixdog_ai::registry::accounting::UsagePricing;
use mixdog_ai::registry::accounting::UsageRow;
use mixdog_ai::registry::accounting::UsageSink;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::MockCodec;
use mixdog_core_api::domain::provider::*;
use mixdog_core_api::domain::retry::Decision;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::AcpSearchBackend;
use super::AcpSearchError;
use super::AcpSearchReply;
use super::AcpSearchRequest;
use super::ConfiguredSearchRoutes;
use super::HostedWebSearch;
use super::NativeSearchError;
use super::NativeSearchRequest;
use super::NativeSource;
use super::NativeWebSearch;
use super::ProviderSearchSender;
use super::SearchCall;
use super::SearchHost;
use super::SearchProvider;
use super::SenderDeps;
use super::cache::NodeCache;
use super::hosted_usage::NativeSearchUsageSinks;
use super::search::SearchArgs;
use super::search::SearchService;

struct Unpriced;
impl UsagePricing for Unpriced {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        let input = if args.input_tokens_inclusive == Some(true) {
            (args.input_tokens - args.cache_read_tokens - args.cache_write_tokens).max(0.0)
        } else {
            args.input_tokens
        };
        PricedUsage { input, cost_usd: None, rates: Map::new() }
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

struct DefaultAccounts;

#[async_trait]
impl AccountOf for DefaultAccounts {
    async fn of(&self, _: &str) -> Result<String, String> {
        Ok("default".to_owned())
    }
}

struct Surface;
impl RetryDecider for Surface {
    fn verdict(&self, error: &ProviderError, state: &RetryState, _: &RetryPolicy, _: JitterSamples) -> Decision {
        Decision { verdict: Verdict::Surface, next: state.after_failure(error.kind) }
    }
}

struct ScriptedStream(VecDeque<Result<StreamEvent, ProviderError>>);

#[async_trait]
impl ModelStream for ScriptedStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        self.0.pop_front()
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
}

struct HostedStub {
    id: ProviderId,
    codec: MockCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    replies: Arc<Mutex<VecDeque<Result<Vec<StreamEvent>, ProviderError>>>>,
    seen: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl ProviderAdapter for HostedStub {
    fn release_send(&self, _: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.seen.lock().unwrap().push(format!("{}/{}", self.id.as_str(), request.model));
        let events = self.replies.lock().unwrap().pop_front().expect("scripted hosted reply")?;
        Ok(Box::new(ScriptedStream(events.into_iter().map(Ok).collect())))
    }
}

struct MixedHost {
    main: Value,
    stored: Value,
    hosted_replies: Arc<Mutex<VecDeque<Result<Vec<StreamEvent>, ProviderError>>>>,
    hosted_seen: Arc<Mutex<Vec<String>>>,
    acp_ready_error: Option<String>,
}

#[async_trait]
impl SearchHost for MixedHost {
    fn main_route(&self, _: &ThreadId) -> Value {
        self.main.clone()
    }
    fn stored_web_search_route(&self) -> Value {
        self.stored.clone()
    }
    async fn main_model_row(&self, provider: &str, model: &str) -> Result<Option<Value>, String> {
        Ok(Some(json!({ "id": model, "provider": provider, "supportsWebSearch": true })))
    }
    fn catalog_row(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    async fn provider(&self, provider: &str) -> Result<Option<SearchProvider>, String> {
        if matches!(provider, "acp-antigravity" | "acp-antigravity-cli") {
            if let Some(error) = &self.acp_ready_error {
                return Err(error.clone());
            }
            return Ok(Some(SearchProvider::Acp));
        }
        Ok(Some(SearchProvider::Hosted(Arc::new(HostedStub {
            id: ProviderId::from(provider),
            codec: MockCodec,
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            replies: self.hosted_replies.clone(),
            seen: self.hosted_seen.clone(),
        }))))
    }
    fn session_id(&self, thread: &ThreadId) -> Option<String> {
        Some(thread.as_str().to_owned())
    }
}

struct ScriptedAcpBackend {
    replies: Mutex<VecDeque<Result<AcpSearchReply, AcpSearchError>>>,
    seen: Mutex<Vec<AcpSearchRequest>>,
}

impl ScriptedAcpBackend {
    fn new(replies: impl IntoIterator<Item = Result<AcpSearchReply, AcpSearchError>>) -> Arc<Self> {
        Arc::new(Self { replies: Mutex::new(replies.into_iter().collect()), seen: Mutex::default() })
    }
}

#[async_trait]
impl AcpSearchBackend for ScriptedAcpBackend {
    async fn search(&self, request: AcpSearchRequest, cancel: &CancellationToken) -> Result<AcpSearchReply, AcpSearchError> {
        self.seen.lock().unwrap().push(request);
        if cancel.is_cancelled() {
            return Err(AcpSearchError::cancelled("aborted before send"));
        }
        self.replies.lock().unwrap().pop_front().expect("scripted ACP reply")
    }
}

fn sender_deps(ledger: Arc<Ledger>, sinks: Arc<NativeSearchUsageSinks>) -> SenderDeps {
    let broker = Arc::new(ModelBroker::new(Arc::new(Admission::new()), Arc::new(Surface)));
    let clock = Arc::new(AtomicI64::new(1_700_000_000_000));
    SenderDeps {
        broker: broker.clone(),
        pricing: Arc::new(Unpriced),
        ledger: Some(ledger),
        sinks,
        lane: SenderDeps::default_lane(&broker),
        account: Arc::new(DefaultAccounts),
        now: Arc::new(move || clock.fetch_add(10, Ordering::SeqCst)),
    }
}

fn search_request() -> NativeSearchRequest {
    NativeSearchRequest {
        thread: ThreadId::from("thread-acp"),
        query: "rust release".into(),
        site: Some("rust-lang.org".into()),
        locale: Some(json!("en-US")),
        context_size: "medium".into(),
        max_results: 3,
        prompt: "Search rust release".into(),
    }
}

#[tokio::test]
async fn unwired_acp_backend_reports_unavailable() {
    let host = Arc::new(MixedHost {
        main: json!({ "provider": "acp-antigravity", "model": "gemini-3-flash" }),
        stored: json!({ "provider": "default", "model": "default" }),
        hosted_replies: Arc::default(),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let ledger = Arc::new(Ledger::default());
    let sinks = NativeSearchUsageSinks::new();
    let search = HostedWebSearch::new(ConfiguredSearchRoutes::new(host.clone()), ProviderSearchSender::new(host, sender_deps(ledger.clone(), sinks)));

    let err = search.search(search_request(), CancellationToken::new()).await.unwrap_err();
    assert!(matches!(err, NativeSearchError::Unavailable(ref msg) if msg.contains("acp-antigravity")), "{err:?}");
    assert!(ledger.0.lock().unwrap().is_empty(), "an unwired backend writes no ledger row");
}

#[tokio::test]
async fn unavailable_acp_candidate_falls_through_to_next_candidate_and_fails_unavailable_only_when_none_ran() {
    let hosted_ok = |text: &str| {
        vec![
            StreamEvent::TextDelta(text.into()),
            StreamEvent::Citation(json!({ "url": "https://hosted.example/hit", "title": "Hit" })),
            StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
        ]
    };

    // 1. ACP primary (unwired) followed by a hosted fallback runs the hosted fallback.
    let host = Arc::new(MixedHost {
        main: json!({ "provider": "acp-antigravity", "model": "gemini-3-flash" }),
        stored: json!({
            "provider": "default",
            "model": "default",
            "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }]
        }),
        hosted_replies: Arc::new(Mutex::new(VecDeque::from([Ok(hosted_ok("From OpenAI fallback."))]))),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::new(host.clone(), sender_deps(Arc::new(Ledger::default()), NativeSearchUsageSinks::new())),
    );
    let result = search.search(search_request(), CancellationToken::new()).await.unwrap();
    assert_eq!(result.provider, "openai");
    assert_eq!(result.answer, "From OpenAI fallback.");
    assert_eq!(*host.hosted_seen.lock().unwrap(), ["openai/gpt-5.2"]);

    let rate_limited = || {
        let mut err = ProviderError::new(ErrorKind::RateLimited, DeliveryState::NotSent);
        err.status = Some(429);
        err.message = "too many requests".into();
        err
    };

    // 2. Hosted capacity failure -> unavailable ACP fallback -> second hosted fallback succeeds.
    let host = Arc::new(MixedHost {
        main: json!({}),
        stored: json!({
            "provider": "openai",
            "model": "gpt-5.2",
            "fallbacks": [
                { "provider": "acp-antigravity", "model": "gemini-3-flash" },
                { "provider": "anthropic", "model": "claude-sonnet-4-5" }
            ]
        }),
        hosted_replies: Arc::new(Mutex::new(VecDeque::from([Err(rate_limited()), Ok(hosted_ok("From Anthropic second fallback."))]))),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::new(host.clone(), sender_deps(Arc::new(Ledger::default()), NativeSearchUsageSinks::new())),
    );
    let result = search.search(search_request(), CancellationToken::new()).await.unwrap();
    assert_eq!(result.provider, "anthropic");
    assert_eq!(result.answer, "From Anthropic second fallback.");
    assert_eq!(*host.hosted_seen.lock().unwrap(), ["openai/gpt-5.2", "anthropic/claude-sonnet-4-5"]);

    // 3. Hosted capacity failure -> unavailable ACP fallback with nothing left fails (a candidate ran).
    let host = Arc::new(MixedHost {
        main: json!({}),
        stored: json!({
            "provider": "openai",
            "model": "gpt-5.2",
            "fallbacks": [{ "provider": "acp-antigravity", "model": "gemini-3-flash" }]
        }),
        hosted_replies: Arc::new(Mutex::new(VecDeque::from([Err(rate_limited())]))),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::new(host, sender_deps(Arc::new(Ledger::default()), NativeSearchUsageSinks::new())),
    );
    let err = search.search(search_request(), CancellationToken::new()).await.unwrap_err();
    assert!(matches!(err, NativeSearchError::Failed(ref msg) if msg.contains("openai/gpt-5.2")), "{err:?}");

    // 4. Multiple unavailable ACP candidates with no candidate running fail as Unavailable.
    let host = Arc::new(MixedHost {
        main: json!({}),
        stored: json!({
            "provider": "acp-antigravity",
            "model": "gemini-3-flash",
            "fallbacks": [{ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }]
        }),
        hosted_replies: Arc::default(),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::new(host, sender_deps(Arc::new(Ledger::default()), NativeSearchUsageSinks::new())),
    );
    let err = search.search(search_request(), CancellationToken::new()).await.unwrap_err();
    assert!(matches!(err, NativeSearchError::Unavailable(ref msg) if msg.contains("acp-antigravity") && msg.contains("acp-antigravity-cli")), "{err:?}");
}

#[tokio::test]
async fn acp_search_normalizes_results_accounts_ledger_and_reports_usage_delta() {
    let host = Arc::new(MixedHost {
        main: json!({ "provider": "acp-antigravity", "model": "gemini-3-flash", "effort": "high" }),
        stored: json!({ "provider": "default", "model": "default" }),
        hosted_replies: Arc::default(),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let backend = ScriptedAcpBackend::new([
        // Official server style: full summary + Sources list in citations and search_web call.
        Ok(AcpSearchReply {
            answer: "  Rust 1.90 released.  ".into(),
            model: Some("gemini-3-flash-high".into()),
            citations: vec![
                NativeSource {
                    url: "https://grounding.example/1".into(),
                    title: "rust-lang.org".into(),
                    snippet: "  Official  notes ".into(),
                    published_date: None,
                },
                NativeSource { url: "https://grounding.example/1".into(), title: "duplicate".into(), snippet: String::new(), published_date: None },
            ],
            calls: vec![SearchCall {
                query: "rust release".into(),
                sources: vec![NativeSource {
                    url: "https://grounding.example/2".into(),
                    title: "blog.rust-lang.org".into(),
                    snippet: "Announcement".into(),
                    published_date: None,
                }],
                urls: vec!["https://grounding.example/3".into(), "https://grounding.example/4".into()],
            }],
            usage: Some(Usage { input_tokens: 120, output_tokens: 45, cache_read_tokens: 30, ..Usage::default() }),
            input_excludes_cache: true,
        }),
        // agy acp style: empty tool_call_update sources, answer with no URLs -> produces no-source-URL warning.
        Ok(AcpSearchReply {
            answer: "Answer from agent_message_chunk.".into(),
            model: None,
            citations: Vec::new(),
            calls: vec![SearchCall { query: "rust release".into(), sources: Vec::new(), urls: Vec::new() }],
            usage: None,
            input_excludes_cache: false,
        }),
    ]);

    let ledger = Arc::new(Ledger::default());
    let sinks = NativeSearchUsageSinks::new();
    let deltas = Arc::new(Mutex::new(Vec::new()));
    let _release = sinks.register("thread-acp", {
        let deltas = deltas.clone();
        Arc::new(move |delta| deltas.lock().unwrap().push(delta))
    });
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::with_acp(host, sender_deps(ledger.clone(), sinks), backend.clone()),
    );
    let service = SearchService::new(Some(search), Arc::new(NodeCache::new(None)));

    let first = service
        .search(
            &SearchArgs {
                query: "rust release".into(),
                listed: false,
                site: Some("rust-lang.org".into()),
                locale: Some(json!("en-US")),
                context_size: "medium".into(),
                max_results: 3,
            },
            &ThreadId::from("thread-acp"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(first.provider, "acp-antigravity");
    assert_eq!(first.answer, "Rust 1.90 released.");
    assert_eq!(first.model.as_deref(), Some("gemini-3-flash-high"));
    // Deduplicated and truncated to max_results (3).
    let urls: Vec<&str> = first.results.iter().map(|hit| hit.url.as_str()).collect();
    assert_eq!(urls, ["https://grounding.example/1", "https://grounding.example/2", "https://grounding.example/3"]);
    assert_eq!(first.results[0].snippet, "Official notes");
    assert!(first.warnings.is_empty());
    assert_eq!(first.usage.as_ref().unwrap()["promptTokens"], json!(150));

    let seen = backend.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].provider.as_str(), seen[0].model.as_str(), seen[0].effort.as_deref()), ("acp-antigravity", "gemini-3-flash", Some("high")));
    assert_eq!(
        (seen[0].query.as_str(), seen[0].site.as_deref(), seen[0].max_results, seen[0].context_size.as_str()),
        ("rust release", Some("rust-lang.org"), 3, "medium")
    );
    drop(seen);

    let rows = ledger.0.lock().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].provider, "acp-antigravity");
    assert_eq!(rows[0].source_type, "native-web-search");
    assert_eq!(rows[0].output, 45.0);
    assert_eq!(rows[0].cache_read, 30.0);
    drop(rows);
    let recorded_deltas = deltas.lock().unwrap();
    assert_eq!(recorded_deltas.len(), 1, "asking turn hears usage delta");
    assert_eq!(recorded_deltas[0]["requestedModel"], json!("gemini-3-flash"));
    assert_eq!(recorded_deltas[0]["model"], json!("gemini-3-flash-high"));
    drop(recorded_deltas);

    let second = service
        .search(
            &SearchArgs { query: "rust release 2".into(), listed: false, site: None, locale: None, context_size: "low".into(), max_results: 5 },
            &ThreadId::from("thread-acp"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(second.answer, "Answer from agent_message_chunk.");
    assert_eq!(second.warnings, ["native web search returned no source URLs"]);
}

#[tokio::test]
async fn acp_search_without_search_web_call_is_a_failure_and_still_records_usage() {
    let host = Arc::new(MixedHost {
        main: json!({}),
        stored: json!({ "provider": "acp-antigravity", "model": "gemini-3-flash", "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }] }),
        hosted_replies: Arc::default(),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let backend = ScriptedAcpBackend::new([Ok(AcpSearchReply {
        answer: "I answered from memory without searching.".into(),
        model: None,
        citations: Vec::new(),
        calls: Vec::new(),
        usage: Some(Usage { input_tokens: 50, output_tokens: 20, ..Usage::default() }),
        input_excludes_cache: false,
    })]);
    let ledger = Arc::new(Ledger::default());
    let sinks = NativeSearchUsageSinks::new();
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::with_acp(host.clone(), sender_deps(ledger.clone(), sinks), backend),
    );

    let err = search.search(search_request(), CancellationToken::new()).await.unwrap_err();
    assert!(matches!(err, NativeSearchError::Failed(ref msg) if msg.contains("search_web")), "{err:?}");
    assert!(host.hosted_seen.lock().unwrap().is_empty(), "a no-search refusal surfaces without falling back");
    let rows = ledger.0.lock().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "failed");
    assert_eq!(rows[0].output, 20.0);
}

#[tokio::test]
async fn mixed_chain_falls_back_on_capacity_and_surfaces_sign_in_refusal_and_not_installed() {
    // 1. ACP capacity failure falls back to hosted provider.
    let hosted_ok = vec![
        StreamEvent::TextDelta("From OpenAI fallback.".into()),
        StreamEvent::Citation(json!({ "url": "https://openai.example/hit", "title": "Hit" })),
        StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
    ];
    let host = Arc::new(MixedHost {
        main: json!({}),
        stored: json!({
            "provider": "acp-antigravity",
            "model": "gemini-3-flash",
            "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }]
        }),
        hosted_replies: Arc::new(Mutex::new(VecDeque::from([Ok(hosted_ok)]))),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let backend = ScriptedAcpBackend::new([Err(AcpSearchError::capacity("429 quota exhausted"))]);
    let ledger = Arc::new(Ledger::default());
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::with_acp(host.clone(), sender_deps(ledger, NativeSearchUsageSinks::new()), backend),
    );
    let result = search.search(search_request(), CancellationToken::new()).await.unwrap();
    assert_eq!(result.provider, "openai");
    assert_eq!(result.answer, "From OpenAI fallback.");
    assert_eq!(*host.hosted_seen.lock().unwrap(), ["openai/gpt-5.2"]);

    // 2. Hosted capacity failure (429) falls back to ACP provider.
    let mut rate_limited = ProviderError::new(ErrorKind::RateLimited, DeliveryState::NotSent);
    rate_limited.status = Some(429);
    rate_limited.message = "too many requests".into();
    let host = Arc::new(MixedHost {
        main: json!({}),
        stored: json!({
            "provider": "openai",
            "model": "gpt-5.2",
            "fallbacks": [{ "provider": "acp-antigravity-cli", "model": "claude-opus-4-6" }]
        }),
        hosted_replies: Arc::new(Mutex::new(VecDeque::from([Err(rate_limited)]))),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let backend = ScriptedAcpBackend::new([Ok(AcpSearchReply {
        answer: "From ACP fallback.".into(),
        model: None,
        citations: vec![NativeSource { url: "https://acp.example/hit".into(), title: "ACP Hit".into(), snippet: String::new(), published_date: None }],
        calls: vec![SearchCall { query: "rust release".into(), sources: Vec::new(), urls: Vec::new() }],
        usage: None,
        input_excludes_cache: false,
    })]);
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::with_acp(host.clone(), sender_deps(Arc::new(Ledger::default()), NativeSearchUsageSinks::new()), backend),
    );
    let result = search.search(search_request(), CancellationToken::new()).await.unwrap();
    assert_eq!(result.provider, "acp-antigravity-cli");
    assert_eq!(result.answer, "From ACP fallback.");
    assert_eq!(*host.hosted_seen.lock().unwrap(), ["openai/gpt-5.2"]);

    // 3. Sign-in, refusal, and not-installed surface immediately without touching the fallback.
    for error in
        [AcpSearchError::sign_in("Antigravity is signed out"), AcpSearchError::refusal("account disabled"), AcpSearchError::not_installed("agy not found")]
    {
        let want = error.message.clone();
        let host = Arc::new(MixedHost {
            main: json!({}),
            stored: json!({
                "provider": "acp-antigravity",
                "model": "gemini-3-flash",
                "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }]
            }),
            hosted_replies: Arc::default(),
            hosted_seen: Arc::default(),
            acp_ready_error: None,
        });
        let backend = ScriptedAcpBackend::new([Err(error)]);
        let search = HostedWebSearch::new(
            ConfiguredSearchRoutes::new(host.clone()),
            ProviderSearchSender::with_acp(host.clone(), sender_deps(Arc::new(Ledger::default()), NativeSearchUsageSinks::new()), backend),
        );
        let got = search.search(search_request(), CancellationToken::new()).await.unwrap_err();
        assert_eq!(got, NativeSearchError::Failed(want));
        assert!(host.hosted_seen.lock().unwrap().is_empty(), "non-capacity ACP error must not try fallback");
    }

    // 4. Readiness error from SearchHost::provider (not installed / signed out) surfaces at once.
    let host = Arc::new(MixedHost {
        main: json!({}),
        stored: json!({
            "provider": "acp-antigravity",
            "model": "gemini-3-flash",
            "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }]
        }),
        hosted_replies: Arc::default(),
        hosted_seen: Arc::default(),
        acp_ready_error: Some("Antigravity is not installed".into()),
    });
    let backend = ScriptedAcpBackend::new([]);
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::with_acp(host.clone(), sender_deps(Arc::new(Ledger::default()), NativeSearchUsageSinks::new()), backend.clone()),
    );
    let got = search.search(search_request(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(got, NativeSearchError::Failed("Antigravity is not installed".into()));
    assert!(backend.seen.lock().unwrap().is_empty());
    assert!(host.hosted_seen.lock().unwrap().is_empty());

    // 5. Caller cancellation does not fall back to next candidate.
    let host = Arc::new(MixedHost {
        main: json!({}),
        stored: json!({
            "provider": "acp-antigravity",
            "model": "gemini-3-flash",
            "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }]
        }),
        hosted_replies: Arc::default(),
        hosted_seen: Arc::default(),
        acp_ready_error: None,
    });
    let backend = ScriptedAcpBackend::new([Err(AcpSearchError::capacity("rate limit"))]);
    let search = HostedWebSearch::new(
        ConfiguredSearchRoutes::new(host.clone()),
        ProviderSearchSender::with_acp(host.clone(), sender_deps(Arc::new(Ledger::default()), NativeSearchUsageSinks::new()), backend),
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    let got = search.search(search_request(), cancel).await.unwrap_err();
    assert!(matches!(got, NativeSearchError::Failed(_)), "{got:?}");
    assert!(host.hosted_seen.lock().unwrap().is_empty());
}
