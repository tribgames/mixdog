//! The `toolModules` section value: exactly what Node's `getToolModuleSettings()` answers
//! (`session-runtime/settings-builtin-tools-api.mjs`), typed. Wire names are Node's keys.
//! Where Node writes `null` the field is `T | null`; where Node leaves the key out it is
//! optional.

use serde::Deserialize;
use serde::Serialize;

use crate::Section;
use crate::SectionName;

/// Node leaves some keys out and writes `null` for others; `Some(None)` is the written `null`,
/// `None` the missing key.
fn null_or_value<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum InstructionFilesMode {
    All,
    Agents,
    Claude,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AutoEffortBase {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct EnabledModule {
    pub enabled: bool,
}

/// A module with a separate install step (`git`, `office`, `tidy`, `visualize`, `media`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct InstallableModule {
    pub enabled: bool,
    pub installed: bool,
}

/// The embedding model behind the memory module (`getEmbeddingInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct EmbeddingInfo {
    pub model: String,
    pub dtype: Option<String>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub dimensions: Option<u32>,
    /// Empty until the model is loaded.
    pub device: String,
    pub engine: String,
    pub supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MemoryModule {
    pub enabled: bool,
    pub installed: bool,
    pub info: EmbeddingInfo,
    pub semantic_search_supported: bool,
}

/// The auto-effort judge model card (`effortJudgeInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EffortJudgeInfo {
    pub model: String,
    pub quantization: String,
    pub engine: String,
    pub device: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub model_bytes: u64,
    pub ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AutoEffortModule {
    pub supported: bool,
    pub enabled: bool,
    /// The judge model is on disk.
    pub installed: bool,
    /// A download is in flight, including the boot download the settings did not start.
    pub installing: bool,
    pub ready: bool,
    /// Why the judge last failed to load; empty when it loaded or never failed.
    pub last_error: String,
    pub info: EffortJudgeInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub enum GpuVendor {
    #[serde(rename = "NVIDIA")]
    Nvidia,
    #[serde(rename = "Apple")]
    Apple,
}

/// One GPU. An Apple GPU reports its name and shared memory only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct LocalGpu {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    pub vendor: GpuVendor,
    pub name: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub memory_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub free_memory_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalHardware {
    pub platform: String,
    pub arch: String,
    pub gpu: Option<LocalGpu>,
    pub gpus: Vec<LocalGpu>,
    pub supported: bool,
    /// Detection still running.
    pub checking: bool,
    /// Epoch ms of the last completed detection.
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub checked_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntime {
    pub installed: bool,
    pub version: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub download_bytes: u64,
    pub source: String,
    pub license: String,
    /// Empty on an unsupported platform.
    pub backend: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalDisk {
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub available_bytes: Option<u64>,
}

/// What the running server reported when a model loaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalModelCapabilities {
    /// Tool support: `null` when the template does not say.
    pub tools: Option<bool>,
    pub images: bool,
    pub audio: bool,
    pub video: bool,
    pub reasoning_settings: bool,
}

/// An ended request: every member is present, `null` when the request did not measure it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalInferenceEnd {
    /// ISO time the request ended.
    pub at: String,
    pub queue_wait_ms: f64,
    pub duration_ms: f64,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub first_response_ms: Option<f64>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub output_tokens: Option<u64>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub input_tokens: Option<u64>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub tokens_per_second: Option<f64>,
    pub error: Option<String>,
}

/// The model's latest request. A `running` one carries `queueWaitMs` only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LocalInference {
    #[serde(rename_all = "camelCase")]
    Running { queue_wait_ms: f64 },
    Complete(LocalInferenceEnd),
    Failed(LocalInferenceEnd),
}

/// The last integrity check of the model file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalVerification {
    pub valid: bool,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size_bytes: u64,
    pub sha256: String,
    /// ISO time of the check.
    pub at: String,
}

/// One catalog model (Node's `publicModel`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct LocalModel {
    pub id: String,
    pub name: String,
    pub description: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub remaining_download_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub estimated_vram_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub minimum_vram_bytes: u64,
    /// The user's context size; `null` runs the default.
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub configured_context_window: Option<u32>,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub default_context_window: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub min_context_window: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_context_window: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub context_window: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub runtime_context_window: u32,
    pub supports_function_calling: Option<bool>,
    pub supports_reasoning: Option<bool>,
    pub supports_images: bool,
    pub supports_reasoning_settings: bool,
    pub architecture: Option<String>,
    pub compatibility: String,
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<LocalModelCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "null_or_value")]
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub load_time_ms: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inference: Option<LocalInference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<LocalVerification>,
    pub license: String,
    pub source: String,
    pub recommended: bool,
    /// The GPU has the model's minimum VRAM.
    pub compatible: bool,
    /// The weights file is complete.
    pub installed: bool,
    /// Some file exists, complete or partial.
    pub present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LocalInstallPhase {
    Runtime,
    Model,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LocalInstallState {
    Running,
    Failed,
    Paused,
    Complete,
}

/// A live installation job, or a paused partial download found on disk (no `jobId`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct LocalInstallation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub phase: LocalInstallPhase,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "null_or_value")]
    pub model_id: Option<Option<String>>,
    pub state: LocalInstallState,
    /// `preparing`, `verifying`, `paused`, `complete`, or a download stage.
    pub stage: String,
    /// `null` while unknown.
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub updated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "null_or_value")]
    pub error: Option<Option<String>>,
    /// Paused partial downloads only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub received_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub total_bytes: Option<u64>,
}

/// How the last server process ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalServerExit {
    /// ISO time.
    pub at: String,
    pub model_id: String,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    /// The stop was asked for.
    pub expected: bool,
    /// Redacted tail of the server log.
    pub log: String,
}

/// The `localProvider` module: catalog status, server and queue status, installations and the
/// switches, flattened as Node merges them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalProviderModule {
    pub platform_supported: bool,
    pub available: bool,
    pub runtime: LocalRuntime,
    pub hardware: LocalHardware,
    pub disk: LocalDisk,
    pub models: Vec<LocalModel>,
    pub recommendation: Option<LocalModel>,
    pub running: bool,
    pub starting: bool,
    pub active_model: Option<String>,
    pub gpu: Option<LocalGpu>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub load_time_ms: Option<f64>,
    pub last_exit: Option<LocalServerExit>,
    pub last_error: Option<String>,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub active_requests: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub queued_requests: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub idle_ttl_seconds: u32,
    /// Epoch ms the idle server unloads, while armed.
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub idle_deadline: Option<i64>,
    pub last_unload_error: Option<String>,
    pub installations: Vec<LocalInstallation>,
    /// The last installation command's failure, until the next command.
    pub installation_command_error: Option<String>,
    pub enabled: bool,
    /// The runtime is installed and the module is installed.
    pub installed: bool,
}

/// Value of the `toolModules` section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ToolModuleSettings {
    pub instruction_files: InstructionFilesMode,
    pub auto_effort_base: AutoEffortBase,
    pub web_search: EnabledModule,
    pub memory: MemoryModule,
    pub git: InstallableModule,
    pub office: InstallableModule,
    pub tidy: InstallableModule,
    pub visualize: InstallableModule,
    pub media: InstallableModule,
    pub local_provider: LocalProviderModule,
    pub auto_effort: AutoEffortModule,
}

impl Section for ToolModuleSettings {
    const NAME: SectionName = SectionName::ToolModules;
    type Value = ToolModuleSettings;
}