//! The desktop file grants and the core's page server, turned on in the workspace service.

use std::path::Path;

use mixdog_workspace::desktop_grants::GRANTS_FILE;
use mixdog_workspace::service::WorkspaceService;

/// Where the page server remembers its port, relative to the data directory.
const PAGE_PORT_FILE: &str = "desktop/page-server.json";

/// Enables `projectFs/grant/*`, `projectFs/localPage/*` and the core page server behind `projectFs/localPageUrl`, with the
/// grant store and the port file under the data directory (both survive a restart).
pub fn compose_desktop_files(workspace: &WorkspaceService, data_dir: &Path) {
    workspace.enable_desktop_files(data_dir.join(GRANTS_FILE), data_dir.join(PAGE_PORT_FILE));
}
