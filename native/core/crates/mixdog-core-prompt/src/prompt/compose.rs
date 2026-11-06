//! `composeSystemPrompt` (`role-instructions.mjs`): the four blocks from their slices.
//!
//! BP1 `baseRules`, BP2 `stableSystemContext`, BP3 `sessionMarkerCore`, and the volatile
//! `sessionEnvironment`. Every slice is the text Node passes; an absent slice is the empty string.

use mixdog_js::js_trim;

use super::sources::PromptSources;

pub const PART_SEPARATOR: &str = "\n\n---\n\n";

/// `profile.skip`: buckets a profile leaves out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProfileSkip {
    pub skills: bool,
    pub claudemd: bool,
    pub memory: bool,
}

/// The options of `composeSystemPrompt`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Slices<'a> {
    pub skip: ProfileSkip,
    pub agent_rules: &'a str,
    pub meta_context: &'a str,
    pub skill_manifest: &'a str,
    pub deferred_tool_manifest: &'a str,
    pub skip_role_catalog: bool,
    pub skip_persona: bool,
    pub agent: Option<&'a str>,
    pub provider: Option<&'a str>,
    pub workflow_context: &'a str,
    pub role_rules: &'a str,
    pub orchestration_context: &'a str,
    pub lead_mode_rules: &'a str,
    pub agent_mode_rules: &'a str,
    pub agent_catalog_context: &'a str,
    pub mixy_rules: &'a str,
    pub contact_catalog_context: &'a str,
    pub identity_context: &'a str,
    pub user_prompt: &'a str,
    pub instruction_files_context: &'a str,
    pub core_memory_context: &'a str,
    pub session_start_context: &'a str,
    pub environment_context: &'a str,
    pub language_context: &'a str,
}

/// What `composeSystemPrompt` returns (`sessionMarker`, the combined legacy string, is not kept).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Composed {
    pub base_rules: String,
    pub stable_system_context: String,
    pub session_marker_core: String,
    pub session_environment: String,
}

/// `trimmedPromptSlice`.
fn trimmed(value: &str) -> &str {
    js_trim(value)
}

/// `joinPromptSlices`: `filter(Boolean)` drops only the empty strings.
fn join(parts: &[&str]) -> String {
    parts.iter().copied().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(PART_SEPARATOR)
}

pub fn compose_system_prompt(slices: &Slices, sources: &dyn PromptSources) -> Composed {
    let stable = join(&[
        trimmed(slices.meta_context),
        if slices.skip.skills { "" } else { trimmed(slices.skill_manifest) },
        trimmed(slices.deferred_tool_manifest),
    ]);

    let role_instructions = if slices.skip_role_catalog {
        String::new()
    } else if slices.agent == Some("lead") {
        sources.mixy_role_section()
    } else {
        sources.role_catalog(slices.agent.filter(|a| !a.is_empty()), slices.provider.filter(|p| !p.is_empty()))
    };
    let persona = match slices.agent.filter(|a| !a.is_empty()) {
        Some(agent) if !slices.skip_persona => sources.persona_section(agent),
        _ => String::new(),
    };
    let memory = if slices.skip.memory { "" } else { trimmed(slices.core_memory_context) };
    let instruction_files = if slices.skip.claudemd { "" } else { trimmed(slices.instruction_files_context) };
    let memory_block = if memory.is_empty() { String::new() } else { format!("# Core Memory\n{memory}") };
    let core = join(&[
        trimmed(slices.workflow_context),
        slices.role_rules,
        trimmed(slices.orchestration_context),
        slices.lead_mode_rules,
        slices.agent_mode_rules,
        trimmed(slices.agent_catalog_context),
        slices.mixy_rules,
        trimmed(slices.contact_catalog_context),
        slices.identity_context,
        slices.user_prompt,
        &role_instructions,
        &persona,
        instruction_files,
        &memory_block,
    ]);
    let environment = join(&[
        trimmed(slices.session_start_context),
        trimmed(slices.environment_context),
        trimmed(slices.language_context),
    ]);
    Composed {
        base_rules: slices.agent_rules.to_owned(),
        stable_system_context: stable,
        session_marker_core: core,
        session_environment: environment,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Files;
    impl PromptSources for Files {
        fn role_catalog(&self, agent: Option<&str>, _: Option<&str>) -> String {
            format!("catalog:{}", agent.unwrap_or("-"))
        }
        fn mixy_role_section(&self) -> String {
            "mixy".into()
        }
        fn persona_section(&self, agent: &str) -> String {
            format!("persona:{agent}")
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
        fn instruction_files(&self, _: Option<&serde_json::Value>, _: Option<&str>) -> String {
            String::new()
        }
        fn instruction_files_mode(&self, _: Option<&serde_json::Value>) -> String {
            String::new()
        }
        fn system_locale(&self) -> String {
            "en-US".into()
        }
    }

    #[test]
    fn the_slices_join_in_prefix_order_and_empty_ones_leave_no_separator() {
        let slices = Slices {
            agent_rules: "rules",
            meta_context: "  meta  ",
            skill_manifest: "skills",
            workflow_context: "wf",
            identity_context: "# Identity",
            agent: Some("worker"),
            core_memory_context: " mem ",
            environment_context: "- Cwd",
            language_context: "# Language",
            ..Slices::default()
        };
        let out = compose_system_prompt(&slices, &Files);
        assert_eq!(out.base_rules, "rules");
        assert_eq!(out.stable_system_context, "meta\n\n---\n\nskills");
        assert_eq!(
            out.session_marker_core,
            "wf\n\n---\n\n# Identity\n\n---\n\ncatalog:worker\n\n---\n\npersona:worker\n\n---\n\n# Core Memory\nmem"
        );
        assert_eq!(out.session_environment, "- Cwd\n\n---\n\n# Language");
        let skipped = Slices { skip: ProfileSkip { skills: true, memory: true, ..Default::default() }, skip_role_catalog: true, skip_persona: true, ..slices };
        let out = compose_system_prompt(&skipped, &Files);
        assert_eq!(out.stable_system_context, "meta");
        assert_eq!(out.session_marker_core, "wf\n\n---\n\n# Identity");
    }

    #[test]
    fn the_lead_reads_mixys_section_not_the_catalog() {
        let slices = Slices { agent: Some("lead"), ..Slices::default() };
        assert_eq!(compose_system_prompt(&slices, &Files).session_marker_core, "mixy\n\n---\n\npersona:lead");
    }
}
