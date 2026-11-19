//! When the judge and the embedder fetch, load and repair: the first judged
//! step's refresh, the one repair per load failure until files are replaced,
//! the judge's refusals, and the memory runtime's explicit installation. Files
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
use crate::memory::runtime::{MemoryRuntime, RuntimeFlags};
use crate::model_install::InstallError;
use crate::tool_state::{StateTick, onnx_runtime_supported};

fn step() -> StepInput {
    StepInput { request: "fix the failing build".into(), step: 1, plan: String::new(), calls: Vec::new() }
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

#[tokio::test(flavor = "multi_thread")]
async fn a_secondary_process_never_fetches_or_loads() {
    let server = Server::start(Vec::new()).await;
    let cache = tempfile::tempdir().expect("cache");
    let tick = StateTick::default();
    let (runtime, embedder) = runtime(&server, cache.path(), RuntimeFlags { secondary: true }, &tick);

    assert!(!runtime.install_model(&CancellationToken::new()).await.expect("answers"));
    assert_eq!(fetches(&server), 0);
    assert!(!embedder.is_installed().await.expect("reads") && !embedder.is_ready());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_explicit_install_leaves_recall_on_its_text_lanes() {
    let server = Server::start(Vec::new()).await;
    let cache = tempfile::tempdir().expect("cache");
    let tick = StateTick::default();
    let (runtime, embedder) = runtime(&server, cache.path(), RuntimeFlags::default(), &tick);

    assert!(runtime.install_model(&CancellationToken::new()).await.is_err());
    assert!(!embedder.is_ready());
    assert_eq!(crate::memory::recall::readiness::RecallEmbedder::new(embedder, false).query_vector("anything", &tokio_util::sync::CancellationToken::new()).await.expect("not aborted"), None);
}

/// Waits for `done`, re-checked after every tick. A condition that never comes
/// fails the test instead of hanging it.
async fn until(tick: &StateTick, mut done: impl FnMut() -> bool) {
    let mut changes = tick.subscribe();
    let waited = async {
        while !done() {
            changes.changed().await.expect("tick lives");
        }
    };
    mixdog_rt::time::timeout(UNTIL_LIMIT, waited).await.expect("the awaited state did not come before the limit (the product published no tick that made it true)");
}
/// How long [`until`] waits: longer than the slowest step it covers (a real model's download and load on a loaded machine).
const UNTIL_LIMIT: std::time::Duration = std::time::Duration::from_secs(300);
/// A judge over a runtime library that does not exist, so every load fails.
fn judge(dir: &Path, manifest: &Manifest, tick: &StateTick, explicit: bool) -> Arc<EffortJudgeModel> {
    judge_over(dir, manifest, tick, explicit, PathBuf::from("unused"))
}
fn judge_over(dir: &Path, manifest: &Manifest, tick: &StateTick, explicit: bool, ort_library: PathBuf) -> Arc<EffortJudgeModel> {
    judge_hosted(dir, manifest, tick, explicit, ort_library, false)
}
/// `real_host`: the model loads in the real host process (the test binary is not `mixdogd`, which the product starts).
fn judge_hosted(dir: &Path, manifest: &Manifest, tick: &StateTick, explicit: bool, ort_library: PathBuf, real_host: bool) -> Arc<EffortJudgeModel> {
    let mut model = config(dir);
    model.explicit = explicit;
    model.ort_library = crate::effort_judge::model::OrtRuntime::Library(ort_library);
    let host = real_host.then(|| crate::effort_judge::host_tests::real_host_launch(&model));
    EffortJudgeModel::with_options(model, crate::effort_judge::JudgeLanes::of(&mixdog_rt::testing::tokens()), JudgeOptions { tick: tick.clone(), manifest: Some(manifest.clone()), host, ..JudgeOptions::default() })
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
async fn a_judgment_is_refused_while_installing_when_not_installed_and_after_a_load_failure() {
    let files = Files::new();
    let tick = StateTick::default();

    // Not installed.
    let server = files.serve().await;
    let release = files.manifest(&server, "r1");
    let empty = tempfile::tempdir().expect("dir");
    let model = judge(empty.path(), &release, &tick, true);
    assert!(matches!(model.probs(step()).await, Err(JudgeError::NotInstalled(_))));

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
    assert!(matches!(installing.probs(step()).await, Err(JudgeError::Installing)));
    assert!(matches!(installing.install(&stalled_release, None, &CancellationToken::new()).await, Err(InstallError::Busy)));
    cancel.cancel();
    assert!(running.await.expect("joins").is_err(), "a cancelled install fails");
    assert!(!installing.is_installing());

    // Installed but unloadable: the load starts, fails, and is not started again inside the back-off.
    let loadable = tempfile::tempdir().expect("dir");
    let broken = judge(loadable.path(), &release, &tick, false);
    broken.install(&release, None, &CancellationToken::new()).await.expect("installs");
    assert!(matches!(broken.probs(step()).await, Err(JudgeError::Load(_))));
    assert!(!broken.last_error().is_empty());
    assert!(matches!(broken.probs(step()).await, Err(JudgeError::Load(_))), "a remembered failure is not retried");
    assert!(!broken.status().ready);
}
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: loads the real judge; needs MIXDOG_EFFORT_JUDGE_DIR and the staged ONNX Runtime (MIXDOG_ORT_LIBRARY)"]
async fn the_first_step_loads_the_real_model_and_shutdown_unloads_it() {
    let dir = PathBuf::from(std::env::var_os("MIXDOG_EFFORT_JUDGE_DIR").expect("MIXDOG_EFFORT_JUDGE_DIR"));
    let files = Files::new();
    let server = files.serve().await;
    let tick = StateTick::default();
    let model = judge_hosted(&dir, &files.manifest(&server, "r1"), &tick, true, real_ort(), true);

    assert!(!model.is_ready(), "nothing is loaded before a judgment");
    model.probs(step()).await.expect("judged");
    assert!(model.is_ready());
    model.shutdown().await;
    assert!(!model.is_ready());
    model.probs(step()).await.expect("a shut-down model loads again");
    assert!(model.is_ready());
    assert_eq!(server.hits("/model.onnx"), 0);
}
#[tokio::test(flavor = "multi_thread")]
async fn explicit_install_downloads_the_files_without_starting_the_host() {
    if !onnx_runtime_supported() {
        return;
    }
    // Deliberately not an ONNX graph. The download path must not start inference.
    let id = DEFAULT_MODEL_ID;
    let server = Server::start(vec![
        (&format!("/{id}/resolve/main/tokenizer.json"), Route::Body(b"{}".to_vec())),
        (&format!("/{id}/resolve/main/tokenizer_config.json"), Route::Body(b"{}".to_vec())),
        (&format!("/{id}/resolve/main/onnx/model_quantized.onnx"), Route::Body(b"graph".to_vec())),
    ]).await;
    let cache = tempfile::tempdir().expect("cache");
    let tick = StateTick::default();
    let (runtime, embedder) = runtime(&server, cache.path(), RuntimeFlags::default(), &tick);
    assert_eq!(fetches(&server), 0);
    assert!(!embedder.is_installed().await.expect("reads"));

    assert!(runtime.install_model(&CancellationToken::new()).await.expect("installs without the inference library"));
    assert!(embedder.is_installed().await.expect("reads"));
    assert!(!embedder.is_ready());
    assert!(runtime.install_model(&CancellationToken::new()).await.expect("reinstall"));
    assert_eq!(fetches(&server), 1);
}
