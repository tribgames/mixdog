//! Node's recording `fixtures/agent-home-cases/golden.json` (`record-agent-home-cases.mjs`), case 2: the role fields
//! of a session's prompt (`sessionRolePromptFields`), read when the test runs and decoded with [`Exact`]. Each recorded
//! identity goes through [`role_fields`], the slice [`compose_session_prompt`](super::compose_session_prompt) builds
//! the role part of every new session's prompt from, and the whole recorded value is compared.
//!
//! Node's object is written from the Rust fields: `leadModeRules` / `identityContext` and `agentModeRules` /
//! `mixyRules` are keys only a Lead's (and an agent-mode Lead's) prompt has, written here when Rust built them;
//! `userPrompt` and `profile.skip` echo the identity's `systemPrompt` and `profileSkip`, which the recorder left out.

use std::path::Path;

use mixdog_testkit::Exact;
use serde_json::{Map, Value, json};

use super::{PromptPaths, PromptSources, SessionPromptInput, role_fields};

/// The role fields of a session whose rules are skipped read no source.
struct NoSources;

impl PromptSources for NoSources {
    fn role_catalog(&self, _: Option<&str>, _: Option<&str>) -> String {
        unreachable!("role_catalog")
    }
    fn mixy_role_section(&self) -> String {
        unreachable!("mixy_role_section")
    }
    fn persona_section(&self, _: &str) -> String {
        unreachable!("persona_section")
    }
    fn agent_mode_identity_line(&self, _: &str) -> String {
        unreachable!("agent_mode_identity_line")
    }
    fn shell_name(&self) -> &'static str {
        unreachable!("shell_name")
    }
    fn scratch_dir(&self, _: &str) -> Option<String> {
        unreachable!("scratch_dir")
    }
    fn shell_tools_line(&self) -> String {
        unreachable!("shell_tools_line")
    }
    fn git_line(&self, _: Option<&str>) -> String {
        unreachable!("git_line")
    }
    fn cwd_entries(&self, _: &str) -> String {
        unreachable!("cwd_entries")
    }
    fn instruction_files(&self, _: Option<&Value>, _: Option<&str>) -> String {
        unreachable!("instruction_files")
    }
    fn instruction_files_mode(&self, _: Option<&Value>) -> String {
        unreachable!("instruction_files_mode")
    }
    fn system_locale(&self) -> String {
        unreachable!("system_locale")
    }
}

#[test]
fn a_home_threads_prompt_carries_its_agents_role_and_a_leads_does_not() {
    let golden = Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-home-cases/golden.json"));
    let name = "a home thread's prompt carries its agent's role; a Lead's does not";
    let case = &golden.get("cases").as_array()[2];
    assert_eq!(case.get("case").as_str(), name);
    let want = case.get("observed");
    let options = want.get("options");
    let paths = PromptPaths { plugin_root: Path::new(""), data_dir: Path::new("") };
    let mut fields = Vec::new();
    for recorded in want.get("fields").as_array() {
        let agent = match recorded.get("agent") {
            Exact::Null => None,
            other => Some(other.as_str()),
        };
        let skip_agent_rules = recorded.get("skipAgentRules").as_bool();
        let input = SessionPromptInput {
            agent,
            skip_agent_rules,
            owner_is_agent: options.get("ownerIsAgent").as_bool(),
            tool_free_role: options.get("toolFreeRole").as_bool(),
            delegation_free: options.get("delegationFree").as_bool(),
            ..SessionPromptInput::default()
        };
        let role = role_fields(&input, &paths, &NoSources);
        let mut result = vec![("roleRules".to_owned(), Exact::String(role.role_rules))];
        for (key, text) in [
            ("leadModeRules", role.lead_mode_rules),
            ("identityContext", role.identity_context),
            ("agentModeRules", role.agent_mode_rules),
            ("mixyRules", role.mixy_rules),
        ] {
            if !text.is_empty() {
                result.push((key.to_owned(), Exact::String(text)));
            }
        }
        result.extend([
            ("userPrompt".to_owned(), Exact::Undefined),
            ("skipRoleCatalog".to_owned(), Exact::Bool(role.skip_role_catalog)),
            ("skipPersona".to_owned(), Exact::Bool(role.skip_persona)),
            ("agent".to_owned(), agent.map_or(Exact::Null, |agent| Exact::String(agent.to_owned()))),
            ("profile".to_owned(), Exact::Object(vec![("skip".to_owned(), Exact::Undefined)])),
        ]);
        fields.push(Exact::Object(vec![
            ("agent".to_owned(), recorded.get("agent").clone()),
            ("skipAgentRules".to_owned(), Exact::Bool(skip_agent_rules)),
            ("result".to_owned(), Exact::Object(result)),
        ]));
    }
    let options: Map<String, Value> = options.to_plain().unwrap().as_object().unwrap().clone();
    let got = Exact::Object(vec![("options".to_owned(), Exact::plain(&json!(options))), ("fields".to_owned(), Exact::Array(fields))]);
    assert!(got == *want, "{name}: {got:?}");
}
