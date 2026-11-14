//! The prompt of an empty thread composed again from the settings as they stand: the prompt half
//! of Node's turn-start reconcile (`tool-policy/policy-stage.mjs` `stagePolicy` + `applyPolicy`):
//! BP1 rules without the denied tools, BP2's stable context (meta, workflow, skills), BP3's core
//! (instruction files, core memory) and environment, and the prompt settings record.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_prompt::prompt::compose::ProfileSkip;
use mixdog_core_prompt::prompt::real_sources::RealSources;
use mixdog_core_session::session::thread_switches::WorkflowTarget;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skills::MANIFEST_CHAR_BUDGET;
use mixdog_mcp::skills::MANIFEST_LIMIT;
use mixdog_mcp::skills::Skill;
use mixdog_mcp::skills::build_manifest;
use mixdog_services::memory::core::context::CoreMemoryContext;
use mixdog_store::agent_mode::session_mode_of;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::prewarm::ComposeJob;
use super::prewarm::PromptFacts;
use super::prewarm::StartupProbes;
use super::prewarm::compose;
use super::prompt_session::PromptPaths;
use super::prompt_session::SessionPrompt;
use super::prompt_session::SessionPromptInput;
use super::prompt_session::compose_session_prompt;
use super::route_surface::is_agent_owner;
use super::tool_pool::model_surface::workflow_disallows_agent_tool;
use super::tool_surface::unused_model_edit_tool_name;
use mixdog_core_prompt::prompt::probes::StartupObservations;

/// What a rebuild is composed from, besides the settings the composer reads itself.
pub struct RebuildRequest {
    /// The thread's header: its prompt identity, folder, owner and workflow as they stand.
    pub header: Header,
    /// The workflow and orchestration texts the config gives now.
    pub target: WorkflowTarget,
    /// `liveDeniedTools`: the tools BP1 must not describe.
    pub denied: Vec<String>,
    /// `honoredSchemaAllowlist`.
    pub allow: Option<Vec<String>>,
    pub provider: String,
    pub model: String,
    /// The `git` tool is on the thread's surface.
    pub has_git_tool: bool,
}

/// Composes a thread's prompt from the settings as they stand.
#[async_trait]
pub trait PromptRebuild: Send + Sync + 'static {
    async fn rebuild(&self, request: RebuildRequest) -> Result<SessionPrompt, String>;
}

/// `buildSkillManifest(collectPromptSkillsCached(cwd, config))`: the manifest of the skills a session working in `cwd` may see.
#[async_trait]
pub trait PromptSkills: Send + Sync + 'static {
    async fn manifest(&self, cwd: &str) -> Result<String, String>;
}

/// [`PromptSkills`] over the skill catalog: the skills not switched off, with their feature available
/// and inside their project scope for `cwd` (the catalog reads the live config for its gates), listed
/// by `build_manifest` with Node's limits (80 skills, 8000 characters). A catalog that cannot be read
/// is the error, not an empty list.
pub struct CatalogPromptSkills(pub Arc<SkillCatalog>);

/// `buildSkillManifest(skills)` over an already filtered list.
fn manifest_of(skills: &[Skill]) -> String {
    let listed: Vec<&Skill> = skills.iter().collect();
    build_manifest(&listed, MANIFEST_LIMIT, MANIFEST_CHAR_BUDGET)
}

#[async_trait]
impl PromptSkills for CatalogPromptSkills {
    async fn manifest(&self, cwd: &str) -> Result<String, String> {
        let visible = self.0.visible(Path::new(cwd)).await.map_err(|error| error.to_string())?;
        Ok(manifest_of(&visible))
    }
}

/// [`PromptRebuild`] over the prompt composition, run on the interactive lane with the startup
/// probes (`prewarm::compose`).
pub struct ComposedPrompt {
    pub io: ToolIo,
    pub probes: Arc<StartupProbes>,
    pub observed: Arc<StartupObservations>,
    pub facts: Arc<PromptFacts>,
    /// `promptConfigSlice(config)`: the runtime's config as the prompt reads it.
    pub config: Arc<dyn Fn() -> Value + Send + Sync>,
    pub core_memory: CoreMemoryContext,
    pub skills: Arc<dyn PromptSkills>,
}

/// The composition input, owned so the lane job can borrow it.
struct Owned {
    request: RebuildRequest,
    config: Value,
    session_id: String,
    cwd: String,
    agent: Option<String>,
    owner_is_agent: bool,
    agent_mode: bool,
    tool_free_role: bool,
    skip_agent_rules: bool,
    delegation_free: bool,
    system_prompt: String,
    profile_skip: ProfileSkip,
    omit: Vec<String>,
    core_memory: String,
    skill_manifest: String,
}

impl Owned {
    fn input(&self) -> SessionPromptInput<'_> {
        SessionPromptInput {
            session_id: &self.session_id,
            provider: &self.request.provider,
            model: &self.request.model,
            agent_mode: self.agent_mode,
            owner_is_agent: self.owner_is_agent,
            agent: self.agent.as_deref(),
            tool_free_role: self.tool_free_role,
            skip_agent_rules: self.skip_agent_rules,
            rule_omit_tools: &self.omit,
            allow_tools: self.request.allow.as_deref(),
            has_git_tool: self.request.has_git_tool,
            delegation_free: self.delegation_free,
            system_prompt: &self.system_prompt,
            profile_skip: self.profile_skip,
            cwd: Some(self.cwd.as_str()).filter(|cwd| !cwd.is_empty()),
            cwd_startup_entries: None,
            config: Some(&self.config),
            workflow_context: &self.request.target.pack_context,
            orchestration_context: &self.request.target.orchestration_context,
            agent_catalog_context: &self.request.target.agent_catalog_context,
            contact_catalog_context: &self.request.target.contact_catalog_context,
            orchestration_mode: &self.request.target.orchestration_mode,
            core_memory_context: &self.core_memory,
            instruction_files_context: None,
            skill_manifest: &self.skill_manifest,
        }
    }
}

#[async_trait]
impl PromptRebuild for ComposedPrompt {
    async fn rebuild(&self, request: RebuildRequest) -> Result<SessionPrompt, String> {
        let header = &request.header;
        let text = |key: &str| header.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let identity = header.get("promptIdentity").cloned().unwrap_or(Value::Null);
        let flag = |key: &str| identity.get(key).and_then(Value::as_bool).unwrap_or(false);
        let skip = |key: &str| identity.pointer(&format!("/profileSkip/{key}")).and_then(Value::as_bool).unwrap_or(false);
        let owner_is_agent = is_agent_owner(&Value::Object(header.clone()));
        let agent = identity.get("agent").and_then(Value::as_str).filter(|agent| !agent.is_empty()).map(str::to_owned);
        let agent_mode = session_mode_of(header) == "agent";
        let tool_free_role = owner_is_agent && request.allow.as_ref().is_some_and(Vec::is_empty);
        let cwd = text("cwd");
        let config = (self.config)();
        // `delegationDisabled(session, ownerIsAgent)` reads the workflow the session holds now.
        let delegation_free = !owner_is_agent && header.get("workflow").is_some_and(|workflow| workflow_disallows_agent_tool(workflow, agent_mode));
        let core_memory = if owner_is_agent { String::new() } else { self.core_memory.load(&cwd, agent.as_deref().unwrap_or_default()).await };
        let skill_manifest = if tool_free_role || request.allow.as_ref().is_some_and(Vec::is_empty) { String::new() } else { self.skills.manifest(&cwd).await? };
        let mut omit = request.denied.clone();
        omit.push(unused_model_edit_tool_name(&request.model).to_owned());
        // `summary?.name || summary?.id || null`: the workflow the notice names.
        let workflow_name = ["name", "id"]
            .iter()
            .find_map(|key| request.target.summary.get(*key).and_then(Value::as_str).filter(|name| !name.is_empty()))
            .map(str::to_owned);
        let owned = Arc::new(Owned {
            session_id: text("id"),
            system_prompt: identity.get("systemPrompt").and_then(Value::as_str).unwrap_or_default().to_owned(),
            skip_agent_rules: flag("skipAgentRules"),
            profile_skip: ProfileSkip { skills: skip("skills"), claudemd: skip("claudemd"), memory: skip("memory") },
            cwd,
            agent,
            owner_is_agent,
            agent_mode,
            tool_free_role,
            delegation_free,
            omit,
            core_memory,
            skill_manifest,
            config,
            request,
        });
        let job: ComposeJob<SessionPrompt> = Arc::new(move |lane, host, observed| {
            let paths = PromptPaths { plugin_root: host.plugin_root, data_dir: host.data_dir };
            let sources = RealSources::new(lane, host, observed);
            let mut prompt = compose_session_prompt(&owned.input(), &paths, &sources);
            // The profile the prompt was composed from, read first: an edit landing during composition leaves the stamp
            // behind, never ahead. An agent's own session keeps no stamp.
            if let Some(agent) = owned.agent.as_deref().filter(|_| !owned.owner_is_agent) {
                prompt.profile_revision = sources.agent_profile_revision(agent, owned.agent_mode);
            }
            prompt
        });
        let mut composed = compose(&self.io, &self.probes, &self.observed, self.facts.clone(), job).await?;
        composed.sections.workflow_name = workflow_name;
        Ok(composed)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use mixdog_mcp::skill_deps::SkillToolDependencies;
    use mixdog_mcp::skills::SkillSource;

    use super::*;

    fn skill(name: &str, when: &str) -> Skill {
        Skill {
            name: name.to_owned(),
            description: String::new(),
            when_to_use: when.to_owned(),
            file_path: PathBuf::new(),
            source: SkillSource::Global,
            plugin: None,
            requires: Vec::new(),
            tool_dependencies: SkillToolDependencies::none(),
        }
    }

    /// `buildSkillManifest` over the prompt's skills (its text is `build_manifest`'s own Node golden):
    /// none is no manifest, names are sorted, and past 80 skills the rest are counted.
    #[test]
    fn the_prompt_lists_the_visible_skills_as_node_does() {
        assert_eq!(manifest_of(&[]), "");
        let two = manifest_of(&[skill("pdf", "Read or create PDF files."), skill("Tidy", "Clean up code.")]);
        assert!(two.starts_with("# available-skills\nSelection triggers and linked tools.\n<available_skills>\n- pdf: Read or create PDF files.\n- Tidy: Clean up code.\n"), "{two}");
        let many: Vec<Skill> = (0..90).map(|n| skill(&format!("skill-{n:03}"), "use it when asked")).collect();
        let listed = manifest_of(&many);
        assert!(listed.contains("- ... 10 more skills omitted") && !listed.contains("skill-089"));
    }
}