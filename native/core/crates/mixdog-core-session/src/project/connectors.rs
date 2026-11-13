//! The per-project connector switches (Node `agent-connectors.mjs` `getProjectConnectors` and
//! `setProjectConnectorEnabled`): which of the installed connectors a registered Project allows.
//! The policy lives in `<data>/project-connectors.json`, keyed by the Project's path; an
//! edit rewrites the file under its lock and answers the project's switches again.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_agents::agents::ConnectorCatalog;
use mixdog_core_base::support::on_lane;
use mixdog_mcp::permissions::PROJECT_CONNECTORS_FILE;
use mixdog_mcp::permissions::PolicyIo;
use mixdog_mcp::permissions::Projects;
use mixdog_mcp::permissions::read_projects;
use mixdog_mcp::scopes::within_projects;
use mixdog_rt::CancellationToken;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::service::Registry;

/// Node's `NO_WIDEN_MESSAGE`.
const NO_WIDEN_MESSAGE: &str = "This change would widen what the bot may do without asking; make it on the desktop.";

/// `samePath(left, right)`: each lies within the other.
fn same_path(left: &str, right: &str) -> bool {
    within_projects(Path::new(left), &[right.to_owned()]) && within_projects(Path::new(right), &[left.to_owned()])
}

/// `requireId`: the trimmed text, or `<label> is required`.
fn require_id(value: &str, label: &str) -> Result<String, String> {
    let id = mixdog_js::js_trim(value);
    if id.is_empty() { Err(format!("{label} is required")) } else { Ok(id.to_owned()) }
}

fn utf16_sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort_by_key(|id| id.encode_utf16().collect::<Vec<u16>>());
    ids.dedup();
    ids
}

/// A clone reads and writes the same file under its lock.
#[derive(Clone)]
pub struct ProjectConnectors {
    projects: Arc<dyn Registry>,
    /// The installed connectors (`installedIds()`: `mcpStatus().servers` in listing order), the
    /// catalog the agent connector switches read.
    installed: Arc<dyn ConnectorCatalog>,
    file: PathBuf,
    io: PolicyIo,
}

impl ProjectConnectors {
    pub fn new(projects: Arc<dyn Registry>, installed: Arc<dyn ConnectorCatalog>, data_dir: &Path, io: PolicyIo) -> Self {
        Self { projects, installed, file: data_dir.join(PROJECT_CONNECTORS_FILE), io }
    }

    /// The registered Project at `project_path` (its path is the policy key).
    async fn registered(&self, project_path: &str) -> Result<String, String> {
        let path = require_id(project_path, "project path")?;
        self.projects.registered(&path).await?.ok_or_else(|| format!("project not registered: {path}"))
    }

    /// `[{ id, enabled }]` for each installed connector under the projects' file.
    async fn switches(&self, policies: &Projects, root: &str) -> Result<Value, String> {
        let off: Vec<&String> = match policies {
            Projects::Roots(list) => list.iter().filter(|entry| same_path(&entry.root, root)).flat_map(|entry| entry.off.iter()).collect(),
            Projects::Absent | Projects::DenyAll => Vec::new(),
        };
        Ok(Value::Array(
            self.installed
                .installed()
                .await?
                .into_iter()
                .map(|id| {
                    let enabled = !matches!(policies, Projects::DenyAll) && !off.contains(&&id);
                    json!({ "id": id, "enabled": enabled })
                })
                .collect(),
        ))
    }

    async fn read(&self, cancel: &CancellationToken) -> Result<Projects, String> {
        let file = self.file.clone();
        on_lane(self.io.maintenance, cancel, move |lane| read_projects(lane, &file)).await.map_err(|error| error.to_string())
    }

    /// `getProjectConnectors(projectPath)`: each installed connector and whether the project
    /// allows it.
    pub async fn get(&self, project_path: &str, cancel: &CancellationToken) -> Result<Value, String> {
        let root = self.registered(project_path).await?;
        self.switches(&self.read(cancel).await?, &root).await
    }

    /// `setProjectConnectorEnabled(projectPath, connectorId, enabled, options)`: switch one
    /// connector on or off for the project, then the project's switches. With `no_widen` (a
    /// remote client) switching one on that is off now is refused, judged on the file as it is
    /// under its lock.
    pub async fn set_enabled(
        &self,
        project_path: &str,
        connector_id: &str,
        enabled: &Value,
        no_widen: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        let id = require_id(connector_id, "connector id")?;
        // The raw wire value: Node checks `typeof enabled` after the id and before the project.
        let Value::Bool(enabled) = *enabled else { return Err("enabled must be a boolean".to_owned()) };
        let root = self.registered(project_path).await?;
        let (file, key_root) = (self.file.clone(), root.clone());
        let written = on_lane(self.io.durability, cancel, move |lane| -> Result<(), String> {
            mixdog_statefile::with_lock(lane, &file, &mixdog_statefile::LockOpts::default(), || {
                let mut by_root: Vec<(String, Vec<String>)> = match read_projects(lane, &file) {
                    // A file that cannot be read is never overwritten: it may hold switches.
                    Projects::DenyAll => return Err(format!("{PROJECT_CONNECTORS_FILE} cannot be read; fix or remove it first")),
                    Projects::Absent => Vec::new(),
                    Projects::Roots(list) => list.into_iter().map(|entry| (entry.root, entry.off.into_iter().collect())).collect(),
                };
                let at = by_root.iter().position(|(entry, _)| same_path(entry, &key_root));
                let at = at.unwrap_or_else(|| {
                    by_root.push((key_root.clone(), Vec::new()));
                    by_root.len() - 1
                });
                let current = &mut by_root[at].1;
                if no_widen && enabled && current.contains(&id) {
                    return Err(NO_WIDEN_MESSAGE.to_owned());
                }
                current.retain(|entry| *entry != id);
                if !enabled {
                    current.push(id.clone());
                }
                let mut projects = Map::new();
                for (root, off) in by_root {
                    if !off.is_empty() {
                        projects.insert(root, json!({ "off": utf16_sorted(off) }));
                    }
                }
                mixdog_statefile::write_json(lane, &file, &json!({ "projects": projects }), &mixdog_statefile::Opts::default())
                    .map(drop)
                    .map_err(|error| error.to_string())
            })
            .map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())?;
        written?;
        self.switches(&self.read(cancel).await?, &root).await
    }
}
