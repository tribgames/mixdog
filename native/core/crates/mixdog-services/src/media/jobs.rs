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

use super::renditions::StillRenditions;
use super::store::{MediaStore, now_ms};
use super::variants;

/// Finished jobs stay readable so a slow poller still sees the terminal state.
const TERMINAL_TTL_MS: i64 = 10 * 60_000;
const MAX_PROMPT_CHARS: usize = 8_000;
const DEFAULT_MAX_ACTIVE_JOBS: usize = 4;
pub const MAX_GENERATED_MEDIA_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct MediaFailure {
    pub message: String,
    pub code: Option<String>,
}

impl MediaFailure {
    pub fn new(message: impl Into<String>, code: &str) -> Self {
        Self { message: message.into(), code: Some(code.to_owned()) }
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
    /// Reports 0..1 or 0..100.
    pub progress: Arc<dyn Fn(f64) + Send + Sync>,
}

pub struct GeneratedMedia {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub revised_prompt: Option<String>,
    pub duration_seconds: Option<u64>,
}

#[async_trait]
pub trait MediaGenerator: Send + Sync {
    /// Validates lane/kind/model (and credentials) before a job exists.
    async fn resolve(&self, lane: &str, kind: &str, model: &str) -> Result<ResolvedMedia, MediaFailure>;
    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedMedia, MediaFailure>;
    /// The lane catalog (providers, models, controls) as the provider layer describes it.
    async fn lanes(&self) -> Value;
}

struct Job {
    snapshot: Value,
    cancel: CancellationToken,
}

pub struct MediaJobs {
    store: Arc<MediaStore>,
    generator: Arc<dyn MediaGenerator>,
    jobs: Mutex<HashMap<String, Job>>,
    updates: broadcast::Sender<Value>,
    max_active: usize,
    /// When set, each saved asset's tile rendition is built in the background.
    renditions: Option<StillRenditions>,
}

impl MediaJobs {
    pub fn new(store: Arc<MediaStore>, generator: Arc<dyn MediaGenerator>, max_active: Option<usize>) -> Arc<Self> {
        Self::build(store, generator, max_active, None)
    }

    /// [`new`](Self::new) that also warms the tile rendition of every asset it saves.
    pub fn with_renditions(store: Arc<MediaStore>, generator: Arc<dyn MediaGenerator>, max_active: Option<usize>, renditions: StillRenditions) -> Arc<Self> {
        Self::build(store, generator, max_active, Some(renditions))
    }

    fn build(store: Arc<MediaStore>, generator: Arc<dyn MediaGenerator>, max_active: Option<usize>, renditions: Option<StillRenditions>) -> Arc<Self> {
        Arc::new(Self {
            store,
            generator,
            jobs: Mutex::default(),
            updates: broadcast::channel(256).0,
            max_active: max_active.filter(|n| *n > 0).unwrap_or(DEFAULT_MAX_ACTIVE_JOBS),
            renditions,
        })
    }

    /// Every snapshot change, for the `mediaJobs` section feed.
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.updates.subscribe()
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut Map<String, Value>)) {
        let snapshot = {
            let mut jobs = self.jobs.lock().unwrap();
            let Some(job) = jobs.get_mut(id) else { return };
            change(job.snapshot.as_object_mut().expect("snapshot is an object"));
            job.snapshot.clone()
        };
        let _ = self.updates.send(snapshot);
    }

    fn sweep(jobs: &mut HashMap<String, Job>) {
        let now = now_ms();
        jobs.retain(|_, j| j.snapshot["endedAt"].as_i64().is_none_or(|ended| now - ended <= TERMINAL_TTL_MS));
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
        let resolved = self.generator.resolve(text("lane"), text("kind"), text("model")).await?;
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
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let snapshot = json!({
            "id": id, "status": "running", "kind": resolved.kind, "lane": resolved.lane, "model": resolved.model,
            "prompt": prompt, "options": options, "boardId": board_id, "progress": 0,
            "assetId": null, "error": null, "errorCode": null, "startedAt": now_ms(), "endedAt": null,
        });
        {
            // The ceiling check and the insert are one step, so concurrent starts cannot overshoot.
            let mut jobs = self.jobs.lock().unwrap();
            Self::sweep(&mut jobs);
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
        let _ = self.updates.send(snapshot.clone());
        let this = self.clone();
        tokio::spawn(async move { this.run(id, resolved, prompt, options, references, board_id, cancel).await });
        Ok(snapshot)
    }

    async fn run(self: Arc<Self>, id: String, resolved: ResolvedMedia, prompt: String, options: Value, references: Vec<Reference>, board_id: String, cancel: CancellationToken) {
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
            .generate(GenerationRequest { resolved: resolved.clone(), prompt: prompt.clone(), options: options.clone(), references, cancel: cancel.clone(), progress })
            .await;
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
                if let Some(d) = media.duration_seconds.filter(|d| *d > 0) {
                    meta.insert("durationSeconds".into(), json!(d));
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
            s.insert("endedAt".into(), json!(now_ms()));
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
                }
            }
        });
    }

    pub async fn lanes(&self) -> Value {
        self.generator.lanes().await
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.jobs.lock().unwrap().get(id).map(|j| j.snapshot.clone())
    }

    pub fn list(&self) -> Vec<Value> {
        let mut jobs = self.jobs.lock().unwrap();
        Self::sweep(&mut jobs);
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
            Ok(ResolvedMedia { kind: kind.into(), lane: lane.into(), model: model.into(), max_references: 1 })
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
                    Ok(GeneratedMedia { bytes: b"png".to_vec(), mime: "image/png".into(), revised_prompt: None, duration_seconds: None })
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
}
