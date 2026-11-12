//! The trust sources of the `code_graph` tool (`TrustedRoots`): the registered projects (`listProjects`, strict: a failed read is not an empty registry)
//! and the selected directories beyond the tool's own cwd (`explicitSessionCwd`, `readLastSessionCwd`).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_session::session::UserCwd;
use mixdog_tools::code_graph::TrustedRoots;
use mixdog_workspace::catalog::Catalog;
use mixdog_workspace::catalog::display_name;

pub struct UserTrustedRoots {
    pub registry: Arc<Catalog>,
    pub user_cwd: UserCwd,
}

#[async_trait]
impl TrustedRoots for UserTrustedRoots {
    async fn registered(&self) -> Vec<PathBuf> {
        match self.registry.list().await {
            Ok(rows) => rows.into_iter().map(|row| PathBuf::from(row.path)).collect(),
            Err(error) => {
                tracing::warn!(%error, "[code_graph] the project registry could not be read");
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
/// `listProjects()` (`runtime/shared/projects.mjs`) for the `session` tool's project listing: the same registry the trust above reads.
pub struct RegistryProjects {
    pub registry: Arc<Catalog>,
}

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_port::ProjectList for RegistryProjects {
    async fn list(&self) -> Vec<mixdog_tools::orch::session::ProjectRow> {
        match self.registry.list().await {
            Ok(rows) => rows.into_iter().map(|row| mixdog_tools::orch::session::ProjectRow { name: display_name(&row), path: row.path }).collect(),
            Err(error) => {
                tracing::warn!(%error, "[session] the project registry could not be read");
                Vec::new()
            }
        }
    }
}