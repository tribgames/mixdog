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
use serde_json::{json, Value};

use super::fixture_fs;
use super::local_models::ManagedLocalModels;
use super::media::{AttachmentFacts, StoredFacts};
use super::process::{HostInfo, LocalModels};
use super::vault::KeychainVault;

const HOST: &str = include_str!("../../../../fixtures/process-services/host.json");
const SECRETS: &str = include_str!("../../../../fixtures/process-services/secrets.json");
const LOCAL: &str = include_str!("../../../../fixtures/process-services/local-models.json");

fn golden(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

// ---- HostInfo ----------------------------------------------------------------------------

/// `codexUserAgent()`'s `(<os> <release>; <arch>)` for Node's `os.type()`, `os.release()` and
/// `os.arch()`.
#[test]
fn the_host_is_described_in_codexs_vocabulary_as_node_does() {
    let golden = golden(HOST);
    for case in golden["cases"].as_array().unwrap() {
        let text = |key: &str| case[key].as_str().unwrap();
        let host = HostInfo::from_node(text("type"), text("release"), text("arch"));
        assert_eq!(format!("{} {}; {}", host.os_type, host.os_release, host.arch), text("platform"), "{case}");
    }
}

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

// ---- KeychainVault -----------------------------------------------------------------------

/// `PS_PROTECT` / `PS_UNPROTECT` of `lib/keychain-cjs.cjs`, verbatim, and the powershell.exe
/// invocation of its `powershell()`: the DPAPI call Node's vault makes on Windows. A blob only
/// decrypts for the user who made it, so the tests make theirs with this call at run time.
#[cfg(windows)]
mod node_dpapi {
    use std::io::Write;
    use std::process::{Command, Stdio};

    const PREAMBLE: &str = "Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;";
    const SCOPE: &str = "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser;";

    fn powershell(script: &str, input: Option<&str>) -> String {
        let root = std::env::var("SystemRoot").unwrap();
        let exe = std::path::Path::new(&root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let mut child = Command::new(exe)
            .args(["-NonInteractive", "-NoProfile", "-Command", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input.unwrap_or("").as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    /// `win32Set`'s encryption: the base64 of the DPAPI blob of the UTF-8 value.
    pub fn protect(value: &str) -> String {
        use base64::Engine as _;
        let script = format!(
            "& {{ {PREAMBLE} $bytes = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim()); {SCOPE} $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope); [Convert]::ToBase64String($enc) }}"
        );
        powershell(&script, Some(&base64::engine::general_purpose::STANDARD.encode(value))).trim().to_owned()
    }

    /// `win32Get`'s decryption of a file's content.
    pub fn unprotect(file: &str) -> String {
        let script = format!(
            "& {{ {PREAMBLE} $b64 = $args[0]; $enc = [Convert]::FromBase64String($b64); {SCOPE} $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, $scope); [System.Text.Encoding]::UTF8.GetString($dec) }} '{}'",
            file.trim()
        );
        powershell(&script, None).trim().to_owned()
    }
}

/// A DPAPI file made by Node's DPAPI call is read as Node's `getSecret` reads it. The blob is
/// made during the run (so it opens for whoever runs the test); the recorded fixture fixes the
/// file's structure (the blob header) and the value `getSecret` answered.
#[cfg(windows)]
#[tokio::test]
async fn a_dpapi_file_node_wrote_is_read_by_the_vault() {
    let golden = golden(SECRETS);
    let dpapi = &golden["dpapi"];
    let prefix = dpapi["filePrefix"].as_u64().unwrap() as usize;
    let dir = tempfile::tempdir().unwrap();
    for case in dpapi["cases"].as_array().unwrap() {
        let account = case["account"].as_str().unwrap();
        let file = node_dpapi::protect(case["value"].as_str().unwrap());
        assert_eq!(&file[..prefix], case["filePrefix"].as_str().unwrap(), "{account}: the blob header");
        fixture_fs::write(dir.path().join("secrets").join(format!("{account}.dpapi")), &file);
    }
    let vault = KeychainVault::open(mixdog_rt::testing::tokens().durability_io, dir.path());
    for case in dpapi["cases"].as_array().unwrap() {
        let account = case["account"].as_str().unwrap();
        assert_eq!(vault.get(account).await.unwrap().as_deref(), case["expected"].as_str(), "{account}");
        assert!(!vault.is_fallback(account).await.unwrap(), "{account}");
    }
    assert_eq!(vault.get("agent.never.apiKey").await.unwrap(), None);
}

/// What the vault writes is what Node reads: Node's DPAPI call decrypts the account's `.dpapi`
/// file to the value, the file has the recorded structure, and a delete empties the account.
#[cfg(windows)]
#[tokio::test]
async fn the_vault_stores_the_values_node_stored_in_the_same_file_format() {
    let golden = golden(SECRETS);
    let dpapi = &golden["dpapi"];
    let prefix = dpapi["filePrefix"].as_u64().unwrap() as usize;
    let dir = tempfile::tempdir().unwrap();
    let vault = KeychainVault::open(mixdog_rt::testing::tokens().durability_io, dir.path());
    for case in dpapi["cases"].as_array().unwrap() {
        let (account, value) = (case["account"].as_str().unwrap(), case["value"].as_str().unwrap());
        vault.set(account, value).await.unwrap();
        let file = fixture_fs::read_to_string(dir.path().join("secrets").join(format!("{account}.dpapi"))).unwrap();
        assert_eq!(&file[..prefix], case["filePrefix"].as_str().unwrap(), "{account}: the blob header");
        assert_eq!(node_dpapi::unprotect(&file), case["expected"].as_str().unwrap(), "{account}: Node's decryption of the vault's file");
        assert_eq!(vault.get(account).await.unwrap().as_deref(), case["expected"].as_str(), "{account}");
    }
    let account = dpapi["cases"][0]["account"].as_str().unwrap();
    vault.delete(account).await.unwrap();
    assert_eq!(vault.get(account).await.unwrap(), None);
    vault.delete(account).await.unwrap();
}
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

// ---- ManagedLocalModels ------------------------------------------------------------------

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

impl AttachmentFacts for NoFacts {
    fn facts(&self, _: &str) -> Option<StoredFacts> {
        None
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

/// `localProviderModelEntry(id)`: the bundled manifest and the registered index Node wrote.
#[tokio::test]
async fn the_local_entry_is_nodes_catalog_entry() {
    let golden = golden(LOCAL);
    let dir = tempfile::tempdir().unwrap();
    let (models, _provider) = local_models(dir.path(), golden["index"].as_str());
    for case in golden["entries"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let got = models.entry(id);
        match case["entry"].as_object() {
            None => assert!(got.is_none(), "{id:?}"),
            Some(want) => {
                let got = got.unwrap_or_else(|| panic!("{id:?} has an entry"));
                // A registered model without a name prints as `undefined`.
                assert_eq!(got.name, want["name"].as_str().unwrap_or("undefined"), "{id}");
                assert_eq!(got.supports_function_calling, want["supportsFunctionCalling"].as_bool(), "{id}");
            }
        }
    }
}

/// `localModelState(model).capabilities.tools` after the model server's props were recorded.
#[tokio::test]
async fn the_runtime_tool_support_is_what_the_loaded_server_reported() {
    let golden = golden(LOCAL);
    let dir = tempfile::tempdir().unwrap();
    let (models, provider) = local_models(dir.path(), None);
    for load in golden["loads"].as_array().unwrap() {
        let id = load["id"].as_str().unwrap();
        provider.catalog.state.record_load(id, &load["props"].as_object().map_or(Value::Null, |_| load["props"].clone()), Some(12.0));
        assert_eq!(models.runtime_tools(id), load["tools"].as_bool(), "{id}");
    }
    let never = &golden["never"];
    assert!(never["capabilities"].is_null());
    assert_eq!(models.runtime_tools(never["id"].as_str().unwrap()), None);
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

// ---- ProcessServices::production -----------------------------------------------------------

struct Offline;

#[async_trait]
impl mixdog_ai::transport::http::HttpSend for Offline {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<
        mixdog_ai::transport::http::HttpResponse,
        mixdog_core_api::domain::provider::ProviderError,
    > {
        Err(mixdog_core_api::domain::provider::ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::Transient,
            mixdog_core_api::domain::provider::DeliveryState::NotSent,
        ))
    }
}

struct NoHeaders;

impl super::process::SessionHeaders for NoHeaders {
    fn header(&self, _: &str) -> Option<Arc<mixdog_store::schema::record::Header>> {
        None
    }
}

/// The constructor builds what the process owns itself — keychain, environment, machine,
/// installation id, rejections file, local runtime — and passes the root's stores through.
#[tokio::test]
async fn the_production_services_are_built_from_the_process_and_the_roots_stores() {
    use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ListingLookup, ModelsDevSource};
    use mixdog_ai::netproxy::{system::SystemProxy, NetworkProxy};
    use mixdog_ai::oauth::CredentialIo;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::{Config, ConfigLanes};

    use super::process::{ProcessInputs, ProcessServices};

    let dir = tempfile::tempdir().unwrap();
    let plugin_data = dir.path().join("plugin-data");
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
    let (_, provider) = local_models(&plugin_data, None);
    let services = ProcessServices::production(ProcessInputs {
        config,
        catalog,
        listing: ListingLookup::new(),
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
