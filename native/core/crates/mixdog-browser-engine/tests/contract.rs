//! The engine's action registry is the command contract of the `browser` and `browser_devtools` tools: the same 33 names, the
//! order the recorded host corpus (`browser-golden.json`, `actions`) lists them in, and one parse for each.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_browser_engine::actions::registry::Action;
use mixdog_browser_engine::actions::registry::is_action;
use mixdog_browser_engine::limits::TABLESS_ACTIONS;
use mixdog_core_api::domain::tool::Tool;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_tools::desktop::browser::BrowserTool;
use mixdog_tools::desktop::host::HostCommandError;
use mixdog_tools::desktop::host::HostCommands;
use serde_json::Value;

/// A host nothing is asked of: the tools are built only to read their specs.
struct NoHost;

#[async_trait]
impl HostCommands for NoHost {
    async fn browser(&self, _thread: &ThreadId, _action: &str, _input: JsonValue, _cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        unreachable!("the contract test never calls a tool")
    }

    async fn visualize(&self, _thread: &ThreadId, _cwd: &str, _action: &str, _input: JsonValue, _cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        unreachable!("the contract test never calls a tool")
    }
}

/// The names in the `action` enum of a tool's input schema.
fn schema_actions(tool: &BrowserTool) -> Vec<String> {
    let schema = &tool.spec().input_schema;
    schema["properties"]["action"]["enum"]
        .as_array()
        .unwrap_or_else(|| panic!("{} has no action enum", tool.spec().name))
        .iter()
        .map(|name| name.as_str().expect("an action name").to_owned())
        .collect()
}

#[test]
fn registry_matches_tool_contracts() {
    let host: Arc<dyn HostCommands> = Arc::new(NoHost);
    let browser = schema_actions(&BrowserTool::browser(host.clone()));
    let devtools = schema_actions(&BrowserTool::devtools(host));
    let contract: Vec<&str> = browser.iter().chain(&devtools).map(String::as_str).collect();
    let contract_set: BTreeSet<&str> = contract.iter().copied().collect();
    assert_eq!(contract_set.len(), contract.len(), "an action is offered by both tools or twice");

    let registry: Vec<&str> = Action::ALL.iter().map(|action| action.name()).collect();
    let registry_set: BTreeSet<&str> = registry.iter().copied().collect();
    assert_eq!(registry_set.len(), registry.len(), "the registry names an action twice");
    assert_eq!(registry_set, contract_set, "the registry and the two tools' action enums differ");

    // The corpus lists the contract's actions in the order the host's contract table does.
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/desktop-host/browser-golden.json")).expect("browser-golden.json is JSON");
    let recorded: Vec<&str> = golden["actions"].as_array().expect("the corpus lists its actions").iter().map(|name| name.as_str().expect("an action name")).collect();
    assert_eq!(registry, recorded, "the registry order differs from the recorded contract");

    for action in Action::ALL {
        assert_eq!(Action::parse(action.name()), Some(*action));
        assert_eq!(Action::parse(&format!("  {}\n", action.name().to_uppercase())), Some(*action), "{}", action.name());
        assert!(is_action(action.name()));
    }
    assert_eq!(Action::parse("definitely_not_an_action"), None);
    assert!(!is_action("definitely_not_an_action"));

    // The actions that address the session and never a page are exactly the ones the registry marks.
    for name in TABLESS_ACTIONS {
        assert!(Action::parse(name).is_some_and(Action::is_tabless), "{name}");
    }
    assert_eq!(Action::ALL.iter().filter(|action| action.is_tabless()).count(), TABLESS_ACTIONS.len());
}
