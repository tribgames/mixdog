//! Which tools a session is denied: the feature gates (what is installed, configured and present on the machine) and the live
//! denials a session's caller, mode and workflow add.

use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_core::run_host::workflow_surface::denials::FeatureFacts;
use mixdog_core::run_host::workflow_surface::denials::feature_disallowed_tools;
use mixdog_core::run_host::workflow_surface::denials::live_denied_tools;
use mixdog_core_config::tool_modules::Origin;
use mixdog_core_config::tool_modules::adopt;
use serde_json::Value;
use serde_json::json;

const NOTHING_PRESENT: FeatureFacts = FeatureFacts { browser: false, computer: false, terminal: false, visualize: false, git: false };

fn denied_by_features(config: Value, present: &FeatureFacts) -> Vec<String> {
    let stored = mixdog_core_config::config::agent_routes::stored_file_of(&config);
    let config = adopt(stored["agent"].as_object().expect("config"), Origin::Given);
    feature_disallowed_tools(&config, present, &|_: &str| None, ToolProfile::Interactive)
}

#[test]
fn on_a_bare_install_every_optional_tool_is_denied() {
    assert_eq!(
        denied_by_features(json!({}), &NOTHING_PRESENT),
        ["memory", "recall", "git", "github", "browser", "browser_devtools", "computer", "terminal", "office", "tidy", "visualize", "explore"]
    );
}

#[test]
fn git_on_the_path_allows_git_alone() {
    let present = FeatureFacts { git: true, ..NOTHING_PRESENT };
    assert_eq!(
        denied_by_features(json!({}), &present),
        ["memory", "recall", "github", "browser", "browser_devtools", "computer", "terminal", "office", "tidy", "visualize", "explore"]
    );
}

#[test]
fn installed_builtins_and_a_configured_explorer_leave_only_what_the_machine_lacks_denied() {
    let config = json!({
        "builtins": { "git": { "installed": true }, "memory": { "installed": true }, "office": { "installed": true }, "tidy": { "installed": true } },
        "agents": { "explore": { "provider": "openai", "model": "gpt-5" } },
    });
    let present = FeatureFacts { browser: true, computer: true, terminal: true, visualize: false, git: true };
    assert_eq!(denied_by_features(config, &present), ["visualize"]);
}

fn live(session: Value, workflow: Value, features: &[&str]) -> Result<Vec<String>, String> {
    let features: Vec<String> = features.iter().map(|f| (*f).to_owned()).collect();
    live_denied_tools(session.as_object().expect("session"), &workflow, &features).map_err(|error| format!("{error:?}"))
}

fn builtin_default() -> Value {
    json!({ "id": "default", "name": "Default", "description": "", "source": "built-in", "delegatesAgents": false })
}

fn delegating() -> Value {
    json!({ "id": "review", "name": "Review", "description": "", "source": "user", "delegatesAgents": true })
}

#[test]
fn a_coding_session_is_denied_its_callers_tools_the_features_and_the_reaction_tool() {
    let session = json!({ "id": "sess_task", "callerDisallowedTools": ["get_goal", "create_goal"] });
    assert_eq!(live(session, delegating(), &["web_search"]).unwrap(), ["get_goal", "create_goal", "web_search", "react"]);
    assert_eq!(live(json!({ "id": "sess_task", "callerDisallowedTools": [] }), builtin_default(), &[]).unwrap(), ["react"]);
}

#[test]
fn a_bots_home_chat_may_react_but_is_denied_delegating_unless_its_workflow_delegates() {
    let home = json!({ "id": "sess_home_botty", "callerDisallowedTools": [] });
    assert_eq!(live(home, builtin_default(), &[]).unwrap(), ["agent"], "a workflow that delegates to no agent keeps the agent tool away");
    assert_eq!(
        live(json!({ "id": "sess_home_botty", "callerDisallowedTools": ["get_goal"] }), delegating(), &["memory", "recall"]).unwrap(),
        ["get_goal", "memory", "recall"]
    );
    let stored_as_coding = json!({ "id": "sess_home_botty", "sessionMode": "coding", "callerDisallowedTools": [] });
    assert_eq!(live(stored_as_coding, builtin_default(), &[]).unwrap(), Vec::<String>::new(), "a home thread stored as a coding session is one");
}

#[test]
fn a_workflow_that_names_its_agents_denies_the_agent_tool_when_it_names_none() {
    let coding = json!({ "id": "sess_task", "callerDisallowedTools": [] });
    let named = |agents: Value| json!({ "id": "x", "name": "X", "agentsConfigured": true, "agents": agents });
    assert_eq!(live(coding.clone(), named(json!([])), &[]).unwrap(), ["agent", "react"]);
    assert_eq!(live(coding, named(json!(["worker"])), &[]).unwrap(), ["react"]);
}

#[test]
fn a_session_without_a_list_of_caller_denials_is_an_error_not_an_empty_list() {
    for caller in [None, Some(json!(null)), Some(json!(3)), Some(json!({ "a": 1 })), Some(json!(true))] {
        let mut session = json!({ "id": "sess_task" });
        if let Some(caller) = &caller {
            session["callerDisallowedTools"] = caller.clone();
        }
        assert!(live(session, delegating(), &[]).is_err(), "{caller:?}");
    }
}
