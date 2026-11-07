//! The provider-hosted web search (Node `createNativeWebSearch`): the route
//! chain yields provider/model candidates; the first one the provider serves
//! answers, and only a capacity refusal moves on to the next. What a provider
//! call is (the registry, credentials, the wire) sits behind
//! [`HostedSearchSender`]; which providers are candidates sits behind
//! [`SearchRoutes`].

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_js::is_js_space;
use mixdog_core_api::ids::ThreadId;
use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use url::Url;

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
/// resolved to candidates: de-duplicated by provider, in route order. Both
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
}

#[async_trait]
pub trait HostedSearchSender: Send + Sync {
    async fn send(&self, call: HostedSearchCall, cancel: &CancellationToken) -> Result<HostedSearchReply, HostedSearchError>;
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
    let has_scheme = raw
        .get(..8)
        .is_some_and(|head| head.eq_ignore_ascii_case("https://"))
        || raw.get(..7).is_some_and(|head| head.eq_ignore_ascii_case("http://"));
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
    }
}

fn hosted_tool(request: &NativeSearchRequest, tool_type: &str, family: SearchFamily) -> Value {
    let domains = request.site.as_deref().map(allowed_domains).unwrap_or_default();
    let kind = if js_trim(tool_type).is_empty() { "web_search" } else { js_trim(tool_type) };
    match family {
        SearchFamily::Gemini => json!({ "type": kind }),
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
            }
            tool
        }
    }
}

const SYSTEM_PROMPT: &str = "You are Mixdog native web search.\nUse the hosted web_search tool for current or external facts.\nAnswer concisely, cite source URLs, and do not request local tools or file edits.";

fn first_text<'a>(source: &'a Map<String, Value>, names: &[&str]) -> &'a str {
    names
        .iter()
        .filter_map(|name| source.get(*name).and_then(Value::as_str))
        .find(|text| !text.is_empty())
        .unwrap_or_default()
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
    urls.extend(
        action
            .get("urls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|url| !url.is_empty())
            .map(str::to_string),
    );
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
            published_date: Some(first_text(source, &["publishedDate", "published_date"]).to_string())
                .filter(|date| !date.is_empty()),
        })
        .collect();
    SearchCall {
        query: action.get("query").and_then(Value::as_str).unwrap_or_default().to_string(),
        sources,
        urls,
    }
}

#[async_trait]
impl NativeWebSearch for HostedWebSearch {
    async fn search(&self, request: NativeSearchRequest, cancel: CancellationToken) -> Result<NativeSearchResult, String> {
        let candidates = self.routes.candidates(&request.thread).await?;
        if candidates.is_empty() {
            return Err(self.routes.no_candidate_message(&request.thread).await);
        }
        let mut errors: Vec<String> = Vec::new();
        for candidate in candidates {
            let tool_type = tool_types(&candidate).remove(0);
            let call = HostedSearchCall {
                thread: request.thread.clone(),
                tool: hosted_tool(&request, &tool_type, candidate.family),
                include: if candidate.family == SearchFamily::Openai {
                    vec!["web_search_call.action.sources".to_string()]
                } else {
                    Vec::new()
                },
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
                    if !error.capacity || cancel.is_cancelled() {
                        return Err(error.message);
                    }
                    let model = if candidate.model.is_empty() { String::new() } else { format!("/{}", candidate.model) };
                    errors.push(format!("{}{model}/{tool_type}: {}", candidate.provider, error.message));
                }
            }
        }
        Err(format!("native web search failed: {}", errors.join(" | ")))
    }
}
