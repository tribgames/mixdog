//! Embedding goldens recorded from the Node product (`fixtures/tools/memory/embeddings`):
//! token ids must match exactly, vectors to float precision. The model cache and
//! ONNX Runtime library come from `MIXDOG_MEMORY_MODELS` / `MIXDOG_ORT_LIBRARY`.

use std::path::PathBuf;

use serde_json::Value;

use crate::memory::embed::config::{self, InputType, MAX_TEXT_UNITS};
use crate::memory::embed::engine::{EmbedConfig, Embedder};
use crate::memory::embed::tokenizer::UnigramTokenizer;

const GOLDEN: &str = include_str!("../../../../../fixtures/tools/memory/embeddings/golden.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden parses")
}

fn model_dir() -> (PathBuf, String) {
    let cache = PathBuf::from(std::env::var_os("MIXDOG_MEMORY_MODELS").expect("MIXDOG_MEMORY_MODELS names the model cache"));
    (cache, config::DEFAULT_MODEL_ID.to_owned())
}

fn input_type(case: &Value) -> InputType {
    InputType::parse(case["inputType"].as_str())
}

fn prepared(case: &Value) -> String {
    config::prepare_input(case["text"].as_str().unwrap_or_default(), input_type(case), config::DEFAULT_MODEL_ID)
}

#[test]
fn profile_matches_recorded_artifacts() {
    let artifacts = &golden()["artifacts"];
    let id = config::DEFAULT_MODEL_ID;
    assert_eq!(artifacts["modelId"], id);
    assert_eq!(artifacts["graphFile"], config::graph_file(id, None));
    assert_eq!(artifacts["dims"].as_u64(), config::known_dims(id).map(|d| d as u64));
    assert_eq!(artifacts["dtype"], config::normalize_dtype(id, None));
    assert_eq!(artifacts["workerMaxChars"].as_u64(), Some(MAX_TEXT_UNITS as u64));
    assert_eq!(artifacts["pooling"], "mean");
    assert_eq!(config::pooling(id), config::Pooling::Mean);
    assert_eq!(config::normalize_dtype(id, Some("fp32")), "q8", "unsupported dtype falls back");
    assert_eq!(config::graph_file("Xenova/bge-m3", Some("q4")), "onnx/model_q4.onnx");
}

#[test]
fn preprocessing_matches_recorded_text() {
    for case in golden()["cases"].as_array().expect("cases") {
        let prepared = prepared(case);
        assert_eq!(prepared.encode_utf16().count() as u64, case["preparedLength"].as_u64().unwrap_or(0), "{case}");
        if let Some(expected) = case["prepared"].as_str() {
            assert_eq!(prepared, expected);
        }
    }
}

#[test]
fn tokenizer_ids_match_recorded_ids() {
    let (cache, id) = model_dir();
    let max_length = golden()["artifacts"]["modelMaxLength"].as_u64().expect("max length") as usize;
    let tokenizer = UnigramTokenizer::load(&cache.join(id).join("tokenizer.json"), max_length).expect("tokenizer loads");
    for case in golden()["cases"].as_array().expect("cases") {
        let prepared = prepared(case);
        if prepared.is_empty() {
            continue;
        }
        let expected: Vec<i64> = case["ids"].as_array().expect("ids").iter().filter_map(Value::as_i64).collect();
        assert_eq!(tokenizer.encode(&prepared), expected, "{}", case["text"].as_str().unwrap_or_default().chars().take(40).collect::<String>());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn vectors_match_recorded_vectors() {
    let (cache, model_id) = model_dir();
    let embedder = Embedder::load(EmbedConfig {
        model_id,
        cache_dir: cache,
        ort_library: PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY names onnxruntime")),
        dtype: None,
        sessions: 2,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    })
    .await
    .expect("embedder loads");
    for case in golden()["cases"].as_array().expect("cases") {
        let expected: Vec<f32> = case["vector"].as_array().expect("vector").iter().filter_map(|v| v.as_f64().map(|v| v as f32)).collect();
        let got = embedder.embed(case["text"].as_str().unwrap_or_default(), input_type(case)).await.expect("embeds");
        assert_eq!(got.len(), expected.len());
        let worst = got.iter().zip(&expected).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(worst < 2e-5, "max component error {worst} for {}", case["text"].as_str().unwrap_or_default().chars().take(40).collect::<String>());
    }
    let batch = embedder.embed_batch(&["alpha".into(), String::new()], InputType::Query).await.expect("batch");
    assert_eq!((batch[0].len(), batch[1].len()), (384, 0));
}
