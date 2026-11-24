//! `composeSessionSystem` (`session-prompt-composition.mjs`) and the steps around it: the
//! environment settle after creation, the route-change refresh and the conversation reset.
//!
//! Creation, in the order `createSession` runs it:
//! 1. [`compose_session_prompt`] -> [`SessionPrompt`] (`composeSessionSystem` + `seedSessionMessages`);
//! 2. the tool surface and the deferred manifest are applied to the blocks by `run_host`
//!    (`tool_surface::apply`, over [`SystemBlocks::node_messages`] and back with
//!    [`SystemBlocks::from_node_messages`]);
//! 3. [`refresh_environment`] adds the `# Session` block (`refreshSessionBp3Environment`).

use std::path::Path;

use mixdog_js::js_trim;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Map;
use serde_json::Value;

use crate::run_host::rules::LeadPart;
use crate::run_host::rules::agent_mode_file;
use crate::run_host::rules::agent_role_file;
use crate::run_host::rules::build_agent_mode_content;
use crate::run_host::rules::build_agent_role_content;
use crate::run_host::rules::build_base_rules;
use crate::run_host::rules::build_lead_role_content;
use crate::run_host::rules::lead_role_file;
use crate::run_host::rules::read_base_rule_files;
use crate::run_host::rules_lead::LeadPaths;
use crate::run_host::rules_lead::build_lead_language;
use crate::run_host::rules_lead::build_lead_language_content;
use crate::run_host::rules_lead::build_lead_meta_content;
use crate::run_host::rules_lead::read_lead_files;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_prompt::prompt::blocks::SystemBlocks;
use mixdog_core_prompt::prompt::compose::PART_SEPARATOR;
use mixdog_core_prompt::prompt::compose::ProfileSkip;
use mixdog_core_prompt::prompt::compose::RoleSource;
use mixdog_core_prompt::prompt::compose::Slices;
use mixdog_core_prompt::prompt::compose::compose_system_prompt;
use mixdog_core_prompt::prompt::compose::persona_agent;
use mixdog_core_prompt::prompt::compose::role_source;
use mixdog_core_prompt::prompt::notice::OwnedSections;
use mixdog_core_prompt::prompt::real_sources::SourceWants;
use mixdog_core_prompt::prompt::source_files::PromptFiles;
use mixdog_core_prompt::prompt::sources::PromptSources;
use mixdog_core_session::session::worktree::PromptRewrite;
use mixdog_core_session::session::worktree::PromptView;
use mixdog_core_session::session::worktree::pending_workspace_reroot;
use mixdog_core_session::session::worktree::route_prompt_refresh;

/// The shipped rules and the data directory the composition reads (`mixdogRoot()`,
/// `resolvePluginData()`), and the files it reads them through.
#[derive(Clone, Copy)]
pub struct PromptPaths<'a> {
    pub plugin_root: &'a Path,
    pub data_dir: &'a Path,
    pub files: &'a dyn PromptFiles,
}

/// Reads, through `paths.files`, the rule and Lead files [`compose_session_prompt`] asks for with `input`.
pub fn read_session_prompt_files(input: &SessionPromptInput, paths: &PromptPaths) {
    let plan = Plan::of(input);
    let (files, root) = (paths.files, paths.plugin_root);
    if !plan.skip_rules {
        read_base_rule_files(files, root);
        files.read(&if input.owner_is_agent { agent_role_file(root) } else { lead_role_file(root) });
    }
    if plan.agent_mode {
        files.read(&agent_mode_file(root, "conduct"));
        if plan.mixy {
            files.read(&agent_mode_file(root, "mixy"));
        }
    }
    if plan.lead {
        read_lead_files(&LeadPaths { plugin_root: root, data_dir: paths.data_dir, config: input.config, files }, plan.include_style);
    }
}

/// The source calls [`compose_session_prompt`] makes with `input`, for its read step.
pub fn session_prompt_wants(input: &SessionPromptInput) -> SourceWants {
    let plan = Plan::of(input);
    let mut wants = SourceWants::default();
    match role_source(plan.skip_role_catalog, input.agent, Some(input.provider)) {
        RoleSource::None => {}
        RoleSource::Mixy => wants.mixy_role = true,
        RoleSource::Catalog(..) => wants.role_catalog = true,
    }
    wants.persona = persona_agent(plan.skip_role_catalog, input.agent).map(str::to_owned);
    if plan.agent_mode {
        wants.identity = Some(plan.agent.unwrap_or(MIXY_AGENT_ID).to_owned());
    }
    if let Some(shell) = plan.shell {
        shell.want(&mut wants);
    }
    if let Instructions::Load = plan.instructions {
        wants.instruction_files = Some((plan.config_mode.cloned(), input.cwd.map(str::to_owned)));
    }
    wants
}

/// What [`compose_session_prompt`] builds from its input, decided once: the composition follows it and its read step
/// reads for it.
struct Plan<'a> {
    /// No rules at all (`opts.skipAgentRules`, or a role without tools).
    skip_rules: bool,
    /// The Lead's role, meta and language parts.
    lead: bool,
    /// A Lead in agent mode.
    agent_mode: bool,
    agent: Option<&'a str>,
    mixy: bool,
    skip_role_catalog: bool,
    /// The output style is part of the meta and language parts.
    include_style: bool,
    /// `instructionFiles` as the prompt config states it; `None` reads the stored setting.
    config_mode: Option<&'a Value>,
    instructions: Instructions<'a>,
    /// The shell environment's calls; `None` for a role without tools.
    shell: Option<ShellCalls<'a>>,
}

/// Where a prompt's instruction files come from.
#[derive(Clone, Copy)]
enum Instructions<'a> {
    None,
    Given(&'a str),
    Load,
}

impl<'a> Plan<'a> {
    fn of(input: &SessionPromptInput<'a>) -> Self {
        // A prompt config without the key states `undefined`, which normalizes to the default; no config reads the stored setting.
        static UNSTATED: Value = Value::Null;
        let skip_rules = input.skip_agent_rules || input.tool_free_role;
        let lead = !input.owner_is_agent && !skip_rules;
        let agent_mode = lead && input.agent_mode;
        let agent = input.agent.filter(|agent| !agent.is_empty());
        let mixy = agent.unwrap_or(MIXY_AGENT_ID) == MIXY_AGENT_ID;
        let instructions = match input.instruction_files_context {
            _ if input.tool_free_role || input.profile_skip.claudemd || input.agent_mode => Instructions::None,
            Some(text) => Instructions::Given(text),
            None => Instructions::Load,
        };
        Self {
            skip_rules,
            lead,
            agent_mode,
            agent,
            mixy,
            skip_role_catalog: !input.owner_is_agent && matches!(agent, None | Some(MIXY_AGENT_ID)) && !(agent_mode && mixy),
            include_style: !input.agent_mode,
            config_mode: input.config.map(|config| config.get("instructionFiles").unwrap_or(&UNSTATED)),
            instructions,
            shell: (!input.tool_free_role).then(|| shell_calls(input.cwd, input.cwd_startup_entries, input.has_git_tool)),
        }
    }
}

/// The source calls of the shell environment block.
#[derive(Clone, Copy)]
struct ShellCalls<'a> {
    cwd: Option<&'a str>,
    /// `git_line(cwd)`.
    git: bool,
    /// `cwd_entries(cwd)`, for a folder whose listing was not given.
    entries: Option<&'a str>,
}

fn shell_calls<'a>(cwd: Option<&'a str>, cwd_startup_entries: Option<&str>, has_git_tool: bool) -> ShellCalls<'a> {
    let cwd = cwd.filter(|cwd| !cwd.is_empty());
    ShellCalls { cwd, git: has_git_tool, entries: cwd.filter(|_| cwd_startup_entries.is_none()) }
}

impl ShellCalls<'_> {
    fn want(&self, wants: &mut SourceWants) {
        wants.shell_tools = true;
        if self.git {
            wants.git = Some(self.cwd.map(str::to_owned));
        }
        wants.cwd_entries = self.entries.map(str::to_owned);
    }
}

/// What `composeSessionSystem` reads of the session options and the resolved tool surface.
#[derive(Debug, Clone, Copy, Default)]
pub struct SessionPromptInput<'a> {
    pub session_id: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    /// `sessionMode === 'agent'`.
    pub agent_mode: bool,
    /// `surface.ownerIsAgent`.
    pub owner_is_agent: bool,
    /// `surface.resolvedAgent`.
    pub agent: Option<&'a str>,
    /// `ownerIsAgent && surface.schemaAllowedTools.length === 0`.
    pub tool_free_role: bool,
    /// `opts.skipAgentRules === true`.
    pub skip_agent_rules: bool,
    /// `surface.ruleOmitTools` and `surface.schemaAllowedTools`.
    pub rule_omit_tools: &'a [String],
    pub allow_tools: Option<&'a [String]>,
    /// `surface.toolsForRouting.some((tool) => tool?.name === 'git')`.
    pub has_git_tool: bool,
    /// `delegationDisabled({ ...opts, sessionMode }, ownerIsAgent)`.
    pub delegation_free: bool,
    /// `opts.systemPrompt || ''`.
    pub system_prompt: &'a str,
    pub profile_skip: ProfileSkip,
    /// `opts.cwd || captureOriginalUserCwd()`; `None` when neither names a directory.
    pub cwd: Option<&'a str>,
    /// `opts.cwdStartupEntries` (an off-thread listing); `None` lists the directory now.
    pub cwd_startup_entries: Option<&'a str>,
    /// `promptConfigSlice(opts.promptConfig)`; `None` reads the config file.
    pub config: Option<&'a Value>,
    pub workflow_context: &'a str,
    /// `opts.leadWorkflowParts` (ignored for an agent-owned session).
    pub orchestration_context: &'a str,
    pub agent_catalog_context: &'a str,
    pub contact_catalog_context: &'a str,
    /// `opts.orchestrationMode || ''`.
    pub orchestration_mode: &'a str,
    pub core_memory_context: &'a str,
    /// `opts.instructionFilesContext`; `None` loads them for `cwd`.
    pub instruction_files_context: Option<&'a str>,
    /// `buildSkillManifest(surface.skills)`.
    pub skill_manifest: &'a str,
}

/// The prompt a new session starts with: the blocks (the `env` block is `sessionEnvironment`,
/// before the `# Session` block) and the header fields `buildSessionRecord` derives from them.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionPrompt {
    pub blocks: SystemBlocks,
    /// `bp3EnvironmentContext`: the environment tail the refreshes rebuild the `env` block from.
    pub environment_tail: String,
    pub prompt_identity: Value,
    pub prompt_settings: Value,
    /// The sections `prompt_settings` is the record of (`promptSettingsSections`): what a conversation's
    /// settings are compared with at its turn start (`notice::stage_prompt_settings_notice`).
    pub sections: OwnedSections,
    /// `{ id, name }` or null.
    pub response_language: Value,
    /// `agentProfileRevision`: the stamp of the profile files the prompt was composed from; empty where no stamp is
    /// kept (an agent's own session, an invalid agent id) and until a rebuild that reads the files fills it.
    pub profile_revision: String,
}

impl SessionPrompt {
    /// Writes the prompt's header fields in the order Node's record carries them
    /// (`buildSessionRecord`): the blocks, `promptIdentity`, `promptSettings`, `responseLanguage`,
    /// `bp3EnvironmentContext`, `bp3EnvSplit`, `sessionStartMetaInjected`.
    pub fn write(&self, header: &mut Header) {
        self.blocks.write(header);
        header.insert("promptIdentity".into(), self.prompt_identity.clone());
        header.insert("promptSettings".into(), self.prompt_settings.clone());
        header.insert("responseLanguage".into(), self.response_language.clone());
        header.insert("bp3EnvironmentContext".into(), Value::String(self.environment_tail.clone()));
        header.insert("bp3EnvSplit".into(), Value::Bool(true));
        header.insert("sessionStartMetaInjected".into(), Value::Bool(false));
    }
}

/// `scratchEnvironmentLine(sessionId)`.
pub fn scratch_environment_line(session_id: &str, sources: &dyn PromptSources) -> String {
    sources
        .scratch_dir(session_id)
        .filter(|dir| !dir.is_empty())
        .map_or_else(String::new, |dir| format!("- Scratch: {dir} — this session's scratch directory; TEMP, TMP and TMPDIR in shell commands point here."))
}

/// `buildShellEnvironmentContext`: the Cwd, shell, scratch, tools, git and listing facts.
fn shell_environment_context(
    calls: ShellCalls<'_>,
    cwd_startup_entries: Option<&str>,
    owner_is_agent: bool,
    session_id: &str,
    sources: &dyn PromptSources,
) -> String {
    let cwd_line = match calls.cwd {
        Some(cwd) if owner_is_agent => format!("- Cwd: {cwd} — the active Project root; relative paths and shell commands resolve here."),
        Some(_) => "- Relative paths and shell commands resolve in the active Project shown by Session Cwd.".to_owned(),
        None => String::new(),
    };
    let shell = sources.shell_name();
    let git = if calls.git { sources.git_line(calls.cwd) } else { String::new() };
    let entries = match calls.entries {
        Some(cwd) => sources.cwd_entries(cwd),
        None => calls.cwd.and(cwd_startup_entries).unwrap_or_default().to_owned(),
    };
    [
        cwd_line,
        format!("- Shell: {shell}. Use {shell} syntax unless the user specifies otherwise."),
        scratch_environment_line(session_id, sources),
        sources.shell_tools_line(),
        git,
        entries,
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

/// What `buildWorkspacePromptContext` reads of a session being re-rooted.
#[derive(Debug, Clone, Copy, Default)]
pub struct WorkspaceFacts<'a> {
    pub session_id: &'a str,
    pub owner_is_agent: bool,
    /// `owner === 'agent'` with `schemaAllowedTools` an empty list.
    pub tool_free_role: bool,
    /// The session has the `git` tool among `tools` and `deferredToolCatalog`.
    pub has_git_tool: bool,
    /// `session.skipInstructionFiles === true`.
    pub skip_instruction_files: bool,
    /// `sessionModeOf(session) === 'agent'`.
    pub agent_mode: bool,
}

/// `{ environmentContext, instructionFilesContext }` for a session re-rooted at `cwd`;
/// `None` keeps what the session has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContext {
    pub environment_context: Option<String>,
    pub instruction_files_context: Option<String>,
}

/// `buildWorkspacePromptContext(session, cwd, { instructionFilesMode })`: `config_mode` is the
/// in-memory `instructionFiles` setting, `None` the stored one.
pub fn workspace_prompt_context(facts: &WorkspaceFacts, cwd: &str, config_mode: Option<&Value>, sources: &dyn PromptSources) -> WorkspaceContext {
    let Some((shell, instructions)) = workspace_plan(facts, cwd) else {
        return WorkspaceContext { environment_context: None, instruction_files_context: None };
    };
    let environment = shell_environment_context(shell, None, facts.owner_is_agent, facts.session_id, sources);
    let instructions = instructions.then(|| sources.instruction_files(config_mode, Some(cwd)));
    WorkspaceContext { environment_context: Some(environment), instruction_files_context: instructions }
}

/// The source calls [`workspace_prompt_context`] makes, for its read step.
pub fn workspace_prompt_wants(facts: &WorkspaceFacts, cwd: &str, config_mode: Option<&Value>) -> SourceWants {
    let mut wants = SourceWants::default();
    if let Some((shell, instructions)) = workspace_plan(facts, cwd) {
        shell.want(&mut wants);
        if instructions {
            wants.instruction_files = Some((config_mode.cloned(), Some(cwd.to_owned())));
        }
    }
    wants
}

/// What [`workspace_prompt_context`] builds: the shell environment's calls and whether it loads the instruction
/// files; `None` for a role without tools, which keeps what it has.
fn workspace_plan<'a>(facts: &WorkspaceFacts, cwd: &'a str) -> Option<(ShellCalls<'a>, bool)> {
    (!facts.tool_free_role).then(|| (shell_calls(Some(cwd), None, facts.has_git_tool), !(facts.skip_instruction_files || facts.agent_mode)))
}
/// The rule slices of `sessionRolePromptFields` that depend on the role.
struct RoleFields {
    role_rules: String,
    lead_mode_rules: String,
    identity_context: String,
    agent_mode_rules: String,
    mixy_rules: String,
    skip_role_catalog: bool,
    skip_persona: bool,
}

fn role_fields(input: &SessionPromptInput, plan: &Plan<'_>, paths: &PromptPaths, sources: &dyn PromptSources) -> RoleFields {
    let (lead, agent_mode, agent, mixy) = (plan.lead, plan.agent_mode, plan.agent, plan.mixy);
    let include_brief = !input.delegation_free;
    let (files, root) = (paths.files, paths.plugin_root);
    let role_rules = if plan.skip_rules {
        String::new()
    } else if input.owner_is_agent {
        build_agent_role_content(files, root)
    } else {
        build_lead_role_content(files, root, include_brief, LeadPart::Common)
    };
    let mut fields = RoleFields {
        role_rules,
        lead_mode_rules: String::new(),
        identity_context: String::new(),
        agent_mode_rules: String::new(),
        mixy_rules: String::new(),
        skip_role_catalog: plan.skip_role_catalog,
        skip_persona: plan.skip_role_catalog,
    };
    if lead {
        let identity = if agent_mode {
            sources.agent_mode_identity_line(agent.unwrap_or(MIXY_AGENT_ID))
        } else {
            build_lead_role_content(files, root, include_brief, LeadPart::Identity)
        };
        fields.lead_mode_rules = build_lead_role_content(files, root, include_brief, if agent_mode { LeadPart::Agent } else { LeadPart::Coding });
        if !identity.is_empty() {
            fields.identity_context = format!("# Identity\n\n{identity}");
        }
    }
    if agent_mode {
        fields.agent_mode_rules = build_agent_mode_content(files, root, "conduct");
        if mixy {
            fields.mixy_rules = build_agent_mode_content(files, root, "mixy");
        }
    }
    fields
}

/// `composeSessionSystem` + `seedSessionMessages` (without the reference-files messages, which
/// are conversation rows): the four blocks and the prompt's header fields.
pub fn compose_session_prompt(input: &SessionPromptInput, paths: &PromptPaths, sources: &dyn PromptSources) -> SessionPrompt {
    let plan = Plan::of(input);
    let injected_rules = if plan.skip_rules {
        String::new()
    } else {
        build_base_rules(paths.files, paths.plugin_root, input.provider, input.model, input.rule_omit_tools, input.allow_tools, input.owner_is_agent)
    };
    let role = role_fields(input, &plan, paths, sources);
    let lead_only = plan.lead;
    let lead_paths = LeadPaths { plugin_root: paths.plugin_root, data_dir: paths.data_dir, config: input.config, files: paths.files };
    let include_style = plan.include_style;
    let meta_context = if lead_only { build_lead_meta_content(&lead_paths, include_style) } else { String::new() };
    let locale = sources.system_locale();
    let language_context = if lead_only { build_lead_language_content(&lead_paths, include_style, &locale) } else { String::new() };
    let shell_environment = match plan.shell {
        Some(calls) => shell_environment_context(calls, input.cwd_startup_entries, input.owner_is_agent, input.session_id, sources),
        None => String::new(),
    };
    let environment_tail =
        [shell_environment.as_str(), language_context.as_str()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(PART_SEPARATOR);
    let config_mode = plan.config_mode;
    let instruction_files = match plan.instructions {
        Instructions::None => String::new(),
        Instructions::Given(text) => text.to_owned(),
        Instructions::Load => sources.instruction_files(config_mode, input.cwd),
    };
    let part = |text| if input.owner_is_agent { "" } else { text };
    // A delegated worker gets no workflow pack (owner-approved difference from Node, B-12): its own rules carry the approval policy.
    let workflow = part(input.workflow_context);
    let slices = Slices {
        skip: input.profile_skip,
        agent_rules: &injected_rules,
        meta_context: &meta_context,
        skill_manifest: input.skill_manifest,
        deferred_tool_manifest: "",
        skip_role_catalog: role.skip_role_catalog,
        skip_persona: role.skip_persona,
        agent: input.agent,
        provider: Some(input.provider),
        workflow_context: workflow,
        role_rules: &role.role_rules,
        orchestration_context: part(input.orchestration_context),
        lead_mode_rules: &role.lead_mode_rules,
        agent_mode_rules: &role.agent_mode_rules,
        agent_catalog_context: part(input.agent_catalog_context),
        mixy_rules: &role.mixy_rules,
        contact_catalog_context: part(input.contact_catalog_context),
        identity_context: &role.identity_context,
        user_prompt: input.system_prompt,
        instruction_files_context: &instruction_files,
        core_memory_context: input.core_memory_context,
        session_start_context: "",
        environment_context: &shell_environment,
        language_context: &language_context,
    };
    let composed = compose_system_prompt(&slices, sources);

    let coding_lead = !input.owner_is_agent && !input.agent_mode;
    let response_language = if lead_only {
        build_lead_language(&lead_paths, &locale).map_or(Value::Null, |(id, name)| serde_json::json!({ "id": id, "name": name }))
    } else {
        Value::Null
    };
    let sections = OwnedSections {
        meta: meta_context,
        workflow: workflow.to_owned(),
        workflow_name: None,
        orchestration: if coding_lead { input.orchestration_context.to_owned() } else { String::new() },
        orchestration_mode: if coding_lead { input.orchestration_mode.to_owned() } else { String::new() },
        skills: input.skill_manifest.to_owned(),
        language: language_context,
        instruction_files: if input.profile_skip.claudemd { String::new() } else { instruction_files },
        core_memory: if input.profile_skip.memory { String::new() } else { input.core_memory_context.to_owned() },
        instruction_files_mode: sources.instruction_files_mode(config_mode),
        response_language: response_language.clone(),
    };
    let some = |text: String| (!text.is_empty()).then_some(text);
    SessionPrompt {
        blocks: SystemBlocks {
            base: some(composed.base_rules),
            stable: some(composed.stable_system_context),
            core: some(composed.session_marker_core),
            env: some(composed.session_environment),
            combined: false,
        },
        environment_tail,
        prompt_identity: prompt_identity(input),
        prompt_settings: sections.record(),
        sections,
        response_language,
        profile_revision: String::new(),
    }
}

fn prompt_identity(input: &SessionPromptInput) -> Value {
    let mut identity = Map::new();
    identity.insert("systemPrompt".into(), Value::String(input.system_prompt.to_owned()));
    identity.insert("skipAgentRules".into(), Value::Bool(input.skip_agent_rules));
    let mut skip = Map::new();
    for (key, on) in [("skills", input.profile_skip.skills), ("claudemd", input.profile_skip.claudemd), ("memory", input.profile_skip.memory)] {
        if on {
            skip.insert(key.into(), Value::Bool(true));
        }
    }
    identity.insert("profileSkip".into(), Value::Object(skip));
    identity.insert("agent".into(), input.agent.map_or(Value::Null, |agent| Value::String(agent.to_owned())));
    Value::Object(identity)
}

/// A prompt change: the blocks as they are afterwards and the one header change that lands it
/// (the blocks that differ, plus the header fields the rewrite touches).
#[derive(Debug, Clone, PartialEq)]
pub struct PromptPatch {
    pub blocks: SystemBlocks,
    pub change: HeaderChange,
}

fn merge(mut into: HeaderChange, other: HeaderChange) -> HeaderChange {
    for (key, value) in other.set {
        into.unset.retain(|k| *k != key);
        into.set.insert(key, value);
    }
    for key in other.unset {
        into.set.shift_remove(&key);
        if !into.unset.contains(&key) {
            into.unset.push(key);
        }
    }
    into
}

fn patch_of(blocks: &SystemBlocks, rewrite: PromptRewrite) -> PromptPatch {
    let mut next = blocks.clone();
    if let Some(core) = rewrite.tier3 {
        next.core = Some(core);
    }
    if let Some(env) = rewrite.env {
        next.env = Some(env);
    }
    let change = merge(rewrite.change, next.change_from(blocks));
    PromptPatch { blocks: next, change }
}

/// `refreshSessionBp3Environment(session, session.cwd)` for the header's own cwd: the `env`
/// block becomes the `# Session` block followed by the environment tail. A staged workspace
/// re-root keeps the block rooted where it was.
pub fn refresh_environment(header: &Header, blocks: &SystemBlocks) -> PromptPatch {
    route_prompt(header, blocks, false)
}

/// What `updateSessionRoute` does to the prompt (`session-lifecycle.mjs:517-518`): on a changed
/// route a staged re-root is applied first, then the `# Session` block is rebuilt.
pub fn route_prompt(header: &Header, blocks: &SystemBlocks, route_changed: bool) -> PromptPatch {
    let rewrite = route_prompt_refresh(&PromptView { header, tier3: blocks.core.as_deref(), env: blocks.env.as_deref() }, route_changed);
    patch_of(blocks, rewrite)
}

/// `presentedWorkspace(session)` (`prompt-utils.mjs:323`) of a session header: the workspace its
/// system prompt presents, `{cwd, environmentContext, coreMemoryContext, instructionFilesContext}`.
/// A pure read of the `tier3` and `env` blocks and `bp3EnvironmentContext`/`bp3CoreContext`.
pub fn presented_workspace_of(header: &Header) -> Value {
    let blocks = SystemBlocks::from_header(header);
    mixdog_core_session::session::worktree::presented_workspace(&PromptView { header, tier3: blocks.core.as_deref(), env: blocks.env.as_deref() })
}

/// `resetSessionBp3Environment(session)` for a cleared conversation: a staged re-root is applied
/// now (core, environment tail and cwd slices), then the `env` block is the environment tail
/// alone (no `# Session` block) and `sessionStartMetaInjected` is false, so the next ask adds the
/// block again. A session without an `env` block or a tail only gets the re-root, as in Node.
pub fn reset_environment(header: &Header, blocks: &SystemBlocks) -> PromptPatch {
    let mut next = blocks.clone();
    let mut change = HeaderChange::default();
    if pending_workspace_reroot(header).is_some() {
        let rewrite = route_prompt_refresh(&PromptView { header, tier3: blocks.core.as_deref(), env: blocks.env.as_deref() }, true);
        change = rewrite.change;
        // The re-root's own `# Session` refresh is not part of a reset.
        change.set.shift_remove("sessionStartMetaInjected");
        if let Some(core) = rewrite.tier3 {
            next.core = Some(core);
        }
    }
    let tail = change.set.get("bp3EnvironmentContext").or_else(|| header.get("bp3EnvironmentContext")).and_then(Value::as_str);
    if blocks.combined {
        // Legacy combined layout: the one `tier3` message is core + environment, no `# Session`
        // block (`resetSessionBp3Environment`, `prompt-utils.mjs:585-590`).
        let core = change.set.get("bp3CoreContext").or_else(|| header.get("bp3CoreContext")).and_then(Value::as_str);
        if let (Some(_), Some(core)) = (&blocks.core, core) {
            let parts = [core, tail.unwrap_or_default()];
            next.core = Some(parts.iter().map(|part| js_trim(part)).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(PART_SEPARATOR));
            if header.get("sessionStartMetaInjected") != Some(&Value::Bool(false)) {
                change.set.insert("sessionStartMetaInjected".into(), Value::Bool(false));
            }
        }
    } else if let (Some(_), Some(tail)) = (&blocks.env, tail) {
        next.env = Some(js_trim(tail).to_owned());
        if header.get("sessionStartMetaInjected") != Some(&Value::Bool(false)) {
            change.set.insert("sessionStartMetaInjected".into(), Value::Bool(false));
        }
    }
    let change = merge(change, next.change_from(blocks));
    PromptPatch { blocks: next, change }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Sources;

    impl PromptSources for Sources {
        fn role_catalog(&self, _: Option<&str>, _: Option<&str>) -> String {
            String::new()
        }
        fn mixy_role_section(&self) -> String {
            String::new()
        }
        fn persona_section(&self, _: &str) -> String {
            String::new()
        }
        fn agent_mode_identity_line(&self, _: &str) -> String {
            String::new()
        }
        fn shell_name(&self) -> &'static str {
            "Bash"
        }
        fn scratch_dir(&self, _: &str) -> Option<String> {
            None
        }
        fn shell_tools_line(&self) -> String {
            String::new()
        }
        fn git_line(&self, _: Option<&str>) -> String {
            String::new()
        }
        fn cwd_entries(&self, _: &str) -> String {
            String::new()
        }
        fn instruction_files(&self, config_mode: Option<&Value>, _: Option<&str>) -> String {
            config_mode.and_then(Value::as_str).map_or_else(String::new, |mode| format!("files:{mode}"))
        }
        fn instruction_files_mode(&self, config_mode: Option<&Value>) -> String {
            config_mode.and_then(Value::as_str).map_or_else(String::new, |mode| format!("mode:{mode}"))
        }
        fn system_locale(&self) -> String {
            "en-US".into()
        }
    }

    fn compose(input: &SessionPromptInput) -> SessionPrompt {
        let paths =
            PromptPaths { plugin_root: Path::new("/no-rules"), data_dir: Path::new("/no-data"), files: &mixdog_core_prompt::prompt::source_files::LiveFiles };
        compose_session_prompt(input, &paths, &Sources)
    }

    #[test]
    fn a_lead_session_without_rules_carries_its_sections_identity_and_environment() {
        let config = json!({ "instructionFiles": "all" });
        let input = SessionPromptInput {
            session_id: "s1",
            provider: "openai",
            model: "m",
            skip_agent_rules: true,
            cwd: Some("/work"),
            cwd_startup_entries: Some("- listing"),
            config: Some(&config),
            workflow_context: "wf",
            orchestration_context: "orch",
            orchestration_mode: "auto",
            core_memory_context: "mem",
            skill_manifest: "skills",
            system_prompt: "be brief",
            profile_skip: ProfileSkip { memory: true, ..ProfileSkip::default() },
            ..SessionPromptInput::default()
        };
        let prompt = compose(&input);
        let environment = "- Relative paths and shell commands resolve in the active Project shown by Session Cwd.\n\
                           - Shell: Bash. Use Bash syntax unless the user specifies otherwise.\n\
                           - listing";
        assert_eq!(prompt.environment_tail, environment);
        assert_eq!(prompt.blocks.env.as_deref(), Some(environment));
        assert_eq!(prompt.blocks.base, None);
        let core = prompt.blocks.core.as_deref().unwrap();
        assert!(core.contains("wf") && core.contains("be brief") && core.contains("files:all") && !core.contains("mem"), "{core}");
        assert_eq!(prompt.prompt_identity, json!({ "systemPrompt": "be brief", "skipAgentRules": true, "profileSkip": { "memory": true }, "agent": null }));
        let sections = &prompt.sections;
        assert_eq!(
            (sections.workflow.as_str(), sections.orchestration.as_str(), sections.orchestration_mode.as_str(), sections.skills.as_str()),
            ("wf", "orch", "auto", "skills")
        );
        assert_eq!((sections.instruction_files.as_str(), sections.instruction_files_mode.as_str()), ("files:all", "mode:all"));
        assert_eq!((sections.core_memory.as_str(), sections.meta.as_str(), sections.language.as_str()), ("", "", ""));
        assert_eq!(prompt.response_language, Value::Null);
        assert_eq!(prompt.prompt_settings, sections.record());
    }

    #[test]
    fn a_delegated_workers_prompt_carries_no_workflow_or_orchestration() {
        let input = SessionPromptInput {
            session_id: "s1",
            owner_is_agent: true,
            skip_agent_rules: true,
            workflow_context: "wf",
            orchestration_context: "orch",
            orchestration_mode: "auto",
            ..SessionPromptInput::default()
        };
        let sections = compose(&input).sections;
        assert_eq!((sections.workflow.as_str(), sections.orchestration.as_str(), sections.orchestration_mode.as_str()), ("", "", ""));
    }
}
