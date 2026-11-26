//! The provider-hosted web search (Node `createNativeWebSearch`): the route
//! chain yields provider/model candidates; the first one the provider serves
//! answers, and only a capacity refusal moves on to the next. What a provider
//! call is (the registry, credentials, the wire) sits behind
//! [`HostedSearchSender`]; which providers are candidates sits behind
//! [`SearchRoutes`].

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::ids::ThreadId;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::search::NativeSearchError;
use super::search::NativeSearchRequest;
use super::search::NativeSearchResult;
use super::search::NativeSource;
use super::search::NativeWebSearch;
use super::search::SearchCall;

const TOOL_TYPE_ENV: &str = "MIXDOG_NATIVE_WEB_SEARCH_TOOL_TYPE";

/// The provider's hosted web-search family (Node `webSearchProviderFamily`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SearchFamily {
    Openai,
    Anthropic,
    Gemini,
    Xai,
    Acp,
}

/// One provider/model that may answer a search.
#[derive(Clone, Debug)]
pub struct SearchCandidate {
    pub provider: String,
    pub family: SearchFamily,
    pub model: String,
    pub effort: Option<String>,
    pub fast: bool,
    pub model_parameters: Value,
    /// A hosted tool type the route names; the family default otherwise.
    pub tool_type: Option<String>,
}

/// The web-search route chain (Node `nativeWebSearchRoutes`), already
/// resolved to candidates: de-duplicated by provider and model, in route order. Both
/// reads are the asking thread's runtime's.
#[async_trait]
pub trait SearchRoutes: Send + Sync {
    async fn candidates(&self, thread: &ThreadId) -> Result<Vec<SearchCandidate>, String>;
    /// Why the chain produced no candidate (Node `noCandidateError`).
    async fn no_candidate_message(&self, thread: &ThreadId) -> String;
}

/// One request to a provider with the hosted search tool attached.
#[derive(Clone, Debug)]
pub struct HostedSearchCall {
    /// The thread whose turn asked: its session owns the send.
    pub thread: ThreadId,
    pub candidate: SearchCandidate,
    pub system: String,
    pub user: String,
    /// The hosted tool, in the provider family's shape.
    pub tool: Value,
    /// Extra response fields to request (`web_search_call.action.sources`).
    pub include: Vec<String>,
    /// `auto` for Gemini, `required` for every other family.
    pub tool_choice: &'static str,
}

#[derive(Clone, Debug, Default)]
pub struct HostedSearchReply {
    pub content: String,
    /// The model the provider reports having used.
    pub model: Option<String>,
    /// The provider's usage object, verbatim. Reporting it to the ledger
    /// (Node `reportNativeWebSearchUsage`) is the sender's job: it holds the
    /// session id of the send.
    pub usage: Option<Value>,
    pub citations: Vec<Value>,
    pub web_search_calls: Vec<Value>,
}

#[derive(Clone, Debug)]
pub struct HostedSearchError {
    pub message: String,
    /// A capacity refusal the server stated (429/503, or an account-pool quota
    /// refusal) before the stream produced anything: the next candidate may
    /// answer. A denied credential or any started stream is not one.
    pub capacity: bool,
    /// The backend for this candidate is not available yet.
    pub unavailable: bool,
}

impl HostedSearchError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self { message: message.into(), capacity: false, unavailable: true }
    }
}

/// One web search asked of an ACP agent preset's search-only session.
#[derive(Clone, Debug)]
pub struct AcpSearchRequest {
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub query: String,
    pub site: Option<String>,
    pub locale: Option<Value>,
    pub max_results: usize,
    pub context_size: String,
}

/// One ACP search dispatch with the asking thread and resolved candidate.
#[derive(Clone, Debug)]
pub struct AcpSearchCall {
    pub thread: ThreadId,
    pub candidate: SearchCandidate,
    pub request: AcpSearchRequest,
}

/// One ACP search turn's answer, citations, `search_web` calls, and usage.
#[derive(Clone, Debug, Default)]
pub struct AcpSearchReply {
    pub answer: String,
    /// The model the agent reports having used, if any.
    pub model: Option<String>,
    pub citations: Vec<NativeSource>,
    /// The `search_web` calls made during this turn; an empty list is rejected as a failure.
    pub calls: Vec<SearchCall>,
    pub usage: Option<Usage>,
    /// Whether `usage.input_tokens` excludes `usage.cache_read_tokens`.
    pub input_excludes_cache: bool,
}

/// Classification of an ACP search backend failure.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AcpSearchErrorKind {
    /// Rate limit or quota exhaustion before any search ran: fallback to the next candidate.
    Capacity,
    /// Agent sign-in required or expired: surface at once.
    SignIn,
    /// Account/policy refusal or turn made no `search_web` call: surface at once.
    Refusal,
    /// Agent binary/server not installed or feature disabled: surface at once.
    NotInstalled,
    /// No ACP search backend is wired yet: reports candidate unavailable.
    Unavailable,
    /// Caller cancelled the search.
    Cancelled,
    /// Any other failure: surface at once.
    Failed,
}

#[derive(Clone, Debug)]
pub struct AcpSearchError {
    pub kind: AcpSearchErrorKind,
    pub message: String,
    /// Usage reported before failure or cancellation, if any.
    pub usage: Option<Usage>,
    pub input_excludes_cache: bool,
}

impl AcpSearchError {
    pub fn capacity(message: impl Into<String>) -> Self {
        Self { kind: AcpSearchErrorKind::Capacity, message: message.into(), usage: None, input_excludes_cache: false }
    }

    pub fn sign_in(message: impl Into<String>) -> Self {
        Self { kind: AcpSearchErrorKind::SignIn, message: message.into(), usage: None, input_excludes_cache: false }
    }

    pub fn refusal(message: impl Into<String>) -> Self {
        Self { kind: AcpSearchErrorKind::Refusal, message: message.into(), usage: None, input_excludes_cache: false }
    }

    pub fn not_installed(message: impl Into<String>) -> Self {
        Self { kind: AcpSearchErrorKind::NotInstalled, message: message.into(), usage: None, input_excludes_cache: false }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self { kind: AcpSearchErrorKind::Unavailable, message: message.into(), usage: None, input_excludes_cache: false }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self { kind: AcpSearchErrorKind::Cancelled, message: message.into(), usage: None, input_excludes_cache: false }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self { kind: AcpSearchErrorKind::Failed, message: message.into(), usage: None, input_excludes_cache: false }
    }

    pub fn with_usage(mut self, usage: Option<Usage>, input_excludes_cache: bool) -> Self {
        self.usage = usage;
        self.input_excludes_cache = input_excludes_cache;
        self
    }
}

/// Port implemented by the ACP search session pool to run search-only turns.
#[async_trait]
pub trait AcpSearchBackend: Send + Sync {
    async fn search(&self, request: AcpSearchRequest, cancel: &CancellationToken) -> Result<AcpSearchReply, AcpSearchError>;
}

/// Normalized ACP search reply returned by [`HostedSearchSender::send_acp`] after ledger accounting.
#[derive(Clone, Debug, Default)]
pub struct AcpSendReply {
    pub answer: String,
    pub model: Option<String>,
    pub usage: Option<Value>,
    pub citations: Vec<NativeSource>,
    pub calls: Vec<SearchCall>,
}

#[async_trait]
pub trait HostedSearchSender: Send + Sync {
    async fn send(&self, call: HostedSearchCall, cancel: &CancellationToken) -> Result<HostedSearchReply, HostedSearchError>;

    async fn send_acp(&self, call: AcpSearchCall, _cancel: &CancellationToken) -> Result<AcpSendReply, HostedSearchError> {
        Err(HostedSearchError::unavailable(format!("ACP web search backend for \"{}\" is not available", call.candidate.provider)))
    }
}

pub struct HostedWebSearch {
    routes: Arc<dyn SearchRoutes>,
    sender: Arc<dyn HostedSearchSender>,
}

impl HostedWebSearch {
    pub fn new(routes: Arc<dyn SearchRoutes>, sender: Arc<dyn HostedSearchSender>) -> Arc<Self> {
        Arc::new(Self { routes, sender })
    }
}

fn allowed_domain(site: &str) -> String {
    let raw = js_trim(site);
    if raw.is_empty() {
        return String::new();
    }
    let has_scheme =
        raw.get(..8).is_some_and(|head| head.eq_ignore_ascii_case("https://")) || raw.get(..7).is_some_and(|head| head.eq_ignore_ascii_case("http://"));
    let candidate = if has_scheme { raw.to_string() } else { format!("https://{raw}") };
    match Url::parse(&candidate) {
        Ok(url) => url.host_str().unwrap_or_default().to_lowercase(),
        Err(_) => {
            let bare = if has_scheme { raw.split_once("://").map_or(raw, |(_, rest)| rest) } else { raw };
            bare.split('/').next().unwrap_or_default().to_lowercase()
        }
    }
}

/// A site filter may name several domains the way a search box takes them
/// ("a.com OR b.com", "a.com, b.com", "site:a.com site:b.com").
fn allowed_domains(site: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    js_trim(site)
        .split(|c: char| is_js_space(c) || c == ',' || c == '|')
        .filter(|part| !part.is_empty() && !part.eq_ignore_ascii_case("or"))
        .map(|part| {
            let bare = match part.get(..5) {
                Some(head) if head.eq_ignore_ascii_case("site:") => &part[5..],
                _ => part,
            };
            allowed_domain(bare)
        })
        .filter(|domain| !domain.is_empty() && seen.insert(domain.clone()))
        .collect()
}

fn tool_types(candidate: &SearchCandidate) -> Vec<String> {
    let from_env = std::env::var(TOOL_TYPE_ENV).unwrap_or_default();
    if !js_trim(&from_env).is_empty() {
        return vec![js_trim(&from_env).to_string()];
    }
    if let Some(configured) = candidate.tool_type.as_deref().map(js_trim).filter(|t| !t.is_empty()) {
        return vec![configured.to_string()];
    }
    match candidate.family {
        SearchFamily::Gemini => vec!["google_search".to_string()],
        SearchFamily::Anthropic | SearchFamily::Xai => vec!["web_search".to_string()],
        SearchFamily::Openai => vec!["web_search".to_string(), "web_search_preview".to_string()],
        SearchFamily::Acp => vec!["search_web".to_string()],
    }
}

/// Node `nativeWebSearchUserLocation`: an object locale's country, region, city and timezone as the provider's
/// approximate `user_location`; a string locale, or an object with none of them, sends none.
fn user_location(locale: Option<&Value>) -> Option<Value> {
    let object = locale?.as_object()?;
    let mut location = Map::new();
    location.insert("type".to_owned(), json!("approximate"));
    for key in ["country", "region", "city", "timezone"] {
        let text = match object.get(key) {
            Some(Value::String(text)) => js_trim(text).to_owned(),
            Some(Value::Number(number)) => number.to_string(),
            Some(Value::Bool(flag)) => flag.to_string(),
            _ => String::new(),
        };
        if !text.is_empty() {
            location.insert(key.to_owned(), json!(text));
        }
    }
    (location.len() > 1).then_some(Value::Object(location))
}

fn hosted_tool(request: &NativeSearchRequest, tool_type: &str, family: SearchFamily) -> Value {
    let domains = request.site.as_deref().map(allowed_domains).unwrap_or_default();
    let location = user_location(request.locale.as_ref());
    let kind = if js_trim(tool_type).is_empty() { "web_search" } else { js_trim(tool_type) };
    match family {
        SearchFamily::Gemini | SearchFamily::Acp => json!({ "type": kind }),
        SearchFamily::Anthropic => {
            let uses = if request.max_results == 0 { 5 } else { request.max_results };
            let mut tool = json!({
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": uses.clamp(1, 10),
            });
            if !domains.is_empty() {
                tool["allowed_domains"] = json!(domains);
            }
            if let Some(location) = location {
                tool["user_location"] = location;
            }
            tool
        }
        SearchFamily::Xai => {
            let mut tool = json!({ "type": kind });
            if !domains.is_empty() {
                tool["filters"] = json!({ "allowed_domains": domains });
            }
            tool
        }
        SearchFamily::Openai => {
            let mut tool = json!({ "type": kind });
            if kind == "web_search" {
                let size = js_trim(&request.context_size);
                tool["search_context_size"] = json!(if size.is_empty() { "low" } else { size });
                if !domains.is_empty() {
                    tool["filters"] = json!({ "allowed_domains": domains });
                }
                if let Some(location) = location {
                    tool["user_location"] = location;
                }
            }
            tool
        }
    }
}

const SYSTEM_PROMPT: &str = "You are Mixdog native web search.\nUse the hosted web_search tool for current or external facts.\nAnswer concisely, cite source URLs, and do not request local tools or file edits.";

fn first_text<'a>(source: &'a Map<String, Value>, names: &[&str]) -> &'a str {
    names.iter().filter_map(|name| source.get(*name).and_then(Value::as_str)).find(|text| !text.is_empty()).unwrap_or_default()
}

/// The citations and the sources of the searches the provider ran, flattened
/// and de-duplicated by URL (Node `flattenNativeWebSearchSources`).
fn flatten_citations(citations: &[Value], calls: &[Value]) -> Vec<NativeSource> {
    let mut out: Vec<NativeSource> = Vec::new();
    let mut add = |source: &Value, fallback_title: &str| {
        let Some(source) = source.as_object() else { return };
        let url = js_trim(first_text(source, &["url", "uri", "href", "source_url"]));
        if url.is_empty() {
            return;
        }
        let title = js_trim(first_text(source, &["title", "query", "name"]));
        let title = if title.is_empty() { js_trim(fallback_title) } else { title };
        out.push(NativeSource {
            url: url.to_string(),
            title: if title.is_empty() { url.to_string() } else { title.to_string() },
            snippet: js_trim(first_text(source, &["snippet", "text", "description"])).to_string(),
            published_date: None,
        });
    };
    for citation in citations {
        add(citation, "");
    }
    for call in calls {
        let action = call.get("action").unwrap_or(&Value::Null);
        let query = action.get("query").and_then(Value::as_str).unwrap_or_default();
        for source in action.get("sources").and_then(Value::as_array).into_iter().flatten() {
            add(source, query);
        }
        if let Some(url) = action.get("url").filter(|url| url.as_str().is_some_and(|s| !s.is_empty())) {
            add(&json!({ "url": url, "title": query }), query);
        }
        for url in action.get("urls").and_then(Value::as_array).into_iter().flatten() {
            add(&json!({ "url": url, "title": query }), query);
        }
    }
    let mut seen = HashSet::new();
    out.retain(|source| seen.insert(source.url.clone()));
    out
}

/// One search the provider ran, for the warning when no source URL came back.
fn search_call(call: &Value) -> SearchCall {
    let action = call.get("action").unwrap_or(&Value::Null);
    let mut urls: Vec<String> = Vec::new();
    if let Some(url) = action.get("url").and_then(Value::as_str).filter(|url| !url.is_empty()) {
        urls.push(url.to_string());
    }
    urls.extend(action.get("urls").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|url| !url.is_empty()).map(str::to_string));
    let sources = action
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|source| NativeSource {
            url: first_text(source, &["url", "uri", "href", "source_url"]).to_string(),
            title: first_text(source, &["title", "query", "name"]).to_string(),
            snippet: first_text(source, &["snippet", "text", "description"]).to_string(),
            published_date: Some(first_text(source, &["publishedDate", "published_date"]).to_string()).filter(|date| !date.is_empty()),
        })
        .collect();
    SearchCall { query: action.get("query").and_then(Value::as_str).unwrap_or_default().to_string(), sources, urls }
}

fn flatten_acp_citations(citations: &[NativeSource], calls: &[SearchCall]) -> Vec<NativeSource> {
    let mut out: Vec<NativeSource> = Vec::new();
    let mut add = |source: &NativeSource, fallback_title: &str| {
        let url = js_trim(&source.url);
        if url.is_empty() {
            return;
        }
        let title = js_trim(&source.title);
        let title = if title.is_empty() { js_trim(fallback_title) } else { title };
        out.push(NativeSource {
            url: url.to_string(),
            title: if title.is_empty() { url.to_string() } else { title.to_string() },
            snippet: js_trim(&source.snippet).to_string(),
            published_date: source.published_date.clone(),
        });
    };
    for citation in citations {
        add(citation, "");
    }
    for call in calls {
        for source in &call.sources {
            add(source, &call.query);
        }
        for url in &call.urls {
            add(&NativeSource { url: url.clone(), ..NativeSource::default() }, &call.query);
        }
    }
    let mut seen = HashSet::new();
    out.retain(|source| seen.insert(source.url.clone()));
    out
}

#[async_trait]
impl NativeWebSearch for HostedWebSearch {
    async fn search(&self, request: NativeSearchRequest, cancel: CancellationToken) -> Result<NativeSearchResult, NativeSearchError> {
        let candidates = self.routes.candidates(&request.thread).await.map_err(NativeSearchError::Failed)?;
        if candidates.is_empty() {
            return Err(NativeSearchError::Unavailable(self.routes.no_candidate_message(&request.thread).await));
        }
        let mut errors: Vec<String> = Vec::new();
        let mut unavailable: Vec<String> = Vec::new();
        for candidate in candidates {
            if candidate.family == SearchFamily::Acp {
                let call = AcpSearchCall {
                    thread: request.thread.clone(),
                    candidate: candidate.clone(),
                    request: AcpSearchRequest {
                        provider: candidate.provider.clone(),
                        model: candidate.model.clone(),
                        effort: candidate.effort.clone(),
                        query: request.query.clone(),
                        site: request.site.clone(),
                        locale: request.locale.clone(),
                        max_results: request.max_results,
                        context_size: request.context_size.clone(),
                    },
                };
                match self.sender.send_acp(call, &cancel).await {
                    Ok(reply) => {
                        let citations = flatten_acp_citations(&reply.citations, &reply.calls);
                        return Ok(NativeSearchResult {
                            provider: candidate.provider,
                            answer: js_trim(&reply.answer).to_string(),
                            citations,
                            calls: reply.calls,
                            model: reply.model.filter(|model| !model.is_empty()).or_else(|| Some(candidate.model).filter(|model| !model.is_empty())),
                            usage: reply.usage,
                        });
                    }
                    Err(error) => {
                        if error.unavailable && !cancel.is_cancelled() {
                            unavailable.push(error.message);
                            continue;
                        }
                        if !error.capacity || cancel.is_cancelled() {
                            return Err(NativeSearchError::Failed(error.message));
                        }
                        let model = if candidate.model.is_empty() { String::new() } else { format!("/{}", candidate.model) };
                        errors.push(format!("{}{model}/search_web: {}", candidate.provider, error.message));
                    }
                }
                continue;
            }
            let tool_type = tool_types(&candidate).remove(0);
            let call = HostedSearchCall {
                thread: request.thread.clone(),
                tool: hosted_tool(&request, &tool_type, candidate.family),
                include: if candidate.family == SearchFamily::Openai { vec!["web_search_call.action.sources".to_string()] } else { Vec::new() },
                tool_choice: if candidate.family == SearchFamily::Gemini { "auto" } else { "required" },
                system: SYSTEM_PROMPT.to_string(),
                user: request.prompt.clone(),
                candidate: candidate.clone(),
            };
            match self.sender.send(call, &cancel).await {
                Ok(reply) => {
                    return Ok(NativeSearchResult {
                        provider: candidate.provider,
                        answer: js_trim(&reply.content).to_string(),
                        citations: flatten_citations(&reply.citations, &reply.web_search_calls),
                        calls: reply.web_search_calls.iter().map(search_call).collect(),
                        model: reply.model.filter(|model| !model.is_empty()).or_else(|| Some(candidate.model).filter(|model| !model.is_empty())),
                        usage: reply.usage,
                    });
                }
                Err(error) => {
                    if error.unavailable && !cancel.is_cancelled() {
                        unavailable.push(error.message);
                        continue;
                    }
                    if !error.capacity || cancel.is_cancelled() {
                        return Err(NativeSearchError::Failed(error.message));
                    }
                    let model = if candidate.model.is_empty() { String::new() } else { format!("/{}", candidate.model) };
                    errors.push(format!("{}{model}/{tool_type}: {}", candidate.provider, error.message));
                }
            }
        }
        if errors.is_empty() {
            return Err(NativeSearchError::Unavailable(if unavailable.len() == 1 {
                unavailable.remove(0)
            } else {
                unavailable.join(" | ")
            }));
        }
        Err(NativeSearchError::Failed(format!("native web search failed: {}", errors.join(" | "))))
    }
}

#[cfg(test)]
mod user_location_tests {
    use super::*;

    fn request(locale: Option<Value>) -> NativeSearchRequest {
        NativeSearchRequest {
            thread: ThreadId::from("t"),
            query: "q".into(),
            site: None,
            locale,
            context_size: "low".into(),
            max_results: 5,
            prompt: String::new(),
        }
    }

    /// `nativeWebSearchUserLocation`: an object locale reaches Anthropic and OpenAI as an approximate `user_location`.
    #[test]
    fn an_object_locale_is_the_providers_user_location() {
        let locale = json!({ "country": "KR", "city": " Seoul ", "language": "ko", "region": "", "timezone": "Asia/Seoul" });
        let want = json!({ "type": "approximate", "country": "KR", "city": "Seoul", "timezone": "Asia/Seoul" });
        let request = request(Some(locale));
        assert_eq!(hosted_tool(&request, "web_search", SearchFamily::Openai)["user_location"], want);
        assert_eq!(hosted_tool(&request, "web_search", SearchFamily::Anthropic)["user_location"], want);
        assert!(hosted_tool(&request, "web_search", SearchFamily::Xai).get("user_location").is_none());
        assert!(hosted_tool(&self::request(Some(json!("ko-KR"))), "web_search", SearchFamily::Openai).get("user_location").is_none());
        assert!(hosted_tool(&self::request(Some(json!({ "language": "ko" }))), "web_search", SearchFamily::Openai).get("user_location").is_none());
    }
}
