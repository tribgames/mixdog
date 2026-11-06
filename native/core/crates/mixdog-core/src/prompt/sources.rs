//! What the composition reads from outside the session. Each method is one Node loader,
//! answered as that loader answers (a missing file reads as the empty string, never an error).

use serde_json::Value;

pub trait PromptSources {
    /// `loadScopedRoleInstructions(agent, provider)` (`role-instructions.mjs`): the
    /// `# Agent Role Catalog` / `# Agent Role Rules` text for the agent.
    fn role_catalog(&self, agent: Option<&str>, provider: Option<&str>) -> String;
    /// `loadMixyRoleSection()`: Mixy's own `AGENT.md` as a one-role catalog.
    fn mixy_role_section(&self) -> String;
    /// `loadAgentPersonaSection(agent)`: the `## Persona` section of `PERSONA.md`.
    fn persona_section(&self, agent: &str) -> String;
    /// `agentModeIdentityLine(agent)`: `You are <name>…`.
    fn agent_mode_identity_line(&self, agent: &str) -> String;

    /// `process.platform === 'win32' ? 'PowerShell' : 'Bash'`.
    fn shell_name(&self) -> &'static str;
    /// `sessionScratchDir(sessionId)`, the session's scratch directory.
    fn scratch_dir(&self, session_id: &str) -> Option<String>;
    /// `describeShellToolsStartupState()`; empty when unknown.
    fn shell_tools_line(&self) -> String;
    /// `describeGitStartupState({ cwd })`; `None` is the process's own directory.
    fn git_line(&self, cwd: Option<&str>) -> String;
    /// `describeCwdStartupEntries({ cwd })`.
    fn cwd_entries(&self, cwd: &str) -> String;

    /// `loadInstructionFilesContext({ mode, cwd })` with the mode the prompt config states
    /// (`config.instructionFiles`), else the stored setting.
    fn instruction_files(&self, config_mode: Option<&Value>, cwd: Option<&str>) -> String;
    /// `normalizeInstructionFilesMode(config.instructionFiles)`, else `configuredInstructionFilesMode()`.
    fn instruction_files_mode(&self, config_mode: Option<&Value>) -> String;

    /// The host's `Intl.DateTimeFormat().resolvedOptions().locale` (the `system` response language).
    fn system_locale(&self) -> String;
}
