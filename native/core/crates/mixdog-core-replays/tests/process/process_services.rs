//! The production process services: the keychain vault, the managed local runtime and the host
//! description. Node goldens (`fixtures/process-services`, recorder
//! `record-process-services.mjs`) come from `lib/keychain-cjs.cjs`, `local-provider/*.mjs` and
//! `providers/codex-client-meta.mjs` run on a 1.4.5 tree.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::text_only::MediaText;
use mixdog_ai::registry::keys::{SecretVault, VaultError};
use mixdog_ai::service::model_proxy_inline::{AttachmentReader, ReadError};
use mixdog_core_api::domain::ext::{DocumentText, ExtError, PdfIntake};
use mixdog_core_api::domain::provider::{Content, Message, Role};
use mixdog_protocol::ThreadId;
use mixdog_secrets::{SecretError, SecretStore};
use mixdog_services::local_provider::assets::ReqwestFetcher;
use mixdog_services::local_provider::hugging_face::ReqwestHf;
use mixdog_services::local_provider::server_process::{LoopbackHealth, SystemLauncher, Timing};
use mixdog_services::local_provider::{LocalProvider, Parts};
use mixdog_services::tidy::process::Processes;
use serde_json::json;

use mixdog_core::run_host::fixture_fs;
use mixdog_core::run_host::local_models::ManagedLocalModels;
use mixdog_core::run_host::media::{AttachmentFacts, StoredFacts};
use mixdog_core::run_host::process::{HostInfo, LocalModels};
use mixdog_core::run_host::vault::KeychainVault;

/// The machine itself: libuv's `os.type()` and `os.release()` and Node's `os.arch()`.
#[test]
fn this_machine_is_read_as_libuv_does() {
    let host = HostInfo::current().unwrap();
    let want_type = if cfg!(windows) {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "Mac OS"
    } else {
        "Linux"
    };
    assert_eq!(host.os_type, want_type);
    let want_arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    assert_eq!(host.arch, want_arch);
    if cfg!(windows) {
        // `<major>.<minor>.<build>` of RtlGetVersion.
        let parts: Vec<&str> = host.os_release.split('.').collect();
        assert!(parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())), "{}", host.os_release);
    } else {
        assert!(!host.os_release.is_empty());
    }
}

/// `PS_PROTECT` / `PS_UNPROTECT` of `lib/keychain-cjs.cjs`, verbatim, and the powershell.exe
/// invocation of its `powershell()`: the DPAPI call Node's vault makes on Windows. A blob only
/// decrypts for the user who made it, so the tests make theirs with this call at run time.
#[cfg(windows)]
mod node_dpapi {}
struct Failing;

#[async_trait]
impl SecretStore for Failing {
    async fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
        Err(SecretError::new("[keychain] the keyring is locked"))
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
        Err(SecretError::new("[keychain] security set failed"))
    }
    async fn delete(&self, _: &str) -> Result<(), SecretError> {
        Err(SecretError { message: "[keychain] delete failed".into(), no_provider: true, unrun: false })
    }
    async fn is_fallback(&self, account: &str) -> Result<bool, SecretError> {
        Ok(account == "from-file")
    }
}

#[tokio::test]
async fn a_failing_keychain_is_the_vaults_error_with_node_s_message() {
    let vault = KeychainVault::new(Arc::new(Failing));
    assert_eq!(vault.get("a").await, Err(VaultError::new("[keychain] the keyring is locked")));
    assert_eq!(vault.set("a", "v").await, Err(VaultError::new("[keychain] security set failed")));
    assert_eq!(vault.delete("a").await, Err(VaultError::new("[keychain] delete failed")));
    assert!(vault.is_fallback("from-file").await.unwrap());
    assert!(!vault.is_fallback("a").await.unwrap());
}

struct NoDocs;

#[async_trait]
impl DocumentText for NoDocs {
    async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, ExtError> {
        Ok(None)
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        Ok(String::new())
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        Err(ExtError::UnknownWorker)
    }
}

struct NoBlobs;

#[async_trait]
impl AttachmentReader for NoBlobs {
    async fn read(&self, _: &str) -> Result<Vec<u8>, ReadError> {
        Err(ReadError::Permanent)
    }
}

struct NoFacts;

#[async_trait]
impl AttachmentFacts for NoFacts {
    async fn facts(&self, _: &str) -> Option<StoredFacts> {
        None
    }
}

struct Offline;

#[async_trait]
impl mixdog_ai::transport::http::HttpSend for Offline {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        Err(mixdog_core_api::domain::provider::ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::Transient,
            mixdog_core_api::domain::provider::DeliveryState::NotSent,
        ))
    }
}

struct NoHeaders;

impl mixdog_core::run_host::process::SessionHeaders for NoHeaders {
    fn header(&self, _: &str) -> Option<Arc<mixdog_store::schema::record::Header>> {
        None
    }
}

/// The constructor builds what the process owns itself — keychain, environment, machine,
/// installation id, rejections file, local runtime — and passes the root's stores through.
#[tokio::test]
async fn the_production_services_are_built_from_the_process_and_the_roots_stores() {
    use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
    use mixdog_ai::netproxy::{NetworkProxy, system::SystemProxy};
    use mixdog_ai::oauth::CredentialIo;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::{Config, ConfigLanes};

    use mixdog_core::run_host::process::{ProcessInputs, ProcessServices};

    let dir = tempfile::tempdir().unwrap();
    let plugin_data = dir.path().join("plugin-data");
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    // The models.dev table is on disk (what the installed core has) and the network is down.
    fixture_fs::write(
        dir.path().join(mixdog_ai::catalog::MODELS_DEV_CACHE_FILE),
        r#"{"fetchedAt":1,"data":{"opencode-go":{"models":{"glm-5":{"name":"GLM 5","limit":{"context":200000,"output":8000}}}}}}"#,
    );
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
    let (_, provider) = local_models(&plugin_data, None);
    let services = ProcessServices::production(ProcessInputs {
        config,
        catalog,
        network: NetworkProxy::new(Arc::new(mixdog_ai::netproxy::route::ProcessEnv), SystemProxy::default()),
        lanes: tokens,
        plugin_data: plugin_data.clone(),
        home_dir: dir.path().to_path_buf(),
        build_version: "9.8.7".into(),
        ledger: Arc::new(|| None),
        sessions: Arc::new(NoHeaders),
        local_provider: provider,
        documents: Arc::new(NoDocs),
        attachments: Arc::new(NoBlobs),
        attachment_facts: Arc::new(NoFacts),
    })
    .await
    .unwrap();

    assert_eq!((services.build_version.as_str(), &services.plugin_data, &services.home_dir), ("9.8.7", &plugin_data, &dir.path().to_path_buf()));
    let host = HostInfo::current().unwrap();
    assert_eq!((services.host.os_type, services.host.os_release, services.host.arch), (host.os_type, host.os_release, host.arch));
    // The id is created in the plugin data directory and the next process reads it back.
    // The lookup the adapters read is the one the catalog publishes into: what the catalog loaded from disk is there, so a
    // listing (OpenCode Go's models.dev fallback) is no longer read against an empty table.
    let rows = services.listing.models_dev_models("opencode-go").expect("the adapters' lookup holds the catalog's models.dev table");
    assert!(rows.contains_key("glm-5"));
    assert_eq!(services.installation_id.len(), 36);
    assert_eq!(fixture_fs::read_to_string(plugin_data.join("installation_id")).unwrap(), services.installation_id);
    assert!(services.env.var("PATH").is_some() || services.env.var("Path").is_some());
    assert!(services.local.entry("qwen3.8-27b-q4-k-m").is_some());
    // The keychain is the plugin data directory's `secrets/` folder, as Node's.
    #[cfg(windows)]
    {
        services.vault.set("agent.sample.apiKey", "sk-DUMMY-sample").await.unwrap();
        assert!(fixture_fs::exists(plugin_data.join("secrets").join("agent.sample.apiKey.dpapi")).unwrap());
        assert_eq!(services.vault.get("agent.sample.apiKey").await.unwrap().as_deref(), Some("sk-DUMMY-sample"));
    }
}

/// A real provider over a data directory that holds the registered-models index Node wrote.
fn local_models(dir: &std::path::Path, index: Option<&str>) -> (ManagedLocalModels, Arc<LocalProvider>) {
    if let Some(index) = index {
        fixture_fs::write(dir.join("local-provider").join("registered-models.json"), index);
    }
    let tokens = mixdog_rt::testing::tokens();
    let manager = mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default());
    let processes = Processes::new(Arc::new(manager), tokens.durability_io);
    let provider = LocalProvider::new(Parts {
        data_dir: dir.to_owned(),
        fetcher: Arc::new(ReqwestFetcher::default()),
        launcher: Arc::new(SystemLauncher::new(&processes)),
        processes,
        hf_http: Box::new(ReqwestHf::default()),
        health: Arc::new(LoopbackHealth::default()),
        timing: Timing::default(),
        idle_ttl_seconds: None,
        platform_key: None,
    });
    (ManagedLocalModels::new(provider.clone(), Arc::new(NoDocs), Arc::new(NoBlobs), Arc::new(NoFacts)), provider)
}
/// The managed runtime takes text: a request with no media passes through the media layer
/// unchanged, whatever session row it is built for.
#[tokio::test]
async fn the_media_layer_passes_a_text_request_through() {
    let dir = tempfile::tempdir().unwrap();
    let (models, _provider) = local_models(dir.path(), None);
    let media: Arc<dyn MediaText> = models.media(&json!({"id": "sess_a", "provider": "mixdog-local", "model": "m"}));
    let messages = vec![Message::new(Role::User, Content::Text("hello".into()))];
    let prepared = media.prepare_pdf_text(messages.clone()).await.unwrap();
    assert_eq!(prepared, messages);
}
