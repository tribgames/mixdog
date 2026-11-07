//! `leadPromptParts(config, dir, { agentMode, agentId })` of `runtime-core/workflow/context.mjs`
//! with its agent catalogs, and `leadPartsFor(session, leadPromptParts)` of
//! `tool-policy/surface-helpers.mjs`: the workflow slices of a Lead's prompt.
//!
//! A coding Lead gets the mode's orchestration text and the catalog of the agents it may
//! delegate to (bots are never its agents). An agent-mode Lead gets the fixed delegation block, the
//! same sub-agent catalog, and the catalog of its contacts: every bot but itself and, for any Lead
//! but Mixy, Mixy first under her display name. An agent scan, definition or name read that
//! cannot run is a [`SurfaceFailure`], never an empty roster.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_agents::agents::AgentDefinition;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::agents::is_contact;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::support::on_lane;
use mixdog_core_config::config::mixy_display_name;
use mixdog_core_run::run_host::route_chain::resolve_session_mode;
use mixdog_core_session::session::thread_switches::SurfaceFailure;
use mixdog_rt::CancellationToken;
use mixdog_rt::InteractiveIo;
use mixdog_store::agent_mode::session_mode_of;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::instructions::OrchestrationTexts;

/// An agent-mode Lead's fixed delegation block, in place of the orchestration mode.
pub const AGENT_MODE_DELEGATION: &str = "# Delegation

Handle conversation yourself. Do quick lookups and small edits yourself. Hand
self-contained investigation, writing or implementation to sub-agents
(`agent`); their reports return to this chat. Open a new agent task session
(`session create`) only for a big plan, multi-step work across many files or
stages that needs its own Lead, with a self-contained brief: start it when
already requested, otherwise suggest it. Then relay the result in your own
words. Promise a follow-up only when the session result allows it.";

/// An agent-mode Lead's contact catalog intro: the user's other bots.
pub const MIXY_CONTACTS_INTRO: &str = "The user's other bots. Hand one a request with `session send` to its chat and a
self-contained brief.";

/// The slices of a Lead's prompt the workflow gives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LeadParts {
    pub orchestration_context: String,
    pub agent_catalog_context: String,
    pub contact_catalog_context: String,
}

/// A delegatable agent id and its definition (`None`: the folder holds no usable AGENT.md).
struct Listed {
    id: String,
    definition: Option<AgentDefinition>,
}

impl Listed {
    fn contact(&self) -> bool {
        is_contact(&self.id, self.definition.as_ref().and_then(|definition| definition.kind.as_deref()))
    }
}

/// `agentCatalog(dir, ids)`: name and description only; the AGENT.md body is the worker's own
/// system prompt and rides in the worker session.
fn agent_catalog<'a>(agents: impl Iterator<Item = &'a Listed>) -> String {
    agents
        .filter_map(|listed| listed.definition.as_ref())
        .map(|agent| {
            if agent.description.is_empty() {
                format!("- {} ({})", agent.name, agent.id)
            } else {
                format!("- {} ({}): {}", agent.name, agent.id, agent.description)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn titled(title: &str, body: &str) -> String {
    if body.is_empty() { String::new() } else { format!("{title}\n\n{body}") }
}

/// The agent catalogs and mode texts of one install.
pub struct LeadPrompt {
    agents: Arc<AgentDefinitions>,
    texts: OrchestrationTexts,
    lane: InteractiveIo,
    data: PathBuf,
}

impl LeadPrompt {
    /// `data` is the data dir Mixy's identity folder is under.
    pub fn new(agents: Arc<AgentDefinitions>, texts: OrchestrationTexts, lane: InteractiveIo, data: impl Into<PathBuf>) -> Self {
        Self { agents, texts, lane, data: data.into() }
    }

    /// The delegatable agents with their definitions. A scan or definition read that cannot run is
    /// a typed failure, not an empty roster.
    async fn listed(&self) -> Result<Vec<Listed>, SurfaceFailure> {
        let failed = |what: &str, error: &dyn std::fmt::Display| SurfaceFailure(format!("the agent {what} could not be read: {error}"));
        let mut listed = Vec::new();
        for id in self.agents.delegatable_agent_ids().await.map_err(|error| failed("list", &error))? {
            let definition = self.agents.load(&id).await.map_err(|error| failed(&format!("definition of \"{id}\""), &error))?;
            listed.push(Listed { id, definition });
        }
        Ok(listed)
    }

    /// `mixyDisplayName()`, read anew; a lane that cannot run the read is a typed failure.
    async fn mixy_name(&self) -> Result<String, SurfaceFailure> {
        let data = self.data.clone();
        on_lane(self.lane, &CancellationToken::new(), move |lane| mixy_display_name(lane, &data))
            .await
            .map_err(|error| SurfaceFailure(format!("the lead's display name could not be read: {error:?}")))
    }

    /// `leadPromptParts` for `mode` (`configuredOrchestrationMode` of the config).
    pub async fn lead_prompt_parts(&self, mode: &str, agent_mode: bool, agent_id: &str) -> Result<LeadParts, SurfaceFailure> {
        let listed = self.listed().await?;
        if !agent_mode {
            // Bots are never a coding Lead's agents: only agent-mode Leads hand them work.
            let workflow: Vec<&Listed> = listed.iter().filter(|agent| !agent.contact()).collect();
            return Ok(LeadParts {
                // Solo without agents has nothing to delegate to on request either.
                orchestration_context: if mode == "none" && workflow.is_empty() { String::new() } else { self.texts.orchestration_instructions(mode).await? },
                agent_catalog_context: titled("# Available Agents", &agent_catalog(workflow.iter().copied())),
                contact_catalog_context: String::new(),
            });
        }
        let sub_agents = agent_catalog(listed.iter().filter(|agent| !agent.contact()));
        let mut lines = Vec::new();
        if agent_id != MIXY_AGENT_ID {
            lines.push(format!("- {} ({MIXY_AGENT_ID}): the user's representative bot", self.mixy_name().await?));
        }
        let others = agent_catalog(listed.iter().filter(|agent| agent.contact() && agent.id != agent_id));
        if !others.is_empty() {
            lines.push(others);
        }
        let contacts = lines.join("\n");
        Ok(LeadParts {
            // An agent-mode Lead without agents has no one to delegate to at all.
            orchestration_context: if sub_agents.is_empty() && contacts.is_empty() { String::new() } else { AGENT_MODE_DELEGATION.to_owned() },
            agent_catalog_context: titled("# Available Agents", &sub_agents),
            contact_catalog_context: if contacts.is_empty() { String::new() } else { format!("# Bots\n\n{MIXY_CONTACTS_INTRO}\n\n{contacts}") },
        })
    }

    /// `leadPartsFor(session, leadPromptParts)`: the parts for the session's mode and the agent it acts as.
    pub async fn lead_parts_for(&self, mode: &str, session: &Header) -> Result<LeadParts, SurfaceFailure> {
        let agent_mode = session_mode_of(session) == "agent";
        let (_, agent_id) = resolve_session_mode(&Value::Object(session.clone()));
        self.lead_prompt_parts(mode, agent_mode, &agent_id).await
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
