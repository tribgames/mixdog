//! Session action to protocol request: `resolve_action(action, args, ctx)` is the one request a call of the session's finite
//! read/configure surface becomes (protocol.md section 12.2 to 12.4).
//!
//! An action is the verbatim `<namespace>/<action>` method of `action_tables::ACTION_NAMESPACES` unless it is one of the overrides
//! below, whose method or params are another shape. The positional arguments take the names of the method's params type; those
//! names are read from the generated client method table (`schema/client_methods.json`, behind `client_method_spec`) the first time
//! an action is resolved, so no second table of parameter names exists.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::action_tables::{ACTION_NAMESPACES, ARG_ORDER};

/// The generated client method table of the protocol crate: `methods[method].params.$ref` names the params type in `definitions`.
const CLIENT_METHODS_SCHEMA: &str =
    include_str!("../../mixdog-app-protocol/schema/client_methods.json");

/// What a call is bound to: the thread the view is bound to (`None` before it has one).
#[derive(Debug, Clone, Copy, Default)]
pub struct RouteContext<'a> {
    pub thread_id: Option<&'a str>,
}

/// One protocol request. The client library assigns `opId` to every mutation, so it is not set here.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub method: String,
    pub params: Value,
}

/// Why an action did not become a request.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RouteError {
    #[error("session action {action} is unavailable")]
    Unavailable { action: String },
    #[error("session action {action} has no protocol method {method}")]
    UnknownMethod { action: String, method: String },
    #[error("session action {action} takes at most {max} arguments")]
    TooManyArguments { action: String, max: usize },
}

impl RouteError {
    /// The error code the client library gives a method the protocol does not declare.
    pub fn code(&self) -> Option<&'static str> {
        matches!(self, Self::UnknownMethod { .. }).then_some("unknownMethod")
    }
}

/// The positional params of one method.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodArgs {
    /// The params type has `threadId`.
    pub thread: bool,
    /// Its named params in positional order, without `opId` and `threadId`.
    pub args: Vec<String>,
}

/// The methods the finite session surface exposes, each with its positional params.
pub fn method_args() -> &'static HashMap<String, MethodArgs> {
    static TABLE: OnceLock<HashMap<String, MethodArgs>> = OnceLock::new();
    TABLE.get_or_init(build_method_args)
}

fn build_method_args() -> HashMap<String, MethodArgs> {
    let schema: Value =
        serde_json::from_str(CLIENT_METHODS_SCHEMA).expect("client_methods.json is valid JSON");
    let definitions = &schema["definitions"];
    let mut table = HashMap::new();
    for (namespace, actions) in ACTION_NAMESPACES {
        for action in *actions {
            let method = format!("{namespace}/{action}");
            if mixdog_app_protocol::client_method_spec(&method).is_none() {
                continue;
            }
            let Some(reference) = schema["methods"][&method]["params"]["$ref"].as_str() else {
                continue;
            };
            let Some(fields) =
                definitions[reference.rsplit('/').next().unwrap_or_default()]["properties"]
                    .as_object()
            else {
                continue;
            };
            let mut args: Vec<String> = fields
                .keys()
                .filter(|k| *k != "opId" && *k != "threadId")
                .cloned()
                .collect();
            args.sort();
            if let Some((_, order)) = ARG_ORDER.iter().find(|(m, _)| *m == method) {
                args = order.iter().map(|s| (*s).to_string()).collect();
            }
            table.insert(
                method,
                MethodArgs {
                    thread: fields.contains_key("threadId"),
                    args,
                },
            );
        }
    }
    table
}

fn namespace_of() -> &'static HashMap<&'static str, &'static str> {
    static TABLE: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    TABLE.get_or_init(|| {
        ACTION_NAMESPACES
            .iter()
            .flat_map(|(namespace, actions)| {
                actions.iter().map(move |action| (*action, *namespace))
            })
            .collect()
    })
}

/// The actions whose method or params are not the verbatim form, in the order `resolve_action` checks them.
const OVERRIDES: &[&str] = &[
    "clear",
    "compact",
    "rewindToItem",
    "renameSessionTitle",
    "deleteSession",
    "deleteSessionIfIdle",
    "stopShellJob",
    "releaseShellJob",
    "stopShellJobs",
    "scheduleQuotaResume",
    "cancelQuotaResume",
    "retryFailedTurn",
    "continueSessionInModel",
    "inheritFrom",
    "goalControl",
    "listProviderModels",
    "setFast",
    "setRoute",
];

/// Every finite session action a view exposes as an async method: the namespaces' actions, then the overrides not among them.
pub fn session_actions() -> Vec<&'static str> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (_, actions) in ACTION_NAMESPACES {
        for action in *actions {
            if seen.insert(*action) {
                out.push(*action);
            }
        }
    }
    for action in OVERRIDES {
        if seen.insert(*action) {
            out.push(*action);
        }
    }
    out
}

/// `{ method, params }` for `action(...args)` on the thread the view is bound to. A method the protocol table does not declare is
/// an `UnknownMethod` error, raised before anything is sent.
pub fn resolve_action(
    action: &str,
    args: &[Value],
    ctx: &RouteContext<'_>,
) -> Result<Resolved, RouteError> {
    if let Some(resolved) = override_of(action, args, ctx) {
        return Ok(resolved);
    }
    let Some(namespace) = namespace_of().get(action) else {
        return Err(RouteError::Unavailable {
            action: action.to_string(),
        });
    };
    let method = format!("{namespace}/{action}");
    let Some(spec) = method_args().get(&method) else {
        return Err(RouteError::UnknownMethod {
            action: action.to_string(),
            method,
        });
    };
    if args.len() > spec.args.len() {
        return Err(RouteError::TooManyArguments {
            action: action.to_string(),
            max: spec.args.len(),
        });
    }
    let mut params = Map::new();
    if let (true, Some(thread)) = (spec.thread, thread_of(ctx)) {
        params.insert("threadId".into(), Value::String(thread.to_string()));
    }
    for (name, value) in spec.args.iter().zip(args) {
        params.insert(name.clone(), value.clone());
    }
    Ok(Resolved {
        method,
        params: Value::Object(params),
    })
}

/// A call's thread when it has one (an empty id is none).
fn thread_of<'a>(ctx: &RouteContext<'a>) -> Option<&'a str> {
    ctx.thread_id.filter(|t| !t.is_empty())
}

/// `{ k: v, ... }` of the pairs whose value is present.
fn defined(pairs: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_string(), v)))
            .collect(),
    )
}

fn arg(args: &[Value], index: usize) -> Option<Value> {
    args.get(index).cloned()
}

/// A plain object argument, `{}` for anything else.
fn object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn thread_value(ctx: &RouteContext<'_>) -> Option<Value> {
    ctx.thread_id.map(|t| Value::String(t.to_string()))
}

fn request(method: &str, params: Value) -> Option<Resolved> {
    Some(Resolved {
        method: method.to_string(),
        params,
    })
}

fn override_of(action: &str, args: &[Value], ctx: &RouteContext<'_>) -> Option<Resolved> {
    let thread = thread_value(ctx);
    match action {
        "clear" => request("thread/clear", defined(vec![("threadId", thread)])),
        "compact" => request(
            "thread/compact/start",
            defined(vec![("threadId", thread), ("options", arg(args, 0))]),
        ),
        "rewindToItem" => {
            let restore = object(args.get(1))
                .get("restoreFiles")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::Bool(true));
            request(
                "thread/rewind",
                defined(vec![
                    ("threadId", thread),
                    ("itemId", arg(args, 0)),
                    ("restoreFiles", Some(restore)),
                ]),
            )
        }
        "renameSessionTitle" => request(
            "thread/name/set",
            defined(vec![("threadId", arg(args, 0)), ("title", arg(args, 1))]),
        ),
        "deleteSession" => request("thread/delete", defined(vec![("threadId", arg(args, 0))])),
        "deleteSessionIfIdle" => request(
            "thread/delete",
            defined(vec![("threadId", arg(args, 0)), ("ifIdle", arg(args, 1))]),
        ),
        "stopShellJob" => request(
            "thread/backgroundTerminals/terminate",
            defined(vec![("threadId", thread), ("taskId", arg(args, 0))]),
        ),
        "releaseShellJob" => request(
            "thread/backgroundTerminals/release",
            defined(vec![("threadId", thread), ("taskId", arg(args, 0))]),
        ),
        "stopShellJobs" => request(
            "thread/backgroundTerminals/clean",
            defined(vec![("threadId", thread)]),
        ),
        "scheduleQuotaResume" => request(
            "thread/quotaResume/schedule",
            defined(vec![("threadId", arg(args, 0))]),
        ),
        "cancelQuotaResume" => request(
            "thread/quotaResume/cancel",
            defined(vec![("threadId", arg(args, 0))]),
        ),
        "retryFailedTurn" => request(
            "turn/retryFailed",
            defined(vec![("threadId", arg(args, 0)), ("turnKey", arg(args, 1))]),
        ),
        "continueSessionInModel" => request(
            "thread/continueInModel",
            defined(vec![("threadId", arg(args, 0)), ("route", arg(args, 1))]),
        ),
        // The bound thread is the already-created heir; the source is the argument.
        "inheritFrom" => {
            let options = object(args.get(1));
            request(
                "thread/fork",
                defined(vec![
                    ("threadId", arg(args, 0)),
                    ("intoThreadId", thread),
                    ("route", options.get("route").cloned()),
                    ("compact", options.get("compact").cloned()),
                ]),
            )
        }
        "goalControl" => {
            let goal = args.first();
            let name = object(goal).get("action").filter(|v| !v.is_null()).cloned();
            let kind = name.as_ref().and_then(Value::as_str).map(str::to_owned);
            match kind.as_deref() {
                Some("set") => request(
                    "thread/goal/set",
                    defined(vec![("threadId", thread), ("goal", goal.cloned())]),
                ),
                Some("clear") => request("thread/goal/clear", defined(vec![("threadId", thread)])),
                _ => request(
                    "thread/goal/control",
                    defined(vec![
                        ("threadId", thread),
                        (
                            "action",
                            Some(name.unwrap_or_else(|| Value::String("command".into()))),
                        ),
                        ("args", goal.cloned()),
                    ]),
                ),
            }
        }
        "listProviderModels" => request("model/list", Value::Object(object(args.first()))),
        "setFast" => request(
            "fast/set",
            defined(vec![("threadId", thread), ("on", arg(args, 0))]),
        ),
        "setRoute" => request(
            "route/set",
            defined(vec![("threadId", thread), ("route", arg(args, 0))]),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const BOUND: RouteContext<'static> = RouteContext {
        thread_id: Some("t1"),
    };
    const UNBOUND: RouteContext<'static> = RouteContext { thread_id: None };

    #[test]
    fn verbatim_action_takes_the_params_names_in_declared_order() {
        let r = resolve_action(
            "completeMcpOAuthLogin",
            &[json!("f1"), json!("http://cb")],
            &BOUND,
        )
        .unwrap();
        assert_eq!(r.method, "mcp/completeMcpOAuthLogin");
        assert_eq!(
            r.params,
            json!({ "threadId": "t1", "flowId": "f1", "callbackUrl": "http://cb" })
        );
    }

    #[test]
    fn unbound_call_has_no_thread_and_a_missing_argument_is_absent() {
        let r = resolve_action("setTheme", &[], &UNBOUND).unwrap();
        assert_eq!(r.params, json!({}));
    }

    #[test]
    fn null_argument_is_kept() {
        let r = resolve_action("setProfile", &[Value::Null], &UNBOUND).unwrap();
        assert_eq!(r.params, json!({ "input": null }));
    }

    #[test]
    fn unknown_action_is_unavailable() {
        let e = resolve_action("noSuchAction", &[], &BOUND).unwrap_err();
        assert_eq!(e.to_string(), "session action noSuchAction is unavailable");
        assert_eq!(e.code(), None);
    }

    #[test]
    fn action_without_a_method_is_unknown_method() {
        let e = resolve_action("isSessionTerminal", &[], &BOUND).unwrap_err();
        assert_eq!(
            e.to_string(),
            "session action isSessionTerminal has no protocol method thread/isSessionTerminal"
        );
        assert_eq!(e.code(), Some("unknownMethod"));
    }

    #[test]
    fn too_many_arguments_are_refused() {
        let e = resolve_action(
            "setTheme",
            &[json!(1), json!(2), json!(3), json!(4)],
            &BOUND,
        )
        .unwrap_err();
        assert!(matches!(e, RouteError::TooManyArguments { .. }));
    }

    #[test]
    fn overrides_shape_their_params() {
        let r = resolve_action("rewindToItem", &[json!("i1"), Value::Null], &BOUND).unwrap();
        assert_eq!(
            (r.method.as_str(), r.params),
            (
                "thread/rewind",
                json!({ "threadId": "t1", "itemId": "i1", "restoreFiles": true })
            )
        );
        let r = resolve_action("goalControl", &[json!({ "action": "clear" })], &BOUND).unwrap();
        assert_eq!(
            (r.method.as_str(), r.params),
            ("thread/goal/clear", json!({ "threadId": "t1" }))
        );
        let r = resolve_action("goalControl", &[json!({ "x": 1 })], &BOUND).unwrap();
        assert_eq!(r.params["action"], json!("command"));
        let r = resolve_action(
            "inheritFrom",
            &[json!("src"), json!({ "route": "r" })],
            &BOUND,
        )
        .unwrap();
        assert_eq!(
            r.params,
            json!({ "threadId": "src", "intoThreadId": "t1", "route": "r" })
        );
        let r = resolve_action("listProviderModels", &[json!("not an object")], &BOUND).unwrap();
        assert_eq!((r.method.as_str(), r.params), ("model/list", json!({})));
    }

    #[test]
    fn declared_order_rows_are_permutations_of_the_schema_fields() {
        let schema: Value = serde_json::from_str(CLIENT_METHODS_SCHEMA).unwrap();
        for (method, order) in ARG_ORDER {
            let reference = schema["methods"][*method]["params"]["$ref"]
                .as_str()
                .expect(method);
            let fields = schema["definitions"][reference.rsplit('/').next().unwrap()]["properties"]
                .as_object()
                .unwrap();
            let mut named: Vec<&str> = fields
                .keys()
                .map(String::as_str)
                .filter(|k| *k != "opId" && *k != "threadId")
                .collect();
            let mut declared: Vec<&str> = order.to_vec();
            named.sort_unstable();
            declared.sort_unstable();
            assert_eq!(named, declared, "{method}");
        }
    }

    #[test]
    fn every_override_is_a_listed_action() {
        let actions = session_actions();
        assert!(OVERRIDES.iter().all(|o| actions.contains(o)));
    }
}
