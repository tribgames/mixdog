//! Audio → text: size and duration gates, transcript cache, one whisper-ready wav per
//! attachment, then the managed whisper server. Serialisation of transcriptions is the
//! protocol's `global("voice")` scope (queue of one), not a queue here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use mixdog_rt::{DurabilityIo, Scope, Scoped};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::language::{detect_device_language, normalize_whisper_language};
use super::runtime::{RuntimeManifest, VoiceRuntime, VoiceRuntimeInfo, resolve_voice_runtime, voice_runtime_info};
use super::single_flight::SingleFlight;
use super::wav::{ONSET_SILENCE_SECONDS, prepend_wav_silence};
use crate::lane::on_lane;

/// A user-facing failure message (for example "voice runtime not installed …").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceError(pub String);

impl std::fmt::Display for VoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for VoiceError {}

impl From<String> for VoiceError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

/// The `voice` section of the config.
#[derive(Clone, Debug, PartialEq)]
pub struct VoiceSettings {
    pub enabled: bool,
    pub language: Option<String>,
    pub max_file_size_mb: f64,
    pub max_duration_sec: f64,
    pub thread_count: Option<usize>,
    pub sample_rate: u32,
    pub channels: u32,
}

impl VoiceSettings {
    pub fn from_section(section: &Value) -> Self {
        let transcription = section.get("transcription");
        let number = |key: &str| transcription.and_then(|t| t.get(key)).and_then(Value::as_f64);
        Self {
            enabled: section.get("enabled") == Some(&Value::Bool(true)),
            language: section.get("language").and_then(Value::as_str).map(str::to_owned),
            max_file_size_mb: number("maxFileSizeMB").unwrap_or(0.0),
            max_duration_sec: number("maxDurationSec").unwrap_or(0.0),
            thread_count: number("threadCount").map(|n| n.max(1.0) as usize),
            sample_rate: number("sampleRate").map_or(16000, |n| n as u32),
            channels: number("channels").map_or(1, |n| n as u32),
        }
    }

    /// Configured whisper thread count, else a quarter of the cores (at least one).
    pub fn whisper_threads(&self) -> usize {
        self.thread_count.unwrap_or_else(|| {
            let cpus = std::thread::available_parallelism().map_or(2, |n| n.get());
            cpus.div_ceil(4).max(1)
        })
    }
}

/// The exact whisper-server contract: a running server matches it or is replaced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerContract {
    pub server_cmd: PathBuf,
    pub model_path: PathBuf,
    pub thread_count: usize,
    pub host: String,
}

/// Process-level audio helpers.
#[async_trait]
pub trait AudioTools: Send + Sync {
    async fn convert_to_wav(&self, ffmpeg: &Path, audio: &Path, wav: &Path, sample_rate: u32, channels: u32, threads: usize) -> Result<(), VoiceError>;

    /// Container duration; `None` when it cannot be measured, so a gate never rejects a file it
    /// could not measure.
    async fn probe_duration_sec(&self, audio: &Path) -> Option<f64>;
}

#[async_trait]
pub trait WhisperEngine: Send + Sync {
    /// Resolves when a server matching `contract` is bound and has loaded its model.
    async fn ensure_ready(&self, contract: &ServerContract) -> Result<(), VoiceError>;
    async fn transcribe(&self, wav: &Path, language: Option<&str>) -> Result<String, VoiceError>;
}

/// Live `voice` config section.
pub trait VoiceSettingsSource: Send + Sync {
    fn voice_section(&self) -> Value;
}

struct AttachmentState {
    sessions: HashMap<String, std::collections::HashSet<String>>,
    next_run: u64,
    /// Per in-flight attachment: `(live_runs, forgotten_before_run)`.
    in_flight: HashMap<String, (usize, u64)>,
}

impl Default for AttachmentState {
    fn default() -> Self {
        Self { sessions: HashMap::new(), next_run: 1, in_flight: HashMap::new() }
    }
}

impl AttachmentState {
    fn begin_run(&mut self, attachment_id: &str) -> u64 {
        let run_id = self.next_run;
        self.next_run = self.next_run.wrapping_add(1).max(1);
        let entry = self.in_flight.entry(attachment_id.to_owned()).or_insert((0, 0));
        entry.0 += 1;
        run_id
    }

    fn end_run(&mut self, attachment_id: &str) {
        if let Some(entry) = self.in_flight.get_mut(attachment_id) {
            entry.0 = entry.0.saturating_sub(1);
            if entry.0 == 0 {
                self.in_flight.remove(attachment_id);
                if self.in_flight.is_empty() {
                    self.in_flight.shrink_to_fit();
                }
            }
        }
    }

    fn invalidate_in_flight(&mut self, attachment_id: &str) {
        if let Some(entry) = self.in_flight.get_mut(attachment_id) {
            entry.1 = self.next_run;
        }
    }

    fn can_cache(&self, attachment_id: &str, session_id: Option<&str>, run_id: u64) -> bool {
        let not_forgotten = self.in_flight.get(attachment_id).is_some_and(|&(_, forgotten_before)| run_id >= forgotten_before);
        if !not_forgotten {
            return false;
        }
        match session_id {
            Some(sid) => self.sessions.get(sid).is_some_and(|set| set.contains(attachment_id)) || self.sessions.values().any(|set| set.contains(attachment_id)),
            None => true,
        }
    }
}

struct RunGuard {
    pipeline: Arc<VoicePipeline>,
    attachment_id: String,
    run_id: u64,
}

impl RunGuard {
    fn begin(pipeline: &Arc<VoicePipeline>, attachment_id: &str) -> Self {
        let run_id = pipeline.attachments.lock().unwrap().begin_run(attachment_id);
        Self { pipeline: Arc::clone(pipeline), attachment_id: attachment_id.to_owned(), run_id }
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.pipeline.attachments.lock().unwrap().end_run(&self.attachment_id);
    }
}

pub struct VoicePipeline {
    data_dir: PathBuf,
    manifest: RuntimeManifest,
    settings: Arc<dyn VoiceSettingsSource>,
    engine: Arc<dyn WhisperEngine>,
    tools: Arc<dyn AudioTools>,
    device_language: OnceLock<String>,
    transcripts: Mutex<HashMap<String, String>>,
    transcribing: SingleFlight<Result<Option<String>, VoiceError>>,
    wav_by_attachment: Mutex<HashMap<String, PathBuf>>,
    attachments: Mutex<AttachmentState>,
    converting: SingleFlight<Result<(), VoiceError>>,
    /// The lane every file read and write of the voice path runs on.
    lane: DurabilityIo,
}

/// Size of `path`, `None` when it cannot be read.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn file_exists(path: &Path) -> bool {
    path.exists()
}

/// Prepends the onset silence to the converted WAV in place.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn pad_wav(wav: &Path) -> Result<(), VoiceError> {
    let bytes = std::fs::read(wav).map_err(|e| VoiceError(e.to_string()))?;
    let padded = prepend_wav_silence(&bytes, ONSET_SILENCE_SECONDS).map_err(|e| VoiceError(format!("{e}: {}", wav.display())))?;
    std::fs::write(wav, padded).map_err(|e| VoiceError(e.to_string()))
}

impl VoicePipeline {
    pub fn new(
        data_dir: PathBuf,
        manifest: RuntimeManifest,
        settings: Arc<dyn VoiceSettingsSource>,
        engine: Arc<dyn WhisperEngine>,
        tools: Arc<dyn AudioTools>,
        lane: DurabilityIo,
    ) -> Self {
        Self {
            data_dir,
            manifest,
            settings,
            engine,
            tools,
            device_language: OnceLock::new(),
            transcripts: Mutex::default(),
            transcribing: SingleFlight::default(),
            wav_by_attachment: Mutex::default(),
            attachments: Mutex::default(),
            converting: SingleFlight::default(),
            lane,
        }
    }

    /// Associates an attachment with `session_id` so ending the session releases its cached entries.
    pub fn bind_session(&self, session_id: &str, attachment_id: &str) {
        self.attachments.lock().unwrap().sessions.entry(session_id.to_owned()).or_default().insert(attachment_id.to_owned());
    }

    /// Transcribes an attachment belonging to `session_id`, binding its lifecycle to that session.
    pub async fn transcribe_for_session(
        self: &Arc<Self>,
        session_id: &str,
        audio: &Path,
        attachment_id: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, VoiceError> {
        self.bind_session(session_id, attachment_id);
        self.transcribe_inner(audio, Some(attachment_id), Some(session_id), cancel).await
    }

    fn evict_cached<'a>(&self, ids: impl IntoIterator<Item = &'a str> + Clone) {
        {
            let mut transcripts = self.transcripts.lock().unwrap();
            for id in ids.clone() {
                transcripts.remove(id);
            }
            if transcripts.is_empty() {
                transcripts.shrink_to_fit();
            }
        }
        {
            let mut wavs = self.wav_by_attachment.lock().unwrap();
            for id in ids {
                wavs.remove(id);
            }
            if wavs.is_empty() {
                wavs.shrink_to_fit();
            }
        }
    }

    /// Drops the cached transcript and converted WAV path once the attachment is sent or removed.
    pub fn forget_attachment(&self, attachment_id: &str) {
        let mut state = self.attachments.lock().unwrap();
        state.sessions.retain(|_, attachments| {
            attachments.remove(attachment_id);
            !attachments.is_empty()
        });
        if state.sessions.is_empty() {
            state.sessions.shrink_to_fit();
        }
        state.invalidate_in_flight(attachment_id);
        self.evict_cached([attachment_id]);
    }

    /// Drops every cached transcript and WAV path associated with a session that ended.
    pub fn forget_session(&self, session_id: &str) {
        let mut state = self.attachments.lock().unwrap();
        let removed = state.sessions.remove(session_id);
        if state.sessions.is_empty() {
            state.sessions.shrink_to_fit();
        }
        let Some(attachments) = removed else { return };
        let orphaned: Vec<String> = attachments.into_iter().filter(|id| !state.sessions.values().any(|set| set.contains(id))).collect();
        for id in &orphaned {
            state.invalidate_in_flight(id);
        }
        self.evict_cached(orphaned.iter().map(String::as_str));
    }

    #[cfg(test)]
    pub(crate) fn cache_counts(&self) -> (usize, usize) {
        (self.transcripts.lock().unwrap().len(), self.wav_by_attachment.lock().unwrap().len())
    }

    pub fn lane(&self) -> DurabilityIo {
        self.lane
    }

    pub fn settings(&self) -> VoiceSettings {
        VoiceSettings::from_section(&self.settings.voice_section())
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn manifest(&self) -> &RuntimeManifest {
        &self.manifest
    }

    /// What is installed now, resolved on the lane; a lane that cannot answer reads as nothing
    /// installed.
    pub async fn runtime(&self) -> Result<VoiceRuntime, VoiceError> {
        let (dir, manifest) = (self.data_dir.clone(), self.manifest.clone());
        on_lane(self.lane, move || resolve_voice_runtime(&dir, &manifest))
            .await
            .map_err(|e| VoiceError(format!("the voice runtime state could not be read: {e}")))
    }

    /// For a status display only: a read that never ran shows an absent runtime, and the next
    /// poll reads it again. Nothing that installs or transcribes may use this.
    pub async fn runtime_for_display(&self) -> VoiceRuntime {
        self.runtime().await.unwrap_or_else(|_| VoiceRuntime::absent(&self.manifest))
    }

    /// [`voice_runtime_info`] for `runtime`, read on the lane.
    pub async fn runtime_info(&self, runtime: &VoiceRuntime) -> VoiceRuntimeInfo {
        let (runtime, manifest) = (runtime.clone(), self.manifest.clone());
        on_lane(self.lane, move || voice_runtime_info(&runtime, &manifest)).await.unwrap_or_default()
    }

    async fn contract(&self, settings: &VoiceSettings) -> Result<(VoiceRuntime, ServerContract), VoiceError> {
        let runtime = self.runtime().await?;
        if !runtime.installed {
            let missing: Vec<&str> = [(runtime.binary, "binary"), (runtime.model, "model"), (runtime.ffmpeg, "ffmpeg")]
                .into_iter()
                .filter(|(present, _)| !present)
                .map(|(_, name)| name)
                .collect();
            return Err(VoiceError(format!(
                "voice runtime not installed (missing: {}) — open the setup wizard and click \"Install voice\"",
                missing.join(" + ")
            )));
        }
        let contract = ServerContract {
            server_cmd: runtime.server_cmd.clone().expect("installed implies server"),
            model_path: runtime.model_path.clone().expect("installed implies model"),
            thread_count: settings.whisper_threads(),
            host: "127.0.0.1".to_owned(),
        };
        Ok((runtime, contract))
    }

    fn language(&self, settings: &VoiceSettings) -> String {
        normalize_whisper_language(settings.language.as_deref()).unwrap_or_else(|| {
            self.device_language
                .get_or_init(|| {
                    let env = |key: &str| std::env::var(key).ok();
                    let vars = [env("MIXDOG_CHANNELS_WHISPER_LANGUAGE"), env("LC_ALL"), env("LC_MESSAGES"), env("LANG")];
                    detect_device_language(vars.iter().map(Option::as_deref))
                })
                .clone()
        })
    }

    /// `Ok(None)` is a skipped file (over a gate) or a legitimately empty transcript; every real
    /// failure is an error so the caller can retry and mark the failure. Node accepts any audio and
    /// bounds nothing by time, so the wait ends only by the caller's `cancel`: callers of the same
    /// attachment share one run, and the run (and its whisper request) is cancelled when the last
    /// of them has left.
    pub async fn transcribe(self: &Arc<Self>, audio: &Path, attachment_id: Option<&str>, cancel: &CancellationToken) -> Result<Option<String>, VoiceError> {
        self.transcribe_inner(audio, attachment_id, None, cancel).await
    }

    async fn transcribe_inner(
        self: &Arc<Self>,
        audio: &Path,
        attachment_id: Option<&str>,
        session_id: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, VoiceError> {
        match Scope::new().cancel(cancel).run(self.transcribe_gated(audio, attachment_id, session_id)).await {
            Scoped::Done(result) => result,
            Scoped::Cancelled | Scoped::DeadlineExceeded => Err(VoiceError("transcribe: cancelled".into())),
        }
    }

    async fn transcribe_gated(self: &Arc<Self>, audio: &Path, attachment_id: Option<&str>, session_id: Option<&str>) -> Result<Option<String>, VoiceError> {
        let run_guard = attachment_id.map(|id| RunGuard::begin(self, id));
        let settings = self.settings();
        let max_bytes = settings.max_file_size_mb * 1024.0 * 1024.0;
        if max_bytes > 0.0 {
            let path = audio.to_owned();
            // A size check that never ran must not wave an over-limit file through.
            let size = on_lane(self.lane, move || file_size(&path)).await.map_err(|e| VoiceError(format!("the audio file size could not be checked: {e}")))?;
            if size.is_some_and(|size| size as f64 > max_bytes) {
                return Ok(None);
            }
        }
        if settings.max_duration_sec > 0.0
            && let Some(duration) = self.tools.probe_duration_sec(audio).await
            && duration > settings.max_duration_sec
        {
            return Ok(None);
        }
        let Some((id, run_guard)) = attachment_id.zip(run_guard) else {
            return Arc::clone(self).transcribe_uncached(audio.to_owned(), None, None).await;
        };
        if let Some(text) = self.transcripts.lock().unwrap().get(id).cloned() {
            return Ok(Some(text));
        }
        let (this, audio, session) = (Arc::clone(self), audio.to_owned(), session_id.map(str::to_owned));
        self.transcribing.run(id, move || this.transcribe_uncached(audio, Some(run_guard), session)).await
    }

    async fn transcribe_uncached(self: Arc<Self>, audio: PathBuf, run: Option<RunGuard>, session_id: Option<String>) -> Result<Option<String>, VoiceError> {
        let session_id = session_id.as_deref();
        let settings = self.settings();
        let (runtime, contract) = self.contract(&settings).await?;
        let language = self.language(&settings);
        let wav = self.ensure_wav(&audio, run.as_ref(), session_id, &runtime, &settings).await?;
        self.engine.ensure_ready(&contract).await?;
        let text = self.engine.transcribe(&wav, Some(&language)).await?;
        let text = mixdog_js::js_trim(&text);
        if text.is_empty() {
            return Ok(None);
        }
        if let Some(run) = &run {
            let state = self.attachments.lock().unwrap();
            if state.can_cache(&run.attachment_id, session_id, run.run_id) {
                self.transcripts.lock().unwrap().insert(run.attachment_id.clone(), text.to_owned());
            }
        }
        Ok(Some(text.to_owned()))
    }

    async fn ensure_wav(
        self: &Arc<Self>,
        audio: &Path,
        run: Option<&RunGuard>,
        session_id: Option<&str>,
        runtime: &VoiceRuntime,
        settings: &VoiceSettings,
    ) -> Result<PathBuf, VoiceError> {
        let attachment_id = run.map(|r| r.attachment_id.as_str());
        if let Some(id) = attachment_id {
            let cached = self.wav_by_attachment.lock().unwrap().get(id).cloned();
            if let Some(path) = cached {
                let probed = path.clone();
                if on_lane(self.lane, move || file_exists(&probed)).await.unwrap_or(false) {
                    return Ok(path);
                }
                self.wav_by_attachment.lock().unwrap().remove(id);
            }
        }
        let wav = audio.with_extension("wav");
        let key = attachment_id.map_or_else(|| wav.to_string_lossy().into_owned(), str::to_owned);
        let ffmpeg = runtime.ffmpeg_path.clone().expect("installed implies ffmpeg");
        let threads = settings.whisper_threads();
        let (tools, lane, audio, converted) = (Arc::clone(&self.tools), self.lane, audio.to_owned(), wav.clone());
        let (sample_rate, channels) = (settings.sample_rate, settings.channels);
        self.converting
            .run(&key, move || async move {
                tools.convert_to_wav(&ffmpeg, &audio, &converted, sample_rate, channels, threads).await?;
                let padded = converted.clone();
                on_lane(lane, move || pad_wav(&padded)).await.map_err(|e| VoiceError(e.to_string()))?
            })
            .await?;
        if let Some(run) = run {
            let state = self.attachments.lock().unwrap();
            if state.can_cache(&run.attachment_id, session_id, run.run_id) {
                self.wav_by_attachment.lock().unwrap().insert(run.attachment_id.clone(), wav.clone());
            }
        }
        Ok(wav)
    }

    /// Warms the managed server for the current contract so the next transcription skips the
    /// cold model load. Never fails: warm-up is advisory.
    pub async fn prepare_transcription(&self) -> Value {
        let settings = self.settings();
        let contract = match self.contract(&settings).await {
            Ok((_, contract)) => contract,
            Err(VoiceError(reason)) => return json!({"ready": false, "reason": reason}),
        };
        match self.engine.ensure_ready(&contract).await {
            Ok(()) => json!({"ready": true}),
            Err(VoiceError(reason)) => json!({"ready": false, "reason": reason}),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::super::runtime::SERVER_NAME;
    use super::*;

    pub struct Fixed(pub Value);
    impl VoiceSettingsSource for Fixed {
        fn voice_section(&self) -> Value {
            self.0.clone()
        }
    }

    #[derive(Default)]
    pub struct FakeTools {
        pub converts: AtomicUsize,
        pub duration: Option<f64>,
    }

    #[async_trait]
    impl AudioTools for FakeTools {
        async fn convert_to_wav(&self, _: &Path, _: &Path, wav: &Path, rate: u32, _: u32, _: usize) -> Result<(), VoiceError> {
            self.converts.fetch_add(1, Ordering::SeqCst);
            let mut w = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
            w.extend(16u32.to_le_bytes());
            w.extend([1, 0, 1, 0]);
            w.extend(rate.to_le_bytes());
            w.extend((rate * 2).to_le_bytes());
            w.extend([2, 0, 16, 0]);
            w.extend(b"data");
            w.extend(2u32.to_le_bytes());
            w.extend([9, 0]);
            std::fs::write(wav, w).unwrap();
            Ok(())
        }
        async fn probe_duration_sec(&self, _: &Path) -> Option<f64> {
            self.duration
        }
    }

    #[derive(Default)]
    pub struct FakeEngine {
        pub ready: AtomicUsize,
        pub runs: AtomicUsize,
        pub text: String,
    }

    #[async_trait]
    impl WhisperEngine for FakeEngine {
        async fn ensure_ready(&self, _: &ServerContract) -> Result<(), VoiceError> {
            self.ready.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn transcribe(&self, wav: &Path, _: Option<&str>) -> Result<String, VoiceError> {
            assert!(std::fs::metadata(wav).unwrap().len() > 46, "the onset pad is in the wav");
            self.runs.fetch_add(1, Ordering::SeqCst);
            Ok(self.text.clone())
        }
    }

    fn put(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    /// The whisper runtime alone: what an install leaves behind when the model then fails.
    pub fn install_whisper(dir: &Path) {
        put(dir, "voice-runtime/active-version", b"whisper-1.10.1-vulkan");
        put(dir, "voice-runtime/whisper-1.10.1-vulkan/Release/whisper-cli", b"x");
        put(dir, &format!("voice-runtime/whisper-1.10.1-vulkan/Release/{SERVER_NAME}"), b"x");
    }

    pub fn install(dir: &Path) {
        install_whisper(dir);
        put(dir, "voice/models/ggml.bin", b"model");
        put(dir, "ffmpeg-runtime/active-version", b"ffmpeg-6");
        put(dir, "ffmpeg-runtime/ffmpeg-6/ffmpeg", b"x");
    }

    pub fn manifest() -> RuntimeManifest {
        RuntimeManifest {
            version: "1.10.1".into(),
            variants: vec![("vulkan".into(), "Release/whisper-cli".into())],
            model_key: "standard".into(),
            model_id: "standard".into(),
            model_filename: "ggml.bin".into(),
            model_size: 5,
            ffmpeg_executable: Some("ffmpeg".into()),
        }
    }

    fn pipeline(dir: &Path, section: Value, tools: FakeTools, engine: FakeEngine) -> (Arc<VoicePipeline>, Arc<FakeTools>, Arc<FakeEngine>) {
        let (tools, engine) = (Arc::new(tools), Arc::new(engine));
        let p = Arc::new(VoicePipeline::new(
            dir.to_owned(),
            manifest(),
            Arc::new(Fixed(section)),
            engine.clone(),
            tools.clone(),
            mixdog_rt::testing::tokens().durability_io,
        ));
        (p, tools, engine)
    }

    #[tokio::test]
    async fn missing_runtime_is_a_user_actionable_error_and_prepare_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let (p, _, engine) = pipeline(dir.path(), json!({}), FakeTools::default(), FakeEngine::default());
        let err = p.transcribe(&dir.path().join("a.ogg"), None, &CancellationToken::new()).await.unwrap_err();
        assert!(err.0.starts_with("voice runtime not installed (missing: binary + model + ffmpeg)"));
        let prepared = p.prepare_transcription().await;
        assert_eq!(prepared["ready"], false);
        assert_eq!(engine.ready.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn transcript_and_wav_are_cached_per_attachment() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path());
        let audio = dir.path().join("a.ogg");
        std::fs::write(&audio, b"audio").unwrap();
        let (p, tools, engine) = pipeline(dir.path(), json!({}), FakeTools::default(), FakeEngine { text: " hello \n".into(), ..Default::default() });
        let first = p.transcribe(&audio, Some("att"), &CancellationToken::new()).await.unwrap();
        let second = p.transcribe(&audio, Some("att"), &CancellationToken::new()).await.unwrap();
        assert_eq!((first.as_deref(), second.as_deref()), (Some("hello"), Some("hello")));
        assert_eq!(tools.converts.load(Ordering::SeqCst), 1);
        assert_eq!(engine.runs.load(Ordering::SeqCst), 1);
        assert_eq!(p.prepare_transcription().await, json!({"ready": true}));
    }

    /// An engine that holds every transcription until `gate` opens.
    struct Gated {
        gate: Arc<tokio::sync::Notify>,
        runs: AtomicUsize,
    }

    #[async_trait]
    impl WhisperEngine for Gated {
        async fn ensure_ready(&self, _: &ServerContract) -> Result<(), VoiceError> {
            Ok(())
        }
        async fn transcribe(&self, _: &Path, _: Option<&str>) -> Result<String, VoiceError> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            self.gate.notified().await;
            Ok("after".into())
        }
    }

    /// The caller that started the run cancels while another waits on the same attachment: the
    /// canceller gets the cancelled error at once and the other still gets the transcript, from the
    /// one run.
    #[tokio::test]
    async fn a_caller_cancelling_leaves_the_run_to_the_other_waiter() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path());
        let audio = dir.path().join("a.ogg");
        std::fs::write(&audio, b"audio").unwrap();
        let engine = Arc::new(Gated { gate: Arc::default(), runs: AtomicUsize::new(0) });
        let p = Arc::new(VoicePipeline::new(
            dir.path().to_owned(),
            manifest(),
            Arc::new(Fixed(json!({}))),
            engine.clone(),
            Arc::new(FakeTools::default()),
            mixdog_rt::testing::tokens().durability_io,
        ));
        let (first, second) = (CancellationToken::new(), CancellationToken::new());
        let leader = tokio::spawn({
            let (p, audio, cancel) = (p.clone(), audio.clone(), first.clone());
            async move { p.transcribe(&audio, Some("att"), &cancel).await }
        });
        while p.transcribing.waiters("att") < 1 {
            tokio::task::yield_now().await;
        }
        let follower = tokio::spawn({
            let (p, audio, cancel) = (p.clone(), audio.clone(), second.clone());
            async move { p.transcribe(&audio, Some("att"), &cancel).await }
        });
        while p.transcribing.waiters("att") < 2 {
            tokio::task::yield_now().await;
        }
        first.cancel();
        assert_eq!(leader.await.unwrap().unwrap_err(), VoiceError("transcribe: cancelled".into()));
        engine.gate.notify_one();
        assert_eq!(follower.await.unwrap().unwrap().as_deref(), Some("after"));
        assert_eq!(engine.runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn gates_skip_big_and_long_files_and_empty_transcript_is_none() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path());
        let audio = dir.path().join("a.ogg");
        std::fs::write(&audio, vec![0u8; 2 * 1024 * 1024]).unwrap();
        let (p, _, engine) = pipeline(dir.path(), json!({"transcription": {"maxFileSizeMB": 1}}), FakeTools::default(), FakeEngine::default());
        assert_eq!(p.transcribe(&audio, None, &CancellationToken::new()).await.unwrap(), None);
        let (p, _, _) = pipeline(
            dir.path(),
            json!({"transcription": {"maxDurationSec": 10}}),
            FakeTools { duration: Some(11.0), ..Default::default() },
            FakeEngine::default(),
        );
        assert_eq!(p.transcribe(&audio, None, &CancellationToken::new()).await.unwrap(), None);
        assert_eq!(engine.runs.load(Ordering::SeqCst), 0);
        let (p, _, engine) = pipeline(dir.path(), json!({}), FakeTools::default(), FakeEngine { text: "  ".into(), ..Default::default() });
        assert_eq!(p.transcribe(&audio, Some("e"), &CancellationToken::new()).await.unwrap(), None);
        assert_eq!(engine.runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn forgetting_an_attachment_or_ending_its_session_releases_transcript_and_wav() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path());
        let a1 = dir.path().join("a1.ogg");
        let a2 = dir.path().join("a2.ogg");
        let a3 = dir.path().join("a3.ogg");
        for path in [&a1, &a2, &a3] {
            std::fs::write(path, b"audio").unwrap();
        }
        let (p, _, _) = pipeline(dir.path(), json!({}), FakeTools::default(), FakeEngine { text: "hello".into(), ..Default::default() });
        p.transcribe(&a1, Some("att-sent"), &CancellationToken::new()).await.unwrap();
        p.transcribe_for_session("sess-1", &a2, "att-s1", &CancellationToken::new()).await.unwrap();
        p.transcribe_for_session("sess-2", &a3, "att-s2", &CancellationToken::new()).await.unwrap();
        assert_eq!(p.cache_counts(), (3, 3));

        // Attachment sent or removed.
        p.forget_attachment("att-sent");
        assert_eq!(p.cache_counts(), (2, 2));

        // Session 1 ends: its entries go while session 2's live attachment stays.
        p.forget_session("sess-1");
        assert_eq!(p.cache_counts(), (1, 1));
        assert!(p.transcripts.lock().unwrap().contains_key("att-s2"));

        // Session 2 ends: everything is released.
        p.forget_session("sess-2");
        assert_eq!(p.cache_counts(), (0, 0));
    }

    #[tokio::test]
    async fn forgetting_mid_flight_does_not_leak_wav_or_transcript_cache_entries() {
        struct GatedTools {
            entered: Arc<tokio::sync::Notify>,
            release: Arc<tokio::sync::Notify>,
            gate_convert: bool,
        }
        #[async_trait]
        impl AudioTools for GatedTools {
            async fn convert_to_wav(&self, _: &Path, _: &Path, wav: &Path, rate: u32, _: u32, _: usize) -> Result<(), VoiceError> {
                if self.gate_convert {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                let mut w = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
                w.extend(16u32.to_le_bytes());
                w.extend([1, 0, 1, 0]);
                w.extend(rate.to_le_bytes());
                w.extend((rate * 2).to_le_bytes());
                w.extend([2, 0, 16, 0]);
                w.extend(b"data");
                w.extend(2u32.to_le_bytes());
                w.extend([9, 0]);
                std::fs::write(wav, w).unwrap();
                Ok(())
            }
            async fn probe_duration_sec(&self, _: &Path) -> Option<f64> {
                None
            }
        }
        struct GatedEngine {
            entered: Arc<tokio::sync::Notify>,
            release: Arc<tokio::sync::Notify>,
            gate_transcribe: bool,
        }
        #[async_trait]
        impl WhisperEngine for GatedEngine {
            async fn ensure_ready(&self, _: &ServerContract) -> Result<(), VoiceError> {
                Ok(())
            }
            async fn transcribe(&self, _: &Path, _: Option<&str>) -> Result<String, VoiceError> {
                if self.gate_transcribe {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                Ok("transcribed text".into())
            }
        }

        let dir = tempfile::tempdir().unwrap();
        install(dir.path());

        // Case 1: forget_session runs while convert_to_wav is in flight -> neither wav nor transcript is cached.
        let a1 = dir.path().join("mid1.ogg");
        std::fs::write(&a1, b"audio").unwrap();
        let conv_entered = Arc::new(tokio::sync::Notify::new());
        let conv_release = Arc::new(tokio::sync::Notify::new());
        let p1 = Arc::new(VoicePipeline::new(
            dir.path().to_path_buf(),
            manifest(),
            Arc::new(Fixed(json!({}))),
            Arc::new(GatedEngine { entered: Arc::new(tokio::sync::Notify::new()), release: Arc::new(tokio::sync::Notify::new()), gate_transcribe: false }),
            Arc::new(GatedTools { entered: conv_entered.clone(), release: conv_release.clone(), gate_convert: true }),
            mixdog_rt::testing::tokens().durability_io,
        ));
        let task1 = {
            let p = Arc::clone(&p1);
            let a = a1.clone();
            tokio::spawn(async move { p.transcribe_for_session("sess-1", &a, "att-1", &CancellationToken::new()).await })
        };
        conv_entered.notified().await;
        p1.forget_session("sess-1");
        conv_release.notify_one();
        assert_eq!(task1.await.unwrap().unwrap().as_deref(), Some("transcribed text"));
        assert_eq!(p1.cache_counts(), (0, 0), "mid-flight forget_session must not leave orphaned wav or transcript");

        // Case 2: forget_attachment runs while engine.transcribe is in flight -> neither wav nor transcript survives.
        let a2 = dir.path().join("mid2.ogg");
        std::fs::write(&a2, b"audio").unwrap();
        let tx_entered = Arc::new(tokio::sync::Notify::new());
        let tx_release = Arc::new(tokio::sync::Notify::new());
        let p2 = Arc::new(VoicePipeline::new(
            dir.path().to_path_buf(),
            manifest(),
            Arc::new(Fixed(json!({}))),
            Arc::new(GatedEngine { entered: tx_entered.clone(), release: tx_release.clone(), gate_transcribe: true }),
            Arc::new(GatedTools { entered: Arc::new(tokio::sync::Notify::new()), release: Arc::new(tokio::sync::Notify::new()), gate_convert: false }),
            mixdog_rt::testing::tokens().durability_io,
        ));
        let task2 = {
            let p = Arc::clone(&p2);
            let a = a2.clone();
            tokio::spawn(async move { p.transcribe_for_session("sess-2", &a, "att-2", &CancellationToken::new()).await })
        };
        tx_entered.notified().await;
        p2.forget_attachment("att-2");
        tx_release.notify_one();
        assert_eq!(task2.await.unwrap().unwrap().as_deref(), Some("transcribed text"));
        assert_eq!(p2.cache_counts(), (0, 0), "mid-flight forget_attachment must not leave orphaned transcript");

        // Case 3: session-less transcribe(..., Some(id), ...) (e.g. one-shot dictation) + mid-flight forget_attachment
        // during convert_to_wav -> neither wav nor transcript leaks, and in_flight tracking clears.
        let a3 = dir.path().join("mid3.ogg");
        std::fs::write(&a3, b"audio").unwrap();
        let d_conv_entered = Arc::new(tokio::sync::Notify::new());
        let d_conv_release = Arc::new(tokio::sync::Notify::new());
        let p3 = Arc::new(VoicePipeline::new(
            dir.path().to_path_buf(),
            manifest(),
            Arc::new(Fixed(json!({}))),
            Arc::new(GatedEngine { entered: Arc::new(tokio::sync::Notify::new()), release: Arc::new(tokio::sync::Notify::new()), gate_transcribe: false }),
            Arc::new(GatedTools { entered: d_conv_entered.clone(), release: d_conv_release.clone(), gate_convert: true }),
            mixdog_rt::testing::tokens().durability_io,
        ));
        let task3 = {
            let p = Arc::clone(&p3);
            let a = a3.clone();
            tokio::spawn(async move { p.transcribe(&a, Some("dictation-1"), &CancellationToken::new()).await })
        };
        d_conv_entered.notified().await;
        p3.forget_attachment("dictation-1");
        d_conv_release.notify_one();
        assert_eq!(task3.await.unwrap().unwrap().as_deref(), Some("transcribed text"));
        assert_eq!(p3.cache_counts(), (0, 0), "session-less transcribe + mid-flight forget_attachment during convert must not leak");
        assert!(p3.attachments.lock().unwrap().in_flight.is_empty());

        // Case 4: session-less transcribe(..., Some(id), ...) + mid-flight forget_attachment during engine.transcribe
        // -> already-cached wav is dropped and finished transcript is not inserted.
        let a4 = dir.path().join("mid4.ogg");
        std::fs::write(&a4, b"audio").unwrap();
        let d_tx_entered = Arc::new(tokio::sync::Notify::new());
        let d_tx_release = Arc::new(tokio::sync::Notify::new());
        let p4 = Arc::new(VoicePipeline::new(
            dir.path().to_path_buf(),
            manifest(),
            Arc::new(Fixed(json!({}))),
            Arc::new(GatedEngine { entered: d_tx_entered.clone(), release: d_tx_release.clone(), gate_transcribe: true }),
            Arc::new(GatedTools { entered: Arc::new(tokio::sync::Notify::new()), release: Arc::new(tokio::sync::Notify::new()), gate_convert: false }),
            mixdog_rt::testing::tokens().durability_io,
        ));
        let task4 = {
            let p = Arc::clone(&p4);
            let a = a4.clone();
            tokio::spawn(async move { p.transcribe(&a, Some("dictation-2"), &CancellationToken::new()).await })
        };
        d_tx_entered.notified().await;
        p4.forget_attachment("dictation-2");
        d_tx_release.notify_one();
        assert_eq!(task4.await.unwrap().unwrap().as_deref(), Some("transcribed text"));
        assert_eq!(p4.cache_counts(), (0, 0), "session-less transcribe + mid-flight forget_attachment during transcribe must not leak");
        assert!(p4.attachments.lock().unwrap().in_flight.is_empty());

        // Case 5: bind_session + session-less transcribe + mid-flight forget_session -> neither wav nor transcript leaks.
        let a5 = dir.path().join("mid5.ogg");
        std::fs::write(&a5, b"audio").unwrap();
        let b_tx_entered = Arc::new(tokio::sync::Notify::new());
        let b_tx_release = Arc::new(tokio::sync::Notify::new());
        let p5 = Arc::new(VoicePipeline::new(
            dir.path().to_path_buf(),
            manifest(),
            Arc::new(Fixed(json!({}))),
            Arc::new(GatedEngine { entered: b_tx_entered.clone(), release: b_tx_release.clone(), gate_transcribe: true }),
            Arc::new(GatedTools { entered: Arc::new(tokio::sync::Notify::new()), release: Arc::new(tokio::sync::Notify::new()), gate_convert: false }),
            mixdog_rt::testing::tokens().durability_io,
        ));
        p5.bind_session("sess-bound", "att-bound");
        let task5 = {
            let p = Arc::clone(&p5);
            let a = a5.clone();
            tokio::spawn(async move { p.transcribe(&a, Some("att-bound"), &CancellationToken::new()).await })
        };
        b_tx_entered.notified().await;
        p5.forget_session("sess-bound");
        b_tx_release.notify_one();
        assert_eq!(task5.await.unwrap().unwrap().as_deref(), Some("transcribed text"));
        assert_eq!(p5.cache_counts(), (0, 0), "bind_session + transcribe + mid-flight forget_session must not leak");
        assert!(p5.attachments.lock().unwrap().in_flight.is_empty());
    }
}
