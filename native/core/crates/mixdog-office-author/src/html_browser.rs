//! The browser session every HTML authoring route (pptx, pdf, docx, xlsx) lays its document out in: the lease of the
//! shared render browser, the deadline and cancellation wiring around the layout work, the failure result, and the
//! photographs of captured elements (`authoring/html-browser.mjs`).
//!
//! Node launched a Chrome of its own for each route and reaped it with the process. The product now has one render
//! browser, launched, shared, idle-closed and guarded by the extension host (`BrowserEndpoint`); a route holds the
//! lease for its whole run, works in a browser context of its own and gives both back on every exit path: the context
//! is disposed with the connection, so even a run that is dropped half way leaves no page behind.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_core_api::domain::ext::BrowserHold;
use mixdog_office_base::write_note::WriteNote;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::cdp::Cdp;
use crate::page::Page;

/// The deadline of a route's layout work.
pub const LAYOUT_TIMEOUT: Duration = Duration::from_secs(90);

/// How long a browser context is given to go away.
const TEARDOWN: Duration = Duration::from_secs(2);

/// Why a run ended without its result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunError {
    /// The caller cancelled; the route lets this through rather than answering a failure.
    Cancelled,
    /// The browser or the layout failed, with the message the route reports.
    Failed(String),
}

impl RunError {
    /// The message of a failure; a cancellation has none of its own.
    pub fn message(&self) -> &str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Failed(message) => message,
        }
    }
}

impl From<String> for RunError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

/// The lanes a route's file work and image work run on.
#[derive(Clone, Copy)]
pub struct AuthorLanes {
    tokens: LaneTokens,
}

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// A lease of the shared render browser and a browser context of the run's own.
pub struct HtmlBrowser {
    cdp: Arc<Cdp>,
    context_id: String,
    hold: Mutex<Option<BrowserHold>>,
}

/// The result of a route whose browser or layout failed: `{ ok: false, error: { message }, elapsedMs, ...extra }`.
pub fn html_failure(message: &str, started_at: Instant, extra: Option<Map<String, Value>>) -> Value {
    let mut result = Map::new();
    result.insert("ok".into(), json!(false));
    result.insert("error".into(), json!({ "message": message }));
    result.insert("elapsedMs".into(), json!((started_at.elapsed().as_secs_f64() * 1000.0).round() as u64));
    result.extend(extra.unwrap_or_default());
    Value::Object(result)
}

/// Photographs each element the measure tagged `[attribute="1".."count"]` into `scratch` (as `capture-<n>.png`, on a
/// transparent background); index to path. An index with no element is skipped.
pub async fn photograph_captures(
    page: &Page,
    lanes: &AuthorLanes,
    note: &dyn WriteNote,
    attribute: &str,
    count: usize,
    scratch: &Path,
) -> Result<BTreeMap<usize, PathBuf>, String> {
    let mut captures = BTreeMap::new();
    for index in 1..=count {
        let Some(element) = page.query(&format!("[{attribute}=\"{index}\"]")).await? else { continue };
        let path = scratch.join(format!("capture-{index}.png"));
        let png = element.screenshot(true).await?;
        note.note_write(&path);
        lanes.write_file(&path, png).await?;
        captures.insert(index, path);
    }
    Ok(captures)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_result_has_the_shape_the_routes_report() {
        let started = Instant::now();
        let plain = html_failure("boom", started, None);
        assert_eq!(plain["ok"], json!(false));
        assert_eq!(plain["error"], json!({ "message": "boom" }));
        assert!(plain["elapsedMs"].as_u64().is_some());
        assert_eq!(plain.as_object().unwrap().keys().collect::<Vec<_>>(), ["ok", "error", "elapsedMs"]);

        let mut extra = Map::new();
        extra.insert("layout".into(), json!([{ "severity": "error" }]));
        let refused = html_failure("layout check refused the document", started, Some(extra));
        assert_eq!(refused["layout"], json!([{ "severity": "error" }]));
        assert_eq!(refused.as_object().unwrap().keys().collect::<Vec<_>>(), ["ok", "error", "elapsedMs", "layout"]);
    }

    #[test]
    fn a_run_error_reads_as_its_message() {
        assert_eq!(RunError::from("no browser".to_string()), RunError::Failed("no browser".into()));
        assert_eq!(RunError::Failed("x".into()).message(), "x");
        assert_eq!(RunError::Cancelled.message(), "cancelled");
    }

    #[test]
    fn the_layout_deadline_is_ninety_seconds() {
        assert_eq!(LAYOUT_TIMEOUT, Duration::from_secs(90));
    }
}


impl AuthorLanes {
    pub fn new(tokens: LaneTokens) -> Self {
        Self { tokens }
    }

    /// Writes `bytes` to `path`.
    pub async fn write_file(&self, path: &Path, bytes: Vec<u8>) -> Result<(), String> {
        let path = path.to_path_buf();
        let target = path.clone();
        self.tokens
            .durability_io
            .submit_wait(&CancellationToken::new(), move |lane| mixdog_fsio::write(lane, &target, bytes))
            .await
            .map_err(|full| full.to_string())?
            .await
            .map_err(|dropped| dropped.to_string())?
            .map_err(|error| format!("{}: {error}", path.display()))
    }

    /// A new empty folder in the system temp folder whose name starts with `prefix` (`mkdtemp`).
    pub async fn make_scratch_dir(&self, prefix: &str) -> Result<PathBuf, String> {
        let base = std::env::temp_dir();
        let prefix = prefix.to_string();
        self.tokens
            .durability_io
            .submit_wait(&CancellationToken::new(), move |lane| loop {
                let number = SCRATCH.fetch_add(1, Ordering::Relaxed);
                let path = base.join(format!("{prefix}{:x}{number:x}", std::process::id()));
                match mixdog_fsio::create_dir(lane, &path) {
                    Ok(()) => return Ok(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(format!("{}: {error}", path.display())),
                }
            })
            .await
            .map_err(|full| full.to_string())?
            .await
            .map_err(|dropped| dropped.to_string())?
    }

    /// Removes a folder with what is in it; a folder that cannot be removed is left (`rm(..., { force: true })` with
    /// its failure swallowed).
    pub async fn remove_dir_all(&self, path: &Path) {
        let path = path.to_path_buf();
        let removal = self.tokens.durability_io.submit_wait(&CancellationToken::new(), move |lane| mixdog_fsio::remove_dir_all(lane, &path)).await;
        if let Ok(removal) = removal {
            let _ = removal.await;
        }
    }

    /// Runs `job` on the bulk compute lane (image decoding and trimming, which are too long for a task's poll).
    pub async fn compute<R, F>(&self, job: F) -> Result<R, String>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        mixdog_raster::on_lane(self.tokens.cpu_bulk, job).await.map_err(|error| error.to_string())
    }
}
impl HtmlBrowser {
    /// Leases the shared render browser (launching it when none runs) and opens a context in it. The lease is kept
    /// until [`close`](Self::close) or until the last reference to this value is dropped. The Office layout expects
    /// glyph advances not snapped to hinted widths (`--font-render-hinting=none`, so a line breaks where the Word and
    /// PowerPoint render breaks it): the shared render browser is started with that flag (mixdog-exthost `browser.rs`).
    pub async fn launch(endpoint: &dyn BrowserEndpoint) -> Result<Arc<Self>, String> {
        let (url, hold) = endpoint.lease().await?;
        let cdp = Arc::new(Cdp::connect(&url).await?);
        let context = cdp.send("Target.createBrowserContext", json!({ "disposeOnDetach": true }), None).await?;
        let context_id = context.get("browserContextId").and_then(Value::as_str).unwrap_or_default().to_string();
        Ok(Arc::new(Self { cdp, context_id, hold: Mutex::new(Some(hold)) }))
    }

    /// `browser.newPage()`.
    pub async fn new_page(&self) -> Result<Page, String> {
        Page::open(self.cdp.clone(), &self.context_id).await
    }

    /// Closes the run's context (and with it every page) and gives the lease back. Safe to call more than once.
    pub async fn close(&self) {
        let _ = mixdog_rt::time::timeout(
            TEARDOWN,
            self.cdp.send("Target.disposeBrowserContext", json!({ "browserContextId": self.context_id }), None),
        )
        .await;
        drop(self.hold.lock().unwrap_or_else(|p| p.into_inner()).take());
    }
}
/// Runs `work` against the browser under a deadline and the cancellation, and closes the browser afterwards. A
/// cancellation that has already happened ends the run before the work starts.
pub async fn run_in_browser<T, F, Fut>(browser: Arc<HtmlBrowser>, cancel: &CancellationToken, timeout: Duration, work: F) -> Result<T, RunError>
where
    F: FnOnce(Arc<HtmlBrowser>) -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let outcome = if cancel.is_cancelled() {
        Err(RunError::Cancelled)
    } else {
        let running = work(browser.clone());
        tokio::select! {
            biased;
            result = running => result.map_err(RunError::Failed),
            () = mixdog_rt::time::sleep(timeout) => Err(RunError::Failed(format!("HTML layout exceeded {} ms", timeout.as_millis()))),
            () = cancel.cancelled() => Err(RunError::Cancelled),
        }
    };
    browser.close().await;
    outcome
}
