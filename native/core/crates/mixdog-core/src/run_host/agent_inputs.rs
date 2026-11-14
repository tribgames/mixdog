//! The inputs of the agent registry and the worker-turn observer that the purge hooks hold
//! (`PurgeOwners.agents`, `PurgeOwners.worker_turns`) and that exist before the session directory:
//!
//! - [`ConfigReap`]: `ReapWindow`, Node's `resolveAgentTerminalReapMs(config, provider)` over the live
//!   config's `autoClear` section (`agent_terminal_reap_ms`).
//! - [`LateLiveSessions`] and [`LateTurnSource`]: the directory's own `LiveSessions` and `TurnSource`
//!   through the late directory. The purge hooks are part of what the directory is built from, so
//!   the registry cannot hold the built directory. Unbound nothing is loaded and no session
//!   reports turns, which is what Node's registry sees before any session runtime exists; the
//!   composition verifies the directory before the listener accepts.
//! - [`FileEnvironment`]: the agent tool's `Environment` (`AgentParts.env`).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::seams::{TurnListener, TurnSource, Unobserve};
use mixdog_agent::agent_tool::host::Environment;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::{EntryKind, FileService, ReadRange};
use mixdog_rt::InteractiveIo;
use mixdog_tools::fs::read_failure_message;
use mixdog_agent::compact::settings::agent_terminal_reap_ms;
use mixdog_core_config::config::Config;
use mixdog_core_session::session::agent_registry::{LiveSessions, LiveStamp, ReapWindow, Row};

use super::compose_parts::LateDirectory;

/// `resolveAgentTerminalReapMs(config, provider)`.
pub struct ConfigReap {
    config: Config,
}

impl ConfigReap {
    pub fn new(config: Config) -> Self {
        Self { config }
    }
}

impl ReapWindow for ConfigReap {
    fn terminal_reap_ms(&self, provider: &str) -> f64 {
        agent_terminal_reap_ms(self.config.agent().get("autoClear"), provider)
    }
}

/// The registry's view of the loaded sessions.
pub struct LateLiveSessions(pub Arc<LateDirectory>);

impl LiveSessions for LateLiveSessions {
    fn loaded(&self) -> Vec<String> {
        self.0.directory().map(|directory| LiveSessions::loaded(&*directory)).unwrap_or_default()
    }

    fn header(&self, session: &str) -> Option<Row> {
        LiveSessions::header(&*self.0.directory()?, session)
    }

    fn running(&self, session: &str) -> bool {
        self.0.directory().is_some_and(|directory| LiveSessions::running(&*directory, session))
    }

    fn has_live_work(&self, session: &str) -> bool {
        self.0.directory().is_some_and(|directory| LiveSessions::has_live_work(&*directory, session))
    }

    fn runtime_stage(&self, session: &str) -> Option<String> {
        LiveSessions::runtime_stage(&*self.0.directory()?, session)
    }

    fn stamp(&self, session: &str) -> Option<LiveStamp> {
        LiveSessions::stamp(&*self.0.directory()?, session)
    }
}

/// The agent tool's `Environment`, over the file service on the interactive lane:
/// - `is_directory`: `isExistingDirectory(path)` (`stat(path)` follows links; any failure is no);
/// - `read_text`: `readFileSync(target, 'utf8')` (invalid bytes read as U+FFFD; a failure reads as
///   Node's `err.message`);
/// - `current_dir`: `process.cwd()`, the folder the daemon started in (it never changes it);
/// - `now_iso`: `new Date().toISOString()`.
pub struct FileEnvironment {
    files: Arc<dyn FileService>,
    lane: InteractiveIo,
    current_dir: String,
}

impl FileEnvironment {
    pub fn new(files: Arc<dyn FileService>, lane: InteractiveIo, current_dir: String) -> Self {
        Self { files, lane, current_dir }
    }
}

#[async_trait]
impl Environment for FileEnvironment {
    async fn is_directory(&self, path: &str) -> bool {
        let Some(path) = AbsPath::new(PathBuf::from(path)) else { return false };
        self.files.stat(self.lane, path).await.is_ok_and(|stat| stat.kind == EntryKind::Dir)
    }

    async fn read_text(&self, path: &str) -> Result<String, String> {
        let target = PathBuf::from(path);
        let abs = AbsPath::new(target.clone()).ok_or_else(|| format!("path is not absolute: {path}"))?;
        let read = self.files.read(self.lane, abs, ReadRange::default()).await.map_err(|error| read_failure_message(&error, &target))?;
        Ok(String::from_utf8_lossy(&read.bytes).into_owned())
    }

    fn current_dir(&self) -> String {
        self.current_dir.clone()
    }

    fn now_iso(&self) -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

/// `observeSessionTurns` through the late directory.
pub struct LateTurnSource(pub Arc<LateDirectory>);

impl TurnSource for LateTurnSource {
    fn observe_session_turns(&self, session_id: &str, listener: Arc<dyn TurnListener>) -> Option<Unobserve> {
        self.0.directory()?.observe_session_turns(session_id, listener)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_unbound_directory_has_no_sessions_and_no_turns() {
        let late = Arc::new(LateDirectory::default());
        let live = LateLiveSessions(late.clone());
        assert!(live.loaded().is_empty() && live.header("s").is_none() && !live.running("s") && !live.has_live_work("s"));
        assert!(live.runtime_stage("s").is_none());
        struct Quiet;
        impl TurnListener for Quiet {
            fn turn_started(&self, _: mixdog_agent::agent_tool::flow::seams::TurnStart) {}
            fn turn_settled(&self, _: mixdog_agent::agent_tool::flow::seams::TurnOutcome) {}
        }
        assert!(LateTurnSource(late).observe_session_turns("s", Arc::new(Quiet)).is_none());
    }

    /// `isExistingDirectory`, `readFileSync(target, 'utf8')` and `toISOString()` as the agent tool
    /// asks them.
    #[tokio::test]
    async fn the_agent_environment_reads_what_node_reads() {
        use mixdog_core_api::domain::fs::{WritePrecondition, WriteRequest};
        use mixdog_core_api::domain::mock::MockFileService;

        let tokens = mixdog_rt::testing::tokens();
        let files = Arc::new(MockFileService::default());
        let root = std::env::temp_dir().join("agent-environment");
        let dir = AbsPath::new(root.clone()).unwrap();
        let file = AbsPath::new(root.join("prompt.txt")).unwrap();
        files.create_dir(tokens.durability_io, dir, true).await.unwrap();
        let request = WriteRequest { path: file, content: b"ask \xff here".to_vec(), precondition: WritePrecondition::Unconditional };
        files.write(tokens.durability_io, request).await.unwrap();
        let env = FileEnvironment::new(files, tokens.interactive_io, "/start".into());

        assert!(env.is_directory(&root.to_string_lossy()).await);
        assert!(!env.is_directory(&root.join("prompt.txt").to_string_lossy()).await, "a file is not a directory");
        assert!(!env.is_directory(&root.join("gone").to_string_lossy()).await);
        assert!(!env.is_directory("relative").await);
        assert_eq!(env.read_text(&root.join("prompt.txt").to_string_lossy()).await.as_deref(), Ok("ask \u{fffd} here"));
        let missing = root.join("gone.txt");
        assert_eq!(
            env.read_text(&missing.to_string_lossy()).await,
            Err(format!("ENOENT: no such file or directory, open '{}'", missing.display()))
        );
        assert_eq!(env.current_dir(), "/start");
        let stamp = env.now_iso();
        assert!(stamp.len() == 24 && stamp.ends_with('Z') && stamp.as_bytes()[10] == b'T', "{stamp}");
    }

    /// The work `decisions.md` "Node daemon hot paths found by profiling" 6 forbids a reader of non-credential settings,
    /// counted where every route passes (the `work` modules of the two crates, on only in this crate's test builds): a
    /// config file read by any instance, a rebuild of the agent section, a load of the provider map, the construction of
    /// a provider, a credential read (a credential file, the account roster, the keychain, a key variable). The counters
    /// are process-wide: the suite runs under nextest, one process per test.
    const FORBIDDEN: [&str; 5] = ["config file reads", "agent-section rebuilds", "provider-map loads", "providers built", "credential reads"];

    fn forbidden_work() -> [u64; 5] {
        [
            mixdog_core_config::work::file_reads(),
            mixdog_core_config::work::agent_rebuilds(),
            mixdog_ai::work::provider_loads(),
            mixdog_ai::work::providers_built(),
            mixdog_ai::work::credential_reads(),
        ]
    }

    /// `decisions.md` "Node daemon hot paths found by profiling" 6: the stale-row deadline needs only `autoClear`; it reads the
    /// published snapshot, so it neither reloads the config nor goes through the provider loader that probes credentials.
    #[tokio::test]
    async fn the_reap_window_read_neither_reloads_the_config_nor_probes_credentials() {
        let world = crate::run_host::process_tests::world(&[], json!({}), Vec::new()).await;
        let config = world.services.config.clone();
        config
            .update(|doc| {
                doc.insert("agent".into(), serde_json::json!({ "autoClear": { "providerIdleMs": { "openai": 120_000 } } }));
                Ok(())
            })
            .await
            .expect("saved");
        let reap = ConfigReap::new(config.clone());
        let (revision, before) = (config.revision(), forbidden_work());
        for _ in 0..5 {
            assert_eq!(reap.terminal_reap_ms("openai"), 120_000.0);
        }
        let after = forbidden_work();
        for ((name, before), after) in FORBIDDEN.iter().zip(before).zip(after) {
            assert_eq!(after, before, "a reap-window read did {name}");
        }
        assert_eq!(config.revision(), revision, "a reap-window read installed a document");
    }

    /// The counters of the test above are live on every route the forbidden work can take, including the ones that do not
    /// pass through the instance under test: another `Config` opening or reloading the file, each provider adapter's
    /// constructor (`build`, `build_custom_parts`), `custom_key_ids`, a credential file, the gcloud login, the keychain and
    /// the key variables.
    #[tokio::test]
    async fn every_route_to_the_forbidden_work_moves_its_counter() {
        use mixdog_ai::registry::builder::DefaultProviderBuilder;
        use mixdog_ai::registry::effective::EffectiveProviders;
        use mixdog_ai::registry::keys::{ApiKeyStore, KeyConfig};
        use mixdog_ai::registry::providers::ProviderBuilder;
        use mixdog_core_config::config::ConfigLanes;

        let world = crate::run_host::process_tests::world(&[("OPENAI_API_KEY", "k"), ("CUSTOM_KEY", "v")], json!({}), Vec::new()).await;
        let services = &world.services;
        let builder = Arc::new(DefaultProviderBuilder::new(crate::run_host::builder_env::builder_env(services)));
        let keys = ApiKeyStore::new(services.vault.clone(), services.env.clone(), false);
        let effective = EffectiveProviders::new(builder.clone(), ApiKeyStore::new(services.vault.clone(), services.env.clone(), false), services.env.clone());
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let other = tempfile::tempdir().expect("dir");
        let agent = services.config.agent();

        let moved = |name: &str, before: [u64; 5], counter: usize| {
            assert!(forbidden_work()[counter] > before[counter], "{name} moved no {} counter", FORBIDDEN[counter]);
        };
        let before = forbidden_work();
        Config::open(other.path().join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.expect("another instance");
        moved("opening another Config", before, 0);
        let before = forbidden_work();
        services.config.reload().await.expect("reload");
        moved("Config::reload", before, 0);
        let before = forbidden_work();
        services.config.loaded_agent().await.expect("rebuilt");
        moved("Config::loaded_agent", before, 1);
        let before = forbidden_work();
        effective.load(&agent, false).await.expect("loaded");
        moved("EffectiveProviders::load", before, 2);
        // Each adapter's constructor counts, whichever function reaches it: the setup probes call `build_custom_parts` itself,
        // and a keyless provider reads no credential.
        for (name, cfg) in [
            ("openai", json!({ "apiKey": "k" })),
            ("openai-oauth", json!({})),
            ("anthropic", json!({ "apiKey": "k" })),
            ("xai", json!({ "apiKey": "k" })),
            ("gemini", json!({ "apiKey": "k" })),
            ("grok-oauth", json!({})),
            ("cursor-api", json!({ "apiKey": "k" })),
            ("devin-oauth", json!({})),
        ] {
            let before = forbidden_work();
            builder.build(name, &cfg).await.unwrap_or_else(|error| panic!("{name}: {error}"));
            moved(&format!("DefaultProviderBuilder::build {name}"), before, 3);
        }
        for (name, cfg) in [
            ("custom-one-wire", json!({ "type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-chat", "baseURL": "http://127.0.0.1:1/v1", "auth": "none" })),
            ("custom-anthropic", json!({ "type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "anthropic", "baseURL": "http://127.0.0.1:1", "auth": "none" })),
            ("custom-two-wires", json!({ "type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-chat", "wires": ["chat", "responses"], "baseURL": "http://127.0.0.1:1/v1", "auth": "none" })),
        ] {
            let (before, credentials) = (forbidden_work(), mixdog_ai::work::credential_reads());
            builder.build_custom_parts(name, &cfg).unwrap_or_else(|error| panic!("{name}: {error}"));
            moved(&format!("DefaultProviderBuilder::build_custom_parts {name}"), before, 3);
            assert_eq!(mixdog_ai::work::credential_reads(), credentials, "{name} is keyless: nothing reads a credential");
        }
        // The gcloud login file is read by the settings view alone: no provider is built, no provider map loaded.
        for read in 1..=2 {
            let before = forbidden_work();
            builder.adc_describe("", false).await;
            moved(&format!("DefaultProviderBuilder::adc_describe, read {read}"), before, 4);
            assert_eq!(forbidden_work()[1..4], before[1..4], "adc_describe built or loaded nothing");
        }
        let before = forbidden_work();
        let configured = KeyConfig { api_key: None, api_key_env: Some("CUSTOM_KEY".into()) };
        assert_eq!(keys.resolve("custom-one", &configured).await.expect("env key"), "v");
        moved("ApiKeyStore::resolve of a key variable", before, 4);
        let before = forbidden_work();
        assert_eq!(keys.reload("custom-one", &configured).await.expect("env key"), "v");
        moved("ApiKeyStore::reload of a key variable", before, 4);
        let before = forbidden_work();
        let vault = crate::run_host::vault::KeychainVault::new(Arc::new(mixdog_secrets::MemoryStore::default()));
        mixdog_ai::registry::keys::SecretVault::get(&vault, "agent.openai.apiKey").await.expect("keychain");
        moved("KeychainVault::get", before, 4);
        let before = forbidden_work();
        builder.custom_key_ids("custom-acme").await.expect("roster");
        moved("DefaultProviderBuilder::custom_key_ids", before, 4);
        let before = forbidden_work();
        builder.oauth_credentials_usable("openai-oauth").await.expect("probe");
        moved("DefaultProviderBuilder::oauth_credentials_usable", before, 4);
        let before = forbidden_work();
        builder.oauth_credential_state("openai-oauth").await.expect("state");
        moved("DefaultProviderBuilder::oauth_credential_state", before, 4);
        let before = forbidden_work();
        keys.get("openai").await.expect("key");
        moved("ApiKeyStore::get", before, 4);
        let before = forbidden_work();
        effective.load(&agent, true).await.expect("loaded with secrets");
        moved("EffectiveProviders::load with secrets", before, 4);
    }

    /// `resolveAgentTerminalReapMs`: openai-oauth keeps the finite hour its unlimited cache needs, a
    /// provider with an override uses it, an unknown provider the `default` row.
    #[test]
    fn the_reap_window_is_the_agent_terminal_retention() {
        let hour = 3_600_000.0;
        assert_eq!(agent_terminal_reap_ms(None, "openai-oauth"), hour);
        let section = json!({ "providerIdleMs": { "openai": 120_000, "default": 180_000 } });
        assert_eq!(agent_terminal_reap_ms(Some(&section), "openai"), 120_000.0);
        assert_eq!(agent_terminal_reap_ms(Some(&section), "nowhere"), 180_000.0);
    }
}
