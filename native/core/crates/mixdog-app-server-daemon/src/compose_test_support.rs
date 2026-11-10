//! What the tests that compose the real core share. Composing runs `ensure_runtime` for the bundled PostgreSQL runtime and starts the memory stack on it; with no runtime
//! installed in the data directory that DOWNLOADS it, so these tests never start from an empty one. They are the integration tests of the memory crate's kind
//! (`#[ignore]`, `MIXDOG_PG_RUNTIME` names an unpacked runtime directory, as in `mixdog-services`' `memory/tests/boot.rs`): the runtime is copied once into the layout
//! `ensure_runtime` reads as installed (`<data>/runtime/runtime-<key>`, the `.version-sha256` stamp, `active-version`), so no network is touched.
//! The tests of this binary use ONE data directory and run one at a time (they share its cluster); each ends by stopping its core, which stops the cluster.

use std::path::Path;
use std::path::PathBuf;

use mixdog_services::memory::pg::runtime_install::{Manifest, Platform, install_key, ver_dir};

/// The shared data directory while a test holds `exclusive()`; removed when that guard drops (a static's destructor never runs at process exit,
/// which left a copy of the runtime behind on every run).
static DATA: std::sync::Mutex<Option<tempfile::TempDir>> = std::sync::Mutex::new(None);
// Held for a whole test, across awaits, on purpose: it keeps the tests of one process off the cluster's port one at a time (separate processes are ordered by nextest's pg-cluster group).
#[allow(clippy::disallowed_types, reason = "a test-long guard across awaits")]
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The data directory of every real-core test, with the runtime of `MIXDOG_PG_RUNTIME` installed in it.
pub fn data_dir() -> PathBuf {
    let mut shared = DATA.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    shared
        .get_or_insert_with(|| {
            let dir = tempfile::tempdir().expect("the shared data directory");
            install(dir.path());
            dir
        })
        .path()
        .to_owned()
}

#[allow(clippy::disallowed_methods, reason = "test fixture: copies an unpacked runtime into the layout `ensure_runtime` reads")]
pub fn install(data: &Path) {
    let source = std::path::PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let manifest = Manifest::bundled().expect("the bundled manifest");
    let (asset, _) = manifest.select(&Platform::current()).expect("the manifest has a runtime for this platform");
    let key = install_key(&manifest.version(), &asset.sha256);
    let base = data.join("runtime");
    let target = ver_dir(&base, &key);
    copy_tree(&source, &target);
    std::fs::write(target.join(".version-sha256"), &asset.sha256).expect("the stamp");
    std::fs::write(base.join("active-version"), &key).expect("the active version");
}

#[allow(clippy::disallowed_methods, reason = "test fixture")]
fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("the target directory");
    for entry in std::fs::read_dir(from).expect("the runtime directory") {
        let entry = entry.expect("a runtime entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("an entry type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("a runtime file");
        }
    }
}

/// What a user's settings hold once a provider is signed in and a model is chosen: the provider in `mixdog-config.json`, its listed model in the catalog cache the core cold-starts
/// from (`catalogs/snapshot.json`), and the preset `default` names. The provider needs no key (`auth: none`) and its address is never called by a test that starts no turn.
#[allow(clippy::disallowed_methods, reason = "test fixture: the settings files a user's setup would have written")]
pub fn seed_default_model(data: &Path) {
    const PROVIDER: &str = "custom-test";
    const MODEL: &str = "test-model";
    let config = serde_json::json!({ "agent": {
        "providers": { PROVIDER: {
            "type": "custom", "schemaVersion": 2, "name": "test", "protocol": "openai-chat",
            "baseURL": "http://127.0.0.1:9", "auth": "none", "enabled": true,
            "modelOverrides": { MODEL: { "manual": true } },
        } },
        "default": "main",
        "presets": [{ "id": "main", "name": "main", "provider": PROVIDER, "model": MODEL }],
    } });
    std::fs::write(data.join("mixdog-config.json"), config.to_string()).expect("the settings file");
    let snapshot = serde_json::json!({ "generation": 1, "models": { PROVIDER: [{
        "id": MODEL, "provider": PROVIDER, "displayName": null, "rates": {}, "vision": "unknown",
        "functionCalling": "unknown", "reasoning": "unknown", "fastMode": "unknown",
        "reasoningEfforts": [], "source": "native", "manual": true,
    }] } });
    std::fs::create_dir_all(data.join("catalogs")).expect("the catalog directory");
    std::fs::write(data.join("catalogs").join("snapshot.json"), snapshot.to_string()).expect("the catalog cache");
}

/// Held for the whole test: the cluster in `data_dir` is started by one core at a time.
pub async fn exclusive() -> Exclusive {
    Exclusive(ONE_AT_A_TIME.lock().await)
}

/// The test-long hold on the cluster. A test declares it first, so it drops last: after the test's core has stopped, it removes the shared data directory,
/// and a directory that cannot be removed (a process still holds it) fails the test.
pub struct Exclusive(#[allow(dead_code, reason = "held for its drop")] tokio::sync::MutexGuard<'static, ()>);

impl Drop for Exclusive {
    fn drop(&mut self) {
        let shared = DATA.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(dir) = shared {
            let path = dir.path().to_owned();
            if let Err(error) = dir.close() {
                let message = format!("the shared data directory {} was not removed: {error}", path.display());
                if std::thread::panicking() {
                    eprintln!("{message}");
                } else {
                    panic!("{message}");
                }
            }
        }
    }
}

/// The catalog's HTTP port in every real-core test: a client that cannot connect, so the boot warm-up (200 ms after
/// the composition starts) never reaches a network.
pub fn offline_http() -> std::sync::Arc<dyn mixdog_ai::transport::http::HttpSend> {
    std::sync::Arc::new(OfflineHttp)
}

struct OfflineHttp;

#[async_trait::async_trait]
impl mixdog_ai::transport::http::HttpSend for OfflineHttp {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        Err(mixdog_core_api::domain::provider::ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::Transient,
            mixdog_core_api::domain::provider::DeliveryState::NotSent,
        ))
    }
}