use std::collections::HashMap;
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
use mixdog_ai::service::routes::web_search_provider_family;
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

use super::NativeSearchRequest;
use super::NativeWebSearch;
use super::hosted_routes::ConfiguredSearchRoutes;
use super::hosted_routes::SearchHost;
use super::hosted_search::HostedWebSearch;
use super::hosted_search::SearchRoutes;
use super::hosted_sender::ProviderSearchSender;
use super::hosted_sender::SenderDeps;
use super::hosted_usage::NativeSearchUsageSinks;

/// Prices nothing, as an empty catalog does.
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
        rates.insert("requestedModel".into(), args.requested_model.clone().map_or(Value::Null, Value::from));
        rates.insert("pricingModel".into(), json!(args.pricing_model.clone().unwrap_or_else(|| args.model.clone())));
        rates.insert("pricingProvider".into(), json!(args.provider));
        rates.insert("pricingSource".into(), Value::Null);
        if args.input_tokens_known == Some(false) {
            rates.insert("inputTokensKnown".into(), json!(false));
        }
        let reason = if args.input_tokens_known == Some(false) { "unmeasured-input" } else { "model-not-found" };
        rates.insert("unpricedReason".into(), json!(reason));
        PricedUsage { input, cost_usd: None, rates }
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

/// Every failure ends the send: the chain, not the broker, decides what happens next.
struct Surface;

impl RetryDecider for Surface {
    fn verdict(&self, error: &ProviderError, state: &RetryState, _: &RetryPolicy, _: JitterSamples) -> Decision {
        Decision { verdict: Verdict::Surface, next: state.after_failure(error.kind) }
    }
}

struct Script {
    events: VecDeque<Result<StreamEvent, ProviderError>>,
}

#[async_trait]
impl ModelStream for Script {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        self.events.pop_front()
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

/// One provider: answers the replies in order, remembers the requests, and moves
/// the clock the way a send takes time.
struct Provider {
    id: ProviderId,
    codec: MockCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    clock: Arc<AtomicI64>,
    replies: Arc<Mutex<VecDeque<Value>>>,
    requests: Arc<Mutex<Vec<(String, ModelRequest)>>>,
}

fn reply_events(reply: &Value) -> Result<Vec<StreamEvent>, ProviderError> {
    if let Some(error) = reply.get("throw") {
        let status = error["props"]["status"].as_u64().map(|status| status as u16);
        let kind = match status {
            Some(429) => ErrorKind::RateLimited,
            Some(503) => ErrorKind::Overloaded,
            Some(403) => ErrorKind::Permission,
            _ => ErrorKind::Unknown,
        };
        let mut failure = ProviderError::new(kind, DeliveryState::Accepted);
        failure.status = status;
        failure.message = error["message"].as_str().unwrap().to_owned();
        return Err(failure);
    }
    let result = &reply["result"];
    let mut events = Vec::new();
    events.push(StreamEvent::TextDelta(result["content"].as_str().unwrap().to_owned()));
    for citation in result["citations"].as_array().into_iter().flatten() {
        events.push(StreamEvent::Citation(citation.clone()));
    }
    for call in result["webSearchCalls"].as_array().into_iter().flatten() {
        events.push(StreamEvent::ServerToolBlock(call.clone()));
    }
    if let Some(usage) = result.get("usage") {
        let n = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        events.push(StreamEvent::Usage(Usage {
            input_tokens: n("inputTokens"),
            output_tokens: n("outputTokens"),
            cache_read_tokens: n("cachedTokens"),
            cache_write_tokens: n("cacheWriteTokens"),
            raw: usage.get("raw").cloned(),
            ..Usage::default()
        }));
    }
    events.push(StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None });
    Ok(events)
}

#[async_trait]
impl ProviderAdapter for Provider {
    fn release_send(&self, _group: &str) {}
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
        self.requests.lock().unwrap().push((self.id.as_str().to_owned(), (*request).clone()));
        self.clock.fetch_add(250, Ordering::SeqCst);
        let reply = self.replies.lock().unwrap().pop_front().expect("a scripted reply");
        let events = reply_events(&reply)?;
        Ok(Box::new(Script { events: events.into_iter().map(Ok).collect() }))
    }
}

struct World {
    main: Value,
    stored: Value,
    session: Option<String>,
    cached: Value,
    listed: Value,
    global: Value,
    providers: Mutex<HashMap<String, Arc<dyn ProviderAdapter>>>,
    clock: Arc<AtomicI64>,
    replies: Arc<Mutex<VecDeque<Value>>>,
    requests: Arc<Mutex<Vec<(String, ModelRequest)>>>,
}

impl World {
    fn of(spec: &Value, clock: i64) -> Arc<Self> {
        let field = |key: &str| spec.get(key).cloned().unwrap_or(Value::Null);
        Arc::new(Self {
            main: field("main"),
            stored: field("webSearchRoute"),
            session: spec.get("session").and_then(Value::as_str).map(str::to_owned),
            cached: field("cached"),
            listed: field("listed"),
            global: field("global"),
            providers: Mutex::default(),
            clock: Arc::new(AtomicI64::new(clock)),
            replies: Arc::new(Mutex::new(spec["replies"].as_array().cloned().unwrap_or_default().into())),
            requests: Arc::default(),
        })
    }
}

#[async_trait]
impl SearchHost for World {
    fn main_route(&self, thread: &ThreadId) -> Value {
        assert_eq!(thread, &asking_thread(), "the route is the asking thread's");
        self.main.clone()
    }
    fn stored_web_search_route(&self) -> Value {
        self.stored.clone()
    }
    async fn main_model_row(&self, provider: &str, model: &str) -> Result<Option<Value>, String> {
        let cached = self.cached.get(provider).and_then(|rows| rows.get(model)).filter(|row| !row.is_null());
        let listed = self.listed.get(provider).and_then(Value::as_array).and_then(|rows| rows.iter().find(|row| row["id"] == model));
        Ok(cached.or(listed).cloned())
    }
    fn catalog_row(&self, provider: &str, model: &str) -> Option<Value> {
        self.global.get(format!("{provider}/{model}")).cloned()
    }
    async fn provider(&self, provider: &str) -> Result<Option<super::SearchProvider>, String> {
        let mut providers = self.providers.lock().unwrap();
        Ok(Some(super::SearchProvider::Hosted(
            providers
                .entry(provider.to_owned())
                .or_insert_with(|| {
                    Arc::new(Provider {
                        id: ProviderId::from(provider),
                        codec: MockCodec,
                        policy: RetryPolicy::codex_default(),
                        keepalive: KeepaliveSchedule::SPEC,
                        clock: self.clock.clone(),
                        replies: self.replies.clone(),
                        requests: self.requests.clone(),
                    })
                })
                .clone(),
        )))
    }
    fn session_id(&self, thread: &ThreadId) -> Option<String> {
        assert_eq!(thread, &asking_thread(), "the session is the asking thread's");
        self.session.clone()
    }
}

/// The thread every case asks from: a host that is handed another one fails.
fn asking_thread() -> ThreadId {
    ThreadId::from("asking-thread")
}

/// Every account provider is on its default account, as an unread roster says.
struct DefaultAccounts;

#[async_trait]
impl AccountOf for DefaultAccounts {
    async fn of(&self, _provider: &str) -> Result<String, String> {
        Ok("default".to_owned())
    }
}

fn candidate_view(candidate: &super::hosted_search::SearchCandidate) -> Value {
    json!({
        "provider": candidate.provider,
        "model": candidate.model,
        "effort": candidate.effort,
        "fast": candidate.fast,
        "modelParameters": candidate.model_parameters,
        "toolType": candidate.tool_type,
    })
}

/// What the recording says `thread`'s search resolves to for `case`.
async fn expect_case(routes: &ConfiguredSearchRoutes, thread: &ThreadId, case: &Value) {
    let got = routes.candidates(thread).await;
    let name = &case["name"];
    match (&case["candidates"], &case["error"]) {
        (Value::Array(want), _) => {
            let got = got.unwrap_or_else(|error| panic!("{name}: {error}"));
            let want: Vec<Value> = want
                .iter()
                .map(|c| json!({ "provider": c["provider"], "model": c["model"], "effort": c["effort"], "fast": c["fast"], "modelParameters": c["modelParameters"], "toolType": c["toolType"] }))
                .collect();
            assert_eq!(got.iter().map(candidate_view).collect::<Vec<_>>(), want, "{name}");
            if want.is_empty() {
                assert_eq!(routes.no_candidate_message(thread).await, case["noCandidate"].as_str().unwrap(), "{name}");
            }
        }
        (_, Value::String(error)) => assert_eq!(&got.unwrap_err(), error, "{name}"),
        _ => panic!("{name}: no expectation"),
    }
}

/// A daemon's host: the config and the catalog are one, and each thread has its own Main route
/// and session (Node has one runtime per conversation).
struct Threads {
    shared: Arc<World>,
    mains: HashMap<ThreadId, Value>,
}

#[async_trait]
impl SearchHost for Threads {
    fn main_route(&self, thread: &ThreadId) -> Value {
        self.mains[thread].clone()
    }
    fn stored_web_search_route(&self) -> Value {
        self.shared.stored_web_search_route()
    }
    async fn main_model_row(&self, provider: &str, model: &str) -> Result<Option<Value>, String> {
        self.shared.main_model_row(provider, model).await
    }
    fn catalog_row(&self, provider: &str, model: &str) -> Option<Value> {
        self.shared.catalog_row(provider, model)
    }
    async fn provider(&self, provider: &str) -> Result<Option<super::SearchProvider>, String> {
        self.shared.provider(provider).await
    }
    fn session_id(&self, thread: &ThreadId) -> Option<String> {
        Some(thread.as_str().to_owned())
    }
}

/// The Node `nativeTools` entry a provider crate tool stands for.
fn native_tool(provider: &str, tool: &mixdog_core_api::domain::provider::HostedWebSearch) -> Value {
    let domains = (!tool.allowed_domains.is_empty()).then(|| json!(tool.allowed_domains));
    let location = tool.user_location.as_ref().map(|l| {
        let mut out = json!({ "type": "approximate" });
        for (key, value) in [("country", &l.country), ("region", &l.region), ("city", &l.city), ("timezone", &l.timezone)] {
            if let Some(value) = value {
                out[key] = json!(value);
            }
        }
        out
    });
    let mut out = match web_search_provider_family(provider) {
        "gemini" => return json!({ "type": tool.tool_type }),
        "anthropic" => {
            let mut out = json!({ "type": "web_search_20250305", "name": "web_search", "max_uses": tool.max_uses });
            if let Some(domains) = domains {
                out["allowed_domains"] = domains;
            }
            out
        }
        family => {
            let mut out = json!({ "type": tool.tool_type });
            if family == "openai" && tool.tool_type == "web_search" {
                out["search_context_size"] = json!(tool.context_size);
            }
            if let Some(domains) = domains {
                out["filters"] = json!({ "allowed_domains": domains });
            }
            out
        }
    };
    if let Some(location) = location {
        out["user_location"] = location;
    }
    out
}

fn text_of(content: &Content) -> String {
    match content {
        Content::Text(text) => text.to_string(),
        Content::Parts(_) => panic!("text expected"),
    }
}

/// The ledger rows with the random request id folded to `<req>`, as Node's are recorded.
fn row_views(ledger: &Ledger) -> Vec<Value> {
    ledger
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|row| {
            let mut row = serde_json::to_value(row).unwrap();
            let id = row["id"].as_str().unwrap().to_owned();
            row["id"] = json!(format!("<req>{}", &id[36..]));
            row
        })
        .collect()
}

#[test]
fn a_turn_hears_the_newest_live_registration_of_its_session() {
    let sinks = NativeSearchUsageSinks::new();
    let heard = Arc::new(Mutex::new(Vec::new()));
    let listener = |tag: &'static str| {
        let heard = heard.clone();
        Arc::new(move |_: Value| heard.lock().unwrap().push(tag)) as super::hosted_usage::UsageSink
    };
    let first = sinks.register("s1", listener("a"));
    let second = sinks.register("s1", listener("b"));
    sinks.report(Some("s1"), || json!({}));
    drop(first);
    sinks.report(Some("s1"), || json!({}));
    drop(second);
    sinks.report(Some("s1"), || json!({}));
    sinks.report(Some("other"), || json!({}));
    assert_eq!(*heard.lock().unwrap(), vec!["b", "b"]);
    let third = sinks.register("s2", Arc::new(|_| panic!("boom")));
    sinks.report(Some("s2"), || json!({}));
    drop(third);
}

/// Cases that differ only in the thread's Main route: the route and the candidates it resolves to.
fn main_route_cases() -> Vec<Value> {
    vec![
        json!({
            "name": "default follows a capable main model",
            "main": {"effort": "high", "fast": true, "model": "gpt-5.2", "modelParameters": {"verbosity": "low"}, "provider": "openai"},
            "candidates": [{"effort": "high", "fast": true, "key": "default\nopenai\ngpt-5.2", "model": "gpt-5.2", "modelParameters": {"verbosity": "low"}, "provider": "openai", "source": "default-web-search-route", "toolType": null}],
        }),
        json!({
            "name": "default takes the effective effort first",
            "main": {"effectiveEffort": "medium", "effort": "low", "model": "gpt-5.2", "provider": "openai"},
            "candidates": [{"effort": "medium", "fast": false, "key": "default\nopenai\ngpt-5.2", "model": "gpt-5.2", "modelParameters": {}, "provider": "openai", "source": "default-web-search-route", "toolType": null}],
        }),
        json!({
            "name": "default refuses a codex main model",
            "main": {"model": "gpt-5.2-codex", "provider": "openai-oauth"},
            "candidates": [],
            "noCandidate": "default web search route requires the current main model to support native web search (openai-oauth/gpt-5.2-codex)",
        }),
    ]
}

#[tokio::test]
async fn the_default_search_route_follows_a_capable_main_model_and_refuses_a_codex_one() {
    for case in main_route_cases() {
        expect_case(&ConfiguredSearchRoutes::new(World::of(&case, 0)), &asking_thread(), &case).await;
    }
}
#[tokio::test]
async fn one_host_answers_each_thread_with_its_own_main_route() {
    let owned = main_route_cases();
    let cases: Vec<&Value> = owned.iter().collect();
    let thread_of = |index: usize| ThreadId::from(format!("thread-{index}").as_str());
    let mains = cases.iter().enumerate().map(|(index, case)| (thread_of(index), case["main"].clone())).collect();
    let routes = ConfiguredSearchRoutes::new(Arc::new(Threads { shared: World::of(&json!({}), 0), mains }));
    // Last thread first: no answer depends on which thread asked before.
    for (index, case) in cases.iter().enumerate().rev() {
        expect_case(&routes, &thread_of(index), case).await;
    }
}

/// One search through the real routes and sender for each case: its provider scripted with the case's replies, then the
/// answer, the requests the provider got, the spend the asking turn heard and the ledger rows checked against the case.
async fn check_sends(sends: &[Value], start: i64) {
    // A row's day is the local day: the cases are written for Seoul.
    let _ = mixdog_js::time::set_process_zone(mixdog_js::time::Tz::Asia__Seoul);
    for case in sends {
        let name = &case["name"];
        let mut spec = case.clone();
        spec["main"] = json!({ "provider": "openai", "model": "gpt-5.2" });
        let world = World::of(&spec, start);
        let broker = Arc::new(ModelBroker::new(Arc::new(Admission::new()), Arc::new(Surface)));
        let ledger = Arc::new(Ledger::default());
        let sinks = NativeSearchUsageSinks::new();
        let deps = SenderDeps {
            broker: broker.clone(),
            pricing: Arc::new(Unpriced),
            ledger: Some(ledger.clone()),
            sinks: sinks.clone(),
            lane: SenderDeps::default_lane(&broker),
            account: Arc::new(DefaultAccounts),
            now: {
                let clock = world.clock.clone();
                Arc::new(move || clock.load(Ordering::SeqCst))
            },
        };
        let search = HostedWebSearch::new(ConfiguredSearchRoutes::new(world.clone()), ProviderSearchSender::new(world.clone(), deps));
        let heard = Arc::new(Mutex::new(Vec::new()));
        let _release = world.session.as_deref().map(|session| {
            let heard = heard.clone();
            sinks.register(session, Arc::new(move |delta| heard.lock().unwrap().push(delta)))
        });
        let args = &case["args"];
        let request = NativeSearchRequest {
            thread: asking_thread(),
            query: args["query"].as_str().unwrap().to_owned(),
            site: args.get("site").and_then(Value::as_str).map(str::to_owned),
            locale: None,
            context_size: args.get("contextSize").and_then(Value::as_str).unwrap_or_default().to_owned(),
            max_results: args.get("maxResults").and_then(Value::as_u64).unwrap_or(0) as usize,
            prompt: args["prompt"].as_str().unwrap().to_owned(),
        };
        let got = search.search(request, CancellationToken::new()).await;

        assert_answer(case, got);
        assert_provider_requests(case, &world);
        assert_eq!(Value::Array(heard.lock().unwrap().clone()), case["deltas"], "{name}");
        assert_eq!(row_views(&ledger), departed_rows(case), "{name}");
    }
}

fn assert_answer(case: &Value, got: Result<super::NativeSearchResult, super::NativeSearchError>) {
    let name = &case["name"];
    match (&case["result"], &case["error"]) {
        (Value::Object(want), _) => {
            let got = got.unwrap_or_else(|error| panic!("{name}: {error:?}"));
            assert_eq!(got.answer, want["content"].as_str().unwrap(), "{name}");
            assert_eq!(got.provider, want["provider"].as_str().unwrap(), "{name}");
            let urls: Vec<(String, String)> = got.citations.iter().map(|c| (c.title.clone(), c.url.clone())).collect();
            let want_urls: Vec<(String, String)> = want["citations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| (c["title"].as_str().unwrap().to_owned(), c["url"].as_str().unwrap().to_owned()))
                .collect();
            assert_eq!(urls, want_urls, "{name}");
        }
        (_, Value::String(error)) => assert_eq!(got.unwrap_err().message(), error.as_str(), "{name}"),
        _ => panic!("{name}: no expectation"),
    }
}

fn assert_provider_requests(case: &Value, world: &World) {
    let name = &case["name"];
    let requests = world.requests.lock().unwrap();
    let calls = case["calls"].as_array().unwrap();
    assert_eq!(requests.len(), calls.len(), "{name}");
    for ((provider, request), call) in requests.iter().zip(calls) {
        let opts = &call["opts"];
        assert_eq!(provider, call["provider"].as_str().unwrap(), "{name}");
        assert_eq!(request.model, call["model"].as_str().unwrap(), "{name}");
        let messages: Vec<Value> = request
            .messages
            .iter()
            .map(|m| json!({ "role": if m.role == Role::System { "system" } else { "user" }, "content": text_of(&m.content) }))
            .collect();
        assert_eq!(Value::Array(messages), call["messages"], "{name}");
        assert!(request.tools.is_empty(), "{name}");
        let options = &request.options;
        assert_eq!(options.session_id.as_deref(), opts["sessionId"].as_str(), "{name}");
        assert_eq!(options.effort.as_deref(), opts["effort"].as_str(), "{name}");
        assert_eq!(options.fast, opts["fast"].as_bool().unwrap(), "{name}");
        assert_eq!(options.tool_choice.as_deref(), opts["toolChoice"].as_str(), "{name}");
        assert_eq!(options.model_parameters.as_ref(), Some(&opts["modelParameters"]), "{name}");
        let [HostedTool::WebSearch(tool)] = options.hosted_tools.as_slice() else { panic!("{name}: one hosted tool") };
        assert_eq!(json!([native_tool(provider, tool)]), opts["nativeTools"], "{name}");
        let include: Vec<&str> = if tool.include_sources { vec!["web_search_call.action.sources"] } else { vec![] };
        assert_eq!(json!(include), opts["nativeInclude"], "{name}");
    }
}

/// Recorded sends whose ledger row a DECIDED DEPARTURE changes: a completed send whose provider reported no usage now
/// records `outputTokensKnown:false` in its rates (`mixdog-ai` accounting), so the request projection can tell an
/// unmeasured output from a measured zero. Node's row did not say so.
const OUTPUT_UNKNOWN_SENDS: &[&str] = &["xai with a tool type and no usage"];

/// The recorded ledger rows of a send with its listed departure applied.
fn departed_rows(case: &Value) -> Vec<Value> {
    let mut rows = case["rows"].as_array().unwrap().clone();
    if OUTPUT_UNKNOWN_SENDS.contains(&case["name"].as_str().unwrap()) {
        for row in &mut rows {
            let rates = row["rates"].as_str().unwrap();
            assert!(!rates.contains("outputTokensKnown"), "{}: the recording already says it", case["name"]);
            row["rates"] = json!(format!("{},\"outputTokensKnown\":false}}", rates.strip_suffix('}').unwrap()));
        }
    }
    rows
}

#[tokio::test]
async fn a_search_asks_the_provider_for_its_hosted_tool_and_answers_with_citations_spend_and_a_ledger_row() {
    let case = json!({
        "name": "openai with usage, a model, citations and search calls",
        "args": {"contextSize": "medium", "maxResults": 3, "prompt": "find x", "query": "q", "site": "a.com OR b.com"},
        "session": "lead-1",
        "webSearchRoute": {"effort": "high", "fast": true, "model": "zz-gpt", "modelParameters": {"verbosity": "low"}, "provider": "openai"},
        "replies": [{"result": {
            "citations": [{"title": "A", "url": "https://a.com/1"}],
            "content": "  the answer  ",
            "usage": {"cacheWriteTokens": 0, "cachedTokens": 40, "inputTokens": 120, "outputTokens": 30, "promptTokens": 120, "raw": {"output_tokens_details": {"reasoning_tokens": 7}}},
            "webSearchCalls": [{"action": {"query": "x", "sources": [{"url": "https://b.com/2"}]}, "type": "web_search_call"}],
        }}],
        "result": {"content": "the answer", "provider": "openai", "citations": [{"title": "A", "url": "https://a.com/1"}, {"title": "x", "url": "https://b.com/2"}]},
        "calls": [{
            "provider": "openai",
            "model": "zz-gpt",
            "messages": [
                {"role": "system", "content": "You are Mixdog native web search.\nUse the hosted web_search tool for current or external facts.\nAnswer concisely, cite source URLs, and do not request local tools or file edits."},
                {"role": "user", "content": "find x"},
            ],
            "opts": {
                "effort": "high", "fast": true, "modelParameters": {"verbosity": "low"}, "toolChoice": "required",
                "nativeInclude": ["web_search_call.action.sources"],
                "nativeTools": [{"filters": {"allowed_domains": ["a.com", "b.com"]}, "search_context_size": "medium", "type": "web_search"}],
                "sessionId": "lead-1:native-web-search:loyw3v28",
            },
        }],
        "deltas": [{
            "agentRole": "web-search", "contextCacheWriteTokens": 0, "contextCachedReadTokens": 40, "contextInputTokens": 120,
            "contextMeasuredTokens": null, "contextOutputTokens": 30, "contextPromptTokens": 120, "deltaCacheWrite": 0,
            "deltaCachedRead": 40, "deltaInput": 120, "deltaOutput": 30, "deltaPrompt": 120, "deltaToolCalls": 0,
            "iterationIndex": 0, "model": "zz-gpt", "promptKnown": true, "reasoningTokens": 7, "reasoningTokensComplete": true,
            "requestMs": 0, "requestedModel": "zz-gpt", "sessionId": "lead-1:native-web-search:loyw3v28",
            "source": "native_web_search", "ts": 1_700_000_000_250_i64,
        }],
        "rows": [{
            "account": "", "attempts": 1, "cacheRead": 40, "cacheWrite": 0, "costSource": "unpriced", "costUsd": null,
            "day": "2023-11-15", "durationMs": 250, "elapsedMs": 0, "id": "<req>", "input": 80, "kind": "api",
            "model": "zz-gpt", "origin": "live", "output": 30, "provider": "openai",
            "rates": "{\"requestedModel\":\"zz-gpt\",\"pricingModel\":\"zz-gpt\",\"pricingProvider\":\"openai\",\"pricingSource\":null,\"unpricedReason\":\"model-not-found\"}",
            "requestedModel": "", "requestedProvider": "", "responseId": "", "sessionId": "lead-1:native-web-search:loyw3v28",
            "sourceType": "native-web-search", "status": "completed", "ts": 1_700_000_000_250_i64, "ttftMs": null,
        }],
    });
    check_sends(&[case], 1_700_000_000_000).await;
}
