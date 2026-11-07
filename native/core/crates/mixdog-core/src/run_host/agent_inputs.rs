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
use mixdog_core_session::session::agent_registry::{LiveSessions, ReapWindow, Row};

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
