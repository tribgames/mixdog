//! One hosted web-search send (`sendCandidate` of `session-runtime/
//! native-web-search.mjs`): the provider named by the candidate is asked, over
//! the broker, with the hosted tool attached, under a session id derived from the
//! asking session. The send writes its ledger rows like any other send
//! (`source_type` `native-web-search`) and reports its spend to the asking turn.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::Lane;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::process_lane_settings;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::broker::SendError;
use mixdog_ai::broker::SendRequest;
use mixdog_ai::registry::accounted::AccountOf;
use mixdog_ai::registry::accounted::input_excludes_cache;
use mixdog_ai::registry::accounting::Completed;
use mixdog_ai::registry::accounting::Facts;
use mixdog_ai::registry::accounting::Outcome;
use mixdog_ai::registry::accounting::SendAccounting;
use mixdog_ai::registry::accounting::SendIdentity;
use mixdog_ai::registry::accounting::UsagePricing;
use mixdog_ai::registry::accounting::UsageSink;
use mixdog_ai::registry::accounting::random_uuid;
use mixdog_ai::registry::attempt::RecordingSink;
use mixdog_ai::service::routes::capacity_fallback;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_ai::providers::hosted::web_search_from_node;
use mixdog_core_api::domain::provider::HostedTool;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Usage;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::hosted_routes::SearchHost;
use super::hosted_search::HostedSearchCall;
use super::hosted_search::HostedSearchError;
use super::hosted_search::HostedSearchReply;
use super::hosted_search::HostedSearchSender;
use super::hosted_search::SearchFamily;
use super::hosted_usage::NativeSearchUsageSinks;
use super::hosted_usage::usage_delta;

const SOURCE_TYPE: &str = "native-web-search";

/// What the send needs besides the host: the broker, the ledger and its prices,
/// and the sinks of the asking turns.
pub struct SenderDeps {
    pub broker: Arc<ModelBroker>,
    pub pricing: Arc<dyn UsagePricing>,
    /// `None` while no ledger is open: nothing is recorded.
    pub ledger: Option<Arc<dyn UsageSink>>,
    pub sinks: Arc<NativeSearchUsageSinks>,
    /// The admission lane of a provider, shared with the main sends.
    pub lane: Arc<dyn Fn(&str) -> Arc<Lane> + Send + Sync>,
    /// The account each row of the send is recorded under (`currentProviderAccountId`, read where
    /// the row is written, as the main sends' accounting reads it); empty for a provider with no
    /// accounts. An error is the lookup's failure, which fails the recording of the send's rows
    /// (`usageAccountingError`), never the send.
    pub account: Arc<dyn AccountOf>,
    /// Epoch ms (`Date.now()`).
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl SenderDeps {
    /// The lane of the model proxy's runner: the provider's default account.
    pub fn default_lane(broker: &Arc<ModelBroker>) -> Arc<dyn Fn(&str) -> Arc<Lane> + Send + Sync> {
        let broker = Arc::clone(broker);
        Arc::new(move |provider| {
            let key = LaneKey::new(provider.into(), "default");
            broker.admission().lane(&key, process_lane_settings()(&key))
        })
    }

    pub fn system_clock() -> Arc<dyn Fn() -> i64 + Send + Sync> {
        Arc::new(|| {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
        })
    }
}

pub struct ProviderSearchSender {
    host: Arc<dyn SearchHost>,
    deps: SenderDeps,
}

impl ProviderSearchSender {
    pub fn new(host: Arc<dyn SearchHost>, deps: SenderDeps) -> Arc<Self> {
        Arc::new(Self { host, deps })
    }
}

/// JS `Number#toString(36)`.
fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn plain(message: impl Into<String>) -> HostedSearchError {
    HostedSearchError { message: message.into(), capacity: false }
}

/// The hosted tool of a call in the provider crate's shape; each codec renders
/// the one its wire hosts (`nativeTools`).
fn hosted_tool(call: &HostedSearchCall) -> HostedTool {
    web_search_from_node(&call.tool, call.candidate.family == SearchFamily::Anthropic, &call.include)
}

fn request_of(call: &HostedSearchCall, session_id: &str) -> ModelRequest {
    let candidate = &call.candidate;
    ModelRequest {
        model: candidate.model.clone(),
        messages: vec![
            Message::new(Role::System, Content::Text(call.system.clone())),
            Message::new(Role::User, Content::Text(call.user.clone())),
        ],
        tools: Vec::new(),
        options: RequestOptions {
            session_id: Some(session_id.to_owned()),
            effort: candidate.effort.clone(),
            fast: candidate.fast,
            tool_choice: Some(call.tool_choice.to_owned()),
            model_parameters: Some(candidate.model_parameters.clone()),
            hosted_tools: vec![hosted_tool(call)],
            ..RequestOptions::default()
        },
    }
}

/// The usage object of a result, in the provider-result shape Node returns.
pub fn usage_object(usage: &Usage, input_inclusive: bool) -> Value {
    let prompt =
        if input_inclusive { usage.input_tokens } else { usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens };
    let mut out = Map::new();
    out.insert("inputTokens".into(), json!(usage.input_tokens));
    out.insert("outputTokens".into(), json!(usage.output_tokens));
    out.insert("cachedTokens".into(), json!(usage.cache_read_tokens));
    out.insert("cacheWriteTokens".into(), json!(usage.cache_write_tokens));
    if usage.cache_write_1h_tokens > 0 {
        out.insert("cacheWrite1hTokens".into(), json!(usage.cache_write_1h_tokens));
    }
    out.insert("promptTokens".into(), json!(prompt));
    if let Some(reasoning) = usage.reasoning_tokens {
        out.insert("reasoningTokens".into(), json!(reasoning));
    }
    if let Some(cost) = usage.cost {
        out.insert("costUsd".into(), json!(cost.0 as f64 / 10_000_000_000.0));
    }
    if let Some(raw) = &usage.raw {
        out.insert("raw".into(), raw.clone());
    }
    Value::Object(out)
}

/// What the stream answered: the text, the last usage, and the sources the
/// result carries (Node's Anthropic result has none: its decoder reports no
/// citation or search call; the others report both).
fn fold(events: &[StreamEvent]) -> (String, Option<Usage>, Option<String>, Vec<Value>, Vec<Value>) {
    let (mut content, mut usage, mut pricing) = (String::new(), None, None);
    let (mut citations, mut calls) = (Vec::new(), Vec::new());
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => content.push_str(text),
            StreamEvent::Usage(reported) => usage = Some(reported.clone()),
            StreamEvent::Completed { pricing_model, .. } => pricing = pricing_model.clone(),
            StreamEvent::Citation(citation) => citations.push(citation.clone()),
            StreamEvent::ServerToolBlock(block) if block.get("type").and_then(Value::as_str) == Some("web_search_call") => {
                calls.push(block.clone());
            }
            _ => {}
        }
    }
    (content, usage, pricing, citations, calls)
}

fn refused(error: &ProviderError, cancel: &CancellationToken) -> HostedSearchError {
    // An account-pool quota refusal is stated by its code.
    let pool = error.code.as_deref() == Some("provider_accounts_exhausted");
    HostedSearchError { message: error.message.clone(), capacity: capacity_fallback(error, cancel.is_cancelled(), pool) }
}

#[async_trait]
impl HostedSearchSender for ProviderSearchSender {
    async fn send(&self, call: HostedSearchCall, cancel: &CancellationToken) -> Result<HostedSearchReply, HostedSearchError> {
        let candidate = &call.candidate;
        let provider = candidate.provider.as_str();
        let adapter = match self.host.provider(provider).await.map_err(plain)? {
            Some(adapter) => adapter,
            None => return Err(plain(format!("provider \"{provider}\" is not ready"))),
        };
        let started_at = (self.deps.now)();
        let owner = self.host.session_id(&call.thread);
        let base = owner.as_deref().filter(|id| !id.is_empty()).unwrap_or("web_search");
        let session_id = format!("{base}:{SOURCE_TYPE}:{}", base36((self.deps.now)().max(0) as u64));
        let excludes_cache = input_excludes_cache(provider);
        let identity = SendIdentity {
            provider: provider.to_owned(),
            model: candidate.model.clone(),
            requested_provider: provider.to_owned(),
            requested_model: candidate.model.clone(),
            route_hop: false,
            session_id: Some(session_id.clone()),
            owner_session_id: None,
            source_type: SOURCE_TYPE.to_owned(),
            input_tokens_inclusive: !excludes_cache,
            request_service_tier: String::new(),
            // Read for every row by the roster below, never once here.
            account: Ok(String::new()),
            request_id: random_uuid(),
            started_at,
        };
        let accounting = SendAccounting::new(identity, Arc::clone(&self.deps.pricing), self.deps.ledger.clone())
            .with_sources(Arc::clone(&self.deps.now), Arc::new(random_uuid))
            .with_account(Arc::clone(&self.deps.account));
        let mut sink = RecordingSink::collecting().with_accounting(accounting);
        let request = SendRequest {
            request: Arc::new(request_of(&call, &session_id)),
            lane: (self.deps.lane)(provider),
            admission: AdmissionRequest::default(),
        };
        let sent = self.deps.broker.send(adapter.as_ref(), request, &mut sink, cancel).await;
        let ended_at = (self.deps.now)();
        let last_usage = sink.last_usage().cloned();
        let events = sink.events().to_vec();
        let (content, usage, pricing_model, citations, web_search_calls) = fold(&events);
        let outcome_error = match &sent {
            Ok(_) => None,
            Err(SendError::Provider(error) | SendError::Exhausted(error)) => Some(error.clone()),
            Err(SendError::Fallback { last, .. }) => Some(last.clone()),
            Err(SendError::Admission(error)) => {
                let mut failure = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                failure.message = format!("{error:?}");
                Some(failure)
            }
            Err(SendError::Cancelled) => None,
        };
        if sink.accounting().is_some() {
            let outcome = match (&sent, &outcome_error) {
                (Ok(_), _) => Outcome::Completed(Completed {
                    facts: usage.as_ref().map(Facts::from),
                    pricing_model: pricing_model.clone(),
                    stream_ended_at: ended_at,
                    ..Completed::default()
                }),
                (Err(SendError::Cancelled), _) => Outcome::Cancelled { reported: last_usage.as_ref().map(Facts::from) },
                (Err(_), Some(error)) => Outcome::Failed(error),
                (Err(_), None) => return Err(plain("web search failed")),
            };
            let _ = sink.finish_accounting(outcome).await;
        }
        match sent {
            Err(SendError::Cancelled) => Err(plain("This operation was aborted")),
            Err(_) => Err(outcome_error.as_ref().map(|error| refused(error, cancel)).unwrap_or_else(|| plain("web search failed"))),
            Ok(_) => {
                if let Some(reported) = &usage {
                    let model = candidate.model.as_str();
                    self.deps.sinks.report(owner.as_deref(), || {
                        usage_delta(&session_id, model, model, reported, !excludes_cache, (self.deps.now)())
                    });
                }
                Ok(HostedSearchReply {
                    content,
                    model: None,
                    usage: usage.as_ref().map(|reported| usage_object(reported, !excludes_cache)),
                    citations,
                    web_search_calls,
                })
            }
        }
    }
}
