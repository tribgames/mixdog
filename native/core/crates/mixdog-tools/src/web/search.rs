//! `web_search`: the configured route's provider runs its built-in search tool;
//! this module owns the request shape, de-duplication of identical in-flight
//! searches, the result cache and the text rendering.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::cache::NodeCache;
use super::cache::node_cache_key;
use super::format::clip;

const CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const NODE_PROVIDER: &str = "native-web-search";
pub const PROVIDER_UNAVAILABLE: &str =
    "web search provider unavailable: open /websearch to choose a web search provider/model";

#[derive(Clone, Debug)]
pub struct NativeSearchRequest {
    pub query: String,
    pub site: Option<String>,
    pub locale: Option<String>,
    pub context_size: String,
    pub max_results: usize,
    pub prompt: String,
}

#[derive(Clone, Debug, Default)]
pub struct NativeSource {
    pub url: String,
    pub title: String,
    pub snippet: String,
    pub published_date: Option<String>,
}

/// One search the provider ran, with the pages it reached.
#[derive(Clone, Debug, Default)]
pub struct SearchCall {
    pub query: String,
    pub sources: Vec<NativeSource>,
    pub urls: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct NativeSearchResult {
    pub provider: String,
    pub answer: String,
    pub citations: Vec<NativeSource>,
    pub calls: Vec<SearchCall>,
    /// The model that answered, when the provider names it.
    pub model: Option<String>,
    /// The provider's usage object, verbatim.
    pub usage: Option<serde_json::Value>,
}

/// The provider seam (spec P3 "native tool" call). Cancellation = cancel the
/// provider stream.
#[async_trait]
pub trait NativeWebSearch: Send + Sync {
    async fn search(&self, request: NativeSearchRequest, cancel: CancellationToken) -> Result<NativeSearchResult, String>;
}

#[derive(Clone, Debug)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub from_call: bool,
    pub published_date: Option<String>,
}

#[derive(Debug)]
pub struct SearchPayload {
    pub provider: String,
    pub answer: String,
    pub results: Vec<SearchHit>,
    pub warnings: Vec<String>,
    /// Node's `response.model` / `response.usage`: kept in the payload (and
    /// its cache), never part of the rendered text.
    pub model: Option<String>,
    pub usage: Option<serde_json::Value>,
}

impl SearchPayload {
    /// The payload read back from a cached `node_payload` (possibly written by Node).
    pub(super) fn from_node(stored: &Value) -> Option<Self> {
        let response = stored.get("response")?;
        let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        let results = response
            .get("results")?
            .as_array()?
            .iter()
            .map(|hit| {
                Some(SearchHit {
                    title: text(hit, "title")?,
                    url: text(hit, "url")?,
                    snippet: text(hit, "snippet").unwrap_or_default(),
                    from_call: hit.get("source").and_then(Value::as_str) == Some("web_search_call"),
                    published_date: text(hit, "publishedDate"),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let warnings = response
            .get("warnings")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        Some(Self {
            provider: text(stored, "provider").unwrap_or_else(|| NODE_PROVIDER.to_string()),
            answer: text(response, "answer").unwrap_or_default(),
            results,
            warnings,
            model: text(response, "model"),
            usage: response.get("usage").filter(|usage| !usage.is_null()).cloned(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct SearchArgs {
    pub query: String,
    /// `keywords` was a list of one query (Node keys such a search by the list).
    pub listed: bool,
    pub site: Option<String>,
    /// A string such as `ko-KR`, or the object form with country/language/region/city/timezone.
    pub locale: Option<Value>,
    pub context_size: String,
    pub max_results: usize,
}

type SearchOutcome = Option<Result<Arc<SearchPayload>, String>>;

struct Flight {
    cancel: CancellationToken,
    waiters: AtomicUsize,
    outcome: tokio::sync::watch::Receiver<SearchOutcome>,
}

struct Core {
    provider: Option<Arc<dyn NativeWebSearch>>,
    cache: Arc<NodeCache>,
    flights: Mutex<HashMap<String, Arc<Flight>>>,
}

pub struct SearchService {
    core: Arc<Core>,
}

/// A string locale as it is, an object as `JSON.stringify` writes it.
fn locale_label(args: &SearchArgs) -> Option<String> {
    args.locale.as_ref().map(|locale| match locale {
        Value::String(text) => text.clone(),
        other => mixdog_js::json_stringify(other),
    })
}

fn build_prompt(args: &SearchArgs) -> String {
    let mut lines = vec![
        "Perform a concise web research task for Mixdog web search.".to_string(),
        String::new(),
        format!("Query: {}", args.query),
    ];
    if let Some(site) = &args.site {
        lines.push(format!("Site/domain restriction: {site}"));
    }
    if let Some(locale) = locale_label(args) {
        lines.push(format!("Locale: {locale}"));
    }
    lines.push(format!("Max results: {}", args.max_results));
    lines.push(String::new());
    lines.push("Return a short answer first, then cite useful results as title + URL + one-line snippet.".to_string());
    lines.push("Do not edit files.".to_string());
    lines.join("\n")
}

/// Node `webSearchArgsForCacheKey`: `site` and `locale` are null when empty, the context size
/// defaults to `low` and the result cap is clamped to 1..=20.
fn cache_args(args: &SearchArgs) -> Value {
    let query = mixdog_js::js_trim(&args.query);
    json!({
        "keywords": if args.listed { json!([query]) } else { json!(query) },
        "site": match args.site.as_deref() {
            Some(text) if !text.is_empty() => json!(text),
            _ => Value::Null,
        },
        "locale": args.locale.clone().unwrap_or(Value::Null),
        "contextSize": if args.context_size.is_empty() { "low" } else { args.context_size.as_str() },
        "maxResults": args.max_results.clamp(1, 20),
    })
}

/// Node `buildCacheKey('web_search', { provider, ...cacheArgs })`.
pub(super) fn cache_key(args: &SearchArgs) -> String {
    let mut payload = json!({ "provider": NODE_PROVIDER });
    if let (Some(base), Value::Object(rest)) = (payload.as_object_mut(), cache_args(args)) {
        base.extend(rest);
    }
    node_cache_key("web_search", &payload)
}

/// The payload Node caches for a search, as far as its size goes.
pub(super) fn node_payload(payload: &SearchPayload, args: &SearchArgs, duration_ms: u64) -> Value {
    let cache = cache_args(args);
    let query = json!(mixdog_js::js_trim(&args.query));
    let results: Vec<Value> = payload
        .results
        .iter()
        .map(|hit| {
            json!({
                "title": hit.title,
                "url": hit.url,
                "snippet": hit.snippet,
                "source": if hit.from_call { "web_search_call" } else { "citation" },
                "provider": NODE_PROVIDER,
                "publishedDate": hit.published_date,
            })
        })
        .collect();
    json!({
        "tool": "web_search",
        "provider": payload.provider,
        "response": {
            "usedProvider": payload.provider,
            "query": query,
            "rawQuery": query,
            "answer": payload.answer,
            "model": payload.model,
            "durationMs": duration_ms,
            "usage": payload.usage,
            "results": results,
            "warnings": payload.warnings,
            "site": cache["site"],
            "locale": cache["locale"],
        },
    })
}

/// `text.replace(/\s+/g, ' ').trim()`.
pub(super) fn collapse(text: &str) -> String {
    mixdog_js::js_words(text).collect::<Vec<_>>().join(" ")
}

pub(super) fn normalize(result: NativeSearchResult, max_results: usize) -> SearchPayload {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut add = |source: &NativeSource, fallback_title: &str, from_call: bool| {
        let url = mixdog_js::js_trim(&source.url).to_string();
        if url.is_empty() {
            return;
        }
        let title = [mixdog_js::js_trim(&source.title), mixdog_js::js_trim(fallback_title), url.as_str()]
            .into_iter()
            .find(|candidate| !candidate.is_empty())
            .unwrap_or("(untitled)")
            .to_string();
        hits.push(SearchHit {
            title,
            url,
            snippet: collapse(&source.snippet),
            from_call,
            published_date: source.published_date.clone(),
        });
    };
    for citation in &result.citations {
        add(citation, "", false);
    }
    for call in &result.calls {
        for source in &call.sources {
            add(source, &call.query, true);
        }
        for url in &call.urls {
            add(&NativeSource { url: url.clone(), ..NativeSource::default() }, &call.query, true);
        }
    }
    let mut seen = HashSet::new();
    hits.retain(|hit| seen.insert(hit.url.clone()));
    hits.truncate(max_results);
    let mut warnings = Vec::new();
    if hits.is_empty() && !result.calls.is_empty() {
        warnings.push("native web search returned no source URLs".to_string());
    }
    SearchPayload {
        provider: if result.provider.is_empty() { NODE_PROVIDER.to_string() } else { result.provider },
        answer: mixdog_js::js_trim(&result.answer).to_string(),
        results: hits,
        warnings,
        model: result.model,
        usage: result.usage,
    }
}

impl SearchService {
    pub fn new(provider: Option<Arc<dyn NativeWebSearch>>, cache: Arc<NodeCache>) -> Self {
        Self {
            core: Arc::new(Core {
                provider,
                cache,
                flights: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// One query. Identical in-flight searches share one provider call; the
    /// provider call is cancelled once every caller waiting on it has left.
    pub async fn search(&self, args: &SearchArgs, cancel: &CancellationToken) -> Result<Arc<SearchPayload>, String> {
        let key = cache_key(args);
        if let Some(stored) = self.core.cache.get(&key).await
            && let Some(hit) = SearchPayload::from_node(&stored)
        {
            return Ok(Arc::new(hit));
        }
        let flight = {
            let mut flights = self.core.flights.lock().unwrap_or_else(|p| p.into_inner());
            let flight = flights
                .entry(key.clone())
                .or_insert_with(|| self.start(&key, args))
                .clone();
            flight.waiters.fetch_add(1, Ordering::SeqCst);
            flight
        };
        let _leave = Leave {
            core: &self.core,
            key: &key,
            flight: flight.clone(),
        };
        tokio::select! {
            () = cancel.cancelled() => Err("web search aborted".to_string()),
            result = Self::await_outcome(flight.outcome.clone()) => result,
        }
    }

    async fn await_outcome(mut outcome: tokio::sync::watch::Receiver<SearchOutcome>) -> Result<Arc<SearchPayload>, String> {
        loop {
            if let Some(result) = outcome.borrow().clone() {
                return result;
            }
            if outcome.changed().await.is_err() {
                return Err("web search aborted".to_string());
            }
        }
    }

    fn start(&self, key: &str, args: &SearchArgs) -> Arc<Flight> {
        let cancel = CancellationToken::new();
        let core = self.core.clone();
        let request = NativeSearchRequest {
            query: args.query.clone(),
            site: args.site.clone(),
            locale: locale_label(args),
            context_size: args.context_size.clone(),
            max_results: args.max_results,
            prompt: build_prompt(args),
        };
        let key = key.to_string();
        let flight_cancel = cancel.clone();
        let max_results = args.max_results;
        let args = args.clone();
        let (sender, outcome) = tokio::sync::watch::channel(None);
        tokio::spawn(async move {
            let result = async {
                let Some(provider) = core.provider.clone() else {
                    return Err(PROVIDER_UNAVAILABLE.to_string());
                };
                let started = Instant::now();
                let found = provider.search(request, flight_cancel).await?;
                let payload = Arc::new(normalize(found, max_results));
                let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                core.cache.put(key, node_payload(&payload, &args, duration_ms), CACHE_TTL, 0).await;
                Ok(payload)
            }
            .await;
            let _ = sender.send(Some(result));
        });
        Arc::new(Flight {
            cancel,
            waiters: AtomicUsize::new(0),
            outcome,
        })
    }
}

struct Leave<'a> {
    core: &'a Core,
    key: &'a str,
    flight: Arc<Flight>,
}

impl Drop for Leave<'_> {
    fn drop(&mut self) {
        let mut flights = self.core.flights.lock().unwrap_or_else(|p| p.into_inner());
        if self.flight.waiters.fetch_sub(1, Ordering::SeqCst) == 1 {
            if flights.get(self.key).is_some_and(|f| Arc::ptr_eq(f, &self.flight)) {
                flights.remove(self.key);
            }
            self.flight.cancel.cancel();
        }
    }
}

fn text_cites_url(text: &str, url: &str) -> bool {
    text.match_indices(url).any(|(at, _)| {
        let mut rest = text[at + url.len()..].chars();
        let follows = match rest.next() {
            Some(c) if c.is_ascii_alphanumeric() || "/?#&=%_~-".contains(c) => true,
            Some('.') => rest.next().is_some_and(|c| c.is_ascii_alphanumeric()),
            _ => false,
        };
        !follows
    })
}

pub fn format_results(payload: &SearchPayload) -> String {
    const TITLE_CAP: usize = 200;
    const SNIPPET_CAP: usize = 600;
    const ANSWER_CAP: usize = 4000;
    let results: Vec<&SearchHit> = payload.results.iter().collect();
    let mut blocks: Vec<String> = Vec::new();
    if !payload.warnings.is_empty() {
        blocks.push(format!("Warnings: {}", payload.warnings.join("; ")));
    }
    if results.is_empty() && payload.answer.is_empty() {
        blocks.push("(no search results)".to_string());
        return blocks.join("\n\n");
    }
    let shown_answer = if payload.answer.is_empty() {
        String::new()
    } else {
        clip(&payload.answer, ANSWER_CAP)
    };
    if !shown_answer.is_empty() {
        blocks.push(shown_answer.clone());
    }
    if results.is_empty() {
        return blocks.join("\n\n");
    }
    // A label shared by several URLs names the search, not a page.
    let mut urls_by_title: HashMap<&str, HashSet<&str>> = HashMap::new();
    for hit in &results {
        if !hit.title.is_empty() && !hit.url.is_empty() {
            urls_by_title.entry(&hit.title).or_default().insert(&hit.url);
        }
    }
    let mut entries: Vec<String> = Vec::new();
    for hit in &results {
        let snippet = clip(mixdog_js::js_trim(&hit.snippet), SNIPPET_CAP);
        let date = hit.published_date.as_deref().unwrap_or("");
        let url_part = [hit.url.as_str(), date]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" — ");
        let query_labelled = hit.title.is_empty()
            || hit.title == hit.url
            || hit.from_call
            || urls_by_title.get(hit.title.as_str()).is_some_and(|urls| urls.len() > 1);
        if !hit.url.is_empty() && snippet.is_empty() && query_labelled {
            if !text_cites_url(&shown_answer, &hit.url) {
                entries.push(format!("{}. {url_part}", entries.len() + 1));
            }
            continue;
        }
        let title = clip(if hit.title.is_empty() { "(no title)" } else { &hit.title }, TITLE_CAP);
        let mut lines = vec![format!("{}. {title}", entries.len() + 1)];
        if !url_part.is_empty() {
            lines.push(format!("   {url_part}"));
        }
        if !snippet.is_empty() && snippet != title && snippet != hit.url {
            lines.push(format!("   {snippet}"));
        }
        entries.push(lines.join("\n"));
    }
    if !entries.is_empty() {
        blocks.push(entries.join("\n\n"));
    }
    blocks.join("\n\n")
}
