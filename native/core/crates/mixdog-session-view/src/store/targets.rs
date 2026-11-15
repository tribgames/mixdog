//! The session actions the router (`action_route`) has no row for, and what each is on the wire: a method of its own shape, or a
//! section the core publishes (desktop `service-route.ts`, `capability-route.ts` and `section-capabilities.ts` are the same maps for
//! the desktop's capability calls). `fast_on` is the session's present fast mode, which `toggleFast` flips.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::action_route::Resolved;

/// Where a session action without a router row goes.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// One protocol request.
    Method(Resolved),
    /// The value of a published section entry; `refresh` is the recompute requested first (`account/refreshProviderSetup` params).
    Section { section: &'static str, key: Option<String>, refresh: Option<Value> },
}

fn method(name: &str, params: Value) -> Option<Target> {
    Some(Target::Method(Resolved { method: name.to_owned(), params }))
}

/// The pairs whose value is present and not null.
fn given(pairs: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(pairs.into_iter().filter_map(|(key, value)| value.filter(|v| !v.is_null()).map(|v| (key.to_owned(), v))).collect())
}

fn at(args: &[Value], index: usize) -> Option<Value> {
    args.get(index).cloned()
}

fn field(options: Option<&Value>, name: &str) -> Option<Value> {
    options.and_then(|options| options.get(name)).cloned()
}

/// The options of `getProviderSetup` that ask for a recompute (`SETUP_OPTIONS` of `section-capabilities.ts`).
fn setup_refresh(args: &[Value]) -> Option<Value> {
    let options = args.first().and_then(Value::as_object)?;
    let asked: Map<String, Value> = ["force", "refresh", "unlockKeychain", "recheckKeychain"]
        .into_iter()
        .filter(|name| options.get(*name) == Some(&Value::Bool(true)))
        .map(|name| (name.to_owned(), Value::Bool(true)))
        .collect();
    (!asked.is_empty()).then_some(Value::Object(asked))
}

/// The target of `action(...args)` on `thread`, `None` when the action has none here (the router answers it, or nothing does).
pub fn target_of(action: &str, args: &[Value], thread: Option<&str>, fast_on: bool) -> Option<Target> {
    let thread_value = thread.filter(|t| !t.is_empty()).map(|t| json!(t));
    match action {
        "addProject" => method("project/create", given(vec![("path", at(args, 0))])),
        "ensureProjectDirectory" => method("project/ensureDirectory", given(vec![("path", at(args, 0))])),
        "listProjects" => method("project/list", json!({})),
        "renameProject" => method("project/update", given(vec![("path", at(args, 0)), ("alias", at(args, 1))])),
        "touchProjectSelected" => method("project/touch", given(vec![("path", at(args, 0))])),
        "setCwd" => method("thread/setCwd", given(vec![("threadId", thread_value), ("path", at(args, 0))])),
        "listSessions" => {
            let options = args.first();
            method(
                "thread/list",
                given(
                    ["archived", "cursor", "cwd", "limit", "searchTerm", "sortDirection", "sortKey"]
                        .into_iter()
                        .map(|name| (name, field(options, name)))
                        .collect(),
                ),
            )
        }
        "inheritSession" => method(
            "thread/fork",
            given(vec![("threadId", at(args, 0)), ("route", at(args, 1)), ("compact", field(args.get(2), "compact"))]),
        ),
        "setAgentRoute" => method("route/set", given(vec![("threadId", thread_value), ("agentId", at(args, 0)), ("route", at(args, 1))])),
        "toggleFast" => method("fast/set", given(vec![("threadId", thread_value), ("on", Some(Value::Bool(!fast_on)))])),
        "getOnboardingStatus" => Some(Target::Section { section: "config", key: Some("onboarding".to_owned()), refresh: None }),
        "getProviderAccounts" => {
            let key = args.first().and_then(Value::as_str)?;
            Some(Target::Section { section: "providerAccounts", key: Some(key.to_owned()), refresh: None })
        }
        "listPresets" => Some(Target::Section { section: "presets", key: None, refresh: None }),
        "listAgents" => Some(Target::Section { section: "agents", key: None, refresh: None }),
        "listWorkflows" => Some(Target::Section { section: "workflows", key: None, refresh: None }),
        "getWebSearchRoute" => Some(Target::Section { section: "webSearch", key: None, refresh: None }),
        "getProviderSetup" => Some(Target::Section { section: "providerSetup", key: None, refresh: setup_refresh(args) }),
        "listProviders" => Some(Target::Section { section: "providerSetup", key: None, refresh: None }),
        _ => None,
    }
}

/// The actions [`target_of`] answers, whatever their arguments (`typeof store[name] === 'function'` for them).
const TARGET_ACTIONS: [&str; 18] = [
    "addProject",
    "ensureProjectDirectory",
    "listProjects",
    "renameProject",
    "touchProjectSelected",
    "setCwd",
    "listSessions",
    "inheritSession",
    "setAgentRoute",
    "toggleFast",
    "getOnboardingStatus",
    "getProviderAccounts",
    "listPresets",
    "listAgents",
    "listWorkflows",
    "getWebSearchRoute",
    "getProviderSetup",
    "listProviders",
];

/// The members of the store that are not session actions: the prompt surface of `intake`.
const INTAKE_MEMBERS: [&str; 7] = ["submit", "submitAsync", "steer", "abort", "restoreQueued", "resolveToolApproval", "respondApproval"];

/// Whether the store serves `name` at all: a row of the router, a target of this table, or a member of the prompt surface. A name
/// that is none of them is no function of Node's store, and its callers take the silent `null` instead of an error.
pub fn has_action(name: &str) -> bool {
    TARGET_ACTIONS.contains(&name)
        || INTAKE_MEMBERS.contains(&name)
        || crate::action_route::session_actions().contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn method_of(target: Option<Target>) -> (String, Value) {
        match target {
            Some(Target::Method(resolved)) => (resolved.method, resolved.params),
            other => panic!("not a method: {other:?}"),
        }
    }

    #[test]
    fn a_project_action_is_its_methods_params() {
        assert_eq!(method_of(target_of("addProject", &[json!("/p")], Some("t"), false)), ("project/create".to_owned(), json!({ "path": "/p" })));
        assert_eq!(method_of(target_of("renameProject", &[json!("/p"), json!("A")], None, false)), ("project/update".to_owned(), json!({ "path": "/p", "alias": "A" })));
        assert_eq!(method_of(target_of("listProjects", &[], None, false)).0, "project/list");
    }

    #[test]
    fn the_bound_thread_is_addressed_and_toggle_fast_flips_the_mode() {
        assert_eq!(method_of(target_of("setCwd", &[json!("/w")], Some("t"), false)).1, json!({ "threadId": "t", "path": "/w" }));
        assert_eq!(method_of(target_of("toggleFast", &[], Some("t"), true)).1, json!({ "threadId": "t", "on": false }));
        assert_eq!(method_of(target_of("toggleFast", &[], Some("t"), false)).1, json!({ "threadId": "t", "on": true }));
    }

    #[test]
    fn a_session_list_keeps_the_fields_the_method_has() {
        let options = json!({ "limit": 20, "cwd": "/w", "refreshFromStorage": true });
        assert_eq!(method_of(target_of("listSessions", &[options], None, false)).1, json!({ "limit": 20, "cwd": "/w" }));
    }

    #[test]
    fn a_section_read_names_its_section_and_the_setup_recompute() {
        assert_eq!(
            target_of("getProviderSetup", &[json!({ "force": true, "other": 1 })], None, false),
            Some(Target::Section { section: "providerSetup", key: None, refresh: Some(json!({ "force": true })) })
        );
        assert_eq!(target_of("getOnboardingStatus", &[], None, false), Some(Target::Section { section: "config", key: Some("onboarding".to_owned()), refresh: None }));
        assert_eq!(target_of("getProviderAccounts", &[], None, false), None);
    }

    #[test]
    fn an_action_of_the_router_has_no_target() {
        assert_eq!(target_of("setTheme", &[], None, false), None);
    }

    #[test]
    fn the_store_serves_the_router_rows_the_targets_and_the_prompt_surface_only() {
        for name in ["setTheme", "getOnboardingStatus", "listWorkflows", "submitAsync", "contextStatus", "setRoute"] {
            assert!(has_action(name), "{name}");
        }
        assert!(!has_action("noSuchAction"));
        assert!(!has_action(""));
    }

    #[test]
    fn every_target_action_has_a_target() {
        for name in TARGET_ACTIONS {
            let args = [json!("x"), json!("y")];
            assert!(target_of(name, &args, Some("t"), false).is_some(), "{name}");
        }
    }
}
