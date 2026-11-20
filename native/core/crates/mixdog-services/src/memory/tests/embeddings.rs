//! Embedding goldens recorded from the Node product (`fixtures/tools/memory/embeddings`):
//! token ids must match exactly, vectors to float precision. The model cache and
//! ONNX Runtime library come from `MIXDOG_MEMORY_MODELS` / `MIXDOG_ORT_LIBRARY`.

use std::path::PathBuf;

use crate::memory::embed::config::{self, InputType};
use crate::memory::embed::engine::{EmbedConfig, Embedder};

/// `scripts/verify-embedding-runtime.mjs` on the Rust core: the shipped model is installed the way the core installs it
/// (from the hub, into an empty cache), loaded through the memory service's embedder, and embeds the probe string.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs the staged ONNX Runtime (MIXDOG_ORT_LIBRARY) and network access to the model hub"]
async fn the_shipped_model_installs_and_embeds_a_probe_string() {
    let cache = tempfile::tempdir().expect("cache");
    let config = EmbedConfig {
        model_id: config::DEFAULT_MODEL_ID.to_owned(),
        cache_dir: cache.path().to_path_buf(),
        ort_library: PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY names onnxruntime")),
        dtype: None,
        sessions: 1,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    };
    assert!(Embedder::load(config.clone()).await.is_err(), "an empty cache has no model to load");
    crate::memory::embed::install::install(&config, crate::memory::embed::install::HUB, None, &tokio_util::sync::CancellationToken::new())
        .await
        .expect("the model installs");
    let embedder = Embedder::load(config).await.expect("the installed model loads");
    let vector = embedder.embed("Mixdog embedding runtime warmup verification", InputType::Document).await.expect("embeds");
    assert_eq!(Some(vector.len()), config::known_dims(config::DEFAULT_MODEL_ID), "the model's dimensions");
    assert!(vector.iter().all(|value| value.is_finite()) && vector.iter().any(|value| *value != 0.0), "a real vector");
}
