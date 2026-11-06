//! The hosted web search over the real routes and sender against what Node does
//! (`benchmarks/rust-core/recorders/record-hosted-search.mjs`): the candidates the config and Main
//! route give, and for each send the request the provider gets, the answer, the
//! spend the asking turn hears and the ledger rows written. The provider is
//! scripted; nothing leaves the process.

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

const GOLDEN: &str = include_str!("../../../../fixtures/hosted-search/golden.json");

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
    fn main_route(&self) -> Value {
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
    async fn provider(&self, provider: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
        let mut providers = self.providers.lock().unwrap();
        Ok(Some(
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
        ))
    }
    fn session_id(&self) -> Option<String> {
        self.session.clone()
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

#[tokio::test]
async fn the_candidates_are_the_ones_node_resolves() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["routes"].as_array().unwrap() {
        let routes = ConfiguredSearchRoutes::new(World::of(case, 0));
        let got = routes.candidates().await;
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
                    assert_eq!(routes.no_candidate_message().await, case["noCandidate"].as_str().unwrap(), "{name}");
                }
            }
            (_, Value::String(error)) => assert_eq!(&got.unwrap_err(), error, "{name}"),
            _ => panic!("{name}: no expectation"),
        }
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
        Content::Text(text) => text.clone(),
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

#[tokio::test]
async fn every_send_is_asked_answered_accounted_and_reported_like_node() {
    // The golden was recorded in Seoul: a row's day is the local day.
    let _ = mixdog_js::time::set_process_zone(mixdog_js::time::Tz::Asia__Seoul);
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let start = golden["startedAt"].as_i64().unwrap();
    for case in golden["sends"].as_array().unwrap() {
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
            account: SenderDeps::default_account(),
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
            query: args["query"].as_str().unwrap().to_owned(),
            site: args.get("site").and_then(Value::as_str).map(str::to_owned),
            locale: None,
            context_size: args.get("contextSize").and_then(Value::as_str).unwrap_or_default().to_owned(),
            max_results: args.get("maxResults").and_then(Value::as_u64).unwrap_or(0) as usize,
            prompt: args["prompt"].as_str().unwrap().to_owned(),
        };
        let got = search.search(request, CancellationToken::new()).await;

        match (&case["result"], &case["error"]) {
            (Value::Object(want), _) => {
                let got = got.unwrap_or_else(|error| panic!("{name}: {error}"));
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
            (_, Value::String(error)) => assert_eq!(&got.unwrap_err(), error, "{name}"),
            _ => panic!("{name}: no expectation"),
        }

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

        assert_eq!(Value::Array(heard.lock().unwrap().clone()), case["deltas"], "{name}");
        assert_eq!(row_views(&ledger), case["rows"].as_array().unwrap().clone(), "{name}");
    }
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
