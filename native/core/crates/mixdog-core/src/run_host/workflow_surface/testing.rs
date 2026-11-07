//! Sandboxed installs for the tests of the surface: an install root and a data dir laid from text
//! files, the config over them, and the agent definitions that read both.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::agents::AgentEvidence;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use serde_json::Value;
use serde_json::json;

use crate::run_host::fixture_fs;

struct NoEvidence;

#[async_trait]
impl AgentEvidence for NoEvidence {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

/// `normalizeToolProfile`: a name that is no profile is the interactive one.
pub(super) fn profile_of(name: &str) -> ToolProfile {
    match name {
        "headless" => ToolProfile::Headless,
        "heartbeat" => ToolProfile::Heartbeat,
        _ => ToolProfile::Interactive,
    }
}

pub(super) struct World {
    /// Keeps the sandbox alive.
    pub _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub data: PathBuf,
    pub config: Config,
    pub agents: Arc<AgentDefinitions>,
}

/// `path -> text` files under `folder`.
pub(super) fn lay(folder: &Path, files: &Value) {
    fixture_fs::create_dir_all(folder);
    for (path, text) in files.as_object().expect("files") {
        fixture_fs::write(folder.join(path), text.as_str().expect("text"));
    }
}

/// The install `root_files` and `data_files` describe, with `agent_config` as the config's agent section.
pub(super) async fn open_world(root_files: &Value, data_files: &Value, agent_config: &Value) -> World {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().expect("sandbox");
    let (root, data) = (dir.path().join("root"), dir.path().join("data"));
    lay(&root, root_files);
    lay(&data, data_files);
    let config_path = dir.path().join("mixdog-config.json");
    fixture_fs::write(&config_path, serde_json::to_vec(&json!({ "agent": agent_config })).expect("config"));
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.expect("config opens");
    let agents = Arc::new(AgentDefinitions::new(
        &root,
        &data,
        tokens.interactive_io,
        AgentRoutes::new(config.clone(), &data),
        Arc::new(NoEvidence),
        Arc::new(|| Value::Null),
        dir.path().join("task"),
    ));
    World { _dir: dir, root, data, config, agents }
}
