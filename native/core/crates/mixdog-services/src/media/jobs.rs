//! Media generation jobs. Image lanes answer in one request, video lanes poll for minutes, so
//! both run as background jobs with a polled snapshot that outlives the window. The lane catalog
//! and adapters belong to the provider layer and sit behind [`MediaGenerator`]; every snapshot
//! change is also broadcast so the scoped `media:<jobId>` section feed can push it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use super::ledger::{MediaUsageCall, MediaUsageLedger};
use super::renditions::StillRenditions;
use super::store::MediaStore;
use super::variants;

/// Finished jobs stay readable so a slow poller still sees the terminal state.
const TERMINAL_TTL_MS: i64 = 10 * 60_000;
const MAX_PROMPT_CHARS: usize = 8_000;
const DEFAULT_MAX_ACTIVE_JOBS: usize = 4;
pub use super::upstream::MAX_GENERATED_MEDIA_BYTES;

#[derive(Debug, Clone)]
pub struct MediaFailure {
    pub message: String,
    pub code: Option<String>,
    /// What the provider reported before the request failed: still billed.
    pub usage: Option<Value>,
}

impl MediaFailure {
    pub fn new(message: impl Into<String>, code: &str) -> Self {
        Self { message: message.into(), code: Some(code.to_owned()), usage: None }
    }
}

/// A validated request: the lane and model a generation will really use.
#[derive(Debug, Clone)]
pub struct ResolvedMedia {
    pub kind: String,
    pub lane: String,
    pub model: String,
    /// Maximum reference images the model accepts.
    pub max_references: usize,
    /// The model the request really names when it is not the listed one (the ChatGPT lane's orchestrator).
    pub request_model: Option<String>,
}

pub struct Reference {
    pub base64: String,
    pub mime: String,
}

pub struct GenerationRequest {
    pub resolved: ResolvedMedia,
    pub prompt: String,
    pub options: Value,
    pub references: Vec<Reference>,
    pub cancel: CancellationToken,
    /// The connected account the whole job runs as (`mixdog exec --account`); empty: the lane's own.
    pub account: String,
    pub session_id: String,
    pub source_type: String,
    /// Reports 0..1 or 0..100.
    pub progress: Arc<dyn Fn(f64) + Send + Sync>,
}

#[derive(Debug)]
pub struct GeneratedMedia {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub revised_prompt: Option<String>,
    pub duration_seconds: Option<f64>,
    /// Normalized provider-reported usage (`media::usage`), billed once the provider has answered.
    pub usage: Option<Value>,
}

#[async_trait]
pub trait MediaGenerator: Send + Sync {
    /// Validates lane/kind/model (and credentials) before a job exists.
    async fn resolve(&self, lane: &str, kind: &str, model: &str) -> Result<ResolvedMedia, MediaFailure>;
    /// [`resolve`](Self::resolve) as a connected account of the lane's provider (the whole job runs as
    /// it: an account that cannot serve the call fails it, never another account). Generators without
    /// accounts keep this default.
    async fn resolve_for(&self, lane: &str, kind: &str, model: &str, account: &str) -> Result<ResolvedMedia, MediaFailure> {
        let _ = account;
        self.resolve(lane, kind, model).await
    }
    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedMedia, MediaFailure>;
    /// The lane catalog (providers, models, controls) as the provider layer describes it.
    async fn lanes(&self) -> Value;
}

/// Whom a generation is for: the pinned account and the conversation it belongs to.
struct Who {
    account: String,
    session_id: String,
    source_type: String,
}

struct Job {
    snapshot: Value,
    cancel: CancellationToken,
}

/// What the `mediaJobs` section follows: a job's snapshot changed, or the job left the table (its
/// terminal TTL passed and a start or a list swept it, as in Node), after which `getMediaJob`
/// answers null for it.
#[derive(Debug, Clone, PartialEq)]
pub enum JobEvent {
    Changed(Value),
    Swept(String),
}

pub struct MediaJobs {
    store: Arc<MediaStore>,
    generator: Arc<dyn MediaGenerator>,
    jobs: Mutex<HashMap<String, Job>>,
    updates: broadcast::Sender<JobEvent>,
    max_active: usize,
    /// When set, each saved asset's tile rendition is built in the background.
    renditions: Option<StillRenditions>,
    /// One ledger row per generation; none: nothing is recorded.
    ledger: Option<Arc<dyn MediaUsageLedger>>,
}

impl MediaJobs {
    pub fn new(store: Arc<MediaStore>, generator: Arc<dyn MediaGenerator>, max_active: Option<usize>) -> Arc<Self> {
        Self::build(store, generator, max_active, None, None)
    }

    /// [`new`](Self::new) that also warms the tile rendition of every asset it saves.
    pub fn with_renditions(store: Arc<MediaStore>, generator: Arc<dyn MediaGenerator>, max_active: Option<usize>, renditions: StillRenditions) -> Arc<Self> {
        Self::build(store, generator, max_active, Some(renditions), None)
    }

    /// [with_renditions](Self::with_renditions) that also bills every generation to ledger.
    pub fn with_ledger(store: Arc<MediaStore>, generator: Arc<dyn MediaGenerator>, max_active: Option<usize>, renditions: Option<StillRenditions>, ledger: Arc<dyn MediaUsageLedger>) -> Arc<Self> {
        Self::build(store, generator, max_active, renditions, Some(ledger))
    }

    fn build(store: Arc<MediaStore>, generator: Arc<dyn MediaGenerator>, max_active: Option<usize>, renditions: Option<StillRenditions>, ledger: Option<Arc<dyn MediaUsageLedger>>) -> Arc<Self> {
        Arc::new(Self {
            store,
            generator,
            jobs: Mutex::default(),
            updates: broadcast::channel(256).0,
            max_active: max_active.filter(|n| *n > 0).unwrap_or(DEFAULT_MAX_ACTIVE_JOBS),
            renditions,
            ledger,
        })
    }

    /// Every snapshot change and every job that left the table, for the `mediaJobs` section.
    pub fn subscribe(&self) -> broadcast::Receiver<JobEvent> {
        self.updates.subscribe()
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut Map<String, Value>)) {
        let snapshot = {
            let mut jobs = self.jobs.lock().unwrap();
            let Some(job) = jobs.get_mut(id) else { return };
            change(job.snapshot.as_object_mut().expect("snapshot is an object"));
            job.snapshot.clone()
        };
        let _ = self.updates.send(JobEvent::Changed(snapshot));
    }

    /// Drops the finished jobs past their TTL and tells the section; the table is the caller's guard.
    fn sweep(&self, jobs: &mut HashMap<String, Job>) {
        let now = (self.store.marks().now)();
        let gone: Vec<String> = jobs.iter().filter(|(_, j)| j.snapshot["endedAt"].as_i64().is_some_and(|ended| now - ended > TERMINAL_TTL_MS)).map(|(id, _)| id.clone()).collect();
        for id in gone {
            jobs.remove(&id);
            let _ = self.updates.send(JobEvent::Swept(id));
        }
    }

    /// Validates and starts one generation; returns the initial snapshot at once.
    pub async fn start(self: &Arc<Self>, input: &Value) -> Result<Value, MediaFailure> {
        let text = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
        let prompt = mixdog_js::js_trim(text("prompt")).to_owned();
        if prompt.is_empty() {
            return Err(MediaFailure::new("prompt is required", "MEDIA_PROMPT_REQUIRED"));
        }
        if mixdog_js::utf16_len(&prompt) > MAX_PROMPT_CHARS {
            return Err(MediaFailure::new("prompt is too long", "MEDIA_PROMPT_TOO_LONG"));
        }
        let account = mixdog_js::js_trim(text("account")).to_owned();
        let (session_id, source_type) = (text("sessionId").to_owned(), text("sourceType").to_owned());
        let resolved = self.generator.resolve_for(text("lane"), text("kind"), text("model"), &account).await?;
        let references: Vec<Reference> = input
            .get("references")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|r| {
                let base64 = r.get("base64").and_then(Value::as_str).filter(|b| !b.is_empty())?;
                Some(Reference { base64: base64.to_owned(), mime: r.get("mime").and_then(Value::as_str).unwrap_or("image/png").to_owned() })
            })
            .take(resolved.max_references)
            .collect();
        let options = input.get("options").filter(|o| o.is_object()).cloned().unwrap_or_else(|| json!({}));
        let board_id = mixdog_js::slice_utf16(text("boardId"), 64);
        let id = (self.store.marks().id)();
        let cancel = CancellationToken::new();
        let snapshot = json!({
            "id": id, "status": "running", "kind": resolved.kind, "lane": resolved.lane, "model": resolved.model,
            "prompt": prompt, "options": options, "boardId": board_id, "progress": 0,
            "assetId": null, "error": null, "errorCode": null, "startedAt": (self.store.marks().now)(), "endedAt": null,
        });
        {
            // The ceiling check and the insert are one step, so concurrent starts cannot overshoot.
            let mut jobs = self.jobs.lock().unwrap();
            self.sweep(&mut jobs);
            let active = jobs.values().filter(|j| j.snapshot["status"] == "running").count();
            if active >= self.max_active {
                return Err(MediaFailure::new(
                    format!("too many media generations are already running ({active}/{})", self.max_active),
                    "MEDIA_TOO_MANY_JOBS",
                ));
            }
            jobs.insert(id.clone(), Job { snapshot: snapshot.clone(), cancel: cancel.clone() });
        }
        // Remembering the selection is a convenience: a full disk never blocks the generation.
        let selection = json!({"kind": resolved.kind, "lane": resolved.lane, "model": resolved.model});
        let _ = self.store.run(move |store| store.set_default(&selection)).await;
        let _ = self.updates.send(JobEvent::Changed(snapshot.clone()));
        let this = self.clone();
        let who = Who { account, session_id, source_type };
        tokio::spawn(async move { this.run(id, resolved, prompt, options, references, board_id, who, cancel).await });
        Ok(snapshot)
    }

    #[allow(clippy::too_many_arguments, reason = "one job's whole input")]
    async fn run(self: Arc<Self>, id: String, resolved: ResolvedMedia, prompt: String, options: Value, references: Vec<Reference>, board_id: String, who: Who, cancel: CancellationToken) {
        let progress = {
            let (this, id) = (self.clone(), id.clone());
            Arc::new(move |value: f64| {
                if !value.is_finite() {
                    return;
                }
                // Lanes report a 0-1 fraction or a percentage; the rail never walks backwards.
                let next = (if value > 1.0 { value } else { value * 100.0 }).clamp(0.0, 100.0).round() as i64;
                this.update(&id, |s| {
                    if next > s["progress"].as_i64().unwrap_or(0) {
                        s.insert("progress".into(), json!(next));
                    }
                });
            })
        };
        let result = self
            .generator
            .generate(GenerationRequest { resolved: resolved.clone(), prompt: prompt.clone(), options: options.clone(), references, cancel: cancel.clone(), account: who.account.clone(), session_id: who.session_id.clone(), source_type: who.source_type.clone(), progress })
            .await;
        // Billed once the provider returned a result, whatever happens to the bytes next; a failure is
        // recorded only when the provider reported usage for it.
        match &result {
            Ok(media) => self.bill(&resolved, media.usage.as_ref(), &who).await,
            Err(failure) if failure.usage.is_some() => self.bill(&resolved, failure.usage.as_ref(), &who).await,
            Err(_) => {}
        }
        let described = (resolved.lane.clone(), resolved.model.clone(), resolved.kind.clone());
        let outcome = match result {
            Err(failure) => Err(failure),
            Ok(media) if media.bytes.is_empty() || media.bytes.len() > MAX_GENERATED_MEDIA_BYTES => {
                Err(MediaFailure::new("generated media exceeds the media size limit", "MEDIA_RESULT_TOO_LARGE"))
            }
            Ok(media) => {
                let mut meta = Map::new();
                if !board_id.is_empty() {
                    meta.insert("boardId".into(), json!(board_id));
                }
                if let Some(p) = media.revised_prompt.filter(|p| !p.is_empty()) {
                    meta.insert("revisedPrompt".into(), json!(p));
                }
                if let Some(d) = media.duration_seconds.filter(|d| *d > 0.0) {
                    meta.insert("durationSeconds".into(), mixdog_js::json_number(d));
                }
                let (mime, bytes) = (media.mime, media.bytes);
                let saved = self
                    .store
                    .run(move |store| store.save_asset(&resolved.kind, &resolved.lane, &resolved.model, &prompt, options, &mime, &bytes, meta))
                    .await
                    .and_then(|saved| saved)
                    .map_err(|e| MediaFailure::new(e.to_string(), e.code()));
                if let (Ok(asset), Some(renditions)) = (&saved, &self.renditions) {
                    variants::prewarm(self.store.clone(), renditions.clone(), asset["id"].as_str().unwrap_or_default().to_owned(), asset["kind"] == "video");
                }
                saved
            }
        };
        self.update(&id, |s| {
            s.insert("endedAt".into(), json!((self.store.marks().now)()));
            match outcome {
                Ok(asset) => {
                    s.insert("assetId".into(), asset["id"].clone());
                    s.insert("progress".into(), json!(100));
                    s.insert("status".into(), json!("done"));
                }
                Err(failure) => {
                    let canceled = cancel.is_cancelled() || failure.code.as_deref() == Some("MEDIA_CANCELED");
                    s.insert("status".into(), json!(if canceled { "canceled" } else { "failed" }));
                    let message = if canceled { "canceled".to_owned() } else { mixdog_js::slice_utf16(&failure.message, 500) };
                    s.insert("error".into(), json!(message));
                    s.insert("errorCode".into(), json!(failure.code));
                    if !canceled {
                        // The snapshot is the only record of a failure and it is swept: keep the reason.
                        mixdog_rt::node_console_error!("[media] job failed lane={} model={} kind={} code={}: {}", described.0, described.1, described.2, failure.code.as_deref().unwrap_or("none"), mixdog_js::slice_utf16(&failure.message, 500));
                    }
                }
            }
        });
    }

    /// One ledger row for the generation (`record` in `jobs.mjs`): the ChatGPT lane bills the
    /// orchestrator model that ran the hosted tool, not the "auto" image route.
    async fn bill(&self, resolved: &ResolvedMedia, usage: Option<&Value>, who: &Who) {
        let Some(ledger) = &self.ledger else { return };
        let pricing_model = if resolved.lane == "openai-oauth" { resolved.request_model.as_deref() } else { None };
        ledger.record(MediaUsageCall { lane: &resolved.lane, model: &resolved.model, pricing_model, usage, session_id: &who.session_id, source_type: &who.source_type, account: &who.account }).await;
    }

    pub async fn lanes(&self) -> Value {
        self.generator.lanes().await
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.jobs.lock().unwrap().get(id).map(|j| j.snapshot.clone())
    }

    pub fn list(&self) -> Vec<Value> {
        let mut jobs = self.jobs.lock().unwrap();
        self.sweep(&mut jobs);
        let mut all: Vec<Value> = jobs.values().map(|j| j.snapshot.clone()).collect();
        all.sort_by_key(|s| std::cmp::Reverse(s["startedAt"].as_i64().unwrap_or(0)));
        all
    }

    pub fn cancel(&self, id: &str) -> Value {
        let jobs = self.jobs.lock().unwrap();
        let Some(job) = jobs.get(id) else { return json!({"id": id, "canceled": false}) };
        let running = job.snapshot["status"] == "running";
        if running {
            job.cancel.cancel();
        }
        json!({"id": id, "canceled": running})
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    struct Fake {
        gate: tokio::sync::Semaphore,
        fail: bool,
    }

    #[async_trait]
    impl MediaGenerator for Fake {
        async fn resolve(&self, lane: &str, kind: &str, model: &str) -> Result<ResolvedMedia, MediaFailure> {
            Ok(ResolvedMedia { kind: kind.into(), lane: lane.into(), model: model.into(), max_references: 1, request_model: None })
        }
        async fn lanes(&self) -> Value {
            json!([])
        }
        async fn generate(&self, request: GenerationRequest) -> Result<GeneratedMedia, MediaFailure> {
            (request.progress)(0.5);
            (request.progress)(0.2);
            tokio::select! {
                _ = request.cancel.cancelled() => Err(MediaFailure::new("aborted", "MEDIA_CANCELED")),
                _ = self.gate.acquire() => if self.fail {
                    Err(MediaFailure::new("upstream said no", "UPSTREAM"))
                } else {
                    Ok(GeneratedMedia { bytes: b"png".to_vec(), mime: "image/png".into(), revised_prompt: None, duration_seconds: None, usage: None })
                },
            }
        }
    }

    fn jobs(fail: bool, max: usize) -> (tempfile::TempDir, Arc<MediaStore>, Arc<MediaJobs>, Arc<Fake>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(MediaStore::new(dir.path(), mixdog_rt::testing::tokens().durability_io));
        let fake = Arc::new(Fake { gate: tokio::sync::Semaphore::new(0), fail });
        let jobs = MediaJobs::new(store.clone(), fake.clone(), Some(max));
        (dir, store, jobs, fake)
    }

    async fn settled(jobs: &MediaJobs, id: &str) -> Value {
        loop {
            let s = jobs.get(id).unwrap();
            if s["status"] != "running" {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn request() -> Value {
        json!({"lane": "gemini", "kind": "image", "model": "m", "prompt": " draw ", "boardId": ""})
    }

    #[tokio::test]
    async fn a_job_progresses_monotonically_and_stores_its_asset() {
        let (_d, store, jobs, fake) = jobs(false, 4);
        let start = jobs.start(&request()).await.unwrap();
        assert_eq!(start["status"], "running");
        let id = start["id"].as_str().unwrap().to_owned();
        fake.gate.add_permits(1);
        let done = settled(&jobs, &id).await;
        assert_eq!(done["status"], "done");
        assert_eq!(done["progress"], 100);
        assert_eq!(store.list_assets(None, None, None, "").unwrap()["assets"][0]["id"], done["assetId"]);
        assert_eq!(store.get_default(Some(&json!("image")))["lane"], "gemini");
    }

    #[tokio::test]
    async fn failures_and_cancels_are_distinct_terminal_states() {
        let (_d, _s, jobs, fake) = jobs(true, 4);
        let id = jobs.start(&request()).await.unwrap()["id"].as_str().unwrap().to_owned();
        fake.gate.add_permits(1);
        let failed = settled(&jobs, &id).await;
        assert_eq!((failed["status"].as_str(), failed["errorCode"].as_str()), (Some("failed"), Some("UPSTREAM")));

        let id = jobs.start(&request()).await.unwrap()["id"].as_str().unwrap().to_owned();
        assert_eq!(jobs.cancel(&id)["canceled"], true);
        let canceled = settled(&jobs, &id).await;
        assert_eq!((canceled["status"].as_str(), canceled["error"].as_str()), (Some("canceled"), Some("canceled")));
        assert_eq!(jobs.cancel(&id)["canceled"], false);
        assert_eq!(jobs.cancel("unknown")["canceled"], false);
    }

    #[tokio::test]
    async fn the_active_ceiling_and_prompt_rules_hold() {
        let (_d, _s, jobs, _fake) = jobs(false, 1);
        jobs.start(&request()).await.unwrap();
        let busy = jobs.start(&request()).await.unwrap_err();
        assert_eq!(busy.code.as_deref(), Some("MEDIA_TOO_MANY_JOBS"));
        let mut blank = request();
        blank["prompt"] = json!("  ");
        assert_eq!(jobs.start(&blank).await.unwrap_err().code.as_deref(), Some("MEDIA_PROMPT_REQUIRED"));
        assert_eq!(jobs.list().len(), 1);
    }

    /// A generator that answers as scripted at once, and what it was asked.
    struct Scripted {
        outcome: Result<GeneratedMedia, MediaFailure>,
        request_model: Option<String>,
        asked: Mutex<Vec<(String, String, String, String)>>,
    }

    #[async_trait]
    impl MediaGenerator for Scripted {
        async fn resolve(&self, lane: &str, kind: &str, model: &str) -> Result<ResolvedMedia, MediaFailure> {
            Ok(ResolvedMedia { kind: kind.into(), lane: lane.into(), model: model.into(), max_references: 1, request_model: self.request_model.clone() })
        }
        async fn resolve_for(&self, lane: &str, kind: &str, model: &str, account: &str) -> Result<ResolvedMedia, MediaFailure> {
            self.asked.lock().unwrap().push(("resolve".into(), account.into(), String::new(), String::new()));
            self.resolve(lane, kind, model).await
        }
        async fn lanes(&self) -> Value {
            json!([])
        }
        async fn generate(&self, request: GenerationRequest) -> Result<GeneratedMedia, MediaFailure> {
            self.asked.lock().unwrap().push(("generate".into(), request.account, request.session_id, request.source_type));
            match &self.outcome {
                Ok(media) => Ok(GeneratedMedia { bytes: media.bytes.clone(), mime: media.mime.clone(), revised_prompt: None, duration_seconds: media.duration_seconds, usage: media.usage.clone() }),
                Err(failure) => Err(failure.clone()),
            }
        }
    }

    /// (lane, model, pricing model, usage, session, source, account) of every row billed.
    type Billed = (String, String, Option<String>, Option<Value>, String, String, String);

    #[derive(Default)]
    struct Rows(Mutex<Vec<Billed>>);

    #[async_trait]
    impl MediaUsageLedger for Rows {
        async fn record(&self, call: MediaUsageCall<'_>) {
            self.0.lock().unwrap().push((call.lane.into(), call.model.into(), call.pricing_model.map(str::to_owned), call.usage.cloned(), call.session_id.into(), call.source_type.into(), call.account.into()));
        }
    }

    fn billed_jobs(outcome: Result<GeneratedMedia, MediaFailure>, request_model: Option<&str>) -> (tempfile::TempDir, Arc<MediaJobs>, Arc<Scripted>, Arc<Rows>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(MediaStore::new(dir.path(), mixdog_rt::testing::tokens().durability_io));
        let generator = Arc::new(Scripted { outcome, request_model: request_model.map(str::to_owned), asked: Mutex::new(Vec::new()) });
        let rows = Arc::new(Rows::default());
        let jobs = MediaJobs::with_ledger(store, generator.clone(), Some(4), None, rows.clone());
        (dir, jobs, generator, rows)
    }

    fn image(usage: Option<Value>) -> GeneratedMedia {
        GeneratedMedia { bytes: b"png".to_vec(), mime: "image/png".into(), revised_prompt: None, duration_seconds: None, usage }
    }

    #[tokio::test]
    async fn a_generation_is_billed_once_with_who_it_was_for() {
        let usage = json!({"inputTokens": 3, "outputTokens": 9});
        let (_d, jobs, generator, rows) = billed_jobs(Ok(image(Some(usage.clone()))), None);
        let mut input = request();
        input["sessionId"] = json!("sess-1");
        input["sourceType"] = json!("lead");
        input["account"] = json!(" work ");
        let id = jobs.start(&input).await.unwrap()["id"].as_str().unwrap().to_owned();
        assert_eq!(settled(&jobs, &id).await["status"], "done");
        assert_eq!(*rows.0.lock().unwrap(), vec![("gemini".into(), "m".into(), None, Some(usage), "sess-1".into(), "lead".into(), "work".into())]);
        // The account the job is pinned to reaches both the catalog check and the adapter, trimmed.
        assert_eq!(*generator.asked.lock().unwrap(), vec![("resolve".to_owned(), "work".to_owned(), String::new(), String::new()), ("generate".to_owned(), "work".to_owned(), "sess-1".to_owned(), "lead".to_owned())]);
    }

    #[tokio::test]
    async fn the_chatgpt_lane_bills_the_model_that_ran_the_tool() {
        let (_d, jobs, _g, rows) = billed_jobs(Ok(image(None)), Some("gpt-5.5"));
        let mut input = request();
        input["lane"] = json!("openai-oauth");
        let id = jobs.start(&input).await.unwrap()["id"].as_str().unwrap().to_owned();
        settled(&jobs, &id).await;
        let rows = rows.0.lock().unwrap();
        assert_eq!((rows[0].0.as_str(), rows[0].2.as_deref(), rows[0].3.clone()), ("openai-oauth", Some("gpt-5.5"), None), "a result without usage still makes its row");
    }

    #[tokio::test]
    async fn a_failure_is_billed_only_when_the_provider_reported_usage() {
        let usage = json!({"inputTokens": 4});
        let mut failure = MediaFailure::new("no image", "MEDIA_EMPTY_RESULT");
        failure.usage = Some(usage.clone());
        let (_d, jobs, _g, rows) = billed_jobs(Err(failure), None);
        let id = jobs.start(&request()).await.unwrap()["id"].as_str().unwrap().to_owned();
        assert_eq!(settled(&jobs, &id).await["status"], "failed");
        assert_eq!(rows.0.lock().unwrap().len(), 1);
        assert_eq!(rows.0.lock().unwrap()[0].3, Some(usage));

        let (_d, jobs, _g, rows) = billed_jobs(Err(MediaFailure::new("boom", "UPSTREAM")), None);
        let id = jobs.start(&request()).await.unwrap()["id"].as_str().unwrap().to_owned();
        assert_eq!(settled(&jobs, &id).await["status"], "failed");
        assert!(rows.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_result_that_cannot_be_kept_is_still_billed() {
        let mut empty = image(Some(json!({"images": 1})));
        empty.bytes.clear();
        let (_d, jobs, _g, rows) = billed_jobs(Ok(empty), None);
        let id = jobs.start(&request()).await.unwrap()["id"].as_str().unwrap().to_owned();
        let done = settled(&jobs, &id).await;
        assert_eq!(done["errorCode"], "MEDIA_RESULT_TOO_LARGE");
        assert_eq!(rows.0.lock().unwrap().len(), 1);
    }
}