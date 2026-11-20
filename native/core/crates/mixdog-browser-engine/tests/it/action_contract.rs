//! The engine's action registry is the command contract of the `browser` and `browser_devtools` tools: the two tools offer
//! between them exactly the actions the engine can run, each once, and every one parses.

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

/// A host nothing is asked of: the tools are built only to read their specs.
struct NoHost;

#[async_trait]
impl HostCommands for NoHost {
    async fn browser(&self, _thread: &ThreadId, _action: &str, _input: JsonValue, _cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        unreachable!("the contract test never calls a tool")
    }

    async fn visualize(
        &self,
        _thread: &ThreadId,
        _cwd: &str,
        _action: &str,
        _input: JsonValue,
        _cancel: &CancellationToken,
    ) -> Result<JsonValue, HostCommandError> {
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
fn the_two_browser_tools_offer_exactly_the_actions_the_engine_registers() {
    let host: Arc<dyn HostCommands> = Arc::new(NoHost);
    let browser = schema_actions(&BrowserTool::browser(host.clone()));
    let devtools = schema_actions(&BrowserTool::devtools(host));
    let offered: Vec<&str> = browser.iter().chain(&devtools).map(String::as_str).collect();
    let offered_set: BTreeSet<&str> = offered.iter().copied().collect();
    assert_eq!(offered_set.len(), offered.len(), "an action is offered by both tools or twice");

    let registry: Vec<&str> = Action::ALL.iter().map(|action| action.name()).collect();
    let registry_set: BTreeSet<&str> = registry.iter().copied().collect();
    assert_eq!(registry_set.len(), registry.len(), "the registry names an action twice");
    assert_eq!(registry_set, offered_set, "the registry and the two tools' action enums differ");
}

#[test]
fn every_registered_name_parses_ignoring_case_and_surrounding_space_and_an_unknown_one_does_not() {
    for action in Action::ALL {
        assert_eq!(Action::parse(action.name()), Some(*action));
        assert_eq!(Action::parse(&format!("  {}\n", action.name().to_uppercase())), Some(*action), "{}", action.name());
        assert!(is_action(action.name()));
    }
    assert_eq!(Action::parse("definitely_not_an_action"), None);
    assert!(!is_action("definitely_not_an_action"));
}

#[test]
fn the_actions_that_address_the_session_and_never_a_page_are_exactly_the_marked_ones() {
    for name in TABLESS_ACTIONS {
        assert!(Action::parse(name).is_some_and(Action::is_tabless), "{name}");
    }
    assert_eq!(Action::ALL.iter().filter(|action| action.is_tabless()).count(), TABLESS_ACTIONS.len());
}
