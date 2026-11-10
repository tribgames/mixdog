//! `relay_files`: the document service's question "may this paired phone name this file" answered by the workspace, which
//! holds the registered projects (its catalog) and the phone's one-file grants (its grant store).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_workspace::service::WorkspaceService;

pub struct WorkspaceRelayFiles(pub Arc<WorkspaceService>);

#[async_trait]
impl mixdog_exthost::RelayFiles for WorkspaceRelayFiles {
    async fn admit(&self, req: &CoreRequest, root: &str, rel: &str) -> Result<(String, String), CoreError> {
        let target = self.0.relay_file(req, root, rel).await?;
        Ok((target.root.to_string_lossy().into_owned(), target.rel))
    }
}
