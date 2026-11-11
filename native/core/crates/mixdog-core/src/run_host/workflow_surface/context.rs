//! The pack half of `activeWorkflowContext(config, dir)` (`runtime-core/workflow/context.mjs`):
//! `loadWorkflowPack` on a lane, `workflowSummary(pack, { hasAgents })` and
//! `workflowContextBlockFromPack(pack)`.

use mixdog_core_base::support::on_lane;
use mixdog_core_config::workflow::WorkflowPaths;
use mixdog_core_config::workflow::pack::Pack;
use mixdog_core_config::workflow::pack::load_pack;
use mixdog_core_config::workflow::pack::workflow_summary;
use mixdog_core_session::session::thread_switches::SurfaceFailure;
use mixdog_js::js_trim;
use mixdog_js::js_trim_start;
use mixdog_rt::CancellationToken;
use mixdog_rt::InteractiveIo;
use serde_json::Value;

/// `workflowContextBlockFromPack(pack)`: one header line, then the body. The body opens with its
/// own `# <name>` title, which the header already says, so the title line is dropped (only when
/// it matches, case-insensitively, and the body goes on after it).
pub fn context_block_from_pack(pack: Option<&Pack>) -> String {
    let Some(pack) = pack else { return String::new() };
    let raw = pack.body.as_str();
    let first_break = raw.find('\n');
    let first_line = js_trim(first_break.map_or(raw, |at| &raw[..at]));
    let body = match first_break {
        Some(at) if first_line.to_lowercase() == format!("# {}", pack.name.to_lowercase()) => js_trim_start(&raw[at + 1..]),
        _ => raw,
    };
    let described = if pack.description.is_empty() { String::new() } else { format!(" — {}", pack.description) };
    format!("# Active Workflow: {}{described}\n\n{body}", pack.name)
}

/// What the active pack gives a session: its summary row and its prompt block.
#[derive(Clone, Debug, PartialEq)]
pub struct ActiveWorkflow {
    /// `{id, name, description, source, delegatesAgents}`.
    pub summary: Value,
    /// `packContext`: the pack block alone.
    pub pack_context: String,
}

/// The workflow packs of one install: the shipped ones under `paths.root`, the user's under
/// `paths.data`.
#[derive(Clone)]
pub struct WorkflowPacks {
    lane: InteractiveIo,
    paths: WorkflowPaths,
}

impl WorkflowPacks {
    pub fn new(lane: InteractiveIo, paths: WorkflowPaths) -> Self {
        Self { lane, paths }
    }

    /// `loadWorkflowPack(dir, id)`, read fresh: the user copy, then the shipped one, then the
    /// shipped default; `None` when none of them can be read. A lane that cannot run the read is
    /// a typed failure, not a missing pack.
    pub async fn load(&self, workflow_id: &str) -> Result<Option<Pack>, SurfaceFailure> {
        let (paths, id) = (self.paths.clone(), workflow_id.to_owned());
        on_lane(self.lane, &CancellationToken::new(), move |_| load_pack(&paths, &id))
            .await
            .map_err(|error| SurfaceFailure(format!("the workflow pack \"{workflow_id}\" could not be read: {error:?}")))
    }

    /// The summary and pack block of the pack `workflow_id` names; `has_agents` is whether the
    /// agent scan finds an agent to delegate to.
    pub async fn active(&self, workflow_id: &str, has_agents: bool) -> Result<ActiveWorkflow, SurfaceFailure> {
        let pack = self.load(workflow_id).await?;
        Ok(ActiveWorkflow {
            summary: Value::Object(workflow_summary(pack.as_ref(), has_agents)),
            pack_context: context_block_from_pack(pack.as_ref()),
        })
    }
}
