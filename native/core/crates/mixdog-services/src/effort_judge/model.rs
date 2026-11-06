//! The effort-judge model: an 18-layer multilingual classifier (ONNX) that
//! rates a tool-result step on four levels. Files and calibration are read
//! from the same folder Node installs them in (`models/effort-judge`):
//! `model.onnx`, `tokenizer.json`, `calibration.json` (temperature, the token
//! budget and `steps: 1` when the model was trained on tool-result steps) and
//! the `install.json` stamp of a finished install.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mixdog_agent::step_effort::StepInput;
use mixdog_rt::CpuBulk;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

use crate::effort_judge::error::JudgeError;
use crate::lane::on_lane;
use crate::model_install::InstallError;
use crate::effort_judge::input::{InputFormat, TurnInput, pack_ids, step_judge_text, turn_text};
use crate::effort_judge::tokenizer::BpeTokenizer;
use crate::memory::embed::engine::ort_environment;
use crate::memory::embed::install::holds_data;

const DEFAULT_MAX_TOKENS: usize = 256;
/// One judgment runs at a time; four threads halve the long-input tail.
const INTRA_THREADS: usize = 4;
const MODEL_FILES: [&str; 2] = ["model.onnx", "tokenizer.json"];

#[derive(Debug, Clone)]
pub struct ModelConfig {
    pub dir: PathBuf,
    /// The folder was named explicitly (`MIXDOG_EFFORT_JUDGE_DIR`): it is used
    /// as it is, without an install stamp.
    pub explicit: bool,
    /// The ONNX Runtime shared library the embeddings also use, or that this platform has none.
    pub ort_library: OrtRuntime,
}

/// The runtime the judge loads. `NoBinding` is the platform onnxruntime ships no binding for (macOS Intel,
/// where Node's `onnxRuntimeSupported()` is false): the judge then answers unsupported and never loads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrtRuntime {
    Library(PathBuf),
    NoBinding,
}

impl ModelConfig {
    /// `onnxRuntimeSupported()` for this configuration: the platform has a binding and the library is known.
    pub fn runtime_supported(&self) -> bool {
        crate::tool_state::onnx_runtime_supported() && matches!(self.ort_library, OrtRuntime::Library(_))
    }

    /// The default folder under a data directory.
    pub fn in_data_dir(data_dir: &Path, ort_library: OrtRuntime) -> Self {
        Self { dir: data_dir.join("models").join("effort-judge"), explicit: false, ort_library }
    }
}

#[allow(clippy::disallowed_methods, reason = "a lane-job body, reached through `available`")]
fn stamped(dir: &Path) -> bool {
    let Ok(bytes) = std::fs::read(dir.join("install.json")) else { return false };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|json| json["release"].as_str().map(|release| !release.is_empty()))
        .unwrap_or(false)
}

/// Whether the model is installed: both files hold data, and a release
/// install is stamped.
///
/// Reads files: a lane-job body. Async callers use [`available_on`]; the host's info reader
/// runs it as a read-lane job.
pub fn available(config: &ModelConfig) -> bool {
    MODEL_FILES.iter().all(|file| holds_data(&config.dir.join(file))) && (config.explicit || stamped(&config.dir))
}

/// [`available`] as a job on `lane`.
pub async fn available_on(lane: CpuBulk, config: &ModelConfig) -> Result<bool, InstallError> {
    let config = config.clone();
    on_lane(lane, move || available(&config)).await.map_err(InstallError::io)
}

struct Calibration {
    temperature: f64,
    max_tokens: usize,
    steps: bool,
    input_format: InputFormat,
}

#[allow(clippy::disallowed_methods, reason = "runs inside the load job on the lane")]
fn calibration(dir: &Path) -> Calibration {
    let raw: serde_json::Value =
        std::fs::read(dir.join("calibration.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let temperature = raw["temperature"].as_f64().filter(|t| *t > 0.0).unwrap_or(1.0);
    let max_tokens = raw["maxTokens"].as_f64().filter(|n| *n > 2.0).map_or(DEFAULT_MAX_TOKENS, |n| n as usize);
    let input_format = InputFormat::named(raw["inputFormat"].as_str().unwrap_or_default());
    Calibration { temperature, max_tokens, steps: raw["steps"].as_f64() == Some(1.0), input_format }
}

/// `effortJudgeSupportsSteps`: whether `calibration.json` in `dir` says `steps: 1`.
/// A missing or unreadable file is `false`.
pub async fn steps_in(lane: CpuBulk, dir: &Path) -> Result<bool, InstallError> {
    let dir = dir.to_owned();
    on_lane(lane, move || calibration(&dir).steps).await.map_err(InstallError::io)
}

pub struct JudgeModel {
    tokenizer: BpeTokenizer,
    session: Mutex<Session>,
    temperature: f64,
    max_tokens: usize,
    steps: bool,
    input_format: InputFormat,
}

fn run_error(error: impl std::fmt::Display) -> JudgeError {
    JudgeError::Run(error.to_string())
}

impl JudgeModel {
    /// Loads the tokenizer and session, then runs one warm-up judgment: the
    /// first run allocates buffers and is several times slower than the rest.
    #[allow(clippy::disallowed_methods, reason = "a lane-job body: `ensure_loaded` runs it on the lane")]
    pub fn load(config: &ModelConfig) -> Result<Self, JudgeError> {
        let OrtRuntime::Library(library) = &config.ort_library else { return Err(JudgeError::Unsupported) };
        if !available(config) {
            return Err(JudgeError::NotInstalled(config.dir.display().to_string()));
        }
        let tokenizer = BpeTokenizer::load(&config.dir.join("tokenizer.json"))?;
        let environment = ort_environment(library).map_err(|e| JudgeError::Load(e.message()))?;
        let session = (|| -> ort::Result<Session> {
            let mut builder = Session::builder(environment)?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_intra_threads(INTRA_THREADS)?;
            builder.commit_from_file(config.dir.join("model.onnx"))
        })()
        .map_err(|e| JudgeError::Load(format!("onnxruntime session: {e}")))?;
        let settings = calibration(&config.dir);
        let model = Self {
            tokenizer,
            session: Mutex::new(session),
            temperature: settings.temperature,
            max_tokens: settings.max_tokens,
            steps: settings.steps,
            input_format: settings.input_format,
        };
        let warm = model.turn_ids(&TurnInput { request: "warm up".into(), ..TurnInput::default() });
        model.run(&warm).map_err(|e| JudgeError::Load(e.to_string()))?;
        Ok(model)
    }

    fn ids_of_text(&self, text: &str) -> Vec<i64> {
        let (prefix, suffix) = (&self.tokenizer.prefix, &self.tokenizer.suffix);
        let room = self.max_tokens.saturating_sub(prefix.len() + suffix.len());
        let body = self.tokenizer.encode(text);
        prefix.iter().copied().chain(body.into_iter().take(room)).chain(suffix.iter().copied()).map(i64::from).collect()
    }

    /// `<bos> step text <eos>` for one step, cut to the token budget.
    pub fn step_ids(&self, input: &StepInput) -> Vec<i64> {
        self.ids_of_text(&step_judge_text(input))
    }

    /// `<bos> turn text <eos>` in the layout the model was trained on, cut to the token budget.
    pub fn turn_ids(&self, input: &TurnInput) -> Vec<i64> {
        if self.input_format == InputFormat::Pack {
            return pack_ids(&self.tokenizer, input, self.max_tokens).into_iter().map(i64::from).collect();
        }
        self.ids_of_text(&turn_text(self.input_format, input))
    }

    /// Calibrated probabilities over the four levels for a turn (`inputs` are already clipped).
    pub fn turn_probs(&self, input: &TurnInput) -> Result<Vec<f64>, JudgeError> {
        self.run(&self.turn_ids(input))
    }

    fn run(&self, ids: &[i64]) -> Result<Vec<f64>, JudgeError> {
        let shape = [1usize, ids.len()];
        let tensor = |values: Vec<i64>| Tensor::from_array((shape, values)).map_err(run_error);
        let feeds = vec![
            ("input_ids", tensor(ids.to_vec())?.into_dyn()),
            ("attention_mask", tensor(vec![1; ids.len()])?.into_dyn()),
        ];
        let mut session = self.session.lock().map_err(|_| JudgeError::Run("session poisoned".into()))?;
        let outputs = session.run(feeds).map_err(run_error)?;
        let (_, logits) = outputs["logits"].try_extract_tensor::<f32>().map_err(run_error)?;
        let scaled: Vec<f64> = logits.iter().map(|value| f64::from(*value) / self.temperature).collect();
        let top = scaled.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let exp: Vec<f64> = scaled.iter().map(|value| (value - top).exp()).collect();
        let sum: f64 = exp.iter().sum();
        Ok(exp.into_iter().map(|value| value / sum).collect())
    }

    /// Calibrated probabilities over the four levels for one step.
    pub fn probs(&self, input: &StepInput) -> Result<Vec<f64>, JudgeError> {
        if !self.steps {
            return Err(JudgeError::StepsUnsupported);
        }
        self.run(&self.step_ids(input))
    }
}
