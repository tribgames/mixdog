//! The browser-rendered fetch stage (Node `scrapeWithPuppeteer`), over the
//! shared browser's DevTools endpoint. Every request the page makes is paused
//! and answered by [`Fetcher::fetch_for_browser`], so the address policy holds
//! for the document, its redirects and every subresource, and Chromium never
//! resolves a name itself.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use super::lanes::WebLanes;
use async_trait::async_trait;
use base64::Engine;
use reqwest::header::HeaderMap;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Semaphore;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::task::JoinSet;
use url::Url;

use super::cdp::Cdp;
use super::cdp::Event;
use super::error::FetchError;
use super::error::FetchKind;
use super::extract::extract_document;
use super::http::Fetcher;
use super::http::MAX_BODY_BYTES;
use super::http::assert_document_response;
use super::pipeline::PageRenderer;
use super::pipeline::RENDER_STAGE;
use super::pipeline::StagePage;
use super::ssrf::AddressPolicy;

const DEFAULT_POOL_PAGES: usize = 3;
const TEXT_POLL: Duration = Duration::from_millis(100);
const IDLE_TIME: Duration = Duration::from_millis(400);
const IDLE_CONCURRENCY: usize = 2;
const TEARDOWN: Duration = Duration::from_secs(2);

const HAS_TEXT: &str = r#"(() => { const text = (document.querySelector('main,[role="main"],article') || document.body)?.innerText?.trim() || ''; return Boolean(text); })()"#;
const PAGE_CONTENT: &str = "(() => { let content = ''; if (document.doctype) { content = new XMLSerializer().serializeToString(document.doctype); } if (document.documentElement) { content += document.documentElement.outerHTML; } return content; })()";

pub use mixdog_core_api::domain::ext::BrowserEndpoint;

pub struct BrowserRenderer {
    endpoint: Arc<dyn BrowserEndpoint>,
    fetcher: Arc<Fetcher>,
    slots: Semaphore,
}

/// What the page's event stream has shown so far.
struct PageState {
    document: Mutex<Option<(u16, HeaderMap)>>,
    document_error: Mutex<Option<FetchError>>,
    inflight: watch::Sender<usize>,
    dom_loaded: watch::Sender<HashSet<String>>,
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn launch_failed(message: &str) -> FetchError {
    FetchError::new(FetchKind::Network, format!("puppeteer launch failed: {message}"))
}

fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn millis(value: f64) -> Duration {
    Duration::from_millis(value.max(1.0) as u64)
}

impl BrowserRenderer {
    /// `version` is the product version sent in the user agent.
    pub fn new(endpoint: Arc<dyn BrowserEndpoint>, version: &str, lanes: WebLanes) -> Result<Arc<Self>, FetchError> {
        Self::with_policy(endpoint, AddressPolicy::PublicOnly, version, lanes)
    }

    pub(crate) fn with_policy(
        endpoint: Arc<dyn BrowserEndpoint>,
        policy: AddressPolicy,
        version: &str,
        lanes: WebLanes,
    ) -> Result<Arc<Self>, FetchError> {
        let pages = std::env::var("PUPPETEER_POOL_MAX_PAGES")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .filter(|pages| *pages > 0)
            .unwrap_or(DEFAULT_POOL_PAGES);
        Ok(Arc::new(Self {
            endpoint,
            fetcher: Arc::new(Fetcher::new(policy, version, lanes)?),
            slots: Semaphore::new(pages),
        }))
    }

    /// Answers one paused request through the policy-checked fetcher.
    async fn answer_paused(
        fetcher: &Fetcher,
        cdp: &Cdp,
        session: &str,
        main_frame: &str,
        state: &PageState,
        params: &Value,
    ) {
        let request_id = text_of(params, "requestId");
        let request = params.get("request").cloned().unwrap_or(Value::Null);
        let is_main_document = text_of(params, "resourceType") == "Document" && text_of(params, "frameId") == main_frame;
        let outcome = async {
            let url = Url::parse(text_of(&request, "url")).map_err(|_| FetchError::policy("Invalid URL in browser request"))?;
            let headers: Vec<(String, String)> = request
                .get("headers")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(name, value)| (name.clone(), value.as_str().unwrap_or_default().to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let method = match text_of(&request, "method") {
                "" => "GET",
                method => method,
            };
            let body = request.get("postData").and_then(Value::as_str).map(str::to_string);
            fetcher.fetch_for_browser(&url, method, &headers, body).await
        }
        .await;
        match outcome {
            Ok(response) => {
                if is_main_document {
                    *state.document.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some((response.status, response.headers.clone()));
                }
                let headers: Vec<Value> = response
                    .headers
                    .iter()
                    .filter(|(name, _)| !matches!(name.as_str(), "content-length" | "transfer-encoding" | "content-encoding"))
                    .map(|(name, value)| json!({ "name": name.as_str(), "value": String::from_utf8_lossy(value.as_bytes()) }))
                    .collect();
                let _ = cdp
                    .send(
                        "Fetch.fulfillRequest",
                        json!({
                            "requestId": request_id,
                            "responseCode": response.status,
                            "responseHeaders": headers,
                            "body": base64::engine::general_purpose::STANDARD.encode(&response.body),
                        }),
                        Some(session),
                    )
                    .await;
            }
            Err(error) => {
                if is_main_document {
                    *state.document_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(error);
                }
                let _ = cdp
                    .send(
                        "Fetch.failRequest",
                        json!({ "requestId": request_id, "errorReason": "Failed" }),
                        Some(session),
                    )
                    .await;
            }
        }
    }

    /// Consumes the page's events: the request gate, the in-flight request
    /// count and the DOMContentLoaded lifecycle marks.
    fn watch_events(
        fetcher: Arc<Fetcher>,
        cdp: &Arc<Cdp>,
        session: String,
        main_frame: String,
        state: Arc<PageState>,
        mut events: tokio::sync::broadcast::Receiver<Arc<Event>>,
    ) -> AbortOnDrop {
        let cdp = cdp.clone();
        AbortOnDrop(tokio::spawn(async move {
            let mut paused = JoinSet::new();
            let mut open: HashSet<String> = HashSet::new();
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                if event.session.as_deref() != Some(session.as_str()) {
                    continue;
                }
                let params = &event.params;
                match event.method.as_str() {
                    "Fetch.requestPaused" => {
                        let fetcher = fetcher.clone();
                        let cdp = cdp.clone();
                        let (session, main_frame, state, params) =
                            (session.clone(), main_frame.clone(), state.clone(), params.clone());
                        paused.spawn(async move {
                            Self::answer_paused(&fetcher, &cdp, &session, &main_frame, &state, &params).await;
                        });
                    }
                    "Network.requestWillBeSent" => {
                        if !text_of(params.get("request").unwrap_or(&Value::Null), "url").starts_with("data:") {
                            open.insert(text_of(params, "requestId").to_string());
                            state.inflight.send_replace(open.len());
                        }
                    }
                    "Network.loadingFinished" | "Network.loadingFailed" => {
                        open.remove(text_of(params, "requestId"));
                        state.inflight.send_replace(open.len());
                    }
                    "Page.lifecycleEvent" => {
                        if text_of(params, "name") == "DOMContentLoaded" && text_of(params, "frameId") == main_frame {
                            let loader = text_of(params, "loaderId").to_string();
                            state.dom_loaded.send_modify(|loaders| {
                                loaders.insert(loader);
                            });
                        }
                    }
                    _ => {}
                }
            }
        }))
    }

    async fn wait_for_text(cdp: &Cdp, session: &str, limit: Duration) -> Result<(), FetchError> {
        let poll = async {
            loop {
                let reply = cdp
                    .send(
                        "Runtime.evaluate",
                        json!({ "expression": HAS_TEXT, "returnByValue": true }),
                        Some(session),
                    )
                    .await?;
                if reply.pointer("/result/value").and_then(Value::as_bool) == Some(true) {
                    return Ok(());
                }
                tokio::time::sleep(TEXT_POLL).await;
            }
        };
        // Running out of time only means the page has no text yet.
        tokio::time::timeout(limit, poll).await.unwrap_or(Ok(()))
    }

    async fn wait_for_network_idle(state: &PageState, limit: Duration) {
        let mut inflight = state.inflight.subscribe();
        let idle = async {
            loop {
                if *inflight.borrow_and_update() <= IDLE_CONCURRENCY {
                    tokio::select! {
                        () = tokio::time::sleep(IDLE_TIME) => return,
                        changed = inflight.changed() => if changed.is_err() { return },
                    }
                } else if inflight.changed().await.is_err() {
                    return;
                }
            }
        };
        let _ = tokio::time::timeout(limit, idle).await;
    }

    async fn scrape(&self, cdp: &Arc<Cdp>, context_id: &str, url: &Url, budget: Duration) -> Result<StagePage, FetchError> {
        let target = cdp
            .send(
                "Target.createTarget",
                json!({ "url": "about:blank", "browserContextId": context_id }),
                None,
            )
            .await?;
        let attached = cdp
            .send(
                "Target.attachToTarget",
                json!({ "targetId": text_of(&target, "targetId"), "flatten": true }),
                None,
            )
            .await?;
        let session = text_of(&attached, "sessionId").to_string();
        let events = cdp.subscribe();
        let send = |method: &'static str, params: Value| {
            let session = session.clone();
            let cdp = cdp.clone();
            async move { cdp.send(method, params, Some(&session)).await }
        };
        send("Page.enable", json!({})).await?;
        send("Network.enable", json!({})).await?;
        send("Page.setLifecycleEventsEnabled", json!({ "enabled": true })).await?;
        send("Network.setBypassServiceWorker", json!({ "bypass": true })).await?;
        let tree = send("Page.getFrameTree", json!({})).await?;
        let main_frame = tree
            .pointer("/frameTree/frame/id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let state = Arc::new(PageState {
            document: Mutex::new(None),
            document_error: Mutex::new(None),
            inflight: watch::channel(0).0,
            dom_loaded: watch::channel(HashSet::new()).0,
        });
        let _gate = Self::watch_events(self.fetcher.clone(), cdp, session.clone(), main_frame, state.clone(), events);
        send(
            "Fetch.enable",
            json!({ "handleAuthRequests": false, "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] }),
        )
        .await?;

        let document_error = || state.document_error.lock().unwrap_or_else(|p| p.into_inner()).take();
        let navigated = send("Page.navigate", json!({ "url": url.as_str() })).await?;
        if let Some(reason) = navigated.get("errorText").and_then(Value::as_str) {
            return Err(document_error()
                .unwrap_or_else(|| FetchError::new(FetchKind::Network, format!("{reason} at {url}"))));
        }
        if let Some(loader) = navigated.get("loaderId").and_then(Value::as_str) {
            let mut loaded = state.dom_loaded.subscribe();
            let _ = loaded.wait_for(|loaders| loaders.contains(loader)).await;
        }
        let response = state.document.lock().unwrap_or_else(|p| p.into_inner()).take();
        let Some((status, headers)) = response else {
            return Err(document_error()
                .unwrap_or_else(|| FetchError::new(FetchKind::Network, "Browser navigation returned no HTTP response")));
        };
        assert_document_response(status, &headers)?;

        let budget_ms = budget.as_millis() as f64;
        Self::wait_for_text(cdp, &session, millis(5000f64.min(1f64.max(budget_ms / 3.0)))).await?;
        Self::wait_for_network_idle(&state, millis(2500f64.min(1f64.max(budget_ms / 4.0)))).await;

        let frame = send("Page.getFrameTree", json!({})).await?;
        let mut final_url = text_of(frame.pointer("/frameTree/frame").unwrap_or(&Value::Null), "url").to_string();
        final_url.push_str(text_of(frame.pointer("/frameTree/frame").unwrap_or(&Value::Null), "urlFragment"));
        let final_url = self.fetcher.parse_url(&final_url)?;
        let content = send(
            "Runtime.evaluate",
            json!({ "expression": PAGE_CONTENT, "returnByValue": true }),
        )
        .await?;
        if content.get("exceptionDetails").is_some() {
            return Err(FetchError::new(FetchKind::Network, "browser could not read the page content"));
        }
        let html = text_of(content.get("result").unwrap_or(&Value::Null), "value").to_string();
        if html.len() > MAX_BODY_BYTES {
            return Err(FetchError::policy(format!(
                "puppeteer page content too large: {} bytes > cap={MAX_BODY_BYTES}",
                html.len()
            )));
        }
        let at = final_url.clone();
        let extracted = super::lanes::run(self.fetcher.lanes().extract, move |_| extract_document(&at, &html, "text/html"))
            .await
            .map_err(|_| FetchError::new(FetchKind::Network, "content extraction failed"))??;
        Ok(StagePage {
            url: final_url.to_string(),
            title: extracted.title,
            content: extracted.content,
            extractor: RENDER_STAGE.to_string(),
            format: extracted.format.to_string(),
            content_type: extracted.content_type,
            excerpt: extracted.excerpt,
            excerpt_json_len: extracted.excerpt_json_len,
            redirects: None,
        })
    }
}

#[async_trait]
impl PageRenderer for BrowserRenderer {
    async fn render(&self, url: &Url, budget: Duration) -> Result<StagePage, FetchError> {
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|_| FetchError::new(FetchKind::Cancelled, "browser pool closed"))?;
        // The hold keeps the shared browser open for the whole render, teardown included (Node
        // takes a pool slot before any browser use).
        let (endpoint, _hold) = self.endpoint.lease().await.map_err(|message| launch_failed(&message))?;
        let cdp = Arc::new(Cdp::connect(&endpoint).await.map_err(|message| launch_failed(&message))?);
        // The context goes away with the connection, so a dropped (cancelled)
        // render leaves nothing behind.
        let context = cdp
            .send("Target.createBrowserContext", json!({ "disposeOnDetach": true }), None)
            .await
            .map_err(|error| launch_failed(&error.message))?;
        let context_id = text_of(&context, "browserContextId").to_string();
        let outcome = self.scrape(&cdp, &context_id, url, budget).await;
        let _ = tokio::time::timeout(
            TEARDOWN,
            cdp.send("Target.disposeBrowserContext", json!({ "browserContextId": context_id }), None),
        )
        .await;
        outcome
    }
}
