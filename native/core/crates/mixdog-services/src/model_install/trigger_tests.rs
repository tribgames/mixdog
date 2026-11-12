//! When the judge and the embedder fetch, load and repair: the first judged
//! step's refresh, the one repair per load failure until files are replaced,
//! the prewarm skip rules, and the memory runtime's gates and warmups. Files
//! come from a local HTTP server; the background work is awaited through the
//! state tick the product publishes, never through sleeps.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_agent::step_effort::StepInput;
use tokio_util::sync::CancellationToken;

use super::tests::{Route, Server, big, config, embed_config_with, manifest, real_ort};
use crate::effort_judge::error::JudgeError;
use crate::effort_judge::install::{self, Manifest};
use crate::effort_judge::judge::JudgeOptions;
use crate::effort_judge::EffortJudgeModel;
use crate::memory::embed::config::DEFAULT_MODEL_ID;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::recall::QueryEmbedder;
use crate::memory::runtime::{MemoryRuntime, RuntimeFlags, WarmupReply};
use crate::model_install::InstallError;
use crate::tool_state::{StateTick, onnx_runtime_supported};

fn step() -> StepInput {
    StepInput { request: "fix the failing build".into(), step: 1, plan: String::new(), calls: Vec::new() }
}

/// Waits for `done`, re-checked after every tick. A condition that never comes
/// fails the test instead of hanging it.
async fn until(tick: &StateTick, mut done: impl FnMut() -> bool) {
    let mut changes = tick.subscribe();
    while !done() {
        changes.changed().await.expect("tick lives");
    }
}

/// Lets queued background work run so a trigger that must NOT fire has had its chance.
async fn settle() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}

struct Files {
    model: Vec<u8>,
    tokenizer: Vec<u8>,
}

impl Files {
    fn new() -> Self {
        Self { model: big(1, 300_000), tokenizer: big(2, 40_000) }
    }

    async fn serve(&self) -> Server {
        Server::start(vec![("/model.onnx", Route::Body(self.model.clone())), ("/tokenizer.json", Route::Body(self.tokenizer.clone()))])
            .await
    }

    fn manifest(&self, server: &Server, release: &str) -> Manifest {
        manifest(server, release, &[("model.onnx", &self.model), ("tokenizer.json", &self.tokenizer)])
    }
}

/// A judge over a runtime library that does not exist, so every load fails.
fn judge(dir: &Path, manifest: &Manifest, tick: &StateTick, explicit: bool) -> Arc<EffortJudgeModel> {
    judge_over(dir, manifest, tick, explicit, PathBuf::from("unused"))
}

fn judge_over(dir: &Path, manifest: &Manifest, tick: &StateTick, explicit: bool, ort_library: PathBuf) -> Arc<EffortJudgeModel> {
    let mut model = config(dir);
    model.explicit = explicit;
    model.ort_library = crate::effort_judge::model::OrtRuntime::Library(ort_library);
    EffortJudgeModel::with_options(model, crate::effort_judge::JudgeLanes::of(&mixdog_rt::testing::tokens()), JudgeOptions { tick: tick.clone(), manifest: Some(manifest.clone()), ..JudgeOptions::default() })
        .expect("judge")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_judged_step_refreshes_a_model_that_is_not_the_current_release_once() {
    let files = Files::new();
    let server = files.serve().await;
    let release = files.manifest(&server, "r1");
    let dir = tempfile::tempdir().expect("dir");
    let tick = StateTick::default();
    let model = judge(dir.path(), &release, &tick, false);

    assert!(!model.is_available());
    assert!(model.probs(step()).await.is_err(), "the step does not wait for the download");
    until(&tick, || install::install_current(dir.path(), &release) && !model.is_installing()).await;
    assert_eq!((server.hits("/model.onnx"), server.hits("/tokenizer.json")), (1, 1));

    // Later steps do not look again, and the unloadable bytes do not fetch more.
    for _ in 0..2 {
        assert!(model.probs(step()).await.is_err());
    }
    settle().await;
    assert_eq!(server.hits("/model.onnx"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_refresh_for_an_explicit_dir_or_an_install_that_is_already_current() {
    let files = Files::new();
    let server = files.serve().await;
    let release = files.manifest(&server, "r1");

    let explicit_dir = tempfile::tempdir().expect("dir");
    let explicit = judge(explicit_dir.path(), &release, &StateTick::default(), true);
    assert!(matches!(explicit.probs(step()).await, Err(JudgeError::NotInstalled(_))));
    settle().await;
    assert_eq!(server.hits("/model.onnx"), 0, "an explicit dir is checked, never installed");

    let dir = tempfile::tempdir().expect("dir");
    let installer = judge(dir.path(), &release, &StateTick::default(), false);
    installer.install(&release, None, &CancellationToken::new()).await.expect("installs");
    assert_eq!(server.hits("/model.onnx"), 1);
    let fresh = judge(dir.path(), &release, &StateTick::default(), false);
    assert!(fresh.probs(step()).await.is_err(), "the bytes are not a model");
    settle().await;
    assert_eq!((server.hits("/model.onnx"), server.hits("/tokenizer.json")), (1, 1), "a current install fetches nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_load_failure_repairs_only_damaged_files_and_only_once_until_files_are_replaced() {
    let files = Files::new();
    let server = files.serve().await;
    let release = files.manifest(&server, "r1");
    let dir = tempfile::tempdir().expect("dir");
    let installer = judge(dir.path(), &release, &StateTick::default(), false);
    installer.install(&release, None, &CancellationToken::new()).await.expect("installs");

    // Files match the manifest but cannot load: nothing is damaged, so nothing is fetched,
    // however often the remembered failure answers.
    let tick = StateTick::default();
    let healthy = judge(dir.path(), &release, &tick, false);
    for _ in 0..3 {
        let error = healthy.probs(step()).await.expect_err("cannot load");
        assert!(matches!(error, JudgeError::Load(_)), "{error}");
    }
    settle().await;
    assert!(!healthy.last_error().is_empty());
    assert_eq!((server.hits("/model.onnx"), server.hits("/tokenizer.json")), (1, 1));

    // A zeroed tail: same size, wrong hash. Only that file is fetched. The damage goes to a
    // copy, so the healthy instance's own background verification cannot race it.
    let healthy_dir = dir;
    let dir = tempfile::tempdir().expect("dir");
    for entry in std::fs::read_dir(healthy_dir.path()).expect("list") {
        let entry = entry.expect("entry");
        std::fs::copy(entry.path(), dir.path().join(entry.file_name())).expect("copy");
    }
    let damage = |bytes: &[u8]| {
        let mut bad = bytes.to_vec();
        let len = bad.len();
        bad[len - 64..].fill(0);
        std::fs::write(dir.path().join("model.onnx"), bad).expect("damage");
    };
    let restored = || std::fs::read(dir.path().join("model.onnx")).is_ok_and(|bytes| bytes == files.model);
    damage(&files.model);
    let damaged = judge(dir.path(), &release, &tick, false);
    let first = damaged.probs(step()).await;
    assert!(matches!(first, Err(JudgeError::Load(_))), "{first:?}");
    until(&tick, || server.hits("/model.onnx") == 2 && restored() && !damaged.is_installing()).await;
    assert_eq!(server.hits("/tokenizer.json"), 1, "the intact file stays");

    // The files were replaced, so the next failure may repair again.
    damage(&files.model);
    assert!(matches!(damaged.probs(step()).await, Err(JudgeError::Load(_))));
    until(&tick, || server.hits("/model.onnx") == 3 && restored() && !damaged.is_installing()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn prewarm_skips_while_installing_when_not_installed_and_after_a_load_failure() {
    let files = Files::new();
    let tick = StateTick::default();

    // Not installed.
    let server = files.serve().await;
    let release = files.manifest(&server, "r1");
    let empty = tempfile::tempdir().expect("dir");
    let model = judge(empty.path(), &release, &tick, true);
    assert!(!model.prewarm().await);

    // An install in flight: judgments answer at once, a second install is refused.
    let stalled = Server::start(vec![("/model.onnx", Route::Stall), ("/tokenizer.json", Route::Body(files.tokenizer.clone()))]).await;
    let stalled_release = files.manifest(&stalled, "r1");
    let dir = tempfile::tempdir().expect("dir");
    let installing = judge(dir.path(), &stalled_release, &tick, false);
    let cancel = CancellationToken::new();
    let running = tokio::spawn({
        let (model, release, cancel) = (installing.clone(), stalled_release.clone(), cancel.clone());
        async move { model.install(&release, None, &cancel).await }
    });
    until(&tick, || installing.is_installing()).await;
    assert!(!installing.prewarm().await);
    assert!(matches!(installing.probs(step()).await, Err(JudgeError::Installing)));
    assert!(matches!(installing.install(&stalled_release, None, &CancellationToken::new()).await, Err(InstallError::Busy)));
    cancel.cancel();
    assert!(running.await.expect("joins").is_err(), "a cancelled install fails");
    assert!(!installing.is_installing());

    // Installed but unloadable: the load starts, fails, and is not started again.
    let loadable = tempfile::tempdir().expect("dir");
    let broken = judge(loadable.path(), &release, &tick, false);
    broken.install(&release, None, &CancellationToken::new()).await.expect("installs");
    assert!(broken.prewarm().await, "the load starts in the background");
    until(&tick, || !broken.last_error().is_empty()).await;
    assert!(!broken.prewarm().await, "a remembered failure is not retried");
    assert!(!broken.status().ready);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: loads the real judge; needs MIXDOG_EFFORT_JUDGE_DIR and the staged ONNX Runtime (MIXDOG_ORT_LIBRARY)"]
async fn prewarm_loads_the_real_model_ahead_of_the_first_step_and_shutdown_unloads_it() {
    let dir = PathBuf::from(std::env::var_os("MIXDOG_EFFORT_JUDGE_DIR").expect("MIXDOG_EFFORT_JUDGE_DIR"));
    let files = Files::new();
    let server = files.serve().await;
    let tick = StateTick::default();
    let model = judge_over(&dir, &files.manifest(&server, "r1"), &tick, true, real_ort());

    assert!(model.prewarm().await);
    until(&tick, || model.is_ready()).await;
    assert!(model.prewarm().await, "loaded");
    model.shutdown().await;
    assert!(!model.is_ready());
    assert!(model.prewarm().await, "a shut-down model loads again");
    until(&tick, || model.is_ready()).await;
    assert_eq!(server.hits("/model.onnx"), 0);
}

async fn e5_server() -> Server {
    let source = PathBuf::from(std::env::var_os("MIXDOG_MEMORY_MODELS").expect("MIXDOG_MEMORY_MODELS"))
        .join("Xenova")
        .join("multilingual-e5-small");
    let id = DEFAULT_MODEL_ID;
    Server::start(vec![
        (&format!("/{id}/resolve/main/tokenizer.json"), Route::File(source.join("tokenizer.json"))),
        (&format!("/{id}/resolve/main/tokenizer_config.json"), Route::File(source.join("tokenizer_config.json"))),
        (&format!("/{id}/resolve/main/onnx/model_quantized.onnx"), Route::File(source.join("onnx").join("model_quantized.onnx"))),
    ])
    .await
}

fn runtime(server: &Server, cache: &Path, flags: RuntimeFlags, tick: &StateTick) -> (Arc<MemoryRuntime>, Arc<EmbeddingProvider>) {
    runtime_over(server, cache, flags, tick, PathBuf::from("unused"))
}

fn runtime_over(
    server: &Server,
    cache: &Path,
    flags: RuntimeFlags,
    tick: &StateTick,
    ort_library: PathBuf,
) -> (Arc<MemoryRuntime>, Arc<EmbeddingProvider>) {
    let embedder = Arc::new(EmbeddingProvider::with_tick(embed_config_with(cache, ort_library), tick.clone()).with_hub(server.base.clone()));
    (MemoryRuntime::new(embedder.clone(), flags, None), embedder)
}

fn fetches(server: &Server) -> usize {
    server.hits(&format!("/{DEFAULT_MODEL_ID}/resolve/main/tokenizer.json"))
}

/// Node's real `ensureStandaloneEnvironment` run over each starting `MIXDOG_EMBED_WARMUP`, then the real `embeddingWarmupCanStart` /
/// `embeddingOnDemandCanStart` (`fixtures/standalone-defaults`, `record-standalone-defaults.mjs`).
#[test]
fn a_standalone_start_gates_the_warmup_as_nodes_does() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/standalone-defaults/twin.json");
    let twin: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let states = twin["warmup"].as_array().unwrap();
    assert_eq!(states.len(), 14);
    for state in states {
        let value = state["embedWarmup"].as_str().map(str::to_owned);
        let flags = RuntimeFlags::from_env(&|name| (name == "MIXDOG_EMBED_WARMUP").then(|| value.clone()).flatten());
        assert_eq!(onnx_runtime_supported(), state["onnxRuntimeSupported"], "{value:?}");
        assert_eq!(flags.warmup_can_start(), state["warmupCanStart"], "{value:?}");
        assert_eq!(flags.on_demand_can_start(), state["onDemandCanStart"], "{value:?}");
    }
}

#[test]
fn the_gates_follow_node_for_every_flag_combination() {
    let default = RuntimeFlags::default();
    assert!(!default.secondary && default.eager_warmup);
    for secondary in [false, true] {
        for eager_warmup in [false, true] {
            let flags = RuntimeFlags { secondary, eager_warmup };
            assert_eq!(flags.warmup_can_start(), onnx_runtime_supported() && eager_warmup && !secondary, "{flags:?}");
            assert_eq!(flags.on_demand_can_start(), onnx_runtime_supported() && !secondary, "{flags:?}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_secondary_process_never_fetches_or_loads() {
    let server = Server::start(Vec::new()).await;
    let cache = tempfile::tempdir().expect("cache");
    let tick = StateTick::default();
    let (runtime, embedder) = runtime(&server, cache.path(), RuntimeFlags { secondary: true, eager_warmup: true }, &tick);

    runtime.cold_warmup().await.expect("a skipped warmup is not an error");
    runtime.prewarm_recall();
    settle().await;
    let reply = runtime.embedding_warmup(&CancellationToken::new()).await.expect("answers");
    assert_eq!(reply, WarmupReply::Skipped("secondary mode"));
    assert_eq!(reply.to_json(), serde_json::json!({ "ok": true, "skipped": "secondary mode" }));
    assert_eq!(fetches(&server), 0);
    assert!(!embedder.is_installed().await.expect("reads") && !embedder.is_ready());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: real inference needs the staged ONNX Runtime (MIXDOG_ORT_LIBRARY) and the e5 files (MIXDOG_MEMORY_MODELS)"]
async fn without_eager_warmup_only_the_explicit_install_route_loads_the_model() {
    let server = e5_server().await;
    let cache = tempfile::tempdir().expect("cache");
    let tick = StateTick::default();
    let (runtime, embedder) =
        runtime_over(&server, cache.path(), RuntimeFlags { secondary: false, eager_warmup: false }, &tick, real_ort());

    runtime.cold_warmup().await.expect("skipped");
    runtime.prewarm_recall();
    settle().await;
    assert_eq!(fetches(&server), 0, "MIXDOG_EMBED_WARMUP=0 gates the eager paths");
    assert!(!embedder.is_installed().await.expect("reads"));

    let reply = runtime.embedding_warmup(&CancellationToken::new()).await.expect("installs and loads");
    assert_eq!(reply, WarmupReply::Ready(true));
    assert_eq!(reply.to_json(), serde_json::json!({ "ok": true, "ready": true }));
    assert_eq!(fetches(&server), 1);
    assert!(embedder.is_ready());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: real inference needs the staged ONNX Runtime (MIXDOG_ORT_LIBRARY) and the e5 files (MIXDOG_MEMORY_MODELS)"]
async fn a_session_start_prewarm_installs_and_loads_in_the_background_and_repeats_are_free() {
    let server = e5_server().await;
    let cache = tempfile::tempdir().expect("cache");
    let tick = StateTick::default();
    let (runtime, embedder) = runtime_over(&server, cache.path(), RuntimeFlags::default(), &tick, real_ort());

    runtime.prewarm_recall();
    until(&tick, || embedder.is_ready()).await;
    assert_eq!(fetches(&server), 1);

    runtime.prewarm_recall();
    runtime.cold_warmup().await.expect("already warm");
    settle().await;
    assert_eq!(fetches(&server), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_download_fails_the_awaited_paths_and_leaves_recall_on_its_text_lanes() {
    let server = Server::start(Vec::new()).await;
    let cache = tempfile::tempdir().expect("cache");
    let tick = StateTick::default();
    let (runtime, embedder) = runtime(&server, cache.path(), RuntimeFlags::default(), &tick);

    assert!(runtime.cold_warmup().await.is_err());
    assert!(runtime.embedding_warmup(&CancellationToken::new()).await.is_err());
    runtime.prewarm_recall();
    settle().await;
    assert!(!embedder.is_ready());
    assert_eq!(crate::memory::recall::readiness::RecallEmbedder::new(embedder, false).query_vector("anything", &tokio_util::sync::CancellationToken::new()).await.expect("not aborted"), None);
}
