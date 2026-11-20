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

    async fn private_copy(&self, req: &CoreRequest, root: &str, rel: &str) -> Result<mixdog_exthost::PrivateCopy, CoreError> {
        let copy = self.0.relay_private_copy(req, root.to_owned(), rel.to_owned()).await?;
        Ok(mixdog_exthost::PrivateCopy { root: copy.root.to_string_lossy().into_owned(), rel: copy.rel.clone(), guard: Box::new(copy) })
    }
}

/// A paired phone's reads of a visualize pane's files: the tabs decide what is servable, the workspace checks containment and
/// reads (`mixdog_workspace::visualize_pane`).
pub struct WorkspacePaneFiles(pub Arc<WorkspaceService>);

fn scope_of(scope: mixdog_exthost::PaneScope) -> mixdog_workspace::visualize_pane::PaneScope {
    mixdog_workspace::visualize_pane::PaneScope {
        root: scope.root,
        panes: scope
            .panes
            .into_iter()
            .map(|pane| mixdog_workspace::visualize_pane::TabPane {
                kind: pane.kind,
                path: pane.path,
                root: pane.root,
                inline: pane.inline,
                version: pane.version,
            })
            .collect(),
    }
}

#[async_trait]
impl mixdog_exthost::PaneFiles for WorkspacePaneFiles {
    async fn range(&self, req: &CoreRequest, scope: mixdog_exthost::PaneScope, rel: String, offset: u64, length: u64) -> Result<serde_json::Value, CoreError> {
        self.0.visualize_pane_range(req, scope_of(scope), rel, offset, length).await
    }

    async fn file(&self, req: &CoreRequest, scope: mixdog_exthost::PaneScope, index: usize) -> Result<serde_json::Value, CoreError> {
        self.0.visualize_pane_file(req, scope_of(scope), index).await
    }
}
