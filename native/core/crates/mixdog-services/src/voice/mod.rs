//! Voice: managed whisper.cpp + ffmpeg runtime, transcription pipeline, `voice/` service.

pub mod language;
pub mod pipeline;
pub mod runtime;
pub mod service;
pub mod setup;
pub mod setup_action;
pub mod single_flight;
pub mod wav;
pub mod whisper_server;

pub use pipeline::{AudioTools, ServerContract, VoiceError, VoicePipeline, VoiceSettings, VoiceSettingsSource, WhisperEngine};
pub use runtime::{RuntimeManifest, VoiceRuntime, resolve_voice_runtime, voice_runtime_info};
pub use service::VoiceService;
pub use setup_action::{set_voice_enabled, voice_feature_status};
pub use setup::{Missing, ToggleResult, VoiceEnabledStore, VoiceInstaller, VoiceSetup};
pub use whisper_server::{ProcessAudioTools, WhisperServer};
