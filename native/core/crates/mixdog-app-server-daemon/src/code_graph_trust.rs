//! The trust sources of the `code_graph` tool (`TrustedRoots`): the registered projects (`listProjects`, strict: a failed read is not an empty registry)
//! and the selected directories beyond the tool's own cwd (`explicitSessionCwd`, `readLastSessionCwd`).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_session::session::UserCwd;
use mixdog_store::registry::Registry;
use mixdog_tools::code_graph::TrustedRoots;

pub struct UserTrustedRoots {
    pub registry: Arc<Registry>,
    pub user_cwd: UserCwd,
    pub lane: mixdog_rt::MaintenanceIo,
}

#[async_trait]
impl TrustedRoots for UserTrustedRoots {
    async fn registered(&self) -> Vec<PathBuf> {
        let registry = self.registry.clone();
        match mixdog_core_base::support::on_lane(self.lane, &mixdog_rt::CancellationToken::new(), move |lane| registry.list_strict(lane)).await {
            Ok(Ok(entries)) => entries.into_iter().map(|entry| PathBuf::from(entry.path)).collect(),
            Ok(Err(error)) => {
                tracing::warn!(%error, "[code_graph] the project registry could not be read");
                Vec::new()
            }
            Err(error) => {
                tracing::warn!(?error, "[code_graph] the project registry read did not run");
                Vec::new()
            }
        }
    }

    async fn selected(&self) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        match self.user_cwd.explicit_cwd(None).await {
            Ok(cwd) => roots.extend(cwd.map(PathBuf::from)),
            Err(error) => tracing::warn!(?error, "[code_graph] the explicit session folder could not be read"),
        }
        match self.user_cwd.last_cwd(None).await {
            Ok(cwd) => roots.extend(cwd.map(PathBuf::from)),
            Err(error) => tracing::warn!(?error, "[code_graph] the last session folder could not be read"),
        }
        roots
    }
}
/// `listProjects()` (`runtime/shared/projects.mjs`, tolerant) for the `session` tool's project listing: the registry file the trust above reads strictly.
/// `Registry::list` is the tolerant read (an unreadable registry lists as empty, as Node's); only a lane that did not run the read is said.
pub struct RegistryProjects {
    pub registry: Arc<Registry>,
    pub lane: mixdog_rt::MaintenanceIo,
}

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_port::ProjectList for RegistryProjects {
    async fn list(&self) -> Vec<mixdog_tools::orch::session::ProjectRow> {
        let registry = self.registry.clone();
        match mixdog_core_base::support::on_lane(self.lane, &mixdog_rt::CancellationToken::new(), move |lane| registry.list(lane)).await {
            Ok(entries) => entries.into_iter().map(|entry| mixdog_tools::orch::session::ProjectRow { name: entry.name, path: entry.path }).collect(),
            Err(error) => {
                tracing::warn!(?error, "[session] the project registry read did not run");
                Vec::new()
            }
        }
    }
}