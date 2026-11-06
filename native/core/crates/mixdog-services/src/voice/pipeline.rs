//! Audio → text: size and duration gates, transcript cache, one whisper-ready wav per
//! attachment, then the managed whisper server. Serialisation of transcriptions is the
//! protocol's `global("voice")` scope (queue of one), not a queue here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};

use super::language::{detect_device_language, normalize_whisper_language};
use super::runtime::{RuntimeManifest, VoiceRuntime, VoiceRuntimeInfo, resolve_voice_runtime, voice_runtime_info};
use crate::lane::on_lane;
use super::single_flight::SingleFlight;
use super::wav::{ONSET_SILENCE_SECONDS, prepend_wav_silence};

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
    async fn convert_to_wav(
        &self,
        ffmpeg: &Path,
        audio: &Path,
        wav: &Path,
        sample_rate: u32,
        channels: u32,
        threads: usize,
    ) -> Result<(), VoiceError>;

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
            converting: SingleFlight::default(),
            lane,
        }
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
    pub async fn runtime(&self) -> VoiceRuntime {
        let (dir, manifest) = (self.data_dir.clone(), self.manifest.clone());
        let unresolved = VoiceRuntime::absent(&self.manifest);
        on_lane(self.lane, move || resolve_voice_runtime(&dir, &manifest)).await.unwrap_or(unresolved)
    }

    /// [`voice_runtime_info`] for `runtime`, read on the lane.
    pub async fn runtime_info(&self, runtime: &VoiceRuntime) -> VoiceRuntimeInfo {
        let (runtime, manifest) = (runtime.clone(), self.manifest.clone());
        on_lane(self.lane, move || voice_runtime_info(&runtime, &manifest)).await.unwrap_or_default()
    }

    async fn contract(&self, settings: &VoiceSettings) -> Result<(VoiceRuntime, ServerContract), VoiceError> {
        let runtime = self.runtime().await;
        if !runtime.installed {
            let missing: Vec<&str> = [
                (runtime.binary, "binary"),
                (runtime.model, "model"),
                (runtime.ffmpeg, "ffmpeg"),
            ]
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
                    let vars = [
                        env("MIXDOG_CHANNELS_WHISPER_LANGUAGE"),
                        env("LC_ALL"),
                        env("LC_MESSAGES"),
                        env("LANG"),
                    ];
                    detect_device_language(vars.iter().map(Option::as_deref))
                })
                .clone()
        })
    }

    /// `Ok(None)` is a skipped file (over a gate) or a legitimately empty transcript; every real
    /// failure is an error so the caller can retry and mark the failure.
    pub async fn transcribe(&self, audio: &Path, attachment_id: Option<&str>) -> Result<Option<String>, VoiceError> {
        let settings = self.settings();
        let max_bytes = settings.max_file_size_mb * 1024.0 * 1024.0;
        if max_bytes > 0.0 {
            let path = audio.to_owned();
            if let Ok(Some(size)) = on_lane(self.lane, move || file_size(&path)).await {
                if size as f64 > max_bytes {
                    return Ok(None);
                }
            }
        }
        if settings.max_duration_sec > 0.0 {
            if let Some(duration) = self.tools.probe_duration_sec(audio).await {
                if duration > settings.max_duration_sec {
                    return Ok(None);
                }
            }
        }
        let Some(id) = attachment_id else {
            return self.transcribe_uncached(audio, None).await;
        };
        if let Some(text) = self.transcripts.lock().unwrap().get(id).cloned() {
            return Ok(Some(text));
        }
        self.transcribing.run(id, self.transcribe_uncached(audio, Some(id))).await
    }

    async fn transcribe_uncached(&self, audio: &Path, attachment_id: Option<&str>) -> Result<Option<String>, VoiceError> {
        let settings = self.settings();
        let (runtime, contract) = self.contract(&settings).await?;
        let language = self.language(&settings);
        let wav = self.ensure_wav(audio, attachment_id, &runtime, &settings).await?;
        self.engine.ensure_ready(&contract).await?;
        let text = self.engine.transcribe(&wav, Some(&language)).await?;
        let text = mixdog_js::js_trim(&text);
        if text.is_empty() {
            return Ok(None);
        }
        if let Some(id) = attachment_id {
            self.transcripts.lock().unwrap().insert(id.to_owned(), text.to_owned());
        }
        Ok(Some(text.to_owned()))
    }

    async fn ensure_wav(
        &self,
        audio: &Path,
        attachment_id: Option<&str>,
        runtime: &VoiceRuntime,
        settings: &VoiceSettings,
    ) -> Result<PathBuf, VoiceError> {
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
        self.converting
            .run(&key, async {
                self.tools
                    .convert_to_wav(&ffmpeg, audio, &wav, settings.sample_rate, settings.channels, threads)
                    .await?;
                let converted = wav.clone();
                on_lane(self.lane, move || pad_wav(&converted)).await.map_err(|e| VoiceError(e.to_string()))?
            })
            .await?;
        if let Some(id) = attachment_id {
            self.wav_by_attachment.lock().unwrap().insert(id.to_owned(), wav.clone());
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

    pub fn install(dir: &Path) {
        let put = |rel: &str, bytes: &[u8]| {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, bytes).unwrap();
        };
        put("voice-runtime/active-version", b"whisper-1.10.1-vulkan");
        put("voice-runtime/whisper-1.10.1-vulkan/Release/whisper-cli", b"x");
        put(&format!("voice-runtime/whisper-1.10.1-vulkan/Release/{SERVER_NAME}"), b"x");
        put("voice/models/ggml.bin", b"model");
        put("ffmpeg-runtime/active-version", b"ffmpeg-6");
        put("ffmpeg-runtime/ffmpeg-6/ffmpeg", b"x");
    }

    pub fn manifest() -> RuntimeManifest {
        RuntimeManifest {
            version: "1.10.1".into(),
            variants: vec![("vulkan".into(), "Release/whisper-cli".into())],
            model_id: "standard".into(),
            model_filename: "ggml.bin".into(),
            model_size: 5,
            ffmpeg_executable: Some("ffmpeg".into()),
        }
    }

    fn pipeline(dir: &Path, section: Value, tools: FakeTools, engine: FakeEngine) -> (VoicePipeline, Arc<FakeTools>, Arc<FakeEngine>) {
        let (tools, engine) = (Arc::new(tools), Arc::new(engine));
        let p = VoicePipeline::new(dir.to_owned(), manifest(), Arc::new(Fixed(section)), engine.clone(), tools.clone(), mixdog_rt::testing::tokens().durability_io);
        (p, tools, engine)
    }

    #[tokio::test]
    async fn missing_runtime_is_a_user_actionable_error_and_prepare_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let (p, _, engine) = pipeline(dir.path(), json!({}), FakeTools::default(), FakeEngine::default());
        let err = p.transcribe(&dir.path().join("a.ogg"), None).await.unwrap_err();
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
        let first = p.transcribe(&audio, Some("att")).await.unwrap();
        let second = p.transcribe(&audio, Some("att")).await.unwrap();
        assert_eq!((first.as_deref(), second.as_deref()), (Some("hello"), Some("hello")));
        assert_eq!(tools.converts.load(Ordering::SeqCst), 1);
        assert_eq!(engine.runs.load(Ordering::SeqCst), 1);
        assert_eq!(p.prepare_transcription().await, json!({"ready": true}));
    }

    #[tokio::test]
    async fn gates_skip_big_and_long_files_and_empty_transcript_is_none() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path());
        let audio = dir.path().join("a.ogg");
        std::fs::write(&audio, vec![0u8; 2 * 1024 * 1024]).unwrap();
        let (p, _, engine) = pipeline(dir.path(), json!({"transcription": {"maxFileSizeMB": 1}}), FakeTools::default(), FakeEngine::default());
        assert_eq!(p.transcribe(&audio, None).await.unwrap(), None);
        let (p, _, _) = pipeline(
            dir.path(),
            json!({"transcription": {"maxDurationSec": 10}}),
            FakeTools { duration: Some(11.0), ..Default::default() },
            FakeEngine::default(),
        );
        assert_eq!(p.transcribe(&audio, None).await.unwrap(), None);
        assert_eq!(engine.runs.load(Ordering::SeqCst), 0);
        let (p, _, engine) = pipeline(dir.path(), json!({}), FakeTools::default(), FakeEngine { text: "  ".into(), ..Default::default() });
        assert_eq!(p.transcribe(&audio, Some("e")).await.unwrap(), None);
        assert_eq!(engine.runs.load(Ordering::SeqCst), 1);
    }
}
