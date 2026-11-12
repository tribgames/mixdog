//! Embedding model profiles: dimensions, dtype/graph file naming, pooling and
//! the input prefixes each model was trained with.

use mixdog_js::{js_trim, slice_utf16, utf16_len};

pub const DEFAULT_MODEL_ID: &str = "Xenova/multilingual-e5-small";

/// Upper bound on one text's length (UTF-16 code units) before tokenizing, so
/// an unbounded string never builds a huge tensor.
pub const MAX_TEXT_UNITS: usize = 8000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pooling {
    Mean,
    Cls,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputType {
    Query,
    Document,
}

impl InputType {
    /// Anything but `query` is a document.
    pub fn parse(value: Option<&str>) -> Self {
        if value.is_some_and(|v| js_trim(v).to_lowercase() == "query") { Self::Query } else { Self::Document }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ModelProfile {
    pub dims: usize,
    pub default_dtype: &'static str,
    pub default_device: &'static str,
    pub model_file_name: &'static str,
    pub pooling: Pooling,
    pub query_prefix: &'static str,
    pub document_prefix: &'static str,
    pub supported_dtypes: &'static [&'static str],
}

const PROFILES: [(&str, ModelProfile); 3] = [
    (
        DEFAULT_MODEL_ID,
        ModelProfile {
            dims: 384,
            default_dtype: "q8",
            default_device: "cpu",
            model_file_name: "model",
            pooling: Pooling::Mean,
            query_prefix: "query: ",
            document_prefix: "passage: ",
            supported_dtypes: &["q8"],
        },
    ),
    (
        "ibm-granite/granite-embedding-97m-multilingual-r2",
        ModelProfile {
            dims: 384,
            default_dtype: "fp32",
            default_device: "cpu",
            model_file_name: "model_quint8_avx2",
            pooling: Pooling::Cls,
            query_prefix: "",
            document_prefix: "",
            supported_dtypes: &["fp32"],
        },
    ),
    (
        "Xenova/bge-m3",
        ModelProfile {
            dims: 1024,
            default_dtype: "q4",
            default_device: "auto",
            model_file_name: "model",
            pooling: Pooling::Mean,
            query_prefix: "",
            document_prefix: "",
            supported_dtypes: &["fp32", "fp16", "q8", "q4"],
        },
    ),
];

/// The embedding settings Node reads from the environment (`embedding-model-config.mjs`):
/// `MIXDOG_EMBED_MODEL` and `MIXDOG_EMBED_DTYPE`, unset when absent.
#[derive(Debug, Clone, Default)]
pub struct EmbedEnv {
    pub model: Option<String>,
    pub dtype: Option<String>,
}

impl EmbedEnv {
    pub fn from_process() -> Self {
        Self { model: std::env::var("MIXDOG_EMBED_MODEL").ok(), dtype: std::env::var("MIXDOG_EMBED_DTYPE").ok() }
    }

    /// `getConfiguredEmbeddingModelId`: the trimmed model setting, else the default model.
    pub fn model_id(&self) -> String {
        let model = js_trim(self.model.as_deref().unwrap_or_default());
        if model.is_empty() { DEFAULT_MODEL_ID.to_owned() } else { model.to_owned() }
    }

    /// `getDefaultEmbeddingDtype`: the dtype setting when `model_id` supports it, else its default.
    pub fn dtype(&self, model_id: &str) -> String {
        normalize_dtype(model_id, self.dtype.as_deref())
    }
}

/// `getDefaultEmbeddingDevice`: the profile's device, `auto` for a model without one.
pub fn default_device(model_id: &str) -> &'static str {
    profile(model_id).map_or("auto", |p| p.default_device)
}

/// `getEmbeddingOutputName`: no profile names an output, so the graph's first output is read.
pub fn output_name(_model_id: &str) -> &'static str {
    ""
}

pub fn profile(model_id: &str) -> Option<&'static ModelProfile> {
    PROFILES.iter().find(|(id, _)| *id == js_trim(model_id)).map(|(_, profile)| profile)
}

pub fn known_dims(model_id: &str) -> Option<usize> {
    profile(model_id).map(|p| p.dims)
}

/// The `metaKey` Node's memory start stores as `embedding.current_model`
/// (`index.mjs` `_initStore`): vectors made under another identity are dropped.
/// `provider` is the main config's `embedding.provider`, null when unset.
pub fn identity(provider: Option<&str>, model_id: &str, dtype: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "provider": provider,
        "model": model_id,
        "dtype": normalize_dtype(model_id, dtype),
        "format": "mixdog-embedding-v3",
    })
}

/// The requested dtype when the model supports it, else the model's default.
pub fn normalize_dtype(model_id: &str, dtype: Option<&str>) -> String {
    let profile = profile(model_id);
    let fallback = profile.map_or("fp32", |p| p.default_dtype);
    let requested = js_trim(dtype.unwrap_or_default()).to_lowercase();
    if requested.is_empty() {
        return fallback.to_owned();
    }
    let supported: &[&str] = profile.map_or(&["fp32", "fp16", "q8", "q4"], |p| p.supported_dtypes);
    let supported = supported.contains(&requested.as_str());
    if supported { requested } else { fallback.to_owned() }
}

/// Graph path inside the model directory: `onnx/<file name><dtype suffix>.onnx`.
pub fn graph_file(model_id: &str, dtype: Option<&str>) -> String {
    let resolved = normalize_dtype(model_id, dtype);
    let suffix = match resolved.as_str() {
        "fp16" => "_fp16",
        "q8" => "_quantized",
        "q4" => "_q4",
        _ => "",
    };
    format!("onnx/{}{suffix}.onnx", profile(model_id).map_or("model", |p| p.model_file_name))
}

pub fn pooling(model_id: &str) -> Pooling {
    profile(model_id).map_or(Pooling::Mean, |p| p.pooling)
}

/// The text a model embeds: trimmed, prefixed for its input type, cut to
/// `MAX_TEXT_UNITS`. Empty stays empty.
pub fn prepare_input(text: &str, input_type: InputType, model_id: &str) -> String {
    let clean = js_trim(text);
    if clean.is_empty() {
        return String::new();
    }
    let profile = profile(model_id);
    let prefix = match input_type {
        InputType::Query => profile.map_or("", |p| p.query_prefix),
        InputType::Document => profile.map_or("", |p| p.document_prefix),
    };
    let prepared = format!("{prefix}{clean}");
    if utf16_len(&prepared) > MAX_TEXT_UNITS { slice_utf16(&prepared, MAX_TEXT_UNITS) } else { prepared }
}
