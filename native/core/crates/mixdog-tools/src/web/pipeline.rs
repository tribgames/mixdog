//! One logical fetch: an HTTP attempt (with one retry on a transient failure),
//! then the optional render stage, all inside one budget. Pages on the same host
//! take turns with a short gap; other hosts never wait on them.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::error::FetchError;
use super::error::FetchKind;
use super::extract::assert_readable;
use super::extract::extract_document;
use super::http::Fetcher;
use super::http::Redirect;
use super::http::Session;
use super::http::meta_refresh_target;

const RETRY_FLOOR: Duration = Duration::from_millis(400);
const HOST_INTERVAL: Duration = Duration::from_millis(250);
const MAX_META_REFRESH: usize = 3;
pub const HTTP_STAGE: &str = "http";
pub const RENDER_STAGE: &str = "puppeteer";

/// What a stage produced.
#[derive(Clone, Debug, Default)]
pub struct StagePage {
    pub url: String,
    pub title: String,
    pub content: String,
    pub extractor: String,
    /// `Extracted::format`, `content_type` and `excerpt`: they only size the cache entry.
    pub format: String,
    pub content_type: String,
    pub excerpt: String,
    pub excerpt_json_len: usize,
    /// Node's `redirects`: the HTTP stage records them (an empty list included), the browser
    /// stage has none.
    pub redirects: Option<Vec<Redirect>>,
}

/// The browser-rendered stage (implemented over the core CDP client).
#[async_trait]
pub trait PageRenderer: Send + Sync {
    async fn render(&self, url: &Url, budget: Duration) -> Result<StagePage, FetchError>;
}

#[derive(Clone, Debug)]
pub struct Failure {
    pub extractor: String,
    pub error: String,
    pub code: &'static str,
    pub status: Option<u16>,
}

#[derive(Clone, Debug)]
pub struct Attempt {
    pub stage: &'static str,
    pub ok: bool,
    pub elapsed_ms: u128,
    pub code: Option<&'static str>,
}

#[derive(Clone, Debug)]
pub struct Page {
    pub url: String,
    pub title: String,
    pub content: String,
    pub extractor: String,
    pub format: String,
    pub content_type: String,
    pub excerpt: String,
    pub excerpt_json_len: usize,
    pub redirects: Option<Vec<Redirect>>,
    pub failures: Vec<Failure>,
    pub attempts: Vec<Attempt>,
}

#[derive(Debug)]
pub struct PipelineFailure {
    pub error: FetchError,
    pub code: &'static str,
    pub failures: Vec<Failure>,
    pub attempts: Vec<Attempt>,
}

#[derive(Default)]
struct Trace {
    failures: Vec<Failure>,
    attempts: Vec<Attempt>,
}

struct HostGate {
    ready_at: tokio::sync::Mutex<Instant>,
}

#[derive(Default)]
pub struct HostPacer {
    hosts: Mutex<HashMap<String, Arc<HostGate>>>,
}

impl HostPacer {
    fn gate(&self, host: &str) -> Arc<HostGate> {
        let mut hosts = self.hosts.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(gate) = hosts.get(host) {
            return gate.clone();
        }
        // Idle hosts whose gap has passed carry no state worth keeping.
        hosts.retain(|_, gate| {
            Arc::strong_count(gate) > 1
                || gate
                    .ready_at
                    .try_lock()
                    .map_or(true, |ready| *ready > Instant::now())
        });
        let gate = Arc::new(HostGate {
            ready_at: tokio::sync::Mutex::new(Instant::now()),
        });
        hosts.insert(host.to_string(), gate.clone());
        gate
    }

    /// Runs `operation` once it is this caller's turn on `host`.
    async fn run<T>(
        &self,
        host: &str,
        operation: impl std::future::Future<Output = Result<T, FetchError>>,
    ) -> Result<T, FetchError> {
        let gate = self.gate(host);
        let mut ready_at = gate.ready_at.lock().await;
        tokio::time::sleep_until(tokio::time::Instant::from_std(*ready_at)).await;
        let result = operation.await;
        let mut next = Instant::now() + HOST_INTERVAL;
        if let Err(error) = &result
            && !error.retry_after.is_zero()
        {
            next = next.max(Instant::now() + error.retry_after);
        }
        *ready_at = next;
        result
    }
}

pub struct Pipeline {
    fetcher: Arc<Fetcher>,
    renderer: Option<Arc<dyn PageRenderer>>,
    pacer: HostPacer,
}

fn retryable_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
}

fn is_challenge(error: &FetchError) -> bool {
    error.kind == FetchKind::Challenge && !matches!(error.status, Some(401 | 429))
}

impl Pipeline {
    pub fn new(fetcher: Arc<Fetcher>, renderer: Option<Arc<dyn PageRenderer>>) -> Self {
        Self {
            fetcher,
            renderer,
            pacer: HostPacer::default(),
        }
    }

    pub async fn run(
        &self,
        url: &Url,
        budget: Duration,
        cancel: &CancellationToken,
    ) -> Result<Page, PipelineFailure> {
        let deadline = Instant::now() + budget;
        let mut trace = Trace::default();
        let outcome = {
            let work = self.run_stages(url, deadline, cancel, &mut trace);
            tokio::select! {
                biased;
                () = cancel.cancelled() => Err(FetchError::new(FetchKind::Cancelled, "Fetch cancelled")),
                () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => Err(FetchError::new(
                    FetchKind::Timeout,
                    format!("Fetch exceeded {}ms total budget", budget.as_millis()),
                )),
                result = work => result,
            }
        };
        match outcome {
            Ok(page) => Ok(Page {
                failures: trace.failures,
                attempts: trace.attempts,
                ..page
            }),
            Err(mut error) => {
                // A stage cut off at the deadline is the total deadline.
                if error.kind == FetchKind::StageTimeout
                    && Instant::now() + Duration::from_millis(10) >= deadline
                {
                    error = FetchError::new(
                        FetchKind::Timeout,
                        format!("Fetch exceeded {}ms total budget", budget.as_millis()),
                    );
                }
                Err(PipelineFailure {
                    code: error.code(),
                    error,
                    failures: trace.failures,
                    attempts: trace.attempts,
                })
            }
        }
    }

    async fn run_stages(
        &self,
        url: &Url,
        deadline: Instant,
        cancel: &CancellationToken,
        trace: &mut Trace,
    ) -> Result<Page, FetchError> {
        let mut last: Option<FetchError> = None;
        for retry in 0..2 {
            match self.attempt(HTTP_STAGE, url, deadline, trace).await {
                Ok(page) => return Ok(page),
                Err(error) => {
                    if cancel.is_cancelled() {
                        return Err(error);
                    }
                    if error.kind == FetchKind::Policy {
                        return Err(error);
                    }
                    if is_challenge(&error) {
                        last = Some(error);
                        break;
                    }
                    if let Some(status) = error.status
                        && !retryable_status(status)
                        && status != 403
                    {
                        return Err(error);
                    }
                    let transient = error.kind == FetchKind::NetworkTransient
                        || error.status.is_some_and(retryable_status);
                    let delay = error.retry_after.max(RETRY_FLOOR);
                    if !transient || retry == 1 {
                        last = Some(error);
                        break;
                    }
                    if Instant::now() + delay >= deadline {
                        return Err(error);
                    }
                    last = Some(error);
                    tokio::time::sleep(delay).await;
                }
            }
        }
        let last = last.expect("the loop exits with an error");
        // Rendering does not fix a rate limit or a failing upstream server.
        if last.status.is_some_and(|status| status != 403) && !is_challenge(&last) {
            return Err(last);
        }
        if self.renderer.is_none() {
            return Err(last);
        }
        self.attempt(RENDER_STAGE, url, deadline, trace).await
    }

    async fn attempt(
        &self,
        stage: &'static str,
        url: &Url,
        deadline: Instant,
        trace: &mut Trace,
    ) -> Result<Page, FetchError> {
        let started = Instant::now();
        let host = url.host_str().unwrap_or_default().to_string();
        let result = self
            .pacer
            .run(&host, async {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let budget = if stage == HTTP_STAGE {
                    Duration::from_millis(12_000.min((remaining.as_millis() as f64 * 0.45).floor() as u64).max(1))
                } else {
                    remaining.max(Duration::from_millis(1))
                };
                let page = tokio::time::timeout(budget, self.execute(stage, url, budget))
                    .await
                    .map_err(|_| FetchError::new(FetchKind::StageTimeout, format!("{stage} timed out")))??;
                assert_readable(&page.content)?;
                Ok(page)
            })
            .await;
        let elapsed_ms = started.elapsed().as_millis();
        match result {
            Ok(page) => {
                trace.attempts.push(Attempt {
                    stage,
                    ok: true,
                    elapsed_ms,
                    code: None,
                });
                Ok(Page {
                    url: page.url,
                    title: page.title,
                    content: page.content,
                    extractor: page.extractor,
                    format: page.format,
                    content_type: page.content_type,
                    excerpt: page.excerpt,
                    excerpt_json_len: page.excerpt_json_len,
                    redirects: page.redirects,
                    failures: Vec::new(),
                    attempts: Vec::new(),
                })
            }
            Err(error) => {
                trace.failures.push(Failure {
                    extractor: stage.to_string(),
                    error: error.message.clone(),
                    code: error.code(),
                    status: error.status,
                });
                trace.attempts.push(Attempt {
                    stage,
                    ok: false,
                    elapsed_ms,
                    code: Some(error.code()),
                });
                Err(error)
            }
        }
    }

    async fn execute(&self, stage: &'static str, url: &Url, budget: Duration) -> Result<StagePage, FetchError> {
        match (stage, &self.renderer) {
            (RENDER_STAGE, Some(renderer)) => renderer.render(url, budget).await,
            _ => self.scrape_http(url).await,
        }
    }

    async fn scrape_http(&self, url: &Url) -> Result<StagePage, FetchError> {
        let session = Session::default();
        let mut document = self.fetcher.fetch_document(url, &session).await?;
        let mut redirects = Vec::new();
        for hop in 0.. {
            redirects.append(&mut document.redirects);
            let content_type = document.content_type.to_lowercase();
            let html = content_type.contains("text/html") || content_type.contains("application/xhtml+xml");
            let Some(target) = html.then(|| meta_refresh_target(&document.body, &document.url)).flatten() else {
                break;
            };
            if hop >= MAX_META_REFRESH {
                return Err(FetchError::policy("Too many redirects (meta refresh)"));
            }
            redirects.push(Redirect {
                url: document.url.to_string(),
                status: None,
                location: target.to_string(),
            });
            document = self.fetcher.fetch_document(&target, &session).await?;
        }
        let final_url = document.url.clone();
        let extracted = tokio::task::spawn_blocking(move || {
            extract_document(&document.url, &document.body, &document.content_type)
        })
        .await
        .map_err(|_| FetchError::new(FetchKind::Network, "content extraction failed"))??;
        Ok(StagePage {
            url: final_url.to_string(),
            title: extracted.title,
            content: extracted.content,
            extractor: extracted.extractor.to_string(),
            format: extracted.format.to_string(),
            content_type: extracted.content_type,
            excerpt: extracted.excerpt,
            excerpt_json_len: extracted.excerpt_json_len,
            redirects: Some(redirects),
        })
    }
}
