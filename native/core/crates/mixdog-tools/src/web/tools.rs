//! The four web tools over one shared service.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::future::join_all;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::JsonValue;
use serde_json::json;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::args::FetchArgs;
use super::lanes::WebLanes;
use super::args::fetch_args;
use super::args::search_args;
use super::cache::CacheFile;
use super::cache::NodeCache;
use super::cache::node_cache_key;
use super::error::FetchError;
use super::format::FetchItem;
use super::format::continuation;
use super::format::format_fetch;
use super::format::paginate;
use super::http::Fetcher;
use super::pipeline::Page;
use super::pipeline::PageRenderer;
use super::pipeline::Pipeline;
use super::search::NativeWebSearch;
use super::search::SearchArgs;
use super::search::SearchService;
use super::search::format_results;
use super::ssrf::AddressPolicy;

const PAGE_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
/// The `name` of the plain `Error` Node throws for an address-policy block; it serves as the code.
const NODE_ERROR_NAME: &str = "Error";
const FETCH_CACHE_VERSION: &str = "document-pipeline-v3";
const FETCH_URL_CAP: usize = 10;
const FETCH_CONCURRENCY: usize = 3;
const SEARCH_FANOUT: usize = 10;
const LOCAL_BATCH_CAP: usize = 8;

pub struct WebConfig {
    /// Product version, sent in the user agent.
    pub version: String,
    pub renderer: Option<Arc<dyn PageRenderer>>,
    pub search: Option<Arc<dyn NativeWebSearch>>,
    pub request_timeout: Duration,
    /// Where the page and search caches persist (`cache.local.json` in the data directory);
    /// without it they live in memory only.
    pub cache_file: Option<CacheFile>,
    pub lanes: WebLanes,
    pub(crate) public_policy: AddressPolicy,
}

impl WebConfig {
    pub fn new(version: impl Into<String>, lanes: WebLanes) -> Self {
        Self {
            version: version.into(),
            lanes,
            renderer: None,
            search: None,
            request_timeout: Duration::from_secs(120),
            cache_file: None,
            public_policy: AddressPolicy::PublicOnly,
        }
    }
}

pub struct WebService {
    public: Arc<Fetcher>,
    loopback: Fetcher,
    pipeline: Pipeline,
    cache: Arc<NodeCache>,
    search: SearchService,
    timeout: Duration,
}

fn unavailable(capability: &str, message: String) -> ToolError {
    ToolError::new(
        ToolErrorCode::Unavailable {
            capability: capability.to_string(),
            reason: message.clone(),
        },
        message,
    )
}

fn text_output(text: String) -> ToolOutput {
    ToolOutput {
        parts: vec![ToolPart::Text(text)],
        ..ToolOutput::default()
    }
}

impl WebService {
    pub fn new(config: WebConfig) -> Result<Arc<Self>, FetchError> {
        let public = Arc::new(Fetcher::new(config.public_policy, &config.version, config.lanes)?);
        let cache = Arc::new(NodeCache::new(config.cache_file));
        Ok(Arc::new(Self {
            loopback: Fetcher::new(AddressPolicy::LoopbackOnly, &config.version, config.lanes)?,
            pipeline: Pipeline::new(public.clone(), config.renderer),
            public,
            search: SearchService::new(config.search, cache.clone()),
            cache,
            timeout: config.request_timeout,
        }))
    }

    /// Writes any unsaved cache entries now (Node `flushCacheState`, run on stop).
    pub async fn flush_cache(&self) {
        self.cache.flush().await;
    }

    pub fn tools(self: &Arc<Self>) -> Vec<Arc<dyn Tool>> {
        vec![
            Arc::new(WebSearchTool::new(self.clone())),
            Arc::new(WebFetchTool::new(self.clone())),
            Arc::new(LocalFetchTool::new(self.clone())),
            Arc::new(ImageFetchTool::new(self.clone())),
        ]
    }

    async fn fetch_one(&self, url: &str, args: &FetchArgs, cancel: &CancellationToken) -> FetchItem {
        let normalized = Url::parse(url).map_or_else(|_| url.to_string(), |parsed| parsed.to_string());
        let cache_key = node_cache_key("fetch:url", &json!({ "url": normalized, "version": FETCH_CACHE_VERSION }));
        if let Some(payload) = self.cache.get(&cache_key).await
            && let Some(page) = Page::from_node(&payload)
        {
            return success_item(&page, args);
        }
        let error_item = |error: &FetchError, code: &str, failures, attempts| FetchItem::Error {
            url: url.to_string(),
            error: error.message.clone(),
            error_code: code.to_string(),
            failures,
            attempts,
        };
        // Node's `assertPublicUrl` throws a plain `Error` before the pipeline runs: the item
        // carries the message and the error's name as its code, and no diagnostics.
        let mut target = match self.public.parse_url(url) {
            Ok(target) => target,
            Err(error) => return error_item(&error, NODE_ERROR_NAME, Vec::new(), Vec::new()),
        };
        target.set_fragment(None);
        match self.pipeline.run(&target, self.timeout, &cancel.clone().into()).await {
            Ok(page) => {
                self.cache
                    .put(
                        cache_key,
                        page_payload(&page, target.as_str()),
                        PAGE_CACHE_TTL,
                        excerpt_size_gap(&page),
                    )
                    .await;
                success_item(&page, args)
            }
            Err(failure) => error_item(&failure.error, failure.code, failure.failures, failure.attempts),
        }
    }

    async fn web_fetch(&self, args: FetchArgs, cancel: &CancellationToken) -> ToolOutcome {
        let urls: Vec<String> = args.urls.iter().take(FETCH_URL_CAP).cloned().collect();
        let truncated = if args.urls.len() > urls.len() { args.urls.len() } else { 0 };
        let gate = Semaphore::new(FETCH_CONCURRENCY);
        let items: Vec<FetchItem> = join_all(urls.iter().map(|url| async {
            let _turn = gate.acquire().await;
            self.fetch_one(url, &args, cancel).await
        }))
        .await;
        self.cache.flush().await;
        let text = format_fetch(&items, truncated);
        if items.iter().any(|item| matches!(item, FetchItem::Success { .. })) {
            Ok(text_output(text))
        } else {
            Err(unavailable("web_fetch", text))
        }
    }

    async fn web_search(&self, args: &JsonValue, thread: &ThreadId, cancel: &CancellationToken) -> ToolOutcome {
        let input = search_args(args)?;
        let listed_alone = input.listed && input.queries.len() == 1;
        let mut queries: Vec<String> = Vec::new();
        for query in input.queries {
            if !queries.contains(&query) {
                queries.push(query);
            }
        }
        let one = |query: String| SearchArgs {
            query,
            listed: listed_alone,
            site: input.site.clone(),
            locale: input.locale.clone(),
            context_size: input.context_size.clone(),
            max_results: input.max_results,
        };
        if let [only] = queries.as_slice() {
            return match self.search.search(&one(only.clone()), thread, cancel).await {
                Ok(payload) => Ok(text_output(format_results(&payload))),
                Err(message) => Err(unavailable("web_search", format!("Web search failed: {message}"))),
            };
        }
        let gate = Semaphore::new(SEARCH_FANOUT);
        let (gate, one) = (&gate, &one);
        let sections: Vec<(String, bool)> = join_all(queries.iter().map(|query| async move {
            let _turn = gate.acquire().await;
            let result = self.search.search(&one(query.clone()), thread, cancel).await;
            let (text, failed) = match result {
                Ok(payload) => (format_results(&payload), false),
                Err(message) => (format!("Web search failed: {message}"), true),
            };
            (format!("### Query: {query}\n\n{text}"), failed)
        }))
        .await;
        let failed = sections.iter().filter(|(_, failed)| *failed).count();
        let summary = if failed > 0 {
            format!(
                "[web_search] {failed}/{} queries failed; successful results are retained.\n\n",
                queries.len()
            )
        } else {
            String::new()
        };
        let joined: Vec<String> = sections.into_iter().map(|(text, _)| text).collect();
        let text = format!("{summary}{}", joined.join("\n\n---\n\n"));
        if failed > 0 {
            let mut error = unavailable("web_search", text.clone());
            error.partial = Some(text_output(text));
            return Err(error);
        }
        Ok(text_output(text))
    }

    async fn local_fetch(&self, args: FetchArgs, cancel: &CancellationToken) -> ToolOutcome {
        self.bounded_batch(&args, cancel, |url| async move {
            let parsed = self.loopback.parse_url(&url)?;
            let text = self.loopback.fetch_text(&parsed).await?;
            let window = paginate(&text, args.start_index, args.max_length);
            Ok(vec![ToolPart::Text(format!("{url}\n\n{}{}", window.content, continuation(&window)))])
        })
        .await
    }

    async fn image_fetch(&self, args: FetchArgs, cancel: &CancellationToken) -> ToolOutcome {
        self.bounded_batch(&args, cancel, |url| async move {
            let parsed = self.public.parse_url(&url)?;
            let (mime, bytes) = self.public.fetch_image(&parsed).await?;
            Ok(vec![
                ToolPart::Text(format!("Downloaded image: {url} ({mime}, {} bytes)", bytes.len())),
                ToolPart::Image {
                    mime,
                    data: ImageData::Bytes(bytes),
                },
            ])
        })
        .await
    }

    /// Sequential URLs under one request deadline; the first failure ends the call.
    async fn bounded_batch<F, Fut>(&self, args: &FetchArgs, cancel: &CancellationToken, each: F) -> ToolOutcome
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<Vec<ToolPart>, FetchError>>,
    {
        if args.urls.len() > LOCAL_BATCH_CAP {
            return Err(unavailable(
                "fetch",
                format!("Error: fetch batch exceeds maximum of {LOCAL_BATCH_CAP} URLs."),
            ));
        }
        let run = async {
            let mut parts = Vec::new();
            for url in &args.urls {
                parts.extend(each(url.clone()).await?);
            }
            Ok::<_, FetchError>(parts)
        };
        let outcome = tokio::select! {
            () = cancel.cancelled() => Err(FetchError::new(super::error::FetchKind::Cancelled, "Fetch cancelled")),
            result = mixdog_rt::time::timeout(self.timeout, run) => match result {
                Ok(result) => result,
                Err(_) => Err(FetchError::new(
                    super::error::FetchKind::Timeout,
                    "The operation was aborted due to timeout",
                )),
            },
        };
        match outcome {
            Ok(parts) => Ok(ToolOutput {
                parts,
                ..ToolOutput::default()
            }),
            Err(error) if error.kind == super::error::FetchKind::Cancelled => {
                Err(ToolError::new(ToolErrorCode::Cancelled, "Fetch cancelled"))
            }
            Err(error) => Err(unavailable("fetch", format!("Fetch failed: {}", error.message))),
        }
    }
}

/// The payload Node caches for a fetched page, `{ tool, ...page }` as the pipeline returns it.
/// `httpStatus` is a placeholder: a cached page is always 2xx, so it is three digits either way.
pub(super) fn page_payload(page: &Page, requested_url: &str) -> serde_json::Value {
    let failures: Vec<serde_json::Value> = page
        .failures
        .iter()
        .map(|failure| {
            let mut item = json!({ "extractor": failure.extractor, "error": failure.error, "code": failure.code });
            if let (Some(status), Some(map)) = (failure.status, item.as_object_mut()) {
                map.insert("status".into(), json!(status));
            }
            item
        })
        .collect();
    let attempts: Vec<serde_json::Value> = page
        .attempts
        .iter()
        .map(|attempt| {
            let elapsed = u64::try_from(attempt.elapsed_ms).unwrap_or(u64::MAX);
            match &attempt.code {
                None => json!({ "stage": attempt.stage, "status": "success", "elapsedMs": elapsed }),
                Some(code) => json!({ "stage": attempt.stage, "status": "error", "elapsedMs": elapsed, "code": code }),
            }
        })
        .collect();
    let tried: Vec<&str> = page.attempts.iter().map(|attempt| attempt.stage.as_str()).collect();
    let mut map = serde_json::Map::new();
    map.insert("tool".into(), json!("web_fetch"));
    map.insert("url".into(), json!(page.url));
    map.insert("title".into(), json!(page.title));
    map.insert("content".into(), json!(page.content));
    map.insert("excerpt".into(), json!(page.excerpt));
    map.insert("extractor".into(), json!(page.extractor));
    map.insert("format".into(), json!(page.format));
    map.insert("contentType".into(), json!(page.content_type));
    map.insert("httpStatus".into(), json!(200));
    if let Some(redirects) = &page.redirects {
        let records: Vec<serde_json::Value> = redirects
            .iter()
            .map(|hop| match hop.status {
                Some(status) => json!({ "url": hop.url, "status": status, "location": hop.location }),
                None => json!({ "url": hop.url, "location": hop.location, "status": "meta-refresh" }),
            })
            .collect();
        map.insert("redirects".into(), json!(records));
    }
    map.insert("requestedUrl".into(), json!(requested_url));
    map.insert("triedExtractors".into(), json!(tried));
    map.insert("failures".into(), json!(failures));
    map.insert("attempts".into(), json!(attempts));
    serde_json::Value::Object(map)
}

/// Units the excerpt takes in Node's serialized entry beyond what the stored text takes: a cut
/// inside a surrogate pair is a lone surrogate there (six units escaped), U+FFFD here.
pub(super) fn excerpt_size_gap(page: &Page) -> usize {
    let shown = mixdog_js::utf16_len(&mixdog_js::json_stringify(&json!(page.excerpt)));
    page.excerpt_json_len - shown
}

fn success_item(page: &Page, args: &FetchArgs) -> FetchItem {
    FetchItem::Success {
        url: page.url.clone(),
        title: page.title.clone(),
        window: paginate(&page.content, args.start_index, args.max_length),
        failures: page.failures.clone(),
        attempts: page.attempts.clone(),
    }
}

fn fetch_schema() -> JsonValue {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }],
                "description": "URL, or an array of up to 10; loopback and public URLs in separate calls.",
            },
            "startIndex": { "type": "integer", "minimum": 0, "description": "Character offset." },
            "maxLength": { "type": "integer", "minimum": 0, "description": "Default 20000; 0 unlimited." },
        },
        "required": ["url"],
        "additionalProperties": false,
    })
}

/// `hidden` is Node's `public: false`: a runtime-only target no model is shown (the spec's `public`).
fn spec(name: &str, title: &str, trigger: Option<&str>, description: &str, schema: JsonValue, open_world: bool, hidden: bool) -> ToolSpec {
    ToolSpec {
        name: name.to_string(),
        title: Some(title.to_string()),
        trigger: trigger.map(str::to_owned),
        public: !hidden,
        aliases: Vec::new(),
        description: description.to_string(),
        input_schema: schema,
        annotations: ToolAnnotations {
            title: Some(title.to_string()),
            read_only_hint: Some(true),
            destructive_hint: Some(false),
            idempotent_hint: Some(true),
            open_world_hint: Some(open_world),
            ..ToolAnnotations::default()
        },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }
}

macro_rules! web_tool {
    ($tool:ident, $name:literal, $title:literal, $trigger:expr, $description:literal, $schema:expr, $open_world:literal, $hidden:literal, |$svc:ident, $ctx:ident, $args:ident| $body:expr) => {
        pub struct $tool {
            service: Arc<WebService>,
            spec: ToolSpec,
        }

        impl $tool {
            pub fn new(service: Arc<WebService>) -> Self {
                Self {
                    service,
                    spec: spec($name, $title, $trigger, $description, $schema, $open_world, $hidden),
                }
            }
        }

        #[async_trait]
        impl Tool for $tool {
            fn spec(&self) -> &ToolSpec {
                &self.spec
            }

            async fn call(&self, $ctx: &ToolContext, $args: JsonValue) -> ToolOutcome {
                let $svc = &self.service;
                $body
            }
        }
    };
}

web_tool!(
    WebSearchTool,
    "web_search",
    "Mixdog Web Search",
    Some("Unfamiliar names, products, models, recent or external facts; search before answering from memory."),
    "Search the web for recent, external or unfamiliar facts (names, products, models) before answering from memory.",
    json!({
        "type": "object",
        "properties": {
            "query": {
                "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }],
                "description": "One query, or an array run as a batch.",
            },
            "site": { "type": "string", "description": "Domain filter." },
            "maxResults": { "type": "integer", "minimum": 1, "maximum": 20, "description": "Default 10." },
            "locale": { "type": "string", "description": "e.g. ko-KR." },
            "contextSize": { "type": "string", "enum": ["low", "medium", "high"], "description": "Default low." },
        },
        "required": ["query"],
        "additionalProperties": false,
    }),
    true,
    false,
    |service, ctx, args| service.web_search(&args, &ctx.thread_id, &ctx.cancel).await
);

web_tool!(
    WebFetchTool,
    "web_fetch",
    "Mixdog Web Fetch",
    Some("Page or docs body from a known URL; not discovery (web_search)."),
    "Fetch the page or docs body of known URLs; to find pages, use web_search.",
    fetch_schema(),
    true,
    false,
    |service, ctx, args| service.web_fetch(fetch_args(&args)?, &ctx.cancel).await
);

web_tool!(
    LocalFetchTool,
    "local_fetch",
    "Mixdog Loopback Fetch",
    None,
    "Runtime-only loopback HTTP(S) fetch target.",
    fetch_schema(),
    false,
    true,
    |service, ctx, args| service.local_fetch(fetch_args(&args)?, &ctx.cancel).await
);

web_tool!(
    ImageFetchTool,
    "image_fetch",
    "Mixdog Image Fetch",
    None,
    "Runtime-only bounded public image fetch target.",
    fetch_schema(),
    true,
    true,
    |service, ctx, args| service.image_fetch(fetch_args(&args)?, &ctx.cancel).await
);
